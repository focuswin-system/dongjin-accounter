const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError, amountError } = require('../lib/ledger')
const { vatByQuarter } = require('../lib/vatAgg')

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
  /* ⚠ 완료인데 금액이 0이면 **막는다.** 예전엔 여기서 그냥 통과시켰는데, 그러면
       syncTaxTxn 이 "완료가 아니거나 금액이 0"으로 보고 **그때 만든 거래를 지운다.**
       이미 납부 완료였던 분기의 금액을 지우고 저장하면 지출 1건이 사라지고 계좌 잔액이
       늘어나는데, 화면은 "납부 처리하고 거래내역에 반영했어요"라고 말했다.
       납부를 취소하려면 상태를 '대기'로 내리는 길이 따로 있다. */
  if (isDone && !amount) {
    return `${isRefund ? '환급' : '납부'}액을 입력해주세요. 취소하려면 상태를 대기로 바꿔주세요.`
  }
  /* ⚠ 음수·초대형 금액을 막는다. 서버는 [^0-9-] 로 파싱해 음수가 통과했고,
       그러면 syncTaxTxn 이 음수 지출을 만들어 **계좌 잔액이 늘어난다.**
       lib/ledger.js 의 amountError 가 정확히 이걸 막으려고 있는데 이 파일만 안 썼다
       ("프런트만 믿는 구조가 F-02 의 뿌리" — 같은 파일 주석). */
  { const e = amountError(amount); if (amount && e) return e }
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
    /* 세액 집계는 lib/vatAgg.js 한 곳 — 보고서·엑셀도 같은 것을 쓴다.
       (여기서 손으로 적어 두었더니 화면만 고쳐지고 세무사 제출용은 청구서만 세고 있었다.) */
    const vatQ = await vatByQuarter(req.db, year)

    /* 이중 계상 의심 건 — 같은 돈이 청구서와 거래 양쪽에서 세어지는 경우.
     *
     * 세금계산서를 임포트해 매입 청구서를 만들고, 통장 출금도 따로 거래로 등록한 뒤
     * **정산 매칭을 하지 않으면** invoice_id 가 NULL 이라 두 집계에 모두 들어간다
     * → 매입세액이 2배가 된다. 앱이 "같은 거래"라고 확신할 수는 없으므로 지우지 않고,
     *   거래처와 금액이 같은데 한 번도 정산되지 않은 청구서가 있는 건을 찾아 **알린다.**
     *   해결은 청구서 상세에서 그 거래를 정산에 연결하는 것이다. */
    const [dupAgg] = await req.db.execute(
      `SELECT QUARTER(t.date) AS q, COUNT(*) AS cnt, COALESCE(SUM(t.vat_amount), 0) AS vat
         FROM transactions t
        WHERE YEAR(t.date) = ? AND t.kind = 'expense'
          AND t.invoice_id IS NULL AND t.vat_amount IS NOT NULL AND t.vendor_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM invoices i
             WHERE i.kind = 'received' AND i.vendor_id = t.vendor_id
               AND i.total_amount = t.amount
               AND NOT EXISTS (SELECT 1 FROM invoice_matches m WHERE m.invoice_id = i.id)
          )
        GROUP BY QUARTER(t.date)`,
      [year]
    )
    const dupBy = Object.fromEntries(dupAgg.map(r => [Number(r.q), r]))
    const [filings] = await req.db.execute('SELECT * FROM vat_filings WHERE year = ?', [year])
    const fileBy = Object.fromEntries(filings.map(r => [Number(r.quarter), r]))

    const quarters = [1, 2, 3, 4].map(q => {
      const v = vatQ[q]
      const f = fileBy[q] || {}
      const sales_vat = v.salesVat
      const purchase_vat = v.purchaseVat
      const estimate = sales_vat - purchase_vat            // 청구서 + 직접거래 자동집계(예상)
      const filed = f.filed_amount == null ? null : Number(f.filed_amount)  // 실제 신고세액(입력 전이면 null)
      return {
        quarter: q,
        sales_vat,
        purchase_vat,
        // 출처별 내역 — "청구서엔 없는데 세액이 왜 이렇지?"를 화면에서 설명할 수 있게 나눠 준다
        sales_vat_invoice: v.salesInvoice,
        sales_vat_direct: v.salesDirect,
        purchase_vat_invoice: v.purchaseInvoice,
        purchase_vat_direct: v.purchaseDirect,
        non_deductible_vat: v.nonDeductible,   // 불공제로 빠진 매입세액
        // 이중 계상 의심 — 정산되지 않은 매입 청구서와 거래처·금액이 같은 직접 거래
        dup_suspect_count: Number((dupBy[q] || {}).cnt || 0),
        dup_suspect_vat:   Number((dupBy[q] || {}).vat || 0),
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
    /* 마감 검사 — 새 납부일과 **기존 납부 거래의 날짜** 양쪽을 본다.
     * 완료를 취소하면(완료 → 대기) syncTaxTxn이 기존 지출 거래를 삭제하는데,
     * 여기서 새 날짜만 검사하던 탓에 마감월 납부를 되돌려 그 달 잔액을 사후에 늘릴 수 있었다.
     * 거래 쪽은 "세금 납부 거래는 세무 화면에서 되돌려라"며 직접 삭제를 막으므로,
     * 이 경로가 막히지 않으면 마감 우회의 정식 출구가 된다. */
    let prevTxnDate = null
    if (exist[0]?.txn_id) {
      const [[pt]] = await conn.execute('SELECT date FROM transactions WHERE id = ?', [exist[0].txn_id])
      prevTxnDate = pt?.date || null
    }
    {
      const ce = await closedPeriodError(conn, prevTxnDate, isDone ? (paid_date || kstToday()) : null)
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

/* 마감 검사 — 새 납부일과 **기존 납부 거래의 날짜** 양쪽.
 * 완료를 취소하거나 삭제하면 기존 거래가 사라져 그 달 잔액이 바뀐다.
 * 완료일 때만 검사하던 탓에, 마감월 납부를 '납부 대기'로 되돌려 지출을 없앨 수 있었다. */
const otClosedErr = async (db, body, existingTxnId) => {
  const st = body.status || '납부 대기'
  const isDone = st === '납부 완료' || st === '환급 완료'
  let prevDate = null
  if (existingTxnId) {
    const [[pt]] = await db.execute('SELECT date FROM transactions WHERE id = ?', [existingTxnId])
    prevDate = pt?.date || null
  }
  return closedPeriodError(db, prevDate, isDone ? (body.paid_date || kstToday()) : null)
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
  try {
    await conn.beginTransaction()
    const [[cur]] = await conn.execute('SELECT txn_id FROM other_taxes WHERE id=?', [req.params.id])
    if (!cur) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    // 기존 납부 거래의 날짜까지 검사한다(완료 취소 시 그 거래가 사라져 마감월 잔액이 바뀐다)
    { const ce = await otClosedErr(conn, req.body, cur.txn_id); if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) } }
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
    if (!cur) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    // 삭제하면 연결된 납부 거래도 사라져 그 달 잔액이 바뀐다 → 마감월이면 막는다.
    // (검사가 없어서 이 경로가 마감 우회의 정식 출구였다)
    if (cur.txn_id) {
      const [[pt]] = await conn.execute('SELECT date FROM transactions WHERE id=?', [cur.txn_id])
      const ce = pt ? await closedPeriodError(conn, pt.date) : null
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
    }
    await conn.execute('DELETE FROM other_taxes WHERE id=?', [req.params.id])
    if (cur.txn_id) await conn.execute('DELETE FROM transactions WHERE id=?', [cur.txn_id])   // 연결된 납부 거래도 정리
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

module.exports = router
