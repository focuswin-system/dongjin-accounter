/**
 * 감사 로그 — 무엇을 남기고 무엇을 남기지 않는가
 *
 * 회계 데이터라 "그 거래 누가 지웠지?"에 답하지 못하면 감사가 성립하지 않는다.
 * 반대로 로그가 장부의 사본이 되어도 안 된다 — 금액·거래처명은 회사 비밀이다.
 * 그 두 경계를 여기서 못 박는다.
 *
 * 경로 규칙은 서로 잡아먹기 쉽다(삭제 vs 취소, 월 삭제 vs 건 삭제). 그 오분류가
 * 곧 '기록은 남았는데 엉뚱한 행위로 남은' 상태라, 겹치는 짝을 특히 촘촘히 본다.
 *
 * DB 없이 전부 검증된다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { EventEmitter } = require('node:events')

const {
  auditRuleFor, targetIdFrom, AUDIT_RULES, ACTION_LABELS, RESOURCE_LABELS,
} = require('../platform/auditMap')
const { createAuditTrail } = require('../middleware/auditTrail')

/** 경로 → { resource, action, target } 로 간단히 보는 도우미 */
const look = (method, path, ctx = {}) => {
  const found = auditRuleFor(method, path)
  if (!found) return null
  return {
    res: found.rule.res,
    action: found.rule.action,
    target: targetIdFrom(found, { body: ctx.body, createdId: ctx.createdId }),
  }
}

// ── 남겨야 할 것 ──

test('마감과 마감 해제를 구별해 남긴다', () => {
  assert.deepStrictEqual(
    look('POST', '/api/closings', { body: { period: '2026-07' } }),
    { res: 'closing', action: 'close', target: '2026-07' })
  assert.deepStrictEqual(
    look('DELETE', '/api/closings/2026-07'),
    { res: 'closing', action: 'reopen', target: '2026-07' })
})

test('거래 삭제는 대상 ID와 함께 남는다', () => {
  assert.deepStrictEqual(
    look('DELETE', '/api/transactions/t-123'),
    { res: 'transaction', action: 'delete', target: 't-123' })
})

test('새로 발행한 청구서는 응답의 id를 대상으로 남는다', () => {
  assert.deepStrictEqual(
    look('POST', '/api/invoices', { createdId: 'inv-9' }),
    { res: 'invoice', action: 'issue', target: 'inv-9' })
})

test('급여 지급과 지급 취소가 모두 남는다', () => {
  assert.deepStrictEqual(
    look('POST', '/api/payroll/p1/pay'),
    { res: 'payroll', action: 'pay', target: 'p1' })
  assert.deepStrictEqual(
    look('DELETE', '/api/payroll/p1/pay/tx9'),
    { res: 'payroll', action: 'pay_cancel', target: 'p1' })
})

// ── 겹치는 짝을 잘못 분류하지 않는가 ──

test('월 단위 급여 삭제를 건 삭제로 오인하지 않는다', () => {
  assert.deepStrictEqual(
    look('DELETE', '/api/payroll/month/2026-07'),
    { res: 'payroll', action: 'delete_month', target: '2026-07' })
})

test('입금 매칭 취소를 청구서 삭제로 오인하지 않는다', () => {
  assert.deepStrictEqual(
    look('DELETE', '/api/invoices/i1/matches/m1'),
    { res: 'invoice', action: 'match_cancel', target: 'i1' })
})

test('적금 미납 회차 납입을 일반 납입으로 오인하지 않는다', () => {
  assert.deepStrictEqual(
    look('POST', '/api/savings/s1/pay-missed'),
    { res: 'savings', action: 'pay_missed', target: 's1' })
  assert.deepStrictEqual(
    look('POST', '/api/savings/s1/pay'),
    { res: 'savings', action: 'pay', target: 's1' })
})

test('상환 취소를 차입금 삭제로 오인하지 않는다', () => {
  assert.deepStrictEqual(
    look('DELETE', '/api/finance/loans/l1/repay/2'),
    { res: 'loan', action: 'repay_cancel', target: 'l1' })
  assert.deepStrictEqual(
    look('DELETE', '/api/finance/loans/l1'),
    { res: 'loan', action: 'delete', target: 'l1' })
})

// ── 남기지 않아야 할 것 ──

test('조회는 남기지 않는다 — 남기면 정작 중요한 기록이 묻힌다', () => {
  assert.strictEqual(look('GET', '/api/transactions'), null)
  assert.strictEqual(look('GET', '/api/invoices/i1'), null)
})

test('첨부 삭제를 청구서 삭제로 오인하지 않는다', () => {
  assert.strictEqual(look('DELETE', '/api/invoices/docs/d1'), null)
  assert.strictEqual(look('DELETE', '/api/transactions/docs/d1'), null)
})

test('기준정보 수정은 남기지 않는다', () => {
  assert.strictEqual(look('PUT', '/api/vendors/v1'), null)
  assert.strictEqual(look('POST', '/api/categories'), null)
})

test('본문에서는 규칙이 지정한 필드 하나만 꺼낸다', () => {
  const found = auditRuleFor('POST', '/api/closings')
  const target = targetIdFrom(found, {
    body: { period: '2026-07', amount: 13500000, vendor: '포커스윈' },
  })
  assert.strictEqual(target, '2026-07', '금액·거래처는 애초에 쳐다보지 않는다')
})

// ── 미들웨어 동작 ──

/** 가짜 res — finish 를 직접 발화시킨다 */
const fakeRes = (statusCode = 200) => Object.assign(new EventEmitter(), {
  statusCode, json(body) { return body },
})

const runMw = ({ method, path, statusCode = 200, body, respond }) => {
  const logged = []
  const mw = createAuditTrail({ audit: e => logged.push(e), clientIp: () => '10.0.0.9' })
  const req = { method, originalUrl: path, body, user: { id: 'u1', companyId: 'c1', username: 'kyung' } }
  const res = fakeRes(statusCode)
  let passed = false
  mw(req, res, () => { passed = true })
  if (respond) res.json(respond)
  res.emit('finish')
  return { logged, passed }
}

test('성공한 요청만 남긴다 — 권한 거부가 삭제 기록으로 남으면 안 된다', () => {
  const ok = runMw({ method: 'DELETE', path: '/api/transactions/t1', statusCode: 200 })
  assert.strictEqual(ok.logged.length, 1)

  for (const code of [403, 404, 409, 500]) {
    const bad = runMw({ method: 'DELETE', path: '/api/transactions/t1', statusCode: code })
    assert.strictEqual(bad.logged.length, 0, `${code} 는 아무것도 바꾸지 않았다`)
  }
})

test('남기는 항목은 누가·무엇을·대상·IP 뿐이다', () => {
  const { logged } = runMw({ method: 'DELETE', path: '/api/transactions/t1' })
  assert.deepStrictEqual(logged[0], {
    companyId: 'c1', userId: 'u1', username: 'kyung',
    action: 'delete', resource: 'transaction', targetId: 't1', ip: '10.0.0.9',
  })
})

test('응답 본문에서 id 말고는 아무것도 가져가지 않는다', () => {
  const { logged } = runMw({
    method: 'POST', path: '/api/invoices',
    body: { amount: 13500000, vendor: '포커스윈' },
    respond: { id: 'inv-9', amount: 13500000, vendor: '포커스윈' },
  })
  assert.strictEqual(logged[0].targetId, 'inv-9')
  const dumped = JSON.stringify(logged[0])
  assert.ok(!dumped.includes('13500000'), '금액이 감사 로그에 남으면 안 된다')
  assert.ok(!dumped.includes('포커스윈'), '거래처명이 감사 로그에 남으면 안 된다')
})

test('감사 대상이든 아니든 요청은 그대로 흘러간다', () => {
  assert.ok(runMw({ method: 'DELETE', path: '/api/transactions/t1' }).passed)
  assert.ok(runMw({ method: 'GET', path: '/api/transactions' }).passed)
})

test('응답을 감싸도 원래 본문은 그대로 나간다', () => {
  const mw = createAuditTrail({ audit() {}, clientIp: () => '' })
  const req = { method: 'POST', originalUrl: '/api/invoices', body: {}, user: {} }
  const sent = []
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, json(body) { sent.push(body); return this },
  })
  mw(req, res, () => {})
  res.json({ id: 'inv-1', total: 100 })
  assert.deepStrictEqual(sent, [{ id: 'inv-1', total: 100 }], '응답이 변형되면 안 된다')
})

// ── 규칙표 자체의 위생 ──

test('규칙은 전부 전체 경로에 고정돼 있다', () => {
  for (const r of AUDIT_RULES) {
    const src = r.re.source
    assert.ok(src.startsWith('^\\/api\\/'), `앞이 열린 규칙은 남의 경로를 잡는다: ${src}`)
    assert.ok(src.endsWith('$'), `뒤가 열린 규칙은 하위 경로까지 잡는다: ${src}`)
  }
})

test('모든 규칙의 행위·대상에 화면 이름이 있다', () => {
  // 이름이 없으면 변경 이력 화면에 'pay_missed' 같은 코드값이 그대로 나온다.
  // 규칙을 추가하면서 이름표를 빠뜨리는 게 가장 흔한 실수라 여기서 막는다.
  for (const r of AUDIT_RULES) {
    assert.ok(ACTION_LABELS[r.action], `행위 이름 없음: ${r.action}`)
    assert.ok(RESOURCE_LABELS[r.res], `대상 이름 없음: ${r.res}`)
  }
})

test('계정 관련 행위에도 이름이 있다 — 기록하는 곳은 둘이어도 읽는 곳은 하나다', () => {
  // routes/auth.js 가 직접 남기는 것들(감사 미들웨어를 거치지 않는다)
  for (const a of ['login', 'login_fail', 'password_change', 'password_reset',
                   'activate', 'deactivate', 'role_change', 'roles_assign', 'create']) {
    assert.ok(ACTION_LABELS[a], `행위 이름 없음: ${a}`)
  }
  assert.ok(RESOURCE_LABELS.user)
})

test('경로 캡처를 쓰는 규칙에는 그 번호의 캡처 그룹이 있다', () => {
  // 캡처가 없는데 target:1 이면 대상 ID가 조용히 null 로 남는다 —
  // '누가 무엇을 지웠는지'에서 '무엇을'이 빠진 기록이 된다.
  for (const r of AUDIT_RULES) {
    if (typeof r.target !== 'number') continue
    const groups = new RegExp(r.re.source + '|').exec('').length - 1
    assert.ok(groups >= r.target,
      `${r.res}/${r.action}: 캡처 그룹 ${groups}개인데 target:${r.target} 을 쓴다`)
  }
})
