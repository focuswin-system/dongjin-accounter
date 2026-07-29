const jwt = require('jsonwebtoken')
const { renewedToken } = require('../lib/session')
const { setFileCookie } = require('./fileAuth')

/**
 * JWT 검증. 멀티테넌트 전환 후 토큰에는 companyId·dbName이 반드시 실려 있어야 한다
 * (tenant 미들웨어가 이 값으로 회사 DB를 고른다).
 *
 * 전환 이전에 발급된 구(舊) 토큰에는 companyId가 없다 → 401로 떨궈 재로그인시킨다.
 * 이걸 통과시키면 회사 스코프 없이 요청이 흘러 들어가므로 반드시 막아야 한다.
 */
module.exports = function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '로그인이 필요합니다' })
  }
  let payload
  try {
    payload = jwt.verify(header.slice(7), process.env.JWT_SECRET)
  } catch {
    return res.status(401).json({ error: '토큰이 만료되었거나 유효하지 않습니다' })
  }
  if (!payload.companyId || !payload.dbName) {
    return res.status(401).json({ error: '다시 로그인해 주세요' })
  }
  // 임시 비밀번호 계정(mustChangePw)은 비번을 바꾸기 전엔 다른 API를 못 쓴다.
  // 프런트 게이트만으로는 localStorage를 지우면 우회되므로 서버에서도 막는다(JWT에 실린 플래그로 DB조회 없이).
  // 허용: 내 정보 조회·로그아웃·본인 비번 변경. 그 외는 403.
  if (payload.mustChangePw) {
    // 전역 미들웨어라 req.path는 전체 경로(/api/auth/...). 허용: 내 정보·로그아웃·본인 비번 변경.
    const p = req.path
    const isPwChange = req.method === 'PUT' && /^\/api\/auth\/users\/[^/]+\/password$/.test(p)
    const allowed = p === '/api/auth/me' || p === '/api/auth/logout' || isPwChange
    if (!allowed) {
      return res.status(403).json({ error: '임시 비밀번호예요. 먼저 비밀번호를 변경해주세요.', mustChangePw: true })
    }
  }
  // 만료가 다가오면 조용히 새 토큰을 실어 보낸다(슬라이딩 세션).
  // 일하는 도중에 튕기지 않게 하는 장치다 — 자세한 정책은 lib/session.js 참고.
  // 첨부파일용 쿠키도 같은 토큰으로 맞춰야 /uploads 접근이 함께 연장된다.
  const renewed = renewedToken(payload)
  if (renewed) {
    res.set('X-Renewed-Token', renewed)
    setFileCookie(res, renewed)
  }

  req.user = payload
  next()
}
