const jwt = require('jsonwebtoken')

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
  req.user = payload
  next()
}
