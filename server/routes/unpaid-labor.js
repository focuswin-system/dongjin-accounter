const { Router } = require('express')
const { randomUUID } = require('crypto')
const { moneyOf } = require('../lib/money')

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
 * ⚠ 여기는 **아직 안 나간 돈의 목록**이지 회계 장부가 아니다. 실제로 지급하면
 *   거래를 등록하고 여기 paid_amount 를 올린다 — 자동으로 거래를 만들지 않는다.
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
function amountsError(amount, paid) {
  if (!(amount > 0)) return '퇴직금 총액을 입력해주세요'
  if (paid < 0) return '지급액은 0 이상이어야 해요'
  if (paid > amount) return '지급액이 총액보다 클 수 없어요'
  if (amount > 1e12) return '금액이 너무 큽니다. 값을 확인해주세요.'
  return null
}

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
    const id = randomUUID()
    await req.db.execute(
      `INSERT INTO unpaid_labor (id, employee_id, name, kind, status, period, amount, paid_amount, due_date, memo)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, b.employee_id || null, name, KIND,
       STATUS.includes(b.status) ? b.status : 'retired',
       b.period || null, amount, paid, b.due_date || null, b.memo || null])
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
    const name = b.name != null ? String(b.name).trim() : cur.name
    if (!name) return res.status(400).json({ error: '이름을 입력해주세요' })

    const [r] = await req.db.execute(
      `UPDATE unpaid_labor SET employee_id=?, name=?, status=?, period=?, amount=?, paid_amount=?, due_date=?, memo=?
        WHERE id=? AND kind=?`,
      [b.employee_id !== undefined ? (b.employee_id || null) : cur.employee_id,
       name,
       STATUS.includes(b.status) ? b.status : cur.status,
       b.period !== undefined ? (b.period || null) : cur.period,
       amount, paid,
       b.due_date !== undefined ? (b.due_date || null) : cur.due_date,
       b.memo !== undefined ? (b.memo || null) : cur.memo,
       req.params.id, KIND])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    const [r] = await req.db.execute('DELETE FROM unpaid_labor WHERE id = ? AND kind = ?', [req.params.id, KIND])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
