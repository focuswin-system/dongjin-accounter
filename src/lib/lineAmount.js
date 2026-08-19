/* 품목 라인의 금액 계산 — 청구서·주문 품목표 공용.
 *
 * 무엇에 단가를 곱하는가가 품목마다 다르다.
 *   qty(기본) — 금액 = 수량 × 단가   (개·EA·세트…)
 *   weight    — 금액 = 중량 × 단가   (㎏당 단가로 파는 자재)
 *
 * 계산이 화면과 서버에 따로 있으면 반드시 어긋난다(청구서에 찍힌 금액과 저장된 금액이 다름).
 * 그래서 이 파일 하나만 쓰고, 서버는 이 규칙을 그대로 복사한 lib/lineAmount.js 를 쓴다.
 *
 * ⚠ 사람이 금액을 직접 고칠 수 있다. 자동 계산은 '기본값'이지 강제가 아니다 —
 *   할인·끝수 조정이 실무에 흔하다. 그래서 호출부는 사용자가 손댄 금액을 덮지 않는다.
 */

/** 숫자만 남긴다(콤마·단위 제거). 소수점은 살린다 — 중량은 소수가 흔하다. */
export const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const s = String(v ?? '').replace(/[^0-9.-]/g, '')
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : 0
}

/** 이 라인이 단가를 곱할 기준값 (수량 또는 중량) */
export function basisValue(line) {
  return line?.price_basis === 'weight' ? num(line.weight) : num(line.qty)
}

/** 자동 계산 금액. 원 단위로 반올림한다(소수 원은 청구서에 쓰지 않는다). */
export function computeLineAmount(line) {
  return Math.round(basisValue(line) * num(line?.unit_price))
}

/** 라인 배열의 공급가액 합계 */
export function linesSupplyTotal(lines) {
  return (lines || []).reduce((s, l) => s + num(l.amount), 0)
}

export const BASIS_LABEL = { qty: '수량', weight: '중량' }
