const { Router } = require('express')

const router = Router()

// 경영 도우미 — 범용 집계. 자유 SQL 금지: group/filter 컬럼을 화이트리스트로 고정한다.
// 설계: docs/02-design/features/mgmt-query-assistant.design.md
// ⚠ 멀티테넌트 — 전역 풀 금지. 반드시 req.db 로만 질의한다.

const KIND = { sales: 'income', purchase: 'expense' }
// group → { key 컬럼식, 라벨식, JOIN }. 컬럼식은 사용자 입력이 아니라 이 맵의 값만 SQL에 들어간다.
const GROUP = {
  none:     null,
  vendor:   { col: 't.vendor_id',                  label: 'MAX(v.name)',   join: 'LEFT JOIN vendors v ON t.vendor_id = v.id' },
  contract: { col: 't.contract_id',                label: 'MAX(c.name)',   join: 'LEFT JOIN contracts c ON t.contract_id = c.id' },
  category: { col: 't.category',                   label: 'MAX(t.category)', join: '' },
  item:     { col: 't.item_id',                    label: 'MAX(ri.name)',  join: 'LEFT JOIN ref_items ri ON t.item_id = ri.id' },
  month:    { col: "DATE_FORMAT(t.date, '%Y-%m')", label: "DATE_FORMAT(t.date, '%Y-%m')", join: '' },
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// GET /api/analytics/aggregate?topic=&measure=&group=&from=&to=&status_scope=&vendor_id=&contract_id=&category=&item_id=
router.get('/aggregate', async (req, res, next) => {
  try {
    const topic = KIND[req.query.topic] ? req.query.topic : 'sales'   // sales|purchase
    const kind = KIND[topic]
    const measure = req.query.measure === 'count' ? 'count' : 'amount'
    const groupKey = Object.prototype.hasOwnProperty.call(GROUP, req.query.group) ? req.query.group : 'none'
    const grp = GROUP[groupKey]
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : '1900-01-01'
    const to   = DATE_RE.test(req.query.to   || '') ? req.query.to   : '2999-12-31'
    // 완료(기본): 잔액 계산과 동일하게 income 전부 + expense는 status='지급완료'만. all이면 상태 무관.
    const scope = req.query.status_scope === 'all' ? 'all' : 'completed'
    const statusCond = (scope === 'completed' && kind === 'expense') ? " AND t.status = '지급완료'" : ''
    const AGG = measure === 'count' ? 'COUNT(*)' : 'COALESCE(SUM(t.amount), 0)'

    const where = ['t.kind = ?', 't.date BETWEEN ? AND ?']
    const params = [kind, from, to]
    // 화이트리스트 필터 (컬럼명은 코드 상수, 값만 바인딩)
    for (const [q, col] of [['vendor_id', 't.vendor_id'], ['contract_id', 't.contract_id'], ['category', 't.category'], ['item_id', 't.item_id']]) {
      if (req.query[q]) { where.push(`${col} = ?`); params.push(req.query[q]) }
    }
    const whereSql = where.join(' AND ') + statusCond

    if (!grp) {
      const [[row]] = await req.db.execute(
        `SELECT ${AGG} AS value, COUNT(*) AS cnt FROM transactions t WHERE ${whereSql}`, params)
      return res.json({ topic, measure, group: 'none', from, to,
        rows: [{ key: 'total', label: '합계', value: Number(row.value), count: Number(row.cnt) }],
        total: Number(row.value) })
    }
    const order = groupKey === 'month' ? `${grp.col} ASC` : 'value DESC'
    const [rows] = await req.db.execute(
      `SELECT ${grp.col} AS gkey, ${grp.label} AS label, ${AGG} AS value, COUNT(*) AS cnt
       FROM transactions t ${grp.join} WHERE ${whereSql}
       GROUP BY ${grp.col} ORDER BY ${order}`, params)
    const out = rows.map(r => ({ key: r.gkey, label: r.label || '(미지정)', value: Number(r.value), count: Number(r.cnt) }))
    res.json({ topic, measure, group: groupKey, from, to, rows: out, total: out.reduce((s, r) => s + r.value, 0) })
  } catch (e) { next(e) }
})

module.exports = router
