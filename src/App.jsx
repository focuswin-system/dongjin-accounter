import { useState, useEffect, useMemo, useRef, Fragment, Component } from 'react'
import logoSymbol from './assets/company/favicon.svg'
import { Icon, useToast, useConfirm, Popover, PopItem, ToastProvider, ConfirmProvider } from './lib/ui'
import { api, setApiFailureHandler } from './lib/api'
import { NAV_TREE, DOMAIN_OF, leafIdOf, PORTAL_CAT_BY_ID, LEAF_BY_ID, MASTER_LEAVES, PORTAL_PAGE_OF_LEAF, NAV_PATH_OF } from './lib/nav'
import { PermCtx, usePerms, visibleNav, visiblePortalNode, withoutMasterOnly } from './lib/perms'
import { sessionAlive, clearSession } from './lib/session'
import { UpdateBanner } from './lib/components/UpdateBanner'
import { LoginScreen } from './screens/Login'
import { HomeScreen } from './screens/Home'
import { LedgerScreen } from './screens/Ledger'
import { TransactionForm } from './screens/Form'
import { ContractListScreen, ContractScreen, CONTRACT_LIST } from './screens/Contract'
import { DocsScreen, EvidenceScreen, EvidenceAttachDrawer, ExcelScreen, ReportsScreen } from './screens/Docs'
import { SettlementScreen } from './screens/Settlement'
import { PaymentRunScreen } from './screens/PaymentRun'
import { PurchaseStatusScreen } from './screens/PurchaseStatus'
import { FundStatusScreen } from './screens/FundStatus'
import { PurchaseReqScreen } from './screens/PurchaseReq'
import { QuoteRequestScreen } from './screens/QuoteRequest'
import { HRScreen } from './screens/HR'
import { LaborContractScreen, OutsourcingScreen } from './screens/WorkContract'
import { MasterScreen, RefMasterPanel, REF_CONFIGS, RecurringExpensePanel, RecurringInvoicePanel } from './screens/Master'
import { LoanScreen, InvestmentScreen, FinanceDashScreen } from './screens/Finance'
import { SavingsScreen } from './screens/Savings'
import { CashReportScreen, DailyTrialScreen } from './screens/CashReport'
import { BillingScreen } from './screens/Billing'
import { TaxVatScreen, OtherTaxScreen } from './screens/Tax'
import { MiscPLScreen } from './screens/MiscPL'
import { MgmtDashScreen } from './screens/Mgmt'
import { MgmtAskScreen } from './screens/MgmtAsk'
import { PortalScreen } from './screens/Portal'

/* 브레드크럼에 세울 말.
 *
 * ⚠ **사이드바에 있는 화면은 여기 적지 않는다** — nav.js NAV_PATH_OF 가 트리에서 바로 뽑는다.
 *   여기에 손으로 적어두면 메뉴를 옮길 때마다 어긋난다(실제로 21개가 어긋나 있었다:
 *   사이드바는 '인사급여 › 근로·용역 › 근로계약'인데 크럼은 '인사급여 › 근로계약'이었다).
 *
 * 남은 것은 **사이드바에 없는 라우트**뿐이다 — 필터만 걸린 하위 화면(ledger_*),
 * 메뉴에서 감춘 화면(ar·ap·contract), 포털 페이지, 모달 화면. */
const CRUMB_MAP = {
  home:            ["홈"],
  ledger_income:   ["거래내역", "입금"],
  ledger_expense:  ["거래내역", "지출"],
  ledger_ar:       ["거래내역", "미수금"],
  ledger_ap:       ["거래내역", "미지급금"],
  income:          ["입금관리", "수시입금", "입금"],
  expense:         ["지급처리", "수시지급", "지출"],
  ar:              ["입금관리", "수시입금", "미수금"],
  ap:              ["지급처리", "수시지급", "미지급금"],
  billing:         ["입금관리", "수시입금"],
  contract:        ["계약관리", "주문 전체"],
  contract_detail: ["주문", null],
  // 포털 페이지(타일 화면) — 도메인 아래 한 칸
  /* 포털 페이지(타일 화면) — 도메인 아래 한 칸.
     2026-08 재편으로 acct_* 카테고리가 사라지고 아래 셋이 새로 생겼다.
     여기 빠지면 그 타일에서 크럼이 "홈" 하나로 떨어진다(App.jsx 아래 fallback). */
  tax_all:         ["세무관리", "신고"],
  office_report:   ["사무업무", "보고서"],
  office_docs:     ["사무업무", "문서"],
  hr_labor:        ["인사관리", "근로·용역"],
  mgmt_biz:        ["경영관리"],
  master:          ["기준정보"],   // 일반회계 하위가 아니라 독립 영역(인사 기준정보까지 모은다)
  settings:        ["환경설정"],
  hr_base:         ["인사급여", "기준정보"],
  evidence:        ["증빙 관리"],
  excel:           ["엑셀 업로드"],
  excel_modal:     ["엑셀 업로드"],
};

/* 브레드크럼 마디를 누르면 갈 곳 — CRUMB_MAP과 같은 자리 순서로, 앞쪽(누를 수 있는) 마디만 적는다.
 * 마지막 마디는 지금 보고 있는 화면이라 링크가 아니다.
 *
 * 규칙은 하나다: **그 마디의 이름이 가리키는 화면으로 보낸다.**
 *   '판매·수주(매출)'·'문서'·'세무관리' 같은 포털 카테고리 이름 → 그 포털 페이지
 *   '일반회계'·'인사급여' 같은 도메인 이름 → 홈(도메인은 전용 화면이 없고 홈에 도메인 줄로 서 있다)
 *   '거래내역'·'주문'처럼 화면 이름 → 그 화면
 * 여기 없는 라우트는 nav 잎 정보(도메인·섹션)로 자동 계산한다 — 아래 crumbTargets 참고. */
const CRUMB_TO = {
  ledger_income:    ["ledger"],
  ledger_expense:   ["ledger"],
  ledger_ar:        ["ledger"],
  ledger_ap:        ["ledger"],
  /* 지워진 포털(acct_sales·acct_purchase)로 보내고 있었다. 그 해시는 CRUMB_MAP 에 남아
     '아는 라우트'로 통과한 뒤 switch 를 지나쳐 홈이 그려졌다 — 주소는 #acct_sales 인데
     화면은 홈이고 사이드바는 아무것도 안 켜진 상태였다. 이제 실제 화면으로 보낸다. */
  income:           ["home", "billing_issued"],
  expense:          ["home", "billing_received"],
  ar:               ["home", "billing_issued"],
  ap:               ["home", "billing_received"],
  billing:          ["home"],
  contract:         ["home", null],
  contract_detail:  ["contract"],
  acct_sales:       ["home"],
  acct_purchase:    ["home"],
  acct_expense:     ["home"],
  acct_docs:        ["home"],
  acct_tax:         ["home"],
  hr_labor:         ["home"],
  hr_base:          ["home"],
};

/* 크럼 각 마디의 목적지 배열을 만든다(길이는 crumbs와 같고, 링크가 없으면 null).
 * CRUMB_MAP에 없는 라우트는 크럼이 [도메인, 섹션, 화면] 꼴이라 구조에서 상위를 뽑아낼 수 있다. */
const crumbTargets = (route, crumbs) => {
  const last = crumbs.length - 1;
  const explicit = CRUMB_TO[route];
  if (explicit) return crumbs.map((_, i) => (i === last ? null : explicit[i] || null));
  const leaf = LEAF_BY_ID[route];
  if (!leaf) return crumbs.map(() => null);
  // 기준정보·환경설정은 도메인이 아니라 그 자체가 타일 페이지다
  const top = leaf.domain === "기준정보" ? "master" : leaf.domain === "환경설정" ? "settings" : "home";
  const page = PORTAL_PAGE_OF_LEAF[route] || null;
  return crumbs.map((_, i) => (i === last ? null : i === 0 ? top : page));
};

// 알림 아이콘(tone/icon 이름 → 컴포넌트)
const NOTIF_ICON = {
  Warn:    <Icon.Warn size={14}/>,
  Bell:    <Icon.Bell size={14}/>,
  Clock:   <Icon.Clock size={14}/>,
  Receipt: <Icon.Receipt size={14}/>,
  Check:   <Icon.Check size={14}/>,
};

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

const HELP_MAP = {
  home: {
    title: "홈 화면",
    items: [
      "오늘 할 일 카드에서 입금·이체를 바로 처리할 수 있어요",
      "자금 현황 카드를 클릭하면 해당 거래내역으로 이동해요",
      "처리 필요 알림을 클릭하면 해당 관리 화면으로 이동해요",
      "입금·지급 예정 항목은 D-day 기준으로 색상이 표시돼요",
    ]
  },
  ledger: {
    title: "거래내역",
    items: [
      "상단 탭으로 입금·지출·미수금·미지급금을 구분해 조회하세요",
      "필터 버튼으로 기간·비목을 조합해 원하는 거래만 볼 수 있어요",
      "행 클릭 시 상세 정보·결의서·증빙을 확인하고 바로 처리할 수 있어요",
      "증빙 ⚠️ 표시는 세금계산서가 첨부되지 않은 거래예요",
    ]
  },
  contract: {
    title: "주문 관리",
    items: [
      "미수금·미지급금·주문목록 탭으로 구분해 조회하세요",
      "기간·비목 필터로 원하는 기간의 데이터만 볼 수 있어요",
      "담당자 필터로 PM별 주문을 구분해 조회할 수 있어요",
      "행 클릭 시 주문 상세·결의서·증빙 이력을 확인할 수 있어요",
    ]
  },
  contract_detail: {
    title: "주문 상세",
    items: [
      "주문 상세에서 결의서와 증빙 이력을 한 번에 확인하세요",
      "입금·지출 등록으로 해당 주문 거래내역을 바로 추가할 수 있어요",
      "진행률 바는 주문금액 대비 입금 완료 비율이에요",
      "파일 첨부로 계약서·발주서·검사성적서를 등록할 수 있어요",
    ]
  },
  hr: {
    title: "인사관리",
    items: [
      "직원 등록·근로계약은 근로계약 메뉴에서 관리해요",
      "급여대장 탭에서 '급여대장 생성' 후 명세서·지급을 처리하세요",
      "용역·일용 지급은 용역·일용 대장 탭과 기타 용역·일용 메뉴에서 확인해요",
      "4대보험·소득세는 자동 계산이 아니라 공단·세무서 고지 금액을 명세서에 직접 입력해요",
    ]
  },
  report: {
    title: "보고서",
    items: [
      "각 보고서 카드를 클릭하면 상세 자료를 확인할 수 있어요",
      "월별·주문별·발주처별로 나눠 세무사 전달 자료를 준비하세요",
      "보고서 화면에서 인쇄·PDF 저장을 바로 실행할 수 있어요",
      "기준 월은 화면 상단에 표시된 날짜를 기준으로 집계돼요",
    ]
  },
  billing: {
    title: "청구 관리",
    items: [
      "판매·수주(매출)의 대금 청구서에서 미수금을, 매입의 대금 청구서에서 미지급금을 관리하세요",
      "청구서와 실제 거래내역을 매칭하면 미수금이 자동으로 차감돼요",
      "기한 지남 항목을 클릭해 독촉 또는 재청구 처리를 할 수 있어요",
      "청구서 발행 버튼으로 주문 청구 일정과 연동된 청구를 빠르게 등록해요",
    ]
  },
  master: {
    title: "설정",
    items: [
      "회사 정보·거래처·계좌 등 기본 정보를 관리하세요",
      "비목·계정과목은 실무에 맞게 직접 추가·수정할 수 있어요",
      "세율·보험료율 등 연간 변경 사항을 여기서 갱신하세요",
      "데이터 초기화는 설정 하단에서 접근할 수 있어요",
    ]
  },
  doc: {
    title: "결의서",
    items: [
      "외주가공비·원자재 등 지출 결의서를 항목별로 확인하세요",
      "승인 요청 탭에서 미결 결의서를 빠르게 처리할 수 있어요",
      "결의서 클릭 시 세부 내역과 첨부 증빙을 확인하세요",
      "결의서 승인 후 미지급금 탭에서 이체 처리가 가능해요",
    ]
  },
  misc_pl: {
    title: "일반 경비 · 잡손익",
    items: [
      "주문·품목에 붙지 않는 운영비(임차료·통신비·보험료 등)를 등록하는 화면이에요",
      "매입(원가)과 달리 여기 지출은 판매관리비로 잡혀요",
      "행을 클릭하면 바로 수정하고, 오른쪽 삭제 버튼으로 지울 수 있어요",
      "매달 같은 날 나가는 지출은 매입의 '정기지출'에 걸어두세요",
    ]
  },
  recurring: {
    title: "정기 반복",
    items: [
      "무엇을 · 언제 · 얼마씩 반복할지 조건을 설정하는 곳이에요",
      "정기청구의 실제 발행은 판매·수주(매출) → 대금 청구서의 '발행 예정'에서 해요",
      "등록일 이전 회차는 소급 생성되지 않아요 (과거분은 직접 입력)",
      "비활성으로 돌리면 다음 회차부터 생성이 멈춰요",
    ]
  },
  evidence: {
    title: "증빙 관리",
    items: [
      "세금계산서·영수증·발주서 등 증빙을 여기서 등록·관리해요",
      "파일 첨부 후 해당 거래와 연결하면 자동 매칭이 돼요",
      "누락 증빙은 홈 화면 알림에서도 확인할 수 있어요",
      "엑셀 업로드로 여러 증빙을 한 번에 등록할 수 있어요",
    ]
  },
};

// 화면 렌더 중 예외가 나도 앱 전체가 백지가 되지 않도록 방어.
// 라우트가 바뀌면 에러 상태를 자동 해제해 다른 화면으로 빠져나갈 수 있게 함.
class ErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  componentDidUpdate(prev) {
    if (prev.routeKey !== this.props.routeKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (this.state.error) {
      return (
        <div className="card card-pad fade-up" style={{ textAlign: "center", padding: "48px 24px", maxWidth: 460, margin: "40px auto" }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: "var(--neg-soft)", color: "var(--neg-ink)", display: "grid", placeItems: "center", margin: "0 auto 16px" }}>
            <Icon.Warn size={24}/>
          </div>
          <div className="fw-700" style={{ fontSize: 16, marginBottom: 8 }}>이 화면을 표시하는 중 문제가 발생했어요</div>
          <div className="text-sm text-muted" style={{ lineHeight: 1.6, marginBottom: 20 }}>
            다른 메뉴로 이동하거나 다시 시도해 주세요. 문제가 계속되면 데이터를 확인해 주세요.
          </div>
          <button className="btn primary" onClick={() => this.setState({ error: null })}>다시 시도</button>
        </div>
      )
    }
    return this.props.children
  }
}

// 비활성화된 메뉴용 플레이스홀더 (라우트로 직접 접근해도 기능 노출 안 함)
function ComingSoon({ title }) {
  return (
    <div className="card card-pad fade-up" style={{ textAlign: "center", padding: "56px 24px", maxWidth: 460, margin: "40px auto" }}>
      <div style={{ width: 48, height: 48, borderRadius: 14, background: "var(--surface-3)", color: "var(--muted-2)", display: "grid", placeItems: "center", margin: "0 auto 16px" }}>
        <Icon.Clock size={24}/>
      </div>
      <div className="fw-700" style={{ fontSize: 16, marginBottom: 8 }}>{title}는 준비 중이에요</div>
      <div className="text-sm text-muted" style={{ lineHeight: 1.6 }}>이 메뉴는 현재 비활성화되어 있어요. 곧 제공될 예정입니다.</div>
    </div>
  );
}

// 권한 없는 화면에 주소로 직접 들어왔을 때. 서버가 이미 403을 주므로 데이터는 안 나오지만,
// 빈 화면에 에러 토스트만 뜨면 고장으로 보인다 → 왜 못 보는지 알려준다.
function NoPermission({ title }) {
  return (
    <div className="card card-pad fade-up" style={{ textAlign: "center", padding: "56px 24px", maxWidth: 460, margin: "40px auto" }}>
      <div style={{ width: 48, height: 48, borderRadius: 14, background: "var(--surface-3)", color: "var(--muted-2)", display: "grid", placeItems: "center", margin: "0 auto 16px" }}>
        <Icon.Warn size={24}/>
      </div>
      <div className="fw-700" style={{ fontSize: 16, marginBottom: 8 }}>{title || "이 화면"}을(를) 볼 권한이 없어요</div>
      <div className="text-sm text-muted" style={{ lineHeight: 1.6 }}>
        회사 관리자에게 권한을 요청하세요.<br/>환경설정 › 사용자에서 역할을 배정할 수 있어요.
      </div>
    </div>
  );
}

function AppInner({ onLogout, user }) {
  // 권한 없는 메뉴는 아예 그리지 않는다. 눌러서 403을 받는 것보다 없는 게 낫다.
  const { perms, can: canDo } = usePerms();
  const navTree = useMemo(() => visibleNav(perms), [perms]);
  /* 기준정보는 15개 화면의 묶음이라, 그중 하나라도 볼 수 있으면 메뉴를 세운다.
     하나도 못 보는 사람에게 빈 페이지로 가는 메뉴를 보여줄 이유가 없다. */
  const masterVisible = useMemo(() => MASTER_LEAVES.some(l => canDo(l.id)), [perms]);
  const [route, setRoute] = useState("home");
  const [contractId, setContractId] = useState("CT-2026-101");
  const [focusInvoiceId, setFocusInvoiceId] = useState(null);   // 홈 할 일 → 청구서 바로 열기
  const [contractName, setContractName] = useState("");
  const [txnForm, setTxnForm] = useState(null); // null | { kind, contract? }
  const [txnVersion, setTxnVersion] = useState(0);
  // 잎 id → 처리가 밀린 건수 (사이드바 배지). 0이면 배지를 그리지 않는다.
  const [overdueCycles, setOverdueCycles] = useState({ recurring_invoice: 0, recurring_expense: 0, finance_loan: 0 });
  const [evidenceAttach, setEvidenceAttach] = useState(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifRead, setNotifRead] = useState(false);
  const [notifs, setNotifs] = useState([]);
  const [faqOpen, setFaqOpen] = useState(false);
  const [idlePhase, setIdlePhase] = useState("hidden"); // "hidden" | "showing" | "dismissing"
  const [nudgeMode, setNudgeMode] = useState(() => localStorage.getItem("nudgeMode") || "always");
  const idleRef = useRef(null);
  const contentRef = useRef(null);   // 데스크톱 내부 스크롤 컨테이너(.content) — 라우트 전환 시 맨 위로
  const toast = useToast();
  const { confirm } = useConfirm();
  const unreadCount = notifRead ? 0 : notifs.length;

  // ── 놓친 비동기 실패를 사용자에게 알린다 ──
  // 화면 코드 대부분은 load() 안에서 api 를 await 만 하고 try 로 감싸지 않는다(호출 265곳,
  // try 12곳). ErrorBoundary 는 '렌더' 오류만 잡으므로 이런 실패는 어디에도 걸리지 않고,
  // 결과적으로 화면이 조용히 빈 상태로 남는다 — 사용자는 데이터가 없는 것인지 서버가
  // 죽은 것인지 알 수 없다. 마지막 안전망으로 여기서 받아 토스트로 알린다.
  //
  // 근본 해결은 각 호출부가 실패를 다루는 것이지만, 그때까지도 '조용히 실패'만은 없어야 한다.
  useEffect(() => {
    // 한 화면이 API를 5~10번 부르므로 서버가 죽으면 같은 문구가 그만큼 쏟아진다.
    // 사용자에게 필요한 정보는 "서버가 안 된다" 하나뿐이다 — 잠깐 사이 같은 문구는 한 번만.
    let lastMsg = '', lastAt = 0;
    const announce = (msg) => {
      const now = Date.now();
      if (msg === lastMsg && now - lastAt < 3000) return;
      lastMsg = msg; lastAt = now;
      toast.push(msg, { tone: 'warn' });
    };

    // (1) 요청 계층이 직접 알리는 인프라 실패.
    //     조회 메서드는 실패를 `catch { return [] }` 로 삼켜 화면을 빈 목록으로 만든다.
    //     rejection 이 생기지 않으므로 아래 (2) 로는 절대 잡히지 않는다 — 이 경로가 본체다.
    setApiFailureHandler((err) => announce(err.message));

    // (2) 아무도 잡지 않은 나머지 실패(마지막 안전망).
    const onRejection = (e) => {
      const err = e.reason;
      // 401은 이미 로그인 화면으로 되돌리는 중이라 토스트가 오히려 혼란스럽다.
      if (err?.kind === 'auth') { e.preventDefault(); return }
      // (1)에서 이미 알린 오류를 두 번 띄우지 않는다.
      if (!err?.notified) announce(err?.message || '요청을 처리하지 못했어요.');
      // 콘솔에는 원본을 남긴다(운영 진단용). 기본 'Uncaught (in promise)' 는 막는다.
      console.warn('[처리되지 않은 요청 실패]', err);
      e.preventDefault();
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      setApiFailureHandler(null);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [toast]);

  // 실데이터 알림 로드 (거래/청구서 변동 시 갱신)
  useEffect(() => {
    let alive = true
    api.getNotifications().then(list => { if (alive) { setNotifs(list); setNotifRead(false); } }).catch(() => {})
    return () => { alive = false }
  }, [txnVersion]);

  /* '처리가 밀린 건수' — 사이드바 배지.
   * 이행 관리 화면을 만들어도 그 화면을 열지 않으면 밀린 게 있는지 모른다.
   * 정기 회차(청구·지출)와 차입금 상환이 같은 성격이라 함께 센다 —
   * 셋 다 "예정일이 지났는데 처리되지 않은 것"이고, 방치하면 그 달 장부에 구멍이 난다.
   * 라우트가 바뀔 때 다시 센다(그 화면에 있는 동안은 화면 자체가 진실을 보여준다). */
  useEffect(() => {
    let alive = true
    const overdueOf = (list) => (list || []).filter(c => c.state === 'overdue').length
    // 권한 없는 화면의 배지는 세지 않는다 — 세려고 부르면 403만 쌓이고 숫자는 어차피 안 나온다
    const skip = Promise.resolve([])
    Promise.all([
      canDo("recurring_invoice") ? api.getPendingRecurring() : skip,
      canDo("recurring_expense") ? api.getPendingRecurringExpenses() : skip,
      canDo("finance_loan") ? api.getFinanceSummary() : skip,
    ])
      .then(([sales, purchase, finance]) => {
        if (!alive) return
        setOverdueCycles({
          recurring_invoice: overdueOf(sales),
          recurring_expense: overdueOf(purchase),
          finance_loan: finance?.overdue_count || 0,
        })
      })
      .catch(() => {})
    return () => { alive = false }
  }, [route, txnVersion, perms]);

  useEffect(() => {
    const apply = () => {
      const h = window.location.hash.replace("#", "");
      // 알려진 라우트면 반영한다. CRUMB_MAP에만 의존하면 기준정보·인사기준·환경설정 하위탭
      // (master_/hrbase_/settings_)과 포털 카테고리가 빠져, 새로고침·뒤로가기 시 홈으로 튕겼다.
      const known = CRUMB_MAP[h] || LEAF_BY_ID[h] || PORTAL_CAT_BY_ID[h]
        || /^(master_|hrbase_|settings_)/.test(h);
      if (h && known) setRoute(h);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  /* Ctrl+K / Esc.
   *
   * Esc 는 **지금 열려 있는 것 중 맨 위 하나만** 닫는다. 여러 개를 한꺼번에 닫으면
   * 명령팔레트를 닫으려던 Esc 가 뒤에 있던 화면까지 함께 접는다.
   *
   * 캡처 단계로 듣는 이유: 드로어도 Esc 를 쓴다(닫기 확인). 무언가 닫았으면
   * preventDefault 로 표시해 두면, 아래 깔린 드로어가 같은 Esc 로 "정말 닫을까요?"를
   * 묻지 않는다(lib/ui.jsx Drawer). 버블 단계로 두면 등록 순서에 따라 누가 먼저
   * 받을지가 달라져서, 팔레트를 드로어 위에 띄운 순간부터 순서가 뒤집힌다. */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); setCmdOpen(true); return;
      }
      if (e.key !== "Escape") return;
      if (cmdOpen)     { setCmdOpen(false);     e.preventDefault(); return; }
      if (faqOpen)     { setFaqOpen(false);     e.preventDefault(); return; }
      if (sidebarOpen) { setSidebarOpen(false); e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cmdOpen, faqOpen, sidebarOpen]);

  // nudgeMode → localStorage 저장
  useEffect(() => { localStorage.setItem("nudgeMode", nudgeMode); }, [nudgeMode]);

  // 유휴 감지 → nudgeMode에 따라 동작
  useEffect(() => {
    if (faqOpen || nudgeMode === "off") { setIdlePhase("hidden"); return; }
    if (nudgeMode === "always")         { setIdlePhase("showing"); return; }

    // "auto" 모드: 60초 미활동 시 nudge 표시
    const startTimer = () => {
      clearTimeout(idleRef.current);
      idleRef.current = setTimeout(() => setIdlePhase("showing"), 60000);
    };
    // 마우스 이동은 타이머만 리셋 (nudge는 건드리지 않음 — 버튼 클릭 가능하도록)
    const onMove   = () => startTimer();
    // 클릭·키·스크롤은 타이머 리셋 + nudge 닫기
    const onAction = () => {
      setIdlePhase(prev => prev === "showing" ? "dismissing" : prev);
      startTimer();
    };
    const moveEvents   = ["mousemove", "touchmove"];
    const actionEvents = ["click", "keydown", "touchstart"];
    moveEvents.forEach(e   => window.addEventListener(e, onMove,   { passive: true }));
    actionEvents.forEach(e => window.addEventListener(e, onAction, { passive: true }));
    // 스크롤은 캡처 단계로 — 데스크톱은 body가 아니라 .content 내부에서 스크롤되므로
    // (스크롤 이벤트는 버블링하지 않아) window 캡처로 받아야 유휴 타이머가 리셋된다.
    window.addEventListener("scroll", onAction, { passive: true, capture: true });
    startTimer();
    return () => {
      moveEvents.forEach(e   => window.removeEventListener(e, onMove));
      actionEvents.forEach(e => window.removeEventListener(e, onAction));
      window.removeEventListener("scroll", onAction, { capture: true });
      clearTimeout(idleRef.current);
    };
  }, [faqOpen, nudgeMode]);

  // "dismissing" → 0.4초 뒤 "hidden" (always 모드 제외)
  useEffect(() => {
    if (idlePhase === "dismissing" && nudgeMode !== "always") {
      const t = setTimeout(() => setIdlePhase("hidden"), 400);
      return () => clearTimeout(t);
    }
  }, [idlePhase, nudgeMode]);

  /* 사이드바 도메인 펼침 상태 + 활성 라우트의 도메인 자동 펼침.
   *
   * ⚠ 기본값을 **트리에서 뽑는다.** 예전엔 "acct"(일반회계)를 적어 뒀는데 2026-08 재편에서
   *   그 도메인이 사라졌다. 홈(#home)은 DOMAIN_OF 에 없어 자동 펼침도 안 걸리므로,
   *   **모든 도메인이 접힌 채로** 첫 화면이 떴다 — 메뉴가 통째로 안 보였다.
   *   이름을 박아 두면 트리를 고칠 때마다 같은 일이 난다. */
  const activeId = leafIdOf(route);
  const [openDomains, setOpenDomains] = useState(
    () => NAV_TREE.filter(n => n.type === "domain").slice(0, 1).map(n => n.id));
  useEffect(() => {
    const d = DOMAIN_OF[activeId];
    setOpenDomains(prev => (d && !prev.includes(d)) ? [...prev, d] : prev);
  }, [activeId]);
  const toggleDomain = (id) => setOpenDomains(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  // 라우트가 바뀌면 새 화면을 맨 위에서 보여준다. 데스크톱은 내부 스크롤(.content),
  // 모바일은 body 스크롤이라 둘 다 리셋한다.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [route]);

  /* 어느 화면을 쓰는지 남긴다(화면 이름만). 관리자 콘솔의 '사용 현황'이 이걸 읽는다.
   *
   * 2초 머문 뒤에만 보낸다 — 메뉴를 훑고 지나가는 이동까지 세면 "많이 쓴 화면"이
   * 실제로 일한 화면이 아니라 **지나친 화면**이 된다.
   * 실패해도 아무것도 하지 않는다. 곁다리 기록이 사용자의 일을 방해하면 안 된다. */
  useEffect(() => {
    if (!route) return;
    const t = setTimeout(() => { api.logUsage(route); }, 2000);
    return () => clearTimeout(t);
  }, [route]);

  const go = (id, opts = {}) => {
    if (opts.contractId) setContractId(opts.contractId);
    if (opts.contractName != null) setContractName(opts.contractName);
    // 홈 '할 일'에서 특정 청구서를 바로 열 때 사용 (없으면 목록만 보여준다)
    setFocusInvoiceId(opts.invoiceId || null);
    setRoute(id);
    window.location.hash = id;
    setSidebarOpen(false);
    // 스크롤 리셋은 route 변경 effect에서(데스크톱은 .content, 모바일은 window) 처리한다.
  };

  const Screen = useMemo(() => {
    // 주소창·북마크·옛 링크로 권한 없는 화면에 들어오는 경우. 메뉴에서 숨겨도 이 길은 열려 있다.
    // (막지 않아도 서버가 403을 주지만, 이유를 보여주는 편이 낫다)
    // settings_* 하위 탭은 'settings' 자원 하나가 관장한다(서버 apiPerms와 같은 규칙).
    const guardId = route.startsWith("settings") ? "settings"
                  : PORTAL_CAT_BY_ID[route] ? null      // 포털은 내용물이 걸러지므로 통째로 막지 않는다
                  : LEAF_BY_ID[route] ? route : null;
    if (guardId && !canDo(guardId)) return <NoPermission title={LEAF_BY_ID[guardId]?.label}/>;

    // 미수금/미지급금(구 ledger_ar/ledger_ap)은 청구서 기준 회수 화면으로 이관됨
    if (route === "ledger_ar") return <BillingScreen initialTab="issued"  role="collect" openRefund={() => setTxnForm({ kind: "expense", category: "매출 환불", memo: "매출 환불" })}/>;
    if (route === "ledger_ap") return <BillingScreen initialTab="received" role="collect" openReturn={() => setTxnForm({ kind: "income",  category: "매입 환입", memo: "매입 환입" })}/>;
    if (route.startsWith("ledger")) {
      const filter = route === "ledger_income" ? "income"
                   : route === "ledger_expense" ? "expense"
                   : "all";
      /* 거래내역의 '예정' 행(미수금·미지급금)에서 해당 청구서로 보낸다.
         해시에 ?invoiceId= 를 붙이면 안 된다 — 이 앱의 해시 라우터는 질의문자열을 모르고,
         알려진 라우트가 아니라며 아무 데도 안 간다. 청구서 지정은 go(…, {invoiceId}) 소관. */
      return <LedgerScreen initialFilter={filter} refreshTrigger={txnVersion} openEdit={(txn) => setTxnForm({ kind: txn.kind, txn })} openExcel={() => go("excel_modal")}
        openInvoice={(kind, invoiceId) => go(kind === "income" ? "ar" : "ap", { invoiceId })}/>;
    }
    if (PORTAL_CAT_BY_ID[route]) {
      // 포털 타일도 권한대로 걸러 그린다. 남는 게 없으면 들어갈 데가 없다는 뜻.
      // 마스터 전용 화면(변경 이력)은 자원 권한과 별개 축이라 한 번 더 거른다 —
      // 안 그러면 실무 역할에게 눌러도 403 나는 타일이 남는다.
      const node = withoutMasterOnly(visiblePortalNode(perms, PORTAL_CAT_BY_ID[route]), user?.role === 'admin');
      return node ? <PortalScreen node={node} go={go}/> : <NoPermission title={PORTAL_CAT_BY_ID[route].label}/>;
    }
    // 기준정보 서브메뉴: 내부 서브내브 없이 해당 탭만 전체폭으로. (일반회계 master_ / 인사급여 hrbase_)
    if (route.startsWith("master_")) return <MasterScreen user={user} section="base" forcedTab={route.slice(7)}/>;
    if (route.startsWith("hrbase_")) return <MasterScreen user={user} section="hr" forcedTab={route.slice(7)}/>;
    if (route.startsWith("settings_")) return <MasterScreen user={user} section="settings" forcedTab={route.slice(9)}/>;
    switch (route) {
      case "home":            return <HomeScreen go={go} user={user} openIncome={() => setTxnForm({ kind: "income" })} openExpense={() => setTxnForm({ kind: "expense" })}/>;
      case "billing":         return <BillingScreen/>;
      /* focusInvoiceId 를 넘긴다 — Ctrl+K 에서 청구서를 골랐는데 목록만 열리면
         찾은 것을 다시 찾아야 한다(BillingScreen 은 이미 이 값을 받아 그 건을 연다). */
      /* 등록 입구가 '받은 서류'를 먼저 묻고, 계산서가 아니면 거래 드로어로 넘긴다
         (Billing.jsx DocTypeChooser). 그래서 두 화면에 열기 함수를 내려준다. */
      /* ⚠ key 로 **다시 마운트**시킨다. 같은 컴포넌트를 두 라우트가 쓰므로 key 가 없으면
         React 가 인스턴스를 재사용하고, 화면 안의 상태가 그대로 건너간다:
           · 수시입금에서 '입금내역'을 보다 수시지급으로 가면 '지급내역'이 골라진 채로 뜬다
           · 더 나쁜 건 상태 필터다. 매출에만 있는 '장기 미수'를 걸어 두고 매입으로 가면
             그 쪽 칩 목록에는 없는 값이 남아 **아무 칩도 안 눌린 빈 표**가 된다
             ("왜 아무것도 없지" — 필터가 걸린 흔적조차 화면에 없다).
         기간·거래처 필터도 같은 경로로 새어 나간다. 두 화면은 서로 다른 장부다. */
      case "billing_issued":  return <BillingScreen key="billing_issued" initialTab="issued" focusInvoiceId={focusInvoiceId}
                                       openIncome={() => setTxnForm({ kind: "income" })}/>;
      case "billing_received":return <BillingScreen key="billing_received" initialTab="received" focusInvoiceId={focusInvoiceId}
                                       openExpense={() => setTxnForm({ kind: "expense", compact: true })}/>;
      case "contract":        return <ContractListScreen kind="all" goDetail={(id, name) => go("contract_detail", { contractId: id, contractName: name })}/>;
      case "contract_sales":  return <ContractListScreen kind="sales" goDetail={(id, name) => go("contract_detail", { contractId: id, contractName: name })}/>;
      case "contract_purchase": return <ContractListScreen kind="purchase" goDetail={(id, name) => go("contract_detail", { contractId: id, contractName: name })}/>;
      case "contract_detail": return <ContractScreen goList={() => go("contract")} contractId={contractId} refreshTrigger={txnVersion} openIncome={(contract, vendor) => setTxnForm({ kind: "income", contract, vendor })} openExpense={(contract, vendor, opts) => setTxnForm(opts?.asCost ? { kind: "expense", costContract: contract, vendor } : { kind: "expense", contract, vendor })}/>;
      case "hr":              return <HRScreen/>;
      // 재무관리 — 차입금·투자. 손익이 아니라 부채·자본이다(server/lib/pnl.js)
      case "finance_loan":       return <LoanScreen/>;
      case "finance_investment": return <InvestmentScreen/>;
      case "finance_savings":    return <SavingsScreen/>;
      case "finance_dash":       return <FinanceDashScreen/>;

      case "cash_report":     return <CashReportScreen/>;
      case "fund_status":     return <FundStatusScreen go={go}/>;
      case "report_daily":    return <DailyTrialScreen/>;
      case "report":          return <ReportsScreen/>;
      case "tax_vat":         return <TaxVatScreen/>;
      case "tax_etc":         return <OtherTaxScreen/>;
      case "master":          return <MasterScreen user={user} section="base"/>;
      // 'settings'는 위 PORTAL_CAT_BY_ID에서 타일 페이지로 처리됨(각 타일 → settings_<tab>)
      case "hr_base":         return <MasterScreen user={user} section="hr"/>;
      case "hr_labor_contract": return <LaborContractScreen/>;
      case "hr_outsourcing":  return <OutsourcingScreen/>;
      // 일반 경비 / 잡손익 — 화면은 하나를 공유하고 진입 메뉴가 초기 탭을 정한다
      case "misc_pl":
      case "misc_income":     return <MiscPLScreen initialTab={route === "misc_income" ? "income" : "expense"}
                                       refreshTrigger={txnVersion}
                                       openExpense={() => setTxnForm({ kind: "expense" })}
                                       openIncome={() => setTxnForm({ kind: "income" })}
                                       openEdit={(txn) => setTxnForm({ kind: txn.kind, txn })}/>;
      // 정기 반복은 기준정보(정적 참조)가 아니라 돈 흐름이다 → 성격에 맞는 회계처리 그룹에 둔다.
      // 정기지출=경비(판관비), 정기청구=판매·수주(매출). 패널은 Master의 것을 그대로 재사용.
      case "recurring_expense": return <RecurringExpensePanel page goRoute={go}/>;
      case "recurring_invoice": return <RecurringInvoicePanel page goRoute={go}/>;
      case "mgmt_dash":       return <MgmtDashScreen/>;
      case "mgmt_ask":        return <MgmtAskScreen/>;
      case "excel_modal":     return <ExcelScreen/>;
      case "income":          return <LedgerScreen initialFilter="income" openEdit={(txn) => setTxnForm({ kind: txn.kind, txn })} openExcel={() => go("excel_modal")}/>;
      case "expense":         return <LedgerScreen initialFilter="expense" openEdit={(txn) => setTxnForm({ kind: txn.kind, txn })} openExcel={() => go("excel_modal")}/>;
      // 미수금/미지급금은 청구서 기준 → 발행 청구서와 같은 BillingScreen을 '회수 모드'로 재사용
      case "ar":              return <BillingScreen initialTab="issued"  role="collect" focusInvoiceId={focusInvoiceId} openRefund={() => setTxnForm({ kind: "expense", category: "매출 환불", memo: "매출 환불" })}/>;
      case "ap":              return <BillingScreen initialTab="received" role="collect" focusInvoiceId={focusInvoiceId} openReturn={() => setTxnForm({ kind: "income",  category: "매입 환입", memo: "매입 환입" })}/>;
      case "doc":             return <DocsScreen/>;
      case "settlement":      return <SettlementScreen/>;
      case "payment_run":     return <PaymentRunScreen go={go}/>;
      case "purchase_status": return <PurchaseStatusScreen go={go}/>;
      case "purchase_req":    return <PurchaseReqScreen/>;
      case "quote_req":       return <QuoteRequestScreen/>;
      // 증빙 관리는 아직 목 데이터만 보여주는 화면이라 nav 에서 뺐는데, #evidence 해시로는
      // 계속 들어와져 가짜 숫자가 실데이터처럼 보였다. 실구현 전까지 '준비 중'으로 막는다.
      // (화면 코드 EvidenceScreen 은 그대로 둔다 — 추후 실구현 시 여기만 되돌리면 된다)
      case "evidence":        return <ComingSoon title="증빙 관리"/>;
      case "excel":           return <ExcelScreen/>;
      default:                return <HomeScreen go={go} openIncome={() => setTxnForm({ kind: "income" })} openExpense={() => setTxnForm({ kind: "expense" })}/>;
    }
  }, [route, contractId, txnVersion, focusInvoiceId, perms]);

  const helpKey = route.startsWith("ledger") || ["income","expense","ar","ap","excel_modal"].includes(route) ? "ledger"
                : route.startsWith("billing") ? "billing"
                : (route === "contract_sales" || route === "contract_purchase") ? "contract"
                : (route === "settings" || route === "hr_base" || route === "hr_labor_contract" || route === "hr_outsourcing" || route.startsWith("master") || route.startsWith("hrbase") || route.startsWith("settings_")) ? "master"
                : (route === "recurring_expense" || route === "recurring_invoice") ? "recurring"
                : (route === "misc_income") ? "misc_pl"
                : (route === "mgmt_dash" || route === "mgmt_ask") ? "report" : route;
  const help = HELP_MAP[helpKey] || HELP_MAP.home;

  // 기준정보·환경설정 서브메뉴(master_/settings_<탭>)는 CRUMB_MAP에 없으니 nav 잎 정보로 구성.
  // 중간 라벨은 잎의 section을 쓴다(기준정보 잎은 "기준정보", 환경설정 잎은 "환경설정").
  // 사이드바에 있는 화면은 트리에서 뽑은 길(NAV_PATH_OF)을 그대로 쓴다 — 크럼과 사이드바가 어긋나지 않게.
  let crumbs = CRUMB_MAP[route] || NAV_PATH_OF[route]
    || (LEAF_BY_ID[route] ? [LEAF_BY_ID[route].domain, LEAF_BY_ID[route].section, LEAF_BY_ID[route].label] : ["홈"]);
  if (route === "contract_detail") {
    crumbs = ["주문", contractName || "주문 상세"];
  }
  const crumbTo = crumbTargets(route, crumbs);
  /* 빈 마디와 '경영관리 › 경영관리'처럼 같은 말이 잇달아 나오는 자리를 걷어낸다.
     겹칠 땐 뒤쪽(더 가까운 상위)을 남긴다 — 링크가 한 단계만 올라가야 쓸모 있다. */
  const trail = crumbs
    .map((label, i) => ({ label, to: i === crumbs.length - 1 ? null : crumbTo[i] }))
    .filter((c, i, a) => c.label && c.label !== a[i + 1]?.label);

  return (
    <div className="app">
      {/* Mobile overlay */}
      <div className={`sidebar-overlay${sidebarOpen ? " open" : ""}`} onClick={() => setSidebarOpen(false)}/>

      {/* Sidebar */}
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="brand">
          <img src={logoSymbol} alt="로고" style={{ width: 36, height: 36, objectFit: "contain", flexShrink: 0 }}/>
          <div className="name">도니도라 - 회계관리</div>
        </div>

        <div className="nav-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, marginRight: -4, paddingRight: 4 }}>
          {navTree.map(node => {
            if (node.type === "leaf") {
              const Ic = node.icon;
              return (
                <div key={node.id} className={`nav-item${activeId === node.id ? " active" : ""}`} onClick={() => go(node.id)}>
                  <Ic className="nav-ico"/>
                  <span>{node.label}</span>
                </div>
              );
            }
            const Dic = node.icon;
            const open = openDomains.includes(node.id);
            const inDomain = DOMAIN_OF[activeId] === node.id;
            // 도메인을 접어두면 안쪽 배지가 안 보인다 → 합계를 도메인 줄에도 올린다
            const domainOverdue = node.sections.reduce((s, sec) =>
              s + sec.items.reduce((n, it) => n + (overdueCycles[it.id] || 0), 0), 0);
            return (
              <div key={node.id} style={{ marginTop: 4 }}>
                <button className={`nav-domain${inDomain ? " has-active" : ""}`} onClick={() => toggleDomain(node.id)}>
                  <Dic className="nav-ico"/>
                  <span>{node.label}</span>
                  {!open && domainOverdue > 0 && (
                    <span className="nav-count neg ml-auto" title={`처리가 밀린 정기 회차 ${domainOverdue}건`}>{domainOverdue}</span>
                  )}
                  <Icon.Down className="nav-chev" style={{ transform: open ? "none" : "rotate(-90deg)" }}/>
                </button>
                {open && node.sections.map(section => (
                  <div key={section.label} className="nav-section">
                    <div className="nav-group-label nav-sub-label">{section.label}</div>
                    {section.items.map(it => {
                      const Lic = it.icon;
                      if (it.disabled) {
                        return (
                          <div key={it.id} className="nav-item nav-sub disabled" title="준비 중인 메뉴예요"
                            onClick={() => toast.push(`${it.label}은(는) 준비 중이에요`)}>
                            <Lic className="nav-ico"/>
                            <span>{it.label}</span>
                            <span className="nav-count" style={{ background: "var(--surface-3)", color: "var(--muted-2)" }}>준비중</span>
                          </div>
                        );
                      }
                      const overdue = overdueCycles[it.id] || 0;
                      return (
                        <div key={it.id} className={`nav-item nav-sub${activeId === it.id ? " active" : ""}`} onClick={() => go(it.id)}>
                          <Lic className="nav-ico"/>
                          <span>{it.label}</span>
                          {/* 놓친 회차 — '해야 하는데 안 된 것'이라 개수만 조용히 놓지 않고 눈에 걸리게 */}
                          {overdue > 0 && (
                            <span className="nav-count neg" title={`처리가 밀린 회차 ${overdue}건`}>{overdue}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {/* 기준정보·환경설정 — 매일 쓰는 업무 메뉴와 성격이 달라 아래에 따로 세운다.
            둘 다 '한 번 세팅하고 가끔 손보는' 것들이라 위쪽 흐름을 차지하지 않는다. */}
        {(masterVisible || canDo("settings")) && (
          <div style={{ paddingTop: 8, marginTop: 8, borderTop: "1px solid var(--line)" }}>
            {masterVisible && (
              <div className={`nav-item${activeId === "master" ? " active" : ""}`} onClick={() => go("master")}>
                <Icon.Folder className="nav-ico" size={18}/>
                <span>기준정보</span>
              </div>
            )}
            {canDo("settings") && (
              <div className={`nav-item${activeId === "settings" ? " active" : ""}`} onClick={() => go("settings")}>
                <Icon.Cog className="nav-ico" size={18}/>
                <span>환경설정</span>
              </div>
            )}
          </div>
        )}

        <Popover align="left" width={200} direction="up"
          trigger={
            <div className="sidebar-footer" style={{ cursor: "pointer", borderRadius: 10, transition: "background .12s" }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--surface-3)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div className="avatar">{(user?.displayName || "관")[0]}</div>
              <div style={{ minWidth: 0 }}>
                <div className="who">{user?.displayName || "관리자"}</div>
                <div className="who-sub" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{user?.role || ""}</div>
              </div>
              <Icon.Down size={14} style={{ marginLeft: "auto", flexShrink: 0, color: "var(--muted-2)" }}/>
            </div>
          }>
          <div style={{ padding: 6 }}>
            <PopItem icon={<Icon.Cog size={14}/>} label="프로필 설정" onClick={() => toast.push("프로필 설정은 준비 중이에요")}/>
            <div style={{ height: 1, background: "var(--line)", margin: "4px 0" }}/>
            <PopItem icon={<Icon.Out size={14}/>} label="로그아웃" onClick={async () => {
              const ok = await confirm({
                tone: "info",
                icon: <Icon.Out size={22}/>,
                title: "로그아웃 하시겠습니까?",
                body: "현재 세션이 종료됩니다. 저장되지 않은 작업이 있다면 먼저 저장해주세요.",
                confirmLabel: "로그아웃",
              });
              if (ok) onLogout();
            }}/>
          </div>
        </Popover>
      </aside>

      {/* Main */}
      <main className="main">
        <div className="topbar">
          <button className="menu-btn icon-btn" onClick={() => setSidebarOpen(o => !o)} aria-label="메뉴">
            <Icon.Menu size={18}/>
          </button>
          <div className="crumb">
            {trail.map((c, i, arr) => {
              // 지금 화면으로 가는 마디는 링크로 만들지 않는다 — 눌러도 제자리라 고장으로 읽힌다
              const to = c.to && c.to !== route ? c.to : null;
              return (
                <Fragment key={i}>
                  {i === arr.length - 1
                    ? <b>{c.label}</b>
                    : to
                      ? <button type="button" className="crumb-link" onClick={() => go(to)}>{c.label}</button>
                      : <span>{c.label}</span>}
                  {i < arr.length - 1 && <span style={{ margin: "0 8px", color: "var(--subtle)" }}>›</span>}
                </Fragment>
              );
            })}
          </div>
          <button className="search" onClick={() => setCmdOpen(true)} style={{ border: 0, cursor: "pointer", textAlign: "left" }}>
            <Icon.Search size={14}/>
            <span style={{ flex: 1 }}>거래처, 주문, 영수증 검색</span>
            <span className="kbd">{isMac ? "⌘K" : "Ctrl K"}</span>
          </button>
          <Popover align="right" width={360}
            trigger={
              <button className="icon-btn" title="알림" style={{ position: "relative" }} onClick={() => {}}>
                <Icon.Bell size={16}/>
                {unreadCount > 0 && <span style={{ position: "absolute", top: 8, right: 8, width: 7, height: 7, borderRadius: "50%", background: "var(--neg)", border: "1.5px solid #fff" }}/>}
              </button>
            }>
            <div>
              <div className="row" style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
                <div className="fw-700">알림</div>
                {unreadCount > 0 && <span className="badge neg ml-auto">{unreadCount}건</span>}
              </div>
              <div style={{ maxHeight: 360, overflowY: "auto" }}>
                {notifs.length === 0 && (
                  <div style={{ padding: "28px 14px", textAlign: "center", color: "var(--muted-2)", fontSize: 13 }}>
                    처리할 알림이 없어요.
                  </div>
                )}
                {notifs.map((n, i) => (
                  <button key={i} data-pop-item onClick={() => go(n.to)}
                    className="row gap-10"
                    style={{ width: "100%", padding: "12px 14px", borderTop: i ? "1px solid var(--line)" : 0,
                      border: i ? undefined : 0, borderLeft: 0, borderRight: 0, borderBottom: 0,
                      alignItems: "flex-start", textAlign: "left", background: "transparent",
                      fontFamily: "inherit", cursor: "pointer", opacity: notifRead ? 0.5 : 1 }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--surface-2)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <span style={{
                      width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                      background: `var(--${n.tone === "neg" ? "neg" : n.tone === "warn" ? "warn" : n.tone === "brand" ? "brand" : "surface-3"}-soft)`,
                      color: `var(--${n.tone === "neg" ? "neg" : n.tone === "warn" ? "warn" : n.tone === "brand" ? "brand" : "muted"})`,
                      display: "grid", placeItems: "center",
                    }}>{NOTIF_ICON[n.icon] || NOTIF_ICON.Bell}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="text-sm fw-600" style={{ display: "block", marginBottom: 2 }}>{n.title}</span>
                      <span className="text-xs text-muted2" style={{ display: "block" }}>{n.sub}{n.when ? ` · ${n.when}` : ""}</span>
                    </span>
                  </button>
                ))}
              </div>
              {notifs.length > 0 && (
                <div style={{ padding: 8, borderTop: "1px solid var(--line)" }}>
                  <button className="btn ghost sm" style={{ width: "100%" }} onClick={() => setNotifRead(true)}>모두 읽음 처리</button>
                </div>
              )}
            </div>
          </Popover>
          <Popover align="right" width={300}
            trigger={<button className="icon-btn" title="도움말"><Icon.Help size={16}/></button>}>
            <div>
              <div className="row gap-8" style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
                <div style={{ width: 22, height: 22, borderRadius: 6, background: "var(--brand-soft)", color: "var(--brand)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Icon.Sparkle size={11}/>
                </div>
                <div className="fw-700 text-sm">{help.title} 사용법</div>
              </div>
              <div style={{ padding: "10px 14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                {help.items.map((item, i) => (
                  <div key={i} className="row gap-8" style={{ alignItems: "flex-start" }}>
                    <span style={{ color: "var(--brand)", flexShrink: 0, marginTop: 2, fontSize: 12 }}>·</span>
                    <span className="text-sm" style={{ lineHeight: 1.55, color: "var(--ink)" }}>{item}</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: "12px 14px", borderTop: "1px solid var(--line)" }}>
                <div className="text-xs fw-700" style={{ color: "var(--muted-2)", marginBottom: 8, letterSpacing: "0.02em" }}>도움말 말걸기</div>
                <div style={{ display: "flex", width: "100%", background: "var(--surface-2)", borderRadius: 8, padding: 3, gap: 2 }}>
                  {[["auto", "자동"], ["always", "항상 표시"], ["off", "끄기"]].map(([v, label]) => (
                    <button key={v} onClick={() => setNudgeMode(v)}
                      style={{ flex: 1, padding: "5px 0", border: 0, borderRadius: 6, cursor: "pointer",
                        fontSize: 11, fontWeight: 600, fontFamily: "inherit",
                        background: nudgeMode === v ? "#fff" : "transparent",
                        color: nudgeMode === v ? "var(--ink)" : "var(--muted-2)",
                        boxShadow: nudgeMode === v ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
                        transition: "all .15s" }}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Popover>
        </div>

        <div className="content" ref={contentRef}>
          <div className="page-shell">
            <ErrorBoundary routeKey={route}>
              {Screen}
            </ErrorBoundary>
          </div>
        </div>
      </main>

      <TransactionForm open={txnForm !== null} kind={txnForm?.kind || "expense"} initialContract={txnForm?.contract} initialCostContract={txnForm?.costContract || null} initialVendor={txnForm?.vendor || null} initialCategory={txnForm?.category || null} initialMemo={txnForm?.memo || null} compact={!!txnForm?.compact} editTxn={txnForm?.txn || null} onClose={() => setTxnForm(null)} onSave={() => setTxnVersion(v => v + 1)}/>
      <EvidenceAttachDrawer item={evidenceAttach} onClose={() => setEvidenceAttach(null)}/>
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} onPick={(c) => {
        setCmdOpen(false);
        // 고른 것이 무엇이냐에 따라 열 대상을 함께 넘긴다 — 주문은 그 상세, 청구서는 그 건
        go(c.route, {
          ...(c.contractId ? { contractId: c.contractId, contractName: c.contractName } : {}),
          ...(c.invoiceId ? { invoiceId: c.invoiceId } : {}),
        });
      }}/>

      {/* FAQ 유휴 nudge + 플로팅 버튼 */}
      {idlePhase !== "hidden" && !faqOpen && (
        <div style={{
          position:"fixed", right:24, bottom:24, zIndex:60,
          display:"flex", alignItems:"flex-end", gap:10,
          opacity: idlePhase === "dismissing" ? 0 : 1,
          transition:"opacity .35s ease",
          pointerEvents: idlePhase === "dismissing" ? "none" : "auto",
        }}>
          {/* 말풍선 */}
          <div style={{
            background:"#fff", borderRadius:14, padding:"12px 16px",
            boxShadow:"0 4px 20px rgba(15,23,42,0.12)", border:"1px solid var(--line)",
            maxWidth:190, marginBottom:4,
            ...(idlePhase === "showing" ? { animation:"nudgeBubble .3s ease both .25s" } : {}),
          }}>
            <div className="fw-700" style={{ fontSize:13, marginBottom:3, color:"var(--ink)" }}>도움이 필요하세요?</div>
            <div className="text-xs text-muted" style={{ lineHeight:1.55 }}>자주 묻는 질문을 확인해 보세요.</div>
          </div>

          {/* 로봇 버튼 */}
          <button onClick={() => setFaqOpen(true)} title="자주 묻는 질문"
            style={{
              width:50, height:50, borderRadius:"50%",
              background:"var(--brand)", color:"#fff",
              border:0, cursor:"pointer", display:"grid", placeItems:"center",
              boxShadow:"0 4px 18px rgba(37,99,235,0.35)", flexShrink:0,
              ...(idlePhase === "showing" ? { animation:"nudgePop .4s cubic-bezier(.34,1.56,.64,1) both" } : {}),
            }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="10" rx="2"/>
              <path d="M9 11V7a3 3 0 0 1 6 0v4"/>
              <circle cx="9" cy="16" r="1" fill="currentColor" stroke="none"/>
              <circle cx="15" cy="16" r="1" fill="currentColor" stroke="none"/>
              <path d="M12 3v1M8 3h8"/>
            </svg>
          </button>
        </div>
      )}
      <FaqPanel open={faqOpen} onClose={() => setFaqOpen(false)} route={route}
        go={(r) => { go(r); setFaqOpen(false); }}/>
    </div>
  );
}

/* ══════════════════════════════════════════════
   FAQ 플로팅 패널
══════════════════════════════════════════════ */
const FAQ_CATEGORIES = ["거래 등록", "미수금·미지급금", "주문 관리", "증빙·결의서", "인사·급여", "보고서·마감", "시스템·설정"];

const FAQ_DATA = [
  // 거래 등록
  { id:"f01", cat:"거래 등록",       routes:["home","ledger"],              q:"입금을 어떻게 등록하나요?",                  a:"입금관리 → 수시입금에서 '입금 등록'을 누르면 받으신 서류(세금계산서인지 아닌지)를 먼저 묻고, 그에 맞는 폼으로 안내해요. 매달 같은 곳에서 들어오는 돈은 정기입금에 규칙으로 걸어 두면 회차가 알아서 떠요.", action:{ label:"수시입금으로", route:"billing_issued" } },
  { id:"f02", cat:"거래 등록",       routes:["home","ledger"],              q:"지출을 어떻게 등록하나요?",                  a:"지급처리 → 수시지급에서 '지급 등록'을 누르세요. 받으신 서류(세금계산서 / 카드전표·영수증 / 없음)를 먼저 고르면 그에 맞는 폼이 열려요. 매달 나가는 고정비는 정기지급에 걸어 두면 됩니다.", action:{ label:"수시지급으로", route:"billing_received" } },
  { id:"f03", cat:"거래 등록",       routes:["ledger"],                     q:"여러 건을 한꺼번에 올리고 싶어요",            a:"엑셀 업로드 기능을 이용하면 여러 거래를 한 번에 등록할 수 있어요. 거래내역 오른쪽 위 '엑셀 업로드'에서 서식을 내려받아 작성한 뒤 올려 주세요.", action:{ label:"엑셀 업로드로", route:"excel_modal" } },
  { id:"f04", cat:"거래 등록",       routes:["ledger"],                     q:"거래 내용을 수정하거나 삭제하고 싶어요",      a:"거래내역에서 그 줄을 누르면 상세가 열려요. 아래쪽 '편집'으로 고치고, '삭제'로 지울 수 있어요. 거래내역은 보는 곳이라 평소에는 여기서 고칠 일이 많지 않아요 — 잘못 들어간 게 보일 때만 쓰면 됩니다.", action:{ label:"거래내역으로", route:"ledger" } },
  { id:"f05", cat:"거래 등록",       routes:["ledger","home"],              q:"등록하려는 거래처가 목록에 없어요",           a:"거래처는 설정 화면에서 먼저 추가해야 해요. 설정 → 거래처 탭에서 새 거래처를 등록한 뒤 다시 시도해 보세요.", action:{ label:"설정으로", route:"master" } },
  { id:"f06", cat:"거래 등록",       routes:["ledger","home","contract"],   q:"등록하려는 주문이 목록에 없어요",             a:"주문은 수주·발주 화면에서 '신규 생성' 버튼으로 먼저 만들어야 해요. 주문이 없는 거래라면 등록 폼에서 주문 칸을 비워두면 됩니다(선택 입력이에요).", action:{ label:"수주로", route:"contract_sales" } },
  // 미수금·미지급금
  { id:"f07", cat:"미수금·미지급금", routes:["contract","ledger"],          q:"미수금이 자동으로 생성되지 않아요",           a:"입금 등록 2단계에서 주문을 선택했는지 확인해 보세요. 주문을 연결해야 해당 주문의 미수금이 자동으로 차감돼요.", action:{ label:"거래내역으로", route:"ledger" } },
  { id:"f08", cat:"미수금·미지급금", routes:["contract","home"],            q:"연체된 미수금은 어떻게 처리하나요?",          a:"미수금 화면의 '기한 지남' 탭에서 연체 건을 확인하세요. 행 우측 '독촉' 버튼으로 거래처에 메일을 보내고, 입금 확인 후 '입금 처리'를 누르면 돼요.", action:{ label:"미수금으로", route:"contract" } },
  { id:"f09", cat:"미수금·미지급금", routes:["contract"],                   q:"미지급금 이체를 어떻게 실행하나요?",          a:"미지급금 화면에서 이체할 건의 체크박스를 선택한 뒤 '선택 이체 실행'을 눌러요. 결의서 승인이 완료된 건만 이체가 가능해요.", action:{ label:"미지급금으로", route:"contract" } },
  { id:"f10", cat:"미수금·미지급금", routes:["home","contract"],            q:"홈에 '연체 미수금' 알림이 뜨는데 어디서 처리하나요?", a:"홈 화면의 알림 카드를 직접 클릭하면 미수금 화면으로 바로 이동해요. 또는 주문 메뉴 → 미수금 탭에서 처리할 수 있어요.", action:{ label:"미수금으로", route:"contract" } },
  // 주문 관리
  { id:"f11", cat:"주문 관리",       routes:["contract","contract_detail"], q:"주문 담당자(PM)를 변경하고 싶어요",           a:"주문 상세 화면에서 담당자 항목을 클릭하면 수정할 수 있어요. 설정 → 직원 탭에서 PM으로 지정된 직원 중에서 선택할 수 있어요.", action:{ label:"주문 목록으로", route:"contract" } },
  { id:"f12", cat:"주문 관리",       routes:["contract_detail"],            q:"주문과 연결된 거래를 추가하고 싶어요",        a:"주문 상세 화면 우측 상단의 '입금 등록' 또는 '지출 등록'을 누르면 해당 주문에 자동 연결된 거래로 등록돼요.", action:null },
  { id:"f13", cat:"주문 관리",       routes:["contract_detail"],            q:"발주서나 계약서 파일을 첨부하고 싶어요",      a:"주문 상세 화면의 '증빙' 탭에서 파일을 드래그하거나 선택해 첨부할 수 있어요. PDF·이미지·엑셀 형식을 지원해요.", action:null },
  { id:"f14", cat:"주문 관리",       routes:["contract"],                   q:"진행률 바는 어떻게 계산되나요?",              a:"주문금액 대비 현재까지 입금 처리된 금액의 비율이에요. 입금을 등록하고 주문과 연결하면 자동으로 반영돼요.", action:null },
  // 증빙·결의서
  { id:"f15", cat:"증빙·결의서",     routes:["ledger"],                     q:"세금계산서를 어떻게 등록하나요?",              a:"거래를 등록할 때 증빙 첨부 단계에서 세금계산서 파일을 올리거나, 거래내역에서 해당 거래를 열어 증빙을 첨부하세요.", action:null },
  { id:"f16", cat:"증빙·결의서",     routes:["ledger"],                     q:"거래내역에 ⚠️ 표시는 무엇인가요?",            a:"세금계산서나 영수증이 연결되지 않은 거래에 표시돼요. 거래 상세를 열어 증빙을 첨부하면 사라져요.", action:null },
  { id:"f17", cat:"증빙·결의서",     routes:["doc","contract"],             q:"결의서 승인이 안 돼요",                        a:"결의서는 결재선 순서대로 승인이 이루어져요. 현재 결재자가 누구인지 결의서 상세에서 확인하고, 해당 담당자에게 승인을 요청하세요.", action:{ label:"결의서로", route:"doc" } },
  { id:"f18", cat:"증빙·결의서",     routes:["doc"],                        q:"외주가공비 결의서를 새로 만들고 싶어요",      a:"지출 등록 마지막 단계에서 '결의서 자동 생성'을 켜두면 지출 등록과 동시에 결의서가 생성돼요. 또는 결의서 화면에서 '+ 결의서 작성'을 눌러도 돼요.", action:{ label:"결의서로", route:"doc" } },
  { id:"f19", cat:"증빙·결의서",     routes:["doc","contract"],             q:"결의서와 미지급금은 어떻게 연결되나요?",      a:"지출 등록 시 결의서가 생성되고, 결의서가 승인되면 해당 금액이 미지급금 목록에 자동으로 올라와요. 이체 실행 시 미지급금이 차감돼요.", action:null },
  // 인사·급여
  { id:"f20", cat:"인사·급여",       routes:["hr","hr_labor_contract"],     q:"새 직원을 등록하려면 어떻게 하나요?",          a:"근로계약 메뉴에서 '직원 등록' 버튼을 눌러 인적 정보와 고용형태·급여 기준을 입력하세요. 등록한 주문을 바탕으로 급여대장이 만들어져요.", action:{ label:"근로계약으로", route:"hr_labor_contract" } },
  { id:"f21", cat:"인사·급여",       routes:["hr"],                         q:"급여 명세를 어떻게 만들고 고치나요?",           a:"인사관리 → 급여대장 탭에서 '급여대장 생성'을 누르면 근로계약 기준으로 명세가 만들어져요. 각 행의 '명세서'에서 항목·금액을 조정하고, '지급'으로 실제 이체를 연결하면 미지급·과지급이 자동 계산돼요.", action:{ label:"인사관리로", route:"hr" } },
  { id:"f22", cat:"인사·급여",       routes:["hr"],                         q:"급여를 지급 처리하려면 어떻게 하나요?",         a:"급여대장 각 직원 행의 '지급' 버튼에서 실지급액과 출금 계좌를 넣어 등록하면, 거래내역에 지출로 자동 기록되고 계좌 잔액에 반영돼요. 여러 번 나눠 지급해도 미지급 잔액이 추적돼요.", action:{ label:"인사관리로", route:"hr" } },
  { id:"f23", cat:"인사·급여",       routes:["hr","master"],                q:"4대보험·소득세는 어떻게 입력하나요?",          a:"자동 계산하지 않아요. 공단·세무서 고지 금액을 급여 명세서의 공제 항목에 직접 입력하면 실수령액에 반영돼요. 표준 급여 항목은 기준정보 → 급여 항목에서 관리해요.", action:{ label:"인사관리로", route:"hr" } },
  // 보고서·마감
  { id:"f24", cat:"보고서·마감",     routes:["report"],                     q:"세무사에게 전달할 자료를 어떻게 뽑나요?",      a:"보고서 화면에서 '세무사 전달용' 카드를 클릭하면 월별 손익·부가세 요약 자료가 나와요. 인쇄 버튼으로 PDF를 저장하거나 출력할 수 있어요.", action:{ label:"보고서로", route:"report" } },
  { id:"f25", cat:"보고서·마감",     routes:["report","ledger"],            q:"지난달 데이터를 조회하고 싶어요",               a:"거래내역 화면의 기간 필터에서 '지난 달' 또는 '직접 입력'을 선택하면 원하는 기간의 데이터를 조회할 수 있어요.", action:{ label:"거래내역으로", route:"ledger" } },
  // 시스템·설정
  { id:"f26", cat:"시스템·설정",     routes:["master"],                     q:"거래처를 추가하거나 수정하고 싶어요",           a:"설정 화면의 '거래처' 탭에서 추가·수정·삭제가 가능해요. 거래처 정보가 변경되어도 기존 거래내역에는 영향을 주지 않아요.", action:{ label:"설정으로", route:"master" } },
  { id:"f27", cat:"시스템·설정",     routes:["master","ledger"],            q:"비목(계정과목)을 추가하고 싶어요",              a:"설정 → 비목 탭에서 새 비목을 추가할 수 있어요. 추가된 비목은 지출 등록 3단계부터 바로 선택할 수 있어요.", action:{ label:"설정으로", route:"master" } },
  { id:"f28", cat:"시스템·설정",     routes:["home","master"],              q:"로그인 비밀번호를 바꾸고 싶어요",               a:"화면 왼쪽 하단의 사용자 이름을 클릭한 뒤 '프로필 설정'에서 변경할 수 있어요.", action:null },
];

function FaqPanel({ open, onClose, route, go }) {
  const [search, setSearch] = useState("");
  const [selId,  setSelId]  = useState(null);
  const [cat,    setCat]    = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) { setSearch(""); setSelId(null); setCat(null); setTimeout(() => inputRef.current?.focus(), 80); }
  }, [open]);

  const helpKey = route.startsWith("ledger") || ["income","expense","ar","ap","excel_modal"].includes(route) ? "ledger" : route;
  const sel = selId ? FAQ_DATA.find(f => f.id === selId) : null;
  const currentFaqs = FAQ_DATA.filter(f => f.routes.includes(helpKey));
  const filtered = search
    ? FAQ_DATA.filter(f => f.q.includes(search) || f.a.includes(search) || f.cat.includes(search))
    : cat ? FAQ_DATA.filter(f => f.cat === cat) : [];

  if (!open) return null;

  const QRow = ({ f, showCat = false }) => (
    <button onClick={() => setSelId(f.id)}
      style={{ width:"100%", padding:"12px 18px", borderTop:"1px solid var(--line)", textAlign:"left",
        border:0, background:"transparent", cursor:"pointer", fontFamily:"inherit",
        display:"flex", alignItems:"center", gap:10, transition:"background .1s" }}
      onMouseEnter={e => e.currentTarget.style.background = "var(--surface-2)"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      <span className="text-sm fw-600" style={{ flex:1, lineHeight:1.4, textAlign:"left" }}>{f.q}</span>
      {showCat && <span className="badge outline" style={{ fontSize:10, flexShrink:0, whiteSpace:"nowrap" }}>{f.cat}</span>}
      <Icon.Right size={13} style={{ color:"var(--muted-2)", flexShrink:0 }}/>
    </button>
  );

  return (
    /* ⚠ 딤과 패널을 **겹쳐** 놓는다(공용 Drawer 와 같은 구조).
     *
     * 예전엔 flex 로 나란히 뒀는데, 딤이 `flex:1` 이라 **패널 폭만큼을 비워두고** 깔렸다.
     * 패널은 transform 으로 오른쪽 밖에서 슬라이드해 들어오므로, 그 0.18초 동안
     * 오른쪽 380px 띠만 안 어두운 채로 남는다 — "하얀 판이 깔렸다가 드로어가 튀어나오는"
     * 느낌이 그것이었다(실측: 화면 1280 인데 딤은 890 까지, 패널은 x=1267 에 대기).
     * 겹쳐 두면 열리는 순간부터 화면 전체가 균일하게 어둡고, 패널만 미끄러져 들어온다.
     */
    <div style={{ position:"fixed", inset:0, zIndex:90 }}>
      <div onClick={onClose}
        style={{ position:"absolute", inset:0, background:"rgba(11,18,32,0.18)", backdropFilter:"blur(1px)" }}/>
      <div style={{ position:"absolute", top:0, right:0, bottom:0,
        width:"min(380px,100vw)", background:"#fff", display:"flex", flexDirection:"column",
        boxShadow:"-8px 0 40px rgba(15,23,42,0.13)", animation:"slideInRight .18s ease both" }}>

        {/* Header */}
        <div style={{ padding:"15px 18px", borderBottom:"1px solid var(--line)", flexShrink:0, display:"flex", gap:10, alignItems:"center" }}>
          {sel
            ? <button className="icon-btn" onClick={() => setSelId(null)} style={{ marginLeft:-4 }}><Icon.Left size={16}/></button>
            : <div style={{ width:28, height:28, borderRadius:8, background:"var(--brand-soft)", color:"var(--brand)", display:"grid", placeItems:"center", flexShrink:0 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                  <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/>
                </svg>
              </div>
          }
          <span className="fw-700" style={{ fontSize:14, flex:1 }}>자주 묻는 질문</span>
          <button className="icon-btn" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        {sel ? (
          /* ── 답변 화면 ── */
          <div style={{ flex:1, overflowY:"auto", padding:"22px 18px" }}>
            <span className="badge outline" style={{ marginBottom:14, display:"inline-block" }}>{sel.cat}</span>
            <div className="fw-700" style={{ fontSize:16, marginBottom:16, lineHeight:1.45, letterSpacing:"-0.01em" }}>{sel.q}</div>
            <div className="text-sm" style={{ lineHeight:1.8, color:"var(--ink)" }}>{sel.a}</div>
            {sel.action && (
              <button className="btn primary sm" style={{ marginTop:20 }} onClick={() => go(sel.action.route)}>
                {sel.action.label} <Icon.Right size={13}/>
              </button>
            )}
          </div>
        ) : (
          /* ── 목록 화면 ── */
          <>
            <div style={{ padding:"12px 18px", borderBottom:"1px solid var(--line)", flexShrink:0 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, background:"var(--surface-2)", borderRadius:10, padding:"8px 12px" }}>
                <Icon.Search size={14} style={{ color:"var(--muted-2)", flexShrink:0 }}/>
                <input ref={inputRef} value={search} onChange={e => { setSearch(e.target.value); setCat(null); }}
                  placeholder="궁금한 것을 검색해보세요"
                  style={{ flex:1, border:0, outline:0, fontSize:13, background:"transparent", fontFamily:"inherit" }}/>
                {search && <button className="icon-btn" style={{ width:18, height:18 }} onClick={() => setSearch("")}><Icon.Close size={12}/></button>}
              </div>
            </div>

            <div style={{ flex:1, overflowY:"auto" }}>
              {search ? (
                /* 검색 결과 */
                <>
                  <div style={{ padding:"12px 18px 4px", fontSize:11, fontWeight:700, color:"var(--muted-2)", letterSpacing:"0.04em" }}>검색 결과 {filtered.length}건</div>
                  {filtered.length === 0 ? (
                    <div style={{ padding:"48px 24px", textAlign:"center", color:"var(--muted-2)" }}>
                      <Icon.Search size={28} style={{ marginBottom:10, opacity:.4 }}/>
                      <div className="fw-600" style={{ fontSize:13 }}>일치하는 질문이 없어요</div>
                      <div style={{ fontSize:12, marginTop:4 }}>다른 키워드로 검색하거나 카테고리를 둘러보세요</div>
                    </div>
                  ) : filtered.map(f => <QRow key={f.id} f={f} showCat/>)}
                </>
              ) : (
                /* 기본: 현재 화면 + 카테고리 */
                <>
                  {currentFaqs.length > 0 && (
                    <div style={{ borderBottom:"1px solid var(--line)" }}>
                      <div style={{ padding:"14px 18px 6px", fontSize:11, fontWeight:700, color:"var(--muted-2)", letterSpacing:"0.04em" }}>이 화면 관련 질문</div>
                      {currentFaqs.map(f => <QRow key={f.id} f={f}/>)}
                    </div>
                  )}
                  <div style={{ padding:"14px 18px 8px", fontSize:11, fontWeight:700, color:"var(--muted-2)", letterSpacing:"0.04em" }}>카테고리별 보기</div>
                  <div style={{ padding:"0 18px 16px", display:"flex", flexWrap:"wrap", gap:8 }}>
                    {FAQ_CATEGORIES.map(c => (
                      <button key={c} className={`chip ${cat === c ? "active" : ""}`} onClick={() => setCat(cat === c ? null : c)}>{c}</button>
                    ))}
                  </div>
                  {cat && (
                    <div style={{ borderTop:"1px solid var(--line)" }}>
                      {FAQ_DATA.filter(f => f.cat === cat).map(f => <QRow key={f.id} f={f}/>)}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const CommandPalette = ({ open, onClose, onPick }) => {
  const { can: canDo } = usePerms();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [index, setIndex] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const ql = q.trim().toLowerCase();
  // 권한 없는 화면으로 가는 항목은 검색에도 안 뜬다 — 뜨면 눌렀을 때 403만 본다.
  // (거래처·주문 같은 데이터 항목은 서버가 이미 권한대로 걸러 내려준다)
  const allowed = index.filter(c => !c.route || canDo(c.route));
  /* keywords 는 화면에 안 보이는 검색 태그다(lib/nav.js LEAF_TAGS).
     '세금계산서'로 대금 청구서를, '통장'으로 계좌·카드를 찾게 해준다 —
     메뉴명만으로 검색하면 처음 쓰는 사람은 무슨 이름인지 몰라서 못 찾는다. */
  const match = (c) =>
    c.label.toLowerCase().includes(ql)
    || (c.sub || "").toLowerCase().includes(ql)
    || (c.keywords || "").toLowerCase().includes(ql)
    || c.kind.includes(q.trim());
  /* 줄 세우는 순서 — 위에서부터 이렇게 읽힌다.
   *   0 메뉴        : 거래처가 수백 건이면 메뉴가 밑으로 밀려, '보험'을 쳐도
   *                   보험 거래처만 잔뜩 나오고 정작 보험 화면은 안 보인다.
   *   1 아직 안 끝난 것 : 정산 안 된 청구서, 살아 있는 정기 규칙(rank=1).
   *                   거래처를 검색하는 이유는 대개 "받을 게 남았나"다.
   *   2 그 밖의 데이터  : 주문·거래처(rank 없음 → 2)
   *   3 끝난 것        : 정산 완료 청구서, 중지된 규칙
   * 같은 층 안에서는 원래 순서를 지킨다(정렬이 안정적이라 목록이 튀지 않는다). */
  const tier = (c) => (c.kind === '메뉴' ? 0 : (c.rank ?? 2));
  const results = (ql
    ? allowed.filter(match).sort((a, b) => tier(a) - tier(b))
    : allowed
  ).slice(0, 50);

  // 열릴 때 실데이터 인덱스 로드(거래처·주문·청구서 + 메뉴)
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    api.getCommandIndex().then(list => { if (alive) { setIndex(list); setLoading(false); } }).catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open]);

  useEffect(() => { if (open) { setQ(""); setIdx(0); setTimeout(() => inputRef.current?.focus(), 50); } }, [open]);
  useEffect(() => { setIdx(0); }, [results.length]);

  // 선택된 항목 자동 스크롤
  useEffect(() => {
    const el = listRef.current?.children[idx];
    el?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && results[idx]) { onPick(results[idx]); }
  };

  if (!open) return null;

  return (
    <div onClick={onClose} data-modal-open style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(11,18,32,0.36)", display: "grid", placeItems: "start center", paddingTop: 96, backdropFilter: "blur(2px)" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "min(560px, calc(100vw - 32px))", background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 30px 80px -20px rgba(15,23,42,0.35)", animation: "fadeUp .16s ease" }}>
        <div className="row gap-10" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
          <Icon.Search size={18} className="text-muted"/>
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="거래처·주문·청구서·정기 규칙·메뉴 검색"
            style={{ flex: 1, border: 0, outline: 0, fontSize: 15, fontFamily: "inherit", background: "transparent" }}/>
          <span className="kbd">ESC</span>
        </div>
        <div ref={listRef} style={{ maxHeight: 380, overflowY: "auto", padding: 6 }}>
          {results.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: "var(--muted-2)", fontSize: 13 }}>
              {loading ? "불러오는 중…" : "검색 결과가 없어요."}
            </div>
          )}
          {results.map((c, i) => (
            <button key={i} onClick={() => onPick(c)} onMouseEnter={() => setIdx(i)}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: 0,
                background: i === idx ? "var(--surface-2)" : "transparent",
                textAlign: "left", fontFamily: "inherit", cursor: "pointer", borderRadius: 8 }}>
              {/* 메뉴는 '어디로 가는 길'이라 데이터 항목과 성격이 다르다 —
                  처음 쓰는 사람이 찾는 게 대개 이쪽이라 눈에 띄게 둔다. */}
              <span className={`badge ${c.kind === '메뉴' ? 'brand' : 'outline'}`}
                style={{ width: 56, justifyContent: "center" }}>{c.kind}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="fw-600 text-sm">{c.label}</div>
                {c.sub && <div className="text-xs text-muted2">{c.sub}</div>}
              </div>
              <Icon.Right size={14} className="text-muted2"/>
            </button>
          ))}
        </div>
        <div className="row gap-12" style={{ padding: "10px 16px", borderTop: "1px solid var(--line)", fontSize: 11, color: "var(--muted-2)" }}>
          <span><span className="kbd">↑↓</span> 이동</span>
          <span><span className="kbd">↵</span> 선택</span>
          <span><span className="kbd">ESC</span> 닫기</span>
        </div>
      </div>
    </div>
  );
};

export default function App() {
  // 토큰이 죽었으면 앱을 그리지 않는다.
  // 플래그만 보고 들어가면 죽은 토큰으로 요청 십수 개를 쏘고, 그 401들이 세션을 지우며
  // '들어갔다 다시 튕겨나오는' 화면이 된다(어제 쓰던 브라우저를 아침에 열면 매번).
  const [loggedIn, setLoggedIn] = useState(() => sessionAlive());
  const [user, setUser] = useState(() => {
    if (!sessionAlive()) return null;
    try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
  });
  // 권한 — 서버가 진실이다. 토큰에 싣지 않으므로 새로고침·로그인마다 다시 읽는다.
  // null = 아직 못 읽음 → 그 동안은 제한 없이 보여준다(빈 사이드바가 잠깐 번쩍이는 게 더 나쁘다).
  // 어차피 서버가 막으므로 이 짧은 구간에 권한 없는 화면을 눌러도 데이터는 안 나온다.
  const [perms, setPerms] = useState(null);
  useEffect(() => {
    if (!loggedIn) { setPerms(null); return; }
    let alive = true;
    api.me()
      .then(me => { if (alive) setPerms(me?.perms || {}); })
      .catch(() => { /* 실패 시 제한 없음 유지 — 서버 게이트가 최종 판정 */ });
    return () => { alive = false; };
  }, [loggedIn]);

  const handleLogin = (u) => {
    localStorage.setItem('loggedIn', '1');
    localStorage.setItem('user', JSON.stringify(u));
    setUser(u); setLoggedIn(true);
  };
  const handleLogout = () => {
    // 첨부파일 접근 쿠키(httpOnly)는 서버만 지울 수 있다. localStorage만 비우면
    // 로그아웃 후에도 8시간 동안 /uploads 로 이전 회사 첨부에 접근할 수 있다.
    // 실패해도 로그아웃은 계속 진행한다(응답을 기다리지 않음).
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    clearSession();
    setUser(null); setLoggedIn(false);
  };

  // 관리자가 리셋한 임시 비번으로 들어온 계정은 새 비번을 정하기 전엔 앱에 못 들어간다.
  const clearMustChange = () => {
    const u = { ...user, mustChangePw: false };
    localStorage.setItem('user', JSON.stringify(u));
    setUser(u);
  };

  return (
    <ToastProvider>
      <ConfirmProvider>
        <PermCtx.Provider value={perms}>
          {!loggedIn
            ? <LoginScreen onLogin={handleLogin}/>
            : user?.mustChangePw
              ? <ForcePasswordChange user={user} onDone={clearMustChange} onLogout={handleLogout}/>
              : <AppInner onLogout={handleLogout} user={user}/>}
          {/* 배포로 새 버전이 올라왔을 때만 뜬다. 로그인 화면에서도 보여야 한다 —
              옛 번들이 옛 인증 흐름을 타면 로그인 자체가 이상하게 동작할 수 있다. */}
          <UpdateBanner/>
        </PermCtx.Provider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

// 최초 로그인(관리자 리셋) 시 비번 변경 강제 — 성공해야 앱으로 들어간다.
function ForcePasswordChange({ user, onDone, onLogout }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (pw.length < 4) return setErr('비밀번호는 4자 이상으로 해주세요.');
    if (pw !== pw2) return setErr('두 비밀번호가 일치하지 않아요.');
    setBusy(true);
    const res = await api.updateUserPassword(user.id, pw);   // 본인 변경 → 서버가 must_change_pw=0으로
    setBusy(false);
    if (!res.ok) return setErr(res.error || '변경에 실패했어요.');
    onDone();
  };
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#fff', padding: 20 }}>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: 360 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em', marginBottom: 6 }}>비밀번호 변경</div>
        <div style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 24 }}>
          임시 비밀번호로 로그인했어요. 계속하려면 새 비밀번호를 정해주세요.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input className="input" type="password" autoFocus placeholder="새 비밀번호 (4자 이상)"
            value={pw} onChange={e => { setPw(e.target.value); setErr(''); }} style={{ height: 44 }}/>
          <input className="input" type="password" placeholder="새 비밀번호 확인"
            value={pw2} onChange={e => { setPw2(e.target.value); setErr(''); }} style={{ height: 44 }}/>
          {err && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10,
              background: 'var(--neg-soft)', color: 'var(--neg-ink)', fontSize: 13 }}>
              <Icon.Warn size={14}/> {err}
            </div>
          )}
          <button className="btn primary" type="submit" disabled={busy} style={{ height: 46, fontWeight: 700 }}>
            {busy ? '변경 중...' : '변경하고 시작하기'}
          </button>
          <button type="button" className="btn" onClick={onLogout} style={{ height: 40 }}>다른 계정으로 로그인</button>
        </div>
      </form>
    </div>
  );
}
