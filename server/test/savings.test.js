/**
 * 예적금 계산 — 숫자가 조용히 틀리면 사용자가 만기에 가서야 안다.
 * 특히 적금 이자는 흔한 계산 실수(총납입 × 이율 × 기간)로 2배 가까이 부풀려진다.
 */
const test = require('node:test')
const assert = require('node:assert')
const {
  installmentInterest, depositInterest, paymentSchedule, unpaidPayments,
  paidPrincipal, maturitySummary, maturityDateOf, TAX_RATE, accruedInterest, monthsBetween,
  KINDS, noMaturity,
} = require('../lib/savings')

test('적금 이자 — 예치 기간이 회차마다 다르다', () => {
  // 월 100만원 × 12개월, 연 4%
  // 정답: 1,000,000 × (0.04/12) × (12×13/2) = 1,000,000 × 0.003333… × 78 = 260,000
  assert.equal(installmentInterest(1_000_000, 4, 12), 260_000)
})

test('적금 이자 — 총납입×이율×기간으로 계산하면 안 된다', () => {
  // 흔한 오답: 12,000,000 × 0.04 × 1년 = 480,000 (거의 2배)
  const wrong = 12_000_000 * 0.04
  assert.notEqual(installmentInterest(1_000_000, 4, 12), wrong)
  assert.ok(installmentInterest(1_000_000, 4, 12) < wrong)
})

test('예금 이자 — 원금 × 이율 × 기간', () => {
  assert.equal(depositInterest(10_000_000, 3.5, 12), 350_000)
  assert.equal(depositInterest(10_000_000, 3.5, 6), 175_000)
  assert.equal(depositInterest(10_000_000, 3.5, 24), 700_000)
})

test('이율 0이거나 금액 0이면 이자 0 (0으로 나누기·NaN 방지)', () => {
  assert.equal(installmentInterest(1_000_000, 0, 12), 0)
  assert.equal(installmentInterest(0, 4, 12), 0)
  assert.equal(installmentInterest(1_000_000, 4, 0), 0)
  assert.equal(depositInterest(0, 3, 12), 0)
  assert.equal(depositInterest(1_000_000, 3, 0), 0)
})

test('적금 스케줄 — 1회차는 가입일 당일', () => {
  const s = { kind: 'installment', monthly_amount: 500_000, term_months: 3, start_date: '2026-03-10', pay_day: 10 }
  const sch = paymentSchedule(s)
  assert.equal(sch.length, 3)
  assert.equal(sch[0].due_date, '2026-03-10')   // 대출과 달리 가입 당일부터 낸다
  assert.equal(sch[1].due_date, '2026-04-10')
  assert.equal(sch[2].due_date, '2026-05-10')
})

test('적금 스케줄 — 누계가 맞는다', () => {
  const s = { kind: 'installment', monthly_amount: 300_000, term_months: 4, start_date: '2026-01-05', pay_day: 5 }
  const sch = paymentSchedule(s)
  assert.deepEqual(sch.map(c => c.cumulative), [300_000, 600_000, 900_000, 1_200_000])
  assert.equal(sch.at(-1).cumulative, 300_000 * 4)
})

test('예금은 납입 회차가 없다', () => {
  assert.deepEqual(paymentSchedule({ kind: 'deposit', principal: 10_000_000, term_months: 12 }), [])
})

test('미납 회차 — 이미 낸 회차는 빠진다', () => {
  const s = { kind: 'installment', monthly_amount: 100_000, term_months: 5, start_date: '2026-01-01', pay_day: 1 }
  assert.deepEqual(unpaidPayments(s, [1, 2]).map(c => c.seq), [3, 4, 5])
  assert.equal(unpaidPayments(s, []).length, 5)
})

test('쌓인 원금은 스케줄이 아니라 실적으로 센다', () => {
  // 3회차까지 왔어도 2번만 냈으면 200만원이다
  const s = { kind: 'installment', monthly_amount: 1_000_000, term_months: 12, start_date: '2026-01-01', pay_day: 1 }
  assert.equal(paidPrincipal(s, [{ amount: 1_000_000 }, { amount: 1_000_000 }]), 2_000_000)
  // 예금은 가입 시점에 전액
  assert.equal(paidPrincipal({ kind: 'deposit', principal: 5_000_000 }, []), 5_000_000)
})

test('만기 요약 — 적금', () => {
  const s = { kind: 'installment', monthly_amount: 1_000_000, term_months: 12, annual_rate: 4, start_date: '2026-01-15', pay_day: 15 }
  const m = maturitySummary(s)
  assert.equal(m.principal, 12_000_000)
  assert.equal(m.interest, 260_000)
  assert.equal(m.total, 12_260_000)
  assert.equal(m.tax, Math.round(260_000 * TAX_RATE))
  assert.equal(m.afterTax, m.total - m.tax)
  assert.equal(m.firstDue, '2026-01-15')
  assert.equal(m.lastDue, '2026-12-15')
})

test('만기 요약 — 예금', () => {
  const s = { kind: 'deposit', principal: 20_000_000, term_months: 6, annual_rate: 3, start_date: '2026-02-01' }
  const m = maturitySummary(s)
  assert.equal(m.principal, 20_000_000)
  assert.equal(m.interest, 300_000)     // 2천만 × 3% × 0.5년
  assert.equal(m.total, 20_300_000)
})

test('만기일 — 가입일 + 기간, 말일 처리 포함', () => {
  assert.equal(maturityDateOf({ start_date: '2026-01-15', term_months: 12 }), '2027-01-15')
  // 1/31 가입 + 1개월 = 2월 말일(2026은 평년이라 28일)
  assert.equal(maturityDateOf({ start_date: '2026-01-31', term_months: 1 }), '2026-02-28')
  assert.equal(maturityDateOf({ start_date: '', term_months: 12 }), null)
  assert.equal(maturityDateOf({ start_date: '2026-01-15', term_months: 0 }), null)
})

test('만기일은 납입일과 무관하다', () => {
  // 납입일을 5일로 잡아도 만기는 가입일 기준
  const a = maturityDateOf({ start_date: '2026-03-20', term_months: 6, pay_day: 5 })
  assert.equal(a, '2026-09-20')
})

test('납입일을 안 정하면 가입일과 같은 날 — 가입일보다 앞설 수 없다', () => {
  // 라우트 기본값(pay_day = 가입일의 '일')과 같은 조건.
  // 예전에 미리보기만 기본을 1로 두어 7/31 가입인데 첫 납입이 7/1로 나왔다.
  const s = { kind: 'installment', monthly_amount: 1_000_000, term_months: 12,
              start_date: '2026-07-31', pay_day: 31 }
  const sch = paymentSchedule(s)
  assert.equal(sch[0].due_date, '2026-07-31')
  assert.ok(sch[0].due_date >= s.start_date, '첫 납입일이 가입일보다 앞서면 안 된다')
  // 말일이라 짧은 달은 그 달 말일로 밀린다
  assert.equal(sch[1].due_date, '2026-08-31')
  assert.equal(sch[7].due_date, '2027-02-28')
})

test('실제로 넣은 돈에만 이자가 붙는다 — 1회만 낸 적금에 12회분 이자를 주면 안 된다', () => {
  // 만기 처리 기본값이 maturitySummary(끝까지 넣었을 때)였을 때 생기던 과대계상.
  const s = { kind: 'installment', monthly_amount: 1_000_000, term_months: 12,
              annual_rate: 4, start_date: '2026-01-01', pay_day: 1 }
  const full = maturitySummary(s).interest            // 260,000 (12회 전부)
  const one = accruedInterest(s, [{ amount: 1_000_000, paid_date: '2026-01-01' }], '2027-01-01')
  assert.equal(full, 260_000)
  assert.equal(one, 40_000)                            // 100만 × 4%/12 × 12개월
  assert.ok(one < full, '납입 실적이 적으면 이자도 적어야 한다')
})

test('끝까지 납입하면 폐쇄식 계산과 같은 값이 나온다', () => {
  const s = { kind: 'installment', monthly_amount: 1_000_000, term_months: 12,
              annual_rate: 4, start_date: '2026-01-01', pay_day: 1 }
  const payments = paymentSchedule(s).map(c => ({ amount: c.amount, paid_date: c.due_date }))
  assert.equal(accruedInterest(s, payments, maturityDateOf(s)), installmentInterest(1_000_000, 4, 12))
})

test('예금 중도해지 — 예치한 기간만큼만 이자가 붙는다', () => {
  const s = { kind: 'deposit', principal: 12_000_000, term_months: 12, annual_rate: 3, start_date: '2026-01-01' }
  assert.equal(accruedInterest(s, [], '2027-01-01'), 360_000)   // 만기: 1200만 × 3%
  assert.equal(accruedInterest(s, [], '2026-07-01'), 180_000)   // 6개월: 절반
  assert.equal(accruedInterest(s, [], '2028-01-01'), 360_000)   // 약정 기간 이상은 안 붙는다
})

test('개월 수는 날짜가 차야 센다', () => {
  assert.equal(monthsBetween('2026-01-31', '2026-02-28'), 0)   // 하루 모자람
  assert.equal(monthsBetween('2026-01-01', '2026-02-01'), 1)
  assert.equal(monthsBetween('2026-01-01', '2025-12-01'), 0)   // 역순은 0
})

/* ── 보증금·퇴직연금: 만기도 이자도 없는 둘 ──────────────────────────
 * fowin 은 퇴직연금 신탁을 '정기예금' 계좌로도, savings 로도 등록해 같은 904,870원이
 * 가용 잔액과 묶인 돈 양쪽에 잡혀 있었다. 계좌 쪽을 걷어내고 여기로 일원화했으니,
 * 이 둘이 만기·이자 계산에서 확실히 빠지는지 잠가 둔다. */

test('구분에 퇴직연금이 있다', () => {
  assert.ok(KINDS.includes('pension'))
  assert.ok(KINDS.includes('guarantee'))
})

test('보증금·퇴직연금은 만기가 없는 종류로 판정된다', () => {
  assert.equal(noMaturity('guarantee'), true)
  assert.equal(noMaturity('pension'), true)
  assert.equal(noMaturity('deposit'), false)
  assert.equal(noMaturity('installment'), false)
})

test('퇴직연금은 이율이 들어와도 이자를 계산하지 않는다', () => {
  // 이율이 잘못 채워져 들어와도(임포트·수기 입력) 0이어야 한다 —
  // 안 그러면 회차가 없는데 적금 분기로 떨어져 조용히 이상한 값이 된다.
  const s = { kind: 'pension', principal: 904_870, term_months: 0, annual_rate: 3, start_date: '2026-08-01' }
  assert.equal(accruedInterest(s, [], '2027-08-01'), 0)
  const g = { kind: 'guarantee', principal: 5_100_000, term_months: 0, annual_rate: 3, start_date: '2026-08-01' }
  assert.equal(accruedInterest(g, [], '2027-08-01'), 0)
})

test('퇴직연금은 회차도 만기일도 없다', () => {
  const s = { kind: 'pension', principal: 904_870, term_months: 0, annual_rate: 0,
              start_date: '2026-08-01', pay_day: 1 }
  assert.deepEqual(paymentSchedule(s), [])
  assert.equal(maturityDateOf(s), null)
  assert.equal(maturitySummary(s).interest, 0)
  assert.equal(maturitySummary(s).maturityDate, null)
})

test('퇴직연금 적립금은 묶인 돈에 원금 그대로 잡힌다', () => {
  // 회차 합계(=0)로 떨어지면 자금현황의 '묶인 자금'에서 통째로 사라진다.
  const s = { kind: 'pension', principal: 904_870, term_months: 0 }
  assert.equal(paidPrincipal(s, []), 904_870)
})
