const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError } = require('../lib/ledger')
const { laborAcctCode, laborCategory } = require('../lib/acctCode')
const { removeUploadedFile } = require('../lib/uploads')
const { uploadMem, parseSheet } = require('../lib/xlsx-import')
const { newBook, templateSheet, guideSheet, sendBook } = require('../lib/xlsxBook')

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
    let sql = `SELECT w.*, e.name AS employee_name, e.emp_no, e.department, e.role, e.birth_date, e.status AS emp_status, e.leave_date
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
/* ── 근로계약 엑셀 업로드 — 직원 + 근로계약을 한 번에(2026-10-02 사용자: "엑셀 업로드 없음") ──
 *
 * 한 줄 = 직원 한 명 + 그 사람의 근로계약 하나. 화면의 '직원 등록'과 같은 일을 여러 줄로 한다.
 * 급여 기준은 **지급 항목만** 칸으로 받는다(이 회사 표준 지급 항목이 칸이 된다). 공제(4대보험·세금)는
 * 표준 항목의 기본값으로 채운다 — 사람마다 요율을 엑셀로 받으면 틀리기 쉽고, 화면에서 고치는 게 낫다.
 * ⚠ 머리글 글자는 업로드 화면(WorkContract.jsx laborImportAdapter)이 열을 알아보는 근거다 — 바꾸지 말 것.
 * ⚠ 새로 넣기만 한다. 이미 있는 직원의 재계약은 화면의 '새 계약(연봉 인상)'으로 — 엑셀로 덮으면 계약 이력이 끊긴다. */
const TERM_BY_LABEL = { '무기한': 'open', '기간 만료': 'fixed', '자동 갱신': 'auto_renew' }

router.get('/import/template', async (req, res, next) => {
  try {
    const [depts] = await req.db.execute("SELECT name FROM hr_codes WHERE type = 'dept' ORDER BY sort_order, name")
    const [poss] = await req.db.execute("SELECT name FROM hr_codes WHERE type = 'pos' ORDER BY sort_order, name")
    const [types] = await req.db.execute("SELECT label FROM employ_types WHERE kind = 'labor' AND COALESCE(active, 1) = 1 ORDER BY sort_order, label").catch(() => [[]])
    const [earns] = await req.db.execute("SELECT label FROM payroll_item_types WHERE active = 1 AND kind = 'earn' AND mode = 'fixed' ORDER BY sort_order, label")
    const listRef = (sheet, n) => ({ ref: `'${sheet}'!$A$2:$A$${Math.max(2, n + 1)}` })
    const YN = ['적용', '제외']
    const COLS = [
      { header: '이름', width: 12, required: true, prompt: '직원 이름. 예: 홍길동' },
      { header: '부서', width: 14, list: listRef('부서 목록', depts.length), prompt: "목록에서 선택('부서 목록' 시트). 없는 부서는 인사 기준정보에 먼저 추가하세요." },
      { header: '직위', width: 12, list: listRef('직위 목록', poss.length), prompt: "목록에서 선택('직위 목록' 시트)." },
      { header: '생년월일', width: 12, prompt: '급여명세서 표기용. 예: 1990-05-12' },
      { header: '입사일', width: 12, required: true, prompt: '계약 시작일. 예: 2026-03-02' },
      { header: '고용형태', width: 12, list: listRef('고용형태 목록', types.length), prompt: '목록에서 선택. 고르면 급여형태·4대보험 기본값이 따라옵니다.' },
      { header: '종료 방식', width: 10, list: Object.keys(TERM_BY_LABEL), strict: true, prompt: '무기한 / 기간 만료 / 자동 갱신. 비우면 무기한.' },
      { header: '계약 종료', width: 12, prompt: '종료 방식이 기간 만료·자동 갱신일 때만. 예: 2027-03-01' },
      { header: '소정근로시간', width: 16, prompt: '예: 주 40시간 / 09:00~18:00' },
      { header: '급여 지급일', width: 10, int: true, prompt: '매월 며칠(1~31). 비우면 25일.' },
      { header: '국민연금', width: 9, list: YN, strict: true, prompt: '적용 / 제외. 비우면 고용형태 기본값.' },
      { header: '건강보험', width: 9, list: YN, strict: true, prompt: '적용 / 제외. 비우면 고용형태 기본값.' },
      { header: '고용보험', width: 9, list: YN, strict: true, prompt: '적용 / 제외. 비우면 고용형태 기본값.' },
      { header: '산재보험', width: 9, list: YN, strict: true, prompt: '적용 / 제외. 비우면 고용형태 기본값.' },
      { header: '급여이체 계좌', width: 26, prompt: '예: 하나은행 123-456789-01 홍길동' },
      // 이 회사의 표준 지급 항목(고정 금액)이 그대로 칸이 된다 — 급여 기준의 지급 항목
      ...earns.map(e => ({ header: e.label, width: 13, money: true, prompt: `월 ${e.label}(원). 비우면 0.` })),
      { header: '메모', width: 24, prompt: '특이사항' },
    ]
    const wb = newBook()
    templateSheet(wb, '근로계약', { columns: COLS, samples: [] })
    const listSheet = (name, rows) => {
      const ws = wb.addWorksheet(name)
      ws.columns = [{ width: 20 }]
      const h = ws.getRow(1).getCell(1)
      h.value = name.replace(' 목록', ''); h.font = { bold: true, size: 10 }
      h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F7' } }
      rows.forEach((v, i) => { ws.getRow(i + 2).getCell(1).value = v })
    }
    listSheet('부서 목록', depts.map(d => d.name))
    listSheet('직위 목록', poss.map(d => d.name))
    listSheet('고용형태 목록', types.map(t => t.label))
    guideSheet(wb, [
      '근로계약 일괄 업로드 — 작성 안내',
      '',
      '• 한 줄에 직원 한 명과 그 사람의 근로계약 하나를 적습니다. 직원과 계약이 함께 등록됩니다.',
      '• 이름·입사일은 꼭 적으세요. 이미 등록된 직원(이름·생년월일이 같음)은 건너뜁니다 — 재계약은 화면의 [새 계약(연봉 인상)]으로 하세요.',
      '• 고용형태를 고르면 급여형태와 4대보험 기본값이 따라옵니다. 4대보험 칸을 적으면 그 값이 우선합니다.',
      '• 급여 기준: 지급 항목(기본급·수당 등)은 칸에 월 금액을 적습니다. 공제(4대보험·세금)는 표준 항목의 기본값으로 채워지고, 화면에서 고칠 수 있습니다.',
      '• 부서·직위는 목록에 있는 이름을 쓰세요. 목록에 없는 이름도 그대로 저장되지만 부서별로 모아 볼 때 갈라집니다.',
      '• 첫 행(열 제목)은 그대로 두고, 둘째 행부터 적으세요.',
    ], '작성안내', { hasRequired: true, hasSamples: false })
    await sendBook(res, wb, '근로계약_업로드_양식.xlsx')
  } catch (e) { next(e) }
})

router.post('/import/parse', uploadMem.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다' })
    res.json(parseSheet(req.file.buffer))
  } catch (e) { next(e) }
})

// items: [{ name, department, role, birth_date, start_date, employ_type, term_mode, end_date, work_hours, pay_day,
//           insure_np|hi|ei|ai (1/0/null), salary_account, earns: { 항목명: 금액 }, memo }]
router.post('/import/commit', async (req, res, next) => {
  const items = Array.isArray(req.body.items) ? req.body.items : []
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [types] = await conn.execute("SELECT * FROM employ_types WHERE kind = 'labor'")
    const typeByLabel = new Map(types.map(t => [String(t.label).trim(), t]))
    const [masters] = await conn.execute('SELECT * FROM payroll_item_types WHERE active = 1 ORDER BY sort_order, label')
    // 이미 있는 직원 — 이름+생년월일(생년월일이 없으면 이름만)으로 본다
    const [emps] = await conn.execute('SELECT name, birth_date FROM employees')
    const known = new Set(emps.map(e => `${String(e.name).trim()}|${e.birth_date || ''}`))
    const knownName = new Set(emps.map(e => String(e.name).trim()))
    // 생년월일이 비어 있는 기존 직원 — 업로드 줄에 생년월일이 있어도 같은 사람일 수 있다
    const nameNoBirth = new Set(emps.filter(e => !e.birth_date).map(e => String(e.name).trim()))
    const results = items.map(() => ({ status: 'skipped' }))
    let inserted = 0
    for (const [k, it] of items.entries()) {
      const name = String(it.name || '').trim()
      if (!name) { results[k] = { status: 'noName' }; continue }
      const birth = String(it.birth_date || '').slice(0, 10) || null
      /* 이름·생년월일이 같으면 중복. 생년월일 없이 이름만 같으면 '확인 필요' — 사용자가 미리보기에서
         '새로 등록'을 골랐으면(confirmed) 넣는다. 예전엔 고른 것을 무시하고 '중복'으로 건너뛰었다(검토) */
      if (birth && known.has(`${name}|${birth}`)) { results[k] = { status: 'dup' }; continue }
      if (!birth && knownName.has(name) && !it.confirmed) { results[k] = { status: 'dup' }; continue }
      if (birth && nameNoBirth.has(name) && !it.confirmed) { results[k] = { status: 'dup' }; continue }
      // 화면 검사만 믿지 않는다 — 날짜 모양·지급일 범위
      const ISO = /^\d{4}-\d{2}-\d{2}$/
      if (!ISO.test(String(it.start_date || '').slice(0, 10))) { results[k] = { status: 'invalid', why: '입사일 형식' }; continue }
      if (birth && !ISO.test(birth)) { results[k] = { status: 'invalid', why: '생년월일 형식' }; continue }
      if (it.end_date && !ISO.test(String(it.end_date).slice(0, 10))) { results[k] = { status: 'invalid', why: '계약 종료일 형식' }; continue }
      if (it.pay_day != null && it.pay_day !== '' && !(Number(it.pay_day) >= 1 && Number(it.pay_day) <= 31)) { results[k] = { status: 'invalid', why: '급여 지급일(1~31)' }; continue }
      const t = typeByLabel.get(String(it.employ_type || '').trim()) || null
      const ins = (key) => (it[key] === 1 || it[key] === 0 ? it[key] : (t ? Number(t[key]) || 0 : 1))
      const earnVal = (label) => Number(String((it.earns || {})[label] ?? '').replace(/[^0-9]/g, '')) || 0
      // 급여 기준 — 표준 항목 순서대로. 지급(고정)은 엑셀 금액, 그 밖(공제·비율)은 기본값
      const payItems = masters.map(m => ({
        label: m.label, kind: m.kind, mode: m.mode,
        value: m.kind === 'earn' && m.mode === 'fixed' ? earnVal(m.label) : Number(m.default_value) || 0,
      }))
      const start = String(it.start_date || '').slice(0, 10) || null
      const term = ['open', 'fixed', 'auto_renew'].includes(it.term_mode) ? it.term_mode : 'open'
      const eid = randomUUID()
      await conn.execute(
        `INSERT INTO employees (id, emp_no, name, role, department, base_salary, join_date, birth_date, status, active, person_kind, salary_account)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [eid, await nextEmpNo(conn), name, it.role || '', it.department || '', earnVal('기본급'),
         start, birth, '재직', 1, 'employee', it.salary_account || null])
      const f = normalize({
        kind: 'labor', income_type: '근로', title: `${name} 근로계약`,
        employ_type_id: t?.id || null, employ_type: t?.label || (it.employ_type || null),
        start_date: start, end_date: it.end_date || null, term_mode: term,
        pay_form: t?.pay_form || 'monthly', work_hours: it.work_hours || null,
        pay_day: Number(it.pay_day) || 25, pay_items: payItems,
        insure_np: ins('insure_np'), insure_hi: ins('insure_hi'), insure_ei: ins('insure_ei'), insure_ai: ins('insure_ai'),
        memo: it.memo || null,
      })
      await conn.execute(
        `INSERT INTO work_contracts
           (id, employee_id, kind, income_type, title, employ_type_id, employ_type, start_date, end_date, term_mode,
            status, pay_form, work_hours, pay_day, pay_items, insure_np, insure_hi, insure_ei, insure_ai, conv_alert_months, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [randomUUID(), eid, f.kind, f.income_type, f.title, f.employ_type_id, f.employ_type, f.start_date, f.end_date, f.term_mode,
         f.status, f.pay_form, f.work_hours, f.pay_day, f.pay_items,
         f.insure_np, f.insure_hi, f.insure_ei, f.insure_ai, f.conv_alert_months, f.memo])
      known.add(`${name}|${birth || ''}`); knownName.add(name)
      inserted++
      results[k] = { status: 'inserted' }
    }
    await conn.commit()
    res.json({ ok: true, inserted, results })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

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
    // 편집 드로어는 status·memo를 안 보낸다(각각 상세 상단·메모 탭에서 관리) → 미전송이면 기존 값 유지.
    // 예전엔 normalize가 status='진행중'·memo=null로 강제해, 편집 저장이 만료계약을 진행중으로
    // 되돌리고 메모를 지웠다. work_hours·conv_alert_months도 폼에 없을 때 보존한다.
    const keepStatus = req.body.status !== undefined ? f.status : null
    const keepMemo   = req.body.memo !== undefined ? (req.body.memo || null) : null
    const keepWH     = req.body.work_hours !== undefined ? (req.body.work_hours || null) : null
    const keepConv   = req.body.conv_alert_months !== undefined ? f.conv_alert_months : null
    await conn.execute(
      `UPDATE work_contracts SET kind=?, income_type=?, title=?, employ_type_id=?, employ_type=?, start_date=?, end_date=?,
         term_mode=?, status=COALESCE(?, status), pay_form=?, work_hours=COALESCE(?, work_hours), pay_day=?, pay_items=?,
         insure_np=?, insure_hi=?, insure_ei=?, insure_ai=?,
         conv_alert_months=COALESCE(?, conv_alert_months), memo=COALESCE(?, memo) WHERE id=?`,
      [f.kind, f.income_type, f.title, f.employ_type_id, f.employ_type, f.start_date, f.end_date, f.term_mode,
       keepStatus, f.pay_form, keepWH, f.pay_day, f.pay_items,
       f.insure_np, f.insure_hi, f.insure_ei, f.insure_ai, keepConv, keepMemo, req.params.id]
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

/* 계약 삭제 — **잘못 등록한 것을 지우는 길**이다. 퇴사·만료와는 다른 일이다.
 *
 * ⚠ 급여대장이 한 번이라도 나온 계약은 **막는다.**
 *   예전엔 `UPDATE payroll SET work_contract_id = NULL` 로 연결만 끊고 지웠다. 장부는 남지만
 *   그 급여가 **어느 계약에서 나온 것인지가 사라진다** — 나중에 "이 사람 그때 얼마였지"를
 *   되짚을 수 없고, 계약별 인건비 집계도 그만큼 비게 된다. 되돌릴 방법도 없다.
 *   실수로 등록한 계약은 급여가 나가기 전이므로 이 가드에 걸리지 않는다.
 *   이미 급여가 나갔다면 그건 실수가 아니라 **끝난 계약**이다 → 퇴사 처리·만료를 쓴다. */
router.delete('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[{ cnt }]] = await conn.execute(
      'SELECT COUNT(*) AS cnt FROM payroll WHERE work_contract_id = ?', [req.params.id])
    if (cnt > 0) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `이 계약으로 만든 급여대장이 ${cnt}건 있어요. 지우면 그 급여가 어느 계약에서 나왔는지 알 수 없게 됩니다.`
             + ` 계약이 끝난 것이라면 '퇴사 처리'나 만료로 정리해주세요.` })
    }
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

    /* 중복 제출 가드 — 이 경로는 요청마다 **새 회차를 만든다.**
     * 두 번 도착하면 명세가 2장 발급되고 계좌에서도 두 번 빠진다. 화면의 busy 가드는
     * 같은 탭에서 연타하는 것만 막는다(느려서 새로고침 후 다시 누르거나 탭이 둘이면 통과).
     *
     * 같은 계약·같은 달·같은 지급일·같은 실지급액이면 중복으로 본다. 정말 한 번 더
     * 지급해야 하는 경우(같은 날 같은 금액을 두 번)는 화면에서 확인을 받아 force 로 다시 보낸다.
     * 계약 행은 위에서 FOR UPDATE 로 잠갔으므로 동시 요청도 여기서 순서가 갈린다. */
    const payDate = pay_date || date || `${m}-25`
    if (!req.body.force) {
      const [[dup]] = await conn.execute(
        `SELECT id, seq FROM payroll
          WHERE work_contract_id = ? AND month = ? AND pay_date = ? AND net_salary = ?
          LIMIT 1`, [c.id, m, payDate, net])
      if (dup) {
        await rollbackQuietly(conn)
        return res.status(409).json({
          code: 'duplicate',
          error: `${m} ${payDate}에 실지급 ${Number(net).toLocaleString('ko-KR')}원 회차(${dup.seq}회차)가 이미 있어요. 같은 지급을 한 번 더 등록할까요?`,
        })
      }
    }

    const [[{ maxseq }]] = await conn.execute(
      'SELECT COALESCE(MAX(seq),0) AS maxseq FROM payroll WHERE employee_id = ? AND month = ?', [c.employee_id, m]
    )
    const seq = Number(maxseq) + 1
    const payrollId = randomUUID()
    await conn.execute(
      `INSERT INTO payroll (id, employee_id, work_contract_id, seq, month, base_salary, allowance, deduction, net_salary, gross, items, qty_lines, pay_date, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [payrollId, c.employee_id, c.id, seq, m, base, gross - base, deduction, net, gross,
       JSON.stringify(items), JSON.stringify(clean), payDate, '확정']
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
      /* 소득구분에 맞는 비목·계정과목으로 지출 기록(급여와 구분되어 신고자료 집계가 섞이지 않게).
         규칙은 lib/acctCode.js 한 곳 — 회차 지급(payroll.js)과 반드시 같은 값이어야 한다.
         두 벌로 두면 어느 화면에서 지급했느냐에 따라 비목이 갈려 집계가 조용히 쪼개진다.
         account_code 가 없으면 일계표에서 상대 계정이 비어 차·대변이 안 맞는다. */
      const category = laborCategory(c.income_type)
      await conn.execute(
        `INSERT INTO transactions (id, kind, account_id, account_code, category, amount, date, method, status, employee_id, payroll_id, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txnId, 'expense', account_id, laborAcctCode(c.income_type), category, net, date || pay_date || kstToday(),
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
