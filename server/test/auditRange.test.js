/**
 * 변경 이력 조회 기간
 *
 * 감사 자료는 '무엇이 없었는지'를 근거로 쓰인다. 그래서 기간 처리가 조용히 틀리면
 * 가장 나쁘다 — 화면에 아무것도 없는 것을 "그 기간엔 아무 일도 없었다"로 읽기 때문이다.
 *
 *   · 기본은 최근 한 달 (전체를 훑으면 정작 최근이 안 보인다)
 *   · 최대 1년 (상한이 없으면 한 번의 조회가 전체 스캔이 된다)
 *   · 상한을 넘으면 **조용히 자르지 않고 거절한다** — 잘린 결과는 거짓말이 된다
 *
 * DB 없이 전부 검증된다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const { resolveRange, buildFilters, DEFAULT_DAYS, MAX_DAYS } = require('../routes/audit')._range

const TODAY = '2026-08-04'

test('아무것도 안 주면 최근 한 달', () => {
  const r = resolveRange({}, TODAY)
  assert.strictEqual(r.to, TODAY)
  assert.strictEqual(r.from, '2026-07-05', `${DEFAULT_DAYS}일 전이어야 한다`)
})

test('종료일만 주면 그날로부터 거슬러 한 달', () => {
  const r = resolveRange({ to: '2026-03-31' }, TODAY)
  assert.strictEqual(r.to, '2026-03-31')
  assert.strictEqual(r.from, '2026-03-01')
})

test('시작일만 주면 오늘까지', () => {
  const r = resolveRange({ from: '2026-08-01' }, TODAY)
  assert.deepStrictEqual(r, { from: '2026-08-01', to: TODAY })
})

test('딱 1년은 허용한다', () => {
  const r = resolveRange({ from: '2025-08-04', to: '2026-08-04' }, TODAY)
  assert.ok(!r.error, '1년은 상한 안이다')
  assert.strictEqual(r.from, '2025-08-04')
})

test('1년을 넘으면 조용히 자르지 않고 거절한다', () => {
  const r = resolveRange({ from: '2024-01-01', to: '2026-08-04' }, TODAY)
  assert.ok(r.error, '넘으면 반드시 오류다')
  assert.match(r.error, /1년/)
  assert.strictEqual(r.from, undefined, '잘린 기간을 결과인 척 돌려주면 안 된다')
})

test('시작일이 종료일보다 뒤면 거절한다', () => {
  const r = resolveRange({ from: '2026-08-04', to: '2026-08-01' }, TODAY)
  assert.ok(r.error)
})

test('날짜 형식이 아니면 무시하고 기본값을 쓴다', () => {
  // 빈 문자열·쓰레기 값이 들어와도 화면이 죽지 않고 기본 기간으로 열려야 한다
  for (const bad of ['', '어제', '2026-13-99xx', null, undefined]) {
    const r = resolveRange({ from: bad, to: bad }, TODAY)
    assert.ok(!r.error, `${bad} 로 오류가 나면 안 된다`)
    assert.strictEqual(r.to, TODAY)
  }
})

test('ISO 시각이 섞여 들어와도 날짜만 쓴다', () => {
  const r = resolveRange({ from: '2026-08-01T09:30:00Z', to: '2026-08-03T22:00:00Z' }, TODAY)
  assert.deepStrictEqual(r, { from: '2026-08-01', to: '2026-08-03' })
})

test('상한은 윤년을 감안한 366일이다', () => {
  assert.strictEqual(MAX_DAYS, 366)
})

// ── 조건 생성 ──

test('기간은 그 날 전체를 포함한다', () => {
  // to 를 그대로 쓰면 종료일 오전 0시까지만 잡혀, 그날 기록이 통째로 빠진다
  const { where, params } = buildFilters({}, { from: '2026-07-01', to: '2026-07-31' })
  assert.ok(params.includes('2026-07-01 00:00:00'))
  assert.ok(params.includes('2026-07-31 23:59:59'), '종료일 하루가 빠지면 안 된다')
  assert.strictEqual(where.length, params.length, '조건과 값 개수가 어긋나면 SQL이 깨진다')
})

test('필터는 값이 있을 때만 조건이 된다', () => {
  const none = buildFilters({}, { from: 'a', to: 'b' })
  assert.strictEqual(none.where.length, 2, '기간 조건 2개뿐')

  const all = buildFilters(
    { action: 'delete', resource: 'transaction', username: 'kyung' }, { from: 'a', to: 'b' })
  assert.strictEqual(all.where.length, 5)
  assert.strictEqual(all.params.length, 5)
  assert.ok(all.params.includes('delete'))
  assert.ok(all.params.includes('kyung'))
})
