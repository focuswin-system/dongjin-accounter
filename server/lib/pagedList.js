// 문서 목록 공용 페이지네이션·필터 — 정산내역서·구매품의서·견적요청서·지급결의서가 함께 쓴다.
//
// 규칙: 요청에 q(검색)·from/to(기간)·vendor(거래처)·status(상태)·limit/offset 중 **하나라도** 있으면
//   '페이지 모드'. 화면 목록은 페이지로 부르고, 문서를 후보로 끌어오는 쪽(예: 정산이 결의서를 후보로)은
//   파라미터 없이 불러 **예전처럼 배열 전체**를 받는다 — 그 계약을 안 깨려고 paged 로 가른다.
//
// ── 기간은 **문서 날짜**로 거른다 ──
//   예전엔 작성일(created_at)이었다. 그러면 지난달 품의를 오늘 적으면 '이번 달'에 잡힌다 —
//   사람은 종이에 찍힌 날짜(품의일자·지급일·정산일)로 찾는다. 문서 날짜가 비었을 때만 작성일을 쓴다.
//   문서 날짜 칸은 VARCHAR 'YYYY-MM-DD' 라 문자열 비교가 곧 날짜 비교다(화면이 날짜 입력으로만 받는다).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// 요청에서 페이지·필터 파라미터를 뽑는다. limit 은 1~200 으로 가둔다(한 번에 과다 로드 방지).
function pageParams(req) {
  const q = String(req.query.q || '').trim()
  // 날짜 모양이 아니면 버린다 — 그대로 SQL 에 넘기면 문자열 비교가 엉뚱한 범위를 만든다
  const from = DATE_RE.test(req.query.from || '') ? req.query.from : null
  const to = DATE_RE.test(req.query.to || '') ? req.query.to : null
  const vendorId = String(req.query.vendor_id || '').trim() || null
  const vendor = String(req.query.vendor || '').trim() || null
  const status = String(req.query.status || '').trim() || null
  const paged = !!(q || from || to || vendorId || vendor || status || req.query.limit != null || req.query.offset != null)
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200)
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)
  return { q, from, to, vendorId, vendor, status, paged, limit, offset }
}

/** 문서 날짜 칸 → 비교에 쓸 SQL 식. 비었으면 작성일. col 은 코드에 박힌 칼럼명만 넣는다(사용자 값 금지). */
const docDateExpr = (col, prefix = '') =>
  `COALESCE(NULLIF(${prefix}${col}, ''), DATE_FORMAT(${prefix}created_at, '%Y-%m-%d'))`

/**
 * q/from/to/vendor/status 로 WHERE 절과 바인딩 배열을 만든다.
 *   searchCols : 검색어를 OR 로 걸 컬럼들(예: ['doc_no','vendor_name','summary'])
 *   opts.dateExpr : 기간 비교 SQL 식(docDateExpr 로 만든다). 기본은 작성일
 *   opts.prefix   : JOIN 이 있어 컬럼에 별칭이 필요할 때(예: 'er.')
 *   opts.vendor   : true 면 vendor_id / vendor_name 으로 거른다.
 *                   거래처를 목록에서 골랐으면 id 로, 등록 안 된 이름이면 이름으로 —
 *                   문서에는 id 없이 이름만 적힌 옛 행이 있어서 둘 다 본다.
 *   opts.statusSql: (status) => { sql, args } | null — 문서마다 상태 뜻이 달라 부르는 쪽이 정한다
 */
function buildWhere(pp, searchCols, opts = {}) {
  const { prefix = '', dateExpr = `DATE_FORMAT(${prefix}created_at, '%Y-%m-%d')`, vendor = false, statusSql = null } = opts
  const where = []
  const args = []
  if (pp.q) {
    const like = `%${pp.q}%`
    where.push('(' + searchCols.map(c => `${c.includes('.') ? c : prefix + c} LIKE ?`).join(' OR ') + ')')
    for (const _ of searchCols) args.push(like)
  }
  if (pp.from) { where.push(`${dateExpr} >= ?`); args.push(pp.from) }
  if (pp.to)   { where.push(`${dateExpr} <= ?`); args.push(pp.to) }
  if (vendor && (pp.vendorId || pp.vendor)) {
    if (pp.vendorId && pp.vendor) {
      where.push(`(${prefix}vendor_id = ? OR (${prefix}vendor_id IS NULL AND ${prefix}vendor_name = ?))`)
      args.push(pp.vendorId, pp.vendor)
    } else if (pp.vendorId) {
      where.push(`${prefix}vendor_id = ?`); args.push(pp.vendorId)
    } else {
      where.push(`${prefix}vendor_name = ?`); args.push(pp.vendor)
    }
  }
  if (pp.status && statusSql) {
    const s = statusSql(pp.status)
    if (s) { where.push(s.sql); args.push(...(s.args || [])) }
  }
  return { whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', args }
}

/**
 * 승인 흐름이 있는 문서(구매품의서·지급결의서)의 상태 필터.
 *   pending  아직 안 끝난 것(작성·승인) — '할 일' 큐
 *   작성 / 승인 / 완료
 * 옛 행은 status 가 비어 있을 수 있다 — 작성으로 본다.
 */
const approvalStatusSql = (prefix = '') => (status) => {
  const col = `COALESCE(NULLIF(${prefix}status, ''), '작성')`
  if (status === 'pending') return { sql: `${col} <> '완료'`, args: [] }
  if (['작성', '승인', '완료'].includes(status)) return { sql: `${col} = ?`, args: [status] }
  return null
}

/** 상태별 건수(작성·승인) — 필터 칩 옆 숫자. 검색·기간과 무관한 **할 일 크기**다. */
async function approvalCounts(db, table) {
  if (!['purchase_reqs', 'expense_resolutions'].includes(table)) throw new Error('approvalCounts: 알 수 없는 표')
  const [rows] = await db.execute(
    `SELECT COALESCE(NULLIF(status, ''), '작성') AS s, COUNT(*) AS n FROM ${table} GROUP BY COALESCE(NULLIF(status, ''), '작성')`)
  return Object.fromEntries(rows.map(r => [r.s, Number(r.n)]))
}

// 합계·부가정보를 이 페이지 행들에만 붙이도록 IN(...) 자리표시자를 만든다(전체 스캔 방지).
//   빈 배열이면 { clause:'', ids:[] } — 호출부가 SUM 질의를 건너뛰게 한다.
function inClause(ids) {
  if (!ids.length) return { clause: '', ids: [] }
  return { clause: `(${ids.map(() => '?').join(',')})`, ids }
}

module.exports = { pageParams, buildWhere, inClause, docDateExpr, approvalStatusSql, approvalCounts }
