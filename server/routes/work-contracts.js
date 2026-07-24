const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError } = require('../lib/ledger')
const { removeUploadedFile } = require('../lib/uploads')

const router = Router()

const KINDS = ['labor', 'service', 'daily']
const INCOME = ['근로', '사업', '일용', '기타']
const FORMS = ['annual', 'monthly', 'hourly', 'daily', 'piece']
const TERMS = ['fixed', 'auto_renew', 'open']
const tinyint = (v) => (v ? 1 : 0)
// JSON 컬럼(pay_items/qty_lines/items)은 항상 JSON.stringify로 쓰지만, 혹시 손상된 행 하나가
// 상세 응답 전체를 500으로 만들지 않도록 안전 파싱한다(payroll.js parseItems와 같은 방어).
const safeParse = (raw) => { if (!raw) return []; try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] } }

// 사번 채번: 기존 emp_no의 최대 숫자 접미 + 1. COUNT 기반은 삭제 후 중복 사번이 나온다.
async function nextEmpNo(conn) {
  const [rows] = await conn.execute('SELECT emp_no FROM employees')
  let max = 0
  for (const r of rows) { const n = parseInt(String(r.emp_no || '').replace(/[^0-9]/g, ''), 10); if (n > max) max = n }
  return 'EMP-' + String(max + 1).padStart(3, '0')
}

// 급여/용역 항목(JSON) → 금액. percent 항목은 '지급(earn) 고정금액 합계' 기준.
// (payroll.js computePayslip와 동일 규칙 — 명세서 계산이 한 곳에서만 정의되도록 맞춘다)
function computeItems(items) {
  const list = Array.isArray(items) ? items : []
  const earnFixed = list.filter(i => i.kind === 'earn' && i.mode === 'fixed')
    .reduce((s, i) => s + (Number(i.value) || 0), 0)
  const calc = list.map(i => {
    const v = Number(i.value) || 0
    const amount = i.mode === 'percent' ? Math.round(earnFixed * v / 100) : Math.round(v)
    return { label: i.label || '', kind: i.kind === 'deduct' ? 'deduct' : 'earn',
             mode: i.mode === 'percent' ? 'percent' : 'fixed', value: v, amount }
  })
  const base = (list.find(i => i.kind === 'earn' && /기본급/.test(i.label || ''))?.value) || earnFixed
  const gross = calc.filter(i => i.kind === 'earn').reduce((s, i) => s + i.amount, 0)
  const deduction = calc.filter(i => i.kind === 'deduct').reduce((s, i) => s + i.amount, 0)
  return { calc, base: Number(base) || 0, gross, deduction, net: gross - deduction }
}

// 요청 body → 계약 컬럼. 유형에 안 맞는 필드는 정리한다.
function normalize(body) {
  const kind = KINDS.includes(body.kind) ? body.kind : 'labor'
  const income = INCOME.includes(body.income_type) ? body.income_type
    : (kind === 'daily' ? '일용' : kind === 'service' ? '사업' : '근로')
  const term = TERMS.includes(body.term_mode) ? body.term_mode : 'fixed'
  return {
    kind, income_type: income, term_mode: term,
    title: body.title || null,
    employ_type_id: body.employ_type_id || null,
    employ_type: body.employ_type || null,
    start_date: body.start_date || null,
    end_date: term === 'open' ? null : (body.end_date || null),
    status: body.status || '진행중',
    pay_form: FORMS.includes(body.pay_form) ? body.pay_form : 'monthly',
    work_hours: body.work_hours || null,
    pay_day: Number(body.pay_day) >= 1 && Number(body.pay_day) <= 31 ? Number(body.pay_day) : null,
    pay_items: kind === 'labor' ? JSON.stringify(Array.isArray(body.pay_items) ? body.pay_items : []) : null,
    insure_np: tinyint(body.insure_np), insure_hi: tinyint(body.insure_hi),
    insure_ei: tinyint(body.insure_ei), insure_ai: tinyint(body.insure_ai),
    // 일용인데 값이 안 오면 3개월(일반 일용 상용전환 기준)을 기본으로 — 안 그러면 경고가 영영 안 뜬다.
    conv_alert_months: Number(body.conv_alert_months) || (kind === 'daily' ? 3 : 0),
    memo: body.memo || null,
  }
}

// 단가표 통째 교체 (기성형 replaceContractItems와 같은 방식)
async function replaceItems(conn, wcId, items) {
  await conn.execute('DELETE FROM work_contract_items WHERE work_contract_id = ?', [wcId])
  if (!Array.isArray(items)) return
  let ord = 0
  for (const it of items) {
    const nm = (it && it.name != null) ? String(it.name).trim() : ''
    if (!nm) continue
    const price = Number(String(it.unit_price ?? '').replace(/[^0-9]/g, '')) || 0
    await conn.execute(
      'INSERT INTO work_contract_items (id, work_contract_id, item_id, name, spec, unit, unit_price, sort_order) VALUES (?,?,?,?,?,?,?,?)',
      [randomUUID(), wcId, it.item_id || null, nm, it.spec || null, it.unit || null, price, ++ord]
    )
  }
}

// 계약 한 건에 용역·일용 누적/미지급을 붙인다(payroll 회차 집계).
async function withMetrics(conn, c) {
  const [[agg]] = await conn.execute(
    `SELECT COALESCE(SUM(p.net_salary),0) AS net_sum,
            COALESCE((SELECT SUM(t.amount) FROM transactions t
                      JOIN payroll p2 ON t.payroll_id = p2.id
                      WHERE p2.work_contract_id = ?),0) AS paid_sum,
            COUNT(*) AS pay_count
       FROM payroll p WHERE p.work_contract_id = ?`,
    [c.id, c.id]
  )
  const netSum = Number(agg.net_sum), paidSum = Number(agg.paid_sum)
  return { ...c, net_sum: netSum, paid_sum: paidSum,
           unpaid: Math.max(0, netSum - paidSum), pay_count: Number(agg.pay_count) }
}

// ── 목록: ?kind= (labor / service,daily) ──
// 읽기 전용이라 트랜잭션이 필요 없다. 예전에는 커넥션을 하나 잡아 아래 N+1 루프 내내
// 쥐고 있었는데, 테넌트 풀은 작아서(기본 3) 목록 몇 개만 동시에 열려도 고갈된다.
// 게다가 getConnection() 이 try 밖에 있어 획득 실패가 라우트를 빠져나갔다.
router.get('/', async (req, res, next) => {
  try {
    const conn = req.db
    const { kind, income_type, status } = req.query
    let sql = `SELECT w.*, e.name AS employee_name, e.emp_no, e.department, e.status AS emp_status, e.leave_date
               FROM work_contracts w LEFT JOIN employees e ON w.employee_id = e.id WHERE 1=1`
    const params = []
    if (kind) {
      // 'service,daily' 처럼 콤마로 여러 kind
      const ks = kind.split(',').filter(k => KINDS.includes(k))
      if (ks.length) { sql += ` AND w.kind IN (${ks.map(() => '?').join(',')})`; params.push(...ks) }
    }
    if (income_type && INCOME.includes(income_type)) { sql += ' AND w.income_type = ?'; params.push(income_type) }
    if (status) { sql += ' AND w.status = ?'; params.push(status) }
    sql += ' ORDER BY w.created_at DESC'
    const [rows] = await conn.execute(sql, params)
    const out = []
    for (const r of rows) {
      // 근로계약의 '월 기준급여'는 계약 pay_items로 계산(급여대장 생성 전에도 보이게).
      let monthly_net = 0
      if (r.kind === 'labor' && r.pay_items) {
        try { monthly_net = computeItems(JSON.parse(r.pay_items)).net } catch {}
      }
      out.push(await withMetrics(conn, { ...r, pay_items: undefined, monthly_net }))
    }
    res.json(out)
  } catch (e) { next(e) }
})

// ── 상용전환 경고 대상: 일용 계약 중 계속 고용 개월수 >= conv_alert_months ──
// ⚠ '/:id' 보다 먼저 선언해야 한다(안 그러면 id='alerts'로 잡힌다).
router.get('/alerts/conversion', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT w.id, w.title, w.conv_alert_months, w.start_date, e.name AS employee_name,
              (SELECT MAX(p.month) FROM payroll p WHERE p.work_contract_id = w.id) AS last_month,
              TIMESTAMPDIFF(MONTH, w.start_date,
                CONCAT(COALESCE((SELECT MAX(p.month) FROM payroll p WHERE p.work_contract_id = w.id), DATE_FORMAT(CURDATE(),'%Y-%m')), '-01')) AS months
       FROM work_contracts w JOIN employees e ON w.employee_id = e.id
       WHERE w.kind = 'daily' AND w.status = '진행중' AND w.start_date IS NOT NULL AND w.conv_alert_months > 0
       HAVING months >= w.conv_alert_months
       ORDER BY months DESC`
    )
    res.json(rows.map(r => ({ ...r, months: Number(r.months) })))
  } catch (e) { next(e) }
})

// ── 상세: 계약 + 단가표 + 첨부 + 지급 회차 + 품목별 누적 ──
router.get('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const [[c]] = await conn.execute(
      `SELECT w.*, e.name AS employee_name, e.emp_no, e.role, e.department, e.birth_date, e.salary_account, e.join_date, e.status AS emp_status, e.leave_date
       FROM work_contracts w LEFT JOIN employees e ON w.employee_id = e.id WHERE w.id = ?`,
      [req.params.id]
    )
    if (!c) return res.status(404).json({ error: 'Not found' })
    const [items] = await conn.execute(
      'SELECT id, item_id, name, spec, unit, unit_price, sort_order FROM work_contract_items WHERE work_contract_id = ? ORDER BY sort_order, name',
      [req.params.id]
    )
    const [docs] = await conn.execute(
      'SELECT id, file_url, file_name, created_at FROM work_contract_docs WHERE work_contract_id = ? ORDER BY created_at',
      [req.params.id]
    )
    // 지급 회차(payroll) + 각 회차의 실지급액
    const [pays] = await conn.execute(
      `SELECT p.id, p.month, p.seq, p.gross, p.deduction, p.net_salary, p.pay_date, p.status, p.items, p.qty_lines,
              COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.payroll_id = p.id),0) AS paid
       FROM payroll p WHERE p.work_contract_id = ? ORDER BY p.month DESC, p.seq DESC`,
      [req.params.id]
    )
    const payments = pays.map(p => {
      const net = Number(p.net_salary) || 0, paid = Number(p.paid)
      return { ...p, gross: Number(p.gross), deduction: Number(p.deduction), net_salary: net, paid,
               remain: net - paid, unpaid: Math.max(0, net - paid), overpaid: Math.max(0, paid - net),
               items: safeParse(p.items),          // 명세서 출력이 지급/공제 라인을 읽는다
               qty_lines: safeParse(p.qty_lines),
               payStatus: paid <= 0 ? '미지급' : net - paid > 0 ? '일부지급' : paid - net > 0 ? '과지급' : '지급완료' }
    })
    // 품목(업무)별 누적 — 용역·일용 단가×수량 라인 집계
    const lineAgg = {}
    for (const p of pays) {
      const lines = safeParse(p.qty_lines)
      for (const l of lines) {
        const key = l.name || '기타'
        if (!lineAgg[key]) lineAgg[key] = { name: key, unit: l.unit || null, qty_sum: 0, amount_sum: 0 }
        lineAgg[key].qty_sum += Number(l.qty) || 0
        lineAgg[key].amount_sum += Number(l.amount) || 0
      }
    }
    const withM = await withMetrics(conn, c)
    res.json({
      ...withM,
      pay_items: safeParse(c.pay_items),
      items: items.map(i => ({ ...i, unit_price: Number(i.unit_price) })),
      attachments: docs.map(d => ({ id: d.id, url: d.file_url, name: d.file_name || '계약서' })),
      payments,
      item_progress: Object.values(lineAgg),
    })
  } catch (e) { next(e) } finally { conn.release() }
})

// ── 계약 생성. body.employee(신규 인력)면 사람도 함께 만든다. ──
router.post('/', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    let employeeId = req.body.employee_id
    // 신규 인력 동시 등록
    if (!employeeId && req.body.employee) {
      const e = req.body.employee
      const eid = randomUUID()
      const empNo = await nextEmpNo(conn)
      const personKind = req.body.kind === 'labor' ? 'employee' : 'worker'
      await conn.execute(
        `INSERT INTO employees (id, emp_no, name, role, department, base_salary, join_date, birth_date, status, active, person_kind, salary_account)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [eid, empNo, e.name, e.role || '', e.department || '', e.base_salary || 0,
         e.join_date || req.body.start_date || null, e.birth_date || null, '재직', 1, personKind, e.salary_account || null]
      )
      employeeId = eid
    }
    if (!employeeId) { await rollbackQuietly(conn); return res.status(400).json({ error: '대상 인력이 필요해요' }) }

    const f = normalize(req.body)
    // 근로계약은 직원당 1건만 진행중 — 연봉 인상/재계약으로 새 근로계약을 만들면 기존 진행중 근로계약을
    // 만료로 돌려 이력으로 남긴다(안 그러면 목록에 같은 직원이 진행중 2건으로 중복 노출된다).
    if (f.kind === 'labor') {
      await conn.execute("UPDATE work_contracts SET status = '만료' WHERE employee_id = ? AND kind = 'labor' AND status = '진행중'", [employeeId])
    }
    const id = randomUUID()
    await conn.execute(
      `INSERT INTO work_contracts
         (id, employee_id, kind, income_type, title, employ_type_id, employ_type, start_date, end_date, term_mode,
          status, pay_form, work_hours, pay_day, pay_items, insure_np, insure_hi, insure_ei, insure_ai, conv_alert_months, memo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, employeeId, f.kind, f.income_type, f.title, f.employ_type_id, f.employ_type, f.start_date, f.end_date, f.term_mode,
       f.status, f.pay_form, f.work_hours, f.pay_day, f.pay_items,
       f.insure_np, f.insure_hi, f.insure_ei, f.insure_ai, f.conv_alert_months, f.memo]
    )
    if (f.kind !== 'labor') await replaceItems(conn, id, req.body.items)
    await conn.commit()
    res.json({ ok: true, id, employee_id: employeeId })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

router.put('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[cur]] = await conn.execute('SELECT id, kind FROM work_contracts WHERE id = ? FOR UPDATE', [req.params.id])
    if (!cur) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const f = normalize(req.body)
    await conn.execute(
      `UPDATE work_contracts SET kind=?, income_type=?, title=?, employ_type_id=?, employ_type=?, start_date=?, end_date=?,
         term_mode=?, status=?, pay_form=?, work_hours=?, pay_day=?, pay_items=?,
         insure_np=?, insure_hi=?, insure_ei=?, insure_ai=?, conv_alert_months=?, memo=? WHERE id=?`,
      [f.kind, f.income_type, f.title, f.employ_type_id, f.employ_type, f.start_date, f.end_date, f.term_mode,
       f.status, f.pay_form, f.work_hours, f.pay_day, f.pay_items,
       f.insure_np, f.insure_hi, f.insure_ei, f.insure_ai, f.conv_alert_months, f.memo, req.params.id]
    )
    if (f.kind !== 'labor') {
      if (req.body.items !== undefined) await replaceItems(conn, req.params.id, req.body.items)
    } else {
      await conn.execute('DELETE FROM work_contract_items WHERE work_contract_id = ?', [req.params.id])
    }
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

// ── 복제: 계약 + 단가표를 새 계약으로. 같은 인력의 다음 계약 or 다른 인력에게 같은 조건. ──
router.post('/:id/duplicate', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[src]] = await conn.execute('SELECT * FROM work_contracts WHERE id = ?', [req.params.id])
    if (!src) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const newId = randomUUID()
    const employeeId = req.body.employee_id || src.employee_id
    await conn.execute(
      `INSERT INTO work_contracts
         (id, employee_id, kind, income_type, title, employ_type_id, employ_type, start_date, end_date, term_mode,
          status, pay_form, work_hours, pay_day, pay_items, insure_np, insure_hi, insure_ei, insure_ai, conv_alert_months, memo)
       SELECT ?, ?, kind, income_type, CONCAT(COALESCE(title,''), ' (사본)'), employ_type_id, employ_type,
              ?, end_date, term_mode, '진행중', pay_form, work_hours, pay_day, pay_items,
              insure_np, insure_hi, insure_ei, insure_ai, conv_alert_months, memo
       FROM work_contracts WHERE id = ?`,
      [newId, employeeId, req.body.start_date || src.start_date, req.params.id]
    )
    const [items] = await conn.execute('SELECT * FROM work_contract_items WHERE work_contract_id = ? ORDER BY sort_order', [req.params.id])
    let ord = 0
    for (const it of items) {
      await conn.execute(
        'INSERT INTO work_contract_items (id, work_contract_id, item_id, name, spec, unit, unit_price, sort_order) VALUES (?,?,?,?,?,?,?,?)',
        [randomUUID(), newId, it.item_id, it.name, it.spec, it.unit, it.unit_price, ++ord]
      )
    }
    await conn.commit()
    res.json({ ok: true, id: newId })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

router.delete('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    // 지급된 회차(payroll)의 거래는 보존하고 연결만 해제 → 계약 삭제해도 장부는 남는다.
    // 두 문을 한 트랜잭션으로 묶어 unlink만 되고 계약이 남는 어긋난 상태를 막는다.
    await conn.execute('UPDATE payroll SET work_contract_id = NULL WHERE work_contract_id = ?', [req.params.id])
    await conn.execute('DELETE FROM work_contracts WHERE id = ?', [req.params.id])  // items·docs는 CASCADE
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

// ── 계약서 첨부(다중) ──
router.post('/:id/docs', async (req, res, next) => {
  try {
    const { url, file_url, name, file_name } = req.body
    const u = url || file_url
    if (!u) return res.status(400).json({ error: 'url 필수' })
    const id = randomUUID()
    await req.db.execute('INSERT INTO work_contract_docs (id, work_contract_id, file_url, file_name) VALUES (?,?,?,?)',
      [id, req.params.id, u, name || file_name || '계약서'])
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.delete('/docs/:docId', async (req, res, next) => {
  try {
    // DB 행만 지우면 실제 파일이 uploads/{companyId}/ 에 그대로 남는다(고아 파일).
    // 컬럼명은 file_url (url 아님) — 잘못된 컬럼이면 SELECT가 ER_BAD_FIELD로 500나고 삭제가 영영 안 된다.
    const [[doc]] = await req.db.execute('SELECT file_url FROM work_contract_docs WHERE id = ?', [req.params.docId])
    await req.db.execute('DELETE FROM work_contract_docs WHERE id = ?', [req.params.docId])
    if (doc) removeUploadedFile(doc.file_url, req.user?.companyId)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// ── 용역·일용 지급 발행 — 단가표 수량 → payroll 회차 1건(+선택 즉시지급). 기성 청구(progress-invoice)와 같은 흐름. ──
// body: { month, pay_date, lines:[{name,unit,qty,unit_price,amount}], deductions:[{label,value}], paid?, account_id, date }
router.post('/:id/pay', async (req, res, next) => {
  const { month, pay_date, lines, deductions, paid, account_id, date, memo } = req.body
  if (paid) { const de = futureDateError(date || pay_date); if (de) return res.status(400).json({ error: de }) }
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[c]] = await conn.execute(
      'SELECT w.*, e.name AS employee_name FROM work_contracts w JOIN employees e ON w.employee_id = e.id WHERE w.id = ? FOR UPDATE',
      [req.params.id]
    )
    if (!c) { await rollbackQuietly(conn); return res.status(404).json({ error: '계약을 찾을 수 없어요' }) }

    // 라인 정규화(수량×단가). 이름 없거나 금액 0 이하 제외.
    const clean = []
    for (const l of (Array.isArray(lines) ? lines : [])) {
      const nm = (l && l.name != null) ? String(l.name).trim() : ''
      if (!nm) continue
      const qty = Number(String(l.qty ?? '').replace(/[^0-9.]/g, '')) || 0
      const price = Number(String(l.unit_price ?? '').replace(/[^0-9]/g, '')) || 0
      const amount = (l.amount != null && l.amount !== '')
        ? (Number(String(l.amount).replace(/[^0-9]/g, '')) || 0) : Math.round(qty * price)
      if (amount <= 0) continue
      clean.push({ item_id: l.item_id || null, name: nm, spec: l.spec || null, unit: l.unit || null, qty, unit_price: price, amount })
    }
    if (clean.length === 0) { await rollbackQuietly(conn); return res.status(400).json({ error: '지급할 항목이 없어요' }) }

    // 명세 items = 용역비 라인(earn) + 원천징수 등 공제. 공제는 확정 금액 입력(요율 계산 안 함).
    const items = clean.map(l => ({ label: l.name, kind: 'earn', mode: 'fixed', value: l.amount }))
    for (const d of (Array.isArray(deductions) ? deductions : [])) {
      const v = Number(String(d.value ?? '').replace(/[^0-9]/g, '')) || 0
      if (!d.label || v <= 0) continue
      items.push({ label: d.label, kind: 'deduct', mode: 'fixed', value: v })
    }
    const { base, gross, deduction, net } = computeItems(items)

    const m = month || (date || pay_date || kstToday()).slice(0, 7)
    const [[{ maxseq }]] = await conn.execute(
      'SELECT COALESCE(MAX(seq),0) AS maxseq FROM payroll WHERE employee_id = ? AND month = ?', [c.employee_id, m]
    )
    const seq = Number(maxseq) + 1
    const payrollId = randomUUID()
    await conn.execute(
      `INSERT INTO payroll (id, employee_id, work_contract_id, seq, month, base_salary, allowance, deduction, net_salary, gross, items, qty_lines, pay_date, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [payrollId, c.employee_id, c.id, seq, m, base, gross - base, deduction, net, gross,
       JSON.stringify(items), JSON.stringify(clean), pay_date || date || `${m}-25`, '확정']
    )

    let txnId = null
    if (paid) {
      // 예전에는 계좌 미지정 시 '가장 오래된 은행계좌'로 조용히 대체했다. 그러면 실제로 돈이
      // 나간 계좌가 아닌 곳에서 차감돼 두 계좌가 동시에 틀어진다(한쪽은 과소, 한쪽은 과대).
      // 은행계좌가 하나도 없으면 NULL이 되어 어느 잔액에도 안 잡혔다. 명시 선택을 요구한다.
      const lerr = ledgerError({ kind: 'expense', account_id, status: '지급완료' })
      if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: lerr }) }
      const ce = await closedPeriodError(conn, date || pay_date || kstToday())
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
      txnId = randomUUID()
      // 소득구분에 맞는 카테고리로 지출 기록(급여와 구분되어 신고자료 집계가 섞이지 않게)
      const category = c.income_type === '일용' ? '일용노무비' : c.income_type === '기타' ? '기타소득 지급' : '용역비'
      await conn.execute(
        `INSERT INTO transactions (id, kind, account_id, category, amount, date, method, status, employee_id, payroll_id, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [txnId, 'expense', account_id, category, net, date || pay_date || kstToday(),
         '계좌이체', '지급완료', c.employee_id, payrollId, memo || `${m} ${c.employee_name} ${category}`]
      )
      // ↑ status '지급완료'(공백 없음) — 계좌 잔액 계산(accounts.js)이 이 값만 지출로 센다.
      await conn.execute('UPDATE payroll SET status = ? WHERE id = ?', ['지급완료', payrollId])
    }
    await conn.commit()
    res.json({ ok: true, id: payrollId, seq, gross, deduction, net, txnId })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

module.exports = router
