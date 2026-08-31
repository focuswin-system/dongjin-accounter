/**
 * 문서 카탈로그 — **어떤 문서 양식이 존재하는가**의 단일 소스.
 *
 * 보고서 카탈로그(platform/reportCatalog.js)와 **같은 판**이다. 거기 머리말이
 * 설명하는 문제를 문서 쪽도 그대로 갖고 있었다: 목록이 src/lib/nav.js 의 하드코딩
 * 잎이라 **회사마다 다른 목록을 줄 방법이 없었다.** 견적요청서를 안 쓰는 회사도
 * 메뉴에 그게 서 있고, 우리가 A사에만 새 양식을 열어 줄 길도 없었다.
 *
 * ── 여기와 화면의 관계 ──
 *   key  ↔  src/lib/nav.js 의 **잎 id** (= 라우트 = 권한 자원 이름)
 * ⚠ 셋이 같은 문자열이어야 한다. 보고서와 다른 점이다 — 보고서는 타일 판 안의
 *   항목이라 자기 라우트가 없지만, 문서는 사이드바에 잎으로 서 있다.
 *   그래서 카탈로그 key 를 잎 id 와 어긋나게 지으면 **끄기가 아무 일도 안 한다.**
 *   scripts/check-isolation.js [16] 이 이걸 지켜본다.
 *
 * ── scope ── (보고서와 같은 뜻)
 *   all       모든 회사가 기본으로 본다
 *   entitled  켜 준 회사만 본다. 운영 콘솔에서 회사별로 켠다
 *   hidden    카탈로그에는 있지만 어디에도 안 나간다
 *
 * ── ⚠ 지금 넷 다 'all' 인 이유 ──
 * **오늘 쓰던 사람의 화면이 내일 그대로여야 한다.** 이 단계는 판을 까는 일이지
 * 무엇을 빼앗는 일이 아니다. 넷 다 'all' + 회사 설정은 '행이 없으면 켜짐'이라
 * 마이그레이션도, 씨앗 데이터도, 사용자가 켤 것도 없다 — 배포하면 화면이 똑같다.
 * 나중에 새 양식을 만들 때 그것만 'entitled' 로 올리면 된다.
 */

/** 기능 키 — 회사별 판매 단위. company_features.feature_key 와 같은 문자열이다. */
const featureKeyOf = (key) => `doc:${key}`

/**
 * 회사 설정 키 — 그 회사가 스스로 끈 것을 담는 이름.
 *
 * ⚠ 보고서와 **같은 표**(report_prefs)를 쓴다. 이름은 report_ 로 시작하지만
 *   실체는 key_name/enabled 두 칸짜리 범용 표이고, 회계 처리 방식
 *   (voucher_issuance)도 이미 여기 산다(routes/company.js).
 *   표를 새로 만들면 테넌트마다 마이그레이션이 필요한데, 얻는 건 이름뿐이다.
 * ⚠ 접두사 'doc:' 이 붙는 이유는 보고서 key 와 섞이지 않게 하기 위해서다.
 *   보고서는 접두사 없이 raw key 로 들어간다.
 */
const prefKeyOf = (key) => `doc:${key}`

const BUILTIN_DOCS = [
  { key: 'doc',          title: '지급결의서', descr: '지출 전에 결재를 받는 문서예요.',            scope: 'all', sort: 10 },
  { key: 'settlement',   title: '정산내역서', descr: '쓴 돈을 항목별로 정리해 넘기는 문서예요.',    scope: 'all', sort: 20 },
  { key: 'quote_req',    title: '견적요청서', descr: '거래처에 단가를 물어보는 문서예요.',          scope: 'all', sort: 30 },
  { key: 'purchase_req', title: '구매품의서', descr: '무엇을 얼마에 살지 결재를 받는 문서예요.',    scope: 'all', sort: 40 },
]

const BUILTIN_BY_KEY = Object.fromEntries(BUILTIN_DOCS.map(d => [d.key, d]))

/**
 * 이 회사에서 **보이는** 문서 목록.
 * 두 축을 모두 통과해야 한다 — 우리가 열어줬나(features) AND 회사가 켜 뒀나(disabled 에 없나).
 *
 * @param disabled report_prefs 의 enabled=0 인 key_name 집합(원본 그대로)
 */
function visibleDocs({ catalog = BUILTIN_DOCS, features = new Set(), disabled = new Set() } = {}) {
  const out = []
  for (const d of [...catalog].sort((a, b) => (a.sort || 999) - (b.sort || 999))) {
    if (d.scope === 'hidden') continue
    if (d.scope === 'entitled' && !features.has(featureKeyOf(d.key))) continue
    if (disabled.has(prefKeyOf(d.key))) continue
    out.push({ key: d.key, title: d.title, descr: d.descr || '' })
  }
  return out
}

module.exports = { BUILTIN_DOCS, BUILTIN_BY_KEY, featureKeyOf, prefKeyOf, visibleDocs }
