#!/usr/bin/env node
/**
 * DB 연결·권한 진단
 *
 *   node scripts/check-db.js
 *
 * 앱 계정(런타임/DML)과 관리 계정(DDL)이 각각 필요한 권한을 갖고 있는지 확인하고,
 * 부족하면 **그대로 붙여넣어 실행할 수 있는 GRANT 문**을 출력한다.
 *
 * 권한 분리 목표:
 *   앱 계정   — 공용 DB + 테넌트 DB(acct_%)에 SELECT/INSERT/UPDATE/DELETE. DDL 없음.
 *   관리 계정 — DB 생성 및 스키마 변경(ALL PRIVILEGES).
 */
require('dotenv').config()
const mysql = require('mysql2/promise')
const { PLATFORM_DB, appConfig, adminConfig, hasDedicatedAdmin } = require('../platform/db')

const TENANT_DB = process.env.DB_NAME || 'dongjin_erp'
const TENANT_PATTERN = process.env.TENANT_DB_PREFIX || 'acct_'

const ok   = (m) => console.log(`  ✅ ${m}`)
const bad  = (m) => console.log(`  ❌ ${m}`)
const warn = (m) => console.log(`  ⚠  ${m}`)

async function tryConnect(cfg, label) {
  try {
    const conn = await mysql.createConnection(cfg)
    return conn
  } catch (e) {
    bad(`${label} 접속 실패: ${e.code || e.message}`)
    return null
  }
}

async function grantsOf(conn) {
  try {
    const [rows] = await conn.query('SHOW GRANTS FOR CURRENT_USER()')
    return rows.map(r => Object.values(r)[0])
  } catch { return [] }
}

async function canWrite(conn, db) {
  // 실제로 쓰기가 되는지 확인 — 임시 테이블이 아니라 권한 메타로 판단하면 오탐이 많다.
  try {
    await conn.query(`SELECT 1 FROM \`${db}\`.companies LIMIT 1`)
    return true
  } catch (e) {
    return e.code !== 'ER_DBACCESS_DENIED_ERROR' && e.code !== 'ER_TABLEACCESS_DENIED_ERROR'
  }
}

async function main() {
  console.log('━'.repeat(64))
  console.log(' DB 연결·권한 진단')
  console.log('━'.repeat(64))
  console.log(` 호스트     : ${appConfig.host}`)
  console.log(` 앱 계정    : ${appConfig.user}`)
  console.log(` 관리 계정  : ${adminConfig().user}${hasDedicatedAdmin() ? '' : '  (미설정 → 앱 계정으로 폴백)'}`)
  console.log(` 공용 DB    : ${PLATFORM_DB}`)
  console.log(` 테넌트 DB  : ${TENANT_DB}`)

  const missing = []

  // ── 앱 계정 ──
  console.log('\n[앱 계정 — 런타임(DML)]')
  const app = await tryConnect(appConfig, '앱 계정')
  if (app) {
    ok('서버 접속')
    const [dbs] = await app.query('SHOW DATABASES')
    const names = dbs.map(d => Object.values(d)[0])

    if (names.includes(PLATFORM_DB)) {
      ok(`공용 DB(${PLATFORM_DB}) 접근 가능`)
      if (await canWrite(app, PLATFORM_DB)) ok('공용 DB 조회 가능')
      else { bad('공용 DB 조회 불가'); missing.push(dmlGrant(PLATFORM_DB, appConfig.user)) }
    } else {
      bad(`공용 DB(${PLATFORM_DB}) 가 없거나 접근 권한이 없습니다`)
      missing.push(dmlGrant(PLATFORM_DB, appConfig.user))
    }

    if (names.includes(TENANT_DB)) ok(`테넌트 DB(${TENANT_DB}) 접근 가능`)
    else { bad(`테넌트 DB(${TENANT_DB}) 접근 불가`); missing.push(dmlGrant(TENANT_DB, appConfig.user)) }

    // 신규 테넌트(acct_c0002 …)를 앱이 읽고 쓸 수 있어야 한다
    const g = await grantsOf(app)
    // MariaDB는 SHOW GRANTS에서 이스케이프를 빼고 표시한다(`acct\_%` → `acct_%`).
    // 표시 형식에 의존하지 않도록 양쪽에서 백슬래시를 제거하고 비교한다.
    const unescape = (s) => s.replace(/\\/g, '')
    const hasWildcard = g.some(s => unescape(s).includes(`\`${TENANT_PATTERN}%\``))
    if (hasWildcard) ok(`신규 테넌트(${TENANT_PATTERN}%) 와일드카드 권한 있음`)
    else {
      warn(`신규 테넌트(${TENANT_PATTERN}%) 와일드카드 권한 없음 — 회사 추가 시 앱이 접근 못 합니다`)
      missing.push(dmlGrantWildcard(TENANT_PATTERN, appConfig.user))
    }

    // DDL 권한이 '있으면' 오히려 경고(권한 분리 원칙 위반)
    if (g.some(s => /ALL PRIVILEGES ON \*\.\*|GRANT ALL PRIVILEGES ON `?\*/.test(s)) ||
        g.some(s => s.includes('ON *.*') && s.includes('CREATE'))) {
      warn('앱 계정이 전역 DDL 권한을 갖고 있습니다 — 운영에서는 DML로 제한하세요')
    }
    await app.end()
  }

  // ── 관리 계정 ──
  console.log('\n[관리 계정 — DDL]')
  if (!hasDedicatedAdmin()) {
    warn('DB_ADMIN_USER 미설정 — 앱 계정으로 DDL을 수행합니다(운영 비권장)')
  }
  const adm = await tryConnect(adminConfig(), '관리 계정')
  if (adm) {
    ok('서버 접속')
    // GRANT 문자열 파싱은 오판이 잦다(자기 DB 한정 ALL PRIVILEGES를 전역으로 착각).
    // 임시 DB를 실제로 만들었다 지워서 확실하게 판정한다.
    // ⚠ 이름은 반드시 테넌트 접두사(acct_)를 따라야 한다. 권한을 `acct\_%` 로 한정해 주는 게
    //   정석인데, 접두사를 안 지키면 올바른 설정에서도 실패해 오탐이 난다.
    const probe = `${TENANT_PATTERN}privchk_tmp`
    try {
      await adm.query(`CREATE DATABASE IF NOT EXISTS \`${probe}\``)
      await adm.query(`DROP DATABASE \`${probe}\``)
      ok('DB 생성 권한 확인 (실제 생성/삭제 테스트 통과)')
    } catch (e) {
      bad(`DB 생성 불가 (${e.code || e.message}) — 공용/테넌트 DB를 만들 수 없습니다`)
      missing.push(adminGrant(adminConfig().user))
    }
    await adm.end()
  }

  // ── 결과 ──
  console.log('\n' + '━'.repeat(64))
  if (missing.length === 0) {
    console.log(' ✅ 권한 구성 이상 없음')
    console.log('━'.repeat(64) + '\n')
    return
  }
  console.log(' ⚠  부족한 권한이 있습니다. root로 아래를 실행하세요:')
  console.log('━'.repeat(64))
  console.log('\nmysql -u root -p <<\'SQL\'')
  for (const line of [...new Set(missing)]) console.log(line)
  console.log('FLUSH PRIVILEGES;')
  console.log('SQL\n')
}

const host = () => process.env.DB_GRANT_HOST || 'localhost'
const dmlGrant = (db, user) =>
  `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${db}\`.* TO '${user}'@'${host()}';`
// GRANT에서 _ 는 와일드카드다. 리터럴 언더스코어는 \_ 로 이스케이프해야 acct_ 접두사만 매칭된다.
const dmlGrantWildcard = (prefix, user) =>
  `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${prefix.replace('_', '\\_')}%\`.* TO '${user}'@'${host()}';`
const adminGrant = (user) =>
  `GRANT ALL PRIVILEGES ON *.* TO '${user}'@'${host()}' WITH GRANT OPTION;  -- 또는 필요한 DB로 한정`

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\n진단 실패:', e.message); process.exit(1) })
