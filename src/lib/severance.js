import { fmtNum } from './ui'

/* 예상 퇴직금 한 줄 설명 — 서버 lib/severance.js 결과를 사람이 읽는 말로.
   메모에 남겨 나중에 "이 금액이 어디서 나왔나"를 볼 수 있게 한다 */
export const severanceBasisText = (est) => (est?.eligible
  ? `예상액 — 1일 평균임금 ${fmtNum(est.avgDaily)}원 × 30 × 재직 ${fmtNum(est.serviceDays)}일 ÷ 365 (${est.basis === 'payroll' ? '최근 3개월 급여대장' : '근로계약 급여 기준'})`
  : (est?.reason || ''))

/* 법정 지급 기한 — 퇴직일부터 14일 이내(근로기준법 36조) */
export const severanceDueDate = (leaveDate) => {
  if (!leaveDate) return ''
  const [y, m, d] = leaveDate.split('-').map(Number)
  const t = new Date(y, m - 1, d + 14)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

/* 계산에서 빠진 것 — 화면에 짧게 */
export const SEVERANCE_CAVEAT = '예상액이에요 — 최근 3개월 급여대장에 상여가 있으면 그대로 들어가고, 연차수당 가산·통상임금 비교는 빠졌어요. 확인하고 고쳐 주세요.'
