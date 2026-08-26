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

/* 기준일이 **어느 회계월에 속하는가**.
 *
 * 25일 마감이면 8/26 은 달력으로 8월이지만 회계로는 9월분(8/26~9/25)이다.
 * 예전엔 달력월을 그대로 써서, 마감일을 넘긴 날(매달 26~31일, 연 72일)에 offset=0 이
 * **이미 끝난 구간**(7/26~8/25)을 가리켰다. 그 구간은 range.to < today 라 예정을 아예
 * 안 세므로 화면이 "이 달 나갈 돈 0원"으로 떴다 — 급여일·카드결제일이 든 달을 통째로 놓친다.
 */
function fiscalMonthOf(baseDate, closingDay = 0) {
  const [y, m, d] = String(baseDate).split('-').map(Number)
  const cd = Math.min(28, Math.max(0, Number(closingDay) || 0))
  if (!cd || d <= cd) return { y, m }
  const t = new Date(y, m, 1)          // m 은 1-based → 다음 달
  return { y: t.getFullYear(), m: t.getMonth() + 1 }
}

/** 그 단위의 구간 하나 — 기준일이 속한 구간을 offset 만큼 앞뒤로 옮긴 것. */
function periodRange(unit, baseDate, offset = 0, { closingDay = 0, weekStart = 1 } = {}) {
  const u = pick(unit)
  const [y, m, d] = String(baseDate).split('-').map(Number)

  if (u === 'week') {
    // 주는 마감 개념이 없다 — 주 시작요일로만 끊는다
    const base = new Date(y, m - 1, d + offset * 7)
    const ws = Math.min(6, Math.max(0, Number(weekStart) || 0))
    const back = (base.getDay() - ws + 7) % 7
    const from = new Date(base); from.setDate(base.getDate() - back)
    const to = new Date(from); to.setDate(from.getDate() + 6)
    return { unit: u, from: ymd(from), to: ymd(to) }
  }

  // 월·분기·년은 **기준일이 속한 회계월**에서 출발한다(달력월이 아니다)
  const fm = fiscalMonthOf(baseDate, closingDay)

  if (u === 'month') {
    const t = new Date(fm.y, fm.m - 1 + offset, 1)
    return { unit: u, ...monthRange(`${t.getFullYear()}-${pad(t.getMonth() + 1)}`, closingDay) }
  }

  if (u === 'quarter') {
    // 분기 = 달 3개를 이어 붙인다. 마감일이 있으면 시작 달의 시작일 ~ 끝 달의 끝일.
    const q = Math.floor((fm.m - 1) / 3) + offset
    const y2 = fm.y + Math.floor(q / 4)
    const q2 = ((q % 4) + 4) % 4
    const first = monthRange(`${y2}-${pad(q2 * 3 + 1)}`, closingDay)
    const last = monthRange(`${y2}-${pad(q2 * 3 + 3)}`, closingDay)
    return { unit: u, from: first.from, to: last.to }
  }

  // year — 1월분의 시작 ~ 12월분의 끝(마감일이 있으면 전년 12/26 부터 시작하기도 한다)
  const y2 = fm.y + offset
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

/** 연속한 구간들 — 화면의 '한 눈에 보기'.
 *
 * base = **지금 보고 있는 구간**의 offset. 예전엔 늘 오늘 기준으로 앞뒤 6칸씩 13줄을 냈는데,
 * 8월을 보든 11월을 보든 같은 13줄이 떠서 "고른 것과 상관없는 달"이 첫 화면을 다 먹었다.
 * 지금은 보고 있는 구간과 그 다음 한 칸만 낸다(back=0, forward=1). offset 은 **절대값**으로
 * 유지한다 — 화면이 이 값으로 구간을 옮기기 때문이다. */
function periodSeries(unit, baseDate, { back = 6, forward = 6, base = 0, closingDay = 0, weekStart = 1 } = {}) {
  const out = []
  for (let i = base - Math.abs(back); i <= base + Math.abs(forward); i++) {
    const r = periodRange(unit, baseDate, i, { closingDay, weekStart })
    out.push({ ...r, offset: i, label: periodLabel(pick(unit), r) })
  }
  return out
}

/* ── 구간을 한 단계 잘게 쪼갠다 ────────────────────────────────────────────
 *
 * 자금 현황의 결론은 "이 달에 얼마 남나"가 아니라 **"며칠에 어느 통장이 비나"** 다.
 * 구간 합계만 보면 월말에 흑자여도 25일 급여일에 통장이 비는 걸 못 본다 —
 * 그 날 이체가 안 나가면 신용 문제가 되므로, 합계로는 답이 안 된다.
 *
 * 그래서 고른 단위보다 **한 칸 잘게** 쪼갠 축을 함께 낸다.
 *   주·월 → 일자별 / 분기 → 주별 / 년 → 월별
 * 더 잘게 쪼개면(1년을 일자로) 칸이 365개가 되어 도로 안 보인다.
 */
const BUCKET_OF = { week: 'day', month: 'day', quarter: 'week', year: 'month' }

function bucketsOf(unit, range, { weekStart = 1, closingDay = 0 } = {}) {
  const b = BUCKET_OF[pick(unit)]
  if (b === 'week') {
    return weeksOf(range.from, range.to, weekStart)
      .map(w => ({ ...w, label: `${w.from.slice(5)} ~ ${w.to.slice(5)}` }))
  }
  if (b === 'month') {
    const out = []
    const [fy, fm] = range.from.split('-').map(Number)
    // 마감일이 있으면 회계월이 달력월과 어긋난다 — monthRange 로 잘라야 구간 합계와 맞는다
    for (let k = 0; k < 14; k++) {
      const t = new Date(fy, fm - 1 + k, 1)
      const key = `${t.getFullYear()}-${pad(t.getMonth() + 1)}`
      const r = monthRange(key, closingDay)
      if (r.from > range.to) break
      const from = r.from < range.from ? range.from : r.from
      const to = r.to > range.to ? range.to : r.to
      if (from > to) continue
      out.push({ from, to, label: `${Number(key.slice(5, 7))}월` })
    }
    return out
  }
  // day
  const out = []
  const end = new Date(`${range.to}T00:00:00`)
  for (let cur = new Date(`${range.from}T00:00:00`); cur <= end; cur.setDate(cur.getDate() + 1)) {
    const day = ymd(cur)
    out.push({ from: day, to: day, label: day.slice(5) })
  }
  return out
}

/** 하루 전 날짜 — 구간 시작 시점의 '전날 잔액'을 구할 때 쓴다 */
function dayBefore(date) {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() - 1)
  return ymd(d)
}

/** 바깥에서 들어온 날짜 문자열을 받아들일지 정한다 — `YYYY-MM-DD` 만 통과, 아니면 null.
 *  쿼리스트링을 그대로 조회 조건으로 넘기지 않기 위한 문지기다.
 *  ⚠ 정규식의 역슬래시를 잃으면(`/^d{4}-d{2}-d{2}$/`) **무엇을 넣어도 null** 이 되어,
 *    사용자가 기간을 골라도 조용히 무시된다. 실제로 차입금 엑셀이 그렇게 새어 나갔다 —
 *    화면은 멀쩡해 보이고 파일만 전 기간으로 나왔다. period.test.js 가 이 자리를 지킨다. */
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null)

module.exports = {
  monthRange, weeksOf, periodRange, periodLabel, periodSeries, UNITS, fiscalMonthOf,
  bucketsOf, dayBefore, BUCKET_OF, dateOrNull,
}
