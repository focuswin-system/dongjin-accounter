/**
 * 운영자 콘솔의 두 자물쇠
 *
 * 이 콘솔은 코드베이스에서 **유일하게 테넌트 격리를 의도적으로 넘는 문**이다.
 * 여기가 뚫리면 회사별 DB 분리도, req.db 규칙도, 권한 게이트도 전부 무의미해진다.
 * 그래서 자물쇠 두 개를 각각 못 박는다.
 *
 *   1) lanOnly       — 사무실 LAN 밖에서는 문이 보이지 않는다
 *   2) platformAuth  — 회사 사용자 토큰으로는 절대 들어올 수 없다
 *
 * 특히 2번이 중요하다. 두 토큰은 **같은 JWT_SECRET 으로 서명**되므로,
 * 구분이 허술하면 회사 마스터의 토큰이 그대로 전 회사를 여는 열쇠가 된다.
 *
 * DB 없이 전부 검증된다.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-admin-gate'

const { test } = require('node:test')
const assert = require('node:assert')
const jwt = require('jsonwebtoken')

const lanOnly = require('../middleware/lanOnly')
const { createPlatformAuth } = require('../middleware/platformAuth')

const { isFromLan } = lanOnly

/** 살아 있는 운영자 계정 하나만 있는 상황 */
const ADMIN = { id: 'a1', username: 'unyoung', name: '운영자' }
const platformAuth = createPlatformAuth({
  findAdmin: async (id) => (id === ADMIN.id ? ADMIN : null),
})

/** 소켓 주소와 헤더로 요청을 흉내낸다 */
const from = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers })

// ── 1) LAN 게이트 ──

test('사무실 LAN 에서는 열린다', () => {
  assert.ok(isFromLan(from('192.168.0.34')))
  assert.ok(isFromLan(from('192.168.1.7')))
  assert.ok(isFromLan(from('10.0.0.5')))
  assert.ok(isFromLan(from('172.16.3.9')))
  assert.ok(isFromLan(from('::ffff:192.168.0.34')), 'IPv6로 표현된 IPv4도 같은 주소다')
})

test('서버 장비에서 직접 여는 것은 열린다 — 거기 닿으려면 이미 SSH가 있어야 한다', () => {
  assert.ok(isFromLan(from('127.0.0.1')))
  assert.ok(isFromLan(from('::1')))
})

test('터널(외부)로 들어온 요청은 막힌다 — 이게 이 게이트의 전부다', () => {
  // cloudflared 는 같은 장비의 localhost 로 전달한다. 소켓만 보면 루프백이라
  // 통과할 뻔한 자리다 — 프록시가 붙인 원 IP 헤더가 '밖에서 왔다'는 증거다.
  assert.strictEqual(isFromLan(from('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' })), false)
  assert.strictEqual(isFromLan(from('::1', { 'x-forwarded-for': '203.0.113.9' })), false)
})

test('공인 IP 에서 직접 오면 막힌다', () => {
  assert.strictEqual(isFromLan(from('203.0.113.9')), false)
  assert.strictEqual(isFromLan(from('8.8.8.8')), false)
  assert.strictEqual(isFromLan(from('')), false)
})

test('LAN 안이라고 헤더를 지어내도 통과시키지 않는다', () => {
  // 판정 근거는 소켓 주소뿐이다. 헤더는 통과 근거로 쓰지 않는다.
  assert.strictEqual(isFromLan(from('203.0.113.9', { 'x-forwarded-for': '192.168.0.10' })), false)
})

test('막을 때는 404 를 준다 — 403 은 여기 뭔가 있다고 알려주는 셈이다', () => {
  let code = null
  const res = { status: (c) => { code = c; return { json: () => {} } } }
  let passed = false
  lanOnly(from('203.0.113.9'), res, () => { passed = true })
  assert.strictEqual(code, 404)
  assert.strictEqual(passed, false)
})

// ── 2) 운영자 인증 ──

const runAuth = (token) => new Promise(resolve => {
  const req = { headers: token ? { authorization: 'Bearer ' + token } : {} }
  const res = { status: (code) => ({ json: (b) => resolve({ code, error: b.error }) }) }
  platformAuth(req, res, () => resolve({ code: 'next', admin: req.admin }))
})

const sign = (claims) => jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '1h' })

test('운영자 토큰은 통과한다', async () => {
  const r = await runAuth(sign({ kind: 'platform', id: 'a1', username: 'unyoung' }))
  assert.strictEqual(r.code, 'next')
  assert.strictEqual(r.admin.username, 'unyoung')
})

test('회사 사용자 토큰으로는 절대 들어올 수 없다', async () => {
  // 같은 비밀키로 서명된 진짜 토큰이다. 구분이 허술하면 여기서 뚫린다.
  const tenant = sign({ id: 'u1', companyId: 'c1', dbName: 'acct_fowin', username: 'admin', role: 'admin' })
  const r = await runAuth(tenant)
  assert.strictEqual(r.code, 403)
})

test('kind 만 갈아끼워도 회사가 실려 있으면 거부한다', async () => {
  // kind 하나만 보면, 훗날 테넌트 토큰에 kind 가 실리는 변경으로 조용히 뚫린다.
  const forged = sign({ kind: 'platform', id: 'u1', companyId: 'c1', username: 'admin' })
  const r = await runAuth(forged)
  assert.strictEqual(r.code, 403, 'companyId 가 실린 토큰은 무조건 거부다')

  const forged2 = sign({ kind: 'platform', id: 'u1', dbName: 'acct_fowin', username: 'admin' })
  assert.strictEqual((await runAuth(forged2)).code, 403)
})

test('토큰이 없거나 서명이 다르면 401', async () => {
  assert.strictEqual((await runAuth(null)).code, 401)
  const wrong = jwt.sign({ kind: 'platform', id: 'a1' }, 'another-secret', { expiresIn: '1h' })
  assert.strictEqual((await runAuth(wrong)).code, 401)
})

test('만료된 운영자 토큰은 401', async () => {
  const expired = jwt.sign(
    { kind: 'platform', id: 'a1', username: 'x', exp: Math.floor(Date.now() / 1000) - 60 },
    process.env.JWT_SECRET)
  assert.strictEqual((await runAuth(expired)).code, 401)
})

test('계정을 지우면 남아 있던 토큰도 곧바로 막힌다', async () => {
  // 토큰만 믿으면 삭제된 운영자가 세션 수명(12시간) 동안 계속 들어온다.
  // 접근을 끊는 순간 실제로 끊겨야 하는 자리다.
  const gone = sign({ kind: 'platform', id: 'deleted-id', username: 'ex-staff' })
  const r = await runAuth(gone)
  assert.strictEqual(r.code, 401)
  assert.match(r.error, /사용할 수 없는/)
})

test('계정 정보는 토큰이 아니라 DB 값을 쓴다', async () => {
  // 토큰에 실린 이름을 그대로 믿으면, 이름이 바뀌어도 옛 값이 감사 기록에 남는다.
  const stale = sign({ kind: 'platform', id: 'a1', username: '옛이름', name: '옛이름' })
  const r = await runAuth(stale)
  assert.strictEqual(r.admin.username, 'unyoung')
})
