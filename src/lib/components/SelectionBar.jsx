import { Icon } from '../ui'

/* 고른 것 바 — 표에서 여러 줄을 고르면 화면 **아래에 떠서** 따라다닌다.
 *
 * 왜 — 버튼을 표 위에 두면 목록이 길 때 스크롤과 함께 사라진다. 40줄을 고르고 나서
 *   [만들기]를 찾으러 맨 위로 다시 올라가야 했다(2026-10-01 사용자 · 반복거래 40건 시험).
 *   떠 있으면 몇 줄을 고르든 같은 자리에 있다.
 *
 * 쓰는 법 — 고른 게 없으면 아무것도 그리지 않는다.
 *   <SelectionBar count={n} summary="38,548,400원" onClear={...}>
 *     <button className="btn primary">선택한 n건 만들기</button>
 *   </SelectionBar>
 * 바가 표 마지막 줄을 가리지 않게 자리를 하나 남긴다(sel-bar-spacer) — 그래서 **목록 맨 끝**에 둔다.
 */
export const SelectionBar = ({ count, summary, onClear, children }) => {
  if (!count) return null
  return (
    <>
      <div className="sel-bar-spacer" aria-hidden="true"/>
      <div className="sel-bar no-print" role="region" aria-label="고른 항목">
        <span className="fw-700 text-sm num">{count.toLocaleString()}건 선택</span>
        {summary != null && <span className="text-sm text-muted num">{summary}</span>}
        {onClear && (
          <button type="button" className="btn ghost sm" onClick={onClear}>
            <Icon.Close size={12}/> 선택 해제
          </button>
        )}
        <div className="row gap-6" style={{ marginLeft: 8 }}>{children}</div>
      </div>
    </>
  )
}
