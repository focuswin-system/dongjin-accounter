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
    const { name, role, department, base_salary, join_date, birth_date, status,
            position_allowance, meal_allowance, vehicle_allowance, dependents, child_dependents } = req.body
    const id = randomUUID()
    const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) AS cnt FROM employees')
    const emp_no = 'EMP-' + String(cnt + 1).padStart(3, '0')
    // active는 상태에서 파생(퇴사만 비활성) — 클라 값 대신 서버가 단일 소스로 계산.
    const st = status || '재직'
    await pool.execute(
      `INSERT INTO employees (id, emp_no, name, role, department, base_salary, join_date, birth_date, status, active,
        position_allowance, meal_allowance, vehicle_allowance, dependents, child_dependents)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, emp_no, name, role||'', department||'', base_salary||0, join_date||null, birth_date||null,
       st, st === '퇴사' ? 0 : 1,
       position_allowance||0, meal_allowance||0, vehicle_allowance||0,
       dependents == null ? 1 : dependents, child_dependents||0]
    )
    res.json({ id, emp_no })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, role, department, base_salary, join_date, birth_date, active, status,
            position_allowance, meal_allowance, vehicle_allowance, dependents, child_dependents } = req.body
    // 상태를 단일 소스로: status가 오면 그걸 저장하고 active를 파생(퇴사만 비활성).
    // (하위호환: status 없이 active만 오던 옛 호출은 active로 상태를 역산.)
    const st = status != null ? status : (active === false ? '퇴사' : '재직')
    const [result] = await pool.execute(
      `UPDATE employees SET name=?, role=?, department=?, base_salary=?, join_date=?, birth_date=?, status=?, active=?,
        position_allowance=?, meal_allowance=?, vehicle_allowance=?, dependents=?, child_dependents=?
       WHERE id=?`,
      [name, role||'', department||'', base_salary||0, join_date||null, birth_date||null, st, st === '퇴사' ? 0 : 1,
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
