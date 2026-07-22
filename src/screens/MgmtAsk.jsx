import { useState, useEffect, useRef } from 'react'
import { Icon, fmtNum, useToast, useConfirm } from '../lib/ui'
import { api } from '../lib/api'

/* 경영 도우미 — 대화(세션)형 조회.
 * 좌측 대화 목록 + 우측 차트 타임라인. 하단 컴포저(메뉴 드릴다운)로 질문을 만들면 차트 버블이 쌓인다.
 * 각 차트는 저장된 조건(QuerySpec)으로 언제든 새로고침(기준시각 표시). 스냅샷은 서버 result에 박제.
 * 추후 LLM: 컴포저를 텍스트 입력으로 교체하면 됨 — 세션·저장·차트·새로고침 그대로.
 * 설계: docs/02-design/features/mgmt-chat-sessions.design.md */

const won = (n) => fmtNum(Math.round(Number(n) || 0)) + '원'

// 상대시각 — "방금 / N분 전 / N시간 전 / M/D HH:mm" (KST 로컬)
const rel = (ts) => {
  if (!ts) return ''
  const d = new Date(ts), diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return '방금'
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const TOPICS = [{ v: 'sales', label: '매출' }, { v: 'purchase', label: '매입' }]
const GROUPS = [
  { v: 'month', label: '월별 추이' }, { v: 'vendor', label: '거래처별' }, { v: 'category', label: '비목별' },
  { v: 'contract', label: '계약별' }, { v: 'item', label: '품목별' },
]
const PERIODS = [
  { v: 'this_month', label: '이번 달' }, { v: 'this_quarter', label: '이번 분기' },
  { v: 'last_3m', label: '최근 3개월' }, { v: 'this_year', label: '올해' }, { v: 'last_12m', label: '최근 12개월' },
]

const RefreshIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
  </svg>
)

// ── 경량 SVG 차트 ──
const BAR_COLOR = 'var(--brand)'
const BarChart = ({ rows }) => {
  const top = rows.slice(0, 8), max = Math.max(1, ...top.map(r => r.value))
  return (
    <div className="col" style={{ gap: 8, padding: '2px' }}>
      {top.map((r, i) => (
        <div key={i} className="row" style={{ gap: 10, alignItems: 'center' }}>
          <div className="text-sm" style={{ width: 130, minWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>{r.label}</div>
          <div style={{ flex: 1, background: 'var(--surface-2)', borderRadius: 6, height: 20 }}>
            <div style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, height: '100%', background: BAR_COLOR, borderRadius: 6, transition: 'width .3s' }}/>
          </div>
          <div className="num text-sm fw-600" style={{ width: 116, textAlign: 'right' }}>{won(r.value)}</div>
        </div>
      ))}
    </div>
  )
}
const LineChart = ({ rows }) => {
  const w = 620, h = 190, pad = 32
  if (!rows.length) return null
  const max = Math.max(1, ...rows.map(r => r.value))
  const stepX = rows.length > 1 ? (w - pad * 2) / (rows.length - 1) : 0
  const x = (i) => pad + i * stepX, y = (v) => h - pad - (v / max) * (h - pad * 2)
  const pts = rows.map((r, i) => `${x(i)},${y(r.value)}`).join(' ')
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ maxWidth: w, minWidth: 300 }}>
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="var(--line)"/>
        <polyline points={pts} fill="none" stroke={BAR_COLOR} strokeWidth="2.5"/>
        {rows.map((r, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(r.value)} r="3.5" fill={BAR_COLOR}/>
            <text x={x(i)} y={h - pad + 15} textAnchor="middle" fontSize="11" fill="var(--muted-2)">{String(r.label).slice(5)}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// ── 응답 카드(차트 버블) ──
const ChartCard = ({ item, onRefresh, onDelete }) => {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const r = item.result || {}
  const rows = r.rows || []
  const dataRows = rows.filter(x => x.key !== 'total')
  const doRefresh = async () => { setBusy(true); await onRefresh(item.id); setBusy(false) }
  return (
    <div className="col" style={{ gap: 8, alignItems: 'stretch', maxWidth: 720 }}>
      {/* 질문 버블(우측) */}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <div style={{ background: 'var(--brand)', color: '#fff', padding: '7px 13px', borderRadius: '14px 14px 3px 14px', fontSize: 13.5, fontWeight: 600 }}>{item.title}</div>
      </div>
      {/* 응답 카드 */}
      <div className="card card-pad" style={{ borderRadius: '3px 14px 14px 14px' }}>
        <div className="row" style={{ alignItems: 'flex-start', marginBottom: 10, gap: 8 }}>
          <div className="row gap-8" style={{ alignItems: 'flex-start', flex: 1 }}>
            <Icon.Sparkle size={16}/><span className="fw-600 text-sm" style={{ lineHeight: 1.5 }}>{r.summary}</span>
          </div>
          <div className="row gap-6" style={{ flexShrink: 0, alignItems: 'center' }}>
            <span className="text-xs text-muted2" title={item.refreshed_at ? new Date(item.refreshed_at).toLocaleString('ko-KR') : ''}>{rel(item.refreshed_at)} 기준</span>
            <button className="icon-btn" title="새로고침" onClick={doRefresh} disabled={busy} style={{ opacity: busy ? 0.5 : 1 }}><RefreshIcon/></button>
            <button className="icon-btn" title="삭제" onClick={() => onDelete(item)}><Icon.Trash size={14}/></button>
          </div>
        </div>
        {dataRows.length === 0 ? (
          <div className="text-sm text-muted2" style={{ padding: '12px 0' }}>표시할 데이터가 없어요.</div>
        ) : (
          <>
            <div style={{ margin: '4px 0 6px' }}>{r.chart === 'line' ? <LineChart rows={rows}/> : <BarChart rows={dataRows}/>}</div>
            <button className="btn ghost sm" onClick={() => setOpen(o => !o)} style={{ marginTop: 4 }}>
              {open ? '표 접기' : '표로 보기'} ({dataRows.length}건)
            </button>
            {open && (
              <table className="table" style={{ marginTop: 8 }}>
                <thead><tr><th>{r.groupLabel || '항목'}</th><th className="num-right">{r.topicLabel || '금액'}</th><th className="num-right" style={{ width: 80 }}>건수</th></tr></thead>
                <tbody>
                  {dataRows.map((row, i) => (
                    <tr key={i}><td className="fw-600">{row.label}</td><td className="num-cell num-right">{won(row.value)}</td><td className="num-cell num-right text-muted">{row.count}건</td></tr>
                  ))}
                  <tr style={{ background: 'var(--surface-2)' }}><td className="fw-700">합계</td><td className="num-cell num-right fw-700">{won(r.total)}</td><td/></tr>
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const Chip = ({ on, onClick, children }) => (
  <button type="button" className={`chip ${on ? 'active' : ''}`} onClick={onClick}>{children}</button>
)

// ── 하단 컴포저 ──
const Composer = ({ onAdd, busy }) => {
  const [spec, setSpec] = useState({ topic: '', group: '', period: '' })
  const ready = spec.topic && spec.group && spec.period
  const add = async () => { if (!ready) return; await onAdd(spec); setSpec({ topic: '', group: '', period: '' }) }
  return (
    <div className="card card-pad col" style={{ gap: 12, borderColor: 'var(--brand-soft)' }}>
      <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="text-xs fw-700 text-muted2" style={{ width: 54 }}>무엇을</span>
        {TOPICS.map(t => <Chip key={t.v} on={spec.topic === t.v} onClick={() => setSpec(s => ({ ...s, topic: t.v }))}>{t.label}</Chip>)}
        <button className="btn primary ml-auto" disabled={!ready || busy} onClick={add}>
          <Icon.Plus size={14}/> {busy ? '추가 중…' : '차트 추가'}
        </button>
      </div>
      <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="text-xs fw-700 text-muted2" style={{ width: 54 }}>기준</span>
        {GROUPS.map(g => <Chip key={g.v} on={spec.group === g.v} onClick={() => setSpec(s => ({ ...s, group: g.v }))}>{g.label}</Chip>)}
      </div>
      <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="text-xs fw-700 text-muted2" style={{ width: 54 }}>기간</span>
        {PERIODS.map(p => <Chip key={p.v} on={spec.period === p.v} onClick={() => setSpec(s => ({ ...s, period: p.v }))}>{p.label}</Chip>)}
      </div>
    </div>
  )
}

export const MgmtAskScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [chats, setChats] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [items, setItems] = useState([])
  const [renaming, setRenaming] = useState(null)  // chatId 편집 중
  const [renameText, setRenameText] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const threadEnd = useRef(null)

  const loadChats = async () => {
    const list = await api.getChats()
    setChats(list)
    return list
  }
  useEffect(() => { (async () => { const list = await loadChats(); if (list.length) setActiveId(list[0].id) })() }, [])
  useEffect(() => { if (activeId) api.getChatItems(activeId).then(setItems); else setItems([]) }, [activeId])
  useEffect(() => { threadEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [items.length])

  const newChat = async () => {
    const c = await api.createChat()
    setChats(prev => [{ ...c, updated_at: new Date().toISOString() }, ...prev])
    setActiveId(c.id); setItems([])
  }
  const delChat = async (c) => {
    if (!await confirm({ tone: 'neg', icon: <Icon.Trash size={22}/>, title: '대화 삭제', body: `"${c.title}" 대화를 삭제할까요? 저장된 차트도 함께 지워져요.`, confirmLabel: '삭제' })) return
    await api.deleteChat(c.id)
    const rest = chats.filter(x => x.id !== c.id)
    setChats(rest)
    if (activeId === c.id) setActiveId(rest[0]?.id || null)
    toast.push('대화를 삭제했어요')
  }
  const saveRename = async (c) => {
    const t = renameText.trim()
    setRenaming(null)
    if (!t || t === c.title) return
    await api.renameChat(c.id, t)
    setChats(prev => prev.map(x => x.id === c.id ? { ...x, title: t } : x))
  }

  const addItem = async (spec) => {
    if (!activeId) return
    setAddBusy(true)
    try {
      const it = await api.addChatItem(activeId, spec)
      setItems(prev => [...prev, it])
      if (it.autoTitle) setChats(prev => prev.map(x => x.id === activeId ? { ...x, title: it.autoTitle, item_count: (x.item_count || 0) + 1 } : x))
      else setChats(prev => prev.map(x => x.id === activeId ? { ...x, item_count: (x.item_count || 0) + 1 } : x))
    } catch { toast.push('차트를 만들지 못했어요') }
    setAddBusy(false)
  }
  const refreshItem = async (id) => {
    try { const it = await api.refreshChatItem(id); setItems(prev => prev.map(x => x.id === id ? it : x)) }
    catch { toast.push('새로고침에 실패했어요') }
  }
  const delItem = async (item) => {
    if (!await confirm({ tone: 'neg', icon: <Icon.Trash size={22}/>, title: '차트 삭제', body: '이 차트를 대화에서 지울까요?', confirmLabel: '삭제' })) return
    await api.deleteChatItem(item.id)
    setItems(prev => prev.filter(x => x.id !== item.id))
    setChats(prev => prev.map(x => x.id === activeId ? { ...x, item_count: Math.max(0, (x.item_count || 1) - 1) } : x))
  }

  const active = chats.find(c => c.id === activeId)

  return (
    <div className="fade-up col" style={{ height: 'calc(100vh - 132px)', minHeight: 460 }}>
      <div style={{ marginBottom: 12 }}>
        <div className="page-title">경영 도우미</div>
        <div className="page-sub">자주 보는 매출·매입 차트를 대화로 저장해 두고, 아무 때나 새로고침하세요.</div>
      </div>
      <div className="row" style={{ flex: 1, gap: 16, alignItems: 'stretch', minHeight: 0 }}>
        {/* 좌측: 대화 목록 */}
        <div className="card col" style={{ width: 244, minWidth: 244, padding: 10, gap: 4, overflow: 'hidden' }}>
          <button className="btn primary" style={{ justifyContent: 'center', marginBottom: 6 }} onClick={newChat}><Icon.Plus size={14}/> 새 대화</button>
          <div className="col" style={{ gap: 3, overflowY: 'auto', flex: 1 }}>
            {chats.length === 0 && <div className="text-sm text-muted2" style={{ padding: 12, textAlign: 'center' }}>대화를 만들어<br/>차트를 저장해 보세요.</div>}
            {chats.map(c => (
              <div key={c.id} className={`chat-row row ${c.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(c.id)}
                style={{ padding: '8px 10px', borderRadius: 8, cursor: 'pointer', gap: 6, alignItems: 'center', background: c.id === activeId ? 'var(--brand-soft)' : 'transparent' }}>
                {renaming === c.id ? (
                  <input autoFocus className="input" value={renameText} onChange={e => setRenameText(e.target.value)}
                    onBlur={() => saveRename(c)} onKeyDown={e => { if (e.key === 'Enter') saveRename(c); if (e.key === 'Escape') setRenaming(null) }}
                    onClick={e => e.stopPropagation()} style={{ height: 28, fontSize: 13, padding: '2px 6px' }}/>
                ) : (
                  <>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="text-sm fw-600" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</div>
                      <div className="text-xs text-muted2">{c.item_count || 0}개 · {rel(c.updated_at)}</div>
                    </div>
                    <button className="icon-btn chat-act" title="이름 변경" onClick={e => { e.stopPropagation(); setRenaming(c.id); setRenameText(c.title) }}><Icon.Pencil size={13}/></button>
                    <button className="icon-btn chat-act" title="삭제" onClick={e => { e.stopPropagation(); delChat(c) }}><Icon.Trash size={13}/></button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 우측: 스레드 + 컴포저 */}
        <div className="col" style={{ flex: 1, minWidth: 0, gap: 12 }}>
          {!active ? (
            <div className="card card-pad col" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <Icon.Sparkle size={28}/>
              <div className="fw-700">대화를 시작하세요</div>
              <div className="text-sm text-muted2" style={{ textAlign: 'center' }}>왼쪽 <b>새 대화</b>를 누르고, 아래에서 매출·매입 차트를 골라 저장하면<br/>여기 타임라인에 쌓이고 언제든 새로고침할 수 있어요.</div>
              <button className="btn primary" onClick={newChat} style={{ marginTop: 4 }}><Icon.Plus size={14}/> 새 대화</button>
            </div>
          ) : (
            <>
              <div className="col" style={{ flex: 1, overflowY: 'auto', gap: 18, paddingRight: 4, minHeight: 0 }}>
                {items.length === 0 && (
                  <div className="col" style={{ alignItems: 'center', justifyContent: 'center', flex: 1, gap: 6, color: 'var(--muted-2)' }}>
                    <Icon.Chart size={26}/>
                    <div className="text-sm">아래에서 <b>무엇을 · 기준 · 기간</b>을 골라 첫 차트를 추가해 보세요.</div>
                  </div>
                )}
                {items.map(it => <ChartCard key={it.id} item={it} onRefresh={refreshItem} onDelete={delItem}/>)}
                <div ref={threadEnd}/>
              </div>
              <Composer onAdd={addItem} busy={addBusy}/>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
