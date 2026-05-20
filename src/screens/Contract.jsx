import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge, PERIOD_PRESETS, inPeriod, periodRangeLabel, FilterSelect } from '../lib/ui'
import { SAMPLE } from '../lib/data'
import { MiniStat } from './Home'

const FormBlock = ({ title, hint, children }) => (
  <div>
    <div className="fw-700" style={{ fontSize: 17, marginBottom: 4, letterSpacing: "-0.02em" }}>{title}</div>
    {hint && <div className="text-sm text-muted" style={{ marginBottom: 14 }}>{hint}</div>}
    {children}
  </div>
);

/* ============ 입금 등록 Drawer (레거시 6-step) ============ */
export const IncomeDrawer = ({ open, onClose }) => {
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    vendor: "A기업",
    contract: "MES 유지보수",
    type: "유지보수료",
    amount: 1100000,
    date: "2026-05-13",
    account: "기업은행 *123",
    memo: "5월분",
  });
  const totalSteps = 6;
  const stepLabels = ["거래처", "계약", "입금 구분", "금액", "입금일/계좌", "증빙"];

  useEffect(() => { if (open) setStep(1); }, [open]);

  return (
    <>
      <div className={`drawer-backdrop ${open ? "open" : ""}`} onClick={onClose}/>
      <aside className={`drawer ${open ? "open" : ""}`} role="dialog" aria-label="입금 등록">
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>입금 등록</div>
            <div className="text-xs text-muted">회사에 들어온 돈을 빠르게 기록하세요.</div>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        <div className="drawer-body">
          <div className="steps" style={{ marginBottom: 18 }}>
            {stepLabels.map((s, i) => {
              const n = i + 1;
              const cls = n < step ? "done" : n === step ? "curr" : "";
              return (
                <span key={s} className={`step ${cls}`}>
                  <span className="n">{n < step ? <Icon.Check size={12}/> : n}</span>{s}
                </span>
              );
            })}
          </div>

          {step === 1 && (
            <FormBlock title="어디서 들어온 돈인가요?" hint="거래처를 선택하세요.">
              <input className="input" defaultValue={form.vendor} placeholder="거래처명 검색"/>
              <div className="row gap-6" style={{ marginTop: 10, flexWrap: "wrap" }}>
                {["A기업", "B기업", "C산업", "D테크", "F소프트"].map(v => (
                  <button key={v} className={`chip ${form.vendor === v ? "active" : ""}`} onClick={() => setForm({...form, vendor: v})}>{v}</button>
                ))}
                <button className="chip"><Icon.Plus size={12}/> 새 거래처</button>
              </div>
            </FormBlock>
          )}

          {step === 2 && (
            <FormBlock title="어떤 계약의 돈인가요?" hint="해당하는 계약을 선택해주세요.">
              <div className="col gap-8">
                {["MES 유지보수", "도면관리 구축", "QMS 라이선스", "ERP 커스터마이징", "(계약 없음)"].map(v => (
                  <button key={v} className="row gap-10" onClick={() => setForm({...form, contract: v})}
                    style={{ padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 12, background: form.contract === v ? "var(--surface-3)" : "#fff", textAlign: "left", cursor: "pointer" }}>
                    <div style={{ width: 20, height: 20, borderRadius: "50%", border: "2px solid", borderColor: form.contract === v ? "var(--ink)" : "var(--line-strong)", display: "grid", placeItems: "center" }}>
                      {form.contract === v && <div style={{ width: 8, height: 8, background: "var(--ink)", borderRadius: "50%" }}/>}
                    </div>
                    <span className="fw-600">{v}</span>
                  </button>
                ))}
              </div>
            </FormBlock>
          )}

          {step === 3 && (
            <FormBlock title="어떤 입금인가요?">
              <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {["계약금","중도금","잔금","유지보수료","월 사용료","환급금","잡수익","기타"].map(v => (
                  <button key={v} className={`chip ${form.type === v ? "active" : ""}`} onClick={() => setForm({...form, type: v})}
                    style={{ justifyContent: "center" }}>{v}</button>
                ))}
              </div>
            </FormBlock>
          )}

          {step === 4 && (
            <FormBlock title="얼마가 들어왔나요?">
              <label className="label">금액</label>
              <input className="input num fw-700" style={{ fontSize: 22 }} value={fmtNum(form.amount) + " 원"}
                onChange={e => {
                  const v = parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0;
                  setForm({...form, amount: v});
                }}/>
              <div className="row gap-6" style={{ marginTop: 10, flexWrap: "wrap" }}>
                {[500000, 1000000, 1100000, 3300000].map(a => (
                  <button key={a} className="chip" onClick={() => setForm({...form, amount: a})}>{fmtNum(a)}원</button>
                ))}
              </div>
            </FormBlock>
          )}

          {step === 5 && (
            <FormBlock title="언제 / 어디로 들어왔나요?">
              <label className="label">입금일</label>
              <input className="input" defaultValue={form.date}/>
              <label className="label" style={{ marginTop: 14 }}>입금 계좌</label>
              <div className="col gap-8">
                {[
                  { v: "기업은행 *123", sub: "주거래" },
                  { v: "신한은행 *456", sub: "수금 전용" },
                  { v: "국민은행 *789", sub: "예비" },
                ].map(o => (
                  <button key={o.v} className="row gap-10" onClick={() => setForm({...form, account: o.v})}
                    style={{ padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 12, background: form.account === o.v ? "var(--surface-3)" : "#fff", textAlign: "left", cursor: "pointer" }}>
                    <Icon.Bank size={18}/>
                    <div>
                      <div className="fw-600">{o.v}</div>
                      <div className="text-xs text-muted2">{o.sub}</div>
                    </div>
                    {form.account === o.v && <Icon.Check size={18} className="ml-auto"/>}
                  </button>
                ))}
              </div>
            </FormBlock>
          )}

          {step === 6 && (
            <FormBlock title="증빙이 있나요?" hint="세금계산서, 통장사본 등을 첨부할 수 있어요.">
              <div className="drop">
                <Icon.Upload size={22}/>
                <div className="fw-600" style={{ marginTop: 8 }}>파일을 끌어다 놓거나 클릭해서 업로드</div>
                <div className="text-xs text-muted2" style={{ marginTop: 4 }}>PDF, JPG, PNG · 최대 20MB</div>
              </div>
              <div style={{ marginTop: 12 }}>
                <span className="file-pill"><Icon.File size={12}/> 세금계산서_{form.vendor}_{form.type}.pdf <span className="text-muted2">· 82KB</span></span>
              </div>
              <div className="card" style={{ marginTop: 18, padding: 16, background: "var(--surface-2)", border: "1px solid var(--line)" }}>
                <div className="fw-700 text-sm" style={{ marginBottom: 8 }}>입력 요약</div>
                <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "6px 16px", fontSize: 12.5 }}>
                  <span className="text-muted">거래처</span><span className="fw-600">{form.vendor}</span>
                  <span className="text-muted">계약</span><span className="fw-600">{form.contract}</span>
                  <span className="text-muted">입금 구분</span><span className="fw-600">{form.type}</span>
                  <span className="text-muted">입금 계좌</span><span className="fw-600">{form.account}</span>
                  <span className="text-muted">입금일</span><span className="fw-600">{form.date}</span>
                  <span className="text-muted">금액</span><span className="fw-700 num">{fmtNum(form.amount)}원</span>
                </div>
              </div>
            </FormBlock>
          )}
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={() => step > 1 ? setStep(step - 1) : onClose()}>{step > 1 ? "이전" : "취소"}</button>
          <div className="ml-auto row gap-8">
            <span className="text-xs text-muted2" style={{ alignSelf: "center" }}>
              <span className="num fw-700" style={{ color: "var(--ink)" }}>{step}</span> / {totalSteps}
            </span>
            {step < totalSteps
              ? <button className="btn primary" onClick={() => setStep(step + 1)}>다음 <Icon.Right size={14}/></button>
              : <button className="btn primary" onClick={() => { onClose(); toast.push("입금 내역이 등록되었어요"); }}><Icon.Check size={14}/> 등록 완료</button>}
          </div>
        </div>
      </aside>
    </>
  );
};

/* ============ 계약 목록 데이터 ============ */
export const CONTRACT_LIST = [
  { id: "CT-2026-101", name: "KF-21 동체 부품 가공",       vendor: "한화에어로스페이스", amount: 142000000, inDone: 113600000, remain:  28400000, out: 38500000, profit: 75100000, status: "진행중", period: "2026-01-15 ~ 2026-08-31", pm: "정수민" },
  { id: "CT-2026-088", name: "유도무기 정밀가공 부품",      vendor: "LIG넥스원",          amount:  96000000, inDone:  77400000, remain:  18600000, out: 28200000, profit: 49200000, status: "진행중", period: "2026-02-01 ~ 2026-07-31", pm: "정수민" },
  { id: "CT-2026-072", name: "K2 변속기 케이스 가공",       vendor: "현대로템",            amount:  48000000, inDone:  38800000, remain:   9200000, out: 12100000, profit: 26700000, status: "진행중", period: "2026-01-20 ~ 2026-06-30", pm: "이지원" },
  { id: "CT-2026-065", name: "헬기 외장 패널 가공",          vendor: "KAI",                amount:  22500000, inDone:  18000000, remain:   4500000, out:  6400000, profit: 11600000, status: "진행중", period: "2026-03-01 ~ 2026-06-30", pm: "이지원" },
  { id: "CT-2026-058", name: "레이더 하우징 가공",           vendor: "한화시스템",         amount:  18200000, inDone:  14400000, remain:   3800000, out:  4900000, profit:  9500000, status: "진행중", period: "2026-02-10 ~ 2026-07-15", pm: "정수민" },
  { id: "CT-2026-044", name: "탄피 황동 가공 시제품",        vendor: "풍산",                amount:   4000000, inDone:   2200000, remain:   1800000, out:   400000, profit:  1400000, status: "진행중", period: "2026-04-01 ~ 2026-06-30", pm: "이지원" },
  { id: "CT-2025-194", name: "함정 추진계 정밀가공",         vendor: "(주)대선기공",        amount:  62000000, inDone:  43800000, remain:  18200000, out: 21400000, profit: 18600000, status: "보류",   period: "2025-09-01 ~ 2026-04-30", pm: "정수민" },
  { id: "CT-2025-176", name: "기체 패스너 가공",             vendor: "(주)서울항공",        amount:  18600000, inDone:  10000000, remain:   8600000, out:  4200000, profit:  5800000, status: "완료",   period: "2025-08-01 ~ 2026-03-15", pm: "이지원" },
];

function synthesizeDetail(row) {
  const milestones = [];
  if (row.amount >= 12000000) {
    milestones.push({ date: row.period?.split(" ~ ")[0] || "2026-02-15", type: "계약금", amount: Math.round(row.amount * 0.3), status: "입금 완료", evid: true });
    milestones.push({ date: "2026-04-05", type: "중도금", amount: Math.round(row.amount * (row.inDone >= row.amount * 0.6 ? 0.3 : 0)), status: row.inDone >= row.amount * 0.6 ? "입금 완료" : "입금 예정", evid: row.inDone >= row.amount * 0.6 });
    milestones.push({ date: "2026-05-20", type: "잔금", amount: row.remain || Math.round(row.amount * 0.4), status: row.remain === 0 ? "입금 완료" : "입금 예정", evid: row.remain === 0 });
  } else {
    milestones.push({ date: row.period?.split(" ~ ")[0] || "2026-02-15", type: "계약금", amount: Math.round(row.amount * 0.5), status: "입금 완료", evid: true });
    milestones.push({ date: "2026-05-15", type: "잔금", amount: row.remain || Math.round(row.amount * 0.5), status: row.remain === 0 ? "입금 완료" : "입금 예정", evid: row.remain === 0 });
  }

  const expenses = [
    { date: "2026-03-12", vendor: "외주 OO",      category: "외주비", amount: Math.round(row.out * 0.4), doc: "승인 완료", pay: "지급 완료" },
    { date: "2026-04-22", vendor: "재료 공급사",  category: "재료비", amount: Math.round(row.out * 0.3), doc: "승인 완료", pay: "지급 완료" },
    { date: "2026-05-10", vendor: "프리랜서 박OO", category: "외주비", amount: Math.round(row.out * 0.3), doc: "승인 완료", pay: "지급 예정" },
  ].filter(e => e.amount > 0);

  return {
    name: row.name, vendor: row.vendor, code: row.id, period: row.period, pm: row.pm,
    status: row.status, amount: row.amount, inDone: row.inDone, remain: row.remain,
    out: row.out, profit: row.profit,
    incomes: milestones,
    expenses,
    docs: [
      { id: `EXP-${row.id.slice(-4)}-1`, title: `${expenses[0]?.category || "외주비"} — ${expenses[0]?.vendor || "OO"}`, date: expenses[0]?.date || "2026-04-01", amount: expenses[0]?.amount || 0, status: "승인 완료" },
    ],
    evidences: [
      { name: `세금계산서_${row.vendor}_계약금.pdf`, type: "세금계산서", size: "82KB", date: milestones[0].date },
      { name: `세금계산서_${row.vendor}_중도금.pdf`, type: "세금계산서", size: "78KB", date: "2026-04-05" },
    ],
    history: [
      { date: "2026-05-10", who: "한경리", what: "지출 내역 등록" },
      { date: milestones[0].date, who: row.pm, what: `계약금 ${fmtNum(milestones[0].amount)}원 입금 등록` },
      { date: row.period?.split(" ~ ")[0] || "2026-02-01", who: row.pm, what: "계약 등록" },
    ],
  };
}

export function getContractDetail(id) {
  const row = CONTRACT_LIST.find(c => c.id === id) || CONTRACT_LIST[0];
  if (row.id === "CT-2026-101" && SAMPLE.contractDetail) {
    return SAMPLE.contractDetail;
  }
  return synthesizeDetail(row);
}

/* ============ 미수금 관리 ============ */
export const ReceivablesScreen = () => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [tab, setTab] = useState("전체");
  const [filterOpen, setFilterOpen] = useState(false);
  const [period, setPeriod] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const tabs = ["전체", "청구 예정", "입금 예정", "일부 입금", "기한 지남", "장기 미수"];
  const { summary, rows } = SAMPLE.receivables;
  const filtered = rows.filter(r =>
    (tab === "전체" || r.status === tab) &&
    inPeriod(r.due, period, { from: customFrom, to: customTo })
  );

  const onProcessIncome = async (r) => {
    const ok = await confirm({
      tone: "brand", icon: <Icon.In size={22}/>,
      title: `${r.vendor} 입금을 처리할까요?`,
      body: `${r.contract}의 ${fmtNum(r.remain)}원을 입금 완료로 처리합니다.`,
      detail: "통장 입금이 확인된 경우에만 처리해주세요.",
      confirmLabel: "입금 처리",
    });
    if (ok) toast.push(`${r.vendor} 입금이 처리되었어요`);
  };

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 6 }}>
        <div>
          <div className="page-title">미수금 관리</div>
          <div className="page-sub">계약·청구 데이터에서 자동 집계된 미수금입니다. 행을 클릭해 입금 처리하세요.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={() => toast.push("청구서를 거래처에 발송했어요")}><Icon.Download/> 청구서 일괄 발행</button>
          <button className="btn" onClick={() => toast.push("미수금 내역을 엑셀로 내려받았어요")}><Icon.Excel/> 내보내기</button>
        </div>
      </div>
      <Spacer h={20}/>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        <BigSummaryCard label="전체 미수금"    amount={summary.total}       sub="총 6건"          accent="blue"/>
        <BigSummaryCard label="이번 달 미수금" amount={summary.thisMonth}   sub="3건"             accent="pos"/>
        <BigSummaryCard label="연체 미수금"    amount={summary.overdue}     sub="2건 · D+13~15"   accent="warn" warn/>
        <BigSummaryCard label="장기 미수"      amount={summary.longOverdue} sub="1건 · 82일 경과" accent="neg"  warn/>
      </div>
      <Spacer h={24}/>
      <div className="card">
        <div className="row gap-8" style={{ padding: "16px 16px", borderBottom: "1px solid var(--line)" }}>
          {tabs.map(t => (
            <button key={t} className={`chip ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
          ))}
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={() => setFilterOpen(s => !s)} style={{ position: "relative" }}>
              <Icon.Filter/> 필터
              {period !== "all" && <span style={{ position: "absolute", top: 6, right: 6, width: 6, height: 6, borderRadius: "50%", background: "var(--brand)" }}/>}
            </button>
          </div>
        </div>
        {filterOpen && (
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", background: "var(--surface-2)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="row gap-8" style={{ flexWrap: "wrap", alignItems: "center" }}>
              <span className="text-xs fw-600 text-muted" style={{ width: 36, flexShrink: 0 }}>기간</span>
              {PERIOD_PRESETS.map(p => (
                <button key={p.id} className={`chip ${period === p.id ? "active" : ""}`} onClick={() => setPeriod(p.id)}>{p.label}</button>
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
            {period !== "all" && (() => {
              const label = periodRangeLabel(period, { from: customFrom, to: customTo });
              return (
                <div className="row gap-10" style={{ alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                    <span className="fw-600" style={{ color: "var(--brand-ink)" }}>
                      {PERIOD_PRESETS.find(p => p.id === period)?.label}
                    </span>
                    {label && <span className="num" style={{ marginLeft: 6 }}>({label})</span>}
                  </span>
                  <button className="btn ghost sm" onClick={() => { setPeriod("all"); setCustomFrom(""); setCustomTo(""); }}>
                    <Icon.Close size={12}/> 초기화
                  </button>
                </div>
              );
            })()}
          </div>
        )}
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>거래처</th><th>계약명</th><th className="num-right">청구금액</th>
                <th className="num-right">입금 완료</th><th className="num-right">남은 금액</th>
                <th>예정일</th><th>지연일수</th><th>상태</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const pct = Math.round((r.paid / r.billed) * 100);
                return (
                  <tr key={i}>
                    <td className="fw-600">{r.vendor}</td>
                    <td className="text-muted">{r.contract}</td>
                    <td className="num-cell num-right">{fmtNum(r.billed)}</td>
                    <td className="num-cell num-right text-muted">{fmtNum(r.paid)}</td>
                    <td className="num-cell num-right fw-700">{fmtNum(r.remain)}</td>
                    <td className="num-cell text-sm">{r.due}</td>
                    <td>
                      {r.delay > 0
                        ? <span className={`badge ${r.delay > 60 ? "neg" : "warn"}`}>D+{r.delay}</span>
                        : <span className="text-muted2 text-xs">—</span>}
                    </td>
                    <td><StatusBadge status={r.status}/></td>
                    <td>
                      <div className="row gap-4">
                        <button className="btn primary sm" onClick={(e) => { e.stopPropagation(); onProcessIncome(r); }}>입금 처리</button>
                        <button className="btn sm" onClick={(e) => { e.stopPropagation(); toast.push(`${r.vendor}에 독촉 메일을 발송했어요`); }}>독촉</button>
                        <button className="btn ghost sm"><Icon.More/></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

/* ============ 미지급금 관리 ============ */
export const PayablesScreen = () => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [tab, setTab] = useState("전체");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterCat, setFilterCat] = useState(null);
  const tabs = ["전체", "지급 예정", "지급 대기", "기한 지남", "지급 완료"];
  const { summary, rows } = SAMPLE.payables;
  const categories = useMemo(() => [...new Set(rows.map(r => r.category))].sort(), [rows]);
  const filtered = rows.filter(r =>
    (tab === "전체" || r.pay === tab) &&
    (!filterCat || r.category === filterCat)
  );

  const onBulkTransfer = async () => {
    const ok = await confirm({
      tone: "neg", icon: <Icon.Bank size={22}/>,
      title: "선택 항목을 일괄 이체할까요?",
      body: "이체 실행 후에는 결재선 승인 없이 즉시 계좌에서 출금됩니다. 이 작업은 되돌릴 수 없어요.",
      detail: "선택 4건 · 합계 2,888,000원 · 기업은행 *123 출금",
      confirmLabel: "이체 실행",
    });
    if (ok) toast.push("선택 항목 4건을 일괄 이체했어요");
  };

  const onTransferOne = async (r) => {
    const ok = await confirm({
      tone: "neg", icon: <Icon.Bank size={22}/>,
      title: `${r.vendor}로 이체할까요?`,
      body: `${r.category} ${fmtNum(r.amount)}원이 기업은행 *123에서 출금됩니다.`,
      confirmLabel: "이체 실행",
    });
    if (ok) toast.push(`${r.vendor} 이체를 실행했어요`);
  };

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 6 }}>
        <div>
          <div className="page-title">미지급금 관리</div>
          <div className="page-sub">지출·결의서 데이터에서 자동 집계된 미지급금입니다. 행을 클릭해 이체 처리하세요.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={() => toast.push("이체 명세서를 내려받았어요")}><Icon.Download/> 이체 명세서</button>
          <button className="btn" onClick={() => toast.push("미지급금 내역을 엑셀로 내려받았어요")}><Icon.Excel/> 내보내기</button>
        </div>
      </div>
      <Spacer h={20}/>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        <BigSummaryCard label="전체 미지급금"     amount={summary.total}          sub="총 8건"        accent="warn"/>
        <BigSummaryCard label="이번 달 지급 예정" amount={summary.thisMonth}      sub="5건"           accent="blue"/>
        <BigSummaryCard label="지급 지연"         amount={summary.overdue}        sub="2건 · 평균 6일" accent="neg"  warn/>
        <BigSummaryCard label="승인 대기 지급"    amount={summary.pendingApproval} sub="2건"          accent="warn" warn/>
      </div>
      <Spacer h={24}/>
      <div className="card">
        <div className="row gap-8" style={{ padding: "16px 16px", borderBottom: "1px solid var(--line)" }}>
          {tabs.map(t => (
            <button key={t} className={`chip ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
          ))}
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={() => setFilterOpen(s => !s)} style={{ position: "relative" }}>
              <Icon.Filter/> 필터
              {filterCat && <span style={{ position: "absolute", top: 6, right: 6, width: 6, height: 6, borderRadius: "50%", background: "var(--brand)" }}/>}
            </button>
          </div>
        </div>
        {filterOpen && (
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", background: "var(--surface-2)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="row gap-8" style={{ alignItems: "center" }}>
              <span className="text-xs fw-600 text-muted" style={{ width: 36, flexShrink: 0 }}>비목</span>
              <FilterSelect value={filterCat} onChange={setFilterCat} options={categories} placeholder="전체"/>
            </div>
            {filterCat && (
              <div className="row gap-10" style={{ alignItems: "center" }}>
                <span style={{ fontSize: 12 }}>
                  <span className="fw-600" style={{ color: "var(--brand-ink)" }}>비목</span>
                  <span className="num" style={{ marginLeft: 6, color: "var(--muted)" }}>({filterCat})</span>
                </span>
                <button className="btn ghost sm" onClick={() => setFilterCat(null)}><Icon.Close size={12}/> 초기화</button>
              </div>
            )}
          </div>
        )}
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 36 }}><input type="checkbox"/></th>
                <th>거래처</th><th>계약/공통비</th><th>비목</th>
                <th className="num-right">지급 예정 금액</th><th>지급 예정일</th>
                <th>결의서</th><th>지급 상태</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={i}>
                  <td><input type="checkbox"/></td>
                  <td className="fw-600">{r.vendor}</td>
                  <td className="text-muted">{r.scope}</td>
                  <td><span className="badge outline">{r.category}</span></td>
                  <td className="num-cell num-right fw-700">{fmtNum(r.amount)}</td>
                  <td className="num-cell text-sm">{r.due}</td>
                  <td><StatusBadge status={r.doc}/></td>
                  <td><StatusBadge status={r.pay}/></td>
                  <td>
                    <div className="row gap-4">
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); onTransferOne(r); }}>이체 실행</button>
                      <button className="btn ghost sm"><Icon.More/></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ padding: "14px 18px", borderTop: "1px solid var(--line)" }}>
          <span className="text-sm text-muted">선택한 건을 한 번에 이체할 수 있어요.</span>
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={() => toast.push("선택 항목으로 결의서를 만들었어요")}>선택 항목 결의서 만들기</button>
            <button className="btn primary" onClick={onBulkTransfer}>선택 항목 일괄 이체</button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ============ 공통 카드 컴포넌트 ============ */
export const BigSummaryCard = ({ label, amount, sub, accent = "blue", warn = false }) => (
  <div className={`stat accent-${accent}`}>
    <div className="stat-label">{label}</div>
    <div className="stat-num num">{fmtNum(amount)}<span className="won">원</span></div>
    <div className="stat-foot">
      <span className={`badge ${warn ? (accent === "neg" ? "neg" : "warn") : "outline"}`}><span className="dot"/>{sub}</span>
    </div>
  </div>
);

export const SummaryTile = ({ label, amount, pct, tone, big = false }) => (
  <div className="card" style={{ padding: "18px 18px", display: "flex", flexDirection: "column", gap: 8, background: big ? "var(--ink)" : "#fff", color: big ? "#fff" : "var(--ink)", borderColor: big ? "var(--ink)" : "var(--line)" }}>
    <div style={{ fontSize: 12.5, fontWeight: 600, color: big ? "rgba(255,255,255,0.7)" : "var(--muted)" }}>{label}</div>
    <div className="num fw-700" style={{ fontSize: big ? 26 : 22, letterSpacing: "-0.02em" }}>
      {amount >= 0 ? "" : "-"}{fmtNum(Math.abs(amount))}<span style={{ fontSize: 13, fontWeight: 600, opacity: 0.65, marginLeft: 3 }}>원</span>
    </div>
    {pct != null && (
      <div className="text-xs" style={{ color: big ? "rgba(255,255,255,0.7)" : "var(--muted-2)" }}>전체의 {pct}%</div>
    )}
  </div>
);

/* ============ 계약 상세 ============ */
export const ContractScreen = ({ goList, contractId, openIncome, openExpense }) => {
  const toast = useToast();
  const [tab, setTab] = useState("입금 내역");
  const [memo, setMemo] = useState("");
  const c = useMemo(() => getContractDetail(contractId), [contractId]);
  const inPct = c.amount > 0 ? Math.round((c.inDone / c.amount) * 100) : 0;

  return (
    <div className="fade-up">
      <div className="row gap-12" style={{ alignItems: "center", color: "var(--muted)", fontSize: 12.5, marginBottom: 8 }}>
        <button className="btn ghost sm" onClick={goList} style={{ padding: "4px 8px" }}><Icon.Left size={14}/> 계약 목록</button>
        <span style={{ color: "var(--subtle)" }}>/</span>
        <span style={{ color: "var(--ink)", fontWeight: 600 }}>{c.name}</span>
      </div>
      <div className="row" style={{ alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <div className="row gap-10">
            <div className="page-title">{c.name}</div>
            <StatusBadge status={c.status}/>
          </div>
          <div className="page-sub">{c.vendor} · {c.code} · 계약기간 {c.period} · PM {c.pm}</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={() => toast.push("계약서 PDF를 열었어요")}><Icon.File/> 계약서 보기</button>
          <button className="btn" onClick={openIncome}><Icon.Plus/> 입금 등록</button>
          <button className="btn primary" onClick={openExpense}><Icon.Plus/> 지출 등록</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
        <SummaryTile label="계약금액"    amount={c.amount}/>
        <SummaryTile label="입금 완료"   amount={c.inDone}  pct={inPct} tone="pos"/>
        <SummaryTile label="남은 미수금" amount={c.remain}              tone="warn"/>
        <SummaryTile label="지출 합계"   amount={c.out}                 tone="neg"/>
        <SummaryTile label="예상 손익"   amount={c.profit}              tone="pos" big/>
      </div>
      <Spacer h={20}/>

      <div className="card card-pad">
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="section-title">계약 진행률</div>
          <div className="ml-auto text-sm text-muted">계약금액의 {inPct}% 입금됨 · 남은 미수금 <span className="num fw-700 text-ink" style={{ color: "var(--ink)" }}>{fmtNum(c.remain)}원</span></div>
        </div>
        <div style={{ display: "flex", height: 14, borderRadius: 999, overflow: "hidden", background: "var(--surface-3)" }}>
          <div style={{ width: `${inPct}%`, background: "var(--ink)" }}/>
          <div style={{ width: `${100-inPct}%`, background: "transparent", borderLeft: "1px dashed rgba(0,0,0,0.1)" }}/>
        </div>
        <div className="row" style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted-2)" }}>
          <div><span style={{ display: "inline-block", width: 8, height: 8, background: "var(--ink)", borderRadius: 2, marginRight: 6 }}/>입금 완료 {fmtNum(c.inDone)}원</div>
          <div className="ml-auto"><span style={{ display: "inline-block", width: 8, height: 8, background: "var(--surface-3)", border: "1px solid var(--line-strong)", borderRadius: 2, marginRight: 6 }}/>잔여 {fmtNum(c.remain)}원</div>
        </div>
      </div>
      <Spacer h={20}/>

      <div className="card">
        <div className="tab-bar" style={{ padding: "0 12px" }}>
          {["입금 내역", "지출 내역", "증빙", "결의서", "메모/히스토리"].map(t => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>

        {tab === "입금 내역" && (
          <table className="table">
            <thead><tr><th>입금일</th><th>구분</th><th className="num-right">금액</th><th>상태</th><th>증빙</th></tr></thead>
            <tbody>
              {c.incomes.map((r, i) => (
                <tr key={i}>
                  <td className="num-cell text-muted">{r.date}</td>
                  <td><span className="badge outline">{r.type}</span></td>
                  <td className="num-cell num-right fw-700">{fmtNum(r.amount)}</td>
                  <td><StatusBadge status={r.status}/></td>
                  <td>{r.evid ? <span className="badge pos"><Icon.Check size={11}/> 첨부</span> : <span className="badge neg"><Icon.Warn size={11}/> 누락</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === "지출 내역" && (
          <table className="table">
            <thead><tr><th>지출일</th><th>거래처</th><th>비목</th><th className="num-right">금액</th><th>결의서</th><th>지급</th></tr></thead>
            <tbody>
              {c.expenses.map((r, i) => (
                <tr key={i}>
                  <td className="num-cell text-muted">{r.date}</td>
                  <td className="fw-600">{r.vendor}</td>
                  <td><span className="badge outline">{r.category}</span></td>
                  <td className="num-cell num-right fw-700">{fmtNum(r.amount)}</td>
                  <td><StatusBadge status={r.doc}/></td>
                  <td><StatusBadge status={r.pay}/></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === "증빙" && (
          <div style={{ padding: 22 }}>
            <div className="grid" style={{ gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
              {c.evidences.map((e, i) => (
                <div key={i} className="row gap-12" style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14, background: "#fff" }}>
                  <div style={{ width: 40, height: 48, background: "var(--surface-3)", border: "1px solid var(--line)", borderRadius: 6, display: "grid", placeItems: "center" }}>
                    {e.name.endsWith(".pdf") ? <Icon.File size={20}/> : <Icon.Image size={20}/>}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="fw-600" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</div>
                    <div className="text-xs text-muted2">{e.type} · {e.size} · {e.date}</div>
                  </div>
                  <button className="btn ghost sm"><Icon.Eye/></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "결의서" && (
          <table className="table">
            <thead><tr><th>문서번호</th><th>제목</th><th>작성일</th><th className="num-right">금액</th><th>상태</th><th></th></tr></thead>
            <tbody>
              {c.docs.map((r, i) => (
                <tr key={i}>
                  <td className="num-cell">{r.id}</td>
                  <td className="fw-600">{r.title}</td>
                  <td className="text-muted">{r.date}</td>
                  <td className="num-cell num-right fw-700">{fmtNum(r.amount)}</td>
                  <td><StatusBadge status={r.status}/></td>
                  <td><button className="btn sm">미리보기</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === "메모/히스토리" && (
          <div style={{ padding: 22 }}>
            <div style={{ marginBottom: 24 }}>
              <label className="label">새 메모 추가</label>
              <textarea className="input" rows={3} value={memo} onChange={e => setMemo(e.target.value)}
                placeholder="계약에 관련된 메모를 자유롭게 적어주세요"
                style={{ resize: "vertical", fontFamily: "inherit" }}/>
              <div className="row" style={{ marginTop: 8 }}>
                <span className="text-xs text-muted2">메모는 계약 히스토리에 시간순으로 기록됩니다.</span>
                <button className="btn primary sm ml-auto" disabled={!memo.trim()}
                  style={{ opacity: memo.trim() ? 1 : 0.4 }}
                  onClick={() => { if (memo.trim()) { toast.push("메모가 기록되었어요"); setMemo(""); } }}>
                  <Icon.Pencil size={12}/> 메모 남기기
                </button>
              </div>
            </div>
            <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 12, letterSpacing: "0.02em" }}>변경 이력</div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {c.history.map((h, i) => (
                <li key={i} style={{ display: "flex", gap: 14, padding: "10px 0" }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--ink)", marginTop: 7, flexShrink: 0 }}/>
                  <div>
                    <div className="row gap-8">
                      <span className="fw-600 text-sm">{h.who}</span>
                      <span className="text-xs text-muted2">{h.date}</span>
                    </div>
                    <div className="text-sm text-muted">{h.what}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

/* ============ 계약 목록 ============ */
export const ContractListScreen = ({ goDetail }) => {
  const [tab, setTab] = useState("전체");
  const [q, setQ] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterPM, setFilterPM] = useState(null);
  const tabs = ["전체", "진행중", "보류", "완료"];
  const pms = useMemo(() => [...new Set(CONTRACT_LIST.map(c => c.pm))].sort(), []);
  const rows = CONTRACT_LIST
    .filter(r => tab === "전체" || r.status === tab)
    .filter(r => !q || r.name.includes(q) || r.vendor.includes(q))
    .filter(r => !filterPM || r.pm === filterPM);

  const totals = CONTRACT_LIST.reduce((a, c) => ({
    amount: a.amount + c.amount, inDone: a.inDone + c.inDone,
    remain: a.remain + c.remain, out: a.out + c.out,
  }), { amount: 0, inDone: 0, remain: 0, out: 0 });

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 8 }}>
        <div>
          <div className="page-title">계약 관리</div>
          <div className="page-sub">계약별 입금·지출·미수금을 한눈에 확인하세요.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn"><Icon.Download/> 내보내기</button>
          <button className="btn primary"><Icon.Plus/> 새 계약</button>
        </div>
      </div>
      <Spacer h={20}/>

      <div className="grid grid-4-to-2" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <MiniStat label="진행중 계약"   value={`${CONTRACT_LIST.filter(c => c.status === "진행중").length}건`} sub={`총 ${CONTRACT_LIST.length}건`} tone="ink"/>
        <MiniStat label="계약금액 합계" value={fmtNum(totals.amount) + "원"}  sub="진행 + 완료"                                             tone="brand"/>
        <MiniStat label="남은 미수금"   value={fmtNum(totals.remain) + "원"}  sub={`${CONTRACT_LIST.filter(c => c.remain > 0).length}건 잔존`} tone="warn"/>
        <MiniStat label="누적 지출"     value={fmtNum(totals.out) + "원"}     sub="모든 계약"                                               tone="neg"/>
      </div>
      <Spacer h={20}/>

      <div className="card">
        <div className="row gap-8" style={{ padding: "16px 16px", borderBottom: "1px solid var(--line)" }}>
          {tabs.map(t => (
            <button key={t} className={`chip ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
          ))}
          <div className="ml-auto row gap-8">
            <div className="search" style={{ margin: 0, width: 220, padding: "6px 10px" }}>
              <Icon.Search size={14}/>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="계약/거래처 검색"/>
            </div>
            <button className="btn" onClick={() => setFilterOpen(s => !s)} style={{ position: "relative" }}>
              <Icon.Filter/> 필터
              {filterPM && <span style={{ position: "absolute", top: 6, right: 6, width: 6, height: 6, borderRadius: "50%", background: "var(--brand)" }}/>}
            </button>
          </div>
        </div>
        {filterOpen && (
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", background: "var(--surface-2)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="row gap-8" style={{ flexWrap: "wrap", alignItems: "center" }}>
              <span className="text-xs fw-600 text-muted" style={{ width: 36, flexShrink: 0 }}>담당자</span>
              <button className={`chip ${!filterPM ? "active" : ""}`} onClick={() => setFilterPM(null)}>전체</button>
              {pms.map(pm => (
                <button key={pm} className={`chip ${filterPM === pm ? "active" : ""}`} onClick={() => setFilterPM(pm)}>{pm}</button>
              ))}
            </div>
            {filterPM && (
              <div><button className="btn ghost sm" onClick={() => setFilterPM(null)}><Icon.Close size={12}/> 필터 초기화</button></div>
            )}
          </div>
        )}
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: "30%" }}>계약</th><th>거래처</th>
                <th className="num-right">계약금액</th><th className="num-right">입금 완료</th>
                <th className="num-right">남은 미수금</th><th className="num-right">지출액</th>
                <th className="num-right">예상 손익</th><th>상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const pct = Math.round((r.inDone / r.amount) * 100);
                return (
                  <tr key={i} style={{ cursor: "pointer" }} onClick={() => goDetail(r.id)}>
                    <td>
                      <div className="fw-600">{r.name}</div>
                      <div className="row gap-8" style={{ marginTop: 8 }}>
                        <div className="bar-track" style={{ width: 140 }}>
                          <div className="bar-fill" style={{ width: `${pct}%` }}/>
                        </div>
                        <span className="text-xs text-muted2 num">{pct}%</span>
                        <span className="text-xs text-muted2">· {r.id}</span>
                      </div>
                    </td>
                    <td className="fw-600">{r.vendor}</td>
                    <td className="num-cell num-right">{fmtNum(r.amount)}</td>
                    <td className="num-cell num-right">{fmtNum(r.inDone)}</td>
                    <td className="num-cell num-right fw-700" style={{ color: r.remain > 0 ? "var(--warn-ink)" : "var(--muted-2)" }}>{r.remain > 0 ? fmtNum(r.remain) : "—"}</td>
                    <td className="num-cell num-right text-muted">{fmtNum(r.out)}</td>
                    <td className="num-cell num-right fw-700 text-pos">+{fmtNum(r.profit)}</td>
                    <td><StatusBadge status={r.status}/></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
