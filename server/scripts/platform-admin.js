#!/usr/bin/env node
/**
 * 운영자(플랫폼 관리자) 계정 관리 — 콘솔에 들어갈 유일한 열쇠를 만드는 곳.
 *
 * 화면에서 운영자 계정을 만들 수 있게 하면 '첫 계정은 누가 만드나' 문제가 생기고,
 * 그 자리는 대개 무인증 부트스트랩 경로가 되어 뚫린다. 그래서 계정 생성은
 * **서버에 들어올 수 있는 사람만** 할 수 있게 CLI 로만 둔다.
 *
 *   목록:   npm run admin:list
 *   추가:   npm run admin -- --user unyoung --name "홍길동" --password '...'
 *   비번:   npm run admin -- --user unyoung --password '...'      (있으면 변경)
 *   삭제:   npm run admin -- --user unyoung --delete
 */
require('dotenv').config()
const bcrypt = require('bcryptjs')
const { randomUUID } = require('crypto')
const { platformPool } = require('../platform/db')

const MIN_PW = 10

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}
const has = (name) => process.argv.includes(`--${name}`)

async function list() {
  const [rows] = await platformPool.execute(
    'SELECT username, name, created_at FROM platform_admins ORDER BY username')
  if (!rows.length) {
    console.log('\n등록된 운영자 계정이 없습니다.')
    console.log("  → 만들기:  npm run admin -- --user <아이디> --name <이름> --password '<비밀번호>'\n")
    return
  }
  console.log(`\n운영자 계정 ${rows.length}개\n`)
  for (const r of rows) {
    console.log(`  ${String(r.username).padEnd(20)} ${String(r.name || '').padEnd(16)} ${r.created_at.toISOString().slice(0, 10)}`)
  }
  console.log('')
}

async function main() {
  if (has('list') || process.argv.length <= 2) return list()

  const username = String(arg('user') || '').trim()
  if (!username) throw new Error('--user <아이디> 가 필요합니다')

  const [[existing]] = await platformPool.execute(
    'SELECT id FROM platform_admins WHERE username = ?', [username])

  if (has('delete')) {
    if (!existing) throw new Error(`'${username}' 계정이 없습니다`)
    await platformPool.execute('DELETE FROM platform_admins WHERE id = ?', [existing.id])
    console.log(`\n✅ '${username}' 삭제했습니다.\n`)
    return
  }

  const password = arg('password')
  if (!password) throw new Error("--password '<비밀번호>' 가 필요합니다")
  // 이 계정 하나가 전 회사 데이터를 보는 문이다. 짧은 비밀번호를 허용할 이유가 없다.
  if (password.length < MIN_PW) throw new Error(`비밀번호는 ${MIN_PW}자 이상이어야 합니다`)

  const hash = await bcrypt.hash(password, 10)
  if (existing) {
    await platformPool.execute('UPDATE platform_admins SET password = ? WHERE id = ?', [hash, existing.id])
    console.log(`\n✅ '${username}' 비밀번호를 바꿨습니다.\n`)
  } else {
    await platformPool.execute(
      'INSERT INTO platform_admins (id, username, password, name) VALUES (?,?,?,?)',
      [randomUUID(), username, hash, arg('name') || null])
    console.log(`\n✅ 운영자 '${username}' 을(를) 만들었습니다.`)
    console.log('   콘솔은 사무실 LAN 에서만 열립니다 —  http://<서버주소>:8081/admin\n')
  }
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error('\n❌ ' + e.message + '\n'); process.exit(1) })
