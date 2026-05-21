import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Popover, PopItem, Spacer, StatusBadge, PERIOD_PRESETS, inPeriod, periodRangeLabel, FilterSelect, Drawer } from '../lib/ui'
import { SAMPLE } from '../lib/data'

export const LedgerScreen = ({ initialFilter = "all", openIncome, openExpense, openExcel }) => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [filter, setFilter] = useState(initialFilter);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [period, setPeriod] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [filterCat, setFilterCat] = useState(null);

  useEffect(() => { setFilter(initialFilter); }, [initialFilter]);

  const txns = useMemo(() => {
    const ins = SAMPLE.incomes.map(r => ({
      kind: "income", sign: +1,
      date: r.date, vendor: r.vendor, scope: r.contract, category: r.type,
      amount: r.amount, account: r.account, status: r.status, evid: r.evid, memo: r.memo,
    }));
    const outs = SAMPLE.expenses.map(r => ({
      kind: "expense", sign: -1,
      date: r.date, vendor: r.vendor, scope: r.scope, category: r.category,
      amount: r.amount, method: r.method, status: r.pay, doc: r.doc, evid: r.evid,
    }));
    return [...ins, ...outs].sort((a, b) => b.date.localeCompare(a.date));
  }, []);

  const categories = useMemo(() => [...new Set(txns.map(t => t.category).filter(Boolean))].sort(), [txns]);

  const filtered = useMemo(() => {
    let rows = txns;
    if (filter === "income")  rows = rows.filter(t => t.kind === "income");
    else if (filter === "expense") rows = rows.filter(t => t.kind === "expense");
    else if (filter === "ar") rows = rows.filter(t => t.kind === "income" && ["입금 예정", "일부 입금", "장기 미수"].includes(t.status));
    else if (filter === "ap") rows = rows.filter(t => t.kind === "expense" && ["지급 예정", "지급 대기", "기한 지남"].includes(t.status));
    if (period !== "all") rows = rows.filter(t => inPeriod(t.date, period, { from: customFrom, to: customTo }));
    if (filterCat)        rows = rows.filter(t => t.category === filterCat);
    if (q) {
      const lc = q.toLowerCase();
      rows = rows.filter(t => t.vendor.toLowerCase().includes(lc) || t.scope?.toLowerCase().includes(lc) || t.category?.toLowerCase().includes(lc));
    }
    return rows;
  }, [txns, filter, q, period, customFrom, customTo, filterCat]);

  const inSum  = txns.filter(t => t.kind === "income"  && t.status === "입금 완료").reduce((a, t) => a + t.amount, 0);
  const outSum = txns.filter(t => t.kind === "expense" && t.status === "지급 완료").reduce((a, t) => a + t.amount, 0);
  const arSum  = txns.filter(t => t.kind === "income"  && ["입금 예정", "일부 입금", "장기 미수"].includes(t.status)).reduce((a, t) => a + t.amount, 0);
  const apSum  = txns.filter(t => t.kind === "expense" && ["지급 예정", "지급 대기", "기한 지남"].includes(t.status)).reduce((a, t) => a + t.amount, 0);

  const tabs = [
    { id: "all",     label: "전체 거래",  count: txns.length },
    { id: "income",  label: "입금",       count: txns.filter(t => t.kind === "income").length },
    { id: "expense", label: "지출",       count: txns.filter(t => t.kind === "expense").length },
    { id: "ar",      label: "미수금",     count: txns.filter(t => t.kind === "income" && ["입금 예정", "일부 입금", "장기 미수"].includes(t.status)).length },
    { id: "ap",      label: "미지급금",   count: txns.filter(t => t.kind === "expense" && ["지급 예정", "지급 대기", "기한 지남"].includes(t.status)).length },
  ];

  const titleMap = { all: "거래내역", income: "거래내역 · 입금", expense: "거래내역 · 지출", ar: "거래내역 · 미수금", ap: "거래내역 · 미지급금" };
  const subMap = {
    all:     "한 곳에서 입금·지출·미수금·미지급금을 모두 확인하세요.",
    income:  "발주처에서 들어온 돈을 등록하고 처리하세요.",
    expense: "외주가공·자재·운영비를 등록하고 결의·이체로 처리하세요.",
    ar:      "납품 후 입금되지 않은 금액입니다. 행을 클릭해 입금을 처리하세요.",
    ap:      "지급해야 할 비용입니다. 행을 클릭해 이체를 실행하세요.",
  };

  return (
    <>
      <div className="fade-up">
        <div className="row page-header-row" style={{ marginBottom: 8 }}>
          <div>
            <div className="page-title">{titleMap[filter]}</div>
            <div className="page-sub">{subMap[filter]}</div>
          </div>
          <div className="ml-auto row gap-8">
            <button className="btn excel" onClick={openExcel}><Icon.Excel/> <span className="btn-label-hide">엑셀 업로드</span></button>
            <button className="btn" onClick={() => toast.push("거래내역을 엑셀로 내려받았어요")}><Icon.Download/> <span className="btn-label-hide">내보내기</span></button>
            <Popover align="right" width={220}
              trigger={<button className="btn primary"><Icon.Plus/> 거래 등록 <Icon.Down size={12} style={{ marginLeft: 2 }}/></button>}>
              <div style={{ padding: 6 }}>
                <PopItem icon={<Icon.In size={16}/>}  label="입금 등록" sub="수금 내역을 등록합니다" onClick={openIncome}/>
                <PopItem icon={<Icon.Out size={16}/>} label="지출 등록" sub="지출 내역을 등록합니다" onClick={openExpense}/>
              </div>
            </Popover>
          </div>
        </div>

        <Spacer h={20}/>

        <div className="grid grid-4-to-2" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
          <LedgerCard label="이번 달 입금"  amount={inSum}  tone="pos"   active={filter === "income"} onClick={() => setFilter("income")}/>
          <LedgerCard label="이번 달 지출"  amount={outSum} tone="neg"   active={filter === "expense"} onClick={() => setFilter("expense")}/>
          <LedgerCard label="미수금"        amount={arSum}  tone="brand" active={filter === "ar"} onClick={() => setFilter("ar")} note="입금 대기"/>
          <LedgerCard label="미지급금"      amount={apSum}  tone="warn"  active={filter === "ap"} onClick={() => setFilter("ap")} note="지급 대기"/>
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div className="row gap-6" style={{ padding: 12, borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
            {tabs.map(t => (
              <button key={t.id} className={`chip ${filter === t.id ? "active" : ""}`} onClick={() => setFilter(t.id)}>
                {t.label} <span style={{ marginLeft: 4, opacity: 0.7 }}>{t.count}</span>
              </button>
            ))}
            <div className="ml-auto row gap-8">
              <div className="search" style={{ margin: 0, width: 220, padding: "6px 10px" }}>
                <Icon.Search size={14}/>
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="거래처·계약·비목 검색"/>
              </div>
              <button
                className="btn"
                onClick={() => setFilterOpen(s => !s)}
                style={{ position: "relative" }}>
                <Icon.Filter/>
                필터
                {(period !== "all" || filterCat) && (
                  <span style={{ position: "absolute", top: 6, right: 6, width: 6, height: 6, borderRadius: "50%", background: "var(--brand)" }}/>
                )}
              </button>
              <button
                className={`btn ${period === "month" ? "active" : ""}`}
                onClick={() => setPeriod(p => p === "month" ? "all" : "month")}>
                <Icon.Calendar/>
                이번 달
              </button>
            </div>
          </div>

          {filterOpen && (
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", background: "var(--surface-2)", display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="row gap-8" style={{ flexWrap: "wrap", alignItems: "center" }}>
                <span className="text-xs fw-600 text-muted" style={{ width: 36, flexShrink: 0 }}>기간</span>
                {PERIOD_PRESETS.map(p => (
                  <button key={p.id} className={`chip ${period === p.id ? "active" : ""}`} onClick={() => setPeriod(p.id)}>
                    {p.label}
                  </button>
                ))}
              </div>
              {period === "custom" && (
                <div className="row gap-8" style={{ alignItems: "center", paddingLeft: 44 }}>
                  <input type="date" className="input num" style={{ height: 34, width: 148, fontSize: 13 }}
                    value={customFrom} onChange={e => setCustomFrom(e.target.value)}/>
                  <span className="text-muted fw-600">~</span>
                  <input type="date" className="input num" style={{ height: 34, width: 148, fontSize: 13 }}
                    value={customTo} onChange={e => setCustomTo(e.target.value)}/>
                </div>
              )}
              <div className="row gap-8" style={{ alignItems: "center" }}>
                <span className="text-xs fw-600 text-muted" style={{ width: 36, flexShrink: 0 }}>비목</span>
                <FilterSelect value={filterCat} onChange={setFilterCat} options={categories} placeholder="전체"/>
              </div>
              {(period !== "all" || filterCat) && (
                <div className="row gap-10" style={{ alignItems: "center" }}>
                  {period !== "all" && (() => {
                    const label = periodRangeLabel(period, { from: customFrom, to: customTo });
                    return (
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>
                        <span className="fw-600" style={{ color: "var(--brand-ink)" }}>
                          {PERIOD_PRESETS.find(p => p.id === period)?.label}
                        </span>
                        {label && <span className="num" style={{ marginLeft: 6 }}>({label})</span>}
                      </span>
                    );
                  })()}
                  <button className="btn ghost sm" onClick={() => { setPeriod("all"); setFilterCat(null); setCustomFrom(""); setCustomTo(""); }}>
                    <Icon.Close size={12}/> 초기화
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 110 }}>날짜</th>
                  <th>거래처</th>
                  <th>계약/공통</th>
                  <th>비목</th>
                  <th className="num-right">금액</th>
                  <th style={{ width: 110 }}>상태</th>
                  <th style={{ width: 70 }}>증빙</th>
                  <th style={{ width: 130 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={8} style={{ textAlign: "center", padding: 50, color: "var(--muted-2)", fontSize: 13 }}>
                    조건에 맞는 거래내역이 없어요.
                  </td></tr>
                )}
                {filtered.map((t, i) => (
                  <tr key={i} style={{ cursor: "pointer" }} onClick={() => setSel(t)}>
                    <td className="num-cell text-muted text-sm">{t.date}</td>
                    <td className="fw-700">{t.vendor}</td>
                    <td className="text-muted text-sm">{t.scope}</td>
                    <td><span className="badge outline">{t.category}</span></td>
                    <td className="num-cell num-right fw-700" style={{ color: t.sign > 0 ? "var(--pos)" : "var(--ink)" }}>
                      {t.sign > 0 ? "+" : "−"}{fmtNum(t.amount)}
                    </td>
                    <td><StatusBadge status={t.status}/></td>
                    <td>
                      {t.evid
                        ? <span className="badge pos" style={{ padding: "2px 8px" }}><Icon.Check size={11}/></span>
                        : <span className="badge neg" style={{ padding: "2px 8px" }}><Icon.Warn size={11}/></span>}
                    </td>
                    <td><TxnActions txn={t} toast={toast} confirm={confirm}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row" style={{ padding: "14px 18px", borderTop: "1px solid var(--line)", color: "var(--muted)", fontSize: 12.5 }}>
            전체 {filtered.length}건
          </div>
        </div>
      </div>

      <TransactionDetailDrawer txn={sel} onClose={() => setSel(null)} toast={toast} openIncome={openIncome} openExpense={openExpense}/>
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

const TxnActions = ({ txn, toast, confirm }) => {
  if (txn.kind === "income" && ["입금 예정", "일부 입금"].includes(txn.status)) {
    return (
      <button className="btn primary sm" onClick={async (e) => {
        e.stopPropagation();
        const ok = await confirm({ tone: "brand", icon: <Icon.In size={22}/>, title: `${txn.vendor} 입금 처리`, body: `${txn.scope}의 ${fmtNum(txn.amount)}원을 입금 완료로 처리합니다.`, confirmLabel: "입금 처리" });
        if (ok) toast.push("입금이 처리되었어요");
      }}>입금 처리</button>
    );
  }
  if (txn.kind === "income" && txn.status === "장기 미수") {
    return (
      <div className="row gap-4">
        <button className="btn sm" onClick={(e) => { e.stopPropagation(); toast.push("독촉 메일을 발송했어요"); }}>독촉</button>
        <button className="btn primary sm" onClick={async (e) => {
          e.stopPropagation();
          const ok = await confirm({ tone: "pos", icon: <Icon.In size={22}/>, title: `${txn.vendor} 입금 처리`, body: `${txn.scope}의 ${fmtNum(txn.amount)}원을 입금 완료로 처리합니다.`, confirmLabel: "입금 처리" });
          if (ok) toast.push("입금이 처리되었어요");
        }}>입금 처리</button>
      </div>
    );
  }
  if (txn.kind === "expense" && ["지급 예정", "지급 대기", "기한 지남"].includes(txn.status)) {
    return (
      <button className="btn primary sm" onClick={async (e) => {
        e.stopPropagation();
        const ok = await confirm({ tone: "neg", icon: <Icon.Bank size={22}/>, title: `${txn.vendor} 이체 실행`, body: `${txn.category} ${fmtNum(txn.amount)}원이 등록된 계좌에서 출금됩니다.`, confirmLabel: "이체 실행" });
        if (ok) toast.push("이체가 실행되었어요");
      }}>이체 실행</button>
    );
  }
  return <span className="text-xs text-muted2">—</span>;
};

const DetailRow = ({ label, value }) => (
  <div className="row" style={{ padding: "10px 0", borderBottom: "1px solid var(--line)", fontSize: 13.5 }}>
    <span className="text-muted fw-600" style={{ width: 100 }}>{label}</span>
    <span className="fw-600">{value}</span>
  </div>
);

const TransactionDetailDrawer = ({ txn, onClose, toast, openIncome, openExpense }) => {
  const [tab, setTab] = useState("개요");
  useEffect(() => { if (txn) setTab("개요"); }, [txn]);
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
          {["개요", txn.kind === "expense" ? "결의서" : null, "증빙"].filter(Boolean).map(t => (
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
              <DetailRow label="계약/공통" value={txn.scope}/>
              <DetailRow label="비목"      value={txn.category}/>
              {txn.account && <DetailRow label="입금 계좌" value={txn.account}/>}
              {txn.method  && <DetailRow label="결제수단"  value={txn.method}/>}
              {txn.memo    && <DetailRow label="메모"      value={txn.memo}/>}
              {txn.doc     && <DetailRow label="결의서"    value={<StatusBadge status={txn.doc}/>}/>}
            </div>
          )}
          {tab === "결의서" && (
            <div>
              <div className="alert-row" style={{ background: "var(--brand-soft)", borderColor: "transparent", marginBottom: 16 }}>
                <Icon.Sign/>
                <div><div className="lead">이 지출에 연결된 결의서</div><div className="body">결의서는 지출과 함께 자동 생성되어 결재선을 따라갑니다.</div></div>
              </div>
              <DetailRow label="문서번호" value={<span className="num">{`EXP-${txn.date.slice(0, 4)}-${String(([...(txn.vendor + txn.date)].reduce((a, c) => a + c.charCodeAt(0), 0) % 9000) + 1000).padStart(4, '0')}`}</span>}/>
              <DetailRow label="상태"     value={<StatusBadge status={txn.doc || "승인 완료"}/>}/>
              <DetailRow label="작성자"   value="한경리"/>
              <DetailRow label="결재선"   value="한경리 → 정대표 (단독 결재)"/>
              <div className="row gap-8" style={{ marginTop: 18 }}>
                <button className="btn"><Icon.Eye size={14}/> 미리보기</button>
                <button className="btn"><Icon.Download size={14}/> PDF</button>
              </div>
            </div>
          )}
          {tab === "증빙" && (
            <div>
              {txn.evid ? (
                <div className="col gap-10">
                  <div className="row gap-12" style={{ padding: 14, border: "1px solid var(--line)", borderRadius: 12, background: "#fff" }}>
                    <div style={{ width: 40, height: 48, background: "var(--surface-3)", border: "1px solid var(--line)", borderRadius: 6, display: "grid", placeItems: "center" }}><Icon.File size={20}/></div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="fw-600">세금계산서_{txn.vendor}.pdf</div>
                      <div className="text-xs text-muted2">세금계산서 · 82KB · {txn.date}</div>
                    </div>
                    <button className="btn ghost sm"><Icon.Eye/></button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="alert-row" style={{ background: "var(--neg-soft)", borderColor: "transparent", marginBottom: 14 }}>
                    <Icon.Warn/>
                    <div><div className="lead">증빙이 없어요</div><div className="body">영수증 또는 세금계산서가 첨부되지 않았습니다.</div></div>
                  </div>
                  <div className="drop">
                    <Icon.Upload size={22}/>
                    <div className="fw-600" style={{ marginTop: 8 }}>증빙 파일을 끌어다 놓거나 클릭해서 업로드</div>
                    <div className="text-xs text-muted2" style={{ marginTop: 4 }}>PDF, JPG, PNG · 최대 20MB</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>닫기</button>
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={() => { onClose(); txn.kind === "income" ? openIncome?.() : openExpense?.(); }}><Icon.Pencil size={14}/> 편집</button>
            {txn.kind === "income" && ["입금 예정", "일부 입금", "장기 미수"].includes(txn.status) && (
              <button className="btn primary" onClick={() => { onClose(); toast.push("입금이 처리되었어요"); }}><Icon.Check size={14}/> 입금 처리</button>
            )}
            {txn.kind === "expense" && ["지급 예정", "지급 대기", "기한 지남"].includes(txn.status) && (
              <button className="btn primary" onClick={() => { onClose(); toast.push("이체가 실행되었어요"); }}><Icon.Bank size={14}/> 이체 실행</button>
            )}
          </div>
        </div>
    </Drawer>
  );
};
