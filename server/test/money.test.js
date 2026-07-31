/**
 * 금액 파싱 — 조용히 100배 틀리던 자리다. 엑셀 서식이 그대로 들어온다.
 */
const test = require('node:test')
const assert = require('node:assert')
const { moneyOf, numOf } = require('../lib/money')

test('소수점을 지우면 안 된다 — 100배 사고', () => {
  // 예전 구현: parseInt(replace(/[^0-9-]/g,'')) → '110000000' → 1억 1천만
  assert.equal(moneyOf('1,100,000.00'), 1_100_000)
  assert.equal(moneyOf('1100000.00'), 1_100_000)
  assert.equal(moneyOf('1,234,567.89'), 1_234_568)   // 반올림
})

test('회계형식 괄호는 음수다', () => {
  // 예전 구현은 양수로 읽어, 수정세금계산서(감액)가 증액으로 들어갔다
  assert.equal(moneyOf('(1,100,000)'), -1_100_000)
  assert.equal(moneyOf('(1,100,000.00)'), -1_100_000)
})

test('통화기호·공백·원 표기를 걷어낸다', () => {
  assert.equal(moneyOf('₩1,100,000'), 1_100_000)
  assert.equal(moneyOf(' 1 100 000 '), 1_100_000)
  assert.equal(moneyOf('1,100,000원'), 1_100_000)
})

test('빈 값·잡값은 0', () => {
  assert.equal(moneyOf(null), 0)
  assert.equal(moneyOf(undefined), 0)
  assert.equal(moneyOf(''), 0)
  assert.equal(moneyOf('   '), 0)
  assert.equal(moneyOf('-'), 0)
  assert.equal(moneyOf('.'), 0)
  assert.equal(moneyOf('없음'), 0)
})

test('숫자는 그대로(소수는 반올림)', () => {
  assert.equal(moneyOf(1_100_000), 1_100_000)
  assert.equal(moneyOf(1100000.4), 1_100_000)
  assert.equal(moneyOf(1100000.5), 1_100_001)
  assert.equal(moneyOf(NaN), 0)
  assert.equal(moneyOf(Infinity), 0)
})

test('음수 부호는 살린다', () => {
  assert.equal(moneyOf('-1,100,000'), -1_100_000)
  assert.equal(moneyOf(-1_100_000), -1_100_000)
})

test('점이 여러 개면 마지막 것만 소수점으로 본다', () => {
  // 유럽식 천단위(1.100.000) 나 오타. 100배로 부풀리지 않는 게 중요하다.
  assert.equal(moneyOf('1.100.000'), 1_100_000)
})

test('numOf 는 소수를 유지한다 — 이율 등', () => {
  assert.equal(numOf('4.5'), 4.5)
  assert.equal(numOf('연 3.25%'), 3.25)
  assert.equal(numOf(''), 0)
  assert.equal(numOf('abc'), 0)
})
