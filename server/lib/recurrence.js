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

// start_date 앵커에서 period 간격으로 밟아 today까지의 '아직 생성 안 된' 회차 날짜 목록(오름차순).
// - period: 'monthly'(기본) | 'quarterly' | 'yearly'
// - day_of_month: 앵커 일자. 그 달 말일보다 크면 말일로 clamp(31일 앵커 → 2월 28/29, 4월 30).
// - last_generated: 이 값(포함) 이하 회차는 이미 생성됨.
// - end_date: 있으면 초과 회차 중단.
// 각 회차를 원 앵커의 '절대 월'(i*step)로 재계산하므로 오버플로 드리프트가 없다.
function dueDatesToGenerate(rec, today = new Date()) {
  if (!rec.start_date) return []
  const step = rec.period === 'yearly' ? 12 : rec.period === 'quarterly' ? 3 : 1
  const [sy, sm] = String(rec.start_date).split('-').map(Number) // sm: 1-indexed
  if (!sy || !sm) return []
  const anchorDay = Number(rec.day_of_month) || Number(String(rec.start_date).split('-')[2]) || 1
  const todayStr = fmtDate(today)
  const floor = rec.last_generated || '' // 이 값 이하(포함)는 이미 생성됨
  const out = []
  for (let i = 0; i < 1200; i++) { // 안전 상한(월간이면 100년치)
    const abs = (sm - 1) + i * step // 절대 월(0-indexed)
    const y = sy + Math.floor(abs / 12)
    const m = ((abs % 12) + 12) % 12
    const day = Math.min(anchorDay, daysInMonth(y, m)) // 월말 clamp
    const ds = fmtDate(new Date(y, m, day))
    if (ds > todayStr) break
    if (rec.end_date && ds > rec.end_date) break
    if (ds >= rec.start_date && ds > floor) out.push(ds)
  }
  return out
}

module.exports = { dueDatesToGenerate, fmtDate, daysInMonth }
