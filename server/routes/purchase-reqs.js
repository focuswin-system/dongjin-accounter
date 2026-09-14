const { Router } = require('express')
const { randomUUID } = require('crypto')
const { kstToday } = require('../db')
const { rollbackQuietly } = require('../lib/tx')
const { withTx, httpError } = require('../lib/withTx')
const { pageParams, buildWhere, inClause, docDateExpr, approvalStatusSql, approvalCounts } = require('../lib/pagedList')
const {
  approveDoc, execCandidates, executeDoc, invoiceState, linkInvoiceDoc, loadDoc, openInvoicesFor, resolutionOfReq, sourceTxnsOfReq, unapproveDoc, undoDoc,
} = require('../lib/docExec')

const router = Router()
const parseJson = (v, fb) => { try { return v ? JSON.parse(v) : fb } catch { return fb } }
const TABLE = 'purchase_reqs'

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
  return { ...r, status: r.status || '작성', order_amount: Number(r.order_amount) || 0, items: its, total, approval: parseJson(r.approval, []) }
}

/* 목록 한 줄에 붙이는 연결 정보 — 결의서로 넘겼는지, 어느 지출에서 만들었는지.
   화면이 상태 옆에 "DJ-… 결의"를 보여주고, 정산내역서가 같은 돈을 두 번 넣지 않게 판정하는 데 쓴다.
   id 목록만큼만 조회한다(전체 스캔 방지). */
async function attachLinks(db, rows) {
  const { clause, ids } = inClause(rows.map(r => r.id))
  const sums = {}, resol = {}, srcTxns = {}
  if (ids.length) {
    const [s] = await db.execute(
      `SELECT req_id, COALESCE(SUM(amount),0) AS total FROM purchase_req_items WHERE req_id IN ${clause} GROUP BY req_id`, ids)
    for (const x of s) sums[x.req_id] = Number(x.total)
    const [e] = await db.execute(
      `SELECT purchase_req_id, doc_no, status, id FROM expense_resolutions WHERE purchase_req_id IN ${clause}`, ids)
    for (const x of e) resol[x.purchase_req_id] = { id: x.id, doc_no: x.doc_no, status: x.status || '작성' }
    const [t] = await db.execute(`SELECT req_id, txn_id FROM purchase_req_txns WHERE req_id IN ${clause}`, ids)
    for (const x of t) (srcTxns[x.req_id] = srcTxns[x.req_id] || []).push(x.txn_id)
  }
  return rows.map(r => ({
    ...r, status: r.status || '작성', order_amount: Number(r.order_amount) || 0, total: sums[r.id] || 0,
    approval: parseJson(r.approval, []), resolution: resol[r.id] || null, source_txn_ids: srcTxns[r.id] || [],
  }))
}

router.get('/', async (req, res, next) => {
  try {
    const pp = pageParams(req)
    if (!pp.paged) {
      const [rows] = await req.db.execute('SELECT * FROM purchase_reqs ORDER BY created_at DESC, id DESC')
      return res.json(await attachLinks(req.db, rows))
    }
    const { whereSql, args } = buildWhere(pp, ['doc_no', 'vendor_name', 'summary', 'order_source'], {
      dateExpr: docDateExpr('req_date'), vendor: true, statusSql: approvalStatusSql(),
    })
    const [[{ cnt }]] = await req.db.execute(`SELECT COUNT(*) AS cnt FROM purchase_reqs ${whereSql}`, args)
    const [rows] = await req.db.execute(
      `SELECT * FROM purchase_reqs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ${pp.limit} OFFSET ${pp.offset}`, args)
    res.json({ rows: await attachLinks(req.db, rows), total: Number(cnt), hasMore: pp.offset + rows.length < Number(cnt),
      counts: await approvalCounts(req.db, 'purchase_reqs') })
  } catch (e) { next(e) }
})

/* 다른 품의가 이미 붙든 청구서·지출 — 새 품의의 '받은 청구서에서'·'거래내역에서' 고르기에서
   표시하고 막는 데 쓴다. 같은 청구서로 품의가 둘이면 둘 다 처리하려 들 수 있다. */
router.get('/claimed', async (req, res, next) => {
  try {
    const [inv] = await req.db.execute('SELECT invoice_id AS id, doc_no FROM purchase_reqs WHERE invoice_id IS NOT NULL')
    const [txn] = await req.db.execute(
      `SELECT p.txn_id AS id, pr.doc_no FROM purchase_req_txns p JOIN purchase_reqs pr ON pr.id = p.req_id
       UNION ALL SELECT txn_id AS id, doc_no FROM purchase_reqs WHERE txn_id IS NOT NULL`)
    const toMap = (rows) => Object.fromEntries(rows.map(r => [r.id, r.doc_no]))
    res.json({ invoices: toMap(inv), txns: toMap(txn) })
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [[r]] = await req.db.execute('SELECT * FROM purchase_reqs WHERE id = ?', [req.params.id])
    if (!r) return res.status(404).json({ error: 'Not found' })
    const [items] = await req.db.execute('SELECT * FROM purchase_req_items WHERE req_id = ? ORDER BY sort_order, id', [req.params.id])
    // 붙은 청구서의 지금 상태(지워졌으면 null)
    const inv = await invoiceState(req.db, r.invoice_id)
    const invoice = inv ? { id: inv.id, invoice_no: inv.invoice_no, total: inv.total, remain: inv.remain, issued_at: inv.issued_at } : null
    const resolution = await resolutionOfReq(req.db, r.id)
    const sourceTxns = await sourceTxnsOfReq(req.db, r.id)
    let txn = null
    if (r.txn_id) {
      const [[t]] = await req.db.execute(
        `SELECT t.id, t.date, t.amount, a.name AS account_name FROM transactions t
           LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`, [r.txn_id])
      if (t) txn = { ...t, amount: Number(t.amount) || 0 }
    }
    res.json({ ...adapt(r, items), invoice, resolution, txn,
      source_txns: sourceTxns.map(s => ({ ...s, amount: Number(s.amount) || 0 })) })
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const HEAD_COLS = ['req_date', 'vendor_id', 'vendor_name', 'order_source', 'ship_no', 'summary', 'arrival_date', 'order_amount', 'pay_terms', 'man_hours', 'applicant', 'note']
const headVals = (b) => [b.req_date || null, b.vendor_id || null, b.vendor_name || '', b.order_source || '', b.ship_no || '',
  b.summary || '', b.arrival_date || null, Number(b.order_amount) || 0, b.pay_terms || '', b.man_hours || '', b.applicant || '', b.note || '']
/* 날짜 칸은 'YYYY-MM-DD' 만 받는다. 목록의 기간 필터가 이 칸을 문자열로 비교하므로
   '2026.9.1' 같은 값이 섞이면 조용히 엉뚱한 기간에 잡힌다(예전엔 글 칸이라 무엇이든 들어갔다). */
const dateErrorOf = (b) => {
  for (const [k, label] of [['req_date', '품의일자'], ['arrival_date', '입하일자']]) {
    if (b[k] && !DATE_RE.test(b[k])) return `${label}는 YYYY-MM-DD 로 적어주세요`
  }
  return null
}

/**
 * 새 품의. source 로 **어디서 만들었는지**를 받아 잇는다.
 *   { type:'invoice', id }  받은 청구서 한 장 — 처리하면 그 청구서를 지급한다
 *   { type:'txn', ids:[] }  이미 나간 지출 — 처리할 돈이 없다(승인하면 곧바로 완료)
 * 잇지 않으면 품의를 처리할 때 그 청구서와 별개의 지출이 새로 생긴다(같은 매입이 두 번).
 */
router.post('/', async (req, res, next) => {
  const dateErr = dateErrorOf(req.body)
  if (dateErr) return res.status(400).json({ error: dateErr })
  try {
    const out = await withTx(req.db, async (conn) => {
      const src = req.body.source || null
      let invoiceId = null, txnIds = []
      if (src && src.type === 'invoice' && src.id) {
        const inv = await invoiceState(conn, src.id, { lock: true })
        if (!inv || inv.kind !== 'received') throw httpError(400, '매입 청구서를 찾을 수 없어요')
        const [[other]] = await conn.execute('SELECT doc_no FROM purchase_reqs WHERE invoice_id = ? LIMIT 1', [src.id])
        if (other) throw httpError(409, `청구서 ${inv.invoice_no || ''}로는 이미 구매품의서 ${other.doc_no}가 있어요.`.replace('  ', ' '))
        invoiceId = src.id
      } else if (src && src.type === 'txn' && Array.isArray(src.ids)) {
        txnIds = [...new Set(src.ids.filter(Boolean))]
        if (txnIds.length) {
          const { clause, ids } = inClause(txnIds)
          const [taken] = await conn.execute(
            `SELECT pr.doc_no FROM purchase_req_txns p JOIN purchase_reqs pr ON pr.id = p.req_id WHERE p.txn_id IN ${clause} LIMIT 1`, ids)
          if (taken.length) throw httpError(409, `고른 지출 중에 이미 구매품의서 ${taken[0].doc_no}에 쓰인 것이 있어요.`)
          const [found] = await conn.execute(
            `SELECT id FROM transactions WHERE kind = 'expense' AND id IN ${clause}`, ids)
          if (found.length !== txnIds.length) throw httpError(400, '고른 지출 중에 찾을 수 없는 것이 있어요')
        }
      }

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
        `INSERT INTO purchase_reqs (id, doc_no, ${HEAD_COLS.join(', ')}, approval, status, invoice_id) VALUES (?,?,${HEAD_COLS.map(() => '?').join(',')},?,?,?)`,
        [id, doc_no, ...headVals({ ...req.body, applicant }), JSON.stringify(approval), '작성', invoiceId])
      await insertItems(conn, id, req.body.items)
      for (const t of txnIds) {
        await conn.execute('INSERT INTO purchase_req_txns (id, req_id, txn_id) VALUES (?,?,?)', [randomUUID(), id, t])
      }
      const [[head]] = await conn.execute('SELECT * FROM purchase_reqs WHERE id = ?', [id])
      const [items] = await conn.execute('SELECT * FROM purchase_req_items WHERE req_id = ? ORDER BY sort_order, id', [id])
      return adapt(head, items)
    })
    res.json(out)
  } catch (e) { next(e) }
})

/**
 * 수정. **상태는 본문에서 받지 않는다.**
 * 예전엔 `status || '작성'` 이라, 화면이 status 를 안 보내는 저장 한 번에 승인이 조용히 풀렸다.
 *   · 완료(지출 처리됨) — 품목·금액을 바꾸면 이미 나간 지출과 문서가 다른 말을 한다 → 막는다
 *   · 승인 — 내용을 바꾸면 결재받은 문서가 아니다 → 작성으로 되돌린다(화면이 먼저 알린다)
 */
router.put('/:id', async (req, res, next) => {
  const dateErr = dateErrorOf(req.body)
  if (dateErr) return res.status(400).json({ error: dateErr })
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[cur]] = await conn.execute('SELECT id, status FROM purchase_reqs WHERE id = ? FOR UPDATE', [req.params.id])
    if (!cur) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    if (cur.status === '완료') { await rollbackQuietly(conn); return res.status(409).json({ error: '처리가 끝난 품의서는 고칠 수 없어요. 처리 취소부터 해주세요.' }) }
    const er = await resolutionOfReq(conn, req.params.id)
    if (er) { await rollbackQuietly(conn); return res.status(409).json({ error: `지급결의서 ${er.doc_no}로 넘긴 품의서예요. 고치려면 그 결의서를 먼저 지워주세요.` }) }
    await conn.execute(
      `UPDATE purchase_reqs SET ${HEAD_COLS.map(c => `${c}=?`).join(', ')}, status='작성', approval=? WHERE id=?`,
      [...headVals(req.body), JSON.stringify(Array.isArray(req.body.approval) ? req.body.approval : []), req.params.id])
    await conn.execute('DELETE FROM purchase_req_items WHERE req_id = ?', [req.params.id])
    await insertItems(conn, req.params.id, req.body.items)
    await conn.commit()
    res.json({ ok: true, status: '작성', unapproved: cur.status === '승인' })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/**
 * 삭제. 처리된 품의는 `?cascade=1` 이 있어야 지운다(지출까지 되돌린 뒤).
 * 결의서로 넘긴 품의는 못 지운다 — 결의서의 구매품의NO가 허공을 가리키고, 그 결의서를 처리하면
 * 없는 품의를 완료로 바꾸려 든다.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const cascade = req.query.cascade === '1' || req.query.cascade === 'true'
    const out = await withTx(req.db, async (conn) => {
      const [[cur]] = await conn.execute('SELECT id, status, txn_id FROM purchase_reqs WHERE id = ? FOR UPDATE', [req.params.id])
      if (!cur) throw httpError(404, '구매품의서를 찾을 수 없어요')
      const er = await resolutionOfReq(conn, req.params.id)
      if (er) throw httpError(409, `지급결의서 ${er.doc_no}에서 쓰고 있어요. 그 결의서를 먼저 지워주세요.`)
      let keptTxn = false
      // 돈이 나간 품의만 되돌릴 게 있다. 돈 없이 끝난 완료(이미 나간 지출로 만든 품의)는 그냥 지운다
      if (cur.status === '완료' && cur.txn_id) {
        if (!cascade) throw httpError(409, '처리가 끝난 품의서예요. 지출까지 함께 되돌리려면 처리 취소 후 삭제하세요.')
        keptTxn = (await undoDoc(conn, TABLE, req.params.id)).keptTxn
      }
      await conn.execute('DELETE FROM purchase_req_txns WHERE req_id = ?', [req.params.id])
      await conn.execute('DELETE FROM purchase_req_items WHERE req_id = ?', [req.params.id])
      await conn.execute('DELETE FROM purchase_reqs WHERE id = ?', [req.params.id])
      return { ok: true, keptTxn }
    })
    res.json(out)
  } catch (e) { next(e) }
})

/* ── 승인·처리 ── 규칙은 lib/docExec.js (지급결의서와 같은 함수) */

// 승인. 처리할 돈이 없는 품의(이미 나간 지출·완납 청구서)는 곧바로 완료가 된다(autoDone 에 이유)
router.post('/:id/approve', async (req, res, next) => {
  try { res.json(await withTx(req.db, conn => approveDoc(conn, TABLE, req.params.id))) }
  catch (e) { next(e) }
})
router.post('/:id/unapprove', async (req, res, next) => {
  try { res.json(await withTx(req.db, conn => unapproveDoc(conn, TABLE, req.params.id))) }
  catch (e) { next(e) }
})

// 처리 창 — 연결할 만한 지출 거래
router.get('/:id/matchable', async (req, res, next) => {
  try {
    const doc = await loadDoc(req.db, TABLE, req.params.id)
    if (!doc) return res.status(404).json({ error: 'Not found' })
    res.json(await execCandidates(req.db, TABLE, doc))
  } catch (e) { next(e) }
})

// 처리 창 — 같은 거래처의 미지급 청구서(금액이 맞는 것이 위로)
router.get('/:id/open-invoices', async (req, res, next) => {
  try {
    const doc = await loadDoc(req.db, TABLE, req.params.id)
    if (!doc) return res.status(404).json({ error: 'Not found' })
    const amount = Number(req.query.amount) || doc._amount
    res.json(await openInvoicesFor(req.db, doc.vendor_id, amount))
  } catch (e) { next(e) }
})

// 청구서 붙이기/떼기 — { invoice_id } (null 이면 뗀다)
router.post('/:id/link-invoice', async (req, res, next) => {
  try { res.json(await withTx(req.db, conn => linkInvoiceDoc(conn, TABLE, req.params.id, req.body.invoice_id || null))) }
  catch (e) { next(e) }
})

// 지출 처리 — mode 'link' | 'create'
router.post('/:id/process', async (req, res, next) => {
  try { res.json({ ok: true, ...(await withTx(req.db, conn => executeDoc(conn, TABLE, req.params.id, req.body))) }) }
  catch (e) { next(e) }
})

// 처리 취소 — 완료 → 승인. 품의가 만든 지출은 지우고, 연결만 한 지출은 연결 전으로 되돌린다
router.post('/:id/unprocess', async (req, res, next) => {
  try {
    const out = await withTx(req.db, conn => undoDoc(conn, TABLE, req.params.id))
    if (!out.changed) return res.status(409).json({ error: '아직 처리되지 않은 품의서예요' })
    res.json({ ok: true, keptTxn: out.keptTxn, restored: out.restored })
  } catch (e) { next(e) }
})

module.exports = router
