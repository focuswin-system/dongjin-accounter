import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, Combobox } from '../lib/ui'

const VENDORS_INCOME = [
  { value: "한화에어로스페이스", label: "한화에어로스페이스", sub: "발주처 · KF-21 동체 부품" },
  { value: "LIG넥스원",          label: "LIG넥스원",          sub: "발주처 · 유도무기 정밀가공" },
  { value: "현대로템",            label: "현대로템",            sub: "발주처 · K2 변속기 케이스" },
  { value: "KAI",                label: "KAI",                sub: "발주처 · 헬기 외장 패널" },
  { value: "한화시스템",         label: "한화시스템",         sub: "발주처 · 레이더 하우징" },
  { value: "풍산",                label: "풍산",                sub: "발주처 · 탄피 황동 가공" },
  { value: "(주)대선기공",        label: "(주)대선기공",        sub: "발주처 · 함정 추진계 (보류)" },
  { value: "(주)서울항공",        label: "(주)서울항공",        sub: "발주처 · 기체 패스너 (완료)" },
];
const VENDORS_EXPENSE = [
  { value: "정밀도금 (주)",       label: "정밀도금 (주)",      sub: "외주가공 · 표면처리" },
  { value: "(주)한울정밀",        label: "(주)한울정밀",       sub: "외주가공 · CNC" },
  { value: "(주)동아표면처리",    label: "(주)동아표면처리",   sub: "외주가공 · 도금" },
  { value: "포스코강판",           label: "포스코강판",          sub: "원자재 · 강판" },
  { value: "(주)대원특수강",       label: "(주)대원특수강",      sub: "원자재 · 특수강" },
  { value: "한국기계연구원",       label: "한국기계연구원",      sub: "시험·인증" },
  { value: "한국화학연구원",       label: "한국화학연구원",      sub: "시험·인증 · 재질 분석" },
  { value: "다이아공구",          label: "다이아공구",          sub: "공구·소모품" },
  { value: "한국산업안전공단",    label: "한국산업안전공단",    sub: "안전관리" },
  { value: "임대인 박OO",          label: "임대인 박OO",         sub: "임차 · 공장" },
  { value: "프리랜서 설계 박OO",   label: "프리랜서 설계 박OO",  sub: "외주 · 설계용역" },
];
const CONTRACTS_OPT = [
  { value: "KF-21 동체 부품",      label: "KF-21 동체 부품",      sub: "한화에어로스페이스 · 진행중" },
  { value: "유도무기 정밀가공",     label: "유도무기 정밀가공",     sub: "LIG넥스원 · 진행중" },
  { value: "K2 변속기 케이스",     label: "K2 변속기 케이스",     sub: "현대로템 · 진행중" },
  { value: "헬기 외장 패널",       label: "헬기 외장 패널",       sub: "KAI · 진행중" },
  { value: "레이더 하우징",         label: "레이더 하우징",         sub: "한화시스템 · 진행중" },
  { value: "탄피 황동 가공",        label: "탄피 황동 가공",        sub: "풍산 · 진행중" },
  { value: "함정 추진계 정밀가공",  label: "함정 추진계 정밀가공",  sub: "(주)대선기공 · 보류" },
  { value: "공통(원자재)",         label: "공통(원자재)",         sub: "특정 계약 없음" },
  { value: "공통(생산소모)",       label: "공통(생산소모)",       sub: "특정 계약 없음" },
  { value: "공통",                  label: "공통",                  sub: "사무·운영" },
];
const CATEGORIES_INCOME = [
  { value: "선급금",       label: "선급금",       sub: "납품수익" },
  { value: "기성고",       label: "기성고",       sub: "납품수익" },
  { value: "검수 후 결제", label: "검수 후 결제", sub: "납품수익" },
  { value: "납품대금",     label: "납품대금",     sub: "납품수익" },
  { value: "잔금",          label: "잔금",          sub: "납품수익" },
  { value: "용역수익",     label: "용역수익",     sub: "기타수익" },
  { value: "환급금",        label: "환급금",        sub: "기타수익" },
  { value: "잡수익",        label: "잡수익",        sub: "기타수익" },
];
const CATEGORIES_EXPENSE = [
  { value: "철강 원자재",       label: "철강 원자재",       sub: "재료비" },
  { value: "비철금속",           label: "비철금속 (알루미늄·황동)", sub: "재료비" },
  { value: "특수강",              label: "특수강",              sub: "재료비" },
  { value: "정밀가공 외주",     label: "정밀가공 외주",     sub: "외주가공비" },
  { value: "표면처리 외주",     label: "표면처리 외주",     sub: "외주가공비" },
  { value: "도금 외주",          label: "도금 외주",          sub: "외주가공비" },
  { value: "열처리 외주",       label: "열처리 외주",       sub: "외주가공비" },
  { value: "용접 외주",          label: "용접 외주",          sub: "외주가공비" },
  { value: "공구비",             label: "공구비",             sub: "공구·소모품" },
  { value: "측정공구비",         label: "측정공구비",         sub: "공구·소모품" },
  { value: "소모품비",           label: "소모품비",           sub: "공구·소모품" },
  { value: "시험검사비",         label: "시험검사비",         sub: "시험·인증비" },
  { value: "검사성적서 발급",   label: "검사성적서 발급",   sub: "시험·인증비" },
  { value: "방산인증 수수료",   label: "방산인증 수수료",   sub: "시험·인증비" },
  { value: "임차료",             label: "임차료",             sub: "운영비" },
  { value: "전력비",             label: "전력비",             sub: "운영비" },
  { value: "통신비",             label: "통신비",             sub: "운영비" },
  { value: "운반비",             label: "운반비",             sub: "운영비" },
  { value: "식대",                label: "식대",                sub: "여비·교통비 · 비과세" },
  { value: "교통비",             label: "교통비",             sub: "여비·교통비 · 비과세" },
  { value: "출장비",             label: "출장비",             sub: "여비·교통비 · 비과세" },
  { value: "안전관리비",         label: "안전관리비",         sub: "안전·환경" },
  { value: "세금과공과",         label: "세금과공과",         sub: "세금과공과" },
];

const initialFormFor = (kind) => {
  const today = new Date().toISOString().slice(0, 10);
  return kind === "income"
    ? { vendor: "", contract: "", category: "", amount: 0, account: "기업은행 *123 (주거래)", date: today, memo: "", taxFree: false, supply: 0, vat: 0 }
    : { vendor: "", contract: "", category: "", amount: 0, method: "계좌이체", employee: "", date: today, memo: "", taxFree: false, supply: 0, vat: 0, makeDoc: true };
};

const FormField = ({ label, required, hint, children }) => (
  <div>
    <label className="label" style={{ marginBottom: 8 }}>
      {label}
      {required && <span style={{ color: "var(--neg-ink)" }}> *</span>}
      {hint && <span className="text-muted2 fw-600" style={{ marginLeft: 6, fontWeight: 400 }}>· {hint}</span>}
    </label>
    {children}
  </div>
);

export const TransactionForm = ({ open, kind: initialKind = "expense", onClose }) => {
  const toast = useToast();
  const [kind, setKind] = useState(initialKind);
  const [form, setForm] = useState(initialFormFor(initialKind));
  const [showMore, setShowMore] = useState(false);

  useEffect(() => {
    if (open) { setKind(initialKind); setForm(initialFormFor(initialKind)); setShowMore(false); }
  }, [open, initialKind]);

  const switchKind = (k) => { setKind(k); setForm(initialFormFor(k)); };

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); handleSave(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, form, kind]);

  const handleSave = () => {
    if (!form.vendor)   { toast.push("거래처를 선택해주세요"); return; }
    if (!form.contract) { toast.push("계약/공통을 선택해주세요"); return; }
    if (!form.category) { toast.push(kind === "income" ? "입금 구분을 선택해주세요" : "비목을 선택해주세요"); return; }
    if (!form.amount)   { toast.push("금액을 입력해주세요"); return; }
    if (!form.date || !/^\d{4}-\d{2}-\d{2}$/.test(form.date)) { toast.push("날짜를 올바른 형식으로 입력해주세요 (예: 2026-05-15)"); return; }
    if (kind === "expense" && (form.method === "개인카드" || form.method === "현금") && !form.employee) {
      toast.push("개인카드·현금 지출은 사용 직원을 지정해주세요"); return;
    }
    onClose();
    toast.push(kind === "income" ? "입금 내역이 등록되었어요" : "지출 내역이 등록되었어요");
  };

  if (!open) return null;

  return (
    <>
      <div className="drawer-backdrop open" onClick={onClose}/>
      <aside className="drawer open" role="dialog" aria-label="거래 등록" style={{ width: "min(520px, 100vw)" }}>
        <div className="drawer-head" style={{ padding: "14px 22px" }}>
          <div style={{ display: "flex", background: "var(--surface-3)", padding: 3, borderRadius: 10, gap: 0 }}>
            <button onClick={() => switchKind("income")}
              style={{ padding: "8px 16px", border: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
                background: kind === "income" ? "#fff" : "transparent",
                color: kind === "income" ? "var(--pos)" : "var(--muted)", borderRadius: 8,
                boxShadow: kind === "income" ? "0 1px 2px rgba(15,23,42,.06)" : "none", transition: "all .12s" }}>
              <Icon.In size={14} style={{ verticalAlign: -2, marginRight: 4 }}/> 입금
            </button>
            <button onClick={() => switchKind("expense")}
              style={{ padding: "8px 16px", border: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
                background: kind === "expense" ? "#fff" : "transparent",
                color: kind === "expense" ? "var(--neg-ink)" : "var(--muted)", borderRadius: 8,
                boxShadow: kind === "expense" ? "0 1px 2px rgba(15,23,42,.06)" : "none", transition: "all .12s" }}>
              <Icon.Out size={14} style={{ verticalAlign: -2, marginRight: 4 }}/> 지출
            </button>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        <div className="drawer-body" style={{ paddingTop: 8 }}>
          <div className="col gap-16">
            <FormField label="거래처" required>
              <Combobox value={form.vendor} onChange={v => setForm({...form, vendor: v})}
                options={kind === "income" ? VENDORS_INCOME : VENDORS_EXPENSE}
                frequent={kind === "income" ? ["한화에어로스페이스", "LIG넥스원", "현대로템"] : ["정밀도금 (주)", "포스코강판", "(주)한울정밀"]}
                placeholder={kind === "income" ? "발주처를 검색하거나 선택하세요" : "거래처를 검색하거나 선택하세요"}
                onAddNew={(q) => { setForm({...form, vendor: q}); toast.push(`"${q}" 거래처를 새로 등록했어요`); }}
                addNewLabel="거래처로 추가"/>
            </FormField>

            <FormField label={kind === "income" ? "납품 계약" : "계약 / 공통"} required>
              <Combobox value={form.contract} onChange={v => setForm({...form, contract: v})}
                options={CONTRACTS_OPT}
                frequent={["KF-21 동체 부품", "유도무기 정밀가공", "공통"]}
                placeholder="계약을 검색하거나 선택하세요"
                onAddNew={(q) => { setForm({...form, contract: q}); toast.push(`"${q}" 계약을 새로 등록했어요`); }}
                addNewLabel="계약으로 추가"/>
            </FormField>

            <FormField label={kind === "income" ? "입금 구분" : "비목"} required>
              <Combobox value={form.category} onChange={v => setForm({...form, category: v})}
                options={kind === "income" ? CATEGORIES_INCOME : CATEGORIES_EXPENSE}
                frequent={kind === "income" ? ["기성고", "납품대금", "잔금"] : ["외주가공비", "재료비", "시험검사비", "임차료"]}
                placeholder={kind === "income" ? "입금 구분을 선택하세요" : "비목을 검색하거나 선택하세요"}
                onAddNew={(q) => { setForm({...form, category: q}); toast.push(`"${q}" 비목을 새로 등록했어요`); }}
                addNewLabel="비목으로 추가"/>
            </FormField>

            <FormField label="금액" required hint={kind === "expense" ? "공급가액·부가세는 자동 계산돼요" : null}>
              <div style={{ position: "relative" }}>
                <input className="input num fw-700" style={{ fontSize: 22, paddingRight: 40 }}
                  value={fmtNum(form.amount)}
                  onChange={e => {
                    const v = parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0;
                    const supply = kind === "expense" && !form.taxFree ? Math.round(v / 1.1) : v;
                    setForm({...form, amount: v, supply, vat: v - supply});
                  }}
                  placeholder="0"/>
                <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: "var(--muted-2)", fontSize: 14, fontWeight: 600 }}>원</span>
              </div>
              {kind === "expense" && form.amount > 0 && (
                <div className="row gap-6" style={{ marginTop: 8, fontSize: 11.5, color: "var(--muted)" }}>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                    <input type="checkbox" checked={form.taxFree} onChange={e => {
                      const tf = e.target.checked;
                      setForm({...form, taxFree: tf, supply: tf ? form.amount : Math.round(form.amount / 1.1), vat: tf ? 0 : form.amount - Math.round(form.amount / 1.1)});
                    }}/>
                    면세
                  </label>
                  {!form.taxFree && (
                    <span style={{ marginLeft: 8 }}>
                      공급가액 <b className="num" style={{ color: "var(--ink)" }}>{fmtNum(form.supply)}</b> ·
                      부가세 <b className="num" style={{ color: "var(--ink)" }}>{fmtNum(form.vat)}</b>
                    </span>
                  )}
                </div>
              )}
              <div className="row gap-6" style={{ marginTop: 8, flexWrap: "wrap" }}>
                {(kind === "income" ? [1000000, 5000000, 10000000, 28400000] : [120000, 500000, 1500000, 6800000]).map(a => (
                  <button key={a} type="button" className="chip" onClick={() => {
                    const supply = kind === "expense" && !form.taxFree ? Math.round(a / 1.1) : a;
                    setForm({...form, amount: a, supply, vat: a - supply});
                  }}>{fmtNum(a)}원</button>
                ))}
              </div>
            </FormField>

            {kind === "expense" ? (
              <FormField label="결제수단" required>
                <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                  {["계좌이체", "법인카드", "개인카드", "현금"].map(v => (
                    <button key={v} type="button" className={`chip ${form.method === v ? "active" : ""}`}
                      onClick={() => setForm({...form, method: v})}>
                      {v === "계좌이체" && <Icon.Bank size={12}/>}
                      {(v === "법인카드" || v === "개인카드") && <Icon.Card size={12}/>}
                      {v === "현금" && <Icon.Wallet size={12}/>}
                      {v}
                    </button>
                  ))}
                </div>
              </FormField>
            ) : (
              <FormField label="입금 계좌" required>
                <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                  {["기업은행 *123 (주거래)", "신한은행 *456 (수금)", "국민은행 *789 (예비)"].map(v => (
                    <button key={v} type="button" className={`chip ${form.account === v ? "active" : ""}`}
                      onClick={() => setForm({...form, account: v})}>
                      <Icon.Bank size={12}/>{v}
                    </button>
                  ))}
                </div>
              </FormField>
            )}

            {kind === "expense" && (
              <FormField label="사용 직원"
                required={form.method === "개인카드" || form.method === "현금"}
                hint={(form.method === "개인카드" || form.method === "현금") ? "월말 정산을 위해 지정해주세요" : "선택"}>
                <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                  {[{ name: "정수민", dept: "관리지원" }, { name: "한경리", dept: "관리지원" }, { name: "이지원", dept: "영업" }, { name: "박서연", dept: "생산" }, { name: "최민호", dept: "생산" }].map(e => (
                    <button key={e.name} type="button" className={`chip ${form.employee === e.name ? "active" : ""}`}
                      onClick={() => setForm({...form, employee: e.name})}>
                      {e.name}<span className="text-muted2" style={{ fontWeight: 400, marginLeft: 2 }}>· {e.dept}</span>
                    </button>
                  ))}
                </div>
              </FormField>
            )}

            <FormField label={kind === "income" ? "입금일" : "지출일"} required>
              <input className="input num" value={form.date} onChange={e => setForm({...form, date: e.target.value})}/>
            </FormField>

            <div>
              <button type="button"
                onClick={() => setShowMore(s => !s)}
                style={{ border: 0, background: "transparent", color: "var(--muted)", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, padding: 0, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Icon.Right size={12} style={{ transform: showMore ? "rotate(90deg)" : "none", transition: "transform .15s" }}/>
                추가 정보 (선택)
              </button>
              {showMore && (
                <div className="col gap-16" style={{ marginTop: 14 }}>
                  <FormField label="증빙 첨부">
                    <div className="drop" style={{ padding: 16 }}>
                      <Icon.Upload size={18}/>
                      <div className="text-sm fw-600" style={{ marginTop: 6 }}>파일 끌어다 놓기 또는 클릭</div>
                      <div className="text-xs text-muted2" style={{ marginTop: 2 }}>PDF, JPG, PNG · 최대 20MB</div>
                    </div>
                  </FormField>
                  <FormField label="메모">
                    <textarea className="input" rows={2} value={form.memo}
                      onChange={e => setForm({...form, memo: e.target.value})}
                      placeholder="비고 사항을 자유롭게 입력하세요"
                      style={{ resize: "vertical", fontFamily: "inherit" }}/>
                  </FormField>
                  {kind === "expense" && (
                    <FormField label="결의서">
                      <label className="row gap-10" style={{ padding: 12, border: "1px solid var(--line)", borderRadius: 10, cursor: "pointer", background: form.makeDoc ? "var(--brand-soft)" : "#fff" }}>
                        <input type="checkbox" checked={form.makeDoc} onChange={e => setForm({...form, makeDoc: e.target.checked})}/>
                        <div style={{ flex: 1 }}>
                          <div className="fw-700 text-sm">결의서 자동 생성</div>
                          <div className="text-xs text-muted">등록과 동시에 결재선(한경리 → 정대표)으로 전송됩니다.</div>
                        </div>
                      </label>
                    </FormField>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>취소</button>
          <div className="ml-auto row gap-8" style={{ alignItems: "center" }}>
            <span className="text-xs text-muted2"><span className="kbd">⌘</span> <span className="kbd">↵</span> 저장</span>
            <button className="btn primary" onClick={handleSave}><Icon.Check size={14}/> 등록</button>
          </div>
        </div>
      </aside>
    </>
  );
};
