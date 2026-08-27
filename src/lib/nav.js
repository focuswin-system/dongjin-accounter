import { Icon } from './ui'

/* 포털형 2뎁스 네비게이션 트리 (도메인 → 업무 섹션 → 잎 메뉴)
 * App 사이드바와 홈 포털이 이 트리를 공유한다. 환경설정(settings)은 별도 취급.
 *
 * ── 2026-08 재편: 회계 언어에서 업무 언어로 ──────────────────────────
 *
 * 예전 축은 '판매·수주(매출) / 구매·발주(매입) / 경비'였다. 회계 계정 성격과 같은 축이라
 * 손익 보고서까지 그대로 이어지는 장점이 있었지만, **그 축은 만든 사람의 축**이었다.
 * 대표(공급자) 관점에서 계약을 추적하고 원가를 계산하려고 세운 구조다.
 *
 * 실제 고객사에 납품해 보니 일하는 방식이 달랐다. 이분들은 큰 계약 틀에서 내려오지 않고
 * **손에 들어온 서류**(세금계산서·거래명세서·카드전표)를 보고 받아적는다. 그리고 회사마다
 * 정기청구만 하거나 정기지출만 하는 식으로 **한쪽 리듬에 치우쳐** 있다.
 *
 * 그래서 축을 둘로 바꿨다.
 *   1) **돈의 방향** — "돈 나간 거 어디 기록하지? 들어온 거 어디 기록하지?"에 바로 답한다.
 *      회계를 모르는 사람도 방향은 안다. 매출/매입은 알아야 고를 수 있는 말이었다.
 *   2) **정기 / 수시** — 둘은 다루는 리듬이 다르다. 정기는 "이번 달 회차 돌았나"(이행 관리),
 *      수시는 "이거 청구서 끊자"(발행 작업)다. 예전엔 정기청구가 판매 밑, 정기지출이 구매
 *      밑에 흩어져 **"이번 달 정기 건들"을 한 번에 볼 수 없었다.**
 *
 * ⚠ 이번 단계는 **배치와 라벨만** 바꾼다. 라우트 id·권한 자원은 하나도 안 건드렸다.
 *   즐겨찾기(homeFavorites)·북마크·FAQ 링크가 그대로 살아 있고, 되돌리기도 쉽다.
 *   화면 병합과 API 경로 분리는 다음 단계다 — 아래 각 자리의 ⓵⓶ 주석 참조.
 */
export const NAV_TREE = [
  { type: "leaf", id: "home", label: "홈", icon: Icon.Home },

  /* 계약관리 — 수주와 발주를 **한 도메인**에 둔다.
   *
   * ⓶ 다음 단계: 한 화면으로 합치는 것은 아직 하지 않는다.
   *   서버가 요청 본문의 kind 를 신뢰할 수 없어 '매출만 주고 매입은 막기'를 **화면이 갈려
   *   있다는 사실에 기대어** 구현하고 있다(platform/apiPerms.js 머리말). 화면을 합치면
   *   한 화면 = 한 자원이 되어 그 구분이 무너진다. 합치려면 API 를 경로로 갈라야 한다
   *   (/api/contracts/sales · /purchase). 그때까지는 도메인만 모으고 화면은 둘로 둔다.
   *
   * 계약의 비중은 줄인다 — 고객사는 계약에서 내려오지 않는다. 다만 없애지는 않는다.
   * 추후 MES 의 수주·발주 데이터와 이어붙일 자리이자 원가 계산의 근거다. */
  {
    type: "domain", id: "contract_dom", label: "계약관리", icon: Icon.Briefcase,
    sections: [
      { label: "계약", items: [
        { id: "contract_sales",    label: "수주", icon: Icon.Briefcase },
        { id: "contract_purchase", label: "발주", icon: Icon.Briefcase },
      ]},
    ],
  },

  /* 입출금 — 들어온 돈과 나간 돈, 그리고 그 결과를 보는 거래내역까지 **한 도메인**.
   *
   * 예전엔 입금관리·지급처리·거래내역이 최상위 셋으로 갈려 있었다. 축은 하나(돈의 방향)인데
   * 최상위가 셋이라 사이드바 위쪽이 그만큼 무거웠고, 등록하고 확인하러 가는 흐름
   * (수시입금 → 거래내역)이 도메인을 건너뛰어야 했다.
   *
   * 섹션 라벨을 '입금/출금'으로 두고 잎 이름을 사이드바에서만 '정기/수시'로 줄인다.
   * ⚠ 줄이는 것은 **사이드바 표시뿐**이다(`short`). Ctrl+K·바로가기 독·브레드크럼은
   *   부모가 안 보이므로 '정기입금/정기지급' 전체 이름을 그대로 쓴다 —
   *   거기서 '정기'가 둘이면 어느 쪽인지 가릴 수 없다.
   *
   * 급여·임금이 여기 있는 이유: hr 화면은 급여대장·용역/일용 대장·미지급 퇴직금으로
   * **전부 나가는 돈**이다. 반면 근로계약·고용형태 같은 인사 데이터는 성격이 달라
   * 아래 인사관리에 남는다 — 지급 메뉴에서 직원을 등록하게 두면 안 된다.
   *
   * ⓶ '경비'가 아직 잎으로 남아 있다. 다음 단계에서 **수시지급 안의 입력 폼 분기**로 흡수한다.
   *   경비(성격)와 정기/수시(리듬)는 서로 직교해서, 경비를 메뉴로 세우면 정기 경비(임차료·
   *   서버비)가 갈 곳이 애매해지고 정기/수시 안에 넣으면 경비가 두 군데로 흩어진다.
   *   답은 "메뉴는 하나, 폼은 둘"이다 — 등록할 때 **받은 서류가 뭔지**만 물으면
   *   세금계산서면 청구서 폼, 카드전표·영수증이면 가벼운 경비 폼으로 갈린다. */
  {
    type: "domain", id: "cash_dom", label: "입출금", icon: Icon.Recv,
    sections: [
      { label: "입금", items: [
        { id: "recurring_invoice", label: "정기입금", short: "정기", icon: Icon.Clock },
        { id: "billing_issued",    label: "수시입금", short: "수시", icon: Icon.Receipt },
      ]},
      { label: "출금", items: [
        { id: "recurring_expense", label: "정기지급", short: "정기", icon: Icon.Clock },
        { id: "billing_received",  label: "수시지급", short: "수시", icon: Icon.Receipt },
        { id: "misc_pl",           label: "경비",     icon: Icon.Wallet },
        /* 카드 대금 지급 / 내부 계좌 이체 — 둘 다 **벌지도 쓰지도 않은 돈**이라
         * 수입도 지출도 아니다(저장은 양쪽 모두 두 줄 대체 거래, api.transfer 하나를 쓴다).
         * 그런데도 **화면을 가른다.** 회계로도 화면 뼈대로도 다른 일이기 때문이다.
         *
         *   카드 대금 지급 : 예금 ↓ + 미지급금 ↓ — 빚을 갚는다.
         *                    화면 본체가 **갚을 카드 목록**(작업 목록)이다.
         *   내부 계좌 이체 : 예금 A ↓ + 예금 B ↑ — 자산 안에서 옮긴다(총액 불변).
         *                    화면 본체가 **폼 하나**다.
         *
         * ⚠ 수시지급(매입 청구서) 안에 넣지 않는다. 카드사는 세금계산서를 주지 않고,
         *   개별 카드 사용분은 이미 거래로 매입세액에 잡혀 있다(routes/tax.js).
         *   카드 대금을 청구서로 또 등록하면 **매입세액이 두 번 잡힌다.** */
        { id: "card_payment",      label: "카드 대금 지급", short: "카드 대금", icon: Icon.Card },
        { id: "transfer",          label: "내부 계좌 이체", short: "내부 이체", icon: Icon.Bank },
        { id: "hr",                label: "급여·임금", icon: Icon.Building },
      ]},
      /* 거래내역 — **조회 전용**. 등록은 위 입금·출금에서 하고 여기서는 오간 돈을 본다.
       * 섹션 라벨을 비워 둔다 — '거래내역 › 거래내역'은 한 겹이 헛돈다.
       * (라벨이 비면 사이드바가 그 줄을 안 그린다. 브레드크럼은 NAV_PATH_OF 가 이미 접는다.) */
      { label: "", items: [
        { id: "ledger", label: "거래내역", icon: Icon.Wallet },
      ]},
    ],
  },

  /* 인사관리 — 사람을 관리하는 일. 급여 '지급'은 위 지급처리로 갔다.
   * 부서·직위·급여항목·고용형태는 처음 세팅하고 거의 안 건드리므로 기준정보에 있다. */
  {
    type: "domain", id: "hr_dom", label: "인사관리", icon: Icon.Building,
    sections: [
      { label: "근로·용역", items: [
        { id: "hr_labor_contract", label: "근로계약",      icon: Icon.Sign },
        { id: "hr_outsourcing",    label: "기타 용역·일용", icon: Icon.Briefcase },
      ]},
    ],
  },

  /* 세무관리 — 지급처리 밑에 넣지 않는다.
   *   · 부가세는 지급만이 아니다. **환급이면 입금**이라 지급 메뉴에 두면 갈 곳이 없다.
   *   · 이 화면이 하는 일은 '신고 자료 준비'고 납부는 그 결과일 뿐이다.
   *   · 원천세·4대보험은 급여에 딸린 것이고 법인세는 또 별건이라, 한 덩어리로 묶으면 섞인다.
   * "낼 세금이 지급 예정에 떠야 한다"는 요구는 맞지만 그건 자금 현황이 할 일이지
   * 메뉴 위치 문제가 아니다. */
  {
    type: "domain", id: "tax_dom", label: "세무관리", icon: Icon.Doc,
    sections: [
      { label: "신고", items: [
        { id: "tax_vat", label: "부가세",   icon: Icon.Doc },
        { id: "tax_etc", label: "기타세액", icon: Icon.Doc },
      ]},
    ],
  },

  /* 문서업무 — **만들어서 넘기는 것들**만 남는다.
   *
   * 예전 이름은 '사무업무'였고 문서와 보고서를 함께 담고 있었다. 보고서를 경영관리로
   * 올리면서(대표가 직접 보는 자리) 여기엔 문서만 남았으므로 이름도 그에 맞춘다.
   *
   * 이 도메인에 들어오는 이유는 대개 손이 가는 일이 있어서다 — 결의서를 끊는다,
   * 정산내역서를 보낸다, 견적을 요청한다. 그날 안에 끝내야 하는 것들이다.
   *
   * ⚠ 자금일보는 매일 아침 제일 먼저 여는 화면인데 이제 경영관리 밑이다. 홈에 그날 숫자가
   *   카드로 떠 있어 그 우려를 덜지만, 실사용에서 "찾기 어렵다"가 나오면 다시 올린다. */
  {
    type: "domain", id: "office_dom", label: "문서업무", icon: Icon.Doc,
    sections: [
      /* 문서가 먼저다. 이 도메인에 들어오는 이유는 대개 **만들어서 넘길 것**이 있어서다
         (결의서를 끊는다, 정산내역서를 보낸다, 견적을 요청한다) — 손이 가는 일이라
         그날 안에 끝내야 한다. 보고서는 숫자를 확인하러 오는 것이라 급하지 않고,
         홈과 경영관리에도 같은 숫자가 카드로 떠 있다.
         회사마다 쓰는 양식이 다르다. 보고서가 이미 회사별로 켜고 끄는 구조(scope)를
         갖고 있으므로, 문서도 같은 방식으로 넓힐 자리다(⓶ 다음 단계). */
      { label: "문서", items: [
        { id: "doc",          label: "지급결의서", icon: Icon.Sign },
        { id: "settlement",   label: "정산내역서", icon: Icon.Doc },
        { id: "quote_req",    label: "견적요청서", icon: Icon.Doc },
        { id: "purchase_req", label: "구매품의서", icon: Icon.Receipt },
      ]},
    ],
  },

  {
    /* 재무관리 — 성과(손익)와 재무(대차)는 성격이 다르다. 일반 거래와 섞으면 헛갈린다.
     * 대출 원금·투자금은 손익이 아니라 부채·자본이다(server/lib/pnl.js). */
    type: "domain", id: "finance", label: "재무관리", icon: Icon.Bank,
    sections: [
      { label: "자금 조달", items: [
        { id: "finance_loan",       label: "차입금", icon: Icon.Wallet },
        { id: "finance_investment", label: "투자",   icon: Icon.Trend },
      ]},
      /* 조달과 운용은 한 쌍이다. 적금은 대출의 거울상이라(매월 넣고 만기에 받는다)
       * 같은 도메인에서 마주보게 둔다. 보통예금·카드 같은 '결제수단'은 기준정보에 남는다 —
       * 예적금은 묶여 있어 당장 못 쓰는 돈이라 성격이 다르다. */
      { label: "자금 운용", items: [
        { id: "finance_savings", label: "적금·정기예금·보증금", icon: Icon.Bank },
        /* 대여금 — 빌려준 돈. 차입금(자금 조달)과 마주보는 자리라 '자금 운용'에 둔다.
           빌려준 돈은 안 적으면 잊힌다 — 적을 자리가 아예 없던 항목이다. */
        { id: "finance_lending", label: "대여금", icon: Icon.Wallet },
      ]},
      { label: "현황", items: [
        { id: "finance_dash", label: "재무 현황", icon: Icon.Chart },
      ]},
    ],
  },

  {
    type: "domain", id: "mgmt", label: "경영관리", icon: Icon.Trend,
    /* 보고서를 여기로 올린다.
     * 원래는 경리가 뽑아 대표에게 넘기는 자료라 사무업무에 있었다. 그런데 **대표가 직접
     * 보라고 만든 자리가 경영관리**다. 보고서를 사무업무에 두면 대표는 못 찾고, 경리가
     * 뽑아 넘기는 일을 계속하게 된다 — 경영관리를 만든 이유와 어긋난다.
     * 위치를 옮겨도 경리가 잃는 것은 없다. 접근을 막는 것은 메뉴가 아니라 권한이다
     * (platform/permissions.js RESOURCES + 회사별 scope).
     *
     * ⓷ 다음 단계: 아래 잎 여섯을 **보고서 카탈로그로 흡수**해 '보고서' 잎 하나로 만든다.
     *   분류 축은 '누가 보는가' — 대표가 보는 것(자금 현황·매입매출)과 경리가 쓰는 것
     *   (일계표·전표 목록)은 한 목록에 평평하게 두면 대표 쪽 자리의 뜻이 옅어진다.
     *   ⚠ 그때 이름도 다시 본다 — 일계표·전표 목록은 엄밀히 '보고서'가 아니라 장부다. */
    sections: [
      { label: "보고서", items: [
        { id: "report",          label: "보고서",         icon: Icon.Chart },
        { id: "report_daily",    label: "일계표",         icon: Icon.Book },
        /* 전표 목록(분개장) — 일계표가 '하루치 집계'라면 이건 '기간 전체를 전표 줄로'.
           신고철에 세무사에게 넘기거나 회계 프로그램에 올릴 때 쓴다. 그때까지는
           거래내역 CSV 를 받아 손으로 분개를 만들어야 했다. */
        { id: "voucher_book",    label: "전표 목록",       icon: Icon.Doc },
        { id: "cash_report",     label: "자금일보",       icon: Icon.Bank },
        { id: "payment_run",     label: "매입 결제내역",   icon: Icon.Bank },
        { id: "purchase_status", label: "매입·매출 현황",  icon: Icon.Chart },
        /* 자금일보와 같은 데이터, 다른 축 — 자금일보는 오늘부터 N일 롤링(매일 아침 보는 것),
           자금 현황은 주·월·분기·년 구간(대표가 "이 달에 도나"를 보는 것). */
        { id: "fund_status",     label: "자금 현황",       icon: Icon.Chart },
      ]},
      { label: "현황", items: [
        { id: "mgmt_dash", label: "대시보드",   icon: Icon.Trend },
        { id: "mgmt_ask",  label: "어시스턴트", icon: Icon.Sparkle },
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
    { id: "master_account",         label: "계좌",      icon: Icon.Bank },
    { id: "master_card",            label: "카드",      icon: Icon.Card },
    /* (제거) '계좌 잔액' — 계좌 화면과 **같은 것을 두 곳에서** 다루고 있었다.
     * 목록에 이미 잔액 칸이 있는데 잔액을 고치려면 다른 메뉴로 가야 했고,
     * "계좌에서 볼까 계좌 잔액에서 볼까"가 매번 갈렸다.
     * 현재 잔액·초기잔액·조정 이력·잔액 조정을 전부 계좌 상세 안으로 넣었다.
     * 라우트·권한 자원은 살려 둔다(HIDDEN_LEAVES) — 옛 링크가 계좌 화면으로 들어온다. */
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
  { id: "settings_reports",  label: "보고서",    icon: Icon.Chart },
  { id: "settings_closing",  label: "월 마감",   icon: Icon.Bank },
  // 변경 이력 — 회사 마스터만 열린다(서버가 막고, 화면도 마스터가 아니면 타일을 감춘다)
  { id: "settings_audit",    label: "변경 이력", icon: Icon.Doc },
]

/* 사이드바·포털에서는 뺐지만 **살아 있는 화면** — 라우트·권한 자원·검색은 그대로 둔다.
 * 'contract'(주문 전체 목록)는 수주/발주 두 메뉴와 같은 화면이라 트리에서 뺐지만,
 *   · 주문 상세(contract_detail)의 브레드크럼이 이 라우트로 돌아오고
 *   · 자주 쓰진 않아도 '수주+발주를 한 표에서' 보고 싶을 때가 있다(Ctrl+K)
 * 그래서 없애지 않고 감춘다. 기준정보·환경설정 잎을 다루는 방식과 같다. */
export const HIDDEN_LEAVES = [
  { id: "contract", label: "주문 전체", icon: Icon.Briefcase, domain: "계약관리", section: "계약" },
  /* 미수금·미지급금 — 대금 청구서와 같은 화면이라 트리에서 뺐지만 살아 있다.
     홈 화면·알림·거래내역 KPI가 이 라우트로 들어오고, Ctrl+K 에서 '미수금'으로 찾으면
     청구서 화면이 '미정산' 필터로 열린다. 권한 자원(ar·ap)도 그대로 유지된다. */
  { id: "ar", label: "미수금 (수시입금)",   icon: Icon.Recv, domain: "입금관리", section: "입금" },
  { id: "ap", label: "미지급금 (수시지급)", icon: Icon.Pay,  domain: "지급처리", section: "지급" },
  /* 계좌 잔액 — 계좌 상세 안으로 들어갔지만 라우트는 살아 있다(계좌 화면을 띄운다).
     '잔액'·'통장잔고'로 찾는 사람이 실제로 있어서 Ctrl+K 에서 걸려야 하고,
     권한 자원(master_accountBalance)은 잔액 조회 게이트가 아직 참조한다
     (server/routes/accounts.js canSeeBalance). */
  { id: "master_accountBalance", label: "계좌 잔액 (계좌)", icon: Icon.Bank, domain: "기준정보", section: "자금·자산" },
  /* 잡손익 — 2026-08 재편에서 메뉴에서 뺐다. 영업외 수익(잡수익·환급금·이자)이라 건수가
     아주 적고, 그 몇 건 때문에 상시 메뉴 한 칸을 쓰는 게 맞지 않았다. 거래 등록에서
     비목으로 고르면 되고, 조회는 거래내역에서 한다.
     라우트·권한 자원은 살려 둔다 — 옛 링크와 Ctrl+K('잡수익')가 여전히 들어온다. */
  { id: "misc_income", label: "잡손익", icon: Icon.Trend, domain: "지급처리", section: "지급" },
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

/* 잎 id → 브레드크럼에 세울 자리 = **사이드바에서 그 화면이 있는 길**.
 * 크럼을 손으로 적어두면 메뉴를 옮길 때마다 어긋난다(실제로 21개가 어긋나 있었다).
 * 트리가 하나뿐인 원본이 되게 여기서 뽑는다.
 *
 * 섹션에 잎이 하나뿐이면 섹션 이름은 뺀다 — 한 칸이 늘 뿐 길을 알려주지 않는다.
 *   '인사급여 › 인사·급여 › 인사관리' → '인사급여 › 인사관리'
 *   '재무관리 › 현황 › 재무 현황'      → '재무관리 › 재무 현황' */
export const NAV_PATH_OF = {}
for (const node of NAV_TREE) {
  if (node.type !== "domain") continue
  for (const s of node.sections) for (const it of s.items) {
    NAV_PATH_OF[it.id] = s.items.length > 1 ? [node.label, s.label, it.label] : [node.label, it.label]
  }
}

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
  // 판매·수주(매출)
  // 라벨이 '수주'이 됐으니 옛 이름(매출 주문)으로 찾는 사람이 못 찾으면 안 된다.
  // ⚠ '발주'는 여기 넣지 않는다 — 발주 메뉴(우리가 낸 발주)와 헷갈린다.
  //    다만 '발주처'(우리에게 발주한 고객사)로 찾는 사람은 여기가 맞다.
  /* ⚠ '계약'을 검색어로 **남겨 둔다.** 화면 이름은 수주/주문으로 바뀌었지만
     쓰던 사람은 한동안 '계약'으로 찾는다. 옛 이름으로 못 찾으면 이름을 바꾼 게 아니라
     기능이 사라진 걸로 읽힌다(같은 이유로 '미수금'도 남겨 뒀다). */
  contract_sales:   '매출주문 매출 수주 납품주문 오더 주문 발주처 계약 수주계약 매출계약',
  /* 미수금 메뉴를 청구서로 합치면서 그 검색어를 여기로 옮겼다 —
     경리는 '미수금·받을돈·연체'로 찾지 '대금 청구서'로 찾지 않는다. */
  billing_issued:   '세금계산서 계산서 청구 발행 매출 인보이스 수금 미수금 받을돈 채권 외상매출금 미수 연체 독촉 회수 미정산 대금청구서 수시입금 수시청구',
  /* 라벨이 '정기청구' → '정기입금'이 됐다. 옛 이름으로 못 찾으면 이름이 바뀐 게 아니라
     기능이 사라진 걸로 읽힌다(수주·미수금과 같은 이유). */
  recurring_invoice:'정기 매달 월정액 자동청구 구독 정기청구 정기입금 정기수금',
  ar:               '받을돈 채권 외상매출금 미수 연체 독촉 회수',
  // 매입
  contract_purchase:'매입주문 매입 발주 외주주문 하도급 구매주문 주문 계약 발주계약 매입계약',
  billing_received: '매입세금계산서 수취 매입계산서 청구받은 미지급금 줄돈 채무 외상매입금 미지급 결제 지급처리 미정산 대금청구서 수시지급 수시결제',
  recurring_expense:'정기지출 고정비 임차료 월세 리스 자동이체 정기지급 정기결제',
  ap:               '줄돈 채무 외상매입금 미지급 결제 지급처리',
  // 경비
  misc_pl:          '경비 비용 지출 소액 카드값 잡비 영수증 카드전표',
  misc_income:      '잡수익 기타수익 이자수익 환급',
  // 문서
  doc:              '결의서 지출결의 품의 결재 승인',
  settlement:       '정산 출장비 가지급 여비 경비정산',
  quote_req:        '견적 RFQ 단가문의',
  purchase_req:     '품의 구매요청 발주요청 稟議',
  payment_run:      '결제내역 이체 일괄이체 송금 지급명단 매입처결제',
  /* 옛 이름('계좌 이체')과 서로의 말을 양쪽에 다 남긴다 — 카드값을 처리하려고 '이체'로
     찾는 사람, 통장 이동을 하려고 '카드'로 잘못 찾는 사람이 둘 다 있다. */
  card_payment:     '카드대금 카드결제 카드값 법인카드 신용카드 결제일 이체 계좌이체 갚기',
  transfer:         '이체 계좌이체 통장이체 자금이동 옮기기 내부이체 대체 시재',
  purchase_status:  '매입현황 주별 품목별 자재 구매현황 매출현황',
  fund_status:      '자금현황 자금수지 자금계획 월별 분기 주별 예정 잔고 현금흐름',
  // 장부
  ledger:           '거래 입출금 통장내역 원장 전표 입금 출금',
  contract:         '주문조회 주문목록 전체주문 수주발주 통합',
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
  master_account:       '통장 계좌 은행 예금 결제수단 계좌카드',
  master_card:          '카드 법인카드 신용카드 체크카드 결제일 카드대금 계좌카드',
  master_accountBalance:'잔액 통장잔고 시재',
  master_insurance:     '보험 화재보험 배상책임 보험료 증권',
  // 인사급여
  /* 라벨이 '인사관리' → '급여·임금'이 됐다(지급처리로 이동). 옛 이름을 남겨 둔다 —
     이 화면을 '인사관리'로 기억하는 사람이 아직 있다. 직원·근로계약은 인사관리 도메인이다. */
  hr:               '인사 급여 급여대장 월급 인건비 직원 사원 인사관리 급여임금 임금 상여 퇴직금',
  hr_labor_contract:'근로계약 정규직 채용 입사 퇴사 4대보험',
  hr_outsourcing:   '용역 프리랜서 일용직 외주인력 사업소득 기타소득',
  hrbase_department:'부서 조직 팀',
  hrbase_position:  '직위 직급 직책',
  hrbase_payrollItems:'급여항목 수당 공제 기본급 식대',
  hrbase_employType:'고용형태 근로형태',
  // 재무
  finance_loan:     '대출 차입 융자 상환 이자 원리금',
  finance_investment:'투자 출자 증자 유치 가수금',
  finance_savings:  '예금 적금 정기예금 만기 예치 보증금 임차보증금 관리비보증금',
  finance_lending:  '대여금 빌려준돈 채권 채권명부 대여 회수 원리금 이자수익',
  finance_dash:     '재무 부채 자본 차입현황',
  // 경영
  cash_report:      '자금 자금계획 현금흐름 잔액예측 자금수지',
  report:           '보고서 리포트 통계 분석 현황',
  report_daily:     '일계표 일보 분개 차대변 시산표',
  voucher_book:     '전표 분개장 분개 차변 대변 신고 세무사 회계프로그램 이관 원장',
  mgmt_dash:        '경영 대시보드 지표 KPI 현황판',
  mgmt_ask:         '질의 도우미 물어보기',
  // 환경설정
  settings_company: '회사정보 사업자등록증 대표자 회사',
  settings_user:    '사용자 계정 권한 로그인 비밀번호 역할',
  settings_approval:'결재선 결재 승인라인',
  settings_reports: '보고서 리포트 사용 설정 노출 켜기 끄기',
  settings_closing: '마감 월마감 장부마감 결산',
  settings_audit:   '변경이력 감사 로그 기록 이력 누가 추적 삭제기록 접속기록',
}

// ── 홈택스식 다단계 포털 구조 (도메인 → 카테고리 → 그룹 → 화면) ──
// 카테고리: route(바로 화면) 또는 groups(하위 라인 → 화면 버튼들, 포털 페이지)
export const PORTAL = [
  /* NAV_TREE 와 **같은 구조로 맞춘다.** 둘이 어긋나면 홈과 사이드바가 다른 말을 하고,
     실제로 예전에 재무관리가 사이드바에만 있어 홈에서는 들어갈 길이 없던 적이 있다. */
  {
    id: 'contract_dom', label: '계약관리', icon: Icon.Briefcase,
    categories: [
      { id: 'contract_sales_c',    label: '수주', icon: Icon.Briefcase, desc: '받은 주문', route: 'contract_sales' },
      { id: 'contract_purchase_c', label: '발주', icon: Icon.Briefcase, desc: '보낸 주문', route: 'contract_purchase' },
    ],
  },
  {
    /* NAV_TREE 의 입출금과 같은 모양. 트리와 포털이 어긋나면 홈과 사이드바가 다른 말을 한다
       (거래내역이 트리에만 있고 타일이 없어 홈에서 못 들어가던 적이 실제로 있다). */
    id: 'cash_dom', label: '입출금', icon: Icon.Recv,
    categories: [
      { id: 'cash_in', label: '입금', icon: Icon.Recv, desc: '정기·수시 청구와 수금', groups: [
        { label: '', items: ['recurring_invoice', 'billing_issued'] },
      ]},
      { id: 'cash_out', label: '출금', icon: Icon.Pay, desc: '정기·수시 지급, 경비·카드·이체·급여', groups: [
        { label: '', items: ['recurring_expense', 'billing_received', 'misc_pl', 'card_payment', 'transfer', 'hr'] },
      ]},
      { id: 'ledger_all', label: '거래내역', icon: Icon.Wallet, desc: '오간 돈을 모아 봅니다 (조회 전용)', route: 'ledger' },
    ],
  },
  {
    id: 'tax_dom', label: '세무관리', icon: Icon.Doc,
    categories: [
      { id: 'tax_all', label: '신고', icon: Icon.Doc, desc: '부가세·기타세액 신고', groups: [
        { label: '', items: ['tax_vat', 'tax_etc'] },
      ]},
    ],
  },
  {
    id: 'hr_dom', label: '인사관리', icon: Icon.Building,
    categories: [
      { id: 'hr_labor', label: '근로·용역', icon: Icon.Sign, desc: '근로계약·용역·일용', groups: [
        { label: '', items: ['hr_labor_contract', 'hr_outsourcing'] },
      ]},
    ],
  },
  {
    id: 'office_dom', label: '문서업무', icon: Icon.Doc,
    categories: [
      { id: 'office_docs', label: '문서', icon: Icon.Sign, desc: '지급결의서·정산내역서·견적요청서·구매품의서', groups: [
        { label: '', items: ['doc', 'settlement', 'quote_req', 'purchase_req'] },
      ]},
    ],
  },
  {
    id: 'finance', label: '재무관리', icon: Icon.Bank,
    categories: [
      { id: 'finance_fund', label: '자금 조달', icon: Icon.Wallet, desc: '차입금·투자', groups: [
        { label: '', items: ['finance_loan', 'finance_investment'] },
      ]},
      { id: 'finance_ops',    label: '자금 운용', icon: Icon.Bank,  desc: '적금·정기예금·보증금', route: 'finance_savings' },
      { id: 'finance_status', label: '재무 현황', icon: Icon.Chart, desc: '차입·투자 현황',   route: 'finance_dash' },
    ],
  },
  {
    id: 'mgmt', label: '경영관리', icon: Icon.Trend,
    categories: [
      { id: 'mgmt_report', label: '보고서', icon: Icon.Chart, desc: '보고서·일계표·전표 목록·자금일보·자금 현황·매입 현황', groups: [
        { label: '', items: ['report', 'report_daily', 'voucher_book', 'cash_report', 'payment_run', 'purchase_status', 'fund_status'] },
      ]},
      { id: 'mgmt_biz', label: '현황', icon: Icon.Trend, desc: '대시보드·어시스턴트', groups: [
        { label: '', items: ['mgmt_dash', 'mgmt_ask'] },
      ]},
    ],
  },
]

// 포털 페이지(그룹 보유) 카테고리만 id로 조회 — App 라우팅에서 PortalScreen 렌더
export const PORTAL_CAT_BY_ID = {}
for (const d of PORTAL) for (const c of d.categories) if (c.groups) PORTAL_CAT_BY_ID[c.id] = { ...c, domainLabel: d.label }

/* 옛 라우트 → 새 라우트. **메뉴를 옮길 때 여기만 적는다.**
 *
 * 잎 id 는 절대 바꾸지 않으므로(권한 자원이자 사용자가 담아둔 바로가기의 이름이다)
 * 여기 실리는 건 **포털 페이지 id** 뿐이다. 그것도 라우트라, 옮기면 옛 주소가 죽는다 —
 * 담아둔 바로가기·북마크·FAQ 링크가 조용히 '홈'으로 떨어진다.
 *   office_report → mgmt_report : 보고서를 사무업무에서 경영관리로 올렸다(2026-08-27) */
export const ROUTE_ALIAS = {
  office_report: 'mgmt_report',
}
for (const [from, to] of Object.entries(ROUTE_ALIAS)) {
  if (PORTAL_CAT_BY_ID[to]) PORTAL_CAT_BY_ID[from] = PORTAL_CAT_BY_ID[to]
}

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

/* 잎 id → 그 잎이 놓여 있는 포털 페이지 id.
   브레드크럼에서 한 단계 위로 올라갈 때 쓴다(예: 계좌 잔액 → 기준정보).
   route 하나만 가리키는 카테고리(자금일보처럼 타일=화면인 것)는 넣지 않는다 —
   올라갈 곳이 자기 자신이라 눌러도 제자리다. */
export const PORTAL_PAGE_OF_LEAF = {}
for (const d of PORTAL) for (const c of d.categories) {
  if (c.groups) for (const g of c.groups) for (const id of g.items) PORTAL_PAGE_OF_LEAF[id] = c.id
}
for (const g of MASTER_GROUPS) for (const it of g.items) PORTAL_PAGE_OF_LEAF[it.id] = 'master'
for (const l of SETTINGS_LEAVES) PORTAL_PAGE_OF_LEAF[l.id] = 'settings'

// 도메인(일반회계·인사급여·재무관리·경영관리)에는 전용 화면이 없다 — 도메인 마디는 홈 포털로 보낸다
export const DOMAIN_LABELS = new Set(PORTAL.map(d => d.label))

/* 포털 카테고리 라우트도 소속 도메인으로 매핑(사이드바 도메인 자동 펼침).
 *
 * ⚠ **손으로 적지 않는다.** 예전엔 acct_sales·acct_docs… 를 하나씩 박아 뒀는데,
 *   2026-08 재편으로 그것들이 사라지고 새 카테고리(office_report·office_docs·tax_all)가
 *   생겼는데도 목록은 그대로였다. 그 타일에 들어가면 사이드바가 안 펼쳐지고
 *   브레드크럼도 '홈' 하나로 떨어졌다. PORTAL 을 훑어 자동으로 만든다 —
 *   타일을 더하거나 지워도 따라온다. */
for (const d of PORTAL) {
  for (const c of d.categories) {
    // groups 를 가진 것은 포털 페이지(그 자체가 라우트), route 만 있는 것은 잎으로 넘기는 타일
    if (c.groups) DOMAIN_OF[c.id] = d.id
  }
}
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
  if (route === "excel_modal" || route === "excel") return "ledger"
  /* 미수금·미지급금은 대금 청구서와 같은 화면이라 메뉴를 합쳤다(HIDDEN_LEAVES).
     그 라우트로 들어와도 사이드바에서 '대금 청구서'가 켜져야 지금 어디인지 알 수 있다 —
     안 그러면 아무것도 활성화되지 않아 길을 잃는다. */
  if (route === "ar" || route === "ledger_ar") return "billing_issued"
  if (route === "ap" || route === "ledger_ap") return "billing_received"
  if (route === "billing") return "billing_issued"
  // 환경설정 하위(settings_<tab>)는 사이드바 하단 '환경설정'을 활성으로
  if (route === "settings" || route.startsWith("settings_")) return "settings"
  return route
}
