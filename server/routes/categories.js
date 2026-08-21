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
    // 코드 미지정 시 구분(지출=EXP / 수입=INC)에 따라 자동 채번
    if (!id) {
      const prefix = kind === 'inc' ? 'INC' : 'EXP'
      const [[{ maxno }]] = await req.db.execute(
        "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(id,'-',-1) AS UNSIGNED)),0) AS maxno FROM categories WHERE id LIKE ?",
        [`${prefix}-%`]
      )
      id = `${prefix}-${Number(maxno) + 1}`
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
    const [result] = await req.db.execute(
      'UPDATE categories SET name=?, group_name=?, vat=?, pay_method=?, vat_deductible=?, account_code=? WHERE id=?',
      [name, group_name || '', vat || '10%', pay_method || '계좌이체', vat_deductible === 0 ? 0 : 1,
       account_code || null, req.params.id]
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
