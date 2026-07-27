import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Combobox, localToday } from '../lib/ui'
import { api } from '../lib/api'
import { PageHeader } from '../lib/components/PageHeader'
import { DocWorkspace, DocSide, DocListRow, DocSideEmpty, DocMain, DocToolbar, DocViewport, DocEmpty } from '../lib/components/DocWorkspace'

const numOf = (v) => (typeof v === 'string' ? parseInt(v.replace(/[^0-9-]/g, ''), 10) || 0 : Number(v) || 0)
const emptyItem = () => ({ name: '', spec: '', unit: '', qty: '', unit_price: '', amount: '', memo: '' })

const CellIn = ({ value, onChange, right, placeholder }) => (
  <input className={`settle-cellin ${right ? 'num' : ''}`} value={value ?? ''} placeholder={placeholder}
    onChange={e => onChange(e.target.value)} style={right ? { textAlign: 'right' } : undefined}/>
)

const PurchaseReqPreview = ({ doc, company, vendors, onVendorAdd, isNew, onSaved, onCancelNew, onDeleted }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [edit, setEdit] = useState(!!isNew)
  const empty = () => ({ req_date: localToday(), vendor_name: '', order_source: '', ship_no: '', summary: '',
    arrival_date: '', order_amount: '', pay_terms: '', man_hours: '', note: '', items: [emptyItem()], approval: [] })
  const [form, setForm] = useState(empty())
  const [presets, setPresets] = useState([])

  useEffect(() => { api.getApprovalPresets().then(setPresets) }, [])
  useEffect(() => {
    setEdit(!!isNew)
    if (!doc) { setForm(empty()); return }
    setForm({
      req_date: doc.req_date || localToday(), vendor_name: doc.vendor_name || '', order_source: doc.order_source || '',
      ship_no: doc.ship_no || '', summary: doc.summary || '', arrival_date: doc.arrival_date || '',
      order_amount: doc.order_amount ? String(doc.order_amount) : '', pay_terms: doc.pay_terms || '', man_hours: doc.man_hours || '',
      note: doc.note || '',
      items: (doc.items && doc.items.length ? doc.items : []).map(it => ({
        name: it.name || '', spec: it.spec || '', unit: it.unit || '',
        qty: it.qty ? String(it.qty) : '', unit_price: it.unit_price ? String(it.unit_price) : '', amount: it.amount ? String(it.amount) : '', memo: it.memo || '',
      })),
      approval: (doc.approval && doc.approval.length) ? doc.approval : [],
    })
  }, [doc?.id, isNew])

  const setH = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setItem = (i, field, v) => setForm(f => {
    const items = [...f.items]
    if (i === items.length) items.push(emptyItem())
    const it = { ...items[i], [field]: v }
    if (field === 'qty' || field === 'unit_price') it.amount = String(numOf(field === 'qty' ? v : it.qty) * numOf(field === 'unit_price' ? v : it.unit_price))
    items[i] = it
    return { ...f, items }
  })

  const viewItems = edit ? form.items : (doc?.items || [])
  const total = (edit ? form.items : (doc?.items || [])).reduce((s, it) => s + numOf(it.amount), 0)
  const ceo = company?.ceo || '대표이사'
  const defApproval = [{ label: '담당' }, { label: '부장' }, { label: '이사' }, { label: '대표이사', position: ceo }]
  const approval = edit ? (form.approval && form.approval.length ? form.approval : defApproval) : (doc?.approval && doc.approval.length ? doc.approval : defApproval)
  const applyPreset = (p) => setForm(f => ({ ...f, approval: (p.steps || []).map(s => ({ label: s.label, position: s.position || '', name: '' })) }))
  const itemRows = edit ? [...viewItems, emptyItem()] : viewItems   // 편집 시 맨 끝 ghost 행
  const minRows = 6
  const padRows = Math.max(0, minRows - itemRows.length)

  const save = async () => {
    const items = form.items.filter(it => (it.name || '').trim() || numOf(it.amount) || numOf(it.qty))
      .map(it => ({ name: (it.name || '').trim(), spec: (it.spec || '').trim(), unit: (it.unit || '').trim(),
        qty: numOf(it.qty), unit_price: numOf(it.unit_price), amount: numOf(it.amount) || numOf(it.qty) * numOf(it.unit_price), memo: (it.memo || '').trim() }))
    if (!items.length) return toast.push('품목을 하나 이상 입력해주세요')
    const chosen = presets.find(p => p.is_default) || presets[0]
    const vendorObj = vendors.find(v => v.name === form.vendor_name.trim())
    const payload = {
      req_date: form.req_date || null, vendor_id: vendorObj?.id || null, vendor_name: form.vendor_name.trim(),
      order_source: form.order_source.trim(), ship_no: form.ship_no.trim(), summary: form.summary.trim(),
      arrival_date: form.arrival_date || null, order_amount: numOf(form.order_amount),
      pay_terms: form.pay_terms.trim(), man_hours: form.man_hours.trim(), note: form.note.trim(), items,
      approval: (form.approval && form.approval.length) ? form.approval
        : (chosen ? chosen.steps.map(s => ({ label: s.label, position: s.position || '', name: '' })) : undefined),
    }
    const res = isNew ? await api.createPurchaseReq(payload) : await api.updatePurchaseReq(doc.id, payload)
    if (!res.ok) return toast.push(res.error || '저장에 실패했어요')
    toast.push(isNew ? `구매품의서 ${res.req?.doc_no || ''}를 만들었어요` : '저장됐어요')
    setEdit(false); onSaved(isNew ? res.req?.id : doc.id)
  }
  const cancel = () => { if (isNew) return onCancelNew(); setEdit(false) }
  const remove = async () => {
    const ok = await confirm({ tone: 'neg', icon: <Icon.Warn size={22}/>, title: `${doc.doc_no} 삭제`, body: '이 구매품의서를 삭제할까요? 복구할 수 없어요.', confirmLabel: '삭제' })
    if (!ok) return
    const res = await api.deletePurchaseReq(doc.id)
    if (!res.ok) return toast.push(res.error || '삭제에 실패했어요')
    toast.push('삭제됐어요'); onDeleted()
  }
  const cell = (v) => (v || v === 0 ? v : '')

  return (
    <>
      <DocToolbar docNo={isNew ? '새 구매품의서' : doc.doc_no}
        status={!isNew && <span className="text-sm text-muted">품의금액 <b className="num">{fmtNum(total)}원</b></span>}>
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

      <DocViewport>
        <div className="doc-paper resolution-paper resolution-print" id="resolution-print">
          <div className="res-title-ko">구매품의서</div>
          <div className="res-title">購 買 稟 議 書</div>
          <div className="res-date num">{form.req_date || ''}</div>

          <table className="res-table res-head">
            <tbody>
              <tr>
                <th>구매품의NO</th><td className="num">{isNew ? '(자동)' : doc.doc_no}</td>
                <th>품의일자</th><td>{edit ? <CellIn value={form.req_date} onChange={v => setH('req_date', v)} placeholder="YYYY-MM-DD"/> : form.req_date}</td>
                <th>담당자</th><td>{doc?.applicant || ''}</td>
              </tr>
              <tr>
                <th>공급업체</th>
                <td>{edit
                  ? <Combobox value={form.vendor_name} onChange={v => setH('vendor_name', v)}
                      options={vendors.map(v => ({ value: v.name, label: v.name, sub: v.type || '' }))}
                      placeholder="공급업체 선택 또는 추가"
                      onAddNew={async (q) => { const name = await onVendorAdd(q); if (name) setH('vendor_name', name) }} addNewLabel="거래처로 추가"/>
                  : form.vendor_name}</td>
                <th>수주처</th><td>{edit ? <CellIn value={form.order_source} onChange={v => setH('order_source', v)} placeholder="예: 현대·한화·공용"/> : form.order_source}</td>
                <th>호선/작지</th><td>{edit ? <CellIn value={form.ship_no} onChange={v => setH('ship_no', v)}/> : form.ship_no}</td>
              </tr>
              <tr>
                <th>품명</th><td>{edit ? <CellIn value={form.summary} onChange={v => setH('summary', v)} placeholder="예: 사무실"/> : form.summary}</td>
                <th>입하일자</th><td>{edit ? <CellIn value={form.arrival_date} onChange={v => setH('arrival_date', v)} placeholder="YYYY-MM-DD"/> : form.arrival_date}</td>
                <th>지불조건</th><td>{edit ? <CellIn value={form.pay_terms} onChange={v => setH('pay_terms', v)} placeholder="예: 정기"/> : form.pay_terms}</td>
              </tr>
              <tr>
                <th>수주금액</th><td className="num">{edit ? <CellIn value={form.order_amount} onChange={v => setH('order_amount', v)} right/> : (form.order_amount ? fmtNum(numOf(form.order_amount)) : '')}</td>
                <th>품의금액</th><td className="num fw-700">{fmtNum(total)}</td>
                <th>소요M/H</th><td>{edit ? <CellIn value={form.man_hours} onChange={v => setH('man_hours', v)}/> : form.man_hours}</td>
              </tr>
            </tbody>
          </table>

          <div className="res-note-line">아래 내역과 같이 購買코자 하오니 稟議하오며 決裁하여 주시기 바랍니다.</div>

          <table className="res-table res-items">
            <thead>
              <tr>
                <th style={{ width: 34 }}>NO</th><th>품명 및 규격</th><th style={{ width: 48 }}>단위</th>
                <th style={{ width: 60 }}>수량</th><th style={{ width: 100 }}>단가</th><th style={{ width: 110 }}>금액</th><th style={{ width: 90 }}>비고</th>
              </tr>
            </thead>
            <tbody>
              {itemRows.map((it, i) => {
                const isGhost = edit && i === viewItems.length
                return (
                  <tr key={i}>
                    <td className="num" style={{ textAlign: 'center' }}>{it && (it.name || numOf(it.amount)) ? i + 1 : (edit ? '' : '')}</td>
                    <td>{edit ? <CellIn value={it?.name} onChange={v => setItem(i, 'name', v)} placeholder={isGhost ? '+ 품목' : ''}/> : cell(it.spec ? `${it.name} · ${it.spec}` : it.name)}</td>
                    <td style={{ textAlign: 'center' }}>{edit ? <CellIn value={it?.unit} onChange={v => setItem(i, 'unit', v)}/> : cell(it.unit)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{edit ? <CellIn value={it?.qty} onChange={v => setItem(i, 'qty', v)} right/> : (it.qty ? fmtNum(it.qty) : '')}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{edit ? <CellIn value={it?.unit_price} onChange={v => setItem(i, 'unit_price', v)} right/> : (it.unit_price ? fmtNum(it.unit_price) : '')}</td>
                    <td className="num fw-600" style={{ textAlign: 'right' }}>{(it && numOf(it.amount)) ? fmtNum(numOf(it.amount)) : ''}</td>
                    <td>{edit ? <CellIn value={it?.memo} onChange={v => setItem(i, 'memo', v)}/> : cell(it.memo)}</td>
                  </tr>
                )
              })}
              {Array.from({ length: padRows }).map((_, i) => (
                <tr key={`e${i}`}><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
              ))}
              <tr className="res-total">
                <th colSpan={5} style={{ textAlign: 'center' }}>합　계</th>
                <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(total)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>

          {edit && presets.length > 0 && (
            <div className="no-print row gap-6" style={{ margin: '10px 0 4px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="text-xs text-muted2">결재선</span>
              {presets.map(p => <button key={p.id} className="btn ghost sm" onClick={() => applyPreset(p)}>{p.name}</button>)}
            </div>
          )}
          <div className="res-foot">
            <div className="res-note">
              <div className="res-note-head">특기사항</div>
              <div className="res-note-body">{edit ? <input className="settle-cellin" value={form.note} onChange={e => setH('note', e.target.value)}/> : form.note}</div>
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

export const PurchaseReqScreen = () => {
  const toast = useToast()
  const [list, setList] = useState([])
  const [company, setCompany] = useState(null)
  const [vendors, setVendors] = useState([])
  const [selId, setSelId] = useState(null)
  const [sel, setSel] = useState(null)
  const [creating, setCreating] = useState(false)

  const load = async (keepId) => {
    const [rows, comp, vs] = await Promise.all([api.getPurchaseReqs(), api.getCompany(), api.getVendors()])
    setList(rows); setCompany(comp); setVendors(vs)
    setSelId(prev => {
      const want = keepId || prev
      return want && rows.some(r => r.id === want) ? want : (rows[0]?.id || null)
    })
  }
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (creating) return
    if (!selId) { setSel(null); return }
    api.getPurchaseReq(selId).then(setSel)
  }, [selId, creating])

  const addVendor = async (q) => {
    const res = await api.addVendor({ name: q, gubu: 'A' })
    if (res.ok) { setVendors(await api.getVendors()); toast.push(`"${q}" 거래처가 등록됐어요`); return q }
    toast.push(res.error || '거래처 등록에 실패했어요'); return ''
  }

  const blankDoc = { id: '__new', req_date: localToday(), items: [], approval: [] }

  return (
    <div className="fade-up">
      <PageHeader title="구매품의서"
        actions={<button className="btn primary" onClick={() => setCreating(true)}><Icon.Plus size={14}/> 새 구매품의서</button>}/>
      <DocWorkspace>
        <DocSide>
          {list.length === 0
            ? <DocSideEmpty>구매품의서가 없어요.<br/>'새 구매품의서'로 만드세요.</DocSideEmpty>
            : list.map(d => (
              <DocListRow key={d.id} active={!creating && selId === d.id} onClick={() => { setCreating(false); setSelId(d.id) }}
                docNo={d.doc_no} right={<span className="text-xs text-muted2">{d.req_date || ''}</span>}
                title={d.vendor_name || '—'} meta={d.summary || d.order_source || ''} amount={d.total || 0}/>
            ))}
        </DocSide>
        <DocMain>
          {creating
            ? <PurchaseReqPreview doc={blankDoc} company={company} vendors={vendors} onVendorAdd={addVendor} isNew
                onSaved={(id) => { setCreating(false); load(id) }} onCancelNew={() => setCreating(false)}/>
            : sel
              ? <PurchaseReqPreview key={sel.id} doc={sel} company={company} vendors={vendors} onVendorAdd={addVendor}
                  onSaved={(id) => load(id)} onDeleted={() => { setSelId(null); load() }}/>
              : <DocEmpty icon={<Icon.Receipt size={32} style={{ opacity: 0.3 }}/>}>왼쪽에서 구매품의서를 고르거나 새로 만드세요.</DocEmpty>}
        </DocMain>
      </DocWorkspace>
    </div>
  )
}
