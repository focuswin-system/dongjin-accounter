// 청구서에서 저절로 생기는 적요(lib/memoText.js)
const { test } = require('node:test')
const assert = require('node:assert')
const { issueSummary, settleMemo } = require('../lib/memoText')

test('발행·수취 전표 적요 — 청구번호 없이 사람 말로', () => {
  assert.strictEqual(issueSummary({ kind: 'issued', invoice_no: '청구-2026-0008' }), '매출 세금계산서 발행')
  assert.strictEqual(issueSummary({ kind: 'received', invoice_no: '매입-2026-0001' }), '매입 세금계산서 수취')
})

test('입금·지급 거래 적요 — 청구서 메모가 있으면 뒤에 붙는다', () => {
  assert.strictEqual(settleMemo({ kind: 'issued' }), '매출대금 입금')
  assert.strictEqual(settleMemo({ kind: 'received', memo: '  ' }), '매입대금 지급')
  assert.strictEqual(settleMemo({ kind: 'issued', memo: '기성고 3차' }), '매출대금 입금 · 기성고 3차')
})

test('엑셀 임포트의 JSON 메모는 풀어서 붙인다 — 중괄호가 적요에 찍히면 안 된다', () => {
  const memo = JSON.stringify({ src: 'payables-import-2026', item: '원자재', buyer: '공용', vessel: 'P179' })
  assert.strictEqual(settleMemo({ kind: 'received', memo }), '매입대금 지급 · 원자재 · P179')
  // 다른 JSON·깨진 JSON 은 그대로(지어내지 않는다)
  assert.strictEqual(settleMemo({ kind: 'issued', memo: '{깨짐' }), '매출대금 입금 · {깨짐')
})
