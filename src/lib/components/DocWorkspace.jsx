import { useEffect, useRef, useState } from 'react'
import { fmtNum } from '../ui'

// 문서 센터 공용 레이아웃 — 좌측 리스트 + 우측(콘텐츠 헤더 + 본문).
// 지급결의서·정산내역서 등 모든 문서 화면이 같은 뼈대를 쓴다.
//
//   <DocWorkspace>
//     <DocSide top={필터/검색}>{rows or empty}</DocSide>
//     <DocMain>
//       {sel ? <><DocToolbar docNo status>{actions}</DocToolbar><DocViewport portrait>{문서}</DocViewport></> : <DocEmpty/>}
//     </DocMain>
//   </DocWorkspace>

export const DocWorkspace = ({ children }) => <div className="doc-ws">{children}</div>

/* 목록 키보드 이동 — 목록 줄에 포커스가 있을 때만 ↑↓·Home·End 로 옮겨 가며 본다(메일 앱처럼).
 *   입력칸·팝업에 포커스가 있으면 줄이 아니라 그쪽이 키를 받으므로 건드리지 않는다.
 *   포커스는 바로 옮기고, 문서 열기(줄 클릭)는 손을 멈췄을 때만 — 꾹 누르면 줄마다 상세 요청이 몰린다.
 *   마지막 줄에서 ↓ 면 '더 보기'를 불러온다. */
const NAV_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End']
const OPEN_DELAY = 120
export const DocSide = ({ top, children }) => {
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const onKeyDown = (e) => {
    if (!NAV_KEYS.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const cur = e.target.closest?.('.doc-ws-row')
    if (!cur) return
    e.preventDefault()   // 목록 대신 화면이 스크롤되지 않게
    const box = e.currentTarget
    const rows = [...box.querySelectorAll('.doc-ws-row')]
    const i = rows.indexOf(cur)
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : i + (e.key === 'ArrowDown' ? 1 : -1)
    if (j >= rows.length) { box.querySelector('[data-doc-more]:not(:disabled)')?.click(); return }
    if (j < 0 || j === i) return
    const next = rows[j]
    next.focus({ preventScroll: true })
    next.scrollIntoView({ block: 'nearest' })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { next.dataset.kbd = '1'; next.click() }, OPEN_DELAY)
  }
  return (
    <div className="card doc-ws-side">
      {top && <div className="doc-ws-side-top">{top}</div>}
      <div className="doc-ws-side-scroll" onKeyDown={onKeyDown}
        onPointerDown={() => clearTimeout(timer.current)}>{children}</div>
    </div>
  )
}

/** 목록 끝 '더 보기' — useDocList 의 list 를 그대로 받는다. 키보드 이동이 data-doc-more 로 찾는다 */
export const DocListMore = ({ list }) => list.hasMore ? (
  <button type="button" className="btn ghost" data-doc-more style={{ width: '100%', marginTop: 6 }}
    disabled={list.loadingMore} onClick={list.loadMore}>
    {list.loadingMore ? '불러오는 중…' : `더 보기 · ${list.rows.length}/${list.total}건`}
  </button>
) : null

// 좌측 리스트 한 행 — 두 화면 공통 모양(문서번호+우측배지, 제목, 메타+금액)
/* 한 줄 레이아웃(폭 900px 이하)에서는 문서가 목록 **아래**에 있다 — 고르면 문서로 내려가 보여 준다.
   안 그러면 고른 게 안 보여 "눌러도 안 뜬다"가 된다 */
const showDocIfStacked = () => {
  if (typeof window === 'undefined' || window.innerWidth > 900) return
  setTimeout(() => document.querySelector('.doc-ws-main')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60)
}
export const DocListRow = ({ active, onClick: onPick, docNo, right, title, meta, amount, amountLabel = '원' }) => {
  // 키보드로 옮겨 온 줄은 목록에 머문다 — 한 줄 레이아웃에서 문서로 내려가 버리면 다음 ↓ 를 못 누른다
  const onClick = (e) => {
    const kbd = e.currentTarget.dataset.kbd; delete e.currentTarget.dataset.kbd
    onPick?.(e); if (!kbd) showDocIfStacked()
  }
  return (
  <button type="button" className={`doc-ws-row ${active ? 'active' : ''}`} onClick={onClick}>
    <div className="doc-ws-row-top">
      <span className="num text-xs text-muted2 fw-600">{docNo}</span>
      {right != null && <span className="doc-ws-row-right">{right}</span>}
    </div>
    {title != null && <div className="doc-ws-row-title">{title}</div>}
    {(meta != null || amount != null) && (
      <div className="doc-ws-row-meta">
        {meta != null && <span className="text-xs text-muted">{meta}</span>}
        {amount != null && (
          <span className="num fw-700 text-sm doc-ws-row-amt">
            {fmtNum(amount)}<span className="text-muted2" style={{ fontWeight: 400, marginLeft: 2 }}>{amountLabel}</span>
          </span>
        )}
      </div>
    )}
  </button>
  )
}

export const DocSideEmpty = ({ children }) => (
  <div className="doc-ws-side-empty">{children}</div>
)

export const DocMain = ({ children }) => <div className="doc-ws-main">{children}</div>

// 콘텐츠 헤더 — 문서번호 + 상태 + (오른쪽) 액션 버튼들
export const DocToolbar = ({ docNo, status, children }) => (
  <div className="card no-print doc-ws-toolbar">
    <span className="num fw-700 text-sm">{docNo}</span>
    {status}
    <div className="ml-auto row gap-6">{children}</div>
  </div>
)

// 본문 뷰포트 — portrait(세로 양식)면 가운데 정렬, 아니면(가로) 그대로 폭 채움
/* 종이 폭(A4 794px)보다 칸이 좁으면 **화면에서만** 줄여 보인다(.doc-ws-fit zoom — 인쇄는 원래 크기).
 *
 * 왜 — 노트북(1366×768, 배율 125% → 폭 1093px)에서 2열이 버티지 못해 목록 아래로 접혔고,
 *   문서가 화면 밖(아래 1300px)에 있어 고객사가 "목록만 뜨고 문서가 안 뜬다, 인쇄도 안 된다"고 했다
 *   (2026-10-01). 넓은 모니터에선 재현이 안 돼 개발 쪽에선 못 봤다.
 *   2열을 노트북 폭까지 지키되, 그러면 종이가 칸보다 넓어지므로 맞춰 줄인다. */
const PAPER_W = 794
export const DocViewport = ({ portrait, children }) => {
  const ref = useRef(null)
  const [fit, setFit] = useState(1)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const cs = getComputedStyle(el)
      const w = el.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0)
      // 너무 작아지면 글자를 못 읽는다 — 그 아래는 가로 스크롤로 넘긴다
      setFit(Math.max(0.6, Math.min(1, w / PAPER_W)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={ref} className={`doc-ws-viewport ${portrait ? 'is-portrait' : ''}`}>
      {/* 줄일 때는 종이를 A4 폭(794px)으로 펴 놓고 통째로 줄인다 — 퍼센트 폭은 zoom 과 엮여 브라우저마다 어긋났다 */}
      <div className="doc-ws-fit" style={{ '--doc-fit': fit, ...(fit < 1 ? { width: PAPER_W } : null) }}>{children}</div>
    </div>
  )
}

export const DocEmpty = ({ icon, children }) => (
  <div className="card doc-ws-empty">
    {icon}
    <div className="text-sm">{children}</div>
  </div>
)
