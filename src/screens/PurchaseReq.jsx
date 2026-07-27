import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Combobox, localToday, MoneyInput, Drawer } from '../lib/ui'
import { api } from '../lib/api'
import { PageHeader } from '../lib/components/PageHeader'
import { DocWorkspace, DocSide, DocListRow, DocSideEmpty, DocMain, DocToolbar, DocViewport, DocEmpty } from '../lib/components/DocWorkspace'

const numOf = (v) => (typeof v === 'string' ? parseInt(v.replace(/[^0-9-]/g, ''), 10) || 0 : Number(v) || 0)
const ROWS = 15
const emptyItem = () => ({ name: '', unit: '', qty: '', unit_price: '', amount: '', actual_price: '', actual_amount: '', memo: '' })

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
  const [itemMaster, setItemMaster] = useState([])   // 품목 기준정보 — 행에서 골라 규격·단위·매입단가 자동채움
  const [payOpen, setPayOpen] = useState(false)      // 미지급금 등록 다이얼로그
  const [paySupply, setPaySupply] = useState('')
  const [payVat, setPayVat] = useState('과세')
  const [payDue, setPayDue] = useState('')

  const reloadMaster = () => api.getRefItems('item').then(r => setItemMaster(r || []))
  useEffect(() => { api.getApprovalPresets().then(setPresets); reloadMaster() }, [])
  useEffect(() => {
    setEdit(!!isNew)
    if (!doc) { setForm(empty()); return }
    setForm({
      req_date: doc.req_date || localToday(), vendor_name: doc.vendor_name || '', order_source: doc.order_source || '',
      ship_no: doc.ship_no || '', summary: doc.summary || '', arrival_date: doc.arrival_date || '',
      order_amount: doc.order_amount ? String(doc.order_amount) : '', pay_terms: doc.pay_terms || '', man_hours: doc.man_hours || '',
      note: doc.note || '',
      items: (doc.items && doc.items.length ? doc.items : []).map(it => ({
        name: it.name || '', unit: it.unit || '', qty: it.qty ? String(it.qty) : '',
        unit_price: it.unit_price ? String(it.unit_price) : '', amount: it.amount ? String(it.amount) : '',
        actual_price: it.actual_price ? String(it.actual_price) : '', actual_amount: it.actual_amount ? String(it.actual_amount) : '', memo: it.memo || '',
      })),
      approval: (doc.approval && doc.approval.length) ? doc.approval : [],
    })
  }, [doc?.id, isNew])

  const setH = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setItem = (i, field, v) => setForm(f => {
    const items = [...f.items]
    if (i === items.length) items.push(emptyItem())
    const it = { ...items[i], [field]: v }
    const qty = numOf(field === 'qty' ? v : it.qty)
    it.amount = String(qty * numOf(field === 'unit_price' ? v : it.unit_price))
    it.actual_amount = String(qty * numOf(field === 'actual_price' ? v : it.actual_price))
    items[i] = it
    return { ...f, items }
  })
  // 품목 기준정보에서 고르면 품명(＋규격)·단위·견적단가(매입가)를 자동으로 채운다.
  // 매 키 입력마다 호출되며, 입력값이 품목명과 정확히 일치할 때만 자동채움(계약 화면과 동일 방식).
  const pickItem = (i, name) => setForm(f => {
    const items = [...f.items]
    if (i === items.length) items.push(emptyItem())
    const base = items[i]
    const m = itemMaster.find(x => x.name === name)
    if (m) {
      const nm = m.spec ? `${m.name} ${m.spec}` : m.name
      const qty = numOf(base.qty)
      const price = numOf(m.purchase_price) || numOf(base.unit_price)
      items[i] = { ...base, name: nm, unit: m.unit || base.unit,
        unit_price: m.purchase_price ? String(m.purchase_price) : base.unit_price,
        amount: String(qty * price) }
    } else {
      items[i] = { ...base, name }
    }
    return { ...f, items }
  })
  // 목록에 없는 품목은 기준정보에 새로 등록하고 이 행에 채운다(계약·거래처 인라인 추가와 동일).
  const addNewItem = async (i, q) => {
    const nm = (q || '').trim(); if (!nm) return
    await api.addRefItem({ type: 'item', name: nm })
    await reloadMaster()
    setItem(i, 'name', nm)
  }

  const viewItems = edit ? form.items : (doc?.items || [])
  const total = viewItems.reduce((s, it) => s + numOf(it.amount), 0)          // 품의금액 = 견적 금액 합
  const ceo = company?.ceo || '대표이사'
  const defApproval = [{ label: '담당' }, { label: '부장' }, { label: '이사' }, { label: '대표이사' }, { label: '대표이사', position: ceo }]
  const approval = edit ? (form.approval && form.approval.length ? form.approval : defApproval) : (doc?.approval && doc.approval.length ? doc.approval : defApproval)
  const applyPreset = (p) => setForm(f => ({ ...f, approval: (p.steps || []).map(s => ({ label: s.label, position: s.position || '', name: '' })) }))
  const itemRows = edit ? [...viewItems, emptyItem()] : viewItems
  const padRows = Math.max(0, ROWS - itemRows.length)
  const vendorLabel = form.vendor_name || '견적가'

  const save = async () => {
    const items = form.items.filter(it => (it.name || '').trim() || numOf(it.amount) || numOf(it.qty))
      .map(it => ({ name: (it.name || '').trim(), unit: (it.unit || '').trim(), qty: numOf(it.qty),
        unit_price: numOf(it.unit_price), amount: numOf(it.amount) || numOf(it.qty) * numOf(it.unit_price),
        actual_price: numOf(it.actual_price), actual_amount: numOf(it.actual_amount) || numOf(it.qty) * numOf(it.actual_price), memo: (it.memo || '').trim() }))
    if (!items.length) return toast.push('품목을 하나 이상 입력해주세요')
    const vendorObj = vendors.find(v => v.name === form.vendor_name.trim())
    const payload = {
      req_date: form.req_date || null, vendor_id: vendorObj?.id || null, vendor_name: form.vendor_name.trim(),
      order_source: form.order_source.trim(), ship_no: form.ship_no.trim(), summary: form.summary.trim(),
      arrival_date: form.arrival_date || null, order_amount: numOf(form.order_amount),
      pay_terms: form.pay_terms.trim(), man_hours: form.man_hours.trim(), note: form.note.trim(), items,
      approval,   // 화면에 보이는 결재선(form.approval 없으면 defApproval)을 그대로 저장 — WYSIWYG
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
  const amt = (n) => (n ? fmtNum(n) : '')

  // ── 미지급금 등록 ──
  const due30 = () => { const d = new Date(); d.setDate(d.getDate() + 30); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
  const openPay = () => { setPaySupply(String(total)); setPayVat('과세'); setPayDue(due30()); setPayOpen(true) }
  const paySupplyN = numOf(paySupply)
  const payVatAmt = payVat === '과세' ? Math.round(paySupplyN * 0.1) : 0
  const submitPayable = async () => {
    if (!paySupplyN) return toast.push('공급가를 입력해주세요')
    const res = await api.issuePurchaseReqPayable(doc.id, { supply_amount: paySupplyN, vat_mode: payVat, due: payDue || null })
    if (!res.ok) return toast.push(res.error || '등록에 실패했어요')
    toast.push(`미지급금 ${res.invoice_no}로 등록됐어요`)
    setPayOpen(false); onSaved(doc.id)
  }

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
            {doc?.payable
              ? <span className="chip" title={`합계 ${fmtNum(doc.payable.total)}원`}><Icon.Check size={12}/> 미지급 {doc.payable.invoice_no} · {doc.payable.status}</span>
              : <button className="btn" onClick={openPay}><Icon.Receipt size={14}/> 미지급금 등록</button>}
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
          <div className="pr-date num">품의일자 {edit ? <input className="settle-cellin" style={{ width: 110, display: 'inline-block' }} value={form.req_date} onChange={e => setH('req_date', e.target.value)} placeholder="YYYY-MM-DD"/> : form.req_date}</div>

          {/* 헤더 — 가로 표(라벨행 + 값행), 품의금액은 금번/누계 */}
          <table className="res-table pr-head">
            <thead>
              <tr>
                <th rowSpan={2}>구매품의NO</th><th rowSpan={2}>수주처</th><th rowSpan={2}>호선NO</th>
                <th rowSpan={2}>품명</th><th rowSpan={2}>입하일자</th><th rowSpan={2}>수주금액</th>
                <th colSpan={2}>품의금액</th>
                <th rowSpan={2}>지불조건</th><th rowSpan={2}>소요M/H</th><th rowSpan={2}>담당자</th>
              </tr>
              <tr><th>금번</th><th>누계</th></tr>
            </thead>
            <tbody>
              <tr>
                <td className="num">{isNew ? '(자동)' : doc.doc_no}</td>
                <td>{edit ? <CellIn value={form.order_source} onChange={v => setH('order_source', v)}/> : form.order_source}</td>
                <td>{edit ? <CellIn value={form.ship_no} onChange={v => setH('ship_no', v)}/> : form.ship_no}</td>
                <td>{edit ? <CellIn value={form.summary} onChange={v => setH('summary', v)}/> : form.summary}</td>
                <td>{edit ? <CellIn value={form.arrival_date} onChange={v => setH('arrival_date', v)} placeholder="YYYY-MM-DD"/> : form.arrival_date}</td>
                <td className="num" style={{ textAlign: 'right' }}>{edit ? <CellIn value={form.order_amount} onChange={v => setH('order_amount', v)} right/> : (form.order_amount ? fmtNum(numOf(form.order_amount)) : '')}</td>
                <td className="num fw-700" style={{ textAlign: 'right' }}>{amt(total)}</td>
                <td className="num" style={{ textAlign: 'right' }}>{amt(total)}</td>
                <td>{edit ? <CellIn value={form.pay_terms} onChange={v => setH('pay_terms', v)}/> : form.pay_terms}</td>
                <td>{edit ? <CellIn value={form.man_hours} onChange={v => setH('man_hours', v)}/> : form.man_hours}</td>
                <td>{doc?.applicant || ''}</td>
              </tr>
            </tbody>
          </table>

          <div className="res-note-line">아래 내역과 같이 購買코자 하오니 稟議하오며 決裁하여 주시기 바랍니다.</div>

          {/* 품목 — 이중 단가(공급업체 견적 / 실적가) */}
          <table className="res-table res-items pr-items">
            <thead>
              <tr>
                <th rowSpan={2} style={{ width: 30 }}>NO</th>
                <th rowSpan={2}>품명 및 규격</th>
                <th rowSpan={2} style={{ width: 40 }}>단위</th>
                <th rowSpan={2} style={{ width: 52 }}>수량</th>
                <th colSpan={2}>{edit
                  ? <Combobox value={form.vendor_name} onChange={v => setH('vendor_name', v)}
                      options={vendors.map(v => ({ value: v.name, label: v.name, sub: v.type || '' }))}
                      placeholder="공급업체(견적처) 선택·추가"
                      onAddNew={async (q) => { const name = await onVendorAdd(q); if (name) setH('vendor_name', name) }} addNewLabel="거래처로 추가"/>
                  : vendorLabel}</th>
                <th colSpan={2}>실적가</th>
                <th rowSpan={2} style={{ width: 64 }}>비고</th>
              </tr>
              <tr>
                <th style={{ width: 78 }}>단가</th><th style={{ width: 92 }}>금액</th>
                <th style={{ width: 78 }}>단가</th><th style={{ width: 92 }}>금액</th>
              </tr>
            </thead>
            <tbody>
              {itemRows.map((it, i) => {
                const isGhost = edit && i === viewItems.length
                const has = it && (it.name || numOf(it.amount) || numOf(it.qty))
                return (
                  <tr key={i}>
                    <td className="num" style={{ textAlign: 'center' }}>{has ? i + 1 : ''}</td>
                    <td className="pr-item-name">{edit
                      ? <Combobox value={it?.name || ''} onChange={v => pickItem(i, v)} onAddNew={q => addNewItem(i, q)}
                          options={itemMaster.map(m => ({ value: m.name, label: m.name,
                            sub: [m.spec, m.unit, m.purchase_price ? fmtNum(m.purchase_price) + '원' : ''].filter(Boolean).join(' · ') }))}
                          addNewLabel="새 품목 등록" placeholder={isGhost ? '+ 품목 선택·검색' : '품목'}/>
                      : (it?.name || '')}</td>
                    <td style={{ textAlign: 'center' }}>{edit ? <CellIn value={it?.unit} onChange={v => setItem(i, 'unit', v)}/> : (it?.unit || '')}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{edit ? <CellIn value={it?.qty} onChange={v => setItem(i, 'qty', v)} right/> : (it?.qty ? fmtNum(it.qty) : '')}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{edit ? <CellIn value={it?.unit_price} onChange={v => setItem(i, 'unit_price', v)} right/> : (it?.unit_price ? fmtNum(it.unit_price) : '')}</td>
                    <td className="num fw-600" style={{ textAlign: 'right' }}>{it && numOf(it.amount) ? fmtNum(numOf(it.amount)) : ''}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{edit ? <CellIn value={it?.actual_price} onChange={v => setItem(i, 'actual_price', v)} right/> : (it?.actual_price ? fmtNum(it.actual_price) : '')}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{it && numOf(it.actual_amount) ? fmtNum(numOf(it.actual_amount)) : ''}</td>
                    <td>{edit ? <CellIn value={it?.memo} onChange={v => setItem(i, 'memo', v)}/> : (it?.memo || '')}</td>
                  </tr>
                )
              })}
              {Array.from({ length: padRows }).map((_, i) => (
                <tr key={`e${i}`}><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
              ))}
              <tr className="res-total">
                <th colSpan={5} style={{ textAlign: 'center' }}>합　계</th>
                <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(total)}</td>
                <td></td>
                <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(viewItems.reduce((s, it) => s + numOf(it.actual_amount), 0))}</td>
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

      <Drawer open={payOpen} onClose={() => setPayOpen(false)} width="min(420px, 100vw)" label="미지급금 등록">
        <div className="col gap-16" style={{ padding: 20 }}>
          <div className="text-sm text-muted2">이 구매품의서를 매입 청구서(미지급금)로 등록합니다. 미지급금·부가세 매입세액·지급결의서에 반영돼요.</div>
          <div>
            <label className="label" style={{ marginBottom: 6, display: 'block' }}>공급가</label>
            <MoneyInput value={paySupply} onChange={setPaySupply}/>
          </div>
          <div>
            <label className="label" style={{ marginBottom: 6, display: 'block' }}>과세유형</label>
            <div className="row gap-6">
              {['과세', '면세', '영세'].map(t => (
                <button key={t} type="button" className={`chip ${payVat === t ? 'active' : ''}`} onClick={() => setPayVat(t)}>{t}</button>
              ))}
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 8 }}>
              {payVat === '과세' ? '공급가 + VAT 10%' : payVat === '면세' ? '세액 없음' : '영세율(세액 0, 과세표준 포함)'}
              {' · 세액 '}<b className="num">{fmtNum(payVatAmt)}</b>{' · 합계 '}<b className="num">{fmtNum(paySupplyN + payVatAmt)}원</b>
            </div>
          </div>
          <div>
            <label className="label" style={{ marginBottom: 6, display: 'block' }}>지급 예정일</label>
            <input className="input" type="date" value={payDue} onChange={e => setPayDue(e.target.value)}/>
          </div>
          <div className="row gap-8" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
            <button className="btn" onClick={() => setPayOpen(false)}>취소</button>
            <button className="btn primary" onClick={submitPayable}><Icon.Check size={14}/> 미지급금 등록</button>
          </div>
        </div>
      </Drawer>
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
    const want = keepId || selId
    const nextId = want && rows.some(r => r.id === want) ? want : (rows[0]?.id || null)
    setSelId(nextId)
    // 선택 id가 그대로여도 상세를 다시 읽는다 — 미지급금 등록 후 payable 상태 최신화
    if (nextId) api.getPurchaseReq(nextId).then(setSel); else setSel(null)
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
                title={d.vendor_name || d.summary || '—'} meta={d.order_source || ''} amount={d.total || 0}/>
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
