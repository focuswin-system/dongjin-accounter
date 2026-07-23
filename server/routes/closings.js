const { Router } = require('express')
const { randomUUID } = require('crypto')
const { monthOf } = require('../lib/closing')

const router = Router()

// 마감한 달 목록 (최근 순)
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM closed_periods ORDER BY period DESC')
    res.json(rows)
  } catch (e) { next(e) }
})

// 월 마감
router.post('/', async (req, res, next) => {
  try {
    const period = monthOf(req.body.period)
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: '마감할 달을 YYYY-MM 형식으로 지정해주세요' })
    // 아직 오지 않은 달을 마감하면 그 달의 거래를 아예 넣을 수 없게 된다
    const nowMonth = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7)  // KST 기준 이번 달
    if (period > nowMonth) return res.status(400).json({ error: '아직 지나지 않은 달은 마감할 수 없어요' })
    await req.db.execute(
      'INSERT INTO closed_periods (id, period, memo, closed_by) VALUES (?,?,?,?)',
      [randomUUID(), period, req.body.memo || null, req.user?.username || null]
    )
    res.json({ ok: true, period })
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '이미 마감된 달이에요' })
    next(e)
  }
})

// 마감 해제
router.delete('/:period', async (req, res, next) => {
  try {
    const [r] = await req.db.execute('DELETE FROM closed_periods WHERE period = ?', [monthOf(req.params.period)])
    if (r.affectedRows === 0) return res.status(404).json({ error: '마감된 달이 아니에요' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
