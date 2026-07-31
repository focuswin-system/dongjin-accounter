import { useState, useEffect, Fragment } from 'react'
import { Icon, fmtNum, localToday } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
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

  return (
    <div className="fade-up">
      {page && (
        <PageHeader title="자금일보"
          sub={`${data.date} 기준 · 앞으로 ${days}일`}
          actions={
            <div className="row gap-8" style={{ alignItems: 'center' }}>
              <input className="input" type="date" style={{ width: 150 }} value={date}
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
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 20 }}>
        {[
          { label: '지금 쓸 수 있는 돈', value: data.available, sub: `통장 ${data.accounts.filter(a => a.kind !== 'card').length}개` },
          { label: '묶인 돈 (예적금)', value: data.locked, sub: data.lockedItems.length ? `${data.lockedItems.length}건 · 만기까지 못 씀` : '없어요' },
          { label: '받을 돈 (미수금)', value: data.receivable.total, sub: `${data.receivable.count}건` },
          { label: '나갈 돈 (미지급금)', value: data.payable.total, sub: `${data.payable.count}건` },
        ].map(k => (
          <div key={k.label} className="card card-pad">
            <div className="text-xs text-muted2">{k.label}</div>
            <div className="num fw-700" style={{ fontSize: 20, marginTop: 4 }}>{fmtNum(k.value)}원</div>
            <div className="text-xs text-muted2" style={{ marginTop: 2 }}>{k.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* 계좌별 잔액 */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
            <span className="fw-700 text-sm">계좌별 잔액</span>
            <span className="num text-sm text-muted ml-auto">{fmtNum(data.available)}원</span>
          </div>
          <table className="table">
            <tbody>
              {data.accounts.filter(a => a.kind !== 'card').map(a => (
                <tr key={a.id}>
                  <td className="fw-700 text-sm">{a.name}
                    <div className="text-xs text-muted2">{[a.bank, a.number].filter(Boolean).join(' ')}</div>
                  </td>
                  <td className="text-xs text-muted2" style={{ width: 90 }}>{a.type}</td>
                  <td className="num-cell num-right fw-700">{fmtNum(a.balance)}</td>
                </tr>
              ))}
              {data.lockedItems.map(s => (
                <tr key={s.id} style={{ opacity: 0.7 }}>
                  <td className="text-sm">{s.name}
                    <div className="text-xs text-muted2">{s.bank} · 만기 {s.maturity_date || '—'}</div>
                  </td>
                  <td style={{ width: 90 }}><span className="badge outline" style={{ fontSize: 10 }}>묶임</span></td>
                  <td className="num-cell num-right text-muted">{fmtNum(s.balance)}</td>
                </tr>
              ))}
              {data.accounts.filter(a => a.kind !== 'card').length === 0 && (
                <tr><td colSpan={3} style={{ textAlign: 'center', padding: 24, color: 'var(--muted-2)', fontSize: 13 }}>
                  등록된 계좌가 없어요.
                </td></tr>
              )}
            </tbody>
          </table>
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
          <div style={{ maxHeight: 460, overflowY: 'auto' }}>
            <table className="table">
              <tbody>
                {f.days.length === 0 && (
                  <tr><td style={{ textAlign: 'center', padding: 24, color: 'var(--muted-2)', fontSize: 13 }}>
                    이 기간에 예정된 입출금이 없어요.
                  </td></tr>
                )}
                {f.days.map(d => (
                  <Fragment key={d.date}>
                    <tr style={{ background: 'var(--surface-2)' }}>
                      <td className="num text-sm fw-700" colSpan={2}>
                        {d.date} <span className="text-xs text-muted2" style={{ fontWeight: 400 }}>{dday(d.date, data.date)}</span>
                      </td>
                      <td className="num-cell num-right text-sm">
                        <span style={{ color: d.net >= 0 ? 'var(--pos-ink)' : 'var(--neg-ink)' }}>
                          {d.net >= 0 ? '+' : ''}{fmtNum(d.net)}
                        </span>
                      </td>
                      <td className="num-cell num-right fw-700" style={{ color: d.balance < 0 ? 'var(--neg-ink)' : undefined }}>
                        {fmtNum(d.balance)}
                      </td>
                    </tr>
                    {d.items.map((it, i) => (
                      <tr key={i}>
                        <td style={{ paddingLeft: 20 }} className="text-sm">
                          {it.label || '—'}
                          {it.overdue && <span className="badge neg" style={{ marginLeft: 6, fontSize: 10 }}>기한 지남</span>}
                        </td>
                        <td className="text-xs text-muted2" style={{ width: 90 }}>{it.source}</td>
                        <td className="num-cell num-right text-sm" colSpan={2}
                          style={{ color: it.kind === 'in' ? 'var(--pos-ink)' : 'var(--neg-ink)' }}>
                          {it.kind === 'in' ? '+' : '−'}{fmtNum(it.amount)}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
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

  const shift = (n) => {
    const d = new Date(date); d.setDate(d.getDate() + n)
    setDate(d.toISOString().slice(0, 10))
  }

  return (
    <div className="fade-up">
      <PageHeader title="일계표"
        sub="하루치 거래를 계정과목별로 차변·대변에 나눠 봅니다"
        actions={
          <div className="row gap-4" style={{ alignItems: 'center' }}>
            <button className="btn sm" onClick={() => shift(-1)}>◀</button>
            <input className="input" type="date" style={{ width: 150 }} value={date}
              onChange={e => setDate(e.target.value)}/>
            <button className="btn sm" onClick={() => shift(1)}>▶</button>
            <button className="btn sm" onClick={() => setDate(localToday())}>오늘</button>
          </div>
        }/>

      {loading && !data && <div className="text-sm text-muted" style={{ padding: 40, textAlign: 'center' }}>불러오는 중…</div>}
      {data && (
        <>
          {/* 합계가 안 맞으면 그 사실을 감추지 않는다 — 조용히 맞추면 틀린 장부가 맞는 것처럼 보인다 */}
          {!data.balanced && (
            <div className="card card-pad" style={{ marginBottom: 16, borderColor: 'var(--neg)', background: 'rgba(220,38,38,0.04)' }}>
              <div className="fw-700 text-sm" style={{ color: 'var(--neg-ink)', marginBottom: 4 }}>
                차변과 대변이 맞지 않아요 (차이 {fmtNum(Math.abs(data.debitTotal - data.creditTotal))}원)
              </div>
              <div className="text-sm text-muted" style={{ lineHeight: 1.7 }}>
                계좌나 계정과목이 비어 있는 거래가 {data.unbalanced.length}건 있어요.
                한쪽 다리가 없으면 합계가 맞을 수 없습니다. 아래 목록의 거래를 고쳐주세요.
              </div>
              <table className="table" style={{ marginTop: 10 }}>
                <tbody>
                  {data.unbalanced.map(u => (
                    <tr key={u.id}>
                      <td className="text-sm">{u.category || '(내용 없음)'}</td>
                      <td className="text-xs text-muted2" style={{ width: 120 }}>{u.account_name || '계좌 없음'}</td>
                      <td className="text-xs" style={{ width: 130, color: 'var(--neg-ink)' }}>{u.missing} 없음</td>
                      <td className="num-cell num-right text-sm">{fmtNum(u.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', gap: 10 }}>
              <span className="fw-700 text-sm">{data.date}</span>
              <span className="text-xs text-muted2">거래 {data.txnCount}건</span>
              {data.balanced && data.txnCount > 0 && (
                <span className="badge pos ml-auto"><Icon.Check size={12}/> 차·대변 일치</span>
              )}
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th className="num-right" style={{ width: 160 }}>차변</th>
                  <th style={{ width: 90 }}>코드</th>
                  <th>계정과목</th>
                  <th style={{ width: 80 }}>구분</th>
                  <th className="num-right" style={{ width: 160 }}>대변</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', padding: 32, color: 'var(--muted-2)', fontSize: 13 }}>
                    이 날짜에 완료된 거래가 없어요.
                  </td></tr>
                )}
                {data.lines.map(l => (
                  <tr key={l.code}>
                    <td className="num-cell num-right fw-700">{l.debit ? fmtNum(l.debit) : ''}</td>
                    <td className="num text-xs text-muted2">{l.code}</td>
                    <td className="text-sm">{l.name}
                      {l.category && <span className="text-xs text-muted2" style={{ marginLeft: 6 }}>{l.category}</span>}
                    </td>
                    <td><span className="badge outline" style={{ fontSize: 10 }}>{l.acct_type || '—'}</span></td>
                    <td className="num-cell num-right fw-700">{l.credit ? fmtNum(l.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
              {data.lines.length > 0 && (
                <tfoot>
                  <tr style={{ background: 'var(--surface-2)' }}>
                    <td className="num-cell num-right fw-700">{fmtNum(data.debitTotal)}</td>
                    <td colSpan={3} style={{ textAlign: 'center' }} className="text-sm fw-700">합계</td>
                    <td className="num-cell num-right fw-700">{fmtNum(data.creditTotal)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className="text-xs text-muted2" style={{ marginTop: 14, lineHeight: 1.7 }}>
            · 거래 하나가 <b>두 줄</b>로 나뉩니다. 입금이면 통장이 차변(늘어남)·상대 계정이 대변,
            지출이면 반대예요. 그래서 차변 합계와 대변 합계는 <b>항상 같아야</b> 합니다.<br/>
            · 완료된 거래만 셉니다(지급 대기·입금 예정은 아직 장부에 오르지 않은 돈이에요).<br/>
            · 자금 흐름과 앞으로의 예정은 <b>자금일보</b>에서 보세요. 일계표는 그날 분개를 맞추는 문서예요.
          </div>
        </>
      )}
    </div>
  )
}
