const { Router } = require('express')
const { randomUUID } = require('crypto')
const { withTx, httpError } = require('../lib/withTx')
const { kstToday } = require('../db')
const { canAny } = require('../platform/userPerms')
const { normalizeTemplate, listTemplates, monthItems, previewItems, createOne } = require('../lib/repeat')

/* 반복거래 — 규칙은 lib/repeat.js 한 곳. 여기는 요청을 받아 넘기기만 한다.
 * 설계: docs/02-design/features/repeat-templates.design.md */
const router = Router()
const YM_RE = /^\d{4}-\d{2}$/

/* ── 방향별 권한 ───────────────────────────────────────────────────
 * 입금·출금이 **한 라우트**로 합쳐졌다(옛 /api/recurring-invoices · /api/recurring 둘).
 * 권한 게이트(middleware/perm.js)는 경로 하나에 자원군 OR 라, 출금 권한만 있는 역할이
 * 이 경로를 통과하면 입금 반복거래까지 읽고 **매출 청구서까지 만들 수 있었다**
 * (정작 /api/invoices 는 403 인데 여기로 우회됐다 — 실측 확인).
 * 그래서 줄마다 그 방향의 자원을 다시 따진다. 옛 두 라우트와 같은 경계다.
 *
 * ⚠ 역할이 하나도 없는 계정은 통과시킨다 — perm.js 의 설계 결정과 같다.
 *   여기서만 막으면 역할 미배정 계정이 이 화면에서만 빈손이 된다. */
const dirResource = (dir) => (dir === 'in' ? 'recurring_invoice' : 'recurring_expense')

const allowsDir = (req, dir, action) =>
  !req.permRoles?.length || canAny(req.perms, [dirResource(dir)], action)

/** 볼 수 있는 방향만 남긴다 */
const visibleDirs = (req) => ['in', 'out'].filter(d => allowsDir(req, d, 'view'))

/** 그 방향을 쓸 수 없으면 403 */
const assertDir = (req, dir, action) => {
  if (!allowsDir(req, dir, action)) {
    throw httpError(403, `${dir === 'in' ? '입금' : '출금'} 반복거래에 대한 권한이 없어요. 관리자에게 문의하세요.`)
  }
}

/** 이 반복거래의 방향 (없으면 404) */
const dirOfTemplate = async (db, id) => {
  const [[row]] = await db.execute('SELECT direction FROM repeat_templates WHERE id = ?', [String(id || '')])
  if (!row) throw httpError(404, '반복거래를 찾을 수 없어요')
  return row.direction
}

const ymOf = (v) => {
  const ym = String(v || kstToday().slice(0, 7))
  if (!YM_RE.test(ym)) throw httpError(400, '달을 YYYY-MM 으로 보내주세요')
  return ym
}
const dirOf = (v) => (v === 'in' || v === 'out' ? v : null)

router.get('/', async (req, res, next) => {
  try {
    const dirs = visibleDirs(req)
    const rows = await listTemplates(req.db, kstToday())
    res.json(rows.filter(r => dirs.includes(r.direction)))
  } catch (e) { next(e) }
})

// ⚠ '/:id' 보다 앞에 둔다 — 뒤에 두면 month 가 id 로 먹힌다
router.get('/month', async (req, res, next) => {
  try {
    const dirs = visibleDirs(req)
    const asked = dirOf(req.query.direction)
    const rows = await monthItems(req.db, ymOf(req.query.ym), { direction: asked })
    res.json(rows.filter(r => dirs.includes(r.direction)))
  } catch (e) { next(e) }
})

/* 만들기 확인 — 고른 줄의 기본 날짜·금액과 '이미 장부에 있는 같은 돈' 후보. 아무것도 바꾸지 않는다 */
router.post('/preview', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : []
    const dirs = visibleDirs(req)
    const rows = await previewItems(req.db, ymOf(req.body?.ym), ids)
    res.json(rows.filter(r => dirs.includes(r.direction)))
  } catch (e) { next(e) }
})

/* 만들기 — 고른 줄을 한 트랜잭션으로. 한 줄이라도 막히면 아무것도 만들지 않는다
 * (반쯤 만들어진 달은 '어디까지 했지'를 사람이 다시 세야 한다). */
router.post('/create', async (req, res, next) => {
  try {
    const ym = ymOf(req.body?.ym)
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    if (!items.length) throw httpError(400, '만들 반복거래를 골라주세요')
    if (items.length > 100) throw httpError(400, '한 번에 100건까지 만들 수 있어요')
    const ids = items.map(i => String(i.template_id || ''))
    if (new Set(ids).size !== ids.length) throw httpError(400, '같은 반복거래가 두 번 들어 있어요')
    // 줄마다 그 방향을 만들 권한이 있는지 — 만들기 전에 전부 본다(한 줄이라도 막히면 아무것도 안 만든다)
    for (const id of ids) assertDir(req, await dirOfTemplate(req.db, id), 'create')
    const today = kstToday()
    const created = await withTx(req.db, async (conn) => {
      const out = []
      for (const row of items) out.push(await createOne(conn, ym, row, today))
      return out
    })
    res.json({ ok: true, created })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const n = normalizeTemplate(req.body)
    if (n.error) throw httpError(400, n.error, { field: n.field })
    const v = n.value
    assertDir(req, v.direction, 'create')
    const id = randomUUID()
    await req.db.execute(
      `INSERT INTO repeat_templates (id, direction, creates, vendor_id, contract_id, item, category, amount, vat_mode,
         period, anchor_month, day_of_month, account_id, pay_term, pay_day, active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, v.direction, v.creates, v.vendor_id, v.contract_id, v.item, v.category, v.amount, v.vat_mode,
       v.period, v.anchor_month, v.day_of_month, v.account_id, v.pay_term, v.pay_day, v.active])
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const n = normalizeTemplate(req.body)
    if (n.error) throw httpError(400, n.error, { field: n.field })
    const v = n.value
    /* 바꾸기 전·후 두 방향 모두 따진다 — 뒤만 보면 남의 방향 것을 끌어올 수 있고,
       앞만 보면 제 방향 것을 남의 방향으로 넘길 수 있다 */
    assertDir(req, await dirOfTemplate(req.db, req.params.id), 'edit')
    assertDir(req, v.direction, 'edit')
    const [r] = await req.db.execute(
      `UPDATE repeat_templates SET direction=?, creates=?, vendor_id=?, contract_id=?, item=?, category=?, amount=?,
         vat_mode=?, period=?, anchor_month=?, day_of_month=?, account_id=?, pay_term=?, pay_day=?, active=?
       WHERE id = ?`,
      [v.direction, v.creates, v.vendor_id, v.contract_id, v.item, v.category, v.amount, v.vat_mode,
       v.period, v.anchor_month, v.day_of_month, v.account_id, v.pay_term, v.pay_day, v.active, req.params.id])
    if (!r.affectedRows) throw httpError(404, '반복거래를 찾을 수 없어요')
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.patch('/:id/toggle', async (req, res, next) => {
  try {
    assertDir(req, await dirOfTemplate(req.db, req.params.id), 'edit')
    const [r] = await req.db.execute('UPDATE repeat_templates SET active = 1 - active WHERE id = ?', [req.params.id])
    if (!r.affectedRows) throw httpError(404, '반복거래를 찾을 수 없어요')
    const [[row]] = await req.db.execute('SELECT active FROM repeat_templates WHERE id = ?', [req.params.id])
    res.json({ ok: true, active: !!row.active })
  } catch (e) { next(e) }
})

/* 지우기 — 앞으로 목록에 안 뜰 뿐, 이미 만든 청구서·거래는 그대로다(실제로 오간 돈의 기록).
 * 남는 건수를 알려준다 — "같이 지워지나"를 걱정하지 않게. */
router.delete('/:id', async (req, res, next) => {
  try {
    assertDir(req, await dirOfTemplate(req.db, req.params.id), 'delete')
    const [[kept]] = await req.db.execute(
      `SELECT (SELECT COUNT(*) FROM invoices WHERE template_id = ?) AS invs,
              (SELECT COUNT(*) FROM transactions WHERE template_id = ?) AS txns`, [req.params.id, req.params.id])
    const [r] = await req.db.execute('DELETE FROM repeat_templates WHERE id = ?', [req.params.id])
    if (!r.affectedRows) throw httpError(404, '반복거래를 찾을 수 없어요')
    res.json({ ok: true, keptInvoices: Number(kept.invs) || 0, keptTxns: Number(kept.txns) || 0 })
  } catch (e) { next(e) }
})

module.exports = router
