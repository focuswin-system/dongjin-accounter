import { useState, useMemo } from 'react'
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
export const DataTable = ({ columns, rows, onRowClick, empty = '표시할 내용이 없어요', footer, rowKey }) => {
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

  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
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
            <tr><td colSpan={columns.length} className="dt-empty">{empty}</td></tr>
          ) : sorted.map((row, i) => (
            <tr key={rowKey ? rowKey(row) : (row.id ?? i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={onRowClick ? { cursor: 'pointer' } : undefined}>
              {columns.map((c, ci) => (
                <td key={c.key ?? ci} className={`${alignClass(c.align)} ${c.className || ''}`.trim()}>
                  {c.render ? c.render(row, i) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  )
}
