/**
 * 장부 전 정산 — 계약 등록 전 회차를 청구서·입금 없이 닫는다.
 * 운영 fowin(2026-08): 2024년 계약을 '수금 완료'로 만들려고 오늘 날짜 청구서 + 지난 입금을 넣어
 * 2년 전 매출 2,200만 원이 이번 분기 부가세에 섰다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const r = require('../routes/contracts')

test('등록일보다 앞선 일정만 소급이다 — 같은 날·뒤는 아니다', () => {
  assert.strictEqual(r._isBeforeSetup('2024-07-04', '2026-08-21'), true)
  assert.strictEqual(r._isBeforeSetup('2026-08-21', '2026-08-21'), false)
  assert.strictEqual(r._isBeforeSetup('2026-09-01', '2026-08-21'), false)
  assert.strictEqual(r._isBeforeSetup('', '2026-08-21'), false)
  assert.strictEqual(r._isBeforeSetup('2024-07-04', ''), false)
})

test('장부 전 정산분은 청구액·수금액에 들어가고 손익에는 안 들어간다', () => {
  const m = r._metrics({ side: 'sales', vat_mode: 'taxable', amount: 20000000, billing_mode: 'fixed',
    prior_supply: 10000000, term_prior_supply: 10000000, in_done: 0, billed: 0, in_supply: 0, cost_supply: 0 })
  assert.strictEqual(m.prior, 11000000)
  assert.strictEqual(m.collected, 11000000)
  assert.strictEqual(m.billed, 11000000)
  assert.strictEqual(m.remain, 11000000)       // 22,000,000 − 11,000,000
  assert.strictEqual(m.profit, 0)              // 그때 원가가 장부에 없으니 매출만 넣지 않는다
})

test('면세 계약은 부가세 없이 더한다', () => {
  const m = r._metrics({ side: 'sales', vat_mode: 'exempt', amount: 5000000, billing_mode: 'fixed', prior_supply: 5000000, term_prior_supply: 5000000 })
  assert.strictEqual(m.prior, 5000000)
})
