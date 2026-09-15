const { Router } = require('express')
const { withTx, httpError } = require('../lib/withTx')
const { fiscalOfDate, fiscalOfYear, fiscalYearOf, parseFiscal } = require('../lib/fiscal')
const { planCompanyChange } = require('../lib/companyChange')
const { kstToday } = require('../db')

const router = Router()
const COMPANY_ID = 'main' // 자사 정보는 단일 레코드

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM company_info WHERE id = ?', [COMPANY_ID])
    const row = rows[0]
    if (!row) return res.json(null)
    // fiscal — 오늘이 속한 회기(기간·이름·기수). 화면은 기수를 '올해 기수'로 보여주고 받는다.
    res.json({ ...row, fiscal: fiscalOfDate(row, kstToday()) })
  } catch (e) { next(e) }
})

/* 올해 회기 미리보기 — 결산월을 고르는 순간 "2026.04.01 ~ 2027.03.31 (26-27년)"을 보여준다.
   계산을 화면에 두 벌 두지 않으려고 서버에 묻는다(lib/fiscal.js 한 곳). */
router.get('/fiscal-preview', async (req, res, next) => {
  try {
    const endMonth = Number(req.query.end_month)
    const p = parseFiscal({ fiscal_end_month: endMonth })
    if (!p.ok) return res.status(400).json({ error: p.error })
    res.json(fiscalOfYear(p.value, fiscalYearOf(endMonth, kstToday())))
  } catch (e) { next(e) }
})

/* 저장 — **보낸 칸만 바꾼다.**
 *
 * 예전엔 안 보낸 칸을 빈 값으로 덮었다. 모든 칸을 보내는 화면 하나뿐일 땐 티가 안 났지만,
 * 첫 설정 화면처럼 일부만 보내는 곳이 생기면 주거래 계좌·마감일이 조용히 지워진다.
 *
 * 검사 규칙은 lib/companyChange.js — 오류에 field 를 실어 화면이 그 칸 아래에 붙인다.
 * 감사 기록은 platform/auditMap.js 가 남긴다(사업자번호가 바뀌면 인쇄물 머리글·매출/매입 판정이 달라진다).
 */
router.put('/', async (req, res, next) => {
  try {
    const out = await withTx(req.db, async (conn) => {
      await conn.execute('INSERT IGNORE INTO company_info (id, name) VALUES (?, ?)', [COMPANY_ID, ''])
      const [[cur]] = await conn.execute('SELECT * FROM company_info WHERE id = ? FOR UPDATE', [COMPANY_ID])
      const r = planCompanyChange(cur, req.body || {}, kstToday())
      if (!r.ok) throw httpError(r.status, r.error, r.field ? { field: r.field } : null)
      const keys = Object.keys(r.set)
      if (keys.length) {
        // 칸 이름은 planCompanyChange 의 허용 목록에서만 나온다(요청 본문의 키를 그대로 쓰지 않는다)
        await conn.execute(
          `UPDATE company_info SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`,
          [...keys.map(k => r.set[k]), COMPANY_ID])
      }
      return { ok: true }
    })
    res.json(out)
  } catch (e) { next(e) }
})

/* 회계 처리 방식 — 회사가 정하는 장부 규약.
 *
 * report_prefs 테이블을 함께 쓴다(key_name/enabled 만 있는 범용 표).
 * **행이 없으면 켜짐**이 이 표의 규약이라, 켤 때는 지우고 끌 때만 넣는다 —
 * 보고서 on/off(routes/reports.js)와 같은 방식이어야 두 곳이 다른 말을 하지 않는다.
 *
 * voucher_issuance  청구서 발행 시점의 분개를 일계표에 함께 셀지 — 곧 **인식 시점**의 선택이다.
 *   켜짐(기본) **발생주의**. 세금계산서를 끊은 날 매출·매입으로 잡는다. 발행 때 생긴
 *              채권·채무가 결제 때 사라지는 두 시점이 다 잡혀 회계적으로 옳다.
 *   꺼짐       **현금주의**. 통장에 돈이 오간 날에만 잡는다("은행 기준으로 전표를 끊는" 회사용).
 * ⚠ 화면에도 이 이름을 그대로 쓴다(기준정보 › 회사 정보). 켜기/끄기로 두면 무엇을 고르는
 *   건지 알 수 없고, 선택지에는 원래 이름이 있다.
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
