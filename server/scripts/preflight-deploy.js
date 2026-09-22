#!/usr/bin/env node
/**
 * 배포 전 자가진단 — **읽기 전용**(SELECT 만, 아무것도 안 고친다).
 *
 *   cd server && node scripts/preflight-deploy.js
 *
 * ── 왜 필요한가 ──
 * 규칙을 고치는 배포는 **이미 쌓인 데이터의 해석을 바꾼다.** 코드 테스트는 새 데이터만 보고,
 * 로컬 테스트 테넌트는 실데이터의 모양을 대표하지 못한다. 그래서 운영 DB에 대고
 * "이번 배포로 무엇이 달라 보이게 되는가"를 배포 **전에** 세어 본다.
 *
 * 숫자가 0 이면 그대로 올리면 된다. 0 이 아니면 그 건들이 배포 후 **다르게 보인다** —
 * 틀려지는 게 아니라 이제야 맞게 보이는 것이지만, 미리 알고 올리는 것과 아닌 것은 다르다.
 */
require('dotenv').config()
const mysql = require('mysql2/promise')
const { appConfig, PLATFORM_DB } = require('../platform/db')

const TENANT_PATTERN = (process.env.TENANT_DB_PREFIX || 'acct_') + '%'

/* 각 항목: 무엇을 세는가 / 0 이 아니면 무슨 뜻인가 */
const CHECKS = [
  {
    label: '미완료 거래에 매칭된 청구서',
    why: '결제수단을 어음으로 바꾸는 등으로 거래가 미완료인데 청구서는 완료로 서 있던 건. '
       + '배포 후 그 청구서를 건드리면 미수금·미지급금으로 되살아난다(그게 맞는 값이다).',
    sql: (d) => `SELECT COUNT(DISTINCT i.id) n FROM \`${d}\`.invoices i
                   JOIN \`${d}\`.invoice_matches m ON m.invoice_id = i.id
                   JOIN \`${d}\`.transactions t ON t.id = m.txn_id
                  WHERE REPLACE(t.status,' ','') NOT IN ('지급완료','입금완료')
                    AND i.status IN ('입금 완료','지급 완료','일부 입금','일부 지급')`,
  },
  {
    label: '거래가 없어진 고아 매칭',
    why: '거래는 지워졌는데 매칭 줄만 남은 것. 새 규칙은 거래를 JOIN 하므로 이 줄은 정산에서 빠진다 — '
       + '그만큼 미수금·미지급금이 늘어 보인다.',
    sql: (d) => `SELECT COUNT(*) n FROM \`${d}\`.invoice_matches m
                   LEFT JOIN \`${d}\`.transactions t ON t.id = m.txn_id WHERE t.id IS NULL`,
  },
  {
    label: '공급가+세액 ≠ 합계 인 거래',
    why: '옛 경로로 들어온 어긋난 세액. **기존 행은 그대로 둔다**(배포가 데이터를 안 고친다). '
       + '다만 그 거래를 다시 저장하면 새 규칙이 합계 기준으로 되돌린다.',
    sql: (d) => `SELECT COUNT(*) n FROM \`${d}\`.transactions
                  WHERE vat_amount IS NOT NULL AND supply_amount IS NOT NULL
                    AND supply_amount + vat_amount <> amount`,
  },
  {
    label: "겸함('C') 거래처의 주문",
    why: '방향(contracts.side)이 이번 배포에서 채워진다. 옛 규칙 그대로 매출로 채우므로 숫자는 안 바뀌지만, '
       + '그중 실제로는 발주인 건이 있으면 주문 편집의 구분 칩으로 고쳐야 한다.',
    sql: (d) => `SELECT COUNT(*) n FROM \`${d}\`.contracts ct
                   JOIN \`${d}\`.vendors v ON v.id = ct.vendor_id WHERE v.gubu = 'C'`,
  },
  {
    label: '계정과목이 빈 거래',
    why: '전표에서 한쪽 다리가 없는 거래. 이번 배포가 만들지는 않지만, 있으면 분개장·일계표가 그만큼 안 맞는다.',
    sql: (d) => `SELECT COUNT(*) n FROM \`${d}\`.transactions WHERE account_code IS NULL OR account_code = ''`,
  },
]

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length))

;(async () => {
  const conn = await mysql.createConnection({ ...appConfig, database: undefined })
  const [dbs] = await conn.query('SHOW DATABASES LIKE ?', [TENANT_PATTERN])
  const names = dbs.map(r => Object.values(r)[0]).filter(n => n !== PLATFORM_DB)

  console.log('━'.repeat(72))
  console.log(' 배포 전 자가진단 (읽기 전용)')
  console.log('━'.repeat(72))

  const totals = CHECKS.map(() => 0)
  for (const db of names) {
    const cells = []
    for (let i = 0; i < CHECKS.length; i++) {
      try {
        const [[row]] = await conn.query(CHECKS[i].sql(db))
        const n = Number(row.n) || 0
        totals[i] += n
        cells.push(n)
      } catch (e) {
        cells.push(e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR' ? '-' : 'ERR')
      }
    }
    console.log(` ${pad(db, 16)} ` + cells.map((c, i) => `${CHECKS[i].label.slice(0, 10)}=${c}`).join('  '))
  }

  console.log('\n' + '─'.repeat(72))
  let dirty = false
  CHECKS.forEach((c, i) => {
    const mark = totals[i] > 0 ? '⚠' : '✅'
    if (totals[i] > 0) dirty = true
    console.log(` ${mark} ${c.label}: ${totals[i]}건`)
    if (totals[i] > 0) console.log(`    ${c.why}`)
  })
  console.log('─'.repeat(72))
  console.log(dirty
    ? ' 0 이 아닌 항목이 있습니다. 위 설명을 읽고 올릴지 정하세요 — 막는 것이 아니라 알리는 것입니다.'
    : ' 전부 0 — 이번 배포로 기존 데이터가 다르게 보이는 건은 없습니다.')
  console.log('━'.repeat(72) + '\n')
  await conn.end()
})().catch(e => { console.error('진단 실패:', e.message); process.exit(1) })
