const jwt = require('jsonwebtoken')
const { platformPool } = require('../platform/db')

/**
 * 운영자(플랫폼 관리자) 인증 — 두 번째 자물쇠.
 *
 * ⚠ 이 토큰과 테넌트 사용자 토큰은 **절대 섞이면 안 된다.**
 * 같은 JWT_SECRET 으로 서명되므로, 구분 없이 검증하면 회사 마스터의 토큰으로
 * 전 회사 데이터를 보는 콘솔에 들어올 수 있다. 그건 격리가 통째로 뚫리는 것이다.
 *
 * 그래서 양쪽에 서로를 배제하는 표식을 둔다.
 *   운영자 토큰  : kind === 'platform' 이고 companyId 가 **없다**
 *   테넌트 토큰  : companyId·dbName 이 반드시 있다(middleware/auth.js 가 없으면 401)
 *
 * 여기서는 두 조건을 **모두** 본다 — kind 만 보면, 훗날 테넌트 토큰에 kind 가
 * 실리는 변경이 생겼을 때 조용히 뚫린다. companyId 가 실린 토큰은 무조건 거부다.
 *
 * 조회(findAdmin)를 주입받는 형태인 이유는 DB 없이 검증하기 위해서다.
 * 실제 배선은 이 파일 맨 아래에서 한 번 한다.
 */
function createPlatformAuth({ findAdmin }) {
  return async function platformAuth(req, res, next) {
    const header = req.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: '운영자 로그인이 필요합니다' })
    }
    let payload
    try {
      payload = jwt.verify(header.slice(7), process.env.JWT_SECRET)
    } catch {
      return res.status(401).json({ error: '세션이 만료되었거나 유효하지 않습니다' })
    }
    // 테넌트 사용자 토큰을 운영자 토큰으로 쓸 수 없다(그 반대도 auth.js 가 막는다)
    if (payload.kind !== 'platform' || payload.companyId || payload.dbName) {
      return res.status(403).json({ error: '운영자 계정이 아닙니다' })
    }

    /* 계정이 아직 살아 있는지 매번 확인한다.
     *
     * 토큰만 믿으면 **계정을 지워도 최대 12시간(세션 수명) 동안 계속 들어온다.**
     * 퇴사·사고로 접근을 끊는 순간 실제로 끊겨야 하는 자리라, 여기서만은
     * 요청마다 한 번 더 본다. 콘솔은 운영자 몇 명이 쓰는 화면이라 부담이 없다.
     * (고객용 API 는 트래픽이 달라 이렇게 하지 않는다 — 거긴 토큰 수명으로 관리한다) */
    try {
      const admin = await findAdmin(payload.id)
      if (!admin) return res.status(401).json({ error: '더 이상 사용할 수 없는 계정입니다' })
      req.admin = admin
      next()
    } catch (e) { next(e) }
  }
}

/** 기본 조회 — 운영자 계정이 아직 있는지 */
async function lookupAdmin(id) {
  const [[row]] = await platformPool.execute(
    'SELECT id, username, name FROM platform_admins WHERE id = ?', [id])
  return row || null
}

module.exports = createPlatformAuth({ findAdmin: lookupAdmin })
module.exports.createPlatformAuth = createPlatformAuth
