import { usePerms } from '../perms'

/**
 * 다른 화면으로 보내는 버튼 — **거기서 할 수 있을 때만** 버튼, 아니면 누구에게 부탁할지 안내.
 *
 * 왜 — "기준정보 › 카드에서 결제일을 정하세요 [가기]"를 권한 없는 사람이 누르면
 *   '볼 권한이 없어요' 화면으로 넘어가 막힌다(누르고 나서야 막다른 길인 걸 안다).
 *   화면마다 권한을 따로 보면 또 빠뜨린다 — 실제로 다섯 곳이 안 보고 있었다(2026-09-30).
 *
 * @param route   가는 곳(nav 잎 id). 권한 이름과 같다(settings_* 는 settings 로 풀린다 — lib/perms resourceOf)
 * @param action  거기서 할 일 — 'view'(보기) · 'edit'(고치기) · 'create'(등록). 기본 view
 * @param go      화면 이동 함수(goRoute). 없으면 버튼을 그리지 않는다
 * @param ask     권한이 없을 때의 안내. 문자열이면 그 말, null 이면 **아무것도 안 그린다**
 *                (부제 옆 작은 링크처럼 안내가 오히려 시끄러운 자리)
 * @param label   기본 안내에 넣을 곳 이름(예: '기준정보(카드)')
 */
export const GoOrAsk = ({ route, action = 'view', go, ask, label, className = 'btn sm', style, askStyle, children }) => {
  const { can } = usePerms()
  if (go && can(route, action)) {
    return <button type="button" className={className} style={style} onClick={() => go(route)}>{children}</button>
  }
  if (ask === null) return null
  return (
    <span className="text-xs text-muted2" style={askStyle ?? style}>
      {ask || `${label || '해당 화면'} 권한이 있는 담당자에게 요청해 주세요.`}
    </span>
  )
}
