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

test('반복거래 미리보기는 조회, 만들기는 등록', () => {
  assert.equal(actionFor('POST', '/api/repeat-templates/preview'), 'view')
  assert.equal(actionFor('POST', '/api/repeat-templates/create'), 'create')
  assert.equal(requiredPerm('POST', '/api/repeat-templates/preview').action, 'view')
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

test('회사 정보 조회는 공용, 수정·미리보기는 환경설정 권한', () => {
  // 인쇄물 머리글·첫 설정 판정에 쓰인다 — 권한 없는 직원의 인쇄물에서 공급자 칸이 비면 안 된다
  assert.equal(requiredPerm('GET', '/api/company'), null)
  assert.deepEqual(requiredPerm('PUT', '/api/company'), { resources: ['settings'], action: 'edit' })
  assert.deepEqual(requiredPerm('GET', '/api/company/fiscal-preview').resources, ['settings'])
  assert.deepEqual(requiredPerm('GET', '/api/company/accounting-prefs').resources, ['settings'])
})

test('계좌 목록은 공용이되 잔액은 라우트가 따로 가린다', () => {
  // 결제수단이라 목록 자체는 열어야 한다. 잔액 차단은 routes/accounts.js canSeeBalance 소관.
  assert.equal(requiredPerm('GET', '/api/accounts'), null)
  assert.equal(requiredPerm('POST', '/api/accounts').action, 'create')
})

/* ── 경로별 자원 재정의(RESOURCE_OVERRIDES) ──
 *
 * 한 라우터가 여러 화면을 받으면 접두사 하나로는 못 가른다. '카드 대금'·'내부 이체'는
 * /api/transactions 로 저장하는데, 이 두 자원을 접두사 목록에 더하면 그 권한 하나로
 * 전 거래를 다루게 되고, 빼면 화면이 통째로 403 이 된다. 두 사고를 다 겪었으므로
 * **열어야 하는 문과 열면 안 되는 문을 둘 다** 못박는다. */
const hasRes = (need, r) => !!need && need.resources.includes(r)

test('카드 대금·내부 이체 화면이 쓰는 문은 열려 있다', () => {
  // 목록을 못 읽으면 '갚을 카드'도 '이체 이력'도 못 그린다 — 화면이 통째로 빈다
  assert.ok(hasRes(requiredPerm('GET', '/api/transactions'), 'card_payment'))
  assert.ok(hasRes(requiredPerm('GET', '/api/transactions'), 'transfer'))
  // 이체 두 줄 만들기 — 두 화면의 주 동작
  assert.ok(hasRes(requiredPerm('POST', '/api/transactions/transfer'), 'card_payment'))
  assert.ok(hasRes(requiredPerm('POST', '/api/transactions/transfer'), 'transfer'))
  // 명세서 업로드는 parse → card 가 한 쌍이다. 파싱만 막으면 파일 고르는 순간 멈춘다
  assert.ok(hasRes(requiredPerm('POST', '/api/transactions/import/parse'), 'card_payment'))
  assert.ok(hasRes(requiredPerm('POST', '/api/transactions/import/card'), 'card_payment'))
  // 이체 내역 엑셀
  assert.ok(hasRes(requiredPerm('GET', '/api/transactions/transfers.xlsx'), 'transfer'))
})

test('그 두 자원으로 거래를 새로 등록하거나 고칠 수는 없다', () => {
  // 화면에 없는 동작까지 열리면 '카드값 갚기' 권한이 사실상 거래내역 전권이 된다
  assert.ok(!hasRes(requiredPerm('POST', '/api/transactions'), 'card_payment'))
  assert.ok(!hasRes(requiredPerm('POST', '/api/transactions'), 'transfer'))
  assert.ok(!hasRes(requiredPerm('PUT', '/api/transactions/abc'), 'card_payment'))
  assert.ok(!hasRes(requiredPerm('PATCH', '/api/transactions/abc/status'), 'card_payment'))
  // 엑셀 일괄 등록(통장 거래)은 거래내역 몫이다
  assert.ok(!hasRes(requiredPerm('POST', '/api/transactions/import/commit'), 'card_payment'))
})

test('삭제는 경로로 못 가르므로 라우트가 한 번 더 본다', () => {
  // 경로만으로는 그 거래가 이체인지 알 수 없어 게이트는 열어 두고,
  // routes/transactions.js 의 transferOnlyGuard 가 '이체로 만든 줄'로 좁힌다.
  assert.ok(hasRes(requiredPerm('DELETE', '/api/transactions/abc'), 'card_payment'))
  assert.equal(requiredPerm('DELETE', '/api/transactions/abc').action, 'delete')
})

test('일괄 등록은 create 가 아니라 upload 다 — 카드 경로도 마찬가지', () => {
  // upload 를 일부러 안 준 역할이 API 를 직접 쳐서 게이트를 우회하면 안 된다
  assert.equal(requiredPerm('POST', '/api/transactions/import/commit').action, 'upload')
  assert.equal(requiredPerm('POST', '/api/transactions/import/card').action, 'upload')
  assert.equal(requiredPerm('POST', '/api/transactions/import/parse').action, 'upload')
})
