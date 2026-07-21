const { Router } = require('express')

const router = Router()

// 표준 계정과목 조회 (읽기 전용 마스터). ?postable=1 이면 거래 입력용(집계 제외).
router.get('/', async (req, res, next) => {
  try {
    let sql = 'SELECT id, acct_type, category, name, code, note, postable FROM account_subjects'
    if (String(req.query.postable) === '1') sql += ' WHERE postable = 1'
    sql += ' ORDER BY sort_order'
    const [rows] = await req.db.execute(sql)
    res.json(rows)
  } catch (e) { next(e) }
})

module.exports = router
