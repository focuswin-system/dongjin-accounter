/**
 * 부가세율 — 화면 쪽 **한 곳**.
 *
 * 여태 `* 0.1` / `/ 1.1` 이 화면 14곳에 흩어져 있었다. 세율이 바뀌는 일은 드물지만
 * 흩어져 있으면 바뀔 때 한두 곳을 반드시 빠뜨리고, 빠뜨린 곳은 조용히 틀린 세액을 낸다.
 *
 * ⚠ 서버 쪽 짝은 server/lib/vat.js 의 VAT_RATE 다 — 빌드 경계가 달라 한 파일을
 *   나눠 쓸 수 없다. **둘 중 하나를 고치면 나머지도 같이 고친다.**
 * ⚠ 면세·영세 판정은 여기서 하지 않는다. 호출부가 과세유형을 보고 0을 넣는다 —
 *   유형 해석은 서버 lib/vat.js 가 원본이고, 화면이 그 규칙을 흉내 내면 갈린다.
 */

/* ⚠ 숫자 해석은 **lineAmount.js 의 num 하나**를 쓴다.
   여기서 `Number(v) || 0` 을 따로 쓰면 "1,000,000" 같은 **콤마 문자열이 0** 이 되어
   세액이 통째로 사라진다 — 품목표는 입력값을 문자열로 들고 있다. */
import { num } from './lineAmount.js'

export const VAT_RATE = 0.1

/** 공급가액 → 세액 */
export const vatOf = (supply) => Math.round(num(supply) * VAT_RATE)

/** 세액 포함 합계 → 공급가액 */
export const supplyOf = (total) => Math.round(num(total) / (1 + VAT_RATE))
