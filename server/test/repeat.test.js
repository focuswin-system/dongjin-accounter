/**
 * 반복거래 규칙 — 그 달에 뜨는가, 날짜·금액이 맞는가.
 *
 * 여기가 틀리면 조용히 아프다. 안 뜨면 그 달 매출을 빠뜨리고, 엉뚱한 달에 뜨면 두 번 청구한다.
 * (옛 정기 규칙이 둘 다 겪었다 — 그 사고들의 모양을 그대로 테스트로 남긴다.)
 */
const { test } = require('node:test')
const assert = require('node:assert')
const { daysInMonth, addDays, fmtDate, cashDateOf } = require('../lib/payTerm')
const {
  occursInMonth, dateInMonth, contractAllows, amountsOf, itemText, normalizeTemplate,
  dueTotalBetween, monthlyEquivalent,
} = require('../lib/repeat')

// ── 달력 ──

test('daysInMonth — 윤년 2월을 구분한다', () => {
  assert.strictEqual(daysInMonth(2024, 1), 29)
  assert.strictEqual(daysInMonth(2026, 1), 28)
  assert.strictEqual(daysInMonth(2026, 3), 30)
})

test('addDays — 달·해를 넘어간다', () => {
  assert.strictEqual(addDays('2026-01-31', 1), '2026-02-01')
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01')
  assert.strictEqual(addDays('2024-03-01', -1), '2024-02-29')
})

test('fmtDate — UTC 변환을 타지 않는다(KST 경계)', () => {
  assert.strictEqual(fmtDate(new Date(2026, 6, 29, 0, 30)), '2026-07-29')
})

test('결제조건 — 청구일 → 돈이 오가는 날', () => {
  assert.strictEqual(cashDateOf('2026-08-05', 'immediate'), '2026-08-05')
  assert.strictEqual(cashDateOf('2026-08-05', 'net30'), '2026-09-04')
  assert.strictEqual(cashDateOf('2026-08-05', 'nm_day', 10), '2026-09-10')
  assert.strictEqual(cashDateOf('2026-12-05', 'nm_eom'), '2027-01-31')
  assert.strictEqual(cashDateOf('2026-01-05', 'dom', 31), '2026-01-31')
  assert.strictEqual(cashDateOf('2026-02-05', 'eom'), '2026-02-28')
  assert.strictEqual(cashDateOf('2026-02-05', 'bogus'), '2026-03-07', '모르는 조건은 net30')
})

// ── 그 달에 뜨는가 ──

test('매월은 늘 뜬다', () => {
  for (const ym of ['2026-01', '2026-07', '2027-12']) assert.ok(occursInMonth({ period: 'monthly', anchor_month: 5 }, ym))
})

test('분기 — 기준 달부터 3개월마다(해 넘김 포함)', () => {
  const q = { period: 'quarterly', anchor_month: 1 }   // fowin '그룹웨어 및 웹서버 유지보수'
  assert.deepStrictEqual(['2026-01', '2026-02', '2026-04', '2026-07', '2026-10', '2027-01']
    .map(ym => occursInMonth(q, ym)), [true, false, true, true, true, true])
  const q2 = { period: 'quarterly', anchor_month: 11 }
  assert.ok(occursInMonth(q2, '2027-02'))
  assert.ok(!occursInMonth(q2, '2027-03'))
})

test('격월·매년', () => {
  assert.ok(occursInMonth({ period: 'bimonthly', anchor_month: 2 }, '2026-12'))
  assert.ok(!occursInMonth({ period: 'bimonthly', anchor_month: 2 }, '2027-01'))
  assert.ok(occursInMonth({ period: 'yearly', anchor_month: 1 }, '2027-01'))
  assert.ok(!occursInMonth({ period: 'yearly', anchor_month: 1 }, '2026-09'))
})

test('날짜 — 말일 clamp, 일자 0 은 만들 때 고른다', () => {
  assert.strictEqual(dateInMonth({ day_of_month: 31 }, '2026-02'), '2026-02-28')
  assert.strictEqual(dateInMonth({ day_of_month: 31 }, '2024-02'), '2024-02-29')
  assert.strictEqual(dateInMonth({ day_of_month: 10 }, '2026-09'), '2026-09-10')
  assert.strictEqual(dateInMonth({ day_of_month: 0 }, '2026-09'), null)
})

// ── 계약에 붙은 반복거래는 계약이 살아 있을 때만 ──

const live = { contract_id: 'c1', c_status: '진행중', c_start: '2026-03-15', c_end: '2026-12-31' }

test('계약 없음이면 늘 통과', () => {
  assert.ok(contractAllows({}, '2026-09', '2026-09-10'))
})

test('계약 기간 안에서만 — 시작 전·끝난 뒤는 안 뜬다', () => {
  assert.ok(contractAllows(live, '2026-09', '2026-09-10'))
  assert.ok(!contractAllows(live, '2026-03', '2026-03-10'), '시작일 전 날짜')
  assert.ok(contractAllows(live, '2026-03', '2026-03-20'))
  assert.ok(!contractAllows(live, '2027-01', '2027-01-10'), '종료일 뒤')
})

test('계약이 완료·보류면 안 뜬다 — 갱신·종료 때 반복거래를 고치지 않는 이유', () => {
  assert.ok(!contractAllows({ ...live, c_status: '완료' }, '2026-09', '2026-09-10'))
  // 청구 방식은 안 본다 — 옛 정기지출은 총액형 발주에도 붙어 돌았다(옮기면서 사라지면 안 된다)
  assert.ok(contractAllows({ ...live, c_billing_mode: 'onetime' }, '2026-09', '2026-09-10'))
  assert.ok(!contractAllows({ contract_id: 'gone' }, '2026-09', '2026-09-10'), '지워진 계약')
})

test('일자 0 이면 그 달이 계약 기간과 겹치는지로 본다', () => {
  assert.ok(contractAllows(live, '2026-03', null), '3/15 시작 — 3월은 겹친다')
  assert.ok(!contractAllows(live, '2026-02', null))
  assert.ok(!contractAllows(live, '2027-01', null))
  assert.ok(contractAllows({ ...live, c_end: null }, '2030-05', null), '무기한')
})

// ── 금액 ──

test('부가세 방식 — 별도·포함·면세·영세', () => {
  assert.deepStrictEqual(amountsOf('exclusive', 90000), { supply: 90000, vat: 9000, total: 99000, taxType: '과세' })
  assert.deepStrictEqual(amountsOf('inclusive', 433840), { supply: 394400, vat: 39440, total: 433840, taxType: '과세' })
  assert.deepStrictEqual(amountsOf('none', 50000), { supply: 50000, vat: 0, total: 50000, taxType: '면세' })
  assert.deepStrictEqual(amountsOf('zero', 50000), { supply: 50000, vat: 0, total: 50000, taxType: '영세' })
})

test('{월} 은 그 달 숫자로', () => {
  assert.strictEqual(itemText({ item: '{월}월 임차료' }, '2026-09'), '9월 임차료')
  assert.strictEqual(itemText({ item: '유지보수' }, '2026-09'), '유지보수')
})

test('월 환산 — 분기 ÷3, 매년 ÷12', () => {
  assert.strictEqual(monthlyEquivalent({ amount: 430000, vat_mode: 'exclusive', period: 'quarterly' }), 157667)
  assert.strictEqual(monthlyEquivalent({ amount: 120000, vat_mode: 'none', period: 'yearly' }), 10000)
})

test('도래액 — 청구를 안 한 달도 센다(계약 이행률 분모)', () => {
  const t = { amount: 100000, vat_mode: 'exclusive', period: 'monthly', day_of_month: 10 }
  assert.strictEqual(dueTotalBetween(t, '2026-07-01', '2026-09-15'), 330000)
  assert.strictEqual(dueTotalBetween(t, '2026-07-11', '2026-09-09'), 110000, '7/10 은 시작 전, 9/10 은 오늘 뒤')
})

// ── 등록 검사 ──

const base = { direction: 'out', creates: 'txn', item: '임차료', category: '임차료', amount: '433,840', account_id: 'a1' }

test('출금은 비목이 필요하다 — 전표의 비용 줄이 비면 일계표가 안 맞는다', () => {
  assert.deepStrictEqual(normalizeTemplate({ ...base, category: '' }), { error: '비목을 골라주세요', field: 'category' })
})

test('바로 출금은 계좌가 필요하다 — 매달 만들 때 막히면 반복거래를 버린다', () => {
  assert.strictEqual(normalizeTemplate({ ...base, account_id: '' }).field, 'account_id')
  assert.strictEqual(normalizeTemplate({ ...base, creates: 'invoice', account_id: '' }).value.creates, 'invoice')
})

test('입금은 늘 청구서 — txn 을 보내도 청구서', () => {
  const r = normalizeTemplate({ ...base, direction: 'in', creates: 'txn', category: '' })
  assert.strictEqual(r.value.creates, 'invoice')
})

test('값 정리 — 금액 콤마, 모르는 주기·부가세는 기본값, 일자 범위', () => {
  const v = normalizeTemplate({ ...base, period: 'weekly', vat_mode: '?', day_of_month: 45, anchor_month: 0 }).value
  assert.deepStrictEqual([v.amount, v.period, v.vat_mode, v.day_of_month, v.anchor_month, v.pay_term],
    [433840, 'monthly', 'exclusive', 31, 1, 'immediate'])
  assert.strictEqual(normalizeTemplate({ ...base, day_of_month: 0 }).value.day_of_month, 0)
  assert.strictEqual(normalizeTemplate({ ...base, amount: 0 }).field, 'amount')
  assert.strictEqual(normalizeTemplate({ ...base, direction: 'x' }).field, 'direction')
})
