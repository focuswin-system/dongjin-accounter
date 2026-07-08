import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, Spacer, Drawer } from '../lib/ui'
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

  const load = () => api.getVatSummary(year).then(setData)
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
