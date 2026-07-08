import { Icon } from './ui'

// 포털형 2뎁스 네비게이션 트리 (도메인 → 업무 섹션 → 잎 메뉴)
// App 사이드바와 홈 포털이 이 트리를 공유한다. 환경설정(settings)은 별도 취급.
export const NAV_TREE = [
  { type: "leaf", id: "home", label: "홈", icon: Icon.Home },
  {
    type: "domain", id: "acct", label: "일반회계", icon: Icon.Book,
    sections: [
      { label: "판매·매출", items: [
        { id: "contract_sales", label: "매출 계약",   icon: Icon.Briefcase },
        { id: "income",         label: "입금",        icon: Icon.In },
        { id: "ar",             label: "미수금",      icon: Icon.Recv },
        { id: "billing_issued", label: "발행 청구서", icon: Icon.Receipt },
      ]},
      { label: "구매·매입", items: [
        { id: "contract_purchase", label: "매입 계약",   icon: Icon.Briefcase },
        { id: "expense",           label: "지출",        icon: Icon.Out },
        { id: "ap",                label: "미지급금",    icon: Icon.Pay },
        { id: "billing_received",  label: "수취 청구서", icon: Icon.Receipt },
        { id: "doc",               label: "지급결의서",  icon: Icon.Sign },
      ]},
      { label: "경비·잡손익", items: [
        { id: "misc_pl", label: "경비·잡손익", icon: Icon.Doc },
      ]},
      { label: "거래·계약", items: [
        { id: "ledger",   label: "전체 거래내역", icon: Icon.Wallet },
        { id: "contract", label: "계약",          icon: Icon.Briefcase },
        { id: "evidence", label: "증빙 관리",     icon: Icon.Folder },
      ]},
      { label: "세무관리", items: [
        { id: "tax_vat", label: "부가세",   icon: Icon.Doc },
        { id: "tax_etc", label: "기타세액", icon: Icon.Doc },
      ]},
      { label: "기준정보", items: [
        { id: "master", label: "기준정보 관리", icon: Icon.Folder },
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
        { id: "hr_base", label: "부서·직위·급여", icon: Icon.Folder },
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
      ]},
    ],
  },
]

// 환경설정(사이드바 하단·포털 별도 타일)
export const SETTINGS_LEAF = { id: "settings", label: "환경설정", icon: Icon.Cog }

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
export const LEAF_BY_ID = Object.fromEntries(ALL_LEAVES.map(l => [l.id, l]))

// 라우트(하위 라우트 포함) → 사이드바에서 활성 표시할 잎 id
export function leafIdOf(route) {
  if (route === "contract_detail") return "contract"
  if (route === "ledger_income") return "income"
  if (route === "ledger_expense") return "expense"
  if (route === "ledger_ar") return "ar"
  if (route === "ledger_ap") return "ap"
  if (route === "excel_modal" || route === "excel") return "ledger"
  if (route === "billing") return "billing_issued"
  if (route === "settings") return "settings"
  return route
}
