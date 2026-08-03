/**
 * 계좌별 자금 예측 — projectByAccount.
 *
 * 이 계산이 틀리면 "어느 통장이 부족한지"를 잘못 알려준다. 경영자가 그걸 보고
 * 이체를 결정하므로 조용히 틀리면 실제로 돈이 안 나가는 사고로 이어진다.
 *
 * 특히 지키려는 것:
 *   · 계좌를 안 정한 흐름을 아무 통장에나 얹지 않는다(그 통장이 넉넉해 보이면 안 된다)
 *   · 전체 합계는 넉넉해도 개별 통장은 마이너스일 수 있다 — 그 상태를 잡아낸다
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { projectByAccount } = require('../lib/cashReport')

const RANGE = { from: '2026-08-03', to: '2026-09-02' }
const ACCOUNTS = [
  { id: 'main', name: '주거래', kind: 'bank', type: '보통예금', balance: 100_000_000 },
  { id: 'pay',  name: '급여계좌', kind: 'bank', type: '보통예금', balance: 3_000_000 },
]

test('흐름이 없으면 최저 잔액은 현재 잔액이다', () => {
  const r = projectByAccount(ACCOUNTS, [], RANGE)
  const main = r.accounts.find(a => a.id === 'main')
  assert.equal(main.lowest.balance, 100_000_000)
  assert.equal(main.lowest.date, RANGE.from)
})

test('통장별로 따로 접는다 — 합계가 넉넉해도 한쪽은 마이너스일 수 있다', () => {
  const flows = [
    { date: '2026-08-25', kind: 'out', amount: 15_000_000, account_id: 'pay', label: '급여' },
  ]
  const r = projectByAccount(ACCOUNTS, flows, RANGE)
  const pay = r.accounts.find(a => a.id === 'pay')
  const main = r.accounts.find(a => a.id === 'main')
  // 합계는 100,000,000 + 3,000,000 - 15,000,000 = 8,800만으로 넉넉하지만
  assert.equal(pay.lowest.balance, -12_000_000, '급여계좌는 1,200만 부족해야 한다')
  assert.equal(pay.lowest.date, '2026-08-25')
  assert.equal(main.lowest.balance, 100_000_000, '주거래는 영향이 없어야 한다')
})

test('계좌를 안 정한 흐름은 어느 통장에도 얹지 않는다', () => {
  const flows = [
    { date: '2026-08-10', kind: 'in', amount: 50_000_000, account_id: null, label: '미수금' },
  ]
  const r = projectByAccount(ACCOUNTS, flows, RANGE)
  for (const a of r.accounts) {
    assert.equal(a.in, 0, `${a.name}에 미지정 수금이 얹히면 안 된다`)
    assert.equal(a.lowest.balance, a.balance)
  }
  assert.equal(r.unassigned.in, 50_000_000)
  assert.equal(r.unassigned.items.length, 1)
})

test('없는 계좌를 가리키는 흐름도 미지정으로 간다(카드 등 제외된 계좌)', () => {
  const flows = [
    { date: '2026-08-10', kind: 'out', amount: 1_000_000, account_id: 'card-xxx', label: '카드대금' },
  ]
  const r = projectByAccount(ACCOUNTS, flows, RANGE)
  assert.equal(r.unassigned.out, 1_000_000)
  for (const a of r.accounts) assert.equal(a.out, 0)
})

test('최저 시점은 중간에 잡힌다 — 나갔다가 들어오면 그 사이가 바닥이다', () => {
  const flows = [
    { date: '2026-08-05', kind: 'out', amount: 2_500_000, account_id: 'pay' },
    { date: '2026-08-20', kind: 'in',  amount: 9_000_000, account_id: 'pay' },
  ]
  const r = projectByAccount(ACCOUNTS, flows, RANGE)
  const pay = r.accounts.find(a => a.id === 'pay')
  assert.equal(pay.lowest.balance, 500_000, '8/5 직후가 바닥')
  assert.equal(pay.lowest.date, '2026-08-05')
  assert.equal(pay.endBalance, 9_500_000, '기간 끝에는 회복한다')
})
