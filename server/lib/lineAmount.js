/* 품목 라인 금액 계산 — 프런트 src/lib/lineAmount.js 와 **같은 규칙**이어야 한다.
 *
 * 화면이 보여준 금액과 서버가 저장한 금액이 다르면 청구서가 거짓말이 된다.
 * 규칙이 한 줄이라 파일을 공유하는 대신 복사해 두고, 양쪽 주석에 서로를 적어 둔다
 * (server/ 는 CommonJS, src/ 는 ESM 이라 그대로는 못 가져다 쓴다).
 *
 *   qty(기본) — 금액 = 수량 × 단가
 *   weight    — 금액 = 중량 × 단가   (㎏당 단가로 파는 자재)
 */

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

const basisValue = (line) => (line?.price_basis === 'weight' ? num(line.weight) : num(line.qty))

/** 자동 계산 금액(원 단위 반올림) */
const computeLineAmount = (line) => Math.round(basisValue(line) * num(line?.unit_price))

/** price_basis 정규화 — 아는 값만 통과시킨다(엉뚱한 값이 오면 기본 'qty') */
const normBasis = (v) => (v === 'weight' ? 'weight' : 'qty')

module.exports = { num, basisValue, computeLineAmount, normBasis }
