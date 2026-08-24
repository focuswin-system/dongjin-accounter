/**
 * 반복 주기(정기청구·정기지급·계약) — **이 표가 유일한 정의다.**
 *
 * ⚠ 회계 기간을 쪼개는 lib/period.js 와는 다른 것이다. 그쪽은 "7월분은 6/26~7/25" 같은
 *   마감일 기준 구간을 만들고, 이쪽은 "몇 달마다 도는가"를 정한다. 이름이 비슷해 헷갈리기
 *   쉬운데 섞으면 안 된다.
 *
 * ── 왜 한 곳으로 모으나 ──
 * 이 표가 네 군데에 흩어져 있었다: contract-model.js, contract-export.js,
 * recurrence.js(삼항식), 그리고 화면 쪽 몇 곳. 값이 셋(월·분기·년)일 때는 버텼지만
 * **격월을 넣는 순간 하나라도 빠지면 조용히 틀린다** — 빠진 곳은 격월을 모르니
 * `|| 1`로 떨어져 '매월'로 계산한다. 회차가 두 배로 돌거나 월 환산이 두 배가 되는데,
 * 에러는 안 난다. 그런 종류의 버그는 숫자를 손으로 세어 보기 전에는 안 보인다.
 *
 * ⚠ 화면 쪽 정의(src/lib/renewal.js BILLING_PERIODS)와 **값(value)이 글자까지 같아야** 한다.
 *   DB ENUM 도 같은 문자열을 쓴다(recurring_invoices.period / recurring_expenses.period).
 */

/** 주기 → 몇 달마다. 회차 간격이자 '월 환산'의 나눗수다. */
const PERIOD_MONTHS = Object.freeze({
  monthly: 1,
  bimonthly: 2,   // 격월 — 2개월마다(홀수달/짝수달은 시작일이 정한다)
  quarterly: 3,
  yearly: 12,
})

/** DB ENUM 에 실어야 할 값 목록(순서 = 간격 오름차순) */
const PERIODS = Object.freeze(Object.keys(PERIOD_MONTHS))

/** 모르는 값이 오면 '매월'로 본다 — 옛 데이터·빈 값 방어 */
const periodMonths = (p) => PERIOD_MONTHS[p] || 1

/** 사람이 읽는 이름 */
const PERIOD_LABEL = Object.freeze({
  monthly: '매월', bimonthly: '격월', quarterly: '매분기', yearly: '매년',
})
const periodLabel = (p) => PERIOD_LABEL[p] || '매월'

/** 저장 전 정규화 — 목록에 없으면 'monthly'. ENUM 에 못 넣는 값이 오면 500 이 난다. */
const normPeriod = (p) => (PERIOD_MONTHS[p] ? p : 'monthly')

module.exports = { PERIOD_MONTHS, PERIODS, periodMonths, PERIOD_LABEL, periodLabel, normPeriod }
