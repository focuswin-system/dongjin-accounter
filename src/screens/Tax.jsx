import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, Drawer } from '../lib/ui'
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
  const [form, setForm] = useState({ status: '납부 대기', paid_amount: '', paid_date: '', memo: '' })

  useEffect(() => {
    if (target) setForm({
      status: target.status || '납부 대기',
      paid_amount: target.paid_amount ? String(target.paid_amount) : String(Math.abs(target.payable) || ''),
      paid_date: target.paid_date || '',
      memo: target.memo || '',
    })
  }, [target])

  if (!target) return null
  const isRefund = target.payable < 0
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const save = async () => {
    const res = await api.saveVatFiling({
      year, quarter: target.quarter,
      status: form.status,
      paid_amount: parseInt(String(form.paid_amount).replace(/[^0-9]/g, ''), 10) || 0,
      paid_date: form.paid_date || null,
      memo: form.memo || null,
    })
    if (!res.ok) return toast.push(res.error || '저장 실패')
    toast.push('신고 상태가 저장됐어요')
    onSaved(); onClose()
  }

  return (
    <Drawer open={!!target} onClose={onClose}>
      <div className="drawer-head">
        <div>
          <div className="fw-700" style={{ fontSize: 16 }}>{year}년 {target.quarter}분기 부가세</div>
          <div className="text-xs text-muted">{isRefund ? '환급' : '납부'}세액 {fmtNum(Math.abs(target.payable))}원</div>
        </div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>
      <div className="drawer-body col gap-14">
        <div>
          <label className="label" style={{ marginBottom: 8 }}>신고 상태</label>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            {VAT_STATUSES.map(s => (
              <button key={s} type="button" className={`chip ${form.status === s ? 'active' : ''}`} onClick={() => f('status', s)}>{s}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>{isRefund ? '환급액' : '납부액'}</label>
          <input className="input num" value={form.paid_amount ? Number(String(form.paid_amount).replace(/[^0-9]/g, '')).toLocaleString() : ''}
            onChange={e => f('paid_amount', e.target.value.replace(/[^0-9]/g, ''))} placeholder="0"/>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>{isRefund ? '환급일' : '납부일'}</label>
          <input className="input" type="date" value={form.paid_date} onChange={e => f('paid_date', e.target.value)}/>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>메모</label>
          <input className="input" value={form.memo} onChange={e => f('memo', e.target.value)} placeholder="신고/납부 관련 메모"/>
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
  const totals = quarters.reduce((a, q) => ({
    sales: a.sales + q.sales_vat, purchase: a.purchase + q.purchase_vat, payable: a.payable + q.payable,
  }), { sales: 0, purchase: 0, payable: 0 })
  const unpaid = quarters.filter(q => q.payable > 0 && q.status !== '납부 완료').reduce((s, q) => s + q.payable, 0)

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 8 }}>
        <div>
          <div className="page-title">부가세</div>
          <div className="page-sub">발행·수취 세금계산서에서 분기별 매출·매입세액을 자동 집계합니다. 신고 후 납부·환급을 기록하세요.</div>
        </div>
        <div className="ml-auto row gap-6" style={{ alignItems: 'center' }}>
          <button className="icon-btn" onClick={() => setYear(y => y - 1)} title="이전 연도"><Icon.Left size={16}/></button>
          <span className="fw-700 num" style={{ fontSize: 15, minWidth: 64, textAlign: 'center' }}>{year}년</span>
          <button className="icon-btn" onClick={() => setYear(y => y + 1)} title="다음 연도"><Icon.Right size={16}/></button>
        </div>
      </div>
      <Spacer h={20}/>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        <StatCard label="연간 매출세액" amount={totals.sales} tone="ink" hint="발행 세금계산서 기준"/>
        <StatCard label="연간 매입세액" amount={totals.purchase} tone="muted" hint="수취 세금계산서 기준"/>
        <StatCard label={totals.payable >= 0 ? '연간 납부세액' : '연간 환급세액'} amount={totals.payable} tone={totals.payable >= 0 ? 'neg-ink' : 'brand'} hint="매출세액 − 매입세액"/>
        <StatCard label="미납 부가세" amount={unpaid} tone="warn-ink" hint="납부 미완료 분기 합계"/>
      </div>
      <Spacer h={24}/>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>분기</th><th>과세기간</th>
                <th className="num-right">매출세액</th><th className="num-right">매입세액</th>
                <th className="num-right">납부(환급)세액</th><th>신고 상태</th>
                <th className="num-right">납부·환급액</th><th></th>
              </tr>
            </thead>
            <tbody>
              {quarters.map(q => {
                const refund = q.payable < 0
                return (
                  <tr key={q.quarter}>
                    <td className="fw-700">{q.quarter}분기</td>
                    <td className="text-sm text-muted num">{year}.{QUARTER_PERIOD[q.quarter]}</td>
                    <td className="num-cell num-right">{fmtNum(q.sales_vat)}</td>
                    <td className="num-cell num-right text-muted">{fmtNum(q.purchase_vat)}</td>
                    <td className="num-cell num-right fw-700" style={{ color: refund ? 'var(--brand)' : 'var(--neg-ink)' }}>
                      {refund ? '환급 ' : ''}{fmtNum(Math.abs(q.payable))}
                    </td>
                    <td><span className={`badge ${STATUS_TONE[q.status] || 'outline'}`}>{q.status}</span></td>
                    <td className="num-cell num-right">{q.paid_amount ? fmtNum(q.paid_amount) : '—'}</td>
                    <td>
                      <button className="btn sm" onClick={() => setTarget(q)}>{q.status === '납부 대기' ? (refund ? '환급 처리' : '납부 처리') : '수정'}</button>
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
  const [form, setForm] = useState(OT_EMPTY)
  useEffect(() => {
    if (open) setForm(editing ? {
      name: editing.name || '', period: editing.period || '', status: editing.status || '납부 대기',
      tax_amount: editing.tax_amount ? String(editing.tax_amount) : '',
      paid_amount: editing.paid_amount ? String(editing.paid_amount) : '',
      paid_date: editing.paid_date || '', memo: editing.memo || '',
    } : OT_EMPTY)
  }, [open, editing])
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const numv = (v) => v ? Number(String(v).replace(/[^0-9]/g, '')).toLocaleString() : ''

  const save = async () => {
    if (!form.name.trim()) return toast.push('세목을 입력하세요')
    const payload = {
      ...form,
      tax_amount: parseInt(String(form.tax_amount).replace(/[^0-9]/g, ''), 10) || 0,
      paid_amount: parseInt(String(form.paid_amount).replace(/[^0-9]/g, ''), 10) || 0,
      paid_date: form.paid_date || null, memo: form.memo || null,
    }
    const res = editing ? await api.updateOtherTax(editing.id, payload) : await api.addOtherTax(payload)
    if (!res.ok) return toast.push(res.error || '저장 실패')
    toast.push(editing ? '수정됐어요' : '등록됐어요')
    onSaved(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose}>
      <div className="drawer-head">
        <div className="fw-700" style={{ fontSize: 16 }}>{editing ? '기타세액 수정' : '기타세액 등록'}</div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>
      <div className="drawer-body col gap-14">
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
            <input className="input num" value={numv(form.tax_amount)} onChange={e => f('tax_amount', e.target.value.replace(/[^0-9]/g, ''))} placeholder="0"/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>납부액</label>
            <input className="input num" value={numv(form.paid_amount)} onChange={e => f('paid_amount', e.target.value.replace(/[^0-9]/g, ''))} placeholder="0"/>
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
          <label className="label" style={{ marginBottom: 8 }}>납부일</label>
          <input className="input" type="date" value={form.paid_date} onChange={e => f('paid_date', e.target.value)}/>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>메모</label>
          <input className="input" value={form.memo} onChange={e => f('memo', e.target.value)} placeholder="비고"/>
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
