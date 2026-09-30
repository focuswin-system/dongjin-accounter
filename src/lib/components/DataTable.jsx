import { useState, useMemo, useEffect, useLayoutEffect, useRef, Fragment } from 'react'
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
//   maxWidth,       글 칸이 차지할 최대 폭(px, 기본 320). 넘치면 한 줄 '…'
//   shrink,         false 면 화면 맞추기에서 깎지 않는다(날짜 범위처럼 잘리면 뜻이 사라지는 칸)
// }]
//
// ⚠ **칸은 한 줄이다**(2026-09-30 사용자). 줄바꿈이 섞이면 행 높이가 들쭉날쭉해 목록을 훑을 수 없다.
//   넘치는 글은 '…'로 자르고, 잘린 칸에 마우스를 올리면 전체 글이 뜬다(title — 잘렸을 때만).
//   전체 내용은 행을 눌러 상세에서 본다. 그래서 render 도 **한 줄로** 그린다 —
//   이름 아래 작은 글씨를 붙이고 싶으면 '이름 · 부가정보'로 옆에 잇거나 칸을 따로 뺀다.
//   칸 폭을 직접 끌어 정한 표(fixedWidth)는 그 폭 안에서 자른다.
// rows: 배열 / onRowClick(row): 행 클릭 / empty: 빈 상태(문자열·노드) / minWidth: 표 최소 폭(px) / maxHeight: 세로 스크롤 상한(px)
//
// loading: 아직 못 읽었나. **'없음'과 '아직 안 옴'은 다른 말이다.**
//   예전엔 둘을 구분하지 않아, 화면을 열면 "조건에 맞는 거래내역이 없어요."가 번쩍였다가
//   표가 채워졌다. 새 회사는 그 문구가 진짜인지 로딩인지 알 수 없었고, 카드 대금에서는
//   "카드 등록하러 가기" 버튼이 번쩍여 **없는 카드를 또 만들러 가게** 만들었다.
//   화면이 파생 계산을 많이 하면 rows 를 null 로 바꾸기 어렵다 — 그때는 loading 플래그만 든다.
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
/** 설정 목록에 보일 이름.
 *  ⚠ 머리글이 비었거나(버튼 칸) 아이콘·배지면 **label 을 반드시 준다.** 안 주면 영문 키가
 *    그대로 목록에 나온다 — 'action' 이 무엇인지 아는 사람은 우리뿐이다(실사용 문의). */
const colLabel = (c) =>
  c.label || (typeof c.header === 'string' && c.header.trim() ? c.header : null) || c.key || '이름 없는 열'

/* 칸 안의 보조 정보 — 이름 **옆에** 작고 흐리게 잇는다(아래 줄에 달지 않는다 — 칸은 한 줄).
   예: <b>경남은행 계좌1</b><Sub>529070105612</Sub> → '경남은행 계좌1  529070105612' */
export const Sub = ({ children, className = '', style }) =>
  children == null || children === false || children === '' ? null
    : <span className={`dt-sub ${className}`.trim()} style={style}>{children}</span>

/* 잘린 칸에만 전체 글을 띄운다 — 늘 걸면 멀쩡한 칸에도 말풍선이 떠 시끄럽다.
   render 가 이미 title 을 준 칸(안내 말풍선)은 건드리지 않는다 */
const titleIfClipped = (e) => {
  const el = e.currentTarget
  const inner = el.firstElementChild
  const clipped = el.scrollWidth > el.clientWidth || (inner && inner.scrollWidth > inner.clientWidth)
  if (clipped && !el.querySelector('[title]')) {
    // 보조 정보(Sub)는 화면에선 여백으로 떨어져 있지만 글자로는 붙어 있다 — 말풍선엔 ' · '로 잇는다
    const copy = el.cloneNode(true)
    copy.querySelectorAll('.dt-sub').forEach(n => n.prepend(' · '))
    el.title = copy.textContent.replace(/\s+/g, ' ').trim()
  }
  else if (!clipped) el.removeAttribute('title')
}

export const DataTable = ({ columns, rows, loading, onRowClick, empty = '표시할 내용이 없어요', footer, rowKey, renderExpanded, select, rowClass, minWidth, maxHeight,
  /* tableKey: 주면 '열' 버튼이 생긴다 — 열 접기·순서·너비를 이 브라우저에 기억한다.
     **모든 열을 접을 수 있다**(마지막 한 열만 남긴다). 무엇이 필요한지는 보는 사람이 정한다 —
     우리가 '이건 못 끕니다'로 정해 두면 정작 안 쓰는 열을 못 치운다.
     열 정의에 붙일 수 있는 것:
       defaultHidden: true  처음엔 접혀 있는 열(공급가액·부가세처럼 필요한 사람만 펴는 것)
       label                설정 목록에 보일 이름(header 가 아이콘·노드일 때) */
  tableKey,
  /* colBarIn: '열 설정' 버튼을 표 위 **따로 한 줄** 대신 이 자리(DOM 노드)에 그린다.
     툴바에 필터·검색이 이미 한 줄 있는 화면은 버튼 하나 때문에 한 줄이 더 생겨 표가 밀려 내려간다.
     화면이 툴바 안에 <span ref={setSlot}/> 을 두고 그 노드를 넘긴다. 아직 null 이면 그리지 않는다. */
  colBarIn,
  /* pageSize: 주면 **앞 N건만** 그리고 아래에 [더 보기]를 단다(수백 건 목록 — 2026-09-29 수주·발주).
     ⚠ 자르는 것은 **맨 마지막**이다: 화면이 거른(검색·필터) rows 를 받아 여기서 정렬한 **다음** 자른다.
       잘린 50건 안에서 검색·정렬하면 뒤쪽 건은 영영 못 찾는다(사용자 지적). 합계(footer)도 거른 전체 기준.
     거르는 조건(rows)이나 정렬이 바뀌면 다시 N건부터 — 그래서 rows 는 useMemo 로 넘긴다
     (매번 새 배열이면 그릴 때마다 N건으로 되돌아간다). */
  pageSize }) => {
  const [sort, setSort] = useState(null)   // { key, dir: 'asc' | 'desc' } | null
  const [limit, setLimit] = useState(pageSize || 0)
  useEffect(() => { if (pageSize) setLimit(pageSize) }, [rows, sort, pageSize])
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

  /* '아직 안 옴' 판정 — 화면이 loading 을 주면 그것을, 안 주면 rows 가 null/undefined 인지 본다.
     빈 배열([])은 **진짜 없음**이다 — 그건 로딩으로 보지 않는다. */
  const isLoading = loading ?? (rows == null)

  const sorted = useMemo(() => {
    // rows 가 null 로 오는 화면이 있다(아직 안 읽음) — 정렬·지도에서 터지지 않게 빈 배열로 본다
    if (!Array.isArray(rows)) return []
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
  /* ⚠ rowKey 에 **줄 번호도 넘긴다.** 안 넘기면 `rowKey={(r, i) => i}` 처럼 번호로 키를 만드는
     화면(부가세·주문별 수익 등 일곱 곳)에서 i 가 undefined 라 **키가 통째로 빈다** —
     React 가 경고를 내고, 줄이 신원을 잃어 정렬·필터 때 엉뚱한 줄이 재사용된다. */
  const keyOf = (row, i) => (rowKey ? rowKey(row, i) : (row.id ?? i))
  const keyByRow = new Map(sorted.map((r, i) => [r, keyOf(r, i)]))
  // 그릴 줄 — 거르고 정렬한 **뒤에** 자른다(pageSize 머리말)
  const visible = pageSize ? sorted.slice(0, limit) : sorted
  const hiddenCount = sorted.length - visible.length
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

  /* 화면에 맞추기 — 칸이 한 줄이 되면서 표가 화면보다 넓어질 수 있다(줄바꿈이 폭을 흡수하던 몫).
     넘치면 **가장 넓은 글 칸부터** 같은 높이로 깎는다(물 채우기: 넓은 칸들이 같은 상한 L 로 잘린다).
     금액(오른쪽 정렬)·버튼 칸은 깎지 않는다 — 숫자가 '…'가 되면 읽을 수 없다.
     L 은 FIT_MIN 밑으로 안 내린다. 그래도 넘치면 가로 스크롤이 맡는다(좁은 화면).
     원래 FIT_MIN 보다 좁은 칸(번호·날짜·기한 배지 같은 짧은 것)은 후보가 아니다 — 긴 글만 깎는다.
     다 깎아도 못 맞추면 깎을 만큼 깎고 나머지는 가로 스크롤 — 덜 밀게 하는 편이 낫다
     (안 깎아 봤더니 1600 화면에서 주문 목록의 상태 칸이 화면 밖으로 나갔다).
     ⚠ 자연 폭은 칸의 scrollWidth(잘려도 글 전체 폭)에서 구한다 — 지금 폭에서 구하면
       깎은 결과를 다시 재서 또 깎는 되먹임이 생긴다. 폭을 직접 끈 표(fixedWidth)는 건드리지 않는다. */
  const scrollRef = useRef(null)
  const [caps, setCaps] = useState(null)
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const FIT_MIN = 150, PAD = 30
    const fit = () => {
      const table = box.querySelector(':scope > table')
      if (!table || fixedWidth) { setCaps(c => (c ? null : c)); return }
      let extra = 0
      const cand = []
      for (const c of shownColumns) {
        if (c.align === 'right' || c.key == null || c.shrink === false) continue
        const th = table.querySelector(`:scope > thead th[data-dt-th="${c.key}"]`)
        const cells = table.querySelectorAll(`:scope > tbody .dt-cell[data-dt-col="${c.key}"]`)
        if (!th || !cells.length) continue
        let nat = 0, btn = false
        cells.forEach(el => { nat = Math.max(nat, el.scrollWidth); if (!btn && el.querySelector('button')) btn = true })
        if (btn) continue
        nat = Math.max(nat + PAD, th.querySelector('.dt-th')?.scrollWidth + PAD || 0)
        if (nat <= FIT_MIN) continue
        extra += nat - th.getBoundingClientRect().width
        cand.push({ key: c.key, nat })
      }
      const over = table.offsetWidth + extra - box.clientWidth
      if (over <= 1 || !cand.length) { setCaps(c => (c ? null : c)); return }
      // 물 채우기 — 상한 L 을 내리며 넘친 만큼 깎일 때 멈춘다
      const w = cand.map(c => c.nat).sort((a, b) => b - a)
      let L = FIT_MIN
      for (let i = 0, cut = 0; i < w.length; i++) {
        const next = i + 1 < w.length ? Math.max(w[i + 1], FIT_MIN) : FIT_MIN
        const room = (w[i] - next) * (i + 1)          // L 을 w[i] → next 로 내리면 더 깎이는 폭
        if (cut + room >= over) { L = w[i] - (over - cut) / (i + 1); break }
        cut += room
        if (next === FIT_MIN) break
      }
      L = Math.max(FIT_MIN, Math.floor(L))
      const next = {}
      cand.forEach(c => { if (c.nat > L) next[c.key] = L - PAD })
      setCaps(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(box)
    return () => ro.disconnect()
  }, [rows, sort, limit, shownColumns, fixedWidth])   // eslint-disable-line react-hooks/exhaustive-deps

  const colBar = tableKey ? (
    /* 표 위 오른쪽 — 늘 있지만 조용하다(ghost). 여기 있는 줄 모르면 아무도 안 쓰므로
       숨기지는 않는다. 인쇄에는 안 나온다.
       ⚠ 이 표들은 대개 `overflow: hidden` 인 카드 안에 있다. 그래서 공용 Popover(absolute)를
         쓰면 **버튼도 열림 패널도 카드 모서리에서 잘린다**(실측 — 줄이 적을 때 특히 심하다).
         패널은 화면 좌표(fixed)로 body 에 띄우고, 바에는 오른쪽 여백을 준다. */
    <div className="dt-colbar no-print">
      {/* 테두리 없는 ghost 로 뒀더니 카드 모서리에 얹힌 글자처럼 보였다 —
          누르는 것임을 알 수 있게 보통 버튼으로 세운다. 이름도 '열'만으로는 안 읽힌다. */}
      <button ref={colBtnRef} className="btn sm" title="보여줄 열·순서·너비를 고쳐요"
        onClick={() => setColOpen(o => !o)}>
        {/* 손댄 표라는 표시 — 글자 뒤에 '·' 를 붙였더니 **글자가 잘린 것처럼** 보였다.
            점은 따로 그린다. 정상(기본값)일 때는 아무 표식도 안 붙인다. */}
        <Icon.Filter size={12}/> 열 설정
        {changed && <span className="dt-coldot" title="기본값에서 바꾼 표예요"/>}
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
    {colBarIn === undefined ? colBar : (colBarIn && colBar ? createPortal(colBar, colBarIn) : null)}
    <div ref={scrollRef} className="table-scroll" style={maxHeight ? { maxHeight } : undefined}>
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
              /* 정렬은 머리글 클릭이다 — 키보드로도 되게 한다(Tab 으로 오고 Enter/Space).
                 aria-sort 는 읽어 주는 도구가 지금 어느 방향인지 말할 수 있게 한다. */
              return (
                <th key={c.key ?? i} data-dt-th={c.key}
                  className={`${alignClass(c.align)} ${c.headClassName || ''}`.trim()}
                  style={{ width: c.width, cursor: c.sortable ? 'pointer' : undefined,
                           position: tableKey ? 'relative' : undefined }}
                  tabIndex={c.sortable ? 0 : undefined}
                  aria-sort={c.sortable ? (active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                  onKeyDown={c.sortable ? (e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickSort(c) }
                  } : undefined}
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
          {isLoading ? (
            <tr><td colSpan={colCount} className="dt-empty">불러오는 중…</td></tr>
          ) : sorted.length === 0 ? (
            <tr><td colSpan={colCount} className="dt-empty">{empty}</td></tr>
          ) : visible.map((row, i) => {
            const key = keyByRow.get(row) ?? keyOf(row, i)
            const expanded = renderExpanded ? renderExpanded(row, i) : null
            const on = selectedSet.has(key)
            const able = select ? canSelect(row) : false
            return (
              <Fragment key={key}>
                {/* 눌러서 여는 행은 **키보드로도 열려야 한다** — Tab 으로 옮기고 Enter/Space.
                    마우스로만 열리면 키보드로 표를 훑던 사람은 거기서 손을 떼야 한다. */}
                <tr onClick={onRowClick ? () => onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? 'button' : undefined}
                  onKeyDown={onRowClick ? (e) => {
                    if (e.target !== e.currentTarget) return   // 칸 안의 버튼·체크박스가 먼저다
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row) }
                  } : undefined}
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
                      <div className="dt-cell" data-dt-col={c.key} onMouseEnter={titleIfClipped}
                        style={fixedWidth ? undefined : { maxWidth: Math.min(c.maxWidth ?? 320, caps?.[c.key] ?? Infinity) }}>
                        {c.render ? c.render(row, i) : row[c.key]}
                      </div>
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
      {hiddenCount > 0 && !isLoading && (
        <div className="dt-more">
          <span className="text-xs text-muted num">{visible.length.toLocaleString()} / {sorted.length.toLocaleString()}건</span>
          <button type="button" className="btn sm" onClick={() => setLimit(l => l + pageSize)}>
            {Math.min(pageSize, hiddenCount).toLocaleString()}건 더 보기
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setLimit(sorted.length)}>전부 보기</button>
        </div>
      )}
    </div>
    </>
  )
}
