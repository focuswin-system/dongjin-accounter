#!/usr/bin/env node
/**
 * DB 준비 스크립트 (배포/최초 설치 시 1회, 멱등)
 *
 *   node scripts/setup-db.js          전체 준비
 *   node scripts/setup-db.js --check  변경 없이 상태만 점검
 *
 * 하는 일:
 *   1) 공용 관리 DB(acct_platform) 생성 + 스키마
 *   2) 테넌트 DB(DB_NAME) 스키마·마이그레이션 적용
 *   3) 최초 1회 부트스트랩 — 기존 단일 테넌트를 '첫 회사'로 등록하고 계정을 공용 DB로 이전
 *
 * ⚠ DDL을 수행하므로 관리 계정(DB_ADMIN_USER)으로 동작한다.
 *   앱 런타임 계정은 DDL 권한이 없어야 정상이다 — 권한 분리는 check-db.js로 확인.
 */
require('dotenv').config()
const {
  platformPool, PLATFORM_DB, withAdmin, assertDbName, validateCompanyCode, hasDedicatedAdmin, adminConfig,
} = require('../platform/db')
const { createPlatformSchema, bootstrapFirstCompany, ensurePresetRoles } = require('../platform/schema')
const { initDb } = require('../db')

const CHECK_ONLY = process.argv.includes('--check')
const TENANT_DB = assertDbName(process.env.DB_NAME || 'dongjin_erp')

const log  = (...a) => console.log(...a)
const step = (n, msg) => console.log(`\n[${n}] ${msg}`)

async function main() {
  log('━'.repeat(60))
  log(' focus-accounter DB 준비')
  log('━'.repeat(60))
  log(` 관리 계정   : ${adminConfig().user}${hasDedicatedAdmin() ? '' : '  ⚠ 앱 계정과 동일(운영에서는 분리 권장)'}`)
  log(` 공용 DB     : ${PLATFORM_DB}`)
  log(` 테넌트 DB   : ${TENANT_DB}`)
  if (CHECK_ONLY) log(' 모드        : --check (변경 없음)')

  // ── 1. 공용 관리 DB ──
  step(1, `공용 관리 DB(${PLATFORM_DB}) 준비`)
  await withAdmin(async (conn) => {
    const [rows] = await conn.query('SHOW DATABASES LIKE ?', [PLATFORM_DB])
    if (rows.length === 0) {
      if (CHECK_ONLY) return log('   · 없음 — 생성이 필요합니다')
      await conn.query(
        `CREATE DATABASE \`${PLATFORM_DB}\` CHARACTER SET utf8 COLLATE utf8_general_ci`
      )
      log('   · 데이터베이스 생성됨')
    } else {
      log('   · 데이터베이스 존재')
    }
  })

  if (!CHECK_ONLY) {
    await withAdmin(async (conn) => {
      await createPlatformSchema(conn)
      log('   · 스키마 적용 완료')
    }, { database: PLATFORM_DB })
  }

  // ── 2. 기존(첫) 테넌트 DB 준비 ──
  // 부트스트랩(3단계)이 이 DB의 users·company_info를 읽어가므로 먼저 처리한다.
  step(2, `기존 테넌트 DB(${TENANT_DB}) 준비`)
  await withAdmin(async (conn) => {
    const [rows] = await conn.query('SHOW DATABASES LIKE ?', [TENANT_DB])
    if (rows.length === 0) {
      if (CHECK_ONLY) return log('   · 없음 — 생성이 필요합니다')
      await conn.query(`CREATE DATABASE \`${TENANT_DB}\` CHARACTER SET utf8 COLLATE utf8_general_ci`)
      log('   · 데이터베이스 생성됨')
    } else {
      log('   · 데이터베이스 존재')
    }
  })
  if (CHECK_ONLY) {
    log('   · (--check: 스키마 적용 생략)')
  } else {
    await withAdmin(async (conn) => {
      await initDb(conn)
      log('   · 스키마·마이그레이션 적용 완료')
    }, { database: TENANT_DB })
  }

  // ── 3. 부트스트랩 (첫 회사 등록) ──
  step(3, '첫 회사 등록(부트스트랩)')
  const codeCheck = validateCompanyCode(process.env.BOOTSTRAP_COMPANY_CODE || 'dongjin')
  if (!codeCheck.ok) throw new Error(`BOOTSTRAP_COMPANY_CODE 오류: ${codeCheck.error}`)

  await withAdmin(async (platformConn) => {
    const [[{ cnt }]] = await platformConn.execute('SELECT COUNT(*) AS cnt FROM companies')
    if (cnt > 0) {
      const [list] = await platformConn.execute('SELECT id, code, name, db_name FROM companies ORDER BY created_at')
      log(`   · 이미 ${cnt}개 회사가 등록되어 있습니다:`)
      for (const c of list) log(`       - ${c.code}  (${c.name})  →  ${c.db_name}`)
      // 기본 역할 보정 — 초기 부트스트랩에 역할 생성이 없던 시절에 이전된 회사를 메운다.
      if (!CHECK_ONLY) {
        for (const c of list) {
          const r = await ensurePresetRoles(platformConn, c.id)
          if (r.created > 0)    log(`   · ${c.code}: 기본 역할 ${r.created}종 생성(보정)`)
          if (r.backfilled > 0) log(`   · ${c.code}: 신규 자원 권한 ${r.backfilled}건 보충`)
          // 역할이 하나도 연결 안 된 계정을 메운다.
          // admin은 마스터, 그 외는 조회전용을 기본으로 준다(권한은 마스터가 나중에 조정).
          if (r.masterRoleId) {
            const [[viewer]] = await platformConn.execute(
              "SELECT id FROM roles WHERE company_id = ? AND name = '조회전용'", [c.id]
            )
            const [orphans] = await platformConn.execute(
              `SELECT u.id, u.role FROM users u
                WHERE u.company_id = ?
                  AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)`,
              [c.id]
            )
            let linked = 0
            for (const u of orphans) {
              const roleId = u.role === 'admin' ? r.masterRoleId : viewer?.id
              if (!roleId) continue
              await platformConn.execute(
                'INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)', [u.id, roleId]
              )
              linked++
            }
            if (linked > 0) log(`   · ${c.code}: 계정 ${linked}개에 역할 연결(보정)`)
          }
        }
      }
      return
    }
    if (CHECK_ONLY) return log('   · 등록된 회사 없음 — 부트스트랩이 필요합니다')

    // 레거시 테넌트 DB에서 회사명·계정을 읽어온다.
    const result = await withAdmin(
      (legacyConn) => bootstrapFirstCompany(platformConn, legacyConn, {
        code: codeCheck.code,
        dbName: TENANT_DB,
        fallbackName: process.env.BOOTSTRAP_COMPANY_NAME,
      }),
      { database: TENANT_DB }
    )
    if (result.skipped) {
      log(`   · 건너뜀 — ${result.reason}`)
      log('     (신규 설치라면 회사·마스터 계정을 별도로 생성해야 합니다)')
    } else {
      log(`   · 회사 '${result.code}' 등록 완료, 계정 ${result.users}개 이전`)
      log(`   · 이제 로그인 시 회사코드에 '${result.code}' 를 입력합니다`)
    }
  }, { database: PLATFORM_DB })

  // ── 4. 전 테넌트 스키마 적용 ──
  // ⚠ 이 단계가 없으면 두 번째 회사부터 스키마가 영원히 고정된다.
  //   (db.js에 컬럼을 추가하고 배포해도 첫 회사에만 적용되어, 나머지 회사는
  //    해당 화면이 전부 ER_BAD_FIELD_ERROR 500으로 죽는다)
  // initDb는 멱등이라 매번 전체에 돌려도 안전하다. 회사가 수백 개로 늘어 느려지면
  // 그때 tenant_migrations 기반 버전드 러너로 승격한다(현재는 단순함이 더 가치 있음).
  step(4, '전 테넌트 스키마 적용')
  const [companies] = await platformPool.execute(
    'SELECT code, db_name FROM companies ORDER BY created_at'
  )
  if (CHECK_ONLY) {
    log(`   · 대상 ${companies.length}개: ${companies.map(c => c.db_name).join(', ')}`)
    log('   · (--check: 적용 생략)')
  } else {
    const failed = []
    for (const c of companies) {
      try {
        await withAdmin(conn => initDb(conn), { database: c.db_name })
        log(`   · ${c.code.padEnd(12)} ${c.db_name} ✅`)
      } catch (e) {
        // 한 회사가 실패해도 나머지는 진행한다 — 전체가 멈추면 복구가 더 어렵다.
        failed.push({ code: c.code, db: c.db_name, err: e.message })
        log(`   · ${c.code.padEnd(12)} ${c.db_name} ❌ ${e.code || e.message}`)
      }
    }
    if (failed.length) {
      throw new Error(
        `테넌트 ${failed.length}개의 스키마 적용에 실패했습니다:\n` +
        failed.map(f => `  - ${f.code} (${f.db}): ${f.err}`).join('\n') +
        `\n  나머지 회사는 정상 적용되었습니다. 위 회사만 개별 확인하세요.`
      )
    }
  }

  log('\n' + '━'.repeat(60))
  log(CHECK_ONLY ? ' 점검 완료 (변경 없음)' : ' ✅ 준비 완료')
  log('━'.repeat(60) + '\n')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n❌ 실패:', e.message)
    if (e.code === 'ER_DBACCESS_DENIED_ERROR' || e.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('\n권한이 부족합니다. 필요한 GRANT를 보려면:  npm run check:db\n')
    }
    process.exit(1)
  })
