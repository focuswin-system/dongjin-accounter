/**
 * 부가세 집계 — **한 곳**.
 *
 * ── 왜 모으는가 ──
 * 같은 분기의 부가세가 세 화면에서 서로 달랐다.
 *
 *   세무관리 › 부가세      청구서 + **직접 입력 거래**   (카드·현금 매입세액 포함)
 *   보고서 › 부가세 신고자료  청구서만                     ← 빠짐
 *   엑셀 reports/vat.xlsx   청구서만                     ← 빠짐
 *
 * routes/tax.js 가 "이게 빠져 있어서 카드·현금 매입세액이 통째로 누락됐다"며 고친 것이
 * **화면 쪽만**이었다. 정작 세무사에게 넘기고 홈택스에 옮겨 적는 것은 안 고쳐진 쪽이다.
 *
 * 그래서 계산을 여기 한 곳에 두고 셋이 나눠 쓴다.
 *
 * ── 집계에 들어가는 것 ──
 *   1) 청구서(invoices)의 vat_amount — 발행일 기준
 *   2) 청구서를 거치지 않은 **직접 입력 거래**의 vat_amount — 거래일 기준
 *      · invoice_id 가 있는 거래는 청구서 정산분이라 1)에 이미 있다 → 반드시 제외(이중계상)
 *      · vat_amount 가 NULL 인 옛 거래는 세액을 모르므로 안 센다
 *      · 매입은 불공제(vat_deductible=0)를 뺀다 — 그래야 실제 공제세액이다
 *      · 증빙유형이 불공제(간이영수증·거래명세서 등)면 거래 플래그와 무관하게 공제 대상 아님
 *      · 증빙유형을 안 적은 거래는 종전대로 공제로 본다(과거 데이터를 갑자기 불공제로 만들지 않는다)
 *
 * ⚠ 멀티테넌트 — db 는 반드시 인자로 받는다. 기본값을 두면 조용히 남의 회사를 읽는다.
 */

/** 분기별 청구서 세액 */
async function invoiceVat(db, year) {
  const [rows] = await db.execute(
    `SELECT QUARTER(issued_at) AS q,
            SUM(CASE WHEN kind='issued'   THEN vat_amount ELSE 0 END) AS sales_vat,
            SUM(CASE WHEN kind='received' THEN vat_amount ELSE 0 END) AS purchase_vat
       FROM invoices
      WHERE YEAR(issued_at) = ?
      GROUP BY QUARTER(issued_at)`, [year])
  return rows
}

/** 분기별 직접 입력 거래 세액 (청구서를 안 거친 것) */
async function directVat(db, year) {
  const [rows] = await db.execute(
    `SELECT QUARTER(t.date) AS q,
            SUM(CASE WHEN t.kind='income'  THEN t.vat_amount ELSE 0 END) AS sales_vat,
            SUM(CASE WHEN t.kind='expense' AND t.vat_deductible = 1 AND COALESCE(ev.deductible, 1) = 1
                     THEN t.vat_amount ELSE 0 END) AS purchase_vat,
            SUM(CASE WHEN t.kind='expense' AND (t.vat_deductible = 0 OR COALESCE(ev.deductible, 1) = 0)
                     THEN t.vat_amount ELSE 0 END) AS non_deductible_vat
       FROM transactions t
       LEFT JOIN (
         SELECT name, MIN(deductible) AS deductible FROM ref_items WHERE type = 'evidence_type' GROUP BY name
       ) ev ON ev.name = t.evid_type
      WHERE YEAR(t.date) = ? AND t.invoice_id IS NULL AND t.vat_amount IS NOT NULL
      GROUP BY QUARTER(t.date)`, [year])
  return rows
}

/**
 * 분기별 세액 합계 — 청구서 + 직접 입력 거래.
 * @returns { [분기]: { salesVat, purchaseVat, salesInvoice, salesDirect, purchaseInvoice, purchaseDirect, nonDeductible } }
 */
async function vatByQuarter(db, year) {
  const [inv, dir] = await Promise.all([invoiceVat(db, year), directVat(db, year)])
  const invBy = Object.fromEntries(inv.map(r => [Number(r.q), r]))
  const dirBy = Object.fromEntries(dir.map(r => [Number(r.q), r]))
  const out = {}
  for (const q of [1, 2, 3, 4]) {
    const a = invBy[q] || {}
    const t = dirBy[q] || {}
    out[q] = {
      salesVat:        Number(a.sales_vat || 0) + Number(t.sales_vat || 0),
      purchaseVat:     Number(a.purchase_vat || 0) + Number(t.purchase_vat || 0),
      salesInvoice:    Number(a.sales_vat || 0),
      salesDirect:     Number(t.sales_vat || 0),
      purchaseInvoice: Number(a.purchase_vat || 0),
      purchaseDirect:  Number(t.purchase_vat || 0),
      nonDeductible:   Number(t.non_deductible_vat || 0),
    }
  }
  return out
}

/**
 * 한 분기의 세액 — 보고서·엑셀이 쓴다.
 * @param quarter 1~4
 */
async function vatOfQuarter(db, year, quarter) {
  const all = await vatByQuarter(db, year)
  return all[Number(quarter)] || {
    salesVat: 0, purchaseVat: 0, salesInvoice: 0, salesDirect: 0,
    purchaseInvoice: 0, purchaseDirect: 0, nonDeductible: 0,
  }
}

module.exports = { invoiceVat, directVat, vatByQuarter, vatOfQuarter }
