/**
 * 2026년 거래처 외상매입현황 임포트 스크립트
 * 실행: node import-payables.js [--year 2025]
 *
 * 기본값: 2026년 통합 시트 → invoices (received) + vendors 자동 추가
 */

const { randomUUID } = require('crypto')
const path = require('path')
const XLSX = require('xlsx')
const db = require('./db')

// ─── 인자 파싱 ────────────────────────────────────────────────
const args = process.argv.slice(2)
const yearArg = args.includes('--year') ? args[args.indexOf('--year') + 1] : '2026'
const DRY_RUN = args.includes('--dry-run')
const currentYear = new Date().getFullYear().toString()
const IS_HISTORICAL = yearArg < currentYear  // 전년도 → 지급 완료 처리

const EXCEL_FILE = path.join(
  'C:/Users/USER/Desktop/동진테크/동진자료',
  `${yearArg}년 거래처 외상매입현황(01월~12월).xlsx`
)
const SHEET_NAME = `${yearArg}년 통합`

console.log(`\n동진테크 외상매입현황 임포트 (${yearArg}년)`)
console.log('파일:', EXCEL_FILE)
if (DRY_RUN) console.log('⚠️  DRY-RUN 모드 (DB 기록 없음)')
console.log('─'.repeat(60))

// ─── 엑셀 날짜 변환 ──────────────────────────────────────────
function excelDateToISO(serial) {
  if (!serial || typeof serial !== 'number') return null
  // Excel serial → JS Date (UTC 기준)
  const d = new Date(Math.round((serial - 25569) * 86400 * 1000))
  return d.toISOString().slice(0, 10)
}

// ─── 기존 거래처 캐시 ────────────────────────────────────────
function buildVendorCache() {
  const rows = db.prepare('SELECT id, name FROM vendors').all()
  const cache = new Map()
  for (const r of rows) {
    // 정규화: ㈜, (주) 제거 후 소문자 비교
    const normalized = r.name.replace(/[㈜()주]/g, '').trim()
    cache.set(normalized, r.id)
    cache.set(r.name, r.id) // 원본명도 등록
  }
  return cache
}

function normalizeVendorName(name) {
  return String(name).replace(/[㈜()주]/g, '').trim()
}

function getOrCreateVendor(name, cache, stats) {
  if (!name || String(name).trim() === '') return null
  const normalized = normalizeVendorName(name)

  // 정확 매칭 또는 정규화 매칭
  if (cache.has(name)) return cache.get(name)
  if (cache.has(normalized)) return cache.get(normalized)

  // 신규 거래처 생성
  const id = randomUUID()
  if (!DRY_RUN) {
    db.prepare('INSERT INTO vendors (id, name, gubu, type, service_type) VALUES (?,?,?,?,?)')
      .run(id, name, 'A', '매입처', '외주/자재')
  }
  cache.set(name, id)
  cache.set(normalized, id)
  stats.newVendors++
  return id
}

// ─── 메인 임포트 ─────────────────────────────────────────────
function run() {
  const wb = XLSX.readFile(EXCEL_FILE)
  if (!wb.SheetNames.includes(SHEET_NAME)) {
    console.error(`❌ 시트 없음: "${SHEET_NAME}"`)
    console.log('사용 가능한 시트:', wb.SheetNames.join(', '))
    process.exit(1)
  }

  const ws = wb.Sheets[SHEET_NAME]
  // header: 1 → 2D 배열, 첫 2행은 헤더
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  // 데이터 행: 3번째 행(index 2)부터, NO 컬럼이 숫자인 행
  const dataRows = allRows.filter((r, i) => i >= 2 && typeof r[0] === 'number' && r[0] !== '')

  console.log(`총 데이터 행: ${dataRows.length}건`)

  // 컬럼 인덱스 (Row 1 헤더 기준)
  // [0]NO [1]일자 [2]거래처 [3]품명 [4]단위 [5]수량 [6]단가
  // [7]공급가액 [8]부가세 [9]합계 [10]접수 [11]담당자
  // [12]수주처 [13]호선 [14]사용처 [15]비고

  const vendorCache = buildVendorCache()
  const stats = { inserted: 0, skipped: 0, newVendors: 0, errors: 0 }

  // 이미 임포트된 데이터 확인 (중복 방지)
  const existingCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM invoices WHERE kind='received' AND memo LIKE '%"src":"payables-import-${yearArg}"%'`
  ).get().cnt

  if (existingCount > 0) {
    console.log(`⚠️  이미 임포트된 데이터 ${existingCount}건 존재 (--force 옵션으로 재실행 가능)`)
    if (!args.includes('--force')) {
      console.log('중복 임포트를 방지합니다. --force 옵션을 추가하면 재임포트합니다.')
      process.exit(0)
    }
    // --force: 기존 데이터 삭제 후 재임포트
    if (!DRY_RUN) {
      const del = db.prepare(
        `DELETE FROM invoices WHERE kind='received' AND memo LIKE '%"src":"payables-import-${yearArg}"%'`
      ).run()
      console.log(`🗑️  기존 데이터 ${del.changes}건 삭제`)
    }
  }

  const insInvoice = db.prepare(`
    INSERT INTO invoices
      (id, kind, vendor_id, supply_amount, vat_amount, total_amount, issued_at, status, memo)
    VALUES
      (?,?,?,?,?,?,?,?,?)
  `)

  let batchCount = 0
  const BATCH_SIZE = 100

  const doImport = db.transaction(() => {
    for (const row of dataRows) {
      try {
        const dateISO = excelDateToISO(row[1])
        if (!dateISO) { stats.skipped++; continue }

        const vendorName = String(row[2]).trim()
        const itemName   = String(row[3]).trim()
        const supplyAmt  = Math.round(Number(row[7]) || 0)
        const vatAmt     = Math.round(Number(row[8]) || 0)
        const totalAmt   = Math.round(Number(row[9]) || 0)

        if (totalAmt === 0) { stats.skipped++; continue }

        const vendorId = getOrCreateVendor(vendorName, vendorCache, stats)

        // 수주처/호선/사용처는 memo JSON에 저장
        const memo = JSON.stringify({
          src:     `payables-import-${yearArg}`,
          item:    itemName,
          unit:    String(row[4]).trim() || '',
          qty:     Number(row[5]) || 0,
          uprice:  Math.round(Number(row[6]) || 0),
          buyer:   String(row[12]).trim() || '',
          vessel:  String(row[13]).trim() || '',
          usage:   String(row[14]).trim() || '',
          manager: String(row[11]).trim() || '',
          note:    String(row[15]).trim() || '',
          receipt: String(row[10]).trim() || '',
        })

        // 전년도 데이터는 지급 완료, 당해년도는 지급 대기
        const status = IS_HISTORICAL ? '지급 완료' : '지급 대기'

        if (!DRY_RUN) {
          insInvoice.run(
            randomUUID(),
            'received',
            vendorId,
            supplyAmt,
            vatAmt,
            totalAmt,
            dateISO,
            status,
            memo
          )
        }

        stats.inserted++
        batchCount++

        if (batchCount % BATCH_SIZE === 0) {
          process.stdout.write(`\r  처리 중: ${batchCount} / ${dataRows.length}건`)
        }
      } catch (e) {
        stats.errors++
        if (stats.errors <= 5) console.error('\n  ⚠️  오류 행:', row[0], e.message)
      }
    }
  })

  doImport()

  console.log(`\r  처리 완료: ${dataRows.length}건`.padEnd(50))
  console.log('\n─'.repeat(60))
  console.log('📊 임포트 결과')
  console.log(`  ✅ 등록:       ${stats.inserted.toLocaleString()}건`)
  console.log(`  ⏭️  건너뜀:    ${stats.skipped.toLocaleString()}건`)
  console.log(`  🏢 신규 거래처: ${stats.newVendors.toLocaleString()}개`)
  if (stats.errors > 0)
    console.log(`  ❌ 오류:       ${stats.errors.toLocaleString()}건`)

  // 금액 합계 출력
  if (!DRY_RUN) {
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS cnt,
        SUM(supply_amount) AS supply,
        SUM(vat_amount) AS vat,
        SUM(total_amount) AS total
      FROM invoices
      WHERE kind='received' AND memo LIKE '%"src":"payables-import-${yearArg}"%'
    `).get()
    console.log('\n💰 등록된 금액 합계')
    console.log(`  공급가액: ${totals.supply.toLocaleString()}원`)
    console.log(`  부가세:   ${totals.vat.toLocaleString()}원`)
    console.log(`  합   계:  ${totals.total.toLocaleString()}원`)
  }

  console.log('\n다음 단계:')
  console.log('  node index.js                   ← 서버 실행')
  console.log('  GET /api/invoices?kind=received  ← 임포트 확인')
  console.log('  GET /api/invoices/summary/payables ← 미지급 요약')
}

run()
