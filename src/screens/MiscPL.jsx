import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, StatusBadge } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DataTable } from '../lib/components/DataTable'
import { api } from '../lib/api'

const TABS = [
  { id: 'expense', label: '경비·수수료·잡손실', kind: 'expense' },
  { id: 'income',  label: '잡수익',            kind: 'income'  },
]

// 판관비(운영비)·잡손익 = 어느 계약에도 붙지 않는 돈.
// 이 앱에서 매출원가는 계약에 귀속시키는 게 규칙이라(근거 계약 contract_id / 원가 귀속 cost_contract_id),
// '두 축 모두 비어 있음' = 계약과 무관한 판관비다. 비목 코드 범위로 나누지 않는 이유는,
// 사용자가 새로 만든 비목이 EXP-905처럼 자동 채번돼 코드 범위에 뜻이 없기 때문.
//
// 이 화면은 '조회'가 아니라 '등록'하는 곳이다 — 계약 없는 경비는 여기서 등록·수정·삭제까지 끝난다.
// (계약에 걸린 원가·지급은 매입 쪽에서, 세금계산서 있는 매입 대금은 매입 대금청구서에서)
export const MiscPLScreen = ({ refreshTrigger, openExpense, openIncome, openEdit }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [tab, setTab] = useState('expense')
  const [rows, setRows] = useState([])
  const cur = TABS.find(t => t.id === tab)

  const load = async () => {
    const list = await api.getTransactions({ kind: cur.kind })
    setRows(list.filter(r => !r.contractId && !r.cost_contract_id))
  }
  useEffect(() => { load() }, [tab, refreshTrigger])

  const total = rows.reduce((s, r) => s + (r.amount || 0), 0)

  const remove = async (e, r) => {
    e.stopPropagation()   // 행 클릭(수정)과 겹치지 않게
    const ok = await confirm({
      tone: 'warn', icon: <Icon.Warn size={22}/>, title: '거래 삭제',
      body: `${r.date} · ${r.category} · ${fmtNum(r.amount)}원 거래를 삭제할까요? 계좌 잔액에 반영된 거래면 잔액도 되돌아가요.`,
      confirmLabel: '삭제',
    })
    if (!ok) return
    const res = await api.deleteTransaction(r.id)
    toast.push(res.ok ? '삭제됐어요' : (res.error || '삭제에 실패했어요'), res.ok ? undefined : { tone: 'warn' })
    load()
  }

  const addBtn = tab === 'expense'
    ? <button className="btn primary" onClick={openExpense}><Icon.Plus size={14}/> 경비 등록</button>
    : <button className="btn primary" onClick={openIncome}><Icon.Plus size={14}/> 잡수익 등록</button>

  return (
    <div className="fade-up">
      <PageHeader title="경비·잡손익"
        sub="어느 계약에도 붙지 않은 운영비(임차료·통신비 등)·수수료·잡수익·잡손실을 여기서 등록·관리합니다. 계약에 걸린 원가·지급은 매입 쪽에서 봅니다."
        actions={addBtn}/>
      <div className="card">
        <div className="row gap-8" style={{ padding: '16px 16px', borderBottom: '1px solid var(--line)' }}>
          {TABS.map(t => (
            <button key={t.id} className={`chip ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
          <div className="ml-auto text-sm text-muted">합계 <span className="num fw-700" style={{ color: 'var(--ink)' }}>{fmtNum(total)}원</span> · {rows.length}건</div>
        </div>
        <DataTable
          rows={rows}
          onRowClick={(r) => openEdit(r)}
          empty={tab === 'expense' ? '등록된 경비가 없어요. 위 "경비 등록"으로 추가하세요.' : '등록된 잡수익이 없어요.'}
          columns={[
            { key: 'date', header: '날짜', sortable: true, render: r => <span className="num text-sm">{r.date}</span> },
            { key: 'vendor', header: '거래처', sortable: true, render: r => <span className="fw-600">{r.vendor}</span> },
            { key: 'category', header: '비목', render: r => <span className="badge outline">{r.category}</span> },
            { key: 'scope', header: '적요/구분', render: r => <span className="text-sm text-muted">{r.scope}</span> },
            { key: 'amount', header: '금액', align: 'right', sortable: true, render: r => <span className="num-cell fw-700">{fmtNum(r.amount)}</span> },
            { key: 'status', header: '상태', render: r => <StatusBadge status={r.status}/> },
            { key: '_act', header: '', render: r => (
              <button className="btn" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--neg)' }} onClick={(e) => remove(e, r)}>삭제</button>
            ) },
          ]}
        />
      </div>
    </div>
  )
}
