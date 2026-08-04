/**
 * 서버 오류 수집
 *
 * 수집기는 '오류가 난 순간'에 도는 코드다. 여기서 나는 버그는 최악이다 —
 * 진짜 장애를 가리거나(기록 실패로 요청이 안 끝남) 장애를 키운다(폭주 시 DB 두들김).
 * 그래서 세 가지를 못 박아 둔다.
 *
 *   1) 저장되는 값에 회사 기밀이 없다 (logSafe 를 거친 것만)
 *   2) 기록이 실패해도 절대 던지지 않는다
 *   3) 폭주하면 버리되, 버렸다는 사실은 남긴다
 *
 * DB 없이 전부 검증된다 — exec 를 주입하는 이유가 이것이다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const { createErrorRecorder, buildRow, fingerprintOf, MAX_PER_WINDOW } = require('../lib/errorLog')

/** 실행된 SQL·파라미터를 모아두는 가짜 exec */
const spyExec = () => {
  const calls = []
  const fn = (sql, params) => { calls.push({ sql, params }); return Promise.resolve() }
  fn.calls = calls
  return fn
}

const sqlErr = () => Object.assign(new Error('x'), {
  code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000',
  sqlMessage: "Duplicate entry 'INV-2026-0001' for key 'uq_invoice_no'",
  sql: "INSERT INTO invoices (amount, vendor) VALUES (13500000, '포커스윈')",
})

const req = () => ({
  method: 'POST', originalUrl: '/api/invoices',
  user: { id: 'u1', companyId: 'c1', username: 'fwadmin', dbName: 'acct_fowin' },
})

test('저장되는 행에 값이 남지 않는다', () => {
  const row = buildRow({ err: sqlErr(), req: req(), status: 500 })
  const dumped = JSON.stringify(row)
  assert.ok(!dumped.includes('INV-2026-0001'), '청구번호가 DB에 남으면 안 된다')
  assert.ok(!dumped.includes('포커스윈'), '거래처명이 DB에 남으면 안 된다')
  assert.ok(!dumped.includes('13500000'), '금액이 DB에 남으면 안 된다')
  assert.ok(row.message.includes('uq_invoice_no'), '어느 제약인지는 남아야 진단이 된다')
})

test('누가·어느 회사인지는 남는다', () => {
  const row = buildRow({ err: sqlErr(), req: req(), status: 500 })
  assert.strictEqual(row.companyId, 'c1')
  assert.strictEqual(row.username, 'fwadmin')
  assert.strictEqual(row.path, '/api/invoices')
  assert.strictEqual(row.status, 500)
  assert.strictEqual(row.code, 'ER_DUP_ENTRY')
})

test('같은 버그는 ID·숫자가 달라도 한 묶음이 된다', () => {
  const a = fingerprintOf({ code: 'TypeError', message: "빈 값 '123'", frame: 'at f (a.js:1:1)' })
  const b = fingerprintOf({ code: 'TypeError', message: "빈 값 '987'", frame: 'at f (a.js:1:1)' })
  assert.strictEqual(a, b, '숫자만 다른 같은 오류는 묶여야 한다')
})

test('다른 오류는 다른 묶음이 된다', () => {
  const a = fingerprintOf({ code: 'TypeError', message: 'x', frame: 'at f (a.js:1:1)' })
  const b = fingerprintOf({ code: 'TypeError', message: 'x', frame: 'at g (b.js:9:9)' })
  assert.notStrictEqual(a, b, '발생 지점이 다르면 다른 버그다')
})

test('로그인 전(req 없음) 오류도 기록된다', () => {
  const row = buildRow({ err: new Error('부팅 중'), req: null, status: 0 })
  assert.strictEqual(row.companyId, null)
  assert.strictEqual(row.status, null)
  assert.ok(row.fingerprint)
})

test('DB 기록이 실패해도 던지지 않는다', async () => {
  const rec = createErrorRecorder({
    exec: () => Promise.reject(new Error('관리 DB 접속 불가')),
    log: { warn() {} },
  })
  const ok = await rec.record({ err: new Error('원래 오류'), req: req() })
  assert.strictEqual(ok, false, '실패는 false 로 알리고 조용히 넘어간다')
})

test('오류 객체가 이상해도 죽지 않는다', async () => {
  const exec = spyExec()
  const rec = createErrorRecorder({ exec, log: { warn() {} } })
  await rec.record({ err: null, req: null })
  await rec.record({ err: '문자열 오류', req: null })
  assert.strictEqual(exec.calls.length, 2, '이상한 입력도 기록 자체는 된다')
})

test('폭주하면 창당 상한까지만 기록한다', async () => {
  const exec = spyExec()
  const warns = []
  const rec = createErrorRecorder({
    exec, now: () => 1_000, log: { warn: m => warns.push(m) },
  })
  for (let i = 0; i < MAX_PER_WINDOW + 20; i++) {
    await rec.record({ err: new Error('루프'), req: req() })
  }
  assert.strictEqual(exec.calls.length, MAX_PER_WINDOW, '상한을 넘겨 DB를 두들기지 않는다')
})

test('버린 건수는 다음 창에서 알린다 — 조용히 버리면 오독한다', async () => {
  const exec = spyExec()
  const warns = []
  let t = 1_000
  const rec = createErrorRecorder({
    exec, now: () => t, log: { warn: m => warns.push(String(m)) },
  })
  for (let i = 0; i < MAX_PER_WINDOW + 5; i++) {
    await rec.record({ err: new Error('루프'), req: req() })
  }
  t += 61_000                                   // 다음 창
  await rec.record({ err: new Error('그 다음'), req: req() })
  assert.ok(warns.some(w => w.includes('5건')), `버린 5건을 알려야 한다: ${warns.join(' / ')}`)
})

test('정리는 보관 기간이 지난 것만 지운다', async () => {
  const exec = spyExec()
  const rec = createErrorRecorder({ exec })
  await rec.prune(90)
  assert.match(exec.calls[0].sql, /DELETE FROM error_logs/)
  assert.deepStrictEqual(exec.calls[0].params, [90])
})
