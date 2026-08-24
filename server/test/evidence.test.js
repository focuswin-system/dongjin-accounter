/**
 * 증빙 충족 판정.
 *
 * 여기서 잠그는 것:
 *   1. **파일이 없어도 확인 체크로 닫힌다.** 파일 유무로만 보면 종이 원본만 오는 회사는
 *      영원히 '미비'로 남고, 그러면 그 목록을 아무도 안 본다.
 *   2. **요구하지 않는 건은 미비가 아니다.** 대표 가수금 상환처럼 서류가 없는 건까지
 *      미비로 세면 목록이 길어져 진짜 챙길 것이 묻힌다.
 *   3. 챙겼는지(업무 상태)와 공제 가능한지(세법)를 **섞지 않는다.**
 */
const test = require('node:test')
const assert = require('node:assert')

const { evidenceState, evidenceSummary, hasEvidence, deductibleOf } = require('../lib/evidence')

test('파일이 있으면 충족', () => {
  assert.equal(evidenceState({ required: 1, fileUrl: '/uploads/c1/a.pdf' }), 'ok')
  assert.equal(evidenceState({ required: 1, docCount: 2 }), 'ok')
})

test('파일이 없어도 확인 체크로 닫힌다', () => {
  // 원본이 우편으로만 오는 곳이 있다 — 체크가 없으면 그런 회사는 영원히 미비다
  assert.equal(evidenceState({ required: 1, checked: 1 }), 'ok')
  assert.equal(evidenceState({ required: 1, checked: true }), 'ok')
})

test('요구하는데 아무것도 없으면 미비', () => {
  assert.equal(evidenceState({ required: 1 }), 'missing')
  assert.equal(evidenceState({ required: 1, fileUrl: '', docCount: 0, checked: 0 }), 'missing')
  assert.equal(evidenceState({ required: 1, fileUrl: '   ' }), 'missing', '공백만 든 주소는 없는 것이다')
})

test('요구하지 않으면 미비가 아니다', () => {
  assert.equal(evidenceState({ required: 0 }), 'none')
  assert.equal(evidenceState({}), 'none')
  // 요구하지 않아도 붙여 뒀으면 충족으로 본다(붙인 걸 안 보이게 할 이유가 없다)
  assert.equal(evidenceState({ required: 0, docCount: 1 }), 'ok')
})

test('요약 — 미비만 세지 않고 요구 건수도 함께 낸다', () => {
  const s = evidenceSummary([
    { required: 1, docCount: 1 },   // ok
    { required: 1 },                // missing
    { required: 1, checked: 1 },    // ok
    { required: 0 },                // none
  ])
  assert.deepEqual(s, { required: 3, ok: 2, missing: 1 })
})

test('hasEvidence 는 세 경로를 모두 본다', () => {
  assert.equal(hasEvidence({ fileUrl: 'x' }), true)
  assert.equal(hasEvidence({ docCount: 1 }), true)
  assert.equal(hasEvidence({ checked: '1' }), true)
  assert.equal(hasEvidence({}), false)
})

test('공제 가능 여부는 유형이 정한다 — 안 적었으면 모른다(null)', () => {
  // '아니오'로 단정하면 공제 가능한 건이 조용히 빠진다
  const db = { async execute(_s, [name]) {
    return [name === '세금계산서' ? [{ deductible: 1 }] : name === '간이영수증' ? [{ deductible: 0 }] : []]
  } }
  return Promise.all([
    deductibleOf(db, '세금계산서').then(v => assert.equal(v, true)),
    deductibleOf(db, '간이영수증').then(v => assert.equal(v, false)),
    deductibleOf(db, '').then(v => assert.equal(v, null)),
    deductibleOf(db, '없는유형').then(v => assert.equal(v, null)),
  ])
})
