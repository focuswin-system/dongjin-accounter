/**
 * 자금일보 — "지금 돈이 어디 얼마 있고, 앞으로 언제 들어오고 나가는가".
 *
 * ── 일계표와 다른 문서다 ──
 *   일계표   그날 거래를 계정과목별 차변/대변으로 집계한다. 경리가 분개를 맞추는 문서.
 *   자금일보 계좌별 잔액과 들어올·나갈 돈. 대표가 "언제 돈이 마르나"를 보는 문서.
 * 중소기업이 무너지는 건 대개 적자가 아니라 **흑자도산**이다 — 손익은 흑자인데 미수금이
 * 안 들어와 급여일에 현금이 없는 것. 그걸 미리 보는 게 이 문서의 존재 이유다.
 *
 * ── 잔액 산식은 routes/accounts.js 와 반드시 같아야 한다 ──
 * 예전 dashboard.js 는 수입에 status 조건이 없어 '입금 예정'까지 잔액에 넣었다.
 * 그래서 같은 회사 잔액이 화면마다 달랐다. 여기서는 accounts.js 와 똑같이
 * **완료된 것만** 센다(SETTLED_INCOME / SETTLED_EXPENSE).
 */

const { SETTLED_INCOME, SETTLED_EXPENSE } = require('./ledger')
const { pendingCond } = require('./invoiceStatus')
const { paymentSchedule, unpaidPayments, paidPrincipal } = require('./savings')
const { repaymentSchedule } = require('./loan')

const num = (v) => Number(v) || 0

/**
 * 기준일 시점의 계좌별 잔액.
 *
 * `asOf` 를 주면 그 날짜까지의 거래만 센다 — 과거 어느 날의 잔액을 되짚을 수 있다.
 * 잔액 조정(account_adjustments)도 같은 기준으로 자른다. 안 자르면 미래의 조정이
 * 과거 잔액에 섞여 "그날 통장에 있던 돈"과 어긋난다.
 */
async function balancesAsOf(db, asOf) {
  const dateCond = asOf ? ' AND date <= ?' : ''
  const p = (base) => (asOf ? [...base, asOf] : base)
  const [rows] = await db.execute(`
    SELECT a.id, a.name, a.bank, a.type, a.kind, a.number, a.purpose, a.acct_code,
           a.initial_balance,
           COALESCE((SELECT SUM(amount) FROM transactions
                      WHERE kind='income'  AND account_id=a.id AND status=?${dateCond}), 0) AS income_total,
           COALESCE((SELECT SUM(amount) FROM transactions
                      WHERE kind='expense' AND account_id=a.id AND status=?${dateCond}), 0) AS expense_total,
           COALESCE((SELECT SUM(amount) FROM account_adjustments
                      WHERE account_id=a.id${dateCond}), 0) AS adj_total
      FROM accounts a
     ORDER BY a.kind, a.name`,
    [...p([SETTLED_INCOME]), ...p([SETTLED_EXPENSE]), ...(asOf ? [asOf] : [])])

  return rows.map(r => ({
    id: r.id, name: r.name, bank: r.bank, type: r.type, kind: r.kind,
    number: r.number, purpose: r.purpose, acct_code: r.acct_code,
    balance: num(r.initial_balance) + num(r.income_total) - num(r.expense_total) + num(r.adj_total),
    income_total: num(r.income_total),
    expense_total: num(r.expense_total),
  }))
}

/**
 * 앞으로 들어올·나갈 돈을 **날짜축 하나로** 모은다.
 *
 * 네 군데에서 나온다. 하나라도 빠지면 "며칠에 잔액이 얼마"가 틀려서 문서 전체가 쓸모없어진다.
 *   1. 미수금  청구서 due_at (아직 정산 안 된 잔액만)
 *   2. 미지급금 청구서 due_at
 *   3. 대출 상환 스케줄 (원금+이자)
 *   4. 적금 납입 스케줄
 * 정기청구·정기지출은 **청구서/거래가 만들어진 뒤** 1·2번으로 잡히므로 여기서 또 세지 않는다
 * (세면 같은 돈이 두 번 계산된다).
 *
 * @returns {{date, kind:'in'|'out', amount, label, source, account_id}[]} 날짜 오름차순
 */
async function upcomingFlows(db, { from, to }) {
  const out = []

  // 1·2. 미수금·미지급금 — 이미 정산된 부분(invoice_matches)은 빼고 남은 잔액만
  for (const kind of ['issued', 'received']) {
    const cond = pendingCond(kind)
    /* 결제기한이 비어 있는 청구서도 **반드시 포함한다.**
     * 예전엔 `due_at IS NOT NULL` 로 걸러냈는데, 그러면 같은 화면의 '나갈 돈' KPI(전체 합계)와
     * 예측이 어긋난다. 기한 없는 미지급 1억이 있으면 KPI는 1억인데 최저 예상 잔액은 0원 나간
     * 것처럼 계산된다 — 이 문서의 결론이 **낙관 쪽으로 틀린다.**
     * 기한을 모르는 돈은 '언제 나갈지 모르니 지금 있는 것으로' 보는 편이 안전하다. */
    const [rows] = await db.execute(`
      SELECT i.id, i.invoice_no, i.due_at, i.total_amount, i.account_id, v.name AS vendor_name,
             COALESCE((SELECT SUM(amount) FROM invoice_matches WHERE invoice_id = i.id), 0) AS matched
        FROM invoices i
        LEFT JOIN vendors v ON v.id = i.vendor_id
       WHERE i.kind = ? AND ${cond.sql}
       ORDER BY i.due_at`, [kind, ...cond.params])
    for (const r of rows) {
      const remain = num(r.total_amount) - num(r.matched)
      if (remain <= 0) continue
      const due = r.due_at || ''
      const noDue = !due
      // 기한이 이미 지난 것도 넣는다 — '오늘까지 들어왔어야 할 돈'이라 예측에 그대로 영향을 준다.
      // 기한 이전·미정인 것은 기준일에 몰아 표시한다(언제일지 모르니 가장 앞에 세운다).
      const date = (noDue || due < from) ? from : due
      if (date > to) continue
      out.push({
        date, kind: kind === 'issued' ? 'in' : 'out', amount: remain,
        label: `${r.vendor_name || '거래처'} ${r.invoice_no || ''}`.trim(),
        source: kind === 'issued' ? '미수금' : '미지급금',
        account_id: r.account_id || null,
        overdue: !noDue && due < from,
        noDue,                       // 화면에서 '기한 미정'으로 표시한다
      })
    }
  }

  // 3. 대출 상환 — 아직 처리하지 않은 회차만
  const [loans] = await db.execute("SELECT * FROM loans WHERE status='active'")
  for (const l of loans) {
    const [paid] = await db.execute('SELECT seq FROM loan_repayments WHERE loan_id = ?', [l.id])
    const done = new Set(paid.map(p => Number(p.seq)))
    for (const c of repaymentSchedule(l)) {
      if (done.has(c.seq)) continue
      const date = c.due_date < from ? from : c.due_date
      if (date > to || c.total <= 0) continue
      out.push({
        date, kind: 'out', amount: c.total,
        label: `${l.name} ${c.seq}회차`, source: '대출 상환',
        account_id: l.account_id || null, overdue: c.due_date < from,
      })
    }
  }

  // 4. 적금 납입 — 아직 안 낸 회차만
  const [savings] = await db.execute("SELECT * FROM savings WHERE status='active' AND kind='installment'")
  for (const s of savings) {
    const [paid] = await db.execute(
      'SELECT seq FROM savings_payments WHERE savings_id = ? AND paid_date IS NOT NULL', [s.id])
    for (const c of unpaidPayments(s, paid.map(p => p.seq))) {
      const date = c.due_date < from ? from : c.due_date
      if (date > to || c.amount <= 0) continue
      out.push({
        date, kind: 'out', amount: c.amount,
        label: `${s.name} ${c.seq}회차`, source: '적금 납입',
        account_id: s.account_id || null, overdue: c.due_date < from,
      })
    }
  }

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return out
}

/**
 * 날짜별로 접어 잔액 추이를 만든다.
 * **최저 잔액과 그 날짜**가 이 문서의 결론이다 — "며칠에 얼마까지 떨어지나".
 */
function project(startBalance, flows, { from, to }) {
  const byDate = new Map()
  for (const f of flows) {
    if (!byDate.has(f.date)) byDate.set(f.date, { date: f.date, in: 0, out: 0, items: [] })
    const d = byDate.get(f.date)
    d[f.kind] += f.amount
    d.items.push(f)
  }
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
  let bal = startBalance
  let low = { date: from, balance: startBalance }
  for (const d of days) {
    bal = bal + d.in - d.out
    d.balance = bal
    d.net = d.in - d.out
    if (bal < low.balance) low = { date: d.date, balance: bal }
  }
  return {
    days,
    endBalance: bal,
    lowest: low,
    totalIn: days.reduce((a, d) => a + d.in, 0),
    totalOut: days.reduce((a, d) => a + d.out, 0),
    range: { from, to },
  }
}

/**
 * 일계표 — 그날 거래를 **복식으로 전개**해 계정과목별 차변/대변으로 집계한다.
 *
 * 이 앱의 거래는 겉보기엔 단식(income/expense)이지만 실은 복식 한 쌍을 담고 있다.
 *   입금: 차변 = 계좌 계정과목(보통예금)   / 대변 = 거래 계정과목(매출 등)
 *   지출: 차변 = 거래 계정과목(외주비 등)  / 대변 = 계좌 계정과목
 * 그래서 **차변 합계와 대변 합계는 반드시 같다**. 다르면 계좌나 계정과목이 빠진 거래가 있다는
 * 뜻이라, 그 사실을 그대로 보여준다(조용히 맞추면 틀린 장부를 맞는 것처럼 보이게 만든다).
 */
async function dailyTrial(db, date) {
  const [rows] = await db.execute(`
    SELECT t.id, t.kind, t.amount, t.account_code, t.category, t.memo,
           a.acct_code AS bank_code, a.name AS account_name
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.date = ? AND t.status IN (?, ?)`,
    [date, SETTLED_INCOME, SETTLED_EXPENSE])

  // 계정과목 이름표 — 코드만 보여주면 사람이 못 읽는다
  const [subjects] = await db.execute(
    'SELECT code, name, acct_type, category FROM account_subjects WHERE code IS NOT NULL')
  const nameOf = new Map(subjects.map(s => [String(s.code), s]))

  const acc = new Map()   // code → { code, name, acct_type, debit, credit }
  const bump = (code, side, amount) => {
    if (!code) return false
    const key = String(code)
    if (!acc.has(key)) {
      const s = nameOf.get(key)
      acc.set(key, {
        code: key, name: s?.name || key, acct_type: s?.acct_type || '',
        category: s?.category || '', debit: 0, credit: 0,
      })
    }
    acc.get(key)[side] += amount
    return true
  }

  const unbalanced = []   // 한쪽 계정과목이 비어 짝이 안 맞는 거래
  for (const t of rows) {
    const amount = num(t.amount)
    if (amount <= 0) continue
    // 입금이면 돈이 계좌로 들어오므로 계좌가 차변, 지출이면 계좌가 대변
    const bankSide = t.kind === 'income' ? 'debit' : 'credit'
    const itemSide = t.kind === 'income' ? 'credit' : 'debit'
    const okBank = bump(t.bank_code, bankSide, amount)
    const okItem = bump(t.account_code, itemSide, amount)
    if (!okBank || !okItem) {
      unbalanced.push({
        id: t.id, amount, kind: t.kind,
        category: t.category || t.memo || '',
        missing: !okBank ? '계좌 계정과목' : '거래 계정과목',
        account_name: t.account_name || null,
      })
    }
  }

  const lines = [...acc.values()].sort((a, b) => (a.code < b.code ? -1 : 1))
  const debitTotal = lines.reduce((s, l) => s + l.debit, 0)
  const creditTotal = lines.reduce((s, l) => s + l.credit, 0)
  return {
    date, lines,
    debitTotal, creditTotal,
    /* 합계가 같은 것만으로는 '맞다'고 할 수 없다.
     * 한쪽 다리가 빠진 거래 둘의 금액이 같으면(입금 100만 계좌 미지정 + 지출 100만 계정과목 없음)
     * 차변합 = 대변합 이 된다. 그날은 결함 거래가 있는데도 화면이 "일치"라고 단언하고
     * 고칠 목록도 안 보여줬다. 짝 잃은 거래가 없어야 비로소 맞는 것이다. */
    balanced: debitTotal === creditTotal && unbalanced.length === 0,
    totalsMatch: debitTotal === creditTotal,
    txnCount: rows.length,
    // 짝이 안 맞는 거래를 숨기지 않는다 — 합계가 안 맞는 이유가 여기 있다
    unbalanced,
  }
}

module.exports = { balancesAsOf, upcomingFlows, project, dailyTrial }
