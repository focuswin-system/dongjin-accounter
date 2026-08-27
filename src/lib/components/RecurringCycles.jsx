import { useState, useEffect, useCallback } from 'react'
import { Icon, fmtNum, useToast, useConfirm, localToday, Drawer, MoneyInput , fmtDateShort } from '../ui'
import { DrawerHead, DrawerFooter } from './Drawer'
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
      ? '예정일이 지났는데 청구서가 없어요. 이미 받은 돈이면 입금 처리하세요.'
      : '예정일이 지났는데 청구서가 없어요. 이미 낸 돈이면 지급 처리하세요.',
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
  /* 발행은 했는데 **입금이 안 된** 회차.
   *
   * 회차 목록은 원래 '청구서가 아직 없는 것'만 담는다. 청구서가 생기면 목록에서 사라진다.
   * 그래서 소급으로 청구서만 만들고 입금 처리를 안 하면 여기서 다시 볼 수 없었고,
   * 그 돈을 받으려면 수시입금으로 가서 달을 1월·2월… 로 바꿔가며 찾아야 했다.
   * 소급을 많이 쓰는 회사에서 1~9월에 흩어진 17건이 그렇게 방치돼 있었다.
   *
   * ⚠ 다른 구획과 달리 이건 **이미 있는 청구서**다. '발행'이 아니라 '입금 붙이기'만 한다. */
  unpaid: {
    label: '발행함 · 미입금', tone: 'warn', icon: <Icon.Warn size={13}/>,
    primary: 'paid',
    hint: (sales) => sales
      ? '청구서는 발행됐는데 입금 처리가 안 됐어요. 이미 받은 돈이면 여기서 처리하세요.'
      : '청구서는 등록됐는데 지급 처리가 안 됐어요. 이미 낸 돈이면 여기서 처리하세요.',
  },
  /* 발행일이 아직 안 온 청구서 — **미리 끊어 둔 것**.
   *
   * 미래 날짜로 미리 발행하는 일이 실제로 있다(9/1 자를 8월에 끊어 둔다). 그런데 그 청구서는
   * 어디에서도 안 보였다 — 수시입금 목록은 기본이 이번 달이라 9월 건이 안 뜨고,
   * 회차 목록은 청구서가 생기면 사라진다. 그래서 "9월 것 어디 갔지" 하고 찾다가
   * **8월 것을 그것인 줄 알고 지운 사고**가 났다(입금까지 끝난 건이었다).
   * 안 보이는 것을 만들지 않는다 — 보이게 두고 '아직 발행일 전'이라고 적는다. */
  ahead: {
    label: '앞서 발행함', tone: 'brand', icon: <Icon.Clock size={13}/>,
    primary: null,
    hint: (sales) => sales
      ? '발행일이 아직 오지 않은 청구서예요. 미리 끊어 둔 것이니 그대로 두면 됩니다.'
      : '등록일이 아직 오지 않은 청구서예요. 미리 잡아 둔 것이니 그대로 두면 됩니다.',
  },
  /* 건너뛴 회차 — 감추기만 하면 되돌릴 방법이 없어진다. 접어서 맨 아래에 둔다
     ("왜 이 달만 없지"를 여기서 확인하고 되살릴 수 있어야 한다). */
  skipped: {
    label: '건너뜀', tone: 'outline', icon: <Icon.Close size={13}/>,
    primary: null,
    hint: () => '청구하지 않기로 한 회차예요. 되살리면 다시 목록에 나타나요.',
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

const Row = ({ c, sales, primary, onIssue, onPaid, onOpenContract, onSkip, onUnskip, onOpenInvoice, skipped, unpaid, ahead, busy, blockedBy }) => {
  const issueLabel = sales ? '청구서 발행' : '청구서 등록'
  const paidLabel = sales ? '입금 처리' : '지급 처리'
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
      <td className="num text-sm" style={{ whiteSpace: 'nowrap' }} title={c.due_date}>
        {/* 노트북 폭에서 이 칸이 두 줄로 접혔다 — 연도 두 자리를 줄인다(원값은 title) */}
        {fmtDateShort(c.due_date)}
        <span className={`badge ${ddayTone(c.due_date)}`} style={{ marginLeft: 6, fontSize: 10 }}>{dday(c.due_date)}</span>
      </td>
      {/* 긴 거래처명이 두세 줄로 접히던 자리 — 한 줄로 자르고 hover 로 온전히 보여준다 */}
      <td className="fw-700" style={{ maxWidth: 200 }}>
        <span className="clip" title={c.vendor_name || ''}>{c.vendor_name || '(거래처 미지정)'}</span>
      </td>
      <td className="text-sm text-muted">
        {c.item || c.contract_name || '—'}
        {/* 주문 기반이면 금액·종료 시점의 출처가 주문이다 → 그쪽으로 보낸다.
            이동 수단이 없는 자리(기준정보 탭 안)에서는 눌러도 아무 일이 없으니 버튼으로 만들지 않는다 */}
        {c.contract_id && (onOpenContract
          ? <button className="badge brand" style={{ marginLeft: 6, fontSize: 10, cursor: 'pointer', border: 0 }}
              title="주문 상세로 이동" onClick={() => onOpenContract(c)}><Icon.Link size={10}/> 주문</button>
          : <span className="badge brand" style={{ marginLeft: 6, fontSize: 10 }} title="주문에서 관리하는 항목입니다">주문</span>
        )}
      </td>
      <td className="num-cell num-right fw-700">{fmtNum(cycleTotal(c))}</td>
      <td>
        <div className="row gap-6" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
          {/* 발행함·미입금 — 이미 청구서가 있다. 새로 발행하면 중복이므로 그 버튼을 안 준다.
              '앞선 회차부터' 규칙도 여기엔 안 건다(발행이 아니라 정산이라 순서가 상관없다). */}
          {/* 앞서 발행함 — 아직 할 일이 없다. 무엇인지 확인만 할 수 있게 둔다.
              여기에 '입금 처리'를 주면 받지도 않은 돈을 받았다고 적게 된다. */}
          {ahead ? (
            <>
              <span className="badge outline" style={{ fontSize: 10 }}>{c.invoice_no}</span>
              {onOpenInvoice && (
                <button className="btn sm" disabled={busy} onClick={() => onOpenInvoice(c)}>청구서 열기</button>
              )}
            </>
          ) : unpaid ? (
            <>
              <span className="badge outline" style={{ fontSize: 10 }}>{c.invoice_no}</span>
              <button className="btn sm primary" disabled={busy} onClick={() => onPaid(c)}>
                {sales ? '입금 처리' : '지급 처리'}
              </button>
              {onOpenInvoice && (
                <button className="btn sm" disabled={busy} onClick={() => onOpenInvoice(c)}>청구서 열기</button>
              )}
            </>
          ) : skipped ? (
            <>
              {c.skip_reason && <span className="text-xs text-muted2">{c.skip_reason}</span>}
              <button className="btn sm" disabled={busy} onClick={() => onUnskip(c)}>되살리기</button>
            </>
          ) : (
            <>
              {blockedBy && <span className="text-xs text-muted2">앞선 회차부터</span>}
              {primary === 'paid' ? <>{btn('paid')}{btn('issue')}</> : <>{btn('issue')}{btn('paid')}</>}
              {/* 회차는 저장된 행이 아니라 계산값이라 '삭제'가 없다. 예전엔 잘못 잡힌 회차를 없애려면
                  발행한 뒤 그 청구서를 지워야 했다(청구번호만 헛되이 소모). 여기서 바로 건너뛴다. */}
              {onSkip && (
                <button className="btn sm" disabled={busy} title="이 회차는 청구하지 않아요"
                  onClick={() => onSkip(c)}>건너뛰기</button>
              )}
            </>
          )}
        </div>
      </td>
    </tr>
  )
}

const Section = ({ state, cycles, sales, onIssue, onPaid, onOpenContract, onBulk, onSkip, onUnskip, onOpenInvoice, busy, collapsible, earliest }) => {
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
                    skipped={state === 'skipped'} unpaid={state === 'unpaid'} ahead={state === 'ahead'}
                    onSkip={onSkip} onUnskip={onUnskip} onOpenInvoice={onOpenInvoice}
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
 * @param onOpenContract  주문 배지 클릭
 */
export const RecurringCycles = ({ cycles = [], kind = 'purchase', onIssue, onPaid, onBulk, onOpenContract, onSkip, onUnskip, onOpenInvoice, busy }) => {
  const sales = kind === 'sales'
  const by = (s) => cycles.filter(c => c.state === s)
  const overdue = by('overdue'), soon = by('soon'), upcoming = by('upcoming'), skipped = by('skipped'), unpaid = by('unpaid'), ahead = by('ahead')
  /* 규칙별 '가장 이른 미처리 회차' — 서버가 개별 처리를 허용하는 유일한 회차다.
     구획을 나눠 보여주므로 전체 cycles에서 구해야 한다(놓친 회차가 있으면 임박 회차도 아직 못 누른다).
     ⚠ 건너뛴 회차는 빼야 한다 — 넣으면 "앞선 회차(건너뛴 날)부터 처리하세요"가 떠서
       정작 처리해야 할 회차가 영영 안 눌린다(건너뛴 건 처리할 대상이 아니다). */
  const earliest = new Map()
  for (const c of cycles) {
    if (c.state === 'skipped' || c.state === 'unpaid' || c.state === 'ahead') continue
    const cur = earliest.get(c.recurring_id)
    if (!cur || c.due_date < cur) earliest.set(c.recurring_id, c.due_date)
  }
  if (!cycles.length) return null   // 처리할 회차가 없으면 이 영역 자체를 그리지 않는다
  return (
    <div style={{ marginBottom: 20 }}>
      {overdue.length > 0 && (
        <Section state="overdue" cycles={overdue} sales={sales} earliest={earliest}
          onIssue={onIssue} onPaid={onPaid} onBulk={onBulk} onOpenContract={onOpenContract}
          onSkip={onSkip} busy={busy}/>
      )}
      {/* 놓친 회차 바로 다음 — 둘 다 "이미 지난 일인데 안 끝난 것"이라 급한 순서가 같다. */}
      {unpaid.length > 0 && (
        <Section state="unpaid" cycles={unpaid} sales={sales} earliest={earliest}
          onPaid={onPaid} onOpenContract={onOpenContract} onOpenInvoice={onOpenInvoice} busy={busy}/>
      )}
      {soon.length > 0 && (
        <Section state="soon" cycles={soon} sales={sales} earliest={earliest}
          onIssue={onIssue} onPaid={onPaid} onOpenContract={onOpenContract} onSkip={onSkip} busy={busy}/>
      )}
      {/* '예정'(아직 발행 안 함) 바로 앞 — 둘 다 앞으로의 일인데, 이건 이미 끊어 둔 것이다.
          접어 두지 않는다. 접으면 또 안 보이고, 안 보여서 난 사고가 이것이다. */}
      {ahead.length > 0 && (
        <Section state="ahead" cycles={ahead} sales={sales} earliest={earliest}
          onOpenContract={onOpenContract} onOpenInvoice={onOpenInvoice} busy={busy}/>
      )}
      {upcoming.length > 0 && (
        <Section state="upcoming" cycles={upcoming} sales={sales} earliest={earliest} collapsible
          onIssue={onIssue} onPaid={onPaid} onOpenContract={onOpenContract} onSkip={onSkip} busy={busy}/>
      )}
      {skipped.length > 0 && (
        <Section state="skipped" cycles={skipped} sales={sales} earliest={earliest} collapsible
          onOpenContract={onOpenContract} onUnskip={onUnskip} busy={busy}/>
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
    ? { pending: api.getPendingRecurring, issue: api.issueRecurring, missed: api.issueMissedRecurringInvoices,
        skip: (id, due) => api.skipRecurringCycle('sales', id, due),
        unskip: (id, due) => api.unskipRecurringCycle('sales', id, due) }
    : { pending: api.getPendingRecurringExpenses, issue: api.issueRecurringExpense, missed: api.issueMissedRecurringExpenses,
        skip: (id, due) => api.skipRecurringCycle('purchase', id, due),
        unskip: (id, due) => api.unskipRecurringCycle('purchase', id, due) }

  const reload = useCallback(async () => {
    setCycles(await A.pending.call(api))
  }, [kind])
  useEffect(() => { reload() }, [reload])

  const after = async () => { await reload(); await onChanged?.() }

  // 회차 1건 → 청구서(미수/미지급). 계좌는 건드리지 않는다.
  /* 변동형이면 **금액을 먼저 묻는다.**
   * 규칙의 금액은 예상액일 뿐이라 그대로 발행하면 틀린 금액의 세금계산서가 나간다.
   * 기본값은 그 회차에 실린 예상액 — 실제와 같은 달이 많아 그대로 확인만 하면 된다.
   * 서버도 같은 규칙을 갖고 있다(금액 없이 오면 400) — 화면만 믿지 않는다. */
  const [amountAsk, setAmountAsk] = useState(null)   // { cycle, value }

  const doIssue = async (c, amount) => {
    setBusy(true)
    const extra = amount == null ? {}
      : (sales ? { supply_amount: amount } : { amount })
    const res = await A.issue.call(api, c.recurring_id, { due: c.due_date, ...extra })
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '처리에 실패했어요', { tone: 'warn' })
    toast.push(sales ? '청구서를 발행했어요' : '매입 청구서를 등록했어요')
    after()
  }

  const issue = async (c) => {
    if (c.amount_mode === 'variable') {
      /* 기본값(예상액)도 위와 같은 뜻으로 채운다 — 매출은 공급가액, 매입은 VAT 포함 합계.
         pending 은 둘 다 amount=공급가·vat=세액으로 주므로 매입만 합쳐야 한다. */
      const preset = sales ? (c.amount ?? '') : ((c.amount || 0) + (c.vat || 0))
      setAmountAsk({ cycle: c, value: String(preset || '') })
      return
    }
    await doIssue(c, null)
  }

  // 기입금/기지급은 계좌·날짜를 받아야 하므로 드로어를 띄운다(PaidIssueDrawer 공용)
  const openPaid = (c) => setPaidTarget(c)
  /* 드로어가 넘긴 _amount(변동형에서만 채워진다)를 서버로 실어 보낸다.
     빼먹으면 변동형 회차는 기입금/기지급이 서버 400 으로 막힌다 — 실제로 그랬다.
     매출은 supply_amount, 매입은 amount 로 이름이 갈린다(각 라우트의 바디 이름). */
  const issuePaid = (t) => {
    /* ⚠ 두 갈래다.
     *   회차(미발행)  → 청구서를 **새로 만들면서** 입금까지 처리한다.
     *   발행함·미입금 → 청구서가 **이미 있다.** 여기서 또 발행하면 같은 달 청구서가 둘이 된다.
     *                   있는 청구서에 입금을 붙인다(matchInvoice — 수시입금 화면과 같은 경로).
     * 한 버튼(입금 처리)이 두 가지 일을 하는 셈이라, 갈림길을 여기 한 곳에 둔다. */
    if (t.state === 'unpaid' && t.invoice_id) {
      return api.matchInvoice(t.invoice_id, {
        txnId: null,                      // 붙일 거래가 없으니 새로 만든다(서버가 만든다)
        amount: t._amount != null ? t._amount : (t.total_amount ?? cycleTotal(t)),
        date: t._date || t.due_date,
        account_id: t._accountId,         // ⚠ 스네이크다(api.matchInvoice 시그니처)
        memo: `${t.contract_name || t.item || '정기'} ${t.invoice_no || ''} 정산`.trim(),
      })
    }
    return A.issue.call(api, t.recurring_id, {
      due: t.due_date, paid: true, account_id: t._accountId,
      ...(t._amount != null ? (sales ? { supply_amount: t._amount } : { amount: t._amount }) : {}),
    })
  }

  /* 놓친 회차 일괄 — 무엇이 만들어지는지 전부 보여주고 확인받는다(되돌리는 비용이 큰 동작).
   * 대상은 화면의 'overdue' 구획이 아니라 **서버가 실제로 처리하는 범위**(오늘까지 도래한 회차)다.
   * 오늘 회차는 화면에서 '오늘·임박'으로 분류되는데 서버는 그것까지 만들기 때문에,
   * overdue만 세어 보여주면 "1건 발행"이라 확인받고 2건이 생겼다. */
  const bulk = async () => {
    const today = localToday()
    // 건너뛴 회차는 서버가 만들지 않는다 → 확인창 건수·목록에서도 빼야 "N건" 이 맞는다
    const overdue = cycles.filter(c => c.state !== 'skipped' && c.due_date <= today)
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
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

  /* 회차 건너뛰기 — "이 달은 청구 안 함".
     회차는 저장된 행이 아니라 계산값이라 지울 대상이 없어서, 예전엔 발행한 뒤 그 청구서를
     삭제하는 수밖에 없었다(청구번호만 헛되이 소모되고, 마감·정산에 걸리면 그마저 막힌다). */
  const skip = async (c) => {
    const ok = await confirm({
      title: `${c.due_date} 회차를 건너뛸까요?`,
      body: `${c.vendor_name || ''} · ${fmtNum(cycleTotal(c))}원 — 이 회차는 ${sales ? '청구하지' : '지출로 잡지'} 않아요. 정기 규칙은 그대로 돌아가고, 나중에 되살릴 수 있어요.`,
      confirmLabel: '건너뛰기',
    })
    if (!ok) return
    setBusy(true)
    const res = await A.skip.call(api, c.recurring_id, c.due_date)
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '건너뛰기에 실패했어요', { tone: 'warn' })
    toast.push(`${c.due_date} 회차를 건너뛰었어요`)
    after()
  }

  const unskip = async (c) => {
    setBusy(true)
    const res = await A.unskip.call(api, c.recurring_id, c.due_date)
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '되살리기에 실패했어요', { tone: 'warn' })
    toast.push(`${c.due_date} 회차를 되살렸어요`)
    after()
  }

  const closePaid = () => setPaidTarget(null)
  const donePaid = () => { setPaidTarget(null); after() }

  const overdueCount = cycles.filter(c => c.state === 'overdue').length
  return { cycles, busy, reload, issue, openPaid, issuePaid, bulk, skip, unskip, paidTarget, closePaid, donePaid, overdueCount, sales,
    // 변동형 금액 묻기 — 화면은 <CycleAmountDrawer {...cyc.amountProps}/> 한 줄만 그리면 된다
    amountProps: {
      ask: amountAsk, sales,
      onChange: (v) => setAmountAsk(a => (a ? { ...a, value: v } : a)),
      onClose: () => setAmountAsk(null),
      onConfirm: async () => {
        const amt = Math.round(Number(String(amountAsk.value).replace(/[^0-9-]/g, '')) || 0)
        if (amt <= 0) return toast.push('금액을 입력해주세요', { tone: 'warn' })
        setAmountAsk(null)
        await doIssue(amountAsk.cycle, amt)
      },
      busy,
    } }
}

/**
 * 변동형 회차의 금액 입력 — 전기·수도·통신처럼 **날짜는 같고 금액만 다른** 건에 쓴다.
 *
 * 사용량을 계산하지 않는다. 고지서를 보고 그 금액을 넣는 것뿐이다 —
 * 단가·사용량·검침일까지 들면 그건 청구 시스템이 아니라 과금 시스템이다.
 * 기본값은 규칙의 예상액이라, 같은 달이면 확인만 하고 넘어가면 된다.
 */
export const CycleAmountDrawer = ({ ask, sales, onChange, onClose, onConfirm, busy }) => (
  <Drawer open={!!ask} onClose={onClose} width="min(420px,100vw)" label="회차 금액 입력">
    <DrawerHead title={sales ? '이번 회차 청구 금액' : '이번 회차 금액'}
      sub={ask ? `${ask.cycle.vendor_name || ''} · ${ask.cycle.due_date}` : ''} onClose={onClose}/>
    {ask && (
      <div className="drawer-body col gap-form">
        {/* ⚠ 매출과 매입이 **받는 금액의 뜻이 다르다.**
              매출(정기입금) 발행은 `supply_amount`(공급가액)를 받아 서버가 부가세를 붙이고,
              매입(정기지급) 등록은 `amount`(VAT 포함 합계)를 받아 서버가 세액을 빼낸다
              (routes/recurring.js expenseVat = recurFromTotal).
              라벨을 한쪽으로 통일하면 반대쪽이 **10% 어긋난 금액**으로 기록된다. */}
        <div>
          <label className="label">
            {sales ? '공급가액' : '금액'} <span style={{ color: 'var(--neg-ink)' }}>*</span>
            {!sales && <span className="text-muted2 fw-600" style={{ fontSize: 11 }}> · VAT 포함 합계</span>}
          </label>
          <MoneyInput value={ask.value} onChange={onChange}/>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
            {sales
              ? '부가세는 규칙의 설정대로 자동으로 붙어요. 고지서 금액이 부가세 포함이면 공급가액으로 나눠 넣으세요.'
              : '고지서에 찍힌 금액을 그대로 넣으세요. 부가세는 규칙 설정에 따라 서버가 나눕니다.'}
          </div>
        </div>
        <div className="text-xs text-muted2" style={{ lineHeight: 1.7 }}>
          · 금액이 매번 다른 규칙이라 회차마다 물어봅니다.<br/>
          · 규칙에 적힌 금액은 <b>예상액</b>이에요 — 여기서 넣은 값이 실제로 기록됩니다.
        </div>
      </div>
    )}
    <DrawerFooter onCancel={onClose} onSave={onConfirm} saveLabel={sales ? '발행' : '등록'} busy={busy}/>
  </Drawer>
)

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
      계좌 잔액은 움직이지 않아요 — 실제 {sales ? '입금' : '지급'}은 회차별 {sales ? '입금' : '지급'} 처리에서 하세요.
    </div>
  </div>
)
