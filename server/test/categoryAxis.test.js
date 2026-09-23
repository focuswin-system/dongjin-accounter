/**
 * 복합 거래(txn_splits)를 비목 축에서 펼치는 규칙 + 업로드 양식의 금액 서식.
 *
 * 여기서 틀리면 **틀린 티가 안 난다.** 합계도 부가세도 맞고 비목 분포만 어긋나기 때문에,
 * 총액을 맞춰 보는 검산으로는 안 걸린다. 화면에서 재현하려면 복합 전표를 먼저 적어야 해서
 * (운영 테넌트에는 한 건도 없다) 규칙만 떼어 여기서 못박는다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const {
  splitJoin, splitCategory, splitAmount, splitSupply, splitSupplyRaw, splitVat,
  splitTxnCount, splitCategoryFilter,
} = require('../lib/categoryAxis')
const { newBook, templateSheet } = require('../lib/xlsxBook')
const ExcelJS = require('exceljs')

// ── 비목 축 조각 ────────────────────────────────────────────────────────

test('JOIN 은 복합 거래에만 붙는다 — 아니면 모든 거래가 중복된다', () => {
  const j = splitJoin()
  assert.match(j, /LEFT JOIN txn_splits/)
  // has_splits = 1 조건이 빠지면 LEFT JOIN 이 아니라 전수 결합이 되어 합계가 부푼다
  assert.match(j, /t\.has_splits = 1/)
})

test('별칭을 바꿔 부를 수 있다 — 같은 질의에 표가 여럿일 때', () => {
  assert.match(splitJoin('tx', 'sp'), /txn_splits sp ON sp\.txn_id = tx\.id AND tx\.has_splits = 1/)
  assert.strictEqual(splitCategory('tx', 'sp'), 'COALESCE(sp.category, tx.category)')
})

test('항목이 있으면 항목 값이, 없으면 거래 값이 이긴다', () => {
  assert.strictEqual(splitCategory(), 'COALESCE(s.category, t.category)')
  assert.strictEqual(splitAmount(), 'COALESCE(s.amount, t.amount)')
  assert.strictEqual(splitVat(), 'COALESCE(s.vat_amount, t.vat_amount)')
})

test('공급가액은 쓰임이 둘 — 집계는 총액으로 폴백하고, 전달 자료는 NULL 을 지킨다', () => {
  // 집계: 부가세 컬럼이 없던 시절 거래를 0 으로 세면 그 기간 매입이 통째로 사라진다
  assert.match(splitSupply(), /t\.amount\)$/)
  // 전달 자료: 모르는 값을 총액으로 채우면 '세액 0원'으로 읽혀 세무사가 부가세를 빼먹는다
  assert.strictEqual(splitSupplyRaw(), 'COALESCE(s.supply_amount, t.supply_amount)')
  assert.ok(!splitSupplyRaw().includes('.amount)'), '전달 자료용에는 총액 폴백이 없어야 한다')
})

test('건수는 펼친 줄이 아니라 거래를 센다', () => {
  assert.strictEqual(splitTxnCount(), 'COUNT(DISTINCT t.id)')
})

test('비목 필터는 JOIN 없이 동작하고 값을 정확히 두 번 받는다', () => {
  const f = splitCategoryFilter()
  // EXISTS 라 줄이 안 늘어난다 — 거래처·월 축에 같이 걸어도 합계가 안 부푼다
  assert.match(f, /EXISTS/)
  assert.ok(!f.includes('LEFT JOIN'), 'JOIN 을 품으면 다른 축에서 별칭 충돌이 난다')
  // 물음표 개수가 곧 params.push 횟수다 — 어긋나면 질의가 통째로 깨진다
  assert.strictEqual((f.match(/\?/g) || []).length, 2)
})

test('비목 축 조각은 s 별칭에만 기댄다 — 다른 표 별칭이 새면 질의가 깨진다', () => {
  for (const sql of [splitCategory(), splitAmount(), splitSupply(), splitVat()]) {
    assert.match(sql, /^COALESCE\(s\./)
  }
})

// ── 업로드 양식의 금액 서식 ─────────────────────────────────────────────

test('양식의 금액 열에 천단위 서식이 붙고, 머리글 글자는 그대로다', async () => {
  const columns = [
    { header: '거래일자', width: 12, required: true },
    { header: '거래처', width: 22 },
    { header: '금액', width: 12, required: true, money: true },
    { header: '수량', width: 10, int: true },
  ]
  const wb = newBook()
  templateSheet(wb, '거래내역', { columns, samples: [['2026-09-01', '가나다', 8000000, 3]] })

  const buf = await wb.xlsx.writeBuffer()
  const read = new ExcelJS.Workbook()
  await read.xlsx.load(buf)
  const ws = read.getWorksheet(1)

  /* ⚠ 이 검사가 이 파일에서 가장 중요하다. 머리글에 '금액 *' 처럼 표시를 붙이면
     임포트 파서가 열을 못 찾아 받아 간 양식이 그대로 안 붙는다(왕복이 깨진다).
     필수 표시는 글자가 아니라 바탕색으로만 준다. */
  assert.deepStrictEqual(
    ws.getRow(1).values.slice(1),
    ['거래일자', '거래처', '금액', '수량'],
  )

  const money = ws.getRow(2).getCell(3)
  assert.strictEqual(typeof money.value, 'number', '금액은 숫자여야 엑셀이 서식을 입힌다')
  assert.match(money.numFmt || '', /#,##0/)
  assert.match(ws.getRow(2).getCell(4).numFmt || '', /0/)

  // 금액이 아닌 열에는 숫자 서식을 걸지 않는다 — 날짜·상호가 숫자로 뭉개진다
  assert.ok(!ws.getRow(2).getCell(1).numFmt, '날짜 열에 숫자 서식이 붙으면 안 된다')
  assert.ok(!ws.getRow(2).getCell(2).numFmt, '글자 열에 숫자 서식이 붙으면 안 된다')
})

test('금액 열이 없는 양식은 예전과 똑같이 나온다', async () => {
  const columns = [{ header: '상호명', width: 22, required: true }, { header: '사업자번호', width: 14 }]
  const wb = newBook()
  templateSheet(wb, '거래처', { columns, samples: [['가나다', '123-45-67891']] })
  const buf = await wb.xlsx.writeBuffer()
  const read = new ExcelJS.Workbook()
  await read.xlsx.load(buf)
  const ws = read.getWorksheet(1)
  assert.deepStrictEqual(ws.getRow(1).values.slice(1), ['상호명', '사업자번호'])
  // 사업자번호는 **글자다.** 숫자 서식이 붙으면 앞의 0 이 사라져 틀린 번호가 된다
  assert.ok(!ws.getRow(2).getCell(2).numFmt)
  assert.strictEqual(ws.getRow(2).getCell(2).value, '123-45-67891')
})
