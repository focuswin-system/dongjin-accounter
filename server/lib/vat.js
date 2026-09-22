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

/**
 * 부가세율 — **여기 하나만 고치면 된다.**
 * 이 파일 안에서만도 `0.1` 이 세 군데(vatRateOf · RECUR_VAT · 합계 역산) 있었고,
 * 바깥으로도 서버 2곳·화면 9곳에 흩어져 있었다. 세율이 바뀌는 일은 드물지만
 * 흩어져 있으면 바뀔 때 한두 곳을 반드시 빠뜨리고, 빠뜨린 곳은 조용히 틀린 세액을 낸다.
 * ⚠ 화면 쪽 짝은 src/lib/vatRate.js 다(빌드 경계가 달라 한 파일을 못 나눠 쓴다).
 *   둘 중 하나를 고치면 나머지도 같이 고친다.
 */
const VAT_RATE = 0.1
/* 금액 파싱 — **소수점을 삼키면 안 된다.**
 * 예전엔 숫자·부호만 남겨서 `110000.7` 이 `"1100007"` → 110만 7원이 됐다(10배).
 * amount 는 반올림해 11만원으로 저장되는데 공급가·세액만 10배로 남아, 합계와 안 맞는
 * 거래가 오류 없이 저장됐다. 규칙은 lib/money.js·src/lib/hometax.js 와 같다. */
const num = (v) => {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : 0
  let t = String(v).trim()
  const paren = /^\(.*\)$/.test(t)            // 회계형식 (1,100) = 음수
  t = t.replace(/[^0-9.-]/g, '')
  if (!t || t === '-' || t === '.') return 0
  if ((t.match(/\./g) || []).length > 1) t = t.replace(/\./g, '')   // 점이 여럿이면 천단위 구분자
  const n = parseFloat(t)
  if (!Number.isFinite(n)) return 0
  return Math.round(paren ? -Math.abs(n) : n)
}

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
    supply = Math.round(total / (1 + VAT_RATE))   // 합계 = 공급가 × (1 + 세율)
    vat = total - supply
  } else {
    supply = total                      // 면세·영세는 세액이 없다
    vat = 0
  }
  if (type !== '과세') vat = 0           // 유형이 우선 — 면세·영세에 세액이 실려 오면 버린다

  /* ── 보낸 값을 그대로 믿지 않는다 ──
   *
   * 예전엔 공급가·세액을 **검증 없이** 저장했다. amount 는 amountError 가 보는데
   * 이 둘은 아무도 안 봤다. 그래서 이런 것이 200 으로 통과했다:
   *   · 11만원 거래에 세액 9,999,999  → 그 분기가 납부에서 환급으로 뒤집혔다
   *   · 공급가 −100,000            → 세액이 금액보다 커졌다
   *   · 카드 명세서 열을 잘못 이어 공급가·세액이 둘 다 합계와 같아짐
   * 화면이 막아도 엑셀·카드 업로드·API 가 여기를 지난다 — **서버가 최종 판정**이다.
   *
   * 고치지 않고 **버린다**(역산으로 되돌린다). 막아서 통째로 거절하면 수백 줄짜리
   * 업로드가 한 줄 때문에 전부 못 들어가고, 사람은 어느 줄인지도 모른다.
   * 합계는 이미 amountError 가 본 값이라 역산 결과는 언제나 말이 된다.
   */
  const bad = supply < 0 || vat < 0 || supply + vat !== total
  if (bad) {
    if (type === '과세') { supply = Math.round(total / (1 + VAT_RATE)); vat = total - supply }
    else { supply = total; vat = 0 }
  }

  return {
    supply_amount: supply,
    vat_amount: vat,
    tax_type: type,
    vat_deductible: vat_deductible === 0 || vat_deductible === false || vat_deductible === '0' ? 0 : 1,
  }
}

/* ── 주문의 과세유형 ──
 * contracts.vat_mode: taxable(과세) / exempt(면세) / zero(영세).
 * 청구서를 만드는 모든 지점이 이 두 함수만 쓰게 해서, 한 곳에서 0.1을 빠뜨리는 사고를 막는다. */
const CONTRACT_VAT_MODES = ['taxable', 'exempt', 'zero']

/** 주문 vat_mode → 부가세율. 면세·영세 모두 세액 0이지만 뜻이 다르다(과세표준 포함 여부). */
const vatRateOf = (vatMode) => (vatMode === 'exempt' || vatMode === 'zero' ? 0 : VAT_RATE)

/** 주문 vat_mode → 청구서에 남길 과세유형 라벨 */
const taxTypeOfMode = (vatMode) => (vatMode === 'exempt' ? '면세' : vatMode === 'zero' ? '영세' : '과세')

/** 공급가액 → 세액 (주문 vat_mode 기준) */
const vatOf = (supply, vatMode) => Math.round((Number(supply) || 0) * vatRateOf(vatMode))

/* (옛 정기 규칙 전용 recurFromSupply·recurFromTotal·effRecurVatMode·modeFromCatVat 는 반복거래로 바뀌며 걷었다.
   반복거래의 금액·부가세는 lib/repeat.js amountsOf 가 VAT_RATE 로 계산한다.) */
module.exports = {
  TAX_TYPES, normalizeTaxType, vatFields, CONTRACT_VAT_MODES, vatRateOf, taxTypeOfMode, vatOf, VAT_RATE }
