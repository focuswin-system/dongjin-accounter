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

const router = Router()

const RECEIVABLE_STATUSES = new Set(['입금 예정', '일부 입금', '기한 지남', '장기 미수'])
const PAYABLE_STATUSES    = new Set(['지급 대기', '지급 예정', '일부 지급', '기한 지남'])

async function attachMatches(db, invoice) {
  const [matches] = await db.execute('SELECT * FROM invoice_matches WHERE invoice_id = ?', [invoice.id])
  const [docs] = await db.execute('SELECT id, url, name, doc_type, size, created_at FROM invoice_docs WHERE invoice_id = ? ORDER BY created_at', [invoice.id])
  const paid = matches.reduce((s, m) => s + Number(m.amount), 0)
  return { ...invoice, matches, docs, paidAmount: paid, remainAmount: Number(invoice.total_amount) - paid }
}

router.get('/', async (req, res, next) => {
  try {
    const { kind, status, vendorId, from, to } = req.query
    let sql = 'SELECT i.*, v.name AS vendor_name, c.name AS contract_name FROM invoices i LEFT JOIN vendors v ON i.vendor_id = v.id LEFT JOIN contracts c ON i.contract_id = c.id WHERE 1=1'
    const params = []
    if (kind)     { sql += ' AND i.kind = ?';       params.push(kind) }
    if (status)   { sql += ' AND i.status = ?';     params.push(status) }
    if (vendorId) { sql += ' AND i.vendor_id = ?';  params.push(vendorId) }
    if (from)     { sql += ' AND i.issued_at >= ?'; params.push(from) }
    if (to)       { sql += ' AND i.issued_at <= ?'; params.push(to) }
    sql += ' ORDER BY i.issued_at DESC'
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
  // 단가는 넣지 않는다 — 계산서 한 건의 값을 기준단가로 굳히면 나중 견적·계약이 그 값을 물려받는다.
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
    const itemId = await resolveItemId(db, itemIdx, l, register)
    await db.execute(
      'INSERT INTO invoice_lines (id, invoice_id, item_id, name, spec, unit, qty, unit_price, amount, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [randomUUID(), invoiceId, itemId, l.name || '(품목명 없음)', l.spec, null, l.qty, l.unit_price, l.amount, ++ord])
  }
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
router.get('/import/template', (req, res, next) => {
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
    const ws = xlsx.utils.aoa_to_sheet(rows)
    ws['!cols'] = [{ wch: 12 }, { wch: 28 }, { wch: 18 }, { wch: 20 },
      { wch: 20 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 8 },
      { wch: 22 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 16 }]

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
    const wsGuide = xlsx.utils.aoa_to_sheet(guide)
    wsGuide['!cols'] = [{ wch: 100 }]

    const wb = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(wb, ws, '세금계산서')
    xlsx.utils.book_append_sheet(wb, wsGuide, '작성안내')
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="tax_invoice_import_template.xlsx"; filename*=UTF-8''${encodeURIComponent('세금계산서_업로드_양식.xlsx')}`)
    res.send(buf)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM invoices WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(await attachMatches(req.db, rows[0]))
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo, tax_type } = req.body
    /* 금액 검증이 아예 없어서 **0원·음수 청구서가 그대로 저장됐다**(실제로 0원 청구서가
     * '입금 예정'으로 남아 홈 '할 일'에 떠 있었다). 음수 청구서는 미수금 총액을 깎아
     * 다른 청구서를 상계하고, 부가세 과세표준도 함께 줄인다.
     * 거래(transactions)·결의서는 이미 amountError 를 통과해야 하는데 청구서만 빠져 있었다. */
    { const ae = amountError(total_amount); if (ae) return res.status(400).json({ error: ae }) }
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
    // (영세는 세액이 0이라 추론이 안 되므로 반드시 명시해야 한다 — 계약에서 발행하면 자동으로 채워진다)
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
    await req.db.execute(
      'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo, tax_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, invoice_no, kind, vendor_id||null, contract_id||null, supply_amount, vat_amount, total_amount, issued_at, due_at||null, status||(kind==='issued' ? '입금 예정' : '지급 대기'), account_id||null, memo||'', taxType]
    )
    res.json({ id, invoice_no })
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
router.put('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const { vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, account_id, memo, tax_type } = req.body
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
    const [result] = await conn.execute(
      'UPDATE invoices SET vendor_id=?, contract_id=?, supply_amount=?, vat_amount=?, total_amount=?, issued_at=?, due_at=?, account_id=?, memo=?, tax_type=? WHERE id=?',
      [vendor_id||null, contract_id||null, supply_amount, vat_amount, total_amount, issued_at, due_at||null, account_id||null, memo||'', taxType, req.params.id]
    )
    if (result.affectedRows === 0) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
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
    const [[inv]] = await conn.execute('SELECT recurring_id, issued_at FROM invoices WHERE id = ?', [id])
    if (!inv) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    // 마감된 달의 청구서를 지우면 이미 신고한 부가세 자료가 줄어든다 → 막는다
    { const ce = await closedPeriodError(conn, inv.issued_at); if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) } }
    await conn.execute('DELETE FROM invoice_matches WHERE invoice_id = ?', [id])
    await conn.execute('DELETE FROM invoice_docs WHERE invoice_id = ?', [id])
    await conn.execute('UPDATE transactions SET invoice_id = NULL WHERE invoice_id = ?', [id])
    // 연결된 청구 일정은 '예정'으로 되돌려 발행 예정에 다시 노출(고아 방지)
    await conn.execute("UPDATE milestones SET status = '예정', invoice_id = NULL WHERE invoice_id = ?", [id])
    await conn.execute('DELETE FROM invoices WHERE id = ?', [id])
    const rec = inv?.recurring_id
      ? await restoreLastGenerated(conn, 'recurring_invoices', inv.recurring_id, inv.issued_at)
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
      // 특정해 합산). 정기청구·계약에서 자동 생성된 청구서는 account_id가 NULL이므로
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
