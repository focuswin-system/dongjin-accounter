const { Router } = require('express')
const { randomUUID } = require('crypto')
const { pool } = require('../db')

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    const { vendorId, buyerCode, status } = req.query
    let sql = `SELECT c.*, v.name AS vendor_name,
        COALESCE((SELECT SUM(amount) FROM transactions WHERE contract_id=c.id AND kind='income'),0)  AS in_done,
        COALESCE((SELECT SUM(amount) FROM transactions WHERE contract_id=c.id AND kind='expense'),0) AS out_total
      FROM contracts c LEFT JOIN vendors v ON c.vendor_id = v.id WHERE 1=1`
    const params = []
    if (vendorId)  { sql += ' AND c.vendor_id = ?';  params.push(vendorId) }
    if (buyerCode) { sql += ' AND c.buyer_code = ?'; params.push(buyerCode) }
    if (status)    { sql += ' AND c.status = ?';     params.push(status) }
    sql += ' ORDER BY c.created_at DESC'
    const [rows] = await pool.execute(sql, params)
    res.json(rows.map(r => {
      const in_done = Number(r.in_done || 0)
      const out = Number(r.out_total || 0)
      const remain = (r.amount || 0) - in_done
      return {
        ...r, in_done, out, remain: remain > 0 ? remain : 0, profit: in_done - out,
        cost_budget: r.cost_budget ? JSON.parse(r.cost_budget) : null,
      }
    }))
  } catch (e) { next(e) }
})

// 발행 예정(대기) 청구 일정 — 계약 청구 일정 중 status='예정' (gubu로 매출/매입 구분)
router.get('/schedule/pending', async (req, res, next) => {
  try {
    const { gubu } = req.query
    let sql = `SELECT m.id AS milestone_id, m.type, m.amount, m.due_date,
                      c.id AS contract_id, c.name AS contract_name, c.contract_no, c.vendor_id,
                      v.name AS vendor_name, v.gubu
               FROM milestones m
               JOIN contracts c ON m.contract_id = c.id
               LEFT JOIN vendors v ON c.vendor_id = v.id
               WHERE m.status = '예정'`
    const params = []
    if (gubu) { sql += ' AND v.gubu = ?'; params.push(gubu) }
    sql += ' ORDER BY m.due_date'
    const [rows] = await pool.execute(sql, params)
    res.json(rows.map(r => ({ ...r, amount: Number(r.amount) })))
  } catch (e) { next(e) }
})

// 청구 일정 단건 상태 변경(발행/기입금 처리 후 목록에서 제외)
router.patch('/milestones/:id/status', async (req, res, next) => {
  try {
    const [result] = await pool.execute('UPDATE milestones SET status=? WHERE id=?', [req.body.status || '예정', req.params.id])
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [cRows] = await pool.execute(
      'SELECT c.*, v.name AS vendor_name FROM contracts c LEFT JOIN vendors v ON c.vendor_id = v.id WHERE c.id = ?',
      [req.params.id]
    )
    if (!cRows[0]) return res.status(404).json({ error: 'Not found' })
    const c = cRows[0]
    const [milestones] = await pool.execute(
      'SELECT * FROM milestones WHERE contract_id = ? ORDER BY due_date',
      [req.params.id]
    )
    const [incomeRows] = await pool.execute(
      "SELECT t.*, v.name AS vendor_name FROM transactions t LEFT JOIN vendors v ON t.vendor_id=v.id WHERE t.contract_id=? AND t.kind='income' ORDER BY t.date DESC",
      [req.params.id]
    )
    const [expenseRows] = await pool.execute(
      "SELECT t.*, v.name AS vendor_name FROM transactions t LEFT JOIN vendors v ON t.vendor_id=v.id WHERE t.contract_id=? AND t.kind='expense' ORDER BY t.date DESC",
      [req.params.id]
    )
    const in_done   = incomeRows.reduce((s, t) => s + Number(t.amount), 0)
    const out_total = expenseRows.reduce((s, t) => s + Number(t.amount), 0)

    // 상세 탭용 가공 데이터
    const incomes = incomeRows.map(t => ({
      date: t.date, type: t.category || '입금', amount: Number(t.amount),
      status: t.status, evid: !!(t.evid_url || t.evid_type),
    }))
    const expenses = expenseRows.map(t => ({
      date: t.date, vendor: t.vendor_name || '—', category: t.category || '—',
      amount: Number(t.amount), doc: t.doc_no ? '작성 완료' : '미작성', pay: t.status,
    }))
    const evidences = [...incomeRows, ...expenseRows]
      .filter(t => t.evid_url || t.evid_type)
      .map(t => ({
        name: t.evid_url ? String(t.evid_url).split('/').pop() : (t.evid_type || '증빙'),
        type: t.evid_type || '', size: '', date: t.date,
      }))
    const docs = expenseRows.filter(t => t.doc_no).map(t => ({
      id: t.doc_no,
      title: [t.category, t.vendor_name].filter(Boolean).join(' · ') || '결의서',
      date: t.date, amount: Number(t.amount), status: t.status,
    }))

    // 원가 실적 집계 (지급완료만, 비목 패턴 매칭)
    const cost_actual = { material: 0, outsource: 0, labor: 0, overhead: 0 }
    for (const t of expenseRows) {
      if (t.status !== '지급완료') continue
      const cat = t.category || ''
      const amt = Number(t.amount)
      if (/재료비|철강|원자재|비철|특수강|부자재/.test(cat))         cost_actual.material  += amt
      else if (/외주|가공|표면|도금|열처리|용접|연삭|방전/.test(cat)) cost_actual.outsource += amt
      else if (/급여|인건|복리|퇴직/.test(cat))                      cost_actual.labor     += amt
      else                                                          cost_actual.overhead  += amt
    }

    const remain = (c.amount || 0) - in_done

    // 계약 첨부 서류(다중) + 레거시 단일 계약서(file_url) 병합
    const [attRows] = await pool.execute(
      'SELECT id, url, name, doc_type, size, created_at FROM contract_docs WHERE contract_id = ? ORDER BY created_at',
      [req.params.id]
    )
    const attachments = attRows.map(d => ({ id: d.id, url: d.url, name: d.name, type: d.doc_type || '기타', size: d.size || 0 }))
    if (c.file_url && !attachments.some(a => a.url === c.file_url)) {
      attachments.unshift({ id: null, url: c.file_url, name: c.file_name || '계약서', type: '계약서', size: 0, legacy: true })
    }

    res.json({
      ...c,
      cost_budget: c.cost_budget ? JSON.parse(c.cost_budget) : null,
      milestones,
      incomes, expenses, evidences, docs, attachments, history: [],
      cost_actual,
      in_done,
      out: out_total,
      remain: remain > 0 ? remain : 0,
      profit: in_done - out_total,
      txn_count: incomeRows.length + expenseRows.length,
    })
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { vendor_id, name, amount, start_date, end_date, status, buyer_code, pu_no, order_no, vessel_code, cost_budget, file_url, file_name, contract_no } = req.body
    const id = randomUUID()
    await pool.execute(
      'INSERT INTO contracts (id, vendor_id, name, amount, start_date, end_date, status, buyer_code, pu_no, order_no, vessel_code, cost_budget, file_url, file_name, contract_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, vendor_id||null, name, amount, start_date||null, end_date||null, status||'진행중', buyer_code||null, pu_no||null, order_no||null, vessel_code||null, cost_budget ? JSON.stringify(cost_budget) : null, file_url||null, file_name||null, contract_no||null]
    )
    res.json({ id })
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '이미 사용 중인 계약번호예요' })
    next(e)
  }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { vendor_id, name, amount, start_date, end_date, status, buyer_code, pu_no, order_no, vessel_code, file_url, file_name, contract_no } = req.body
    const [result] = await pool.execute(
      'UPDATE contracts SET vendor_id=?, name=?, amount=?, start_date=?, end_date=?, status=?, buyer_code=?, pu_no=?, order_no=?, vessel_code=?, file_url=?, file_name=?, contract_no=? WHERE id=?',
      [vendor_id||null, name, amount, start_date||null, end_date||null, status||'진행중', buyer_code||null, pu_no||null, order_no||null, vessel_code||null, file_url||null, file_name||null, contract_no||null, req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '이미 사용 중인 계약번호예요' })
    next(e)
  }
})

router.post('/:id/milestones', async (req, res, next) => {
  const { milestones } = req.body
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.execute('DELETE FROM milestones WHERE contract_id = ?', [req.params.id])
    for (const m of milestones) {
      await conn.execute(
        'INSERT INTO milestones (id, contract_id, type, ratio, amount, due_date, status, invoice_id) VALUES (?,?,?,?,?,?,?,?)',
        [randomUUID(), req.params.id, m.type, m.ratio||0, m.amount, m.due_date||null, m.status||'예정', m.invoice_id||null]
      )
    }
    await conn.commit()
    res.json({ ok: true })
  } catch (e) {
    await conn.rollback()
    next(e)
  } finally {
    conn.release()
  }
})

router.put('/:id/cost-budget', async (req, res, next) => {
  try {
    const [result] = await pool.execute(
      'UPDATE contracts SET cost_budget = ? WHERE id = ?',
      [JSON.stringify(req.body), req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.get('/:id/cost-analysis', async (req, res, next) => {
  try {
    const [cRows] = await pool.execute('SELECT * FROM contracts WHERE id = ?', [req.params.id])
    if (!cRows[0]) return res.status(404).json({ error: 'Not found' })
    const c = cRows[0]
    const budget = c.cost_budget ? JSON.parse(c.cost_budget) : { material: 0, outsource: 0, labor: 0, overhead: 0 }
    const [txns] = await pool.execute(
      "SELECT category, SUM(amount) AS total FROM transactions WHERE contract_id = ? AND kind='expense' AND status='지급완료' GROUP BY category",
      [req.params.id]
    )
    const actual = { material: 0, outsource: 0, labor: 0, overhead: 0 }
    for (const t of txns) {
      const total = Number(t.total)
      if (/재료비|철강|원자재/.test(t.category))  actual.material  += total
      else if (/외주|가공/.test(t.category))       actual.outsource += total
      else if (/급여|인건/.test(t.category))        actual.labor     += total
      else                                          actual.overhead  += total
    }
    const totalBudget = Object.values(budget).reduce((s, v) => s + v, 0)
    const totalActual = Object.values(actual).reduce((s, v) => s + v, 0)
    res.json({
      budget, actual, totalBudget, totalActual,
      targetCostRate: c.amount > 0 ? totalBudget / c.amount : 0,
      actualCostRate:  c.amount > 0 ? totalActual / c.amount : 0,
      estimatedProfit: c.amount - totalActual,
    })
  } catch (e) { next(e) }
})

// ── 계약 첨부 서류(다중) ──
router.post('/:id/docs', async (req, res, next) => {
  try {
    const { url, name, doc_type, size } = req.body
    if (!url) return res.status(400).json({ error: 'url 필수' })
    const id = randomUUID()
    await pool.execute(
      'INSERT INTO contract_docs (id, contract_id, url, name, doc_type, size) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, url, name || '', doc_type || '', size || 0]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.delete('/docs/:docId', async (req, res, next) => {
  try {
    await pool.execute('DELETE FROM contract_docs WHERE id = ?', [req.params.docId])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 레거시 단일 계약서(file_url) 제거
router.patch('/:id/clear-file', async (req, res, next) => {
  try {
    await pool.execute('UPDATE contracts SET file_url=NULL, file_name=NULL WHERE id=?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
