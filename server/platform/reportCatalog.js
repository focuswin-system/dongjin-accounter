/**
 * 보고서 카탈로그 — **어떤 양식이 존재하는가**의 단일 소스.
 *
 * ── 예전 문제 ──
 * 목록이 화면 파일(src/screens/Docs.jsx)의 하드코딩 배열이었다. 그래서
 * 회사마다 다른 목록을 줄 방법이 없었고, 실제로 **화면은 만들어 놓고 목록에 안 넣어
 * 아무도 못 보는 보고서가 3개**(주문별·방산·세무사 전달용) 방치돼 있었다.
 * 목록과 화면이 이미 따로 놀고 있었다는 뜻이다 — 그럼 목록은 밖에서 정해야 한다.
 *
 * ── 여기와 화면의 관계 ──
 *   key  ↔  src/screens/Docs.jsx 의 REPORT_VIEWS[key] (React 컴포넌트)
 * 서버가 목록을 주고, 화면은 그 key 로 컴포넌트를 찾는다.
 * **화면에 없는 key 는 화면이 조용히 건너뛴다** — 서버만 먼저 배포돼도 깨지지 않는다.
 *
 * ── scope ──
 *   all       모든 회사가 기본으로 본다(지금까지 보이던 7개)
 *   entitled  **켜 준 회사만 본다.** 운영 콘솔에서 회사별로 켜고 끈다
 *   hidden    카탈로그에는 있지만 **어디에도 안 나간다.** 콘솔에서도 켤 수 없다
 *
 * ⚠ 안 켜진 entitled 는 **아무에게도 안 보인다** — 마스터에게도 '잠금 카드'를 띄우지 않는다.
 *   한때 마스터에게 잠금 카드로 보여 "살 수 있다"를 알리려 했는데, 팔 물건이 정해지기 전에
 *   광고부터 내거는 꼴이라 뺐다. 켜 주기 전까지 고객 화면은 오늘과 완전히 같다.
 *
 * hidden 을 '카탈로그에서 빼기' 대신 남겨둔 이유:
 *   빼면 아래 REPORT_VIEWS 에만 화면이 남아 **또 미아가 된다**(이 셋이 그 상태였다).
 *   등록해 두고 안 내보내면 검사 [15](카탈로그 ↔ 화면 동기화)가 계속 지켜준다.
 *   지금은 hidden 인 항목이 없다 — 화면이 아직 없는 양식을 미리 적어둘 때 쓴다.
 *
 * 설계: docs/02-design/features/company-report-templates.design.md §1.2 · §6.1
 */

/** 기능 키 — 회사별 판매 단위. company_features.feature_key 와 같은 문자열이다. */
const featureKeyOf = (key) => `report:${key}`

const BUILTIN_REPORTS = [
  { key: 'monthly',     title: '월별 입금/지출 현황',     descr: '이번 달과 지난 달을 비교해보세요.',                 scope: 'all',      sort: 10 },
  { key: 'tax4',        title: '4대보험·원천세 신고 자료', descr: '매달 10일 납부 기한 전에 신고서를 받으세요.',        scope: 'all',      sort: 20 },
  { key: 'category',    title: '비목별 지출 현황',         descr: '재료비·외주가공비·시험검사비 등 비목별 비교.',       scope: 'all',      sort: 30 },
  { key: 'vendor',      title: '발주처별 거래 현황',       descr: '발주처별 거래 규모를 비교해보세요.',                scope: 'all',      sort: 40 },
  { key: 'ar',          title: '미수금 현황',              descr: '받을 돈이 어디서 얼마나 남았는지 정리해드려요.',      scope: 'all',      sort: 50 },
  { key: 'subcontract', title: '외주가공비 분석',          descr: '협력사별 외주비 비중과 단가 추이.',                 scope: 'all',      sort: 60 },
  { key: 'vat',         title: '부가세 신고 자료',         descr: '분기별 매출·매입세액 및 납부세액을 확인하세요.',      scope: 'all',      sort: 70 },

  /* 회사별로 열어주는 양식(선택 제공). 안 켜 준 회사에는 **아무에게도 안 보인다.**
   *
   * 2026-08-14 에 실데이터로 붙였다. 그 전에는 셋 다 화면만 있고 데이터가 없었다
   * (빈 표 / 'NaN%' / 코드에 박힌 건수) — 그 상태로 켜면 고객이 가짜 숫자를 본다. */
  { key: 'contract',    title: '주문별 수익 현황',         descr: '주문별로 받은 매출·투입 원가·손익을 봅니다.',        scope: 'entitled', sort: 80 },
  { key: 'taxoffice',   title: '세무사 전달용 자료',       descr: '한 달치 회계 자료를 종류별로 모아 엑셀로 넘깁니다.',   scope: 'entitled', sort: 100 },
  /* 대표가 쓰던 엑셀(자금(현금)관리)의 칸 배치를 그대로 옮긴 한 장.
     자금 현황 화면과 숫자는 같고 모양이 다르다 — 몇 년째 그 자리로 봐 온 문서라
     같은 숫자라도 자리가 바뀌면 못 읽는다. */
  { key: 'fundsheet',   title: '자금관리표',              descr: '계좌별 잔액·나갈 돈·들어올 돈을 대표 보고 양식 그대로 봅니다.', scope: 'entitled', sort: 110 },

  /* ⚠ 방산 원가 보고서는 아직 **켤 수 없다**(hidden).
   *   SAMPLE.contractSummary(=[]) 를 읽어 늘 빈 표이고, 0으로 나눠 이행률이 'NaN%' 로 찍힌다.
   *   주문별 수익 현황과 같은 집계에 마일스톤 진행률을 얹으면 되지만 아직 안 했다.
   *   실구현 전에는 절대 entitled 로 올리지 않는다 — 켜는 순간 고객이 NaN 을 본다. */
  { key: 'defense',     title: '방산 원가 보고서',         descr: '방산 납품 원가 구성과 마일스톤 진행을 봅니다.',       scope: 'hidden', sort: 90 },
]

const BUILTIN_BY_KEY = new Map(BUILTIN_REPORTS.map(r => [r.key, r]))

/**
 * 이 회사가 볼 목록을 만든다. **순수 함수** — DB를 모른다(그래서 테스트가 쉽다).
 *
 * @param {object}  o
 * @param {Array}   o.catalog   양식 목록(기본: 내장 카탈로그). 나중에 회사 전용 양식을 이어 붙인다
 * @param {Set}     o.features  이 회사가 가진 기능 키 (우리가 열어준 것)
 * @param {Set}     o.disabled  그 회사가 스스로 끈 key (report_prefs)
 * @returns {Array} [{ key, title, descr, kind }] — **볼 수 있는 것만.** 잠금 항목은 없다
 */
function visibleReports({ catalog = BUILTIN_REPORTS, features = new Set(), disabled = new Set() } = {}) {
  const out = []
  for (const r of [...catalog].sort((a, b) => (a.sort || 999) - (b.sort || 999))) {
    if (r.scope === 'hidden') continue                      // 어디에도 안 나간다
    if (r.scope === 'entitled' && !features.has(r.feature || featureKeyOf(r.key))) continue
    // 회사가 스스로 끈 것 — 우리가 열어준 것이라도 그 회사 화면에서는 뺀다
    if (disabled.has(r.key)) continue
    out.push({ key: r.key, title: r.title, descr: r.descr || '', kind: r.kind || 'builtin' })
  }
  return out
}

module.exports = { BUILTIN_REPORTS, BUILTIN_BY_KEY, featureKeyOf, visibleReports }
