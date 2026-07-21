/**
 * 테넌트 라우팅 미들웨어
 *
 * JWT의 dbName으로 그 회사의 DB 풀을 골라 req.db 에 꽂는다.
 * 이 뒤의 모든 라우트는 req.db 로만 질의한다 — 전역 풀을 쓰면 회사 구분이 사라진다.
 *
 * ⚠ 라우트가 실수로 전역 풀을 쓰는 것을 막는 장치:
 *    · db.js는 pool을 export 하지 않는다
 *    · scripts/check-isolation.js 가 routes/ 의 전역 풀 사용을 검사한다
 *
 * 설계: docs/02-design/features/multi-tenant-saas.design.md §1.2
 */
const { getPool } = require('../db/poolManager')

module.exports = function tenantMiddleware(req, res, next) {
  const dbName = req.user?.dbName
  if (!dbName) {
    // authMiddleware가 이미 걸러내지만, 순서가 바뀌어도 회사 없는 요청이
    // 데이터에 닿지 않도록 여기서 한 번 더 막는다.
    return res.status(401).json({ error: '다시 로그인해 주세요' })
  }
  try {
    req.db = getPool(dbName)
  } catch (e) {
    // assertDbName 실패 = 토큰이 조작됐거나 등록 정보가 깨진 경우
    console.error('[tenant] 잘못된 DB 이름:', dbName, e.message)
    return res.status(400).json({ error: '회사 정보가 올바르지 않습니다' })
  }
  next()
}
