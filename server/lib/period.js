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

/* ── 기간 단위 ────────────────────────────────────────────────────────────
 *
 * 자금 현황은 주·월·분기·년 어느 단위로도 봐야 한다. 달이 특별한 게 아니라
 * 단위 중 하나일 뿐이다("이건 달별로도, 분기별로도, 주별로도 볼 수 있어야 한다").
 *
 * 월·분기·년은 **마감일**을 따른다 — 25일 마감 회사면 7월은 6/26~7/25 다.
 * 회사가 세는 '한 달'이 화면마다 다르면 매입·매출 현황과 자금 현황이 어긋난다.
 * 주는 마감일과 무관하게 주 시작요일로만 끊는다(주 단위에 마감 개념이 없다).
 */
const UNITS = ['week', 'month', 'quarter', 'year']

const pick = (u) => (UNITS.includes(u) ? u : 'month')

/** 그 단위의 구간 하나 — 기준일이 속한 구간을 offset 만큼 앞뒤로 옮긴 것. */
function periodRange(unit, baseDate, offset = 0, { closingDay = 0, weekStart = 1 } = {}) {
  const u = pick(unit)
  const [y, m, d] = String(baseDate).split('-').map(Number)

  if (u === 'week') {
    const base = new Date(y, m - 1, d + offset * 7)
    const ws = Math.min(6, Math.max(0, Number(weekStart) || 0))
    const back = (base.getDay() - ws + 7) % 7
    const from = new Date(base); from.setDate(base.getDate() - back)
    const to = new Date(from); to.setDate(from.getDate() + 6)
    return { unit: u, from: ymd(from), to: ymd(to) }
  }

  if (u === 'month') {
    const t = new Date(y, m - 1 + offset, 1)
    return { unit: u, ...monthRange(`${t.getFullYear()}-${pad(t.getMonth() + 1)}`, closingDay) }
  }

  if (u === 'quarter') {
    // 분기 = 달 3개를 이어 붙인다. 마감일이 있으면 시작 달의 시작일 ~ 끝 달의 끝일.
    const q = Math.floor((m - 1) / 3) + offset
    const y2 = y + Math.floor(q / 4)
    const q2 = ((q % 4) + 4) % 4
    const first = monthRange(`${y2}-${pad(q2 * 3 + 1)}`, closingDay)
    const last = monthRange(`${y2}-${pad(q2 * 3 + 3)}`, closingDay)
    return { unit: u, from: first.from, to: last.to }
  }

  // year — 1월분의 시작 ~ 12월분의 끝(마감일이 있으면 전년 12/26 부터 시작하기도 한다)
  const y2 = y + offset
  return { unit: u, from: monthRange(`${y2}-01`, closingDay).from, to: monthRange(`${y2}-12`, closingDay).to }
}

/** 사람이 읽는 구간 이름 — 화면 탭·표 머리에 그대로 쓴다. */
function periodLabel(unit, range) {
  const [y, m, d] = range.from.split('-').map(Number)
  if (unit === 'week')    return `${range.from.slice(5)} ~ ${range.to.slice(5)}`
  if (unit === 'quarter') return `${range.to.slice(0, 4)}년 ${Math.floor((Number(range.to.slice(5, 7)) - 1) / 3) + 1}분기`
  if (unit === 'year')    return `${range.to.slice(0, 4)}년`
  // 월 — 마감일이 있으면 '끝나는 달'이 그 달분이다(6/26~7/25 = 7월분)
  return `${range.to.slice(0, 4)}년 ${Number(range.to.slice(5, 7))}월`
}

/** 연속한 구간들 — 화면의 '한 눈에 보기'(월이면 12칸, 주면 12주). 과거→미래 순. */
function periodSeries(unit, baseDate, { back = 6, forward = 6, closingDay = 0, weekStart = 1 } = {}) {
  const out = []
  for (let i = -Math.abs(back); i <= Math.abs(forward); i++) {
    const r = periodRange(unit, baseDate, i, { closingDay, weekStart })
    out.push({ ...r, offset: i, label: periodLabel(pick(unit), r) })
  }
  return out
}

module.exports = { monthRange, weeksOf, periodRange, periodLabel, periodSeries, UNITS }
