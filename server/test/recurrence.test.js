/**
 * 정기 반복일 계산 — 정기청구·정기지출 공용
 *
 * 여기가 틀리면 조용히 아프다. 회차가 안 나오면 그 달 매출이 미청구로 사라지고,
 * 과하게 나오면 없는 청구서가 수백 건 쏟아진다. 둘 다 실제로 있었던 사고라
 * 그 사고들을 그대로 테스트로 박아둔다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const { dueDatesToGenerate, daysInMonth, addDays, fmtDate } = require('../lib/recurrence')

// ── 날짜 헬퍼 ──

test('daysInMonth — 윤년 2월을 구분한다', () => {
  assert.strictEqual(daysInMonth(2024, 1), 29, '2024는 윤년')
  assert.strictEqual(daysInMonth(2026, 1), 28)
  assert.strictEqual(daysInMonth(2026, 3), 30, '4월은 30일')
  assert.strictEqual(daysInMonth(2026, 0), 31)
})

test('addDays — 달·해를 넘어간다', () => {
  assert.strictEqual(addDays('2026-01-31', 1), '2026-02-01')
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01')
  assert.strictEqual(addDays('2026-03-01', -1), '2026-02-28')
  assert.strictEqual(addDays('2024-03-01', -1), '2024-02-29', '윤년')
})

test('fmtDate — UTC 변환을 타지 않는다(KST 경계)', () => {
  // toISOString() 을 쓰면 KST 자정 직후가 전날로 밀린다. 로컬 캘린더 기준이어야 한다.
  assert.strictEqual(fmtDate(new Date(2026, 6, 29, 0, 30)), '2026-07-29')
  assert.strictEqual(fmtDate(new Date(2026, 6, 29, 23, 59)), '2026-07-29')
})

// ── 회차 생성 ──

test('월간 — 앵커일을 유지하며 오늘까지만 만든다', () => {
  const out = dueDatesToGenerate(
    { start_date: '2026-01-10', period: 'monthly', day_of_month: 10 }, '2026-04-15')
  assert.deepStrictEqual(out, ['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10'])
})

test('월말 앵커(31일) — 짧은 달은 clamp 하되 드리프트가 누적되지 않는다', () => {
  // 과거 버그: 오버플로가 누적돼 회차가 며칠씩 밀리고 결국 누락됐다.
  // 각 회차는 원 앵커의 '절대 월'로 재계산되므로 긴 달에서는 다시 31일이어야 한다.
  const out = dueDatesToGenerate(
    { start_date: '2026-01-31', period: 'monthly', day_of_month: 31 }, '2026-05-31')
  assert.deepStrictEqual(out, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'])
})

test('분기·연간 — period 를 무시하지 않는다', () => {
  // 과거 버그: 지출 쪽이 period 를 무시해 분기/연 주문이 매달 생성됐다.
  const q = dueDatesToGenerate(
    { start_date: '2026-01-15', period: 'quarterly', day_of_month: 15 }, '2026-12-31')
  assert.deepStrictEqual(q, ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15'])

  const y = dueDatesToGenerate(
    { start_date: '2024-03-01', period: 'yearly', day_of_month: 1 }, '2026-12-31')
  assert.deepStrictEqual(y, ['2024-03-01', '2025-03-01', '2026-03-01'])
})

test('last_generated 이하 회차는 다시 만들지 않는다', () => {
  const out = dueDatesToGenerate(
    { start_date: '2026-01-10', period: 'monthly', day_of_month: 10, last_generated: '2026-02-10' },
    '2026-04-15')
  assert.deepStrictEqual(out, ['2026-03-10', '2026-04-10'])
})

test('setup_date 이전 회차는 소급하지 않는다', () => {
  // 실제 사고: 2003년 시작 무기한 주문이 등록 즉시 수백 건으로 쏟아졌다.
  // 등록한 날부터만 청구해야 한다.
  const out = dueDatesToGenerate(
    { start_date: '2003-05-01', period: 'monthly', day_of_month: 1, setup_date: '2026-06-15' },
    '2026-08-31')
  assert.deepStrictEqual(out, ['2026-07-01', '2026-08-01'])
})

test('end_date 를 넘으면 중단한다', () => {
  const out = dueDatesToGenerate(
    { start_date: '2026-01-10', period: 'monthly', day_of_month: 10, end_date: '2026-03-31' },
    '2026-12-31')
  assert.deepStrictEqual(out, ['2026-01-10', '2026-02-10', '2026-03-10'])
})

test('horizonDays — 미래 회차 미리보기(기본은 오늘까지만)', () => {
  const rec = { start_date: '2026-01-10', period: 'monthly', day_of_month: 10 }
  const base = dueDatesToGenerate(rec, '2026-03-01')
  assert.deepStrictEqual(base, ['2026-01-10', '2026-02-10'], '기본은 미래를 포함하지 않는다')

  const ahead = dueDatesToGenerate(rec, '2026-03-01', { horizonDays: 35 })
  assert.deepStrictEqual(ahead, ['2026-01-10', '2026-02-10', '2026-03-10'],
    '월간은 다음 회차가 한 번 미리 보여야 한다')
})

test('셀 기준이 아예 없으면(시작일·등록일 둘 다) 빈 배열', () => {
  assert.deepStrictEqual(dueDatesToGenerate({ period: 'monthly' }, '2026-04-15'), [])
  assert.deepStrictEqual(dueDatesToGenerate({ start_date: '' }, '2026-04-15'), [])
  assert.deepStrictEqual(dueDatesToGenerate({ start_date: '엉터리' }, '2026-04-15'), [])
})

test('시작일이 없으면 등록일(setup_date)부터 센다', () => {
  /* 무기한 주문은 "언제부터"가 모호한 경우가 흔하다. 예전엔 시작일이 비면 회차가
     영원히 0건이었고(경고도 없었다) 그 달 매출이 조용히 빠졌다.
     등록일을 앵커로 삼으면 등록한 달부터 정상적으로 청구된다. */
  const out = dueDatesToGenerate(
    { start_date: '', period: 'monthly', day_of_month: 10, setup_date: '2026-06-15' },
    '2026-08-31')
  assert.deepStrictEqual(out, ['2026-07-10', '2026-08-10'],
    '등록일(6/15) 이후 첫 앵커일(7/10)부터 나와야 한다')
})

test('시작일이 없어도 end_date 는 그대로 듣는다 (종료된 주문은 멈춘다)', () => {
  const out = dueDatesToGenerate(
    { start_date: '', period: 'monthly', day_of_month: 1, setup_date: '2026-01-05', end_date: '2026-03-31' },
    '2026-12-31')
  assert.deepStrictEqual(out, ['2026-02-01', '2026-03-01'])
})

test('주문을 닫으며 종료일을 오늘로 맞춰도 과거 미발행 회차는 남는다', () => {
  /* 이 성질이 '상태로 목록에서 잘라내기' 대신 '종료일 채우기'를 고른 이유다.
     주문이 완료돼도 마지막 회차 청구는 남는 게 정상이고(8월 말 종료 → 8월분을 9월에 발행),
     그 회차가 사라지면 못 받은 돈이 조용히 없어진다. */
  const out = dueDatesToGenerate(
    { start_date: '2026-01-01', period: 'monthly', day_of_month: 1,
      setup_date: '2026-01-01', end_date: '2026-08-05' },   // 오늘(8/5)로 닫음
    '2026-08-05')
  assert.deepStrictEqual(out,
    ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01',
     '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'],
    '닫기 전 회차는 그대로 청구할 수 있어야 한다')
  // 반면 미래 회차(9/1)는 더 이상 나오지 않는다
  assert.ok(!out.includes('2026-09-01'))
})

test('시작일이 있으면 등록일이 있어도 시작일이 앵커다', () => {
  // 폴백이 기존 동작을 바꾸지 않는지 — 소급 하한(setup_date)은 그대로 걸린다
  const out = dueDatesToGenerate(
    { start_date: '2026-01-10', period: 'monthly', day_of_month: 10, setup_date: '2026-03-01' },
    '2026-04-30')
  assert.deepStrictEqual(out, ['2026-03-10', '2026-04-10'])
})

test('day_of_month 가 없으면 start_date 의 일자를 앵커로 쓴다', () => {
  const out = dueDatesToGenerate({ start_date: '2026-01-07', period: 'monthly' }, '2026-03-31')
  assert.deepStrictEqual(out, ['2026-01-07', '2026-02-07', '2026-03-07'])
})

test('today 를 문자열로 주든 Date 로 주든 같은 결과', () => {
  const rec = { start_date: '2026-01-10', period: 'monthly', day_of_month: 10 }
  const asStr = dueDatesToGenerate(rec, '2026-03-15')
  const asDate = dueDatesToGenerate(rec, new Date(2026, 2, 15))
  assert.deepStrictEqual(asStr, asDate)
})

test('아직 시작 전이면 아무것도 만들지 않는다', () => {
  const out = dueDatesToGenerate(
    { start_date: '2027-01-01', period: 'monthly', day_of_month: 1 }, '2026-07-29')
  assert.deepStrictEqual(out, [])
})

// ── 회차 상태 분류 (놓침 / 오늘·임박 / 예정) ──
// 화면의 세 구획이 이 값을 그대로 쓴다. 화면에서 다시 계산하면 서버와 어긋난다.

const { cycleState, pendingCycle, SOON_DAYS } = require('../lib/recurrence')

test('cycleState — 지난 회차는 overdue(놓침)', () => {
  assert.strictEqual(cycleState('2026-07-13', '2026-07-30'), 'overdue')
  assert.strictEqual(cycleState('2026-07-29', '2026-07-30'), 'overdue')
})

test('cycleState — 오늘과 7일 안은 soon', () => {
  assert.strictEqual(cycleState('2026-07-30', '2026-07-30'), 'soon', '오늘도 soon')
  assert.strictEqual(cycleState('2026-08-06', '2026-07-30'), 'soon', `+${SOON_DAYS}일 경계 포함`)
})

test('cycleState — 7일 밖은 upcoming', () => {
  assert.strictEqual(cycleState('2026-08-07', '2026-07-30'), 'upcoming')
  assert.strictEqual(cycleState('2026-09-13', '2026-07-30'), 'upcoming')
})

test('pendingCycle — 주문 기반 여부(contract_id)를 빠뜨리지 않는다', () => {
  // 두 라우트가 각자 객체를 만들던 탓에 한쪽에만 필드가 없던 적이 있다.
  // 이 값이 없으면 화면에서 '주문 기반 / 일반'을 가를 수 없다.
  const withContract = pendingCycle(
    { id: 'r1', vendor_id: 'v1', vendor_name: '(주)세이프넷', contract_id: 'c1', period: 'monthly' },
    '2026-08-13', '2026-07-30', { amount: 100000, vat: 10000 })
  assert.strictEqual(withContract.contract_id, 'c1')
  assert.strictEqual(withContract.state, 'upcoming')
  assert.strictEqual(withContract.amount, 100000)

  const plain = pendingCycle({ id: 'r2', period: 'monthly' }, '2026-07-13', '2026-07-30', {})
  assert.strictEqual(plain.contract_id, null, '주문 무관 정기는 null')
  assert.strictEqual(plain.state, 'overdue')
})

test('일괄 등록 대상 — 등록일 이전 회차는 절대 포함되지 않는다', () => {
  // 2020년 시작 주문을 2026-07-26에 등록한 경우.
  // 일괄 등록은 horizon 없이 dueDatesToGenerate(오늘까지)를 쓰므로 이 목록이 곧 대상이다.
  const rec = { start_date: '2020-01-13', day_of_month: 13, period: 'monthly', setup_date: '2026-07-26' }
  const dues = dueDatesToGenerate(rec, '2026-10-05')
  assert.deepStrictEqual(dues, ['2026-08-13', '2026-09-13'],
    '등록일 이후 도래분만 — 2020~2026-07은 소급하지 않는다')
  assert.ok(dues.every(d => d >= '2026-07-26'))
})

test('일괄 등록 대상 — 미래 회차는 포함되지 않는다', () => {
  // 미수/미지급이 조기에 부풀지 않게, 일괄은 오늘까지만 만든다.
  const rec = { start_date: '2026-01-13', day_of_month: 13, period: 'monthly', setup_date: '2026-01-13' }
  const dues = dueDatesToGenerate(rec, '2026-03-01')
  assert.deepStrictEqual(dues, ['2026-01-13', '2026-02-13'])
})

test('청구일을 바꿔도 이미 발행한 달이 되살아나지 않는다', () => {
  // 매월 1일 규칙으로 7월분을 발행한 상태(last_generated=2026-07-01)에서
  // 거래처 요청으로 청구일을 25일로 바꾸면, 예전 구현은 07-25 > 07-01 이라
  // 7월을 '놓친 회차'로 다시 내놨다 → 발행하면 7월분 청구서가 두 장(미수금 2배).
  const base = { start_date: '2026-01-01', period: 'monthly', last_generated: '2026-07-01' }
  const moved = { ...base, day_of_month: 25 }
  const got = dueDatesToGenerate(moved, '2026-07-31')
  assert.deepEqual(got, [], '7월은 이미 발행했으므로 아무것도 안 나와야 한다')
})

test('청구일을 앞당겨도 그 달을 건너뛰지 않는다', () => {
  // 25일 → 1일로 당긴 경우. 예전엔 08-01 이 07-25 보다 커서 통과했지만,
  // 같은 규칙이 반대로 작동하면(당긴 달이 last_generated 보다 작아) 그 달이 통째로 사라졌다.
  const rec = { start_date: '2026-01-25', period: 'monthly', day_of_month: 1, last_generated: '2026-07-25' }
  assert.deepEqual(dueDatesToGenerate(rec, '2026-08-31'), ['2026-08-01'])
})

test('다음 달 회차는 정상적으로 나온다 — 과잉 차단이 아니다', () => {
  const rec = { start_date: '2026-01-01', period: 'monthly', day_of_month: 1, last_generated: '2026-07-01' }
  assert.deepEqual(dueDatesToGenerate(rec, '2026-09-15'), ['2026-08-01', '2026-09-01'])
})

test('분기·연 주기도 달 단위로 판정한다', () => {
  const q = { start_date: '2026-01-10', period: 'quarterly', day_of_month: 10, last_generated: '2026-04-10' }
  // 4월분은 끝났고 7월분만 남는다. 앵커를 20일로 옮겨도 4월이 되살아나지 않아야 한다.
  assert.deepEqual(dueDatesToGenerate({ ...q, day_of_month: 20 }, '2026-07-31'), ['2026-07-20'])
  const y = { start_date: '2026-03-01', period: 'yearly', day_of_month: 1, last_generated: '2026-03-01' }
  assert.deepEqual(dueDatesToGenerate(y, '2026-12-31'), [])
})

// ── 소급 등록 (lib/backfill.js) ────────────────────────────────
const { backfillCycles, tooManyError, MAX_BACKFILL } = require('../lib/backfill')

test('소급 — 등록일 하한을 무시하고 지정한 기간의 회차를 만든다', () => {
  /* 평소엔 등록일(setup_date) 이전이 막히지만, 소급은 사용자가 연 기간이 하한이 된다.
     같은 규칙(주기·앵커일)을 쓰므로 평소 회차와 어긋나지 않는다. */
  const rec = { start_date: '2026-01-01', period: 'monthly', day_of_month: 1, setup_date: '2026-08-05' }
  assert.deepStrictEqual(
    dueDatesToGenerate(rec, '2026-08-05'), [],
    '평소 경로는 등록일(8/5) 이전을 만들지 않는다 — 8/1 앵커는 이미 지났고 9/1은 아직 안 왔다')
  assert.deepStrictEqual(
    backfillCycles(rec, '2026-03-01', '2026-08-05'),
    ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'])
})

test('소급 — 주문 시작일보다 앞선 기간을 열어도 시작일 전은 안 만든다', () => {
  const rec = { start_date: '2026-05-01', period: 'monthly', day_of_month: 1, setup_date: '2026-08-05' }
  assert.deepStrictEqual(
    backfillCycles(rec, '2026-01-01', '2026-08-05'),
    ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'])
})

test('소급 — 종료일을 넘지 않는다', () => {
  const rec = { start_date: '2026-01-01', period: 'monthly', day_of_month: 1, end_date: '2026-04-30', setup_date: '2026-08-05' }
  assert.deepStrictEqual(
    backfillCycles(rec, '2026-01-01', '2026-08-05'),
    ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'])
})

test('소급 — 이미 발행한 회차도 목록에 나온다(중복 판단은 장부로)', () => {
  /* last_generated 하한을 그대로 쓰면 중간에 지운 회차를 영영 못 되살린다.
     그래서 소급 계산은 하한을 비우고, '이미 있음'은 실제 청구서 조회로 판단한다. */
  const rec = { start_date: '2026-01-01', period: 'monthly', day_of_month: 1,
    setup_date: '2026-08-05', last_generated: '2026-06-01' }
  assert.deepStrictEqual(
    backfillCycles(rec, '2026-05-01', '2026-07-31'),
    ['2026-05-01', '2026-06-01', '2026-07-01'])
})

test('소급 — 상한을 넘으면 잘라내지 않고 거절한다', () => {
  assert.strictEqual(tooManyError(MAX_BACKFILL), null)
  const msg = tooManyError(MAX_BACKFILL + 1)
  assert.ok(msg && msg.includes(String(MAX_BACKFILL + 1)), '몇 개가 나왔는지 알려줘야 범위를 좁힐 수 있다')
})
