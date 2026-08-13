/**
 * 요금제 — **뼈대만** 있고 아직 아무것도 팔지 않는다.
 *
 * ── 왜 지금 만드나 ──
 * companies.plan 컬럼은 멀티테넌트 전환 때부터 있었는데 **코드 어디에서도 읽지 않았다.**
 * 껍데기만 있는 컬럼은 나중에 살릴 때 "기존 값이 무슨 뜻이었나"를 아무도 모른다.
 * 그래서 지금 뜻을 못 박고 연결만 해 둔다 — 실제 판매는 나중이다.
 *
 * ── 두 층으로 나눈 이유 ──
 *   요금제(plan)      묶음. "프로를 쓰면 이만큼"  ← 여기
 *   회사별 예외        낱개. "이 회사만 이 양식"   ← company_features 표
 * 낱개가 묶음을 덮어쓴다. 묶음만 두면 "A사에만 방산 보고서"를 표현할 수 없고,
 * 낱개만 두면 회사가 늘 때마다 같은 목록을 손으로 반복해 넣게 된다. 둘 다 필요하다.
 *
 * ── 지금 상태 ──
 * 모든 요금제의 features 가 **비어 있다.** 즉 지금은 요금제가 아무 차이도 만들지 않는다.
 * 기본으로 보이는 보고서는 요금제가 아니라 카탈로그의 scope:'all' 이 정한다
 * (platform/reportCatalog.js). 팔기 시작할 때 여기 features 에 키를 채우면 된다.
 *
 * 설계: docs/02-design/features/company-report-templates.design.md §4.2
 */

/** 기능 키 이름 규칙 — '<영역>:<이름>'. 보고서 말고 다른 유료 기능도 같은 표를 쓴다. */
const FEATURE_NS = ['report']

const PLANS = {
  basic: { label: '기본', features: [] },
  pro:   { label: '프로', features: [] },   // 뼈대 — 팔 것이 정해지면 여기 채운다
}

const DEFAULT_PLAN = 'basic'

/** 그 요금제가 기본으로 주는 기능 키들. 모르는 요금제는 기본 요금제로 본다. */
function planFeatures(plan) {
  const p = PLANS[String(plan || '').trim()] || PLANS[DEFAULT_PLAN]
  return p.features
}

/** 기능 키가 우리가 아는 이름 규칙인가 — 오타로 만든 키가 조용히 무시되는 걸 막는다 */
function isKnownFeatureKey(key) {
  const s = String(key || '')
  return FEATURE_NS.some(ns => s.startsWith(`${ns}:`)) && s.length > 0
}

module.exports = { PLANS, DEFAULT_PLAN, planFeatures, isKnownFeatureKey, FEATURE_NS }
