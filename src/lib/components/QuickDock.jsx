import { useState, useEffect, useMemo, useRef } from 'react'
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
const POS_KEY = 'quickDockPos'     // { corner, dx, dy } — 화면 어디에 서 있나
const HIDE_KEY = 'quickDockHidden' // '1' 이면 안 그린다
const DIR_KEY = 'quickDockDir'     // 'column'(세로) | 'row'(가로)

/* 위치는 **모서리 + 그 모서리에서의 거리**로 저장한다.
   절대 좌표(left/top)로 두면 창 크기를 줄였을 때 화면 밖으로 나가 영영 못 잡는다. */
const CORNERS = [
  { key: 'br', label: '오른쪽 아래' },
  { key: 'bl', label: '왼쪽 아래' },
  { key: 'tr', label: '오른쪽 위' },
  { key: 'tl', label: '왼쪽 위' },
]
const loadPos = () => {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY))
    return p && CORNERS.some(c => c.key === p.corner) ? p : { corner: 'br', dx: 24, dy: 24 }
  } catch { return { corner: 'br', dx: 24, dy: 24 } }
}

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

/* 바로가기 목록은 **한 벌**이다.
   예전엔 홈의 '자주 찾는 메뉴'(homeFavorites)와 이 독(quickLinks)이 서로 다른 저장소를 써서,
   독에 담은 것이 홈에 없고 홈에 담은 것이 독에 없었다. 같은 것을 두 곳에서 관리한 셈이다.
   이제 홈이 이 목록을 그대로 그린다 — 저장은 여기 한 곳. */
export const QUICK_KEY = KEY
export const loadQuickLinks = () => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY))
    if (Array.isArray(s) && s.length) return s
    /* 옛 홈 즐겨찾기를 한 번 옮겨온다 — 담아 둔 것이 사라지면 '지워졌다'로 읽힌다.
       모양이 다르다(문자열 id 배열 → { id } 배열). */
    const old = JSON.parse(localStorage.getItem('homeFavorites'))
    if (Array.isArray(old) && old.length) return old.filter(x => typeof x === 'string').map(id => ({ id }))
    return Array.isArray(s) ? s : []
  } catch { return [] }
}
const load = loadQuickLinks

export const QuickDock = ({ go, route, canDo, onOpenFaq }) => {
  const [open, setOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [links, setLinks] = useState(load)
  const [q, setQ] = useState('')
  const [pos, setPos] = useState(loadPos)
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDE_KEY) === '1')
  const [styling, setStyling] = useState(null)   // 아이콘·색을 펼쳐 둔 항목(한 번에 하나만)
  const [dir, setDir] = useState(() => (localStorage.getItem(DIR_KEY) === 'row' ? 'row' : 'column'))

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(links))
    // 홈도 같은 목록을 그린다 — 저장만 하고 알리지 않으면 새로고침해야 반영된다
    window.dispatchEvent(new CustomEvent('quicklinks:changed', { detail: links }))
  }, [links])
  useEffect(() => { localStorage.setItem(POS_KEY, JSON.stringify(pos)) }, [pos])
  useEffect(() => { localStorage.setItem(HIDE_KEY, hidden ? '1' : '0') }, [hidden])
  useEffect(() => { localStorage.setItem(DIR_KEY, dir) }, [dir])
  // 밖(상단 도움말)에서 다시 켤 수 있어야 한다 — 숨긴 뒤 되돌릴 길이 없으면 안 된다
  useEffect(() => {
    const on = () => setHidden(false)
    window.addEventListener('quickdock:show', on)
    // 홈의 '바로가기 편집'이 여는 문 — 편집 폼을 두 벌 만들지 않는다
    const onEdit = () => { setHidden(false); localStorage.removeItem(HIDE_KEY); setEditOpen(true) }
    window.addEventListener('quickdock:edit', onEdit)
    return () => {
      window.removeEventListener('quickdock:show', on)
      window.removeEventListener('quickdock:edit', onEdit)
    }
  }, [])

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

  /* 끌어서 옮기기.
   *
   * 같은 버튼이 '누르면 펼치기'와 '끌면 이동'을 겸한다. 8px 을 문턱으로 둔다 —
   * 손이 조금 흔들려도 클릭으로 읽히고, 옮길 뜻이 있으면 그보다는 크게 움직인다.
   * 놓을 때 **가장 가까운 모서리**로 붙인다. 자유 좌표로 두면 창 크기가 바뀌었을 때
   * 화면 밖으로 나가 다시 잡을 수 없다. */
  const drag = useRef(null)
  const onPointerDown = (e) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return
    d.moved = true
    setOpen(false)                      // 옮기는 중엔 목록을 접는다(따라다니면 어지럽다)
    const w = window.innerWidth, h = window.innerHeight
    const right = e.clientX > w / 2, bottom = e.clientY > h / 2
    setPos({
      corner: (bottom ? 'b' : 't') + (right ? 'r' : 'l'),
      dx: Math.max(12, Math.min(w - 74, right ? w - e.clientX - 25 : e.clientX - 25)),
      dy: Math.max(12, Math.min(h - 74, bottom ? h - e.clientY - 25 : e.clientY - 25)),
    })
  }
  const onPointerUp = (e) => {
    const d = drag.current
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (!d?.moved) setOpen(o => !o)     // 안 움직였으면 평소대로 펼치기/접기
  }

  // 모서리에 따라 어느 변에서 띄울지 정한다
  /* 목록이 뻗는 방향은 **모서리와 함께** 정해진다.
     세로면 위/아래로, 가로면 왼/오른쪽으로 — 화면 밖으로 뻗으면 안 되니까
     아래 모서리에선 위로, 오른쪽 모서리에선 왼쪽으로 뒤집는다. */
  const vertical = dir === 'column'
  const anchor = {
    position: 'fixed', zIndex: 60, display: 'flex', gap: 10,
    flexDirection: vertical
      ? (pos.corner[0] === 'b' ? 'column' : 'column-reverse')
      : (pos.corner[1] === 'r' ? 'row' : 'row-reverse'),
    alignItems: vertical
      ? (pos.corner[1] === 'r' ? 'flex-end' : 'flex-start')
      : 'center',
    [pos.corner[0] === 'b' ? 'bottom' : 'top']: pos.dy,
    [pos.corner[1] === 'r' ? 'right' : 'left']: pos.dx,
  }

  if (hidden) return (
    <Drawer open={editOpen} onClose={() => setEditOpen(false)} width="min(460px,100vw)" label="바로가기 편집" confirmClose={false}>
      <DrawerHead title="바로가기" sub="지금은 숨겨져 있어요" onClose={() => setEditOpen(false)}/>
      <div className="drawer-body">
        <button className="btn primary" onClick={() => setHidden(false)}>다시 보이기</button>
      </div>
    </Drawer>
  )

  return (
    <>
      <div style={anchor}>

        {/* 펼친 바로가기들 — 위로 쌓인다(아래는 여는 버튼이 차지한다) */}
        {open && (
          <div style={{ display: 'flex', gap: 8,
            flexDirection: vertical ? 'column' : (pos.corner[1] === 'r' ? 'row-reverse' : 'row'),
            alignItems: vertical ? (pos.corner[1] === 'r' ? 'flex-end' : 'flex-start') : 'center' }}>
            {shown.length === 0 && (
              <span className="qd-label text-muted" style={{ fontWeight: 500 }}>
                편집에서 자주 가는 화면을 담아보세요
              </span>
            )}
            {shown.map(l => {
              const leaf = LEAF_BY_ID[l.id]
              const Ic = IconOf(l.icon)
              return (
                <button key={l.id} className={`qd-item ${vertical ? '' : 'qd-item-v'}`}
                  onClick={() => { go(l.id); setOpen(false) }}>
                  <span className="qd-label">{leaf.label}</span>
                  <span className="qd-dot" style={{ background: bgOf(l.color) }}><Ic size={17}/></span>
                </button>
              )
            })}
            <button className={`qd-item ${vertical ? '' : 'qd-item-v'}`} onClick={() => { setEditOpen(true); setOpen(false) }}>
              <span className="qd-label">편집</span>
              <span className="qd-dot" style={{ background: 'var(--surface-3)', color: 'var(--muted)' }}>
                <Icon.Pencil size={15}/>
              </span>
            </button>
          </div>
        )}

        <button className="qd-fab"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          title={open ? '닫기' : '바로가기 (끌어서 옮길 수 있어요)'} aria-expanded={open}>
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
                  const open = styling === l.id
                  return (
                    /* 한 줄이 기본이다. 예전엔 항목마다 아이콘 24개 + 색 6개를 **늘 펼쳐** 두어
                       카드 하나가 세로로 화면 절반을 먹었다 — 세 개만 담아도 스크롤 지옥이었고,
                       회색 네모가 잔뜩 깔려 무엇이 골라진 건지도 안 보였다.
                       지금 모습(동그라미)을 보여주고, 바꾸고 싶을 때만 펼친다. */
                    <div key={l.id} className="card" style={{ overflow: 'hidden' }}>
                      <div className="row gap-8" style={{ padding: '10px 12px' }}>
                        <button type="button" className="qd-dot qd-dot-sm" title="아이콘·색 바꾸기"
                          style={{ background: bgOf(l.color) }}
                          onClick={() => setStyling(open ? null : l.id)}><Ic size={15}/></button>
                        <div style={{ minWidth: 0 }}>
                          <div className="fw-600 text-sm">{leaf?.label || l.id}</div>
                          <div className="text-xs text-muted2">{[leaf?.domain, leaf?.section].filter(Boolean).join(' › ')}</div>
                        </div>
                        <div className="row gap-6 ml-auto" style={{ alignItems: 'center' }}>
                          <div className="col" style={{ gap: 1 }}>
                            <button className="ord-btn" disabled={i === 0} title="위로" onClick={() => move(i, -1)}>▲</button>
                            <button className="ord-btn" disabled={i === links.length - 1} title="아래로" onClick={() => move(i, 1)}>▼</button>
                          </div>
                          <button className="btn sm" onClick={() => setStyling(open ? null : l.id)}>
                            {open ? '접기' : '꾸미기'}
                          </button>
                          <button className="btn sm" style={{ color: 'var(--neg-ink)' }} onClick={() => remove(l.id)}>빼기</button>
                        </div>
                      </div>

                      {open && (
                        <div className="col gap-10" style={{ padding: '12px', borderTop: '1px solid var(--line)', background: 'var(--surface-2)' }}>
                          <div>
                            <div className="text-xs text-muted2" style={{ marginBottom: 6 }}>아이콘</div>
                            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                              {DOCK_ICONS.map(n => {
                                const I = Icon[n]
                                return (
                                  <button key={n} type="button" className={`qd-pick ${l.icon === n ? 'on' : ''}`}
                                    title={n} onClick={() => patch(l.id, { icon: n })}><I size={14}/></button>
                                )
                              })}
                            </div>
                          </div>
                          <div>
                            <div className="text-xs text-muted2" style={{ marginBottom: 6 }}>색</div>
                            <div className="row gap-6">
                              {DOCK_COLORS.map(c => (
                                <button key={c.key} type="button" title={c.label}
                                  className={`qd-color ${l.color === c.key ? 'on' : ''}`}
                                  style={{ background: c.bg }} onClick={() => patch(l.id, { color: c.key })}/>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
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

          {/* 자리와 숨기기 — 화면을 가린다는 말이 나올 자리라 조작을 눈에 보이게 둔다.
              끌어서 옮길 수도 있지만, 끌 수 있다는 걸 모르는 사람을 위해 버튼도 낸다. */}
          <div>
            <label className="label">펼치는 방향</label>
            <div className="row gap-6">
              {[['column', '세로', '↑'], ['row', '가로', '←']].map(([v, label, arrow]) => (
                <button key={v} type="button" className={`chip ${dir === v ? 'active' : ''}`}
                  onClick={() => setDir(v)}>{arrow} {label}</button>
              ))}
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
              가로로 펼치면 이름이 아이콘 아래에 붙어요 — 옆에 붙이면 줄이 화면을 가로지릅니다.
            </div>
          </div>

          <div>
            <label className="label">독 자리</label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {CORNERS.map(c => (
                <button key={c.key} type="button"
                  className={`chip ${pos.corner === c.key ? 'active' : ''}`}
                  onClick={() => setPos(p => ({ ...p, corner: c.key }))}>{c.label}</button>
              ))}
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
              독 버튼을 <b>끌어서</b> 옮길 수도 있어요. 놓으면 가장 가까운 모서리에 붙습니다.
            </div>
          </div>

          <div>
            <button className="btn" style={{ width: '100%' }}
              onClick={() => { setHidden(true); setEditOpen(false) }}>
              <Icon.EyeOff size={14}/> 독 숨기기
            </button>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
              숨겨도 사라지지 않아요 — 상단 <b>도움말(?)</b>에서 다시 켤 수 있습니다.
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
