/**
 * 로그인 세션 상태 — **화면을 그리기 전에** 토큰이 살아 있는지 본다.
 *
 * ── 왜 필요한가 ──
 * 예전에는 앱이 `localStorage.loggedIn === '1'` 하나만 보고 로그인 상태를 정했다.
 * 토큰이 만료됐는지는 보지 않았다. 그래서 어제 쓰던 브라우저를 아침에 열면:
 *
 *   1. 만료된 토큰인데도 앱 화면을 전부 그린다
 *   2. 그 죽은 토큰으로 API 요청 십수 개를 한꺼번에 쏜다
 *   3. 401이 돌아오면 세션을 지우고 새로고침 → 로그인 화면
 *   4. 사용자에게는 "들어갔다가 다시 튕겨나왔다"로 보인다
 *   5. 그 사이 느린 요청이 늦게 401로 돌아와 새로 받은 토큰까지 지우기도 한다
 *
 * 즉 **매일 아침 한 번씩 재현되는 문제**였다. 근본 해결은 간단하다 —
 * 죽은 토큰이면 애초에 앱을 그리지 않고 바로 로그인 화면을 보여준다.
 *
 * 여기서 하는 만료 판정은 **화면 결정용**이다. 보안 판정이 아니다.
 * 서명은 서버만 검증할 수 있고(비밀키가 서버에 있다), 실제 차단도 서버가 한다.
 * 클라이언트는 "이 토큰으로는 어차피 안 된다"를 미리 알아 헛수고를 줄일 뿐이다.
 */

/** JWT payload 를 서명 검증 없이 꺼낸다. 못 읽으면 null (형식이 깨진 토큰) */
export function decodeToken(token) {
  try {
    const part = String(token).split('.')[1]
    if (!part) return null
    // base64url → base64. atob 는 표준 base64만 받는다.
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const json = decodeURIComponent(
      atob(b64).split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    )
    return JSON.parse(json)
  } catch { return null }
}

/**
 * 지금 이 토큰으로 요청을 보내볼 가치가 있는가.
 *
 * 시계가 조금 어긋나도 멀쩡한 세션을 죽이지 않도록 30초 여유를 둔다.
 * 반대로 만료 직전(30초 미만)이면 어차피 곧 죽으므로 미리 로그인 화면으로 보낸다 —
 * 작업 도중에 튕기는 것보다 시작 전에 다시 로그인하는 편이 낫다.
 */
export function tokenAlive(token, nowMs = Date.now()) {
  if (!token) return false
  const claims = decodeToken(token)
  if (!claims || !claims.exp) return false      // exp 없는 토큰은 우리 것이 아니다
  return claims.exp * 1000 - nowMs > 30_000
}

/** 저장된 세션이 아직 쓸 만한가 — App 이 첫 렌더에서 이걸로 판단한다 */
export const sessionAlive = () =>
  localStorage.getItem('loggedIn') === '1' && tokenAlive(localStorage.getItem('token'))

/** 세션 흔적을 지운다. 지우는 항목이 흩어져 있으면 하나씩 빠뜨린다. */
export function clearSession() {
  localStorage.removeItem('token')
  localStorage.removeItem('loggedIn')
  localStorage.removeItem('user')
}

/**
 * 앱이 뜨기 전에 한 번 — 죽은 세션이면 흔적을 지운다.
 * 이걸 안 하면 죽은 토큰이 남아 첫 요청 묶음이 전부 401을 받는다.
 * @returns {boolean} 지웠으면 true
 */
export function pruneDeadSession() {
  const token = localStorage.getItem('token')
  const flagged = localStorage.getItem('loggedIn') === '1'
  if (!flagged && !token) return false
  if (tokenAlive(token)) return false
  clearSession()
  return true
}
