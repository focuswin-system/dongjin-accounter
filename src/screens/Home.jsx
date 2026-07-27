import { useState, useEffect } from 'react'
import { Icon, Popover, PopItem } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { api } from '../lib/api'
import { PORTAL, ALL_LEAVES, LEAF_BY_ID } from '../lib/nav'

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

// 도메인 → 홈 타일 목록. expandGroups 카테고리(회계처리)는 각 섹션(판매·매출·매입…)을 개별 타일로 펼치고,
// route형 카테고리(인사관리·보고서 등)는 바로가기 타일, 그 외(세무·기준정보)는 하위메뉴를 묶은 링크 타일.
const sectionTiles = (domain) => domain.categories.flatMap(cat => {
  if (cat.route) return [{ key: cat.id, label: cat.label, desc: cat.desc, route: cat.route, Ic: cat.icon, items: [] }]
  if (cat.expandGroups) return cat.groups.map((g, i) => ({ key: `${cat.id}-${i}`, label: g.label, items: g.items }))
  return [{ key: cat.id, label: cat.label, items: (cat.groups || []).flatMap(g => g.items) }]
})

export const HomeScreen = ({ go, user, openIncome, openExpense }) => {
  const [todos, setTodos] = useState([])
  const [favorites, setFavorites] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem('homeFavorites')); return Array.isArray(s) ? s : DEFAULT_FAVS } catch { return DEFAULT_FAVS }
  })

  useEffect(() => { api.getHomeTodos().then(setTodos).catch(() => {}) }, [])
  useEffect(() => { localStorage.setItem('homeFavorites', JSON.stringify(favorites)) }, [favorites])

  // 할 일은 청구서 상태에서 파생된다 — 정산하면 다음 조회에서 자연히 빠지므로 별도 완료표시가 없다
  const pendingTodos = todos.map(t => ({ ...t, ...TODO_KIND_META[t.kind] }))

  // 예전에는 여기서 모달을 띄우고 '입금이 처리되었어요'를 보여줬지만, 실제로는 아무 거래도
  // 만들지 않는 빈 호출이었다(api.completeTodo 는 {ok:true}만 돌려주는 스텁). 사용자는 돈이
  // 기록된 줄 알았지만 장부에는 아무것도 남지 않았다.
  // 정산은 청구서 상세의 정상 경로(계좌 선택·매칭·잔액 반영)에서만 이뤄져야 하므로 그리로 보낸다.
  const handleTodoAction = (t) => {
    if (t.kind === "ar")      go("ar", { invoiceId: t.invoiceId })
    else if (t.kind === "ap") go("ap", { invoiceId: t.invoiceId })
  }

  const addFav = (id) => setFavorites(f => f.includes(id) ? f : [...f, id])
  const removeFav = (id) => setFavorites(f => f.filter(x => x !== id))


  return (
    <>
    <div className="fade-up">
      {/* Hero */}
      <PageHeader
        title={`${user?.displayName || "관리자"}님, 안녕하세요`}
        sub={todayLabel()}
        actions={<>
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
        </>}
      />

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
          <div className="todo-grid">
            {pendingTodos.slice(0, 4).map(t => (
              <button key={t.id} type="button" className="todo-card" onClick={() => handleTodoAction(t)}>
                <span className="todo-ico" style={{ background: t.soft, color: t.toneColor }}>{t.icon}</span>
                <span className="todo-main">
                  <span className="todo-tag" style={{ color: t.toneColor }}>{t.tag}</span>
                  <span className="todo-title">{t.title}</span>
                  {t.sub && <span className="todo-sub">{t.sub}</span>}
                </span>
                <span className="todo-go">{t.action} <Icon.Right size={12}/></span>
              </button>
            ))}
            {pendingTodos.length > 4 && (
              <button type="button" className="todo-card todo-more" onClick={() => go("ar")}>
                <span className="todo-main">
                  <span className="todo-title">+{pendingTodos.length - 4}건 더</span>
                  <span className="todo-sub">미수금·미지급금에서 전체 보기</span>
                </span>
                <Icon.Right size={14}/>
              </button>
            )}
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

      {/* 도메인 라인 → 섹션 타일(사이드바 구조 그대로 홈에 펼침) */}
      {PORTAL.map(domain => {
        const Dic = domain.icon
        return (
          <div key={domain.id} className="domain-line">
            <div className="domain-line-head">
              <div className="d-ico"><Dic size={15}/></div>
              <div className="d-label">{domain.label}</div>
            </div>
            <div className="sec-tile-grid">
              {sectionTiles(domain).map(tile => (
                tile.items.length ? (
                  <div key={tile.key} className="sec-tile">
                    <div className="sec-tile-title">{tile.label}</div>
                    <div className="sec-tile-links">
                      {tile.items.map(id => {
                        const l = LEAF_BY_ID[id]
                        if (!l) return null
                        const Ic = l.icon
                        return (
                          <button key={id} type="button" className="sec-link" onClick={() => go(id)}>
                            <Ic size={13} style={{ opacity: 0.7, flexShrink: 0 }}/>
                            <span>{l.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  <button key={tile.key} className="cat-tile" onClick={() => go(tile.route)}>
                    <div className="c-ico"><tile.Ic size={20}/></div>
                    <div className="c-label">{tile.label}</div>
                    {tile.desc && <div className="c-desc">{tile.desc}</div>}
                    <div className="c-go">바로가기 <Icon.Right size={11}/></div>
                  </button>
                )
              ))}
            </div>
          </div>
        )
      })}

      {/* 환경설정 (라인과 별도) */}
      <div className="domain-line" style={{ marginBottom: 0 }}>
        <div className="domain-line-head">
          <div className="d-ico" style={{ background: "var(--surface-3)", color: "var(--muted)" }}><Icon.Cog size={15}/></div>
          <div className="d-label">환경설정</div>
        </div>
        <div className="tile-row">
          <button className="cat-tile" onClick={() => go("settings")}>
            <div className="c-ico" style={{ background: "var(--surface-3)", color: "var(--muted)" }}><Icon.Cog size={20}/></div>
            <div className="c-label">환경설정</div>
            <div className="c-desc">회사정보·사용자·문서양식</div>
            <div className="c-go">바로가기 <Icon.Right size={11}/></div>
          </button>
        </div>
      </div>
    </div>
    </>
  )
}
