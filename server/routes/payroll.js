const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { rollbackQuietly } = require('../lib/tx')

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
    qty_lines: parseItems(p.qty_lines),   // 용역·일용 단가×수량 라인(있으면)
    payments: txns,
    paid,
    remain,                       // 양수=미지급, 음수=과지급
    unpaid: remain > 0 ? remain : 0,
    overpaid: remain < 0 ? -remain : 0,
    payStatus: paid <= 0 ? '미지급' : remain > 0 ? '일부지급' : remain < 0 ? '과지급' : '지급완료',
  }
}

// ── 목록: ?month= 월별, ?scope= labor(급여대장, seq=0 기본) | service(용역·일용 회차, seq>=1) | all ──
router.get('/', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const { month, scope } = req.query
    // 급여대장(근로)은 seq=0만. 용역·일용은 seq>=1. 기본은 labor(급여대장 화면 호환).
    const seqCond = scope === 'service' ? ' AND p.seq > 0' : scope === 'all' ? '' : ' AND p.seq = 0'
    const base = 'SELECT p.*, e.name, e.role, e.department, e.emp_no, e.join_date, e.birth_date FROM payroll p JOIN employees e ON p.employee_id = e.id'
    const [rows] = month
      ? await conn.execute(base + ' WHERE p.month = ?' + seqCond + ' ORDER BY e.department, e.name, p.seq', [month])
      : await conn.execute(base + ' WHERE 1=1' + seqCond + ' ORDER BY p.month DESC, e.name, p.seq')
    const out = []
    for (const p of rows) out.push(await enrich(conn, p))
    res.json(out)
  } catch (e) { next(e) } finally { conn.release() }
})

// ── 대표님용 요약: 지급 예정일 · 미지급 총액 · 과지급 건 ──
router.get('/summary', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const month = req.query.month || kstToday().slice(0, 7)
    // 급여대장 요약은 근로(seq=0)만 — 용역·일용 회차가 섞여 총액이 부풀지 않게
    const [rows] = await conn.execute(
      'SELECT p.*, e.name, e.department FROM payroll p JOIN employees e ON p.employee_id = e.id WHERE p.month = ? AND p.seq = 0',
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
  const conn = await req.db.getConnection()
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
    await req.db.execute(`
      INSERT INTO payroll (id, employee_id, month, base_salary, allowance, deduction, net_salary, gross, items, pay_date, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE base_salary=VALUES(base_salary), allowance=VALUES(allowance),
        deduction=VALUES(deduction), net_salary=VALUES(net_salary), gross=VALUES(gross),
        items=VALUES(items), pay_date=VALUES(pay_date), status=VALUES(status)
    `, [rowId, employee_id, month, base, allowance, deduction, net, gross, itemsJson, pay_date || `${month}-25`, status || '확정'])
    res.json({ ok: true, id: rowId, base, gross, deduction, net })
  } catch (e) { next(e) }
})

// ── 월 급여대장 일괄 생성: 그 달에 유효한 근로계약 기준으로 미작성분만(seq=0) ──
// 소스는 근로계약(work_contracts.pay_items). 급여 항목 마스터는 계약 pay_items의 '초기값'을 만드는
// 템플릿으로 역할이 물러났다. 계약이 없거나 pay_items가 비면 예전 방식(직원 컬럼)으로 폴백한다.
router.post('/generate', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const { month, pay_date } = req.body
    if (!month) return res.status(400).json({ error: 'month 필수' })
    const monthStart = `${month}-01`
    const monthEnd = `${month}-31`
    // 그 달에 유효한 근로계약: 시작 <= 월말 AND (종료 없음 OR 종료 >= 월초) AND 진행중 + 직원 재직
    const [contracts] = await conn.execute(
      `SELECT w.*, e.name FROM work_contracts w JOIN employees e ON w.employee_id = e.id
       WHERE w.kind = 'labor' AND w.status = '진행중' AND e.active = 1
         AND (w.start_date IS NULL OR w.start_date <= ?)
         AND (w.end_date IS NULL OR w.end_date >= ?)`,
      [monthEnd, monthStart]
    )
    const [masters] = await conn.execute('SELECT * FROM payroll_item_types WHERE active = 1 ORDER BY sort_order, label')
    // 이미 근로 급여(seq=0)가 있는 직원은 건너뛴다(용역 회차 seq>=1은 무관)
    const [exist] = await conn.execute('SELECT employee_id FROM payroll WHERE month = ? AND seq = 0', [month])
    const has = new Set(exist.map(r => r.employee_id))
    await conn.beginTransaction()
    let created = 0
    // 한 직원에 계약이 여러 개면 가장 최근 시작 계약 하나만
    const byEmp = new Map()
    for (const w of contracts) {
      const prev = byEmp.get(w.employee_id)
      if (!prev || String(w.start_date || '') > String(prev.start_date || '')) byEmp.set(w.employee_id, w)
    }
    for (const w of byEmp.values()) {
      if (has.has(w.employee_id)) continue
      let items = []
      try { items = JSON.parse(w.pay_items || '[]') } catch { items = [] }
      // 계약에 급여 기준이 없으면 폴백(직원 컬럼 + 마스터) — 마이그레이션 전 데이터 보호
      if (!Array.isArray(items) || items.length === 0) {
        const [[emp]] = await conn.execute('SELECT * FROM employees WHERE id = ?', [w.employee_id])
        items = itemsFromMaster(masters, emp || {})
      }
      const { base, gross, deduction, net } = computePayslip(items)
      await conn.execute(`
        INSERT INTO payroll (id, employee_id, work_contract_id, seq, month, base_salary, allowance, deduction, net_salary, gross, items, pay_date, status)
        VALUES (?,?,?,0,?,?,?,?,?,?,?,?,?)
      `, [randomUUID(), w.employee_id, w.id, month, base, gross - base, deduction, net, gross, JSON.stringify(items),
          pay_date || (w.pay_day ? `${month}-${String(w.pay_day).padStart(2, '0')}` : `${month}-25`), '작성중'])
      created++
    }
    await conn.commit()
    res.json({ ok: true, created })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

// ── 실제 급여 지급 등록: 지출 거래 생성 + 급여대장 연결 ──
router.post('/:id/pay', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const { amount, date, account_id, method, memo } = req.body
    // 급여 지급은 실제 이체라 미래 일자 금지(앱 전체 KST 규칙 일관 — 용역 지급·거래 등록과 동일).
    const de = futureDateError(date); if (de) return res.status(400).json({ error: de })
    const [[p]] = await conn.execute('SELECT p.*, e.name FROM payroll p JOIN employees e ON p.employee_id = e.id WHERE p.id = ?', [req.params.id])
    if (!p) return res.status(404).json({ error: 'Not found' })
    const amt = Number(amount) || 0
    if (amt <= 0) return res.status(400).json({ error: '금액을 확인해주세요' })
    // 계좌가 없으면 이 지출은 어느 계좌 잔액에서도 빠지지 않는다(accounts.js calcBalance는
    // account_id로 계좌를 특정해 합산한다). 실제로 돈은 나갔는데 잔액은 그대로인 상태가 되므로
    // NULL 저장을 허용하지 않는다 — 과거 F-02와 동일 유형.
    if (!account_id) return res.status(400).json({ error: '출금 계좌를 선택해주세요' })

    await conn.beginTransaction()
    const txnId = randomUUID()
    await conn.execute(`
      INSERT INTO transactions (id, kind, account_id, category, amount, date, method, status, buyer_type, employee_id, payroll_id, memo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [txnId, 'expense', account_id, '급여', amt, date || kstToday(),
        method || '계좌이체', '지급완료', '공통', p.employee_id, p.id, memo || `${p.month} ${p.name} 급여 지급`])
    // ↑ 거래 status는 '지급완료'(공백 없음) — 계좌 잔액 계산(accounts.js)이 이 값만 지출로 센다.
    //   날짜 폴백도 kstToday() — UTC(new Date())를 쓰면 KST 새벽 등록 시 하루 전으로 찍힌다.

    // 누적 지급액으로 상태 갱신
    const [[{ paid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM transactions WHERE payroll_id = ?', [p.id])
    const net = Number(p.net_salary) || 0
    const status = Number(paid) >= net ? '지급완료' : Number(paid) > 0 ? '일부지급' : p.status
    await conn.execute('UPDATE payroll SET status = ? WHERE id = ?', [status, p.id])
    await conn.commit()
    res.json({ ok: true, txnId, paid: Number(paid), remain: net - Number(paid) })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

// ── 지급 취소(연결된 지출 삭제) ──
router.delete('/:id/pay/:txnId', async (req, res, next) => {
  const conn = await req.db.getConnection()
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
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

// 이미 지급된 급여가 붙어 있는 급여대장은 지우지 않는다.
//
// 예전에는 지출 거래의 payroll_id 만 NULL로 끊고 대장을 지웠다. 그러면 돈은 이미 나갔는데
// (거래는 '지급완료'로 남아 계좌 잔액에서도 빠진 상태) 급여대장을 다시 만들면 그 직원이
// 전액 '미지급'으로 되살아난다 → 화면이 재지급을 유도해 이중 지급이 난다.
// '지급 취소'(DELETE /:id/pay/:txnId)가 이미 있으므로, 그걸 먼저 하도록 순서를 강제한다.
async function linkedPayments(db, where, params) {
  const [[r]] = await db.execute(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS amt FROM transactions WHERE payroll_id IN (${where})`,
    params)
  return { cnt: Number(r.cnt), amt: Number(r.amt) }
}

// ── 이 달 급여대장 전체 비우기: 한 트랜잭션으로 (프론트 건별 반복 삭제의 부분 실패 방지) ──
// 급여대장(근로, seq=0)만 대상 — 용역·일용 회차(seq>=1)는 별도.
router.delete('/month/:month', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const paid = await linkedPayments(conn, 'SELECT id FROM payroll WHERE month = ? AND seq = 0', [req.params.month])
    if (paid.cnt > 0) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `이미 지급한 급여 ${paid.cnt}건(${paid.amt.toLocaleString('ko-KR')}원)이 있어 비울 수 없어요. 급여 상세에서 지급 내역을 먼저 취소해주세요.`,
      })
    }
    const [[{ cnt }]] = await conn.execute('SELECT COUNT(*) AS cnt FROM payroll WHERE month = ? AND seq = 0', [req.params.month])
    await conn.execute('DELETE FROM payroll WHERE month = ? AND seq = 0', [req.params.month])
    await conn.commit()
    res.json({ ok: true, deleted: cnt })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

router.delete('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const paid = await linkedPayments(conn, 'SELECT ?', [req.params.id])
    if (paid.cnt > 0) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `이미 지급한 급여 ${paid.cnt}건(${paid.amt.toLocaleString('ko-KR')}원)이 있어 삭제할 수 없어요. 지급 내역을 먼저 취소해주세요.`,
      })
    }
    await conn.execute('DELETE FROM payroll WHERE id = ?', [req.params.id])
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

module.exports = router
