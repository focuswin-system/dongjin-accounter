const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday, kstDate } = require('../db')
const { dueDatesToGenerate, addDays, LOOKAHEAD_DAYS } = require('../lib/recurrence')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError } = require('../lib/ledger')
const { closedPeriodError } = require('../lib/closing')

const router = Router()

/* 정기지출의 부가세: 정기지출은 amount(합계 = VAT 포함) 하나만 들고, 세율은 비목(categories.vat)을 따른다.
   비목 vat: '10%'=과세 / '면세' / '영세' / '—'(미설정 → 면세로 본다). 매출의 vat_mode와 짝. */
const expenseVat = (total, catVat) => {
  const t = Number(total) || 0
  if (catVat === '10%') { const supply = Math.round(t / 1.1); return { supply, vat: t - supply, tax_type: '과세' } }
  if (catVat === '영세') return { supply: t, vat: 0, tax_type: '영세' }
  return { supply: t, vat: 0, tax_type: '면세' }   // 면세·—·기타
}

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
    const { vendor_id, contract_id, category, amount, period, day_of_month, start_date, end_date, account_id } = req.body
    // start_date 는 NOT NULL 이라 없으면 SQL 오류(500)가 난다. 원인을 알려주는 400으로 바꾼다.
    if (!start_date) return res.status(400).json({ error: '시작일을 선택해주세요' })
    if (!(Number(amount) > 0)) return res.status(400).json({ error: '금액을 입력해주세요' })
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO recurring_expenses (id, vendor_id, contract_id, category, amount, period, day_of_month, start_date, end_date, account_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, vendor_id||null, contract_id||null, category||'', amount, period||'monthly', day_of_month||1, start_date, end_date||null, account_id||null]
    )
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { vendor_id, contract_id, category, amount, period, day_of_month, start_date, end_date, account_id } = req.body
    const [result] = await req.db.execute(
      'UPDATE recurring_expenses SET vendor_id=?, contract_id=?, category=?, amount=?, period=?, day_of_month=?, start_date=?, end_date=?, account_id=? WHERE id=?',
      [vendor_id||null, contract_id||null, category||'', amount, period||'monthly', day_of_month||1, start_date, end_date||null, account_id||null, req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
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
        const { supply, vat } = expenseVat(r.amount, r.cat_vat)
        out.push({
          source: 'recurring-expense',
          recurring_id: r.id,
          due_date: due,
          vendor_id: r.vendor_id,
          vendor_name: r.vendor_name || '',
          contract_name: r.contract_name || r.category || '',
          contract_no: r.contract_no || '',
          type: '정기지출',
          item: r.category || '',
          amount: supply,
          vat,
          period: r.period,
        })
      }
    }
    out.sort((a, b) => a.due_date.localeCompare(b.due_date))
    res.json(out)
  } catch (e) { next(e) }
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

    const { supply, vat, tax_type } = expenseVat(r.amount, r.cat_vat)
    const total = supply + vat
    const year = target.slice(0, 4)
    const [[{ maxno }]] = await conn.execute(
      "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind='received' AND invoice_no LIKE ?",
      [`매입-${year}-%`])
    const invoice_no = `매입-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    let acctId = account_id || r.account_id || null
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
      if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: lerr }) }
      const txnId = randomUUID()
      // 계약에 걸린 정기지출이면 그 계약(매입)에 귀속(contract_id)
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, category, amount, date, method, status, doc_no, invoice_id, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txnId, 'expense', r.vendor_id || null, r.contract_id || null, acctId,
         r.category || '대금 지급', total, target, '계좌이체', '지급완료', '', invId, `청구서 ${invoice_no} 정산`])
      await conn.execute('INSERT INTO invoice_matches (id, invoice_id, txn_id, amount) VALUES (?,?,?,?)',
        [randomUUID(), invId, txnId, total])
    }
    await conn.execute('UPDATE recurring_expenses SET last_generated = ? WHERE id = ?', [target, r.id])
    await conn.commit()
    res.json({ ok: true, id: invId, invoice_no })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// (구) 배치 생성 — pending/issue로 대체됨. 호출자 없음. 지급 대기 거래를 직접 만들던 방식이라
// 미지급금 추적을 건너뛰었다. 하위호환 위해 남겨두되 새 흐름은 위 pending/issue를 쓴다.
router.post('/generate', async (req, res, next) => {
  const today = kstToday()
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [recurrings] = await conn.execute('SELECT * FROM recurring_expenses WHERE active = 1')
    const generated = []

    for (const r of recurrings) {
      // 정기지출은 소급 생성하지 않는다(과거 지급대기 홍수 방지) — 가장 최근 미생성 회차 1건만.
      // period(월/분기/연)·월말일은 공용 dueDatesToGenerate가 정확히 반영한다.
      const dues = dueDatesToGenerate(r, today)
      if (!dues.length) continue
      const target = dues[dues.length - 1]
      const id = randomUUID()
      // kind를 안 넣으면 NULL로 들어가 지출 목록·계약 원가 어디에도 안 잡힌다(돈이 조용히 샌다).
      // 계약에 걸린 정기지출이면 그 계약(매입)에 귀속시킨다.
      await conn.execute(
        'INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, category, amount, date, method, status, recurring_id, memo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, 'expense', r.vendor_id||null, r.contract_id||null, r.account_id||null, r.category, r.amount, target, '계좌이체', '지급 대기', r.id, '정기 지출 자동 생성']
      )
      await conn.execute('UPDATE recurring_expenses SET last_generated = ? WHERE id = ?', [target, r.id])
      generated.push({ id, vendor_id: r.vendor_id, category: r.category, amount: r.amount, date: target })
    }

    await conn.commit()
    res.json({ generated, count: generated.length })
  } catch (e) {
    await rollbackQuietly(conn)
    next(e)
  } finally {
    conn.release()
  }
})

module.exports = router
