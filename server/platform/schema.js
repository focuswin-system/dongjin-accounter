/**
 * 공용 관리 DB 스키마 (DDL) + 최초 부트스트랩
 *
 * ⚠ 이 파일의 함수는 전부 DDL을 실행하므로 **관리 계정(withAdmin)** 으로만 호출한다.
 *   앱 런타임 계정은 DDL 권한이 없다 — 스키마 작업은 배포 시점(scripts/setup-db.js)에만 수행.
 *
 * 설계: docs/02-design/features/multi-tenant-saas.design.md §3.1
 */
const { randomUUID } = require('crypto')

/** 공용 DB에 있어야 하는 테이블 — 준비 상태 점검(assertPlatformReady)에도 쓰인다. */
const PLATFORM_TABLES = [
  'companies', 'users', 'roles', 'user_roles', 'role_perms',
  'platform_admins', 'audit_logs', 'tenant_migrations',
]

/**
 * 공용 관리 DB 스키마 생성 (멱등).
 * @param {import('mysql2/promise').Connection} c 관리 계정 연결 (해당 DB에 접속된 상태)
 */
async function createPlatformSchema(c) {
  // 회사(테넌트) 레지스트리 — code로 로그인, db_name으로 데이터 DB 라우팅
  await c.execute(`
    CREATE TABLE IF NOT EXISTS companies (
      id         VARCHAR(36) PRIMARY KEY,
      code       VARCHAR(20) NOT NULL UNIQUE,
      name       VARCHAR(255) NOT NULL,
      db_name    VARCHAR(64) NOT NULL UNIQUE,
      plan       VARCHAR(30)  DEFAULT 'basic',
      status     VARCHAR(20)  DEFAULT 'active',
      active     TINYINT      DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // 로그인 주체. username은 전역이 아니라 '회사 안에서' 유일하다.
  // → A사 '24'와 B사 '24'가 독립 공존한다. 이 복합 유니크가 테넌트 스코프 인증의 핵심.
  await c.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id             VARCHAR(36) PRIMARY KEY,
      company_id     VARCHAR(36) NOT NULL,
      username       VARCHAR(100) NOT NULL,
      password       VARCHAR(255) NOT NULL,
      name           VARCHAR(100),
      email          VARCHAR(200),
      role           VARCHAR(20) DEFAULT 'user',
      must_change_pw TINYINT DEFAULT 0,
      active         TINYINT DEFAULT 1,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_company_user (company_id, username),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    )
  `)

  // ── 권한 (P5에서 본격 사용) ──
  await c.execute(`
    CREATE TABLE IF NOT EXISTS roles (
      id         VARCHAR(36) PRIMARY KEY,
      company_id VARCHAR(36) NOT NULL,
      name       VARCHAR(50) NOT NULL,
      is_system  TINYINT DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_company_role (company_id, name),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id VARCHAR(36) NOT NULL,
      role_id VARCHAR(36) NOT NULL,
      PRIMARY KEY (user_id, role_id)
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS role_perms (
      role_id  VARCHAR(36) NOT NULL,
      resource VARCHAR(40) NOT NULL,
      action   VARCHAR(20) NOT NULL,
      PRIMARY KEY (role_id, resource, action),
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    )
  `)

  // 운영자(우리) 계정 — 회사 관리자와 별개
  await c.execute(`
    CREATE TABLE IF NOT EXISTS platform_admins (
      id         VARCHAR(36) PRIMARY KEY,
      username   VARCHAR(100) NOT NULL UNIQUE,
      password   VARCHAR(255) NOT NULL,
      name       VARCHAR(100),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // 감사 로그 — 회계·방산 특성상 '누가 언제 무엇을'
  await c.execute(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id         VARCHAR(36) PRIMARY KEY,
      company_id VARCHAR(36),
      user_id    VARCHAR(36),
      username   VARCHAR(100),
      action     VARCHAR(40),
      resource   VARCHAR(40),
      target_id  VARCHAR(64),
      ip         VARCHAR(45),
      detail     TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_audit_company_time (company_id, created_at)
    )
  `)

  // 테넌트별 마이그레이션 적용 상태 (P3 러너가 사용)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS tenant_migrations (
      db_name    VARCHAR(64) NOT NULL,
      version    VARCHAR(80) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (db_name, version)
    )
  `)
}

/**
 * 기존 단일 테넌트를 첫 회사로 흡수한다 (companies가 비어 있을 때만 1회).
 * 레거시 DB의 users를 bcrypt 해시째 옮기므로 기존 비밀번호가 그대로 유지된다.
 *
 * @param {import('mysql2/promise').Connection} c        공용 DB 연결
 * @param {import('mysql2/promise').Connection} legacyConn 레거시 테넌트 DB 연결 (없으면 null)
 * @param {{ code: string, dbName: string, fallbackName?: string }} opts
 * @returns {Promise<{skipped: boolean, reason?: string, code?: string, users?: number}>}
 */
async function bootstrapFirstCompany(c, legacyConn, { code, dbName, fallbackName }) {
  const [[{ cnt }]] = await c.execute('SELECT COUNT(*) AS cnt FROM companies')
  if (cnt > 0) return { skipped: true, reason: '이미 회사가 등록되어 있습니다' }
  if (!legacyConn) return { skipped: true, reason: '레거시 DB에 접근할 수 없습니다' }

  let legacyName = null
  let legacyUsers = []
  try {
    const [rows] = await legacyConn.execute('SELECT name FROM company_info LIMIT 1')
    legacyName = rows[0]?.name || null
  } catch { /* company_info 없음 — 무시 */ }
  try {
    const [rows] = await legacyConn.execute(
      'SELECT id, username, password, name, role, active FROM users ORDER BY created_at'
    )
    legacyUsers = rows
  } catch { /* users 없음 — 무시 */ }

  if (legacyUsers.length === 0) {
    return { skipped: true, reason: '레거시 users가 비어 있습니다' }
  }

  const companyId = randomUUID()
  await c.execute(
    'INSERT INTO companies (id, code, name, db_name, status, active) VALUES (?,?,?,?,?,1)',
    [companyId, code, legacyName || fallbackName || '기본 회사', dbName, 'active']
  )
  for (const u of legacyUsers) {
    await c.execute(
      'INSERT INTO users (id, company_id, username, password, name, role, active) VALUES (?,?,?,?,?,?,?)',
      [u.id, companyId, u.username, u.password, u.name || '', u.role || 'user', u.active ? 1 : 0]
    )
  }
  // 신규 생성(provisionTenant)과 동일하게 기본 역할을 만들어 준다.
  // 이게 빠지면 '이전해 온 회사만 역할이 없는' 상태가 되어 권한 관리(P5)에서 갈라진다.
  const roles = await ensurePresetRoles(c, companyId)
  // 기존 admin 계정은 마스터 역할에 연결
  if (roles.masterRoleId) {
    for (const u of legacyUsers.filter(x => (x.role || 'user') === 'admin')) {
      await c.execute('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)',
        [u.id, roles.masterRoleId])
    }
  }
  return { skipped: false, code, users: legacyUsers.length, companyId, roles: roles.created }
}

/**
 * 회사에 기본 역할(마스터/경리/조회전용) + 권한 매트릭스를 만든다. 이미 있으면 건너뛴다(멱등).
 * provisionTenant(신규 회사)와 bootstrapFirstCompany(기존 회사 흡수) 양쪽에서 쓴다.
 */
async function ensurePresetRoles(c, companyId) {
  // 순환 참조를 피하려고 지연 로드 (permissions는 순수 데이터 모듈)
  const { PRESET_ROLES, expandPresetPerms } = require('./permissions')
  let created = 0
  let masterRoleId = null
  let backfilled = 0
  for (const preset of PRESET_ROLES) {
    const [[exist]] = await c.execute(
      'SELECT id FROM roles WHERE company_id = ? AND name = ?', [companyId, preset.name]
    )
    let roleId = exist?.id
    if (!roleId) {
      roleId = randomUUID()
      await c.execute('INSERT INTO roles (id, company_id, name, is_system) VALUES (?,?,?,?)',
        [roleId, companyId, preset.name, preset.isSystem ? 1 : 0])
      created++
    }
    // ⚠ 역할이 이미 있어도 권한 행은 항상 채워 넣는다.
    //   건너뛰면, 나중에 permissions.js에 자원이 추가돼도(예: mgmt_ask) 기존 회사의
    //   '마스터' 역할에는 그 권한이 영영 생기지 않아 새 화면에 못 들어간다.
    //   INSERT IGNORE라 이미 있는 행은 건드리지 않는다 —
    //   ⚠ 단 이는 '프리셋에 있는 권한을 보충'만 한다. 마스터가 의도적으로 **뺀** 권한도
    //     다시 채워지므로, 시스템 역할(is_system)에 한해서만 수행한다.
    if (preset.isSystem) {
      for (const [resource, action] of expandPresetPerms(preset.perms)) {
        const [r] = await c.execute(
          'INSERT IGNORE INTO role_perms (role_id, resource, action) VALUES (?,?,?)',
          [roleId, resource, action])
        if (r.affectedRows > 0 && exist) backfilled++
      }
    }
    if (preset.name === '마스터') masterRoleId = roleId
  }
  return { created, backfilled, masterRoleId }
}

module.exports = { PLATFORM_TABLES, createPlatformSchema, bootstrapFirstCompany, ensurePresetRoles }
