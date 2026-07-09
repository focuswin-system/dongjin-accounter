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
      // 입금은 VAT 포함 총액 → 계약금액(공급가)도 총액 기준으로 비교
      const contractTotal = Math.round((Number(r.amount) || 0) * 1.1)
      const remain = contractTotal - in_done
      return {
        ...r, in_done, out, remain: remain > 0 ? remain : 0, profit: in_done - out,
        cost_budget: r.cost_budget ? JSON.parse(r.cost_budget) : null,
      }
    }))
  } catch (e) { next(e) }
})

// 발행 예정(대기) 청구 일정 — status='예정' & 아직 미발행(invoice_id NULL)
// for=sales → 발주처(gubu B)+미지정(NULL) / for=purchase → 매입(A·E)
router.get('/schedule/pending', async (req, res, next) => {
  try {
    const forKind = req.query.for
    let sql = `SELECT m.id AS milestone_id, m.type, m.amount, m.due_date,
                      c.id AS contract_id, c.name AS contract_name, c.contract_no, c.vendor_id,
                      v.name AS vendor_name, v.gubu
               FROM milestones m
               JOIN contracts c ON m.contract_id = c.id
               LEFT JOIN vendors v ON c.vendor_id = v.id
               WHERE m.status = '예정' AND (m.invoice_id IS NULL OR m.invoice_id = '')`
    if (forKind === 'purchase')  sql += " AND v.gubu IN ('A','E')"
    else if (forKind === 'sales') sql += " AND (v.gubu IS NULL OR v.gubu = 'B')"
    sql += ' ORDER BY m.due_date'
    const [rows] = await pool.execute(sql)
    res.json(rows.map(r => ({ ...r, amount: Number(r.amount) })))
  } catch (e) { next(e) }
})

// 청구 일정 단건 상태 변경(레거시 — 필요 시)
router.patch('/milestones/:id/status', async (req, res, next) => {
  try {
    const [result] = await pool.execute('UPDATE milestones SET status=? WHERE id=?', [req.body.status || '예정', req.params.id])
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 청구 일정 → 청구서 발행 (+선택적 기입금). 원자적: 청구서·(기입금 시)거래·매칭·일정 상태를 한 트랜잭션에서 처리.
// 거래처 gubu로 매출(issued)/매입(received) 자동 판별. 이미 발행된 일정은 409로 거부(중복 방지).
router.post('/schedule/:milestoneId/issue', async (req, res, next) => {
  const { paid, date } = req.body
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [[ms]] = await conn.execute(
      `SELECT m.*, c.name AS contract_name, c.vendor_id, v.gubu
       FROM milestones m JOIN contracts c ON m.contract_id = c.id
       LEFT JOIN vendors v ON c.vendor_id = v.id WHERE m.id = ? FOR UPDATE`,
      [req.params.milestoneId]
    )
    if (!ms) { await conn.rollback(); return res.status(404).json({ error: '청구 일정을 찾을 수 없어요' }) }
    if (ms.status !== '예정' || (ms.invoice_id && ms.invoice_id !== '')) {
      await conn.rollback(); return res.status(409).json({ error: '이미 발행된 청구 일정이에요' })
    }
    const isPurchase = ms.gubu === 'A' || ms.gubu === 'E'
    const kind = isPurchase ? 'received' : 'issued'
    const supply = Number(ms.amount) || 0
    const vat = Math.round(supply * 0.1)
    const total = supply + vat
    const today = new Date().toISOString().slice(0, 10)
    const year = today.slice(0, 4)
    const prefix = isPurchase ? '매입' : '청구'
    // 채번: 최대 일련번호+1 (삭제해도 재사용 안 됨)
    const [[{ maxno }]] = await conn.execute(
      `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno
       FROM invoices WHERE kind = ? AND invoice_no LIKE ?`,
      [kind, `${prefix}-${year}-%`]
    )
    const invoice_no = `${prefix}-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    const invId = randomUUID()
    const status = paid ? (isPurchase ? '지급 완료' : '입금 완료') : (isPurchase ? '지급 대기' : '입금 예정')
    await conn.execute(
      'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, memo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [invId, invoice_no, kind, ms.vendor_id || null, ms.contract_id, supply, vat, total, today, ms.due_date || null, status, `${ms.contract_name} · ${ms.type}`]
    )
    // 기입금: 실제 입/출금 거래 + 매칭 생성(장부·계좌·계약 수금에 반영)
    if (paid) {
      const txnId = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, contract_id, category, amount, date, method, status, buyer_type, doc_no, invoice_id, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txnId, isPurchase ? 'expense' : 'income', ms.vendor_id || null, ms.contract_id,
         isPurchase ? '대금 지급' : '수금', total, date || today, '계좌이체',
         isPurchase ? '지급완료' : '입금완료', '공통', '', invId, `청구서 ${invoice_no} 정산`]
      )
      await conn.execute('INSERT INTO invoice_matches (id, invoice_id, txn_id, amount) VALUES (?,?,?,?)', [randomUUID(), invId, txnId, total])
    }
    await conn.execute('UPDATE milestones SET status = ?, invoice_id = ? WHERE id = ?',
      [paid ? (isPurchase ? '지급 완료' : '입금 완료') : (isPurchase ? '지급 예정' : '입금 예정'), invId, req.params.milestoneId])
    await conn.commit()
    res.json({ ok: true, id: invId, invoice_no, kind })
  } catch (e) { await conn.rollback(); next(e) }
  finally { conn.release() }
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

    const contractTotal = Math.round((Number(c.amount) || 0) * 1.1)
    const remain = contractTotal - in_done

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
