const { Router } = require('express')
const { randomUUID } = require('crypto')

const router = Router()

async function calcBalance(db, accountId) {
  const [rows] = await db.execute(`
    SELECT
      a.initial_balance,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='income'  AND account_id=a.id), 0) AS income_total,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='expense' AND account_id=a.id AND status='지급완료'), 0) AS expense_total,
      COALESCE((SELECT SUM(amount) FROM account_adjustments WHERE account_id=a.id), 0) AS adj_total
    FROM accounts a WHERE a.id = ?
  `, [accountId])
  const row = rows[0]
  if (!row) return 0
  return Number(row.initial_balance) + Number(row.income_total) - Number(row.expense_total) + Number(row.adj_total)
}

router.get('/', async (req, res, next) => {
  try {
    const [accounts] = await req.db.execute('SELECT * FROM accounts ORDER BY name')
    const result = await Promise.all(accounts.map(async a => ({ ...a, balance: await calcBalance(req.db, a.id) })))
    res.json(result)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM accounts WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json({ ...rows[0], balance: await calcBalance(req.db, req.params.id) })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { name, bank, type, initial_balance, kind, number, purpose } = req.body
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO accounts (id, name, bank, type, initial_balance, kind, `number`, purpose) VALUES (?,?,?,?,?,?,?,?)',
      [id, name, bank||'', type||'보통예금', initial_balance||0, kind||'bank', number||'', purpose||'']
    )
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, bank, type, initial_balance, kind, number, purpose } = req.body
    const [result] = await req.db.execute(
      'UPDATE accounts SET name=?, bank=?, type=?, initial_balance=?, kind=?, `number`=?, purpose=? WHERE id=?',
      [name, bank||'', type||'보통예금', initial_balance||0, kind||'bank', number||'', purpose||'', req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    // 이 계좌를 참조하는 곳이 있으면 삭제 차단.
    // FK가 있는 곳(거래·청구서·정기)만 보면, FK 없이 account_id 만 들고 있는 테이블
    // (세금 납부·기준정보·잔액조정 — 나중에 ensureColumn 으로 붙은 컬럼들)은 통과해버려
    // 계좌가 사라진 뒤 그 화면들이 지워진 계좌를 가리키게 된다.
    // 어디에 걸렸는지 세어 알려준다 — "어딘가 연결돼 있다"만으로는 정리할 수가 없다.
    const id = req.params.id
    const [[c]] = await req.db.execute(
      `SELECT
         (SELECT COUNT(*) FROM transactions        WHERE account_id = ?) AS txns,
         (SELECT COUNT(*) FROM invoices            WHERE account_id = ?) AS invs,
         (SELECT COUNT(*) FROM recurring_expenses  WHERE account_id = ?) AS rexp,
         (SELECT COUNT(*) FROM recurring_invoices  WHERE account_id = ?) AS rinv,
         (SELECT COUNT(*) FROM vat_filings         WHERE account_id = ?) AS vat,
         (SELECT COUNT(*) FROM other_taxes         WHERE account_id = ?) AS otax,
         (SELECT COUNT(*) FROM ref_items           WHERE account_id = ?) AS refi,
         (SELECT COUNT(*) FROM account_adjustments WHERE account_id = ?) AS adj`,
      [id, id, id, id, id, id, id, id]
    )
    const parts = []
    if (Number(c.txns) > 0) parts.push(`거래 ${c.txns}건`)
    if (Number(c.invs) > 0) parts.push(`청구서 ${c.invs}건`)
    if (Number(c.rexp) > 0) parts.push(`정기지출 ${c.rexp}건`)
    if (Number(c.rinv) > 0) parts.push(`정기청구 ${c.rinv}건`)
    if (Number(c.vat)  > 0) parts.push(`부가세 납부 ${c.vat}건`)
    if (Number(c.otax) > 0) parts.push(`기타세액 ${c.otax}건`)
    if (Number(c.refi) > 0) parts.push(`기준정보 ${c.refi}건`)
    if (Number(c.adj)  > 0) parts.push(`잔액조정 ${c.adj}건`)
    if (parts.length) {
      return res.status(409).json({
        error: `이 계좌/카드에 ${parts.join(' · ')}이 연결돼 있어 삭제할 수 없어요. 먼저 정리해주세요.`,
      })
    }
    const [result] = await req.db.execute('DELETE FROM accounts WHERE id = ?', [req.params.id])
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) {
    if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.errno === 1451) {
      return res.status(409).json({ error: '이 계좌/카드에 연결된 항목이 있어 삭제할 수 없습니다' })
    }
    next(e)
  }
})

router.get('/:id/adjustments', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      'SELECT * FROM account_adjustments WHERE account_id = ? ORDER BY date DESC',
      [req.params.id]
    )
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/:id/adjustments', async (req, res, next) => {
  try {
    const { amount, reason, date, created_by } = req.body
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO account_adjustments (id, account_id, amount, reason, date, created_by) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, amount, reason||'', date, created_by||'']
    )
    res.json({ id })
  } catch (e) { next(e) }
})

module.exports = router
