import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, Drawer, Combobox, MoneyInput, localToday } from '../lib/ui'
import { api } from '../lib/api'

const QUARTER_PERIOD = { 1: '1~3월', 2: '4~6월', 3: '7~9월', 4: '10~12월' }
const VAT_STATUSES = ['납부 대기', '납부 완료', '환급 완료']
const STATUS_TONE = { '납부 대기': 'outline', '납부 완료': 'pos', '환급 완료': 'brand' }

const StatCard = ({ label, amount, tone = 'ink', hint }) => (
  <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div className="text-sm text-muted" style={{ fontWeight: 600 }}>{label}</div>
    <div className="num fw-700" style={{ fontSize: 22, letterSpacing: '-0.02em', color: `var(--${tone})` }}>
      {amount < 0 ? '−' : ''}{fmtNum(Math.abs(amount))}<span style={{ fontSize: 13, fontWeight: 600, opacity: 0.6, marginLeft: 3 }}>원</span>
    </div>
    {hint && <div className="text-xs text-muted2">{hint}</div>}
  </div>
)

const FilingDrawer = ({ target, year, onClose, onSaved }) => {
  const toast = useToast()
  const [form, setForm] = useState({ status: '납부 대기', filed_amount: '', paid_amount: '', paid_date: '', memo: '', account_id: '', category: '', account_code: '' })
  const [accounts, setAccounts] = useState([])
  const [categories, setCategories] = useState([])
  const [acctSubjects, setAcctSubjects] = useState([])
  const [jeokyos, setJeokyos] = useState([])
  useEffect(() => {
    api.getAccounts().then(list => setAccounts(list.filter(a => a.kind === 'bank')))
    api.getCategories().then(setCategories)
    api.getAccountSubjects().then(setAcctSubjects)
    api.getRefItems('jeokyo').then(setJeokyos)
  }, [])

  useEffect(() => {
    if (target) setForm({
      status: target.status || '납부 대기',
      // 신고세액: 이미 입력됐으면 그 값, 아니면 자동집계 예상값을 기본으로 채움
      filed_amount: target.filed_amount != null ? String(target.filed_amount) : String(target.estimate ?? target.payable ?? ''),
      paid_amount: target.paid_amount ? String(target.paid_amount) : '',
      paid_date: target.paid_date || '',
      // 적요: 저장된 값 없으면 자동 문구로 채움 (사용자 수정 가능)
      memo: target.memo || `${year}년 ${target.quarter}분기 부가세 ${(target.filed_amount ?? target.estimate ?? 0) < 0 ? '환급' : '납부'}`,
      account_id: target.account_id || '',
      category: target.category || '',
      account_code: target.account_code || '',
    })
  }, [target])

  if (!target) return null
  const filedNum = parseInt(String(form.filed_amount).replace(/[^0-9-]/g, ''), 10) || 0
  const isRefund = filedNum < 0        // 신고세액이 음수면 환급
  const isDone = form.status === '납부 완료' || form.status === '환급 완료'
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const save = async () => {
    if (isDone && !form.account_id) return toast.push(`${isRefund ? '환급' : '납부'} 계좌를 선택해주세요`)
    const res = await api.saveVatFiling({
      year, quarter: target.quarter,
      status: form.status,
      filed_amount: form.filed_amount === '' ? null : filedNum,
      paid_amount: parseInt(String(form.paid_amount).replace(/[^0-9]/g, ''), 10) || 0,
      paid_date: form.paid_date || null,
      memo: form.memo || null,
      account_id: form.account_id || null,
      category: form.category || null,
      account_code: form.account_code || null,
    })
    if (!res.ok) return toast.push(res.error || '저장 실패')
    toast.push(isDone ? `${isRefund ? '환급' : '납부'} 처리하고 거래내역에 반영했어요` : '신고 내용이 저장됐어요')
    onSaved(); onClose()
  }

  return (
    <Drawer open={!!target} onClose={onClose}>
      <div className="drawer-head">
        <div>
          <div className="fw-700" style={{ fontSize: 16 }}>{year}년 {target.quarter}분기 부가세</div>
          <div className="text-xs text-muted">자동집계 예상 {target.estimate < 0 ? '환급 ' : ''}{fmtNum(Math.abs(target.estimate ?? 0))}원 (매출세액 − 매입세액)</div>
        </div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>
      <div className="drawer-body col gap-form">
        <div>
          <label className="label" style={{ marginBottom: 8 }}>신고세액 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 실제 신고한 금액 (환급이면 음수)</span></label>
          <MoneyInput value={form.filed_amount} allowNegative onChange={raw => f('filed_amount', raw)}/>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
            자동집계 예상값으로 채웠어요. 실제 신고서 금액과 다르면 고치세요. {isRefund ? '음수 = 환급받을 세액.' : ''}
          </div>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>신고 상태</label>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            {VAT_STATUSES.map(s => (
              <button key={s} type="button" className={`chip ${form.status === s ? 'active' : ''}`} onClick={() => f('status', s)}>{s}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>{isRefund ? '환급받은 금액' : '납부한 금액'}</label>
          <MoneyInput value={form.paid_amount} onChange={raw => f('paid_amount', raw)}/>
        </div>
        {/* 납부/환급 완료면 실제 자금이 오간 계좌 → 거래내역·계좌잔고에 반영 */}
        {isDone && (
          <div>
            <label className="label" style={{ marginBottom: 8 }}>{isRefund ? '환급 입금' : '납부 출금'} 계좌 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {accounts.map(a => (
                <button key={a.id} type="button" className={`chip ${form.account_id === a.id ? 'active' : ''}`} onClick={() => f('account_id', a.id)}>
                  {a.name}{a.number ? ` ${String(a.number).slice(-4)}` : ''}
                </button>
              ))}
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
              {isRefund ? '이 계좌로 환급 입금 거래가 생성돼요.' : '이 계좌에서 지출 거래가 생성돼요.'} 완료를 취소하면 그 거래도 함께 사라집니다.
            </div>
          </div>
        )}
        {/* 생성될 거래의 분류 — 사용자가 직접 고른다(비목 필수, 계정과목 선택) */}
        {isDone && (
          <>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>비목</label>
              <Combobox value={form.category} onChange={v => f('category', v)}
                options={categories.filter(c => c.id?.startsWith(isRefund ? 'INC-' : 'EXP-')).map(c => ({ value: c.name, label: c.name, sub: c.group_name || '' }))}
                placeholder="비목 선택" onAddNew={v => f('category', v)} addNewLabel="이 비목으로 입력"/>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계정과목 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
              <Combobox value={form.account_code} onChange={v => f('account_code', v)}
                options={acctSubjects.map(a => ({ value: a.code, label: a.name, sub: `${a.code} · ${a.category}`, keywords: a.note || '' }))}
                placeholder="계정과목 선택 (선택)" allowAdd={false}/>
            </div>
          </>
        )}
        <div>
          <label className="label" style={{ marginBottom: 8 }}>{isRefund ? '환급일' : '납부일'}</label>
          <input className="input" type="date" max={localToday()} value={form.paid_date} onChange={e => f('paid_date', e.target.value)}/>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>적요 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 거래 내용</span></label>
          <Combobox value={form.memo} onChange={v => f('memo', v)}
            options={jeokyos.map(j => ({ value: j.name, label: j.name, sub: j.memo || '' }))}
            placeholder="적요 입력" onAddNew={v => f('memo', v)} addNewLabel="이 적요로 입력"/>
        </div>
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" onClick={save}><Icon.Check size={14}/> 저장</button>
      </div>
    </Drawer>
  )
}

export const TaxVatScreen = () => {
  const [year, setYear] = useState(new Date().getFullYear())
  const [data, setData] = useState({ year, quarters: [] })
  const [target, setTarget] = useState(null)

  const load = () => api.getVatFilings(year).then(setData)
  useEffect(() => { load() }, [year])

  const quarters = data.quarters || []
  // 연간 합계는 신고세액이 있으면 그걸, 없으면 예상값을 쓴다(payable이 이미 그 규칙)
  const totals = quarters.reduce((a, q) => ({
    sales: a.sales + q.sales_vat, purchase: a.purchase + q.purchase_vat, payable: a.payable + q.payable,
  }), { sales: 0, purchase: 0, payable: 0 })
  // 미납: 신고 완료(신고세액 입력)됐고 납부(+세액)인데 아직 납부 안 한 분기
  const unpaid = quarters.filter(q => q.filed_amount != null && q.payable > 0 && q.status !== '납부 완료').reduce((s, q) => s + q.payable, 0)
  // 환급 예정: 신고했고 환급(−세액)인데 아직 환급 처리 안 됨
  const refundDue = quarters.filter(q => q.filed_amount != null && q.payable < 0 && q.status !== '환급 완료').reduce((s, q) => s + Math.abs(q.payable), 0)

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 8 }}>
        <div>
          <div className="page-title">부가세</div>
          <div className="page-sub">청구서에서 분기별 세액을 예상으로 집계해요. 실제 신고세액을 입력하고 납부·환급을 기록하면, 그 신고세액 기준으로 관리됩니다.</div>
        </div>
        <div className="ml-auto row gap-6" style={{ alignItems: 'center' }}>
          <button className="icon-btn" onClick={() => setYear(y => y - 1)} title="이전 연도"><Icon.Left size={16}/></button>
          <span className="fw-700 num" style={{ fontSize: 15, minWidth: 64, textAlign: 'center' }}>{year}년</span>
          <button className="icon-btn" onClick={() => setYear(y => y + 1)} title="다음 연도"><Icon.Right size={16}/></button>
        </div>
      </div>
      <Spacer h={20}/>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        <StatCard label={totals.payable >= 0 ? '연간 납부세액' : '연간 환급세액'} amount={totals.payable} tone={totals.payable >= 0 ? 'neg-ink' : 'brand'} hint="신고세액(없으면 예상) 합계"/>
        <StatCard label="미납 부가세" amount={unpaid} tone="warn-ink" hint="신고했으나 미납한 분기"/>
        <StatCard label="환급 예정" amount={refundDue} tone="brand" hint="신고했으나 미수령 환급"/>
        <StatCard label="연간 매출세액" amount={totals.sales} tone="muted" hint={`매입세액 ${fmtNum(totals.purchase)}원`}/>
      </div>
      <Spacer h={24}/>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>분기</th><th>과세기간</th>
                <th className="num-right">매출세액</th><th className="num-right">매입세액</th>
                <th className="num-right">예상세액</th><th className="num-right">신고세액</th>
                <th>신고 상태</th><th className="num-right">납부·환급액</th><th></th>
              </tr>
            </thead>
            <tbody>
              {quarters.map(q => {
                const refund = q.payable < 0
                const filedYet = q.filed_amount != null
                return (
                  <tr key={q.quarter}>
                    <td className="fw-700">{q.quarter}분기</td>
                    <td className="text-sm text-muted num">{year}.{QUARTER_PERIOD[q.quarter]}</td>
                    <td className="num-cell num-right">{fmtNum(q.sales_vat)}</td>
                    <td className="num-cell num-right text-muted">{fmtNum(q.purchase_vat)}</td>
                    {/* 예상(자동집계) — 참고 */}
                    <td className="num-cell num-right text-muted2">
                      {q.estimate < 0 ? '환급 ' : ''}{fmtNum(Math.abs(q.estimate))}
                    </td>
                    {/* 신고세액 — 관리 기준. 미입력이면 '미신고' */}
                    <td className="num-cell num-right fw-700" style={{ color: filedYet ? (refund ? 'var(--brand)' : 'var(--neg-ink)') : 'var(--muted-2)' }}>
                      {filedYet ? `${refund ? '환급 ' : ''}${fmtNum(Math.abs(q.payable))}` : '미신고'}
                    </td>
                    <td><span className={`badge ${STATUS_TONE[q.status] || 'outline'}`}>{q.status}</span></td>
                    <td className="num-cell num-right">{q.paid_amount ? fmtNum(q.paid_amount) : '—'}</td>
                    <td>
                      <button className="btn sm" onClick={() => setTarget(q)}>{q.status === '납부 대기' ? (filedYet ? (refund ? '환급 처리' : '납부 처리') : '신고 등록') : '수정'}</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <FilingDrawer target={target} year={year} onClose={() => setTarget(null)} onSaved={load}/>
    </div>
  )
}

/* ============ 기타세액 (원천세·지방소득세 등) ============ */
const OT_EMPTY = { name: '', period: '', status: '납부 대기', tax_amount: '', paid_amount: '', paid_date: '', memo: '' }
const otUnpaid = (r) => (r.status === '납부 완료' || r.status === '환급 완료') ? 0 : Math.max(0, (r.tax_amount || 0) - (r.paid_amount || 0))

const OtherTaxDrawer = ({ open, editing, onClose, onSaved }) => {
  const toast = useToast()
  const [form, setForm] = useState({ ...OT_EMPTY, account_id: '', category: '', account_code: '' })
  const [accounts, setAccounts] = useState([])
  const [categories, setCategories] = useState([])
  const [acctSubjects, setAcctSubjects] = useState([])
  const [jeokyos, setJeokyos] = useState([])
  useEffect(() => {
    api.getAccounts().then(list => setAccounts(list.filter(a => a.kind === 'bank')))
    api.getCategories().then(setCategories)
    api.getAccountSubjects().then(setAcctSubjects)
    api.getRefItems('jeokyo').then(setJeokyos)
  }, [])
  useEffect(() => {
    if (open) setForm(editing ? {
      name: editing.name || '', period: editing.period || '', status: editing.status || '납부 대기',
      tax_amount: editing.tax_amount ? String(editing.tax_amount) : '',
      paid_amount: editing.paid_amount ? String(editing.paid_amount) : '',
      paid_date: editing.paid_date || '', memo: editing.memo || '', account_id: editing.account_id || '',
      category: editing.category || '', account_code: editing.account_code || '',
    } : { ...OT_EMPTY, account_id: '', category: '', account_code: '' })
  }, [open, editing])
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const isDone = form.status === '납부 완료' || form.status === '환급 완료'
  const isRefund = form.status === '환급 완료'

  const save = async () => {
    if (!form.name.trim()) return toast.push('세목을 입력하세요')
    if (isDone && !form.account_id) return toast.push(`${isRefund ? '환급' : '납부'} 계좌를 선택해주세요`)
    const payload = {
      ...form,
      tax_amount: parseInt(String(form.tax_amount).replace(/[^0-9]/g, ''), 10) || 0,
      paid_amount: parseInt(String(form.paid_amount).replace(/[^0-9]/g, ''), 10) || 0,
      paid_date: form.paid_date || null, memo: form.memo || null, account_id: form.account_id || null,
    }
    const res = editing ? await api.updateOtherTax(editing.id, payload) : await api.addOtherTax(payload)
    if (!res.ok) return toast.push(res.error || '저장 실패')
    toast.push(isDone ? `${isRefund ? '환급' : '납부'} 처리하고 거래내역에 반영했어요` : (editing ? '수정됐어요' : '등록됐어요'))
    onSaved(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose}>
      <div className="drawer-head">
        <div className="fw-700" style={{ fontSize: 16 }}>{editing ? '기타세액 수정' : '기타세액 등록'}</div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>
      <div className="drawer-body col gap-form">
        <div>
          <label className="label" style={{ marginBottom: 8 }}>세목 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <input className="input" value={form.name} onChange={e => f('name', e.target.value)} placeholder="예: 원천세(근로소득), 지방소득세"/>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>과세기간 / 귀속</label>
          <input className="input" value={form.period} onChange={e => f('period', e.target.value)} placeholder="예: 2026년 3월분, 2026년 귀속"/>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>신고(납부)세액</label>
            <MoneyInput value={form.tax_amount} onChange={raw => f('tax_amount', raw)}/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>납부액</label>
            <MoneyInput value={form.paid_amount} onChange={raw => f('paid_amount', raw)}/>
          </div>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>상태</label>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            {VAT_STATUSES.map(s => (
              <button key={s} type="button" className={`chip ${form.status === s ? 'active' : ''}`} onClick={() => f('status', s)}>{s}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>{isRefund ? '환급일' : '납부일'}</label>
          <input className="input" type="date" max={localToday()} value={form.paid_date} onChange={e => f('paid_date', e.target.value)}/>
        </div>
        {isDone && (
          <div>
            <label className="label" style={{ marginBottom: 8 }}>{isRefund ? '환급 입금' : '납부 출금'} 계좌 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {accounts.map(a => (
                <button key={a.id} type="button" className={`chip ${form.account_id === a.id ? 'active' : ''}`} onClick={() => f('account_id', a.id)}>
                  {a.name}{a.number ? ` ${String(a.number).slice(-4)}` : ''}
                </button>
              ))}
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
              {isRefund ? '이 계좌로 환급 입금 거래가 생성돼요.' : '이 계좌에서 지출 거래가 생성돼요.'}
            </div>
          </div>
        )}
        {isDone && (
          <>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>비목</label>
              <Combobox value={form.category} onChange={v => f('category', v)}
                options={categories.filter(c => c.id?.startsWith(isRefund ? 'INC-' : 'EXP-')).map(c => ({ value: c.name, label: c.name, sub: c.group_name || '' }))}
                placeholder="비목 선택" onAddNew={v => f('category', v)} addNewLabel="이 비목으로 입력"/>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계정과목 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
              <Combobox value={form.account_code} onChange={v => f('account_code', v)}
                options={acctSubjects.map(a => ({ value: a.code, label: a.name, sub: `${a.code} · ${a.category}`, keywords: a.note || '' }))}
                placeholder="계정과목 선택 (선택)" allowAdd={false}/>
            </div>
          </>
        )}
        <div>
          <label className="label" style={{ marginBottom: 8 }}>적요 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 거래 내용</span></label>
          <Combobox value={form.memo} onChange={v => f('memo', v)}
            options={jeokyos.map(j => ({ value: j.name, label: j.name, sub: j.memo || '' }))}
            placeholder="적요 입력" onAddNew={v => f('memo', v)} addNewLabel="이 적요로 입력"/>
        </div>
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" onClick={save}><Icon.Check size={14}/> 저장</button>
      </div>
    </Drawer>
  )
}

export const OtherTaxScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = () => api.getOtherTaxes().then(setRows)
  useEffect(() => { load() }, [])

  const totals = rows.reduce((a, r) => ({
    tax: a.tax + (r.tax_amount || 0), paid: a.paid + (r.paid_amount || 0), unpaid: a.unpaid + otUnpaid(r),
  }), { tax: 0, paid: 0, unpaid: 0 })

  const openNew = () => { setEditing(null); setDrawerOpen(true) }
  const openEdit = (r) => { setEditing(r); setDrawerOpen(true) }
  const handleDelete = async (r) => {
    const ok = await confirm({ tone: 'warn', icon: <Icon.Warn size={22}/>, title: `${r.name} 삭제`, body: '이 기타세액 항목을 삭제할까요?', confirmLabel: '삭제' })
    if (!ok) return
    await api.deleteOtherTax(r.id); toast.push('삭제됐어요'); load()
  }

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 8 }}>
        <div>
          <div className="page-title">기타세액</div>
          <div className="page-sub">원천세·지방소득세 등 부가세 외 세금의 신고세액·납부·환급을 정리합니다.</div>
        </div>
        <button className="btn primary ml-auto" onClick={openNew}><Icon.Plus size={14}/> 기타세액 등록</button>
      </div>
      <Spacer h={20}/>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        <StatCard label="신고세액 합계" amount={totals.tax} tone="ink"/>
        <StatCard label="납부액 합계" amount={totals.paid} tone="pos"/>
        <StatCard label="미납 세액" amount={totals.unpaid} tone="warn-ink" hint="납부 미완료 합계"/>
      </div>
      <Spacer h={24}/>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>세목</th><th>과세기간/귀속</th>
                <th className="num-right">신고세액</th><th className="num-right">납부액</th>
                <th className="num-right">미납</th><th>상태</th><th>납부일</th><th style={{ width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--muted-2)' }}>등록된 기타세액이 없어요. '기타세액 등록'을 눌러 추가하세요.</td></tr>
              )}
              {rows.map(r => {
                const unpaid = otUnpaid(r)
                return (
                  <tr key={r.id}>
                    <td className="fw-700">{r.name}</td>
                    <td className="text-sm text-muted">{r.period || '—'}</td>
                    <td className="num-cell num-right">{fmtNum(r.tax_amount)}</td>
                    <td className="num-cell num-right text-muted">{fmtNum(r.paid_amount)}</td>
                    <td className="num-cell num-right fw-700" style={{ color: unpaid > 0 ? 'var(--neg-ink)' : 'var(--muted-2)' }}>{unpaid > 0 ? fmtNum(unpaid) : '—'}</td>
                    <td><span className={`badge ${STATUS_TONE[r.status] || 'outline'}`}>{r.status}</span></td>
                    <td className="text-sm num">{r.paid_date || '—'}</td>
                    <td>
                      <div className="row gap-6">
                        <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => openEdit(r)}>수정</button>
                        <button className="btn" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--neg)' }} onClick={() => handleDelete(r)}>삭제</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <OtherTaxDrawer open={drawerOpen} editing={editing} onClose={() => setDrawerOpen(false)} onSaved={load}/>
    </div>
  )
}
