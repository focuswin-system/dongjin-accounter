/**
 * 문서의 승인·지출 처리 — 구매품의서와 지급결의서가 **같이** 쓰는 규칙.
 *
 * ── 흐름 ──
 *   작성 ─승인─▶ 승인 ─지출 처리─▶ 완료
 *
 * 품의를 승인할 때 "지출도 처리할까요?"를 묻는다. 예 → 품의에서 바로 처리한다.
 * 아니요 → 승인으로 두고, 나중에 품의서에서 처리하거나 지급결의서로 넘겨 거기서 처리한다.
 * 결의서도 승인한 뒤 같은 창으로 처리한다.
 *
 * ── 왜 한 곳인가 ──
 * 처리 규칙(마감·미래일·계좌 잔액·청구서 정산·이중계상 가드)이 이미 결의서 라우트에 있었다.
 * 품의에 같은 기능을 복사해 두면 한쪽만 고쳐진다 — "품의로 처리하면 막히는데 결의서로 하면
 * 통과" 같은 구멍이 곧 생긴다. 그래서 두 표를 받는 함수 하나로 옮겼다.
 * 두 표는 처리 결과 칸 이름이 같다(invoice_id·txn_id·txn_created·txn_prev_status·txn_prev_account_id).
 *
 * ── 돈은 한 번만 나간다 ──
 *   · 품의를 결의서로 넘기면(expense_resolutions.purchase_req_id) 품의에서는 처리할 수 없다.
 *     결의서를 처리하면 그 품의도 완료가 된다. 되돌리면 같이 되돌아간다.
 *   · 청구서가 붙은 문서는 **그 청구서를 지급**한다(새 비용이 아니라 외상매입금이 사라지는 것).
 *   · 청구서가 없는 문서를 새 지출로 처리하기 전에 두 가지를 되묻는다.
 *       dup_txn      같은 거래처·같은 금액의 지출이 통장에 이미 있다(lib/settleTxn.js 규칙)
 *       open_invoice 같은 거래처에 금액이 맞는 미지급 청구서가 있다 — 그 청구서로 지급해야
 *                    나중에 매입세액이 두 번 잡히지 않는다
 *
 * ⚠ 멀티테넌트 — conn/db 는 반드시 인자로 받는다. 기본값을 두면 조용히 남의 회사를 읽는다.
 */
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { closedPeriodError } = require('./closing')
const { ledgerError } = require('./ledger')
const { insertExpenseTxn } = require('./directTxn')
const { settleAcctCode } = require('./acctCode')
const { recalcInvoiceStatus } = require('./invoiceStatus')
const { lookalikeSettleTxns, dupSettleMessage } = require('./settleTxn')
const { httpError } = require('./withTx')

/* 표 이름을 SQL 에 끼워 넣으므로 반드시 이 목록으로 거른다 */
const DOC_TABLES = {
  expense_resolutions: { label: '지급결의서' },
  purchase_reqs:       { label: '구매품의서' },
}
const tableOf = (table) => {
  if (!DOC_TABLES[table]) throw new Error(`docExec: 알 수 없는 문서 표 ${table}`)
  return table
}
const won = (n) => Number(n || 0).toLocaleString('ko-KR')

/** 문서 한 건 + 처리에 필요한 파생값(금액·제목). 품의는 금액 칸이 없어 품목 합계를 쓴다. */
async function loadDoc(conn, table, id, { lock = false } = {}) {
  tableOf(table)
  const [[r]] = await conn.execute(`SELECT * FROM ${table} WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id])
  if (!r) return null
  if (table === 'purchase_reqs') {
    const [[{ total }]] = await conn.execute(
      'SELECT COALESCE(SUM(amount),0) AS total FROM purchase_req_items WHERE req_id = ?', [id])
    return { ...r, _amount: Number(total) || 0, _title: r.summary || r.vendor_name || '구매품의', _payMethod: '계좌이체' }
  }
  return { ...r, _amount: Number(r.amount) || 0, _title: r.title || '지출 결의', _payMethod: r.pay_method || '계좌이체' }
}

/** 청구서의 남은 금액. 없으면(지워졌으면) null */
async function invoiceState(conn, invoiceId, { lock = false } = {}) {
  if (!invoiceId) return null
  const [[inv]] = await conn.execute(
    `SELECT id, invoice_no, kind, vendor_id, contract_id, account_id, total_amount, issued_at FROM invoices WHERE id = ?${lock ? ' FOR UPDATE' : ''}`,
    [invoiceId])
  if (!inv) return null
  const [[{ paid }]] = await conn.execute(
    'SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [invoiceId])
  const total = Number(inv.total_amount) || 0
  return { ...inv, total, paid: Number(paid), remain: total - Number(paid) }
}

/**
 * 이 거래를 **처리 결과로** 붙든 문서 — 두 표(결의서·품의)를 다 본다.
 *
 * ⚠ 한 표만 보면 안 된다. 결의서 R 이 만든 거래 T 에 품의 P 가 연결되면 한 번 나간 돈으로
 *   두 문서가 완료된다. R 을 되돌리면 T 가 지워지고(purchase_reqs.txn_id 는 FK 가 없다)
 *   P 는 없는 거래를 가리킨 채 완료로 남는다 — 되돌릴 수도, 다시 처리할 수도 없다.
 *   반대(P 가 만든 T 에 R 연결)는 P 를 되돌릴 때 FK 오류(500)가 난다.
 * '품의의 근거 지출'(purchase_req_txns)은 여기서 안 센다 — 돈을 만든 연결이 아니라
 * "이 지출로 품의를 썼다"는 기록이라, 같은 지출에 사후 결의서를 붙이는 건 정상이다.
 */
async function txnClaimedBy(conn, txnId, { table = null, id = null } = {}) {
  if (!txnId) return null
  for (const t of Object.keys(DOC_TABLES)) {
    const [[row]] = await conn.execute(
      `SELECT doc_no FROM ${t} WHERE txn_id = ?${t === table ? ' AND id <> ?' : ''} LIMIT 1`,
      t === table ? [txnId, id] : [txnId])
    if (row) return { label: DOC_TABLES[t].label, doc_no: row.doc_no }
  }
  return null
}
/** 두 표의 처리 결과 거래를 뺄 때 쓰는 SQL 조각(자기 문서는 남긴다). 인자 순서: [selfId, selfId] */
const NOT_CLAIMED_SQL = (col, table) => `
        AND ${col} NOT IN (SELECT txn_id FROM expense_resolutions WHERE txn_id IS NOT NULL${table === 'expense_resolutions' ? ' AND id <> ?' : ''})
        AND ${col} NOT IN (SELECT txn_id FROM purchase_reqs WHERE txn_id IS NOT NULL${table === 'purchase_reqs' ? ' AND id <> ?' : ''})`

/**
 * 청구서가 사라질 때 그 청구서를 가리키던 품의·결의서의 연결을 푼다.
 * 정산 내역이 있으면 청구서 삭제 자체가 막히므로 여기까지 오는 건 **아직 돈이 안 나간** 연결뿐이다.
 * 남겨 두면 처리 창이 없는 청구서를 찾다 '청구서 없는 지출'로 조용히 바뀌어, 결재받은 금액과 다른 규칙으로 처리된다.
 */
async function detachInvoiceFromDocs(conn, invoiceId) {
  await conn.execute("UPDATE purchase_reqs SET invoice_id = NULL WHERE invoice_id = ? AND COALESCE(status,'') <> '완료'", [invoiceId])
  await conn.execute("UPDATE expense_resolutions SET invoice_id = NULL WHERE invoice_id = ? AND COALESCE(status,'') <> '완료'", [invoiceId])
}

/**
 * 결의서를 따라 품의 상태를 바꾼다 — **품의 자신이 돈을 낸 적이 없을 때만**(txn_id IS NULL).
 * 경합으로 품의가 스스로 처리까지 한 뒤라면, 결의서 쪽 변화로 그 품의를 승인으로 되돌리면
 * 이미 낸 돈을 한 번 더 처리할 수 있게 된다.
 */
async function syncReqFromResolution(conn, reqId, status) {
  if (!reqId) return
  if (status === '완료') {
    await conn.execute("UPDATE purchase_reqs SET status = '완료' WHERE id = ? AND txn_id IS NULL", [reqId])
  } else {
    await conn.execute("UPDATE purchase_reqs SET status = '승인' WHERE id = ? AND status = '완료' AND txn_id IS NULL", [reqId])
  }
}

/** 품의를 넘겨받은 결의서(있으면). 품의에서 직접 처리·연결 변경을 막는 근거다. */
async function resolutionOfReq(conn, reqId) {
  const [[r]] = await conn.execute(
    'SELECT id, doc_no, status FROM expense_resolutions WHERE purchase_req_id = ? ORDER BY created_at LIMIT 1', [reqId])
  return r || null
}

/** 이 품의가 **이미 나간 지출에서** 만들어졌나 */
async function sourceTxnsOfReq(conn, reqId) {
  const [rows] = await conn.execute(
    `SELECT p.txn_id, t.date, t.amount FROM purchase_req_txns p
       JOIN transactions t ON t.id = p.txn_id
      WHERE p.req_id = ? ORDER BY t.date`, [reqId])
  return rows
}

/**
 * 처리할 돈이 남았나. 없으면 그 이유(승인하면 곧바로 완료로 둔다).
 *   · 이미 나간 지출로 만든 품의(청구서 없음)
 *   · 붙은 청구서가 이미 다 지급됨
 */
async function nothingToPay(conn, table, doc) {
  const inv = await invoiceState(conn, doc.invoice_id)
  if (inv && inv.remain <= 0) return `청구서 ${inv.invoice_no || ''}가 이미 지급 완료돼 있어요`.replace('  ', ' ')
  if (!inv && table === 'purchase_reqs') {
    const src = await sourceTxnsOfReq(conn, doc.id)
    if (src.length) return '이미 나간 지출로 만든 품의예요'
  }
  return null
}

/* ── 승인 ────────────────────────────────────────────────────────── */

/**
 * 작성 → 승인. 처리할 돈이 없으면 곧바로 완료로 둔다(묻는 게 헛돈다).
 * @returns {{ status:string, autoDone:string|null }}
 */
async function approveDoc(conn, table, id) {
  tableOf(table)
  const doc = await loadDoc(conn, table, id, { lock: true })
  if (!doc) throw httpError(404, `${DOC_TABLES[table].label}를 찾을 수 없어요`)
  if (doc.status === '완료') throw httpError(409, '이미 처리된 문서예요')
  if (doc.status === '승인') return { status: '승인', autoDone: null }     // 멱등
  // 돈이 나간 기록(txn_id)이 있는데 완료가 아니면 어딘가에서 상태가 덮였다 — 여기서 더 나아가면 두 번 낸다
  if (doc.txn_id) throw httpError(409, '지출이 연결된 문서인데 상태가 어긋나 있어요. 처리 취소부터 해주세요.')
  const why = await nothingToPay(conn, table, doc)
  const next = why ? '완료' : '승인'
  await conn.execute(`UPDATE ${table} SET status = ? WHERE id = ?`, [next, id])
  // 품의에서 넘겨받은 결의서가 끝나면 그 품의도 끝난 것이다(처리할 때와 같은 규칙)
  if (next === '완료' && table === 'expense_resolutions') await syncReqFromResolution(conn, doc.purchase_req_id, '완료')
  return { status: next, autoDone: why }
}

/**
 * 승인 → 작성. 돈이 나간 뒤에는 못 되돌린다 — 처리 취소가 먼저다.
 * 처리할 돈이 없어 곧바로 완료된 것(txn 없음)은 작성으로 바로 되돌릴 수 있다.
 */
async function unapproveDoc(conn, table, id) {
  tableOf(table)
  const doc = await loadDoc(conn, table, id, { lock: true })
  if (!doc) throw httpError(404, `${DOC_TABLES[table].label}를 찾을 수 없어요`)
  if (doc.status === '완료' && doc.txn_id) throw httpError(409, '지출 처리된 문서예요. 처리 취소부터 해주세요.')
  if (table === 'purchase_reqs') {
    const er = await resolutionOfReq(conn, id)
    if (er) throw httpError(409, `지급결의서 ${er.doc_no}에서 쓰고 있는 품의예요. 그 결의서를 먼저 지워주세요.`)
  }
  await conn.execute(`UPDATE ${table} SET status = '작성' WHERE id = ?`, [id])
  if (doc.status === '완료' && table === 'expense_resolutions') await syncReqFromResolution(conn, doc.purchase_req_id, '승인')
  return { status: '작성' }
}

/* ── 처리 ────────────────────────────────────────────────────────── */

/** 같은 거래처에 **금액이 맞는** 미지급 청구서 — 오차 규칙은 구매품의 중복 확인과 같다 */
async function openInvoicesFor(db, vendorId, amount, { nearOnly = false, excludeIds = [] } = {}) {
  if (!vendorId) return []
  // 같은 이름으로 여러 벌 등록된 거래처도 한곳으로 본다(그 청구서가 다른 벌에 붙어 있을 수 있다)
  const [rows] = await db.execute(
    `SELECT i.id, i.invoice_no, i.issued_at, i.due_at, i.total_amount, i.memo,
            COALESCE((SELECT SUM(m.amount) FROM invoice_matches m WHERE m.invoice_id = i.id), 0) AS paid
       FROM invoices i
      WHERE i.kind = 'received'
        AND i.vendor_id IN (SELECT v2.id FROM vendors v1 JOIN vendors v2 ON TRIM(v2.name) = TRIM(v1.name) WHERE v1.id = ?)
      ORDER BY i.issued_at DESC
      LIMIT 200`, [vendorId])
  const amt = Number(amount) || 0
  const near = Math.min(1000, Math.max(1, Math.round(amt * 0.005)))
  const close = (x) => amt > 0 && (Math.abs(x - amt) <= near
    || Math.abs(x - Math.round(amt * 1.1)) <= near || Math.abs(x - Math.round(amt / 1.1)) <= near)
  const out = rows
    .map(r => ({ id: r.id, invoice_no: r.invoice_no, issued_at: r.issued_at, due_at: r.due_at, memo: r.memo || '',
      total: Number(r.total_amount) || 0, remain: (Number(r.total_amount) || 0) - Number(r.paid) }))
    .filter(r => r.remain > 0 && !excludeIds.includes(r.id))
    .map(r => ({ ...r, near: close(r.remain) }))
  const filtered = nearOnly ? out.filter(r => r.near) : out
  return filtered.sort((a, b) => Number(b.near) - Number(a.near))
}

/**
 * 연결할 만한 지출 거래 — 처리 창의 '통장 거래에 연결' 목록.
 * 같은 거래처가 위로, 금액이 가까울수록 위로.
 */
async function execCandidates(db, table, doc) {
  tableOf(table)
  const inv = await invoiceState(db, doc.invoice_id)
  const target = inv ? inv.remain : doc._amount
  /* 제외:
   *  · 같은 종류 문서가 이미 처리 결과로 붙든 거래 — 한 지출을 두 결의서(두 품의)가 완료로 삼으면
   *    한 번 나간 돈으로 두 건이 끝나고, 나머지 한 건의 지출은 영영 기록되지 않는다
   *  · 품의: 다른 품의의 '이미 나간 지출' 출처로 잡힌 거래(같은 이유)
   *  · 청구서가 붙은 문서: 이미 다른 청구서에 매칭된 거래 — 골라 봐야 처리에서 막힌다 */
  const extra = []
  if (table === 'purchase_reqs') extra.push('AND t.id NOT IN (SELECT txn_id FROM purchase_req_txns WHERE req_id <> ?)')
  if (inv) extra.push('AND t.id NOT IN (SELECT txn_id FROM invoice_matches WHERE txn_id IS NOT NULL)')
  const [rows] = await db.execute(
    `SELECT t.id, t.date, t.amount, t.category, t.memo, t.status, t.account_id, t.vendor_id,
            v.name AS vendor_name, a.name AS account_name
       FROM transactions t
       LEFT JOIN vendors v ON t.vendor_id = v.id
       LEFT JOIN accounts a ON t.account_id = a.id
      WHERE t.kind = 'expense'
        ${NOT_CLAIMED_SQL('t.id', table)}
        ${extra.join('\n        ')}
      ORDER BY (t.vendor_id <=> ?) DESC, ABS(t.amount - ?) ASC, t.date DESC
      LIMIT 30`,
    [doc.id, ...(table === 'purchase_reqs' ? [doc.id] : []), doc.vendor_id || null, target])
  return rows.map(t => ({ ...t, amount: Number(t.amount) || 0, related: !!doc.vendor_id && t.vendor_id === doc.vendor_id }))
}

/**
 * 지출 처리.
 * @param body { mode:'link'|'create', txn_id, amount, date, account_id,
 *               tax_type, vat_deductible, evid_type, category, allow_new, skip_invoice }
 * @returns {{ txn_id:string, invoicePaid:boolean, created:boolean }}
 */
async function executeDoc(conn, table, id, body = {}) {
  tableOf(table)
  const label = DOC_TABLES[table].label
  const { mode, txn_id } = body
  const r = await loadDoc(conn, table, id, { lock: true })
  if (!r) throw httpError(404, `${label}를 찾을 수 없어요`)
  if (r.status === '완료') throw httpError(409, `이미 처리된 ${label}예요`)
  if (r.status !== '승인') throw httpError(409, '먼저 승인해주세요')
  if (r.txn_id) throw httpError(409, '지출이 연결된 문서인데 상태가 어긋나 있어요. 처리 취소부터 해주세요.')
  if (table === 'purchase_reqs') {
    const er = await resolutionOfReq(conn, id)
    if (er) throw httpError(409, `지급결의서 ${er.doc_no}로 넘긴 품의예요. 그 결의서에서 처리해주세요.`)
  }
  if (table === 'expense_resolutions' && r.purchase_req_id) {
    /* 넘겨받은 품의를 잠그고 본다. 넘기기 직전에 품의에서 이미 처리했다면(경합) 여기서 또 내면 두 번이다. */
    const [[pr]] = await conn.execute('SELECT doc_no, txn_id FROM purchase_reqs WHERE id = ? FOR UPDATE', [r.purchase_req_id])
    if (pr && pr.txn_id) throw httpError(409, `구매품의서 ${pr.doc_no}에서 이미 지출 처리했어요. 이 결의서는 처리할 돈이 없어요.`)
  }

  /* 청구서가 붙은 문서면 그 청구서를 잠그고 남은 금액을 본다.
     이미 완납이면 새 지출을 만들어봐야 매칭할 잔액이 없어 지출만 붕 뜬다(이중 계상). */
  const inv = await invoiceState(conn, r.invoice_id, { lock: true })
  if (inv && inv.remain <= 0) throw httpError(409, '연결된 청구서가 이미 지급 완료됐어요')
  /* 이미 나간 지출로 만든 품의는 처리할 돈이 없다. 승인하면 곧바로 완료가 되지만,
     그 완료를 되돌린 뒤(승인 상태) 여기로 오면 같은 돈을 새 지출로 한 번 더 만들 수 있다. */
  if (!inv && table === 'purchase_reqs' && (await sourceTxnsOfReq(conn, id)).length) {
    throw httpError(409, '이미 나간 지출로 만든 품의예요. 처리할 돈이 없어요.')
  }

  /* 마감 검사 — '실제로 쓰일 날짜'로 본다. 연결이면 그 거래의 날짜다.
     (예전 결의서 처리는 body.date 만 봐서 연결 모드가 늘 무검사였다) */
  let linkTxn = null
  if (mode === 'link') {
    if (!txn_id) throw httpError(400, '연결할 지출 거래를 선택해주세요')
    // FOR UPDATE — 같은 거래를 두 문서가 동시에 집으려 할 때 한쪽을 기다리게 한다
    const [[t]] = await conn.execute(
      "SELECT id, status, account_id, amount, date, doc_no FROM transactions WHERE id = ? AND kind = 'expense' FOR UPDATE", [txn_id])
    if (!t) throw httpError(404, '지출 거래를 찾을 수 없어요')
    linkTxn = t
  }
  const effDate = mode === 'link' ? linkTxn.date : (body.date || kstToday())
  {
    const ce = await closedPeriodError(conn, effDate)
    if (ce) throw httpError(409, ce)
  }

  let linkedTxnId = null, txnCreated = false, prevStatus = null, prevAccountId = null

  if (mode === 'link') {
    /* 같은 종류의 다른 문서가 이미 처리 결과로 붙든 거래는 막는다.
       후보 목록이 빼 주긴 하지만 그 목록은 창을 열 때 한 번만 받는다 —
       열어 둔 두 창에서 같은 거래를 고르면 한 번 나간 돈으로 두 건이 완료된다. */
    const dup = await txnClaimedBy(conn, txn_id, { table, id })
    if (dup) throw httpError(409, `이 지출은 이미 ${dup.label} ${dup.doc_no || ''}에서 처리됐어요. 다른 지출을 고르거나 새로 등록하세요.`.replace('  ', ' '))
    if (table === 'purchase_reqs') {
      const [[src]] = await conn.execute(
        `SELECT pr.doc_no FROM purchase_req_txns p JOIN purchase_reqs pr ON pr.id = p.req_id
          WHERE p.txn_id = ? AND p.req_id <> ? LIMIT 1`, [txn_id, id])
      if (src) throw httpError(409, `이 지출은 구매품의서 ${src.doc_no}의 근거로 이미 쓰였어요.`)
    }
    // 되돌릴 때 쓰려면 바꾸기 전 값을 지금 적어 둬야 한다 — 바꾼 뒤에는 원래 무엇이었는지 알 수 없다
    prevStatus = linkTxn.status || null
    prevAccountId = linkTxn.account_id || null
    // 처리는 '집행'이다. 연결 대상이 아직 미지급이면 지급완료로 바꿔야 계좌 잔액에서 빠진다.
    const acct = linkTxn.account_id || body.account_id || inv?.account_id || null
    const lerr = ledgerError({ kind: 'expense', account_id: acct, status: '지급완료' })
    if (lerr) throw httpError(400, lerr)
    linkedTxnId = linkTxn.id
    await conn.execute("UPDATE transactions SET doc_no = ? WHERE id = ? AND (doc_no IS NULL OR doc_no = '' OR doc_no = '공통')", [r.doc_no, linkTxn.id])
    await conn.execute("UPDATE transactions SET status = '지급완료', account_id = ? WHERE id = ?", [acct, linkTxn.id])
  } else if (mode === 'create') {
    // 지출일은 실제로 돈이 나간 날이라 미래일 수 없다
    if (futureDateError(effDate)) throw httpError(400, '미래 날짜로는 처리할 수 없어요 (오늘까지만 가능)')
    const amt = Number(body.amount) > 0 ? Math.round(Number(body.amount)) : (inv ? inv.remain : r._amount)
    if (!(amt > 0)) throw httpError(400, '지출 금액을 입력해주세요')
    /* 청구서 잔액을 넘는 지급은 거절한다. 예전 결의서 처리는 넘는 금액으로 거래를 만들고
       매칭만 잔액까지 잘라서, 차액이 어느 청구서에도 안 붙은 지출로 조용히 남았다. */
    if (inv && amt > inv.remain) {
      throw httpError(409, `청구서 ${inv.invoice_no || ''}의 남은 금액은 ${won(inv.remain)}원이에요 (${won(amt)}원 입력).`.replace('  ', ' '))
    }
    // 계좌가 없으면 만들지 않는다 — NULL 이면 어느 계좌 잔액에서도 안 빠져 잔액이 과대 계상된다
    const acct = body.account_id || inv?.account_id || null
    const lerr = ledgerError({ kind: 'expense', account_id: acct, status: '지급완료' })
    if (lerr) throw httpError(400, lerr)

    /* 청구서가 없는 새 지출이면 비목이 있어야 한다. 비목이 곧 계정과목이다 —
       없으면 전표의 비용 줄이 비어 일계표 차·대변이 안 맞는다(예전엔 결의서 제목을 비목 칸에
       넣어서 '5축 가공 외주 단가주문' 같은 자유 글이 비목 집계를 오염시켰다). */
    const category = String(body.category || '').trim()
    if (!inv && !category) throw httpError(400, '비목을 골라주세요')

    // 같은 거래처에 금액이 맞는 미지급 청구서가 있으면 그 청구서로 지급하게 되묻는다
    if (!inv && !body.skip_invoice && r.vendor_id) {
      const open = await openInvoicesFor(conn, r.vendor_id, amt, { nearOnly: true })
      if (open.length) {
        throw httpError(409, '이 거래처에 금액이 맞는 미지급 청구서가 있어요', { code: 'open_invoice', invoices: open.slice(0, 5) })
      }
    }
    // 통장에서 이미 올라온 같은 지출이 있으면 되묻는다(새로 만들면 한 번 나간 돈이 두 줄이 된다)
    // 거래처를 몰라도 같은 계좌로 본다(lib/settleTxn.js) — 결의서 직접 작성은 거래처가 비기 쉽다
    if (!body.allow_new) {
      const found = await lookalikeSettleTxns(conn, {
        kind: 'expense', vendorId: r.vendor_id || inv?.vendor_id || null, accountId: acct, amount: amt, date: effDate, invoiceId: inv?.id || null })
      const msg = dupSettleMessage(found, 'expense')
      if (msg) throw httpError(409, msg, { code: 'dup_txn' })
    }

    let newId = randomUUID()
    if (inv) {
      /* 청구서 정산 — 매입은 청구서 받을 때 이미 인식됐고, 지금은 그때 생긴 외상매입금이 사라진다.
         그래서 계정은 외상매입금, 비목은 '대금 지급', 세액 칸은 비운다(청구서 쪽에서 센다).
         주문(contract_id)은 청구서에서 승계한다 — 빠지면 그 주문의 지급 실적에서 사라진다. */
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, account_code, category, amount, date, method, status, doc_no, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [newId, 'expense', r.vendor_id || inv.vendor_id || null, inv.contract_id || null, acct,
         settleAcctCode('expense'), '대금 지급', amt, effDate, r._payMethod,
         '지급완료', r.doc_no, `${label} ${r.doc_no} 처리`])
    } else {
      /* 청구서 없는 실제 비용 — 부가세·계정 칸은 공용 함수가 채운다(lib/directTxn.js, 반복거래와 같은 규칙).
         증빙유형이 불공제(간이영수증 등)면 집계가 알아서 공제에서 뺀다. */
      newId = await insertExpenseTxn(conn, {
        vendorId: r.vendor_id, accountId: acct, category, amount: amt, date: effDate, method: r._payMethod,
        docNo: r.doc_no, memo: `${label} ${r.doc_no} 처리`,
        taxType: body.tax_type, vatDeductible: body.vat_deductible,
        evidType: String(body.evid_type || '').trim() || null,
      })
    }
    linkedTxnId = newId
    txnCreated = true
  } else {
    throw httpError(400, "mode는 'link' 또는 'create'여야 해요")
  }

  // 청구서가 붙은 문서면 처리한 지출을 그 청구서에 지급 매칭한다
  let invoicePaid = false
  if (inv) {
    // 한 거래는 한 청구서에만 — 이미 다른 청구서에 붙은 지출이면 재매칭하지 않는다(이중 계상)
    const [[dupMatch]] = await conn.execute('SELECT invoice_id FROM invoice_matches WHERE txn_id = ? LIMIT 1', [linkedTxnId])
    if (dupMatch) throw httpError(409, '이미 다른 청구서에 매칭된 지출이에요')
    const [[txnRow]] = await conn.execute('SELECT amount FROM transactions WHERE id = ?', [linkedTxnId])
    const matchAmount = Math.min(Number(txnRow.amount) || 0, inv.remain)
    await conn.execute('UPDATE transactions SET invoice_id = ? WHERE id = ?', [inv.id, linkedTxnId])
    await conn.execute(
      'INSERT INTO invoice_matches (id, invoice_id, txn_id, amount, txn_created) VALUES (?,?,?,?,?)',
      [randomUUID(), inv.id, linkedTxnId, matchAmount, txnCreated ? 1 : 0])
    // 상태 규칙은 lib/invoiceStatus.js 하나 — 직접 적으면 부분 지급이 섞일 때 틀린다
    await recalcInvoiceStatus(conn, inv.id)
    invoicePaid = true
  }

  await conn.execute(
    `UPDATE ${table} SET status = '완료', txn_id = ?, txn_created = ?, txn_prev_status = ?, txn_prev_account_id = ? WHERE id = ?`,
    [linkedTxnId, txnCreated ? 1 : 0, prevStatus, prevAccountId, id])
  // 품의에서 넘겨받은 결의서면 그 품의도 끝난 것이다
  if (table === 'expense_resolutions') await syncReqFromResolution(conn, r.purchase_req_id, '완료')
  return { txn_id: linkedTxnId, invoicePaid, created: txnCreated }
}

/**
 * 처리 취소 — 완료 → 승인. 지출·청구서 정산을 함께 되돌린다.
 *
 * 순서와 이유:
 *   1. 문서의 거래 연결을 **먼저** 끊는다 — expense_resolutions.txn_id 는 FK 라,
 *      쥔 채 거래를 지우면 ER_ROW_IS_REFERENCED 로 트랜잭션이 통째로 터진다
 *   2. 마감 검사 — 마감된 달의 지출을 지우면 그 달 잔액이 사후에 바뀐다
 *   3. 청구서 정산 해제 → 상태 재계산
 *   4. 거래는 **문서가 만든 것만** 지운다. 이미 있던 거래는 통장에 실제로 오간 독립 기록이라
 *      남기고, 연결 전 상태·계좌로 되돌린다(안 되돌리면 청구서는 미지급으로 살아나는데
 *      돈은 나간 것으로 남아, 다시 지급하면 같은 돈이 두 번 나간다)
 *
 * 되돌린 뒤 상태는 **승인**이다. 결재는 그대로 유효하고, 잘못한 것은 처리다.
 * 삭제(cascade)도 이 함수를 먼저 부른다 — 두 벌로 두면 한쪽만 고쳐진다.
 */
async function undoDoc(conn, table, id) {
  tableOf(table)
  const r = await loadDoc(conn, table, id, { lock: true })
  if (!r) throw httpError(404, `${DOC_TABLES[table].label}를 찾을 수 없어요`)
  if (r.status !== '완료') return { doc: r, changed: false, keptTxn: false, restored: false }
  /* 돈 없이 끝난 완료(이미 나간 지출·완납 청구서라 승인 즉시 완료)는 되돌릴 처리가 없다.
     되돌릴 곳은 '승인 취소'다(unapproveDoc) — 여기서 승인으로 내리면 처리 버튼이 다시 살아난다. */
  if (!r.txn_id) return { doc: r, changed: false, keptTxn: false, restored: false }

  let keptTxn = false, restored = false
  await conn.execute(
    `UPDATE ${table} SET status = '승인', txn_id = NULL, txn_created = 0, txn_prev_status = NULL, txn_prev_account_id = NULL WHERE id = ?`,
    [id])
  if (table === 'expense_resolutions') await syncReqFromResolution(conn, r.purchase_req_id, '승인')

  if (r.txn_id) {
    const [[txn]] = await conn.execute('SELECT id, date FROM transactions WHERE id = ? FOR UPDATE', [r.txn_id])
    if (txn) {
      const ce = await closedPeriodError(conn, txn.date)
      if (ce) throw httpError(409, ce)
    }
    /* 이 지출이 물고 있던 청구서 정산을 푼다 — **이 문서의 청구서 것만**.
       연결한 기존 거래가 원래 다른 청구서에도 붙어 있었을 수 있다(처리 전부터). 그건 이 문서가
       만든 정산이 아니므로 건드리면 남의 지급 기록을 지우게 된다. */
    const [matches] = r.invoice_id
      ? await conn.execute('SELECT id, invoice_id FROM invoice_matches WHERE txn_id = ? AND invoice_id = ?', [r.txn_id, r.invoice_id])
      : [[]]
    for (const m of matches) await conn.execute('DELETE FROM invoice_matches WHERE id = ?', [m.id])
    for (const invId of [...new Set(matches.map(m => m.invoice_id))]) await recalcInvoiceStatus(conn, invId)
    const [[rest]] = await conn.execute('SELECT MIN(invoice_id) AS keep FROM invoice_matches WHERE txn_id = ?', [r.txn_id])

    // 옛 데이터·경합으로 다른 문서도 이 거래를 처리 결과로 쥐고 있으면 지우지 않는다(그 문서가 허공을 가리킨다)
    const other = await txnClaimedBy(conn, r.txn_id, { table, id })
    if (txn) {
      if (Number(r.txn_created) === 1 && !rest.keep && !other) {
        await conn.execute('DELETE FROM transactions WHERE id = ?', [r.txn_id])
      } else {
        await conn.execute('UPDATE transactions SET invoice_id = ? WHERE id = ?', [rest.keep || null, r.txn_id])
        // 증빙란의 문서번호도 지운다 — 이 문서가 붙인 번호일 때만(다른 번호는 남의 것)
        await conn.execute('UPDATE transactions SET doc_no = NULL WHERE id = ? AND doc_no = ?', [r.txn_id, r.doc_no])
        if (r.txn_prev_status) {
          await conn.execute('UPDATE transactions SET status = ?, account_id = ? WHERE id = ?',
            [r.txn_prev_status, r.txn_prev_account_id || null, r.txn_id])
          restored = true
        }
        keptTxn = true
      }
    }
  }
  return { doc: r, changed: true, keptTxn, restored }
}

/**
 * 문서에 매입 청구서를 붙이거나(invoiceId) 뗀다(null).
 * 처리 창에서 "이 거래처에 미지급 청구서가 있어요 → 이 청구서로 지급"을 누르면 온다.
 */
async function linkInvoiceDoc(conn, table, id, invoiceId) {
  tableOf(table)
  const label = DOC_TABLES[table].label
  const r = await loadDoc(conn, table, id, { lock: true })
  if (!r) throw httpError(404, `${label}를 찾을 수 없어요`)
  if (r.status === '완료') throw httpError(409, '처리된 문서는 청구서를 바꿀 수 없어요. 처리 취소부터 해주세요.')
  if (table === 'purchase_reqs') {
    const er = await resolutionOfReq(conn, id)
    if (er) throw httpError(409, `지급결의서 ${er.doc_no}로 넘긴 품의예요. 그 결의서에서 바꿔주세요.`)
  }
  if (invoiceId) {
    const inv = await invoiceState(conn, invoiceId, { lock: true })
    if (!inv) throw httpError(404, '청구서를 찾을 수 없어요')
    if (inv.kind !== 'received') throw httpError(400, '매입 청구서만 붙일 수 있어요')
    if (r.vendor_id && inv.vendor_id && r.vendor_id !== inv.vendor_id) throw httpError(400, '거래처가 다른 청구서예요')
    // 한 청구서는 같은 종류 문서 하나에만 — 두 결의서가 같은 청구서를 지급하려 들면 한쪽이 붕 뜬다
    const [[other]] = await conn.execute(`SELECT doc_no FROM ${table} WHERE invoice_id = ? AND id <> ? LIMIT 1`, [invoiceId, id])
    if (other) throw httpError(409, `청구서 ${inv.invoice_no || ''}는 이미 ${label} ${other.doc_no}에 붙어 있어요.`.replace('  ', ' '))
  }
  await conn.execute(`UPDATE ${table} SET invoice_id = ? WHERE id = ?`, [invoiceId || null, id])
  return { invoice_id: invoiceId || null }
}

module.exports = {
  txnClaimedBy, NOT_CLAIMED_SQL, detachInvoiceFromDocs, syncReqFromResolution,
  DOC_TABLES, loadDoc, invoiceState, resolutionOfReq, sourceTxnsOfReq, nothingToPay,
  approveDoc, unapproveDoc, executeDoc, undoDoc, linkInvoiceDoc, execCandidates, openInvoicesFor,
}
