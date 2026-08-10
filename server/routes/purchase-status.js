const { Router } = require('express')
const { monthRange, weeksOf } = require('../lib/period')

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

    const [rows] = await req.db.execute(
      `SELECT i.issued_at, i.invoice_no, i.tax_type, v.name AS vendor_name,
              l.name, l.spec, l.unit, l.qty, l.weight, l.price_basis,
              l.unit_price, l.amount, l.vat, l.note
         FROM invoice_lines l
         JOIN invoices i ON i.id = l.invoice_id
         LEFT JOIN vendors v ON i.vendor_id = v.id
        WHERE i.kind = ? AND i.issued_at BETWEEN ? AND ?
        ORDER BY i.issued_at, v.name, l.sort_order`, [kind, from, to])

    /* 세액이 NULL 이면 '아직 안 정했다' — 청구서 과세유형대로 채운다.
       0 은 '면세라서 0'이라 그대로 둔다(실물 표의 근조화환이 그렇다). */
    const lines = rows.map(r => {
      const amount = Number(r.amount) || 0
      const vat = r.vat === null || r.vat === undefined
        ? ((r.tax_type || '과세') === '과세' ? Math.round(amount * 0.1) : 0)
        : Number(r.vat) || 0
      return {
        date: r.issued_at, vendor: r.vendor_name || '(거래처 미지정)', invoice_no: r.invoice_no,
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

    res.json({
      month, kind, from, to, closingDay, weekStart, weeks,
      amount: lines.reduce((s, l) => s + l.amount, 0),
      vat: lines.reduce((s, l) => s + l.vat, 0),
      total: lines.reduce((s, l) => s + l.total, 0),
      count: lines.length,
    })
  } catch (e) { next(e) }
})

module.exports = router
