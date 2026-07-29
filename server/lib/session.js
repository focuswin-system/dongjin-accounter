/**
 * 로그인 세션 수명 — 발급과 갱신을 한곳에서 정한다.
 *
 * ── 왜 필요한가 ──
 * 토큰 수명이 8시간 고정이었고 쓰는 중에도 늘어나지 않았다. 09:00에 로그인하면
 * 17:00에 만료된다 — 점심 포함 9시간 근무보다 짧다. 그래서 **매일 오후 한 번은
 * 반드시 튕겼고**, 그때 프런트는 401을 받고 곧바로 새로고침해 작성 중이던 거래
 * 입력 내용까지 함께 날렸다. 로그인 시각이 매일 조금씩 달라 "종종 갑자기"처럼 보였다.
 *
 * 두 가지로 고친다.
 *   1) 기본 수명을 근무일보다 길게(12시간)
 *   2) 쓰는 동안에는 만료가 다가오면 조용히 새 토큰으로 갈아끼운다(슬라이딩)
 *
 * ⚠ 슬라이딩만 두면 토큰이 영원히 살아난다 — 한 번 유출되면 회수 수단이 없다.
 *   그래서 '최초 로그인 시각'을 토큰에 박아두고(loginAt), 거기서 24시간이 지나면
 *   더 갱신하지 않는다. 계속 일하는 사람도 하루에 한 번은 다시 로그인한다.
 *   (자리를 비운 사이 만료되는 것은 정상 동작이다 — 그건 막지 않는다.)
 */
const jwt = require('jsonwebtoken')

const SESSION_HOURS = 12        // 한 번 발급된 토큰이 사는 시간
const RENEW_WITHIN_MIN = 60     // 만료가 이만큼 남으면 갱신한다
const ABSOLUTE_MAX_HOURS = 24   // 최초 로그인으로부터 이만큼 지나면 더는 갱신하지 않는다

const nowSec = () => Math.floor(Date.now() / 1000)

/**
 * 세션 토큰 발급. loginAt 이 없으면 지금을 최초 로그인 시각으로 본다.
 * 갱신 때는 원래 loginAt 을 그대로 물려주어야 절대 상한이 밀리지 않는다.
 */
function signSession(claims, now = nowSec()) {
  const { iat, exp, ...rest } = claims
  // iat·exp 를 직접 계산한다(expiresIn 옵션 대신). 그래야 now 주입이 만료 시각까지
  // 온전히 적용돼 테스트가 실제 시계에 흔들리지 않는다. 운영에서는 now = 현재이므로 동일하다.
  return jwt.sign(
    {
      ...rest,
      loginAt: Number(claims.loginAt) || now,
      iat: now,
      exp: now + SESSION_HOURS * 3600,
    },
    process.env.JWT_SECRET
  )
}

/**
 * 지금 갱신해줘야 하는가. 필요하고 허용되면 새 토큰, 아니면 null.
 *
 * @param {object} payload 검증을 통과한 JWT 페이로드(exp·loginAt 포함)
 * @param {number} [now] 테스트용 주입점(초 단위)
 */
function renewedToken(payload, now = nowSec()) {
  if (!payload || !payload.exp) return null
  const leftSec = payload.exp - now
  if (leftSec <= 0) return null                        // 이미 만료 — 여기까지 오지 않는다
  if (leftSec > RENEW_WITHIN_MIN * 60) return null     // 아직 넉넉하다

  // loginAt 이 없는 토큰(이 기능 이전에 발급된 것)은 iat 를 최초 시각으로 본다.
  const loginAt = Number(payload.loginAt) || Number(payload.iat) || 0
  if (loginAt && now - loginAt > ABSOLUTE_MAX_HOURS * 3600) return null

  return signSession(payload, now)
}

module.exports = {
  signSession,
  renewedToken,
  _session: { SESSION_HOURS, RENEW_WITHIN_MIN, ABSOLUTE_MAX_HOURS },
}
