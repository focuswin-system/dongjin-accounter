#!/usr/bin/env node
// 정기청구가 과거로 소급 생성돼 쌓인 청구서 정리 스크립트.
//
// 안전장치:
//  - 기본은 미리보기(dry-run). 실제 삭제는 --commit 필요.
//  - 삭제 대상은 "정기청구로 만들어졌고 + 아직 입금/매칭이 전혀 없는(입금 예정)" 건뿐.
//    → 이미 입금됐거나(invoice_matches) 거래(transactions.invoice_id)가 붙은 건은 절대 건드리지 않는다.
//  - 거래처를 반드시 지정해야 --commit 가능(전체 거래처를 한 번에 지우는 사고 방지).
//
// ⚠ 멀티테넌트: 어느 회사 DB를 대상으로 할지 반드시 --company 로 지정해야 한다.
//    (예전엔 db.js의 전역 pool을 썼는데, 멀티테넌트 전환 때 pool은 export되지 않게 바뀌어
//     이 스크립트는 실행 즉시 TypeError로 죽는 상태였다. 회사를 추측해 지우면 더 큰 사고다.)
//
// 사용법(운영 서버의 server/ 폴더에서):
//   node scripts/cleanup-recurring-invoices.js                                       # 회사 목록 확인
//   node scripts/cleanup-recurring-invoices.js --company fowin                       # 그 회사 미리보기
//   node scripts/cleanup-recurring-invoices.js --company fowin --vendor "금강..."     # 거래처 한정 미리보기
//   node scripts/cleanup-recurring-invoices.js --company fowin --vendor "금강..." --commit   # 실제 삭제
//
// 옵션:
//   --company "<회사코드>"  대상 회사(필수). 미지정 시 목록만 보여주고 종료
//   --vendor "<이름 일부>"  거래처 이름 부분일치로 한정
//   --auto-only            memo가 '정기청구 자동 생성%'인 일괄생성분만(기본은 '정기청구%' 전부)
//   --commit               실제 삭제 실행

// 실행 위치(cwd)와 무관하게 서버가 쓰는 것과 같은 DB 설정을 확실히 로드.
// (dotenv는 이미 존재하는 env를 덮어쓰지 않으므로 root/.env → server/.env 순서로 채운다)
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const mysql = require('mysql2/promise')

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null
}

const vendorLike  = typeof arg('--vendor') === 'string' ? arg('--vendor') : null
const companyCode = typeof arg('--company') === 'string' ? arg('--company') : null
const autoOnly    = !!arg('--auto-only')
const commit      = !!arg('--commit')
const memoPat     = autoOnly ? '정기청구 자동 생성%' : '정기청구%'

const baseCfg = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
}

// 회사코드 → 그 회사의 DB 이름. 어느 회사인지 절대 추측하지 않는다.
async function resolveDb() {
  const plat = await mysql.createConnection({ ...baseCfg, database: process.env.PLATFORM_DB_NAME || 'acct_platform' })
  try {
    const [rows] = await plat.query('SELECT code, name, db_name FROM companies ORDER BY id')
    if (!companyCode) {
      console.log('\n대상 회사를 --company 로 지정하세요:\n')
      console.table(rows.map(r => ({ 회사코드: r.code, 회사명: r.name, DB: r.db_name })))
      console.log('예)  node scripts/cleanup-recurring-invoices.js --company ' + (rows[0]?.code || '<코드>'))
      return null
    }
    const hit = rows.find(r => r.code === companyCode)
    if (!hit) {
      console.error(`\n❌ '${companyCode}' 회사를 찾을 수 없어요. 위 목록의 회사코드를 쓰세요.`)
      console.table(rows.map(r => ({ 회사코드: r.code, 회사명: r.name })))
      return null
    }
    console.log(`\n대상 회사: ${hit.name} (${hit.code}) → ${hit.db_name}`)
    return hit.db_name
  } finally {
    await plat.end()
  }
}

async function main() {
  const dbName = await resolveDb()
  if (!dbName) return
  const pool = mysql.createPool({ ...baseCfg, database: dbName, connectionLimit: 3 })
  try {
    await run(pool)
  } finally {
    await pool.end()
  }
}

async function run(pool) {
  // 삭제 대상 조건: 정기청구발(memo) + 입금 예정(미정산) + 매칭/거래 없음
  const where = `
    i.kind = 'issued'
    AND i.memo LIKE ?
    AND i.status = '입금 예정'
    AND NOT EXISTS (SELECT 1 FROM invoice_matches m WHERE m.invoice_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM transactions t   WHERE t.invoice_id = i.id)
    ${vendorLike ? 'AND v.name LIKE ?' : ''}`
  const params = vendorLike ? [memoPat, `%${vendorLike}%`] : [memoPat]

  // 1) 미리보기: 거래처별 건수·금액·기간
  const [summary] = await pool.execute(
    `SELECT v.name AS vendor, COUNT(*) AS cnt, SUM(i.total_amount) AS total,
            MIN(i.issued_at) AS first_date, MAX(i.issued_at) AS last_date
     FROM invoices i LEFT JOIN vendors v ON i.vendor_id = v.id
     WHERE ${where}
     GROUP BY v.name ORDER BY cnt DESC`, params)

  const totalCnt = summary.reduce((s, r) => s + Number(r.cnt), 0)
  console.log(`\n=== 삭제 대상 미리보기 (memo LIKE '${memoPat}', status='입금 예정', 매칭·거래 없음) ===`)
  if (vendorLike) console.log(`거래처 필터: "%${vendorLike}%"`)
  if (!totalCnt) { console.log('대상 없음. 지울 게 없습니다.'); return }
  console.table(summary.map(r => ({
    거래처: r.vendor, 건수: Number(r.cnt),
    합계금액: Number(r.total).toLocaleString(),
    기간: `${r.first_date} ~ ${r.last_date}`,
  })))
  console.log(`총 ${totalCnt}건`)

  // 샘플 5건
  const [sample] = await pool.execute(
    `SELECT i.invoice_no, v.name AS vendor, i.issued_at, i.total_amount, i.status, LEFT(i.memo,30) AS memo
     FROM invoices i LEFT JOIN vendors v ON i.vendor_id = v.id
     WHERE ${where} ORDER BY i.issued_at LIMIT 5`, params)
  console.log('\n샘플(가장 오래된 5건):')
  console.table(sample)

  if (!commit) {
    console.log('\n[미리보기 모드] 실제로 지우려면 --commit 을 붙여 다시 실행하세요.')
    if (!vendorLike) console.log('안전을 위해 --commit 은 --vendor 지정이 있어야만 동작합니다.')
    return
  }
  if (!vendorLike) {
    console.log('\n[중단] 전체 거래처 일괄 삭제는 막아뒀습니다. --vendor 로 거래처를 지정하세요.')
    return
  }

  // 2) 실제 삭제 (한 트랜잭션)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    // 혹시 남아있을 수 있는 첨부(invoice_docs)만 정리하고 삭제 — matches/transactions는 위 조건상 없음
    const [del] = await conn.execute(
      `DELETE i FROM invoices i LEFT JOIN vendors v ON i.vendor_id = v.id WHERE ${where}`, params)
    await conn.commit()
    console.log(`\n✅ ${del.affectedRows}건 삭제 완료.`)
  } catch (e) {
    try { await conn.rollback() } catch { /* 롤백 실패는 삼킨다 — 원래 오류를 덮지 않도록 */ }
    console.error('삭제 실패, 롤백함:', e.code || e.message)
  } finally {
    conn.release()
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
