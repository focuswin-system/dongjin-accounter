import { Icon, Combobox } from '../ui'
import { PeriodPicker } from './PeriodPicker'

/**
 * 문서 목록 필터 — 좌측 목록 위(DocSide top)에 선다. 견적요청·구매품의·지급결의·정산내역이 같이 쓴다.
 *
 *   [검색                         ]
 *   [📅 전체 기간 ▾] [거래처 ▾      ×]
 *   전체 · 작성 2 · 승인 1 · 완료          초기화
 *
 * 기간은 **문서 날짜**(품의일자·지급일·정산일)로 거른다 — 서버 lib/pagedList.js.
 * 거래처·상태는 그 문서에 그 칸이 있을 때만 준다(정산서는 거래처가 줄마다 달라 없다).
 *
 * @param list      useDocList() 가 돌려준 것 (filters·setFilter·setPeriod·resetFilters)
 * @param vendors   [{ id, name }] — 없으면 거래처 칸을 안 그린다
 * @param statuses  [{ id, label, count? }] — 없으면 상태 줄을 안 그린다. id '' 는 전체
 */
export const DocFilters = ({ list, placeholder = '검색', vendors, statuses, children }) => {
  const { filters, setFilter, setPeriod, resetFilters } = list
  const active = !!(filters.from || filters.to || filters.vendor || filters.status)
  return (
    <div className="doc-filters">
      <div className="search" style={{ margin: 0, padding: '6px 10px' }}>
        <Icon.Search size={14}/>
        <input value={filters.q} onChange={e => setFilter('q', e.target.value)} placeholder={placeholder}/>
        {filters.q && (
          <button type="button" className="icon-btn" aria-label="검색어 지우기" onClick={() => setFilter('q', '')}>
            <Icon.Close size={12}/>
          </button>
        )}
      </div>

      <div className="doc-filters-row">
        <PeriodPicker from={filters.from} to={filters.to} onChange={setPeriod}/>
        {vendors && (
          <div className="doc-filters-vendor">
            {/* portal — 목록 카드가 넘침을 자르므로 밖에 띄운다 */}
            <Combobox portal allowAdd={false} value={filters.vendor}
              onChange={v => setFilter('vendor', v || '')}
              options={vendors.map(v => ({ value: v.name, label: v.name }))}
              placeholder="거래처 전체"/>
          </div>
        )}
        {vendors && filters.vendor && (
          <button type="button" className="icon-btn" aria-label="거래처 필터 지우기" title="거래처 필터 지우기"
            onClick={() => setFilter('vendor', '')}><Icon.Close size={12}/></button>
        )}
      </div>

      {(statuses || active) && (
        <div className="doc-filters-row">
          {statuses && (
            <div className="row gap-4" style={{ flexWrap: 'wrap' }}>
              {statuses.map(s => (
                <button key={s.id || 'all'} type="button"
                  className={`chip ${filters.status === s.id ? 'active' : ''}`}
                  onClick={() => setFilter('status', s.id)}>
                  {s.label}
                  {/* 정상엔 표식을 달지 않는다 — 0건이면 숫자도 없다 */}
                  {s.count > 0 && <span className="num doc-filters-count">{s.count}</span>}
                </button>
              ))}
            </div>
          )}
          {active && (
            <button type="button" className="btn ghost sm ml-auto" onClick={resetFilters}>초기화</button>
          )}
        </div>
      )}
      {children}
    </div>
  )
}

/** 승인 흐름 문서(구매품의·지급결의)의 상태 칩. counts = 서버 page.counts */
export const approvalStatuses = (counts = {}) => [
  { id: '', label: '전체' },
  { id: '작성', label: '작성', count: counts['작성'] || 0 },
  { id: '승인', label: '승인', count: counts['승인'] || 0 },
  { id: '완료', label: '완료' },
]

/** 거래처 이름 → id (필터를 서버에 보낼 때). 목록에 없는 이름이면 이름만 보낸다. */
export const vendorParams = (vendors, name) => {
  if (!name) return {}
  const v = (vendors || []).find(x => x.name === name)
  return v ? { vendor: name, vendor_id: v.id } : { vendor: name }
}
