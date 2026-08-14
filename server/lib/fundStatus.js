/**
 * 자금 현황 집계 — 계좌·부채·저축·미지급 인건비·입금 예정.
 *
 * ── 왜 lib 인가 ──
 * 처음엔 routes/fund-status.js 안에 있었다. 그런데 **자금관리표 보고서**가 같은 숫자를
 * 써야 한다(대표가 보던 엑셀을 그대로 옮긴 양식이다). 집계를 두 벌로 두면 같은 회사의
 * 자금표가 화면마다 달라진다 — 그러면 둘 다 못 믿게 된다.
 * 그래서 산식은 여기 한 곳에 두고, 라우트는 얇게 가져다 쓴다.
 * (lib/cashReport.js 를 자금일보·자금현황이 함께 쓰는 것과 같은 이유다.)
 *
 * ⚠ 여기 함수들은 **db 를 인자로 받는다.** 전역 풀을 참조하면 회사 구분이 사라진다.
 */

const { dayBefore } = require('./period')
const { balancesAsOf, upcomingFlows } = require('./cashReport')
const { SETTLED_INCOME, SETTLED_EXPENSE } = require('./ledger')
const { remainingPrincipal } = require('./loan')
const { pendingCond } = require('./invoiceStatus')

/** 구간이 마감됐는가 — 그 구간에 걸친 달이 **전부** 마감돼야 확정이다. */
async function closedState(db, from, to, today) {
  const months = []
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, m = 1) : m++) {
    months.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  if (!months.length) return 'planned'
  const ph = months.map(() => '?').join(',')
  const [rows] = await db.execute(
    `SELECT period FROM closed_periods WHERE period IN (${ph})`, months)
  const closed = new Set(rows.map(r => r.period))
  if (from > today) return 'planned'                       // 아직 안 온 구간
  if (months.every(m => closed.has(m))) return 'closed'    // 전부 마감 = 확정
  return to < today ? 'provisional' : 'current'            // 지났지만 미마감 / 진행 중
}

/* 구간 **시작 시점**의 계좌별 잔액.
 *
 * balancesAsOf 만으로는 미래 구간이 틀린다. 거래는 미래 날짜로 등록할 수 없으므로
 * balancesAsOf('2026-09-01') 은 사실상 '오늘 잔액'이고, 오늘~구간 시작 사이에 나갈
 * 급여·카드값이 하나도 안 빠져 있다. 실물로 4,000만이 과대였고, 그 결과 9월에 비는
 * 통장이 shortfalls 에 안 잡혔다 — "며칠에 어느 통장이 비나"가 다음 달부터 틀린 것이다.
 *
 * 그래서 미래 구간이면 **오늘부터 구간 직전까지의 예정을 미리 반영**한다.
 * 그 다리 구간에서는 연체·기한미정도 센다(anchorPast:true) — 지금 몫의 돈이니까.
 */
async function openingBalances(db, { from, today, datedOnly = false }) {
  const rows = await balancesAsOf(db, dayBefore(from))
  if (from <= today) return rows
  const bridge = await upcomingFlows(db, { from: today, to: dayBefore(from), anchorPast: true })
  const delta = new Map()
  for (const f of bridge) {
    /* datedOnly — 시간축(timeline)은 기한 미정·연체를 **축에서 빼고** 별도 블록으로 낸다.
       다리 구간에서만 그걸 포함하면 이번 달 마지막 잔액과 다음 달 첫 잔액이 어긋난다
       (실측 1억 7,818만 차이). 축과 같은 규칙을 써야 두 구간이 이어진다. */
    if (datedOnly && (f.noDue || f.overdue)) continue
    const k = f.account_id || ''
    delta.set(k, (delta.get(k) || 0) + (f.kind === 'in' ? f.amount : -f.amount))
  }
  return rows.map(a => ({ ...a, balance: a.balance + (delta.get(a.id) || 0) }))
}

/** 그 구간에 **실제로 오간 돈**(거래 실적). 계좌별로 나눈다. */
async function actualsIn(db, from, to, mine) {
  const [rows] = await db.execute(
    `SELECT account_id, kind, SUM(amount) AS total
       FROM transactions
      WHERE date BETWEEN ? AND ?
        AND ((kind = 'income' AND status = ?) OR (kind = 'expense' AND status = ?))
      GROUP BY account_id, kind`,
    [from, to, SETTLED_INCOME, SETTLED_EXPENSE])
  const by = new Map()
  let inSum = 0, outSum = 0
  for (const r of rows) {
    const key = r.account_id || ''
    /* ⚠ 합계는 **화면에 서는 계좌만** 센다.
     *
     * 예전엔 여기서 계좌를 안 걸러, 카드 계좌 지출이 상단 KPI '나간 돈'에는 들어가는데
     * 아래 계좌표에는 없었다(계좌표는 kind!=='card' 만 그린다). 게다가 그 사용액은
     * 결제일에 '카드 결제'로 한 번 더 세어져 **같은 돈이 두 번** 잡혔다.
     * 개인 계좌도 마찬가지다 — 비관리자에게는 표에 안 보이는데 KPI 에만 섞여
     * "법인+개인+미지정" 합이 KPI 와 안 맞았다. */
    if (key && !mine.has(key)) continue
    if (!by.has(key)) by.set(key, { in: 0, out: 0 })
    const v = Number(r.total) || 0
    if (r.kind === 'income') { by.get(key).in += v; inSum += v } else { by.get(key).out += v; outSum += v }
  }
  return { by, in: inSum, out: outSum }
}

/* 부채 현황 — 기관별 남은 원금과 합계. 대표 자금표의 '<법인 부채 현황>' 블록이다.
 * 남은 원금은 lib/loan.js 규칙(실적만 차감)을 그대로 쓴다 — 예정 회차를 세면 안 갚은 돈이
 * 갚은 것으로 잡힌다. */
async function debtStatus(db) {
  const [loans] = await db.execute(
    "SELECT id, name, lender, principal, status FROM loans WHERE status = 'active' ORDER BY lender, name")
  /* 대출마다 회차를 따로 조회하지 않는다 — 한 번에 받아 나눈다.
     이 화면은 대출·저축·인건비를 한꺼번에 그리는데 대출이 14건이면 왕복만 15번이었다. */
  const byLoan = new Map()
  if (loans.length) {
    const [reps] = await db.execute(
      `SELECT loan_id, principal, paid_date FROM loan_repayments
        WHERE loan_id IN (${loans.map(() => '?').join(',')})`, loans.map(l => l.id))
    for (const r of reps) {
      if (!byLoan.has(r.loan_id)) byLoan.set(r.loan_id, [])
      byLoan.get(r.loan_id).push(r)
    }
  }
  const items = []
  for (const l of loans) {
    const reps = byLoan.get(l.id) || []
    items.push({
      id: l.id, name: l.name, lender: l.lender || '기타',
      principal: Number(l.principal) || 0,
      remaining: remainingPrincipal(l.principal, reps),
    })
  }
  const byLender = new Map()
  for (const it of items) {
    if (!byLender.has(it.lender)) byLender.set(it.lender, { lender: it.lender, items: [], total: 0 })
    const g = byLender.get(it.lender)
    g.items.push(it); g.total += it.remaining
  }
  return { groups: [...byLender.values()], total: items.reduce((s, x) => s + x.remaining, 0) }
}

/* 저축·보증금 현황 — 묶여 있어 지금 못 쓰는 돈. 대표 자금표의 '<저축 현황>' 블록.
 * 적금은 **실제로 넣은 만큼**만 센다(스케줄로 세면 밀린 회차까지 넣은 것처럼 부푼다). */
async function savingsStatus(db) {
  const [rows] = await db.execute(
    "SELECT id, name, bank, kind, principal, monthly_amount FROM savings WHERE status = 'active' ORDER BY kind, name")
  // 적금 납입 실적도 한 번에 — 상품마다 조회하면 왕복이 상품 수만큼 늘어난다
  const paidBy = new Map()
  const insts = rows.filter(r => r.kind === 'installment')
  if (insts.length) {
    const [ps] = await db.execute(
      `SELECT savings_id, COALESCE(SUM(amount),0) AS paid FROM savings_payments
        WHERE savings_id IN (${insts.map(() => '?').join(',')}) AND paid_date IS NOT NULL
        GROUP BY savings_id`, insts.map(r => r.id))
    for (const p of ps) paidBy.set(p.savings_id, Number(p.paid) || 0)
  }
  const items = []
  for (const s of rows) {
    const amount = s.kind === 'installment' ? (paidBy.get(s.id) || 0) : (Number(s.principal) || 0)
    items.push({ id: s.id, name: s.name, bank: s.bank || '', kind: s.kind, amount })
  }
  return { items, total: items.reduce((s, x) => s + x.amount, 0) }
}

/* 미지급 인건비 — 퇴직자/현직원 × 급여/퇴직금. 대표 자금표에 이름별로 적혀 있던 블록.
 *
 * 출처가 둘이고, **둘을 섞어 적으면 안 된다**:
 *   급여  → 급여대장(payroll). 월분 행의 `net_salary − 실지급`이 곧 미지급이다.
 *           퇴사자도 employees 에 남으므로 과거 월분이 그대로 여기 잡힌다.
 *   퇴직금 → unpaid_labor. 급여대장은 "한 사람 한 달 한 행"이라 근속 전체에 대한
 *           일시금이 들어갈 자리가 없다.
 * 자금 예측(lib/cashReport.js 9·10번)이 세는 것과 같은 두 곳이다 — 한쪽만 보면
 * 요약행의 '미지급 인건비'와 예측의 '나갈 돈'이 서로 안 맞는다.
 */
/* 직원별 급여 명세를 볼 자격.
 *
 * laborStatus 는 이름·월분·미지급액을 낸다 — 인사 데이터다. 그런데 이 라우터의 게이트는
 * fund_status/cash_report 라, 인사 권한이 막힌 역할('실무' 프리셋은 hr:[] 인데
 * fund_status 는 열려 있다)이 /api/employees 는 403 을 받으면서 여기로는 전 직원
 * 미지급 급여를 받아 갔다. 합계는 자금 판단에 필요하니 남기고 **이름별 명세만** 가린다.
 * 역할 미배정 계정은 제한 없음(게이트와 같은 규칙 — routes/accounts.js canSeeBalance). */
const canSeeLaborDetail = (req) => {
  const perms = req.perms
  if (!perms || perms.size === 0) return true
  return ['hr', 'hr_labor_contract', 'hr_outsourcing'].some(r => perms.has(`${r}:view`))
}

async function laborStatus(db) {
  // 급여 — 지급액은 payroll_id 로 합산한다(나눠 지급한 건을 빠뜨리면 미지급이 부푼다)
  const [pay] = await db.execute(
    `SELECT p.month, p.net_salary, e.name AS emp_name, e.status AS emp_status,
            COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.payroll_id = p.id), 0) AS paid
       FROM payroll p LEFT JOIN employees e ON e.id = p.employee_id
      WHERE p.status IN ('확정', '일부지급')
      ORDER BY e.name, p.month`)
  const salary = pay.map(r => ({
    name: r.emp_name || '직원', kind: 'salary',
    status: r.emp_status === '퇴사' ? 'retired' : 'active',
    period: r.month || '',
    remain: (Number(r.net_salary) || 0) - (Number(r.paid) || 0),
  })).filter(x => x.remain > 0)

  // 퇴직금
  const [sev] = await db.execute(
    "SELECT name, status, period, amount, paid_amount FROM unpaid_labor WHERE kind = 'severance' ORDER BY status, name")
  const severance = sev.map(r => ({
    name: r.name, kind: 'severance', status: r.status, period: r.period || '',
    remain: (Number(r.amount) || 0) - (Number(r.paid_amount) || 0),
  })).filter(x => x.remain > 0)

  const items = [...salary, ...severance]
  const sum = (f) => items.filter(f).reduce((s, x) => s + x.remain, 0)
  return {
    items,
    retiredSalary: sum(x => x.status === 'retired' && x.kind === 'salary'),
    retiredSeverance: sum(x => x.status === 'retired' && x.kind === 'severance'),
    activeSalary: sum(x => x.status === 'active' && x.kind === 'salary'),
    activeSeverance: sum(x => x.status === 'active' && x.kind === 'severance'),
    total: sum(() => true),
  }
}

/* 입금 예정(날짜 미정) — 잔금·중도금처럼 **언제 들어올지 모르는 돈**.
 * 대표 자금표 맨 아래 '입금 예정금액' 블록이 정확히 이것이다(쉬운기술 잔금·동진테크 중도금…).
 * 기한이 있는 것은 위 계좌별 예정에 이미 날짜로 서 있으므로 여기서는 뺀다 —
 * 다만 **기한이 지났는데 아직 안 들어온 것**은 "언제 들어올지 모르는 돈"이 됐으므로 여기 둔다. */
async function incomingNoDate(db, today) {
  const cond = pendingCond('issued', 'i')
  const [rows] = await db.execute(
    `SELECT i.invoice_no, i.due_at, i.total_amount, v.name AS vendor_name, c.name AS contract_name,
            COALESCE((SELECT SUM(amount) FROM invoice_matches WHERE invoice_id = i.id), 0) AS matched
       FROM invoices i
       LEFT JOIN vendors v ON v.id = i.vendor_id
       LEFT JOIN contracts c ON c.id = i.contract_id
      WHERE i.kind = 'issued' AND ${cond.sql}`, cond.params)
  const items = rows.map(r => ({
    vendor: r.vendor_name || '거래처', contract: r.contract_name || '',
    invoice_no: r.invoice_no || '', due_at: r.due_at || '',
    remain: (Number(r.total_amount) || 0) - (Number(r.matched) || 0),
    overdue: !!r.due_at && r.due_at < today,
  })).filter(x => x.remain > 0 && (!x.due_at || x.overdue))
  return { items, total: items.reduce((s, x) => s + x.remain, 0) }
}

module.exports = {
  closedState, openingBalances, actualsIn,
  debtStatus, savingsStatus, laborStatus, incomingNoDate, canSeeLaborDetail,
}
