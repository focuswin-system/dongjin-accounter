#!/usr/bin/env node
/**
 * 회사(테넌트) 삭제 CLI
 *
 *   node scripts/delete-tenant.js --code <회사코드> --confirm <회사코드>
 *   node scripts/delete-tenant.js --code <회사코드> --dry-run     무엇이 지워지는지만 표시
 *   node scripts/delete-tenant.js --code <회사코드> --confirm <코드> --no-backup
 *
 * ⚠ 되돌릴 수 없는 작업이다. 그래서 안전장치를 겹으로 둔다:
 *   1) --confirm 에 회사코드를 한 번 더 입력해야 실행된다(오타·복붙 사고 방지)
 *   2) 기본으로 DB를 통째로 덤프해 백업한다(--no-backup 으로만 생략 가능)
 *   3) 마지막 회사는 지울 수 없다(로그인 불가 상태가 되는 것을 막는다)
 *   4) 부트스트랩된 원본 테넌트(prefix 밖의 DB)는 기본 거부 — 실서비스 DB 오삭제 방지
 *
 * 지우는 것: 테넌트 DB · companies 행(users/roles/role_perms는 FK CASCADE) · 업로드 폴더
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { platformPool, withAdmin, appConfig, assertDbName } = require('../platform/db')

const DB_PREFIX = process.env.TENANT_DB_PREFIX || 'acct_'
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads')
const BACKUP_DIR = process.env.TENANT_BACKUP_DIR || path.join(require('os').homedir(), 'backups')

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const has = (flag) => process.argv.includes(flag)

async function main() {
  const code = String(arg('--code') || '').trim().toLowerCase()
  const confirm = String(arg('--confirm') || '').trim().toLowerCase()
  const dryRun = has('--dry-run')
  const noBackup = has('--no-backup')
  const force = has('--force')

  if (!code) {
    console.error(`
사용법:
  node scripts/delete-tenant.js --code <회사코드> --confirm <회사코드>
  node scripts/delete-tenant.js --code <회사코드> --dry-run

옵션:
  --dry-run     실제로 지우지 않고 대상만 표시
  --no-backup   삭제 전 DB 덤프를 남기지 않음(비권장)
  --force       접두사(${DB_PREFIX}) 밖의 DB도 삭제 허용 — 실서비스 DB일 수 있으니 신중히
`)
    process.exit(1)
  }

  // ── 대상 확인 ──
  const [[company]] = await platformPool.execute(
    'SELECT id, code, name, db_name, status FROM companies WHERE code = ?', [code]
  )
  if (!company) throw new Error(`회사코드 '${code}' 를 찾을 수 없습니다`)

  const [[{ total }]] = await platformPool.execute('SELECT COUNT(*) AS total FROM companies')
  const [[{ users }]] = await platformPool.execute(
    'SELECT COUNT(*) AS users FROM users WHERE company_id = ?', [company.id]
  )
  const uploadDir = path.join(UPLOAD_ROOT, company.id)
  const uploadCount = fs.existsSync(uploadDir)
    ? fs.readdirSync(uploadDir).length : 0

  // 테넌트 DB의 실제 데이터량 — '빈 회사인 줄 알았는데 아니었다' 사고 방지
  let rowCounts = {}
  try {
    rowCounts = await withAdmin(async (c) => {
      const out = {}
      for (const t of ['vendors', 'contracts', 'invoices', 'transactions', 'employees']) {
        try {
          const [[r]] = await c.execute(`SELECT COUNT(*) AS n FROM \`${t}\``)
          out[t] = r.n
        } catch { out[t] = '?' }
      }
      return out
    }, { database: company.db_name })
  } catch (e) {
    console.warn(`  (테넌트 DB 조회 실패: ${e.code || e.message})`)
  }

  console.log('━'.repeat(64))
  console.log(' 회사 삭제')
  console.log('━'.repeat(64))
  console.log(` 회사코드     : ${company.code}`)
  console.log(` 회사명       : ${company.name}`)
  console.log(` 데이터베이스 : ${company.db_name}`)
  console.log(` 계정         : ${users}개`)
  console.log(` 업로드 파일  : ${uploadCount}개  (${uploadDir})`)
  console.log(` 데이터       : ${Object.entries(rowCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  console.log('━'.repeat(64))

  // ── 안전장치 ──
  if (total <= 1) {
    throw new Error('마지막 남은 회사는 삭제할 수 없습니다(아무도 로그인할 수 없게 됩니다)')
  }
  if (!company.db_name.startsWith(DB_PREFIX) && !force) {
    throw new Error(
      `'${company.db_name}' 는 테넌트 접두사(${DB_PREFIX})로 시작하지 않습니다.\n` +
      `  기존에 흡수한 실서비스 DB일 수 있습니다. 정말 지우려면 --force 를 붙이세요.`
    )
  }

  if (dryRun) {
    console.log('\n [--dry-run] 아무것도 삭제하지 않았습니다.\n')
    return
  }
  if (confirm !== code) {
    throw new Error(
      `확인이 필요합니다. 위 내용을 확인하고 아래처럼 다시 실행하세요:\n` +
      `  node scripts/delete-tenant.js --code ${code} --confirm ${code}`
    )
  }

  // ── 1. 백업 ──
  if (!noBackup) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const out = path.join(BACKUP_DIR, `deleted_${company.code}_${company.db_name}_${stamp}.sql`)
    try {
      const dump = execFileSync('mysqldump', [
        `-h${appConfig.host}`, `-u${appConfig.user}`, `-p${appConfig.password}`,
        '--single-transaction', '--routines', assertDbName(company.db_name),
      ], { maxBuffer: 512 * 1024 * 1024 })
      fs.writeFileSync(out, dump)
      console.log(`\n [1] 백업: ${out} (${(dump.length / 1024).toFixed(0)} KB)`)
    } catch (e) {
      throw new Error(
        `백업 실패로 중단합니다: ${e.message}\n` +
        `  백업 없이 진행하려면 --no-backup 을 붙이세요(비권장).`
      )
    }
  } else {
    console.log('\n [1] 백업 생략(--no-backup)')
  }

  // ── 2. 업로드 폴더 ──
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true })
    console.log(` [2] 업로드 폴더 삭제: ${uploadCount}개 파일`)
  } else {
    console.log(' [2] 업로드 폴더 없음')
  }

  // ── 3. 공용 DB에서 회사 제거 (users/roles/role_perms는 FK CASCADE) ──
  // DB를 먼저 지우면 로그인은 되는데 데이터가 없는 상태가 생긴다 → 회사 행부터 지운다.
  await platformPool.execute('DELETE FROM companies WHERE id = ?', [company.id])
  console.log(` [3] 회사·계정·역할 삭제 (계정 ${users}개)`)

  // ── 4. 테넌트 DB DROP ──
  await withAdmin(c => c.query(`DROP DATABASE IF EXISTS \`${assertDbName(company.db_name)}\``))
  console.log(` [4] 데이터베이스 삭제: ${company.db_name}`)

  console.log('\n' + '━'.repeat(64))
  console.log(` ✅ '${company.code}' 삭제 완료`)
  if (!noBackup) console.log('    백업본이 남아 있으니 복구가 필요하면 알려주세요.')
  console.log('━'.repeat(64) + '\n')
}

main()
  .then(async () => { await platformPool.end(); process.exit(0) })
  .catch(async (e) => {
    console.error('\n❌ ' + e.message + '\n')
    await platformPool.end().catch(() => {})
    process.exit(1)
  })
