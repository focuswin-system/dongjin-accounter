/**
 * 전자결재 화면 부품 — 구매품의서·지급결의서·정산내역서가 **같은 것을** 쓴다.
 * 규칙(차례·전결·후결·회수)은 전부 서버(lib/approval.js)에 있다. 여기는 보여 주고 누르게 할 뿐이다.
 * 설계: docs/02-design/features/e-approval.design.md
 *
 *   useApprovalOn()       회사가 전자결재를 쓰나(꺼져 있으면 문서 화면은 예전 '승인' 버튼 그대로)
 *   useDocApproval()      문서 하나의 결재 이력(최근 회차 먼저)
 *   <ApprovalButtons/>    문서 머리 버튼 — 결재 올리기 / 승인·반려·전결 / 회수 / 후결 올리기
 *   <ApprovalLine/>       결재선 진행(누가 했고 지금 누구 차례인지)
 *   <ApprovalStamp/>      인쇄 결재란 — 이름·날짜·전결·생략
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { Icon, Drawer, useToast, Combobox, fmtNum } from '../ui'
import { DrawerHead } from './Drawer'
import { api } from '../api'

/* ── 켜짐 여부 — 화면마다 묻지 않게 한 번 받아 두고, 환경설정에서 바꾸면 다시 받는다 ── */
let onCache = null
let onPromise = null
const loadOn = () => {
  if (!onPromise) {
    onPromise = api.getApprovalSettings().then(s => {
      if (!s) { onPromise = null; return null }   // 실패는 기억하지 않는다 — 다음 화면에서 다시 묻는다
      onCache = !!s.enabled
      return onCache
    })
  }
  return onPromise
}
/* 켜짐 여부를 버리고 다시 받는다 — 환경설정에서 바꿀 때, **로그인·로그아웃 때**(App.jsx).
   모듈 변수라 로그아웃해도 남는다: 안 버리면 다른 회사로 들어가도 앞 회사의 켜짐 값을 쓴다 */
export const refreshApprovalOn = () => { onPromise = null; onCache = null; window.dispatchEvent(new Event('approval:changed')) }
if (typeof window !== 'undefined') window.addEventListener('approval:stale', refreshApprovalOn)
/* 결재 동작(상신·승인·반려·전결·회수) 뒤 — 사이드바 배지·종이 바로 다시 센다(App.jsx 가 듣는다).
   화면 이동 때만 세면, 결재함에서 방금 승인했는데 배지는 그대로 '1'이다(실화면에서 봤다) */
export const notifyApprovalActed = () => window.dispatchEvent(new Event('approval:acted'))

export function useApprovalOn() {
  const [on, setOn] = useState(onCache)
  useEffect(() => {
    let alive = true
    const get = () => loadOn().then(v => { if (alive) setOn(v) })
    get()
    window.addEventListener('approval:changed', get)
    return () => { alive = false; window.removeEventListener('approval:changed', get) }
  }, [])
  return on   // null = 아직 모름
}

/* current: undefined = 아직 모름(버튼·결재란을 그리지 않는다), null = 결재 없음.
   모르는 동안 '결재 없음'으로 그리면, 결재 중인 문서에 [결재 올리기]가 잠깐 떴다 바뀐다 */
export function useDocApproval(docType, docId, key) {
  const [list, setList] = useState(null)
  const seq = useRef(0)
  const reload = useCallback(() => {
    const my = ++seq.current
    if (!docId) { setList([]); return }
    // 문서를 바꾸면 앞 문서의 결재를 먼저 지운다 — 늦게 온 앞 문서 응답도 버린다
    setList(l => (l && l.docId === docId ? l : null))
    api.getDocApprovals(docType, docId).then(r => {
      if (my !== seq.current) return
      const next = r || []
      next.docId = docId
      setList(next)
    })
  }, [docType, docId])
  useEffect(() => { reload() }, [reload, key])
  const current = list === null ? undefined : (list[0] || null)
  return { list, current, loading: list === null, reload }
}

/* 지금 로그인한 사람 — 결재선에서 자기 자신을 빼는 데만 쓴다(판정은 서버) */
const myId = () => { try { return JSON.parse(localStorage.getItem('user') || 'null')?.id || null } catch { return null } }

const fmtDate = (s) => (s ? String(s).slice(5, 10).replace('-', '.') : '')

/* 목록 줄에 보일 상태 — 반려되어 돌아온 문서는 '작성'이 아니라 '반려'로(서버가 approval_state 를 얹는다).
   후결이 반려된 문서는 이미 처리됐으므로 문서 상태 대신 '후결 반려'로 눈에 걸리게 한다 */
export const listStatusOf = (d) => {
  if (d?.approval_state === '반려') return d.approval_mode === 'post' ? '후결 반려' : ((d.status || '작성') === '작성' ? '반려' : d.status)
  return d?.status || '작성'
}
const STEP_TONE = { 차례: 'warn', 승인: 'pos', 전결: 'pos', 반려: 'neg' }

/* ── 결재선 진행 ── */
export const ApprovalLine = ({ approval }) => {
  if (!approval) return null
  const steps = approval.steps || []
  return (
    <div className="appr-line">
      <div className="appr-node">
        <div className="text-xs text-muted">기안</div>
        <div className="fw-600">{approval.drafter_name}</div>
        <div className="text-xs text-muted">{fmtDate(approval.submitted_at)}</div>
      </div>
      {steps.map(s => (
        <div key={s.seq} className={`appr-node${s.status === '차례' ? ' is-turn' : ''}${s.status === '생략' ? ' is-skip' : ''}`}>
          <div className="text-xs text-muted">{s.kind === '참조' ? '참조' : (s.label || s.approver_pos || '결재')}</div>
          <div className="fw-600">{s.approver_name}</div>
          <div className="text-xs">
            {STEP_TONE[s.status]
              ? <span className={`badge ${STEP_TONE[s.status]}`}>{s.status === '차례' ? '결재 차례' : s.status}</span>
              : <span className="text-muted">{s.status === '대기' ? '대기' : s.status}</span>}
            {s.acted_at && <span className="text-muted" style={{ marginLeft: 4 }}>{fmtDate(s.acted_at)}</span>}
          </div>
          {s.comment && <div className="text-xs text-muted appr-comment" title={s.comment}>“{s.comment}”</div>}
        </div>
      ))}
    </div>
  )
}

/* ── 인쇄 결재란 ──
 * 결재가 있으면(진행·승인) 칸마다 **이름과 날짜**를 찍는다 — 빈 칸에 손으로 서명하던 것을 대신한다.
 * 전결한 칸은 '전결', 그 뒤 생략된 칸은 사선. 결재가 없으면(전자결재 안 쓰는 회사·옛 문서) 예전 빈 결재란. */
export const ApprovalStamp = ({ approval, legacy }) => {
  const live = approval && ['진행', '승인'].includes(approval.status)
  if (!live) {
    const cols = legacy || []
    return (
      <table className="res-approve">
        <tbody>
          <tr>{cols.map((s, i) => <th key={i}>{s.label}{s.position ? <div style={{ fontWeight: 400, fontSize: 10, color: '#888' }}>{s.position}</div> : null}</th>)}</tr>
          <tr>{cols.map((_, i) => <td key={i}></td>)}</tr>
        </tbody>
      </table>
    )
  }
  const cols = [
    { label: '기안', name: approval.drafter_name, date: approval.submitted_at, status: '승인' },
    ...(approval.steps || []).filter(s => s.kind === '결재').map(s => ({
      label: s.label || s.approver_pos || '결재', name: s.approver_name, date: s.acted_at, status: s.status,
    })),
  ]
  return (
    <table className="res-approve appr-stamp">
      {approval.mode === 'post' && <caption className="appr-stamp-post">후결</caption>}
      <tbody>
        <tr>{cols.map((c, i) => <th key={i}>{c.label}</th>)}</tr>
        <tr>{cols.map((c, i) => (
          <td key={i} className={c.status === '생략' ? 'appr-skip' : ''}>
            {c.status === '생략' ? null : (
              <>
                <div className="appr-stamp-name">{['승인', '전결'].includes(c.status) ? c.name : ''}</div>
                <div className="appr-stamp-date">
                  {c.status === '전결' ? `전결 ${fmtDate(c.date)}` : ['승인'].includes(c.status) ? fmtDate(c.date) : ''}
                </div>
              </>
            )}
          </td>
        ))}</tr>
      </tbody>
    </table>
  )
}

/* ── 문서 머리 버튼 ──
 * status: 문서 상태(작성·결재중·승인·완료). current: 최근 결재(useDocApproval).
 * 이 부품이 그리는 것은 **결재 동작만**이다 — 지출 처리·편집·인쇄 같은 버튼은 화면이 그대로 둔다. */
export const ApprovalButtons = ({ docType, docId, status, current, onChanged, allowPost = true }) => {
  const [submitOpen, setSubmitOpen] = useState(false)
  const [actOpen, setActOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const active = current && current.status === '진행'
  const st = status || '작성'

  const recall = async () => {
    setBusy(true)
    const r = await api.actApproval(current.id, 'recall')
    setBusy(false)
    if (!r.ok) return toast.push(r.error || '회수하지 못했어요', { tone: 'warn' })
    toast.push('결재를 회수했어요. 고쳐서 다시 올릴 수 있어요')
    notifyApprovalActed()
    onChanged?.()
  }

  let body = null
  if (current === undefined) {
    body = null   // 결재 이력을 받는 중
  } else if (active) {
    body = (
      <>
        <span className="text-xs text-muted" style={{ alignSelf: 'center' }}>
          {current.mode === 'post' ? '후결 진행 중' : '결재 중'}{current.turn_name ? ` · ${current.turn_name} 차례` : ''}
        </span>
        {current.can_recall && <button className="btn ghost sm" onClick={recall} disabled={busy}>{busy ? '회수 중…' : '회수'}</button>}
        {current.my_turn && <button className="btn primary" onClick={() => setActOpen(true)}><Icon.Sign size={14}/> 결재하기</button>}
      </>
    )
  } else if (st === '작성') {
    body = <button className="btn primary" onClick={() => setSubmitOpen(true)}><Icon.Sign size={14}/> 결재 올리기</button>
  } else if (allowPost && (st === '승인' || st === '완료') && !(current && current.status === '승인')) {
    // 결재 없이 승인·처리된 문서(이미 나간 돈에 붙인 결의서 등) — 결재는 뒤따라 받는다(후결)
    body = <button className="btn ghost sm" onClick={() => setSubmitOpen(true)} title="이미 처리된 문서에 결재를 뒤따라 받아요">후결 올리기</button>
  }

  return (
    <>
      {body}
      <SubmitApprovalDrawer open={submitOpen} onClose={() => setSubmitOpen(false)}
        docType={docType} docId={docId} forcePost={st === '승인' || st === '완료'} allowPost={allowPost}
        onDone={() => { setSubmitOpen(false); onChanged?.() }}/>
      <ActApprovalDrawer approvalId={actOpen ? current?.id : null} onClose={() => setActOpen(false)}
        onDone={() => { setActOpen(false); onChanged?.() }}/>
    </>
  )
}

/* 반려되어 돌아온 문서 — 사유를 머리에 띄운다(기안자가 무엇을 고칠지 알게) */
export const RejectedNote = ({ current, status }) => {
  if (!current || current.status !== '반려') return null
  const who = (current.steps || []).find(s => s.status === '반려')
  const post = current.mode === 'post'
  if (!post && (status || '작성') !== '작성') return null
  return (
    <div className="card card-pad no-print" style={{ marginBottom: 12, background: 'var(--neg-soft)', color: 'var(--neg-ink)' }}>
      <b>{post ? '후결이 반려됐어요' : '반려된 문서예요'}</b>
      {who && <> — {who.approver_name}: “{who.comment}”</>}
      {post && <div className="text-sm" style={{ marginTop: 4 }}>이미 처리된 문서예요. 지출을 되돌릴지 판단해 주세요.</div>}
    </div>
  )
}

/* ── 결재 올리기 ── */
export const SubmitApprovalDrawer = ({ open, onClose, docType, docId, forcePost, onDone, allowPost = true }) => {
  const toast = useToast()
  const [people, setPeople] = useState([])
  const [presets, setPresets] = useState([])
  const [steps, setSteps] = useState([])
  const [post, setPost] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setPost(!!forcePost); setReason(forcePost ? '이미 처리된 문서' : '')
    Promise.all([api.getApprovers(), api.getApprovalPresets()]).then(([ps, pr]) => {
      // 기안자 자신은 결재선에 못 든다(서버도 막는다) — 고를 수 있게 두면 올릴 때 400 으로 돌아온다
      const me = myId()
      ps = (ps || []).filter(u => u.id !== me)
      setPeople(ps)
      setPresets(pr || [])
      const def = (pr || []).find(p => Number(p.is_default)) || (pr || [])[0]
      setSteps(def ? stepsFromPreset(def, ps || []) : [{ label: '', user_id: '', kind: '결재' }])
    })
  }, [open, forcePost])

  const stepsFromPreset = (p, ps) => {
    let raw = p.steps
    if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = [] } }
    /* 프리셋의 첫 칸이 '담당'(기안자 자리)이면 뺀다 — 기안자는 결재선에 들어가지 않고 결재란 첫 칸에 따로 찍힌다 */
    const list = (raw || []).filter((s, i) => !(i === 0 && /담당|기안/.test(s.label || '') && !s.user_id))
    return list.map(s => ({
      label: s.label || '', kind: s.kind === '참조' ? '참조' : '결재',
      user_id: ps.some(u => u.id === s.user_id) ? s.user_id : '',
    }))
  }

  const setStep = (i, k, v) => setSteps(list => list.map((s, j) => (j === i ? { ...s, [k]: v } : s)))
  const move = (i, d) => setSteps(list => {
    const j = i + d; if (j < 0 || j >= list.length) return list
    const next = [...list]; [next[i], next[j]] = [next[j], next[i]]; return next
  })
  const personOpts = people.map(u => ({ value: u.id, label: u.name, sub: [u.position, u.department].filter(Boolean).join(' · ') }))

  const submit = async () => {
    setBusy(true)
    const r = await api.submitApproval({
      doc_type: docType, doc_id: docId, mode: post ? 'post' : 'normal', reason: post ? reason : '',
      steps: steps.map(s => ({ user_id: s.user_id, label: s.label, kind: s.kind })),
    })
    setBusy(false)
    if (!r.ok) return toast.push(r.error || '올리지 못했어요', { tone: 'warn' })
    toast.push(r.mode === 'post' ? '후결로 올렸어요. 지금 처리할 수 있어요' : '결재를 올렸어요')
    notifyApprovalActed()
    onDone?.()
  }

  const ready = steps.length && steps.every(s => s.user_id) && steps.some(s => s.kind === '결재') && (!post || reason.trim())

  return (
    <Drawer open={open} onClose={onClose} width="min(560px, 100vw)" confirmClose={false}>
      <DrawerHead onClose={onClose} title={forcePost ? '후결 올리기' : '결재 올리기'} sub="결재선 순서대로 차례가 넘어가요"/>
      <div className="drawer-body col gap-form">
        {presets.length > 0 && (
          <div className="row gap-6" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="text-xs text-muted">결재선</span>
            {presets.map(p => <button key={p.id} className="btn ghost sm" onClick={() => setSteps(stepsFromPreset(p, people))}>{p.name}</button>)}
          </div>
        )}
        <div className="col gap-8">
          {steps.map((s, i) => (
            <div key={i} className="row gap-6" style={{ alignItems: 'center' }}>
              <span className="text-xs text-muted num" style={{ width: 16 }}>{i + 1}</span>
              <input className="input" style={{ width: 84 }} placeholder="예: 이사" value={s.label}
                onChange={e => setStep(i, 'label', e.target.value)}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Combobox value={s.user_id} onChange={v => setStep(i, 'user_id', v)} options={personOpts}
                  placeholder="결재자 선택" allowAdd={false} portal/>
              </div>
              <div className="seg" role="tablist">
                {['결재', '참조'].map(k => (
                  <button key={k} aria-pressed={s.kind === k} className={`seg-btn ${s.kind === k ? 'active' : ''}`} onClick={() => setStep(i, 'kind', k)}>{k}</button>
                ))}
              </div>
              <button className="icon-btn" title="위로" onClick={() => move(i, -1)}><Icon.Up size={14}/></button>
              <button className="icon-btn" title="아래로" onClick={() => move(i, 1)}><Icon.Down size={14}/></button>
              <button className="icon-btn" title="빼기" onClick={() => setSteps(list => list.filter((_, j) => j !== i))}><Icon.Close size={14}/></button>
            </div>
          ))}
          <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }}
            onClick={() => setSteps(list => [...list, { label: '', user_id: '', kind: '결재' }])}>
            <Icon.Plus size={14}/> 결재자 추가
          </button>
        </div>
        {/* 정산내역서처럼 내보낼 돈이 없는 문서는 '먼저 처리'할 게 없다 — 후결을 내지 않는다 */}
        {allowPost && (
          <label className="row gap-8" style={{ alignItems: 'center', cursor: forcePost ? 'default' : 'pointer' }}>
            <input type="checkbox" checked={post} disabled={forcePost} onChange={e => setPost(e.target.checked)}/>
            <span>긴급 — 먼저 처리하고 결재는 뒤에 받기(후결)</span>
          </label>
        )}
        {post && (
          <textarea className="input" rows={2} placeholder="예: 자재 입고가 급해 먼저 지급" value={reason}
            onChange={e => setReason(e.target.value)}/>
        )}
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" disabled={!ready || busy} onClick={submit}>
          <Icon.Sign size={14}/> {busy ? '올리는 중…' : '올리기'}
        </button>
      </div>
    </Drawer>
  )
}

/* ── 결재하기(승인·전결·반려) ── */
export const ActApprovalDrawer = ({ approvalId, onClose, onDone, onOpenDoc }) => {
  const toast = useToast()
  const [a, setA] = useState(null)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  // 전결은 뒤 결재자를 모두 건너뛴다 — 한 번 더 눌러야 된다(승인 옆이라 잘못 누르기 쉽다)
  const [armFinal, setArmFinal] = useState(false)
  useEffect(() => {
    if (!approvalId) return
    setA(null); setComment(''); setArmFinal(false)
    api.getApproval(approvalId).then(setA).catch(e => toast.push(e.message, { tone: 'warn' }))
  }, [approvalId])   // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (action) => {
    if (action === 'reject' && !comment.trim()) return toast.push('반려 사유를 적어 주세요', { tone: 'warn' })
    if (action === 'final' && !armFinal) return setArmFinal(true)
    setBusy(true)
    const r = await api.actApproval(approvalId, action, comment)
    setBusy(false)
    if (!r.ok) return toast.push(r.error || '처리하지 못했어요', { tone: 'warn' })
    toast.push(action === 'reject' ? '반려했어요' : action === 'final' ? '전결했어요' : r.status === '승인' ? '결재가 끝났어요' : '승인했어요')
    notifyApprovalActed()
    onDone?.()
  }

  return (
    <Drawer open={!!approvalId} onClose={onClose} width="min(620px, 100vw)" confirmClose={false}>
      <DrawerHead onClose={onClose} title="결재하기" sub={a ? `${a.doc_label} · ${a.title || ''}` : ''}/>
      <div className="drawer-body col gap-form">
        {a && (
          <>
            {/* 무엇에 도장을 찍는지 — 금액과 원문으로 가는 길 */}
            <div className="row gap-8" style={{ alignItems: 'center' }}>
              {a.amount != null && <span className="text-sm">금액 <b className="num">{fmtNum(a.amount)}원</b></span>}
              {onOpenDoc && a.doc_route && (
                <button className="btn ghost sm ml-auto" onClick={() => onOpenDoc(a)}><Icon.Doc size={14}/> 문서 열기</button>
              )}
            </div>
            {a.mode === 'post' && (
              <div className="card card-pad" style={{ background: 'var(--warn-soft)', color: 'var(--warn-ink)' }}>
                <b>후결</b> — 이미 처리된 문서예요. 사유: {a.reason}
              </div>
            )}
            <ApprovalLine approval={a}/>
            <textarea className="input" rows={3} placeholder="의견(반려할 때는 꼭 적어 주세요)" value={comment}
              onChange={e => setComment(e.target.value)}/>
          </>
        )}
      </div>
      <div className="drawer-foot">
        <button className="btn" disabled={busy || !a?.my_turn} onClick={() => act('reject')} style={{ color: 'var(--neg-ink)' }}>반려</button>
        <button className={`btn ml-auto${armFinal ? ' primary' : ''}`} disabled={busy || !a?.my_turn} onClick={() => act('final')}
          title="뒤 결재자를 거치지 않고 여기서 결재를 끝내요">{armFinal ? '한 번 더 누르면 전결' : '전결'}</button>
        <button className="btn primary" disabled={busy || !a?.my_turn} onClick={() => act('approve')}>
          <Icon.Check size={14}/> 승인
        </button>
      </div>
    </Drawer>
  )
}
