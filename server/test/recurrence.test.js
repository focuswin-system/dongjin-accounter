/**
 * 정기 반복일 계산 — 정기청구·정기지출 공용
 *
 * 여기가 틀리면 조용히 아프다. 회차가 안 나오면 그 달 매출이 미청구로 사라지고,
 * 과하게 나오면 없는 청구서가 수백 건 쏟아진다. 둘 다 실제로 있었던 사고라
 * 그 사고들을 그대로 테스트로 박아둔다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const { dueDatesToGenerate, daysInMonth, addDays, fmtDate } = require('../lib/recurrence')

// ── 날짜 헬퍼 ──

test('daysInMonth — 윤년 2월을 구분한다', () => {
  assert.strictEqual(daysInMonth(2024, 1), 29, '2024는 윤년')
  assert.strictEqual(daysInMonth(2026, 1), 28)
  assert.strictEqual(daysInMonth(2026, 3), 30, '4월은 30일')
  assert.strictEqual(daysInMonth(2026, 0), 31)
})

test('addDays — 달·해를 넘어간다', () => {
  assert.strictEqual(addDays('2026-01-31', 1), '2026-02-01')
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01')
  assert.strictEqual(addDays('2026-03-01', -1), '2026-02-28')
  assert.strictEqual(addDays('2024-03-01', -1), '2024-02-29', '윤년')
})

test('fmtDate — UTC 변환을 타지 않는다(KST 경계)', () => {
  // toISOString() 을 쓰면 KST 자정 직후가 전날로 밀린다. 로컬 캘린더 기준이어야 한다.
  assert.strictEqual(fmtDate(new Date(2026, 6, 29, 0, 30)), '2026-07-29')
  assert.strictEqual(fmtDate(new Date(2026, 6, 29, 23, 59)), '2026-07-29')
})

// ── 회차 생성 ──

test('월간 — 앵커일을 유지하며 오늘까지만 만든다', () => {
  const out = dueDatesToGenerate(
    { start_date: '2026-01-10', period: 'monthly', day_of_month: 10 }, '2026-04-15')
  assert.deepStrictEqual(out, ['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10'])
})

test('월말 앵커(31일) — 짧은 달은 clamp 하되 드리프트가 누적되지 않는다', () => {
  // 과거 버그: 오버플로가 누적돼 회차가 며칠씩 밀리고 결국 누락됐다.
  // 각 회차는 원 앵커의 '절대 월'로 재계산되므로 긴 달에서는 다시 31일이어야 한다.
  const out = dueDatesToGenerate(
    { start_date: '2026-01-31', period: 'monthly', day_of_month: 31 }, '2026-05-31')
  assert.deepStrictEqual(out, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'])
})

test('분기·연간 — period 를 무시하지 않는다', () => {
  // 과거 버그: 지출 쪽이 period 를 무시해 분기/연 계약이 매달 생성됐다.
  const q = dueDatesToGenerate(
    { start_date: '2026-01-15', period: 'quarterly', day_of_month: 15 }, '2026-12-31')
  assert.deepStrictEqual(q, ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15'])

  const y = dueDatesToGenerate(
    { start_date: '2024-03-01', period: 'yearly', day_of_month: 1 }, '2026-12-31')
  assert.deepStrictEqual(y, ['2024-03-01', '2025-03-01', '2026-03-01'])
})

test('last_generated 이하 회차는 다시 만들지 않는다', () => {
  const out = dueDatesToGenerate(
    { start_date: '2026-01-10', period: 'monthly', day_of_month: 10, last_generated: '2026-02-10' },
    '2026-04-15')
  assert.deepStrictEqual(out, ['2026-03-10', '2026-04-10'])
})

test('setup_date 이전 회차는 소급하지 않는다', () => {
  // 실제 사고: 2003년 시작 무기한 계약이 등록 즉시 수백 건으로 쏟아졌다.
  // 등록한 날부터만 청구해야 한다.
  const out = dueDatesToGenerate(
    { start_date: '2003-05-01', period: 'monthly', day_of_month: 1, setup_date: '2026-06-15' },
    '2026-08-31')
  assert.deepStrictEqual(out, ['2026-07-01', '2026-08-01'])
})

test('end_date 를 넘으면 중단한다', () => {
  const out = dueDatesToGenerate(
    { start_date: '2026-01-10', period: 'monthly', day_of_month: 10, end_date: '2026-03-31' },
    '2026-12-31')
  assert.deepStrictEqual(out, ['2026-01-10', '2026-02-10', '2026-03-10'])
})

test('horizonDays — 미래 회차 미리보기(기본은 오늘까지만)', () => {
  const rec = { start_date: '2026-01-10', period: 'monthly', day_of_month: 10 }
  const base = dueDatesToGenerate(rec, '2026-03-01')
  assert.deepStrictEqual(base, ['2026-01-10', '2026-02-10'], '기본은 미래를 포함하지 않는다')

  const ahead = dueDatesToGenerate(rec, '2026-03-01', { horizonDays: 35 })
  assert.deepStrictEqual(ahead, ['2026-01-10', '2026-02-10', '2026-03-10'],
    '월간은 다음 회차가 한 번 미리 보여야 한다')
})

test('start_date 가 없거나 형식이 깨지면 빈 배열', () => {
  assert.deepStrictEqual(dueDatesToGenerate({ period: 'monthly' }, '2026-04-15'), [])
  assert.deepStrictEqual(dueDatesToGenerate({ start_date: '' }, '2026-04-15'), [])
  assert.deepStrictEqual(dueDatesToGenerate({ start_date: '엉터리' }, '2026-04-15'), [])
})

test('day_of_month 가 없으면 start_date 의 일자를 앵커로 쓴다', () => {
  const out = dueDatesToGenerate({ start_date: '2026-01-07', period: 'monthly' }, '2026-03-31')
  assert.deepStrictEqual(out, ['2026-01-07', '2026-02-07', '2026-03-07'])
})

test('today 를 문자열로 주든 Date 로 주든 같은 결과', () => {
  const rec = { start_date: '2026-01-10', period: 'monthly', day_of_month: 10 }
  const asStr = dueDatesToGenerate(rec, '2026-03-15')
  const asDate = dueDatesToGenerate(rec, new Date(2026, 2, 15))
  assert.deepStrictEqual(asStr, asDate)
})

test('아직 시작 전이면 아무것도 만들지 않는다', () => {
  const out = dueDatesToGenerate(
    { start_date: '2027-01-01', period: 'monthly', day_of_month: 1 }, '2026-07-29')
  assert.deepStrictEqual(out, [])
})
