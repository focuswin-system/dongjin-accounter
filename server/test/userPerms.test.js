/**
 * 권한 조회·캐시 — 캐시가 틀리면 '권한을 뺐는데 계속 쓰는' 상태가 된다.
 * DB는 가짜 풀로 대신한다(쿼리 결과만 필요).
 */
const test = require('node:test')
const assert = require('node:assert')
const { loadUserPerms, invalidate, canAny, canAccess, toClientShape } = require('../platform/userPerms')

const fakeDb = (rows) => {
  let calls = 0
  return { execute: async () => { calls++; return [rows] }, calls: () => calls }
}

const ROWS = [
  { role_name: '경리', resource: 'ledger', action: 'access' },
  { role_name: '경리', resource: 'ledger', action: 'view' },
  { role_name: '경리', resource: 'ledger', action: 'create' },
  { role_name: '경리', resource: 'ar', action: 'access' },
]

test('역할 권한을 합집합으로 읽는다', async () => {
  invalidate()
  const db = fakeDb(ROWS)
  const { perms, roles } = await loadUserPerms(db, { companyId: 'c1', userId: 'u1' })
  assert.deepEqual(roles, ['경리'])
  assert.ok(perms.has('ledger:create'))
  assert.ok(!perms.has('ledger:delete'))
})

test('TTL 안에서는 다시 쿼리하지 않는다', async () => {
  invalidate()
  const db = fakeDb(ROWS)
  await loadUserPerms(db, { companyId: 'c1', userId: 'u2' })
  await loadUserPerms(db, { companyId: 'c1', userId: 'u2' })
  assert.equal(db.calls(), 1)
})

test('invalidate 후에는 다시 읽는다 — 권한 변경이 즉시 반영돼야 한다', async () => {
  invalidate()
  const db = fakeDb(ROWS)
  await loadUserPerms(db, { companyId: 'c1', userId: 'u3' })
  invalidate({ companyId: 'c1', userId: 'u3' })
  await loadUserPerms(db, { companyId: 'c1', userId: 'u3' })
  assert.equal(db.calls(), 2)
})

test('회사 단위 invalidate 는 다른 회사 캐시를 건드리지 않는다', async () => {
  invalidate()
  const db = fakeDb(ROWS)
  await loadUserPerms(db, { companyId: 'cA', userId: 'u1' })
  await loadUserPerms(db, { companyId: 'cB', userId: 'u1' })
  invalidate({ companyId: 'cA' })
  await loadUserPerms(db, { companyId: 'cB', userId: 'u1' })   // 캐시 히트여야 한다
  assert.equal(db.calls(), 2)
})

test('캐시 키가 회사까지 포함한다 — 같은 userId라도 회사가 다르면 별개', async () => {
  // 같은 사람이 여러 회사에 있을 수 있고, 섞이면 남의 회사 권한으로 동작한다
  invalidate()
  const db = fakeDb(ROWS)
  await loadUserPerms(db, { companyId: 'cX', userId: 'same' })
  await loadUserPerms(db, { companyId: 'cY', userId: 'same' })
  assert.equal(db.calls(), 2)
})

test('권한이 없는 역할(LEFT JOIN NULL)도 역할로는 잡힌다', async () => {
  // 역할은 있는데 권한이 0개 = 아무것도 못 한다. '역할 없음'(전체 허용)과 구별돼야 한다.
  invalidate()
  const db = fakeDb([{ role_name: '빈역할', resource: null, action: null }])
  const { perms, roles } = await loadUserPerms(db, { companyId: 'c1', userId: 'u9' })
  assert.deepEqual(roles, ['빈역할'])
  assert.equal(perms.size, 0)
})

test('canAny — 자원군 중 하나만 있어도 통과', () => {
  const perms = new Set(['ar:view'])
  assert.ok(canAny(perms, ['billing_issued', 'ar'], 'view'))
  assert.ok(!canAny(perms, ['billing_issued', 'ap'], 'view'))
  assert.ok(!canAny(perms, ['ar'], 'delete'))
})

test('canAccess', () => {
  assert.ok(canAccess(new Set(['ledger:access']), 'ledger'))
  assert.ok(!canAccess(new Set(['ledger:view']), 'ledger'))
})

test('toClientShape — 자원별 행위 목록', () => {
  const { perms } = toClientShape({
    perms: new Set(['ledger:view', 'ledger:create', 'ar:access']), roles: ['경리'],
  })
  assert.deepEqual(perms.ledger, ['create', 'view'])
  assert.deepEqual(perms.ar, ['access'])
})
