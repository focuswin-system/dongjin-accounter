/* 회사별 기능(entitlement) 판정 — 요금제 묶음 + 회사별 낱개.
 *
 * 이 판정이 틀리면 두 방향 모두 사고다:
 *   느슨하면 → 안 켜 준 회사가 유료 양식을 본다(팔 수 없게 된다)
 *   빡빡하면 → 켜 준 회사가 못 본다(항의가 들어온다)
 * 그래서 DB 없이 도는 순수 함수로 떼어 두고 여기서 못 박는다.
 */
const test = require('node:test')
const assert = require('node:assert')
const { mergeFeatures } = require('../lib/entitlements')
const { visibleReports, BUILTIN_REPORTS, featureKeyOf } = require('../platform/reportCatalog')

const TODAY = '2026-08-14'

/* ── 기능 병합 ── */

test('요금제가 준 것 + 회사별로 켠 것이 합쳐진다', () => {
  const f = mergeFeatures(['report:a'], [{ feature_key: 'report:b', enabled: 1 }], TODAY)
  assert.deepStrictEqual([...f].sort(), ['report:a', 'report:b'])
})

test('enabled=0 은 요금제로 받은 것도 회수한다 — 사용 중지·계약 해지 자리', () => {
  const f = mergeFeatures(['report:a'], [{ feature_key: 'report:a', enabled: 0 }], TODAY)
  assert.strictEqual(f.has('report:a'), false)
})

test('기간 밖(시작 전·만료 후)은 없는 것으로 본다', () => {
  const before = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, starts_on: '2026-09-01' }], TODAY)
  assert.strictEqual(before.has('report:x'), false)
  const after = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, expires_on: '2026-08-13' }], TODAY)
  assert.strictEqual(after.has('report:x'), false)
  const now = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, starts_on: '2026-08-01', expires_on: '2026-08-31' }], TODAY)
  assert.strictEqual(now.has('report:x'), true)
})

test('날짜가 비어 있으면 제한 없음 — 기간 없이 열어준 경우', () => {
  const f = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, starts_on: null, expires_on: null }], TODAY)
  assert.strictEqual(f.has('report:x'), true)
})

test('DATE 가 Date 객체로 와도 만료가 동작한다', () => {
  /* mysql2 는 DATE 를 **Date 객체**로 준다. String(date).slice(0,10) 은 'Thu Jan 01' 이 되어
     '2026-08-14' 와 비교하면 '2' < 'T' → 만료가 영영 안 온다.
     사용 중지한 회사가 유료 양식을 계속 보는 상태다. 실동작 검증에서 잡혔다 — 여기서 못 박는다. */
  const expired = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, expires_on: new Date(2026, 0, 1) }], TODAY)
  assert.strictEqual(expired.has('report:x'), false, '지난 만료일은 닫혀야 한다')

  const alive = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, expires_on: new Date(2026, 11, 31) }], TODAY)
  assert.strictEqual(alive.has('report:x'), true, '남은 만료일은 열려야 한다')

  const notYet = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, starts_on: new Date(2026, 8, 1) }], TODAY)
  assert.strictEqual(notYet.has('report:x'), false, '시작 전은 닫혀야 한다')
})

test('망가진 날짜는 제한 없음으로 본다 — 켜 준 걸 조용히 끄지 않는다', () => {
  const f = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, expires_on: 'garbage' }], TODAY)
  assert.strictEqual(f.has('report:x'), true)
})

/* ── 카탈로그 노출 ──
 *
 * scope 세 값의 뜻을 표로 못 박는다.
 *   all       늘 보인다
 *   entitled  **켜 준 회사만** 본다. 안 켜졌으면 아무에게도 안 보인다(잠금 카드도 없다)
 *   hidden    어디에도 안 나간다. 기능 키를 켜 줘도 안 나간다
 */
const SAMPLE = [
  { key: 'h', title: '숨김', scope: 'hidden',   sort: 1 },
  { key: 'e', title: '선택', scope: 'entitled', sort: 2 },
  { key: 'a', title: '기본', scope: 'all',      sort: 3 },
]

test('hidden 은 어디에도 안 나간다 — 기능 키를 켜 줘도', () => {
  const off = visibleReports({ catalog: SAMPLE, features: new Set() })
  assert.strictEqual(off.some(r => r.key === 'h'), false)
  const on = visibleReports({ catalog: SAMPLE, features: new Set([featureKeyOf('h')]) })
  assert.strictEqual(on.some(r => r.key === 'h'), false, 'scope 를 바꾸는 결정 없이는 절대 안 나간다')
})

test('안 켜진 entitled 는 아무에게도 안 보인다 — 잠금 카드조차 없다', () => {
  const rows = visibleReports({ catalog: SAMPLE, features: new Set() })
  assert.strictEqual(rows.some(r => r.key === 'e'), false)
  assert.ok(rows.every(r => !('locked' in r)), 'locked 필드 자체가 없다')
})

test('켜 준 entitled 는 그 회사 전원에게 보인다', () => {
  const rows = visibleReports({ catalog: SAMPLE, features: new Set([featureKeyOf('e')]) })
  const e = rows.find(r => r.key === 'e')
  assert.ok(e)
  assert.strictEqual(e.title, '선택')
})

test('all 은 아무것도 안 켜도 보인다', () => {
  const rows = visibleReports({ catalog: SAMPLE, features: new Set() })
  assert.deepStrictEqual(rows.map(r => r.key), ['a'])
})

/* ── 실제 카탈로그 ── */

test('화면 변화 0 — 아무것도 안 켠 회사는 기존 7개뿐이다', () => {
  const rows = visibleReports({ features: new Set() })
  assert.deepStrictEqual(rows.map(r => r.key),
    ['monthly', 'tax4', 'category', 'vendor', 'ar', 'subcontract', 'vat'])
})

test('켜 주면 그 양식만 늘어난다 — 같은 entitled 라도 나머지는 닫혀 있다', () => {
  const TWO = [
    { key: 'a', title: '기본', scope: 'all',      sort: 1 },
    { key: 'x', title: '선택X', scope: 'entitled', sort: 2 },
    { key: 'y', title: '선택Y', scope: 'entitled', sort: 3 },
  ]
  const rows = visibleReports({ catalog: TWO, features: new Set([featureKeyOf('x')]) })
  assert.deepStrictEqual(rows.map(r => r.key), ['a', 'x'])
})

/* 데이터가 안 붙은 화면을 켤 수 있는 상태로 두면 **가짜 숫자가 고객에게 간다.**
   방산 원가 보고서가 아직 그 상태다(빈 표 + 'NaN%'). 실구현 전까지 hidden 이어야 한다. */
test('방산 원가 보고서는 실구현 전까지 열 수 없어야 한다', () => {
  const r = BUILTIN_REPORTS.find(x => x.key === 'defense')
  assert.strictEqual(r.scope, 'hidden',
    'SAMPLE 빈 배열을 읽고 NaN% 를 찍는다 — 켜면 고객이 그걸 본다')
})

test('실데이터에 붙인 둘은 회사별로 열 수 있다', () => {
  for (const key of ['contract', 'taxoffice']) {
    assert.strictEqual(BUILTIN_REPORTS.find(x => x.key === key).scope, 'entitled')
  }
})

test('카탈로그 key 는 중복이 없다 — 화면 매핑이 1:1이어야 한다', () => {
  const keys = BUILTIN_REPORTS.map(r => r.key)
  assert.strictEqual(new Set(keys).size, keys.length)
})

test('scope 는 아는 값만 쓴다 — 오타가 조용히 all 처럼 동작하면 안 된다', () => {
  const KNOWN = new Set(['all', 'entitled', 'hidden'])
  for (const r of BUILTIN_REPORTS) {
    assert.ok(KNOWN.has(r.scope), `${r.key} 의 scope='${r.scope}' 는 아는 값이 아니다`)
  }
})
