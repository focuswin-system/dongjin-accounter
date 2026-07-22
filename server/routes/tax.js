const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { rollbackQuietly } = require('../lib/tx')

const router = Router()

// 세금 납부/환급을 실제 자금 흐름(거래)에 반영한다.
//  완료(납부/환급) → 지출/입금 거래를 생성(또는 갱신). 완료 취소 → 그 거래 삭제.
//  반환: 연결된 txn_id (완료 아니면 null)
// 비목(category)·적요(memo)·계정과목(accountCode)은 화면에서 사용자가 정한 값을 그대로 거래에 넣는다.
// db: 트랜잭션 커넥션(conn) 또는 요청의 테넌트 풀(req.db). 세금 저장과 거래 반영을 한 트랜잭션으로 묶기 위해 주입받는다.
async function syncTaxTxn({ existingTxnId, isDone, isRefund, amount, accountId, date, category, memo, accountCode }, db) {
  // db는 필수. 기본값(전역 풀)을 두면 호출자가 빠뜨렸을 때 조용히 남의 회사 DB를 건드린다.
  if (!db) throw new Error('syncTaxTxn: 테넌트 연결(db)이 필요합니다')
  // 완료가 아니거나 금액 0 → 기존 거래 있으면 삭제하고 연결 해제
  if (!isDone || !amount) {
    if (existingTxnId) await db.execute('DELETE FROM transactions WHERE id=?', [existingTxnId])
    return null
  }
  const kind = isRefund ? 'income' : 'expense'
  const status = isRefund ? '입금완료' : '지급완료'
  const d = date || kstToday()
  // 이미 연결된 거래가 있으면 그 행이 실제로 존재하는지로 판정한다.
  // (UPDATE affectedRows는 mysql2에서 '변경된 행' 수라, 값이 그대로면 0이 되어 새 거래가 잘못 생긴다)
  if (existingTxnId) {
    const [[exists]] = await db.execute('SELECT id FROM transactions WHERE id=?', [existingTxnId])
    if (exists) {
      await db.execute(
        'UPDATE transactions SET kind=?, account_id=?, category=?, amount=?, date=?, status=?, memo=?, account_code=? WHERE id=?',
        [kind, accountId || null, category, amount, d, status, memo, accountCode || null, existingTxnId])
      return existingTxnId
    }
  }
  const id = randomUUID()
  await db.execute(
    `INSERT INTO transactions (id, kind, account_id, category, amount, date, method, status, buyer_type, doc_no, memo, account_code)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, kind, accountId || null, category, amount, d, '계좌이체', status, '공통', '공통', memo, accountCode || null])
  return id
}

// 부가세 분기별 집계 (매출세액 − 매입세액) + 신고 상태
router.get('/vat', async (req, res, next) => {
  try {
    const year = parseInt(req.query.year, 10) || Number(kstToday().slice(0, 4))
    const [agg] = await req.db.execute(
      `SELECT QUARTER(issued_at) AS q,
              SUM(CASE WHEN kind='issued'   THEN vat_amount ELSE 0 END) AS sales_vat,
              SUM(CASE WHEN kind='received' THEN vat_amount ELSE 0 END) AS purchase_vat
       FROM invoices
       WHERE YEAR(issued_at) = ?
       GROUP BY QUARTER(issued_at)`,
      [year]
    )
    const [filings] = await req.db.execute('SELECT * FROM vat_filings WHERE year = ?', [year])
    const aggBy = Object.fromEntries(agg.map(r => [Number(r.q), r]))
    const fileBy = Object.fromEntries(filings.map(r => [Number(r.quarter), r]))

    const quarters = [1, 2, 3, 4].map(q => {
      const a = aggBy[q] || {}
      const f = fileBy[q] || {}
      const sales_vat = Number(a.sales_vat || 0)
      const purchase_vat = Number(a.purchase_vat || 0)
      const estimate = sales_vat - purchase_vat            // 청구서 기준 자동집계(예상)
      const filed = f.filed_amount == null ? null : Number(f.filed_amount)  // 실제 신고세액(입력 전이면 null)
      return {
        quarter: q,
        sales_vat,
        purchase_vat,
        estimate,                        // +면 납부 예상, −면 환급 예상
        filed_amount: filed,             // null이면 아직 신고 전
        payable: filed != null ? filed : estimate,  // 관리 기준: 신고세액 우선, 없으면 예상
        status: f.status || '납부 대기',
        paid_amount: Number(f.paid_amount || 0),
        paid_date: f.paid_date || null,
        memo: f.memo || '',
        account_id: f.account_id || '',
        category: f.category || '',
        account_code: f.account_code || '',
      }
    })
    res.json({ year, quarters })
  } catch (e) { next(e) }
})

// 신고 상태 저장(분기별 upsert)
router.put('/vat', async (req, res, next) => {
  const { year, quarter, status, paid_amount, paid_date, memo, filed_amount, account_id, category, account_code } = req.body
  if (!year || !quarter) return res.status(400).json({ error: 'year·quarter 필수' })
  // 납부/환급 완료면 실제 지출/입금 거래가 생기므로 미래 납부일 금지
  const isDoneStatus = status === '납부 완료' || status === '환급 완료'
  if (isDoneStatus) { const de = futureDateError(paid_date); if (de) return res.status(400).json({ error: de }) }
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [exist] = await conn.execute('SELECT * FROM vat_filings WHERE year=? AND quarter=?', [year, quarter])
    const amount = parseInt(String(paid_amount).replace(/[^0-9-]/g, ''), 10) || 0
    // 신고세액: 빈 값이면 null(미신고), 숫자면 그 값
    const filed = (filed_amount === '' || filed_amount == null) ? null : (parseInt(String(filed_amount).replace(/[^0-9-]/g, ''), 10) || 0)
    const st = status || '납부 대기'
    // 납부 완료 → 지출 거래 / 환급 완료 → 입금 거래. 완료 취소 시 삭제.
    const isDone = st === '납부 완료' || st === '환급 완료'
    const isRefund = st === '환급 완료'
    const txnId = await syncTaxTxn({
      existingTxnId: exist[0]?.txn_id || null,
      isDone, isRefund, amount, accountId: account_id, date: paid_date,
      // 비목·계정과목은 화면에서 사용자가 고른 값. 비목만 비어 있으면 최소 라벨.
      category: (category && category.trim()) || (isRefund ? '부가세 환급' : '부가세 납부'),
      accountCode: account_code || null,
      memo: (memo && memo.trim()) || `${year}년 ${quarter}분기 부가세 ${isRefund ? '환급' : '납부'}`,
    }, conn)
    if (exist[0]) {
      await conn.execute(
        'UPDATE vat_filings SET status=?, paid_amount=?, paid_date=?, memo=?, filed_amount=?, account_id=?, txn_id=?, category=?, account_code=? WHERE id=?',
        [st, amount, paid_date || null, memo || null, filed, account_id || null, txnId, category || null, account_code || null, exist[0].id]
      )
    } else {
      await conn.execute(
        'INSERT INTO vat_filings (id, year, quarter, status, paid_amount, paid_date, memo, filed_amount, account_id, txn_id, category, account_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [randomUUID(), year, quarter, st, amount, paid_date || null, memo || null, filed, account_id || null, txnId, category || null, account_code || null]
      )
    }
    await conn.commit()
    res.json({ ok: true, txnId })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// ── 기타세액 (원천세·지방소득세 등) ──
const OT_FIELDS = ['name', 'period', 'tax_amount', 'paid_amount', 'paid_date', 'status', 'memo']
const otPick = (b) => OT_FIELDS.map(f => (
  (f === 'tax_amount' || f === 'paid_amount') ? (parseInt(String(b[f]).replace(/[^0-9-]/g, ''), 10) || 0)
  : (f === 'status') ? (b[f] || '납부 대기')
  : (b[f] ?? null)
))

router.get('/others', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM other_taxes ORDER BY created_at DESC')
    res.json(rows)
  } catch (e) { next(e) }
})

// 기타세액도 납부 완료 → 지출 / 환급 완료 → 입금 거래 연결. 비목·계정과목은 사용자가 정한 값.
async function syncOtherTaxTxn(body, existingTxnId, db) {
  if (!db) throw new Error('syncOtherTaxTxn: 테넌트 연결(db)이 필요합니다')
  const st = body.status || '납부 대기'
  const isDone = st === '납부 완료' || st === '환급 완료'
  const isRefund = st === '환급 완료'
  const amount = parseInt(String(body.paid_amount).replace(/[^0-9-]/g, ''), 10) || 0
  return syncTaxTxn({
    existingTxnId, isDone, isRefund, amount, accountId: body.account_id, date: body.paid_date,
    category: (body.category && body.category.trim()) || `${body.name || '기타세액'} ${isRefund ? '환급' : '납부'}`.trim(),
    accountCode: body.account_code || null,
    memo: (body.memo && body.memo.trim()) || `${body.name || '기타세액'} ${body.period ? `(${body.period}) ` : ''}${isRefund ? '환급' : '납부'}`.trim(),
  }, db)
}

// 기타세액도 납부/환급 완료면 실제 거래가 생기므로 미래 납부일 금지
const otFutureErr = (body) =>
  (body.status === '납부 완료' || body.status === '환급 완료') ? futureDateError(body.paid_date) : null

router.post('/others', async (req, res, next) => {
  if (!req.body.name) return res.status(400).json({ error: '세목명 필수' })
  { const de = otFutureErr(req.body); if (de) return res.status(400).json({ error: de }) }
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const id = randomUUID()
    const txnId = await syncOtherTaxTxn(req.body, null, conn)
    await conn.execute(
      'INSERT INTO other_taxes (id, name, period, tax_amount, paid_amount, paid_date, status, memo, account_id, txn_id, account_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, ...otPick(req.body), req.body.account_id || null, txnId, req.body.account_code || null]
    )
    await conn.commit()
    res.json({ ok: true, id })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.put('/others/:id', async (req, res, next) => {
  { const de = otFutureErr(req.body); if (de) return res.status(400).json({ error: de }) }
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[cur]] = await conn.execute('SELECT txn_id FROM other_taxes WHERE id=?', [req.params.id])
    if (!cur) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const txnId = await syncOtherTaxTxn(req.body, cur.txn_id || null, conn)
    await conn.execute(
      'UPDATE other_taxes SET name=?, period=?, tax_amount=?, paid_amount=?, paid_date=?, status=?, memo=?, account_id=?, txn_id=?, account_code=? WHERE id=?',
      [...otPick(req.body), req.body.account_id || null, txnId, req.body.account_code || null, req.params.id]
    )
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.delete('/others/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[cur]] = await conn.execute('SELECT txn_id FROM other_taxes WHERE id=?', [req.params.id])
    await conn.execute('DELETE FROM other_taxes WHERE id=?', [req.params.id])
    if (cur?.txn_id) await conn.execute('DELETE FROM transactions WHERE id=?', [cur.txn_id])   // 연결된 납부 거래도 정리
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

module.exports = router
