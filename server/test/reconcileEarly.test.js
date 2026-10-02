/**
 * 1일 발행·말일 수금 — 지난달 말일 입금을 이번 달 청구서의 '확실한 짝'으로 고르지 않는다.
 * 운영 fowin(2026-09): 9/1 청구서에 8/31 입금이 붙어 그 뒤로 매달 한 달씩 밀렸다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { scorePair, isSure } = require('../lib/reconcile')

const inv = { vendor_id: 'v1', issued_at: '2026-09-01', due_at: '2026-10-01', remain: 110000, total: 110000, supply: 100000 }
const pay = (date) => ({ vendor_id: 'v1', date, amount: 110000, used: 0 })

test('같은 달 말일 입금이 지난달 말일 입금보다 점수가 높다', () => {
  assert.ok(scorePair(inv, pay('2026-09-30')).score > scorePair(inv, pay('2026-08-31')).score)
})

test('발행일보다 앞선 입금은 미리 골라 두지 않는다 — 후보로는 남는다', () => {
  const early = scorePair(inv, pay('2026-08-31'))
  assert.ok(early.score > 0, '후보에서 아예 빠지면 선불을 못 붙인다')
  assert.strictEqual(isSure(inv, pay('2026-08-31'), early.why), false)
  assert.strictEqual(isSure(inv, pay('2026-09-30'), scorePair(inv, pay('2026-09-30')).why), true)
})

const { markClearSure } = require('../lib/reconcile')
test('확실한 짝이 둘이면 둘 다 확실하지 않다(tie) — 같은 금액 입금이 두 번', () => {
  const two = markClearSure([{ id: 1, sure: true }, { id: 2, sure: true }, { id: 3, sure: false }])
  assert.deepStrictEqual(two.map(x => [x.sure, !!x.tie]), [[false, true], [false, true], [false, false]])
  const one = markClearSure([{ id: 1, sure: true }, { id: 2, sure: false }])
  assert.deepStrictEqual(one.map(x => [x.sure, !!x.tie]), [[true, false], [false, false]])
})
