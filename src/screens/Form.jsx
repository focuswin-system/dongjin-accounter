import { useState, useEffect, useRef, useMemo } from 'react'
import { Icon, fmtNum, useToast, Combobox, Drawer, MoneyInput, localToday, DateInput } from '../lib/ui'
import { FileAttach } from '../lib/FileAttach'
import { api } from '../lib/api'
import { withMainFirst, isMainAccount, MAIN_BADGE } from '../lib/mainAccount'
import { quickAddCategory, quickAddRefItemWithId } from '../lib/quickAdd'

// 과세유형 3종. 영세 = 세율 0%인 과세거래(수출·해외용역) — 세액은 0이지만 과세표준엔 들어간다.
// 면세와 값을 나눠 두지 않으면 신고서에서 둘을 구분할 수 없다. 서버 lib/vat.js와 같은 값집합.
const TAX_TYPES = ["과세", "면세", "영세"];

/* 자금 계정 — 계정과목 후보에서 제외한다. 서버 lib/categoryAccount.js FUND_CODES 와 같은 값집합.
 * 계좌를 이미 고르는 화면이라, 상대 계정에까지 예금·현금이 오면 분개가 성립하지 않는다. */
const FUND_CODES = ["1101", "1102", "1103"];

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

/* 결제수단에 맞는 계좌만 남긴다.
 *
 * ⚠ **조용히 틀린 데이터를 만들던 자리다.** 결제수단을 바꿔도 form.account 가 그대로
 *   남아 있었다. 법인카드를 고르고 계좌를 지정한 뒤 '현금'으로 바꾸면 칩은 사라지는데
 *   뒤에서는 그 카드가 살아 있다가 그대로 저장된다 — 화면에는 아무것도 안 골라진 것으로
 *   보이니 사용자는 알 수가 없다.
 *   운영(태영엔지니어링)에서 현금 지출 3건이 법인카드 '공장장(4851)'에 달려 있었다.
 *   현금으로 낸 돈이 카드 미결제로 잡혀 카드 대금 예측이 6만원 부풀어 있었다.
 *
 * 수단이 바뀌면 그 수단이 쓸 수 없는 계좌는 놓는다. 같은 갈래면 그대로 둔다
 * (법인카드 ↔ 개인카드처럼 둘 다 카드인 경우에는 다시 고르게 하지 않는다).
 */
const accountKindFor = (method) =>
  method === '현금' ? 'cash' : (method === '법인카드' || method === '개인카드') ? 'card' : 'bank'

const keepAccount = (current, method, accounts = []) => {
  if (!current) return ''
  const a = accounts.find(x => x.name === current)
  if (!a) return ''
  const want = accountKindFor(method)
  // 현금 시재는 kind='cash'. 옛 데이터가 보통예금 계좌에 type='현금'으로 있을 수도 있어 둘 다 본다.
  const isCash = a.kind === 'cash' || a.type === '현금'
  const has = isCash ? 'cash' : a.kind === 'card' ? 'card' : 'bank'
  return has === want ? current : ''
}

const TAX_INVOICE_GROUPS = ["재료비", "외주가공비", "시험·인증비"];

export const TransactionForm = ({ open, kind: initialKind = "expense", initialContract, initialCostContract, initialVendor, initialCategory, initialMemo,
  /* 경비 모드 — 영수증·카드전표로 나간 자잘한 돈을 적을 때. 주문 관련 칸(발주·원가 귀속)을 접는다.
   *
   * 왜 접나: 식대 8,000원을 적는데 '발주'와 '원가 귀속'을 지나쳐야 하면, 칸이 많아서가 아니라
   * **읽고 판단해야 해서** 느려진다("이건 발주가 있나?"). 경비는 정의상 주문에 안 붙는 돈이라
   * 그 판단이 늘 '아니오'다. 필요하면 '주문에 붙이기'로 펼 수 있게 두어 기능은 잃지 않는다. */
  compact = false,
  editTxn, onClose, onSave }) => {
  const toast = useToast();
  const [kind, setKind] = useState(initialKind);
  const [form, setForm] = useState(initialFormFor(initialKind, initialContract, "", initialCostContract));
  const [showMore, setShowMore] = useState(false);
  // Ctrl+Enter 단축키까지 있어 두 번 눌리기 쉽다 — 같은 거래가 2건 등록되는 걸 막는다
  const [busy, setBusy] = useState(false);
  const [supplyMode, setSupplyMode] = useState(false);
  const taxable = form.taxType === "과세";
  const [taxWarningDismissed, setTaxWarningDismissed] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [vendorAccounts, setVendorAccounts] = useState([]);   // 고른 거래처의 계좌들(여럿일 수 있다)
  const [accounts, setAccounts] = useState([]);
  // 회사 정보 — 주거래 계좌·카드를 앞에 세우는 데 쓴다(lib/mainAccount.js)
  const [company, setCompany] = useState(null);
  /* 기본으로 골라 둘 계좌 — 주거래가 있으면 그것, 없으면 통장 첫 줄.
     ⚠ 이 자리는 **원래도 자동 선택**하던 곳이다(accounts[0]). 새로 위험을 만드는 게 아니라
       더 맞는 것으로 바꾸는 것이다. 칩 목록은 여전히 앞에 세우기만 하고 미리 고르지 않는다. */
  const defaultAccountName = () => {
    const wantId = company?.[initialKind === 'income' ? 'main_in_account_id' : 'main_out_account_id']
    const pick = accounts.find(a => a.id === wantId) || accounts.find(a => a.kind !== 'card') || accounts[0]
    return pick?.name || ''
  };
  /* 계좌를 세 갈래로 나눠 쓴다 — 결제수단마다 고를 수 있는 것이 다르다.
     현금(금고 시재)을 통장 칩에 섞어 두면 "이체로 현금을 냈다"는 말이 안 되는 기록이 생긴다. */
  const isCashAcct = (a) => a.kind !== 'card' && a.type === '현금'
  /* 주거래를 맨 앞으로 — 매일 쓰는 통장이 가나다순 일곱 번째에 있으면 매번 눈으로 찾는다.
     ⚠ **앞에 세우기만 한다.** 미리 골라 두면 확인 없이 지나가 엉뚱한 통장에 기록된다
       (결제수단을 바꿔도 계좌가 남아 현금이 카드에 달린 사고를 방금 겪었다).
     지출 폼이라 'out' 축이다 — 수입이면 'in'. */
  const use = kind === 'income' ? 'in' : 'out'
  const bankAccounts = withMainFirst(
    accounts.filter(a => a.kind !== 'card' && !isCashAcct(a)), company, use)
  const cardAccounts = withMainFirst(accounts.filter(a => a.kind === 'card'), company, 'card')
  const cashAccounts = accounts.filter(isCashAcct)
  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);            // 품목(선택)
  const [jeokyos, setJeokyos] = useState([]);        // 적요
  const [evidenceTypes, setEvidenceTypes] = useState([]);  // 적격증빙 유형(매입세액 공제 판정)
  const [acctSubjects, setAcctSubjects] = useState([]); // 계정과목(선택)
  // 옛 거래에서 비워낸 자금 계정 코드 — 왜 비었는지 칸 아래에 설명하려고 기억해 둔다
  const [staleFundCode, setStaleFundCode] = useState('');
  // 경비 모드에서 접어 둔 주문 칸을 사용자가 폈는가
  const [showOrderFields, setShowOrderFields] = useState(false);
  const [contracts, setContracts] = useState([]);
  const [employees, setEmployees] = useState([]);

  // 거래는 주문에 두 축으로 붙는다.
  //   근거 주문  — 이 돈이 오간 약정. 입금=수주 / 지출=발주(외주·구매). **없으면 비운다(선택 입력)**
  //   원가 귀속  — (지출만) 이 돈이 어느 매출건의 원가인지. 외주비는 외주주문에 '지급'되면서 그 프로젝트의 '원가'가 된다.
  const contractOpts = useMemo(() => {
    const opts = contracts
      .filter(c => kind === 'income' ? !c.is_purchase : c.is_purchase)   // 입금=수주 / 지출=발주
      .map(c => ({
        value: c.name, label: c.name,
        sub: [c.vendor_name, c.status].filter(Boolean).join(' · '),
      }));
    /* 예전엔 지출에 '공통(원자재)'·'공통(생산소모)'·'공통(인건비)'·'공통' 네 개를 붙였다.
     * 주문이 필수 입력이라 주문 없는 지출을 넣을 길이 없었기 때문인데, 두 가지가 잘못됐다.
     *   · 그 값은 doc_no 에 들어가지만 화면에 안 보인다 — 거래 목록의 '주문' 칸은
     *     `contract_name || memo || doc_no` 순으로 고르는데(api.js) 적요가 필수라 항상 적요가 이긴다.
     *   · 무엇보다 **분류가 아니다.** 원자재냐 생산소모냐는 비목(category)이 이미 받고 있다.
     * 주문은 선택 입력으로 두고, 없으면 비우는 게 맞다(contract_id 는 nullable). */
    return opts;
  }, [contracts, kind]);

  // 원가 귀속 후보 = 수주만
  const costContractOpts = useMemo(() => ([
    { value: "", label: "귀속 없음", sub: "특정 수주건의 원가가 아님 (일반 경비)" },
    ...contracts.filter(c => !c.is_purchase).map(c => ({
      value: c.name, label: c.name,
      sub: [c.vendor_name, c.status].filter(Boolean).join(' · '),
    })),
  ]), [contracts]);

  useEffect(() => {
    api.getVendors().then(setVendors);
    /* ⚠ 기본 계좌는 이미 자동으로 골라지고 있었다(`list[0]`). 그런데 그건 **가나다순 첫 줄**이라
       카드가 걸릴 수도 있었다 — 기본 결제수단이 계좌이체인데 카드가 골라져 있는 셈이다.
       주거래 계좌가 지정돼 있으면 그것을, 없으면 통장 중 첫 줄을 쓴다.
       (이미 고르고 있던 자리라 새로 위험을 만드는 게 아니다 — 더 맞는 것으로 바꾸는 것이다.
        칩 목록은 여전히 앞에 세우기만 하고 미리 고르지 않는다.) */
    Promise.all([api.getAccounts(), api.getCompany()]).then(([list, co]) => {
      setAccounts(list);
      setCompany(co);
      const wantId = co?.[kind === 'income' ? 'main_in_account_id' : 'main_out_account_id']
      const pick = list.find(a => a.id === wantId) || list.find(a => a.kind !== 'card') || list[0]
      if (pick) setForm(f => ({ ...f, account: f.account || pick.name }));
    });
    api.getContracts().then(list => setContracts(list));
    // 고르기만 하면 되므로 최소 목록 — 전체 목록은 급여까지 담고 있어 인사 권한이 필요하다
    api.getEmployeeOptions().then(setEmployees);
    api.getCategories().then(setCategories);
    api.getRefItems('item').then(setItems);
    api.getRefItems('jeokyo').then(setJeokyos);
    api.getRefItems('evidence_type').then(setEvidenceTypes);
    /* 자금 계정(현금·당좌·보통예금)은 후보에서 뺀다.
     * 이 칸은 **계좌의 상대 계정**이라, 여기에 예금·현금이 오면 분개가
     * `보통예금 / 보통예금` 이 되어 매출도 비용도 장부에 잡히지 않는다.
     * (2026-08 실데이터 조사에서 이 유형 결함 15건 — '현금 = 돈'으로 오해해 1101을 골랐다) */
    api.getAccountSubjects({ postableOnly: true })
      .then(rows => setAcctSubjects(rows.filter(a => !FUND_CODES.includes(String(a.code)))));
  }, []);

  useEffect(() => {
    if (open) {
      setKind(initialKind);
      setStaleFundCode('');
      setShowOrderFields(false);
      /* ⚠ 기본 계좌는 `accounts[0]` — **가나다순 첫 줄**이었다. 카드가 걸릴 수도 있고,
         주거래를 지정해 뒀는데 엉뚱한 통장이 골라져 있으면 "왜 이게 선택돼 있지"가 된다.
         주거래 → 통장 첫 줄 순으로 고른다(로더와 같은 규칙). */
      setForm({ ...initialFormFor(initialKind, initialContract, defaultAccountName(), initialCostContract),
        vendor: initialVendor || "",
        category: initialCategory || "",   // 환불·환입처럼 비목을 미리 지정하고 여는 경우
        memo: initialMemo || "" });
      setShowMore(false);
    }
    /* ⚠ **accounts·company 를 의존성에 넣지 않는다.** 넣었다가 되돌렸다 —
       이 효과는 setForm 으로 폼을 통째로 갈아엎는다. 목록이 늦게 도착하면 그때 다시 돌아
       **사용자가 입력 중이던 내용을 지운다.** 열릴 때 한 번만 도는 게 맞다.
       처음 마운트 직후라 목록이 비어 있는 경우는 아래 로더가 `f.account ||` 로 채운다. */
  }, [open, initialKind, initialContract, initialCostContract, initialVendor, initialCategory, initialMemo]);

  // 편집 모드: 기존 데이터 프리필 — 열 때 1회. 참조목록(categories·items) 로드와 무관하게
  // editTxn에서 직접 복원(품목명·직원명은 서버 조인으로 옴) → 늦은 로드가 입력 중 폼을 리셋하지 않게 함
  useEffect(() => {
    if (!open || !editTxn) return;
    setKind(editTxn.kind);
    setShowMore(!!(editTxn.evid_url || editTxn.account_code || editTxn.project_no || editTxn.site));
    /* 자금 계정을 비웠으면 그 사실을 알린다 — 조용히 비우면 사용자가 모르는 채로 저장한다.
       showMore 도 켜서 계정과목 칸이 접혀 있지 않게 한다(안 보이면 안내도 안 읽힌다). */
    const stale = FUND_CODES.includes(String(editTxn.account_code || '')) ? String(editTxn.account_code) : '';
    setStaleFundCode(stale);
    if (stale) setShowMore(true);
    setForm({
      vendor:    editTxn.vendor   || '',
      /* 주문이 비어 있으면 비운 채로 둔다. 예전엔 '공통'을 지어내 채웠는데(주문이 필수였으니까),
         주문 없이 만들어진 자동 생성 거래(청구서 정산·정기지출·급여)를 한 번만 열어도
         '공통'이 doc_no 에 박혔다. 없는 것은 없는 채로 보여준다. */
      contract:  editTxn.contract || '',
      costContract: editTxn.cost_contract_name || '',
      acctGroup: '',                                   // 아래 파생 effect에서 채움
      category:  editTxn.category === '—' ? '' : (editTxn.category || ''),
      item:      editTxn.item_name || '',
      itemId:    editTxn.item_id   || '',
      /* 옛 거래가 자금 계정(1101 등)을 상대 계정으로 들고 있으면 **비운다.**
       *
       * 그 코드는 후보 목록에서 빠졌으므로 Combobox 가 라벨을 못 찾아 "1101" 이라는
       * 코드만 덩그러니 보이고, 저장을 누르면 서버가 400 으로 막는다(fundAccountError).
       * 사용자는 어느 칸이 문제인지 알 방법이 없어 거래를 영영 못 고친다.
       * 비워 두면 서버가 비목에 맞는 계정과목을 넣어 주므로 저장이 되고, 아래 안내로
       * 무엇이 바뀌었는지 알린다. (2026-08 조사에서 fowin 15건이 이 상태였다) */
      accountCode: FUND_CODES.includes(String(editTxn.account_code || '')) ? '' : (editTxn.account_code || ''),
      amount:    editTxn.amount   || 0,
      account:   editTxn.account  || accounts[0]?.name || '',
      method:    editTxn.method   || '계좌이체',
      date:      editTxn.date     || localToday(),
      memo:      editTxn.memo     || '',
      // 과세유형·공급가·세액: 저장된 값이 있으면 그대로. 값이 없는 거래(급여·보험·청구서정산 등
      // 자동생성분)를 과세로 역산하면 없던 부가세가 생겨 매입세액이 부풀었다 → 세액 없으면 면세로 본다.
      taxType:   editTxn.tax_type || (Number(editTxn.vat_amount) > 0 ? '과세' : '면세'),
      vatDeductible: editTxn.vat_deductible !== 0,
      supply:    editTxn.supply_amount != null ? editTxn.supply_amount : (editTxn.amount || 0),
      vat:       editTxn.vat_amount != null ? editTxn.vat_amount : 0,
      evid_url:  editTxn.evid_url  || '',
      project_no: editTxn.project_no || '',
      site:      editTxn.site || '',
      evid_type: editTxn.evid_type || '',
      evidFile:  null,
      employee:  editTxn.employee || '',
      cpAccountId: editTxn.counterpartyAccountId || '',
      docs:      [],   // 편집 시 새로 올리는 첨부만
    });
  }, [open, editTxn]);

  /* 고른 거래처의 계좌 목록. 거래처가 바뀌면 다시 읽고, 이전 선택은 버린다 —
     A사 계좌를 고른 채 거래처만 B사로 바꾸면 남의 계좌가 붙는다. */
  useEffect(() => {
    const v = vendors.find(x => x.name === form.vendor)
    if (!v) { setVendorAccounts([]); return }
    let alive = true
    api.getVendor(v.id).then(d => {
      if (!alive) return
      const list = d?.accounts || []
      setVendorAccounts(list)
      setForm(f => {
        // 편집으로 열었을 때 이미 붙어 있던 계좌는 지키고, 목록에 없으면 비운다
        if (f.cpAccountId && list.some(a => a.id === f.cpAccountId)) return f
        // 계좌가 하나뿐이면 고를 것이 없다 — 그게 그 계좌다
        const only = list.length === 1 ? list[0].id : ''
        const primary = list.find(a => a.is_primary)?.id || ''
        const next = only || primary || ''
        return f.cpAccountId === next ? f : { ...f, cpAccountId: next }
      })
    })
    return () => { alive = false }
  }, [form.vendor, vendors]);

  // 비목의 계정과목 그룹(세금계산서 안내 배너용) 파생 — 폼 리셋 없이 acctGroup만 갱신
  useEffect(() => {
    if (!form.category) return;
    const g = categories.find(c => c.name === form.category)?.group_name || '';
    setForm(f => f.acctGroup === g ? f : { ...f, acctGroup: g });
  }, [form.category, categories]);

  /* 비목이 정해 둔 계정과목 이름 — 계정과목 칸을 비워 두면 무엇이 들어갈지 미리 보여준다.
   * 값을 폼에 밀어 넣지는 않는다. 넣으면 사용자가 고른 것과 자동으로 정해진 것을
   * 구분할 수 없어져, 나중에 비목을 바꿔도 옛 계정과목이 그대로 남는다(서버가 정한다). */
  const autoAcctName = useMemo(() => {
    if (form.accountCode || !form.category) return '';
    const code = categories.find(c => c.name === form.category)?.account_code;
    if (!code) return '';
    const s = acctSubjects.find(a => String(a.code) === String(code));
    return s ? `${s.code} ${s.name}` : '';
  }, [form.accountCode, form.category, categories, acctSubjects]);


  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); handleSave(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, form, kind]);

  /* 상대 계좌 고르기 — 거래처가 계좌를 **여럿** 준 경우에만 묻는다.
     하나뿐이면 고를 것이 없으므로 묻지 않고 그 계좌를 붙인다(위 effect).
     입력을 늘리는 일이라, 늘려야만 하는 자리에서만 늘린다. */
  const counterpartyPicker = (ask) => vendorAccounts.length > 1 && (
    <div style={{ marginTop: 10 }}>
      <div className="text-xs text-muted2" style={{ marginBottom: 6 }}>
        {form.vendor} 계좌가 {vendorAccounts.length}개예요. {ask}
      </div>
      <div className="row gap-6" style={{ flexWrap: "wrap" }}>
        {vendorAccounts.map(a => (
          <button key={a.id} type="button"
            className={`chip ${form.cpAccountId === a.id ? "active" : ""}`}
            onClick={() => setForm({ ...form, cpAccountId: a.id })}>
            {a.bank_name || "은행 미상"} {a.account_no}
            {a.holder && <span className="text-muted2" style={{ fontWeight: 400, marginLeft: 2 }}>· {a.holder}</span>}
          </button>
        ))}
      </div>
    </div>
  );

  const handleSave = async () => {
    if (busy) return;
    if (!form.vendor)   { toast.push("거래처를 선택해주세요"); return; }
    // 주문은 선택 입력이다 — 주문 없이 오가는 돈이 정상적으로 더 많다(경비·소모품·공과금).
    // 예전엔 필수라서 '공통'을 고르게 했고, 그게 가짜 주문 선택지가 생긴 이유였다.
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
      // 원가 귀속(지출만) — 이 돈이 어느 매출건의 원가인지. 근거 주문과 별개 축.
      cost_contract_id: kind === "expense" ? (costContractObj?.id || null) : null,
      account_id:   accountObj?.id  || null,
      // 상대 계좌 — id 만 보낸다. 은행·계좌번호는 서버가 그 줄을 다시 읽어 베낀다.
      counterparty_account_id: form.cpAccountId || null,
      /* 직원은 **id 와 이름을 함께** 보낸다.
         명부에 있으면 둘 다, 명부에 없는 사람(퇴사자·알바·대표 가족)이면 이름만 남는다 —
         법인카드는 실제로 그런 사람이 쓴다. id 만 보내면 그 경우 기록이 통째로 사라진다. */
      employee_id:   employeeObj?.id || null,
      employee_name: form.employee || null,
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
      // 목록에 없는 이름을 '주문 없이 이 이름으로 적어두기'로 넣은 경우에만 doc_no 에 남는다.
      // (기존 데이터의 '공통…' 값도 이 경로로 그대로 보존된다 — 열었다고 지우지 않는다)
      doc_no:       contractObj ? '' : (form.contract || ''),
      memo:         form.memo || "",
      evid_type:    form.evid_type || "",
      evid_url:     form.evid_url  || "",
    }

    setBusy(true);
    const res = editTxn
      ? await api.updateTransaction(editTxn.id, txnData)
      : await api.addTransaction(txnData)
    setBusy(false);

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
      // 마감된 달·계좌 누락 등 서버가 알려준 사유를 그대로 보여준다(막연한 '실패' 대신)
      toast.push(res.error || "저장에 실패했어요. 다시 시도해주세요.", { tone: 'warn' })
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
                    toast.push("거래처 등록에 실패했어요", { tone: 'warn' })
                  }
                }}
                addNewLabel="거래처로 추가"/>
            </FormField>

            {/* 경비 모드에서는 주문 두 칸을 접어 둔다. 수정 중이거나 이미 값이 있으면 편다 —
                접어서 보이지 않는 칸에 값이 들어 있으면 "왜 이 주문에 붙었지"를 알 수 없다. */}
            {compact && !showOrderFields && !form.contract && !form.costContract && (
              <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }}
                onClick={() => setShowOrderFields(true)}>
                <Icon.Plus size={12}/> 주문에 붙이기 (발주·원가 귀속)
              </button>
            )}
            {(!compact || showOrderFields || form.contract || form.costContract) && <>
            <FormField label={kind === "income" ? "수주 (선택)" : "발주 (선택)"}
              hint={kind === "expense"
                ? "이 돈이 나가는 근거 주문(외주·구매)이 있을 때만 고르세요. 경비·공과금처럼 주문 없이 쓰는 돈은 비워둡니다."
                : "이 입금의 근거 주문이 있을 때만 고르세요. 없으면 비워둡니다."}>
              <Combobox value={form.contract} onChange={v => setForm({...form, contract: v})}
                options={contractOpts}
                placeholder={contractOpts.length
                  ? (kind === "expense" ? "해당 발주가 있으면 선택" : "해당 수주가 있으면 선택")
                  : "등록된 주문이 없어요 (비워두면 됩니다)"}
                /* 주문은 거래처·품목과 달리 이름만으로 만들 수 없다(거래처·금액·기간·청구방식이 있어야
                   미수금과 기성 집계가 성립한다). 그래서 여기서 입력한 이름은 주문이 되지 않고
                   이 거래의 '참조'(doc_no)로만 남는다 — 주문별 매출·원가 집계에는 잡히지 않는다.
                   예전엔 "주문을 새로 등록했어요"라고 알려서, 등록된 줄 알고 넘어가면
                   그 매출이 주문 실적에서 통째로 빠졌다. 무슨 일이 일어나는지 그대로 말한다. */
                onAddNew={(q) => {
                  setForm({ ...form, contract: q })
                  toast.push(`"${q}"는 참조로만 적어둡니다. 주문 실적에 넣으려면 주문 화면에서 등록 후 다시 연결해주세요.`, { tone: 'warn' })
                }}
                addNewLabel="주문 없이 이 이름으로 적어두기"/>
            </FormField>

            {/* 원가 귀속 — 이 지출이 어느 매출건의 원가인지. 외주비는 외주주문에 '지급'되면서 그 프로젝트의 '원가'가 된다.
                두 축이 따로라 이중계상이 아니다. */}
            {kind === "expense" && (
              <FormField label="원가 귀속 (수주)"
                hint="이 지출이 특정 수주건 때문에 나갔다면 그 주문을 고르세요. 그 주문의 손익에 원가로 잡힙니다.">
                <Combobox value={form.costContract || ""} onChange={v => setForm({...form, costContract: v})}
                  options={costContractOpts}
                  placeholder="귀속할 수주 (없으면 비워두세요)"/>
              </FormField>
            )}
            </>}

            {/* 계정과목(선택) → 비목(필수) → 적요(필수) 순. 계정과목은 표준 분류라 기본 노출.
                비워 두면 서버가 비목에 달린 계정과목을 넣는다(routes/transactions.js resolveAcctCode) —
                그래서 '선택'이지만 실제로는 대부분 채워진다. 다르게 잡아야 할 때만 직접 고르면 된다. */}
            <FormField label="계정과목"
              hint={staleFundCode
                ? `이 거래에 '${staleFundCode}' 가 상대 계정으로 들어 있었어요. 그러면 장부에 매출·비용이 잡히지 않아 비웠습니다 — 비목에 맞춰 다시 정해집니다.`
                : "비워두면 비목에 맞춰 자동으로 정해집니다"}>
              <Combobox value={form.accountCode}
                onChange={(v) => setForm(f => ({ ...f, accountCode: v }))}
                options={acctSubjects.map(a => ({ value: a.code, label: a.name, sub: `${a.code} · ${a.category}`, keywords: a.note || "" }))}
                placeholder={autoAcctName ? `자동: ${autoAcctName}` : "비목에 따라 자동 (직접 고를 수도 있어요)"}
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
                    // 과세유형 칩과 같은 이유로 입력 기준을 지킨다(공급가액 입력 모드 보존)
                    return applyTax(next, supplyMode ? next.supply : next.amount, supplyMode)
                  })
                }}
                options={categories.filter(c => c.id?.startsWith(kind === "income" ? "INC-" : "EXP-"))
                  .map(c => ({ value: c.name, label: c.name, sub: c.group_name || "" }))}
                placeholder={kind === "income" ? "수금 유형을 검색하거나 선택하세요" : "비목을 검색하거나 선택하세요"}
                onAddNew={async (q) => {
                  const nm = await quickAddCategory(q, {
                    kind: kind === "income" ? "inc" : "exp", setCategories, toast,
                  })
                  // 새 비목은 서버 기본값(과세 10%·공제 가능)으로 만들어진다.
                  // 그 값들을 폼에도 그대로 반영해 '고른 것'과 '만든 것'이 같게 동작하게 한다.
                  if (nm) setForm(f => applyTax({ ...f, category: nm, acctGroup: "", taxType: "과세", vatDeductible: true }, f.amount, false))
                }}
                addNewLabel={kind === "income" ? "수금 유형으로 등록" : "비목으로 등록"}/>
            </FormField>

            <FormField label="품목" hint="선택 · 고르면 적요·금액 자동 채움">
              {/* value 는 품목 id. 이름을 값으로 쓰면 규격만 다른 동명 품목(도면 개정 등)이
                  한 값으로 뭉개져 무엇을 골라도 첫 번째가 잡힌다 — 단가·과세유형까지 그 품목 것이 들어온다. */}
              <Combobox value={form.itemId || form.item}
                onChange={(v) => {
                  const it = items.find(x => String(x.id) === String(v))
                  setForm(f => {
                    const next = { ...f, item: it ? it.name : v, itemId: it?.id || "" }
                    if (it) {
                      if (!f.memo || f.memo === f.item) next.memo = it.name   // 적요 자동 채움(비어있거나 이전 품목명일 때만)
                      // 들어오는 돈은 출고가(amount), 나가는 돈은 매입가(purchase_price)가 맞는 단가다.
                      // 매입가가 없는 품목이면 종전대로 출고가로 채운다.
                      const unit = kind === 'expense' ? (Number(it.purchase_price) || Number(it.amount)) : Number(it.amount)
                      // 품목에 과세유형이 정해져 있으면 그것도 따라간다(기준정보 tax_type → 거래).
                      if (it.tax_type) next.taxType = it.tax_type
                      if (unit && !f.amount) {                                // 단가는 공급가액 — 총액 = 단가 + 부가세
                        Object.assign(next, applyTax(next, unit, true))
                      } else if (it.tax_type) {
                        // 금액은 그대로 두되, 바뀐 과세유형으로 공급가/세액을 다시 나눈다(면세로 바꿨는데 부가세가 남지 않게)
                        Object.assign(next, applyTax(next, next.amount, false))
                      }
                    }
                    return next
                  })
                }}
                options={items.map(it => {
                  const unit = kind === 'expense' ? (Number(it.purchase_price) || Number(it.amount)) : Number(it.amount)
                  return { value: it.id, label: it.name,
                    sub: [it.code, it.spec, it.unit, unit ? fmtNum(unit) + '원' : ''].filter(Boolean).join(' · ') }
                })}
                placeholder="품목 선택 (선택)"
                onAddNew={async (q) => {
                  const it = await quickAddRefItemWithId('item', q, { setList: setItems, toast, label: '품목' })
                  // 규격·단가는 아직 없으므로 적요·금액 자동 채움은 일어나지 않는다(그게 맞다).
                  // itemId 를 반드시 같이 채운다 — 안 채우면 이 거래에 품목이 연결되지 않는다.
                  if (it) setForm(f => ({ ...f, item: it.name, itemId: it.id }))
                }}
                addNewLabel="품목으로 등록"/>
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
                  /* 입력 기준(supplyMode)을 지켜서 재계산한다.
                     예전엔 항상 f.amount(VAT 포함 총액)를 넘겨서, '공급가액 입력' 모드에서
                     과세 100만(총액 110만) → 영세로 바꾸면 **공급가가 110만**이 됐다.
                     영세는 세액이 0이어도 공급가가 과세표준에 들어가므로 신고가 10% 부풀어진다. */
                  <button key={t} type="button" className={`chip ${form.taxType === t ? "active" : ""}`}
                    onClick={() => setForm(f => applyTax({ ...f, taxType: t }, supplyMode ? f.supply : f.amount, supplyMode))}>{t}</button>
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
                      onClick={() => setForm({ ...form, method: v, account: keepAccount(form.account, v, accounts) })}>
                      {v === "계좌이체" && <Icon.Bank size={12}/>}
                      {(v === "법인카드" || v === "개인카드") && <Icon.Card size={12}/>}
                      {v === "현금" && <Icon.Wallet size={12}/>}
                      {v}
                    </button>
                  ))}
                </div>
                {form.method === "계좌이체" && (
                  <div className="row gap-6" style={{ flexWrap: "wrap", marginTop: 8 }}>
                    {bankAccounts.map(a => (
                      <button key={a.id} type="button" className={`chip ${form.account === a.name ? "active" : ""}`}
                        onClick={() => setForm({...form, account: a.name})}>
                        <Icon.Bank size={12}/>{a.name}
                        {isMainAccount(a, company, use) && (
                          <span className="text-muted2" style={{ fontSize: 10, marginLeft: 3 }}>{MAIN_BADGE}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {/* 카드로 쓰면 그 카드 계정에 미결제가 쌓인다. 나중에 어디서 갚는지 그 자리에서
                    알려준다 — 안 알려주면 "그래서 이건 언제 통장에서 나가나"가 남는다
                    (실무자가 실제로 그렇게 물었다).
                    ⚠ **법인카드에도 뜬다.** 예전엔 개인카드에만 달아 뒀는데 거꾸로였다 —
                      법인카드가 오히려 회사가 갚는 것이 확실한 쪽이다.
                    ⚠ 가리키는 곳이 **'카드 대금 지급'** 이다. 예전엔 '계좌 이체'라고 적었는데
                      그 화면이 둘로 갈리면서 카드를 못 고르게 됐다 — 문구를 안 고쳤으면
                      안내대로 갔다가 막힌다. 화면 이름을 바꾸면 가리키는 글도 함께 옮겨야 한다. */}
                {(form.method === "법인카드" || form.method === "개인카드") && (
                  <div className="text-xs text-muted2" style={{ marginTop: 8, lineHeight: 1.7 }}>
                    이 카드에 미결제로 쌓여요. 나중에 갚을 때 <b>지급처리 › 카드 대금 지급</b>에서
                    통장 → 카드로 처리하시면 됩니다.
                  </div>
                )}
                {(form.method === "법인카드" || form.method === "개인카드") && (
                  <div className="row gap-6" style={{ flexWrap: "wrap", marginTop: 8 }}>
                    {cardAccounts.length === 0 ? (
                      <span className="text-xs text-muted2">등록된 카드가 없어요. 설정 → 계좌/카드에서 추가하세요.</span>
                    ) : cardAccounts.map(a => (
                      <button key={a.id} type="button" className={`chip ${form.account === a.name ? "active" : ""}`}
                        onClick={() => setForm({...form, account: a.name})}>
                        <Icon.Card size={12}/>{a.name}
                        {/* 왜 맨 앞인지 말해주지 않으면 "왜 순서가 이렇지"가 된다 */}
                        {isMainAccount(a, company, 'card') && (
                          <span className="text-muted2" style={{ fontSize: 10, marginLeft: 3 }}>{MAIN_BADGE}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {/* 현금 — **금고 시재**에서 나간다. 기준정보에서 종류 '현금'인 계정을 만들어 두면
                    여기서 고를 수 있고, 그러면 시재 잔액이 관리된다(회계의 현금 계정 1101).
                    ⚠ 시재를 안 세는 회사도 있다. 그런 회사는 계정을 안 만들면 되고,
                      계좌 없이 비용만 잡힌다(서버도 현금은 계좌 없이 통과시킨다). */}
                {form.method === "현금" && (
                  cashAccounts.length === 0 ? (
                    <div className="text-xs text-muted2" style={{ marginTop: 8, lineHeight: 1.7 }}>
                      금고 시재를 관리하시면 <b>기준정보 › 계좌</b>에서 종류를 <b>현금</b>으로 계정을
                      하나 만들어 주세요. 그러면 여기서 골라 시재 잔액이 관리됩니다.<br/>
                      안 만드셔도 됩니다 — 그때는 비용만 잡히고 통장 잔액은 움직이지 않아요.
                    </div>
                  ) : (
                    <div className="row gap-6" style={{ flexWrap: "wrap", marginTop: 8 }}>
                      {cashAccounts.map(a => (
                        <button key={a.id} type="button" className={`chip ${form.account === a.name ? "active" : ""}`}
                          onClick={() => setForm({...form, account: a.name})}>
                          <Icon.Wallet size={12}/>{a.name}
                        </button>
                      ))}
                      <button type="button" className={`chip ${!form.account ? "active" : ""}`}
                        onClick={() => setForm({...form, account: ""})}>지정 안 함</button>
                    </div>
                  )
                )}
                {form.method === "계좌이체" && counterpartyPicker("어디로 보냈나요?")}
              </FormField>
            ) : (
              <FormField label="입금 계좌" required>
                <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                  {bankAccounts.map(a => (
                    <button key={a.id} type="button" className={`chip ${form.account === a.name ? "active" : ""}`}
                      onClick={() => setForm({...form, account: a.name})}>
                      <Icon.Bank size={12}/>{a.name}
                      {isMainAccount(a, company, use) && (
                        <span className="text-muted2" style={{ fontSize: 10, marginLeft: 3 }}>{MAIN_BADGE}</span>
                      )}
                    </button>
                  ))}
                </div>
                {counterpartyPicker("어디서 들어왔나요?")}
              </FormField>
            )}

            {/* ⚠ 예전 hint 는 "월말 정산을 위해 지정하세요"였다. 그런데 **월말 정산은 없는
                기능**이다 — employee_id 를 저장만 하고 정산하는 코드가 어디에도 없다.
                화면이 있지도 않은 절차를 약속하면 사용자는 "지정해 뒀으니 나중에 정산되겠지"
                하고 넘어간다. 미구현보다 나쁘다. 하는 일을 그대로 적는다.
                직원이 사비로 쓴 돈은 갚을 때 그 지출을 등록하면 된다(따로 정산 절차가 없다). */}
            {/* ⚠ **법인카드가 빠져 있었다.** 개인카드·현금만 물어봤는데, 그건 방향이 거꾸로다.
                개인카드·현금은 직원이 사비로 쓴 것이라 갚아주면 끝난다. 법인카드는 **회사 돈을
                직원이 직접 쓰는 것**이라 누가 썼는지가 통제의 핵심인데, 정작 그때 안 물었다.
                (카드 대금 지급 화면의 사용 내역 표가 이 값을 보여준다.)

                칩이 아니라 Combobox 다 — 직원이 스무 명을 넘으면 칩이 화면을 덮는다.
                allowAdd 로 명부에 없는 사람도 적는다(퇴사자·알바·대표 가족이 실제로 쓴다). */}
            {kind === "expense" && ["법인카드", "개인카드", "현금"].includes(form.method) && (
              <FormField label="사용 직원"
                hint={form.method === "법인카드" ? "이 카드를 누가 썼는지 기록해 둡니다 (선택)" : "누가 썼는지 기록해 둡니다 (선택)"}>
                <Combobox
                  value={form.employee}
                  onChange={v => setForm({ ...form, employee: v })}
                  onAddNew={v => setForm({ ...form, employee: v })}
                  options={employees
                    .filter(e => e.status === "재직" || e.status === "수습")
                    .map(e => ({ value: e.name, label: e.name, sub: e.dept }))}
                  placeholder="직원 선택 · 직접 입력"/>
              </FormField>
            )}

            <FormField label={kind === "income" ? "입금일" : "지출일"} required>
              <DateInput className="input" max={localToday()} value={form.date} onChange={e => setForm({...form, date: e.target.value})}/>
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
                        <input className="input" value={form.project_no || ''} placeholder="예: PRJ-2026-01 / 231호선"
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
            <button className="btn primary" onClick={handleSave} disabled={busy}><Icon.Check size={14}/> {busy ? "저장 중…" : (editTxn ? "수정" : "등록")}</button>
          </div>
        </div>
    </Drawer>
  );
};
