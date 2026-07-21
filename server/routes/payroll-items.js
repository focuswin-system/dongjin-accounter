const { Router } = require('express')
const { randomUUID } = require('crypto')

const router = Router()

// 급여 항목 마스터(지급/공제 표준 목록)
router.get('/', async (req, res, next) => {
  try {
    const { kind } = req.query
    const [rows] = kind
      ? await req.db.execute('SELECT * FROM payroll_item_types WHERE active = 1 AND kind = ? ORDER BY sort_order, label', [kind])
      : await req.db.execute('SELECT * FROM payroll_item_types WHERE active = 1 ORDER BY sort_order, label')
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { label, kind, mode, default_value } = req.body
    if (!label || !['earn', 'deduct'].includes(kind)) return res.status(400).json({ error: 'label·kind 확인' })
    const [[{ maxOrder }]] = await req.db.execute('SELECT COALESCE(MAX(sort_order),0) AS maxOrder FROM payroll_item_types')
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO payroll_item_types (id, label, kind, mode, default_value, sort_order) VALUES (?,?,?,?,?,?)',
      [id, label, kind, mode === 'percent' ? 'percent' : 'fixed', Number(default_value) || 0, maxOrder + 1]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { label, kind, mode, default_value } = req.body
    const [r] = await req.db.execute(
      'UPDATE payroll_item_types SET label=?, kind=?, mode=?, default_value=? WHERE id=?',
      [label, kind === 'deduct' ? 'deduct' : 'earn', mode === 'percent' ? 'percent' : 'fixed', Number(default_value) || 0, req.params.id]
    )
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('UPDATE payroll_item_types SET active = 0 WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
