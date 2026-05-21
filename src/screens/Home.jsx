import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Icon, fmtNum, useToast, useConfirm, Popover, PopItem, Spacer } from '../lib/ui'
import { api } from '../lib/api'

const localDateStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

// 오늘 날짜 기준 D-day 계산 (due: "YYYY-MM-DD")
const calcDDay = (due) => {
  const today = new Date(); today.setHours(0,0,0,0)
  const dueDate = new Date(due); dueDate.setHours(0,0,0,0)
  const diff = Math.round((dueDate - today) / 86400000)
  if (diff === 0) return "오늘"
  if (diff < 0)  return `${Math.abs(diff)}일 초과`
  return `D-${diff}`
}

const dDayTone = (due) => {
  const today = new Date(); today.setHours(0,0,0,0)
  const diff = Math.round((new Date(due) - today) / 86400000)
  if (diff < 0)  return "neg"
  if (diff <= 3) return "warn"
  return "brand"
}

// Icon/tone mapping is a client-side concern — not stored in DB.
const TODO_KIND_META = {
  ar:       { icon: <Icon.In size={14}/>,      toneColor: 'var(--brand)' },
  doc:      { icon: <Icon.Sign size={14}/>,    toneColor: 'var(--warn-ink)' },
  evidence: { icon: <Icon.Receipt size={14}/>, toneColor: 'var(--warn-ink)' },
  ap:       { icon: <Icon.Bank size={14}/>,    toneColor: 'var(--neg-ink)' },
}

export const MiniStat = ({ label, value, sub, tone = "ink" }) => (
  <div className="card" style={{ padding: "16px 18px", minWidth: 0 }}>
    <div className="row gap-8" style={{ marginBottom: 6 }}>
      <span className="text-sm text-muted fw-600" style={{ whiteSpace: "nowrap" }}>{label}</span>
      <span className={`badge ${tone === "ink" ? "outline" : tone}`} style={{ marginLeft: "auto" }}>{sub}</span>
    </div>
    <div className="num fw-700" style={{ fontSize: 22, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>{value}</div>
  </div>
)

const WEEK_KO = ["일", "월", "화", "수", "목", "금", "토"]
const todayLabel = () => {
  const d = new Date()
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK_KO[d.getDay()]}요일`
}

const ALERT_ROUTE = { ar: "billing_issued", ap: "billing_received", doc: "doc", evidence: "evidence" }

export const HomeScreen = ({ go, user, openIncome, openExpense }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [doneIds, setDoneIds] = useState(new Set())
  const [paymentModal, setPaymentModal] = useState(null) // { todo, date, kind: 'ar'|'ap' }

  const [todos, setTodos] = useState([])
  const [stats, setStats] = useState([])
  const [upcomingIn, setUpcomingIn] = useState([])
  const [upcomingOut, setUpcomingOut] = useState([])
  const [cashFlow, setCashFlow] = useState(null)
  const [alerts, setAlerts] = useState([])

  useEffect(() => {
    Promise.all([
      api.getHomeTodos(),
      api.getHomeStats(),
      api.getUpcomingIn(),
      api.getUpcomingOut(),
      api.getMonthCashFlow(),
      api.getAlerts(),
    ]).then(([t, s, ui, uo, cf, al]) => {
      setTodos(t)
      setStats(s)
      setUpcomingIn(ui)
      setUpcomingOut(uo)
      setCashFlow(cf)
      setAlerts(al)
    })
  }, [])

  const handleTodoAction = async (t) => {
    if (t.kind === "ar") {
      setPaymentModal({ todo: t, date: localDateStr(), kind: 'ar' })
    } else if (t.kind === "ap") {
      setPaymentModal({ todo: t, date: localDateStr(), kind: 'ap' })
    } else if (t.kind === "doc") {
      await api.completeTodo(t.id)
      setDoneIds(s => new Set([...s, t.id]))
      toast.push("결의서를 승인했어요")
    } else if (t.kind === "evidence") {
      go("evidence")
    }
  }

  const handlePaymentConfirm = async () => {
    const { todo, kind } = paymentModal
    await api.completeTodo(todo.id)
    setDoneIds(s => new Set([...s, todo.id]))
    toast.push(kind === 'ar' ? "입금이 처리되었어요" : "이체가 실행되었어요")
    setPaymentModal(null)
  }

  const enrichedTodos = todos.map(t => ({ ...t, ...TODO_KIND_META[t.kind] }))
  const pendingTodos = enrichedTodos.filter(t => !doneIds.has(t.id))

  const paymentModalEl = paymentModal && createPortal(
    <div onClick={() => setPaymentModal(null)}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(11,18,32,0.35)", display: "grid", placeItems: "center", backdropFilter: "blur(2px)" }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 16, width: "min(420px, calc(100vw - 32px))", padding: 28, boxShadow: "0 30px 60px -20px rgba(15,23,42,0.3)", animation: "fadeUp .18s ease" }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, display: "grid", placeItems: "center",
            background: paymentModal.kind === 'ar' ? "var(--pos-bg)" : "var(--neg-bg)",
            color: paymentModal.kind === 'ar' ? "var(--pos)" : "var(--neg)" }}>
            {paymentModal.kind === 'ar' ? <Icon.In size={22}/> : <Icon.Bank size={22}/>}
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.35 }}>{paymentModal.todo.title}</div>
        </div>
        <div style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.65, marginBottom: 20 }}>
          {paymentModal.kind === 'ar'
            ? `${paymentModal.todo.sub}을(를) 입금 완료로 처리합니다.`
            : `${paymentModal.todo.sub}을(를) 등록된 계좌에서 이체합니다.`}
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>
            {paymentModal.kind === 'ar' ? '입금일' : '지급일'} <span style={{ color: "var(--neg-ink)" }}>*</span>
          </label>
          <input type="date" className="input" value={paymentModal.date}
            max={localDateStr()}
            onChange={e => setPaymentModal(m => ({ ...m, date: e.target.value }))}
            style={{ width: "100%" }}/>
          <div style={{ fontSize: 11.5, color: "var(--muted2)", marginTop: 5 }}>기본값: 오늘. 실제 입금·이체된 날짜를 선택하세요.</div>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={() => setPaymentModal(null)}>취소</button>
          <button className="btn" onClick={handlePaymentConfirm}
            style={{ background: paymentModal.kind === 'ar' ? "var(--pos)" : "var(--neg-ink)", color: "#fff", borderColor: "transparent" }}>
            {paymentModal.kind === 'ar' ? '입금 처리' : '이체 실행'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )

  return (
    <>
    <div className="fade-up">
      <div className="row page-header-row" style={{ alignItems: "flex-end", marginBottom: 22 }}>
        <div>
          <div className="page-title">{user?.displayName || "관리자"}님, 오늘의 자금 현황입니다</div>
          <div className="page-sub">{todayLabel()}</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={() => toast.push("이번 달 보고서를 내려받았어요")}>
            <Icon.Download/> <span className="btn-label-hide">보고서 내려받기</span>
          </button>
          <Popover align="right" width={220}
            trigger={<button className="btn primary"><Icon.Plus/> 거래 등록 <Icon.Down size={12} style={{ marginLeft: 2 }}/></button>}>
            <div style={{ padding: 6 }}>
              <PopItem icon={<Icon.In size={16}/>}    label="입금 등록"   sub="발주처 입금"        onClick={openIncome}/>
              <PopItem icon={<Icon.Out size={16}/>}   label="지출 등록"   sub="외주·자재·운영비" onClick={openExpense}/>
              <div style={{ height: 1, background: "var(--line)", margin: "6px 0" }}/>
              <PopItem icon={<Icon.Excel size={16}/>} label="엑셀 업로드" sub="여러 건 한 번에"    onClick={() => go("excel_modal")}/>
            </div>
          </Popover>
        </div>
      </div>

      {/* 오늘 할 일 */}
      <div className="card" style={{ overflow: "hidden", marginBottom: 24 }}>
        <div className="row" style={{ padding: "18px 22px", borderBottom: "1px solid var(--line)" }}>
          <div>
            <div className="section-title">오늘 할 일 <span className="num text-muted2" style={{ fontWeight: 500, marginLeft: 6 }}>{pendingTodos.length}건</span></div>
            <div className="section-sub">행마다 바로 처리할 수 있어요. 통장 확인이 끝난 건부터 처리해보세요.</div>
          </div>
          {pendingTodos.length === 0 && (
            <div className="ml-auto badge pos"><Icon.Check size={11}/> 모두 처리 완료</div>
          )}
        </div>

        {pendingTodos.length === 0 ? (
          <div style={{ padding: 50, textAlign: "center", color: "var(--muted)" }}>
            <Icon.Check size={32} className="text-pos"/>
            <div className="fw-700" style={{ fontSize: 15, marginTop: 8, color: "var(--ink)" }}>오늘 처리할 일이 모두 끝났어요</div>
            <div className="text-sm" style={{ marginTop: 4 }}>{user?.displayName || "관리자"}님, 수고하셨습니다.</div>
          </div>
        ) : (
          <div>
            {pendingTodos.map((t, i) => (
              <div key={t.id} className="row gap-12" style={{
                padding: "16px 22px", borderTop: i ? "1px solid var(--line)" : 0,
                transition: "background .12s", cursor: "default",
              }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--surface-2)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{
                  width: 32, height: 32, borderRadius: 10, flexShrink: 0,
                  background: t.toneColor === "var(--brand)" ? "var(--brand-soft)"
                           : t.toneColor === "var(--warn-ink)" ? "var(--warn-soft)"
                           : "var(--neg-soft)",
                  color: t.toneColor,
                  display: "grid", placeItems: "center",
                }}>{t.icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row gap-8" style={{ marginBottom: 2 }}>
                    <span className="text-xs fw-700" style={{ color: t.toneColor }}>{t.tag}</span>
                  </div>
                  <div className="fw-700" style={{ fontSize: 14, marginBottom: 2 }}>{t.title}</div>
                  <div className="text-xs text-muted">{t.sub}</div>
                </div>
                <button className="btn primary sm" onClick={() => handleTodoAction(t)} style={{ minWidth: 64 }}>
                  {t.action}
                </button>
                <button className="btn ghost sm" onClick={async () => {
                  const ok = await confirm({
                    tone: "warn",
                    icon: <Icon.Clock size={22}/>,
                    title: "나중에 처리할까요?",
                    body: `"${t.title}" 항목을 오늘 할 일 목록에서 제외합니다.`,
                    confirmLabel: "나중에 처리",
                  })
                  if (ok) {
                    setDoneIds(s => new Set([...s, t.id]))
                    toast.push("나중에 처리하기로 미뤘어요")
                  }
                }}>
                  <Icon.Close size={14}/>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 자금 요약 */}
      <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.02em", marginBottom: 10, padding: "0 4px" }}>자금 현황</div>
      <div className="grid grid-4-to-2" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
        {stats.map(s => (
          <button key={s.id}
            onClick={() => go(s.id === "ar" ? "ledger_ar" : s.id === "ap" ? "ledger_ap" : s.id === "iex" ? "ledger_income" : "ledger_expense")}
            className="card"
            style={{ padding: "14px 16px", textAlign: "left", cursor: "pointer", fontFamily: "inherit", border: "1px solid var(--line)", transition: "border-color .12s" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = "var(--line-strong)"}
            onMouseLeave={e => e.currentTarget.style.borderColor = "var(--line)"}>
            <div className="row gap-6" style={{ marginBottom: 6 }}>
              <span className="text-sm text-muted fw-600">{s.label}</span>
              <span className="ml-auto row gap-4" style={{ fontSize: 11, fontWeight: 600, color: s.delta > 0 ? "var(--pos)" : "var(--neg-ink)" }}>
                {s.delta > 0 ? <Icon.Trend size={11}/> : <Icon.TrendDn size={11}/>}
                <span className="num">{s.delta > 0 ? "+" : ""}{s.delta}%</span>
              </span>
            </div>
            <div className="num fw-700" style={{ fontSize: 20, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>
              {fmtNum(s.amount)}<span className="text-muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 3 }}>원</span>
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>{s.sub}</div>
          </button>
        ))}
      </div>

      {/* 처리 필요 알림 */}
      {alerts.length > 0 && (
        <div className="col gap-8" style={{ marginBottom: 24 }}>
          {alerts.map((a, i) => (
            <button key={i} onClick={() => go(ALERT_ROUTE[a.to] || a.to)}
              className="row gap-12"
              style={{ padding: "12px 16px", border: `1px solid var(--${a.kind}-soft)`, borderRadius: 12, background: `var(--${a.kind}-soft)`, cursor: "pointer", textAlign: "left", fontFamily: "inherit", transition: "opacity .12s", width: "100%" }}
              onMouseEnter={e => e.currentTarget.style.opacity = "0.8"}
              onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: `var(--${a.kind}-soft)`, border: `1px solid var(--${a.kind})`, color: `var(--${a.kind}-ink)`, display: "grid", placeItems: "center", flexShrink: 0 }}>
                {a.kind === "neg" ? <Icon.Warn size={13}/> : <Icon.Bell size={13}/>}
              </div>
              <div style={{ flex: 1 }}>
                <span className="fw-700 text-sm" style={{ color: `var(--${a.kind}-ink)` }}>{a.title}</span>
                <span className="num fw-600 text-sm" style={{ marginLeft: 6, color: `var(--${a.kind})` }}>{a.count}건</span>
                <div className="text-xs text-muted" style={{ marginTop: 2 }}>{a.desc}</div>
              </div>
              <Icon.Right size={13} style={{ color: `var(--${a.kind})`, flexShrink: 0 }}/>
            </button>
          ))}
        </div>
      )}

      {/* 입금/지급 예정 */}
      <div className="grid grid-2-to-1" style={{ gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div className="card">
          <div className="row" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
            <div className="section-title" style={{ fontSize: 14 }}>입금 예정</div>
            <button className="btn ghost sm ml-auto" onClick={() => go("ledger_ar")}>전체 <Icon.Right size={12}/></button>
          </div>
          {upcomingIn.map((r, i) => (
            <div key={i} className="row gap-10" style={{ padding: "12px 18px", borderTop: i ? "1px solid var(--line)" : 0 }}>
              <span className={`badge ${dDayTone(r.due)}`} style={{ fontSize: 10, padding: "2px 6px", flexShrink: 0 }}>{calcDDay(r.due)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="text-sm fw-600" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.vendor}</div>
                <div className="text-xs text-muted2" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.contract} · {r.type}</div>
              </div>
              <span className="num fw-700 text-sm" style={{ whiteSpace: "nowrap" }}>{fmtNum(r.amount)}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="row" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
            <div className="section-title" style={{ fontSize: 14 }}>지급 예정</div>
            <button className="btn ghost sm ml-auto" onClick={() => go("ledger_ap")}>전체 <Icon.Right size={12}/></button>
          </div>
          {upcomingOut.map((r, i) => (
            <div key={i} className="row gap-10" style={{ padding: "12px 18px", borderTop: i ? "1px solid var(--line)" : 0 }}>
              <span className={`badge ${dDayTone(r.due)}`} style={{ fontSize: 10, padding: "2px 6px", flexShrink: 0 }}>{calcDDay(r.due)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="text-sm fw-600" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.vendor}</div>
                <div className="text-xs text-muted2">{r.note}</div>
              </div>
              <span className="num fw-700 text-sm" style={{ whiteSpace: "nowrap" }}>{fmtNum(r.amount)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 이달 현금흐름 예측 */}
      {cashFlow && (
        <div className="card card-pad" style={{ background: cashFlow.net >= 0 ? "var(--pos-soft)" : "var(--neg-soft)", borderColor: "transparent" }}>
          <div className="row gap-8" style={{ marginBottom: 14 }}>
            <div className="section-title" style={{ fontSize: 14 }}>
              이달 현금흐름 예측
            </div>
            <span className="text-xs text-muted" style={{ marginLeft: 4, lineHeight: "20px" }}>
              {cashFlow.month.replace("-", "년 ")}월 · 앱 내 예정 데이터 기준
            </span>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div>
              <div className="text-xs text-muted fw-600" style={{ marginBottom: 4 }}>입금 예정 ({cashFlow.inCount}건)</div>
              <div className="num fw-700" style={{ fontSize: 18, color: "var(--pos)" }}>+{fmtNum(cashFlow.inTotal)}<span style={{ fontSize: 12, fontWeight: 400, marginLeft: 2 }}>원</span></div>
            </div>
            <div>
              <div className="text-xs text-muted fw-600" style={{ marginBottom: 4 }}>지급 예정 ({cashFlow.outCount}건)</div>
              <div className="num fw-700" style={{ fontSize: 18, color: "var(--neg)" }}>−{fmtNum(cashFlow.outTotal)}<span style={{ fontSize: 12, fontWeight: 400, marginLeft: 2 }}>원</span></div>
            </div>
            <div style={{ borderLeft: "1px solid var(--line)", paddingLeft: 16 }}>
              <div className="text-xs text-muted fw-600" style={{ marginBottom: 4 }}>예상 순 현금 변동</div>
              <div className="num fw-700" style={{ fontSize: 18, color: cashFlow.net >= 0 ? "var(--pos)" : "var(--neg)" }}>
                {cashFlow.net >= 0 ? "+" : "−"}{fmtNum(Math.abs(cashFlow.net))}<span style={{ fontSize: 12, fontWeight: 400, marginLeft: 2 }}>원</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
    {paymentModalEl}
    </>
  )
}
