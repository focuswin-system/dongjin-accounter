import { useState } from 'react'
import { Icon, periodToRange, DateInput } from '../ui'

// 표 상단 툴바 — 날짜 범위 + 검색 + 필터 패널. DataTable 위에 얹는다.
//
// date:    { from, to, onChange({from,to}) }
//          두 날짜 인풋(from~to)이 본체. 프리셋 버튼(이번 달·지난 달…)은 그 값을 채워주는 지름길일 뿐.
//          이 prop 을 안 주면 날짜 컨트롤이 없다(화면마다 '있을지 없을지').
// search:  { value, onChange, placeholder }
// filters: [{ label, node }]  필터 버튼(⚙)을 누르면 열리는 패널의 항목들.
//          항목 라벨(세로) × 임의 컨트롤 node(칩/셀렉트 등, 가로).
// hasActiveFilter: 필터 버튼에 활성 점(•) 표시할지
// onReset: 있으면 패널에 '초기화' 버튼 노출
// right:   툴바 바 우측 끝 추가 노드(옵션)

const DATE_PRESETS = [
  { id: 'month',   label: '이번 달' },
  { id: 'last',    label: '지난 달' },
  { id: 'quarter', label: '이번 분기' },
  { id: 'year',    label: '올해' },
]

export const TableToolbar = ({ date, search, filters, hasActiveFilter, onReset, right }) => {
  const [open, setOpen] = useState(false)
  const hasFilters = filters?.length > 0

  return (
    <div className="tbar">
      <div className="tbar-bar">
        {date && (
          <div className="tbar-date">
            <Icon.Calendar size={14} className="text-muted2"/>
            <DateInput className="input num tbar-dateinput"
              value={date.from || ''} max={date.to || undefined}
              onChange={e => date.onChange({ from: e.target.value, to: date.to })}/>
            <span className="text-muted fw-600">~</span>
            <DateInput className="input num tbar-dateinput"
              value={date.to || ''} min={date.from || undefined}
              onChange={e => date.onChange({ from: date.from, to: e.target.value })}/>
            {/* 지금 걸린 범위와 같은 프리셋은 눌린 상태로 보여준다.
                예전엔 어느 버튼에도 표시가 없어서, **기본값이 '이번 달'인데 필터가 없다고
                믿게 됐다** — 거래내역에 98건 중 4건만 뜨니 "왜 안 나오지"가 된다.
                '전체'도 범위가 비었을 때 눌린 것으로 보여야 짝이 맞는다. */}
            <div className="tbar-presets">
              {DATE_PRESETS.map(p => {
                const r = periodToRange(p.id)
                const on = date.from === r.from && date.to === r.to
                return (
                  <button key={p.id} className={`btn ghost sm${on ? ' active' : ''}`}
                    aria-pressed={on}
                    onClick={() => date.onChange(r)}>{p.label}</button>
                )
              })}
              <button className={`btn ghost sm${!date.from && !date.to ? ' active' : ''}`}
                aria-pressed={!date.from && !date.to}
                onClick={() => date.onChange({ from: '', to: '' })}>전체</button>
            </div>
          </div>
        )}

        <div className="tbar-right">
          {search && (
            <div className="search tbar-search">
              <Icon.Search size={14}/>
              <input value={search.value} onChange={e => search.onChange(e.target.value)} placeholder={search.placeholder || '검색'}/>
            </div>
          )}
          {hasFilters && (
            <button className="btn" style={{ position: 'relative' }} onClick={() => setOpen(o => !o)}>
              <Icon.Filter/> 필터
              {hasActiveFilter && <span className="tbar-dot"/>}
            </button>
          )}
          {right}
        </div>
      </div>

      {open && hasFilters && (
        <div className="tbar-panel">
          {filters.map((f, i) => (
            <div key={i} className="tbar-frow">
              <span className="tbar-flabel">{f.label}</span>
              <div className="tbar-fcontrol">{f.node}</div>
            </div>
          ))}
          {onReset && hasActiveFilter && (
            <div><button className="btn ghost sm" onClick={onReset}><Icon.Close size={12}/> 초기화</button></div>
          )}
        </div>
      )}
    </div>
  )
}
