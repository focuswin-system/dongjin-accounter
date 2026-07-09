import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge, PERIOD_PRESETS, inPeriod, periodRangeLabel, FilterSelect, Drawer, Combobox } from '../lib/ui'
import { api } from '../lib/api'
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
  const stepLabels = ["거래처", "계약", "수금 유형", "금액", "입금일/계좌", "증빙"];

  useEffect(() => { if (open) setStep(1); }, [open]);

  return (
    <Drawer open={open} onClose={onClose} label="입금 등록">
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
                  <span className="text-muted">수금 유형</span><span className="fw-600">{form.type}</span>
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
    </Drawer>
  );
};

/* ============ 계약 목록 데이터 ============ */
export const CONTRACT_LIST = [
  { id: "CT-2026-101", name: "KF-21 동체 부품 가공",       vendor: "한화에어로스페이스", amount: 142000000, inDone: 113600000, remain:  28400000, out: 38500000, profit: 75100000, status: "진행중", period: "2026-01-15 ~ 2026-08-31", pm: "정수민",
    costBudget: { material: 20000000, outsource: 15000000, labor: 8000000, overhead: 3500000 },
    milestones: [
      { id: "ms-101-1", type: "선급금", ratio: 20, amount: 28400000, dueDate: "2026-01-30", status: "입금 완료", invoiceId: "INV-2026-050" },
      { id: "ms-101-2", type: "기성고", ratio: 30, amount: 42600000, dueDate: "2026-03-15", status: "입금 완료", invoiceId: "INV-2026-051" },
      { id: "ms-101-3", type: "기성고", ratio: 30, amount: 42600000, dueDate: "2026-04-20", status: "입금 완료", invoiceId: "INV-2026-052" },
      { id: "ms-101-4", type: "잔금",   ratio: 20, amount: 28400000, dueDate: "2026-05-20", status: "입금 예정", invoiceId: "INV-2026-001" },
    ],
  },
  { id: "CT-2026-088", name: "유도무기 정밀가공 부품",      vendor: "LIG넥스원",          amount:  96000000, inDone:  77400000, remain:  18600000, out: 28200000, profit: 49200000, status: "진행중", period: "2026-02-01 ~ 2026-07-31", pm: "정수민",
    costBudget: { material: 10000000, outsource: 14000000, labor: 6000000, overhead: 2000000 },
    milestones: [
      { id: "ms-088-1", type: "선급금", ratio: 20, amount: 19200000, dueDate: "2026-02-10", status: "입금 완료", invoiceId: null },
      { id: "ms-088-2", type: "기성고", ratio: 40, amount: 38400000, dueDate: "2026-04-15", status: "입금 완료", invoiceId: null },
      { id: "ms-088-3", type: "기성고", ratio: 20, amount: 19200000, dueDate: "2026-05-18", status: "일부 입금", invoiceId: "INV-2026-002" },
      { id: "ms-088-4", type: "잔금",   ratio: 20, amount: 19200000, dueDate: "2026-07-20", status: "예정",     invoiceId: null },
    ],
  },
  { id: "CT-2026-072", name: "K2 변속기 케이스 가공",       vendor: "현대로템",            amount:  48000000, inDone:  38800000, remain:   9200000, out: 12100000, profit: 26700000, status: "진행중", period: "2026-01-20 ~ 2026-06-30", pm: "이지원",
    costBudget: { material: 5000000, outsource: 4500000, labor: 2000000, overhead: 1000000 },
    milestones: [
      { id: "ms-072-1", type: "선급금", ratio: 30, amount: 14400000, dueDate: "2026-01-25", status: "입금 완료", invoiceId: null },
      { id: "ms-072-2", type: "기성고", ratio: 50, amount: 24000000, dueDate: "2026-04-10", status: "입금 완료", invoiceId: null },
      { id: "ms-072-3", type: "잔금",   ratio: 20, amount:  9200000, dueDate: "2026-05-27", status: "입금 완료", invoiceId: "INV-2026-003" },
    ],
  },
  { id: "CT-2026-065", name: "헬기 외장 패널 가공",          vendor: "KAI",                amount:  22500000, inDone:  18000000, remain:   4500000, out:  6400000, profit: 11600000, status: "진행중", period: "2026-03-01 ~ 2026-06-30", pm: "이지원",
    costBudget: { material: 2500000, outsource: 2500000, labor: 1000000, overhead: 500000 },
    milestones: [
      { id: "ms-065-1", type: "선급금", ratio: 40, amount:  9000000, dueDate: "2026-03-05", status: "입금 완료", invoiceId: null },
      { id: "ms-065-2", type: "중도금", ratio: 40, amount:  9000000, dueDate: "2026-05-01", status: "입금 완료", invoiceId: null },
      { id: "ms-065-3", type: "잔금",   ratio: 20, amount:  4500000, dueDate: "2026-05-30", status: "입금 예정", invoiceId: "INV-2026-004" },
    ],
  },
  { id: "CT-2026-058", name: "레이더 하우징 가공",           vendor: "한화시스템",         amount:  18200000, inDone:  14400000, remain:   3800000, out:  4900000, profit:  9500000, status: "진행중", period: "2026-02-10 ~ 2026-07-15", pm: "정수민",
    costBudget: { material: 1800000, outsource: 2000000, labor: 800000, overhead: 400000 },
    milestones: [
      { id: "ms-058-1", type: "선급금", ratio: 40, amount:  7280000, dueDate: "2026-02-15", status: "입금 완료", invoiceId: null },
      { id: "ms-058-2", type: "기성고", ratio: 40, amount:  7280000, dueDate: "2026-04-20", status: "입금 완료", invoiceId: null },
      { id: "ms-058-3", type: "잔금",   ratio: 20, amount:  3800000, dueDate: "2026-06-02", status: "입금 예정", invoiceId: "INV-2026-005" },
    ],
  },
  { id: "CT-2026-044", name: "탄피 황동 가공 시제품",        vendor: "풍산방산",            amount:   4000000, inDone:   2200000, remain:   1800000, out:   400000, profit:  1400000, status: "진행중", period: "2026-04-01 ~ 2026-06-30", pm: "이지원",
    costBudget: { material: 200000, outsource: 100000, labor: 80000, overhead: 20000 },
    milestones: [
      { id: "ms-044-1", type: "계약금", ratio: 50, amount: 2000000, dueDate: "2026-04-05", status: "일부 입금", invoiceId: null },
      { id: "ms-044-2", type: "잔금",   ratio: 50, amount: 2000000, dueDate: "2026-06-20", status: "예정",     invoiceId: null },
    ],
  },
  { id: "CT-2025-194", name: "함정 추진계 정밀가공",         vendor: "(주)대선기공",        amount:  62000000, inDone:  43800000, remain:  18200000, out: 21400000, profit: 18600000, status: "보류",   period: "2025-09-01 ~ 2026-04-30", pm: "정수민",
    costBudget: { material: 8000000, outsource: 9000000, labor: 3000000, overhead: 1500000 },
    milestones: [
      { id: "ms-194-1", type: "계약금", ratio: 30, amount: 18600000, dueDate: "2025-09-10", status: "입금 완료", invoiceId: null },
      { id: "ms-194-2", type: "기성고", ratio: 40, amount: 24800000, dueDate: "2026-01-15", status: "입금 완료", invoiceId: null },
      { id: "ms-194-3", type: "잔금",   ratio: 30, amount: 18600000, dueDate: "2026-04-30", status: "기한 지남", invoiceId: "INV-2026-007" },
    ],
  },
  { id: "CT-2025-176", name: "기체 패스너 가공",             vendor: "(주)서울항공",        amount:  18600000, inDone:  10000000, remain:   8600000, out:  4200000, profit:  5800000, status: "완료",   period: "2025-08-01 ~ 2026-03-15", pm: "이지원",
    costBudget: { material: 1500000, outsource: 1800000, labor: 700000, overhead: 300000 },
    milestones: [
      { id: "ms-176-1", type: "계약금", ratio: 50, amount:  9300000, dueDate: "2025-08-10", status: "입금 완료", invoiceId: null },
      { id: "ms-176-2", type: "잔금",   ratio: 50, amount:  9300000, dueDate: "2026-03-15", status: "기한 지남", invoiceId: "INV-2026-008" },
    ],
  },
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
    { date: "2026-03-12", vendor: "외주 OO",      category: "외주가공비", amount: Math.round(row.out * 0.4), doc: "승인 완료", pay: "지급 완료" },
    { date: "2026-04-22", vendor: "재료 공급사",  category: "재료비",    amount: Math.round(row.out * 0.3), doc: "승인 완료", pay: "지급 완료" },
    { date: "2026-05-10", vendor: "프리랜서 박OO", category: "외주가공비", amount: Math.round(row.out * 0.3), doc: "승인 완료", pay: "지급 예정" },
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
  const [summary, setSummary] = useState({ total: 0, thisMonth: 0, overdue: 0, longOverdue: 0, count: 0, thisMonthCount: 0, overdueCount: 0, longOverdueCount: 0 });
  const [rows, setRows] = useState([]);

  const load = async () => {
    const { summary: s, rows: r } = await api.getReceivables();
    setSummary(s); setRows(r);
  };
  useEffect(() => { load(); }, []);

  const filtered = rows.filter(r =>
    (tab === "전체" || r.status === tab) &&
    inPeriod(r.due, period, { from: customFrom, to: customTo })
  );

  const exportCsv = () => {
    if (filtered.length === 0) return toast.push("내보낼 내역이 없어요")
    downloadCsv(`미수금_${new Date().toISOString().slice(0, 10)}.csv`,
      ["거래처", "계약명", "청구금액", "입금완료", "남은금액", "예정일", "지연일수", "상태"],
      filtered.map(r => [r.vendor, r.contract, r.billed, r.paid, r.remain, r.due, r.delay > 0 ? `D+${r.delay}` : "", r.status]))
  }

  const onProcessIncome = async (r) => {
    const ok = await confirm({
      tone: "brand", icon: <Icon.In size={22}/>,
      title: `${r.vendor} 입금을 처리할까요?`,
      body: `${r.contract}의 ${fmtNum(r.remain)}원을 입금 완료로 처리합니다.`,
      detail: "통장 입금이 확인된 경우에만 처리해주세요.",
      confirmLabel: "입금 처리",
    });
    if (ok) {
      await api.matchInvoice(r.id, { txnId: `TXN-${Date.now()}`, amount: r.remain });
      toast.push(`${r.vendor} 입금이 처리되었어요`);
      load();
    }
  };

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 6 }}>
        <div>
          <div className="page-title">미수금 관리</div>
          <div className="page-sub">계약·청구 데이터에서 자동 집계된 미수금입니다. 행을 클릭해 입금 처리하세요.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={() => toast.push("청구서 자동 발송은 메일 연동 후 제공돼요 (준비 중)")}><Icon.Download/> 청구서 일괄 발행</button>
          <button className="btn" onClick={exportCsv}><Icon.Excel/> 내보내기</button>
        </div>
      </div>
      <Spacer h={20}/>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        <BigSummaryCard label="전체 미수금"    amount={summary.total}       sub={`총 ${summary.count}건`}                    accent="blue"/>
        <BigSummaryCard label="이번 달 미수금" amount={summary.thisMonth}   sub={`${summary.thisMonthCount}건`}               accent="pos"/>
        <BigSummaryCard label="연체 미수금"    amount={summary.overdue}     sub={`${summary.overdueCount}건`}                 accent="warn" warn/>
        <BigSummaryCard label="장기 미수"      amount={summary.longOverdue} sub={`${summary.longOverdueCount}건`}             accent="neg"  warn/>
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
                        <button className="btn sm" onClick={(e) => { e.stopPropagation(); toast.push("독촉 메일 발송은 준비 중이에요 (메일 연동 예정)"); }}>독촉</button>
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
  const [summary, setSummary] = useState({ total: 0, thisMonth: 0, overdue: 0, pendingApproval: 0, count: 0, overdueCount: 0, pendingCount: 0 });
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(new Set());

  const load = async () => {
    const { summary: s, rows: r } = await api.getPayables();
    setSummary(s); setRows(r); setSelected(new Set());
  };
  useEffect(() => { load(); }, []);

  const categories = useMemo(() => [...new Set(rows.map(r => r.category))].sort(), [rows]);
  const filtered = rows.filter(r =>
    (tab === "전체" || r.pay === tab) &&
    (!filterCat || r.category === filterCat)
  );

  const toggleOne = (id) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = filtered.length > 0 && filtered.every(r => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(filtered.map(r => r.id)));
  const exportCsv = () => {
    if (filtered.length === 0) return toast.push("내보낼 내역이 없어요");
    downloadCsv(`미지급금_${new Date().toISOString().slice(0, 10)}.csv`,
      ["거래처", "계약/공통비", "비목", "지급예정금액", "지급예정일", "결의서", "지급상태"],
      filtered.map(r => [r.vendor, r.scope, r.category, r.amount, r.due, r.doc, r.pay]));
  };

  const onBulkTransfer = async () => {
    const targets = filtered.filter(r => selected.has(r.id));
    if (targets.length === 0) return toast.push("이체할 항목을 선택하세요");
    const total = targets.reduce((s, r) => s + r.amount, 0);
    const ok = await confirm({
      tone: "neg", icon: <Icon.Bank size={22}/>,
      title: `선택한 ${targets.length}건을 일괄 이체할까요?`,
      body: "이체 실행 후에는 즉시 계좌에서 출금됩니다. 이 작업은 되돌릴 수 없어요.",
      detail: `합계 ${fmtNum(total)}원`,
      confirmLabel: "이체 실행",
    });
    if (!ok) return;
    for (const r of targets) {
      await api.matchInvoice(r.id, { txnId: `TXN-${Date.now()}`, amount: r.amount });
    }
    toast.push(`${targets.length}건 이체를 실행했어요`);
    load();
  };

  const onTransferOne = async (r) => {
    const ok = await confirm({
      tone: "neg", icon: <Icon.Bank size={22}/>,
      title: `${r.vendor}로 이체할까요?`,
      body: `${r.category} ${fmtNum(r.amount)}원이 기업은행(주거래) *4010에서 출금됩니다.`,
      confirmLabel: "이체 실행",
    });
    if (ok) {
      await api.matchInvoice(r.id, { txnId: `TXN-${Date.now()}`, amount: r.amount });
      toast.push(`${r.vendor} 이체를 실행했어요`);
      load();
    }
  };

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 6 }}>
        <div>
          <div className="page-title">미지급금 관리</div>
          <div className="page-sub">지출·결의서 데이터에서 자동 집계된 미지급금입니다. 행을 클릭해 이체 처리하세요.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={exportCsv}><Icon.Download/> 이체 명세서</button>
          <button className="btn" onClick={exportCsv}><Icon.Excel/> 내보내기</button>
        </div>
      </div>
      <Spacer h={20}/>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        <BigSummaryCard label="전체 미지급금"     amount={summary.total}           sub={`총 ${summary.count}건`}         accent="warn"/>
        <BigSummaryCard label="이번 달 지급 예정" amount={summary.thisMonth}       sub={`${summary.thisMonthCount}건`}    accent="blue"/>
        <BigSummaryCard label="지급 지연"         amount={summary.overdue}         sub={`${summary.overdueCount}건`}     accent="neg"  warn/>
        <BigSummaryCard label="승인 대기 지급"    amount={summary.pendingApproval} sub={`${summary.pendingCount}건`}     accent="warn" warn/>
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
                <th style={{ width: 36 }}><input type="checkbox" checked={allSelected} onChange={toggleAll}/></th>
                <th>거래처</th><th>계약/공통비</th><th>비목</th>
                <th className="num-right">지급 예정 금액</th><th>지급 예정일</th>
                <th>결의서</th><th>지급 상태</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={i}>
                  <td><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleOne(r.id)}/></td>
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
            <button className="btn" onClick={() => toast.push("선택 항목 결의서 생성은 준비 중이에요")}>선택 항목 결의서 만들기</button>
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

/* ============ CSV 내보내기 헬퍼 ============ */
const downloadCsv = (filename, headers, rows) => {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\r\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

/* ============ 청구 일정 편집 Drawer ============ */
const MS_TYPES = ["정기", "일시", "계약금", "중도금", "잔금"]
const MS_STATUSES = ["예정", "입금 예정", "일부 입금", "입금 완료", "지급 예정", "지급 완료", "기한 지남"]

function MilestoneEditDrawer({ open, onClose, contractId, initial, onSaved }) {
  const toast = useToast()
  const [rows, setRows] = useState([])
  useEffect(() => {
    if (open) setRows((initial || []).map(m => ({
      type: m.type || '정기', ratio: m.ratio ?? '', amount: m.amount ?? '',
      due_date: m.due_date || '', status: m.status || '예정', invoice_id: m.invoice_id || null,
    })))
  }, [open, initial])

  const addRow = () => setRows(r => [...r, { type: '정기', ratio: '', amount: '', due_date: '', status: '예정', invoice_id: null }])
  const upd = (i, k, v) => setRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row))
  const del = (i) => setRows(r => r.filter((_, idx) => idx !== i))

  const save = async () => {
    const payload = rows.map(m => ({
      type: m.type,
      ratio: parseInt(String(m.ratio).replace(/[^0-9]/g, '')) || 0,
      amount: parseInt(String(m.amount).replace(/[^0-9]/g, '')) || 0,
      due_date: m.due_date || null,
      status: m.status,
      invoice_id: m.invoice_id || null,   // 발행된 청구서 연결 보존(재저장 시 유실 방지)
    }))
    const res = await api.addMilestones(contractId, payload)
    if (!res.ok) return toast.push('저장 실패')
    toast.push('청구 일정이 저장됐어요')
    onSaved(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} width="min(620px,100vw)" label="청구 일정 편집">
      <div className="drawer-head">
        <div className="fw-700" style={{ fontSize: 16 }}>청구 일정 편집</div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>
      <div className="drawer-body col" style={{ gap: 12 }}>
        {rows.length === 0 && <div className="text-sm text-muted2" style={{ padding: '8px 0' }}>아직 청구 일정이 없어요. 아래에서 추가하세요.</div>}
        {rows.map((m, i) => {
          // 이미 청구서로 발행된 회차는 수정 불가(청구서와 금액이 어긋나지 않도록)
          const locked = !!m.invoice_id
          if (locked) return (
            <div key={i} className="card" style={{ padding: 12, border: '1px solid var(--brand-soft)', background: 'var(--surface-2)' }}>
              <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="badge outline">{m.type}</span>
                <span className="num fw-700">{fmtNum(m.amount)}</span>
                <span className="text-sm text-muted">{m.due_date || '—'}</span>
                <StatusBadge status={m.status}/>
                <span className="badge brand ml-auto" style={{ fontSize: 10 }}>발행됨 · 수정 불가</span>
              </div>
            </div>
          )
          return (
          <div key={i} className="card" style={{ padding: 12, border: '1px solid var(--line)' }}>
            <div className="row gap-8" style={{ marginBottom: 8, alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <Combobox value={m.type} onChange={v => upd(i, 'type', v)} allowAdd={false}
                  options={MS_TYPES.map(t => ({ value: t, label: t }))} placeholder="유형"/>
              </div>
              <div style={{ flex: 1 }}>
                <Combobox value={m.status} onChange={v => upd(i, 'status', v)} allowAdd={false}
                  options={MS_STATUSES.map(s => ({ value: s, label: s }))} placeholder="상태"/>
              </div>
              <button className="icon-btn" onClick={() => del(i)} title="삭제" style={{ flexShrink: 0 }}><Icon.Close size={14}/></button>
            </div>
            <div className="row gap-8">
              <input className="input num" style={{ flex: 1 }} placeholder="비율 %" value={m.ratio} onChange={e => upd(i, 'ratio', e.target.value)}/>
              <input className="input num" style={{ flex: 2 }} placeholder="금액" value={m.amount} onChange={e => upd(i, 'amount', e.target.value)}/>
              <input className="input" type="date" style={{ flex: 2 }} value={m.due_date} onChange={e => upd(i, 'due_date', e.target.value)}/>
            </div>
          </div>
          )
        })}
        <button className="btn" onClick={addRow}><Icon.Plus size={13}/> 청구 일정 추가</button>
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" onClick={save}><Icon.Check size={14}/> 저장</button>
      </div>
    </Drawer>
  )
}

/* ============ 원가 예산 수정 Drawer ============ */
function BudgetEditDrawer({ open, onClose, contractId, initial, onSaved }) {
  const toast = useToast()
  const [b, setB] = useState({ material: '', outsource: '', labor: '', overhead: '' })
  useEffect(() => {
    if (open) setB({
      material: initial?.material ?? '', outsource: initial?.outsource ?? '',
      labor: initial?.labor ?? '', overhead: initial?.overhead ?? '',
    })
  }, [open, initial])

  const FIELDS = [['material', '재료비'], ['outsource', '외주가공비'], ['labor', '인건비'], ['overhead', '경비']]
  const num = v => parseInt(String(v).replace(/[^0-9]/g, '')) || 0

  const save = async () => {
    const res = await api.updateCostBudget(contractId, {
      material: num(b.material), outsource: num(b.outsource), labor: num(b.labor), overhead: num(b.overhead),
    })
    if (!res.ok) return toast.push('저장 실패')
    toast.push('예산이 저장됐어요')
    onSaved(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} width="min(440px,100vw)" label="원가 예산 수정">
      <div className="drawer-head">
        <div className="fw-700" style={{ fontSize: 16 }}>원가 예산 수정</div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>
      <div className="drawer-body col" style={{ gap: 16 }}>
        {FIELDS.map(([k, label]) => (
          <div key={k}>
            <label className="label" style={{ marginBottom: 8 }}>{label}</label>
            <input className="input num" value={b[k]} onChange={e => setB(p => ({ ...p, [k]: e.target.value }))} placeholder="0"/>
          </div>
        ))}
        <div className="text-xs text-muted2">실적은 거래내역(지급 완료)에서 자동 집계돼요.</div>
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" onClick={save}><Icon.Check size={14}/> 저장</button>
      </div>
    </Drawer>
  )
}

/* ============ 계약 상세 ============ */
export const ContractScreen = ({ goList, contractId, openIncome, openExpense, refreshTrigger }) => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [tab, setTab] = useState("청구 일정");
  const [memo, setMemo] = useState("");
  const [c, setC] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [vendors, setVendors] = useState([]);
  const [msOpen, setMsOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);

  const reload = () => api.getContract(contractId).then(data => { if (data) setC(data); });

  useEffect(() => {
    if (!contractId) return;
    reload();
    api.getVendors().then(setVendors);
  }, [contractId]);

  // 계약 상세에서 입금/지출 등록 시 자동 갱신
  useEffect(() => { if (refreshTrigger > 0 && contractId) reload(); }, [refreshTrigger]);

  // 청구 일정 → 발행 청구서(미수금) 발행
  const issueInvoiceForMilestone = async (ms) => {
    if (!c) return;
    const supply = ms.amount || 0;
    const vat = Math.round(supply * 0.1);
    const ok = await confirm({
      tone: "brand", icon: <Icon.Receipt size={22}/>,
      title: `${ms.type} 청구서 발행`,
      body: `${c.vendor_name || c.vendor || "거래처"} · ${ms.type} ${fmtNum(supply + vat)}원(VAT 포함) 청구서를 발행해요. 대금 청구에 등록됩니다.`,
      confirmLabel: "청구서 발행",
    });
    if (!ok) return;
    // 원자적 발행(청구서+일정 상태·연결). 거래처 gubu로 매출/매입 자동 판별.
    const res = await api.issueSchedule(ms.id, { paid: false });
    if (!res.ok) { toast.push(res.error || "청구서 발행에 실패했어요"); return; }
    toast.push(`${ms.type} 청구서를 발행했어요`);
    reload();
  };

  const openEdit = () => {
    if (!c) return;
    setEditForm({
      vendor:      c.vendor_name || '',
      contract_no: c.contract_no || '',
      name:        c.name || '',
      amount:      String(c.amount || ''),
      start_date:  c.start_date || '',
      end_date:    c.end_date   || '',
      status:      c.status     || '진행중',
      file_url:    c.file_url   || '',
      file_name:   c.file_name  || '',
    });
    setEditOpen(true);
  };

  const handleEditSave = async () => {
    const vendorObj = vendors.find(v => v.name === editForm.vendor);
    const amount = parseInt(String(editForm.amount).replace(/[^0-9]/g, ''), 10) || 0;
    const res = await api.updateContract(contractId, {
      vendor_id:   vendorObj?.id || c.vendor_id || null,
      contract_no: editForm.contract_no?.trim() || null,
      name:        editForm.name,
      amount,
      start_date:  editForm.start_date || null,
      end_date:    editForm.end_date   || null,
      status:      editForm.status,
      file_url:    editForm.file_url  || null,
      file_name:   editForm.file_name || null,
    });
    if (res.ok) { toast.push("수정됐어요"); setEditOpen(false); reload(); }
    else toast.push(res.error || "저장 실패");
  };

  if (!c) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted-2)" }}>불러오는 중...</div>;

  const inDone  = c.in_done  || 0;
  const remain  = c.remain   || 0;
  const out     = c.out      || 0;
  const profit  = c.profit   || 0;
  // 매입 계약(gubu A/E)이면 '지급' 관점, 매출이면 '수금' 관점
  const isPurchase = c.vendor_gubu === 'A' || c.vendor_gubu === 'E';
  // 입/출금은 VAT 포함 총액 → 진행률도 총액(공급가×1.1) 기준. 100% 초과 방지
  const contractTotal = Math.round((c.amount || 0) * 1.1);
  const done      = isPurchase ? out : inDone;              // 매출=수금 완료, 매입=지급 완료
  const remainAmt = Math.max(0, contractTotal - done);
  const donePct   = contractTotal > 0 ? Math.min(100, Math.round((done / contractTotal) * 100)) : 0;
  const doneLabel = isPurchase ? '지급' : '입금';
  const remainLabel = isPurchase ? '남은 미지급' : '남은 미수금';
  const vendor  = c.vendor_name || c.vendor || '—';
  const period  = [c.start_date, c.end_date].filter(Boolean).join(' ~ ') || '—';

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
          <div className="page-sub">{vendor} · 계약기간 {period}{c.contract_no ? ` · 계약번호 ${c.contract_no}` : ''}</div>
        </div>
        <div className="ml-auto row gap-8">
          {c.file_url
            ? <a className="btn" href={c.file_url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><Icon.File size={14}/> 계약서 보기</a>
            : null}
          <button className="btn" onClick={openEdit}><Icon.Pencil size={14}/> 편집</button>
          <button className="btn" onClick={() => openIncome(c.name, vendor)}><Icon.Plus/> 입금 등록</button>
          <button className="btn primary" onClick={() => openExpense(c.name, vendor)}><Icon.Plus/> 지출 등록</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
        <SummaryTile label="계약금액"        amount={c.amount}/>
        <SummaryTile label={`${doneLabel} 완료`} amount={done}   pct={donePct} tone="pos"/>
        <SummaryTile label={remainLabel}      amount={remainAmt}            tone="warn"/>
        <SummaryTile label={isPurchase ? "입금 합계" : "지출 합계"} amount={isPurchase ? inDone : out} tone="neg"/>
        <SummaryTile label="예상 손익"        amount={profit}               tone="pos" big/>
      </div>
      <Spacer h={20}/>

      <div className="card card-pad">
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="section-title">계약 진행률</div>
          <div className="ml-auto text-sm text-muted">계약금액의 {donePct}% {doneLabel}됨 · {remainLabel} <span className="num fw-700 text-ink" style={{ color: "var(--ink)" }}>{fmtNum(remainAmt)}원</span></div>
        </div>
        <div style={{ display: "flex", height: 14, borderRadius: 999, overflow: "hidden", background: "var(--surface-3)" }}>
          <div style={{ width: `${donePct}%`, background: "var(--ink)" }}/>
          <div style={{ width: `${100-donePct}%`, background: "transparent", borderLeft: "1px dashed rgba(0,0,0,0.1)" }}/>
        </div>
        <div className="row" style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted-2)" }}>
          <div><span style={{ display: "inline-block", width: 8, height: 8, background: "var(--ink)", borderRadius: 2, marginRight: 6 }}/>{doneLabel} 완료 {fmtNum(done)}원</div>
          <div className="ml-auto"><span style={{ display: "inline-block", width: 8, height: 8, background: "var(--surface-3)", border: "1px solid var(--line-strong)", borderRadius: 2, marginRight: 6 }}/>잔여 {fmtNum(remainAmt)}원</div>
        </div>
      </div>
      <Spacer h={20}/>

      <div className="card">
        <div className="tab-bar" style={{ padding: "0 12px" }}>
          {["청구 일정", "원가 예산", "입금 내역", "지출 내역", "증빙", "결의서", "메모/히스토리"].map(t => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>

        {tab === "청구 일정" && (() => {
          const milestones = c.milestones || []
          const DONE = isPurchase ? "지급 완료" : "입금 완료"
          const collectLabel = isPurchase ? "지급" : "수금"
          const msSum = milestones.reduce((s, m) => s + (Number(m.amount) || 0), 0)
          const diff = msSum - (Number(c.amount) || 0)
          const doneSum = milestones.filter(m => m.status === DONE).reduce((s, m) => s + Number(m.amount || 0), 0)
          const remainSum = milestones.filter(m => m.status !== DONE).reduce((s, m) => s + Number(m.amount || 0), 0)
          return (
            <div style={{ padding: 20 }}>
              <div className="row" style={{ marginBottom: 14 }}>
                <div className="text-sm text-muted">이 계약에서 청구할 금액·시점을 미리 등록하세요. '청구서 발행'을 누르면 대금 청구로 넘어가요.</div>
                <button className="btn ml-auto" onClick={() => setMsOpen(true)}><Icon.Pencil size={13}/> 편집</button>
              </div>
              {milestones.length > 0 && Math.abs(diff) > 1 && (
                <div className="alert-row" style={{ marginBottom: 12, background: "var(--warn-soft)", borderColor: "transparent" }}>
                  <Icon.Warn/>
                  <div>
                    <div className="lead">청구 일정 합계가 계약금액(공급가)보다 {diff > 0 ? "많아요" : "적어요"}.</div>
                    <div className="body">일정 합계 {fmtNum(msSum)}원 · 계약금액 {fmtNum(c.amount)}원 (차이 {fmtNum(Math.abs(diff))}원)</div>
                  </div>
                </div>
              )}
              <div className="card" style={{ overflow: "hidden" }}>
                <table className="table">
                  <thead><tr><th>유형</th><th className="num-right">비율</th><th className="num-right">금액</th><th>예정일</th><th>상태</th><th></th></tr></thead>
                  <tbody>
                    {milestones.map((ms, i) => (
                      <tr key={i}>
                        <td><span className="badge outline">{ms.type}</span></td>
                        <td className="num-right text-muted">{ms.ratio ? `${ms.ratio}%` : "—"}</td>
                        <td className="num-cell num-right fw-700">{fmtNum(ms.amount)}</td>
                        <td className="text-sm">{ms.due_date}</td>
                        <td><StatusBadge status={ms.status}/></td>
                        <td>
                          {ms.status === "예정"
                            ? <button className="btn" style={{ fontSize: 11, padding: "3px 10px" }} onClick={() => issueInvoiceForMilestone(ms)}><Icon.Plus size={11}/> 청구서 발행</button>
                            : (ms.status === "입금 완료" || ms.status === "지급 완료")
                              ? <span className="text-muted text-xs">완료</span>
                              : <span className="text-muted text-xs">청구됨</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ marginTop: 14, padding: "10px 14px", background: "var(--surface-2)", borderRadius: 10, fontSize: 13 }}>
                <span className="text-muted">{collectLabel} 완료</span>
                <span className="num fw-700 ml-auto">{fmtNum(doneSum)}</span>
                <span className="text-muted" style={{ marginLeft: 16 }}>남은 {collectLabel} 예정</span>
                <span className="num fw-700 ml-auto" style={{ color: "var(--warn-ink)" }}>{fmtNum(remainSum)}</span>
              </div>
            </div>
          )
        })()}

        {tab === "원가 예산" && (() => {
          const budget = c.cost_budget || {}
          const actual = c.cost_actual || {}
          const LABELS = { material: "재료비", outsource: "외주가공비", labor: "인건비", overhead: "경비" }
          const totalBudget = Object.values(budget).reduce((s, v) => s + (Number(v) || 0), 0)
          const totalActual = Object.values(actual).reduce((s, v) => s + (Number(v) || 0), 0)
          const targetRate  = c.amount > 0 ? ((totalBudget / c.amount) * 100).toFixed(1) : 0
          const actualRate  = c.amount > 0 ? ((totalActual / c.amount) * 100).toFixed(1) : 0

          return (
            <div style={{ padding: 20 }}>
              <div className="row" style={{ marginBottom: 14 }}>
                <div className="text-sm text-muted">참고용 예상 원가예요. 인건비·자재비는 인사급여·매입계약에서 별도 관리돼요.</div>
                <button className="btn ml-auto" onClick={() => setBudgetOpen(true)}><Icon.Pencil size={13}/> 예산 수정</button>
              </div>
              <div className="card" style={{ overflow: "hidden", marginBottom: 14 }}>
                <table className="table">
                  <thead><tr><th>항목</th><th className="num-right">예산</th><th className="num-right">실적</th><th className="num-right" style={{ width: 70 }}>달성율</th><th style={{ width: 80 }}>상태</th></tr></thead>
                  <tbody>
                    {Object.entries(LABELS).map(([key, label]) => {
                      const b = budget[key] || 0
                      const a = actual[key] || 0
                      const pct = b > 0 ? Math.round((a / b) * 100) : 0
                      const noActual = b > 0 && a === 0   // 실적 미집계(인건비·자재비는 별도 관리)
                      const tone = noActual ? "outline" : pct >= 100 ? "neg" : pct >= 80 ? "warn" : "pos"
                      return (
                        <tr key={key}>
                          <td className="fw-600">{label}</td>
                          <td className="num-cell num-right">{fmtNum(b)}</td>
                          <td className="num-cell num-right">{noActual ? "—" : fmtNum(a)}</td>
                          <td className="num-right"><span className={`badge ${tone}`}>{noActual ? "미집계" : `${pct}%`}</span></td>
                          <td className="text-sm text-muted">{noActual ? "실적 미집계" : pct >= 100 ? "🔴 초과" : pct >= 80 ? "⚠️ 임박" : "정상"}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                {[
                  { label: "예산 합계",   value: fmtNum(totalBudget), sub: `목표 원가율 ${targetRate}%` },
                  { label: "실적 합계",   value: fmtNum(totalActual), sub: `실제 원가율 ${actualRate}%`, tone: totalActual > totalBudget ? "neg" : "pos" },
                  { label: "예상 이익",   value: fmtNum(c.amount - totalActual), sub: `계약금액 ${fmtNum(c.amount)}원 기준` },
                ].map(s => (
                  <div key={s.label} className="card" style={{ padding: "14px 16px" }}>
                    <div className="text-sm text-muted" style={{ marginBottom: 6 }}>{s.label}</div>
                    <div className="num fw-700" style={{ fontSize: 18, color: s.tone === "neg" ? "var(--neg-ink)" : s.tone === "pos" ? "var(--pos)" : undefined }}>{s.value}</div>
                    <div className="text-xs text-muted" style={{ marginTop: 4 }}>{s.sub}</div>
                  </div>
                ))}
              </div>
            </div>
          )
        })()}

        {tab === "입금 내역" && (
          <table className="table">
            <thead><tr><th>입금일</th><th>구분</th><th className="num-right">금액</th><th>상태</th><th>증빙</th></tr></thead>
            <tbody>
              {(c.incomes || []).length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: "center", padding: 40, color: "var(--muted-2)", fontSize: 13 }}>등록된 입금 내역이 없어요.</td></tr>
              )}
              {(c.incomes || []).map((r, i) => (
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
              {(c.expenses || []).length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: "center", padding: 40, color: "var(--muted-2)", fontSize: 13 }}>등록된 지출 내역이 없어요.</td></tr>
              )}
              {(c.expenses || []).map((r, i) => (
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

        {tab === "증빙" && (() => {
          const ACCEPT = ".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.hwp";
          const attachments = c.attachments || [];
          const attach = async (file, docType) => {
            if (!file) return;
            const up = await api.uploadFile(file);
            if (!up?.url) { toast.push("업로드에 실패했어요"); return; }
            const res = await api.addContractDoc(c.id, { url: up.url, name: up.originalName || file.name, doc_type: docType || '기타', size: up.size || 0 });
            if (res.ok) { toast.push("첨부됐어요"); reload(); }
            else toast.push("첨부에 실패했어요");
          };
          const remove = async (d) => {
            const res = d.id ? await api.deleteContractDoc(d.id) : await api.clearContractFile(c.id);
            if (res.ok) { toast.push("삭제됐어요"); reload(); }
            else toast.push("삭제에 실패했어요");
          };
          return (
          <div style={{ padding: 22 }} className="col gap-10">
            {attachments.length === 0 && (
              <div style={{ textAlign: "center", padding: 24, color: "var(--muted-2)", fontSize: 13 }}>등록된 계약 첨부가 없어요. 아래에서 추가하세요.</div>
            )}
            {attachments.map((d, i) => (
              <div key={d.id || i} className="row gap-12" style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14, background: "#fff" }}>
                <div style={{ width: 40, height: 48, background: "var(--surface-3)", border: "1px solid var(--line)", borderRadius: 6, display: "grid", placeItems: "center" }}>
                  {(d.name || '').toLowerCase().endsWith(".pdf") ? <Icon.File size={20}/> : <Icon.Image size={20}/>}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="fw-600" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</div>
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
              <div className="fw-600" style={{ marginTop: 8 }}>계약서·증빙을 끌어다 놓거나 클릭해서 추가</div>
              <div className="text-xs text-muted2" style={{ marginTop: 4 }}>여러 개 첨부 가능 · PDF, JPG, PNG · 최대 20MB</div>
              <input type="file" style={{ display: "none" }} accept={ACCEPT} onChange={e => attach(e.target.files[0])}/>
            </label>
          </div>
          );
        })()}

        {tab === "결의서" && (
          <table className="table">
            <thead><tr><th>문서번호</th><th>제목</th><th>작성일</th><th className="num-right">금액</th><th>상태</th><th></th></tr></thead>
            <tbody>
              {(c.docs || []).length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: "center", padding: 40, color: "var(--muted-2)", fontSize: 13 }}>등록된 결의서가 없어요.</td></tr>
              )}
              {(c.docs || []).map((r, i) => (
                <tr key={i}>
                  <td className="num-cell">{r.id}</td>
                  <td className="fw-600">{r.title}</td>
                  <td className="text-muted">{r.date}</td>
                  <td className="num-cell num-right fw-700">{fmtNum(r.amount)}</td>
                  <td><StatusBadge status={r.status}/></td>
                  <td></td>
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
                  onClick={() => toast.push("계약 메모 저장은 준비 중이에요")}>
                  <Icon.Pencil size={12}/> 메모 남기기
                </button>
              </div>
            </div>
            <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 12, letterSpacing: "0.02em" }}>변경 이력</div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {(c.history || []).map((h, i) => (
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

      {/* 편집 Drawer */}
      <Drawer open={editOpen} onClose={() => setEditOpen(false)} width="min(480px,100vw)" label="계약 편집">
        <div className="drawer-body">
          <div className="col gap-16">
            <div>
              <label className="label" style={{ marginBottom: 8 }}>거래처</label>
              <Combobox value={editForm.vendor} onChange={v => setEditForm(f => ({ ...f, vendor: v }))}
                options={vendors.map(v => ({ value: v.name, label: v.name }))} placeholder="거래처 선택"/>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계약명 *</label>
              <input className="input" value={editForm.name || ''} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}/>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계약번호 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
              <input className="input" value={editForm.contract_no || ''} onChange={e => setEditForm(f => ({ ...f, contract_no: e.target.value }))} placeholder="예: CT-2026-001"/>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계약금액 (공급가액)</label>
              <div style={{ position: 'relative' }}>
                <input className="input num fw-700" style={{ fontSize: 20, paddingRight: 36 }}
                  value={editForm.amount ? Number(String(editForm.amount).replace(/[^0-9]/g, '')).toLocaleString() : ''}
                  onChange={e => setEditForm(f => ({ ...f, amount: e.target.value.replace(/[^0-9]/g, '') }))}/>
                <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>원</span>
              </div>
            </div>
            <div className="row gap-12">
              <div style={{ flex: 1 }}>
                <label className="label" style={{ marginBottom: 8 }}>시작일</label>
                <input className="input" type="date" value={editForm.start_date || ''} onChange={e => setEditForm(f => ({ ...f, start_date: e.target.value }))}/>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label" style={{ marginBottom: 8 }}>종료일</label>
                <input className="input" type="date" value={editForm.end_date || ''} onChange={e => setEditForm(f => ({ ...f, end_date: e.target.value }))}/>
              </div>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>상태</label>
              <div className="row gap-6">
                {['진행중','보류','완료'].map(s => (
                  <button key={s} type="button" className={`chip ${editForm.status === s ? 'active' : ''}`} onClick={() => setEditForm(f => ({ ...f, status: s }))}>{s}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계약서 파일</label>
              {editForm.file_url ? (
                <div className="row gap-10" style={{ padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-2)' }}>
                  <Icon.File size={15} style={{ color: 'var(--brand)', flexShrink: 0 }}/>
                  <span className="text-sm fw-600" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{editForm.file_name}</span>
                  <a className="btn ghost sm" href={editForm.file_url} target="_blank" rel="noreferrer"><Icon.Eye size={13}/></a>
                  <button type="button" className="icon-btn" onClick={() => setEditForm(f => ({ ...f, file_url: '', file_name: '' }))}><Icon.Close size={14}/></button>
                </div>
              ) : (
                <div className="drop" style={{ padding: 14, cursor: 'pointer' }}
                  onClick={() => document.getElementById('edit-contract-file').click()}
                  onDrop={async (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (!f) return; const r = await api.uploadFile(f); if (r.url) setEditForm(p => ({ ...p, file_url: r.url, file_name: r.originalName || f.name })); }}
                  onDragOver={e => e.preventDefault()}>
                  <input id="edit-contract-file" type="file" style={{ display: 'none' }} accept=".pdf,.jpg,.jpeg,.png,.docx,.hwp"
                    onChange={async (e) => { const f = e.target.files[0]; if (!f) return; const r = await api.uploadFile(f); if (r.url) setEditForm(p => ({ ...p, file_url: r.url, file_name: r.originalName || f.name })); }}/>
                  <Icon.Upload size={16}/>
                  <div className="text-sm fw-600" style={{ marginTop: 6 }}>계약서 파일 첨부</div>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="drawer-foot">
          <button className="btn" onClick={() => setEditOpen(false)}>취소</button>
          <button className="btn primary ml-auto" onClick={handleEditSave}><Icon.Check size={14}/> 저장</button>
        </div>
      </Drawer>

      <MilestoneEditDrawer open={msOpen} onClose={() => setMsOpen(false)} contractId={contractId}
        initial={c.milestones} onSaved={reload}/>
      <BudgetEditDrawer open={budgetOpen} onClose={() => setBudgetOpen(false)} contractId={contractId}
        initial={c.cost_budget} onSaved={reload}/>
    </div>
  );
};

/* ============ 계약 목록 ============ */
const NEW_CONTRACT_FORM = { vendor: "", contract_no: "", name: "", amount: "", start_date: "", end_date: "", status: "진행중", file_url: "", file_name: "" };

const CONTRACT_KIND_META = {
  all:      { title: "계약 관리", sub: "계약별 입금·지출·미수금을 한눈에 확인하세요.", addGubu: "B" },
  sales:    { title: "매출 계약", sub: "발주처(수금) 계약입니다. 계약별 청구·입금·미수금을 관리하세요.", addGubu: "B" },
  purchase: { title: "매입 계약", sub: "매입처·외주(지급) 계약입니다. 계약별 지급 일정·미지급을 관리하세요.", addGubu: "A" },
};

export const ContractListScreen = ({ goDetail, kind = "all" }) => {
  const toast = useToast();
  const [tab, setTab] = useState("전체");
  const [q, setQ] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterPM, setFilterPM] = useState(null);
  const [allContracts, setAllContracts] = useState([]);
  const [newOpen, setNewOpen] = useState(false);
  const [newForm, setNewForm] = useState(NEW_CONTRACT_FORM);
  const [vendors, setVendors] = useState([]);
  const tabs = ["전체", "진행중", "보류", "완료"];
  const meta = CONTRACT_KIND_META[kind] || CONTRACT_KIND_META.all;

  const reload = () => api.getContracts().then(list => setAllContracts(list || []));
  useEffect(() => {
    reload();
    api.getVendors().then(setVendors);
  }, []);

  const handleNewSave = async () => {
    if (!newForm.vendor) return toast.push("거래처를 선택해주세요");
    if (!newForm.name)   return toast.push("계약명을 입력해주세요");
    if (!newForm.amount) return toast.push("계약금액을 입력해주세요");
    const vendorObj = vendors.find(v => v.name === newForm.vendor);
    const amount = parseInt(String(newForm.amount).replace(/[^0-9]/g, ""), 10);
    const res = await api.addContract({
      vendor_id:   vendorObj?.id || null,
      contract_no: newForm.contract_no?.trim() || null,
      name:        newForm.name,
      amount,
      start_date:  newForm.start_date || null,
      end_date:    newForm.end_date   || null,
      status:      newForm.status,
      file_url:    newForm.file_url  || null,
      file_name:   newForm.file_name || null,
    });
    if (res.ok) {
      toast.push("계약이 등록됐어요");
      setNewOpen(false);
      setNewForm(NEW_CONTRACT_FORM);
      reload();
    } else {
      toast.push(res.error || "저장에 실패했어요");
    }
  };

  // 거래처 gubu로 매출(B)·매입(A/E) 분류. gubu 미상은 매출로 간주(기존 데이터 호환).
  const vendorGubu = useMemo(() => Object.fromEntries(vendors.map(v => [v.id, v.gubu])), [vendors]);
  const isPurchase = (r) => { const g = vendorGubu[r.vendor_id]; return g === "A" || g === "E"; };
  // 남은 잔액: 매출=총액−수금, 매입=총액−지급 (총액=공급가×1.1)
  const rowRemain = (r) => {
    const total = Math.round((r.amount || 0) * 1.1);
    const done = isPurchase(r) ? (r.out || 0) : (r.in_done ?? r.inDone ?? 0);
    return Math.max(0, total - done);
  };
  const scoped = allContracts.filter(r => kind === "all" ? true : kind === "purchase" ? isPurchase(r) : !isPurchase(r));

  const pms = useMemo(() => [...new Set(scoped.map(c => c.pm).filter(Boolean))].sort(), [scoped]);
  const rows = scoped
    .filter(r => tab === "전체" || r.status === tab)
    .filter(r => !q || (r.name || "").includes(q) || (r.vendor_name || r.vendor || "").includes(q))
    .filter(r => !filterPM || r.pm === filterPM);

  const totals = scoped.reduce((a, c) => ({
    amount: a.amount + (c.amount || 0), inDone: a.inDone + (c.in_done || c.inDone || 0),
    remain: a.remain + rowRemain(c), out: a.out + (c.out || 0),
  }), { amount: 0, inDone: 0, remain: 0, out: 0 });

  const exportCsv = () => {
    if (rows.length === 0) return toast.push("내보낼 계약이 없어요");
    downloadCsv(`계약목록_${new Date().toISOString().slice(0, 10)}.csv`,
      ["계약명", "계약번호", "거래처", "계약금액", "입금완료", "남은잔액", "지출", "상태"],
      rows.map(r => [r.name, r.contract_no || "", r.vendor_name || r.vendor || "", r.amount || 0, r.in_done || 0, rowRemain(r), r.out || 0, r.status]));
  };

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 8 }}>
        <div>
          <div className="page-title">{meta.title}</div>
          <div className="page-sub">{meta.sub}</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={exportCsv}><Icon.Download/> 내보내기</button>
          <button className="btn primary" onClick={() => { setNewForm(NEW_CONTRACT_FORM); setNewOpen(true); }}><Icon.Plus/> 새 계약</button>
        </div>
      </div>
      <Spacer h={20}/>

      <div className="grid grid-4-to-2" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <MiniStat label="진행중 계약"   value={`${scoped.filter(c => c.status === "진행중").length}건`} sub={`총 ${scoped.length}건`} tone="ink"/>
        <MiniStat label="계약금액 합계" value={fmtNum(totals.amount) + "원"}  sub="진행 + 완료"                                                tone="brand"/>
        <MiniStat label={kind === "purchase" ? "미지급 잔액" : "남은 미수금"} value={fmtNum(totals.remain) + "원"} sub={`${scoped.filter(c => rowRemain(c) > 0).length}건 잔존`} tone="warn"/>
        <MiniStat label="누적 지출"     value={fmtNum(totals.out) + "원"}     sub="모든 계약"                                                  tone="neg"/>
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
                <th style={{ width: "26%" }}>계약</th><th style={{ width: 120 }}>계약번호</th><th>거래처</th>
                <th className="num-right">계약금액</th><th className="num-right">입금 완료</th>
                <th className="num-right">남은 잔액</th><th className="num-right">지출액</th>
                <th className="num-right">예상 손익</th><th>상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const pct = r.amount > 0 ? Math.round(((r.in_done || r.inDone || 0) / r.amount) * 100) : 0;
                return (
                  <tr key={i} style={{ cursor: "pointer" }} onClick={() => goDetail(r.id, r.name)}>
                    <td>
                      <div className="fw-600">{r.name}</div>
                      <div className="row gap-8" style={{ marginTop: 8 }}>
                        <div className="bar-track" style={{ width: 140 }}>
                          <div className="bar-fill" style={{ width: `${pct}%` }}/>
                        </div>
                        <span className="text-xs text-muted2 num">{pct}%</span>
                        <span className="text-xs text-muted2">· {r.start_date || r.startDate || '—'}</span>
                      </div>
                    </td>
                    <td className="text-sm num" style={{ color: r.contract_no ? undefined : "var(--muted-2)" }}>{r.contract_no || '—'}</td>
                    <td className="fw-600">{r.vendor_name || r.vendor || '—'}</td>
                    <td className="num-cell num-right">{fmtNum(r.amount || 0)}</td>
                    <td className="num-cell num-right">{fmtNum(r.in_done || r.inDone || 0)}</td>
                    <td className="num-cell num-right fw-700" style={{ color: rowRemain(r) > 0 ? "var(--warn-ink)" : "var(--muted-2)" }}>{rowRemain(r) > 0 ? fmtNum(rowRemain(r)) : "—"}</td>
                    <td className="num-cell num-right text-muted">{fmtNum(r.out || 0)}</td>
                    <td className="num-cell num-right fw-700" style={{ color: (r.profit || 0) < 0 ? "var(--neg-ink)" : "var(--pos)" }}>{(r.profit || 0) >= 0 ? "+" : ""}{fmtNum(r.profit || 0)}</td>
                    <td><StatusBadge status={r.status}/></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Drawer open={newOpen} onClose={() => setNewOpen(false)} width="min(480px,100vw)" label="새 계약 등록">
        <div className="drawer-body">
          <div className="col gap-16">
            <div>
              <label className="label" style={{ marginBottom: 8 }}>거래처 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
              <Combobox
                value={newForm.vendor}
                onChange={v => setNewForm(f => ({ ...f, vendor: v }))}
                options={vendors.map(v => ({ value: v.name, label: v.name, sub: v.type || "" }))}
                placeholder="거래처를 검색하거나 선택하세요"
                onAddNew={async (q) => {
                  const res = await api.addVendor({ name: q, gubu: meta.addGubu });
                  if (res.ok) {
                    const updated = await api.getVendors();
                    setVendors(updated);
                    setNewForm(f => ({ ...f, vendor: q }));
                    toast.push(`"${q}" 거래처가 등록됐어요`);
                  }
                }}
                addNewLabel="거래처로 추가"
              />
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계약명 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
              <input className="input" value={newForm.name} onChange={e => setNewForm(f => ({ ...f, name: e.target.value }))} placeholder="계약명을 입력하세요"/>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계약번호 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
              <input className="input" value={newForm.contract_no} onChange={e => setNewForm(f => ({ ...f, contract_no: e.target.value }))} placeholder="예: CT-2026-001 (계약서 번호)"/>
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>계약을 번호로 구분하는 경우 입력하세요. 목록·상세에 표시됩니다.</div>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계약금액 (공급가액) <span style={{ color: "var(--neg-ink)" }}>*</span></label>
              <div style={{ position: "relative" }}>
                <input className="input num fw-700" style={{ fontSize: 20, paddingRight: 36 }}
                  value={newForm.amount ? Number(String(newForm.amount).replace(/[^0-9]/g, "")).toLocaleString() : ""}
                  onChange={e => setNewForm(f => ({ ...f, amount: e.target.value.replace(/[^0-9]/g, "") }))}
                  placeholder="0"/>
                <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: "var(--muted-2)", fontSize: 13 }}>원</span>
              </div>
              {newForm.amount && (
                <div className="text-xs text-muted" style={{ marginTop: 6 }}>
                  부가세 포함 총액: <span className="num fw-600" style={{ color: "var(--ink)" }}>{Math.round(parseInt(newForm.amount) * 1.1).toLocaleString()}원</span>
                </div>
              )}
            </div>
            <div className="row gap-12">
              <div style={{ flex: 1 }}>
                <label className="label" style={{ marginBottom: 8 }}>계약 시작일</label>
                <input className="input" type="date" value={newForm.start_date} onChange={e => setNewForm(f => ({ ...f, start_date: e.target.value }))}/>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label" style={{ marginBottom: 8 }}>계약 종료일</label>
                <input className="input" type="date" value={newForm.end_date} onChange={e => setNewForm(f => ({ ...f, end_date: e.target.value }))}/>
              </div>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계약 상태</label>
              <div className="row gap-6">
                {["진행중", "보류", "완료"].map(s => (
                  <button key={s} type="button" className={`chip ${newForm.status === s ? "active" : ""}`} onClick={() => setNewForm(f => ({ ...f, status: s }))}>{s}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계약서 첨부 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
              {newForm.file_url ? (
                <div className="row gap-10" style={{ padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-2)' }}>
                  <Icon.File size={15} style={{ color: 'var(--brand)', flexShrink: 0 }}/>
                  <span className="text-sm fw-600" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{newForm.file_name}</span>
                  <button type="button" className="icon-btn" onClick={() => setNewForm(f => ({ ...f, file_url: '', file_name: '' }))}><Icon.Close size={14}/></button>
                </div>
              ) : (
                <div className="drop" style={{ padding: 14, cursor: 'pointer' }}
                  onClick={() => document.getElementById('contract-file-input').click()}
                  onDrop={async (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (!f) return; const r = await api.uploadFile(f); if (r.url) setNewForm(p => ({ ...p, file_url: r.url, file_name: r.originalName || f.name })); }}
                  onDragOver={e => e.preventDefault()}>
                  <input id="contract-file-input" type="file" style={{ display: 'none' }} accept=".pdf,.jpg,.jpeg,.png,.docx,.hwp"
                    onChange={async (e) => { const f = e.target.files[0]; if (!f) return; const r = await api.uploadFile(f); if (r.url) setNewForm(p => ({ ...p, file_url: r.url, file_name: r.originalName || f.name })); }}/>
                  <Icon.Upload size={16}/>
                  <div className="text-sm fw-600" style={{ marginTop: 6 }}>계약서 파일을 끌어다 놓거나 클릭</div>
                  <div className="text-xs text-muted2" style={{ marginTop: 2 }}>PDF, JPG, PNG, Word, HWP</div>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="drawer-foot">
          <button className="btn" onClick={() => setNewOpen(false)}>취소</button>
          <button className="btn primary ml-auto" onClick={handleNewSave}><Icon.Check size={14}/> 등록</button>
        </div>
      </Drawer>
    </div>
  );
};
