/**
 * 로그 위생 — 서버 로그에 남의 회사 기밀이 새지 않게 오류를 다듬는다.
 *
 * 이 서비스는 한 서버에서 여러 회사의 회계 데이터를 다룬다. 로그는 운영자(우리 회사)가
 * 보는 것이고, 장애 추적에 필요한 최소한만 남겨야 한다.
 *
 *   남긴다  — 누가·언제·무엇을(경로)·오류 코드·성공/실패
 *   안 남긴다 — 금액, 거래처명, 계좌번호, 품목·계약명, 요청 본문, SQL 파라미터 값
 *
 * ⚠ 진짜 위험은 '의도적으로 남긴 로그'가 아니라 **새는 로그**다.
 * 대표적인 두 가지:
 *
 *   1) MariaDB 오류 메시지에 값이 박혀 온다.
 *      Duplicate entry 'INV-2026-0001' for key 'uq_invoice_no'
 *      → 청구번호·사업자번호 같은 실제 데이터가 그대로 로그에 남는다.
 *
 *   2) mysql2 오류 객체에는 실행한 SQL(err.sql)이 붙는다.
 *      오류를 통째로 console.error 하면 쿼리문과 값이 함께 찍힌다.
 *
 * 그래서 오류는 반드시 safeErr()를 거쳐 찍는다.
 */

/** 스택에서 남길 프레임 수. 원인 지점을 짚기엔 충분하고 로그를 덮지는 않는다. */
const STACK_FRAMES = 4

/**
 * SQL 오류 메시지에서 값을 가린다.
 *
 * 중복 오류는 **어느 제약이 걸렸는지(키 이름)가 진단의 핵심**이라 키는 남기고 값만 가린다.
 * 그 외 메시지는 어떤 따옴표 리터럴이 값인지 형태로 구분할 수 없으므로 전부 가린다.
 */
function maskSqlMessage(msg) {
  const s = String(msg == null ? '' : msg)
  const dup = s.match(/^Duplicate entry '[\s\S]*' for key '([^']*)'$/)
  if (dup) return `Duplicate entry '···' for key '${dup[1]}'`
  return s.replace(/'(?:[^'\\]|\\.)*'/g, "'···'")
}

/** 스택에서 프레임 줄만 추린다. 첫 줄(= 오류 메시지 원문)은 버린다 — 거기로도 값이 샌다. */
function frames(stack) {
  if (!stack) return undefined
  const out = String(stack)
    .split('\n')
    .filter(l => /^\s+at\s/.test(l))
    .slice(0, STACK_FRAMES)
    .map(l => l.trim())
  return out.length ? out : undefined
}

/** mysql2 계열 오류인가 — 메시지에 파라미터 값이 섞여 오는 부류 */
const isSqlError = e => Boolean(e.sqlMessage || e.sqlState || e.errno)

/**
 * 로그에 찍어도 되는 형태로 오류를 다듬는다.
 *
 * SQL 오류는 메시지를 마스킹한다(값이 박혀 오므로). 일반 JS 오류(TypeError 등)의
 * 메시지는 런타임이 만든 문장이라 값이 들어갈 여지가 적고, 가리면 원인 파악이
 * 어려워지므로 그대로 둔다. 대신 err.sql 은 어느 경우에도 절대 싣지 않는다.
 */
function safeErr(err) {
  if (err == null) return { message: '(오류 객체 없음)' }
  if (typeof err !== 'object') return { message: maskSqlMessage(err) }

  const out = {}
  if (err.name && err.name !== 'Error') out.name = err.name
  if (err.code) out.code = err.code
  if (err.errno) out.errno = err.errno
  if (err.sqlState) out.sqlState = err.sqlState

  out.message = isSqlError(err)
    ? maskSqlMessage(err.sqlMessage || err.message)
    : String(err.message == null ? err : err.message)

  const at = frames(err.stack)
  if (at) out.at = at
  return out
}

/**
 * 요청의 신원 꼬리표 — '어느 회사의 누가 무엇을 하다가' 를 한 줄로.
 *
 * 이게 없으면 `[500] POST /api/transactions` 만 남아, 어느 회사에서 터진 장애인지
 * 알 수 없다. 테넌트가 여럿인 이상 회사 식별자는 로그의 필수 항목이다.
 * (경로의 쿼리스트링은 전부 ID·enum·날짜라 그대로 남겨도 값이 새지 않는다)
 */
function reqTag(req) {
  if (!req) return '-'
  const u = req.user
  const who = u ? `${u.dbName || u.companyId || '?'}/${u.username || u.id || '?'}` : '비로그인'
  return `${who} ${req.method} ${req.originalUrl || req.path || '-'}`
}

module.exports = { safeErr, reqTag, maskSqlMessage }
