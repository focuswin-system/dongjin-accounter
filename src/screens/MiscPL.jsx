import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, StatusBadge } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DataTable } from '../lib/components/DataTable'
import { api } from '../lib/api'

// 같은 '주문 없는 돈'이지만 메뉴가 둘로 갈린다:
//   일반 경비 = 판관비 지출(임차료·통신비·수수료 등)  ← 대부분의 건
//   잡손익    = 영업외 수입(이자·환급·잡수익)
// 화면은 하나를 공유하고 진입 메뉴가 초기 탭을 정한다(대금청구서의 발행/수취와 같은 방식).
const TABS = [
  { id: 'expense', label: '일반 경비', kind: 'expense',
    title: '일반 경비',
    sub: '어느 주문에도 붙지 않은 운영비(임차료·통신비·수수료 등)를 등록·관리합니다. 주문에 걸린 원가·지급은 매입 쪽에서 봅니다.',
    empty: '등록된 경비가 없어요. 위 "경비 등록"으로 추가하세요.',
    addLabel: '경비 등록' },
  { id: 'income',  label: '잡손익', kind: 'income',
    title: '잡손익',
    sub: '영업과 무관하게 생긴 수입(이자·환급·잡수익)입니다. 나가는 돈은 일반 경비에서 봅니다.',
    empty: '등록된 잡수익이 없어요.',
    addLabel: '잡수익 등록' },
]

// 판관비(운영비)·잡손익 = 어느 주문에도 붙지 않는 돈.
// 이 앱에서 매출원가는 주문에 귀속시키는 게 규칙이라(근거 주문 contract_id / 원가 귀속 cost_contract_id),
// '두 축 모두 비어 있음' = 주문과 무관한 판관비다. 비목 코드 범위로 나누지 않는 이유는,
// 사용자가 새로 만든 비목이 EXP-905처럼 자동 채번돼 코드 범위에 뜻이 없기 때문.
//
// 이 화면은 '조회'가 아니라 '등록'하는 곳이다 — 주문 없는 경비는 여기서 등록·수정·삭제까지 끝난다.
// (주문에 걸린 원가·지급은 매입 쪽에서, 세금계산서 있는 매입 대금은 매입 대금청구서에서)
export const MiscPLScreen = ({ initialTab = 'expense', refreshTrigger, openExpense, openIncome, openEdit }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [tab, setTab] = useState(initialTab)
  // 메뉴(일반 경비 ↔ 잡손익)로 다시 들어오면 그 탭으로 맞춘다
  useEffect(() => { setTab(initialTab) }, [initialTab])
  const [rows, setRows] = useState([])
  const cur = TABS.find(t => t.id === tab)

  const load = async () => {
    const list = await api.getTransactions({ kind: cur.kind })
    /* 재무 거래(대출 실행·원금 상환·예적금 납입·투자)는 손익이 아니라 여기서 뺀다.
     * 이 화면은 주문 두 축이 비었는지만 봤는데, 재무 거래도 주문이 없어서 그대로 섞였다
     * → 3억 대출을 실행하면 **잡손익 합계가 3억**이 됐다. 손익 아닌 돈이 수익으로 보인다.
     * 판정은 서버가 계정과목 대분류로 한다(server/lib/pnl.js 와 같은 규칙). */
    /* ⚠ 급여·청구서 정산은 뺀다.
     * 이 화면은 '주문에 안 붙는 자잘한 수익·비용'을 보는 곳인데, 주문 두 축이 비었는지만
     * 봐서 **급여와 청구서 정산이 그대로 섞였다.** 실데이터로 보니 58건 중
     * 급여 20건(6,208만)·정산 2건(1,452만)이 들어와, 합계의 대부분이 급여였다
     * — 경비를 보려고 연 화면에서 경비가 안 보인다.
     * 둘 다 각자의 화면(인사급여·대금청구서)에서 관리하는 건이라 여기서 셀 이유가 없다. */
    setRows(list.filter(r =>
      !r.contractId && !r.cost_contract_id && r.isPnl !== false && !r.payrollId && !r.invoiceId))
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

  const addBtn = (
    <button className="btn primary" onClick={cur.kind === 'expense' ? openExpense : openIncome}>
      <Icon.Plus size={14}/> {cur.addLabel}
    </button>
  )

  return (
    <div className="fade-up">
      {/* 제목은 **메뉴 이름**이다 — 메뉴가 '경비 처리'인데 제목이 탭 이름('일반 경비')이면
          같은 화면이 두 이름을 갖는다(nav.js·Billing.jsx 가 같은 규칙을 지킨다).
          탭이 무엇인지는 바로 아래 칩과 이 설명줄이 말한다 —
          `sub` 는 여태 TABS 에 적혀만 있고 화면에 안 나오던 값이다. */}
      <PageHeader title="경비 처리" sub={cur.sub} actions={addBtn}/>
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
          empty={cur.empty}
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
