/**
 * 비목 채번·연결 — **번호만 보고 판단하면 남의 비목에 계정과목을 바른다.**
 *
 * 사용자가 만드는 비목은 `MAX(번호)+1` 로 채번된다. 최초 시드가 EXP-904 에서 끝나므로
 * 사용자가 처음 만든 지출 비목이 EXP-905 였는데, 나중에 표준 비목 보강이 EXP-905~915 를
 * 번호로 못 박아 쓰면서 같은 번호를 다투게 됐다. 그러면:
 *   · 표준 '감가상각비'는 영영 안 생기고
 *   · 사용자의 '차량 리스료'(EXP-905)에 5209(감가상각비)가 발린다
 * 그 뒤 그 비목으로 찍은 거래가 전부 감가상각비로 분개된다 — 에러도 로그도 없이.
 *
 * 여기서 잠그는 것:
 *   1. 사용자 채번이 표준 번호대(9000 미만)를 침범하지 않는다
 *   2. 표준 비목 목록과 매핑 표가 서로 어긋나지 않는다
 */
const test = require('node:test')
const assert = require('node:assert')

const { CATEGORY_ACCOUNT, EXTRA_CATEGORIES, isFundAccount } = require('../lib/categoryAccount')

/** routes/categories.js 의 채번 규칙과 같은 식 — 규칙이 갈리면 여기서 깨진다 */
const USER_ID_BASE = 9000
const nextUserId = (prefix, maxno) => `${prefix}-${Math.max(Number(maxno), USER_ID_BASE) + 1}`

test('사용자 채번은 표준 번호대를 침범하지 않는다', () => {
  // 최초 시드 직후(EXP-904)에 사용자가 비목을 만들어도 905 를 가져가면 안 된다
  assert.equal(nextUserId('EXP', 904), 'EXP-9001')
  // 표준 보강까지 끝난 상태(915)에서도 마찬가지
  assert.equal(nextUserId('EXP', 915), 'EXP-9001')
  assert.equal(nextUserId('INC', 204), 'INC-9001')
  // 이미 사용자 번호가 있으면 그 다음
  assert.equal(nextUserId('EXP', 9001), 'EXP-9002')
})

test('예전 규칙이었다면 표준 번호와 충돌했다 — 회귀 방지', () => {
  const oldRule = (prefix, maxno) => `${prefix}-${Number(maxno) + 1}`
  const collided = oldRule('EXP', 904)                 // 'EXP-905'
  const claimed = new Set(EXTRA_CATEGORIES.map(([id]) => id))
  assert.ok(claimed.has(collided),
    '표준 비목이 EXP-905 를 쓰므로, 옛 규칙이면 사용자 비목과 같은 번호가 된다')
  assert.ok(!claimed.has(nextUserId('EXP', 904)),
    '새 규칙으로 뽑은 번호는 표준 목록 어디에도 없어야 한다')
})

test('표준 비목은 전부 9000 미만 — 사용자 구간을 안 쓴다', () => {
  for (const [id] of EXTRA_CATEGORIES) {
    const no = Number(String(id).split('-').pop())
    assert.ok(no < USER_ID_BASE, `${id} 가 사용자 번호대(${USER_ID_BASE}+)를 쓰고 있다`)
  }
})

test('표준 비목 id 는 서로 겹치지 않는다', () => {
  const ids = EXTRA_CATEGORIES.map(([id]) => id)
  assert.equal(new Set(ids).size, ids.length, '표준 비목 목록에 같은 id 가 둘 있다')
})

test('표준 비목 이름도 서로 겹치지 않는다', () => {
  // 시딩이 이름으로 중복을 거르므로, 목록 안에 같은 이름이 둘이면 하나는 영영 안 들어간다
  const names = EXTRA_CATEGORIES.map(([, name]) => name)
  assert.equal(new Set(names).size, names.length, '표준 비목 목록에 같은 이름이 둘 있다')
})

test('표준 비목은 전부 계정과목이 정해져 있다', () => {
  // 매핑이 없으면 시딩이 account_code = null 로 넣고, 그 비목으로 찍은 거래는
  // 일계표에서 상대 계정이 없어 차·대변이 안 맞는다
  for (const [id, name] of EXTRA_CATEGORIES) {
    assert.ok(CATEGORY_ACCOUNT[id], `${id}(${name}) 에 계정과목이 없다`)
  }
})

test('상대 계정과목으로 자금 계정이 오면 안 된다', () => {
  // 거래는 이미 계좌로 한쪽 다리를 갖는다. 상대까지 예금·현금이면 '보통예금 / 보통예금' 이 되어
  // 매출도 비용도 장부에 안 잡힌다(fowin 실데이터 결함 15건이 전부 이 유형이었다)
  for (const [id, code] of Object.entries(CATEGORY_ACCOUNT)) {
    assert.ok(!isFundAccount(code), `${id} 가 자금 계정 ${code} 에 연결돼 있다`)
  }
  assert.equal(isFundAccount('1101'), true)
  assert.equal(isFundAccount('5219'), false)
})
