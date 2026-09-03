import { useState, useMemo, useEffect, useRef, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui'

// 표 코어 — 앱 전역 표(약 49개)의 공통 뼈대.
// 헤더/필터 바(기간·검색·필터패널)는 별도 TableToolbar가 맡고, 여기선 표 본문만 담당한다.
// 정렬은 컬럼 헤더 클릭(오름→내림→해제, 클라이언트). 필터는 상단 툴바 소관(사용자 규약).
// 컬럼 너비는 지금은 고정값(width)만 — 드래그 리사이즈는 추후 opt-in.
//
// columns: [{
//   key,            row 접근 키 (render 없으면 row[key] 그대로 표시)
//   header,         헤더 라벨(문자열/노드)
//   width,          px 고정 너비(옵션)
//   align,          'right' | 'center' (기본 left) — 헤더·셀 정렬
//   sortable,       true면 헤더 클릭으로 정렬
//   sortValue,      (row) => 정렬 기준값 (기본 row[key]). 표시값과 정렬값이 다를 때(예: 금액 부호)
//   render,         (row, i) => 셀 내용 (기본 row[key])
//   className,      td className
//   headClassName,  th className
// }]
// rows: 배열 / onRowClick(row): 행 클릭 / empty: 빈 상태(문자열·노드) / minWidth: 표 최소 폭(px) / maxHeight: 세로 스크롤 상한(px)
// footer: <tfoot> 내용(합계 행 등, 옵션) / rowKey(row): key 추출(기본 row.id ?? index)
// renderExpanded(row): 펼침 내용. 값을 돌려주는 행만 아래에 전폭 행이 하나 더 붙는다.
//   (차입금 상환 스케줄·예적금 납입 스케줄처럼 '행 안의 표'가 필요한 화면이 여럿이라 여기 둔다.
//    화면마다 Fragment로 <tr>을 직접 끼우면 colSpan·배경·구분선을 매번 다시 맞춰야 한다)
/* select: 다중 선택. 주면 맨 앞에 체크박스 열이 생긴다.
 *   { ids, onChange(ids), isSelectable(row)?, disabledHint(row)? }
 * 선택 상태를 화면이 들고 있는 이유: 일괄 처리 뒤 무엇을 골랐는지 유지할지 비울지는
 * 그 화면의 사정이다(삭제는 비우고, 지급 처리는 남겨두는 편이 낫다).
 *
 * isSelectable 로 고를 수 없는 행을 가른다 — 이미 정산된 청구서처럼 **일괄 처리 대상이
 * 아닌 행**은 체크 자체가 안 돼야 한다. 눌러놓고 나중에 "3건 중 1건만 됐어요"라고
 * 말하는 것보다, 애초에 못 고르게 하고 이유를 붙이는 편이 낫다.
 */
/* ── 열 개인화 (tableKey 를 준 표만) ────────────────────────────────
 *
 * 같은 표라도 보는 사람이 다르다. 경리는 청구금액과 입금만 보면 되지만, 신고 자료를
 * 맞추는 사람은 공급가액과 부가세를 봐야 한다. 그렇다고 열을 다 세워 두면 표가
 * 가로로 밀려 아무도 못 읽는다 — 그래서 **접어 두고, 필요한 사람이 편다.**
 *
 * 저장은 이 브라우저에만 한다(서버에 두면 같은 계정을 여럿이 쓰는 곳에서 서로 화면을
 * 바꿔 버린다). 못 읽거나 못 쓰면 조용히 기본값으로 간다 — 표는 늘 그려져야 한다.
 *
 * ⚠ `tableKey` 는 표마다 달라야 한다. 같은 키를 쓰면 한 표에서 숨긴 열이 다른 표에서도 사라진다.
 */
const prefKey = (k) => `dt:${k}`
const readPrefs = (k) => {
  if (!k) return null
  try { return JSON.parse(localStorage.getItem(prefKey(k)) || 'null') } catch { return null }
}
const writePrefs = (k, v) => {
  if (!k) return
  try { localStorage.setItem(prefKey(k), JSON.stringify(v)) } catch { /* 사생활 보호 모드 */ }
}
/** 설정 목록에 보일 이름 — header 가 노드(아이콘·배지)거나 아예 비었으면(버튼 칸) 대신 쓸 이름. */
const colLabel = (c) =>
  c.label || (typeof c.header === 'string' && c.header.trim() ? c.header : null) || c.key || '이름 없는 열'

export const DataTable = ({ columns, rows, onRowClick, empty = '표시할 내용이 없어요', footer, rowKey, renderExpanded, select, rowClass, minWidth, maxHeight,
  /* tableKey: 주면 '열' 버튼이 생긴다 — 열 접기·순서·너비를 이 브라우저에 기억한다.
     **모든 열을 접을 수 있다**(마지막 한 열만 남긴다). 무엇이 필요한지는 보는 사람이 정한다 —
     우리가 '이건 못 끕니다'로 정해 두면 정작 안 쓰는 열을 못 치운다.
     열 정의에 붙일 수 있는 것:
       defaultHidden: true  처음엔 접혀 있는 열(공급가액·부가세처럼 필요한 사람만 펴는 것)
       label                설정 목록에 보일 이름(header 가 아이콘·노드일 때) */
  tableKey }) => {
  const [sort, setSort] = useState(null)   // { key, dir: 'asc' | 'desc' } | null
  const [prefs, setPrefs] = useState(() => readPrefs(tableKey))
  /* 표가 다른 화면으로 재사용될 때(같은 컴포넌트, 다른 tableKey) 앞 표의 설정이 남지 않게 한다 */
  useEffect(() => { setPrefs(readPrefs(tableKey)) }, [tableKey])
  const savePrefs = (next) => { setPrefs(next); writePrefs(tableKey, next) }

  /* 실제로 그릴 열 — 순서 → 숨김 → 너비 순으로 반영한다.
     ⚠ 저장된 순서에 없는 열은 **뒤에 붙인다**. 새 열이 생겼는데 저장된 순서만 따르면
       그 열이 통째로 사라진다(설정을 한 번 만진 사람만 못 보는, 찾기 어려운 버그다). */
  const shownColumns = useMemo(() => {
    if (!tableKey) return columns
    const order = prefs?.order || []
    const rank = new Map(order.map((k, i) => [k, i]))
    const ordered = [...columns].sort((a, b) =>
      (rank.has(a.key) ? rank.get(a.key) : 1e6 + columns.indexOf(a)) -
      (rank.has(b.key) ? rank.get(b.key) : 1e6 + columns.indexOf(b)))
    const hidden = new Set(prefs?.hidden || columns.filter(c => c.defaultHidden).map(c => c.key))
    const widths = prefs?.width || {}
    /* 접을 수 있는 열을 따로 두지 않는다 — 무엇이 필요한지는 보는 사람이 정한다.
       (마지막 한 열까지 접는 것만 toggleCol 이 막는다 — 빈 표는 고장으로 보인다) */
    return ordered
      .filter(c => !hidden.has(c.key))
      .map(c => (widths[c.key] ? { ...c, width: widths[c.key] } : c))
  }, [columns, prefs, tableKey])

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = shownColumns.find(c => c.key === sort.key)
    if (!col) return rows
    const val = (r) => (col.sortValue ? col.sortValue(r) : r[col.key])
    // 방향은 '값 비교'에만 적용한다. reverse()로 뒤집으면 빈 값(뒤에 있던 것)이 맨 앞으로 와
    // '빈 값은 항상 뒤로' 규약이 내림차순에서 깨진다.
    const dir = sort.dir === 'desc' ? -1 : 1
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b)
      if (x == null && y == null) return 0
      if (x == null) return 1          // 빈 값은 항상 뒤로(방향 무관)
      if (y == null) return -1
      const c = (typeof x === 'number' && typeof y === 'number')
        ? x - y
        : String(x).localeCompare(String(y), 'ko')
      return c * dir
    })
  }, [rows, sort, shownColumns])

  const clickSort = (col) => {
    if (!col.sortable) return
    setSort(s => {
      if (!s || s.key !== col.key) return { key: col.key, dir: 'asc' }
      if (s.dir === 'asc') return { key: col.key, dir: 'desc' }
      return null                       // 내림 다음은 정렬 해제(원래 순서)
    })
  }

  const alignClass = (a) => (a === 'right' ? 'num-right' : a === 'center' ? 'text-center' : '')

  /* 행 키는 **정렬된 목록 기준으로 한 번만** 매긴다.
     rowKey 도 row.id 도 없을 때의 대체값이 배열 인덱스라서, 걸러낸 배열(selectable)에서 다시
     매기면 같은 행이 다른 키를 갖는다 — 고른 것과 그려진 것이 어긋난다. */
  const keyOf = (row, i) => (rowKey ? rowKey(row) : (row.id ?? i))
  const keyByRow = new Map(sorted.map((r, i) => [r, keyOf(r, i)]))
  const canSelect = (row) => !select?.isSelectable || select.isSelectable(row)
  const selectable = select ? sorted.filter(canSelect) : []
  const selectedSet = new Set(select?.ids || [])
  /* 머리 체크박스는 **지금 화면에 보이는 것 중 고를 수 있는 것**만 다룬다.
     필터를 걸어 놓고 전체 선택을 눌렀는데 안 보이는 행까지 선택되면, 그 다음 '일괄 삭제'가
     사용자가 보지 못한 것을 지운다. */
  const allOn = selectable.length > 0 && selectable.every(r => selectedSet.has(keyByRow.get(r)))
  const someOn = selectable.some(r => selectedSet.has(keyByRow.get(r)))
  const toggleAll = () => {
    const visible = selectable.map(r => keyByRow.get(r))
    select.onChange(allOn ? (select.ids || []).filter(id => !visible.includes(id))
                          : [...new Set([...(select.ids || []), ...visible])])
  }
  const toggleOne = (id) => {
    const on = selectedSet.has(id)
    select.onChange(on ? (select.ids || []).filter(x => x !== id) : [...(select.ids || []), id])
  }
  const colCount = shownColumns.length + (select ? 1 : 0)

  /* ── 열 설정 조작 ──
     hidden 은 '지금 접힌 열'을 통째로 담는다. 저장된 값이 없으면 defaultHidden 이 기본이다. */
  const hiddenNow = prefs?.hidden || columns.filter(c => c.defaultHidden).map(c => c.key)
  const orderedAll = useMemo(() => {
    const order = prefs?.order || []
    const rank = new Map(order.map((k, i) => [k, i]))
    return [...columns].sort((a, b) =>
      (rank.has(a.key) ? rank.get(a.key) : 1e6 + columns.indexOf(a)) -
      (rank.has(b.key) ? rank.get(b.key) : 1e6 + columns.indexOf(b)))
  }, [columns, prefs])

  const toggleCol = (key) => {
    const on = hiddenNow.includes(key)
    // 마지막 남은 한 열까지 접으면 표가 통째로 사라진다 — 거기서 멈춘다
    if (!on && shownColumns.length <= 1) return
    const hidden = on ? hiddenNow.filter(k => k !== key) : [...hiddenNow, key]
    /* 정렬 기준이던 열을 접으면 정렬도 푼다 — 안 그러면 보이지도 않는 열 기준으로
       줄이 서 있어 "왜 이 순서지"를 알 길이 없다. */
    if (!on && sort?.key === key) setSort(null)
    savePrefs({ ...(prefs || {}), hidden })
  }
  const moveCol = (key, delta) => {
    const keys = orderedAll.map(c => c.key)
    const i = keys.indexOf(key)
    const j = i + delta
    if (i < 0 || j < 0 || j >= keys.length) return
    keys.splice(j, 0, keys.splice(i, 1)[0])
    savePrefs({ ...(prefs || {}), order: keys })
  }
  const resetCols = () => { savePrefs({}); setSort(null) }

  /* 너비 끌기 — 머리글 오른쪽 모서리를 잡고 민다.
     ⚠ 표 안의 클릭(정렬)과 겹치지 않게 손잡이에서 클릭을 멈춘다. */
  const drag = useRef(null)
  useEffect(() => {
    if (!tableKey) return
    const onMove = (e) => {
      if (!drag.current) return
      const { key, startX, startW } = drag.current
      const w = Math.max(48, Math.round(startW + (e.clientX - startX)))
      drag.current.w = w
      const th = document.querySelector(`[data-dt-th="${key}"]`)
      if (th) th.style.width = `${w}px`      // 끄는 동안은 DOM 만 — 매 픽셀 저장하면 화면이 통째로 다시 그려진다
    }
    const onUp = () => {
      if (!drag.current) return
      const drag0 = drag.current
      const { key, w } = drag0
      drag.current = null
      document.body.style.cursor = ''
      if (w) savePrefs({ ...(prefs || {}), width: { ...(drag0.snapshot || {}), [key]: w } })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [tableKey, prefs])

  /* ⚠ 끌기를 시작할 때 **모든 열의 지금 너비를 함께 적어 둔다.**
     기본 레이아웃(table-layout:auto)에서는 지정한 width 가 '희망 사항'이라, 남는 폭을
     브라우저가 다시 나눠 갖는다 — 246px 로 끌어도 화면은 166px 그대로였다(실측).
     너비를 지키려면 fixed 레이아웃으로 가야 하는데, 그러면 **적어 두지 않은 열**은
     제 폭을 잃는다. 그래서 지금 보이는 모습을 그대로 굳힌 뒤 하나만 바꾼다. */
  const startResize = (e, c) => {
    e.preventDefault(); e.stopPropagation()
    const th = e.currentTarget.parentElement
    const row = th.parentElement
    /* ⚠ offsetWidth 는 **내림한 정수**다. 열마다 1px 씩 깎이면 열두 열에서 십여 px 이 사라져,
       굳히는 순간 금액이 두 줄로 접힌다(실측). 소수까지 재서 올림한다. */
    const wOf = (el) => Math.ceil(el.getBoundingClientRect().width)
    const snapshot = { ...(prefs?.width || {}) }
    for (const el of row.children) {
      const k = el.getAttribute('data-dt-th')
      if (k && !snapshot[k]) snapshot[k] = wOf(el)
    }
    drag.current = { key: c.key, startX: e.clientX, startW: wOf(th), snapshot }
    document.body.style.cursor = 'col-resize'
  }

  const changed = !!(prefs && (prefs.hidden?.length || prefs.order?.length || Object.keys(prefs.width || {}).length))

  /* ── 열 설정 패널 열고 닫기 ──
     화면 좌표로 띄운다(카드의 overflow 를 벗어나야 안 잘린다). 그래서 자리를 직접 잰다:
       · 오른쪽 끝을 버튼에 맞추되 화면 밖으로 나가지 않게 민다
       · 아래가 모자라면 버튼 위로 올린다(줄이 적은 표는 표 아래가 곧 화면 끝이다) */
  const [colOpen, setColOpen] = useState(false)
  const [colMenuPos, setColMenuPos] = useState(null)
  const colBtnRef = useRef(null)
  const colMenuRef = useRef(null)
  const MENU_W = 264

  useEffect(() => {
    if (!colOpen) { setColMenuPos(null); return }
    const place = () => {
      const b = colBtnRef.current?.getBoundingClientRect()
      if (!b) return
      const h = colMenuRef.current?.offsetHeight || 320
      const left = Math.max(8, Math.min(b.right - MENU_W, window.innerWidth - MENU_W - 8))
      const below = b.bottom + 6
      const top = below + h > window.innerHeight - 8 ? Math.max(8, b.top - h - 6) : below
      setColMenuPos({ top, left })
    }
    place()
    // 그린 뒤 실제 높이로 한 번 더 맞춘다(첫 계산은 높이를 모른다)
    const t = setTimeout(place, 0)
    const onDoc = (e) => {
      if (colBtnRef.current?.contains(e.target) || colMenuRef.current?.contains(e.target)) return
      setColOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setColOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    // 스크롤하면 버튼이 움직인다 — 패널도 따라간다(안 따라가면 허공에 떠 있다)
    window.addEventListener('scroll', place, true)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [colOpen, orderedAll.length])

  /* 너비를 손본 표만 fixed 로 간다 — 안 만진 표는 여태 모습 그대로여야 한다.
     폭을 합계로 못박는 이유: width:100% 인 채로 fixed 면 남는 폭을 열들이 나눠 가져
     끌어 놓은 값과 어긋난다. 합계가 화면보다 좁으면 오른쪽이 비고, 넓으면 가로로 스크롤된다. */
  const fixedWidth = useMemo(() => {
    const w = prefs?.width
    if (!tableKey || !w || !Object.keys(w).length) return null
    const cols = shownColumns.filter(c => w[c.key])
    if (cols.length !== shownColumns.length) return null   // 새 열이 생겼으면 굳히지 않는다
    return cols.reduce((a, c) => a + Number(w[c.key] || 0), 0) + (select ? 40 : 0)
  }, [prefs, shownColumns, select, tableKey])

  const colBar = tableKey ? (
    /* 표 위 오른쪽 — 늘 있지만 조용하다(ghost). 여기 있는 줄 모르면 아무도 안 쓰므로
       숨기지는 않는다. 인쇄에는 안 나온다.
       ⚠ 이 표들은 대개 `overflow: hidden` 인 카드 안에 있다. 그래서 공용 Popover(absolute)를
         쓰면 **버튼도 열림 패널도 카드 모서리에서 잘린다**(실측 — 줄이 적을 때 특히 심하다).
         패널은 화면 좌표(fixed)로 body 에 띄우고, 바에는 오른쪽 여백을 준다. */
    <div className="dt-colbar no-print">
      <button ref={colBtnRef} className="btn ghost sm" title="보여줄 열·순서·너비를 고쳐요"
        onClick={() => setColOpen(o => !o)}>
        <Icon.Filter size={12}/> 열{changed ? ' ·' : ''}
      </button>
      {colOpen && colMenuPos && createPortal(
        <div ref={colMenuRef} className="dt-colmenu"
          style={{ position: 'fixed', top: colMenuPos.top, left: colMenuPos.left, width: 264 }}>
        <div style={{ padding: 8 }}>
          <div className="row" style={{ padding: '2px 6px 8px' }}>
            <span className="text-xs text-muted2">보여줄 열과 순서</span>
            {changed && <button className="btn ghost sm ml-auto" onClick={resetCols}>기본값</button>}
          </div>
          {/* 열이 열댓 개인 표도 있다 — 목록이 화면 밖으로 넘치면 아래쪽 열은 손도 못 댄다 */}
          <div style={{ maxHeight: '46vh', overflowY: 'auto' }}>
          {orderedAll.map((c, i) => {
            const on = !hiddenNow.includes(c.key)
            const last = on && shownColumns.length <= 1
            return (
              <div key={c.key} className="row gap-6" style={{ padding: '4px 6px', alignItems: 'center' }}>
                <input type="checkbox" checked={on} disabled={last}
                  onChange={() => toggleCol(c.key)}
                  title={last ? '열을 모두 접을 수는 없어요' : undefined}/>
                <span className={`text-sm ${!on ? 'text-muted2' : ''}`}
                  style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {colLabel(c)}
                </span>
                <button className="icon-btn sm" title="위로" disabled={i === 0}
                  onClick={() => moveCol(c.key, -1)}><Icon.Up size={12}/></button>
                <button className="icon-btn sm" title="아래로" disabled={i === orderedAll.length - 1}
                  onClick={() => moveCol(c.key, 1)}><Icon.Down size={12}/></button>
              </div>
            )
          })}
          </div>
          <div className="text-xs text-muted2" style={{ padding: '8px 6px 2px', lineHeight: 1.6 }}>
            머리글 오른쪽 끝을 끌면 너비가 바뀌어요. 이 브라우저에만 기억합니다.
          </div>
        </div>
        </div>, document.body)}
    </div>
  ) : null

  return (
    <>
    {colBar}
    <div className="table-scroll" style={maxHeight ? { maxHeight } : undefined}>
      {/* minWidth: 열이 많아 좁은 화면에서 짓눌리는 표(자금관리표 등)가 쓴다.
          인쇄에서는 index.css 가 min-width 를 0으로 되돌린다 — 종이는 안 밀린다. */}
      <table className="table"
        style={fixedWidth ? { tableLayout: 'fixed', width: fixedWidth, minWidth: fixedWidth }
                          : (minWidth ? { minWidth } : undefined)}>
        <thead>
          <tr>
            {select && (
              <th style={{ width: 40 }} onClick={e => e.stopPropagation()}>
                <input type="checkbox" checked={allOn}
                  ref={el => { if (el) el.indeterminate = !allOn && someOn }}
                  disabled={selectable.length === 0}
                  onChange={toggleAll} title="보이는 것 전체 선택"/>
              </th>
            )}
            {shownColumns.map((c, i) => {
              const active = sort?.key === c.key
              return (
                <th key={c.key ?? i} data-dt-th={c.key}
                  className={`${alignClass(c.align)} ${c.headClassName || ''}`.trim()}
                  style={{ width: c.width, cursor: c.sortable ? 'pointer' : undefined,
                           position: tableKey ? 'relative' : undefined }}
                  onClick={() => clickSort(c)}>
                  <span className="dt-th" style={{ justifyContent: c.align === 'right' ? 'flex-end' : c.align === 'center' ? 'center' : 'flex-start' }}>
                    {c.header}
                    {/* data-dir 은 Icon 이 svg로 전달하지 않으므로 감싸는 span 이 지닌다 */}
                    {c.sortable && <span className="dt-sort" data-dir={active ? sort.dir : 'none'}><Icon.Down size={12}/></span>}
                  </span>
                  {/* 너비 손잡이 — 마지막 열에는 두지 않는다(늘려 봐야 표 밖이다) */}
                  {tableKey && i < shownColumns.length - 1 && (
                    <span className="dt-resize no-print" onMouseDown={e => startResize(e, c)}
                      onClick={e => e.stopPropagation()} title="끌어서 너비 조절"/>
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr><td colSpan={colCount} className="dt-empty">{empty}</td></tr>
          ) : sorted.map((row, i) => {
            const key = keyByRow.get(row) ?? keyOf(row, i)
            const expanded = renderExpanded ? renderExpanded(row, i) : null
            const on = selectedSet.has(key)
            const able = select ? canSelect(row) : false
            return (
              <Fragment key={key}>
                <tr onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={onRowClick ? { cursor: 'pointer' } : undefined}
                  className={[on ? 'dt-selected' : '', rowClass ? rowClass(row) : ''].filter(Boolean).join(' ') || undefined}>
                  {select && (
                    /* 체크박스 칸에서는 행 클릭(상세 열기)이 일어나면 안 된다 —
                       고르려다 드로어가 열리면 선택이 아니라 방해가 된다. */
                    <td onClick={e => e.stopPropagation()}
                      title={!able ? (select.disabledHint?.(row) || '이 건은 일괄 처리 대상이 아니에요') : undefined}>
                      <input type="checkbox" checked={on} disabled={!able}
                        onChange={() => toggleOne(key)}/>
                    </td>
                  )}
                  {shownColumns.map((c, ci) => (
                    <td key={c.key ?? ci} className={`${alignClass(c.align)} ${c.className || ''}`.trim()}>
                      {c.render ? c.render(row, i) : row[c.key]}
                    </td>
                  ))}
                </tr>
                {expanded && (
                  <tr className="dt-expanded">
                    <td colSpan={colCount} style={{ padding: 0, background: 'var(--surface-2)' }}>{expanded}</td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
    </>
  )
}
