import { useState } from 'react'
import { Icon, fmtNum, Spacer } from '../lib/ui'
import { api } from '../lib/api'

/* 경영 도우미 — 절차식 조회.
 * 질문을 QuerySpec(topic·group·period)으로 좁혀 → 검증된 집계(api.getAnalytics) → 요약+차트+그리드.
 * 추후 LLM을 얹으면 "자유 문장 → 이 QuerySpec"으로 앞단만 바뀐다. 설계: docs/02-design/features/mgmt-query-assistant.design.md */

const won = (n) => fmtNum(Math.round(Number(n) || 0)) + '원'
const kstToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

// 기간 프리셋 → {from,to,label} (KST 로컬 달력)
const periodRange = (preset) => {
  const d = new Date(); const y = d.getFullYear(), m = d.getMonth()
  const iso = (yy, mm, dd) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
  if (preset === 'this_month') return { from: iso(y, m + 1, 1), to: kstToday(), label: `${y}년 ${m + 1}월` }
  if (preset === 'this_quarter') { const q = Math.floor(m / 3); return { from: iso(y, q * 3 + 1, 1), to: kstToday(), label: `${y}년 ${q + 1}분기` } }
  if (preset === 'last_12m') { const s = new Date(y, m - 11, 1); return { from: iso(s.getFullYear(), s.getMonth() + 1, 1), to: kstToday(), label: '최근 12개월' } }
  return { from: iso(y, 1, 1), to: iso(y, 12, 31), label: `${y}년` }  // this_year
}

const TOPICS = [{ v: 'sales', label: '매출' }, { v: 'purchase', label: '매입' }]
const GROUPS = [
  { v: 'month', label: '월별 추이', chart: 'line' },
  { v: 'vendor', label: '거래처별', chart: 'bar' },
  { v: 'category', label: '비목별', chart: 'bar' },
  { v: 'contract', label: '계약별', chart: 'bar' },
  { v: 'item', label: '품목별', chart: 'bar' },
]
const PERIODS = [
  { v: 'this_month', label: '이번 달' }, { v: 'this_quarter', label: '이번 분기' },
  { v: 'this_year', label: '올해' }, { v: 'last_12m', label: '최근 12개월' },
]
// 빠른 질문 카드 (한 클릭 → 바로 결과)
const QUICK = [
  { icon: Icon.Trend, title: '올해 매출 추이', sub: '월별로 얼마씩 들어왔나', spec: { topic: 'sales', group: 'month', period: 'this_year' } },
  { icon: Icon.Building, title: '거래처별 매출', sub: '누가 큰 고객인가', spec: { topic: 'sales', group: 'vendor', period: 'this_year' } },
  { icon: Icon.Folder, title: '비목별 지출', sub: '돈이 어디로 나가나', spec: { topic: 'purchase', group: 'category', period: 'this_year' } },
  { icon: Icon.TrendDn, title: '이번 달 매입', sub: '이번 달 나간 돈', spec: { topic: 'purchase', group: 'vendor', period: 'this_month' } },
]

// ── 경량 SVG 차트 ──
const BAR_COLOR = 'var(--brand)'
const BarChart = ({ rows }) => {
  const top = rows.slice(0, 8)
  const max = Math.max(1, ...top.map(r => r.value))
  return (
    <div className="col" style={{ gap: 8, padding: '4px 2px' }}>
      {top.map((r, i) => (
        <div key={i} className="row" style={{ gap: 10, alignItems: 'center' }}>
          <div className="text-sm" style={{ width: 130, minWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>{r.label}</div>
          <div style={{ flex: 1, background: 'var(--surface-2)', borderRadius: 6, height: 22, position: 'relative' }}>
            <div style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, height: '100%', background: BAR_COLOR, borderRadius: 6, transition: 'width .3s' }}/>
          </div>
          <div className="num text-sm fw-600" style={{ width: 120, textAlign: 'right' }}>{won(r.value)}</div>
        </div>
      ))}
    </div>
  )
}
const LineChart = ({ rows }) => {
  const w = 640, h = 200, pad = 34
  if (rows.length === 0) return null
  const max = Math.max(1, ...rows.map(r => r.value))
  const stepX = rows.length > 1 ? (w - pad * 2) / (rows.length - 1) : 0
  const x = (i) => pad + i * stepX
  const y = (v) => h - pad - (v / max) * (h - pad * 2)
  const pts = rows.map((r, i) => `${x(i)},${y(r.value)}`).join(' ')
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ maxWidth: w, minWidth: 320 }}>
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="var(--line)"/>
        <polyline points={pts} fill="none" stroke={BAR_COLOR} strokeWidth="2.5"/>
        {rows.map((r, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(r.value)} r="3.5" fill={BAR_COLOR}/>
            <text x={x(i)} y={h - pad + 16} textAnchor="middle" fontSize="11" fill="var(--muted-2)">{String(r.label).slice(5)}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

export const MgmtAskScreen = () => {
  const [step, setStep] = useState({ topic: '', group: '', period: '' })  // 드릴다운 진행
  const [result, setResult] = useState(null)   // { spec, topicLabel, groupLabel, periodLabel, chart, rows, total }
  const [loading, setLoading] = useState(false)

  const run = async (spec) => {
    setLoading(true)
    const range = periodRange(spec.period)
    const data = await api.getAnalytics({ topic: spec.topic, group: spec.group, from: range.from, to: range.to })
    setLoading(false)
    const g = GROUPS.find(x => x.v === spec.group)
    setResult({
      spec, topicLabel: TOPICS.find(t => t.v === spec.topic)?.label || '',
      groupLabel: g?.label || '', periodLabel: range.label, chart: g?.chart || 'bar',
      rows: data.rows || [], total: data.total || 0,
    })
  }

  const reset = () => { setResult(null); setStep({ topic: '', group: '', period: '' }) }

  // 드릴다운 완료 시 자동 실행
  const pick = (field, v) => {
    const next = { ...step, [field]: v }
    setStep(next)
    if (next.topic && next.group && next.period) run(next)
  }

  // ── 결과 화면 ──
  if (result) {
    const { rows, total, topicLabel, groupLabel, periodLabel, chart } = result
    const top = rows.filter(r => r.key !== 'total').sort((a, b) => b.value - a.value)[0]
    const summary = rows.length === 0
      ? `${periodLabel} ${topicLabel} 데이터가 없어요.`
      : chart === 'line'
        ? `${periodLabel} ${topicLabel}은 총 ${won(total)}예요.` + (top ? ` 가장 많은 달은 ${top.label}(${won(top.value)}).` : '')
        : `${periodLabel} ${topicLabel}은 총 ${won(total)}, ${groupLabel} ${rows.length}건.` + (top ? ` 가장 큰 건 ${top.label}(${won(top.value)}).` : '')
    return (
      <div className="fade-up">
        <div className="row" style={{ marginBottom: 8 }}>
          <div>
            <div className="page-title">경영 도우미</div>
            <div className="page-sub">{topicLabel} · {groupLabel} · {periodLabel}</div>
          </div>
          <button className="btn ml-auto" onClick={reset}><Icon.Left size={14}/> 다른 질문</button>
        </div>
        <Spacer h={16}/>
        <div className="card card-pad" style={{ background: 'var(--brand-soft)', borderColor: 'transparent', marginBottom: 16 }}>
          <div className="row gap-8"><Icon.Sparkle/><span className="fw-600">{summary}</span></div>
        </div>
        {rows.length > 0 && (
          <>
            <div className="card card-pad" style={{ marginBottom: 16 }}>
              {chart === 'line' ? <LineChart rows={rows}/> : <BarChart rows={rows}/>}
            </div>
            <div className="card" style={{ overflow: 'hidden' }}>
              <table className="table">
                <thead><tr><th>{groupLabel}</th><th className="num-right">{result.spec.topic === 'sales' ? '매출' : '매입'}</th><th className="num-right" style={{ width: 90 }}>건수</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}><td className="fw-600">{r.label}</td><td className="num-cell num-right">{won(r.value)}</td><td className="num-cell num-right text-muted">{r.count}건</td></tr>
                  ))}
                  <tr style={{ background: 'var(--surface-2)' }}><td className="fw-700">합계</td><td className="num-cell num-right fw-700">{won(total)}</td><td/></tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    )
  }

  // ── 진입: 빠른 질문 카드 + 직접 좁히기 ──
  return (
    <div className="fade-up">
      <div className="page-title">경영 도우미</div>
      <div className="page-sub">궁금한 걸 골라가면 차트로 답해드려요.</div>
      <Spacer h={20}/>

      <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 10 }}>빠른 질문</div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 28 }}>
        {QUICK.map((q, i) => {
          const IconC = q.icon
          return (
            <button key={i} className="card card-pad col" style={{ gap: 6, alignItems: 'flex-start', cursor: 'pointer', textAlign: 'left' }} onClick={() => run(q.spec)}>
              <IconC size={20}/>
              <div className="fw-700" style={{ marginTop: 4 }}>{q.title}</div>
              <div className="text-sm text-muted">{q.sub}</div>
            </button>
          )
        })}
      </div>

      <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 10 }}>직접 좁혀보기</div>
      <div className="card card-pad col" style={{ gap: 18 }}>
        <Row label="무엇을?">
          {TOPICS.map(t => <Chip key={t.v} on={step.topic === t.v} onClick={() => pick('topic', t.v)}>{t.label}</Chip>)}
        </Row>
        {step.topic && (
          <Row label="어떤 기준으로?">
            {GROUPS.map(g => <Chip key={g.v} on={step.group === g.v} onClick={() => pick('group', g.v)}>{g.label}</Chip>)}
          </Row>
        )}
        {step.topic && step.group && (
          <Row label="언제?">
            {PERIODS.map(p => <Chip key={p.v} on={step.period === p.v} onClick={() => pick('period', p.v)}>{p.label}</Chip>)}
          </Row>
        )}
        {loading && <div className="text-sm text-muted2">불러오는 중…</div>}
      </div>
    </div>
  )
}

const Row = ({ label, children }) => (
  <div>
    <div className="text-sm fw-700" style={{ marginBottom: 8 }}>{label}</div>
    <div className="row gap-6" style={{ flexWrap: 'wrap' }}>{children}</div>
  </div>
)
const Chip = ({ on, onClick, children }) => (
  <button type="button" className={`chip ${on ? 'active' : ''}`} onClick={onClick}>{children}</button>
)
