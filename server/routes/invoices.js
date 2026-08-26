const { Router } = require('express')
const { randomUUID } = require('crypto')
const xlsx = require('xlsx')
const { uploadMem, parseSheet } = require('../lib/xlsx-import')
const { futureDateError, kstToday } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { rollbackQuietly } = require('../lib/tx')
const { restoreLastGenerated } = require('../lib/recurrence')
const { ledgerError, amountError } = require('../lib/ledger')
const { settleAcctCode } = require('../lib/acctCode')
const { removeUploadedFile } = require('../lib/uploads')
const { normalizeTaxType } = require('../lib/vat')
const { recalcInvoiceStatus, paidAmountOf } = require('../lib/invoiceStatus')
// 품목 라인 금액 규칙 — 프런트 src/lib/lineAmount.js 와 같은 규칙(중량 단가 포함)
const { computeLineAmount, normBasis } = require('../lib/lineAmount')

const { isFundAccount, acctCodeByCategoryName } = require('../lib/categoryAccount')
const { invoiceVoucher, withNames } = require('../lib/voucher')
const { newBook, templateSheet, guideSheet, sendBook } = require('../lib/xlsxBook')

const router = Router()

const RECEIVABLE_STATUSES = new Set(['입금 예정', '일부 입금', '기한 지남', '장기 미수'])
const PAYABLE_STATUSES    = new Set(['지급 대기', '지급 예정', '일부 지급', '기한 지남'])

/* 자금 계정은 청구서 계정과목이 될 수 없다.
 *
 * 청구서 발행은 **자금이 움직이지 않는** 사건이다. 예금·현금이 발행 분개에 나오면
 * 그 시점부터 장부가 틀린다. 거래 등록(routes/transactions.js)·비목 저장(routes/categories.js)과
 * **같은 규칙을 같은 방식으로** 말한다 — 조용히 무시하면 사용자가 지정한 것과 다른 계정으로
 * 저장된 청구서를 성공 응답과 함께 갖게 된다. */
const fundAccountError = (code) =>
  isFundAccount(code)
    ? '청구서 계정과목에 현금·예금은 고를 수 없어요. 청구서를 발행하는 시점엔 아직 돈이 오가지 않습니다.'
    : null

/**
 * 청구서의 계정과목 — 사용자가 고른 값이 우선, 없으면 비목에 달린 값.
 *
 * 발행 분개의 한쪽이 이 값이다. 매출은 없으면 제품매출로 갈음할 수 있지만(lib/voucher.js),
 * **매입은 갈음할 수 없다** — 외주가공비인지 통신비인지는 정해줘야 알 수 있다.
 * (자금 계정 검증은 라우트 입구에서 fundAccountError 로 먼저 막는다)
 */
async function resolveInvoiceAcctCode(db, accountCode, categoryName, kind) {
  if (accountCode) return accountCode
  return acctCodeByCategoryName(db, categoryName, kind)
}

async function attachMatches(db, invoice) {
  const [matches] = await db.execute('SELECT * FROM invoice_matches WHERE invoice_id = ?', [invoice.id])
  const [docs] = await db.execute('SELECT id, url, name, doc_type, size, created_at FROM invoice_docs WHERE invoice_id = ? ORDER BY created_at', [invoice.id])
  /* 품목 내역(거래명세서) — 폼에서 수정하려면 읽을 수 있어야 한다.
     라인이 없는 청구서(총액만)는 빈 배열이라 화면이 기존처럼 총액 입력으로 동작한다. */
  const [lines] = await db.execute(
    `SELECT id, item_id, name, spec, unit, qty, weight, price_basis, unit_price, amount, vat, note, delivery_date
     FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order, created_at`, [invoice.id])
  const paid = matches.reduce((s, m) => s + Number(m.amount), 0)
  return { ...invoice, matches, docs, lines, paidAmount: paid, remainAmount: Number(invoice.total_amount) - paid }
}

/* 기간을 **어느 날짜로 걸를 것인가.**
 *
 * 여태 발행일 하나로 못 박혀 있었다. 그런데 회사마다 업무의 축이 다르다 —
 * 제조·유통은 물건이 오간 날(납품일)이 축이고, 용역은 발행일이 축이고,
 * 자금 담당은 돈이 오갈 날(결제기한)이 축이다.
 * 실사용 문의: "발행일자가 아닌 입고일자 등으로 정렬이 필요할 수 있음. 실제 물품이
 * 오간/오갈 날, 청구서를 발행한 날, 돈이 오간/오갈 날이 있다면 사용자가 중요한 정보를
 * 선택해서 조회하게 맞는 게 아닐까."
 *
 * ⚠ 납품일은 **청구서가 아니라 품목 줄**에 있다(invoice_lines.delivery_date).
 *   8/5·8/12·8/27 납품분을 8월분 한 장으로 묶는 게 실무의 보통 모습이라(월합계 세금계산서)
 *   청구서의 납품일이 하나로 정해지지 않는다. 그래서 **줄들의 범위**로 다룬다 —
 *   기간에 걸치는지는 "그 줄 중 하나라도 기간 안에 있으면"으로 본다.
 */
const DATE_AXES = {
  issued:   'i.issued_at',   // 청구서를 발행(등록)한 날
  due:      'i.due_at',      // 돈이 오갈 날(결제기한)
  delivery: null,            // 물건이 오간 날 — 품목 줄에 있어 서브쿼리로 건다
}
const axisOf = (v) => (Object.prototype.hasOwnProperty.call(DATE_AXES, v) ? v : 'issued')

router.get('/', async (req, res, next) => {
  try {
    const { kind, status, vendorId, from, to } = req.query
    const axis = axisOf(req.query.date_axis)
    /* 계좌명을 함께 준다 — 화면에서 "어느 통장으로 들어올/들어온 돈인가"를 보여주려면
       필요한데, 여태 account_id 만 내려가 목록에서는 알 수가 없었다(건마다 열어야 했다).
       납품일 범위도 함께 — 목록에 "이 청구서가 언제 나간 물건인지"가 안 보였다.
       한 줄이면 그 날짜, 여러 줄이면 8/5~8/27 처럼 범위로 보여준다. */
    let sql = `SELECT i.*, v.name AS vendor_name, c.name AS contract_name, a.name AS account_name,
        (SELECT MIN(l.delivery_date) FROM invoice_lines l
          WHERE l.invoice_id = i.id AND l.delivery_date IS NOT NULL AND l.delivery_date <> '') AS delivery_from,
        (SELECT MAX(l.delivery_date) FROM invoice_lines l
          WHERE l.invoice_id = i.id AND l.delivery_date IS NOT NULL AND l.delivery_date <> '') AS delivery_to
      FROM invoices i
      LEFT JOIN vendors v ON i.vendor_id = v.id
      LEFT JOIN contracts c ON i.contract_id = c.id
      LEFT JOIN accounts a ON i.account_id = a.id WHERE 1=1`
    const params = []
    if (kind)     { sql += ' AND i.kind = ?';       params.push(kind) }
    if (status)   { sql += ' AND i.status = ?';     params.push(status) }
    if (vendorId) { sql += ' AND i.vendor_id = ?';  params.push(vendorId) }
    if (from || to) {
      if (axis === 'delivery') {
        /* 줄 중 하나라도 기간에 걸치면 그 청구서를 낸다.
           ⚠ 납품일이 안 적힌 청구서(용역 등)는 이 축에서 빠진다 — 걸 날짜가 없으니 맞다.
             화면이 그 사실을 안내한다. */
        sql += ` AND EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id
                   AND l.delivery_date IS NOT NULL AND l.delivery_date <> ''`
        if (from) { sql += ' AND l.delivery_date >= ?'; params.push(from) }
        if (to)   { sql += ' AND l.delivery_date <= ?'; params.push(to) }
        sql += ')'
      } else {
        const col = DATE_AXES[axis]
        if (from) { sql += ` AND ${col} >= ?`; params.push(from) }
        if (to)   { sql += ` AND ${col} <= ?`; params.push(to) }
      }
    }
    /* 정렬도 고른 축을 따른다 — 납품일로 걸러 놓고 발행일 순으로 늘어놓으면
       "언제 들어온 물건" 순서로 못 본다. 납품일은 시작일(MIN) 기준. */
    sql += axis === 'delivery'
      ? ' ORDER BY delivery_from DESC, i.issued_at DESC'
      : ` ORDER BY ${DATE_AXES[axis]} DESC`
    const [rows] = await req.db.execute(sql, params)
    res.json(await Promise.all(rows.map(r => attachMatches(req.db, r))))
  } catch (e) { next(e) }
})

router.get('/summary/receivables', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute("SELECT * FROM invoices WHERE kind='issued'")
    const active = rows.filter(r => RECEIVABLE_STATUSES.has(r.status))
    const withMatches = await Promise.all(active.map(r => attachMatches(req.db, r)))
    const today = kstToday()
    const overdueRows = withMatches.filter(r => r.remainAmount > 0 && r.due_at && r.due_at < today)
    const summary = {
      total:        withMatches.reduce((s, r) => s + r.remainAmount, 0),
      count:        withMatches.length,
      overdue:      overdueRows.reduce((s, r) => s + r.remainAmount, 0),
      overdueCount: overdueRows.length,
      longOverdue:  withMatches.filter(r => r.status === '장기 미수').reduce((s, r) => s + r.remainAmount, 0),
    }
    res.json({ summary, rows: withMatches })
  } catch (e) { next(e) }
})

router.get('/summary/payables', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute("SELECT * FROM invoices WHERE kind='received'")
    const withMatches = await Promise.all(rows.map(r => attachMatches(req.db, r)))
    const pending = withMatches.filter(r => PAYABLE_STATUSES.has(r.status))
    const today = kstToday()
    const overdueRows = pending.filter(r => r.remainAmount > 0 && r.due_at && r.due_at < today)
    const summary = {
      total:           pending.reduce((s, r) => s + r.remainAmount, 0),
      count:           pending.length,
      overdue:         overdueRows.reduce((s, r) => s + r.remainAmount, 0),
      overdueCount:    overdueRows.length,
      pendingApproval: pending.filter(r => r.status === '지급 대기').reduce((s, r) => s + r.remainAmount, 0),
    }
    res.json({ summary, rows: withMatches })
  } catch (e) { next(e) }
})

router.get('/summary/vat', async (req, res, next) => {
  try {
    const { quarter, year } = req.query
    const y = year || Number(kstToday().slice(0, 4))
    const months = { Q1: ['01','02','03'], Q2: ['04','05','06'], Q3: ['07','08','09'], Q4: ['10','11','12'] }[quarter] || []
    if (!months.length) return res.json({ salesVat: 0, purchaseVat: 0, netVat: 0, rows: [] })
    const placeholders = months.map(() => 'i.issued_at LIKE ?').join(' OR ')
    const params = months.map(m => `${y}-${m}%`)
    const [all] = await req.db.execute(
      `SELECT i.*, v.name AS vendor_name FROM invoices i
       LEFT JOIN vendors v ON i.vendor_id = v.id
       WHERE (${placeholders})`,
      params
    )
    const salesVat    = all.filter(r => r.kind === 'issued').reduce((s, r) => s + Number(r.vat_amount), 0)
    const purchaseVat = all.filter(r => r.kind === 'received').reduce((s, r) => s + Number(r.vat_amount), 0)
    res.json({ salesVat, purchaseVat, netVat: salesVat - purchaseVat, rows: all })
  } catch (e) { next(e) }
})

/* ── 홈택스 전자세금계산서 엑셀 임포트 ────────────────────────────────
 * 세금계산서 발행/수취는 채권·채무가 생긴 것이므로 청구서로 넣는다(매출→미수금 / 매입→미지급금).
 * 실제 입금·지급은 종전대로 청구서 정산(matches)에서 처리한다 — 여기서 거래를 만들지 않는다.
 *
 * ⚠ 이 세 라우트는 반드시 '/:id' 보다 위에 있어야 한다.
 *   아래로 내려가면 GET /import/template 이 GET /:id 에 먹혀 404가 된다.
 */
router.post('/import/parse', uploadMem.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다' })
    res.json(parseSheet(req.file.buffer))
  } catch (e) { next(e) }
})

// 금액 파싱은 lib/money.js 단일 규칙 — 엑셀 서식('1,100,000.00', 회계형식 괄호)이 그대로 들어온다
const { moneyOf: intOf, numOf } = require('../lib/money')
const digitsOf = (v) => String(v ?? '').replace(/[^0-9]/g, '')

const refKey = (v) => String(v ?? '').replace(/[\s()\-.,·/]/g, '').toLowerCase()

/**
 * 기준정보 품목(ref_items type='item') 색인 — 엑셀 품목명을 기존 품목에 연결하기 위해.
 * 이름＋규격이 정확히 맞으면 그 품목, 규격이 비었으면 이름만으로 찾되
 * **후보가 둘 이상이면 연결하지 않는다**(규격이 다른 엉뚱한 품목에 붙으면 집계가 조용히 섞인다).
 */
async function buildItemIndex(db) {
  const [rows] = await db.execute("SELECT id, name, spec FROM ref_items WHERE type='item'")
  const byNameSpec = new Map(), byName = new Map()
  let maxOrder = 0
  for (const r of rows) {
    const ns = refKey(r.name) + '|' + refKey(r.spec)
    if (!byNameSpec.has(ns)) byNameSpec.set(ns, r.id)
    const n = refKey(r.name)
    byName.set(n, byName.has(n) ? null : r.id)   // null = 동명이품 → 모호
  }
  const [[{ mo }]] = await db.execute("SELECT COALESCE(MAX(sort_order),0) AS mo FROM ref_items WHERE type='item'")
  maxOrder = Number(mo) || 0
  return { byNameSpec, byName, order: maxOrder, created: [] }
}

/** 품목 한 줄 → 기준정보 품목 id. 없으면 register일 때만 만든다. */
async function resolveItemId(db, idx, line, register) {
  if (!idx || !line.name) return null
  const ns = refKey(line.name) + '|' + refKey(line.spec)
  const exact = idx.byNameSpec.get(ns)
  if (exact) return exact
  if (!line.spec) {
    const byName = idx.byName.get(refKey(line.name))
    if (byName) return byName
    if (byName === null && idx.byName.has(refKey(line.name))) return null   // 모호 → 연결 안 함
  }
  if (!register) return null
  // 단가는 넣지 않는다 — 계산서 한 건의 값을 기준단가로 굳히면 나중 견적·주문이 그 값을 물려받는다.
  const id = randomUUID()
  await db.execute(
    'INSERT INTO ref_items (id, type, name, spec, sort_order, memo) VALUES (?,?,?,?,?,?)',
    [id, 'item', line.name, line.spec, ++idx.order, '세금계산서 업로드로 등록'])
  idx.byNameSpec.set(ns, id)
  if (!idx.byName.has(refKey(line.name))) idx.byName.set(refKey(line.name), id)
  idx.created.push(line.name)
  return id
}

/**
 * 세금계산서 품목 내역을 청구서에 단다.
 * itemIdx가 없으면(옵션 끔) item_id를 비운 채 이름·규격만 스냅샷으로 남긴다 —
 * 표기가 조금씩 다른 품목이 기준정보에서 수백 개로 불어나는 것이 기본 동작이 되지 않게.
 */
/**
 * 청구서 금액을 확정한다. 품목 내역이 있으면 그 합계가 공급가액이다.
 *
 * 왜 서버에서도 하는가: 화면이 이미 그렇게 계산하지만, 그건 화면의 사정이다.
 * 공급가액과 품목 합계가 어긋난 채 저장되면 거래명세서에 찍힌 금액과 청구 금액이 달라지고,
 * 나중에 어느 쪽이 맞는지 판단할 근거가 없다. 근거는 품목이므로 품목을 따른다.
 *
 * 세액은 건드리지 않는다 — 과세/면세/영세와 끝수 조정은 화면이 정한 값을 존중한다.
 * 다만 합계(total)는 공급가+세액으로 다시 맞춘다.
 */
function amountsFromLines(body) {
  const lines = Array.isArray(body.lines) ? body.lines : null
  if (!lines || lines.length === 0) {
    return {
      supply_amount: body.supply_amount,
      vat_amount: body.vat_amount,
      total_amount: body.total_amount,
    }
  }
  const supply = lines.reduce((s, l) => {
    const amt = l.amount === undefined || l.amount === null || l.amount === ''
      ? computeLineAmount(l) : intOf(l.amount)
    return s + amt
  }, 0)
  const vat = intOf(body.vat_amount)
  return { supply_amount: supply, vat_amount: vat, total_amount: supply + vat }
}

/* 납품일 정규화 — 빈 문자열은 NULL 로 눕힌다.
   ''(빈 칸)을 그대로 넣으면 '적었는데 비어 있음'과 '안 적었음'이 DB에서 섞이고,
   날짜로 정렬·묶을 때 빈 문자열이 실제 날짜보다 앞에 서서 분할 결과가 뒤집힌다. */
const normDeliveryDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null)

/** 줄 하나의 세액 — 직접 적었으면 그 값, 안 적었으면 과세유형대로 자동(과세 10%, 그 외 0).
 *  화면(InvoiceLines.shownVat)·거래명세서(StatementDoc.lineVat)와 **같은 규칙**이라야
 *  사용자가 표에서 본 숫자와 저장되는 숫자가 같다. */
const lineVatOf = (l, taxType) => (
  (l.vat === undefined || l.vat === null || l.vat === '')
    ? (taxType === '과세' ? Math.round(intOf(l.amount) * 0.1) : 0)
    : intOf(l.vat)
)

/** 라인 1건 INSERT — 홈택스 임포트와 폼 입력이 **같은 컬럼**을 쓰게 한 곳에 둔다.
 *  한쪽만 새 컬럼을 채우면 같은 청구서라도 어디서 만들었냐에 따라 명세서가 달라진다. */
async function insertInvoiceLine(db, invoiceId, l, ord) {
  await db.execute(
    `INSERT INTO invoice_lines
       (id, invoice_id, item_id, name, spec, unit, qty, weight, price_basis, unit_price, amount, vat, note, sort_order, delivery_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [randomUUID(), invoiceId, l.item_id || null, l.name || '(품목명 없음)', l.spec || null, l.unit || null,
     l.qty || 0, l.weight || 0, normBasis(l.price_basis), l.unit_price || 0, l.amount || 0,
     // NULL 은 '아직 안 정했다', 0 은 '면세라서 0' — 서로 다른 뜻이라 구분해 넣는다
     (l.vat === undefined || l.vat === null || l.vat === '') ? null : Number(l.vat) || 0,
     l.note || null, ord, normDeliveryDate(l.delivery_date)])
}

async function replaceInvoiceLines(db, invoiceId, lines, itemIdx = null, register = false) {
  const clean = (Array.isArray(lines) ? lines : [])
    .map(l => ({
      name: String(l.name || '').trim(),
      spec: String(l.spec || '').trim() || null,
      qty: numOf(l.qty),
      unit_price: intOf(l.unit_price),
      amount: intOf(l.amount),
    }))
    .filter(l => l.name || l.amount)
  if (!clean.length) return 0
  await db.execute('DELETE FROM invoice_lines WHERE invoice_id = ?', [invoiceId])
  let ord = 0
  for (const l of clean) {
    l.item_id = await resolveItemId(db, itemIdx, l, register)
    await insertInvoiceLine(db, invoiceId, l, ++ord)
  }
  return clean.length
}

/**
 * 청구서 폼(거래명세서식 입력)이 보낸 품목을 저장한다.
 *
 * 홈택스 임포트(replaceInvoiceLines)와 나눈 이유: 저쪽은 엑셀의 품목명으로 기준정보를 **찾아야**
 * 하지만, 폼은 사용자가 이미 고른 item_id 를 그대로 들고 온다. 찾는 로직을 공유하면
 * 폼에서 고른 품목이 이름이 비슷한 다른 품목으로 바뀔 수 있다.
 *
 * ⚠ 금액은 서버에서 **다시 계산하지 않는다.** 할인·끝수 조정처럼 사람이 손대는 값이라
 *   덮으면 화면에서 본 금액과 저장된 금액이 달라진다. 대신 비어 있을 때만 계산으로 채운다.
 *
 * @returns 저장한 라인 수 (0이면 라인 없는 청구서 = 총액만 있는 기존 방식)
 */
async function writeInvoiceLines(db, invoiceId, lines) {
  if (!Array.isArray(lines)) return null       // 아예 안 보냈으면 건드리지 않는다(부분 수정 보존)
  await db.execute('DELETE FROM invoice_lines WHERE invoice_id = ?', [invoiceId])
  const clean = lines
    .map(l => {
      const row = {
        item_id: l.item_id || null,
        name: String(l.name || '').trim(),
        spec: String(l.spec || '').trim() || null,
        unit: String(l.unit || '').trim() || null,
        qty: numOf(l.qty),
        weight: numOf(l.weight),
        price_basis: normBasis(l.price_basis),
        unit_price: intOf(l.unit_price),
        /* 줄별 세액 — NULL 은 '아직 안 정했다', 0 은 '면세라서 0'. 뜻이 다르므로 뭉개지 않는다.
           같은 청구서에 과세와 면세가 섞이는 일이 실제로 있다(자재 + 근조화환). */
        vat: (l.vat === undefined || l.vat === null || l.vat === '') ? null : intOf(l.vat),
        note: String(l.note || '').trim() || null,
        // 품목별 납품일(입고일). 안 적으면 NULL — 분할 발행에서 '날짜 없음' 묶음이 된다.
        delivery_date: normDeliveryDate(l.delivery_date),
      }
      // 금액을 안 보냈으면 계산해 채운다(화면과 같은 규칙 — lib/lineAmount.js)
      row.amount = l.amount === undefined || l.amount === null || l.amount === ''
        ? computeLineAmount(row) : intOf(l.amount)
      return row
    })
    // 빈 줄은 버린다 — 표에 남은 마지막 빈 행이 '(품목명 없음) 0원'으로 저장되면 명세서가 지저분해진다
    .filter(l => l.name || l.amount || l.qty || l.weight)
  let ord = 0
  for (const l of clean) await insertInvoiceLine(db, invoiceId, l, ++ord)
  return clean.length
}

/**
 * 세금계산서의 상대방 거래처를 찾고, 없으면 만든다.
 * 사업자번호 → 상호 순으로 찾는다(홈택스 상호는 우리가 등록한 이름과 표기가 다를 수 있다).
 * db는 인자로 받는다 — 전역 풀 기본값을 두면 조용히 남의 회사 DB에 거래처를 만든다.
 */
async function findOrCreateVendor(db, { name, bizNo, kind }) {
  const biz = digitsOf(bizNo)
  if (biz) {
    const [hit] = await db.execute(
      "SELECT id FROM vendors WHERE REPLACE(REPLACE(biz_no, '-', ''), ' ', '') = ? LIMIT 1", [biz])
    if (hit[0]) return { id: hit[0].id, created: false }
  }
  const nm = String(name || '').trim()
  if (!nm) return { id: null, created: false }
  const [byName] = await db.execute('SELECT id FROM vendors WHERE name = ? LIMIT 1', [nm])
  if (byName[0]) return { id: byName[0].id, created: false }
  // 매출 세금계산서의 상대는 발주처(B), 매입은 매입처(A).
  const id = randomUUID()
  await db.execute('INSERT INTO vendors (id, name, biz_no, gubu) VALUES (?,?,?,?)',
    [id, nm, String(bizNo || '').trim() || null, kind === 'issued' ? 'B' : 'A'])
  return { id, created: true, name: nm }
}

router.post('/import/commit', async (req, res, next) => {
  const items = Array.isArray(req.body.items) ? req.body.items : []
  if (!items.length) return res.json({ ok: true, inserted: 0, updated: 0 })
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()

    // 청구번호 채번(청구-2026-0001). 행마다 MAX를 다시 읽으면 느리므로 종류·연도별로 한 번만 읽고 올린다.
    const seq = new Map()
    const nextInvoiceNo = async (kind, year) => {
      const prefix = kind === 'issued' ? '청구' : '매입'
      const key = `${kind}|${year}`
      if (!seq.has(key)) {
        const [[{ maxno }]] = await conn.execute(
          "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind = ? AND invoice_no LIKE ?",
          [kind, `${prefix}-${year}-%`])
        seq.set(key, Number(maxno))
      }
      const n = seq.get(key) + 1
      seq.set(key, n)
      return `${prefix}-${year}-${String(n).padStart(4, '0')}`
    }

    let inserted = 0, updated = 0, amountKept = 0, linedInvoices = 0, dupSkipped = 0, closedSkipped = 0, amountSkipped = 0
    // 마감월 판정은 같은 달을 반복 조회하지 않게 캐시한다(200건이면 같은 달이 수십 번 나온다)
    const closedCache = new Map()
    const isClosedMonth = async (date) => {
      const m = String(date || '').slice(0, 7)
      if (!closedCache.has(m)) closedCache.set(m, !!(await closedPeriodError(conn, date)))
      return closedCache.get(m)
    }
    const createdVendors = []
    // 미등록 품목을 기준정보에 함께 등록할지 — 화면 옵션(기본 꺼짐).
    // 켠 경우에만 기존 품목과의 연결(item_id)도 한다. 끄면 종전처럼 이름만 남긴다.
    const registerItems = req.body.registerItems === true
    const itemIdx = registerItems ? await buildItemIndex(conn) : null
    for (const it of items) {
      const kind = it.kind === 'issued' ? 'issued' : 'received'
      const issuedAt = String(it.issued_at || '').slice(0, 10)
      if (!issuedAt) continue                      // 작성일자 없는 행은 화면에서 이미 걸러진다
      // 마감된 달의 행은 건너뛴다. 200건 중 한 건 때문에 전체를 거절하면 실무가 막히고,
      // 조용히 넣으면 신고 끝난 분기의 부가세가 바뀐다 → 스킵하고 몇 건인지 보고한다.
      if (await isClosedMonth(issuedAt)) { closedSkipped++; continue }
      const supply = intOf(it.supply_amount)
      const taxType = normalizeTaxType(it.tax_type || (intOf(it.vat_amount) > 0 ? '과세' : '면세'))
      /* 면세·영세에 세액이 실려 오면 버린다 — lib/vat.js vatFields()의 규칙("유형이 우선")과 같다.
       * 임포트만 이 규칙을 안 타서, 과세유형은 면세인데 세액이 남아 부가세 매출세액에 합산됐다. */
      const vat = taxType === '과세' ? intOf(it.vat_amount) : 0
      const total = intOf(it.total_amount) || (supply + vat)
      const confirmNo = String(it.nts_confirm_no || '').trim() || null
      const dueAt = String(it.due_at || '').slice(0, 10) || null

      if (it.action === 'update' && it.id) {
        // 이미 입금·지급이 붙은 청구서의 금액을 엑셀로 덮으면 정산 잔액이 어긋난다.
        // 그런 건은 승인번호만 채우고 금액·일자는 그대로 둔다(무엇이 유지됐는지 결과로 알린다).
        const [[{ mcnt }]] = await conn.execute(
          'SELECT COUNT(*) AS mcnt FROM invoice_matches WHERE invoice_id = ?', [it.id])
        if (Number(mcnt) > 0) {
          // 품목도 건드리지 않는다 — 금액은 옛 값 그대로인데 품목만 새 것이면 둘이 어긋난다.
          await conn.execute(
            'UPDATE invoices SET nts_confirm_no = COALESCE(nts_confirm_no, ?) WHERE id = ?', [confirmNo, it.id])
          amountKept++
        } else {
          const v = await findOrCreateVendor(conn, { name: it.vendor_name, bizNo: it.biz_no, kind })
          if (v.created) createdVendors.push(v.name)
          await conn.execute(
            `UPDATE invoices SET vendor_id = COALESCE(?, vendor_id), supply_amount = ?, vat_amount = ?,
                    total_amount = ?, issued_at = ?, due_at = COALESCE(?, due_at), tax_type = ?,
                    nts_confirm_no = COALESCE(?, nts_confirm_no)
             WHERE id = ?`,
            [v.id, supply, vat, total, issuedAt, dueAt, taxType, confirmNo, it.id])
          // 엑셀에 품목이 있을 때만 갈아끼운다. 빈 채로 덮으면 기성 청구의 품목 내역이 날아간다.
          if (await replaceInvoiceLines(conn, it.id, it.lines, itemIdx, registerItems)) linedInvoices++
        }
        updated++
        continue
      }

      // 승인번호는 국세청이 부여한 유일값이다 → 같은 번호의 청구서가 이미 있으면 새로 만들지 않는다.
      // 여태 중복 판정이 업로드 화면에만 있어서, 같은 payload가 다시 오면(재시도·중복 제출·
      // 사용자가 '전체 새로 등록'을 고른 경우) 서버가 그대로 두 벌 만들었다.
      // "같은 파일을 다시 올려도 두 번 쌓이지 않는다"는 약속을 서버에서도 지킨다.
      if (confirmNo) {
        const [[exists]] = await conn.execute(
          'SELECT id FROM invoices WHERE nts_confirm_no = ? LIMIT 1', [confirmNo])
        if (exists) { dupSkipped++; continue }
      }
      /* 금액이 0·음수인 행은 만들지 않는다. 여기만 검사가 없어 엑셀의 빈 금액 칸이
       * 0원 청구서로 들어왔다. 한 행 때문에 배치 전체를 세우면 나머지 수백 건이 날아가므로
       * (중복 처리와 같은 이유) 세어서 결과 화면에 보고한다. */
      if (amountError(total)) { amountSkipped++; continue }
      const v = await findOrCreateVendor(conn, { name: it.vendor_name, bizNo: it.biz_no, kind })
      if (v.created) createdVendors.push(v.name)
      const newId = randomUUID()
      try {
        await conn.execute(
          `INSERT INTO invoices (id, invoice_no, kind, vendor_id, supply_amount, vat_amount, total_amount,
                                 issued_at, due_at, status, memo, tax_type, nts_confirm_no)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [newId, await nextInvoiceNo(kind, issuedAt.slice(0, 4)), kind, v.id,
           supply, vat, total, issuedAt, dueAt,
           kind === 'issued' ? '입금 예정' : '지급 대기', String(it.memo || ''), taxType, confirmNo])
      } catch (e) {
        // UNIQUE(nts_confirm_no)가 걸린 경우: 위 조회와 이 삽입 사이에 다른 요청이 먼저 넣었다.
        // 그 한 건 때문에 배치 전체를 500으로 되돌리면 나머지 수백 건이 통째로 날아간다 →
        // 중복으로 세고 넘어간다(결과 화면에 dupSkipped로 보고된다).
        if (e.code === 'ER_DUP_ENTRY') { dupSkipped++; continue }
        throw e
      }
      if (await replaceInvoiceLines(conn, newId, it.lines, itemIdx, registerItems)) linedInvoices++
      inserted++
    }

    await conn.commit()
    res.json({
      ok: true, inserted, updated, amountKept, linedInvoices, dupSkipped, closedSkipped, amountSkipped, createdVendors,
      createdItems: itemIdx ? itemIdx.created : [],
    })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// 양식 다운로드 — 홈택스 '전자세금계산서 목록조회 → 엑셀받기'와 같은 머리글로 만든다.
router.get('/import/template', async (req, res, next) => {
  try {
    // 품목 상세 포함 형식으로 만든다 — 첫 두 행은 같은 승인번호(= 품목 2줄짜리 계산서 1건)다.
    const cols = ['작성일자', '승인번호', '공급자 사업자등록번호', '공급자 상호',
      '공급받는자 사업자등록번호', '공급받는자 상호', '합계금액', '공급가액', '세액', '종류',
      '품목명', '품목 규격', '품목 수량', '품목 단가', '품목 공급가액', '비고']
    const rows = [
      cols,
      ['2026-07-05', '20260705-41000000-11111111', '000-00-00000', '(주)포커스윈',
        '111-11-11111', '(주)한화오션', 11000000, 10000000, 1000000, '일반',
        '회원관리 시스템 개발', '2차', 1, 7000000, 7000000, '7월 기성'],
      ['2026-07-05', '20260705-41000000-11111111', '000-00-00000', '(주)포커스윈',
        '111-11-11111', '(주)한화오션', 11000000, 10000000, 1000000, '일반',
        '유지보수', '월 정액', 6, 500000, 3000000, ''],
      ['2026-07-10', '20260710-41000000-22222222', '222-22-22222', '정밀가공(주)',
        '000-00-00000', '(주)포커스윈', 1650000, 1500000, 150000, '일반',
        'CNC 가공', 'AL6061', 30, 50000, 1500000, '외주'],
    ]
    const WIDTHS = [12, 28, 18, 20, 20, 20, 14, 14, 12, 8, 22, 12, 10, 12, 14, 16]
    /* 필수는 작성일자·승인번호뿐이다. 나머지는 홈택스 파일에 있으면 쓰고 없으면 비운다 —
       머리글에 별을 남발하면 별이 뜻을 잃는다. */
    const REQUIRED = new Set(['작성일자', '승인번호'])

    const guide = [
      ['홈택스 세금계산서 업로드 — 작성 안내'],
      [''],
      ['• 홈택스 › 조회/발급 › 전자세금계산서 › 목록조회에서 내려받은 엑셀을 그대로 올리면 됩니다.'],
      ['  (머리글이 달라도 업로드 화면에서 컬럼을 직접 연결할 수 있어요)'],
      [''],
      ['• 매출/매입 구분: 공급자·공급받는자 사업자등록번호를 우리 회사 번호와 비교해 자동으로 가릅니다.'],
      ['  우리 회사 번호는 환경설정 › 회사 정보에서 가져옵니다(거기가 비어 있으면 업로드 화면에서 직접 넣을 수 있습니다).'],
      ['  우리 번호와 어느 쪽도 맞지 않으면 업로드 화면에서 고른 기본 구분으로 들어가고, 행에 표시됩니다.'],
      ['• 작성일자: 필수. 부가세 귀속 분기를 정하는 날짜입니다(발급일자·전송일자가 아닙니다).'],
      ['• 세액이 0이면 면세로 봅니다. 영세율 건은 종류 칸에 "영세"가 있어야 영세로 들어갑니다.'],
      ['• 승인번호: 중복 판정의 기준입니다. 있으면 같은 파일을 다시 올려도 두 번 등록되지 않아요.'],
      ['• 품목: 승인번호가 같은 여러 행은 한 계산서의 품목들로 보고 묶습니다(위 1~2행 참고).'],
      ['  품목 칸을 안 쓰면 계산서 한 줄짜리로 등록되고, 금액·부가세에는 아무 차이가 없습니다.'],
      ['  품목을 넣으면 매입 지급결의서가 품목별 명세로 자동 작성됩니다.'],
      ['  ※ 기준정보 품목 등록은 업로드 화면의 "미등록 품목 등록" 옵션으로 켤 수 있습니다(기본 꺼짐).'],
      ['• 결제기한은 홈택스 엑셀에 없으므로 업로드 화면에서 "작성일자 + N일"로 정합니다.'],
      [''],
      ['• 등록 결과: 매출은 미수금(입금 예정), 매입은 미지급금(지급 대기)으로 잡히고 부가세 집계에 바로 반영됩니다.'],
      ['  실제 입금·지급 처리는 청구서를 열어 정산(매칭)에서 하세요.'],
    ]
    const wb = newBook()
    templateSheet(wb, '세금계산서', {
      columns: cols.map((header, i) => ({ header, width: WIDTHS[i] || 16, required: REQUIRED.has(header) })),
      samples: rows.slice(1),
    })
    guideSheet(wb, guide.map(g => g[0], '작성안내', { hasRequired: true }))
    await sendBook(res, wb, '세금계산서_업로드_양식.xlsx')
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM invoices WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(await attachMatches(req.db, rows[0]))
  } catch (e) { next(e) }
})

/* 청구서 발행 전표.
 *
 * 결제 전표(거래)와 **다른 전표**다. 발행 때 채권·채무가 생기고, 결제 때 그것이 사라진다.
 * 자금이 움직이지 않으므로 항상 대체전표이고, 공급가액과 부가세가 나뉘어 줄이 셋이 된다. */
router.get('/:id/voucher', async (req, res, next) => {
  try {
    const [[inv]] = await req.db.execute(`
      SELECT i.id, i.invoice_no, i.kind, i.supply_amount, i.vat_amount, i.total_amount,
             i.issued_at, i.category, i.account_code, v.name AS vendor_name
        FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id
       WHERE i.id = ?`, [req.params.id])
    if (!inv) return res.status(404).json({ error: 'Not found' })
    res.json(await withNames(req.db, invoiceVoucher(inv), { category: inv.category || null }))
  } catch (e) { next(e) }
})

/** 매출/매입 구분 — 이 둘 말고는 어느 목록에도 안 잡혀 '보이지 않는 청구서'가 된다 */
const INVOICE_KINDS = new Set(['issued', 'received'])

/**
 * 청구서 등록 시 요청 본문 검증 (금액 총액은 amountError 가 따로 본다).
 *
 * 순수 함수로 빼두어 DB 없이 검증한다 — 여기서 놓치면 500 이 되고,
 * 사용자는 무엇이 잘못됐는지 알 수 없는 "처리 중 오류"만 본다.
 */
function invoiceCreateError({ kind, supply_amount, vat_amount }) {
  if (!INVOICE_KINDS.has(kind)) return '매출/매입 구분이 없거나 올바르지 않아요'
  // 0 은 허용한다 — 면세는 세액이 0 이고, 총액 0 은 amountError 가 이미 막았다.
  for (const [label, v] of [['공급가액', supply_amount], ['부가세액', vat_amount]]) {
    /* ⚠ Number(null)·Number('') 은 0 이다. 그래서 숫자 검사만 하면 이 둘이 통과하는데,
     * supply_amount·vat_amount 컬럼은 NOT NULL 이고 서버 sql_mode 가 STRICT_TRANS_TABLES 라
     * null 도 '' 도 그대로 넣으면 **500** 이 된다. 값의 '있음'을 먼저 본다. */
    if (v === undefined || v === null || v === '') return `${label}을 입력해주세요`
    const num = Number(v)
    if (!Number.isFinite(num)) return `${label}을 숫자로 입력해주세요`
    if (num < 0) return `${label}은 0보다 작을 수 없어요`
  }
  return null
}

router.post('/', async (req, res, next) => {
  try {
    const { kind, vendor_id, contract_id, issued_at, due_at, status, account_id, memo, tax_type,
            category, account_code } = req.body
    /* 품목 내역이 있으면 **그 합계가 공급가액이다.** 화면도 그렇게 동작하지만(공급가액 칸이 잠긴다)
       서버에서도 확정한다 — 두 숫자를 각자 보내면 명세서와 청구서가 다른 말을 하는 청구서가
       저장될 수 있고, 그건 나중에 어느 쪽이 맞는지 알 방법이 없다. */
    const { supply_amount, vat_amount, total_amount } = amountsFromLines(req.body)
    /* 금액 검증이 아예 없어서 **0원·음수 청구서가 그대로 저장됐다**(실제로 0원 청구서가
     * '입금 예정'으로 남아 홈 '할 일'에 떠 있었다). 음수 청구서는 미수금 총액을 깎아
     * 다른 청구서를 상계하고, 부가세 과세표준도 함께 줄인다.
     * 거래(transactions)·결의서는 이미 amountError 를 통과해야 하는데 청구서만 빠져 있었다. */
    { const ae = amountError(total_amount); if (ae) return res.status(400).json({ error: ae }) }
    /* 나머지 필수 필드도 같은 이유로 막는다.
     *
     * total_amount·issued_at 만 검사하고 kind·supply_amount·vat_amount 는 무방비였다.
     * 셋 중 하나라도 빠지면 undefined 가 그대로 INSERT 파라미터로 들어가
     * mysql2 가 "Bind parameters must not contain undefined" 로 던진다 → **500**.
     * 사용자에겐 "처리 중 오류"만 보여 무엇을 안 넣었는지 알 수 없다
     * (실제로 운영 로그에 이 500 이 찍혀 있었다).
     *
     * 바로 아래 issued_at 주석이 같은 사고를 이미 한 번 적어뒀는데, 그때 그 필드만
     * 고치고 나머지는 보지 않았다. 이번엔 이 INSERT 가 요청 본문에서 받는 값을 전부 본다.
     * (다른 청구서 INSERT 7곳은 주문·정기 규칙에서 내부 계산하므로 이 문제가 없다) */
    { const e = invoiceCreateError({ kind, supply_amount, vat_amount })
      if (e) return res.status(400).json({ error: e }) }
    /* 발행일은 반드시 받는다. 없으면 DB의 NOT NULL 제약에 걸려 **500**이 났다 —
     * 사용자에겐 "처리 중 오류"라고만 보여서 무엇을 안 넣었는지 알 수 없다.
     * 게다가 발행일이 없으면 바로 아래 마감 검사가 undefined 로 통과해 버린다. */
    if (!issued_at) return res.status(400).json({ error: '발행일을 선택해주세요' })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(issued_at))) {
      return res.status(400).json({ error: '발행일 형식이 올바르지 않아요 (YYYY-MM-DD)' })
    }
    // 마감된 달에는 청구서를 새로 발행할 수 없다 — 부가세 집계의 주 소스가 청구서이므로,
    // 신고를 끝낸 분기에 청구서가 추가되면 제출 자료와 장부가 어긋난다.
    // (미래 발행일은 막지 않는다 — 정기청구의 미리 발행이 정당한 업무다)
    { const ce = await closedPeriodError(req.db, issued_at); if (ce) return res.status(409).json({ error: ce }) }
    // 과세유형: 화면이 정해 보내면 그대로, 아니면 세액 유무로 과세/면세를 가른다.
    // (영세는 세액이 0이라 추론이 안 되므로 반드시 명시해야 한다 — 주문에서 발행하면 자동으로 채워진다)
    const taxType = normalizeTaxType(tax_type || (Number(vat_amount) > 0 ? '과세' : '면세'))
    const id = randomUUID()
    // 친화적 청구번호 생성: 청구-2026-0001 / 매입-2026-0001 (최대 일련번호+1 — 삭제해도 재사용 안 됨)
    const year = String(issued_at || '').slice(0, 4) || kstToday().slice(0, 4)
    const prefix = kind === 'issued' ? '청구' : '매입'
    const [[{ maxno }]] = await req.db.execute(
      "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind = ? AND invoice_no LIKE ?",
      [kind, `${prefix}-${year}-%`]
    )
    const invoice_no = `${prefix}-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    /* 비목과 계정과목을 받아 둔다 — 발행 시점 분개에 필요하다.
     * 매입 청구서는 그 돈이 외주가공비인지 원재료비인지 청구서만 봐서는 알 수 없다.
     * 계정과목은 비목에서 끌어오고, 저장된 값은 **스냅샷**이다(비목 연결이 나중에 바뀌어도
     * 이미 발행한 청구서의 전표는 그대로 남아야 한다). */
    { const fe = fundAccountError(account_code); if (fe) return res.status(400).json({ error: fe }) }
    const invAcctCode = await resolveInvoiceAcctCode(req.db, account_code, category, kind)
    await req.db.execute(
      'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo, tax_type, category, account_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, invoice_no, kind, vendor_id||null, contract_id||null, supply_amount, vat_amount, total_amount, issued_at, due_at||null, status||(kind==='issued' ? '입금 예정' : '지급 대기'), account_id||null, memo||'', taxType, category||null, invAcctCode]
    )
    // 거래명세서식 품목 내역(선택) — 없으면 총액만 있는 기존 청구서 그대로다
    const lineCount = await writeInvoiceLines(req.db, id, req.body.lines)
    res.json({ id, invoice_no, lines: lineCount })
  } catch (e) { next(e) }
})

/**
 * 청구서 수정.
 *
 * 여기에는 가드가 하나도 없었다. 그 결과 두 방향으로 장부가 조용히 틀어졌다:
 *   · 감액: 2,200만(1,500만 정산)을 220만으로 내리면 잔여가 −1,280만이 되고,
 *     미수금 요약이 그 음수를 단순 합산해 **다른 청구서의 정상 미수를 상계해 없앤다**.
 *   · 증액: 완납 건을 올리면 status가 '입금 완료'로 남아 미수금 화면·대시보드 양쪽에서
 *     제외된다(둘 다 status로 걸러낸다) → 늘어난 미수가 장부에서 사라진다.
 * 거래 수정 경로(transactions.js)는 매칭 재조정 + 상태 재계산을 묶어 두었는데 이쪽엔 그 짝이 없었다.
 *
 * 그래서 셋을 넣는다: 마감 검사(날짜 이동은 양쪽) · 정산액 하한 검사 · 상태 재계산.
 * status는 클라이언트가 보낸 값을 믿지 않고 정산 누계로 확정한다(화면이 옛 status를 그대로 되보낸다).
 */
/**
 * 납품일별로 **나눠서** 발행한다 — 거래처·발행일은 같고 품목·납품일만 다른 청구서 여러 장.
 *
 * ── 왜 청구서를 쪼개나 ──
 * 돈이 오가는 단위는 **세금계산서(청구서) 한 장**이다. 채권이 그 단위로 성립하고,
 * 거래처의 지급 시스템도 세금계산서 번호로 돈다. 그래서 "이 납품분만 따로 받아야 한다"는
 * 요구는 품목별 입금으로 풀면 안 된다 — 장부의 채권 단위와 세금계산서가 어긋나서,
 * 나중에 어느 쪽이 맞는지 알 방법이 없어진다. **청구서를 나누는 것**이 정석이다.
 * 그 나누는 일을 손으로 N번 반복하지 않게 해주는 것이 이 엔드포인트다.
 *
 * ── 규칙 ──
 * · 묶는 기준은 납품일. 날짜를 안 적은 줄은 '날짜 없음' 한 묶음으로 함께 발행한다.
 * · 청구번호는 한 트랜잭션 안에서 이어서 채번한다(청구-2026-0001, -0002 …).
 *   따로따로 POST 하면 동시 발행 때 같은 번호를 두 장이 집을 수 있다.
 * · 세액은 **묶음의 공급가로 다시 계산한다.** 줄에 세액을 적어 놨으면 그 합을 쓴다.
 *   나뉜 뒤에는 각 장이 독립된 세금계산서라, 그 장의 공급가에 대한 세액이 맞는 값이다.
 *   (원본 한 장의 세액을 비율로 쪼개면 끝수가 어디로 갔는지 설명할 수 없다)
 * · 하나라도 막히면 **아무것도 만들지 않는다.** 절반만 발행되면 무엇이 나갔는지
 *   사람이 되짚어야 하고, 그 상태를 되돌릴 방법도 마땅치 않다.
 */
router.post('/split', async (req, res, next) => {
  try {
    const { kind, vendor_id, contract_id, issued_at, due_at, status, account_id, memo, tax_type,
            category, account_code } = req.body
    const lines = Array.isArray(req.body.lines) ? req.body.lines : []
    if (!lines.length) return res.status(400).json({ error: '나눌 품목이 없어요. 품목을 먼저 입력해주세요.' })
    if (!issued_at) return res.status(400).json({ error: '발행일을 선택해주세요' })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(issued_at))) {
      return res.status(400).json({ error: '발행일 형식이 올바르지 않아요 (YYYY-MM-DD)' })
    }
    const taxType = normalizeTaxType(tax_type || '과세')
    { const fe = fundAccountError(account_code); if (fe) return res.status(400).json({ error: fe }) }
    const splitAcctCode = await resolveInvoiceAcctCode(req.db, account_code, category, kind)

    /* 납품일로 묶는다. 빈 값은 '' 한 칸에 모은다(날짜 없는 줄끼리 한 장).
       Map 은 넣은 순서를 지키므로, 화면에서 본 줄 순서가 청구서 순서로 이어진다. */
    const groups = new Map()
    for (const l of lines) {
      const name = String(l.name || '').trim()
      const amt = (l.amount === undefined || l.amount === null || l.amount === '')
        ? computeLineAmount(l) : intOf(l.amount)
      if (!name && !amt) continue              // 표 맨 아래 빈 줄
      const key = normDeliveryDate(l.delivery_date) || ''
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push({ ...l, amount: amt })
    }
    if (!groups.size) return res.status(400).json({ error: '나눌 품목이 없어요. 품목을 먼저 입력해주세요.' })
    if (groups.size === 1) {
      return res.status(400).json({ error: '납품일이 모두 같아요. 나눌 필요 없이 그냥 발행하시면 됩니다.' })
    }

    const conn = await req.db.getConnection()
    try {
      await conn.beginTransaction()
      // 마감 검사는 한 번만 — 모든 장이 같은 발행일을 쓴다
      const ce = await closedPeriodError(conn, issued_at)
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }

      const year = String(issued_at).slice(0, 4) || kstToday().slice(0, 4)
      const prefix = kind === 'issued' ? '청구' : '매입'
      /* FOR UPDATE — 이 구간을 잠가 동시에 발행하는 요청을 줄 세운다.
         잠그지 않으면 두 요청이 같은 maxno 를 읽어 같은 번호를 만든다(결의서 채번과 같은 이유). */
      const [[{ maxno }]] = await conn.execute(
        "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind = ? AND invoice_no LIKE ? FOR UPDATE",
        [kind, `${prefix}-${year}-%`])

      let seq = Number(maxno)
      const created = []
      for (const [deliveryDate, groupLines] of groups) {
        const supply = groupLines.reduce((s, l) => s + intOf(l.amount), 0)
        /* 세액은 **줄마다** 정한다: 직접 적었으면 그 값, 안 적었으면 과세유형대로 자동.
         * 그 합이 이 장의 세액이다.
         *
         * 예전엔 "명시한 줄이 하나라도 있으면 명시값의 합"으로 계산했다. 그러면 과세·면세가
         * 섞인 장에서 면세 줄만 0으로 고쳤을 때, 나머지 과세 줄의 자동 세액이 통째로 0이 된다
         * — 화면 품목표에는 자동값이 떠 있는데 저장은 다른 숫자가 되는, 제일 나쁜 종류의 어긋남이다.
         * 거래명세서(StatementDoc.lineVat)·품목표(InvoiceLines.shownVat)와 같은 규칙이다. */
        const vat = groupLines.reduce((t, l) => t + lineVatOf(l, taxType), 0)
        const total = supply + vat
        const ae = amountError(total)
        if (ae) {
          await rollbackQuietly(conn)
          return res.status(400).json({ error: `${deliveryDate || '납품일 없음'} 묶음: ${ae}` })
        }
        const ie = invoiceCreateError({ kind, supply_amount: supply, vat_amount: vat })
        if (ie) { await rollbackQuietly(conn); return res.status(400).json({ error: ie }) }

        const id = randomUUID()
        const invoice_no = `${prefix}-${year}-${String(++seq).padStart(4, '0')}`
        /* 메모에 납품일을 남긴다 — 목록에서는 품목 줄이 안 보이므로, 같은 거래처·같은 날짜로
           여러 장이 나란히 서면 어느 장이 어느 납품분인지 구분할 단서가 필요하다. */
        const noteBase = String(memo || '').trim()
        const noteDate = deliveryDate ? `납품 ${deliveryDate}` : '납품일 미기재'
        // 나눠 발행해도 비목은 같다 — 안 물려주면 쪼갠 장들만 발행 전표를 못 세운다
        await conn.execute(
          'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo, tax_type, category, account_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, invoice_no, kind, vendor_id || null, contract_id || null, supply, vat, total, issued_at,
           due_at || null, status || (kind === 'issued' ? '입금 예정' : '지급 대기'),
           account_id || null, noteBase ? `${noteBase} · ${noteDate}` : noteDate, taxType,
           category || null, splitAcctCode])
        await writeInvoiceLines(conn, id, groupLines)
        created.push({ id, invoice_no, delivery_date: deliveryDate || null, supply, vat, total, lines: groupLines.length })
      }
      await conn.commit()
      res.json({ ok: true, count: created.length, invoices: created })
    } catch (e) { await rollbackQuietly(conn); throw e }
    finally { conn.release() }
  } catch (e) { next(e) }
})

/* 증빙 확인 — 청구서에 붙은 파일(invoice_docs)이 없어도 '확인함'으로 닫을 수 있게 한다.
 * 왜 체크가 필요한지는 lib/evidence.js 머리말 참조(종이 원본만 오는 곳이 있다).
 * 다른 칸은 건드리지 않는다 — 이 라우트는 오직 이 한 칸을 위한 것이다. */
router.patch('/:id/evidence', async (req, res, next) => {
  try {
    if (req.body.evidence_ok === undefined) return res.status(400).json({ error: '바꿀 값이 없어요' })
    const [result] = await req.db.execute(
      'UPDATE invoices SET evidence_ok=? WHERE id=?', [req.body.evidence_ok ? 1 : 0, req.params.id])
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const { vendor_id, contract_id, issued_at, due_at, account_id, memo, tax_type,
            category, account_code } = req.body
    // 등록과 같은 규칙 — 품목이 있으면 그 합계가 공급가액이다
    const { supply_amount, vat_amount, total_amount } = amountsFromLines(req.body)
    await conn.beginTransaction()
    const [[cur]] = await conn.execute('SELECT issued_at, total_amount FROM invoices WHERE id = ? FOR UPDATE', [req.params.id])
    if (!cur) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }

    // 부가세 집계의 주 소스가 청구서다 → 마감된 달의 신고 자료가 사후에 바뀌면 안 된다.
    // 날짜를 옮기는 경우 양쪽을 본다(잠긴 달에서 빼내거나 밀어넣는 것도 막는다 — 거래와 같은 규칙).
    const ce = await closedPeriodError(conn, cur.issued_at, issued_at)
    if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }

    // 수정에도 같은 규칙 — 발행만 막고 수정으로 0원을 만들 수 있으면 막은 의미가 없다.
    { const ae = amountError(total_amount); if (ae) { await rollbackQuietly(conn); return res.status(400).json({ error: ae }) } }

    // 이미 정산된 금액보다 낮출 수 없다. 낮추면 잔여가 음수가 되어 다른 미수금을 상계한다.
    const paid = await paidAmountOf(conn, req.params.id)
    const newTotal = Number(total_amount) || 0
    if (paid > 0 && newTotal < paid) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `이미 ${paid.toLocaleString('ko-KR')}원이 정산된 청구서예요. 그보다 적은 금액(${newTotal.toLocaleString('ko-KR')}원)으로는 바꿀 수 없어요. 먼저 정산을 취소하세요.`,
      })
    }

    const taxType = normalizeTaxType(tax_type || (Number(vat_amount) > 0 ? '과세' : '면세'))
    /* 비목을 **보낸 요청만** 갱신한다. 청구서 폼이 아닌 화면(정산·상태 변경)이 저장할 때
     * 빈 값으로 덮으면 발행 전표의 계정과목이 한 번에 사라진다
     * (정산내역서에서 겪은 '화면에서 뺀 필드가 저장 한 번에 소멸' 과 같은 유형). */
    /* ⚠ 두 칸을 **따로** 갱신한다. 예전엔 둘 중 하나만 보내도 둘 다 썼다.
     *
     * 청구서 폼은 category 만 보낸다(Billing.jsx). 그래서 만기일 한 칸만 고쳐 저장해도
     * account_code 가 **현재 비목 매핑으로 다시 계산**됐다 — 이 파일 머리말이 "스냅샷이라
     * 나중에 비목 연결이 바뀌어도 발행 전표는 그대로 남는다"고 약속한 것과 반대다.
     * 반대로 account_code 만 보내면 category 가 NULL 로 지워졌다.
     *
     * 규칙:
     *   account_code 를 보냈다        → 그대로 쓴다(명시적 지정)
     *   비목이 실제로 **바뀌었다**     → 계정과목도 따라 바꾼다(안 바꾸면 옛 계정이 남는다)
     *   비목을 보냈지만 그대로다       → account_code 를 건드리지 않는다(스냅샷 보존)
     */
    const sets = []
    const vals = []
    let curInv = null
    if (category !== undefined || account_code !== undefined) {
      // 등록·분할과 같은 규칙 — 한 입구만 막으면 다른 입구로 우회된다
      const fe = fundAccountError(account_code)
      if (fe) { await rollbackQuietly(conn); return res.status(400).json({ error: fe }) }
      const [[row]] = await conn.execute(
        'SELECT kind, category, account_code FROM invoices WHERE id = ?', [req.params.id])
      curInv = row || null
    }
    if (category !== undefined) { sets.push('category=?'); vals.push(category || null) }
    if (account_code !== undefined) {
      sets.push('account_code=?')
      vals.push(await resolveInvoiceAcctCode(conn, account_code, category, curInv?.kind))
    } else if (category !== undefined && String(category || '') !== String(curInv?.category || '')) {
      sets.push('account_code=?')
      vals.push(await resolveInvoiceAcctCode(conn, null, category, curInv?.kind))
    }

    const [result] = await conn.execute(
      `UPDATE invoices SET vendor_id=?, contract_id=?, supply_amount=?, vat_amount=?, total_amount=?, issued_at=?, due_at=?, account_id=?, memo=?, tax_type=?
         ${sets.length ? ', ' + sets.join(', ') : ''}
       WHERE id=?`,
      [vendor_id||null, contract_id||null, supply_amount, vat_amount, total_amount, issued_at, due_at||null, account_id||null, memo||'', taxType, ...vals, req.params.id]
    )
    if (result.affectedRows === 0) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    /* 품목 내역 — lines 를 **보낸 요청만** 갱신한다.
       청구서를 다루지 않는 화면(정산·상태 변경)의 저장이 기존 품목표를 지우면 안 된다
       (주문 items·cost_budget 과 같은 부분 수정 보존 원칙). */
    await writeInvoiceLines(conn, req.params.id, req.body.lines)
    // 금액이 바뀌면 상태도 바뀐다(완납이 일부입금으로, 또는 그 반대). 정산 누계로 확정한다.
    const st = await recalcInvoiceStatus(conn, req.params.id)
    await conn.commit()
    res.json({ ok: true, status: st?.status, paidAmount: st?.paid, remainAmount: st?.remain })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.delete('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const id = req.params.id
    // 입금/지급(매칭) 내역이 있으면 삭제 금지 — 이미 장부에 반영된 돈이므로
    const [[{ mcnt }]] = await conn.execute('SELECT COUNT(*) AS mcnt FROM invoice_matches WHERE invoice_id = ?', [id])
    if (mcnt > 0) { await rollbackQuietly(conn); return res.status(409).json({ error: '입금·지급 내역이 있는 청구서는 삭제할 수 없어요. 먼저 입금 매칭을 취소하세요.' }) }
    // 정기청구에서 나온 회차면 last_generated 를 되돌려 '발행 예정'에 다시 뜨게 한다.
    // 안 하면 그 달치가 자동 생성에도 예정 목록에도 안 나와 매출이 조용히 미청구로 사라진다.
    const [[inv]] = await conn.execute('SELECT recurring_id, issued_at, kind FROM invoices WHERE id = ?', [id])
    if (!inv) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    // 마감된 달의 청구서를 지우면 이미 신고한 부가세 자료가 줄어든다 → 막는다
    { const ce = await closedPeriodError(conn, inv.issued_at); if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) } }
    await conn.execute('DELETE FROM invoice_matches WHERE invoice_id = ?', [id])
    await conn.execute('DELETE FROM invoice_docs WHERE invoice_id = ?', [id])
    await conn.execute('UPDATE transactions SET invoice_id = NULL WHERE invoice_id = ?', [id])
    // 연결된 청구 일정은 '예정'으로 되돌려 발행 예정에 다시 노출(고아 방지)
    await conn.execute("UPDATE milestones SET status = '예정', invoice_id = NULL WHERE invoice_id = ?", [id])
    await conn.execute('DELETE FROM invoices WHERE id = ?', [id])
    /* 규칙 테이블은 청구서 종류를 따라간다. 여태 매출이든 매입이든 recurring_invoices 만 봤는데,
       정기지출에서 나온 매입 청구서의 recurring_id 는 recurring_expenses 의 것이다 —
       그 표에서 찾으니 없는 규칙이라 조용히 아무것도 안 되돌리고, 지운 그 달치가
       '놓친 회차'에도 자동 생성에도 영영 안 떴다(일괄 삭제는 처음부터 종류를 봤다). */
    const rec = inv?.recurring_id
      ? await restoreLastGenerated(conn,
          inv.kind === 'issued' ? 'recurring_invoices' : 'recurring_expenses',
          inv.recurring_id, inv.issued_at)
      : { restored: false, note: null }
    await conn.commit()
    res.json({ ok: true, recurringNote: rec.note })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

router.post('/:id/matches', async (req, res, next) => {
  // account_code(계정과목 코드)와 account_id(입출금 계좌)는 다른 값이다 — 섞지 말 것.
  const { txn_id, amount, date, category, memo, account_code, account_id } = req.body
  const invoiceId = req.params.id
  const dateErr = futureDateError(date)
  if (dateErr) return res.status(400).json({ error: dateErr })
  // 매칭은 실제 입금/지급 거래를 만들거나 상태를 완료로 바꾼다 → 마감된 달이면 막는다
  const closedErr = await closedPeriodError(req.db, date)
  if (closedErr) return res.status(409).json({ error: closedErr })
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[inv]] = await conn.execute('SELECT * FROM invoices WHERE id = ? FOR UPDATE', [invoiceId])
    if (!inv) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const isIssued = inv.kind === 'issued'

    /* 잔여를 넘는 정산은 **거절한다**(예전엔 잘라서 기록했다).
     *
     * 자르면 통장에 300만이 들어왔는데 장부에는 100만만 남고, 화면은 "매칭 처리가 완료됐어요"를
     * 띄운다 — 사용자는 200만이 사라진 걸 모른다. 다른 탭이 먼저 정산해 잔여가 줄었을 때
     * 실제로 일어나는 일이고, 조용히 틀린 금액은 되돌리기도 어렵다.
     * 잔여가 바뀐 사실을 알려주고 사용자가 다시 판단하게 하는 편이 맞다. */
    const [[{ paid: prevPaid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [invoiceId])
    const remainBefore = Number(inv.total_amount) - Number(prevPaid)
    if (remainBefore <= 0) { await rollbackQuietly(conn); return res.status(400).json({ error: '이미 정산이 완료된 청구서예요' }) }
    const matchAmount = Number(amount) || 0
    if (matchAmount <= 0) { await rollbackQuietly(conn); return res.status(400).json({ error: '매칭 금액이 올바르지 않아요' }) }
    if (matchAmount > remainBefore) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `남은 금액은 ${remainBefore.toLocaleString('ko-KR')}원이에요`
             + `(${matchAmount.toLocaleString('ko-KR')}원 입력). 그 사이 다른 정산이 있었는지 확인하고 다시 시도해주세요.` })
    }

    // 매칭 대상 거래: 기존 거래가 있으면 그대로, 없으면 실제 거래를 새로 만들어 거래내역에 반영
    let realTxnId = null
    if (txn_id) {
      // 다른 청구서에 이미 매칭된 거래는 재사용 금지(이중 매칭 방지)
      const [[dup]] = await conn.execute('SELECT invoice_id FROM invoice_matches WHERE txn_id = ? LIMIT 1', [txn_id])
      if (dup) { await rollbackQuietly(conn); return res.status(409).json({ error: '이미 다른 청구서에 매칭된 거래예요' }) }
      const [[ex]] = await conn.execute('SELECT id FROM transactions WHERE id = ?', [txn_id])
      if (ex) realTxnId = ex.id
    }
    if (realTxnId) {
      // 기존 거래를 재사용할 때 invoice_id만 붙이면, 그 거래가 아직 '지급 대기'인 경우
      // 청구서만 완료되고 지출은 계좌 잔액에서 빠지지 않는다(accounts.js는 '지급완료'만 센다).
      // 정산했다는 것은 실제로 돈이 오갔다는 뜻이므로 거래도 완료 상태로 맞춘다.
      const [[cur]] = await conn.execute('SELECT status, account_id FROM transactions WHERE id = ?', [realTxnId])
      const acct = cur?.account_id || account_id || inv.account_id || null
      const lerr = ledgerError({ kind: isIssued ? 'income' : 'expense', account_id: acct, status: isIssued ? '입금완료' : '지급완료' })
      if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: lerr }) }
      await conn.execute(
        'UPDATE transactions SET invoice_id = ?, status = ?, account_id = ? WHERE id = ?',
        [invoiceId, isIssued ? '입금완료' : '지급완료', acct, realTxnId])
    } else {
      // 정산은 실제로 돈이 오간 것이므로 status를 완료형으로 확정한다. 그런데 계좌가 비면
      // 그 돈은 어느 계좌 잔액에도 잡히지 않는다(accounts.js calcBalance는 account_id로 계좌를
      // 특정해 합산). 정기청구·주문에서 자동 생성된 청구서는 account_id가 NULL이므로
      // 여기서 막지 않으면 입금이 통째로 잔액에서 누락된다 — 과거 F-02와 동일 유형.
      const acct = account_id || inv.account_id || null
      const lerr = ledgerError({ kind: isIssued ? 'income' : 'expense', account_id: acct, status: isIssued ? '입금완료' : '지급완료' })
      if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: lerr }) }
      realTxnId = randomUUID()
      const cat   = (category && category.trim()) || (isIssued ? '수금' : '대금 지급')
      const memoV = (memo && memo.trim()) || `청구서 ${inv.invoice_no || ''} 정산`.trim()
      await conn.execute(`
        INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, category, amount, date, method, status, doc_no, invoice_id, memo, account_code)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [realTxnId, isIssued ? 'income' : 'expense', inv.vendor_id || null, inv.contract_id || null,
          acct, cat, matchAmount,
          date || kstToday(), '계좌이체',   // UTC(new Date())면 KST 새벽에 하루 전으로 찍힌다
          isIssued ? '입금완료' : '지급완료', inv.contract_id ? '' : '공통', invoiceId, memoV,
          /* 계정과목은 화면에서 '선택'이라 대부분 비워서 온다. 그대로 두면 일계표에서
             상대 계정이 없어 차변·대변이 안 맞는다(실제로 수금 1,687만원 거래가 불일치로 떴다).
             정산 거래의 상대 계정은 이미 정해져 있다 — 매출·매입은 청구서 발행 시점에
             인식됐고 지금은 그때 생긴 채권·채무가 사라지는 것이다(외상매출금/외상매입금).
             사용자가 고른 값이 있으면 그것을 우선한다. */
          account_code || settleAcctCode(isIssued ? 'income' : 'expense')])
    }

    const id = randomUUID()
    // txn_created: 이 거래를 정산이 만들었는가. 취소할 때 함께 지울지가 여기서 갈린다.
    // 기존 거래를 연결한 경우(txn_id를 받은 경우)는 0 — 취소해도 그 거래는 남아야 한다.
    const createdHere = !txn_id
    await conn.execute(
      'INSERT INTO invoice_matches (id, invoice_id, txn_id, amount, txn_created) VALUES (?,?,?,?,?)',
      [id, invoiceId, realTxnId, matchAmount, createdHere ? 1 : 0])

    // 매칭 누계로 청구서 상태 자동 갱신 (규칙은 lib/invoiceStatus.js 하나에만 둔다)
    await recalcInvoiceStatus(conn, invoiceId)

    await conn.commit()
    res.json({ id, txn_id: realTxnId })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/* ── 일괄 처리 ────────────────────────────────────────────────────
 *
 * 고객 요청: "청구서 대금도 한 번에 다중 처리(일괄 지급 처리)했으면 좋겠다.
 *            특정 거래처 대금을 한 번에 지급하는 식으로."
 *
 * 원칙 — **하나라도 막히면 전부 멈춘다.**
 * 일부만 처리하고 "5건 중 3건 됐어요"라고 말하면, 나머지 2건이 무엇이었는지 사용자가
 * 되짚어야 한다. 돈이 오가는 일에서 그 되짚기는 현실적으로 안 일어난다.
 * 그래서 미리 전부 검사하고, 걸리는 게 있으면 무엇이 왜 걸렸는지 말한 뒤 아무것도 안 한다.
 * (놓친 회차 일괄 발행·소급 등록이 같은 규칙을 쓴다)
 */
router.post('/bulk/settle', async (req, res, next) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : []
  if (!ids.length) return res.status(400).json({ error: '처리할 청구서를 선택해주세요' })
  if (ids.length > 100) return res.status(400).json({ error: `한 번에 100건까지예요 (${ids.length}건 선택). 기간이나 거래처로 좁혀주세요.` })

  const date = String(req.body.date || kstToday())
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '처리일 형식이 올바르지 않아요 (YYYY-MM-DD)' })
  // 미래 날짜로 돈이 오간 것으로 만들 수 없다(단건 정산·거래 등록과 같은 규칙)
  { const de = futureDateError(date); if (de) return res.status(400).json({ error: de }) }

  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    // 마감된 달이면 아무것도 만들지 않는다 — 처리일 하나로 전부 들어가므로 한 번만 본다
    { const ce = await closedPeriodError(conn, date)
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) } }

    const ph = ids.map(() => '?').join(',')
    const [invs] = await conn.execute(`SELECT * FROM invoices WHERE id IN (${ph}) FOR UPDATE`, ids)
    if (invs.length !== ids.length) { await rollbackQuietly(conn); return res.status(404).json({ error: '없는 청구서가 섞여 있어요. 목록을 새로고침해주세요.' }) }

    // 1) 먼저 전부 검사한다(아무것도 만들기 전에)
    const blocked = []
    const plan = []
    for (const inv of invs) {
      const [[{ paid }]] = await conn.execute(
        'SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [inv.id])
      const remain = Number(inv.total_amount) - Number(paid)
      if (remain <= 0) { blocked.push(`${inv.invoice_no}: 이미 정산 완료`); continue }
      const isIssued = inv.kind === 'issued'
      const acct = req.body.account_id || inv.account_id || null
      const lerr = ledgerError({ kind: isIssued ? 'income' : 'expense', account_id: acct,
        status: isIssued ? '입금완료' : '지급완료' })
      // 계좌가 없으면 그 돈은 어느 계좌 잔액에도 안 잡힌다 — 조용히 새는 것보다 막는 게 낫다
      if (lerr) { blocked.push(`${inv.invoice_no}: ${lerr}`); continue }
      plan.push({ inv, remain, isIssued, acct })
    }
    if (blocked.length) {
      await rollbackQuietly(conn)
      /* 같은 이유가 건마다 반복되면(계좌 미지정 4건 등) 읽히지 않는다 —
         이유별로 묶고 대표 청구번호만 보여준다. */
      const byReason = new Map()
      for (const b of blocked) {
        const [no, ...rest] = b.split(': ')
        const reason = rest.join(': ')
        if (!byReason.has(reason)) byReason.set(reason, [])
        byReason.get(reason).push(no)
      }
      const lines = [...byReason].map(([reason, nos]) =>
        `${reason} (${nos.slice(0, 3).join(', ')}${nos.length > 3 ? ` 외 ${nos.length - 3}건` : ''})`)
      return res.status(409).json({
        error: `처리할 수 없는 청구서가 있어 아무것도 처리하지 않았어요.\n· ${lines.join('\n· ')}`,
        blocked,
      })
    }

    // 2) 전부 통과했을 때만 만든다. 되돌릴 수 있게 한 묶음으로 표시한다.
    const batch = randomUUID()
    const done = []
    for (const { inv, remain, isIssued, acct } of plan) {
      const txnId = randomUUID()
      await conn.execute(`
        INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, category, amount, date, method, status, doc_no, invoice_id, memo, account_code, backfill_batch)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txnId, isIssued ? 'income' : 'expense', inv.vendor_id || null, inv.contract_id || null,
         acct, isIssued ? '수금' : '대금 지급', remain, date, '계좌이체',
         isIssued ? '입금완료' : '지급완료', inv.contract_id ? '' : '공통', inv.id,
         `청구서 ${inv.invoice_no || ''} 정산 (일괄)`.trim(),
         settleAcctCode(isIssued ? 'income' : 'expense'), batch])
      await conn.execute(
        'INSERT INTO invoice_matches (id, invoice_id, txn_id, amount, txn_created) VALUES (?,?,?,?,1)',
        [randomUUID(), inv.id, txnId, remain])
      await recalcInvoiceStatus(conn, inv.id)
      done.push({ id: inv.id, invoice_no: inv.invoice_no, amount: remain })
    }
    await conn.commit()
    res.json({ ok: true, batch, count: done.length, total: done.reduce((s, d) => s + d.amount, 0), done })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/** 일괄 삭제 — 정산이 붙은 건·마감된 달은 전체를 멈춘다(단건 삭제와 같은 가드). */
router.post('/bulk/delete', async (req, res, next) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : []
  if (!ids.length) return res.status(400).json({ error: '삭제할 청구서를 선택해주세요' })
  if (ids.length > 100) return res.status(400).json({ error: `한 번에 100건까지예요 (${ids.length}건 선택).` })

  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const ph = ids.map(() => '?').join(',')
    const [invs] = await conn.execute(`SELECT * FROM invoices WHERE id IN (${ph}) FOR UPDATE`, ids)
    /* 고른 것 중 없는 게 섞였으면 멈춘다. 그냥 진행하면 "8건 삭제했어요"라고 해놓고
       실제로는 6건만 지워진다 — 목록이 낡았다는 뜻이므로 새로고침을 시켜야 한다. */
    if (invs.length !== ids.length) {
      await rollbackQuietly(conn)
      return res.status(404).json({ error: '없는 청구서가 섞여 있어요. 목록을 새로고침해주세요.' })
    }

    const blocked = []
    for (const inv of invs) {
      const [[{ mcnt }]] = await conn.execute(
        'SELECT COUNT(*) AS mcnt FROM invoice_matches WHERE invoice_id = ?', [inv.id])
      if (Number(mcnt) > 0) { blocked.push(`${inv.invoice_no}: 입금·지급 내역이 있어요(먼저 정산을 취소하세요)`); continue }
      const ce = await closedPeriodError(conn, inv.issued_at)
      if (ce) blocked.push(`${inv.invoice_no}: ${ce}`)
    }
    if (blocked.length) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `지울 수 없는 청구서가 있어 아무것도 지우지 않았어요.\n· ${blocked.join('\n· ')}`, blocked })
    }

    for (const inv of invs) {
      await conn.execute('DELETE FROM invoice_docs WHERE invoice_id = ?', [inv.id])
      await conn.execute('UPDATE transactions SET invoice_id = NULL WHERE invoice_id = ?', [inv.id])
      // 연결된 청구 일정은 '예정'으로 되돌린다 — 안 하면 그 일정이 영영 발행 대기에 안 뜬다
      await conn.execute("UPDATE milestones SET status = '예정', invoice_id = NULL WHERE invoice_id = ?", [inv.id])
      await conn.execute('DELETE FROM invoices WHERE id = ?', [inv.id])
      // 정기청구에서 나온 회차면 하한을 되돌려 그 달이 다시 청구 가능해지게(단건 삭제와 같은 처리)
      if (inv.recurring_id) {
        await restoreLastGenerated(conn, inv.kind === 'issued' ? 'recurring_invoices' : 'recurring_expenses',
          inv.recurring_id, inv.issued_at)
      }
    }
    await conn.commit()
    res.json({ ok: true, count: invs.length })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// ── 매칭 후보: 거래내역에 이미 있는(미매칭) 같은 종류 거래 ──
router.get('/:id/matchable', async (req, res, next) => {
  try {
    const [invRows] = await req.db.execute('SELECT kind, vendor_id, supply_amount, total_amount FROM invoices WHERE id = ?', [req.params.id])
    const inv = invRows[0]
    if (!inv) return res.json([])
    const txnKind = inv.kind === 'issued' ? 'income' : 'expense'
    const [[{ paid }]] = await req.db.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [req.params.id])
    const supply = Number(inv.supply_amount), total = Number(inv.total_amount), remain = total - Number(paid)
    const [rows] = await req.db.execute(`
      SELECT t.id, t.amount, t.date, t.category, t.vendor_id, t.status, t.account_id, v.name AS vendor_name
      FROM transactions t
      LEFT JOIN vendors v ON t.vendor_id = v.id
      WHERE t.kind = ?
        AND (t.invoice_id IS NULL OR t.invoice_id = '')
        AND t.id NOT IN (SELECT txn_id FROM invoice_matches)
      ORDER BY t.date DESC
      LIMIT 100
    `, [txnKind])
    const enriched = rows.map(r => {
      const amt = Number(r.amount)
      const sameVendor = !!inv.vendor_id && r.vendor_id === inv.vendor_id
      const matchTotal = amt === total
      const matchSupply = amt === supply
      const matchRemain = amt === remain
      const related = sameVendor || matchTotal || matchSupply || matchRemain
      // 정렬 점수: 거래처+금액 둘 다 일치 > 금액 일치 > 거래처 일치
      const score = (sameVendor ? 1 : 0) + ((matchTotal || matchRemain || matchSupply) ? 2 : 0)
      return { ...r, sameVendor, matchTotal, matchSupply, matchRemain, related, score }
    })
    enriched.sort((a, b) => (b.score - a.score) || (a.date < b.date ? 1 : -1))
    res.json(enriched)
  } catch (e) { next(e) }
})

router.delete('/:id/matches/:matchId', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[inv]] = await conn.execute('SELECT * FROM invoices WHERE id = ? FOR UPDATE', [req.params.id])
    if (!inv) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const [[match]] = await conn.execute(
      'SELECT txn_id, txn_created FROM invoice_matches WHERE id = ? AND invoice_id = ?', [req.params.matchId, req.params.id])
    if (!match) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    /* 정산이 만든 거래는 함께 지운다. 남기면 같은 돈이 두 몫으로 존재한다 —
     * 계좌 잔액에는 입금이 그대로 있는데 미수금도 부활해서, 자산이 그만큼 과대 계상된다.
     * 반대로 이미 있던 거래를 연결한 것(txn_created=0)은 청구서 연결만 끊고 장부에 남긴다.
     * 그 거래는 실제로 오간 돈의 독립 기록이고, 지우면 계좌 잔액이 틀어진다.
     * 구분 컬럼이 없던 시절(txn_created 기본 0) 데이터는 보수적으로 '남기는' 쪽이다. */
    /* 지급결의서로 집행된 지출은 여기서 못 끊는다.
     * 결의서(expense_resolutions)가 그 거래를 자기 결과물로 붙들고 있어서(status='완료', txn_id),
     * 연결만 끊으면 결의서는 '완료'인데 청구서는 미지급으로 되살아나 같은 건이 두 번 지급 대상이 된다.
     * 되돌릴 곳은 결의서다 — 어디로 가야 하는지 알려주고 막는다. */
    if (match.txn_id) {
      const [[res0]] = await conn.execute(
        'SELECT doc_no FROM expense_resolutions WHERE txn_id = ? LIMIT 1', [match.txn_id])
      if (res0) {
        await rollbackQuietly(conn)
        return res.status(409).json({
          error: `이 건은 지급결의서 ${res0.doc_no || ''}로 집행됐어요. 결의서에서 되돌려주세요.`.replace('  ', ' '),
        })
      }
    }
    let removedTxn = null
    if (match.txn_id) {
      if (Number(match.txn_created) === 1) {
        // 마감된 달의 거래를 지우면 그 달 잔액이 사후에 바뀐다 → 막는다
        const [[txn]] = await conn.execute('SELECT date FROM transactions WHERE id = ?', [match.txn_id])
        const ce = txn ? await closedPeriodError(conn, txn.date) : null
        if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
        await conn.execute('DELETE FROM transactions WHERE id = ?', [match.txn_id])
        removedTxn = match.txn_id
      } else {
        await conn.execute('UPDATE transactions SET invoice_id = NULL WHERE id = ?', [match.txn_id])
      }
    }
    await conn.execute('DELETE FROM invoice_matches WHERE id = ? AND invoice_id = ?', [req.params.matchId, req.params.id])
    // 남은 매칭 누계로 상태 재계산 — 안 하면 remain이 생겨도 '완료'로 남아 미수/미지급이 누락된다.
    const st = await recalcInvoiceStatus(conn, req.params.id)
    await conn.commit()
    res.json({ ok: true, status: st?.status, removedTxn })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

// ── 청구서 첨부 서류 ──
router.post('/:id/docs', async (req, res, next) => {
  try {
    const { url, name, doc_type, size } = req.body
    if (!url) return res.status(400).json({ error: 'url 필수' })
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO invoice_docs (id, invoice_id, url, name, doc_type, size) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, url, name || '', doc_type || '', size || 0]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.delete('/docs/:docId', async (req, res, next) => {
  try {
    // DB 행만 지우면 실제 파일이 uploads/{companyId}/ 에 그대로 남는다(고아 파일).
    const [[doc]] = await req.db.execute('SELECT url FROM invoice_docs WHERE id = ?', [req.params.docId])
    await req.db.execute('DELETE FROM invoice_docs WHERE id = ?', [req.params.docId])
    if (doc) removeUploadedFile(doc.url, req.user?.companyId)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
// 입력 검증은 DB 없이 검증한다(test/invoiceCreate.test.js) — 여기서 놓치면 500이 된다
module.exports._invoiceCreateError = invoiceCreateError
