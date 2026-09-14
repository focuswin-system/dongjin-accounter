const { Router } = require('express')
const { randomUUID } = require('crypto')
const { kstToday } = require('../db')
const { rollbackQuietly } = require('../lib/tx')
const { pageParams, buildWhere, inClause, docDateExpr } = require('../lib/pagedList')
const { usedSourceMap, duplicateSourceError } = require('../lib/settleSources')

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
    const pp = pageParams(req)
    const adaptRow = (r, total) => {
      const received = Number(r.received_amount) || 0
      return { ...r, received_amount: received, total, balance: received - total, approval: parseJson(r.approval, []) }
    }
    // 파라미터 없음 = 예전처럼 전체 배열(후보용 호출 호환)
    if (!pp.paged) {
      const [rows] = await req.db.execute('SELECT * FROM settlements ORDER BY created_at DESC, id DESC')
      const [sums] = await req.db.execute('SELECT settlement_id, COALESCE(SUM(amount),0) AS total FROM settlement_lines GROUP BY settlement_id')
      const map = {}
      for (const s of sums) map[s.settlement_id] = Number(s.total)
      return res.json(rows.map(r => adaptRow(r, map[r.id] || 0)))
    }
    // 페이지 모드 — 검색·기간·50건씩. 합계는 이 페이지 행에만 붙인다.
    // 정산서는 거래처가 한 곳이 아니다(줄마다 다르다) — 기간·검색만 건다
    const { whereSql, args } = buildWhere(pp, ['doc_no', 'settler', 'purpose'], { dateExpr: docDateExpr('settle_date') })
    const [[{ cnt }]] = await req.db.execute(`SELECT COUNT(*) AS cnt FROM settlements ${whereSql}`, args)
    const [rows] = await req.db.execute(
      `SELECT * FROM settlements ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ${pp.limit} OFFSET ${pp.offset}`, args)
    const { clause, ids } = inClause(rows.map(r => r.id))
    const map = {}
    if (ids.length) {
      const [sums] = await req.db.execute(
        `SELECT settlement_id, COALESCE(SUM(amount),0) AS total FROM settlement_lines WHERE settlement_id IN ${clause} GROUP BY settlement_id`, ids)
      for (const s of sums) map[s.settlement_id] = Number(s.total)
    }
    res.json({ rows: rows.map(r => adaptRow(r, map[r.id] || 0)), total: Number(cnt), hasMore: pp.offset + rows.length < Number(cnt) })
  } catch (e) { next(e) }
})

/**
 * 이미 정산서에 들어간 돈 — 새 정산서의 '가져오기'에서 빼는 근거. { 열쇠: 정산서 번호 }
 * 같은 돈이 거래·결의서·품의 여러 얼굴로 오므로 사슬 끝까지 펼친다(lib/settleSources.js).
 */
router.get('/used-sources', async (req, res, next) => {
  try { res.json(await usedSourceMap(req.db)) }
  catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [[r]] = await req.db.execute('SELECT * FROM settlements WHERE id = ?', [req.params.id])
    if (!r) return res.status(404).json({ error: 'Not found' })
    const [lines] = await req.db.execute('SELECT * FROM settlement_lines WHERE settlement_id = ? ORDER BY sort_order, id', [req.params.id])
    res.json(adapt(r, lines))
  } catch (e) { next(e) }
})

/* 줄의 출처(어느 거래·결의서·품의에서 가져왔나). 이 목록 밖의 값은 버린다 —
   used-sources 가 이 값으로 표를 찾아가므로 엉뚱한 값이 들어가면 판정이 조용히 빠진다. */
const SOURCE_TYPES = new Set(['txn', 'resolution', 'purchase_req'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const insertLines = async (conn, settlementId, lines) => {
  const list = Array.isArray(lines) ? lines.filter(l => (l.title && l.title.trim()) || Number(l.amount)) : []
  let i = 0
  for (const l of list) {
    const st = SOURCE_TYPES.has(l.source_type) && l.source_id ? l.source_type : null
    await conn.execute(
      'INSERT INTO settlement_lines (id, settlement_id, category, title, amount, memo, sort_order, source_type, source_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [randomUUID(), settlementId, l.category || '기타경비', l.title || '', Number(l.amount) || 0, l.memo || '', i++,
       st, st ? String(l.source_id) : null])
  }
}

// 새 정산내역서 — 헤더 + 라인. 정산서는 잔액 계산·인쇄용 문서라 거래는 만들지 않는다(단일소스 유지, 연동은 후속).
// 출장지역(trip_area)·출장기간(trip_period)은 2026-08 양식 개편에서 화면과 함께 은퇴했다.
// 컬럼은 옛 문서의 값을 보존하려고 남겨두되, 여기서는 읽지도 쓰지도 않는다
// (쓰면 옛 문서를 한 번 저장하는 것만으로 값이 빈칸으로 지워진다).
router.post('/', async (req, res, next) => {
  const { settler, settle_date, purpose, received_amount, note, lines } = req.body
  // 목록의 기간 필터가 이 칸을 문자열로 비교한다 — 날짜 모양이 아니면 엉뚱한 기간에 잡힌다
  if (settle_date && !DATE_RE.test(settle_date)) return res.status(400).json({ error: '정산일은 YYYY-MM-DD 로 적어주세요' })
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const year = (settle_date || kstToday()).slice(0, 4)
    // 채번 JS-YYYY-NNNN — 트랜잭션 안에서 FOR UPDATE 로 최신 커밋을 잠그고 뽑는다(동시 생성 중복 방지)
    const [[{ maxno }]] = await conn.execute(
      `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(doc_no, '-', -1) AS UNSIGNED)), 0) AS maxno
       FROM settlements WHERE doc_no LIKE ? FOR UPDATE`, [`JS-${year}-%`])
    const doc_no = `JS-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    // 같은 돈을 두 번 담지 않는다 — 화면이 목록에서 빼 주지만 동시에 넣으면 겹친다
    { const de = await duplicateSourceError(conn, lines); if (de) { await rollbackQuietly(conn); return res.status(409).json({ error: de }) } }
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
  if (settle_date && !DATE_RE.test(settle_date)) return res.status(400).json({ error: '정산일은 YYYY-MM-DD 로 적어주세요' })
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[cur]] = await conn.execute('SELECT id FROM settlements WHERE id = ? FOR UPDATE', [req.params.id])
    if (!cur) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    { const de = await duplicateSourceError(conn, lines, { settlementId: req.params.id }); if (de) { await rollbackQuietly(conn); return res.status(409).json({ error: de }) } }
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
