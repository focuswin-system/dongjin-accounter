const { Router } = require('express')
const { randomUUID } = require('crypto')
const { rollbackQuietly } = require('../lib/tx')

const router = Router()

const parseSteps = (v) => { try { return v ? JSON.parse(v) : [] } catch { return [] } }
const adapt = (r) => ({ ...r, is_default: !!r.is_default, steps: parseSteps(r.steps) })

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM approval_presets ORDER BY is_default DESC, sort_order, created_at')
    res.json(rows.map(adapt))
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { name, steps, is_default } = req.body
    if (!name || !name.trim()) return res.status(400).json({ error: '프리셋 이름을 입력해주세요' })
    const id = randomUUID()
    const [[{ maxOrder }]] = await req.db.execute('SELECT COALESCE(MAX(sort_order),0) AS maxOrder FROM approval_presets')
    if (is_default) await req.db.execute('UPDATE approval_presets SET is_default=0')
    await req.db.execute(
      'INSERT INTO approval_presets (id, name, steps, is_default, sort_order) VALUES (?,?,?,?,?)',
      [id, name.trim(), JSON.stringify(steps || []), is_default ? 1 : 0, maxOrder + 1]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const { name, steps, is_default } = req.body
    await conn.beginTransaction()
    // 대상을 먼저 갱신한다 — 없는 id면 여기서 0행이라 롤백. (예전엔 존재 확인 전에 모든 기본을
    // 해제해서, 대상이 없으면 '아무것도 기본이 아닌' 상태로 남아 결재선이 하드코딩으로 떨어졌다)
    const [r] = await conn.execute(
      'UPDATE approval_presets SET name=?, steps=?, is_default=? WHERE id=?',
      [name || '', JSON.stringify(steps || []), is_default ? 1 : 0, req.params.id]
    )
    if (r.affectedRows === 0) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    // 이 프리셋을 기본으로 지정했으면 나머지의 기본 플래그를 내린다(자기 자신은 제외)
    if (is_default) await conn.execute('UPDATE approval_presets SET is_default=0 WHERE id <> ?', [req.params.id])
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// 기본 프리셋 지정(하나만 기본이 되도록)
//
// 예전에는 '전체 해제 → 대상 지정' 두 문을 트랜잭션 없이 실행했다. 대상 id 가 없거나
// 두 문 사이에서 실패하면 **아무것도 기본이 아닌 상태**로 남는다. 그러면 결의서를 만들 때
// defaultApproval() 이 프리셋을 못 찾아 하드코딩 결재선(담당/결재/대표)으로 조용히 떨어진다
// — 회사가 설정한 결재선이 무시된 채 문서가 만들어진다.
router.patch('/:id/default', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[hit]] = await conn.execute('SELECT id FROM approval_presets WHERE id = ?', [req.params.id])
    if (!hit) { await rollbackQuietly(conn); return res.status(404).json({ error: '결재선을 찾을 수 없어요' }) }
    await conn.execute('UPDATE approval_presets SET is_default=0')
    await conn.execute('UPDATE approval_presets SET is_default=1 WHERE id=?', [req.params.id])
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM approval_presets WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
