import { useState, useEffect, useMemo } from 'react'
import { Icon, Drawer, fmtNum, Loading } from '../ui'
import { DrawerHead } from './Drawer'

/**
 * 여러 건 골라 담는 서랍 — 문서의 줄을 **장부에서 끌어올 때** 쓴다.
 *
 * SourceChooser 가 "어디서 만들까요"를 묻고, 그 답이 '거래에서'·'품목에서'면 여기로 온다.
 * 결의서는 한 건만 고르면 되지만(지출 하나 = 결의서 하나), 정산내역서·견적요청서는
 * **여러 줄**이 한 장이라 고르는 방식이 다르다.
 *
 * ⚠ 고른 것을 위에 쌓아 보여준다. 스무 줄짜리 목록에서 다섯 개를 고르는 동안
 *   무엇을 골랐는지 안 보이면 같은 것을 두 번 고르거나 빠뜨린다.
 *
 * @param rows     [{ id, ... }] 고를 것들. null 이면 '불러오는 중'
 * @param render   (row) => { title, sub, right } 한 줄을 어떻게 보일지
 * @param onDone   (선택한 rows) => void
 * @param search   (q) => void  검색어가 바뀔 때(서버 검색이면 여기서 다시 부른다). 없으면 화면에서 거른다
 * @param match    (row, q) => boolean  화면에서 거를 때 쓰는 판정
 */
export const PickListDrawer = ({
  open, onClose, title, sub, rows, render, onDone,
  search, match, placeholder = '검색', doneLabel = '가져오기', empty = '고를 것이 없어요.',
}) => {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState([])

  useEffect(() => { if (open) { setQ(''); setPicked([]) } }, [open])

  const shown = useMemo(() => {
    if (!rows) return null
    if (search || !q.trim()) return rows          // 서버가 걸렀거나 검색어가 없다
    return rows.filter(r => (match ? match(r, q.trim()) : true))
  }, [rows, q, search, match])

  const pickedSet = useMemo(() => new Set(picked.map(p => p.id)), [picked])
  const toggle = (row) => setPicked(p =>
    p.some(x => x.id === row.id) ? p.filter(x => x.id !== row.id) : [...p, row])

  const onQ = (v) => { setQ(v); search?.(v) }

  return (
    <Drawer open={open} onClose={onClose} width="min(640px,100vw)" confirmClose={false} label={title}>
      <DrawerHead title={title} sub={sub} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="search" style={{ margin: 0, padding: '6px 10px' }}>
          <Icon.Search size={14}/>
          <input value={q} onChange={e => onQ(e.target.value)} placeholder={placeholder}/>
        </div>

        {/* 고른 것 — 목록 위에 둔다. 아래에 두면 스크롤에 밀려 안 보인다 */}
        {picked.length > 0 && (
          <div className="col gap-6">
            <div className="text-xs text-muted2">고른 것 {picked.length}</div>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {picked.map(p => {
                const r = render(p)
                return (
                  <button key={p.id} type="button" className="chip" onClick={() => toggle(p)}
                    title="빼기">{r.title} <Icon.Close size={11}/></button>
                )
              })}
            </div>
          </div>
        )}

        {shown === null ? <Loading label="불러오는 중…"/>
          : shown.length === 0
            ? <div className="text-sm text-muted" style={{ padding: 24, textAlign: 'center' }}>{empty}</div>
            : <div className="col gap-6">
                {shown.map(row => {
                  const r = render(row)
                  const on = pickedSet.has(row.id)
                  return (
                    <button key={row.id} type="button"
                      className={`card doctype-pick${on ? ' on' : ''}`} onClick={() => toggle(row)}>
                      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                        {/* 고른 것에만 표식. 안 고른 것에 빈 네모를 깔면 목록이 시끄럽다 */}
                        <span className="pick-mark">{on ? <Icon.Check size={13}/> : null}</span>
                        <span style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                          <span className="fw-700" style={{ display: 'block' }}>{r.title}</span>
                          {r.sub && <span className="text-sm text-muted" style={{ display: 'block', marginTop: 2 }}>{r.sub}</span>}
                        </span>
                        {r.right != null && (
                          <span className="num fw-700" style={{ whiteSpace: 'nowrap' }}>
                            {typeof r.right === 'number' ? `${fmtNum(r.right)}원` : r.right}
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>}
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" disabled={!picked.length}
          onClick={() => onDone(picked)}>
          {picked.length ? `${picked.length}건 ${doneLabel}` : doneLabel}
        </button>
      </div>
    </Drawer>
  )
}
