import { fmtNum } from '../ui'

// 화면 상단 지표 카드(KPI) 단일 정의.
//
// 원래 정의가 3벌이었다 — Docs.StatCard({label,value,unit,tone}) / Tax.StatCard({label,amount,tone,hint})
// / Home.MiniStat({label,value,sub,tone}). prop 이름이 서로 달라서 한 화면의 카드를 다른 화면에
// 복사하면 에러 없이 빈 칸이 렌더됐다(value ↔ amount). 그래서 이름을 하나로 못박는다.
//
// props
//   label     지표 이름
//   value     숫자면 fmtNum + unit 을 붙이고, 문자열이면 그대로 쓴다(이미 포맷된 값)
//   unit      숫자일 때만 값 뒤에 붙는 단위. 단위를 안 붙이려면 unit=""
//   tone      숫자 색 (CSS 변수명: pos·neg·warn·brand·ink·muted·neg-ink·warn-ink). 없으면 기본 잉크색
//   badge     오른쪽 위 뱃지 문구(보조 설명·건수). 없으면 뱃지 자체를 그리지 않는다
//   badgeTone 뱃지 색 (brand·pos·warn·neg·ink). 기본 ink 는 외곽선 뱃지
//   hint      값 아래 작은 보조 문구
export const Kpi = ({ label, value, unit = '원', tone, badge, badgeTone = 'ink', hint }) => {
  const isNum = typeof value === 'number'
  return (
    <div className="card card-pad" style={{ minWidth: 0 }}>
      <div className="row gap-8" style={{ marginBottom: 6 }}>
        <span className="text-sm text-muted fw-600" style={{ whiteSpace: 'nowrap' }}>{label}</span>
        {badge && (
          <span className={`badge ${badgeTone === 'ink' ? 'outline' : badgeTone}`} style={{ marginLeft: 'auto' }}>{badge}</span>
        )}
      </div>
      <div className={`${isNum ? 'num ' : ''}fw-700`}
        style={{ fontSize: 22, letterSpacing: '-0.02em', whiteSpace: 'nowrap', color: tone ? `var(--${tone})` : undefined }}>
        {/* 음수는 하이픈(-)이 아니라 진짜 빼기표(−)로 — 숫자 폰트에서 하이픈은 너무 짧아 잘 안 보인다 */}
        {isNum ? (value < 0 ? '−' + fmtNum(Math.abs(value)) : fmtNum(value)) : value}
        {isNum && unit && (
          <span className="text-muted" style={{ fontSize: 13, fontWeight: 400, marginLeft: 3 }}>{unit}</span>
        )}
      </div>
      {hint && <div className="text-xs text-muted2" style={{ marginTop: 6 }}>{hint}</div>}
    </div>
  )
}

// KPI 카드를 나란히 놓는 줄. 화면마다 grid 스타일을 손으로 적던 걸 한 곳으로 모은다.
// 열 수와 접힘은 index.css `.kpi-row[data-cols]` 가 전부 정한다(1~5열).
// 여기서 gridTemplateColumns 를 인라인으로 주면 media 규칙을 덮어써서 좁은 화면에서 금액이 잘린다.
export const KpiRow = ({ cols = 4, gap = 12, children, style }) => (
  <div className="kpi-row" data-cols={cols} style={{ gap, ...style }}>
    {children}
  </div>
)
