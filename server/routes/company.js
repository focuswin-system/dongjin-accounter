const { Router } = require('express')

const router = Router()
const COMPANY_ID = 'main' // 자사 정보는 단일 레코드

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM company_info WHERE id = ?', [COMPANY_ID])
    res.json(rows[0] || null)
  } catch (e) { next(e) }
})

router.put('/', async (req, res, next) => {
  try {
    const { name, biz_no, ceo, biz_type, biz_item, address, phone, fax, email, main_account,
            closing_day, week_start_day } = req.body
    await req.db.execute(
      `INSERT INTO company_info
         (id, name, biz_no, ceo, biz_type, biz_item, address, phone, fax, email, main_account, closing_day, week_start_day)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name), biz_no=VALUES(biz_no), ceo=VALUES(ceo),
         biz_type=VALUES(biz_type), biz_item=VALUES(biz_item), address=VALUES(address),
         phone=VALUES(phone), fax=VALUES(fax), email=VALUES(email),
         main_account=VALUES(main_account),
         closing_day=VALUES(closing_day), week_start_day=VALUES(week_start_day), updated_at=NOW()`,
      [COMPANY_ID, name||'', biz_no||'', ceo||'', biz_type||'', biz_item||'',
       address||'', phone||'', fax||'', email||'', main_account||'',
       // 0~28 만 받는다 — 29~31 은 짧은 달에 존재하지 않아 그 달만 조용히 어긋난다
       Math.min(28, Math.max(0, parseInt(closing_day, 10) || 0)),
       Math.min(6, Math.max(0, parseInt(week_start_day, 10) || 0))]
    )
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
