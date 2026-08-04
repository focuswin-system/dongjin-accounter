/**
 * API 경로 → (자원, 행위) 매핑 — 권한 강제의 단일 지점.
 *
 * ── 왜 라우트마다 미들웨어를 붙이지 않는가 ──
 * 라우트별로 검사를 걸면 **빠뜨린 라우트가 곧 구멍**이다. 그게 2026-07-30 검토에서 드러난
 * '마감 우회'와 똑같은 실패 패턴이었다(거래는 잠기는데 청구서·결의서·세금·PATCH는 열려 있었다).
 * 그래서 전역 게이트(index.js) 한 곳에서 판정하고, 매핑이 없는 라우터가 있으면
 * scripts/check-isolation.js 가 실패하게 한다 → 새 화면을 추가하면서 권한을 빠뜨릴 수 없다.
 *
 * ── 알아둘 한계(의도) ──
 * 라우터와 화면은 1:1이 아니다. 예: `/api/invoices` 하나가 매출 청구서·매입 청구서·미수금·미지급금
 * 네 화면을 모두 받는다. 그래서 서버 판정은 **"이 API를 쓸 자격이 있나"**(자원군 중 하나라도
 * 그 행위 권한이 있으면 통과)이고, '매출만 주고 매입은 막기' 같은 형제 화면 구분은
 * **화면 노출(nav 가리기)** 로 처리한다. 서버에서 그걸 가르려면 요청 본문의 kind를 신뢰해야 하는데,
 * 그건 신뢰할 수 없는 값이라 오히려 더 나쁜 보안이 된다.
 *
 * 자원 id·행위 목록은 platform/permissions.js 가 단일 소스다.
 */

const { RESOURCE_IDS } = require('./permissions')

/** HTTP 메서드 → 기본 행위 */
const METHOD_ACTION = {
  GET: 'view',
  HEAD: 'view',
  POST: 'create',
  PUT: 'edit',
  PATCH: 'edit',
  DELETE: 'delete',
}

/**
 * API prefix → 관련 자원 목록.
 * 그 중 **하나라도** 해당 행위 권한이 있으면 통과한다(자원군 판정).
 * 자원 id는 nav.js 잎 메뉴와 1:1이며 permissions.js RESOURCES 에 있어야 한다.
 */
const API_RESOURCES = {
  '/api/invoices':            ['billing_issued', 'billing_received', 'ar', 'ap'],
  '/api/contracts':           ['contract_sales', 'contract_purchase', 'contract'],
  '/api/transactions':        ['ledger', 'misc_pl', 'misc_income'],
  '/api/recurring-invoices':  ['recurring_invoice'],
  '/api/recurring-expenses':  ['recurring_expense'],
  '/api/resolutions':         ['doc'],
  '/api/settlements':         ['settlement'],
  '/api/purchase-reqs':       ['purchase_req'],
  '/api/quote-reqs':          ['quote_req'],
  '/api/tax':                 ['tax_vat', 'tax_etc'],
  '/api/finance':             ['finance_loan', 'finance_investment', 'finance_dash'],
  '/api/savings':             ['finance_savings'],
  '/api/vendors':             ['master_vendor'],
  '/api/account-subjects':    ['master_accountSubject'],
  '/api/categories':          ['master_category'],
  '/api/accounts':            ['master_account', 'master_accountBalance'],
  // 기준정보 범용(품목·자산·적요·보험·증빙유형) — 하나의 라우터가 여러 탭을 받는다
  '/api/ref-items':           ['master_item', 'master_fixed_asset', 'master_intangible_asset',
                               'master_jeokyo', 'master_insurance', 'master_evidence_type'],
  '/api/employees':           ['hr'],
  '/api/payroll':             ['hr'],
  '/api/payroll-items':       ['hrbase_payrollItems'],
  '/api/work-contracts':      ['hr_labor_contract', 'hr_outsourcing'],
  '/api/employ-types':        ['hrbase_employType'],
  '/api/hr-codes':            ['hrbase_department', 'hrbase_position'],
  '/api/analytics':           ['mgmt_ask', 'mgmt_dash', 'report'],
  // 홈 요약과 자금일보·일계표를 한 라우터가 받는다(같은 집계를 쓴다)
  '/api/dashboard':           ['home', 'cash_report', 'report_daily'],
  '/api/closings':            ['settings'],
  // 변경 이력 — 환경설정 하위 화면. 자원 판정은 settings 로 하되, 실제 열람은
  // routes/audit.js 가 회사 마스터로 한 번 더 좁힌다(계정 보안 사건이 함께 보이므로).
  '/api/audit':               ['settings'],
  '/api/company':             ['settings'],
  '/api/approval-presets':    ['settings'],
  // 첨부 업로드/다운로드는 어느 화면에서든 쓴다 → 자원으로 가르지 않고 아래 ANY_AUTHENTICATED 로 둔다
}

/**
 * 자원으로 가르지 않는 경로 — 로그인만 되어 있으면 통과.
 *   /api/auth   내 정보·비번 변경 등. 계정 관리(사용자 추가·역할 변경)는 라우트가 자체적으로
 *               마스터 여부를 검사한다(routes/auth.js isMaster).
 *   /api/uploads 첨부 파일. 화면별로 가르면 같은 파일을 어디서 올렸는지에 따라 접근이 갈려
 *               첨부가 조용히 깨진다. 파일 자체의 회사 격리는 middleware/fileAuth.js 가 한다.
 */
const ANY_AUTHENTICATED = ['/api/auth', '/api/uploads']

/**
 * **조회는 공용, 수정은 자기 자원** — 기준정보처럼 다른 화면이 선택 목록으로 쓰는 라우터.
 *
 * 왜 필요한가: 거래 하나를 등록하려면 거래처·계정과목·비목·품목·적요·계좌 목록을 읽어야 한다.
 * 이걸 각 기준정보 화면 권한(master_vendor 등)으로 막으면, '거래 등록'만 허용된 역할이
 * **드롭다운이 전부 빈 채로 아무것도 못 하는** 상태가 된다(실제로 브라우저에서 403 6건 확인).
 * 그래서 GET은 로그인한 사람이면 통과시키고, 등록·수정·삭제는 그대로 그 자원 권한을 요구한다.
 *
 * 무엇을 포기하는가: 같은 회사 안에서 거래처·계정과목 '이름 목록'은 누구나 볼 수 있다.
 * 회사 내부 참조 데이터이고 금액·거래가 아니라 감수할 수 있는 범위다.
 * 회사 간 격리는 그대로다 — req.db 가 자기 회사 DB만 본다.
 */
const LOOKUP_PREFIXES = [
  '/api/vendors', '/api/account-subjects', '/api/categories', '/api/ref-items',
  /* 계좌는 결제수단이라 어느 화면에서든 골라야 한다. 다만 응답의 **잔액은 따로 가린다** —
   * routes/accounts.js 가 req.perms 를 보고 권한 없는 사람에겐 balance 를 빼고 내려준다.
   * 계좌 '목록'과 계좌 '잔액'은 민감도가 다르다. */
  '/api/accounts',
]

/**
 * 경로 하나만 공용으로 여는 예외(접두어 전체가 아니라).
 *
 * `/api/employees` 전체를 열었더니 `SELECT *`가 **기본급·생년월일·급여계좌**까지 내보냈다.
 * 실무 프리셋은 인사를 통째로 차단하는데, 그 차단이 이 예외 하나로 무의미해졌다.
 * 고르기용 최소 목록(/options)만 연다.
 */
const LOOKUP_PATHS = ['/api/employees/options']

/**
 * 경로별 행위 재정의. 메서드만으로는 업로드·다운로드·출력을 가를 수 없다.
 * 정규식은 전체 경로(/api/...)에 대해 검사하며, 먼저 맞는 것이 이긴다.
 */
const ACTION_OVERRIDES = [
  // 엑셀 일괄 등록 — POST지만 '업로드' 권한이다
  { re: /^\/api\/[a-z-]+\/import\/(parse|commit)$/, action: 'upload' },
  // 양식·자료 내려받기 — GET이지만 '다운로드'
  { re: /^\/api\/[a-z-]+\/import\/template$/, action: 'download' },
  { re: /\/export(\.xlsx)?$/, action: 'download' },
  // 인쇄·출력용 조회
  { re: /\/(print|pdf)$/, action: 'export' },
]

/** 요청 → 필요한 행위 */
function actionFor(method, fullPath) {
  for (const o of ACTION_OVERRIDES) if (o.re.test(fullPath)) return o.action
  return METHOD_ACTION[method] || 'view'
}

/** 요청 경로 → API prefix ('/api/xxx'). 없으면 null */
function prefixOf(fullPath) {
  const m = /^(\/api\/[a-z-]+)/.exec(fullPath)
  return m ? m[1] : null
}

/**
 * 이 요청에 필요한 권한. null이면 자원 검사 대상이 아니다(로그인만 필요).
 * @returns {{ resources: string[], action: string }|null}
 */
function requiredPerm(method, fullPath) {
  const prefix = prefixOf(fullPath)
  if (!prefix) return null
  if (ANY_AUTHENTICATED.includes(prefix)) return null
  const resources = API_RESOURCES[prefix]
  if (!resources) return null      // 매핑 누락 — check:isolation 이 잡는다(런타임에선 막지 않는다)
  const action = actionFor(method, fullPath)
  // 기준정보 조회는 공용(위 설명 참고). 다운로드·업로드·등록·수정·삭제는 그대로 막는다.
  if (action === 'view') {
    if (LOOKUP_PREFIXES.includes(prefix)) return null
    if (LOOKUP_PATHS.includes(fullPath)) return null
  }
  return { resources, action }
}

/** 매핑에 쓰인 자원 id가 카탈로그에 다 있는지 (check:isolation 용) */
function unknownResources() {
  const known = new Set(RESOURCE_IDS)
  const bad = []
  for (const [prefix, list] of Object.entries(API_RESOURCES)) {
    for (const r of list) if (!known.has(r)) bad.push(`${prefix} → ${r}`)
  }
  return bad
}

module.exports = {
  METHOD_ACTION, API_RESOURCES, ANY_AUTHENTICATED, ACTION_OVERRIDES, LOOKUP_PREFIXES, LOOKUP_PATHS,
  actionFor, prefixOf, requiredPerm, unknownResources,
}
