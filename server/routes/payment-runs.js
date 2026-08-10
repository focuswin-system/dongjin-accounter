const { Router } = require('express')

const router = Router()

/* 매입처 결제 내역 — 월별 일괄이체 명단.
 *
 * 실제 고객사(태영엔지니어링)가 매달 만드는 서류를 그대로 대체한다:
 *   "2026년 6월분 매입처 결제 내역 / 경남은행 창원영업부 207-0077-7078-00 / 합계 7,712,253"
 *   31개 업체 × (업체명·은행·계좌번호·예금주·이체금액·비고)
 * 지금은 엑셀로 손으로 만든다(받은 파일의 순번이 13→15→18→14 로 꼬여 있었다).
 *
 * 우리는 미지급금을 이미 갖고 있으므로 **모으는 일은 끝나 있다.** 뽑아주기만 하면 된다.
 *
 * ⚠ 조회 전용이다. 저장하지 않고, 아무것도 바꾸지 않는다.
 *   실제 지급 처리는 청구서 일괄 정산(/invoices/bulk/settle)이 맡는다 —
 *   돈이 나가는 길을 둘로 만들면 어느 쪽으로 나갔는지 나중에 못 짚는다.
 */
router.get('/', async (req, res, next) => {
  try {
    /* 기준월. 그 달 **말일까지 내야 할 것**을 모은다 — 기한이 그 달인 것만 세면
       연체분이 빠져서, 정작 먼저 내야 할 돈이 명단에서 사라진다. */
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null
    if (!month) return res.status(400).json({ error: '기준월을 YYYY-MM 으로 지정해주세요' })
    const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()
    const until = `${month}-${String(lastDay).padStart(2, '0')}`

    const [rows] = await req.db.execute(
      `SELECT i.id, i.invoice_no, i.issued_at, i.due_at, i.total_amount, i.memo,
              v.id AS vendor_id, v.name AS vendor_name,
              va.bank_name, va.account_no, va.holder, v.pay_account,
              COALESCE((SELECT SUM(m.amount) FROM invoice_matches m WHERE m.invoice_id = i.id), 0) AS paid
         FROM invoices i
         LEFT JOIN vendors v ON i.vendor_id = v.id
         /* 거래처마다 계좌가 여럿이라(실물 명세서에 셋이 적혀 있다) **주 계좌**를 집는다.
            매달 31곳을 하나씩 고르게 할 수는 없다 — 다를 때만 거래처에서 주 계좌를 바꾼다. */
         LEFT JOIN vendor_accounts va ON va.vendor_id = v.id AND va.is_primary = 1
        WHERE i.kind = 'received'
          AND (i.due_at IS NULL OR i.due_at <= ?)
        ORDER BY v.name, i.due_at, i.issued_at`, [until])

    /* 남은 금액이 있는 것만. 완납된 청구서는 낼 돈이 없다.
       기한이 비어 있는 건 뺄 수 없다 — 기한을 안 적었을 뿐 내야 할 돈이다(그래서 위 조건에 포함). */
    const open = rows
      .map(r => ({ ...r, remain: Number(r.total_amount) - Number(r.paid) }))
      .filter(r => r.remain > 0)

    const byVendor = new Map()
    for (const r of open) {
      const key = r.vendor_id || `__none__${r.vendor_name || ''}`
      if (!byVendor.has(key)) {
        byVendor.set(key, {
          vendor_id: r.vendor_id || null,
          vendor_name: r.vendor_name || '(거래처 미지정)',
          bank_name: r.bank_name || '', bank_account: r.account_no || '',
          // 예금주가 비면 상호로 대신한다. 개인 명의 계좌면 이게 틀리므로 화면이 경고한다.
          account_holder: r.holder || '',
          pay_account_legacy: r.pay_account || '',
          amount: 0, count: 0, invoices: [], overdue: 0,
        })
      }
      const g = byVendor.get(key)
      g.amount += r.remain
      g.count += 1
      if (r.due_at && r.due_at < `${month}-01`) g.overdue += r.remain
      g.invoices.push({
        id: r.id, invoice_no: r.invoice_no, issued_at: r.issued_at, due_at: r.due_at,
        amount: r.remain, memo: r.memo || '',
      })
    }

    /* 금액 큰 순으로 세운다. 받은 실물은 순번이 뒤섞여 있었는데(엑셀 정렬 사고),
       기계가 만들면 그럴 일이 없고 큰 금액부터 보이는 편이 확인하기 쉽다. */
    const vendors = [...byVendor.values()].sort((a, b) => b.amount - a.amount)
    const total = vendors.reduce((s, v) => s + v.amount, 0)
    // 계좌를 모르면 이체 자체를 못 한다 — 이 명단의 유일한 치명적 결함이라 따로 센다
    const missingBank = vendors.filter(v => !v.bank_account).length

    res.json({ month, until, total, count: vendors.length, missingBank, vendors })
  } catch (e) { next(e) }
})

module.exports = router
