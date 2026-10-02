import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, StatusBadge, periodToRange, FilterSelect, Drawer, localToday, fmtDateShort } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { SummaryCard, SummaryRow } from '../lib/components/Kpi'
import { DataTable } from '../lib/components/DataTable'
import { TableToolbar } from '../lib/components/TableToolbar'
import { VoucherView } from '../lib/components/VoucherView'
import { VoucherSlip } from '../lib/components/VoucherSlip'
import { AttachmentPanel } from '../lib/components/AttachmentPanel'
import { TransactionForm } from './Form'
import { useTableFilter } from '../lib/tableFilter'
import { api } from '../lib/api'
import { downloadXlsx } from '../lib/export'
import { ResolutionDocument } from './Docs'
import { JournalEntryDrawer, journalVoucherOf } from './VoucherEntry'
import { SourceChooser } from '../lib/components/SourceChooser'
import { isMiscPl } from '../lib/txnScope'
import { usePerms } from '../lib/perms'
import { useOrdersFromMes } from '../lib/customModules'

// CSV 저장은 보고서 내보내기와 같은 것을 쓴다 → lib/export.js

/* 거래내역 — **조회 화면**. openIncome/openExpense 를 더 받지 않는다(등록 입구는 여기 없다).
   화면에서 뺀 것은 배선까지 은퇴시킨다 — 남겨 두면 다음 사람이 "쓰는 줄 알고" 다시 버튼을 단다. */
export const LedgerScreen = ({ initialFilter = "all", openEdit, openExcel, refreshTrigger,
  /* 3단계(2026-09) — 서류 없이 오간 돈의 **유일한 입구**가 됐다(세금계산서가 있으면 세금계산서 화면).
     입금·출금 폼은 App 이 소유하는 거래 서랍이고, 대체는 이 화면이 연다.
     canJournal — 전표 권한(voucher_entry)이 있을 때만 '전표입력'. openJournalOnMount — 옛 '전표 입력' 주소로 들어온 경우 */
  openIncome, openExpense, canJournal = false, openJournalOnMount = false,
  /* 다른 화면에서 "이 거래를 거래내역에서 열어줘"라고 넘겨준 id.
     없으면 평소처럼 목록만 연다(청구서의 focusInvoiceId 와 같은 방식). */
  focusTxnId, goRoute,
  /* 다른 화면(전표 목록)에서 "이 기간 그대로 와라"고 넘겨준 기간. 없으면 이번 달.
     ⚠ 기간만 들고 온다 — 비목·주문·검색까지 넘기면 두 화면이 서로의 필터를 알아야 한다. */
  initialRange = null,
  canVoucherBook = false }) => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [filter, setFilter] = useState(initialFilter);
  const [sel, setSel] = useState(null);
  /* 주문 일괄 연결 — 엑셀로 올린 거래를 한꺼번에 주문에 붙인다.
     allContracts 는 이름이 아니라 **id 로 보내야** 해서 목록을 따로 받는다
     (거래에서 뽑은 이름 목록은 아직 아무 거래도 안 붙은 주문을 모른다). */
  const [checkedIds, setCheckedIds] = useState([]);
  const [bulkContract, setBulkContract] = useState(null);
  const [allContracts, setAllContracts] = useState([]);
  const [txns, setTxns] = useState([]);
  /* 아직 못 읽었나 — 빈 배열만 보면 "거래내역이 없어요"가 열자마자 번쩍인다.
     '없음'과 '아직 안 옴'은 다른 말이다. 파생 계산은 그대로 두고 플래그만 따로 든다. */
  const [loading, setLoading] = useState(true);
  /* 거래내역은 **실제로 오간 돈만** 싣는다(2026-09-30 사용자 결정).
     예전엔 '예정 포함'(미수·미지급 세금계산서를 행으로 섞기)과 미수금·미지급금 카드가 있었다 —
     화면이 여럿으로 흩어져 있던 시절 "한 번에 들어올·나갈 돈을 보자"는 고객 요청이었다.
     지금은 미수·미지급은 세금계산서 화면이, 들어올·나갈 돈의 흐름은 자금일보가 맡는다.
     여기 섞으면 이 화면의 합계(통장 잔액과 맞아야 하는 숫자)와 표가 어긋나 보인다. */
  /* 대체전표 — 돈이 안 움직이는 분개. 예전엔 '전표 입력' 화면에만 있어서 거래내역만 보면 빠졌다.
     같은 표에 '대체'로 세운다. 합계(입금·지출)에는 안 든다 — 통장이 안 움직였으니까. */
  const [journals, setJournals] = useState([]);
  const [jOpen, setJOpen] = useState(openJournalOnMount && canJournal);
  const [entryPick, setEntryPick] = useState(false);   // 1단계 — 입금·출금·대체
  const [srcPick, setSrcPick] = useState(null);        // 2단계 — 손에 든 것(무엇에서 가져오나)
  const [jView, setJView] = useState(null);   // { voucher, jvId, docNo }
  useEffect(() => { if (openJournalOnMount && canJournal) setJOpen(true); }, [openJournalOnMount, canJournal]);

  /* 수주·발주를 MES 에서 보는 회사(동진) — 회계 쪽 계약 연결을 안 쓴다. 계약 칸·필터·미연결 탭·연결 도구를
     세우면 전부 빈 칸이거나 '전체'와 같은 목록이 된다(거래 등록 폼이 계약 칸을 숨기는 것과 같은 판단) */
  const ordersFromMes = useOrdersFromMes();
  // MES 회사는 '계약 미연결' 탭이 없다 — 옛 주소(misc_pl)로 들어와도 전체로 연다
  useEffect(() => { setFilter(initialFilter === 'misc' && ordersFromMes ? 'all' : initialFilter); }, [initialFilter, ordersFromMes]);

  /* 볼 권한이 있는 것만 부른다 — 조회의 403 은 화면 전체에 '권한이 없어요'를 띄운다(api.js notifyInfra).
     거래내역만 받은 역할이 이 화면을 열 때마다 오류를 보게 된다(대체전표·미수·미지급 요약). */
  const { can } = usePerms();
  const canJournalView = can("voucher_entry", "view") || can("voucher_book", "view");
  const reload = () => {
    api.getTransactions().then(setTxns).finally(() => setLoading(false));
    if (can("contract_sales", "view") || can("contract_purchase", "view") || can("contract", "view"))
      api.getContracts().then(list => setAllContracts(list || []));
    if (canJournalView) api.getJournalVouchers().then(list => setJournals(list || []));
  };
  useEffect(() => { reload(); }, []);
  useEffect(() => { if (refreshTrigger > 0) reload(); }, [refreshTrigger]);

  const categories = useMemo(() => [...new Set(txns.map(t => t.category).filter(Boolean))].sort(), [txns]);
  /* 주문 목록 — 근거 주문과 원가 귀속 둘 다 모은다. 외주비는 매입주문에 '지급'되면서
     동시에 매출주문의 '원가'라, 한 축만 보면 그 거래를 못 찾는다. */
  const contracts = useMemo(() => [...new Set(
    txns.flatMap(t => [t.contract, t.cost_contract_name]).filter(Boolean))].sort(), [txns]);

  /* 기간·비목·주문·검색 — 규칙은 공용 훅(lib/tableFilter)에 하나만 둔다.
     기본 기간은 이번 달(프리셋 버튼이 값을 바꿔준다). */
  const tf = useTableFilter({
    date: { field: 'date', initial: initialRange || periodToRange("month") },
    search: { fields: ['vendor', 'scope', 'category', 'contract'], placeholder: ordersFromMes ? "거래처·적요·비목 검색" : "거래처·계약·비목 검색" },
    filters: [
      { key: 'cat', label: "비목", field: 'category', options: categories },
      /* 주문으로 거르기 — 잘못 붙은 거래를 찾으려면 "이 주문에 붙은 것 전부"를
         한 번에 봐야 한다. 예전엔 검색어로 더듬는 수밖에 없었다.
         두 축(근거·원가 귀속)을 모두 본다 — 이 필터의 뜻이 그것이지, 어느 컬럼이냐가 아니다. */
      ...(ordersFromMes ? [] : [{ key: 'contract', label: "계약", options: contracts,
        match: (t, v) => t.contract === v || t.cost_contract_name === v }]),
    ],
  });
  const { range, setRange, q, setQ } = tf;

  /* 기간·비목·검색까지만 적용한 범위. 입금/지출 탭은 아직 안 나눈다.
     합계 카드와 탭 옆 건수는 이 범위를 쓴다 — 예전엔 둘 다 전체 txns 로 계산해서
     "2026년 7월"로 좁혀놔도 카드에는 **개업 이래 누계**가, 탭에는 전체 건수가 떠 있었다.
     화면의 표와 숫자가 서로 다른 기간을 말하니 그 값을 그대로 보고에 옮기면 틀린다. */
  const journalRows = useMemo(() => journals.map(v => ({
    id: `jv-${v.id}`, journal: true, jvId: v.id, docNo: v.doc_no,
    kind: 'journal', sign: 0, date: String(v.date || '').slice(0, 10),
    vendor: '', contract: '', scope: v.summary || v.memo || v.doc_no, category: '대체',
    amount: Number(v.total) || 0, status: '대체',
  })), [journals]);
  const scoped = useMemo(() => tf.apply([...txns, ...journalRows]), [txns, journalRows, tf.apply]);


  /* 짚어 열기 — 청구서·주문에서 "이 거래를 거래내역에서 열어줘"로 넘어온 경우.
     ⚠ **필터를 안 거친 원본(txns)에서 찾는다.** 기본 기간이 이번 달이라, 지난달 거래를
     넘겨받으면 filtered 에는 없어서 아무 일도 안 일어난다 — 넘어왔는데 안 열리면
     기능이 고장난 것으로 읽힌다. */
  useEffect(() => {
    if (!focusTxnId || !txns.length) return
    const hit = txns.find(t => t.id === focusTxnId)
    if (hit) setSel(hit)
  }, [focusTxnId, txns]);

  // 표에 실제로 그려지는 행 = 범위 + 탭
  const filtered = useMemo(() => {
    const byTab = (rows) =>
      filter === "income"  ? rows.filter(t => t.kind === "income")
      : filter === "expense" ? rows.filter(t => t.kind === "expense")
      /* 계약 미연결 = 옛 '경비 처리·잡손익' 화면(3단계에서 이 필터로 흡수). 규칙은 lib/txnScope.js 하나 */
      : filter === "misc"    ? rows.filter(t => !t.journal && isMiscPl(t))
      : rows;
    return byTab(scoped);
  }, [scoped, filter]);

  /* 내보내기는 화면에 보이는 그대로 담는다(실제로 오간 돈 + 대체전표) */
  const exportXlsx = async () => {
    if (filtered.length === 0) return toast.push("내보낼 거래가 없어요");
    const r = await downloadXlsx(`거래내역_${localToday()}.xlsx`, {
      title: "거래내역",
      sub: `${range.from} ~ ${range.to}` + (filter === "income" ? " · 입금" : filter === "expense" ? " · 지출" : ""),
      columns: [
        { header: "날짜", width: 12 },
        { header: "구분", width: 8, align: "center" },
        { header: "거래처", width: 22 },
        ...(ordersFromMes ? [] : [{ header: "계약", width: 20 }, { header: "원가 귀속", width: 20 }]),
        { header: "적요", width: 24 },
        { header: "비목", width: 14 },
        { header: "금액", width: 15, money: true },
        { header: "상태", width: 12, align: "center" },
      ],
      rows: filtered.map(t => [t.date,
        t.journal ? "대체" : t.kind === "income" ? "입금" : "지출",
        t.vendor, ...(ordersFromMes ? [] : [t.contract || "", t.cost_contract_name || ""]), t.scope, t.category,
        t.journal ? t.amount : t.sign * t.amount, t.status]),
    });
    if (!r.ok) toast.push(r.error || "엑셀을 만들지 못했어요", { tone: "warn" });
  };

  // 화면에서 사라진 선택은 버린다 — 안 보이는 거래를 주문에 붙이면 안 된다
  useEffect(() => {
    /* 걸러낸 결과가 **같으면 이전 배열을 그대로 돌려준다.**
       .filter() 는 바뀐 게 없어도 늘 새 배열을 만든다 → 매번 새 상태 → 다시 렌더 →
       이 effect 가 또 돌아 무한 루프가 된다(실제로 "Maximum update depth exceeded"가 났다).
       의존성이 원시값이던 때는 우연히 가려져 있었을 뿐, 지우는 게 맞는 쪽이다. */
    setCheckedIds(prev => {
      const next = prev.filter(id => filtered.some(t => t.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, [filtered, filter]);

  /* 고른 거래를 주문에 붙이거나 뗀다.
     ⚠ 축은 **거래 종류와 주문 종류**가 정한다 — 화면이 고르게 하면 반드시 틀린다.
        지출 + 매출 주문  → 원가 귀속(cost)
        그 외             → 근거 주문(contract)
     지출·입금이 섞여 있으면 축이 갈리므로 나눠 보낸다. */
  const doBulkLink = async (unlink) => {
    const rows = filtered.filter(t => checkedIds.includes(t.id));
    if (!rows.length) return;
    /* ⚠ **id 로 찾는다.** 예전엔 이름으로 찾았는데 주문 이름은 유일하지 않다 —
       실제 회사에 거래처만 다른 '홈페이지 유지보수' 가 여덟 개 있었고, 그때 find 는
       목록의 첫 번째를 집었다. 여기는 **한 번에 수십 건**을 붙이는 자리라 피해가 크다. */
    const target = unlink ? null : allContracts.find(c => c.id === bulkContract);
    if (!unlink && !target) return toast.push('계약을 골라주세요', { tone: 'warn' });

    /* ⚠ **주문에 적힌 방향이 먼저다.** 예전엔 `gubu A·E || is_purchase` 라 거래처가 이겼다 —
       수주로 만든 주문인데 거래처가 매입처면 축을 contract_id 로 보내는데, 서버는 그 주문을
       매출로 보아 원가를 cost_contract_id 에서만 센다. 붙인 지출이 원가에도 지급액에도
       안 잡히고 조용히 사라진다("N건 연결했어요"만 뜬다). */
    const isPurchaseC = target && (target.is_purchase ?? (target.gubu === 'A' || target.gubu === 'E'));
    const groups = new Map();   // axis → txnIds
    for (const t of rows) {
      const axis = (!unlink && t.kind === 'expense' && !isPurchaseC) ? 'cost' : 'contract';
      if (!groups.has(axis)) groups.set(axis, []);
      groups.get(axis).push(t.id);
    }
    if (unlink) {
      // 뗄 때는 붙어 있는 축을 그대로 푼다(둘 다 붙어 있으면 둘 다)
      groups.clear();
      groups.set('contract', rows.filter(t => t.contract).map(t => t.id));
      groups.set('cost', rows.filter(t => t.cost_contract_name).map(t => t.id));
    }

    let done = 0;
    for (const [axis, ids] of groups) {
      if (!ids.length) continue;
      const res = await api.linkTxnsToContract({ txnIds: ids, contractId: target?.id || null, axis });
      if (!res.ok) return toast.push(res.error || '연결에 실패했어요', { tone: 'warn' });
      done += res.count;
    }
    if (!done) return toast.push('연결된 계약이 없는 거래예요');
    toast.push(unlink ? `${done}건의 계약 연결을 뗐어요` : `${done}건을 ${target?.name || '계약'}에 연결했어요`);
    setCheckedIds([]); setBulkContract(null); reload();
  };

  // 선택한 거래를 한꺼번에 삭제. 각 건은 deleteTransaction 이 청구서 매칭·복합전표 splits 까지 정리한다.
  const doBulkDelete = async () => {
    const rows = filtered.filter(t => checkedIds.includes(t.id));
    if (!rows.length) return;
    const total = rows.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: '거래 일괄 삭제',
      body: `선택한 ${rows.length}건(합계 ${fmtNum(total)}원)을 삭제합니다. 복구할 수 없어요. 청구서에 붙은 입금·지급이면 그 정산도 함께 풀립니다.`,
      confirmLabel: '삭제',
    });
    if (!ok) return;
    /* ⚠ 실패는 **어느 건인지** 말한다. 여기서 막히는 건 마감된 달·결의서나 어음이 붙든 거래처럼
       진짜 이유가 있는 것들인데, "2건 실패"만 띄우면 무엇이 남았는지 알 길이 없다
       (한 건씩 지우는 경로라 일부만 지워진 채 끝난다 — 되짚을 수 있어야 한다). */
    let done = 0;
    const failed = [];
    for (const t of rows) {
      const res = await api.deleteTransaction(t.id);
      if (res.ok) done++;
      else failed.push(`${t.date} ${t.vendor || t.category || ''} ${fmtNum(t.amount)}원`.replace(/ +/g, ' ').trim());
    }
    setCheckedIds([]); reload();
    if (!failed.length) return toast.push(`${done}건 삭제됐어요`);
    toast.push(
      `${done}건 삭제, ${failed.length}건은 그대로예요 — ${failed.slice(0, 3).join(' / ')}`
      + (failed.length > 3 ? ` 외 ${failed.length - 3}건` : ''),
      { tone: 'warn' });
  };

  const openJournal = async (t) => {
    const v = await api.getJournalVoucher(t.jvId);
    if (!v) return toast.push('전표를 불러오지 못했어요', { tone: 'warn' });
    setJView({ voucher: journalVoucherOf(v), jvId: t.jvId, docNo: v.doc_no });
  };
  const removeJournal = async () => {
    if (!jView) return;
    const ok = await confirm({ tone: 'neg', icon: <Icon.Warn size={22}/>, title: '대체전표 삭제',
      body: `전표 ${jView.docNo || ''}를 지웁니다.`, detail: '분개 줄이 함께 지워져요.', confirmLabel: '삭제' });
    if (!ok) return;
    const res = await api.deleteJournalVoucher(jView.jvId);
    toast.push(res.ok ? '전표를 지웠어요' : (res.error || '삭제에 실패했어요'), res.ok ? undefined : { tone: 'warn' });
    if (res.ok) { setJView(null); reload(); }
  };

  const inSum  = scoped.filter(t => t.kind === "income"  && t.status === "입금완료").reduce((a, t) => a + t.amount, 0);
  const outSum = scoped.filter(t => t.kind === "expense" && t.status === "지급완료").reduce((a, t) => a + t.amount, 0);
  const inCount  = scoped.filter(t => t.kind === "income"  && t.status === "입금완료").length;
  const outCount = scoped.filter(t => t.kind === "expense" && t.status === "지급완료").length;

  /* 탭 숫자는 **그 탭을 눌렀을 때 표에 뜨는 줄 수**여야 한다 — 다르면 어느 쪽이 틀렸나부터 의심하게 된다. */
  const tabCount = (pred) => scoped.filter(pred).length;
  const tabs = [
    { id: "all",     label: "전체",       count: tabCount(() => true) },
    { id: "income",  label: "입금",       count: tabCount(t => t.kind === "income") },
    { id: "expense", label: "출금",       count: tabCount(t => t.kind === "expense") },
    /* ⚠ '대체' 탭은 뺐다(2026-09). 두 가지 이유다.
       ① **축이 다르다.** 전체·입금·출금은 돈의 방향인데 대체만 전표 종류였다. 한 줄에
          다른 층위가 섞이면 "대체는 입금도 출금도 아닌 제3의 방향인가"에서 멈춘다.
       ② 운영 전 테넌트에서 대체전표가 **0건**이었다. 늘 빈 탭이 맨 앞줄을 차지했다.
       잃는 것은 없다 — 대체 행은 전체 탭에 그대로 서고, 누르면 openJournal 이 전표를 열고
       거기서 지운다(행 클릭에 붙어 있지 탭에 붙어 있지 않다). 등록은 '거래 등록 › 전표입력'. */
    /* 계약 미연결 — 수주·발주 어디에도 연결 안 된 손익 거래(lib/txnScope isMiscPl). MES 회사는 계약 연결을 안 써서 뺀다 */
    ...(ordersFromMes ? [] : [{ id: "misc", label: "계약 미연결", count: tabCount(t => !t.journal && isMiscPl(t)) }]),
  ];

  /* 이 화면은 **서류 없이 오간 돈의 입구이자 전부를 보는 곳**이다(3단계, 2026-09).
   *
   * 예전엔 조회 전용이었다 — 등록 입구는 수시 입금·출금의 "받은 서류" 선택창 하나였고, 여기에
   * 등록 버튼을 두면 같은 거래를 만드는 입구가 두 벌이 됐기 때문이다.
   * 3단계에서 **메뉴가 그 질문을 대신하게** 됐다: 세금계산서가 있으면 세금계산서, 없으면 여기.
   * 세금계산서 화면은 더 이상 거래 폼을 열지 않으므로 입구는 여전히 하나다.
   *
   * 반복되는 돈은 반복거래에서, 세금계산서가 오간 돈은 세금계산서 화면에서 처리하는 게 낫다 —
   * 거래 폼이 거래처·금액을 보고 그 둘을 알려준다(entry-hints). */
  /* ── 입력수단으로 고른다 ──
   * 첫 물음은 **어떻게 적을까**다(사용자 정의: 입력수단 1 = 전표입력).
   *   1 전표입력     입금전표 / 출금전표 / 대체전표 — 전표 양식 그대로. 입금·출금전표는 반대편(통장)이 고정이다
   *   2 간편 입력    거래처·비목·금액 — 계정과목을 안 외워도 되는 길(청구서 연결도 여기서)
   *   3~5 가져오기   세금계산서 · 지급결의서 · 반복거래 — 이미 장부에 있는 것에서 끌어온다
   * 일반 입력만 여기서 방향(출금·입금)을 고른다 — 전표입력은 전표 종류가 곧 방향이고,
   * 가져오기는 서류가 방향을 이미 안다. 두 번 묻지 않기 위해서다. */
  /* ⚠ **일반 입력이 맨 위, 방향을 여기서 고른다**(2026-09-30 사용자 실사용 관찰).
     예전엔 맨 위가 '전표입력'(계정과목으로 적는 전문가용)이고 일반 입력은 '폼 입력'이라는 모호한 이름으로
     두 번째에 있었다. 게다가 폼 입력은 방향을 안 묻고 **무조건 입금**으로 열려, 법인카드 밥값을 적으려던
     사람이 입금 폼에 거래처를 추가했다(→ 매출처로 등록됐다). 가장 흔한 일(돈이 나감)을 맨 위에 둔다 */
  const entryOptions = [
    openExpense && { id: 'simple-out', icon: Icon.Out, label: '일반 입력 · 출금',
      desc: '돈이 나감 — 카드 결제·계좌 이체·현금 지출',
      effect: '거래처·비목·금액만 적으면 됩니다. 계정과목을 몰라도 돼요.' },
    openIncome && { id: 'simple-in', icon: Icon.In, label: '일반 입력 · 입금',
      desc: '돈이 들어옴 — 매출 입금·환급·이자',
      effect: '거래처를 고르면 그 거래처의 남은 청구서도 보여줘요.' },
    canJournal && { id: 'voucher', icon: Icon.Book, label: '전표입력',
      desc: '입금전표 · 출금전표 · 대체전표 (계정과목으로 적기)',
      effect: '계정과목으로 적어요. 입금·출금전표는 반대편이 통장으로 고정됩니다.' },
    { id: 'invoice', icon: Icon.Receipt, label: '세금계산서에서',
      desc: '발행·수취한 청구서를 골라 입금·지급 처리',
      effect: '미수금·미지급금이 함께 정리돼요.' },
    { id: 'doc', icon: Icon.Sign, label: '지급결의서에서',
      desc: '승인된 결의서를 골라 지급 처리',
      effect: '결의서가 완료로 바뀌고 거래가 만들어져요.' },
    { id: 'repeat', icon: Icon.Clock, label: '반복거래에서',
      desc: '매달 같은 돈은 여기서 가져와요',
      effect: '그 달이 ‘만듦’으로 남아 다음에 또 적지 않아요.' },
  ].filter(Boolean);

  /* 세금계산서만 어느 쪽인지 한 번 더 묻는다 —
     전표입력은 전표 종류가 곧 방향이고, 일반 입력은 입구에서 출금·입금을 고른다. */
  const sourceOptions = () => [
    { id: 'income', icon: Icon.In, label: '발행 (매출)', desc: '못 받은 청구서를 골라 입금 처리' },
    { id: 'expense', icon: Icon.Out, label: '수취 (매입)', desc: '안 낸 청구서를 골라 지급 처리' },
  ];

  const pickEntry = (id) => {
    setEntryPick(false);
    if (id === 'voucher') { setJOpen(true); return; }
    if (id === 'simple-out') { openExpense?.(); return; }
    if (id === 'simple-in') { openIncome?.(); return; }
    if (id === 'doc') { goRoute?.('payment_run'); return; }
    if (id === 'repeat') { goRoute?.('recurring_invoice'); return; }
    setSrcPick(id);   // 'invoice' — 어느 쪽 세금계산서인지만
  };

  const pickSource = (kind) => {
    setSrcPick(null);
    goRoute?.(kind === 'income' ? 'billing_issued' : 'billing_received');
  };

  const titleMap = { all: "거래내역", income: "거래내역 · 입금", expense: "거래내역 · 출금", misc: "거래내역 · 계약 미연결" };
  const subMap = {
    all:     "통장에서 오간 돈과 대체전표를 봅니다. 세금계산서가 있는 건은 세금계산서에서 적어요.",
    income:  "들어온 돈을 모아 봅니다.",
    expense: "나간 돈을 모아 봅니다.",
    misc:    "수주·발주에 연결되지 않은 운영비·잡수익 (급여·세금계산서 정산 제외)",
  };

  return (
    <>
      <div className="fade-up">
        <PageHeader
          title={titleMap[filter]}
          sub={subMap[filter]}
          /* 등록 셋은 **손에 든 것**으로 고른다 — 들어온 돈 / 나간 돈 / 돈이 안 움직인 분개.
             엑셀 둘은 조회의 연장이라 primary 가 아니다. */
          actions={<>
            <button className="btn excel" onClick={openExcel}><Icon.Excel/> <span className="btn-label-hide">엑셀 업로드</span></button>
            <button className="btn" onClick={exportXlsx}><Icon.Excel/> <span className="btn-label-hide">엑셀 내보내기</span></button>
            {/* 같은 돈을 **차변·대변으로** 보고 싶을 때. 전표 렌더러를 여기 또 만들지 않는다 —
                복합 거래(txn_splits)를 펼치는 곳이 둘이 되면 곧 두 모양으로 갈린다.
                보고 있던 기간을 들고 간다(비목·검색은 안 들고 간다 — 전표 목록의 축이 아니다). */}
            {canVoucherBook && (
              <button className="btn" onClick={() => goRoute?.('voucher_book', { range })}>
                <Icon.Doc size={14}/> <span className="btn-label-hide">전표로 보기</span>
              </button>
            )}
            {/* 입구는 **하나**다 — 누르면 어떻게 적을지 묻는다(일반 입력·전표입력·세금계산서에서…).
                ⚠ 버튼 이름은 '전표'가 아니다 — 전표입력은 그 안의 **한 가지**일 뿐이라,
                버튼에 그 이름을 달면 나머지 넷이 없는 것처럼 보인다.
                홈의 [거래 등록]과 같은 말을 쓴다 — 같은 일에 두 이름을 두지 않는다. */}
            {entryOptions.length > 0 && (
              <button className="btn primary" onClick={() => setEntryPick(true)}>
                <Icon.Plus size={14}/> 거래 등록
              </button>
            )}
          </>}
        />

        {/* 세금계산서 화면과 **같은 틀**(2026-09-30 사용자: "업무는 달라도 헤더·필터는 비슷해야"):
              요약 카드(SummaryCard) → 필터 줄(바탕 위) → 보기 탭(이어 붙은 탭) → 표만 카드.
            필터가 탭보다 위인 이유는 세금계산서 쪽 주석과 같다 — 기간은 어느 탭에나 걸린다.
            카드는 **필터**다(누르면 그 종류만 남는다) — active 가 고른 상태를 낸다 */}
        <SummaryRow cols={2}>
          <SummaryCard label="입금 합계" amount={inSum} count={inCount} accent="pos"
            active={filter === "income"} onClick={() => setFilter("income")} hint="입금만 보기"/>
          <SummaryCard label="출금 합계" amount={outSum} count={outCount} accent="neg"
            active={filter === "expense"} onClick={() => setFilter("expense")} hint="출금만 보기"/>
        </SummaryRow>

        <TableToolbar {...tf.toolbarProps}/>

        <div className="row gap-8" style={{ marginTop: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <div className="seg" role="tablist" aria-label="보기">
            {tabs.map(t => (
              <button key={t.id} role="tab" aria-selected={filter === t.id}
                className={`seg-btn ${filter === t.id ? "active" : ""}`} onClick={() => setFilter(t.id)}>
                {t.label}<span className="seg-count">{t.count}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          {/* 선택 바 — 엑셀로 올린 거래를 주문에 한꺼번에 붙이는 자리.
              한 건씩 열어 고르던 것이 "굉장히 번거롭다"는 지적에서 나왔다. */}
          {checkedIds.length > 0 && (
            <div className="card card-pad" style={{ margin: '12px 16px', position: 'sticky', top: 0, zIndex: 3 }}>
              <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="fw-700 text-sm">{checkedIds.length}건 선택</span>
                <button className="btn ghost sm" onClick={() => setCheckedIds([])}>선택 해제</button>
                {/* 삭제는 눈에 덜 띄게(ghost·경고색) — 조회하다 잘못 누르지 않게. 확인 한 번 받는다. */}
                <button className="btn ghost sm" style={{ color: 'var(--neg-ink)' }} onClick={doBulkDelete}>
                  <Icon.Trash size={13}/> 삭제
                </button>
                {!ordersFromMes && (
                <div className="row gap-6 ml-auto" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="text-xs text-muted2">계약</span>
                  <FilterSelect value={bulkContract} onChange={setBulkContract}
                    /* 이름이 겹치는 주문은 거래처를 붙여 갈리게 한다(값은 id). */
                    options={allContracts.map(c => ({
                      value: c.id,
                      label: c.vendor_name ? `${c.vendor_name} · ${c.name}` : c.name,
                    }))} placeholder="계약 선택"/>
                  <button className="btn primary" onClick={() => doBulkLink(false)} disabled={!bulkContract}>
                    <Icon.Link size={14}/> 연결
                  </button>
                  <button className="btn" onClick={() => doBulkLink(true)}>연결 떼기</button>
                </div>
                )}
              </div>
              {/* 지출을 매출 주문에 붙이는 건 '원가 귀속'이다 — 근거 주문과 다른 축이라
                  무엇으로 붙는지 미리 말해줘야 한다. 조용히 틀리면 원가율만 이상해진다. */}
              {!ordersFromMes && (
                <div className="text-xs text-muted2" style={{ marginTop: 8 }}>
                  금액은 바뀌지 않습니다. 지출을 <b>수주</b>에 연결하면 그 수주의 <b>원가</b>로,
                  <b>발주</b>에 연결하면 <b>지급 근거</b>로 잡힙니다.
                </div>
              )}
            </div>
          )}

          <DataTable
            rows={filtered}
            loading={loading}
            onRowClick={t => (t.journal ? openJournal(t) : setSel(t))}
            select={{
              ids: checkedIds, onChange: setCheckedIds,
              isSelectable: t => !t.journal,
              disabledHint: () => '대체전표는 계약에 연결하지 않아요',
            }}
            rowKey={t => t.id}
            /* 열을 고를 수 있다 — 이 표는 하루에도 여러 번 보는 자리라 사람마다 보는 열이 다르다
               ('열' 버튼에서 접기·순서·너비, 이 브라우저에만 기억) */
            tableKey="ledger"
            empty="조건에 맞는 거래내역이 없어요."
            columns={[
              { key: 'date', header: '날짜', width: 110, sortable: true,
                render: t => <span className="num-cell text-muted text-sm">{fmtDateShort(t.date)}</span> },
              { key: 'vendor', header: '거래처', sortable: true,
                render: t => (
                  <span className="fw-700">{t.vendor}</span>
                ) },
              /* 주문 — 적요와 **한 칸에 뭉치지 않는다.**
                 예전엔 `주문명 || 적요 || 전표번호` 를 '내용' 한 칸에 넣어서,
                 주문에 붙은 거래인지 아닌지를 화면에서 알 수 없었다.
                 원가 귀속(cost_contract_name)은 근거 주문과 다른 축이라 표식을 달아 가른다. */
              ...(ordersFromMes ? [] : [{ key: 'contract', header: '계약', sortable: true,
                render: t => {
                  if (t.contract) return <span className="badge outline text-sm">{t.contract}</span>
                  if (t.cost_contract_name) return (
                    <span className="badge outline text-sm" title="이 지출이 원가로 귀속된 수주">
                      {t.cost_contract_name} <span className="text-muted2" style={{ fontSize: 10 }}>원가</span>
                    </span>
                  )
                  return <span className="text-muted2 text-sm">—</span>
                } }]),
              { key: 'scope', header: '적요',
                render: t => <span className="text-muted text-sm">{t.scope}</span> },
              { key: 'category', header: '비목',
                /* 복합 전표는 비목이 여럿인데 이 칸에 서는 것은 **첫 항목 하나**다.
                   표시가 없으면 나머지가 없는 것처럼 보인다 — 눌러서 항목을 펼칠 수 있다는 것도
                   알 길이 없었다. 조용히 '복합'만 덧붙인다(정상에 경고를 달지 않는다). */
                render: t => (
                  <>
                    <span className="badge outline">{t.category}</span>
                    {t.hasSplits && (
                      <span className="badge outline text-muted2" style={{ marginLeft: 4, fontSize: 10 }}
                            title="비목이 여럿인 전표예요 — 열면 항목이 펼쳐집니다">복합</span>
                    )}
                  </>
                ) },
              { key: 'amount', header: '금액', align: 'right', sortable: true,
                sortValue: t => t.sign * t.amount,
                render: t => t.journal
                  ? <span className="num-cell text-muted">{fmtNum(t.amount)}</span>
                  : <span className="num-cell fw-700" style={{ color: t.sign > 0 ? "var(--pos)" : "var(--ink)" }}>
                      {t.sign > 0 ? "+" : "−"}{fmtNum(t.amount)}
                    </span> },
              /* 공급가액·부가세 — 금액(합계)만으로는 신고 자료를 못 맞춘다. 접어 두고 필요할 때 편다.
                 값이 없는 거래(이체·급여 등)는 빈 칸이다 — 0 으로 적으면 '면세'로 읽힌다. */
              { key: 'supplyAmount', header: '공급가액', align: 'right', sortable: true, defaultHidden: true,
                render: t => <span className="num-cell text-muted">{t.supplyAmount != null ? fmtNum(t.supplyAmount) : '—'}</span> },
              { key: 'vatAmount', header: '부가세', align: 'right', sortable: true, defaultHidden: true,
                render: t => <span className="num-cell text-muted">{t.vatAmount != null ? fmtNum(t.vatAmount) : '—'}</span> },
              { key: 'status', header: '상태', width: 110,
                render: t => <StatusBadge status={t.status}/> },
              /* 예정 행에는 증빙·처리 버튼이 없다. 아직 일어나지 않은 일이라
                 증빙이 '없음(경고)'으로 뜨면 거짓 경고가 되고, 처리 버튼은 대상이 없다. */
              { key: 'evid', header: '증빙', width: 70,
                /* ⚠ 증빙이 **없는 것이 보통이다**(카드전표·영수증을 건건이 붙이는 회사는 드물다).
                   없음을 빨간 경고로 칠했더니 목록 전체가 빨강이 됐다 — 그건 경고가 아니라 벽지다.
                   정상에는 표식을 달지 않는다(디자인 규약). 붙은 것만 조용히 표시하고,
                   없는 것은 비워 둔다. '증빙 없는 지출'을 찾는 일은 세무 보고서가 맡는다. */
                render: t => t.journal ? <span className="text-muted2">—</span>
                  : t.evid
                  ? <span className="badge pos" style={{ padding: "2px 8px" }}><Icon.Check size={11}/></span>
                  : <span className="text-muted2" title="증빙이 아직 안 붙었어요">—</span> },
              // label — 머리글이 비어 있어 '열 설정' 목록에 영문 키(actions)가 그대로 나왔다
              { key: 'actions', header: '', label: '처리 버튼', width: 130,
                render: t => t.journal
                  ? <span className="text-xs text-muted2">{t.docNo}</span>
                  : <TxnActions txn={t} toast={toast} confirm={confirm} onAction={reload}/> },
            ]}
          />

          <div className="row" style={{ padding: "14px 18px", borderTop: "1px solid var(--line)", color: "var(--muted)", fontSize: 12.5 }}>
            전체 {filtered.length}건
          </div>
        </div>
      </div>

      <TransactionDetailDrawer txn={sel} onClose={() => setSel(null)} toast={toast} confirm={confirm} openEdit={openEdit} onAction={reload}/>
      {/* 1단계 — 돈이 어느 쪽으로 움직였나 */}
      <SourceChooser
        open={entryPick} onClose={() => setEntryPick(false)}
        title="어떻게 적을까요?" sub="손에 든 것으로 고르세요"
        label="입력 방법" options={entryOptions} onPick={pickEntry}/>

      {/* 2단계 — 손에 든 것 */}
      <SourceChooser
        open={!!srcPick} onClose={() => setSrcPick(null)}
        title="어느 쪽 세금계산서인가요?" sub="고르면 그 목록으로 갑니다"
        label="방향" options={srcPick ? sourceOptions() : []} onPick={pickSource}/>

      {/* 옛 '전표 입력' 주소로 들어오면 목록이 '대체'로 걸려 있다 — 서랍도 대체전표로 연다(둘이 어긋나면 헷갈린다) */}
      <JournalEntryDrawer goRoute={goRoute} initialType={openJournalOnMount ? 'tr' : 'in'} open={jOpen} onClose={() => setJOpen(false)}
        onSaved={({ source, id }) => {
          setJOpen(false); reload();
          if (source === 'journal') openJournal({ jvId: id });
          else setFilter('all');
        }}/>
      <VoucherView open={!!jView} voucher={jView?.voucher} onClose={() => setJView(null)}
        extra={jView && canJournal && (
          <button className="btn" style={{ color: 'var(--neg-ink)' }} onClick={removeJournal}>삭제</button>
        )}/>
    </>
  );
};

const TxnActions = ({ txn, toast, confirm, onAction }) => {
  const doIncome = async (e) => {
    e.stopPropagation();
    const ok = await confirm({ tone: "brand", icon: <Icon.In size={22}/>, title: `${txn.vendor} 입금 처리`, body: `${fmtNum(txn.amount)}원을 입금 완료로 처리합니다.`, confirmLabel: "입금 처리" });
    if (ok) {
      const res = await api.updateTransactionStatus(txn.id, "입금완료");
      if (res.ok) { toast.push("입금이 처리됐어요"); onAction?.(); }
      else toast.push(res.error || "처리에 실패했어요", { tone: "warn" });
    }
  };
  const doExpense = async (e) => {
    e.stopPropagation();
    const ok = await confirm({ tone: "neg", icon: <Icon.Bank size={22}/>, title: `${txn.vendor} 이체 실행`, body: `${txn.category} ${fmtNum(txn.amount)}원을 지급완료로 처리합니다.`, confirmLabel: "이체 실행" });
    if (ok) {
      const res = await api.updateTransactionStatus(txn.id, "지급완료");
      if (res.ok) { toast.push("이체가 완료됐어요"); onAction?.(); }
      else toast.push(res.error || "처리에 실패했어요", { tone: "warn" });
    }
  };

  /* ⚠ 이 버튼들은 **primary 가 아니다.**
     조회하러 온 화면에서 도래한 줄마다 채운 버튼이 서 있으면 "여기서 처리하는 게 보통"으로
     읽힌다. 입금·지급 처리는 자기 화면(수시입금·수시지급)이 따로 있고, 거기에는 정산 계좌·
     날짜를 받는 절차가 붙어 있다. 여기서는 보다가 눈에 띈 것을 **할 수 있게만** 둔다.
     capability 는 그대로, 권유만 뺀다. */
  if (txn.kind === "income" && ["입금 예정", "일부 입금"].includes(txn.status))
    return <button className="btn sm" onClick={doIncome}>입금 처리</button>;

  /* 장기 미수도 할 수 있는 건 '입금 처리'뿐이다.
     (제거) '독촉' 버튼 — 눌러도 "준비 중이에요" 토스트만 떴다. 정직하긴 했지만 누를 수 있는
     버튼이 있으면 기대가 생기고, 장기 미수 행마다 매번 그 실망을 반복하게 된다.
     메일 발송을 실제로 붙일 때 청구서 상세의 독촉과 함께 되살린다. */
  if (txn.kind === "income" && txn.status === "장기 미수")
    return <button className="btn sm" onClick={doIncome}>입금 처리</button>;

  if (txn.kind === "expense" && ["지급 예정", "지급 대기", "기한 지남"].includes(txn.status))
    return <button className="btn sm" onClick={doExpense}>이체 실행</button>;

  return <span className="text-xs text-muted2">—</span>;
};

const DetailRow = ({ label, value }) => (
  <div className="row" style={{ padding: "10px 0", borderBottom: "1px solid var(--line)", fontSize: 13.5 }}>
    <span className="text-muted fw-600" style={{ width: 100 }}>{label}</span>
    <span className="fw-600">{value}</span>
  </div>
);

/* 거래 상세 — 큰 팝업, 탭 둘(2026-09-29 사용자).
 *   거래 정보  왼쪽: 흐름(어디서 → 어디로) · 내용 · 청구(세금계산서) · 연결 문서 / 오른쪽: 전표(인쇄 종이 그대로)
 *   증빙       왼쪽: 서류 목록 / 오른쪽: 미리보기(이미지·PDF) — 팝업 높이를 다 쓴다
 * 한 장에 전부 펼쳤더니 "너무 난잡하다" — 보는 목적이 다른 둘(장부 확인 / 서류 확인)을 가른다.
 *
 * [편집]은 **제자리 수정**이다 — 거래 정보 탭의 왼쪽이 그대로 입력 폼이 된다(다른 창으로 넘어가지 않는다).
 * 폼은 거래 등록 폼(TransactionForm) 그 자체를 끼워 넣는다 — 규칙을 두 벌 만들지 않는다.
 * 데이터는 한 번에 받는다(GET /transactions/:id/overview — 연결 문서·첨부는 보는 사람 권한으로 걸러 온다).
 * 설계: popup-attachments-print §4 */
const TransactionDetailDrawer = ({ txn, onClose, toast, confirm, openEdit, onAction }) => {
  const [ov, setOv] = useState(null);                   // overview 응답
  const [tab, setTab] = useState("info");               // info | docs
  const [editing, setEditing] = useState(false);        // 제자리 수정 중
  const [company, setCompany] = useState(null);
  const [resView, setResView] = useState(null);         // 결의서 열람(문서)
  const load = () => api.getTransactionOverview(txn.id)
    .then(setOv)
    .catch(e => toast.push(e.message || "불러오지 못했어요", { tone: "warn" }));
  useEffect(() => {
    if (!txn) return;
    setOv(null); setResView(null); setTab("info"); setEditing(false);
    load();
    api.getCompany().then(setCompany);
  }, [txn]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!txn) return null;
  const t = ov?.txn || txn;
  const out = t.sign < 0;
  const acct = t.account || "계좌 미지정";
  const party = [t.vendor, [t.counterpartyBank, t.counterpartyAccount].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "상대 미지정";
  const files = ov?.files || [];

  const attach = async (file) => {
    const up = await api.uploadFile(file);
    if (!up?.url) { toast.push(up?.error || "업로드에 실패했어요", { tone: "warn" }); return; }
    const res = await api.addTransactionDoc(t.id, { url: up.url, name: up.originalName || file.name, doc_type: "기타", size: up.size || 0 });
    if (res.ok) { toast.push("증빙이 붙었어요"); load(); onAction?.(); }
    else toast.push(res.error || "첨부에 실패했어요", { tone: "warn" });
  };
  const remove = async (f) => {
    const ok = await confirm({ tone: "neg", icon: <Icon.Trash size={22}/>, title: "증빙 지우기", body: `${f.name} 을(를) 지울까요?`, confirmLabel: "지우기" });
    if (!ok) return;
    const res = f.id ? await api.deleteTransactionDoc(f.id) : await api.updateTransactionEvidence(t.id, { evid_url: "", evid_type: "" });
    if (res.ok) { toast.push("지웠어요"); load(); onAction?.(); }
    else toast.push(res.error || "삭제에 실패했어요", { tone: "warn" });
  };

  /* 보는 동안은 묻지 않고 닫는다(증빙 올리기는 그 자리에서 저장된다). 고치는 중에만 묻는다 */
  return (
    <Drawer open={true} onClose={onClose} size="xl" height="min(800px, calc(100vh - 48px))" label="거래 상세" confirmClose={editing}>
        <div className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <div className="row gap-8">
              <span className={`badge ${out ? "neg" : "pos"}`}>{out ? "지출" : "입금"}</span>
              <StatusBadge status={t.status}/>
            </div>
            <div className="fw-700" style={{ fontSize: 17, marginTop: 6 }}>{t.vendor}</div>
            <div className="text-xs text-muted">{[t.scope, t.category, t.date].filter(Boolean).join(" · ")}</div>
          </div>
          <div className="ml-auto num fw-700" style={{ fontSize: 26, letterSpacing: "-0.02em", color: out ? "var(--ink)" : "var(--pos)" }}>
            {out ? "−" : "+"}{fmtNum(t.amount)}<span className="text-muted" style={{ fontWeight: 400, fontSize: 15, marginLeft: 3 }}>원</span>
          </div>
          <button className="icon-btn" title="닫기" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        <div className="txo-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "info"} className={`tab ${tab === "info" ? "active" : ""}`} onClick={() => setTab("info")}>거래 정보</button>
          {/* 고치는 중엔 탭을 못 옮긴다 — 옮기면 쓰던 폼이 사라진다 */}
          <button role="tab" aria-selected={tab === "docs"} className={`tab ${tab === "docs" ? "active" : ""}`} disabled={editing}
            title={editing ? "수정을 마치고 볼 수 있어요" : undefined} onClick={() => setTab("docs")}>
            증빙{files.length > 0 && <span className="num txo-count">{files.length}</span>}
          </button>
        </div>

        {/* 증빙 탭은 고정된 창 높이를 목록·미리보기가 꽉 채운다(txo-body-fill) */}
        <div className={`drawer-body${tab === "docs" ? " txo-body-fill" : ""}`}>
          {tab === "info" && (
          /* 편집 중엔 폼이 한 칸을 다 쓴다 — 옆의 전표는 저장 전 옛 값이라 볼 이유가 없었다
             (저장하면 다시 계산된다). 세금계산서 편집과 같은 모양(2026-10-01 사용자) */
          editing ? (
            <TransactionForm embedded open editTxn={t} kind={t.kind}
              onClose={() => setEditing(false)}
              onSave={() => { load(); onAction?.(); }}/>
          ) : (
          <div className="txo-grid">
            {(
            <div className="col gap-20" style={{ minWidth: 0 }}>
              {/* 자금 흐름 — 지출은 우리 계좌 → 상대, 입금은 상대 → 우리 계좌 */}
              <section>
                <div className="txo-label">자금 흐름</div>
                <div className="txo-flow">
                  <div className="txo-node"><div className="text-xs text-muted2">{out ? "출금" : "보낸 곳"}</div><div className="fw-600">{out ? acct : party}</div></div>
                  <Icon.Right size={18}/>
                  <div className="txo-node"><div className="text-xs text-muted2">{out ? "받는 곳" : "입금"}</div><div className="fw-600">{out ? party : acct}</div></div>
                </div>
              </section>

              <section>
                <div className="txo-label">내용</div>
                <DetailRow label="거래일" value={t.date}/>
                <DetailRow label="내용" value={t.scope}/>
                {/* 복합 거래는 비목 칸에 **첫 항목 하나**만 담긴다 — 그대로 두면 나머지가 없는 것처럼 읽힌다.
                    항목별 금액은 오른쪽 전표 줄이 이미 보여 준다 */}
                <DetailRow label="비목" value={t.hasSplits
                  ? <span>{t.category} 외 <span className="badge outline" style={{ marginLeft: 4 }}>여러 비목 · 전표 참고</span></span>
                  : t.category}/>
                {t.method && <DetailRow label="결제수단" value={t.method}/>}
                {t.contract && <DetailRow label="계약" value={t.contract}/>}
                {t.cost_contract_name && <DetailRow label="원가 귀속" value={t.cost_contract_name}/>}
              </section>

              <section>
                <div className="txo-label">청구</div>
                {!ov ? <div className="text-sm text-muted">불러오는 중…</div>
                  : ov.invoices.length === 0 ? <div className="text-sm text-muted">연결된 세금계산서가 없어요</div>
                  : ov.invoices.map(i => (
                    <div key={i.id} className="txo-row">
                      <div style={{ minWidth: 0 }}>
                        <div className="fw-600">{i.kind === "issued" ? "매출" : "매입"} 세금계산서 {i.invoice_no || ""}</div>
                        <div className="text-xs text-muted2">{i.vendor_name} · 발행 {i.issued_at}{i.due_at ? ` · 기한 ${i.due_at}` : ""}</div>
                      </div>
                      <div className="ml-auto" style={{ textAlign: "right" }}>
                        <div className="num fw-700">{fmtNum(i.total_amount)}</div>
                        <div className="text-xs text-muted2">
                          {i.this_amount != null && i.this_amount !== i.total_amount ? `이 거래 ${fmtNum(i.this_amount)} · ` : ""}
                          남음 {fmtNum(Math.max(0, i.total_amount - i.paid_amount))}
                        </div>
                      </div>
                      <StatusBadge status={i.status}/>
                    </div>
                  ))}
              </section>

              {ov && (ov.resolutions.length + ov.purchaseReqs.length + ov.settlements.length) > 0 && (
                <section>
                  <div className="txo-label">문서</div>
                  {ov.resolutions.map(r => (
                    <div key={r.id} className="txo-row">
                      <div style={{ minWidth: 0 }}>
                        <div className="fw-600">지급결의서 {r.doc_no}</div>
                        <div className="text-xs text-muted2">{r.title} · {fmtNum(r.amount)}원</div>
                      </div>
                      <span className="ml-auto"><StatusBadge status={r.status || "작성"}/></span>
                      <button className="btn sm" onClick={async () => {
                        const full = await api.getResolutionByTxn(t.id);
                        if (full) setResView(full); else toast.push("결의서를 열지 못했어요", { tone: "warn" });
                      }}><Icon.Eye size={13}/> 보기</button>
                    </div>
                  ))}
                  {ov.purchaseReqs.map(r => (
                    <div key={r.id} className="txo-row">
                      <div style={{ minWidth: 0 }}>
                        <div className="fw-600">구매품의서 {r.doc_no}</div>
                        <div className="text-xs text-muted2">{r.summary || "—"} · {r.req_date}</div>
                      </div>
                      <span className="ml-auto"><StatusBadge status={r.status || "작성"}/></span>
                    </div>
                  ))}
                  {ov.settlements.map(r => (
                    <div key={r.id} className="txo-row">
                      <div className="fw-600">정산내역서 {r.doc_no}</div>
                      <span className="ml-auto"><StatusBadge status={r.status || "작성"}/></span>
                    </div>
                  ))}
                </section>
              )}
            </div>
            )}

            {/* 전표 — 인쇄되는 종이 그대로. 인쇄는 이 종이만(.voucher-print 화이트리스트) */}
            <section style={{ minWidth: 0 }}>
              <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
                <div className="txo-label" style={{ margin: 0 }}>전표</div>
                {ov?.voucher && <button className="btn sm ml-auto" onClick={() => window.print()}><Icon.Print size={13}/> 전표 인쇄</button>}
              </div>
              <div className="doc-paper txo-paper voucher-print">
                {!ov ? <div className="text-sm text-muted" style={{ padding: 30, textAlign: "center" }}>불러오는 중…</div>
                  : ov.voucher ? <VoucherSlip v={ov.voucher}/>
                  : <div className="text-sm text-muted" style={{ padding: 30, textAlign: "center" }}>전표를 세우지 못했어요</div>}
              </div>
            </section>
          </div>
          )
          )}

          {tab === "docs" && (
            <>
              <AttachmentPanel files={files} onUpload={attach} onRemove={remove}
                height="auto"
                canRemove={f => f.source === "txn"}
                empty={ov ? "붙은 서류가 없어요" : "불러오는 중…"}/>
              {files.some(f => f.source !== "txn") && (
                <div className="text-xs text-muted2" style={{ marginTop: 6 }}>세금계산서에 붙은 서류는 세금계산서 화면에서 지워요.</div>
              )}
            </>
          )}
        </div>

        {/* 고치는 중엔 폼이 자기 [취소]·[저장]을 가진다 — 팝업 발은 접는다 */}
        {!editing && (
        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>닫기</button>
          {/* 삭제는 **눈에 덜 띄게** 둔다. 조회하러 온 화면에서 붉게 채운 버튼이 늘 왼쪽에
              서 있으면 "여기서 지우는 게 보통"으로 읽힌다. 지울 수는 있어야 하니 남기되,
              바탕을 빼고 글자만 붉게 둔다. */}
          <button className="btn" style={{ color: "var(--neg-ink)" }} onClick={async () => {
            const ok = await confirm({ tone: "neg", icon: <Icon.Warn size={22}/>, title: "거래 삭제", body: `${t.vendor} · ${fmtNum(t.amount)}원 거래를 삭제합니다. 복구할 수 없어요.`, confirmLabel: "삭제" });
            if (ok) {
              const res = await api.deleteTransaction(t.id);
              if (res.ok) { toast.push("삭제됐어요"); onClose(); onAction?.(); }
              // 세금 납부·결의서·급여에 연결된 거래는 409로 막힌다. 사유를 그대로 보여줘야
              // 사용자가 어디서 취소해야 하는지 알 수 있다.
              else toast.push(res.error || "삭제에 실패했어요", { tone: "warn" });
            }
          }}><Icon.Trash size={14}/> 삭제</button>
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={() => { setTab("info"); setEditing(true); }}><Icon.Pencil size={14}/> 편집</button>
            {t.kind === "income" && ["입금 예정", "일부 입금", "장기 미수"].includes(t.status) && (
              <button className="btn" onClick={async () => {
                const ok = await confirm({ tone: "brand", icon: <Icon.In size={22}/>, title: "입금 처리", body: `${fmtNum(t.amount)}원을 입금 완료로 처리합니다.`, confirmLabel: "입금 처리" });
                if (ok) { const res = await api.updateTransactionStatus(t.id, "입금완료"); if (res.ok) { toast.push("입금이 처리됐어요"); onClose(); onAction?.(); } else toast.push(res.error || "처리에 실패했어요", { tone: "warn" }); }
              }}><Icon.Check size={14}/> 입금 처리</button>
            )}
            {t.kind === "expense" && ["지급 예정", "지급 대기", "기한 지남"].includes(t.status) && (
              <button className="btn" onClick={async () => {
                const ok = await confirm({ tone: "neg", icon: <Icon.Bank size={22}/>, title: "이체 실행", body: `${fmtNum(t.amount)}원을 지급완료로 처리합니다.`, confirmLabel: "이체 실행" });
                if (ok) { const res = await api.updateTransactionStatus(t.id, "지급완료"); if (res.ok) { toast.push("이체가 완료됐어요"); onClose(); onAction?.(); } else toast.push(res.error || "처리에 실패했어요", { tone: "warn" }); }
              }}><Icon.Bank size={14}/> 이체 실행</button>
            )}
          </div>
        </div>
        )}

        {/* 지급결의서 열람·인쇄 — 결의서 종이 그대로 */}
        {resView && (
          <div className="res-viewer-overlay" onClick={() => setResView(null)}>
            <div className="res-viewer" onClick={e => e.stopPropagation()}>
              <div className="row gap-8 no-print" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
                <span className="fw-700">지급결의서 {resView.doc_no}</span>
                <div className="ml-auto row gap-6">
                  <button className="btn" onClick={() => window.print()}><Icon.Print/> 인쇄</button>
                  <button className="icon-btn" title="닫기" onClick={() => setResView(null)}><Icon.Close size={16}/></button>
                </div>
              </div>
              <div style={{ padding: 20, overflow: "auto" }}>
                <ResolutionDocument doc={resView} company={company} printClass="resolution-print"/>
              </div>
            </div>
          </div>
        )}
    </Drawer>
  );
};
