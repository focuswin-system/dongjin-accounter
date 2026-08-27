import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge, PERIOD_PRESETS, inPeriod, periodRangeLabel, FilterSelect, Drawer, Combobox, MoneyInput, localToday, DateInput } from '../lib/ui'
import { FileAttach } from '../lib/FileAttach'
import { api } from '../lib/api'
import { Kpi, KpiRow } from '../lib/components/Kpi'
import { PageHeader } from '../lib/components/PageHeader'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { DataTable } from '../lib/components/DataTable'
import { LinkTxnDrawer } from '../lib/components/LinkTxnDrawer'
/* 청구서 품목표와 **같은 컴포넌트**를 쓴다 — 칸 구성만 다르다(CONTRACT_COLUMNS).
   따로 만들어 두니 청구서 쪽 개선(목록 잘림·칸 자동확장·Tab 확정)이 주문에는 하나도 안 왔다. */
import { InvoiceLines, CONTRACT_COLUMNS, CONTRACT_PROGRESS_COLUMNS } from '../lib/components/InvoiceLines'
import { TxnQuickDrawer } from '../lib/components/TxnQuickDrawer'
import { BILLING_MODES, TERM_MODES, BILLING_PERIODS, billingLabel, termLabel, periodLabel, periodMonths, cycleMonthsHint,
         isRecurring, isProgress, isOpenEnded, hasTotal, amountLabel, renewalInfo, nextEndDate, recurringMismatch } from '../lib/renewal'

const numOnly = (v) => String(v ?? '').replace(/[^0-9]/g, '');
const asNum   = (v) => parseInt(numOnly(v), 10) || 0;

/* 주문 품목표 = "이 주문으로 무엇을 주고받나". 청구 방식(총액·정기·기성)과는 별개 축이라 전 타입에서 쓴다.
     총액형·정기형 — 수량×단가 합계가 곧 주문금액(정기형은 주기당 금액). 품목 0줄이면 금액을 직접 입력.
     기성형     — 수량은 주문 때 정하지 않는다(청구할 때 입력) → 수량 칸을 숨기고 단가표로만 쓴다.
   품목은 기준정보(ref_items type='item')에서 고르거나 인라인 추가. 단가·매입가는 기준정보값이 기본이고
   주문별로 수정 가능하며, 저장 시 스냅샷으로 남는다(기준정보를 나중에 고쳐도 이 주문 조건은 그대로). */
/* 단가를 무엇에 곱하는가 — 수량(기본) 또는 중량. 서버·청구서와 같은 규칙(lib/lineAmount.js).
   중량 기준인데 수량으로 곱하면 주문 금액이 조용히 달라진다. */
const basisQty = (r) => (r?.price_basis === 'weight' ? asNum(r.weight) : (asNum(r.qty) || 1));
const lineAmount = (r) => basisQty(r) * asNum(r.unit_price);
const itemsTotal = (rows) => (rows || []).filter(r => (r.name || '').trim()).reduce((s, r) => s + lineAmount(r), 0);
const itemsCost  = (rows) => (rows || []).filter(r => (r.name || '').trim()).reduce((s, r) => s + basisQty(r) * asNum(r.cost_price), 0);

const ContractItemsEditor = ({ form, set, itemMaster, reloadMaster, withQty = false, required = false, hint }) => {
  const rows = form.items || [];
  const setRows = (next) => set(f => ({ ...f, items: next }));

  /* 목록에 없는 품목은 **기준정보에 등록하고** 그 id 를 돌려준다.
     청구서는 이름만 남기면 되지만(명세서에 찍히면 그만), 주문 품목표는 다음 주문에서도
     같은 품목을 고를 수 있어야 한다. */
  const addNewItem = async (name) => {
    const res = await api.addRefItem({ type: 'item', name });
    await reloadMaster();
    return res.id || '';
  };

  return (
    <div>
      <InvoiceLines
        lines={rows}
        onChange={setRows}
        itemMaster={itemMaster}
        columns={withQty ? CONTRACT_COLUMNS : CONTRACT_PROGRESS_COLUMNS}
        label={<>품목 {required
          ? <span style={{ color: 'var(--neg-ink)' }}>*</span>
          : <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span>}</>}
        labelHint={null}
        addLabel="품목 추가"
        emptyHint={hint}
        onAddNewItem={addNewItem}
        /* 합계 판정을 itemsTotal·itemsCost 와 **같은 규칙**으로 맞춘다(이름이 있어야 센다).
           안 맞추면 합계는 뜨는데 저장은 "품목을 등록해주세요"로 거절된다. */
        isUsableLine={(r) => !!String(r?.name || '').trim()}
      />
      {hint && rows.length > 0 && (
        <div className="text-xs text-muted2" style={{ marginTop: 6 }}>{hint}</div>
      )}
    </div>
  );
};

/* 상대편 번호·프로젝트 번호 — 둘 다 선택 입력이라 폼 맨 아래(계약서 첨부 위)에 둔다.
   업종마다 부르는 이름이 다르다(조선=호선번호, 천막=설치현장, 선반=작업지시번호, SW=프로젝트코드)
   → 라벨은 업종중립으로 두고 예시로 감을 준다. */
const ContractRefFields = ({ form, set }) => (
  <div className="row gap-12">
    <div style={{ flex: 1 }}>
      <label className="label" style={{ marginBottom: 8 }}>
        발주번호 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span>
      </label>
      <input className="input" value={form.order_no || ''} placeholder="고객사에서 받은 발주번호"
        onChange={e => set(f => ({ ...f, order_no: e.target.value }))}/>
    </div>
    <div style={{ flex: 1 }}>
      <label className="label" style={{ marginBottom: 8 }}>
        프로젝트·공사번호 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span>
      </label>
      <input className="input" value={form.project_no || ''} placeholder="예: PRJ-2026-01 / 231호선"
        onChange={e => set(f => ({ ...f, project_no: e.target.value }))}/>
    </div>
  </div>
)

/* 주문 조건 입력 — 신규 생성/편집 Drawer 공용.
   청구 방식(총액형·정기형·기성형)과 종료 방식(만료·자동갱신·무기한)이 독립이라, 금액·기간 칸도 그에 따라 바뀐다. */
const ContractTermFields = ({ form, set }) => {
  const recurring = form.billing_mode === 'recurring';
  const progress  = form.billing_mode === 'progress';
  const openEnded = form.term_mode === 'open';
  // 기성형은 품목 단가표에서 쓸 품목 기준정보를 불러온다(인라인 추가 시 갱신).
  const [itemMaster, setItemMaster] = useState([]);
  const reloadMaster = () => api.getRefItems('item').then(r => setItemMaster(r || []));
  useEffect(() => { reloadMaster(); }, []);
  // 갱신 개념이 있는 주문만 연장기간·통보기한이 의미 있다.
  // (총액형+기간만료 = 구축 프로젝트는 끝나면 끝 → 갱신 임박 알림 대상도 아님. 무기한은 애초에 없음)
  const hasRenewal = !openEnded && (form.term_mode === 'auto_renew' || recurring);
  // 품목을 적었으면 그 합계가 금액이다(서버 contract-model도 같은 규칙으로 다시 매긴다).
  const lineSum = itemsTotal(form.items);
  const byItems = lineSum > 0;
  const unitAmt = byItems ? lineSum : asNum(form.unit_amount);
  const totalAmt = byItems ? lineSum : asNum(form.amount);
  // 정기형 주문 총액 미리보기 = 주기당 금액 × 기간 안 회차수
  const preview = (() => {
    if (!recurring || openEnded || !form.start_date || !form.end_date) return null;
    const unit = unitAmt;
    if (!unit) return null;
    const s = new Date(form.start_date), e = new Date(form.end_date);
    if (isNaN(s) || isNaN(e) || e < s) return null;
    const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
    const full = e.getDate() >= s.getDate() ? months + 1 : months;
    const cycles = Math.max(1, Math.floor(full / periodMonths(form.billing_period)));
    return { cycles, total: unit * cycles };
  })();

  return (
    <>
      <div>
        <label className="label" style={{ marginBottom: 8 }}>청구 방식</label>
        <div className="row gap-6">
          {BILLING_MODES.map(t => (
            <button key={t.value} type="button" className={`chip ${form.billing_mode === t.value ? 'active' : ''}`}
              onClick={() => set(f => ({ ...f, billing_mode: t.value }))}>{t.label}</button>
          ))}
        </div>
        <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
          {BILLING_MODES.find(t => t.value === form.billing_mode)?.hint}
        </div>
      </div>

      <div>
        <label className="label" style={{ marginBottom: 8 }}>종료 방식</label>
        <div className="row gap-6">
          {TERM_MODES.map(t => (
            <button key={t.value} type="button" className={`chip ${form.term_mode === t.value ? 'active' : ''}`}
              onClick={() => set(f => ({ ...f, term_mode: t.value }))}>{t.label}</button>
          ))}
        </div>
        <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
          {TERM_MODES.find(t => t.value === form.term_mode)?.hint}
        </div>
      </div>

      <div>
        <label className="label" style={{ marginBottom: 8 }}>부가세</label>
        <div className="row gap-6">
          {[{ value: 'taxable', label: '과세' }, { value: 'exempt', label: '면세' }, { value: 'zero', label: '영세' }].map(t => (
            <button key={t.value} type="button" className={`chip ${(form.vat_mode || 'taxable') === t.value ? 'active' : ''}`}
              onClick={() => set(f => ({ ...f, vat_mode: t.value }))}>{t.label}</button>
          ))}
        </div>
        <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
          {form.vat_mode === 'exempt'
            ? '부가세 없는 주문(면세). 청구서 발행 시 부가세 0으로 처리돼요.'
            : form.vat_mode === 'zero'
              ? '영세율(수출·해외용역) — 세율 0%라 세액은 없지만, 공급가액은 부가세 신고의 과세표준에 들어가요.'
              : '공급가액에 부가세 10%가 붙어 청구돼요.'}
        </div>
      </div>

      {/* 금액 — 총액형은 주문 총액, 정기형은 주기당 금액, 기성형은 품목 단가표.
          어느 쪽이든 품목을 적으면 그 합계가 금액이 된다(품목 = '무엇', 청구방식 = '어떻게'). */}
      {progress ? (
        <ContractItemsEditor form={form} set={set} itemMaster={itemMaster} reloadMaster={reloadMaster} required
          hint="기성 청구할 품목과 단가를 등록하세요. 수량은 주문 상세의 기성 청구에서 회차마다 넣습니다."/>
      ) : recurring ? (
        <>
          <div className="row gap-12">
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>청구 주기</label>
              <div className="row gap-6">
                {BILLING_PERIODS.map(p => (
                  <button key={p.value} type="button" className={`chip ${form.billing_period === p.value ? 'active' : ''}`}
                    onClick={() => set(f => ({ ...f, billing_period: p.value }))}>{p.label}</button>
                ))}
              </div>
            </div>
            <div style={{ width: 110 }}>
              <label className="label" style={{ marginBottom: 8 }}>청구일</label>
              <div style={{ position: 'relative' }}>
                <input className="input num" style={{ paddingRight: 28 }} value={form.billing_day ?? ''}
                  onChange={e => set(f => ({ ...f, billing_day: numOnly(e.target.value).slice(0, 2) }))} placeholder="1"/>
                <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>일</span>
              </div>
            </div>
            {/* 분기·년은 '몇 월'인지가 이 칸에 없다 — 월은 주문 시작일이 정한다(서버 recurrence.js).
                적어 주지 않으면 '분기면 몇 월에 나가나'가 화면 어디에도 없다. */}
            <div className="text-xs text-muted2" style={{ alignSelf: 'center', marginTop: 18 }}>
              {cycleMonthsHint(form.start_date, form.billing_day, form.billing_period, localToday())}
            </div>
          </div>
          <ContractItemsEditor form={form} set={set} itemMaster={itemMaster} reloadMaster={reloadMaster} withQty
            hint="매 회차 무엇을 청구하는지 품목으로 적으면 합계가 주기당 금액이 됩니다. 안 적으면 금액만 넣으면 돼요."/>

          <div>
            <label className="label" style={{ marginBottom: 8 }}>
              {periodLabel(form.billing_period)} 청구금액 (공급가액) <span style={{ color: 'var(--neg-ink)' }}>*</span>
            </label>
            {byItems ? (
              <div className="input num fw-700" style={{ fontSize: 20, background: 'var(--surface-2)', color: 'var(--muted)' }}>
                {unitAmt.toLocaleString()} 원 <span className="text-xs fw-600" style={{ color: 'var(--muted-2)' }}>· 품목 합계</span>
              </div>
            ) : (
              <div style={{ position: 'relative' }}>
                <MoneyInput className="input num fw-700" style={{ fontSize: 20, paddingRight: 36 }}
                  value={form.unit_amount}
                  onChange={raw => set(f => ({ ...f, unit_amount: raw }))}/>
                <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>원</span>
              </div>
            )}
            <div className="text-xs text-muted" style={{ marginTop: 6 }}>
              {openEnded
                ? '무기한 주문이라 주문 총액은 없어요. 이 금액이 매 회차 청구됩니다.'
                : preview
                  ? <>주문 총액 <b className="num text-ink">{(preview.total + asNum(form.initial_amount)).toLocaleString()}원</b>
                      {asNum(form.initial_amount) > 0 && <> = 초기 {asNum(form.initial_amount).toLocaleString()}원 + </>}
                      {asNum(form.initial_amount) > 0 ? '' : ' = '}
                      {periodLabel(form.billing_period)} {unitAmt.toLocaleString()}원 × {preview.cycles}회 <span className="text-muted2">(자동 계산)</span></>
                  : '주문 기간을 넣으면 주문 총액을 자동으로 계산해요.'}
            </div>
          </div>
          {/* 초기 구축비 + 월 정액처럼 두 갈래로 청구되는 주문 — 주문은 하나로 두고 청구만 나눈다 */}
          <div>
            <label className="label" style={{ marginBottom: 8 }}>
              초기 일시금 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택 (구축비·설치비)</span>
            </label>
            <div style={{ position: 'relative' }}>
              <MoneyInput className="input num" style={{ paddingRight: 36 }}
                value={form.initial_amount}
                onChange={raw => set(f => ({ ...f, initial_amount: raw }))}/>
              <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>원</span>
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
              주문 초기에 한 번만 받는 돈이 있으면 넣으세요. <b>청구 일정</b>에 1회성 항목으로 깔려서 대금청구에서 발행할 수 있고,
              매달 나가는 {periodLabel(form.billing_period)} 청구는 정기청구가 따로 돕니다. 갱신 후 기간에는 붙지 않아요.
            </div>
          </div>
        </>
      ) : (
        <>
          <ContractItemsEditor form={form} set={set} itemMaster={itemMaster} reloadMaster={reloadMaster} withQty
            hint="납품물·구축 항목을 품목으로 적으면 합계가 주문금액이 됩니다. 안 적으면 금액만 넣으면 돼요."/>

          <div>
            <label className="label" style={{ marginBottom: 8 }}>주문금액 (공급가액) <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            {byItems ? (
              <div className="input num fw-700" style={{ fontSize: 20, background: 'var(--surface-2)', color: 'var(--muted)' }}>
                {totalAmt.toLocaleString()} 원 <span className="text-xs fw-600" style={{ color: 'var(--muted-2)' }}>· 품목 합계</span>
              </div>
            ) : (
              <div style={{ position: 'relative' }}>
                <MoneyInput className="input num fw-700" style={{ fontSize: 20, paddingRight: 36 }}
                  value={form.amount}
                  onChange={raw => set(f => ({ ...f, amount: raw }))}/>
                <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>원</span>
              </div>
            )}
            {totalAmt > 0 && (
              <div className="text-xs text-muted" style={{ marginTop: 6 }}>
                {form.vat_mode === 'exempt' || form.vat_mode === 'zero'
                  ? <>{form.vat_mode === 'zero' ? '영세율' : '면세'} 주문 — 부가세 없이 <span className="num fw-600" style={{ color: 'var(--ink)' }}>{totalAmt.toLocaleString()}원</span> 청구</>
                  : <>부가세 포함 총액: <span className="num fw-600" style={{ color: 'var(--ink)' }}>{Math.round(totalAmt * 1.1).toLocaleString()}원</span></>}
              </div>
            )}
          </div>
        </>
      )}

      {/* 기간 — 무기한이면 종료일이 없다 */}
      <div className="row gap-12">
        <div style={{ flex: 1 }}>
          <label className="label" style={{ marginBottom: 8 }}>주문 시작일</label>
          <DateInput className="input" value={form.start_date || ''}
            onChange={e => set(f => ({ ...f, start_date: e.target.value }))}/>
        </div>
        <div style={{ flex: 1 }}>
          <label className="label" style={{ marginBottom: 8 }}>주문 종료일</label>
          {openEnded
            ? <div className="input" style={{ display: 'flex', alignItems: 'center', color: 'var(--muted-2)' }}>해지할 때까지</div>
            : <DateInput className="input" value={form.end_date || ''}
                onChange={e => set(f => ({ ...f, end_date: e.target.value }))}/>}
        </div>
      </div>

      {/* 갱신 조건 — 갱신 개념이 있는 주문(자동갱신 또는 정기형)만. 총액형+만료·무기한은 숨김 */}
      {hasRenewal && (
        <>
          <div className="row gap-12">
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>갱신 시 연장 기간</label>
              <div style={{ position: 'relative' }}>
                <input className="input num" style={{ paddingRight: 44 }} value={form.term_months ?? ''}
                  onChange={e => set(f => ({ ...f, term_months: numOnly(e.target.value) }))} placeholder="12"/>
                <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>개월</span>
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>갱신 통보 기한</label>
              <div style={{ position: 'relative' }}>
                <input className="input num" style={{ paddingRight: 60 }} value={form.notice_days ?? ''}
                  onChange={e => set(f => ({ ...f, notice_days: numOnly(e.target.value) }))} placeholder="60"/>
                <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>일 전</span>
              </div>
            </div>
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: -6 }}>
            종료일 {form.notice_days || 60}일 전부터 목록·알림에 뜹니다
            {form.term_mode === 'auto_renew'
              ? ' — 자동갱신이라도 해지하려면 이 기한 안에 통보해야 하니까요.'
              : ' — 계약서상 재계약 통보 기한에 맞추세요.'}
          </div>
        </>
      )}
    </>
  );
};

/* 목록·상세 공용 갱신 표시.
   아직 여유 있는 주문(stage 'ok')까지 배지로 칠하면 목록이 배지밭이 된다 → 흐린 글씨로만.
   배지는 실제로 챙겨야 할 때(통보기한 임박·만료)만 켠다. */
const RenewalBadge = ({ contract }) => {
  const r = renewalInfo(contract);
  if (!r.managed || !r.badge) return null;
  if (r.stage === 'ok') return <span className="text-xs text-muted2">갱신 {r.badge}</span>;
  return <span className={`badge ${r.tone}`}><span className="dot"/>{r.badge}</span>;
};

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
  const stepLabels = ["거래처", "주문", "수금 유형", "금액", "입금일/계좌", "증빙"];

  useEffect(() => { if (open) setStep(1); }, [open]);

  return (
    <Drawer open={open} onClose={onClose} label="입금 등록">
        <DrawerHead title="입금 등록" sub="회사에 들어온 돈을 빠르게 기록하세요." onClose={onClose}/>

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
            <FormBlock title="어떤 주문의 돈인가요?" hint="해당하는 주문을 선택해주세요.">
              <div className="col gap-8">
                {["MES 유지보수", "도면관리 구축", "QMS 라이선스", "ERP 커스터마이징", "(주문 없음)"].map(v => (
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
              <MoneyInput className="input num fw-700" style={{ fontSize: 22 }} value={form.amount}
                onChange={(raw, v) => setForm({...form, amount: v})}/>
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
                  <span className="text-muted">주문</span><span className="fw-600">{form.contract}</span>
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

/* ============ 주문 목록 데이터 ============ */
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
      { date: row.period?.split(" ~ ")[0] || "2026-02-01", who: row.pm, what: "주문 등록" },
    ],
  };
}

export function getContractDetail(id) {
  const row = CONTRACT_LIST.find(c => c.id === id) || CONTRACT_LIST[0];
  return synthesizeDetail(row);
}

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
const MS_TYPES = ["정기", "일시", "계약금(선급금)", "중도금", "기성", "잔금"]
const MS_STATUSES = ["예정", "입금 예정", "일부 입금", "입금 완료", "지급 예정", "지급 완료", "기한 지남"]

function MilestoneEditDrawer({ open, onClose, contractId, contractAmount, initial, onSaved }) {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const total = asNum(contractAmount)
  useEffect(() => {
    if (open) setRows((initial || []).map(m => ({
      type: m.type || '정기', ratio: m.ratio ?? '', amount: m.amount ?? '',
      due_date: m.due_date || '', status: m.status || '예정', invoice_id: m.invoice_id || null,
    })))
  }, [open, initial])

  const addRow = () => setRows(r => [...r, { type: '정기', ratio: '', amount: '', due_date: '', status: '예정', invoice_id: null }])
  const upd = (i, k, v) => setRows(r => r.map((row, idx) => {
    if (idx !== i) return row
    const next = { ...row, [k]: v }
    // 비율(%) 입력 시 주문 총액 기준으로 금액 자동 계산(수동 수정 가능). 총액이 있을 때만.
    if (k === 'ratio' && total > 0) {
      const pct = parseInt(String(v).replace(/[^0-9]/g, ''), 10) || 0
      next.amount = pct > 0 ? String(Math.round(total * pct / 100)) : ''
    }
    return next
  }))
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
    if (!res.ok) return toast.push('저장 실패', { tone: 'warn' })
    toast.push('청구 일정이 저장됐어요')
    onSaved(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} width="min(620px,100vw)" label="청구 일정 편집">
      <DrawerHead title="청구 일정 편집" onClose={onClose}/>
      <div className="drawer-body col gap-form">
        {total > 0 && (
          <div className="text-xs text-muted2" style={{ padding: '2px 0' }}>
            주문 총액 <b className="text-ink">{fmtNum(total)}원</b> · 비율(%)을 넣으면 금액이 자동 계산돼요(직접 수정 가능).
          </div>
        )}
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
              <MoneyInput className="input num" style={{ flex: 2 }} placeholder="금액" value={m.amount} onChange={raw => upd(i, 'amount', raw)}/>
              <DateInput className="input" style={{ flex: 2 }} value={m.due_date} onChange={e => upd(i, 'due_date', e.target.value)}/>
            </div>
          </div>
          )
        })}
        <button className="btn" onClick={addRow}><Icon.Plus size={13}/> 청구 일정 추가</button>
      </div>
      <DrawerFooter onCancel={onClose} onSave={save}/>
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
    if (!res.ok) return toast.push('저장 실패', { tone: 'warn' })
    toast.push('예산이 저장됐어요')
    onSaved(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} width="min(440px,100vw)" label="원가 예산 수정">
      <DrawerHead title="원가 예산 수정" onClose={onClose}/>
      <div className="drawer-body col gap-form">
        {FIELDS.map(([k, label]) => (
          <div key={k}>
            <label className="label" style={{ marginBottom: 8 }}>{label}</label>
            <MoneyInput className="input num" value={b[k]} onChange={raw => setB(p => ({ ...p, [k]: raw }))}/>
          </div>
        ))}
        <div className="text-xs text-muted2">실적은 거래내역(지급 완료)에서 자동 집계돼요.</div>
      </div>
      <DrawerFooter onCancel={onClose} onSave={save}/>
    </Drawer>
  )
}

/* 갱신 처리 Drawer — 종료일 연장(+금액 변경) 또는 미갱신 종료 */
function RenewDrawer({ open, onClose, contract, onSaved }) {
  const toast = useToast()
  const [form, setForm] = useState({ renew: true, new_end_date: '', new_amount: '', new_unit_amount: '', memo: '' })

  useEffect(() => {
    if (open && contract) setForm({
      renew: true,
      new_end_date: nextEndDate(contract),
      new_amount: String(contract.amount || ''),
      new_unit_amount: String(contract.unit_amount || ''),
      memo: '',
    })
  }, [open, contract])

  if (!contract) return null
  const recurring = isRecurring(contract)
  const isRenew = form.renew
  // 정기형은 '주기당 금액'이 바뀌는 게 본질 — 총액은 서버가 새 기간으로 다시 계산한다
  const unitNum = asNum(form.new_unit_amount)
  const amountNum = asNum(form.new_amount)
  const prevUnit = Number(contract.unit_amount) || 0
  const prevAmount = Number(contract.amount) || 0
  const diff = recurring ? unitNum - prevUnit : amountNum - prevAmount

  const save = async () => {
    if (isRenew && !form.new_end_date) return toast.push('새 종료일을 입력해주세요')
    const res = await api.renewContract(contract.id, {
      result: isRenew ? 'renew' : 'close',
      new_end_date:    isRenew ? form.new_end_date : null,
      new_amount:      isRenew && !recurring ? amountNum : null,
      new_unit_amount: isRenew && recurring  ? unitNum   : null,
      memo: form.memo || null,
    })
    if (!res.ok) return toast.push(res.error || '갱신 처리에 실패했어요', { tone: 'warn' })
    if (isRenew) {
      toast.push(res.recurringExtended > 0
        ? `${form.new_end_date}까지 갱신하고 정기청구도 함께 연장했어요`
        : `${form.new_end_date}까지 갱신됐어요`)
    } else {
      toast.push('미갱신으로 종료 처리했어요')
    }
    onSaved(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} width="min(460px,100vw)" label="주문 갱신 처리">
      <DrawerHead title="주문 갱신 처리" onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="text-sm text-muted">
          현재 종료일 <b className="text-ink num">{contract.end_date || '—'}</b>
          {' · '}{recurring
            ? <>{periodLabel(contract.billing_period)} 청구금액 <b className="num">{fmtNum(prevUnit)}원</b></>
            : <>주문금액 <b className="num">{fmtNum(prevAmount)}원</b></>}
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>처리 결과</label>
          <div className="row gap-6">
            <button type="button" className={`chip ${isRenew ? 'active' : ''}`} onClick={() => setForm(f => ({ ...f, renew: true }))}>갱신</button>
            <button type="button" className={`chip ${!isRenew ? 'active' : ''}`} onClick={() => setForm(f => ({ ...f, renew: false }))}>미갱신</button>
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
            {isRenew
              ? '계약기간을 다음 기간으로 넘기고 이력을 남깁니다. 주문은 진행중으로 유지돼요.'
              : '주문을 완료로 닫고 미갱신 이력을 남깁니다.'}
          </div>
        </div>
        {isRenew && (
          <>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>새 종료일 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
              <DateInput className="input" value={form.new_end_date}
                onChange={e => setForm(f => ({ ...f, new_end_date: e.target.value }))}/>
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                {contract.term_months || 12}개월 연장 기준으로 미리 채웠어요. 실제 계약서에 맞게 고치세요.
              </div>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>
                갱신 후 {recurring ? `${periodLabel(contract.billing_period)} 청구금액` : '주문금액'} (공급가액)
              </label>
              <div style={{ position: 'relative' }}>
                <MoneyInput className="input num fw-700" style={{ fontSize: 18, paddingRight: 36 }}
                  value={recurring ? form.new_unit_amount : form.new_amount}
                  onChange={raw => setForm(f => recurring
                    ? ({ ...f, new_unit_amount: raw })
                    : ({ ...f, new_amount: raw }))}/>
                <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>원</span>
              </div>
              {diff !== 0 && (
                <div className="text-xs" style={{ marginTop: 6, color: diff > 0 ? 'var(--pos)' : 'var(--neg-ink)' }}>
                  기존 대비 {diff > 0 ? '+' : ''}{fmtNum(diff)}원
                </div>
              )}
              {recurring && (
                <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                  새 기간의 주문 총액은 이 금액 × 회차수로 자동 계산돼요.
                  {contract.recurring_active > 0 && ' 연결된 정기청구 금액·종료일도 같이 맞춰집니다.'}
                </div>
              )}
            </div>
          </>
        )}
        <div>
          <label className="label" style={{ marginBottom: 8 }}>메모 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
          <input className="input" value={form.memo} onChange={e => setForm(f => ({ ...f, memo: e.target.value }))}
            placeholder={isRenew ? '예: 단가 5% 인상 합의' : '예: 내부 개발로 전환'}/>
        </div>
        {contract.recurring_active > 0 && !isRenew && (
          <div className="alert-row" style={{ background: 'var(--warn-soft)', borderColor: 'transparent' }}>
            <Icon.Warn/>
            <div className="text-sm">이 주문에 걸린 <b>정기청구 {contract.recurring_active}건</b>이 아직 활성입니다. 미갱신 종료 후 기준정보 → 정기청구에서 중지하세요.</div>
          </div>
        )}
      </div>
      <DrawerFooter onCancel={onClose} onSave={save} saveLabel={isRenew ? '갱신 처리' : '미갱신 종료'}/>
    </Drawer>
  )
}

/* ============ 주문 상세 ============ */
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
  const [renewOpen, setRenewOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  /* 거래 연결 — 이미 등록된 입금·지출을 이 주문에 붙인다.
     { kind, axis } 로 연다. axis 는 탭이 정한다(근거 주문 / 원가 귀속). */
  const [linkOpen, setLinkOpen] = useState(null);
  const [txnOpen, setTxnOpen] = useState(null);   // 주문 화면에서 연 거래 상세

  const reload = () => api.getContract(contractId).then(data => { if (data) setC(data); });

  useEffect(() => {
    if (!contractId) return;
    reload();
    api.getVendors().then(setVendors);
    // 주문이 바뀌면 탭을 기본으로 리셋 — 이전 주문의 탭 키가 남으면(예: 총액형에서 '원가 예산' 보다가
    // 기성형 주문으로 이동) 그 주문에 없는 탭이라 본문이 비거나 엉뚱하게 뜬다. '청구 일정'은 두 유형 모두 안전.
    setTab("청구 일정");
  }, [contractId]);

  // 주문이 바뀌면 저장된 메모를 텍스트영역에 로드(입금/지출 refresh 때 덮어쓰지 않게 c.id 기준).
  useEffect(() => { setMemo(c?.memo || ""); }, [c?.id]);

  const saveMemo = async () => {
    const res = await api.updateContractMemo(contractId, memo);
    if (res.ok) { toast.push("메모를 저장했어요"); reload(); } else toast.push("저장에 실패했어요", { tone: 'warn' });
  };

  // 주문 상세에서 입금/지출 등록 시 자동 갱신
  useEffect(() => { if (refreshTrigger > 0 && contractId) reload(); }, [refreshTrigger]);

  // 청구 일정 → 발행 청구서(미수금) 발행
  const issueInvoiceForMilestone = async (ms) => {
    if (!c) return;
    const supply = ms.amount || 0;
    // 면세 주문이면 부가세 0 — 확인창 금액이 서버 계산과 어긋나지 않게(면세인데 VAT 포함으로 오표시 방지).
    const exempt = c.vat_mode === 'exempt' || c.vat_mode === 'zero';   // 면세·영세 모두 세액 0
    const vat = exempt ? 0 : Math.round(supply * 0.1);
    const ok = await confirm({
      tone: "brand", icon: <Icon.Receipt size={22}/>,
      title: `${ms.type} 청구서 발행`,
      body: `${c.vendor_name || c.vendor || "거래처"} · ${ms.type} ${fmtNum(supply + vat)}원${exempt ? "(면세)" : "(VAT 포함)"} 청구서를 발행해요. 대금 청구에 등록됩니다.`,
      confirmLabel: "청구서 발행",
    });
    if (!ok) return;
    // 원자적 발행(청구서+일정 상태·연결). 거래처 gubu로 매출/매입 자동 판별.
    const res = await api.issueSchedule(ms.id, { paid: false });
    if (!res.ok) { toast.push(res.error || "청구서 발행에 실패했어요", { tone: 'warn' }); return; }
    toast.push(`${ms.type} 청구서를 발행했어요`);
    reload();
  };

  const handleDelete = async () => {
    if (!c) return;
    const ok = await confirm({
      tone: 'warn', icon: <Icon.Warn size={22}/>, title: `${c.name} 삭제`,
      body: '이 주문과 그 설정(청구 일정·품목표·갱신 이력·첨부)을 지웁니다. 청구서·거래·정기반복이 연결돼 있으면 지울 수 없어요.',
      confirmLabel: '삭제',
    });
    if (!ok) return;
    const res = await api.deleteContract(contractId);
    if (!res.ok) return toast.push(res.error || '삭제에 실패했어요', { tone: 'warn' });
    toast.push('주문을 삭제했어요');
    goList();
  };

  const openEdit = () => {
    if (!c) return;
    setEditForm({
      vendor:      c.vendor_name || '',
      contract_no: c.contract_no || '',
      order_no:    c.order_no    || '',
      project_no:  c.project_no  || '',
      name:        c.name || '',
      status:      c.status     || '진행중',
      file_url:    c.file_url   || '',
      file_name:   c.file_name  || '',
      docs:        [],   // 편집 폼에서 새로 올리는 첨부만. 기존 첨부는 상세 '증빙' 탭에서 관리.
      // 주문 품목표(있으면). 편집 시 그대로 불러와 수정 → 저장 시 통째 교체된다.
      items:       (c.contract_items || []).map(it => ({
        item_id: it.item_id || '', name: it.name || '', spec: it.spec || '', unit: it.unit || '',
        qty: it.qty ? String(it.qty) : '',
        // 저장된 중량·단가기준을 그대로 되불러온다 — 빠지면 다시 저장할 때 수량 기준으로 덮인다
        weight: Number(it.weight) ? String(Number(it.weight)) : '',
        price_basis: it.price_basis === 'weight' ? 'weight' : 'qty',
        unit_price: String(it.unit_price || ''), cost_price: String(it.cost_price || ''),
      })),
      cost_budget: c.cost_budget || null,
      billing_mode:   c.billing_mode || 'onetime',
      term_mode:      c.term_mode    || 'fixed',
      vat_mode:       c.vat_mode     || 'taxable',
      amount:         String(c.amount || ''),
      unit_amount:    String(c.unit_amount || ''),
      billing_period: c.billing_period || 'monthly',
      billing_day:    String(c.billing_day ?? 1),
      initial_amount: String(c.initial_amount || ''),
      start_date:     c.start_date || '',
      end_date:       c.end_date   || '',
      term_months:    String(c.term_months ?? 12),
      notice_days:    String(c.notice_days ?? 60),
    });
    setEditOpen(true);
  };

  const handleEditSave = async () => {
    const vendorObj = vendors.find(v => v.name === editForm.vendor);
    const payload = contractPayload(editForm, vendorObj?.id || c.vendor_id);

    /* 주문을 '완료'로 닫을 때, 종료일이 없는 정기 규칙이 걸려 있으면 먼저 물어본다.
       무기한 주문은 종료일이 없어 닫은 뒤에도 회차가 영원히 발행 후보로 뜬다.
       동의 없이는 아무것도 바꾸지 않는다(서버도 close_recurring 을 받아야만 처리한다). */
    /* 정기형에서 다른 청구방식으로 바꿀 때 — 걸려 있는 정기청구/정기지출을 멈출지 묻는다.
       안 물으면 주문은 단건인데 매달 청구가 계속 나간다(과청구). 반대로 말없이 멈추면
       청구가 왜 끊겼는지 알 수 없다. 그래서 무엇이 멈추는지 보여주고 고르게 한다. */
    const wasRecurring = c.billing_mode === 'recurring'
    const nowRecurring = editForm.billing_mode === 'recurring'
    if (wasRecurring && !nowRecurring) {
      const live = (c.recurrings || []).filter(r => r.active)
      if (live.length > 0) {
        const ok = await confirm({
          title: '걸려 있는 정기 청구도 멈출까요?',
          body: (
            <>
              <div style={{ marginBottom: 8 }}>
                청구방식을 <b>{editForm.billing_mode === 'progress' ? '기성형' : '단건'}</b>으로 바꾸는데,
                이 주문에 정기 {isPurchase ? '지출' : '청구'} {live.length}건이 아직 돌고 있어요.
                그대로 두면 매 주기마다 계속 {isPurchase ? '지출이' : '청구가'} 잡힙니다.
              </div>
              <div>
                오늘({localToday()})로 종료일을 맞춥니다. 그 전에 아직 발행 안 한 회차는
                ‘놓친 회차’로 남아 그대로 처리할 수 있어요.
              </div>
            </>
          ),
          confirmLabel: '멈추기',
          cancelLabel: '그대로 두기',
        });
        if (ok) payload.stop_recurring = true;
      }
    }

    if (editForm.status === '완료' && c.status !== '완료') {
      const open = await api.getOpenEndedRecurring(contractId);
      const list = [...(open.invoices || []), ...(open.expenses || [])];
      if (list.length > 0) {
        const ok = await confirm({
          title: '이 주문의 정기 청구·지출도 종료할까요?',
          body: (
            <>
              <div style={{ marginBottom: 8 }}>
                종료일이 없어서, 주문을 닫아도 회차가 계속 발행 후보로 올라옵니다.
              </div>
              <ul style={{ margin: '0 0 8px 16px', padding: 0 }}>
                {(open.invoices || []).map(r => <li key={r.id}>정기청구 · {r.label || '(이름 없음)'}</li>)}
                {(open.expenses || []).map(r => <li key={r.id}>정기지출 · {r.label || '(이름 없음)'}</li>)}
              </ul>
              <div>
                종료일을 <b>{open.suggestedEndDate}</b>로 맞춥니다.
                그 전에 아직 발행 안 한 회차는 ‘놓친 회차’로 남아 그대로 청구할 수 있어요.
                나중에 정기청구·정기지출 화면에서 종료일을 지우면 되돌릴 수 있습니다.
              </div>
            </>
          ),
          confirmLabel: '종료일 맞추기',
          cancelLabel: '그대로 두기',
        });
        if (ok) payload.close_recurring = true;
      }
    }

    const res = await api.updateContract(contractId, payload);
    if (res.ok) {
      const rc = res.recurringClosed;
      if (rc && (rc.invoices || rc.expenses)) {
        toast.push(`정기 ${rc.invoices + rc.expenses}건의 종료일을 ${rc.end_date}로 맞췄어요`);
      }
      const rs = res.recurringStopped;
      if (rs && (rs.invoices || rs.expenses)) {
        toast.push(`정기 ${rs.invoices + rs.expenses}건을 오늘로 멈췄어요`);
      }
      // 편집 폼에서 새로 올린 계약서 파일들을 주문 첨부(contract_docs)로 연결
      for (const d of (editForm.docs || [])) await api.addContractDoc(contractId, { url: d.url, name: d.name, doc_type: '계약서', size: d.size || 0 });
      toast.push("수정됐어요"); setEditOpen(false); reload();
    }
    else toast.push(res.error || "저장 실패", { tone: 'warn' });
  };

  if (!c) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted-2)" }}>불러오는 중...</div>;

  const inDone  = c.in_done  || 0;
  const out     = c.out      || 0;   // 이 주문이 근거인 지출(매입주문의 지급액)
  const cost    = c.cost     || 0;   // 이 매출주문에 귀속된 원가 — 손익(profit)이 빼는 값
  const profit  = c.profit   || 0;
  // 매입 주문(gubu A/E)이면 '지급' 관점, 매출이면 '수금' 관점
  const isPurchase = c.vendor_gubu === 'A' || c.vendor_gubu === 'E';
  const doneLabel   = isPurchase ? '지급' : '입금';
  const remainLabel = isPurchase ? '남은 미지급' : '남은 미수금';
  // 지표는 서버(metrics)가 계산한 값을 그대로 쓴다 — 화면마다 다시 계산하면 어긋난다.
  // 무기한 정기주문은 '총액'이 없으므로 term_total/remain이 null → 진행률 대신 누적으로 본다.
  const openEnded  = !hasTotal(c);
  const recurring  = isRecurring(c);
  const progress   = isProgress(c);
  const termTotal  = c.term_total ?? 0;          // 이번 텀 총액(VAT 포함)
  const done       = c.term_collected ?? 0;      // 이번 텀에 받은(지급한) 돈
  const doneAll    = c.collected ?? (isPurchase ? out : inDone);
  const remainAmt  = c.remain ?? 0;              // 남은 주문분
  const arRemain   = c.ar_remain ?? 0;           // 미수금(청구했는데 안 들어온 돈)
  const donePct    = termTotal > 0 ? Math.min(100, Math.round((done / termTotal) * 100)) : 0;
  const vendor  = c.vendor_name || c.vendor || '—';
  /* 기간 표시는 openEnded(=총액 개념 없음)가 아니라 **실제 종료일 유무**로 정한다.
     기성형은 총액이 없어 openEnded 로 잡히는데, 종료일이 있는 단가주문을
     '해지할 때까지'로 보여주면 갱신 시점을 놓친다(목록도 같은 원인으로 틀렸다). */
  const period  = (isOpenEnded(c) || !c.end_date)
    ? `${c.start_date || '—'} ~ 해지할 때까지`
    : [c.start_date, c.end_date].filter(Boolean).join(' ~ ') || '—';
  const rn = renewalInfo(c);

  return (
    <div className="fade-up">
      <div className="row gap-12" style={{ alignItems: "center", color: "var(--muted)", fontSize: 12.5, paddingTop: 30, marginBottom: 8 }}>
        <button className="btn ghost sm" onClick={goList} style={{ padding: "4px 8px" }}><Icon.Left size={14}/> 주문 목록</button>
        <span style={{ color: "var(--subtle)" }}>/</span>
        <span style={{ color: "var(--ink)", fontWeight: 600 }}>{c.name}</span>
      </div>
      <div className="row" style={{ alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <div className="row gap-10">
            <div className="page-title">{c.name}</div>
            <StatusBadge status={c.status}/>
            <RenewalBadge contract={c}/>
          </div>
          <div className="page-sub">
            {vendor} · {billingLabel(c)}/{termLabel(c)} · {amountLabel(c, fmtNum)} · 계약기간 {period}
            {c.contract_no ? ` · 주문번호 ${c.contract_no}` : ''}
          </div>
        </div>
        <div className="ml-auto row gap-8">
          {(c.file_url || c.attachments?.[0]?.url)
            ? <a className="btn" href={c.file_url || c.attachments[0].url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><Icon.File size={14}/> 계약서 보기</a>
            : null}
          <button className="btn" onClick={openEdit}><Icon.Pencil size={14}/> 편집</button>
          <button className="btn" style={{ color: 'var(--neg)' }} onClick={handleDelete}><Icon.Trash size={14}/> 삭제</button>
          {/* 기성형 = 품목 단가×수량으로 그때그때 청구. 매출이면 발행(받을 돈), 매입이면 매입 기성(나갈 돈). */}
          {progress && (
            <button className="btn primary" onClick={() => setProgressOpen(true)}><Icon.Plus/> 기성 청구</button>
          )}
          {/* 매출 주문 = 수금 + 그 일에 들어간 원가(외주비 등) → 둘 다 등록.
              매입 주문 = 나가는 돈만 → 입금은 붙을 자리가 없다. */}
          {isPurchase ? (
            <button className="btn primary" onClick={() => openExpense(c.id, c.vendor_id)}><Icon.Plus/> 지급 등록</button>
          ) : (
            <>
              {/* 원가는 이 주문의 **발주처**가 아니라 외주업체에게 나간다 — 거래처를 미리 채우지
                  않는다. 채우면 고객사가 매입처 자리에 앉고, 그 폼의 거래처 목록(매입처)에는
                  없는 값이라 화면엔 비어 보이면서 저장은 그 값으로 된다. */}
              <button className="btn" onClick={() => openExpense(c.id, null, { asCost: true })}><Icon.Plus/> 원가 등록</button>
              <button className="btn primary" onClick={() => openIncome(c.id, c.vendor_id)}><Icon.Plus/> 입금 등록</button>
            </>
          )}
        </div>
      </div>

      {/* 지표는 주문 성격에 따라 다르게 읽어야 한다.
          매출 주문 = 받을 돈 + 그 일에 들어간 원가 + 손익.
          매입 주문 = 나갈 돈만. 원가·손익 개념이 없다(붙이면 "나간 돈 = 손해"라는 거짓 숫자가 된다).
          무기한 정기주문 = 채울 총액이 없으므로 진행률 대신 누적·미수 중심. */}
      {progress ? (
        // 기성형은 총액·월 정액·진행률 개념이 없다 → 실제로 의미 있는 세 숫자만: 누적 기성 청구 / 누적 수금(지급) / 미수(미지급).
        <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <SummaryTile label={isPurchase ? "누적 기성(청구)" : "누적 청구(기성)"} amount={c.billed || 0}/>
          <SummaryTile label={`누적 ${doneLabel}`} amount={doneAll}/>
          <SummaryTile label={isPurchase ? "미지급금" : "미수금"} amount={arRemain} big/>
        </div>
      ) : (
      <div className="grid" style={{ gridTemplateColumns: `repeat(${isPurchase ? 4 : 5}, 1fr)`, gap: 12 }}>
        {/* 옆 타일(수금·미수금·원가)이 모두 부가세 포함 금액이라 여기도 기준을 맞춘다.
            공급가만 보여주면 '주문 840만 · 수금 924만'처럼 앞뒤가 안 맞아 보인다. */}
        <SummaryTile
          label={openEnded ? `${periodLabel(c.billing_period)} ${isPurchase ? '지급' : '청구'}금액` : recurring ? "이번 계약기간 총액" : "주문금액"}
          amount={openEnded ? (c.unit_amount || 0) : (c.term_total ?? c.amount)}/>
        <SummaryTile
          label={openEnded ? `누적 ${doneLabel}` : `${doneLabel} 완료`}
          amount={openEnded ? doneAll : done}
          pct={openEnded ? undefined : donePct}/>
        <SummaryTile
          label={openEnded ? (isPurchase ? "미지급금" : "미수금") : remainLabel}
          amount={openEnded ? arRemain : remainAmt}/>
        {isPurchase ? (
          // 매입: 청구받은 것 중 아직 안 나간 돈
          <SummaryTile label="미지급금" amount={arRemain} big/>
        ) : (
          <>
            {/* 손익이 빼는 값과 같은 축이어야 한다 — out 을 쓰면 원가 0 · 손익 +323,000 처럼
                타일끼리 뺄셈이 안 맞는다(목록 '원가' 열과 같은 원인). */}
            <SummaryTile label="이 주문 원가" amount={cost}/>
            <SummaryTile label={openEnded ? "누적 손익" : "예상 손익"} amount={profit ?? 0} big/>
          </>
        )}
      </div>
      )}
      <Spacer h={20}/>

      {/* 정기청구 연결 — 정기형 주문은 정기청구가 실제 청구를 돌리는 장치다.
          주문이 원본이고 정기청구가 실행 → 어긋나면(금액·주기·종료일) 여기서 잡는다. */}
      {recurring && (
        <>
          <div className="card card-pad">
            <div className="row gap-12" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                {/* 매출 주문이면 정기청구(받을 돈), 매입 주문이면 정기지출(나갈 돈).
                    이걸 안 나누면 매입 주문의 반복이 미수금으로 둔갑한다. */}
                <div className="section-title">{isPurchase ? '정기지출' : '정기청구'}</div>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  {(c.recurrings || []).length === 0
                    ? `이 주문은 ${periodLabel(c.billing_period)}마다 ${fmtNum(c.unit_amount || 0)}원이 ${isPurchase ? '나가는' : '청구되는'} 주문인데, 아직 ${isPurchase ? '정기지출' : '정기청구'}이 걸려 있지 않아요. 지금은 ${isPurchase ? '지출이' : '청구서가'} 자동 생성되지 않습니다.`
                    : `${periodLabel(c.billing_period)} ${fmtNum(c.unit_amount || 0)}원 · ${cycleMonthsHint(c.start_date, c.billing_day, c.billing_period, localToday())}${c.end_date ? ` · ${c.end_date}까지` : ' · 해지할 때까지'}`}
                </div>
                {/* 정기청구는 주문에서 관리한다(기준정보에 두면 워크플로우가 끊긴다).
                    주문이 원본, 정기청구는 실행 장치 → 어긋나면 '주문 조건으로 맞추기'로 되돌린다. */}
                {(c.recurrings || []).map(r => {
                  const gaps = recurringMismatch(c, r);
                  return (
                    <div key={r.id} style={{ marginTop: 8 }}>
                      <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className={`badge ${r.active ? 'pos' : 'outline'}`}><span className="dot"/>{r.active ? '활성' : '중지됨'}</span>
                        <span className="text-xs text-muted2">
                          {periodLabel(r.period)} {fmtNum(r.supply_amount)}원 · 매월 {r.day_of_month || 1}일 · {r.start_date} ~ {r.end_date || '무기한'}
                          {r.last_generated ? ` · 최근 발행 ${r.last_generated}` : ' · 아직 발행 이력 없음'}
                        </span>
                        <button className="btn ghost sm" onClick={async () => {
                          const res = await api.toggleContractRecurring(contractId, r.id);
                          if (!res.ok) return toast.push(res.error || '처리에 실패했어요', { tone: 'warn' });
                          const what = isPurchase ? '정기지출' : '정기청구';
                          toast.push(res.active ? `${what}을 재개했어요` : `${what}을 중지했어요. 다음 회차부터 생성되지 않아요`);
                          reload();
                        }}>{r.active ? '중지' : '재개'}</button>
                      </div>
                      {gaps.length > 0 && (
                        <div className="alert-row" style={{ marginTop: 8, background: 'var(--warn-soft)', borderColor: 'transparent' }}>
                          <Icon.Warn/>
                          <div className="text-sm" style={{ flex: 1 }}>
                            주문과 정기청구가 달라요 — {gaps.join(' / ')}
                          </div>
                          <button className="btn sm" onClick={async () => {
                            const res = await api.syncContractRecurring(contractId);
                            if (!res.ok) return toast.push(res.error || '맞추기에 실패했어요', { tone: 'warn' });
                            toast.push('주문 조건으로 맞췄어요');
                            reload();
                          }}>주문 조건으로 맞추기</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {(c.recurrings || []).length === 0 && (
                <div className="ml-auto">
                  <button className="btn primary" onClick={async () => {
                    const res = await api.addContractRecurring(contractId);
                    if (!res.ok) return toast.push(res.error || '생성에 실패했어요', { tone: 'warn' });
                    toast.push(isPurchase
                      ? '정기지출을 걸었어요. 회차가 되면 지출이 자동 생성됩니다'
                      : '정기청구를 걸었어요. 대금 청구서의 "발행 예정"에서 회차를 발행하세요');
                    reload();
                  }}><Icon.Plus/> {isPurchase ? '정기지출 걸기' : '정기청구 걸기'}</button>
                </div>
              )}
            </div>
          </div>
          <Spacer h={20}/>
        </>
      )}

      {/* 기성형 주문 — 품목 단가표 + 품목별 누적 기성. 청구는 '기성 청구' 버튼으로 그때그때 발행. */}
      {progress && (
        <>
          <div className="card card-pad">
            <div className="row gap-12" style={{ alignItems: 'center' }}>
              <div className="section-title">품목 단가표</div>
              <button className="btn primary sm ml-auto" onClick={() => setProgressOpen(true)}>
                <Icon.Plus/> 기성 청구
              </button>
            </div>
            {(c.contract_items || []).length === 0 ? (
              <div className="text-sm text-muted" style={{ marginTop: 10 }}>
                등록된 품목이 없어요. <b>편집</b>에서 품목과 단가를 등록하면 기성 청구할 수 있어요.
              </div>
            ) : (
              <table className="table" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>품목</th><th>규격</th><th>단위</th>
                    <th style={{ textAlign: 'right' }}>단가</th>
                    <th style={{ textAlign: 'right' }}>누적 수량</th>
                    <th style={{ textAlign: 'right' }}>누적 기성액</th>
                  </tr>
                </thead>
                <tbody>
                  {(c.contract_items || []).map(it => {
                    // 품목별 누적은 청구서 line 합계에서 온다(item_id 우선, 없으면 이름으로 대조).
                    const prog = (c.item_progress || []).find(p =>
                      (it.item_id && p.item_id === it.item_id) || (!it.item_id && p.name === it.name));
                    return (
                      <tr key={it.id}>
                        <td className="fw-600">{it.name}</td>
                        <td className="text-muted">{it.spec || '—'}</td>
                        <td className="text-muted">{it.unit || '—'}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{fmtNum(it.unit_price)}원</td>
                        <td className="num" style={{ textAlign: 'right' }}>{prog ? fmtNum(prog.qty_sum) : '—'}</td>
                        <td className="num fw-600" style={{ textAlign: 'right' }}>{prog ? fmtNum(prog.amount_sum) + '원' : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <Spacer h={20}/>
        </>
      )}

      {/* 총액형·정기형도 품목으로 구성할 수 있다(선택). 적어 뒀으면 무엇을 얼마에 주고받는지 여기서 본다.
          기성형과 달리 수량이 주문에 있으므로 라인 금액·원가·마진이 그대로 확정된다. */}
      {!progress && (c.contract_items || []).length > 0 && (() => {
        const rows = c.contract_items || [];
        const sum  = rows.reduce((s, it) => s + (Number(it.qty) || 1) * Number(it.unit_price || 0), 0);
        const cost = rows.reduce((s, it) => s + (Number(it.qty) || 1) * Number(it.cost_price || 0), 0);
        return (
          <>
            <div className="card card-pad">
              <div className="section-title">주문 품목</div>
              <table className="table" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>품목</th><th>규격</th><th>단위</th>
                    <th style={{ textAlign: 'right' }}>수량</th>
                    <th style={{ textAlign: 'right' }}>출고가</th>
                    <th style={{ textAlign: 'right' }}>금액</th>
                    <th style={{ textAlign: 'right' }}>매입가</th>
                    <th style={{ textAlign: 'right' }}>마진</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(it => {
                    const qty = Number(it.qty) || 1;
                    const amt = qty * Number(it.unit_price || 0);
                    const cst = qty * Number(it.cost_price || 0);
                    return (
                      <tr key={it.id}>
                        <td className="fw-600">{it.name}</td>
                        <td className="text-muted">{it.spec || '—'}</td>
                        <td className="text-muted">{it.unit || '—'}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{fmtNum(qty)}</td>
                        <td className="num" style={{ textAlign: 'right' }}>{fmtNum(it.unit_price)}</td>
                        <td className="num fw-600" style={{ textAlign: 'right' }}>{fmtNum(amt)}</td>
                        <td className="num text-muted" style={{ textAlign: 'right' }}>{it.cost_price ? fmtNum(it.cost_price) : '—'}</td>
                        <td className="num" style={{ textAlign: 'right', color: amt - cst < 0 ? 'var(--neg-ink)' : undefined }}>
                          {it.cost_price ? fmtNum(amt - cst) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="text-xs text-muted" style={{ marginTop: 10 }}>
                합계 <b className="num text-ink">{fmtNum(sum)}원</b>
                {cost > 0 && <> · 원가 <span className="num">{fmtNum(cost)}원</span> · 마진 <b className="num">{fmtNum(sum - cost)}원</b> (기준정보 매입가 기준 스냅샷)</>}
              </div>
            </div>
            <Spacer h={20}/>
          </>
        );
      })()}

      {/* 갱신 관리 — 만료가 있는 주문만 (무기한은 갱신 개념이 없다) */}
      {!openEnded && (
        <>
          <div className="card card-pad" style={{
            borderColor: rn.stage === 'expired' ? 'var(--neg-ink)' : rn.stage === 'due' ? 'var(--warn-ink)' : undefined,
          }}>
            <div className="row gap-12" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <div className="row gap-8" style={{ alignItems: 'center' }}>
                  <div className="section-title">주문 갱신</div>
                  <RenewalBadge contract={c}/>
                </div>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  종료일 <b className="num text-ink">{c.end_date || '—'}</b>
                  {' · '}{termLabel(c)}
                  {' · '}갱신 시 {c.term_months || 12}개월 연장
                  {' · '}통보 기한 {c.notice_days ?? 60}일 전
                  {rn.stage === 'expired' && <span style={{ color: 'var(--neg-ink)' }}> · 종료일이 {-rn.days}일 지났습니다</span>}
                  {rn.stage === 'ok' && rn.days != null && <span> · 갱신 검토까지 {rn.days - (Number(c.notice_days ?? 60))}일 남음</span>}
                </div>
                {c.term_mode === 'auto_renew' && (
                  <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                    자동갱신 주문이에요. 통보기한까지 해지 통보가 없으면 실제로는 연장되니, 종료일이 지나기 전에 <b>갱신 처리</b>로 새 기간을 기록해두세요.
                  </div>
                )}
                {(c.renewals?.length > 0) && (
                  <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                    갱신 {c.renewals.filter(r => r.result === '갱신').length}회 · 최근 {c.renewals[0].renewed_at}
                    {c.current_term_start ? ` · 이번 계약기간 시작 ${c.current_term_start}` : ''}
                  </div>
                )}
              </div>
              <div className="ml-auto row gap-8">
                <button className={`btn ${rn.stage === 'ok' ? '' : 'primary'}`} onClick={() => setRenewOpen(true)}>
                  <Icon.Check size={14}/> 갱신 처리
                </button>
              </div>
            </div>
            {c.recurring_active > 0 && rn.stage === 'expired' && (
              <div className="alert-row" style={{ marginTop: 14, background: 'var(--warn-soft)', borderColor: 'transparent' }}>
                <Icon.Warn/>
                <div className="text-sm">주문이 만료됐는데 <b>정기청구 {c.recurring_active}건</b>이 아직 돌고 있어요. 갱신하거나 정기청구를 중지하세요.</div>
              </div>
            )}
          </div>
          <Spacer h={20}/>
        </>
      )}

      {/* 진행률은 '끝이 있는 주문'에만 의미가 있다. 무기한 주문엔 채워야 할 총액이 없다. */}
      {!openEnded && (
        <>
          <div className="card card-pad">
            <div className="row" style={{ marginBottom: 10 }}>
              <div className="section-title">{recurring ? '이번 계약기간 진행률' : '주문 진행률'}</div>
              <div className="ml-auto text-sm text-muted">
                {recurring ? '이번 기간 총액' : '주문금액'}의 {donePct}% {doneLabel}됨 · {remainLabel}{' '}
                <span className="num fw-700 text-ink" style={{ color: "var(--ink)" }}>{fmtNum(remainAmt)}원</span>
              </div>
            </div>
            <div style={{ display: "flex", height: 14, borderRadius: 999, overflow: "hidden", background: "var(--surface-3)" }}>
              <div style={{ width: `${donePct}%`, background: "var(--ink)" }}/>
              <div style={{ width: `${100-donePct}%`, background: "transparent", borderLeft: "1px dashed rgba(0,0,0,0.1)" }}/>
            </div>
            <div className="row" style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted-2)" }}>
              <div><span style={{ display: "inline-block", width: 8, height: 8, background: "var(--ink)", borderRadius: 2, marginRight: 6 }}/>{doneLabel} 완료 {fmtNum(done)}원</div>
              <div className="ml-auto"><span style={{ display: "inline-block", width: 8, height: 8, background: "var(--surface-3)", border: "1px solid var(--line-strong)", borderRadius: 2, marginRight: 6 }}/>잔여 {fmtNum(remainAmt)}원</div>
            </div>
            {recurring && c.renewals?.length > 0 && (
              <div className="text-xs text-muted2" style={{ marginTop: 10 }}>
                갱신된 주문이라 <b>이번 기간({c.current_term_start} ~ {c.end_date})</b>에 받은 돈만 셉니다. 누적 {doneLabel} {fmtNum(doneAll)}원.
              </div>
            )}
          </div>
          <Spacer h={20}/>
        </>
      )}

      {/* 탭도 관점에 따라 다르다. 매입 주문엔 '원가 예산'도 '입금 내역'도 없다.
          내부 키는 그대로 두고 라벨만 매입 관점으로 바꾼다(아래 분기들이 키를 쓰므로). */}
      <div className="card">
        <div className="tab-bar" style={{ padding: "0 12px" }}>
          {(progress
            // 기성형은 마일스톤(청구/지급 일정)이 없다 → 그 자리에 '기성 청구 내역'. 원가 예산도 제외.
            ? (isPurchase
                ? [["기성 청구 내역", "기성 청구 내역"], ["지출 내역", "지급 내역"], ["증빙", "증빙"], ["결의서", "결의서"], ["메모/히스토리", "메모/히스토리"]]
                : [["기성 청구 내역", "기성 청구 내역"], ["입금 내역", "입금 내역"], ["지출 내역", "원가 지출"], ["증빙", "증빙"], ["결의서", "결의서"], ["메모/히스토리", "메모/히스토리"]])
            : isPurchase
            ? [["청구 일정", "지급 일정"], ["지출 내역", "지급 내역"], ["증빙", "증빙"], ["결의서", "결의서"], ["메모/히스토리", "메모/히스토리"]]
            : [["청구 일정", "청구 일정"], ["원가 예산", "원가 예산"], ["입금 내역", "입금 내역"], ["지출 내역", "원가 지출"], ["증빙", "증빙"], ["결의서", "결의서"], ["메모/히스토리", "메모/히스토리"]]
          ).map(([key, label]) => {
            // 기성형 기본 탭: 초기 tab 상태가 "청구 일정"이라 기성형에선 '기성 청구 내역'을 기본 활성으로 취급
            const active = tab === key || (progress && key === "기성 청구 내역" && tab === "청구 일정")
            return <button key={key} className={`tab ${active ? "active" : ""}`} onClick={() => setTab(key)}>{label}</button>
          })}
        </div>

        {/* 기성 청구 내역 — 기성형 주문이 발행한 기성 청구서 목록(마일스톤 탭 대체) */}
        {progress && (tab === "기성 청구 내역" || tab === "청구 일정") && (
          <div style={{ padding: 20 }}>
            <div className="row" style={{ marginBottom: 14 }}>
              <div className="text-sm text-muted">이 주문으로 발행한 기성 청구 목록이에요. 새 기성은 위 <b>기성 청구</b> 버튼으로 발행하세요.</div>
              <button className="btn primary ml-auto" onClick={() => setProgressOpen(true)}><Icon.Plus size={13}/> 기성 청구</button>
            </div>
            {(c.progress_invoices || []).length === 0 ? (
              <div className="text-sm text-muted" style={{ padding: "24px 0", textAlign: "center" }}>아직 발행한 기성 청구가 없어요.</div>
            ) : (
              <div className="card" style={{ overflow: "hidden" }}>
                <table className="table">
                  <thead><tr><th>청구번호</th><th>청구일</th><th className="num-right">금액</th><th className="num-right">품목</th><th>{isPurchase ? '지급 예정일' : '입금 예정일'}</th><th>상태</th></tr></thead>
                  <tbody>
                    {(c.progress_invoices || []).map(inv => (
                      <tr key={inv.id}>
                        <td className="fw-600">{inv.invoice_no}</td>
                        <td className="text-sm">{inv.issued_at}</td>
                        <td className="num-cell num-right fw-700">{fmtNum(inv.total_amount)}</td>
                        <td className="num-right text-muted">{inv.line_count}품목</td>
                        <td className="text-sm text-muted">{inv.due_at || '—'}</td>
                        <td><StatusBadge status={inv.status}/></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "청구 일정" && !progress && (() => {
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
                <div className="text-sm text-muted">이 주문에서 청구할 금액·시점을 미리 등록하세요. '청구서 발행'을 누르면 대금 청구로 넘어가요.</div>
                <button className="btn ml-auto" onClick={() => setMsOpen(true)}><Icon.Pencil size={13}/> 편집</button>
              </div>
              {milestones.length > 0 && Math.abs(diff) > 1 && (
                <div className="alert-row" style={{ marginBottom: 12, background: "var(--warn-soft)", borderColor: "transparent" }}>
                  <Icon.Warn/>
                  <div>
                    <div className="lead">청구 일정 합계가 주문금액(공급가)보다 {diff > 0 ? "많아요" : "적어요"}.</div>
                    <div className="body">일정 합계 {fmtNum(msSum)}원 · 주문금액 {fmtNum(c.amount)}원 (차이 {fmtNum(Math.abs(diff))}원)</div>
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
                <div className="text-sm text-muted">참고용 예상 원가예요. 인건비·자재비는 인사급여·발주에서 별도 관리돼요.</div>
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
                  { label: "예상 이익",   value: fmtNum(c.amount - totalActual), sub: `주문금액 ${fmtNum(c.amount)}원 기준` },
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
          <div style={{ padding: 20 }}>
            {/* 이미 처리된 입금을 이 주문에 붙인다 — 엑셀로 올린 거래를 주문과 맞출 때 쓴다.
                주문을 보고 있을 때가 대사하기 가장 자연스러운 자리다. */}
            <div className="row" style={{ marginBottom: 14 }}>
              <span className="text-xs text-muted2">행을 누르면 그 거래를 열어 고치거나 연결을 뗄 수 있어요.</span>
              <button className="btn sm ml-auto" onClick={() => setLinkOpen({ kind: 'income', axis: 'contract' })}>
                <Icon.Link size={13}/> 거래 연결
              </button>
            </div>
            <div className="card" style={{ overflow: "hidden" }}>
            <table className="table">
              {/* 거래처·적요가 없으면 "어느 거래인지" 알 수가 없다 — 잘못 붙은 걸 찾으려고
                  전체 거래내역을 헤매게 된 이유가 이것이었다. */}
              <thead><tr><th>입금일</th><th>거래처 · 적요</th><th>구분</th><th>계좌</th>
                <th className="num-right">금액</th><th>상태</th><th>증빙</th></tr></thead>
              <tbody>
                {(c.incomes || []).length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: "center", padding: 40, color: "var(--muted-2)", fontSize: 13 }}>
                    등록된 입금 내역이 없어요. <b>거래 연결</b>로 이미 등록된 입금을 붙일 수 있어요.
                  </td></tr>
                )}
                {(c.incomes || []).map((r, i) => (
                  <tr key={r.id || i} style={{ cursor: r.id ? 'pointer' : undefined }}
                    onClick={() => r.id && setTxnOpen(r.id)}>
                    <td className="num-cell text-muted">{r.date}</td>
                    <td>
                      <div className="fw-600">{r.vendor || '—'}</div>
                      {r.memo && <div className="text-xs text-muted2">{r.memo}</div>}
                    </td>
                    <td><span className="badge outline">{r.type}</span></td>
                    <td className="text-sm text-muted">{r.account || '—'}</td>
                    <td className="num-cell num-right fw-700">{fmtNum(r.amount)}</td>
                    <td><StatusBadge status={r.status}/></td>
                    <td>{r.evid ? <span className="badge pos"><Icon.Check size={11}/> 첨부</span> : <span className="badge neg"><Icon.Warn size={11}/> 누락</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {/* 매출 주문 → 이 주문에 귀속된 '원가'. 그 돈이 어느 매입주문으로 나갔는지도 함께 보여준다.
            매입 주문 → 이 주문이 근거인 '지급'. */}
        {tab === "지출 내역" && (
          <div style={{ padding: 20 }}>
            {/* ⚠ 축이 다르다. 매입 주문은 '이 주문이 근거인 지급'(contract_id),
                매출 주문은 '이 주문에 귀속된 원가'(cost_contract_id)다.
                외주비는 외주 매입주문에 지급되면서 동시에 프로젝트 매출주문의 원가라
                여기서 축을 틀리면 돈이 조용히 엉뚱한 바구니로 간다. */}
            <div className="row" style={{ marginBottom: 14 }}>
              <span className="text-xs text-muted2">
                {isPurchase ? '행을 누르면 그 지급 거래를 열 수 있어요.' : '행을 누르면 그 지출 거래를 열 수 있어요.'}
              </span>
              <button className="btn sm ml-auto"
                onClick={() => setLinkOpen({ kind: 'expense', axis: isPurchase ? 'contract' : 'cost' })}>
                <Icon.Link size={13}/> {isPurchase ? '지급 거래 연결' : '원가 거래 연결'}
              </button>
            </div>
            <div className="card" style={{ overflow: "hidden" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{isPurchase ? '지급일' : '지출일'}</th><th>거래처 · 적요</th><th>비목</th>
                  {!isPurchase && <th>지급 근거(발주)</th>}
                  <th className="num-right">금액</th><th>결의서</th><th>{isPurchase ? '지급' : '정산'}</th>
                </tr>
              </thead>
              <tbody>
                {(c.expenses || []).length === 0 && (
                  <tr><td colSpan={isPurchase ? 6 : 7} style={{ textAlign: "center", padding: 40, color: "var(--muted-2)", fontSize: 13 }}>
                    {isPurchase
                      ? '등록된 지급 내역이 없어요. '
                      : '이 주문에 귀속된 원가가 없어요. '}
                    <b>{isPurchase ? '지급 거래 연결' : '원가 거래 연결'}</b>로 이미 등록된 지출을 붙일 수 있어요.
                  </td></tr>
                )}
                {(c.expenses || []).map((r, i) => (
                  <tr key={r.id || i} style={{ cursor: r.id ? 'pointer' : undefined }}
                    onClick={() => r.id && setTxnOpen(r.id)}>
                    <td className="num-cell text-muted">{r.date}</td>
                    <td>
                      <div className="fw-600">{r.vendor}</div>
                      {r.memo && <div className="text-xs text-muted2">{r.memo}</div>}
                    </td>
                    <td><span className="badge outline">{r.category}</span></td>
                    {!isPurchase && (
                      <td className="text-sm text-muted">{r.paidContract || <span className="text-muted2">공통 (주문 없음)</span>}</td>
                    )}
                    <td className="num-cell num-right fw-700">{fmtNum(r.amount)}</td>
                    <td><StatusBadge status={r.doc}/></td>
                    <td><StatusBadge status={r.pay}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {tab === "증빙" && (
          <div style={{ padding: 22 }}>
            <FileAttach
              docs={c.attachments || []}
              onAdd={async (d) => {
                const res = await api.addContractDoc(c.id, { url: d.url, name: d.name, doc_type: '기타', size: d.size || 0 });
                if (res.ok) { toast.push("첨부됐어요"); reload(); } else toast.push("첨부에 실패했어요", { tone: 'warn' });
              }}
              onRemove={async (d) => {
                // 레거시 단일 파일(file_url, id 없음)은 clear-file로, 나머지는 contract_docs 삭제
                const res = d.id ? await api.deleteContractDoc(d.id) : await api.clearContractFile(c.id);
                if (res.ok) { toast.push("삭제됐어요"); reload(); } else toast.push("삭제에 실패했어요", { tone: 'warn' });
              }}
              label="계약서·증빙을 끌어다 놓거나 클릭해서 추가"/>
          </div>
        )}

        {tab === "결의서" && (
          <div style={{ padding: 20 }}>
          <div className="card" style={{ overflow: "hidden" }}>
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
          </div>
          </div>
        )}

        {tab === "메모/히스토리" && (
          <div style={{ padding: 22 }}>
            <div style={{ marginBottom: 24 }}>
              <label className="label">새 메모 추가</label>
              <textarea className="input" rows={3} value={memo} onChange={e => setMemo(e.target.value)}
                placeholder="주문에 관련된 메모를 자유롭게 적어주세요"
                style={{ resize: "vertical", fontFamily: "inherit" }}/>
              <div className="row" style={{ marginTop: 8 }}>
                <span className="text-xs text-muted2">이 주문에 대한 자유 메모를 저장해두세요.</span>
                <button className="btn primary sm ml-auto" onClick={saveMemo}>
                  <Icon.Pencil size={12}/> 메모 저장
                </button>
              </div>
            </div>
            {(c.renewals || []).length > 0 && (
              <>
                <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 12, letterSpacing: "0.02em" }}>갱신 이력</div>
                <div className="table-scroll" style={{ marginBottom: 20 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 60 }}>회차</th><th>처리일</th><th>결과</th>
                        <th>계약기간 변경</th><th className="num-right">주문금액 변경</th><th>메모</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.renewals.map(r => (
                        <tr key={r.id}>
                          <td className="num">{r.seq}차</td>
                          <td className="num text-sm">{r.renewed_at || '—'}</td>
                          <td><span className={`badge ${r.result === '갱신' ? 'pos' : 'outline'}`}><span className="dot"/>{r.result}</span></td>
                          <td className="num text-sm">
                            {r.result === '갱신' ? `${r.prev_end_date || '—'} → ${r.new_end_date}` : `${r.prev_end_date || '—'}에 종료`}
                          </td>
                          <td className="num-cell num-right text-sm">
                            {(() => {
                              // 정기형은 '주기당 금액'이 실제로 협상되는 값 — 총액이 아니라 그걸 보여준다
                              const [prev, next] = recurring
                                ? [r.prev_unit_amount, r.new_unit_amount]
                                : [r.prev_amount, r.new_amount];
                              if (r.result !== '갱신' || next == null || next === prev) {
                                return <span className="text-muted2">변동 없음</span>;
                              }
                              return <span>{fmtNum(prev || 0)} → <b>{fmtNum(next)}</b>{recurring ? ` / ${periodLabel(c.billing_period)}` : ''}</span>;
                            })()}
                          </td>
                          <td className="text-sm text-muted">{r.memo || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
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
      <Drawer open={editOpen} onClose={() => setEditOpen(false)}
        /* 품목표가 뜨면 넓힌다 — 청구서 드로어와 같은 규칙(Billing.jsx).
           품목표는 8~9열이라 480px 안에서는 첫 칸부터 가로 스크롤이 된다.
           품목이 없으면 예전 폭 그대로 — 나머지 칸은 좁아야 읽기 쉽다. */
        width={(editForm.items || []).length > 0 ? "min(1240px,100vw)" : "min(480px,100vw)"}
        label="주문 편집">
        <div className="drawer-body">
          <div className="col gap-form">
            <div>
              <label className="label" style={{ marginBottom: 8 }}>거래처</label>
              <Combobox value={editForm.vendor} onChange={v => setEditForm(f => ({ ...f, vendor: v }))}
                options={vendors.map(v => ({ value: v.name, label: v.name }))} placeholder="거래처 선택"/>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>주문명 *</label>
              <input className="input" value={editForm.name || ''} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}/>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>주문번호 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
              <input className="input" value={editForm.contract_no || ''} onChange={e => setEditForm(f => ({ ...f, contract_no: e.target.value }))} placeholder="예: CT-2026-001"/>
            </div>
            <ContractTermFields form={editForm} set={setEditForm}/>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>상태</label>
              <div className="row gap-6">
                {['진행중','보류','완료'].map(s => (
                  <button key={s} type="button" className={`chip ${editForm.status === s ? 'active' : ''}`} onClick={() => setEditForm(f => ({ ...f, status: s }))}>{s}</button>
                ))}
              </div>
            </div>
            <ContractRefFields form={editForm} set={setEditForm}/>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계약서 추가 첨부 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 여러 개 가능</span></label>
              {editForm.file_url && (
                <div className="row gap-10" style={{ padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-2)', marginBottom: 8 }}>
                  <Icon.File size={15} style={{ color: 'var(--brand)', flexShrink: 0 }}/>
                  <span className="text-sm fw-600" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{editForm.file_name || '기존 계약서'}</span>
                  <a className="btn ghost sm" href={editForm.file_url} target="_blank" rel="noreferrer"><Icon.Eye size={13}/></a>
                  <button type="button" className="icon-btn" onClick={() => setEditForm(f => ({ ...f, file_url: '', file_name: '' }))}><Icon.Close size={14}/></button>
                </div>
              )}
              <FileAttach
                docs={editForm.docs || []}
                onAdd={(d) => setEditForm(f => ({ ...f, docs: [...(f.docs || []), d] }))}
                onRemove={(d) => setEditForm(f => ({ ...f, docs: (f.docs || []).filter(x => x !== d) }))}
                label="계약서 파일을 끌어다 놓거나 클릭"/>
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>기존에 첨부한 파일은 주문 상세의 '증빙' 탭에서 확인·삭제할 수 있어요.</div>
            </div>
          </div>
        </div>
        <DrawerFooter onCancel={() => setEditOpen(false)} onSave={handleEditSave}/>
      </Drawer>

      <MilestoneEditDrawer open={msOpen} onClose={() => setMsOpen(false)} contractId={contractId}
        contractAmount={c.amount} initial={c.milestones} onSaved={reload}/>
      <BudgetEditDrawer open={budgetOpen} onClose={() => setBudgetOpen(false)} contractId={contractId}
        initial={c.cost_budget} onSaved={reload}/>
      <RenewDrawer open={renewOpen} onClose={() => setRenewOpen(false)} contract={c} onSaved={reload}/>
      <ProgressInvoiceDrawer open={progressOpen} onClose={() => setProgressOpen(false)} contract={c} onSaved={reload}/>

      {/* 이미 등록된 거래를 이 주문에 붙인다 */}
      <LinkTxnDrawer open={!!linkOpen} onClose={() => setLinkOpen(null)}
        contractId={contractId} contractName={c.name}
        kind={linkOpen?.kind} axis={linkOpen?.axis} onLinked={reload}/>

      {/* 주문 화면에서 연 거래 상세 — 여기서 고치거나 연결을 뗄 수 있어야
          "잘못된 걸 그 자리에서 처리"가 된다(전체 거래내역으로 나갈 일이 없어진다). */}
      <TxnQuickDrawer txnId={txnOpen} onClose={() => setTxnOpen(null)}
        contractId={contractId} onChanged={() => { setTxnOpen(null); reload(); }}/>
    </div>
  );
};

/* ============ 기성 청구 발행 Drawer (기성형 주문) ============
   주문 품목 단가표를 불러와 품목별 수량을 입력 → 금액=수량×단가 자동 → 청구서 발행.
   총액형의 청구 일정과 달리 마일스톤 없이 품목 line으로 청구한다. */
const ProgressInvoiceDrawer = ({ open, onClose, contract, onSaved }) => {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [issuedAt, setIssuedAt] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [paid, setPaid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');

  const isPurchase = contract?.vendor_gubu === 'A' || contract?.vendor_gubu === 'E';
  const exempt = contract?.vat_mode === 'exempt' || contract?.vat_mode === 'zero';

  // 열릴 때 주문 품목표를 수량 0으로 깔아준다(단가는 주문 단가 스냅샷).
  useEffect(() => {
    if (!open) return;
    setRows((contract?.contract_items || []).map(it => ({
      item_id: it.item_id || '', name: it.name, spec: it.spec || '', unit: it.unit || '',
      // 중량·단가기준은 주문 스냅샷을 그대로 가져온다 — 여기서 빠지면 기성 청구가 수량 기준으로 떨어진다
      // 주문의 중량은 출발점이 아니라 **빈 칸으로 시작**한다 — 회차마다 다르므로
      // 주문값이 미리 들어가 있으면 그대로 발행해 버리기 쉽다(수량과 같은 이유로 0에서 시작).
      weight: '', price_basis: it.price_basis === 'weight' ? 'weight' : 'qty',
      unit_price: Number(it.unit_price) || 0, cost_price: Number(it.cost_price) || 0, qty: '', amount: '',
    })));
    setIssuedAt(localToday());
    setDueAt(''); setPaid(false);
    api.getAccounts().then(a => { setAccounts(a); const bank = a.find(x => x.kind === 'bank'); setAccountId(bank ? bank.id : ''); });
  }, [open, contract]);

  // 수량 입력 시 금액 자동(수동 수정 전까지). 금액을 직접 고치면 그 값을 유지.
  /* 회차 수량(또는 중량)을 넣으면 금액이 따라온다.
     ㎏당 단가 품목은 회차마다 **중량**이 다르다 — 주문에 적힌 중량은 출발점일 뿐이라
     여기서 다시 받아야 한다. 안 그러면 매 회차 같은 중량으로만 청구된다. */
  const setQty = (i, v) => setRows(rs => rs.map((r, idx) => {
    if (idx !== i) return r;
    const n = Number(String(v).replace(/[^0-9.]/g, '')) || 0;
    if (r.price_basis === 'weight') return { ...r, weight: v, amount: Math.round(n * r.unit_price) };
    return { ...r, qty: v, amount: Math.round(n * r.unit_price) };
  }));
  const setAmount = (i, raw) => setRows(rs => rs.map((r, idx) =>
    idx === i ? { ...r, amount: Number(String(raw).replace(/[^0-9]/g, '')) || 0 } : r));

  const lines = rows.filter(r => (Number(r.amount) || 0) > 0);
  const supply = lines.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const vat = exempt ? 0 : Math.round(supply * 0.1);
  const total = supply + vat;

  const submit = async () => {
    if (lines.length === 0) return toast.push('수량 또는 금액이 있는 품목을 입력해주세요');
    setSaving(true);
    const res = await api.issueProgressInvoice(contract.id, {
      issued_at: issuedAt, due_at: dueAt || null, paid, account_id: paid ? (accountId || null) : null,
      lines: lines.map(r => ({
        item_id: r.item_id || null, name: r.name, spec: r.spec, unit: r.unit,
        qty: Number(String(r.qty).replace(/[^0-9.]/g, '')) || 0,
        // 중량·단가기준을 함께 보내야 청구서 품목·거래명세서에 근거가 남는다
        weight: Number(String(r.weight).replace(/[^0-9.]/g, '')) || 0,
        price_basis: r.price_basis === 'weight' ? 'weight' : 'qty',
        unit_price: r.unit_price, cost_price: r.cost_price || 0, amount: Number(r.amount) || 0,
      })),
    });
    setSaving(false);
    if (!res.ok) return toast.push(res.error || '발행에 실패했어요', { tone: 'warn' });
    toast.push(`${res.invoice_no} 발행됐어요${paid ? ' · 정산까지 반영' : ''}`);
    onClose(); onSaved?.();
  };

  return (
    <Drawer open={open} onClose={onClose} label="기성 청구">
      <DrawerHead title="기성 청구 발행" sub={<>{contract?.name} · 품목별 수량을 넣으면 금액이 자동 계산돼요.</>} onClose={onClose}/>
      <div className="drawer-body">
        {(contract?.contract_items || []).length === 0 ? (
          <div className="text-sm text-muted">
            주문에 등록된 품목이 없어요. <b>편집</b>에서 품목 단가표를 먼저 등록해주세요.
          </div>
        ) : (
          <>
            <div className="row gap-12">
              <div style={{ flex: 1 }}>
                <label className="label" style={{ marginBottom: 8 }}>{isPurchase ? '청구일(매입)' : '청구일'}</label>
                <DateInput className="input" value={issuedAt} onChange={e => setIssuedAt(e.target.value)}/>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label" style={{ marginBottom: 8 }}>{isPurchase ? '지급 예정일' : '입금 예정일'} <span className="text-muted2">· 선택</span></label>
                <DateInput className="input" value={dueAt} onChange={e => setDueAt(e.target.value)}/>
              </div>
            </div>
            <Spacer h={16}/>
            <label className="label" style={{ marginBottom: 8 }}>품목별 기성 수량</label>
            <table className="table">
              <thead>
                <tr>
                  <th>품목</th>
                  <th style={{ textAlign: 'right' }}>단가</th>
                  {/* 중량 기준 품목이 섞여 있으면 머리글도 그렇게 적는다 */}
                  <th style={{ width: 80, textAlign: 'right' }}>
                    {rows.some(r => r.price_basis === 'weight') ? '수량·중량' : '수량'}
                  </th>
                  <th style={{ width: 130, textAlign: 'right' }}>금액</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="fw-600">{r.name}{r.spec ? <span className="text-muted2 text-xs"> · {r.spec}</span> : ''}</td>
                    <td className="num text-muted" style={{ textAlign: 'right' }}>{fmtNum(r.unit_price)}{r.unit ? `/${r.unit}` : ''}</td>
                    <td>
                      {/* 중량 기준 품목은 중량을 받는다 — 칸 이름이 '수량'인데 중량을 넣게 하면
                          입력한 사람도, 나중에 명세서를 보는 사람도 무엇을 적은 건지 모른다. */}
                      <input className="input num" style={{ textAlign: 'right' }}
                        value={r.price_basis === 'weight' ? r.weight : r.qty}
                        onChange={e => setQty(i, e.target.value)} placeholder="0"/>
                      {r.price_basis === 'weight' && (
                        <div className="text-xs text-muted2" style={{ textAlign: 'right', marginTop: 2 }}>중량</div>
                      )}
                    </td>
                    <td>
                      <MoneyInput className="input num" style={{ textAlign: 'right' }} value={r.amount}
                        onChange={raw => setAmount(i, raw)}/>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Spacer h={16}/>
            <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
              <div className="row"><span className="text-muted">공급가액</span><span className="num fw-600 ml-auto">{fmtNum(supply)}원</span></div>
              <div className="row" style={{ marginTop: 6 }}><span className="text-muted">부가세{exempt ? ' (면세)' : ''}</span><span className="num ml-auto">{fmtNum(vat)}원</span></div>
              <div className="row" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
                <span className="fw-700">합계</span><span className="num fw-700 ml-auto" style={{ fontSize: 18 }}>{fmtNum(total)}원</span>
              </div>
            </div>
            <Spacer h={14}/>
            <label className="row gap-8" style={{ cursor: 'pointer', alignItems: 'center' }}>
              <input type="checkbox" checked={paid} onChange={e => setPaid(e.target.checked)}/>
              <span className="text-sm">발행과 동시에 {isPurchase ? '지급' : '입금'} 완료로 처리 (실제 거래·정산까지 반영)</span>
            </label>
            {paid && (
              <div style={{ marginTop: 10 }}>
                <label className="label">{isPurchase ? '출금 계좌' : '입금 계좌'}</label>
                <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                  {accounts.filter(a => a.kind === 'bank').map(a => (
                    <button key={a.id} type="button" className={`chip ${accountId === a.id ? 'active' : ''}`} onClick={() => setAccountId(a.id)}>{a.name}</button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="drawer-foot">
        <button className="btn ghost" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" onClick={submit}
          disabled={saving || lines.length === 0}>
          {saving ? '발행 중…' : `${isPurchase ? '매입 기성' : '기성 청구'} 발행`}
        </button>
      </div>
    </Drawer>
  );
};

/* ============ 주문 목록 ============ */
const NEW_CONTRACT_FORM = {
  vendor: "", contract_no: "", order_no: "", project_no: "", name: "", status: "진행중", file_url: "", file_name: "",
  billing_mode: "onetime", term_mode: "fixed", vat_mode: "taxable", docs: [], items: [],
  amount: "", unit_amount: "", billing_period: "monthly", billing_day: "1", initial_amount: "",
  start_date: "", end_date: "", term_months: "12", notice_days: "60",
};

// 폼 → 서버 payload. 금액·기간의 해석은 서버(contract-model)가 하고, 화면은 입력값만 넘긴다.
const contractPayload = (form, vendorId) => ({
  vendor_id:   vendorId || null,
  contract_no: form.contract_no?.trim() || null,
  order_no:    form.order_no?.trim()    || null,
  project_no:  form.project_no?.trim()  || null,
  name:        form.name,
  status:      form.status,
  file_url:    form.file_url  || null,
  file_name:   form.file_name || null,
  billing_mode:   form.billing_mode,
  term_mode:      form.term_mode,
  vat_mode:       ['exempt', 'zero'].includes(form.vat_mode) ? form.vat_mode : 'taxable',
  // 주문 품목표 — 서버가 전체 교체 저장(이름 있는 행만). 청구 방식과 무관하게 저장된다.
  items:          (form.items || []).map(it => ({
    item_id: it.item_id || null, name: it.name, spec: it.spec || '', unit: it.unit || '',
    qty: asNum(it.qty), unit_price: asNum(it.unit_price), cost_price: asNum(it.cost_price),
    /* 중량·단가기준을 반드시 함께 보낸다.
     * 서버(routes/contracts.js)는 이 두 값을 저장하고 기성 발행이 그걸로 금액을 낸다.
     * 안 보내면 서버가 weight=0 · basis='qty' 로 되돌려서, ㎏당 단가로 적어 둔 주문이
     * **저장할 때마다 수량 기준으로 초기화**된다(화면에서 입력은 되는데 다시 열면 사라진다). */
    weight: asNum(it.weight), price_basis: it.price_basis === 'weight' ? 'weight' : 'qty',
  })),
  // 원가예산은 상세의 '예산 수정'이 주 편집기다. 여기선 값이 있을 때만 실어 보낸다
  // (안 실으면 서버가 손대지 않는다 → 주문 편집 저장이 예산을 지우는 사고를 막는다).
  ...(form.cost_budget ? { cost_budget: form.cost_budget } : {}),
  amount:         asNum(form.amount),
  unit_amount:    asNum(form.unit_amount),
  billing_period: form.billing_period,
  billing_day:    asNum(form.billing_day) || 1,
  initial_amount: asNum(form.initial_amount),
  start_date:     form.start_date || null,
  end_date:       form.end_date   || null,
  term_months:    asNum(form.term_months) || 12,
  notice_days:    form.notice_days === '' ? 60 : asNum(form.notice_days),
});

/* 부제로 방향을 못박는다 — '수주'와 '발주'는 한 글자 차이인데 돈의 방향이 반대다.
 * 특히 이 바닥에서 '발주처'는 **우리에게 발주한 고객사**(=수주의 상대)를 가리켜서,
 * 라벨만 보면 '발주'을 발주처 주문으로 읽을 수 있다. 그래서 '우리가 발주한'이라고 쓴다. */
const CONTRACT_KIND_META = {
  all:      { title: "주문 전체", sub: "수주·발주를 한 표에서 봅니다. 주문별 입금·지출·미수금을 확인하세요.", addGubu: "B" },
  sales:    { title: "수주", sub: "우리가 수주한 주문입니다(발주처 = 고객사). 주문별 청구·입금·미수금을 관리하세요.", addGubu: "B" },
  purchase: { title: "발주", sub: "우리가 발주한 주문입니다(외주·구매). 주문별 지급 일정·미지급을 관리하세요.", addGubu: "A" },
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
  const tabs = ["전체", "진행중", "갱신 필요", "만료", "보류", "완료"];
  const meta = CONTRACT_KIND_META[kind] || CONTRACT_KIND_META.all;

  const reload = () => api.getContracts().then(list => setAllContracts(list || []));
  useEffect(() => {
    reload();
    api.getVendors().then(setVendors);
  }, []);

  const handleNewSave = async () => {
    if (!newForm.vendor) return toast.push("거래처를 선택해주세요");
    if (!newForm.name)   return toast.push("주문명을 입력해주세요");
    const recurring = newForm.billing_mode === 'recurring';
    const progress  = newForm.billing_mode === 'progress';
    if (progress && !(newForm.items || []).some(it => (it.name || '').trim() && asNum(it.unit_price) > 0))
      return toast.push("품목과 단가를 하나 이상 입력해주세요");
    // 금액은 직접 입력하거나 품목으로 구성하거나 — 둘 중 하나만 있으면 된다.
    const lineSum = itemsTotal(newForm.items);
    if (recurring && !asNum(newForm.unit_amount) && !lineSum) return toast.push(`${periodLabel(newForm.billing_period)} 청구금액을 입력하거나 품목을 등록해주세요`);
    if (!recurring && !progress && !asNum(newForm.amount) && !lineSum) return toast.push("주문금액을 입력하거나 품목을 등록해주세요");
    if (newForm.term_mode !== 'open' && !newForm.end_date) return toast.push("주문 종료일을 입력해주세요 (무기한이면 종료 방식을 '무기한'으로)");
    const vendorObj = vendors.find(v => v.name === newForm.vendor);
    const res = await api.addContract(contractPayload(newForm, vendorObj?.id));
    if (res.ok) {
      // 폼에서 올린 계약서 파일들을 주문 첨부(contract_docs)로 연결
      for (const d of (newForm.docs || [])) await api.addContractDoc(res.id, { url: d.url, name: d.name, doc_type: '계약서', size: d.size || 0 });
      toast.push("주문이 등록됐어요");
      setNewOpen(false);
      setNewForm(NEW_CONTRACT_FORM);
      reload();
    } else {
      toast.push(res.error || "저장에 실패했어요", { tone: 'warn' });
    }
  };

  // 거래처 gubu로 매출(B)·매입(A/E) 분류. gubu 미상은 매출로 간주(기존 데이터 호환).
  const vendorGubu = useMemo(() => Object.fromEntries(vendors.map(v => [v.id, v.gubu])), [vendors]);
  const isPurchase = (r) => { const g = vendorGubu[r.vendor_id]; return g === "A" || g === "E"; };
  // 남은 잔액은 서버(metrics)가 주문 성격에 맞게 계산해 준다.
  // 무기한 정기주문은 '남은 주문분'이 없으므로(null) 미수금을 대신 보여준다.
  const rowRemain = (r) => (r.remain != null ? r.remain : (r.ar_remain || 0));
  const scoped = allContracts.filter(r => kind === "all" ? true : kind === "purchase" ? isPurchase(r) : !isPurchase(r));

  const pms = useMemo(() => [...new Set(scoped.map(c => c.pm).filter(Boolean))].sort(), [scoped]);
  // 갱신 탭은 상태값이 아니라 종료일·통보기한으로 판정(renewalInfo)
  const matchTab = (r) => {
    if (tab === "전체") return true;
    if (tab === "갱신 필요") return renewalInfo(r).stage === "due";
    if (tab === "만료")     return renewalInfo(r).stage === "expired";
    return r.status === tab;
  };
  const rows = scoped
    .filter(matchTab)
    .filter(r => !q || (r.name || "").includes(q) || (r.vendor_name || r.vendor || "").includes(q))
    .filter(r => !filterPM || r.pm === filterPM);

  const renewDue     = scoped.filter(r => renewalInfo(r).stage === "due").length;
  const renewExpired = scoped.filter(r => renewalInfo(r).stage === "expired").length;

  // 무기한 정기주문은 총액이 없으므로 '주문금액 합계'에서 빠진다(넣으면 합계가 거짓말이 됨).
  // 대신 월정액 합계(MRR)를 따로 센다 — 정기형 주문의 실질 규모는 이쪽이다.
  const totals = scoped.reduce((a, c) => ({
    amount: a.amount + (hasTotal(c) ? (c.amount || 0) : 0),
    remain: a.remain + rowRemain(c),        // 주문잔액 — 아직 청구 안 한 금액을 포함한다
    arRemain: a.arRemain + (c.ar_remain || 0),  // 진짜 미수금 — 청구했는데 안 들어온 돈
    monthly: a.monthly + (isRecurring(c) && c.status === '진행중'
      ? Math.round((c.unit_amount || 0) / periodMonths(c.billing_period)) : 0),
  }), { amount: 0, remain: 0, arRemain: 0, monthly: 0 });

  // 엑셀 내보내기 — 서버가 서식·요약까지 갖춘 .xlsx를 만든다
  // (주문 목록 / 갱신 관리 / 정기 주문 3개 시트)
  const [exporting, setExporting] = useState(false);
  const exportXlsx = async () => {
    if (scoped.length === 0) return toast.push("내보낼 주문이 없어요");
    setExporting(true);
    const res = await api.exportContractsXlsx(kind);
    setExporting(false);
    toast.push(res.ok ? "엑셀 파일을 내려받았어요" : (res.error || "내보내기에 실패했어요"));
  };

  return (
    <div className="fade-up">
      <PageHeader
        title={meta.title}
        actions={<>
          <button className="btn" onClick={exportXlsx} disabled={exporting}>
            <Icon.Download/> {exporting ? "만드는 중..." : "엑셀 내보내기"}
          </button>
          <button className="btn primary" onClick={() => { setNewForm(NEW_CONTRACT_FORM); setNewOpen(true); }}><Icon.Plus/> 신규 생성</button>
        </>}
      />

      {/* 색은 '지금 챙길 게 있다'는 신호일 때만 켠다. 평상시엔 무채색(ink) — 다 칠하면 색이 의미를 잃는다. */}
      <KpiRow cols={5}>
        <Kpi label="진행중 주문"   value={`${scoped.filter(c => c.status === "진행중").length}건`} badge={`총 ${scoped.length}건`} badgeTone="ink"/>
        <Kpi label="주문금액 합계" value={fmtNum(totals.amount) + "원"}  badge="무기한 주문 제외"  badgeTone="ink"/>
        <Kpi label={kind === "purchase" ? "월 고정지출" : "월 고정수입"} value={fmtNum(totals.monthly) + "원"}
          badge={`정기주문 ${scoped.filter(c => isRecurring(c) && c.status === '진행중').length}건 · 월 환산`} badgeTone="ink"/>
        {/* ⚠ 이 카드는 '미수금'이 아니라 **남은 주문분**이다.
            totals.remain 은 주문잔액(주문 총액 − 수금)이라 **아직 청구조차 안 한 금액을 포함**한다.
            예전엔 '남은 미수금'이라고 불러서, 주문만 맺고 청구는 한 장도 안 한 상태에서
            미수금 4,664만원이 떠 있었다 — 홈·미수금 화면은 0원인데 여기만 다른 말을 했다.
            진짜 미수금(청구했는데 안 들어온 돈)은 ar_remain 이므로 뱃지로 따로 보여준다. */}
        <Kpi label={kind === "purchase" ? "남은 주문분(지급)" : "남은 주문분"} value={fmtNum(totals.remain) + "원"}
          /* 뱃지는 '다를 때만' 의미가 있다. 두 값이 같으면(총액형이 전부 완납이라
             남은 주문분 = 미수금인 경우) 같은 숫자를 두 번 보여주는 꼴이라 오히려 헷갈린다. */
          badge={totals.arRemain > 0 && totals.arRemain !== totals.remain
            ? `그중 ${kind === "purchase" ? "미지급금" : "미수금"} ${fmtNum(totals.arRemain)}원`
            : `${scoped.filter(c => rowRemain(c) > 0).length}건 잔존`}
          badgeTone={totals.arRemain > 0 ? "warn" : "ink"}/>
        <Kpi label="갱신 챙길 주문" value={`${renewDue + renewExpired}건`}
          badge={renewExpired > 0 ? `만료 방치 ${renewExpired}건` : renewDue > 0 ? "통보 기한 임박" : "임박 없음"}
          badgeTone={renewExpired > 0 ? "neg" : renewDue > 0 ? "warn" : "ink"}/>
      </KpiRow>
      <Spacer h={20}/>

      <div className="card">
        {/* 상태 칩 6개 + 검색·필터가 한 줄에 서는데 .row 는 줄바꿈을 안 한다 —
            좁은 화면에서 합이 상자보다 넓어져 화면 전체가 가로로 밀렸다.
            검색칸도 220px 고정이라 접힌 줄에서 다시 비어져 나온다(거래내역·청구서와 같은 처리). */}
        <div className="row gap-8" style={{ padding: "16px 16px", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
          {tabs.map(t => (
            <button key={t} className={`chip ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t}</button>
          ))}
          {/* 검색 + 필터는 **한 덩어리**다. flex 기본값(0 1 auto)이면 줄이 빡빡할 때 이 묶음이
              먼저 쪼그라들고, 묶음 자신도 wrap 이라 **안에서** 세로로 쌓인다 —
              검색칸 위, 필터 버튼 아래로 두 줄이 된다(.search 의 min(220px,100%) 이
              쪼그라든 부모를 따라가 더 좁아진다). 줄이 모자라면 묶음째 다음 줄로 내려가야 한다. */}
          <div className="ml-auto tbar-right">
            <div className="search tbar-search" style={{ padding: "6px 10px" }}>
              <Icon.Search size={14}/>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="주문/거래처 검색"/>
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
        <DataTable
          rows={rows}
          rowKey={r => r.id}
          onRowClick={r => goDetail(r.id, r.name)}
          empty="조건에 맞는 주문이 없어요"
          columns={[
            { key: 'name', header: '주문', width: '24%', render: r => {
              const openEnded = !hasTotal(r);
              // 진행률은 '이번 계약기간' 기준. 무기한 주문은 채울 총액이 없어 막대를 안 그린다.
              // 총액은 서버 metrics의 term_total 사용(vat_mode 반영). 화면에서 ×1.1 재계산 금지.
              const total = r.term_total ?? 0;
              const pct = openEnded || total <= 0 ? null : Math.min(100, Math.round(((r.term_collected ?? 0) / total) * 100));
              return <>
                <div className="fw-600">{r.name}</div>
                <div className="row gap-8" style={{ marginTop: 8 }}>
                  {pct == null
                    ? <span className="text-xs text-muted2">청구 {r.billed ? fmtNum(r.billed) : 0}원 · 수금 {fmtNum(r.collected ?? 0)}원</span>
                    : <><div className="bar-track" style={{ width: 120 }}><div className="bar-fill" style={{ width: `${pct}%` }}/></div><span className="text-xs text-muted2 num">{pct}%</span></>}
                  <span className="text-xs text-muted2">· {billingLabel(r)}/{termLabel(r)}</span>
                </div>
              </>
            } },
            { key: 'contract_no', header: '주문번호', width: 110, sortable: true, render: r => <span className="text-sm num" style={{ color: r.contract_no ? undefined : "var(--muted-2)" }}>{r.contract_no || '—'}</span> },
            { key: 'vendor', header: '거래처', sortable: true, sortValue: r => r.vendor_name || r.vendor || '', render: r => <span className="fw-600">{r.vendor_name || r.vendor || '—'}</span> },
            { key: 'term', header: '계약기간 · 갱신', width: 175, render: r => <>
              <div className="text-sm num">
                {/* 기간은 **총액 유무와 무관하다.** 예전엔 hasTotal 로 갈랐는데, 기성형은
                    총액 개념이 없어 hasTotal=false 라서 종료일을 넣어도 늘 '해지 시까지'로 떴다
                    (2026-12-31 까지인 단가주문이 무기한처럼 보였다 — 갱신 시점을 놓친다).
                    기간은 종료일이 있느냐, 무기한(term_mode=open)이냐로만 정한다. */}
                {isOpenEnded(r) || !r.end_date ? `${r.start_date || '—'} ~ 해지 시까지` : [r.start_date, r.end_date].filter(Boolean).join(' ~ ')}
              </div>
              {renewalInfo(r).managed && <div style={{ marginTop: 6 }}><RenewalBadge contract={r}/></div>}
            </> },
            { key: 'amount', header: '금액', align: 'right', sortable: true, sortValue: r => r.amount || 0, render: r => (
              isRecurring(r)
                ? <div><div className="fw-600">{fmtNum(r.unit_amount || 0)}<span className="text-xs text-muted2">/{periodLabel(r.billing_period)}</span></div>{hasTotal(r) && <div className="text-xs text-muted2">기간 총 {fmtNum(r.amount || 0)}</div>}</div>
                /* 옆 칸의 '수금'·'남은 주문분'은 전부 **부가세 포함** 금액이다.
                   여기만 공급가(c.amount)를 보여줘서, 주문 8,400,000 인데 수금 9,240,000 처럼
                   같은 행의 숫자끼리 앞뒤가 안 맞아 보였다("주문보다 많이 받았나?").
                   기준을 맞춰 VAT 포함 총액(term_total)을 크게 두고, 공급가는 밑에 적는다. */
                : (r.term_total != null && r.term_total !== r.amount
                    ? <div><div className="num-cell">{fmtNum(r.term_total)}</div>
                        <div className="text-xs text-muted2">공급가 {fmtNum(r.amount || 0)}</div></div>
                    : <span className="num-cell">{fmtNum(r.amount || 0)}</span>)
            ) },
            { key: 'collected', header: kind === "purchase" ? "지급액" : "수금", align: 'right', sortable: true, sortValue: r => r.collected ?? 0, render: r => <span className="num-cell">{fmtNum(r.collected ?? 0)}</span> },
            /* 총액형은 '주문잔액'(아직 청구 안 한 몫 포함), 기성·무기한형은 remain 이 없어
               ar_remain(미수금)이 온다. 둘은 성격이 다르므로 무엇을 보고 있는지 밑줄에 적는다. */
            { key: 'remain', header: '남은 주문분', align: 'right', sortable: true, sortValue: r => rowRemain(r), render: r => (
              <span className="num-cell fw-700" style={{ color: rowRemain(r) > 0 ? "var(--warn-ink)" : "var(--muted-2)" }}>
                {rowRemain(r) > 0 ? fmtNum(rowRemain(r)) : "—"}
                {rowRemain(r) > 0 && (
                  <div className="text-xs fw-400 text-muted2">
                    {hasTotal(r) ? '미청구 포함' : (isPurchase(r) ? '미지급금' : '미수금')}
                  </div>
                )}
              </span>
            ) },
            // 매입 주문엔 원가·손익이 없다 → 미지급금으로 대체
            { key: 'cost', header: kind === "purchase" ? "미지급금" : "원가", align: 'right', render: r => (
              isPurchase(r)
                ? <span className="num-cell fw-700" style={{ color: (r.ar_remain || 0) > 0 ? "var(--warn-ink)" : "var(--muted-2)" }}>{(r.ar_remain || 0) > 0 ? fmtNum(r.ar_remain) : "—"}</span>
                /* r.out 이 아니라 r.cost 다.
                   out  = 이 주문이 '근거'인 지출(contract_id)      — 매입주문의 지급액
                   cost = 이 매출주문에 '귀속'된 원가(cost_contract_id) — 외주비 등
                   매출 주문의 원가는 후자다. out 을 쓰던 탓에 원가가 늘 0으로 보였고,
                   손익은 cost 를 빼고 계산해서 **수금 523,000 · 원가 0 · 손익 +323,000**처럼
                   화면 안에서 뺄셈이 맞지 않았다(손익이 틀린 게 아니라 원가 칸이 거짓이었다). */
                : <span className="num-cell text-muted">{fmtNum(r.cost || 0)}</span>
            ) },
            // 매입 주문은 손익 칸 자체가 없다('전체'에선 칸 비워 정렬 맞춤). 손익은 마이너스일 때만 색 경고.
            ...(kind !== "purchase" ? [{ key: 'profit', header: '예상 손익', align: 'right', sortable: true, sortValue: r => isPurchase(r) ? null : (r.profit || 0), render: r => (
              isPurchase(r)
                ? <span className="num-cell text-muted2">—</span>
                : <span className="num-cell fw-700" style={{ color: (r.profit || 0) < 0 ? "var(--neg-ink)" : undefined }}>{(r.profit || 0) >= 0 ? "+" : ""}{fmtNum(r.profit || 0)}</span>
            ) }] : []),
            { key: 'status', header: '상태', render: r => <StatusBadge status={r.status}/> },
          ]}
        />
      </div>

      <Drawer open={newOpen} onClose={() => setNewOpen(false)}
        width={(newForm.items || []).length > 0 ? "min(1240px,100vw)" : "min(480px,100vw)"}
        label="신규 생성">
        <div className="drawer-body">
          <div className="col gap-form">
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
              <label className="label" style={{ marginBottom: 8 }}>주문명 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
              <input className="input" value={newForm.name} onChange={e => setNewForm(f => ({ ...f, name: e.target.value }))} placeholder="주문명을 입력하세요"/>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>주문번호 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
              <input className="input" value={newForm.contract_no} onChange={e => setNewForm(f => ({ ...f, contract_no: e.target.value }))} placeholder="예: CT-2026-001 (계약서 번호)"/>
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>주문을 번호로 구분하는 경우 입력하세요. 목록·상세에 표시됩니다.</div>
            </div>
            <ContractTermFields form={newForm} set={setNewForm}/>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>주문 상태</label>
              <div className="row gap-6">
                {["진행중", "보류", "완료"].map(s => (
                  <button key={s} type="button" className={`chip ${newForm.status === s ? "active" : ""}`} onClick={() => setNewForm(f => ({ ...f, status: s }))}>{s}</button>
                ))}
              </div>
            </div>
            <ContractRefFields form={newForm} set={setNewForm}/>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>계약서 첨부 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택 · 여러 개 가능</span></label>
              <FileAttach
                docs={newForm.docs || []}
                onAdd={(d) => setNewForm(f => ({ ...f, docs: [...(f.docs || []), d] }))}
                onRemove={(d) => setNewForm(f => ({ ...f, docs: (f.docs || []).filter(x => x !== d) }))}
                label="계약서 파일을 끌어다 놓거나 클릭"/>
            </div>
          </div>
        </div>
        <DrawerFooter onCancel={() => setNewOpen(false)} onSave={handleNewSave} saveLabel="등록"/>
      </Drawer>
    </div>
  );
};
