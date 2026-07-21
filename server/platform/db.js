/**
 * 공용 관리 DB (control-plane) — 런타임 접근 계층
 *
 * ── 권한 분리 원칙 ──
 * 런타임(이 풀)  : 앱 계정. DML만 수행한다. DDL 권한을 갖지 않는다.
 * 관리(withAdmin): 관리 계정. CREATE DATABASE·ALTER 등 DDL 전용.
 *                  상시 연결을 유지하지 않고 필요할 때 열었다가 즉시 닫는다.
 *                  배포 시점 스크립트(scripts/setup-db.js, provision-tenant.js)에서만 쓴다.
 *
 * 이 분리 덕분에 웹 요청 경로가 탈취돼도 스키마를 건드리거나 DB를 만들 수 없다.
 *
 * 설계: docs/02-design/features/multi-tenant-saas.design.md §3.1
 */
require('dotenv').config()
const mysql = require('mysql2/promise')
const { randomUUID } = require('crypto')
const { PLATFORM_TABLES } = require('./schema')

const PLATFORM_DB = process.env.PLATFORM_DB_NAME || 'acct_platform'

// ── 런타임(DML) 계정 ──
const appConfig = {
  host:     process.env.DB_HOST     || 'localhost',
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  charset:  'utf8',
}

// ── 관리(DDL) 계정 ── 미설정이면 앱 계정으로 폴백(개발 편의). 운영에서는 반드시 분리한다.
const hasDedicatedAdmin = () => !!process.env.DB_ADMIN_USER
const adminConfig = () => ({
  host:     process.env.DB_HOST || 'localhost',
  user:     process.env.DB_ADMIN_USER     || appConfig.user,
  password: process.env.DB_ADMIN_PASSWORD ?? appConfig.password,
  charset:  'utf8',
})

// DB 이름은 SQL 식별자라 파라미터 바인딩이 불가능하다 → 반드시 검증 후 보간한다.
const DB_NAME_RE = /^[A-Za-z0-9_]{1,64}$/
function assertDbName(name) {
  if (!DB_NAME_RE.test(String(name || ''))) throw new Error(`허용되지 않는 DB 이름: ${name}`)
  return name
}

// ── 회사코드(slug) 규칙 — 설계 §2.1 ──
// 소문자 영숫자+하이픈 4~20자. 생성 후 불변(변경은 슈퍼관리자만).
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,18}[a-z0-9]$/
const RESERVED_CODES = new Set([
  'admin', 'administrator', 'api', 'www', 'app', 'login', 'logout', 'signup',
  'platform', 'system', 'root', 'static', 'assets', 'uploads', 'health',
  'support', 'help', 'billing', 'account', 'accounts', 'null', 'undefined',
])
function validateCompanyCode(code) {
  const c = String(code || '').trim().toLowerCase()
  if (!SLUG_RE.test(c)) return { ok: false, error: '회사코드는 소문자 영문·숫자·하이픈 4~20자여야 합니다' }
  if (RESERVED_CODES.has(c)) return { ok: false, error: '사용할 수 없는 회사코드입니다' }
  return { ok: true, code: c }
}

/** 런타임 풀 — DML 전용. */
const platformPool = mysql.createPool({
  ...appConfig,
  database:           PLATFORM_DB,
  waitForConnections: true,
  connectionLimit:    10,
})

/**
 * 관리 계정으로 DDL을 수행한다. 연결은 매번 열고 반드시 닫는다(상시 유지 금지).
 * @param {(conn: import('mysql2/promise').Connection) => Promise<any>} fn
 * @param {{ database?: string }} [opts] 특정 DB에 접속한 상태로 열려면 지정
 */
async function withAdmin(fn, { database } = {}) {
  const cfg = adminConfig()
  if (database) cfg.database = assertDbName(database)
  let conn
  try {
    conn = await mysql.createConnection(cfg)
  } catch (e) {
    throw new Error(
      `관리 계정(${cfg.user})으로 DB에 접속하지 못했습니다: ${e.code || e.message}\n` +
      `  → server/.env의 DB_ADMIN_USER / DB_ADMIN_PASSWORD를 확인하세요.`
    )
  }
  try {
    return await fn(conn)
  } finally {
    await conn.end().catch(() => {})
  }
}

/**
 * 공용 DB가 사용할 준비가 됐는지 확인한다(런타임 계정 기준, DDL 없음).
 * 부팅 시 호출해 문제를 '조용한 런타임 에러'가 아니라 '명확한 기동 실패'로 만든다.
 */
async function assertPlatformReady() {
  let rows
  try {
    ;[rows] = await platformPool.query(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?`,
      [PLATFORM_DB]
    )
  } catch (e) {
    throw new Error(
      `공용 관리 DB(${PLATFORM_DB})에 접근할 수 없습니다: ${e.code || e.message}\n` +
      `  → 최초 1회 준비가 필요합니다:  npm run setup:db\n` +
      `  → 권한 상태를 보려면:          npm run check:db`
    )
  }
  const present = new Set(rows.map(r => String(r.t || r.TABLE_NAME).toLowerCase()))
  const missing = PLATFORM_TABLES.filter(t => !present.has(t))
  if (missing.length) {
    throw new Error(
      `공용 관리 DB(${PLATFORM_DB}) 스키마가 불완전합니다. 누락: ${missing.join(', ')}\n` +
      `  → 준비 명령:  npm run setup:db`
    )
  }
  const [[{ cnt }]] = await platformPool.execute('SELECT COUNT(*) AS cnt FROM companies')
  if (cnt === 0) {
    throw new Error(
      `등록된 회사가 없습니다. 로그인할 수 없는 상태입니다.\n` +
      `  → 기존 데이터를 첫 회사로 흡수:  npm run setup:db`
    )
  }
}

/**
 * 감사 로그 기록. 실패해도 본 요청을 막지 않는다(로그 때문에 업무가 멈추면 안 됨).
 */
function audit({ companyId, userId, username, action, resource, targetId, ip, detail }) {
  platformPool
    .execute(
      `INSERT INTO audit_logs (id, company_id, user_id, username, action, resource, target_id, ip, detail)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [randomUUID(), companyId || null, userId || null, username || null, action || null,
       resource || null, targetId || null, ip || null, detail || null]
    )
    .catch(e => console.warn('[audit] 기록 실패:', e.code || e.message))
}

module.exports = {
  platformPool,
  PLATFORM_DB,
  appConfig,
  adminConfig,
  hasDedicatedAdmin,
  withAdmin,
  assertPlatformReady,
  assertDbName,
  validateCompanyCode,
  audit,
}
