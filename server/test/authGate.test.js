/**
 * 임시 비밀번호 게이트 — 잘못되면 계정이 영구 잠긴다.
 *
 * 실제로 있었던 사고: 허용 목록을 req.path 로 판정했는데, 이 미들웨어는 두 곳에서 돈다.
 *   · index.js 전역 게이트      → req.path = '/api/auth/users/<id>/password' (전체)
 *   · routes/auth.js 라우트별   → req.path = '/users/<id>/password'          (마운트 벗겨짐)
 * 후자에서 허용 목록이 전부 빗나가 임시 비번 계정이 '내 정보'도 '비번 변경'도 못 하게 됐다.
 * 비번을 바꿀 수 없으니 스스로 풀 방법이 없는 잠금이었다 — 그 두 경로를 모두 테스트한다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-auth-gate'
const jwt = require('jsonwebtoken')
const authMiddleware = require('../middleware/auth')

const tokenFor = (extra = {}) => jwt.sign(
  { id: 'u1', companyId: 'c1', dbName: 'd1', username: 'fwadmin', role: 'admin',
    loginAt: Math.floor(Date.now() / 1000), ...extra },
  process.env.JWT_SECRET, { expiresIn: '1h' })

/** 미들웨어를 한 번 돌려 'next' 또는 상태코드를 돌려준다 */
const run = ({ method = 'GET', path: p, originalUrl, token }) => new Promise(resolve => {
  const req = { method, path: p, originalUrl: originalUrl ?? p, headers: { authorization: 'Bearer ' + token } }
  const res = {
    status: (code) => ({ json: (body) => resolve({ code, error: body.error }) }),
    set: () => {}, cookie: () => {},
  }
  authMiddleware(req, res, (err) => resolve(err ? { code: 500 } : { code: 'next' }))
})

const TEMP = () => tokenFor({ mustChangePw: true })

// ── 라우터 내부(마운트 경로가 벗겨진 상대 경로) — 사고가 났던 자리 ──

test('임시 비번 — 라우터 내부에서도 본인 비번 변경이 허용된다', async () => {
  const r = await run({
    method: 'PUT', path: '/users/u1/password',
    originalUrl: '/api/auth/users/u1/password', token: TEMP(),
  })
  assert.strictEqual(r.code, 'next', `막히면 스스로 잠금을 풀 수 없다: ${r.error}`)
})

test('임시 비번 — 라우터 내부에서도 내 정보 조회가 허용된다', async () => {
  const r = await run({ path: '/me', originalUrl: '/api/auth/me', token: TEMP() })
  assert.strictEqual(r.code, 'next', r.error)
})

test('임시 비번 — 라우터 내부에서도 로그아웃이 허용된다', async () => {
  const r = await run({ path: '/logout', originalUrl: '/api/auth/logout', token: TEMP() })
  assert.strictEqual(r.code, 'next', r.error)
})

// ── 전역 게이트(전체 경로) ──

test('임시 비번 — 전역 게이트에서도 같은 세 경로가 허용된다', async () => {
  for (const [method, p] of [['PUT', '/api/auth/users/u1/password'], ['GET', '/api/auth/me'], ['POST', '/api/auth/logout']]) {
    const r = await run({ method, path: p, token: TEMP() })
    assert.strictEqual(r.code, 'next', `${method} ${p}: ${r.error}`)
  }
})

test('임시 비번 — 그 외 API는 막는다(게이트가 열려버리면 안 된다)', async () => {
  for (const p of ['/api/invoices', '/api/transactions', '/api/auth/users']) {
    const r = await run({ path: p, token: TEMP() })
    assert.strictEqual(r.code, 403, `${p} 는 막혀야 한다`)
  }
})

test('임시 비번 — 남의 비번 변경 경로는 열리지 않는다(PUT만·password만)', async () => {
  // 쿼리스트링을 붙여 우회하거나, 다른 메서드로 통과되면 안 된다
  const cases = [
    { method: 'PATCH', path: '/users/u1/password', originalUrl: '/api/auth/users/u1/password' },
    { method: 'PUT', path: '/users/u1/role', originalUrl: '/api/auth/users/u1/role' },
    { method: 'PUT', path: '/users/u1/password/x', originalUrl: '/api/auth/users/u1/password/x' },
  ]
  for (const c of cases) {
    const r = await run({ ...c, token: TEMP() })
    assert.strictEqual(r.code, 403, `${c.method} ${c.originalUrl} 는 막혀야 한다`)
  }
})

test('임시 비번 — 쿼리스트링이 붙어도 허용 판정이 유지된다', async () => {
  const r = await run({
    method: 'PUT', path: '/users/u1/password',
    originalUrl: '/api/auth/users/u1/password?x=1', token: TEMP(),
  })
  assert.strictEqual(r.code, 'next', r.error)
})

// ── 정상 계정은 영향 없음 ──

test('임시 비번이 아닌 계정은 모든 API를 그대로 쓴다', async () => {
  const ok = tokenFor({ mustChangePw: false })
  for (const p of ['/api/invoices', '/api/transactions', '/api/auth/me']) {
    const r = await run({ path: p, token: ok })
    assert.strictEqual(r.code, 'next', `${p}: ${r.error}`)
  }
})

test('토큰이 없거나 회사 정보가 없으면 401', async () => {
  const noCompany = jwt.sign({ id: 'u1', username: 'x' }, process.env.JWT_SECRET, { expiresIn: '1h' })
  const r = await run({ path: '/api/invoices', token: noCompany })
  assert.strictEqual(r.code, 401, '회사 스코프 없는 토큰은 통과시키면 안 된다')
})
