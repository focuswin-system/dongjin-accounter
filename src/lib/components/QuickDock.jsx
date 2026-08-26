import { useState, useEffect, useMemo } from 'react'
import { Icon, Drawer } from '../ui'
import { DrawerHead } from './Drawer'
import { ALL_LEAVES, LEAF_BY_ID } from '../nav'

/**
 * 바로가기 독 — 자주 가는 화면을 떠 있는 버튼에 담아 둔다.
 *
 * 예전엔 이 자리에 '도움이 필요하세요?' 말풍선이 유휴 시간마다 떠올랐다. 매일 쓰는
 * 사람에게 자주 묻는 질문은 **처음 한 주만** 필요한데, 화면에서 가장 눈에 띄는 자리를
 * 계속 차지하고 있었다. FAQ 는 상단 도움말(?)로 옮기고 이 자리를 일하는 데 쓴다.
 *
 * ── 담는 것 ──
 * 화면(route) + 아이콘 + 색. 셋 다 **앱이 가진 것 중에서 고른다.**
 *   · 아이콘을 파일로 올리게 하면 SVG 안에 스크립트를 심을 수 있어 정제가 필요하고,
 *     제각각인 그림이 섞여 화면이 지저분해진다. 고르게 하면 둘 다 없다.
 *   · 색은 의미 토큰(brand·pos·warn·neg)에서 고른다 — 다크모드나 테마가 바뀌어도 따라온다.
 *
 * 저장은 localStorage 다(홈 즐겨찾기와 같은 방식). 이 기기에서만 쓰는 개인 설정이라
 * 서버에 둘 이유가 없고, 로그인 없이도 즉시 뜬다.
 */

const KEY = 'quickLinks'

/* 바로가기로 쓸 만한 아이콘만 추린다. 48개를 다 내놓으면 Close·Menu·Down 같은
   '기능 아이콘'까지 섞여, 고르는 사람이 무엇을 뜻하는지 알 수 없다. */
export const DOCK_ICONS = [
  'Home', 'Bank', 'Card', 'Wallet', 'Recv', 'Pay', 'In', 'Out',
  'Receipt', 'Doc', 'File', 'Sign', 'Book', 'Folder', 'Chart', 'Trend',
  'Building', 'Briefcase', 'Clock', 'Calendar', 'Bell', 'Check', 'Sparkle', 'Cog',
]

/* 색은 이름으로 고른다 — 코드값을 직접 넣게 하면 테마와 어긋나고, 읽을 수 없는 조합
   (흰 글씨에 노란 배경)이 만들어진다. */
export const DOCK_COLORS = [
  { key: 'ink',   label: '먹',   bg: 'var(--ink)' },
  { key: 'brand', label: '파랑', bg: 'var(--brand)' },
  { key: 'pos',   label: '초록', bg: 'var(--pos)' },
  { key: 'warn',  label: '주황', bg: 'var(--warn-ink)' },
  { key: 'neg',   label: '빨강', bg: 'var(--neg)' },
  { key: 'gray',  label: '회색', bg: 'var(--muted)' },
]
const bgOf = (c) => (DOCK_COLORS.find(x => x.key === c) || DOCK_COLORS[0]).bg
const IconOf = (name) => Icon[name] || Icon.Right

const load = () => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY))
    return Array.isArray(s) ? s : []
  } catch { return [] }
}

export const QuickDock = ({ go, route, canDo, onOpenFaq }) => {
  const [open, setOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [links, setLinks] = useState(load)
  const [q, setQ] = useState('')

  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(links)) }, [links])

  /* 권한 없는 화면은 독에서도 감춘다 — 눌렀을 때 403 만 보게 하지 않는다.
     담아 둔 기록은 지우지 않는다: 권한이 다시 생기면 그대로 돌아온다. */
  const shown = useMemo(
    () => links.filter(l => LEAF_BY_ID[l.id] && (!canDo || canDo(l.id))),
    [links, canDo])

  const already = new Set(links.map(l => l.id))
  const candidates = useMemo(() => {
    const s = q.trim().toLowerCase()
    return ALL_LEAVES
      .filter(l => !already.has(l.id) && (!canDo || canDo(l.id)))
      .filter(l => !s || l.label.toLowerCase().includes(s)
        || [l.domain, l.section].filter(Boolean).join(' ').toLowerCase().includes(s))
      .slice(0, 40)
  }, [q, links, canDo])

  const add = (id) => {
    if (already.has(id)) return
    const leaf = LEAF_BY_ID[id]
    // 메뉴가 이미 들고 있는 아이콘을 첫 값으로 — 아무것도 안 고른 상태로 두면 다 똑같이 보인다
    const guess = DOCK_ICONS.find(n => Icon[n] === leaf?.icon) || 'Right'
    setLinks(prev => [...prev, { id, icon: guess, color: 'ink' }])
  }
  const patch = (id, part) => setLinks(prev => prev.map(l => (l.id === id ? { ...l, ...part } : l)))
  const remove = (id) => setLinks(prev => prev.filter(l => l.id !== id))
  const move = (i, dir) => setLinks(prev => {
    const to = i + dir
    if (to < 0 || to >= prev.length) return prev
    const next = [...prev]
    ;[next[i], next[to]] = [next[to], next[i]]
    return next
  })

  const canAddCurrent = !!LEAF_BY_ID[route] && !already.has(route)

  return (
    <>
      <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 60,
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>

        {/* 펼친 바로가기들 — 위로 쌓인다(아래는 여는 버튼이 차지한다) */}
        {open && (
          <div className="col gap-8" style={{ alignItems: 'flex-end' }}>
            {shown.length === 0 && (
              <div className="card card-pad text-xs text-muted" style={{ maxWidth: 200 }}>
                아직 담은 화면이 없어요. 아래 <b>편집</b>에서 자주 가는 화면을 담아보세요.
              </div>
            )}
            {shown.map(l => {
              const leaf = LEAF_BY_ID[l.id]
              const Ic = IconOf(l.icon)
              return (
                <button key={l.id} className="qd-item" onClick={() => { go(l.id); setOpen(false) }}>
                  <span className="qd-label">{leaf.label}</span>
                  <span className="qd-dot" style={{ background: bgOf(l.color) }}><Ic size={17}/></span>
                </button>
              )
            })}
            <button className="qd-item" onClick={() => { setEditOpen(true); setOpen(false) }}>
              <span className="qd-label">편집</span>
              <span className="qd-dot" style={{ background: 'var(--surface-3)', color: 'var(--muted)' }}>
                <Icon.Pencil size={15}/>
              </span>
            </button>
          </div>
        )}

        <button className="qd-fab" onClick={() => setOpen(o => !o)}
          title={open ? '닫기' : '바로가기'} aria-expanded={open}>
          {open ? <Icon.Close size={20}/> : <Icon.Sparkle size={20}/>}
        </button>
      </div>

      {/* 편집 — 담기(장바구니)와 꾸미기(아이콘·색)를 한 자리에서 */}
      <Drawer open={editOpen} onClose={() => setEditOpen(false)} width="min(460px,100vw)" label="바로가기 편집"
        confirmClose={false}>
        <DrawerHead title="바로가기 편집" sub="자주 가는 화면을 담고 아이콘·색을 골라요" onClose={() => setEditOpen(false)}/>
        <div className="drawer-body col gap-16">
          <div>
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="label" style={{ margin: 0 }}>담은 화면 {links.length}개</span>
              {canAddCurrent && (
                <button className="btn sm ml-auto" onClick={() => add(route)}>
                  <Icon.Plus size={13}/> 지금 화면 담기
                </button>
              )}
            </div>
            {links.length === 0 ? (
              <div className="text-sm text-muted" style={{ padding: '16px 0' }}>
                아직 없어요. 아래에서 골라 담으세요.
              </div>
            ) : (
              <div className="col gap-10">
                {links.map((l, i) => {
                  const leaf = LEAF_BY_ID[l.id]
                  const Ic = IconOf(l.icon)
                  return (
                    <div key={l.id} className="card card-pad col gap-8">
                      <div className="row gap-8">
                        <span className="qd-dot" style={{ background: bgOf(l.color), width: 30, height: 30 }}><Ic size={15}/></span>
                        <span className="fw-600 text-sm">{leaf?.label || l.id}</span>
                        <span className="text-xs text-muted2">{[leaf?.domain, leaf?.section].filter(Boolean).join(' › ')}</span>
                        <div className="row gap-6 ml-auto">
                          <button className="ord-btn" disabled={i === 0} title="위로" onClick={() => move(i, -1)}>▲</button>
                          <button className="ord-btn" disabled={i === links.length - 1} title="아래로" onClick={() => move(i, 1)}>▼</button>
                          <button className="btn sm" style={{ color: 'var(--neg-ink)' }} onClick={() => remove(l.id)}>빼기</button>
                        </div>
                      </div>
                      <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                        {DOCK_ICONS.map(n => {
                          const I = Icon[n]
                          return (
                            <button key={n} type="button" className={`qd-pick ${l.icon === n ? 'on' : ''}`}
                              title={n} onClick={() => patch(l.id, { icon: n })}><I size={14}/></button>
                          )
                        })}
                      </div>
                      <div className="row gap-6">
                        {DOCK_COLORS.map(c => (
                          <button key={c.key} type="button" title={c.label}
                            className={`qd-color ${l.color === c.key ? 'on' : ''}`}
                            style={{ background: c.bg }} onClick={() => patch(l.id, { color: c.key })}/>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div>
            <label className="label">화면 담기</label>
            <div className="search" style={{ margin: '0 0 10px', width: '100%', padding: '7px 10px' }}>
              <Icon.Search size={14}/>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="메뉴 이름으로 찾기"/>
            </div>
            <div className="col gap-6" style={{ maxHeight: 260, overflowY: 'auto' }}>
              {candidates.length === 0 && (
                <div className="text-sm text-muted" style={{ padding: '12px 0' }}>더 담을 화면이 없어요.</div>
              )}
              {candidates.map(l => (
                <button key={l.id} className="row gap-8 qd-add" onClick={() => add(l.id)}>
                  <Icon.Plus size={13} className="text-muted2"/>
                  <span className="text-sm fw-600">{l.label}</span>
                  <span className="text-xs text-muted2 ml-auto">{[l.domain, l.section].filter(Boolean).join(' › ')}</span>
                </button>
              ))}
            </div>
          </div>

          {/* FAQ 입구 — 이 자리에 있던 말풍선을 걷어내면서 갈 곳이 없어지면 안 된다 */}
          {onOpenFaq && (
            <button className="btn" onClick={() => { setEditOpen(false); onOpenFaq() }}>
              <Icon.Help size={14}/> 자주 묻는 질문 보기
            </button>
          )}
        </div>
      </Drawer>
    </>
  )
}
