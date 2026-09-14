import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * 문서 목록(견적요청·구매품의·지급결의·정산내역) 공용 — 필터·페이지·더 보기.
 *
 * 네 화면이 같은 load/디바운스/더보기 코드를 한 벌씩 들고 있었다. 필터(기간·거래처·상태)를
 * 붙이려면 네 번 고쳐야 하고, 한 곳만 고쳐지면 화면마다 검색이 다르게 동작한다.
 *
 * ⚠ **늦게 온 응답은 버린다**(seq). 예전엔 디바운스만 있어서 '삼우' 조회가 '삼우열처리'
 *   조회보다 늦게 도착하면 옛 결과가 새 결과를 덮었다 — 검색창과 목록이 다른 말을 한다.
 *
 * @param fetchPage (params) => Promise<{ rows, total, hasMore, ... }>
 *        params = { q, from, to, vendor, status, limit, offset }. 부르는 쪽이 거래처 id 를 덧붙이는 등
 *        가공할 수 있다. 매 렌더 새 함수여도 된다(ref 로 최신 것을 쓴다 — 바뀔 때마다 다시 부르지 않는다).
 * @param initial   필터 초기값(예: { status: 'pending' })
 */
export const EMPTY_DOC_FILTERS = { q: '', from: '', to: '', vendor: '', status: '' }

export function useDocList(fetchPage, { limit = 50, initial = {} } = {}) {
  const [filters, setFilters] = useState({ ...EMPTY_DOC_FILTERS, ...initial })
  const [rows, setRows] = useState([])
  const [page, setPage] = useState(null)        // 마지막 응답(배지용 건수 등)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const seq = useRef(0)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  const load = useCallback(async ({ append = false } = {}) => {
    const my = ++seq.current
    if (append) setLoadingMore(true)
    const offset = append ? rowsRef.current.length : 0
    const res = await fetchRef.current({ ...filtersRef.current, limit, offset })
    if (my !== seq.current) return null            // 그 사이 조건이 바뀌었다 — 옛 결과는 버린다
    const got = res?.rows || []
    setRows(prev => (append ? [...prev, ...got] : got))
    setPage(res || null)
    setLoading(false); setLoadingMore(false)
    return res
  }, [limit])

  // 조건이 바뀌면 다시 부른다. 검색어는 타이핑이 멎을 때까지 기다린다(한 글자마다 조회하지 않는다).
  const lastQ = useRef(filters.q)
  useEffect(() => {
    const typing = lastQ.current !== filters.q
    lastQ.current = filters.q
    const t = setTimeout(() => { load() }, typing ? 300 : 0)
    return () => clearTimeout(t)
  }, [filters, load])

  const setFilter = useCallback((k, v) => setFilters(f => (f[k] === v ? f : { ...f, [k]: v })), [])
  const setPeriod = useCallback(({ from, to }) => setFilters(f => ({ ...f, from: from || '', to: to || '' })), [])
  const resetFilters = useCallback(() => setFilters(f => ({ ...EMPTY_DOC_FILTERS, q: f.q })), [])

  return {
    filters, setFilter, setPeriod, resetFilters,
    rows, setRows, page, loading, loadingMore,
    total: page?.total || 0, hasMore: !!page?.hasMore,
    reload: () => load(), loadMore: () => load({ append: true }),
  }
}
