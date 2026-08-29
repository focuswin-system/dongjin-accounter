/* 부가세 신고 자료 — 엑셀 한 권.
 *
 * ── 왜 새로 만드나 ──
 * 여태 이 보고서만 전용 출력이 없어서, 화면의 표를 긁어 **CSV** 로 뱉었다(lib/export.js).
 * 그러니 서식도 합계도 없고, 신고서에 옮겨 적을 순서로도 서 있지 않았다.
 * 세무사에게 넘기거나 홈택스에 옮겨 적는 문서인데 그 모양이면 결국 손으로 다시 만든다.
 *
 * ── 이 문서의 순서는 **신고서를 따른다** ──
 * 요약 시트가 신고서 칸 순서(과세표준·매출세액 → 매입세액 → 납부할 세액)로 서고,
 * 매출·매입 명세가 그 근거로 뒤에 붙는다. 화면에서 보는 숫자와 같아야 하므로
 * 집계는 화면과 같은 소스(invoices)를 쓴다.
 *
 * ⚠ 과세유형(tax_type)을 **반드시 갈라 적는다.** 과세·영세·면세를 한 줄로 합치면
 *   과세표준이 부풀고, 그대로 신고하면 틀린 신고가 된다. 영세율은 세액이 0이지만
 *   과세표준에는 들어가고, 면세는 아예 부가세 신고 대상이 아니다.
 */
const { newBook, blockSheet, sheet, guideSheet, sendBook } = require('./xlsxBook')
const { vatPeriodOf } = require('./vatPeriod')

const num = (v) => Number(v) || 0
const day = (v) => String(v || '').slice(0, 10)

/** 과세유형 정규화 — 옛 데이터는 비어 있을 수 있다. 비면 과세로 본다(세액이 붙어 있다). */
const taxTypeOf = (r) => {
  const t = String(r.tax_type || '').trim()
  return t === '영세' || t === '면세' ? t : '과세'
}

/**
 * @param rows  invoices 행(+ vendor_name) — routes/invoices.js summary/vat 와 같은 소스
 * @param opt   { quarter, year }
 */
function vatPack(rows, { quarter, year }) {
  const period = vatPeriodOf(quarter, year)
  const of = (kind) => rows.filter(r => r.kind === kind)

  const bucket = (list) => {
    const out = { 과세: { supply: 0, vat: 0, n: 0 }, 영세: { supply: 0, vat: 0, n: 0 }, 면세: { supply: 0, vat: 0, n: 0 } }
    for (const r of list) {
      const b = out[taxTypeOf(r)]
      b.supply += num(r.supply_amount)
      b.vat += num(r.vat_amount)
      b.n += 1
    }
    return out
  }

  const sales = bucket(of('issued'))
  const purchase = bucket(of('received'))
  /* 납부세액 = 매출세액 − 매입세액. 면세는 신고 대상이 아니므로 세액 계산에서 빠진다
     (면세 청구서에는 세액이 0이라 더해도 값은 같지만, 뜻이 다르니 명세에서 구분해 보여준다). */
  const salesVat = sales.과세.vat + sales.영세.vat
  const purchaseVat = purchase.과세.vat + purchase.영세.vat

  return { period, sales, purchase, salesVat, purchaseVat, netVat: salesVat - purchaseVat, rows }
}

/** 명세 시트의 열 — 화면 표와 같은 순서로 둔다(보이는 것과 받는 것이 다르면 대조가 안 된다) */
const DETAIL_COLUMNS = [
  { header: '발행일', key: 'date', width: 12 },
  { header: '청구서번호', key: 'no', width: 16 },
  { header: '거래처', key: 'vendor', width: 26 },
  { header: '과세유형', key: 'taxType', width: 10 },
  { header: '공급가액', key: 'supply', width: 15, money: true },
  { header: '세액', key: 'vat', width: 13, money: true },
  { header: '합계', key: 'total', width: 15, money: true },
]

/* sheet() 는 **값 배열**을 받는다(열 순서대로). 객체로 넘기면 빈 칸이 된다 —
   DETAIL_COLUMNS 의 순서와 여기가 어긋나지 않게 한 곳에서 만든다. */
const detailRows = (list) => list
  .slice()
  .sort((a, b) => day(a.issued_at).localeCompare(day(b.issued_at)))
  .map(r => [
    day(r.issued_at),
    r.invoice_no || '',
    r.vendor_name || '',
    taxTypeOf(r),
    num(r.supply_amount),
    num(r.vat_amount),
    num(r.total_amount),
  ])

const sumCol = (rows, i) => rows.reduce((s, r) => s + (Number(r[i]) || 0), 0)

function buildVatWorkbook(pack, { quarter, year }) {
  const { period, sales, purchase, salesVat, purchaseVat, netVat } = pack
  const wb = newBook()

  const S = (...cells) => ({ kind: 'section', cells })
  const H = (...cells) => ({ kind: 'head', cells })
  const D = (...cells) => ({ kind: 'data', cells })
  const T = (...cells) => ({ kind: 'total', cells })
  const N = (text) => ({ kind: 'note', cells: [text] })
  const B = () => ({ kind: 'blank' })

  /* ── 1장: 신고 요약 — 신고서 칸 순서 그대로 ── */
  const money = [1, 2, 3]   // 건수·공급가액·세액 열
  const line = (label, b) => D(label, b.n, b.supply, b.vat)

  blockSheet(wb, '신고 요약', {
    title: `부가가치세 신고 자료 (${period.label})`,
    sub: `과세기간 ${period.from} ~ ${period.to} · 신고기한 ${period.due}`,
    widths: [26, 10, 18, 16],
    money,
    rows: [
      S('1. 과세표준 및 매출세액'),
      H('구분', '매수', '공급가액', '세액'),
      line('과세 (세금계산서 발급분)', sales.과세),
      line('영세율', sales.영세),
      T('매출 합계', sales.과세.n + sales.영세.n, sales.과세.supply + sales.영세.supply, salesVat),
      B(),
      S('2. 매입세액'),
      H('구분', '매수', '공급가액', '세액'),
      line('과세 (세금계산서 수취분)', purchase.과세),
      line('영세율', purchase.영세),
      T('매입 합계', purchase.과세.n + purchase.영세.n, purchase.과세.supply + purchase.영세.supply, purchaseVat),
      B(),
      S('3. 납부(환급)할 세액'),
      H('구분', '', '', '세액'),
      D('매출세액', '', '', salesVat),
      D('매입세액', '', '', purchaseVat),
      T(netVat >= 0 ? '납부할 세액' : '환급받을 세액', '', '', Math.abs(netVat)),
      B(),
      /* 면세는 부가세 신고 대상이 아니다. 그런데 장부에는 함께 있으므로,
         "왜 합계가 장부와 다르지"를 막기 위해 여기서 따로 밝힌다. */
      ...(sales.면세.n || purchase.면세.n ? [
        S('참고 — 면세 (신고 대상 아님)'),
        H('구분', '매수', '공급가액', '세액'),
        line('면세 매출', sales.면세),
        line('면세 매입', purchase.면세),
      ] : []),
      B(),
      N('※ 이 자료는 장부에 등록된 청구서를 집계한 것입니다. 홈택스 신고 전 세금계산서 발급·수취 내역과 대조하세요.'),
      N('※ 영세율 매출은 세액이 0이지만 과세표준에는 포함됩니다. 면세는 부가세 신고 대상이 아닙니다.'),
    ],
  })

  /* ── 2·3장: 명세 — 요약의 근거 ── */
  const salesDetail = detailRows(pack.rows.filter(r => r.kind === 'issued'))
  const purchaseDetail = detailRows(pack.rows.filter(r => r.kind === 'received'))
  const addDetail = (name, rows) => sheet(wb, name, {
    title: name,
    sub: `과세기간 ${period.from} ~ ${period.to}`,
    columns: DETAIL_COLUMNS,
    rows,
    // 합계 줄도 값 배열 — 발행일 칸에 '합계', 금액 세 칸에 각각의 합
    totals: rows.length ? ['합계', '', '', '', sumCol(rows, 4), sumCol(rows, 5), sumCol(rows, 6)] : null,
    freezeCols: 2,
  })
  addDetail('매출 명세', salesDetail)
  addDetail('매입 명세', purchaseDetail)

  guideSheet(wb, [
    '이 파일은 도니도라에서 만든 부가가치세 신고 참고 자료입니다.',
    '',
    `과세기간: ${period.from} ~ ${period.to} (${period.label})`,
    `신고기한: ${period.due}`,
    '',
    '· [신고 요약] 신고서 칸 순서대로 과세표준·매출세액 → 매입세액 → 납부(환급)할 세액을 정리했습니다.',
    '· [매출 명세] · [매입 명세] 요약의 근거가 되는 청구서 목록입니다.',
    '',
    '주의',
    '· 장부에 등록된 청구서만 집계합니다. 홈택스의 세금계산서 발급·수취 내역과 반드시 대조하세요.',
    '· 영세율은 세액이 0이지만 과세표준에 포함됩니다.',
    '· 면세는 부가세 신고 대상이 아니어서 요약의 합계에서 빠져 있습니다(참고 구획에 따로 적었습니다).',
  ])

  return wb
}

module.exports = { vatPack, buildVatWorkbook, sendBook }
