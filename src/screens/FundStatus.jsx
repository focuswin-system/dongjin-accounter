import { useState, useEffect } from 'react'
import { Icon, fmtNum, Loading } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { api } from '../lib/api'

/* 자금 현황 — "이 기간에 돈이 얼마 들어오고 나가서, 얼마 남나".
 *
 * 자금일보와 같은 데이터를 쓰지만 축이 다르다. 자금일보는 오늘부터 N일 롤링(매일 아침),
 * 여기는 주·월·분기·년 구간(대표가 보는 축). 달이 특별한 게 아니라 단위 중 하나다.
 *
 * 엑셀은 시트 12장을 넘겨야 한 해가 보인다. 이 화면이 이길 수 있는 지점이 정확히 거기라서,
 * 위쪽에 구간을 한 줄씩 늘어놓아 **어느 구간에 구멍이 나는지**를 스크롤 없이 보여준다.
 */

const UNITS = [
  { id: 'week', label: '주' },
  { id: 'month', label: '월' },
  { id: 'quarter', label: '분기' },
  { id: 'year', label: '년' },
]

/* 지난 기간이라고 다 확정이 아니다 — 입력이 밀린 달도 지난 달이다.
   확정의 근거는 장부 마감이고, 지났지만 미마감이면 '잠정'이라 말해준다. */
const STATE = {
  closed:      { label: '확정',  hint: '장부가 마감된 기간이에요' },
  provisional: { label: '잠정',  hint: '지났지만 아직 마감 전이라 입력 중일 수 있어요' },
  current:     { label: '진행 중', hint: '오늘까지는 실적, 남은 날은 예정이에요' },
  planned:     { label: '예정',  hint: '아직 오지 않은 기간이에요' },
}

const Money = ({ v, tone }) => (
  <span className={`num ${tone || ''}`}>{v < 0 ? '−' : ''}{fmtNum(Math.abs(v))}</span>
)

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

/* 달력 — 일자 단위(주·월)에서만 뜻이 있다.
 *
 * 표는 정확하지만 "이 달 언제가 고비냐"를 **모양으로** 보여주지는 못한다. 급여일·카드
 * 결제일·부가세일이 달의 어디쯤 몰려 있는지는 달력이 훨씬 빨리 읽힌다. 경리·대표가
 * 원래 벽에 붙여 놓고 보던 것도 달력이다. 표와 달력은 같은 데이터를 다르게 볼 뿐이라
 * 어느 쪽을 보든 숫자는 같다.
 */
const CalendarView = ({ timeline, openBuckets, onToggle }) => {
  const byDate = new Map(timeline.buckets.map(b => [b.from, b]))
  const ws = Number(timeline.weekStart) || 0
  const first = new Date(`${timeline.range.from}T00:00:00`)
  const last = new Date(`${timeline.range.to}T00:00:00`)
  // 첫 주의 빈 칸 — 구간 시작 요일이 주 시작 요일과 다를 때 앞을 비운다
  const lead = (first.getDay() - ws + 7) % 7
  const cells = []
  for (let i = 0; i < lead; i++) cells.push(null)
  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    cells.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }
  while (cells.length % 7) cells.push(null)

  return (
    <div className="card-pad" style={{ paddingTop: 0 }}>
      <div className="fund-cal">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={`h${i}`} className="fund-cal-head">{WEEKDAYS[(ws + i) % 7]}</div>
        ))}
        {cells.map((date, i) => {
          if (!date) return <div key={`e${i}`} className="fund-cal-cell empty"/>
          const b = byDate.get(date)
          const today = date === timeline.today
          const opened = openBuckets.has(date)
          const neg = b && b.balance < 0
          /* 합계는 플러스인데 **특정 통장만** 비는 날이 있다(8/15: 합계 +806만, 급여통장 −1,200만).
             칸에 합계만 적으면 그 날이 흰 칸으로 지나간다 — 정작 그 날 이체가 안 나가는데. */
          const short = b?.shortAccounts || []
          return (
            <div key={date}
              className={`fund-cal-cell${b?.moved ? ' movable' : ''}${today ? ' today' : ''}${opened ? ' opened' : ''}${neg ? ' neg' : short.length ? ' short' : ''}`}
              onClick={() => b?.moved && onToggle(date)}>
              <div className="fund-cal-day">
                {Number(date.slice(8))}
                {today && <span className="fund-cal-today">오늘</span>}
              </div>
              {b && (b.in > 0 || b.out > 0) && (
                <div className="fund-cal-flow">
                  {b.in > 0 && <div className="num" style={{ color: 'var(--pos-ink)' }}>+{fmtNum(b.in)}</div>}
                  {b.out > 0 && <div className="num" style={{ color: 'var(--neg-ink)' }}>−{fmtNum(b.out)}</div>}
                </div>
              )}
              {/* 바닥난 통장 이름을 칸에 적는다 — "어느 통장이"까지 알아야 손을 쓸 수 있다 */}
              {short.length > 0 && (
                <div className="fund-cal-short">
                  {short.length === 1
                    ? <>{short[0].name} <span className="num">−{fmtNum(Math.abs(short[0].balance))}</span></>
                    : <>통장 {short.length}개 부족</>}
                </div>
              )}
              {/* 그 날 끝 잔액 — 달력에서 제일 중요한 숫자다. 음수면 칸 자체가 붉어진다. */}
              {b && (
                <div className="fund-cal-bal num" style={{ color: neg ? 'var(--neg-ink)' : undefined }}>
                  {b.balance < 0 ? '−' : ''}{fmtNum(Math.abs(b.balance))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {/* 펼친 날들 — 여러 날을 한 번에 열어 견줄 수 있다 */}
      {[...openBuckets].filter(k => byDate.has(k)).sort().map(k => {
        const b = byDate.get(k)
        return (
          <div key={k} className="card card-pad" style={{ marginTop: 10, background: 'var(--surface-2)' }}>
            <div className="row" style={{ marginBottom: 6, alignItems: 'baseline' }}>
              <b>{b.from}</b>
              <span className="text-sm text-muted" style={{ marginLeft: 8 }}>{b.past ? '실적' : '예정'}</span>
              <span className="num ml-auto fw-700" style={{ color: b.balance < 0 ? 'var(--neg-ink)' : undefined }}>
                잔액 {b.balance < 0 ? '−' : ''}{fmtNum(Math.abs(b.balance))}
              </span>
            </div>
            {[...b.items].sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'in' ? -1 : 1))
              .map((it, i) => <FlowLine key={i} it={it}/>)}
          </div>
        )
      })}
    </div>
  )
}

/* 예정·실적 한 건을 한 줄로.
 *
 * 예전엔 날짜·출처·이름·금액만 적었다. 그런데 자금표를 보다 멈추는 지점은 늘
 * **"이게 들어오는 돈이야 나가는 돈이야, 어느 통장으로, 누구한테서?"** 였다.
 * 색과 +/− 부호로만 갈라 놓으면 흑백으로 뽑거나 색약인 사람에게는 아무 구분이 없다.
 * 그래서 넷을 다 글자로 적는다: 입금/출금 · 출처 · 상대 · 통장.
 */
const FlowLine = ({ it, showAccount = true }) => {
  const inflow = it.kind === 'in'
  return (
    <div className="row text-sm" style={{ padding: '4px 0', gap: 8, flexWrap: 'wrap' }}>
      <span className="num text-muted" style={{ width: 92 }}>{it.date}</span>
      {/* 입금인지 출금인지를 맨 앞에 글자로 — 이 줄에서 제일 먼저 알아야 할 것이다 */}
      <span className="badge" style={{
        fontSize: 10, minWidth: 34, justifyContent: 'center',
        color: inflow ? 'var(--pos-ink)' : 'var(--neg-ink)',
      }}>{inflow ? '입금' : '출금'}</span>
      <span className="badge" style={{ fontSize: 10 }}>{it.source}</span>
      <span>{it.label}</span>
      {it.overdue && <span className="badge warn" style={{ fontSize: 10 }}>기한 지남</span>}
      {it.noDue && <span className="badge" style={{ fontSize: 10 }}>기한 미정</span>}
      {showAccount && (
        <span className="text-sm text-muted">
          {it.account_name
            ? <>{inflow ? '→' : '←'} {it.account_name}</>
            : '통장 미정'}
        </span>
      )}
      <span className="num ml-auto fw-600" style={{ color: inflow ? 'var(--pos-ink)' : 'var(--neg-ink)' }}>
        {inflow ? '+' : '−'}{fmtNum(it.amount)}
      </span>
    </div>
  )
}

export const FundStatusScreen = ({ go }) => {
  const [unit, setUnit] = useState('month')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState(null)
  const [series, setSeries] = useState(null)
  const [timeline, setTimeline] = useState(null)
  const [open, setOpen] = useState(null)      // 펼친 계좌 id
  /* 펼친 시점 — **여럿을 동시에** 열어 둘 수 있어야 한다.
     하나만 열리면 8/15 급여와 8/25 카드값을 비교하려 할 때마다 앞의 것이 닫혀
     번갈아 누르며 외워야 했다. 자금표는 원래 여러 날을 견주어 보는 문서다. */
  const [openBuckets, setOpenBuckets] = useState(() => new Set())
  const toggleBucket = (key) => setOpenBuckets(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })
  // 움직임 없는 칸까지 다 그리면 한 달이 31줄이 된다 — 기본은 돈이 오간 날만 본다
  const [allBuckets, setAllBuckets] = useState(false)
  // 달력으로 볼 것인가 — 일자 단위(주·월)에서만 뜻이 있다
  const [asCalendar, setAsCalendar] = useState(false)

  useEffect(() => {
    let alive = true
    setData(null)
    api.getFundStatus({ unit, offset }).then(d => { if (alive) setData(d) })
    return () => { alive = false }
  }, [unit, offset])

  // 구간을 옮기면 시간축과 옆 구간 요약도 그 구간 기준으로 다시 잡는다
  useEffect(() => {
    let alive = true
    setSeries(null); setTimeline(null); setOpenBuckets(new Set())
    api.getFundSeries({ unit, offset }).then(d => { if (alive) setSeries(d) })
    api.getFundTimeline({ unit, offset }).then(d => { if (alive) setTimeline(d) })
    return () => { alive = false }
  }, [unit, offset])

  const st = data ? (STATE[data.state] || STATE.current) : null

  const AccountTable = ({ group, title, unassigned }) => !group || !group.accounts.length ? null : (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row card-pad" style={{ alignItems: 'baseline', paddingBottom: 10 }}>
        <div className="fw-700">{title}</div>
        <div className="ml-auto text-sm">
          <span className="text-muted2">기간 말 예상</span>{' '}
          <b className="num" style={{ fontSize: 15, color: group.expected < 0 ? 'var(--neg-ink)' : undefined }}>
            {group.expected < 0 ? '−' : ''}{fmtNum(Math.abs(group.expected))}원
          </b>
          {/* 이 숫자는 **계좌에 붙은 예정만** 센다. 미지정분(급여·퇴직금 등)을 안 밝히면
              대표가 이 한 줄만 보고 그만큼 낙관적으로 판단한다. */}
          {unassigned && (unassigned.in > 0 || unassigned.out > 0) && (
            <span className="text-xs text-muted2" style={{ marginLeft: 8 }}>
              계좌 미지정 {unassigned.in - unassigned.out < 0 ? '−' : '+'}
              {fmtNum(Math.abs(unassigned.in - unassigned.out))} 별도
            </span>
          )}
        </div>
      </div>
      <div className="table-scroll" style={{ overflowX: 'auto' }}>
        <table className="table" style={{ minWidth: 820 }}>
          {/* '들어온 돈 / 들어올 돈'은 한 글자(온·올)만 달라서 옆에 놓으면 구분이 안 된다.
              시제를 열 이름에 욱여넣는 대신 **실적·예정을 머리에 묶어** 갈랐다. */}
          <thead>
            <tr>
              <th rowSpan={2}>계좌</th>
              <th className="num-right" rowSpan={2} style={{ width: 120 }}>현재 잔액</th>
              <th className="num-right" colSpan={2} style={{ borderLeft: '1px solid var(--line)' }}>실적</th>
              <th className="num-right" colSpan={2} style={{ borderLeft: '1px solid var(--line)' }}>예정</th>
              <th className="num-right" rowSpan={2} style={{ width: 130, borderLeft: '1px solid var(--line)' }}>예상 잔액</th>
            </tr>
            <tr>
              <th className="num-right" style={{ width: 120, borderLeft: '1px solid var(--line)' }}>입금</th>
              <th className="num-right" style={{ width: 120 }}>출금</th>
              <th className="num-right" style={{ width: 120, borderLeft: '1px solid var(--line)' }}>입금</th>
              <th className="num-right" style={{ width: 120 }}>출금</th>
            </tr>
          </thead>
          {/* 펼친 내역은 **그 계좌 바로 밑**에 붙어야 한다.
              예전엔 계좌를 다 그린 뒤 표 맨 아래에 붙여서, 주거래를 눌렀는데 하나은행 밑이
              열렸다 — 어느 계좌 것인지 눈으로 되짚어야 했다. */}
          {group.accounts.map(a => (
            <tbody key={a.id}>
              <tr style={{ cursor: a.items.length ? 'pointer' : 'default' }}
                onClick={() => a.items.length && setOpen(open === a.id ? null : a.id)}>
                <td>
                  <span className="fw-600">{a.name}</span>
                  {a.items.length > 0 && (
                    <span className="text-xs text-muted2" style={{ marginLeft: 6 }}>
                      예정 {a.items.length}건 {open === a.id ? '▲' : '▼'}
                    </span>
                  )}
                </td>
                <td className="num num-right"><Money v={a.balance} tone={a.balance < 0 ? 'neg-ink' : ''}/></td>
                <td className="num num-right text-muted">{a.actualIn ? fmtNum(a.actualIn) : ''}</td>
                <td className="num num-right text-muted">{a.actualOut ? fmtNum(a.actualOut) : ''}</td>
                <td className="num num-right">{a.planIn ? fmtNum(a.planIn) : ''}</td>
                <td className="num num-right">{a.planOut ? fmtNum(a.planOut) : ''}</td>
                <td className="num num-right fw-700" style={{ color: a.expected < 0 ? 'var(--neg-ink)' : undefined }}>
                  <Money v={a.expected}/>
                </td>
              </tr>
              {open === a.id && (
                <tr>
                  <td colSpan={7} style={{ background: 'var(--surface-2)', padding: '10px 14px' }}>
                    {/* 이미 '이 계좌' 안이라 통장 이름은 되풀이하지 않는다 */}
                    {a.items.map((it, i) => <FlowLine key={i} it={it} showAccount={false}/>)}
                  </td>
                </tr>
              )}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  )

  return (
    <div className="fade-up">
      <PageHeader title="자금 현황"
        sub="기간을 골라 들어온·나간 돈과 들어올·나갈 돈을 봅니다. 계좌를 누르면 항목과 날짜가 펼쳐져요."/>

      {/* 기간 단위 — 달이 특별한 게 아니라 단위 중 하나다 */}
      <div className="card card-pad no-print" style={{ marginBottom: 16 }}>
        <div className="row gap-12" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="row gap-6">
            {UNITS.map(u => (
              <button key={u.id} className={`chip ${unit === u.id ? 'active' : ''}`}
                onClick={() => { setUnit(u.id); setOffset(0); setOpen(null) }}>{u.label}</button>
            ))}
          </div>
          <div className="row gap-6" style={{ alignItems: 'center', marginLeft: 8 }}>
            <button className="btn sm" onClick={() => setOffset(o => o - 1)}>◀</button>
            <span className="fw-700" style={{ minWidth: 130, textAlign: 'center' }}>{data?.range.label || '…'}</span>
            <button className="btn sm" onClick={() => setOffset(o => o + 1)}>▶</button>
            {offset !== 0 && <button className="btn ghost sm" onClick={() => setOffset(0)}>지금으로</button>}
          </div>
          {data && (
            <span className="text-xs text-muted2 ml-auto">
              {data.range.from} ~ {data.range.to}
              {data.closingDay > 0 && <> · 매월 {data.closingDay}일 마감</>}
              <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => go?.('settings_company')}>
                기간 설정 <Icon.Right size={11}/>
              </button>
            </span>
          )}
        </div>
      </div>

      {/* ── 며칠에 어느 통장이 비나 ──────────────────────────────────────────
          이 화면의 결론이다. 구간 합계로는 안 나온다 — 월말에 흑자여도 25일 급여일에
          통장이 비면 그 날 이체가 안 나가고, 그건 돈이 없는 것과 같다.
          그래서 구간을 한 칸 잘게 쪼개(월→일자, 분기→주, 년→월) 계좌별 잔액을 따라간다. */}
      {timeline && (() => {
      const hasUnassigned = timeline.buckets.some(b => b.unassigned.in || b.unassigned.out)
      /* 통장을 전부 열로 세우면 실물에서 열이 19개가 된다(통장 16개인 회사가 있다).
         가로로 터진 표는 안 읽히므로 **이 구간에 돈이 오간 통장만** 세우고,
         나머지는 '그 외 N개'로 묶어 잔액만 낸다(합계는 그대로 맞는다). */
      const moved = timeline.accounts.filter(a =>
        timeline.buckets.some(b => b.byAccount[a.id].in || b.byAccount[a.id].out))
      const rest = timeline.accounts.filter(a => !moved.includes(a))
      const restBal = (b) => rest.reduce((s, a) => s + b.byAccount[a.id].balance, 0)
      const cols = moved.length + (rest.length ? 1 : 0) + (hasUnassigned ? 1 : 0) + 4
      const un = timeline.undated || { in: 0, out: 0 }
      return (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row card-pad" style={{ alignItems: 'baseline', paddingBottom: 8, flexWrap: 'wrap', gap: 8 }}>
            <div>
              <div className="fw-700">돈이 오가는 날</div>
              <div className="text-xs text-muted2">
                {timeline.bucketUnit === 'day' ? '일자별' : timeline.bucketUnit === 'week' ? '주별' : '월별'}로
                {' '}계좌 잔액이 어떻게 움직이는지 봅니다. 줄을 누르면 그 날 항목이 펼쳐져요.
              </div>
            </div>
            <div className="row gap-6 ml-auto">
              {/* 달력은 일자 단위에서만 뜻이 있다 — 분기(주별)·년(월별)을 달력에 그릴 수 없다 */}
              {timeline.bucketUnit === 'day' && (
                <div className="row gap-4">
                  <button className={`chip ${!asCalendar ? 'active' : ''}`} onClick={() => setAsCalendar(false)}>표</button>
                  <button className={`chip ${asCalendar ? 'active' : ''}`} onClick={() => setAsCalendar(true)}>달력</button>
                </div>
              )}
              {!asCalendar && (
                <button className="btn ghost sm" onClick={() => setAllBuckets(v => !v)}>
                  {allBuckets ? '움직인 날만' : '전부 보기'}
                </button>
              )}
              {openBuckets.size > 0 && (
                <button className="btn ghost sm" onClick={() => setOpenBuckets(new Set())}>모두 접기</button>
              )}
            </div>
          </div>

          {/* 모자라는 시점 — 표를 훑기 전에 결론부터. 없으면 아무 표식도 달지 않는다. */}
          {timeline.shortfalls.length > 0 && (
            <div className="card-pad" style={{ paddingTop: 0 }}>
              <div className="alert-row" style={{ background: 'var(--neg-soft, var(--warn-soft))', borderColor: 'transparent' }}>
                <Icon.Warn size={16}/>
                <div>
                  <div className="lead">잔액이 모자라는 때가 있어요</div>
                  {/* 한 줄에 붙여 놨더니 '−12,000,00008-25' 처럼 숫자가 이어 붙어 못 읽었다 */}
                  <div className="body">
                    {timeline.shortfalls.map((s, i) => (
                      <div key={i} style={{ padding: '3px 0' }}>
                        <b>{s.label}</b> · {s.accountName} <b className="num" style={{ color: 'var(--neg-ink)' }}>
                          −{fmtNum(s.need)}</b>
                        {/* "모자랍니다"까지만 말하면 절반이다 — 다음에 할 일은 어디서 끌어올지 찾는 것이다 */}
                        {s.cover?.length > 0 && (
                          <div className="text-sm text-muted" style={{ marginTop: 2 }}>
                            옮길 수 있는 통장:{' '}
                            {s.cover.map((cv, k) => (
                              <span key={cv.id} style={{ marginRight: 8 }}>
                                {k > 0 && '· '}{cv.name}
                                {cv.owner === 'personal' && <span className="text-xs"> (대표 개인)</span>}{' '}
                                <b className="num">{fmtNum(cv.balance)}</b>
                              </span>
                            ))}
                          </div>
                        )}
                        {s.accountId && s.cover?.length === 0 && (
                          <div className="text-sm text-muted" style={{ marginTop: 2 }}>
                            이 시점에 여유 있는 통장이 없어요 — 회사 전체가 모자랍니다.
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 폭은 계좌 수를 따라간다 — 760 으로 고정해 뒀더니 통장이 4개인 회사에서 날짜가
              '08-' / '03' 두 줄로 깨졌다. 넘치면 가로로 스크롤한다. */}
          {/* 기한을 모르는 돈 — 날짜축에 못 올린다. 안 보여주면 "이 표에 다 있다"고 믿게 되니
              금액과 이유를 위에 적어 둔다. 눌러 펼치면 무엇이 그런지 보인다. */}
          {(un.in > 0 || un.out > 0) && (
            <div className="card-pad" style={{ paddingTop: 0 }}>
              <div className="alert-row" style={{ background: 'var(--surface-2)', borderColor: 'transparent', cursor: 'pointer' }}
                onClick={() => toggleBucket('__undated')}>
                <Icon.Sparkle size={16}/>
                <div style={{ flex: 1 }}>
                  <div className="lead">
                    날짜가 안 잡힌 돈이 따로 있어요
                    {un.in > 0 && <> · 들어올 <b className="num" style={{ color: 'var(--pos-ink)' }}>{fmtNum(un.in)}</b></>}
                    {un.out > 0 && <> · 나갈 <b className="num" style={{ color: 'var(--neg-ink)' }}>{fmtNum(un.out)}</b></>}
                    <span className="text-xs text-muted2" style={{ marginLeft: 8 }}>
                      {openBuckets.has('__undated') ? '접기 ▲' : '펼치기 ▼'}
                    </span>
                  </div>
                  <div className="body">
                    기한이 없거나 이미 지난 돈이에요(밀린 급여·퇴직금, 기한 없는 청구서).
                    아래 표는 <b>며칠에 어느 통장이 비나</b>를 보는 자리라, 이 돈을 오늘 칸에 몰면
                    그 뒤 잔액이 통째로 가려져서 따로 뺐어요.
                  </div>
                  {openBuckets.has('__undated') && (
                    <div style={{ marginTop: 8 }}>
                      {timeline.undated.items.map((it, i) => (
                        <FlowLine key={i} it={{ ...it, date: it.overdue ? '기한 지남' : '기한 미정' }}/>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {asCalendar && timeline.bucketUnit === 'day' ? (
            <CalendarView timeline={timeline} openBuckets={openBuckets} onToggle={toggleBucket}/>
          ) : (
          <div className="table-scroll" style={{ overflowX: 'auto' }}>
            <table className="table timeline-table"
              style={{ minWidth: 360 + (moved.length + (rest.length ? 1 : 0)) * 130 + (hasUnassigned ? 120 : 0) + 130 }}>
              <thead>
                <tr>
                  <th style={{ width: 120, whiteSpace: 'nowrap' }}>
                    {timeline.bucketUnit === 'day' ? '날짜' : timeline.bucketUnit === 'week' ? '주' : '달'}
                  </th>
                  {/* '들어온·올'은 과거·미래를 억지로 붙인 말이라 읽히지 않는다.
                      줄마다 실적/예정 배지가 이미 시제를 말해주므로 열 이름은 시제를 안 쓴다. */}
                  <th className="num-right" style={{ width: 110 }}>입금</th>
                  <th className="num-right" style={{ width: 110 }}>출금</th>
                  {moved.map(a => (
                    <th key={a.id} className="num-right" style={{ width: 130 }}>{a.name}</th>
                  ))}
                  {rest.length > 0 && (
                    <th className="num-right" style={{ width: 130 }}>그 외 {rest.length}개</th>
                  )}
                  {/* 계좌를 안 정한 예정도 열로 세운다 — 각주로만 밝히면 열을 더해도 합계가 안 맞아
                      "이 표 숫자가 틀렸나" 싶어진다. 열로 있으면 눈으로 더해 맞출 수 있다. */}
                  {hasUnassigned && <th className="num-right" style={{ width: 120 }}>계좌 미정</th>}
                  <th className="num-right" style={{ width: 130 }}>합계</th>
                </tr>
              </thead>
              {timeline.buckets.filter(b => allBuckets || b.moved).map(b => (
                <tbody key={b.from}>
                  <tr onClick={() => b.moved && toggleBucket(b.from)}
                    style={{ cursor: b.moved ? 'pointer' : 'default', opacity: b.moved ? 1 : 0.5 }}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className={b.moved ? 'fw-600' : 'text-muted2'}>{b.label}</span>
                      {/* 지난 칸은 실적, 앞으로 올 칸은 예정 — 색이 아니라 말로 갈라준다 */}
                      {b.moved && (
                        <span className="text-xs text-muted2" style={{ marginLeft: 6 }}>
                          {b.past ? '실적' : '예정'} {openBuckets.has(b.from) ? '▲' : '▼'}
                        </span>
                      )}
                    </td>
                    <td className="num num-right" style={{ color: b.in ? 'var(--pos-ink)' : undefined }}>
                      {b.in ? fmtNum(b.in) : ''}
                    </td>
                    <td className="num num-right" style={{ color: b.out ? 'var(--neg-ink)' : undefined }}>
                      {b.out ? fmtNum(b.out) : ''}
                    </td>
                    {moved.map(a => {
                      const v = b.byAccount[a.id]
                      const neg = v.balance < 0
                      return (
                        <td key={a.id} className="num num-right"
                          style={{ color: neg ? 'var(--neg-ink)' : undefined, fontWeight: neg ? 700 : undefined }}>
                          <Money v={v.balance}/>
                        </td>
                      )
                    })}
                    {rest.length > 0 && (
                      <td className="num num-right text-muted"><Money v={restBal(b)}/></td>
                    )}
                    {hasUnassigned && (
                      // 아직 미정분이 없는 날에 0을 줄줄이 찍으면 시선만 먹는다 — 생기고부터 보여준다
                      <td className="num num-right" style={{ color: b.unassigned.balance < 0 ? 'var(--neg-ink)' : undefined }}>
                        {b.unassigned.balance === 0 ? '' : <Money v={b.unassigned.balance}/>}
                      </td>
                    )}
                    <td className="num num-right fw-700" style={{ color: b.balance < 0 ? 'var(--neg-ink)' : undefined }}>
                      <Money v={b.balance}/>
                    </td>
                  </tr>
                  {openBuckets.has(b.from) && (
                    <tr>
                      <td colSpan={cols} style={{ background: 'var(--surface-2)', padding: '10px 14px' }}>
                        {/* 들어온 돈을 먼저, 나간 돈을 뒤에 — 섞여 있으면 그 날 무슨 일이 있었는지 안 읽힌다 */}
                        {[...b.items].sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'in' ? -1 : 1))
                          .map((it, i) => <FlowLine key={i} it={it}/>)}
                      </td>
                    </tr>
                  )}
                </tbody>
              ))}
            </table>
          </div>
          )}
          {hasUnassigned && !asCalendar && (
            <div className="text-sm text-muted card-pad" style={{ paddingTop: 0 }}>
              <b>계좌 미정</b>은 어느 통장에서 오갈지 안 정해진 예정이에요(미지급 급여·퇴직금, 계좌를 안 적은 청구서).
              나가는 건 확실하니 합계에는 넣습니다.
            </div>
          )}
        </div>
      )})()}

      {/* 옆 구간 — 지금 보는 구간과 그 다음 하나. 어디로 갈지 고르는 자리다. */}
      {series && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <div className="fw-700">구간 비교</div>
            <div className="text-xs text-muted2">지금 구간과 다음 구간이에요. 누르면 그 구간으로 이동해요.</div>
          </div>
          <div className="table-scroll" style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 700 }}>
              <thead>
                <tr>
                  <th style={{ width: 130 }}>구간</th>
                  <th style={{ width: 84 }}>상태</th>
                  {/* 구간 하나에 실적과 예정이 섞여 있다 — 시제를 붙이면 반은 틀린 말이 된다 */}
                  <th className="num-right">입금</th>
                  <th className="num-right">출금</th>
                  <th className="num-right" style={{ width: 140 }}>남는 돈</th>
                </tr>
              </thead>
              <tbody>
                {series.series.map(p => (
                  <tr key={p.offset} onClick={() => { setOffset(p.offset); setOpen(null) }}
                    style={{ cursor: 'pointer', background: p.offset === offset ? 'var(--surface-2)' : undefined }}>
                    <td className="fw-600">
                      {p.label}
                      {p.offset === 0 && <span className="text-xs text-muted2" style={{ marginLeft: 6 }}>지금</span>}
                    </td>
                    <td>
                      {/* 확정에는 표식을 달지 않는다 — 정상이 기본이고, 눈에 띄어야 할 건 '아직 아닌 것'이다 */}
                      {p.state === 'closed'
                        ? <span className="text-xs text-muted2">확정</span>
                        : <span className="badge" style={{ fontSize: 10 }}>{STATE[p.state]?.label}</span>}
                    </td>
                    <td className="num num-right">{p.in ? fmtNum(p.in) : '—'}</td>
                    <td className="num num-right">{p.out ? fmtNum(p.out) : '—'}</td>
                    <td className="num num-right fw-700" style={{ color: p.net < 0 ? 'var(--neg-ink)' : undefined }}>
                      <Money v={p.net}/>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!data ? <Loading label="자금 현황을 모으는 중…"/> : (
        <>
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="row" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div className="fw-700" style={{ fontSize: 15 }}>
                  {data.range.label}
                  <span className="badge" style={{ marginLeft: 8, fontSize: 10 }}>{st.label}</span>
                </div>
                <div className="text-xs text-muted2" style={{ marginTop: 3 }}>{st.hint}</div>
              </div>
              <div className="row gap-16 ml-auto" style={{ flexWrap: 'wrap' }}>
                <div>
                  <div className="text-xs text-muted2">들어온 / 들어올</div>
                  <div className="num fw-600">{fmtNum(data.totals.actualIn)} / {fmtNum(data.totals.planIn)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted2">나간 / 나갈</div>
                  <div className="num fw-600">{fmtNum(data.totals.actualOut)} / {fmtNum(data.totals.planOut)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted2">차이</div>
                  <div className="num fw-700" style={{ fontSize: 16, color: data.totals.net < 0 ? 'var(--neg-ink)' : undefined }}>
                    <Money v={data.totals.net}/>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 대표 자금표 맨 아래 요약 행 그대로 — 보통계좌·저축·부채·지급예정·미지급 인건비.
              '현금 과부족'이 그 표의 결론이라 맨 오른쪽에 크게 둔다. */}
          <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th style={{ width: 90 }}>구분</th>
                  <th className="num-right">보통계좌</th>
                  <th className="num-right">저축·보증금</th>
                  <th className="num-right">부채</th>
                  <th className="num-right">나갈 돈</th>
                  <th className="num-right">미지급 인건비</th>
                  <th className="num-right" style={{ width: 140 }}>현금 과부족</th>
                </tr>
              </thead>
              <tbody>
                {[['법인', data.corp], ...(data.personal ? [['개인', data.personal]] : [])].map(([label, g]) => {
                  /* ⚠ 계좌 미지정 예정을 법인에 더한다.
                   *
                   * 미지급 급여·퇴직금·계좌를 안 적은 청구서는 account_id 가 없어서 계좌 합계
                   * 어디에도 안 들어간다. 그걸 빼고 '현금 과부족'을 내면 **결론이 낙관 쪽으로
                   * 틀린다** — 실제로 이 화면에서 나갈 돈이 4,317만으로 나왔는데 위 KPI는
                   * 1억 1,317만이었다(급여·퇴직금 7,000만이 통째로 빠져 있었다).
                   * 미지정 예정은 성격상 전부 법인 돈이라(개인 계좌 전용 예정은 없다) 법인에 얹는다. */
                  const un = label === '법인' ? (data.unassigned || { in: 0, out: 0 }) : { in: 0, out: 0 }
                  const planIn = g.planIn + un.in
                  const planOut = g.planOut + un.out
                  const gap = planIn - planOut
                  return (
                    <tr key={label}>
                      <td className="fw-600">{label}</td>
                      <td className="num num-right">{fmtNum(g.balance)}</td>
                      <td className="num num-right text-muted">{label === '법인' ? fmtNum(data.savings?.total || 0) : '—'}</td>
                      <td className="num num-right text-muted">{label === '법인' ? fmtNum(data.debts?.total || 0) : '—'}</td>
                      <td className="num num-right">{fmtNum(planOut)}</td>
                      <td className="num num-right text-muted">{label === '법인' ? fmtNum(data.labor?.total || 0) : '—'}</td>
                      <td className="num num-right fw-700" style={{ color: gap < 0 ? 'var(--neg-ink)' : undefined }}>
                        <Money v={gap}/>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {/* 한 표 안에 기준이 다른 숫자가 섞여 있다. 안 밝히면 지난 구간을 볼 때
                "7월엔 부채가 이만큼이었구나"로 잘못 읽는다 — 저 값은 오늘 잔액이다. */}
            <div className="text-sm text-muted card-pad" style={{ paddingTop: 0 }}>
              저축·부채·미지급 인건비는 <b>오늘 기준 잔액</b>이고, 나갈 돈·현금 과부족은 <b>이 구간</b>의 예정이에요.
              계좌를 안 정한 예정(급여·퇴직금 등)도 법인에 넣어 셉니다.
            </div>
          </div>

          <AccountTable group={data.corp} title="법인 계좌" unassigned={data.unassigned}/>
          {data.personal && <AccountTable group={data.personal} title="대표 개인 계좌"/>}

          {/* ── 대표 자금표 아래쪽 구성 그대로: 부채 · 저축 · 미지급 인건비 · 입금예정 ── */}
          <div className="grid-3-to-1" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 16 }}>
            {data.debts && data.debts.total > 0 && (
              <div className="card card-pad">
                <div className="row" style={{ alignItems: 'baseline', marginBottom: 10 }}>
                  <div className="fw-700">부채 현황</div>
                  <div className="num fw-700 ml-auto" style={{ color: 'var(--neg-ink)' }}>{fmtNum(data.debts.total)}원</div>
                </div>
                {data.debts.groups.map(g => (
                  <div key={g.lender} style={{ marginBottom: 8 }}>
                    <div className="row text-sm">
                      <span className="fw-600">{g.lender}</span>
                      <span className="num ml-auto fw-600">{fmtNum(g.total)}</span>
                    </div>
                    {g.items.map(it => (
                      <div key={it.id} className="row text-xs text-muted2" style={{ paddingLeft: 8 }}>
                        <span>{it.name}</span>
                        <span className="num ml-auto">{fmtNum(it.remaining)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {data.savings && data.savings.total > 0 && (
              <div className="card card-pad">
                <div className="row" style={{ alignItems: 'baseline', marginBottom: 10 }}>
                  <div className="fw-700">저축·보증금</div>
                  <div className="num fw-700 ml-auto">{fmtNum(data.savings.total)}원</div>
                </div>
                <div className="text-sm text-muted" style={{ marginBottom: 6 }}>묶여 있어 지금은 못 쓰는 돈이에요.</div>
                {data.savings.items.map(it => (
                  <div key={it.id} className="row text-sm" style={{ padding: '2px 0' }}>
                    <span>{it.name}</span>
                    <span className="text-xs text-muted2" style={{ marginLeft: 6 }}>
                      {it.kind === 'guarantee' ? '보증금' : it.kind === 'deposit' ? '예금' : '적금'}
                    </span>
                    <span className="num ml-auto">{fmtNum(it.amount)}</span>
                  </div>
                ))}
              </div>
            )}

            {data.labor && data.labor.total > 0 && (
              <div className="card card-pad">
                <div className="row" style={{ alignItems: 'baseline', marginBottom: 10 }}>
                  <div className="fw-700">미지급 급여·퇴직금</div>
                  <div className="num fw-700 ml-auto" style={{ color: 'var(--neg-ink)' }}>{fmtNum(data.labor.total)}원</div>
                </div>
                {/* 어디를 고쳐야 이 숫자가 바뀌는지 적어준다 — 안 적으면 "왜 안 지워지지"가 된다 */}
                <div className="text-sm text-muted" style={{ marginBottom: 6 }}>
                  급여는 급여대장, 퇴직금은 인사관리에서 관리해요.
                </div>
                {[['retired', '퇴직자'], ['active', '현직원']].map(([st, stLabel]) => {
                  const rows = data.labor.items.filter(x => x.status === st)
                  if (!rows.length) return null
                  return (
                    <div key={st} style={{ marginBottom: 8 }}>
                      <div className="text-sm fw-600">{stLabel}</div>
                      {rows.map((x, i) => (
                        <div key={i} className="row text-xs text-muted2" style={{ paddingLeft: 8 }}>
                          {/* 월분을 적는다 — 합계만 보면 언제 것이 안 나갔는지 모른다 */}
                          <span>{x.name} {x.period && `${x.period}분`} {x.kind === 'severance' ? '퇴직금' : '급여'}</span>
                          <span className="num ml-auto">{fmtNum(x.remain)}</span>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}

            {data.incoming && data.incoming.total > 0 && (
              <div className="card card-pad">
                <div className="row" style={{ alignItems: 'baseline', marginBottom: 10 }}>
                  <div className="fw-700">입금 예정</div>
                  <div className="num fw-700 ml-auto" style={{ color: 'var(--pos-ink)' }}>{fmtNum(data.incoming.total)}원</div>
                </div>
                {/* 날짜가 있는 돈은 위 계좌별 예정에 이미 서 있다. 여기는 '언제 들어올지 모르는' 것만. */}
                <div className="text-sm text-muted" style={{ marginBottom: 6 }}>
                  기한이 없거나 기한이 지난 미수금이에요. 날짜를 아는 건 위 계좌별 예정에 있어요.
                </div>
                {data.incoming.items.map((x, i) => (
                  <div key={i} className="row text-sm" style={{ padding: '2px 0' }}>
                    <span>{x.vendor}</span>
                    {x.contract && <span className="text-xs text-muted2" style={{ marginLeft: 6 }}>{x.contract}</span>}
                    {x.overdue && <span className="badge warn" style={{ fontSize: 10, marginLeft: 6 }}>기한 지남</span>}
                    <span className="num ml-auto">{fmtNum(x.remain)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 계좌를 모르는 예정은 감추면 합계가 안 맞는다 — 있으면 반드시 보여준다 */}
          {(data.unassigned.in > 0 || data.unassigned.out > 0) && (
            <div className="card card-pad" style={{ marginBottom: 16 }}>
              <div className="row" style={{ alignItems: 'baseline' }}>
                <div className="fw-600">계좌 미지정</div>
                <div className="text-xs text-muted2" style={{ marginLeft: 8 }}>
                  어느 통장으로 오갈지 안 정해진 돈이에요. 위 계좌 합계에는 안 들어갑니다.
                </div>
                <div className="num ml-auto">
                  {data.unassigned.in > 0 && <span className="text-pos">+{fmtNum(data.unassigned.in)}</span>}
                  {data.unassigned.out > 0 && <span style={{ marginLeft: 10, color: 'var(--neg-ink)' }}>−{fmtNum(data.unassigned.out)}</span>}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
