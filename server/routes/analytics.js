const { Router } = require('express')
const { randomUUID } = require('crypto')
const { kstToday } = require('../db')
const { pnlOnly, pnlParams } = require('../lib/pnl')

const router = Router()

// 경영 도우미 — 범용 집계 + 대화(세션)형 저장.
// 설계: docs/02-design/features/mgmt-query-assistant.design.md · mgmt-chat-sessions.design.md
// ⚠ 멀티테넌트 — 전역 풀 금지. 반드시 req.db 로만 질의한다. 대화는 user_id(req.user.id)로 격리.

const KIND = { sales: 'income', purchase: 'expense' }
const TOPIC_LABEL = { sales: '매출', purchase: '매입' }
// group → { key 컬럼식, 라벨식, JOIN, 한글라벨, 차트 }. 컬럼식은 사용자 입력이 아니라 이 맵의 값만 SQL에 들어간다.
const GROUP = {
  none:     { col: null, label: null, join: '', ko: '합계', chart: 'bar' },
  vendor:   { col: 't.vendor_id',                  label: 'MAX(v.name)',   join: 'LEFT JOIN vendors v ON t.vendor_id = v.id',   ko: '거래처별', chart: 'bar' },
  contract: { col: 't.contract_id',                label: 'MAX(c.name)',   join: 'LEFT JOIN contracts c ON t.contract_id = c.id', ko: '계약별', chart: 'bar' },
  category: { col: 't.category',                   label: 'MAX(t.category)', join: '',                                          ko: '비목별', chart: 'bar' },
  item:     { col: 't.item_id',                    label: 'MAX(ri.name)',  join: 'LEFT JOIN ref_items ri ON t.item_id = ri.id', ko: '품목별', chart: 'bar' },
  month:    { col: "DATE_FORMAT(t.date, '%Y-%m')", label: "DATE_FORMAT(t.date, '%Y-%m')", join: '',                            ko: '월별 추이', chart: 'line' },
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const FILTER_COLS = { vendor_id: 't.vendor_id', contract_id: 't.contract_id', category: 't.category', item_id: 't.item_id' }
const PERIODS = new Set(['this_month', 'this_quarter', 'this_year', 'last_3m', 'last_12m', 'custom'])

const won = (n) => (Math.round(Number(n) || 0)).toLocaleString('ko-KR') + '원'
const pad2 = (n) => String(n).padStart(2, '0')
// 월 정수연산(타임존 안전): {y,m}(m=1..12)에서 n개월 전
const shiftMonth = (y, m, n) => { const i = y * 12 + (m - 1) - n; return { y: Math.floor(i / 12), m: (i % 12) + 1 } }

// 기간 프리셋 → {from,to,label}. KST 오늘 기준. 상대기간은 여기서 매번 그 시점 날짜로 환산된다.
function resolvePeriod(spec) {
  const today = kstToday()               // 'YYYY-MM-DD' (KST)
  const [y, m] = today.split('-').map(Number)
  const ms = (yy, mm) => `${yy}-${pad2(mm)}-01`
  switch (spec.period) {
    case 'this_month':   return { from: ms(y, m), to: today, label: `${y}년 ${m}월` }
    case 'this_quarter': { const q = Math.floor((m - 1) / 3); return { from: ms(y, q * 3 + 1), to: today, label: `${y}년 ${q + 1}분기` } }
    case 'last_3m':      { const s = shiftMonth(y, m, 2); return { from: ms(s.y, s.m), to: today, label: '최근 3개월' } }
    case 'last_12m':     { const s = shiftMonth(y, m, 11); return { from: ms(s.y, s.m), to: today, label: '최근 12개월' } }
    case 'custom':       return {
      from: DATE_RE.test(spec.from || '') ? spec.from : '1900-01-01',
      to:   DATE_RE.test(spec.to   || '') ? spec.to   : '2999-12-31',
      label: `${spec.from || '전체'} ~ ${spec.to || ''}`.trim(),
    }
    default:             return { from: ms(y, 1), to: `${y}-12-31`, label: `${y}년` }  // this_year
  }
}

// 사용자 입력(query/body) → 정규화된 QuerySpec. 화이트리스트만 통과.
function normalizeSpec(src = {}) {
  const topic = KIND[src.topic] ? src.topic : 'sales'
  const group = Object.prototype.hasOwnProperty.call(GROUP, src.group) ? src.group : 'none'
  const period = PERIODS.has(src.period) ? src.period : 'this_year'
  const measure = src.measure === 'count' ? 'count' : 'amount'
  const status_scope = src.status_scope === 'all' ? 'all' : 'completed'
  const spec = { topic, group, period, measure, status_scope }
  if (period === 'custom') { if (DATE_RE.test(src.from || '')) spec.from = src.from; if (DATE_RE.test(src.to || '')) spec.to = src.to }
  const filter = {}
  const fsrc = src.filter || src
  for (const k of Object.keys(FILTER_COLS)) if (fsrc[k]) filter[k] = String(fsrc[k])
  if (Object.keys(filter).length) spec.filter = filter
  return spec
}

// QuerySpec → 스냅샷 {topic,group,periodLabel,from,to,chart,rows,total,summary,title}. 계산의 단일 소스.
async function runAggregate(db, spec) {
  const s = normalizeSpec(spec)
  const kind = KIND[s.topic]
  const grp = GROUP[s.group]
  const { from, to, label: periodLabel } = resolvePeriod(s)
  const statusCond = (s.status_scope === 'completed' && kind === 'expense') ? " AND t.status = '지급완료'" : ''
  const AGG = s.measure === 'count' ? 'COUNT(*)' : 'COALESCE(SUM(t.amount), 0)'

  // 재무 거래(차입금 원금·자본금·투자자산)는 매출/매입이 아니다 → 손익 거래만 집계한다.
  // 대출 수령을 income으로 넣는 순간 이 조건이 없으면 그대로 '매출'로 잡힌다(lib/pnl.js).
  const where = ['t.kind = ?', 't.date BETWEEN ? AND ?', pnlOnly('t')]
  const params = [kind, from, to, ...pnlParams()]
  const filter = s.filter || {}
  for (const [k, col] of Object.entries(FILTER_COLS)) if (filter[k]) { where.push(`${col} = ?`); params.push(filter[k]) }
  const whereSql = where.join(' AND ') + statusCond

  let rows, total
  if (s.group === 'none') {
    const [[row]] = await db.execute(`SELECT ${AGG} AS value, COUNT(*) AS cnt FROM transactions t WHERE ${whereSql}`, params)
    rows = [{ key: 'total', label: '합계', value: Number(row.value), count: Number(row.cnt) }]
    total = Number(row.value)
  } else {
    const order = s.group === 'month' ? `${grp.col} ASC` : 'value DESC'
    const [res] = await db.execute(
      `SELECT ${grp.col} AS gkey, ${grp.label} AS label, ${AGG} AS value, COUNT(*) AS cnt
       FROM transactions t ${grp.join} WHERE ${whereSql}
       GROUP BY ${grp.col} ORDER BY ${order}`, params)
    rows = res.map(r => ({ key: r.gkey, label: r.label || '(미지정)', value: Number(r.value), count: Number(r.cnt) }))
    total = rows.reduce((a, r) => a + r.value, 0)
  }

  const topicLabel = TOPIC_LABEL[s.topic]
  const chart = grp.chart
  // 측정값 표기: 금액이면 '원', 건수(count)면 '건'을 붙인다(건수에 원을 붙이던 오류 방지)
  const fmtVal = (n) => s.measure === 'count'
    ? (Math.round(Number(n) || 0)).toLocaleString('ko-KR') + '건'
    : won(n)
  const top = rows.filter(r => r.key !== 'total').slice().sort((a, b) => b.value - a.value)[0]
  const dataRows = rows.filter(r => r.key !== 'total')
  // group='none'(합계) 조회는 rows가 [total] 한 건뿐이라 dataRows가 항상 비어,
  // 예전엔 total이 얼마든 '데이터 없음'으로 나왔다 → 합계 경로는 total로 직접 판단한다.
  const summary = s.group === 'none'
    ? (total === 0 && rows[0]?.count === 0
        ? `${periodLabel} ${topicLabel} 데이터가 없습니다.`
        : `${periodLabel} ${topicLabel}은 총 ${fmtVal(total)}입니다.`)
    : dataRows.length === 0
    ? `${periodLabel} ${topicLabel} 데이터가 없습니다.`
    : chart === 'line'
      ? `${periodLabel} ${topicLabel}은 총 ${fmtVal(total)}입니다.` + (top ? ` 가장 많았던 달은 ${top.label}, ${fmtVal(top.value)}입니다.` : '')
      : `${periodLabel} ${topicLabel}은 총 ${fmtVal(total)}이며, ${grp.ko}로는 ${dataRows.length}건입니다.` + (top ? ` 가장 큰 곳은 ${top.label}, ${fmtVal(top.value)}입니다.` : '')
  const title = `${topicLabel} · ${grp.ko} · ${periodLabel}`

  return { spec: s, topic: s.topic, group: s.group, topicLabel, groupLabel: grp.ko, periodLabel, from, to, chart, rows, total, summary, title }
}

// JSON 컬럼 방어적 파싱(드라이버가 문자열로 줄 때 대비)
const parseJson = (v) => (v && typeof v === 'string') ? JSON.parse(v) : v

// ── 즉석 집계 (컴포저 미리보기·직접 조회) ──
router.get('/aggregate', async (req, res, next) => {
  try {
    const out = await runAggregate(req.db, req.query)
    res.json({ topic: out.topic, measure: normalizeSpec(req.query).measure, group: out.group, from: out.from, to: out.to, rows: out.rows, total: out.total, summary: out.summary, chart: out.chart })
  } catch (e) { next(e) }
})

// ── 대화(세션) CRUD ──
router.get('/chats', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT ch.id, ch.title, ch.created_at, ch.updated_at,
              (SELECT COUNT(*) FROM analytics_chat_items it WHERE it.chat_id = ch.id) AS item_count
       FROM analytics_chats ch WHERE ch.user_id = ? ORDER BY ch.updated_at DESC`, [req.user.id])
    res.json(rows.map(r => ({ ...r, item_count: Number(r.item_count) })))
  } catch (e) { next(e) }
})

router.post('/chats', async (req, res, next) => {
  try {
    const id = randomUUID()
    const title = (req.body?.title || '새 대화').toString().slice(0, 120)
    await req.db.execute('INSERT INTO analytics_chats (id, user_id, title) VALUES (?, ?, ?)', [id, req.user.id, title])
    res.status(201).json({ id, title, item_count: 0 })
  } catch (e) { next(e) }
})

router.patch('/chats/:id', async (req, res, next) => {
  try {
    const title = (req.body?.title || '').toString().trim().slice(0, 120)
    if (!title) return res.status(400).json({ error: '제목을 입력해 주세요.' })
    const [r] = await req.db.execute('UPDATE analytics_chats SET title = ? WHERE id = ? AND user_id = ?', [title, req.params.id, req.user.id])
    if (!r.affectedRows) return res.status(404).json({ error: '대화를 찾을 수 없어요.' })
    res.json({ id: req.params.id, title })
  } catch (e) { next(e) }
})

router.delete('/chats/:id', async (req, res, next) => {
  try {
    const [r] = await req.db.execute('DELETE FROM analytics_chats WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
    if (!r.affectedRows) return res.status(404).json({ error: '대화를 찾을 수 없어요.' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 대화 소유권 확인(항목 조작 전 게이트). 소유 아니면 null.
async function ownedChat(db, chatId, userId) {
  const [[row]] = await db.execute('SELECT id, title FROM analytics_chats WHERE id = ? AND user_id = ?', [chatId, userId])
  return row || null
}

// ── 대화 항목(차트) ──
router.get('/chats/:id/items', async (req, res, next) => {
  try {
    if (!await ownedChat(req.db, req.params.id, req.user.id)) return res.status(404).json({ error: '대화를 찾을 수 없어요.' })
    const [rows] = await req.db.execute(
      'SELECT id, spec_json, title, result_json, refreshed_at, created_at FROM analytics_chat_items WHERE chat_id = ? ORDER BY sort_order, created_at', [req.params.id])
    res.json(rows.map(r => ({ id: r.id, title: r.title, spec: parseJson(r.spec_json), result: parseJson(r.result_json), refreshed_at: r.refreshed_at, created_at: r.created_at })))
  } catch (e) { next(e) }
})

router.post('/chats/:id/items', async (req, res, next) => {
  try {
    const chat = await ownedChat(req.db, req.params.id, req.user.id)
    if (!chat) return res.status(404).json({ error: '대화를 찾을 수 없어요.' })
    const out = await runAggregate(req.db, req.body?.spec || req.body)
    const id = randomUUID()
    const [[{ n }]] = await req.db.execute('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM analytics_chat_items WHERE chat_id = ?', [req.params.id])
    await req.db.execute(
      'INSERT INTO analytics_chat_items (id, chat_id, spec_json, title, result_json, refreshed_at, sort_order) VALUES (?, ?, ?, ?, ?, NOW(), ?)',
      [id, req.params.id, JSON.stringify(out.spec), out.title, JSON.stringify(out), n])
    // 첫 항목이고 제목이 기본값이면 조건으로 자동 명명
    if (chat.title === '새 대화') await req.db.execute('UPDATE analytics_chats SET title = ? WHERE id = ?', [out.title.slice(0, 120), req.params.id])
    else await req.db.execute('UPDATE analytics_chats SET updated_at = NOW() WHERE id = ?', [req.params.id])
    const [[row]] = await req.db.execute('SELECT refreshed_at FROM analytics_chat_items WHERE id = ?', [id])
    res.status(201).json({ id, title: out.title, spec: out.spec, result: out, refreshed_at: row.refreshed_at, autoTitle: chat.title === '새 대화' ? out.title.slice(0, 120) : null })
  } catch (e) { next(e) }
})

router.post('/chat-items/:id/refresh', async (req, res, next) => {
  try {
    const [[item]] = await req.db.execute(
      `SELECT it.id, it.spec_json, it.chat_id FROM analytics_chat_items it
       JOIN analytics_chats ch ON it.chat_id = ch.id WHERE it.id = ? AND ch.user_id = ?`, [req.params.id, req.user.id])
    if (!item) return res.status(404).json({ error: '항목을 찾을 수 없어요.' })
    const out = await runAggregate(req.db, parseJson(item.spec_json))
    await req.db.execute('UPDATE analytics_chat_items SET result_json = ?, title = ?, refreshed_at = NOW() WHERE id = ?', [JSON.stringify(out), out.title, req.params.id])
    await req.db.execute('UPDATE analytics_chats SET updated_at = NOW() WHERE id = ?', [item.chat_id])
    const [[row]] = await req.db.execute('SELECT refreshed_at FROM analytics_chat_items WHERE id = ?', [req.params.id])
    res.json({ id: req.params.id, title: out.title, spec: out.spec, result: out, refreshed_at: row.refreshed_at })
  } catch (e) { next(e) }
})

router.delete('/chat-items/:id', async (req, res, next) => {
  try {
    const [r] = await req.db.execute(
      `DELETE it FROM analytics_chat_items it JOIN analytics_chats ch ON it.chat_id = ch.id WHERE it.id = ? AND ch.user_id = ?`, [req.params.id, req.user.id])
    if (!r.affectedRows) return res.status(404).json({ error: '항목을 찾을 수 없어요.' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
