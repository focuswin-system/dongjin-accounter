const { Router } = require('express')

const router = Router()

/* 첫 세팅 진행 상황.
 *
 * 왜 필요한가: 기준정보가 비어 있으면 자동채움이 안 되고, 자동채움이 안 되면 손입력이
 * 늘고, 그러면 안 쓰게 된다. 그런데 지금은 **무엇을 채워야 그게 켜지는지** 알 방법이 없다.
 * (실제로 회사 정보가 비어 거래명세서 공급자가 '—'로 나오고, 품목 매입가가 0이라
 *  결의서 단가가 안 채워지는 일이 있었다.)
 *
 * 숫자만 센다 — 내용은 보지 않는다.
 */
router.get('/status', async (req, res, next) => {
  try {
    const one = async (sql, params = []) => {
      const [[r]] = await req.db.execute(sql, params)
      return Number(Object.values(r)[0]) || 0
    }
    /* 회사 정보는 '행이 있나'가 아니라 **사업자번호가 있나**로 본다.
       빈 행만 만들어두고 넘어가면 세금계산서·거래명세서에 우리 정보가 안 찍힌다. */
    const [company, accounts, vendors, items, recurring, txns, invoices] = await Promise.all([
      one("SELECT COUNT(*) FROM company_info WHERE biz_no IS NOT NULL AND biz_no <> ''"),
      one('SELECT COUNT(*) FROM accounts'),
      one('SELECT COUNT(*) FROM vendors WHERE active = 1'),
      one("SELECT COUNT(*) FROM ref_items WHERE type = 'item'"),
      one('SELECT COUNT(*) FROM recurring_invoices WHERE active = 1'),
      one('SELECT COUNT(*) FROM transactions'),
      one('SELECT COUNT(*) FROM invoices'),
    ])
    res.json({ company, accounts, vendors, items, recurring, txns, invoices })
  } catch (e) { next(e) }
})

module.exports = router
