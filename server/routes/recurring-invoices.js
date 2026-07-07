const { Router } = require('express')
const { randomUUID } = require('crypto')
const { pool } = require('../db')

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
        const [[{ cnt }]] = await conn.execute(
          "SELECT COUNT(*) AS cnt FROM invoices WHERE kind='issued' AND issued_at LIKE ?",
          [`${year}%`]
        )
        const invoice_no = `청구-${year}-${String(Number(cnt) + 1).padStart(4, '0')}`
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

// start_date 앵커에서 period 간격으로 밟아 today까지의 미생성 회차 날짜 목록
function dueDatesToGenerate(r, today) {
  if (!r.start_date) return []
  const stepMonths = r.period === 'yearly' ? 12 : r.period === 'quarterly' ? 3 : 1
  const [sy, sm] = r.start_date.split('-').map(Number)
  const day = Number(r.day_of_month) || Number(r.start_date.split('-')[2]) || 1
  const todayStr = fmtDate(today)
  const floor = r.last_generated || ''  // 이 값 이하(포함)는 이미 생성됨
  const out = []
  let d = new Date(sy, sm - 1, day)
  let guard = 0
  while (guard++ < 600) {
    const ds = fmtDate(d)
    if (ds > todayStr) break
    if (r.end_date && ds > r.end_date) break
    if (ds >= r.start_date && ds > floor) out.push(ds)
    d = new Date(d.getFullYear(), d.getMonth() + stepMonths, day)
  }
  return out
}

function fmtDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDaysStr(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return fmtDate(new Date(y, m - 1, d + days))
}

module.exports = router
