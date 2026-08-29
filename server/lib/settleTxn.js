/* 정기 회차를 '이미 입금·이미 지급'으로 발행할 때, 그 돈의 거래를 어떻게 마련하는가.
 *
 * 예전엔 **무조건 새 거래를 만들었다.** 그런데 통장·엑셀 임포트로 그 입금이 이미 장부에
 * 들어와 있는 경우가 흔하다. 그러면 같은 돈이 두 번 선다 — 청구서는 우리가 만든 거래로
 * 완료가 되고, 은행에서 올라온 진짜 입금은 짝 없이 떠돈다. fowin 실데이터에서 실제로 겹쳤다.
 *
 * 근거의 순서는 **은행이 먼저다.** 붙일 거래가 있으면 붙이고, 없을 때만 만든다.
 * 후보가 둘 이상이면 고르지 않는다 — 어느 달 입금인지는 사람이 안다.
 */
const { randomUUID } = require('crypto')
const { ledgerError } = require('./ledger')
const { settleAcctCode } = require('./acctCode')

/** 회차일에서 이만큼 떨어진 거래까지 같은 돈으로 본다(월 규칙이 이웃 달을 넘보지 않는 폭) */
const MATCH_WINDOW_DAYS = 20

/**
 * 아직 어느 청구서에도 붙지 않은, 같은 거래처·같은 금액의 실제 거래.
 * 가까운 날짜순. db 는 필수 인자다(전역 풀 기본값 금지 — 남의 회사 장부를 본다).
 */
async function openTxnCandidates(db, { kind, vendorId, amount, date, windowDays = MATCH_WINDOW_DAYS }) {
  if (!db) throw new Error('openTxnCandidates: 테넌트 연결(db)이 필요합니다')
  if (!vendorId || !date || !(Number(amount) > 0)) return []
  /* ⚠ **실제로 오간 돈만 후보다.** 거래에는 아직 안 나간 것도 있다('지급 대기').
     그걸 후보로 삼으면 기지급 처리가 그 줄을 완료로 뒤집어 버린다 —
     나가지도 않은 돈이 잔액에서 빠지고, 나중에 진짜로 나갈 때 붙일 자리가 없다.
     붙이기는 '이미 오간 돈에 청구서를 잇는 일'이지 상태를 바꾸는 일이 아니다. */
  const settled = kind === 'income' ? '입금완료' : '지급완료'
  const [rows] = await db.execute(
    `SELECT t.id, t.date, t.amount, t.account_id, t.memo, t.status
       FROM transactions t
       LEFT JOIN invoice_matches m ON m.txn_id = t.id
      WHERE t.kind = ? AND t.vendor_id = ? AND t.amount = ? AND t.status = ?
        AND t.invoice_id IS NULL AND m.id IS NULL
        AND ABS(DATEDIFF(t.date, ?)) <= ?
      ORDER BY ABS(DATEDIFF(t.date, ?)), t.date`,
    [kind, vendorId, Number(amount), settled, date, windowDays, date])
  return rows
}

/**
 * 청구서 한 장을 정산 처리한다 — 기존 거래에 붙이거나(우선), 없으면 새 거래를 만든다.
 *
 * @returns {{ txnId:string, reused:boolean } | { error:string, candidates?:Array }}
 *   error 를 돌려주면 **호출부가 롤백한다**. 조용히 반쪽만 처리하지 않는다.
 */
async function settleInvoiceTxn(conn, {
  invoiceId, invoiceNo, kind, vendorId, contractId, amount, date,
  acctId, category, acctCode, memo, backfillBatch = null, txnId = null, forceNew = false,
}) {
  const income = kind === 'income'
  const doneStatus = income ? '입금완료' : '지급완료'
  const total = Number(amount) || 0

  /* 붙일 거래를 **잠그고** 다시 확인한다.
   *
   * invoice_matches.txn_id 에는 유일 제약이 없다. 잠그지 않고 "안 붙었나?"만 읽으면,
   * 두 사람이 동시에 정산할 때 **같은 입금이 두 청구서에 붙는다** — 받은 돈이 두 배로
   * 잡히고, 화면 어디에도 경고가 없다(이 저장소가 상환·정산에서 이미 겪은 유형).
   * 후보를 고르는 쪽(openTxnCandidates)은 미리보기에서도 쓰이므로 잠그지 않는다.
   * 실제로 쓰기 직전인 여기서만 잠근다. */
  const lockPickable = async (id) => {
    const [[t]] = await conn.execute(
      `SELECT t.id, t.account_id FROM transactions t
         LEFT JOIN invoice_matches m ON m.txn_id = t.id
        WHERE t.id = ? AND t.kind = ? AND t.amount = ? AND t.status = ?
          AND t.invoice_id IS NULL AND m.id IS NULL
        FOR UPDATE`,
      [id, kind, total, doneStatus])
    return t || null
  }

  let reuse = null
  if (txnId) {
    /* 화면이 고른 거래 — 여기서 다시 확인한다. 미리보기와 저장 사이에 다른 사람이
       그 거래를 가져갔을 수 있고, 그때 조용히 새 거래를 만들면 또 이중이 된다. */
    reuse = await lockPickable(txnId)
    if (!reuse) return { error: `${date} 회차에 붙이려던 거래를 쓸 수 없어요. 그 사이 다른 청구서에 붙었는지 확인하고 미리보기를 다시 해주세요.` }
  } else if (!forceNew) {
    /* forceNew — 화면에서 후보를 보고도 '새로 만들기'를 고른 경우다. 사람이 보고 정했으면
       그대로 따른다(별건 입금이 같은 금액으로 찍히는 일은 실제로 있다). */
    const cands = await openTxnCandidates(conn, { kind, vendorId, amount: total, date })
    if (cands.length === 1) {
      // 고른 뒤에도 잠그고 다시 본다 — 읽은 순간과 쓰는 순간 사이에 누가 가져갈 수 있다
      reuse = await lockPickable(cands[0].id)
      if (!reuse) return { error: `${date} 회차에 붙이려던 거래를 그 사이 다른 청구서가 가져갔어요. 다시 시도해주세요.` }
    } else if (cands.length > 1) {
      return {
        candidates: cands,
        /* 고르는 자리가 없는 화면(회차 '기입금 처리')에서도 다음 수가 보이게 적는다 —
           "골라주세요"만 있으면 어디서 고르는지 몰라 막힌다. */
        error: `${date} 회차와 같은 금액(${total.toLocaleString('ko-KR')}원)의 ${income ? '입금' : '지급'} 거래가 `
             + `이미 ${cands.length}건 있어요(${cands.map(c => c.date).join(', ')}). `
             + `어느 것인지 골라야 같은 돈이 두 번 잡히지 않아요 — 여기서 고르거나, `
             + `${income ? '발행' : '등록'}만 하고 그 ${income ? '입금' : '지급'}을 청구서에 붙여주세요.`,
      }
    }
  }

  if (reuse) {
    /* 이미 장부에 있는 거래에 붙인다. 계좌는 그 거래의 것을 그대로 둔다 —
       통장에서 온 값이 우리가 짐작한 계좌보다 정확하다. */
    const acct = reuse.account_id || acctId || null
    const lerr = ledgerError({ kind, account_id: acct, status: doneStatus })
    if (lerr) return { error: lerr }
    /* ⚠ **주문·거래처도 채운다.** 예전(새로 만들던 코드)은 거래에 contract_id 를 넣고 있었다.
       붙여 쓰면서 그걸 빠뜨리면, 주문 지표가 거래에서 돈을 세는 탓에(METRIC_COLS in_done)
       그 주문의 '누적 수금'과 손익에서 이 돈이 조용히 빠진다 — 미수금은 청구서로 세니 맞는데
       수금만 비어, 화면 두 곳이 다시 다른 말을 하게 된다.
       이미 값이 있으면 건드리지 않는다. 통장에서 온 값이 우리 짐작보다 정확하다. */
    await conn.execute(
      `UPDATE transactions
          SET invoice_id = ?, status = ?, account_id = ?,
              contract_id = COALESCE(contract_id, ?),
              vendor_id   = COALESCE(vendor_id, ?)
        WHERE id = ?`,
      [invoiceId, doneStatus, acct, contractId || null, vendorId || null, reuse.id])
    /* txn_created=0 — 이 거래는 우리가 만든 게 아니다. 되돌리기가 지우면 안 된다. */
    await conn.execute(
      'INSERT INTO invoice_matches (id, invoice_id, txn_id, amount, txn_created) VALUES (?,?,?,?,0)',
      [randomUUID(), invoiceId, reuse.id, total])
    return { txnId: reuse.id, reused: true }
  }

  const acct = acctId || null
  const lerr = ledgerError({ kind, account_id: acct, status: doneStatus })
  if (lerr) return { error: lerr }
  const newId = randomUUID()
  await conn.execute(
    `INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, account_code, category,
                               amount, date, method, status, doc_no, invoice_id, memo, backfill_batch)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [newId, kind, vendorId || null, contractId || null, acct,
     acctCode || settleAcctCode(kind), category || (income ? '수금' : '대금 지급'),
     total, date, '계좌이체', doneStatus, '', invoiceId,
     memo || `청구서 ${invoiceNo || ''} 정산`.trim(), backfillBatch])
  await conn.execute(
    'INSERT INTO invoice_matches (id, invoice_id, txn_id, amount, txn_created) VALUES (?,?,?,?,1)',
    [randomUUID(), invoiceId, newId, total])
  return { txnId: newId, reused: false }
}

module.exports = { openTxnCandidates, settleInvoiceTxn, MATCH_WINDOW_DAYS }
