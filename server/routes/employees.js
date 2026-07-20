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
            position_allowance, meal_allowance, vehicle_allowance, dependents, child_dependents,
            person_kind, leave_date } = req.body
    const id = randomUUID()
    // 사번은 기존 최대 숫자 접미 + 1. COUNT 기반은 삭제 후 중복 사번이 나온다.
    const [existing] = await pool.execute('SELECT emp_no FROM employees')
    const maxNo = existing.reduce((m, r) => Math.max(m, parseInt(String(r.emp_no || '').replace(/[^0-9]/g, ''), 10) || 0), 0)
    const emp_no = 'EMP-' + String(maxNo + 1).padStart(3, '0')
    // active는 상태에서 파생(퇴사만 비활성) — 클라 값 대신 서버가 단일 소스로 계산.
    const st = status || '재직'
    await pool.execute(
      `INSERT INTO employees (id, emp_no, name, role, department, base_salary, join_date, birth_date, status, active,
        position_allowance, meal_allowance, vehicle_allowance, dependents, child_dependents, person_kind, leave_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, emp_no, name, role||'', department||'', base_salary||0, join_date||null, birth_date||null,
       st, st === '퇴사' ? 0 : 1,
       position_allowance||0, meal_allowance||0, vehicle_allowance||0,
       dependents == null ? 1 : dependents, child_dependents||0,
       person_kind === 'worker' ? 'worker' : 'employee', leave_date||null]
    )
    res.json({ id, emp_no })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, role, department, base_salary, join_date, birth_date, active, status,
            position_allowance, meal_allowance, vehicle_allowance, dependents, child_dependents,
            person_kind, leave_date } = req.body
    // 상태를 단일 소스로: status가 오면 그걸 저장하고 active를 파생(퇴사만 비활성).
    // (하위호환: status 없이 active만 오던 옛 호출은 active로 상태를 역산.)
    const st = status != null ? status : (active === false ? '퇴사' : '재직')
    // person_kind는 옛 호출(미전송)이 기존 값을 덮어쓰지 않도록 COALESCE로 보존.
    const [result] = await pool.execute(
      `UPDATE employees SET name=?, role=?, department=?, base_salary=?, join_date=?, birth_date=?, status=?, active=?,
        position_allowance=?, meal_allowance=?, vehicle_allowance=?, dependents=?, child_dependents=?,
        person_kind=COALESCE(?, person_kind), leave_date=?
       WHERE id=?`,
      [name, role||'', department||'', base_salary||0, join_date||null, birth_date||null, st, st === '퇴사' ? 0 : 1,
       position_allowance||0, meal_allowance||0, vehicle_allowance||0,
       dependents == null ? 1 : dependents, child_dependents||0,
       person_kind === 'worker' ? 'worker' : (person_kind === 'employee' ? 'employee' : null),
       st === '퇴사' ? (leave_date || null) : null, req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await pool.execute('DELETE FROM employees WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) {
    // 근로계약·급여·거래에 연결된 직원은 FK로 막힌다 → 500 대신 친절한 안내(삭제 말고 퇴사 처리 유도).
    if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.errno === 1451) {
      return res.status(409).json({ error: '급여·계약·거래 이력이 있는 직원은 삭제할 수 없어요. 퇴사 처리를 이용하세요.' })
    }
    next(e)
  }
})

module.exports = router
