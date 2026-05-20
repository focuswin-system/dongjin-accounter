import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge } from '../lib/ui'
import { MiniStat } from './Home'

export const PAYROLL_CONFIG = {
  effectiveYear: 2026,
  payDay: 25,
  rates: {
    pension:  { label: "국민연금",   employee: 4.5,    employer: 4.5,    base: "보수월액",   agency: "국민연금공단" },
    health:   { label: "건강보험",   employee: 3.545,  employer: 3.545,  base: "보수월액",   agency: "국민건강보험공단" },
    care:     { label: "장기요양",   employee: 0.4591, employer: 0.4591, base: "건강보험료",  agency: "국민건강보험공단", note: "건강보험료 × 12.95%" },
    jobless:  { label: "고용보험",   employee: 0.9,    employer: 1.05,   base: "보수월액",   agency: "근로복지공단" },
    accident: { label: "산재보험",   employee: 0,      employer: 0.7,    base: "보수월액",   agency: "근로복지공단", note: "업종에 따라 0.7% ~ 18.6%" },
  },
  taxFree: {
    meal:    200000,
    vehicle: 200000,
  },
};

function lookupIncomeTax(taxable, dependents) {
  if (taxable <= 1060000) return 0;
  const brackets = [
    { upto: 1500000,  base: 0,      rate: 0.006 },
    { upto: 2000000,  base: 2640,   rate: 0.012 },
    { upto: 2500000,  base: 8640,   rate: 0.024 },
    { upto: 3000000,  base: 20640,  rate: 0.036 },
    { upto: 4000000,  base: 38640,  rate: 0.054 },
    { upto: 5000000,  base: 92640,  rate: 0.072 },
    { upto: 6500000,  base: 164640, rate: 0.090 },
    { upto: 8500000,  base: 299640, rate: 0.115 },
    { upto: 99999999, base: 529640, rate: 0.150 },
  ];
  const b = brackets.find(b => taxable <= b.upto);
  const gross = b.base + (taxable - (brackets[brackets.indexOf(b) - 1]?.upto || 1060000)) * b.rate;
  const deduction = Math.min(0.7, dependents * 0.12);
  return Math.max(0, Math.round(gross * (1 - deduction)));
}

export const HR_EMPLOYEES = [
  { code: "E2015-001", name: "정대표", dept: "대표",         pos: "대표이사", join: "2015-03-15", status: "재직", account: "기업은행 *1234",  pay: { base: 8500000, mealAllowance: 200000, positionAllowance: 800000, vehicleAllowance: 200000, dependents: 3, childDependents: 1 } },
  { code: "E2018-007", name: "정수민", dept: "관리지원본부", pos: "팀장",     join: "2018-04-02", status: "재직", account: "신한은행 *5021",  pay: { base: 5400000, mealAllowance: 200000, positionAllowance: 300000, vehicleAllowance: 0,      dependents: 2, childDependents: 1 } },
  { code: "E2024-014", name: "한경리", dept: "관리지원본부", pos: "사원",     join: "2024-01-08", status: "재직", account: "기업은행 *7732",  pay: { base: 3200000, mealAllowance: 200000, positionAllowance: 0,      vehicleAllowance: 0,      dependents: 1, childDependents: 0 } },
  { code: "E2020-003", name: "이지원", dept: "영업본부",     pos: "과장",     join: "2020-06-20", status: "재직", account: "국민은행 *3344",  pay: { base: 4700000, mealAllowance: 200000, positionAllowance: 200000, vehicleAllowance: 200000, dependents: 2, childDependents: 0 } },
  { code: "E2025-002", name: "윤서연", dept: "영업본부",     pos: "사원",     join: "2025-02-03", status: "수습", account: "—",               pay: { base: 2900000, mealAllowance: 200000, positionAllowance: 0,      vehicleAllowance: 0,      dependents: 1, childDependents: 0 } },
  { code: "E2019-005", name: "박서연", dept: "생산본부",     pos: "대리",     join: "2019-09-13", status: "재직", account: "신한은행 *8810",  pay: { base: 4300000, mealAllowance: 200000, positionAllowance: 150000, vehicleAllowance: 0,      dependents: 1, childDependents: 0 } },
  { code: "E2022-011", name: "최민호", dept: "생산본부",     pos: "사원",     join: "2022-11-20", status: "재직", account: "기업은행 *4503",  pay: { base: 3500000, mealAllowance: 200000, positionAllowance: 100000, vehicleAllowance: 0,      dependents: 1, childDependents: 0 } },
];

export const MONTHLY_EXTRA = {
  "E2015-001": { bonus: 0,       overtime: 0,      extraDeduction: 0, memo: "" },
  "E2018-007": { bonus: 600000,  overtime: 0,      extraDeduction: 0, memo: "KF-21 납품 인센티브" },
  "E2024-014": { bonus: 0,       overtime: 180000, extraDeduction: 0, memo: "결산 마감 야근" },
  "E2020-003": { bonus: 400000,  overtime: 0,      extraDeduction: 0, memo: "신규 수주 인센티브" },
  "E2025-002": { bonus: 0,       overtime: 0,      extraDeduction: 0, memo: "" },
  "E2019-005": { bonus: 0,       overtime: 220000, extraDeduction: 0, memo: "초도검사 대응" },
  "E2022-011": { bonus: 0,       overtime: 280000, extraDeduction: 0, memo: "야간 가공작업" },
};

export function calcPayslip(emp, extra = { bonus: 0, overtime: 0, extraDeduction: 0 }) {
  const p = emp.pay;
  const taxFreeMeal    = Math.min(p.mealAllowance,    PAYROLL_CONFIG.taxFree.meal);
  const taxableMeal    = Math.max(0, p.mealAllowance - taxFreeMeal);
  const taxFreeVehicle = Math.min(p.vehicleAllowance, PAYROLL_CONFIG.taxFree.vehicle);
  const taxableVehicle = Math.max(0, p.vehicleAllowance - taxFreeVehicle);

  const gross = p.base + p.positionAllowance + p.mealAllowance + p.vehicleAllowance + (extra.bonus || 0) + (extra.overtime || 0);
  const taxableIncome = p.base + p.positionAllowance + taxableMeal + taxableVehicle + (extra.bonus || 0) + (extra.overtime || 0);

  const r = PAYROLL_CONFIG.rates;
  const pension = Math.round(taxableIncome * r.pension.employee / 100);
  const health  = Math.round(taxableIncome * r.health.employee / 100);
  const care    = Math.round(health * r.care.employee / 100 * (100 / 3.545));
  const jobless = Math.round(taxableIncome * r.jobless.employee / 100);

  const pensionEmp  = Math.round(taxableIncome * r.pension.employer / 100);
  const healthEmp   = Math.round(taxableIncome * r.health.employer / 100);
  const careEmp     = Math.round(healthEmp * r.care.employer / 100 * (100 / 3.545));
  const joblessEmp  = Math.round(taxableIncome * r.jobless.employer / 100);
  const accidentEmp = Math.round(taxableIncome * r.accident.employer / 100);

  const totalDependents = (emp.pay.dependents || 1) + (emp.pay.childDependents || 0);
  const incomeTax = lookupIncomeTax(taxableIncome, totalDependents);
  const localTax  = Math.round(incomeTax * 0.1);

  const deductTotal = pension + health + care + jobless + incomeTax + localTax + (extra.extraDeduction || 0);
  const net = gross - deductTotal;
  const employerTotal = pensionEmp + healthEmp + careEmp + joblessEmp + accidentEmp;

  return {
    gross, taxableIncome, taxFreeMeal, taxableMeal, taxFreeVehicle, taxableVehicle,
    pension, health, care, jobless, incomeTax, localTax,
    pensionEmp, healthEmp, careEmp, joblessEmp, accidentEmp, employerTotal,
    extraDeduction: extra.extraDeduction || 0,
    deductTotal, net,
  };
}

const sum = (payslips, key) => payslips.reduce((a, p) => a + (p.slip[key] || 0), 0);

/* ───────── HRScreen ───────── */
export const HRScreen = () => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [tab, setTab] = useState("이번 달 급여");
  const [empDrawer, setEmpDrawer] = useState(null);
  const [payslipEmp, setPayslipEmp] = useState(null);
  const [closeDrawer, setCloseDrawer] = useState(false);
  const [monthExtras, setMonthExtras] = useState(MONTHLY_EXTRA);
  const [closed, setClosed] = useState(false);

  const active = HR_EMPLOYEES.filter(e => e.status === "재직" || e.status === "수습");
  const payslips = active.map(e => ({ emp: e, slip: calcPayslip(e, monthExtras[e.code] || {}), extra: monthExtras[e.code] || {} }));
  const totalGross    = payslips.reduce((a, p) => a + p.slip.gross, 0);
  const totalDeduct   = payslips.reduce((a, p) => a + p.slip.deductTotal, 0);
  const totalNet      = payslips.reduce((a, p) => a + p.slip.net, 0);
  const totalEmployer = payslips.reduce((a, p) => a + p.slip.employerTotal, 0);

  const handleBulkPay = async () => {
    const ok = await confirm({
      tone: "neg", icon: <Icon.Bank size={22}/>,
      title: "2026년 5월 급여를 일괄 이체할까요?",
      body: "직원 7명에게 실수령액이 등록된 급여 계좌로 이체됩니다. 인건비 지출이 자동 생성되고, 4대보험·원천세 납부 일정이 다음달 10일로 잡혀요.",
      detail: `이체 합계 ${fmtNum(totalNet)}원 · 기업은행 *123 출금`,
      confirmLabel: "급여 이체 실행",
    });
    if (ok) toast.push("5월 급여가 일괄 이체되었어요");
  };

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
            {tab === "이번 달 급여" && (
              <>
                <button className="btn" onClick={() => setCloseDrawer(true)}><Icon.Pencil/> 5월 마감하기</button>
                <button className="btn" onClick={() => toast.push("급여 명세를 PDF로 일괄 발행했어요")}><Icon.Print/> 명세서 일괄 발행</button>
                <button className="btn primary" onClick={handleBulkPay}><Icon.Bank/> 급여 일괄 이체</button>
              </>
            )}
          </div>
        </div>
        <Spacer h={20}/>

        <div className="card" style={{ overflow: "hidden" }}>
          <div className="tab-bar" style={{ padding: "0 12px" }}>
            {["이번 달 급여", "직원"].map(t => (
              <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>

          {tab === "이번 달 급여" && (
            <div>
              <div className="alert-row" style={{ margin: 18, background: closed ? "var(--pos-soft)" : "var(--brand-soft)", borderColor: "transparent" }}>
                <Icon.Sparkle/>
                <div>
                  <div className="lead">{closed ? "2026년 5월 급여가 마감되었습니다" : "2026년 5월 급여 명세 자동 산출"}</div>
                  <div className="body">
                    아래 명세는 <b>직원 마스터의 기본급·수당</b> + <b>회사 기준의 4대보험 요율</b> + <b>이번 달 추가 입력(보너스·추가공제)</b>으로 자동 계산했어요.
                    {!closed && " 행을 클릭해 직원별 명세서를 확인하거나, '5월 마감하기'로 보너스·야근수당을 일괄 입력하세요."}
                  </div>
                </div>
                {closed && <span className="badge pos ml-auto">마감 완료</span>}
              </div>

              <div className="grid grid-4-to-2" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 12, padding: "0 18px 18px" }}>
                <MiniStat label="이번 달 급여 총액" value={fmtNum(totalGross) + "원"}    sub={`지급일 5/${PAYROLL_CONFIG.payDay}`} tone="ink"/>
                <MiniStat label="공제 합계"          value={fmtNum(totalDeduct) + "원"}   sub="4대보험·세금"                        tone="warn"/>
                <MiniStat label="실수령 합계"        value={fmtNum(totalNet) + "원"}      sub="계좌 이체 금액"                     tone="brand"/>
                <MiniStat label="회사 부담분"        value={fmtNum(totalEmployer) + "원"} sub="4대보험 사용자분"                   tone="neg"/>
              </div>

              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>사번</th><th>이름</th><th>부서/직위</th>
                      <th className="num-right">기본급</th><th className="num-right">수당</th>
                      <th className="num-right">이번달 추가</th><th className="num-right">공제</th>
                      <th className="num-right">실수령</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {payslips.map(({ emp, slip, extra }, i) => {
                      const baseAllowance = emp.pay.positionAllowance + emp.pay.mealAllowance + emp.pay.vehicleAllowance;
                      const monthExtraAmt = (extra.bonus || 0) + (extra.overtime || 0);
                      return (
                        <tr key={i} style={{ cursor: "pointer" }} onClick={() => setPayslipEmp({ emp, slip, extra })}>
                          <td className="num text-muted text-sm">{emp.code}</td>
                          <td className="fw-700">{emp.name} {emp.status === "수습" && <span className="badge warn" style={{ marginLeft: 4 }}>수습</span>}</td>
                          <td className="text-sm text-muted">{emp.dept} · {emp.pos}</td>
                          <td className="num-cell num-right">{fmtNum(emp.pay.base)}</td>
                          <td className="num-cell num-right text-muted">{fmtNum(baseAllowance)}</td>
                          <td className="num-cell num-right" style={{ color: monthExtraAmt > 0 ? "var(--pos)" : "var(--muted-2)" }}>
                            {monthExtraAmt > 0 ? "+" + fmtNum(monthExtraAmt) : "—"}
                          </td>
                          <td className="num-cell num-right text-warn">-{fmtNum(slip.deductTotal)}</td>
                          <td className="num-cell num-right fw-700">{fmtNum(slip.net)}</td>
                          <td><button className="btn ghost sm">명세서</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: "var(--surface-2)" }}>
                      <td colSpan={3} className="fw-700" style={{ padding: "14px 14px" }}>합계 (재직 {payslips.length}명)</td>
                      <td className="num-cell num-right fw-700">{fmtNum(payslips.reduce((a,p) => a + p.emp.pay.base, 0))}</td>
                      <td className="num-cell num-right fw-700 text-muted">{fmtNum(payslips.reduce((a,p) => a + p.emp.pay.positionAllowance + p.emp.pay.mealAllowance + p.emp.pay.vehicleAllowance, 0))}</td>
                      <td className="num-cell num-right fw-700 text-pos">+{fmtNum(payslips.reduce((a,p) => a + (p.extra.bonus || 0) + (p.extra.overtime || 0), 0))}</td>
                      <td className="num-cell num-right fw-700 text-warn">-{fmtNum(totalDeduct)}</td>
                      <td className="num-cell num-right fw-700" style={{ fontSize: 14 }}>{fmtNum(totalNet)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {tab === "직원" && (
            <div>
              <div className="row" style={{ padding: "16px 18px", borderBottom: "1px solid var(--line)" }}>
                <div>
                  <div className="section-title">직원 명부</div>
                  <div className="section-sub">전체 {HR_EMPLOYEES.length}명 · 재직 {active.length}명</div>
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
                    {HR_EMPLOYEES.map((e, i) => (
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
                          <button className="btn ghost sm" onClick={(ev) => { ev.stopPropagation(); setEmpDrawer({ mode: "edit", emp: e }); }}>편집</button>
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
            <b style={{ color: "var(--ink)" }}>4대보험·원천세 신고 자료</b>는 보고서 메뉴에서 받을 수 있어요. 요율은 <b style={{ color: "var(--ink)" }}>설정 → 급여 기준</b>에서 관리합니다.
          </span>
        </div>
      </div>

      <EmployeeDrawer info={empDrawer} onClose={() => setEmpDrawer(null)}/>
      <PayslipDrawer pack={payslipEmp} onClose={() => setPayslipEmp(null)} onChanged={(code, ext) => setMonthExtras({ ...monthExtras, [code]: ext })}/>
      <MonthlyCloseDrawer
        open={closeDrawer}
        extras={monthExtras}
        employees={active}
        onClose={() => setCloseDrawer(false)}
        onSave={(next) => { setMonthExtras(next); setCloseDrawer(false); setClosed(true); toast.push("2026년 5월 급여가 마감되었어요"); }}
      />
    </>
  );
};

/* ───────── 직원 등록/편집 Drawer ───────── */
const EmployeeDrawer = ({ info, onClose }) => {
  const toast = useToast();
  if (!info) return null;
  const isNew = info.mode === "new";
  const e = info.emp || {
    code: "", name: "", dept: "재무팀", pos: "사원", join: "2026-05-13", status: "재직", account: "",
    pay: { base: 3000000, mealAllowance: 200000, positionAllowance: 0, vehicleAllowance: 0, dependents: 1, childDependents: 0 },
  };

  return (
    <>
      <div className="drawer-backdrop open" onClick={onClose}/>
      <aside className="drawer open" role="dialog" style={{ width: "min(560px, 100vw)" }}>
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>{isNew ? "새 직원 등록" : `${e.name} 직원 정보`}</div>
            <div className="text-xs text-muted">{isNew ? "기본 정보와 급여 정보를 입력하세요." : `${e.code} · ${e.dept} · ${e.pos}`}</div>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        <div className="drawer-body">
          <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 12 }}>기본 정보</div>
          <div className="col gap-16" style={{ marginBottom: 28 }}>
            <FieldRow label="사번" required><input className="input" defaultValue={e.code} placeholder="E2026-001"/></FieldRow>
            <FieldRow label="이름" required><input className="input" defaultValue={e.name}/></FieldRow>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <FieldRow label="부서"><SelectField value={e.dept} options={["대표", "관리지원본부", "영업본부", "생산본부", "연구개발팀"]}/></FieldRow>
              <FieldRow label="직위"><SelectField value={e.pos} options={["대표이사", "이사", "부장", "팀장", "과장", "대리", "주임", "사원"]}/></FieldRow>
            </div>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <FieldRow label="입사일"><input className="input num" defaultValue={e.join} placeholder="2026-05-13"/></FieldRow>
              <FieldRow label="재직 상태">
                <div className="row gap-6">
                  {["재직", "수습", "휴직", "퇴사"].map(s => (
                    <button key={s} className={`chip ${e.status === s ? "active" : ""}`}>{s}</button>
                  ))}
                </div>
              </FieldRow>
            </div>
            <FieldRow label="급여 계좌"><input className="input" defaultValue={e.account} placeholder="은행 / 계좌번호"/></FieldRow>
            <FieldRow label="주민등록번호"><input className="input num" placeholder="900101-1******"/></FieldRow>
          </div>

          <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 12 }}>급여 정보</div>
          <div className="col gap-16">
            <div className="alert-row" style={{ background: "var(--surface-2)", borderColor: "var(--line)", marginBottom: 6 }}>
              <Icon.Sparkle/>
              <div>
                <div className="lead">여기 입력한 값이 매달 급여명세에 그대로 반영됩니다.</div>
                <div className="body">식대·차량유지비는 한도 내(각 월 20만원)에서 비과세 처리돼요.</div>
              </div>
            </div>
            <FieldRow label="기본급 (월)" required><MoneyInput defaultValue={e.pay.base}/></FieldRow>
            <FieldRow label="직책수당 (월)"><MoneyInput defaultValue={e.pay.positionAllowance}/></FieldRow>
            <FieldRow label="식대 (월)" hint="월 20만원까지 비과세"><MoneyInput defaultValue={e.pay.mealAllowance}/></FieldRow>
            <FieldRow label="자가운전 보조금 (월)" hint="월 20만원까지 비과세 · 본인 차량 업무 사용 시"><MoneyInput defaultValue={e.pay.vehicleAllowance}/></FieldRow>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <FieldRow label="부양가족 수" hint="본인 포함">
                <input className="input num" type="number" min="1" defaultValue={e.pay.dependents}/>
              </FieldRow>
              <FieldRow label="20세 이하 자녀 수">
                <input className="input num" type="number" min="0" defaultValue={e.pay.childDependents}/>
              </FieldRow>
            </div>
            <div className="card" style={{ padding: 14, background: "var(--brand-soft)", border: 0 }}>
              <div className="text-xs fw-600" style={{ color: "var(--brand-ink)", marginBottom: 6 }}>예상 월 명세</div>
              <PreviewCalc emp={e}/>
            </div>
          </div>
        </div>

        <div className="drawer-foot">
          {!isNew && <button className="btn" style={{ color: "var(--neg-ink)" }}>퇴사 처리</button>}
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={onClose}>취소</button>
            <button className="btn primary" onClick={() => { onClose(); toast.push(isNew ? "직원이 등록되었어요" : "직원 정보를 저장했어요"); }}>
              <Icon.Check size={14}/> {isNew ? "등록" : "저장"}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
};

const PreviewCalc = ({ emp }) => {
  const slip = calcPayslip(emp);
  return (
    <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "4px 16px", fontSize: 12 }}>
      <span className="text-muted">지급액</span>
      <span className="num fw-700 num-right">{fmtNum(slip.gross)}원</span>
      <span className="text-muted">공제 합계</span>
      <span className="num num-right" style={{ color: "var(--neg-ink)" }}>-{fmtNum(slip.deductTotal)}원</span>
      <span className="text-muted fw-600" style={{ paddingTop: 6, borderTop: "1px solid rgba(0,0,0,0.06)" }}>실수령</span>
      <span className="num fw-700 num-right" style={{ paddingTop: 6, borderTop: "1px solid rgba(0,0,0,0.06)" }}>{fmtNum(slip.net)}원</span>
    </div>
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

const SelectField = ({ value, options }) => (
  <select defaultValue={value} style={{ width: "100%", padding: "11px 32px 11px 12px", borderRadius: 10, border: "1px solid var(--line-strong)", background: "#fff", fontFamily: "inherit", fontSize: 13.5, fontWeight: 600, appearance: "none", cursor: "pointer" }}>
    {options.map(o => <option key={o} value={o}>{o}</option>)}
  </select>
);

const PayslipRow = ({ label, note, amount, total, muted }) => (
  <div className="row" style={{ padding: total ? "12px 14px" : "8px 14px", background: total ? "var(--surface-2)" : "transparent", borderRadius: total ? 10 : 0, fontWeight: total ? 700 : 500, fontSize: total ? 14 : 13, color: muted ? "var(--muted-2)" : undefined }}>
    <span>
      {label}
      {note && <span className="text-xs text-muted2" style={{ marginLeft: 6, fontWeight: 400 }}>· {note}</span>}
    </span>
    <span className="num ml-auto" style={{ color: muted ? "var(--muted-2)" : amount < 0 ? "var(--neg-ink)" : "var(--ink)" }}>
      {amount === 0 ? "—" : (amount < 0 ? "-" : "") + fmtNum(Math.abs(amount)) + "원"}
    </span>
  </div>
);

/* ───────── 명세서 Drawer ───────── */
const PayslipDrawer = ({ pack, onClose, onChanged }) => {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [bonus, setBonus] = useState(0);
  const [overtime, setOvertime] = useState(0);
  const [extraDed, setExtraDed] = useState(0);

  useEffect(() => {
    if (pack) {
      setEditing(false);
      setBonus(pack.extra.bonus || 0);
      setOvertime(pack.extra.overtime || 0);
      setExtraDed(pack.extra.extraDeduction || 0);
    }
  }, [pack]);

  if (!pack) return null;
  const { emp } = pack;
  const slip = editing ? calcPayslip(emp, { bonus, overtime, extraDeduction: extraDed }) : pack.slip;

  return (
    <>
      <div className="drawer-backdrop open" onClick={onClose}/>
      <aside className="drawer open" role="dialog" style={{ width: "min(540px, 100vw)" }}>
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>{emp.name} 급여 명세 — 2026년 5월</div>
            <div className="text-xs text-muted">{emp.code} · {emp.dept} · {emp.pos}</div>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        <div className="drawer-body">
          <div className="card" style={{ padding: 18, background: "var(--surface-2)", border: "1px solid var(--line)", marginBottom: 18 }}>
            <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 4 }}>실수령액</div>
            <div className="num fw-700" style={{ fontSize: 30, letterSpacing: "-0.02em" }}>{fmtNum(slip.net)}<span className="text-muted" style={{ fontWeight: 400, fontSize: 16, marginLeft: 4 }}>원</span></div>
            <div className="text-xs text-muted" style={{ marginTop: 6 }}>2026-05-{PAYROLL_CONFIG.payDay} 지급 예정 · {emp.account}</div>
          </div>

          <div className="row" style={{ marginBottom: 10 }}>
            <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.02em" }}>이번 달 추가 입력</div>
            {!editing && <button className="btn ghost sm ml-auto" onClick={() => setEditing(true)}><Icon.Pencil size={12}/> 수정</button>}
          </div>
          {editing ? (
            <div className="card" style={{ padding: 14, marginBottom: 18, border: "1px solid var(--brand)", background: "#fff" }}>
              <div className="col gap-10">
                <FieldRow label="보너스/성과급"><MoneyInputControlled value={bonus} onChange={setBonus}/></FieldRow>
                <FieldRow label="야근/시간외 수당"><MoneyInputControlled value={overtime} onChange={setOvertime}/></FieldRow>
                <FieldRow label="추가 공제" hint="식대 차감, 가불 회수 등"><MoneyInputControlled value={extraDed} onChange={setExtraDed}/></FieldRow>
                <div className="row gap-6" style={{ paddingTop: 8, borderTop: "1px solid var(--line)" }}>
                  <button className="btn sm" onClick={() => setEditing(false)}>취소</button>
                  <button className="btn primary sm ml-auto" onClick={() => {
                    onChanged && onChanged(emp.code, { bonus, overtime, extraDeduction: extraDed, memo: pack.extra.memo || "" });
                    setEditing(false);
                    toast.push("이번 달 명세가 반영되었어요");
                  }}><Icon.Check size={12}/> 저장</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="col gap-8" style={{ marginBottom: 18 }}>
              <PayslipRow label="보너스/성과급"    amount={pack.extra.bonus || 0}    muted={!pack.extra.bonus}/>
              <PayslipRow label="야근/시간외 수당" amount={pack.extra.overtime || 0} muted={!pack.extra.overtime}/>
              {pack.extra.extraDeduction > 0 && <PayslipRow label="추가 공제" amount={-pack.extra.extraDeduction}/>}
              {pack.extra.memo && <div className="text-xs text-muted2" style={{ padding: "4px 14px" }}>· {pack.extra.memo}</div>}
            </div>
          )}

          <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.02em", marginBottom: 10 }}>지급 항목</div>
          <div className="col gap-8" style={{ marginBottom: 18 }}>
            <PayslipRow label="기본급" amount={emp.pay.base}/>
            {emp.pay.positionAllowance > 0 && <PayslipRow label="직책수당" amount={emp.pay.positionAllowance}/>}
            {emp.pay.mealAllowance > 0 && <PayslipRow label="식대" amount={emp.pay.mealAllowance} note="비과세 한도 20만원"/>}
            {emp.pay.vehicleAllowance > 0 && <PayslipRow label="자가운전 보조금" amount={emp.pay.vehicleAllowance} note="비과세 한도 20만원"/>}
            {(pack.extra.bonus > 0) && <PayslipRow label="보너스/성과급" amount={pack.extra.bonus}/>}
            {(pack.extra.overtime > 0) && <PayslipRow label="야근/시간외 수당" amount={pack.extra.overtime}/>}
            <PayslipRow label="지급 합계" amount={slip.gross} total/>
          </div>

          <div className="text-xs text-muted2 fw-600" style={{ letterSpacing: "0.02em", marginBottom: 10 }}>공제 항목</div>
          <div className="col gap-8" style={{ marginBottom: 18 }}>
            <PayslipRow label="국민연금"   note={`${PAYROLL_CONFIG.rates.pension.employee}%`}  amount={-slip.pension}/>
            <PayslipRow label="건강보험"   note={`${PAYROLL_CONFIG.rates.health.employee}%`}   amount={-slip.health}/>
            <PayslipRow label="장기요양"   note="건강보험료 × 12.95%"                          amount={-slip.care}/>
            <PayslipRow label="고용보험"   note={`${PAYROLL_CONFIG.rates.jobless.employee}%`}  amount={-slip.jobless}/>
            <PayslipRow label="소득세"     note={`간이세액표 · 부양가족 ${emp.pay.dependents + emp.pay.childDependents}명`} amount={-slip.incomeTax}/>
            <PayslipRow label="지방소득세" note="소득세 × 10%"                                  amount={-slip.localTax}/>
            {slip.extraDeduction > 0 && <PayslipRow label="추가 공제" amount={-slip.extraDeduction}/>}
            <PayslipRow label="공제 합계" amount={-slip.deductTotal} total/>
          </div>

          <div className="alert-row" style={{ background: "var(--brand-soft)", borderColor: "transparent" }}>
            <Icon.Sparkle/>
            <div>
              <div className="lead">계산 근거</div>
              <div className="body">직원 마스터의 급여 정보 + 회사 기준의 4대보험 요율로 자동 계산했어요.</div>
            </div>
          </div>
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>닫기</button>
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={() => toast.push(`${emp.name} 명세서를 PDF로 발행했어요`)}><Icon.Print size={14}/> 명세서 발행</button>
            <button className="btn primary" onClick={() => toast.push(`${emp.name}에게 이메일로 발송했어요`)}>이메일 발송</button>
          </div>
        </div>
      </aside>
    </>
  );
};

/* ───────── 월 마감 Drawer ───────── */
const MonthlyCloseDrawer = ({ open, extras, employees, onClose, onSave }) => {
  const [local, setLocal] = useState({});
  useEffect(() => { if (open) setLocal({ ...extras }); }, [open]);
  if (!open) return null;

  const update = (code, field, v) => {
    setLocal({ ...local, [code]: { ...(local[code] || {}), [field]: parseInt(v.replace(/[^0-9]/g, "")) || 0 } });
  };
  const updateMemo = (code, v) => {
    setLocal({ ...local, [code]: { ...(local[code] || {}), memo: v } });
  };

  const totalGross = employees.reduce((a, e) => a + calcPayslip(e, local[e.code] || {}).gross, 0);

  return (
    <>
      <div className="drawer-backdrop open" onClick={onClose}/>
      <aside className="drawer open" role="dialog" style={{ width: "min(720px, 100vw)" }}>
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>2026년 5월 급여 마감</div>
            <div className="text-xs text-muted">직원별 이번 달 추가 지급(보너스·야근수당)과 추가 공제를 입력하세요.</div>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        <div className="drawer-body" style={{ padding: 0 }}>
          <div className="alert-row" style={{ margin: 18, background: "var(--brand-soft)", borderColor: "transparent" }}>
            <Icon.Sparkle/>
            <div>
              <div className="lead">기본급·고정 수당은 직원 마스터에서 가져왔어요.</div>
              <div className="body">여기서는 이번 달에만 발생하는 보너스·야근수당·추가 공제만 입력하면 됩니다.</div>
            </div>
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>직원</th>
                  <th className="num-right" style={{ width: 110 }}>기본급</th>
                  <th style={{ width: 130 }}>보너스</th>
                  <th style={{ width: 130 }}>야근수당</th>
                  <th style={{ width: 130 }}>추가 공제</th>
                  <th>메모</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => {
                  const x = local[e.code] || {};
                  return (
                    <tr key={e.code}>
                      <td>
                        <div className="fw-700">{e.name}</div>
                        <div className="text-xs text-muted2">{e.dept} · {e.pos}</div>
                      </td>
                      <td className="num-cell num-right text-muted">{fmtNum(e.pay.base)}</td>
                      <td><input className="input num" style={{ padding: "8px 10px", fontSize: 13 }} value={fmtNum(x.bonus || 0)} onChange={ev => update(e.code, "bonus", ev.target.value)}/></td>
                      <td><input className="input num" style={{ padding: "8px 10px", fontSize: 13 }} value={fmtNum(x.overtime || 0)} onChange={ev => update(e.code, "overtime", ev.target.value)}/></td>
                      <td><input className="input num" style={{ padding: "8px 10px", fontSize: 13 }} value={fmtNum(x.extraDeduction || 0)} onChange={ev => update(e.code, "extraDeduction", ev.target.value)}/></td>
                      <td><input className="input" style={{ padding: "8px 10px", fontSize: 13 }} value={x.memo || ""} placeholder="(선택)" onChange={ev => updateMemo(e.code, ev.target.value)}/></td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: "var(--surface-2)" }}>
                  <td colSpan={5} className="fw-700" style={{ padding: "14px 14px" }}>이번 달 지급 합계 (회사 부담 포함 전)</td>
                  <td className="num-cell num-right fw-700">{fmtNum(totalGross)}원</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>나중에</button>
          <div className="ml-auto row gap-8">
            <span className="text-xs text-muted2" style={{ alignSelf: "center" }}>마감 후에도 개별 직원 명세에서 수정할 수 있어요.</span>
            <button className="btn primary" onClick={() => onSave(local)}><Icon.Check size={14}/> 5월 마감 확정</button>
          </div>
        </div>
      </aside>
    </>
  );
};
