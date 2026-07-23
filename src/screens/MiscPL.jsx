import { useState, useEffect } from 'react'
import { fmtNum, Spacer, StatusBadge } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DataTable } from '../lib/components/DataTable'
import { api } from '../lib/api'

const TABS = [
  { id: 'expense', label: '경비·수수료·잡손실', kind: 'expense' },
  { id: 'income',  label: '잡수익',            kind: 'income'  },
]

// 계약과 무관한 일반 경비·잡손익 (계약 미연결 거래를 모아봄)
export const MiscPLScreen = () => {
  const [tab, setTab] = useState('expense')
  const [rows, setRows] = useState([])
  const cur = TABS.find(t => t.id === tab)

  const load = async () => {
    const list = await api.getTransactions({ kind: cur.kind })
    setRows(list.filter(r => !r.contractId))
  }
  useEffect(() => { load() }, [tab])

  const total = rows.reduce((s, r) => s + (r.amount || 0), 0)

  return (
    <div className="fade-up">
      <PageHeader title="경비·잡손익" sub="계약과 무관한 일반 경비·수수료·잡수익·잡손실 거래를 모아봅니다. 등록·수정은 거래내역에서 하세요."/>
      <div className="card">
        <div className="row gap-8" style={{ padding: '16px 16px', borderBottom: '1px solid var(--line)' }}>
          {TABS.map(t => (
            <button key={t.id} className={`chip ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
          <div className="ml-auto text-sm text-muted">합계 <span className="num fw-700" style={{ color: 'var(--ink)' }}>{fmtNum(total)}원</span> · {rows.length}건</div>
        </div>
        <DataTable
          rows={rows}
          empty="해당 거래가 없어요"
          columns={[
            { key: 'date', header: '날짜', sortable: true, render: r => <span className="num text-sm">{r.date}</span> },
            { key: 'vendor', header: '거래처', sortable: true, render: r => <span className="fw-600">{r.vendor}</span> },
            { key: 'category', header: '비목', render: r => <span className="badge outline">{r.category}</span> },
            { key: 'scope', header: '적요/구분', render: r => <span className="text-sm text-muted">{r.scope}</span> },
            { key: 'amount', header: '금액', align: 'right', sortable: true, render: r => <span className="num-cell fw-700">{fmtNum(r.amount)}</span> },
            { key: 'status', header: '상태', render: r => <StatusBadge status={r.status}/> },
          ]}
        />
      </div>
    </div>
  )
}
