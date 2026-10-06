const { Router } = require('express')
const { randomUUID } = require('crypto')
const { moneyOf } = require('../lib/money')
const { estimateSeverance } = require('../lib/severance')
const { futureDateError, kstToday } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError } = require('../lib/ledger')

const router = Router()

/* 미지급 퇴직금 — 아직 안 나간 퇴직금의 목록.
 *
 * ⚠ **밀린 급여는 여기가 아니다.** 급여대장(payroll)에 그 달 행을 만들면
 *   `net_salary − 실지급 = 미지급`이 저절로 나오고, 자금 예측이 그 값을 지급예정일에
 *   세운다(lib/cashReport.js 9번). 여기에 또 적으면 **나갈 돈이 두 번 잡힌다.**
 *   퇴사자도 마찬가지다 — employees 에 남아 있으므로 과거 월분 행을 만들 수 있다.
 *
 * 그럼 퇴직금은 왜 따로인가:
 *   급여대장은 UNIQUE(employee_id, month) — "한 사람 한 달 한 행"에 기본급·수당·공제다.
 *   퇴직금은 특정 달의 급여가 아니라 근속 전체에 대한 일시금이라 그 구조에 안 들어간다.
 *   억지로 넣으면 그 달 급여로 잡혀 급여대장·손익이 함께 틀어진다.
 *   계정과목도 다르다 — 급여 5201 / 퇴직급여 5202.
 *
 * ⚠ 여기는 **아직 안 나간 돈의 목록**이지 회계 장부가 아니다.
 *   [지급](POST /:id/pay)은 출금 거래를 만들고 paid_amount 를 올린다 — 그 거래를 지우면 되돌린다
 *   (routes/transactions.js DELETE). 손으로 지급액을 고치는 길(PUT)도 그대로 둔다 — 통장에 이미 찍힌
 *   출금을 거래내역에서 따로 등록한 경우, 거래를 또 만들면 두 번 나간다.
 */

const STATUS = ['active', 'retired']
/** 이 표가 담는 것은 퇴직금뿐이다. kind 컬럼은 남겨 두되 값은 하나로 고정한다 */
const KIND = 'severance'

/* 금액 검증 — POST·PUT 이 **같은 규칙**을 써야 한다.
 *
 * moneyOf 는 회계 표기 괄호와 음수를 그대로 살린다("(500,000)" → -500000).
 * 그래서 음수를 안 막으면 `paid > amount` 검사를 통과해 remain 이 총액보다 커지고,
 * 자금 예측에 없는 돈이 '나갈 돈'으로 선다. PUT 에 검증이 없던 탓에 부분 바디 한 번으로
 * 총액이 0으로 덮이고(= 자금 현황에서 그 퇴직금이 통째로 사라짐) 에러도 안 났다.
 */
/* due_date 는 VARCHAR 다(비면 '기한 미정'이라 DATE 로 못 둔다).
 * 그래서 DB 가 형식을 안 고쳐 준다 — '2026-8-1' 이 그대로 저장된다.
 * 자금 예측은 날짜를 **문자열로 비교**하므로('2026-8-1' > '2026-08-31') 그 건은
 * 구간에서 조용히 빠진다. 화면엔 멀쩡히 보이는데 자금표에서만 사라진다. */
function normDate(v) {
  if (v == null || v === '') return null
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(v).trim())
  if (!m) return undefined                       // 형식 자체가 아님 → 호출부가 400
  const [, y, mo, d] = m
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  const t = new Date(`${iso}T00:00:00`)
  // 2026-02-31 처럼 달력에 없는 날은 Date 가 다음 달로 넘겨 버린다 — 되짚어 걸러낸다
  return Number.isNaN(t.getTime()) || t.getDate() !== Number(d) ? undefined : iso
}
const DATE_ERR = '기한은 2026-08-31 형태로 입력해주세요'

function amountsError(amount, paid) {
  if (!(amount > 0)) return '퇴직금 총액을 입력해주세요'
  if (paid < 0) return '지급액은 0 이상이어야 해요'
  if (paid > amount) return '지급액이 총액보다 클 수 없어요'
  if (amount > 1e12) return '금액이 너무 큽니다. 값을 확인해주세요.'
  return null
}

/* 예상 퇴직금 — ?employee_id=&leave_date= (퇴사일을 안 주면 직원의 퇴사일, 그것도 없으면 오늘) */
router.get('/estimate', async (req, res, next) => {
  try {
    if (!req.query.employee_id) return res.status(400).json({ error: '직원을 골라주세요' })
    const [[e]] = await req.db.execute('SELECT id, name, join_date, leave_date, status FROM employees WHERE id = ?', [req.query.employee_id])
    if (!e) return res.status(404).json({ error: '직원을 찾을 수 없어요' })
    // 입사일 — 직원에 없으면 가장 이른 근로계약 시작일
    let joinDate = e.join_date
    if (!joinDate) {
      const [[c]] = await req.db.execute("SELECT MIN(start_date) AS d FROM work_contracts WHERE employee_id = ? AND kind = 'labor'", [e.id])
      joinDate = c?.d || null
    }
    const leaveDate = String(req.query.leave_date || e.leave_date || kstToday()).slice(0, 10)
    const [pay] = await req.db.execute(
      // 근로 급여대장(seq=0)만 — 용역·일용 회차(seq≥1)가 섞이면 평균임금이 부푼다
      'SELECT month, COALESCE(NULLIF(gross, 0), base_salary + COALESCE(allowance, 0)) AS wage FROM payroll WHERE employee_id = ? AND seq = 0', [e.id])
    const wagesByMonth = {}
    for (const r of pay) wagesByMonth[r.month] = (wagesByMonth[r.month] || 0) + (Number(r.wage) || 0)
    // 급여대장이 3개월 없으면 근로계약의 지급 항목 합계(고정 금액)로
    const [[wc]] = await req.db.execute(
      "SELECT pay_items FROM work_contracts WHERE employee_id = ? AND kind = 'labor' ORDER BY (status = '진행중') DESC, start_date DESC LIMIT 1", [e.id])
    let monthly = 0
    try { monthly = (JSON.parse(wc?.pay_items || '[]') || []).filter(i => i.kind === 'earn' && i.mode !== 'percent').reduce((s, i) => s + (Number(i.value) || 0), 0) } catch { monthly = 0 }
    const est = estimateSeverance({ joinDate, leaveDate, wagesByMonth, monthlyFallback: monthly })
    res.json({ employee_id: e.id, name: e.name, joinDate, leaveDate, ...est })
  } catch (e) { next(e) }
})

/* [지급] — 출금 거래(퇴직급여)를 만들고 지급액을 올린다. 급여 지급(routes/payroll.js /:id/pay)과 같은 문지기:
 * 행을 잠그고(두 번 눌러 두 번 나가지 않게) · 남은 금액을 넘지 않게 · 계좌 필수 · 미래 일자·마감 월 금지 */
router.post('/:id/pay', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const { account_id, date, memo, category } = req.body
    const de = futureDateError(date); if (de) return res.status(400).json({ error: de })
    await conn.beginTransaction()
    const [[u]] = await conn.execute('SELECT * FROM unpaid_labor WHERE id = ? FOR UPDATE', [req.params.id])
    if (!u) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const amt = moneyOf(req.body.amount)
    const remain = Number(u.amount) - Number(u.paid_amount)
    if (!(amt > 0)) { await rollbackQuietly(conn); return res.status(400).json({ error: '금액을 확인해주세요' }) }
    if (amt > remain) {
      await rollbackQuietly(conn)
      return res.status(409).json({ error: remain <= 0 ? '이미 다 지급한 퇴직금이에요' : `남은 금액은 ${remain.toLocaleString('ko-KR')}원이에요. 그보다 많이 지급할 수 없어요.` })
    }
    const lerr = ledgerError({ kind: 'expense', account_id, status: '지급완료' }); if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: lerr }) }
    const day = date || kstToday()
    const ce = await closedPeriodError(conn, day); if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
    // 비목 — 화면에서 고른 퇴직급여 비목. 계정과목은 그 비목 설정, 없으면 퇴직급여(5202)
    const [[cat]] = category ? await conn.execute("SELECT name, account_code FROM categories WHERE name = ? AND id LIKE 'EXP-%' LIMIT 1", [category]) : [[null]]
    const txnId = randomUUID()
    await conn.execute(`
      INSERT INTO transactions (id, kind, account_id, account_code, category, amount, date, method, status, employee_id, unpaid_labor_id, memo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [txnId, 'expense', account_id, cat?.account_code || '5202', cat?.name || category || '퇴직급여', amt, day,
       '계좌이체', '지급완료', u.employee_id || null, u.id, memo || `${u.name} 퇴직금 지급`])
    await conn.execute('UPDATE unpaid_labor SET paid_amount = paid_amount + ? WHERE id = ?', [amt, u.id])
    await conn.commit()
    res.json({ ok: true, txnId, remain: remain - amt })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      /* 다 준 건은 맨 아래로. 지우지는 않는다 — 언제 얼마를 줬는지가 기록이라 남겨야 하지만,
         남은 게 있는 사람보다 위에 서면 "아직 줄 돈"을 훑는 눈을 가로막는다. */
      `SELECT u.*, (u.amount - u.paid_amount) AS remain
         FROM unpaid_labor u
        WHERE u.kind = ?
        ORDER BY (u.amount - u.paid_amount) <= 0, u.status, u.name`, [KIND])
    const list = rows.map(r => ({
      ...r, amount: Number(r.amount), paid_amount: Number(r.paid_amount), remain: Number(r.remain),
    }))
    // 화면이 엑셀처럼 '퇴직자 / 현직원'으로 접어 보여줄 수 있게 합계도 낸다
    const sum = (f) => list.filter(f).reduce((s, x) => s + x.remain, 0)
    res.json({
      items: list,
      totals: {
        retired: sum(x => x.status === 'retired'),
        active:  sum(x => x.status === 'active'),
        all:     sum(() => true),
      },
    })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const b = req.body
    const name = String(b.name || '').trim()
    if (!name) return res.status(400).json({ error: '이름을 입력해주세요' })
    const amount = moneyOf(b.amount)
    const paid = moneyOf(b.paid_amount)
    { const e = amountsError(amount, paid); if (e) return res.status(400).json({ error: e }) }
    const dueDate = normDate(b.due_date)
    if (dueDate === undefined) return res.status(400).json({ error: DATE_ERR })
    /* 같은 직원의 줄 돈이 남은 퇴직금이 이미 있으면 막는다 — 퇴사 처리에서 한 번, 급여·임금에서 또 한 번
       등록하면 자금현황에 두 번 잡힌다(검토). 고칠 게 있으면 그 줄을 고친다 */
    if (b.employee_id) {
      const [[dup]] = await req.db.execute(
        'SELECT name FROM unpaid_labor WHERE employee_id = ? AND kind = ? AND amount - paid_amount > 0 LIMIT 1', [b.employee_id, KIND])
      if (dup) return res.status(409).json({ error: `${dup.name} 님의 미지급 퇴직금이 이미 있어요 — 급여·임금 › 미지급 퇴직금에서 그 줄을 고쳐 주세요.` })
    }
    const id = randomUUID()
    await req.db.execute(
      `INSERT INTO unpaid_labor (id, employee_id, name, kind, status, period, amount, paid_amount, due_date, memo)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, b.employee_id || null, name, KIND,
       STATUS.includes(b.status) ? b.status : 'retired',
       b.period || null, amount, paid, dueDate, b.memo || null])
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body
    /* 안 보낸 값은 **기존 값을 유지**한다. 예전엔 통짜로 덮어써서, 부분 바디 한 번에
       총액이 0이 되고 성명이 빈 문자열이 되고 현직원이 퇴직자로 뒤바뀌었다. */
    const [[cur]] = await req.db.execute(
      'SELECT * FROM unpaid_labor WHERE id = ? AND kind = ?', [req.params.id, KIND])
    if (!cur) return res.status(404).json({ error: 'Not found' })

    const amount = b.amount != null && b.amount !== '' ? moneyOf(b.amount) : Number(cur.amount)
    const paid = b.paid_amount != null && b.paid_amount !== '' ? moneyOf(b.paid_amount) : Number(cur.paid_amount)
    { const e = amountsError(amount, paid); if (e) return res.status(400).json({ error: e }) }
    /* [지급]으로 만든 거래가 있으면 지급액을 그 합계보다 낮게 못 고친다 — 낮추면 거래를 지울 때 숫자가 틀어진다(검토) */
    const [[lk]] = await req.db.execute('SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE unpaid_labor_id = ?', [cur.id])
    if (paid < Number(lk.s)) return res.status(400).json({ error: `지급 거래가 ${Number(lk.s).toLocaleString()}원 있어요 — 지급액을 그보다 낮출 수 없어요. 거래를 지우면 지급액이 함께 줄어요.` })
    const name = b.name != null ? String(b.name).trim() : cur.name
    if (!name) return res.status(400).json({ error: '이름을 입력해주세요' })
    let dueDate = cur.due_date
    if (b.due_date !== undefined) {
      dueDate = normDate(b.due_date)
      if (dueDate === undefined) return res.status(400).json({ error: DATE_ERR })
    }

    const [r] = await req.db.execute(
      `UPDATE unpaid_labor SET employee_id=?, name=?, status=?, period=?, amount=?, paid_amount=?, due_date=?, memo=?
        WHERE id=? AND kind=?`,
      [b.employee_id !== undefined ? (b.employee_id || null) : cur.employee_id,
       name,
       STATUS.includes(b.status) ? b.status : cur.status,
       b.period !== undefined ? (b.period || null) : cur.period,
       amount, paid,
       dueDate,
       b.memo !== undefined ? (b.memo || null) : cur.memo,
       req.params.id, KIND])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    /* 지급 거래가 걸려 있으면 지우지 않는다 — 지우면 거래의 unpaid_labor_id 만 남아, 그 거래를 고칠 수도
       ("미지급 퇴직금에서 다시 지급") 되돌릴 수도 없게 된다(검토) */
    const [[lk]] = await req.db.execute('SELECT COUNT(*) AS n FROM transactions WHERE unpaid_labor_id = ?', [req.params.id])
    if (Number(lk.n) > 0) return res.status(409).json({ error: '지급 거래가 있는 퇴직금이에요. 거래내역에서 지급 거래를 먼저 지워주세요.' })
    const [r] = await req.db.execute('DELETE FROM unpaid_labor WHERE id = ? AND kind = ?', [req.params.id, KIND])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
