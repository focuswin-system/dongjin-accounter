/**
 * 로그인 시도 제한 — 순수 로직 검증 (DB 불필요)
 *
 * 특히 clientIp 는 '보안 판정'이다. 여기가 틀리면 공격자가 헤더를 지어내
 * 제한을 우회하거나, 애먼 정상 IP를 대신 잠글 수 있다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const {
  clientIp, noteFailure, noteSuccess, ipBlockedFor, _thresholds,
} = require('../lib/loginGuard')

const reqFrom = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers })

test('clientIp — LAN 직접 접속은 x-forwarded-for를 믿지 않는다', () => {
  // 사무실 LAN(192.168.0.x)에서 8081로 바로 붙어 헤더를 지어낸 상황.
  // 이걸 믿으면 시도 제한을 무한히 우회할 수 있다.
  const req = reqFrom('192.168.0.77', { 'x-forwarded-for': '1.2.3.4' })
  assert.strictEqual(clientIp(req), '192.168.0.77')
})

test('clientIp — LAN 직접 접속은 cf-connecting-ip도 믿지 않는다', () => {
  const req = reqFrom('192.168.0.77', { 'cf-connecting-ip': '1.2.3.4' })
  assert.strictEqual(clientIp(req), '192.168.0.77')
})

test('clientIp — 터널(루프백) 경유면 cf-connecting-ip가 진짜 주소', () => {
  const req = reqFrom('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' })
  assert.strictEqual(clientIp(req), '203.0.113.9')
})

test('clientIp — 터널 경유이고 CF 헤더가 없으면 XFF 첫 항목', () => {
  const req = reqFrom('::1', { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })
  assert.strictEqual(clientIp(req), '203.0.113.9')
})

test('clientIp — 헤더가 전혀 없으면 소켓 주소', () => {
  assert.strictEqual(clientIp(reqFrom('127.0.0.1')), '127.0.0.1')
})

test('IP 층 — 임계값 미만이면 잠기지 않는다', () => {
  const ip = 'test-under-limit'
  noteSuccess(ip)
  for (let i = 0; i < _thresholds.IP_MAX_FAILS - 1; i++) noteFailure(ip)
  assert.strictEqual(ipBlockedFor(ip), 0)
})

test('IP 층 — 임계값에 도달하면 잠기고 남은 시간을 준다', () => {
  const ip = 'test-at-limit'
  noteSuccess(ip)
  for (let i = 0; i < _thresholds.IP_MAX_FAILS; i++) noteFailure(ip)
  const left = ipBlockedFor(ip)
  assert.ok(left > 0, '잠금 후에는 남은 초가 0보다 커야 한다')
  assert.ok(left <= _thresholds.IP_LOCK_MIN * 60, '남은 초가 잠금 시간을 넘지 않는다')
})

test('IP 층 — 로그인 성공은 누적 실패를 한 번분만 덜어낸다', () => {
  // 같은 사무실(같은 공인 IP)의 다른 사람이 애먼 잠금에 걸리지 않게 하는 장치.
  // 다만 '통째로 지우기'는 아니어야 한다 — 아래 우회 테스트 참고.
  const ip = 'test-decrement'
  noteFailure(ip); noteFailure(ip); noteFailure(ip)
  noteSuccess(ip)
  // 3회 - 1회 = 2회 남았으므로, 임계값까지 남은 횟수는 IP_MAX_FAILS - 2 이다.
  for (let i = 0; i < _thresholds.IP_MAX_FAILS - 3; i++) noteFailure(ip)
  assert.strictEqual(ipBlockedFor(ip), 0, '아직 임계값에 못 미쳐야 한다')
  noteFailure(ip)
  assert.ok(ipBlockedFor(ip) > 0, '한 번 더 실패하면 잠겨야 한다')
})

test('IP 층 — 성공을 끼워넣어도 제한을 우회할 수 없다', () => {
  // 멀티테넌트라 공격자가 '자기 회사의 정상 계정'을 가진 상황이 흔하다.
  // 성공 시 카운터를 통째로 지우면 [29회 공격 → 자기 계정 1회 로그인] 반복으로
  // IP 층이 통째로 무력화된다. 실패가 성공보다 많으면 결국 잠겨야 한다.
  const ip = 'test-no-bypass'
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 5; i++) noteFailure(ip)
    noteSuccess(ip)   // 공격자가 자기 계정으로 로그인해 카운터를 씻으려 시도
  }
  assert.ok(ipBlockedFor(ip) > 0, '실패 50회 · 성공 10회면 잠겨 있어야 한다')
})

test('IP 층 — 윈도우가 지나면 누적이 리셋된다', () => {
  // 오래 전 실패까지 영원히 누적되면 정상 사용자가 언젠가는 잠긴다.
  const ip = 'test-window'
  const t0 = 1_000_000_000_000
  for (let i = 0; i < _thresholds.IP_MAX_FAILS - 1; i++) noteFailure(ip, t0)
  const later = t0 + (_thresholds.IP_WINDOW_MIN + 1) * 60 * 1000
  noteFailure(ip, later)
  assert.strictEqual(ipBlockedFor(ip, later), 0, '윈도우 밖 실패는 잊혀야 한다')
})

test('IP 층 — 잠금은 시간이 지나면 자동으로 풀린다', () => {
  const ip = 'test-expiry'
  const t0 = 2_000_000_000_000
  for (let i = 0; i < _thresholds.IP_MAX_FAILS; i++) noteFailure(ip, t0)
  assert.ok(ipBlockedFor(ip, t0) > 0, '잠긴 직후에는 남은 시간이 있다')
  const after = t0 + (_thresholds.IP_LOCK_MIN * 60 + 1) * 1000
  assert.strictEqual(ipBlockedFor(ip, after), 0, '잠금 시간이 지나면 풀린다')
})

test('IP 층 — IP를 모르면(null) 아무것도 세지 않는다', () => {
  noteFailure(null)
  assert.strictEqual(ipBlockedFor(null), 0)
})

test('임계값이 실사용을 방해하지 않는 범위인지', () => {
  // 정상 사용자는 오타로 3~4번은 틀린다. 계정 임계값이 그보다 낮으면 안 된다.
  assert.ok(_thresholds.ACCOUNT_MAX_FAILS >= 5)
  // IP는 한 사무실을 여러 명이 공유하므로 계정보다 넉넉해야 한다.
  assert.ok(_thresholds.IP_MAX_FAILS > _thresholds.ACCOUNT_MAX_FAILS)
})
