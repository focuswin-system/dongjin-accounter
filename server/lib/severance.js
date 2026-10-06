/**
 * 예상 퇴직금 — **예상액**이다. 사람이 확인하고 고친다(2026-10-02 사용자 합의).
 *
 * 법정 퇴직금(근로자퇴직급여 보장법 8조): 계속근로기간 1년에 30일분 이상의 평균임금.
 *   퇴직금 = 1일 평균임금 × 30 × (재직일수 ÷ 365)
 *   1일 평균임금 = 퇴직일 이전 3개월간 임금총액 ÷ 그 기간의 총일수
 *   계속근로 1년 미만이면 대상이 아니다.
 *
 * 이 계산이 **안 하는 것**(화면에 밝힌다):
 *   · 상여금·연차수당의 3/12 가산 — 급여대장에 상여가 그 달 지급으로만 있어 기간 배분을 모른다.
 *     ⚠ 그래서 최근 3개월 급여대장에 상여가 **함께 지급됐으면 그대로 들어가** 예상액이 커진다(화면 문구에 밝힌다)
 *   · 평균임금이 통상임금보다 낮을 때 통상임금으로 바꾸는 것
 *   · 주 15시간 미만 근로자 제외
 * 그래서 '확정'이 아니라 '예상'이다.
 */
const DAY = 86400000
const ymd = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) }
const daysInMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate() }
const prevMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number)
  return Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 - (i + 1), 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` }).reverse()
}

/**
 * @param joinDate  입사일 'YYYY-MM-DD'
 * @param leaveDate 퇴사일 'YYYY-MM-DD' = **마지막 근무일**(퇴사 처리 화면이 그날을 넣는다). 재직일수는 입사일~퇴사일 **양끝 포함**.
 *   예전엔 퇴사일을 빼고 세어, 2025-10-02 입사 · 2026-10-01 마지막 근무가 364일로 '1년 미만'이 됐다(2026-10-02 검토)
 * @param wagesByMonth { 'YYYY-MM': 그 달 지급 합계 } — 급여대장
 * @param monthlyFallback 급여대장이 3개월 없을 때 쓸 월 임금(근로계약 지급 항목 합계)
 */
function estimateSeverance({ joinDate, leaveDate, wagesByMonth = {}, monthlyFallback = 0 }) {
  if (!joinDate || !leaveDate) return { eligible: false, reason: '입사일·퇴사일이 있어야 계산할 수 있어요' }
  // 날짜 모양이 아니면 계산하지 않는다 — 'NaN 원'이 '대상'으로 나가 금액 칸에 null 이 채워졌다(검토)
  const ISO = /^\d{4}-\d{2}-\d{2}$/
  if (!ISO.test(String(joinDate).slice(0, 10)) || !ISO.test(String(leaveDate).slice(0, 10))) {
    return { eligible: false, reason: '입사일·퇴사일 형식(YYYY-MM-DD)을 확인하세요' }
  }
  const serviceDays = Math.round((ymd(leaveDate) - ymd(joinDate)) / DAY) + 1
  if (!Number.isFinite(serviceDays) || serviceDays <= 0) return { eligible: false, reason: '퇴사일이 입사일보다 앞이에요' }
  if (serviceDays < 365) return { eligible: false, serviceDays, reason: '계속근로 1년 미만이라 법정 퇴직금 대상이 아니에요' }
  // 퇴사한 달 앞의 3개월 — 그 달 급여대장이 있으면 그 지급 합계
  const months = prevMonths(String(leaveDate).slice(0, 7), 3)
  const fromPayroll = months.every(m => Number(wagesByMonth[m]) > 0)
  const rows = months.map(m => ({ month: m, days: daysInMonth(m), wage: fromPayroll ? Number(wagesByMonth[m]) : Number(monthlyFallback) || 0 }))
  const wageTotal = rows.reduce((s, r) => s + r.wage, 0)
  const dayTotal = rows.reduce((s, r) => s + r.days, 0)
  if (!(wageTotal > 0)) return { eligible: false, serviceDays, reason: '최근 3개월 급여를 찾지 못했어요 — 급여대장이나 근로계약 급여 기준을 확인하세요' }
  const avgDaily = wageTotal / dayTotal
  const amount = Math.round(avgDaily * 30 * serviceDays / 365)
  return { eligible: true, serviceDays, months: rows, wageTotal, dayTotal, avgDaily: Math.round(avgDaily), amount,
    basis: fromPayroll ? 'payroll' : 'contract' }
}

module.exports = { estimateSeverance, prevMonths }
