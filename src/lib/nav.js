import { Icon } from './ui'

// 포털형 2뎁스 네비게이션 트리 (도메인 → 업무 섹션 → 잎 메뉴)
// App 사이드바와 홈 포털이 이 트리를 공유한다. 환경설정(settings)은 별도 취급.
export const NAV_TREE = [
  { type: "leaf", id: "home", label: "홈", icon: Icon.Home },
  {
    type: "domain", id: "acct", label: "일반회계", icon: Icon.Book,
    sections: [
      // 돈 흐름의 '성격'으로 나눈다 — 회계 계정 성격과 같은 축이라 보고서(손익)까지 그대로 이어진다.
      //   판매·매출 = 수익 / 매입 = 매출원가(직접비) / 경비 = 판관비(운영비) / 장부 = 조회 전용
      // 메뉴 순서 = 실제 일하는 순서. 계약 → 청구 → 회수.
      // '입금'·'지출'은 거래내역 화면에 필터만 건 같은 뷰라 메뉴에서 뺐다(거래내역에서 본다).
      // 판매·매출과 매입은 같은 순서로 읽힌다: 계약 → 청구서 → 정기 → 미회수/미지급.
      // 정기청구(매출)와 정기지출(매입)이 서로 마주보는 자리에 있어야 흐름이 대칭으로 보인다.
      { label: "판매·매출", items: [
        { id: "contract_sales",    label: "매출 계약",   icon: Icon.Briefcase },
        { id: "billing_issued",    label: "대금 청구서", icon: Icon.Receipt },
        { id: "recurring_invoice", label: "정기청구",    icon: Icon.Clock },
        { id: "ar",                label: "미수금",      icon: Icon.Recv },
      ]},
      { label: "매입", items: [
        { id: "contract_purchase", label: "매입 계약",   icon: Icon.Briefcase },
        { id: "billing_received",  label: "대금 청구서", icon: Icon.Receipt },
        { id: "recurring_expense", label: "정기지출",    icon: Icon.Clock },
        { id: "ap",                label: "미지급금",    icon: Icon.Pay },
      ]},
      // 판관비 — 계약·품목에 붙지 않는 운영비(임차·통신·보험 등). 잡손익은 영업외라 따로 둔다.
      { label: "경비", items: [
        { id: "misc_pl",     label: "일반 경비", icon: Icon.Wallet },
        { id: "misc_income", label: "잡손익",    icon: Icon.Trend },
      ]},
      // 결재·정산 문서 모음. 결의서는 매입·경비 양쪽에서 올라오고, 정산내역서는 자금 집행 정산이라
      // 어느 한쪽에 두지 않고 독립 '문서' 섹션에 둔다. 새 회사 양식은 여기에 전용 문서로 계속 추가.
      { label: "문서", items: [
        { id: "doc", label: "지급결의서", icon: Icon.Sign },
        { id: "settlement", label: "정산내역서", icon: Icon.Doc },
      ]},
      { label: "장부", items: [
        { id: "ledger",   label: "전체 거래내역", icon: Icon.Wallet },
        { id: "contract", label: "계약",          icon: Icon.Briefcase },
        // '증빙 관리'는 아직 목업(SAMPLE 데이터·실동작 없음)이라 메뉴에서 숨김.
        // 추후 여유 있을 때 거래 evid_url 집계 + 증빙 누락 관리로 실구현 예정.
      ]},
      { label: "세무관리", items: [
        { id: "tax_vat", label: "부가세",   icon: Icon.Doc },
        { id: "tax_etc", label: "기타세액", icon: Icon.Doc },
      ]},
      { label: "기준정보", items: [
        { id: "master_vendor",          label: "거래처",     icon: Icon.Building },
        { id: "master_accountSubject",  label: "계정과목",   icon: Icon.Book },
        { id: "master_category",        label: "비목",       icon: Icon.Folder },
        { id: "master_jeokyo",          label: "적요",       icon: Icon.Doc },
        { id: "master_evidence_type",   label: "증빙유형",   icon: Icon.Receipt },
        { id: "master_item",            label: "품목",       icon: Icon.Receipt },
        { id: "master_fixed_asset",     label: "고정자산",   icon: Icon.Wallet },
        { id: "master_intangible_asset",label: "무형자산",   icon: Icon.File },
        { id: "master_account",         label: "계좌/카드",  icon: Icon.Card },
        { id: "master_accountBalance",  label: "계좌 잔액",  icon: Icon.Bank },
        { id: "master_insurance",       label: "보험",       icon: Icon.Doc },
      ]},
    ],
  },
  {
    type: "domain", id: "hr_dom", label: "인사급여", icon: Icon.Building,
    sections: [
      { label: "인사·급여", items: [
        { id: "hr", label: "인사관리", icon: Icon.Building },
      ]},
      { label: "근로·용역", items: [
        { id: "hr_labor_contract", label: "근로계약",      icon: Icon.Sign },
        { id: "hr_outsourcing",    label: "기타 용역·일용", icon: Icon.Briefcase },
      ]},
      { label: "기준정보", items: [
        { id: "hrbase_department",   label: "부서",     icon: Icon.Building },
        { id: "hrbase_position",     label: "직위",     icon: Icon.Sign },
        { id: "hrbase_payrollItems", label: "급여 항목", icon: Icon.Wallet },
        { id: "hrbase_employType",   label: "고용형태",  icon: Icon.Briefcase },
      ]},
    ],
  },
  {
    type: "domain", id: "mgmt", label: "경영관리", icon: Icon.Trend,
    sections: [
      { label: "장부관리", items: [
        { id: "report", label: "보고서", icon: Icon.Chart },
      ]},
      { label: "경영관리", items: [
        { id: "mgmt_dash", label: "경영 대시보드", icon: Icon.Trend },
        { id: "mgmt_ask", label: "경영 도우미", icon: Icon.Sparkle },
      ]},
    ],
  },
]

// 환경설정(사이드바 하단·포털 별도 타일)
export const SETTINGS_LEAF = { id: "settings", label: "환경설정", icon: Icon.Cog }

// 환경설정 하위 화면 — 기준정보처럼 각 항목을 forcedTab 잎으로(내부 서브내브 없이 전체폭, 공용 레이아웃).
// '문서 양식'(template)은 목업이라 제외. 클릭 시 route=settings_<tab> → MasterScreen forcedTab.
export const SETTINGS_LEAVES = [
  { id: "settings_company",  label: "회사 정보", icon: Icon.Building },
  { id: "settings_user",     label: "사용자",    icon: Icon.Sign },
  { id: "settings_approval", label: "결재선",    icon: Icon.Doc },
  { id: "settings_closing",  label: "월 마감",   icon: Icon.Bank },
]

// 잎 id → 소속 도메인 id (활성 도메인 자동 펼침용)
export const DOMAIN_OF = {}
for (const node of NAV_TREE) {
  if (node.type === "domain") for (const s of node.sections) for (const it of s.items) DOMAIN_OF[it.id] = node.id
}

// 모든 잎 평탄화 (id → {id,label,icon,domain,section}) — 자주 찾는 메뉴 등에서 사용
export const ALL_LEAVES = []
for (const node of NAV_TREE) {
  if (node.type === "leaf") { if (node.id !== "home") ALL_LEAVES.push({ id: node.id, label: node.label, icon: node.icon }) }
  else for (const s of node.sections) for (const it of s.items) ALL_LEAVES.push({ id: it.id, label: it.label, icon: it.icon, domain: node.label, section: s.label })
}
// 환경설정 잎도 평탄화 목록에 넣는다(포털 타일·브레드크럼·명령팔레트에서 찾게)
for (const l of SETTINGS_LEAVES) ALL_LEAVES.push({ ...l, domain: "환경설정", section: "환경설정" })

export const LEAF_BY_ID = Object.fromEntries(ALL_LEAVES.map(l => [l.id, l]))

// ── 홈택스식 다단계 포털 구조 (도메인 → 카테고리 → 그룹 → 화면) ──
// 카테고리: route(바로 화면) 또는 groups(하위 라인 → 화면 버튼들, 포털 페이지)
export const PORTAL = [
  {
    id: 'acct', label: '일반회계', icon: Icon.Book,
    // 홈은 이 카테고리들이 '깔끔한 카드' 한 벌로 보인다(하위메뉴 나열 X). 각 카드를 누르면
    // 그 영역 포털(또는 단일 화면)로 들어간다. 늘어난 업무(경비·지출승인·장부)를 각 카드로 세운다.
    categories: [
      { id: 'acct_sales', label: '판매·매출', icon: Icon.Recv, desc: '매출 계약·청구·수금', groups: [
        { label: '', items: ['contract_sales', 'billing_issued', 'recurring_invoice', 'ar'] },
      ]},
      { id: 'acct_purchase', label: '매입', icon: Icon.Pay, desc: '매입 계약·청구·지급', groups: [
        { label: '', items: ['contract_purchase', 'billing_received', 'recurring_expense', 'ap'] },
      ]},
      { id: 'acct_expense', label: '경비', icon: Icon.Wallet, desc: '일반 경비·잡손익', groups: [
        { label: '', items: ['misc_pl', 'misc_income'] },
      ]},
      { id: 'acct_docs', label: '문서', icon: Icon.Sign, desc: '지급결의서·정산내역서', groups: [
        { label: '', items: ['doc', 'settlement'] },
      ]},
      { id: 'acct_ledger', label: '장부', icon: Icon.Book, desc: '거래내역·계약 조회', groups: [
        { label: '', items: ['ledger', 'contract'] },   // '증빙 관리'는 목업이라 숨김(추후 실구현 예정)
      ]},
      { id: 'acct_tax', label: '세무관리', icon: Icon.Doc, desc: '부가세·기타세액 신고', groups: [
        { label: '', items: ['tax_vat', 'tax_etc'] },
      ]},
      { id: 'master', label: '기준정보', icon: Icon.Folder, desc: '거래처·계정·품목·자산 등', groups: [
        { label: '거래 기준', items: ['master_vendor', 'master_accountSubject', 'master_category', 'master_jeokyo', 'master_evidence_type'] },
        { label: '품목·자산', items: ['master_item', 'master_fixed_asset', 'master_intangible_asset'] },
        { label: '자금·결제', items: ['master_account', 'master_accountBalance', 'master_insurance'] },
      ]},
    ],
  },
  {
    id: 'hr_dom', label: '인사급여', icon: Icon.Building,
    categories: [
      { id: 'hr', label: '인사관리', icon: Icon.Building, desc: '급여대장·직원 관리', route: 'hr' },
      { id: 'hr_labor', label: '근로·용역', icon: Icon.Sign, desc: '근로계약·용역·일용', groups: [
        { label: '', items: ['hr_labor_contract', 'hr_outsourcing'] },
      ]},
      { id: 'hr_base', label: '기준정보', icon: Icon.Folder, desc: '부서·직위·급여항목·고용형태', groups: [
        { label: '조직', items: ['hrbase_department', 'hrbase_position'] },
        { label: '급여·근로', items: ['hrbase_payrollItems', 'hrbase_employType'] },
      ]},
    ],
  },
  {
    id: 'mgmt', label: '경영관리', icon: Icon.Trend,
    // 좌측 사이드바 섹션과 맞춘다: 장부관리(보고서) / 경영관리(경영 대시보드·경영 도우미)
    categories: [
      { id: 'mgmt_report', label: '장부관리', icon: Icon.Chart, desc: '보고서·집계 자료', route: 'report' },
      { id: 'mgmt_biz', label: '경영관리', icon: Icon.Trend, desc: '경영 대시보드·도우미', groups: [
        { label: '', items: ['mgmt_dash', 'mgmt_ask'] },
      ]},
    ],
  },
]

// 포털 페이지(그룹 보유) 카테고리만 id로 조회 — App 라우팅에서 PortalScreen 렌더
export const PORTAL_CAT_BY_ID = {}
for (const d of PORTAL) for (const c of d.categories) if (c.groups) PORTAL_CAT_BY_ID[c.id] = { ...c, domainLabel: d.label }

// 환경설정도 포털 타일 페이지로(기준정보와 같은 방식) — 'settings' 루트가 타일을 보여주고,
// 각 타일은 settings_<tab> forcedTab 화면으로 들어간다.
PORTAL_CAT_BY_ID['settings'] = {
  id: 'settings', label: '환경설정', icon: Icon.Cog, domainLabel: '환경설정',
  groups: [{ label: '', items: SETTINGS_LEAVES.map(l => l.id) }],
}

// 포털 카테고리 라우트도 소속 도메인으로 매핑(사이드바 도메인 자동 펼침)
DOMAIN_OF['acct_sales'] = 'acct'
DOMAIN_OF['acct_purchase'] = 'acct'
DOMAIN_OF['acct_expense'] = 'acct'
DOMAIN_OF['acct_docs'] = 'acct'
DOMAIN_OF['acct_ledger'] = 'acct'
DOMAIN_OF['acct_tax'] = 'acct'
DOMAIN_OF['master'] = 'acct'   // 기준정보 포털 카테고리(groups) — 사이드바 도메인 자동 펼침
DOMAIN_OF['hr_labor'] = 'hr_dom'
DOMAIN_OF['hr_base'] = 'hr_dom' // 인사급여 기준정보 포털 카테고리(groups)
DOMAIN_OF['mgmt_report'] = 'mgmt'
DOMAIN_OF['mgmt_biz'] = 'mgmt'  // 경영관리 포털 카테고리(groups)

// 라우트(하위 라우트 포함) → 사이드바에서 활성 표시할 잎 id
export function leafIdOf(route) {
  if (route === "contract_detail") return "contract"
  if (route === "ledger_income") return "income"
  if (route === "ledger_expense") return "expense"
  if (route === "ledger_ar") return "ar"
  if (route === "ledger_ap") return "ap"
  if (route === "excel_modal" || route === "excel") return "ledger"
  if (route === "billing") return "billing_issued"
  // 환경설정 하위(settings_<tab>)는 사이드바 하단 '환경설정'을 활성으로
  if (route === "settings" || route.startsWith("settings_")) return "settings"
  return route
}
