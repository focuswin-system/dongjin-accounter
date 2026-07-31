/**
 * 홈택스 세금계산서 엑셀 → 청구서 변환 규칙 테스트.
 *
 * 여기서 틀리면 업로드는 성공하고 숫자만 조용히 틀어진다. 두 가지가 특히 위험하다:
 *   · 매출/매입 방향이 뒤집히면 매출세액과 매입세액이 통째로 자리를 바꾼다.
 *   · 면세를 과세로(또는 영세를 면세로) 넣으면 부가세 신고액이 어긋난다.
 * 둘 다 신고 때가 되어서야 드러나므로 테스트 가성비가 가장 높은 자리다.
 *
 * 대상 모듈(src/lib/hometax.js)은 프런트엔드 ESM이지만 import가 하나도 없는 순수 함수라
 * 여기서 그대로 불러 쓴다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const loading = import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', 'hometax.js')).href)

const OUR = '000-00-00000'

// 엑셀 한 행(대상 라벨 → 셀 값) → mapHometaxRow가 받는 g 함수
const getter = (cells) => (target) => String(cells[target] ?? '')

// 우리가 파는 쪽(공급자 = 우리)인 전형적인 한 행
const SALE_ROW = (M) => ({
  [M.T.date]: '2026-07-05',
  [M.T.confirm]: '20260705-41000000-11111111',
  [M.T.supBiz]: OUR,
  [M.T.supName]: '(주)포커스윈',
  [M.T.buyBiz]: '111-11-11111',
  [M.T.buyName]: '(주)한화오션',
  [M.T.total]: '11,000,000',
  [M.T.supply]: '10,000,000',
  [M.T.vat]: '1,000,000',
  [M.T.docKind]: '일반',
})

test('공급자가 우리면 매출, 공급받는자가 우리면 매입', async () => {
  const M = await loading
  const sale = M.mapHometaxRow(getter(SALE_ROW(M)), { ourBizNo: OUR })
  assert.strictEqual(sale.kind, 'issued')
  assert.strictEqual(sale._by, 'biz')

  // 같은 행에서 우리·상대를 맞바꾸면 매입이어야 한다
  const buyCells = { ...SALE_ROW(M), [M.T.supBiz]: '111-11-11111', [M.T.buyBiz]: OUR }
  const buy = M.mapHometaxRow(getter(buyCells), { ourBizNo: OUR })
  assert.strictEqual(buy.kind, 'received')
})

test('사업자번호는 표기(하이픈·공백)가 달라도 같게 본다', async () => {
  const M = await loading
  const cells = { ...SALE_ROW(M), [M.T.supBiz]: '000 - 00 - 00000' }
  const r = M.mapHometaxRow(getter(cells), { ourBizNo: OUR.replace(/-/g, '') })
  assert.strictEqual(r.kind, 'issued')
  assert.strictEqual(r._by, 'biz')
})

test('우리 번호와 어느 쪽도 안 맞으면 기본 구분으로 넣고 근거를 남긴다', async () => {
  const M = await loading
  const cells = { ...SALE_ROW(M), [M.T.supBiz]: '999-99-99999', [M.T.buyBiz]: '111-11-11111' }
  const r = M.mapHometaxRow(getter(cells), { ourBizNo: OUR, defaultKind: 'received' })
  assert.strictEqual(r.kind, 'received')
  assert.strictEqual(r._by, 'default')
  // 조용히 넘어가면 안 된다 — 행에 경고가 붙어야 한다
  const warns = M.hometaxRowWarns(r, { ourBizNo: OUR })
  assert.ok(warns.some(w => /맞지 않아/.test(w)), warns.join(' / '))
})

test('우리 사업자번호가 비어 있으면 판정하지 않고 경고한다', async () => {
  const M = await loading
  const r = M.mapHometaxRow(getter(SALE_ROW(M)), { ourBizNo: '', defaultKind: 'issued' })
  assert.strictEqual(r._by, 'default')
  const warns = M.hometaxRowWarns(r, { ourBizNo: '' })
  assert.ok(warns.some(w => /사업자등록번호가 없어/.test(w)), warns.join(' / '))
})

test('거래처는 언제나 우리 반대편이다', async () => {
  const M = await loading
  const sale = M.mapHometaxRow(getter(SALE_ROW(M)), { ourBizNo: OUR })
  assert.strictEqual(sale.vendor_name, '(주)한화오션')      // 매출 → 공급받는자
  assert.strictEqual(sale.biz_no, '111-11-11111')

  const buyCells = { ...SALE_ROW(M), [M.T.supBiz]: '111-11-11111', [M.T.buyBiz]: OUR }
  const buy = M.mapHometaxRow(getter(buyCells), { ourBizNo: OUR })
  assert.strictEqual(buy.vendor_name, '(주)포커스윈')       // 매입 → 공급자
})

test('머리글 추측 — 공급받는자 칸이 공급자로 잡히지 않는다', async () => {
  const M = await loading
  // 이게 뒤집히면 매출·매입이 통째로 반대가 된다
  assert.strictEqual(M.guessHometaxColumn('공급받는자 사업자등록번호'), M.T.buyBiz)
  assert.strictEqual(M.guessHometaxColumn('공급자 사업자등록번호'), M.T.supBiz)
  assert.strictEqual(M.guessHometaxColumn('공급받는자 상호'), M.T.buyName)
  assert.strictEqual(M.guessHometaxColumn('공급자 상호'), M.T.supName)
  // 청구서에 넣지 않는 칸은 매핑하지 않는다
  assert.strictEqual(M.guessHometaxColumn('공급자 대표자명'), '사용 안함')
  assert.strictEqual(M.guessHometaxColumn('공급받는자 이메일1'), '사용 안함')
})

test('머리글 추측 — 금액 세 칸이 서로 섞이지 않는다', async () => {
  const M = await loading
  assert.strictEqual(M.guessHometaxColumn('합계금액'), M.T.total)
  assert.strictEqual(M.guessHometaxColumn('공급가액'), M.T.supply)
  assert.strictEqual(M.guessHometaxColumn('세액'), M.T.vat)
  assert.strictEqual(M.guessHometaxColumn('작성일자'), M.T.date)
  assert.strictEqual(M.guessHometaxColumn('승인번호'), M.T.confirm)
})

test('작성일자 — 엑셀이 주는 여러 표기를 YYYY-MM-DD로 통일한다', async () => {
  const M = await loading
  assert.strictEqual(M.normDate('2026-07-05'), '2026-07-05')
  assert.strictEqual(M.normDate('2026.7.5'), '2026-07-05')
  assert.strictEqual(M.normDate('2026/07/05'), '2026-07-05')
  assert.strictEqual(M.normDate('2026년 7월 5일'), '2026-07-05')
  assert.strictEqual(M.normDate('20260705'), '2026-07-05')
  assert.strictEqual(M.normDate(''), '')
  assert.strictEqual(M.normDate('알 수 없음'), '')
})

test('결제기한 — 작성일자 + N일. 월을 넘겨도 맞고, 0이면 기한 없음', async () => {
  const M = await loading
  assert.strictEqual(M.addDays('2026-07-05', 30), '2026-08-04')
  assert.strictEqual(M.addDays('2026-12-20', 30), '2027-01-19')
  assert.strictEqual(M.addDays('2026-01-31', 30), '2026-03-02')   // 2026년 2월은 28일
  assert.strictEqual(M.addDays('2026-07-05', 0), '')
  assert.strictEqual(M.addDays('2026-07-05', ''), '')
  assert.strictEqual(M.addDays('', 30), '')
})

test('과세유형 — 세액이 있으면 과세, 없으면 면세, 종류가 영세면 영세', async () => {
  const M = await loading
  const taxed = M.mapHometaxRow(getter(SALE_ROW(M)), { ourBizNo: OUR })
  assert.strictEqual(taxed.tax_type, '과세')

  const exemptCells = { ...SALE_ROW(M), [M.T.vat]: '0', [M.T.total]: '10,000,000' }
  assert.strictEqual(M.mapHometaxRow(getter(exemptCells), { ourBizNo: OUR }).tax_type, '면세')

  // 영세는 세액 0이지만 과세표준에 들어간다 — 면세와 구분되어야 한다
  const zeroCells = { ...exemptCells, [M.T.docKind]: '영세율' }
  assert.strictEqual(M.mapHometaxRow(getter(zeroCells), { ourBizNo: OUR }).tax_type, '영세')
})

test('금액 — 셋 중 하나가 비어도 나머지로 채운다', async () => {
  const M = await loading
  const noSupply = { ...SALE_ROW(M), [M.T.supply]: '' }
  const a = M.mapHometaxRow(getter(noSupply), { ourBizNo: OUR })
  assert.strictEqual(a.supply_amount, 10000000)
  assert.strictEqual(a.total_amount, 11000000)

  const noTotal = { ...SALE_ROW(M), [M.T.total]: '' }
  const b = M.mapHometaxRow(getter(noTotal), { ourBizNo: OUR })
  assert.strictEqual(b.total_amount, 11000000)
})

test('경고 — 세액이 공급가액의 10%가 아니면 알린다(컬럼이 밀린 신호)', async () => {
  const M = await loading
  const cells = { ...SALE_ROW(M), [M.T.vat]: '100,000', [M.T.total]: '10,100,000' }
  const r = M.mapHometaxRow(getter(cells), { ourBizNo: OUR })
  const warns = M.hometaxRowWarns(r, { ourBizNo: OUR })
  assert.ok(warns.some(w => /10%/.test(w)), warns.join(' / '))
})

test('경고 — 합계금액이 공급가액＋세액과 다르면 알린다', async () => {
  const M = await loading
  const cells = { ...SALE_ROW(M), [M.T.total]: '12,000,000' }
  const r = M.mapHometaxRow(getter(cells), { ourBizNo: OUR })
  assert.ok(M.hometaxRowWarns(r, { ourBizNo: OUR }).some(w => /합계금액/.test(w)))
})

test('경고 — 정상적인 행에는 경고가 붙지 않는다', async () => {
  const M = await loading
  const r = M.mapHometaxRow(getter(SALE_ROW(M)), { ourBizNo: OUR })
  assert.deepStrictEqual(M.hometaxRowWarns(r, { ourBizNo: OUR }), [])
})

test('경고 — 승인번호가 없으면 다음 업로드에서 중복을 못 거른다고 알린다', async () => {
  const M = await loading
  const cells = { ...SALE_ROW(M), [M.T.confirm]: '' }
  const r = M.mapHometaxRow(getter(cells), { ourBizNo: OUR })
  assert.ok(M.hometaxRowWarns(r, { ourBizNo: OUR }).some(w => /승인번호/.test(w)))
})

test('중복 키 — 승인번호가 있으면 그것만으로 판정한다', async () => {
  const M = await loading
  const norm = (s) => String(s).toLowerCase()
  const a = M.mapHometaxRow(getter(SALE_ROW(M)), { ourBizNo: OUR })
  // 같은 계산서인데 금액 표기만 다른 행 → 같은 키여야 두 번 등록되지 않는다
  const b = M.mapHometaxRow(getter({ ...SALE_ROW(M), [M.T.total]: '11000000' }), { ourBizNo: OUR })
  assert.strictEqual(M.hometaxMatchKey(a, norm), M.hometaxMatchKey(b, norm))
  assert.ok(M.hometaxMatchKey(a, norm).startsWith('c:'))
})

test('중복 키 — 승인번호가 없으면 구분·거래처·작성일자·합계로 판정한다', async () => {
  const M = await loading
  const norm = (s) => String(s).toLowerCase()
  const base = { ...SALE_ROW(M), [M.T.confirm]: '' }
  const a = M.mapHometaxRow(getter(base), { ourBizNo: OUR })
  const same = M.mapHometaxRow(getter({ ...base }), { ourBizNo: OUR })
  const other = M.mapHometaxRow(getter({ ...base, [M.T.total]: '22,000,000' }), { ourBizNo: OUR })
  assert.strictEqual(M.hometaxMatchKey(a, norm), M.hometaxMatchKey(same, norm))
  assert.notStrictEqual(M.hometaxMatchKey(a, norm), M.hometaxMatchKey(other, norm))
})

/* ── 품목 상세(한 계산서가 여러 행) ────────────────────────────────
 * 안 묶으면 같은 계산서가 여러 건으로 들어가 매출이 부풀고,
 * 잘못 묶으면 다른 계산서의 금액이 통째로 사라진다. */

// 엑셀 컬럼명 = 매핑 대상 라벨이라고 보고 만든 colFor(실제로는 사용자가 매핑한 컬럼명)
const colForSelf = (M) => (t) => (Object.values(M.T).includes(t) ? t : undefined)
const rowsWithItems = (M) => ([
  { [M.T.date]: '2026-07-05', [M.T.confirm]: 'A-1', [M.T.supBiz]: OUR, [M.T.buyBiz]: '111-11-11111',
    [M.T.buyName]: '(주)한화오션', [M.T.total]: '11,000,000', [M.T.supply]: '10,000,000', [M.T.vat]: '1,000,000',
    [M.T.itemName]: '회원관리 개발', [M.T.itemSpec]: '2차', [M.T.itemQty]: '1', [M.T.itemPrice]: '7,000,000', [M.T.itemAmount]: '7,000,000' },
  { [M.T.date]: '2026-07-05', [M.T.confirm]: 'A-1', [M.T.supBiz]: OUR, [M.T.buyBiz]: '111-11-11111',
    [M.T.buyName]: '(주)한화오션', [M.T.total]: '11,000,000', [M.T.supply]: '10,000,000', [M.T.vat]: '1,000,000',
    [M.T.itemName]: '유지보수', [M.T.itemSpec]: '월정액', [M.T.itemQty]: '6', [M.T.itemPrice]: '500,000', [M.T.itemAmount]: '3,000,000' },
  { [M.T.date]: '2026-07-10', [M.T.confirm]: 'B-2', [M.T.supBiz]: '222-22-22222', [M.T.buyBiz]: OUR,
    [M.T.supName]: '정밀가공(주)', [M.T.total]: '1,650,000', [M.T.supply]: '1,500,000', [M.T.vat]: '150,000',
    [M.T.itemName]: 'CNC 가공', [M.T.itemQty]: '30', [M.T.itemPrice]: '50,000', [M.T.itemAmount]: '1,500,000' },
])

test('품목 상세 — 승인번호가 같은 행은 한 계산서로 묶고 금액을 한 번만 센다', async () => {
  const M = await loading
  const grouped = M.groupHometaxRows(rowsWithItems(M), colForSelf(M))
  assert.strictEqual(grouped.length, 2)                    // 3행 → 2건
  assert.strictEqual(grouped[0].__lines.length, 2)
  assert.strictEqual(grouped[1].__lines.length, 1)
  assert.strictEqual(grouped[0].__mergedRows, 2)

  const first = M.mapHometaxRow(getter(grouped[0]), { ourBizNo: OUR }, grouped[0])
  assert.strictEqual(first.total_amount, 11000000)         // 22,000,000이 되면 매출이 두 배로 부푼다
  assert.strictEqual(first.lines.length, 2)
  assert.strictEqual(first.lines[0].name, '회원관리 개발')
  assert.strictEqual(first.lines[1].qty, 6)
  assert.strictEqual(first.lines[1].amount, 3000000)
})

test('품목 상세 — 원본 엑셀 행 번호를 잃지 않는다(표에 그 번호가 뜬다)', async () => {
  const M = await loading
  const grouped = M.groupHometaxRows(rowsWithItems(M), colForSelf(M))
  assert.strictEqual(grouped[0].__row, 0)
  assert.strictEqual(grouped[1].__row, 2)                  // 2행이 합쳐졌으니 다음 건은 원본 3번째 행
})

test('품목 상세 — 묶은 뒤에도 방향·거래처는 각 계산서대로다', async () => {
  const M = await loading
  const grouped = M.groupHometaxRows(rowsWithItems(M), colForSelf(M))
  const a = M.mapHometaxRow(getter(grouped[0]), { ourBizNo: OUR }, grouped[0])
  const b = M.mapHometaxRow(getter(grouped[1]), { ourBizNo: OUR }, grouped[1])
  assert.strictEqual(a.kind, 'issued')
  assert.strictEqual(a.vendor_name, '(주)한화오션')
  assert.strictEqual(b.kind, 'received')
  assert.strictEqual(b.vendor_name, '정밀가공(주)')
})

test('품목 상세 — 승인번호가 없으면 묶지 않는다(잘못 합치면 금액이 사라진다)', async () => {
  const M = await loading
  const rows = rowsWithItems(M).map(r => ({ ...r, [M.T.confirm]: '' }))
  const grouped = M.groupHometaxRows(rows, colForSelf(M))
  assert.strictEqual(grouped.length, 3)                    // 근거가 없으면 행을 그대로 둔다
  assert.strictEqual(grouped[0].__lines.length, 1)
})

test('품목 — 품목 공급가액이 비면 수량×단가로 채운다', async () => {
  const M = await loading
  const rows = [{ ...rowsWithItems(M)[0], [M.T.itemAmount]: '' }]
  const grouped = M.groupHometaxRows(rows, colForSelf(M))
  assert.strictEqual(grouped[0].__lines[0].amount, 7000000)
})

test('품목 — 품목 칸을 안 쓰면 라인 없이 계산서만 들어간다', async () => {
  const M = await loading
  const grouped = M.groupHometaxRows(rowsWithItems(M), (t) => (
    // 품목 컬럼을 매핑하지 않은 경우
    [M.T.itemName, M.T.itemSpec, M.T.itemQty, M.T.itemPrice, M.T.itemAmount].includes(t) ? undefined
      : (Object.values(M.T).includes(t) ? t : undefined)
  ))
  assert.strictEqual(grouped.length, 2)                    // 묶기는 그대로 동작
  assert.strictEqual(grouped[0].__lines.length, 0)
  const d = M.mapHometaxRow(getter(grouped[0]), { ourBizNo: OUR }, grouped[0])
  assert.deepStrictEqual(d.lines, [])
  assert.deepStrictEqual(M.hometaxRowWarns(d, { ourBizNo: OUR }), [])   // 품목 없다고 경고하지 않는다
})

test('품목 — 합계가 공급가액과 다르면 알린다(행이 덜 묶였거나 컬럼이 틀렸다는 신호)', async () => {
  const M = await loading
  const rows = [rowsWithItems(M)[0]]                       // 품목 1줄(7백만)뿐인데 공급가액은 1천만
  const grouped = M.groupHometaxRows(rows, colForSelf(M))
  const d = M.mapHometaxRow(getter(grouped[0]), { ourBizNo: OUR }, grouped[0])
  assert.ok(M.hometaxRowWarns(d, { ourBizNo: OUR }).some(w => /품목 합계/.test(w)))
})

test('머리글 추측 — 품목 칸이 계산서 합계 칸을 가로채지 않는다', async () => {
  const M = await loading
  // 이게 뒤집히면 품목이 여러 개인 계산서에서만 금액이 틀어진다(가장 늦게 발견되는 종류)
  assert.strictEqual(M.guessHometaxColumn('품목공급가액'), M.T.itemAmount)
  assert.strictEqual(M.guessHometaxColumn('공급가액'), M.T.supply)
  assert.strictEqual(M.guessHometaxColumn('품목명'), M.T.itemName)
  assert.strictEqual(M.guessHometaxColumn('품목규격'), M.T.itemSpec)
  assert.strictEqual(M.guessHometaxColumn('품목수량'), M.T.itemQty)
  assert.strictEqual(M.guessHometaxColumn('품목단가'), M.T.itemPrice)
  assert.strictEqual(M.guessHometaxColumn('품목세액'), '사용 안함')   // 저장할 곳이 없다
  assert.strictEqual(M.guessHometaxColumn('품목일자'), '사용 안함')
  assert.strictEqual(M.guessHometaxColumn('작성일자'), M.T.date)
  // 품목 접두사 없는 표준 표기도 받는다
  assert.strictEqual(M.guessHometaxColumn('규격'), M.T.itemSpec)
  assert.strictEqual(M.guessHometaxColumn('수량'), M.T.itemQty)
  assert.strictEqual(M.guessHometaxColumn('단가'), M.T.itemPrice)
})

test('필수값 — 작성일자·거래처·금액이 없으면 등록하지 않고 이유를 말한다', async () => {
  const M = await loading
  const ok = M.mapHometaxRow(getter(SALE_ROW(M)), { ourBizNo: OUR })
  assert.strictEqual(M.isHometaxRowValid(ok), true)

  const noDate = M.mapHometaxRow(getter({ ...SALE_ROW(M), [M.T.date]: '' }), { ourBizNo: OUR })
  assert.strictEqual(M.isHometaxRowValid(noDate), false)
  assert.match(M.hometaxInvalidLabel(noDate), /작성일자/)

  const noVendor = M.mapHometaxRow(getter({ ...SALE_ROW(M), [M.T.buyName]: '' }), { ourBizNo: OUR })
  assert.strictEqual(M.isHometaxRowValid(noVendor), false)
  assert.match(M.hometaxInvalidLabel(noVendor), /거래처/)
})

test('경고 — 1년 넘게 미래인 작성일자를 알린다(정상 날짜엔 안 뜬다)', async () => {
  const M = await loading
  const far = M.mapHometaxRow(getter({ ...SALE_ROW(M), [M.T.date]: '2030-12-31' }), { ourBizNo: OUR })
  assert.ok(M.hometaxRowWarns(far, { ourBizNo: OUR, today: '2026-07-30' }).some(w => /1년 넘게/.test(w)))
  // 가까운 미래(정기청구 미리 발행)는 정당하므로 경고하지 않는다
  const near = M.mapHometaxRow(getter({ ...SALE_ROW(M), [M.T.date]: '2026-09-05' }), { ourBizNo: OUR })
  assert.deepStrictEqual(M.hometaxRowWarns(near, { ourBizNo: OUR, today: '2026-07-30' }), [])
  // today를 안 넘겨도 모든 행에 경고가 붙지 않아야 한다(오늘 기준으로 계산)
  const normal = M.mapHometaxRow(getter(SALE_ROW(M)), { ourBizNo: OUR })
  assert.deepStrictEqual(M.hometaxRowWarns(normal, { ourBizNo: OUR }), [])
})

test('금액 파싱이 서버 lib/money.js 와 같은 규칙이어야 한다', async () => {
  // 같은 엑셀을 프런트가 파싱하든 서버가 다시 계산하든 값이 같아야 한다.
  // 어긋나면 화면에 보인 금액과 저장된 금액이 다르다.
  const M = await loading
  const { moneyOf } = require('../lib/money')
  for (const v of ['1,100,000.00', '(1,100,000)', '₩1,100,000', '1.100.000', '', '없음', '-500', 1100000.5]) {
    assert.equal(M.intOf(v), moneyOf(v), `입력 ${JSON.stringify(v)} 에서 어긋남`)
  }
  // 100배 사고가 재발하지 않는지 못 박는다
  assert.equal(M.intOf('1,100,000.00'), 1_100_000)
})
