const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { rollbackQuietly } = require('../lib/tx')
const { restoreLastGenerated } = require('../lib/recurrence')
const { ledgerError } = require('../lib/ledger')

const router = Router()

const RECEIVABLE_STATUSES = new Set(['입금 예정', '일부 입금', '기한 지남', '장기 미수'])
const PAYABLE_STATUSES    = new Set(['지급 대기', '지급 예정', '일부 지급', '기한 지남'])

async function attachMatches(db, invoice) {
  const [matches] = await db.execute('SELECT * FROM invoice_matches WHERE invoice_id = ?', [invoice.id])
  const [docs] = await db.execute('SELECT id, url, name, doc_type, size, created_at FROM invoice_docs WHERE invoice_id = ? ORDER BY created_at', [invoice.id])
  const paid = matches.reduce((s, m) => s + Number(m.amount), 0)
  return { ...invoice, matches, docs, paidAmount: paid, remainAmount: Number(invoice.total_amount) - paid }
}

router.get('/', async (req, res, next) => {
  try {
    const { kind, status, vendorId, from, to } = req.query
    let sql = 'SELECT i.*, v.name AS vendor_name, c.name AS contract_name FROM invoices i LEFT JOIN vendors v ON i.vendor_id = v.id LEFT JOIN contracts c ON i.contract_id = c.id WHERE 1=1'
    const params = []
    if (kind)     { sql += ' AND i.kind = ?';       params.push(kind) }
    if (status)   { sql += ' AND i.status = ?';     params.push(status) }
    if (vendorId) { sql += ' AND i.vendor_id = ?';  params.push(vendorId) }
    if (from)     { sql += ' AND i.issued_at >= ?'; params.push(from) }
    if (to)       { sql += ' AND i.issued_at <= ?'; params.push(to) }
    sql += ' ORDER BY i.issued_at DESC'
    const [rows] = await req.db.execute(sql, params)
    res.json(await Promise.all(rows.map(r => attachMatches(req.db, r))))
  } catch (e) { next(e) }
})

router.get('/summary/receivables', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute("SELECT * FROM invoices WHERE kind='issued'")
    const active = rows.filter(r => RECEIVABLE_STATUSES.has(r.status))
    const withMatches = await Promise.all(active.map(r => attachMatches(req.db, r)))
    const today = kstToday()
    const overdueRows = withMatches.filter(r => r.remainAmount > 0 && r.due_at && r.due_at < today)
    const summary = {
      total:        withMatches.reduce((s, r) => s + r.remainAmount, 0),
      count:        withMatches.length,
      overdue:      overdueRows.reduce((s, r) => s + r.remainAmount, 0),
      overdueCount: overdueRows.length,
      longOverdue:  withMatches.filter(r => r.status === '장기 미수').reduce((s, r) => s + r.remainAmount, 0),
    }
    res.json({ summary, rows: withMatches })
  } catch (e) { next(e) }
})

router.get('/summary/payables', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute("SELECT * FROM invoices WHERE kind='received'")
    const withMatches = await Promise.all(rows.map(r => attachMatches(req.db, r)))
    const pending = withMatches.filter(r => PAYABLE_STATUSES.has(r.status))
    const today = kstToday()
    const overdueRows = pending.filter(r => r.remainAmount > 0 && r.due_at && r.due_at < today)
    const summary = {
      total:           pending.reduce((s, r) => s + r.remainAmount, 0),
      count:           pending.length,
      overdue:         overdueRows.reduce((s, r) => s + r.remainAmount, 0),
      overdueCount:    overdueRows.length,
      pendingApproval: pending.filter(r => r.status === '지급 대기').reduce((s, r) => s + r.remainAmount, 0),
    }
    res.json({ summary, rows: withMatches })
  } catch (e) { next(e) }
})

router.get('/summary/vat', async (req, res, next) => {
  try {
    const { quarter, year } = req.query
    const y = year || Number(kstToday().slice(0, 4))
    const months = { Q1: ['01','02','03'], Q2: ['04','05','06'], Q3: ['07','08','09'], Q4: ['10','11','12'] }[quarter] || []
    if (!months.length) return res.json({ salesVat: 0, purchaseVat: 0, netVat: 0, rows: [] })
    const placeholders = months.map(() => 'i.issued_at LIKE ?').join(' OR ')
    const params = months.map(m => `${y}-${m}%`)
    const [all] = await req.db.execute(
      `SELECT i.*, v.name AS vendor_name FROM invoices i
       LEFT JOIN vendors v ON i.vendor_id = v.id
       WHERE (${placeholders})`,
      params
    )
    const salesVat    = all.filter(r => r.kind === 'issued').reduce((s, r) => s + Number(r.vat_amount), 0)
    const purchaseVat = all.filter(r => r.kind === 'received').reduce((s, r) => s + Number(r.vat_amount), 0)
    res.json({ salesVat, purchaseVat, netVat: salesVat - purchaseVat, rows: all })
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM invoices WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(await attachMatches(req.db, rows[0]))
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo } = req.body
    const id = randomUUID()
    // 친화적 청구번호 생성: 청구-2026-0001 / 매입-2026-0001 (최대 일련번호+1 — 삭제해도 재사용 안 됨)
    const year = String(issued_at || '').slice(0, 4) || kstToday().slice(0, 4)
    const prefix = kind === 'issued' ? '청구' : '매입'
    const [[{ maxno }]] = await req.db.execute(
      "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind = ? AND invoice_no LIKE ?",
      [kind, `${prefix}-${year}-%`]
    )
    const invoice_no = `${prefix}-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    await req.db.execute(
      'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, invoice_no, kind, vendor_id||null, contract_id||null, supply_amount, vat_amount, total_amount, issued_at, due_at||null, status||(kind==='issued' ? '입금 예정' : '지급 대기'), account_id||null, memo||'']
    )
    res.json({ id, invoice_no })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo } = req.body
    const [result] = await req.db.execute(
      'UPDATE invoices SET vendor_id=?, contract_id=?, supply_amount=?, vat_amount=?, total_amount=?, issued_at=?, due_at=?, status=?, account_id=?, memo=? WHERE id=?',
      [vendor_id||null, contract_id||null, supply_amount, vat_amount, total_amount, issued_at, due_at||null, status, account_id||null, memo||'', req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const id = req.params.id
    // 입금/지급(매칭) 내역이 있으면 삭제 금지 — 이미 장부에 반영된 돈이므로
    const [[{ mcnt }]] = await conn.execute('SELECT COUNT(*) AS mcnt FROM invoice_matches WHERE invoice_id = ?', [id])
    if (mcnt > 0) { await rollbackQuietly(conn); return res.status(409).json({ error: '입금·지급 내역이 있는 청구서는 삭제할 수 없어요. 먼저 입금 매칭을 취소하세요.' }) }
    // 정기청구에서 나온 회차면 last_generated 를 되돌려 '발행 예정'에 다시 뜨게 한다.
    // 안 하면 그 달치가 자동 생성에도 예정 목록에도 안 나와 매출이 조용히 미청구로 사라진다.
    const [[inv]] = await conn.execute('SELECT recurring_id, issued_at FROM invoices WHERE id = ?', [id])
    await conn.execute('DELETE FROM invoice_matches WHERE invoice_id = ?', [id])
    await conn.execute('DELETE FROM invoice_docs WHERE invoice_id = ?', [id])
    await conn.execute('UPDATE transactions SET invoice_id = NULL WHERE invoice_id = ?', [id])
    // 연결된 청구 일정은 '예정'으로 되돌려 발행 예정에 다시 노출(고아 방지)
    await conn.execute("UPDATE milestones SET status = '예정', invoice_id = NULL WHERE invoice_id = ?", [id])
    await conn.execute('DELETE FROM invoices WHERE id = ?', [id])
    const rec = inv?.recurring_id
      ? await restoreLastGenerated(conn, 'recurring_invoices', inv.recurring_id, inv.issued_at)
      : { restored: false, note: null }
    await conn.commit()
    res.json({ ok: true, recurringNote: rec.note })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

router.post('/:id/matches', async (req, res, next) => {
  // account_code(계정과목 코드)와 account_id(입출금 계좌)는 다른 값이다 — 섞지 말 것.
  const { txn_id, amount, date, category, memo, account_code, account_id } = req.body
  const invoiceId = req.params.id
  const dateErr = futureDateError(date)
  if (dateErr) return res.status(400).json({ error: dateErr })
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[inv]] = await conn.execute('SELECT * FROM invoices WHERE id = ? FOR UPDATE', [invoiceId])
    if (!inv) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const isIssued = inv.kind === 'issued'

    // 과입금 방지: 잔여를 초과하지 않도록 매칭 금액 제한
    const [[{ paid: prevPaid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [invoiceId])
    const remainBefore = Number(inv.total_amount) - Number(prevPaid)
    if (remainBefore <= 0) { await rollbackQuietly(conn); return res.status(400).json({ error: '이미 정산이 완료된 청구서예요' }) }
    const matchAmount = Math.min(Number(amount) || 0, remainBefore)
    if (matchAmount <= 0) { await rollbackQuietly(conn); return res.status(400).json({ error: '매칭 금액이 올바르지 않아요' }) }

    // 매칭 대상 거래: 기존 거래가 있으면 그대로, 없으면 실제 거래를 새로 만들어 거래내역에 반영
    let realTxnId = null
    if (txn_id) {
      // 다른 청구서에 이미 매칭된 거래는 재사용 금지(이중 매칭 방지)
      const [[dup]] = await conn.execute('SELECT invoice_id FROM invoice_matches WHERE txn_id = ? LIMIT 1', [txn_id])
      if (dup) { await rollbackQuietly(conn); return res.status(409).json({ error: '이미 다른 청구서에 매칭된 거래예요' }) }
      const [[ex]] = await conn.execute('SELECT id FROM transactions WHERE id = ?', [txn_id])
      if (ex) realTxnId = ex.id
    }
    if (realTxnId) {
      // 기존 거래를 재사용할 때 invoice_id만 붙이면, 그 거래가 아직 '지급 대기'인 경우
      // 청구서만 완료되고 지출은 계좌 잔액에서 빠지지 않는다(accounts.js는 '지급완료'만 센다).
      // 정산했다는 것은 실제로 돈이 오갔다는 뜻이므로 거래도 완료 상태로 맞춘다.
      const [[cur]] = await conn.execute('SELECT status, account_id FROM transactions WHERE id = ?', [realTxnId])
      const acct = cur?.account_id || account_id || inv.account_id || null
      const lerr = ledgerError({ kind: isIssued ? 'income' : 'expense', account_id: acct, status: isIssued ? '입금완료' : '지급완료' })
      if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: lerr }) }
      await conn.execute(
        'UPDATE transactions SET invoice_id = ?, status = ?, account_id = ? WHERE id = ?',
        [invoiceId, isIssued ? '입금완료' : '지급완료', acct, realTxnId])
    } else {
      // 정산은 실제로 돈이 오간 것이므로 status를 완료형으로 확정한다. 그런데 계좌가 비면
      // 그 돈은 어느 계좌 잔액에도 잡히지 않는다(accounts.js calcBalance는 account_id로 계좌를
      // 특정해 합산). 정기청구·계약에서 자동 생성된 청구서는 account_id가 NULL이므로
      // 여기서 막지 않으면 입금이 통째로 잔액에서 누락된다 — 과거 F-02와 동일 유형.
      const acct = account_id || inv.account_id || null
      const lerr = ledgerError({ kind: isIssued ? 'income' : 'expense', account_id: acct, status: isIssued ? '입금완료' : '지급완료' })
      if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: lerr }) }
      realTxnId = randomUUID()
      const cat   = (category && category.trim()) || (isIssued ? '수금' : '대금 지급')
      const memoV = (memo && memo.trim()) || `청구서 ${inv.invoice_no || ''} 정산`.trim()
      await conn.execute(`
        INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, category, amount, date, method, status, buyer_type, doc_no, invoice_id, memo, account_code)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [realTxnId, isIssued ? 'income' : 'expense', inv.vendor_id || null, inv.contract_id || null,
          acct, cat, matchAmount,
          date || kstToday(), '계좌이체',   // UTC(new Date())면 KST 새벽에 하루 전으로 찍힌다
          isIssued ? '입금완료' : '지급완료', '공통', inv.contract_id ? '' : '공통', invoiceId, memoV, account_code || null])
    }

    const id = randomUUID()
    await conn.execute('INSERT INTO invoice_matches (id, invoice_id, txn_id, amount) VALUES (?,?,?,?)', [id, invoiceId, realTxnId, matchAmount])

    // 매칭 누계로 청구서 상태 자동 갱신
    const [[{ paid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [invoiceId])
    const total = Number(inv.total_amount)
    const status = Number(paid) >= total ? (isIssued ? '입금 완료' : '지급 완료') : (isIssued ? '일부 입금' : '일부 지급')
    await conn.execute('UPDATE invoices SET status = ? WHERE id = ?', [status, invoiceId])
    await conn.execute('UPDATE milestones SET status = ? WHERE invoice_id = ?', [status, invoiceId])

    await conn.commit()
    res.json({ id, txn_id: realTxnId })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// ── 매칭 후보: 거래내역에 이미 있는(미매칭) 같은 종류 거래 ──
router.get('/:id/matchable', async (req, res, next) => {
  try {
    const [invRows] = await req.db.execute('SELECT kind, vendor_id, supply_amount, total_amount FROM invoices WHERE id = ?', [req.params.id])
    const inv = invRows[0]
    if (!inv) return res.json([])
    const txnKind = inv.kind === 'issued' ? 'income' : 'expense'
    const [[{ paid }]] = await req.db.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [req.params.id])
    const supply = Number(inv.supply_amount), total = Number(inv.total_amount), remain = total - Number(paid)
    const [rows] = await req.db.execute(`
      SELECT t.id, t.amount, t.date, t.category, t.vendor_id, t.status, t.account_id, v.name AS vendor_name
      FROM transactions t
      LEFT JOIN vendors v ON t.vendor_id = v.id
      WHERE t.kind = ?
        AND (t.invoice_id IS NULL OR t.invoice_id = '')
        AND t.id NOT IN (SELECT txn_id FROM invoice_matches)
      ORDER BY t.date DESC
      LIMIT 100
    `, [txnKind])
    const enriched = rows.map(r => {
      const amt = Number(r.amount)
      const sameVendor = !!inv.vendor_id && r.vendor_id === inv.vendor_id
      const matchTotal = amt === total
      const matchSupply = amt === supply
      const matchRemain = amt === remain
      const related = sameVendor || matchTotal || matchSupply || matchRemain
      // 정렬 점수: 거래처+금액 둘 다 일치 > 금액 일치 > 거래처 일치
      const score = (sameVendor ? 1 : 0) + ((matchTotal || matchRemain || matchSupply) ? 2 : 0)
      return { ...r, sameVendor, matchTotal, matchSupply, matchRemain, related, score }
    })
    enriched.sort((a, b) => (b.score - a.score) || (a.date < b.date ? 1 : -1))
    res.json(enriched)
  } catch (e) { next(e) }
})

router.delete('/:id/matches/:matchId', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[inv]] = await conn.execute('SELECT * FROM invoices WHERE id = ? FOR UPDATE', [req.params.id])
    if (!inv) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    // 삭제할 매칭의 거래는 청구서 연결만 해제(장부에는 남김 — 실제 오간 돈일 수 있어 삭제하지 않는다).
    const [[match]] = await conn.execute('SELECT txn_id FROM invoice_matches WHERE id = ? AND invoice_id = ?', [req.params.matchId, req.params.id])
    await conn.execute('DELETE FROM invoice_matches WHERE id = ? AND invoice_id = ?', [req.params.matchId, req.params.id])
    if (match && match.txn_id) await conn.execute('UPDATE transactions SET invoice_id = NULL WHERE id = ?', [match.txn_id])
    // 남은 매칭 누계로 청구서·마일스톤 상태 재계산 — 안 하면 remain이 생겨도 '완료'로 남아 미수/미지급이 누락된다.
    const [[{ paid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [req.params.id])
    const isIssued = inv.kind === 'issued'
    const total = Number(inv.total_amount)
    const status = Number(paid) <= 0 ? (isIssued ? '입금 예정' : '지급 대기')
      : Number(paid) >= total ? (isIssued ? '입금 완료' : '지급 완료')
      : (isIssued ? '일부 입금' : '일부 지급')
    await conn.execute('UPDATE invoices SET status = ? WHERE id = ?', [status, req.params.id])
    await conn.execute('UPDATE milestones SET status = ? WHERE invoice_id = ?', [status, req.params.id])
    await conn.commit()
    res.json({ ok: true, status })
  } catch (e) { await rollbackQuietly(conn); next(e) } finally { conn.release() }
})

// ── 청구서 첨부 서류 ──
router.post('/:id/docs', async (req, res, next) => {
  try {
    const { url, name, doc_type, size } = req.body
    if (!url) return res.status(400).json({ error: 'url 필수' })
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO invoice_docs (id, invoice_id, url, name, doc_type, size) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, url, name || '', doc_type || '', size || 0]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.delete('/docs/:docId', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM invoice_docs WHERE id = ?', [req.params.docId])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
