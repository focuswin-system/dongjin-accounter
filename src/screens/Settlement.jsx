import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Combobox, localToday } from '../lib/ui'
import { api } from '../lib/api'
import { PageHeader } from '../lib/components/PageHeader'
import { DocWorkspace, DocSide, DocListRow, DocSideEmpty, DocMain, DocToolbar, DocViewport, DocEmpty } from '../lib/components/DocWorkspace'

// 定算內譯書 좌측 고정 분류·슬롯(동진테크 양식). tag = 양식 상의 항번호(주석 참조). 우측은 기타경비 자유 목록.
const SLOT_GROUPS = [
  { cat: '도로비', tag: '', slots: ['터널비', '고속도로통행료'] },
  { cat: '교통비', tag: '③', slots: ['승선료', '대중교통비', '철도·항공'] },
  { cat: '영업비', tag: '④', slots: ['직접정산', '회사정산'] },
  { cat: '운송료', tag: '⑤', slots: ['선편', '화물', '택배·퀵', '버스', '우편'] },
]
const ETC = '기타경비'
const FOOTNOTES = [
  '① ② ③ ⑥ 항은 출장에 限하며 특기사항에 지역 및 목적지 기재할것 (예: 서울 동진조선)',
  '③ ④ ⑥ ⑧ 항은 정산자 이외의 참석자 성명을 특기사항에 기재할것 (예: 동진조선 홍길동대리, 당사 이순신과장)',
  '④ 항은 발송지역 및 인수자를 특기사항에 기재할것 (예: 서울 동진조선 자재과 홍길동)',
  '⑦ 항은 해당 차량번호를 금액 뒤에 기재할것 (예: 20,000(5848))',
]
const keyOf = (cat, title) => `${cat}|${title}`
const numOf = (v) => (typeof v === 'string' ? parseInt(v.replace(/[^0-9-]/g, ''), 10) || 0 : Number(v) || 0)

const splitLines = (lines) => {
  const slotVal = {}
  const etc = []
  for (const l of (lines || [])) {
    const grp = SLOT_GROUPS.find(g => g.cat === l.category && g.slots.includes(l.title))
    if (grp) slotVal[keyOf(l.category, l.title)] = l
    else etc.push(l)
  }
  return { slotVal, etc }
}

// 짧은 슬롯명을 칸 폭에 맞춰 양끝으로 벌린다(터  널  비).
const Spread = ({ text }) => (
  <span className="settle-slot">{[...String(text)].map((c, i) => <span key={i}>{c}</span>)}</span>
)

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
  const emptyForm = () => ({ settler: '', settle_date: localToday(), trip_area: '', trip_period: '', purpose: '', received_amount: '', note: '', slots: {}, etc: [], approval: [] })
  const [form, setForm] = useState(emptyForm())
  const [presets, setPresets] = useState([])
  const [presetId, setPresetId] = useState('')

  useEffect(() => { api.getApprovalPresets().then(setPresets) }, [])
  useEffect(() => {
    setEdit(!!isNew)
    if (!doc) { setForm(emptyForm()); return }
    const { slotVal, etc } = splitLines(doc.lines)
    const slots = {}
    for (const k of Object.keys(slotVal)) slots[k] = { amount: String(slotVal[k].amount || ''), memo: slotVal[k].memo || '' }
    setForm({
      settler: doc.settler || '', settle_date: doc.settle_date || localToday(),
      trip_area: doc.trip_area || '', trip_period: doc.trip_period || '', purpose: doc.purpose || '',
      received_amount: doc.received_amount ? String(doc.received_amount) : '', note: doc.note || '',
      slots, etc: etc.map(l => ({ title: l.title || '', amount: String(l.amount || ''), memo: l.memo || '' })),
      approval: (doc.approval && doc.approval.length) ? doc.approval : [],
    })
  }, [doc?.id, isNew])

  const setH = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setSlot = (k, field, v) => setForm(f => ({ ...f, slots: { ...f.slots, [k]: { ...(f.slots[k] || { amount: '', memo: '' }), [field]: v } } }))
  const setEtc = (i, field, v) => setForm(f => {
    const etc = [...f.etc]
    if (i === etc.length) etc.push({ title: '', amount: '', memo: '' })   // ghost 행 입력 → 새 행
    etc[i] = { ...etc[i], [field]: v }
    return { ...f, etc }
  })

  const slotTotal = Object.values(form.slots).reduce((s, v) => s + numOf(v.amount), 0)
  const etcTotal = form.etc.reduce((s, l) => s + numOf(l.amount), 0)
  const total = edit ? slotTotal + etcTotal : (doc?.lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const received = edit ? numOf(form.received_amount) : (Number(doc?.received_amount) || 0)
  const balance = received - total
  const ceo = company?.ceo || '대표이사'
  const defApproval = [{ label: '담당' }, { label: '결재' }, { label: '대표이사', position: ceo }]
  const approval = edit
    ? (form.approval && form.approval.length ? form.approval : defApproval)
    : (doc?.approval && doc.approval.length ? doc.approval : defApproval)
  const applyPreset = (p) => setForm(f => ({ ...f, approval: (p.steps || []).map(s => ({ label: s.label, position: s.position || '', name: '' })) }))

  // 표시용 데이터(편집 중이면 form, 아니면 doc)
  const view = edit
    ? { slotVal: Object.fromEntries(Object.entries(form.slots).map(([k, v]) => [k, { amount: numOf(v.amount), memo: v.memo }])), etc: form.etc }
    : splitLines(doc?.lines)
  const leftCells = []
  for (const g of SLOT_GROUPS) g.slots.forEach((s, i) => leftCells.push({ span: i === 0 ? g.slots.length : 0, cat: g.cat, slot: s }))
  const etcRows = edit ? [...view.etc, { title: '', amount: '', memo: '' }] : view.etc   // 편집 시 맨 끝 ghost 행
  const rowCount = Math.max(leftCells.length, etcRows.length)
  const padLeft = rowCount - leftCells.length

  const save = async () => {
    const lines = []
    for (const g of SLOT_GROUPS) for (const s of g.slots) {
      const v = form.slots[keyOf(g.cat, s)]
      if (v && numOf(v.amount)) lines.push({ category: g.cat, title: s, amount: numOf(v.amount), memo: (v.memo || '').trim() })
    }
    for (const l of form.etc) if ((l.title || '').trim() || numOf(l.amount)) lines.push({ category: ETC, title: (l.title || '').trim(), amount: numOf(l.amount), memo: (l.memo || '').trim() })
    if (!lines.length) return toast.push('지출 항목을 하나 이상 입력해주세요')
    const chosen = presets.find(p => p.is_default) || presets[0]
    const payload = {
      settler: form.settler.trim(), settle_date: form.settle_date || null,
      trip_area: form.trip_area.trim(), trip_period: form.trip_period.trim(), purpose: form.purpose.trim(),
      received_amount: numOf(form.received_amount), note: form.note.trim(), lines,
      approval: (form.approval && form.approval.length) ? form.approval
        : (chosen ? chosen.steps.map(s => ({ label: s.label, position: s.position || '', name: '' })) : undefined),
    }
    const res = isNew ? await api.createSettlement(payload) : await api.updateSettlement(doc.id, payload)
    if (!res.ok) return toast.push(res.error || '저장에 실패했어요')
    toast.push(isNew ? `정산내역서 ${res.settlement?.doc_no || ''}를 만들었어요` : '저장됐어요')
    setEdit(false)
    onSaved(isNew ? res.settlement?.id : doc.id)
  }
  const cancel = () => { if (isNew) return onCancelNew(); setEdit(false) }
  const remove = async () => {
    const ok = await confirm({ tone: 'neg', icon: <Icon.Warn size={22}/>, title: `${doc.doc_no} 삭제`, body: '이 정산내역서를 삭제할까요? 복구할 수 없어요.', confirmLabel: '삭제' })
    if (!ok) return
    const res = await api.deleteSettlement(doc.id)
    if (!res.ok) return toast.push(res.error || '삭제에 실패했어요')
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
                <th>정산자</th><td>{edit ? <CellIn value={form.settler} onChange={v => setH('settler', v)}/> : form.settler}</td>
                <th>출장지역①</th><td>{edit ? <CellIn value={form.trip_area} onChange={v => setH('trip_area', v)}/> : form.trip_area}</td>
                <th>출장기간②</th><td>{edit ? <CellIn value={form.trip_period} onChange={v => setH('trip_period', v)}/> : form.trip_period}</td>
              </tr>
              <tr>
                <th>구분</th><td colSpan={3}>{edit ? <CellIn value={form.purpose} onChange={v => setH('purpose', v)} placeholder="예: 세금납부·자재대 외"/> : form.purpose}</td>
                <th>정산일</th><td>{edit ? <CellIn value={form.settle_date} onChange={v => setH('settle_date', v)} placeholder="YYYY-MM-DD"/> : (form.settle_date || '')}</td>
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
              <col style={{ width: 24 }}/><col style={{ width: 116 }}/><col style={{ width: 92 }}/>
              <col style={{ width: 24 }}/><col/><col style={{ width: 92 }}/>
            </colgroup>
            <thead>
              <tr><th colSpan={2}>항　목</th><th>지출액</th><th colSpan={2}>항　목</th><th>지출액</th></tr>
            </thead>
            <tbody>
              {Array.from({ length: rowCount }).map((_, i) => {
                const L = leftCells[i]
                const g = L && SLOT_GROUPS.find(x => x.cat === L.cat)
                const sv = L && view.slotVal[keyOf(L.cat, L.slot)]
                const R = etcRows[i]
                const isGhost = edit && i === view.etc.length
                return (
                  <tr key={i}>
                    {L
                      ? (L.span > 0 ? <th rowSpan={L.span} className="settle-cat">{L.cat}{g.tag ? <span className="settle-tag">{g.tag}</span> : null}</th> : null)
                      : (i === leftCells.length ? <th rowSpan={padLeft} className="settle-cat"> </th> : null)}
                    <td className="settle-slotcell">{L ? <Spread text={L.slot}/> : ''}</td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {L ? (edit ? <CellIn value={form.slots[keyOf(L.cat, L.slot)]?.amount || ''} onChange={v => setSlot(keyOf(L.cat, L.slot), 'amount', v)} right/> : (sv ? fmtNum(sv.amount) : '')) : ''}
                    </td>
                    {i === 0 ? <th rowSpan={rowCount} className="settle-cat">{ETC}</th> : null}
                    <td>
                      {edit
                        ? (i < etcRows.length ? <CellIn value={etcRows[i].title || ''} onChange={v => setEtc(i, 'title', v)} placeholder={isGhost ? '+ 항목' : ''}/> : '')
                        : (R ? <>{R.title}{R.memo ? <span className="settle-memo"> · {R.memo}</span> : null}</> : '')}
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {edit
                        ? (i < etcRows.length ? <CellIn value={etcRows[i].amount || ''} onChange={v => setEtc(i, 'amount', v)} right/> : '')
                        : (R ? fmtNum(R.amount) : '')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {edit && presets.length > 0 && (
            <div className="no-print row gap-6" style={{ margin: '10px 0 4px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="text-xs text-muted2">결재선</span>
              {presets.map(p => (
                <button key={p.id} className="btn ghost sm" onClick={() => applyPreset(p)}>{p.name}</button>
              ))}
            </div>
          )}
          <table className="res-table settle-foot">
            <colgroup>
              <col style={{ width: 24 }}/><col style={{ width: 116 }}/><col style={{ width: 92 }}/>
              <col style={{ width: 24 }}/><col/><col style={{ width: 92 }}/>
            </colgroup>
            <tbody>
              <tr>
                <th className="settle-cat">특기사항</th>
                <td colSpan={2} className="settle-note">{edit ? <CellIn value={form.note} onChange={v => setH('note', v)} placeholder="예: 우리.090-044469-13-301 계좌인출 후 송금"/> : form.note}</td>
                <th className="settle-cat">결　재</th>
                <td colSpan={2} className="settle-approve-cell">
                  <div className="settle-approve">
                    {approval.map((s, i) => (
                      <div key={i} className="settle-approve-col">
                        <div className="settle-approve-h">{s.label}{s.position ? <div className="settle-approve-pos">{s.position}</div> : null}</div>
                        <div className="settle-approve-sign"/>
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <div className="settle-notes">
            {FOOTNOTES.map((t, i) => <div key={i}>※ {t}</div>)}
          </div>
          <div className="res-company num">{company?.name || ''}</div>
        </div>
      </DocViewport>
    </>
  )
}

// ── 화면 ─────────────────────────────────────────────────────────
export const SettlementScreen = () => {
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

  const blankDoc = { id: '__new', settle_date: localToday(), lines: [], approval: [] }

  return (
    <div className="fade-up">
      <PageHeader title="정산내역서"
        actions={<button className="btn primary" onClick={() => { setCreating(true) }}><Icon.Plus size={14}/> 새 정산내역서</button>}/>

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
