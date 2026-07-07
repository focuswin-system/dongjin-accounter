const { Router } = require('express')
const { randomUUID } = require('crypto')
const { pool } = require('../db')

const router = Router()

router.get('/', async (_, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT r.*, v.name AS vendor_name
      FROM recurring_expenses r
      LEFT JOIN vendors v ON r.vendor_id = v.id
      ORDER BY r.day_of_month
    `)
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { vendor_id, contract_id, category, amount, period, day_of_month, start_date, end_date, account_id } = req.body
    const id = randomUUID()
    await pool.execute(
      'INSERT INTO recurring_expenses (id, vendor_id, contract_id, category, amount, period, day_of_month, start_date, end_date, account_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, vendor_id||null, contract_id||null, category||'', amount, period||'monthly', day_of_month||1, start_date, end_date||null, account_id||null]
    )
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { vendor_id, contract_id, category, amount, period, day_of_month, start_date, end_date, account_id } = req.body
    const [result] = await pool.execute(
      'UPDATE recurring_expenses SET vendor_id=?, contract_id=?, category=?, amount=?, period=?, day_of_month=?, start_date=?, end_date=?, account_id=? WHERE id=?',
      [vendor_id||null, contract_id||null, category||'', amount, period||'monthly', day_of_month||1, start_date, end_date||null, account_id||null, req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT active FROM recurring_expenses WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const newActive = rows[0].active ? 0 : 1
    await pool.execute('UPDATE recurring_expenses SET active = ? WHERE id = ?', [newActive, req.params.id])
    res.json({ active: !!newActive })
  } catch (e) { next(e) }
})

router.post('/generate', async (_, res, next) => {
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [recurrings] = await conn.execute('SELECT * FROM recurring_expenses WHERE active = 1')
    const generated = []

    for (const r of recurrings) {
      const nextDate = calcNextDate(r, today)
      if (!nextDate) continue
      const nextStr = nextDate.toISOString().slice(0, 10)
      const lastGen = r.last_generated || r.start_date
      if (nextStr <= todayStr && nextStr > lastGen) {
        const id = randomUUID()
        await conn.execute(
          'INSERT INTO transactions (id, vendor_id, account_id, category, amount, date, method, status, buyer_type, recurring_id, memo) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [id, r.vendor_id||null, r.account_id||null, r.category, r.amount, nextStr, '계좌이체', '지급 대기', '공통', r.id, '정기 지출 자동 생성']
        )
        await conn.execute('UPDATE recurring_expenses SET last_generated = ? WHERE id = ?', [nextStr, r.id])
        generated.push({ id, vendor_id: r.vendor_id, category: r.category, amount: r.amount, date: nextStr })
      }
    }

    await conn.commit()
    res.json({ generated, count: generated.length })
  } catch (e) {
    await conn.rollback()
    next(e)
  } finally {
    conn.release()
  }
})

function calcNextDate(r, today) {
  const day = r.day_of_month
  const date = new Date(today.getFullYear(), today.getMonth(), day)
  if (date > today) date.setMonth(date.getMonth() - 1)
  if (r.end_date && date.toISOString().slice(0, 10) > r.end_date) return null
  return date
}

module.exports = router
