/**
 * 매입세액 불공제(접대비 등) — 부가가치세법 제39조 ①6
 *
 * 공제받지 못하는 세액이 세 곳에서 '돌려받을 돈'으로 새고 있었다.
 *   1) 매입 청구서(세금계산서 수취)엔 불공제 표시 자체가 없어 전부 공제로 집계
 *   2) 전표가 그 세액을 부가세대급금(자산)으로 세웠다 — 받을 수 없는 돈이 자산으로 남는다
 *   3) 신고 자료 엑셀이 수취분 세액을 전부 매입세액으로 더했다
 *
 * DB 없이 검증한다(비목 조회는 가짜 db 로).
 */
const { test } = require('node:test')
const assert = require('node:assert')

const { invoiceDeductible } = require('../lib/invoiceCreate')
const { invoiceVoucher, transactionVoucher } = require('../lib/voucher')
const { vatPack } = require('../lib/vatWorkbook')

/** categories 조회만 흉내 내는 db — 접대비만 불공제 */
const fakeDb = {
  execute: async (_sql, [name]) => [[
    name === '접대비' ? { account_code: '5205', vat: '10%', vat_deductible: 0 }
      : name === '복리후생비(관리)' ? { account_code: '5203', vat: '10%', vat_deductible: 1 }
      : undefined,
  ]],
}

test('매입 청구서는 비목에서 불공제를 물려받는다', async () => {
  assert.strictEqual(await invoiceDeductible(fakeDb, { kind: 'received', category: '접대비' }), 0)
  assert.strictEqual(await invoiceDeductible(fakeDb, { kind: 'received', category: '복리후생비(관리)' }), 1)
  assert.strictEqual(await invoiceDeductible(fakeDb, { kind: 'received', category: '' }), 1)
})

test('화면이 정해 보낸 값이 비목보다 우선한다', async () => {
  assert.strictEqual(await invoiceDeductible(fakeDb, { kind: 'received', category: '접대비', vatDeductible: 1 }), 1)
  assert.strictEqual(await invoiceDeductible(fakeDb, { kind: 'received', category: '복리후생비(관리)', vatDeductible: 0 }), 0)
})

test('매출 청구서는 공제 개념이 없다 — 늘 1', async () => {
  assert.strictEqual(await invoiceDeductible(fakeDb, { kind: 'issued', category: '접대비', vatDeductible: 0 }), 1)
})

const debitOf = (v, code) => v.lines.filter(l => l.side === 'debit' && l.code === code)
  .reduce((s, l) => s + Number(l.amount), 0)

test('불공제 매입 청구서 전표 — 세액은 비용에 얹고 부가세대급금이 없다', () => {
  const v = invoiceVoucher({ kind: 'received', supply_amount: 100000, vat_amount: 10000, total_amount: 110000,
                              account_code: '5205', vat_deductible: 0 })
  assert.strictEqual(debitOf(v, '1306'), 0)
  assert.strictEqual(debitOf(v, '5205'), 110000)
  assert.ok(v.balanced)
})

test('공제 매입 청구서 전표는 그대로 — 세액이 부가세대급금으로', () => {
  const v = invoiceVoucher({ kind: 'received', supply_amount: 100000, vat_amount: 10000, total_amount: 110000,
                              account_code: '5203', vat_deductible: 1 })
  assert.strictEqual(debitOf(v, '1306'), 10000)
  assert.strictEqual(debitOf(v, '5203'), 100000)
})

test('불공제 복합 거래 전표 — 세액이 각 비목 줄에 얹힌다', () => {
  const v = transactionVoucher({ kind: 'expense', amount: 55000, bank_code: '1103', vat_deductible: 0,
    splits: [{ account_code: '5205', supply_amount: 50000, vat_amount: 5000, amount: 55000 }] })
  assert.strictEqual(debitOf(v, '1306'), 0)
  assert.strictEqual(debitOf(v, '5205'), 55000)
  assert.ok(v.balanced)
})

test('신고 자료 — 수취분은 전부 적고, 불공제는 따로 빼서 공제 매입세액만 남긴다', () => {
  const rows = [
    { kind: 'received', tax_type: '과세', supply_amount: 100000, vat_amount: 10000, vat_deductible: 1, issued_at: '2026-07-01' },
    { kind: 'received', tax_type: '과세', supply_amount: 50000,  vat_amount: 5000,  vat_deductible: 0, issued_at: '2026-07-02' },
  ]
  const p = vatPack(rows, { quarter: 'Q3', year: 2026 })
  assert.strictEqual(p.purchase.과세.vat, 15000)      // 수취분 줄 — 합계표와 맞아야 한다
  assert.strictEqual(p.nonDed.vat, 5000)             // (16) 공제받지 못할 매입세액
  assert.strictEqual(p.purchaseVat, 10000)           // 실제 공제
})

/* 계좌 → 계정과목 — 신용카드는 미지급금. 예전엔 카드도 보통예금이라 카드 지출이
   '통장에서 바로 나간 돈'으로 전표가 섰다(2026-10-01). */
const { accountAcctCode } = require('../lib/acctCode')
test('신용카드는 미지급금, 체크카드·통장은 예금 계정', () => {
  assert.strictEqual(accountAcctCode({ kind: 'card', type: '법인카드', card_type: 'credit' }), '2202')
  assert.strictEqual(accountAcctCode({ kind: 'card', type: '개인카드' }), '2202')
  assert.strictEqual(accountAcctCode({ kind: 'card', type: '체크카드', card_type: 'check' }), '1103')
  assert.strictEqual(accountAcctCode({ kind: 'bank', type: '현금' }), '1101')
  assert.strictEqual(accountAcctCode({ kind: 'bank', type: '보통예금' }), '1103')
})
