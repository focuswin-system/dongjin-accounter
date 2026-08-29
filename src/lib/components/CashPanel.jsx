import { useState, useEffect } from 'react'
import { Icon, fmtNum } from '../ui'
import { api } from '../api'

/* 홈의 자금 — **이 화면의 주인공**.
 *
 * 예전에는 KPI 숫자 넷만 나란히 떠 있었다. 근거가 없어 숫자가 붕 뜨고, 넷이 같은 무게라
 * 눈이 어디 머물지 정해지지 않았다("밋밋하다"의 실제 원인).
 *
 * 그래서 한 덩어리로 묶는다.
 *   왼쪽  지금 쓸 수 있는 돈 — 가장 크게. 아침에 이 숫자 하나 보러 온다
 *   오른쪽 앞으로 6주, 주별로 들어올 돈·나갈 돈과 그 결과 잔액
 *
 * ⚠ 집계는 이미 있는 자금일보를 그대로 쓴다(/dashboard/cash-report).
 *   홈 전용 집계를 새로 만들면 같은 질문에 두 답이 생긴다.
 */
const WEEKS = 6
const DAYS = WEEKS * 7

const kstOf = (ms) => new Date(ms).toISOString().slice(0, 10)
const md = (s) => { const [, m, d] = String(s).split('-'); return `${Number(m)}/${Number(d)}` }
/** 억·만 단위로 줄여 읽는다 — 축 옆에 314,194,945 를 적으면 숫자를 읽느라 모양을 못 본다 */
const short = (n) => {
  const v = Math.abs(n)
  if (v >= 100000000) return `${(n / 100000000).toFixed(1)}억`
  if (v >= 10000) return `${Math.round(n / 10000).toLocaleString('ko-KR')}만`
  return n.toLocaleString('ko-KR')
}

/* 주별 자금 융통 — **막대**로 그린다.
 *
 * 처음엔 잔액 스파크라인(선 + 최저점 동그라미)으로 그렸는데, 그건 대시보드 디자인의
 * 관용구지 **자금 차트의 표현이 아니다.** 회계에서 자금 융통은 기간별로 들어온 돈과
 * 나간 돈을 나란히 세워 보고, 잔액은 그 결과로 읽는다.
 * "선 하나가 움직이다 중간에 동그라미는 뭐냐"는 말이 나왔다 — 읽는 법을 따로 배워야 하는
 * 그림은 잘못 그린 그림이다.
 *
 * 한 주에 막대 둘(들어올 돈·나갈 돈), 그 아래 주 시작일과 그 주가 끝났을 때의 잔액.
 * 눈금을 둘 쓰지 않는다 — 막대는 금액, 선은 잔액 식으로 겹치면 어느 눈금인지 알 수 없다.
 * SVG 를 쓰지 않는 이유도 같다. 막대는 높이 비율이면 충분하고, HTML 이면 글자가 안 찌그러진다.
 */
const WeekFlow = ({ from, start, days, weeks }) => {
  const day0 = new Date(`${from}T00:00:00Z`).getTime()
  const week = 7 * 86400000
  const buckets = Array.from({ length: weeks }, (_, i) => ({
    i, at: day0 + i * week, in: 0, out: 0, balance: start,
  }))
  for (const d of days) {
    const t = new Date(`${d.date}T00:00:00Z`).getTime()
    const idx = Math.min(weeks - 1, Math.max(0, Math.floor((t - day0) / week)))
    buckets[idx].in += d.inSure || 0
    buckets[idx].out += d.outSure || 0
  }
  let bal = start
  for (const b of buckets) { bal = bal + b.in - b.out; b.balance = bal }

  // 막대 높이는 그 기간 안에서 가장 큰 금액을 기준으로 잡는다(회사마다 자릿수가 다르다)
  const peak = Math.max(1, ...buckets.map(b => Math.max(b.in, b.out)))
  const lowest = Math.min(...buckets.map(b => b.balance))

  return (
    <div className="wf">
      {buckets.map(b => {
        const worst = b.balance === lowest
        return (
          <div key={b.i} className="wf-col">
            <div className="wf-bars">
              <div className="wf-bar wf-in" style={{ height: `${(b.in / peak) * 100}%` }}
                title={`들어올 돈 ${fmtNum(b.in)}원`}/>
              <div className="wf-bar wf-out" style={{ height: `${(b.out / peak) * 100}%` }}
                title={`나갈 돈 ${fmtNum(b.out)}원`}/>
            </div>
            <div className="wf-week">{md(kstOf(b.at))}</div>
            <div className={`wf-bal${worst ? ' worst' : ''}`}>{short(b.balance)}</div>
          </div>
        )
      })}
    </div>
  )
}

export const CashPanel = ({ go }) => {
  const [d, setD] = useState(null)
  useEffect(() => { api.getCashReport({ days: DAYS }).then(setD).catch(() => {}) }, [])
  if (!d) return null

  const f = d.forecast || {}
  const low = f.lowest || { date: d.date, balance: d.available }
  const negative = low.balance < 0
  const lowIsToday = low.date === d.date

  return (
    <div style={{ marginBottom: 24 }}>
      <div className="row" style={{ marginBottom: 10, padding: '0 2px', alignItems: 'center' }}>
        <div className="text-xs fw-700" style={{ color: 'var(--muted-2)', letterSpacing: '0.02em' }}>자금</div>
        <button className="btn ghost sm ml-auto" onClick={() => go('cash_report')}>
          자금일보 <Icon.Right size={12}/>
        </button>
      </div>

      <div className="card cash-panel">
        {/* 왼쪽 — 지금. 오른쪽 — 앞으로. 한 카드 안에서 시선이 왼→오로 흐른다 */}
        <div className="cash-now">
          <div className="text-xs text-muted2">지금 쓸 수 있는 돈</div>
          <div className="cash-big num">
            {fmtNum(d.available)}<span className="cash-won">원</span>
          </div>
          {/* ⚠ 금액(available)과 **같은 집합**을 센다. available 은 개인 계좌를 빼는데
              건수만 다 세면 "통장 5개"인데 그중 셋만 더해진 숫자가 된다.
              서버가 available 을 만든 기준을 그대로 쓴다(accountCount). */}
          <div className="text-xs text-muted2">통장 {d.accountCount ?? 0}개</div>

          <div className="cash-flows">
            <div>
              <div className="text-xs text-muted2">{WEEKS}주간 들어올 돈</div>
              <div className="num fw-700" style={{ color: 'var(--pos-ink)' }}>{fmtNum(f.totalIn || 0)}</div>
              {f.uncertainIn > 0 && (
                <div className="text-xs text-muted2">기약 없는 {fmtNum(f.uncertainIn)}원은 뺐어요</div>
              )}
            </div>
            <div>
              <div className="text-xs text-muted2">{WEEKS}주간 나갈 돈</div>
              <div className="num fw-700" style={{ color: 'var(--neg-ink)' }}>{fmtNum(f.totalOut || 0)}</div>
              {f.uncertainOut > 0 && (
                <div className="text-xs text-muted2">그중 {fmtNum(f.uncertainOut)}원은 기한 미정</div>
              )}
            </div>
          </div>
        </div>

        <div className="cash-chart">
          {/* 그림이 무엇인지 **먼저** 말한다. 범례도 함께 — 색만 보고 알아맞히게 하지 않는다. */}
          <div className="row" style={{ alignItems: 'baseline', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <div className="text-xs text-muted2">주별 자금 융통</div>
            <div className="row gap-10 ml-auto text-xs text-muted2" style={{ alignItems: 'center' }}>
              <span className="wf-key"><i className="wf-dot wf-in"/> 들어올 돈</span>
              <span className="wf-key"><i className="wf-dot wf-out"/> 나갈 돈</span>
            </div>
          </div>

          <WeekFlow from={d.date} start={d.available} days={f.days || []} weeks={WEEKS}/>

          <div className="text-sm" style={{ marginTop: 10, color: negative ? 'var(--neg-ink)' : 'var(--muted)' }}>
            {negative
              ? <><b>{low.date}</b>에 잔액이 마이너스가 됩니다.</>
              : lowIsToday
                ? '앞으로 6주 동안 잔액이 지금보다 낮아지지 않습니다.'
                : <>가장 낮은 날은 <b>{low.date}</b>, <b className="num">{fmtNum(low.balance)}원</b>입니다.</>}
          </div>
        </div>
      </div>
    </div>
  )
}
