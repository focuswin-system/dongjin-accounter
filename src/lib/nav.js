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
      //
      // ⚠ 용어를 단계별로 나눠 쓴다 — 전면 통일하지 않는다.
      //   영업 단계(계약)   → **수주 / 발주**. 실무가 쓰는 말이다("수주계약서"). '매출 계약'은 어색했다.
      //   회계 단계(청구서·미수금·미지급금·부가세) → **매출 / 매입 유지**.
      //     홈택스·세금계산서·부가세 신고서와 **글자가 같아야 대조가 된다**
      //     (매출세금계산서·매출세액은 서식 용어이고, 미수금·미지급금은 계정과목이다).
      //   그래서 '수주 계약 → 대금 청구서(매출) → 미수금'처럼 한 줄에 두 용어가 같이 선다. 의도된 것이다.
      { label: "판매·매출", items: [
        { id: "contract_sales",    label: "수주 계약",   icon: Icon.Briefcase },
        { id: "billing_issued",    label: "대금 청구서", icon: Icon.Receipt },
        { id: "recurring_invoice", label: "정기청구",    icon: Icon.Clock },
        { id: "ar",                label: "미수금",      icon: Icon.Recv },
      ]},
      { label: "매입", items: [
        { id: "contract_purchase", label: "발주 계약",   icon: Icon.Briefcase },
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
        { id: "quote_req", label: "견적요청서", icon: Icon.Doc },
        { id: "purchase_req", label: "구매품의서", icon: Icon.Receipt },
      ]},
      { label: "장부", items: [
        { id: "ledger",   label: "전체 거래내역", icon: Icon.Wallet },
        /* (제거) 'contract' 계약 통합 목록 —
         * 같은 ContractListScreen 을 kind="all" 로 연 것뿐이라, 사이드바에 계약이 세 번 서 있었다
         * (수주 계약·발주 계약·계약). 게다가 위 둘을 수주/발주로 바꾸고 나면 이 항목만 라벨이
         * 궁색해진다 — "계약"이라 부르면 위 둘은 계약이 아닌 게 되니까.
         * 라우트·권한 자원은 살려 둔다(HIDDEN_LEAVES). 계약 상세의 브레드크럼이 여기로 돌아오고,
         * Ctrl+K 로는 '계약 전체'로 여전히 찾을 수 있다. */
        // '증빙 관리'는 아직 목업(SAMPLE 데이터·실동작 없음)이라 메뉴에서 숨김.
        // 추후 여유 있을 때 거래 evid_url 집계 + 증빙 누락 관리로 실구현 예정.
      ]},
      { label: "세무관리", items: [
        { id: "tax_vat", label: "부가세",   icon: Icon.Doc },
        { id: "tax_etc", label: "기타세액", icon: Icon.Doc },
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
    ],
  },
  {
    /* 재무관리 — 성과(손익)와 재무(대차)는 성격이 다르다. 일반회계 안에 섞으면 헛갈린다.
     * 대출 원금·투자금은 손익이 아니라 부채·자본이다(server/lib/pnl.js). */
    type: "domain", id: "finance", label: "재무관리", icon: Icon.Bank,
    sections: [
      { label: "자금 조달", items: [
        { id: "finance_loan",       label: "차입금",   icon: Icon.Wallet },
        { id: "finance_investment", label: "투자",     icon: Icon.Trend },
      ]},
      /* 조달과 운용은 한 쌍이다. 적금은 대출의 거울상이라(매월 넣고 만기에 받는다)
       * 같은 도메인에서 마주보게 둔다. 보통예금·카드 같은 '결제수단'은 기준정보에 남는다 —
       * 예적금은 묶여 있어 당장 못 쓰는 돈이라 성격이 다르다. */
      { label: "자금 운용", items: [
        { id: "finance_savings",    label: "예금·적금", icon: Icon.Bank },
      ]},
      { label: "현황", items: [
        { id: "finance_dash",       label: "재무 현황", icon: Icon.Chart },
      ]},
    ],
  },
  {
    type: "domain", id: "mgmt", label: "경영관리", icon: Icon.Trend,
    sections: [
      /* 자금일보는 매일 아침 제일 먼저 여는 화면이다. 보고서(월 1~2회 보는 과거 집계) 안에
       * 묻으면 매일 3클릭이 되고, 그러면 안 본다. 그래서 잎으로 세운다.
       * 일계표는 반대다 — 그날 분개를 맞추는 과거 집계라 보고서 안이 맞다. */
      { label: "자금", items: [
        { id: "cash_report", label: "자금일보", icon: Icon.Bank },
      ]},
      { label: "장부관리", items: [
        { id: "report", label: "보고서", icon: Icon.Chart },
        { id: "report_daily", label: "일계표", icon: Icon.Book },
      ]},
      { label: "경영관리", items: [
        { id: "mgmt_dash", label: "경영 대시보드", icon: Icon.Trend },
        { id: "mgmt_ask", label: "경영 도우미", icon: Icon.Sparkle },
      ]},
    ],
  },
]

/* ── 기준정보 (사이드바 하단·환경설정 위) ──────────────────────────
 *
 * 예전엔 일반회계 안에 11개, 인사급여 안에 4개가 흩어져 사이드바에 상시 노출됐다.
 * 그런데 기준정보는 **처음 세팅하고 나면 거의 안 건드린다** — 계정과목은 K-GAAP 표준이라
 * 수정 자체가 막혀 있고, 부서·직위·고용형태는 몇 년에 한 번 바뀐다.
 * 매일 쓰는 대금 청구서와 같은 무게로 자리를 차지할 이유가 없었다.
 *
 * 사이드바 44개 중 15개(34%)가 이것들이었다. 한 곳으로 모아 '기준정보' 한 항목으로 세운다.
 * 찾아가는 길은 오히려 늘었다 — 홈 포털 타일, 사이드바 하단, 그리고 Ctrl+K 검색
 * ('통장'·'품목'·'거래처' 같은 말로도 걸린다. LEAF_TAGS 참고).
 *
 * ⚠ 각 항목의 id(=권한 자원)는 그대로 둔다. 위치만 옮기는 것이고 권한 체계는 손대지 않는다.
 */
export const MASTER_LEAF = { id: "master", label: "기준정보", icon: Icon.Folder }

export const MASTER_GROUPS = [
  { label: "거래·품목", items: [
    { id: "master_vendor",          label: "거래처",     icon: Icon.Building },
    { id: "master_item",            label: "품목",       icon: Icon.Receipt },
    { id: "master_category",        label: "비목",       icon: Icon.Folder },
    { id: "master_jeokyo",          label: "적요",       icon: Icon.Doc },
    { id: "master_evidence_type",   label: "증빙유형",   icon: Icon.Receipt },
    { id: "master_accountSubject",  label: "계정과목",   icon: Icon.Book },
  ]},
  { label: "자금·자산", items: [
    { id: "master_account",         label: "계좌/카드",  icon: Icon.Card },
    { id: "master_accountBalance",  label: "계좌 잔액",  icon: Icon.Bank },
    { id: "master_fixed_asset",     label: "고정자산",   icon: Icon.Wallet },
    { id: "master_intangible_asset",label: "무형자산",   icon: Icon.File },
    { id: "master_insurance",       label: "보험",       icon: Icon.Doc },
  ]},
  { label: "인사", items: [
    { id: "hrbase_department",   label: "부서",     icon: Icon.Building },
    { id: "hrbase_position",     label: "직위",     icon: Icon.Sign },
    { id: "hrbase_payrollItems", label: "급여 항목", icon: Icon.Wallet },
    { id: "hrbase_employType",   label: "고용형태",  icon: Icon.Briefcase },
  ]},
]

export const MASTER_LEAVES = MASTER_GROUPS.flatMap(g =>
  g.items.map(it => ({ ...it, domain: "기준정보", section: g.label })))

// 환경설정(사이드바 하단·포털 별도 타일)
export const SETTINGS_LEAF = { id: "settings", label: "환경설정", icon: Icon.Cog }

// 환경설정 하위 화면 — 기준정보처럼 각 항목을 forcedTab 잎으로(내부 서브내브 없이 전체폭, 공용 레이아웃).
// '문서 양식'(template)은 목업이라 제외. 클릭 시 route=settings_<tab> → MasterScreen forcedTab.
export const SETTINGS_LEAVES = [
  { id: "settings_company",  label: "회사 정보", icon: Icon.Building },
  { id: "settings_user",     label: "사용자",    icon: Icon.Sign },
  { id: "settings_approval", label: "결재선",    icon: Icon.Doc },
  { id: "settings_closing",  label: "월 마감",   icon: Icon.Bank },
  // 변경 이력 — 회사 마스터만 열린다(서버가 막고, 화면도 마스터가 아니면 타일을 감춘다)
  { id: "settings_audit",    label: "변경 이력", icon: Icon.Doc },
]

/* 사이드바·포털에서는 뺐지만 **살아 있는 화면** — 라우트·권한 자원·검색은 그대로 둔다.
 * 'contract'(계약 전체 목록)는 수주/발주 두 메뉴와 같은 화면이라 트리에서 뺐지만,
 *   · 계약 상세(contract_detail)의 브레드크럼이 이 라우트로 돌아오고
 *   · 자주 쓰진 않아도 '수주+발주를 한 표에서' 보고 싶을 때가 있다(Ctrl+K)
 * 그래서 없애지 않고 감춘다. 기준정보·환경설정 잎을 다루는 방식과 같다. */
export const HIDDEN_LEAVES = [
  { id: "contract", label: "계약 전체", icon: Icon.Briefcase, domain: "일반회계", section: "장부" },
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
/* 기준정보·환경설정 잎도 평탄화 목록에 넣는다.
   사이드바 트리에서는 빠졌지만 **찾을 수 있어야 한다** —
   포털 타일·브레드크럼·명령팔레트(Ctrl+K)가 모두 이 목록을 쓴다. */
for (const l of MASTER_LEAVES) ALL_LEAVES.push(l)
for (const l of SETTINGS_LEAVES) ALL_LEAVES.push({ ...l, domain: "환경설정", section: "환경설정" })
for (const l of HIDDEN_LEAVES) ALL_LEAVES.push(l)

export const LEAF_BY_ID = Object.fromEntries(ALL_LEAVES.map(l => [l.id, l]))

/**
 * 메뉴 검색 태그 — **사용자가 쓰는 말**로 메뉴를 찾게 한다.
 *
 * 메뉴명만으로 검색하면 처음 쓰는 사람이 못 찾는다. 실제로 이런 말로 찾는다:
 *   "보험" → 보험 화면이 어디 있는지 모름
 *   "인사" → '인사관리'인지 '근로계약'인지 모름
 *   "미지급금 처리" → 어디서 지급하는지 모름
 *   "세금계산서" → 대금 청구서라는 걸 모름
 *
 * 그래서 **동의어·업무 표현·오타에 가까운 말**까지 붙여둔다.
 * 라벨과 겹치는 말은 굳이 안 넣는다(라벨로 이미 걸린다).
 */
export const LEAF_TAGS = {
  // 판매·매출
  // 라벨이 '수주 계약'이 됐으니 옛 이름(매출 계약)으로 찾는 사람이 못 찾으면 안 된다.
  // ⚠ '발주'는 여기 넣지 않는다 — 발주 계약(우리가 발주한 것)과 헷갈린다.
  //    다만 '발주처'(우리에게 발주한 고객사)로 찾는 사람은 여기가 맞다.
  contract_sales:   '매출계약 매출 수주계약 납품계약 오더 주문 발주처 계약',
  billing_issued:   '세금계산서 계산서 청구 발행 매출 인보이스 수금',
  recurring_invoice:'정기 매달 월정액 자동청구 구독',
  ar:               '받을돈 채권 외상매출금 미수 연체 독촉 회수',
  // 매입
  contract_purchase:'매입계약 매입 발주계약 외주계약 하도급 구매계약 계약',
  billing_received: '매입세금계산서 수취 매입계산서 청구받은',
  recurring_expense:'정기지출 고정비 임차료 월세 리스 자동이체',
  ap:               '줄돈 채무 외상매입금 미지급 결제 지급처리',
  // 경비
  misc_pl:          '경비 비용 지출 소액 카드값 잡비',
  misc_income:      '잡수익 기타수익 이자수익 환급',
  // 문서
  doc:              '결의서 지출결의 품의 결재 승인',
  settlement:       '정산 출장비 가지급 여비 경비정산',
  quote_req:        '견적 RFQ 단가문의',
  purchase_req:     '품의 구매요청 발주요청 稟議',
  // 장부
  ledger:           '거래 입출금 통장내역 원장 전표 입금 출금',
  contract:         '계약조회 계약목록 전체계약 수주발주 통합',
  // 세무
  tax_vat:          '부가가치세 신고 매출세액 매입세액 환급 홈택스',
  tax_etc:          '원천세 법인세 지방소득세 4대보험 납부',
  // 기준정보
  master_vendor:        '거래처 업체 협력사 공급사 발주처 매입처 사업자등록',
  master_accountSubject:'계정 계정코드 분개 차변 대변 KGAAP',
  master_category:      '비목 항목 분류 지출항목',
  master_jeokyo:        '적요 메모양식 상용구',
  master_evidence_type: '증빙 영수증종류 적격증빙',
  master_item:          '품목 제품 부품 자재 도면 규격 단가',
  master_fixed_asset:   '자산 설비 기계 장비 차량 감가상각',
  master_intangible_asset:'무형 소프트웨어 라이선스 특허 상표',
  master_account:       '통장 계좌 카드 은행 법인카드 결제수단',
  master_accountBalance:'잔액 통장잔고 시재',
  master_insurance:     '보험 화재보험 배상책임 보험료 증권',
  // 인사급여
  hr:               '인사 급여 급여대장 월급 인건비 직원 사원',
  hr_labor_contract:'근로계약 정규직 채용 입사 퇴사 4대보험',
  hr_outsourcing:   '용역 프리랜서 일용직 외주인력 사업소득 기타소득',
  hrbase_department:'부서 조직 팀',
  hrbase_position:  '직위 직급 직책',
  hrbase_payrollItems:'급여항목 수당 공제 기본급 식대',
  hrbase_employType:'고용형태 근로형태',
  // 재무
  finance_loan:     '대출 차입 융자 상환 이자 원리금',
  finance_investment:'투자 출자 증자 유치 가수금',
  finance_savings:  '예금 적금 정기예금 만기 예치',
  finance_dash:     '재무 부채 자본 차입현황',
  // 경영
  cash_report:      '자금 자금계획 현금흐름 잔액예측 자금수지',
  report:           '보고서 리포트 통계 분석 현황',
  report_daily:     '일계표 일보 분개 차대변 시산표',
  mgmt_dash:        '경영 대시보드 지표 KPI 현황판',
  mgmt_ask:         '질의 도우미 물어보기',
  // 환경설정
  settings_company: '회사정보 사업자등록증 대표자 회사',
  settings_user:    '사용자 계정 권한 로그인 비밀번호 역할',
  settings_approval:'결재선 결재 승인라인',
  settings_closing: '마감 월마감 장부마감 결산',
  settings_audit:   '변경이력 감사 로그 기록 이력 누가 추적 삭제기록 접속기록',
}

// ── 홈택스식 다단계 포털 구조 (도메인 → 카테고리 → 그룹 → 화면) ──
// 카테고리: route(바로 화면) 또는 groups(하위 라인 → 화면 버튼들, 포털 페이지)
export const PORTAL = [
  {
    id: 'acct', label: '일반회계', icon: Icon.Book,
    // 홈은 이 카테고리들이 '깔끔한 카드' 한 벌로 보인다(하위메뉴 나열 X). 각 카드를 누르면
    // 그 영역 포털(또는 단일 화면)로 들어간다. 늘어난 업무(경비·지출승인·장부)를 각 카드로 세운다.
    categories: [
      { id: 'acct_sales', label: '판매·매출', icon: Icon.Recv, desc: '수주·청구·수금', groups: [
        { label: '', items: ['contract_sales', 'billing_issued', 'recurring_invoice', 'ar'] },
      ]},
      { id: 'acct_purchase', label: '매입', icon: Icon.Pay, desc: '발주·청구·지급', groups: [
        { label: '', items: ['contract_purchase', 'billing_received', 'recurring_expense', 'ap'] },
      ]},
      { id: 'acct_expense', label: '경비', icon: Icon.Wallet, desc: '일반 경비·잡손익', groups: [
        { label: '', items: ['misc_pl', 'misc_income'] },
      ]},
      { id: 'acct_docs', label: '문서', icon: Icon.Sign, desc: '지급결의서·정산내역서·견적요청서·구매품의서', groups: [
        { label: '', items: ['doc', 'settlement', 'quote_req', 'purchase_req'] },
      ]},
      /* 계약 통합 목록을 빼고 나니 남은 게 '전체 거래내역' 하나다 → 타일 안에 버튼 하나짜리
       * 포털 페이지를 두지 않고 바로 거래내역으로 보낸다(인사관리·자금 운용 타일과 같은 방식).
       * '증빙 관리'는 목업이라 숨김(추후 실구현 예정). */
      { id: 'acct_ledger', label: '장부', icon: Icon.Book, desc: '전체 거래내역', route: 'ledger' },
      { id: 'acct_tax', label: '세무관리', icon: Icon.Doc, desc: '부가세·기타세액 신고', groups: [
        { label: '', items: ['tax_vat', 'tax_etc'] },
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
      /* (제거) 'hr_base' 기준정보 카테고리 — 부서·직위·급여항목·고용형태.
       *
       * 기준정보를 독립 영역으로 모으면서 사이드바에서는 인사급여 안의 4개를 빼냈는데,
       * **홈 포털에는 그대로 남아** 같은 화면으로 가는 길이 두 갈래가 됐다
       * (홈에 '기준정보' 타일이 두 번 나왔다). 모으기로 한 이상 입구도 하나여야 한다.
       * 이 4개는 아래 MASTER_GROUPS 의 '인사' 묶음에 그대로 있다.
       * 라우트 'hr_base'(인사 기준정보 화면) 자체는 남겨둔다 — 구 링크·브레드크럼이 쓴다. */
    ],
  },
  {
    /* 재무관리는 사이드바에만 있고 홈 포털에서 빠져 있었다 — 홈에서는 들어갈 길이 없었다는 뜻이다.
     * (nav.js NAV_TREE 와 PORTAL 이 어긋나 있던 자리) */
    id: 'finance', label: '재무관리', icon: Icon.Bank,
    categories: [
      { id: 'finance_fund', label: '자금 조달', icon: Icon.Wallet, desc: '차입금·투자', groups: [
        { label: '', items: ['finance_loan', 'finance_investment'] },
      ]},
      { id: 'finance_ops', label: '자금 운용', icon: Icon.Bank, desc: '예금·적금', route: 'finance_savings' },
      { id: 'finance_status', label: '재무 현황', icon: Icon.Chart, desc: '차입·투자 현황', route: 'finance_dash' },
    ],
  },
  {
    id: 'mgmt', label: '경영관리', icon: Icon.Trend,
    // 좌측 사이드바 섹션과 맞춘다: 장부관리(보고서) / 경영관리(경영 대시보드·경영 도우미)
    categories: [
      { id: 'mgmt_cash', label: '자금일보', icon: Icon.Bank, desc: '오늘 잔액과 앞으로 들어올·나갈 돈', route: 'cash_report' },
      { id: 'mgmt_report', label: '장부관리', icon: Icon.Chart, desc: '보고서·일계표', groups: [
        { label: '', items: ['report', 'report_daily'] },
      ]},
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

/* 기준정보도 같은 방식의 포털 페이지. 일반회계 도메인 안에 있던 것을 꺼내
   독립 타일로 세운다 — 일반회계뿐 아니라 인사 기준정보까지 한 곳에 모으기 때문이다. */
PORTAL_CAT_BY_ID['master'] = {
  id: 'master', label: '기준정보', icon: Icon.Folder, domainLabel: '기준정보',
  groups: MASTER_GROUPS.map(g => ({ label: g.label, items: g.items.map(it => it.id) })),
}

// 포털 카테고리 라우트도 소속 도메인으로 매핑(사이드바 도메인 자동 펼침)
DOMAIN_OF['acct_sales'] = 'acct'
DOMAIN_OF['acct_purchase'] = 'acct'
DOMAIN_OF['acct_expense'] = 'acct'
DOMAIN_OF['acct_docs'] = 'acct'
DOMAIN_OF['acct_ledger'] = 'acct'
DOMAIN_OF['acct_tax'] = 'acct'
/* 기준정보(master)는 **일부러 DOMAIN_OF 에 넣지 않는다.**
   일반회계 안에 있다가 독립 영역으로 빠져나온 항목이라(인사 기준정보까지 모은다),
   여기에 'acct' 로 매핑해두면 기준정보에 들어갈 때마다 일반회계 도메인이 펼쳐진다 —
   사이드바에서는 아래쪽 독립 항목으로 서 있는데 위의 다른 도메인이 열리는 셈이라 어긋난다.
   (App.jsx CRUMB_MAP 도 master 를 '일반회계 하위가 아니라 독립 영역'으로 둔다) */
DOMAIN_OF['hr_labor'] = 'hr_dom'
DOMAIN_OF['hr_base'] = 'hr_dom' // 인사 기준정보 화면(라우트) — 홈 타일에서는 뺐지만 route 는 남아 있다
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
