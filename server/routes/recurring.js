const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday, kstDate } = require('../db')
const { dueDatesToGenerate, addDays, LOOKAHEAD_DAYS, pendingCycle } = require('../lib/recurrence')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError, amountError } = require('../lib/ledger')
const { closedPeriodError } = require('../lib/closing')
const { recurFromTotal, modeFromCatVat } = require('../lib/vat')

const router = Router()

/* 정기지출의 부가세: amount(합계 = VAT 포함)에서 세액을 뺀다.
   vat_mode가 저장돼 있으면(폼에서 직접 선택) 그걸 쓰고, 없으면(옛 데이터) 비목 categories.vat를 따른다. */
const expenseVat = (total, vatMode, catVat) =>
  recurFromTotal(total, vatMode || modeFromCatVat(catVat))

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(`
      SELECT r.*, v.name AS vendor_name
      FROM recurring_expenses r
      LEFT JOIN vendors v ON r.vendor_id = v.id
      ORDER BY r.day_of_month
    `)
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { vendor_id, contract_id, category, amount, vat_mode, period, day_of_month, start_date, end_date, account_id } = req.body
    // start_date 는 NOT NULL 이라 없으면 SQL 오류(500)가 난다. 원인을 알려주는 400으로 바꾼다.
    if (!start_date) return res.status(400).json({ error: '시작일을 선택해주세요' })
    if (!(Number(amount) > 0)) return res.status(400).json({ error: '금액을 입력해주세요' })
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO recurring_expenses (id, vendor_id, contract_id, category, amount, vat_mode, period, day_of_month, start_date, end_date, account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, vendor_id||null, contract_id||null, category||'', amount, vat_mode||null, period||'monthly', day_of_month||1, start_date, end_date||null, account_id||null]
    )
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { vendor_id, contract_id, category, amount, vat_mode, period, day_of_month, start_date, end_date, account_id } = req.body
    const [result] = await req.db.execute(
      'UPDATE recurring_expenses SET vendor_id=?, contract_id=?, category=?, amount=?, vat_mode=?, period=?, day_of_month=?, start_date=?, end_date=?, account_id=? WHERE id=?',
      [vendor_id||null, contract_id||null, category||'', amount, vat_mode||null, period||'monthly', day_of_month||1, start_date, end_date||null, account_id||null, req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/**
 * 정기지출 삭제 — '앞으로 자동 생성하지 않는다'는 뜻이다.
 *
 * 이미 만들어진 청구서·거래는 **지우지 않는다**. 그건 실제로 오간 돈의 기록이라,
 * 자동 생성 규칙을 지운다고 함께 사라지면 장부에 구멍이 난다.
 * (transactions·invoices 의 recurring_id 는 '어디서 생성됐는지' 추적용이고 FK 가 없다.
 *  가리키던 규칙이 사라져도 금액·집계에는 영향이 없다.)
 *
 * 지금까지는 삭제 자체가 없어서, 잘못 만든 정기지출을 끄는 것 말고는 방법이 없었다.
 * 게다가 계약 삭제가 정기 건수를 세어 막는 탓에 계약도 못 지우는 막다른 골목이 됐다.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const [[rec]] = await req.db.execute('SELECT id FROM recurring_expenses WHERE id = ?', [req.params.id])
    if (!rec) return res.status(404).json({ error: 'Not found' })
    // 남게 될 기록을 세어 알려준다 — 사용자가 '같이 지워지는 것 아닌가' 걱정하지 않도록.
    const [[kept]] = await req.db.execute(
      `SELECT (SELECT COUNT(*) FROM invoices     WHERE recurring_id = ?) AS invs,
              (SELECT COUNT(*) FROM transactions WHERE recurring_id = ?) AS txns`,
      [req.params.id, req.params.id])
    await req.db.execute('DELETE FROM recurring_expenses WHERE id = ?', [req.params.id])
    res.json({ ok: true, keptInvoices: Number(kept.invs) || 0, keptTxns: Number(kept.txns) || 0 })
  } catch (e) { next(e) }
})

router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT active FROM recurring_expenses WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const newActive = rows[0].active ? 0 : 1
    await req.db.execute('UPDATE recurring_expenses SET active = ? WHERE id = ?', [newActive, req.params.id])
    res.json({ active: !!newActive })
  } catch (e) { next(e) }
})

// 지급 예정 회차(아직 매입 청구서 미생성) — 매입 대금청구서 '지급 예정' 목록에 계약 지급일정과 함께 뜬다.
// 매출의 정기청구 pending과 완전 대칭. 경리가 매입 청구서 메뉴 한 곳에서 이번 달 낼 걸 다 본다.
router.get('/pending', async (req, res, next) => {
  try {
    const [recs] = await req.db.execute(`
      SELECT r.*, UNIX_TIMESTAMP(r.created_at) AS created_epoch,
             v.name AS vendor_name, c.name AS contract_name, c.contract_no, cat.vat AS cat_vat
      FROM recurring_expenses r
      LEFT JOIN vendors v    ON r.vendor_id = v.id
      LEFT JOIN contracts c  ON r.contract_id = c.id
      LEFT JOIN categories cat ON r.category = cat.name
      WHERE r.active = 1`)
    const today = kstToday()
    const out = []
    for (const r of recs) {
      r.setup_date = kstDate(Number(r.created_epoch) * 1000)   // 등록일(KST) — 소급 하한
      for (const due of dueDatesToGenerate(r, today, { horizonDays: LOOKAHEAD_DAYS })) {
        const { supply, vat } = expenseVat(r.amount, r.vat_mode, r.cat_vat)
        out.push(pendingCycle(r, due, today, {
          source: 'recurring-expense',
          type: '정기지출',
          item: r.category || '',
          amount: supply,
          vat,
          // 계약 이름이 없으면 비목으로 대신 표시(계약 무관 정기지출)
          contract_name: r.contract_name || r.category || '',
        }))
      }
    }
    out.sort((a, b) => a.due_date.localeCompare(b.due_date))
    res.json(out)
  } catch (e) { next(e) }
})

/**
 * 정기지출 회차 1건 → 매입 청구서(+ paid면 지급 거래·매칭).
 * 건별 등록(/:id/issue)과 일괄 등록(/issue-missed)이 같은 코드를 쓰게 떼어냈다 —
 * 두 벌로 두면 한쪽만 고쳐져서 금액·상태가 조용히 달라진다.
 * 호출 전 검사(회차 순서·미래일자·마감)는 라우트가 한다.
 */
async function createExpenseInvoice(conn, r, target, { paid = false, accountId = null } = {}) {
  const { supply, vat, tax_type } = expenseVat(r.amount, r.vat_mode, r.cat_vat)
  const total = supply + vat
  // 금액 없는 정기지출이 매달 0원 매입 청구서를 찍어내면 '지급 대기'만 쌓인다.
  // (호출부는 { error } 를 받아 그대로 사용자에게 돌려준다)
  { const ae = amountError(total); if (ae) return { error: ae } }
  const year = target.slice(0, 4)
  const [[{ maxno }]] = await conn.execute(
    "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind='received' AND invoice_no LIKE ?",
    [`매입-${year}-%`])
  const invoice_no = `매입-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
  let acctId = accountId || r.account_id || null
  if (paid && !acctId) {
    const [[defBank]] = await conn.execute("SELECT id FROM accounts WHERE kind='bank' ORDER BY created_at LIMIT 1")
    acctId = defBank ? defBank.id : null
  }
  const invId = randomUUID()
  await conn.execute(
    'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, recurring_id, memo, tax_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [invId, invoice_no, 'received', r.vendor_id || null, r.contract_id || null, supply, vat, total,
     target, addDays(target, 30), paid ? '지급 완료' : '지급 대기', acctId, r.id,
     `정기지출 · ${r.category || ''}`.trim(), tax_type]
  )
  if (paid) {
    const lerr = ledgerError({ kind: 'expense', account_id: acctId, status: '지급완료' })
    if (lerr) return { error: lerr }
    const txnId = randomUUID()
    // 계약에 걸린 정기지출이면 그 계약(매입)에 귀속(contract_id)
    await conn.execute(
      `INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, category, amount, date, method, status, doc_no, invoice_id, memo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [txnId, 'expense', r.vendor_id || null, r.contract_id || null, acctId,
       r.category || '대금 지급', total, target, '계좌이체', '지급완료', '', invId, `청구서 ${invoice_no} 정산`])
    await conn.execute('INSERT INTO invoice_matches (id, invoice_id, txn_id, amount, txn_created) VALUES (?,?,?,?,1)',
      [randomUUID(), invId, txnId, total])
  }
  await conn.execute('UPDATE recurring_expenses SET last_generated = ? WHERE id = ?', [target, r.id])
  return { invId, invoice_no, total }
}

/**
 * 놓친 회차 일괄 등록 — 예정일이 지났는데 청구서가 없는 회차를 모두 '지급 대기'로 만든다.
 *
 * 미래 회차는 대상이 아니고(미지급금 조기 부풀림 방지), 소급 범위는 등록일(setup_date)부터다 —
 * 2020년 시작 계약을 올해 등록해도 등록일 이전 회차는 만들어지지 않는다(dueDatesToGenerate의 하한).
 * 계좌는 건드리지 않는다(paid=false) — 실제 이체를 확인하지 않은 채 잔액을 움직이지 않기 위해.
 * 지급 처리는 회차별 '기지급 처리'에서 계좌·날짜를 정해 한다. (매출 /issue-missed와 대칭)
 */
router.post('/issue-missed', async (req, res, next) => {
  const today = kstToday()
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    // FOR UPDATE — 같은 일괄이 두 번 겹쳐 실행되면(빠른 재클릭·두 탭) 양쪽이 같은 last_generated를
    // 읽어 같은 회차를 두 벌 만든다. 건별 issue와 같은 잠금을 쓴다.
    const [recs] = await conn.execute(
      `SELECT r.*, UNIX_TIMESTAMP(r.created_at) AS created_epoch, cat.vat AS cat_vat
       FROM recurring_expenses r LEFT JOIN categories cat ON r.category = cat.name
       WHERE r.active = 1 FOR UPDATE`)
    const generated = []
    for (const r of recs) {
      r.setup_date = kstDate(Number(r.created_epoch) * 1000)
      for (const due of dueDatesToGenerate(r, today)) {   // horizon 없음 = 오늘까지만
        /* 마감된 달이 하나라도 섞이면 전체를 거절한다.
         * 예전엔 일괄 경로에만 마감 검사가 없어, 신고를 끝낸 달로 매입 청구서가 새로 꽂혔다
         * → 그 분기 매입세액이 신고 후에 늘어난다. 회차는 순서를 건너뛸 수 없으므로
         *   일부만 처리하면 남은 회차를 영영 못 넣는다 → 전체 거절이 맞다. */
        const ce = await closedPeriodError(conn, due)
        if (ce) {
          await rollbackQuietly(conn)
          return res.status(409).json({ error: `${due} 회차가 마감된 달이라 전체를 처리하지 않았어요. ${ce}` })
        }
        const made = await createExpenseInvoice(conn, r, due)
        generated.push({ id: made.invId, invoice_no: made.invoice_no, date: due, total: made.total })
      }
    }
    await conn.commit()
    res.json({ ok: true, count: generated.length, generated })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// 정기지출 회차 1건을 매입 청구서(미지급금)로 등록. 매출 정기청구 issue와 대칭.
// paid=true면 실제 지급 거래 + 매칭까지(계좌 잔액·미지급 반영).
router.post('/:id/issue', async (req, res, next) => {
  const { due, paid, account_id } = req.body
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[r]] = await conn.execute(
      `SELECT r.*, UNIX_TIMESTAMP(r.created_at) AS created_epoch, cat.vat AS cat_vat
       FROM recurring_expenses r LEFT JOIN categories cat ON r.category = cat.name
       WHERE r.id = ? FOR UPDATE`, [req.params.id])
    if (!r) { await rollbackQuietly(conn); return res.status(404).json({ error: '정기지출을 찾을 수 없어요' }) }
    r.setup_date = kstDate(Number(r.created_epoch) * 1000)
    const dues = dueDatesToGenerate(r, kstToday(), { horizonDays: LOOKAHEAD_DAYS })
    if (dues.length === 0) { await rollbackQuietly(conn); return res.status(409).json({ error: '등록할 회차가 없어요' }) }
    const target = due || dues[0]
    // 앞선 회차를 건너뛰면 last_generated 때문에 그 앞이 영영 안 뜬다 → 가장 이른 미생성 회차만 허용
    if (target !== dues[0]) { await rollbackQuietly(conn); return res.status(409).json({ error: `앞선 회차(${dues[0]})부터 등록해주세요` }) }
    // 기지급(paid)은 실제 지급 거래가 생기므로 미래 일자 금지 + 마감 검사
    if (paid) {
      const de = futureDateError(target); if (de) { await rollbackQuietly(conn); return res.status(400).json({ error: de }) }
      const ce = await closedPeriodError(conn, target); if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
    }

    const made = await createExpenseInvoice(conn, r, target, { paid, accountId: account_id })
    if (made.error) { await rollbackQuietly(conn); return res.status(400).json({ error: made.error }) }
    await conn.commit()
    res.json({ ok: true, id: made.invId, invoice_no: made.invoice_no })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/* (제거) POST /generate — 옛 배치 생성.
 * 청구서를 건너뛰고 '지급 대기' 거래를 바로 만들어 미지급금 추적에서 빠졌고,
 * 등록일 하한(setup_date)을 안 걸어서 소급 방지도 적용되지 않았다. 호출자도 없었다.
 * 대체: POST /issue-missed (청구서로 만들고, 등록일 이후 회차만). */

module.exports = router
