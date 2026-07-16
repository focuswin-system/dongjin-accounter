import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge, Drawer, Combobox } from '../lib/ui'
import { MiniStat } from './Home'
import { api } from '../lib/api'

/* ───────── 급여대장: 항목별(%·수치) 계산 ───────── */
// item: { label, kind:'earn'|'deduct', mode:'fixed'|'percent', value }
// percent 항목은 '지급(earn) 고정금액 합계'(≈보수월액) 기준
export function computeItems(items) {
  const list = Array.isArray(items) ? items : [];
  const earnFixed = list.filter(i => i.kind === 'earn' && i.mode === 'fixed').reduce((s, i) => s + (Number(i.value) || 0), 0);
  const calc = list.map(i => {
    const v = Number(i.value) || 0;
    const amount = i.mode === 'percent' ? Math.round(earnFixed * v / 100) : Math.round(v);
    return { ...i, amount };
  });
  const gross = calc.filter(i => i.kind === 'earn').reduce((s, i) => s + i.amount, 0);
  const deduction = calc.filter(i => i.kind === 'deduct').reduce((s, i) => s + i.amount, 0);
  return { calc, gross, deduction, net: gross - deduction };
}

// 세무서·공단에서 받은 확정 금액을 직접 입력하는 방식.
// 기본값은 0(직접 입력) — %가 필요하면 명세서에서 항목별로 % 모드로 바꿀 수 있어요.
const DEFAULT_PAYROLL_ITEMS = (base = 0) => ([
  { label: "기본급",     kind: "earn",   mode: "fixed", value: base },
  { label: "직책수당",   kind: "earn",   mode: "fixed", value: 0 },
  { label: "식대",       kind: "earn",   mode: "fixed", value: 0 },
  { label: "국민연금",   kind: "deduct", mode: "fixed", value: 0 },
  { label: "건강보험",   kind: "deduct", mode: "fixed", value: 0 },
  { label: "장기요양",   kind: "deduct", mode: "fixed", value: 0 },
  { label: "고용보험",   kind: "deduct", mode: "fixed", value: 0 },
  { label: "소득세",     kind: "deduct", mode: "fixed", value: 0 },
  { label: "지방소득세", kind: "deduct", mode: "fixed", value: 0 },
]);

export const shiftMonth = (m, delta) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
export const monthLabel = (m) => { const [y, mo] = (m || '').split('-'); return y ? `${y}년 ${Number(mo)}월` : m; };

// 급여명세서 인쇄 — 숨김 iframe으로 렌더 후 인쇄(빈 창·팝업 차단 문제 회피)
function printPayslip(row, company = "") {
  const { calc, gross, deduction, net } = computeItems(row.items);
  const won = (n) => (Number(n) || 0).toLocaleString('ko-KR');
  const line = (l, a, neg) => `<tr><td>${l}</td><td style="text-align:right">${neg ? '-' : ''}${won(a)}</td></tr>`;
  const earns = calc.filter(i => i.kind === 'earn').map(i => line(i.label + (i.mode === 'percent' ? ` (${i.value}%)` : ''), i.amount)).join('');
  const deds  = calc.filter(i => i.kind === 'deduct').map(i => line(i.label + (i.mode === 'percent' ? ` (${i.value}%)` : ''), i.amount)).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>임금명세서 ${row.name} ${row.month}</title>
  <style>
    @page{size:A4;margin:12mm}
    html,body{margin:0}
    body{font-family:'Malgun Gothic',sans-serif;padding:0;color:#1a1a1a;max-width:720px;margin:0 auto}
    h1{font-size:21px;text-align:center;letter-spacing:8px;margin:0 0 4px}
    .co{text-align:center;color:#555;font-size:13px;margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    .info{margin-bottom:16px}
    .info th,.info td{border:1px solid #e5e5e5;padding:7px 10px}
    .info th{width:84px;text-align:left;color:#555;font-weight:600;background:#f6f7f9}
    .pay th,.pay td{border:1px solid #e5e5e5;padding:7px 10px}
    .pay th{background:#f6f7f9;text-align:left;font-size:12px}
    .num{text-align:right;font-variant-numeric:tabular-nums}
    .tot td{font-weight:700;background:#fafafa}
    .cols{display:flex}.cols>div{flex:1}
    .net{margin-top:14px;padding:12px 16px;border:2px solid #333;display:flex;justify-content:space-between;align-items:center;font-weight:800;font-size:16px}
    .foot{margin-top:16px;color:#999;font-size:12px;text-align:right}
  </style></head><body>
  <h1>임금명세서</h1>
  <div class="co">${company ? company + ' · ' : ''}${monthLabel(row.month)}분</div>
  <table class="info">
    <tr><th>성명</th><td>${row.name || ''}</td><th>사번</th><td>${row.emp_no || '—'}</td></tr>
    <tr><th>부서</th><td>${row.department || '—'}</td><th>직위</th><td>${row.role || '—'}</td></tr>
    <tr><th>생년월일</th><td>${row.birth_date || '—'}</td><th>입사일</th><td>${row.join_date || '—'}</td></tr>
    <tr><th>지급일</th><td colspan="3">${row.pay_date || '—'}</td></tr>
  </table>
  <div class="cols">
    <div><table class="pay"><tr><th>지급 항목</th><th class="num">금액</th></tr>${earns}<tr class="tot"><td>지급 합계</td><td class="num">${won(gross)}</td></tr></table></div>
    <div><table class="pay"><tr><th>공제 항목</th><th class="num">금액</th></tr>${deds}<tr class="tot"><td>공제 합계</td><td class="num">${won(deduction)}</td></tr></table></div>
  </div>
  <div class="net"><span>차인지급액 (실수령액)</span><span>${won(net)}원</span></div>
  <div class="foot">${company ? company + ' · ' : ''}발행일 ${row.pay_date || ''}</div>
  </body></html>`;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  iframe.onload = () => {
    const win = iframe.contentWindow;
    const cleanup = () => setTimeout(() => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }, 500);
    try { win.onafterprint = cleanup; win.focus(); win.print(); }
    catch (e) { console.error('명세서 인쇄 실패', e); }
    setTimeout(cleanup, 60000);
  };
  iframe.srcdoc = html;
  document.body.appendChild(iframe);
}

/* ───────── HRScreen ───────── */
export const HRScreen = () => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [tab, setTab] = useState("급여대장");
  const [empDrawer, setEmpDrawer] = useState(null);
  const [employees, setEmployees] = useState([]);

  // 급여대장
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [payRows, setPayRows] = useState([]);
  const [paySummary, setPaySummary] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [editSlip, setEditSlip] = useState(null);
  const [payTarget, setPayTarget] = useState(null);

  const reloadEmployees = () => api.getEmployees().then(setEmployees);
  const loadPayroll = async () => {
    const [rows, s] = await Promise.all([api.getPayroll(month), api.getPayrollSummary(month)]);
    setPayRows(rows); setPaySummary(s);
  };
  useEffect(() => { reloadEmployees() }, []);
  useEffect(() => { api.getAccounts().then(setAccounts) }, []);
  useEffect(() => { loadPayroll() }, [month]);

  const handleGeneratePayroll = async () => {
    const res = await api.generatePayroll(month, `${month}-25`);
    if (res.ok) { toast.push(res.created > 0 ? `${res.created}명 급여대장을 만들었어요` : "이미 모두 작성돼 있어요"); loadPayroll(); }
    else toast.push("생성에 실패했어요");
  };

  const handleDeleteRow = async (r) => {
    const hasPaid = (r.paid || 0) !== 0;
    const ok = await confirm({
      tone: "neg", icon: <Icon.Warn size={22}/>,
      title: `${r.name} 급여 명세 삭제`,
      body: hasPaid
        ? "이 직원의 이번 달 급여 명세를 삭제합니다. 이미 기록된 지출 거래는 거래내역에 그대로 남고, 이 급여와의 연결만 끊겨요."
        : "이 직원의 이번 달 급여 명세를 삭제합니다. 다시 만들려면 '급여대장 생성'을 누르세요.",
      confirmLabel: "삭제",
    });
    if (!ok) return;
    const res = await api.deletePayslip(r.id);
    if (res.ok) { toast.push("급여 명세를 삭제했어요"); loadPayroll(); }
    else toast.push("삭제에 실패했어요");
  };

  const handleClearMonth = async () => {
    if (payRows.length === 0) return;
    const anyPaid = payRows.some(r => (r.paid || 0) !== 0);
    const ok = await confirm({
      tone: "neg", icon: <Icon.Warn size={22}/>,
      title: `${monthLabel(month)} 급여대장 전체 삭제`,
      body: `${payRows.length}명의 이번 달 급여 명세를 모두 삭제합니다.${anyPaid ? " 이미 기록된 지출 거래는 거래내역에 남고 연결만 끊겨요." : ""} 급여 명세는 복구할 수 없어요.`,
      confirmLabel: "전체 삭제",
    });
    if (!ok) return;
    for (const r of payRows) await api.deletePayslip(r.id);
    toast.push(`${monthLabel(month)} 급여대장을 비웠어요`);
    loadPayroll();
  };

  const active = employees.filter(e => e.status === "재직" || e.status === "수습");

  return (
    <>
      <div className="fade-up">
        <div className="row" style={{ marginBottom: 8 }}>
          <div>
            <div className="page-title">인사관리</div>
            <div className="page-sub">직원 명부와 매달 급여를 한 곳에서 관리하세요. 4대보험·원천세 신고 자료는 보고서에서 받을 수 있어요.</div>
          </div>
          <div className="ml-auto row gap-8">
            {tab === "직원" && <button className="btn primary" onClick={() => setEmpDrawer({ mode: "new" })}><Icon.Plus/> 직원 등록</button>}
          </div>
        </div>
        <Spacer h={20}/>

        <div className="card" style={{ overflow: "hidden" }}>
          <div className="tab-bar" style={{ padding: "0 12px" }}>
            {["급여대장", "직원"].map(t => (
              <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>

          {tab === "급여대장" && (
            <div>
              <div style={{ padding: "18px 18px 0" }}>
                <div className="row gap-8" style={{ marginBottom: 14 }}>
                  <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, -1))}><Icon.Left size={14}/></button>
                  <div className="fw-700" style={{ fontSize: 15, minWidth: 90, textAlign: "center" }}>{monthLabel(month)}</div>
                  <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, 1))}><Icon.Right size={14}/></button>
                  <div className="ml-auto row gap-8">
                    {payRows.length > 0 && <button className="btn" style={{ color: "var(--neg-ink)" }} onClick={handleClearMonth}><Icon.Trash size={14}/> 이 달 비우기</button>}
                    <button className="btn" onClick={handleGeneratePayroll}><Icon.Plus/> 급여대장 생성</button>
                  </div>
                </div>

                <div className="alert-row" style={{ marginBottom: 16, background: (paySummary?.unpaidTotal > 0 || paySummary?.overpaidCount > 0) ? "var(--warn-soft)" : "var(--brand-soft)", borderColor: "transparent" }}>
                  <Icon.Sparkle/>
                  <div>
                    <div className="lead">
                      {monthLabel(month)} 급여 지급 예정일 <b>{paySummary?.payDate || "—"}</b>
                      {paySummary?.unpaidTotal > 0 && <> · 미지급 <b style={{ color: "var(--warn-ink)" }}>{fmtNum(paySummary.unpaidTotal)}원</b></>}
                      {paySummary?.overpaidCount > 0 && <> · 과지급 <b style={{ color: "var(--neg-ink)" }}>{paySummary.overpaidCount}건</b></>}
                    </div>
                    <div className="body">각 직원 행의 <b>명세서</b>에서 지급·공제 항목을 직접(%·금액) 조정하고, <b>지급 등록</b>으로 실제 이체를 연결하면 미지급·과지급이 자동 계산돼요.</div>
                  </div>
                </div>

                <div className="grid grid-4-to-2" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 4 }}>
                  <MiniStat label="실수령 합계"  value={fmtNum(paySummary?.netTotal || 0) + "원"}    sub={`재직 ${paySummary?.count || 0}명`} tone="brand"/>
                  <MiniStat label="지급 완료"    value={fmtNum(paySummary?.paidTotal || 0) + "원"}   sub="실제 이체분"                       tone="ink"/>
                  <MiniStat label="미지급 합계"  value={fmtNum(paySummary?.unpaidTotal || 0) + "원"} sub="아직 못 준 급여"                   tone={paySummary?.unpaidTotal > 0 ? "warn" : "ink"}/>
                  <MiniStat label="과지급"       value={(paySummary?.overpaidCount || 0) + "건"}     sub="초과 지급 확인"                    tone={paySummary?.overpaidCount > 0 ? "neg" : "ink"}/>
                </div>
              </div>

              {payRows.length === 0 ? (
                <div style={{ padding: "40px 18px 48px", textAlign: "center", color: "var(--muted-2)" }}>
                  <div style={{ marginBottom: 12 }}>{monthLabel(month)} 급여대장이 아직 없어요.</div>
                  <button className="btn primary" onClick={handleGeneratePayroll}><Icon.Plus/> 재직 직원 급여대장 만들기</button>
                </div>
              ) : (
                <div className="table-scroll" style={{ marginTop: 12 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>직원</th>
                        <th className="num-right">실수령</th>
                        <th className="num-right">지급 완료</th>
                        <th className="num-right">미지급 / 과지급</th>
                        <th>지급일</th>
                        <th>상태</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {payRows.map((r) => {
                        const remain = r.remain;
                        return (
                          <tr key={r.id}>
                            <td>
                              <div className="fw-700">{r.name}</div>
                              <div className="text-xs text-muted2">{r.department || "—"} · {r.role || "—"}</div>
                            </td>
                            <td className="num-cell num-right fw-700">{fmtNum(r.net_salary)}</td>
                            <td className="num-cell num-right text-muted">{fmtNum(r.paid)}</td>
                            <td className="num-cell num-right">
                              {remain > 0 ? <span className="text-warn fw-700">미지급 {fmtNum(remain)}</span>
                                : remain < 0 ? <span className="text-neg fw-700">과지급 {fmtNum(-remain)}</span>
                                : <span className="text-muted">—</span>}
                            </td>
                            <td className="num text-sm text-muted">{r.pay_date || "—"}</td>
                            <td><StatusBadge status={r.payStatus}/></td>
                            <td>
                              <div className="row gap-4">
                                <button className="btn ghost sm" onClick={() => setEditSlip(r)}>명세서</button>
                                <button className="btn ghost sm" onClick={() => setPayTarget(r)}>지급</button>
                                <button className="btn ghost sm" style={{ color: "var(--neg)" }} onClick={() => handleDeleteRow(r)}>삭제</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: "var(--surface-2)" }}>
                        <td className="fw-700" style={{ padding: "14px 14px" }}>합계 {payRows.length}명</td>
                        <td className="num-cell num-right fw-700">{fmtNum(paySummary?.netTotal || 0)}</td>
                        <td className="num-cell num-right fw-700 text-muted">{fmtNum(paySummary?.paidTotal || 0)}</td>
                        <td className="num-cell num-right fw-700 text-warn">{fmtNum(paySummary?.unpaidTotal || 0)}</td>
                        <td colSpan={3}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab === "직원" && (
            <div>
              <div className="row" style={{ padding: "16px 18px", borderBottom: "1px solid var(--line)" }}>
                <div>
                  <div className="section-title">직원 명부</div>
                  <div className="section-sub">전체 {employees.length}명 · 재직 {active.length}명</div>
                </div>
                <div className="ml-auto row gap-8">
                  <div className="search" style={{ margin: 0, width: 220, padding: "6px 10px" }}>
                    <Icon.Search size={14}/>
                    <input placeholder="이름·사번 검색"/>
                  </div>
                  <button className="btn"><Icon.Filter/> 필터</button>
                </div>
              </div>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>사번</th><th>이름</th><th>부서</th><th>직위</th><th>입사일</th>
                      <th>재직 상태</th><th className="num-right">기본급</th><th>부양가족</th><th>급여 계좌</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((e, i) => (
                      <tr key={i} style={{ cursor: "pointer" }} onClick={() => setEmpDrawer({ mode: "edit", emp: e })}>
                        <td className="num text-muted text-sm">{e.code}</td>
                        <td className="fw-700">{e.name}</td>
                        <td className="text-sm">{e.dept}</td>
                        <td className="text-sm">{e.pos}</td>
                        <td className="num text-sm text-muted">{e.join}</td>
                        <td><StatusBadge status={e.status}/></td>
                        <td className="num-cell num-right">{fmtNum(e.pay.base)}</td>
                        <td className="text-sm text-muted">{e.pay.dependents + e.pay.childDependents}명</td>
                        <td className="text-sm text-muted">{e.account}</td>
                        <td>
                          <div className="row gap-4">
                            <button className="btn ghost sm" onClick={(ev) => { ev.stopPropagation(); setEmpDrawer({ mode: "edit", emp: e }); }}>편집</button>
                            <button className="btn ghost sm" style={{ color: "var(--neg)" }} onClick={async (ev) => {
                              ev.stopPropagation();
                              const ok = await confirm({ tone: "neg", icon: <Icon.Warn size={22}/>, title: `${e.name} 삭제`, body: "직원 정보를 삭제합니다. 복구할 수 없어요.", confirmLabel: "삭제" });
                              if (ok) { await api.deleteEmployee(e.id); reloadEmployees(); toast.push("삭제됐어요"); }
                            }}>삭제</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="row gap-10" style={{ marginTop: 16, padding: "12px 14px", fontSize: 12, color: "var(--muted-2)" }}>
          <Icon.Sparkle size={14}/>
          <span>
            <b style={{ color: "var(--ink)" }}>4대보험·원천세 신고 자료</b>는 보고서 메뉴에서 받을 수 있어요. 표준 급여 항목은 <b style={{ color: "var(--ink)" }}>설정 → 급여 항목</b>에서 관리합니다.
          </span>
        </div>
      </div>

      <PayslipEditorDrawer row={editSlip} onClose={() => setEditSlip(null)} onSaved={() => { setEditSlip(null); loadPayroll(); }}/>
      <PayDrawer row={payTarget} accounts={accounts} onClose={() => setPayTarget(null)} onSaved={() => loadPayroll()}/>

      <EmployeeDrawer info={empDrawer} onClose={() => setEmpDrawer(null)} onSaved={reloadEmployees}/>
    </>
  );
};

/* ───────── 직원 등록/편집 Drawer ───────── */
const EmployeeDrawer = ({ info, onClose, onSaved }) => {
  const toast = useToast();
  const [depts, setDepts] = useState([]);
  const [positions, setPositions] = useState([]);
  const EMPTY = { name: "", dept: "", pos: "", join: "", birth: "", status: "재직", base: 0, positionAllowance: 0, mealAllowance: 0, vehicleAllowance: 0, dependents: 1, childDependents: 0 };
  const [form, setForm] = useState(EMPTY);

  useEffect(() => {
    api.getHrCodes('dept').then(setDepts);
    api.getHrCodes('pos').then(setPositions);
  }, []);

  useEffect(() => {
    if (!info) return;
    const e = info.emp;
    setForm(e ? {
      name: e.name, dept: e.dept === "—" ? "" : e.dept, pos: e.pos === "—" ? "" : e.pos,
      join: e.join === "—" ? "" : e.join, birth: e.birth || "", status: e.status, base: e.pay?.base || 0,
      positionAllowance: e.pay?.positionAllowance || 0,
      mealAllowance: e.pay?.mealAllowance || 0,
      vehicleAllowance: e.pay?.vehicleAllowance || 0,
      dependents: e.pay?.dependents || 1,
      childDependents: e.pay?.childDependents || 0,
    } : EMPTY);
  }, [info]);

  const handleSave = async () => {
    if (!form.name) return toast.push("이름을 입력해주세요");
    const body = {
      name:               form.name,
      role:               form.pos,
      department:         form.dept,
      base_salary:        form.base || 0,
      join_date:          form.join || null,
      birth_date:         form.birth || null,
      position_allowance: form.positionAllowance || 0,
      meal_allowance:     form.mealAllowance || 0,
      vehicle_allowance:  form.vehicleAllowance || 0,
      dependents:         form.dependents || 1,
      child_dependents:   form.childDependents || 0,
      status:             form.status,
      active:             form.status !== "퇴사",
    };
    const editing = info.mode === "edit" && info.emp?.id;
    const res = editing ? await api.updateEmployee(info.emp.id, body) : await api.addEmployee(body);
    if (res?.id || res?.ok) {
      toast.push(editing ? "직원 정보를 저장했어요" : "직원이 등록됐어요");
      onSaved?.();
      onClose();
    } else {
      toast.push("저장에 실패했어요");
    }
  };

  if (!info) return null;
  const isNew = info.mode === "new";
  const e = info.emp || {};

  return (
    <Drawer open={true} onClose={onClose} width="min(560px, 100vw)">
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>{isNew ? "새 직원 등록" : `${e.name} 직원 정보`}</div>
            <div className="text-xs text-muted">{isNew ? "기본 정보와 급여 정보를 입력하세요." : `${e.code} · ${e.dept} · ${e.pos}`}</div>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        <div className="drawer-body">
          <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 12 }}>기본 정보</div>
          <div className="col gap-form" style={{ marginBottom: 28 }}>
            <FieldRow label="이름" required><input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="홍길동"/></FieldRow>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <FieldRow label="부서">
                <Combobox
                  value={form.dept}
                  onChange={v => setForm(f => ({ ...f, dept: v }))}
                  options={depts.map(d => ({ value: d.name, label: d.name }))}
                  placeholder="부서 선택"
                  onAddNew={async (name) => {
                    const res = await api.addHrCode('dept', name);
                    if (res.ok) {
                      const updated = await api.getHrCodes('dept');
                      setDepts(updated);
                      setForm(f => ({ ...f, dept: name }));
                      toast.push(`"${name}" 부서 추가됐어요`);
                    }
                  }}
                  addNewLabel="부서로 추가"
                />
              </FieldRow>
              <FieldRow label="직위">
                <Combobox
                  value={form.pos}
                  onChange={v => setForm(f => ({ ...f, pos: v }))}
                  options={positions.map(p => ({ value: p.name, label: p.name }))}
                  placeholder="직위 선택"
                  onAddNew={async (name) => {
                    const res = await api.addHrCode('pos', name);
                    if (res.ok) {
                      const updated = await api.getHrCodes('pos');
                      setPositions(updated);
                      setForm(f => ({ ...f, pos: name }));
                      toast.push(`"${name}" 직위 추가됐어요`);
                    }
                  }}
                  addNewLabel="직위로 추가"
                />
              </FieldRow>
            </div>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <FieldRow label="입사일"><input className="input num" type="date" value={form.join} onChange={e => setForm(f => ({ ...f, join: e.target.value }))}/></FieldRow>
              <FieldRow label="재직 상태">
                <div className="row gap-6">
                  {["재직", "수습", "휴직", "퇴사"].map(s => (
                    <button key={s} type="button" className={`chip ${form.status === s ? "active" : ""}`} onClick={() => setForm(f => ({ ...f, status: s }))}>{s}</button>
                  ))}
                </div>
              </FieldRow>
            </div>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <FieldRow label="생년월일" hint="급여명세서 표기용"><input className="input num" type="date" value={form.birth} onChange={e => setForm(f => ({ ...f, birth: e.target.value }))}/></FieldRow>
              <FieldRow label="급여 계좌"><input className="input" defaultValue={e.account} placeholder="은행 / 계좌번호"/></FieldRow>
            </div>
            <FieldRow label="주민등록번호"><input className="input num" placeholder="900101-1******"/></FieldRow>
          </div>

          <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 12 }}>급여 정보</div>
          <div className="col gap-form">
            <div className="alert-row" style={{ background: "var(--surface-2)", borderColor: "var(--line)", marginBottom: 6 }}>
              <Icon.Sparkle/>
              <div>
                <div className="lead">여기 입력한 기본급·직책수당·식대·자가운전 보조금은 급여대장 생성 시 명세서에 자동으로 채워집니다.</div>
                <div className="body">4대보험·소득세처럼 매달 바뀌는 공제액만 급여대장 명세서에서 세무서·공단 고지 금액으로 직접 입력하면 돼요.</div>
              </div>
            </div>
            <FieldRow label="기본급 (월)" required><MoneyInputControlled value={form.base} onChange={v => setForm(f => ({ ...f, base: v }))}/></FieldRow>
            <FieldRow label="직책수당 (월)"><MoneyInputControlled value={form.positionAllowance} onChange={v => setForm(f => ({ ...f, positionAllowance: v }))}/></FieldRow>
            <FieldRow label="식대 (월)" hint="월 20만원까지 비과세"><MoneyInputControlled value={form.mealAllowance} onChange={v => setForm(f => ({ ...f, mealAllowance: v }))}/></FieldRow>
            <FieldRow label="자가운전 보조금 (월)" hint="월 20만원까지 비과세 · 본인 차량 업무 사용 시"><MoneyInputControlled value={form.vehicleAllowance} onChange={v => setForm(f => ({ ...f, vehicleAllowance: v }))}/></FieldRow>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <FieldRow label="부양가족 수" hint="본인 포함 · 참고용">
                <input className="input num" type="number" min="1" value={form.dependents} onChange={e => setForm(f => ({ ...f, dependents: parseInt(e.target.value) || 0 }))}/>
              </FieldRow>
              <FieldRow label="20세 이하 자녀 수">
                <input className="input num" type="number" min="0" value={form.childDependents} onChange={e => setForm(f => ({ ...f, childDependents: parseInt(e.target.value) || 0 }))}/>
              </FieldRow>
            </div>
          </div>
        </div>

        <div className="drawer-foot">
          {!isNew && <button className="btn" style={{ color: "var(--neg-ink)" }}>퇴사 처리</button>}
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={onClose}>취소</button>
            <button className="btn primary" onClick={handleSave}>
              <Icon.Check size={14}/> {isNew ? "등록" : "저장"}
            </button>
          </div>
        </div>
    </Drawer>
  );
};

const FieldRow = ({ label, hint, required, children }) => (
  <div>
    <label className="label">
      {label} {required && <span style={{ color: "var(--neg-ink)" }}>*</span>}
      {hint && <span className="text-muted2 fw-600" style={{ marginLeft: 6, fontWeight: 400 }}>· {hint}</span>}
    </label>
    {children}
  </div>
);

const MoneyInput = ({ defaultValue }) => {
  const [v, setV] = useState(defaultValue || 0);
  return (
    <div style={{ position: "relative" }}>
      <input className="input num fw-700" style={{ paddingRight: 32 }}
        value={fmtNum(v)}
        onChange={e => setV(parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)}/>
      <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "var(--muted-2)", fontSize: 12 }}>원</span>
    </div>
  );
};

const MoneyInputControlled = ({ value, onChange }) => (
  <div style={{ position: "relative" }}>
    <input className="input num fw-700" style={{ paddingRight: 32 }}
      value={fmtNum(value)}
      onChange={e => onChange(parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)}/>
    <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "var(--muted-2)", fontSize: 12 }}>원</span>
  </div>
);

/* ───────── 급여 명세서 편집 Drawer (항목별 %·수치 입력) ───────── */
const PayslipEditorDrawer = ({ row, onClose, onSaved }) => {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [payDate, setPayDate] = useState("");
  const [masters, setMasters] = useState([]);
  const [company, setCompany] = useState("");

  useEffect(() => { api.getPayrollItemTypes().then(setMasters); }, []);
  useEffect(() => { api.getCompany().then(c => setCompany(c?.name || "")); }, []);
  useEffect(() => {
    if (!row) return;
    const init = (row.items && row.items.length) ? row.items : DEFAULT_PAYROLL_ITEMS(Number(row.base_salary) || 0);
    setItems(init.map(i => ({ ...i })));
    setPayDate(row.pay_date || "");
  }, [row]);

  const addMaster = (id) => {
    const m = masters.find(x => x.id === id);
    if (!m) return;
    setItems(prev => [...prev, { label: m.label, kind: m.kind, mode: m.mode, value: Number(m.default_value) || 0 }]);
  };

  if (!row) return null;
  const { calc, gross, deduction, net } = computeItems(items);
  const update = (idx, patch) => setItems(items.map((it, i) => i === idx ? { ...it, ...patch } : it));
  const addItem = (kind) => setItems([...items, { label: "", kind, mode: "fixed", value: 0 }]);
  const removeItem = (idx) => setItems(items.filter((_, i) => i !== idx));

  const save = async () => {
    const res = await api.savePayslip({ id: row.id, employee_id: row.employee_id, month: row.month, items, pay_date: payDate || `${row.month}-25`, status: row.status });
    if (res.ok) { toast.push("급여 명세를 저장했어요"); onSaved(); }
    else toast.push("저장에 실패했어요");
  };

  // 컴포넌트로 정의해 <ItemList/>로 렌더하면 매 렌더마다 새 타입이 돼 input이 언마운트→포커스 유실.
  // JSX를 반환하는 함수로 두고 {renderItems(...)}로 '호출'하면 요소가 인라인돼 리마운트가 없다.
  const renderItems = (kind) => (
    <div className="col gap-8">
      {items.map((it, idx) => it.kind === kind && (
        <div key={idx} className="row gap-6" style={{ alignItems: "center" }}>
          <input className="input" style={{ flex: 1, padding: "8px 10px", fontSize: 13 }} value={it.label}
            placeholder={kind === "earn" ? "지급 항목명" : "공제 항목명"}
            onChange={e => update(idx, { label: e.target.value })}/>
          <div className="row gap-2" style={{ background: "var(--surface-2)", borderRadius: 8, padding: 2 }}>
            {[["fixed", "원"], ["percent", "%"]].map(([m, lbl]) => (
              <button key={m} type="button" onClick={() => update(idx, { mode: m })}
                style={{ padding: "5px 10px", border: 0, borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit",
                  background: it.mode === m ? "#fff" : "transparent", color: it.mode === m ? "var(--ink)" : "var(--muted-2)",
                  boxShadow: it.mode === m ? "0 1px 3px rgba(0,0,0,0.1)" : "none" }}>{lbl}</button>
            ))}
          </div>
          <div style={{ position: "relative", width: 130 }}>
            <input className="input num fw-700" style={{ padding: "8px 26px 8px 10px", fontSize: 13 }}
              value={it.mode === "percent" ? it.value : fmtNum(it.value)}
              onChange={e => {
                const raw = e.target.value.replace(/[^0-9.]/g, "");
                update(idx, { value: it.mode === "percent" ? raw : (parseInt(raw.replace(/\./g, "")) || 0) });
              }}/>
            <span style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", color: "var(--muted-2)", fontSize: 11 }}>{it.mode === "percent" ? "%" : "원"}</span>
          </div>
          <div className="num text-sm text-muted" style={{ width: 88, textAlign: "right" }}>
            {kind === "deduct" ? "-" : ""}{fmtNum(calc[idx]?.amount || 0)}
          </div>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => removeItem(idx)}><Icon.Close size={13}/></button>
        </div>
      ))}
      <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => addItem(kind)}><Icon.Plus size={12}/> {kind === "earn" ? "지급 항목 추가" : "공제 항목 추가"}</button>
    </div>
  );

  return (
    <Drawer open={true} onClose={onClose} width="min(640px, 100vw)">
      <div className="drawer-head">
        <div>
          <div className="fw-700" style={{ fontSize: 16 }}>{row.name} 급여 명세 — {monthLabel(row.month)}</div>
          <div className="text-xs text-muted">{row.department || "—"} · {row.role || "—"} · 각 항목을 %나 금액으로 직접 입력하세요</div>
        </div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>

      <div className="drawer-body">
        <div className="card" style={{ padding: 16, background: "var(--surface-2)", border: "1px solid var(--line)", marginBottom: 18 }}>
          <div className="row">
            <div>
              <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 4 }}>실수령액</div>
              <div className="num fw-700" style={{ fontSize: 26 }}>{fmtNum(net)}<span className="text-muted" style={{ fontWeight: 400, fontSize: 14, marginLeft: 3 }}>원</span></div>
            </div>
            <div className="ml-auto text-sm" style={{ textAlign: "right" }}>
              <div className="text-muted">지급 합계 <b className="text-ink">{fmtNum(gross)}</b></div>
              <div className="text-muted">공제 합계 <b className="text-warn">-{fmtNum(deduction)}</b></div>
            </div>
          </div>
        </div>

        <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.02em", marginBottom: 10 }}>지급 항목</div>
        <div style={{ marginBottom: 22 }}>{renderItems("earn")}</div>

        <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.02em", marginBottom: 10 }}>공제 항목 <span className="text-muted2" style={{ fontWeight: 400 }}>· %는 지급(고정금액) 합계 기준으로 계산돼요</span></div>
        <div style={{ marginBottom: 16 }}>{renderItems("deduct")}</div>

        {masters.length > 0 && (
          <div className="row gap-8" style={{ marginBottom: 22, alignItems: "center", maxWidth: 360 }}>
            <span className="text-xs text-muted2 fw-600" style={{ whiteSpace: "nowrap" }}>표준 항목에서 추가</span>
            <div style={{ flex: 1 }}>
              <Combobox value="" onChange={addMaster}
                options={masters.map(m => ({ value: m.id, label: `${m.kind === "earn" ? "+ " : "− "}${m.label}`, sub: m.mode === "percent" ? `${Number(m.default_value)}%` : "금액" }))}
                placeholder="설정에 등록한 항목 불러오기"/>
            </div>
          </div>
        )}

        <div className="col gap-8" style={{ maxWidth: 280 }}>
          <label className="label">지급 예정일</label>
          <input className="input num" type="date" value={payDate} onChange={e => setPayDate(e.target.value)}/>
        </div>
      </div>

      <div className="drawer-foot">
        <button className="btn" onClick={() => printPayslip({ ...row, items, pay_date: payDate }, company)}><Icon.Print size={14}/> 명세서 출력</button>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" onClick={save}><Icon.Check size={14}/> 저장</button>
        </div>
      </div>
    </Drawer>
  );
};

/* ───────── 급여 지급 등록 Drawer (실지출 연결) ───────── */
const PayDrawer = ({ row, accounts, onClose, onSaved }) => {
  const toast = useToast();
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState("");
  const [accountId, setAccountId] = useState("");
  const [method, setMethod] = useState("계좌이체");

  useEffect(() => {
    if (!row) return;
    setAmount(row.remain > 0 ? row.remain : 0);
    setDate(new Date().toISOString().slice(0, 10));
    setAccountId("");
    setMethod("계좌이체");
  }, [row]);

  if (!row) return null;
  const remain = row.remain;

  const register = async () => {
    if (!amount || amount <= 0) return toast.push("지급액을 입력해주세요");
    const res = await api.payPayroll(row.id, { amount, date, account_id: accountId || null, method });
    if (res.ok) { toast.push("급여 지급을 등록했어요 (거래내역에 반영)"); onSaved(); onClose(); }
    else toast.push(res.error || "등록에 실패했어요");
  };
  const removePay = async (txnId) => {
    const res = await api.deletePayrollPayment(row.id, txnId);
    if (res.ok) { toast.push("지급 내역을 취소했어요"); onSaved(); onClose(); }
    else toast.push("취소에 실패했어요");
  };

  return (
    <Drawer open={true} onClose={onClose} width="min(520px, 100vw)">
      <div className="drawer-head">
        <div>
          <div className="fw-700" style={{ fontSize: 16 }}>{row.name} 급여 지급 — {monthLabel(row.month)}</div>
          <div className="text-xs text-muted">실제 이체분을 등록하면 거래내역(지출)에 자동 기록돼요</div>
        </div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>

      <div className="drawer-body">
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 18 }}>
          <MiniStat label="실수령" value={fmtNum(row.net_salary) + "원"} tone="ink"/>
          <MiniStat label="지급 완료" value={fmtNum(row.paid) + "원"} tone="brand"/>
          <MiniStat label={remain >= 0 ? "미지급" : "과지급"} value={fmtNum(Math.abs(remain)) + "원"} tone={remain > 0 ? "warn" : remain < 0 ? "neg" : "ink"}/>
        </div>

        <div className="col gap-form">
          <div>
            <label className="label">이번 지급액 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
            <div style={{ position: "relative" }}>
              <input className="input num fw-700" style={{ paddingRight: 32 }} value={fmtNum(amount)}
                onChange={e => setAmount(parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0)}/>
              <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "var(--muted-2)", fontSize: 12 }}>원</span>
            </div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <div>
              <label className="label">지급일</label>
              <input className="input num" type="date" value={date} onChange={e => setDate(e.target.value)}/>
            </div>
            <div>
              <label className="label">지급 수단</label>
              <div className="row gap-6">
                {["계좌이체", "현금"].map(m => (
                  <button key={m} type="button" className={`chip ${method === m ? "active" : ""}`} onClick={() => setMethod(m)}>{m}</button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <label className="label">출금 계좌</label>
            <Combobox value={accountId} onChange={setAccountId}
              options={accounts.map(a => ({ value: a.id, label: a.name, sub: a.number }))}
              placeholder="계좌 선택 (선택)"/>
          </div>
        </div>

        {(row.payments && row.payments.length > 0) && (
          <div style={{ marginTop: 24 }}>
            <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 10 }}>지급 내역 {row.payments.length}건</div>
            <div className="col gap-6">
              {row.payments.map(p => (
                <div key={p.id} className="row gap-8" style={{ padding: "8px 12px", background: "var(--surface-2)", borderRadius: 8 }}>
                  <span className="num text-sm text-muted">{p.date}</span>
                  <span className="num fw-700 ml-auto">{fmtNum(p.amount)}원</span>
                  <button className="btn ghost sm" style={{ color: "var(--neg)" }} onClick={() => removePay(p.id)}>취소</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>닫기</button>
        <button className="btn primary ml-auto" onClick={register}><Icon.Bank size={14}/> 지급 등록</button>
      </div>
    </Drawer>
  );
};
