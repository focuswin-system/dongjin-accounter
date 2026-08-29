import { useState, useEffect } from 'react'
import { Icon, fmtNum } from '../ui'
import { api } from '../api'

/* 홈의 자금 — **이 화면의 주인공**.
 *
 * 예전에는 KPI 숫자 넷만 나란히 떠 있었다. 근거가 없어 숫자가 붕 뜨고, 넷이 같은 무게라
 * 눈이 어디 머물지 정해지지 않았다("밋밋하다"의 실제 원인).
 *
 * 그래서 셋을 한 덩어리로 묶는다.
 *   ① 지금 쓸 수 있는 돈 — 가장 크게. 아침에 이 숫자 하나 보러 온다.
 *   ② 앞으로 6주 잔액 — 그 숫자가 **어디로 가는지**. 홈에 어울리는 건 지나간 흐름이 아니라
 *      앞으로다("다음 달 15일쯤 바닥나겠는데"가 행동을 만드는 질문이다).
 *   ③ 들어올 돈 · 나갈 돈 — 그 선이 왜 그렇게 움직이는지의 근거.
 *
 * ⚠ 용어의 기준을 하나로 맞춘다. 예전엔 '지금'과 '이번 주'가 섞여 있었고, 넷째(최저 잔액)만
 *   혼자 예측이라 성격이 달랐다. 최저점은 이제 **차트가 말한다** — 숫자로 또 적지 않는다.
 *
 * ⚠ 데이터는 이미 있는 자금일보를 그대로 쓴다(/dashboard/cash-report). 홈 전용 집계를
 *   새로 만들면 같은 질문에 두 답이 생긴다.
 */
const WEEKS = 6
const DAYS = WEEKS * 7

const md = (s) => { const [, m, d] = String(s).split('-'); return `${Number(m)}/${Number(d)}` }
/** 억/만 단위로 줄여 읽는다 — 축 옆에 314,194,945 를 적으면 숫자를 읽느라 모양을 못 본다 */
const short = (n) => {
  const v = Math.abs(n)
  if (v >= 100000000) return `${(n / 100000000).toFixed(1)}억`
  if (v >= 10000) return `${Math.round(n / 10000).toLocaleString('ko-KR')}만`
  return n.toLocaleString('ko-KR')
}

/** 예측선 — 흐름이 있는 날만 점이 된다(계산이 그렇게 되어 있다). 그 사이는 잔액이 그대로다. */
const Sparkline = ({ from, start, days, height = 96 }) => {
  const pts = [{ date: from, balance: start }, ...days.map(d => ({ date: d.date, balance: d.balance }))]
  if (pts.length < 2) return null

  const xs = pts.map(p => new Date(`${p.date}T00:00:00Z`).getTime())
  const x0 = xs[0], x1 = xs[xs.length - 1] || x0 + 1
  const span = Math.max(1, x1 - x0)
  const vals = pts.map(p => p.balance)
  /* 눈금은 **데이터 범위**에 맞춘다.
     한때 0 을 무조건 눈금에 넣었는데("0 은 넘으면 안 되는 선"), 잔액이 3억이면 0 이 너무 멀어
     선이 맨 위에 딱 붙어 **아무 변화도 안 보였다**. 위험선이 필요한 경우는 실제로 0 아래로
     내려갈 때뿐이고, 그때는 0 이 범위 안에 저절로 들어온다. */
  const dataHi = Math.max(...vals)
  const dataLo = Math.min(...vals)
  const padV = Math.max(1, (dataHi - dataLo) * 0.18)   // 위아래 여백 — 선이 테두리에 닿지 않게
  const hi = dataHi + padV
  const lo = Math.min(dataLo - padV, dataLo < 0 ? 0 : dataLo - padV)
  const range = Math.max(1, hi - lo)
  const W = 100, pad = 4
  const px = (t) => ((t - x0) / span) * W
  const py = (v) => pad + (1 - (v - lo) / range) * (height - pad * 2)

  // 계단선 — 잔액은 흐름이 있는 날에만 움직인다. 직선으로 이으면 없던 변화를 그리는 셈이다.
  let d = `M ${px(xs[0])} ${py(vals[0])}`
  for (let i = 1; i < pts.length; i++) d += ` L ${px(xs[i])} ${py(vals[i - 1])} L ${px(xs[i])} ${py(vals[i])}`
  const area = `${d} L ${px(xs[xs.length - 1])} ${py(lo)} L ${px(xs[0])} ${py(lo)} Z`

  const lowIdx = vals.indexOf(dataLo)
  const zeroY = py(0)
  const negative = dataLo < 0

  /* 눈금과 라벨이 없으면 **무슨 선인지 알 수 없다**(실제로 "뭔 의미인지 모르겠다"는 말이 나왔다).
     축 텍스트는 SVG 밖 HTML 로 그린다 — preserveAspectRatio="none" 로 가로를 늘리면
     SVG 안의 글자도 함께 늘어나 찌그러진다. */
  const lowPct = (px(xs[lowIdx]) / W) * 100

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none"
          style={{ width: '100%', height, display: 'block' }}>
          <defs>
            <linearGradient id="cashFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ink)" stopOpacity="0.12"/>
              <stop offset="100%" stopColor="var(--ink)" stopOpacity="0"/>
            </linearGradient>
          </defs>
          {/* 가장 낮은 값의 가로선 — 점 하나만 찍어두면 그 점이 무슨 높이인지 알 수 없다 */}
          <line x1="0" y1={py(dataLo)} x2={W} y2={py(dataLo)}
            stroke="var(--line-strong)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke"/>
          {/* 0 선 — 아래로 내려가면 돈이 마른다는 뜻이라 다른 눈금과 구분한다 */}
          {negative && (
            <line x1="0" y1={zeroY} x2={W} y2={zeroY}
              stroke="var(--neg)" strokeWidth="1" strokeDasharray="2 2" vectorEffect="non-scaling-stroke"/>
          )}
          <path d={area} fill="url(#cashFill)"/>
          <path d={d} fill="none" stroke="var(--ink)" strokeWidth="1.8"
            strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
          <circle cx={px(xs[0])} cy={py(vals[0])} r="3" fill="var(--ink)" vectorEffect="non-scaling-stroke"/>
          <circle cx={px(xs[lowIdx])} cy={py(vals[lowIdx])} r="3.5"
            fill="#fff" stroke={vals[lowIdx] < 0 ? 'var(--neg)' : 'var(--ink)'} strokeWidth="2"
            vectorEffect="non-scaling-stroke"/>
        </svg>
        {/* 가장 낮은 지점 라벨 — 선 위에 올려 어느 날 얼마인지 바로 읽히게 */}
        <div className="cash-lowtag" style={{
          left: `${Math.min(88, Math.max(4, lowPct))}%`,
          top: `${(py(dataLo) / height) * 100}%`,
        }}>{short(dataLo)}</div>
      </div>
      {/* 가로축 — 오늘부터 언제까지인지 */}
      <div className="cash-axis">
        <span>오늘 {md(from)}</span>
        <span>{md(pts[pts.length - 1].date)}</span>
      </div>
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
          <div className="text-xs text-muted2">통장 {d.accounts?.filter(a => a.kind !== 'card').length ?? 0}개</div>

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
          {/* 그림이 무엇인지 **먼저** 말한다. 선만 그려두면 무슨 뜻인지 알 수 없다. */}
          <div style={{ marginBottom: 8 }}>
            <div className="text-xs text-muted2">
              앞으로 {WEEKS}주, 통장 잔액이 이렇게 움직입니다
            </div>
            <div className="text-sm" style={{ marginTop: 2, color: negative ? 'var(--neg-ink)' : 'var(--ink)' }}>
              {lowIsToday
                ? '오늘이 가장 낮아요'
                : <>가장 낮은 날 <b className="num">{low.date}</b> · <b className="num">{fmtNum(low.balance)}원</b></>}
            </div>
          </div>
          <Sparkline from={d.date} start={d.available} days={f.days || []}/>
          {/* 마이너스로 내려가는 건 이 화면이 잡아야 할 유일한 경고다 */}
          {negative && (
            <div className="text-sm" style={{ color: 'var(--neg-ink)', marginTop: 8 }}>
              이대로면 <b>{low.date}</b>에 잔액이 마이너스가 됩니다.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
