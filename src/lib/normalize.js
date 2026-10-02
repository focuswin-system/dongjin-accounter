/* 거래처 이름·사업자번호 정규화 — 중복 판정의 기준.
 *
 * 거래처 임포트(Master)와 세금계산서 임포트(Billing)가 서로 다른 규칙으로 정규화하면,
 * 같은 회사를 한쪽은 중복으로 다른 쪽은 신규로 봐서 거래처가 두 벌 생긴다. 규칙은 여기 하나.
 */

/** 사업자등록번호 → 숫자만 (‘000-00-00000’과 ‘00000000000’을 같게 본다) */
export const normBizNo = (v) => String(v ?? '').replace(/[^0-9]/g, '')

/** 상호 → 법인격·공백·기호 제거 후 소문자. ‘(주)포커스윈’과 ‘포커스윈 주식회사’를 같게 본다. */
export const normVendorName = (v) => String(v ?? '')
  .replace(/\(주\)|\(유\)|\(재\)|\(사\)|㈜|㈔|㈕|주식회사|유한회사|재단법인|사단법인/g, '')
  .replace(/[\s()\-.,·]/g, '')
  .toLowerCase()

/**
 * **비슷한** 상호 — 정규화한 글자가 같거나, 다섯 글자 이상에서 **한 글자만** 다르다.
 * '금강노인종합복지관' ↔ '금강노인종합복지회관' 이 같은 곳이었는데 서로 다른 거래처로 잡혀,
 * 같은 입금이 두 줄 들어가도 중복 검사가 못 봤다(운영 fowin 2026-01~07, 2줄).
 *
 * 서버 lib/vendorName.js 와 **같은 함수**다(테스트가 본다).
 * ⚠ **잇는 데 쓰지 않는다 — 묻는 데만 쓴다.** 위 normVendorName 주석대로, 오타 같은 다른 회사를 잘못 이으면
 *   남의 거래처에 돈이 붙는다. 그래서 이 판정은 '같은 곳인가요?'를 묻거나(거래처 등록) '중복 의심'을
 *   띄우는(정산·업로드) 자리에서만 쓴다. 짧은 이름(4자 이하)은 한 글자 차이도 다른 회사인 일이 흔해 뺀다.
 */
export const isSimilarVendorName = (a, b) => {
  const x = normVendorName(a), y = normVendorName(b)
  if (!x || !y) return false
  if (x === y) return true
  if (Math.min(x.length, y.length) < 5 || Math.abs(x.length - y.length) > 1) return false
  // 한 글자 차이(바꿈·넣음·뺌) — 앞뒤에서 같은 만큼 걷어내고 가운데 남은 게 한 글자 이하인가
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  let j = 0
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++
  return Math.max(x.length, y.length) - i - j <= 1
}
