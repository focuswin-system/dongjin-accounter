/**
 * 카드사 이용내역 엑셀 → 카드 사용 지출 변환 규칙 테스트.
 *
 * 여기서 틀리면 업로드는 성공하고 숫자만 조용히 틀어진다. 위험한 순서대로:
 *   · 열을 잘못 짚으면(공급가액을 합계로) 경비가 10% 적게 잡힌다 — 아무 오류도 안 난다.
 *   · 승인번호를 못 읽으면 같은 명세서를 두 번 올렸을 때 경비가 두 배가 된다.
 *   · 취소(음수) 건이 그대로 들어가면 지출이 두 줄 남아 증빙을 맞출 수 없다.
 *
 * 대상 모듈(src/lib/cardStatement.js)은 프런트엔드 ESM 이지만 순수 함수만 있어
 * 여기서 그대로 불러 쓴다(번들러를 안 거치므로 그 파일의 import 에는 확장자가 있어야 한다).
 */
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const loading = import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', 'cardStatement.js')).href)

// 엑셀 한 행(대상 라벨 → 셀 값) → mapCardRow 가 받는 g 함수
const getter = (cells) => (target) => String(cells[target] ?? '')

test('카드사마다 다른 열 이름을 같은 뜻으로 짚는다', async () => {
  const M = await loading
  const g = M.guessCardColumn
  // 신한·삼성·현대·KB·롯데 이용내역에서 실제로 쓰는 머리글들
  assert.equal(g('이용일자'), M.C.date)
  assert.equal(g('이용일'), M.C.date)
  assert.equal(g('승인일자'), M.C.date)
  assert.equal(g('거래일자'), M.C.date)          // 홈택스 사업용카드
  assert.equal(g('이용가맹점'), M.C.merchant)
  assert.equal(g('가맹점명'), M.C.merchant)
  assert.equal(g('이용금액'), M.C.amount)
  assert.equal(g('승인금액'), M.C.amount)
  assert.equal(g('합계금액'), M.C.amount)
  assert.equal(g('할부개월'), M.C.installment)
  assert.equal(g('사업자등록번호'), M.C.bizNo)
  assert.equal(g('봉사료'), M.C.tip)
  assert.equal(g(''), null)
  assert.equal(g('포인트'), null)                // 모르는 열은 비워 둔다(사람이 고른다)
})

test('취소 건은 상태 열로 가려낸다 — 금액이 양수라 금액만 보면 못 가린다', async () => {
  const M = await loading
  // 신한·KB 는 금액을 양수로 두고 '매입상태=취소'로만 표시한다
  assert.equal(M.guessCardColumn('매입상태'), M.C.status)
  assert.equal(M.guessCardColumn('승인상태'), M.C.status)

  const canceled = M.mapCardRow(getter({
    [M.C.date]: '2026-09-03', [M.C.merchant]: '지에스25', [M.C.amount]: '11,000', [M.C.status]: '취소',
  }))
  assert.equal(canceled.canceled, true)
  assert.equal(M.isCardRowValid(canceled), false)
  assert.match(M.cardInvalidLabel(canceled), /취소/)

  const normal = M.mapCardRow(getter({
    [M.C.date]: '2026-09-03', [M.C.merchant]: '지에스25', [M.C.amount]: '11,000', [M.C.status]: '정상',
  }))
  assert.equal(normal.canceled, false)
  assert.equal(M.isCardRowValid(normal), true)
})

test('업종이 가맹점보다 먼저다 — 가맹점업종이 거래처 이름으로 들어가면 안 된다', async () => {
  const M = await loading
  assert.equal(M.guessCardColumn('가맹점업종'), M.C.industry)
  assert.equal(M.guessCardColumn('업종'), M.C.industry)
  assert.equal(M.guessCardColumn('가맹점명'), M.C.merchant)   // 업종이 없으면 가맹점 그대로
})

test('공급가액을 합계로 짚지 않는다 — 그러면 경비가 10% 적게 잡힌다', async () => {
  const M = await loading
  assert.equal(M.guessCardColumn('공급가액'), M.C.supply)
  assert.equal(M.guessCardColumn('부가세'), M.C.vat)
  assert.equal(M.guessCardColumn('부가가치세'), M.C.vat)
  // '승인번호'가 '승인일자'(날짜) 규칙에 먼저 잡히면 중복 판정이 통째로 사라진다
  assert.equal(M.guessCardColumn('승인번호'), M.C.approval)
})

test('한 행 → 지출 한 건 (공급가·세액이 찍혀 온 전형적인 행)', async () => {
  const M = await loading
  const d = M.mapCardRow(getter({
    [M.C.date]: '2026.09.03', [M.C.merchant]: '지에스25 서면점',
    [M.C.amount]: '11,000', [M.C.supply]: '10,000', [M.C.vat]: '1,000',
    [M.C.approval]: '12345678', [M.C.installment]: '일시불',
  }), { defaultCategory: '소모품비' })
  assert.equal(d.date, '2026-09-03')
  assert.equal(d.amount, 11000)
  assert.equal(d.supply_amount, 10000)
  assert.equal(d.vat_amount, 1000)
  assert.equal(d.tax_type, '과세')
  assert.equal(d.approval_no, '12345678')
  assert.equal(d.installment, 1)
  assert.equal(d.category, '소모품비')
  assert.equal(d.memo, '지에스25 서면점')       // 가맹점은 적요에 남는다
  assert.ok(M.isCardRowValid(d))
})

test('세액 열이 없으면 과세유형을 정하지 않는다 — 서버가 비목 설정대로 계산한다', async () => {
  const M = await loading
  const d = M.mapCardRow(getter({ [M.C.date]: '2026-09-03', [M.C.amount]: '11000' }))
  assert.equal(d.supply_amount, null)
  assert.equal(d.vat_amount, null)
  assert.equal(d.tax_type, null)
})

test('세액이 0으로 찍혀 오면 면세다 (병원·학원·농산물)', async () => {
  const M = await loading
  const d = M.mapCardRow(getter({
    [M.C.date]: '2026-09-03', [M.C.amount]: '30000', [M.C.supply]: '30000', [M.C.vat]: '0',
  }))
  assert.equal(d.tax_type, '면세')
  assert.equal(d.vat_amount, 0)
})

test('합계 열이 없는 파일은 공급가+세액+봉사료로 합계를 만든다', async () => {
  const M = await loading
  const d = M.mapCardRow(getter({
    [M.C.date]: '2026-09-03', [M.C.supply]: '10,000', [M.C.vat]: '1,000', [M.C.tip]: '500',
  }))
  assert.equal(d.amount, 11500)
  assert.ok(M.isCardRowValid(d))
})

test('할부는 개월 수를 읽고 승인일에 전액으로 잡는다', async () => {
  const M = await loading
  assert.equal(M.installmentMonths('일시불'), 1)
  assert.equal(M.installmentMonths(''), 1)
  assert.equal(M.installmentMonths('3개월'), 3)
  assert.equal(M.installmentMonths('03'), 3)
  assert.equal(M.installmentMonths('1'), 1)
  const d = M.mapCardRow(getter({
    [M.C.date]: '2026-09-03', [M.C.merchant]: '하이마트', [M.C.amount]: '1,200,000', [M.C.installment]: '6개월',
  }))
  assert.equal(d.amount, 1200000)               // 회차 금액이 아니라 승인 총액
  assert.ok(d.memo.includes('6개월 할부'))
  assert.ok(M.cardRowWarns(d).some(w => w.includes('할부')))
})

test('취소(음수) 건은 등록하지 않고 이유를 말한다', async () => {
  const M = await loading
  const d = M.mapCardRow(getter({ [M.C.date]: '2026-09-03', [M.C.amount]: '-11,000' }))
  assert.equal(d.amount, -11000)
  assert.equal(M.isCardRowValid(d), false)
  assert.match(M.cardInvalidLabel(d), /취소/)
})

test('중복 판정은 승인번호가 축이다', async () => {
  const M = await loading
  const withNo = M.mapCardRow(getter({
    [M.C.date]: '2026-09-03', [M.C.amount]: '11000', [M.C.merchant]: 'A', [M.C.approval]: '00012345',
  }))
  const sameNoOtherDay = M.mapCardRow(getter({
    [M.C.date]: '2026-09-09', [M.C.amount]: '11000', [M.C.merchant]: 'B', [M.C.approval]: '00012345',
  }))
  assert.equal(M.cardMatchKey(withNo), M.cardMatchKey(sameNoOtherDay))

  // 승인번호가 없으면 날짜+금액+가맹점으로 본다 — 가맹점이 다르면 다른 건이다
  const noNo1 = M.mapCardRow(getter({ [M.C.date]: '2026-09-03', [M.C.amount]: '4500', [M.C.merchant]: '카페A' }))
  const noNo2 = M.mapCardRow(getter({ [M.C.date]: '2026-09-03', [M.C.amount]: '4500', [M.C.merchant]: '카페B' }))
  assert.notEqual(M.cardMatchKey(noNo1), M.cardMatchKey(noNo2))
  assert.ok(M.cardRowWarns(noNo1).some(w => w.includes('승인번호')))
})

test('청구내역 파일을 이용내역으로 잘못 올리는 것을 머리글로 가려낸다', async () => {
  const M = await loading
  assert.equal(M.looksLikeBillingFile(['이용일자', '가맹점명', '이용금액', '승인번호']), false)
  assert.equal(M.looksLikeBillingFile(['결제일', '가맹점', '이번달청구금액', '할부회차']), true)
  assert.equal(M.looksLikeBillingFile(['이용일자', '잔여할부금']), true)
  // 실제 이용대금명세서에 흔한 머리글들 — 하나라도 놓치면 할부 원금이 회차마다 또 잡힌다
  assert.equal(M.looksLikeBillingFile(['결제일', '가맹점', '결제금액', '수수료', '원금']), true)
  assert.equal(M.looksLikeBillingFile(['이용일자', '잔여회차']), true)
  assert.equal(M.looksLikeBillingFile(['결제예정금액']), true)
})
