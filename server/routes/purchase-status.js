const { Router } = require('express')
const { monthRange, weeksOf } = require('../lib/period')
const { VAT_RATE } = require('../lib/vat')

const router = Router()

/* 주별 총 매입(매출) 현황 — 품목 단위로 기간을 가로지른다.
 *
 * 실물 그대로다:
 *   "※ 주별 총 매입 현황 (매월 25일 마감)"
 *   순번·일자·거래처명·명칭·규격·수량·단위·단가·금액·부가세·계·비고
 *   주마다 소계, 아래에 "7월 총 합계"
 *
 * ⚠ 세는 것은 **청구서 품목(invoice_lines)** 이지 거래(입출금)가 아니다.
 *   실물 표의 각 줄은 전부 세금계산서를 받는 매입이다(통신요금·기장수수료 포함).
 *   거래로 세면 한 번에 여러 건을 결제한 카드값이 한 줄로 뭉쳐 품목이 사라진다.
 *
 * 날짜 축은 **발행일(issued_at)** 이다 — 그 날 무엇을 샀는가가 이 표의 물음이고,
 * 언제 냈는가(지급일)는 결제내역서가 답한다.
 */
router.get('/', async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null
    if (!month) return res.status(400).json({ error: '기준월을 YYYY-MM 으로 지정해주세요' })
    const kind = req.query.kind === 'issued' ? 'issued' : 'received'   // 기본 매입

    // 회사가 정한 마감일·주 시작요일을 따른다(환경설정 › 회사 정보)
    const [[cfg]] = await req.db.execute(
      "SELECT closing_day, week_start_day FROM company_info WHERE id = 'main'")
    const closingDay = cfg ? Number(cfg.closing_day) || 0 : 0
    const weekStart = cfg ? Number(cfg.week_start_day) : 1

    const { from, to } = monthRange(month, closingDay)

    /* ⚠ **거래명세서 한 장의 순서를 흐뜨리지 않는다.**
     *
     * 예전엔 `ORDER BY i.issued_at, v.name, l.sort_order` 였다. 거래처 이름으로 한 번 더
     * 섞기 때문에, 같은 날 여러 거래처의 명세서가 있으면 **한 장의 줄들이 갈라져** 흩어졌다.
     * 담당자는 거래명세서 한 장을 그대로 옮겨 적는데(품목 순서가 곧 종이의 순서다),
     * 화면이 다시 정렬해 버리면 종이와 화면을 나란히 놓고 대조할 수가 없다.
     * 실사용 문의: "품목은 담당자가 거래명세서 단위로 입력하는데 그게 흐트러져 버린다."
     *
     * 청구서(=명세서 한 장) 단위를 지키고, 그 안에서는 **입력 순서**(sort_order)를 지킨다.
     * 거래처별로 모아 보고 싶으면 화면에서 거래처를 골라 거르면 된다 — 정렬로 뭉개면
     * 원래 순서를 되돌릴 방법이 없다.
     *
     * 기간 축도 고를 수 있다. 제조·유통은 **물건이 오간 날**로 이 표를 본다(delivery).
     */
    const axis = req.query.date_axis === 'delivery' ? 'delivery' : 'issued'
    const where = axis === 'delivery'
      ? "l.delivery_date IS NOT NULL AND l.delivery_date <> '' AND l.delivery_date BETWEEN ? AND ?"
      : 'i.issued_at BETWEEN ? AND ?'
    const order = axis === 'delivery'
      ? 'l.delivery_date, i.invoice_no, l.sort_order'
      : 'i.issued_at, i.invoice_no, l.sort_order'
    const [rows] = await req.db.execute(
      `SELECT i.issued_at, i.invoice_no, i.tax_type, v.name AS vendor_name,
              l.name, l.spec, l.unit, l.qty, l.weight, l.price_basis,
              l.unit_price, l.amount, l.vat, l.note, l.delivery_date
         FROM invoice_lines l
         JOIN invoices i ON i.id = l.invoice_id
         LEFT JOIN vendors v ON i.vendor_id = v.id
        WHERE i.kind = ? AND ${where}
        ORDER BY ${order}`, [kind, from, to])

    /* 세액이 NULL 이면 '아직 안 정했다' — 청구서 과세유형대로 채운다.
       0 은 '면세라서 0'이라 그대로 둔다(실물 표의 근조화환이 그렇다). */
    const lines = rows.map(r => {
      const amount = Number(r.amount) || 0
      const vat = r.vat === null || r.vat === undefined
        ? ((r.tax_type || '과세') === '과세' ? Math.round(amount * VAT_RATE) : 0)
        : Number(r.vat) || 0
      return {
        // 표의 '날짜'는 고른 축을 따른다 — 납품일로 보는데 발행일이 찍히면 축이 어긋난다
        date: axis === 'delivery' ? String(r.delivery_date).slice(0, 10) : r.issued_at,
        issued_at: r.issued_at,
        delivery_date: r.delivery_date ? String(r.delivery_date).slice(0, 10) : null,
        vendor: r.vendor_name || '(거래처 미지정)', invoice_no: r.invoice_no,
        name: r.name, spec: r.spec || '', unit: r.unit || '',
        // 중량 기준 줄은 수량이 아니라 중량이 곱해진 값이다 — 표에 그대로 적는다
        qty: r.price_basis === 'weight' ? Number(r.weight) || 0 : Number(r.qty) || 0,
        basis: r.price_basis === 'weight' ? 'weight' : 'qty',
        unit_price: Number(r.unit_price) || 0,
        amount, vat, total: amount + vat, note: r.note || '',
      }
    })

    // 주별로 담는다. 빈 주도 남긴다 — 빠진 주가 있으면 "왜 없지"부터 묻게 된다.
    const weeks = weeksOf(from, to, weekStart).map(w => {
      const items = lines.filter(l => l.date >= w.from && l.date <= w.to)
      return {
        ...w, items,
        amount: items.reduce((s, l) => s + l.amount, 0),
        vat: items.reduce((s, l) => s + l.vat, 0),
        total: items.reduce((s, l) => s + l.total, 0),
      }
    })

    /* 연 누계 — "그 해 1월 1일부터 이 달까지 얼마나 샀나".
       월 합계만으로는 한 해의 흐름을 못 본다(세무사에게 넘길 때도 누계를 함께 묻는다).
       ⚠ 시작점은 1월 1일이 아니라 **회계 1월의 시작일**이다 — 마감일이 25일인 회사의
         1월분은 전년 12월 26일부터다. 달마다 쓰는 기준을 여기서만 바꾸면 누계가 안 맞는다.
       줄을 다시 읽지 않고 합계만 센다(연초부터면 줄이 수천 개가 된다).
       세액이 NULL 인 줄은 위 매핑과 **같은 규칙**으로 채운다 — 다르면 월 합계와 누계가 어긋난다. */
    const yearFrom = monthRange(`${month.slice(0, 4)}-01`, closingDay).from
    /* ⚠ 합계를 SQL 로 세지 않는다. 세액이 NULL 인 줄을 채우는 반올림이 **SQL 과 JS 에서 다르다** —
       MySQL 의 곱셈은 DECIMAL(정확)이고 JS 는 부동소수라, amount 가 1,234,565 인 줄에서
       SQL 은 123,457, JS 는 123,456 이 나온다. 그렇게 세면 같은 달인데도 월 합계와 누계가
       1원 어긋나고(실제로 그랬다), 보는 사람은 어느 쪽이 맞는지 알 길이 없다.
       그래서 줄을 받아 **위와 똑같은 식**으로 센다. 열 세 개만 읽으므로 한 해치라도 가볍다. */
    const [yRows] = await req.db.execute(
      `SELECT l.amount, l.vat, i.tax_type
         FROM invoice_lines l
         JOIN invoices i ON i.id = l.invoice_id
        WHERE i.kind = ? AND ${where}`, [kind, yearFrom, to])
    let ytdAmount = 0, ytdVat = 0
    for (const r of yRows) {
      const amount = Number(r.amount) || 0
      ytdAmount += amount
      ytdVat += r.vat === null || r.vat === undefined
        ? ((r.tax_type || '과세') === '과세' ? Math.round(amount * VAT_RATE) : 0)
        : Number(r.vat) || 0
    }

    res.json({
      month, kind, from, to, closingDay, weekStart, weeks, dateAxis: axis,
      // 연 누계 — 화면이 '월간으로 뽑을 때' 아래에 한 줄 더 낸다
      ytd: { from: yearFrom, to, amount: ytdAmount, vat: ytdVat, total: ytdAmount + ytdVat },
      amount: lines.reduce((s, l) => s + l.amount, 0),
      vat: lines.reduce((s, l) => s + l.vat, 0),
      total: lines.reduce((s, l) => s + l.total, 0),
      count: lines.length,
    })
  } catch (e) { next(e) }
})

module.exports = router
