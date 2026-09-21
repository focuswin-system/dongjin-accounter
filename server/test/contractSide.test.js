/**
 * 주문 방향(매출/매입) 판정 규칙 테스트.
 *
 * 여기서 틀리면 **없는 매출이 생긴다.** 매입 주문이 매출로 판정되면
 *   · 주문 집계에서 지급액이 '수금'으로 잡히고
 *   · 정기 주문이면 회차마다 매출 청구서가 발행돼 미수금이 쌓이고
 *   · 수주·발주 목록에 같은 주문이 둘 다 뜬다
 * 전부 조용히 일어나고, 분기 부가세나 손익을 볼 때에야 드러난다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const {
  sideFromGubu, normalizeSide, isPurchaseSide, sideOf, sideFilterSql,
} = require('../lib/contractSide')

test('주문에 적힌 방향이 거래처 구분을 이긴다', () => {
  // 겸함('C') 거래처의 매입 주문 — 예전 규칙(gubu)으로는 매출로 떨어지던 바로 그 경우
  assert.equal(isPurchaseSide({ side: 'purchase', gubu: 'C' }), true)
  assert.equal(isPurchaseSide({ side: 'sales', gubu: 'C' }), false)
  // 거래처를 매입처로 바꿔도 주문에 적힌 방향은 안 흔들린다
  assert.equal(isPurchaseSide({ side: 'sales', gubu: 'A' }), false)
  assert.equal(sideOf({ side: 'purchase', gubu: 'B' }), 'purchase')
})

test('방향이 비면 옛 규칙(거래처 구분)으로 떨어진다', () => {
  assert.equal(isPurchaseSide({ gubu: 'A' }), true)
  assert.equal(isPurchaseSide({ gubu: 'E' }), true)
  assert.equal(isPurchaseSide({ gubu: 'B' }), false)
  assert.equal(isPurchaseSide({ gubu: null }), false)   // 거래처 없는 주문은 매출
  // 조인 별칭이 vendor_gubu 로 오는 쿼리도 있다 — 둘 다 봐야 한다
  assert.equal(isPurchaseSide({ vendor_gubu: 'A' }), true)
  assert.equal(isPurchaseSide({}), false)
})

test('모르는 값은 방향으로 인정하지 않는다', () => {
  assert.equal(normalizeSide('purchase'), 'purchase')
  assert.equal(normalizeSide('sales'), 'sales')
  assert.equal(normalizeSide('매입'), null)
  assert.equal(normalizeSide(''), null)
  assert.equal(normalizeSide(undefined), null)
  // 잘못된 값이 들어와도 거래처로 떨어질 뿐, 매입이 매출로 뒤집히지 않는다
  assert.equal(isPurchaseSide({ side: '매입', gubu: 'A' }), true)
})

test('옛 행을 채울 때 쓰는 규칙은 그때 판정과 같아야 한다', () => {
  assert.equal(sideFromGubu('A'), 'purchase')
  assert.equal(sideFromGubu('E'), 'purchase')
  assert.equal(sideFromGubu('B'), 'sales')
  assert.equal(sideFromGubu('C'), 'sales')   // 옛 규칙이 그랬다 — 숫자가 바뀌면 안 된다
  assert.equal(sideFromGubu(null), 'sales')
})

test('목록 필터는 적힌 방향을 먼저 보고, 빈 것만 거래처로 본다', () => {
  const p = sideFilterSql('purchase')
  assert.match(p, /c\.side = 'purchase'/)
  assert.match(p, /c\.side IS NULL/)
  assert.match(p, /v\.gubu IN \('A','E','C'\)/)

  const s = sideFilterSql('sales')
  assert.match(s, /c\.side = 'sales'/)
  assert.match(s, /v\.gubu IS NULL OR v\.gubu IN \('B','C'\)/)

  // 별칭을 바꿔 쓰는 쿼리도 있다
  assert.match(sideFilterSql('purchase', 'ct', 'vv'), /ct\.side/)
  assert.match(sideFilterSql('purchase', 'ct', 'vv'), /vv\.gubu/)

  // 'all' 이나 빈 값이면 아무것도 안 거른다
  assert.equal(sideFilterSql('all'), '')
  assert.equal(sideFilterSql(undefined), '')
})
