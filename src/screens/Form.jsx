import { useState, useEffect, useRef, useMemo } from 'react'
import { Icon, fmtNum, useToast, Combobox, Drawer, MoneyInput, localToday } from '../lib/ui'
import { FileAttach } from '../lib/FileAttach'
import { api } from '../lib/api'

// 과세유형 3종. 영세 = 세율 0%인 과세거래(수출·해외용역) — 세액은 0이지만 과세표준엔 들어간다.
// 면세와 값을 나눠 두지 않으면 신고서에서 둘을 구분할 수 없다. 서버 lib/vat.js와 같은 값집합.
const TAX_TYPES = ["과세", "면세", "영세"];

/** 금액 한 값에서 공급가·세액·합계를 한 번에 맞춘다.
 *  bySupply=true 면 입력값이 공급가액(세금계산서 기준), false 면 VAT 포함 총액. */
const applyTax = (f, value, bySupply) => {
  const v = Number(value) || 0;
  if (f.taxType !== "과세") return { ...f, amount: v, supply: v, vat: 0 };
  if (bySupply) { const vat = Math.round(v * 0.1); return { ...f, supply: v, vat, amount: v + vat }; }
  const supply = Math.round(v / 1.1);
  return { ...f, amount: v, supply, vat: v - supply };
};

const initialFormFor = (kind, contract = "", firstAccount = "", costContract = "") => {
  const today = localToday();
  return kind === "income"
    ? { vendor: "", contract, acctGroup: "", category: "", item: "", itemId: "", accountCode: "", amount: 0, account: firstAccount, date: today, memo: "", taxType: "과세", vatDeductible: true, supply: 0, vat: 0, docs: [] }
    : { vendor: "", contract, costContract, acctGroup: "", category: "", item: "", itemId: "", accountCode: "", amount: 0, method: "계좌이체", account: firstAccount, employee: "", date: today, memo: "", taxType: "과세", vatDeductible: true, supply: 0, vat: 0, docs: [] };
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

const TAX_INVOICE_GROUPS = ["재료비", "외주가공비", "시험·인증비"];

export const TransactionForm = ({ open, kind: initialKind = "expense", initialContract, initialCostContract, initialVendor, initialCategory, initialMemo, editTxn, onClose, onSave }) => {
  const toast = useToast();
  const [kind, setKind] = useState(initialKind);
  const [form, setForm] = useState(initialFormFor(initialKind, initialContract, "", initialCostContract));
  const [showMore, setShowMore] = useState(false);
  const [supplyMode, setSupplyMode] = useState(false);
  const taxable = form.taxType === "과세";
  const [taxWarningDismissed, setTaxWarningDismissed] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);            // 품목(선택)
  const [jeokyos, setJeokyos] = useState([]);        // 적요
  const [evidenceTypes, setEvidenceTypes] = useState([]);  // 적격증빙 유형(매입세액 공제 판정)
  const [acctSubjects, setAcctSubjects] = useState([]); // 계정과목(선택)
  const [contracts, setContracts] = useState([]);
  const [employees, setEmployees] = useState([]);

  // 거래는 계약에 두 축으로 붙는다.
  //   근거 계약  — 이 돈이 오간 약정. 입금=매출계약 / 지출=매입계약(외주 계약 등), 없으면 공통
  //   원가 귀속  — (지출만) 이 돈이 어느 매출건의 원가인지. 외주비는 외주계약에 '지급'되면서 그 프로젝트의 '원가'가 된다.
  const contractOpts = useMemo(() => {
    const opts = contracts
      .filter(c => kind === 'income' ? !c.is_purchase : c.is_purchase)   // 입금=매출계약 / 지출=매입계약
      .map(c => ({
        value: c.name, label: c.name,
        sub: [c.vendor_name, c.status].filter(Boolean).join(' · '),
      }));
    if (kind === 'income') return opts;
    return [
      ...opts,
      { value: "공통(원자재)",   label: "공통(원자재)",   sub: "계약 없이 나가는 돈" },
      { value: "공통(생산소모)", label: "공통(생산소모)", sub: "계약 없이 나가는 돈" },
      { value: "공통(인건비)",   label: "공통(인건비)",   sub: "급여·보험 등" },
      { value: "공통",           label: "공통",           sub: "사무·운영" },
    ];
  }, [contracts, kind]);

  // 원가 귀속 후보 = 매출 계약만
  const costContractOpts = useMemo(() => ([
    { value: "", label: "귀속 없음", sub: "특정 매출건의 원가가 아님 (일반 경비)" },
    ...contracts.filter(c => !c.is_purchase).map(c => ({
      value: c.name, label: c.name,
      sub: [c.vendor_name, c.status].filter(Boolean).join(' · '),
    })),
  ]), [contracts]);

  useEffect(() => {
    api.getVendors().then(setVendors);
    api.getAccounts().then(list => {
      setAccounts(list);
      if (list.length > 0) setForm(f => ({ ...f, account: f.account || list[0].name }));
    });
    api.getContracts().then(list => setContracts(list));
    api.getEmployees().then(setEmployees);
    api.getCategories().then(setCategories);
    api.getRefItems('item').then(setItems);
    api.getRefItems('jeokyo').then(setJeokyos);
    api.getRefItems('evidence_type').then(setEvidenceTypes);
    api.getAccountSubjects({ postableOnly: true }).then(setAcctSubjects);
  }, []);

  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setForm({ ...initialFormFor(initialKind, initialContract, accounts[0]?.name || "", initialCostContract),
        vendor: initialVendor || "",
        category: initialCategory || "",   // 환불·환입처럼 비목을 미리 지정하고 여는 경우
        memo: initialMemo || "" });
      setShowMore(false);
    }
  }, [open, initialKind, initialContract, initialCostContract, initialVendor, initialCategory, initialMemo]);

  // 편집 모드: 기존 데이터 프리필 — 열 때 1회. 참조목록(categories·items) 로드와 무관하게
  // editTxn에서 직접 복원(품목명·직원명은 서버 조인으로 옴) → 늦은 로드가 입력 중 폼을 리셋하지 않게 함
  useEffect(() => {
    if (!open || !editTxn) return;
    const supply = editTxn.amount ? Math.round(editTxn.amount / 1.1) : 0;
    setKind(editTxn.kind);
    setShowMore(!!(editTxn.evid_url || editTxn.account_code || editTxn.project_no || editTxn.site));
    setForm({
      vendor:    editTxn.vendor   || '',
      // 자동 생성 거래(청구서 정산·정기지출·급여)는 계약이 비어 있을 수 있어 '공통'으로 복원
      contract:  editTxn.contract || '공통',
      costContract: editTxn.cost_contract_name || '',
      acctGroup: '',                                   // 아래 파생 effect에서 채움
      category:  editTxn.category === '—' ? '' : (editTxn.category || ''),
      item:      editTxn.item_name || '',
      itemId:    editTxn.item_id   || '',
      accountCode: editTxn.account_code || '',
      amount:    editTxn.amount   || 0,
      account:   editTxn.account  || accounts[0]?.name || '',
      method:    editTxn.method   || '계좌이체',
      date:      editTxn.date     || localToday(),
      memo:      editTxn.memo     || '',
      // 과세유형·공급가·세액은 저장된 값이 있으면 그대로. 이 기능 이전 거래는 값이 없어 합계에서 역산한다.
      taxType:   editTxn.tax_type || '과세',
      vatDeductible: editTxn.vat_deductible !== 0,
      supply:    editTxn.supply_amount != null ? editTxn.supply_amount : supply,
      vat:       editTxn.vat_amount != null ? editTxn.vat_amount : (editTxn.amount || 0) - supply,
      evid_url:  editTxn.evid_url  || '',
      project_no: editTxn.project_no || '',
      site:      editTxn.site || '',
      evid_type: editTxn.evid_type || '',
      evidFile:  null,
      employee:  editTxn.employee || '',
      docs:      [],   // 편집 시 새로 올리는 첨부만
    });
  }, [open, editTxn]);

  // 비목의 계정과목 그룹(세금계산서 안내 배너용) 파생 — 폼 리셋 없이 acctGroup만 갱신
  useEffect(() => {
    if (!form.category) return;
    const g = categories.find(c => c.name === form.category)?.group_name || '';
    setForm(f => f.acctGroup === g ? f : { ...f, acctGroup: g });
  }, [form.category, categories]);


  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); handleSave(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, form, kind]);

  const handleSave = async () => {
    if (!form.vendor)   { toast.push("거래처를 선택해주세요"); return; }
    if (!form.contract) { toast.push("계약/공통을 선택해주세요"); return; }
    if (!form.category) { toast.push(kind === "income" ? "수금 유형을 선택해주세요" : "비목을 선택해주세요"); return; }
    if (!form.memo || !form.memo.trim()) { toast.push("적요(거래 내용)를 입력해주세요"); return; }
    if (!form.amount)   { toast.push("금액을 입력해주세요"); return; }
    if (!form.date || !/^\d{4}-\d{2}-\d{2}$/.test(form.date)) { toast.push("날짜를 올바른 형식으로 입력해주세요"); return; }
    if (form.date > localToday()) { toast.push(`미래 날짜로는 ${kind === "income" ? "입금" : "지출"}을 등록할 수 없어요 (오늘까지만 가능)`); return; }

    const vendorObj   = vendors.find(v => v.name === form.vendor)
    const contractObj = contracts.find(c => c.name === form.contract)
    const accountObj  = accounts.find(a => a.name === form.account)
    const employeeObj = employees.find(e => e.name === form.employee)

    const amount = typeof form.amount === "string"
      ? parseInt(form.amount.replace(/[^0-9]/g, ""), 10)
      : form.amount

    const costContractObj = contracts.find(c => c.name === form.costContract)

    const txnData = {
      kind,
      vendor_id:    vendorObj?.id   || null,
      contract_id:  contractObj?.id || null,
      // 원가 귀속(지출만) — 이 돈이 어느 매출건의 원가인지. 근거 계약과 별개 축.
      cost_contract_id: kind === "expense" ? (costContractObj?.id || null) : null,
      account_id:   accountObj?.id  || null,
      employee_id:  employeeObj?.id || null,
      category:     form.category,
      sub_category: "",
      item_id:      form.itemId || null,
      account_code: form.accountCode || null,
      amount,
      // 부가세: 화면에서 이미 갈라 둔 공급가·세액을 그대로 넘긴다(서버가 유형 기준으로 한 번 더 검증).
      supply_amount:  form.supply,
      vat_amount:     form.vat,
      tax_type:       form.taxType || "과세",
      vat_deductible: form.vatDeductible === false ? 0 : 1,
      date:         form.date,
      method:       form.method || "계좌이체",
      status:       editTxn?.status || (kind === "income" ? "입금완료" : "지급완료"),
      // 업종중립 선택 입력 — 조선=호선번호, 천막=설치현장, 선반=작업지시번호, SW=프로젝트코드
      project_no:   form.project_no || "",
      site:         form.site || "",
      // 실제 계약이 아닌 "공통 XYZ" 선택 시 doc_no에 이름 보존
      doc_no:       contractObj ? '' : (form.contract || ''),
      memo:         form.memo || "",
      evid_type:    form.evid_type || "",
      evid_url:     form.evid_url  || "",
    }

    const res = editTxn
      ? await api.updateTransaction(editTxn.id, txnData)
      : await api.addTransaction(txnData)

    if (res.ok) {
      // 폼에서 올린 증빙(여러 개)을 거래에 연결
      const txnId = editTxn ? editTxn.id : res.id
      if (txnId && (form.docs || []).length) {
        for (const d of form.docs) await api.addTransactionDoc(txnId, { url: d.url, name: d.name, doc_type: '기타', size: d.size || 0 })
      }
      onClose()
      onSave?.()
      toast.push(editTxn ? "수정됐어요" : (kind === "income" ? "입금 내역이 등록됐어요" : "지출 내역이 등록됐어요"))
    } else {
      toast.push("저장에 실패했어요. 다시 시도해주세요.")
    }
  };

  return (
    <Drawer open={open} onClose={onClose} width="min(520px, 100vw)" label={editTxn ? "거래 수정" : "거래 등록"}>
        {/* 종류는 진입점(입금 등록/지출 등록)에서 이미 정해져 열린다 → 폼 안에서 전환하지 않는다. */}
        <div className="drawer-head" style={{ padding: "14px 22px" }}>
          <div className="row gap-8" style={{ alignItems: "center" }}>
            <span className={`badge ${kind === "income" ? "pos" : "neg"}`}>
              {kind === "income"
                ? <><Icon.In size={13} style={{ verticalAlign: -2, marginRight: 3 }}/> 입금</>
                : <><Icon.Out size={13} style={{ verticalAlign: -2, marginRight: 3 }}/> 지출</>}
            </span>
            <span className="fw-700" style={{ fontSize: 15 }}>{editTxn ? "거래 수정" : "거래 등록"}</span>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        <div className="drawer-body" style={{ paddingTop: 8 }}>
          <div className="col gap-form">
            <FormField label="거래처" required>
              <Combobox value={form.vendor} onChange={v => setForm({...form, vendor: v})}
                options={(kind === "income"
                  ? vendors.filter(v => v.gubu === "B")
                  : vendors.filter(v => ["A", "E"].includes(v.gubu))
                ).map(v => ({ value: v.name, label: v.name, sub: `${v.type || ''} · ${v.phone || ''}` }))}
                placeholder={kind === "income" ? "발주처를 검색하거나 선택하세요" : "거래처를 검색하거나 선택하세요"}
                onAddNew={async (q) => {
                  const gubu = kind === "income" ? "B" : "A"
                  const res = await api.addVendor({ name: q, gubu })
                  if (res.ok) {
                    const updated = await api.getVendors()
                    setVendors(updated)
                    setForm(f => ({ ...f, vendor: q }))
                    toast.push(`"${q}" 거래처가 등록됐어요`)
                  } else {
                    toast.push("거래처 등록에 실패했어요")
                  }
                }}
                addNewLabel="거래처로 추가"/>
            </FormField>

            <FormField label={kind === "income" ? "매출 계약" : "매입 계약 / 공통"} required
              hint={kind === "expense" ? "이 돈이 나가는 근거 계약(외주·구매). 계약 없이 쓰는 돈이면 공통" : null}>
              <Combobox value={form.contract} onChange={v => setForm({...form, contract: v})}
                options={contractOpts}
                placeholder={kind === "expense" ? "매입 계약 선택 (없으면 공통)" : "매출 계약을 검색하거나 선택하세요"}
                onAddNew={(q) => { setForm({...form, contract: q}); toast.push(`"${q}" 계약을 새로 등록했어요`); }}
                addNewLabel="계약으로 추가"/>
            </FormField>

            {/* 원가 귀속 — 이 지출이 어느 매출건의 원가인지. 외주비는 외주계약에 '지급'되면서 그 프로젝트의 '원가'가 된다.
                두 축이 따로라 이중계상이 아니다. */}
            {kind === "expense" && (
              <FormField label="원가 귀속 (매출 계약)"
                hint="이 지출이 특정 매출건 때문에 나갔다면 그 계약을 고르세요. 그 계약의 손익에 원가로 잡힙니다.">
                <Combobox value={form.costContract || ""} onChange={v => setForm({...form, costContract: v})}
                  options={costContractOpts}
                  placeholder="귀속할 매출 계약 (없으면 비워두세요)"/>
              </FormField>
            )}

            {/* 계정과목(선택) → 비목(필수) → 적요(필수) 순. 계정과목은 표준 분류라 기본 노출. */}
            <FormField label="계정과목" hint="선택 · 표준 계정과목(K-GAAP)">
              <Combobox value={form.accountCode}
                onChange={(v) => setForm(f => ({ ...f, accountCode: v }))}
                options={acctSubjects.map(a => ({ value: a.code, label: a.name, sub: `${a.code} · ${a.category}`, keywords: a.note || "" }))}
                placeholder="계정과목 선택 (선택)"
                allowAdd={false}/>
            </FormField>

            <FormField label={kind === "income" ? "수금 유형(비목)" : "비목"} required>
              <Combobox value={form.category}
                onChange={(v) => {
                  const catItems = categories.filter(c => c.id?.startsWith(kind === "income" ? "INC-" : "EXP-"))
                  const c = catItems.find(x => x.name === v)
                  setForm(f => {
                    // 비목이 정해 둔 과세유형·매입세액 공제 여부를 기본값으로 물려받는다(거래별 수정 가능).
                    const next = { ...f, category: v, acctGroup: c?.group_name || "" }
                    if (c) {
                      if (c.vat === "면세" || c.vat === "영세") next.taxType = c.vat
                      else if (c.vat === "10%") next.taxType = "과세"
                      next.vatDeductible = c.vat_deductible !== 0
                    }
                    return applyTax(next, next.amount, false)
                  })
                }}
                options={categories.filter(c => c.id?.startsWith(kind === "income" ? "INC-" : "EXP-"))
                  .map(c => ({ value: c.name, label: c.name, sub: c.group_name || "" }))}
                placeholder={kind === "income" ? "수금 유형을 검색하거나 선택하세요" : "비목을 검색하거나 선택하세요"}
                allowAdd={false}/>
            </FormField>

            <FormField label="품목" hint="선택 · 고르면 적요·금액 자동 채움">
              <Combobox value={form.item}
                onChange={(v) => {
                  const it = items.find(x => x.name === v)
                  setForm(f => {
                    const next = { ...f, item: v, itemId: it?.id || "" }
                    if (it) {
                      if (!f.memo || f.memo === f.item) next.memo = it.name   // 적요 자동 채움(비어있거나 이전 품목명일 때만)
                      // 들어오는 돈은 출고가(amount), 나가는 돈은 매입가(purchase_price)가 맞는 단가다.
                      // 매입가가 없는 품목이면 종전대로 출고가로 채운다.
                      const unit = kind === 'expense' ? (Number(it.purchase_price) || Number(it.amount)) : Number(it.amount)
                      // 품목에 과세유형이 정해져 있으면 그것도 따라간다(기준정보 tax_type → 거래).
                      if (it.tax_type) next.taxType = it.tax_type
                      if (unit && !f.amount) {                                // 단가는 공급가액 — 총액 = 단가 + 부가세
                        Object.assign(next, applyTax(next, unit, true))
                      }
                    }
                    return next
                  })
                }}
                options={items.map(it => {
                  const unit = kind === 'expense' ? (Number(it.purchase_price) || Number(it.amount)) : Number(it.amount)
                  return { value: it.name, label: it.name,
                    sub: [it.code, it.spec, it.unit, unit ? fmtNum(unit) + '원' : ''].filter(Boolean).join(' · ') }
                })}
                placeholder="품목 선택 (선택)"
                allowAdd={false}/>
            </FormField>

            <FormField label="적요" required hint="거래 내용">
              <Combobox value={form.memo}
                onChange={(v) => setForm(f => ({ ...f, memo: v }))}
                options={jeokyos.map(j => ({ value: j.name, label: j.name, sub: j.memo || '' }))}
                placeholder="적요를 검색·선택하거나 직접 입력하세요"
                onAddNew={(q) => setForm(f => ({ ...f, memo: q }))}
                addNewLabel="적요로 입력"/>
            </FormField>

            {kind === "expense" && form.acctGroup && TAX_INVOICE_GROUPS.includes(form.acctGroup) && !taxWarningDismissed && (
              <div style={{ background: "var(--warn-bg, #fffbeb)", border: "1px solid var(--warn, #f59e0b)", borderRadius: 10, padding: "12px 14px" }}>
                <div className="row gap-8" style={{ marginBottom: 8 }}>
                  <Icon.Warn size={15} style={{ color: "var(--warn-ink, #92400e)", flexShrink: 0 }}/>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--warn-ink, #92400e)" }}>세금계산서가 있는 지출이에요</div>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6, marginBottom: 10 }}>
                  재료비·외주가공비는 매입 &gt; 대금 청구서에 먼저 등록하세요.<br/>
                  미지급금 추적과 부가세 신고 자료가 자동으로 맞춰집니다.
                </div>
                <div className="row gap-8">
                  <button type="button" className="btn" style={{ fontSize: 12 }}
                    onClick={() => { onClose(); window.location.hash = "billing_received"; }}>
                    <Icon.Recv size={13}/> 청구 관리로 이동
                  </button>
                  <button type="button" className="btn" style={{ fontSize: 12, color: "var(--muted)" }}
                    onClick={() => setTaxWarningDismissed(true)}>
                    직접 등록
                  </button>
                </div>
              </div>
            )}

            {/* 과세유형은 입금·지출 모두에 필요하다. 여태 지출에만 '면세' 체크가 있었고 입금은
                무조건 세액 0으로 처리돼, 청구서를 안 거친 매출의 세액이 부가세 신고에서 빠졌다. */}
            <FormField label="과세유형" hint={
              taxable ? "공급가액에 부가세 10%" : form.taxType === "영세" ? "세율 0% — 세액은 없지만 과세표준에는 들어가요" : "부가세 없는 거래"}>
              <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                {TAX_TYPES.map(t => (
                  <button key={t} type="button" className={`chip ${form.taxType === t ? "active" : ""}`}
                    onClick={() => setForm(f => applyTax({ ...f, taxType: t }, f.amount, false))}>{t}</button>
                ))}
              </div>
            </FormField>

            <FormField label="금액" required>
              {taxable && (
                <div className="row gap-6" style={{ marginBottom: 8 }}>
                  <button type="button"
                    className={`chip ${!supplyMode ? "active" : ""}`}
                    onClick={() => { setSupplyMode(false); setForm(f => applyTax(f, f.amount, false)); }}>
                    총액 입력
                  </button>
                  <button type="button"
                    className={`chip ${supplyMode ? "active" : ""}`}
                    onClick={() => { setSupplyMode(true); setForm(f => applyTax(f, f.supply || f.amount, true)); }}>
                    공급가액 입력
                  </button>
                  <span className="text-muted2" style={{ fontSize: 11.5, alignSelf: "center" }}>
                    {supplyMode ? "세금계산서 기준 (VAT 별도)" : "VAT 포함 총액"}
                  </span>
                </div>
              )}
              <div style={{ position: "relative" }}>
                <MoneyInput className="input num fw-700" style={{ fontSize: 22, paddingRight: 40 }}
                  value={supplyMode && taxable ? form.supply : form.amount}
                  onChange={(raw, v) => setForm(f => applyTax(f, v, supplyMode && taxable))}/>
                <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: "var(--muted-2)", fontSize: 14, fontWeight: 600 }}>원</span>
              </div>
              {taxable && form.amount > 0 && (
                <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--muted)" }}>
                  공급가액 <b className="num" style={{ color: "var(--ink)" }}>{fmtNum(form.supply)}</b> ·
                  부가세 <b className="num" style={{ color: "var(--ink)" }}>{fmtNum(form.vat)}</b> ·
                  합계 <b className="num" style={{ color: "var(--ink)" }}>{fmtNum(form.amount)}</b>
                </div>
              )}
              {/* 접대비·비영업용 승용차 등은 세금계산서를 받아도 매입세액을 공제받지 못한다.
                  세액은 그대로 기록하되 부가세 집계의 공제분에서만 뺀다. */}
              {kind === "expense" && taxable && form.amount > 0 && (
                <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer", marginTop: 8, fontSize: 11.5, color: "var(--muted)" }}>
                  <input type="checkbox" checked={!form.vatDeductible}
                    onChange={e => setForm(f => ({ ...f, vatDeductible: !e.target.checked }))}/>
                  매입세액 불공제 <span className="text-muted2">(접대비·비영업용 승용차 등)</span>
                </label>
              )}
              <div className="row gap-6" style={{ marginTop: 8, flexWrap: "wrap" }}>
                {(kind === "income" ? [5000000, 10000000, 20000000, 50000000] : [500000, 1000000, 3000000, 5000000]).map(a => (
                  <button key={a} type="button" className="chip"
                    onClick={() => setForm(f => applyTax(f, a, supplyMode && taxable))}>{fmtNum(a)}원</button>
                ))}
              </div>
            </FormField>

            {/* 매입세액 공제는 '적격증빙'이 있어야 받는다 — 공제 여부를 좌우하므로 추가정보에 숨기지 않는다.
                불공제 증빙(간이영수증 등)을 고르면 불공제 체크도 같이 맞춰 준다. */}
            {kind === "expense" && taxable && (
              <FormField label="증빙유형" hint="선택 · 매입세액 공제 판정에 쓰여요">
                <Combobox value={form.evid_type}
                  onChange={(v) => {
                    const e = evidenceTypes.find(x => x.name === v)
                    setForm(f => ({ ...f, evid_type: v, vatDeductible: e ? e.deductible !== 0 : f.vatDeductible }))
                  }}
                  options={evidenceTypes.map(e => ({ value: e.name, label: e.name,
                    sub: [e.deductible === 0 ? '매입세액 공제 불가' : '공제 가능', e.memo].filter(Boolean).join(' · ') }))}
                  placeholder="증빙유형 선택 (선택)"
                  allowAdd={false}/>
              </FormField>
            )}

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
                {form.method === "계좌이체" && (
                  <div className="row gap-6" style={{ flexWrap: "wrap", marginTop: 8 }}>
                    {accounts.filter(a => a.kind !== "card").map(a => (
                      <button key={a.id} type="button" className={`chip ${form.account === a.name ? "active" : ""}`}
                        onClick={() => setForm({...form, account: a.name})}>
                        <Icon.Bank size={12}/>{a.name}
                      </button>
                    ))}
                  </div>
                )}
                {(form.method === "법인카드" || form.method === "개인카드") && (
                  <div className="row gap-6" style={{ flexWrap: "wrap", marginTop: 8 }}>
                    {accounts.filter(a => a.kind === "card").length === 0 ? (
                      <span className="text-xs text-muted2">등록된 카드가 없어요. 설정 → 계좌/카드에서 추가하세요.</span>
                    ) : accounts.filter(a => a.kind === "card").map(a => (
                      <button key={a.id} type="button" className={`chip ${form.account === a.name ? "active" : ""}`}
                        onClick={() => setForm({...form, account: a.name})}>
                        <Icon.Card size={12}/>{a.name}
                      </button>
                    ))}
                  </div>
                )}
              </FormField>
            ) : (
              <FormField label="입금 계좌" required>
                <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                  {accounts.filter(a => a.kind !== "card").map(a => (
                    <button key={a.id} type="button" className={`chip ${form.account === a.name ? "active" : ""}`}
                      onClick={() => setForm({...form, account: a.name})}>
                      <Icon.Bank size={12}/>{a.name}
                    </button>
                  ))}
                </div>
              </FormField>
            )}

            {kind === "expense" && (form.method === "개인카드" || form.method === "현금") && (
              <FormField label="사용 직원" hint="월말 정산을 위해 지정하세요 (선택)">
                <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                  <button type="button" className={`chip ${!form.employee ? "active" : ""}`}
                    onClick={() => setForm({...form, employee: ""})}>없음</button>
                  {employees.filter(e => e.status === "재직" || e.status === "수습").map(e => (
                    <button key={e.id} type="button" className={`chip ${form.employee === e.name ? "active" : ""}`}
                      onClick={() => setForm({...form, employee: e.name})}>
                      {e.name}<span className="text-muted2" style={{ fontWeight: 400, marginLeft: 2 }}>· {e.dept}</span>
                    </button>
                  ))}
                </div>
              </FormField>
            )}

            <FormField label={kind === "income" ? "입금일" : "지출일"} required>
              <input className="input" type="date" max={localToday()} value={form.date} onChange={e => setForm({...form, date: e.target.value})}/>
            </FormField>

            <div>
              <button type="button"
                onClick={() => setShowMore(s => !s)}
                style={{ border: 0, background: "transparent", color: "var(--muted)", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, padding: 0, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Icon.Right size={12} style={{ transform: showMore ? "rotate(90deg)" : "none", transition: "transform .15s" }}/>
                추가 정보 (선택)
              </button>
              {showMore && (
                <div className="col gap-form" style={{ marginTop: 14 }}>
                  {/* 업종중립 선택 입력. 업종마다 부르는 이름이 다르다(조선=호선번호, 천막=설치현장,
                      선반=작업지시번호, SW=프로젝트코드) — 안 쓰는 회사는 비워두면 그만이다. */}
                  <div className="row gap-12">
                    <div style={{ flex: 1 }}>
                      <FormField label="프로젝트·공사번호" hint="선택">
                        <input className="input" value={form.project_no || ''} placeholder="예: 231호선 / PRJ-2026-01"
                          onChange={e => setForm(f => ({ ...f, project_no: e.target.value }))}/>
                      </FormField>
                    </div>
                    <div style={{ flex: 1 }}>
                      <FormField label="현장·사용처" hint="선택">
                        <input className="input" value={form.site || ''} placeholder="예: 1공장 / 본사"
                          onChange={e => setForm(f => ({ ...f, site: e.target.value }))}/>
                      </FormField>
                    </div>
                  </div>
                  <FormField label="증빙 첨부" hint="세금계산서·영수증 등 여러 개 첨부 가능">
                    {form.evid_url && (
                      <div className="row gap-10" style={{ padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-2)', marginBottom: 8 }}>
                        <Icon.Receipt size={15} style={{ color: 'var(--brand)', flexShrink: 0 }}/>
                        <span className="text-sm fw-600" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(form.evid_url).split('/').pop() || '기존 증빙'}</span>
                        <a className="btn ghost sm" href={form.evid_url} target="_blank" rel="noreferrer"><Icon.Eye size={13}/></a>
                        <button type="button" className="icon-btn" onClick={() => setForm(f => ({ ...f, evidFile: null, evid_url: '', evid_type: '' }))}><Icon.Close size={14}/></button>
                      </div>
                    )}
                    <FileAttach
                      docs={form.docs || []}
                      onAdd={(d) => setForm(f => ({ ...f, docs: [...(f.docs || []), d] }))}
                      onRemove={(d) => setForm(f => ({ ...f, docs: (f.docs || []).filter(x => x !== d) }))}
                      label="증빙을 끌어다 놓거나 클릭 (여러 개 가능)"/>
                  </FormField>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>취소</button>
          <div className="ml-auto row gap-8" style={{ alignItems: "center" }}>
            <span className="text-xs text-muted2"><span className="kbd">⌘</span> <span className="kbd">↵</span> 저장</span>
            <button className="btn primary" onClick={handleSave}><Icon.Check size={14}/> {editTxn ? "수정" : "등록"}</button>
          </div>
        </div>
    </Drawer>
  );
};
