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

/* 이름 수정 — 오타 하나를 고치려면 지우고 다시 만들어야 했다.
 *
 * ⚠ **직원 정보까지 함께 고친다.** hr_codes 는 id 로 참조되지 않는다 —
 * employees.department / employees.role 이 **이름 문자열**을 그대로 들고 있다
 * (VARCHAR 컬럼이고, 화면도 Combobox 에서 고른 name 을 저장한다).
 * 그래서 마스터 행만 고치면 '차자장'으로 저장된 직원들은 그대로 남고, 목록에 없는
 * 직위가 되어 인사 명부에 직위가 둘로 갈린다(부서면 부서별 집계가 쪼개진다).
 *
 * 한 트랜잭션으로 묶는다. 중간에 끊기면 마스터와 직원이 서로 다른 이름을 들게 된다.
 * (transactions.category 를 이름으로 저장해 개칭을 막아둔 것과 같은 유형의 문제인데,
 *  여기는 대상이 employees 두 칸뿐이라 따라 고치는 쪽이 가능하다.) */
router.put('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const name = String(req.body.name ?? '').trim()
    if (!name) { conn.release(); return res.status(400).json({ error: '이름을 입력해주세요' }) }

    await conn.beginTransaction()
    const [[cur]] = await conn.execute('SELECT type, name FROM hr_codes WHERE id=? FOR UPDATE', [req.params.id])
    if (!cur) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }

    await conn.execute('UPDATE hr_codes SET name=? WHERE id=?', [name, req.params.id])

    /* 이름이 실제로 바뀐 경우에만 직원을 훑는다. 같은 이름으로 저장을 눌렀을 때
       멀쩡한 행을 건드려 봐야 얻는 게 없다. */
    let moved = 0
    if (cur.name !== name) {
      const col = cur.type === 'dept' ? 'department' : cur.type === 'pos' ? 'role' : null
      if (col) {
        const [r] = await conn.execute(
          `UPDATE employees SET \`${col}\` = ? WHERE \`${col}\` = ?`, [name, cur.name])
        moved = r.affectedRows || 0
      }
    }
    await conn.commit()
    res.json({ ok: true, renamedEmployees: moved })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM hr_codes WHERE id=?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
