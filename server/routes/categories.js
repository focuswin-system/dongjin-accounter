const { Router } = require('express')
const { pool } = require('../db')

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    const { type } = req.query
    let sql = 'SELECT * FROM categories WHERE active = 1'
    const params = []
    if (type === 'exp') { sql += " AND id LIKE 'EXP-%'"; }
    if (type === 'inc') { sql += " AND id LIKE 'INC-%'"; }
    sql += ' ORDER BY sort_order, id'
    const [rows] = await pool.execute(sql, params)
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { id, name, group_name, vat, pay_method } = req.body
    if (!id || !name) return res.status(400).json({ error: 'id, name 필수' })
    const [[{ maxOrd }]] = await pool.execute('SELECT COALESCE(MAX(sort_order),0)+1 AS maxOrd FROM categories')
    await pool.execute(
      'INSERT INTO categories (id, name, group_name, vat, pay_method, sort_order) VALUES (?,?,?,?,?,?)',
      [id, name, group_name || '', vat || '10%', pay_method || '계좌이체', maxOrd]
    )
    res.json({ id })
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '이미 존재하는 코드입니다' })
    next(e)
  }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, group_name, vat, pay_method } = req.body
    const [result] = await pool.execute(
      'UPDATE categories SET name=?, group_name=?, vat=?, pay_method=? WHERE id=?',
      [name, group_name || '', vat || '10%', pay_method || '계좌이체', req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await pool.execute('UPDATE categories SET active = 0 WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
