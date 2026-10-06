import { useState, useEffect, useMemo } from 'react'
import { GoOrAsk } from '../lib/components/GoOrAsk'
import { Icon, fmtNum, useToast, useConfirm, MoneyInput, DateInput, localToday, fmtDateShort, periodToRange } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { SummaryCard, SummaryRow } from '../lib/components/Kpi'
import { DataTable } from '../lib/components/DataTable'
import { TableToolbar } from '../lib/components/TableToolbar'
import { useTableFilter } from '../lib/tableFilter'
import { Drawer } from '../lib/ui'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { AccountField } from '../lib/components/AccountField'
import { api } from '../lib/api'
import { TxnQuickDrawer } from '../lib/components/TxnQuickDrawer'
import { ImportWizard } from '../lib/components/ImportWizard'
import { cardImportAdapter } from '../lib/cardImport'
import { accountLabels } from '../lib/accountLabel'
import { payDayLabel } from '../lib/cardPayDay'

/**
 * 카드 대금 — 카드마다 **회차별로 제대로 냈나**를 보고, 카드를 열어 갚는다.
 *
 * ── 화면 (2026-10-02 사용자) ──
 *   "카드가 여러 개 뜨고, 최근 5회차까지 이상 없는지와 현재 상태를 보고,
 *    카드를 누르면 팝업에서 회차 칩으로 회차별 납부 상황을 보고 거기서 지급 처리"
 *   · 메인: 요약 → 카드 타일(미결제·이번 결제 예정·밀린 대금 + 최근 회차 칩) → 기간 사용 표
 *   · 팝업: 회차 칩 → 그 회차의 사용·낸 돈·남은 돈·사용 내역 → 지급(통장·금액·날짜) → 지급 이력
 *
 * ── 숫자는 서버가 낸다(server/lib/cardBill.js) ──
 *   회차 = 지난 결제일 다음날 ~ 이번 결제일. 갚은 돈은 **오래된 회차부터** 채운다(카드사와 같다).
 *   서버 조회는 카드 수와 무관하게 세 번이고, 이 화면도 낱건은 **필요한 만큼만** 받는다 —
 *   표는 보이는 기간만, 팝업은 고른 회차만, 업로드 대조는 업로드를 시작할 때 그 카드만.
 *   (예전엔 회사 지출 전체를 한 번에 받아 화면에서 걸렀다)
 *
 * ⚠ 건별로 골라 갚는 기능은 없다 — 카드사에 "이 건만"은 없다. 금액 단위로 갚는다.
 * ⚠ 차액(명세서 − 장부)은 계산하지 않는다 — 카드사 청구액은 종이에만 있다. 구간과 장부 사용액을 내준다.
 * ⚠ 체크카드는 없다 — 쓴 즉시 통장에서 빠져 갚을 것이 없다.
 */

const mmdd = (d) => (d ? `${Number(d.slice(5, 7))}.${d.slice(8, 10)}` : '')
const monthOf = (d) => `${Number(d.slice(5, 7))}월`
const sum = (arr, k) => arr.reduce((s, x) => s + (Number(x[k]) || 0), 0)

/* 회차 상태 → 말과 색. 상태색은 뜻이라 액센트를 따르지 않는다(테마 규칙) */
const STATUS = {
  paid:        { label: '완납',      badge: 'pos',     dot: 'var(--pos)' },
  unpaid:      { label: '미납',      badge: 'neg',     dot: 'var(--neg)' },
  partial:     { label: '일부 미납', badge: 'neg',     dot: 'var(--neg)' },
  due:         { label: '결제 예정', badge: 'outline', dot: 'var(--brand)' },
  partial_due: { label: '일부 냄',   badge: 'outline', dot: 'var(--brand)' },
  none:        { label: '사용 없음', badge: 'outline', dot: 'var(--line-strong)' },
}

/* 회차 칩 — 타일(작게·읽기만)과 팝업(고르기)이 같은 모양을 쓴다 */
const CycleChip = ({ c, active, onClick, compact = false }) => {
  const st = STATUS[c.status] || STATUS.none
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={`chip ${active ? 'active' : ''}`} data-view=""
      title={`${mmdd(c.payDate)} 결제 · ${st.label}${c.used ? ` · 사용 ${fmtNum(c.used)}` : ''}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: onClick ? 'pointer' : 'default',
        ...(compact ? { padding: '2px 8px', fontSize: 11.5 } : null) }}>
      <span style={{ width: 7, height: 7, borderRadius: 7, background: st.dot, flexShrink: 0 }}/>
      {monthOf(c.payDate)}
      {!compact && <span className="text-muted2" style={{ fontSize: 11 }}>{st.label}</span>}
    </Tag>
  )
}

export const CardPaymentScreen = ({ openEdit, goRoute }) => {
  const [accounts, setAccounts] = useState([])
  const [bills, setBills] = useState([])
  const [uses, setUses] = useState([])              // 보이는 기간의 카드 사용(이체 제외)
  const [openId, setOpenId] = useState(null)        // 팝업으로 연 카드
  const [txnOpen, setTxnOpen] = useState(null)
  const [importing, setImporting] = useState(null)  // { cardId, existing } — cardId '' 이면 마법사에서 고른다
  const [categories, setCategories] = useState([])
  const [employees, setEmployees] = useState([])   // 업로드 '사용 직원' 칸 확인용(이름만)
  const [loading, setLoading] = useState(true)

  const tf = useTableFilter({
    date: { field: 'date', initial: periodToRange('month') },
    search: { fields: ['memo', 'vendor', 'category', 'employeeName'], placeholder: '가맹점·비목·사용 직원 검색' },
    // 카드 — 자주 거르는 축이라 바에 바로 세운다(inline). 이름이 겹치면 끝자리로 가른다
    filters: [{ key: 'card', label: '카드', field: 'accountId', inline: true, placeholder: '전체 카드',
      options: accountLabels(accounts).filter(a => bills.some(b => b.id === a.id)).map(a => ({ value: a.id, label: a.label })) }],
  })
  const from = tf.range?.from, to = tf.range?.to

  const cardIdsOf = (accs) => new Set(accs.filter(a => a.kind === 'card').map(a => a.id))
  // 표는 **보이는 기간만** 서버에서 거른다
  const loadUses = async (accs, r = { from, to }) => {
    const rows = await api.getTransactions({ kind: 'expense', from: r.from, to: r.to })
    const ids = cardIdsOf(accs)
    /* 회차 숫자(서버 cardBill)와 같은 기준 — **완료된 지출만**, 카드에서 나간 이체(현금서비스 등)도 갚을 돈이다.
       예전엔 상태를 안 거르고 이체를 빼서 '사용 X원'과 아래 목록 합계가 달랐다(2026-10-02 검토) */
    setUses((rows || []).filter(t => t.status === '지급완료' && ids.has(t.accountId)))
  }
  const loadBills = async () => {
    const [accs, b] = await Promise.all([api.getAccounts(), api.getCardBills()])
    setAccounts(accs || []); setBills(b || [])
    return [accs || [], b || []]
  }
  const reload = async () => { const [accs] = await loadBills(); await loadUses(accs) }
  /* 처음 기간 = **이번 회차들**(가장 이른 회차 시작 ~ 가장 늦은 결제일). 달력 '이번 달'로 두면
     월초엔 표가 비고(10/2 → 0건) 결제 예정액과 견줄 수도 없다. 그다음은 사람이 바꾼다 */
  useEffect(() => {
    (async () => {
      const [accs, b] = await loadBills()
      const cy = b.map(x => x.cycle).filter(Boolean)
      let r = { from, to }
      if (cy.length) {
        r = { from: cy.map(c => c.from).sort()[0], to: cy.map(c => c.to).sort().pop() }
        tf.setRange(r)
      }
      await loadUses(accs, r)
    })().finally(() => setLoading(false))
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!loading) loadUses(accounts) }, [from, to])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.getCategories().then(r => setCategories(r || [])).catch(() => {}) }, [])
  useEffect(() => { api.getEmployeeOptions().then(r => setEmployees(r || [])).catch(() => {}) }, [])

  const byId = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts])
  // 이름이 겹치는 카드는 끝자리를 붙여 가른다(lib/accountLabel)
  const labelOf = useMemo(() => new Map(accountLabels(accounts).map(a => [a.id, a.label])), [accounts])
  const creditCards = useMemo(() => accounts.filter(a => a.kind === 'card' && a.cardType === 'credit'), [accounts])
  const importAdapter = useMemo(
    () => cardImportAdapter({ cards: creditCards, categories, employees, defaultAccountId: importing?.cardId || '' }),
    [creditCards, categories, employees, importing?.cardId])
  const shownUses = useMemo(() => tf.apply(uses), [uses, tf.apply])   // eslint-disable-line react-hooks/exhaustive-deps

  /* 명세서 업로드 — 대조 대상은 **그 카드의 전 기간** 사용분(명세서가 표의 기간과 다를 수 있다).
     업로드를 시작할 때만 받는다. 카드를 안 골랐으면 모든 카드. 다른 카드의 같은 날·같은 금액이
     '확인 필요'로 잡혀 멀쩡한 줄이 빠지지 않게 고른 카드로 좁힌다(예전 결정 그대로) */
  const startImport = async (cardId) => {
    // 대조 대상은 **모든 카드** — 줄마다 카드가 다를 수 있다. 다른 카드끼리 섞이지 않게 키에 카드를 넣는다(cardImport buildIndex)
    const rows = await api.getTransactions({ kind: 'expense' })
    const ids = cardIdsOf(accounts)
    setOpenId(null)
    setImporting({ cardId, existing: (rows || []).filter(t => !t.transferId && ids.has(t.accountId)) })
  }

  const due = bills.filter(b => b.current > 0)
  const overdue = bills.filter(b => b.overdue > 0)
  const nextPay = due.map(b => b.cycle?.payDate).filter(Boolean).sort()[0]

  if (importing) return (
    <ImportWizard adapter={importAdapter} existing={importing.existing}
      onCancel={() => setImporting(null)}
      onDone={() => { setImporting(null); reload() }}/>
  )

  return (
    <div className="fade-up">
      <PageHeader title="카드 대금"
        sub="카드별로 회차마다 제대로 냈는지 봅니다. 카드를 누르면 회차별 내역과 지급이 열려요."
        actions={creditCards.length > 0 ? <button className="btn excel" onClick={() => startImport('')}><Icon.Excel/> 엑셀 업로드</button> : null}/>

      <SummaryRow cols={3}>
        <SummaryCard label="다음 결제 예정" amount={sum(due, 'current')} count={due.length} unit="장" accent="brand"
          hint={nextPay ? `가장 가까운 결제일 ${mmdd(nextPay)}` : '결제일 기준 이번 회차 사용분'}/>
        <SummaryCard label="밀린 대금" amount={sum(overdue, 'overdue')} count={overdue.length} unit="장" accent="neg"
          warn={overdue.length > 0} hint="결제일이 지났는데 남은 돈"/>
        <SummaryCard label="기간 사용" amount={sum(shownUses, 'amount')} count={shownUses.length} accent="blue"
          hint={from ? `${mmdd(from)} ~ ${mmdd(to)} 사용` : '전체 기간 사용'}/>
      </SummaryRow>

      {!loading && bills.length === 0 && (
        <div className="card card-pad row gap-12" style={{ marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="text-sm">등록된 신용카드가 없어요.</span>
          <span className="ml-auto">
            <GoOrAsk route="master_card" action="create" go={goRoute} ask="카드 등록은 기준정보(카드) 권한이 있는 담당자에게 요청해 주세요.">
              카드 등록 <Icon.Right size={12}/>
            </GoOrAsk>
          </span>
        </div>
      )}

      {/* 카드 타일 — 지금 상태 + 최근 회차. 누르면 팝업 */}
      {bills.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))', gap: 12, marginTop: 16 }}>
          {bills.map(b => (
            <button key={b.id} type="button" className="card card-pad" onClick={() => setOpenId(b.id)}
              style={{ textAlign: 'left', cursor: 'pointer', width: '100%', font: 'inherit', color: 'inherit',
                ...(b.overdue > 0 ? { borderColor: 'var(--neg)' } : null) }}>
              <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                <span className="fw-700">{labelOf.get(b.id) || b.name}</span>
                <Icon.Right size={14} className="text-muted2 ml-auto"/>
              </div>
              <div className="text-xs text-muted" style={{ marginTop: 2 }}>
                {b.pay_day ? `매월 ${payDayLabel(b.pay_day)} 결제` : <span style={{ color: 'var(--warn-ink)' }}>결제일 미설정</span>}
                {' · '}{b.pay_account_name || <span style={{ color: 'var(--neg-ink)' }}>결제 계좌 미설정</span>}
              </div>
              <div className="row" style={{ marginTop: 12, alignItems: 'flex-end', gap: 16 }}>
                <div>
                  <div className="text-xs text-muted2">미결제</div>
                  <div className="num fw-700" style={{ fontSize: 20 }}>{fmtNum(b.unpaid)}</div>
                </div>
                <div className="ml-auto text-xs" style={{ textAlign: 'right' }}>
                  {b.cycle && <div className="text-muted">{mmdd(b.cycle.payDate)} 결제 예정 <b className="num" style={{ color: 'var(--ink)' }}>{fmtNum(b.current)}</b></div>}
                  {b.overdue > 0 && <div style={{ color: 'var(--neg-ink)', marginTop: 2 }}>밀린 대금 <b className="num">{fmtNum(b.overdue)}</b></div>}
                </div>
              </div>
              {b.cycles?.length > 0 && (
                <div className="row gap-4" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                  {b.cycles.map(c => <CycleChip key={c.payDate} c={c} compact/>)}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* 기간 사용 — 모든 카드. 다른 화면처럼 표 위에 제목을 두지 않는다 */}
      <div style={{ marginTop: 24 }}><TableToolbar {...tf.toolbarProps}/></div>
      <div className="card" style={{ overflow: 'hidden', marginTop: 12 }}>
        <DataTable tableKey="card-usage" rows={shownUses} loading={loading} rowKey={t => t.id} onRowClick={t => setTxnOpen(t.id)}
          empty="이 기간에 카드로 쓴 내역이 없어요."
          columns={[
            { key: 'date', header: '날짜', sortable: true, render: t => <span className="num">{fmtDateShort(t.date)}</span> },
            { key: 'card', header: '카드', sortable: true, sortValue: t => labelOf.get(t.accountId) || '',
              render: t => labelOf.get(t.accountId) || byId.get(t.accountId)?.name || '—' },
            /* 카드 사용은 가맹점이 적요에 있는 일이 대부분 — 거래처가 없을 때 붙는 '(미확인)'은 여기선 소음 */
            { key: 'memo', header: '가맹점 · 적요', maxWidth: 360, render: t => <>{t.vendorId ? <><b>{t.vendor}</b>{t.memo ? ' ' : ''}</> : null}{t.memo}</> },
            { key: 'category', header: '비목', sortable: true },
            // 법인카드는 여럿이 나눠 쓴다 — 누가 썼는지가 이 표의 값어치다
            { key: 'employeeName', header: '사용 직원', render: t => t.employeeName || t.employee || <span className="text-muted2">—</span> },
            { key: 'evid', header: '증빙', label: '증빙', render: t => (t.evid_url || (t.docs && t.docs.length))
              ? <span className="badge pos" style={{ fontSize: 10 }}>첨부</span> : <span className="text-muted2">—</span> },
            { key: 'amount', header: '금액', align: 'right', sortable: true, render: t => <span className="num fw-600">{fmtNum(t.amount)}</span> },
          ]}
          footer={shownUses.length > 0 && (
            <tr><td colSpan={6} className="text-sm text-muted">합계 {shownUses.length}건</td>
              <td className="num-right num fw-700">{fmtNum(sum(shownUses, 'amount'))}</td></tr>
          )}/>
      </div>

      {txnOpen && <TxnQuickDrawer txnId={txnOpen} onClose={() => setTxnOpen(null)} onChanged={reload} openEdit={openEdit}/>}
      {openId && bills.some(b => b.id === openId) && (
        <CardBillDrawer bill={bills.find(b => b.id === openId)} label={labelOf.get(openId)} accounts={accounts}
          goRoute={goRoute} onClose={() => setOpenId(null)} onChanged={reload}
          onUpload={() => startImport(openId)} onAccounts={setAccounts}/>
      )}
    </div>
  )
}

/* ── 카드 팝업 — 회차 칩 → 회차별 납부 상황 → 지급 → 지급 이력 ─────────────── */
const CardBillDrawer = ({ bill, label, accounts, goRoute, onClose, onChanged, onUpload, onAccounts }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const today = localToday()
  const cycles = bill.cycles || []
  const name = label || bill.name
  /* 처음 여는 회차 — 가장 오래된 **밀린** 회차. 없으면 이번 회차 */
  const [pick, setPick] = useState(() => {
    const owe = cycles.find(c => c.status === 'unpaid' || c.status === 'partial')
    return (owe || cycles[cycles.length - 1] || {}).payDate || null
  })
  const cy = cycles.find(c => c.payDate === pick) || null
  const [rows, setRows] = useState(null)   // 고른 회차의 사용 내역
  const [paid, setPaid] = useState(null)   // 이 카드의 지급 이력
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)

  // 회차를 고를 때마다 그 회차 사용분만 받는다
  useEffect(() => {
    if (!cy) { setRows([]); return }
    let alive = true
    setRows(null)
    api.getTransactions({ kind: 'expense', accountId: bill.id, from: cy.from, to: cy.to }).then(r => {
      if (alive) setRows((r || []).filter(t => t.status === '지급완료').sort((a, b) => String(a.date).localeCompare(String(b.date))))
    })
    return () => { alive = false }
  }, [bill.id, cy?.payDate, bill.unpaid])   // eslint-disable-line react-hooks/exhaustive-deps
  /* 지급 이력 = 카드 쪽에 들어온 **이체**(받는 쪽 줄). 환불·취소(이체 아님)는 뺀다.
     지우면 서버가 이체 두 줄을 함께 지운다(routes/transactions.js DELETE) */
  useEffect(() => {
    let alive = true
    api.getTransactions({ kind: 'income', accountId: bill.id }).then(r => {
      if (alive) setPaid((r || []).filter(t => t.transferId).sort((a, b) => String(b.date).localeCompare(String(a.date))))
    })
    return () => { alive = false }
  }, [bill.id, bill.unpaid])

  /* 이 회차까지 남은 돈 — 갚은 돈은 오래된 회차부터 채워지므로, 이 회차를 끝내려면 앞의 밀린 돈까지 내야 한다 */
  const upTo = cy ? (bill.before_remain || 0) + sum(cycles.filter(c => c.payDate <= cy.payDate), 'remain') : bill.unpaid
  useEffect(() => {
    setForm(f => ({
      fromAccountId: f?.fromAccountId ?? (bill.pay_account_id || ''),
      amount: String(upTo > 0 ? upTo : bill.unpaid),
      /* 지급일 기본 = 오늘. 밀린 회차를 오늘 갚는데 지난 결제일로 넣으면 통장 출금이 소급돼 그 사이 잔액 이력이
         바뀌고, 마감된 달이면 막힌다(2026-10-02 검토). 자동이체를 나중에 적을 땐 사용자가 날짜를 고친다 */
      date: today,
      memo: cy ? `${bill.name} ${monthOf(cy.payDate)} 대금` : `${bill.name} 카드대금`,
    }))
  }, [cy?.payDate, upTo, bill.unpaid])   // eslint-disable-line react-hooks/exhaustive-deps

  const st = cy ? (STATUS[cy.status] || STATUS.none) : null
  const amt = Number(String(form?.amount || '').replace(/[^0-9-]/g, '')) || 0
  const fromAcct = accounts.find(a => a.id === form?.fromAccountId)
  const short = fromAcct && fromAcct.currentBalance != null && fromAcct.currentBalance < amt
  const left = bill.unpaid - amt

  const save = async () => {
    if (!form.fromAccountId) return toast.push('어느 통장에서 갚을지 골라 주세요', { tone: 'warn' })
    if (amt <= 0) return toast.push('금액을 입력해 주세요', { tone: 'warn' })
    if (busy) return
    setBusy(true)   // 확인창 전에 — 연타로 두 번 지급되지 않게
    const ok = await confirm({
      tone: 'brand', icon: <Icon.Card size={22}/>, title: '카드 대금 지급',
      body: `${fromAcct?.name}에서 ${fmtNum(amt)}원으로 ${name} 대금을 갚습니다.`,
      detail: (left > 0 ? `갚고 나면 미결제 ${fmtNum(left)}원이 남아요. ` : '') + '손익에는 잡히지 않아요.',
      confirmLabel: '지급',
    })
    try {
      if (!ok) return
      const res = await api.transfer({ fromAccountId: form.fromAccountId, toAccountId: bill.id, amount: amt, date: form.date, memo: form.memo })
      if (!res.ok) return toast.push(res.error || '지급하지 못했어요', { tone: 'warn' })
      toast.push('카드 대금을 지급했어요')
      await onChanged?.()
    } finally { setBusy(false) }
  }
  const removePay = async (t) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: '지급 취소',
      body: `${mmdd(t.date)} ${fmtNum(t.amount)}원 지급을 지웁니다.`,
      detail: '통장 출금과 카드 입금 두 줄이 함께 지워져요.', confirmLabel: '삭제',
    })
    if (!ok) return
    const res = await api.deleteTransaction(t.id)
    toast.push(res.ok ? '지급을 취소했어요' : (res.error || '취소하지 못했어요'), res.ok ? undefined : { tone: 'warn' })
    onChanged?.()
  }

  /* 회차 요약 — 왼쪽 맨 위. 카드 명세서처럼 **사용 − 낸 돈 = 남은 돈**을 위에서 아래로 읽게 한다.
     (숫자 하나만 크게 띄우니 무엇에서 무엇을 뺀 값인지가 안 보였다 — 2026-10-02 사용자) */
  const overdueCy = cy && cy.remain > 0 && cy.payDate < today
  const sumLine = (label, sub, v, strong) => (
    <div className="row" style={{ alignItems: 'baseline', gap: 8, padding: strong ? '10px 0 0' : '4px 0' }}>
      <span className={strong ? 'fw-700' : 'text-sm text-muted'}>{label}</span>
      {sub && <span className="text-xs text-muted2">{sub}</span>}
      <span className={`num ml-auto ${strong ? 'fw-700' : 'text-sm'}`}
        style={strong ? { fontSize: 20, color: overdueCy ? 'var(--neg-ink)' : undefined } : undefined}>{v}</span>
    </div>
  )
  const cycleHead = cy && (
    <div>
      <div className="row gap-6" style={{ alignItems: 'center', marginBottom: 8 }}>
        <span className="fw-700">{mmdd(cy.payDate)} 결제</span>
        <span className={`badge ${st.badge}`} style={{ fontSize: 10 }}>{st.label}</span>
      </div>
      {sumLine('사용', <span className="num">{mmdd(cy.from)} ~ {mmdd(cy.to)} · {cy.count}건</span>, fmtNum(cy.used))}
      {sumLine('낸 돈', null, cy.paid > 0 ? `− ${fmtNum(cy.paid)}` : '0')}
      <div style={{ borderTop: '1px solid var(--line-strong)', marginTop: 6 }}/>
      {sumLine('남은 돈', null, fmtNum(cy.remain), true)}
    </div>
  )

  /* 지급 입력 — 왼쪽 */
  const payForm = form && bill.unpaid > 0 && (
    <div className="col gap-form" style={{ borderTop: '1px solid var(--line)', paddingTop: 20 }}>
      <div>
        <label className="label">어느 통장에서 갚나요 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
        <AccountField kind="bank" valueKey="id" value={form.fromAccountId}
          accounts={accounts.filter(a => a.kind !== 'card')} allAccounts={accounts}
          onChange={v => setForm(f => ({ ...f, fromAccountId: v }))}
          onCreated={async () => { const l = await api.getAccounts(); if (Array.isArray(l)) onAccounts?.(l) }}/>
        {!bill.pay_account_id && <div className="text-xs text-muted2" style={{ marginTop: 6 }}>기준정보 › 카드에서 결제 계좌를 정해 두면 자동으로 골라져요</div>}
        {short && (
          <div className="text-xs" style={{ color: 'var(--neg-ink)', marginTop: 6 }}>
            {fromAcct.name} 잔액 {fmtNum(fromAcct.currentBalance)}원 — {fmtNum(amt - fromAcct.currentBalance)}원 모자라요
          </div>
        )}
      </div>
      <div>
        <label className="label">갚는 금액 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
        <MoneyInput value={form.amount} onChange={raw => setForm(f => ({ ...f, amount: raw }))}/>
        <div className="row gap-6" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          {cy && upTo > 0 && upTo !== bill.unpaid && (
            <button type="button" className={`chip ${amt === upTo ? 'active' : ''}`} onClick={() => setForm(f => ({ ...f, amount: String(upTo) }))}>
              {monthOf(cy.payDate)}까지 {fmtNum(upTo)}
            </button>
          )}
          <button type="button" className={`chip ${amt === bill.unpaid ? 'active' : ''}`} onClick={() => setForm(f => ({ ...f, amount: String(bill.unpaid) }))}>
            전액 {fmtNum(bill.unpaid)}
          </button>
        </div>
        {left < 0 && <div className="text-xs text-muted2" style={{ marginTop: 6 }}>미결제보다 {fmtNum(-left)}원 많아요 — 카드에 잔액이 생깁니다</div>}
      </div>
      <div><label className="label">지급일 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
        <DateInput className="input" max={today} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}/>
      </div>
      <div><label className="label">내용</label>
        <input className="input" value={form.memo} onChange={e => setForm(f => ({ ...f, memo: e.target.value }))}/>
      </div>
    </div>
  )

  /* 목록 — 오른쪽: 고른 회차 사용 내역 + 지급 이력 */
  const lineRow = { padding: '7px 16px', borderTop: '1px solid var(--line)', gap: 10 }
  const ellipsis = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
  const empty = (msg) => <div className="text-sm text-muted2" style={{ padding: '12px 16px', borderTop: '1px solid var(--line)' }}>{msg}</div>
  const lists = (
    <div className="col gap-16" style={{ minWidth: 0 }}>
      {cy && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="row" style={{ padding: '8px 8px 8px 16px', alignItems: 'center' }}>
            <span className="fw-700 text-sm">{monthOf(cy.payDate)} 회차 사용 내역</span>
            <button className="btn ghost sm ml-auto" onClick={onUpload}><Icon.Excel size={13}/> 엑셀 업로드</button>
          </div>
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {rows === null ? empty('불러오는 중…')
              : rows.length === 0 ? empty('이 회차에 장부에 올라온 사용 내역이 없어요.')
              : rows.map(t => (
                <div key={t.id} className="row text-sm" style={lineRow}>
                  <span className="num text-muted" style={{ width: 40, flexShrink: 0 }}>{mmdd(t.date)}</span>
                  <span style={ellipsis}>{t.memo || t.vendor}</span>
                  <span className="text-xs text-muted2" style={{ flexShrink: 0 }}>{t.category}</span>
                  <span className="num" style={{ width: 84, textAlign: 'right', flexShrink: 0 }}>{fmtNum(t.amount)}</span>
                </div>
              ))}
          </div>
        </div>
      )}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="fw-700 text-sm" style={{ padding: '10px 16px' }}>지급 이력</div>
        <div style={{ maxHeight: 200, overflowY: 'auto' }}>
          {paid === null ? empty('불러오는 중…')
            : paid.length === 0 ? empty('이 카드에 대금을 낸 기록이 없어요.')
            : paid.map(t => (
              <div key={t.id} className="row text-sm" style={{ ...lineRow, alignItems: 'center' }}>
                <span className="num text-muted" style={{ width: 76, flexShrink: 0 }}>{fmtDateShort(t.date)}</span>
                <span style={ellipsis}>{t.memo}</span>
                <span className="num fw-600">{fmtNum(t.amount)}</span>
                <button className="btn ghost sm" style={{ color: 'var(--neg-ink)' }} onClick={() => removePay(t)}>취소</button>
              </div>
            ))}
        </div>
      </div>
    </div>
  )

  return (
    <Drawer open onClose={onClose} size="lg" label="카드 대금">
      <DrawerHead title={name}
        sub={`${bill.pay_day ? `매월 ${payDayLabel(bill.pay_day)} 결제` : '결제일 미설정'} · 미결제 ${fmtNum(bill.unpaid)}원`}
        onClose={onClose}/>
      <div className="drawer-body col gap-16">
        {!bill.pay_day ? (
          <div className="card card-pad row gap-12" style={{ alignItems: 'center', flexWrap: 'wrap', borderColor: 'var(--warn)' }}>
            <span className="text-sm">결제일을 정해야 회차별로 볼 수 있어요.</span>
            <span className="ml-auto">
              <GoOrAsk route="master_card" action="edit" go={goRoute} ask="결제일은 기준정보(카드) 권한이 있는 담당자에게 요청해 주세요.">
                결제일 정하기 <Icon.Right size={12}/>
              </GoOrAsk>
            </span>
          </div>
        ) : (
          <div className="col gap-6">
            {/* 회차 칩 — 오래된 것 → 이번 회차. 최근 3회 + 밀린 회차(서버가 고른다) */}
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {cycles.map(c => <CycleChip key={c.payDate} c={c} active={c.payDate === pick} onClick={() => setPick(c.payDate)}/>)}
            </div>
            <div className="text-xs text-muted2">
              갚은 돈은 오래된 회차부터 채워져요
              {bill.before_remain > 0 && <span style={{ color: 'var(--neg-ink)' }}> · 이보다 앞선 회차에 밀린 돈 {fmtNum(bill.before_remain)}원</span>}
            </div>
          </div>
        )}
        {/* 2열 — 왼쪽 회차 요약·지급 입력, 오른쪽 목록. 좁으면 쌓인다(index.css .card-bill-grid) */}
        <div className="card-bill-grid">
          <div className="col gap-20" style={{ minWidth: 0 }}>
            {cycleHead}
            {payForm}
          </div>
          {lists}
        </div>
      </div>
      {bill.unpaid > 0
        ? <DrawerFooter onCancel={onClose} cancelLabel="닫기" onSave={save} saveLabel="지급" busy={busy}/>
        : <DrawerFooter onCancel={onClose} cancelLabel="닫기"/>}
    </Drawer>
  )
}
