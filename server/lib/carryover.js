/* 이월 잔액 — 쓰기 전부터 있던 미수·미지급(4단계, 2026-09). 설계: docs/02-design/features/fiscal-opening.design.md
 *
 * 거래처별 금액만 받아 **청구서로** 세운다(invoices.carryover = 1). 청구서라서 받을 돈·줄 돈 잔액·입금 처리·
 * 대사가 그대로 된다. 상대 계정은 미처분이익잉여금(3504) — 기초 잔액의 차액을 자본으로 맞추는 방식이라
 * 손익(매출·비용)으로 안 잡힌다(lib/pnl.js 는 계정 대분류로 가른다).
 *
 * ⚠ 그런데 **기간으로 청구서를 고르는 집계**에는 섞이면 안 된다. 장부 시작일이 분기 중간이면 이월 청구서(시작일 전날)가
 *   같은 분기에 들어, 매출 목록·부가세 명세·세무사 전달 자료에 '그 기간의 매출·매입'으로 선다.
 *   그런 쿼리는 `notCarryover()` 를 붙인다. 잔액을 세는 곳(미수·미지급 합계, 월 매입내역의 전월이월)에는 **붙이지 않는다** —
 *   거기서는 이월이 들어가야 맞는다.
 */

/** 기간 집계 쿼리에 붙이는 조건. alias 는 'i.' 처럼 점까지 */
const notCarryover = (alias = '') => `COALESCE(${alias}carryover, 0) = 0`

/** 이월 청구서의 상대 계정 — 미처분이익잉여금 */
const CARRYOVER_ACCT = '3504'

/** 날짜 하루 전(YYYY-MM-DD) — 이월 청구서의 발행일 = 장부 시작일 전날 */
const dayBefore = (date) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

module.exports = { notCarryover, CARRYOVER_ACCT, dayBefore }
