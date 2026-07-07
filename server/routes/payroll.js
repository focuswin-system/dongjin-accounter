const { Router } = require('express')
const { randomUUID } = require('crypto')
const { pool } = require('../db')

const router = Router()

// ── 급여 항목(JSON) → 금액 계산 ──
// item: { label, kind:'earn'|'deduct', mode:'fixed'|'percent', value }
// percent 항목은 '지급(earn) 중 고정금액 합계'(≈보수월액)를 기준으로 계산
function computePayslip(items) {
  const list = Array.isArray(items) ? items : []
  const earnFixed = list
    .filter(i => i.kind === 'earn' && i.mode === 'fixed')
    .reduce((s, i) => s + (Number(i.value) || 0), 0)
  const calc = list.map(i => {
    const v = Number(i.value) || 0
    const amount = i.mode === 'percent' ? Math.round(earnFixed * v / 100) : Math.round(v)
    return { label: i.label || '', kind: i.kind === 'deduct' ? 'deduct' : 'earn', mode: i.mode === 'percent' ? 'percent' : 'fixed', value: v, amount }
  })
  const base       = (list.find(i => i.kind === 'earn' && /기본급/.test(i.label || ''))?.value) || earnFixed
  const gross      = calc.filter(i => i.kind === 'earn').reduce((s, i) => s + i.amount, 0)
  const deduction  = calc.filter(i => i.kind === 'deduct').reduce((s, i) => s + i.amount, 0)
  const net        = gross - deduction
  return { calc, base: Number(base) || 0, gross, deduction, net }
}

// 급여 항목 마스터를 직원 고정 급여(기본급·직책수당·식대·자가운전)에 맞춰 명세 항목으로 변환
// 직원 마스터에 등록된 고정 수당이 있으면 라벨을 유연 매칭해 그 값을 자동으로 채운다.
// (마스터 라벨이 '식대(비과세)'·'자가운전보조' 등으로 달라도 매칭되도록 정규식 사용)
function itemsFromMaster(masters, emp) {
  const base = Number(emp.base_salary) || 0
  const meal = Number(emp.meal_allowance)     || 0
  const car  = Number(emp.vehicle_allowance)  || 0
  const pos  = Number(emp.position_allowance) || 0
  const empValueFor = (label) => {
    const l = String(label || '')
    if (/기본급/.test(l))          return base
    if (/직책|직급/.test(l))       return pos
    if (/식대/.test(l))            return meal
    if (/자가운전|차량|운전/.test(l)) return car
    return null
  }
  let items
  if (!masters.length) {
    items = [{ label: '기본급', kind: 'earn', mode: 'fixed', value: base }]
  } else {
    items = masters.map(m => {
      const ev = (m.kind === 'earn' && m.mode === 'fixed') ? empValueFor(m.label) : null
      return {
        label: m.label,
        kind: m.kind,
        mode: m.mode,
        value: ev != null ? ev : (Number(m.default_value) || 0),
      }
    })
  }
  // 기본급 항목이 아예 없으면 맨 앞에 추가한다.
  if (!items.some(i => i.kind === 'earn' && /기본급/.test(i.label || ''))) {
    items.unshift({ label: '기본급', kind: 'earn', mode: 'fixed', value: base })
  }
  return items
}

function parseItems(raw) {
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] }
}

// 급여대장 행 1건을 응답용으로 가공(지급액·미지급/과지급 포함)
async function enrich(conn, p) {
  const [txns] = await conn.execute(
    'SELECT id, amount, date, method, account_id, memo FROM transactions WHERE payroll_id = ? ORDER BY date',
    [p.id]
  )
  const paid = txns.reduce((s, t) => s + Number(t.amount), 0)
  const net = Number(p.net_salary) || 0
  const remain = net - paid
  return {
    ...p,
    items: parseItems(p.items),
    payments: txns,
    paid,
    remain,                       // 양수=미지급, 음수=과지급
    unpaid: remain > 0 ? remain : 0,
    overpaid: remain < 0 ? -remain : 0,
    payStatus: paid <= 0 ? '미지급' : remain > 0 ? '일부지급' : remain < 0 ? '과지급' : '지급완료',
  }
}

// ── 목록: ?month= 으로 월별, 없으면 전체 ──
router.get('/', async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    const { month } = req.query
    const base = 'SELECT p.*, e.name, e.role, e.department, e.emp_no, e.join_date, e.birth_date FROM payroll p JOIN employees e ON p.employee_id = e.id'
    const [rows] = month
      ? await conn.execute(base + ' WHERE p.month = ? ORDER BY e.department, e.name', [month])
      : await conn.execute(base + ' ORDER BY p.month DESC, e.name')
    const out = []
    for (const p of rows) out.push(await enrich(conn, p))
    res.json(out)
  } catch (e) { next(e) } finally { conn.release() }
})

// ── 대표님용 요약: 지급 예정일 · 미지급 총액 · 과지급 건 ──
router.get('/summary', async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7)
    const [rows] = await conn.execute(
      'SELECT p.*, e.name, e.department FROM payroll p JOIN employees e ON p.employee_id = e.id WHERE p.month = ?',
      [month]
    )
    const list = []
    for (const p of rows) list.push(await enrich(conn, p))
    const netTotal    = list.reduce((s, r) => s + (Number(r.net_salary) || 0), 0)
    const paidTotal   = list.reduce((s, r) => s + r.paid, 0)
    const unpaidTotal = list.reduce((s, r) => s + r.unpaid, 0)
    const overItems   = list.filter(r => r.overpaid > 0).map(r => ({ name: r.name, amount: r.overpaid, month: r.month }))
    const unpaidItems = list.filter(r => r.unpaid > 0).map(r => ({ name: r.name, amount: r.unpaid, month: r.month }))
    const payDate = list.map(r => r.pay_date).filter(Boolean).sort()[0] || `${month}-25`
    res.json({
      month, payDate,
      count: list.length,
      netTotal, paidTotal, unpaidTotal,
      overpaidCount: overItems.length,
      overItems, unpaidItems,
    })
  } catch (e) { next(e) } finally { conn.release() }
})

// ── 직원별 전월 이력(미지급/과지급 누계) ──
router.get('/employee/:id', async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    const [[emp]] = await conn.execute('SELECT * FROM employees WHERE id = ?', [req.params.id])
    if (!emp) return res.status(404).json({ error: 'Not found' })
    const [rows] = await conn.execute(
      'SELECT p.*, e.name, e.department FROM payroll p JOIN employees e ON p.employee_id = e.id WHERE p.employee_id = ? ORDER BY p.month DESC',
      [req.params.id]
    )
    const months = []
    for (const p of rows) months.push(await enrich(conn, p))
    const unpaidTotal  = months.reduce((s, m) => s + m.unpaid, 0)
    const overpaidTotal = months.reduce((s, m) => s + m.overpaid, 0)
    res.json({ employee: { id: emp.id, name: emp.name, department: emp.department, role: emp.role }, months, unpaidTotal, overpaidTotal })
  } catch (e) { next(e) } finally { conn.release() }
})

// ── 명세 저장(생성/수정): employee_id + month 기준 upsert ──
router.post('/', async (req, res, next) => {
  try {
    const { id, employee_id, month, items, pay_date, status } = req.body
    if (!employee_id || !month) return res.status(400).json({ error: 'employee_id, month 필수' })
    const { base, gross, deduction, net } = computePayslip(items)
    const allowance = gross - base
    const itemsJson = JSON.stringify(Array.isArray(items) ? items : [])
    const rowId = id || randomUUID()
    await pool.execute(`
      INSERT INTO payroll (id, employee_id, month, base_salary, allowance, deduction, net_salary, gross, items, pay_date, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE base_salary=VALUES(base_salary), allowance=VALUES(allowance),
        deduction=VALUES(deduction), net_salary=VALUES(net_salary), gross=VALUES(gross),
        items=VALUES(items), pay_date=VALUES(pay_date), status=VALUES(status)
    `, [rowId, employee_id, month, base, allowance, deduction, net, gross, itemsJson, pay_date || `${month}-25`, status || '확정'])
    res.json({ ok: true, id: rowId, base, gross, deduction, net })
  } catch (e) { next(e) }
})

// ── 월 급여대장 일괄 생성: 재직 직원 중 미작성분만 기본 템플릿으로 ──
router.post('/generate', async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    const { month, pay_date } = req.body
    if (!month) return res.status(400).json({ error: 'month 필수' })
    const [emps] = await conn.execute("SELECT * FROM employees WHERE active = 1")
    const [masters] = await conn.execute('SELECT * FROM payroll_item_types WHERE active = 1 ORDER BY sort_order, label')
    const [exist] = await conn.execute('SELECT employee_id FROM payroll WHERE month = ?', [month])
    const has = new Set(exist.map(r => r.employee_id))
    await conn.beginTransaction()
    let created = 0
    for (const e of emps) {
      if (has.has(e.id)) continue
      const items = itemsFromMaster(masters, e)
      const { base, gross, deduction, net } = computePayslip(items)
      await conn.execute(`
        INSERT INTO payroll (id, employee_id, month, base_salary, allowance, deduction, net_salary, gross, items, pay_date, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `, [randomUUID(), e.id, month, base, gross - base, deduction, net, gross, JSON.stringify(items), pay_date || `${month}-25`, '작성중'])
      created++
    }
    await conn.commit()
    res.json({ ok: true, created })
  } catch (e) { await conn.rollback(); next(e) } finally { conn.release() }
})

// ── 실제 급여 지급 등록: 지출 거래 생성 + 급여대장 연결 ──
router.post('/:id/pay', async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    const { amount, date, account_id, method, memo } = req.body
    const [[p]] = await conn.execute('SELECT p.*, e.name FROM payroll p JOIN employees e ON p.employee_id = e.id WHERE p.id = ?', [req.params.id])
    if (!p) return res.status(404).json({ error: 'Not found' })
    const amt = Number(amount) || 0
    if (amt <= 0) return res.status(400).json({ error: '금액을 확인해주세요' })

    await conn.beginTransaction()
    const txnId = randomUUID()
    await conn.execute(`
      INSERT INTO transactions (id, kind, account_id, category, amount, date, method, status, buyer_type, employee_id, payroll_id, memo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [txnId, 'expense', account_id || null, '급여', amt, date || new Date().toISOString().slice(0, 10),
        method || '계좌이체', '지급 완료', '공통', p.employee_id, p.id, memo || `${p.month} ${p.name} 급여 지급`])

    // 누적 지급액으로 상태 갱신
    const [[{ paid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM transactions WHERE payroll_id = ?', [p.id])
    const net = Number(p.net_salary) || 0
    const status = Number(paid) >= net ? '지급완료' : Number(paid) > 0 ? '일부지급' : p.status
    await conn.execute('UPDATE payroll SET status = ? WHERE id = ?', [status, p.id])
    await conn.commit()
    res.json({ ok: true, txnId, paid: Number(paid), remain: net - Number(paid) })
  } catch (e) { await conn.rollback(); next(e) } finally { conn.release() }
})

// ── 지급 취소(연결된 지출 삭제) ──
router.delete('/:id/pay/:txnId', async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.execute('DELETE FROM transactions WHERE id = ? AND payroll_id = ?', [req.params.txnId, req.params.id])
    const [[p]] = await conn.execute('SELECT * FROM payroll WHERE id = ?', [req.params.id])
    if (p) {
      const [[{ paid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM transactions WHERE payroll_id = ?', [p.id])
      const net = Number(p.net_salary) || 0
      const status = Number(paid) >= net && net > 0 ? '지급완료' : Number(paid) > 0 ? '일부지급' : '확정'
      await conn.execute('UPDATE payroll SET status = ? WHERE id = ?', [status, p.id])
    }
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await conn.rollback(); next(e) } finally { conn.release() }
})

router.delete('/:id', async (req, res, next) => {
  try {
    // 연결된 급여 지출의 연결만 해제(거래 자체는 보존)
    await pool.execute('UPDATE transactions SET payroll_id = NULL WHERE payroll_id = ?', [req.params.id])
    await pool.execute('DELETE FROM payroll WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
