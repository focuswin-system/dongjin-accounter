/**
 * 기입금·기지급 처리는 **거래를 만들기 전에 이미 있는 거래를 찾는다.**
 *
 * fowin 실데이터에서 실제로 일어난 일: 소급 등록이 회차마다 입금 거래를 새로 만들었고,
 * 통장에서 임포트한 진짜 입금은 짝 없이 떠돌았다. 같은 돈이 장부에 두 번 섰다.
 * 은행이 근거인 거래가 우선이다 — 붙일 게 있으면 붙이고, 없을 때만 만든다.
 * 후보가 둘이면 **고르지 않고 멈춘다**(어느 달 입금인지는 사람이 안다).
 *
 * DB 없이 검증한다 — conn 은 SQL 을 받아 정해진 답을 돌려주는 가짜다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const { settleInvoiceTxn } = require('../lib/settleTxn')

/** SQL 조각으로 무엇을 묻는지 가려내는 가짜 커넥션 */
const fakeConn = ({ candidates = [], pickable = null }) => {
  const calls = []
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
      if (sql.includes('FROM transactions t') && sql.includes('WHERE t.id = ?')) {
        return [pickable ? [pickable] : []]          // 화면이 고른 거래를 다시 확인하는 질의
      }
      if (sql.includes('FROM transactions t')) return [candidates]   // 후보 찾기
      return [{ affectedRows: 1 }]
    },
  }
}

const base = {
  invoiceId: 'inv-1', invoiceNo: '청구-2026-0001', kind: 'income',
  vendorId: 'v-1', contractId: null, amount: 132000, date: '2026-03-01',
  acctId: 'acc-1',
}

test('후보가 없으면 거래를 새로 만든다 (지금까지의 동작)', async () => {
  const conn = fakeConn({ candidates: [] })
  const r = await settleInvoiceTxn(conn, base)
  assert.equal(r.reused, false)
  const ins = conn.calls.find(c => c.sql.startsWith('INSERT INTO transactions'))
  assert.ok(ins, '새 거래를 만들어야 한다')
  const match = conn.calls.find(c => c.sql.startsWith('INSERT INTO invoice_matches'))
  assert.ok(match.sql.endsWith('VALUES (?,?,?,?,1)'), '우리가 만든 거래이므로 txn_created=1')
})

test('통장 입금이 딱 하나 있으면 새로 만들지 않고 그것에 붙인다', async () => {
  const conn = fakeConn({ candidates: [{ id: 'txn-real', date: '2026-03-03', amount: 132000, account_id: 'acc-9' }] })
  const r = await settleInvoiceTxn(conn, base)
  assert.equal(r.reused, true)
  assert.equal(r.txnId, 'txn-real')
  assert.ok(!conn.calls.some(c => c.sql.startsWith('INSERT INTO transactions')),
    '거래를 새로 만들면 같은 돈이 두 번 선다')
  const match = conn.calls.find(c => c.sql.startsWith('INSERT INTO invoice_matches'))
  assert.ok(match.sql.endsWith('VALUES (?,?,?,?,0)'), '남의 거래를 빌려 쓴 것이므로 txn_created=0 — 되돌리기가 지우면 안 된다')
})

test('붙일 때 계좌는 그 거래의 것을 쓴다 — 통장 값이 우리 짐작보다 정확하다', async () => {
  const conn = fakeConn({ candidates: [{ id: 'txn-real', date: '2026-03-03', amount: 132000, account_id: 'acc-9' }] })
  await settleInvoiceTxn(conn, base)
  const upd = conn.calls.find(c => c.sql.startsWith('UPDATE transactions SET invoice_id'))
  assert.equal(upd.params[2], 'acc-9')
})

test('같은 금액 후보가 둘이면 고르지 않고 멈춘다', async () => {
  const conn = fakeConn({ candidates: [
    { id: 'a', date: '2026-07-27', amount: 77000, account_id: 'acc-1' },
    { id: 'b', date: '2026-07-30', amount: 77000, account_id: 'acc-1' },
  ] })
  const r = await settleInvoiceTxn(conn, { ...base, amount: 77000, date: '2026-07-25' })
  assert.ok(r.error, '자동으로 고르면 틀린 달에 붙는다')
  assert.equal(r.candidates.length, 2, '무엇 중에서 고를지 화면에 돌려준다')
  assert.ok(!conn.calls.some(c => c.sql.startsWith('INSERT INTO')), '아무것도 만들지 않는다')
})

test('사람이 보고 새로 만들기를 고르면(forceNew) 후보가 있어도 만든다', async () => {
  const conn = fakeConn({ candidates: [
    { id: 'a', date: '2026-07-27', amount: 77000, account_id: 'acc-1' },
    { id: 'b', date: '2026-07-30', amount: 77000, account_id: 'acc-1' },
  ] })
  const r = await settleInvoiceTxn(conn, { ...base, amount: 77000, date: '2026-07-25', forceNew: true })
  assert.equal(r.reused, false)
  assert.ok(conn.calls.some(c => c.sql.startsWith('INSERT INTO transactions')))
})

test('화면이 고른 거래가 그 사이 다른 청구서에 붙었으면 만들지 않고 멈춘다', async () => {
  // pickable 이 비면 '아직 안 붙은 그 거래'를 못 찾은 것 — 누가 먼저 가져갔다는 뜻
  const conn = fakeConn({ candidates: [], pickable: null })
  const r = await settleInvoiceTxn(conn, { ...base, txnId: 'txn-taken' })
  assert.ok(r.error, '조용히 새 거래를 만들면 또 이중이 된다')
  assert.ok(!conn.calls.some(c => c.sql.startsWith('INSERT INTO')))
})

test('계좌를 끝내 알 수 없으면 만들지 않는다 — 잔액에서 통째로 누락된다', async () => {
  const conn = fakeConn({ candidates: [] })
  const r = await settleInvoiceTxn(conn, { ...base, acctId: null })
  assert.ok(r.error)
  assert.ok(!conn.calls.some(c => c.sql.startsWith('INSERT INTO')))
})
