const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError } = require('../lib/ledger')
const {
  KINDS, paymentSchedule, unpaidPayments, paidPrincipal, maturitySummary, maturityDateOf,
} = require('../lib/savings')

const router = Router()

/* 예금·적금 — 자금 '운용'. 차입금(자금 조달)의 거울상이라 구조를 일부러 맞췄다.
 *
 * 최우선 규칙: **납입은 비용이 아니다.** 돈이 계좌에서 나가지만 회사 재산은 그대로다
 * (보통예금이 줄고 금융상품이 는다). 계정과목을 자산(1201·1501)으로 붙이면
 * lib/pnl.js 가 손익 집계에서 알아서 빼준다. 비용 계정으로 붙이면 손익이 그만큼 틀어진다.
 *
 * 만기 수령은 **원금과 이자를 나눈다** — 원금은 자산 회수(손익 아님), 이자는 수익(손익).
 * 한 건으로 뭉치면 원금까지 수익이 되어 매출이 부풀려진다(대출 상환과 정확히 같은 이유).
 *
 * ⚠ 멀티테넌트 — 전역 풀 금지. req.db 로만 질의하고 헬퍼에는 db를 인자로 넘긴다.
 */

// 기본 계정과목 — 화면에서 고르지 않았을 때. 표준 계정과목 시딩에 이미 있는 코드다.
const ACCT = {
  shortTerm: '1201',   // 단기금융상품 (1년 이내)
  longTerm:  '1501',   // 장기금융상품 (1년 초과)
  interest:  'INC-204',// 이자수익
}

const intOf = (v) => parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10) || 0
const numOf = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0 }

/** 기간이 1년을 넘으면 장기금융상품 — 회계 분류가 갈린다 */
const defaultAcctCode = (termMonths) => (Number(termMonths) > 12 ? ACCT.longTerm : ACCT.shortTerm)

/** 예적금 1건 + 납입 실적 + 스케줄 + 만기 요약 */
async function savingsDetail(db, s) {
  const [payments] = await db.execute(
    'SELECT * FROM savings_payments WHERE savings_id = ? ORDER BY seq', [s.id])
  const paid = payments.filter(p => p.paid_date)
  const schedule = paymentSchedule(s)
  const unpaid = unpaidPayments(s, paid.map(p => p.seq))
  const today = kstToday()
  return {
    ...s,
    schedule,
    payments: paid,
    paid_count: paid.length,
    // 지금까지 실제로 들어간 돈. 자금일보의 '묶인 자금'이 이 값을 쓴다.
    balance: paidPrincipal(s, paid),
    maturity: maturitySummary(s),
    next_payment: unpaid[0] || null,
    // 예정일이 지났는데 아직 안 낸 회차 — 자동이체가 실패했거나 잔액이 모자랐던 경우
    overdue_payments: unpaid.filter(c => c.due_date <= today),
  }
}

// ── 목록 ──────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(`
      SELECT s.*, a.name AS account_name, v.name AS vendor_name
        FROM savings s
        LEFT JOIN accounts a ON a.id = s.account_id
        LEFT JOIN vendors  v ON v.id = s.vendor_id
       ORDER BY s.status, s.start_date DESC`)
    res.json(await Promise.all(rows.map(r => savingsDetail(req.db, r))))
  } catch (e) { next(e) }
})

/**
 * 등록 화면의 만기 미리보기 — 저장하기 전에 이자·만기 수령액을 보여준다.
 * 기본값은 **등록(POST)과 반드시 같아야 한다.** 예전에 여기만 pay_day 기본을 1로 두어
 * 미리보기 첫 납입일이 가입일보다 앞으로 나왔다(7/31 가입인데 첫 납입 7/1).
 */
router.get('/preview', (req, res) => {
  const q = req.query
  const start_date = q.start_date || kstToday()
  res.json(maturitySummary({
    kind: KINDS.includes(q.kind) ? q.kind : 'installment',
    principal: intOf(q.principal),
    monthly_amount: intOf(q.monthly_amount),
    annual_rate: numOf(q.annual_rate),
    term_months: intOf(q.term_months),
    start_date,
    pay_day: intOf(q.pay_day) || Number(String(start_date).slice(8, 10)) || 1,
  }))
})

router.get('/:id', async (req, res, next) => {
  try {
    const [[s]] = await req.db.execute(`
      SELECT s.*, a.name AS account_name, v.name AS vendor_name
        FROM savings s
        LEFT JOIN accounts a ON a.id = s.account_id
        LEFT JOIN vendors  v ON v.id = s.vendor_id
       WHERE s.id = ?`, [req.params.id])
    if (!s) return res.status(404).json({ error: 'Not found' })
    res.json(await savingsDetail(req.db, s))
  } catch (e) { next(e) }
})

/**
 * 가입.
 *
 * 예금은 가입하는 순간 목돈이 계좌에서 빠진다 → recorded=true 면 출금 거래를 만든다.
 * 적금은 가입만으로는 돈이 안 나간다(1회차 납입은 아래 /pay 로 처리) — 대출을 '실행'과
 * '상환'으로 나눈 것과 같은 이유다. 가입과 동시에 첫 회차를 내는 게 보통이라
 * 화면에서 바로 1회차 납입을 안내한다.
 */
router.post('/', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const b = req.body
    const kind = KINDS.includes(b.kind) ? b.kind : 'installment'
    const name = String(b.name || '').trim()
    if (!name) return res.status(400).json({ error: '상품명을 입력해주세요' })
    const start_date = b.start_date
    if (!start_date) return res.status(400).json({ error: '가입일을 입력해주세요' })
    const fe = futureDateError(start_date)
    if (fe) return res.status(400).json({ error: fe })

    const term_months = intOf(b.term_months)
    if (term_months <= 0) return res.status(400).json({ error: '기간(개월)을 1 이상으로 입력해주세요' })
    const principal = kind === 'deposit' ? intOf(b.principal) : 0
    const monthly_amount = kind === 'installment' ? intOf(b.monthly_amount) : 0
    if (kind === 'deposit' && principal <= 0) return res.status(400).json({ error: '예치 금액을 입력해주세요' })
    if (kind === 'installment' && monthly_amount <= 0) return res.status(400).json({ error: '월 납입액을 입력해주세요' })

    const recorded = b.recorded !== false && kind === 'deposit'   // 적금은 가입만으로 출금이 없다
    const account_id = b.account_id || null
    if (recorded) {
      const le = ledgerError({ kind: 'expense', account_id, status: '지급완료' })
      if (le) return res.status(400).json({ error: le })
      const ce = await closedPeriodError(conn, start_date)
      if (ce) return res.status(400).json({ error: ce })
    }

    const id = randomUUID()
    const acct_code = b.acct_code || defaultAcctCode(term_months)
    const pay_day = intOf(b.pay_day) || Number(String(start_date).slice(8, 10)) || 1
    const maturity_date = maturityDateOf({ start_date, term_months })

    await conn.beginTransaction()
    let txn_id = null
    if (recorded) {
      // 예치금은 **자산 이동**이지 비용이 아니다 — 계정과목을 금융상품으로 붙여 손익에서 빠지게 한다
      txn_id = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, doc_no, memo, account_code, savings_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txn_id, 'expense', b.vendor_id || null, account_id, '예금 예치', principal, start_date,
         '계좌이체', '지급완료', '공통', `${name} 가입`, acct_code, id])
    }
    await conn.execute(
      `INSERT INTO savings (id, name, bank, vendor_id, kind, principal, monthly_amount, annual_rate,
                            term_months, start_date, pay_day, maturity_date, account_id, acct_code,
                            acct_code_interest, status, memo, txn_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
      [id, name, b.bank || '', b.vendor_id || null, kind, principal, monthly_amount, numOf(b.annual_rate),
       term_months, start_date, pay_day, maturity_date, account_id, acct_code,
       b.acct_code_interest || ACCT.interest, b.memo || '', txn_id])
    await conn.commit()
    res.json({ id })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body
    const [[cur]] = await req.db.execute('SELECT * FROM savings WHERE id = ?', [req.params.id])
    if (!cur) return res.status(404).json({ error: 'Not found' })
    if (cur.status !== 'active') return res.status(409).json({ error: '이미 만기·해지된 상품은 수정할 수 없어요' })
    // 이미 납입 실적이 있으면 금액·기간을 바꿀 수 없다 — 바꾸면 지난 회차와 어긋난다
    const [[{ cnt }]] = await req.db.execute(
      'SELECT COUNT(*) AS cnt FROM savings_payments WHERE savings_id = ? AND paid_date IS NOT NULL', [req.params.id])
    const term_months = intOf(b.term_months) || cur.term_months
    const monthly_amount = intOf(b.monthly_amount) || cur.monthly_amount
    if (cnt > 0 && (term_months !== cur.term_months || monthly_amount !== Number(cur.monthly_amount))) {
      return res.status(409).json({
        error: `이미 ${cnt}회차를 납입해서 금액·기간은 바꿀 수 없어요. 조건이 달라졌다면 해지 후 새로 등록해주세요.` })
    }
    await req.db.execute(
      `UPDATE savings SET name=?, bank=?, vendor_id=?, annual_rate=?, term_months=?, monthly_amount=?,
              pay_day=?, maturity_date=?, account_id=?, acct_code=?, memo=? WHERE id=?`,
      [String(b.name || cur.name).trim(), b.bank ?? cur.bank, b.vendor_id ?? cur.vendor_id,
       numOf(b.annual_rate), term_months, monthly_amount,
       intOf(b.pay_day) || cur.pay_day,
       maturityDateOf({ start_date: cur.start_date, term_months }),
       b.account_id ?? cur.account_id, b.acct_code || cur.acct_code, b.memo ?? cur.memo, req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    const [[{ cnt }]] = await req.db.execute(
      'SELECT COUNT(*) AS cnt FROM savings_payments WHERE savings_id = ? AND paid_date IS NOT NULL', [req.params.id])
    if (cnt > 0) {
      return res.status(409).json({
        error: `납입 실적 ${cnt}건이 있어 삭제할 수 없어요. 잘못 만든 게 아니라면 해지로 처리해주세요.` })
    }
    const [r] = await req.db.execute('DELETE FROM savings WHERE id = ?', [req.params.id])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/**
 * 회차 납입을 실제로 반영한다 — 건별·일괄이 같은 코드를 쓰게 떼어냈다.
 * 납입액은 **자산 증가**라 손익이 아니다(계정과목을 금융상품으로 붙인다).
 * 호출 전 검사(회차 순서·미래일자·마감·계좌)는 라우트가 한다.
 */
async function applyPayment(conn, s, cycle, { payDate, acct }) {
  const txnId = randomUUID()
  await conn.execute(
    `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, doc_no, memo, account_code, savings_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [txnId, 'expense', s.vendor_id || null, acct, '적금 납입', cycle.amount, payDate,
     '계좌이체', '지급완료', '공통', `${s.name} ${cycle.seq}회차 납입`, s.acct_code || ACCT.shortTerm, s.id])
  await conn.execute(
    `INSERT INTO savings_payments (id, savings_id, seq, due_date, amount, paid_date, txn_id)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE paid_date=VALUES(paid_date), amount=VALUES(amount), txn_id=VALUES(txn_id)`,
    [randomUUID(), s.id, cycle.seq, cycle.due_date, cycle.amount, payDate, txnId])
  return txnId
}

/** 회차 납입(건별) */
router.post('/:id/pay', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    // 잠금 — 같은 회차를 두 번 눌러 이중 출금이 나는 것을 막는다(대출 상환과 같은 이유)
    const [[s]] = await conn.execute('SELECT * FROM savings WHERE id = ? FOR UPDATE', [req.params.id])
    if (!s) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    if (s.status !== 'active') { await rollbackQuietly(conn); return res.status(409).json({ error: '만기·해지된 상품이에요' }) }
    if (s.kind !== 'installment') { await rollbackQuietly(conn); return res.status(400).json({ error: '예금은 납입 회차가 없어요' }) }

    const payDate = req.body.pay_date || kstToday()
    const acct = req.body.account_id || s.account_id
    const le = ledgerError({ kind: 'expense', account_id: acct, status: '지급완료' })
    if (le) { await rollbackQuietly(conn); return res.status(400).json({ error: le }) }
    const fe = futureDateError(payDate)
    if (fe) { await rollbackQuietly(conn); return res.status(400).json({ error: fe }) }
    if (payDate < s.start_date) {
      await rollbackQuietly(conn)
      return res.status(400).json({ error: `납입일이 가입일(${s.start_date})보다 빠를 수 없어요` })
    }
    const ce = await closedPeriodError(conn, payDate)
    if (ce) { await rollbackQuietly(conn); return res.status(400).json({ error: ce }) }

    const [paid] = await conn.execute(
      'SELECT seq FROM savings_payments WHERE savings_id = ? AND paid_date IS NOT NULL', [s.id])
    const unpaid = unpaidPayments(s, paid.map(p => p.seq))
    if (!unpaid.length) { await rollbackQuietly(conn); return res.status(409).json({ error: '남은 회차가 없어요' }) }
    // 순서를 건너뛸 수 없다 — 건너뛰면 누계가 어긋나고 되돌리기 어렵다
    const cycle = req.body.seq ? unpaid.find(c => c.seq === Number(req.body.seq)) : unpaid[0]
    if (!cycle) { await rollbackQuietly(conn); return res.status(400).json({ error: '이미 납입했거나 없는 회차예요' }) }
    if (cycle.seq !== unpaid[0].seq) {
      await rollbackQuietly(conn)
      return res.status(400).json({ error: `${unpaid[0].seq}회차부터 순서대로 처리해주세요` })
    }

    await applyPayment(conn, s, cycle, { payDate, acct })
    await conn.commit()
    res.json({ ok: true, seq: cycle.seq, amount: cycle.amount })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/**
 * 놓친 납입 일괄 처리 — 예정일이 지났는데 처리하지 않은 회차를 순서대로 모두 반영한다.
 * 마감된 달이 하나라도 섞이면 **전체를 거절한다**(대출과 같은 규칙).
 * 순서를 건너뛸 수 없으므로 일부만 처리하면 남은 회차를 영영 못 넣게 된다.
 */
router.post('/:id/pay-missed', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[s]] = await conn.execute('SELECT * FROM savings WHERE id = ? FOR UPDATE', [req.params.id])
    if (!s) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    if (s.kind !== 'installment') { await rollbackQuietly(conn); return res.status(400).json({ error: '예금은 납입 회차가 없어요' }) }
    const acct = req.body.account_id || s.account_id
    const le = ledgerError({ kind: 'expense', account_id: acct, status: '지급완료' })
    if (le) { await rollbackQuietly(conn); return res.status(400).json({ error: le }) }

    const today = kstToday()
    const [paid] = await conn.execute(
      'SELECT seq FROM savings_payments WHERE savings_id = ? AND paid_date IS NOT NULL', [s.id])
    const missed = unpaidPayments(s, paid.map(p => p.seq)).filter(c => c.due_date <= today)
    if (!missed.length) { await rollbackQuietly(conn); return res.json({ ok: true, count: 0 }) }

    for (const c of missed) {
      const ce = await closedPeriodError(conn, c.due_date)
      if (ce) {
        await rollbackQuietly(conn)
        return res.status(400).json({ error: `${c.seq}회차(${c.due_date})가 마감된 달이라 전체를 처리하지 않았어요. ${ce}` })
      }
    }
    for (const c of missed) await applyPayment(conn, s, c, { payDate: c.due_date, acct })
    await conn.commit()
    res.json({ ok: true, count: missed.length, total: missed.reduce((a, c) => a + c.amount, 0) })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/**
 * 만기 수령 — 원금과 이자를 **두 거래로 나눈다**.
 * 원금은 자산 회수(손익 아님), 이자는 이자수익(손익). 한 건으로 뭉치면 원금까지 수익이 되어
 * 매출이 부풀려진다. 대출 상환에서 원금·이자를 나눈 것과 정확히 같은 이유다.
 */
router.post('/:id/mature', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[s]] = await conn.execute('SELECT * FROM savings WHERE id = ? FOR UPDATE', [req.params.id])
    if (!s) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    if (s.status !== 'active') { await rollbackQuietly(conn); return res.status(409).json({ error: '이미 처리된 상품이에요' }) }

    const recvDate = req.body.received_date || kstToday()
    const acct = req.body.account_id || s.account_id
    const le = ledgerError({ kind: 'income', account_id: acct, status: '입금완료' })
    if (le) { await rollbackQuietly(conn); return res.status(400).json({ error: le }) }
    const fe = futureDateError(recvDate)
    if (fe) { await rollbackQuietly(conn); return res.status(400).json({ error: fe }) }
    const ce = await closedPeriodError(conn, recvDate)
    if (ce) { await rollbackQuietly(conn); return res.status(400).json({ error: ce }) }

    const [payRows] = await conn.execute(
      'SELECT * FROM savings_payments WHERE savings_id = ? AND paid_date IS NOT NULL', [s.id])
    // 원금은 **실제로 넣은 만큼**만 돌려받는다. 스케줄 기준으로 잡으면 밀린 회차만큼 부풀려진다.
    const principal = paidPrincipal(s, payRows)
    if (principal <= 0) {
      await rollbackQuietly(conn)
      return res.status(400).json({ error: '납입 실적이 없어요. 먼저 납입을 기록해주세요.' })
    }
    // 이자는 실제 수령액을 받는다(우대금리·중도해지로 예상과 다를 수 있다). 없으면 예상치로 채운다.
    const interest = req.body.interest != null ? intOf(req.body.interest) : maturitySummary(s).interest
    if (interest < 0) { await rollbackQuietly(conn); return res.status(400).json({ error: '이자는 음수일 수 없어요' }) }

    const mkTxn = async (amount, category, acctCode, memo) => {
      if (amount <= 0) return null
      const id = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, doc_no, memo, account_code, savings_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, 'income', s.vendor_id || null, acct, category, amount, recvDate,
         '계좌이체', '입금완료', '공통', memo, acctCode, s.id])
      return id
    }
    // 원금 = 금융상품 회수(자산↔자산, 손익 아님) / 이자 = 이자수익(손익)
    const txnP = await mkTxn(principal, '예적금 만기', s.acct_code || ACCT.shortTerm, `${s.name} 만기 원금`)
    const txnI = await mkTxn(interest, '이자수익', s.acct_code_interest || ACCT.interest, `${s.name} 만기 이자`)

    await conn.execute(
      "UPDATE savings SET status='matured', matured_at=?, txn_maturity_id=?, txn_interest_id=? WHERE id=?",
      [recvDate, txnP, txnI, s.id])
    await conn.commit()
    res.json({ ok: true, principal, interest, total: principal + interest })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

module.exports = router
