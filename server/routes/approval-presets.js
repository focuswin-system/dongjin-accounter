const { Router } = require('express')
const { randomUUID } = require('crypto')

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
  try {
    const { name, steps, is_default } = req.body
    if (is_default) await req.db.execute('UPDATE approval_presets SET is_default=0')
    const [r] = await req.db.execute(
      'UPDATE approval_presets SET name=?, steps=?, is_default=? WHERE id=?',
      [name || '', JSON.stringify(steps || []), is_default ? 1 : 0, req.params.id]
    )
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 기본 프리셋 지정(하나만 기본이 되도록)
router.patch('/:id/default', async (req, res, next) => {
  try {
    await req.db.execute('UPDATE approval_presets SET is_default=0')
    const [r] = await req.db.execute('UPDATE approval_presets SET is_default=1 WHERE id=?', [req.params.id])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM approval_presets WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
