const { Router } = require('express')
const { randomUUID } = require('crypto')
const { kstToday } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError, amountError, SETTLED_INCOME, SETTLED_EXPENSE } = require('../lib/ledger')
const { moneyOf: intOf } = require('../lib/money')
const { recalcInvoiceStatus } = require('../lib/invoiceStatus')

const router = Router()

/**
 * 어음 — 받을어음(거래처가 우리에게) · 지급어음(우리가 거래처에).
 *
 * ── 최우선 규칙: 어음을 받은 건 돈을 받은 게 아니다 ──
 * 만기가 와야 현금이 된다. 그래서 **수취 시점에는 거래(transactions)를 만들지 않는다.**
 * 대신 청구서 정산(invoice_matches)에 txn_id 없이 기록한다(그 칸은 nullable 이다).
 *
 *   수취   청구서는 정산돼 미수금에서 빠지고, 계좌 잔액은 안 움직인다.
 *          (잔액은 status='입금완료'/'지급완료' 인 거래만 센다 — routes/accounts.js)
 *          회계로는 외상매출금 1204 ↓ / 받을어음 1205 ↑.
 *   만기   그때 비로소 거래를 만든다(완료 + 계좌) → 예금 ↑ / 받을어음 ↓.
 *   부도   그 invoice_matches 행을 지운다 → **청구서가 다시 미수로 돌아온다.**
 *          어음은 dishonored 로 남겨 이력을 지운 것처럼 보이지 않게 한다.
 *
 * ⚠ 만약 수취 때 '입금완료' 거래를 만들면 **통장에 없는 돈이 잔액에 잡힌다.**
 *   이 앱에서 가장 크게 틀어지는 종류의 사고다 — 그래서 일부러 안 만든다.
 *
 * ⚠ 지급어음은 방향만 반대다(외상매입금 2101 ↓ / 지급어음 2102 ↑).
 *   한 라우터에 담는다 — 갈라 두면 만기·부도 규칙이 두 벌이 되어 언젠가 어긋난다.
 *
 * ⚠ 멀티테넌트 — 전역 풀 금지. req.db 로만 질의한다.
 */

// 계정과목 — 표준 시딩에 이미 있는 코드다(account_subjects).
const ACCT = {
  receivable: '1205',   // 받을어음 (자산·당좌자산)
  payable:    '2102',   // 지급어음 (부채·유동부채)
}

const KINDS = new Set(['receivable', 'payable'])
const isRecv = (k) => k === 'receivable'

/**
 * 같은 어음이 이미 있나.
 *
 * 어음번호는 **실물 용지에 인쇄된 번호**라 시스템이 채번하지 않는다(그래서 UNIQUE 도 아니다).
 * 그런데 그 탓에 같은 어음을 두 번 등록해도 조용히 통과했다 — 없는 채권이 하나 더 생기고,
 * 만기일에 들어올 돈이 그만큼 부풀어 자금 예측이 틀어진다. 되돌리려면 어느 쪽이 진짜인지
 * 사람이 종이를 보고 골라야 한다.
 *
 * 번호만으로 판정하지 않는다 — 은행·지점이 다르면 번호가 겹칠 수 있다.
 * **거래처 + 어음번호 + 방향**이 같을 때만 같은 어음으로 본다.
 * 번호가 비어 있으면 판정하지 않는다(빈 번호끼리 묶으면 서로 다른 어음이 막힌다).
 *
 * @param excludeId 수정할 때 자기 자신은 뺀다
 */
const duplicateNote = async (db, { kind, note_no, vendor_id }, excludeId = null) => {
  const no = String(note_no || '').trim()
  if (!no || !vendor_id) return null
  const [[dup]] = await db.execute(
    `SELECT n.id, n.status, n.amount, n.due_on, v.name AS vendor_name
       FROM notes n LEFT JOIN vendors v ON v.id = n.vendor_id
      WHERE n.kind = ? AND n.vendor_id = ? AND TRIM(n.note_no) = ?
        ${excludeId ? 'AND n.id <> ?' : ''}
      LIMIT 1`,
    excludeId ? [kind, vendor_id, no, excludeId] : [kind, vendor_id, no])
  return dup || null
}

const dateError = (v, label) => {
  if (!v) return `${label}을 선택해주세요`
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? null : `${label} 형식이 올바르지 않아요`
}

const rowOut = (r) => ({
  id: r.id, kind: r.kind, noteNo: r.note_no || '',
  vendorId: r.vendor_id, vendorName: r.vendor_name || '',
  amount: Number(r.amount) || 0,
  issuedOn: r.issued_on, dueOn: r.due_on, status: r.status,
  accountId: r.account_id, accountName: r.account_name || '',
  settledOn: r.settled_on, dishonoredOn: r.dishonored_on, txnId: r.txn_id, originTxnId: r.origin_txn_id,
  invoiceId: r.invoice_id, invoiceNo: r.invoice_no || '',
  memo: r.memo || '', createdAt: r.created_at,
})

const SELECT = `
  SELECT n.*, v.name AS vendor_name, a.name AS account_name, i.invoice_no
    FROM notes n
    LEFT JOIN vendors  v ON v.id = n.vendor_id
    LEFT JOIN accounts a ON a.id = n.account_id
    LEFT JOIN invoices i ON i.id = n.invoice_id`

/* 목록 — 만기가 가까운 것부터. 보유 중인 것이 먼저 서고, 끝난 것(결제·부도)은 뒤로 간다.
   "무엇을 아직 못 받았나"가 이 화면을 여는 이유이기 때문이다. */
router.get('/', async (req, res, next) => {
  try {
    const where = []
    const params = []
    if (KINDS.has(req.query.kind)) { where.push('n.kind = ?'); params.push(req.query.kind) }
    if (['held', 'settled', 'dishonored'].includes(req.query.status)) {
      where.push('n.status = ?'); params.push(req.query.status)
    }
    const [rows] = await req.db.execute(
      `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY FIELD(n.status, 'held', 'dishonored', 'settled'), n.due_on ASC
        LIMIT 500`, params)
    res.json(rows.map(rowOut))
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [[r]] = await req.db.execute(`${SELECT} WHERE n.id = ?`, [req.params.id])
    if (!r) return res.status(404).json({ error: '없는 어음이에요' })
    res.json(rowOut(r))
  } catch (e) { next(e) }
})

/**
 * 어음 등록.
 *
 * invoice_id 를 주면 **그 청구서를 어음으로 정산한다** — 거래는 안 만들고
 * invoice_matches 에만 남긴다(위 머리말). 안 주면 어음만 대장에 올린다.
 */
router.post('/', async (req, res, next) => {
  try {
    const { kind, note_no, vendor_id, amount, issued_on, due_on, invoice_id, origin_txn_id, memo } = req.body
    /* ⚠ 검증 순서는 **폼에 놓인 순서**를 따른다(어느 쪽 어음 → 거래처 → 금액 → 발행일 → 만기일).
         예전엔 날짜부터 봤더니, 빈 폼으로 저장하면 거래처·금액을 놔두고 "만기일을
         선택해주세요"부터 떴다. 사람은 위에서부터 채우는데 지적은 아래에서 올라와,
         고치고 저장할 때마다 새 항목이 하나씩 튀어나온다. */
    if (!KINDS.has(kind)) return res.status(400).json({ error: '받을어음인지 지급어음인지 골라주세요' })
    if (!vendor_id) return res.status(400).json({ error: '거래처를 선택해주세요' })
    const amt = intOf(amount)
    { const e = amountError(amt); if (e) return res.status(400).json({ error: e }) }
    { const e = dateError(issued_on, '발행일'); if (e) return res.status(400).json({ error: e }) }
    { const e = dateError(due_on, '만기일');   if (e) return res.status(400).json({ error: e }) }
    /* ⚠ 만기가 발행보다 앞설 수 없다. 거꾸로 넣으면 자금 예측에서 이미 지난 날로
         잡혀 "받을 돈"이 조용히 사라진다. */
    if (due_on < issued_on) return res.status(400).json({ error: '만기일이 발행일보다 빠를 수 없어요' })
    /* 발행일이 마감된 달이면 막는다 — 어음 수취는 그 달의 채권을 바꾸는 일이다 */
    { const e = await closedPeriodError(req.db, issued_on); if (e) return res.status(409).json({ error: e }) }
    /* 같은 어음을 두 번 적는 것을 막는다. 통과시키면 없는 채권이 하나 더 생긴다. */
    {
      const dup = await duplicateNote(req.db, { kind, note_no, vendor_id })
      if (dup) {
        const st = dup.status === 'settled' ? '결제됨' : dup.status === 'dishonored' ? '부도' : '보유 중'
        return res.status(409).json({
          error: `이미 등록된 어음이에요 — ${dup.vendor_name || '거래처'} ${String(note_no).trim()} `
               + `(${Number(dup.amount).toLocaleString('ko-KR')}원 · 만기 ${dup.due_on} · ${st}). `
               + '다른 어음이면 어음번호를 확인해주세요.',
        })
      }
    }

    const conn = await req.db.getConnection()
    try {
      await conn.beginTransaction()

      let matchId = null
      if (invoice_id) {
        const [[inv]] = await conn.execute(
          `SELECT id, kind, invoice_no, total_amount,
                  COALESCE((SELECT SUM(amount) FROM invoice_matches WHERE invoice_id = ?), 0) AS matched
             FROM invoices WHERE id = ?`, [invoice_id, invoice_id])
        if (!inv) { await rollbackQuietly(conn); return res.status(404).json({ error: '없는 청구서예요' }) }
        /* 방향이 맞아야 한다 — 받을어음은 매출 청구서(issued), 지급어음은 매입(received).
           섞이면 남의 채권을 우리 채무로 지운 것이 된다. */
        const want = isRecv(kind) ? 'issued' : 'received'
        if (inv.kind !== want) {
          await rollbackQuietly(conn)
          return res.status(400).json({
            error: isRecv(kind) ? '받을어음은 우리가 발행한 청구서에만 붙일 수 있어요'
                                : '지급어음은 우리가 받은 청구서에만 붙일 수 있어요',
          })
        }
        const remain = (Number(inv.total_amount) || 0) - (Number(inv.matched) || 0)
        if (amt > remain) {
          await rollbackQuietly(conn)
          return res.status(400).json({
            error: `청구서 ${inv.invoice_no}의 남은 금액(${remain.toLocaleString('ko-KR')}원)보다 클 수 없어요`,
          })
        }
        /* ⚠ txn_id 를 **비운다.** 이것이 이 기능의 핵심이다 —
             거래가 없으므로 계좌 잔액은 그대로이고, 청구서만 정산된다. */
        matchId = randomUUID()
        await conn.execute(
          'INSERT INTO invoice_matches (id, invoice_id, txn_id, amount, txn_created) VALUES (?,?,?,?,0)',
          [matchId, invoice_id, null, amt])
        await recalcInvoiceStatus(conn, invoice_id)
      }

      const id = randomUUID()
      await conn.execute(
        `INSERT INTO notes (id, kind, note_no, vendor_id, amount, issued_on, due_on, status, invoice_id, match_id, origin_txn_id, memo)
         VALUES (?,?,?,?,?,?,?, 'held', ?,?,?,?)`,
        [id, kind, String(note_no || '').trim(), vendor_id, amt, issued_on, due_on,
         invoice_id || null, matchId, origin_txn_id || null, String(memo || '').trim()])

      await conn.commit()
      res.json({ ok: true, id })
    } catch (e) { await rollbackQuietly(conn); throw e }
    finally { conn.release() }
  } catch (e) { next(e) }
})

/**
 * 만기 결제 — 이때 **처음으로** 거래를 만든다.
 *
 * 받을어음이면 입금(예금 ↑ / 받을어음 ↓), 지급어음이면 출금(지급어음 ↓ / 예금 ↓).
 */
router.post('/:id/settle', async (req, res, next) => {
  try {
    const { account_id, date, memo } = req.body
    const on = date || kstToday()
    { const e = dateError(on, '결제일'); if (e) return res.status(400).json({ error: e }) }
    { const e = await closedPeriodError(req.db, on); if (e) return res.status(409).json({ error: e }) }

    const conn = await req.db.getConnection()
    try {
      await conn.beginTransaction()
      /* FOR UPDATE — 같은 어음을 두 번 결제해 거래가 둘 생기는 것을 막는다
         (차입금 상환·적금 만기와 같은 이유). */
      const [[n]] = await conn.execute('SELECT * FROM notes WHERE id = ? FOR UPDATE', [req.params.id])
      if (!n) { await rollbackQuietly(conn); return res.status(404).json({ error: '없는 어음이에요' }) }
      if (n.status !== 'held') {
        await rollbackQuietly(conn)
        return res.status(409).json({
          error: n.status === 'settled' ? '이미 결제된 어음이에요' : '부도 처리된 어음이에요. 먼저 되돌려주세요.',
        })
      }

      const recv = isRecv(n.kind)
      const txnKind = recv ? 'income' : 'expense'
      const status  = recv ? SETTLED_INCOME : SETTLED_EXPENSE
      { const e = ledgerError({ kind: txnKind, account_id, status, method: '계좌이체' })
        if (e) { await rollbackQuietly(conn); return res.status(400).json({ error: e }) } }

      const [[v]] = await conn.execute('SELECT name FROM vendors WHERE id = ?', [n.vendor_id])
      const label = `${recv ? '받을어음' : '지급어음'} ${n.note_no || ''} 만기`.replace(/\s+/g, ' ').trim()

      /* ⚠ **거래가 이미 있으면 새로 만들지 않는다.**
       *   거래 등록 폼에서 결제수단 '어음'으로 적은 건은 그때 거래가 만들어졌다
       *   (예정 상태라 잔액엔 안 잡혀 있다). 만기에 또 만들면 같은 돈이 두 번 잡힌다.
       *   있는 거래를 **완료로 바꾸고 계좌를 채워** 그때 비로소 잔액이 움직이게 한다. */
      let txnId = n.origin_txn_id || null
      if (txnId) {
        const [r] = await conn.execute(
          `UPDATE transactions SET status = ?, account_id = ?, date = ?, account_code = ? WHERE id = ?`,
          [status, account_id || null, on, recv ? ACCT.receivable : ACCT.payable, txnId])
        // 그 거래가 지워졌으면(사용자가 거래내역에서 삭제) 새로 만든다 — 만기 기록이 사라지면 안 된다
        if (!r.affectedRows) txnId = null
      }
      if (!txnId) {
        txnId = randomUUID()
        await conn.execute(
          `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, memo, account_code)
           VALUES (?,?,?,?,?,?,?, '계좌이체', ?,?,?)`,
          [txnId, txnKind, n.vendor_id || null, account_id || null,
           recv ? '수금' : '대금 지급', Number(n.amount) || 0, on, status,
           String(memo || '').trim() || `${v?.name || ''} ${label}`.trim(),
           /* ⚠ 상대 계정은 **받을어음/지급어음**이다(외상매출금이 아니다).
                그 채권·채무는 어음을 받을 때 이미 어음으로 바뀌었다. 여기서 또 외상으로
                적으면 같은 채권이 두 번 사라진다. */
           recv ? ACCT.receivable : ACCT.payable])
      }

      await conn.execute(
        `UPDATE notes SET status = 'settled', settled_on = ?, account_id = ?, txn_id = ? WHERE id = ?`,
        [on, account_id || null, txnId, n.id])

      await conn.commit()
      res.json({ ok: true, txnId })
    } catch (e) { await rollbackQuietly(conn); throw e }
    finally { conn.release() }
  } catch (e) { next(e) }
})

/**
 * 부도 — 못 받았다(또는 우리가 못 갚았다).
 *
 * ⚠ **청구서를 미수로 되돌린다.** 어음으로 정산 처리했던 invoice_matches 행을 지운다.
 *   안 지우면 받지도 못한 돈이 '받은 것'으로 남아 미수금이 실제보다 작아진다 —
 *   그 상태로 결산하면 못 받을 돈이 장부에서 사라진다.
 */
router.post('/:id/dishonor', async (req, res, next) => {
  try {
    const conn = await req.db.getConnection()
    try {
      await conn.beginTransaction()
      const [[n]] = await conn.execute('SELECT * FROM notes WHERE id = ? FOR UPDATE', [req.params.id])
      if (!n) { await rollbackQuietly(conn); return res.status(404).json({ error: '없는 어음이에요' }) }
      if (n.status === 'settled') {
        await rollbackQuietly(conn)
        return res.status(409).json({ error: '이미 결제된 어음이에요. 결제를 먼저 되돌려주세요.' })
      }
      if (n.status === 'dishonored') { await rollbackQuietly(conn); return res.json({ ok: true }) }

      if (n.match_id) {
        await conn.execute('DELETE FROM invoice_matches WHERE id = ?', [n.match_id])
        if (n.invoice_id) await recalcInvoiceStatus(conn, n.invoice_id)
      }
      /* ⚠ 부도일은 **컬럼에** 남긴다. 메모에만 적으면 부도 전표(수취 분개의 반대)를
           세울 날짜가 없어, 부도난 어음이 받을어음 잔액에 영원히 남는다.
           날짜를 따로 주지 않으면 만기일로 본다 — 부도는 만기에 판명된다. */
      const on = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.on || '')) ? req.body.on : (n.due_on || kstToday())
      await conn.execute(
        `UPDATE notes SET status = 'dishonored', match_id = NULL, dishonored_on = ?, memo = ? WHERE id = ?`,
        [on, `${n.memo || ''}${n.memo ? ' · ' : ''}부도 ${on}`.trim(), n.id])

      await conn.commit()
      res.json({ ok: true, restored: !!n.match_id })
    } catch (e) { await rollbackQuietly(conn); throw e }
    finally { conn.release() }
  } catch (e) { next(e) }
})

/* 되돌리기 — 결제·부도를 취소하고 '보유'로 되돌린다.
   ⚠ 결제를 되돌리면 그때 만든 거래도 함께 지운다. 안 지우면 통장에 없는 입금이 남는다.
   ⚠ 부도를 되돌리는 길은 두지 않는다 — 청구서를 이미 미수로 돌려놨으므로,
     다시 어음으로 받으려면 어음을 새로 등록하는 편이 흐름이 분명하다. */
router.post('/:id/unsettle', async (req, res, next) => {
  try {
    const conn = await req.db.getConnection()
    try {
      await conn.beginTransaction()
      const [[n]] = await conn.execute('SELECT * FROM notes WHERE id = ? FOR UPDATE', [req.params.id])
      if (!n) { await rollbackQuietly(conn); return res.status(404).json({ error: '없는 어음이에요' }) }
      if (n.status !== 'settled') { await rollbackQuietly(conn); return res.status(409).json({ error: '결제된 어음이 아니에요' }) }
      if (n.settled_on) {
        const e = await closedPeriodError(conn, n.settled_on)
        if (e) { await rollbackQuietly(conn); return res.status(409).json({ error: e }) }
      }
      /* ⚠ 거래 등록 폼에서 온 어음이면 그 거래는 **지우지 않는다** — 그건 어음을 준
           사실 자체를 적은 것이라, 지우면 비용까지 사라진다. 예정 상태로만 되돌린다. */
      if (n.txn_id && n.txn_id === n.origin_txn_id) {
        await conn.execute(
          `UPDATE transactions SET status = ?, account_id = NULL WHERE id = ?`,
          [isRecv(n.kind) ? '입금 예정' : '지급 예정', n.txn_id])
      } else if (n.txn_id) {
        await conn.execute('DELETE FROM transactions WHERE id = ?', [n.txn_id])
      }
      await conn.execute(
        `UPDATE notes SET status = 'held', settled_on = NULL, txn_id = NULL WHERE id = ?`, [n.id])
      await conn.commit()
      res.json({ ok: true })
    } catch (e) { await rollbackQuietly(conn); throw e }
    finally { conn.release() }
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { note_no, vendor_id, amount, issued_on, due_on, memo } = req.body
    { const e = dateError(issued_on, '발행일'); if (e) return res.status(400).json({ error: e }) }
    { const e = dateError(due_on, '만기일');   if (e) return res.status(400).json({ error: e }) }
    if (due_on < issued_on) return res.status(400).json({ error: '만기일이 발행일보다 빠를 수 없어요' })
    const amt = intOf(amount)
    { const e = amountError(amt); if (e) return res.status(400).json({ error: e }) }

    const [[n]] = await req.db.execute('SELECT kind, status, match_id FROM notes WHERE id = ?', [req.params.id])
    if (!n) return res.status(404).json({ error: '없는 어음이에요' })
    /* 수정으로도 같은 어음이 둘 되면 안 된다 — 등록만 막으면 번호를 고쳐서 겹칠 수 있다.
       kind 는 수정 폼에 없으므로 저장된 값을 쓴다. */
    {
      const dup = await duplicateNote(req.db, { kind: n.kind, note_no, vendor_id }, req.params.id)
      if (dup) {
        return res.status(409).json({
          error: `그 번호는 이미 다른 어음이 쓰고 있어요 — ${dup.vendor_name || '거래처'} `
               + `${Number(dup.amount).toLocaleString('ko-KR')}원 · 만기 ${dup.due_on}.`,
        })
      }
    }
    /* ⚠ 금액은 청구서 정산액과 묶여 있다 — 결제·정산이 걸린 뒤에는 못 바꾼다.
         바꾸면 청구서의 미수금이 어음 금액과 어긋난다. */
    if (n.status !== 'held') return res.status(409).json({ error: '결제·부도된 어음은 고칠 수 없어요' })
    if (n.match_id) {
      const [[m]] = await req.db.execute('SELECT amount FROM invoice_matches WHERE id = ?', [n.match_id])
      if (m && Number(m.amount) !== amt) {
        return res.status(409).json({ error: '청구서에 붙은 어음은 금액을 바꿀 수 없어요. 지우고 다시 등록해주세요.' })
      }
    }
    await req.db.execute(
      `UPDATE notes SET note_no=?, vendor_id=?, amount=?, issued_on=?, due_on=?, memo=? WHERE id=?`,
      [String(note_no || '').trim(), vendor_id || null, amt, issued_on, due_on,
       String(memo || '').trim(), req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    const conn = await req.db.getConnection()
    try {
      await conn.beginTransaction()
      const [[n]] = await conn.execute('SELECT * FROM notes WHERE id = ? FOR UPDATE', [req.params.id])
      if (!n) { await rollbackQuietly(conn); return res.status(404).json({ error: '없는 어음이에요' }) }
      if (n.status === 'settled') {
        await rollbackQuietly(conn)
        return res.status(409).json({ error: '결제된 어음은 지울 수 없어요. 결제를 먼저 되돌려주세요.' })
      }
      // 청구서에 붙여 둔 정산도 함께 걷는다 — 남기면 받지도 않은 돈이 정산으로 남는다
      if (n.match_id) {
        await conn.execute('DELETE FROM invoice_matches WHERE id = ?', [n.match_id])
        if (n.invoice_id) await recalcInvoiceStatus(conn, n.invoice_id)
      }
      await conn.execute('DELETE FROM notes WHERE id = ?', [n.id])
      await conn.commit()
      res.json({ ok: true })
    } catch (e) { await rollbackQuietly(conn); throw e }
    finally { conn.release() }
  } catch (e) { next(e) }
})

module.exports = router
