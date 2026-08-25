import { useState, useEffect } from 'react'
import { Icon, fmtNum, localToday, DateInput } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { Kpi, KpiRow } from '../lib/components/Kpi'
import { DataTable } from '../lib/components/DataTable'
import { api } from '../lib/api'

/* 자금일보 — "지금 돈이 어디 얼마 있고, 앞으로 언제 들어오고 나가는가".
 *
 * 보고서 안에 넣지 않고 잎으로 세운 이유: 보고서 10개는 전부 '지난달 어땠나'(과거 집계)이고
 * 월 1~2회 본다. 자금일보는 **매일 아침 제일 먼저 여는 화면**이고 미래 예측을 담는다.
 * 성격도 빈도도 달라서 섞으면 둘 다 흐려지고, 3단계 깊이에 묻히면 안 보게 된다.
 *
 * 이 화면의 결론은 맨 위 '최저 예상 잔액'이다 — 흑자도산은 손익이 아니라 여기서 드러난다.
 */

const RANGES = [
  { days: 14, label: '2주' },
  { days: 30, label: '한 달' },
  { days: 60, label: '두 달' },
  { days: 90, label: '석 달' },
]

const dday = (date, from) => {
  const d = Math.round((new Date(date) - new Date(from)) / 86400000)
  return d === 0 ? '오늘' : d > 0 ? `D-${d}` : `${-d}일 지남`
}

export const CashReportScreen = ({ page = true }) => {
  const [date, setDate] = useState(localToday())
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.getCashReport({ date, days }).then(d => { if (alive) { setData(d); setLoading(false) } })
    return () => { alive = false }
  }, [date, days])

  if (loading && !data) return <div className="text-sm text-muted" style={{ padding: 40, textAlign: 'center' }}>불러오는 중…</div>
  if (!data) return <div className="text-sm text-muted" style={{ padding: 40, textAlign: 'center' }}>자금 현황을 불러오지 못했어요.</div>

  const f = data.forecast
  // 잔액이 마이너스로 떨어지면 그날 돈이 모자란다는 뜻 — 가장 강하게 알려야 할 신호다
  const willRunShort = f.lowest.balance < 0
  const tight = !willRunShort && f.lowest.balance < data.available * 0.2

  /* 계좌별 예측 — 합계가 넉넉해도 특정 통장은 마이너스일 수 있다.
     실제로 이 회사가 그랬다: 주거래 +3억 7,154만 / 급여계좌 −5,357만.
     합계만 보면 "자금 넉넉해요"라 급여일에 이체가 안 나가는 걸 알 수 없다. */
  const ba = data.byAccount || { accounts: [], unassigned: { in: 0, out: 0, items: [] } }
  const byAcct = new Map(ba.accounts.map(a => [a.id, a]))
  const unassigned = ba.unassigned
  const shortAccounts = ba.accounts.filter(a => a.lowest && a.lowest.balance < 0)
  // 옮겨올 수 있는 통장 = 예상 최저가 가장 넉넉한 곳
  const richest = ba.accounts
    .filter(a => a.lowest && a.lowest.balance > 0)
    .sort((x, y) => y.lowest.balance - x.lowest.balance)[0] || null

  return (
    <div className="fade-up">
      {page && (
        <PageHeader title="자금일보"
          sub={`${data.date} 기준 · 앞으로 ${days}일`}
          actions={
            <div className="row gap-8" style={{ alignItems: 'center' }}>
              <DateInput className="input" style={{ width: 150 }} value={date}
                max={localToday()} onChange={e => setDate(e.target.value)}/>
              <div className="row gap-4">
                {RANGES.map(r => (
                  <button key={r.days} type="button" className={`chip ${days === r.days ? 'active' : ''}`}
                    onClick={() => setDays(r.days)}>{r.label}</button>
                ))}
              </div>
            </div>
          }/>
      )}

      {/* 결론부터 — 며칠에 얼마까지 떨어지나 */}
      <div className="card card-pad" style={{
        marginBottom: 18,
        borderColor: willRunShort ? 'var(--neg)' : tight ? 'var(--warn, var(--line))' : undefined,
        background: willRunShort ? 'rgba(220,38,38,0.04)' : undefined,
      }}>
        <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="text-xs text-muted2">앞으로 {days}일 중 가장 낮은 잔액</div>
            <div className="num fw-700" style={{ fontSize: 26, marginTop: 4, color: willRunShort ? 'var(--neg-ink)' : undefined }}>
              {fmtNum(f.lowest.balance)}원
            </div>
            <div className="text-sm" style={{ marginTop: 4, color: willRunShort ? 'var(--neg-ink)' : 'var(--muted)' }}>
              {f.lowest.date === data.date
                ? '오늘이 가장 낮아요 — 앞으로는 들어올 돈이 더 많아요'
                : `${f.lowest.date} (${dday(f.lowest.date, data.date)})`}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            {willRunShort ? (
              <div className="text-sm" style={{ lineHeight: 1.7 }}>
                <b style={{ color: 'var(--neg-ink)' }}>이대로 가면 돈이 모자랍니다.</b><br/>
                미수금을 앞당겨 받거나, 지급 일정을 조정하거나, 자금을 융통해야 해요.
              </div>
            ) : tight ? (
              <div className="text-sm" style={{ lineHeight: 1.7 }}>
                <b>여유가 빠듯해요.</b> 예정에 없던 지출이 생기면 흔들릴 수 있어요.
              </div>
            ) : (
              <div className="text-sm text-muted" style={{ lineHeight: 1.7 }}>
                예정대로면 자금은 넉넉해요. 들어올 돈 {fmtNum(f.totalIn)}원, 나갈 돈 {fmtNum(f.totalOut)}원.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 지금 상태 */}
      <KpiRow cols={4} style={{ marginBottom: 20 }}>
        {/* 법인 것만 센다. 개인(대표 사비)은 아래에 따로 적는다 — 섞으면 "회사에 얼마 있나"가 부풀려진다 */}
        <Kpi label="지금 쓸 수 있는 돈" value={data.available}
          tone={data.available < 0 ? 'neg-ink' : undefined}
          hint={data.availablePersonal
            ? `법인 통장 ${data.accounts.filter(a => a.kind !== 'card' && a.owner !== 'personal').length}개 · 개인 ${fmtNum(data.availablePersonal)}원 별도`
            : `통장 ${data.accounts.filter(a => a.kind !== 'card').length}개`}/>
        <Kpi label="묶인 돈 (예적금)" value={data.locked}
          badge={data.lockedItems.length ? `${data.lockedItems.length}건` : undefined}
          hint={data.lockedItems.length ? '만기까지 못 씀' : '없어요'}/>
        <Kpi label="받을 돈 (미수금)" value={data.receivable.total} tone="pos"
          badge={`${data.receivable.count}건`}/>
        <Kpi label="나갈 돈 (미지급금)" value={data.payable.total} tone="neg-ink"
          badge={`${data.payable.count}건`}/>
      </KpiRow>

      {/* 기약 없는 돈 — **계산에서 뺀 몫을 감추지 않는다.**
          빼 놓고 화면에도 안 적으면 "그 돈은 어디 갔나"가 된다.
          ⚠ 들어올 돈과 나갈 돈에서 처리가 서로 반대라, 그 사실을 문장으로 밝힌다.
             같은 말로 적으면 한쪽은 반드시 오해된다. */}
      {(f.uncertainIn > 0 || f.uncertainOut > 0) && (
        <div className="card card-pad" style={{ marginBottom: 20 }}>
          <div className="text-sm fw-700" style={{ marginBottom: 8 }}>기약 없는 돈</div>
          <div className="text-sm text-muted" style={{ lineHeight: 1.8 }}>
            {f.uncertainIn > 0 && (<>
              들어올 돈 <b className="num" style={{ color: 'var(--pos-ink)' }}>{fmtNum(f.uncertainIn)}원</b>
              <span className="text-muted2"> ({f.uncertainInCount}건)</span>
              {' '}— 장기 미수·기한 미정·오래 밀린 건이에요.
              <b> 위 예측에서 뺐습니다</b> (없는 셈 쳐야 안전해요).<br/>
            </>)}
            {f.uncertainOut > 0 && (<>
              나갈 돈 <b className="num" style={{ color: 'var(--neg-ink)' }}>{fmtNum(f.uncertainOut)}원</b>
              <span className="text-muted2"> ({f.uncertainOutCount}건)</span>
              {' '}— 기한을 모르는 미지급·퇴직금이에요.
              <b> 위 예측에 그대로 넣었습니다</b> (있는 셈 쳐야 안전해요).
            </>)}
          </div>
        </div>
      )}

      <div className="cols-2">
        {/* 계좌별 잔액 */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
            <span className="fw-700 text-sm">계좌별 잔액</span>
            <span className="num text-sm text-muted ml-auto">{fmtNum(data.available)}원</span>
          </div>
          {/* 통장과 묶인 돈(예적금)을 한 표에 — 둘 다 회사 돈이지만 쓸 수 있는지가 다르다.
              여기에 **계좌별 예상 최저 잔액**을 함께 둔다. 합계만 보면
              "회사 전체로는 넉넉한데 급여계좌는 마이너스"를 알 수 없다(실제로 그런 상태였다). */}
          <DataTable
            rows={[
              ...data.accounts.filter(a => a.kind !== 'card').map(a => {
                const f = byAcct.get(a.id)
                return { id: a.id, name: a.name, sub: [a.bank, a.number].filter(Boolean).join(' '),
                  tag: a.type, amount: a.balance, low: f?.lowest, flowIn: f?.in || 0, flowOut: f?.out || 0 }
              }),
              ...data.lockedItems
                .map(s => ({ id: s.id, name: s.name, sub: `${s.bank || ''} · 만기 ${s.maturity_date || '—'}`, locked: true, amount: s.balance })),
            ]}
            empty="등록된 계좌가 없어요."
            columns={[
              { key: 'name', header: '계좌', render: r => (
                <div style={{ opacity: r.locked ? 0.7 : 1 }}>
                  <div className={r.locked ? 'text-sm' : 'fw-700 text-sm'}>{r.name}</div>
                  <div className="text-xs text-muted2">{r.sub}</div>
                </div>
              )},
              { key: 'amount', header: '지금 잔액', width: 120, align: 'right',
                className: 'num-cell', render: r => (
                  <span className={r.locked ? 'text-muted' : 'fw-700'}>{fmtNum(r.amount)}</span>
                )},
              /* 예상 최저 = 앞으로 N일 사이 이 통장이 가장 낮아지는 순간.
                 지금 잔액이 넉넉해도 그 사이 빠져나갈 게 많으면 여기서 드러난다. */
              { key: 'low', header: `예상 최저 (${data.days}일)`, width: 150, align: 'right', render: r => {
                if (r.locked) return <span className="text-xs text-muted2">—</span>
                const v = r.low?.balance
                if (v == null) return <span className="text-xs text-muted2">—</span>
                const short = v < 0
                return (
                  <div>
                    <div className={`num-cell ${short ? 'fw-700' : 'text-muted'}`}
                      style={short ? { color: 'var(--neg-ink)' } : undefined}>{fmtNum(v)}</div>
                    {(r.flowIn > 0 || r.flowOut > 0) && (
                      <div className="text-xs text-muted2">{r.low?.date}</div>
                    )}
                  </div>
                )
              }},
            ]}/>
          {/* 부족해지는 통장은 표 밑에서 한 번 더 짚는다 — 표만 보면 지나치기 쉽다.
              얼마를 옮겨야 하는지까지 계산해줘야 바로 행동으로 이어진다. */}
          {shortAccounts.length > 0 && (
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--line)', background: 'var(--neg-weak, var(--surface-2))' }}>
              {shortAccounts.map(a => (
                <div key={a.id} className="text-xs" style={{ lineHeight: 1.7 }}>
                  <b style={{ color: 'var(--neg-ink)' }}>{a.name}</b>이 {a.lowest.date}에{' '}
                  <b className="num">{fmtNum(Math.abs(a.lowest.balance))}원</b> 부족해요
                  {richest && richest.id !== a.id && richest.lowest.balance > Math.abs(a.lowest.balance) && (
                    <> — <b>{richest.name}</b>에서 옮기면 돼요</>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* 어느 통장으로 들어올지 안 정한 돈. 임의로 한 계좌에 몰아넣으면 그 계좌가
              실제보다 넉넉해 보이므로 따로 세워 "정해주세요"라고 말한다. */}
          {(unassigned.in > 0 || unassigned.out > 0) && (
            <div className="row" style={{ padding: '10px 16px', borderTop: '1px solid var(--line)' }}>
              <span className="text-xs text-muted2">계좌를 안 정한 예정 {unassigned.items.length}건</span>
              <span className="num text-sm ml-auto">
                {unassigned.in > 0 && <span style={{ color: 'var(--pos)' }}>+{fmtNum(unassigned.in)}</span>}
                {unassigned.in > 0 && unassigned.out > 0 && ' / '}
                {unassigned.out > 0 && <span style={{ color: 'var(--neg-ink)' }}>−{fmtNum(unassigned.out)}</span>}
              </span>
            </div>
          )}
          {data.loanRemaining > 0 && (
            <div className="row" style={{ padding: '10px 16px', borderTop: '1px solid var(--line)', background: 'var(--surface-2)' }}>
              <span className="text-xs text-muted2">갚아야 할 차입금 {data.loanCount}건</span>
              <span className="num text-sm ml-auto">−{fmtNum(data.loanRemaining)}원</span>
            </div>
          )}
        </div>

        {/* 날짜별 예정 */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', gap: 10 }}>
            <span className="fw-700 text-sm">앞으로 들어올·나갈 돈</span>
            <span className="text-xs text-muted2 ml-auto">
              +{fmtNum(f.totalIn)} / −{fmtNum(f.totalOut)}
            </span>
          </div>
          {/* 날짜 한 줄 + 그날 항목들 — DataTable 의 펼침 행을 항상 열어 쓴다 */}
          <div style={{ maxHeight: 460, overflowY: 'auto' }}>
            <DataTable
              rows={f.days}
              rowKey={d => d.date}
              empty="이 기간에 예정된 입출금이 없어요."
              renderExpanded={d => (
                <div>
                  {d.items.map((it, i) => (
                    <div key={i} className="row" style={{
                      gap: 8, padding: '8px 14px 8px 24px',
                      borderTop: i === 0 ? 'none' : '1px solid var(--line)',
                    }}>
                      <span className="text-sm" style={{ flex: 1, minWidth: 0 }}>
                        {it.label || '—'}
                        {/* 불확실 배지가 더 무거운 말이라 '기한 지남'을 포함한다.
                            둘 다 붙이면 '기한 지남 · 146일 밀림'처럼 같은 말이 두 번 보인다. */}
                        {it.overdue && it.certain !== false && (
                          <span className="badge neg" style={{ marginLeft: 6, fontSize: 10 }}>기한 지남</span>
                        )}
                        {/* 왜 기약이 없는지를 그 줄에 적는다 — '기한 미정'만으로는
                            장기 미수와 오래 밀린 건을 구분할 수 없다 */}
                        {it.certain === false && (
                          <span className="badge warn" style={{ marginLeft: 6, fontSize: 10 }}>
                            {it.uncertainReason || '기한 미정'}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted2" style={{ flexShrink: 0 }}>{it.source}</span>
                      <span className="num-cell text-sm" style={{
                        width: 110, textAlign: 'right', flexShrink: 0,
                        color: it.kind === 'in' ? 'var(--pos-ink)' : 'var(--neg-ink)',
                      }}>
                        {it.kind === 'in' ? '+' : '−'}{fmtNum(it.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              columns={[
                { key: 'date', header: '날짜', render: d => (
                  <span className="num text-sm fw-700">{d.date}
                    <span className="text-xs text-muted2" style={{ fontWeight: 400, marginLeft: 6 }}>{dday(d.date, data.date)}</span>
                  </span>
                )},
                { key: 'net', header: '증감', width: 120, align: 'right', className: 'num-cell text-sm', render: d => (
                  <span style={{ color: d.net >= 0 ? 'var(--pos-ink)' : 'var(--neg-ink)' }}>
                    {d.net >= 0 ? '+' : ''}{fmtNum(d.net)}
                  </span>
                )},
                { key: 'balance', header: '잔액', width: 130, align: 'right', className: 'num-cell fw-700', render: d => (
                  <span style={{ color: d.balance < 0 ? 'var(--neg-ink)' : undefined }}>{fmtNum(d.balance)}</span>
                )},
              ]}/>
          </div>
        </div>
      </div>

      <div className="text-xs text-muted2" style={{ marginTop: 14, lineHeight: 1.7 }}>
        · 잔액은 <b>완료된 거래만</b> 셉니다(입금 예정·지급 대기는 아직 통장에 없는 돈이라 아래 예정에 잡혀요).<br/>
        · 기한이 지난 미수·미지급은 기준일에 몰아서 표시해요 — 언제 들어올지 모르니 가장 앞에 세웁니다.<br/>
        · 정기청구·정기지출은 청구서나 거래로 만들어진 뒤에 잡혀요(예정과 실제를 두 번 세지 않으려고요).
      </div>
    </div>
  )
}

/** 일계표 — 그날 거래를 계정과목별 차변/대변으로. 경리가 분개를 맞추는 문서다. */
export const DailyTrialScreen = () => {
  const [date, setDate] = useState(localToday())
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.getDailyTrial(date).then(d => { if (alive) { setData(d); setLoading(false) } })
    return () => { alive = false }
  }, [date])

  /* 날짜 이동 — toISOString()은 UTC라 쓰면 안 된다(src/lib/ui.jsx 규약).
   * new Date("2026-07-31")은 UTC 자정 파싱인데 setDate/getDate는 로컬 기준이라,
   * UTC+9에서는 우연히 맞고 그 외 시간대에서는 하루씩 밀린다. 로컬 달력으로만 센다. */
  const shift = (n) => {
    const [y, m, d] = date.split('-').map(Number)
    const t = new Date(y, m - 1, d + n)
    setDate(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`)
  }

  return (
    /* 표가 T자라 폭을 860으로 묶었다. 제목·날짜 이동까지 같은 폭 안에 둬야
       머리글과 표가 한 덩어리로 읽힌다(제목만 왼쪽 끝에 떨어져 있으면 어긋나 보인다). */
    /* margin 축약형을 쓰면 React가 marginTop 같은 개별 속성과 섞였다고 경고한다
       (같은 자리에 다른 화면이 들어왔다 나가면서 스타일이 교체될 때). 개별 속성으로 적는다. */
    <div className="fade-up" style={{ maxWidth: 860, marginLeft: 'auto', marginRight: 'auto' }}>
      <PageHeader title="일계표"
        sub="하루치 거래를 계정과목별로 차변·대변에 나눠 봅니다"
        actions={
          <div className="row gap-4" style={{ alignItems: 'center' }}>
            <button className="btn sm" onClick={() => shift(-1)}>◀</button>
            <DateInput className="input" style={{ width: 150 }} value={date}
              onChange={e => setDate(e.target.value)}/>
            <button className="btn sm" onClick={() => shift(1)}>▶</button>
            <button className="btn sm" onClick={() => setDate(localToday())}>오늘</button>
          </div>
        }/>

      {loading && !data && <div className="text-sm text-muted" style={{ padding: 40, textAlign: 'center' }}>불러오는 중…</div>}
      {data && (
        <>
          {/* 합계가 안 맞으면 그 사실을 감추지 않는다 — 조용히 맞추면 틀린 장부가 맞는 것처럼 보인다 */}
          {/* 합계가 우연히 맞아도 짝 잃은 거래가 있으면 알린다 — 그게 더 위험하다
              (장부가 맞는 것처럼 보이는데 실제로는 두 거래가 서로의 오류를 가리고 있다) */}
          {data.unbalanced.length > 0 && (
            <div className="card card-pad" style={{ marginBottom: 16, borderColor: 'var(--neg)', background: 'rgba(220,38,38,0.04)' }}>
              <div className="fw-700 text-sm" style={{ color: 'var(--neg-ink)', marginBottom: 4 }}>
                {data.totalsMatch
                  ? '합계는 맞지만 짝이 없는 거래가 있어요'
                  : `차변과 대변이 맞지 않아요 (차이 ${fmtNum(Math.abs(data.debitTotal - data.creditTotal))}원)`}
              </div>
              <div className="text-sm text-muted" style={{ lineHeight: 1.7 }}>
                계좌나 계정과목이 비어 있는 거래가 {data.unbalanced.length}건 있어요.
                {data.totalsMatch
                  ? ' 우연히 금액이 상쇄돼 합계는 맞아 보이지만, 장부가 맞는 건 아니에요.'
                  : ' 한쪽 다리가 없으면 합계가 맞을 수 없습니다.'} 아래 목록의 거래를 고쳐주세요.
              </div>
              <div style={{ marginTop: 10 }}>
                <DataTable
                  rows={data.unbalanced}
                  columns={[
                    { key: 'category', header: '내용', className: 'text-sm', render: u => u.category || '(내용 없음)' },
                    { key: 'account_name', header: '계좌', width: 130, className: 'text-xs text-muted2',
                      render: u => u.account_name || '계좌 없음' },
                    { key: 'missing', header: '빠진 것', width: 140, className: 'text-xs',
                      render: u => <span style={{ color: 'var(--neg-ink)' }}>{u.missing} 없음</span> },
                    { key: 'amount', header: '금액', width: 120, align: 'right', className: 'num-cell text-sm',
                      render: u => fmtNum(u.amount) },
                  ]}/>
              </div>
            </div>
          )}

          {/* 전표를 아직 못 세운 청구서 — 합계에는 안 들어갔으므로 "장부가 틀렸다"가 아니다.
              톤을 불일치 경고와 구분한다: 이건 고칠 수 있는 빈칸이지 오류가 아니다. */}
          {data.pendingInvoices?.length > 0 && (
            <div className="card card-pad" style={{ marginBottom: 16 }}>
              <div className="fw-700 text-sm" style={{ marginBottom: 4 }}>
                전표를 세우지 못한 청구서 {data.pendingInvoices.length}건
              </div>
              <div className="text-sm text-muted" style={{ lineHeight: 1.7, marginBottom: 10 }}>
                비목이 없어 어떤 계정으로 올릴지 정해지지 않았어요. 아래 합계에는 <b>넣지 않았습니다</b> —
                차·대변은 그대로 맞아요. 청구서를 열어 비목을 골라주시면 장부에 올라갑니다.
              </div>
              <DataTable
                rows={data.pendingInvoices}
                rowKey={p => p.id}
                columns={[
                  { key: 'invoice_no', header: '청구서', className: 'text-sm',
                    render: p => p.invoice_no || '(번호 없음)' },
                  { key: 'kind', header: '구분', width: 70, className: 'text-xs text-muted2',
                    render: p => (p.kind === 'issued' ? '매출' : '매입') },
                  { key: 'missing', header: '빠진 것', width: 220, className: 'text-xs text-muted2',
                    render: p => p.missing },
                  { key: 'amount', header: '금액', width: 120, align: 'right', className: 'num-cell text-sm',
                    render: p => fmtNum(p.amount) },
                ]}/>
            </div>
          )}

          {/* 일계표는 T자다 — 차변 | 계정과목 | 대변 이 가운데로 모여야 읽힌다.
              넓은 화면에서 폭을 다 쓰면 가운데가 텅 비어 좌우 숫자를 눈으로 잇기 어렵다. */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', gap: 10 }}>
              <span className="fw-700 text-sm">{data.date}</span>
              <span className="text-xs text-muted2">거래 {data.txnCount}건</span>
              {/* 발행분을 함께 세는지 밝힌다 — 숫자가 왜 달라 보이는지 알 수 있어야 한다 */}
              {data.includeIssuance && data.issuedCount > 0 && (
                <span className="text-xs text-muted2">· 청구서 발행 {data.issuedCount}건</span>
              )}
              {data.balanced && data.txnCount > 0 && (
                <span className="badge pos ml-auto"><Icon.Check size={12}/> 차·대변 일치</span>
              )}
            </div>
            <DataTable
              rows={data.lines}
              rowKey={l => l.code}
              empty="이 날짜에 완료된 거래가 없어요."
              footer={data.lines.length > 0 && (
                <tr>
                  <td className="num-cell num-right">{fmtNum(data.debitTotal)}</td>
                  <td className="text-sm text-center">합계</td>
                  <td className="num-cell num-right">{fmtNum(data.creditTotal)}</td>
                </tr>
              )}
              columns={[
                { key: 'debit', header: '차변', width: 200, align: 'right', className: 'num-cell fw-700',
                  render: l => (l.debit ? fmtNum(l.debit) : '') },
                // 코드·이름·대분류를 한 칸에 모은다. 컬럼으로 쪼개면 좌우 숫자가 멀어져 T자로 안 읽힌다
                { key: 'name', header: '계정과목', align: 'center', render: l => (
                  <div className="row" style={{ gap: 8, justifyContent: 'center', alignItems: 'baseline' }}>
                    <span className="num text-xs text-muted2">{l.code}</span>
                    <span className="text-sm fw-600">{l.name}</span>
                    {l.acct_type && <span className="badge outline" style={{ fontSize: 10 }}>{l.acct_type}</span>}
                  </div>
                )},
                { key: 'credit', header: '대변', width: 200, align: 'right', className: 'num-cell fw-700',
                  render: l => (l.credit ? fmtNum(l.credit) : '') },
              ]}/>
          </div>

          <div className="text-xs text-muted2" style={{ marginTop: 14, lineHeight: 1.7 }}>
            · 거래 하나가 <b>두 줄</b>로 나뉩니다. 입금이면 통장이 차변(늘어남)·상대 계정이 대변,
            지출이면 반대예요. 그래서 차변 합계와 대변 합계는 <b>항상 같아야</b> 합니다.<br/>
            · 완료된 거래만 셉니다(지급 대기·입금 예정은 아직 장부에 오르지 않은 돈이에요).<br/>
            {data.includeIssuance
              ? <>· <b>청구서를 발행한 날</b>의 분개도 함께 셉니다 — 그때 받을 돈(외상매출금)이 생기고,
                  입금될 때 사라져요. 두 시점이 다 있어야 장부가 맞습니다.<br/></>
              : <>· 청구서 발행 분개는 세지 않습니다(회사 설정). 돈이 실제로 오간 거래만 봅니다.<br/></>}
            · 자금 흐름과 앞으로의 예정은 <b>자금일보</b>에서 보세요. 일계표는 그날 분개를 맞추는 문서예요.
          </div>
        </>
      )}
    </div>
  )
}
