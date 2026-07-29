/**
 * /api 전역 요청 한도 — 순수 로직 검증 (서버 기동 불필요)
 *
 * 한도 자체보다 중요한 건 'IP를 어떻게 정하느냐'다. 헤더를 그대로 믿으면
 * 한도는 헤더 한 줄로 무력화되므로, loginGuard.clientIp 와 같은 판정을 쓰는지 확인한다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const { apiRateLimit } = require('../lib/rateLimit')

/** 미들웨어를 1회 호출하고 상태코드를 돌려준다(통과하면 0). */
function call(mw, req) {
  let status = 0
  const res = {
    set() {},
    status(c) { status = c; return this },
    json() { return this },
  }
  mw(req, res, () => { status = 0 })
  return status
}

const reqFrom = (peer, headers = {}) => ({
  socket: { remoteAddress: peer }, headers, method: 'GET', originalUrl: '/api/test',
})

test('한도 안에서는 통과한다', () => {
  const mw = apiRateLimit({ max: 3, windowMs: 60_000 })
  const req = reqFrom('127.0.0.1', { 'x-forwarded-for': 'rl-under' })
  assert.strictEqual(call(mw, req), 0)
  assert.strictEqual(call(mw, req), 0)
  assert.strictEqual(call(mw, req), 0)
})

test('한도를 넘으면 429를 준다', () => {
  const mw = apiRateLimit({ max: 3, windowMs: 60_000 })
  const req = reqFrom('127.0.0.1', { 'x-forwarded-for': 'rl-over' })
  for (let i = 0; i < 3; i++) assert.strictEqual(call(mw, req), 0)
  assert.strictEqual(call(mw, req), 429, '4번째는 막혀야 한다')
})

test('IP가 다르면 서로의 한도에 영향을 주지 않는다', () => {
  const mw = apiRateLimit({ max: 2, windowMs: 60_000 })
  const a = reqFrom('127.0.0.1', { 'x-forwarded-for': 'rl-a' })
  const b = reqFrom('127.0.0.1', { 'x-forwarded-for': 'rl-b' })
  call(mw, a); call(mw, a)
  assert.strictEqual(call(mw, a), 429, 'A는 한도 초과')
  assert.strictEqual(call(mw, b), 0, 'B는 영향 없음')
})

test('LAN 직접 접속은 x-forwarded-for로 한도를 우회할 수 없다', () => {
  // 소켓 상대가 루프백이 아니면 헤더를 믿지 않는다 → 같은 LAN IP로 묶여서 함께 센다.
  const mw = apiRateLimit({ max: 2, windowMs: 60_000 })
  const r1 = reqFrom('192.168.0.77', { 'x-forwarded-for': 'spoof-1' })
  const r2 = reqFrom('192.168.0.77', { 'x-forwarded-for': 'spoof-2' })
  const r3 = reqFrom('192.168.0.77', { 'x-forwarded-for': 'spoof-3' })
  assert.strictEqual(call(mw, r1), 0)
  assert.strictEqual(call(mw, r2), 0)
  assert.strictEqual(call(mw, r3), 429, '헤더를 바꿔도 같은 소켓 주소로 세어야 한다')
})
