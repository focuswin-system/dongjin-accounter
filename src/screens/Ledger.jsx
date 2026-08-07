import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Popover, PopItem, StatusBadge, periodToRange, FilterSelect, Drawer, localToday } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DataTable } from '../lib/components/DataTable'
import { TableToolbar } from '../lib/components/TableToolbar'
import { api } from '../lib/api'
import { downloadCsv } from '../lib/export'
import { ResolutionDocument } from './Docs'

// CSV 저장은 보고서 내보내기와 같은 것을 쓴다 → lib/export.js

export const LedgerScreen = ({ initialFilter = "all", openIncome, openExpense, openEdit, openExcel, openInvoice, refreshTrigger }) => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [filter, setFilter] = useState(initialFilter);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(null);
  // 날짜 범위는 두 인풋(from~to)이 본체. 기본값 = 이번 달(프리셋 버튼이 값을 바꿔줌).
  const [range, setRange] = useState(() => periodToRange("month"));
  const [filterCat, setFilterCat] = useState(null);
  const [txns, setTxns] = useState([]);
  // 미수금/미지급금은 청구서 기준(회수는 입금·환불/지급·환입 화면에서). 여기선 요약만 청구서 기준으로 표시.
  const [recSummary, setRecSummary] = useState(null);
  const [paySummary, setPaySummary] = useState(null);
  /* '예정 포함' — 고객 요청: "전체 거래내역에서 미납금과 미지급금은 왜 안 보이냐.
     한 번에 나갈 돈·들어올 돈·거래내역을 볼 수 있어야 되는 거 아니냐."
     맞는 요구다. 다만 **같은 합계에 섞으면 안 된다** — 이 화면의 입금·지출 합계는 실제로
     오간 돈이고 계좌 잔액·손익과 맞아야 한다. 아직 안 받은 돈을 더하면 그 달 매출이 부풀고
     잔액이 안 맞는다. 그래서 행은 함께 보여주되 **합계는 실제분만** 세고, 예정은 따로 적는다. */
  const [showPlanned, setShowPlanned] = useState(false);
  const [openInvoices, setOpenInvoices] = useState([]);   // 아직 안 받은/안 낸 청구서

  useEffect(() => { setFilter(initialFilter); }, [initialFilter]);

  const reload = () => {
    api.getTransactions().then(setTxns);
    api.getReceivablesSummary().then(setRecSummary);
    api.getPayablesSummary().then(setPaySummary);
    api.getInvoices().then(list => setOpenInvoices((list || []).filter(inv => Number(inv.remainAmount) > 0)));
  };
  useEffect(() => { reload(); }, []);
  useEffect(() => { if (refreshTrigger > 0) reload(); }, [refreshTrigger]);

  const categories = useMemo(() => [...new Set(txns.map(t => t.category).filter(Boolean))].sort(), [txns]);

  /* 기간·비목·검색까지만 적용한 범위. 입금/지출 탭은 아직 안 나눈다.
     합계 카드와 탭 옆 건수는 이 범위를 쓴다 — 예전엔 둘 다 전체 txns 로 계산해서
     "2026년 7월"로 좁혀놔도 카드에는 **개업 이래 누계**가, 탭에는 전체 건수가 떠 있었다.
     화면의 표와 숫자가 서로 다른 기간을 말하니 그 값을 그대로 보고에 옮기면 틀린다. */
  const scoped = useMemo(() => {
    let rows = txns;
    if (range?.from) rows = rows.filter(t => t.date >= range.from);
    if (range?.to)   rows = rows.filter(t => t.date <= range.to);
    if (filterCat)   rows = rows.filter(t => t.category === filterCat);
    if (q) {
      const lc = q.toLowerCase();
      rows = rows.filter(t => t.vendor.toLowerCase().includes(lc) || t.scope?.toLowerCase().includes(lc) || t.category?.toLowerCase().includes(lc));
    }
    return rows;
  }, [txns, q, range, filterCat]);

  /* 미정산 청구서를 거래 모양으로 바꾼다. 실제 거래와 **같은 필터**를 타야 한다 —
     기간을 좁혀놓고 예정만 전 기간이 뜨면 화면이 두 기간을 동시에 말하게 된다.
     날짜는 지급 기한(없으면 발행일)이다. "언제 들어올·나갈 돈인가"가 이 화면의 축이므로. */
  const plannedRows = useMemo(() => {
    if (!showPlanned) return [];
    let rows = openInvoices.map(inv => ({
      id: `planned-${inv.id}`,
      planned: true,
      invoiceId: inv.id,
      kind: inv.kind === 'issued' ? 'income' : 'expense',
      sign: inv.kind === 'issued' ? +1 : -1,
      date: inv.dueAt || inv.issuedAt,
      vendor: inv.vendor || '(거래처 미지정)',
      scope: inv.contract || inv.memo || inv.invoiceNo,
      category: inv.kind === 'issued' ? '미수금' : '미지급금',
      amount: Number(inv.remainAmount) || 0,
      status: inv.status,
    }));
    if (range?.from) rows = rows.filter(t => t.date >= range.from);
    if (range?.to)   rows = rows.filter(t => t.date <= range.to);
    if (filterCat)   rows = rows.filter(t => t.category === filterCat);
    if (q) {
      const lc = q.toLowerCase();
      rows = rows.filter(t => t.vendor.toLowerCase().includes(lc) || t.scope?.toLowerCase().includes(lc) || t.category?.toLowerCase().includes(lc));
    }
    return rows;
  }, [showPlanned, openInvoices, range, filterCat, q]);

  // 표에 실제로 그려지는 행 = 범위 + 탭 (+ 켰으면 예정분)
  const filtered = useMemo(() => {
    const byTab = (rows) =>
      filter === "income"  ? rows.filter(t => t.kind === "income")
      : filter === "expense" ? rows.filter(t => t.kind === "expense")
      : rows;
    const real = byTab(scoped);
    if (!showPlanned) return real;
    // 날짜 순으로 섞어 놓는다 — 예정만 아래로 몰면 "언제 무엇이" 흐름이 끊긴다
    return [...real, ...byTab(plannedRows)].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }, [scoped, filter, showPlanned, plannedRows]);

  // 예정분 합계는 실제 합계와 **따로** 적는다(섞으면 잔액·손익이 틀어진다)
  const plannedIn  = plannedRows.filter(t => t.kind === 'income').reduce((a, t) => a + t.amount, 0);
  const plannedOut = plannedRows.filter(t => t.kind === 'expense').reduce((a, t) => a + t.amount, 0);

  /* 내보내기는 화면에 보이는 그대로 담는다. 다만 '예정'은 실제 입출금과 반드시 갈라져야 한다 —
     한 열로 구분해 두지 않으면 받은 파일에서 합계를 내는 순간 통장과 안 맞는다. */
  const exportCsv = () => {
    if (filtered.length === 0) return toast.push("내보낼 거래가 없어요");
    downloadCsv(`거래내역_${localToday()}.csv`,
      ["날짜", "실제/예정", "구분", "거래처", "내용", "비목", "금액", "상태"],
      filtered.map(t => [t.date, t.planned ? "예정" : "실제", t.kind === "income" ? "입금" : "지출",
        t.vendor, t.scope, t.category, t.sign * t.amount, t.status]));
  };

  const inSum  = scoped.filter(t => t.kind === "income"  && t.status === "입금완료").reduce((a, t) => a + t.amount, 0);
  const outSum = scoped.filter(t => t.kind === "expense" && t.status === "지급완료").reduce((a, t) => a + t.amount, 0);

  /* 탭 숫자는 **그 탭을 눌렀을 때 표에 뜨는 줄 수**여야 한다.
     '예정 포함'을 켜 놓고 탭이 15인데 표가 18줄이면, 어느 쪽이 틀렸나부터 의심하게 된다. */
  const tabCount = (pred) => scoped.filter(pred).length + (showPlanned ? plannedRows.filter(pred).length : 0);
  const tabs = [
    { id: "all",     label: "전체 거래",  count: tabCount(() => true) },
    { id: "income",  label: "입금",       count: tabCount(t => t.kind === "income") },
    { id: "expense", label: "지출",       count: tabCount(t => t.kind === "expense") },
  ];

  const titleMap = { all: "거래내역", income: "거래내역 · 입금", expense: "거래내역 · 지출" };
  const subMap = {
    all:     "실제로 오간 모든 입금·지출 기록이에요. 미수금·미지급금은 판매·매출의 '미수금', 매입의 '미지급금'에서 관리해요.",
    income:  "발주처에서 들어온 돈을 등록하고 처리하세요.",
    expense: "외주가공·자재·운영비를 등록하고 결의·이체로 처리하세요.",
  };

  return (
    <>
      <div className="fade-up">
        <PageHeader
          title={titleMap[filter]}
          actions={<>
            <button className="btn excel" onClick={openExcel}><Icon.Excel/> <span className="btn-label-hide">엑셀 업로드</span></button>
            <button className="btn" onClick={exportCsv}><Icon.Download/> <span className="btn-label-hide">내보내기</span></button>
            <Popover align="right" width={220}
              trigger={<button className="btn primary"><Icon.Plus/> {filter === "ar" ? "입금·환불" : filter === "ap" ? "지급·환입" : "거래 등록"} <Icon.Down size={12} style={{ marginLeft: 2 }}/></button>}>
              <div style={{ padding: 6 }}>
                <PopItem icon={<Icon.In size={16}/>}  label="입금 등록" onClick={openIncome}/>
                <PopItem icon={<Icon.Out size={16}/>} label="지출 등록" onClick={openExpense}/>
              </div>
            </Popover>
          </>}
        />

        {/* 미수금/미지급금은 청구서 기준(요약만 표시). 카드 클릭 시 회수 화면으로 이동. */}
        <div className="grid grid-4-to-2" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
          <LedgerCard label="입금 합계"  amount={inSum}  tone="pos"   active={filter === "income"} onClick={() => setFilter("income")}/>
          <LedgerCard label="지출 합계"  amount={outSum} tone="neg"   active={filter === "expense"} onClick={() => setFilter("expense")}/>
          <LedgerCard label="미수금"        amount={recSummary?.total ?? 0}  tone="brand" note="미수금 화면으로" onClick={() => { window.location.hash = "ar"; }}/>
          <LedgerCard label="미지급금"      amount={paySummary?.total ?? 0}  tone="warn"  note="미지급금 화면으로" onClick={() => { window.location.hash = "ap"; }}/>
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          {/* 탭(전체 거래/입금/지출) — 상단 KPI 카드 클릭과 연동. 툴바와 별개로 유지. */}
          <div className="row gap-6" style={{ padding: 12, borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
            {tabs.map(t => (
              <button key={t.id} className={`chip ${filter === t.id ? "active" : ""}`} onClick={() => setFilter(t.id)}>
                {t.label} <span style={{ marginLeft: 4, opacity: 0.7 }}>{t.count}</span>
              </button>
            ))}
          </div>

          <TableToolbar
            date={{ from: range?.from || "", to: range?.to || "", onChange: setRange }}
            search={{ value: q, onChange: setQ, placeholder: "거래처·계약·비목 검색" }}
            filters={[{ label: "비목", node: <FilterSelect value={filterCat} onChange={setFilterCat} options={categories} placeholder="전체"/> }]}
            hasActiveFilter={!!filterCat}
            onReset={() => setFilterCat(null)}
            right={
              /* 아직 안 오간 돈을 이 표에 함께 띄운다. 켜져 있다는 걸 숫자로도 말해준다 —
                 "왜 합계랑 표가 안 맞지"가 생기지 않도록. */
              <label className="row gap-6 text-sm" style={{ cursor: 'pointer', alignItems: 'center' }}
                title="미수금·미지급금을 함께 봅니다. 합계에는 더해지지 않아요.">
                <input type="checkbox" checked={showPlanned} onChange={e => setShowPlanned(e.target.checked)}/>
                예정 포함
                {showPlanned && (
                  <span className="text-xs text-muted2">
                    (들어올 {fmtNum(plannedIn)} · 나갈 {fmtNum(plannedOut)})
                  </span>
                )}
              </label>
            }
          />

          {showPlanned && (
            <div className="text-xs text-muted2" style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)' }}>
              점선 행은 <b>아직 오가지 않은 돈</b>(미수금·미지급금)이에요. 위 <b>입금·지출 합계에는 들어가지 않습니다</b> —
              그 합계는 실제로 통장을 오간 금액이라 계좌 잔액과 맞아야 하거든요. 행을 누르면 해당 청구서로 갑니다.
            </div>
          )}

          <DataTable
            rows={filtered}
            /* 예정 행은 거래가 아니라 청구서다 — 거래 상세를 열면 없는 거래를 보여주게 된다.
               그 청구서 화면으로 보낸다(미수금=#ar / 미지급금=#ap, 해당 건이 열린 채로). */
            onRowClick={t => {
              if (!t.planned) return setSel(t)
              openInvoice?.(t.kind, t.invoiceId)
            }}
            rowKey={t => t.id}
            rowClass={t => t.planned ? 'row-planned' : ''}
            empty="조건에 맞는 거래내역이 없어요."
            columns={[
              { key: 'date', header: '날짜', width: 110, sortable: true,
                render: t => <span className="num-cell text-muted text-sm">{t.date}</span> },
              { key: 'vendor', header: '거래처', sortable: true,
                render: t => (
                  <span className="fw-700">
                    {t.vendor}
                    {/* 실제로 오간 돈과 섞여 보이면 안 된다 — 행마다 '예정'이라고 적는다 */}
                    {t.planned && <span className="badge outline" style={{ marginLeft: 6, fontSize: 10 }}>예정</span>}
                  </span>
                ) },
              // 계약이 있으면 계약명, 없으면 적요(api.js scope) — 두 가지가 섞이므로 '내용'
              { key: 'scope', header: '내용',
                render: t => <span className="text-muted text-sm">{t.scope}</span> },
              { key: 'category', header: '비목',
                render: t => <span className="badge outline">{t.category}</span> },
              { key: 'amount', header: '금액', align: 'right', sortable: true,
                sortValue: t => t.sign * t.amount,
                render: t => <span className="num-cell fw-700" style={{ color: t.sign > 0 ? "var(--pos)" : "var(--ink)" }}>
                  {t.sign > 0 ? "+" : "−"}{fmtNum(t.amount)}
                </span> },
              { key: 'status', header: '상태', width: 110,
                render: t => <StatusBadge status={t.status}/> },
              /* 예정 행에는 증빙·처리 버튼이 없다. 아직 일어나지 않은 일이라
                 증빙이 '없음(경고)'으로 뜨면 거짓 경고가 되고, 처리 버튼은 대상이 없다. */
              { key: 'evid', header: '증빙', width: 70,
                render: t => t.planned ? <span className="text-muted2">—</span>
                  : t.evid
                  ? <span className="badge pos" style={{ padding: "2px 8px" }}><Icon.Check size={11}/></span>
                  : <span className="badge neg" style={{ padding: "2px 8px" }}><Icon.Warn size={11}/></span> },
              { key: 'actions', header: '', width: 130,
                render: t => t.planned
                  ? <span className="text-xs text-muted2">청구서에서 처리</span>
                  : <TxnActions txn={t} toast={toast} confirm={confirm} onAction={reload}/> },
            ]}
          />

          <div className="row" style={{ padding: "14px 18px", borderTop: "1px solid var(--line)", color: "var(--muted)", fontSize: 12.5 }}>
            전체 {filtered.length}건
          </div>
        </div>
      </div>

      <TransactionDetailDrawer txn={sel} onClose={() => setSel(null)} toast={toast} confirm={confirm} openEdit={openEdit} onAction={reload}/>
    </>
  );
};

const LedgerCard = ({ label, amount, tone, active, onClick, note }) => {
  const bg = active
    ? (tone === "pos" ? "#E8F5EE" : tone === "neg" ? "#FBE9E9" : tone === "brand" ? "#E7EFFB" : "#FBEFD9")
    : "#fff";
  const border = active
    ? (tone === "pos" ? "var(--pos)" : tone === "neg" ? "var(--neg)" : tone === "brand" ? "var(--brand)" : "var(--warn)")
    : "var(--line)";
  return (
    <button onClick={onClick} className="card"
      style={{ padding: "16px 18px", border: `1px solid ${border}`, background: bg, textAlign: "left", cursor: "pointer", fontFamily: "inherit", transition: "background .12s, border-color .12s" }}>
      <div className="row gap-8" style={{ marginBottom: 6 }}>
        <span className="text-sm text-muted fw-600" style={{ whiteSpace: "nowrap" }}>{label}</span>
        {note && <span className={`badge ${tone}`} style={{ marginLeft: "auto" }}>{note}</span>}
      </div>
      <div className="num fw-700" style={{ fontSize: 22, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>
        {fmtNum(amount)}<span className="text-muted" style={{ fontWeight: 400, fontSize: 14, marginLeft: 3 }}>원</span>
      </div>
    </button>
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

  if (txn.kind === "income" && ["입금 예정", "일부 입금"].includes(txn.status))
    return <button className="btn primary sm" onClick={doIncome}>입금 처리</button>;

  /* 장기 미수도 할 수 있는 건 '입금 처리'뿐이다.
     (제거) '독촉' 버튼 — 눌러도 "준비 중이에요" 토스트만 떴다. 정직하긴 했지만 누를 수 있는
     버튼이 있으면 기대가 생기고, 장기 미수 행마다 매번 그 실망을 반복하게 된다.
     메일 발송을 실제로 붙일 때 청구서 상세의 독촉과 함께 되살린다. */
  if (txn.kind === "income" && txn.status === "장기 미수")
    return <button className="btn primary sm" onClick={doIncome}>입금 처리</button>;

  if (txn.kind === "expense" && ["지급 예정", "지급 대기", "기한 지남"].includes(txn.status))
    return <button className="btn primary sm" onClick={doExpense}>이체 실행</button>;

  return <span className="text-xs text-muted2">—</span>;
};

const DetailRow = ({ label, value }) => (
  <div className="row" style={{ padding: "10px 0", borderBottom: "1px solid var(--line)", fontSize: 13.5 }}>
    <span className="text-muted fw-600" style={{ width: 100 }}>{label}</span>
    <span className="fw-600">{value}</span>
  </div>
);

const TransactionDetailDrawer = ({ txn, onClose, toast, confirm, openEdit, onAction }) => {
  const [tab, setTab] = useState("개요");
  const [docs, setDocs] = useState([]);
  const [resolution, setResolution] = useState(null);   // 이 지출에 연결된 지급결의서
  const [company, setCompany] = useState(null);
  const [resView, setResView] = useState(false);        // 결의서 열람 모달
  useEffect(() => {
    if (!txn) return;
    setTab("개요"); setDocs(txn.docs || []); setResolution(null); setResView(false);
    if (txn.kind === "expense") {
      api.getResolutionByTxn(txn.id).then(setResolution);
      api.getCompany().then(setCompany);
    }
  }, [txn]);
  if (!txn) return null;
  return (
    <Drawer open={true} onClose={onClose} width="min(560px, 100vw)">
        <div className="drawer-head">
          <div>
            <div className="row gap-8">
              <span className={`badge ${txn.sign > 0 ? "pos" : "neg"}`}>{txn.sign > 0 ? "입금" : "지출"}</span>
              <StatusBadge status={txn.status}/>
            </div>
            <div className="fw-700" style={{ fontSize: 16, marginTop: 6 }}>{txn.vendor}</div>
            <div className="text-xs text-muted">{txn.scope} · {txn.category} · {txn.date}</div>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        <div style={{ borderBottom: "1px solid var(--line)", padding: "0 22px" }}>
          {["개요", "증빙"].map(t => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>

        <div className="drawer-body">
          {tab === "개요" && (
            <div>
              <div className="card" style={{ padding: 18, background: "var(--surface-2)", border: "1px solid var(--line)", marginBottom: 18 }}>
                <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 4 }}>{txn.sign > 0 ? "입금액" : "지출액"}</div>
                <div className="num fw-700" style={{ fontSize: 28, letterSpacing: "-0.02em", color: txn.sign > 0 ? "var(--pos)" : "var(--ink)" }}>
                  {txn.sign > 0 ? "+" : "−"}{fmtNum(txn.amount)}<span className="text-muted" style={{ fontWeight: 400, fontSize: 16, marginLeft: 4 }}>원</span>
                </div>
              </div>
              <DetailRow label="거래일"    value={txn.date}/>
              <DetailRow label="거래처"    value={txn.vendor}/>
              <DetailRow label="내용" value={txn.scope}/>
              <DetailRow label="비목"      value={txn.category}/>
              {/* 지출인데 '입금 계좌'라고 적혀 있었다. 바로 위 금액 칸은 sign으로 갈라 쓰면서
                  여기만 고정 문구였다. 앱 전체가 쓰는 짝(PaidIssueDrawer·Contract·Finance)에 맞춘다. */}
              {txn.account && <DetailRow label={txn.sign > 0 ? "입금 계좌" : "출금 계좌"} value={txn.account}/>}
              {txn.method  && <DetailRow label="결제수단"  value={txn.method}/>}
              {txn.memo    && <DetailRow label="메모"      value={txn.memo}/>}
              {txn.doc     && <DetailRow label="결의서"    value={<StatusBadge status={txn.doc}/>}/>}
            </div>
          )}
          {tab === "증빙" && (() => {
            const ACCEPT = ".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.hwp";
            const attach = async (file, docType) => {
              if (!file) return;
              const up = await api.uploadFile(file);
              if (!up?.url) { toast.push("업로드에 실패했어요", { tone: 'warn' }); return; }
              const res = await api.addTransactionDoc(txn.id, { url: up.url, name: up.originalName || file.name, doc_type: docType || '기타', size: up.size || 0 });
              if (res.ok) { setDocs(prev => [...prev, { id: res.id, url: up.url, name: up.originalName || file.name, type: docType || '기타', size: up.size || 0 }]); toast.push("증빙이 첨부됐어요"); onAction?.(); }
              else toast.push("첨부에 실패했어요", { tone: 'warn' });
            };
            const remove = async (d) => {
              const res = d.id ? await api.deleteTransactionDoc(d.id) : await api.updateTransactionEvidence(txn.id, { evid_url: '', evid_type: '' });
              if (res.ok) { setDocs(prev => prev.filter(x => x !== d)); toast.push("삭제됐어요"); onAction?.(); }
              else toast.push("삭제에 실패했어요", { tone: 'warn' });
            };
            return (
            <div className="col gap-10">
              {/* 이 지출에 연결된 지급결의서 — 별도 파일 없이 여기서 열람·인쇄 */}
              {resolution && (
                <div className="row gap-12" style={{ padding: 14, border: "1px solid var(--brand)", borderRadius: 12, background: "var(--brand-soft)" }}>
                  <div style={{ width: 40, height: 48, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, display: "grid", placeItems: "center" }}><Icon.Sign size={20}/></div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="fw-600">지급결의서 {resolution.doc_no}</div>
                    <div className="text-xs text-muted2">{resolution.title} · {fmtNum(resolution.amount)}원</div>
                  </div>
                  <button className="btn sm" onClick={() => setResView(true)}><Icon.Eye size={13}/> 보기</button>
                </div>
              )}
              {docs.length === 0 && !resolution && (
                <div className="alert-row" style={{ background: "var(--neg-soft)", borderColor: "transparent" }}>
                  <Icon.Warn/>
                  <div><div className="lead">증빙이 없어요</div><div className="body">영수증·세금계산서 등을 첨부해주세요. 여러 개도 됩니다.</div></div>
                </div>
              )}
              {docs.map((d, i) => (
                <div key={d.id || i} className="row gap-12" style={{ padding: 14, border: "1px solid var(--line)", borderRadius: 12, background: "#fff" }}>
                  <div style={{ width: 40, height: 48, background: "var(--surface-3)", border: "1px solid var(--line)", borderRadius: 6, display: "grid", placeItems: "center" }}><Icon.File size={20}/></div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="fw-600" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name || '첨부 파일'}</div>
                    <div className="text-xs text-muted2">{d.type || '기타'}{d.size ? ` · ${Math.round(d.size / 1024)}KB` : ''}</div>
                  </div>
                  <button className="btn ghost sm" onClick={() => window.open(d.url, '_blank')}><Icon.Eye/></button>
                  <a className="btn ghost sm" href={d.url} download={d.name} style={{ textDecoration: "none" }}><Icon.Download size={14}/></a>
                  <button className="btn ghost sm" style={{ color: "var(--neg)" }} onClick={() => remove(d)}><Icon.Close size={14}/></button>
                </div>
              ))}
              <label className="drop" style={{ display: "block", cursor: "pointer" }}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); attach(e.dataTransfer.files[0]); }}>
                <Icon.Upload size={22}/>
                <div className="fw-600" style={{ marginTop: 8 }}>증빙 파일을 끌어다 놓거나 클릭해서 추가</div>
                <div className="text-xs text-muted2" style={{ marginTop: 4 }}>여러 개 첨부 가능 · PDF, JPG, PNG · 최대 20MB</div>
                <input type="file" style={{ display: "none" }} accept={ACCEPT} onChange={e => attach(e.target.files[0])}/>
              </label>
            </div>
            );
          })()}
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>닫기</button>
          <button className="btn" style={{ color: "var(--neg-ink)", borderColor: "var(--neg)", background: "var(--neg-soft)" }} onClick={async () => {
            const ok = await confirm({ tone: "neg", icon: <Icon.Warn size={22}/>, title: "거래 삭제", body: `${txn.vendor} · ${fmtNum(txn.amount)}원 거래를 삭제합니다. 복구할 수 없어요.`, confirmLabel: "삭제" });
            if (ok) {
              const res = await api.deleteTransaction(txn.id);
              if (res.ok) { toast.push("삭제됐어요"); onClose(); onAction?.(); }
              // 세금 납부·결의서·급여에 연결된 거래는 409로 막힌다. 사유를 그대로 보여줘야
              // 사용자가 어디서 취소해야 하는지 알 수 있다.
              else toast.push(res.error || "삭제에 실패했어요", { tone: "warn" });
            }
          }}><Icon.Trash size={14}/> 삭제</button>
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={() => { onClose(); openEdit?.(txn); }}><Icon.Pencil size={14}/> 편집</button>
            {txn.kind === "income" && ["입금 예정", "일부 입금", "장기 미수"].includes(txn.status) && (
              <button className="btn primary" onClick={async () => {
                const ok = await confirm({ tone: "brand", icon: <Icon.In size={22}/>, title: "입금 처리", body: `${fmtNum(txn.amount)}원을 입금 완료로 처리합니다.`, confirmLabel: "입금 처리" });
                if (ok) { const res = await api.updateTransactionStatus(txn.id, "입금완료"); if (res.ok) { toast.push("입금이 처리됐어요"); onClose(); onAction?.(); } else toast.push(res.error || "처리에 실패했어요", { tone: "warn" }); }
              }}><Icon.Check size={14}/> 입금 처리</button>
            )}
            {txn.kind === "expense" && ["지급 예정", "지급 대기", "기한 지남"].includes(txn.status) && (
              <button className="btn primary" onClick={async () => {
                const ok = await confirm({ tone: "neg", icon: <Icon.Bank size={22}/>, title: "이체 실행", body: `${fmtNum(txn.amount)}원을 지급완료로 처리합니다.`, confirmLabel: "이체 실행" });
                if (ok) { const res = await api.updateTransactionStatus(txn.id, "지급완료"); if (res.ok) { toast.push("이체가 완료됐어요"); onClose(); onAction?.(); } else toast.push(res.error || "처리에 실패했어요", { tone: "warn" }); }
              }}><Icon.Bank size={14}/> 이체 실행</button>
            )}
          </div>
        </div>

        {/* 지급결의서 열람·인쇄 모달 — 별도 파일 없이 증빙 영역에서 바로 */}
        {resView && resolution && (
          <div className="res-viewer-overlay" onClick={() => setResView(false)}>
            <div className="res-viewer" onClick={e => e.stopPropagation()}>
              <div className="row gap-8 no-print" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
                <span className="fw-700">지급결의서 {resolution.doc_no}</span>
                <div className="ml-auto row gap-6">
                  <button className="btn" onClick={() => window.print()}><Icon.Print/> 인쇄</button>
                  <button className="icon-btn" onClick={() => setResView(false)}><Icon.Close size={16}/></button>
                </div>
              </div>
              <div style={{ padding: 20, overflow: "auto" }}>
                <ResolutionDocument doc={resolution} company={company} printClass="resolution-print"/>
              </div>
            </div>
          </div>
        )}
    </Drawer>
  );
};
