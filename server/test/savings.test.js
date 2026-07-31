/**
 * 예적금 계산 — 숫자가 조용히 틀리면 사용자가 만기에 가서야 안다.
 * 특히 적금 이자는 흔한 계산 실수(총납입 × 이율 × 기간)로 2배 가까이 부풀려진다.
 */
const test = require('node:test')
const assert = require('node:assert')
const {
  installmentInterest, depositInterest, paymentSchedule, unpaidPayments,
  paidPrincipal, maturitySummary, maturityDateOf, TAX_RATE,
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
