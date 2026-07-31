/**
 * 금액 문자열 → 정수(원). 앱 전역의 단일 규칙.
 *
 * ── 왜 공용으로 두는가 ──
 * 같은 함수가 5곳에 복사돼 있었고(hometax·finance·invoices·ref-items·savings),
 * 전부 같은 결함을 갖고 있었다:
 *
 *   parseInt(String(v).replace(/[^0-9-]/g, ''), 10)
 *
 * 이 방식은 숫자와 부호만 남기고 **소수점을 지운다.**
 *   '1,100,000.00' → '110000000' → 1억 1천만원 (110만원의 **100배**)
 *   '(1,100,000)'  → '1100000'   → 회계형식 음수가 **양수**로
 *
 * 엑셀은 서식이 적용된 문자열을 그대로 준다(xlsx-import 가 raw:false 로 읽는다).
 * 소수점 2자리 서식이나 회계 형식은 실무에서 흔하다. 그리고 공급가·세액·합계가
 * 똑같이 100배가 되므로 `공급가+세액 ≠ 합계` 같은 기존 검증도 통과한다 —
 * **조용히 100배 틀린 청구서**가 만들어진다.
 */

/**
 * 금액 파싱. 소수점은 반올림하고, 회계형식 괄호는 음수로 읽는다.
 * @param {*} v '1,100,000.00' · '(1,100,000)' · '₩1,100,000' · 1100000 · null
 * @returns {number} 정수. 못 읽으면 0.
 */
function moneyOf(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : 0

  let s = String(v).trim()
  // 회계 형식 (1,100,000) = 음수. 지우기 전에 판정해야 부호가 산다.
  const paren = /^\(.*\)$/.test(s)
  // 숫자·부호·소수점만 남긴다(통화기호·콤마·공백·원 제거)
  s = s.replace(/[^0-9.-]/g, '')
  if (!s || s === '-' || s === '.') return 0
  /* 점이 여러 개면 전부 천단위 구분자다(1.100.000 유럽식). 한국 표기에서 소수점은 하나뿐이고
   * 천단위는 콤마이므로, 점이 둘 이상이면 소수점일 수 없다 → 다 지운다.
   * 하나만 있으면 소수점으로 본다(1100000.00). */
  if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '')

  const n = parseFloat(s)
  if (!Number.isFinite(n)) return 0
  return Math.round(paren ? -Math.abs(n) : n)
}

/** 비율·이율 등 소수를 그대로 쓰는 값 */
function numOf(v) {
  if (v == null || v === '') return 0
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

module.exports = { moneyOf, numOf }
