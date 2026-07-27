import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Drawer, Combobox, MoneyInput, localToday } from '../lib/ui'
import { api } from '../lib/api'
import { PageHeader } from '../lib/components/PageHeader'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { DocWorkspace, DocSide, DocListRow, DocSideEmpty, DocMain, DocToolbar, DocViewport, DocEmpty } from '../lib/components/DocWorkspace'

// 定算內譯書 좌측 고정 분류·슬롯(동진테크 양식). 우측은 기타경비 자유 목록.
const SLOT_GROUPS = [
  { cat: '도로비', slots: ['터널비', '고속도로통행료'] },
  { cat: '교통비', slots: ['승선료', '대중교통비', '철도·항공'] },
  { cat: '영업비', slots: ['직접정산', '회사정산'] },
  { cat: '운송료', slots: ['선편', '화물', '택배·퀵', '버스', '우편'] },
]
const ETC = '기타경비'
const keyOf = (cat, title) => `${cat}|${title}`
const numOf = (v) => (typeof v === 'string' ? parseInt(v.replace(/[^0-9-]/g, ''), 10) || 0 : Number(v) || 0)

// doc.lines → 좌측 고정슬롯 값 맵 + 우측 기타경비 목록으로 분리
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

// ── 인쇄 양식(定算內譯書) — 실물처럼 좌우 한 그리드 ─────────────────
export const SettlementDocument = ({ doc, company }) => {
  const ceo = company?.ceo || '대표이사'
  const total = (doc.lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const received = Number(doc.received_amount) || 0
  const balance = received - total
  const approval = (doc.approval && doc.approval.length)
    ? doc.approval
    : [{ label: '담당' }, { label: '결재' }, { label: '대표이사', position: ceo }]
  const { slotVal, etc } = splitLines(doc.lines)

  // 좌측 고정슬롯 행 + 우측 기타경비 행을 한 그리드로 합친다(이음새 없이).
  const leftCells = []
  for (const g of SLOT_GROUPS) g.slots.forEach((s, i) => leftCells.push({ span: i === 0 ? g.slots.length : 0, cat: g.cat, slot: s, v: slotVal[keyOf(g.cat, s)] }))
  const rowCount = Math.max(leftCells.length, etc.length)
  const padLeft = rowCount - leftCells.length

  return (
    <div className="doc-paper resolution-paper resolution-print settle-paper">
      <div className="res-title-ko">정산내역서</div>
      <div className="res-title">定 算 內 譯 書</div>
      <div className="res-date num">{doc.settle_date || ''}</div>
      <div className="res-note-line">아래 내역과 같이 經費 使用 部分에 대하여 定算코자 하오니 決裁하여 주시기 바랍니다.</div>

      <table className="res-table res-head">
        <tbody>
          <tr>
            <th>정산자</th><td>{doc.settler || ''}</td>
            <th>출장지역</th><td>{doc.trip_area || ''}</td>
            <th>출장기간</th><td>{doc.trip_period || ''}</td>
          </tr>
          <tr>
            <th>수령액</th><td className="num fw-700">{fmtNum(received)}</td>
            <th>지출총액</th><td className="num">{fmtNum(total)}</td>
            <th>잔　액</th><td className="num fw-700" style={{ color: balance < 0 ? 'var(--neg-ink)' : undefined }}>{fmtNum(balance)}</td>
          </tr>
          {doc.purpose ? <tr><th>구분</th><td colSpan={5}>{doc.purpose}</td></tr> : null}
        </tbody>
      </table>

      <table className="res-table settle-grid">
        <colgroup>
          <col style={{ width: 26 }}/><col/><col style={{ width: 92 }}/>
          <col style={{ width: 26 }}/><col/><col style={{ width: 92 }}/>
        </colgroup>
        <thead>
          <tr><th colSpan={2}>항　목</th><th>지출액</th><th colSpan={2}>항　목</th><th>지출액</th></tr>
        </thead>
        <tbody>
          {Array.from({ length: rowCount }).map((_, i) => {
            const L = leftCells[i]
            const R = etc[i]
            return (
              <tr key={i}>
                {L
                  ? (L.span > 0 ? <th rowSpan={L.span} className="settle-cat">{L.cat}</th> : null)
                  : (i === leftCells.length ? <th rowSpan={padLeft} className="settle-cat"> </th> : null)}
                <td>{L ? <>{L.slot}{L.v && L.v.memo ? <span className="settle-memo"> · {L.v.memo}</span> : null}</> : ''}</td>
                <td className="num" style={{ textAlign: 'right' }}>{L && L.v ? fmtNum(L.v.amount) : ''}</td>
                {i === 0 ? <th rowSpan={rowCount} className="settle-cat">기타경비</th> : null}
                <td>{R ? <>{R.title}{R.memo ? <span className="settle-memo"> · {R.memo}</span> : null}</> : ''}</td>
                <td className="num" style={{ textAlign: 'right' }}>{R ? fmtNum(R.amount) : ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {/* 특기사항·결재 — 본문 그리드에 이어붙여 한 몸으로(세로 라벨). PDF 하단과 동일 구조. */}
      <table className="res-table settle-foot">
        <colgroup>
          <col style={{ width: 26 }}/><col/><col style={{ width: 92 }}/>
          <col style={{ width: 26 }}/><col/><col style={{ width: 92 }}/>
        </colgroup>
        <tbody>
          <tr>
            <th className="settle-cat">특기사항</th>
            <td colSpan={2} className="settle-note">{doc.note || ''}</td>
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
        ※ 출장 항목(도로비·교통비·영업비 등)은 출장지역·기간을 상단에 기재하세요.<br/>
        ※ 운송료는 발송지역·인수자를 비고에 적으세요. 기타경비는 은행인출·계좌이체 등 그 외 집행분을 적습니다.
      </div>
      <div className="res-company num">{company?.name || ''}</div>
    </div>
  )
}

// ── 새/편집 드로어 ───────────────────────────────────────────────
const SettlementDrawer = ({ open, editDoc, onClose, onSaved }) => {
  const toast = useToast()
  const [form, setForm] = useState({ settler: '', settle_date: localToday(), trip_area: '', trip_period: '', purpose: '', received_amount: '', note: '' })
  const [slots, setSlots] = useState({})                       // key 'cat|slot' -> { amount, memo }
  const [etc, setEtc] = useState([{ title: '', amount: '', memo: '' }])
  const [presets, setPresets] = useState([])
  const [presetId, setPresetId] = useState('')

  useEffect(() => {
    if (!open) return
    api.getApprovalPresets().then(list => {
      setPresets(list)
      setPresetId((list.find(p => p.is_default) || list[0])?.id || '')
    })
    if (editDoc) {
      setForm({
        settler: editDoc.settler || '', settle_date: editDoc.settle_date || localToday(),
        trip_area: editDoc.trip_area || '', trip_period: editDoc.trip_period || '', purpose: editDoc.purpose || '',
        received_amount: String(editDoc.received_amount || ''), note: editDoc.note || '',
      })
      const { slotVal, etc: et } = splitLines(editDoc.lines)
      const sl = {}
      for (const k of Object.keys(slotVal)) sl[k] = { amount: String(slotVal[k].amount || ''), memo: slotVal[k].memo || '' }
      setSlots(sl)
      setEtc(et.length ? et.map(l => ({ title: l.title || '', amount: String(l.amount || ''), memo: l.memo || '' })) : [{ title: '', amount: '', memo: '' }])
    } else {
      setForm({ settler: '', settle_date: localToday(), trip_area: '', trip_period: '', purpose: '', received_amount: '', note: '' })
      setSlots({}); setEtc([{ title: '', amount: '', memo: '' }])
    }
  }, [open, editDoc])

  const setSlot = (k, field, v) => setSlots(s => ({ ...s, [k]: { ...(s[k] || { amount: '', memo: '' }), [field]: v } }))
  const setEtcLine = (i, field, v) => setEtc(ls => ls.map((l, j) => j === i ? { ...l, [field]: v } : l))
  const addEtc = () => setEtc(ls => [...ls, { title: '', amount: '', memo: '' }])
  const removeEtc = (i) => setEtc(ls => ls.length > 1 ? ls.filter((_, j) => j !== i) : ls)

  const slotTotal = Object.values(slots).reduce((s, v) => s + numOf(v.amount), 0)
  const etcTotal = etc.reduce((s, l) => s + numOf(l.amount), 0)
  const total = slotTotal + etcTotal
  const balance = numOf(form.received_amount) - total
  const chosen = presets.find(p => p.id === presetId)

  const save = async () => {
    const lines = []
    for (const g of SLOT_GROUPS) for (const s of g.slots) {
      const v = slots[keyOf(g.cat, s)]
      if (v && numOf(v.amount)) lines.push({ category: g.cat, title: s, amount: numOf(v.amount), memo: (v.memo || '').trim() })
    }
    for (const l of etc) if (l.title.trim() || numOf(l.amount)) lines.push({ category: ETC, title: l.title.trim(), amount: numOf(l.amount), memo: l.memo.trim() })
    if (!lines.length) return toast.push('지출 항목을 하나 이상 입력해주세요')
    const payload = {
      settler: form.settler.trim(), settle_date: form.settle_date || null,
      trip_area: form.trip_area.trim(), trip_period: form.trip_period.trim(), purpose: form.purpose.trim(),
      received_amount: numOf(form.received_amount), note: form.note.trim(), lines,
      approval: chosen ? chosen.steps.map(s => ({ label: s.label, position: s.position || '', name: '' })) : undefined,
    }
    const res = editDoc ? await api.updateSettlement(editDoc.id, payload) : await api.createSettlement(payload)
    if (!res.ok) return toast.push(res.error || '저장에 실패했어요')
    toast.push(editDoc ? '수정됐어요' : `정산내역서 ${res.settlement?.doc_no || ''}를 만들었어요`)
    onSaved(editDoc ? editDoc.id : res.settlement?.id)
  }

  return (
    <Drawer open={open} onClose={onClose} width="min(720px,100vw)" label="정산내역서">
      <DrawerHead title={editDoc ? '정산내역서 수정' : '새 정산내역서'} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="text-sm text-muted">수령한 자금을 분류별로 정산하고 잔액을 맞추는 문서예요. 좌측은 출장·운송 고정 분류, 우측(기타경비)은 은행인출·계좌이체 등 자유 항목.</div>

        <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 140px' }}>
            <label className="label" style={{ marginBottom: 8 }}>정산자</label>
            <input className="input" value={form.settler} onChange={e => setForm(f => ({ ...f, settler: e.target.value }))} placeholder="정산 담당자"/>
          </div>
          <div style={{ width: 150 }}>
            <label className="label" style={{ marginBottom: 8 }}>정산일</label>
            <input className="input" type="date" value={form.settle_date} onChange={e => setForm(f => ({ ...f, settle_date: e.target.value }))}/>
          </div>
        </div>
        <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 120px' }}>
            <label className="label" style={{ marginBottom: 8 }}>출장지역 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
            <input className="input" value={form.trip_area} onChange={e => setForm(f => ({ ...f, trip_area: e.target.value }))} placeholder="예: 서울 동진조선"/>
          </div>
          <div style={{ flex: '1 1 120px' }}>
            <label className="label" style={{ marginBottom: 8 }}>출장기간 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
            <input className="input" value={form.trip_period} onChange={e => setForm(f => ({ ...f, trip_period: e.target.value }))} placeholder="예: 4/28~4/30"/>
          </div>
          <div style={{ flex: '1 1 120px' }}>
            <label className="label" style={{ marginBottom: 8 }}>구분 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
            <input className="input" value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))} placeholder="예: 세금납부·자재대 외"/>
          </div>
        </div>

        <div>
          <label className="label" style={{ marginBottom: 8 }}>수령액 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 정산 대상 자금</span></label>
          <div style={{ position: 'relative' }}>
            <MoneyInput className="input num fw-700" style={{ fontSize: 18, paddingRight: 36 }}
              value={form.received_amount} onChange={raw => setForm(f => ({ ...f, received_amount: raw }))}/>
            <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>원</span>
          </div>
        </div>

        {/* 좌측 고정 분류·슬롯 */}
        <div>
          <label className="label" style={{ marginBottom: 8 }}>출장·운송 분류 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 쓴 항목만 금액 입력</span></label>
          <div className="col gap-10">
            {SLOT_GROUPS.map(g => (
              <div key={g.cat}>
                <div className="text-xs fw-700" style={{ color: 'var(--muted-2)', marginBottom: 4, paddingLeft: 2 }}>{g.cat}</div>
                <div className="col gap-6">
                  {g.slots.map(s => {
                    const k = keyOf(g.cat, s)
                    const v = slots[k] || { amount: '', memo: '' }
                    return (
                      <div key={s} className="row gap-6" style={{ alignItems: 'center' }}>
                        <span className="text-sm" style={{ width: 96, flexShrink: 0 }}>{s}</span>
                        <div style={{ width: 130 }}><MoneyInput className="input num" value={v.amount} onChange={raw => setSlot(k, 'amount', raw)}/></div>
                        <input className="input" style={{ flex: 1, minWidth: 100 }} value={v.memo} onChange={e => setSlot(k, 'memo', e.target.value)} placeholder="비고(발송·인수 등)"/>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 우측 기타경비 */}
        <div>
          <div className="row" style={{ marginBottom: 8, alignItems: 'center' }}>
            <label className="label" style={{ margin: 0 }}>기타경비 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 은행인출·계좌이체 등</span></label>
            <button className="btn sm ml-auto" onClick={addEtc}><Icon.Plus size={12}/> 항목 추가</button>
          </div>
          <div className="col gap-6">
            {etc.map((l, i) => (
              <div key={i} className="row gap-6" style={{ alignItems: 'center' }}>
                <input className="input" style={{ flex: 1, minWidth: 120 }} value={l.title} onChange={e => setEtcLine(i, 'title', e.target.value)} placeholder="항목(예: 은행인출-법인세)"/>
                <div style={{ width: 130 }}><MoneyInput className="input num" value={l.amount} onChange={raw => setEtcLine(i, 'amount', raw)}/></div>
                <input className="input" style={{ width: 120 }} value={l.memo} onChange={e => setEtcLine(i, 'memo', e.target.value)} placeholder="비고"/>
                <button className="icon-btn" onClick={() => removeEtc(i)} title="삭제"><Icon.Close size={14}/></button>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: '12px 14px', display: 'flex', gap: 20, alignItems: 'center' }}>
          <span className="text-sm text-muted">지출 합계 <b className="num" style={{ color: 'var(--ink)' }}>{fmtNum(total)}원</b></span>
          <span className="text-sm text-muted ml-auto">잔액</span>
          <b className="num" style={{ fontSize: 18, color: balance < 0 ? 'var(--neg-ink)' : 'var(--brand-ink)' }}>{fmtNum(balance)}원</b>
        </div>

        <div>
          <label className="label" style={{ marginBottom: 8 }}>결재선</label>
          <Combobox value={presetId} onChange={setPresetId} allowAdd={false}
            options={presets.map(p => ({ value: p.id, label: p.name }))} placeholder="기본 결재선"/>
          {chosen && <div className="text-xs text-muted2" style={{ marginTop: 6 }}>{(chosen.steps || []).map(s => s.label).join(' → ')}</div>}
        </div>

        <div>
          <label className="label" style={{ marginBottom: 8 }}>특기사항 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
          <input className="input" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="예: 우리.090-044469-13-301 계좌인출 후 송금"/>
        </div>
      </div>
      <DrawerFooter onCancel={onClose} onSave={save} saveLabel={editDoc ? '저장' : '정산내역서 만들기'}/>
    </Drawer>
  )
}

// ── 화면 ─────────────────────────────────────────────────────────
export const SettlementScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [list, setList] = useState([])
  const [company, setCompany] = useState(null)
  const [selId, setSelId] = useState(null)
  const [sel, setSel] = useState(null)
  const [drawer, setDrawer] = useState(null)

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
    if (!selId) { setSel(null); return }
    api.getSettlement(selId).then(setSel)
  }, [selId])

  const doDelete = async () => {
    if (!sel) return
    const ok = await confirm({ tone: 'neg', icon: <Icon.Warn size={22}/>, title: `${sel.doc_no} 삭제`, body: '이 정산내역서를 삭제할까요? 복구할 수 없어요.', confirmLabel: '삭제' })
    if (!ok) return
    const res = await api.deleteSettlement(sel.id)
    if (!res.ok) return toast.push(res.error || '삭제에 실패했어요')
    toast.push('삭제됐어요'); setSelId(null); load()
  }

  return (
    <div className="fade-up">
      <PageHeader title="정산내역서"
        actions={<button className="btn primary" onClick={() => setDrawer('new')}><Icon.Plus size={14}/> 새 정산내역서</button>}/>

      <DocWorkspace>
        <DocSide>
          {list.length === 0
            ? <DocSideEmpty>정산내역서가 없어요.<br/>'새 정산내역서'로 만드세요.</DocSideEmpty>
            : list.map(d => (
              <DocListRow key={d.id} active={selId === d.id} onClick={() => setSelId(d.id)}
                docNo={d.doc_no} right={<span className="text-xs text-muted2">{d.settle_date || ''}</span>}
                title={d.settler || '—'} meta="잔액" amount={d.balance || 0}/>
            ))}
        </DocSide>
        <DocMain>
          {sel ? (
            <>
              <DocToolbar docNo={sel.doc_no}
                status={<span className="text-sm text-muted">잔액 <b className="num" style={{ color: (sel.balance || 0) < 0 ? 'var(--neg-ink)' : 'var(--brand-ink)' }}>{fmtNum(sel.balance || 0)}원</b></span>}>
                <button className="btn" onClick={() => window.print()}><Icon.Print/> 인쇄</button>
                <button className="btn" onClick={() => setDrawer(sel)}><Icon.Pencil size={14}/> 편집</button>
                <button className="btn" style={{ color: 'var(--neg)' }} onClick={doDelete}><Icon.Trash size={14}/> 삭제</button>
              </DocToolbar>
              <DocViewport portrait><SettlementDocument doc={sel} company={company}/></DocViewport>
            </>
          ) : (
            <DocEmpty icon={<Icon.Doc size={32} style={{ opacity: 0.3 }}/>}>왼쪽에서 정산내역서를 고르거나 새로 만드세요.</DocEmpty>
          )}
        </DocMain>
      </DocWorkspace>

      <SettlementDrawer open={!!drawer} editDoc={drawer === 'new' ? null : drawer}
        onClose={() => setDrawer(null)}
        onSaved={(id) => { setDrawer(null); load(id) }}/>
    </div>
  )
}
