const { Router } = require('express')
const { randomUUID } = require('crypto')
const { platformPool } = require('../platform/db')
const { KINDS, cleanFiles } = require('../platform/templateRequests')

const router = Router()

/**
 * 양식 신청 — 고객사가 "이런 보고서·문서를 쓰고 싶다"고 보내는 문.
 *
 * ── 왜 필요한가 ──
 * 카탈로그·주문·회사 설정까지 만들어 놓고 **고객이 요청할 통로가 없었다.**
 * 전화·카톡으로 오면 기록이 안 남고, 무엇을 요청했는지가 사람 머릿속에만 있다.
 *
 * ── 어디에 담나 ──
 * **플랫폼 DB** 다(platform/schema.js template_requests). 받는 사람이 우리라서다 —
 * 회사 DB에 두면 콘솔이 테넌트를 하나하나 열어봐야 신청이 왔는지 알 수 있다.
 * ⚠ 그래서 이 라우터만 req.db 를 쓰지 않는다. 회사 구분은 **req.user.companyId** 로만 한다 —
 *   경로·본문으로 회사 id 를 받지 않는다(받는 순간 검증 한 곳만 빠뜨려도 남의 것을 본다).
 *
 * ⚠ **신청은 계약이 아니다.** 여기 행이 생겨도 아무것도 안 열린다. 여는 것은 사람이
 *   콘솔에서 company_features 를 켜는 별도의 손이다(routes/admin.js).
 */

/* 보고서·문서 관리 화면이 마스터 전용이라 신청도 마스터가 낸다.
   양식을 늘리는 일은 회사가 정할 일이지 담당자 개인이 정할 일이 아니다. */
const isMaster = (req) => req.user?.role === 'admin'

const rowOut = (r) => ({
  id: r.id, kind: r.kind, title: r.title, descr: r.descr || '',
  files: Array.isArray(r.files) ? r.files : (r.files ? JSON.parse(r.files) : []),
  status: r.status, opsReply: r.ops_reply || '',
  requester: r.requester || '', createdAt: r.created_at, updatedAt: r.updated_at,
})

/** 우리 회사가 낸 신청 — 상태와 답변까지. 목록을 안 보여주면 같은 걸 또 신청한다. */
router.get('/', async (req, res, next) => {
  try {
    if (!isMaster(req)) return res.status(403).json({ error: '회사 마스터만 볼 수 있어요' })
    const kind = KINDS.has(req.query.kind) ? req.query.kind : null
    const [rows] = await platformPool.execute(
      `SELECT id, kind, title, descr, files, status, ops_reply, requester, created_at, updated_at
         FROM template_requests
        WHERE company_id = ?${kind ? ' AND kind = ?' : ''}
        ORDER BY created_at DESC
        LIMIT 100`,
      kind ? [req.user.companyId, kind] : [req.user.companyId])
    res.json({ items: rows.map(rowOut) })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    if (!isMaster(req)) return res.status(403).json({ error: '회사 마스터만 신청할 수 있어요' })
    const kind = KINDS.has(req.body?.kind) ? req.body.kind : 'report'
    const title = String(req.body?.title || '').trim().slice(0, 160)
    if (!title) return res.status(400).json({ error: '어떤 양식인지 제목을 적어주세요' })
    const descr = String(req.body?.descr || '').trim().slice(0, 4000)
    const files = cleanFiles(req.body?.files, req.user.companyId)

    const id = randomUUID()
    await platformPool.execute(
      `INSERT INTO template_requests
         (id, company_id, kind, title, descr, files, requested_by, requester)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, req.user.companyId, kind, title, descr, JSON.stringify(files),
       req.user.id || null, String(req.user.name || req.user.username || '').slice(0, 80)])
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

/* 취소 — **아직 우리가 손대기 전**에만 된다.
   검토를 시작한 뒤에도 지워지면, 콘솔에서 보고 있던 건이 눈앞에서 사라진다. */
router.delete('/:id', async (req, res, next) => {
  try {
    if (!isMaster(req)) return res.status(403).json({ error: '회사 마스터만 취소할 수 있어요' })
    const [r] = await platformPool.execute(
      `DELETE FROM template_requests WHERE id = ? AND company_id = ? AND status = 'received'`,
      [req.params.id, req.user.companyId])
    if (!r.affectedRows) {
      return res.status(409).json({ error: '이미 확인한 신청이라 취소할 수 없어요. 문의해주세요.' })
    }
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
