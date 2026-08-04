const { audit } = require('../platform/db')
const { auditRuleFor, targetIdFrom } = require('../platform/auditMap')
const { clientIp } = require('../lib/loginGuard')

/**
 * 감사 로그 — '누가 무엇을 했는가'를 남긴다.
 *
 * 인증 → 테넌트 → 권한 다음에 돈다. 그래서 req.user 는 이미 있고 회사도 확정돼 있다.
 * 무엇을 남길지는 platform/auditMap.js 가 단일 소스다.
 *
 * ── 설계 결정 ──
 *
 * · **성공한 요청만 남긴다.** 실패(4xx/5xx)는 아무것도 바꾸지 않았으므로 남길 이유가 없고,
 *   남기면 "삭제했다"는 기록이 실제로는 권한 거부였던 경우와 섞여 로그를 믿을 수 없게 된다.
 *   (로그인 실패만은 예외로 routes/auth.js 가 따로 남긴다 — 그건 침입 신호라 실패가 곧 정보다)
 *
 * · **응답을 보낸 뒤에 기록한다.** res 의 'finish' 에 걸어, 기록이 느려도 사용자 응답이
 *   늦어지지 않게 한다. audit() 자체도 실패를 삼키므로 로그 때문에 업무가 멈추지 않는다.
 *
 * · **응답 본문에서 오직 id 하나만 읽는다.** 새로 만든 것(POST)의 대상 ID는 응답에만 있다.
 *   본문 전체를 붙들면 금액·거래처명이 로그로 흘러가므로 id 만 꺼내고 즉시 버린다.
 *
 * 의존을 주입받는 형태로 만든 이유는 DB 없이 시험하기 위해서다.
 * 실제 배선은 이 파일 맨 아래에서 한 번 한다.
 */
function createAuditTrail({ audit: record, clientIp: ipOf }) {
  return function auditTrail(req, res, next) {
    const found = auditRuleFor(req.method, (req.originalUrl || req.path).split('?')[0])
    if (!found) return next()

    // 새로 만든 자원의 id는 응답에만 있다. id 하나만 꺼내고 본문은 붙들지 않는다.
    let createdId = null
    if (found.rule.target === 'created') {
      const origJson = res.json
      res.json = function auditPeekJson(body) {
        if (body && typeof body === 'object') createdId = body.id == null ? null : body.id
        return origJson.call(this, body)
      }
    }

    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return  // 바뀐 게 없으면 남기지 않는다
      const u = req.user || {}
      record({
        companyId: u.companyId,
        userId: u.id,
        username: u.username,
        action: found.rule.action,
        resource: found.rule.res,
        targetId: targetIdFrom(found, { body: req.body, createdId }),
        ip: ipOf(req),
      })
    })

    next()
  }
}

module.exports = createAuditTrail({ audit, clientIp })
module.exports.createAuditTrail = createAuditTrail
