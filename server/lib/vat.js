/* 부가세 단일 규칙 — 세액을 해석하는 곳은 여기 하나.
 *
 * 과세유형 3종
 *   과세  공급가 × 10% = 세액.
 *   면세  세액 없음. 과세표준에도 안 들어간다(부가세 신고서의 '면세수입금액'은 별도 참고란).
 *   영세  세율 0%인 '과세'거래(수출·해외용역 등). 세액은 0이지만 공급가는 과세표준에 들어간다.
 *         → 세액이 0이라는 사실만으로 면세와 구분할 수 없어서, 유형 값을 따로 저장한다.
 *
 * 매입세액 불공제(vat_deductible=0): 접대비·비영업용 승용차 등. 세액은 기록하되 공제 집계에서 뺀다.
 */

const TAX_TYPES = ['과세', '면세', '영세']
const num = (v) => Number(String(v ?? '').replace(/[^0-9-]/g, '')) || 0

/** 과세유형 정규화. 모르는 값·빈 값은 '과세'로 본다(종전 동작과 같다). */
function normalizeTaxType(v) {
  return TAX_TYPES.includes(v) ? v : '과세'
}

/**
 * 거래 body → 저장할 부가세 필드.
 * 화면이 공급가·세액을 보내면 그대로 믿고, 안 보내면 합계에서 역산한다
 * (구버전 화면·스크립트가 amount만 보내도 세액이 비지 않게).
 */
function vatFields({ amount, supply_amount, vat_amount, tax_type, vat_deductible }) {
  const total = num(amount)
  const type = normalizeTaxType(tax_type)
  const sent = supply_amount != null && supply_amount !== ''
  let supply, vat
  if (sent) {
    supply = num(supply_amount)
    vat = vat_amount != null && vat_amount !== '' ? num(vat_amount) : total - supply
  } else if (type === '과세') {
    supply = Math.round(total / 1.1)   // 합계 = 공급가 × 1.1
    vat = total - supply
  } else {
    supply = total                      // 면세·영세는 세액이 없다
    vat = 0
  }
  if (type !== '과세') vat = 0           // 유형이 우선 — 면세·영세에 세액이 실려 오면 버린다
  return {
    supply_amount: supply,
    vat_amount: vat,
    tax_type: type,
    vat_deductible: vat_deductible === 0 || vat_deductible === false || vat_deductible === '0' ? 0 : 1,
  }
}

/* ── 계약의 과세유형 ──
 * contracts.vat_mode: taxable(과세) / exempt(면세) / zero(영세).
 * 청구서를 만드는 모든 지점이 이 두 함수만 쓰게 해서, 한 곳에서 0.1을 빠뜨리는 사고를 막는다. */
const CONTRACT_VAT_MODES = ['taxable', 'exempt', 'zero']

/** 계약 vat_mode → 부가세율. 면세·영세 모두 세액 0이지만 뜻이 다르다(과세표준 포함 여부). */
const vatRateOf = (vatMode) => (vatMode === 'exempt' || vatMode === 'zero' ? 0 : 0.1)

/** 계약 vat_mode → 청구서에 남길 과세유형 라벨 */
const taxTypeOfMode = (vatMode) => (vatMode === 'exempt' ? '면세' : vatMode === 'zero' ? '영세' : '과세')

/** 공급가액 → 세액 (계약 vat_mode 기준) */
const vatOf = (supply, vatMode) => Math.round((Number(supply) || 0) * vatRateOf(vatMode))

module.exports = { TAX_TYPES, normalizeTaxType, vatFields, CONTRACT_VAT_MODES, vatRateOf, taxTypeOfMode, vatOf }
