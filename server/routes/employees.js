const { Router } = require('express')
const { randomUUID } = require('crypto')

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM employees ORDER BY emp_no ASC')
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { name, role, department, base_salary, join_date, birth_date, status,
            position_allowance, meal_allowance, vehicle_allowance, dependents, child_dependents,
            person_kind, leave_date, salary_account } = req.body
    const id = randomUUID()
    // 사번은 기존 최대 숫자 접미 + 1. COUNT 기반은 삭제 후 중복 사번이 나온다.
    const [existing] = await req.db.execute('SELECT emp_no FROM employees')
    const maxNo = existing.reduce((m, r) => Math.max(m, parseInt(String(r.emp_no || '').replace(/[^0-9]/g, ''), 10) || 0), 0)
    const emp_no = 'EMP-' + String(maxNo + 1).padStart(3, '0')
    // active는 상태에서 파생(퇴사만 비활성) — 클라 값 대신 서버가 단일 소스로 계산.
    const st = status || '재직'
    await req.db.execute(
      `INSERT INTO employees (id, emp_no, name, role, department, base_salary, join_date, birth_date, status, active,
        position_allowance, meal_allowance, vehicle_allowance, dependents, child_dependents, person_kind, leave_date, salary_account)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, emp_no, name, role||'', department||'', base_salary||0, join_date||null, birth_date||null,
       st, st === '퇴사' ? 0 : 1,
       position_allowance||0, meal_allowance||0, vehicle_allowance||0,
       dependents == null ? 1 : dependents, child_dependents||0,
       person_kind === 'worker' ? 'worker' : 'employee', leave_date||null, salary_account||null]
    )
    res.json({ id, emp_no })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, role, department, base_salary, join_date, birth_date, active, status,
            position_allowance, meal_allowance, vehicle_allowance, dependents, child_dependents,
            person_kind, leave_date, salary_account } = req.body
    // 상태를 단일 소스로: status가 오면 그걸 저장하고 active를 파생(퇴사만 비활성).
    // ⚠ 상태·재직 정보를 아예 안 보낸 부분 업데이트(근로계약 편집 등)는 기존 상태를 유지한다.
    //   예전엔 미전송 시 '재직'으로 강제해, 퇴사자의 계약을 편집하면 직원이 조용히 부활했다.
    const hasStatusInput = status !== undefined || active !== undefined
    const st = status != null ? status : (active === false ? '퇴사' : '재직')
    const stCol     = hasStatusInput ? st : null                       // null → COALESCE로 기존 유지
    const activeCol = hasStatusInput ? (st === '퇴사' ? 0 : 1) : null   // null → 기존 유지
    // leave_date: 상태를 바꿀 때만 세팅(퇴사=날짜, 재직=비움). 미전송이면 기존 유지.
    const leaveGuard = hasStatusInput ? 1 : null
    const leaveVal   = hasStatusInput ? (st === '퇴사' ? (leave_date || null) : null) : null
    // ⚠ 부분 업데이트 보존: WorkContract 등은 name·status 등 일부만 보낸다. 그때 급여·수당·부양가족을
    //   기본값(0/1)으로 덮어쓰면 직원의 급여정보가 조용히 사라진다 → 모든 선택 필드를 COALESCE로 보존.
    //   보낸 필드만 갱신, 안 보낸(undefined) 필드는 유지. 값을 지우려면 명시적으로 빈값/0을 보내야 한다.
    //   (mysql2는 undefined 바인딩을 거부하므로 undefined→null로 변환해서 넘긴다)
    const keep = (v) => (v === undefined ? null : v)
    const keepNum = (v) => (v === undefined ? null : (parseInt(String(v).replace(/[^0-9-]/g, ''), 10) || 0))
    const [result] = await req.db.execute(
      `UPDATE employees SET
         name=?,
         status=COALESCE(?, status), active=COALESCE(?, active),
         role=COALESCE(?, role), department=COALESCE(?, department),
         base_salary=COALESCE(?, base_salary), join_date=COALESCE(?, join_date), birth_date=COALESCE(?, birth_date),
         position_allowance=COALESCE(?, position_allowance), meal_allowance=COALESCE(?, meal_allowance),
         vehicle_allowance=COALESCE(?, vehicle_allowance), dependents=COALESCE(?, dependents),
         child_dependents=COALESCE(?, child_dependents),
         person_kind=COALESCE(?, person_kind), salary_account=COALESCE(?, salary_account),
         leave_date=CASE WHEN ? IS NULL THEN leave_date ELSE ? END
       WHERE id=?`,
      [name, stCol, activeCol,
       keep(role), keep(department),
       keepNum(base_salary), keep(join_date), keep(birth_date),
       keepNum(position_allowance), keepNum(meal_allowance),
       keepNum(vehicle_allowance), keepNum(dependents),
       keepNum(child_dependents),
       person_kind === 'worker' ? 'worker' : (person_kind === 'employee' ? 'employee' : null),
       salary_account === undefined ? null : (salary_account || ''),
       leaveGuard, leaveVal, req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM employees WHERE id = ?', [req.params.id])
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
