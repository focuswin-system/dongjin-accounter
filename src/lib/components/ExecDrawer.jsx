import { useState, useEffect, useRef } from 'react'
import { api } from '../api'
import { Icon, fmtNum, useToast, useConfirm, Drawer, Combobox, MoneyInput, DateInput, localToday, Loading } from '../ui'
import { DrawerHead, DrawerFooter } from './Drawer'
import { vatOf, VAT_RATE } from '../vatRate'

/**
 * 지출 처리 창 — 구매품의서·지급결의서가 같이 쓴다(서버 규칙도 lib/docExec.js 하나).
 *
 *   청구서가 붙은 문서  → 그 청구서를 지급한다(남은 금액까지). 과세유형·비목은 청구서 것.
 *   청구서가 없는 문서  → 새 비용이다. 과세유형·비목·증빙을 받는다(전표·부가세가 여기서 정해진다).
 *   통장 거래에 연결    → 이미 올라온 지출에 붙인다. 돈이 또 나가지 않는다.
 *
 * 서버가 되묻는 두 가지를 여기서 받는다.
 *   open_invoice  같은 거래처에 금액이 맞는 미지급 청구서가 있다 → 그 청구서로 지급할지, 별개인지
 *   dup_txn       같은 지출이 통장에 이미 있다 → 그래도 새로 만들지
 *
 * @param doc { kind:'purchase_req'|'resolution', id, docNo, title, vendorName, vendorId,
 *              amount, amountIsSupply, invoice:{ id, invoice_no, remain }|null, payDate }
 *        amountIsSupply — 품의 금액은 공급가다(견적가). 결의서는 지급액(VAT 포함)이다.
 */
const API = {
  purchase_req: {
    matchable: (id) => api.getPurchaseReqMatchable(id),
    openInvoices: (id, amt) => api.getPurchaseReqOpenInvoices(id, amt),
    process: (id, body) => api.processPurchaseReq(id, body),
    link: (id, invId) => api.linkPurchaseReqInvoice(id, invId),
  },
  resolution: {
    matchable: (id) => api.getResolutionMatchable(id),
    openInvoices: (id, amt) => api.getResolutionOpenInvoices(id, amt),
    process: (id, body) => api.processResolution(id, body),
    link: (id, invId) => api.linkResolutionInvoice(id, invId),
  },
}
const TAX_TYPES = ['과세', '면세', '영세']

export const ExecDrawer = ({ open, onClose, doc, onDone, onChanged }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const A = API[doc?.kind] || API.resolution
  const [invoice, setInvoice] = useState(null)        // 이 창에서 붙인 청구서까지 반영한 현재 값
  const [mode, setMode] = useState('create')
  const [amount, setAmount] = useState('')
  const [touched, setTouched] = useState(false)       // 사람이 금액을 고쳤나(과세유형을 바꿔도 덮지 않는다)
  const [date, setDate] = useState(localToday())
  const [accounts, setAccounts] = useState([])
  const [accountId, setAccountId] = useState('')
  const [taxType, setTaxType] = useState('과세')
  const [category, setCategory] = useState('')
  const [evidType, setEvidType] = useState('')
  const [vatDeductible, setVatDeductible] = useState(true)
  const [categories, setCategories] = useState([])
  const [evidenceTypes, setEvidenceTypes] = useState([])
  const [candidates, setCandidates] = useState(null)
  const [picked, setPicked] = useState(null)
  const [openInvoices, setOpenInvoices] = useState([])
  const [skipInvoice, setSkipInvoice] = useState(false) // '별개 지출이에요'를 눌렀나
  const [busy, setBusy] = useState(false)
  const bodyRef = useRef(null)

  const baseAmount = (inv, tax) => {
    if (inv) return inv.remain
    const a = Number(doc?.amount) || 0
    return doc?.amountIsSupply && tax === '과세' ? a + vatOf(a) : a
  }

  useEffect(() => {
    if (!open || !doc) return
    const inv = doc.invoice || null
    setInvoice(inv); setMode('create'); setTouched(false); setPicked(null)
    setTaxType('과세'); setCategory(''); setEvidType(''); setVatDeductible(true); setSkipInvoice(false)
    setAmount(String(baseAmount(inv, '과세') || ''))
    /* 지출일은 오늘까지로 자른다. 결의서의 지급일은 '주기로 한 날'이라 대개 미래인데,
       그대로 채우면 아무것도 안 바꾸고 눌렀을 때 서버가 미래 날짜라며 거절한다. */
    const t = localToday()
    setDate(doc.payDate && doc.payDate <= t ? doc.payDate : t)
    setCandidates(null)
    A.matchable(doc.id).then(setCandidates)
    api.getAccounts().then(list => {
      setAccounts(list || [])
      // 은행 계좌를 기본으로(kind='bank'). 카드 지출도 있으니 목록에서 카드도 고를 수 있게 둔다.
      const bank = (list || []).find(a => a.kind === 'bank') || (list || [])[0]
      setAccountId(bank?.id || '')
    })
    api.getCategories().then(list => setCategories((list || []).filter(c => c.id?.startsWith('EXP-'))))
    api.getRefItems('evidence_type').then(list => setEvidenceTypes(list || []))
    setOpenInvoices([])
    if (!inv && doc.vendorId) A.openInvoices(doc.id).then(list => setOpenInvoices(list || []))
  }, [open, doc?.id])   // eslint-disable-line react-hooks/exhaustive-deps

  // 과세유형을 바꾸면 품의(공급가 기준)의 기본 금액이 달라진다 — 사람이 고친 금액은 그대로 둔다
  useEffect(() => {
    if (!open || touched || invoice) return
    setAmount(String(baseAmount(null, taxType) || ''))
  }, [taxType])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) return null
  const amountNum = parseInt(String(amount).replace(/[^0-9]/g, ''), 10) || 0
  const taxable = taxType === '과세'
  // 합계 → 공급가·세액. 서버 lib/vat.js vatFields 와 같은 역산(공급가 = 합계 / 1.1 반올림)
  const supply = invoice ? 0 : (taxable ? Math.round(amountNum / (1 + VAT_RATE)) : amountNum)
  const vat = invoice ? 0 : amountNum - supply
  const pickedRow = (candidates || []).find(t => t.id === picked)
  const needsAccount = mode === 'create' || (pickedRow && !pickedRow.account_id)
  const nearInvoices = openInvoices.filter(i => i.near)

  // 청구서를 붙인다 — 이후 처리는 그 청구서의 지급이 된다
  const payThisInvoice = async (inv) => {
    setBusy(true)
    const r = await A.link(doc.id, inv.id)
    setBusy(false)
    if (!r.ok) return toast.push(r.error || '청구서를 붙이지 못했어요', { tone: 'warn' })
    const next = { id: inv.id, invoice_no: inv.invoice_no, remain: inv.remain }
    setInvoice(next); setAmount(String(inv.remain)); setTouched(false); setOpenInvoices([])
    A.matchable(doc.id).then(setCandidates)
    /* 부모 문서도 새로 읽힌다 — 안 그러면 창을 닫았다 열 때 옛 문서(청구서 없음)로 초기화돼
       새 지출 양식이 뜨는데, 서버는 청구서 지급으로 처리해 금액이 어긋난다. */
    onChanged?.()
    toast.push(`청구서 ${inv.invoice_no}로 지급해요`)
  }

  const submit = async (extra = {}) => {
    if (mode === 'link' && !picked) return toast.push('연결할 지출을 골라주세요')
    if (needsAccount && !accountId) return toast.push('출금 계좌를 골라주세요')
    if (mode === 'create') {
      if (!amountNum) return toast.push('지출 금액을 입력해주세요')
      if (invoice && amountNum > invoice.remain) return toast.push(`남은 금액은 ${fmtNum(invoice.remain)}원이에요`)
      if (!invoice && !category) return toast.push('비목을 골라주세요')
    }
    const body = mode === 'link'
      ? { mode: 'link', txn_id: picked, account_id: accountId || null }
      : { mode: 'create', amount: amountNum, date, account_id: accountId || null,
          ...(invoice ? {} : { tax_type: taxType, category, evid_type: evidType || null, vat_deductible: vatDeductible ? 1 : 0 }),
          skip_invoice: skipInvoice }
    setBusy(true)
    const res = await A.process(doc.id, { ...body, ...extra })
    setBusy(false)
    if (!res.ok) {
      if (res.code === 'open_invoice') {
        // 창 위쪽에 청구서를 띄우고 고르게 한다(확인창으로 물으면 바깥을 눌러 닫는 것이 '별개'로 읽힌다)
        setOpenInvoices((res.payload?.invoices || []).map(i => ({ ...i, near: true })))
        bodyRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' })
        return
      }
      if (res.code === 'dup_txn') {
        const ok = await confirm({
          tone: 'warn', icon: <Icon.Warn size={22}/>, title: '같은 지출이 이미 있어요',
          body: res.error, detail: '새로 만들면 장부에 같은 돈이 두 줄 남아요. 그 거래에 연결하려면 취소하고 \'통장 거래에 연결\'을 고르세요.',
          confirmLabel: '그래도 새로 등록',
        })
        if (ok) return submit({ ...extra, allow_new: true })
        return
      }
      return toast.push(res.error || '처리하지 못했어요', { tone: 'warn' })
    }
    toast.push(mode === 'link' ? '통장 거래에 연결했어요'
      : res.invoicePaid ? `청구서 ${invoice?.invoice_no || ''} 지급까지 처리했어요`.replace('  ', ' ') : '지출을 등록했어요')
    onDone?.(res)
  }

  const pickCategory = (name) => {
    setCategory(name)
    // 비목에 과세유형이 정해져 있으면 따라간다(거래 입력 폼과 같은 규칙)
    const c = categories.find(x => x.name === name)
    if (c?.vat === '면세' || c?.vat === '영세') setTaxType(c.vat)
    else if (c?.vat === '10%') setTaxType('과세')
    if (c) setVatDeductible(c.vat_deductible !== 0)
  }

  return (
    <Drawer open={open} onClose={onClose} width="min(500px,100vw)" label="지출 처리">
      <DrawerHead title="지출 처리" sub={[doc.docNo, doc.title, doc.vendorName !== doc.title ? doc.vendorName : null].filter(Boolean).join(' · ')} onClose={onClose}/>
      <div className="drawer-body col gap-form" ref={bodyRef}>
        {invoice ? (
          <div className="exec-note">
            <Icon.Receipt size={16}/>
            <div>
              청구서 <b>{invoice.invoice_no}</b>를 지급해요
              <div className="text-xs text-muted">남은 금액 <b className="num">{fmtNum(invoice.remain)}원</b></div>
            </div>
          </div>
        ) : nearInvoices.length > 0 && !skipInvoice && (
          <div className="exec-note warn">
            <Icon.Warn size={16}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fw-600">금액이 맞는 미지급 청구서가 있어요</div>
              <div className="col gap-6" style={{ marginTop: 8 }}>
                {nearInvoices.slice(0, 3).map(i => (
                  <div key={i.id} className="row gap-8" style={{ alignItems: 'center' }}>
                    <span className="text-sm" style={{ flex: 1, minWidth: 0 }}>
                      {i.invoice_no} · {String(i.issued_at || '').slice(0, 10)} · <b className="num">{fmtNum(i.remain)}원</b>
                    </span>
                    <button type="button" className="btn sm primary" disabled={busy} onClick={() => payThisInvoice(i)}>이 청구서로 지급</button>
                  </div>
                ))}
              </div>
              <button type="button" className="btn ghost sm" style={{ marginTop: 6, paddingLeft: 0 }}
                onClick={() => setSkipInvoice(true)}>별개 지출이에요</button>
            </div>
          </div>
        )}

        <div className="row gap-6">
          <button type="button" className={`chip ${mode === 'create' ? 'active' : ''}`} onClick={() => setMode('create')}>
            {invoice ? '지급 등록' : '새 지출 등록'}
          </button>
          <button type="button" className={`chip ${mode === 'link' ? 'active' : ''}`} onClick={() => setMode('link')}>통장 거래에 연결</button>
        </div>

        {mode === 'create' ? (
          <>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>{invoice ? '지급액' : '지출액 (VAT 포함)'}</label>
              <div style={{ position: 'relative' }}>
                <MoneyInput className="input num fw-700" style={{ fontSize: 20, paddingRight: 36 }}
                  value={amount} onChange={raw => { setAmount(raw); setTouched(true) }}/>
                <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>원</span>
              </div>
              {!invoice && taxable && amountNum > 0 && (
                <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                  공급가 <span className="num">{fmtNum(supply)}</span> · 세액 <span className="num">{fmtNum(vat)}</span>
                </div>
              )}
            </div>

            {!invoice && (
              <>
                <div>
                  <label className="label" style={{ marginBottom: 8 }}>비목 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                  <Combobox value={category} onChange={pickCategory} allowAdd={false}
                    options={categories.map(c => ({ value: c.name, label: c.name, sub: c.group_name || '' }))}
                    placeholder="비목 검색·선택"/>
                </div>
                <div>
                  <label className="label" style={{ marginBottom: 8 }}>과세유형</label>
                  <div className="row gap-6">
                    {TAX_TYPES.map(t => (
                      <button key={t} type="button" className={`chip ${taxType === t ? 'active' : ''}`} onClick={() => setTaxType(t)}>{t}</button>
                    ))}
                  </div>
                </div>
                {taxable && (
                  <div>
                    <label className="label" style={{ marginBottom: 8 }}>증빙유형 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
                    <Combobox value={evidType} allowAdd={false}
                      onChange={(v) => {
                        setEvidType(v)
                        const e = evidenceTypes.find(x => x.name === v)
                        if (e) setVatDeductible(e.deductible !== 0)
                      }}
                      options={evidenceTypes.map(e => ({ value: e.name, label: e.name, sub: e.deductible === 0 ? '매입세액 공제 불가' : '공제 가능' }))}
                      placeholder="세금계산서·카드·현금영수증…"/>
                  </div>
                )}
              </>
            )}

            <div>
              <label className="label" style={{ marginBottom: 8 }}>지출일</label>
              <DateInput className="input" max={localToday()} value={date} onChange={e => setDate(e.target.value)}/>
            </div>
            <AccountPick accounts={accounts} value={accountId} onChange={setAccountId}/>
          </>
        ) : (
          <div>
            <label className="label" style={{ marginBottom: 8 }}>연결할 지출</label>
            {candidates === null ? <Loading label="지출을 불러오는 중…"/>
              : candidates.length === 0 ? (
                <div className="text-sm text-muted2 exec-empty">연결할 지출이 없어요.</div>
              ) : (
                <div className="col gap-6 exec-cands">
                  {candidates.map(t => (
                    <button key={t.id} type="button" onClick={() => setPicked(t.id)}
                      className={`exec-cand ${picked === t.id ? 'on' : ''}`}>
                      <div className="row gap-8">
                        <span className="fw-600 text-sm">{t.vendor_name || t.category || '거래처 미상'}</span>
                        {t.related && <span className="badge outline" style={{ fontSize: 10 }}>같은 거래처</span>}
                        <span className="ml-auto num fw-700">{fmtNum(t.amount)}원</span>
                      </div>
                      <div className="text-xs text-muted2" style={{ marginTop: 3 }}>
                        {t.date} · {t.category || '—'}{t.account_name ? ` · ${t.account_name}` : ''}
                        {t.status !== '지급완료' && <> · {t.status}</>}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            {pickedRow && pickedRow.status !== '지급완료' && (
              <div className="text-xs text-muted2" style={{ marginTop: 8 }}>
                아직 {pickedRow.status} 상태예요. 연결하면 지급완료로 바뀌어 계좌 잔액에서 빠져요.
              </div>
            )}
            {invoice && pickedRow && pickedRow.amount < invoice.remain && (
              <div className="text-xs" style={{ marginTop: 8, color: 'var(--warn-ink)' }}>
                남은 금액보다 적어요. 연결하면 청구서는 일부 지급으로 남아요.
              </div>
            )}
            {pickedRow && !pickedRow.account_id && (
              <div style={{ marginTop: 10 }}>
                <AccountPick accounts={accounts} value={accountId} onChange={setAccountId}/>
              </div>
            )}
          </div>
        )}
      </div>
      <DrawerFooter onCancel={onClose} onSave={() => submit()} saveLabel={busy ? '처리 중…' : '처리 완료'} saveDisabled={busy}/>
    </Drawer>
  )
}

// 출금 계좌 — 비면 그 지출은 어느 계좌 잔액에서도 빠지지 않으므로 필수다
const AccountPick = ({ accounts, value, onChange }) => (
  <div>
    <label className="label" style={{ marginBottom: 8 }}>출금 계좌 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
    <Combobox value={value} onChange={onChange} allowAdd={false}
      options={accounts.map(a => ({ value: a.id, label: a.name, sub: [a.kind === 'card' ? '카드' : a.bankName, a.number].filter(Boolean).join(' ') }))}
      placeholder="계좌 선택"/>
  </div>
)

/**
 * 승인하고, 처리할지 묻는다 — 품의·결의서 공용.
 * 처리할 돈이 없는 문서는 서버가 곧바로 완료로 둔다(autoDone) — 그땐 묻지 않는다.
 * @param onApproved 승인 직후(묻기 전에) 부른다 — 뒤에 깔린 목록·문서가 '승인'으로 먼저 바뀌어야
 *                   "승인했어요"라는 말과 화면이 같은 말을 한다
 * @returns 'exec'(처리 창을 열어라) | 'later' | 'done' | null(실패)
 */
export async function approveAndAsk({ approve, confirm, toast, onApproved }) {
  const res = await approve()
  if (!res.ok) { toast.push(res.error || '승인하지 못했어요', { tone: 'warn' }); return null }
  onApproved?.()
  if (res.status === '완료') {
    toast.push(`${res.autoDone || '처리할 돈이 없어요'}. 처리 완료로 뒀어요.`)
    return 'done'
  }
  const go = await confirm({
    icon: <Icon.Check size={22}/>, title: '승인했어요',
    body: '지출도 지금 처리할까요?',
    detail: '나중에 해도 돼요. 처리 전까지 목록에 승인으로 남아요.',
    confirmLabel: '지출 처리', cancelLabel: '나중에',
  })
  return go ? 'exec' : 'later'
}
