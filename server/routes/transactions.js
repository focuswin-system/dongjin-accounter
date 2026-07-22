const { Router } = require('express')
const { randomUUID } = require('crypto')
const multer = require('multer')
const xlsx = require('xlsx')
const { futureDateError } = require('../db')
const { rollbackQuietly } = require('../lib/tx')
const { restoreLastGenerated } = require('../lib/recurrence')

const router = Router()
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

// 청구서 매칭 누계로 청구서·마일스톤 상태를 다시 계산한다.
// 거래가 지워지거나 금액이 바뀌면 정산액이 달라지므로 반드시 다시 계산해야 한다.
// (db는 필수 인자 — 기본값을 두면 호출자가 빠뜨렸을 때 조용히 다른 회사 DB를 건드린다)
async function recalcInvoiceStatus(db, invoiceId) {
  const [[inv]] = await db.execute('SELECT kind, total_amount FROM invoices WHERE id = ?', [invoiceId])
  if (!inv) return
  const [[{ paid }]] = await db.execute('SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [invoiceId])
  const isIssued = inv.kind === 'issued'
  const total = Number(inv.total_amount)
  const status = Number(paid) <= 0 ? (isIssued ? '입금 예정' : '지급 대기')
    : Number(paid) >= total ? (isIssued ? '입금 완료' : '지급 완료')
    : (isIssued ? '일부 입금' : '일부 지급')
  await db.execute('UPDATE invoices SET status = ? WHERE id = ?', [status, invoiceId])
  await db.execute('UPDATE milestones SET status = ? WHERE invoice_id = ?', [status, invoiceId])
}

// 거래 목록/상세에 첨부 서류(다중) 붙이기
async function attachDocs(db, rows) {
  if (!rows.length) return
  const ids = rows.map(r => r.id)
  const ph = ids.map(() => '?').join(',')
  const [docs] = await db.execute(
    `SELECT id, txn_id, url, name, doc_type, size, created_at FROM transaction_docs WHERE txn_id IN (${ph}) ORDER BY created_at`, ids)
  const byTxn = {}
  for (const d of docs) { if (!byTxn[d.txn_id]) byTxn[d.txn_id] = []; byTxn[d.txn_id].push(d) }
  for (const r of rows) r.docs = byTxn[r.id] || []
}

router.get('/', async (req, res, next) => {
  try {
    const { kind, contractId, buyerType, vesselNo, category, from, to, accountId } = req.query
    let sql = `SELECT t.*, v.name AS vendor_name, c.name AS contract_name, a.name AS account_name,
                      e.name AS employee_name, ri.name AS item_name,
                      cc.name AS cost_contract_name
              FROM transactions t
              LEFT JOIN vendors v ON t.vendor_id = v.id
              LEFT JOIN contracts c ON t.contract_id = c.id
              LEFT JOIN contracts cc ON t.cost_contract_id = cc.id
              LEFT JOIN accounts a ON t.account_id = a.id
              LEFT JOIN employees e ON t.employee_id = e.id
              LEFT JOIN ref_items ri ON t.item_id = ri.id
              WHERE 1=1`
    const params = []
    if (kind)       { sql += ' AND t.kind = ?';        params.push(kind) }
    // 계약으로 거를 땐 두 축을 모두 본다 (그 계약의 근거 거래 + 그 계약에 귀속된 원가)
    if (contractId) { sql += ' AND (t.contract_id = ? OR t.cost_contract_id = ?)'; params.push(contractId, contractId) }
    if (buyerType)  { sql += ' AND t.buyer_type = ?';  params.push(buyerType) }
    if (vesselNo)   { sql += ' AND t.vessel_no = ?';   params.push(vesselNo) }
    if (category)   { sql += ' AND t.category = ?';    params.push(category) }
    if (accountId)  { sql += ' AND t.account_id = ?';  params.push(accountId) }
    if (from)       { sql += ' AND t.date >= ?';       params.push(from) }
    if (to)         { sql += ' AND t.date <= ?';       params.push(to) }
    sql += ' ORDER BY t.date DESC'
    const [rows] = await req.db.execute(sql, params)
    await attachDocs(req.db, rows)
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/summary', async (req, res, next) => {
  try {
    const { buyerType, year, month } = req.query
    let sql = "SELECT category, SUM(amount) AS total, COUNT(*) AS cnt FROM transactions WHERE kind='expense'"
    const params = []
    if (buyerType) { sql += ' AND buyer_type = ?'; params.push(buyerType) }
    if (year && month) { sql += ' AND date LIKE ?'; params.push(`${year}-${month}%`) }
    sql += ' GROUP BY category ORDER BY total DESC'
    const [rows] = await req.db.execute(sql, params)
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(`
      SELECT t.*, v.name AS vendor_name, c.name AS contract_name, a.name AS account_name,
             e.name AS employee_name, ri.name AS item_name, cc.name AS cost_contract_name
      FROM transactions t
      LEFT JOIN vendors v ON t.vendor_id = v.id
      LEFT JOIN contracts c ON t.contract_id = c.id
      LEFT JOIN contracts cc ON t.cost_contract_id = cc.id
      LEFT JOIN accounts a ON t.account_id = a.id
      LEFT JOIN employees e ON t.employee_id = e.id
      LEFT JOIN ref_items ri ON t.item_id = ri.id
      WHERE t.id = ?`, [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    await attachDocs(req.db, rows)
    res.json(rows[0])
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const {
      kind, vendor_id, contract_id, cost_contract_id, account_id, category, sub_category,
      amount, date, method, status, buyer_type, vessel_no, usage_place,
      invoice_id, recurring_id, doc_no, employee_id, evid_type, evid_url, memo,
      item_id, account_code
    } = req.body
    const dateErr = futureDateError(date)
    if (dateErr) return res.status(400).json({ error: dateErr })
    const id = randomUUID()
    // 원가 귀속(cost_contract_id)은 지출에만 의미가 있다 — 수금에 붙으면 매출계약 원가가 부풀어 오른다
    const costId = kind === 'expense' ? (cost_contract_id || null) : null
    await req.db.execute(`
      INSERT INTO transactions (id, kind, vendor_id, contract_id, cost_contract_id, account_id, category, sub_category,
        amount, date, method, status, buyer_type, vessel_no, usage_place,
        invoice_id, recurring_id, doc_no, employee_id, evid_type, evid_url, memo, item_id, account_code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [id, kind, vendor_id||null, contract_id||null, costId, account_id||null, category||'', sub_category||'',
        amount, date, method||'', status||'지급완료', buyer_type||'공통', vessel_no||'', usage_place||'',
        invoice_id||null, recurring_id||null, doc_no||'', employee_id||null, evid_type||'', evid_url||'', memo||'',
        item_id||null, account_code||null])
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const {
      vendor_id, contract_id, cost_contract_id, account_id, category, sub_category,
      amount, date, method, status, buyer_type, vessel_no, usage_place,
      doc_no, employee_id, evid_type, evid_url, memo, item_id, account_code
    } = req.body
    const dateErr = futureDateError(date)
    if (dateErr) return res.status(400).json({ error: dateErr })
    // 편집으로 수입 거래가 되면 원가 귀속은 떨어진다
    const [[cur]] = await req.db.execute('SELECT kind FROM transactions WHERE id = ?', [req.params.id])
    if (!cur) return res.status(404).json({ error: 'Not found' })
    const costId = cur.kind === 'expense' ? (cost_contract_id || null) : null
    // 금액이 바뀌면 청구서 매칭액도 따라가야 한다. 거래 수정과 매칭 갱신이 갈라지면
    // 청구서 정산액이 옛 금액으로 남아 미수/미지급이 틀어지므로 한 트랜잭션으로 묶는다.
    const conn = await req.db.getConnection()
    try {
      await conn.beginTransaction()
      const [result] = await conn.execute(`
        UPDATE transactions SET vendor_id=?, contract_id=?, cost_contract_id=?, account_id=?, category=?, sub_category=?,
          amount=?, date=?, method=?, status=?, buyer_type=?, vessel_no=?, usage_place=?,
          doc_no=?, employee_id=?, evid_type=?, evid_url=?, memo=?, item_id=?, account_code=?
        WHERE id=?
      `, [vendor_id||null, contract_id||null, costId, account_id||null, category||'', sub_category||'',
          amount, date, method||'', status||'지급완료', buyer_type||'공통', vessel_no||'', usage_place||'',
          doc_no||'', employee_id||null, evid_type||'', evid_url||'', memo||'', item_id||null, account_code||null, req.params.id])
      if (result.affectedRows === 0) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }

      // 이 거래에 걸린 청구서 매칭을 새 금액에 맞춰 조정하고 청구서 상태를 재계산한다.
      const [links] = await conn.execute('SELECT id, invoice_id, amount FROM invoice_matches WHERE txn_id = ?', [req.params.id])
      for (const link of links) {
        // 같은 청구서의 다른 매칭을 뺀 잔여를 넘지 않도록 제한(과입금·과지급 방지)
        const [[{ others }]] = await conn.execute(
          'SELECT COALESCE(SUM(amount),0) AS others FROM invoice_matches WHERE invoice_id = ? AND id <> ?',
          [link.invoice_id, link.id])
        const [[inv]] = await conn.execute('SELECT total_amount FROM invoices WHERE id = ?', [link.invoice_id])
        const remainForThis = Number(inv?.total_amount || 0) - Number(others)
        const newMatch = Math.max(0, Math.min(Number(amount) || 0, remainForThis))
        await conn.execute('UPDATE invoice_matches SET amount = ? WHERE id = ?', [newMatch, link.id])
        await recalcInvoiceStatus(conn, link.invoice_id)
      }

      await conn.commit()
      res.json({ ok: true })
    } catch (e) { await rollbackQuietly(conn); throw e }
    finally { conn.release() }
  } catch (e) { next(e) }
})

router.patch('/:id/status', async (req, res, next) => {
  try {
    let { status } = req.body
    if (!status) return res.status(400).json({ error: 'status 필수' })
    // 완료 상태는 무공백 표준형으로 정규화 — 계좌 잔액 계산(accounts.js)이 정확히 '지급완료'/'입금완료'만
    // 지출/입금으로 세므로, '지급 완료'(공백)로 들어오면 잔액에서 누락된다(F-02 계열 방지).
    if (status === '지급 완료') status = '지급완료'
    else if (status === '입금 완료') status = '입금완료'
    const [result] = await req.db.execute('UPDATE transactions SET status=? WHERE id=?', [status, req.params.id])
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 증빙(레거시 단일)만 갱신 — 다른 필드 보존
router.patch('/:id/evidence', async (req, res, next) => {
  try {
    const { evid_url, evid_type } = req.body
    const [result] = await req.db.execute(
      'UPDATE transactions SET evid_url=?, evid_type=? WHERE id=?',
      [evid_url||'', evid_type||'', req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 거래 첨부 서류(다중)
router.post('/:id/docs', async (req, res, next) => {
  try {
    const { url, name, doc_type, size } = req.body
    if (!url) return res.status(400).json({ error: 'url 필수' })
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO transaction_docs (id, txn_id, url, name, doc_type, size) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, url, name || '', doc_type || '', size || 0]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.delete('/docs/:docId', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM transaction_docs WHERE id = ?', [req.params.docId])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    // 세금 납부 거래는 여기서 지우면 안 된다.
    // vat_filings·other_taxes 의 txn_id 는 나중에 ensureColumn 으로 붙인 컬럼이라 FK가 없어,
    // 지워도 DB가 막아주지 않는다. 그러면 세무 화면은 '납부 완료 / 납부액 500만'인데
    // 거래내역엔 그 지출이 없고 계좌 잔액만 500만 늘어난 상태가 된다.
    // 되돌리는 정상 경로는 세무관리 화면에서 상태를 되돌리는 것이다(syncTaxTxn 이 거래도 지운다).
    const [[vat]] = await conn.execute('SELECT year, quarter FROM vat_filings WHERE txn_id = ? LIMIT 1', [req.params.id])
    if (vat) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `${vat.year}년 ${vat.quarter}분기 부가세 납부 거래예요. 세무관리 > 부가세 화면에서 납부를 취소하면 이 거래도 함께 정리됩니다.`,
      })
    }
    const [[ot]] = await conn.execute('SELECT name FROM other_taxes WHERE txn_id = ? LIMIT 1', [req.params.id])
    if (ot) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `'${ot.name}' 세액 납부 거래예요. 세무관리 > 기타세액 화면에서 납부를 취소하면 이 거래도 함께 정리됩니다.`,
      })
    }

    // 이 거래에 걸린 청구서 매칭을 정리하고 청구서 상태를 재계산한다.
    // 안 하면 매칭이 고아로 남아 청구서가 '완료'인 채 미수/미지급이 누락된다.
    const [matches] = await conn.execute('SELECT invoice_id FROM invoice_matches WHERE txn_id = ?', [req.params.id])
    await conn.execute('DELETE FROM invoice_matches WHERE txn_id = ?', [req.params.id])
    for (const m of matches) await recalcInvoiceStatus(conn, m.invoice_id)
    // 정기지출에서 자동 생성된 거래면 last_generated 를 되돌려 그 회차가 다시 생성되게 한다.
    const [[cur]] = await conn.execute('SELECT recurring_id, date FROM transactions WHERE id = ?', [req.params.id])
    await conn.execute('DELETE FROM transactions WHERE id = ?', [req.params.id])
    const rec = cur?.recurring_id
      ? await restoreLastGenerated(conn, 'recurring_expenses', cur.recurring_id, cur.date)
      : { restored: false, note: null }
    await conn.commit()
    res.json({ ok: true, recurringNote: rec.note })
  } catch (e) {
    await rollbackQuietly(conn)
    if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.errno === 1451) {
      return res.status(409).json({ error: '지급결의서·급여에 연결된 거래라 삭제할 수 없어요' })
    }
    next(e)
  } finally { conn.release() }
})

// ── 엑셀 임포트: 파싱(헤더 + 행 미리보기) ──
router.post('/import/parse', uploadMem.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다' })
    const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) return res.json({ headers: [], rows: [] })
    const json = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false })
    const headers = json.length ? Object.keys(json[0]) : []
    res.json({ headers, rows: json.slice(0, 500) })
  } catch (e) { next(e) }
})

// ── 엑셀 임포트: 일괄 등록(미등록 거래처는 자동 생성) ──
router.post('/import/commit', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : []
    // 대량 등록은 '완료' 상태로 들어가므로 계좌가 없으면 그 수백 건이 통째로
    // 계좌 잔액에서 누락된다(accounts.js calcBalance는 account_id로 계좌를 특정해 합산).
    // 행별 계좌(it.account_id)를 우선하고, 없으면 일괄 지정 계좌를 쓴다.
    const accountId = req.body.account_id || null
    if (!accountId && items.some(it => !it.account_id)) {
      return res.status(400).json({ error: '입출금 계좌를 선택해주세요. 계좌를 지정해야 잔액에 반영됩니다.' })
    }
    const [vs] = await conn.execute('SELECT id, name FROM vendors')
    const vendorMap = {}; for (const v of vs) vendorMap[v.name] = v.id
    const [cs] = await conn.execute('SELECT id, name FROM contracts')
    const contractMap = {}; for (const c of cs) contractMap[c.name] = c.id

    await conn.beginTransaction()
    let inserted = 0, skippedFuture = 0; const createdVendors = []
    for (const it of items) {
      // 미래 일자 거래는 건너뛴다 — 완료 상태로 들어가 계좌 잔액에 즉시 반영되므로 개별 등록과 같은 규칙 적용.
      if (futureDateError(it.date)) { skippedFuture++; continue }
      let vendorId = null
      const vname = String(it.vendor || '').trim()
      if (vname) {
        if (vendorMap[vname]) vendorId = vendorMap[vname]
        else {
          vendorId = randomUUID()
          await conn.execute('INSERT INTO vendors (id, name, gubu) VALUES (?,?,?)',
            [vendorId, vname, it.kind === 'income' ? 'B' : 'A'])
          vendorMap[vname] = vendorId; createdVendors.push(vname)
        }
      }
      const cname = String(it.contract || '').trim()
      const contractId = (cname && contractMap[cname]) ? contractMap[cname] : null
      // account_id 를 반드시 넣는다. 빠지면 위 주석대로 '완료 상태'로만 들어가고
      // 계좌 잔액에는 영원히 안 잡혀, 대량 등록 직후부터 통장과 장부가 어긋난다.
      await conn.execute(`
        INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, category, amount, date, method, status, buyer_type, doc_no, memo)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [randomUUID(), it.kind, vendorId, contractId, it.account_id || accountId,
          it.category || '', it.amount, it.date,
          '계좌이체', it.kind === 'income' ? '입금완료' : '지급완료', '공통',
          (cname && !contractId) ? cname : '', it.memo || ''])
      inserted++
    }
    await conn.commit()
    res.json({ inserted, createdVendors, skippedFuture })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// ── 엑셀 임포트: 양식 다운로드(.xlsx) ──
router.get('/import/template', (req, res, next) => {
  try {
    const rows = [
      ["거래일자", "거래처", "계약명", "구분", "비목", "금액", "메모"],
      ["2026-06-01", "(주)한빛문구", "", "지출", "소모품", 80000, "사무용품"],
      ["2026-06-03", "정밀가공(주)", "홈페이지 유지보수", "지출", "외주가공비", 1500000, "6월 외주분"],
      ["2026-06-10", "(재)부산영재교육진흥원", "홈페이지 개선", "입금", "납품대금", 3500000, "선급금"],
    ]
    const ws = xlsx.utils.aoa_to_sheet(rows)
    ws['!cols'] = [{ wch: 12 }, { wch: 22 }, { wch: 24 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 20 }]

    const guide = [
      ["거래내역 일괄 업로드 — 작성 안내"],
      [""],
      ["• 거래일자: YYYY-MM-DD 권장 (예: 2026-06-01). 2026.6.1 / 6/1/26 형식도 인식됩니다."],
      ["• 거래처: 비워도 됩니다. 목록에 없는 거래처는 업로드 시 자동 등록돼요 (입금=발주처 / 지출=매입처)."],
      ["• 계약명: 연결할 계약이 있으면 정확히 입력, 없으면 비워두세요."],
      ["• 구분: '입금' 또는 '지출' (수입·매출=입금 / 매입·출금=지출 도 인식)."],
      ["• 비목: 외주가공비·소모품·납품대금 등 자유롭게 입력하세요."],
      ["• 금액: 숫자만 입력(쉼표 가능). 부호 없이 양수로."],
      ["• 첫 행(머리글)은 그대로 두고, 둘째 행부터 데이터를 입력하세요."],
    ]
    const wsGuide = xlsx.utils.aoa_to_sheet(guide)
    wsGuide['!cols'] = [{ wch: 72 }]

    const wb = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(wb, ws, "거래내역")
    xlsx.utils.book_append_sheet(wb, wsGuide, "작성안내")
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="transaction_import_template.xlsx"; filename*=UTF-8''${encodeURIComponent('거래내역_업로드_양식.xlsx')}`)
    res.send(buf)
  } catch (e) { next(e) }
})

module.exports = router
