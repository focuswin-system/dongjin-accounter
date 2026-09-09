#!/usr/bin/env node
/*
 * 일회성 이관 — 동진테크 MES 거래처 엑셀 → dongjin 테넌트 회계 거래처(vendors).
 *
 * ⚠ 이건 **제품 기능이 아니다.** 도니도라는 멀티테넌트 SaaS 이고, MES 연동은 동진테크
 *   한 회사만의 사정이다. 그래서 화면·라우트·권한으로 제품에 박지 않고, 운영자가 손으로
 *   한 번 돌리는 ops 스크립트로 둔다. (MES ↔ 회계를 잇는 '다리'와 발주 연동은 나중에
 *   동진테크 별도 개발 + DB 공유로 간다 — 여기선 거래처 데이터만 옮긴다.)
 *
 * 사용:
 *   node scripts/import-dongjin-clie.js --company dongjin --file "C:/…/거래처관리.xlsx"
 *   (기본은 dry-run: 미리보기만. 실제로 넣으려면 --commit. 넣기 전 DB 백업 필수.)
 *
 * 규칙:
 *   - MES 는 한 회사(사업자번호)가 clie_code 여럿(N:1) → 사업자번호로 그룹핑해 회사당 1개.
 *   - clie_code 별 매입·매출이 갈리면 회계 gubu = 합집합(C=매입매출).
 *   - 이미 있는 거래처(사업자번호 일치)는 새로 안 만든다(중복 방지). gubu 만 다르면 갱신.
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const mysql = require('mysql2/promise')
const { randomUUID } = require('crypto')
const XLSX = require('xlsx')
const { groupCompanies, reconcile, normBiz } = require('../lib/mesVendorMap')

function arg(name) {
  const i = process.argv.indexOf(name)
  if (i < 0) return null
  const nx = process.argv[i + 1]
  return nx && !nx.startsWith('--') ? nx : true
}
const companyCode = typeof arg('--company') === 'string' ? arg('--company') : null
const file        = typeof arg('--file') === 'string' ? arg('--file') : null
const commit       = !!arg('--commit')

const baseCfg = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
}

async function resolveDb() {
  const plat = await mysql.createConnection({ ...baseCfg, database: process.env.PLATFORM_DB_NAME || 'acct_platform' })
  try {
    const [rows] = await plat.query('SELECT code, name, db_name FROM companies ORDER BY id')
    if (!companyCode) {
      console.log('\n--company 로 회사코드를 지정하세요. 등록된 회사:')
      console.table(rows.map(r => ({ 회사코드: r.code, 회사명: r.name, DB: r.db_name })))
      process.exit(1)
    }
    const hit = rows.find(r => r.code === companyCode)
    if (!hit) { console.error(`회사코드 '${companyCode}' 를 못 찾았어요.`); process.exit(1) }
    console.log(`대상 회사: ${hit.name} (${hit.code}) → ${hit.db_name}`)
    return hit.db_name
  } finally { await plat.end() }
}

async function main() {
  if (!file) { console.error('--file 로 엑셀 경로를 지정하세요.'); process.exit(1) }
  const wb = XLSX.readFile(file)
  const sheet = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
  const { companies, noBiz } = groupCompanies(rows)
  console.log(`\n엑셀 ${rows.length}행 → 회사 ${companies.length}개 (사업자번호 없음 ${noBiz.length})`)
  const gubuDist = {}; for (const c of companies) gubuDist[c.gubu] = (gubuDist[c.gubu] || 0) + 1
  console.log('gubu 분포:', JSON.stringify(gubuDist))

  const dbName = await resolveDb()
  const pool = mysql.createPool({ ...baseCfg, database: dbName, connectionLimit: 3 })
  try {
    const [vendors] = await pool.query('SELECT id, name, biz_no, gubu FROM vendors')
    const { matched, toCreate, accountingOnly, summary } = reconcile(companies, vendors, [])
    console.log('\n── 대사 결과 ──')
    console.log(`  새로 만들 것 : ${toCreate.length}`)
    console.log(`  이미 있음(매칭): ${matched.length}`)
    console.log(`  회계에만 있음 : ${accountingOnly.length} (안 건드림)`)
    // gubu 갱신이 필요한 매칭(현재 gubu ≠ 계산 gubu)
    const gubuFix = matched.filter(m => (m.vendorGubu || null) !== m.gubu)
    if (gubuFix.length) console.log(`  구분(gubu) 갱신 대상: ${gubuFix.length}  예) ${gubuFix.slice(0, 5).map(m => `${m.name}:${m.vendorGubu}→${m.gubu}`).join(', ')}`)

    if (!commit) {
      console.log('\n[dry-run] 실제로 넣지 않았어요. --commit 을 붙이면 반영합니다. (반영 전 DB 백업 필수)')
      console.log('  만들 거래처 예시:', toCreate.slice(0, 8).map(c => `${c.name}(${c.gubu})`).join(', '))
      return
    }

    console.log('\n[commit] 반영 시작…')
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      let inserted = 0, updated = 0
      for (const c of toCreate) {
        await conn.execute(
          'INSERT INTO vendors (id, name, biz_no, ceo, gubu, active) VALUES (?,?,?,?,?,1)',
          [randomUUID(), c.name, c.biz, c.ceo || '', c.gubu])
        inserted++
      }
      for (const m of gubuFix) {
        await conn.execute('UPDATE vendors SET gubu = ? WHERE id = ?', [m.gubu, m.vendorId])
        updated++
      }
      await conn.commit()
      console.log(`\n✅ 완료 — 생성 ${inserted} · gubu 갱신 ${updated}`)
    } catch (e) { await conn.rollback(); throw e } finally { conn.release() }
  } finally { await pool.end() }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
