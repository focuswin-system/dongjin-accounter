/* 문서 복사 규칙(src/lib/docCopy.js) — 무엇을 옮기고 **무엇을 안 옮기는지**.
 *
 * 대상 모듈은 프런트엔드 ESM이지만 순수 함수라 여기서 동적 import 로 부른다(hometax.test.js 와 같은 방식).
 * 이 테스트가 지키는 것: 원본의 연결(청구서·지출·품의)·결재·상태·날짜·문서번호가 복사본에 따라오면
 * 같은 돈이 두 번 결재된다(사용자 확정 2026-09-15). 칸이 새로 생겨도 허용 목록에 적기 전엔 안 옮겨진다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { pathToFileURL } = require('url')

const loading = import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', 'docCopy.js')).href)

const preq = {
  id: 'p1', doc_no: 'GM-2026-0001', req_date: '2026-08-21', status: '승인', approval: [{ label: '대표', name: '홍길동' }],
  invoice_id: 'inv-1', invoice: { invoice_no: '매입-2026-0001' }, txn_id: 'tx-1', resolution: { id: 'r1' },
  source: { type: 'invoice', id: 'inv-1' }, applicant: '김경리',
  vendor_id: 'v1', vendor_name: '청소용역', order_source: '본사', ship_no: '', summary: '8월 청소', pay_terms: '월말', man_hours: '', note: '정기',
  items: [{ name: '사무실 청소', unit: '회', qty: 4, unit_price: 50000, amount: 200000, actual_price: 48000, actual_amount: 192000, memo: '' }],
  new_column_someday: '옮기면 안 됨',
}
const resolution = {
  id: 'r1', doc_no: 'DJ-2026-0001', pay_date: '2026-08-31', status: '완료', approval: [{ label: '대표', name: '홍길동' }],
  invoice_id: 'inv-1', purchase_req_id: 'p1', txn_id: 'tx-1', applicant: '김경리',
  vendor_id: 'v1', vendor_name: '청소용역', title: '8월 청소비', pay_method: '현금', note: '정기',
  items: [{ name: '사무실 청소', unit: '회', qty: 4, price: 50000, amount: 200000, note: '' },
          { name: '유리창', unit: '회', qty: 1, price: 80000, amount: 80000, note: '' }],
}

test('구매품의서 — 거래처·건명·품목은 옮기고, 연결·결재·상태·날짜·번호·신청자는 안 옮긴다', async () => {
  const { copySeedOf } = await loading
  const s = copySeedOf('preq', preq)
  assert.strictEqual(s.vendor_name, '청소용역')
  assert.strictEqual(s.summary, '8월 청소')
  assert.strictEqual(s.items.length, 1)
  for (const k of ['id', 'doc_no', 'req_date', 'status', 'approval', 'invoice_id', 'invoice', 'txn_id', 'resolution', 'source', 'applicant', 'new_column_someday']) {
    assert.ok(!(k in s), `${k} 가 복사됐다`)
  }
})

test('구매품의서 — 실단가·실금액은 비운다(아직 안 산 것이다)', async () => {
  const { copySeedOf } = await loading
  const [it] = copySeedOf('preq', preq).items
  assert.strictEqual(it.unit_price, '50000')
  assert.strictEqual(it.actual_price, '')
  assert.strictEqual(it.actual_amount, '')
})

test('지급결의서 — 연결(청구서·품의·지출)·지급일·상태·결재는 안 옮긴다', async () => {
  const { copySeedOf, resolutionTotalOf } = await loading
  const s = copySeedOf('resolution', resolution)
  assert.strictEqual(s.title, '8월 청소비')
  assert.strictEqual(s.pay_method, '현금')
  for (const k of ['id', 'doc_no', 'pay_date', 'status', 'approval', 'invoice_id', 'purchase_req_id', 'txn_id', 'applicant']) {
    assert.ok(!(k in s), `${k} 가 복사됐다`)
  }
  assert.strictEqual(resolutionTotalOf(s.items), 280000)
})

test('거래처 옆에서 가져올 때(itemsOnly)는 거래처를 건드리지 않는다', async () => {
  const { copySeedOf } = await loading
  const p = copySeedOf('preq', preq, { itemsOnly: true })
  assert.deepStrictEqual(Object.keys(p).sort(), ['items', 'summary'])
  const r = copySeedOf('resolution', resolution, { itemsOnly: true })
  assert.deepStrictEqual(Object.keys(r).sort(), ['items', 'title'])
})

test('모르는 종류·빈 문서는 null', async () => {
  const { copySeedOf } = await loading
  assert.strictEqual(copySeedOf('preq', null), null)
  assert.strictEqual(copySeedOf('quote', preq), null)
})

test('지급결의서 — 일부 지급된 청구서에서 온 원본의 기지급액(음수) 줄은 빼고, 청구서 번호 비고는 비운다', async () => {
  const { copySeedOf, resolutionTotalOf } = await loading
  const fromBill = {
    ...resolution, invoice_id: 'inv-9',
    items: [
      { name: '용역', unit: '식', qty: 1, price: 1000000, amount: 1000000, note: '' },
      { name: '부가세', unit: '', qty: 1, price: 100000, amount: 100000, note: '매입-2026-0009' },
      { name: '기지급액', unit: '', qty: 1, price: -500000, amount: -500000, note: '이미 지급한 금액' },
    ],
  }
  const s = copySeedOf('resolution', fromBill)
  assert.strictEqual(s.items.some(it => it.name === '기지급액'), false)
  assert.strictEqual(resolutionTotalOf(s.items), 1100000)   // 60만이 아니라 원래 청구 금액
  assert.ok(s.items.every(it => it.note === ''), '청구서 번호가 비고에 남았다')
})

test('지급결의서 — 청구서와 무관한 원본은 비고를 그대로 둔다', async () => {
  const { copySeedOf } = await loading
  const s = copySeedOf('resolution', { ...resolution, invoice_id: null,
    items: [{ name: '간식', unit: '식', qty: 1, price: 30000, amount: 30000, note: '팀 공용' }] })
  assert.strictEqual(s.items[0].note, '팀 공용')
})
