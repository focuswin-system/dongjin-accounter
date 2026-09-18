/* 방향이 둘인 자원의 줄 단위 권한(platform/sidePerms.js).
 * 한 경로를 매출·매입(입금·출금)이 같이 쓸 때, 한쪽 권한만으로 반대쪽 장부를 읽고 쓰던 구멍이 있었다
 * (반복거래·청구서 — 2026-09-18 실측). 여기서 경계가 서는지 DB 없이 본다. */
const { test } = require('node:test')
const assert = require('node:assert')
const { sideGuard } = require('../platform/sidePerms')

const guard = sideGuard(
  { issued: ['billing_issued', 'ar'], received: ['billing_received', 'ap'] },
  { issued: '매출 세금계산서', received: '매입 세금계산서' })

const reqOf = (perms, { roles = ['r1'], method = 'GET', url = '/api/invoices' } = {}) =>
  ({ perms: new Set(perms), permRoles: roles, method, originalUrl: url })

test('한쪽 권한만 있으면 그쪽만 보인다', () => {
  const req = reqOf(['billing_received:view'])
  assert.deepStrictEqual(guard.visible(req), ['received'])
})

test('같은 방향의 다른 자원(미지급금 ap)으로도 그 방향이 열린다', () => {
  const req = reqOf(['ap:view'])
  assert.deepStrictEqual(guard.visible(req), ['received'])
})

test('반대쪽 쓰기는 403 이고 문구에 방향 이름이 들어간다', () => {
  const req = reqOf(['billing_received:view', 'billing_received:create'], { method: 'POST' })
  assert.throws(() => guard.assert(req, 'issued', 'create'), e => e.status === 403 && /매출 세금계산서/.test(e.message))
  assert.doesNotThrow(() => guard.assert(req, 'received', 'create'))
})

test('행위를 안 주면 게이트와 같은 행위(메서드)로 본다 — 조회 권한만으로 삭제 못 한다', () => {
  const req = reqOf(['billing_issued:view'], { method: 'DELETE', url: '/api/invoices/abc' })
  assert.throws(() => guard.assert(req, 'issued'), e => e.status === 403)
})

test('역할이 하나도 없는 계정은 통과 — perm.js 와 같은 결정', () => {
  const req = reqOf([], { roles: [] })
  assert.deepStrictEqual(guard.visible(req), ['issued', 'received'])
  assert.doesNotThrow(() => guard.assert(req, 'issued', 'create'))
})

test('둘 다 있으면 둘 다', () => {
  const req = reqOf(['billing_issued:view', 'billing_received:view'])
  assert.deepStrictEqual(guard.visible(req), ['issued', 'received'])
})
