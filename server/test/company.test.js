const test = require('node:test')
const assert = require('node:assert')
const { parseOwnBizNo, sameBizNo } = require('../lib/bizNo')
const { fiscalOfYear, fiscalOfDate, parseFiscal } = require('../lib/fiscal')
const { planCompanyChange } = require('../lib/companyChange')

/* 우리 사업자번호 — 오타 한 자리가 인쇄물과 세금계산서 매출·매입 판정을 통째로 틀리게 한다. */

test('사업자번호 10자리 — 검증 숫자가 맞으면 하이픈 표기로', () => {
  // 운영 중인 실제 번호들(검증 숫자가 맞는다)
  assert.deepStrictEqual(parseOwnBizNo('6088150389'), { ok: true, value: '608-81-50389' })
  assert.deepStrictEqual(parseOwnBizNo('603-81-44150'), { ok: true, value: '603-81-44150' })
  assert.deepStrictEqual(parseOwnBizNo(' 609 86 10935 '), { ok: true, value: '609-86-10935' })
})

test('사업자번호 10자리 — 한 자리 오타는 막는다', () => {
  assert.strictEqual(parseOwnBizNo('608-81-50388').ok, false)
  assert.strictEqual(parseOwnBizNo('123-45-67890').ok, false)
})

test('개인 용도 6자리 — 월·일 범위만 본다', () => {
  assert.deepStrictEqual(parseOwnBizNo('991231'), { ok: true, value: '991231' })
  assert.strictEqual(parseOwnBizNo('991331').ok, false)   // 13월
  assert.strictEqual(parseOwnBizNo('990100').ok, false)   // 0일
})

test('그 밖의 길이는 막는다', () => {
  for (const v of ['', null, '12345', '1234567', '12345678901']) {
    assert.strictEqual(parseOwnBizNo(v).ok, false, String(v))
  }
})

test('같은 번호 판정은 하이픈을 무시한다', () => {
  assert.strictEqual(sameBizNo('608-81-50389', '6088150389'), true)
  assert.strictEqual(sameBizNo('608-81-50389', '608-81-50388'), false)
})

/* 회기 — 해 넘김·결산월 경계에서 한 날짜가 두 회기에 들거나 어디에도 안 들면 안 된다. */

const dec = { fiscal_end_month: 12, fiscal_base_year: 2026, fiscal_base_seq: 5 }
const mar = { fiscal_end_month: 3, fiscal_base_year: 2026, fiscal_base_seq: 5 }

test('12월 결산 — 달력연도, 이름은 2026년', () => {
  assert.deepStrictEqual(fiscalOfYear(dec, 2026),
    { year: 2026, seq: 5, name: '2026년', start: '2026-01-01', end: '2026-12-31' })
  assert.strictEqual(fiscalOfYear(dec, 2028).seq, 7)
})

test('3월 결산 — 시작하는 해 기준, 이름은 26-27년', () => {
  assert.deepStrictEqual(fiscalOfYear(mar, 2026),
    { year: 2026, seq: 5, name: '26-27년', start: '2026-04-01', end: '2027-03-31' })
})

test('3월 결산 경계 — 3/31 은 앞 회기, 4/1 은 다음 회기', () => {
  assert.strictEqual(fiscalOfDate(mar, '2027-03-31').year, 2026)
  assert.strictEqual(fiscalOfDate(mar, '2027-04-01').year, 2027)
  assert.strictEqual(fiscalOfDate(mar, '2027-04-01').seq, 6)
  assert.strictEqual(fiscalOfDate(mar, '2026-01-15').year, 2025)
  assert.strictEqual(fiscalOfDate(mar, '2026-01-15').seq, 4)
})

test('2월 결산 — 윤년 말일', () => {
  const feb = { fiscal_end_month: 2 }
  assert.strictEqual(fiscalOfYear(feb, 2027).end, '2028-02-29')
  assert.strictEqual(fiscalOfYear(feb, 2026).end, '2027-02-28')
  assert.strictEqual(fiscalOfYear(feb, 2026).start, '2026-03-01')
})

test('11월 결산 — 12월은 새 회기의 시작', () => {
  const nov = { fiscal_end_month: 11, fiscal_base_year: 2026, fiscal_base_seq: 1 }
  assert.strictEqual(fiscalOfDate(nov, '2026-12-01').year, 2026)
  assert.strictEqual(fiscalOfDate(nov, '2026-11-30').year, 2025)
  assert.strictEqual(fiscalOfYear(nov, 2026).name, '26-27년')
  assert.strictEqual(fiscalOfYear(nov, 2026).end, '2027-11-30')
})

test('기수 없으면 seq null, 회사가 생기기 전이면 null', () => {
  assert.strictEqual(fiscalOfYear({ fiscal_end_month: 12 }, 2026).seq, null)
  assert.strictEqual(fiscalOfYear({ ...dec, fiscal_base_seq: 1 }, 2025).seq, null)
  assert.strictEqual(fiscalOfYear({ fiscal_end_month: 0 }, 2026), null)
  assert.strictEqual(fiscalOfDate(dec, '2026/01/01'), null)
})

test('입력 검사 — 연도·기수는 둘 다 있거나 둘 다 없어야', () => {
  assert.deepStrictEqual(parseFiscal({ fiscal_end_month: '12', fiscal_base_year: '', fiscal_base_seq: null }),
    { ok: true, value: { fiscal_end_month: 12, fiscal_base_year: null, fiscal_base_seq: null } })
  assert.deepStrictEqual(parseFiscal({ fiscal_end_month: 3, fiscal_base_year: '2026', fiscal_base_seq: '5' }),
    { ok: true, value: { fiscal_end_month: 3, fiscal_base_year: 2026, fiscal_base_seq: 5 } })
  assert.strictEqual(parseFiscal({ fiscal_end_month: 3, fiscal_base_year: 2026 }).ok, false)
  assert.strictEqual(parseFiscal({ fiscal_end_month: 13 }).ok, false)
  assert.strictEqual(parseFiscal({ fiscal_end_month: 12, fiscal_base_year: 2026, fiscal_base_seq: 0 }).ok, false)
  assert.strictEqual(parseFiscal({ fiscal_end_month: 12, fiscal_base_year: 2026, fiscal_base_seq: 2.5 }).ok, false)
})

/* 회사 정보 변경 계획 — 보낸 칸만, 사업자번호는 바꿀 수 있되 비울 수 없다. */

const TODAY = '2026-09-15'
const fresh = { id: 'main', name: '새회사', biz_no: '', fiscal_end_month: 12 }
const live = { id: 'main', name: '(주)포커스윈', biz_no: '608-81-50389', phone: '055-1', main_in_account_id: 'acc1',
  closing_day: 25, fiscal_end_month: 12, fiscal_base_year: null, fiscal_base_seq: null }
const plan = (cur, body) => planCompanyChange(cur, body, TODAY)

test('첫 설정 — 상호·사업자번호만 있으면 된다(기수는 선택)', () => {
  const r = plan(fresh, { biz_no: '6088150389' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.set.biz_no, '608-81-50389')
  assert.strictEqual(plan(fresh, { phone: '1' }).field, 'biz_no')
})

test('사업자번호 — 바꿀 수 있고(형식 검사), 비울 수 없고, 같은 번호면 표기를 안 건드린다', () => {
  assert.strictEqual(plan(live, { biz_no: '6038144150' }).set.biz_no, '603-81-44150')
  const bad = plan(live, { biz_no: '603-81-44151' })
  assert.deepStrictEqual([bad.status, bad.field], [400, 'biz_no'])
  assert.strictEqual('biz_no' in plan(live, { biz_no: '6088150389' }).set, false)
  assert.strictEqual(plan(live, { biz_no: '' }).field, 'biz_no')   // 지우고 저장하면 조용히 남기지 않고 막는다
  assert.strictEqual(plan(fresh, { biz_no: '' }).field, 'biz_no')
})

test('보낸 칸만 바꾼다 — 안 보낸 주거래 계좌·마감일은 set 에 없다', () => {
  const r = plan(live, { phone: '055-2' })
  assert.deepStrictEqual(r.set, { phone: '055-2' })
  assert.strictEqual(r.after.main_in_account_id, 'acc1')
  assert.strictEqual(r.after.closing_day, 25)
})

test('기수는 올해 회기의 기수 — 기준 연도는 오늘이 속한 회계연도로 저장', () => {
  assert.deepStrictEqual(plan(live, { fiscal_end_month: 12, fiscal_base_seq: 5 }).set,
    { fiscal_end_month: 12, fiscal_base_year: 2026, fiscal_base_seq: 5 })
  // 3월 결산이면 2026-09-15 는 2026.04 에 시작한 회기
  assert.strictEqual(plan(live, { fiscal_end_month: 3, fiscal_base_seq: 5 }).set.fiscal_base_year, 2026)
  // 기수 비우기 — 기준도 같이 비운다
  assert.deepStrictEqual(plan(live, { fiscal_end_month: 3, fiscal_base_seq: '' }).set,
    { fiscal_end_month: 3, fiscal_base_year: null, fiscal_base_seq: null })
  assert.strictEqual(plan(live, { fiscal_base_seq: 0 }).field, 'fiscal_base_seq')
})

test('결산월만 바꾸면 올해 기수는 그대로 두고 기준을 다시 잡는다', () => {
  // 2025 기준 6기(12월 결산) → 2026 은 7기. 결산월을 3월로 바꿔도 올해 기수 7 을 유지.
  const cur = { ...live, fiscal_end_month: 12, fiscal_base_year: 2025, fiscal_base_seq: 6 }
  assert.deepStrictEqual(plan(cur, { fiscal_end_month: 3 }).set,
    { fiscal_end_month: 3, fiscal_base_year: 2026, fiscal_base_seq: 7 })
})

test('상호는 비울 수 없고, 종사업장번호는 4자리', () => {
  assert.strictEqual(plan(live, { name: '  ' }).field, 'name')
  assert.strictEqual(plan(live, { sub_biz_no: '12' }).ok, false)
  assert.strictEqual(plan(live, { sub_biz_no: '0001' }).set.sub_biz_no, '0001')
  assert.strictEqual(plan(live, { sub_biz_no: '' }).set.sub_biz_no, null)
})

test('허용 목록 밖의 칸은 무시한다 — 본문 키가 SQL 칸 이름이 되지 않는다', () => {
  const r = plan(live, { 'id = id; DROP': 1, updated_at: 'x', foo: '010', phone: '1' })
  assert.deepStrictEqual(Object.keys(r.set), ['phone'])
})

test('길이 한도는 DB 칸 크기 — 넘으면 500 이 아니라 400(칸 이름과 함께)', () => {
  const r = plan(live, { fax: '0'.repeat(51) })
  assert.deepStrictEqual([r.status, r.field], [400, 'fax'])
  assert.strictEqual(plan(live, { phone: '0'.repeat(50) }).ok, true)
})

test('회기가 지금과 같으면 기준을 다시 잡지 않는다 — 저장할 때마다 기준이 흔들리지 않게', () => {
  const cur = { ...live, fiscal_end_month: 12, fiscal_base_year: 2024, fiscal_base_seq: 3 }   // 2026 은 5기
  const r = plan(cur, { fiscal_end_month: 12, fiscal_base_seq: 5, phone: '1' })
  assert.deepStrictEqual(r.set, { phone: '1' })
  assert.strictEqual(plan(cur, { fiscal_end_month: 13 }).field, 'fiscal_end_month')
})

test('장부 시작일 — 날짜만, 오늘까지, 비우면 풀린다(4단계)', () => {
  assert.strictEqual(plan(live, { books_start: '2026-09-01' }).set.books_start, '2026-09-01')
  assert.strictEqual(plan(live, { books_start: '' }).set.books_start, null)
  const bad = plan(live, { books_start: '2026.9.1' })
  assert.strictEqual(bad.ok, false)
  assert.strictEqual(bad.field, 'books_start')
  const future = plan(live, { books_start: '2026-09-16' })   // TODAY 다음 날 — 오늘 거래까지 막히게 된다
  assert.strictEqual(future.ok, false)
  assert.strictEqual(future.field, 'books_start')
  assert.strictEqual('books_start' in plan(live, { phone: '2' }).set, false)   // 안 보내면 안 건드린다
})
