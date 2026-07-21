const { Router } = require('express')
const { kstDate } = require('../db')

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    // KST 기준 — 다른 화면(청구·미수/미지급)이 전부 KST라 UTC를 쓰면 자정 근처에 연체/도래 판정이 어긋난다.
    const today = kstDate(Date.now())
    const sevenDays = kstDate(Date.now() + 7 * 86400000)

    // 계좌 잔액
    const [accountRows] = await req.db.execute('SELECT * FROM accounts')
    const accountBalances = await Promise.all(accountRows.map(async a => {
      const [rows] = await req.db.execute(`
        SELECT
          a.initial_balance,
          COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='income'  AND account_id=a.id), 0) AS inc,
          COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='expense' AND account_id=a.id AND status='지급완료'), 0) AS exp,
          COALESCE((SELECT SUM(amount) FROM account_adjustments WHERE account_id=a.id), 0) AS adj
        FROM accounts a WHERE a.id = ?
      `, [a.id])
      const r = rows[0]
      return { ...a, balance: Number(r.initial_balance) + Number(r.inc) - Number(r.exp) + Number(r.adj) }
    }))

    // 미수금
    const [receivables] = await req.db.execute("SELECT * FROM invoices WHERE kind='issued' AND status NOT IN ('입금 완료')")
    let receivableTotal = 0
    for (const r of receivables) {
      const [mRows] = await req.db.execute('SELECT COALESCE(SUM(amount),0) AS t FROM invoice_matches WHERE invoice_id=?', [r.id])
      receivableTotal += Number(r.total_amount) - Number(mRows[0].t)
    }

    // 미지급금
    const [payables] = await req.db.execute("SELECT * FROM invoices WHERE kind='received' AND status NOT IN ('지급 완료')")
    let payableTotal = 0
    for (const r of payables) {
      const [mRows] = await req.db.execute('SELECT COALESCE(SUM(amount),0) AS t FROM invoice_matches WHERE invoice_id=?', [r.id])
      payableTotal += Number(r.total_amount) - Number(mRows[0].t)
    }

    // 7일 내 입금 예정
    const [upcomingIncome] = await req.db.execute(`
      SELECT i.*, v.name AS vendor_name FROM invoices i
      LEFT JOIN vendors v ON i.vendor_id = v.id
      WHERE i.kind='issued' AND i.due_at BETWEEN ? AND ? AND i.status IN ('입금 예정','일부 입금')
      ORDER BY i.due_at
    `, [today, sevenDays])

    // 대기 중 정기 지출
    const [pendingRecurring] = await req.db.execute(`
      SELECT t.*, v.name AS vendor_name FROM transactions t
      LEFT JOIN vendors v ON t.vendor_id = v.id
      WHERE t.status='지급 대기' AND t.recurring_id IS NOT NULL
      ORDER BY t.date
    `)

    // 연체 청구서
    const [overdueInvoices] = await req.db.execute(`
      SELECT i.*, v.name AS vendor_name FROM invoices i
      LEFT JOIN vendors v ON i.vendor_id = v.id
      WHERE i.due_at < ? AND i.status IN ('입금 예정','일부 입금','지급 대기','지급 예정')
      ORDER BY i.due_at
    `, [today])

    res.json({ accountBalances, receivableTotal, payableTotal, upcomingIncome, pendingRecurring, overdueInvoices })
  } catch (e) { next(e) }
})

module.exports = router
