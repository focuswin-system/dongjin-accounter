/**
 * 전자결재 API — 결재함·상신·승인·전결·반려·회수. 규칙은 lib/approval.js(엔진) + lib/approvalDocs.js(문서).
 *
 * 권한: 결재함은 **자기 것만** 보이므로 로그인만 되면 연다(platform/permissions.js OPEN_RESOURCES).
 * 결재 동작의 권한은 표가 아니라 "지금 차례인 사람인가"다 — 엔진이 행 잠금 안에서 판정한다.
 * 상신은 그 문서를 고칠 수 있는 사람만(아래 canEditDoc). 설정 변경은 settings 권한(apiPerms 재정의).
 */
const { Router } = require('express')
const approval = require('../lib/approval')
const { DOCS, docTypeOf } = require('../lib/approvalDocs')
const { canAny } = require('../platform/userPerms')

const router = Router()

/* 역할이 없는 계정은 권한 게이트가 전부 통과시킨다(middleware/perm.js 설계) — 여기서도 같게 본다 */
const canDoc = (req, action) => (resource) =>
  !req.permRoles?.length || (!!resource && canAny(req.perms, [resource], action))

router.get('/settings', async (req, res, next) => {
  try { res.json({ enabled: await approval.isEnabled(req.db) }) } catch (e) { next(e) }
})

router.put('/settings', async (req, res, next) => {
  try {
    const on = req.body?.enabled ? 1 : 0
    /* 결재가 진행 중일 때 끄면 그 문서들이 길을 잃는다 — 결재함이 사라져 회수할 곳이 없고,
       문서는 '결재중'으로 잠긴다(검토에서 잡힘). 먼저 끝내거나 회수하게 한다. */
    if (!on) {
      const [[{ n }]] = await req.db.execute("SELECT COUNT(*) AS n FROM approvals WHERE status = '진행'")
      if (Number(n) > 0) return res.status(409).json({ error: `진행 중인 결재가 ${n}건 있어요. 결재를 끝내거나 회수한 뒤에 꺼 주세요.` })
    }
    await req.db.execute("INSERT IGNORE INTO company_info (id, name) VALUES ('main', '')")
    await req.db.execute("UPDATE company_info SET e_approval = ? WHERE id = 'main'", [on])
    res.json({ ok: true, enabled: !!on })
  } catch (e) { next(e) }
})

// 결재자 후보(같은 회사 계정) — 이름·직위·부서만
router.get('/approvers', async (req, res, next) => {
  /* 전원을 준다 — 환경설정의 결재선 프리셋에는 관리자 자신도 넣을 수 있어야 한다.
     '기안자 본인 제외'는 상신 창이 한다(Approval.jsx SubmitApprovalDrawer). 서버 submit 이 최종 판정 */
  try { res.json(await approval.approvers(req.user.companyId)) } catch (e) { next(e) }
})

// 결재함 숫자(종·사이드바)
router.get('/counts', async (req, res, next) => {
  try { res.json(await approval.counts(req.db, req.user)) } catch (e) { next(e) }
})

// 결재함 목록 ?box=todo|mine|done|ref
router.get('/', async (req, res, next) => {
  try { res.json(await approval.inbox(req.db, req.user, String(req.query.box || 'todo'))) } catch (e) { next(e) }
})

// 문서 하나의 결재 이력(모든 회차) — 그 문서를 볼 수 있는 사람
router.get('/doc/:type/:id', async (req, res, next) => {
  try {
    const spec = docTypeOf(req.params.type)
    if (!canDoc(req, 'view')(spec.resource)) return res.status(403).json({ error: '볼 수 없는 문서예요' })
    res.json(await approval.historyOf(req.db, req.user, req.params.type, req.params.id))
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try { res.json(await approval.detail(req.db, req.user, req.params.id, { canViewDoc: canDoc(req, 'view') })) }
  catch (e) { next(e) }
})

// 상신 — 그 문서를 고칠 수 있는 사람만
router.post('/', async (req, res, next) => {
  try {
    const spec = DOCS[String(req.body?.doc_type || '')]
    if (!spec) return res.status(400).json({ error: '알 수 없는 문서 종류예요' })
    if (!canDoc(req, 'edit')(spec.resource)) return res.status(403).json({ error: '이 문서를 결재에 올릴 권한이 없어요' })
    const out = await approval.submit(req.db, req.user, req.body || {})
    res.json({ ok: true, ...out })
  } catch (e) { next(e) }
})

router.post('/:id/approve', async (req, res, next) => {
  try { res.json(await approval.act(req.db, req.user, req.params.id, 'approve', req.body?.comment)) } catch (e) { next(e) }
})
router.post('/:id/final', async (req, res, next) => {
  try { res.json(await approval.act(req.db, req.user, req.params.id, 'final', req.body?.comment)) } catch (e) { next(e) }
})
router.post('/:id/reject', async (req, res, next) => {
  try { res.json(await approval.act(req.db, req.user, req.params.id, 'reject', req.body?.comment)) } catch (e) { next(e) }
})
router.post('/:id/recall', async (req, res, next) => {
  try { res.json(await approval.recall(req.db, req.user, req.params.id)) } catch (e) { next(e) }
})

module.exports = router
