/**
 * 상호 정규화 — '(주)한빛문구' · '주식회사 한빛문구' · '한빛 문구'를 **같은 회사**로 본다.
 *
 * ⚠ 화면 규칙(src/lib/normalize.js normVendorName)과 **글자 하나까지 같아야 한다.**
 *   거래처 업로드·세금계산서 업로드(화면)는 그 규칙으로 중복을 가르는데, 거래내역 업로드(서버)만
 *   글자가 똑같을 때만 이어서, 같은 회사가 거래처로 두 벌 생겼다(2026-09-30). 규칙이 둘이면 또 갈린다.
 *
 * 오타·줄임말(한빛테그, 한빛 ↔ 한빛테크)은 **일부러 안 잡는다** — 다른 회사를 잘못 이으면
 * 아무도 모른 채 남의 거래처에 돈이 붙는다. 그런 건 화면이 '새로 만들 거래처'로 보여 주고 사람이 본다.
 */
const normVendorName = (v) => String(v ?? '')
  .replace(/\(주\)|\(유\)|\(재\)|\(사\)|㈜|㈔|㈕|주식회사|유한회사|재단법인|사단법인/g, '')
  .replace(/[\s()\-.,·]/g, '')
  .toLowerCase()

/**
 * **비슷한** 상호 — 정규화한 글자가 같거나, 다섯 글자 이상에서 **한 글자만** 다르다.
 * '금강노인종합복지관' ↔ '금강노인종합복지회관' 이 같은 곳이었는데 서로 다른 거래처로 잡혀,
 * 같은 입금이 두 줄 들어가도 중복 검사가 못 봤다(운영 fowin 2026-01~07, 2줄).
 *
 * ⚠ **잇는 데 쓰지 않는다 — 묻는 데만 쓴다.** 위 normVendorName 주석대로, 오타 같은 다른 회사를 잘못 이으면
 *   남의 거래처에 돈이 붙는다. 그래서 이 판정은 '같은 곳인가요?'를 묻거나(거래처 등록) '중복 의심'을
 *   띄우는(정산·업로드) 자리에서만 쓴다. 짧은 이름(4자 이하)은 한 글자 차이도 다른 회사인 일이 흔해 뺀다.
 */
const isSimilarVendorName = (a, b) => {
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

/**
 * 이 이름과 비슷한 거래처들(같은 이름 포함). 거래처 표 전체를 한 번 읽는다 — 회사당 수백 곳이라 충분하다.
 * @param db 테넌트 연결(기본값 없음 — 빠뜨리면 남의 회사를 읽는다)
 */
async function similarVendors(db, name) {
  if (!db) throw new Error('similarVendors: 테넌트 연결(db)이 필요합니다')
  if (!normVendorName(name)) return []
  const [rows] = await db.execute('SELECT id, name, gubu, active, biz_no FROM vendors')
  return rows.filter(v => isSimilarVendorName(v.name, name))
}

/** 이 거래처와 같은 곳으로 **의심할** 거래처 id 들(자기 자신 포함) — 중복 검사의 거래처 범위 */
async function sameVendorIds(db, vendorId) {
  if (!db) throw new Error('sameVendorIds: 테넌트 연결(db)이 필요합니다')
  if (!vendorId) return []
  const [[v]] = await db.execute('SELECT name FROM vendors WHERE id = ?', [vendorId])
  if (!v) return [vendorId]
  return [...new Set([vendorId, ...(await similarVendors(db, v.name)).map(x => x.id)])]
}

module.exports = { normVendorName, isSimilarVendorName, similarVendors, sameVendorIds }
