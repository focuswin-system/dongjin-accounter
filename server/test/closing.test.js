/**
 * 월 마감(기간 잠금)
 *
 * 부가세 신고를 끝낸 달의 거래가 바뀌면 제출 자료와 장부가 조용히 어긋난다.
 * 특히 '옮기기'가 위험하다 — 한쪽 날짜만 검사하면 잠긴 달에서 거래를 빼내거나
 * 밀어넣을 수 있다. 그 경로를 중점적으로 본다.
 *
 * db 는 인자로 받으므로 가짜 객체로 검증한다(실제 DB 불필요).
 */
const { test } = require('node:test')
const assert = require('node:assert')

const { isPeriodClosed, closedPeriodError, monthOf } = require('../lib/closing')

/** 잠긴 달 목록을 흉내내는 가짜 테넌트 연결. 조회된 기간을 기록한다. */
function fakeDb(closedMonths = []) {
  const asked = []
  return {
    asked,
    async execute(_sql, [period]) {
      asked.push(period)
      return [closedMonths.includes(period) ? [{ id: 'x' }] : []]
    },
  }
}

test('monthOf — 날짜에서 YYYY-MM 을 뽑는다', () => {
  assert.strictEqual(monthOf('2026-07-29'), '2026-07')
  assert.strictEqual(monthOf('2026-07-29T10:00:00Z'), '2026-07')
  assert.strictEqual(monthOf(null), '')
  assert.strictEqual(monthOf(''), '')
})

test('isPeriodClosed — 잠긴 달이면 true', async () => {
  const db = fakeDb(['2026-06'])
  assert.strictEqual(await isPeriodClosed(db, '2026-06-15'), true)
  assert.strictEqual(await isPeriodClosed(db, '2026-07-15'), false)
})

test('isPeriodClosed — 날짜 형식이 깨지면 DB를 조회하지 않고 false', async () => {
  const db = fakeDb(['2026-06'])
  assert.strictEqual(await isPeriodClosed(db, '엉터리'), false)
  assert.strictEqual(await isPeriodClosed(db, null), false)
  assert.strictEqual(await isPeriodClosed(db, ''), false)
  assert.deepStrictEqual(db.asked, [], '형식이 틀리면 조회 자체를 하지 않아야 한다')
})

test('closedPeriodError — 잠긴 달이면 사용자에게 보여줄 문구를 준다', async () => {
  const db = fakeDb(['2026-06'])
  const err = await closedPeriodError(db, '2026-06-15')
  assert.ok(err && err.includes('2026-06'), '어느 달인지 알려줘야 한다')
  assert.ok(err.includes('마감'), '마감 때문임을 알려줘야 한다')
})

test('closedPeriodError — 열린 달이면 null', async () => {
  const db = fakeDb(['2026-06'])
  assert.strictEqual(await closedPeriodError(db, '2026-07-15'), null)
})

test('closedPeriodError — 잠긴 달에서 열린 달로 빼내는 것을 막는다', async () => {
  // 옮기기: 이전 날짜가 잠긴 달. 새 날짜만 보면 통과해버린다.
  const db = fakeDb(['2026-06'])
  const err = await closedPeriodError(db, '2026-06-15', '2026-07-15')
  assert.ok(err, '이전 날짜가 잠겨 있으면 막아야 한다')
})

test('closedPeriodError — 열린 달에서 잠긴 달로 밀어넣는 것을 막는다', async () => {
  // 반대 방향. 이전 날짜만 보면 통과해버린다.
  const db = fakeDb(['2026-06'])
  const err = await closedPeriodError(db, '2026-07-15', '2026-06-15')
  assert.ok(err, '새 날짜가 잠긴 달이면 막아야 한다')
})

test('closedPeriodError — 빈 날짜는 건너뛴다', async () => {
  const db = fakeDb(['2026-06'])
  assert.strictEqual(await closedPeriodError(db, null, '2026-07-15', ''), null)
})

test('closedPeriodError — 둘 다 열린 달이면 통과', async () => {
  const db = fakeDb(['2026-06'])
  assert.strictEqual(await closedPeriodError(db, '2026-07-15', '2026-08-15'), null)
})
