const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { SETTLED_INCOME, SETTLED_EXPENSE } = require('../lib/ledger')
const { bankAcctCode } = require('../lib/acctCode')

const router = Router()

/* 계좌 잔액.
 *
 * 수입도 지출과 같이 **완료 상태만** 센다. 여태 지출에만 status 조건이 있어서,
 * 아직 안 들어온 수입('입금 예정' 등)이 잔액에 포함됐다 — 거래내역 화면의 '입금 합계'는
 * '입금완료'만 세므로 같은 화면 안에서 두 숫자가 어긋났다.
 * (실데이터 확인: 로컬·운영의 수입 거래는 전부 '입금완료'라 기존 잔액은 바뀌지 않는다.
 *  Ledger에 '입금 처리' 버튼이 있어 미결 수입이 언제든 생길 수 있으므로 미리 대칭으로 맞춘다) */
async function calcBalance(db, accountId) {
  const [rows] = await db.execute(`
    SELECT
      a.initial_balance,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='income'  AND account_id=a.id AND status=?), 0) AS income_total,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='expense' AND account_id=a.id AND status=?), 0) AS expense_total,
      COALESCE((SELECT SUM(amount) FROM account_adjustments WHERE account_id=a.id), 0) AS adj_total
    FROM accounts a WHERE a.id = ?
  `, [SETTLED_INCOME, SETTLED_EXPENSE, accountId])
  const row = rows[0]
  if (!row) return 0
  return Number(row.initial_balance) + Number(row.income_total) - Number(row.expense_total) + Number(row.adj_total)
}

/* 잔액을 볼 자격 — 계좌 목록 자체는 결제수단이라 누구나 골라야 하지만 잔액은 다르다.
 * 권한 게이트가 목록 조회를 공용으로 열어 놨기 때문에(apiPerms LOOKUP) 여기서 한 번 더 가른다.
 * 역할 미배정 계정은 제한 없음(게이트와 같은 규칙)이라 req.perms 가 비면 통과시킨다. */
const canSeeBalance = (req) => {
  const perms = req.perms
  if (!perms || perms.size === 0) return true
  return ['master_accountBalance', 'master_account', 'cash_report', 'home']
    .some(r => perms.has(`${r}:view`))
}

router.get('/', async (req, res, next) => {
  try {
    const [accounts] = await req.db.execute('SELECT * FROM accounts ORDER BY name')
    if (!canSeeBalance(req)) return res.json(accounts.map(a => ({ ...a, balance: null })))
    const result = await Promise.all(accounts.map(async a => ({ ...a, balance: await calcBalance(req.db, a.id) })))
    res.json(result)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM accounts WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    // 목록과 같은 규칙으로 가린다 — 여기만 열려 있으면 계좌 id 만 알면 잔액을 읽을 수 있다
    if (!canSeeBalance(req)) return res.json({ ...rows[0], balance: null })
    res.json({ ...rows[0], balance: await calcBalance(req.db, req.params.id) })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { name, bank, type, initial_balance, kind, number, purpose } = req.body
    const id = randomUUID()
    // acct_code 를 빠뜨리면 이 계좌의 거래는 일계표에서 **한쪽 다리가 없어** 차대변이 안 맞는다.
    // (실제로 여기가 비어 있어서 새로 만든 계좌의 거래가 전부 짝을 잃었다)
    await req.db.execute(
      'INSERT INTO accounts (id, name, bank, type, initial_balance, kind, `number`, purpose, acct_code) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, name, bank||'', type||'보통예금', initial_balance||0, kind||'bank', number||'', purpose||'',
       bankAcctCode(type)]
    )
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, bank, type, initial_balance, kind, number, purpose } = req.body
    // 종류(보통예금↔당좌예금↔현금)가 바뀌면 계정과목도 따라가야 한다 — 안 그러면 일계표가 어긋난다
    const [result] = await req.db.execute(
      'UPDATE accounts SET name=?, bank=?, type=?, initial_balance=?, kind=?, `number`=?, purpose=?, acct_code=? WHERE id=?',
      [name, bank||'', type||'보통예금', initial_balance||0, kind||'bank', number||'', purpose||'',
       bankAcctCode(type), req.params.id]
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
    // 조정 이력은 금액을 담고 있다 — 잔액과 같은 민감도다
    if (!canSeeBalance(req)) return res.status(403).json({ error: '계좌 잔액을 볼 권한이 없어요' })
    const [rows] = await req.db.execute(
      'SELECT * FROM account_adjustments WHERE account_id = ? ORDER BY date DESC',
      [req.params.id]
    )
    res.json(rows)
  } catch (e) { next(e) }
})

/* 잔액 조정 — 계좌 잔액을 거래 없이 직접 움직이는 유일한 경로다.
 * 그런데 가드가 하나도 없어서 미래 날짜(2099년)로도, 마감된 달로도 조정이 들어갔다.
 * 거래에 걸린 규칙과 같은 선을 적용한다(마감·미래일자). 사유도 남기게 한다 —
 * 나중에 "이 5백만은 왜 조정됐나"에 답할 수 없으면 조정 자체가 장부를 흐린다. */
router.post('/:id/adjustments', async (req, res, next) => {
  try {
    const { amount, reason, date, created_by } = req.body
    const amt = parseInt(String(amount ?? '').replace(/[^0-9-]/g, ''), 10)
    if (!Number.isFinite(amt) || amt === 0) return res.status(400).json({ error: '조정 금액을 입력해주세요' })
    if (!date) return res.status(400).json({ error: '조정 일자를 선택해주세요' })
    { const de = futureDateError(date); if (de) return res.status(400).json({ error: de }) }
    { const ce = await closedPeriodError(req.db, date); if (ce) return res.status(409).json({ error: ce }) }
    if (!String(reason || '').trim()) return res.status(400).json({ error: '조정 사유를 입력해주세요' })
    const [[acct]] = await req.db.execute('SELECT id FROM accounts WHERE id = ?', [req.params.id])
    if (!acct) return res.status(404).json({ error: '계좌를 찾을 수 없어요' })
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO account_adjustments (id, account_id, amount, reason, date, created_by) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, amt, String(reason).trim(), date, created_by||'']
    )
    res.json({ id })
  } catch (e) { next(e) }
})

module.exports = router
