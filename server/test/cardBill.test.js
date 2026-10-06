/**
 * 카드 회차 — 결제일 D 에 빠지는 돈은 '지난 결제일 다음날 ~ 이번 결제일' 사용분.
 * 화면(카드 대금)과 자금 예측이 이 한 곳(lib/cardBill.js)을 쓴다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { upcomingCycle, cycleAt } = require('../lib/cardBill')

test('결제일 전이면 이번 달 결제일, 지났으면 다음 달', () => {
  assert.deepStrictEqual(upcomingCycle(4, '2026-10-02'), { payDate: '2026-10-04', prevPay: '2026-09-04', from: '2026-09-05', to: '2026-10-04' })
  assert.strictEqual(upcomingCycle(4, '2026-10-04').payDate, '2026-10-04')   // 결제일 당일은 그날 것
  assert.strictEqual(upcomingCycle(4, '2026-10-05').payDate, '2026-11-04')
})

test('말일 결제(31) — 짧은 달은 그 달 마지막 날', () => {
  assert.deepStrictEqual(cycleAt(2026, 3, 31), { payDate: '2026-03-31', prevPay: '2026-02-28', from: '2026-03-01', to: '2026-03-31' })
  assert.strictEqual(cycleAt(2026, 4, 31).payDate, '2026-04-30')
})

test('연말을 넘는다', () => {
  assert.deepStrictEqual(upcomingCycle(10, '2026-12-15'), { payDate: '2027-01-10', prevPay: '2026-12-10', from: '2026-12-11', to: '2027-01-10' })
  assert.strictEqual(cycleAt(2027, 1, 10).prevPay, '2026-12-10')
})

/* 가짜 db — cardBills 의 세 조회를 SQL 모양으로 가려 돌려준다 */
const fakeDb = ({ init = 0, daily = [], payDay = 4, adjs = [] }) => ({
  async execute(sql) {
    if (sql.includes('FROM accounts a')) return [[{ id: 'c1', name: '카드', card_pay_day: payDay, initial_balance: init }]]
    if (sql.includes('FROM account_adjustments')) return [adjs.map(a => ({ account_id: 'c1', ...a }))]
    if (sql.includes('GROUP BY account_id, LEFT')) return [daily.map(d => ({ account_id: 'c1', n: d.owe ? 1 : 0, paid: 0, owe: 0, ...d }))]
    return [[]]
  },
})
const { cardBills, SHOW_CYCLES } = require('../lib/cardBill')

test('최근 3회차만 보이되, 밀린 회차는 오래돼도 보인다', async () => {
  // 오늘 10/02 → 이번 회차 10/04. 5/04 회차(4/05~5/04)에 쓰고 안 냄, 8월 회차는 쓰고 냄
  const db = fakeDb({ daily: [
    { d: '2026-04-20', owe: 1000 },
    { d: '2026-07-20', owe: 500 },
    { d: '2026-08-04', paid: 500 },
  ] })
  const [b] = await cardBills(db, '2026-10-02')
  const pays = b.cycles.map(c => c.payDate)
  assert.deepStrictEqual(pays, ['2026-05-04', '2026-08-04', '2026-09-04', '2026-10-04'])
  assert.strictEqual(SHOW_CYCLES, 3)
  // 갚은 500 은 **오래된** 5월 회차부터 채운다 → 5월 500 남음, 8월은 미납 500
  assert.strictEqual(b.cycles[0].remain, 500)
  assert.strictEqual(b.cycles[1].status, 'unpaid')
  assert.strictEqual(b.overdue, 1000)
  assert.strictEqual(b.unpaid, 1000)
})

test('결제일 없는 카드 — 미결제는 잔액 그대로(기초잔액을 두 번 세지 않는다)', async () => {
  const [b0] = await cardBills(fakeDb({ init: -500000, payDay: 0 }), '2026-10-02')
  assert.strictEqual(b0.unpaid, 500000)
  const [b1] = await cardBills(fakeDb({ init: -500000, payDay: 0, daily: [{ d: '2026-09-10', owe: 200000 }, { d: '2026-09-20', paid: 100000 }] }), '2026-10-02')
  assert.strictEqual(b1.unpaid, 600000)
})

test('잔액 조정은 계좌 잔액처럼 — 플러스는 미결제를 줄인다', async () => {
  const [b] = await cardBills(fakeDb({ daily: [{ d: '2026-09-10', owe: 300000 }], adjs: [{ d: '2026-09-15', amt: 100000 }] }), '2026-10-02')
  assert.strictEqual(b.unpaid, 200000)
})
