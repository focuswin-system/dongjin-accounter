const { Router } = require('express')
const { randomUUID } = require('crypto')
const multer = require('multer')
const xlsx = require('xlsx')
const { futureDateError, kstToday, kstDate } = require('../db')
const { rollbackQuietly } = require('../lib/tx')
const { dateOrNull } = require('../lib/period')
const { normalizeStatus, ledgerError, defaultSettledStatus, amountError } = require('../lib/ledger')
const { restoreLastGenerated, dueDatesToGenerate, LOOKAHEAD_DAYS } = require('../lib/recurrence')
const { removeUploadedFile } = require('../lib/uploads')
const { vatFields, recurFromSupply } = require('../lib/vat')
const { closedPeriodError } = require('../lib/closing')
const { recalcInvoiceStatus } = require('../lib/invoiceStatus')
const { isFundAccount } = require('../lib/categoryAccount')
const { transactionVoucher, withNames } = require('../lib/voucher')
const { listVouchers, toRows, COLUMNS: VOUCHER_COLUMNS, GUIDE: VOUCHER_GUIDE } = require('../lib/voucherBook')
const { newBook, sheet, templateSheet, guideSheet, sendBook } = require('../lib/xlsxBook')

const router = Router()

/* 상대 계정과목에 자금 계정(현금·당좌·보통예금)이 오면 분개가 성립하지 않는다.
 *
 * 거래는 이미 `account_id`(계좌)로 한쪽 다리를 갖는다. 상대 계정까지 예금·현금이면
 * `보통예금 / 보통예금` 이 되어 **매출도 비용도 장부에 잡히지 않는다.** 일계표 합계는
 * 맞아 보이므로 더 위험하다 — 틀린 장부가 맞는 것처럼 보인다.
 *
 * 2026-08-20 fowin 전수 조사에서 이 유형 결함이 15건 나왔다. 사용자가 '현금 = 돈'으로
 * 이해해 계정과목에서 1101 현금을 고른 것이다. 자금 계정끼리의 이동은 '계좌 간 이체'인데
 * 이 앱에는 그 기능이 없으므로, 지금 이 조합은 항상 입력 실수다.
 * (계좌 이체를 도입하면 전용 경로에서 처리하고 이 가드를 그 경로만 우회시켜야 한다) */
const fundAccountError = (code) =>
  isFundAccount(code)
    ? '계정과목에 현금·예금은 고를 수 없어요. 그 자리는 이미 계좌가 차지하고 있어, 그대로 두면 매출·비용이 장부에 잡히지 않습니다.'
    : null

/* 비목이 정해 둔 계정과목을 기본값으로 쓴다.
 * 사용자가 고른 값이 있으면 그것이 이긴다 — 같은 비목이라도 건별로 달라질 수 있다. */
const resolveAcctCode = async (db, accountCode, categoryName, kind) => {
  if (accountCode) return accountCode
  if (!categoryName) return null
  const [[row]] = await db.execute(
    'SELECT account_code FROM categories WHERE name = ? AND id LIKE ? LIMIT 1',
    [categoryName, kind === 'income' ? 'INC-%' : 'EXP-%']
  )
  return row?.account_code || null
}
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

// 청구서 상태 재계산은 lib/invoiceStatus.js 공용
// (거래 수정·삭제, 정산 추가·취소, 청구서 금액 수정이 모두 같은 규칙을 써야 한다)

/* 상대 계좌 스냅샷 — 어느 계좌로 오갔는지를 거래에 **베껴** 둔다.
 *
 * 화면이 보낸 은행·계좌번호 문자열을 그대로 믿지 않고, 고른 줄(vendor_accounts.id)을
 * 서버가 다시 읽어 베낀다. 그래야 (1) 그 시점에 실제로 있던 계좌임이 보장되고
 * (2) 나중에 거래처가 계좌를 고쳐도 과거 거래의 계좌는 안 바뀐다.
 *
 * 고른 줄이 그 거래처의 것이 아니면 무시한다 — 남의 거래처 계좌가 붙는 걸 막는다.
 * accountId 가 비면 스냅샷 네 칸을 모두 지운다(연결 해제).
 */
async function counterpartySnapshot(db, vendorId, accountId) {
  const empty = { id: null, bank: null, account: null, holder: null }
  if (!accountId || !vendorId) return empty
  const [[row]] = await db.execute(
    'SELECT id, bank_name, account_no, holder FROM vendor_accounts WHERE id = ? AND vendor_id = ?',
    [accountId, vendorId])
  if (!row) return empty
  return { id: row.id, bank: row.bank_name || null, account: row.account_no || null, holder: row.holder || null }
}

// 거래 목록/상세에 첨부 서류(다중) 붙이기
async function attachDocs(db, rows) {
  if (!rows.length) return
  const ids = rows.map(r => r.id)
  const ph = ids.map(() => '?').join(',')
  const [docs] = await db.execute(
    `SELECT id, txn_id, url, name, doc_type, size, created_at FROM transaction_docs WHERE txn_id IN (${ph}) ORDER BY created_at`, ids)
  const byTxn = {}
  for (const d of docs) { if (!byTxn[d.txn_id]) byTxn[d.txn_id] = []; byTxn[d.txn_id].push(d) }
  for (const r of rows) r.docs = byTxn[r.id] || []
}

router.get('/', async (req, res, next) => {
  try {
    const { kind, contractId, projectNo, category, from, to, accountId } = req.query
    /* is_pnl — 이 거래가 손익인가. 판정 기준은 lib/pnl.js 와 같다(계정과목 대분류).
     *
     * 화면이 이걸 스스로 판단할 수 없었다. 응답에 account_code 는 있었지만 그 코드가
     * 자산·부채·자본인지 알려면 계정과목표가 필요했고, 그래서 경비·잡손익 화면과 보고서가
     * **대출 실행을 매출로, 원금 상환·예적금 납입을 경비로** 집계했다.
     * 서버가 한 번에 판정해 내려준다 — 규칙이 두 벌이 되지 않게. */
    let sql = `SELECT t.*, v.name AS vendor_name, c.name AS contract_name, a.name AS account_name,
                      COALESCE(e.name, t.employee_name) AS employee_name, ri.name AS item_name,
                      cc.name AS cost_contract_name,
                      /* 어느 청구서와 이어진 입금·지급인지 — 화면이 '입금내역'에서 그 흔적을
                         보여주려면 번호가 필요하다(id 만으로는 사람이 읽을 수 없다). */
                      inv.invoice_no AS invoice_no,
                      (t.account_code IS NULL OR t.account_code = '' OR NOT EXISTS (
                         SELECT 1 FROM account_subjects s
                          WHERE s.code = t.account_code AND s.acct_type IN ('자산','부채','자본')
                      )) AS is_pnl
              FROM transactions t
              LEFT JOIN vendors v ON t.vendor_id = v.id
              LEFT JOIN contracts c ON t.contract_id = c.id
              LEFT JOIN contracts cc ON t.cost_contract_id = cc.id
              LEFT JOIN accounts a ON t.account_id = a.id
              LEFT JOIN employees e ON t.employee_id = e.id
              LEFT JOIN ref_items ri ON t.item_id = ri.id
              LEFT JOIN invoices inv ON t.invoice_id = inv.id
              WHERE 1=1`
    const params = []
    if (kind)       { sql += ' AND t.kind = ?';        params.push(kind) }
    // 주문으로 거를 땐 두 축을 모두 본다 (그 주문의 근거 거래 + 그 주문에 귀속된 원가)
    if (contractId) { sql += ' AND (t.contract_id = ? OR t.cost_contract_id = ?)'; params.push(contractId, contractId) }
    if (projectNo)  { sql += ' AND t.project_no = ?';  params.push(projectNo) }
    if (category)   { sql += ' AND t.category = ?';    params.push(category) }
    if (accountId)  { sql += ' AND t.account_id = ?';  params.push(accountId) }
    if (from)       { sql += ' AND t.date >= ?';       params.push(from) }
    if (to)         { sql += ' AND t.date <= ?';       params.push(to) }
    sql += ' ORDER BY t.date DESC'
    const [rows] = await req.db.execute(sql, params)
    await attachDocs(req.db, rows)
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/summary', async (req, res, next) => {
  try {
    const { year, month } = req.query
    let sql = "SELECT category, SUM(amount) AS total, COUNT(*) AS cnt FROM transactions WHERE kind='expense'"
    const params = []
    if (year && month) { sql += ' AND date LIKE ?'; params.push(`${year}-${month}%`) }
    sql += ' GROUP BY category ORDER BY total DESC'
    const [rows] = await req.db.execute(sql, params)
    res.json(rows)
  } catch (e) { next(e) }
})

/* ⚠ 아래 '/:id' 보다 **먼저** 서 있어야 한다.
   express 는 먼저 등록된 것부터 맞춰보므로, /:id 가 위에 있으면 'linkable' 이
   거래 id 로 잡혀 404 가 난다(실제로 그래서 후보 목록이 늘 비어 있었다). */
/**
 * 거래를 등록하기 **전에** 알려줄 것들 — "이거 여기서 넣는 게 맞나요?"
 *
 * ── 왜 필요한가 ──
 * 실사용 회사에서 같은 입금이 여러 벌로 쌓였다. 경로가 셋인데 화면이 서로를 모른다.
 *   · 정기청구가 회차를 만들어 청구서를 발행하고
 *   · 소급 마법사가 지난 회차를 만들고
 *   · 담당자가 수시입금에서 손으로 또 넣는다
 * 셋 다 "돈이 들어왔다"를 적으므로, 앞의 둘을 모른 채 손으로 넣으면 매출이 두 번 잡힌다.
 * 실제로 55건이 완전 중복이었고, 날짜만 다른 이중 계상이 18건 더 있었다.
 *
 * ── 무엇으로 짚는가 ──
 * 거래처만 보면 안 된다. 한 거래처에 정기 규칙이 여럿이고(임차료·관리비) 미수 청구서도
 * 여럿이다. 관계없는 것까지 딸려 나오면 매번 뜨는 안내가 되고, **매번 뜨는 안내는 읽히지
 * 않는다** — 정작 위험한 순간에도 넘긴다. 그래서 거래처에 더해
 *   · 주문(contract) — 폼에서 골랐다면 **다른 주문의 것은 뺀다.** 주문이 안 붙은 것은
 *                      남긴다 — 계약이 비어 있는 청구서가 애초에 문제의 출발점이었다
 *   · 금액           — 청구서는 남은 금액과, 정기는 회차 금액과 맞춰 본다
 *   · 회차 날짜      — 정기는 그 규칙의 **미처리 회차**가 입력 날짜 근처일 때만
 * 를 함께 본다.
 *
 * 막지는 않는다 — 같은 날 같은 금액이 정말 두 번 들어오는 일이 있다. **알려주고 고르게 한다.**
 */
const HINT_DAYS = 10        // 날짜가 어긋난 이중 계상을 잡는 창(소급은 1일, 실제 입금은 15일)

router.get('/entry-hints', async (req, res, next) => {
  try {
    const kind = req.query.kind === 'income' ? 'income' : 'expense'
    const vendorId = req.query.vendor_id || null
    const contractId = req.query.contract_id || null
    const date = dateOrNull(req.query.date)
    const amount = Math.round(Number(req.query.amount) || 0)
    const empty = { duplicates: [], openInvoices: [], recurring: [] }
    if (!vendorId || !date || amount <= 0) return res.json(empty)

    /* ① 같은 거래처·금액이 가까운 날짜에 이미 있나.
     *   주문으로 좁히지 않는다 — 중복으로 들어간 거래는 애초에 주문을 안 붙인 경우가 많아,
     *   좁히면 정작 잡아야 할 것을 놓친다. */
    const [duplicates] = await req.db.execute(
      `SELECT t.id, t.date, t.amount, t.memo, t.category,
              (t.invoice_id IS NOT NULL) AS has_invoice, i.invoice_no
         FROM transactions t LEFT JOIN invoices i ON t.invoice_id = i.id
        WHERE t.vendor_id = ? AND t.kind = ? AND t.amount = ?
          AND ABS(DATEDIFF(t.date, ?)) <= ?
        ORDER BY ABS(DATEDIFF(t.date, ?)) LIMIT 5`,
      [vendorId, kind, amount, date, HINT_DAYS, date])

    /* ② 아직 안 받은(안 낸) 청구서 — 여기에 붙이면 미수금·미지급금이 정리된다.
     *
     * 남은 금액과의 관계를 셋으로 나눈다. 관계에 따라 **할 수 있는 일이 다르기 때문**이다.
     *   exact   남은 금액과 딱 맞음    → 여기서 바로 정산한다
     *   partial 입력액이 남은 금액보다 적음 → 부분 입금으로 정산한다
     *   over    입력액이 남은 금액보다 많음 → 청구서 여러 건을 한꺼번에 받은 것이다.
     *                                        여기서 붙이면 과입금이 되므로 알리기만 한다.
     *
     * over 를 통째로 걸러내는 게 깔끔해 보이지만 그러면 합산 입금 때 **아무 안내도 안 뜬다** —
     * 그게 바로 떠 있는 거래가 생기는 경로다. 짚어는 주고, 처리는 청구서 화면으로 보낸다.
     *
     * 딱 맞는 것이 있으면 그것만 보여준다. 가장 확실한 답이 있는데 옆에 다른 후보를
     * 늘어놓으면 고르는 일이 오히려 어려워진다. */
    const invKind = kind === 'income' ? 'issued' : 'received'
    const doneStatus = kind === 'income' ? '입금 완료' : '지급 완료'
    const [invRows] = await req.db.execute(
      `SELECT i.id, i.invoice_no, i.issued_at, i.due_at, i.total_amount, i.status, i.contract_id,
              c.name AS contract_name,
              i.total_amount - IFNULL((SELECT SUM(m.amount) FROM invoice_matches m
                                        WHERE m.invoice_id = i.id), 0) AS remaining
         FROM invoices i
         LEFT JOIN contracts c ON i.contract_id = c.id
        WHERE i.vendor_id = ? AND i.kind = ? AND i.status <> ?
          AND (? IS NULL OR i.contract_id IS NULL OR i.contract_id = ?)
        ORDER BY i.due_at IS NULL, i.due_at, i.issued_at
        LIMIT 20`,
      [vendorId, invKind, doneStatus, contractId, contractId])
    const tagged = invRows
      .map(r => {
        const remaining = Number(r.remaining)
        return { ...r, remaining, match: remaining === amount ? 'exact' : remaining > amount ? 'partial' : 'over' }
      })
      .filter(r => r.remaining > 0)
    const pick = ['exact', 'partial', 'over'].map(m => tagged.filter(r => r.match === m)).find(a => a.length) || []
    const openInvoices = pick.slice(0, 3)

    /* ③ 정기 규칙 — 짚을 근거가 분명할 때만.
     *
     * 판정은 두 겹이다.
     *   (가) 그 규칙에 **아직 처리 안 된 회차가 있어야** 한다. 다 처리된 규칙은 지금 할 일이
     *        없으므로 짚어 봐야 "이미 했는데?"가 된다.
     *   (나) 그 위에 — 금액이 고정인 규칙은 **금액이 맞아야** 하고, 금액이 매번 다른 규칙
     *        (amount_mode='variable', 전기료 같은 것)은 금액으로 맞출 수 없으니 **회차가
     *        입력 날짜 근처**여야 한다.
     *
     * 날짜만으로 판정하면 안 된다. 월 규칙은 어느 날짜에서든 열흘 안에 회차가 걸려서
     * 사실상 매번 뜬다 — 실제로 그렇게 만들어 보니 금액이 전혀 다른 입력에도 규칙 둘이
     * 그대로 떴다. **매번 뜨는 안내는 읽히지 않는다.**
     *
     * 회차 계산은 손으로 하지 않고 lib/recurrence.js 의 dueDatesToGenerate 를 쓴다 —
     * 주기(월·분기·연)·월말 clamp·건너뛴 회차·소급 하한이 전부 거기 있고, 여기서 다시 세면
     * 두 곳이 다른 답을 갖게 된다. */
    const recTable = kind === 'income' ? 'recurring_invoices' : 'recurring_expenses'
    const itemCol = kind === 'income' ? 'item' : 'category'
    const skipKind = kind === 'income' ? 'invoice' : 'expense'
    const [recRows] = await req.db.execute(
      `SELECT r.*, r.${itemCol} AS item, c.name AS contract_name,
              UNIX_TIMESTAMP(r.created_at) AS created_epoch
         FROM ${recTable} r
         LEFT JOIN contracts c ON r.contract_id = c.id
        WHERE r.vendor_id = ? AND r.active = 1
          AND (? IS NULL OR r.contract_id IS NULL OR r.contract_id = ?)`,
      [vendorId, contractId, contractId])
    const [skipRows] = await req.db.execute(
      'SELECT recurring_id, due_date FROM recurring_skips WHERE kind = ?', [skipKind])
    const skipBy = new Map()
    for (const s of skipRows) {
      if (!skipBy.has(s.recurring_id)) skipBy.set(s.recurring_id, [])
      skipBy.get(s.recurring_id).push(String(s.due_date).slice(0, 10))
    }

    const today = kstToday()
    const recurring = []
    for (const r of recRows) {
      r.setup_date = kstDate(Number(r.created_epoch) * 1000)
      r.skips = skipBy.get(r.id) || []
      // 정기청구는 공급가액이 저장돼 있다 — 거래에 적히는 건 부가세 포함 총액이다
      const total = kind === 'income'
        ? Number(r.supply_amount) + recurFromSupply(Number(r.supply_amount), r.vat_mode || 'exclusive').vat
        : Number(r.amount)
      const variable = (r.amount_mode || 'fixed') === 'variable'
      // 부가세 계산의 원 단위 반올림 차이까지 '다른 금액'으로 보지는 않는다
      const amountMatch = !variable && Math.abs(total - amount) <= 10
      // 아직 처리 안 된 회차 중 입력 날짜와 가장 가까운 것
      const dues = dueDatesToGenerate(r, today, { horizonDays: LOOKAHEAD_DAYS })
      if (!dues.length) continue                // (가) 할 일이 남은 규칙만
      let nearDue = null, best = Infinity
      for (const d of dues) {
        const gap = Math.abs((new Date(d) - new Date(date)) / 86400000)
        if (gap < best) { best = gap; nearDue = d }
      }
      const dueNear = best <= HINT_DAYS
      if (!(variable ? dueNear : amountMatch)) continue   // (나) 근거가 없으면 잠자코 있는다
      recurring.push({
        id: r.id, item: r.item || '', amount: total, day_of_month: r.day_of_month,
        contract_name: r.contract_name || null, variable,
        due: nearDue, due_near: dueNear, amount_match: amountMatch,
        why: dueNear && amountMatch ? 'both' : dueNear ? 'due' : 'amount',
      })
      if (recurring.length >= 3) break
    }

    res.json({ duplicates, openInvoices, recurring })
  } catch (e) { next(e) }
})

/** 이 주문에 붙일 만한 거래 후보. 이미 이 주문에 붙어 있는 것은 뺀다. */
router.get('/linkable', async (req, res, next) => {
  try {
    const col = LINK_AXIS[req.query.axis] || 'contract_id'
    const kind = req.query.kind === 'income' ? 'income' : 'expense'
    const contractId = req.query.contractId || null
    if (!contractId) return res.status(400).json({ error: '주문을 지정해주세요' })
    const q = String(req.query.q || '').trim()

    /* 아직 아무 주문에도 안 붙은 거래를 먼저 세운다(ORDER BY 의 첫 키).
       다른 주문에 붙은 것도 후보에 남기는 이유는 **잘못 붙은 것을 옮기는 일**이
       이 화면의 주 용도이기 때문이다 — 목록에 없으면 옮길 수가 없다. */
    const params = [kind, contractId]
    let where = `t.kind = ? AND (t.${col} IS NULL OR t.${col} <> ?)`
    if (q) {
      where += ' AND (v.name LIKE ? OR t.memo LIKE ? OR t.category LIKE ?)'
      params.push(`%${q}%`, `%${q}%`, `%${q}%`)
    }

    const [rows] = await req.db.execute(
      `SELECT t.id, t.date, t.amount, t.category, t.memo, t.status, t.kind,
              v.name AS vendor_name, c.name AS linked_contract_name
         FROM transactions t
         LEFT JOIN vendors v ON t.vendor_id = v.id
         LEFT JOIN contracts c ON t.${col} = c.id
        WHERE ${where}
        ORDER BY (t.${col} IS NULL) DESC, t.date DESC
        LIMIT 100`, params)
    res.json(rows.map(r => ({ ...r, amount: Number(r.amount) })))
  } catch (e) { next(e) }
})

/* 전표 목록(분개장) — 기간 전체를 차변·대변으로 펼친다. 신고철에 세무사에게 넘기는 형태다.
   ⚠ '/:id' 보다 위에 있어야 한다 — 아래면 'vouchers'가 id 로 잡힌다. */
router.get('/vouchers', async (req, res, next) => {
  try {
    const { from, to, kind } = req.query
    if (!from || !to) return res.status(400).json({ error: '기간을 지정해주세요' })
    res.json(await listVouchers(req.db, { from, to, kind }))
  } catch (e) { next(e) }
})

router.get('/vouchers.xlsx', async (req, res, next) => {
  try {
    const { from, to, kind } = req.query
    if (!from || !to) return res.status(400).json({ error: '기간을 지정해주세요' })
    const vouchers = await listVouchers(req.db, { from, to, kind })
    const rows = toRows(vouchers)
    const debit = vouchers.reduce((s, v) => s + v.debitTotal, 0)
    const credit = vouchers.reduce((s, v) => s + v.creditTotal, 0)
    const bad = vouchers.filter(v => !v.balanced).length

    const wb = newBook()
    sheet(wb, '전표 목록', {
      title: '전표 목록 (분개장)',
      sub: `${from} ~ ${to} · 전표 ${vouchers.length}건 · ${rows.length}줄`
        + (bad > 0 ? ` · 확인 필요 ${bad}건` : ''),
      columns: VOUCHER_COLUMNS,
      rows,
      // 합계는 차·대 두 칸에만 — 나머지 칸에 값을 넣으면 필터를 걸 때 합계가 데이터로 딸려 온다
      totals: ['합계', '', '', '', '', debit, credit, '', '', ''],
      freezeCols: 2,   // 일자·전표번호는 오른쪽으로 넘겨도 계속 보여야 한다
    })
    guideSheet(wb, VOUCHER_GUIDE)
    await sendBook(res, wb, `전표목록_${from}_${to}.xlsx`)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(`
      SELECT t.*, v.name AS vendor_name, c.name AS contract_name, a.name AS account_name,
             COALESCE(e.name, t.employee_name) AS employee_name, ri.name AS item_name, cc.name AS cost_contract_name
      FROM transactions t
      LEFT JOIN vendors v ON t.vendor_id = v.id
      LEFT JOIN contracts c ON t.contract_id = c.id
      LEFT JOIN contracts cc ON t.cost_contract_id = cc.id
      LEFT JOIN accounts a ON t.account_id = a.id
      LEFT JOIN employees e ON t.employee_id = e.id
      LEFT JOIN ref_items ri ON t.item_id = ri.id
      WHERE t.id = ?`, [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    await attachDocs(req.db, rows)
    res.json(rows[0])
  } catch (e) { next(e) }
})

/* 거래 전표 — 이 거래가 장부에 어떻게 오르는지 차변·대변 줄로 보여준다.
 * 계정과목 이름은 서버에서 붙인다. 코드만 내보내면 화면이 다시 조회해야 하고,
 * 인쇄본에서 코드만 찍히면 사람이 읽을 수 없다. */
router.get('/:id/voucher', async (req, res, next) => {
  try {
    const [[t]] = await req.db.execute(`
      SELECT t.id, t.kind, t.amount, t.date, t.category, t.memo, t.account_code,
             a.acct_code AS bank_code, a.name AS account_name, v.name AS vendor_name
        FROM transactions t
        LEFT JOIN accounts a ON a.id = t.account_id
        LEFT JOIN vendors  v ON v.id = t.vendor_id
       WHERE t.id = ?`, [req.params.id])
    if (!t) return res.status(404).json({ error: 'Not found' })
    res.json(await withNames(req.db, transactionVoucher(t), { account_name: t.account_name }))
  } catch (e) { next(e) }
})

/* ── 계좌 간 이체 ───────────────────────────────────────────────
 *
 * ── 왜 전용 경로가 필요한가 ──
 * 이 앱에는 이체가 없었다. 그래서 신용카드 대금처럼 **통장에서 카드로 옮기는 돈**을
 * 적을 방법이 지출밖에 없었고, 그러면 이렇게 된다:
 *   · 카드로 산 소모품 → 지출 1건 (비용)
 *   · 결제일 통장 출금 → 지출 1건 (또 비용)  ← **같은 돈이 비용으로 두 번**
 * 안 적으면 반대로 통장 잔액이 실제보다 많다. 소모품·비품을 카드로 사는 건 매일 있는
 * 일이라 **틀린 금액이 계속 쌓인다.**
 *
 * ── 왜 두 줄인가 ──
 * 계좌 잔액은 `기초 + 입금 − 지출` 로 계산된다(routes/accounts.js). 이체를 **두 줄**
 * (출금계좌의 지출 + 입금계좌의 입금)로 남기면 **잔액 로직을 한 글자도 안 고치고**
 * 양쪽이 맞는다. 한 줄에 from/to 를 담으면 잔액·일계표·자금일보를 전부 이체 전용으로
 * 다시 짜야 하고, 그 중 하나만 빠뜨려도 조용히 틀린다.
 * 두 줄은 `transfer_id` 로 잇는다 — 하나만 지우면 돈이 사라지거나 생겨난다.
 *
 * ── 왜 손익이 아닌가 ──
 * 내 통장에서 내 카드로 옮긴 것은 벌지도 쓰지도 않은 것이다. 손익 판정은 계정과목
 * 대분류가 한다(lib/pnl.js) → 양쪽 다 **상대 계좌의 계정과목**(자산·부채)을 달아
 * 손익 집계에서 자동으로 빠지게 한다. 상대 계좌에 계정과목이 없으면 1103 보통예금.
 *
 * ⚠ 자금 계정 가드(fundAccountError)를 **이 경로만** 우회한다.
 *   그 가드는 "계정과목에 현금·예금이 오면 분개가 성립하지 않는다"는 규칙인데,
 *   이체는 **바로 그 자금 계정끼리의 이동**이라 유일한 정당한 예외다.
 *   가드 주석에도 그렇게 하라고 적혀 있다(transactions.js 상단).
 */
router.post('/transfer', async (req, res, next) => {
  const { from_account_id, to_account_id, amount, date, memo } = req.body
  const conn = await req.db.getConnection()
  try {
    const amt = Math.round(Number(amount) || 0)
    if (!from_account_id || !to_account_id) {
      return res.status(400).json({ error: '보내는 계좌와 받는 계좌를 모두 골라주세요' })
    }
    if (from_account_id === to_account_id) {
      return res.status(400).json({ error: '같은 계좌로는 옮길 수 없어요' })
    }
    const ae = amountError(amt)
    if (ae) return res.status(400).json({ error: ae })
    /* ⚠ 날짜가 비었는지 **직접** 본다. futureDateError 는 `date &&` 로 시작해서
       빈 값을 그냥 통과시킨다(미래가 아니니까). 그대로 INSERT 하면 NOT NULL 로
       500 이 나고, 사용자는 왜 안 되는지 모른다. */
    if (!date) return res.status(400).json({ error: '날짜를 입력해주세요' })
    const fe = futureDateError(date)
    if (fe) return res.status(400).json({ error: fe })

    await conn.beginTransaction()
    /* 마감된 달이면 막는다. 이체도 실제로 잔액을 움직이는 거래라, 신고를 끝낸 달의
       숫자를 뒤에서 바꾸면 이미 낸 신고서와 장부가 갈린다(다른 경로와 같은 규칙). */
    const ce = await closedPeriodError(conn, date)
    if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }

    const [accts] = await conn.execute(
      'SELECT id, name, kind, acct_code FROM accounts WHERE id IN (?, ?)',
      [from_account_id, to_account_id])
    const from = accts.find(a => a.id === from_account_id)
    const to   = accts.find(a => a.id === to_account_id)
    if (!from || !to) { await rollbackQuietly(conn); return res.status(404).json({ error: '계좌를 찾을 수 없어요' }) }

    /* 상대 계좌의 계정과목을 단다 — 이 거래가 손익에 안 잡히게 하는 장치다(위 설명).
     *
     * ⚠ 카드는 **2202 미지급금**이다. 계좌 테이블의 acct_code 는 예금 종류로만 정해져서
     *   (lib/acctCode.js bankAcctCode) 카드도 1103 보통예금을 받는다. 그대로 쓰면
     *   통장→카드 이체의 분개가 `보통예금 / 보통예금` 이 되어 일계표에서 뜻을 잃는다.
     *   신용카드 잔액은 회계적으로 '아직 안 갚은 돈'이므로 미지급금이 맞다.
     * 그 밖에는 계좌의 계정과목, 비어 있으면 1103. 어느 쪽이든 자산·부채라
     * lib/pnl.js 가 손익에서 빼 준다. */
    const CARD_CODE = '2202'   // 미지급금
    const codeOf = (a) => (a.kind === 'card' ? CARD_CODE : (String(a.acct_code || '').trim() || '1103'))
    const transferId = randomUUID()
    const note = (memo || '').trim() || `${from.name} → ${to.name} 이체`

    const mk = async (kind, accountId, counterCode) => {
      const id = randomUUID()
      await conn.execute(
        `INSERT INTO transactions
           (id, kind, account_id, account_code, category, amount, date, method, status,
            doc_no, memo, transfer_id, counterparty_account_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, kind, accountId, counterCode, '계좌 이체', amt, date,
         '계좌이체', kind === 'income' ? '입금완료' : '지급완료', '공통', note,
         transferId, kind === 'expense' ? to_account_id : from_account_id])
      return id
    }
    // 보내는 쪽은 지출, 받는 쪽은 입금 — 두 줄이 같은 transfer_id 를 갖는다
    const outId = await mk('expense', from_account_id, codeOf(to))
    const inId  = await mk('income',  to_account_id,   codeOf(from))

    await conn.commit()
    res.json({ ok: true, transfer_id: transferId, out_id: outId, in_id: inId })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.post('/', async (req, res, next) => {
  try {
    const {
      kind, vendor_id, contract_id, cost_contract_id, account_id, category, sub_category,
      amount, date, method, status, project_no, site,
      invoice_id, recurring_id, doc_no, employee_id, employee_name, evid_type, evid_url, memo,
      item_id, account_code, supply_amount, vat_amount, tax_type, vat_deductible,
      counterparty_account_id
    } = req.body
    const dateErr = futureDateError(date)
    if (dateErr) return res.status(400).json({ error: dateErr })
    const closedErr = await closedPeriodError(req.db, date)
    if (closedErr) return res.status(409).json({ error: closedErr })
    // 음수·초대형 금액을 서버에서 막는다 — 음수 지출은 계좌 잔액을 늘리고 매입세액을 깎는다
    { const ae = amountError(amount); if (ae) return res.status(400).json({ error: ae }) }
    const vat = vatFields({ amount, supply_amount, vat_amount, tax_type, vat_deductible })
    // 완료 상태인데 계좌가 없으면 잔액에 잡히지 않는다(lib/ledger.js 참고)
    // 기본 상태는 종류별로 — 수입에 '지급완료'가 박히면 '입금완료'만 세는 집계에서 빠진다
    const st = normalizeStatus(status || defaultSettledStatus(kind))
    const lerr = ledgerError({ kind, account_id, status: st, method })
    if (lerr) return res.status(400).json({ error: lerr })
    { const fe = fundAccountError(account_code); if (fe) return res.status(400).json({ error: fe }) }
    // 계정과목을 안 고르면 비목이 정해 둔 값을 쓴다 — 비면 일계표에서 상대 계정이 빈다
    const acctCode = await resolveAcctCode(req.db, account_code, category, kind)
    const id = randomUUID()
    // 원가 귀속(cost_contract_id)은 지출에만 의미가 있다 — 수금에 붙으면 매출주문 원가가 부풀어 오른다
    const costId = kind === 'expense' ? (cost_contract_id || null) : null
    const cp = await counterpartySnapshot(req.db, vendor_id, counterparty_account_id)
    await req.db.execute(`
      INSERT INTO transactions (id, kind, vendor_id, contract_id, cost_contract_id, account_id, category, sub_category,
        amount, date, method, status, project_no, site,
        invoice_id, recurring_id, doc_no, employee_id, employee_name, evid_type, evid_url, memo, item_id, account_code,
        supply_amount, vat_amount, tax_type, vat_deductible,
        counterparty_account_id, counterparty_bank, counterparty_account, counterparty_holder)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [id, kind, vendor_id||null, contract_id||null, costId, account_id||null, category||'', sub_category||'',
        amount, date, method||'', st, project_no||'', site||'',
        invoice_id||null, recurring_id||null, doc_no||'', employee_id||null, employee_name||null, evid_type||'', evid_url||'', memo||'',
        item_id||null, acctCode,
        vat.supply_amount, vat.vat_amount, vat.tax_type, vat.vat_deductible,
        cp.id, cp.bank, cp.account, cp.holder])
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const {
      vendor_id, contract_id, cost_contract_id, account_id, category, sub_category,
      amount, date, method, status, project_no, site,
      doc_no, employee_id, employee_name, evid_type, evid_url, memo, item_id, account_code,
      supply_amount, vat_amount, tax_type, vat_deductible, counterparty_account_id
    } = req.body
    const dateErr = futureDateError(date)
    if (dateErr) return res.status(400).json({ error: dateErr })
    // 등록과 같은 금액 검증 — 수정으로 음수를 넣는 경로도 막아야 한다
    { const ae = amountError(amount); if (ae) return res.status(400).json({ error: ae }) }
    const vat = vatFields({ amount, supply_amount, vat_amount, tax_type, vat_deductible })
    // 편집으로 수입 거래가 되면 원가 귀속은 떨어진다
    const [[cur]] = await req.db.execute('SELECT kind, date AS cur_date FROM transactions WHERE id = ?', [req.params.id])
    if (!cur) return res.status(404).json({ error: 'Not found' })
    // 마감은 옮기기 전·후 두 날짜를 모두 본다 — 한쪽만 보면 잠긴 달에서 거래를 빼내거나 밀어넣을 수 있다
    const closedErr = await closedPeriodError(req.db, cur.cur_date, date)
    if (closedErr) return res.status(409).json({ error: closedErr })
    /* 다른 장부가 참조하는 거래는 **수정도** 막는다.
     * 삭제만 막고 있었는데, 부가세 납부 거래 금액을 500만 → 300만으로 고치면
     * 계좌는 300만인데 vat_filings.paid_amount 는 500만 그대로가 된다 — 세무 화면과 어긋난다.
     * 재무 거래도 같다(원금을 고치면 차입금 잔액과 안 맞는다). */
    const OWNED = [
      ['vat_filings', 'txn_id', '부가세 납부', '세무관리 > 부가세'],
      ['other_taxes', 'txn_id', '세액 납부', '세무관리 > 기타세액'],
      ['loans', 'txn_id', '차입금 실행', '재무관리 > 차입금'],
      ['loan_repayments', 'txn_principal_id', '차입금 상환(원금)', '재무관리 > 차입금'],
      ['loan_repayments', 'txn_interest_id', '차입금 상환(이자)', '재무관리 > 차입금'],
      ['savings', 'txn_id', '예금 가입', '재무관리 > 예금·적금'],
      ['savings_payments', 'txn_id', '적금 납입', '재무관리 > 예금·적금'],
      ['investments', 'txn_id', '투자', '재무관리 > 투자'],
    ]
    for (const [table, col, label, where] of OWNED) {
      const [[hit]] = await req.db.execute(`SELECT 1 AS x FROM ${table} WHERE ${col} = ? LIMIT 1`, [req.params.id])
      if (hit) {
        return res.status(409).json({
          error: `${label} 거래는 여기서 고칠 수 없어요. ${where} 화면에서 되돌린 뒤 다시 등록해주세요.`,
        })
      }
    }
    // 장부 불변식은 등록(POST)·상태변경(PATCH)과 똑같이 수정에도 걸어야 한다.
    // 여기가 비어 있어서, 완료 상태 지출을 계좌 없이 저장하면 거래는 남고 계좌 잔액에서만
    // 조용히 빠지는 상태가 만들어졌다(F-02 계열). 상태는 표준형으로 정규화한 뒤 검사한다.
    const st = normalizeStatus(status || defaultSettledStatus(cur.kind))
    const lerr = ledgerError({ kind: cur.kind, account_id, status: st, method })
    if (lerr) return res.status(400).json({ error: lerr })
    // 등록과 같은 가드·기본값을 수정에도 건다 — 한쪽만 막으면 수정으로 우회된다
    { const fe = fundAccountError(account_code); if (fe) return res.status(400).json({ error: fe }) }
    const acctCode = await resolveAcctCode(req.db, account_code, category, cur.kind)
    const costId = cur.kind === 'expense' ? (cost_contract_id || null) : null
    const cp = await counterpartySnapshot(req.db, vendor_id, counterparty_account_id)
    // 금액이 바뀌면 청구서 매칭액도 따라가야 한다. 거래 수정과 매칭 갱신이 갈라지면
    // 청구서 정산액이 옛 금액으로 남아 미수/미지급이 틀어지므로 한 트랜잭션으로 묶는다.
    const conn = await req.db.getConnection()
    try {
      await conn.beginTransaction()
      const [result] = await conn.execute(`
        UPDATE transactions SET vendor_id=?, contract_id=?, cost_contract_id=?, account_id=?, category=?, sub_category=?,
          amount=?, date=?, method=?, status=?, project_no=?, site=?,
          doc_no=?, employee_id=?, employee_name=?, evid_type=?, evid_url=?, memo=?, item_id=?, account_code=?,
          supply_amount=?, vat_amount=?, tax_type=?, vat_deductible=?,
          counterparty_account_id=?, counterparty_bank=?, counterparty_account=?, counterparty_holder=?
        WHERE id=?
      `, [vendor_id||null, contract_id||null, costId, account_id||null, category||'', sub_category||'',
          amount, date, method||'', st, project_no||'', site||'',
          doc_no||'', employee_id||null, employee_name||null, evid_type||'', evid_url||'', memo||'', item_id||null, acctCode,
          vat.supply_amount, vat.vat_amount, vat.tax_type, vat.vat_deductible,
          cp.id, cp.bank, cp.account, cp.holder, req.params.id])
      if (result.affectedRows === 0) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }

      // 이 거래에 걸린 청구서 매칭을 새 금액에 맞춰 조정하고 청구서 상태를 재계산한다.
      const [links] = await conn.execute('SELECT id, invoice_id, amount FROM invoice_matches WHERE txn_id = ?', [req.params.id])
      for (const link of links) {
        // 같은 청구서의 다른 매칭을 뺀 잔여를 넘지 않도록 제한(과입금·과지급 방지)
        const [[{ others }]] = await conn.execute(
          'SELECT COALESCE(SUM(amount),0) AS others FROM invoice_matches WHERE invoice_id = ? AND id <> ?',
          [link.invoice_id, link.id])
        const [[inv]] = await conn.execute('SELECT total_amount FROM invoices WHERE id = ?', [link.invoice_id])
        const remainForThis = Number(inv?.total_amount || 0) - Number(others)
        const newMatch = Math.max(0, Math.min(Number(amount) || 0, remainForThis))
        await conn.execute('UPDATE invoice_matches SET amount = ? WHERE id = ?', [newMatch, link.id])
        await recalcInvoiceStatus(conn, link.invoice_id)
      }

      await conn.commit()
      res.json({ ok: true })
    } catch (e) { await rollbackQuietly(conn); throw e }
    finally { conn.release() }
  } catch (e) { next(e) }
})

router.patch('/:id/status', async (req, res, next) => {
  try {
    const { account_id } = req.body
    // 완료 상태는 무공백 표준형으로 정규화 — 잔액 계산(accounts.js)이 '지급완료'/'입금완료'만
    // 세므로 '지급 완료'(공백)로 들어오면 누락된다(F-02 계열 방지).
    const status = normalizeStatus(req.body.status)
    if (!status) return res.status(400).json({ error: 'status 필수' })
    const [[cur]] = await req.db.execute('SELECT kind, account_id, date, method FROM transactions WHERE id = ?', [req.params.id])
    if (!cur) return res.status(404).json({ error: 'Not found' })
    // 상태를 바꾸면 계좌 잔액이 움직인다('지급 대기'↔'지급완료'). 마감된 달이면 막는다 —
    // POST·PUT·DELETE는 모두 검사하는데 여기만 빠져 있어서, 거래내역의 '이체 실행' 버튼 하나로
    // 마감월 잔액이 사후에 바뀌었다(양방향 모두).
    { const ce = await closedPeriodError(req.db, cur.date); if (ce) return res.status(409).json({ error: ce }) }
    // 계좌가 비어 있으면 '완료'로 바꿔도 잔액에서 움직이지 않는다. 정기지출은 계좌 없이
    // '지급 대기'로 생성될 수 있어(recurring.js), 거래내역의 '이체 실행'이 이 경로를 탄다.
    // 요청이 계좌를 함께 보냈으면 그걸로 채우고, 그래도 없으면 막는다.
    const acct = cur.account_id || account_id || null
    const err = ledgerError({ kind: cur.kind, account_id: acct, status, method: cur.method })
    if (err) return res.status(400).json({ error: err })
    const [result] = await req.db.execute(
      'UPDATE transactions SET status = ?, account_id = ? WHERE id = ?', [status, acct, req.params.id])
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/* 증빙만 갱신 — 다른 필드 보존.
 *
 * evid_ok 는 **파일이 없을 때 쓰는 문**이다. 원본이 종이로만 오는 곳이 아직 많아서,
 * 파일 유무로만 판정하면 그런 회사는 영원히 '증빙 미비'로 남고 그 목록을 아무도 안 본다.
 * (판정 규칙은 lib/evidence.js 한 곳에 있다 — 화면마다 다르게 세면 둘 다 못 믿는다.)
 *
 * ⚠ **보낸 칸만 쓴다.** 예전엔 셋을 무조건 덮어써서, 확인 체크만 보내면 붙여 둔 파일 주소가
 *   빈 문자열로 지워졌다(청구서 PUT·비목 PUT 에서 고친 것과 같은 유형). */
router.patch('/:id/evidence', async (req, res, next) => {
  try {
    const { evid_url, evid_type, evid_ok } = req.body
    const sets = [], vals = []
    if (evid_url  !== undefined) { sets.push('evid_url=?');  vals.push(evid_url || '') }
    if (evid_type !== undefined) { sets.push('evid_type=?'); vals.push(evid_type || '') }
    if (evid_ok   !== undefined) { sets.push('evid_ok=?');   vals.push(evid_ok ? 1 : 0) }
    if (!sets.length) return res.status(400).json({ error: '바꿀 값이 없어요' })
    const [result] = await req.db.execute(
      `UPDATE transactions SET ${sets.join(', ')} WHERE id=?`, [...vals, req.params.id])
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 거래 첨부 서류(다중)
router.post('/:id/docs', async (req, res, next) => {
  try {
    const { url, name, doc_type, size } = req.body
    if (!url) return res.status(400).json({ error: 'url 필수' })
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO transaction_docs (id, txn_id, url, name, doc_type, size) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, url, name || '', doc_type || '', size || 0]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.delete('/docs/:docId', async (req, res, next) => {
  try {
    // DB 행만 지우면 실제 파일이 uploads/{companyId}/ 에 그대로 남는다(고아 파일).
    const [[doc]] = await req.db.execute('SELECT url FROM transaction_docs WHERE id = ?', [req.params.docId])
    await req.db.execute('DELETE FROM transaction_docs WHERE id = ?', [req.params.docId])
    if (doc) removeUploadedFile(doc.url, req.user?.companyId)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    // 마감된 달의 거래는 지울 수 없다(신고자료와 장부가 어긋난다)
    const [[del]] = await conn.execute('SELECT date FROM transactions WHERE id = ?', [req.params.id])
    if (del) {
      const closedErr = await closedPeriodError(conn, del.date)
      if (closedErr) { await rollbackQuietly(conn); return res.status(409).json({ error: closedErr }) }
    }
    // 세금 납부 거래는 여기서 지우면 안 된다.
    // vat_filings·other_taxes 의 txn_id 는 나중에 ensureColumn 으로 붙인 컬럼이라 FK가 없어,
    // 지워도 DB가 막아주지 않는다. 그러면 세무 화면은 '납부 완료 / 납부액 500만'인데
    // 거래내역엔 그 지출이 없고 계좌 잔액만 500만 늘어난 상태가 된다.
    // 되돌리는 정상 경로는 세무관리 화면에서 상태를 되돌리는 것이다(syncTaxTxn 이 거래도 지운다).
    const [[vat]] = await conn.execute('SELECT year, quarter FROM vat_filings WHERE txn_id = ? LIMIT 1', [req.params.id])
    if (vat) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `${vat.year}년 ${vat.quarter}분기 부가세 납부 거래예요. 세무관리 > 부가세 화면에서 납부를 취소하면 이 거래도 함께 정리됩니다.`,
      })
    }
    const [[ot]] = await conn.execute('SELECT name FROM other_taxes WHERE txn_id = ? LIMIT 1', [req.params.id])
    if (ot) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `'${ot.name}' 세액 납부 거래예요. 세무관리 > 기타세액 화면에서 납부를 취소하면 이 거래도 함께 정리됩니다.`,
      })
    }
    /* 재무 거래(차입금·예적금·투자)도 같은 이유로 막는다.
     * loans.txn_id, loan_repayments.txn_*_id, savings.txn_id, savings_payments.txn_id,
     * investments.txn_id 는 전부 ensureColumn 으로 붙인 컬럼이라 **FK가 없다** — 지워도 DB가
     * 안 막는다. 3회차 상환 거래를 지우면 계좌 잔액은 복구되는데 loan_repayments 의
     * paid_date 는 그대로 남아 **통장·장부·차입금 잔액 3자가 어긋난다.**
     * 되돌리는 정상 경로는 각 화면의 '상환 취소'·'해지'다(거래까지 함께 정리한다).
     * 급여·결의서는 FK가 있어 이미 막히는데 재무 쪽만 뚫려 있었다. */
    const FIN_REFS = [
      ['loans', 'txn_id', '차입금 실행'],
      ['loan_draws', 'txn_id', '차입금 추가 인출'],
      ['loan_repayments', 'txn_principal_id', '차입금 상환(원금)'],
      ['loan_repayments', 'txn_interest_id', '차입금 상환(이자)'],
      ['savings', 'txn_id', '예금 가입'],
      ['savings', 'txn_maturity_id', '예적금 만기(원금)'],
      ['savings', 'txn_interest_id', '예적금 만기(이자)'],
      ['savings_payments', 'txn_id', '적금 납입'],
      ['investments', 'txn_id', '투자'],
    ]
    for (const [table, col, label] of FIN_REFS) {
      const [[hit]] = await conn.execute(`SELECT 1 AS x FROM ${table} WHERE ${col} = ? LIMIT 1`, [req.params.id])
      if (hit) {
        await rollbackQuietly(conn)
        return res.status(409).json({
          error: `${label} 거래예요. 재무관리 화면에서 되돌려야 관련 기록이 함께 정리됩니다.`,
        })
      }
    }

    // 이 거래에 걸린 청구서 매칭을 정리하고 청구서 상태를 재계산한다.
    // 안 하면 매칭이 고아로 남아 청구서가 '완료'인 채 미수/미지급이 누락된다.
    const [matches] = await conn.execute('SELECT invoice_id FROM invoice_matches WHERE txn_id = ?', [req.params.id])
    await conn.execute('DELETE FROM invoice_matches WHERE txn_id = ?', [req.params.id])
    for (const m of matches) await recalcInvoiceStatus(conn, m.invoice_id)
    // 정기지출에서 자동 생성된 거래면 last_generated 를 되돌려 그 회차가 다시 생성되게 한다.
    const [[cur]] = await conn.execute('SELECT recurring_id, date, transfer_id FROM transactions WHERE id = ?', [req.params.id])
    /* ⚠ 이체는 **짝과 함께** 지운다.
     * 이체는 거래 두 줄(보내는 계좌의 지출 + 받는 계좌의 입금)로 남는다. 한 줄만 지우면
     * 나머지 한 줄이 짝 없이 남아 **돈이 사라지거나 생겨난다** — 통장에서는 나갔는데
     * 카드에는 들어온 기록만 남는 식이다. 잔액도 장부도 그때부터 틀린다.
     * 그래서 transfer_id 가 같은 줄을 통째로 지운다(자기 자신 포함). */
    if (cur?.transfer_id) {
      await conn.execute('DELETE FROM transactions WHERE transfer_id = ?', [cur.transfer_id])
    } else {
      await conn.execute('DELETE FROM transactions WHERE id = ?', [req.params.id])
    }
    const rec = cur?.recurring_id
      ? await restoreLastGenerated(conn, 'recurring_expenses', cur.recurring_id, cur.date)
      : { restored: false, note: null }
    await conn.commit()
    res.json({ ok: true, recurringNote: rec.note })
  } catch (e) {
    await rollbackQuietly(conn)
    if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.errno === 1451) {
      return res.status(409).json({ error: '지급결의서·급여에 연결된 거래라 삭제할 수 없어요' })
    }
    next(e)
  } finally { conn.release() }
})

// ── 엑셀 임포트: 파싱(헤더 + 행 미리보기) ──
router.post('/import/parse', uploadMem.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다' })
    const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) return res.json({ headers: [], rows: [] })
    const json = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false })
    const headers = json.length ? Object.keys(json[0]) : []
    res.json({ headers, rows: json.slice(0, 500) })
  } catch (e) { next(e) }
})

// ── 엑셀 임포트: 일괄 등록(미등록 거래처는 자동 생성) ──
router.post('/import/commit', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : []
    // 대량 등록은 '완료' 상태로 들어가므로 계좌가 없으면 그 수백 건이 통째로
    // 계좌 잔액에서 누락된다(accounts.js calcBalance는 account_id로 계좌를 특정해 합산).
    // 행별 계좌(it.account_id)를 우선하고, 없으면 일괄 지정 계좌를 쓴다.
    const accountId = req.body.account_id || null
    if (!accountId && items.some(it => !it.account_id)) {
      return res.status(400).json({ error: '입출금 계좌를 선택해주세요. 계좌를 지정해야 잔액에 반영됩니다.' })
    }
    /* 이름 → id 지도.
     *
     * ⚠ **이름은 유일하지 않다.** 예전엔 `map[name] = id` 로 그냥 덮어써서, 같은 이름이
     *   여럿이면 마지막 하나만 남고 그 행들이 전부 거기로 붙었다. 실제 회사에서
     *   거래처만 다른 '홈페이지 유지보수' 주문이 여덟 개였고, 다른 거래처의 입금
     *   19건이 엉뚱한 주문에 붙었다. 게다가 DB 이름 끝에 공백이 있으면
     *   (`홈페이지 유지보수 `) trim 한 엑셀 값과 안 맞아 **아무 데도 안 붙었다.**
     *
     * 그래서 (1) 키를 trim 해 맞추고 (2) 같은 이름이 여럿이면 **붙이지 않는다.**
     *   아무거나 집는 것보다 비워 두는 편이 낫다 — 비면 사람이 알아채지만,
     *   엉뚱한 데 붙으면 아무도 모른 채 계약 수익이 틀어진다.
     * 주문은 **거래처가 같은 것 하나**로 좁혀 볼 수 있으면 그것으로 잇는다. */
    const [vs] = await conn.execute('SELECT id, name FROM vendors')
    const vendorByName = {}
    for (const v of vs) (vendorByName[String(v.name || '').trim()] ||= []).push(v.id)
    const [cs] = await conn.execute('SELECT id, name, vendor_id FROM contracts')
    const contractByName = {}
    for (const c of cs) (contractByName[String(c.name || '').trim()] ||= []).push(c)
    const ambiguous = []   // 이름이 겹쳐 못 이은 것 — 응답으로 알려준다

    await conn.beginTransaction()
    let inserted = 0, skippedFuture = 0, skippedClosed = 0, skippedAmount = 0; const createdVendors = []
    for (const it of items) {
      // 미래 일자 거래는 건너뛴다 — 완료 상태로 들어가 계좌 잔액에 즉시 반영되므로 개별 등록과 같은 규칙 적용.
      if (futureDateError(it.date)) { skippedFuture++; continue }
      // 마감된 달도 같은 이유로 건너뛴다 — 개별 등록이면 409로 막히는 행이 일괄에서만 통과하면 안 된다.
      if (await closedPeriodError(conn, it.date)) { skippedClosed++; continue }
      let vendorId = null
      const vname = String(it.vendor || '').trim()
      if (vname) {
        const hit = vendorByName[vname] || []
        if (hit.length === 1) vendorId = hit[0]
        else if (hit.length > 1) ambiguous.push(`거래처 "${vname}"`)   // 여럿이면 안 잇는다
        else {
          vendorId = randomUUID()
          await conn.execute('INSERT INTO vendors (id, name, gubu) VALUES (?,?,?)',
            [vendorId, vname, it.kind === 'income' ? 'B' : 'A'])
          vendorByName[vname] = [vendorId]; createdVendors.push(vname)
        }
      }
      const cname = String(it.contract || '').trim()
      let contractId = null
      if (cname) {
        const hits = contractByName[cname] || []
        if (hits.length === 1) contractId = hits[0].id
        else if (hits.length > 1) {
          // 같은 이름이 여럿 — 거래처로 좁혀 하나로 정해지면 그것으로 잇는다
          const same = vendorId ? hits.filter(c => c.vendor_id === vendorId) : []
          if (same.length === 1) contractId = same[0].id
          else ambiguous.push(`주문 "${cname}"`)
        }
      }
      // account_id 를 반드시 넣는다. 빠지면 위 주석대로 '완료 상태'로만 들어가고
      // 계좌 잔액에는 영원히 안 잡혀, 대량 등록 직후부터 통장과 장부가 어긋난다.
      /* 부가세 필드를 반드시 채운다.
       * 예전엔 supply_amount·vat_amount·tax_type 이 INSERT 목록에 아예 없어 전부 NULL 이었다.
       * 부가세 집계(routes/tax.js)는 `vat_amount IS NOT NULL` 인 거래만 세므로,
       * **엑셀로 올린 수백 건의 매입세액이 신고 자료에서 통째로 빠졌다.**
       * 개별 등록(POST /)은 처음부터 vatFields 를 거쳤다 — 이 경로만 빠져 있었다. */
      const vat = vatFields({
        amount: it.amount, supply_amount: it.supply_amount, vat_amount: it.vat_amount,
        tax_type: it.tax_type, vat_deductible: it.vat_deductible,
      })
      // 금액 검증도 개별 등록과 같게 — 음수 지출이 들어오면 계좌 잔액이 늘어난다
      const ae = amountError(it.amount)
      if (ae) { skippedAmount++; continue }
      /* account_code — 빠지면 일계표에서 상대 계정이 비어 차·대변이 안 맞는다.
         엑셀 대량 등록은 수백 건이 한 번에 들어오는 경로라, 빠지면 그날들이 통째로 깨진다.
         (주석은 값 배열 **밖에** 둔다 — check:isolation 의 인자 개수 검사가 주석 안의
          콤마까지 값으로 세어 '?=17 값=18' 오탐이 난다) */
      await conn.execute(`
        INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, account_code, category, amount, date, method, status, doc_no, memo,
                                  supply_amount, vat_amount, tax_type, vat_deductible)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [randomUUID(), it.kind, vendorId, contractId, it.account_id || accountId,
          it.account_code || null,
          it.category || '', it.amount, it.date,
          '계좌이체', it.kind === 'income' ? '입금완료' : '지급완료',
          (cname && !contractId) ? cname : '', it.memo || '',
          vat.supply_amount, vat.vat_amount, vat.tax_type, vat.vat_deductible])
      inserted++
    }
    await conn.commit()
    /* ambiguous — 이름이 겹쳐 **일부러 안 이은** 것. 조용히 비우면 "왜 주문이 안 붙었지"가
       한참 뒤 계약 수익을 볼 때에야 드러난다. 올린 자리에서 바로 알린다. */
    res.json({ inserted, createdVendors, skippedFuture, skippedClosed, skippedAmount,
      ambiguous: [...new Set(ambiguous)] })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// ── 엑셀 임포트: 양식 다운로드(.xlsx) ──
router.get('/import/template', async (req, res, next) => {
  try {
    const rows = [
      ["거래일자", "거래처", "주문명", "구분", "비목", "금액", "메모"],
      ["2026-06-01", "(주)한빛문구", "", "지출", "소모품", 80000, "사무용품"],
      ["2026-06-03", "정밀가공(주)", "홈페이지 유지보수", "지출", "외주가공비", 1500000, "6월 외주분"],
      ["2026-06-10", "(재)부산영재교육진흥원", "홈페이지 개선", "입금", "납품대금", 3500000, "선급금"],
    ]
    const COLS = [
      { header: '거래일자', width: 12, required: true }, { header: '거래처', width: 22 },
      { header: '주문명', width: 24 }, { header: '구분', width: 8, required: true },
      { header: '비목', width: 14 }, { header: '금액', width: 12, required: true },
      { header: '메모', width: 20 },
    ]

    const guide = [
      ["거래내역 일괄 업로드 — 작성 안내"],
      [""],
      ["• 거래일자: YYYY-MM-DD 권장 (예: 2026-06-01). 2026.6.1 / 6/1/26 형식도 인식됩니다."],
      ["• 거래처: 비워도 됩니다. 목록에 없는 거래처는 업로드 시 자동 등록돼요 (입금=발주처 / 지출=매입처)."],
      ["• 주문명: 연결할 주문이 있으면 정확히 입력, 없으면 비워두세요."],
      ["• 구분: '입금' 또는 '지출' (수입·매출=입금 / 매입·출금=지출 도 인식)."],
      ["• 비목: 외주가공비·소모품·납품대금 등 자유롭게 입력하세요."],
      ["• 금액: 숫자만 입력(쉼표 가능). 부호 없이 양수로."],
      ["• 첫 행(머리글)은 그대로 두고, 둘째 행부터 데이터를 입력하세요."],
    ]
    const wb = newBook()
    templateSheet(wb, '거래내역', { columns: COLS, samples: rows.slice(1) })
    guideSheet(wb, guide.map(g => g[0], '작성안내', { hasRequired: true }))
    await sendBook(res, wb, '거래내역_업로드_양식.xlsx')
  } catch (e) { next(e) }
})


/* ── 주문 연결 ──────────────────────────────────────────────────
 *
 * 고객 지적: "엑셀로 거래를 올린 뒤 주문과 맞추는 과정이 굉장히 번거롭다",
 *           "주문에 잘못 붙은 지출/입금을 전체 거래내역에서 찾느라 헤맸다".
 *
 * 주문 연결은 청구서 '매칭'과 **성격이 다르다.**
 *   청구서 매칭 — 이 돈이 저 청구서를 얼마나 갚았나(invoice_matches 에 금액 배분, 부분 입금 가능)
 *   주문 연결   — 이 거래가 어느 주문 건인가(transactions 의 컬럼 하나, 부분은 없다)
 * 그래서 이름도 '연결'로 쓴다. 같은 말을 쓰면 부분 연결을 기대하게 된다.
 *
 * ⚠ 축이 둘이다. 틀리면 돈이 엉뚱한 바구니에 **조용히** 들어간다(원가율만 이상해진다).
 *   contract_id      — 이 주문이 근거인 거래 (매출주문의 입금 / 매입주문의 지급)
 *   cost_contract_id — 이 지출이 원가로 붙는 매출 주문 (외주비가 대표적)
 *   외주비는 외주 매입주문에 '지급'되면서 동시에 그 프로젝트 매출주문의 '원가'다.
 */
const LINK_AXIS = { contract: 'contract_id', cost: 'cost_contract_id' }

/** 여러 거래를 주문에 붙이거나(contractId 지정) 뗀다(contractId 없음). */
router.post('/link-contract', async (req, res, next) => {
  const ids = Array.isArray(req.body.txnIds) ? req.body.txnIds.filter(Boolean) : []
  if (!ids.length) return res.status(400).json({ error: '연결할 거래를 선택해주세요' })
  if (ids.length > 200) return res.status(400).json({ error: `한 번에 200건까지예요 (${ids.length}건 선택)` })
  const col = LINK_AXIS[req.body.axis] || 'contract_id'
  const contractId = req.body.contractId || null

  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    if (contractId) {
      const [[c]] = await conn.execute('SELECT id FROM contracts WHERE id = ?', [contractId])
      if (!c) { await rollbackQuietly(conn); return res.status(404).json({ error: '주문을 찾을 수 없어요' }) }
    }
    const ph = ids.map(() => '?').join(',')
    const [txns] = await conn.execute(
      `SELECT id, date, kind FROM transactions WHERE id IN (${ph}) FOR UPDATE`, ids)
    if (txns.length !== ids.length) {
      await rollbackQuietly(conn)
      return res.status(404).json({ error: '없는 거래가 섞여 있어요. 목록을 새로고침해주세요.' })
    }
    /* 원가 귀속은 지출에만 있다. 입금에 붙이면 어느 집계에도 안 잡히는 값이 남는다. */
    if (col === 'cost_contract_id' && txns.some(t => t.kind !== 'expense')) {
      await rollbackQuietly(conn)
      return res.status(400).json({ error: '원가 귀속은 지출 거래에만 붙일 수 있어요' })
    }
    /* 마감된 달의 거래는 못 건드린다 — 거래 수정(PUT)과 같은 규칙이다.
       금액이 안 바뀌어도 주문 귀속이 바뀌면 그 달 원가·손익 보고가 달라진다.
       하나라도 걸리면 전부 멈춘다 — 일부만 옮기면 어디까지 됐는지 되짚어야 한다. */
    for (const t of txns) {
      const ce = await closedPeriodError(conn, t.date)
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: `${t.date} 거래: ${ce}` }) }
    }
    await conn.execute(`UPDATE transactions SET ${col} = ? WHERE id IN (${ph})`, [contractId, ...ids])
    await conn.commit()
    res.json({ ok: true, count: ids.length, linked: !!contractId })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

module.exports = router
