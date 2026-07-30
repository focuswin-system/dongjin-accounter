/* 차입금 상환 스케줄 계산 — 재무관리의 단일 규칙.
 *
 * 여기가 틀리면 화면은 멀쩡하고 숫자만 조용히 틀어진다:
 *   · 원금과 이자를 잘못 가르면 이자비용이 부풀거나(원금이 비용으로) 손익이 비어 버린다
 *   · 반올림을 단수 조정 없이 하면 마지막 회차 뒤에 잔액이 1~2원 남거나 초과된다
 *
 * 설계: docs/02-design/features/finance-management.design.md §4
 * 날짜 계산은 정기청구·정기지출과 같은 규칙을 쓴다(lib/recurrence.js) — 말일 clamp가 필요하다.
 */
const { daysInMonth, fmtDate } = require('./recurrence')

const METHODS = ['equal_payment', 'equal_principal', 'bullet']

/** 연이율(%) → 월이율(소수). 0%도 유효하다(무이자 관계사 차입). */
const monthlyRate = (annualRate) => (Number(annualRate) || 0) / 12 / 100

/**
 * 원리금균등 월 납입액 PMT = P·r / (1 − (1+r)^−n)
 * 이율 0이면 나눗셈이 무한이 되므로 원금 균등분할로 떨어뜨린다.
 */
function equalPayment(principal, annualRate, months) {
  const P = Number(principal) || 0
  const n = Number(months) || 0
  const r = monthlyRate(annualRate)
  if (n <= 0) return 0
  if (r === 0) return Math.round(P / n)
  return Math.round((P * r) / (1 - Math.pow(1 + r, -n)))
}

/** 상환일 — start_date 의 '절대 월'에서 i개월 뒤, 앵커일은 그 달 말일로 clamp */
function dueDateOf(startDate, payDay, i) {
  const [sy, sm] = String(startDate).split('-').map(Number)
  const anchor = Number(payDay) || Number(String(startDate).split('-')[2]) || 1
  const abs = (sm - 1) + i
  const y = sy + Math.floor(abs / 12)
  const m = ((abs % 12) + 12) % 12
  return fmtDate(new Date(y, m, Math.min(anchor, daysInMonth(y, m))))
}

/**
 * 상환 스케줄 전체를 만든다.
 *
 * @param loan { principal, annual_rate, method, term_months, start_date, pay_day }
 * @returns [{ seq, due_date, principal, interest, total, balance }]
 *
 * 규칙
 *   · 이자는 매 회차 '직전 잔액 × 월이율'(원 단위 반올림)
 *   · 마지막 회차의 원금은 남은 잔액 전부 — 반올림 누적을 여기서 정산한다
 *   · balance 는 그 회차를 갚은 뒤의 잔액. 마지막은 반드시 0
 */
function repaymentSchedule(loan) {
  const P = Number(loan.principal) || 0
  const n = Number(loan.term_months) || 0
  const method = METHODS.includes(loan.method) ? loan.method : 'equal_payment'
  const r = monthlyRate(loan.annual_rate)
  if (P <= 0 || n <= 0) return []

  const pmt = method === 'equal_payment' ? equalPayment(P, loan.annual_rate, n) : 0
  const flatPrincipal = method === 'equal_principal' ? Math.round(P / n) : 0

  const out = []
  let balance = P
  for (let i = 1; i <= n; i++) {
    const interest = Math.round(balance * r)
    let principal
    if (method === 'bullet') {
      principal = i === n ? balance : 0            // 만기일시 — 이자만 내다 만기에 전액
    } else if (method === 'equal_principal') {
      principal = i === n ? balance : Math.min(flatPrincipal, balance)
    } else {
      principal = i === n ? balance : Math.min(Math.max(pmt - interest, 0), balance)
    }
    // 마지막 회차에서 잔액을 전부 털어 반올림 누적을 정산한다(잔액 1~2원 잔존 방지)
    balance -= principal
    out.push({
      seq: i,
      due_date: dueDateOf(loan.start_date, loan.pay_day, i),
      principal, interest,
      total: principal + interest,
      balance,
    })
  }
  return out
}

/** 아직 상환하지 않은 회차 — paidSeqs(이미 처리한 회차 번호 집합)를 제외한다 */
function unpaidCycles(loan, paidSeqs = []) {
  const done = new Set(paidSeqs.map(Number))
  return repaymentSchedule(loan).filter(c => !done.has(c.seq))
}

/**
 * 잔여 원금 — 실제로 처리한 상환 실적 기준.
 * 스케줄이 아니라 실적으로 계산한다(중도상환·연체로 스케줄과 어긋날 수 있다).
 */
const remainingPrincipal = (principal, repayments = []) =>
  Math.max(0, (Number(principal) || 0) - repayments.reduce((s, r) => s + (Number(r.principal) || 0), 0))

/** 스케줄 합계 — 총 이자를 미리 보여줄 때 쓴다(대출 등록 화면) */
function scheduleTotals(loan) {
  const s = repaymentSchedule(loan)
  return {
    months: s.length,
    principal: s.reduce((a, c) => a + c.principal, 0),
    interest: s.reduce((a, c) => a + c.interest, 0),
    total: s.reduce((a, c) => a + c.total, 0),
    firstDue: s[0]?.due_date || null,
    lastDue: s[s.length - 1]?.due_date || null,
  }
}

module.exports = {
  METHODS, monthlyRate, equalPayment, dueDateOf,
  repaymentSchedule, unpaidCycles, remainingPrincipal, scheduleTotals,
}
