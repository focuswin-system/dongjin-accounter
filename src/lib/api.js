// API layer — replace function bodies (not signatures) when real DB is connected.
// Component and hook code stays unchanged; only this file changes.

import { SAMPLE, TODOS_RAW } from './data'

const PREVIEW_LIMIT = 5

export const api = {
  // GET /api/todos?status=pending&date=today&assignee=:userId
  async getHomeTodos() {
    return TODOS_RAW
  },

  // GET /api/dashboard/stats
  async getHomeStats() {
    return SAMPLE.topStats
  },

  // GET /api/transactions?type=income&status=pending&sort=dueDate&limit=:limit
  async getUpcomingIn({ limit = PREVIEW_LIMIT } = {}) {
    return SAMPLE.upcomingIn.slice(0, limit)
  },

  // GET /api/transactions?type=expense&status=pending&sort=dueDate&limit=:limit
  async getUpcomingOut({ limit = PREVIEW_LIMIT } = {}) {
    return SAMPLE.upcomingOut.slice(0, limit)
  },

  // GET /api/cashflow/monthly?month=:ym  — 이달 입금/지급 예정 합계
  async getMonthCashFlow({ month = new Date().toISOString().slice(0, 7) } = {}) {
    const inRows  = SAMPLE.upcomingIn.filter(r => r.due.startsWith(month))
    const outRows = SAMPLE.upcomingOut.filter(r => r.due.startsWith(month))
    const inTotal  = inRows.reduce((a, r) => a + r.amount, 0)
    const outTotal = outRows.reduce((a, r) => a + r.amount, 0)
    return { month, inTotal, outTotal, net: inTotal - outTotal, inCount: inRows.length, outCount: outRows.length }
  },

  // GET /api/alerts  — 홈 화면 처리 필요 알림 자동 집계
  async getAlerts() {
    const overdueRec  = SAMPLE.receivables.rows.filter(r => ["기한 지남", "장기 미수"].includes(r.status))
    const pendingEvid = SAMPLE.evidenceMissing.length
    const pendingDocs = SAMPLE.docs.filter(d => d.status === "승인 요청")
    const overdueAp   = SAMPLE.payables.rows.filter(r => r.pay === "기한 지남")
    const alerts = []
    if (overdueRec.length > 0)  alerts.push({ kind: "neg",  title: "연체 미수금",      count: overdueRec.length,  desc: "발주처 결제 기한이 지난 납품 건이 있습니다.",        to: "ar" })
    if (pendingEvid > 0)        alerts.push({ kind: "warn", title: "증빙 누락",          count: pendingEvid,        desc: "영수증·세금계산서가 등록되지 않은 지출이 있습니다.", to: "evidence" })
    if (pendingDocs.length > 0) alerts.push({ kind: "warn", title: "승인 대기 결의서",  count: pendingDocs.length, desc: "외주가공·원자재 결의서가 결재선에 있습니다.",        to: "doc" })
    if (overdueAp.length > 0)   alerts.push({ kind: "neg",  title: "지급 지연 외주비",  count: overdueAp.length,   desc: "협력사 외주가공비 지급일이 경과했습니다.",           to: "ap" })
    return alerts
  },

  // PUT /api/todos/:id  { status: "done" }
  async completeTodo(_id) {
    return { ok: true }
  },
}
