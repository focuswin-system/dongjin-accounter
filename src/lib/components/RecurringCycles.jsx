import { useState, useEffect, useCallback } from 'react'
import { Icon, fmtNum, useToast, useConfirm, localToday } from '../ui'
import { api } from '../api'

/* ── 정기 회차 이행 현황 (정기청구·정기지출 공용) ──────────────────
 *
 * 정기 화면은 여태 '규칙'만 보여줬다. 그래서 "이번 회차 처리했나 / 지난 회차 놓쳤나"가
 * 어디에도 안 보이고, 매입 청구서 화면을 직접 열지 않으면 그 달 지출이 조용히 누락됐다.
 * 이 컴포넌트가 그 이행 상태를 규칙 화면 안으로 가져온다.
 *
 * 구획은 긴급도 순이다(유형이 아니라) — 경리가 이 화면을 여는 이유는 "뭘 놓쳤나"이므로.
 *   놓친 회차   예정일이 지났는데 청구서가 없다. 이미 돈이 오갔을 수 있어 가장 급하다.
 *   오늘·임박   7일 안. 아직 안 나갔을 수 있다.
 *   예정        그 뒤(미리보기). 기본으로 접어둔다 — 당장 할 일이 아니다.
 * 상태(state)는 서버 pending이 실어 보낸다(lib/recurrence.js cycleState) — 화면에서 다시
 * 계산하면 서버 규칙과 어긋난다.
 *
 * 비어 있는 구획은 그리지 않는다. "놓친 회차 없음" 빈 카드를 매번 보여주면 진짜 경고가 묻힌다.
 */

const SECTION = {
  overdue: {
    label: '놓친 회차', tone: 'neg', icon: <Icon.Warn size={13}/>,
    // 놓친 회차는 이미 돈이 오갔을 가능성이 높다 → 기정산 처리를 primary로
    primary: 'paid',
    hint: (sales) => sales
      ? '예정일이 지났는데 청구서가 없어요. 이미 입금됐다면 기입금 처리하세요.'
      : '예정일이 지났는데 청구서가 없어요. 이미 결제됐다면 기지급 처리하세요.',
  },
  soon: {
    label: '오늘·임박', tone: 'warn', icon: <Icon.Clock size={13}/>,
    primary: 'issue',   // 아직 돈이 오가지 않았을 수 있다 → 청구서 등록을 primary로
    hint: () => '7일 안에 도래하는 회차예요.',
  },
  upcoming: {
    label: '예정', tone: 'outline', icon: null,
    primary: 'issue',
    hint: () => '미리 발행해 둘 수 있어요.',
  },
}

// 로컬 자정끼리 비교한다. toDateString() 파싱이나 toISOString(UTC)을 쓰면 KST 새벽에 하루가 밀린다
// (ui.jsx localToday의 주석과 같은 이유).
const dayDiff = (due) => Math.round(
  (new Date(`${due}T00:00:00`) - new Date(`${localToday()}T00:00:00`)) / 86400000)

const dday = (due) => {
  const d = dayDiff(due)
  if (d === 0) return '오늘'
  return d < 0 ? `+${Math.abs(d)}일 지남` : `D-${d}`
}
const ddayTone = (due) => {
  const d = dayDiff(due)
  if (d < 0) return 'neg'
  if (d <= 3) return 'warn'
  return 'outline'
}

/** 회차 금액(VAT 포함) — pending은 공급가(amount)와 세액(vat)을 따로 준다 */
export const cycleTotal = (c) => (c.amount || 0) + (c.vat != null ? c.vat : Math.round((c.amount || 0) * 0.1))

const Row = ({ c, sales, primary, onIssue, onPaid, onOpenContract, busy, blockedBy }) => {
  const issueLabel = sales ? '청구서 발행' : '청구서 등록'
  const paidLabel = sales ? '기입금 처리' : '기지급 처리'
  // 서버는 그 규칙의 '가장 이른 미처리 회차'만 허용한다(앞선 회차를 건너뛰면 그 앞이 영영 안 뜬다).
  // 그 규칙을 화면에서 미리 보여주지 않으면, 눌러본 뒤 409 에러로만 알게 된다.
  const btn = (kind) => (
    <button
      className={`btn sm ${!blockedBy && primary === kind ? 'primary' : ''}`}
      disabled={busy || !!blockedBy}
      title={blockedBy ? `앞선 회차(${blockedBy})부터 처리해야 해요` : undefined}
      onClick={() => (kind === 'issue' ? onIssue(c) : onPaid(c))}>
      {kind === 'issue' ? issueLabel : paidLabel}
    </button>
  )
  return (
    <tr>
      <td className="num text-sm" style={{ whiteSpace: 'nowrap' }}>
        {c.due_date}
        <span className={`badge ${ddayTone(c.due_date)}`} style={{ marginLeft: 6, fontSize: 10 }}>{dday(c.due_date)}</span>
      </td>
      <td className="fw-700">{c.vendor_name || '(거래처 미지정)'}</td>
      <td className="text-sm text-muted">
        {c.item || c.contract_name || '—'}
        {/* 계약 기반이면 금액·종료 시점의 출처가 계약이다 → 그쪽으로 보낸다.
            이동 수단이 없는 자리(기준정보 탭 안)에서는 눌러도 아무 일이 없으니 버튼으로 만들지 않는다 */}
        {c.contract_id && (onOpenContract
          ? <button className="badge brand" style={{ marginLeft: 6, fontSize: 10, cursor: 'pointer', border: 0 }}
              title="계약 상세로 이동" onClick={() => onOpenContract(c)}><Icon.Link size={10}/> 계약</button>
          : <span className="badge brand" style={{ marginLeft: 6, fontSize: 10 }} title="계약에서 관리하는 항목입니다">계약</span>
        )}
      </td>
      <td className="num-cell num-right fw-700">{fmtNum(cycleTotal(c))}</td>
      <td>
        <div className="row gap-6" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
          {blockedBy && <span className="text-xs text-muted2">앞선 회차부터</span>}
          {primary === 'paid' ? <>{btn('paid')}{btn('issue')}</> : <>{btn('issue')}{btn('paid')}</>}
        </div>
      </td>
    </tr>
  )
}

const Section = ({ state, cycles, sales, onIssue, onPaid, onOpenContract, onBulk, busy, collapsible, earliest }) => {
  const [open, setOpen] = useState(!collapsible)
  const meta = SECTION[state]
  const sum = cycles.reduce((s, c) => s + cycleTotal(c), 0)
  return (
    <div className="card" style={{ overflow: 'hidden', marginBottom: 12 }}>
      <div className="row" style={{ padding: '12px 16px', gap: 10, flexWrap: 'wrap', alignItems: 'center',
        borderBottom: open ? '1px solid var(--line)' : 'none' }}>
        {collapsible ? (
          <button className="btn ghost sm" onClick={() => setOpen(o => !o)} style={{ padding: '2px 6px' }}>
            <Icon.Right size={12} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}/>
          </button>
        ) : null}
        <span className={`badge ${meta.tone}`} style={{ fontSize: 11 }}>{meta.icon} {meta.label}</span>
        <span className="fw-700 text-sm">{cycles.length}건</span>
        <span className="num text-sm text-muted">{fmtNum(sum)}원</span>
        {open && <span className="text-xs text-muted2" style={{ flex: 1 }}>{meta.hint(sales)}</span>}
        {/* 일괄은 '놓친 회차'에만 — 미래 회차를 한꺼번에 만들면 미수/미지급이 조기에 부푼다.
            단 서버는 '오늘까지 도래한 회차'를 처리하므로, 오늘 회차(soon 구획)도 대상이다.
            확인창에 그 회차까지 보여주지 않으면 "1건 발행" 하고 2건이 생긴다. */}
        {state === 'overdue' && onBulk && (
          <button className="btn sm ml-auto" disabled={busy} onClick={() => onBulk()}>
            <Icon.Receipt size={12}/> 놓친 회차 일괄 {sales ? '발행' : '등록'}
          </button>
        )}
      </div>
      {open && (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 170 }}>예정일</th>
                <th>거래처</th>
                <th>항목</th>
                <th className="num-right" style={{ width: 130 }}>금액(VAT 포함)</th>
                <th style={{ width: 230 }}></th>
              </tr>
            </thead>
            <tbody>
              {cycles.map(c => {
                const first = earliest?.get(c.recurring_id)
                return (
                  <Row key={`${c.recurring_id}-${c.due_date}`} c={c} sales={sales} primary={meta.primary}
                    blockedBy={first && first !== c.due_date ? first : null}
                    onIssue={onIssue} onPaid={onPaid} onOpenContract={onOpenContract} busy={busy}/>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * @param cycles          서버 pending 배열(state 포함)
 * @param kind            'sales'(정기청구) | 'purchase'(정기지출)
 * @param onIssue/onPaid  회차 1건 처리
 * @param onBulk          놓친 회차 일괄 처리
 * @param onOpenContract  계약 배지 클릭
 */
export const RecurringCycles = ({ cycles = [], kind = 'purchase', onIssue, onPaid, onBulk, onOpenContract, busy }) => {
  const sales = kind === 'sales'
  const by = (s) => cycles.filter(c => c.state === s)
  const overdue = by('overdue'), soon = by('soon'), upcoming = by('upcoming')
  // 규칙별 '가장 이른 미처리 회차' — 서버가 개별 처리를 허용하는 유일한 회차다.
  // 구획을 나눠 보여주므로 전체 cycles에서 구해야 한다(놓친 회차가 있으면 임박 회차도 아직 못 누른다).
  const earliest = new Map()
  for (const c of cycles) {
    const cur = earliest.get(c.recurring_id)
    if (!cur || c.due_date < cur) earliest.set(c.recurring_id, c.due_date)
  }
  if (!cycles.length) return null   // 처리할 회차가 없으면 이 영역 자체를 그리지 않는다
  return (
    <div style={{ marginBottom: 20 }}>
      {overdue.length > 0 && (
        <Section state="overdue" cycles={overdue} sales={sales} earliest={earliest}
          onIssue={onIssue} onPaid={onPaid} onBulk={onBulk} onOpenContract={onOpenContract} busy={busy}/>
      )}
      {soon.length > 0 && (
        <Section state="soon" cycles={soon} sales={sales} earliest={earliest}
          onIssue={onIssue} onPaid={onPaid} onOpenContract={onOpenContract} busy={busy}/>
      )}
      {upcoming.length > 0 && (
        <Section state="upcoming" cycles={upcoming} sales={sales} earliest={earliest} collapsible
          onIssue={onIssue} onPaid={onPaid} onOpenContract={onOpenContract} busy={busy}/>
      )}
    </div>
  )
}

/* ── 회차 처리 로직 (정기청구·정기지출 공용 훅) ───────────────────
 * 두 화면이 같은 흐름을 쓰도록 여기 한 곳에 둔다: 목록 로드 → 건별 등록 / 기정산 / 놓친 회차 일괄.
 * kind만 다르고 나머지는 완전히 같다 — 따로 두면 한쪽만 고쳐져서 동작이 갈린다.
 *
 * @param kind        'sales'(정기청구) | 'purchase'(정기지출)
 * @param onChanged   회차가 바뀐 뒤 규칙 목록도 새로 읽어야 할 때(다음 예정일이 변한다)
 */
export const useRecurringCycles = (kind, { onChanged } = {}) => {
  const sales = kind === 'sales'
  const toast = useToast()
  const { confirm } = useConfirm()
  const [cycles, setCycles] = useState([])
  const [busy, setBusy] = useState(false)
  const [paidTarget, setPaidTarget] = useState(null)

  const A = sales
    ? { pending: api.getPendingRecurring, issue: api.issueRecurring, missed: api.issueMissedRecurringInvoices }
    : { pending: api.getPendingRecurringExpenses, issue: api.issueRecurringExpense, missed: api.issueMissedRecurringExpenses }

  const reload = useCallback(async () => {
    setCycles(await A.pending.call(api))
  }, [kind])
  useEffect(() => { reload() }, [reload])

  const after = async () => { await reload(); await onChanged?.() }

  // 회차 1건 → 청구서(미수/미지급). 계좌는 건드리지 않는다.
  const issue = async (c) => {
    setBusy(true)
    const res = await A.issue.call(api, c.recurring_id, { due: c.due_date })
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '처리에 실패했어요', { tone: 'warn' })
    toast.push(sales ? '청구서를 발행했어요' : '매입 청구서를 등록했어요')
    after()
  }

  // 기입금/기지급은 계좌·날짜를 받아야 하므로 드로어를 띄운다(PaidIssueDrawer 공용)
  const openPaid = (c) => setPaidTarget(c)
  const issuePaid = (t) => A.issue.call(api, t.recurring_id, { due: t.due_date, paid: true, account_id: t._accountId })

  /* 놓친 회차 일괄 — 무엇이 만들어지는지 전부 보여주고 확인받는다(되돌리는 비용이 큰 동작).
   * 대상은 화면의 'overdue' 구획이 아니라 **서버가 실제로 처리하는 범위**(오늘까지 도래한 회차)다.
   * 오늘 회차는 화면에서 '오늘·임박'으로 분류되는데 서버는 그것까지 만들기 때문에,
   * overdue만 세어 보여주면 "1건 발행"이라 확인받고 2건이 생겼다. */
  const bulk = async () => {
    const today = localToday()
    const overdue = cycles.filter(c => c.due_date <= today).sort((a, b) => a.due_date.localeCompare(b.due_date))
    if (!overdue.length) return toast.push('처리할 회차가 없어요')
    const ok = await confirm({
      tone: 'brand', icon: <Icon.Receipt size={22}/>,
      title: `놓친 회차 ${overdue.length}건 일괄 ${sales ? '발행' : '등록'}`,
      body: `예정일이 지났는데 청구서가 없는 회차를 ${sales ? '미수금' : '미지급금'}으로 만들어요.`,
      detail: bulkDetail(overdue, sales),
      confirmLabel: `${overdue.length}건 ${sales ? '발행' : '등록'}`,
    })
    if (!ok) return
    setBusy(true)
    const res = await A.missed.call(api)
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '일괄 처리에 실패했어요', { tone: 'warn' })
    toast.push(res.count > 0
      ? `${res.count}건을 ${sales ? '입금 예정' : '지급 대기'}으로 등록했어요`
      : '등록할 회차가 없어요')
    after()
  }

  const closePaid = () => setPaidTarget(null)
  const donePaid = () => { setPaidTarget(null); after() }

  const overdueCount = cycles.filter(c => c.state === 'overdue').length
  return { cycles, busy, reload, issue, openPaid, issuePaid, bulk, paidTarget, closePaid, donePaid, overdueCount, sales }
}

/** 규칙 id → 그 규칙의 다음 예정일·미처리 건수 (규칙 목록 컬럼용) */
export const cycleSummaryByRule = (cycles) => {
  const map = new Map()
  for (const c of cycles) {
    const cur = map.get(c.recurring_id) || { next: null, overdue: 0 }
    if (!cur.next || c.due_date < cur.next) cur.next = c.due_date
    if (c.state === 'overdue') cur.overdue++
    map.set(c.recurring_id, cur)
  }
  return map
}

/** 일괄 처리 확인 대화상자에 넣을 목록 — 무엇이 만들어지는지 줄 단위로 보여준다. */
export const bulkDetail = (cycles, sales) => (
  <div className="col gap-4" style={{ maxHeight: 200, overflowY: 'auto' }}>
    {cycles.map(c => (
      <div key={`${c.recurring_id}-${c.due_date}`} className="row gap-8" style={{ fontSize: 12.5 }}>
        <span className="num text-muted2" style={{ width: 82 }}>{c.due_date}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {c.vendor_name || '(거래처 미지정)'} · {c.item || c.contract_name || ''}
        </span>
        <span className="num fw-600">{fmtNum(cycleTotal(c))}</span>
      </div>
    ))}
    <div className="row gap-8" style={{ fontSize: 12.5, borderTop: '1px solid var(--line)', paddingTop: 4, marginTop: 2 }}>
      <span style={{ flex: 1 }} className="fw-700">합계 {cycles.length}건</span>
      <span className="num fw-700">{fmtNum(cycles.reduce((s, c) => s + cycleTotal(c), 0))}</span>
    </div>
    <div className="text-xs text-muted2" style={{ marginTop: 4 }}>
      {cycles[0]?.due_date} 회차부터 순서대로 처리돼요. {sales ? '입금 예정(미수금)' : '지급 대기(미지급금)'}으로 등록되고,
      계좌 잔액은 움직이지 않아요 — 실제 {sales ? '입금' : '지급'}은 회차별 {sales ? '기입금' : '기지급'} 처리에서 하세요.
    </div>
  </div>
)
