import { useState, useEffect, Fragment } from 'react'
import { Icon, fmtNum, useToast, Spacer, StatusBadge, Drawer } from '../lib/ui'
import { SAMPLE } from '../lib/data'
import { HR_EMPLOYEES, calcPayslip, MONTHLY_EXTRA } from './HR'

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
                    <input className="input num" value={fmtNum(form.supply)} onChange={e => {
                      const v = parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0;
                      const vat = Math.round(v * 0.1);
                      setForm({...form, supply: v, vat, total: v + vat});
                    }}/>
                  </div>
                  <div>
                    <label className="label">부가세</label>
                    <input className="input num" value={fmtNum(form.vat)} onChange={e => {
                      const vv = parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0;
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
                  <input className="input num fw-700" style={{ fontSize: 22 }} value={fmtNum(form.total) + " 원"}
                    onChange={e => {
                      const v = parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0;
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
export const DocsScreen = ({ openExpense }) => {
  const toast = useToast();
  const [sel, setSel] = useState(SAMPLE.docs[0]);
  const [tab, setTab] = useState("전체");
  const tabs = ["전체", "작성중", "승인 요청", "승인 완료", "반려"];
  const list = SAMPLE.docs.filter(d => tab === "전체" || d.status === tab);

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 20 }}>
        <div>
          <div className="page-title">결의서 관리</div>
          <div className="page-sub">지출결의서를 한 곳에서 작성·승인·인쇄하세요.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={() => toast.push("양식 설정 화면을 열었어요")}><Icon.Cog/> 양식 설정</button>
          <button className="btn primary" onClick={openExpense}><Icon.Plus/> 새 결의서</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "clamp(280px, 360px, 400px) 1fr", gap: 16, alignItems: "start" }}>
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="row gap-6" style={{ padding: 12, borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
            {tabs.map(t => (
              <button key={t} className={`chip ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>
          <div style={{ maxHeight: 720, overflowY: "auto" }}>
            {list.map((d, i) => {
              const active = sel.id === d.id;
              return (
                <div key={d.id} onClick={() => setSel(d)}
                  style={{ padding: "16px 18px", background: active ? "var(--surface-3)" : "transparent", borderTop: i === 0 ? 0 : "1px solid var(--line)", cursor: "pointer", transition: "background .12s ease" }}>
                  <div className="row gap-8" style={{ marginBottom: 8 }}>
                    <span className="num text-xs text-muted2 fw-600">{d.id}</span>
                    <span style={{ marginLeft: "auto" }}><StatusBadge status={d.status}/></span>
                  </div>
                  <div className="fw-600" style={{ marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--ink)" }}>{d.title}</div>
                  <div className="row gap-8" style={{ alignItems: "baseline" }}>
                    <span className="text-xs text-muted">{d.date}</span>
                    <span className="text-xs text-muted2">· {d.writer}</span>
                    <span style={{ marginLeft: "auto" }} className="num fw-700 text-sm">{fmtNum(d.amount)}<span className="text-muted2" style={{ fontWeight: 400, marginLeft: 2 }}>원</span></span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <DocPreview doc={sel}/>
      </div>
    </div>
  );
};

export const DocPreview = ({ doc }) => {
  const toast = useToast();
  const taxFree = /식대|교통비|세금과공과|복리후생/.test(doc.title);
  const supply  = taxFree ? doc.amount : Math.round(doc.amount / 1.1);
  const vat     = taxFree ? 0 : doc.amount - supply;

  return (
    <div>
      <div className="card" style={{ padding: "14px 16px", marginBottom: 16, display: "flex", gap: 10, alignItems: "center" }}>
        <span className="num text-sm text-muted">{doc.id}</span>
        <StatusBadge status={doc.status}/>
        <div className="ml-auto row gap-6">
          <button className="btn" onClick={() => toast.push("PDF로 내려받았어요")}><Icon.Download/> PDF</button>
          <button className="btn" onClick={() => toast.push("인쇄 창을 열었어요")}><Icon.Print/> 인쇄</button>
          {doc.status === "작성중" && <button className="btn primary" onClick={() => toast.push("승인 요청을 보냈어요")}>승인 요청</button>}
          {doc.status === "승인 요청" && <button className="btn primary" onClick={() => toast.push("결의서를 승인했어요")}>승인</button>}
        </div>
      </div>

      <div className="doc-paper">
        <div className="doc-title">지 출 결 의 서</div>
        <div className="row" style={{ marginBottom: 18, fontSize: 12 }}>
          <div>
            <div><span className="text-muted">문서번호</span> <span className="num fw-700" style={{ marginLeft: 6 }}>{doc.id}</span></div>
            <div style={{ marginTop: 4 }}><span className="text-muted">작성일</span> <span className="num" style={{ marginLeft: 6 }}>{doc.date}</span></div>
          </div>
          <div className="ml-auto">
            <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr>
                  {["담당", "승인"].map((h, i) => (
                    <th key={i} style={{ border: "1px solid #232733", padding: "4px 16px", background: "#F5F6F8", width: 72, fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ border: "1px solid #232733", width: 72, height: 72, padding: 0, textAlign: "center", verticalAlign: "middle" }}>
                    <Stamp name="한경리"/>
                  </td>
                  <td style={{ border: "1px solid #232733", width: 72, height: 72, padding: 0, textAlign: "center", verticalAlign: "middle" }}>
                    {doc.status === "승인 완료" ? <Stamp name="정대표"/>
                      : doc.status === "반려" ? <Stamp name="반려" tone="neg"/>
                      : <span style={{ color: "#aaa", fontSize: 10 }}>대기</span>}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="text-xs text-muted2" style={{ marginTop: 4, textAlign: "right" }}>작성자 → 대표 (단독 결재)</div>
          </div>
        </div>

        <table className="doc-table">
          <tbody>
            <tr><th>거래처</th><td colSpan={3}>{doc.vendor}</td></tr>
            <tr><th>계약/부서</th><td>{doc.contract}</td><th>작성자</th><td>{doc.writer} (재무팀)</td></tr>
            <tr><th>지출 목적</th><td colSpan={3}>{doc.title}</td></tr>
            <tr><th>비목</th><td>{doc.title.split(" — ")[0]}</td><th>결제수단</th><td>계좌이체</td></tr>
            <tr>
              <th>금액 (원)</th>
              <td colSpan={3}>
                <div className="row" style={{ alignItems: "center" }}>
                  <span className="num fw-700" style={{ fontSize: 18 }}>₩ {fmtNum(doc.amount)}</span>
                  <span className="ml-auto text-muted" style={{ fontSize: 11 }}>
                    {taxFree ? "(면세 비목 · 부가세 없음)" : `(공급가액 ${fmtNum(supply)} + 부가세 ${fmtNum(vat)})`}
                  </span>
                </div>
              </td>
            </tr>
            <tr><th>증빙 종류</th><td>{taxFree ? "영수증 1건" : "세금계산서 1건 · 카드영수증 1건"}</td><th>지급예정일</th><td className="num">{doc.date}</td></tr>
            <tr>
              <th>비고</th>
              <td colSpan={3} style={{ height: 70, verticalAlign: "top", paddingTop: 10, color: "#444", fontSize: 12 }}>
                해당 비용은 {doc.contract} 관련 비용으로, 첨부 증빙에 따라 집행함.
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ marginTop: 18, fontSize: 11, color: "#555" }}>첨부 증빙</div>
        <div className="row gap-6" style={{ marginTop: 6, flexWrap: "wrap" }}>
          {taxFree ? (
            <span className="file-pill" style={{ background: "#F2F4F7" }}><Icon.Image size={12}/> 영수증_원본.jpg</span>
          ) : (
            <>
              <span className="file-pill" style={{ background: "#F2F4F7" }}><Icon.File size={12}/> 세금계산서_원본.pdf</span>
              <span className="file-pill" style={{ background: "#F2F4F7" }}><Icon.Image size={12}/> 거래명세서.jpg</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

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

/* ============ 엑셀 업로드 ============ */
export const ExcelScreen = () => {
  const toast = useToast();
  const [stage] = useState(3);
  const okCount = SAMPLE.excelPreview.filter(r => r.ok).length;
  const errCount = SAMPLE.excelPreview.length - okCount;
  const errBuckets = [
    { key: "날짜 없음",  n: 1, fix: "엑셀의 날짜 형식을 YYYY-MM-DD로 통일해주세요." },
    { key: "비목 미등록", n: 1, fix: "'유류비' 비목이 없어요. 새 비목으로 추가하거나 '교통비'로 연결할 수 있어요." },
    { key: "금액 없음",  n: 1, fix: "'오피스디포' 행의 금액이 비어 있어요." },
  ];

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 6 }}>
        <div>
          <div className="page-title">엑셀 업로드</div>
          <div className="page-sub">기존 입출금 자료를 엑셀로 한 번에 등록하세요.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn"><Icon.Download/> 양식 다운로드</button>
        </div>
      </div>
      <Spacer h={20}/>

      <div className="row gap-12" style={{ marginBottom: 20 }}>
        {[{ n: 1, t: "파일 업로드" },{ n: 2, t: "데이터 유형" },{ n: 3, t: "컬럼 매핑 · 미리보기" },{ n: 4, t: "일괄 등록" }].map((s, i, arr) => (
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

      <div className="grid" style={{ gridTemplateColumns: "1fr clamp(240px, 280px, 320px)", gap: 16, alignItems: "start" }}>
        <div className="col gap-16">
          <div className="card card-pad">
            <div className="row gap-12">
              <div style={{ width: 44, height: 44, borderRadius: 10, background: "#E7F4ED", color: "var(--pos)", display: "grid", placeItems: "center" }}>
                <Icon.Excel size={22}/>
              </div>
              <div>
                <div className="fw-700">2026년_5월_지출입금.xlsx</div>
                <div className="text-xs text-muted2">312KB · {SAMPLE.excelPreview.length}행 · 방금 업로드됨</div>
              </div>
              <div className="ml-auto row gap-6">
                <button className="btn sm">다시 업로드</button>
                <button className="btn ghost sm"><Icon.Close size={14}/></button>
              </div>
            </div>
          </div>

          <div className="card card-pad">
            <div className="section-title" style={{ marginBottom: 4 }}>컬럼 매핑</div>
            <div className="section-sub" style={{ marginBottom: 14 }}>엑셀의 컬럼이 우리 항목과 어떻게 연결될지 확인하세요.</div>
            <div className="table-scroll">
              <table className="table" style={{ marginTop: 6 }}>
                <thead>
                  <tr><th>엑셀 컬럼</th><th>샘플 값</th><th style={{ width: 220 }}>매핑 항목</th></tr>
                </thead>
                <tbody>
                  {[
                    { col: "거래일자", sample: "2026-05-12",     mapped: "날짜" },
                    { col: "상호",     sample: "디자인스튜디오 R", mapped: "거래처" },
                    { col: "프로젝트", sample: "도면관리 구축",    mapped: "계약명" },
                    { col: "구분",     sample: "지출",            mapped: "입금/지출 구분" },
                    { col: "계정",     sample: "외주비",          mapped: "비목" },
                    { col: "금액",     sample: "1,500,000",       mapped: "금액" },
                    { col: "비고",     sample: "5월분",           mapped: "메모" },
                  ].map((r, i) => (
                    <tr key={i}>
                      <td className="fw-600">{r.col}</td>
                      <td className="text-muted num text-sm">{r.sample}</td>
                      <td>
                        <div className="row gap-6" style={{ alignItems: "center" }}>
                          <Icon.Right size={12} className="text-muted2"/>
                          <select defaultValue={r.mapped} style={{ flex: 1, fontSize: 13, fontFamily: "inherit", fontWeight: 600, padding: "7px 28px 7px 12px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "#fff", appearance: "none", cursor: "pointer" }}>
                            {["날짜","거래처","계약명","입금/지출 구분","비목","금액","메모","결제수단","증빙 번호","사용 안함"].map(o => (
                              <option key={o} value={o}>{o}</option>
                            ))}
                          </select>
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
                <span className="badge pos"><Icon.Check size={11}/> 정상 {okCount}</span>
                <span className="badge neg"><Icon.Warn size={11}/> 오류 {errCount}</span>
              </div>
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr><th style={{ width: 40 }}>행</th><th>날짜</th><th>거래처</th><th>계약</th><th>구분</th><th>비목</th><th className="num-right">금액</th><th>상태</th></tr>
                </thead>
                <tbody>
                  {SAMPLE.excelPreview.map((r, i) => (
                    <tr key={i} style={{ background: r.ok ? undefined : "rgba(255, 80, 80, 0.04)" }}>
                      <td className="num text-muted2">{r.row}</td>
                      <td className="num text-sm">{r.date || <span className="text-neg">—</span>}</td>
                      <td className="fw-600">{r.vendor}</td>
                      <td className="text-muted text-sm">{r.contract}</td>
                      <td><span className="badge outline">{r.type}</span></td>
                      <td className="text-sm">{r.category}</td>
                      <td className="num-cell num-right">{r.amount ? fmtNum(r.amount) : <span className="text-neg">—</span>}</td>
                      <td>
                        {r.ok
                          ? <span className="badge pos"><Icon.Check size={11}/> 정상</span>
                          : <span className="badge neg"><Icon.Warn size={11}/> {r.err}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ padding: 16, borderTop: "1px solid var(--line)" }}>
              <span className="text-sm text-muted">오류 {errCount}건을 먼저 수정한 다음 등록하면, 정상 {okCount}건이 한 번에 등록돼요.</span>
              <div className="ml-auto row gap-8">
                <button className="btn" onClick={() => toast.push("업로드를 취소했어요")}>취소</button>
                <button className="btn primary" disabled={errCount > 0} style={{ opacity: errCount > 0 ? 0.5 : 1 }} onClick={() => errCount === 0 && toast.push(`${okCount}건이 등록되었어요`)}>
                  <Icon.Check size={14}/> {okCount}건 일괄 등록
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="col gap-16" style={{ position: "sticky", top: 88 }}>
          <div className="card card-pad">
            <div className="row" style={{ marginBottom: 10 }}>
              <div className="section-title">오류 수정 도우미</div>
              <span className="badge neg ml-auto">{errCount}건</span>
            </div>
            <div className="section-sub" style={{ marginBottom: 14 }}>한 번에 고치고 다시 미리보기로 돌아갈 수 있어요.</div>
            <div className="col gap-10">
              {errBuckets.map((e, i) => (
                <div key={i} style={{ padding: 12, border: "1px solid var(--line)", borderRadius: 12, background: "var(--surface-2)" }}>
                  <div className="row" style={{ marginBottom: 4 }}>
                    <span className="fw-700 text-sm">{e.key}</span>
                    <span className="badge neg ml-auto">{e.n}건</span>
                  </div>
                  <div className="text-xs text-muted">{e.fix}</div>
                  <button className="btn sm" style={{ marginTop: 10 }} onClick={() => toast.push(`${e.key} 오류를 일괄 수정했어요`)}>고치기</button>
                </div>
              ))}
            </div>
          </div>
          <div className="card card-pad" style={{ background: "var(--brand-soft)", borderColor: "transparent" }}>
            <div className="row gap-8" style={{ marginBottom: 6 }}>
              <Icon.Sparkle/>
              <div className="fw-700">엑셀 한 번에 정리하기</div>
            </div>
            <div className="text-sm" style={{ color: "var(--brand-ink)" }}>
              은행 거래내역(CSV)도 같은 방식으로 업로드하면 거래처별로 자동 분류돼요.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

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
  ...SAMPLE.incomes.map(r => r.date.slice(0, 7)),
  ...SAMPLE.expenses.map(r => r.date.slice(0, 7)),
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
    const m = r.date.slice(0, 7)
    if (!bucket[m]) bucket[m] = { income: 0, expense: 0 }
    bucket[m].income += r.amount
  })
  expenses.forEach(r => {
    const m = r.date.slice(0, 7)
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
  const active = HR_EMPLOYEES.filter(e => e.status === "재직" || e.status === "수습")
  const payslips = active.map(e => ({ emp: e, slip: calcPayslip(e, MONTHLY_EXTRA[e.code] || {}) }))
  const sum = (key) => payslips.reduce((a, p) => a + (p.slip[key] || 0), 0)

  return (
    <div>
      <div className="card card-pad" style={{ background: "var(--brand-soft)", borderColor: "transparent", marginBottom: 16 }}>
        <div className="row gap-8">
          <Icon.Bell size={14}/>
          <span className="text-sm fw-600">다음 납부 기한: 2026년 6월 10일 (수)</span>
          <span className="text-xs text-muted" style={{ marginLeft: 4 }}>원천세 신고·납부 / 4대보험료 고지 납부</span>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
        <StatCard label="급여 총액"     value={sum("gross")}/>
        <StatCard label="원천징수 합계" value={sum("incomeTax") + sum("localTax")} tone="neg"/>
        <StatCard label="4대보험(개인)" value={sum("pension") + sum("health") + sum("jobless")} tone="warn"/>
        <StatCard label="4대보험(회사)" value={sum("employerTotal")}/>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>성명</th><th>직위</th>
              <th className="num-right">급여총액</th>
              <th className="num-right">근로소득세</th>
              <th className="num-right">지방소득세</th>
              <th className="num-right">국민연금</th>
              <th className="num-right">건강보험</th>
              <th className="num-right">고용보험</th>
              <th className="num-right">실지급액</th>
            </tr>
          </thead>
          <tbody>
            {payslips.map(({ emp, slip }, i) => (
              <tr key={i}>
                <td className="fw-700">{emp.name}</td>
                <td className="text-sm text-muted">{emp.pos}</td>
                <td className="num-cell num-right">{fmtNum(slip.gross)}</td>
                <td className="num-cell num-right" style={{ color: "var(--neg)" }}>{fmtNum(slip.incomeTax)}</td>
                <td className="num-cell num-right" style={{ color: "var(--neg)" }}>{fmtNum(slip.localTax)}</td>
                <td className="num-cell num-right" style={{ color: "var(--warn-ink)" }}>{fmtNum(slip.pension)}</td>
                <td className="num-cell num-right" style={{ color: "var(--warn-ink)" }}>{fmtNum(slip.health)}</td>
                <td className="num-cell num-right" style={{ color: "var(--warn-ink)" }}>{fmtNum(slip.jobless)}</td>
                <td className="num-cell num-right fw-700">{fmtNum(slip.net)}</td>
              </tr>
            ))}
            <tr style={{ background: "var(--surface-2)" }}>
              <td colSpan={2} className="fw-700">합계</td>
              <td className="num-cell num-right fw-700">{fmtNum(sum("gross"))}</td>
              <td className="num-cell num-right" style={{ color: "var(--neg)" }}>{fmtNum(sum("incomeTax"))}</td>
              <td className="num-cell num-right" style={{ color: "var(--neg)" }}>{fmtNum(sum("localTax"))}</td>
              <td className="num-cell num-right" style={{ color: "var(--warn-ink)" }}>{fmtNum(sum("pension"))}</td>
              <td className="num-cell num-right" style={{ color: "var(--warn-ink)" }}>{fmtNum(sum("health"))}</td>
              <td className="num-cell num-right" style={{ color: "var(--warn-ink)" }}>{fmtNum(sum("jobless"))}</td>
              <td className="num-cell num-right fw-700">{fmtNum(sum("net"))}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 회사 부담 4대보험 항목별 */}
      <div className="card" style={{ overflow: "hidden", marginTop: 16 }}>
        <div className="row" style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}>
          <div className="section-title" style={{ fontSize: 14 }}>회사 부담 4대보험 납부 명세</div>
          <span className="badge outline ml-auto">합계 {fmtNum(sum("pensionEmp") + sum("healthEmp") + sum("careEmp") + sum("joblessEmp") + sum("accidentEmp"))}원</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>항목</th>
              <th>납부처</th>
              <th className="num-right">금액</th>
            </tr>
          </thead>
          <tbody>
            {[
              { label: "국민연금 (회사분)",    agency: "국민연금공단",       key: "pensionEmp" },
              { label: "건강보험 (회사분)",    agency: "국민건강보험공단",   key: "healthEmp" },
              { label: "장기요양보험 (회사분)", agency: "국민건강보험공단",  key: "careEmp" },
              { label: "고용보험 (회사분)",    agency: "근로복지공단",       key: "joblessEmp" },
              { label: "산재보험 (회사분)",    agency: "근로복지공단",       key: "accidentEmp" },
            ].map((item, i) => (
              <tr key={i}>
                <td className="fw-600 text-sm">{item.label}</td>
                <td className="text-sm text-muted">{item.agency}</td>
                <td className="num-cell num-right">{fmtNum(sum(item.key))}</td>
              </tr>
            ))}
            <tr style={{ background: "var(--surface-2)" }}>
              <td colSpan={2} className="fw-700">합계</td>
              <td className="num-cell num-right fw-700">{fmtNum(sum("employerTotal"))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 3. 계약별 손익 현황 ──────────────────────────────────────
const ReportContract = ({ toast }) => {
  const rows = SAMPLE.contractSummary.map(c => ({ ...c, margin: c.profit / c.amount * 100 }))
  const totalAmount = rows.reduce((a, r) => a + r.amount, 0)
  const totalProfit = rows.reduce((a, r) => a + r.profit, 0)

  return (
    <div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 24 }}>
        <StatCard label="총 수주금액" value={totalAmount}/>
        <StatCard label="총 손익"     value={totalProfit} tone="pos"/>
        <StatCard label="평균 이익률" value={parseFloat((totalProfit / totalAmount * 100).toFixed(1))} unit="%" tone="pos"/>
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
  const { summary, rows } = SAMPLE.receivables
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
        <StatCard label="총 지출 대비"   value={parseFloat((total / totalExp * 100).toFixed(1))} unit="%"/>
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
                <td className="num-right text-muted">{(r.total / total * 100).toFixed(1)}%</td>
                <td><RBar pct={(r.total / total) * 100} tone="warn"/></td>
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
                  <div className="text-sm text-muted" style={{ marginTop: 2 }}>{r.buyer} · {r.name.split("(")[0].trim()}</div>
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
                    {r.items.map((it, j) => (
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
                      <td className="num-cell num-right fw-700">{fmtNum(r.items.reduce((a, it) => a + it.total, 0))}</td>
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
