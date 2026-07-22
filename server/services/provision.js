/**
 * 회사(테넌트) 프로비저닝
 *
 * 가입 = 회사 등록 + 전용 DB 생성 + 스키마·시드 + 기본 역할 + 마스터 계정.
 *
 * ⚠ CREATE DATABASE는 DDL이라 트랜잭션에 묶을 수 없다.
 *   그래서 '전부 성공 아니면 전부 취소'를 보상 정리(compensating cleanup)로 구현한다:
 *     1) companies 를 status='provisioning' 으로 먼저 남긴다(코드 선점 = 동시 가입 충돌 방지)
 *     2) DB 생성·스키마·시드 (DDL)
 *     3) 역할·마스터 계정 생성 후 status='active'
 *     실패하면 만들다 만 DB를 DROP 하고 companies 행을 지운다.
 *
 * 동기 처리인 이유: 회계 SaaS는 가입 빈도가 낮아(하루 몇 건) 수 초를 스피너로 덮을 수 있다.
 * 큐/폴링은 가입이 폭주할 때 도입한다(현재는 불필요한 복잡도).
 *
 * 설계: docs/02-design/features/multi-tenant-saas.design.md §2.2
 */
const bcrypt = require('bcryptjs')
const { randomUUID } = require('crypto')
const { platformPool, withAdmin, assertDbName, validateCompanyCode } = require('../platform/db')
const { ensurePresetRoles } = require('../platform/schema')
const { initDb } = require('../db')

const DB_PREFIX = process.env.TENANT_DB_PREFIX || 'acct_'

/**
 * 다음 테넌트 DB 이름을 뽑는다 (acct_c0002, acct_c0003 …).
 * 회사코드가 아니라 일련번호를 쓰는 이유: 코드는 사용자에게 보이는 값이고
 * DB 이름은 내부 식별자다. 둘을 묶으면 코드 변경·특수문자 처리가 지저분해진다.
 */
async function allocateDbName() {
  const [rows] = await platformPool.execute('SELECT db_name FROM companies')
  let max = 0
  for (const r of rows) {
    const m = new RegExp(`^${DB_PREFIX}c(\\d+)$`).exec(r.db_name)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return assertDbName(`${DB_PREFIX}c${String(max + 1).padStart(4, '0')}`)
}

/**
 * @param {object} p
 * @param {string} p.code           회사코드(slug)
 * @param {string} p.name           회사명
 * @param {string} p.masterUsername 마스터 아이디
 * @param {string} p.masterPassword 마스터 비밀번호
 * @param {string} [p.masterName]   마스터 표시 이름
 * @param {string} [p.masterEmail]  마스터 이메일(본인 비번 재설정용)
 * @param {(msg:string)=>void} [p.onProgress]
 */
async function provisionTenant({
  code, name, masterUsername, masterPassword, masterName, masterEmail, onProgress,
}) {
  const log = onProgress || (() => {})

  // ── 입력 검증 ──
  const codeCheck = validateCompanyCode(code)
  if (!codeCheck.ok) throw new Error(codeCheck.error)
  const companyCode = codeCheck.code
  if (!name || !String(name).trim()) throw new Error('회사명을 입력하세요')
  if (!masterUsername || !String(masterUsername).trim()) throw new Error('마스터 아이디를 입력하세요')
  if (!masterPassword || String(masterPassword).length < 8) {
    throw new Error('마스터 비밀번호는 8자 이상이어야 합니다')
  }

  const [dup] = await platformPool.execute('SELECT id FROM companies WHERE code = ?', [companyCode])
  if (dup.length) throw new Error(`이미 사용 중인 회사코드입니다: ${companyCode}`)

  const companyId = randomUUID()
  const dbName = await allocateDbName()
  let dbCreated = false
  let companyRowCreated = false

  try {
    // ── 1. 회사 행 선점 (코드 유니크 제약이 동시 가입 충돌을 막는다) ──
    await platformPool.execute(
      'INSERT INTO companies (id, code, name, db_name, status, active) VALUES (?,?,?,?,?,0)',
      [companyId, companyCode, String(name).trim(), dbName, 'provisioning']
    )
    companyRowCreated = true
    log(`회사 등록(선점): ${companyCode} → ${dbName}`)

    // ── 2. 전용 DB 생성 + 스키마·시드 (DDL — 관리 계정) ──
    await withAdmin(c => c.query(
      `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8 COLLATE utf8_general_ci`
    ))
    dbCreated = true
    log(`데이터베이스 생성: ${dbName}`)

    // initDb가 스키마·마이그레이션·기본 시드(계정과목·비목·적요·급여항목·고용형태)를 모두 적용한다.
    // 표준 계정과목은 저장소의 data/account-subjects.json 을 원본으로 테넌트에 복제된다.
    await withAdmin(c => initDb(c), { database: dbName })
    log('스키마·기준정보 시드 적용')

    // ── 3. 기본 역할 + 권한 매트릭스 ──
    // 기존 회사 흡수(bootstrapFirstCompany)와 같은 함수를 쓴다 — 생성 경로가 갈라지면
    // '신규 회사에만 있는 역할' 같은 불일치가 생긴다.
    const roleResult = await ensurePresetRoles(platformPool, companyId)
    log(`기본 역할 ${roleResult.created}종 생성`)

    // ── 4. 마스터 계정 ──
    const userId = randomUUID()
    await platformPool.execute(
      'INSERT INTO users (id, company_id, username, password, name, email, role) VALUES (?,?,?,?,?,?,?)',
      [userId, companyId, String(masterUsername).trim(), await bcrypt.hash(masterPassword, 10),
       masterName || '', masterEmail || null, 'admin']
    )
    // 마스터 역할 연결
    if (roleResult.masterRoleId) {
      await platformPool.execute(
        'INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)', [userId, roleResult.masterRoleId]
      )
    }
    log(`마스터 계정 생성: ${masterUsername}`)

    // ── 5. 활성화 ──
    await platformPool.execute(
      "UPDATE companies SET status = 'active', active = 1 WHERE id = ?", [companyId]
    )
    log('활성화 완료')

    return { companyId, code: companyCode, dbName, masterUserId: userId }
  } catch (e) {
    // ── 보상 정리 ── 반쯤 만들어진 회사가 남으면 코드가 점유되고 로그인도 안 된다.
    log(`실패 — 정리 중: ${e.message}`)
    if (dbCreated) {
      await withAdmin(c => c.query(`DROP DATABASE IF EXISTS \`${dbName}\``))
        .catch(err => console.warn('[provision] DB 정리 실패:', err.message))
    }
    if (companyRowCreated) {
      // roles/users는 company_id FK가 ON DELETE CASCADE라 함께 정리된다.
      await platformPool.execute('DELETE FROM companies WHERE id = ?', [companyId])
        .catch(err => console.warn('[provision] 회사 행 정리 실패:', err.message))
    }
    throw e
  }
}

module.exports = { provisionTenant, allocateDbName }
