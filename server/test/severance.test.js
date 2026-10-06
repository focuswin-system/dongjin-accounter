/**
 * 예상 퇴직금(lib/severance.js) — 1일 평균임금 × 30 × 재직일수 ÷ 365, 1년 미만은 대상 아님.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { estimateSeverance, prevMonths } = require('../lib/severance')

test('퇴사한 달 앞의 3개월', () => {
  assert.deepStrictEqual(prevMonths('2026-10', 3), ['2026-07', '2026-08', '2026-09'])
  assert.deepStrictEqual(prevMonths('2026-02', 3), ['2025-11', '2025-12', '2026-01'])
})

test('급여대장 3개월로 계산한다', () => {
  // 2023-10-01 입사 ~ 2026-10-01 마지막 근무 = 양끝 포함 1097일, 7·8·9월 월 3,100,000 → 임금 9,300,000 / 92일
  const r = estimateSeverance({ joinDate: '2023-10-01', leaveDate: '2026-10-01',
    wagesByMonth: { '2026-07': 3100000, '2026-08': 3100000, '2026-09': 3100000 } })
  assert.strictEqual(r.eligible, true)
  assert.strictEqual(r.basis, 'payroll')
  assert.strictEqual(r.serviceDays, 1097)
  assert.strictEqual(r.dayTotal, 92)
  assert.strictEqual(r.amount, Math.round(9300000 / 92 * 30 * 1097 / 365))
})

test('급여대장이 3개월 다 없으면 근로계약 월 임금으로', () => {
  const r = estimateSeverance({ joinDate: '2024-01-02', leaveDate: '2026-10-01', wagesByMonth: { '2026-09': 3000000 }, monthlyFallback: 2500000 })
  assert.strictEqual(r.basis, 'contract')
  assert.strictEqual(r.wageTotal, 7500000)
})

test('1년 미만은 대상이 아니다', () => {
  const r = estimateSeverance({ joinDate: '2026-01-02', leaveDate: '2026-10-01', monthlyFallback: 3000000 })
  assert.strictEqual(r.eligible, false)
  assert.match(r.reason, /1년 미만/)
})

test('만 1년 경계 — 마지막 근무일까지 세면 대상이다(퇴사일은 마지막 근무일)', () => {
  // 2025-10-02 입사 ~ 2026-10-01 마지막 근무 = 365일. 예전 식(퇴사일 제외)은 364일로 '1년 미만'이었다
  const r = estimateSeverance({ joinDate: '2025-10-02', leaveDate: '2026-10-01', monthlyFallback: 3000000 })
  assert.strictEqual(r.serviceDays, 365)
  assert.strictEqual(r.eligible, true)
})

test('날짜 모양이 아니면 계산하지 않는다(NaN 금액이 대상으로 나가지 않게)', () => {
  for (const bad of ['abc', '2026.09.30', '2026-9-3']) {
    const r = estimateSeverance({ joinDate: '2024-01-02', leaveDate: bad, monthlyFallback: 3000000 })
    assert.strictEqual(r.eligible, false)
    assert.strictEqual(r.amount, undefined)
  }
  const back = estimateSeverance({ joinDate: '2026-05-01', leaveDate: '2026-04-01', monthlyFallback: 3000000 })
  assert.strictEqual(back.eligible, false)
})
