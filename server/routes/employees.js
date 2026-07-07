const { Router } = require('express')
const { randomUUID } = require('crypto')
const { pool } = require('../db')

const router = Router()

router.get('/', async (_, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM employees ORDER BY emp_no ASC')
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { name, role, department, base_salary, join_date, birth_date,
            position_allowance, meal_allowance, vehicle_allowance, dependents, child_dependents } = req.body
    const id = randomUUID()
    const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) AS cnt FROM employees')
    const emp_no = 'EMP-' + String(cnt + 1).padStart(3, '0')
    await pool.execute(
      `INSERT INTO employees (id, emp_no, name, role, department, base_salary, join_date, birth_date,
        position_allowance, meal_allowance, vehicle_allowance, dependents, child_dependents)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, emp_no, name, role||'', department||'', base_salary||0, join_date||null, birth_date||null,
       position_allowance||0, meal_allowance||0, vehicle_allowance||0,
       dependents == null ? 1 : dependents, child_dependents||0]
    )
    res.json({ id, emp_no })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, role, department, base_salary, join_date, birth_date, active,
            position_allowance, meal_allowance, vehicle_allowance, dependents, child_dependents } = req.body
    const [result] = await pool.execute(
      `UPDATE employees SET name=?, role=?, department=?, base_salary=?, join_date=?, birth_date=?, active=?,
        position_allowance=?, meal_allowance=?, vehicle_allowance=?, dependents=?, child_dependents=?
       WHERE id=?`,
      [name, role||'', department||'', base_salary||0, join_date||null, birth_date||null, active !== false ? 1 : 0,
       position_allowance||0, meal_allowance||0, vehicle_allowance||0,
       dependents == null ? 1 : dependents, child_dependents||0, req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await pool.execute('DELETE FROM employees WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
