/**
 * 청구서 등록 입력 검증
 *
 * 운영 로그에 `POST /api/invoices` 500 이 찍혀 있었다 —
 * "Bind parameters must not contain undefined". total_amount·issued_at 만 검사하고
 * kind·supply_amount·vat_amount 는 무방비라, 빠진 채로 들어오면 undefined 가 그대로
 * INSERT 파라미터가 되어 mysql2 가 던졌다.
 *
 * 500 은 사용자에게 "처리 중 오류"로만 보인다 — 무엇을 안 넣었는지 알 수 없고,
 * 운영자도 로그를 열어야 안다. **막을 수 있는 건 400 으로 막고 이유를 말해야 한다.**
 *
 * DB 없이 전부 검증된다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const invoiceCreateError = require('../routes/invoices')._invoiceCreateError

const ok = { kind: 'issued', supply_amount: 909091, vat_amount: 90909 }

test('정상 입력은 통과한다', () => {
  assert.strictEqual(invoiceCreateError(ok), null)
  assert.strictEqual(invoiceCreateError({ ...ok, kind: 'received' }), null)
})

test('kind 가 없거나 이상하면 막는다 — 어느 목록에도 안 잡히는 청구서가 된다', () => {
  for (const kind of [undefined, null, '', 'sales', 'ISSUED', 0]) {
    const e = invoiceCreateError({ ...ok, kind })
    assert.ok(e, `kind=${JSON.stringify(kind)} 를 통과시키면 안 된다`)
    assert.match(e, /매출·?\/?매입|구분/)
  }
})

test('공급가액이 빠지면 막는다 (이게 운영 500 의 원인이었다)', () => {
  for (const v of [undefined, null, '', 'abc', NaN]) {
    assert.ok(invoiceCreateError({ ...ok, supply_amount: v }),
      `supply_amount=${JSON.stringify(v)} 가 그대로 INSERT 로 가면 500 이다`)
  }
})

test('부가세액이 빠지면 막는다', () => {
  for (const v of [undefined, null, '', 'abc']) {
    assert.ok(invoiceCreateError({ ...ok, vat_amount: v }))
  }
})

test('음수 금액은 막는다 — 미수금 총액을 깎아 다른 청구서를 상계한다', () => {
  assert.match(invoiceCreateError({ ...ok, supply_amount: -1 }), /0보다 작을 수 없어요/)
  assert.match(invoiceCreateError({ ...ok, vat_amount: -1 }), /0보다 작을 수 없어요/)
})

test('0 은 허용한다 — 면세는 세액 0, 총액 0 은 amountError 가 따로 막는다', () => {
  assert.strictEqual(invoiceCreateError({ ...ok, vat_amount: 0 }), null)
  assert.strictEqual(invoiceCreateError({ ...ok, supply_amount: 0 }), null)
})

test('숫자 문자열은 통과한다 — 폼은 문자열로 보낸다', () => {
  assert.strictEqual(invoiceCreateError({ kind: 'issued', supply_amount: '909091', vat_amount: '90909' }), null)
})
