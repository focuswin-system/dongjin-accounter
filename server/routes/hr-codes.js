const { Router } = require('express')
const { randomUUID } = require('crypto')
const { rollbackQuietly } = require('../lib/tx')

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    const { type } = req.query
    const [rows] = type
      ? await req.db.execute('SELECT * FROM hr_codes WHERE type=? ORDER BY sort_order, name', [type])
      : await req.db.execute('SELECT * FROM hr_codes ORDER BY type, sort_order, name')
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { type, name } = req.body
    if (!type || !name) return res.status(400).json({ error: '필수값 누락' })
    const [[{ maxOrder }]] = await req.db.execute('SELECT COALESCE(MAX(sort_order),0) AS maxOrder FROM hr_codes WHERE type=?', [type])
    const id = randomUUID()
    await req.db.execute('INSERT INTO hr_codes (id,type,name,sort_order) VALUES (?,?,?,?)', [id, type, name, maxOrder + 1])
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

/* 표시 순서 — 직위는 **이름순이 뜻이 없다.** 가나다로 세우면
 * '과장·대리·부장·사원·주임'이 되어 서열이 뒤죽박죽이다. 부서도 마찬가지로
 * 회사가 쓰는 순서가 따로 있다. 받은 id 순서를 그대로 sort_order 로 굳힌다.
 * ⚠ '/:id' 보다 위에 있어야 한다 — 아래에 두면 'reorder' 가 id 로 잡힌다.
 * 한 트랜잭션으로 처리한다: 중간에 끊기면 순서가 반만 바뀌어 더 엉킨다.
 * type 을 함께 조건에 넣는다 — id 만 믿으면 부서 순서로 직위를 덮을 수 있다. */
router.put('/reorder', async (req, res, next) => {
  const type = String(req.body.type ?? '')
  const ids = Array.isArray(req.body.ids) ? req.body.ids : []
  if (!type || !ids.length) return res.status(400).json({ error: 'type·ids 필수' })
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    for (let i = 0; i < ids.length; i++) {
      await conn.execute('UPDATE hr_codes SET sort_order=? WHERE id=? AND type=?', [i + 1, ids[i], type])
    }
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/* 이름 수정 — 지금까지는 없었다. 오타 하나를 고치려면 지우고 다시 만들어야 했는데,
 * 그러면 새 id 가 생겨 이 직위를 가리키던 결재선이 끊긴다. */
router.put('/:id', async (req, res, next) => {
  try {
    const name = String(req.body.name ?? '').trim()
    if (!name) return res.status(400).json({ error: '이름을 입력해주세요' })
    const [r] = await req.db.execute('UPDATE hr_codes SET name=? WHERE id=?', [name, req.params.id])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM hr_codes WHERE id=?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
