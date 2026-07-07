const { Router } = require('express')
const { randomUUID } = require('crypto')
const { pool } = require('../db')

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    const { type } = req.query
    const [rows] = type
      ? await pool.execute('SELECT * FROM hr_codes WHERE type=? ORDER BY sort_order, name', [type])
      : await pool.execute('SELECT * FROM hr_codes ORDER BY type, sort_order, name')
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { type, name } = req.body
    if (!type || !name) return res.status(400).json({ error: '필수값 누락' })
    const [[{ maxOrder }]] = await pool.execute('SELECT COALESCE(MAX(sort_order),0) AS maxOrder FROM hr_codes WHERE type=?', [type])
    const id = randomUUID()
    await pool.execute('INSERT INTO hr_codes (id,type,name,sort_order) VALUES (?,?,?,?)', [id, type, name, maxOrder + 1])
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await pool.execute('DELETE FROM hr_codes WHERE id=?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
