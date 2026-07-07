const { Router } = require('express')
const { randomUUID } = require('crypto')
const { pool } = require('../db')

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    const { gubu } = req.query
    const [rows] = gubu
      ? await pool.execute('SELECT * FROM vendors WHERE gubu = ? ORDER BY name', [gubu])
      : await pool.execute('SELECT * FROM vendors ORDER BY gubu, name')
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM vendors WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { name, biz_no, ceo, address, phone, gubu, type, service_type, contact, fax, email } = req.body
    const id = randomUUID()
    await pool.execute(
      'INSERT INTO vendors (id, name, biz_no, ceo, address, phone, gubu, type, service_type, contact, fax, email) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, name, biz_no||'', ceo||'', address||'', phone||'', gubu||'A', type||'', service_type||'', contact||'', fax||'', email||'']
    )
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, biz_no, ceo, address, phone, gubu, type, service_type, contact, fax, email } = req.body
    const [result] = await pool.execute(
      'UPDATE vendors SET name=?, biz_no=?, ceo=?, address=?, phone=?, gubu=?, type=?, service_type=?, contact=?, fax=?, email=? WHERE id=?',
      [name, biz_no||'', ceo||'', address||'', phone||'', gubu||'A', type||'', service_type||'', contact||'', fax||'', email||'', req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await pool.execute('DELETE FROM vendors WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
