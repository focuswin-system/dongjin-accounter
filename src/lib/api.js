// API layer — replace function bodies (not signatures) when real DB is connected.
// Component and hook code stays unchanged; only this file changes.

import { SAMPLE, TODOS_RAW, ACCOUNTS_BALANCE, INVOICES, RECURRING_EXPENSES } from './data'

const PREVIEW_LIMIT = 5

export const api = {
  // GET /api/todos?status=pending&date=today&assignee=:userId
  async getHomeTodos() {
    return TODOS_RAW
  },

  // GET /api/dashboard/stats
  async getHomeStats() {
    const [arSum, apSum, inRows, outRows] = await Promise.all([
      this.getReceivablesSummary(),
      this.getPayablesSummary(),
      this.getUpcomingIn({ limit: 999 }),
      this.getUpcomingOut({ limit: 999 }),
    ])
    const month = new Date().toISOString().slice(0, 7)
    const iexTotal = inRows.filter(r => r.due.startsWith(month)).reduce((s, r) => s + r.amount, 0)
    const oexTotal = outRows.filter(r => r.due.startsWith(month)).reduce((s, r) => s + r.amount, 0)
    const iexCount = inRows.filter(r => r.due.startsWith(month)).length
    const oexCount = outRows.filter(r => r.due.startsWith(month)).length
    return [
      { id: "ar",  label: "미수금",          amount: arSum.total,  sub: `미입금 ${arSum.count}건`,   delta: 0 },
      { id: "ap",  label: "미지급금",        amount: apSum.total,  sub: `미지급 ${apSum.count}건`,   delta: 0 },
      { id: "iex", label: "이번 달 입금 예정", amount: iexTotal,    sub: `예정 ${iexCount}건`,        delta: 0 },
      { id: "oex", label: "이번 달 지급 예정", amount: oexTotal,    sub: `예정 ${oexCount}건`,        delta: 0 },
    ]
  },

  // GET /api/transactions?type=income&status=pending&sort=dueDate&limit=:limit
  async getUpcomingIn({ limit = PREVIEW_LIMIT } = {}) {
    const PENDING = new Set(["입금 예정", "일부 입금", "기한 지남", "장기 미수"])
    return INVOICES
      .filter(inv => inv.kind === "issued" && PENDING.has(inv.status))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .slice(0, limit)
      .map(inv => ({
        vendor: inv.vendor,
        contract: inv.contract,
        type: inv.status === "기한 지남" || inv.status === "장기 미수" ? inv.status : "입금 예정",
        amount: inv.totalAmount - inv.matches.reduce((s, m) => s + m.amount, 0),
        due: inv.dueAt,
      }))
  },

  // GET /api/transactions?type=expense&status=pending&sort=dueDate&limit=:limit
  async getUpcomingOut({ limit = PREVIEW_LIMIT } = {}) {
    const PENDING = new Set(["지급 대기", "지급 예정", "일부 지급", "기한 지남"])
    return INVOICES
      .filter(inv => inv.kind === "received" && PENDING.has(inv.status))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .slice(0, limit)
      .map(inv => ({
        vendor: inv.vendor,
        note: inv.contract || inv.memo || "",
        amount: inv.totalAmount - inv.matches.reduce((s, m) => s + m.amount, 0),
        due: inv.dueAt,
      }))
  },

  // GET /api/cashflow/monthly?month=:ym  — 이달 입금/지급 예정 합계
  async getMonthCashFlow({ month = new Date().toISOString().slice(0, 7) } = {}) {
    const [inRows, outRows] = await Promise.all([
      this.getUpcomingIn({ limit: 999 }),
      this.getUpcomingOut({ limit: 999 }),
    ])
    const monthIn  = inRows.filter(r => r.due.startsWith(month))
    const monthOut = outRows.filter(r => r.due.startsWith(month))
    const inTotal  = monthIn.reduce((a, r) => a + r.amount, 0)
    const outTotal = monthOut.reduce((a, r) => a + r.amount, 0)
    return { month, inTotal, outTotal, net: inTotal - outTotal, inCount: monthIn.length, outCount: monthOut.length }
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

  // F1: 계좌별 잔액 ─────────────────────────────────────────────
  async getAccounts() {
    return ACCOUNTS_BALANCE.map(acc => ({
      ...acc,
      currentBalance: this._calcBalance(acc),
    }))
  },

  _calcBalance(acc) {
    const txIn  = INVOICES.filter(inv => inv.kind === "issued" && inv.accountId === acc.id && inv.status === "입금 완료")
      .reduce((s, inv) => s + inv.matches.reduce((ms, m) => ms + m.amount, 0), 0)
    const txOut = SAMPLE.expenses.filter(e => (e.account || "").includes(acc.name.split(" ")[0]) && e.pay === "지급 완료")
      .reduce((s, e) => s + e.amount, 0)
    const adjTotal = acc.adjustments.reduce((s, a) => s + a.amount, 0)
    return acc.initialBalance + txIn - txOut + adjTotal
  },

  async addAdjustment(accountId, { amount, reason, by = "한경리" }) {
    const acc = ACCOUNTS_BALANCE.find(a => a.id === accountId)
    if (!acc) return { ok: false }
    const adj = { id: `adj-${Date.now()}`, date: new Date().toISOString().slice(0, 10), amount, reason, by }
    acc.adjustments.unshift(adj)
    return { ok: true, adjustment: adj }
  },

  // F2: 청구서 ──────────────────────────────────────────────────
  async getInvoices({ kind, status } = {}) {
    let rows = [...INVOICES]
    if (kind) rows = rows.filter(r => r.kind === kind)
    if (status) rows = rows.filter(r => r.status === status)
    return rows.map(inv => ({
      ...inv,
      paidAmount: inv.matches.reduce((s, m) => s + m.amount, 0),
      remainAmount: inv.totalAmount - inv.matches.reduce((s, m) => s + m.amount, 0),
    }))
  },

  async getReceivablesSummary() {
    const issued = INVOICES.filter(inv => inv.kind === "issued" && inv.status !== "입금 완료")
    const total = issued.reduce((s, inv) => s + (inv.totalAmount - inv.matches.reduce((ms, m) => ms + m.amount, 0)), 0)
    const overdue = issued.filter(inv => ["기한 지남", "장기 미수"].includes(inv.status))
      .reduce((s, inv) => s + (inv.totalAmount - inv.matches.reduce((ms, m) => ms + m.amount, 0)), 0)
    return { total, count: issued.length, overdueAmount: overdue, overdueCount: issued.filter(inv => ["기한 지남", "장기 미수"].includes(inv.status)).length }
  },

  async getPayablesSummary() {
    const received = INVOICES.filter(inv => inv.kind === "received" && inv.status !== "지급 완료")
    const total = received.reduce((s, inv) => s + (inv.totalAmount - inv.matches.reduce((ms, m) => ms + m.amount, 0)), 0)
    const overdue = received.filter(inv => inv.status === "기한 지남")
      .reduce((s, inv) => s + (inv.totalAmount - inv.matches.reduce((ms, m) => ms + m.amount, 0)), 0)
    return { total, count: received.length, overdueAmount: overdue, overdueCount: received.filter(inv => inv.status === "기한 지남").length }
  },

  async addInvoice(data) {
    const inv = { id: `INV-${Date.now()}`, matches: [], ...data }
    INVOICES.push(inv)
    return { ok: true, invoice: inv }
  },

  async matchInvoice(invoiceId, { txnId, amount }) {
    const inv = INVOICES.find(i => i.id === invoiceId)
    if (!inv) return { ok: false }
    inv.matches.push({ txnId, amount, matchedAt: new Date().toISOString().slice(0, 10) })
    const paid = inv.matches.reduce((s, m) => s + m.amount, 0)
    inv.status = paid >= inv.totalAmount ? (inv.kind === "issued" ? "입금 완료" : "지급 완료")
                                        : (inv.kind === "issued" ? "일부 입금" : "일부 지급")
    return { ok: true }
  },

  // F3: 부가세 ──────────────────────────────────────────────────
  async getVatSummary(quarter) {
    const qMonths = { Q1: ["01","02","03"], Q2: ["04","05","06"], Q3: ["07","08","09"], Q4: ["10","11","12"] }
    const months = qMonths[quarter] || []
    const inRange = inv => months.length === 0 || months.includes(inv.issuedAt?.slice(5, 7))
    const salesVat    = INVOICES.filter(inv => inv.kind === "issued"   && inRange(inv)).reduce((s, inv) => s + inv.vatAmount, 0)
    const purchaseVat = INVOICES.filter(inv => inv.kind === "received" && inRange(inv)).reduce((s, inv) => s + inv.vatAmount, 0)
    const salesInvoices    = INVOICES.filter(inv => inv.kind === "issued"   && inRange(inv))
    const purchaseInvoices = INVOICES.filter(inv => inv.kind === "received" && inRange(inv))
    return { quarter, salesVat, purchaseVat, netVat: salesVat - purchaseVat, salesInvoices, purchaseInvoices }
  },

  // F4: 정기 지출 ───────────────────────────────────────────────
  async getRecurringExpenses() {
    return [...RECURRING_EXPENSES]
  },

  async addRecurringExpense(data) {
    const rec = { id: `rec-${Date.now()}`, active: true, lastGenerated: null, ...data }
    RECURRING_EXPENSES.push(rec)
    return { ok: true, recurring: rec }
  },

  async toggleRecurringExpense(id) {
    const rec = RECURRING_EXPENSES.find(r => r.id === id)
    if (!rec) return { ok: false }
    rec.active = !rec.active
    return { ok: true, active: rec.active }
  },

  // F5+F6: 계약 마일스톤·원가예산 (Contract.jsx에서 CONTRACT_LIST 직접 참조)
}
