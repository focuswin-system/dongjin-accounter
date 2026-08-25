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
    /* 주거래 계좌·카드 — 화면의 계좌 칩을 어느 순서로 세울지 정하는 값(accounts.id).
       빈 문자열은 '지정 안 함'이라 null 로 눕힌다 — ''로 두면 어떤 계좌와도 안 맞는
       유령 값이 남는다. */
    const mainId = (v) => (v ? String(v) : null)
    await req.db.execute(
      `INSERT INTO company_info
         (id, name, biz_no, ceo, biz_type, biz_item, address, phone, fax, email, main_account, closing_day, week_start_day,
          main_in_account_id, main_out_account_id, main_card_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name), biz_no=VALUES(biz_no), ceo=VALUES(ceo),
         biz_type=VALUES(biz_type), biz_item=VALUES(biz_item), address=VALUES(address),
         phone=VALUES(phone), fax=VALUES(fax), email=VALUES(email),
         main_account=VALUES(main_account),
         closing_day=VALUES(closing_day), week_start_day=VALUES(week_start_day),
         main_in_account_id=VALUES(main_in_account_id),
         main_out_account_id=VALUES(main_out_account_id),
         main_card_id=VALUES(main_card_id), updated_at=NOW()`,
      [COMPANY_ID, name||'', biz_no||'', ceo||'', biz_type||'', biz_item||'',
       address||'', phone||'', fax||'', email||'', main_account||'',
       // 0~28 만 받는다 — 29~31 은 짧은 달에 존재하지 않아 그 달만 조용히 어긋난다
       Math.min(28, Math.max(0, parseInt(closing_day, 10) || 0)),
       Math.min(6, Math.max(0, parseInt(week_start_day, 10) || 0)),
       mainId(req.body.main_in_account_id), mainId(req.body.main_out_account_id),
       mainId(req.body.main_card_id)]
    )
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/* 회계 처리 방식 — 회사가 정하는 장부 규약.
 *
 * report_prefs 테이블을 함께 쓴다(key_name/enabled 만 있는 범용 표).
 * **행이 없으면 켜짐**이 이 표의 규약이라, 켤 때는 지우고 끌 때만 넣는다 —
 * 보고서 on/off(routes/reports.js)와 같은 방식이어야 두 곳이 다른 말을 하지 않는다.
 *
 * voucher_issuance  청구서 발행 시점의 분개를 일계표에 함께 셀지.
 *   켜짐(기본) 회계적으로 옳다 — 발행 때 생긴 채권·채무가 결제 때 사라지는 두 시점이 다 잡힌다.
 *   꺼짐       "은행 기준으로 돈이 오갈 때만 전표를 끊는" 회사용(현금주의). 결제 거래만 센다.
 */
const ACCOUNTING_PREFS = new Set(['voucher_issuance'])

router.get('/accounting-prefs', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT key_name FROM report_prefs WHERE enabled = 0')
    const off = new Set(rows.map(r => r.key_name))
    res.json(Object.fromEntries([...ACCOUNTING_PREFS].map(k => [k, !off.has(k)])))
  } catch (e) { next(e) }
})

router.put('/accounting-prefs/:key', async (req, res, next) => {
  try {
    const key = String(req.params.key || '')
    if (!ACCOUNTING_PREFS.has(key)) return res.status(404).json({ error: '없는 설정이에요' })
    const enabled = req.body?.enabled !== false
    if (enabled) await req.db.execute('DELETE FROM report_prefs WHERE key_name = ?', [key])
    else await req.db.execute(
      'INSERT INTO report_prefs (key_name, enabled) VALUES (?, 0) ON DUPLICATE KEY UPDATE enabled = 0', [key])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
