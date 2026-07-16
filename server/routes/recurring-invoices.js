const { Router } = require('express')
const { randomUUID } = require('crypto')
const { pool } = require('../db')
const { dueDatesToGenerate, fmtDate } = require('../lib/recurrence')

const router = Router()

router.get('/', async (_, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT r.*, v.name AS vendor_name, c.name AS contract_name
      FROM recurring_invoices r
      LEFT JOIN vendors v   ON r.vendor_id = v.id
      LEFT JOIN contracts c ON r.contract_id = c.id
      ORDER BY r.day_of_month
    `)
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { vendor_id, contract_id, item, supply_amount, vat_mode, period, day_of_month, start_date, end_date, account_id } = req.body
    const id = randomUUID()
    await pool.execute(
      'INSERT INTO recurring_invoices (id, vendor_id, contract_id, item, supply_amount, vat_mode, period, day_of_month, start_date, end_date, account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, vendor_id||null, contract_id||null, item||'', supply_amount, vat_mode||'exclusive', period||'monthly', day_of_month||1, start_date, end_date||null, account_id||null]
    )
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { vendor_id, contract_id, item, supply_amount, vat_mode, period, day_of_month, start_date, end_date, account_id } = req.body
    const [result] = await pool.execute(
      'UPDATE recurring_invoices SET vendor_id=?, contract_id=?, item=?, supply_amount=?, vat_mode=?, period=?, day_of_month=?, start_date=?, end_date=?, account_id=? WHERE id=?',
      [vendor_id||null, contract_id||null, item||'', supply_amount, vat_mode||'exclusive', period||'monthly', day_of_month||1, start_date, end_date||null, account_id||null, req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT active FROM recurring_invoices WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const newActive = rows[0].active ? 0 : 1
    await pool.execute('UPDATE recurring_invoices SET active = ? WHERE id = ?', [newActive, req.params.id])
    res.json({ active: !!newActive })
  } catch (e) { next(e) }
})

// 청구 예정 회차(아직 청구서가 안 만들어진 회차) — 대금청구 '발행 예정' 목록에 계약 청구일정과 함께 뜬다.
// 경리가 청구서 메뉴 한 곳만 열면 이번 달 청구할 게 다 보이게 하기 위함.
router.get('/pending', async (_, res, next) => {
  try {
    const [recs] = await pool.execute(`
      SELECT r.*, v.name AS vendor_name, c.name AS contract_name, c.contract_no
      FROM recurring_invoices r
      LEFT JOIN vendors v   ON r.vendor_id = v.id
      LEFT JOIN contracts c ON r.contract_id = c.id
      WHERE r.active = 1`)
    const today = new Date()
    const out = []
    for (const r of recs) {
      for (const due of dueDatesToGenerate(r, today)) {
        const supply = Number(r.supply_amount)
        const vat = r.vat_mode === 'none' ? 0 : Math.round(supply * 0.1)
        out.push({
          source: 'recurring',
          recurring_id: r.id,
          due_date: due,
          vendor_id: r.vendor_id,
          vendor_name: r.vendor_name || '',
          contract_name: r.contract_name || r.item || '',
          contract_no: r.contract_no || '',
          type: '정기청구',
          item: r.item || '',
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

// 정기청구 회차 1건만 발행 (발행 예정 목록에서 건별로 누르는 경우).
// 앞선 회차를 건너뛰고 발행하면 last_generated 때문에 그 앞 회차가 영영 안 뜨므로,
// 가장 이른 미생성 회차만 발행하도록 제한한다.
router.post('/:id/issue', async (req, res, next) => {
  const { due, paid } = req.body
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [[r]] = await conn.execute('SELECT * FROM recurring_invoices WHERE id = ? FOR UPDATE', [req.params.id])
    if (!r) { await conn.rollback(); return res.status(404).json({ error: '정기청구를 찾을 수 없어요' }) }
    const dues = dueDatesToGenerate(r, new Date())
    if (dues.length === 0) { await conn.rollback(); return res.status(409).json({ error: '발행할 회차가 없어요' }) }
    const target = due || dues[0]
    if (target !== dues[0]) {
      await conn.rollback()
      return res.status(409).json({ error: `앞선 회차(${dues[0]})부터 발행해주세요` })
    }

    const year = target.slice(0, 4)
    const [[{ maxno }]] = await conn.execute(
      "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind='issued' AND invoice_no LIKE ?",
      [`청구-${year}-%`]
    )
    const invoice_no = `청구-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    const supply = Number(r.supply_amount)
    const vat    = r.vat_mode === 'none' ? 0 : Math.round(supply * 0.1)
    const total  = supply + vat
    const id = randomUUID()
    await conn.execute(
      'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, invoice_no, 'issued', r.vendor_id || null, r.contract_id || null, supply, vat, total,
       target, addDaysStr(target, 30), paid ? '입금 완료' : '입금 예정', r.account_id || null,
       `정기청구 · ${r.item || ''}`.trim()]
    )
    // 기입금 처리: 실제 입금 거래 + 매칭까지 (계약 상세의 수금·미수금에 반영)
    if (paid) {
      const txnId = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, category, amount, date, method, status, buyer_type, doc_no, invoice_id, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txnId, 'income', r.vendor_id || null, r.contract_id || null, r.account_id || null,
         '수금', total, target, '계좌이체', '입금완료', '공통', '', id, `청구서 ${invoice_no} 정산`]
      )
      await conn.execute('INSERT INTO invoice_matches (id, invoice_id, txn_id, amount) VALUES (?,?,?,?)',
        [randomUUID(), id, txnId, total])
    }
    await conn.execute('UPDATE recurring_invoices SET last_generated = ? WHERE id = ?', [target, r.id])
    await conn.commit()
    res.json({ ok: true, id, invoice_no })
  } catch (e) { await conn.rollback(); next(e) }
  finally { conn.release() }
})

// 대기 항목 생성: 활성 정기청구 → 미생성 회차마다 '입금 예정' 청구서(미수) 생성.
// 지출과 달리 놓친 회차(예: 몇 달 밀린 유지보수)는 모두 소급 생성한다.
router.post('/generate', async (_, res, next) => {
  const today = new Date()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [recs] = await conn.execute('SELECT * FROM recurring_invoices WHERE active = 1')
    const generated = []

    for (const r of recs) {
      const dues = dueDatesToGenerate(r, today)
      if (!dues.length) continue

      for (const dueStr of dues) {
        const year = dueStr.slice(0, 4)
        // 채번: 최대 일련번호+1 (issue/수동 발행과 동일 방식 — 삭제 후 번호 재사용/중복 방지)
        const [[{ maxno }]] = await conn.execute(
          "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind='issued' AND invoice_no LIKE ?",
          [`청구-${year}-%`]
        )
        const invoice_no = `청구-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
        const supply = Number(r.supply_amount)
        const vat    = r.vat_mode === 'none' ? 0 : Math.round(supply * 0.1)
        const total  = supply + vat
        const dueAt  = addDaysStr(dueStr, 30)
        const id = randomUUID()
        await conn.execute(
          'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, invoice_no, 'issued', r.vendor_id||null, r.contract_id||null, supply, vat, total, dueStr, dueAt, '입금 예정', r.account_id||null, `정기청구 자동 생성 · ${r.item||''}`.trim()]
        )
        generated.push({ id, invoice_no, vendor_id: r.vendor_id, item: r.item, total, date: dueStr })
      }
      await conn.execute('UPDATE recurring_invoices SET last_generated = ? WHERE id = ?', [dues[dues.length - 1], r.id])
    }

    await conn.commit()
    res.json({ generated, count: generated.length })
  } catch (e) {
    await conn.rollback()
    next(e)
  } finally {
    conn.release()
  }
})

// 반복일 계산은 ../lib/recurrence 의 dueDatesToGenerate 로 공용화(월말 clamp·period 정확).

function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return fmtDate(new Date(y, m - 1, d + days))
}

module.exports = router
