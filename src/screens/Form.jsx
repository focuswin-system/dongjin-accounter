import { useState, useEffect, useRef, useMemo } from 'react'
import { Icon, fmtNum, useToast, Combobox, Drawer, MoneyInput, localToday } from '../lib/ui'
import { FileAttach } from '../lib/FileAttach'
import { api } from '../lib/api'

const initialFormFor = (kind, contract = "", firstAccount = "", costContract = "") => {
  const today = localToday();
  return kind === "income"
    ? { vendor: "", contract, acctGroup: "", category: "", item: "", itemId: "", accountCode: "", amount: 0, account: firstAccount, date: today, memo: "", taxFree: false, supply: 0, vat: 0, docs: [] }
    : { vendor: "", contract, costContract, acctGroup: "", category: "", item: "", itemId: "", accountCode: "", amount: 0, method: "계좌이체", account: firstAccount, employee: "", date: today, memo: "", taxFree: false, supply: 0, vat: 0, docs: [] };
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
  const [taxWarningDismissed, setTaxWarningDismissed] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);            // 품목(선택)
  const [jeokyos, setJeokyos] = useState([]);        // 적요
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
    setShowMore(!!(editTxn.evid_url || editTxn.account_code));
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
      taxFree:   false,
      supply,
      vat:       (editTxn.amount || 0) - supply,
      evid_url:  editTxn.evid_url  || '',
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
      date:         form.date,
      method:       form.method || "계좌이체",
      status:       editTxn?.status || (kind === "income" ? "입금완료" : "지급완료"),
      buyer_type:   "공통",
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
                  setForm(f => ({ ...f, category: v, acctGroup: c?.group_name || "" }))
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
                      if (it.amount && !f.amount) {                           // 단가(공급가액)로 자동 채움 — 총액 = 단가 + 부가세 (지출·입금 동일)
                        const supply = Number(it.amount)
                        const vat = f.taxFree ? 0 : Math.round(supply * 0.1)
                        next.supply = supply
                        next.vat = vat
                        next.amount = supply + vat
                      }
                    }
                    return next
                  })
                }}
                options={items.map(it => ({ value: it.name, label: it.name,
                  sub: [it.code, it.spec, it.unit, it.amount ? fmtNum(it.amount) + '원' : ''].filter(Boolean).join(' · ') }))}
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
                  재료비·외주가공비는 구매·매입 &gt; 대금 청구서에 먼저 등록하세요.<br/>
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

            <FormField label="금액" required>
              {kind === "expense" && !form.taxFree && (
                <div className="row gap-6" style={{ marginBottom: 8 }}>
                  <button type="button"
                    className={`chip ${!supplyMode ? "active" : ""}`}
                    onClick={() => { setSupplyMode(false); setForm(f => ({ ...f, supply: Math.round(f.amount / 1.1), vat: f.amount - Math.round(f.amount / 1.1) })); }}>
                    총액 입력
                  </button>
                  <button type="button"
                    className={`chip ${supplyMode ? "active" : ""}`}
                    onClick={() => { setSupplyMode(true); setForm(f => ({ ...f, supply: f.amount, vat: Math.round(f.amount * 0.1), amount: f.amount + Math.round(f.amount * 0.1) })); }}>
                    공급가액 입력
                  </button>
                  <span className="text-muted2" style={{ fontSize: 11.5, alignSelf: "center" }}>
                    {supplyMode ? "세금계산서 기준 (VAT 별도)" : "VAT 포함 총액"}
                  </span>
                </div>
              )}
              <div style={{ position: "relative" }}>
                <MoneyInput className="input num fw-700" style={{ fontSize: 22, paddingRight: 40 }}
                  value={supplyMode ? form.supply : form.amount}
                  onChange={(raw, v) => {
                    if (supplyMode) {
                      const vat = form.taxFree ? 0 : Math.round(v * 0.1);
                      setForm({ ...form, supply: v, vat, amount: v + vat });
                    } else {
                      const supply = kind === "expense" && !form.taxFree ? Math.round(v / 1.1) : v;
                      setForm({ ...form, amount: v, supply, vat: v - supply });
                    }
                  }}/>
                <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: "var(--muted-2)", fontSize: 14, fontWeight: 600 }}>원</span>
              </div>
              {kind === "expense" && (form.amount > 0 || form.supply > 0) && (
                <div className="row gap-6" style={{ marginTop: 8, fontSize: 11.5, color: "var(--muted)" }}>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                    <input type="checkbox" checked={form.taxFree} onChange={e => {
                      const tf = e.target.checked;
                      setSupplyMode(false);
                      setForm({ ...form, taxFree: tf, supply: tf ? form.amount : Math.round(form.amount / 1.1), vat: tf ? 0 : form.amount - Math.round(form.amount / 1.1) });
                    }}/>
                    면세
                  </label>
                  {!form.taxFree && (
                    <span style={{ marginLeft: 8 }}>
                      공급가액 <b className="num" style={{ color: "var(--ink)" }}>{fmtNum(form.supply)}</b> ·
                      부가세 <b className="num" style={{ color: "var(--ink)" }}>{fmtNum(form.vat)}</b> ·
                      합계 <b className="num" style={{ color: "var(--ink)" }}>{fmtNum(form.amount)}</b>
                    </span>
                  )}
                </div>
              )}
              <div className="row gap-6" style={{ marginTop: 8, flexWrap: "wrap" }}>
                {(kind === "income" ? [5000000, 10000000, 20000000, 50000000] : [500000, 1000000, 3000000, 5000000]).map(a => (
                  <button key={a} type="button" className="chip" onClick={() => {
                    if (supplyMode) {
                      const vat = Math.round(a * 0.1);
                      setForm({ ...form, supply: a, vat, amount: a + vat });
                    } else {
                      const supply = kind === "expense" && !form.taxFree ? Math.round(a / 1.1) : a;
                      setForm({ ...form, amount: a, supply, vat: a - supply });
                    }
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
                  <FormField label="증빙 첨부" hint="세금계산서·영수증 등 여러 개 첨부 가능">
                    {form.evid_url && (
                      <div className="row gap-10" style={{ padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-2)', marginBottom: 8 }}>
                        <Icon.Receipt size={15} style={{ color: 'var(--brand)', flexShrink: 0 }}/>
                        <span className="text-sm fw-600" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{form.evid_type || '기존 증빙'}</span>
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
