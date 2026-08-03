/**
 * 청구서 금액 검증이 **모든 발행 경로에** 걸려 있는지 지키는 테스트.
 *
 * 2026-08-03 검수에서 실제 데이터에 0원 청구서('입금 예정')가 남아 있는 것을 발견했다.
 * 청구서를 만드는 경로가 8곳인데 금액을 검사하는 곳이 하나도 없었다.
 * 0원 청구서는 홈 '할 일'과 미수금 목록을 채우고, 음수 청구서는 미수금 총액을 깎아
 * 다른 청구서를 상계하며 부가세 과세표준까지 함께 줄인다.
 *
 * 단위 테스트로 각 라우트를 부르려면 DB가 필요하므로, 여기서는 **소스에 가드가
 * 남아 있는지**를 검사한다. 부실해 보이지만 이 결함의 성격이 '검사를 빠뜨림'이라
 * 재발 지점이 정확히 여기다 — 새 발행 경로를 추가하면서 가드를 잊으면 걸린다.
 *
 * 규칙(amountError 자체의 동작)은 ledger.test.js 가 따로 검증한다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const routesDir = path.join(__dirname, '..', 'routes')
const read = (f) => fs.readFileSync(path.join(routesDir, f), 'utf8')

/** 청구서를 INSERT 하는 라우트 파일 목록 — 새 파일이 생기면 이 테스트가 알려준다. */
const INVOICE_WRITERS = [
  'invoices.js', 'contracts.js', 'recurring.js', 'recurring-invoices.js', 'purchase-reqs.js',
]

test('청구서를 만드는 파일이 늘었으면 이 테스트를 갱신해야 한다', () => {
  const found = fs.readdirSync(routesDir)
    .filter(f => f.endsWith('.js'))
    .filter(f => read(f).includes('INSERT INTO invoices'))
    .sort()
  assert.deepEqual(found, [...INVOICE_WRITERS].sort(),
    '청구서를 INSERT 하는 라우트가 바뀌었어요. 새 경로에도 amountError 가드를 넣고 목록을 갱신하세요.')
})

test('청구서 INSERT 가 있는 파일은 모두 amountError 를 쓴다', () => {
  for (const f of INVOICE_WRITERS) {
    const src = read(f)
    assert.ok(src.includes("require('../lib/ledger')") && src.includes('amountError'),
      `${f}: amountError 를 가져오지 않았어요`)
  }
})

test('INSERT 개수만큼 amountError 가드가 있다', () => {
  for (const f of INVOICE_WRITERS) {
    const src = read(f)
    const inserts = (src.match(/INSERT INTO invoices/g) || []).length
    // require 줄 1개를 뺀 실제 호출 수
    const guards = (src.match(/amountError\(/g) || []).length
    assert.ok(guards >= inserts,
      `${f}: 청구서 INSERT ${inserts}곳인데 amountError 호출은 ${guards}곳이에요. 빠진 경로가 있어요.`)
  }
})
