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
  PLATFORM_DB, withAdmin, assertDbName, validateCompanyCode, hasDedicatedAdmin, adminConfig,
} = require('../platform/db')
const { createPlatformSchema, bootstrapFirstCompany } = require('../platform/schema')
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

  // ── 2. 테넌트 DB 스키마 ──
  step(2, `테넌트 DB(${TENANT_DB}) 스키마·마이그레이션`)
  await withAdmin(async (conn) => {
    const [rows] = await conn.query('SHOW DATABASES LIKE ?', [TENANT_DB])
    if (rows.length === 0) {
      if (CHECK_ONLY) return log('   · 없음 — 생성이 필요합니다')
      await conn.query(`CREATE DATABASE \`${TENANT_DB}\` CHARACTER SET utf8 COLLATE utf8_general_ci`)
      log('   · 데이터베이스 생성됨')
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
      const [list] = await platformConn.execute('SELECT code, name, db_name FROM companies ORDER BY created_at')
      log(`   · 이미 ${cnt}개 회사가 등록되어 있습니다:`)
      for (const c of list) log(`       - ${c.code}  (${c.name})  →  ${c.db_name}`)
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
