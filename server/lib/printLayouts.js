/**
 * 인쇄 배치 — 인쇄 양식 편집기(PrintWizard)에서 손본 쪽·상자 배치를 문서별로 저장한다.
 * 설계: docs/02-design/features/popup-attachments-print.design.md §5-1
 *
 * 배치는 **화면 소유물**이다 — 서버는 모양을 해석하지 않고 크기·형식만 지킨다.
 * 문서 내용이 아니므로 결재 중·마감에도 저장된다. 권한은 그 문서를 볼 수 있으면(apiPerms ACTION_OVERRIDES).
 * 모든 함수는 req.db(테넌트 풀)만 쓴다.
 */
const MAX_BYTES = 200 * 1024

const OWNER_TABLES = {
  resolution:      'expense_resolutions',
  purchase_req:    'purchase_reqs',
  settlement:      'settlements',
  journal_voucher: 'journal_vouchers',
  txn:             'transactions',
}

/** 문서 라우터에 GET/PUT /:id/print-layout 를 단다 */
function printLayoutRoutes(router, ownerType) {
  const table = OWNER_TABLES[ownerType]
  if (!table) throw new Error(`printLayoutRoutes: 모르는 문서 종류 ${ownerType}`)
  const exists = async (db, id) => {
    const [[r]] = await db.execute(`SELECT id FROM ${table} WHERE id = ?`, [id])
    return !!r
  }
  router.get('/:id/print-layout', async (req, res, next) => {
    try {
      if (!(await exists(req.db, req.params.id))) return res.status(404).json({ error: '문서를 찾을 수 없어요' })
      const [[r]] = await req.db.execute(
        'SELECT layout, updated_by, updated_at FROM print_layouts WHERE owner_type = ? AND owner_id = ?', [ownerType, req.params.id])
      if (!r) return res.json({ layout: null })
      let layout = null
      try { layout = JSON.parse(r.layout) } catch { layout = null }   // 깨진 배치는 없는 셈 — 자동 배치로 다시 시작
      res.json({ layout, updated_by: r.updated_by, updated_at: r.updated_at })
    } catch (e) { next(e) }
  })
  router.put('/:id/print-layout', async (req, res, next) => {
    try {
      if (!(await exists(req.db, req.params.id))) return res.status(404).json({ error: '문서를 찾을 수 없어요' })
      const layout = req.body?.layout
      if (!layout || typeof layout !== 'object' || !Array.isArray(layout.pages) || !Array.isArray(layout.items)) {
        return res.status(400).json({ error: '배치 형식이 맞지 않아요' })
      }
      const json = JSON.stringify(layout)
      if (Buffer.byteLength(json) > MAX_BYTES) return res.status(413).json({ error: '배치가 너무 커요' })
      await req.db.execute(
        `INSERT INTO print_layouts (owner_type, owner_id, layout, updated_by) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE layout = VALUES(layout), updated_by = VALUES(updated_by)`,
        [ownerType, req.params.id, json, req.user?.name || req.user?.username || null])
      res.json({ ok: true })
    } catch (e) { next(e) }
  })
}

/** 문서를 지울 때 함께 */
async function removeLayoutFor(db, ownerType, ownerId) {
  await db.execute('DELETE FROM print_layouts WHERE owner_type = ? AND owner_id = ?', [ownerType, ownerId])
}

module.exports = { printLayoutRoutes, removeLayoutFor, OWNER_TABLES }
