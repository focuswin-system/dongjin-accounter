const { Router } = require('express')
const { randomUUID } = require('crypto')
const { kstToday } = require('../db')
const { rollbackQuietly } = require('../lib/tx')
const { closedPeriodError } = require('../lib/closing')

const router = Router()

/**
 * 순수 대체 전표(D2) — 현금이 안 움직이는 분개(감가상각·대손상각 등).
 *
 * ⚠ 은행/현금이 오가는 건 여기가 아니라 거래(transactions)로 넣는다 — 그래야 잔액에 잡힌다.
 *   여기 전표는 통장을 안 거치므로 계좌 잔액과 무관하고, 비은행 계정 원장·전표목록에만 나온다.
 * ⚠ 차변 합계 = 대변 합계 여야 저장된다(복식부기의 기본).
 */

const adapt = (v, lines) => ({
  ...v,
  lines: (lines || []).map(l => ({ ...l, amount: Number(l.amount) || 0 })),
})

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM journal_vouchers ORDER BY date DESC, created_at DESC')
    const [sums] = await req.db.execute(
      "SELECT voucher_id, COALESCE(SUM(CASE WHEN side='debit' THEN amount ELSE 0 END),0) AS total FROM journal_lines GROUP BY voucher_id")
    const map = {}
    for (const s of sums) map[s.voucher_id] = Number(s.total)
    res.json(rows.map(v => ({ ...v, total: map[v.id] || 0 })))
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [[v]] = await req.db.execute('SELECT * FROM journal_vouchers WHERE id = ?', [req.params.id])
    if (!v) return res.status(404).json({ error: 'Not found' })
    const [lines] = await req.db.execute('SELECT * FROM journal_lines WHERE voucher_id = ? ORDER BY sort_order, id', [req.params.id])
    res.json(adapt(v, lines))
  } catch (e) { next(e) }
})

/** 차변/대변 줄 검증 — 둘 이상, 각 금액>0, 차변합=대변합 */
function linesError(lines) {
  if (!Array.isArray(lines)) return '분개 줄이 필요해요'
  const usable = lines.filter(l => Number(l.amount) > 0 && l.account_code)
  if (usable.length < 2) return '차변·대변 줄이 둘 이상이어야 해요'
  const debit = usable.filter(l => l.side === 'debit').reduce((s, l) => s + Math.round(Number(l.amount)), 0)
  const credit = usable.filter(l => l.side === 'credit').reduce((s, l) => s + Math.round(Number(l.amount)), 0)
  if (!debit || !credit) return '차변과 대변이 모두 있어야 해요'
  if (debit !== credit) return `차변 합계(${debit.toLocaleString('ko-KR')})와 대변 합계(${credit.toLocaleString('ko-KR')})가 달라요`
  return null
}

async function nextDocNo(conn, year) {
  const [[{ maxno }]] = await conn.execute(
    "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(doc_no,'-',-1) AS UNSIGNED)),0) AS maxno FROM journal_vouchers WHERE doc_no LIKE ?",
    [`JV-${year}-%`])
  return `JV-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
}

router.post('/', async (req, res, next) => {
  const { date, summary, memo, lines } = req.body
  const le = linesError(lines)
  if (le) return res.status(400).json({ error: le })
  const day = date || kstToday()
  const ce = await closedPeriodError(req.db, day)
  if (ce) return res.status(409).json({ error: ce })
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const id = randomUUID()
    const doc_no = await nextDocNo(conn, day.slice(0, 4))
    await conn.execute(
      'INSERT INTO journal_vouchers (id, doc_no, date, summary, memo) VALUES (?,?,?,?,?)',
      [id, doc_no, day, summary || '', memo || ''])
    let ord = 0
    for (const l of lines.filter(x => Number(x.amount) > 0 && x.account_code)) {
      await conn.execute(
        `INSERT INTO journal_lines (id, voucher_id, side, account_code, account_name, amount, memo, sort_order)
         VALUES (?,?,?,?,?,?,?,?)`,
        [randomUUID(), id, l.side === 'credit' ? 'credit' : 'debit', l.account_code || null,
         l.account_name || '', Math.round(Number(l.amount)) || 0, l.memo || '', ++ord])
    }
    await conn.commit()
    res.json({ ok: true, id, doc_no })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.delete('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[v]] = await conn.execute('SELECT date FROM journal_vouchers WHERE id = ?', [req.params.id])
    if (!v) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const ce = await closedPeriodError(conn, v.date)
    if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
    await conn.execute('DELETE FROM journal_lines WHERE voucher_id = ?', [req.params.id])
    await conn.execute('DELETE FROM journal_vouchers WHERE id = ?', [req.params.id])
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

module.exports = router
