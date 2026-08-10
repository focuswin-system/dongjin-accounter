const test = require('node:test')
const assert = require('node:assert')
const { monthRange, weeksOf } = require('../lib/period')

/* 마감일이 바뀌면 표의 '한 달'이 통째로 움직인다 — 실물과 안 맞으면 아무도 못 믿는 표가 된다.
   그래서 경계(월 넘김·해 넘김·짧은 달·주 쪼개기)를 여기서 못 박는다. */

test('마감일 0 이면 달력월 그대로', () => {
  assert.deepStrictEqual(monthRange('2026-07', 0), { from: '2026-07-01', to: '2026-07-31' })
  assert.deepStrictEqual(monthRange('2026-02', 0), { from: '2026-02-01', to: '2026-02-28' })
})

test('마감일 25 면 전달 26 일부터 그 달 25 일까지', () => {
  // 실물 표머리: "주별 총 매입 현황 (매월 25일 마감)"
  assert.deepStrictEqual(monthRange('2026-07', 25), { from: '2026-06-26', to: '2026-07-25' })
  // 해가 바뀌는 경계 — 1월분은 전년 12/26 부터다
  assert.deepStrictEqual(monthRange('2026-01', 25), { from: '2025-12-26', to: '2026-01-25' })
})

test('마감일은 28 을 넘지 않는다 — 짧은 달에 없는 날짜라 그 달만 어긋난다', () => {
  assert.deepStrictEqual(monthRange('2026-03', 31), monthRange('2026-03', 28))
})

test('주 쪼개기 — 월요일 시작, 경계에서 잘린다', () => {
  // 2026-06-26 은 금요일. 첫 주는 금~일(6/26~6/28)로 잘리고 다음 주부터 월~일.
  const w = weeksOf('2026-06-26', '2026-07-25', 1)
  assert.strictEqual(w[0].from, '2026-06-26')
  assert.strictEqual(w[0].to, '2026-06-28')      // 다음 월요일(6/29) 하루 전
  assert.strictEqual(w[1].from, '2026-06-29')
  assert.strictEqual(w[1].to, '2026-07-05')
  // 마지막 주는 기간 끝에서 잘린다
  assert.strictEqual(w[w.length - 1].to, '2026-07-25')
})

test('주 쪼개기 — 일요일 시작이면 경계가 달라진다', () => {
  const w = weeksOf('2026-07-01', '2026-07-31', 0)
  assert.strictEqual(w[0].from, '2026-07-01')
  // 2026-07-01 은 수요일 → 첫 주는 토(7/4)까지, 다음 주가 일요일부터
  assert.strictEqual(w[1].from, '2026-07-05')
})

test('주는 기간을 빈틈없이 덮고 겹치지 않는다', () => {
  const { from, to } = monthRange('2026-07', 25)
  const w = weeksOf(from, to, 1)
  assert.strictEqual(w[0].from, from)
  assert.strictEqual(w[w.length - 1].to, to)
  for (let i = 1; i < w.length; i++) {
    const prevEnd = new Date(`${w[i - 1].to}T00:00:00`)
    const curStart = new Date(`${w[i].from}T00:00:00`)
    assert.strictEqual((curStart - prevEnd) / 86400000, 1, `${w[i - 1].to} 다음은 ${w[i].from} 이어야 한다`)
  }
})
