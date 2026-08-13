/**
 * 보고서 카탈로그 — **어떤 양식이 존재하는가**의 단일 소스.
 *
 * ── 예전 문제 ──
 * 목록이 화면 파일(src/screens/Docs.jsx)의 하드코딩 배열이었다. 그래서
 * 회사마다 다른 목록을 줄 방법이 없었고, 실제로 **화면은 만들어 놓고 목록에 안 넣어
 * 아무도 못 보는 보고서가 3개**(계약별·방산·세무사 전달용) 방치돼 있었다.
 * 목록과 화면이 이미 따로 놀고 있었다는 뜻이다 — 그럼 목록은 밖에서 정해야 한다.
 *
 * ── 여기와 화면의 관계 ──
 *   key  ↔  src/screens/Docs.jsx 의 REPORT_VIEWS[key] (React 컴포넌트)
 * 서버가 목록을 주고, 화면은 그 key 로 컴포넌트를 찾는다.
 * **화면에 없는 key 는 화면이 조용히 건너뛴다** — 서버만 먼저 배포돼도 깨지지 않는다.
 *
 * ── scope ──
 *   all       모든 회사가 기본으로 본다(지금까지 보이던 7개)
 *   entitled  **사야 보인다.** 회사에 그 기능 키가 있어야 한다
 *
 * 지금 entitled 로 둔 셋은 원래도 아무도 못 보던 것들이다 → 이 변경으로 사라지는 화면은 없다.
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

  /* 아래 셋은 화면 코드는 있는데 목록에 없어 여태 아무도 못 보던 것들이다.
     회사마다 필요 여부가 갈리는 양식이라(방산 원가는 방산 회사만 쓴다) 판매 단위로 둔다. */
  { key: 'contract',    title: '계약별 수익 현황',         descr: '계약 단위로 매출·원가·잔액을 봅니다.',              scope: 'entitled', sort: 80 },
  { key: 'defense',     title: '방산 원가 보고서',         descr: '방산 납품 원가 구성과 마일스톤 진행을 봅니다.',       scope: 'entitled', sort: 90 },
  { key: 'taxoffice',   title: '세무사 전달용 자료',       descr: '월별 손익·부가세 요약을 한 장으로 묶습니다.',        scope: 'entitled', sort: 100 },
]

const BUILTIN_BY_KEY = new Map(BUILTIN_REPORTS.map(r => [r.key, r]))

/**
 * 이 회사가 볼 목록을 만든다. **순수 함수** — DB를 모른다(그래서 테스트가 쉽다).
 *
 * @param {object}  o
 * @param {Array}   o.catalog   양식 목록(기본: 내장 카탈로그). 나중에 회사 전용 양식을 이어 붙인다
 * @param {Set}     o.features  이 회사가 가진 기능 키
 * @param {boolean} o.isMaster  회사 마스터인가 — 못 산 양식을 '잠금'으로 보여줄지 가른다
 * @returns {Array} [{ key, title, descr, kind, locked, lockReason? }]
 */
function visibleReports({ catalog = BUILTIN_REPORTS, features = new Set(), isMaster = false } = {}) {
  const out = []
  for (const r of [...catalog].sort((a, b) => (a.sort || 999) - (b.sort || 999))) {
    const needsBuy = r.scope === 'entitled'
    const has = !needsBuy || features.has(r.feature || featureKeyOf(r.key))
    /* 못 산 양식을 **일반 사원에게는 아예 안 보여준다.**
       살지 말지는 회사가 정하는 일이고, 사원 화면이 광고판이 되면 안 된다.
       마스터에게만 잠금 카드로 보여 "살 수 있는 게 있다"를 알린다. */
    if (!has && !isMaster) continue
    out.push({
      key: r.key,
      title: r.title,
      descr: r.descr || '',
      kind: r.kind || 'builtin',
      locked: !has,
      ...(has ? {} : { lockReason: 'entitlement' }),
    })
  }
  return out
}

module.exports = { BUILTIN_REPORTS, BUILTIN_BY_KEY, featureKeyOf, visibleReports }
