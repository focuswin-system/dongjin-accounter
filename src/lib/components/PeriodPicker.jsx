import { Icon, DateInput, periodToRange, yearLabel, useFiscalTick } from '../ui'

/**
 * 기간 필터 — **날짜칸 두 개 + 지름길 칩**. 앱 전체가 이것 하나를 쓴다.
 *
 *   📅 [2026-09-01] ~ [2026-09-30]  이번 달 · 지난 달 · 이번 분기 · 올해 · 전체
 *
 * 날짜칸 두 개가 본체다. 칩은 그 값을 채워 주는 지름길일 뿐 — 지금 걸린 범위와 같은 칩은 눌린 채로 보인다
 * (표시가 없으면 기본값 '이번 달'이 걸린 줄 모르고 "왜 몇 건 안 나오지"가 된다).
 *
 * ── 왜 하나로 ──
 * 2026-09-29 까지 두 모양이 섞여 있었다: 이 날짜칸 모양(거래내역·전표 목록)과 드롭다운 선택기
 * (문서 목록·세금계산서·어음·수주). 같은 일을 하는 필터를 화면마다 다시 익혀야 했다.
 * 사용자: "거래내역 쪽 꺼가 더 직관적" — 기간이 늘 펼쳐져 보이고 날짜를 바로 친다. 그래서 이쪽으로 통일.
 *
 * 값은 { from, to } ('YYYY-MM-DD', 비면 전체). onChange({ from, to }).
 * 옛 이름(PeriodPicker)도 남긴다 — 부르는 곳을 흔들지 않으려고.
 */
const PRESETS = [
  { id: 'month',   label: '이번 달' },
  { id: 'last',    label: '지난 달' },
  { id: 'quarter', label: '이번 분기' },
  { id: 'year',    get label() { return yearLabel() } },   // 회기 — 결산월이 12월이 아니면 '이번 회기'
]

export const DateRangeBar = ({ from, to, onChange, all = true }) => {
  useFiscalTick()   // 결산월을 늦게 받아도 '올해/이번 회기' 칩이 따라온다
  return (
    <div className="tbar-date">
      <Icon.Calendar size={14} className="text-muted2"/>
      <DateInput className="input num tbar-dateinput"
        value={from || ''} max={to || undefined}
        onChange={e => onChange({ from: e.target.value, to })}/>
      <span className="text-muted fw-600">~</span>
      <DateInput className="input num tbar-dateinput"
        value={to || ''} min={from || undefined}
        onChange={e => onChange({ from, to: e.target.value })}/>
      <div className="tbar-presets">
        {PRESETS.map(p => {
          const r = periodToRange(p.id)
          const on = from === r.from && to === r.to
          return (
            <button key={p.id} type="button" className={`btn ghost sm${on ? ' active' : ''}`}
              aria-pressed={on} onClick={() => onChange(r)}>{p.label}</button>
          )
        })}
        {all && (
          <button type="button" className={`btn ghost sm${!from && !to ? ' active' : ''}`}
            aria-pressed={!from && !to} onClick={() => onChange({ from: '', to: '' })}>전체</button>
        )}
      </div>
    </div>
  )
}

export const PeriodPicker = DateRangeBar
