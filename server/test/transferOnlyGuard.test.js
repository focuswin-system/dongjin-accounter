/**
 * 카드 대금·내부 이체 화면 권한**만** 가진 사람의 삭제 범위 테스트.
 *
 * 권한 게이트는 경로로 판정하는데 `DELETE /transactions/:id` 하나로 모든 거래를 지운다.
 * 그 경로를 두 화면에 열어 주지 않으면 '지급 취소'가 안 되고, 그냥 열어 주면
 * **'카드값 갚기' 권한으로 매출 입금까지 지울 수 있다.** 그래서 라우트에서 한 번 더 좁힌다.
 * 여기서 틀리면 조용히 남의 돈이 사라지거나, 멀쩡한 취소가 막힌다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { transferOnlyGuard } = require('../routes/transactions')

const req = (...perms) => ({ perms: new Set(perms) })

test('이체·카드대금 권한만 있으면 그 화면이 만든 줄만 지울 수 있다', () => {
  const r = req('card_payment:view', 'card_payment:delete')
  // 이체로 만든 줄(transfer_id 있음) — 카드 대금 지급 취소가 이 경우다
  assert.equal(transferOnlyGuard(r, { transfer_id: 'tr-1' }), null)
  // 평범한 거래 — 막는다
  assert.match(transferOnlyGuard(r, { transfer_id: null }), /거래내역에서/)
})

test('거래내역 삭제 권한이 있으면 종전대로 무엇이든 지운다', () => {
  assert.equal(transferOnlyGuard(req('ledger:delete'), { transfer_id: null }), null)
  assert.equal(transferOnlyGuard(req('misc_pl:delete'), { transfer_id: null }), null)
  assert.equal(transferOnlyGuard(req('voucher_book:delete'), { transfer_id: null }), null)
})

test('역할 미배정(제한 없음) 계정은 막지 않는다 — 게이트와 같은 규칙', () => {
  assert.equal(transferOnlyGuard({ perms: new Set() }, { transfer_id: null }), null)
  assert.equal(transferOnlyGuard({}, { transfer_id: null }), null)
})

test('보기 권한만으로는 통과하지 않는다', () => {
  // ledger:view 는 있지만 delete 가 없으면 좁은 쪽 규칙을 그대로 적용한다
  const r = req('ledger:view', 'card_payment:delete')
  assert.match(transferOnlyGuard(r, { transfer_id: null }), /거래내역에서/)
})

test('없는 거래(undefined)도 막는다 — 404 보다 먼저 통과시키면 안 된다', () => {
  assert.match(transferOnlyGuard(req('card_payment:delete'), undefined), /거래내역에서/)
})
