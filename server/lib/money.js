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

/* 장식을 걷어내고 **숫자 한 덩어리**만 꺼낸다. 못 꺼내면 null.
 *
 * ⚠ 예전엔 `[^0-9.-]` 를 통째로 지웠다. 그러면 숫자가 아닌 문자열이 조용히 숫자가 된다:
 *     '1e9'     → '19'   → 19원   (10억을 19원으로 저장)
 *     '12abc34' → '1234'
 *   이 파일이 애초에 생긴 이유(100배 오차)와 같은 종류의 사고다 — 틀린 값이 에러 없이
 *   저장되고 합계 검증도 통과한다.
 *
 * 그래서 규칙을 뒤집었다: **숫자 덩어리는 하나여야 한다.** 앞뒤 장식(₩, 원, 연, %, 괄호)은
 * 얼마든지 붙어도 되지만, 덩어리 밖에 다른 숫자가 있으면 읽지 못한 것으로 본다
 * (호출부가 '금액을 입력해주세요'로 걸러낸다). '연 3.25%' 는 그대로 3.25 로 읽힌다.
 */
function pickNumber(s) {
  const m = /^\D*?(-?[\d.]+)\D*$/.exec(s)
  if (!m) return null
  const t = m[1]
  return t && t !== '-' && t !== '.' && t !== '-.' ? t : null
}

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
  s = pickNumber(s.replace(/[,\s]/g, ''))       // 천단위 콤마·공백부터 걷어낸다
  if (s === null) return 0
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
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  // moneyOf 와 같은 규칙 — 장식은 허용, 숫자 덩어리가 둘이면 읽지 않는다('1e9' → 0)
  const t = pickNumber(String(v).trim().replace(/[,\s]/g, ''))
  if (t === null) return 0
  const n = parseFloat(t)
  return Number.isFinite(n) ? n : 0
}

module.exports = { moneyOf, numOf }
