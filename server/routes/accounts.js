const { Router } = require('express')
const { randomUUID } = require('crypto')
const { pool } = require('../db')

const router = Router()

async function calcBalance(accountId) {
  const [rows] = await pool.execute(`
    SELECT
      a.initial_balance,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='income'  AND account_id=a.id), 0) AS income_total,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='expense' AND account_id=a.id AND status='지급완료'), 0) AS expense_total,
      COALESCE((SELECT SUM(amount) FROM account_adjustments WHERE account_id=a.id), 0) AS adj_total
    FROM accounts a WHERE a.id = ?
  `, [accountId])
  const row = rows[0]
  if (!row) return 0
  return Number(row.initial_balance) + Number(row.income_total) - Number(row.expense_total) + Number(row.adj_total)
}

router.get('/', async (_, res, next) => {
  try {
    const [accounts] = await pool.execute('SELECT * FROM accounts ORDER BY name')
    const result = await Promise.all(accounts.map(async a => ({ ...a, balance: await calcBalance(a.id) })))
    res.json(result)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM accounts WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ ...rows[0], balance: await calcBalance(req.params.id) })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { name, bank, type, initial_balance, kind, number, purpose } = req.body
    const id = randomUUID()
    await pool.execute(
      'INSERT INTO accounts (id, name, bank, type, initial_balance, kind, `number`, purpose) VALUES (?,?,?,?,?,?,?,?)',
      [id, name, bank||'', type||'보통예금', initial_balance||0, kind||'bank', number||'', purpose||'']
    )
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, bank, type, initial_balance, kind, number, purpose } = req.body
    const [result] = await pool.execute(
      'UPDATE accounts SET name=?, bank=?, type=?, initial_balance=?, kind=?, `number`=?, purpose=? WHERE id=?',
      [name, bank||'', type||'보통예금', initial_balance||0, kind||'bank', number||'', purpose||'', req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    // 거래·청구·정기지출에 연결돼 있으면 삭제 차단 (FK 보호)
    const [[{ refCnt }]] = await pool.execute(
      `SELECT
         (SELECT COUNT(*) FROM transactions       WHERE account_id = ?) +
         (SELECT COUNT(*) FROM invoices           WHERE account_id = ?) +
         (SELECT COUNT(*) FROM recurring_expenses WHERE account_id = ?) AS refCnt`,
      [req.params.id, req.params.id, req.params.id]
    )
    if (refCnt > 0) {
      return res.status(409).json({ error: '이 계좌/카드에 연결된 거래·청구·정기지출이 있어 삭제할 수 없습니다' })
    }
    const [result] = await pool.execute('DELETE FROM accounts WHERE id = ?', [req.params.id])
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.get('/:id/adjustments', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM account_adjustments WHERE account_id = ? ORDER BY date DESC',
      [req.params.id]
    )
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/:id/adjustments', async (req, res, next) => {
  try {
    const { amount, reason, date, created_by } = req.body
    const id = randomUUID()
    await pool.execute(
      'INSERT INTO account_adjustments (id, account_id, amount, reason, date, created_by) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, amount, reason||'', date, created_by||'']
    )
    res.json({ id })
  } catch (e) { next(e) }
})

module.exports = router
