const { Router } = require('express')
const { randomUUID } = require('crypto')

const router = Router()

const FIELDS = ['name', 'code', 'spec', 'unit', 'party', 'amount', 'start_date', 'end_date', 'memo',
  'period', 'pay_day', 'account_id', 'file_url', 'file_name',
  'purchase_price', 'item_kind', 'tax_type', 'item_group', 'deductible']
const NUM_FIELDS = new Set(['amount', 'pay_day', 'purchase_price', 'deductible'])
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
      'INSERT INTO ref_items (id, type, name, code, spec, unit, party, amount, start_date, end_date, memo, period, pay_day, account_id, file_url, file_name, purchase_price, item_kind, tax_type, item_group, deductible, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, type, ...pick(req.body), maxOrder + 1]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

// 수정
router.put('/:id', async (req, res, next) => {
  try {
    const [result] = await req.db.execute(
      'UPDATE ref_items SET name=?, code=?, spec=?, unit=?, party=?, amount=?, start_date=?, end_date=?, memo=?, period=?, pay_day=?, account_id=?, file_url=?, file_name=?, purchase_price=?, item_kind=?, tax_type=?, item_group=?, deductible=? WHERE id=?',
      [...pick(req.body), req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 삭제
router.delete('/:id', async (req, res, next) => {
  try {
    // 품목 기준정보는 거래·계약·청구서가 item_id 로 참조하는데 FK가 없다.
    // 그냥 지우면 이미 기록된 거래의 품목명이 조용히 빈칸이 된다(목록은 JOIN 으로 이름을 붙인다).
    // 과거 기록을 훼손하지 않도록, 쓰인 적 있는 항목은 지우지 못하게 막는다.
    const id = req.params.id
    const [[c]] = await req.db.execute(
      `SELECT
         (SELECT COUNT(*) FROM transactions        WHERE item_id = ?) AS txns,
         (SELECT COUNT(*) FROM contract_items      WHERE item_id = ?) AS citems,
         (SELECT COUNT(*) FROM invoice_lines       WHERE item_id = ?) AS ilines,
         (SELECT COUNT(*) FROM work_contract_items WHERE item_id = ?) AS witems`,
      [id, id, id, id]
    )
    const parts = []
    if (Number(c.txns)   > 0) parts.push(`거래 ${c.txns}건`)
    if (Number(c.citems) > 0) parts.push(`계약 품목 ${c.citems}건`)
    if (Number(c.ilines) > 0) parts.push(`청구서 품목 ${c.ilines}건`)
    if (Number(c.witems) > 0) parts.push(`용역계약 품목 ${c.witems}건`)
    if (parts.length) {
      return res.status(409).json({
        error: `이 항목은 ${parts.join(' · ')}에 쓰였어요. 지우면 그 기록의 품목명이 사라져요. 이름만 바꿔 쓰시거나 그대로 두세요.`,
      })
    }
    const [r] = await req.db.execute('DELETE FROM ref_items WHERE id=?', [id])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
