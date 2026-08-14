/* 회사별 기능(entitlement) 판정 — 요금제 묶음 + 회사별 낱개.
 *
 * 이 판정이 틀리면 두 방향 모두 사고다:
 *   느슨하면 → 안 산 회사가 유료 양식을 본다(팔 수 없게 된다)
 *   빡빡하면 → 산 회사가 못 본다(항의가 들어온다)
 * 그래서 DB 없이 도는 순수 함수로 떼어 두고 여기서 못 박는다.
 */
const test = require('node:test')
const assert = require('node:assert')
const { mergeFeatures } = require('../lib/entitlements')
const { visibleReports, BUILTIN_REPORTS, featureKeyOf } = require('../platform/reportCatalog')

const TODAY = '2026-08-14'

test('요금제가 준 것 + 회사별로 켠 것이 합쳐진다', () => {
  const f = mergeFeatures(['report:a'], [{ feature_key: 'report:b', enabled: 1 }], TODAY)
  assert.deepStrictEqual([...f].sort(), ['report:a', 'report:b'])
})

test('enabled=0 은 요금제로 받은 것도 회수한다 — 환불·계약 해지 자리', () => {
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

test('날짜가 비어 있으면 제한 없음 — 영구 판매', () => {
  const f = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, starts_on: null, expires_on: null }], TODAY)
  assert.strictEqual(f.has('report:x'), true)
})

test('DATE 가 Date 객체로 와도 만료가 동작한다', () => {
  /* mysql2 는 DATE 를 **Date 객체**로 준다. String(date).slice(0,10) 은 'Thu Jan 01' 이 되어
     '2026-08-14' 와 비교하면 '2' < 'T' → 만료가 영영 안 온다.
     해지한 회사가 유료 양식을 계속 보는 상태다. 실동작 검증에서 잡혔다 — 여기서 못 박는다. */
  const expired = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, expires_on: new Date(2026, 0, 1) }], TODAY)
  assert.strictEqual(expired.has('report:x'), false, '지난 만료일은 잠겨야 한다')

  const alive = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, expires_on: new Date(2026, 11, 31) }], TODAY)
  assert.strictEqual(alive.has('report:x'), true, '남은 만료일은 열려야 한다')

  const notYet = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, starts_on: new Date(2026, 8, 1) }], TODAY)
  assert.strictEqual(notYet.has('report:x'), false, '시작 전은 잠겨야 한다')
})

test('망가진 날짜는 제한 없음으로 본다 — 켜 준 걸 조용히 끄지 않는다', () => {
  const f = mergeFeatures([], [{ feature_key: 'report:x', enabled: 1, expires_on: 'garbage' }], TODAY)
  assert.strictEqual(f.has('report:x'), true)
})

/* ── 카탈로그 노출 ── */

test('기본 양식(scope:all)은 아무것도 안 사도 보인다', () => {
  const rows = visibleReports({ features: new Set(), isMaster: false })
  const keys = rows.map(r => r.key)
  for (const k of ['monthly', 'tax4', 'category', 'vendor', 'ar', 'subcontract', 'vat']) {
    assert.ok(keys.includes(k), `${k} 가 기본 목록에 있어야 한다`)
  }
  assert.ok(rows.every(r => !r.locked), '기본 양식은 잠기지 않는다')
})

/* scope 별 노출 — 표로 못 박는다.
 *   hidden    아무에게도 안 나간다(기능 키가 있어도)
 *   entitled  마스터에게만 잠금으로. 사면 전원에게
 *   all       전원에게 */
const SAMPLE = [
  { key: 'h', title: '숨김', scope: 'hidden',   sort: 1 },
  { key: 'e', title: '유료', scope: 'entitled', sort: 2 },
  { key: 'a', title: '기본', scope: 'all',      sort: 3 },
]

test('hidden 은 아무에게도 안 나간다 — 마스터에게도', () => {
  for (const isMaster of [false, true]) {
    const rows = visibleReports({ catalog: SAMPLE, features: new Set(), isMaster })
    assert.strictEqual(rows.some(r => r.key === 'h'), false, `isMaster=${isMaster}`)
  }
})

test('hidden 은 기능 키를 켜 줘도 안 나간다 — 팔려면 entitled 로 바꿔야 한다', () => {
  const rows = visibleReports({ catalog: SAMPLE, features: new Set([featureKeyOf('h')]), isMaster: true })
  assert.strictEqual(rows.some(r => r.key === 'h'), false)
})

test('안 산 entitled 는 일반 사원에게 아예 안 보인다 — 사원 화면은 광고판이 아니다', () => {
  const rows = visibleReports({ catalog: SAMPLE, features: new Set(), isMaster: false })
  assert.strictEqual(rows.some(r => r.key === 'e'), false)
})

test('안 산 entitled 는 회사 마스터에게만 잠금으로 보인다', () => {
  const rows = visibleReports({ catalog: SAMPLE, features: new Set(), isMaster: true })
  const d = rows.find(r => r.key === 'e')
  assert.ok(d, '마스터에게는 보인다')
  assert.strictEqual(d.locked, true)
  assert.strictEqual(d.lockReason, 'entitlement')
})

test('산 entitled 는 사원에게도 잠금 없이 보인다', () => {
  const rows = visibleReports({ catalog: SAMPLE, features: new Set([featureKeyOf('e')]), isMaster: false })
  const d = rows.find(r => r.key === 'e')
  assert.ok(d)
  assert.strictEqual(d.locked, false)
})

test('P0 회귀 — 화면 변화 0. 사원도 마스터도 기존 7개뿐이다', () => {
  const BEFORE = ['monthly', 'tax4', 'category', 'vendor', 'ar', 'subcontract', 'vat']
  for (const isMaster of [false, true]) {
    const rows = visibleReports({ features: new Set(), isMaster })
    assert.deepStrictEqual(rows.map(r => r.key), BEFORE, `isMaster=${isMaster}`)
    assert.ok(rows.every(r => !r.locked), '잠금 카드가 하나도 없어야 한다')
  }
})

test('카탈로그 key 는 중복이 없다 — 화면 매핑이 1:1이어야 한다', () => {
  const keys = BUILTIN_REPORTS.map(r => r.key)
  assert.strictEqual(new Set(keys).size, keys.length)
})
