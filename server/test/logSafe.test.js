/**
 * 로그 위생
 *
 * 여러 회사의 회계 데이터를 한 서버에서 다루므로, 서버 로그에 남의 회사 값이 남으면 안 된다.
 * 위험한 건 의도적으로 남긴 로그가 아니라 **새는 로그**다 — MariaDB 오류 메시지에는
 * 실제 값이 박혀 오고(Duplicate entry 'INV-2026-0001' …), mysql2 오류 객체에는
 * 실행한 SQL이 통째로 붙는다. 예전엔 그걸 `console.error(err)` 로 그대로 찍었다.
 *
 * 반대 방향도 함께 지킨다 — 값은 지우되 **누가·어느 회사인지는 반드시 남긴다.**
 * 그게 없으면 장애가 나도 어느 테넌트 문제인지 알 수 없다.
 *
 * DB 없이 전부 검증된다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const { safeErr, reqTag, maskSqlMessage } = require('../lib/logSafe')

/** mysql2 가 실제로 내려주는 모양의 가짜 오류 */
const sqlErr = (sqlMessage, extra = {}) => Object.assign(new Error(sqlMessage), {
  code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000', sqlMessage, ...extra,
})

test('중복 오류에서 값은 가리고 제약 이름은 남긴다', () => {
  const out = maskSqlMessage("Duplicate entry 'INV-2026-0001' for key 'uq_invoice_no'")
  assert.ok(!out.includes('INV-2026-0001'), '청구번호 값이 로그에 남으면 안 된다')
  assert.ok(out.includes('uq_invoice_no'), '어느 제약이 걸렸는지는 진단에 필요하다')
})

test('그 밖의 SQL 메시지는 따옴표 값을 전부 가린다', () => {
  const out = maskSqlMessage(
    "Cannot add or update a child row: FOREIGN KEY (`vendor_id`) REFERENCES `vendors` ('포커스윈')"
  )
  assert.ok(!out.includes('포커스윈'), '거래처명이 로그에 남으면 안 된다')
})

test('오류를 다듬어도 코드·errno 는 남는다', () => {
  const out = safeErr(sqlErr("Duplicate entry '1234567890' for key 'uq_vendor_biz_no'"))
  assert.strictEqual(out.code, 'ER_DUP_ENTRY')
  assert.strictEqual(out.errno, 1062)
  assert.ok(!JSON.stringify(out).includes('1234567890'), '사업자번호가 어디에도 남으면 안 된다')
})

test('mysql2 가 붙이는 SQL 문(err.sql)은 절대 싣지 않는다', () => {
  const err = sqlErr('Duplicate entry ...', {
    sql: "INSERT INTO transactions (amount, vendor) VALUES (13500000, '포커스윈')",
  })
  const dumped = JSON.stringify(safeErr(err))
  assert.ok(!dumped.includes('13500000'), '금액이 로그에 남으면 안 된다')
  assert.ok(!dumped.includes('INSERT INTO'), 'SQL 문 자체를 남기지 않는다')
})

test('스택의 첫 줄(원문 메시지)은 버리고 프레임만 남긴다', () => {
  const err = sqlErr("Duplicate entry '기밀값' for key 'uq_x'")
  const out = safeErr(err)
  assert.ok(!(out.at || []).join('\n').includes('기밀값'), '스택 머리글로도 값이 샌다')
  assert.ok((out.at || []).every(l => l.startsWith('at ')), '프레임 줄만 남는다')
})

test('일반 JS 오류 메시지는 가리지 않는다 — 원인 파악이 막힌다', () => {
  const out = safeErr(new TypeError("Cannot read properties of undefined (reading 'total')"))
  assert.ok(out.message.includes('total'), '런타임 메시지는 값이 아니라 진단 정보다')
  assert.strictEqual(out.name, 'TypeError')
})

test('오류가 아닌 값을 던져도 죽지 않는다', () => {
  assert.ok(safeErr(null).message)
  assert.ok(safeErr('그냥 문자열').message)
  assert.ok(safeErr(undefined).message)
})

test('로그에 어느 회사의 누구인지가 남는다', () => {
  const tag = reqTag({
    method: 'POST', originalUrl: '/api/transactions',
    user: { dbName: 'acct_fowin', username: 'fwadmin' },
  })
  assert.ok(tag.includes('acct_fowin'), '테넌트를 알 수 없으면 장애 추적이 불가능하다')
  assert.ok(tag.includes('fwadmin'))
  assert.ok(tag.includes('/api/transactions'))
})

test('로그인 전 요청도 꼬리표를 만든다', () => {
  const tag = reqTag({ method: 'POST', originalUrl: '/api/auth/login' })
  assert.ok(tag.includes('비로그인'))
  assert.ok(tag.includes('/api/auth/login'))
})
