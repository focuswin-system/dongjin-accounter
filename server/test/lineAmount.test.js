/**
 * 품목 라인 금액 규칙.
 *
 * 이 계산은 화면(src/lib/lineAmount.js)과 서버(server/lib/lineAmount.js)에 **두 벌** 있다.
 * 규칙이 한 줄이라 파일을 공유하는 대신 복사했는데, 그래서 어긋나면 조용히 아프다 —
 * 화면에 찍힌 금액과 저장된 금액이 다른 청구서가 나간다. 그 규칙을 여기 박아둔다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const { computeLineAmount, basisValue, normBasis, num } = require('../lib/lineAmount')

test('기본은 수량 × 단가', () => {
  assert.strictEqual(computeLineAmount({ qty: 3, unit_price: 1500 }), 4500)
  assert.strictEqual(computeLineAmount({ qty: 3, unit_price: 1500, price_basis: 'qty' }), 4500)
})

test('중량 기준이면 중량 × 단가 (수량은 안 쓴다)', () => {
  // 실제 쓰임: ㎏당 단가로 파는 자재. 수량(10개)이 있어도 금액은 중량으로 낸다.
  const line = { qty: 10, weight: 12.5, unit_price: 2000, price_basis: 'weight' }
  assert.strictEqual(computeLineAmount(line), 25000)
  assert.strictEqual(basisValue(line), 12.5)
})

test('중량 소수를 잘라내지 않는다', () => {
  // ㎏ 단위에 g 을 적는다 — 0.5 를 버리면 조용히 틀린 금액이 나간다
  assert.strictEqual(computeLineAmount({ weight: 0.75, unit_price: 4000, price_basis: 'weight' }), 3000)
  assert.strictEqual(num('12.345'), 12.345)
})

test('금액은 원 단위로 반올림한다', () => {
  // 소수 원은 청구서에 쓰지 않는다
  assert.strictEqual(computeLineAmount({ qty: 3, unit_price: 333.4 }), 1000)
  assert.strictEqual(computeLineAmount({ weight: 1.234, unit_price: 1000, price_basis: 'weight' }), 1234)
})

test('빈 값·문자열·콤마를 견딘다', () => {
  // 화면 입력은 문자열이고 콤마가 섞인다
  assert.strictEqual(computeLineAmount({ qty: '2', unit_price: '1,500' }), 3000)
  assert.strictEqual(computeLineAmount({}), 0)
  assert.strictEqual(computeLineAmount({ qty: '', unit_price: '' }), 0)
  assert.strictEqual(computeLineAmount({ qty: 'abc', unit_price: '1000' }), 0)
})

test('price_basis 는 아는 값만 통과시킨다', () => {
  // 엉뚱한 값이 오면 기본(수량)으로 — 금액 계산 기준이 흔들리면 안 된다
  assert.strictEqual(normBasis('weight'), 'weight')
  assert.strictEqual(normBasis('qty'), 'qty')
  assert.strictEqual(normBasis('중량'), 'qty', '한글 라벨이 그대로 오면 기본으로 떨어뜨린다')
  assert.strictEqual(normBasis(undefined), 'qty')
  assert.strictEqual(normBasis(null), 'qty')
})
