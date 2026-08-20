#!/usr/bin/env node
// 기준정보 '정기예금' 계좌 → 예금·적금·보증금(savings) 이관 정리 스크립트.
//
// ── 왜 필요한가 ──
// accounts 는 **결제수단**이다. 거래 등록·급여이체·청구서 정산 등 여러 화면에서
// 드롭다운으로 서고, 잔액은 balancesAsOf() 를 거쳐 자금 예측의 '쓸 수 있는 돈'에
// 그대로 합산된다. 그런데 계좌 유형에 '정기예금'이 있어서, 묶여 있는 돈을 계좌로
// 등록할 수 있었다. 그러면 두 가지가 조용히 깨진다:
//   1. 못 쓰는 돈이 가용 잔액에 잡힌다 → 현금 과부족이 낙관 쪽으로 틀린다
//   2. 결제수단 드롭다운에 서서 "정기예금 통장에서 외주비 지급"이 가능해진다
//
// 실제로 fowin 은 퇴직연금 신탁을 '정기예금' 계좌로 등록해 두고 savings 에도 같은
// 금액을 넣어, 904,870원이 **가용 잔액과 묶인 돈 양쪽에** 잡혀 있었다(이중계상).
//
// ── 이 스크립트가 하는 일 ──
//   1. type='정기예금' 계좌를 찾아 참조 관계를 전수 확인한다
//   2. 참조가 계좌 잔액 조정(account_adjustments)뿐이면 → 조정과 계좌를 지운다
//   3. 거래·청구서 등 **다른 참조가 하나라도 있으면 건드리지 않고 보고만 한다**
//      (이력이 끊기면 그 거래가 계좌 없는 상태로 떠서 잔액표 어디에도 안 잡힌다)
//
// savings 쪽 금액은 **손대지 않는다.** 이미 들어가 있는 값이 진실이고, 여기서
// 다시 만들면 오히려 두 번 잡힌다. 대응되는 savings 행이 없으면 지우지 않고 알린다.
//
// ⚠ 멀티테넌트: 어느 회사 DB를 대상으로 할지 반드시 --company 로 지정해야 한다.
//
// 사용법(운영 서버의 server/ 폴더에서):
//   node scripts/migrate-time-deposit-accounts.js                     # 회사 목록
//   node scripts/migrate-time-deposit-accounts.js --company fowin     # 미리보기(기본)
//   node scripts/migrate-time-deposit-accounts.js --company fowin --commit   # 실제 삭제
//
// 옵션:
//   --company "<회사코드>"  대상 회사(필수)
//   --commit               실제 삭제 실행(기본은 미리보기)

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const mysql = require('mysql2/promise')

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null
}
const companyCode = typeof arg('--company') === 'string' ? arg('--company') : null
const commit = !!arg('--commit')

const baseCfg = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
}

/* 계좌를 가리키는 컬럼 전부. 하나라도 빠뜨리면 참조가 남은 계좌를 지워
   그 거래가 '계좌 미지정'으로 떨어진다 — 잔액표 어디에도 안 서게 된다.
   account_adjustments 는 여기 없다. 그건 이 계좌에 딸린 값이라 함께 지운다. */
const REFS = [
  ['accounts', 'card_pay_account_id', '카드 결제계좌'],
  ['expense_resolutions', 'txn_prev_account_id', '지출결의서'],
  ['investments', 'account_id', '투자'],
  ['invoices', 'account_id', '청구서'],
  ['loans', 'account_id', '차입금'],
  ['other_taxes', 'account_id', '세금'],
  ['recurring_expenses', 'account_id', '정기지출'],
  ['recurring_invoices', 'account_id', '정기청구'],
  ['ref_items', 'account_id', '기준항목'],
  ['savings', 'account_id', '예적금 출금계좌'],
  ['transactions', 'account_id', '거래'],
  ['transactions', 'counterparty_account_id', '거래(상대계좌)'],
  ['vat_filings', 'account_id', '부가세 신고'],
]

const won = (n) => Number(n || 0).toLocaleString('ko-KR')

async function resolveDb() {
  const plat = await mysql.createConnection({
    ...baseCfg, database: process.env.PLATFORM_DB_NAME || 'acct_platform' })
  try {
    const [rows] = await plat.query('SELECT code, name, db_name FROM companies ORDER BY id')
    if (!companyCode) {
      console.log('\n대상 회사를 --company 로 지정하세요:\n')
      console.table(rows.map(r => ({ 회사코드: r.code, 회사명: r.name, DB: r.db_name })))
      return null
    }
    const hit = rows.find(r => r.code === companyCode)
    if (!hit) {
      console.error(`\n❌ '${companyCode}' 회사를 찾을 수 없어요.`)
      console.table(rows.map(r => ({ 회사코드: r.code, 회사명: r.name })))
      return null
    }
    console.log(`\n대상 회사: ${hit.name} (${hit.code}) → ${hit.db_name}`)
    return hit.db_name
  } finally { await plat.end() }
}

/** 이 계좌를 가리키는 곳이 있는가 — 있으면 [{ 곳, 건수 }] */
async function refsOf(pool, id) {
  const out = []
  for (const [table, col, label] of REFS) {
    const [[{ n }]] = await pool.execute(
      `SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${col}\` = ?`, [id])
    if (Number(n) > 0) out.push({ 곳: label, 건수: Number(n) })
  }
  return out
}

/** 계좌 잔액 = 초기잔액 + 입금 − 출금 + 조정. balancesAsOf() 와 같은 식이어야 한다. */
async function balanceOf(pool, a) {
  const [[r]] = await pool.execute(`
    SELECT COALESCE((SELECT SUM(amount) FROM transactions
                      WHERE kind='income'  AND account_id=? AND status='입금완료'), 0) AS inc,
           COALESCE((SELECT SUM(amount) FROM transactions
                      WHERE kind='expense' AND account_id=? AND status='지급완료'), 0) AS exp,
           COALESCE((SELECT SUM(amount) FROM account_adjustments WHERE account_id=?), 0) AS adj`,
    [a.id, a.id, a.id])
  return Number(a.initial_balance || 0) + Number(r.inc) - Number(r.exp) + Number(r.adj)
}

async function run(pool) {
  const [accs] = await pool.execute(
    "SELECT id, name, bank, type, number, purpose, initial_balance FROM accounts WHERE type = '정기예금'")
  if (!accs.length) {
    console.log("\n'정기예금' 유형 계좌가 없습니다. 정리할 게 없어요.")
    return
  }

  console.log(`\n=== '정기예금' 계좌 ${accs.length}건 ===`)
  const removable = []
  for (const a of accs) {
    const bal = await balanceOf(pool, a)
    const refs = await refsOf(pool, a.id)
    const [[{ adj }]] = await pool.execute(
      'SELECT COUNT(*) AS adj FROM account_adjustments WHERE account_id = ?', [a.id])

    /* savings 에 같은 돈이 이미 있는지 — 금액이 같으면 이중계상이라는 뜻이다.
       이름이 달라도(계좌 '우리은행-퇴직연금신탁' vs 저축 '퇴직연금 (우리은행)') 금액으로 잡힌다. */
    const [twins] = await pool.execute(
      "SELECT id, name, kind, principal FROM savings WHERE status='active' AND principal = ?", [bal])

    console.log(`\n── ${a.name} (${a.bank || '은행 미상'} ${a.number || ''})`)
    console.log(`   용도      : ${a.purpose || '—'}`)
    console.log(`   계좌 잔액 : ${won(bal)}원  (초기 ${won(a.initial_balance)} · 조정 ${adj}건)`)
    if (twins.length) {
      for (const t of twins) console.log(`   ⚠ 저축에 같은 금액 있음 : "${t.name}" (${t.kind}) ${won(t.principal)}원 → 이중계상`)
    } else {
      console.log('   ⚠ 저축(savings)에 대응되는 항목이 없습니다 — 지우면 이 돈이 어디에도 안 남아요.')
    }
    if (refs.length) {
      console.log('   참조가 남아 있어 건드리지 않습니다:')
      console.table(refs)
      continue
    }
    if (!twins.length) {
      console.log('   → 먼저 예금·적금·보증금 화면에 등록한 뒤 다시 실행하세요. 이번엔 건너뜁니다.')
      continue
    }
    console.log(`   → 삭제 대상 (계좌 1건 + 잔액 조정 ${adj}건)`)
    removable.push({ a, adj })
  }

  if (!removable.length) {
    console.log('\n지울 수 있는 계좌가 없습니다.')
    return
  }
  if (!commit) {
    console.log(`\n미리보기입니다. 실제로 지우려면 --commit 을 붙여 다시 실행하세요.`)
    console.log(`  node scripts/migrate-time-deposit-accounts.js --company ${companyCode} --commit`)
    return
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    for (const { a } of removable) {
      /* 조정을 먼저 지운다 — 계좌가 먼저 사라지면 조정이 고아로 남아,
         나중에 같은 id 가 재사용될 때 엉뚱한 계좌 잔액을 흔든다. */
      await conn.execute('DELETE FROM account_adjustments WHERE account_id = ?', [a.id])
      await conn.execute('DELETE FROM accounts WHERE id = ?', [a.id])
      console.log(`삭제: ${a.name}`)
    }
    await conn.commit()
    console.log(`\n✅ ${removable.length}건 정리했습니다.`)
  } catch (e) {
    try { await conn.rollback() } catch {}
    throw e
  } finally { conn.release() }
}

/* 예금(deposit)으로 잘못 들어간 퇴직연금을 kind='pension' 으로 옮긴다.
 *
 * 구분(kind)은 화면에서 못 바꾼다 — 회차·이자 계산의 전제가 통째로 달라져서 일부러 잠갔다.
 * 그래서 이미 들어간 값은 여기서 고친다. 대상을 좁게 잡는다:
 *   kind='deposit' 인데 **기간도 이율도 0** (= 예금이 될 수 없는 값) + 이름에 '퇴직연금'
 * 기간·이율이 채워진 진짜 예금은 건드리지 않는다. */
async function fixPensionKind(pool) {
  const [rows] = await pool.execute(`
    SELECT id, name, principal, acct_code FROM savings
     WHERE kind = 'deposit' AND term_months = 0 AND annual_rate = 0
       AND name LIKE '%퇴직연금%'`)
  if (!rows.length) return

  /* ENUM 에 'pension' 이 아직 없으면 UPDATE 가 값을 **빈 문자열로 만든다**(MySQL 기본 모드).
     그러면 그 행이 어느 구분에도 안 잡혀 화면에서 사라진다 — 조용한 데이터 손상이다.
     ENUM 확장은 서버가 뜰 때 db.js 가 한다. 그러니 배포·재시작 뒤에 이 스크립트를 돌려야 한다. */
  const [[col]] = await pool.execute(
    `SELECT COLUMN_TYPE AS t FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'savings' AND column_name = 'kind'`)
  if (!String(col?.t || '').includes("'pension'")) {
    console.log("\n⚠ savings.kind 에 아직 'pension' 이 없습니다. 새 코드를 배포하고 서버를 재시작한 뒤 다시 실행하세요.")
    console.log(`  (현재: ${col?.t || '알 수 없음'})`)
    process.exitCode = 1
    return
  }

  console.log(`\n=== 예금으로 등록된 퇴직연금 ${rows.length}건 → 구분을 '퇴직연금'으로 ===`)
  console.table(rows.map(r => ({ 이름: r.name, 금액: won(r.principal), 계정과목: r.acct_code || '—' })))
  if (!commit) { console.log('미리보기입니다. --commit 을 붙이면 바꿉니다.'); return }
  for (const r of rows) {
    // 계정과목도 함께 옮긴다. 1201(단기금융상품)로 남으면 재무상태표에서 당좌자산에 선다 —
    // 퇴직연금 적립금은 1년 안에 현금이 되지 않으므로 투자자산(1505)이 맞다.
    await pool.execute("UPDATE savings SET kind='pension', acct_code='1505' WHERE id = ?", [r.id])
    console.log(`변경: ${r.name}`)
  }
  console.log(`✅ ${rows.length}건 변경했습니다.`)
}

async function main() {
  const dbName = await resolveDb()
  if (!dbName) return
  const pool = mysql.createPool({ ...baseCfg, database: dbName, connectionLimit: 3 })
  try {
    await fixPensionKind(pool)
    await run(pool)
  } finally { await pool.end() }
}

main().catch(e => { console.error(e); process.exit(1) })
