/**
 * 부가세 단일 규칙 — 금액이 '조용히' 틀리는 걸 막는 테스트.
 *
 * 회계 소프트웨어에서 세액 오류는 화면이 깨지지 않고 숫자만 틀리게 나온다.
 * 사람 눈으로는 신고 때가 되어서야 발견되므로, 여기가 테스트 가성비가 가장 높다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const {
  normalizeTaxType, vatFields, vatRateOf, taxTypeOfMode, vatOf,
  recurFromSupply, recurFromTotal, modeFromCatVat,
} = require('../lib/vat')

test('과세 — 합계에서 공급가·세액을 역산한다', () => {
  const r = vatFields({ amount: 11000 })
  assert.strictEqual(r.supply_amount, 10000)
  assert.strictEqual(r.vat_amount, 1000)
  assert.strictEqual(r.tax_type, '과세')
})

test('과세 — 역산 결과의 합이 원래 합계와 정확히 맞는다(반올림 손실 없음)', () => {
  // 1원이라도 어긋나면 장부가 안 맞는다. 나누어떨어지지 않는 값으로 확인한다.
  for (const total of [11000, 10000, 33333, 1, 999999]) {
    const r = vatFields({ amount: total })
    assert.strictEqual(r.supply_amount + r.vat_amount, total, `합계 ${total}`)
  }
})

test('면세 — 세액은 0이고 공급가가 곧 합계', () => {
  const r = vatFields({ amount: 11000, tax_type: '면세' })
  assert.strictEqual(r.supply_amount, 11000)
  assert.strictEqual(r.vat_amount, 0)
})

test('면세 — 세액이 실려 와도 버린다(유형이 우선)', () => {
  // 화면이 과세로 채워둔 세액을 남긴 채 유형만 면세로 바꾸는 경우.
  const r = vatFields({ amount: 11000, supply_amount: 10000, vat_amount: 1000, tax_type: '면세' })
  assert.strictEqual(r.vat_amount, 0)
})

test('영세 — 세액 0이지만 면세와 유형이 구분된다', () => {
  const r = vatFields({ amount: 10000, tax_type: '영세' })
  assert.strictEqual(r.vat_amount, 0)
  assert.strictEqual(r.tax_type, '영세')
})

test('알 수 없는 과세유형은 과세로 본다', () => {
  assert.strictEqual(normalizeTaxType('이상한값'), '과세')
  assert.strictEqual(normalizeTaxType(''), '과세')
  assert.strictEqual(normalizeTaxType(undefined), '과세')
})

test('화면이 보낸 공급가·세액은 그대로 존중한다', () => {
  const r = vatFields({ amount: 11000, supply_amount: 9000, vat_amount: 2000 })
  assert.strictEqual(r.supply_amount, 9000)
  assert.strictEqual(r.vat_amount, 2000)
})

test('공급가만 보내면 세액은 합계에서 뺀 값', () => {
  const r = vatFields({ amount: 11000, supply_amount: 10000 })
  assert.strictEqual(r.vat_amount, 1000)
})

test('매입세액 불공제 플래그의 여러 표현을 모두 0으로 받는다', () => {
  for (const v of [0, false, '0']) {
    assert.strictEqual(vatFields({ amount: 1000, vat_deductible: v }).vat_deductible, 0, `값 ${v}`)
  }
  for (const v of [1, true, '1', undefined, null]) {
    assert.strictEqual(vatFields({ amount: 1000, vat_deductible: v }).vat_deductible, 1, `값 ${v}`)
  }
})

test('주문 vat_mode → 세율·유형', () => {
  assert.strictEqual(vatRateOf('taxable'), 0.1)
  assert.strictEqual(vatRateOf('exempt'), 0)
  assert.strictEqual(vatRateOf('zero'), 0)
  assert.strictEqual(taxTypeOfMode('exempt'), '면세')
  assert.strictEqual(taxTypeOfMode('zero'), '영세')
  assert.strictEqual(taxTypeOfMode('taxable'), '과세')
  // 모르는 값은 과세로 — 세액을 빠뜨리는 쪽이 아니라 걷는 쪽으로 기운다.
  assert.strictEqual(taxTypeOfMode(undefined), '과세')
  assert.strictEqual(vatRateOf(undefined), 0.1)
})

test('공급가 → 세액', () => {
  assert.strictEqual(vatOf(10000, 'taxable'), 1000)
  assert.strictEqual(vatOf(10000, 'exempt'), 0)
  assert.strictEqual(vatOf(3333, 'taxable'), 333)   // 반올림
})

test('정기청구 — 공급가 기준', () => {
  assert.deepStrictEqual(recurFromSupply(10000, 'exclusive'), { supply: 10000, vat: 1000, tax_type: '과세' })
  assert.deepStrictEqual(recurFromSupply(10000, 'none'), { supply: 10000, vat: 0, tax_type: '면세' })
  assert.deepStrictEqual(recurFromSupply(10000, 'zero'), { supply: 10000, vat: 0, tax_type: '영세' })
})

test('정기지출 — 합계 기준 역산이 합계와 맞는다', () => {
  for (const total of [11000, 33333, 7]) {
    const r = recurFromTotal(total, 'exclusive')
    assert.strictEqual(r.supply + r.vat, total, `합계 ${total}`)
  }
  assert.deepStrictEqual(recurFromTotal(10000, 'none'), { supply: 10000, vat: 0, tax_type: '면세' })
})

test('모르는 정기 vat_mode는 과세로 본다', () => {
  assert.strictEqual(recurFromSupply(10000, undefined).tax_type, '과세')
  assert.strictEqual(recurFromSupply(10000, 'garbage').vat, 1000)
})

test('비목 vat 문자열 → 정기 vat_mode', () => {
  assert.strictEqual(modeFromCatVat('10%'), 'exclusive')
  assert.strictEqual(modeFromCatVat('영세'), 'zero')
  assert.strictEqual(modeFromCatVat('면세'), 'none')
  assert.strictEqual(modeFromCatVat('—'), 'none')
})
