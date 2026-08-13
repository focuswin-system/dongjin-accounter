/**
 * 예금·적금 계산 — 자금 '운용' 쪽. 차입금(lib/loan.js)의 거울상이다.
 *
 *   대출: 목돈을 받고 → 매월 갚고 → 만기에 끝난다
 *   적금: 매월 넣고  → 만기에 원리금을 받는다
 *   예금: 목돈을 넣고 → 만기에 원리금을 받는다
 *
 * 그래서 회차 날짜 계산은 loan.js 의 dueDateOf 를 그대로 쓴다(같은 규칙이어야 한다).
 *
 * ── 왜 accounts 에 넣지 않았나 ──
 * accounts 는 11개 화면에서 **결제수단 드롭다운**으로 쓰인다(거래 등록·청구서 정산·급여이체…).
 * 여기에 적금을 섞으면 그 11곳을 전부 걸러야 하고, 한 곳만 빠뜨려도 '적금 계좌에서 외주비 지급'
 * 같은 게 조용히 만들어진다. 마감 우회 결함과 같은 실패 패턴이라 아예 다른 테이블로 둔다.
 * 대신 자금일보에서 **묶인 자금**으로 합산해 보여준다 — 회사 돈인 건 맞으니까.
 *
 * ── 이자 계산 ──
 * 실무 상품 대부분이 **단리**다(복리 상품은 별도 표기가 붙는다). 세전 기준으로 계산하고,
 * 이자소득세(15.4%)는 표시만 한다 — 법인은 원천징수 후 법인세에서 정산하므로
 * 여기서 세후를 확정해버리면 오히려 틀린 숫자가 된다.
 */

const { dueDateOf } = require('./loan')

/* 적금(매월 납입) / 예금(목돈 예치) / 보증금(임대차·관리비 — 계약이 끝나야 돌아온다)
 *
 * 보증금을 넣는 이유: 받은 자금관리 엑셀의 '저축 현황'에 로봇랜드재단 임대료보증금
 * 5,100,000 · 관리비보증금 1,011,000 이 예적금과 나란히 서 있다. 성격도 같다 —
 * 회사 재산이지만 지금 쓸 수 없는 돈. 다만 **만기도 이자도 없어서** 회차·이자 계산은 하지 않는다. */
const KINDS = ['installment', 'deposit', 'guarantee']

/** 이자소득세율(원천징수) — 소득세 14% + 지방소득세 1.4% */
const TAX_RATE = 0.154

const intOf = (v) => Math.round(Number(v) || 0)

/**
 * 적금 만기이자(단리, 세전).
 *
 * 매월 넣은 돈은 각각 예치 기간이 다르다. 1회차는 n개월, 2회차는 n-1개월 … n회차는 1개월.
 * 그래서 총 이자 = 월납입 × (연이율/12) × (n + (n-1) + … + 1) = 월납입 × r/12 × n(n+1)/2
 * 흔히 하는 실수: 총 납입액 × 연이율 × 기간 — 그러면 이자가 2배 가까이 부풀려진다.
 */
function installmentInterest(monthlyAmount, annualRate, months) {
  const m = intOf(monthlyAmount)
  const n = Math.trunc(Number(months) || 0)
  const r = (Number(annualRate) || 0) / 100
  if (m <= 0 || n <= 0 || r <= 0) return 0
  return Math.round(m * (r / 12) * (n * (n + 1) / 2))
}

/** 예금 만기이자(단리, 세전) = 원금 × 연이율 × 개월/12 */
function depositInterest(principal, annualRate, months) {
  const p = intOf(principal)
  const n = Math.trunc(Number(months) || 0)
  const r = (Number(annualRate) || 0) / 100
  if (p <= 0 || n <= 0 || r <= 0) return 0
  return Math.round(p * r * (n / 12))
}

/**
 * 납입 스케줄. 적금만 회차가 있다(예금은 가입할 때 한 번 넣고 끝).
 * @returns {{seq, due_date, amount, cumulative}[]}
 */
function paymentSchedule(s) {
  if (s.kind !== 'installment') return []
  const n = Math.trunc(Number(s.term_months) || 0)
  const m = intOf(s.monthly_amount)
  if (n <= 0 || m <= 0) return []
  const out = []
  let cum = 0
  for (let i = 1; i <= n; i++) {
    cum += m
    // 1회차는 가입일(start_date) 당일에 낸다 — 그래서 dueDateOf(…, i-1).
    // 대출은 돈을 먼저 받고 다음 달부터 갚으므로 i 부터다. 방향이 반대라 한 칸 당긴다.
    out.push({ seq: i, due_date: dueDateOf(s.start_date, s.pay_day, i - 1), amount: m, cumulative: cum })
  }
  return out
}

/** 아직 납입하지 않은 회차 */
function unpaidPayments(s, paidSeqs = []) {
  const done = new Set(paidSeqs.map(Number))
  return paymentSchedule(s).filter(c => !done.has(c.seq))
}

/**
 * 지금까지 쌓인 원금 — **실제 납입 실적** 기준.
 * 스케줄이 아니라 실적으로 센다(밀린 회차가 있으면 스케줄과 어긋난다).
 * 예금·보증금은 넣는 순간 전액이므로 principal 그대로 — 회차가 없다.
 * ⚠ 'deposit' 만 보고 갈라 놓으면 보증금이 회차 합계(=0)로 떨어져 묶인 돈에서 통째로 사라진다.
 */
function paidPrincipal(s, payments = []) {
  if (s.kind !== 'installment') return intOf(s.principal)
  return payments.reduce((a, p) => a + intOf(p.amount), 0)
}

/** 두 날짜 사이의 개월 수(내림). 이자는 월 단위로 붙는다 */
function monthsBetween(from, to) {
  if (!from || !to) return 0
  const [fy, fm, fd] = String(from).split('-').map(Number)
  const [ty, tm, td] = String(to).split('-').map(Number)
  if (!fy || !ty) return 0
  let m = (ty - fy) * 12 + (tm - fm)
  if (td < fd) m -= 1              // 날짜가 안 찼으면 그 달은 안 센다
  return Math.max(0, m)
}

/**
 * **실제로 넣은 돈에 붙은** 이자(단리·세전).
 *
 * maturitySummary 는 "약속대로 끝까지 넣었을 때"를 계산한다. 만기 처리 화면이 그 값을
 * 기본값으로 쓰면, 12회 중 1회만 낸 적금을 만기 처리할 때 12회분 이자가 들어간다
 * (이자수익도 계좌 잔액도 그만큼 부푼다). 원금은 실적 기준(paidPrincipal)인데 이자만
 * 스케줄 기준이라 전제가 어긋나 있었다.
 *
 * @param payments 실제 납입 실적 [{ amount, paid_date, due_date }]
 * @param asOf     수령일(중도해지면 그 날). 없으면 만기일.
 */
function accruedInterest(s, payments = [], asOf) {
  const r = (Number(s.annual_rate) || 0) / 100
  if (r <= 0) return 0
  const end = asOf || maturityDateOf(s)
  if (!end) return 0
  const cap = Math.trunc(Number(s.term_months) || 0)

  if (s.kind === 'deposit') {
    const held = Math.min(monthsBetween(s.start_date, end), cap)
    return Math.round(intOf(s.principal) * r * (held / 12))
  }
  // 적금 — 회차마다 예치 기간이 다르다. 낸 회차만, 낸 날부터 센다.
  let total = 0
  for (const p of payments) {
    const from = p.paid_date || p.due_date
    const held = Math.min(monthsBetween(from, end), cap)
    total += intOf(p.amount) * (r / 12) * held
  }
  return Math.round(total)
}

/** 만기 예상액 요약 — 등록 화면에서 가입 전에 보여준다 */
function maturitySummary(s) {
  const n = Math.trunc(Number(s.term_months) || 0)
  const principal = s.kind === 'installment'
    ? intOf(s.monthly_amount) * n
    : intOf(s.principal)
  const interest = s.kind === 'installment'
    ? installmentInterest(s.monthly_amount, s.annual_rate, n)
    : depositInterest(s.principal, s.annual_rate, n)
  const tax = Math.round(interest * TAX_RATE)
  const sched = paymentSchedule(s)
  return {
    months: n,
    principal,                      // 총 납입(예치) 원금
    interest,                       // 세전 이자
    tax,                            // 원천징수 예상액(표시용)
    total: principal + interest,    // 세전 만기 수령액
    afterTax: principal + interest - tax,
    firstDue: sched[0]?.due_date || s.start_date || null,
    lastDue: sched[sched.length - 1]?.due_date || null,
    maturityDate: maturityDateOf(s),
  }
}

/**
 * 만기일 — 가입일에서 term_months 만큼 뒤.
 * 말일 처리는 dueDateOf 가 이미 한다(1/31 + 1개월 = 2/28).
 * 적금은 마지막 납입 다음 달이 아니라, 가입일 + 기간이 만기다.
 */
function maturityDateOf(s) {
  if (!s.start_date) return null
  const n = Math.trunc(Number(s.term_months) || 0)
  if (n <= 0) return null
  // pay_day 를 가입일의 '일'로 고정해 계산한다(만기는 납입일과 무관하다)
  const day = Number(String(s.start_date).slice(8, 10)) || 1
  return dueDateOf(s.start_date, day, n)
}

module.exports = {
  KINDS, TAX_RATE,
  installmentInterest, depositInterest, accruedInterest, monthsBetween,
  paymentSchedule, unpaidPayments, paidPrincipal,
  maturitySummary, maturityDateOf,
}
