const { Router } = require('express')
const { randomUUID } = require('crypto')
const { kstToday } = require('../db')
const { rollbackQuietly } = require('../lib/tx')

const router = Router()

const parseJson = (v, fb) => { try { return v ? JSON.parse(v) : fb } catch { return fb } }

// 기본 결재선 프리셋을 새 정산서에 스냅샷으로 복사 (지급결의서와 동일 규칙)
const defaultApproval = async (execFn) => {
  const [[p]] = await execFn('SELECT steps FROM approval_presets WHERE is_default=1 ORDER BY sort_order LIMIT 1')
  const steps = parseJson(p && p.steps, null)
  if (steps && steps.length) return steps.map(s => ({ label: s.label || '', position: s.position || '', name: '' }))
  return [{ label: '담당', position: '', name: '' }, { label: '결재', position: '', name: '' }, { label: '대표이사', position: '', name: '' }]
}

const adaptLine = (l) => ({ ...l, amount: Number(l.amount) || 0 })
const adapt = (r, lines) => {
  const ls = (lines || []).map(adaptLine)
  const total = ls.reduce((s, l) => s + l.amount, 0)
  const received = Number(r.received_amount) || 0
  return { ...r, received_amount: received, lines: ls, total, balance: received - total, approval: parseJson(r.approval, []) }
}

// 목록 (최신순) — 라인 합계는 한 번에 집계
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM settlements ORDER BY created_at DESC')
    const [sums] = await req.db.execute('SELECT settlement_id, COALESCE(SUM(amount),0) AS total FROM settlement_lines GROUP BY settlement_id')
    const map = {}
    for (const s of sums) map[s.settlement_id] = Number(s.total)
    res.json(rows.map(r => {
      const received = Number(r.received_amount) || 0
      const total = map[r.id] || 0
      return { ...r, received_amount: received, total, balance: received - total, approval: parseJson(r.approval, []) }
    }))
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [[r]] = await req.db.execute('SELECT * FROM settlements WHERE id = ?', [req.params.id])
    if (!r) return res.status(404).json({ error: 'Not found' })
    const [lines] = await req.db.execute('SELECT * FROM settlement_lines WHERE settlement_id = ? ORDER BY sort_order, id', [req.params.id])
    res.json(adapt(r, lines))
  } catch (e) { next(e) }
})

const insertLines = async (conn, settlementId, lines) => {
  const list = Array.isArray(lines) ? lines.filter(l => (l.title && l.title.trim()) || Number(l.amount)) : []
  let i = 0
  for (const l of list) {
    await conn.execute(
      'INSERT INTO settlement_lines (id, settlement_id, category, title, amount, memo, sort_order) VALUES (?,?,?,?,?,?,?)',
      [randomUUID(), settlementId, l.category || '기타경비', l.title || '', Number(l.amount) || 0, l.memo || '', i++])
  }
}

// 새 정산내역서 — 헤더 + 라인. 정산서는 잔액 계산·인쇄용 문서라 거래는 만들지 않는다(단일소스 유지, 연동은 후속).
// 출장지역(trip_area)·출장기간(trip_period)은 2026-08 양식 개편에서 화면과 함께 은퇴했다.
// 컬럼은 옛 문서의 값을 보존하려고 남겨두되, 여기서는 읽지도 쓰지도 않는다
// (쓰면 옛 문서를 한 번 저장하는 것만으로 값이 빈칸으로 지워진다).
router.post('/', async (req, res, next) => {
  const { settler, settle_date, purpose, received_amount, note, lines } = req.body
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const year = (settle_date || kstToday()).slice(0, 4)
    // 채번 JS-YYYY-NNNN — 트랜잭션 안에서 FOR UPDATE 로 최신 커밋을 잠그고 뽑는다(동시 생성 중복 방지)
    const [[{ maxno }]] = await conn.execute(
      `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(doc_no, '-', -1) AS UNSIGNED)), 0) AS maxno
       FROM settlements WHERE doc_no LIKE ? FOR UPDATE`, [`JS-${year}-%`])
    const doc_no = `JS-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    const id = randomUUID()
    const approval = Array.isArray(req.body.approval) && req.body.approval.length
      ? req.body.approval
      : await defaultApproval((sql, p) => conn.execute(sql, p))
    await conn.execute(
      `INSERT INTO settlements (id, doc_no, settler, settle_date, purpose, received_amount, note, approval, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, doc_no, settler || req.user?.name || req.user?.username || '관리자', settle_date || null,
       purpose || '',
       Number(received_amount) || 0, note || '', JSON.stringify(approval), '작성'])
    await insertLines(conn, id, lines)
    await conn.commit()
    const [[head]] = await req.db.execute('SELECT * FROM settlements WHERE id = ?', [id])
    const [ln] = await req.db.execute('SELECT * FROM settlement_lines WHERE settlement_id = ? ORDER BY sort_order, id', [id])
    res.json(adapt(head, ln))
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// 수정 — 헤더 갱신 + 라인 통째 교체(삭제 후 재삽입)
router.put('/:id', async (req, res, next) => {
  const { settler, settle_date, purpose, received_amount, note, status, approval, lines } = req.body
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[cur]] = await conn.execute('SELECT id FROM settlements WHERE id = ? FOR UPDATE', [req.params.id])
    if (!cur) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    await conn.execute(
      `UPDATE settlements SET settler=?, settle_date=?, purpose=?, received_amount=?, note=?, status=?, approval=? WHERE id=?`,
      [settler || '', settle_date || null, purpose || '',
       Number(received_amount) || 0, note || '',
       status || '작성', JSON.stringify(Array.isArray(approval) ? approval : []), req.params.id])
    await conn.execute('DELETE FROM settlement_lines WHERE settlement_id = ?', [req.params.id])
    await insertLines(conn, req.params.id, lines)
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM settlement_lines WHERE settlement_id = ?', [req.params.id])
    await req.db.execute('DELETE FROM settlements WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
