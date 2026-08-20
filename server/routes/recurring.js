const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday, kstDate } = require('../db')
const { dueDatesToGenerate, LOOKAHEAD_DAYS, pendingCycle, cashDateOf, PAY_TERMS, PAY_TERMS_WITH_DAY } = require('../lib/recurrence')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError, amountError } = require('../lib/ledger')
const { closedPeriodError } = require('../lib/closing')
const { recurFromTotal, modeFromCatVat } = require('../lib/vat')
/* ⚠ 이 import 가 없어서 기입금(paid) 지출 발행이 ReferenceError → 500 이었다.
   호출은 조건부(paid 일 때만)라 평소 경로에서는 드러나지 않았다. 같은 실수가
   recurring-invoices.js 에도 있었다. 재발 방지는 scripts/check-isolation.js [13]. */
const { settleAcctCode } = require('../lib/acctCode')
const { backfillCycles, tooManyError, addSkip, removeSkip, issuedInvoiceAt } = require('../lib/backfill')

const router = Router()

/** 결제조건은 정해진 셋 중 하나만 받는다 — 모르는 값이 들어오면 날짜 계산이 조용히 어긋난다 */
const payTermOf = (v) => (PAY_TERMS.includes(v) ? v : 'net30')
/* 'N일'을 쓰는 조건에서만 값을 남긴다 — 조건을 바꿔도 옛 N 이 붙어 다니면
   나중에 그 조건으로 되돌렸을 때 예전 날짜가 되살아난다. */
const payDayFor = (term, v) => (PAY_TERMS_WITH_DAY.includes(term) ? Math.min(Math.max(parseInt(v, 10) || 1, 1), 31) : 0)
/* 수정에서 pay_term 을 **안 보냈으면 기존 값을 유지**한다.
   payTermOf(undefined) 가 'net30' 이라, 부분 바디로 수정하면 저장해 둔 '당일 출금'이
   말없이 30일 뒤로 되돌아갔다 — 이 핸들러가 고치려던 결함과 같은 종류가 반대 방향으로 열려 있었다. */
const payTermFor = (v, cur) => (v == null || v === '' ? (cur || 'net30') : payTermOf(v))

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
      'INSERT INTO recurring_expenses (id, vendor_id, contract_id, category, amount, vat_mode, period, day_of_month, start_date, end_date, account_id, pay_term, pay_day) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, vendor_id||null, contract_id||null, category||'', amount, vat_mode||null, period||'monthly', day_of_month||1, start_date, end_date||null, account_id||null, payTermOf(req.body.pay_term), payDayFor(payTermOf(req.body.pay_term), req.body.pay_day)]
    )
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { vendor_id, contract_id, category, amount, vat_mode, period, day_of_month, start_date, end_date, account_id } = req.body
    const [[cur]] = await req.db.execute('SELECT pay_term, pay_day FROM recurring_expenses WHERE id = ?', [req.params.id])
    if (!cur) return res.status(404).json({ error: 'Not found' })
    const [result] = await req.db.execute(
      'UPDATE recurring_expenses SET vendor_id=?, contract_id=?, category=?, amount=?, vat_mode=?, period=?, day_of_month=?, start_date=?, end_date=?, account_id=?, pay_term=?, pay_day=? WHERE id=?',
      [vendor_id||null, contract_id||null, category||'', amount, vat_mode||null, period||'monthly', day_of_month||1, start_date, end_date||null, account_id||null, payTermFor(req.body.pay_term, cur.pay_term),
       payDayFor(payTermFor(req.body.pay_term, cur.pay_term), req.body.pay_day ?? cur.pay_day), req.params.id]
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
 * 게다가 주문 삭제가 정기 건수를 세어 막는 탓에 주문도 못 지우는 막다른 골목이 됐다.
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
    // 건너뛴 기록도 함께(매출 쪽과 같은 이유 — 규칙과 수명을 같이하는 설정값이다)
    await req.db.execute("DELETE FROM recurring_skips WHERE kind = 'expense' AND recurring_id = ?", [req.params.id])
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

// 지급 예정 회차(아직 매입 청구서 미생성) — 매입 대금청구서 '지급 예정' 목록에 주문 지급일정과 함께 뜬다.
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
    // 건너뛴 회차는 계산에서 빼고, 되돌릴 수 있도록 state='skipped'로 함께 실어 보낸다
    const [skipRows] = await req.db.execute(
      "SELECT recurring_id, due_date, reason FROM recurring_skips WHERE kind = 'expense'")
    const skipBy = new Map()
    for (const s of skipRows) {
      if (!skipBy.has(s.recurring_id)) skipBy.set(s.recurring_id, [])
      skipBy.get(s.recurring_id).push(s)
    }
    const out = []
    for (const r of recs) {
      r.setup_date = kstDate(Number(r.created_epoch) * 1000)   // 등록일(KST) — 소급 하한
      r.skips = (skipBy.get(r.id) || []).map(s => String(s.due_date).slice(0, 10))
      for (const due of dueDatesToGenerate(r, today, { horizonDays: LOOKAHEAD_DAYS })) {
        const { supply, vat } = expenseVat(r.amount, r.vat_mode, r.cat_vat)
        out.push(pendingCycle(r, due, today, {
          source: 'recurring-expense',
          type: '정기지출',
          item: r.category || '',
          amount: supply,
          vat,
          // 주문 이름이 없으면 비목으로 대신 표시(주문 무관 정기지출)
          contract_name: r.contract_name || r.category || '',
        }))
      }
      for (const s of (skipBy.get(r.id) || [])) {
        const due = String(s.due_date).slice(0, 10)
        const { supply, vat } = expenseVat(r.amount, r.vat_mode, r.cat_vat)
        out.push({
          ...pendingCycle(r, due, today, {
            source: 'recurring-expense', type: '정기지출', item: r.category || '',
            amount: supply, vat, contract_name: r.contract_name || r.category || '',
            skip_reason: s.reason || '',
          }),
          state: 'skipped',
        })
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
     target, cashDateOf(target, r.pay_term, r.pay_day), paid ? '지급 완료' : '지급 대기', acctId, r.id,
     `정기지출 · ${r.category || ''}`.trim(), tax_type]
  )
  if (paid) {
    const lerr = ledgerError({ kind: 'expense', account_id: acctId, status: '지급완료' })
    if (lerr) return { error: lerr }
    const txnId = randomUUID()
    // 주문에 걸린 정기지출이면 그 주문(매입)에 귀속(contract_id)
    await conn.execute(
      `INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, account_code, category, amount, date, method, status, doc_no, invoice_id, memo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [txnId, 'expense', r.vendor_id || null, r.contract_id || null, acctId,
       settleAcctCode('expense'),   // 외상매입금 — 없으면 일계표 차·대변이 안 맞는다
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
 * 2020년 시작 주문을 올해 등록해도 등록일 이전 회차는 만들어지지 않는다(dueDatesToGenerate의 하한).
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

/* ── 회차 건너뛰기 (매입) ── 매출과 같은 규칙. 배경은 lib/backfill.js 참고. */
router.post('/:id/skip', async (req, res, next) => {
  try {
    const due = String(req.body.due_date || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ error: '건너뛸 회차 날짜가 필요해요' })
    const [[r]] = await req.db.execute('SELECT id FROM recurring_expenses WHERE id = ?', [req.params.id])
    if (!r) return res.status(404).json({ error: '정기지출을 찾을 수 없어요' })
    const inv = await issuedInvoiceAt(req.db, req.params.id, due)
    if (inv) return res.status(409).json({ error: `이 회차는 이미 ${inv.invoice_no}로 등록됐어요. 청구서를 삭제해주세요.` })
    await addSkip(req.db, 'expense', req.params.id, due, req.body.reason)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id/skip/:due', async (req, res, next) => {
  try {
    const n = await removeSkip(req.db, 'expense', req.params.id, req.params.due)
    if (!n) return res.status(404).json({ error: '건너뛴 기록을 찾을 수 없어요' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/* ── 소급 등록 마법사 (매입) ──────────────────────────────────────
 * 매출(recurring-invoices.js)과 같은 규칙. 배경은 lib/backfill.js 참고.
 * 과거 지출은 대부분 이미 돈이 나갔으므로 '기지급'이 기본값이 되도록 화면이 켜서 보낸다.
 */
router.post('/:id/backfill/preview', async (req, res, next) => {
  try {
    const { from, to } = req.body
    if (!from) return res.status(400).json({ error: '소급 시작일을 선택해주세요' })
    const today = kstToday()
    const end = (!to || to > today) ? today : to
    if (from > end) return res.status(400).json({ error: '시작일이 종료일보다 뒤예요' })

    const [[r]] = await req.db.execute(
      `SELECT r.*, v.name AS vendor_name, cat.vat AS cat_vat
       FROM recurring_expenses r LEFT JOIN vendors v ON r.vendor_id = v.id
       LEFT JOIN categories cat ON cat.name = r.category WHERE r.id = ?`, [req.params.id])
    if (!r) return res.status(404).json({ error: '정기지출을 찾을 수 없어요' })

    const dues = backfillCycles(r, from, end)
    const over = tooManyError(dues.length)
    if (over) return res.status(400).json({ error: over, count: dues.length })

    const { supply, vat } = expenseVat(r.amount, r.vat_mode, r.cat_vat)
    const cycles = []
    for (const due of dues) {
      const [[dup]] = await req.db.execute(
        'SELECT id, invoice_no FROM invoices WHERE recurring_id = ? AND issued_at = ? LIMIT 1', [r.id, due])
      const closed = await closedPeriodError(req.db, due)
      cycles.push({
        due_date: due, supply_amount: supply, vat_amount: vat, total_amount: supply + vat,
        exists: !!dup, existing_no: dup ? dup.invoice_no : null,
        closed: !!closed, closed_reason: closed || null,
      })
    }
    res.json({
      item: r.category || '', vendor_name: r.vendor_name || '', from, to: end, cycles,
      selectable: cycles.filter(c => !c.exists && !c.closed).length,
    })
  } catch (e) { next(e) }
})

router.post('/:id/backfill', async (req, res, next) => {
  const cycles = Array.isArray(req.body.cycles) ? req.body.cycles : []
  if (cycles.length === 0) return res.status(400).json({ error: '만들 회차를 선택해주세요' })
  const over = tooManyError(cycles.length)
  if (over) return res.status(400).json({ error: over })

  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[r]] = await conn.execute(
      `SELECT r.*, cat.vat AS cat_vat FROM recurring_expenses r
       LEFT JOIN categories cat ON cat.name = r.category WHERE r.id = ? FOR UPDATE`, [req.params.id])
    if (!r) { await rollbackQuietly(conn); return res.status(404).json({ error: '정기지출을 찾을 수 없어요' }) }

    const batch = randomUUID()
    const today = kstToday()
    const created = []
    for (const c of cycles.slice().sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))) {
      const due = String(c.due_date || '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) { await rollbackQuietly(conn); return res.status(400).json({ error: `회차 날짜가 올바르지 않아요 (${due})` }) }
      if (due > today) { await rollbackQuietly(conn); return res.status(400).json({ error: `${due}는 미래예요. 소급은 과거 회차만 만듭니다.` }) }
      const ce = await closedPeriodError(conn, due)
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: `${due} 회차가 마감된 달이라 아무것도 만들지 않았어요. ${ce}` }) }
      const [[dup]] = await conn.execute(
        'SELECT id FROM invoices WHERE recurring_id = ? AND issued_at = ? LIMIT 1', [r.id, due])
      if (dup) continue

      /* 회차별 금액 수정(임차료 인상 등)을 받는다. createExpenseInvoice 는 규칙 금액으로만
         만들기 때문에 여기서는 amount 를 갈아끼운 사본을 넘긴다. */
      const rowAmount = Number(c.total_amount) > 0 ? Number(c.total_amount) : Number(r.amount)
      const made = await createExpenseInvoice(conn, { ...r, amount: rowAmount }, due,
        { paid: !!c.paid, accountId: c.account_id || null })
      if (made.error) { await rollbackQuietly(conn); return res.status(400).json({ error: `${due} 회차 — ${made.error}` }) }
      // 배치 표식 — 되돌리기가 이 값으로 묶는다
      await conn.execute('UPDATE invoices SET backfill_batch = ?, memo = ? WHERE id = ?',
        [batch, `소급 등록 · ${r.category || ''}`.trim(), made.invId])
      await conn.execute('UPDATE transactions SET backfill_batch = ? WHERE invoice_id = ?', [batch, made.invId])
      created.push({ id: made.invId, invoice_no: made.invoice_no, due_date: due, total: made.total, paid: !!c.paid })
    }

    /* createExpenseInvoice 가 회차마다 last_generated 를 그 날짜로 덮는다. 소급은 과거를
       만드는 일이라, 원래 값이 더 뒤였다면 되돌려 놓아야 한다 — 안 그러면 이미 만들어 둔
       뒤 회차가 '아직 안 만든 것'이 되어 중복 발행된다. */
    const last = created.length ? created[created.length - 1].due_date : null
    const prev = r.last_generated ? String(r.last_generated).slice(0, 10) : null
    if (last && prev && prev > last) {
      await conn.execute('UPDATE recurring_expenses SET last_generated = ? WHERE id = ?', [prev, r.id])
    }
    await conn.commit()
    res.json({ ok: true, batch, count: created.length, created })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.delete('/backfill/:batch', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.execute(
      'SELECT id, invoice_no, issued_at, recurring_id FROM invoices WHERE backfill_batch = ? FOR UPDATE', [req.params.batch])
    if (rows.length === 0) { await rollbackQuietly(conn); return res.status(404).json({ error: '되돌릴 묶음을 찾을 수 없어요' }) }
    for (const inv of rows) {
      const ce = await closedPeriodError(conn, String(inv.issued_at).slice(0, 10))
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: `${inv.invoice_no}(${String(inv.issued_at).slice(0, 10)})가 마감된 달이라 되돌리지 않았어요. ${ce}` }) }
    }
    const recurringId = rows.find(r => r.recurring_id)?.recurring_id || null
    const ids = rows.map(r => r.id)
    const ph = ids.map(() => '?').join(',')
    await conn.execute(`DELETE FROM invoice_matches WHERE invoice_id IN (${ph})`, ids)
    await conn.execute('DELETE FROM transactions WHERE backfill_batch = ?', [req.params.batch])
    await conn.execute(`DELETE FROM invoices WHERE id IN (${ph})`, ids)
    /* 남은 청구서에서 다시 계산한다 — '지운 것 중 가장 이른 날 - 1일'로 낮추면
       그 뒤에 이미 발행된 회차까지 되살아나 중복 지출이 된다(매출 쪽과 같은 이유). */
    if (recurringId) {
      const [[m]] = await conn.execute(
        'SELECT MAX(issued_at) AS last FROM invoices WHERE recurring_id = ?', [recurringId])
      await conn.execute('UPDATE recurring_expenses SET last_generated = ? WHERE id = ?',
        [m && m.last ? String(m.last).slice(0, 10) : null, recurringId])
    }
    await conn.commit()
    res.json({ ok: true, count: rows.length })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

module.exports = router
