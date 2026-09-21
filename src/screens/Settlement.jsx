import { useState, useEffect, useRef } from 'react'
import { Icon, fmtNum, useToast, useConfirm, localToday, DateInput } from '../lib/ui'
import { api } from '../lib/api'
import { PageHeader } from '../lib/components/PageHeader'
import { DocWorkspace, DocSide, DocListRow, DocSideEmpty, DocMain, DocToolbar, DocViewport, DocEmpty } from '../lib/components/DocWorkspace'
import { SourceChooser } from '../lib/components/SourceChooser'
import { PickListDrawer } from '../lib/components/PickListDrawer'
import { DocFilters } from '../lib/components/DocFilters'
import { useDocList } from '../lib/useDocList'
import { makeGridKeyHandler } from '../lib/gridKeys'
import { CellIn } from '../lib/components/CellIn'

// 定算內譯書 — 항목은 고정 분류(도로비·교통비…) 없이 쓰는 사람이 필요한 줄만 추가한다.
// 옛 양식의 좌측 고정 슬롯·출장 항번호(①②③…) 주석은 2026-08 고객 요청으로 걷어냈다.
const numOf = (v) => (typeof v === 'string' ? parseInt(v.replace(/[^0-9-]/g, ''), 10) || 0 : Number(v) || 0)
const emptyLine = () => ({ title: '', amount: '', memo: '' })


// ── 정산내역서 미리보기 + 인라인 편집(지급결의서처럼 양식 내에서 바로 편집) ──
const SettlementPreview = ({ doc, company, isNew, onSaved, onCancelNew, onDeleted }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [edit, setEdit] = useState(!!isNew)
  const emptyForm = () => ({ settler: '', settle_date: localToday(), purpose: '', received_amount: '', note: '', lines: [], approval: [] })
  const [form, setForm] = useState(emptyForm())
  const [presets, setPresets] = useState([])

  // 조회 화면(인쇄 포함)도 상단 머리글은 form 에서 읽는다 → 편집을 취소하면 반드시 여기로 되돌려야
  // 저장하지 않은 값이 그대로 인쇄된다. 그래서 doc → form 변환을 한 곳에 둔다.
  const formFromDoc = (d) => ({
    settler: d.settler || '', settle_date: d.settle_date || localToday(),
    purpose: d.purpose || '',
    received_amount: d.received_amount ? String(d.received_amount) : '', note: d.note || '',
    // category 는 화면에서 사라진 옛 분류(도로비·교통비…)다. 안 들고 있으면 옛 문서를 한 번
    // 저장하는 것만으로 전부 '기타경비'로 뭉개진다 → 손대지 않고 그대로 되돌려 보낸다.
    lines: (d.lines || []).map(l => ({ title: l.title || '', amount: String(l.amount || ''), memo: l.memo || '', category: l.category || '',
      source_type: l.source_type || '', source_id: l.source_id || '' })),
    approval: (d.approval && d.approval.length) ? d.approval : [],
  })

  useEffect(() => { api.getApprovalPresets().then(setPresets) }, [])
  useEffect(() => {
    setEdit(!!isNew)
    setForm(doc ? formFromDoc(doc) : emptyForm())
  }, [doc?.id, isNew])

  const setH = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setLine = (i, field, v) => setForm(f => {
    const lines = [...f.lines]
    if (i === lines.length) lines.push(emptyLine())   // ghost 행에 입력 → 새 줄
    lines[i] = { ...lines[i], [field]: v }
    return { ...f, lines }
  })
  const addLine = () => setForm(f => ({ ...f, lines: [...f.lines, emptyLine()] }))
  const gridKeys = makeGridKeyHandler(addLine)
  const delLine = (i) => setForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))

  const total = edit
    ? form.lines.reduce((s, l) => s + numOf(l.amount), 0)
    : (doc?.lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const received = edit ? numOf(form.received_amount) : (Number(doc?.received_amount) || 0)
  const balance = received - total
  const ceo = company?.ceo || '대표이사'
  const defApproval = [{ label: '담당' }, { label: '결재' }, { label: '대표이사', position: ceo }]
  const approval = edit
    ? (form.approval && form.approval.length ? form.approval : defApproval)
    : (doc?.approval && doc.approval.length ? doc.approval : defApproval)
  const applyPreset = (p) => setForm(f => ({ ...f, approval: (p.steps || []).map(s => ({ label: s.label, position: s.position || '', name: '' })) }))

  // 표시할 줄 — 편집 중이면 입력한 줄 + 맨 끝 ghost 행, 아니면 저장된 라인 그대로
  const rows = edit ? [...form.lines, emptyLine()] : (doc?.lines || [])

  const save = async () => {
    const lines = []
    for (const l of form.lines) {
      if ((l.title || '').trim() || numOf(l.amount)) {
        // category 는 옛 문서에서 읽어온 값만 되돌려 보낸다(새 줄은 서버 기본값).
        lines.push({ title: (l.title || '').trim(), amount: numOf(l.amount), memo: (l.memo || '').trim(), ...(l.category ? { category: l.category } : {}),
          // 어디서 가져온 줄인지(거래·결의서·품의) — 같은 돈이 다른 정산서에 또 들어가는 걸 막는 근거
          ...(l.source_type && l.source_id ? { source_type: l.source_type, source_id: l.source_id } : {}) })
      }
    }
    if (!lines.length) return toast.push('지출 항목을 하나 이상 입력해주세요')
    const chosen = presets.find(p => p.is_default) || presets[0]
    const payload = {
      settler: form.settler.trim(), settle_date: form.settle_date || null,
      purpose: form.purpose.trim(),
      received_amount: numOf(form.received_amount), note: form.note.trim(), lines,
      approval: (form.approval && form.approval.length) ? form.approval
        : (chosen ? chosen.steps.map(s => ({ label: s.label, position: s.position || '', name: '' })) : undefined),
    }
    const res = isNew ? await api.createSettlement(payload) : await api.updateSettlement(doc.id, payload)
    if (!res.ok) return toast.push(res.error || '저장에 실패했어요', { tone: 'warn' })
    toast.push(isNew ? `정산내역서 ${res.settlement?.doc_no || ''}를 만들었어요` : '저장됐어요')
    setEdit(false)
    onSaved(isNew ? res.settlement?.id : doc.id)
  }
  const cancel = () => {
    if (isNew) return onCancelNew()
    setForm(doc ? formFromDoc(doc) : emptyForm())   // 되돌리지 않으면 취소한 값이 조회·인쇄에 남는다
    setEdit(false)
  }
  const remove = async () => {
    const ok = await confirm({ tone: 'neg', icon: <Icon.Warn size={22}/>, title: `${doc.doc_no} 삭제`, body: '이 정산내역서를 삭제할까요? 복구할 수 없어요.', confirmLabel: '삭제' })
    if (!ok) return
    const res = await api.deleteSettlement(doc.id)
    if (!res.ok) return toast.push(res.error || '삭제에 실패했어요', { tone: 'warn' })
    toast.push('삭제됐어요'); onDeleted()
  }

  const amt = (n) => (n ? fmtNum(n) : '')

  return (
    <>
      <DocToolbar docNo={isNew ? '새 정산내역서' : doc.doc_no}
        status={!isNew && <span className="text-sm text-muted">잔액 <b className="num" style={{ color: balance < 0 ? 'var(--neg-ink)' : 'var(--brand-ink)' }}>{fmtNum(balance)}원</b></span>}>
        {edit ? (
          <>
            <button className="btn" onClick={cancel}>취소</button>
            <button className="btn primary" onClick={save}><Icon.Check size={14}/> 저장</button>
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={remove} title="삭제" aria-label="삭제"><Icon.Trash size={14}/></button>
            <button className="btn" onClick={() => setEdit(true)}><Icon.Pencil size={14}/> 편집</button>
            <button className="btn" onClick={() => window.print()}><Icon.Print/> 인쇄</button>
          </>
        )}
      </DocToolbar>

      <DocViewport portrait>
        <div className="doc-paper resolution-paper resolution-print settle-paper" id="resolution-print">
          <div className="res-title-ko">정산내역서</div>
          <div className="res-title">定 算 內 譯 書</div>
          <div className="res-date num">{form.settle_date || ''}</div>
          <div className="res-note-line">아래 내역과 같이 經費 使用 部分에 대하여 定算코자 하오니 決裁하여 주시기 바랍니다.</div>

          <table className="res-table res-head">
            <tbody>
              <tr>
                <th>정산자</th><td colSpan={2}>{edit ? <CellIn value={form.settler} onChange={v => setH('settler', v)}/> : form.settler}</td>
                <th>정산일</th><td colSpan={2}>{edit ? <DateInput className="settle-cellin" value={form.settle_date || ''} onChange={e => setH('settle_date', e.target.value)}/> : (form.settle_date || '')}</td>
              </tr>
              <tr>
                <th>제　목</th><td colSpan={5} className="settle-subject">{edit ? <CellIn value={form.purpose} onChange={v => setH('purpose', v)} placeholder="예: 7월 세금납부·자재대 정산"/> : form.purpose}</td>
              </tr>
              <tr>
                <th>수령액</th><td className="num fw-700">{edit ? <CellIn value={form.received_amount} onChange={v => setH('received_amount', v)} money allowNegative/> : amt(received)}</td>
                <th>지출총액</th><td className="num">{amt(total)}</td>
                <th>잔　액</th><td className="num fw-700" style={{ color: balance < 0 ? 'var(--neg-ink)' : undefined }}>{amt(balance)}</td>
              </tr>
            </tbody>
          </table>

          {/* 키보드로 다닌다 — 구매품의서·견적요청서와 같은 규칙(lib/gridKeys.js) */}
          {edit && <div className="text-xs text-muted2 kbd-hint no-print" style={{ margin: '2px 0 4px' }}>
            <span className="kbd">Enter</span> 아래 줄 · <span className="kbd">Tab</span> 옆 칸 · 마지막 줄에서 Enter 면 줄이 하나 더 생겨요
          </div>}
          <table className="res-table settle-grid" onKeyDown={gridKeys}>
            <colgroup>
              <col/><col style={{ width: 160 }}/>{edit ? <col style={{ width: 34 }}/> : null}
            </colgroup>
            <thead>
              <tr><th>항　목</th><th>지출액</th>{edit ? <th className="settle-rowact no-print"/> : null}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const ghost = edit && i === form.lines.length
                return (
                  <tr key={i}>
                    <td>
                      {edit
                        ? <CellIn value={r.title || ''} onChange={v => setLine(i, 'title', v)} placeholder={ghost ? '+ 여기에 입력하면 줄이 생겨요' : ''}/>
                        : <>{r.title}{r.memo ? <span className="settle-memo"> · {r.memo}</span> : null}</>}
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {edit
                        ? <CellIn value={r.amount || ''} onChange={v => setLine(i, 'amount', v)} money allowNegative/>
                        : fmtNum(r.amount)}
                    </td>
                    {edit ? (
                      <td className="settle-rowact no-print">
                        {!ghost && <button className="settle-del" onClick={() => delLine(i)} title="줄 삭제"><Icon.Close size={12}/></button>}
                      </td>
                    ) : null}
                  </tr>
                )
              })}
              {!edit && rows.length === 0 && (
                <tr className="no-print"><td colSpan={2} style={{ textAlign: 'center', color: '#999' }}>항목이 없어요</td></tr>
              )}
            </tbody>
          </table>
          {edit && (
            <div className="no-print" style={{ marginTop: 6 }}>
              <button className="btn ghost sm" onClick={addLine}><Icon.Plus size={13}/> 줄 추가</button>
            </div>
          )}

          {edit && presets.length > 0 && (
            <div className="no-print row gap-6" style={{ margin: '10px 0 4px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="text-xs text-muted2">결재선</span>
              {presets.map(p => (
                <button key={p.id} className="btn ghost sm" onClick={() => applyPreset(p)}>{p.name}</button>
              ))}
            </div>
          )}
          {/* 하단 특기사항·결재 — 지급결의서와 동일한 res-foot(컴팩트 결재표) */}
          <div className="res-foot">
            <div className="res-note">
              <div className="res-note-head">특기사항</div>
              <div className="res-note-body">{edit ? <input className="settle-cellin" value={form.note} onChange={e => setH('note', e.target.value)} placeholder="예: 우리.090-044469-13-301 계좌인출 후 송금"/> : form.note}</div>
            </div>
            <table className="res-approve">
              <tbody>
                <tr>{approval.map((s, i) => <th key={i}>{s.label}{s.position ? <div style={{ fontWeight: 400, fontSize: 10, color: '#888' }}>{s.position}</div> : null}</th>)}</tr>
                <tr>{approval.map((_, i) => <td key={i}></td>)}</tr>
              </tbody>
            </table>
          </div>

          <div className="res-company num">{company?.name || ''}</div>
        </div>
      </DocViewport>
    </>
  )
}

// ── 화면 ─────────────────────────────────────────────────────────
/* 정산내역서를 어디서 만들까 — 이 문서는 **쓴 돈을 항목별로 정리해 넘기는** 것이라
   줄이 여럿이다. 그 줄이 이미 거래내역에 있는데 손으로 옮겨 적고 있었다. */
const SETTLE_SOURCES = [
  {
    id: 'txn', icon: Icon.Bank,
    label: '거래내역에서 골라서',
    desc: '이미 기록한 지출을 여러 건 가져와요',
    effect: '고른 지출이 항목 줄로 채워져요. 금액·날짜·거래처가 그대로 와요.',
  },
  {
    id: 'doc', icon: Icon.Sign,
    label: '구매품의·지급결의에서 가져와서',
    desc: '이미 만든 구매품의서·지급결의서를 여러 건 가져와요',
    effect: '고른 문서가 항목 줄로 채워지고, 출처(GM-…/DJ-…)가 비고에 남아요.',
  },
  {
    id: 'blank', icon: Icon.Pencil,
    label: '직접 작성',
    desc: '빈 양식에서 시작해요',
    effect: '항목을 하나씩 적어요.',
  },
]

export const SettlementScreen = ({ focusId = null }) => {
  const toast = useToast()
  const [srcOpen, setSrcOpen] = useState(false)
  const [pickOpen, setPickOpen] = useState(false)
  const [txns, setTxns] = useState(null)
  const [docPickOpen, setDocPickOpen] = useState(false)   // 품의·결의에서 불러오기
  const [pickDocs, setPickDocs] = useState(null)
  const [hiddenUsed, setHiddenUsed] = useState(0)          // 이미 정산서에 들어가 뺀 건수
  /* 새 문서에 미리 채워 넣을 줄. blankDoc 이 상수라 여기에 담아 둔다 —
     creating 이 false→true 로 갈 때 미리보기가 새로 마운트되면서 이 값을 읽는다. */
  const [seed, setSeed] = useState([])
  const [company, setCompany] = useState(null)
  const [selId, setSelId] = useState(focusId)
  const [sel, setSel] = useState(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => { api.getCompany().then(setCompany) }, [])

  // 목록 — 서버에서 50건씩. 정산서는 거래처가 줄마다 달라 기간·검색만 건다(lib/useDocList.js)
  const list = useDocList((p) => api.getSettlementsPage(p))

  /* 선택은 지금 목록에 보이는 것 중에서 지킨다. 다른 화면에서 넘어온 문서(focusId)와
     방금 저장한 문서는 목록에서 빠져도 연 채로 둔다. */
  const pinned = useRef(focusId)
  useEffect(() => { if (focusId) { pinned.current = focusId; setCreating(false); setSelId(focusId) } }, [focusId])
  useEffect(() => {
    if (list.loading) return
    setSelId(prev => (prev && (prev === pinned.current || list.rows.some(r => r.id === prev))) ? prev : (list.rows[0]?.id || null))
  }, [list.rows, list.loading])
  // 늦게 온 응답은 버린다 — 줄을 빠르게 옮겨 누르면 목록에 칠해진 줄과 열린 문서가 달라진다
  const selSeq = useRef(0)
  const loadSel = (id) => { const my = ++selSeq.current; if (!id) { setSel(null); return } api.getSettlement(id).then(d => { if (my === selSeq.current) setSel(d) }) }
  useEffect(() => { if (!creating) loadSel(selId) }, [selId, creating])
  const refresh = (id) => {
    const target = id || selId
    pinned.current = target
    if (id) setSelId(id)
    list.reload(); loadSel(target)
  }

  const blankDoc = { id: '__new', settle_date: localToday(), lines: seed, approval: [] }

  /* ── 같은 돈을 두 번 넣지 않는다 ──
     한 지출이 여러 얼굴로 온다: 거래 그 자체, 그 거래를 처리한 결의서, 그 결의서가 넘겨받은 품의.
     각 후보가 가리키는 돈의 열쇠를 전부 모아, 이미 정산서에 들어간 열쇠(서버 used-sources)와
     하나라도 겹치면 뺀다. 고른 것끼리 겹치면(품의와 그 결의서) 결의서 한 줄만 남긴다. */
  const keysOfResolution = (r) => [`resolution:${r.id}`, r.txn_id && `txn:${r.txn_id}`,
    r.purchase_req_id && `purchase_req:${r.purchase_req_id}`].filter(Boolean)
  const keysOfPreq = (r) => [`purchase_req:${r.id}`, r.txn_id && `txn:${r.txn_id}`,
    r.resolution && `resolution:${r.resolution.id}`, ...(r.source_txn_ids || []).map(t => `txn:${t}`)].filter(Boolean)
  const usedBy = (keys, used) => keys.map(k => used[k]).find(Boolean) || null

  return (
    <div className="fade-up doc-screen">
      <PageHeader title="정산내역서"
        actions={<button className="btn primary" onClick={() => setSrcOpen(true)}><Icon.Plus size={14}/> 새 정산내역서</button>}/>

      <SourceChooser
        open={srcOpen} onClose={() => setSrcOpen(false)}
        title="새 정산내역서" sub="어디서 만들까요?"
        options={SETTLE_SOURCES}
        onPick={(id) => {
          setSrcOpen(false)
          if (id === 'blank') { setSeed([]); setCreating(true); return }
          if (id === 'doc') {
            setPickDocs(null); setDocPickOpen(true)
            // 구매품의서 + 지급결의서를 한 목록으로 — 출처가 다른 두 문서를 한 자리에서 고른다
            Promise.all([api.getPurchaseReqs(), api.getResolutions(), api.getSettlementUsedSources()]).then(([prs, ress, used]) => {
              const a = (prs || []).map(r => ({ id: 'pr:' + r.id, srcType: 'purchase_req', srcId: r.id, kind: '구매품의', docNo: r.doc_no,
                title: r.summary || r.vendor_name || '구매품의', vendor: r.vendor_name || '', status: r.status || '작성',
                amount: Number(r.total || r.order_amount) || 0, date: r.req_date || '', keys: keysOfPreq(r) }))
              const b = (ress || []).map(r => ({ id: 're:' + r.id, srcType: 'resolution', srcId: r.id, kind: '지급결의', docNo: r.doc_no,
                title: r.title || r.vendor_name || '지급결의', vendor: r.vendor_name || '', status: r.status || '작성',
                amount: Number(r.amount) || 0, date: r.pay_date || '', keys: keysOfResolution(r) }))
              const all = [...a, ...b]
              const free = all.filter(r => !usedBy(r.keys, used || {}))
              setHiddenUsed(all.length - free.length)
              // 돈이 실제로 나간(완료) 문서를 위로 — 정산은 쓴 돈을 정리하는 문서다
              setPickDocs(free.sort((x, y) => Number(y.status === '완료') - Number(x.status === '완료')))
            })
            return
          }
          setTxns(null); setPickOpen(true)
          /* 이미 나간 지출만(지급완료) — 정산은 쓴 돈을 정리한다. 아직 안 나간 지출을 넣으면
             정산서의 지출총액이 통장과 달라진다. 다른 정산서에 이미 들어간 지출은 뺀다. */
          Promise.all([api.getTransactions({ kind: 'expense' }), api.getSettlementUsedSources()]).then(([rows, used]) => {
            const all = (rows || []).filter(t => t.status === '지급완료')
            const free = all.filter(t => !(used || {})[`txn:${t.id}`])
            setHiddenUsed(all.length - free.length)
            setTxns(free)
          })
        }}/>

      <PickListDrawer
        open={docPickOpen} onClose={() => setDocPickOpen(false)}
        title="구매품의·지급결의에서 골라서"
        sub={hiddenUsed > 0 ? `다른 정산서에 이미 들어간 ${hiddenUsed}건은 뺐어요` : '정산에 넣을 문서를 고르세요'}
        placeholder="문서번호·제목·거래처 검색"
        rows={pickDocs}
        match={(r, q) => [r.docNo, r.title, r.vendor, r.kind].filter(Boolean)
          .some(v => String(v).toLowerCase().includes(q.toLowerCase()))}
        render={(r) => ({
          title: `${r.docNo} · ${r.title}`,
          sub: [r.kind, r.status !== '완료' ? `${r.status} · 지출 전` : null, r.vendor, r.date].filter(Boolean).join(' · '),
          right: r.amount,
        })}
        empty="가져올 구매품의서·지급결의서가 없어요."
        onDone={(rows) => {
          /* 고른 것끼리 같은 돈이면(품의와 그 품의를 넘겨받은 결의서) 결의서 한 줄만 남긴다 —
             결의서가 실제 지급액(세액 포함)이고, 품의는 그 전 단계의 결재다. */
          const resKeys = new Set(rows.filter(r => r.srcType === 'resolution').flatMap(r => r.keys))
          const kept = rows.filter(r => r.srcType !== 'purchase_req' || !r.keys.some(k => resKeys.has(k)))
          if (kept.length < rows.length) toast.push(`같은 지출인 구매품의 ${rows.length - kept.length}건은 결의서 줄로 합쳤어요`)
          /* 문서 → 정산 줄. 제목은 문서 제목, 비고에는 **출처(GM-…/DJ-…)** 와 거래처를 남긴다 —
             정산내역서를 받는 사람이 어느 결재에서 온 건지 되짚을 수 있어야 한다. */
          setSeed(kept.map(r => ({
            title: r.title,
            amount: r.amount,
            memo: [`${r.kind} ${r.docNo}`, r.vendor].filter(Boolean).join(' · '),
            source_type: r.srcType, source_id: r.srcId,
          })))
          setDocPickOpen(false); setCreating(true)
        }}/>

      <PickListDrawer
        open={pickOpen} onClose={() => setPickOpen(false)}
        title="거래내역에서 골라서"
        sub={hiddenUsed > 0 ? `다른 정산서에 이미 들어간 ${hiddenUsed}건은 뺐어요` : '정산에 넣을 지출을 고르세요'}
        placeholder="거래처·비목·적요 검색"
        rows={txns}
        match={(t, q) => [t.vendor, t.category, t.memo].filter(Boolean)
          .some(v => String(v).toLowerCase().includes(q.toLowerCase()))}
        render={(t) => ({
          title: t.vendor && t.vendor !== '(미확인)' ? t.vendor : (t.category || '지출'),
          sub: [t.date, t.category, t.memo].filter(Boolean).join(' · '),
          right: Number(t.amount) || 0,
        })}
        empty="가져올 지출이 없어요."
        onDone={(rows) => {
          /* 거래 → 정산 줄. 제목은 **무슨 지출인지**(비목·적요), 비고에는 날짜·거래처를
             남긴다 — 정산내역서를 받는 사람이 근거를 되짚을 수 있어야 한다. */
          setSeed(rows.map(t => ({
            title: t.category && t.category !== '—' ? t.category : (t.memo || '지출'),
            amount: Number(t.amount) || 0,
            memo: [t.date, t.vendor !== '(미확인)' ? t.vendor : null].filter(Boolean).join(' · '),
            source_type: 'txn', source_id: t.id,
          })))
          setPickOpen(false); setCreating(true)
        }}/>

      <DocWorkspace>
        <DocSide top={<DocFilters list={list} placeholder="문서번호·정산자·제목 검색"/>}>
          {list.rows.length === 0
            ? <DocSideEmpty>{list.loading ? '불러오는 중…'
                : (list.filters.q || list.filters.from) ? '조건에 맞는 정산내역서가 없어요.'
                : <>정산내역서가 없어요.<br/>{"'새 정산내역서'로 만드세요."}</>}</DocSideEmpty>
            : <>
              {list.rows.map(d => (
                <DocListRow key={d.id} active={!creating && selId === d.id} onClick={() => { setCreating(false); setSelId(d.id) }}
                  docNo={d.doc_no} right={<span className="text-xs text-muted2">{d.settle_date || ''}</span>}
                  title={d.purpose || d.settler || '—'} meta={d.purpose ? `${d.settler || ''} · 잔액` : '잔액'} amount={d.balance || 0}/>
              ))}
              {list.hasMore && (
                <button className="btn ghost" style={{ width: '100%', marginTop: 6 }}
                  disabled={list.loadingMore} onClick={list.loadMore}>
                  {list.loadingMore ? '불러오는 중…' : `더 보기 · ${list.rows.length}/${list.total}건`}
                </button>
              )}
            </>}
        </DocSide>
        <DocMain>
          {creating
            ? <SettlementPreview doc={blankDoc} company={company} isNew
                onSaved={(id) => { setCreating(false); refresh(id) }}
                onCancelNew={() => setCreating(false)}/>
            : sel
              ? <SettlementPreview key={sel.id} doc={sel} company={company}
                  onSaved={(id) => refresh(id)}
                  onDeleted={() => { setSelId(null); setSel(null); list.reload() }}/>
              : <DocEmpty icon={<Icon.Doc size={32} style={{ opacity: 0.3 }}/>}>왼쪽에서 정산내역서를 고르거나 새로 만드세요.</DocEmpty>}
        </DocMain>
      </DocWorkspace>
    </div>
  )
}
