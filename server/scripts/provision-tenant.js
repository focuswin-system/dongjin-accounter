#!/usr/bin/env node
/**
 * 회사(테넌트) 생성 CLI
 *
 *   node scripts/provision-tenant.js \
 *     --code hanbit --name "한빛이엔지" \
 *     --user boss --password 'Str0ngPw!23' [--username-label 홍길동] [--email a@b.c]
 *
 *   node scripts/provision-tenant.js --list      등록된 회사 목록
 *
 * 셀프 가입 화면(P4)이 나오기 전까지 이 스크립트로 회사를 추가한다.
 * 내부적으로 services/provision.js 를 그대로 쓰므로, 나중에 가입 API가 생겨도
 * 동작이 갈라지지 않는다.
 */
require('dotenv').config()
const { platformPool } = require('../platform/db')
const { provisionTenant } = require('../services/provision')

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function list() {
  const [rows] = await platformPool.execute(
    `SELECT c.code, c.name, c.db_name, c.status, c.active,
            (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS users
       FROM companies c ORDER BY c.created_at`
  )
  console.log('\n등록된 회사')
  console.log('━'.repeat(78))
  if (!rows.length) console.log(' (없음)')
  for (const r of rows) {
    const state = r.active && r.status === 'active' ? '활성' : r.status
    console.log(` ${String(r.code).padEnd(14)} ${String(r.name).padEnd(20)} ${String(r.db_name).padEnd(14)} ${String(state).padEnd(12)} 계정 ${r.users}`)
  }
  console.log('━'.repeat(78) + '\n')
}

async function main() {
  if (process.argv.includes('--list')) return list()

  const code = arg('--code')
  const name = arg('--name')
  const masterUsername = arg('--user')
  const masterPassword = arg('--password')
  const masterName = arg('--username-label', '')
  const masterEmail = arg('--email', null)

  if (!code || !name || !masterUsername || !masterPassword) {
    console.error(`
사용법:
  node scripts/provision-tenant.js --code <회사코드> --name <회사명> \\
       --user <마스터아이디> --password <비밀번호> [--username-label <이름>] [--email <이메일>]

  node scripts/provision-tenant.js --list

  회사코드: 소문자 영문·숫자·하이픈 4~20자. 로그인 화면에서 입력하는 값이며 생성 후 변경 불가.
`)
    process.exit(1)
  }

  console.log('━'.repeat(64))
  console.log(' 회사 생성')
  console.log('━'.repeat(64))
  const result = await provisionTenant({
    code, name, masterUsername, masterPassword, masterName, masterEmail,
    onProgress: (m) => console.log('  · ' + m),
  })
  console.log('━'.repeat(64))
  console.log(` ✅ 완료`)
  console.log(`    회사코드 : ${result.code}`)
  console.log(`    데이터베이스 : ${result.dbName}`)
  console.log(`    로그인   : 회사코드 '${result.code}' + 아이디 '${masterUsername}'`)
  console.log('━'.repeat(64) + '\n')
}

main()
  .then(async () => { await platformPool.end(); process.exit(0) })
  .catch(async (e) => {
    console.error('\n❌ 실패:', e.message)
    await platformPool.end().catch(() => {})
    process.exit(1)
  })
