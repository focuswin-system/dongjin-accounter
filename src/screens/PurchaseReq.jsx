import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Combobox, localToday, MoneyInput, Drawer, DateInput, StatusBadge } from '../lib/ui'
import { api } from '../lib/api'
import { PageHeader } from '../lib/components/PageHeader'
import { DocWorkspace, DocSide, DocListRow, DocSideEmpty, DocMain, DocToolbar, DocViewport, DocEmpty } from '../lib/components/DocWorkspace'
import { SourceChooser } from '../lib/components/SourceChooser'
import { PickListDrawer } from '../lib/components/PickListDrawer'
import { vatOf } from '../lib/vatRate'
import { makeGridKeyHandler } from '../lib/gridKeys'

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
  /* applicant(담당자) — 새로 만들 때는 비워 둔다. 서버가 비면 로그인한 사람 이름을 넣는다
     (routes/purchase-reqs.js). 그래서 기본값을 여기서 또 정하지 않는다 — 두 곳이 정하면 갈린다. */
  const empty = () => ({ req_date: localToday(), vendor_name: '', order_source: '', ship_no: '', summary: '',
    arrival_date: '', order_amount: '', pay_terms: '', man_hours: '', applicant: '', note: '', items: [emptyItem()], approval: [] })
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
      applicant: doc.applicant || '', note: doc.note || '',
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
  /* 마지막 줄에서 Enter → 줄 추가. setItem 이 이미 "i === items.length 면 한 줄 민다"를
     하고 있어, 빈 줄을 하나 더해 두면 다음 입력이 그 자리에 들어간다. */
  const gridKeys = makeGridKeyHandler(() => setForm(f => ({ ...f, items: [...f.items, emptyItem()] })))

  // 품목 기준정보에서 고르면 품명(＋규격)·단위·견적단가(매입가)를 자동으로 채운다.
  // 매 키 입력마다 호출되며, 입력값이 품목명과 정확히 일치할 때만 자동채움(주문 화면과 동일 방식).
  const pickItem = (i, name) => setForm(f => {
    const items = [...f.items]
    if (i === items.length) items.push(emptyItem())
    const base = items[i]
    // id 로 찾는다 — 이름이 같고 규격만 다른 품목(도면 개정 등)이면 이름 매칭은 늘 첫 번째를 집어
    // 다른 개정판의 단위·단가가 들어가고 품명에도 엉뚱한 규격이 붙는다.
    const m = itemMaster.find(x => String(x.id) === String(name))
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
  // 목록에 없는 품목은 기준정보에 새로 등록하고 이 행에 채운다(주문·거래처 인라인 추가와 동일).
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
      pay_terms: form.pay_terms.trim(), man_hours: form.man_hours.trim(),
      applicant: form.applicant.trim(), note: form.note.trim(), items,
      approval,   // 화면에 보이는 결재선(form.approval 없으면 defApproval)을 그대로 저장 — WYSIWYG
    }
    const res = isNew ? await api.createPurchaseReq(payload) : await api.updatePurchaseReq(doc.id, payload)
    if (!res.ok) return toast.push(res.error || '저장에 실패했어요', { tone: 'warn' })
    toast.push(isNew ? `구매품의서 ${res.req?.doc_no || ''}를 만들었어요` : '저장됐어요')
    setEdit(false); onSaved(isNew ? res.req?.id : doc.id)
  }
  const cancel = () => { if (isNew) return onCancelNew(); setEdit(false) }
  const remove = async () => {
    const ok = await confirm({ tone: 'neg', icon: <Icon.Warn size={22}/>, title: `${doc.doc_no} 삭제`, body: '이 구매품의서를 삭제할까요? 복구할 수 없어요.', confirmLabel: '삭제' })
    if (!ok) return
    const res = await api.deletePurchaseReq(doc.id)
    if (!res.ok) return toast.push(res.error || '삭제에 실패했어요', { tone: 'warn' })
    toast.push('삭제됐어요'); onDeleted()
  }
  const amt = (n) => (n ? fmtNum(n) : '')

  // ── 미지급금 등록 ──
  const due30 = () => { const d = new Date(); d.setDate(d.getDate() + 30); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }
  /* 공급업체(거래처)가 없으면 서버가 등록을 거절한다. 예전엔 그걸 모른 채 창이 열려
     금액·과세유형·지급예정일을 다 채우고 누른 **뒤에야** 거절당했다.
     못 할 일이면 시작하기 전에 알려주는 편이 낫다 — 헛일을 시키지 않는다. */
  const openPay = () => {
    if (!doc?.vendor_id) {
      return toast.push('공급업체를 먼저 거래처로 지정해주세요. 편집에서 공급업체를 고르면 돼요.', { tone: 'warn' })
    }
    setPaySupply(String(total)); setPayVat('과세'); setPayDue(due30()); setPayOpen(true)
  }
  const paySupplyN = numOf(paySupply)
  const payVatAmt = payVat === '과세' ? vatOf(paySupplyN) : 0
  /* 승인 게이트 — 승인해야 미지급금을 등록할 수 있다. 누가·언제는 서버 감사기록에 남는다. */
  const approve = async () => {
    const res = await api.approvePurchaseReq(doc.id)
    if (!res.ok) return toast.push(res.error || '승인에 실패했어요', { tone: 'warn' })
    toast.push('승인했어요'); onSaved(doc.id)
  }
  const unapprove = async () => {
    const res = await api.unapprovePurchaseReq(doc.id)
    if (!res.ok) return toast.push(res.error || '되돌리지 못했어요', { tone: 'warn' })
    toast.push('작성 상태로 되돌렸어요'); onSaved(doc.id)
  }

  const submitPayable = async (force = false) => {
    if (!paySupplyN) return toast.push('공급가를 입력해주세요')
    const res = await api.issuePurchaseReqPayable(doc.id, { supply_amount: paySupplyN, vat_mode: payVat, due: payDue || null, force })
    if (!res.ok) {
      /* 중복이면 그냥 막지 않는다 — 같은 지출이 이미 있을 수 있다고 알려주고, 사람이 확인하면 등록한다.
         (진짜 다른 지출인데 금액만 겹칠 수도 있어, 판단은 사람이 한다) */
      if (res.code === 'duplicate' && res.duplicates?.length) {
        const ok = await confirm({
          tone: 'warn', icon: <Icon.Warn size={22}/>, title: '이미 비슷한 지출이 있어요',
          body: (
            <div>같은 거래처에 금액이 겹치는 게 있어요:
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
                {res.duplicates.map((d, i) => (
                  <li key={i}><b>{d.label}</b> {d.ref} · {d.date} · <span className="num">{fmtNum(d.amount)}원</span></li>
                ))}
              </ul>
            </div>
          ),
          detail: '같은 지출을 두 번 잡는 것일 수 있어요. 그래도 미지급금으로 등록할까요?',
          confirmLabel: '그래도 등록',
        })
        if (ok) return submitPayable(true)
        return
      }
      return toast.push(res.error || '등록에 실패했어요', { tone: 'warn' })
    }
    toast.push(`미지급금 ${res.invoice_no}로 등록됐어요`)
    setPayOpen(false); onSaved(doc.id)
  }

  return (
    <>
      <DocToolbar docNo={isNew ? '새 구매품의서' : doc.doc_no}
        status={!isNew && <span className="row gap-8" style={{ alignItems: 'center' }}>
          {/* 등록됐으면 '등록', 아니면 상태(작성/승인). 옛 데이터는 status 가 비어 '작성'으로 본다. */}
          <StatusBadge status={doc?.payable ? '등록' : (doc?.status || '작성')}/>
          <span className="text-sm text-muted">품의금액 <b className="num">{fmtNum(total)}원</b></span>
        </span>}>
        {edit ? (
          <>
            <button className="btn" onClick={cancel}>취소</button>
            <button className="btn primary" onClick={save}><Icon.Check size={14}/> 저장</button>
          </>
        ) : (
          <>
            {doc?.payable ? (
              <span className="chip" title={`합계 ${fmtNum(doc.payable.total)}원`}><Icon.Check size={12}/> 미지급 {doc.payable.invoice_no} · {doc.payable.status}</span>
            ) : doc?.status === '승인' ? (
              <>
                <button className="btn ghost sm" onClick={unapprove}>승인 취소</button>
                <button className="btn primary" onClick={openPay}><Icon.Receipt size={14}/> 미지급금 등록</button>
              </>
            ) : (
              /* 아직 승인 전 — 먼저 승인해야 미지급금을 등록할 수 있다(결재 없이 돈이 잡히는 걸 막는다) */
              <button className="btn primary" onClick={approve}><Icon.Check size={14}/> 승인</button>
            )}
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
                {/* 담당자 — 옆 칸들과 같이 고칠 수 있어야 한다. 문서를 대신 쓰거나
                    담당이 바뀌는 일이 흔한데 여기만 읽기 전용이었다(견적요청서는 이미 편집된다). */}
                <td>{edit ? <CellIn value={form.applicant} onChange={v => setH('applicant', v)}/> : (form.applicant || doc?.applicant || '')}</td>
              </tr>
            </tbody>
          </table>

          <div className="res-note-line">아래 내역과 같이 購買코자 하오니 稟議하오며 決裁하여 주시기 바랍니다.</div>

          {/* 품목 — 이중 단가(공급업체 견적 / 실적가) */}
          {/* 키보드로 다닌다 — Enter 로 아래 줄(마지막이면 줄이 하나 더 생긴다), ↑↓ 로 위아래.
              품목이 열 줄이면 칸이 팔십 개다. 손이 자판을 떠나면 속도가 절반이 된다. */}
          <table className="res-table res-items pr-items" onKeyDown={gridKeys}>
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
                          options={itemMaster.map(m => ({ value: m.id, label: m.name,
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
            <DateInput className="input" value={payDue} onChange={e => setPayDue(e.target.value)}/>
          </div>
          <div className="row gap-8" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
            <button className="btn" onClick={() => setPayOpen(false)}>취소</button>
            <button className="btn primary" onClick={() => submitPayable()}><Icon.Check size={14}/> 미지급금 등록</button>
          </div>
        </div>
      </Drawer>
    </>
  )
}

/* 구매품의서를 어디서 만들까 — "무엇을 얼마에 살지" 결재를 받는 문서다.
   그 답은 대개 **이미 받아 둔 견적**에 있다. 견적요청서를 끊어 놓고 품의서에는
   같은 품목을 손으로 다시 적고 있었다. */
const PREQ_SOURCES = [
  {
    id: 'quote', icon: Icon.Receipt,
    label: '견적요청서에서',
    desc: '견적을 요청해 둔 건을 그대로 품의로 올려요',
    effect: '거래처와 품목·단가가 그대로 옮겨져요. 받은 단가가 다르면 그 자리에서 고치면 돼요.',
  },
  /* 받은 세금계산서를 품의로 — **이게 정상 순서다.**
     물건을 받고 계산서를 받으면 미지급금이 잡히고, 그걸 결재 올려 지급한다.
     거래내역(이미 나간 돈)에서만 가져올 수 있으면 "돈이 나간 뒤에야 품의"가 된다.
     청구서에는 품목이 직접 달려 있어 거래를 거쳐 되짚을 필요도 없다. */
  {
    id: 'invoice', icon: Icon.Receipt,
    label: '받은 청구서에서',
    desc: '아직 지급하지 않은 매입 건을 가져와요',
    effect: '거래처와 품목이 그대로 옮겨져요. 결재가 나면 그 청구서로 지급하면 됩니다.',
  },
  /* 이미 산 것을 품의로 — 급하게 먼저 사고 결재를 나중에 올리는 일도 흔하다.
     그때 거래내역에 이미 적어 둔 것을 손으로 다시 옮겨 적고 있었다. */
  {
    id: 'txn', icon: Icon.Bank,
    label: '거래내역에서 골라서',
    desc: '이미 기록한 지출을 여러 건 가져와요',
    effect: '고른 지출이 품목 줄로 채워져요. 거래처·금액이 그대로 오고, 수량은 1로 둡니다.',
  },
  {
    id: 'item', icon: Icon.Copy,
    label: '품목에서 골라서',
    desc: '기준정보에 등록된 품목을 여러 개 담아요',
    effect: '규격·단위·매입단가가 채워져요. 수량만 적으면 돼요.',
  },
  {
    id: 'blank', icon: Icon.Pencil,
    label: '직접 작성',
    desc: '빈 양식에서 시작해요',
    effect: '품목을 하나씩 적어요.',
  },
]

export const PurchaseReqScreen = () => {
  const toast = useToast()
  const [srcOpen, setSrcOpen] = useState(false)
  const [pick, setPick] = useState(null)      // 'quote' | 'item' | null
  const [rows, setRows] = useState(null)
  /* 새 문서에 미리 채워 넣을 값 (Settlement·QuoteRequest 와 같은 방식) */
  const [seed, setSeed] = useState({ items: [] })
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
    toast.push(res.error || '거래처 등록에 실패했어요', { tone: 'warn' }); return ''
  }

  /* ⚠ seed 를 펼쳐 넣는다 — 견적에서 오면 품목뿐 아니라 거래처·건명도 함께 온다.
     items 만 채우면 사용자가 거래처를 다시 고르게 되어 '가져온' 느낌이 안 난다. */
  const blankDoc = { id: '__new', req_date: localToday(), approval: [], items: [], ...seed }

  return (
    <div className="fade-up doc-screen">
      <PageHeader title="구매품의서"
        actions={<button className="btn primary" onClick={() => setSrcOpen(true)}><Icon.Plus size={14}/> 새 구매품의서</button>}/>

      <SourceChooser
        open={srcOpen} onClose={() => setSrcOpen(false)}
        title="새 구매품의서" sub="어디서 만들까요?"
        options={PREQ_SOURCES}
        onPick={(id) => {
          setSrcOpen(false)
          if (id === 'blank') { setSeed({ items: [] }); setCreating(true); return }
          setRows(null); setPick(id)
          if (id === 'quote') api.getQuoteReqs().then(r => setRows(r || []))
          /* 매입 청구서 — 목록이 품목(lines)까지 함께 준다(서버 attachMatchesBulk).
             그래서 고른 뒤 상세를 다시 읽지 않아도 된다. */
          else if (id === 'invoice') api.getInvoices({ kind: 'received' }).then(r => setRows(r || []))
          // 지출 전체를 받아 화면에서 거른다 — 품의는 보통 최근 몇 달치를 훑어 고른다(정산내역서와 같은 방식)
          else if (id === 'txn') api.getTransactions({ kind: 'expense' }).then(r => setRows(r || []))
          else api.getRefItems('item').then(r => setRows(r || []))
        }}/>

      {/* 견적요청서에서 — 한 건만 고른다(견적 하나 = 품의 하나). 목록에는 품목이 없어
          고른 뒤에 상세를 한 번 더 읽는다. */}
      <PickListDrawer
        single
        open={pick === 'quote'} onClose={() => setPick(null)}
        title="견적요청서에서" sub="어느 견적을 품의로 올릴까요?"
        placeholder="거래처·문서번호 검색"
        rows={rows}
        match={(r, q) => [r.vendor_name, r.doc_no, r.order_source].filter(Boolean)
          .some(v => String(v).toLowerCase().includes(q.toLowerCase()))}
        render={(r) => ({
          title: r.vendor_name || '거래처 없음',
          sub: [r.doc_no, r.req_date, r.order_source].filter(Boolean).join(' · '),
          right: Number(r.total_amount) || null,
        })}
        empty="견적요청서가 없어요. 먼저 견적을 요청하세요."
        onDone={async ([r]) => {
          const full = await api.getQuoteReq(r.id)
          if (!full) { setPick(null); return toast.push('견적을 불러오지 못했어요', { tone: 'warn' }) }
          setSeed({
            vendor_name: full.vendor_name || '',
            order_source: full.order_source || '',
            ship_no: full.ship_no || '',
            /* 어느 견적에서 왔는지 남긴다 — 품의서를 결재하는 사람이 근거를 되짚을 수 있어야 한다 */
            summary: full.doc_no ? `견적요청서 ${full.doc_no}` : '',
            /* ⚠ 구매품의서 품목에는 자재코드 칸이 없다(견적요청서에만 있다).
               실단가·실금액은 비워 둔다 — 아직 안 산 것이고, 짐작해 넣으면
               "받은 단가"와 "실제 산 단가"가 같은 값으로 굳는다. */
            items: (full.items || []).map(it => ({
              name: it.name || '', unit: it.unit || '',
              qty: it.qty ? String(it.qty) : '',
              unit_price: it.unit_price ? String(it.unit_price) : '',
              amount: it.amount ? String(it.amount) : '',
              actual_price: '', actual_amount: '', memo: it.memo || '',
            })),
          })
          setPick(null); setCreating(true)
        }}/>

      {/* 품목에서 — 견적요청서와 같은 규칙으로 채운다 */}
      {/* 받은 청구서에서 — 아직 지급 안 한 건이 위로 오게 둔다(그게 품의를 올릴 대상이다).
          이미 지급을 마친 건도 고를 수는 있다 — 뒤늦게 결재를 올리는 일이 있다. */}
      <PickListDrawer
        open={pick === 'invoice'} onClose={() => setPick(null)}
        title="받은 청구서에서" sub="품의에 넣을 매입 건을 고르세요"
        placeholder="거래처·청구번호·품목 검색"
        rows={rows}
        match={(v, q) => [v.vendor, v.invoiceNo, v.memo, ...(v.lines || []).map(l => l.name)]
          .filter(Boolean).some(x => String(x).toLowerCase().includes(q.toLowerCase()))}
        render={(v) => ({
          title: v.vendor || '(거래처 없음)',
          sub: [v.issuedAt, v.invoiceNo,
                (v.lines || []).length ? `품목 ${v.lines.length}개` : null,
                v.status].filter(Boolean).join(' · '),
          right: Number(v.totalAmount ?? v.amount) || 0,
        })}
        empty="받은 청구서가 없어요."
        onDone={(picked) => {
          /* 거래처는 한 곳일 때만 — 거래내역 쪽과 같은 규칙(결재 문서라 거래처가 틀리면
             그대로 승인이 난다) */
          const names = [...new Set(picked.map(v => v.vendor).filter(Boolean))]
          const many = names.length > 1
          const items = []
          for (const v of picked) {
            const from = [v.issuedAt, many && v.vendor ? v.vendor : null].filter(Boolean).join(' ')
            const ls = v.lines || []
            if (ls.length) {
              for (const l of ls) {
                const qty = Number(l.qty) || 0
                items.push({
                  name: [l.name, l.spec].filter(Boolean).join(' '),
                  unit: l.unit || '',
                  qty: qty ? String(qty) : '',
                  unit_price: l.unit_price ? String(l.unit_price) : '',
                  amount: l.amount ? String(l.amount) : '',
                  actual_price: '', actual_amount: '',
                  memo: from,
                })
              }
            } else {
              /* 품목 없이 총액만 끊은 청구서 — 공급가액으로 한 줄.
                 합계(total)를 쓰면 부가세가 품의 금액에 섞인다. */
              const supply = Number(v.supplyAmount) || (Number(v.totalAmount ?? v.amount) || 0)
              items.push({
                name: v.memo || v.category || '매입',
                unit: '식', qty: '1',
                unit_price: String(supply), amount: String(supply),
                actual_price: '', actual_amount: '', memo: from,
              })
            }
          }
          setSeed({ ...(names.length === 1 ? { vendor_name: names[0] } : {}), items })
          setPick(null); setCreating(true)
        }}/>

      {/* 거래내역에서 — 여러 건을 담는다. 이미 나간 돈이라 금액이 확정이고,
          그래서 수량 1 · 단가=금액으로 둔다(수량을 비워 두면 합계가 0이 된다). */}
      <PickListDrawer
        open={pick === 'txn'} onClose={() => setPick(null)}
        title="거래내역에서 골라서" sub="품의에 넣을 지출을 고르세요"
        placeholder="거래처·비목·적요 검색"
        rows={rows}
        match={(t, q) => [t.vendor, t.category, t.memo].filter(Boolean)
          .some(v => String(v).toLowerCase().includes(q.toLowerCase()))}
        render={(t) => ({
          title: t.category && t.category !== '—' ? t.category : (t.memo || '지출'),
          sub: [t.date, t.vendor !== '(미확인)' ? t.vendor : null, t.memo].filter(Boolean).join(' · '),
          right: Number(t.amount) || 0,
        })}
        empty="가져올 지출이 없어요."
        onDone={async (picked) => {
          /* ⚠ **무엇을 샀는지는 품목에 있다.** 거래 한 줄에는 비목·금액뿐이고,
             품명·규격·수량·단가는 그 거래가 정산한 **청구서의 품목 줄**(invoice_lines)에 있다.
             그걸 안 보고 비목만 옮기면 품의서에 "소모품 1식 80,000" 한 줄이 서고,
             결재자는 무엇을 사는지 알 수 없다 — 품의서의 존재 이유가 사라진다.
             그래서 청구서가 딸린 건은 상세를 한 번 더 읽어 품목을 그대로 가져온다
             (견적요청서에서 가져올 때와 같은 방식). */
          /* ⚠ **청구서 하나당 한 번만** 읽고, 품목도 한 번만 담는다.
             한 청구서를 나눠 정산하면(선금·잔금) 거래가 여러 줄이고 셋 다 같은
             invoice_id 를 가리킨다. 거래마다 품목을 담으면 **같은 품목이 두세 번 서고
             품의 금액이 그만큼 부풀려진다** — 결재가 나면 그대로 발주가 된다.
             조회도 청구서 수만큼만 나간다(거래 수만큼이면 같은 것을 여러 번 읽는다). */
          const invIdOf = (t) => t.invoiceId || t.invoice_id || ''
          const invIds = [...new Set(picked.map(invIdOf).filter(Boolean))]
          const details = await Promise.all(invIds.map(id => api.getInvoice(id).catch(() => null)))
          const linesByInv = new Map()
          invIds.forEach((id, i) => {
            const ls = details[i]?.lines || []
            if (ls.length) linesByInv.set(id, ls)
          })
          // 같은 청구서의 거래가 여럿이면 **첫 거래에서만** 품목을 담는다
          const usedInv = new Set()

          /* 거래처는 **고른 것들이 한 곳일 때만** 채운다. 여러 곳이 섞였는데 첫 건으로
             정해 버리면 나머지가 그 거래처에서 산 것처럼 보인다 — 품의서는 결재를 받는
             문서라 거래처가 틀리면 그대로 승인이 난다. */
          const names = [...new Set(picked.map(t => t.vendor).filter(v => v && v !== '(미확인)'))]
          const many = names.length > 1
          const items = []
          for (const t of picked) {
            const from = [t.date, many && t.vendor && t.vendor !== '(미확인)' ? t.vendor : null].filter(Boolean).join(' ')
            const invId = invIdOf(t)
            const ls = invId && !usedInv.has(invId) ? linesByInv.get(invId) : null
            if (ls) {
              usedInv.add(invId)
              /* 품목이 있으면 그 줄을 그대로. 규격은 품명 뒤에 붙인다(품의서 양식엔 '품명 및 규격' 한 칸이다).
                 단위·수량이 비어 있을 수 있다 — 그때는 비운 채 둔다. 1식으로 지어내면
                 실제로 몇 개를 사는지 모르는 채 결재가 난다. */
              for (const l of ls) {
                const qty = Number(l.qty) || 0
                items.push({
                  name: [l.name, l.spec].filter(Boolean).join(' '),
                  unit: l.unit || '',
                  qty: qty ? String(qty) : '',
                  unit_price: l.unit_price ? String(l.unit_price) : '',
                  amount: l.amount ? String(l.amount) : '',
                  actual_price: '', actual_amount: '',
                  memo: from,
                })
              }
            } else if (invId && linesByInv.has(invId)) {
              /* 같은 청구서의 두 번째 거래 — 품목은 위에서 이미 담았다. 여기서 비목 줄을
                 또 넣으면 그것도 이중계상이다(품목 합계 + 정산액). 건너뛴다. */
              continue
            } else {
              // 품목이 없는 거래 — 비목·적요로 한 줄. 금액은 확정이라 수량 1·단가=금액.
              items.push({
                name: [t.category && t.category !== '—' ? t.category : null, t.memo].filter(Boolean).join(' · ') || '지출',
                unit: '식',
                qty: '1',
                unit_price: String(Number(t.amount) || 0),
                amount: String(Number(t.amount) || 0),
                actual_price: '', actual_amount: '',
                memo: from,
              })
            }
          }
          setSeed({ ...(names.length === 1 ? { vendor_name: names[0] } : {}), items })
          setPick(null); setCreating(true)
        }}/>

      <PickListDrawer
        open={pick === 'item'} onClose={() => setPick(null)}
        title="품목에서 골라서" sub="살 품목을 고르세요"
        placeholder="품명·자재코드·규격 검색"
        rows={rows}
        match={(m, q) => [m.name, m.code, m.spec].filter(Boolean)
          .some(v => String(v).toLowerCase().includes(q.toLowerCase()))}
        render={(m) => ({
          title: m.spec ? `${m.name} ${m.spec}` : m.name,
          sub: [m.code, m.unit].filter(Boolean).join(' · ') || null,
          right: m.purchase_price ? Number(m.purchase_price) : '단가 없음',
        })}
        empty="등록된 품목이 없어요. 기준정보 > 품목에서 먼저 등록하세요."
        onDone={(picked) => {
          setSeed({ items: picked.map(m => ({
            name: m.spec ? `${m.name} ${m.spec}` : m.name,
            unit: m.unit || '',
            qty: '',                     // 수량은 사람이 정한다
            unit_price: m.purchase_price ? String(m.purchase_price) : '',
            amount: '', actual_price: '', actual_amount: '', memo: '',
          })) })
          setPick(null); setCreating(true)
        }}/>
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
