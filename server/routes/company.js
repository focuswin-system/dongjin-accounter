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
    const { name, biz_no, ceo, biz_type, biz_item, address, phone, fax, email, main_account } = req.body
    await req.db.execute(
      `INSERT INTO company_info
         (id, name, biz_no, ceo, biz_type, biz_item, address, phone, fax, email, main_account)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name), biz_no=VALUES(biz_no), ceo=VALUES(ceo),
         biz_type=VALUES(biz_type), biz_item=VALUES(biz_item), address=VALUES(address),
         phone=VALUES(phone), fax=VALUES(fax), email=VALUES(email),
         main_account=VALUES(main_account), updated_at=NOW()`,
      [COMPANY_ID, name||'', biz_no||'', ceo||'', biz_type||'', biz_item||'',
       address||'', phone||'', fax||'', email||'', main_account||'']
    )
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
