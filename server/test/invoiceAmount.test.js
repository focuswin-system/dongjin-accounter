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
const CREATOR = path.join(__dirname, '..', 'lib', 'invoiceCreate.js')

/* ⚠ 2026-09-07 갱신 — 청구서 INSERT 가 lib/invoiceCreate.js 한 곳으로 모였다.
 * 그 뒤로 이 테스트는 **라우트를 뒤지며 늘 0건을 찾아** 빨간불로 남아 있었다.
 * 빨간 테스트는 아무도 안 읽으므로 없는 것과 같다 — 지키려던 것(모든 발행 경로에
 * 금액 가드가 있다)은 그대로 두고, **보는 자리**를 지금 구조로 옮긴다.
 *   · 라우트는 직접 INSERT 하지 않는다        (격리검사 [17] 과 같은 규칙)
 *   · INSERT 는 createInvoice 안에 하나만 있다
 *   · createInvoice 를 부르는 라우트는 금액을 먼저 검사한다
 */

test('라우트는 청구서를 직접 INSERT 하지 않는다', () => {
  const direct = fs.readdirSync(routesDir)
    .filter(f => f.endsWith('.js'))
    .filter(f => read(f).includes('INSERT INTO invoices'))
    .sort()
  assert.deepEqual(direct, [],
    '라우트에서 청구서를 직접 INSERT 하고 있어요. lib/invoiceCreate.js 의 createInvoice 를 쓰세요.')
})

test('청구서 INSERT 는 createInvoice 안에 있다', () => {
  const src = fs.readFileSync(CREATOR, 'utf8')
  const n = src.split('INSERT INTO invoices').length - 1
  assert.equal(n, 1,
    `lib/invoiceCreate.js 의 청구서 INSERT 가 ${n}곳이에요. 만드는 자리가 옮겨졌거나 늘었어요 — 이 테스트를 갱신하세요.`)
})

test('createInvoice 를 부르는 라우트는 금액을 먼저 검사한다', () => {
  const callers = fs.readdirSync(routesDir)
    .filter(f => f.endsWith('.js'))
    .filter(f => read(f).includes('createInvoice('))
  assert.ok(callers.length > 0, 'createInvoice 를 부르는 라우트가 하나도 없어요 — 경로가 바뀌었어요')
  for (const f of callers) {
    const src = read(f)
    assert.ok(src.includes("require('../lib/ledger')") && src.includes('amountError('),
      `${f}: createInvoice 를 부르면서 amountError 가드가 없어요`)
    const calls  = src.split('createInvoice(').length - 1
    const guards = src.split('amountError(').length - 1
    assert.ok(guards >= calls,
      `${f}: 청구서 생성 ${calls}곳인데 amountError 호출은 ${guards}곳이에요. 빠진 경로가 있어요.`)
  }
})