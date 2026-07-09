const { Router } = require('express')
const { randomUUID } = require('crypto')
const { pool } = require('../db')

const router = Router()

const RECEIVABLE_STATUSES = new Set(['입금 예정', '일부 입금', '기한 지남', '장기 미수'])
const PAYABLE_STATUSES    = new Set(['지급 대기', '지급 예정', '일부 지급', '기한 지남'])

async function attachMatches(invoice) {
  const [matches] = await pool.execute('SELECT * FROM invoice_matches WHERE invoice_id = ?', [invoice.id])
  const [docs] = await pool.execute('SELECT id, url, name, doc_type, size, created_at FROM invoice_docs WHERE invoice_id = ? ORDER BY created_at', [invoice.id])
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
    const [rows] = await pool.execute(sql, params)
    res.json(await Promise.all(rows.map(attachMatches)))
  } catch (e) { next(e) }
})

router.get('/summary/receivables', async (_, res, next) => {
  try {
    const [rows] = await pool.execute("SELECT * FROM invoices WHERE kind='issued'")
    const active = rows.filter(r => RECEIVABLE_STATUSES.has(r.status))
    const withMatches = await Promise.all(active.map(attachMatches))
    const today = new Date().toISOString().slice(0, 10)
    const summary = {
      total:       withMatches.reduce((s, r) => s + r.remainAmount, 0),
      count:       withMatches.length,
      overdue:     withMatches.filter(r => r.due_at < today && r.status !== '장기 미수').reduce((s, r) => s + r.remainAmount, 0),
      longOverdue: withMatches.filter(r => r.status === '장기 미수').reduce((s, r) => s + r.remainAmount, 0),
    }
    res.json({ summary, rows: withMatches })
  } catch (e) { next(e) }
})

router.get('/summary/payables', async (_, res, next) => {
  try {
    const [rows] = await pool.execute("SELECT * FROM invoices WHERE kind='received'")
    const withMatches = await Promise.all(rows.map(attachMatches))
    const pending = withMatches.filter(r => PAYABLE_STATUSES.has(r.status))
    const today = new Date().toISOString().slice(0, 10)
    const summary = {
      total:          pending.reduce((s, r) => s + r.remainAmount, 0),
      count:          pending.length,
      overdue:        pending.filter(r => r.due_at < today).reduce((s, r) => s + r.remainAmount, 0),
      pendingApproval: pending.filter(r => r.status === '지급 대기').reduce((s, r) => s + r.remainAmount, 0),
    }
    res.json({ summary, rows: withMatches })
  } catch (e) { next(e) }
})

router.get('/summary/vat', async (req, res, next) => {
  try {
    const { quarter, year } = req.query
    const y = year || new Date().getFullYear()
    const months = { Q1: ['01','02','03'], Q2: ['04','05','06'], Q3: ['07','08','09'], Q4: ['10','11','12'] }[quarter] || []
    if (!months.length) return res.json({ salesVat: 0, purchaseVat: 0, netVat: 0, rows: [] })
    const placeholders = months.map(() => 'i.issued_at LIKE ?').join(' OR ')
    const params = months.map(m => `${y}-${m}%`)
    const [all] = await pool.execute(
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
    const [rows] = await pool.execute('SELECT * FROM invoices WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(await attachMatches(rows[0]))
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo } = req.body
    const id = randomUUID()
    // 친화적 청구번호 생성: 청구-2026-0001 / 매입-2026-0001 (최대 일련번호+1 — 삭제해도 재사용 안 됨)
    const year = String(issued_at || '').slice(0, 4) || String(new Date().getFullYear())
    const prefix = kind === 'issued' ? '청구' : '매입'
    const [[{ maxno }]] = await pool.execute(
      "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind = ? AND invoice_no LIKE ?",
      [kind, `${prefix}-${year}-%`]
    )
    const invoice_no = `${prefix}-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    await pool.execute(
      'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, invoice_no, kind, vendor_id||null, contract_id||null, supply_amount, vat_amount, total_amount, issued_at, due_at||null, status||(kind==='issued' ? '입금 예정' : '지급 대기'), account_id||null, memo||'']
    )
    res.json({ id, invoice_no })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo } = req.body
    const [result] = await pool.execute(
      'UPDATE invoices SET vendor_id=?, contract_id=?, supply_amount=?, vat_amount=?, total_amount=?, issued_at=?, due_at=?, status=?, account_id=?, memo=? WHERE id=?',
      [vendor_id||null, contract_id||null, supply_amount, vat_amount, total_amount, issued_at, due_at||null, status, account_id||null, memo||'', req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await pool.execute('DELETE FROM invoices WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.post('/:id/matches', async (req, res, next) => {
  try {
    const { txn_id, amount, date } = req.body
    const invoiceId = req.params.id
    const [invRows] = await pool.execute('SELECT * FROM invoices WHERE id = ?', [invoiceId])
    const inv = invRows[0]
    if (!inv) return res.status(404).json({ error: 'Not found' })
    const isIssued = inv.kind === 'issued'

    // 매칭 대상 거래: 기존 거래가 있으면 그대로, 없으면 실제 거래를 새로 만들어 거래내역에 반영
    let realTxnId = null
    if (txn_id) {
      const [ex] = await pool.execute('SELECT id FROM transactions WHERE id = ?', [txn_id])
      if (ex[0]) realTxnId = ex[0].id
    }
    if (realTxnId) {
      // 기존 거래에 연결 시 거래 쪽에도 청구서 연결 표시(양방향)
      await pool.execute('UPDATE transactions SET invoice_id = ? WHERE id = ?', [invoiceId, realTxnId])
    }
    if (!realTxnId) {
      realTxnId = randomUUID()
      await pool.execute(`
        INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, category, amount, date, method, status, buyer_type, doc_no, invoice_id, memo)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [realTxnId, isIssued ? 'income' : 'expense', inv.vendor_id || null, inv.contract_id || null,
          inv.account_id || null, isIssued ? '수금' : '대금 지급', amount,
          date || new Date().toISOString().slice(0, 10), '계좌이체',
          isIssued ? '입금완료' : '지급완료', '공통', inv.contract_id ? '' : '공통', invoiceId, `청구서 ${inv.invoice_no || ''} 정산`.trim()])
    }

    const id = randomUUID()
    await pool.execute(
      'INSERT INTO invoice_matches (id, invoice_id, txn_id, amount) VALUES (?,?,?,?)',
      [id, invoiceId, realTxnId, amount]
    )

    // 매칭 누계로 청구서 상태 자동 갱신
    const [[{ paid }]] = await pool.execute(
      'SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [invoiceId]
    )
    const total = Number(inv.total_amount)
    let status = null
    if (Number(paid) >= total)     status = isIssued ? '입금 완료' : '지급 완료'
    else if (Number(paid) > 0)     status = isIssued ? '일부 입금' : '일부 지급'
    if (status) await pool.execute('UPDATE invoices SET status = ? WHERE id = ?', [status, invoiceId])

    res.json({ id, txn_id: realTxnId })
  } catch (e) { next(e) }
})

// ── 매칭 후보: 거래내역에 이미 있는(미매칭) 같은 종류 거래 ──
router.get('/:id/matchable', async (req, res, next) => {
  try {
    const [invRows] = await pool.execute('SELECT kind, vendor_id, supply_amount, total_amount FROM invoices WHERE id = ?', [req.params.id])
    const inv = invRows[0]
    if (!inv) return res.json([])
    const txnKind = inv.kind === 'issued' ? 'income' : 'expense'
    const [[{ paid }]] = await pool.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [req.params.id])
    const supply = Number(inv.supply_amount), total = Number(inv.total_amount), remain = total - Number(paid)
    const [rows] = await pool.execute(`
      SELECT t.id, t.amount, t.date, t.category, t.vendor_id, v.name AS vendor_name
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
  try {
    await pool.execute(
      'DELETE FROM invoice_matches WHERE id = ? AND invoice_id = ?',
      [req.params.matchId, req.params.id]
    )
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// ── 청구서 첨부 서류 ──
router.post('/:id/docs', async (req, res, next) => {
  try {
    const { url, name, doc_type, size } = req.body
    if (!url) return res.status(400).json({ error: 'url 필수' })
    const id = randomUUID()
    await pool.execute(
      'INSERT INTO invoice_docs (id, invoice_id, url, name, doc_type, size) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, url, name || '', doc_type || '', size || 0]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.delete('/docs/:docId', async (req, res, next) => {
  try {
    await pool.execute('DELETE FROM invoice_docs WHERE id = ?', [req.params.docId])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
