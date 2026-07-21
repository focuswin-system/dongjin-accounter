const { Router } = require('express')
const { randomUUID } = require('crypto')

const router = Router()

const FIELDS = ['name', 'code', 'spec', 'unit', 'party', 'amount', 'start_date', 'end_date', 'memo',
  'period', 'pay_day', 'account_id', 'file_url', 'file_name']
const NUM_FIELDS = new Set(['amount', 'pay_day'])
const pick = (body) => FIELDS.map(f =>
  NUM_FIELDS.has(f) ? (parseInt(String(body[f] ?? '').replace(/[^0-9-]/g, ''), 10) || 0) : (body[f] ?? null))

// 목록 (type별)
router.get('/', async (req, res, next) => {
  try {
    const { type } = req.query
    const [rows] = type
      ? await req.db.execute('SELECT * FROM ref_items WHERE type=? ORDER BY sort_order, name', [type])
      : await req.db.execute('SELECT * FROM ref_items ORDER BY type, sort_order, name')
    res.json(rows)
  } catch (e) { next(e) }
})

// 등록
router.post('/', async (req, res, next) => {
  try {
    const { type, name } = req.body
    if (!type || !name) return res.status(400).json({ error: 'type·name 필수' })
    const [[{ maxOrder }]] = await req.db.execute('SELECT COALESCE(MAX(sort_order),0) AS maxOrder FROM ref_items WHERE type=?', [type])
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO ref_items (id, type, name, code, spec, unit, party, amount, start_date, end_date, memo, period, pay_day, account_id, file_url, file_name, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, type, ...pick(req.body), maxOrder + 1]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

// 수정
router.put('/:id', async (req, res, next) => {
  try {
    const [result] = await req.db.execute(
      'UPDATE ref_items SET name=?, code=?, spec=?, unit=?, party=?, amount=?, start_date=?, end_date=?, memo=?, period=?, pay_day=?, account_id=?, file_url=?, file_name=? WHERE id=?',
      [...pick(req.body), req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 삭제
router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM ref_items WHERE id=?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
