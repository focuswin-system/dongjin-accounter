/**
 * 차입금 상환 스케줄 — 원금과 이자를 가르는 계산.
 *
 * 틀려도 화면은 멀쩡하다. 원금을 이자로 잘못 넣으면 비용이 부풀어 손익이 틀리고,
 * 반올림 단수를 정산하지 않으면 다 갚았는데 잔액이 남는다. 둘 다 신고·결산 때나 드러난다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const {
  repaymentSchedule, equalPayment, monthlyRate, dueDateOf,
  remainingPrincipal, scheduleTotals, unpaidCycles,
} = require('../lib/loan')

// 기업은행 운전자금 5,000만 · 연 4.2% · 36개월 · 매월 15일
const LOAN = {
  principal: 50000000, annual_rate: 4.2, term_months: 36,
  start_date: '2026-01-15', pay_day: 15, method: 'equal_payment',
}

test('월이율 — 연이율/12/100, 0%도 유효하다', () => {
  assert.ok(Math.abs(monthlyRate(4.2) - 0.0035) < 1e-12)
  assert.strictEqual(monthlyRate(0), 0)
  assert.strictEqual(monthlyRate(null), 0)
})

/* ── 잔액이 정확히 0으로 끝나는가 (반올림 단수 정산) ── */

test('세 방식 모두 마지막 회차에 잔액이 정확히 0이 된다', () => {
  for (const method of ['equal_payment', 'equal_principal', 'bullet']) {
    const s = repaymentSchedule({ ...LOAN, method })
    assert.strictEqual(s.length, 36, method)
    assert.strictEqual(s[s.length - 1].balance, 0, `${method}: 마지막 잔액이 0이어야 한다`)
    assert.ok(s.every(c => c.balance >= 0), `${method}: 잔액이 음수가 되면 안 된다`)
  }
})

test('상환 원금의 합은 최초 원금과 1원도 어긋나지 않는다', () => {
  for (const method of ['equal_payment', 'equal_principal', 'bullet']) {
    const s = repaymentSchedule({ ...LOAN, method })
    const sum = s.reduce((a, c) => a + c.principal, 0)
    assert.strictEqual(sum, LOAN.principal, `${method}: ${sum}`)
  }
})

test('나누어떨어지지 않는 금액·회차에서도 합이 맞는다', () => {
  const cases = [
    { principal: 10000000, term_months: 7, annual_rate: 3.7 },
    { principal: 33333333, term_months: 13, annual_rate: 5.55 },
    { principal: 1, term_months: 3, annual_rate: 4 },
    { principal: 99999999, term_months: 60, annual_rate: 2.9 },
  ]
  for (const c of cases) {
    for (const method of ['equal_payment', 'equal_principal', 'bullet']) {
      const s = repaymentSchedule({ ...LOAN, ...c, method })
      assert.strictEqual(s.reduce((a, x) => a + x.principal, 0), c.principal,
        `${method} ${c.principal}/${c.term_months}`)
      assert.strictEqual(s[s.length - 1].balance, 0)
    }
  }
})

/* ── 방식별 성격 ── */

test('만기일시 — 만기 전에는 원금을 갚지 않고 이자만 낸다', () => {
  const s = repaymentSchedule({ ...LOAN, method: 'bullet' })
  assert.ok(s.slice(0, -1).every(c => c.principal === 0), '중간 회차 원금은 0')
  assert.ok(s.slice(0, -1).every(c => c.interest > 0), '중간 회차 이자는 있다')
  assert.strictEqual(s[s.length - 1].principal, LOAN.principal, '만기에 원금 전액')
  // 잔액이 안 줄므로 이자는 매월 같다
  assert.strictEqual(s[0].interest, s[10].interest)
})

test('원금균등 — 원금은 고정, 이자는 잔액이 줄며 감소한다', () => {
  const s = repaymentSchedule({ ...LOAN, method: 'equal_principal' })
  assert.strictEqual(s[0].principal, s[1].principal, '원금 고정')
  assert.ok(s[0].interest > s[1].interest, '이자 감소')
  assert.ok(s[0].total > s[1].total, '납입액도 감소')
})

test('원리금균등 — 납입액이 일정하고, 원금 비중이 점점 커진다', () => {
  const s = repaymentSchedule({ ...LOAN, method: 'equal_payment' })
  const pmt = equalPayment(LOAN.principal, LOAN.annual_rate, LOAN.term_months)
  // 마지막 회차는 단수 정산으로 달라질 수 있다 → 그 앞까지 확인
  for (const c of s.slice(0, -1)) {
    assert.ok(Math.abs(c.total - pmt) <= 1, `납입액 ${c.total} vs ${pmt}`)
  }
  assert.ok(s[0].principal < s[20].principal, '원금 비중 증가')
  assert.ok(s[0].interest > s[20].interest, '이자 비중 감소')
})

test('무이자 차입 — 이자가 0이고 원금만 나뉜다(관계사·개인 차입)', () => {
  const s = repaymentSchedule({ ...LOAN, annual_rate: 0, term_months: 10, principal: 10000000 })
  assert.ok(s.every(c => c.interest === 0))
  assert.strictEqual(s.reduce((a, c) => a + c.principal, 0), 10000000)
  assert.strictEqual(s[s.length - 1].balance, 0)
})

test('이자는 직전 잔액 기준으로 계산된다(원금을 깎기 전 잔액)', () => {
  const s = repaymentSchedule({ ...LOAN, method: 'equal_principal' })
  const r = monthlyRate(LOAN.annual_rate)
  assert.strictEqual(s[0].interest, Math.round(LOAN.principal * r), '1회차는 원금 전액에 대한 이자')
  // 2회차 이자는 1회차 상환 후 잔액 기준
  assert.strictEqual(s[1].interest, Math.round(s[0].balance * r))
})

/* ── 상환일 ── */

test('상환일 — 매월 앵커일, 말일은 그 달 말일로 clamp', () => {
  assert.strictEqual(dueDateOf('2026-01-15', 15, 1), '2026-02-15')
  assert.strictEqual(dueDateOf('2026-01-31', 31, 1), '2026-02-28', '2026년 2월은 28일')
  assert.strictEqual(dueDateOf('2024-01-31', 31, 1), '2024-02-29', '윤년')
  assert.strictEqual(dueDateOf('2026-01-31', 31, 3), '2026-04-30', '4월은 30일')
  // clamp가 누적되면 안 된다 — 31일 앵커가 2월을 지나며 28일로 굳지 않아야 한다
  assert.strictEqual(dueDateOf('2026-01-31', 31, 2), '2026-03-31')
})

test('상환일 — 해를 넘어간다', () => {
  assert.strictEqual(dueDateOf('2026-12-15', 15, 1), '2027-01-15')
  assert.strictEqual(dueDateOf('2026-01-15', 15, 36), '2029-01-15')
})

/* ── 잔여 원금·미상환 회차 ── */

test('잔여 원금은 실적 기준이다(스케줄이 아니라 실제 갚은 원금)', () => {
  // 중도상환·연체로 스케줄과 어긋날 수 있으므로 실적으로 센다
  assert.strictEqual(remainingPrincipal(50000000, [{ principal: 1420000 }, { principal: 1425000 }]), 47155000)
  assert.strictEqual(remainingPrincipal(50000000, []), 50000000)
  assert.strictEqual(remainingPrincipal(1000000, [{ principal: 9999999 }]), 0, '음수가 되지 않는다')
})

test('미상환 회차 — 이미 처리한 회차는 빠진다', () => {
  const left = unpaidCycles(LOAN, [1, 2, 3])
  assert.strictEqual(left.length, 33)
  assert.strictEqual(left[0].seq, 4)
})

/* ── 요약 ── */

test('스케줄 합계 — 총 이자를 등록 화면에서 미리 보여줄 수 있다', () => {
  const t = scheduleTotals(LOAN)
  assert.strictEqual(t.months, 36)
  assert.strictEqual(t.principal, LOAN.principal)
  assert.ok(t.interest > 0 && t.interest < LOAN.principal, `이자 ${t.interest}`)
  assert.strictEqual(t.total, t.principal + t.interest)
  assert.strictEqual(t.firstDue, '2026-02-15')
  assert.strictEqual(t.lastDue, '2029-01-15')
})

test('원금 0·회차 0이면 스케줄이 없다(빈 배열, 예외 아님)', () => {
  assert.deepStrictEqual(repaymentSchedule({ ...LOAN, principal: 0 }), [])
  assert.deepStrictEqual(repaymentSchedule({ ...LOAN, term_months: 0 }), [])
  assert.deepStrictEqual(repaymentSchedule({}), [])
})
