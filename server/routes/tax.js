const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError } = require('../lib/ledger')

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
    `INSERT INTO transactions (id, kind, account_id, category, amount, date, method, status, doc_no, memo, account_code)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, kind, accountId || null, category, amount, d, '계좌이체', status, '공통', memo, accountCode || null])
  return id
}

/**
 * 세금 납부/환급을 '완료'로 저장하기 전 검사.
 * 완료면 실제로 돈이 오간 것이므로 계좌가 있어야 잔액에 반영된다(lib/ledger.js).
 * 라우트가 저장 직전에 부른다 — syncTaxTxn 안에서 던지면 트랜잭션 중간에 끊긴다.
 */
function taxLedgerError({ isDone, isRefund, amount, accountId }) {
  if (!isDone || !amount) return null
  return ledgerError({
    kind: isRefund ? 'income' : 'expense',
    account_id: accountId,
    status: isRefund ? '입금완료' : '지급완료',
  })
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
    // 청구서를 거치지 않은 직접 입력 거래의 세액. 이게 빠져 있어서 카드·현금 매입세액이 통째로 누락됐다.
    //   invoice_id IS NOT NULL 인 거래는 청구서 정산분이라 위 집계에 이미 들어 있다 → 반드시 제외(이중계상).
    //   vat_amount IS NULL 은 이 기능 이전에 쌓인 거래 → 세액을 모르므로 집계하지 않는다.
    //   매입은 불공제(vat_deductible=0)를 빼야 실제 공제세액이 된다.
    //   증빙유형이 불공제(간이영수증·거래명세서 등)면 거래의 vat_deductible과 무관하게 공제 대상이 아니다.
    //   증빙유형을 안 적은 거래는 종전대로 공제로 본다(과거 데이터를 갑자기 불공제로 만들지 않는다).
    const [txnAgg] = await req.db.execute(
      `SELECT QUARTER(t.date) AS q,
              SUM(CASE WHEN t.kind='income'  THEN t.vat_amount ELSE 0 END) AS sales_vat,
              SUM(CASE WHEN t.kind='expense' AND t.vat_deductible = 1 AND COALESCE(ev.deductible, 1) = 1
                       THEN t.vat_amount ELSE 0 END) AS purchase_vat,
              SUM(CASE WHEN t.kind='expense' AND (t.vat_deductible = 0 OR COALESCE(ev.deductible, 1) = 0)
                       THEN t.vat_amount ELSE 0 END) AS non_deductible_vat
       FROM transactions t
       LEFT JOIN (
         SELECT name, MIN(deductible) AS deductible FROM ref_items WHERE type = 'evidence_type' GROUP BY name
       ) ev ON ev.name = t.evid_type
       WHERE YEAR(t.date) = ? AND t.invoice_id IS NULL AND t.vat_amount IS NOT NULL
       GROUP BY QUARTER(t.date)`,
      [year]
    )
    const [filings] = await req.db.execute('SELECT * FROM vat_filings WHERE year = ?', [year])
    const aggBy = Object.fromEntries(agg.map(r => [Number(r.q), r]))
    const txnBy = Object.fromEntries(txnAgg.map(r => [Number(r.q), r]))
    const fileBy = Object.fromEntries(filings.map(r => [Number(r.quarter), r]))

    const quarters = [1, 2, 3, 4].map(q => {
      const a = aggBy[q] || {}
      const t = txnBy[q] || {}
      const f = fileBy[q] || {}
      const sales_vat = Number(a.sales_vat || 0) + Number(t.sales_vat || 0)
      const purchase_vat = Number(a.purchase_vat || 0) + Number(t.purchase_vat || 0)
      const estimate = sales_vat - purchase_vat            // 청구서 + 직접거래 자동집계(예상)
      const filed = f.filed_amount == null ? null : Number(f.filed_amount)  // 실제 신고세액(입력 전이면 null)
      return {
        quarter: q,
        sales_vat,
        purchase_vat,
        // 출처별 내역 — "청구서엔 없는데 세액이 왜 이렇지?"를 화면에서 설명할 수 있게 나눠 준다
        sales_vat_invoice: Number(a.sales_vat || 0),
        sales_vat_direct: Number(t.sales_vat || 0),
        purchase_vat_invoice: Number(a.purchase_vat || 0),
        purchase_vat_direct: Number(t.purchase_vat || 0),
        non_deductible_vat: Number(t.non_deductible_vat || 0),   // 불공제로 빠진 매입세액
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
    // 완료로 저장하는데 계좌가 없으면 그 납부/환급이 계좌 잔액에서 움직이지 않는다.
    const lerr = taxLedgerError({ isDone, isRefund, amount, accountId: account_id })
    if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: lerr }) }
    // 완료로 저장하면 실제 거래가 생기거나 바뀐다 → 마감된 달이면 막는다
    if (isDone) {
      const ce = await closedPeriodError(conn, paid_date || kstToday())
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
    }
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

// 기타세액 저장 전 계좌 검사 — 완료인데 계좌가 없으면 잔액에 반영되지 않는다.
const otLedgerErr = (body) => {
  const st = body.status || '납부 대기'
  return taxLedgerError({
    isDone: st === '납부 완료' || st === '환급 완료',
    isRefund: st === '환급 완료',
    amount: parseInt(String(body.paid_amount).replace(/[^0-9-]/g, ''), 10) || 0,
    accountId: body.account_id,
  })
}

// 완료 상태면 실제 거래가 생기므로 마감된 달인지 검사(거래 등록과 같은 규칙)
const otClosedErr = async (db, body) => {
  const st = body.status || '납부 대기'
  if (st !== '납부 완료' && st !== '환급 완료') return null
  return closedPeriodError(db, body.paid_date || kstToday())
}

router.post('/others', async (req, res, next) => {
  if (!req.body.name) return res.status(400).json({ error: '세목명 필수' })
  { const de = otFutureErr(req.body); if (de) return res.status(400).json({ error: de }) }
  { const le = otLedgerErr(req.body); if (le) return res.status(400).json({ error: le }) }
  { const ce = await otClosedErr(req.db, req.body); if (ce) return res.status(409).json({ error: ce }) }
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
  { const le = otLedgerErr(req.body); if (le) return res.status(400).json({ error: le }) }
  const conn = await req.db.getConnection()
  { const ce = await otClosedErr(req.db, req.body); if (ce) return res.status(409).json({ error: ce }) }
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
