#!/usr/bin/env node
/**
 * 빈 DB 스키마 검사 — **새 회사를 만들 수 있는가**
 *
 *   npm run check:fresh-schema
 *
 * 왜 필요한가: 배포 때 도는 setup:db 는 **이미 있는 회사 DB** 에만 스키마를 덧댄다.
 * 그래서 db.js 안에서 "칸을 만들기 전에 그 칸을 읽는" 순서 실수가 있어도 기존 DB 에는 칸이
 * 이미 있어 조용히 통과하고, 빈 DB(새 회사)에서만 터진다.
 * 2026-09-02 에 실제로 그렇게 들어가 9-15 까지 새 회사 생성이 막혀 있었다(아무도 몰랐다).
 *
 * 하는 일: 임시 DB 를 만들고 → initDb 를 **두 번** 돌리고(처음 = 새 회사, 두 번째 = 멱등성) → 지운다.
 * 로컬 DB 에서 돌린다. 운영 DB 서버에 임시 DB 를 만들지 않는다.
 */
require('dotenv').config()
const { withAdmin } = require('../platform/db')
const { initDb } = require('../db')

const probe = `acct_probe_${Date.now().toString(36)}`

;(async () => {
  let created = false
  try {
    await withAdmin(c => c.query(`CREATE DATABASE \`${probe}\` CHARACTER SET utf8 COLLATE utf8_general_ci`))
    created = true
    const quiet = console.log
    console.log = () => {}   // 시드 로그는 검사 결과를 가린다
    try {
      await withAdmin(c => initDb(c), { database: probe })
      await withAdmin(c => initDb(c), { database: probe })
    } finally {
      console.log = quiet
    }
    console.log(`✅ 빈 DB 에 스키마 적용·재적용 통과 (${probe})`)
  } catch (e) {
    console.error(`❌ 빈 DB 스키마 실패: ${e.message}`)
    console.error('   → db.js 에서 칸·표를 만들기 전에 읽거나 채우는 문이 없는지 보세요.')
    process.exitCode = 1
  } finally {
    if (created) {
      await withAdmin(c => c.query(`DROP DATABASE \`${probe}\``))
        .catch(e => { console.error(`⚠ 임시 DB 삭제 실패 — 손으로 지우세요: ${probe} (${e.message})`); process.exitCode = 1 })
    }
    process.exit()
  }
})()
