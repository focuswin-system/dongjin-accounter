/**
 * 권한 매핑 규칙 — 조용히 틀리면 무권한 통과가 된다.
 * 게이트 자체(middleware/perm.js)는 DB가 필요하므로 스모크로, 규칙은 여기서 검증한다.
 */
const test = require('node:test')
const assert = require('node:assert')
const {
  requiredPerm, actionFor, prefixOf, unknownResources, API_RESOURCES,
} = require('../platform/apiPerms')

test('메서드 → 행위 기본 매핑', () => {
  assert.equal(requiredPerm('GET', '/api/contracts').action, 'view')
  assert.equal(requiredPerm('POST', '/api/contracts').action, 'create')
  assert.equal(requiredPerm('PUT', '/api/contracts/1').action, 'edit')
  assert.equal(requiredPerm('PATCH', '/api/contracts/1').action, 'edit')
  assert.equal(requiredPerm('DELETE', '/api/contracts/1').action, 'delete')
})

test('기준정보 — 조회는 공용, 쓰기는 그 자원 권한', () => {
  // 거래 하나 등록하려면 거래처·계정과목 목록을 읽어야 한다.
  // 이걸 기준정보 화면 권한으로 막으면 드롭다운이 전부 비어 아무것도 못 한다.
  assert.equal(requiredPerm('GET', '/api/vendors'), null)
  assert.equal(requiredPerm('GET', '/api/account-subjects?postable=1'), null)
  assert.equal(requiredPerm('GET', '/api/ref-items'), null)
  // 쓰기는 그대로 막힌다
  assert.deepEqual(requiredPerm('POST', '/api/vendors'), { resources: ['master_vendor'], action: 'create' })
  assert.equal(requiredPerm('DELETE', '/api/vendors/1').action, 'delete')
  // 내려받기·업로드도 공용이 아니다(대량 반출은 조회와 다르다)
  assert.equal(requiredPerm('GET', '/api/vendors/export.xlsx').action, 'download')
  assert.equal(requiredPerm('POST', '/api/vendors/import/commit').action, 'upload')
})

test('엑셀 일괄 등록은 create가 아니라 upload다', () => {
  // POST지만 '등록' 권한만 있는 사람이 수백 건을 한 번에 넣을 수 있으면 안 된다
  assert.equal(actionFor('POST', '/api/invoices/import/parse'), 'upload')
  assert.equal(actionFor('POST', '/api/invoices/import/commit'), 'upload')
  assert.equal(actionFor('GET', '/api/invoices/import/template'), 'download')
})

test('내려받기·인쇄는 별도 행위', () => {
  assert.equal(actionFor('GET', '/api/transactions/export.xlsx'), 'download')
  assert.equal(actionFor('GET', '/api/resolutions/12/print'), 'export')
})

test('쿼리스트링이 붙어도 prefix를 찾는다', () => {
  // 게이트는 ?를 잘라 넘기지만, prefix 추출 자체가 앞부분만 보는지 확인
  assert.equal(prefixOf('/api/payroll-items'), '/api/payroll-items')
  assert.equal(prefixOf('/api/work-contracts/3/lines'), '/api/work-contracts')
  assert.equal(prefixOf('/uploads/a.png'), null)
})

test('auth·uploads 는 자원 검사 대상이 아니다', () => {
  // 여길 자원으로 가르면 로그인·비번변경이 권한에 걸려 계정이 잠긴다
  assert.equal(requiredPerm('GET', '/api/auth/me'), null)
  assert.equal(requiredPerm('POST', '/api/uploads'), null)
})

test('매핑 없는 경로는 null(통과) — 막지 않는다', () => {
  // 막으면 매핑을 빠뜨린 순간 화면이 죽는다. 빠뜨림은 check:isolation 이 잡는다.
  assert.equal(requiredPerm('GET', '/api/nonexistent'), null)
})

test('청구서 라우터는 네 화면을 함께 관장한다', () => {
  const need = requiredPerm('GET', '/api/invoices')
  assert.deepEqual(need.resources, ['billing_issued', 'billing_received', 'ar', 'ap'])
})

test('매핑에 쓰인 자원이 전부 카탈로그에 있다', () => {
  assert.deepEqual(unknownResources(), [])
})

test('자원 목록이 빈 매핑은 없다 — 있으면 아무도 통과 못 한다', () => {
  for (const [prefix, list] of Object.entries(API_RESOURCES)) {
    assert.ok(Array.isArray(list) && list.length, `${prefix} 자원 목록이 비었다`)
  }
})

test('직원 전체 목록은 공용이 아니다 — 급여·생년월일·급여계좌가 들어 있다', () => {
  // /api/employees 를 통째로 LOOKUP 에 넣었더니, 인사가 차단된 경리 역할도
  // 전 직원 기본급을 볼 수 있었다(SELECT * 이라 salary_account 까지 나갔다).
  const need = requiredPerm('GET', '/api/employees')
  assert.ok(need, '직원 목록은 권한 검사를 거쳐야 한다')
  assert.deepEqual(need.resources, ['hr'])
  assert.equal(requiredPerm('GET', '/api/employees/options'), null)   // 고르기용 최소 목록만 공용
})

test('계좌 목록은 공용이되 잔액은 라우트가 따로 가린다', () => {
  // 결제수단이라 목록 자체는 열어야 한다. 잔액 차단은 routes/accounts.js canSeeBalance 소관.
  assert.equal(requiredPerm('GET', '/api/accounts'), null)
  assert.equal(requiredPerm('POST', '/api/accounts').action, 'create')
})
