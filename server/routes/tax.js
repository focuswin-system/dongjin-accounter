const { Router } = require('express')
const { randomUUID } = require('crypto')
const { pool } = require('../db')

const router = Router()

// 부가세 분기별 집계 (매출세액 − 매입세액) + 신고 상태
router.get('/vat', async (req, res, next) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear()
    const [agg] = await pool.execute(
      `SELECT QUARTER(issued_at) AS q,
              SUM(CASE WHEN kind='issued'   THEN vat_amount ELSE 0 END) AS sales_vat,
              SUM(CASE WHEN kind='received' THEN vat_amount ELSE 0 END) AS purchase_vat
       FROM invoices
       WHERE YEAR(issued_at) = ?
       GROUP BY QUARTER(issued_at)`,
      [year]
    )
    const [filings] = await pool.execute('SELECT * FROM vat_filings WHERE year = ?', [year])
    const aggBy = Object.fromEntries(agg.map(r => [Number(r.q), r]))
    const fileBy = Object.fromEntries(filings.map(r => [Number(r.quarter), r]))

    const quarters = [1, 2, 3, 4].map(q => {
      const a = aggBy[q] || {}
      const f = fileBy[q] || {}
      const sales_vat = Number(a.sales_vat || 0)
      const purchase_vat = Number(a.purchase_vat || 0)
      return {
        quarter: q,
        sales_vat,
        purchase_vat,
        payable: sales_vat - purchase_vat, // +면 납부세액, −면 환급세액
        status: f.status || '납부 대기',
        paid_amount: Number(f.paid_amount || 0),
        paid_date: f.paid_date || null,
        memo: f.memo || '',
      }
    })
    res.json({ year, quarters })
  } catch (e) { next(e) }
})

// 신고 상태 저장(분기별 upsert)
router.put('/vat', async (req, res, next) => {
  try {
    const { year, quarter, status, paid_amount, paid_date, memo } = req.body
    if (!year || !quarter) return res.status(400).json({ error: 'year·quarter 필수' })
    const [exist] = await pool.execute('SELECT id FROM vat_filings WHERE year=? AND quarter=?', [year, quarter])
    const amount = parseInt(String(paid_amount).replace(/[^0-9-]/g, ''), 10) || 0
    if (exist[0]) {
      await pool.execute(
        'UPDATE vat_filings SET status=?, paid_amount=?, paid_date=?, memo=? WHERE id=?',
        [status || '납부 대기', amount, paid_date || null, memo || null, exist[0].id]
      )
    } else {
      await pool.execute(
        'INSERT INTO vat_filings (id, year, quarter, status, paid_amount, paid_date, memo) VALUES (?,?,?,?,?,?,?)',
        [randomUUID(), year, quarter, status || '납부 대기', amount, paid_date || null, memo || null]
      )
    }
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
