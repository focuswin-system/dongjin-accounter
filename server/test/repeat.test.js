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
  assert.strictEqual(normalizeTemplate({ ...base, creates: 'invoice', vendor_id: 'v1', account_id: '' }).value.creates, 'invoice')
})

test('입금은 늘 청구서 — txn 을 보내도 청구서', () => {
  const r = normalizeTemplate({ ...base, direction: 'in', creates: 'txn', category: '', vendor_id: 'v1' })
  assert.strictEqual(r.value.creates, 'invoice')
})

/* 거래처 없는 청구서가 매달 서면 미수금·대사에서 '—' 로 남고, findLookalikes 가 거래처 없이는
   후보를 못 찾아 중복 방지까지 꺼진다. 바로 출금(공과금)은 거래처 없이도 된다. */
test('청구서를 만드는 반복거래는 거래처가 필요하다', () => {
  assert.deepStrictEqual(normalizeTemplate({ ...base, direction: 'in', vendor_id: '' }),
    { error: '거래처를 골라주세요', field: 'vendor_id' })
  assert.deepStrictEqual(normalizeTemplate({ ...base, creates: 'invoice', vendor_id: '' }),
    { error: '거래처를 골라주세요', field: 'vendor_id' })
  assert.strictEqual(normalizeTemplate({ ...base, vendor_id: '' }).value.creates, 'txn')
})

test('값 정리 — 금액 콤마, 모르는 주기·부가세는 기본값, 일자 범위', () => {
  const v = normalizeTemplate({ ...base, period: 'weekly', vat_mode: '?', day_of_month: 45, anchor_month: 0 }).value
  assert.deepStrictEqual([v.amount, v.period, v.vat_mode, v.day_of_month, v.anchor_month, v.pay_term],
    [433840, 'monthly', 'exclusive', 31, 1, 'immediate'])
  assert.strictEqual(normalizeTemplate({ ...base, day_of_month: 0 }).value.day_of_month, 0)
  assert.strictEqual(normalizeTemplate({ ...base, amount: 0 }).field, 'amount')
  assert.strictEqual(normalizeTemplate({ ...base, direction: 'x' }).field, 'direction')
})

/* ── 반복 제안(repeatSuggestion) — DB 는 SQL 모양으로 흉내 낸다 ── */
const { repeatSuggestion } = require('../lib/repeat')
const fakeDb = ({ templates = 0, txns = [] }) => ({
  execute: async (sql, params) => {
    if (/FROM repeat_templates/.test(sql)) return [[{ n: templates }]]
    if (/FROM transactions/.test(sql)) {
      const [, , from, to] = params
      return [txns.filter(t => t.d >= from && t.d <= to)
        .map(t => ({ ym: t.d.slice(0, 7), d: t.d, amount: t.amount || 10000, category: t.category || '통신비',
                     account_id: 'acc1', memo: '', tax_type: t.tax_type || '과세' }))
        .sort((a, b) => b.d.localeCompare(a.d))]
    }
    throw new Error('예상 못 한 SQL: ' + sql)
  },
})

test('반복 제안 — 최근 3개월 중 2개월이면 권한다', async () => {
  const db = fakeDb({ txns: [{ d: '2026-07-25' }, { d: '2026-09-27', amount: 132000 }] })
  const r = await repeatSuggestion(db, { kind: 'expense', vendorId: 'v1', category: '통신비', today: '2026-09-28' })
  assert.strictEqual(r.suggest, true)
  assert.strictEqual(r.months, 2)
  // 가장 최근 거래를 본뜬다 — 금액·일자·바로 출금·부가세 포함
  assert.strictEqual(r.prefill.amount, 132000)
  assert.strictEqual(r.prefill.day_of_month, 27)
  assert.strictEqual(r.prefill.creates, 'txn')
  assert.strictEqual(r.prefill.vat_mode, 'inclusive')
})

test('반복 제안 — 한 달뿐이면 안 권한다', async () => {
  const db = fakeDb({ txns: [{ d: '2026-09-05' }, { d: '2026-09-20' }] })
  const r = await repeatSuggestion(db, { kind: 'expense', vendorId: 'v1', category: '통신비', today: '2026-09-28' })
  assert.strictEqual(r.suggest, false)
})

test('반복 제안 — 3개월보다 오래된 건 안 센다(연초 경계 포함)', async () => {
  // 오늘 1월 → 11월·12월·1월이 창이다. 10월 거래는 빠진다
  const db = fakeDb({ txns: [{ d: '2025-10-10' }, { d: '2026-01-10' }] })
  const r = await repeatSuggestion(db, { kind: 'expense', vendorId: 'v1', category: '통신비', today: '2026-01-15' })
  assert.strictEqual(r.suggest, false)
  const db2 = fakeDb({ txns: [{ d: '2025-11-10' }, { d: '2026-01-10' }] })
  const r2 = await repeatSuggestion(db2, { kind: 'expense', vendorId: 'v1', category: '통신비', today: '2026-01-15' })
  assert.strictEqual(r2.suggest, true)
})

test('반복 제안 — 그 거래처·방향 반복거래가 이미 있으면(꺼진 것도) 안 권한다', async () => {
  const db = fakeDb({ templates: 1, txns: [{ d: '2026-08-10' }, { d: '2026-09-10' }] })
  const r = await repeatSuggestion(db, { kind: 'expense', vendorId: 'v1', category: '통신비', today: '2026-09-28' })
  assert.strictEqual(r.suggest, false)
})

test('반복 제안 — 면세 거래는 면세로, 입금은 청구서로 본뜬다', async () => {
  const db = fakeDb({ txns: [{ d: '2026-08-10', tax_type: '면세' }, { d: '2026-09-10', tax_type: '면세' }] })
  const r = await repeatSuggestion(db, { kind: 'income', vendorId: 'v1', today: '2026-09-28' })
  assert.strictEqual(r.suggest, true)
  assert.strictEqual(r.prefill.vat_mode, 'none')
  assert.strictEqual(r.prefill.creates, 'invoice')
  assert.strictEqual(r.prefill.category, null)
})
