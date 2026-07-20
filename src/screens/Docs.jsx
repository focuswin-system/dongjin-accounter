import { useState, useEffect, useRef, Fragment } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge, Drawer, Combobox, MoneyInput, localToday } from '../lib/ui'
// SAMPLE placeholder — Docs 화면은 실 API 연동 전까지 빈 데이터로 동작
const SAMPLE = {
  docs: [], evidences: [], evidenceMissing: [], excelPreview: [],
  incomes: [], expenses: [], contractSummary: [],
  receivables: { summary: { total: 0, thisMonth: 0, overdue: 0, longOverdue: 0 }, rows: [] },
}
import { computeItems, shiftMonth, monthLabel } from './HR'
import { api } from '../lib/api'

const todayStr = () => new Date().toISOString().slice(0, 10)

const FormBlock = ({ title, hint, children }) => (
  <div>
    <div className="fw-700" style={{ fontSize: 17, marginBottom: 4, letterSpacing: "-0.02em" }}>{title}</div>
    {hint && <div className="text-sm text-muted" style={{ marginBottom: 14 }}>{hint}</div>}
    {children}
  </div>
);

/* ============ 지출 등록 Drawer (레거시 7-step) ============ */
export const ExpenseDrawer = ({ open, onClose }) => {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    vendor: "", contract: "", category: "",
    supply: "", vat: "", total: "", simple: false,
    method: "계좌이체", employee: "", date: new Date().toISOString().slice(0, 10), memo: "", evid: true, makeDoc: true,
  });
  const totalSteps = 7;
  const stepLabels = ["거래처", "계약/공통", "계정과목/비목", "금액", "결제수단", "증빙", "결의서"];

  useEffect(() => { if (open) setStep(1); }, [open]);

  return (
    <Drawer open={open} onClose={onClose} label="지출 등록">
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>지출 등록</div>
            <div className="text-xs text-muted">한 단계씩, 7개만 입력하면 끝나요.</div>
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
            <FormBlock title="어디에 쓴 돈인가요?" hint="거래처를 선택하세요.">
              <input className="input" value={form.vendor} onChange={e => setForm({...form, vendor: e.target.value})} placeholder="거래처명 검색"/>
              <div className="row gap-6" style={{ marginTop: 10, flexWrap: "wrap" }}>
                {["디자인스튜디오 R","AWS 코리아","오피스디포","임대인 김OO","프리랜서 박OO"].map(v => (
                  <button key={v} className={`chip ${form.vendor === v ? "active" : ""}`} onClick={() => setForm({...form, vendor: v})}>{v}</button>
                ))}
                <button className="chip"><Icon.Plus size={12}/> 새 거래처</button>
              </div>
            </FormBlock>
          )}

          {step === 2 && (
            <FormBlock title="어떤 계약과 관련 있나요?" hint="계약이 없다면 '공통비'를 선택하세요.">
              <div className="col gap-8">
                {["도면관리 구축","MES 유지보수","ERP 커스터마이징","QMS 라이선스","공통비"].map(v => (
                  <button key={v} className="row gap-10" onClick={() => setForm({...form, contract: v})}
                    style={{ padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 12, background: form.contract === v ? "var(--surface-3)" : "#fff", textAlign: "left", cursor: "pointer" }}>
                    <div style={{ width: 20, height: 20, borderRadius: "50%", border: "2px solid", borderColor: form.contract === v ? "var(--ink)" : "var(--line-strong)", display: "grid", placeItems: "center" }}>
                      {form.contract === v && <div style={{ width: 8, height: 8, background: "var(--ink)", borderRadius: "50%" }}/>}
                    </div>
                    <span className="fw-600">{v}</span>
                    {v === "공통비" && <span className="badge outline ml-auto">계약 없음</span>}
                  </button>
                ))}
              </div>
            </FormBlock>
          )}

          {step === 3 && (
            <FormBlock title="무슨 비용인가요?" hint="자주 쓰는 비목부터 보여줘요.">
              <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {["외주가공비","재료비","소모품비","식대","교통비","출장비","통신비","임차료","보험료","세금과공과","수수료","기타"].map(v => (
                  <button key={v} className={`chip ${form.category === v ? "active" : ""}`} onClick={() => setForm({...form, category: v})}
                    style={{ justifyContent: "center" }}>{v}</button>
                ))}
              </div>
            </FormBlock>
          )}

          {step === 4 && (
            <FormBlock title="얼마를 썼나요?" hint="공급가액과 부가세를 따로 입력하거나, 합계만 빠르게 입력할 수 있어요.">
              <div className="row gap-6" style={{ marginBottom: 12 }}>
                <button className={`chip ${!form.simple ? "active" : ""}`} onClick={() => setForm({...form, simple: false})}>상세 입력</button>
                <button className={`chip ${form.simple ? "active" : ""}`} onClick={() => setForm({...form, simple: true})}>합계만 입력</button>
              </div>
              {!form.simple ? (
                <div className="col gap-10">
                  <div>
                    <label className="label">공급가액</label>
                    <MoneyInput value={form.supply} onChange={(raw, v) => {
                      const vat = Math.round(v * 0.1);
                      setForm({...form, supply: v, vat, total: v + vat});
                    }}/>
                  </div>
                  <div>
                    <label className="label">부가세</label>
                    <MoneyInput value={form.vat} onChange={(raw, vv) => {
                      setForm({...form, vat: vv, total: form.supply + vv});
                    }}/>
                  </div>
                  <div>
                    <label className="label">합계</label>
                    <input className="input num fw-700" value={fmtNum(form.total)} readOnly style={{ background: "var(--surface-2)" }}/>
                  </div>
                </div>
              ) : (
                <div>
                  <label className="label">합계 금액</label>
                  <MoneyInput className="input num fw-700" style={{ fontSize: 22 }} value={form.total}
                    onChange={(raw, v) => {
                      const supply = Math.round(v / 1.1);
                      setForm({...form, total: v, supply, vat: v - supply});
                    }}/>
                </div>
              )}
              <div>
                <label className="label" style={{ marginTop: 14 }}>지출일</label>
                <input className="input" value={form.date} onChange={e => setForm({...form, date: e.target.value})}/>
              </div>
            </FormBlock>
          )}

          {step === 5 && (
            <FormBlock title="어떻게 결제했나요?">
              <div className="col gap-8">
                {[
                  { v: "계좌이체", i: <Icon.Bank/>,   sub: "기업은행 *123 / 신한은행 *456" },
                  { v: "법인카드", i: <Icon.Card/>,   sub: "BC 법인카드 *7821" },
                  { v: "개인카드", i: <Icon.Card/>,   sub: "추후 정산 처리" },
                  { v: "현금",     i: <Icon.Wallet/>, sub: "현금 영수증 첨부 권장" },
                  { v: "기타",     i: <Icon.More/>,   sub: "" },
                ].map(o => (
                  <button key={o.v} className="row gap-12" onClick={() => setForm({...form, method: o.v})}
                    style={{ padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 12, background: form.method === o.v ? "var(--surface-3)" : "#fff", textAlign: "left", cursor: "pointer" }}>
                    <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--surface-3)", display: "grid", placeItems: "center" }}>{o.i}</div>
                    <div>
                      <div className="fw-600">{o.v}</div>
                      <div className="text-xs text-muted2">{o.sub}</div>
                    </div>
                    {form.method === o.v && <Icon.Check size={18} className="ml-auto"/>}
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 18 }}>
                <label className="label">
                  사용 직원
                  {(form.method === "개인카드" || form.method === "현금") && <span style={{ color: "var(--neg-ink)", marginLeft: 4 }}>*</span>}
                  {!(form.method === "개인카드" || form.method === "현금") && <span className="text-muted2 fw-600" style={{ marginLeft: 4 }}>(선택)</span>}
                </label>
                <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                  {[{ name: "정수민", dept: "재무팀" },{ name: "한경리", dept: "재무팀" },{ name: "이지원", dept: "기획팀" },{ name: "박서연", dept: "개발팀" },{ name: "최민호", dept: "개발팀" }].map(e => (
                    <button key={e.name} className={`chip ${form.employee === e.name ? "active" : ""}`} onClick={() => setForm({...form, employee: e.name})}>
                      {e.name} <span className="text-muted2" style={{ marginLeft: 2 }}>· {e.dept}</span>
                    </button>
                  ))}
                </div>
              </div>
            </FormBlock>
          )}

          {step === 6 && (
            <FormBlock title="증빙이 있나요?" hint="영수증, 세금계산서, 카드영수증 등을 첨부할 수 있어요.">
              <div className="drop">
                <Icon.Upload size={22}/>
                <div className="fw-600" style={{ marginTop: 8 }}>파일을 끌어다 놓거나 클릭해서 업로드</div>
                <div className="text-xs text-muted2" style={{ marginTop: 4 }}>PDF, JPG, PNG · 최대 20MB</div>
              </div>
              <div style={{ marginTop: 12 }}>
                <span className="file-pill"><Icon.File size={12}/> 세금계산서_디자인스튜디오R.pdf <span className="text-muted2">· 82KB</span></span>
              </div>
              <div className="alert-row" style={{ marginTop: 14, background: "var(--brand-soft)", borderColor: "transparent" }}>
                <Icon.Sparkle/>
                <div>
                  <div className="lead">증빙은 빨리 첨부할수록 좋아요.</div>
                  <div className="body">세무사 전달이 한결 수월해져요.</div>
                </div>
              </div>
            </FormBlock>
          )}

          {step === 7 && (
            <FormBlock title="지출결의서를 만들까요?" hint="등록하면서 결의서를 같이 생성할 수 있어요.">
              <div className="col gap-8">
                {[{ v: true, label: "바로 결의서 생성", sub: "결재선: 정수민 → 정대표 · 자동으로 승인 요청까지 보내요." },
                  { v: false, label: "나중에 만들기", sub: "지출 내역만 먼저 등록하고, 결의서는 나중에 일괄로 만들 수 있어요." }].map(o => (
                  <button key={String(o.v)} className="row gap-10" onClick={() => setForm({...form, makeDoc: o.v})}
                    style={{ padding: "14px 16px", border: "1px solid var(--line)", borderRadius: 12, background: form.makeDoc === o.v ? "var(--surface-3)" : "#fff", textAlign: "left", cursor: "pointer" }}>
                    <div style={{ width: 18, height: 18, borderRadius: "50%", border: "2px solid", borderColor: form.makeDoc === o.v ? "var(--ink)" : "var(--line-strong)", display: "grid", placeItems: "center" }}>
                      {form.makeDoc === o.v && <div style={{ width: 8, height: 8, background: "var(--ink)", borderRadius: "50%" }}/>}
                    </div>
                    <div>
                      <div className="fw-600">{o.label}</div>
                      <div className="text-xs text-muted2">{o.sub}</div>
                    </div>
                  </button>
                ))}
              </div>
              <div className="card" style={{ marginTop: 18, padding: 16, background: "var(--surface-2)", border: "1px solid var(--line)" }}>
                <div className="fw-700 text-sm" style={{ marginBottom: 8 }}>입력 요약</div>
                <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "6px 16px", fontSize: 12.5 }}>
                  <span className="text-muted">거래처</span><span className="fw-600">{form.vendor}</span>
                  <span className="text-muted">계약/공통비</span><span className="fw-600">{form.contract}</span>
                  <span className="text-muted">비목</span><span className="fw-600">{form.category}</span>
                  <span className="text-muted">결제수단</span><span className="fw-600">{form.method}</span>
                  {form.employee && (<><span className="text-muted">사용 직원</span><span className="fw-600">{form.employee}</span></>)}
                  <span className="text-muted">지출일</span><span className="fw-600">{form.date}</span>
                  <span className="text-muted">금액</span><span className="fw-700 num">{fmtNum(form.total)}원</span>
                </div>
              </div>
            </FormBlock>
          )}
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={() => step > 1 ? setStep(step - 1) : onClose()}>{step > 1 ? "이전" : "취소"}</button>
          <div className="ml-auto row gap-8">
            <span className="text-xs text-muted2" style={{ alignSelf: "center" }}><span className="num fw-700 text-ink" style={{ color: "var(--ink)" }}>{step}</span> / {totalSteps}</span>
            {step < totalSteps
              ? <button className="btn primary" onClick={() => setStep(step + 1)}>다음 <Icon.Right size={14}/></button>
              : <button className="btn primary" onClick={onClose}><Icon.Check size={14}/> 등록 완료</button>}
          </div>
        </div>
    </Drawer>
  );
};

/* ============ 결의서 관리 ============ */
export const DocsScreen = () => {
  const toast = useToast();
  const [docs, setDocs] = useState([]);
  const [company, setCompany] = useState(null);
  const [selId, setSelId] = useState(null);
  const [q, setQ] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [showDone, setShowDone] = useState(false);   // 처리된 결의서까지 볼지

  const load = async () => {
    const [list, comp] = await Promise.all([api.getResolutions(), api.getCompany()]);
    setDocs(list); setCompany(comp);
    setSelId(prev => prev && list.some(d => d.id === prev) ? prev : (list[0]?.id || null));
  };
  useEffect(() => { load(); }, []);

  // 기본은 '처리 안 된 것'만 = 할 일 큐. 완료(처리됨)는 전체 보기에서만.
  const pendingCount = docs.filter(d => d.status !== '완료').length;
  const list = docs
    .filter(d => showDone || d.status !== '완료')
    .filter(d => !q || (d.title || "").includes(q) || (d.vendor_name || "").includes(q) || (d.doc_no || "").includes(q));
  const sel = docs.find(d => d.id === selId) || null;

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 20 }}>
        <div>
          <div className="page-title">지급결의서</div>
          <div className="page-sub">청구서 없는 지출(비품·간식 등)은 여기서 바로 만드세요. 세금계산서가 있는 매입 대금은 구매·매입의 '대금 청구서'에서 발행할 수 있어요.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn primary" onClick={() => setNewOpen(true)}><Icon.Plus/> 새 결의서</button>
        </div>
      </div>

      <NewResolutionDrawer open={newOpen} onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); load().then(() => setSelId(id)); }}/>

      <div className="grid" style={{ gridTemplateColumns: "clamp(280px, 340px, 380px) 1fr", gap: 16, alignItems: "start" }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ padding: 12, borderBottom: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="row gap-6">
              <button className={`chip ${!showDone ? "active" : ""}`} onClick={() => setShowDone(false)}>
                처리 대기 {pendingCount > 0 && <span className="badge brand" style={{ marginLeft: 6 }}>{pendingCount}</span>}
              </button>
              <button className={`chip ${showDone ? "active" : ""}`} onClick={() => setShowDone(true)}>전체</button>
            </div>
            <div className="search" style={{ margin: 0, padding: "6px 10px" }}>
              <Icon.Search size={14}/>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="문서번호·거래처·목적 검색"/>
            </div>
          </div>
          <div style={{ maxHeight: 680, overflowY: "auto" }}>
            {list.length === 0 && (
              <div style={{ padding: 40, textAlign: "center", color: "var(--muted-2)", fontSize: 13 }}>
                {showDone ? "결의서가 없어요." : "처리 대기 중인 결의서가 없어요."}<br/>'새 결의서'로 만들거나 구매·매입의 대금 청구서에서 발행하세요.
              </div>
            )}
            {list.map((d, i) => (
              <div key={d.id} onClick={() => setSelId(d.id)}
                style={{ padding: "16px 18px", background: d.id === selId ? "var(--surface-3)" : "transparent", borderTop: i === 0 ? 0 : "1px solid var(--line)", cursor: "pointer", transition: "background .12s ease" }}>
                <div className="row gap-8" style={{ marginBottom: 8 }}>
                  <span className="num text-xs text-muted2 fw-600">{d.doc_no}</span>
                  <span style={{ marginLeft: "auto" }}><StatusBadge status={d.status}/></span>
                </div>
                <div className="fw-600" style={{ marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--ink)" }}>{d.title}</div>
                <div className="row gap-8" style={{ alignItems: "baseline" }}>
                  <span className="text-xs text-muted">{d.pay_date || "—"}</span>
                  <span className="text-xs text-muted2">· {d.vendor_name || "—"}</span>
                  <span style={{ marginLeft: "auto" }} className="num fw-700 text-sm">{fmtNum(d.amount)}<span className="text-muted2" style={{ fontWeight: 400, marginLeft: 2 }}>원</span></span>
                </div>
              </div>
            ))}
          </div>
        </div>
        {sel
          ? <ResolutionPreview doc={sel} company={company} onSaved={load} onDeleted={() => { setSelId(null); load(); }}/>
          : <div className="card card-pad" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 300, color: "var(--muted-2)", gap: 12 }}>
              <Icon.Receipt size={32} style={{ opacity: 0.3 }}/>
              <div className="text-sm">결의서를 선택하면 내용이 표시됩니다</div>
            </div>
        }
      </div>
    </div>
  );
};

// 새 결의서 직접 등록 — 청구서 없는 소액 경비(비누·간식 등). 지급 전에 결의서부터 작성해 결재받는 흐름.
const NewResolutionDrawer = ({ open, onClose, onCreated }) => {
  const toast = useToast();
  const empty = { vendor: '', title: '', amount: '', pay_method: '계좌이체', pay_date: todayStr(), note: '' };
  const [form, setForm] = useState(empty);
  const [vendors, setVendors] = useState([]);
  const [presets, setPresets] = useState([]);
  const [presetId, setPresetId] = useState('');   // 선택한 결재선 프리셋
  useEffect(() => {
    if (!open) return;
    setForm(empty);
    api.getVendors().then(setVendors);
    api.getApprovalPresets().then(list => {
      setPresets(list);
      setPresetId((list.find(p => p.is_default) || list[0])?.id || '');   // 기본 프리셋 선택
    });
  }, [open]);

  const amountNum = parseInt(String(form.amount).replace(/[^0-9]/g, ''), 10) || 0;
  const chosen = presets.find(p => p.id === presetId);
  const save = async () => {
    if (!form.title.trim()) return toast.push('지출 목적을 입력해주세요');
    if (!amountNum) return toast.push('금액을 입력해주세요');
    const res = await api.createResolution({
      vendor_name: form.vendor.trim(),
      title: form.title.trim(),
      amount: amountNum,
      pay_method: form.pay_method,
      pay_date: form.pay_date || null,
      note: form.note.trim(),
      approval: chosen ? chosen.steps.map(s => ({ label: s.label, position: s.position || '', name: '' })) : undefined,
    });
    if (!res.ok) return toast.push(res.error || '생성에 실패했어요');
    toast.push(`결의서 ${res.resolution.doc_no}를 만들었어요`);
    onCreated(res.resolution.id);
  };

  return (
    <Drawer open={open} onClose={onClose} width="min(460px,100vw)" label="새 결의서">
      <div className="drawer-head">
        <div className="fw-700" style={{ fontSize: 16 }}>새 지급결의서</div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>
      <div className="drawer-body col gap-form">
        <div className="text-sm text-muted">청구서(세금계산서) 없는 지출을 결의서로 만들어요. 품목을 여러 줄로 나누려면 만든 뒤 상세에서 편집하세요.</div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>지출처 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
          <Combobox value={form.vendor} onChange={v => setForm(f => ({ ...f, vendor: v }))}
            options={vendors.map(v => ({ value: v.name, label: v.name }))}
            placeholder="거래처 선택 또는 직접 입력"
            onAddNew={(q) => setForm(f => ({ ...f, vendor: q }))} addNewLabel="이 이름으로 입력"/>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>지출 목적 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <input className="input" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="예: 사무실 간식 구입"/>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>금액 (VAT 포함) <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <div style={{ position: 'relative' }}>
            <MoneyInput className="input num fw-700" style={{ fontSize: 20, paddingRight: 36 }}
              value={form.amount}
              onChange={raw => setForm(f => ({ ...f, amount: raw }))}/>
            <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>원</span>
          </div>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>지급 방법</label>
            <div className="row gap-6">
              {['계좌이체', '현금', '카드'].map(m => (
                <button key={m} type="button" className={`chip ${form.pay_method === m ? 'active' : ''}`}
                  onClick={() => setForm(f => ({ ...f, pay_method: m }))}>{m}</button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>지급일</label>
            <input className="input" type="date" value={form.pay_date} onChange={e => setForm(f => ({ ...f, pay_date: e.target.value }))}/>
          </div>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>특기사항 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
          <input className="input" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="예: 팀 공용"/>
        </div>
        {/* 결재선 — 프리셋에서 선택. 기본 프리셋이 미리 골라져 있음. 만든 뒤 상세에서 바꿀 수도 있음. */}
        {presets.length > 0 && (
          <div>
            <label className="label" style={{ marginBottom: 8 }}>결재선</label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {presets.map(p => (
                <button key={p.id} type="button" className={`chip ${presetId === p.id ? 'active' : ''}`}
                  onClick={() => setPresetId(p.id)}>{p.name}</button>
              ))}
            </div>
            {chosen && (
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                {chosen.steps.map((s, i) => `${s.label}${s.position ? `(${s.position})` : ''}`).join(' → ')}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" onClick={save}><Icon.Check size={14}/> 결의서 만들기</button>
      </div>
    </Drawer>
  );
};

// 결의서 처리 — 이 결의서대로 지출을 집행한다.
//   기존 지출 연결: 이미 카드·이체로 나간 지출을 이 결의서에 붙임
//   새 지출 등록: 결의서 내용으로 지출 거래를 생성(금액 자동, 수정 가능)
// 어느 쪽이든 그 지출의 증빙(doc_no)에 결의서번호가 붙어 추적된다.
const ProcessDrawer = ({ open, onClose, doc, onDone }) => {
  const toast = useToast();
  const [mode, setMode] = useState('create');   // 'create' | 'link'
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayStr());
  const [candidates, setCandidates] = useState([]);
  const [pickedTxn, setPickedTxn] = useState(null);

  useEffect(() => {
    if (!open) return;
    setMode('create'); setAmount(String(doc.amount || '')); setDate(doc.pay_date || todayStr()); setPickedTxn(null);
    api.getResolutionMatchable(doc.id).then(setCandidates);
  }, [open, doc.id]);

  const amountNum = parseInt(String(amount).replace(/[^0-9]/g, ''), 10) || 0;

  const submit = async () => {
    const body = mode === 'link'
      ? { mode: 'link', txn_id: pickedTxn }
      : { mode: 'create', amount: amountNum, date };
    if (mode === 'link' && !pickedTxn) return toast.push('연결할 지출을 선택해주세요');
    const res = await api.processResolution(doc.id, body);
    if (!res.ok) return toast.push(res.error || '처리에 실패했어요');
    const base = mode === 'link' ? '기존 지출에 연결했어요' : '지출을 등록하고 처리했어요';
    toast.push(res.invoicePaid ? `${base}. 청구서도 지급 처리됐어요` : base);
    onDone();
  };

  return (
    <Drawer open={open} onClose={onClose} width="min(480px,100vw)" label="결의서 처리">
      <div className="drawer-head">
        <div>
          <div className="fw-700" style={{ fontSize: 16 }}>결의서 처리</div>
          <div className="text-xs text-muted">{doc.doc_no} · {doc.title} · {fmtNum(doc.amount)}원</div>
        </div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>
      <div className="drawer-body col gap-form">
        <div className="text-sm text-muted">이 결의서대로 지출을 집행합니다. 처리하면 목록의 '처리 대기'에서 빠져요.</div>
        <div className="row gap-6">
          <button type="button" className={`chip ${mode === 'create' ? 'active' : ''}`} onClick={() => setMode('create')}>지출 새로 등록</button>
          <button type="button" className={`chip ${mode === 'link' ? 'active' : ''}`} onClick={() => setMode('link')}>기존 지출에 연결</button>
        </div>

        {mode === 'create' ? (
          <>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>지출 금액</label>
              <div style={{ position: 'relative' }}>
                <MoneyInput className="input num fw-700" style={{ fontSize: 20, paddingRight: 36 }}
                  value={amount}
                  onChange={raw => setAmount(raw)}/>
                <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>원</span>
              </div>
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>결의서 금액으로 채웠어요. 실제 지출액이 다르면 고치세요.</div>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>지출일</label>
              <input className="input" type="date" max={localToday()} value={date} onChange={e => setDate(e.target.value)}/>
            </div>
            <div className="text-xs text-muted2">{doc.vendor_name || '거래처 미지정'} · {doc.pay_method || '계좌이체'}로 지출 거래가 생성됩니다.</div>
          </>
        ) : (
          <div>
            <label className="label" style={{ marginBottom: 8 }}>연결할 지출 거래</label>
            {candidates.length === 0 ? (
              <div className="text-sm text-muted2" style={{ padding: 16, textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 8 }}>
                연결할 미연결 지출이 없어요. '지출 새로 등록'을 쓰세요.
              </div>
            ) : (
              <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {candidates.map(t => (
                  <button key={t.id} type="button" onClick={() => setPickedTxn(t.id)}
                    style={{ textAlign: 'left', padding: '10px 12px', border: `1px solid ${pickedTxn === t.id ? 'var(--brand)' : 'var(--line)'}`,
                             borderRadius: 8, background: pickedTxn === t.id ? 'var(--brand-soft)' : '#fff', cursor: 'pointer' }}>
                    <div className="row gap-8">
                      <span className="fw-600 text-sm">{t.vendor_name || '거래처 미상'}</span>
                      {t.related && <span className="badge outline" style={{ fontSize: 10 }}>같은 거래처</span>}
                      <span className="ml-auto num fw-700">{fmtNum(t.amount)}원</span>
                    </div>
                    <div className="text-xs text-muted2" style={{ marginTop: 3 }}>{t.date} · {t.category || '—'} · {t.status}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" onClick={submit}><Icon.Check size={14}/> 처리 완료</button>
      </div>
    </Drawer>
  );
};

// 읽기전용 결의서 문서 — 결의서 화면과 지출 증빙 영역 양쪽에서 재사용.
// printClass가 있으면 그 요소가 인쇄 대상이 된다(증빙 모달에서 이것만 뽑아 인쇄).
export const ResolutionDocument = ({ doc, company, printClass }) => {
  const items = doc.items && doc.items.length ? doc.items
    : [{ name: doc.title, unit: '식', qty: 1, price: doc.amount, amount: doc.amount, note: '' }];
  const total = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const ceo = company?.ceo || '대표이사';
  // 결재선: 결의서에 저장된 approval, 없으면 담당/결재/대표 기본
  const approval = (doc.approval && doc.approval.length)
    ? doc.approval
    : [{ label: '담당' }, { label: '결재' }, { label: '대표이사', position: ceo }];
  return (
    <div className={`doc-paper resolution-paper ${printClass || ''}`}>
      <div className="res-title-ko">지출결의서</div>
      <div className="res-title">支 出 決 議 書</div>
      <div className="res-date num">{doc.pay_date || ''}</div>

      <table className="res-table res-head">
        <tbody>
          <tr><th>지출처</th><td>{doc.vendor_name}</td><th>지출총액</th><td className="num fw-700">₩ {fmtNum(total || doc.amount)}</td></tr>
          <tr><th>구매품의NO</th><td className="num">{doc.doc_no}</td><th>신청자</th><td>{doc.applicant}</td></tr>
          <tr><th>지출방법</th><td>{doc.pay_method}</td><th>지급일</th><td className="num">{doc.pay_date || '—'}</td></tr>
        </tbody>
      </table>

      <div className="res-note-line">아래 내역과 같이 支出코저 하오니 承認하여 주시기 바랍니다.</div>

      <table className="res-table res-items">
        <thead>
          <tr>
            <th style={{ width: 34 }}>NO</th><th>품명 및 규격</th><th style={{ width: 50 }}>단위</th>
            <th style={{ width: 56 }}>수량</th><th style={{ width: 96 }}>단가</th><th style={{ width: 110 }}>금액</th><th style={{ width: 90 }}>비고</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={i}>
              <td className="num" style={{ textAlign: 'center' }}>{i + 1}</td>
              <td>{it.name}</td>
              <td style={{ textAlign: 'center' }}>{it.unit}</td>
              <td className="num" style={{ textAlign: 'right' }}>{fmtNum(it.qty || 0)}</td>
              <td className="num" style={{ textAlign: 'right' }}>{fmtNum(it.price || 0)}</td>
              <td className="num fw-600" style={{ textAlign: 'right' }}>{fmtNum(it.amount || 0)}</td>
              <td>{it.note}</td>
            </tr>
          ))}
          {Array.from({ length: Math.max(0, 4 - items.length) }).map((_, i) => (
            <tr key={`e${i}`}><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
          ))}
          <tr className="res-total">
            <th colSpan={5} style={{ textAlign: 'center' }}>합　계</th>
            <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(total)}</td>
            <td></td>
          </tr>
        </tbody>
      </table>

      <div className="res-foot">
        <div className="res-note">
          <div className="res-note-head">특기사항</div>
          <div className="res-note-body">{doc.note || ''}</div>
        </div>
        <table className="res-approve">
          <tbody>
            <tr>{approval.map((s, i) => <th key={i}>{s.label}{s.position ? <div style={{ fontWeight: 400, fontSize: 10, color: '#888' }}>{s.position}</div> : null}</th>)}</tr>
            <tr>{approval.map((_, i) => <td key={i}></td>)}</tr>
          </tbody>
        </table>
      </div>

      <div className="res-company">
        {company?.name || ''}{company?.biz_no ? ` · 사업자 ${company.biz_no}` : ''}
      </div>
    </div>
  );
};

// 실제 동진테크 지출결의서 양식(지출처·지출총액·구매품의NO·신청자·지출방법 + 품목 명세 + 결재란) 기반.
// 화면에서 품목·특기사항을 보완하고 인쇄하면 대표가 서명하는 방식(전자결재 아님).
export const ResolutionPreview = ({ doc, company, onSaved, onDeleted }) => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(doc);
  const [processOpen, setProcessOpen] = useState(false);
  const [presets, setPresets] = useState([]);
  useEffect(() => { setForm(doc); setEdit(false); }, [doc.id]);
  useEffect(() => { api.getApprovalPresets().then(setPresets); }, []);
  const done = doc.status === '완료';
  // 결재선: 편집 중이면 form, 아니면 doc. 없으면 담당/결재/대표 기본
  const approval = (form.approval && form.approval.length)
    ? form.approval
    : [{ label: '담당' }, { label: '결재' }, { label: '대표이사', position: company?.ceo || '대표이사' }];
  const applyPreset = (p) => setForm(f => ({ ...f, approval: p.steps.map(s => ({ label: s.label, position: s.position || '', name: '' })) }));

  const items = form.items || [];
  const itemsTotal = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const setItem = (i, key, val) => setForm(f => ({ ...f, items: (f.items || []).map((it, j) => j === i ? { ...it, [key]: val } : it) }));
  const setItemNum = (i, key, val) => {
    const n = parseInt(String(val).replace(/[^0-9]/g, ''), 10) || 0;
    setForm(f => ({ ...f, items: (f.items || []).map((it, j) => {
      if (j !== i) return it;
      const next = { ...it, [key]: n };
      if (key === 'qty' || key === 'price') next.amount = (Number(next.qty) || 0) * (Number(next.price) || 0);
      return next;
    }) }));
  };
  const addItem = () => setForm(f => ({ ...f, items: [...(f.items || []), { name: '', unit: '식', qty: 1, price: 0, amount: 0, note: '' }] }));
  const removeItem = (i) => setForm(f => ({ ...f, items: (f.items || []).filter((_, j) => j !== i) }));

  const save = async () => {
    const res = await api.updateResolution(doc.id, { ...form, amount: itemsTotal || form.amount });
    if (!res.ok) return toast.push(res.error || '저장에 실패했어요');
    toast.push('결의서를 저장했어요'); setEdit(false); onSaved();
  };
  const remove = async () => {
    const ok = await confirm({ tone: 'neg', title: '결의서 삭제', body: `${doc.doc_no} 결의서를 삭제할까요? 거래는 그대로 남아요.`, confirmLabel: '삭제' });
    if (!ok) return;
    const res = await api.deleteResolution(doc.id);
    if (!res.ok) return toast.push('삭제에 실패했어요');
    toast.push('삭제됐어요'); onDeleted();
  };
  const doPrint = () => window.print();

  const ceo = company?.ceo || '대표이사';
  const displayItems = edit ? items : (items.length ? items : [{ name: form.title, unit: '식', qty: 1, price: form.amount, amount: form.amount, note: '' }]);

  return (
    <div>
      {/* 화면 전용 액션 바 (인쇄 시 숨김) */}
      <div className="card no-print" style={{ padding: "14px 16px", marginBottom: 16, display: "flex", gap: 10, alignItems: "center" }}>
        <span className="num text-sm text-muted">{doc.doc_no}</span>
        <StatusBadge status={doc.status}/>
        <div className="ml-auto row gap-6">
          {edit ? (
            <>
              <button className="btn" onClick={() => { setForm(doc); setEdit(false); }}>취소</button>
              <button className="btn primary" onClick={save}><Icon.Check size={14}/> 저장</button>
            </>
          ) : (
            <>
              {!done && <button className="btn ghost" onClick={remove}><Icon.Trash size={14}/></button>}
              {!done && <button className="btn" onClick={() => setEdit(true)}><Icon.Pencil size={14}/> 편집</button>}
              <button className="btn" onClick={doPrint}><Icon.Print/> 인쇄</button>
              {/* 처리 = 이 결의서대로 지출 집행. 처리되면 목록에서 빠진다. */}
              {done
                ? <span className="badge pos" style={{ alignSelf: 'center' }}><span className="dot"/>처리 완료</span>
                : <button className="btn primary" onClick={() => setProcessOpen(true)}><Icon.Check size={14}/> 처리</button>}
            </>
          )}
        </div>
      </div>

      <ProcessDrawer open={processOpen} onClose={() => setProcessOpen(false)} doc={doc}
        onDone={() => { setProcessOpen(false); onSaved(); }}/>

      {/* 인쇄 대상 — 실제 결의서 양식 */}
      <div className="doc-paper resolution-paper" id="resolution-print">
        <div className="res-title-ko">지출결의서</div>
        <div className="res-title">支 出 決 議 書</div>
        <div className="res-date num">{form.pay_date || ''}</div>

        {/* 헤더 표: 지출처 / 지출총액 / 구매품의NO / 신청자 / 지출방법 */}
        <table className="res-table res-head">
          <tbody>
            <tr>
              <th>지출처</th>
              <td>{edit ? <input className="cell-input" value={form.vendor_name || ''} onChange={e => setForm(f => ({ ...f, vendor_name: e.target.value }))}/> : form.vendor_name}</td>
              <th>지출총액</th>
              <td className="num fw-700">₩ {fmtNum(itemsTotal || form.amount)}</td>
            </tr>
            <tr>
              <th>구매품의NO</th>
              <td className="num">{form.doc_no}</td>
              <th>신청자</th>
              <td>{edit ? <input className="cell-input" value={form.applicant || ''} onChange={e => setForm(f => ({ ...f, applicant: e.target.value }))}/> : form.applicant}</td>
            </tr>
            <tr>
              <th>지출방법</th>
              <td>{edit ? <input className="cell-input" value={form.pay_method || ''} onChange={e => setForm(f => ({ ...f, pay_method: e.target.value }))}/> : form.pay_method}</td>
              <th>지급일</th>
              <td className="num">{edit ? <input className="cell-input" type="date" value={form.pay_date || ''} onChange={e => setForm(f => ({ ...f, pay_date: e.target.value }))}/> : (form.pay_date || '—')}</td>
            </tr>
          </tbody>
        </table>

        <div className="res-note-line">아래 내역과 같이 支出코저 하오니 承認하여 주시기 바랍니다.</div>

        {/* 품목 명세 */}
        <table className="res-table res-items">
          <thead>
            <tr>
              <th style={{ width: 34 }}>NO</th><th>품명 및 규격</th><th style={{ width: 50 }}>단위</th>
              <th style={{ width: 56 }}>수량</th><th style={{ width: 96 }}>단가</th><th style={{ width: 110 }}>금액</th><th style={{ width: 90 }}>비고</th>
              {edit && <th className="no-print" style={{ width: 32 }}></th>}
            </tr>
          </thead>
          <tbody>
            {displayItems.map((it, i) => (
              <tr key={i}>
                <td className="num" style={{ textAlign: 'center' }}>{i + 1}</td>
                <td>{edit ? <input className="cell-input" value={it.name || ''} onChange={e => setItem(i, 'name', e.target.value)}/> : it.name}</td>
                <td style={{ textAlign: 'center' }}>{edit ? <input className="cell-input" value={it.unit || ''} onChange={e => setItem(i, 'unit', e.target.value)}/> : it.unit}</td>
                <td className="num" style={{ textAlign: 'right' }}>{edit ? <input className="cell-input num" style={{ textAlign: 'right' }} value={it.qty ?? ''} onChange={e => setItemNum(i, 'qty', e.target.value)}/> : fmtNum(it.qty || 0)}</td>
                <td className="num" style={{ textAlign: 'right' }}>{edit ? <MoneyInput className="cell-input num" style={{ textAlign: 'right' }} placeholder="" value={it.price || ''} onChange={raw => setItemNum(i, 'price', raw)}/> : fmtNum(it.price || 0)}</td>
                <td className="num fw-600" style={{ textAlign: 'right' }}>{fmtNum(it.amount || 0)}</td>
                <td>{edit ? <input className="cell-input" value={it.note || ''} onChange={e => setItem(i, 'note', e.target.value)}/> : it.note}</td>
                {edit && <td className="no-print" style={{ textAlign: 'center' }}><button className="icon-btn" onClick={() => removeItem(i)}><Icon.Close size={13}/></button></td>}
              </tr>
            ))}
            {/* 빈 줄 채우기(양식 느낌) — 화면 편집 중엔 생략 */}
            {!edit && Array.from({ length: Math.max(0, 4 - displayItems.length) }).map((_, i) => (
              <tr key={`e${i}`}><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
            ))}
            <tr className="res-total">
              <th colSpan={5} style={{ textAlign: 'center' }}>합　계</th>
              <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(edit ? itemsTotal : (displayItems.reduce((s, it) => s + (Number(it.amount) || 0), 0)))}</td>
              <td></td>{edit && <td className="no-print"></td>}
            </tr>
          </tbody>
        </table>
        {edit && <button className="btn sm no-print" style={{ marginTop: 8 }} onClick={addItem}><Icon.Plus size={12}/> 품목 추가</button>}

        {/* 특기사항 + 결재란 */}
        <div className="res-foot">
          <div className="res-note">
            <div className="res-note-head">특기사항</div>
            {edit
              ? <textarea className="cell-input" style={{ width: '100%', minHeight: 60, resize: 'vertical' }} value={form.note || ''} onChange={e => setForm(f => ({ ...f, note: e.target.value }))}/>
              : <div className="res-note-body">{form.note || ''}</div>}
          </div>
          <div>
            {/* 편집 중이면 프리셋으로 결재선 교체. 결재란은 approval 단계대로 렌더. */}
            {edit && presets.length > 0 && (
              <div className="row gap-6 no-print" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
                <span className="text-xs text-muted2" style={{ alignSelf: 'center' }}>결재선</span>
                {presets.map(p => (
                  <button key={p.id} className="btn ghost sm" onClick={() => applyPreset(p)}>{p.name}</button>
                ))}
              </div>
            )}
            <table className="res-approve">
              <tbody>
                <tr>{approval.map((s, i) => <th key={i}>{s.label}{s.position ? <div style={{ fontWeight: 400, fontSize: 10, color: '#888' }}>{s.position}</div> : null}</th>)}</tr>
                <tr>{approval.map((_, i) => <td key={i}></td>)}</tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="res-company">
          {company?.name || ''}{company?.biz_no ? ` · 사업자 ${company.biz_no}` : ''}
        </div>
      </div>
    </div>
  );
};

// 이전 DocPreview 이름 호환(다른 곳에서 참조 시)
export const DocPreview = ResolutionPreview;

export const Stamp = ({ name, tone = "neg" }) => {
  const color = tone === "neg" ? "var(--neg)" : "var(--ink)";
  return (
    <div style={{
      width: 48, height: 48, borderRadius: "50%", border: `2px solid ${color}`, color,
      fontFamily: '"Noto Serif KR", serif', fontWeight: 700,
      fontSize: name.length >= 3 ? 11 : 13,
      letterSpacing: name.length >= 3 ? "-0.04em" : "-0.02em",
      display: "grid", placeItems: "center", margin: "auto",
      transform: "rotate(-8deg)", lineHeight: 1,
      background: "rgba(255,255,255,0.6)",
      boxShadow: `inset 0 0 0 2px rgba(255,255,255,0.4)`,
      writingMode: name.length >= 3 ? "vertical-rl" : "horizontal-tb",
    }}>
      {name.length === 3 ? <span style={{ writingMode: "vertical-rl", letterSpacing: "0.1em" }}>{name}</span> : name}
    </div>
  );
};

/* ============ 증빙 관리 ============ */
export const EvidenceScreen = ({ onAttach }) => {
  const toast = useToast();
  const [tab, setTab] = useState("전체");
  const [type, setType] = useState("전체");
  const tabs = ["전체", "연결 완료", "연결 필요", "검토 필요", "누락"];
  const types = ["전체", "세금계산서", "영수증", "카드영수증", "통장내역"];

  const rows = SAMPLE.evidences
    .filter(r => tab === "전체" || r.status === tab)
    .filter(r => type === "전체" || r.type === type);

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 20 }}>
        <div>
          <div className="page-title">증빙 관리</div>
          <div className="page-sub">영수증·세금계산서·통장내역을 한 곳에 모으고, 입출금 내역과 연결하세요.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={() => toast.push("증빙 파일을 ZIP으로 내려받았어요")}><Icon.Download/> 일괄 내려받기</button>
          <button className="btn primary" onClick={() => toast.push("파일 선택 창을 열었어요")}><Icon.Upload/> 파일 업로드</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr clamp(240px, 280px, 320px)", gap: 16, alignItems: "start" }}>
        <div>
          <div className="card card-pad" style={{ padding: 14, marginBottom: 16 }}>
            <div className="row gap-6" style={{ flexWrap: "wrap" }}>
              {tabs.map(t => (
                <button key={t} className={`chip ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
              ))}
              <div style={{ width: 1, height: 22, background: "var(--line)", margin: "0 6px" }}/>
              {types.map(t => (
                <button key={t} className={`chip ${type === t ? "active" : ""}`} onClick={() => setType(t)}>{t}</button>
              ))}
            </div>
          </div>
          <div className="drop" style={{ marginBottom: 16 }}>
            <Icon.Upload size={22}/>
            <div className="fw-600" style={{ marginTop: 8 }}>파일을 끌어다 놓아서 한 번에 업로드</div>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>여러 개를 한 번에 올리면 자동으로 거래내역과 매칭해드려요.</div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
            {rows.map((r, i) => {
              const isPdf = r.name.endsWith(".pdf");
              const isImg = r.name.endsWith(".jpg") || r.name.endsWith(".png");
              return (
                <div key={i} className="card" style={{ padding: 14, display: "flex", gap: 14, alignItems: "center" }}>
                  <div style={{ width: 52, height: 64, borderRadius: 8, background: "var(--surface-3)", border: "1px solid var(--line)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                    {isPdf ? <Icon.File size={22}/> : isImg ? <Icon.Image size={22}/> : <Icon.Doc size={22}/>}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row gap-6" style={{ marginBottom: 4 }}>
                      <span className="badge outline">{r.type}</span>
                      <StatusBadge status={r.status}/>
                    </div>
                    <div className="fw-600" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                    <div className="text-xs text-muted2">{r.size} · {r.date}</div>
                    <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                      {r.linked === "—"
                        ? <span className="text-warn"><Icon.Link size={11}/> 연결할 거래내역을 선택해주세요</span>
                        : <><Icon.Link size={11}/> {r.linked} · {r.contract}</>}
                    </div>
                  </div>
                  <button className="btn ghost sm"><Icon.More/></button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card card-pad" style={{ position: "sticky", top: 88 }}>
          <div className="row" style={{ marginBottom: 12 }}>
            <div>
              <div className="section-title">증빙 누락</div>
              <div className="section-sub">아직 영수증이 없는 지출이에요.</div>
            </div>
            <span className="badge neg ml-auto">{SAMPLE.evidenceMissing.length}건</span>
          </div>
          <div className="col">
            {SAMPLE.evidenceMissing.map((m, i) => (
              <button key={i} onClick={() => onAttach && onAttach(m)}
                className="row gap-10"
                style={{ padding: "12px 0", borderTop: i ? "1px solid var(--line)" : 0, background: "transparent", border: 0, textAlign: "left", cursor: "pointer", fontFamily: "inherit", width: "100%" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--surface-2)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fw-600 text-sm">{m.title}</div>
                  <div className="text-xs text-muted2">{m.date} · {m.id}</div>
                </div>
                <div className="num fw-700 text-sm">{fmtNum(m.amount)}</div>
                <Icon.Right size={12} className="text-muted2"/>
              </button>
            ))}
          </div>
          <button className="btn" style={{ width: "100%", marginTop: 12 }} onClick={() => toast.push("담당자에게 알림을 보냈어요")}>모두 알림 보내기</button>
        </div>
      </div>
    </div>
  );
};

/* ============ 증빙 첨부 Drawer ============ */
export const EvidenceAttachDrawer = ({ item, onClose }) => {
  const toast = useToast();
  if (!item) return null;
  return (
    <Drawer open={true} onClose={onClose} width="min(480px, 100vw)" label="증빙 첨부">
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>증빙 첨부</div>
            <div className="text-xs text-muted">아래 지출에 증빙 파일을 연결하세요.</div>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>
        <div className="drawer-body">
          <div className="card" style={{ padding: 16, background: "var(--surface-2)", border: "1px solid var(--line)", marginBottom: 20 }}>
            <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 4 }}>대상 지출</div>
            <div className="row gap-8">
              <div style={{ flex: 1 }}>
                <div className="fw-700">{item.title}</div>
                <div className="text-xs text-muted">{item.date} · {item.id}</div>
              </div>
              <div className="num fw-700">{fmtNum(item.amount)}원</div>
            </div>
          </div>
          <div className="drop">
            <Icon.Upload size={22}/>
            <div className="fw-600" style={{ marginTop: 8 }}>증빙 파일을 끌어다 놓거나 클릭해서 업로드</div>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>PDF, JPG, PNG · 최대 20MB</div>
          </div>
          <div style={{ marginTop: 18 }}>
            <label className="label">증빙 유형</label>
            <div className="row gap-6" style={{ flexWrap: "wrap" }}>
              {["세금계산서", "영수증", "카드영수증", "통장내역", "기타"].map((t, i) => (
                <button key={t} className={`chip ${i === 1 ? "active" : ""}`}>{t}</button>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 20 }}>
            <label className="label">최근 업로드된 파일에서 선택</label>
            <div className="col gap-8">
              {[
                { name: "이마트_영수증_0510.jpg", type: "영수증", size: "612KB" },
                { name: "택시영수증_0506.jpg", type: "영수증", size: "302KB" },
                { name: "법인카드_0511_명세.csv", type: "카드영수증", size: "12KB" },
              ].map(f => (
                <button key={f.name} className="row gap-10"
                  style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, background: "#fff", textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}>
                  <Icon.Image size={16}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="text-sm fw-600" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</div>
                    <div className="text-xs text-muted2">{f.type} · {f.size}</div>
                  </div>
                  <span className="badge outline">선택</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>취소</button>
          <div className="ml-auto row gap-8">
            <button className="btn primary" onClick={() => { onClose(); toast.push("증빙이 첨부되었어요"); }}><Icon.Check size={14}/> 첨부 완료</button>
          </div>
        </div>
    </Drawer>
  );
};

/* ============ 엑셀 업로드 (실 기능) ============ */
const IMPORT_TARGETS = ["사용 안함", "날짜", "거래처", "계약명", "입금/지출 구분", "비목", "금액", "메모"]
const guessTarget = (h) => {
  const s = String(h).replace(/\s/g, '')
  if (/날짜|일자|date/i.test(s)) return "날짜"
  if (/거래처|상호|업체|공급|vendor/i.test(s)) return "거래처"
  if (/계약|프로젝트|현장|contract/i.test(s)) return "계약명"
  if (/구분|입출|유형|type/i.test(s)) return "입금/지출 구분"
  if (/비목|계정|항목|category/i.test(s)) return "비목"
  if (/금액|amount|가액|합계|공급가/i.test(s)) return "금액"
  if (/메모|비고|적요|note/i.test(s)) return "메모"
  return "사용 안함"
}
const normDate = (v) => {
  if (v == null || v === '') return ''
  const s = String(v).trim()
  const m = s.match(/(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})/)
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
  const d = new Date(s)
  if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return ''
}
const normAmount = (v) => {
  if (v == null || v === '') return null
  const n = parseInt(String(v).replace(/[^0-9.-]/g, ''), 10)
  return isNaN(n) ? null : Math.abs(n)
}
const normKind = (v) => {
  const s = String(v || '').trim()
  if (/입금|수입|매출|수금|income/i.test(s)) return 'income'
  if (/지출|매입|출금|expense/i.test(s)) return 'expense'
  return null
}

export const ExcelScreen = () => {
  const toast = useToast()
  const fileRef = useRef(null)
  const [file, setFile] = useState(null)
  const [rawRows, setRawRows] = useState([])
  const [mapping, setMapping] = useState([])
  const [defaultKind, setDefaultKind] = useState('expense')
  const [excluded, setExcluded] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const onFile = async (f) => {
    if (!f) return
    setBusy(true); setResult(null)
    try {
      const { headers, rows } = await api.parseExcel(f)
      if (!headers.length) { toast.push("열을 인식하지 못했어요. 첫 행이 머리글인지 확인하세요."); setBusy(false); return }
      setFile({ name: f.name, size: f.size })
      setRawRows(rows)
      setMapping(headers.map(h => ({ excelCol: h, target: guessTarget(h) })))
      setExcluded(new Set())
    } catch (e) { toast.push(e.message || "파싱 실패") }
    setBusy(false)
  }

  const reset = () => { setFile(null); setRawRows([]); setMapping([]); setExcluded(new Set()); setResult(null) }
  const colFor = (t) => mapping.find(m => m.target === t)?.excelCol
  const setMap = (i, k, v) => setMapping(ms => ms.map((m, idx) => idx === i ? { ...m, [k]: v } : m))

  const preview = rawRows.map((row, idx) => {
    const g = (t) => { const c = colFor(t); return c != null ? row[c] : '' }
    const date = normDate(g("날짜"))
    const kCol = colFor("입금/지출 구분")
    const kind = kCol != null ? normKind(row[kCol]) : defaultKind
    const amount = normAmount(g("금액"))
    const errs = []
    if (!colFor("날짜") || !date) errs.push("날짜")
    if (!colFor("금액") || amount == null) errs.push("금액")
    if (!kind) errs.push("구분")
    return {
      idx, date, kind, amount,
      vendor: String(g("거래처") || '').trim(),
      contract: String(g("계약명") || '').trim(),
      category: String(g("비목") || '').trim(),
      memo: String(g("메모") || '').trim(), errs,
    }
  })

  const active = preview.filter(r => !excluded.has(r.idx))
  const okRows = active.filter(r => r.errs.length === 0)
  const errRows = active.filter(r => r.errs.length > 0)
  const stage = result ? 4 : (file ? 3 : 1)

  const buckets = [
    { key: "날짜", label: "날짜 오류", fix: "날짜가 비었거나 형식을 인식 못했어요. 매핑을 다시 보거나 해당 행을 제외하세요." },
    { key: "금액", label: "금액 오류", fix: "금액이 비었거나 숫자가 아니에요. 매핑을 다시 보거나 해당 행을 제외하세요." },
    { key: "구분", label: "입금/지출 구분 오류", fix: "구분을 인식 못했어요. '구분' 매핑을 해제하면 위의 기본 유형이 적용돼요." },
  ].map(b => ({ ...b, n: errRows.filter(r => r.errs.includes(b.key)).length })).filter(b => b.n > 0)

  const excludeErr = (key) => setExcluded(s => {
    const n = new Set(s)
    errRows.filter(r => r.errs.includes(key)).forEach(r => n.add(r.idx))
    return n
  })
  const unmapKind = () => setMapping(ms => ms.map(m => m.target === "입금/지출 구분" ? { ...m, target: "사용 안함" } : m))

  const onCommit = async () => {
    if (!okRows.length) return toast.push("등록할 정상 행이 없어요")
    setBusy(true)
    const items = okRows.map(r => ({ date: r.date, vendor: r.vendor, contract: r.contract, kind: r.kind, category: r.category, amount: r.amount, memo: r.memo }))
    const res = await api.commitImport(items)
    setBusy(false)
    if (!res.ok) return toast.push(res.error || "등록 실패")
    setResult(res)
    toast.push(`${res.inserted}건이 등록됐어요`)
  }

  const downloadTemplate = async () => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/transactions/import/template', { headers: token ? { Authorization: 'Bearer ' + token } : {} })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob); const a = document.createElement('a')
      a.href = url; a.download = '거래내역_업로드_양식.xlsx'; a.click(); URL.revokeObjectURL(url)
    } catch { toast.push('양식 다운로드에 실패했어요') }
  }

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 6 }}>
        <div>
          <div className="page-title">엑셀 업로드</div>
          <div className="page-sub">기존 입출금 자료를 엑셀(.xlsx)·CSV로 한 번에 등록하세요.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={downloadTemplate}><Icon.Download/> 양식 다운로드</button>
        </div>
      </div>
      <Spacer h={20}/>

      <div className="row gap-12" style={{ marginBottom: 20 }}>
        {[{ n: 1, t: "파일 업로드" }, { n: 2, t: "데이터 유형" }, { n: 3, t: "컬럼 매핑 · 미리보기" }, { n: 4, t: "일괄 등록" }].map((s, i, arr) => (
          <Fragment key={s.n}>
            <div className="row gap-8" style={{ opacity: stage >= s.n ? 1 : 0.4 }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: stage >= s.n ? "var(--ink)" : "#fff", color: stage >= s.n ? "#fff" : "var(--muted)", border: "1px solid var(--line-strong)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 12 }}>
                {stage > s.n ? <Icon.Check size={14}/> : s.n}
              </div>
              <div className={`text-sm ${stage >= s.n ? "fw-700" : "text-muted"}`}>{s.t}</div>
            </div>
            {i < arr.length - 1 && <div style={{ flex: 1, height: 1, background: "var(--line)" }}/>}
          </Fragment>
        ))}
      </div>

      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={e => onFile(e.target.files[0])}/>

      {result ? (
        <div className="card card-pad fade-up" style={{ textAlign: "center", padding: "48px 24px", maxWidth: 520, margin: "0 auto" }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: "var(--pos-soft)", color: "var(--pos)", display: "grid", placeItems: "center", margin: "0 auto 16px" }}><Icon.Check size={24}/></div>
          <div className="fw-700" style={{ fontSize: 16, marginBottom: 8 }}>{result.inserted}건이 등록됐어요</div>
          {result.createdVendors?.length > 0 && (
            <div className="text-sm text-muted" style={{ marginBottom: 16 }}>신규 거래처 {result.createdVendors.length}곳 자동 등록: {result.createdVendors.slice(0, 5).join(', ')}{result.createdVendors.length > 5 ? ' 외' : ''}</div>
          )}
          <button className="btn primary" onClick={reset}>새 파일 업로드</button>
        </div>
      ) : !file ? (
        <div className="card card-pad">
          <div className="drop" style={{ padding: 48, cursor: "pointer", textAlign: "center" }}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files[0]) }}>
            <Icon.Excel size={36} style={{ color: "var(--pos)" }}/>
            <div className="fw-600" style={{ marginTop: 8 }}>{busy ? "분석 중..." : "엑셀·CSV 파일을 끌어다 놓거나 클릭해서 업로드"}</div>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>.xlsx · .xls · .csv · 최대 20MB · 첫 행은 머리글</div>
          </div>
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "1fr clamp(240px, 280px, 320px)", gap: 16, alignItems: "start" }}>
          <div className="col gap-16">
            <div className="card card-pad">
              <div className="row gap-12">
                <div style={{ width: 44, height: 44, borderRadius: 10, background: "#E7F4ED", color: "var(--pos)", display: "grid", placeItems: "center" }}><Icon.Excel size={22}/></div>
                <div style={{ minWidth: 0 }}>
                  <div className="fw-700" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</div>
                  <div className="text-xs text-muted2">{Math.round(file.size / 1024)}KB · {rawRows.length}행 인식됨</div>
                </div>
                <div className="ml-auto row gap-6">
                  <button className="btn sm" onClick={() => fileRef.current?.click()}>다시 업로드</button>
                  <button className="btn ghost sm" onClick={reset}><Icon.Close size={14}/></button>
                </div>
              </div>
              <div style={{ height: 1, background: "var(--line)", margin: "14px 0" }}/>
              <div className="row gap-10" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <span className="text-sm fw-600">기본 데이터 유형</span>
                <span className="text-xs text-muted2">구분 컬럼을 매핑하면 그 값이 우선해요</span>
                <div className="row gap-6 ml-auto">
                  {[["expense", "지출"], ["income", "입금"]].map(([v, l]) => (
                    <button key={v} className={`chip ${defaultKind === v ? "active" : ""}`} onClick={() => setDefaultKind(v)}>{l}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="card card-pad">
              <div className="section-title" style={{ marginBottom: 4 }}>컬럼 매핑</div>
              <div className="section-sub" style={{ marginBottom: 14 }}>왼쪽은 엑셀 컬럼명(수정 가능), 오른쪽은 우리 항목으로 연결하세요.</div>
              <div className="table-scroll">
                <table className="table" style={{ marginTop: 6 }}>
                  <thead><tr><th style={{ width: 200 }}>엑셀 컬럼</th><th>샘플 값</th><th style={{ width: 220 }}>매핑 항목</th></tr></thead>
                  <tbody>
                    {mapping.map((m, i) => (
                      <tr key={i}>
                        <td><input className="input" value={m.excelCol} onChange={e => setMap(i, "excelCol", e.target.value)}/></td>
                        <td className="text-muted num text-sm" style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(rawRows[0]?.[m.excelCol] ?? '—') || '—'}</td>
                        <td>
                          <div className="row gap-6" style={{ alignItems: "center" }}>
                            <Icon.Right size={12} className="text-muted2"/>
                            <div style={{ flex: 1 }}>
                              <Combobox value={m.target} onChange={v => setMap(i, "target", v)} allowAdd={false}
                                options={IMPORT_TARGETS.map(o => ({ value: o, label: o }))}/>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="row" style={{ padding: "16px 16px", borderBottom: "1px solid var(--line)" }}>
                <div className="section-title">미리보기</div>
                <div className="ml-auto row gap-8">
                  <span className="badge pos"><Icon.Check size={11}/> 정상 {okRows.length}</span>
                  <span className="badge neg"><Icon.Warn size={11}/> 오류 {errRows.length}</span>
                  {excluded.size > 0 && <span className="badge outline">제외 {excluded.size}</span>}
                </div>
              </div>
              <div className="table-scroll" style={{ maxHeight: 360 }}>
                <table className="table">
                  <thead><tr><th style={{ width: 40 }}>행</th><th>날짜</th><th>거래처</th><th>계약</th><th>구분</th><th>비목</th><th className="num-right">금액</th><th>상태</th></tr></thead>
                  <tbody>
                    {preview.slice(0, 100).map((r) => {
                      const ex = excluded.has(r.idx)
                      return (
                        <tr key={r.idx} style={{ background: ex ? "var(--surface-2)" : r.errs.length ? "rgba(255,80,80,0.04)" : undefined, opacity: ex ? 0.5 : 1 }}>
                          <td className="num text-muted2">{r.idx + 2}</td>
                          <td className="num text-sm">{r.date || <span className="text-neg">—</span>}</td>
                          <td className="fw-600">{r.vendor || "—"}</td>
                          <td className="text-muted text-sm">{r.contract || "—"}</td>
                          <td>{r.kind ? <span className="badge outline">{r.kind === "income" ? "입금" : "지출"}</span> : <span className="text-neg text-xs">?</span>}</td>
                          <td className="text-sm">{r.category || "—"}</td>
                          <td className="num-cell num-right">{r.amount != null ? fmtNum(r.amount) : <span className="text-neg">—</span>}</td>
                          <td>
                            {ex ? <span className="badge outline">제외</span>
                              : r.errs.length === 0 ? <span className="badge pos"><Icon.Check size={11}/> 정상</span>
                              : <span className="badge neg"><Icon.Warn size={11}/> {r.errs.join('·')} 오류</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ padding: 16, borderTop: "1px solid var(--line)" }}>
                <span className="text-sm text-muted">{preview.length > 100 ? `상위 100행 표시 · 전체 ${preview.length}행` : `전체 ${preview.length}행`}</span>
                <div className="ml-auto row gap-8">
                  <button className="btn" onClick={reset}>취소</button>
                  <button className="btn primary" disabled={busy || !okRows.length} style={{ opacity: (busy || !okRows.length) ? 0.5 : 1 }} onClick={onCommit}>
                    <Icon.Check size={14}/> {busy ? "등록 중..." : `정상 ${okRows.length}건 일괄 등록`}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="col gap-16" style={{ position: "sticky", top: 88 }}>
            <div className="card card-pad">
              <div className="row" style={{ marginBottom: 10 }}>
                <div className="section-title">오류 수정 도우미</div>
                <span className="badge neg ml-auto">{errRows.length}건</span>
              </div>
              <div className="section-sub" style={{ marginBottom: 14 }}>오류 행을 제외하거나 매핑을 바꾸면 바로 다시 검증돼요.</div>
              {buckets.length === 0 ? (
                <div className="text-sm text-muted" style={{ padding: "8px 0" }}>{errRows.length === 0 ? "오류가 없어요. 바로 등록할 수 있어요." : "—"}</div>
              ) : (
                <div className="col gap-10">
                  {buckets.map((b, i) => (
                    <div key={i} style={{ padding: 12, border: "1px solid var(--line)", borderRadius: 12, background: "var(--surface-2)" }}>
                      <div className="row" style={{ marginBottom: 4 }}><span className="fw-700 text-sm">{b.label}</span><span className="badge neg ml-auto">{b.n}건</span></div>
                      <div className="text-xs text-muted">{b.fix}</div>
                      <div className="row gap-6" style={{ marginTop: 10 }}>
                        <button className="btn sm" onClick={() => excludeErr(b.key)}>오류 행 제외</button>
                        {b.key === "구분" && <button className="btn sm" onClick={unmapKind}>기본값 적용</button>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {excluded.size > 0 && <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={() => setExcluded(new Set())}>제외 해제 ({excluded.size})</button>}
            </div>
            <div className="card card-pad" style={{ background: "var(--brand-soft)", borderColor: "transparent" }}>
              <div className="row gap-8" style={{ marginBottom: 6 }}><Icon.Sparkle/><div className="fw-700">미등록 거래처는 자동 등록</div></div>
              <div className="text-sm" style={{ color: "var(--brand-ink)" }}>엑셀에만 있는 거래처는 등록 시 자동으로 거래처 목록에 추가돼요 (입금=발주처, 지출=매입처).</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ============ 보고서 ============ */

const RBar = ({ pct, tone = "pos" }) => (
  <div style={{ flex: 1, height: 5, borderRadius: 99, background: "var(--surface-3)", overflow: "hidden" }}>
    <div style={{ height: "100%", width: `${Math.min(100, pct)}%`, background: `var(--${tone})`, borderRadius: 99 }}/>
  </div>
)

const StatCard = ({ label, value, unit = "원", tone }) => {
  const isNum = typeof value === "number"
  return (
    <div className="card card-pad">
      <div className="text-sm text-muted fw-600" style={{ marginBottom: 6 }}>{label}</div>
      <div className={`${isNum ? "num " : ""}fw-700`} style={{ fontSize: 22, color: tone ? `var(--${tone})` : undefined }}>
        {isNum ? fmtNum(value) : value}
        {isNum && unit && <span className="text-muted" style={{ fontSize: 13, fontWeight: 400, marginLeft: 3 }}>{unit}</span>}
      </div>
    </div>
  )
}

// 데이터에서 사용 가능한 월 목록 자동 추출
const ALL_MONTHS = [...new Set([
  ...SAMPLE.incomes.map(r => (r.date || '').slice(0, 7)),
  ...SAMPLE.expenses.map(r => (r.date || '').slice(0, 7)),
])].sort((a, b) => b.localeCompare(a))

const PeriodFilter = ({ value, onChange }) => (
  <div className="row gap-8" style={{ marginBottom: 20 }}>
    <span className="text-sm text-muted fw-600" style={{ lineHeight: "28px" }}>기간</span>
    {["전체", ...ALL_MONTHS].map(m => (
      <button key={m} className={`chip${value === m ? " active" : ""}`} onClick={() => onChange(m)}>
        {m === "전체" ? "전체" : `${parseInt(m.slice(5))}월`}
      </button>
    ))}
  </div>
)

const filterByPeriod = (rows, period, dateKey = "date") =>
  period === "전체" ? rows : rows.filter(r => r[dateKey]?.startsWith(period))

const REPORTS = [
  { id: "monthly",     t: "월별 입금/지출 현황",       d: "이번 달과 지난 달을 비교해보세요." },
  { id: "tax4",        t: "4대보험·원천세 신고 자료",   d: "매달 10일 납부 기한 전에 신고서를 받으세요. 다음 납부: 6월 10일." },
  { id: "contract",    t: "계약별 손익 현황",           d: "납품 계약마다 자금 흐름과 예상 손익을 한눈에." },
  { id: "category",    t: "비목별 지출 현황",           d: "재료비·외주가공비·시험검사비 등 비목별 비교." },
  { id: "vendor",      t: "발주처별 거래 현황",         d: "한화·LIG·현대로템 등 발주처별 거래 규모." },
  { id: "ar",          t: "미수금 현황",                d: "받을 돈이 어디서 얼마나 남았는지 정리해드려요." },
  { id: "subcontract", t: "외주가공비 분석",             d: "협력사별 외주비 비중과 단가 추이." },
  { id: "defense",     t: "방산 납품 실적 보고서",       d: "방산물자 지정업체 대상 납품 실적 자료." },
  { id: "taxoffice",   t: "세무사 전달용 자료",          d: "월별 입출금·증빙 묶음을 ZIP으로 받으세요." },
  { id: "vat",         t: "부가세 신고 자료",            d: "분기별 매출·매입세액 및 납부세액을 확인하세요." },
]

// ── 1. 월별 입금/지출 현황 ───────────────────────────────────
const ReportMonthly = ({ toast }) => {
  const [period, setPeriod] = useState("전체")
  const incomes  = filterByPeriod(SAMPLE.incomes,  period)
  const expenses = filterByPeriod(SAMPLE.expenses, period)

  const bucket = {}
  incomes.forEach(r => {
    const m = (r.date || '').slice(0, 7)
    if (!bucket[m]) bucket[m] = { income: 0, expense: 0 }
    bucket[m].income += r.amount
  })
  expenses.forEach(r => {
    const m = (r.date || '').slice(0, 7)
    if (!bucket[m]) bucket[m] = { income: 0, expense: 0 }
    bucket[m].expense += r.amount
  })
  const rows = Object.entries(bucket)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([m, v]) => ({ m, ...v, net: v.income - v.expense }))
  const maxVal = Math.max(...rows.flatMap(r => [r.income, r.expense]), 1)
  const totalIn  = rows.reduce((a, r) => a + r.income, 0)
  const totalOut = rows.reduce((a, r) => a + r.expense, 0)

  return (
    <div>
      <PeriodFilter value={period} onChange={setPeriod}/>
      <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
        <StatCard label="총 입금" value={totalIn} tone="pos"/>
        <StatCard label="총 지출" value={totalOut}/>
        <StatCard label="순차액" value={totalIn - totalOut} tone={totalIn >= totalOut ? "pos" : "neg"}/>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>월</th>
              <th className="num-right">입금</th>
              <th className="num-right">지출</th>
              <th className="num-right">차액</th>
              <th style={{ width: 200 }}>비교</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="fw-600">{r.m}</td>
                <td className="num-cell num-right" style={{ color: "var(--pos)" }}>+{fmtNum(r.income)}</td>
                <td className="num-cell num-right">−{fmtNum(r.expense)}</td>
                <td className="num-cell num-right fw-700" style={{ color: r.net >= 0 ? "var(--pos)" : "var(--neg)" }}>
                  {r.net >= 0 ? "+" : "−"}{fmtNum(Math.abs(r.net))}
                </td>
                <td>
                  <div className="col gap-4">
                    <div className="row gap-6" style={{ alignItems: "center" }}>
                      <span style={{ width: 14, fontSize: 10, color: "var(--pos)" }}>입</span>
                      <RBar pct={(r.income / maxVal) * 100} tone="pos"/>
                    </div>
                    <div className="row gap-6" style={{ alignItems: "center" }}>
                      <span style={{ width: 14, fontSize: 10, color: "var(--muted)" }}>지</span>
                      <RBar pct={(r.expense / maxVal) * 100} tone="neg"/>
                    </div>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 2. 4대보험·원천세 신고 자료 ─────────────────────────────
const ReportTax4 = ({ toast }) => {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [rows, setRows] = useState([])
  // 근로소득(급여대장, seq=0)만 집계 — 용역·일용·기타소득은 원천세 신고 구분이 달라 섞지 않는다.
  useEffect(() => { api.getPayroll(month, "labor").then(r => setRows(Array.isArray(r) ? r : [])) }, [month])

  const data = rows.map(r => ({ row: r, ...computeItems(r.items) }))
  const dedLabels = []
  data.forEach(d => d.calc.forEach(i => { if (i.kind === 'deduct' && !dedLabels.includes(i.label)) dedLabels.push(i.label) }))
  const amountOf = (d, label) => d.calc.filter(i => i.kind === 'deduct' && i.label === label).reduce((a, i) => a + i.amount, 0)
  const sumGross = data.reduce((a, d) => a + d.gross, 0)
  const sumDed = data.reduce((a, d) => a + d.deduction, 0)
  const sumNet = data.reduce((a, d) => a + d.net, 0)
  const sumLabel = (label) => data.reduce((a, d) => a + amountOf(d, label), 0)

  return (
    <div>
      <div className="row gap-8" style={{ marginBottom: 16 }}>
        <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, -1))}><Icon.Left size={14}/></button>
        <div className="fw-700" style={{ fontSize: 15, minWidth: 100, textAlign: "center" }}>{monthLabel(month)}</div>
        <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, 1))}><Icon.Right size={14}/></button>
        <button className="btn ml-auto" onClick={() => toast.push("신고 자료를 출력했어요")}><Icon.Print size={14}/> 자료 출력</button>
      </div>

      <div className="card card-pad" style={{ background: "var(--brand-soft)", borderColor: "transparent", marginBottom: 16 }}>
        <div className="row gap-8">
          <Icon.Bell size={14}/>
          <span className="text-sm fw-600">근로소득 급여대장의 실제 지급·공제액을 집계했어요</span>
          <span className="text-xs text-muted" style={{ marginLeft: 4 }}>용역·일용·기타소득은 원천세 구분이 달라 제외됩니다 (인사관리 → 용역·일용 대장에서 확인)</span>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", color: "var(--muted-2)", padding: "44px 18px" }}>
          {monthLabel(month)} 급여대장이 없어요. 인사관리 → 급여대장에서 먼저 작성하세요.
        </div>
      ) : (
        <>
          <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
            <StatCard label="급여 총액" value={sumGross}/>
            <StatCard label="공제 합계" value={sumDed} tone="warn"/>
            <StatCard label="실지급액" value={sumNet}/>
          </div>
          <div className="card" style={{ overflow: "hidden" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>성명</th><th>직위</th>
                  <th className="num-right">급여총액</th>
                  {dedLabels.map(l => <th key={l} className="num-right">{l}</th>)}
                  <th className="num-right">실지급액</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d, i) => (
                  <tr key={i}>
                    <td className="fw-700">{d.row.name}</td>
                    <td className="text-sm text-muted">{d.row.role || "—"}</td>
                    <td className="num-cell num-right">{fmtNum(d.gross)}</td>
                    {dedLabels.map(l => <td key={l} className="num-cell num-right" style={{ color: "var(--warn-ink)" }}>{fmtNum(amountOf(d, l))}</td>)}
                    <td className="num-cell num-right fw-700">{fmtNum(d.net)}</td>
                  </tr>
                ))}
                <tr style={{ background: "var(--surface-2)" }}>
                  <td colSpan={2} className="fw-700">합계 {data.length}명</td>
                  <td className="num-cell num-right fw-700">{fmtNum(sumGross)}</td>
                  {dedLabels.map(l => <td key={l} className="num-cell num-right fw-700" style={{ color: "var(--warn-ink)" }}>{fmtNum(sumLabel(l))}</td>)}
                  <td className="num-cell num-right fw-700">{fmtNum(sumNet)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ── 3. 계약별 손익 현황 ──────────────────────────────────────
const ReportContract = ({ toast }) => {
  const rows = SAMPLE.contractSummary.map(c => ({ ...c, margin: c.amount ? (c.profit || 0) / c.amount * 100 : 0 }))
  const totalAmount = rows.reduce((a, r) => a + r.amount, 0)
  const totalProfit = rows.reduce((a, r) => a + r.profit, 0)

  return (
    <div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
        <StatCard label="총 수주금액" value={totalAmount}/>
        <StatCard label="총 손익"     value={totalProfit} tone="pos"/>
        <StatCard label="평균 이익률" value={totalAmount > 0 ? parseFloat((totalProfit / totalAmount * 100).toFixed(1)) : 0} unit="%" tone="pos"/>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>계약명</th>
              <th className="num-right">수주금액</th>
              <th className="num-right">입금완료</th>
              <th className="num-right">지출</th>
              <th className="num-right">손익</th>
              <th style={{ width: 120 }}>이익률</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="fw-700">{r.name}</td>
                <td className="num-cell num-right">{fmtNum(r.amount)}</td>
                <td className="num-cell num-right" style={{ color: "var(--pos)" }}>{fmtNum(r.inDone)}</td>
                <td className="num-cell num-right">{fmtNum(r.out)}</td>
                <td className="num-cell num-right fw-700" style={{ color: "var(--pos)" }}>+{fmtNum(r.profit)}</td>
                <td>
                  <div className="row gap-6" style={{ alignItems: "center" }}>
                    <span className="num text-sm fw-600" style={{ color: "var(--pos)", width: 36 }}>{r.margin.toFixed(0)}%</span>
                    <RBar pct={r.margin} tone="pos"/>
                  </div>
                </td>
                <td><StatusBadge status={r.status}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 4. 비목별 지출 현황 ──────────────────────────────────────
const ReportCategory = ({ toast }) => {
  const [period, setPeriod] = useState("전체")
  const expenses = filterByPeriod(SAMPLE.expenses, period)

  const bucket = {}
  expenses.forEach(r => {
    if (!bucket[r.category]) bucket[r.category] = 0
    bucket[r.category] += r.amount
  })
  const total = Object.values(bucket).reduce((a, v) => a + v, 0)
  const rows = Object.entries(bucket)
    .sort(([, a], [, b]) => b - a)
    .map(([cat, amt]) => ({ cat, amt, pct: (amt / total) * 100 }))

  return (
    <div>
      <PeriodFilter value={period} onChange={setPeriod}/>
      <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
        <StatCard label="총 지출"  value={total}/>
        <StatCard label="비목 수"  value={`${rows.length}개`} unit=""/>
        <StatCard label="최다 비목" value={rows[0]?.cat} unit=""/>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>비목</th>
              <th className="num-right">금액</th>
              <th className="num-right" style={{ width: 70 }}>비중</th>
              <th style={{ width: 200 }}>비율</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><span className="badge outline">{r.cat}</span></td>
                <td className="num-cell num-right fw-700">{fmtNum(r.amt)}</td>
                <td className="num-right text-muted">{r.pct.toFixed(1)}%</td>
                <td><RBar pct={r.pct} tone={i === 0 ? "neg" : "warn"}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 5. 발주처별 거래 현황 ────────────────────────────────────
const ReportVendor = ({ toast }) => {
  const [period, setPeriod] = useState("전체")
  const incomes = filterByPeriod(SAMPLE.incomes, period)

  // 실현 매출(입금 완료·일부 입금)과 미실현(예정·미수)을 분리
  const REALIZED = new Set(["입금 완료", "일부 입금"])
  const bucket = {}
  incomes.forEach(r => {
    if (!bucket[r.vendor]) bucket[r.vendor] = { realized: 0, pending: 0, count: 0 }
    if (REALIZED.has(r.status)) bucket[r.vendor].realized += r.amount
    else                        bucket[r.vendor].pending  += r.amount
    bucket[r.vendor].count++
  })
  const rows = Object.entries(bucket)
    .sort(([, a], [, b]) => (b.realized + b.pending) - (a.realized + a.pending))
    .map(([vendor, v]) => ({ vendor, ...v, total: v.realized + v.pending }))
  const totalRealized = rows.reduce((a, r) => a + r.realized, 0)
  const totalPending  = rows.reduce((a, r) => a + r.pending, 0)
  const grandTotal    = totalRealized + totalPending

  return (
    <div>
      <PeriodFilter value={period} onChange={setPeriod}/>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
        <StatCard label="발주처 수"    value={`${rows.length}개사`} unit=""/>
        <StatCard label="청구 합계"    value={grandTotal}/>
        <StatCard label="실현 매출"    value={totalRealized} tone="pos"/>
        <StatCard label="미입금 잔액"  value={totalPending}  tone="warn"/>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>발주처</th>
              <th className="num-right">실현 매출</th>
              <th className="num-right">미입금</th>
              <th className="num-right" style={{ width: 60 }}>건수</th>
              <th className="num-right" style={{ width: 70 }}>비중</th>
              <th style={{ width: 180 }}>비율</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="fw-700">{r.vendor}</td>
                <td className="num-cell num-right" style={{ color: "var(--pos)" }}>{r.realized ? fmtNum(r.realized) : "—"}</td>
                <td className="num-cell num-right" style={{ color: r.pending ? "var(--warn)" : "var(--muted)" }}>
                  {r.pending ? fmtNum(r.pending) : "—"}
                </td>
                <td className="num-right text-muted">{r.count}건</td>
                <td className="num-right text-muted">{(r.total / grandTotal * 100).toFixed(1)}%</td>
                <td><RBar pct={(r.total / grandTotal) * 100} tone="brand"/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 6. 미수금 현황 ───────────────────────────────────────────
const ReportAR = ({ toast }) => {
  const { summary = {}, rows = [] } = SAMPLE.receivables || {}
  return (
    <div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
        <StatCard label="미수금 합계"      value={summary.total}/>
        <StatCard label="이번 달 회수 예정" value={summary.thisMonth} tone="brand"/>
        <StatCard label="기한 초과"         value={summary.overdue}   tone="neg"/>
        <StatCard label="장기 미수"         value={summary.longOverdue} tone="neg"/>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>거래처</th><th>계약</th>
              <th className="num-right">청구금액</th>
              <th className="num-right">입금</th>
              <th className="num-right">잔액</th>
              <th>만기일</th>
              <th style={{ width: 70 }}>연체</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="fw-700">{r.vendor}</td>
                <td className="text-sm text-muted">{r.contract}</td>
                <td className="num-cell num-right">{fmtNum(r.billed)}</td>
                <td className="num-cell num-right" style={{ color: "var(--pos)" }}>{r.paid ? fmtNum(r.paid) : "—"}</td>
                <td className="num-cell num-right fw-700">{fmtNum(r.remain)}</td>
                <td className="text-sm">{r.due}</td>
                <td className="num-cell num-right">
                  {r.delay > 0 ? <span className="badge neg">{r.delay}일</span> : <span className="text-muted">—</span>}
                </td>
                <td><StatusBadge status={r.status}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 7. 외주가공비 분석 ───────────────────────────────────────
const ReportSubcontract = ({ toast }) => {
  const [period, setPeriod] = useState("전체")
  // expenses만 사용 — payables와 중복 집계 방지 (payables는 미지급 잔액 뷰)
  const subRows = filterByPeriod(SAMPLE.expenses, period).filter(r => r.category === "외주가공비")

  const PAID = new Set(["지급 완료"])
  const bucket = {}
  subRows.forEach(r => {
    if (!bucket[r.vendor]) bucket[r.vendor] = { paid: 0, pending: 0, count: 0 }
    if (PAID.has(r.pay)) bucket[r.vendor].paid    += r.amount
    else                  bucket[r.vendor].pending += r.amount
    bucket[r.vendor].count++
  })
  const rows = Object.entries(bucket)
    .sort(([, a], [, b]) => (b.paid + b.pending) - (a.paid + a.pending))
    .map(([vendor, v]) => ({ vendor, ...v, total: v.paid + v.pending }))
  const total    = rows.reduce((a, r) => a + r.total, 0)
  const totalPending = rows.reduce((a, r) => a + r.pending, 0)
  const totalExp = filterByPeriod(SAMPLE.expenses, period).reduce((a, r) => a + r.amount, 0)

  return (
    <div>
      <PeriodFilter value={period} onChange={setPeriod}/>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
        <StatCard label="협력사 수"      value={`${rows.length}개사`} unit=""/>
        <StatCard label="외주가공비 합계" value={total}/>
        <StatCard label="미지급 잔액"    value={totalPending} tone="warn"/>
        <StatCard label="총 지출 대비"   value={totalExp > 0 ? parseFloat((total / totalExp * 100).toFixed(1)) : 0} unit="%"/>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>협력사</th>
              <th className="num-right">지급 완료</th>
              <th className="num-right">미지급</th>
              <th className="num-right" style={{ width: 60 }}>건수</th>
              <th className="num-right" style={{ width: 70 }}>비중</th>
              <th style={{ width: 180 }}>비율</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="fw-700">{r.vendor}</td>
                <td className="num-cell num-right" style={{ color: "var(--pos)" }}>{r.paid ? fmtNum(r.paid) : "—"}</td>
                <td className="num-cell num-right" style={{ color: r.pending ? "var(--warn)" : "var(--muted)" }}>
                  {r.pending ? fmtNum(r.pending) : "—"}
                </td>
                <td className="num-right text-muted">{r.count}건</td>
                <td className="num-right text-muted">{total > 0 ? (r.total / total * 100).toFixed(1) : 0}%</td>
                <td><RBar pct={total > 0 ? (r.total / total) * 100 : 0} tone="warn"/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 8. 방산 납품 실적 보고서 ────────────────────────────────
const ReportDefense = ({ toast }) => {
  const [expanded, setExpanded] = useState(null)
  const rows = SAMPLE.contractSummary
  const totalAmount = rows.reduce((a, r) => a + r.amount, 0)
  const totalDone   = rows.reduce((a, r) => a + r.inDone, 0)

  return (
    <div>
      <div className="card card-pad" style={{ background: "var(--surface-2)", marginBottom: 24 }}>
        <div className="row gap-12" style={{ marginBottom: 8 }}>
          <div className="text-sm fw-700">방산물자 납품 이행률</div>
          <span className="num fw-700 ml-auto" style={{ color: "var(--pos)" }}>{(totalDone / totalAmount * 100).toFixed(1)}%</span>
        </div>
        <RBar pct={(totalDone / totalAmount) * 100} tone="pos"/>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
        <StatCard label="총 수주금액"   value={totalAmount}/>
        <StatCard label="납품 완료금액" value={totalDone} tone="pos"/>
        <StatCard label="잔여금액"      value={totalAmount - totalDone}/>
      </div>
      <div className="col gap-12">
        {rows.map((r, i) => {
          const pct  = r.inDone / r.amount * 100
          const open = expanded === i
          return (
            <div key={i} className="card" style={{ overflow: "hidden" }}>
              {/* 계약 헤더 */}
              <button
                onClick={() => setExpanded(open ? null : i)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", width: "100%", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", borderBottom: open ? "1px solid var(--line)" : "none" }}
              >
                <div style={{ textAlign: "left", flex: 1 }}>
                  <div className="fw-700 text-sm">{r.contractNo}</div>
                  <div className="text-sm text-muted" style={{ marginTop: 2 }}>{r.buyer} · {(r.name || '').split("(")[0].trim()}</div>
                </div>
                <div style={{ textAlign: "right", minWidth: 100 }}>
                  <div className="num fw-700" style={{ fontSize: 15 }}>{fmtNum(r.amount)}원</div>
                  <div className="text-xs text-muted" style={{ marginTop: 2 }}>이행 {pct.toFixed(0)}%</div>
                </div>
                <div style={{ width: 80 }}><RBar pct={pct} tone="pos"/></div>
                <StatusBadge status={r.status}/>
                <Icon.Right size={13} style={{ color: "var(--muted2)", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s", flexShrink: 0 }}/>
              </button>
              {/* 품목 테이블 */}
              {open && (
                <table className="table">
                  <thead>
                    <tr>
                      <th>품목번호</th>
                      <th>품목명</th>
                      <th className="num-right">수량</th>
                      <th>단위</th>
                      <th className="num-right">단가</th>
                      <th className="num-right">금액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(r.items || []).map((it, j) => (
                      <tr key={j}>
                        <td className="text-sm text-muted">{it.no}</td>
                        <td className="fw-600 text-sm">{it.name}</td>
                        <td className="num-cell num-right">{it.qty.toLocaleString()}</td>
                        <td className="text-sm text-muted">{it.unit}</td>
                        <td className="num-cell num-right">{fmtNum(it.unitPrice)}</td>
                        <td className="num-cell num-right fw-700">{fmtNum(it.total)}</td>
                      </tr>
                    ))}
                    <tr style={{ background: "var(--surface-2)" }}>
                      <td colSpan={5} className="fw-700 text-sm">합계</td>
                      <td className="num-cell num-right fw-700">{fmtNum((r.items || []).reduce((a, it) => a + it.total, 0))}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── 9. 세무사 전달용 자료 ────────────────────────────────────
const TAXOFFICE_DOCS = [
  { label: "월별 입출금 내역",         count: "16건", ready: true  },
  { label: "지출결의서 (승인 완료)",    count: "7건",  ready: true  },
  { label: "세금계산서 (매출)",         count: "5건",  ready: true  },
  { label: "세금계산서 (매입)",         count: "8건",  ready: true  },
  { label: "급여대장",                  count: "7명",  ready: true  },
  { label: "원천징수이행상황신고서",    count: "1건",  ready: true  },
  { label: "증빙 누락 항목",            count: "3건",  ready: false },
]

const ReportTaxOffice = ({ toast }) => {
  const [period, setPeriod] = useState("2026년 5월")
  return (
    <div>
      <div className="row gap-12" style={{ marginBottom: 24, alignItems: "flex-end" }}>
        <div>
          <div className="text-sm fw-600" style={{ marginBottom: 8 }}>전달 기간</div>
          <div className="row gap-8">
            {["2026년 3월", "2026년 4월", "2026년 5월"].map(m => (
              <button key={m} className={`chip ${period === m ? "active" : ""}`} onClick={() => setPeriod(m)}>{m}</button>
            ))}
          </div>
        </div>
        <button className="btn primary ml-auto" onClick={() => toast.push(`${period} 자료를 ZIP으로 내려받았어요`)}>
          <Icon.Download size={14}/> ZIP 내려받기
        </button>
      </div>
      <div className="col gap-8" style={{ marginBottom: 24 }}>
        {TAXOFFICE_DOCS.map((d, i) => (
          <div key={i} className="row gap-12" style={{ padding: "12px 16px", border: "1px solid var(--line)", borderRadius: 12, background: "#fff" }}>
            <div style={{ width: 22, height: 22, borderRadius: 6, background: d.ready ? "var(--pos-soft)" : "var(--neg-soft)", display: "grid", placeItems: "center", flexShrink: 0 }}>
              {d.ready
                ? <Icon.Check size={11} style={{ color: "var(--pos)" }}/>
                : <Icon.Warn  size={11} style={{ color: "var(--neg)" }}/>}
            </div>
            <span className="fw-600 text-sm">{d.label}</span>
            <span className="badge outline ml-auto">{d.count}</span>
          </div>
        ))}
      </div>
      {TAXOFFICE_DOCS.some(d => !d.ready) && (
        <div className="alert-row" style={{ background: "var(--warn-soft)", borderColor: "transparent" }}>
          <Icon.Warn/>
          <div>
            <div className="lead">증빙 누락 항목이 있어요</div>
            <div className="body">누락 항목을 먼저 처리하면 더 완전한 자료를 전달할 수 있어요.</div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 10. 부가세 신고 자료 ─────────────────────────────────────
const ReportVAT = ({ toast }) => {
  const [quarter, setQuarter] = useState("Q2")
  const [vatData, setVatData] = useState(null)

  useEffect(() => {
    import('../lib/api').then(({ api }) => {
      api.getVatSummary(quarter).then(setVatData)
    })
  }, [quarter])

  if (!vatData) return <div className="text-muted text-sm" style={{ padding: 24 }}>불러오는 중...</div>

  const { salesVat, purchaseVat, netVat, salesInvoices, purchaseInvoices } = vatData
  const QUARTER_LABEL = { Q1: "1분기 (1~3월)", Q2: "2분기 (4~6월)", Q3: "3분기 (7~9월)", Q4: "4분기 (10~12월)" }
  const salesTotal = salesInvoices.reduce((a, r) => a + r.supplyAmount, 0)
  const purchaseTotal = purchaseInvoices.reduce((a, r) => a + r.supplyAmount, 0)

  return (
    <div>
      {/* 분기 선택 */}
      <div className="row gap-8" style={{ marginBottom: 16 }}>
        <span className="text-sm text-muted fw-600" style={{ lineHeight: "28px" }}>신고 분기</span>
        {["Q1", "Q2", "Q3", "Q4"].map(q => (
          <button key={q} className={`chip${quarter === q ? " active" : ""}`} onClick={() => setQuarter(q)}>
            {QUARTER_LABEL[q]}
          </button>
        ))}
      </div>

      {/* 신고 기간 */}
      <div className="card card-pad" style={{ background: "var(--brand-soft)", borderColor: "transparent", marginBottom: 12 }}>
        <div className="row gap-8">
          <Icon.Bell size={14}/>
          <span className="text-sm fw-600">신고 기간: 2026.04.01 ~ 2026.06.30 (2기 예정신고)</span>
          <span className="text-xs text-muted" style={{ marginLeft: 4 }}>신고 기한: 2026년 7월 25일</span>
        </div>
      </div>

      {/* 영세율 경고 */}
      <div className="card card-pad" style={{ background: "oklch(0.98 0.015 60)", borderColor: "oklch(0.88 0.06 60)", marginBottom: 16 }}>
        <div className="row gap-8" style={{ alignItems: "flex-start" }}>
          <Icon.Warn size={15} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }}/>
          <div>
            <div className="text-sm fw-700" style={{ color: "oklch(0.5 0.12 55)", marginBottom: 4 }}>
              방산업체 영세율(0%) 주의 — 세무사 확인 필수
            </div>
            <div className="text-xs" style={{ color: "oklch(0.55 0.08 55)", lineHeight: 1.6 }}>
              한화에어로스페이스·LIG넥스원 등 방산업체 납품 매출은 부가가치세법 §21에 따라
              영세율(0%) 적용 대상일 수 있습니다. 영세율 적용 시 매출세액은 0원이며,
              매입세액은 전액 환급 대상이 됩니다.
              아래 수치는 단순 참고용이며 실제 신고 전 반드시 담당 세무사와 확인하세요.
            </div>
          </div>
        </div>
      </div>

      {/* 요약 카드 */}
      <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
        <StatCard label="매출세액 (참고)" value={salesVat}                            tone="pos"/>
        <StatCard label="매입세액 (참고)" value={purchaseVat}                         tone="neg"/>
        <StatCard label="납부세액 (참고)" value={netVat} tone={netVat > 0 ? "neg" : "pos"}/>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* 매출 */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="row" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
            <div className="section-title" style={{ fontSize: 14 }}>매출 (세금계산서 발행)</div>
            <span className="badge pos ml-auto">{fmtNum(salesTotal)}원</span>
          </div>
          <table className="table">
            <thead><tr><th>거래처</th><th className="num-right">공급가액</th><th className="num-right">산출세액*</th></tr></thead>
            <tbody>
              {salesInvoices.map((r, i) => (
                <tr key={i}>
                  <td className="fw-600 text-sm">{r.vendor}</td>
                  <td className="num-cell num-right text-sm">{fmtNum(r.supplyAmount)}</td>
                  <td className="num-cell num-right text-sm" style={{ color: "var(--pos)" }}>{fmtNum(r.vatAmount)}</td>
                </tr>
              ))}
              {salesInvoices.length === 0 && (
                <tr><td colSpan={3} className="text-muted text-sm" style={{ textAlign: "center", padding: 16 }}>해당 분기 매출 세금계산서 없음</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 매입 */}
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="row" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
            <div className="section-title" style={{ fontSize: 14 }}>매입 (세금계산서 수취)</div>
            <span className="badge warn ml-auto">{fmtNum(purchaseTotal)}원</span>
          </div>
          <table className="table">
            <thead><tr><th>거래처</th><th className="num-right">공급가액</th><th className="num-right">산출세액*</th></tr></thead>
            <tbody>
              {purchaseInvoices.map((r, i) => (
                <tr key={i}>
                  <td className="fw-600 text-sm">{r.vendor}</td>
                  <td className="num-cell num-right text-sm">{fmtNum(r.supplyAmount)}</td>
                  <td className="num-cell num-right text-sm" style={{ color: "var(--neg)" }}>{fmtNum(r.vatAmount)}</td>
                </tr>
              ))}
              {purchaseInvoices.length === 0 && (
                <tr><td colSpan={3} className="text-muted text-sm" style={{ textAlign: "center", padding: 16 }}>해당 분기 매입 세금계산서 없음</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-muted" style={{ marginTop: 12 }}>
        * 산출세액은 공급가액 × 10% 단순 계산치입니다. 영세율·면세 항목은 별도 적용이 필요합니다.
      </div>
    </div>
  )
}

const REPORT_VIEWS = {
  monthly: ReportMonthly, tax4: ReportTax4, contract: ReportContract,
  category: ReportCategory, vendor: ReportVendor, ar: ReportAR,
  subcontract: ReportSubcontract, defense: ReportDefense,
  taxoffice: ReportTaxOffice, vat: ReportVAT,
}

export const ReportsScreen = () => {
  const toast = useToast()
  const [active, setActive] = useState(null)
  const report = REPORTS.find(r => r.id === active)

  if (active && report) {
    const View = REPORT_VIEWS[active]
    return (
      <div className="fade-up">
        <div className="row" style={{ marginBottom: 20 }}>
          <button className="btn" onClick={() => setActive(null)}><Icon.Left size={14}/> 보고서 목록</button>
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={() => toast.push("PDF로 내려받았어요")}><Icon.Download size={14}/> PDF</button>
            <button className="btn excel" onClick={() => toast.push("엑셀로 내려받았어요")}><Icon.Excel size={14}/> 엑셀</button>
          </div>
        </div>
        <div className="page-title" style={{ marginBottom: 4 }}>{report.t}</div>
        <div className="page-sub" style={{ marginBottom: 24 }}>2026년 5월 기준 · 2026.05.19 조회</div>
        <View toast={toast}/>
      </div>
    )
  }

  return (
    <div className="fade-up">
      <div className="page-title">보고서</div>
      <div className="page-sub">월별·계약별·발주처별·세무사 전달용 자료를 한 번에 확인하세요.</div>
      <Spacer h={20}/>
      <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        {REPORTS.map(r => (
          <button key={r.id} className="card card-pad"
            onClick={() => setActive(r.id)}
            style={{ cursor: "pointer", textAlign: "left", fontFamily: "inherit", border: "1px solid var(--line)", transition: "border-color .12s, background .12s" }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--line-strong)"; e.currentTarget.style.background = "var(--surface-2)" }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--line)"; e.currentTarget.style.background = "" }}>
            <div className="row" style={{ marginBottom: 14 }}>
              <div style={{ width: 32, height: 32, borderRadius: 10, background: "var(--brand-soft)", color: "var(--brand)", display: "grid", placeItems: "center" }}>
                <Icon.Chart size={16}/>
              </div>
              <span className="ml-auto text-muted2"><Icon.Right size={14}/></span>
            </div>
            <div className="fw-700" style={{ marginBottom: 4 }}>{r.t}</div>
            <div className="text-sm text-muted">{r.d}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
