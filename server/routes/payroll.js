const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError } = require('../lib/ledger')
const { laborAcctCode, laborCategory } = require('../lib/acctCode')

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
// 읽기 전용이라 트랜잭션이 필요 없다. 예전에는 커넥션 하나를 잡아 아래 N+1 루프
// (행마다 enrich 가 추가 질의) 내내 쥐고 있었는데, 테넌트 풀은 작아서(기본 3)
// 급여 화면 몇 개만 동시에 열려도 고갈된다. getConnection 이 try 밖이라
// 획득 실패가 라우트를 빠져나가던 문제도 함께 사라진다.
router.get('/', async (req, res, next) => {
  try {
    const conn = req.db
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
  } catch (e) { next(e) }
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
    /* created=0 인 이유를 구분해 돌려준다.
     * 급여대장은 **근로계약(work_contracts)** 이 있어야 만들어진다. 직원만 등록해 두고
     * 생성을 누르면 0건이 되는데, 화면은 그걸 "이미 모두 작성돼 있어요"로 안내했다.
     * 전혀 다른 상황인데 같은 말이 나와서 "작성돼 있다는데 왜 대장이 비었지"에서 막힌다.
     *   noContract  — 그 달에 유효한 근로계약이 하나도 없다(등록부터 해야 한다)
     *   allExists   — 대상은 있는데 전원 이미 작성돼 있다(정상)                       */
    const eligible = byEmp.size
    res.json({
      ok: true, created, eligible, skipped: eligible - created,
      reason: created > 0 ? null : (eligible === 0 ? 'noContract' : 'allExists'),
    })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

// ── 실제 급여 지급 등록: 지출 거래 생성 + 급여대장 연결 ──
router.post('/:id/pay', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const { amount, date, account_id, method, memo } = req.body
    // 급여 지급은 실제 이체라 미래 일자 금지(앱 전체 KST 규칙 일관 — 용역 지급·거래 등록과 동일).
    const de = futureDateError(date); if (de) return res.status(400).json({ error: de })
    /* 근무계약의 소득구분을 함께 읽는다 — 아래 비목 판정에 쓴다.
       work_contract_id 가 없으면(정규 급여대장) 근로소득으로 본다.

       ⚠ 트랜잭션을 **먼저 열고 FOR UPDATE 로 잠근다.**
       예전엔 잠금 없이 읽고 바로 INSERT 해서, 같은 급여에 지급 요청이 두 번 도착하면
       지출 거래가 2건 생기고 **계좌에서 두 번 빠졌다.** 화면의 busy 가드는 같은 탭에서
       빠르게 두 번 누르는 것만 막는다 — 느려서 새로고침하고 다시 누르거나, 탭이 둘이거나,
       브라우저가 재시도하면 그대로 통과한다. 급여는 금액이 커서 한 번이면 사고다. */
    await conn.beginTransaction()
    const [[p]] = await conn.execute(
      `SELECT p.*, e.name, wc.income_type
         FROM payroll p
         JOIN employees e ON p.employee_id = e.id
         LEFT JOIN work_contracts wc ON wc.id = p.work_contract_id
        WHERE p.id = ? FOR UPDATE`, [req.params.id])
    if (!p) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const amt = Number(amount) || 0
    if (amt <= 0) { await rollbackQuietly(conn); return res.status(400).json({ error: '금액을 확인해주세요' }) }

    /* 실지급액을 넘겨 지급할 수 없다 — 중복 제출이 여기서 걸린다.
       일부 지급을 나눠 하는 건 되지만, 합계가 명세의 실지급액을 넘으면 그건 착오다. */
    const [[{ already }]] = await conn.execute(
      'SELECT COALESCE(SUM(amount),0) AS already FROM transactions WHERE payroll_id = ?', [p.id])
    const netSalary = Number(p.net_salary) || 0
    if (Number(already) + amt > netSalary) {
      await rollbackQuietly(conn)
      const remain = netSalary - Number(already)
      return res.status(409).json({
        error: remain <= 0
          ? `이미 전액(${netSalary.toLocaleString('ko-KR')}원) 지급된 급여예요. 더 지급할 금액이 없습니다.`
          : `남은 지급액은 ${remain.toLocaleString('ko-KR')}원이에요. 그보다 많이 지급할 수 없습니다.`,
      })
    }
    // 계좌가 없으면 이 지출은 어느 계좌 잔액에서도 빠지지 않는다(accounts.js calcBalance는
    // account_id로 계좌를 특정해 합산한다). 실제로 돈은 나갔는데 잔액은 그대로인 상태가 되므로
    // NULL 저장을 허용하지 않는다 — 과거 F-02와 동일 유형.
    const lerr = ledgerError({ kind: 'expense', account_id, status: '지급완료' })
    if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: lerr }) }
    // 마감된 달에는 실제 급여 지출을 만들 수 없다(신고자료와 장부 불일치 방지)
    const ce = await closedPeriodError(conn, date || kstToday())
    if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }

    /* 비목·적요를 소득구분에 맞춘다.
     *
     * 여태 소득구분과 무관하게 '급여'로 박았다. 그래서 **사업소득 용역비가 인건비(급여)로
     * 기표되어** 손익계산서의 급여 항목이 부풀고 외주비는 비었다. 원천징수 신고 구분과도
     * 어긋난다(근로소득 vs 사업소득).
     *
     * 게다가 '급여'라는 비목은 기준정보에 없는 경우가 많다(생산 급여/관리 급여로 나뉜다) →
     * 비목별 집계에서 미분류로 빠졌다. 그래서 후보 중 **그 회사에 실제로 있는 비목**을
     * 먼저 찾고, 없을 때만 기본 이름을 쓴다. */
    const category = laborCategory(p.income_type)
    const payLabel = category

    // (트랜잭션은 위에서 이미 열려 있다 — 급여 행을 FOR UPDATE 로 잠근 그 트랜잭션이다)
    const txnId = randomUUID()
    await conn.execute(`
      INSERT INTO transactions (id, kind, account_id, account_code, category, amount, date, method, status, employee_id, payroll_id, memo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [txnId, 'expense', account_id, laborAcctCode(p.income_type), category, amt, date || kstToday(),
        method || '계좌이체', '지급완료', p.employee_id, p.id, memo || `${p.month} ${p.name} ${payLabel} 지급`])
    /* ↑ account_code 를 반드시 넣는다. 없으면 일계표가 이 거래의 상대 계정을 못 찾아
     *   차변·대변이 안 맞는다 — 급여는 매달 나가므로 그 화면이 늘 경고 상태가 된다. */
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
    /* 마감된 달의 지출 거래는 지울 수 없다.
     * 거래내역 화면(routes/transactions.js DELETE)은 같은 삭제를 마감으로 막는데
     * 여기만 뚫려 있어서, 마감·신고를 끝낸 달의 급여 지출이 사후에 사라지고
     * 계좌 잔액과 그 달 손익이 바뀌었다. */
    const [[txn]] = await conn.execute(
      'SELECT date FROM transactions WHERE id = ? AND payroll_id = ?', [req.params.txnId, req.params.id])
    if (txn) {
      const ce = await closedPeriodError(conn, txn.date)
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
    }
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
