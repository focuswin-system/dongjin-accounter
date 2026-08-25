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
  'platform_admins', 'audit_logs', 'error_logs', 'tenant_migrations',
  'company_features', 'report_templates',
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
      -- 이 역할이 뭘 할 수 있는지 한 줄 설명. 역할 배정 화면이 이걸 보여준다
      -- (권한 개수는 사람이 판단할 수 있는 정보가 아니다 — '275개'로는 뭘 되는지 모른다).
      description VARCHAR(200) NULL,
      is_system  TINYINT DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_company_role (company_id, name),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    )
  `)
  // FK 필수 — 없으면 회사/계정이 지워져도 이 행이 남아 고아가 된다
  // (프로비저닝이 계정 생성 후 실패해 보상 정리될 때 실제로 발생했다).
  await c.execute(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id VARCHAR(36) NOT NULL,
      role_id VARCHAR(36) NOT NULL,
      PRIMARY KEY (user_id, role_id),
      KEY idx_user_roles_role (role_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
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
      KEY idx_audit_company_time (company_id, created_at),
      -- 로그인 시도 제한(lib/loginGuard.js)이 매 로그인마다 이 조합으로 조회한다.
      -- 인덱스가 없으면 감사 로그가 쌓일수록 로그인이 느려진다.
      KEY idx_audit_login_attempt (company_id, username, action, created_at)
    )
  `)

  /* 서버 오류 수집 — 지금까지는 장애를 고객이 전화로 알려줬다.
   *
   * stdout(systemd/pm2 로그)에도 그대로 찍히지만, 그건 서버에 들어가야 볼 수 있고
   * 재시작하면 흩어진다. 여기 쌓아두면 관리자 콘솔이 '최근 에러'를 바로 읽는다.
   *
   * ⚠ 저장되는 값은 반드시 lib/logSafe.js 의 safeErr()를 거친 것이어야 한다.
   *   원본 오류에는 SQL 파라미터 값(금액·거래처명)이 박혀 있다.
   *
   * fingerprint: 같은 오류를 묶는 열쇠. 이게 없으면 한 건이 300번 터진 것과
   * 서로 다른 300건을 구별할 수 없어, 목록만 보고는 심각도를 알 수 없다. */
  await c.execute(`
    CREATE TABLE IF NOT EXISTS error_logs (
      id          VARCHAR(36) PRIMARY KEY,
      company_id  VARCHAR(36),
      user_id     VARCHAR(36),
      username    VARCHAR(100),
      method      VARCHAR(10),
      path        VARCHAR(255),
      status      SMALLINT,
      code        VARCHAR(64),
      errno       INT,
      message     VARCHAR(500),
      stack       TEXT,
      fingerprint CHAR(40),
      release_id  VARCHAR(80),
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_error_time (created_at),
      KEY idx_error_group (fingerprint, created_at),
      KEY idx_error_company (company_id, created_at)
    )
  `)

  /* 화면 사용 집계 — "쓰긴 쓰나, 어디서 멈추나"를 보려고 둔다.
   *
   * 지금까지는 감사 로그(삭제·처리 같은 **행위**)와 로그인만 남아서, 가장 흔한 이탈 모습인
   * "들어와서 보기만 하고 나갔다"가 안 잡혔다. 회사별 마지막 로그인은 audit_logs 로 알 수
   * 있지만, 사용자별로 누가 안 들어오는지도, 어느 화면까지 갔다 되돌아가는지도 몰랐다.
   *
   * ⚠ 원본 한 줄씩 쌓지 않고 **(회사·사용자·날짜·화면) 하루 한 줄**로 누적한다.
   *   화면 이동마다 한 행이면 몇 달 만에 수백만 행이 되는데, 우리가 답해야 할 물음
   *   ("이 회사가 지난주에 어느 화면을 얼마나 썼나")에는 집계면 충분하다.
   *
   * ⚠ 남기는 것은 **화면 이름뿐**이다. 금액·거래처·대상 ID는 넣지 않는다
   *   (감사 로그 정책과 같다 — 진단에 필요한 최소만 남긴다). */
  await c.execute(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      company_id VARCHAR(36) NOT NULL,
      user_id    VARCHAR(36) NOT NULL,
      username   VARCHAR(100),
      day        DATE        NOT NULL,
      route      VARCHAR(60) NOT NULL,
      hits       INT         NOT NULL DEFAULT 0,
      last_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (company_id, user_id, day, route),
      KEY idx_usage_company_day (company_id, day),
      KEY idx_usage_last (company_id, last_at)
    )
  `)

  // 테넌트별 마이그레이션 적용 상태 (P3 러너가 사용)
  await c.execute(`
    /* 회사가 무엇을 쓸 수 있나(entitlement). **권한과 다른 축이다** —
       권한은 회사 안에서 마스터가 정하고, 이건 우리(공급자)가 정한다.
       ⚠ 회사 DB가 아니라 여기 있는 이유: 회사 DB에 두면 고객사 마스터가 자기 유료 기능을
         스스로 켤 수 있다. 보고서 말고 다른 유료 기능도 같은 표를 쓴다.
       설계: docs/02-design/features/company-report-templates.design.md §4.1 */
    CREATE TABLE IF NOT EXISTS company_features (
      id          VARCHAR(36) PRIMARY KEY,
      company_id  VARCHAR(36) NOT NULL,
      feature_key VARCHAR(80) NOT NULL,      -- 'report:defense' 처럼 '<영역>:<이름>'
      enabled     TINYINT NOT NULL DEFAULT 1, -- 0 = 회수(요금제로 받은 것도 뺀다)
      starts_on   DATE,                       -- 비면 즉시
      expires_on  DATE,                       -- 비면 무기한. 구독으로 팔 때만 채운다
      granted_by  VARCHAR(36),                -- platform_admins.id — 누가 켰나
      memo        VARCHAR(300),
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_company_feature (company_id, feature_key),
      KEY idx_cf_company (company_id)
    )
  `)

  /* 회사 전용·선언형 보고서 양식. **지금은 비어 있다** —
     P0에서는 내장 카탈로그(platform/reportCatalog.js)만 쓴다.
     definition(JSON)은 선언형 엔진(P3) 자리다. 스키마를 미리 두는 이유는,
     나중에 표를 새로 만들면서 기존 데이터를 옮기는 일을 피하기 위해서다. */
  await c.execute(`
    CREATE TABLE IF NOT EXISTS report_templates (
      id               VARCHAR(36) PRIMARY KEY,
      key_name         VARCHAR(80) NOT NULL UNIQUE,   -- 화면의 REPORT_VIEWS[key] 와 1:1
      title            VARCHAR(120) NOT NULL,
      descr            VARCHAR(300),
      kind             VARCHAR(20) NOT NULL DEFAULT 'custom',   -- builtin | custom
      scope            VARCHAR(20) NOT NULL DEFAULT 'entitled', -- all | entitled
      owner_company_id VARCHAR(36),                   -- custom 이면 그 회사 전용
      definition       JSON,                          -- P3(선언형)에서만 채운다
      active           TINYINT NOT NULL DEFAULT 1,
      sort_order       INT NOT NULL DEFAULT 100,
      created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_rt_owner (owner_company_id)
    )
  `)

  await c.execute(`
    CREATE TABLE IF NOT EXISTS tenant_migrations (
      db_name    VARCHAR(64) NOT NULL,
      version    VARCHAR(80) NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (db_name, version)
    )
  `)

  await migratePlatformSchema(c)
}

/**
 * 기존 설치본 보정 (멱등).
 * CREATE TABLE IF NOT EXISTS 는 이미 있는 테이블을 바꾸지 않으므로,
 * 나중에 추가한 제약은 여기서 따로 적용한다.
 */
async function migratePlatformSchema(c) {
  const [[{ db }]] = await c.execute('SELECT DATABASE() AS db')

  // user_roles 에 FK 추가 — 없으면 users/roles 가 지워져도 행이 남아 고아가 된다.
  const [[{ fkCnt }]] = await c.execute(
    `SELECT COUNT(*) AS fkCnt FROM information_schema.table_constraints
      WHERE table_schema = ? AND table_name = 'user_roles' AND constraint_type = 'FOREIGN KEY'`,
    [db]
  )
  if (fkCnt === 0) {
    // FK를 걸기 전에 기존 고아 행부터 정리해야 한다(있으면 ALTER 가 실패한다).
    const [o1] = await c.execute(
      'DELETE ur FROM user_roles ur LEFT JOIN users u ON u.id = ur.user_id WHERE u.id IS NULL'
    )
    const [o2] = await c.execute(
      'DELETE ur FROM user_roles ur LEFT JOIN roles r ON r.id = ur.role_id WHERE r.id IS NULL'
    )
    const removed = (o1.affectedRows || 0) + (o2.affectedRows || 0)
    if (removed > 0) console.log(`[platform] user_roles 고아 행 ${removed}건 정리`)
    try {
      await c.execute('ALTER TABLE user_roles ADD KEY idx_user_roles_role (role_id)')
    } catch { /* 이미 있으면 무시 */ }
    try {
      await c.execute(`ALTER TABLE user_roles
        ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        ADD FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE`)
      console.log('[platform] user_roles FK 추가 완료')
    } catch (e) {
      console.warn('[platform] user_roles FK 추가 실패:', e.code || e.message)
    }
  }

  /* roles.description — 기존 설치본에는 CREATE TABLE IF NOT EXISTS 로 붙지 않는다.
     (컬럼명이 description 인 이유: `describe` 는 MariaDB 예약어라 백틱 없이는 문법 오류다)
     역할 배정 화면이 이 값을 보여주므로, 없으면 설명 없는 카드가 된다. */
  const [[{ dcnt }]] = await c.execute(
    `SELECT COUNT(*) AS dcnt FROM information_schema.columns
      WHERE table_schema = ? AND table_name = 'roles' AND column_name = 'description'`, [db])
  if (dcnt === 0) {
    try {
      await c.execute('ALTER TABLE roles ADD COLUMN description VARCHAR(200) NULL AFTER name')
      console.log('[platform] roles.description 컬럼 추가 완료')
    } catch (e) { console.warn('[platform] roles.description 추가 실패:', e.code || e.message) }
  }

  /* 자원 분리 이관 — 한 화면을 둘로 쪼갤 때 **권한이 조용히 회수되지 않게** 한다.
   *
   * '계좌/카드' 한 화면을 '계좌'와 '카드'로 갈랐다. 새 자원(master_card)은 아무 역할에도
   * 없으므로, 그냥 두면 어제까지 카드를 관리하던 사람이 오늘 카드 화면에서 튕긴다.
   * 시스템 역할은 프리셋 보충(ensurePresetRoles)이 알아서 채우지만, 회사가 직접 만든
   * 커스텀 역할은 프리셋을 타지 않아 영영 못 받는다 — 그래서 여기서 옮긴다.
   *
   * 규칙: 옛 자원에 있던 **행위 그대로** 새 자원에 복사한다(view 만 있으면 view 만).
   * INSERT IGNORE 라 이미 손수 조정한 회사의 값은 건드리지 않고, 여러 번 돌아도 안전하다. */
  /* 화면 하나를 둘로 가를 때, 원래 화면 권한을 가진 사람이 새 화면도 그대로 보게 한다.
     안 하면 어제까지 하던 일을 오늘 못 하게 되고, 사용자는 기능이 사라진 줄 안다.
     ['계좌 이체' → '카드 대금 지급'] — 카드값 처리는 원래 그 화면 안에 있던 기능이다. */
  const RESOURCE_SPLITS = [['master_account', 'master_card'], ['transfer', 'card_payment']]
  for (const [from, to] of RESOURCE_SPLITS) {
    const [r] = await c.execute(
      `INSERT IGNORE INTO role_perms (role_id, resource, action)
       SELECT role_id, ?, action FROM role_perms WHERE resource = ?`, [to, from])
    if (r.affectedRows > 0) console.log(`[platform] 권한 이관 ${from} → ${to}: ${r.affectedRows}건`)
  }

  /* 시스템 역할 이름 변경. 역할 id 를 그대로 두고 name 만 바꾸므로
     이미 배정된 사용자·권한 행(user_roles·role_perms)은 손대지 않는다.
     ⚠ (company_id, name) 유니크라, 옮길 이름이 이미 있으면 충돌한다 → 그 회사는 건너뛴다
       (직접 만든 동명 역할을 덮어쓰지 않는 쪽이 안전하다). */
  const ROLE_RENAMES = [['경리', '실무']]
  for (const [from, to] of ROLE_RENAMES) {
    const [olds] = await c.execute(
      'SELECT id, company_id FROM roles WHERE name = ? AND is_system = 1', [from])
    for (const r of olds) {
      const [[clash]] = await c.execute(
        'SELECT id FROM roles WHERE company_id = ? AND name = ?', [r.company_id, to])
      if (clash) { console.warn(`[platform] 역할 '${from}'→'${to}' 건너뜀 — 이미 '${to}'가 있음 (회사 ${r.company_id})`); continue }
      await c.execute('UPDATE roles SET name = ? WHERE id = ?', [to, r.id])
      console.log(`[platform] 역할 이름 변경 '${from}' → '${to}' (회사 ${r.company_id})`)
    }
  }

  // 로그인 시도 제한 조회용 인덱스 — 기존 설치본에는 audit_logs가 이미 있어
  // CREATE TABLE IF NOT EXISTS 로는 붙지 않는다.
  const [[{ idxCnt }]] = await c.execute(
    `SELECT COUNT(*) AS idxCnt FROM information_schema.statistics
      WHERE table_schema = ? AND table_name = 'audit_logs'
        AND index_name = 'idx_audit_login_attempt'`,
    [db]
  )
  if (idxCnt === 0) {
    try {
      await c.execute(
        'ALTER TABLE audit_logs ADD KEY idx_audit_login_attempt (company_id, username, action, created_at)'
      )
      console.log('[platform] audit_logs 로그인 시도 인덱스 추가 완료')
    } catch (e) {
      console.warn('[platform] audit_logs 인덱스 추가 실패:', e.code || e.message)
    }
  }
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
 * 회사에 기본 역할(마스터/실무/조회전용) + 권한 매트릭스를 만든다. 이미 있으면 건너뛴다(멱등).
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
      await c.execute('INSERT INTO roles (id, company_id, name, description, is_system) VALUES (?,?,?,?,?)',
        [roleId, companyId, preset.name, preset.describe || null, preset.isSystem ? 1 : 0])
      created++
    } else if (preset.isSystem) {
      // 설명은 코드가 진실이다 — 프리셋 문구를 고치면 기존 회사에도 반영한다.
      await c.execute('UPDATE roles SET description = ? WHERE id = ?', [preset.describe || null, roleId])
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
