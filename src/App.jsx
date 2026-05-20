import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { Icon, useToast, useConfirm, Popover, PopItem, ToastProvider, ConfirmProvider } from './lib/ui'
import { LoginScreen } from './screens/Login'
import { HomeScreen } from './screens/Home'
import { LedgerScreen } from './screens/Ledger'
import { TransactionForm } from './screens/Form'
import { ContractListScreen, ContractScreen, CONTRACT_LIST } from './screens/Contract'
import { DocsScreen, EvidenceScreen, EvidenceAttachDrawer, ExcelScreen, ReportsScreen } from './screens/Docs'
import { HRScreen } from './screens/HR'
import { MasterScreen } from './screens/Master'

const NAV = [
  { id: "home",     label: "홈",       icon: Icon.Home,      group: "main" },
  { id: "ledger",   label: "거래내역", icon: Icon.Wallet,    group: "main" },
  { id: "contract", label: "계약",     icon: Icon.Briefcase, group: "main" },
  { id: "hr",       label: "인사관리", icon: Icon.Building,  group: "main" },
  { id: "report",   label: "보고서",   icon: Icon.Chart,     group: "main" },
];

const SETTINGS_NAV = [
  { id: "master", label: "설정", icon: Icon.Cog },
];

const CRUMB_MAP = {
  home:            ["홈"],
  ledger:          ["거래내역"],
  ledger_income:   ["거래내역", "입금"],
  ledger_expense:  ["거래내역", "지출"],
  ledger_ar:       ["거래내역", "미수금"],
  ledger_ap:       ["거래내역", "미지급금"],
  contract:        ["계약"],
  contract_detail: ["계약", null],
  hr:              ["인사관리"],
  report:          ["보고서"],
  master:          ["설정"],
};

// 알림 상대 시간 계산
const relTime = (ts) => {
  const diff = Date.now() - new Date(ts).getTime()
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (h < 1)  return "방금 전"
  if (h < 24) return `${h}시간 전`
  if (d === 1) return "어제"
  const dt = new Date(ts)
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일`
}

const _now = Date.now()
const SAMPLE_NOTIFS = [
  { tone: "neg",     icon: <Icon.Warn size={14}/>,    title: "(주)동방산업 미수금이 62일 연체되었습니다",  sub: "전차 궤도 부품 시제 · 11,800,000원",      ts: new Date(_now - 2 * 3600000).toISOString() },
  { tone: "warn",    icon: <Icon.Bell size={14}/>,    title: "결의서 EXP-2026-0229 승인 요청",            sub: "외주가공비 — (주)한울정밀 · 4,200,000원", ts: new Date(_now - 6 * 3600000).toISOString() },
  { tone: "warn",    icon: <Icon.Receipt size={14}/>, title: "검사성적서 누락 3건",                        sub: "초도검사 · 시험성적서 등록 필요",          ts: new Date(_now - 26 * 3600000).toISOString() },
  { tone: "brand",   icon: <Icon.Check size={14}/>,   title: "한화에어로스페이스 기성고 24,800,000원 입금", sub: "기업은행 *123 · KF-21 동체 부품",         ts: new Date(_now - 30 * 3600000).toISOString() },
  { tone: "outline", icon: <Icon.Clock size={14}/>,   title: "포스코강판 자재 발주 결제 예정",             sub: "12,400,000원 · D-4",                       ts: new Date(_now - 8 * 86400000).toISOString() },
];

const SAMPLE_COMMANDS = [
  { kind: "거래처", label: "한화에어로스페이스",  sub: "KF-21 동체 부품 진행중",            route: "contract" },
  { kind: "거래처", label: "LIG넥스원",            sub: "유도무기 정밀가공 진행중",          route: "contract" },
  { kind: "계약",   label: "KF-21 동체 부품 가공", sub: "한화에어로스페이스 · 142,000,000원", route: "contract_detail" },
  { kind: "결의서", label: "EXP-2026-0231",        sub: "외주가공비 — 정밀도금 (주)",        route: "doc" },
  { kind: "증빙",   label: "발주서_한화에어로스페이스_KF-21_1차.pdf", sub: "2026-01-15",    route: "evidence" },
  { kind: "메뉴",   label: "미수금 관리",          sub: "6건",                               route: "ar" },
  { kind: "메뉴",   label: "미지급금 관리",        sub: "9건",                               route: "ap" },
  { kind: "메뉴",   label: "엑셀 업로드",          sub: "",                                  route: "excel" },
];

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
    title: "계약 관리",
    items: [
      "미수금·미지급금·계약목록 탭으로 구분해 조회하세요",
      "기간·비목 필터로 원하는 기간의 데이터만 볼 수 있어요",
      "담당자 필터로 PM별 계약을 구분해 조회할 수 있어요",
      "행 클릭 시 계약 상세·결의서·증빙 이력을 확인할 수 있어요",
    ]
  },
  contract_detail: {
    title: "계약 상세",
    items: [
      "계약 상세에서 결의서와 증빙 이력을 한 번에 확인하세요",
      "입금·지출 등록으로 해당 계약 거래내역을 바로 추가할 수 있어요",
      "진행률 바는 계약금액 대비 입금 완료 비율이에요",
      "파일 첨부로 계약서·발주서·검사성적서를 등록할 수 있어요",
    ]
  },
  hr: {
    title: "인사관리",
    items: [
      "직원 탭에서 재직·퇴직 인원 현황을 확인하세요",
      "급여 탭에서 월별 급여 명세 및 4대보험을 확인할 수 있어요",
      "급여일·공제율 등 기본값은 설정에서 조정하세요",
      "직원 행 클릭 시 상세 급여 구성을 확인할 수 있어요",
    ]
  },
  report: {
    title: "보고서",
    items: [
      "각 보고서 카드를 클릭하면 상세 자료를 확인할 수 있어요",
      "월별·계약별·발주처별로 나눠 세무사 전달 자료를 준비하세요",
      "보고서 화면에서 인쇄·PDF 저장을 바로 실행할 수 있어요",
      "기준 월은 화면 상단에 표시된 날짜를 기준으로 집계돼요",
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

function AppInner({ onLogout, user }) {
  const [route, setRoute] = useState("home");
  const [contractId, setContractId] = useState("CT-2026-101");
  const [txnForm, setTxnForm] = useState(null);
  const [evidenceAttach, setEvidenceAttach] = useState(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifRead, setNotifRead] = useState(false);
  const [faqOpen, setFaqOpen] = useState(false);
  const [idlePhase, setIdlePhase] = useState("hidden"); // "hidden" | "showing" | "dismissing"
  const [nudgeMode, setNudgeMode] = useState(() => localStorage.getItem("nudgeMode") || "always");
  const idleRef = useRef(null);
  const toast = useToast();
  const { confirm } = useConfirm();
  const unreadCount = notifRead ? 0 : SAMPLE_NOTIFS.length;

  useEffect(() => {
    const apply = () => {
      const h = window.location.hash.replace("#", "");
      if (h && CRUMB_MAP[h]) setRoute(h);
    };
    apply();
    window.addEventListener("hashchange", apply);
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); setCmdOpen(true);
      } else if (e.key === "Escape") {
        setCmdOpen(false); setSidebarOpen(false); setFaqOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", apply);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

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
    const actionEvents = ["click", "keydown", "scroll", "touchstart"];
    moveEvents.forEach(e   => window.addEventListener(e, onMove,   { passive: true }));
    actionEvents.forEach(e => window.addEventListener(e, onAction, { passive: true }));
    startTimer();
    return () => {
      moveEvents.forEach(e   => window.removeEventListener(e, onMove));
      actionEvents.forEach(e => window.removeEventListener(e, onAction));
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

  const go = (id, opts = {}) => {
    if (opts.contractId) setContractId(opts.contractId);
    setRoute(id);
    window.location.hash = id;
    window.scrollTo({ top: 0 });
    setSidebarOpen(false);
  };

  const Screen = useMemo(() => {
    if (route.startsWith("ledger")) {
      const filter = route === "ledger_income" ? "income"
                   : route === "ledger_expense" ? "expense"
                   : route === "ledger_ar" ? "ar"
                   : route === "ledger_ap" ? "ap"
                   : "all";
      return <LedgerScreen initialFilter={filter} openIncome={() => setTxnForm("income")} openExpense={() => setTxnForm("expense")} openExcel={() => go("excel_modal")}/>;
    }
    switch (route) {
      case "home":            return <HomeScreen go={go} user={user} openIncome={() => setTxnForm("income")} openExpense={() => setTxnForm("expense")}/>;
      case "contract":        return <ContractListScreen goDetail={(id) => go("contract_detail", { contractId: id })}/>;
      case "contract_detail": return <ContractScreen goList={() => go("contract")} contractId={contractId} openIncome={() => setTxnForm("income")} openExpense={() => setTxnForm("expense")}/>;
      case "hr":              return <HRScreen/>;
      case "report":          return <ReportsScreen/>;
      case "master":          return <MasterScreen/>;
      case "excel_modal":     return <ExcelScreen/>;
      case "income":          return <LedgerScreen initialFilter="income" openIncome={() => setTxnForm("income")} openExpense={() => setTxnForm("expense")} openExcel={() => go("excel_modal")}/>;
      case "expense":         return <LedgerScreen initialFilter="expense" openIncome={() => setTxnForm("income")} openExpense={() => setTxnForm("expense")} openExcel={() => go("excel_modal")}/>;
      case "ar":              return <LedgerScreen initialFilter="ar" openIncome={() => setTxnForm("income")} openExpense={() => setTxnForm("expense")} openExcel={() => go("excel_modal")}/>;
      case "ap":              return <LedgerScreen initialFilter="ap" openIncome={() => setTxnForm("income")} openExpense={() => setTxnForm("expense")} openExcel={() => go("excel_modal")}/>;
      case "doc":             return <DocsScreen openExpense={() => setTxnForm("expense")}/>;
      case "evidence":        return <EvidenceScreen onAttach={(item) => setEvidenceAttach(item)}/>;
      case "excel":           return <ExcelScreen/>;
      default:                return <HomeScreen go={go} openIncome={() => setTxnForm("income")} openExpense={() => setTxnForm("expense")}/>;
    }
  }, [route, contractId]);

  let activeId = route;
  if (route === "contract_detail") activeId = "contract";
  if (route.startsWith("ledger") || ["income", "expense", "ar", "ap", "doc", "evidence", "excel_modal"].includes(route)) activeId = "ledger";

  const helpKey = route.startsWith("ledger") || ["income","expense","ar","ap","excel_modal"].includes(route) ? "ledger" : route;
  const help = HELP_MAP[helpKey] || HELP_MAP.home;

  let crumbs = CRUMB_MAP[route] || ["홈"];
  if (route === "contract_detail") {
    const c = CONTRACT_LIST.find(x => x.id === contractId);
    crumbs = ["계약", c?.name || "계약 상세"];
  }

  return (
    <div className="app">
      {/* Mobile overlay */}
      <div className={`sidebar-overlay${sidebarOpen ? " open" : ""}`} onClick={() => setSidebarOpen(false)}/>

      {/* Sidebar */}
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="brand">
          <img src="/src/assets/logo/logo_symbol_64.png" alt="로고" style={{ width: 36, height: 36, objectFit: "contain", flexShrink: 0 }}/>
          <div className="name">동진테크 - 회계관리</div>
        </div>

        <div>
          {NAV.filter(n => n.group === "main").map(n => {
            const active = activeId === n.id;
            const Ic = n.icon;
            return (
              <div key={n.id} className={`nav-item${active ? " active" : ""}`} onClick={() => go(n.id)}>
                <Ic className="nav-ico"/>
                <span>{n.label}</span>
                {n.badge != null && <span className="nav-count">{n.badge}</span>}
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: "auto", paddingTop: 8 }}>
          {SETTINGS_NAV.map(n => {
            const active = activeId === n.id;
            const Ic = n.icon;
            return (
              <div key={n.id} className={`nav-item${active ? " active" : ""}`} style={{ fontSize: 12.5, color: active ? undefined : "var(--muted-2)" }} onClick={() => go(n.id)}>
                <Ic className="nav-ico" size={16}/>
                <span>{n.label}</span>
              </div>
            );
          })}
        </div>

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
            {crumbs.map((c, i, arr) => (
              <Fragment key={i}>
                {i === arr.length - 1
                  ? <b>{c}</b>
                  : <span style={{ cursor: i === 0 && route === "contract_detail" ? "pointer" : "default" }}
                      onClick={() => i === 0 && route === "contract_detail" && go("contract")}>{c}</span>}
                {i < arr.length - 1 && <span style={{ margin: "0 8px", color: "var(--subtle)" }}>›</span>}
              </Fragment>
            ))}
          </div>
          <button className="search" onClick={() => setCmdOpen(true)} style={{ border: 0, cursor: "pointer", textAlign: "left" }}>
            <Icon.Search size={14}/>
            <span style={{ flex: 1 }}>거래처, 계약, 영수증 검색</span>
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
                {SAMPLE_NOTIFS.map((n, i) => (
                  <div key={i} className="row gap-10" style={{ padding: "12px 14px", borderTop: i ? "1px solid var(--line)" : 0, alignItems: "flex-start", opacity: notifRead ? 0.5 : 1 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                      background: `var(--${n.tone === "neg" ? "neg" : n.tone === "warn" ? "warn" : n.tone === "brand" ? "brand" : "surface-3"}-soft)`,
                      color: `var(--${n.tone === "neg" ? "neg" : n.tone === "warn" ? "warn" : n.tone === "brand" ? "brand" : "muted"})`,
                      display: "grid", placeItems: "center",
                    }}>{n.icon}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="text-sm fw-600" style={{ marginBottom: 2 }}>{n.title}</div>
                      <div className="text-xs text-muted2">{n.sub} · {relTime(n.ts)}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ padding: 8, borderTop: "1px solid var(--line)" }}>
                <button className="btn ghost sm" style={{ width: "100%" }} onClick={() => setNotifRead(true)}>모두 읽음 처리</button>
              </div>
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
                    <span className="text-sm" style={{ lineHeight: 1.55, color: "var(--text)" }}>{item}</span>
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

        <div className="content">
          {Screen}
        </div>
      </main>

      <TransactionForm open={txnForm !== null} kind={txnForm || "expense"} onClose={() => setTxnForm(null)}/>
      <EvidenceAttachDrawer item={evidenceAttach} onClose={() => setEvidenceAttach(null)}/>
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} onPick={(c) => { setCmdOpen(false); go(c.route); }}/>

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
const FAQ_CATEGORIES = ["거래 등록", "미수금·미지급금", "계약 관리", "증빙·결의서", "인사·급여", "보고서·마감", "시스템·설정"];

const FAQ_DATA = [
  // 거래 등록
  { id:"f01", cat:"거래 등록",       routes:["home","ledger"],              q:"입금을 어떻게 등록하나요?",                  a:"화면 우측 상단 '거래 등록 → 입금 등록'을 클릭하거나, 홈 화면 '오늘 할 일'에서 해당 입금 건을 직접 처리할 수 있어요.", action:null },
  { id:"f02", cat:"거래 등록",       routes:["home","ledger"],              q:"지출을 어떻게 등록하나요?",                  a:"화면 우측 상단 '거래 등록 → 지출 등록'을 눌러 7단계로 입력하세요. 거래처·계약·비목·금액·결제수단·증빙·결의서 순이에요.", action:null },
  { id:"f03", cat:"거래 등록",       routes:["ledger"],                     q:"여러 건을 한꺼번에 올리고 싶어요",            a:"엑셀 업로드 기능을 이용하면 여러 거래를 한 번에 등록할 수 있어요. '거래 등록 → 엑셀 업로드'에서 서식을 내려받아 작성한 뒤 업로드해 주세요.", action:{ label:"엑셀 업로드로", route:"excel_modal" } },
  { id:"f04", cat:"거래 등록",       routes:["ledger"],                     q:"거래 내용을 수정하거나 삭제하고 싶어요",      a:"거래내역 화면에서 해당 행을 클릭하면 상세 패널이 열려요. 패널 하단의 수정·삭제 버튼으로 처리할 수 있어요.", action:{ label:"거래내역으로", route:"ledger" } },
  { id:"f05", cat:"거래 등록",       routes:["ledger","home"],              q:"등록하려는 거래처가 목록에 없어요",           a:"거래처는 설정 화면에서 먼저 추가해야 해요. 설정 → 거래처 탭에서 새 거래처를 등록한 뒤 다시 시도해 보세요.", action:{ label:"설정으로", route:"master" } },
  { id:"f06", cat:"거래 등록",       routes:["ledger","home","contract"],   q:"등록하려는 계약이 목록에 없어요",             a:"계약은 계약 목록 화면에서 '새 계약' 버튼으로 먼저 만들어야 해요. 계약이 없는 지출이라면 거래 등록 시 '공통비'를 선택할 수도 있어요.", action:{ label:"계약 목록으로", route:"contract" } },
  // 미수금·미지급금
  { id:"f07", cat:"미수금·미지급금", routes:["contract","ledger"],          q:"미수금이 자동으로 생성되지 않아요",           a:"입금 등록 2단계에서 계약을 선택했는지 확인해 보세요. 계약을 연결해야 해당 계약의 미수금이 자동으로 차감돼요.", action:{ label:"거래내역으로", route:"ledger" } },
  { id:"f08", cat:"미수금·미지급금", routes:["contract","home"],            q:"연체된 미수금은 어떻게 처리하나요?",          a:"미수금 화면의 '기한 지남' 탭에서 연체 건을 확인하세요. 행 우측 '독촉' 버튼으로 거래처에 메일을 보내고, 입금 확인 후 '입금 처리'를 누르면 돼요.", action:{ label:"미수금으로", route:"contract" } },
  { id:"f09", cat:"미수금·미지급금", routes:["contract"],                   q:"미지급금 이체를 어떻게 실행하나요?",          a:"미지급금 화면에서 이체할 건의 체크박스를 선택한 뒤 '선택 이체 실행'을 눌러요. 결의서 승인이 완료된 건만 이체가 가능해요.", action:{ label:"미지급금으로", route:"contract" } },
  { id:"f10", cat:"미수금·미지급금", routes:["home","contract"],            q:"홈에 '연체 미수금' 알림이 뜨는데 어디서 처리하나요?", a:"홈 화면의 알림 카드를 직접 클릭하면 미수금 화면으로 바로 이동해요. 또는 계약 메뉴 → 미수금 탭에서 처리할 수 있어요.", action:{ label:"미수금으로", route:"contract" } },
  // 계약 관리
  { id:"f11", cat:"계약 관리",       routes:["contract","contract_detail"], q:"계약 담당자(PM)를 변경하고 싶어요",           a:"계약 상세 화면에서 담당자 항목을 클릭하면 수정할 수 있어요. 설정 → 직원 탭에서 PM으로 지정된 직원 중에서 선택할 수 있어요.", action:{ label:"계약 목록으로", route:"contract" } },
  { id:"f12", cat:"계약 관리",       routes:["contract_detail"],            q:"계약과 연결된 거래를 추가하고 싶어요",        a:"계약 상세 화면 우측 상단의 '입금 등록' 또는 '지출 등록'을 누르면 해당 계약에 자동 연결된 거래로 등록돼요.", action:null },
  { id:"f13", cat:"계약 관리",       routes:["contract_detail"],            q:"발주서나 계약서 파일을 첨부하고 싶어요",      a:"계약 상세 화면의 '증빙' 탭에서 파일을 드래그하거나 선택해 첨부할 수 있어요. PDF·이미지·엑셀 형식을 지원해요.", action:null },
  { id:"f14", cat:"계약 관리",       routes:["contract"],                   q:"진행률 바는 어떻게 계산되나요?",              a:"계약금액 대비 현재까지 입금 처리된 금액의 비율이에요. 입금을 등록하고 계약과 연결하면 자동으로 반영돼요.", action:null },
  // 증빙·결의서
  { id:"f15", cat:"증빙·결의서",     routes:["evidence","ledger"],          q:"세금계산서를 어떻게 등록하나요?",              a:"증빙 관리 화면에서 '+ 증빙 등록'을 눌러 파일을 업로드하세요. 등록 후 해당 거래와 연결하면 자동 매칭이 돼요.", action:{ label:"증빙 관리로", route:"evidence" } },
  { id:"f16", cat:"증빙·결의서",     routes:["ledger","evidence"],          q:"거래내역에 ⚠️ 표시는 무엇인가요?",            a:"세금계산서나 영수증이 연결되지 않은 거래에 표시돼요. 증빙 관리 화면에서 파일을 업로드하거나, 거래 상세에서 직접 첨부하면 사라져요.", action:{ label:"증빙 관리로", route:"evidence" } },
  { id:"f17", cat:"증빙·결의서",     routes:["doc","contract"],             q:"결의서 승인이 안 돼요",                        a:"결의서는 결재선 순서대로 승인이 이루어져요. 현재 결재자가 누구인지 결의서 상세에서 확인하고, 해당 담당자에게 승인을 요청하세요.", action:{ label:"결의서로", route:"doc" } },
  { id:"f18", cat:"증빙·결의서",     routes:["doc"],                        q:"외주가공비 결의서를 새로 만들고 싶어요",      a:"지출 등록 마지막 단계에서 '결의서 자동 생성'을 켜두면 지출 등록과 동시에 결의서가 생성돼요. 또는 결의서 화면에서 '+ 결의서 작성'을 눌러도 돼요.", action:{ label:"결의서로", route:"doc" } },
  { id:"f19", cat:"증빙·결의서",     routes:["doc","contract"],             q:"결의서와 미지급금은 어떻게 연결되나요?",      a:"지출 등록 시 결의서가 생성되고, 결의서가 승인되면 해당 금액이 미지급금 목록에 자동으로 올라와요. 이체 실행 시 미지급금이 차감돼요.", action:null },
  // 인사·급여
  { id:"f20", cat:"인사·급여",       routes:["hr"],                         q:"새 직원을 등록하려면 어떻게 하나요?",          a:"인사관리 → 직원 탭에서 '직원 등록' 버튼을 눌러 기본급·수당·계좌 정보를 입력하세요. 다음 달 급여부터 자동 반영돼요.", action:{ label:"인사관리로", route:"hr" } },
  { id:"f21", cat:"인사·급여",       routes:["hr"],                         q:"급여 계산이 틀린 것 같아요",                   a:"급여는 직원 마스터의 기본급·수당과 설정의 4대보험 요율로 자동 계산돼요. 직원 행을 클릭해 개별 명세를 확인하고, 마감 화면에서 보너스·추가공제를 조정할 수 있어요.", action:{ label:"인사관리로", route:"hr" } },
  { id:"f22", cat:"인사·급여",       routes:["hr"],                         q:"이번 달 급여를 일괄 이체하려면 어떻게 하나요?", a:"인사관리 → 이번 달 급여 탭에서 '마감하기'로 보너스·추가공제를 입력한 뒤 '급여 일괄 이체'를 눌러요. 등록된 계좌로 실수령액이 이체돼요.", action:{ label:"인사관리로", route:"hr" } },
  { id:"f23", cat:"인사·급여",       routes:["hr","master"],                q:"4대보험 요율이 올해 기준과 다른 것 같아요",    a:"보험료율은 설정 화면에서 직접 수정할 수 있어요. 매년 초 고용노동부 고시 기준으로 요율을 업데이트해 주세요.", action:{ label:"설정으로", route:"master" } },
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
    <div style={{ position:"fixed", inset:0, zIndex:90, display:"flex" }}>
      <div onClick={onClose} style={{ flex:1, background:"rgba(11,18,32,0.18)", backdropFilter:"blur(1px)" }}/>
      <div style={{ width:"min(380px,100vw)", background:"#fff", display:"flex", flexDirection:"column",
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
            <div className="text-sm" style={{ lineHeight:1.8, color:"var(--text)" }}>{sel.a}</div>
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
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const results = SAMPLE_COMMANDS.filter(c => !q || c.label.toLowerCase().includes(q.toLowerCase()) || c.sub.toLowerCase().includes(q.toLowerCase()) || c.kind.includes(q));

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
            placeholder="거래처·계약·결의서·증빙·메뉴 검색"
            style={{ flex: 1, border: 0, outline: 0, fontSize: 15, fontFamily: "inherit", background: "transparent" }}/>
          <span className="kbd">ESC</span>
        </div>
        <div ref={listRef} style={{ maxHeight: 380, overflowY: "auto", padding: 6 }}>
          {results.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: "var(--muted-2)", fontSize: 13 }}>검색 결과가 없어요.</div>
          )}
          {results.map((c, i) => (
            <button key={i} onClick={() => onPick(c)} onMouseEnter={() => setIdx(i)}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: 0,
                background: i === idx ? "var(--surface-2)" : "transparent",
                textAlign: "left", fontFamily: "inherit", cursor: "pointer", borderRadius: 8 }}>
              <span className="badge outline" style={{ width: 56, justifyContent: "center" }}>{c.kind}</span>
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
  const [loggedIn, setLoggedIn] = useState(() => localStorage.getItem('loggedIn') === '1');
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
  });

  const handleLogin = (u) => {
    localStorage.setItem('loggedIn', '1');
    localStorage.setItem('user', JSON.stringify(u));
    setUser(u); setLoggedIn(true);
  };
  const handleLogout = () => {
    localStorage.removeItem('loggedIn');
    localStorage.removeItem('user');
    setUser(null); setLoggedIn(false);
  };

  return (
    <ToastProvider>
      <ConfirmProvider>
        {loggedIn ? <AppInner onLogout={handleLogout} user={user}/> : <LoginScreen onLogin={handleLogin}/>}
      </ConfirmProvider>
    </ToastProvider>
  );
}
