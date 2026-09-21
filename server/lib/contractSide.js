/* 주문(계약)의 방향 — 이 주문이 **파는 것인가 사는 것인가**. 판정하는 곳은 여기 하나.
 *
 * ── 왜 칼럼이 필요한가 ──
 * 예전엔 방향을 **거래처 구분(vendors.gubu)으로 추정**했다: A·E면 매입, 아니면 매출.
 * 거래처가 한쪽 일만 하는 동안은 맞았다. 그런데 `'C'`(매입·매출 겸함)가 있다.
 *   · `'C'` 는 사람이 고르기도 하지만 **시스템이 자동으로 승격**시킨다 —
 *     같은 이름을 매입·매출 양쪽에서 쓰면 routes/vendors.js 가 gubu 를 'C' 로 넓힌다.
 *   · 그러면 추정이 'A·E 가 아니다 → 매출'로 떨어진다.
 * 결과는 조용하고 비쌌다. 겸함 거래처의 **매입 주문이 매출로 집계**되고, 수주·발주 목록에
 * **둘 다** 뜨고, 정기 주문이면 회차마다 **매출 청구서가 발행**돼 없는 미수금이 쌓인다.
 *
 * 거래처 하나만 보고는 방향을 알 수 없다 — 추정을 더 똑똑하게 만드는 길은 없다.
 * **만든 화면이 답을 안다**(수주 화면에서 만들면 매출, 발주 화면에서 만들면 매입).
 * 그 답을 contracts.side 에 적어 두고, 여기서 읽는다.
 *
 * ⚠ side 가 비면 옛 규칙(gubu)으로 떨어진다. 옛 행은 1회 마이그레이션으로 채웠지만,
 *   외부 스크립트가 side 없이 넣는 경우가 남을 수 있어 fallback 을 지운다.
 */

const SIDES = ['sales', 'purchase']

/** 거래처 구분만으로 정하는 옛 규칙 — side 를 처음 채울 때와 fallback 에만 쓴다. */
const sideFromGubu = (gubu) => (gubu === 'A' || gubu === 'E' ? 'purchase' : 'sales')

/** 값 정규화. 모르는 값은 null(= 거래처로 추정). */
const normalizeSide = (v) => (SIDES.includes(v) ? v : null)

/**
 * 이 주문은 매입인가.
 * @param row contracts 행 — side 와 (없으면) 거래처 gubu 가 있어야 한다.
 *            gubu 는 조인 별칭에 따라 gubu / vendor_gubu 로 온다. 둘 다 본다.
 */
const isPurchaseSide = (row) => {
  const side = normalizeSide(row?.side)
  if (side) return side === 'purchase'
  return sideFromGubu(row?.gubu ?? row?.vendor_gubu)
    === 'purchase'
}

const sideOf = (row) => (isPurchaseSide(row) ? 'purchase' : 'sales')

/**
 * 목록을 방향으로 거르는 SQL 조각.
 *
 * ⚠ 'C' 를 양쪽에 넣던 옛 필터를 대신한다. 옛 필터는 겸함 거래처의 주문을
 *   **수주·발주 목록 둘 다에** 띄웠다 — 같은 주문이 두 화면에 보이면 어느 쪽에서
 *   고쳐야 하는지도 갈린다.
 *
 * @param kind  'purchase' | 'sales' (그 밖은 빈 문자열 = 안 거름)
 * @param c     contracts 별칭
 * @param v     vendors 별칭 (side 가 빈 옛 행을 위해 필요)
 */
const sideFilterSql = (kind, c = 'c', v = 'v') => {
  if (kind === 'purchase') {
    return ` AND (${c}.side = 'purchase' OR (${c}.side IS NULL AND ${v}.gubu IN ('A','E','C')))`
  }
  if (kind === 'sales') {
    return ` AND (${c}.side = 'sales' OR (${c}.side IS NULL AND (${v}.gubu IS NULL OR ${v}.gubu IN ('B','C'))))`
  }
  return ''
}

module.exports = { SIDES, sideFromGubu, normalizeSide, isPurchaseSide, sideOf, sideFilterSql }
