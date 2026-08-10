/* 회계 기간 계산 — '한 달'과 '한 주'가 달력과 다를 수 있다.
 *
 * 받은 실물 표머리에 "주별 총 매입 현황 (매월 25일 마감)" 이라 적혀 있다.
 * 25일 마감이면 **7월분은 6/26 ~ 7/25** 다. 달력월로 세면 표가 실물과 영영 안 맞는다.
 *
 * closingDay 0 = 달력월 그대로(기본). 1~28 = 그 날짜에 마감.
 *   29~31 을 막는 이유: 2월에 없는 날짜라 그 달만 조용히 어긋난다.
 * weekStart 0=일 … 1=월(기본).
 *
 * ⚠ 이 규칙은 **서버에만** 둔다. 화면은 기간을 스스로 계산하지 않고 서버가 쪼갠
 *   주 구간(from/to)을 그대로 받아 그린다 — 두 벌로 두면 언젠가 갈라져서
 *   화면 합계와 서버 합계가 조용히 달라진다.
 */

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * 'YYYY-MM' 회계월의 실제 시작·끝 날짜.
 *   closingDay=0  → 2026-07 = 07-01 ~ 07-31
 *   closingDay=25 → 2026-07 = 06-26 ~ 07-25
 */
function monthRange(month, closingDay = 0) {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const cd = Math.min(28, Math.max(0, Number(closingDay) || 0))
  if (!cd) {
    const last = new Date(y, m, 0).getDate()
    return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` }
  }
  // 마감일 다음 날부터 그 달 마감일까지
  const start = new Date(y, m - 2, cd + 1)   // 전달 마감 다음 날
  const end = new Date(y, m - 1, cd)
  return { from: ymd(start), to: ymd(end) }
}

/**
 * 기간을 주 단위로 쪼갠다. 각 주는 weekStart 요일에 시작하되,
 * **첫 주와 마지막 주는 기간 경계에서 잘린다**(마감일이 주 중간이라 반드시 잘린다).
 */
function weeksOf(from, to, weekStart = 1) {
  const ws = Math.min(6, Math.max(0, Number(weekStart) || 0))
  const out = []
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  let cur = new Date(start)
  while (cur <= end) {
    // 이번 주의 끝 = 다음 weekStart 하루 전
    const diff = (7 + ws - cur.getDay()) % 7 || 7
    const wEnd = new Date(cur)
    wEnd.setDate(cur.getDate() + diff - 1)
    const segEnd = wEnd > end ? end : wEnd
    out.push({ from: ymd(cur), to: ymd(segEnd) })
    cur = new Date(segEnd)
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

module.exports = { monthRange, weeksOf }
