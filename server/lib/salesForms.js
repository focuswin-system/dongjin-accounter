const { monthRange } = require('./period')
const { VAT_RATE } = require('./vat')

/**
 * 고객사 양식 보고서 — 매출내역·연매출·매입내역·거래처 거래내역·매출장.
 *
 * ── 왜 따로 있나 ──
 * 이미 있는 보고서들은 "우리가 정한 모양"이다. 여기 다섯은 **고객사가 몇 년째 쓰던 종이의
 * 칸 배치를 그대로 옮긴 것**이다. 숫자는 같아도 자리가 바뀌면 못 읽는 문서라, 모양을 맞춘다
 * (자금관리표를 그렇게 만든 것과 같은 이유).
 *
 * ⚠ 세는 것은 **청구서(invoices)와 그 품목(invoice_lines)** 이다. 거래(입출금)가 아니다.
 *   매출·매입이 언제 얼마나 일어났는가는 세금계산서가 답하고, 언제 돈이 오갔는가는
 *   결제 열이 따로 답한다 — 두 축을 한 열에 섞으면 어느 쪽도 못 맞춘다.
 *
 * ⚠ 세액이 NULL 인 줄은 청구서 과세유형대로 채운다. 이 규칙은 화면(src/lib/hometax.js)·
 *   매입매출 현황과 **같아야 한다** — 다르면 같은 달인데 보고서마다 숫자가 다르다.
 */

/** 회사가 정한 마감일. 없으면 달력월. */
async function closingDayOf(db) {
  const [[cfg]] = await db.execute("SELECT closing_day FROM company_info WHERE id = 'main'")
  return cfg ? Number(cfg.closing_day) || 0 : 0
}

/** 줄의 세액 — 비어 있으면 청구서 과세유형으로 채운다(0 은 '면세라서 0'이라 그대로 둔다). */
const vatOfLine = (r) => (r.vat === null || r.vat === undefined
  ? ((r.tax_type || '과세') === '과세' ? Math.round((Number(r.amount) || 0) * VAT_RATE) : 0)
  : Number(r.vat) || 0)

/** 품목 줄을 기간으로 읽는다. 한 곳에서만 읽어야 다섯 양식의 숫자가 같다. */
async function linesOf(db, { kind, from, to, vendorId = null }) {
  const args = [kind, from, to]
  let where = 'i.kind = ? AND i.issued_at BETWEEN ? AND ?'
  if (vendorId) { where += ' AND i.vendor_id = ?'; args.push(vendorId) }
  const [rows] = await db.execute(
    `SELECT i.id AS invoice_id, i.issued_at, i.invoice_no, i.tax_type, i.memo AS invoice_memo,
            i.vendor_id, v.name AS vendor_name,
            c.name AS contract_name,
            l.name, l.spec, l.unit, l.qty, l.weight, l.price_basis,
            l.unit_price, l.amount, l.vat, l.note, l.delivery_date,
            ri.code AS item_code
       FROM invoice_lines l
       JOIN invoices i ON i.id = l.invoice_id
       LEFT JOIN vendors v ON v.id = i.vendor_id
       LEFT JOIN contracts c ON c.id = i.contract_id
       LEFT JOIN ref_items ri ON ri.id = l.item_id
      WHERE ${where}
      ORDER BY i.issued_at, i.invoice_no, l.sort_order`, args)
  return rows.map(r => ({
    invoiceId: r.invoice_id,
    date: r.issued_at,
    deliveryDate: r.delivery_date ? String(r.delivery_date).slice(0, 10) : '',
    invoiceNo: r.invoice_no || '',
    vendorId: r.vendor_id || '',
    vendor: r.vendor_name || '(거래처 없음)',
    contract: r.contract_name || '',
    name: r.name || '',
    spec: r.spec || '',
    code: r.item_code || '',
    unit: r.unit || '',
    // 중량 기준 줄은 곱해진 값이 중량이다 — 표에는 그 값을 적는다(매입·매출 현황과 같다)
    qty: r.price_basis === 'weight' ? Number(r.weight) || 0 : Number(r.qty) || 0,
    basis: r.price_basis === 'weight' ? 'weight' : 'qty',
    unitPrice: Number(r.unit_price) || 0,
    amount: Number(r.amount) || 0,
    vat: vatOfLine(r),
    note: r.note || '',
    memo: r.invoice_memo || '',
  })).map(l => ({ ...l, total: l.amount + l.vat }))
}

/** 청구서 머리(총액)만 — 품목이 없는 청구서도 세야 하는 양식에서 쓴다. */
async function headsOf(db, { kind, from, to }) {
  const [rows] = await db.execute(
    `SELECT i.id, i.issued_at, i.vendor_id, v.name AS vendor_name,
            i.supply_amount, i.vat_amount, i.total_amount, i.memo
       FROM invoices i
       LEFT JOIN vendors v ON v.id = i.vendor_id
      WHERE i.kind = ? AND i.issued_at BETWEEN ? AND ?
      ORDER BY i.issued_at`, [kind, from, to])
  return rows.map(r => ({
    id: r.id, date: r.issued_at,
    vendorId: r.vendor_id || '', vendor: r.vendor_name || '(거래처 없음)',
    supply: Number(r.supply_amount) || 0,
    vat: Number(r.vat_amount) || 0,
    total: Number(r.total_amount) || 0,
    memo: r.memo || '',
  }))
}

const sumBy = (rows, pick) => rows.reduce((s, r) => s + (Number(pick(r)) || 0), 0)

/* ── 7-1. YYYY년 N월분 매출내역 ────────────────────────────────────────────
 * 위: 그 달에 무엇을 얼마에 팔았나(일자·업체·품목·공급가액·부가세, 월계는 누계).
 * 아래: 올해 들어 업체별로 얼마나 팔았나 — 한 장으로 "이 달"과 "올해"를 같이 본다.
 * ⚠ 품목이 없는 청구서(총액만 끊은 것)는 위 표에 줄이 없다. 그래서 아래 누계는
 *   품목이 아니라 **청구서 총액**으로 센다 — 아니면 누계가 조용히 작아진다. */
async function salesMonthForm(db, month) {
  const closingDay = await closingDayOf(db)
  const { from, to } = monthRange(month, closingDay)
  const yearFrom = monthRange(`${month.slice(0, 4)}-01`, closingDay).from

  const lines = await linesOf(db, { kind: 'issued', from, to })
  let run = 0
  const rows = lines.map((l, i) => { run += l.total; return { no: i + 1, ...l, running: run } })

  /* 품목 없이 총액만 끊은 청구서 — 위 표에는 줄이 없다. 있었다는 사실과 금액을 밝힌다.
     안 밝히면 아래 연 누계(청구서 총액 기준)와 위 합계가 다른 이유를 알 길이 없다. */
  const yearHeads = await headsOf(db, { kind: 'issued', from: yearFrom, to })
  // 이 달치는 한 해치에서 걸러 쓴다 — 같은 표를 두 번 읽을 이유가 없다
  const heads = yearHeads.filter(h => h.date >= from && h.date <= to)
  const withLines = new Set(lines.map(l => l.invoiceId))
  const headless = heads.filter(h => !withLines.has(h.id))

  const byVendor = new Map()
  for (const h of yearHeads) {
    const k = h.vendorId || h.vendor
    const cur = byVendor.get(k) || { vendor: h.vendor, supply: 0, vat: 0, total: 0, count: 0 }
    cur.supply += h.supply; cur.vat += h.vat; cur.total += h.total; cur.count += 1
    byVendor.set(k, cur)
  }
  const vendors = [...byVendor.values()]
    .sort((a, b) => b.total - a.total)
    .map((v, i) => ({ no: i + 1, ...v }))

  return {
    month, from, to, yearFrom, closingDay,
    rows,
    totals: { supply: sumBy(rows, r => r.amount), vat: sumBy(rows, r => r.vat), total: sumBy(rows, r => r.total), count: rows.length },
    headless: { count: headless.length, total: sumBy(headless, h => h.total) },
    vendors,
    vendorTotals: {
      supply: sumBy(vendors, v => v.supply), vat: sumBy(vendors, v => v.vat), total: sumBy(vendors, v => v.total),
    },
  }
}

/* ── 7-2. 특정 년도 매출액 (업체 × 12개월) ─────────────────────────────────
 * 한 해를 한 장으로 본다. 달의 경계는 **회사 마감일**을 따른다 — 다른 보고서와 달라지면
 * 같은 매출이 이 표에서만 옆 달에 선다. */
async function salesYearForm(db, year, basis = 'supply') {
  const closingDay = await closingDayOf(db)
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
  const ranges = months.map(m => monthRange(m, closingDay))
  const from = ranges[0].from
  const to = ranges[11].to

  const heads = await headsOf(db, { kind: 'issued', from, to })
  const pick = (h) => (basis === 'total' ? h.total : h.supply)

  const byVendor = new Map()
  for (const h of heads) {
    const k = h.vendorId || h.vendor
    const cur = byVendor.get(k) || { vendor: h.vendor, months: Array(12).fill(0), total: 0 }
    // 어느 달인지는 **범위로** 찾는다(마감일이 있으면 날짜의 월과 회계 월이 다르다)
    const mi = ranges.findIndex(r => h.date >= r.from && h.date <= r.to)
    if (mi >= 0) cur.months[mi] += pick(h)
    cur.total += mi >= 0 ? pick(h) : 0
    byVendor.set(k, cur)
  }
  const vendors = [...byVendor.values()]
    .filter(v => v.total !== 0)
    .sort((a, b) => b.total - a.total)
    .map((v, i) => ({ no: i + 1, ...v }))

  const monthTotals = Array.from({ length: 12 }, (_, i) => sumBy(vendors, v => v.months[i]))
  return {
    year: Number(year), basis, from, to, closingDay,
    monthLabels: months.map(m => `${Number(m.slice(5, 7))}월`),
    vendors, monthTotals, total: sumBy(vendors, v => v.total),
  }
}

/* ── 7-3. YYYY년 N월분 매입내역 ────────────────────────────────────────────
 * 업체마다 한 줄: 전월이월 + 이 달 매입 − 이 달 결제 = 잔액.
 *
 * ⚠ '결제'는 청구서 정산(invoice_matches)이다. 통장에서 나간 날짜를 쓰되(거래의 date),
 *   어음으로 준 것은 거래가 없으므로 정산을 기록한 날을 쓴다 — 둘 다 '준 날'이다.
 * ⚠ 전월이월은 **그 업체의 지난 모든 청구서**에서 구한다(지난달 한 달이 아니라).
 *   한 달만 보면 두 달 전에 밀린 돈이 사라져 잔액이 맞지 않는다. */
async function purchaseMonthForm(db, month) {
  const closingDay = await closingDayOf(db)
  const { from, to } = monthRange(month, closingDay)

  const [invRows] = await db.execute(
    /* ⚠ vendors 에는 메모 칸이 없다 — 비고는 청구서 메모에서 모은다.
       (거래처에 '자동이체'를 적어 두는 칸을 새로 만들지 않았다. 없는 칸을 만들면
        아무도 안 채워 늘 빈 칸이 된다 — 이미 적고 있는 곳에서 가져온다.) */
    `SELECT i.id, i.issued_at, i.vendor_id, v.name AS vendor_name,
            i.supply_amount, i.vat_amount, i.total_amount, i.memo
       FROM invoices i
       LEFT JOIN vendors v ON v.id = i.vendor_id
      WHERE i.kind = 'received' AND i.issued_at <= ?
      ORDER BY i.issued_at`, [to])

  const ids = invRows.map(r => r.id)
  const payByInvoice = new Map()
  if (ids.length) {
    /* IN 절은 나눠 넣는다 — 청구서가 수천 건인 회사에서 한 번에 넣으면 쿼리가 길어져 터진다
       (routes/invoices.js attachMatchesBulk 과 같은 규칙). */
    const CHUNK = 500
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK)
      const [ms] = await db.execute(
        `SELECT m.invoice_id, m.amount,
                COALESCE(t.date, DATE_FORMAT(m.matched_at, '%Y-%m-%d')) AS paid_on
           FROM invoice_matches m
           LEFT JOIN transactions t ON t.id = m.txn_id
          WHERE m.invoice_id IN (${part.map(() => '?').join(',')})`, part)
      for (const m of ms) {
        const arr = payByInvoice.get(m.invoice_id) || []
        arr.push({ amount: Number(m.amount) || 0, on: String(m.paid_on || '').slice(0, 10) })
        payByInvoice.set(m.invoice_id, arr)
      }
    }
  }

  const byVendor = new Map()
  for (const r of invRows) {
    const k = r.vendor_id || r.vendor_name || '(거래처 없음)'
    const cur = byVendor.get(k) || {
      vendor: r.vendor_name || '(거래처 없음)',
      carryOver: 0, supply: 0, vat: 0, total: 0, paid: 0, payDates: [], memos: [],
    }
    const inMonth = r.issued_at >= from && r.issued_at <= to
    const total = Number(r.total_amount) || 0
    if (inMonth) {
      cur.supply += Number(r.supply_amount) || 0
      cur.vat += Number(r.vat_amount) || 0
      cur.total += total
      if (r.memo) cur.memos.push(r.memo)
    } else {
      cur.carryOver += total          // 지난 청구는 통째로 이월 쪽에
    }
    for (const p of payByInvoice.get(r.id) || []) {
      if (p.on && p.on >= from && p.on <= to) { cur.paid += p.amount; cur.payDates.push(p.on) }
      else if (!p.on || p.on < from) cur.carryOver -= p.amount   // 이 달 전에 낸 것은 이월에서 뺀다
      // 이 달 뒤에 낸 것은 아직 일어나지 않은 일이다 — 이 장에는 넣지 않는다
    }
    byVendor.set(k, cur)
  }

  const rows = [...byVendor.values()]
    .map(v => ({
      ...v,
      payDate: v.payDates.sort().slice(-1)[0] || '',
      payCount: v.payDates.length,
      balance: v.carryOver + v.total - v.paid,
      // 비고 — 이 달 청구서에 적은 메모를 모은다(자동이체·리스 같은 말이 거기 적힌다).
      //   같은 말이 여러 건에 반복되므로 중복은 지우고 두 개까지만 낸다.
      note: [...new Set(v.memos.filter(Boolean))].slice(0, 2).join(' · '),
    }))
    // 이 달에 아무 일도 없고 잔액도 0인 업체는 뺀다 — 종이 한 장이 업체 목록이 되면 못 읽는다
    .filter(v => v.total !== 0 || v.paid !== 0 || v.balance !== 0)
    .sort((a, b) => b.total - a.total || b.balance - a.balance)
    .map((v, i) => ({ no: i + 1, ...v }))

  return {
    month, from, to, closingDay, rows,
    totals: {
      carryOver: sumBy(rows, r => r.carryOver), supply: sumBy(rows, r => r.supply),
      vat: sumBy(rows, r => r.vat), total: sumBy(rows, r => r.total),
      paid: sumBy(rows, r => r.paid), balance: sumBy(rows, r => r.balance),
    },
  }
}

/* ── 7-4 · 7-5. 한 거래처의 한 달 ──────────────────────────────────────────
 * 같은 줄을 두 양식이 다르게 그린다(거래내역 / 매출장). 그래서 집계는 하나다.
 *   7-4 납품일자·결재No·공사번호·품번·수량·단가·합계
 *   7-5 일자·품명·품번·수량(단위)·단가·공급가·중간계·VAT 포함
 * ⚠ '공사번호'는 **주문(contract)** 이름이고 '품번'은 품목 기준정보의 코드다.
 *   그 칸을 따로 두지 않았다 — 없는 칸을 새로 만들면 어디서도 안 채워져 늘 빈 칸이 된다.
 */
async function vendorLinesForm(db, { month, vendorId, kind = 'issued' }) {
  const closingDay = await closingDayOf(db)
  const { from, to } = monthRange(month, closingDay)
  const lines = await linesOf(db, { kind, from, to, vendorId })

  let run = 0
  const rows = lines.map((l, i) => { run += l.amount; return { no: i + 1, ...l, running: run } })

  // 고를 수 있는 거래처 — 그 달에 거래가 있는 곳만 준다(전체 거래처를 주면 빈 표만 고르게 된다).
  // 아직 안 골랐으면 위에서 읽은 것이 곧 전체다 — 같은 조회를 두 번 하지 않는다.
  const all = vendorId ? await linesOf(db, { kind, from, to }) : lines
  const seen = new Map()
  for (const l of all) if (!seen.has(l.vendorId)) seen.set(l.vendorId, l.vendor)
  const choices = [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ko'))

  const [[cfg]] = await db.execute(
    "SELECT name, closing_day FROM company_info WHERE id = 'main'").catch(() => [[null]])

  return {
    month, from, to, closingDay, kind,
    vendor: rows[0]?.vendor || choices.find(c => c.id === vendorId)?.name || '',
    companyName: cfg?.name || '',
    choices, rows,
    totals: { supply: sumBy(rows, r => r.amount), vat: sumBy(rows, r => r.vat), total: sumBy(rows, r => r.total), qty: sumBy(rows, r => r.qty), count: rows.length },
  }
}

module.exports = { salesMonthForm, salesYearForm, purchaseMonthForm, vendorLinesForm, linesOf, headsOf }
