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
const { dueDatesToGenerate, addDays, PAYMENT_TERM_DAYS } = require('./recurrence')
const { recurFromSupply } = require('./vat')
const { kstDate } = require('../db')

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
 * 여섯 군데에서 나온다. 하나라도 빠지면 "며칠에 잔액이 얼마"가 틀려서 문서 전체가 쓸모없어진다.
 *   1. 미수금  청구서 due_at (아직 정산 안 된 잔액만)
 *   2. 미지급금 청구서 due_at
 *   3. 대출 상환 — 저장된 예정 회차
 *   4. 적금 납입 — 저장된 예정 회차
 *   5. 정기청구 중 아직 청구서가 안 된 회차
 *   6. 정기지출 중 아직 청구서가 안 된 회차
 *
 * 5·6 은 한때 "청구서가 되면 1·2로 잡히니 또 세면 이중계상"이라며 빠져 있었다. 판단은
 * 옳았지만 결과가 틀렸다 — 회차는 그 날이 와야 청구서가 되므로 **앞을 볼수록 급여·임대료·
 * 통신비·정기수입이 통째로 빠졌다.** 이중계상은 dueDatesToGenerate 가 막아준다
 * (이미 발행한 달의 회차는 목록에서 빠진다).
 *
 * @returns {{date, kind:'in'|'out', amount, label, source, account_id, planned?}[]} 날짜 오름차순
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

  /* 3. 대출 상환 — **저장된 예정 회차**(paid_date IS NULL)를 쓴다.
   *
   * 예전엔 원금·이율·기간으로 스케줄을 매번 다시 계산했다. 그러면 은행 통보서대로
   * 고쳐 둔 금액(변동금리·중도상환·휴일 이체일)이 무시되고 공식값으로 되돌아간다.
   * 자금 예측은 **은행이 실제로 빼갈 금액**을 알아야 쓸모가 있다. */
  const [loans] = await db.execute("SELECT * FROM loans WHERE status='active'")
  for (const l of loans) {
    const [rows] = await db.execute(
      'SELECT seq, due_date, principal, interest, paid_date FROM loan_repayments WHERE loan_id = ? ORDER BY seq',
      [l.id])
    const planned = rows.filter(r => !r.paid_date)
      .map(r => ({ seq: Number(r.seq), due_date: r.due_date, total: num(r.principal) + num(r.interest) }))
    /* 예정 행이 하나도 없는 대출은 스케줄이 아직 안 깔린 옛 데이터다. 그때만 공식으로 만든다 —
       빈손으로 두면 나갈 돈이 통째로 빠져 예측이 **낙관 쪽으로** 틀린다(가장 위험한 방향). */
    const done = new Set(rows.filter(r => r.paid_date).map(r => Number(r.seq)))
    const cycles = planned.length ? planned
      : repaymentSchedule(l).filter(c => !done.has(c.seq))
    for (const c of cycles) {
      const date = c.due_date < from ? from : c.due_date
      if (date > to || c.total <= 0) continue
      out.push({
        date, kind: 'out', amount: c.total,
        label: `${l.name} ${c.seq}회차`, source: '대출 상환',
        account_id: l.account_id || null, overdue: c.due_date < from,
      })
    }
  }

  // 4. 적금 납입 — 대출과 같은 규칙(저장된 예정 회차 우선, 없으면 공식)
  const [savings] = await db.execute("SELECT * FROM savings WHERE status='active' AND kind='installment'")
  for (const s of savings) {
    const [rows] = await db.execute(
      'SELECT seq, due_date, amount, paid_date FROM savings_payments WHERE savings_id = ? ORDER BY seq', [s.id])
    const planned = rows.filter(r => !r.paid_date)
      .map(r => ({ seq: Number(r.seq), due_date: r.due_date, amount: num(r.amount) }))
    const cycles = planned.length ? planned
      : unpaidPayments(s, rows.filter(r => r.paid_date).map(r => r.seq))
    for (const c of cycles) {
      const date = c.due_date < from ? from : c.due_date
      if (date > to || c.amount <= 0) continue
      out.push({
        date, kind: 'out', amount: c.amount,
        label: `${s.name} ${c.seq}회차`, source: '적금 납입',
        account_id: s.account_id || null, overdue: c.due_date < from,
      })
    }
  }

  /* 5·6. 정기청구·정기지출 중 **아직 청구서가 안 만들어진 회차**.
   *
   * 예전엔 "청구서가 만들어지면 1·2번으로 잡히니 여기서 또 세지 않는다"며 통째로 뺐다.
   * 이중계상을 피한 판단은 옳지만 결과가 틀렸다 — 회차는 그 날이 와야 청구서가 되므로,
   * **한 달 앞을 볼수록 급여·임대료·관리비·통신비·정기수입이 통째로 빠진다.**
   * 예측이 낙관 쪽으로 틀리는 가장 큰 원인이었다("지출 날짜를 못 지키면 신용 문제").
   *
   * 이중계상은 dueDatesToGenerate 가 막는다 — last_generated 가 놓인 달의 회차는
   * 이미 청구서가 됐으므로 목록에서 빠지고, 그 청구서는 1·2번이 센다.
   * 건너뛴 회차(recurring_skips)와 등록일 소급 하한도 정기청구 화면과 같은 규칙을 쓴다.
   */
  const [skipRows] = await db.execute('SELECT kind, recurring_id, due_date FROM recurring_skips')
  const skipBy = new Map()
  for (const s of skipRows) {
    const key = `${s.kind}:${s.recurring_id}`
    if (!skipBy.has(key)) skipBy.set(key, [])
    skipBy.get(key).push(String(s.due_date).slice(0, 10))
  }
  const spanDays = Math.max(0, Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000))
  // 회차일 + 결제기한 이 구간 안에 들어오는 회차까지 세려면, 회차는 그만큼 더 앞까지 봐야 한다
  const horizonDays = spanDays

  for (const spec of [
    { table: 'recurring_invoices', skipKind: 'invoice', kind: 'in',  source: '정기청구',
      label: r => `${r.vendor_name || '거래처'} ${r.item || ''}`.trim(),
      // 정기청구는 공급가액을 저장한다 — 통장에 들어오는 돈은 세액을 더한 값이다
      amount: r => { const s = num(r.supply_amount); return s + recurFromSupply(s, r.vat_mode).vat } },
    { table: 'recurring_expenses', skipKind: 'expense', kind: 'out', source: '정기지출',
      label: r => `${r.vendor_name || '거래처'} ${r.category || ''}`.trim(),
      // 정기지출은 합계(VAT 포함)를 저장한다 — 그대로 나간다
      amount: r => num(r.amount) },
  ]) {
    const [recs] = await db.execute(
      `SELECT r.*, UNIX_TIMESTAMP(r.created_at) AS created_epoch, v.name AS vendor_name
         FROM ${spec.table} r LEFT JOIN vendors v ON r.vendor_id = v.id
        WHERE r.active = 1`)
    for (const r of recs) {
      r.setup_date = kstDate(Number(r.created_epoch) * 1000)   // 등록일 이전으로는 소급하지 않는다
      r.skips = skipBy.get(`${spec.skipKind}:${r.id}`) || []
      const amount = spec.amount(r)
      if (amount <= 0) continue
      /* 회차일은 '청구서를 내는 날'이고, 돈이 오가는 날은 **결제기한**이다.
         회차일에 세면 그 회차를 발행하는 순간 같은 돈이 30일 뒤로 점프한다 —
         발행 버튼을 눌렀는지에 따라 예측이 달라지면 문서를 못 믿는다.
         발행 경로와 같은 상수를 쓴다(lib/recurrence.js PAYMENT_TERM_DAYS). */
      for (const cycle of dueDatesToGenerate(r, from, { horizonDays })) {
        const due = addDays(cycle, PAYMENT_TERM_DAYS)
        if (due < from || due > to) continue
        out.push({
          date: due, cycle_date: cycle, kind: spec.kind, amount,
          label: spec.label(r), source: spec.source,
          account_id: r.account_id || null,
          overdue: false,        // 아직 청구서가 없는 회차라 '연체'가 아니라 '예정'이다
          planned: true,         // 확정이 아니라 규칙에서 나온 예정 — 화면이 구분해 보여준다
        })
      }
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

/**
 * 계좌별 자금 예측 — "어느 통장이 언제 부족해지나".
 *
 * ── 왜 필요한가 ──
 * project() 는 전 계좌를 하나로 합쳐 회사 전체의 최저 잔액만 낸다. 그런데 돈은 통장별로
 * 따로 있고 이체는 사람이 해야 한다. 실제로 이 회사가 그랬다:
 *   주거래 +3억 7,154만 / 급여계좌 **−5,357만** → 합계는 3억이라 "자금 넉넉해요"
 * 합계만 보면 급여일에 이체가 안 나간다는 걸 알 수 없다. 경영자가 "어느 계좌에서
 * 얼마를 옮겨야 하나"를 판단하려면 통장 단위로 봐야 한다.
 *
 * ── 계좌가 안 정해진 흐름 ──
 * 미수금 청구서는 수금 계좌를 안 잡고 발행하는 일이 흔하다(기성 청구가 특히 그렇다).
 * 그런 돈을 임의로 주거래에 몰아넣으면 **주거래가 실제보다 넉넉해 보인다.**
 * 아예 빼면 들어올 돈이 없는 것처럼 보인다. 그래서 '계좌 미지정' 칸에 따로 모아
 * 그대로 보여준다 — "이 돈을 어느 통장으로 받을지 정하세요"가 그 자체로 할 일이 된다.
 *
 * @param accounts balancesAsOf() 결과 (카드 포함 — 걸러내는 건 호출부 몫)
 * @param flows    upcomingFlows() 결과
 * @returns {{accounts: [...], unassigned: {...}}}
 */
function projectByAccount(accounts, flows, { from, to }) {
  const byId = new Map()
  for (const a of accounts) {
    byId.set(a.id, {
      id: a.id, name: a.name, kind: a.kind, type: a.type, number: a.number,
      balance: num(a.balance), in: 0, out: 0,
      lowest: { date: from, balance: num(a.balance) },
      items: [],
    })
  }
  // 계좌를 못 찾은(또는 안 정해진) 흐름은 여기로 모은다
  const unassigned = { in: 0, out: 0, items: [] }

  const perDay = new Map()   // accountId → Map(date → {in,out})
  for (const f of flows) {
    const bucket = f.account_id && byId.has(f.account_id) ? byId.get(f.account_id) : unassigned
    bucket[f.kind] += f.amount
    bucket.items.push(f)
    if (bucket === unassigned) continue
    if (!perDay.has(bucket.id)) perDay.set(bucket.id, new Map())
    const m = perDay.get(bucket.id)
    if (!m.has(f.date)) m.set(f.date, { in: 0, out: 0 })
    m.get(f.date)[f.kind] += f.amount
  }

  // 계좌마다 날짜순으로 접어 최저 잔액을 찾는다(project() 와 같은 방식, 범위만 계좌 단위)
  for (const acc of byId.values()) {
    const m = perDay.get(acc.id)
    if (!m) continue
    let bal = acc.balance
    for (const date of [...m.keys()].sort()) {
      const d = m.get(date)
      bal = bal + d.in - d.out
      if (bal < acc.lowest.balance) acc.lowest = { date, balance: bal }
    }
    acc.endBalance = bal
  }
  for (const acc of byId.values()) if (acc.endBalance == null) acc.endBalance = acc.balance

  return { accounts: [...byId.values()], unassigned, range: { from, to } }
}

module.exports = { balancesAsOf, upcomingFlows, project, projectByAccount, dailyTrial }
