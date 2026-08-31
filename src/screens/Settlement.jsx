import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, localToday } from '../lib/ui'
import { api } from '../lib/api'
import { PageHeader } from '../lib/components/PageHeader'
import { DocWorkspace, DocSide, DocListRow, DocSideEmpty, DocMain, DocToolbar, DocViewport, DocEmpty } from '../lib/components/DocWorkspace'
import { SourceChooser } from '../lib/components/SourceChooser'
import { PickListDrawer } from '../lib/components/PickListDrawer'

// 定算內譯書 — 항목은 고정 분류(도로비·교통비…) 없이 쓰는 사람이 필요한 줄만 추가한다.
// 옛 양식의 좌측 고정 슬롯·출장 항번호(①②③…) 주석은 2026-08 고객 요청으로 걷어냈다.
const numOf = (v) => (typeof v === 'string' ? parseInt(v.replace(/[^0-9-]/g, ''), 10) || 0 : Number(v) || 0)
const emptyLine = () => ({ title: '', amount: '', memo: '' })

// 얇은 인라인 셀 입력
const CellIn = ({ value, onChange, right, placeholder }) => (
  <input className={`settle-cellin ${right ? 'num' : ''}`} value={value} placeholder={placeholder}
    onChange={e => onChange(e.target.value)} style={right ? { textAlign: 'right' } : undefined}/>
)

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
    lines: (d.lines || []).map(l => ({ title: l.title || '', amount: String(l.amount || ''), memo: l.memo || '', category: l.category || '' })),
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
        lines.push({ title: (l.title || '').trim(), amount: numOf(l.amount), memo: (l.memo || '').trim(), ...(l.category ? { category: l.category } : {}) })
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
            <button className="btn ghost" onClick={remove}><Icon.Trash size={14}/></button>
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
                <th>정산일</th><td colSpan={2}>{edit ? <CellIn value={form.settle_date} onChange={v => setH('settle_date', v)} placeholder="YYYY-MM-DD"/> : (form.settle_date || '')}</td>
              </tr>
              <tr>
                <th>제　목</th><td colSpan={5} className="settle-subject">{edit ? <CellIn value={form.purpose} onChange={v => setH('purpose', v)} placeholder="예: 7월 세금납부·자재대 정산"/> : form.purpose}</td>
              </tr>
              <tr>
                <th>수령액</th><td className="num fw-700">{edit ? <CellIn value={form.received_amount} onChange={v => setH('received_amount', v)} right/> : amt(received)}</td>
                <th>지출총액</th><td className="num">{amt(total)}</td>
                <th>잔　액</th><td className="num fw-700" style={{ color: balance < 0 ? 'var(--neg-ink)' : undefined }}>{amt(balance)}</td>
              </tr>
            </tbody>
          </table>

          <table className="res-table settle-grid">
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
                        ? <CellIn value={r.amount || ''} onChange={v => setLine(i, 'amount', v)} right/>
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
    id: 'blank', icon: Icon.Pencil,
    label: '직접 작성',
    desc: '빈 양식에서 시작해요',
    effect: '항목을 하나씩 적어요.',
  },
]

export const SettlementScreen = () => {
  const [srcOpen, setSrcOpen] = useState(false)
  const [pickOpen, setPickOpen] = useState(false)
  const [txns, setTxns] = useState(null)
  /* 새 문서에 미리 채워 넣을 줄. blankDoc 이 상수라 여기에 담아 둔다 —
     creating 이 false→true 로 갈 때 미리보기가 새로 마운트되면서 이 값을 읽는다. */
  const [seed, setSeed] = useState([])
  const [list, setList] = useState([])
  const [company, setCompany] = useState(null)
  const [selId, setSelId] = useState(null)
  const [sel, setSel] = useState(null)
  const [creating, setCreating] = useState(false)

  const load = async (keepId) => {
    const [rows, comp] = await Promise.all([api.getSettlements(), api.getCompany()])
    setList(rows); setCompany(comp)
    setSelId(prev => {
      const want = keepId || prev
      return want && rows.some(r => r.id === want) ? want : (rows[0]?.id || null)
    })
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (creating) return
    if (!selId) { setSel(null); return }
    api.getSettlement(selId).then(setSel)
  }, [selId, creating])

  const blankDoc = { id: '__new', settle_date: localToday(), lines: seed, approval: [] }

  return (
    <div className="fade-up">
      <PageHeader title="정산내역서"
        actions={<button className="btn primary" onClick={() => setSrcOpen(true)}><Icon.Plus size={14}/> 새 정산내역서</button>}/>

      <SourceChooser
        open={srcOpen} onClose={() => setSrcOpen(false)}
        title="새 정산내역서" sub="어디서 만들까요?"
        options={SETTLE_SOURCES}
        onPick={(id) => {
          setSrcOpen(false)
          if (id === 'blank') { setSeed([]); setCreating(true); return }
          setTxns(null); setPickOpen(true)
          // 지출 전체를 받아 화면에서 거른다 — 정산은 보통 최근 몇 달치를 훑어 고른다
          api.getTransactions({ kind: 'expense' }).then(setTxns)
        }}/>

      <PickListDrawer
        open={pickOpen} onClose={() => setPickOpen(false)}
        title="거래내역에서 골라서" sub="정산에 넣을 지출을 고르세요"
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
          })))
          setPickOpen(false); setCreating(true)
        }}/>

      <DocWorkspace>
        <DocSide>
          {list.length === 0
            ? <DocSideEmpty>정산내역서가 없어요.<br/>'새 정산내역서'로 만드세요.</DocSideEmpty>
            : list.map(d => (
              <DocListRow key={d.id} active={!creating && selId === d.id} onClick={() => { setCreating(false); setSelId(d.id) }}
                docNo={d.doc_no} right={<span className="text-xs text-muted2">{d.settle_date || ''}</span>}
                title={d.settler || '—'} meta="잔액" amount={d.balance || 0}/>
            ))}
        </DocSide>
        <DocMain>
          {creating
            ? <SettlementPreview doc={blankDoc} company={company} isNew
                onSaved={(id) => { setCreating(false); load(id) }}
                onCancelNew={() => setCreating(false)}/>
            : sel
              ? <SettlementPreview key={sel.id} doc={sel} company={company}
                  onSaved={(id) => load(id)}
                  onDeleted={() => { setSelId(null); load() }}/>
              : <DocEmpty icon={<Icon.Doc size={32} style={{ opacity: 0.3 }}/>}>왼쪽에서 정산내역서를 고르거나 새로 만드세요.</DocEmpty>}
        </DocMain>
      </DocWorkspace>
    </div>
  )
}

// 인쇄용 문서 컴포넌트(다른 화면에서 참조 가능) — 미리보기와 동일 렌더를 읽기전용으로
export const SettlementDocument = ({ doc, company }) => (
  <SettlementPreview doc={doc} company={company} onSaved={() => {}} onDeleted={() => {}}/>
)
