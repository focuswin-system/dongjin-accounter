import { useState, useEffect } from 'react'
import { fmtNum, Spacer } from '../lib/ui'
import { api } from '../lib/api'

const Card = ({ label, amount, tone = 'ink', sub }) => (
  <div className="card card-pad col" style={{ gap: 6 }}>
    <div className="text-sm text-muted fw-600">{label}</div>
    <div className="num fw-700" style={{ fontSize: 22, letterSpacing: '-0.02em', color: `var(--${tone})` }}>
      {fmtNum(amount)}<span style={{ fontSize: 13, fontWeight: 600, opacity: 0.6, marginLeft: 3 }}>원</span>
    </div>
    {sub && <div className="text-xs text-muted2">{sub}</div>}
  </div>
)

export const MgmtDashScreen = () => {
  const year = new Date().getFullYear()
  const [d, setD] = useState({ ar: null, ap: null, contracts: [], vat: { quarters: [] } })

  useEffect(() => {
    let alive = true
    ;(async () => {
      const [ar, ap, contracts, vat] = await Promise.all([
        api.getReceivables(), api.getPayables(), api.getContracts(), api.getVatSummary(year),
      ])
      if (alive) setD({ ar, ap, contracts, vat })
    })()
    return () => { alive = false }
  }, [])

  const contractTotal = d.contracts.reduce((s, c) => s + (c.amount || 0), 0)
  const vatPayable = (d.vat.quarters || []).reduce((s, q) => s + (q.payable || 0), 0)
  const arTotal = d.ar?.summary?.total || 0
  const apTotal = d.ap?.summary?.total || 0

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 8 }}>
        <div>
          <div className="page-title">경영 대시보드</div>
          <div className="page-sub">계약·미수·미지급·세무 현황을 한 화면에서 확인합니다.</div>
        </div>
      </div>
      <Spacer h={20}/>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        <Card label="계약금액 합계" amount={contractTotal} tone="ink" sub={`${d.contracts.length}건`}/>
        <Card label="미수금 총액" amount={arTotal} tone="warn-ink" sub={`${d.ar?.summary?.count || 0}건`}/>
        <Card label="미지급금 총액" amount={apTotal} tone="neg-ink" sub={`${d.ap?.summary?.count || 0}건`}/>
        <Card label={`${year} 부가세 ${vatPayable >= 0 ? '납부' : '환급'}세액`} amount={Math.abs(vatPayable)} tone={vatPayable >= 0 ? 'neg-ink' : 'brand'} sub="매출−매입세액"/>
      </div>
      <Spacer h={24}/>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card card-pad">
          <div className="section-title" style={{ marginBottom: 12 }}>진행중 계약 상위</div>
          {d.contracts.filter(c => c.status === '진행중').slice(0, 6).map(c => (
            <div key={c.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="fw-600 text-sm">{c.name}</span>
              <span className="num ml-auto text-sm">{fmtNum(c.amount || 0)}원</span>
            </div>
          ))}
          {d.contracts.length === 0 && <div className="text-sm text-muted2">계약이 없어요</div>}
        </div>
        <div className="card card-pad">
          <div className="section-title" style={{ marginBottom: 12 }}>{year} 분기별 부가세</div>
          {(d.vat.quarters || []).map(q => (
            <div key={q.quarter} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <span className="fw-600 text-sm">{q.quarter}분기</span>
              <span className="text-xs text-muted2" style={{ marginLeft: 8 }}>{q.status}</span>
              <span className="num ml-auto text-sm" style={{ color: q.payable < 0 ? 'var(--brand)' : 'var(--neg-ink)' }}>
                {q.payable < 0 ? '환급 ' : ''}{fmtNum(Math.abs(q.payable))}
              </span>
            </div>
          ))}
          {(d.vat.quarters || []).length === 0 && <div className="text-sm text-muted2">집계할 세금계산서가 없어요</div>}
        </div>
      </div>
    </div>
  )
}
