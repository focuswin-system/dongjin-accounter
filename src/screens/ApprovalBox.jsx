/**
 * 결재함 — 나에게 온 결재와 내가 올린 결재. 설계: docs/02-design/features/e-approval.design.md §6
 *
 *   결재할 문서  지금 내 차례(여기서 바로 승인·반려·전결)
 *   올린 문서    내가 기안한 것 — 진행·반려·회수. 반려된 것은 사유가 보인다
 *   결재한 문서  내가 승인·전결·반려한 것
 *   참조         참조로 받은 것
 *
 * 목록은 **자기 것만** 서버가 거른다(routes/approvals.js). 그래서 모든 계정에 열린 메뉴다.
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import { Icon, fmtNum, Drawer, useToast } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DataTable, Sub } from '../lib/components/DataTable'
import { DrawerHead } from '../lib/components/Drawer'
import { api } from '../lib/api'
import { ApprovalLine, ActApprovalDrawer, notifyApprovalActed } from '../lib/components/Approval'

const BOXES = [
  ['todo', '결재할 문서'],
  ['mine', '올린 문서'],
  ['done', '결재한 문서'],
  ['ref', '참조'],
]

const STATUS_TONE = { 반려: 'neg', 회수: 'outline', 취소: 'outline' }

/* 한 줄의 상태 글 — 진행이면 '누구 차례', 끝났으면 결과 */
const stateText = (a) => {
  if (a.status === '진행') return a.turn_name ? `${a.turn_name} 차례` : '진행 중'
  if (a.status === '취소') return '효력 없음'
  return a.status
}

export const ApprovalBoxScreen = ({ go }) => {
  const [box, setBox] = useState('todo')
  const [rows, setRows] = useState(null)
  const [counts, setCounts] = useState({ todo: 0, rejected: 0 })
  const [actId, setActId] = useState(null)
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [recalling, setRecalling] = useState(false)
  const seq = useRef(0)
  const toast = useToast()

  /* 탭을 빨리 바꾸면 앞 탭 응답이 늦게 와 뒤 탭을 덮는다 — 마지막 요청 것만 받는다.
     실패는 '없어요'와 다르게 보인다(빈 결재함으로 읽으면 결재를 놓친다) */
  const load = () => {
    const my = ++seq.current
    setRows(null); setError('')
    api.getApprovalBox(box)
      .then(r => { if (my === seq.current) setRows(r) })
      .catch(e => { if (my === seq.current) { setRows([]); setError(e.message || '결재함을 불러오지 못했어요') } })
    api.getApprovalCounts().then(setCounts).catch(() => {})
  }
  useEffect(load, [box])   // eslint-disable-line react-hooks/exhaustive-deps

  const columns = useMemo(() => [
    { key: 'doc_label', header: '문서', width: 96 },
    { key: 'title', header: '제목', maxWidth: 420, render: a => (
      <>
        {a.mode === 'post' && <span className="badge warn" style={{ marginRight: 6 }}>후결</span>}
        {a.title || '—'}
        {a.mode === 'post' && <Sub>{a.reason}</Sub>}
      </>
    ) },
    { key: 'amount', header: '금액', width: 120, align: 'right',
      render: a => (a.amount == null ? '—' : <span className="num">{fmtNum(a.amount)}</span>) },
    // 올린 문서함에서는 기안자가 늘 나라서 칸을 뺀다(아래 filter)
    { key: 'drafter', header: '기안', width: 140, render: a => (
      <>{a.drafter_name}<Sub>{a.drafter_pos}</Sub></>
    ) },
    { key: 'submitted_at', header: '올린 날', width: 112, sortable: true,
      render: a => <span className="num" style={{ whiteSpace: 'nowrap' }}>{String(a.submitted_at || '').slice(0, 10)}</span> },
    { key: 'status', header: '상태', width: 120, render: a => (STATUS_TONE[a.status]
      ? <span className={`badge ${STATUS_TONE[a.status]}`}>{stateText(a)}</span>
      : <span className="text-sm">{stateText(a)}</span>) },
  ].filter(c => !(box === 'mine' && c.key === 'drafter')), [box])

  const openDoc = (a) => {
    setView(null)
    if (a.doc_route) go?.(a.doc_route, { docId: a.doc_id })
  }

  return (
    <div className="fade-up">
      <PageHeader title="결재함" sub="나에게 온 결재와 내가 올린 결재"
        actions={<button className="btn" onClick={load}><Icon.Refresh size={14}/> 새로고침</button>}/>

      <div className="card">
        <div className="row gap-8" style={{ padding: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="seg" role="tablist" aria-label="결재함">
            {BOXES.map(([k, l]) => (
              <button key={k} role="tab" aria-selected={box === k}
                className={`seg-btn ${box === k ? 'active' : ''}`} onClick={() => setBox(k)}>
                {l}
                {k === 'todo' && counts.todo > 0 && <span className="seg-count">{counts.todo}</span>}
                {/* 숫자만 두면 '올린 문서 전체 수'로 읽힌다 — 반려된 것이라고 적는다 */}
                {k === 'mine' && counts.rejected > 0 && <span className="seg-count" style={box === 'mine' ? undefined : { color: 'var(--neg-ink)' }}>반려 {counts.rejected}</span>}
              </button>
            ))}
          </div>
        </div>
        <DataTable tableKey={`approval_${box}`} columns={columns} rows={rows || []} rowKey={a => a.id}
          loading={!rows} onRowClick={a => (a.my_turn ? setActId(a.id) : setView(a))}
          empty={error || (box === 'todo' ? '결재할 문서가 없어요' : '없어요')}/>
      </div>

      <ActApprovalDrawer approvalId={actId} onClose={() => setActId(null)}
        onOpenDoc={(a) => { setActId(null); openDoc(a) }}
        onDone={() => { setActId(null); load() }}/>

      <Drawer open={!!view} onClose={() => setView(null)} width="min(620px, 100vw)" confirmClose={false}>
        {view && (
          <>
            <DrawerHead onClose={() => setView(null)} title={view.title || view.doc_label}
              sub={`${view.doc_label} · ${view.round}회차 · ${stateText(view)}`}/>
            <div className="drawer-body col gap-form">
              {view.mode === 'post' && (
                <div className="card card-pad" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
                  <b>후결</b> — {view.reason}
                </div>
              )}
              <ApprovalLine approval={view}/>
            </div>
            <div className="drawer-foot">
              {view.can_recall && (
                <button className="btn" disabled={recalling} onClick={async () => {
                  setRecalling(true)
                  const r = await api.actApproval(view.id, 'recall')
                  setRecalling(false)
                  if (!r.ok) return toast.push(r.error || '회수하지 못했어요', { tone: 'warn' })
                  toast.push('결재를 회수했어요')
                  setView(null); load(); notifyApprovalActed()
                }}>{recalling ? '회수 중…' : '회수'}</button>
              )}
              <button className="btn primary ml-auto" onClick={() => openDoc(view)}><Icon.Doc size={14}/> 문서 열기</button>
            </div>
          </>
        )}
      </Drawer>
    </div>
  )
}
