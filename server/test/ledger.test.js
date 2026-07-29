/**
 * 장부 불변식 — 거래가 계좌 잔액에 잡히기 위한 조건
 *
 * 이게 틀리면 통장은 줄었는데 화면 잔액은 그대로다. 사용자가 알아챌 방법이 없는
 * 종류의 오류라, 실제로 터졌던 경로들(공백 상태, 계좌 NULL)을 그대로 박아둔다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const {
  SETTLED_EXPENSE, SETTLED_INCOME, normalizeStatus, isSettled, ledgerError,
} = require('../lib/ledger')

test('normalizeStatus — 공백형을 표준형으로 바꾼다', () => {
  // '지급 완료'(공백)는 잔액 집계에서 조용히 누락된다. 저장 전에 반드시 표준형이어야 한다.
  assert.strictEqual(normalizeStatus('지급 완료'), SETTLED_EXPENSE)
  assert.strictEqual(normalizeStatus('지급완료'), SETTLED_EXPENSE)
  assert.strictEqual(normalizeStatus('입금 완료'), SETTLED_INCOME)
  assert.strictEqual(normalizeStatus('  지급 완료  '), SETTLED_EXPENSE, '앞뒤 공백도 제거')
})

test('normalizeStatus — 완료가 아닌 상태는 그대로 둔다', () => {
  assert.strictEqual(normalizeStatus('지급 대기'), '지급 대기')
  assert.strictEqual(normalizeStatus('입금 예정'), '입금 예정')
})

test('normalizeStatus — null·undefined·빈 값은 빈 문자열', () => {
  // 과거 F-02: 급여·용역 지급이 status 공백으로 저장돼 잔액에 반영되지 않았다.
  assert.strictEqual(normalizeStatus(null), '')
  assert.strictEqual(normalizeStatus(undefined), '')
  assert.strictEqual(normalizeStatus(''), '')
  assert.strictEqual(normalizeStatus('   '), '')
})

test('isSettled — 실제로 돈이 오간 상태만 참', () => {
  assert.strictEqual(isSettled('지급완료'), true)
  assert.strictEqual(isSettled('지급 완료'), true, '공백형도 같게 판정해야 한다')
  assert.strictEqual(isSettled('입금완료'), true)
  assert.strictEqual(isSettled('지급 대기'), false)
  assert.strictEqual(isSettled(''), false)
  assert.strictEqual(isSettled(null), false)
})

test('ledgerError — 완료 거래에 계좌가 없으면 막는다', () => {
  const expense = ledgerError({ kind: 'expense', account_id: null, status: '지급완료' })
  assert.ok(expense && expense.includes('출금 계좌'), '지출은 출금 계좌를 안내해야 한다')

  const income = ledgerError({ kind: 'income', account_id: null, status: '입금완료' })
  assert.ok(income && income.includes('입금 계좌'), '입금은 입금 계좌를 안내해야 한다')
})

test('ledgerError — 공백형 상태도 놓치지 않는다', () => {
  // 정규화를 거치지 않고 들어와도 검사는 통과시키면 안 된다.
  const err = ledgerError({ kind: 'expense', account_id: null, status: '지급 완료' })
  assert.ok(err, '공백형이라고 검사를 빠져나가면 안 된다')
})

test('ledgerError — 아직 오가지 않은 돈은 계좌가 없어도 된다', () => {
  // 잔액에 잡히지 않는 게 맞으므로 계좌를 강요하지 않는다.
  assert.strictEqual(ledgerError({ kind: 'expense', account_id: null, status: '지급 대기' }), null)
  assert.strictEqual(ledgerError({ kind: 'income', account_id: null, status: '입금 예정' }), null)
})

test('ledgerError — 계좌가 있으면 통과', () => {
  assert.strictEqual(ledgerError({ kind: 'expense', account_id: 'acc-1', status: '지급완료' }), null)
  assert.strictEqual(ledgerError({ kind: 'income', account_id: 'acc-1', status: '입금완료' }), null)
})

test('ledgerError — 빈 문자열 계좌도 없는 것으로 본다', () => {
  // `account_id || null` 로 넘기는 호출부가 여럿이라 '' 가 들어올 수 있다.
  assert.ok(ledgerError({ kind: 'expense', account_id: '', status: '지급완료' }))
})
