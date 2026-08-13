import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge, Drawer, Combobox, MoneyInput, localToday } from '../lib/ui'
import { Kpi, KpiRow } from '../lib/components/Kpi'
import { PageHeader } from '../lib/components/PageHeader'
import { DataTable } from '../lib/components/DataTable'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
// 지급 등록 Drawer는 급여대장·용역계약 상세가 함께 쓴다(공용 컴포넌트로 분리)
import { PayrollPayDrawer } from '../lib/components/PayrollPayDrawer'
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
  // 이름·항목명·회사명에 <, &, " 등이 있어도 인쇄 레이아웃이 깨지지 않게 이스케이프.
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const line = (l, a, neg) => `<tr><td>${esc(l)}</td><td style="text-align:right">${neg ? '-' : ''}${won(a)}</td></tr>`;
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
  <div class="co">${company ? esc(company) + ' · ' : ''}${monthLabel(row.month)}분</div>
  <table class="info">
    <tr><th>성명</th><td>${esc(row.name)}</td><th>사번</th><td>${esc(row.emp_no) || '—'}</td></tr>
    <tr><th>부서</th><td>${esc(row.department) || '—'}</td><th>직위</th><td>${esc(row.role) || '—'}</td></tr>
    <tr><th>생년월일</th><td>${esc(row.birth_date) || '—'}</td><th>입사일</th><td>${esc(row.join_date) || '—'}</td></tr>
    <tr><th>지급일</th><td colspan="3">${esc(row.pay_date) || '—'}</td></tr>
  </table>
  <div class="cols">
    <div><table class="pay"><tr><th>지급 항목</th><th class="num">금액</th></tr>${earns}<tr class="tot"><td>지급 합계</td><td class="num">${won(gross)}</td></tr></table></div>
    <div><table class="pay"><tr><th>공제 항목</th><th class="num">금액</th></tr>${deds}<tr class="tot"><td>공제 합계</td><td class="num">${won(deduction)}</td></tr></table></div>
  </div>
  <div class="net"><span>차인지급액 (실수령액)</span><span>${won(net)}원</span></div>
  <div class="foot">${company ? esc(company) + ' · ' : ''}발행일 ${esc(row.pay_date)}</div>
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

  // 급여대장
  const [month, setMonth] = useState(() => localToday().slice(0, 7));
  const [payRows, setPayRows] = useState([]);
  const [paySummary, setPaySummary] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [editSlip, setEditSlip] = useState(null);
  const [payTarget, setPayTarget] = useState(null);

  const loadPayroll = async () => {
    const [rows, s] = await Promise.all([api.getPayroll(month), api.getPayrollSummary(month)]);
    setPayRows(rows); setPaySummary(s);
  };
  useEffect(() => { api.getAccounts().then(setAccounts) }, []);
  useEffect(() => { loadPayroll() }, [month]);

  const handleGeneratePayroll = async () => {
    // pay_date 를 넘기지 않는다. 넘기면 서버가 그 값으로 전원을 덮어써(payroll.js:224
    // `pay_date || (w.pay_day ? … : 25일)`) 근로계약에 설정한 급여지급일이 무시된다.
    // 비워두면 계약별 pay_day 를, 없는 사람만 25일로 채운다.
    const res = await api.generatePayroll(month);
    if (!res.ok) return toast.push(res.error || "생성에 실패했어요", { tone: "warn" });
    /* 0건일 때 이유를 갈라 말한다. 예전엔 무조건 "이미 모두 작성돼 있어요"였는데,
       근로계약이 하나도 없어서 만들 게 없는 경우까지 그렇게 안내해서
       "작성돼 있다는데 왜 대장이 비었지"로 막혔다(직원만 등록하면 이 상태가 된다). */
    if (res.created > 0) toast.push(`${res.created}명 급여대장을 만들었어요`);
    else if (res.reason === 'noContract')
      toast.push("이 달에 유효한 근로계약이 없어요. 인사급여 › 근로계약에서 먼저 등록해주세요.", { tone: "warn" });
    else toast.push("이미 모두 작성돼 있어요");
    loadPayroll();
  };

  const handleDeleteRow = async (r) => {
    const hasPaid = (r.paid || 0) !== 0;
    const ok = await confirm({
      tone: "neg", icon: <Icon.Warn size={22}/>,
      title: `${r.name} 급여 명세 삭제`,
      body: hasPaid
        // 지급 이력이 있으면 서버가 409로 막는다(이미 나간 돈이 '미지급'으로 되살아나 재지급을 유도하므로).
        ? "이미 지급한 내역이 있어 바로 삭제할 수 없어요. 급여 상세에서 지급 내역을 먼저 취소한 뒤 다시 시도하세요."
        : "이 직원의 이번 달 급여 명세를 삭제합니다. 다시 만들려면 '급여대장 생성'을 누르세요.",
      confirmLabel: hasPaid ? "확인" : "삭제",
    });
    if (!ok || hasPaid) return;
    const res = await api.deletePayslip(r.id);
    if (res.ok) { toast.push("급여 명세를 삭제했어요"); loadPayroll(); }
    else toast.push(res.error || "삭제에 실패했어요", { tone: "warn" });
  };

  const handleClearMonth = async () => {
    if (payRows.length === 0) return;
    const anyPaid = payRows.some(r => (r.paid || 0) !== 0);
    const ok = await confirm({
      tone: "neg", icon: <Icon.Warn size={22}/>,
      title: `${monthLabel(month)} 급여대장 전체 삭제`,
      body: anyPaid
        ? "이미 지급한 내역이 있어 비울 수 없어요. 각 직원의 급여 상세에서 지급 내역을 먼저 취소해주세요."
        : `${payRows.length}명의 이번 달 급여 명세를 모두 삭제합니다. 급여 명세는 복구할 수 없어요.`,
      confirmLabel: anyPaid ? "확인" : "전체 삭제",
    });
    if (!ok || anyPaid) return;
    // 건별 반복 대신 한 트랜잭션으로 일괄 삭제(부분 실패 방지).
    const res = await api.clearPayrollMonth(month);
    if (res.ok) toast.push(`${monthLabel(month)} 급여대장을 비웠어요`);
    else toast.push(res.error || "삭제에 실패했어요", { tone: "warn" });
    loadPayroll();
  };

  return (
    <>
      <div className="fade-up">
        <PageHeader title="인사관리"/>

        <div className="card" style={{ overflow: "hidden" }}>
          <div className="tab-bar" style={{ padding: "0 12px" }}>
            {["급여대장", "용역·일용 대장", "미지급 퇴직금"].map(t => (
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

                <KpiRow cols={4} style={{ marginBottom: 4 }}>
                  {/* count 는 '그 달 급여대장 행 수'다. '재직 N명'이라고 부르니 대장을 아직
                      안 만든 달에 '재직 0명'이 떠서 **직원이 하나도 없는 것처럼** 보였다
                      (근로계약 화면엔 4명이 있는데도). 무엇을 세는 값인지 그대로 적는다. */}
                  <Kpi label="실수령 합계"  value={fmtNum(paySummary?.netTotal || 0) + "원"}    badge={`대장 ${paySummary?.count || 0}명분`} badgeTone="brand"/>
                  <Kpi label="지급 완료"    value={fmtNum(paySummary?.paidTotal || 0) + "원"}   badge="실제 이체분"                       badgeTone="ink"/>
                  <Kpi label="미지급 합계"  value={fmtNum(paySummary?.unpaidTotal || 0) + "원"} badge="아직 못 준 급여"                   badgeTone={paySummary?.unpaidTotal > 0 ? "warn" : "ink"}/>
                  <Kpi label="과지급"       value={(paySummary?.overpaidCount || 0) + "건"}     badge="초과 지급 확인"                    badgeTone={paySummary?.overpaidCount > 0 ? "neg" : "ink"}/>
                </KpiRow>
              </div>

              {payRows.length === 0 ? (
                <div style={{ padding: "40px 18px 48px", textAlign: "center", color: "var(--muted-2)" }}>
                  <div style={{ marginBottom: 12 }}>{monthLabel(month)} 급여대장이 아직 없어요.</div>
                  <button className="btn primary" onClick={handleGeneratePayroll}><Icon.Plus/> 재직 직원 급여대장 만들기</button>
                </div>
              ) : (
                <div style={{ marginTop: 12 }}>
                  <DataTable
                    rows={payRows}
                    columns={[
                      { key: 'name', header: '직원', sortable: true, render: r => (
                        <><div className="fw-700">{r.name}</div><div className="text-xs text-muted2">{r.department || "—"} · {r.role || "—"}</div></>
                      ) },
                      { key: 'net_salary', header: '실수령', align: 'right', sortable: true, render: r => <span className="num-cell fw-700">{fmtNum(r.net_salary)}</span> },
                      { key: 'paid', header: '지급 완료', align: 'right', render: r => <span className="num-cell text-muted">{fmtNum(r.paid)}</span> },
                      { key: 'remain', header: '미지급 / 과지급', align: 'right', sortable: true, render: r => (
                        r.remain > 0 ? <span className="text-warn fw-700">미지급 {fmtNum(r.remain)}</span>
                          : r.remain < 0 ? <span className="text-neg fw-700">과지급 {fmtNum(-r.remain)}</span>
                          : <span className="text-muted">—</span>
                      ) },
                      { key: 'pay_date', header: '지급일', render: r => <span className="num text-sm text-muted">{r.pay_date || "—"}</span> },
                      { key: 'payStatus', header: '상태', render: r => <StatusBadge status={r.payStatus}/> },
                      { key: 'action', header: '', render: r => (
                        <div className="row gap-4">
                          <button className="btn ghost sm" onClick={() => setEditSlip(r)}>명세서</button>
                          <button className="btn ghost sm" onClick={() => setPayTarget(r)}>지급</button>
                          <button className="btn ghost sm" style={{ color: "var(--neg)" }} onClick={() => handleDeleteRow(r)}>삭제</button>
                        </div>
                      ) },
                    ]}
                    footer={
                      <tr style={{ background: "var(--surface-2)" }}>
                        <td className="fw-700" style={{ padding: "14px 14px" }}>합계 {payRows.length}명</td>
                        <td className="num-cell num-right fw-700">{fmtNum(paySummary?.netTotal || 0)}</td>
                        <td className="num-cell num-right fw-700 text-muted">{fmtNum(paySummary?.paidTotal || 0)}</td>
                        <td className="num-cell num-right fw-700 text-warn">{fmtNum(paySummary?.unpaidTotal || 0)}</td>
                        <td colSpan={3}></td>
                      </tr>
                    }
                  />
                </div>
              )}
            </div>
          )}

          {tab === "용역·일용 대장" && <ServiceLedgerTab month={month} setMonth={setMonth}/>}
          {tab === "미지급 퇴직금" && <SeveranceTab/>}
        </div>

        <div className="row gap-10" style={{ marginTop: 16, padding: "12px 14px", fontSize: 12, color: "var(--muted-2)" }}>
          <Icon.Sparkle size={14}/>
          <span>
            <b style={{ color: "var(--ink)" }}>4대보험·원천세 신고 자료</b>는 보고서 메뉴에서 받을 수 있어요. 표준 급여 항목은 <b style={{ color: "var(--ink)" }}>설정 → 급여 항목</b>에서 관리합니다.
          </span>
        </div>
      </div>

      <PayslipEditorDrawer row={editSlip} onClose={() => setEditSlip(null)} onSaved={() => { setEditSlip(null); loadPayroll(); }}/>
      <PayrollPayDrawer row={payTarget} accounts={accounts} onClose={() => setPayTarget(null)} onSaved={() => loadPayroll()}/>
    </>
  );
};

/* ───────── 미지급 퇴직금 ─────────
 *
 * 급여대장(payroll)은 UNIQUE(employee_id, month) — "한 사람 한 달 한 행"이라
 * 근속 전체에 대한 일시금인 퇴직금이 들어갈 자리가 없다. 그래서 여기만 따로 있다.
 *
 * ⚠ **밀린 급여는 여기가 아니다.** 급여대장에 그 달 행을 만들면 미지급이 저절로 잡히고
 *   자금 예측이 그걸 센다. 여기 또 적으면 나갈 돈이 두 번 계산된다. 화면에도 적어 둔다.
 */
const SeveranceTab = () => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [data, setData] = useState({ items: [], totals: { retired: 0, active: 0, all: 0 } });
  const [employees, setEmployees] = useState([]);
  const [editing, setEditing] = useState(null);   // 행 객체 | 'new' | null

  const load = async () => setData(await api.getUnpaidLabor());
  useEffect(() => { load(); api.getEmployees().then(setEmployees) }, []);

  const doDelete = async (r) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: `${r.name} 퇴직금 삭제`,
      body: '목록에서 지웁니다. 이미 지급한 거래는 지워지지 않아요.', confirmLabel: '삭제',
    });
    if (!ok) return;
    const res = await api.deleteUnpaidLabor(r.id);
    if (!res.ok) return toast.push(res.error || '삭제에 실패했어요', { tone: 'warn' });
    toast.push('삭제했어요'); load();
  };

  return (
    <div>
      <div style={{ padding: '18px 18px 0' }}>
        <div className="alert-row" style={{ marginBottom: 16, background: 'var(--brand-soft)', borderColor: 'transparent' }}>
          <Icon.Sparkle/>
          <div>
            <div className="lead">여기는 <b>퇴직금</b>만 적어요.</div>
            <div className="body">
              밀린 <b>급여</b>는 급여대장에 그 달 명세를 만들면 미지급으로 저절로 잡혀요(퇴사자도 됩니다).
              양쪽에 적으면 자금 현황에서 나갈 돈이 두 번 계산돼요.
            </div>
          </div>
        </div>

        <KpiRow cols={3} style={{ marginBottom: 4 }}>
          <Kpi label="퇴직자"   value={fmtNum(data.totals.retired) + '원'} badge="이미 나간 사람" badgeTone={data.totals.retired > 0 ? 'warn' : 'ink'}/>
          <Kpi label="현직원"   value={fmtNum(data.totals.active) + '원'}  badge="재직 중 적립분" badgeTone="ink"/>
          <Kpi label="합계"     value={fmtNum(data.totals.all) + '원'}     badge="아직 안 준 퇴직금" badgeTone={data.totals.all > 0 ? 'neg' : 'ink'}/>
        </KpiRow>

        <div className="row" style={{ margin: '14px 0' }}>
          <button className="btn primary ml-auto" onClick={() => setEditing('new')}><Icon.Plus size={14}/> 퇴직금 등록</button>
        </div>
      </div>

      <DataTable
        rows={data.items}
        empty="등록된 미지급 퇴직금이 없어요."
        columns={[
          { key: 'name', header: '성명', sortable: true, render: r => <span className="fw-700">{r.name}</span> },
          { key: 'status', header: '구분', width: 90, render: r => (
            <span className={`badge ${r.status === 'retired' ? 'warn' : 'outline'}`}>{r.status === 'retired' ? '퇴직자' : '현직원'}</span>
          ) },
          { key: 'amount', header: '총액', align: 'right', sortable: true, render: r => <span className="num-cell">{fmtNum(r.amount)}</span> },
          { key: 'paid_amount', header: '지급액', align: 'right', render: r => <span className="num-cell text-muted">{fmtNum(r.paid_amount)}</span> },
          // 다 준 건은 빨갛게 0을 쓰지 않는다 — 0원이 경고색이면 진짜 남은 돈이 묻힌다
          { key: 'remain', header: '남은 금액', align: 'right', sortable: true, render: r => (
            r.remain > 0
              ? <span className="num-cell fw-700" style={{ color: 'var(--neg-ink)' }}>{fmtNum(r.remain)}</span>
              : <span className="num-cell text-muted2">지급 완료</span>
          ) },
          // 기한을 모르는 게 보통이다. 없는 날짜를 지어내지 않고 '미정'이라고 적는다.
          { key: 'due_date', header: '지급 기한', width: 120, render: r => (
            r.due_date ? <span className="num text-sm">{r.due_date}</span> : <span className="text-xs text-muted2">미정</span>
          ) },
          { key: 'memo', header: '메모', className: 'text-sm text-muted', render: r => r.memo || '—' },
          { key: 'act', header: '', width: 120, render: r => (
            <div className="row gap-4">
              <button className="btn ghost sm" onClick={() => setEditing(r)}>수정</button>
              <button className="btn ghost sm" style={{ color: 'var(--neg)' }} onClick={() => doDelete(r)}>삭제</button>
            </div>
          ) },
        ]}/>

      <div className="text-xs text-muted2" style={{ padding: '14px 18px', lineHeight: 1.7 }}>
        · 실제로 지급하면 <b>거래를 등록</b>하고 여기 지급액을 올려주세요. 이 표가 거래를 자동으로 만들지는 않아요
        (자동으로 만들면 통장에 이미 찍힌 출금과 겹칩니다).<br/>
        · 남은 금액은 <b>자금 현황</b>에서 '나갈 돈'으로 섭니다. 기한을 비워두면 '기한 미정'으로 잡아요.
      </div>

      <SeveranceDrawer row={editing} employees={employees}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }}/>
    </div>
  );
};

const SeveranceDrawer = ({ row, employees, onClose, onSaved }) => {
  const toast = useToast();
  const blank = { employee_id: '', name: '', status: 'retired', amount: '', paid_amount: '', due_date: '', memo: '' };
  const [f, setF] = useState(blank);
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));
  const isNew = row === 'new';
  useEffect(() => {
    if (!row) return;
    setF(isNew ? blank : {
      employee_id: row.employee_id || '', name: row.name || '', status: row.status || 'retired',
      amount: String(row.amount || ''), paid_amount: String(row.paid_amount || ''),
      due_date: row.due_date || '', memo: row.memo || '',
    });
  }, [row]);
  if (!row) return null;

  // 직원을 고르면 이름·재직여부를 따라 채운다. 명단에 없는 옛 퇴사자는 이름만 직접 적을 수 있다.
  const pickEmployee = (id) => {
    const e = employees.find(x => x.id === id);
    /* 퇴사면 retired, 재직이면 active — 예전엔 퇴사일 때만 따라가고 기본값이 'retired' 라
       재직 중인 직원을 골라도 퇴직자로 집계됐다(칩을 직접 안 누르면). */
    setF(prev => ({
      ...prev, employee_id: id,
      name: e?.name || prev.name,
      status: e ? (e.status === '퇴사' ? 'retired' : 'active') : prev.status,
    }));
  };

  const [busy, setBusy] = useState(false);
  const save = async () => {
    // 왕복 중 두 번 누르면 같은 퇴직금이 2건 생기고 자금 현황이 두 번 센다
    if (busy) return;
    setBusy(true);
    try {
      const body = { ...f, employee_id: f.employee_id || null, due_date: f.due_date || null };
      const res = isNew ? await api.addUnpaidLabor(body) : await api.updateUnpaidLabor(row.id, body);
      if (!res.ok) return toast.push(res.error || '저장에 실패했어요', { tone: 'warn' });
      toast.push(isNew ? '등록했어요' : '수정했어요');
      onSaved();
    } finally { setBusy(false); }
  };

  return (
    <Drawer open onClose={onClose}>
      <DrawerHead title={isNew ? '미지급 퇴직금 등록' : '미지급 퇴직금 수정'}
        sub="아직 안 나간 퇴직금이에요. 급여는 급여대장에서 관리해요." onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div>
          <label className="label">직원</label>
          {/* allowAdd 기본값이 true 라 "Enter로 새로 등록할 수 있어요"가 떴는데 onAddNew 가 없어
              아무 일도 안 났다. 여기서 직원을 새로 만들 일도 없다.
              부서는 어댑터가 `dept` 로 내려준다 — `department` 로 읽어 늘 빈칸이었다. */}
          <Combobox value={f.employee_id} onChange={pickEmployee} allowAdd={false}
            options={employees.map(e => ({ value: e.id, label: e.name, sub: [e.dept, e.status].filter(Boolean).join(' · ') }))}
            placeholder="직원 선택 (명단에 없으면 비워두세요)"/>
        </div>
        <div>
          <label className="label">성명 *</label>
          <input className="input" value={f.name} onChange={e => set('name', e.target.value)} placeholder="예) 홍길동"/>
        </div>
        <div>
          <label className="label">구분</label>
          <div className="row gap-4">
            {[['retired', '퇴직자'], ['active', '현직원']].map(([v, l]) => (
              <button key={v} type="button" className={`chip ${f.status === v ? 'active' : ''}`}
                onClick={() => set('status', v)}>{l}</button>
            ))}
          </div>
        </div>
        <div className="row gap-8">
          <div style={{ flex: 1 }}>
            <label className="label">퇴직금 총액 *</label>
            <MoneyInput value={f.amount} onChange={v => set('amount', v)}/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">이미 지급한 금액</label>
            <MoneyInput value={f.paid_amount} onChange={v => set('paid_amount', v)}/>
          </div>
        </div>
        <div>
          <label className="label">지급 기한</label>
          <input className="input" type="date" value={f.due_date} onChange={e => set('due_date', e.target.value)}/>
          <div className="text-xs text-muted2" style={{ marginTop: 4 }}>
            모르면 비워두세요. '기한 미정'으로 잡아 자금 현황에서 지금 나갈 돈처럼 보수적으로 셉니다.
          </div>
        </div>
        <div>
          <label className="label">메모</label>
          <input className="input" value={f.memo} onChange={e => set('memo', e.target.value)} placeholder="예) 2024년 퇴사, 분할 지급 협의"/>
        </div>
      </div>
      <DrawerFooter onCancel={onClose} onSave={save} saveDisabled={busy}
        saveLabel={busy ? '저장 중…' : (isNew ? '등록' : '수정')}/>
    </Drawer>
  );
};

/* ───────── 용역·일용 대장 (월별 지급 회차, seq>=1) ───────── */
const ServiceLedgerTab = ({ month, setMonth }) => {
  const [rows, setRows] = useState([]);
  // 미지급 회차를 여기서 바로 지급 처리한다(급여대장과 같은 Drawer·같은 API)
  const [payTarget, setPayTarget] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const load = () => api.getPayroll(month, "service").then(setRows);
  useEffect(() => { load() }, [month]);
  useEffect(() => { api.getAccounts().then(setAccounts) }, []);

  const gross = rows.reduce((s, r) => s + (Number(r.net_salary) || 0), 0);
  const paid = rows.reduce((s, r) => s + (Number(r.paid) || 0), 0);
  const unpaid = rows.reduce((s, r) => s + (Number(r.unpaid) || 0), 0);
  const people = new Set(rows.map(r => r.employee_id)).size;

  return (
    <div style={{ padding: "18px 18px 8px" }}>
      <div className="row gap-8" style={{ marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, -1))}><Icon.Left size={14}/></button>
        <div className="fw-700" style={{ fontSize: 15, minWidth: 90, textAlign: "center" }}>{monthLabel(month)}</div>
        <button className="btn ghost sm" onClick={() => setMonth(shiftMonth(month, 1))}><Icon.Right size={14}/></button>
        <div className="ml-auto text-xs text-muted2">지급 등록은 <b>기타 용역·일용</b> 메뉴의 인력 상세에서 해요</div>
      </div>

      <KpiRow cols={4} style={{ marginBottom: 16 }}>
        <Kpi label="지급 발생"  value={fmtNum(gross) + "원"}  badge={`${rows.length}건`}     badgeTone="ink"/>
        <Kpi label="지급 완료"  value={fmtNum(paid) + "원"}   badge="실제 이체분"            badgeTone="brand"/>
        <Kpi label="미지급"     value={fmtNum(unpaid) + "원"} badge="아직 못 준 금액"        badgeTone={unpaid > 0 ? "warn" : "ink"}/>
        <Kpi label="인원"       value={people + "명"}         badge="용역·일용"              badgeTone="ink"/>
      </KpiRow>

      <DataTable
        rows={rows}
        empty={`${monthLabel(month)}에 용역·일용 지급 내역이 없어요.`}
        columns={[
          { key: 'name', header: '성명', sortable: true, render: r => <span className="fw-700">{r.name}</span> },
          { key: 'seq', header: '회차', render: r => <span className="text-sm text-muted">#{r.seq}</span> },
          { key: 'work', header: '업무', render: r => {
            const work = (Array.isArray(r.qty_lines) ? r.qty_lines : []).map(l => l.name).filter(Boolean).join(", ");
            return <span className="text-sm text-muted">{work || "—"}</span>
          } },
          { key: 'net_salary', header: '지급액', align: 'right', sortable: true, render: r => <span className="num-cell">{fmtNum(r.net_salary)}</span> },
          { key: 'paid', header: '지급 완료', align: 'right', render: r => <span className="num-cell">{fmtNum(r.paid)}</span> },
          { key: 'payStatus', header: '상태', render: r => <StatusBadge status={r.payStatus}/> },
          { key: 'act', header: '', align: 'right', render: r => (
            Number(r.unpaid) > 0
              ? <button className="btn sm" onClick={() => setPayTarget(r)}><Icon.Bank size={12}/> 지급</button>
              : null
          ) },
        ]}
      />
      <PayrollPayDrawer row={payTarget} accounts={accounts} label="용역비"
        onClose={() => setPayTarget(null)} onSaved={() => load()}/>
    </div>
  );
};

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
    else toast.push("저장에 실패했어요", { tone: 'warn' });
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
      <DrawerHead
        title={<>{row.name} 급여 명세 — {monthLabel(row.month)}</>}
        sub={<>{row.department || "—"} · {row.role || "—"} · 각 항목을 %나 금액으로 직접 입력하세요</>}
        onClose={onClose}/>

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

