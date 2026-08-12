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

export const FundStatusScreen = ({ go }) => {
  const [unit, setUnit] = useState('month')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState(null)
  const [series, setSeries] = useState(null)
  const [open, setOpen] = useState(null)      // 펼친 계좌 id

  useEffect(() => {
    let alive = true
    setData(null)
    api.getFundStatus({ unit, offset }).then(d => { if (alive) setData(d) })
    return () => { alive = false }
  }, [unit, offset])

  useEffect(() => {
    let alive = true
    setSeries(null)
    api.getFundSeries({ unit }).then(d => { if (alive) setSeries(d) })
    return () => { alive = false }
  }, [unit])

  const st = data ? (STATE[data.state] || STATE.current) : null

  const AccountTable = ({ group, title }) => !group || !group.accounts.length ? null : (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row card-pad" style={{ alignItems: 'baseline', paddingBottom: 10 }}>
        <div className="fw-700">{title}</div>
        <div className="ml-auto text-sm">
          <span className="text-muted2">기간 말 예상</span>{' '}
          <b className="num" style={{ fontSize: 15, color: group.expected < 0 ? 'var(--neg-ink)' : undefined }}>
            {group.expected < 0 ? '−' : ''}{fmtNum(Math.abs(group.expected))}원
          </b>
        </div>
      </div>
      <div className="table-scroll" style={{ overflowX: 'auto' }}>
        <table className="table" style={{ minWidth: 820 }}>
          <thead>
            <tr>
              <th>계좌</th>
              <th className="num-right" style={{ width: 120 }}>현재 잔액</th>
              <th className="num-right" style={{ width: 120 }}>들어온 돈</th>
              <th className="num-right" style={{ width: 120 }}>나간 돈</th>
              <th className="num-right" style={{ width: 120 }}>들어올 돈</th>
              <th className="num-right" style={{ width: 120 }}>나갈 돈</th>
              <th className="num-right" style={{ width: 130 }}>예상 잔액</th>
            </tr>
          </thead>
          <tbody>
            {group.accounts.map(a => (
              <tr key={a.id} style={{ cursor: a.items.length ? 'pointer' : 'default' }}
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
            ))}
            {/* 계좌를 펼치면 그 안의 항목과 날짜 — 엑셀이 열로 늘어놓던 '항목(일자)'다 */}
            {group.accounts.filter(a => open === a.id).map(a => (
              <tr key={`${a.id}-detail`}>
                <td colSpan={7} style={{ background: 'var(--surface-2)', padding: '10px 14px' }}>
                  {a.items.map((it, i) => (
                    <div key={i} className="row text-sm" style={{ padding: '3px 0', gap: 10 }}>
                      <span className="num text-muted2" style={{ width: 92 }}>{it.date}</span>
                      <span className="badge" style={{ fontSize: 10 }}>{it.source}</span>
                      <span>{it.label}</span>
                      {it.overdue && <span className="badge warn" style={{ fontSize: 10 }}>지남</span>}
                      {it.noDue && <span className="badge" style={{ fontSize: 10 }}>기한 미정</span>}
                      <span className="num ml-auto fw-600" style={{ color: it.kind === 'in' ? 'var(--pos-ink)' : 'var(--neg-ink)' }}>
                        {it.kind === 'in' ? '+' : '−'}{fmtNum(it.amount)}
                      </span>
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
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

      {/* 구간 한 눈에 — 엑셀은 시트를 넘겨야 보이던 것 */}
      {series && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <div className="fw-700">한 눈에 보기</div>
            <div className="text-xs text-muted2">어느 구간에 구멍이 나는지 먼저 봅니다. 누르면 그 구간으로 이동해요.</div>
          </div>
          <div className="table-scroll" style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 700 }}>
              <thead>
                <tr>
                  <th style={{ width: 130 }}>구간</th>
                  <th style={{ width: 84 }}>상태</th>
                  <th className="num-right">들어온·올 돈</th>
                  <th className="num-right">나간·갈 돈</th>
                  <th className="num-right" style={{ width: 140 }}>차이</th>
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

          <AccountTable group={data.corp} title="법인 계좌"/>
          {data.personal && <AccountTable group={data.personal} title="대표 개인 계좌"/>}

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
