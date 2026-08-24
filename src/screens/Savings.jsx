import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Drawer, Combobox, MoneyInput, localToday, DateInput } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { Kpi, KpiRow } from '../lib/components/Kpi'
import { DataTable } from '../lib/components/DataTable'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { api } from '../lib/api'

/* 적금·정기예금·보증금 — 자금 '운용'. 차입금(자금 조달)의 거울상이다.
 *
 * 화면에서 계속 드러내는 것 두 가지:
 *   1. 납입은 **비용이 아니다.** 돈이 통장에서 나가지만 회사 재산은 그대로다.
 *      숫자만 보여주면 사용자가 '지출'로 오해하고 손익을 잘못 읽는다.
 *   2. 여기 있는 돈은 **당장 못 쓴다.** 그래서 자금일보에서 '묶인 자금'으로 따로 센다.
 *
 * 보증금이 여기 있는 이유: 임차보증금은 회사 재산인데 주문이 끝나야 돌아온다 —
 * 위 두 성질이 예적금과 똑같다. 다만 **회계 자리는 다르다.** 예적금은 금융상품
 * (1201 단기 / 1501 장기)이고 보증금은 **1801 보증금(기타비유동자산)**이다.
 * 한 화면에 있다고 같은 계정과목을 붙이면 재무상태표에서 자리가 틀린다.
 */

const KIND_LABEL = { installment: '적금', deposit: '예금', guarantee: '보증금', pension: '퇴직연금' }
const KIND_HINT = {
  installment: '매월 정해진 금액을 넣고 만기에 원리금을 받아요.',
  deposit: '목돈을 한 번에 넣고 만기에 원리금을 받아요.',
  guarantee: '임차보증금처럼 주문이 끝나야 돌려받는 돈이에요. 만기도 이자도 없어요.',
  pension: '확정급여형(DB) 퇴직연금 적립금이에요. 만기도 이자도 없고, 직원이 퇴직할 때 나갑니다.',
}
/* 만기·이자·회차가 없는 둘 — 보증금과 퇴직연금. 폼에서는 noMat 으로 묶어 쓴다.
   서버 lib/savings.js 의 noMaturity() 와 같은 기준이어야 한다(한쪽만 고치면 화면과 저장이 어긋난다). */
const isGuarantee = (s) => s?.kind === 'guarantee'
const isPension = (s) => s?.kind === 'pension'
const STATUS_LABEL = { active: '진행 중', matured: '만기', closed: '해지' }

const dday = (date) => {
  if (!date) return ''
  const d = Math.round((new Date(date) - new Date(localToday())) / 86400000)
  return d === 0 ? '오늘' : d > 0 ? `D-${d}` : `${-d}일 지남`
}
const ddayTone = (date) => {
  const d = Math.round((new Date(date) - new Date(localToday())) / 86400000)
  return d < 0 ? 'neg' : d <= 7 ? 'warn' : 'outline'
}

export const SavingsScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [payTarget, setPayTarget] = useState(null)      // { s, cycle }
  const [bulkTarget, setBulkTarget] = useState(null)    // { s, cycles }
  const [matureTarget, setMatureTarget] = useState(null)
  const [expanded, setExpanded] = useState(null)

  const load = async () => {
    setLoading(true)
    const [list, accs] = await Promise.all([api.getSavings(), api.getAccounts()])
    setRows(list)
    setAccounts(accs.filter(a => a.kind !== 'card'))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const active = rows.filter(r => r.status === 'active')
  const totalBalance = active.reduce((s, r) => s + Number(r.balance || 0), 0)
  const expectedInterest = active.reduce((s, r) => s + Number(r.maturity?.interest || 0), 0)
  // 예정일이 지났는데 안 낸 회차 — 자동이체가 실패했거나 잔액이 모자랐던 경우다
  const overdue = active.flatMap(s => (s.overdue_payments || []).map(c => ({ s, cycle: c })))

  const nextMaturity = useMemo(() => {
    const withDate = active.filter(r => r.maturity_date).sort((a, b) => (a.maturity_date < b.maturity_date ? -1 : 1))
    return withDate[0] || null
  }, [rows])

  const doPay = async (s, cycle, body) => {
    const r = await api.paySavings(s.id, body)
    if (!r.ok) return toast.push(r.error || '납입 처리에 실패했어요', { tone: 'warn' })
    toast.push(`${s.name} ${r.seq}회차 ${fmtNum(r.amount)}원 납입했어요`)
    setPayTarget(null); load()
  }

  const doBulk = async (s, accountId) => {
    const r = await api.paySavingsMissed(s.id, { account_id: accountId })
    if (!r.ok) return toast.push(r.error || '일괄 처리에 실패했어요', { tone: 'warn' })
    toast.push(r.count ? `${r.count}건 · ${fmtNum(r.total)}원 납입 처리했어요` : '처리할 회차가 없어요')
    setBulkTarget(null); load()
  }

  const doDelete = async (s) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: `"${s.name}" 삭제`,
      body: '등록을 취소합니다. 납입 실적이 있으면 삭제되지 않아요.', confirmLabel: '삭제',
    })
    if (!ok) return
    const r = await api.deleteSavings(s.id)
    if (!r.ok) return toast.push(r.error || '삭제에 실패했어요', { tone: 'warn' })
    toast.push('삭제했어요'); load()
  }

  // 첫 로딩에만 통째로 가린다. 갱신할 때마다 가리면 표가 언마운트돼
  // 사용자가 걸어둔 정렬이 매번 풀린다(납입 한 건 처리할 때마다 순서가 되돌아간다).
  if (loading && rows.length === 0) {
    return <div className="text-sm text-muted" style={{ padding: 40, textAlign: 'center' }}>불러오는 중…</div>
  }

  return (
    <div className="fade-up">
      <PageHeader title="적금·정기예금·보증금"
        sub={overdue.length > 0 ? `납입일이 지난 회차 ${overdue.length}건이 있어요` : '자금 운용 — 여기 있는 돈은 당장 쓸 수 없어요'}
        actions={<button className="btn primary" onClick={() => { setEditing(null); setFormOpen(true) }}>
          <Icon.Plus size={14}/> 등록
        </button>}/>

      <KpiRow cols={3} style={{ marginBottom: 20 }}>
        <Kpi label="묶인 자금" value={totalBalance} badge={`${active.length}건`}
          hint="예적금·보증금·퇴직연금 — 당장 쓸 수 없어요"/>
        <Kpi label="만기까지 받을 이자" value={expectedInterest} tone="pos" hint="세전 · 단리 기준"/>
        <Kpi label="가장 가까운 만기" value={nextMaturity ? nextMaturity.maturity_date : '—'}
          badge={nextMaturity ? dday(nextMaturity.maturity_date) : undefined}
          hint={nextMaturity ? nextMaturity.name : '진행 중인 상품이 없어요'}/>
      </KpiRow>

      {/* 놓친 납입 — 자동이체가 실패했을 수 있으니 맨 위에 세운다 */}
      {overdue.length > 0 && (
        <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
          <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="badge neg"><Icon.Warn size={12}/> 놓친 납입</span>
            <span className="fw-700 text-sm">{overdue.length}건</span>
            <span className="num text-sm text-muted">{fmtNum(overdue.reduce((s, o) => s + o.cycle.amount, 0))}원</span>
            <span className="text-xs text-muted2" style={{ flex: 1 }}>납입일이 지났는데 처리되지 않았어요</span>
            {/* 상품별로 묶어 일괄 — 회차 순서를 건너뛸 수 없으므로 한 상품씩 처리한다 */}
            {Object.values(overdue.reduce((acc, o) => {
              (acc[o.s.id] ||= { s: o.s, cycles: [] }).cycles.push(o.cycle)
              return acc
            }, {})).map(g => (
              <button key={g.s.id} className="btn sm" onClick={() => setBulkTarget(g)}>
                <Icon.Receipt size={12}/> {g.s.name} {g.cycles.length}건 일괄
              </button>
            ))}
          </div>
          <DataTable
            rowKey={r => `${r.s.id}-${r.cycle.seq}`}
            rows={overdue}
            columns={[
              { key: 'due', header: '납입일', width: 170, render: ({ cycle }) => (
                <span className="num text-sm">{cycle.due_date}
                  <span className={`badge ${ddayTone(cycle.due_date)}`} style={{ marginLeft: 6, fontSize: 10 }}>{dday(cycle.due_date)}</span>
                </span>
              )},
              { key: 'name', header: '상품', className: 'fw-700', render: ({ s }) => s.name },
              { key: 'seq', header: '회차', width: 80, className: 'text-sm text-muted', render: ({ cycle }) => `${cycle.seq}회차` },
              { key: 'amount', header: '금액', width: 130, align: 'right', className: 'num-cell fw-700', render: ({ cycle }) => fmtNum(cycle.amount) },
              { key: 'act', header: '', width: 120, render: (r) => (
                <button className="btn sm primary" onClick={() => setPayTarget(r)}>납입 처리</button>
              )},
            ]}/>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <DataTable
          rows={rows}
          empty="등록된 적금·정기예금·보증금이 없어요. 위에서 추가하세요."
          renderExpanded={s => (expanded === s.id ? <SavingsDetail s={s}/> : null)}
          columns={[
            { key: 'name', header: '상품', sortable: true, className: 'fw-700', render: s => (
              <span style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                <Icon.Down size={12} style={{ marginRight: 6, transform: expanded === s.id ? 'none' : 'rotate(-90deg)', opacity: 0.5 }}/>
                {s.name}
              </span>
            )},
            { key: 'kind', header: '구분', width: 90, render: s => <span className="badge outline">{KIND_LABEL[s.kind]}</span> },
            { key: 'bank', header: '금융기관', width: 110, className: 'text-sm text-muted', sortable: true, render: s => s.bank || '—' },
            { key: 'annual_rate', header: '이율', width: 90, className: 'num text-sm', sortable: true,
              render: s => (Number(s.annual_rate) ? `연 ${Number(s.annual_rate)}%` : '—') },
            { key: 'balance', header: '쌓인 금액', width: 130, align: 'right', className: 'num-cell fw-700',
              sortable: true, sortValue: s => Number(s.balance) || 0, render: s => fmtNum(s.balance) },
            { key: 'total', header: '만기 수령(세전)', width: 140, align: 'right', className: 'num-cell',
              sortable: true, sortValue: s => s.maturity?.total || 0,
              // 보증금·퇴직연금은 만기가 없다 — 0원이라 적으면 "못 받는 돈"으로 읽힌다
              render: s => (isGuarantee(s) ? <span className="text-muted2">돌려받음</span>
                : isPension(s) ? <span className="text-muted2">퇴직 시 지급</span>
                : fmtNum(s.maturity?.total || 0)) },
            { key: 'maturity_date', header: '만기일', width: 140, className: 'num text-sm', sortable: true, render: s => (
              <>{s.maturity_date || '—'}
                {s.status === 'active' && s.maturity_date && (
                  <span className={`badge ${ddayTone(s.maturity_date)}`} style={{ marginLeft: 6, fontSize: 10 }}>{dday(s.maturity_date)}</span>
                )}
              </>
            )},
            { key: 'status', header: '상태', width: 90, render: s => (
              <span className={`badge ${s.status === 'active' ? 'pos' : 'outline'}`}>
                {isGuarantee(s) && s.status === 'matured' ? '반환' : STATUS_LABEL[s.status]}
              </span>
            )},
            { key: 'act', header: '', width: 200, render: s => (
              <div className="row gap-4">
                {s.status === 'active' && s.kind === 'installment' && s.next_payment && (
                  <button className="btn sm primary" onClick={() => setPayTarget({ s, cycle: s.next_payment })}>납입</button>
                )}
                {/* 퇴직연금은 만기 수령이 없다 — 적립금은 퇴직자에게 나가지 회사 통장으로
                    돌아오지 않는다. 버튼을 두면 있지도 않은 입금이 찍힌다(서버도 막는다). */}
                {s.status === 'active' && !isPension(s) && (
                  <button className="btn ghost sm" onClick={() => setMatureTarget(s)}>{isGuarantee(s) ? '반환' : '만기'}</button>
                )}
                {s.status === 'active' && <button className="btn ghost sm" onClick={() => { setEditing(s); setFormOpen(true) }}>수정</button>}
                <button className="btn ghost sm" style={{ color: 'var(--neg)' }} onClick={() => doDelete(s)}>삭제</button>
              </div>
            )},
          ]}/>
      </div>

      <div className="text-xs text-muted2" style={{ marginTop: 14, lineHeight: 1.7 }}>
        · 납입한 돈은 <b>비용이 아니에요.</b> 통장에서 나가지만 회사 재산은 그대로예요(보통예금 → 금융상품).
        그래서 손익에는 잡히지 않고, 만기 이자만 수익으로 잡혀요.<br/>
        · 여기 있는 돈은 만기까지 묶여 있어서 <b>자금일보에서 '묶인 자금'</b>으로 따로 보여드려요.<br/>
        · <b>보증금·퇴직연금</b>도 같은 이유로 여기 있어요. 다만 회계 자리는 달라서 예적금은 금융상품,
        보증금은 <b>기타비유동자산(1801 보증금)</b>, 퇴직연금은 <b>투자자산(1505 퇴직연금운용자산)</b>으로 잡힙니다.<br/>
        · 퇴직연금은 <b>확정급여형(DB)</b>만 여기예요. 확정기여형(DC)은 납입하는 순간 회사 돈이
        아니게 되므로 정기지출에서 <b>퇴직급여</b> 비용으로 처리해주세요.
      </div>

      <SavingsForm open={formOpen} onClose={() => setFormOpen(false)} editing={editing}
        accounts={accounts} onSaved={() => { setFormOpen(false); load() }}/>
      <PayDrawer target={payTarget} accounts={accounts} onClose={() => setPayTarget(null)} onPay={doPay}/>
      <BulkPayDrawer target={bulkTarget} accounts={accounts} onClose={() => setBulkTarget(null)} onPay={doBulk}/>
      <MatureDrawer target={matureTarget} accounts={accounts} onClose={() => setMatureTarget(null)}
        onDone={() => { setMatureTarget(null); load() }}/>
    </div>
  )
}

/** 펼침 — 납입 스케줄과 실적 */
const SavingsDetail = ({ s }) => {
  const paidSeq = new Set((s.payments || []).map(p => Number(p.seq)))
  const sched = s.schedule || []
  if (isGuarantee(s)) {
    return (
      <div style={{ padding: '14px 18px' }} className="text-sm">
        <div className="row gap-16" style={{ flexWrap: 'wrap' }}>
          <span>보증금 <b className="num">{fmtNum(s.principal)}원</b></span>
          <span className="text-muted">계정과목 <b>1801 보증금</b></span>
          <span className="text-muted">지급일 <b className="num">{s.start_date}</b></span>
        </div>
        <div className="text-xs text-muted2" style={{ marginTop: 8, lineHeight: 1.6 }}>
          보증금은 만기도 이자도 없어요. 주문이 끝나면 <b>반환</b>으로 처리하면 통장에 들어온 것으로 잡힙니다.<br/>
          재무상태표에서는 예적금(당좌·투자자산)이 아니라 <b>기타비유동자산</b>에 섭니다 — 1년 안에 현금이 되지 않으니까요.
        </div>
      </div>
    )
  }
  if (isPension(s)) {
    return (
      <div style={{ padding: '14px 18px' }} className="text-sm">
        <div className="row gap-16" style={{ flexWrap: 'wrap' }}>
          <span>적립금 <b className="num">{fmtNum(s.principal)}원</b></span>
          <span className="text-muted">계정과목 <b>1505 퇴직연금운용자산</b></span>
          <span className="text-muted">기준일 <b className="num">{s.start_date}</b></span>
        </div>
        <div className="text-xs text-muted2" style={{ marginTop: 8, lineHeight: 1.6 }}>
          확정급여형(DB) 적립금이에요. 만기도 이자도 없고, <b>직원이 퇴직할 때</b> 여기서 나갑니다.<br/>
          나갈 때 회사 통장을 거치지 않는 게 보통이라 <b>만기 수령 처리는 없어요</b> —
          적립금이 바뀌면 <b>수정</b>으로 잔액을 맞춰주세요.<br/>
          확정기여형(DC)이라면 여기가 아니에요. 납입하는 순간 회사 돈이 아니게 되므로
          정기지출에서 <b>퇴직급여(5202)</b> 비용으로 처리해야 합니다.
        </div>
      </div>
    )
  }
  if (s.kind === 'deposit') {
    return (
      <div style={{ padding: '14px 18px' }} className="text-sm">
        <div className="row gap-16" style={{ flexWrap: 'wrap' }}>
          <span>예치 원금 <b className="num">{fmtNum(s.principal)}원</b></span>
          <span>만기 이자(세전) <b className="num">{fmtNum(s.maturity?.interest || 0)}원</b></span>
          <span>이자소득세 예상 <b className="num">{fmtNum(s.maturity?.tax || 0)}원</b></span>
          <span>세후 수령 <b className="num">{fmtNum(s.maturity?.afterTax || 0)}원</b></span>
        </div>
        <div className="text-xs text-muted2" style={{ marginTop: 8 }}>
          예금은 납입 회차가 없어요. 가입할 때 목돈이 한 번 나갑니다.
          이자소득세는 참고용이에요 — 법인은 원천징수 후 법인세에서 정산해요.
        </div>
      </div>
    )
  }
  return (
    <div style={{ padding: '10px 18px 16px' }}>
      <div className="row gap-16 text-sm" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        <span>월 납입 <b className="num">{fmtNum(s.monthly_amount)}원</b></span>
        <span>납입 {s.paid_count}/{sched.length}회</span>
        <span>만기 이자(세전) <b className="num">{fmtNum(s.maturity?.interest || 0)}원</b></span>
        <span>세후 수령 <b className="num">{fmtNum(s.maturity?.afterTax || 0)}원</b></span>
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        <DataTable
          rows={sched}
          rowKey={c => c.seq}
          columns={[
            { key: 'seq', header: '회차', width: 60, className: 'num text-sm' },
            { key: 'due_date', header: '납입일', width: 120, className: 'num text-sm' },
            { key: 'amount', header: '금액', width: 120, align: 'right', className: 'num-cell', render: c => fmtNum(c.amount) },
            { key: 'cumulative', header: '누계', width: 130, align: 'right', className: 'num-cell text-muted', render: c => fmtNum(c.cumulative) },
            { key: 'state', header: '상태', width: 90, render: c => (paidSeq.has(c.seq)
              ? <span className="badge pos">납입</span>
              : <span className={`badge ${ddayTone(c.due_date)}`}>{dday(c.due_date)}</span>) },
          ]}/>
      </div>
    </div>
  )
}

/** 등록·수정 — 저장 전에 만기 수령액을 계산해 보여준다(가입 판단의 핵심 숫자다) */
const SavingsForm = ({ open, onClose, editing, accounts, onSaved }) => {
  const toast = useToast()
  const blank = {
    kind: 'installment', name: '', bank: '', monthly_amount: '', principal: '',
    annual_rate: '', term_months: '12', start_date: localToday(), pay_day: '',
    account_id: '', memo: '',
    // 보증금 전용 — 지금 내는 돈인가(=출금 거래를 만든다), 예전에 이미 낸 것인가.
    // 기본은 후자다. 대개 이미 나간 돈을 뒤늦게 등록하는데, 거래를 또 만들면 잔액이 두 번 빠진다.
    recorded: false,
  }
  const [f, setF] = useState(blank)
  const [preview, setPreview] = useState(null)
  // 왕복 중 두 번 누르면 예금은 출금 거래가 두 건 생겨 계좌 잔액이 두 번 빠진다
  // (납입·만기는 서버가 FOR UPDATE로 막지만 등록에는 그런 방어가 없다)
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }))
  const guar = f.kind === 'guarantee'
  const pen  = f.kind === 'pension'
  // 만기·이율 칸을 지울지 — 보증금과 퇴직연금이 같다
  const noMat = guar || pen

  useEffect(() => {
    if (!open) { setPreview(null); return }   // 닫을 때 비운다 — 다음에 열 때 직전 상품 숫자가 남는다
    setF(editing ? {
      kind: editing.kind, name: editing.name, bank: editing.bank || '',
      monthly_amount: String(editing.monthly_amount || ''), principal: String(editing.principal || ''),
      annual_rate: String(editing.annual_rate || ''), term_months: String(editing.term_months || '12'),
      start_date: editing.start_date, pay_day: String(editing.pay_day || ''),
      account_id: editing.account_id || '', memo: editing.memo || '', recorded: false,
    } : blank)
  }, [open, editing])

  // 입력이 바뀔 때마다 서버에 계산을 맡긴다 — 화면과 서버가 다른 식을 쓰면 저장 후 숫자가 달라진다
  useEffect(() => {
    if (!open) return
    if (noMat) { setPreview(null); return }   // 보증금·퇴직연금은 만기 계산이 없다
    const t = setTimeout(async () => {
      setPreview(await api.previewSavings({
        kind: f.kind, principal: f.principal, monthly_amount: f.monthly_amount,
        annual_rate: f.annual_rate, term_months: f.term_months,
        start_date: f.start_date, pay_day: f.pay_day,
      }))
    }, 250)
    return () => clearTimeout(t)
  }, [open, noMat, f.kind, f.principal, f.monthly_amount, f.annual_rate, f.term_months, f.start_date, f.pay_day])

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      const body = {
        kind: f.kind, name: f.name.trim(), bank: f.bank.trim(),
        monthly_amount: f.monthly_amount, principal: f.principal,
        annual_rate: f.annual_rate, term_months: f.term_months,
        start_date: f.start_date, pay_day: f.pay_day,
        account_id: f.account_id || null, memo: f.memo,
        // 보증금·퇴직연금에서만 의미가 있다. 예금은 서버가 기본 true, 적금은 가입만으로 출금이 없다.
        recorded: noMat ? !!f.recorded : undefined,
      }
      const r = editing ? await api.updateSavings(editing.id, body) : await api.addSavings(body)
      if (!r.ok) return toast.push(r.error || '저장에 실패했어요', { tone: 'warn' })
      toast.push(editing ? '수정했어요' : '등록했어요')
      onSaved()
    } finally { setBusy(false) }
  }

  return (
    <Drawer open={open} onClose={onClose}>
      <DrawerHead title={`${KIND_LABEL[f.kind]} ${editing ? '수정' : '등록'}`}
        sub={KIND_HINT[f.kind]} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div>
          <label className="label">구분</label>
          <div className="row gap-4">
            {['installment', 'deposit', 'guarantee', 'pension'].map(k => (
              <button key={k} type="button" className={`chip ${f.kind === k ? 'active' : ''}`}
                disabled={!!editing} onClick={() => set('kind', k)}>{KIND_LABEL[k]}</button>
            ))}
          </div>
          {editing && <div className="text-xs text-muted2" style={{ marginTop: 4 }}>구분은 등록 후 바꿀 수 없어요.</div>}
        </div>
        <div>
          <label className="label">{guar ? '보증금 이름 *' : pen ? '제도 이름 *' : '상품명 *'}</label>
          <input className="input" value={f.name} onChange={e => set('name', e.target.value)}
            placeholder={guar ? '예) 로봇랜드재단 임대료보증금'
              : pen ? '예) 퇴직연금 (우리은행)' : '예) 기업 정기적금'}/>
        </div>
        <div>
          <label className="label">{guar ? '받는 곳' : pen ? '운용기관' : '금융기관'}</label>
          <input className="input" value={f.bank} onChange={e => set('bank', e.target.value)}
            placeholder={guar ? '예) 로봇랜드재단' : '예) 우리은행'}/>
        </div>
        {f.kind === 'installment' ? (
          <div>
            <label className="label">월 납입액 *</label>
            <MoneyInput value={f.monthly_amount} onChange={v => set('monthly_amount', v)}/>
          </div>
        ) : (
          <div>
            <label className="label">{guar ? '보증금 금액 *' : pen ? '적립금 잔액 *' : '예치 금액 *'}</label>
            <MoneyInput value={f.principal} onChange={v => set('principal', v)}/>
          </div>
        )}
        {/* 보증금·퇴직연금은 만기도 이자도 없다 — 칸을 그려 두면 사용자가 뭔가 채워야 하는 줄 안다 */}
        {!noMat && (
          <div className="row gap-8">
            <div style={{ flex: 1 }}>
              <label className="label">연 이율 (%)</label>
              <input className="input" value={f.annual_rate} onChange={e => set('annual_rate', e.target.value)} placeholder="4.0"/>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label">기간 (개월) *</label>
              <input className="input" value={f.term_months} onChange={e => set('term_months', e.target.value)} placeholder="12"/>
            </div>
          </div>
        )}
        <div className="row gap-8">
          <div style={{ flex: 1 }}>
            <label className="label">{guar ? '지급일 *' : pen ? '기준일 *' : '가입일 *'}</label>
            <DateInput className="input" value={f.start_date} onChange={e => set('start_date', e.target.value)}/>
          </div>
          {f.kind === 'installment' && (
            <div style={{ flex: 1 }}>
              <label className="label">납입일</label>
              <input className="input" value={f.pay_day} onChange={e => set('pay_day', e.target.value)} placeholder="가입일과 같은 날"/>
            </div>
          )}
        </div>
        {/* 보증금은 대개 몇 년 전에 이미 낸 것을, 퇴직연금은 여태 쌓인 적립금 잔액을
            뒤늦게 등록한다. 그때 통장에 이미 출금이 찍혀 있으므로, 여기서 거래를 또 만들면
            잔액이 두 번 빠진다(퇴직연금은 과거 몇 년치가 오늘 하루에 나간 것처럼 찍힌다). */}
        {/* 수정할 때는 안 보여준다 — PUT 이 recorded 를 읽지 않아 눌러도 거래가 안 생긴다.
            "거래를 만듭니다"라는 안내가 수정 모드에서는 거짓이었다. 등록에서만 뜻이 있다. */}
        {noMat && !editing && (
          <div>
            <label className="label">{pen ? '지금 납입하는 금액인가요?' : '지금 내는 보증금인가요?'}</label>
            <div className="row gap-4">
              {(pen ? [[false, '여태 쌓인 적립금'], [true, '지금 납입해요']]
                    : [[false, '이미 낸 보증금'], [true, '지금 내요']]).map(([v, l]) => (
                <button key={String(v)} type="button" className={`chip ${!!f.recorded === v ? 'active' : ''}`}
                  onClick={() => set('recorded', v)}>{l}</button>
              ))}
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>
              {f.recorded
                ? `아래 계좌에서 ${pen ? '납입액이' : '보증금이'} 빠져나간 것으로 거래를 만듭니다.`
                : '거래는 만들지 않아요. 통장에 이미 찍힌 출금과 겹치지 않게요.'}
            </div>
          </div>
        )}
        <div>
          <label className="label">{f.kind === 'installment' ? '납입 출금 계좌' : '출금 계좌'}</label>
          <Combobox value={f.account_id} onChange={v => set('account_id', v)}
            options={accounts.map(a => ({ value: a.id, label: a.name, sub: [a.bankName, a.number].filter(Boolean).join(' ') }))}
            placeholder="계좌 선택"/>
          <div className="text-xs text-muted2" style={{ marginTop: 4 }}>
            {guar
              ? (f.recorded ? '이 계좌에서 보증금이 빠져나갑니다.' : '나중에 돌려받을 때 이 계좌로 들어온 것으로 잡아요.')
              : pen
                ? (f.recorded ? '이 계좌에서 납입액이 빠져나갑니다.' : '거래를 만들지 않으면 계좌는 쓰지 않아요. 나중에 납입할 때 쓸 계좌를 적어두세요.')
              : f.kind === 'deposit'
                ? '가입하는 순간 이 계좌에서 목돈이 빠져나갑니다.'
                : '매월 이 계좌에서 납입액이 빠져나갑니다. 가입만으로는 돈이 나가지 않아요.'}
          </div>
        </div>
        <div>
          <label className="label">메모</label>
          <input className="input" value={f.memo} onChange={e => set('memo', e.target.value)}/>
        </div>

        {/* 만기 미리보기 — 가입 판단의 핵심 숫자라 저장 전에 보여준다 */}
        {preview && preview.principal > 0 && (
          <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
            <div className="text-xs fw-700" style={{ marginBottom: 8 }}>만기에 이렇게 됩니다</div>
            <div className="col gap-4 text-sm">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="text-muted">{f.kind === 'installment' ? '총 납입 원금' : '예치 원금'}</span>
                <b className="num">{fmtNum(preview.principal)}원</b>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="text-muted">이자 (세전)</span>
                <b className="num" style={{ color: 'var(--pos-ink)' }}>+{fmtNum(preview.interest)}원</b>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="text-muted">이자소득세 15.4% (참고)</span>
                <span className="num text-muted">−{fmtNum(preview.tax)}원</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--line)', paddingTop: 6, marginTop: 2 }}>
                <span className="fw-700">세후 수령액</span>
                <b className="num" style={{ fontSize: 15 }}>{fmtNum(preview.afterTax)}원</b>
              </div>
              <div className="text-xs text-muted2" style={{ marginTop: 4 }}>
                만기 {preview.maturityDate || '—'}
                {f.kind === 'installment' && preview.firstDue && ` · 첫 납입 ${preview.firstDue} · 마지막 ${preview.lastDue}`}
              </div>
            </div>
            {f.kind === 'installment' && (
              <div className="text-xs text-muted2" style={{ marginTop: 8, lineHeight: 1.6 }}>
                적금 이자는 회차마다 예치 기간이 달라요. 그래서 "총 납입액 × 이율"보다 적게 나옵니다.
              </div>
            )}
          </div>
        )}
      </div>
      <DrawerFooter onCancel={onClose} onSave={save} saveDisabled={busy}
        saveLabel={busy ? '저장 중…' : (editing ? '수정' : '등록')}/>
    </Drawer>
  )
}

const PayDrawer = ({ target, accounts, onClose, onPay }) => {
  const [payDate, setPayDate] = useState(localToday())
  const [acct, setAcct] = useState('')
  useEffect(() => {
    if (!target) return
    setPayDate(target.cycle.due_date > localToday() ? localToday() : target.cycle.due_date)
    setAcct(target.s.account_id || '')
  }, [target])
  if (!target) return null
  const { s, cycle } = target
  return (
    <Drawer open onClose={onClose}>
      <DrawerHead title="적금 납입" sub={`${s.name} ${cycle.seq}회차`} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="text-muted text-sm">납입액</span>
            <b className="num" style={{ fontSize: 16 }}>{fmtNum(cycle.amount)}원</b>
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
            예정일 {cycle.due_date} · 이 돈은 <b>비용이 아니라 자산</b>이에요(보통예금 → 금융상품).
          </div>
        </div>
        <div>
          <label className="label">납입일</label>
          <DateInput className="input" value={payDate} onChange={e => setPayDate(e.target.value)}/>
        </div>
        <div>
          <label className="label">출금 계좌 *</label>
          <Combobox value={acct} onChange={setAcct}
            options={accounts.map(a => ({ value: a.id, label: a.name, sub: [a.bankName, a.number].filter(Boolean).join(' ') }))}
            placeholder="계좌 선택"/>
          <div className="text-xs text-muted2" style={{ marginTop: 4 }}>이 계좌의 잔액에서 빠집니다.</div>
        </div>
      </div>
      <DrawerFooter onCancel={onClose} onSave={() => onPay(s, cycle, { pay_date: payDate, account_id: acct, seq: cycle.seq })} saveLabel="납입 처리"/>
    </Drawer>
  )
}

const BulkPayDrawer = ({ target, accounts, onClose, onPay }) => {
  const [acct, setAcct] = useState('')
  useEffect(() => { if (target) setAcct(target.s.account_id || '') }, [target])
  if (!target) return null
  const { s, cycles } = target
  const total = cycles.reduce((a, c) => a + c.amount, 0)
  return (
    <Drawer open onClose={onClose}>
      <DrawerHead title="놓친 납입 일괄 처리" sub={`${s.name} · ${cycles.length}건`} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="text-muted text-sm">합계</span>
            <b className="num" style={{ fontSize: 16 }}>{fmtNum(total)}원</b>
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
            각 회차는 <b>예정일 그대로</b> 기록돼요(자동이체가 그날 나갔을 테니까요).
            마감된 달이 하나라도 섞여 있으면 전체가 취소돼요.
          </div>
        </div>
        <div style={{ maxHeight: 180, overflowY: 'auto' }}>
          <DataTable
            rows={cycles}
            rowKey={c => c.seq}
            columns={[
              { key: 'due_date', header: '납입일', className: 'num text-sm' },
              { key: 'seq', header: '회차', width: 90, className: 'text-sm text-muted', render: c => `${c.seq}회차` },
              { key: 'amount', header: '금액', width: 120, align: 'right', className: 'num-cell', render: c => fmtNum(c.amount) },
            ]}/>
        </div>
        <div>
          <label className="label">출금 계좌 *</label>
          <Combobox value={acct} onChange={setAcct}
            options={accounts.map(a => ({ value: a.id, label: a.name, sub: [a.bankName, a.number].filter(Boolean).join(' ') }))}
            placeholder="계좌 선택"/>
        </div>
      </div>
      <DrawerFooter onCancel={onClose} onSave={() => onPay(s, acct)} saveLabel={`${cycles.length}건 처리`}/>
    </Drawer>
  )
}

/** 만기 — 원금과 이자를 나눠 기록한다. 이자는 실제 수령액을 받는다(우대금리·중도해지로 다를 수 있다) */
const MatureDrawer = ({ target, accounts, onClose, onDone }) => {
  const toast = useToast()
  const [date, setDate] = useState(localToday())
  const [acct, setAcct] = useState('')
  const [interest, setInterest] = useState('')
  useEffect(() => {
    if (!target) return
    setDate(localToday())
    setAcct(target.account_id || '')
    setInterest(String(target.maturity?.interest || 0))
  }, [target])
  if (!target) return null
  const principal = Number(target.balance || 0)
  const guar = isGuarantee(target)
  const save = async () => {
    const r = await api.matureSavings(target.id, { received_date: date, account_id: acct, interest: guar ? 0 : interest })
    if (!r.ok) return toast.push(r.error || (guar ? '반환 처리에 실패했어요' : '만기 처리에 실패했어요'), { tone: 'warn' })
    toast.push(guar
      ? `보증금 ${fmtNum(r.principal)}원을 돌려받은 것으로 기록했어요`
      : `${fmtNum(r.total)}원 입금 처리했어요 (원금 ${fmtNum(r.principal)} + 이자 ${fmtNum(r.interest)})`)
    onDone()
  }
  return (
    <Drawer open onClose={onClose}>
      <DrawerHead title={guar ? '보증금 반환' : '만기 수령'} sub={target.name} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="text-muted text-sm">{guar ? '돌려받을 보증금' : '받을 원금 (실제 납입분)'}</span>
            <b className="num">{fmtNum(principal)}원</b>
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6, lineHeight: 1.6 }}>
            {guar
              ? <>보증금은 <b>수익이 아니에요</b> — 맡겨둔 내 돈이 돌아오는 거예요. 주문이 끝나 실제로 받았을 때만 처리하세요.</>
              : <>원금은 <b>수익이 아니에요</b> — 맡겨둔 내 돈이 돌아오는 거예요. 이자만 수익으로 기록됩니다.
                 그래서 거래가 두 건으로 나뉩니다.</>}
          </div>
        </div>
        {/* 보증금에는 이자가 없다 — 칸을 두면 뭔가 넣어야 하는 줄 안다 */}
        {!guar && (
          <div>
            <label className="label">실제 받은 이자 (세전)</label>
            <MoneyInput value={interest} onChange={setInterest}/>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>
              예상값을 넣어뒀어요. 우대금리나 중도해지로 달라졌다면 실제 금액으로 고쳐주세요.
            </div>
          </div>
        )}
        <div>
          <label className="label">입금일</label>
          <DateInput className="input" value={date} onChange={e => setDate(e.target.value)}/>
        </div>
        <div>
          <label className="label">입금 계좌 *</label>
          <Combobox value={acct} onChange={setAcct}
            options={accounts.map(a => ({ value: a.id, label: a.name, sub: [a.bankName, a.number].filter(Boolean).join(' ') }))}
            placeholder="계좌 선택"/>
        </div>
      </div>
      <DrawerFooter onCancel={onClose} onSave={save} saveLabel={guar ? '반환 처리' : '만기 처리'}/>
    </Drawer>
  )
}
