/**
 * 로그인 세션 수명·갱신 정책
 *
 * 여기가 틀리면 둘 중 하나가 된다 — 일하는 도중에 튕기거나(원래 증상),
 * 토큰이 영원히 살아나 유출돼도 회수할 수 없거나. 양쪽 경계를 다 확인한다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const jwt = require('jsonwebtoken')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-session-spec'
const { signSession, renewedToken, _session } = require('../lib/session')

const HOUR = 3600
const claims = { id: 'u1', companyId: 'c1', dbName: 'db_x', username: 'admin', role: 'admin' }

test('발급된 토큰은 근무일을 덮는 수명을 가진다', () => {
  // 8시간이면 09:00 로그인이 17:00에 끊긴다 — 점심 포함 9시간 근무보다 짧다.
  assert.ok(_session.SESSION_HOURS >= 10, '하루 근무보다는 길어야 한다')
  const decoded = jwt.verify(signSession(claims), process.env.JWT_SECRET)
  const life = decoded.exp - decoded.iat
  assert.strictEqual(life, _session.SESSION_HOURS * HOUR)
})

test('발급 시 최초 로그인 시각(loginAt)이 박힌다', () => {
  const now = 1_800_000_000
  const decoded = jwt.verify(signSession(claims, now), process.env.JWT_SECRET)
  assert.strictEqual(decoded.loginAt, now)
})

test('만료가 멀면 갱신하지 않는다', () => {
  const now = 1_800_000_000
  const payload = { ...claims, loginAt: now, iat: now, exp: now + 5 * HOUR }
  assert.strictEqual(renewedToken(payload, now), null, '5시간이나 남았으면 그대로 쓴다')
})

test('만료가 임박하면 새 토큰을 준다', () => {
  const now = 1_800_000_000
  const payload = { ...claims, loginAt: now - HOUR, iat: now - HOUR, exp: now + 10 * 60 }
  const renewed = renewedToken(payload, now)
  assert.ok(renewed, '10분 남았으면 갱신해야 한다')
  const decoded = jwt.verify(renewed, process.env.JWT_SECRET)
  assert.ok(decoded.exp > payload.exp, '만료가 뒤로 밀려야 한다')
  assert.strictEqual(decoded.username, 'admin', '신원 정보는 그대로 유지된다')
})

test('갱신해도 최초 로그인 시각은 밀리지 않는다', () => {
  // 이게 밀리면 절대 상한이 무의미해지고 토큰이 영원히 살아난다.
  const now = 1_800_000_000
  const loginAt = now - 3 * HOUR
  const payload = { ...claims, loginAt, iat: now - HOUR, exp: now + 10 * 60 }
  const decoded = jwt.verify(renewedToken(payload, now), process.env.JWT_SECRET)
  assert.strictEqual(decoded.loginAt, loginAt)
})

test('최초 로그인으로부터 절대 상한을 넘으면 더는 갱신하지 않는다', () => {
  const now = 1_800_000_000
  const loginAt = now - (_session.ABSOLUTE_MAX_HOURS + 1) * HOUR
  const payload = { ...claims, loginAt, iat: now - HOUR, exp: now + 10 * 60 }
  assert.strictEqual(renewedToken(payload, now), null, '하루가 넘었으면 다시 로그인해야 한다')
})

test('이미 만료된 토큰은 갱신 대상이 아니다', () => {
  const now = 1_800_000_000
  const payload = { ...claims, loginAt: now - HOUR, iat: now - HOUR, exp: now - 10 }
  assert.strictEqual(renewedToken(payload, now), null)
})

test('exp 가 없거나 빈 값이면 아무 일도 하지 않는다', () => {
  assert.strictEqual(renewedToken(null), null)
  assert.strictEqual(renewedToken({}), null)
  assert.strictEqual(renewedToken({ ...claims }), null)
})

test('loginAt 이 없는 옛 토큰은 iat 를 최초 시각으로 본다', () => {
  // 이 기능 배포 전에 발급된 토큰이 살아 있는 동안의 경로.
  const now = 1_800_000_000
  const old = { ...claims, iat: now - (_session.ABSOLUTE_MAX_HOURS + 1) * HOUR, exp: now + 10 * 60 }
  assert.strictEqual(renewedToken(old, now), null, 'iat 기준으로도 상한이 걸려야 한다')

  const recent = { ...claims, iat: now - HOUR, exp: now + 10 * 60 }
  assert.ok(renewedToken(recent, now), '아직 상한 안이면 갱신된다')
})
