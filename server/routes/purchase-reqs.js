const { Router } = require('express')
const { randomUUID } = require('crypto')
const { kstToday } = require('../db')
const { rollbackQuietly } = require('../lib/tx')

const router = Router()
const parseJson = (v, fb) => { try { return v ? JSON.parse(v) : fb } catch { return fb } }

// 기본 결재선(구매품의는 담당/부장/이사/대표이사 5단이 흔하지만, 회사 프리셋을 그대로 쓴다)
const defaultApproval = async (execFn) => {
  const [[p]] = await execFn('SELECT steps FROM approval_presets WHERE is_default=1 ORDER BY sort_order LIMIT 1')
  const steps = parseJson(p && p.steps, null)
  if (steps && steps.length) return steps.map(s => ({ label: s.label || '', position: s.position || '', name: '' }))
  return [{ label: '담당', position: '' }, { label: '부장', position: '' }, { label: '이사', position: '' }, { label: '대표이사', position: '' }]
}

const adaptItem = (it) => ({ ...it, qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0, amount: Number(it.amount) || 0 })
const adapt = (r, items) => {
  const its = (items || []).map(adaptItem)
  const total = its.reduce((s, it) => s + it.amount, 0)
  return { ...r, order_amount: Number(r.order_amount) || 0, items: its, total, approval: parseJson(r.approval, []) }
}

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM purchase_reqs ORDER BY created_at DESC')
    const [sums] = await req.db.execute('SELECT req_id, COALESCE(SUM(amount),0) AS total FROM purchase_req_items GROUP BY req_id')
    const map = {}
    for (const s of sums) map[s.req_id] = Number(s.total)
    res.json(rows.map(r => ({ ...r, order_amount: Number(r.order_amount) || 0, total: map[r.id] || 0, approval: parseJson(r.approval, []) })))
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [[r]] = await req.db.execute('SELECT * FROM purchase_reqs WHERE id = ?', [req.params.id])
    if (!r) return res.status(404).json({ error: 'Not found' })
    const [items] = await req.db.execute('SELECT * FROM purchase_req_items WHERE req_id = ? ORDER BY sort_order, id', [req.params.id])
    res.json(adapt(r, items))
  } catch (e) { next(e) }
})

const insertItems = async (conn, reqId, items) => {
  const list = Array.isArray(items) ? items.filter(it => (it.name && it.name.trim()) || Number(it.amount) || Number(it.qty)) : []
  let i = 0
  for (const it of list) {
    const qty = Number(it.qty) || 0, price = Number(it.unit_price) || 0
    const amount = Number(it.amount) || qty * price
    await conn.execute(
      'INSERT INTO purchase_req_items (id, req_id, name, spec, unit, qty, unit_price, amount, memo, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [randomUUID(), reqId, it.name || '', it.spec || '', it.unit || '', qty, price, amount, it.memo || '', i++])
  }
}

const HEAD_COLS = ['req_date', 'vendor_id', 'vendor_name', 'order_source', 'ship_no', 'summary', 'arrival_date', 'order_amount', 'pay_terms', 'man_hours', 'applicant', 'note']
const headVals = (b) => [b.req_date || null, b.vendor_id || null, b.vendor_name || '', b.order_source || '', b.ship_no || '',
  b.summary || '', b.arrival_date || null, Number(b.order_amount) || 0, b.pay_terms || '', b.man_hours || '', b.applicant || '', b.note || '']

router.post('/', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const year = (req.body.req_date || kstToday()).slice(0, 4)
    const [[{ maxno }]] = await conn.execute(
      `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(doc_no, '-', -1) AS UNSIGNED)), 0) AS maxno
       FROM purchase_reqs WHERE doc_no LIKE ? FOR UPDATE`, [`GM-${year}-%`])
    const doc_no = `GM-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    const id = randomUUID()
    const approval = Array.isArray(req.body.approval) && req.body.approval.length
      ? req.body.approval : await defaultApproval((sql, p) => conn.execute(sql, p))
    const applicant = req.body.applicant || req.user?.name || req.user?.username || '관리자'
    await conn.execute(
      `INSERT INTO purchase_reqs (id, doc_no, ${HEAD_COLS.join(', ')}, approval, status) VALUES (?,?,${HEAD_COLS.map(() => '?').join(',')},?,?)`,
      [id, doc_no, ...headVals({ ...req.body, applicant }), JSON.stringify(approval), '작성'])
    await insertItems(conn, id, req.body.items)
    await conn.commit()
    const [[head]] = await req.db.execute('SELECT * FROM purchase_reqs WHERE id = ?', [id])
    const [items] = await req.db.execute('SELECT * FROM purchase_req_items WHERE req_id = ? ORDER BY sort_order, id', [id])
    res.json(adapt(head, items))
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.put('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[cur]] = await conn.execute('SELECT id FROM purchase_reqs WHERE id = ? FOR UPDATE', [req.params.id])
    if (!cur) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    await conn.execute(
      `UPDATE purchase_reqs SET ${HEAD_COLS.map(c => `${c}=?`).join(', ')}, status=?, approval=? WHERE id=?`,
      [...headVals(req.body), req.body.status || '작성', JSON.stringify(Array.isArray(req.body.approval) ? req.body.approval : []), req.params.id])
    await conn.execute('DELETE FROM purchase_req_items WHERE req_id = ?', [req.params.id])
    await insertItems(conn, req.params.id, req.body.items)
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM purchase_req_items WHERE req_id = ?', [req.params.id])
    await req.db.execute('DELETE FROM purchase_reqs WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
