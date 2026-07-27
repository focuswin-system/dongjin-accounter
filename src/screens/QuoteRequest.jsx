import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Combobox, localToday } from '../lib/ui'
import { api } from '../lib/api'
import { PageHeader } from '../lib/components/PageHeader'
import { DocWorkspace, DocSide, DocListRow, DocSideEmpty, DocMain, DocToolbar, DocViewport, DocEmpty } from '../lib/components/DocWorkspace'

const numOf = (v) => (typeof v === 'string' ? parseInt(v.replace(/[^0-9-]/g, ''), 10) || 0 : Number(v) || 0)
const ROWS = 15
const emptyItem = () => ({ code: '', name: '', unit: '', qty: '', unit_price: '', amount: '', memo: '' })

const CellIn = ({ value, onChange, right, placeholder }) => (
  <input className={`settle-cellin ${right ? 'num' : ''}`} value={value ?? ''} placeholder={placeholder}
    onChange={e => onChange(e.target.value)} style={right ? { textAlign: 'right' } : undefined}/>
)

const QuoteRequestPreview = ({ doc, company, vendors, onVendorAdd, isNew, onSaved, onCancelNew, onDeleted }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [edit, setEdit] = useState(!!isNew)
  const empty = () => ({ req_date: localToday(), vendor_code: '', vendor_name: '', order_source: '', ship_no: '',
    drawing: '', pay_terms: '', deliver_place: '', currency: 'WON', applicant: '', note: '', items: [emptyItem()] })
  const [form, setForm] = useState(empty())
  const [itemMaster, setItemMaster] = useState([])   // 품목 기준정보 — 행에서 골라 자재코드·규격·단위·단가 자동채움

  const reloadMaster = () => api.getRefItems('item').then(r => setItemMaster(r || []))
  useEffect(() => { reloadMaster() }, [])
  useEffect(() => {
    setEdit(!!isNew)
    if (!doc) { setForm(empty()); return }
    setForm({
      req_date: doc.req_date || localToday(), vendor_code: doc.vendor_code || '', vendor_name: doc.vendor_name || '',
      order_source: doc.order_source || '', ship_no: doc.ship_no || '', drawing: doc.drawing || '',
      pay_terms: doc.pay_terms || '', deliver_place: doc.deliver_place || (isNew ? (company?.name || '') : ''),
      currency: doc.currency || 'WON', applicant: doc.applicant || '', note: doc.note || '',
      items: (doc.items && doc.items.length ? doc.items : []).map(it => ({
        code: it.code || '', name: it.name || '', unit: it.unit || '', qty: it.qty ? String(it.qty) : '',
        unit_price: it.unit_price ? String(it.unit_price) : '', amount: it.amount ? String(it.amount) : '', memo: it.memo || '',
      })),
    })
  }, [doc?.id, isNew])

  const setH = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setItem = (i, field, v) => setForm(f => {
    const items = [...f.items]
    if (i === items.length) items.push(emptyItem())
    const it = { ...items[i], [field]: v }
    const qty = numOf(field === 'qty' ? v : it.qty)
    it.amount = String(qty * numOf(field === 'unit_price' ? v : it.unit_price))
    items[i] = it
    return { ...f, items }
  })
  // 품목 기준정보에서 고르면 자재코드·품명(＋규격)·단위·단가를 자동으로 채운다(계약·구매품의서와 동일 방식).
  const pickItem = (i, name) => setForm(f => {
    const items = [...f.items]
    if (i === items.length) items.push(emptyItem())
    const base = items[i]
    const m = itemMaster.find(x => x.name === name)
    if (m) {
      const nm = m.spec ? `${m.name} ${m.spec}` : m.name
      const qty = numOf(base.qty)
      const price = numOf(m.purchase_price) || numOf(base.unit_price)
      items[i] = { ...base, code: m.code || base.code, name: nm, unit: m.unit || base.unit,
        unit_price: m.purchase_price ? String(m.purchase_price) : base.unit_price, amount: String(qty * price) }
    } else {
      items[i] = { ...base, name }
    }
    return { ...f, items }
  })
  const addNewItem = async (i, q) => {
    const nm = (q || '').trim(); if (!nm) return
    await api.addRefItem({ type: 'item', name: nm })
    await reloadMaster()
    setItem(i, 'name', nm)
  }

  const viewItems = edit ? form.items : (doc?.items || [])
  const total = viewItems.reduce((s, it) => s + numOf(it.amount), 0)
  const itemRows = edit ? [...viewItems, emptyItem()] : viewItems
  const padRows = Math.max(0, ROWS - itemRows.length)
  const amt = (n) => (n ? fmtNum(n) : '')

  const save = async () => {
    const items = form.items.filter(it => (it.name || '').trim() || numOf(it.amount) || numOf(it.qty))
      .map(it => ({ code: (it.code || '').trim(), name: (it.name || '').trim(), unit: (it.unit || '').trim(),
        qty: numOf(it.qty), unit_price: numOf(it.unit_price), amount: numOf(it.amount) || numOf(it.qty) * numOf(it.unit_price), memo: (it.memo || '').trim() }))
    if (!items.length) return toast.push('품목을 하나 이상 입력해주세요')
    const vendorObj = vendors.find(v => v.name === form.vendor_name.trim())
    const payload = {
      req_date: form.req_date || null, vendor_id: vendorObj?.id || null, vendor_code: (form.vendor_code || vendorObj?.code || '').trim(),
      vendor_name: form.vendor_name.trim(), order_source: form.order_source.trim(), ship_no: form.ship_no.trim(),
      drawing: form.drawing.trim(), pay_terms: form.pay_terms.trim(), deliver_place: form.deliver_place.trim(),
      currency: form.currency.trim() || 'WON', applicant: form.applicant.trim(), note: form.note.trim(), items,
    }
    const res = isNew ? await api.createQuoteReq(payload) : await api.updateQuoteReq(doc.id, payload)
    if (!res.ok) return toast.push(res.error || '저장에 실패했어요')
    toast.push(isNew ? `견적요청서 ${res.req?.doc_no || ''}를 만들었어요` : '저장됐어요')
    setEdit(false); onSaved(isNew ? res.req?.id : doc.id)
  }
  const cancel = () => { if (isNew) return onCancelNew(); setEdit(false) }
  const remove = async () => {
    const ok = await confirm({ tone: 'neg', icon: <Icon.Warn size={22}/>, title: `${doc.doc_no} 삭제`, body: '이 견적요청서를 삭제할까요? 복구할 수 없어요.', confirmLabel: '삭제' })
    if (!ok) return
    const res = await api.deleteQuoteReq(doc.id)
    if (!res.ok) return toast.push(res.error || '삭제에 실패했어요')
    toast.push('삭제됐어요'); onDeleted()
  }

  return (
    <>
      <DocToolbar docNo={isNew ? '새 견적요청서' : doc.doc_no}
        status={!isNew && <span className="text-sm text-muted">합계금액 <b className="num">{fmtNum(total)}원</b></span>}>
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
          {/* 제목 + 좌상단 회사정보 */}
          <div className="qr-top">
            <div className="qr-corp">
              <div>본사·공장 : {company?.address || ''}</div>
              <div>TEL : {company?.phone || ''}</div>
              <div>FAX : {company?.fax || ''}</div>
            </div>
            <div className="qr-titles">
              <div className="res-title">견 적 요 청 서</div>
              <div className="qr-title-en">(REQUEST FOR QUOTATION)</div>
            </div>
          </div>

          {/* 헤더 A — 8칸(라벨행/값행) */}
          <table className="res-table pr-head">
            <thead>
              <tr>
                <th>공급업체코드</th><th>공급업체상호명</th><th>수주처</th><th>호선</th>
                <th>도면명</th><th>견적요청일자</th><th>담당자</th><th>통화단위</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{edit ? <CellIn value={form.vendor_code} onChange={v => setH('vendor_code', v)}/> : form.vendor_code}</td>
                <td>{edit
                  ? <Combobox value={form.vendor_name} onChange={v => setH('vendor_name', v)}
                      options={vendors.map(v => ({ value: v.name, label: v.name, sub: v.type || '' }))}
                      placeholder="공급업체 선택·추가"
                      onAddNew={async (q) => { const name = await onVendorAdd(q); if (name) setH('vendor_name', name) }} addNewLabel="거래처로 추가"/>
                  : form.vendor_name}</td>
                <td>{edit ? <CellIn value={form.order_source} onChange={v => setH('order_source', v)}/> : form.order_source}</td>
                <td>{edit ? <CellIn value={form.ship_no} onChange={v => setH('ship_no', v)}/> : form.ship_no}</td>
                <td>{edit ? <CellIn value={form.drawing} onChange={v => setH('drawing', v)}/> : form.drawing}</td>
                <td>{edit ? <CellIn value={form.req_date} onChange={v => setH('req_date', v)} placeholder="YYYY-MM-DD"/> : form.req_date}</td>
                <td>{edit ? <CellIn value={form.applicant} onChange={v => setH('applicant', v)}/> : (form.applicant || doc?.applicant || '')}</td>
                <td>{edit ? <CellIn value={form.currency} onChange={v => setH('currency', v)}/> : (form.currency || 'WON')}</td>
              </tr>
            </tbody>
          </table>

          {/* 헤더 B — 견적요청번호·지불조건·납품장소·합계금액·V.A.T */}
          <table className="res-table pr-head qr-head2">
            <tbody>
              <tr>
                <th>견적요청번호</th>
                <td className="num">{isNew ? '(자동)' : doc.doc_no}</td>
                <th>지불조건</th>
                <td>{edit ? <CellIn value={form.pay_terms} onChange={v => setH('pay_terms', v)}/> : form.pay_terms}</td>
                <th>납품장소</th>
                <td>{edit ? <CellIn value={form.deliver_place} onChange={v => setH('deliver_place', v)}/> : form.deliver_place}</td>
                <th>합계금액</th>
                <td className="num fw-700" style={{ textAlign: 'right' }}>{amt(total)}</td>
                <th>V.A.T</th>
                <td>별도</td>
              </tr>
            </tbody>
          </table>

          {/* 품목 — NO·자재코드·품명/규격·단위·수량·단가·금액·비고 */}
          <table className="res-table res-items pr-items">
            <thead>
              <tr>
                <th style={{ width: 30 }}>NO</th>
                <th style={{ width: 96 }}>자재코드</th>
                <th>품명 및 규격</th>
                <th style={{ width: 40 }}>단위</th>
                <th style={{ width: 52 }}>수량</th>
                <th style={{ width: 92 }}>단가</th>
                <th style={{ width: 104 }}>금액</th>
                <th style={{ width: 78 }}>비고</th>
              </tr>
            </thead>
            <tbody>
              {itemRows.map((it, i) => {
                const isGhost = edit && i === viewItems.length
                const has = it && (it.name || numOf(it.amount) || numOf(it.qty))
                return (
                  <tr key={i}>
                    <td className="num" style={{ textAlign: 'center' }}>{has ? i + 1 : ''}</td>
                    <td>{edit ? <CellIn value={it?.code} onChange={v => setItem(i, 'code', v)}/> : (it?.code || '')}</td>
                    <td className="pr-item-name">{edit
                      ? <Combobox value={it?.name || ''} onChange={v => pickItem(i, v)} onAddNew={q => addNewItem(i, q)}
                          options={itemMaster.map(m => ({ value: m.name, label: m.name,
                            sub: [m.code, m.spec, m.unit, m.purchase_price ? fmtNum(m.purchase_price) + '원' : ''].filter(Boolean).join(' · ') }))}
                          addNewLabel="새 품목 등록" placeholder={isGhost ? '+ 품목 선택·검색' : '품목'}/>
                      : (it?.name || '')}</td>
                    <td style={{ textAlign: 'center' }}>{edit ? <CellIn value={it?.unit} onChange={v => setItem(i, 'unit', v)}/> : (it?.unit || '')}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{edit ? <CellIn value={it?.qty} onChange={v => setItem(i, 'qty', v)} right/> : (it?.qty ? fmtNum(it.qty) : '')}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{edit ? <CellIn value={it?.unit_price} onChange={v => setItem(i, 'unit_price', v)} right/> : (it?.unit_price ? fmtNum(it.unit_price) : '')}</td>
                    <td className="num fw-600" style={{ textAlign: 'right' }}>{it && numOf(it.amount) ? fmtNum(numOf(it.amount)) : ''}</td>
                    <td>{edit ? <CellIn value={it?.memo} onChange={v => setItem(i, 'memo', v)}/> : (it?.memo || '')}</td>
                  </tr>
                )
              })}
              {Array.from({ length: padRows }).map((_, i) => (
                <tr key={`e${i}`}><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
              ))}
              <tr className="res-total">
                <th colSpan={6} style={{ textAlign: 'center' }}>합　계</th>
                <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(total)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>

          <div className="res-foot is-full">
            <div className="res-note">
              <div className="res-note-head">＊ 특기사항</div>
              <div className="res-note-body">{edit ? <input className="settle-cellin" value={form.note} onChange={e => setH('note', e.target.value)}/> : form.note}</div>
            </div>
          </div>
          <div className="res-company num">{company?.name || ''}</div>
        </div>
      </DocViewport>
    </>
  )
}

export const QuoteRequestScreen = () => {
  const toast = useToast()
  const [list, setList] = useState([])
  const [company, setCompany] = useState(null)
  const [vendors, setVendors] = useState([])
  const [selId, setSelId] = useState(null)
  const [sel, setSel] = useState(null)
  const [creating, setCreating] = useState(false)

  const load = async (keepId) => {
    const [rows, comp, vs] = await Promise.all([api.getQuoteReqs(), api.getCompany(), api.getVendors()])
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
    api.getQuoteReq(selId).then(setSel)
  }, [selId, creating])

  const addVendor = async (q) => {
    const res = await api.addVendor({ name: q, gubu: 'A' })
    if (res.ok) { setVendors(await api.getVendors()); toast.push(`"${q}" 거래처가 등록됐어요`); return q }
    toast.push(res.error || '거래처 등록에 실패했어요'); return ''
  }

  const blankDoc = { id: '__new', req_date: localToday(), items: [] }

  return (
    <div className="fade-up">
      <PageHeader title="견적요청서"
        actions={<button className="btn primary" onClick={() => setCreating(true)}><Icon.Plus size={14}/> 새 견적요청서</button>}/>
      <DocWorkspace>
        <DocSide>
          {list.length === 0
            ? <DocSideEmpty>견적요청서가 없어요.<br/>'새 견적요청서'로 만드세요.</DocSideEmpty>
            : list.map(d => (
              <DocListRow key={d.id} active={!creating && selId === d.id} onClick={() => { setCreating(false); setSelId(d.id) }}
                docNo={d.doc_no} right={<span className="text-xs text-muted2">{d.req_date || ''}</span>}
                title={d.vendor_name || d.order_source || '—'} meta={d.drawing || ''} amount={d.total || 0}/>
            ))}
        </DocSide>
        <DocMain>
          {creating
            ? <QuoteRequestPreview doc={blankDoc} company={company} vendors={vendors} onVendorAdd={addVendor} isNew
                onSaved={(id) => { setCreating(false); load(id) }} onCancelNew={() => setCreating(false)}/>
            : sel
              ? <QuoteRequestPreview key={sel.id} doc={sel} company={company} vendors={vendors} onVendorAdd={addVendor}
                  onSaved={(id) => load(id)} onDeleted={() => { setSelId(null); load() }}/>
              : <DocEmpty icon={<Icon.Doc size={32} style={{ opacity: 0.3 }}/>}>왼쪽에서 견적요청서를 고르거나 새로 만드세요.</DocEmpty>}
        </DocMain>
      </DocWorkspace>
    </div>
  )
}
