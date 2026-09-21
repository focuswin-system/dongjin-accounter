/* 반복거래 — "매달 비슷하게 오가는 돈"을 목록에서 골라 한 번에 만든다.
 *
 * ── 정기 규칙과 무엇이 다른가 ──
 * 예전 정기 규칙은 회차를 **기억**했다(last_generated·건너뛰기·소급 묶음). 그 기억이 장부와
 * 어긋나는 순간 같은 달을 두 번 청구하거나 한 달이 조용히 사라졌다 — 이 저장소가 여러 번 겪었다.
 * 반복거래는 아무것도 기억하지 않는다. **그 달에 이 반복거래로 만든 청구서·거래가 있는가**만 본다.
 * 만든 것을 지우면 저절로 '안 만듦'이 되고, 되돌리는 코드도 필요 없다.
 *
 * 설계: docs/02-design/features/repeat-templates.design.md
 * ⚠ 멀티테넌트 — db/conn 은 늘 인자로 받는다.
 */
const { randomUUID } = require('crypto')
const { periodMonths, PERIODS } = require('./recurPeriod')
const { daysInMonth, cashDateOf, PAY_TERMS, PAY_TERMS_WITH_DAY } = require('./payTerm')
const { VAT_RATE } = require('./vat')
const { createInvoice } = require('./invoiceCreate')
const { insertExpenseTxn } = require('./directTxn')
const { acctCodeByCategoryName } = require('./categoryAccount')
const { closedPeriodError, closedDocError } = require('./closing')
const { amountError, MAX_AMOUNT } = require('./ledger')
const { lookalikeSettleTxns } = require('./settleTxn')
const { httpError } = require('./withTx')

const VAT_MODES = ['exclusive', 'inclusive', 'none', 'zero']
const pad = (n) => String(n).padStart(2, '0')
const YM_RE = /^\d{4}-\d{2}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/* ── 날짜 ─────────────────────────────────────────────────────────── */

/** 이 반복거래가 그 달(YYYY-MM)에 도는가 — 주기와 기준 달로만 본다(계약은 따로) */
function occursInMonth(t, ym) {
  const step = periodMonths(t.period)
  if (step === 1) return true
  const m = Number(String(ym).slice(5, 7))
  const anchor = Number(t.anchor_month) || 1
  return (((m - anchor) % step) + step) % step === 0
}

/** 그 달의 날짜. 일자 0(만들 때 고름)이면 null. 말일을 넘으면 말일로 */
function dateInMonth(t, ym) {
  const day = Number(t.day_of_month) || 0
  if (!day) return null
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7))
  return `${ym}-${pad(Math.min(day, daysInMonth(y, m - 1)))}`
}

const monthRange = (ym) => {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7))
  return { from: `${ym}-01`, to: `${ym}-${pad(daysInMonth(y, m - 1))}` }
}

/** 다음 달 YYYY-MM */
const nextYm = (ym) => {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7))
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`
}

/* 계약에 붙은 반복거래는 **계약이 살아 있을 때만** 뜬다(사용자 확정 2026-09-15).
 * 갱신·종료 때 반복거래를 고치지 않는 대신 여기서 계산한다 — 계약이 원본, 반복거래는 복사틀이다.
 * c 가 없으면(계약 없음) 늘 통과. date 가 없으면(일자 0) 그 달이 계약 기간과 겹치는지로 본다.
 *
 * ⚠ 청구 방식(billing_mode)은 보지 않는다. 옛 정기지출은 총액형 발주에도 붙일 수 있었고 그대로 돌았다 —
 *   방식으로 거르면 옮겨 온 반복거래가 아무 표시 없이 목록에서 사라진다. 정기형을 다른 방식으로 바꾸는
 *   경우는 계약 수정이 그 반복거래를 **꺼서**(보이는 상태로) 처리한다(routes/contracts.js PUT). */
function contractAllows(t, ym, date) {
  if (!t.contract_id) return true
  if (t.c_status !== '진행중') return false
  const start = String(t.c_start || '').slice(0, 10)
  const end = String(t.c_end || '').slice(0, 10)
  const { from, to } = monthRange(ym)
  const lo = date || to
  const hi = date || from
  if (start && lo < start) return false
  if (end && hi > end) return false
  return true
}

/* ── 금액 ─────────────────────────────────────────────────────────── */

/** 금액 + 부가세 방식 → 공급가·세액·합계·과세유형 */
function amountsOf(vatMode, amount) {
  const a = Math.round(Number(amount) || 0)
  if (vatMode === 'none') return { supply: a, vat: 0, total: a, taxType: '면세' }
  if (vatMode === 'zero') return { supply: a, vat: 0, total: a, taxType: '영세' }
  if (vatMode === 'inclusive') {
    const supply = Math.round(a / (1 + VAT_RATE))
    return { supply, vat: a - supply, total: a, taxType: '과세' }
  }
  const vat = Math.round(a * VAT_RATE)
  return { supply: a, vat, total: a + vat, taxType: '과세' }
}

/** 내용의 {월} 을 그 달 숫자로 — "{월}월 임차료" → "9월 임차료" */
const itemText = (t, ym) => String(t.item || '').replace(/\{월\}/g, String(Number(ym.slice(5, 7))))

/* ── 저장 전 검사 ─────────────────────────────────────────────────── */

/**
 * 반복거래 입력 → 저장할 값. 틀리면 { error, field }.
 * 만들 때 막히는 것(계좌 없는 바로 출금, 비목 없는 출금)은 **등록할 때** 막는다 —
 * 매달 목록에서 체크했는데 그때 가서 막히면 사람은 그 반복거래를 버린다.
 */
function normalizeTemplate(body) {
  const b = body || {}
  const fail = (error, field) => ({ error, field })
  const direction = b.direction === 'out' ? 'out' : b.direction === 'in' ? 'in' : null
  if (!direction) return fail('입금·출금을 골라주세요', 'direction')
  const creates = direction === 'in' ? 'invoice' : (b.creates === 'txn' ? 'txn' : 'invoice')
  const item = String(b.item ?? '').trim().slice(0, 255)
  if (!item) return fail('내용을 입력해주세요', 'item')
  const category = String(b.category ?? '').trim().slice(0, 100) || null
  /* 출금은 비목이 곧 계정과목이다 — 없으면 전표의 비용 줄이 비어 일계표 차·대변이 안 맞는다 */
  if (direction === 'out' && !category) return fail('비목을 골라주세요', 'category')
  const amount = Math.round(Number(String(b.amount ?? '').replace(/[^0-9.-]/g, '')) || 0)
  if (!(amount > 0)) return fail('금액을 입력해주세요', 'amount')
  if (amount > MAX_AMOUNT) return fail('금액이 너무 커요', 'amount')
  const vatMode = VAT_MODES.includes(b.vat_mode) ? b.vat_mode : 'exclusive'
  const period = PERIODS.includes(b.period) ? b.period : 'monthly'
  const anchorMonth = Math.min(12, Math.max(1, parseInt(b.anchor_month, 10) || 1))
  const day = parseInt(b.day_of_month, 10)
  const dayOfMonth = Number.isFinite(day) ? Math.min(31, Math.max(0, day)) : 1
  const accountId = b.account_id ? String(b.account_id) : null
  if (creates === 'txn' && !accountId) return fail('출금 계좌를 골라주세요', 'account_id')
  /* 청구서를 만드는 규칙은 거래처가 있어야 한다 — 청구서를 만드는 다른 창구는 전부 거래처를 요구한다.
     비면 거래처 없는 청구서가 매달 서고(미수금·대사에서 '—'), findLookalikes 가 거래처 없이는
     후보를 못 찾아 **중복 방지까지 꺼진다**. 바로 출금(공과금 등)은 지금대로 선택. */
  if (creates === 'invoice' && !b.vendor_id) return fail('거래처를 골라주세요', 'vendor_id')
  const payTerm = PAY_TERMS.includes(b.pay_term) ? b.pay_term : (creates === 'txn' ? 'immediate' : 'net30')
  const payDay = PAY_TERMS_WITH_DAY.includes(payTerm) ? Math.min(31, Math.max(1, parseInt(b.pay_day, 10) || 1)) : 0
  return {
    value: {
      direction, creates, vendor_id: b.vendor_id ? String(b.vendor_id) : null,
      contract_id: b.contract_id ? String(b.contract_id) : null,
      item, category, amount, vat_mode: vatMode, period, anchor_month: anchorMonth,
      day_of_month: dayOfMonth, account_id: accountId, pay_term: payTerm, pay_day: payDay,
      active: b.active === false || b.active === 0 || b.active === '0' ? 0 : 1,
    },
  }
}

/* ── 목록 ─────────────────────────────────────────────────────────── */

const TEMPLATE_SELECT = `
  SELECT t.*, v.name AS vendor_name, a.name AS account_name,
         c.name AS contract_name, c.status AS c_status,
         c.start_date AS c_start, c.end_date AS c_end
    FROM repeat_templates t
    LEFT JOIN vendors v   ON v.id = t.vendor_id
    LEFT JOIN accounts a  ON a.id = t.account_id
    LEFT JOIN contracts c ON c.id = t.contract_id`

/* 지금 만들 수 없는 줄의 이유 — 비어 있으면 만들 수 있다.
 * 등록 폼(normalizeTemplate)이 막는 것들인데, **폼을 안 거치고 생긴 줄**이 있다:
 *   · 옛 정기 규칙에서 옮겨 온 줄(db.js 이관)
 *   · 매입 계약이 만든 출금 반복거래(syncContractTemplates — 계약은 비목을 모른다)
 * 그대로 두면 체크해서 만들 때 가서야 막히고, 만들기는 전부 아니면 전무라 같이 고른 줄까지 죽는다.
 * 목록에서 미리 말하고 고르지 못하게 한다. */
function needsFix(t) {
  if (t.direction === 'out' && !t.category) return '비목을 골라주세요'
  if (t.creates === 'txn' && !t.account_id) return '출금 계좌를 골라주세요'
  /* 등록 폼을 안 거치고 들어온 줄이 있다 — 계약 연동(syncContractTemplates)과 옛 정기 규칙 이관.
     거래처가 없으면 거래처 없는 청구서가 매달 서고, findLookalikes 가 빠져나가 중복 방지도 꺼진다. */
  if (t.creates === 'invoice' && !t.vendor_id) return '거래처를 골라주세요'
  return null
}

/* 켜져 있는데 계약 때문에 달별 목록에 안 뜨는 이유 — 전체 목록이 말해 줘야 "왜 이번 달에 없지"가 안 된다 */
function contractHiddenReason(t, today) {
  if (!t.contract_id || !t.active) return null
  if (!t.c_status) return '연결된 계약이 없어요'
  if (t.c_status !== '진행중') return `계약이 ${t.c_status} 상태라 달별 목록에 안 떠요`
  const end = String(t.c_end || '').slice(0, 10)
  if (end && end < today) return '계약 기간이 끝나 달별 목록에 안 떠요'
  return null
}

/** 반복거래 전체(꺼진 것 포함) */
async function listTemplates(db, today) {
  const [rows] = await db.execute(`${TEMPLATE_SELECT} ORDER BY t.direction, t.day_of_month, v.name, t.item`)
  return rows.map(r => ({
    ...r, amount: Number(r.amount), ...amountsOf(r.vat_mode, r.amount),
    hidden_reason: contractHiddenReason(r, today), needs_fix: needsFix(r),
  }))
}

/** 여러 반복거래가 그 달에 만든 것 — Map(template_id → {type,id,no,date,amount}) */
async function madeInMonth(db, ids, ym) {
  const out = new Map()
  if (!ids.length) return out
  const { from, to } = monthRange(ym)
  const ph = ids.map(() => '?').join(',')
  const [invs] = await db.execute(
    `SELECT id, invoice_no, template_id, LEFT(issued_at, 10) AS d, total_amount, status FROM invoices
      WHERE template_id IN (${ph}) AND LEFT(issued_at, 10) BETWEEN ? AND ? ORDER BY issued_at`,
    [...ids, from, to])
  for (const i of invs) {
    if (!out.has(i.template_id)) {
      out.set(i.template_id, { type: 'invoice', id: i.id, no: i.invoice_no, date: i.d, amount: Number(i.total_amount), status: i.status })
    }
  }
  const [txns] = await db.execute(
    `SELECT id, template_id, LEFT(date, 10) AS d, amount FROM transactions
      WHERE template_id IN (${ph}) AND LEFT(date, 10) BETWEEN ? AND ? ORDER BY date`,
    [...ids, from, to])
  for (const t of txns) {
    if (!out.has(t.template_id)) out.set(t.template_id, { type: 'txn', id: t.id, no: null, date: t.d, amount: Number(t.amount) })
  }
  return out
}

/**
 * 그 달의 반복거래 — 켜져 있고, 그 달에 돌고, (계약이면) 계약이 살아 있는 것.
 * 각 줄에 이미 만들었는지(made)를 붙인다.
 */
async function monthItems(db, ym, { direction = null } = {}) {
  if (!YM_RE.test(String(ym))) throw httpError(400, '달을 YYYY-MM 으로 보내주세요')
  const [rows] = await db.execute(`${TEMPLATE_SELECT} WHERE t.active = 1`)
  const due = rows.filter(t => (!direction || t.direction === direction) && occursInMonth(t, ym)
    && contractAllows(t, ym, dateInMonth(t, ym)))
  const made = await madeInMonth(db, due.map(t => t.id), ym)
  return due
    .map(t => ({
      ...t, amount: Number(t.amount), ...amountsOf(t.vat_mode, t.amount),
      date: dateInMonth(t, ym), item_text: itemText(t, ym), made: made.get(t.id) || null,
      needs_fix: needsFix(t),
    }))
    /* 화면이 보여주는 날짜로 줄을 세운다 — 만든 줄은 **실제로 만든 날짜**를 보여주므로(화면 Repeat.jsx),
       틀의 예정일로만 정렬하면 25일에 만든 10일짜리가 10일 자리에 앉아 표가 날짜순으로 안 읽힌다.
       일자 0(만들 때 고름)은 예정일이 없으니 맨 뒤. */
    .sort((a, b) => String(a.made?.date || a.date || '9999').localeCompare(String(b.made?.date || b.date || '9999'))
      || String(a.vendor_name || '').localeCompare(String(b.vendor_name || '')))
}

/* ── 이미 들어온 돈 ───────────────────────────────────────────────── */

/**
 * 만들기 전에 **이미 장부에 있는 같은 돈**을 찾는다 — 통장·홈택스로 먼저 들어온 것.
 * 있으면 새로 만들지 않고 그것에 template_id 만 붙이는 게 기본이다(같은 돈이 두 줄 서는 걸 막는다).
 * 반복거래에서 온 적 없는 것(template_id 없음)만 본다.
 */
async function findLookalikes(db, t, date, total, ym) {
  if (t.creates === 'txn') {
    /* ⚠ **taken(이미 청구서에 물린 거래)도 후보로 싣는다.** open 만 보던 때는, 세금계산서를 받아
       지급처리까지 끝낸 달에 이 반복거래를 만들면 경고 한 줄 없이 같은 돈이 두 줄 섰다
       (통장 한 줄 = 장부 두 줄, 운영 fowin 2026-09-09 과 같은 모양). 붙이면 그 달은 '만듦'이 되고
       장부는 한 줄로 남는다 — 어디에 물린 건지는 note 로 보여준다. */
    const { open, taken } = await lookalikeSettleTxns(db, {
      kind: 'expense', vendorId: t.vendor_id, accountId: t.account_id, amount: total, date })
    const cand = [...open, ...taken]
    if (!cand.length) return []
    const ph = cand.map(() => '?').join(',')
    // 날짜 창이 달을 넘을 수 있다 — 다른 달 거래는 붙여도 이 달 '만듦'이 안 되므로 후보에서 뺀다
    const { from, to } = monthRange(ym)
    const [free] = await db.execute(
      `SELECT id FROM transactions WHERE id IN (${ph}) AND template_id IS NULL AND date BETWEEN ? AND ?`,
      [...cand.map(o => o.id), from, to])
    const ok = new Set(free.map(f => f.id))
    return cand.filter(o => ok.has(o.id))
      .map(o => ({ type: 'txn', id: o.id, date: String(o.date).slice(0, 10), amount: Number(o.amount),
        label: o.memo || o.vendor_name || '', note: o.other_no ? `${o.other_no} 정산분` : '' }))
  }
  if (!t.vendor_id) return []
  const { from, to } = monthRange(ym)
  // 같은 이름 거래처가 여러 벌이어도 같은 곳으로 본다(lib/settleTxn.js 와 같은 판정)
  const [rows] = await db.execute(
    `SELECT i.id, i.invoice_no, LEFT(i.issued_at, 10) AS d, i.total_amount FROM invoices i
      WHERE i.kind = ? AND i.template_id IS NULL AND i.total_amount = ?
        AND LEFT(i.issued_at, 10) BETWEEN ? AND ?
        AND i.vendor_id IN (SELECT v2.id FROM vendors v1 JOIN vendors v2 ON TRIM(v2.name) = TRIM(v1.name) WHERE v1.id = ?)
      ORDER BY i.issued_at LIMIT 3`,
    [t.direction === 'in' ? 'issued' : 'received', total, from, to, t.vendor_id])
  return rows.map(r => ({ type: 'invoice', id: r.id, no: r.invoice_no, date: r.d, amount: Number(r.total_amount) }))
}

/** 만들기 확인 서랍이 쓰는 줄 — 기본 날짜·금액과 이미 들어온 돈 후보 */
async function previewItems(db, ym, ids) {
  const items = await monthItems(db, ym)
  const want = new Set((ids || []).map(String))
  const out = []
  for (const it of items) {
    if (!want.has(it.id) || it.made) continue
    const lookalikes = it.date ? await findLookalikes(db, it, it.date, it.total, ym) : []
    out.push({ ...it, lookalikes })
  }
  return out
}

/* ── 만들기 ───────────────────────────────────────────────────────── */

/**
 * 한 줄 만들기. conn 은 트랜잭션 커넥션.
 * @param row { template_id, date, amount, account_id?, link?: {type,id}, force_new? }
 * @returns { type, id, no?, linked }
 */
async function createOne(conn, ym, row, today) {
  /* 반복거래 행만 잠근다 — 같은 반복거래를 두 요청이 동시에 만들면 둘 다 '안 만듦'을 읽고 두 벌이 선다.
     조회(JOIN)에 FOR UPDATE 를 걸면 거래처·계약 행까지 잠겨 무관한 저장이 기다린다 */
  const [[lock]] = await conn.execute('SELECT id FROM repeat_templates WHERE id = ? FOR UPDATE', [String(row.template_id || '')])
  if (!lock) throw httpError(404, '반복거래를 찾을 수 없어요')
  const [[t]] = await conn.execute(`${TEMPLATE_SELECT} WHERE t.id = ?`, [lock.id])
  const name = `${t.vendor_name ? `${t.vendor_name} · ` : ''}${itemText(t, ym)}`
  const date = String(row.date || '')
  if (!DATE_RE.test(date)) throw httpError(400, `${name} — 날짜를 골라주세요`)
  /* 날짜는 그 달 안에서만 — '그 달 만듦'을 날짜의 달로 판정하므로, 다른 달로 옮기면
     이 달은 계속 '안 만듦'으로 남고 옮긴 달은 두 번 만들 수 있게 된다 */
  if (date.slice(0, 7) !== ym) throw httpError(400, `${name} — 날짜는 ${ym} 안에서 골라주세요`)
  if (!t.active) throw httpError(409, `${name} — 꺼진 반복거래예요`)
  if (!occursInMonth(t, ym) || !contractAllows(t, ym, date)) {
    throw httpError(409, `${name} — ${ym} 에는 만들 수 없어요(주기 또는 계약 기간 밖)`)
  }
  // 같은 달에 이미 있으면 막는다 — 두 번 누름·두 탭. 잠금은 위 FOR UPDATE 가 템플릿 단위로 건다
  const made = (await madeInMonth(conn, [t.id], ym)).get(t.id)
  if (made) throw httpError(409, `${name} — 이미 ${made.no || made.date} 로 만들었어요`)
  // 청구서면 문서 잠금(월 마감만), 거래면 돈 잠금(월 마감 + 장부 시작일) — lib/closing.js
  { const ce = await (t.creates === 'invoice' ? closedDocError : closedPeriodError)(conn, date); if (ce) throw httpError(409, `${name} — ${ce}`) }
  /* 옛 정기 규칙에서 옮겨 온 줄은 등록 폼(normalizeTemplate)을 안 거쳤다 — 출금인데 비목이 없을 수 있다.
     비목 없이 만들면 전표의 비용 줄이 비어 일계표 차·대변이 안 맞는다. 무엇을 고쳐야 하는지 말해준다. */
  if (t.direction === 'out' && !t.category) {
    throw httpError(400, `${name} — 비목이 비어 있어요. 반복거래를 열어 비목을 골라주세요`)
  }
  if (t.creates === 'invoice' && !t.vendor_id) {
    throw httpError(400, `${name} — 거래처가 비어 있어요. 반복거래를 열어 거래처를 골라주세요`)
  }

  const amount = row.amount != null && row.amount !== '' ? row.amount : t.amount
  const a = amountsOf(t.vat_mode, amount)
  { const ae = amountError(a.total); if (ae) throw httpError(400, `${name} — ${ae}`) }

  /* 이미 들어온 돈에 붙이기 */
  if (row.link && row.link.id) {
    /* 붙일 건도 **그 달** 것이어야 한다 — '그 달 만듦'은 붙인 건의 날짜로 판정하므로, 다른 달 건에
       붙이면 이 달은 계속 '안 만듦'으로 남아 또 붙이거나 또 만들 수 있다 */
    const { from, to } = monthRange(ym)
    /* 붙일 건은 **서버가 스스로 고른 후보 안에** 있어야 한다. 화면이 보낸 id 를 그대로 믿으면
       엉뚱한 청구서·거래에 template_id 가 찍혀, 그 달이 '만듦'으로 막히고 정작 이 반복거래의
       돈은 영영 안 만들어진다 — 화면에는 아무 표시도 안 남는다. */
    const allowed = await findLookalikes(conn, t, date, a.total, ym)
    if (!allowed.some(o => o.type === row.link.type && String(o.id) === String(row.link.id))) {
      throw httpError(409, `${name} — 붙이려던 건이 이 반복거래와 맞지 않아요. 다시 열어 확인해주세요`)
    }
    if (row.link.type === 'invoice') {
      const [r] = await conn.execute(
        `UPDATE invoices SET template_id = ?
          WHERE id = ? AND template_id IS NULL AND kind = ? AND LEFT(issued_at, 10) BETWEEN ? AND ?`,
        [t.id, row.link.id, t.direction === 'in' ? 'issued' : 'received', from, to])
      if (!r.affectedRows) throw httpError(409, `${name} — 붙이려던 청구서를 쓸 수 없어요. 다시 열어 확인해주세요`)
    } else {
      const [r] = await conn.execute(
        `UPDATE transactions SET template_id = ?
          WHERE id = ? AND template_id IS NULL AND kind = 'expense' AND date BETWEEN ? AND ?`,
        [t.id, row.link.id, from, to])
      if (!r.affectedRows) throw httpError(409, `${name} — 붙이려던 거래를 쓸 수 없어요. 다시 열어 확인해주세요`)
    }
    return { template_id: t.id, type: row.link.type, id: row.link.id, linked: true }
  }
  /* 새로 만들기 전에 한 번 더 — 확인 서랍을 연 뒤 통장에서 같은 돈이 들어왔을 수 있다.
     사람이 보고 '새로 만들기'를 고른 경우(force_new)만 넘어간다 */
  if (!row.force_new) {
    const found = await findLookalikes(conn, t, date, a.total, ym)
    if (found.length) {
      throw httpError(409, `${name} — 같은 금액이 이미 장부에 있어요. 연결할지 새로 만들지 골라주세요`,
        { code: 'lookalike', template_id: t.id, lookalikes: found })
    }
  }

  const memo = itemText(t, ym)
  if (t.creates === 'txn') {
    if (date > today) throw httpError(400, `${name} — 바로 출금은 오늘까지 날짜만 만들 수 있어요`)
    const id = await insertExpenseTxn(conn, {
      vendorId: t.vendor_id, contractId: t.contract_id, accountId: row.account_id || t.account_id,
      category: t.category, amount: a.total, supply: a.supply, vat: a.vat, taxType: a.taxType,
      date, method: '계좌이체', memo, templateId: t.id,
    })
    return { template_id: t.id, type: 'txn', id, linked: false }
  }
  const kind = t.direction === 'in' ? 'issued' : 'received'
  const accountCode = kind === 'received' ? await acctCodeByCategoryName(conn, t.category, 'received') : null
  const { id, invoiceNo } = await createInvoice(conn, {
    kind, vendorId: t.vendor_id, contractId: t.contract_id,
    supply: a.supply, vat: a.vat, total: a.total,
    issuedAt: date, dueAt: cashDateOf(date, t.pay_term, t.pay_day),
    accountId: t.account_id, memo, taxType: a.taxType,
    category: kind === 'received' ? t.category : null, accountCode,
    origin: { type: 'repeat', templateId: t.id },
  })
  return { template_id: t.id, type: 'invoice', id, no: invoiceNo, linked: false }
}

/* ── 앞으로의 돈(자금 예측) · 계약 도래액 ───────────────────────────── */

/**
 * from~to 사이에 **아직 안 만든** 반복거래 날짜들. 자금 예측이 쓴다.
 * 일자 0(만들 때 고름)은 그 달 말일로 본다 — 모르는 날짜를 앞당겨 잡는 것보다 늦게 잡는 편이 안전하다.
 * @returns [{ template, date, cashDate, direction, total }]
 */
async function upcomingOccurrences(db, from, to) {
  const [rows] = await db.execute(`${TEMPLATE_SELECT} WHERE t.active = 1`)
  const out = []
  let ym = from.slice(0, 7)
  const endYm = to.slice(0, 7)
  for (let guard = 0; ym <= endYm && guard < 36; guard++, ym = nextYm(ym)) {
    const due = rows.filter(t => occursInMonth(t, ym))
    const made = await madeInMonth(db, due.map(t => t.id), ym)
    for (const t of due) {
      if (made.has(t.id)) continue
      const date = dateInMonth(t, ym) || monthRange(ym).to
      if (!contractAllows(t, ym, date)) continue
      const cashDate = t.creates === 'txn' ? date : cashDateOf(date, t.pay_term, t.pay_day)
      if (cashDate < from || cashDate > to) continue
      out.push({ template: t, date, cashDate, direction: t.direction, total: amountsOf(t.vat_mode, t.amount).total })
    }
  }
  return out
}

/**
 * 계약에 붙은 반복거래가 from~to 사이에 **나왔어야 할 돈**(합계). 계약 상세의 이행률 분모.
 * 청구를 안 한 달도 분모에 들어가야 빠진 달이 드러난다.
 */
function dueTotalBetween(t, from, to) {
  let sum = 0
  let ym = from.slice(0, 7)
  const endYm = to.slice(0, 7)
  for (let guard = 0; ym <= endYm && guard < 600; guard++, ym = nextYm(ym)) {
    if (!occursInMonth(t, ym)) continue
    const date = dateInMonth(t, ym) || monthRange(ym).to
    if (date < from || date > to) continue
    sum += amountsOf(t.vat_mode, t.amount).total
  }
  return sum
}

/** 켜진 반복거래의 **월 환산** 합계(공급가 기준 아님, 합계) — 경영 대시보드 */
function monthlyEquivalent(t) {
  return Math.round(amountsOf(t.vat_mode, t.amount).total / periodMonths(t.period))
}

/* ── 계약 연동 — 등록·금액만(사용자 확정 2026-09-15) ───────────────────
 * 계약이 원본, 반복거래는 복사틀이다. 갱신·완료 때 반복거래를 고치지 않는다 —
 * 그 달 목록에 뜰지는 contractAllows 가 계약을 보고 계산한다.
 *
 * ⚠ 연동 대상은 **계약 방향과 같은 반복거래 하나**뿐이다(매출 계약 → 입금, 매입 계약 → 출금).
 *   계약에는 다른 반복거래도 붙을 수 있다 — 매출 계약에 원가로 붙인 외주비 출금, 한 계약을 품목별로
 *   나눈 두 줄. 계약을 저장할 때마다 그것들까지 계약 금액으로 덮으면 조용히 금액이 바뀐다. */

/** 계약 과세유형 → 반복거래 vat_mode. 계약 금액(주기당)은 공급가다 */
const vatModeOfContract = (v) => (v === 'exempt' ? 'none' : v === 'zero' ? 'zero' : 'exclusive')
const anchorOf = (startDate) => Math.min(12, Math.max(1, Number(String(startDate || '').slice(5, 7)) || 1))
const dirOfContract = (isPurchase) => (isPurchase ? 'out' : 'in')

/**
 * 정기형 계약에 같은 방향 반복거래가 **없으면** 만든다(꺼 둔 것도 '있는' 것으로 친다 —
 * 일부러 꺼 둔 반복거래를 계약을 저장했다는 이유로 되살리지 않는다).
 * **하나면** 거래처·금액·과세·주기·청구일을 계약 값으로 맞춘다. 둘 이상이면 어느 것이 계약분인지
 * 모르므로 건드리지 않는다(skipped 로 알린다).
 * @param c { id, name, vendor_id, unit_amount, vat_mode, billing_period, billing_day, start_date }
 */
async function syncContractTemplates(conn, c, isPurchase, { reactivate = false } = {}) {
  if (!(Number(c.unit_amount) > 0)) return { created: 0, updated: 0, skipped: 0 }
  const direction = dirOfContract(isPurchase)
  const period = PERIODS.includes(c.billing_period) ? c.billing_period : 'monthly'
  const day = Math.min(31, Math.max(1, Number(c.billing_day) || 1))
  const vm = vatModeOfContract(c.vat_mode)
  const [same] = await conn.execute(
    'SELECT id FROM repeat_templates WHERE contract_id = ? AND direction = ? FOR UPDATE', [c.id, direction])
  if (same.length > 1) return { created: 0, updated: 0, skipped: same.length }
  if (same.length === 1) {
    /* ⚠ 켜는 것은 **방식이 정기형으로 돌아온 그 저장에서만**(reactivate). 늘 active=1 로 쓰면,
       이번 분기는 직접 청구하려고 일부러 꺼 둔 반복거래가 계약을 아무거나 고쳐 저장할 때마다
       되살아나 다음 달 목록에 뜬다. 반대로 되돌릴 때 안 켜면 계약은 정기형인데 목록에 영영
       안 뜬다(둘 다 실측). 그래서 '껐다'와 '방식이 돌아왔다'를 가른다. */
    const [r] = await conn.execute(
      `UPDATE repeat_templates SET vendor_id = ?, amount = ?, vat_mode = ?, period = ?, anchor_month = ?, day_of_month = ?
         ${reactivate ? ', active = 1' : ''}
        WHERE id = ?`,
      [c.vendor_id || null, Number(c.unit_amount), vm, period, anchorOf(c.start_date), day, same[0].id])
    // 값이 그대로면 affectedRows 가 0이다 — 연동은 '있다'가 답이라 1로 센다(화면이 '연동 없음'이라 말하던 것)
    return { created: 0, updated: r.affectedRows || 1, skipped: 0 }
  }
  await conn.execute(
    `INSERT INTO repeat_templates (id, direction, creates, vendor_id, contract_id, item, amount, vat_mode,
       period, anchor_month, day_of_month, pay_term)
     VALUES (?,?,'invoice',?,?,?,?,?,?,?,?,'net30')`,
    [randomUUID(), direction, c.vendor_id || null, c.id, String(c.name || '').slice(0, 255),
     Number(c.unit_amount), vm, period, anchorOf(c.start_date), day])
  return { created: 1, updated: 0, skipped: 0 }
}

/**
 * 정기형을 다른 청구 방식으로 바꿀 때 — 같은 방향 반복거래를 **끈다**(지우지 않는다).
 * 계산으로 숨기지 않고 끄는 이유: 전체 목록에서 '꺼짐'으로 보여야 왜 안 뜨는지 알 수 있고,
 * 방식을 바꾼 뒤에도 달마다 뜨면 청구 일정과 반복거래로 같은 돈을 두 번 청구하게 된다.
 */
async function stopContractTemplates(conn, contractId, isPurchase, { onlyIfSingle = false } = {}) {
  const direction = dirOfContract(isPurchase)
  /* onlyIfSingle — 그 방향에 여러 벌이면 손대지 않는다. 어느 것이 계약 청구용이고 어느 것이
     사람이 따로 붙인 것인지 가릴 수 없다(syncContractTemplates 도 같은 자리에서 물러선다). */
  if (onlyIfSingle) {
    const [rows] = await conn.execute(
      'SELECT id FROM repeat_templates WHERE contract_id = ? AND direction = ? AND active = 1', [contractId, direction])
    if (rows.length !== 1) return 0
  }
  const [r] = await conn.execute(
    'UPDATE repeat_templates SET active = 0 WHERE contract_id = ? AND direction = ? AND active = 1',
    [contractId, direction])
  return r.affectedRows
}

/**
 * 계약 상세의 이행률 — 이번 계약기간 시작부터 오늘까지 **나왔어야 할 돈**(도래) vs 청구·수금.
 * 청구를 안 한 달도 분모에 들어가야 빠진 달이 보인다. 반복거래가 없으면 null(화면이 막대를 안 그린다).
 * 계약 방향과 같은 **켜진** 반복거래만 센다 — 원가로 붙인 출금이 매출 이행률에 섞이면 안 된다.
 * 바로 출금(txn)으로 만든 것은 만들 때 이미 지급된 돈이라 청구·수금 양쪽에 같이 넣는다.
 */
async function contractRepeatProgress(db, contractId, isPurchase, termStart, today) {
  const [rows] = await db.execute(
    `${TEMPLATE_SELECT} WHERE t.contract_id = ? AND t.direction = ? AND t.active = 1`,
    [contractId, dirOfContract(isPurchase)])
  if (!rows.length) return null
  const from = String(termStart || '').slice(0, 10) || today
  const out = { due: 0, billed: 0, paid: 0, missing: 0 }
  const ids = rows.map(t => t.id)
  const ph = ids.map(() => '?').join(',')
  /* 만든 달을 **한 번에** 읽는다(template|YYYY-MM). 달마다 madeInMonth 를 부르면
     2020년부터 도는 계약 하나에 왕복이 백 번을 넘는다 — 계약 상세를 열 때마다. */
  const madeMonths = new Set()
  const rangeFrom = `${from.slice(0, 7)}-01`
  for (const sql of [
    `SELECT template_id, LEFT(issued_at, 7) AS ym FROM invoices
      WHERE template_id IN (${ph}) AND LEFT(issued_at, 10) BETWEEN ? AND ?`,
    `SELECT template_id, LEFT(date, 7) AS ym FROM transactions
      WHERE template_id IN (${ph}) AND date BETWEEN ? AND ?`,
  ]) {
    const [found] = await db.execute(sql, [...ids, rangeFrom, today])
    for (const f of found) madeMonths.add(`${f.template_id}|${f.ym}`)
  }
  for (const t of rows) {
    let ym = from.slice(0, 7)
    for (let guard = 0; ym <= today.slice(0, 7) && guard < 600; guard++, ym = nextYm(ym)) {
      if (!occursInMonth(t, ym)) continue
      const date = dateInMonth(t, ym) || monthRange(ym).to
      if (date < from || date > today || !contractAllows(t, ym, date)) continue
      out.due += amountsOf(t.vat_mode, t.amount).total
      if (!madeMonths.has(`${t.id}|${ym}`)) out.missing += 1
    }
  }
  const [[s]] = await db.execute(
    `SELECT COALESCE(SUM(i.total_amount), 0) AS billed,
            COALESCE(SUM((SELECT COALESCE(SUM(m.amount), 0) FROM invoice_matches m WHERE m.invoice_id = i.id)), 0) AS paid
       FROM invoices i WHERE i.template_id IN (${ph}) AND LEFT(i.issued_at, 10) BETWEEN ? AND ?`,
    [...ids, from, today])
  const [[x]] = await db.execute(
    `SELECT COALESCE(SUM(amount), 0) AS n FROM transactions
      WHERE template_id IN (${ph}) AND invoice_id IS NULL AND date BETWEEN ? AND ?`,
    [...ids, from, today])
  out.billed = Number(s.billed) + Number(x.n)
  out.paid = Number(s.paid) + Number(x.n)
  return out
}

/* ── 반복 제안 ─────────────────────────────────────────────────────
 * 거래를 적은 뒤 "이거 매달 오가는 돈 아닌가요?"를 묻는다(3단계, 사용자 확정 2026-09-18).
 *
 * 판정 — **같은 거래처 · 같은 방향(· 출금이면 같은 비목)** 이 이번 달 포함 최근 3개월 중
 * 2개월 이상 있고, 그 거래처·방향의 반복거래가 아직 없을 때.
 *   · 금액은 안 본다 — 변동 공과금(전기·가스)도 반복이다.
 *   · 날짜(일)는 안 본다 — 25일·27일은 같은 반복이다.
 *   · 반복거래는 꺼진 것도 '있음'으로 친다 — 사람이 일부러 끈 것을 다시 권하면 안 된다.
 * 제안은 권유다. '안 할래요'는 화면이 브라우저에 기억한다(규칙이 아니라 취향이라서). */
async function repeatSuggestion(db, { kind, vendorId, category, today }) {
  const direction = kind === 'income' ? 'in' : kind === 'expense' ? 'out' : null
  if (!direction || !vendorId) return { suggest: false }
  const [[has]] = await db.execute(
    'SELECT COUNT(*) AS n FROM repeat_templates WHERE vendor_id = ? AND direction = ?', [vendorId, direction])
  if (Number(has.n) > 0) return { suggest: false }

  const thisYm = String(today).slice(0, 7)
  const y = Number(thisYm.slice(0, 4)), m = Number(thisYm.slice(5, 7))
  const back2 = m > 2 ? `${y}-${pad(m - 2)}` : `${y - 1}-${pad(m + 10)}`
  const catSql = direction === 'out' && category ? ' AND category = ?' : ''
  const [rows] = await db.execute(
    `SELECT id, LEFT(date, 7) AS ym, LEFT(date, 10) AS d, amount, category, account_id, memo, tax_type
       FROM transactions
      WHERE vendor_id = ? AND kind = ? AND date BETWEEN ? AND ?${catSql}
      ORDER BY date DESC`,
    [vendorId, kind, `${back2}-01`, monthRange(thisYm).to, ...(catSql ? [category] : [])])
  const months = new Set(rows.map(r => r.ym))
  if (months.size < 2) return { suggest: false }

  // 반복거래 등록 서랍을 채울 값 — 가장 최근 거래를 본뜬다
  const last = rows[0]
  const taxType = String(last.tax_type || '')
  return {
    suggest: true, months: months.size,
    prefill: {
      direction, vendor_id: vendorId,
      // 서류 없이 나간 돈을 본뜬 것이라 바로 출금으로. 입금은 늘 청구서(설계 — 미수금을 추적한다)
      creates: direction === 'out' ? 'txn' : 'invoice',
      item: last.category || last.memo || '', category: direction === 'out' ? (last.category || null) : null,
      amount: Number(last.amount) || 0,
      // 거래 금액은 합계다 — 과세면 '부가세 포함'으로 받는다
      vat_mode: taxType === '면세' ? 'none' : taxType === '영세' ? 'zero' : 'inclusive',
      period: 'monthly', day_of_month: Number(String(last.d).slice(8, 10)) || 1,
      account_id: last.account_id || null,
    },
  }
}

module.exports = {
  repeatSuggestion,
  VAT_MODES, occursInMonth, dateInMonth, contractAllows, amountsOf, itemText, normalizeTemplate,
  listTemplates, monthItems, previewItems, createOne, madeInMonth,
  upcomingOccurrences, dueTotalBetween, monthlyEquivalent, TEMPLATE_SELECT, monthRange,
  syncContractTemplates, stopContractTemplates, contractRepeatProgress,
}
