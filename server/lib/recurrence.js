// 정기 반복일 계산 — 정기청구(recurring_invoices)·정기지출(recurring_expenses) 공용.
// 과거엔 두 라우트가 각자 구현해 (1) 지출은 period를 무시해 분기/연이 매달 생성됐고,
// (2) 청구는 월말일(≥29) 앵커에서 오버플로가 누적돼 회차가 밀리고 누락됐다. 여기로 단일화한다.

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

// '발행 예정' 목록에 다가오는 회차를 며칠 앞까지 미리 보여줄지(대금청구서 미리 작성용).
// 월 최대 간격(31일)보다 커서, 월간 정기청구는 다음 회차가 항상 한 번 미리 보인다.
const LOOKAHEAD_DAYS = 35

// start_date 앵커에서 period 간격으로 밟아 '아직 생성 안 된' 회차 날짜 목록(오름차순).
// - period: 'monthly'(기본) | 'quarterly' | 'yearly'
// - day_of_month: 앵커 일자. 그 달 말일보다 크면 말일로 clamp(31일 앵커 → 2월 28/29, 4월 30).
// - last_generated: 이 값(포함) 이하 회차는 이미 생성됨.
// - setup_date: 정기청구를 등록한 날(created_at의 날짜). 이 날 이전 회차는 소급하지 않는다
//   (2003년 시작 무기한 계약이 수백 건으로 쏟아지던 문제 방지 — 설정 시점부터만 청구).
// - end_date: 있으면 초과 회차 중단.
// - opts.horizonDays: 오늘 이후 며칠까지의 미래 회차도 포함(미리보기용). 기본 0(오늘까지만).
// today: 'YYYY-MM-DD' 문자열(권장 — 호출부에서 kstToday()로 KST 기준 전달) 또는 Date.
//        문자열/ds/setup_date를 모두 같은 달력일 기준으로 비교해 타임존 혼용을 막는다.
// 각 회차를 원 앵커의 '절대 월'(i*step)로 재계산하므로 오버플로 드리프트가 없다.
function dueDatesToGenerate(rec, today = new Date(), opts = {}) {
  if (!rec.start_date) return []
  const step = rec.period === 'yearly' ? 12 : rec.period === 'quarterly' ? 3 : 1
  const [sy, sm] = String(rec.start_date).split('-').map(Number) // sm: 1-indexed
  if (!sy || !sm) return []
  const anchorDay = Number(rec.day_of_month) || Number(String(rec.start_date).split('-')[2]) || 1
  const todayStr = typeof today === 'string' ? today : fmtDate(today)
  const horizonDays = Number(opts.horizonDays) || 0
  const horizonStr = horizonDays > 0 ? addDays(todayStr, horizonDays) : todayStr
  const genFloor = rec.last_generated || '' // 이 값 이하(포함)는 이미 생성됨
  const setupFloor = rec.setup_date || ''   // 등록일 이전 회차는 소급 금지(비면 제약 없음)
  const out = []
  for (let i = 0; i < 1200; i++) { // 안전 상한(월간이면 100년치)
    const abs = (sm - 1) + i * step // 절대 월(0-indexed)
    const y = sy + Math.floor(abs / 12)
    const m = ((abs % 12) + 12) % 12
    const day = Math.min(anchorDay, daysInMonth(y, m)) // 월말 clamp
    const ds = fmtDate(new Date(y, m, day))
    if (ds > horizonStr) break
    if (rec.end_date && ds > rec.end_date) break
    if (ds < rec.start_date) continue
    if (setupFloor && ds < setupFloor) continue // 설정 시점 이전 회차 건너뜀
    if (ds > genFloor) out.push(ds)
  }
  return out
}

module.exports = { dueDatesToGenerate, fmtDate, daysInMonth, addDays, LOOKAHEAD_DAYS }
