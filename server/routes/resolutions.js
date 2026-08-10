const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { rollbackQuietly } = require('../lib/tx')
const { vatFields } = require('../lib/vat')
const { ledgerError } = require('../lib/ledger')
const { settleAcctCode } = require('../lib/acctCode')
const { insertWithDocNo } = require('../lib/docno')
const { withTx, httpError } = require('../lib/withTx')

const router = Router()

const parseItems = (v) => { try { return v ? JSON.parse(v) : [] } catch { return [] } }
const parseJson = (v, fb) => { try { return v ? JSON.parse(v) : fb } catch { return fb } }
const adapt = (r) => ({ ...r, amount: Number(r.amount), items: parseItems(r.items), approval: parseJson(r.approval, []) })

/**
 * 청구서 1건 → 결의서 품목 줄.
 *
 * 결의서는 **지급액(VAT 포함)** 을 결재받는 문서다. 그래서 줄 합계가 청구서 total 과
 * 같아야 한다 — 품목은 공급가(수량×단가)라 부가세를 한 줄 더 얹는다.
 * 품목 내역이 없는 청구서는 예전처럼 지급액 한 줄로 뭉친다.
 *
 * 만들 때와 다시 불러올 때가 **같은 함수를 쓴다.** 규칙을 두 군데 두면 한쪽만 고쳐져
 * "새로 만든 결의서와 불러온 결의서의 합계가 다른" 일이 생긴다.
 *
 * 품명과 규격은 한 칸에 합친다 — 양식의 칸이 '품명 및 규격' 하나이고,
 * 구매품의서·견적요청서도 같은 방식으로 채운다(`품명 규격`).
 */
function itemsFromInvoice(inv, lines, fallbackTitle) {
  if (!lines.length) {
    const gross = Number(inv.total_amount) || 0
    return [{ name: fallbackTitle, unit: '식', qty: 1, price: gross, amount: gross, note: inv.invoice_no || '' }]
  }
  const items = lines.map(l => ({
    name: [l.name, l.spec].filter(Boolean).join(' '),
    unit: l.unit || '', qty: Number(l.qty) || 0, price: Number(l.unit_price) || 0,
    amount: Number(l.amount) || 0, note: '',
  }))
  const vat = Number(inv.vat_amount) || 0
  if (vat > 0) items.push({ name: '부가세', unit: '', qty: 1, price: vat, amount: vat, note: inv.invoice_no || '' })
  return items
}

// 기본 결재선 프리셋의 단계를 새 결의서에 스냅샷으로 복사 (없으면 담당/결재/대표)
const defaultApproval = async (execFn) => {
  const [[p]] = await execFn('SELECT steps FROM approval_presets WHERE is_default=1 ORDER BY sort_order LIMIT 1')
  const steps = parseJson(p && p.steps, null)
  if (steps && steps.length) return steps.map(s => ({ label: s.label || '', position: s.position || '', name: '' }))
  return [{ label: '담당', position: '', name: '' }, { label: '결재', position: '', name: '' }, { label: '대표이사', position: '', name: '' }]
}

// 문서번호 채번 DJ-YYYY-NNNN (최대 일련번호 +1, 삭제해도 재사용 안 함)
//
// ⚠ FOR UPDATE 가 반드시 필요하다.
// 트랜잭션(REPEATABLE READ) 안에서 그냥 SELECT 하면 스냅샷을 읽으므로, 다른 트랜잭션이
// 방금 커밋한 번호가 보이지 않는다. 그래서 충돌 후 다시 뽑아도 **같은 번호**가 나와
// 재시도가 무의미했다(실제로 6건 동시 생성 시 4건이 실패). FOR UPDATE 는 최신 커밋을
// 읽고 그 구간을 잠가, 동시에 채번하는 트랜잭션을 줄 세운다.
const nextDocNo = async (execFn, dateStr) => {
  const year = (dateStr || kstToday()).slice(0, 4)
  const [[{ maxno }]] = await execFn(
    `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(doc_no, '-', -1) AS UNSIGNED)), 0) AS maxno
     FROM expense_resolutions WHERE doc_no LIKE ? FOR UPDATE`, [`DJ-${year}-%`])
  return `DJ-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
}

// 목록 (최신순)
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT er.*, v.name AS vendor_name2 FROM expense_resolutions er
       LEFT JOIN vendors v ON er.vendor_id = v.id ORDER BY er.created_at DESC`)
    res.json(rows.map(adapt))
  } catch (e) { next(e) }
})

// 특정 지출 거래에 연결된 결의서 (증빙 영역에서 열람용). 없으면 null.
router.get('/by-txn/:txnId', async (req, res, next) => {
  try {
    const [[r]] = await req.db.execute('SELECT * FROM expense_resolutions WHERE txn_id = ?', [req.params.txnId])
    res.json(r ? adapt(r) : null)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [[r]] = await req.db.execute('SELECT * FROM expense_resolutions WHERE id = ?', [req.params.id])
    if (!r) return res.status(404).json({ error: 'Not found' })
    res.json(adapt(r))
  } catch (e) { next(e) }
})

// 직접 등록 — 청구서 없는 소액 경비(비누·간식 등)를 결의서부터 작성해 결재받는 경우.
// 거래·청구서 연결 없이 사람이 지출처·품목·금액을 입력한다.
router.post('/', async (req, res, next) => {
  try {
    const { vendor_id, vendor_name, title, items, pay_method, pay_date, applicant, note } = req.body
    const itemList = Array.isArray(items) && items.length ? items
      : [{ name: title || '지출', unit: '식', qty: 1, price: Number(req.body.amount) || 0, amount: Number(req.body.amount) || 0, note: '' }]
    const amount = itemList.reduce((s, it) => s + (Number(it.amount) || 0), 0)
    const id = randomUUID()
    // 결재선: 요청에 있으면 그걸 쓰고(만들 때 고른 프리셋), 없으면 기본 프리셋
    const approval = Array.isArray(req.body.approval) && req.body.approval.length
      ? req.body.approval
      : await defaultApproval((sql, p) => req.db.execute(sql, p))
    await insertWithDocNo(
      () => nextDocNo((sql, p) => req.db.execute(sql, p), pay_date),
      (doc_no) => req.db.execute(
        `INSERT INTO expense_resolutions (id, doc_no, vendor_id, vendor_name, title, amount, pay_method, pay_date, applicant, items, note, approval, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, doc_no, vendor_id || null, vendor_name || '', title || '지출 결의', amount,
         pay_method || '계좌이체', pay_date || null,
         applicant || req.user?.name || req.user?.username || '관리자',
         JSON.stringify(itemList), note || '', JSON.stringify(approval), '작성']))
    const [[created]] = await req.db.execute('SELECT * FROM expense_resolutions WHERE id = ?', [id])
    res.json(adapt(created))
  } catch (e) { next(e) }
})

// 매입 청구서 1건 → 결의서 생성(있으면 그대로 반환). 지급 전 결재용.
// 거래(txn_id)는 아직 없을 수 있다 — 나중에 지급 매칭되면 그 거래와 연결(선택).
// 동시 생성이 많은 경로라 교착(deadlock)이 실제로 난다. 교착은 트랜잭션 전체가
// 롤백되므로 문 단위 재시도로는 못 살린다 → withTx 로 begin 부터 다시 시도한다.
router.post('/from-invoice/:invoiceId', async (req, res, next) => {
  try {
    const out = await withTx(req.db, async (conn) => {
    const [[existing]] = await conn.execute('SELECT * FROM expense_resolutions WHERE invoice_id = ?', [req.params.invoiceId])
    if (existing) return { ...adapt(existing), reused: true }

    const [[inv]] = await conn.execute(
      `SELECT i.*, v.name AS vendor_name, c.name AS contract_name FROM invoices i
       LEFT JOIN vendors v ON i.vendor_id = v.id
       LEFT JOIN contracts c ON i.contract_id = c.id
       WHERE i.id = ? FOR UPDATE`, [req.params.invoiceId])
    if (!inv) throw httpError(404, '청구서를 찾을 수 없어요')
    if (inv.kind !== 'received') throw httpError(400, '매입(수취) 청구서만 지급결의서를 만들 수 있어요')


    const title = inv.contract_name || inv.memo || '매입 대금 지급'
    const [lines] = await conn.execute('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order, name', [inv.id])
    const items = itemsFromInvoice(inv, lines, title)

    const approval = await defaultApproval((sql, p) => conn.execute(sql, p))
    const id = randomUUID()
    // 동시에 두 명이 만들면 같은 doc_no 를 뽑는다 → 충돌 시 번호를 다시 뽑아 재시도
    await insertWithDocNo(
      () => nextDocNo((sql, p) => conn.execute(sql, p), inv.issued_at),
      (doc_no) => conn.execute(
        `INSERT INTO expense_resolutions (id, doc_no, invoice_id, vendor_id, vendor_name, title, amount, pay_method, pay_date, applicant, items, note, approval, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, doc_no, inv.id, inv.vendor_id || null, inv.vendor_name || '', title,
         Number(inv.total_amount), '계좌이체', inv.due_at || null,
         req.user?.name || req.user?.username || '관리자',
         JSON.stringify(items), '', JSON.stringify(approval), '작성']))
    // 커밋 전 같은 커넥션으로 재조회. req.db 를 쓰면 conn 을 쥔 채 두 번째 커넥션을
    // 요구하게 되는데, 테넌트 풀은 작아서(기본 3) 동시 요청 시 고갈된다.
    const [[created]] = await conn.execute('SELECT * FROM expense_resolutions WHERE id = ?', [id])
    return adapt(created)
    })
    res.json(out)
  } catch (e) { next(e) }
})

// 처리 후보 지출 거래 — 이 결의서와 연결할 만한 미연결 지출.
// 거래처가 같으면 위로, 금액이 비슷하면 위로. 이미 결의서가 붙은 거래는 제외.
router.get('/:id/matchable', async (req, res, next) => {
  try {
    const [[r]] = await req.db.execute('SELECT * FROM expense_resolutions WHERE id = ?', [req.params.id])
    if (!r) return res.status(404).json({ error: 'Not found' })
    const [rows] = await req.db.execute(
      `SELECT t.id, t.date, t.amount, t.category, t.status, t.account_id, v.name AS vendor_name
       FROM transactions t LEFT JOIN vendors v ON t.vendor_id = v.id
       WHERE t.kind='expense'
         AND t.id NOT IN (SELECT txn_id FROM expense_resolutions WHERE txn_id IS NOT NULL)
       ORDER BY (t.vendor_id <=> ?) DESC, ABS(t.amount - ?) ASC, t.date DESC
       LIMIT 20`,
      [r.vendor_id || null, Number(r.amount) || 0])
    res.json(rows.map(t => ({ ...t, amount: Number(t.amount), related: r.vendor_id && t.vendor_name === r.vendor_name })))
  } catch (e) { next(e) }
})

// 결의서 처리 — 이 결의서대로 지출을 집행한다. 처리되면 status='완료'로 목록(할 일 큐)에서 빠진다.
//   mode='link'   : 이미 등록된 지출 거래에 연결
//   mode='create' : 결의서 내용으로 지출 거래를 새로 생성(금액은 body.amount로 덮어쓸 수 있음)
// 어느 쪽이든 지출 doc_no에 결의서번호를 역참조해, 그 지출의 증빙에서 결의서를 찾을 수 있게 한다.
router.post('/:id/process', async (req, res, next) => {
  const { mode, txn_id, amount, date, account_id } = req.body
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[r]] = await conn.execute('SELECT * FROM expense_resolutions WHERE id = ? FOR UPDATE', [req.params.id])
    if (!r) { await rollbackQuietly(conn); return res.status(404).json({ error: '결의서를 찾을 수 없어요' }) }
    if (r.status === '완료') { await rollbackQuietly(conn); return res.status(409).json({ error: '이미 처리된 결의서예요' }) }

    /* 마감 검사 — body의 date 하나만 보면 두 갈래로 우회된다.
     *   · create: 실제 거래일은 `date || r.pay_date || today`인데 date만 검사했다 →
     *     date를 비우면 마감월 pay_date로 지출이 들어갔다.
     *   · link:   화면(Docs.jsx)이 link 모드에서 date를 아예 보내지 않는다 →
     *     closedPeriodError(undefined)가 즉시 null이라 **항상 무검사**였다.
     * 그래서 '실제로 쓰일 날짜'를 모두 모아서 검사한다(연결 대상 거래의 날짜까지). */
    let linkTxnDate = null
    if (mode === 'link' && txn_id) {
      const [[lt]] = await conn.execute('SELECT date FROM transactions WHERE id = ?', [txn_id])
      linkTxnDate = lt?.date || null
    }
    {
      const effDateForCheck = mode === 'link' ? linkTxnDate : (date || r.pay_date || kstToday())
      const ce = await closedPeriodError(conn, effDateForCheck)
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
    }

    // 매입 청구서 연결 결의서인데 그 청구서가 이미 완납이면, 새 지출을 만들어봐야 매칭할 잔액이 없어
    // 지출만 붕 뜬다(이중 계상). 처리 자체를 막는다.
    // 겸사겸사 청구서의 출금 계좌와 계약을 받아둔다 — 아래에서 지출 거래에 승계한다.
    let invAccountId = null
    let invContractId = null
    if (r.invoice_id) {
      const [[inv]] = await conn.execute('SELECT total_amount, account_id, contract_id FROM invoices WHERE id = ?', [r.invoice_id])
      if (inv) {
        invAccountId = inv.account_id || null
        invContractId = inv.contract_id || null
        const [[{ paid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [r.invoice_id])
        if (Number(inv.total_amount) - Number(paid) <= 0) {
          await rollbackQuietly(conn); return res.status(409).json({ error: '연결된 청구서가 이미 지급 완료됐어요' })
        }
      }
    }

    // 계좌 잔액은 `kind='expense' AND account_id=? AND status='지급완료'` 인 거래만 차감한다
    // (routes/accounts.js calcBalance). 둘 중 하나라도 어긋나면 통장은 줄었는데 장부 잔액은
    // 그대로 남아 조용히 틀어진다. 아래 두 분기 모두 이 조건을 반드시 만족시킨다.
    let linkedTxnId = null
    if (mode === 'link') {
      if (!txn_id) { await rollbackQuietly(conn); return res.status(400).json({ error: '연결할 지출 거래를 선택해주세요' }) }
      // FOR UPDATE — 같은 거래를 두 결의서가 동시에 집으려 할 때 한쪽을 기다리게 한다.
      const [[t]] = await conn.execute("SELECT id, status, account_id FROM transactions WHERE id = ? AND kind='expense' FOR UPDATE", [txn_id])
      if (!t) { await rollbackQuietly(conn); return res.status(404).json({ error: '지출 거래를 찾을 수 없어요' }) }
      // 이미 다른 결의서가 집행한 지출이면 막는다.
      // 후보 목록(/:id/matchable)이 연결된 거래를 빼주긴 하지만, 그 목록은 드로어를 열 때
      // 한 번만 받아온다. 결의서 A를 처리한 뒤 열어둔 B의 드로어에서 같은 거래를 고르면
      // 한 번 나간 돈으로 두 결의서가 '완료'가 되고, B에 해당하는 지출은 영영 기록되지 않는다.
      const [[dupRes]] = await conn.execute(
        'SELECT id, doc_no FROM expense_resolutions WHERE txn_id = ? AND id <> ? LIMIT 1', [txn_id, req.params.id])
      if (dupRes) {
        await rollbackQuietly(conn)
        return res.status(409).json({
          error: `이 지출은 이미 결의서 ${dupRes.doc_no || ''}에 연결돼 있어요. 다른 지출을 고르거나 '지출 새로 등록'을 쓰세요.`.replace('  ', ' '),
        })
      }
      // 결의서 처리는 '집행'이다. 연결 대상이 아직 미지급이면 지급완료로 바꿔야 잔액에서 빠진다.
      const acct = t.account_id || account_id || invAccountId || null
      const lerrL = ledgerError({ kind: 'expense', account_id: acct, status: '지급완료' })
      if (lerrL) { await rollbackQuietly(conn); return res.status(400).json({ error: lerrL }) }
      linkedTxnId = txn_id
      await conn.execute("UPDATE transactions SET doc_no = ? WHERE id = ? AND (doc_no IS NULL OR doc_no = '' OR doc_no = '공통')", [r.doc_no, txn_id])
      await conn.execute("UPDATE transactions SET status = '지급완료', account_id = ? WHERE id = ?", [acct, txn_id])
    } else if (mode === 'create') {
      // 실효 지출일 = 넘어온 date, 없으면 결의서 지급예정일(pay_date), 그것도 없으면 오늘.
      // date만 검사하면 미래인 pay_date로 집행될 때 미래날짜 차단이 우회되므로 실효 날짜로 막는다.
      const effDate = date || r.pay_date || kstToday()
      if (futureDateError(effDate)) { await rollbackQuietly(conn); return res.status(400).json({ error: '미래 날짜로는 처리할 수 없어요 (오늘까지만 가능)' }) }
      const amt = Number(amount) > 0 ? Number(amount) : Number(r.amount)
      // 계좌가 없으면 만들지 않는다. NULL로 넣으면 지출이 어느 계좌 잔액에서도 빠지지 않아
      // 사용자는 돈이 나간 줄 모른 채 잔액을 과대 계상하게 된다(과거 F-02와 동일 유형).
      const acct = account_id || invAccountId || null
      const lerrC = ledgerError({ kind: 'expense', account_id: acct, status: '지급완료' })
      if (lerrC) { await rollbackQuietly(conn); return res.status(400).json({ error: lerrC }) }
      const id = randomUUID()
      // contract_id 를 청구서에서 승계한다. 안 넣으면 그 매입계약의 지급 내역·원가 실적에서
      // 통째로 빠져, 같은 청구서를 결의서 없이 바로 '지급 처리'했을 때와 숫자가 달라진다.
      /* 부가세 필드를 채운다. 예전엔 INSERT 목록에 없어 전부 NULL 이었고,
       * 부가세 집계(routes/tax.js)가 `vat_amount IS NOT NULL` 만 세므로
       * **청구서 없는 소액경비 결의서의 매입세액이 신고 자료에서 통째로 빠졌다.**
       * (매입 청구서에서 발행한 결의서는 아래에서 invoice_id 가 붙어 청구서 쪽으로 집계된다) */
      const vat = vatFields({ amount: amt, tax_type: r.tax_type, vat_deductible: r.vat_deductible })
      await conn.execute(
        /* 매입 청구서에서 발행한 결의서면 이 지출은 **청구서 정산**이다 —
         * 매입은 청구서 수취 시점에 이미 인식됐고, 지금은 그때 생긴 외상매입금이 사라지는 것.
         * 계정과목을 안 넣으면 일계표에서 상대 계정이 비어 차·대변이 안 맞는다
         * (실데이터 검수에서 8,580,000원 지출이 그대로 불일치로 떴다).
         *
         * 청구서 없는 소액경비 결의서(r.invoice_id 없음)는 실제 비용 발생이라 계정과목이
         * 비목마다 다른데, 지금 구조에는 비목→계정과목 매핑이 없다 → null 로 두고
         * 일계표가 '계정과목 없음' 목록으로 알려주게 한다(그건 설계대로다).
         * 근본 해결은 비목 기준정보에 계정과목 칸을 붙이는 것 — 별도 과제. */
        `INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, account_code, category, amount, date, method, status, doc_no, memo,
                                   supply_amount, vat_amount, tax_type, vat_deductible)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, 'expense', r.vendor_id || null, invContractId, acct,
         r.invoice_id ? settleAcctCode('expense') : null,
         /* 비목(category)은 기준정보의 분류값이어야 한다. 결의서 제목(r.title)을 그대로
          * 넣던 탓에 '5축 가공 외주 단가계약'·'AL7075 판재 7월분' 같은 자유 텍스트가
          * 비목 칸에 들어갔다 — 그런 비목은 기준정보에 없으므로 비목별 집계가 오염된다.
          * 청구서 기반 결의서는 청구서 정산과 같은 성격이므로 같은 값('대금 지급')을 쓴다.
          * 청구서 없는 소액경비는 고를 비목이 없어 제목을 그대로 두되, 결의서에 비목 칸을
          * 붙이는 것이 근본 해결이다(비목→계정과목 매핑과 같은 과제). */
         r.invoice_id ? '대금 지급' : (r.title || '지출'), amt,
         effDate, r.pay_method || '계좌이체',
         '지급완료', r.doc_no, `결의서 ${r.doc_no} 집행`,
         vat.supply_amount, vat.vat_amount, vat.tax_type, vat.vat_deductible])
      linkedTxnId = id
    } else {
      await rollbackQuietly(conn); return res.status(400).json({ error: "mode는 'link' 또는 'create'여야 해요" })
    }

    // 매입 청구서에서 발행한 결의서면, 처리한 지출을 그 청구서에 지급 매칭한다.
    // (안 하면 결의서·지출은 처리됐는데 청구서는 '지급 예정'으로 남는다)
    let invoicePaid = false
    if (r.invoice_id) {
      const [[inv]] = await conn.execute('SELECT * FROM invoices WHERE id = ? FOR UPDATE', [r.invoice_id])
      if (inv) {
        const [[{ paid: prevPaid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [r.invoice_id])
        const remainBefore = Number(inv.total_amount) - Number(prevPaid)
        // 이 지출이 이미 다른 청구서에 매칭돼 있으면 재매칭 금지(이중 계상 방지)
        const [[dupMatch]] = await conn.execute('SELECT invoice_id FROM invoice_matches WHERE txn_id = ? LIMIT 1', [linkedTxnId])
        if (dupMatch) { await rollbackQuietly(conn); return res.status(409).json({ error: '이미 다른 청구서에 매칭된 지출이에요' }) }
        if (remainBefore > 0) {
          const [[txnRow]] = await conn.execute('SELECT amount FROM transactions WHERE id = ?', [linkedTxnId])
          const matchAmount = Math.min(Number(txnRow.amount) || 0, remainBefore)
          await conn.execute('UPDATE transactions SET invoice_id = ? WHERE id = ?', [r.invoice_id, linkedTxnId])
          await conn.execute('INSERT INTO invoice_matches (id, invoice_id, txn_id, amount) VALUES (?,?,?,?)', [randomUUID(), r.invoice_id, linkedTxnId, matchAmount])
          const [[{ paid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [r.invoice_id])
          const status = Number(paid) >= Number(inv.total_amount) ? '지급 완료' : '일부 지급'
          await conn.execute('UPDATE invoices SET status = ? WHERE id = ?', [status, r.invoice_id])
          await conn.execute('UPDATE milestones SET status = ? WHERE invoice_id = ?', [status, r.invoice_id])
          invoicePaid = true
        }
      }
    }

    await conn.execute("UPDATE expense_resolutions SET status='완료', txn_id=? WHERE id=?", [linkedTxnId, req.params.id])
    await conn.commit()
    res.json({ ok: true, txn_id: linkedTxnId, invoicePaid })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// 결의서 내용 수정 (품목 명세·특기사항·헤더 보완)
router.put('/:id', async (req, res, next) => {
  try {
    const { title, amount, pay_method, pay_date, applicant, items, note, status, vendor_name, approval } = req.body
    const [[cur]] = await req.db.execute('SELECT status, amount FROM expense_resolutions WHERE id = ?', [req.params.id])
    if (!cur) return res.status(404).json({ error: 'Not found' })

    // 이미 집행된 결의서는 금액·상태를 바꿀 수 없다.
    //  · status 를 안 보내면 '작성'으로 떨어져(기존 `status || '작성'`) 처리 가드를 통과,
    //    같은 결의서를 두 번 집행할 수 있었다 — 한 번 나간 돈으로 지출이 두 건 생긴다.
    //  · 금액을 바꾸면 이미 만들어진 지출 거래와 어긋나 장부가 틀어진다.
    // 적요·결재선 같은 문서 정보는 집행 후에도 고칠 수 있게 둔다.
    const done = cur.status === '완료'
    if (done && Number(amount) !== Number(cur.amount)) {
      return res.status(409).json({ error: '이미 처리된 결의서의 금액은 바꿀 수 없어요. 연결된 지출 거래와 어긋나요.' })
    }
    const nextStatus = done ? '완료' : (status || '작성')

    const [r] = await req.db.execute(
      `UPDATE expense_resolutions SET title=?, amount=?, pay_method=?, pay_date=?, applicant=?, items=?, note=?, status=?, vendor_name=?, approval=?
       WHERE id=?`,
      [title || '', Number(amount) || 0, pay_method || '', pay_date || null, applicant || '',
       JSON.stringify(items || []), note || '', nextStatus, vendor_name || '',
       JSON.stringify(approval || []), req.params.id])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/**
 * 연결된 청구서의 품목을 **다시 불러온다.**
 *
 * 만들 때 한 번 복사하고 끝이라, 청구서에 품목을 나중에 채워도 결의서는 옛 모습
 * ("매입 대금 지급 · 식 · 1") 그대로였다. 청구서 품목 입력이 생기기 전에 만든
 * 결의서가 전부 그렇다.
 *
 * 이미 집행된(완료) 결의서는 막는다 — 품목을 갈아끼우면 이미 나간 지출 거래와
 * 문서가 다른 말을 하게 된다. 금액이 같더라도 마찬가지다.
 */
router.post('/:id/reload-lines', async (req, res, next) => {
  try {
    const out = await withTx(req.db, async (conn) => {
      const [[cur]] = await conn.execute('SELECT * FROM expense_resolutions WHERE id = ? FOR UPDATE', [req.params.id])
      if (!cur) throw httpError(404, '결의서를 찾을 수 없어요')
      if (cur.status === '완료') throw httpError(409, '이미 처리된 결의서는 품목을 바꿀 수 없어요. 연결된 지출 거래와 어긋나요.')
      if (!cur.invoice_id) throw httpError(400, '청구서에서 만든 결의서가 아니에요. 품목을 직접 입력해주세요.')

      const [[inv]] = await conn.execute(
        `SELECT i.*, c.name AS contract_name FROM invoices i
         LEFT JOIN contracts c ON i.contract_id = c.id WHERE i.id = ?`, [cur.invoice_id])
      if (!inv) throw httpError(404, '연결된 청구서가 없어요(지워졌을 수 있어요)')

      const [lines] = await conn.execute(
        'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order, name', [inv.id])
      if (!lines.length) {
        throw httpError(400, `청구서 ${inv.invoice_no || ''}에 품목 내역이 없어요. 청구서를 열어 품목을 넣고 다시 불러오세요.`.trim())
      }
      const items = itemsFromInvoice(inv, lines, cur.title || '매입 대금 지급')
      /* 금액도 청구서 지급액으로 다시 맞춘다. 품목 합(공급가+부가세)이 곧 지급액이라
         따로 두면 표의 합계와 헤더의 '지출총액'이 어긋난다. */
      const amount = Number(inv.total_amount) || 0
      await conn.execute('UPDATE expense_resolutions SET items = ?, amount = ? WHERE id = ?',
        [JSON.stringify(items), amount, cur.id])
      const [[updated]] = await conn.execute('SELECT * FROM expense_resolutions WHERE id = ?', [cur.id])
      return { ...adapt(updated), lineCount: lines.length, invoiceNo: inv.invoice_no }
    })
    res.json(out)
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM expense_resolutions WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
