const { Router } = require('express')
const { randomUUID } = require('crypto')
const { kstToday } = require('../db')
const { rollbackQuietly } = require('../lib/tx')
const { amountError } = require('../lib/ledger')
const { addDays } = require('../lib/recurrence')
const { recurFromSupply } = require('../lib/vat')

const router = Router()
const parseJson = (v, fb) => { try { return v ? JSON.parse(v) : fb } catch { return fb } }

// 기본 결재선(구매품의는 담당/부장/이사/대표이사 5단이 흔하지만, 회사 프리셋을 그대로 쓴다)
const defaultApproval = async (execFn) => {
  const [[p]] = await execFn('SELECT steps FROM approval_presets WHERE is_default=1 ORDER BY sort_order LIMIT 1')
  const steps = parseJson(p && p.steps, null)
  if (steps && steps.length) return steps.map(s => ({ label: s.label || '', position: s.position || '', name: '' }))
  return [{ label: '담당', position: '' }, { label: '부장', position: '' }, { label: '이사', position: '' }, { label: '대표이사', position: '' }]
}

const adaptItem = (it) => ({ ...it, qty: Number(it.qty) || 0, unit_price: Number(it.unit_price) || 0, amount: Number(it.amount) || 0,
  actual_price: Number(it.actual_price) || 0, actual_amount: Number(it.actual_amount) || 0 })
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
    // 미지급금 등록 상태(삭제됐으면 링크가 남아 있어도 null → 재등록 허용)
    let payable = null
    if (r.invoice_id) {
      const [[inv]] = await req.db.execute('SELECT id, invoice_no, status, total_amount FROM invoices WHERE id = ?', [r.invoice_id])
      if (inv) payable = { id: inv.id, invoice_no: inv.invoice_no, status: inv.status, total: Number(inv.total_amount) || 0 }
    }
    res.json({ ...adapt(r, items), payable })
  } catch (e) { next(e) }
})

const insertItems = async (conn, reqId, items) => {
  const list = Array.isArray(items) ? items.filter(it => (it.name && it.name.trim()) || Number(it.amount) || Number(it.qty)) : []
  let i = 0
  for (const it of list) {
    const qty = Number(it.qty) || 0, price = Number(it.unit_price) || 0, aprice = Number(it.actual_price) || 0
    const amount = Number(it.amount) || qty * price
    const aamount = Number(it.actual_amount) || qty * aprice
    await conn.execute(
      'INSERT INTO purchase_req_items (id, req_id, name, spec, unit, qty, unit_price, amount, actual_price, actual_amount, memo, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [randomUUID(), reqId, it.name || '', it.spec || '', it.unit || '', qty, price, amount, aprice, aamount, it.memo || '', i++])
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

// 구매품의서 → 미지급금(매입 청구서) 등록. 품의금액을 공급가로 보고 과세유형으로 세액을 매긴다.
// 실제 지급이 아니라 '지급 대기' 상태의 미지급금만 만든다(자금 이동·마감 검사 불필요).
const VAT_MODES = { '과세': 'exclusive', '면세': 'none', '영세': 'zero', exclusive: 'exclusive', none: 'none', zero: 'zero' }
router.post('/:id/issue-payable', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[r]] = await conn.execute('SELECT * FROM purchase_reqs WHERE id = ? FOR UPDATE', [req.params.id])
    if (!r) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    if (r.invoice_id) {
      const [[inv]] = await conn.execute('SELECT invoice_no FROM invoices WHERE id = ?', [r.invoice_id])
      if (inv) { await rollbackQuietly(conn); return res.status(409).json({ error: `이미 미지급금(${inv.invoice_no})으로 등록됐어요` }) }
    }
    if (!r.vendor_id) { await rollbackQuietly(conn); return res.status(400).json({ error: '공급업체를 거래처로 지정한 뒤 등록해주세요' }) }

    const supplyIn = Number(req.body.supply_amount)
    const supplyBase = Number.isFinite(supplyIn) && supplyIn > 0 ? supplyIn : null
    if (!supplyBase) { await rollbackQuietly(conn); return res.status(400).json({ error: '공급가를 확인해주세요' }) }
    const vatMode = VAT_MODES[req.body.vat_mode] || 'exclusive'
    const { supply, vat, tax_type } = recurFromSupply(supplyBase, vatMode)
    const total = supply + vat
    const issued = kstToday()
    const due = req.body.due || addDays(issued, 30)
    const year = issued.slice(0, 4)
    const [[{ maxno }]] = await conn.execute(
      "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind='received' AND invoice_no LIKE ?",
      [`매입-${year}-%`])
    const invoice_no = `매입-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    const invId = randomUUID()
    // 품목 금액이 비어 있으면 0원 매입 청구서가 되어 '지급 대기'로 남는다.
    { const ae = amountError(total); if (ae) { await rollbackQuietly(conn); return res.status(400).json({ error: ae }) } }
    await conn.execute(
      'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, recurring_id, memo, tax_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [invId, invoice_no, 'received', r.vendor_id, null, supply, vat, total, issued, due, '지급 대기', null, null, `구매품의서 ${r.doc_no}`, tax_type])
    /* 품의서에 적은 품목을 청구서에도 싣는다.
     *
     * 여태 총액만 넘겨서, 품명·규격·수량·단가를 다 적어 결재까지 받은 품의서가
     * 미지급금이 되는 순간 "구매품의서 GM-… 한 줄"로 납작해졌다. 그 청구서로 만든
     * 지급결의서도 당연히 "매입 대금 지급 · 식 · 1"이 됐다 — 같은 내용을 세 번 적고도
     * 마지막 문서에는 아무것도 안 남는 셈이다.
     *
     * 금액은 청구서 쪽을 따른다. 사용자가 등록 화면에서 공급가를 고칠 수 있어서
     * (VAT 별도/포함 전환·단가 조정) 품의 합계와 다를 수 있는데, 청구서에 찍히는 돈은
     * supply 다. 두 값이 어긋나면 **차액을 한 줄로 세워** 합이 맞게 한다 —
     * 조용히 안 맞느니 "조정"이 문서에 보이는 편이 낫다.
     */
    const [reqItems] = await conn.execute(
      'SELECT * FROM purchase_req_items WHERE req_id = ? ORDER BY sort_order, id', [req.params.id])
    const usable = reqItems.filter(it => (it.name || '').trim() || Number(it.amount))
    if (usable.length) {
      let ord = 0, sum = 0
      for (const it of usable) {
        const amt = Number(it.amount) || 0
        sum += amt
        await conn.execute(
          `INSERT INTO invoice_lines (id, invoice_id, name, spec, unit, qty, weight, price_basis, unit_price, amount, sort_order)
           VALUES (?,?,?,?,?,?,0,'qty',?,?,?)`,
          [randomUUID(), invId, it.name || '(품목명 없음)', it.spec || null, it.unit || null,
           Number(it.qty) || 0, Number(it.unit_price) || 0, amt, ++ord])
      }
      const diff = supply - sum
      if (diff !== 0) {
        await conn.execute(
          `INSERT INTO invoice_lines (id, invoice_id, name, spec, unit, qty, weight, price_basis, unit_price, amount, sort_order)
           VALUES (?,?,?,?,?,1,0,'qty',?,?,?)`,
          [randomUUID(), invId, '등록 시 금액 조정', `품의 합계 ${sum.toLocaleString('ko-KR')}원 대비`, null, diff, diff, ++ord])
      }
    }
    await conn.execute('UPDATE purchase_reqs SET invoice_id = ? WHERE id = ?', [invId, req.params.id])
    await conn.commit()
    res.json({ ok: true, invoice_id: invId, invoice_no, lines: usable.length })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

module.exports = router
