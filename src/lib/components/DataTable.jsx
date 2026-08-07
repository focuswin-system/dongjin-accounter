import { useState, useMemo, Fragment } from 'react'
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
// rows: 배열 / onRowClick(row): 행 클릭 / empty: 빈 상태(문자열·노드)
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
export const DataTable = ({ columns, rows, onRowClick, empty = '표시할 내용이 없어요', footer, rowKey, renderExpanded, select }) => {
  const [sort, setSort] = useState(null)   // { key, dir: 'asc' | 'desc' } | null

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find(c => c.key === sort.key)
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
  }, [rows, sort, columns])

  const clickSort = (col) => {
    if (!col.sortable) return
    setSort(s => {
      if (!s || s.key !== col.key) return { key: col.key, dir: 'asc' }
      if (s.dir === 'asc') return { key: col.key, dir: 'desc' }
      return null                       // 내림 다음은 정렬 해제(원래 순서)
    })
  }

  const alignClass = (a) => (a === 'right' ? 'num-right' : a === 'center' ? 'text-center' : '')

  const keyOf = (row, i) => (rowKey ? rowKey(row) : (row.id ?? i))
  const canSelect = (row) => !select?.isSelectable || select.isSelectable(row)
  const selectable = select ? sorted.filter(canSelect) : []
  const selectedSet = new Set(select?.ids || [])
  /* 머리 체크박스는 **지금 화면에 보이는 것 중 고를 수 있는 것**만 다룬다.
     필터를 걸어 놓고 전체 선택을 눌렀는데 안 보이는 행까지 선택되면, 그 다음 '일괄 삭제'가
     사용자가 보지 못한 것을 지운다. */
  const allOn = selectable.length > 0 && selectable.every((r, i) => selectedSet.has(keyOf(r, i)))
  const someOn = selectable.some((r, i) => selectedSet.has(keyOf(r, i)))
  const toggleAll = () => {
    const visible = selectable.map((r, i) => keyOf(r, i))
    select.onChange(allOn ? (select.ids || []).filter(id => !visible.includes(id))
                          : [...new Set([...(select.ids || []), ...visible])])
  }
  const toggleOne = (id) => {
    const on = selectedSet.has(id)
    select.onChange(on ? (select.ids || []).filter(x => x !== id) : [...(select.ids || []), id])
  }
  const colCount = columns.length + (select ? 1 : 0)

  return (
    <div className="table-scroll">
      <table className="table">
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
            {columns.map((c, i) => {
              const active = sort?.key === c.key
              return (
                <th key={c.key ?? i}
                  className={`${alignClass(c.align)} ${c.headClassName || ''}`.trim()}
                  style={{ width: c.width, cursor: c.sortable ? 'pointer' : undefined }}
                  onClick={() => clickSort(c)}>
                  <span className="dt-th" style={{ justifyContent: c.align === 'right' ? 'flex-end' : c.align === 'center' ? 'center' : 'flex-start' }}>
                    {c.header}
                    {/* data-dir 은 Icon 이 svg로 전달하지 않으므로 감싸는 span 이 지닌다 */}
                    {c.sortable && <span className="dt-sort" data-dir={active ? sort.dir : 'none'}><Icon.Down size={12}/></span>}
                  </span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr><td colSpan={colCount} className="dt-empty">{empty}</td></tr>
          ) : sorted.map((row, i) => {
            const key = keyOf(row, i)
            const expanded = renderExpanded ? renderExpanded(row, i) : null
            const on = selectedSet.has(key)
            const able = select ? canSelect(row) : false
            return (
              <Fragment key={key}>
                <tr onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={onRowClick ? { cursor: 'pointer' } : undefined}
                  className={on ? 'dt-selected' : undefined}>
                  {select && (
                    /* 체크박스 칸에서는 행 클릭(상세 열기)이 일어나면 안 된다 —
                       고르려다 드로어가 열리면 선택이 아니라 방해가 된다. */
                    <td onClick={e => e.stopPropagation()}
                      title={!able ? (select.disabledHint?.(row) || '이 건은 일괄 처리 대상이 아니에요') : undefined}>
                      <input type="checkbox" checked={on} disabled={!able}
                        onChange={() => toggleOne(key)}/>
                    </td>
                  )}
                  {columns.map((c, ci) => (
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
  )
}
