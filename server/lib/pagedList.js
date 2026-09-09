// 문서 목록 공용 페이지네이션 — 정산내역서·구매품의서·견적요청서·지급결의서가 함께 쓴다.
//
// 규칙: 요청에 q(검색)·from/to(기간)·limit/offset 중 **하나라도** 있으면 '페이지 모드'.
//   화면 목록은 페이지로 부르고, 문서를 후보로 끌어오는 쪽(예: 정산이 결의서를 후보로)은
//   파라미터 없이 불러 **예전처럼 배열 전체**를 받는다 — 그 계약을 안 깨려고 paged 로 가른다.
//
// ⚠ 기간은 5종 공통으로 created_at(작성일) 기준. 문서마다 자기 날짜(pay_date·settle_date)가
//   varchar 라 정렬·비교가 들쭉날쭉이다. created_at 은 TIMESTAMP 라 항상 일관된다.

// 요청에서 페이지 파라미터를 뽑는다. limit 은 1~200 으로 가둔다(한 번에 과다 로드 방지).
function pageParams(req) {
  const q = (req.query.q || '').trim()
  const from = req.query.from || null
  const to = req.query.to || null
  const paged = !!(q || from || to || req.query.limit != null || req.query.offset != null)
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200)
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)
  return { q, from, to, paged, limit, offset }
}

// q/from/to 로 WHERE 절과 바인딩 배열을 만든다.
//   searchCols: 검색어를 OR 로 걸 컬럼들(예: ['doc_no','vendor_name','summary'])
//   dateCol   : 기간을 비교할 컬럼(기본 created_at)
//   prefix    : JOIN 이 있어 컬럼에 별칭이 필요할 때(예: 'er.'). 기본 없음.
function buildWhere({ q, from, to }, searchCols, dateCol = 'created_at', prefix = '') {
  const where = []
  const args = []
  if (q) {
    const like = `%${q}%`
    where.push('(' + searchCols.map(c => `${prefix}${c} LIKE ?`).join(' OR ') + ')')
    for (const _ of searchCols) args.push(like)
  }
  if (from) { where.push(`${prefix}${dateCol} >= ?`); args.push(from + ' 00:00:00') }
  if (to)   { where.push(`${prefix}${dateCol} <= ?`); args.push(to + ' 23:59:59') }
  return { whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', args }
}

// 합계·부가정보를 이 페이지 행들에만 붙이도록 IN(...) 자리표시자를 만든다(전체 스캔 방지).
//   빈 배열이면 { clause:'', ids:[] } — 호출부가 SUM 질의를 건너뛰게 한다.
function inClause(ids) {
  if (!ids.length) return { clause: '', ids: [] }
  return { clause: `(${ids.map(() => '?').join(',')})`, ids }
}

module.exports = { pageParams, buildWhere, inClause }
