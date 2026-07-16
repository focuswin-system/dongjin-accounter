const { Router } = require('express')
const { randomUUID } = require('crypto')
const { pool, futureDateError, kstToday } = require('../db')

const router = Router()

const parseItems = (v) => { try { return v ? JSON.parse(v) : [] } catch { return [] } }
const parseJson = (v, fb) => { try { return v ? JSON.parse(v) : fb } catch { return fb } }
const adapt = (r) => ({ ...r, amount: Number(r.amount), items: parseItems(r.items), approval: parseJson(r.approval, []) })

// 기본 결재선 프리셋의 단계를 새 결의서에 스냅샷으로 복사 (없으면 담당/결재/대표)
const defaultApproval = async (execFn) => {
  const [[p]] = await execFn('SELECT steps FROM approval_presets WHERE is_default=1 ORDER BY sort_order LIMIT 1')
  const steps = parseJson(p && p.steps, null)
  if (steps && steps.length) return steps.map(s => ({ label: s.label || '', position: s.position || '', name: '' }))
  return [{ label: '담당', position: '', name: '' }, { label: '결재', position: '', name: '' }, { label: '대표이사', position: '', name: '' }]
}

// 문서번호 채번 DJ-YYYY-NNNN (최대 일련번호 +1, 삭제해도 재사용 안 함)
const nextDocNo = async (execFn, dateStr) => {
  const year = (dateStr || new Date().toISOString().slice(0, 10)).slice(0, 4)
  const [[{ maxno }]] = await execFn(
    `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(doc_no, '-', -1) AS UNSIGNED)), 0) AS maxno
     FROM expense_resolutions WHERE doc_no LIKE ?`, [`DJ-${year}-%`])
  return `DJ-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
}

// 목록 (최신순)
router.get('/', async (_, res, next) => {
  try {
    const [rows] = await pool.execute(
      `SELECT er.*, v.name AS vendor_name2 FROM expense_resolutions er
       LEFT JOIN vendors v ON er.vendor_id = v.id ORDER BY er.created_at DESC`)
    res.json(rows.map(adapt))
  } catch (e) { next(e) }
})

// 특정 지출 거래에 연결된 결의서 (증빙 영역에서 열람용). 없으면 null.
router.get('/by-txn/:txnId', async (req, res, next) => {
  try {
    const [[r]] = await pool.execute('SELECT * FROM expense_resolutions WHERE txn_id = ?', [req.params.txnId])
    res.json(r ? adapt(r) : null)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [[r]] = await pool.execute('SELECT * FROM expense_resolutions WHERE id = ?', [req.params.id])
    if (!r) return res.status(404).json({ error: 'Not found' })
    res.json(adapt(r))
  } catch (e) { next(e) }
})

// 직접 등록 — 청구서 없는 소액 경비(비누·간식 등)를 결의서부터 작성해 결재받는 경우.
// 거래·청구서 연결 없이 사람이 지출처·품목·금액을 입력한다.
router.post('/', async (req, res, next) => {
  try {
    const { vendor_id, vendor_name, title, items, pay_method, pay_date, applicant, note } = req.body
    const itemList = Array.isArray(items) && items.length ? items
      : [{ name: title || '지출', unit: '식', qty: 1, price: Number(req.body.amount) || 0, amount: Number(req.body.amount) || 0, note: '' }]
    const amount = itemList.reduce((s, it) => s + (Number(it.amount) || 0), 0)
    const doc_no = await nextDocNo((sql, p) => pool.execute(sql, p), pay_date)
    const [[user]] = await pool.execute('SELECT name FROM users ORDER BY created_at LIMIT 1')
    const id = randomUUID()
    // 결재선: 요청에 있으면 그걸 쓰고(만들 때 고른 프리셋), 없으면 기본 프리셋
    const approval = Array.isArray(req.body.approval) && req.body.approval.length
      ? req.body.approval
      : await defaultApproval((sql, p) => pool.execute(sql, p))
    await pool.execute(
      `INSERT INTO expense_resolutions (id, doc_no, vendor_id, vendor_name, title, amount, pay_method, pay_date, applicant, items, note, approval, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, doc_no, vendor_id || null, vendor_name || '', title || '지출 결의', amount,
       pay_method || '계좌이체', pay_date || null, applicant || (user && user.name) || '관리자',
       JSON.stringify(itemList), note || '', JSON.stringify(approval), '작성'])
    const [[created]] = await pool.execute('SELECT * FROM expense_resolutions WHERE id = ?', [id])
    res.json(adapt(created))
  } catch (e) { next(e) }
})

// 매입 청구서 1건 → 결의서 생성(있으면 그대로 반환). 지급 전 결재용.
// 거래(txn_id)는 아직 없을 수 있다 — 나중에 지급 매칭되면 그 거래와 연결(선택).
router.post('/from-invoice/:invoiceId', async (req, res, next) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [[existing]] = await conn.execute('SELECT * FROM expense_resolutions WHERE invoice_id = ?', [req.params.invoiceId])
    if (existing) { await conn.commit(); return res.json({ ...adapt(existing), reused: true }) }

    const [[inv]] = await conn.execute(
      `SELECT i.*, v.name AS vendor_name, c.name AS contract_name FROM invoices i
       LEFT JOIN vendors v ON i.vendor_id = v.id
       LEFT JOIN contracts c ON i.contract_id = c.id
       WHERE i.id = ? FOR UPDATE`, [req.params.invoiceId])
    if (!inv) { await conn.rollback(); return res.status(404).json({ error: '청구서를 찾을 수 없어요' }) }
    if (inv.kind !== 'received') { await conn.rollback(); return res.status(400).json({ error: '매입(수취) 청구서만 지급결의서를 만들 수 있어요' }) }

    const doc_no = await nextDocNo((sql, p) => conn.execute(sql, p), inv.issued_at)

    // 지급결의서는 '지급액'(gross, VAT 포함)을 결재받는 문서 → 헤더·품목라인 모두 total_amount로 통일.
    // (품목을 공급가(supply)로 두면 라인합≠지급액이 되고, 면세인데 supply가 비면 /1.1 폴백이 과소 계상된다.)
    const gross = Number(inv.total_amount) || 0
    const title = inv.contract_name || inv.memo || '매입 대금 지급'
    const items = [{ name: title, unit: '식', qty: 1, price: gross, amount: gross, note: inv.invoice_no || '' }]

    const [[user]] = await conn.execute('SELECT name FROM users ORDER BY created_at LIMIT 1')
    const approval = await defaultApproval((sql, p) => conn.execute(sql, p))
    const id = randomUUID()
    await conn.execute(
      `INSERT INTO expense_resolutions (id, doc_no, invoice_id, vendor_id, vendor_name, title, amount, pay_method, pay_date, applicant, items, note, approval, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, doc_no, inv.id, inv.vendor_id || null, inv.vendor_name || '', title,
       Number(inv.total_amount), '계좌이체', inv.due_at || null, (user && user.name) || '관리자',
       JSON.stringify(items), '', JSON.stringify(approval), '작성'])
    await conn.commit()
    const [[created]] = await pool.execute('SELECT * FROM expense_resolutions WHERE id = ?', [id])
    res.json(adapt(created))
  } catch (e) { await conn.rollback(); next(e) }
  finally { conn.release() }
})

// 처리 후보 지출 거래 — 이 결의서와 연결할 만한 미연결 지출.
// 거래처가 같으면 위로, 금액이 비슷하면 위로. 이미 결의서가 붙은 거래는 제외.
router.get('/:id/matchable', async (req, res, next) => {
  try {
    const [[r]] = await pool.execute('SELECT * FROM expense_resolutions WHERE id = ?', [req.params.id])
    if (!r) return res.status(404).json({ error: 'Not found' })
    const [rows] = await pool.execute(
      `SELECT t.id, t.date, t.amount, t.category, t.status, v.name AS vendor_name
       FROM transactions t LEFT JOIN vendors v ON t.vendor_id = v.id
       WHERE t.kind='expense'
         AND t.id NOT IN (SELECT txn_id FROM expense_resolutions WHERE txn_id IS NOT NULL)
       ORDER BY (t.vendor_id <=> ?) DESC, ABS(t.amount - ?) ASC, t.date DESC
       LIMIT 20`,
      [r.vendor_id || null, Number(r.amount) || 0])
    res.json(rows.map(t => ({ ...t, amount: Number(t.amount), related: r.vendor_id && t.vendor_name === r.vendor_name })))
  } catch (e) { next(e) }
})

// 결의서 처리 — 이 결의서대로 지출을 집행한다. 처리되면 status='완료'로 목록(할 일 큐)에서 빠진다.
//   mode='link'   : 이미 등록된 지출 거래에 연결
//   mode='create' : 결의서 내용으로 지출 거래를 새로 생성(금액은 body.amount로 덮어쓸 수 있음)
// 어느 쪽이든 지출 doc_no에 결의서번호를 역참조해, 그 지출의 증빙에서 결의서를 찾을 수 있게 한다.
router.post('/:id/process', async (req, res, next) => {
  const { mode, txn_id, amount, date, account_id } = req.body
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [[r]] = await conn.execute('SELECT * FROM expense_resolutions WHERE id = ? FOR UPDATE', [req.params.id])
    if (!r) { await conn.rollback(); return res.status(404).json({ error: '결의서를 찾을 수 없어요' }) }
    if (r.status === '완료') { await conn.rollback(); return res.status(409).json({ error: '이미 처리된 결의서예요' }) }

    // 매입 청구서 연결 결의서인데 그 청구서가 이미 완납이면, 새 지출을 만들어봐야 매칭할 잔액이 없어
    // 지출만 붕 뜬다(이중 계상). 처리 자체를 막는다.
    if (r.invoice_id) {
      const [[inv]] = await conn.execute('SELECT total_amount FROM invoices WHERE id = ?', [r.invoice_id])
      if (inv) {
        const [[{ paid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [r.invoice_id])
        if (Number(inv.total_amount) - Number(paid) <= 0) {
          await conn.rollback(); return res.status(409).json({ error: '연결된 청구서가 이미 지급 완료됐어요' })
        }
      }
    }

    let linkedTxnId = null
    if (mode === 'link') {
      if (!txn_id) { await conn.rollback(); return res.status(400).json({ error: '연결할 지출 거래를 선택해주세요' }) }
      const [[t]] = await conn.execute("SELECT id FROM transactions WHERE id = ? AND kind='expense'", [txn_id])
      if (!t) { await conn.rollback(); return res.status(404).json({ error: '지출 거래를 찾을 수 없어요' }) }
      linkedTxnId = txn_id
      await conn.execute("UPDATE transactions SET doc_no = ? WHERE id = ? AND (doc_no IS NULL OR doc_no = '' OR doc_no = '공통')", [r.doc_no, txn_id])
    } else if (mode === 'create') {
      // 실효 지출일 = 넘어온 date, 없으면 결의서 지급예정일(pay_date), 그것도 없으면 오늘.
      // date만 검사하면 미래인 pay_date로 집행될 때 미래날짜 차단이 우회되므로 실효 날짜로 막는다.
      const effDate = date || r.pay_date || kstToday()
      if (futureDateError(effDate)) { await conn.rollback(); return res.status(400).json({ error: '미래 날짜로는 처리할 수 없어요 (오늘까지만 가능)' }) }
      const amt = Number(amount) > 0 ? Number(amount) : Number(r.amount)
      const id = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, buyer_type, doc_no, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, 'expense', r.vendor_id || null, account_id || null, r.title || '지출', amt,
         effDate, r.pay_method || '계좌이체',
         '지급완료', '공통', r.doc_no, `결의서 ${r.doc_no} 집행`])
      linkedTxnId = id
    } else {
      await conn.rollback(); return res.status(400).json({ error: "mode는 'link' 또는 'create'여야 해요" })
    }

    // 매입 청구서에서 발행한 결의서면, 처리한 지출을 그 청구서에 지급 매칭한다.
    // (안 하면 결의서·지출은 처리됐는데 청구서는 '지급 예정'으로 남는다)
    let invoicePaid = false
    if (r.invoice_id) {
      const [[inv]] = await conn.execute('SELECT * FROM invoices WHERE id = ? FOR UPDATE', [r.invoice_id])
      if (inv) {
        const [[{ paid: prevPaid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [r.invoice_id])
        const remainBefore = Number(inv.total_amount) - Number(prevPaid)
        // 이 지출이 이미 다른 청구서에 매칭돼 있으면 재매칭 금지(이중 계상 방지)
        const [[dupMatch]] = await conn.execute('SELECT invoice_id FROM invoice_matches WHERE txn_id = ? LIMIT 1', [linkedTxnId])
        if (dupMatch) { await conn.rollback(); return res.status(409).json({ error: '이미 다른 청구서에 매칭된 지출이에요' }) }
        if (remainBefore > 0) {
          const [[txnRow]] = await conn.execute('SELECT amount FROM transactions WHERE id = ?', [linkedTxnId])
          const matchAmount = Math.min(Number(txnRow.amount) || 0, remainBefore)
          await conn.execute('UPDATE transactions SET invoice_id = ? WHERE id = ?', [r.invoice_id, linkedTxnId])
          await conn.execute('INSERT INTO invoice_matches (id, invoice_id, txn_id, amount) VALUES (?,?,?,?)', [randomUUID(), r.invoice_id, linkedTxnId, matchAmount])
          const [[{ paid }]] = await conn.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [r.invoice_id])
          const status = Number(paid) >= Number(inv.total_amount) ? '지급 완료' : '일부 지급'
          await conn.execute('UPDATE invoices SET status = ? WHERE id = ?', [status, r.invoice_id])
          await conn.execute('UPDATE milestones SET status = ? WHERE invoice_id = ?', [status, r.invoice_id])
          invoicePaid = true
        }
      }
    }

    await conn.execute("UPDATE expense_resolutions SET status='완료', txn_id=? WHERE id=?", [linkedTxnId, req.params.id])
    await conn.commit()
    res.json({ ok: true, txn_id: linkedTxnId, invoicePaid })
  } catch (e) { await conn.rollback(); next(e) }
  finally { conn.release() }
})

// 결의서 내용 수정 (품목 명세·특기사항·헤더 보완)
router.put('/:id', async (req, res, next) => {
  try {
    const { title, amount, pay_method, pay_date, applicant, items, note, status, vendor_name, approval } = req.body
    const [r] = await pool.execute(
      `UPDATE expense_resolutions SET title=?, amount=?, pay_method=?, pay_date=?, applicant=?, items=?, note=?, status=?, vendor_name=?, approval=?
       WHERE id=?`,
      [title || '', Number(amount) || 0, pay_method || '', pay_date || null, applicant || '',
       JSON.stringify(items || []), note || '', status || '작성', vendor_name || '',
       JSON.stringify(approval || []), req.params.id])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await pool.execute('DELETE FROM expense_resolutions WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
