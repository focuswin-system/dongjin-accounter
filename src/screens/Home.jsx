import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Icon, fmtNum, useToast, Popover, PopItem } from '../lib/ui'
import { api } from '../lib/api'
import { NAV_TREE, SETTINGS_LEAF, ALL_LEAVES, LEAF_BY_ID } from '../lib/nav'

const localDateStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

const WEEK_KO = ["일", "월", "화", "수", "목", "금", "토"]
const todayLabel = () => {
  const d = new Date()
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK_KO[d.getDay()]}요일`
}

// 할 일 종류별 아이콘/색 (클라이언트 표시 전용)
const TODO_KIND_META = {
  ar:       { icon: <Icon.In size={15}/>,      toneColor: 'var(--brand)',    soft: 'var(--brand-soft)' },
  doc:      { icon: <Icon.Sign size={15}/>,    toneColor: 'var(--warn-ink)', soft: 'var(--warn-soft)' },
  evidence: { icon: <Icon.Receipt size={15}/>, toneColor: 'var(--warn-ink)', soft: 'var(--warn-soft)' },
  ap:       { icon: <Icon.Bank size={15}/>,    toneColor: 'var(--neg-ink)',  soft: 'var(--neg-soft)' },
}

const DEFAULT_FAVS = ['income', 'expense', 'billing_issued', 'contract', 'tax_vat']

// Contract.jsx 등에서 재사용
export const MiniStat = ({ label, value, sub, tone = "ink" }) => (
  <div className="card" style={{ padding: "16px 18px", minWidth: 0 }}>
    <div className="row gap-8" style={{ marginBottom: 6 }}>
      <span className="text-sm text-muted fw-600" style={{ whiteSpace: "nowrap" }}>{label}</span>
      <span className={`badge ${tone === "ink" ? "outline" : tone}`} style={{ marginLeft: "auto" }}>{sub}</span>
    </div>
    <div className="num fw-700" style={{ fontSize: 22, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>{value}</div>
  </div>
)

export const HomeScreen = ({ go, user, openIncome, openExpense }) => {
  const toast = useToast()
  const [doneIds, setDoneIds] = useState(new Set())
  const [paymentModal, setPaymentModal] = useState(null) // { todo, date, kind }
  const [todos, setTodos] = useState([])
  const [favorites, setFavorites] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('homeFavorites')); return Array.isArray(s) ? s : DEFAULT_FAVS } catch { return DEFAULT_FAVS }
  })

  useEffect(() => { api.getHomeTodos().then(setTodos).catch(() => {}) }, [])
  useEffect(() => { localStorage.setItem('homeFavorites', JSON.stringify(favorites)) }, [favorites])

  const pendingTodos = todos.filter(t => !doneIds.has(t.id)).map(t => ({ ...t, ...TODO_KIND_META[t.kind] }))

  const handleTodoAction = async (t) => {
    if (t.kind === "ar")       setPaymentModal({ todo: t, date: localDateStr(), kind: 'ar' })
    else if (t.kind === "ap")  setPaymentModal({ todo: t, date: localDateStr(), kind: 'ap' })
    else if (t.kind === "doc") { await api.completeTodo(t.id); setDoneIds(s => new Set([...s, t.id])); toast.push("결의서를 승인했어요") }
    else if (t.kind === "evidence") go("evidence")
  }
  const handlePaymentConfirm = async () => {
    const { todo, kind } = paymentModal
    await api.completeTodo(todo.id)
    setDoneIds(s => new Set([...s, todo.id]))
    toast.push(kind === 'ar' ? "입금이 처리되었어요" : "이체가 실행되었어요")
    setPaymentModal(null)
  }

  const addFav = (id) => setFavorites(f => f.includes(id) ? f : [...f, id])
  const removeFav = (id) => setFavorites(f => f.filter(x => x !== id))

  const paymentModalEl = paymentModal && createPortal(
    <div onClick={() => setPaymentModal(null)}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(11,18,32,0.35)", display: "grid", placeItems: "center", backdropFilter: "blur(2px)" }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 16, width: "min(420px, calc(100vw - 32px))", padding: 28, boxShadow: "0 30px 60px -20px rgba(15,23,42,0.3)", animation: "fadeUp .18s ease" }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, display: "grid", placeItems: "center",
            background: paymentModal.kind === 'ar' ? "var(--brand-soft)" : "var(--neg-soft)",
            color: paymentModal.kind === 'ar' ? "var(--brand)" : "var(--neg-ink)" }}>
            {paymentModal.kind === 'ar' ? <Icon.In size={22}/> : <Icon.Bank size={22}/>}
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.35 }}>{paymentModal.todo.title}</div>
        </div>
        <div style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.65, marginBottom: 20 }}>
          {paymentModal.kind === 'ar' ? `${paymentModal.todo.sub}을(를) 입금 완료로 처리합니다.` : `${paymentModal.todo.sub}을(를) 등록된 계좌에서 이체합니다.`}
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>
            {paymentModal.kind === 'ar' ? '입금일' : '지급일'} <span style={{ color: "var(--neg-ink)" }}>*</span>
          </label>
          <input type="date" className="input" value={paymentModal.date} max={localDateStr()}
            onChange={e => setPaymentModal(m => ({ ...m, date: e.target.value }))} style={{ width: "100%" }}/>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={() => setPaymentModal(null)}>취소</button>
          <button className="btn primary" onClick={handlePaymentConfirm}>
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
      {/* Hero */}
      <div className="row page-header-row" style={{ alignItems: "flex-end", marginBottom: 22 }}>
        <div>
          <div className="page-title">{user?.displayName || "관리자"}님, 안녕하세요</div>
          <div className="page-sub">{todayLabel()}</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={() => go("settings")}><Icon.Cog size={15}/> <span className="btn-label-hide">환경설정</span></button>
          <Popover align="right" width={220}
            trigger={<button className="btn primary"><Icon.Plus/> 거래 등록 <Icon.Down size={12} style={{ marginLeft: 2 }}/></button>}>
            <div style={{ padding: 6 }}>
              <PopItem icon={<Icon.In size={16}/>}    label="입금 등록"   sub="발주처 입금"      onClick={openIncome}/>
              <PopItem icon={<Icon.Out size={16}/>}   label="지출 등록"   sub="외주·자재·운영비" onClick={openExpense}/>
              <div style={{ height: 1, background: "var(--line)", margin: "6px 0" }}/>
              <PopItem icon={<Icon.Excel size={16}/>} label="엑셀 업로드" sub="여러 건 한 번에"   onClick={() => go("excel_modal")}/>
            </div>
          </Popover>
        </div>
      </div>

      {/* 지금 해야 할 일 */}
      <div style={{ marginBottom: 24 }}>
        <div className="text-xs fw-700" style={{ color: "var(--muted-2)", letterSpacing: "0.02em", marginBottom: 10, padding: "0 2px" }}>
          지금 해야 할 일 <span className="num" style={{ color: "var(--brand-ink)", marginLeft: 4 }}>{pendingTodos.length}</span>
        </div>
        {pendingTodos.length === 0 ? (
          <div className="card" style={{ padding: "18px 20px", display: "flex", alignItems: "center", gap: 10, color: "var(--muted)" }}>
            <Icon.Check size={18} className="text-pos"/>
            <span className="text-sm fw-600" style={{ color: "var(--ink)" }}>지금 처리할 일이 없어요.</span>
          </div>
        ) : (
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            {pendingTodos.slice(0, 4).map(t => (
              <div key={t.id} className="card" style={{ padding: "14px 16px", flex: "1 1 240px", minWidth: 220, display: "flex", gap: 12, alignItems: "center" }}>
                <div style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, background: t.soft, color: t.toneColor, display: "grid", placeItems: "center" }}>{t.icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-xs fw-700" style={{ color: t.toneColor }}>{t.tag}</div>
                  <div className="fw-700 text-sm" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</div>
                </div>
                <button className="btn primary sm" onClick={() => handleTodoAction(t)} style={{ flexShrink: 0 }}>{t.action}</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 자주 찾는 메뉴 */}
      <div style={{ marginBottom: 26 }}>
        <div className="text-xs fw-700" style={{ color: "var(--muted-2)", letterSpacing: "0.02em", marginBottom: 10, padding: "0 2px" }}>자주 찾는 메뉴</div>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          {favorites.map(id => {
            const l = LEAF_BY_ID[id]
            if (!l) return null
            const Ic = l.icon
            return (
              <div key={id} className="fav-chip" onClick={() => go(id)}>
                <Ic className="nav-ico" style={{ width: 15, height: 15, opacity: 0.7 }}/>
                <span>{l.label}</span>
                <span className="fav-x" onClick={(e) => { e.stopPropagation(); removeFav(id) }} title="제거"><Icon.Close size={13}/></span>
              </div>
            )
          })}
          <Popover align="left" width={260}
            trigger={<button className="fav-chip" style={{ borderStyle: "dashed", color: "var(--muted)" }}><Icon.Plus size={14}/> 추가</button>}>
            <div style={{ maxHeight: 320, overflowY: "auto", padding: 6 }}>
              {ALL_LEAVES.map(l => {
                const active = favorites.includes(l.id)
                const Ic = l.icon
                return (
                  <button key={l.id} data-pop-item onClick={() => active ? removeFav(l.id) : addFav(l.id)}
                    className="row gap-8" style={{ width: "100%", padding: "8px 10px", border: 0, background: "transparent", cursor: "pointer", fontFamily: "inherit", textAlign: "left", borderRadius: 8 }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--surface-2)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <Ic className="nav-ico" style={{ width: 15, height: 15, opacity: 0.7, flexShrink: 0 }}/>
                    <span className="text-sm fw-600" style={{ flex: 1 }}>{l.label}</span>
                    <span className="text-xs text-muted2">{l.domain || ""}</span>
                    {active && <Icon.Check size={14} style={{ color: "var(--brand)" }}/>}
                  </button>
                )
              })}
            </div>
          </Popover>
        </div>
      </div>

      {/* 포털 그리드 */}
      <div className="portal-grid">
        {NAV_TREE.filter(n => n.type === "domain").map(domain => {
          const Dic = domain.icon
          return (
            <div key={domain.id} className="card portal-panel">
              <div className="portal-phead">
                <div className="p-ico"><Dic size={16}/></div>
                <div className="fw-700" style={{ fontSize: 15 }}>{domain.label}</div>
              </div>
              {domain.sections.map(sec => (
                <div key={sec.label} className="portal-sec">
                  <div className="portal-sec-label">{sec.label}</div>
                  <div className="portal-links">
                    {sec.items.map(it => {
                      const Ic = it.icon
                      return (
                        <button key={it.id} className="portal-link" onClick={() => go(it.id)}>
                          <Ic className="nav-ico"/> {it.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )
        })}

        {/* 환경설정 (별도) */}
        <button className="card portal-panel" onClick={() => go(SETTINGS_LEAF.id)}
          style={{ textAlign: "left", cursor: "pointer", fontFamily: "inherit", display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--line)" }}>
          <div className="portal-phead" style={{ borderBottom: 0, marginBottom: 0, paddingBottom: 0 }}>
            <div className="p-ico" style={{ background: "var(--surface-3)", color: "var(--muted)" }}><Icon.Cog size={16}/></div>
            <div className="fw-700" style={{ fontSize: 15 }}>환경설정</div>
          </div>
          <div className="text-sm text-muted" style={{ paddingLeft: 2 }}>회사 정보 · 사용자 · 문서 양식</div>
        </button>
      </div>
    </div>
    {paymentModalEl}
    </>
  )
}
