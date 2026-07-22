#!/usr/bin/env node
/**
 * 첨부파일 회사별 격리 마이그레이션 (1회, 멱등)
 *
 *   node scripts/migrate-uploads.js          실제 이전
 *   node scripts/migrate-uploads.js --check   변경 없이 대상만 표시
 *
 * 단일 테넌트 시절 uploads/ 루트에 평면으로 쌓인 파일을 uploads/{companyId}/ 로 옮기고,
 * DB에 저장된 URL(/uploads/파일명 → /uploads/{companyId}/파일명)을 함께 고친다.
 * 둘 중 하나만 하면 기존 첨부가 전부 깨지므로 파일 이동과 URL 갱신을 같이 처리한다.
 *
 * 회사가 여럿인 상태에서는 루트 파일의 소유자를 알 수 없으므로 실행을 거부한다
 * (그 경우 이미 마이그레이션이 끝났거나 수동 판단이 필요하다).
 */
require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { platformPool, withAdmin } = require('../platform/db')

const CHECK_ONLY = process.argv.includes('--check')
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads')

// (테이블, URL 컬럼) — 첨부 경로가 저장되는 모든 자리
const URL_COLUMNS = [
  ['invoice_docs',       'url'],
  ['contract_docs',      'url'],
  ['transaction_docs',   'url'],
  ['work_contract_docs', 'file_url'],
  ['transactions',       'evid_url'],
  ['ref_items',          'file_url'],
  ['contracts',          'file_url'],
]

async function main() {
  console.log('━'.repeat(64))
  console.log(' 첨부파일 회사별 격리 마이그레이션')
  console.log('━'.repeat(64))

  const [companies] = await platformPool.execute(
    'SELECT id, code, name, db_name FROM companies ORDER BY created_at'
  )
  if (companies.length === 0) {
    console.log(' 등록된 회사가 없습니다. 먼저 npm run setup:db 를 실행하세요.\n')
    return
  }

  // 루트에 남아 있는 평면 파일 (디렉터리는 이미 이전된 회사 폴더)
  if (!fs.existsSync(UPLOAD_ROOT)) {
    console.log(' uploads 디렉터리가 없습니다 — 이전할 파일이 없습니다.\n')
    return
  }
  const rootFiles = fs.readdirSync(UPLOAD_ROOT)
    .filter(f => fs.statSync(path.join(UPLOAD_ROOT, f)).isFile())

  if (rootFiles.length === 0) {
    console.log(' 루트에 평면 파일이 없습니다 — 이미 이전이 끝난 상태입니다.\n')
    return
  }

  if (companies.length > 1) {
    console.log(` ❌ 회사가 ${companies.length}개인데 루트에 파일이 ${rootFiles.length}개 남아 있습니다.`)
    console.log('    소유 회사를 자동으로 판단할 수 없어 중단합니다. 수동 확인이 필요합니다.\n')
    process.exitCode = 1
    return
  }

  const company = companies[0]
  console.log(` 대상 회사 : ${company.code} (${company.name})`)
  console.log(` 회사 ID   : ${company.id}`)
  console.log(` 이전 파일 : ${rootFiles.length}개`)
  if (CHECK_ONLY) {
    console.log('\n [--check] 변경 없음. 대상 파일:')
    rootFiles.forEach(f => console.log(`   · ${f}`))
    console.log('')
    return
  }

  // ── 1. 파일 이동 ──
  const destDir = path.join(UPLOAD_ROOT, company.id)
  fs.mkdirSync(destDir, { recursive: true })
  let moved = 0, skipped = 0
  for (const f of rootFiles) {
    const from = path.join(UPLOAD_ROOT, f)
    const to = path.join(destDir, f)
    if (fs.existsSync(to)) { skipped++; continue }
    fs.renameSync(from, to)
    moved++
  }
  console.log(`\n [1] 파일 이동: ${moved}개 이동${skipped ? `, ${skipped}개 이미 존재(건너뜀)` : ''}`)

  // ── 2. DB URL 갱신 ──
  // '/uploads/파일명' → '/uploads/{companyId}/파일명'.
  // 이미 회사 ID가 붙은 URL은 건드리지 않는다(재실행 안전).
  const prefix = '/uploads/'
  const newPrefix = `/uploads/${company.id}/`
  console.log(' [2] DB URL 갱신')
  await withAdmin(async (conn) => {
    for (const [table, col] of URL_COLUMNS) {
      try {
        const [r] = await conn.execute(
          `UPDATE \`${table}\` SET \`${col}\` = CONCAT(?, SUBSTRING(\`${col}\`, ?))
            WHERE \`${col}\` LIKE ? AND \`${col}\` NOT LIKE ?`,
          [newPrefix, prefix.length + 1, `${prefix}%`, `${newPrefix}%`]
        )
        if (r.affectedRows > 0) console.log(`     · ${table}.${col}: ${r.affectedRows}건`)
      } catch (e) {
        if (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR') continue
        throw e
      }
    }
  }, { database: company.db_name })

  console.log('\n' + '━'.repeat(64))
  console.log(' ✅ 완료 — 기존 첨부가 회사 폴더로 이전되고 URL이 갱신되었습니다')
  console.log('━'.repeat(64) + '\n')
}

main()
  .then(async () => { await platformPool.end(); process.exit(process.exitCode || 0) })
  .catch(async (e) => {
    console.error('\n❌ 실패:', e.message)
    await platformPool.end().catch(() => {})
    process.exit(1)
  })
