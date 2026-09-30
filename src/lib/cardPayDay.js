/* 카드 결제일 — 1~28일, 그리고 **말일**(31로 저장).
 *
 * 카드사는 결제일을 대개 1~27일 중에서 고르게 한다. 다만 법인카드에 '말일 결제'가 있어(2026-09-30 사용자 문의)
 * 말일을 둔다. 31로 저장하고, 날짜를 만드는 쪽(server/lib/cashReport.js, src/screens/CardPayment.jsx payDateOf)이
 * 이미 **그 달 마지막 날로 자른다** — 2월이면 28(29)일, 4월이면 30일.
 * 29·30일은 두지 않는다 — 2월에 말일로 바뀌어 "30일을 골랐는데 왜 28일이지?"가 된다.
 */
export const CARD_PAY_LAST = 31

/** 결제일 → 사람이 읽는 말. 0·빈 값은 '' */
export const payDayLabel = (d) => {
  const n = Number(d) || 0
  if (!n) return ''
  return n >= CARD_PAY_LAST ? '말일' : `${n}일`
}

/** 결제일 고르기 목록 — 1~28일 + 말일 */
export const PAY_DAY_OPTIONS = [
  ...Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `매월 ${i + 1}일` })),
  { value: String(CARD_PAY_LAST), label: '매월 말일' },
]
