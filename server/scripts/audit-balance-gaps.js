#!/usr/bin/env node
/**
 * 계좌 잔액 누락 진단 — 읽기 전용 (SELECT만, 쓰기 없음)
 *
 * Phase 1 코드 품질 검토에서 확인된 P0(F-02 동형) 결함들이
 * 이미 만들어낸 데이터가 얼마나 되는지 규모를 파악한다.
 *
 * 배경: 계좌 잔액은 `kind='expense' AND account_id = a.id AND status='지급완료'`
 *       조건의 거래만 합산한다(routes/accounts.js). 따라서
 *       - account_id 가 NULL 이면  → 어느 계좌에서도 차감되지 않음
 *       - status 가 '지급완료' 가 아니면 → 차감되지 않음
 *       두 경우 모두 통장은 줄었는데 장부 잔액은 그대로 남는다.
 *
 * 사용: cd server && node scripts/audit-balance-gaps.js
 *       특정 DB만: node scripts/audit-balance-gaps.js winc_ac
 */
require('dotenv').config()
const mysql = require('mysql2/promise')

const CHECKS = [
  {
    label: 'account_id NULL 지출',
    note: '어느 계좌 잔액에서도 차감되지 않음',
    sql: `SELECT COUNT(*) cnt, COALESCE(SUM(amount),0) amt
            FROM transactions WHERE kind='expense' AND account_id IS NULL`,
  },
  {
    label: '  └ 결의서 유래 (resolutions.js:195)',
    sql: `SELECT COUNT(*) cnt, COALESCE(SUM(amount),0) amt
            FROM transactions WHERE kind='expense' AND account_id IS NULL
             AND doc_no IS NOT NULL AND doc_no NOT IN ('','공통')`,
  },
  {
    label: '  └ 급여·용역 유래 (payroll.js:243)',
    sql: `SELECT COUNT(*) cnt, COALESCE(SUM(amount),0) amt
            FROM transactions WHERE kind='expense' AND account_id IS NULL
             AND payroll_id IS NOT NULL`,
  },
  {
    label: 'account_id NULL 입금',
    note: '잔액에 더해지지 않음',
    sql: `SELECT COUNT(*) cnt, COALESCE(SUM(amount),0) amt
            FROM transactions WHERE kind='income' AND account_id IS NULL`,
  },
  {
    label: "status 공백/NULL",
    note: 'F-02 원형 — 모든 상태 필터에서 누락',
    sql: `SELECT COUNT(*) cnt, COALESCE(SUM(amount),0) amt
            FROM transactions WHERE status IS NULL OR TRIM(status)=''`,
  },
  {
    label: "'지급 완료' (공백형 잔재)",
    note: "표준형은 '지급완료'(공백 없음)",
    sql: `SELECT COUNT(*) cnt, COALESCE(SUM(amount),0) amt
            FROM transactions WHERE status='지급 완료'`,
  },
  {
    label: '청구서에 연결됐는데 미완료 지출',
    note: 'invoices.js:177 — 청구서만 완료되고 잔액은 그대로',
    sql: `SELECT COUNT(*) cnt, COALESCE(SUM(t.amount),0) amt
            FROM transactions t JOIN invoice_matches m ON m.txn_id = t.id
           WHERE t.kind='expense' AND t.status <> '지급완료'`,
  },
  {
    label: '매칭액 ≠ 거래액 (transactions.js:126)',
    note: '거래 금액 수정 후 invoice_matches 가 안 따라간 흔적',
    sql: `SELECT COUNT(*) cnt, COALESCE(SUM(ABS(m.amount - t.amount)),0) amt
            FROM invoice_matches m JOIN transactions t ON t.id = m.txn_id
           WHERE m.amount <> t.amount`,
  },
]

const won = (n) => Number(n).toLocaleString('ko-KR') + '원'

async function auditDb(conn, dbName) {
  console.log(`\n${'─'.repeat(78)}\n■ ${dbName}\n${'─'.repeat(78)}`)
  let dirty = 0
  for (const c of CHECKS) {
    try {
      const [rows] = await conn.query(c.sql)
      const { cnt, amt } = rows[0]
      const flag = cnt > 0 ? '⚠' : ' '
      if (cnt > 0) dirty++
      console.log(`${flag} ${c.label.padEnd(38)} ${String(cnt).padStart(6)}건 ${won(amt).padStart(18)}`)
      if (cnt > 0 && c.note) console.log(`  ${' '.repeat(38)} └ ${c.note}`)
    } catch (e) {
      console.log(`  ${c.label.padEnd(38)} (조회 불가: ${e.code || e.message})`)
    }
  }
  return dirty
}

;(async () => {
  const only = process.argv[2]
  const base = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  }

  let targets = []
  if (only) {
    targets = [only]
  } else {
    // 플랫폼 DB에서 회사별 DB 목록을 읽는다
    const plat = await mysql.createConnection({ ...base, database: process.env.PLATFORM_DB_NAME || 'acct_platform' })
    try {
      const [rows] = await plat.query('SELECT code, db_name FROM companies ORDER BY id')
      targets = rows.map((r) => r.db_name)
      console.log(`대상 회사 ${rows.length}개: ${rows.map((r) => `${r.code}(${r.db_name})`).join(', ')}`)
    } finally {
      await plat.end()
    }
  }

  let totalDirty = 0
  for (const dbName of targets) {
    const conn = await mysql.createConnection({ ...base, database: dbName })
    try {
      totalDirty += await auditDb(conn, dbName)
    } finally {
      await conn.end()
    }
  }

  console.log(`\n${'═'.repeat(78)}`)
  console.log(totalDirty === 0
    ? '✅ 잔액 누락으로 이어지는 데이터가 발견되지 않았습니다.'
    : `⚠ ${totalDirty}개 항목에서 잔액 누락 데이터가 발견됐습니다. 위 ⚠ 표시를 확인하세요.`)
  console.log('   (이 스크립트는 읽기 전용입니다 — 아무것도 수정하지 않았습니다)')
})().catch((e) => {
  console.error('실패:', e.code || e.message)
  process.exit(1)
})
