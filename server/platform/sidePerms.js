/* 한 경로에 **방향이 둘인** 자원 — 줄마다 그 방향의 자원을 다시 따진다.
 *
 * 권한 게이트(middleware/perm.js)는 경로 하나에 자원군 **OR** 이다. 매출·매입(입금·출금)이
 * 한 라우트를 쓰면, 한쪽 권한만 가진 역할이 게이트를 통과해 **반대쪽 장부까지** 읽고 쓴다.
 * 실제로 겪었다:
 *   · 반복거래 — 출금 권한만 가진 역할이 입금 반복거래 18건을 읽고 매출 청구서를 만들었다
 *     (정작 /api/invoices 는 403 이었다. 2026-09-18 실측)
 *   · 청구서 — 같은 모양. 수시 출금 권한만으로 매출 청구서를 조회·발행할 수 있었다
 * 옛 구조는 라우트가 방향마다 따로여서 게이트만으로 갈렸다. 합치면 경계를 여기서 다시 세운다.
 *
 * ⚠ 역할이 하나도 없는 계정은 통과시킨다 — perm.js 의 설계 결정과 같다.
 *   여기서만 막으면 역할 미배정 계정이 이 화면들에서만 빈손이 된다.
 */
const { canAny } = require('./userPerms')
const { actionFor } = require('./apiPerms')
const { httpError } = require('../lib/withTx')

/**
 * @param sides  { [방향]: 자원 id 목록 } — 예: { in: ['recurring_invoice'], out: ['recurring_expense'] }
 * @param label  { [방향]: 사람이 읽는 이름 } — 403 문구에 쓴다
 */
function sideGuard(sides, label = {}) {
  const actionOf = (req) => actionFor(req.method, (req.originalUrl || req.path || '').split('?')[0])

  /** 그 방향에 그 행위를 할 수 있나. action 을 안 주면 게이트가 본 것과 같은 행위로 본다 */
  const allows = (req, side, action = actionOf(req)) =>
    !req.permRoles?.length || canAny(req.perms, sides[side] || [], action)

  /** 볼 수 있는 방향만 */
  const visible = (req) => Object.keys(sides).filter(s => allows(req, s, 'view'))

  /** 그 방향을 쓸 수 없으면 403 */
  const assert = (req, side, action) => {
    if (!allows(req, side, action)) {
      throw httpError(403, `${label[side] || side}에 대한 권한이 없어요. 관리자에게 문의하세요.`)
    }
  }

  return { allows, visible, assert }
}

module.exports = { sideGuard }
