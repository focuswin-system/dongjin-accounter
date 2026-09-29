/**
 * 고객사 전용 모듈 카탈로그 — 특정 회사에게만 여는 기능.
 *
 * 보고서·문서 카탈로그(reportCatalog.js · docCatalog.js)와 같은 틀이다.
 *   · 켜는 곳   운영 콘솔(routes/admin.js sellableCatalog) — 우리가 정한다. 고객이 못 켠다
 *   · 판정      lib/entitlements.js featuresOf → 키 'custom:<key>'
 *   · 막는 곳   그 모듈의 라우터 첫 미들웨어(없으면 404 — 존재 자체를 숨긴다)
 *
 * ⚠ 코드는 하나다(포크하지 않는다). 모듈 코드는 server/custom/<회사>/ 한 곳에만 두고,
 *   공통 코드는 그 폴더를 모른다(check:isolation [20]).
 *   설계: docs/02-design/features/dongjin-custom-module.design.md
 */

const BUILTIN_CUSTOM = [
  {
    key: 'dongjin_mes',
    title: 'MES 연결 (동진테크)',
    descr: '계약관리 수주에 MES 수주 진행을 보여 주고, 거래처는 MES 거래처 표를 원본으로 쓴다',
    scope: 'entitled',
  },
]

const customFeatureKeyOf = (key) => `custom:${key}`

module.exports = { BUILTIN_CUSTOM, customFeatureKeyOf }
