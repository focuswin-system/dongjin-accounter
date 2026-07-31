const { platformPool } = require('../platform/db')
const { requiredPerm } = require('../platform/apiPerms')
const { loadUserPerms, canAny } = require('../platform/userPerms')

/**
 * 권한 게이트 — 자원×행위 판정을 여기 한 곳에서 한다.
 *
 * 인증(auth) → 테넌트(tenant) 다음에 돈다. 그래서 req.user 는 이미 있고 회사도 확정돼 있다.
 * 매핑·판정 규칙은 platform/apiPerms.js, 권한 조회는 platform/userPerms.js.
 *
 * ── 설계 결정 ──
 * · **매핑이 없는 경로는 통과시킨다.** 막으면 매핑을 빠뜨린 순간 그 화면이 통째로 죽는다.
 *   대신 scripts/check-isolation.js 가 '매핑 없는 라우터'를 배포 전에 실패로 잡는다.
 *   (열어두고 배포 전에 잡는다 vs 닫아두고 운영에서 터진다 — 전자가 낫다)
 * · **역할이 하나도 없는 사용자는 통과시킨다.** 기존 계정에 user_roles 행이 없을 수 있고,
 *   그런 계정을 갑자기 전면 차단하면 로그인은 되는데 아무것도 못 하는 상태가 된다
 *   (임시비번 영구잠금과 같은 종류의 사고). 역할을 배정하기 시작한 뒤부터 강제된다.
 *   운영 확인: 현재 전 계정이 '마스터' 역할에 배정돼 있어 이 예외에 걸리는 계정은 없다.
 * · 조회(view)까지 막으므로 화면이 빈 목록이 아니라 403을 받는다. 프런트는 권한 없는 메뉴를
 *   애초에 보여주지 않으므로(nav 가리기), 403은 URL 직접 입력·구 링크에서만 발생한다.
 */
module.exports = async function permGate(req, res, next) {
  try {
    const need = requiredPerm(req.method, (req.originalUrl || req.path).split('?')[0])

    const { companyId, id: userId } = req.user || {}
    if (!companyId || !userId) return res.status(401).json({ error: '다시 로그인해 주세요' })

    /* 게이트를 통과시키는 경로에서도 권한을 실어준다.
     * 라우트가 **응답 안에서** 민감한 필드를 가려야 할 때가 있다 —
     * 계좌 목록은 결제수단이라 누구나 골라야 하지만 '잔액'은 아니다(routes/accounts.js).
     * 30초 캐시라 매 요청 쿼리가 아니다. */
    const { perms, roles } = await loadUserPerms(platformPool, { companyId, userId })
    req.perms = perms
    req.permRoles = roles
    if (!need) return next()
    // 역할 미배정 계정은 강제 대상이 아니다(위 설계 결정 참고)
    if (!roles.length) return next()

    if (!canAny(perms, need.resources, need.action)) {
      const LABEL = { access: '접근', view: '조회', create: '등록', edit: '수정',
                      delete: '삭제', upload: '업로드', download: '다운로드', export: '출력' }
      return res.status(403).json({
        error: `이 작업(${LABEL[need.action] || need.action})에 대한 권한이 없어요. 관리자에게 문의하세요.`,
        deniedAction: need.action,
      })
    }
    next()
  } catch (e) { next(e) }
}
