/**
 * 차입금 현황 집계 — 화면과 엑셀이 함께 쓰는 산식.
 *
 * 여기서 잠그는 것 두 가지:
 *   1. 잔액에 **예정 회차를 섞지 않는다.** loan_repayments 에는 아직 안 갚은 회차도 함께 산다.
 *      전부 더하면 한 푼도 안 갚았는데 다 갚은 것으로 나온다.
 *   2. 이자를 **남은 원금에 더하지 않는다.** 갚아야 할 빚은 원금이고 이자는 이미 나간 비용이다.
 */
const test = require('node:test')
const assert = require('node:assert')

const { loanReport, METHOD_LABEL } = require('../lib/loanReport')

/** loans / loan_repayments / loan_draws 세 질의에 차례로 답하는 가짜 테넌트 연결. */
function fakeDb({ loans = [], repayments = [], draws = [] } = {}) {
  return {
    async execute(sql) {
      if (/FROM loans/.test(sql)) return [loans]
      if (/FROM loan_repayments/.test(sql)) return [repayments]
      if (/FROM loan_draws/.test(sql)) return [draws]
      throw new Error('예상 못 한 질의: ' + sql)
    },
  }
}

const LOAN = {
  id: 'L1', name: '경남은행 1억', lender: '경남은행', principal: 100_000_000,
  annual_rate: 0, method: 'none', term_months: 12, start_date: '2026-01-01',
  end_date: null, account_name: '경남은행 계좌1', status: 'active', vendor_name: null,
}

test('예정 회차는 상환으로 세지 않는다', async () => {
  const d = await loanReport(fakeDb({
    loans: [LOAN],
    repayments: [
      { loan_id: 'L1', seq: 1, due_date: '2026-02-01', paid_date: '2026-02-01', principal: 1_000_000, interest: 300_000 },
      { loan_id: 'L1', seq: 2, due_date: '2026-03-01', paid_date: null, principal: 1_000_000, interest: 290_000 },
    ],
  }))
  const l = d.loans[0]
  assert.equal(l.repaidPrincipal, 1_000_000, '갚은 회차만 센다')
  assert.equal(l.remaining, 99_000_000)
  assert.equal(l.paidCount, 1)
  assert.equal(l.cycleCount, 2)
  assert.equal(d.repayments.length, 1, '상환 내역에도 갚은 회차만 담는다')
})

test('이자는 남은 원금에 더하지 않는다', async () => {
  const d = await loanReport(fakeDb({
    loans: [LOAN],
    repayments: [
      { loan_id: 'L1', seq: 1, due_date: '2026-02-01', paid_date: '2026-02-01', principal: 0, interest: 350_000 },
    ],
  }))
  // 이자만 낸 회차 — 원금은 한 푼도 안 줄어야 한다
  assert.equal(d.totals.remaining, 100_000_000)
  assert.equal(d.totals.repaidInterest, 350_000)
  assert.equal(d.totals.repaidPrincipal, 0)
})

test('추가 인출이 있으면 최초 실행액을 되짚는다', async () => {
  const d = await loanReport(fakeDb({
    loans: [{ ...LOAN, principal: 130_000_000 }],
    draws: [{ loan_id: 'L1', draw_date: '2026-03-01', amount: 30_000_000 }],
  }))
  assert.equal(d.loans[0].principal, 130_000_000, '누적 차입액')
  assert.equal(d.loans[0].initialPrincipal, 100_000_000, '최초 실행액')
})

test('차입처별로 묶고 잔액 큰 순으로 세운다', async () => {
  const d = await loanReport(fakeDb({
    loans: [
      { ...LOAN, id: 'A', lender: '경남은행', principal: 10_000_000 },
      { ...LOAN, id: 'B', lender: '기업은행', principal: 50_000_000 },
      { ...LOAN, id: 'C', lender: '경남은행', principal: 30_000_000 },
    ],
  }))
  assert.deepEqual(d.byLender.map(g => g.lender), ['기업은행', '경남은행'])
  const knb = d.byLender.find(g => g.lender === '경남은행')
  assert.equal(knb.count, 2)
  assert.equal(knb.principal, 40_000_000)
  assert.equal(d.totals.principal, 90_000_000)
})

test('차입처가 비면 거래처명, 그것도 없으면 미지정', async () => {
  const d = await loanReport(fakeDb({
    loans: [
      { ...LOAN, id: 'A', lender: '', vendor_name: '중소기업중앙회' },
      { ...LOAN, id: 'B', lender: null, vendor_name: null },
      { ...LOAN, id: 'C', lender: '   ', vendor_name: null },
    ],
  }))
  const names = d.byLender.map(g => g.lender).sort()
  assert.ok(names.includes('중소기업중앙회'))
  assert.ok(names.includes('미지정'))
  assert.ok(!names.includes(''), '빈 이름으로 묶인 행이 생기면 안 된다')
})

test('차입금이 없으면 빈 결과 — 질의를 더 하지 않는다', async () => {
  const d = await loanReport(fakeDb({ loans: [] }))
  assert.deepEqual(d.loans, [])
  assert.deepEqual(d.byLender, [])
  assert.equal(d.totals.principal, 0)
  assert.equal(d.totals.count, 0)
})

test('상환 내역은 납부일 순', async () => {
  const d = await loanReport(fakeDb({
    loans: [LOAN],
    repayments: [
      { loan_id: 'L1', seq: 2, due_date: '2026-03-01', paid_date: '2026-03-05', principal: 1, interest: 0 },
      { loan_id: 'L1', seq: 1, due_date: '2026-02-01', paid_date: '2026-02-03', principal: 1, interest: 0 },
    ],
  }))
  assert.deepEqual(d.repayments.map(r => r.paidDate), ['2026-02-03', '2026-03-05'])
})

test('상환방식 이름이 네 가지 모두 있다', () => {
  // 화면(Docs.jsx LOAN_METHOD_LABEL)과 같은 말을 써야 한다 — 하나라도 빠지면 코드가 그대로 찍힌다
  assert.deepEqual(Object.keys(METHOD_LABEL).sort(),
    ['bullet', 'equal_payment', 'equal_principal', 'none'])
})

/* ── 계좌(차입금 건)별 묶음 ────────────────────────────────────────
 * 날짜순 한 줄로만 내면 계좌들의 회차가 뒤섞여, "이 계좌에 얼마 갚았나"를 눈으로 골라야 한다. */

test('상환 내역을 계좌별로 묶고 소계를 낸다', async () => {
  const d = await loanReport(fakeDb({
    loans: [
      { ...LOAN, id: 'A', name: '경남은행 64-9304' },
      { ...LOAN, id: 'B', name: '기업은행 185' },
    ],
    repayments: [
      { loan_id: 'A', seq: 1, due_date: '2026-01-19', paid_date: '2026-01-19', principal: 1_041_796, interest: 181_303 },
      { loan_id: 'A', seq: 2, due_date: '2026-02-19', paid_date: '2026-02-19', principal: 1_045_000, interest: 178_000 },
      { loan_id: 'B', seq: 1, due_date: '2026-01-31', paid_date: '2026-01-31', principal: 0, interest: 500_000 },
    ],
  }))
  assert.equal(d.byLoan.length, 2)
  const a = d.byLoan.find(g => g.loanId === 'A')
  assert.equal(a.rows.length, 2)
  assert.equal(a.subtotal.principal, 2_086_796)
  assert.equal(a.subtotal.interest, 359_303)
  assert.equal(a.subtotal.total, 2_446_099)
  assert.equal(a.subtotal.count, 2)
  // 소계를 다 더하면 전체와 같아야 한다 — 어긋나면 어느 쪽이 맞는지 알 수 없다
  const sum = d.byLoan.reduce((t, g) => t + g.subtotal.total, 0)
  assert.equal(sum, d.repayments.reduce((t, r) => t + r.total, 0))
})

test('상환 실적이 없는 계좌도 목록에 남는다', async () => {
  // 빠지면 "안 갚은 것"과 "화면에 안 나온 것"을 구별할 수 없다
  const d = await loanReport(fakeDb({ loans: [{ ...LOAN, id: 'A' }] }))
  assert.equal(d.byLoan.length, 1)
  assert.deepEqual(d.byLoan[0].rows, [])
  assert.equal(d.byLoan[0].subtotal.total, 0)
})

test('계좌 하나만 고르면 그 건만 나온다', async () => {
  const calls = []
  const db = {
    async execute(sql, params) {
      calls.push([sql, params])
      if (/FROM loans/.test(sql)) {
        // 라우트가 넘긴 id 로 걸러졌는지 — 안 걸리면 전체가 나가 파일이 통째로 달라진다
        assert.deepEqual(params, ['B'])
        return [[{ ...LOAN, id: 'B', name: '기업은행 185' }]]
      }
      if (/FROM loan_repayments/.test(sql)) return [[]]
      if (/FROM loan_draws/.test(sql)) return [[]]
      throw new Error('예상 못 한 질의')
    },
  }
  const d = await loanReport(db, { loanId: 'B' })
  assert.equal(d.loanId, 'B')
  assert.equal(d.loans.length, 1)
  assert.equal(d.loans[0].name, '기업은행 185')
  assert.ok(/WHERE l\.id IN \(\?\)/.test(calls[0][0]), '고른 건만 뽑는 조건이 SQL 에 있어야 한다')
})

test('계좌를 고르면 진행중 필터를 무시한다 — 다 갚은 건을 골라도 보여야 한다', async () => {
  const db = {
    async execute(sql) {
      if (/FROM loans/.test(sql)) {
        assert.ok(!/status = 'active'/.test(sql), '고른 것이 곧 의도다 — status 로 또 거르면 빈 표가 된다')
        return [[{ ...LOAN, id: 'B', status: 'closed' }]]
      }
      return [[]]
    },
  }
  const d = await loanReport(db, { status: 'active', loanId: 'B' })
  assert.equal(d.loans.length, 1)
  assert.equal(d.loans[0].status, 'closed')
})

test('여러 건을 고르면 그 건들만 나온다 — 칩 다중 선택', async () => {
  const calls = []
  const db = {
    async execute(sql, params) {
      calls.push([sql, params])
      if (/FROM loans/.test(sql)) {
        assert.deepEqual(params, ['A', 'C'], '고른 id 가 그대로 조건에 들어가야 한다')
        return [[{ ...LOAN, id: 'A' }, { ...LOAN, id: 'C' }]]
      }
      return [[]]
    },
  }
  const d = await loanReport(db, { loanIds: ['A', 'C'] })
  assert.equal(d.loans.length, 2)
  assert.ok(/WHERE l\.id IN \(\?,\?\)/.test(calls[0][0]))
})

test('기간은 상환 내역만 자른다 — 차입금 목록은 그대로', async () => {
  /* 구간에 상환이 없다고 그 차입금이 사라지면 안 된다. 잔액은 그대로 남아 있는데
     목록에서 빠지면 **부채가 없어진 것처럼** 보인다. */
  const db = {
    async execute(sql) {
      if (/FROM loans/.test(sql)) return [[{ ...LOAN, id: 'A' }]]
      if (/FROM loan_repayments/.test(sql)) return [[
        { loan_id: 'A', seq: 1, due_date: '2026-01-10', paid_date: '2026-01-10', principal: 100, interest: 10 },
        { loan_id: 'A', seq: 2, due_date: '2026-06-10', paid_date: '2026-06-10', principal: 100, interest: 10 },
      ]]
      return [[]]
    },
  }
  const d = await loanReport(db, { from: '2026-05-01', to: '2026-12-31' })
  assert.equal(d.loans.length, 1, '기간 밖이어도 차입금은 남아야 한다')
  assert.equal(d.repayments.length, 1, '상환 내역만 구간으로 잘린다')
  assert.equal(d.repayments[0].seq, 2)
})
