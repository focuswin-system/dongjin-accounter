import { useState, useRef, useEffect } from 'react'
import { Icon, localToday } from '../ui'

/**
 * 기간 선택기 — **드릴다운**. "달을 누르면 달이, 년을 누르면 년이 나온다."
 *
 * ── 왜 프리셋만으로는 부족한가 ──
 * 여태는 `이번 달 · 지난 달 · 이번 분기 · 올해 · 전체` 버튼뿐이었다. 그래서 "3월 것만
 * 보고 싶다"를 하려면 날짜 인풋 두 개를 직접 찍어야 했다. 경리 업무는 **지난 달들을
 * 되짚는 일**이 잦은데(부가세 신고·정산·대사), 그때마다 달력을 두 번 여는 셈이었다.
 *
 * 게다가 그 인풋은 브라우저 기본 날짜 위젯이라 생김새와 동작이 제각각이다 —
 * 고정자산 제조일자에서 Firefox 가 `type="month"` 를 그냥 텍스트 칸으로 떨어뜨려
 * 입력이 조용히 버려지던 것과 같은 표면이다.
 *
 * ── 미래를 보여주지 않는다 ──
 * 거래는 미래 날짜로 등록할 수 없다(서버 futureDateError). 앞으로 올 달·년을 골라 봐야
 * 늘 빈 표라, 고를 수 있게 두면 "왜 아무것도 없지"만 남는다. 올해·이번 달까지만 연다.
 *
 * ── 값은 여전히 {from, to} ──
 * 바깥에서 보면 지금과 똑같은 범위 값이다. 그래서 이 컴포넌트만 갈아 끼우면 되고,
 * 표·필터·집계 쪽은 아무것도 안 바뀐다.
 */

const MONTHS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월']
const QUARTERS = [
  { id: 1, label: '1분기', months: [1, 3] },
  { id: 2, label: '2분기', months: [4, 6] },
  { id: 3, label: '3분기', months: [7, 9] },
  { id: 4, label: '4분기', months: [10, 12] },
]
/** 과거 몇 해까지 열어둘지 — 올해 포함 4개. 그보다 옛 자료는 기간 지정으로 찍는다. */
const YEARS_BACK = 3

const pad = (n) => String(n).padStart(2, '0')
const lastDay = (y, m) => new Date(y, m, 0).getDate()
const monthRange = (y, m) => ({ from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` })
const quarterRange = (y, q) => {
  const [a, b] = QUARTERS.find(x => x.id === q).months
  return { from: `${y}-${pad(a)}-01`, to: `${y}-${pad(b)}-${pad(lastDay(y, b))}` }
}
const yearRange = (y) => ({ from: `${y}-01-01`, to: `${y}-12-31` })
const same = (a, b) => a.from === b.from && a.to === b.to

/** 지금 걸린 범위가 어떤 모양인지 되짚는다 — 열었을 때 그 자리를 보여주려고 */
function describe(from, to) {
  if (!from && !to) return { mode: 'all' }
  const y = Number(String(from).slice(0, 4))
  if (!y) return { mode: 'custom' }
  const r = { from, to }
  if (same(r, yearRange(y))) return { mode: 'year', year: y }
  for (const q of QUARTERS) if (same(r, quarterRange(y, q.id))) return { mode: 'quarter', year: y, quarter: q.id }
  for (let m = 1; m <= 12; m++) if (same(r, monthRange(y, m))) return { mode: 'month', year: y, month: m }
  return { mode: 'custom' }
}

export const PeriodPicker = ({ from, to, onChange }) => {
  const today = localToday()
  const thisYear = Number(today.slice(0, 4))
  const thisMonth = Number(today.slice(5, 7))

  const cur = describe(from, to)
  const [open, setOpen] = useState(false)
  // 어느 탭을 펼쳐 뒀나. 지금 값이 달이면 '달'로 열린다 — 방금 고른 자리에서 이어서 고르게.
  const [tab, setTab] = useState(cur.mode === 'quarter' ? 'quarter' : cur.mode === 'year' ? 'year' : 'month')
  const [year, setYear] = useState(cur.year || thisYear)
  const boxRef = useRef(null)

  // 바깥을 누르면 닫는다. 안 그러면 표를 누르려다 매번 이 패널을 먼저 닫아야 한다.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const label = cur.mode === 'all' ? '전체 기간'
    : cur.mode === 'year' ? `${cur.year}년`
    : cur.mode === 'quarter' ? `${cur.year}년 ${cur.quarter}분기`
    : cur.mode === 'month' ? `${cur.year}년 ${cur.month}월`
    : `${from || '처음'} ~ ${to || '오늘'}`

  const pick = (range) => { onChange(range); setOpen(false) }

  const years = Array.from({ length: YEARS_BACK + 1 }, (_, i) => thisYear - YEARS_BACK + i)
  // 올해를 보고 있으면 아직 안 온 달은 못 고른다(늘 빈 표라 고를 이유가 없다)
  const monthDisabled = (m) => year > thisYear || (year === thisYear && m > thisMonth)
  const quarterDisabled = (q) => year > thisYear
    || (year === thisYear && QUARTERS.find(x => x.id === q).months[0] > thisMonth)

  return (
    <div className="period-picker" ref={boxRef}>
      <button type="button" className="btn ghost sm period-trigger"
        aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Icon.Calendar size={14}/> {label} <Icon.Down size={12}/>
      </button>

      {open && (
        <div className="period-pop" role="dialog" aria-label="기간 선택">
          <div className="row gap-4 period-tabs">
            {[['month', '달'], ['quarter', '분기'], ['year', '년']].map(([id, l]) => (
              <button key={id} type="button" className={`chip ${tab === id ? 'active' : ''}`}
                onClick={() => setTab(id)}>{l}</button>
            ))}
            <button type="button" className={`chip ml-auto ${cur.mode === 'all' ? 'active' : ''}`}
              onClick={() => pick({ from: '', to: '' })}>전체</button>
          </div>

          {tab !== 'year' && (
            <div className="row period-year">
              <button type="button" className="icon-btn" aria-label="이전 해"
                onClick={() => setYear(y => Math.max(y - 1, thisYear - YEARS_BACK))}
                disabled={year <= thisYear - YEARS_BACK}><Icon.Left size={14}/></button>
              <span className="fw-700 num">{year}</span>
              <button type="button" className="icon-btn" aria-label="다음 해"
                onClick={() => setYear(y => Math.min(y + 1, thisYear))}
                disabled={year >= thisYear}><Icon.Right size={14}/></button>
            </div>
          )}

          {tab === 'month' && (
            <div className="period-grid">
              {MONTHS.map((m, i) => {
                const n = i + 1
                const on = cur.mode === 'month' && cur.year === year && cur.month === n
                return (
                  <button key={m} type="button" disabled={monthDisabled(n)}
                    className={`period-cell${on ? ' active' : ''}`}
                    onClick={() => pick(monthRange(year, n))}>{m}</button>
                )
              })}
            </div>
          )}

          {tab === 'quarter' && (
            <div className="period-grid period-grid-2">
              {QUARTERS.map(q => {
                const on = cur.mode === 'quarter' && cur.year === year && cur.quarter === q.id
                return (
                  <button key={q.id} type="button" disabled={quarterDisabled(q.id)}
                    className={`period-cell${on ? ' active' : ''}`}
                    onClick={() => pick(quarterRange(year, q.id))}>{q.label}</button>
                )
              })}
            </div>
          )}

          {tab === 'year' && (
            <div className="period-grid period-grid-2">
              {years.map(y => (
                <button key={y} type="button"
                  className={`period-cell${cur.mode === 'year' && cur.year === y ? ' active' : ''}`}
                  onClick={() => pick(yearRange(y))}>{y}년</button>
              ))}
            </div>
          )}

          {/* 그 밖의 기간은 직접 찍는다. 자주 쓰는 길이 아니라 아래에 작게 둔다. */}
          <div className="period-custom">
            <span className="text-xs text-muted2">직접 지정</span>
            <input type="date" className="input num" value={from || ''} max={to || undefined}
              onChange={e => onChange({ from: e.target.value, to })}/>
            <span className="text-muted">~</span>
            <input type="date" className="input num" value={to || ''} min={from || undefined}
              onChange={e => onChange({ from, to: e.target.value })}/>
          </div>
        </div>
      )}
    </div>
  )
}
