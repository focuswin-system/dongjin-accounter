#!/usr/bin/env node
/*
 * 같은 거래처가 둘로 중복 등록된 것을 하나로 합친다 — **연관 데이터를 한 건도 안 잃게**.
 *   사용: node scripts/merge-vendor-dups.js --company dongjin --name "마미숙" [--commit]
 *   기본 dry-run(무엇을 옮길지 보여만 줌). --commit 이라야 실제로 합친다. 반영 전 백업 필수.
 *
 * 안전장치:
 *   - 같은 이름 후보가 **정확히 2개**일 때만 동작(애매하면 멈춘다).
 *   - vendors(id) 를 가리키는 **모든 FK 컬럼 + vendor_id 컬럼**을 information_schema 에서
 *     자동 수집해 전부 keeper 로 재연결(repoint)한 뒤 나머지를 삭제 → 참조가 끊기지 않는다.
 *   - 한 트랜잭션. 도중에 하나라도 실패하면 통째로 롤백.
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const mysql = require('mysql2/promise')

function arg(name) { const i = process.argv.indexOf(name); if (i < 0) return null; const nx = process.argv[i + 1]; return nx && !nx.startsWith('--') ? nx : true }
const companyCode = typeof arg('--company') === 'string' ? arg('--company') : null
const targetName  = typeof arg('--name') === 'string' ? arg('--name') : null
const commit      = !!arg('--commit')

const baseCfg = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD }

async function resolveDb() {
  const plat = await mysql.createConnection({ ...baseCfg, database: process.env.PLATFORM_DB_NAME || 'acct_platform' })
  try {
    const [rows] = await plat.query('SELECT code, name, db_name FROM companies')
    const hit = rows.find(r => r.code === companyCode)
    if (!hit) { console.error(`회사코드 '${companyCode}' 없음`); process.exit(1) }
    console.log(`대상: ${hit.name} (${hit.code}) → ${hit.db_name}`)
    return hit.db_name
  } finally { await plat.end() }
}

async function main() {
  if (!companyCode || !targetName) { console.error('--company 와 --name 을 지정하세요.'); process.exit(1) }
  const dbName = await resolveDb()
  const pool = mysql.createPool({ ...baseCfg, database: dbName, connectionLimit: 3 })
  try {
    // vendors(id) 를 가리키는 모든 (테이블, 컬럼) — FK + vendor_id 이름
    const [refs] = await pool.query(
      `SELECT DISTINCT TABLE_NAME t, COLUMN_NAME c FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME='vendors' AND REFERENCED_COLUMN_NAME='id'
       UNION
       SELECT DISTINCT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=? AND COLUMN_NAME='vendor_id'`, [dbName, dbName])
    console.log(`\nvendor 참조 컬럼 ${refs.length}곳:`, refs.map(r => `${r.t}.${r.c}`).join(', '))

    const [cands] = await pool.query('SELECT id, name, biz_no, gubu, created_at FROM vendors WHERE name=? ORDER BY created_at', [targetName])
    if (cands.length !== 2) { console.error(`\n"${targetName}" 후보가 ${cands.length}개 — 정확히 2개일 때만 합칩니다. 중단.`); process.exit(1) }
    const keeper = cands[0], remove = cands[1]   // 오래된 쪽을 남긴다
    console.log(`\n남길 것 : ${keeper.id} (${keeper.name}, biz='${keeper.biz_no||''}', ${keeper.created_at})`)
    console.log(`합칠 것 : ${remove.id} (${remove.name}, biz='${remove.biz_no||''}', ${remove.created_at})`)

    // 각 참조 컬럼에서 remove 를 가리키는 행 수
    console.log('\n── remove 를 가리키는 연관 데이터 ──')
    let totalRefs = 0
    for (const { t, c } of refs) {
      const [[{ n }]] = await pool.query(`SELECT COUNT(*) n FROM \`${t}\` WHERE \`${c}\`=?`, [remove.id])
      if (n > 0) { console.log(`  ${t}.${c}: ${n}건`); totalRefs += n }
    }
    if (totalRefs === 0) console.log('  (없음 — remove 에 붙은 연관 데이터가 없습니다)')

    if (!commit) { console.log('\n[dry-run] 안 합쳤어요. --commit 을 붙이면 위 연관 데이터를 남길 것으로 옮기고 remove 를 삭제합니다.'); return }

    console.log('\n[commit] 합치는 중…')
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      let moved = 0
      for (const { t, c } of refs) {
        const [r] = await conn.execute(`UPDATE \`${t}\` SET \`${c}\`=? WHERE \`${c}\`=?`, [keeper.id, remove.id])
        moved += r.affectedRows
      }
      // 남길 것의 빈 칸을 remove 값으로 채운다(둘 다 개인이라 대개 없음)
      await conn.execute(
        `UPDATE vendors SET biz_no=COALESCE(NULLIF(biz_no,''), ?), ceo=COALESCE(NULLIF(ceo,''), ?) WHERE id=?`,
        [remove.biz_no || '', remove.ceo || '', keeper.id])
      const [d] = await conn.execute('DELETE FROM vendors WHERE id=?', [remove.id])
      await conn.commit()
      console.log(`\n✅ 완료 — 연관 데이터 ${moved}건 이동, 중복 ${d.affectedRows}건 삭제. 남은 거래처: ${keeper.id}`)
      // 검증: remove 를 가리키는 게 하나도 없어야
      let orphan = 0
      for (const { t, c } of refs) { const [[{ n }]] = await pool.query(`SELECT COUNT(*) n FROM \`${t}\` WHERE \`${c}\`=?`, [remove.id]); orphan += n }
      console.log(orphan === 0 ? '검증: 끊긴 참조 0건 ✅' : `⚠ 검증 실패: 남은 참조 ${orphan}건`)
    } catch (e) { await conn.rollback(); throw e } finally { conn.release() }
  } finally { await pool.end() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
