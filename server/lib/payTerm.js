/* 날짜 칸 계산과 결제조건 — 반복거래·차입금·자금 예측이 함께 쓴다.
 *
 * 예전 lib/recurrence.js 에서 **회차 계산을 뺀 나머지**다. 정기 규칙의 회차(last_generated·
 * 건너뛰기·소급)는 반복거래로 바뀌며 없어졌고(docs/02-design/features/repeat-templates.design.md),
 * 달력 계산과 결제조건만 남았다.
 */

// 로컬 캘린더 기준 yyyy-mm-dd (toISOString의 UTC 변환을 쓰지 않는다 — KST 경계 오차 방지)
function fmtDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 해당 연·월(0-indexed month)의 말일
function daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate()
}

// yyyy-mm-dd 문자열에 days를 더한 yyyy-mm-dd (로컬 캘린더 기준)
function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return fmtDate(new Date(y, m - 1, d + days))
}

/* net30 의 일수 — 날짜 기준 30일(관례적 기본값) */
const PAYMENT_TERM_DAYS = 30

/* ⚠ 값을 지우지 말 것 — 저장된 pay_term(repeat_templates, 옛 recurring_*)이 이 문자열을 그대로 갖고 있다.
   목록에서 빠지면 그 반복거래는 조용히 net30 으로 떨어진다. */
const PAY_TERMS = ['immediate', 'net30', 'dom', 'eom', 'nm_day', 'nm_eom']
/* 'N일'을 받는 조건 — 서버·화면이 같은 판정을 써야 한 쪽만 날짜 칸을 내는 일이 없다 */
const PAY_TERMS_WITH_DAY = ['dom', 'nm_day']

/**
 * 청구일 → **돈이 실제로 오가는 날**.
 *
 * 청구일(세금계산서를 끊는 날)과 결제일은 다르다. 국내 B2B 에서 제일 흔한 조건은
 * '30일 후'가 아니라 **익월 지정일**이다("이번 달 것은 다음 달 10일에 넣어드립니다").
 *
 *   immediate  당일        자동이체처럼 그 날 바로
 *   net30      30일 후
 *   dom        당월 N일
 *   eom        당월 말일
 *   nm_day     익월 N일    ← 국내 B2B 최다
 *   nm_eom     익월 말일
 *
 * payDay 는 dom·nm_day 에서만 쓴다. 그 달 말일보다 크면 말일로 clamp 한다.
 */
function cashDateOf(cycleDate, payTerm, payDay) {
  const term = PAY_TERMS.includes(payTerm) ? payTerm : 'net30'
  if (term === 'immediate') return cycleDate
  if (term === 'net30') return addDays(cycleDate, PAYMENT_TERM_DAYS)

  const [y, m] = String(cycleDate).split('-').map(Number)
  if (!y || !m) return addDays(cycleDate, PAYMENT_TERM_DAYS)
  const next = term === 'nm_day' || term === 'nm_eom'
  const ty = next && m === 12 ? y + 1 : y
  const tm = next ? (m === 12 ? 1 : m + 1) : m
  const last = new Date(ty, tm, 0).getDate()
  const day = (term === 'eom' || term === 'nm_eom')
    ? last
    : Math.min(Math.max(Number(payDay) || 1, 1), last)
  return `${ty}-${String(tm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

module.exports = { fmtDate, daysInMonth, addDays, PAYMENT_TERM_DAYS, PAY_TERMS, PAY_TERMS_WITH_DAY, cashDateOf }
