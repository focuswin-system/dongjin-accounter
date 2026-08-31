import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, StatusBadge, periodToRange, FilterSelect, Drawer, localToday } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DataTable } from '../lib/components/DataTable'
import { TableToolbar } from '../lib/components/TableToolbar'
import { VoucherView } from '../lib/components/VoucherView'
import { useTableFilter } from '../lib/tableFilter'
import { api } from '../lib/api'
import { downloadCsv } from '../lib/export'
import { ResolutionDocument } from './Docs'

// CSV 저장은 보고서 내보내기와 같은 것을 쓴다 → lib/export.js

/* 거래내역 — **조회 화면**. openIncome/openExpense 를 더 받지 않는다(등록 입구는 여기 없다).
   화면에서 뺀 것은 배선까지 은퇴시킨다 — 남겨 두면 다음 사람이 "쓰는 줄 알고" 다시 버튼을 단다. */
export const LedgerScreen = ({ initialFilter = "all", openEdit, openExcel, openInvoice, refreshTrigger,
  /* 다른 화면에서 "이 거래를 거래내역에서 열어줘"라고 넘겨준 id.
     없으면 평소처럼 목록만 연다(청구서의 focusInvoiceId 와 같은 방식). */
  focusTxnId }) => {
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
    api.getContracts().then(list => setAllContracts(list || []));
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
    date: { field: 'date', initial: periodToRange("month") },
    search: { fields: ['vendor', 'scope', 'category', 'contract'], placeholder: "거래처·주문·비목 검색" },
    filters: [
      { key: 'cat', label: "비목", field: 'category', options: categories },
      /* 주문으로 거르기 — 잘못 붙은 거래를 찾으려면 "이 주문에 붙은 것 전부"를
         한 번에 봐야 한다. 예전엔 검색어로 더듬는 수밖에 없었다.
         두 축(근거·원가 귀속)을 모두 본다 — 이 필터의 뜻이 그것이지, 어느 컬럼이냐가 아니다. */
      { key: 'contract', label: "주문", options: contracts,
        match: (t, v) => t.contract === v || t.cost_contract_name === v },
    ],
  });
  const { range, setRange, q, setQ } = tf;

  /* 기간·비목·검색까지만 적용한 범위. 입금/지출 탭은 아직 안 나눈다.
     합계 카드와 탭 옆 건수는 이 범위를 쓴다 — 예전엔 둘 다 전체 txns 로 계산해서
     "2026년 7월"로 좁혀놔도 카드에는 **개업 이래 누계**가, 탭에는 전체 건수가 떠 있었다.
     화면의 표와 숫자가 서로 다른 기간을 말하니 그 값을 그대로 보고에 옮기면 틀린다. */
  const scoped = useMemo(() => tf.apply(txns), [txns, tf.apply]);

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
      contract: inv.contract || '',
      scope: inv.memo || inv.invoiceNo,
      category: inv.kind === 'issued' ? '미수금' : '미지급금',
      amount: Number(inv.remainAmount) || 0,
      status: inv.status,
    }));
    /* 실제 거래와 **같은 규칙**으로 거른다. 예전엔 여기에 술어를 다시 적었고,
       그러다 주문 필터가 빠져서 주문으로 좁혀도 예정분은 전 주문이 떠 있었다. */
    return tf.apply(rows);
  }, [showPlanned, openInvoices, tf.apply]);

  /* 짚어 열기 — 청구서·주문에서 "이 거래를 거래내역에서 열어줘"로 넘어온 경우.
     ⚠ **필터를 안 거친 원본(txns)에서 찾는다.** 기본 기간이 이번 달이라, 지난달 거래를
     넘겨받으면 filtered 에는 없어서 아무 일도 안 일어난다 — 넘어왔는데 안 열리면
     기능이 고장난 것으로 읽힌다. */
  useEffect(() => {
    if (!focusTxnId || !txns.length) return
    const hit = txns.find(t => t.id === focusTxnId)
    if (hit) setSel(hit)
  }, [focusTxnId, txns]);

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
      ["날짜", "실제/예정", "구분", "거래처", "주문", "원가 귀속", "적요", "비목", "금액", "상태"],
      filtered.map(t => [t.date, t.planned ? "예정" : "실제", t.kind === "income" ? "입금" : "지출",
        t.vendor, t.contract || "", t.cost_contract_name || "", t.scope, t.category, t.sign * t.amount, t.status]));
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
    const rows = filtered.filter(t => checkedIds.includes(t.id) && !t.planned);
    if (!rows.length) return;
    /* ⚠ **id 로 찾는다.** 예전엔 이름으로 찾았는데 주문 이름은 유일하지 않다 —
       실제 회사에 거래처만 다른 '홈페이지 유지보수' 가 여덟 개 있었고, 그때 find 는
       목록의 첫 번째를 집었다. 여기는 **한 번에 수십 건**을 붙이는 자리라 피해가 크다. */
    const target = unlink ? null : allContracts.find(c => c.id === bulkContract);
    if (!unlink && !target) return toast.push('주문을 골라주세요', { tone: 'warn' });

    const isPurchaseC = target && (target.gubu === 'A' || target.gubu === 'E' || target.is_purchase);
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
    if (!done) return toast.push('연결된 주문이 없는 거래예요');
    toast.push(unlink ? `${done}건의 주문 연결을 뗐어요` : `${done}건을 ${target?.name || '주문'}에 연결했어요`);
    setCheckedIds([]); setBulkContract(null); reload();
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
  /* 이 화면은 **조회하는 곳**이다.
   *
   * 여기 있는 모든 줄은 다른 화면에서 만들어진다 — 입금은 수시입금·정기입금에서,
   * 지급은 수시지급·정기지급·경비에서, 급여는 인사급여에서. 거래내역은 그 전부가
   * 한 자리에 모여 "그래서 통장에 무슨 일이 있었나"를 보는 곳이다.
   *
   * 그래서 문구가 **등록을 시키면 안 된다.** 예전엔 "…등록하고 처리하세요"라고 적어 두고
   * 상단에 '거래 등록' 버튼까지 세워 뒀는데, 그러면 같은 거래를 만드는 입구가 두 벌이 된다 —
   * 회계 분류를 먼저 묻지 않는 이 입구로 들어오면 서류 선택(DocTypeChooser)이 걸러 주던
   * 것들을 그냥 지나친다. 보다가 이상한 줄을 찾으면 그 줄을 열어 고치면 된다. 그건 됐다.
   * 다만 **권하지는 않는다.** */
  /* ⚠ 이 표는 오랫동안 **정의만 돼 있고 화면에 안 붙어 있었다.** 등록 버튼을 뺀 지금은
     이 줄이 있어야 한다 — "그럼 등록은 어디서 하지"에 그 자리에서 답해 줘야 하기 때문이다. */
  const subMap = {
    all:     "실제로 오간 모든 입금·지출을 한자리에서 봅니다. 이상한 줄이 있으면 눌러서 확인하세요. 등록은 입금관리·지급처리에서 해요.",
    income:  "들어온 돈을 모아 봅니다. 등록은 입금관리에서 해요.",
    expense: "나간 돈을 모아 봅니다. 등록은 지급처리에서 해요.",
  };

  return (
    <>
      <div className="fade-up">
        <PageHeader
          title={titleMap[filter]}
          sub={subMap[filter]}
          /* '거래 등록'을 여기서 뺐다 — 등록 입구는 입금관리·지급처리 쪽 하나로 모은다.
             남은 둘은 조회의 연장이다(엑셀로 한꺼번에 들여오기 / 본 것을 내보내기).
             둘 다 primary 가 아니다 — 이 화면에서 제일 하고 싶은 일이 아니다. */
          actions={<>
            <button className="btn excel" onClick={openExcel}><Icon.Excel/> <span className="btn-label-hide">엑셀 업로드</span></button>
            <button className="btn" onClick={exportCsv}><Icon.Download/> <span className="btn-label-hide">내보내기</span></button>
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
            {...tf.toolbarProps}
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

          {/* 선택 바 — 엑셀로 올린 거래를 주문에 한꺼번에 붙이는 자리.
              한 건씩 열어 고르던 것이 "굉장히 번거롭다"는 지적에서 나왔다. */}
          {checkedIds.length > 0 && (
            <div className="card card-pad" style={{ margin: '0 16px 12px', position: 'sticky', top: 0, zIndex: 3 }}>
              <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="fw-700 text-sm">{checkedIds.length}건 선택</span>
                <button className="btn ghost sm" onClick={() => setCheckedIds([])}>선택 해제</button>
                <div className="row gap-6 ml-auto" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="text-xs text-muted2">주문</span>
                  <FilterSelect value={bulkContract} onChange={setBulkContract}
                    /* 이름이 겹치는 주문은 거래처를 붙여 갈리게 한다(값은 id). */
                    options={allContracts.map(c => ({
                      value: c.id,
                      label: c.vendor_name ? `${c.vendor_name} · ${c.name}` : c.name,
                    }))} placeholder="주문 선택"/>
                  <button className="btn primary" onClick={() => doBulkLink(false)} disabled={!bulkContract}>
                    <Icon.Link size={14}/> 연결
                  </button>
                  <button className="btn" onClick={() => doBulkLink(true)}>연결 떼기</button>
                </div>
              </div>
              {/* 지출을 매출 주문에 붙이는 건 '원가 귀속'이다 — 근거 주문과 다른 축이라
                  무엇으로 붙는지 미리 말해줘야 한다. 조용히 틀리면 원가율만 이상해진다. */}
              <div className="text-xs text-muted2" style={{ marginTop: 8 }}>
                금액은 바뀌지 않아요. 지출을 <b>매출 주문</b>에 붙이면 그 주문의 <b>원가</b>로,
                <b>발주</b>에 붙이면 <b>지급 근거</b>로 잡힙니다.
              </div>
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
            select={{
              ids: checkedIds, onChange: setCheckedIds,
              // 예정 행은 청구서라 주문에 붙일 거래가 아니다
              isSelectable: t => !t.planned,
              disabledHint: () => '아직 오가지 않은 돈이라 주문에 붙일 수 없어요',
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
              /* 주문 — 적요와 **한 칸에 뭉치지 않는다.**
                 예전엔 `주문명 || 적요 || 전표번호` 를 '내용' 한 칸에 넣어서,
                 주문에 붙은 거래인지 아닌지를 화면에서 알 수 없었다.
                 원가 귀속(cost_contract_name)은 근거 주문과 다른 축이라 표식을 달아 가른다. */
              { key: 'contract', header: '주문', sortable: true,
                render: t => {
                  if (t.planned) return <span className="text-muted2 text-sm">—</span>
                  if (t.contract) return <span className="badge outline text-sm">{t.contract}</span>
                  if (t.cost_contract_name) return (
                    <span className="badge outline text-sm" title="이 지출이 원가로 붙은 매출 주문">
                      {t.cost_contract_name} <span className="text-muted2" style={{ fontSize: 10 }}>원가</span>
                    </span>
                  )
                  return <span className="text-muted2 text-sm">—</span>
                } },
              { key: 'scope', header: '적요',
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
  /* ⚠ 색을 박아 두면 안 된다 — 어두운 화면에서 이 카드만 흰 채로 남아 숫자가 안 읽혔다.
     고른 상태의 옅은 바탕은 상태 토큰(--*-soft)이 테마마다 알아서 낸다. */
  const bg = active
    ? (tone === "pos" ? "var(--pos-soft)" : tone === "neg" ? "var(--neg-soft)" : tone === "brand" ? "var(--brand-soft)" : "var(--warn-soft)")
    : "var(--surface)";
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

const TransactionDetailDrawer = ({ txn, onClose, toast, confirm, openEdit, onAction }) => {
  const [tab, setTab] = useState("개요");
  const [docs, setDocs] = useState([]);
  const [resolution, setResolution] = useState(null);   // 이 지출에 연결된 지급결의서
  const [company, setCompany] = useState(null);
  const [resView, setResView] = useState(false);        // 결의서 열람 모달
  const [voucherOpen, setVoucherOpen] = useState(false); // 전표 열람(차변·대변)
  useEffect(() => {
    if (!txn) return;
    // 겹쳐 띄우는 것들도 함께 되돌린다 — 안 그러면 다음 거래를 열 때 전표가 저절로 펼쳐진 채 뜬다
    setTab("개요"); setDocs(txn.docs || []); setResolution(null); setResView(false); setVoucherOpen(false);
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
              {/* 상대 계좌 — 거래처가 계좌를 여럿 가지면 여기만이 '어디로 갔나'의 답이다 */}
              {(txn.counterpartyAccount || txn.counterpartyBank) && (
                <DetailRow label={txn.sign > 0 ? "보낸 계좌" : "받는 계좌"}
                  value={[[txn.counterpartyBank, txn.counterpartyAccount].filter(Boolean).join(' '),
                          txn.counterpartyHolder].filter(Boolean).join(' · ')}/>
              )}
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
                  <div style={{ width: 40, height: 48, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 6, display: "grid", placeItems: "center" }}><Icon.Sign size={20}/></div>
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
                <div key={d.id || i} className="row gap-12" style={{ padding: 14, border: "1px solid var(--line)", borderRadius: 12, background: "var(--surface)" }}>
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
          {/* 삭제는 **눈에 덜 띄게** 둔다. 조회하러 온 화면에서 붉게 채운 버튼이 늘 왼쪽에
              서 있으면 "여기서 지우는 게 보통"으로 읽힌다. 지울 수는 있어야 하니 남기되,
              바탕을 빼고 글자만 붉게 둔다. */}
          <button className="btn" style={{ color: "var(--neg-ink)" }} onClick={async () => {
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
            {/* 이 거래가 장부에 어떻게 오르는지 — 경리가 분개를 확인하고 인쇄하는 자리 */}
            <button className="btn" onClick={() => setVoucherOpen(true)}><Icon.Book size={14}/> 전표</button>
            <button className="btn" onClick={() => { onClose(); openEdit?.(txn); }}><Icon.Pencil size={14}/> 편집</button>
            {txn.kind === "income" && ["입금 예정", "일부 입금", "장기 미수"].includes(txn.status) && (
              <button className="btn" onClick={async () => {
                const ok = await confirm({ tone: "brand", icon: <Icon.In size={22}/>, title: "입금 처리", body: `${fmtNum(txn.amount)}원을 입금 완료로 처리합니다.`, confirmLabel: "입금 처리" });
                if (ok) { const res = await api.updateTransactionStatus(txn.id, "입금완료"); if (res.ok) { toast.push("입금이 처리됐어요"); onClose(); onAction?.(); } else toast.push(res.error || "처리에 실패했어요", { tone: "warn" }); }
              }}><Icon.Check size={14}/> 입금 처리</button>
            )}
            {txn.kind === "expense" && ["지급 예정", "지급 대기", "기한 지남"].includes(txn.status) && (
              <button className="btn" onClick={async () => {
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

        {/* 전표 — 이 거래의 차변·대변. 드로어 위에 겹쳐 뜬다(Drawer 스택이 순서를 관리한다) */}
        <VoucherView open={voucherOpen} onClose={() => setVoucherOpen(false)} source="transaction" id={txn.id}/>
    </Drawer>
  );
};
