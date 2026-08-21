const { Router } = require('express')
const { isFundAccount } = require('../lib/categoryAccount')

const router = Router()

/* 비목에 자금 계정(현금·당좌·보통예금)을 달면, 그 비목으로 등록한 거래마다
 * `보통예금 / 보통예금` 같은 분개가 나와 매출도 비용도 장부에 잡히지 않는다.
 * 거래는 이미 계좌로 한쪽 다리를 갖기 때문이다. 입구에서 막는다. */
const fundAccountError = (code) =>
  isFundAccount(code)
    ? '현금·예금 계정은 비목의 계정과목이 될 수 없어요. 그 자리는 계좌가 이미 차지합니다.'
    : null

router.get('/', async (req, res, next) => {
  try {
    const { type } = req.query
    let sql = 'SELECT * FROM categories WHERE active = 1'
    const params = []
    if (type === 'exp') { sql += " AND id LIKE 'EXP-%'"; }
    if (type === 'inc') { sql += " AND id LIKE 'INC-%'"; }
    sql += ' ORDER BY sort_order, id'
    const [rows] = await req.db.execute(sql, params)
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    let { id, kind, name, group_name, vat, pay_method, vat_deductible, account_code } = req.body
    if (!name) return res.status(400).json({ error: 'name 필수' })
    { const fe = fundAccountError(account_code); if (fe) return res.status(400).json({ error: fe }) }
    /* 코드 미지정 시 구분(지출=EXP / 수입=INC)에 따라 자동 채번.
     *
     * ⚠ **표준 비목 번호대를 비켜 간다.** 예전엔 그냥 `MAX+1` 이었는데, 표준 비목 시드가
     * EXP-904 에서 끝나니 사용자가 만든 첫 비목이 EXP-905 였다. 그 뒤 표준 비목을 보강하며
     * EXP-905~915 를 쓰자 **같은 번호를 두고 다투게** 됐다 — 사용자의 '차량 리스료'에
     * 표준 '감가상각비'의 계정과목이 발리는 식이다(db.js 시딩 주석 참조).
     *
     * 그래서 사용자 채번은 9000번대부터 시작한다. 표준 비목이 앞으로 몇 개 더 늘어도
     * 9000 을 넘지 않으므로 다시는 겹치지 않는다. 이미 만들어진 낮은 번호는 그대로 둔다 —
     * 번호를 바꾸면 그 비목으로 찍힌 거래를 전부 따라 고쳐야 한다. */
    if (!id) {
      const prefix = kind === 'inc' ? 'INC' : 'EXP'
      const USER_ID_BASE = 9000
      const [[{ maxno }]] = await req.db.execute(
        "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(id,'-',-1) AS UNSIGNED)),0) AS maxno FROM categories WHERE id LIKE ?",
        [`${prefix}-%`]
      )
      id = `${prefix}-${Math.max(Number(maxno), USER_ID_BASE) + 1}`
    }
    const [[{ maxOrd }]] = await req.db.execute('SELECT COALESCE(MAX(sort_order),0)+1 AS maxOrd FROM categories')
    await req.db.execute(
      'INSERT INTO categories (id, name, group_name, vat, pay_method, sort_order, vat_deductible, account_code) VALUES (?,?,?,?,?,?,?,?)',
      [id, name, group_name || '', vat || '10%', pay_method || '계좌이체', maxOrd, vat_deductible === 0 ? 0 : 1, account_code || null]
    )
    res.json({ id })
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '이미 존재하는 코드입니다' })
    next(e)
  }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, group_name, vat, pay_method, vat_deductible, account_code } = req.body
    { const fe = fundAccountError(account_code); if (fe) return res.status(400).json({ error: fe }) }
    /* account_code 는 **보낸 요청만** 갱신한다.
     *
     * 예전엔 `account_code || null` 을 무조건 써서, 이 필드를 안 보내는 호출 한 번이면
     * 연결이 지워졌다. 배포 전에 페이지를 열어 둔 사용자의 옛 화면이 저장을 누르면 그렇게 된다.
     * 연결이 지워진 뒤 찍힌 거래는 account_code 가 비어 일계표에서 상대 계정이 사라진다.
     * (청구서 PUT 이 같은 이유로 부분 갱신을 하고, 정산내역서에서 이미 겪은 유형이다.) */
    const extra = account_code !== undefined ? ', account_code=?' : ''
    const extraVal = account_code !== undefined ? [account_code || null] : []
    const [result] = await req.db.execute(
      `UPDATE categories SET name=?, group_name=?, vat=?, pay_method=?, vat_deductible=?${extra} WHERE id=?`,
      [name, group_name || '', vat || '10%', pay_method || '계좌이체', vat_deductible === 0 ? 0 : 1,
       ...extraVal, req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('UPDATE categories SET active = 0 WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
