import { useState, useEffect, useRef, useMemo, Fragment } from 'react'
import { Icon, fmtNum, useToast, useConfirm, StatusBadge, Drawer, Combobox, MoneyInput } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { DataTable } from '../lib/components/DataTable'
import { ImportWizard } from '../lib/components/ImportWizard'
import { RecurringCycles, useRecurringCycles, cycleSummaryByRule } from '../lib/components/RecurringCycles'
import { PaidIssueDrawer } from '../lib/components/PaidIssueDrawer'
import { normBizNo, normVendorName } from '../lib/normalize'
import { api, minuteOf } from '../lib/api'

const fmtDateLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const todayStr = () => fmtDateLocal(new Date())

/* (제거) nextRunDate — 정기 항목의 '다음 생성일'을 화면에서 다시 계산하던 함수.
 * 미래 회차만 돌려주는 탓에 등록일 하한(setup_date)·last_generated를 모르고, 그래서
 * 8·9월을 놓친 상태에서 10월에 열면 "다음 생성 10/13"만 보이고 놓친 2건이 감춰졌다.
 * 대체: 서버 pending(state 포함)을 그대로 쓰는 cycleSummaryByRule — 화면과 실제가 어긋날 수 없다. */

const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate()

/**
 * 정기 규칙의 '첫 회차 예정일' 미리보기 — 등록 폼에서 그 자리에서 보여준다.
 * 시작일이 2020년이어도 등록일(오늘) 이전 회차는 생성되지 않는다는 사실을,
 * 설명 문구가 아니라 결과로 알려주기 위한 것. 서버 dueDatesToGenerate와 같은 규칙이다
 * (시작일·앵커일·주기·말일 clamp + 등록일 하한).
 */
const firstCycleDate = (startDate, dayOfMonth, period) => {
  const [sy, sm] = String(startDate || '').split('-').map(Number)
  if (!sy || !sm) return null
  const anchor = Number(dayOfMonth) || 1
  const step = period === 'yearly' ? 12 : period === 'quarterly' ? 3 : 1
  const floor = todayStr()   // 등록일 하한 — 오늘 등록하므로 오늘이 하한
  for (let i = 0; i < 600; i++) {
    const abs = (sm - 1) + i * step
    const y = sy + Math.floor(abs / 12)
    const m = ((abs % 12) + 12) % 12
    const s = fmtDateLocal(new Date(y, m, Math.min(anchor, daysInMonth(y, m))))
    if (s < startDate) continue
    if (s < floor) continue
    return s
  }
  return null
}

const MASTER_DATA = {
  vendor: {
    label: "거래처",
    columns: ["상호명", "사업자번호", "대표자", "거래 유형", "담당자", "연락처"],
    rows: [],
  },
  account: {
    label: "계좌 / 카드",
    columns: ["유형", "은행/카드사", "계좌·카드번호", "별칭", "용도"],
    rows: [],
  },
  // (증빙유형 목업은 제거 — REF_CONFIGS.evidence_type 실 CRUD로 대체됨)
  user: {
    label: "사용자 / 결재선",
    columns: ["이름", "아이디", "권한", "상태"],
    grouped: false,
    rows: [],
  },
  department: {
    label: "부서",
    columns: ["부서명", "상위 부서", "부서장", "구성원", "상태"],
    rows: [],
  },
  position: {
    label: "직위",
    columns: ["직위명", "직급 단계", "결재 권한", "비고"],
    rows: [],
  },
  company: {
    label: "회사 정보",
    columns: ["항목", "값"],
    rows: [],
  },
  template: {
    label: "문서 양식",
    columns: ["양식명", "유형", "설명", "최근 수정"],
    rows: [],
  },
};

const MASTER_TABS = [
  // 거래 기준
  { id: "vendor",          label: "거래처" },
  { id: "accountSubject",  label: "계정과목", custom: true },
  { id: "category",        label: "비목" },
  { id: "jeokyo",          label: "적요", custom: true },
  { id: "evidence_type",   label: "증빙유형", custom: true },
  { id: "item",            label: "품목", custom: true },
  { id: "insurance",       label: "보험", custom: true },
  { id: "fixed_asset",     label: "고정자산", custom: true },
  { id: "intangible_asset",label: "무형자산", custom: true },
  // 재무 운영
  { id: "account",         label: "계좌/카드", custom: true },
  { id: "accountBalance",  label: "계좌 잔액", custom: true },
  { id: "recurringExpense",label: "정기 지출", custom: true },
  { id: "recurringInvoice",label: "정기 청구", custom: true },
  // 조직
  { id: "department",      label: "부서", custom: true },
  { id: "position",        label: "직위", custom: true },
  { id: "user",            label: "사용자" },
  { id: "approval",        label: "결재선", custom: true },
  // 기준 설정
  { id: "payrollItems",    label: "급여 항목", custom: true },
  { id: "employType",      label: "고용형태", custom: true },
  { id: "company",         label: "회사 정보", custom: true },
  { id: "template",        label: "문서 양식" },
  { id: "closing",         label: "월 마감", custom: true },
];

const TAB_BY_ID = Object.fromEntries(MASTER_TABS.map(t => [t.id, t]));

// 도메인별 기준정보 섹션 (App 라우트: master=base / settings / hr_base=hr)
const MASTER_SECTIONS = {
  base: {
    title: "기준정보",
    sub: "거래처·계정과목·계좌·품목·자산 등 회계 처리의 기준이 되는 정보를 관리합니다.",
    groups: [
      // 증빙유형: 목업이던 evidenceType 탭을 버리고 실제 CRUD(ref_items type='evidence_type')로 교체.
      { label: "거래 기준", tabs: ["vendor", "accountSubject", "category", "jeokyo", "evidence_type"] },
      { label: "품목·자산", tabs: ["item", "fixed_asset", "intangible_asset"] },
      { label: "자금·결제", tabs: ["account", "accountBalance", "insurance"] },
      // 정기청구/정기지출은 기준정보(정적 참조)가 아니라 계약에서 파생되는 흐름이라 여기서 제거.
      // → 회계처리로 재배치 완료: 정기청구=판매·매출(route recurring_invoice), 정기지출=경비(route recurring_expense).
      //   패널은 이 파일에서 export해 App이 page 모드로 렌더한다.
    ],
  },
  settings: {
    title: "환경설정",
    sub: "회사 정보·사용자·결재선·장부 마감을 관리합니다.",
    groups: [
      // '문서 양식'(template)은 목업이라 제외. 실동작 항목만.
      { label: "회사", tabs: ["company"] },
      { label: "시스템", tabs: ["user", "approval"] },
      { label: "장부 마감", tabs: ["closing"] },
    ],
  },
  hr: {
    title: "인사급여 기준정보",
    sub: "부서·직위 등 조직 코드와 급여 항목을 관리합니다.",
    groups: [
      { label: "조직", tabs: ["department", "position"] },
      { label: "급여", tabs: ["payrollItems"] },
      { label: "근로·용역", tabs: ["employType"] },
    ],
  },
};

// ── F-1: 거래처 패널 ────────────────────────────────────────────────
const GUBU_LABEL = { B: '발주처', A: '매입처/외주', E: '기관' }
const GUBU_OPTS  = [{ value: 'B', label: '발주처 (수금)' }, { value: 'A', label: '매입처/외주 (지급)' }, { value: 'E', label: '기관' }]

const HrCodePanel = ({ type, label, embedded = false }) => {
  const toast = useToast()
  const [items, setItems] = useState([])
  const [newName, setNewName] = useState("")

  const load = () => api.getHrCodes(type).then(setItems)
  useEffect(() => { load() }, [type])

  const handleAdd = async () => {
    const name = newName.trim()
    if (!name) return toast.push(`${label}명을 입력하세요`)
    if (items.some(i => i.name === name)) return toast.push("이미 있는 항목이에요")
    const res = await api.addHrCode(type, name)
    if (res.ok) { setNewName(""); load(); toast.push(`"${name}" 등록됐어요`) }
    else toast.push("저장 실패", { tone: 'warn' })
  }

  const handleDelete = async (item) => {
    await api.deleteHrCode(item.id)
    toast.push(`"${item.name}" 삭제됐어요`)
    load()
  }

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16 }}>
        {embedded ? (
          <div className="section-sub" style={{ alignSelf: 'center' }}>총 {items.length}개</div>
        ) : (
          <div>
            <div className="section-title">{label} 관리</div>
            <div className="section-sub">총 {items.length}개</div>
          </div>
        )}
      </div>
      <div className="row gap-8" style={{ marginBottom: 16 }}>
        <input
          className="input" style={{ flex: 1 }}
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleAdd()}
          placeholder={`새 ${label}명 입력`}/>
        <button className="btn primary" onClick={handleAdd}><Icon.Plus size={14}/> 추가</button>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>{label}명</th>
              <th style={{ width: 80 }}></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={2} style={{ textAlign: "center", padding: 32, color: "var(--muted-2)", fontSize: 13 }}>
                등록된 {label}이 없어요. 위에서 추가하세요.
              </td></tr>
            )}
            {items.map(item => (
              <tr key={item.id}>
                <td className="fw-600">{item.name}</td>
                <td>
                  <button className="btn" style={{ fontSize: 11, padding: "2px 8px", color: "var(--neg)" }}
                    onClick={() => handleDelete(item)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 기준정보 범용 패널 (적요·품목·보험·고정자산·무형자산·근로계약·기타용역) ──
// 품목유형: 매출 품목(제품·상품·서비스)과 매입 품목(원재료·부재료)의 성격 구분.
// 업종중립 — 제조든 SW든 같은 축으로 쓴다(SW 개발=서비스, 라이선스 재판매=상품).
export const ITEM_KINDS = ['제품', '상품', '서비스', '원재료', '부재료']
// 영세 = 세율 0%인 과세거래(수출·해외용역). 면세(과세표준 제외)와 다르므로 반드시 구분한다.
export const TAX_TYPES = ['과세', '면세', '영세']

export const REF_CONFIGS = {
  jeokyo: {
    type: 'jeokyo', label: '적요',
    sub: '거래 입력 시 자주 쓰는 적요(내용) 문구를 등록해두면 빠르게 선택할 수 있어요.',
    fields: [
      { key: 'name', label: '적요', kind: 'text', req: true },
      { key: 'memo', label: '비고', kind: 'text' },
    ],
  },
  item: {
    type: 'item', label: '품목',
    sub: '거래·계약·청구에 쓰는 품목을 관리합니다. 매입가·출고가를 넣으면 마진이 자동으로 잡혀요.',
    fields: [
      { key: 'code', label: '품목코드', kind: 'text', w: 110 },
      { key: 'name', label: '품명', kind: 'text', req: true },
      { key: 'item_kind', label: '유형', kind: 'select', options: ITEM_KINDS, w: 82,
        hint: '팔 것(제품·상품·서비스) / 살 것(원재료·부재료)' },
      { key: 'item_group', label: '분류', kind: 'text', w: 110, hint: '품목을 묶는 이름 (예: 웹서비스, 가공품)' },
      { key: 'spec', label: '규격', kind: 'text' },
      { key: 'unit', label: '단위', kind: 'text', w: 70 },
      { key: 'purchase_price', label: '매입가', kind: 'num', w: 110, hint: '원가 — 외주·자재 매입 단가' },
      { key: 'amount', label: '출고가', kind: 'num', w: 110, hint: '판매 단가 — 계약·청구서에 자동으로 채워져요' },
      { key: 'margin', label: '마진', kind: 'num', w: 100, calc: r => (Number(r.amount) || 0) - (Number(r.purchase_price) || 0) },
      { key: 'tax_type', label: '과세', kind: 'select', options: TAX_TYPES, w: 76,
        hint: '비워두면 비목의 부가세 설정을 따라갑니다' },
    ],
  },
  evidence_type: {
    type: 'evidence_type', label: '증빙유형',
    sub: '거래에 붙이는 증빙의 종류입니다. 매입세액 공제는 적격증빙(세금계산서·카드전표·지출증빙 현금영수증)이 있어야 받아요.',
    fields: [
      { key: 'name', label: '증빙유형', kind: 'text', req: true },
      { key: 'deductible', label: '매입세액', kind: 'flag', def: 1, w: 120,
        options: [[1, '공제 가능'], [0, '공제 불가']],
        hint: '공제 불가로 두면 이 증빙을 붙인 지출이 부가세 매입세액 집계에서 빠져요' },
      { key: 'memo', label: '설명', kind: 'text' },
    ],
  },
  insurance: {
    type: 'insurance', label: '보험',
    sub: '가입 보험 등록·관리 대장.',
    fields: [
      // 보험은 성격이 갈린다 — 정기납입(화재·자동차·배상책임) / 계약보증(보증보험) / 저축성. 먼저 구분해 등록.
      // 저장은 ref_items.item_kind 컬럼 재사용(보험 행에선 이 컬럼이 비어 있어 품목 로직과 안 겹친다) → 서버/DB 변경 불필요.
      { key: 'item_kind', label: '구분', kind: 'select', w: 96,
        options: ['화재·재산', '자동차', '배상책임', '보증보험', '저축성·연금', '기타'] },
      { key: 'name', label: '보험명', kind: 'text', req: true },
      { key: 'party', label: '보험사', kind: 'text', w: 110 },
      { key: 'code', label: '증권번호', kind: 'text', w: 130 },
      { key: 'amount', label: '보험료', kind: 'num', w: 110 },
      { key: 'period', label: '납입주기', kind: 'select', options: ['일시납', '월납', '분기납', '연납'], w: 84 },
      { key: 'pay_day', label: '납입일', kind: 'num', w: 70, hint: '매월/납기 일자 (1~31)' },
      { key: 'start_date', label: '시작일', kind: 'date', w: 130, hideCol: true },
      { key: 'end_date', label: '만기일', kind: 'date', w: 120 },
      { key: 'account_id', label: '자동이체 계좌', kind: 'account', hideCol: true },
      // 자유 메모 — 보증보험이면 보증종류·귀속계약·보증금액 등 유형별 특수정보를 여기에.
      { key: 'memo', label: '비고', kind: 'text', hideCol: true,
        hint: '보증보험이면 보증종류·귀속계약·보증금액 등을 자유롭게 적어두세요' },
      { key: 'file', label: '증권 첨부', kind: 'file', hideCol: true },
    ],
  },
  fixed_asset: {
    type: 'fixed_asset', label: '고정자산',
    sub: '유형 고정자산(자산번호·취득가액·취득일)을 관리합니다.',
    fields: [
      { key: 'code', label: '자산번호', kind: 'text', w: 120 },
      { key: 'name', label: '자산명', kind: 'text', req: true },
      { key: 'amount', label: '취득가액', kind: 'num', w: 130 },
      { key: 'start_date', label: '취득일', kind: 'date', w: 130 },
      { key: 'memo', label: '비고', kind: 'text' },
    ],
  },
  intangible_asset: {
    type: 'intangible_asset', label: '무형자산',
    sub: '무형자산(소프트웨어·특허 등)을 관리합니다.',
    fields: [
      { key: 'code', label: '자산번호', kind: 'text', w: 120 },
      { key: 'name', label: '자산명', kind: 'text', req: true },
      { key: 'amount', label: '취득가액', kind: 'num', w: 130 },
      { key: 'start_date', label: '취득일', kind: 'date', w: 130 },
      { key: 'memo', label: '비고', kind: 'text' },
    ],
  },
  // labor_contract·outsourcing은 실화면(WorkContract.jsx)으로 대체됨 — ref 목록 패널 제거.
}

// calc 필드(마진 등)는 표에만 나오는 계산값 — 저장하지 않으므로 폼에서 제외한다.
const editableFields = (fields) => fields.filter(fd => !fd.calc)

const emptyRefForm = (fields) => {
  const o = {}
  for (const fd of editableFields(fields)) {
    if (fd.kind === 'file') { o.file_url = ''; o.file_name = '' }
    else if (fd.kind === 'flag') o[fd.key] = fd.def ?? 1
    else o[fd.key] = ''
  }
  return o
}
const rowToForm = (fields, r) => {
  const o = {}
  for (const fd of editableFields(fields)) {
    if (fd.kind === 'file') { o.file_url = r.file_url ?? ''; o.file_name = r.file_name ?? '' }
    else if (fd.kind === 'flag') o[fd.key] = r[fd.key] == null ? (fd.def ?? 1) : Number(r[fd.key])
    else o[fd.key] = r[fd.key] ?? ''
  }
  return o
}

// 증권 등 단일 파일 첨부 위젯
const RefFileField = ({ url, name, uploading, onUpload, onRemove }) => {
  const inputRef = useRef(null)
  if (url) return (
    <div className="row gap-10" style={{ padding: '10px 14px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-2)' }}>
      <Icon.Receipt size={16} style={{ color: 'var(--brand)', flexShrink: 0 }}/>
      <span className="text-sm fw-600" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || url}</span>
      <button type="button" className="icon-btn" onClick={onRemove}><Icon.Close size={14}/></button>
    </div>
  )
  return (
    <div className="drop" style={{ padding: 14, cursor: 'pointer', opacity: uploading ? 0.6 : 1 }} onClick={() => inputRef.current?.click()}>
      <input ref={inputRef} type="file" style={{ display: 'none' }} accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.hwp" onChange={e => onUpload(e.target.files[0])}/>
      <Icon.Upload size={16}/>
      <div className="text-sm fw-600" style={{ marginTop: 4 }}>{uploading ? '업로드 중...' : '파일 첨부 (클릭)'}</div>
      <div className="text-xs text-muted2" style={{ marginTop: 2 }}>PDF, 이미지 등 · 최대 20MB</div>
    </div>
  )
}

// page=true 면 도메인 독립 화면(페이지 타이틀), 아니면 기준정보 서브패널
export const RefMasterPanel = ({ cfg, page = false, embedded = false }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState([])
  const [q, setQ] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyRefForm(cfg.fields))
  const [accounts, setAccounts] = useState([])
  const [uploading, setUploading] = useState(false)
  const [importing, setImporting] = useState(false)

  const load = () => api.getRefItems(cfg.type).then(setRows)
  useEffect(() => { load() }, [cfg.type])
  // 탭을 옮기면 업로드 화면은 닫는다(품목에서 열어두고 자산 탭으로 가면 엉뚱한 양식이 남는다)
  useEffect(() => { setImporting(false) }, [cfg.type])
  const canImport = IMPORTABLE_REF_TYPES.has(cfg.type)
  const adapter = useMemo(() => (canImport ? refImportAdapter(cfg) : null), [cfg.type])
  useEffect(() => {
    if (cfg.fields.some(fd => fd.kind === 'account')) api.getAccounts().then(list => setAccounts(list.filter(a => a.kind !== 'card')))
  }, [cfg.type])

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const filtered = rows.filter(r => !q || cfg.fields.some(fd => String(r[fd.key] ?? '').includes(q)))
  const visibleFields = cfg.fields.filter(fd => !fd.hideCol)

  const openNew = () => { setEditing(null); setForm(emptyRefForm(cfg.fields)); setDrawerOpen(true) }
  const openEdit = (r) => { setEditing(r); setForm(rowToForm(cfg.fields, r)); setDrawerOpen(true) }

  const handleUpload = async (file) => {
    if (!file) return
    setUploading(true)
    const res = await api.uploadFile(file)
    setUploading(false)
    if (res.url) setForm(p => ({ ...p, file_url: res.url, file_name: res.originalName || file.name }))
    else toast.push('파일 업로드에 실패했어요', { tone: 'warn' })
  }
  const handleSave = async () => {
    const reqField = cfg.fields.find(fd => fd.req)
    if (reqField && !String(form[reqField.key] ?? '').trim()) return toast.push(`${reqField.label}을(를) 입력하세요`)
    // 코드(품번·자산번호 등) 중복 방지 — 같은 종류 안에서 같은 코드 재사용 금지
    const codeField = cfg.fields.find(fd => fd.key === 'code')
    if (codeField) {
      const code = String(form.code ?? '').trim()
      if (code && rows.some(r => r.id !== editing?.id && String(r.code ?? '').trim() === code))
        return toast.push(`이미 쓰고 있는 ${codeField.label}예요: ${code}`)
    }
    const res = editing ? await api.updateRefItem(editing.id, form) : await api.addRefItem({ type: cfg.type, ...form })
    if (!res.ok) return toast.push(res.error || '저장 실패', { tone: 'warn' })
    toast.push(editing ? '수정됐어요' : '등록됐어요')
    setDrawerOpen(false); load()
  }
  const handleDelete = async (r) => {
    const ok = await confirm({ tone: 'warn', icon: <Icon.Warn size={22}/>, title: `${r.name} 삭제`, body: '이 항목을 삭제할까요?', confirmLabel: '삭제' })
    if (!ok) return
    await api.deleteRefItem(r.id); toast.push('삭제됐어요'); load()
  }

  const cell = (fd, r) => {
    if (fd.calc) {
      const v = fd.calc(r)
      if (v == null) return '—'
      if (fd.kind !== 'num') return v
      // 역마진(매입가 > 출고가)은 눈에 띄어야 한다
      return <span style={v < 0 ? { color: 'var(--neg-ink)' } : undefined}>{fmtNum(v)}</span>
    }
    if (fd.kind === 'flag') {
      const hit = fd.options.find(([v]) => Number(r[fd.key] ?? fd.def ?? 1) === v)
      return <span className={`badge ${Number(r[fd.key] ?? fd.def ?? 1) ? 'brand' : 'outline'}`}>{hit ? hit[1] : '—'}</span>
    }
    const val = r[fd.key]
    if (val == null || val === '') return '—'
    if (fd.kind === 'num') return fmtNum(val)
    if (fd.kind === 'account') return accounts.find(a => a.id === val)?.name || '—'
    return val
  }

  if (importing && adapter) return (
    <ImportWizard
      adapter={adapter}
      existing={rows}
      onCancel={() => setImporting(false)}
      onDone={() => { setImporting(false); load() }}/>
  )

  return (
    <div className={page ? 'fade-up' : undefined} style={page ? undefined : { padding: 20 }}>
      <div className="row" style={{ marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
        {/* 사이드 서브메뉴로 단독 진입(embedded)하면 상단 PageHeader가 이미 제목을 보여준다 → 중복 제목·문구 숨기고 건수만 */}
        {embedded ? (
          <div className="section-sub" style={{ alignSelf: 'center' }}>총 {rows.length}건</div>
        ) : (
          <div>
            <div className={page ? 'page-title' : 'section-title'}>{cfg.label}</div>
            {cfg.sub && <div className={page ? 'page-sub' : 'section-sub'}>{cfg.sub} · 총 {rows.length}건</div>}
          </div>
        )}
        <div className="search" style={{ margin: 0, marginLeft: 'auto', width: 200, padding: '6px 10px' }}>
          <Icon.Search size={14}/>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={`${cfg.label} 검색`}/>
        </div>
        {canImport && <button className="btn excel" onClick={() => setImporting(true)}><Icon.Excel/> 엑셀 업로드</button>}
        <button className="btn primary" onClick={openNew}><Icon.Plus size={14}/> {cfg.label} 등록</button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <DataTable
          columns={[
            ...visibleFields.map((fd, i) => ({
              key: fd.key,
              header: fd.label,
              width: fd.w,
              align: fd.kind === 'num' ? 'right' : undefined,
              sortable: true,
              // 표시값과 정렬값이 다른 열은 정렬 기준을 따로 준다(계산열=계산결과, 계좌=계좌명)
              sortValue: fd.calc ? (r => fd.calc(r))
                : fd.kind === 'account' ? (r => accounts.find(a => a.id === r[fd.key])?.name || '')
                : undefined,
              className: fd.kind === 'num' ? 'num-cell' : (i === 0 ? 'fw-600' : 'text-sm'),
              render: (r) => (
                <span style={{ color: (r[fd.key] == null || r[fd.key] === '') && !fd.calc && fd.kind !== 'flag' ? 'var(--muted-2)' : undefined }}>
                  {i === 0 && r.file_url && <Icon.Receipt size={12} style={{ marginRight: 4, color: 'var(--brand)', verticalAlign: -1 }}/>}
                  {cell(fd, r)}
                </span>
              ),
            })),
            {
              key: '__actions', header: '', width: 90,
              render: (r) => (
                <div className="row gap-6">
                  <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => openEdit(r)}>수정</button>
                  <button className="btn" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--neg)' }} onClick={() => handleDelete(r)}>삭제</button>
                </div>
              ),
            },
          ]}
          rows={filtered}
          rowKey={r => r.id}
          empty={`등록된 ${cfg.label}이(가) 없어요. 위에서 추가하세요.`}
        />
      </div>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <DrawerHead title={editing ? `${cfg.label} 수정` : `${cfg.label} 등록`} onClose={() => setDrawerOpen(false)}/>
        <div className="drawer-body col gap-form">
          {editableFields(cfg.fields).map(fd => (
            <div key={fd.key}>
              <label className="label" style={{ marginBottom: 8 }}>
                {fd.label} {fd.req && <span style={{ color: 'var(--neg-ink)' }}>*</span>}
                {fd.hint && <span className="text-muted2" style={{ fontWeight: 400, marginLeft: 6, fontSize: 12 }}>· {fd.hint}</span>}
              </label>
              {fd.kind === 'select' ? (
                // 선택 항목이라 고른 칩을 다시 누르면 해제된다(과세유형처럼 '비워두기'가 뜻을 갖는 필드가 있다)
                <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                  {fd.options.map(o => (
                    <button key={o} type="button" className={`chip ${form[fd.key] === o ? 'active' : ''}`}
                      onClick={() => f(fd.key, form[fd.key] === o ? '' : o)}>{o}</button>
                  ))}
                </div>
              ) : fd.kind === 'flag' ? (
                <div className="row gap-6">
                  {fd.options.map(([v, label]) => (
                    <button key={label} type="button" className={`chip ${Number(form[fd.key]) === v ? 'active' : ''}`}
                      onClick={() => f(fd.key, v)}>{label}</button>
                  ))}
                </div>
              ) : fd.kind === 'account' ? (
                <Combobox value={form[fd.key]} onChange={v => f(fd.key, v)} allowAdd={false}
                  options={[{ value: '', label: '선택 안 함' }, ...accounts.map(a => ({ value: a.id, label: a.name }))]}
                  placeholder="자동이체 계좌 선택"/>
              ) : fd.kind === 'file' ? (
                <RefFileField url={form.file_url} name={form.file_name} uploading={uploading}
                  onUpload={handleUpload} onRemove={() => setForm(p => ({ ...p, file_url: '', file_name: '' }))}/>
              ) : (
                <input
                  className={`input ${fd.kind === 'num' ? 'num' : ''}`}
                  type={fd.kind === 'date' ? 'date' : 'text'}
                  value={fd.kind === 'num' ? (form[fd.key] === '' || form[fd.key] == null ? '' : fmtNum(form[fd.key])) : (form[fd.key] ?? '')}
                  onChange={e => f(fd.key, fd.kind === 'num' ? (parseInt(e.target.value.replace(/[^0-9-]/g, ''), 10) || 0) : e.target.value)}
                  placeholder={fd.label}/>
              )}
            </div>
          ))}
        </div>
        <DrawerFooter onCancel={() => setDrawerOpen(false)} onSave={handleSave}/>
      </Drawer>
    </div>
  )
}

// ── 엑셀 업로드 어댑터 ────────────────────────────────────────────
// 마법사 UI(파일→매핑→중복검토→등록)는 lib/components/ImportWizard.jsx 공용이고,
// 여기엔 "무엇을 어떤 키로 중복 판정하느냐"만 둔다. 임포트 대상이 늘면 어댑터만 추가.

const normGubu = (v) => {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (/기관|금융|은행|관공|공공|정부|카드사|^e$/i.test(s)) return 'E'
  if (/매입|외주|자재|원자재|협력|하청|구매|^a$/i.test(s)) return 'A'
  if (/발주|매출|수금|고객|판매|^b$/i.test(s)) return 'B'
  return null
}

const guessVendorTarget = (h) => {
  const s = String(h).replace(/\s/g, '')
  if (/사업자|등록번호|biz/i.test(s)) return "사업자번호"
  if (/구분|gubu/i.test(s)) return "거래구분"
  if (/유형|업종|type|category/i.test(s)) return "거래유형"
  if (/대표|ceo|사장/i.test(s)) return "대표자"
  if (/담당|contact/i.test(s)) return "담당자"
  if (/팩스|fax/i.test(s)) return "팩스"
  if (/이메일|메일|mail/i.test(s)) return "이메일"
  if (/주소|소재지|address/i.test(s)) return "주소"
  if (/전화|연락처|휴대|tel|phone|hp/i.test(s)) return "전화"
  if (/상호|거래처|업체|공급|회사|거래선|vendor|name/i.test(s)) return "상호명"
  return "사용 안함"
}

const vendorImportAdapter = {
  label: '거래처',
  title: '거래처 엑셀 업로드',
  sub: '거래처 목록을 엑셀(.xlsx)·CSV로 한 번에 등록하세요. 이미 있는 거래처는 중복 판정 후 건너뛰거나 덮어쓸 수 있어요.',
  templateUrl: '/api/vendors/import/template',
  templateName: '거래처_업로드_양식.xlsx',
  targets: ["상호명", "거래구분", "거래유형", "사업자번호", "대표자", "담당자", "전화", "팩스", "이메일", "주소"],
  requiredTarget: '상호명',
  requiredHelp: '상호명이 없으면 거래처를 등록할 수 없어요.',
  guess: guessVendorTarget,
  parse: (file) => api.parseVendorExcel(file),
  commit: (items) => api.commitVendorImport(items),

  initialOpts: { defaultGubu: 'A' },
  renderOpts: (opts, patch) => (
    <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="text-sm fw-600">기본 거래구분</span>
      <span className="text-xs text-muted2">‘거래구분’ 컬럼을 매핑하면 그 값이 우선해요</span>
      <div className="row gap-6 ml-auto">
        {GUBU_OPTS.map(o => (
          <button key={o.value} className={`chip ${opts.defaultGubu === o.value ? 'active' : ''}`}
            onClick={() => patch({ defaultGubu: o.value })}>{GUBU_LABEL[o.value]}</button>
        ))}
      </div>
    </div>
  ),

  mapRow: (g, opts) => ({
    name: g('상호명'), gubu: normGubu(g('거래구분')) || opts.defaultGubu,
    biz_no: g('사업자번호'), type: g('거래유형'), ceo: g('대표자'),
    contact: g('담당자'), phone: g('전화'), fax: g('팩스'), email: g('이메일'), address: g('주소'),
  }),
  isValid: (d) => !!String(d.name || '').trim(),
  matchKey: (d) => normBizNo(d.biz_no) || normVendorName(d.name),
  buildIndex: (existing) => {
    const byBiz = new Map(), byName = new Map(), byNorm = new Map()
    for (const v of existing) {
      const b = normBizNo(v.biz_no); if (b) byBiz.set(b, v)
      const nm = String(v.name || '').trim(); if (nm && !byName.has(nm)) byName.set(nm, v)
      const nn = normVendorName(v.name); if (nn) { if (!byNorm.has(nn)) byNorm.set(nn, []); byNorm.get(nn).push(v) }
    }
    return { byBiz, byName, byNorm }
  },
  findMatch: (d, idx) => {
    const bizN = normBizNo(d.biz_no)
    const matched = (bizN && idx.byBiz.get(bizN)) || idx.byName.get(String(d.name || '').trim()) || null
    return { matched, candidates: matched ? [] : (idx.byNorm.get(normVendorName(d.name)) || []) }
  },
  candidateLabel: (c) => ({ label: c.name, sub: c.biz_no || GUBU_LABEL[c.gubu] || '' }),
  // 거래구분을 못 읽으면 기본 구분으로 들어간다 — 조용히 넘기지 않고 행에 표시한다
  rowWarns: (d, g) => {
    const raw = g('거래구분')
    return raw && !normGubu(raw) ? [`거래구분 ‘${raw}’을(를) 못 알아봤어요 — 기본 구분으로 등록됩니다`] : []
  },
  previewCols: [
    { header: '상호명', className: 'fw-600', render: (d) => d.name || <span className="text-neg">—</span> },
    { header: '구분', width: 64, render: (d) => <span className="badge outline" style={{ fontSize: 10 }}>{GUBU_LABEL[d.gubu]}</span> },
    { header: '사업자번호', className: 'num text-sm text-muted', render: (d) => d.biz_no || '—' },
    { header: '대표자', className: 'text-sm', render: (d) => d.ceo || '—' },
    { header: '연락처', className: 'text-sm text-muted', render: (d) => d.contact || d.phone || '—' },
  ],
  dupHelp: (
    <>사업자번호가 같으면 <b>중복</b>, 상호가 똑같아도 <b>중복</b>이에요. 법인격·띄어쓰기만 다른 비슷한 상호는 <b>확인 필요</b>로 표시하니, 처리 칸에서 맞는 거래처를 골라 덮어쓰세요. 미등록 거래처는 <b>신규</b>로 등록됩니다.</>
  ),
}

// ── 기준정보(품목·자산·적요) 엑셀 업로드 ──────────────────────────
// 보험·증빙유형은 첨부파일·계좌 칸이 있어 엑셀 한 장으로 못 채운다 → 제외(서버 허용 목록과 일치).
export const IMPORTABLE_REF_TYPES = new Set(['item', 'fixed_asset', 'intangible_asset', 'jeokyo'])

// 엑셀 머리글 → 우리 필드 추측. 위에 있는 것부터 검사하므로 순서가 곧 우선순위다
// ('매입단가'가 '단가'(출고가)로 잘못 잡히지 않도록 purchase_price를 amount보다 앞에 둔다).
const REF_HEADER_HINTS = [
  ['purchase_price', /매입가|매입단가|매입금액|원가|구매가|purchase|cost/i],
  ['amount',         /출고가|판매가|공급가|취득가|취득가액|단가|금액|price|amount/i],
  ['code',           /품목코드|품번|품목번호|자산번호|자산코드|코드|code/i],
  ['item_kind',      /유형|종류|품목구분|kind/i],
  ['item_group',     /분류|그룹|카테고리|계열|group|category/i],
  ['spec',           /규격|사양|모델|스펙|spec|model/i],
  ['unit',           /단위|unit/i],
  ['start_date',     /취득일|시작일|등록일|일자|date/i],
  ['end_date',       /만기|종료일|폐기일/i],
  ['name',           /품명|품목명|자산명|적요|명칭|이름|내용|name|item/i],
  ['memo',           /비고|메모|설명|note|memo|remark/i],
]

// 선택 항목(칩)은 엑셀에 별별 표기로 온다. 못 알아본 값은 기본값을 밀어넣지 않고 비운다 —
// 특히 과세구분을 잘못 채우면 부가세 신고가 조용히 틀어진다(비우면 비목 설정을 따라감).
const REF_SELECT_SYNONYMS = {
  item_kind: [
    [/부재료|부자재|소모품/, '부재료'],
    [/원재료|원자재|자재|재료|매입품/, '원재료'],
    [/서비스|용역|외주|임가공|가공비|수리|개발|유지보수|구축|라이선스|licen/i, '서비스'],
    [/상품|재판매|사입/, '상품'],
    [/제품|완제품|반제품|생산품/, '제품'],
  ],
  tax_type: [
    [/영세/, '영세'],
    [/면세|비과세/, '면세'],
    [/과세|부가세|10\s*%/, '과세'],
  ],
}

const normRefText = (v) => String(v ?? '').replace(/[\s()\-.,·\/]/g, '').toLowerCase()
// 미리보기 표에 띄울 칸 (안 정한 종류는 앞 4칸)
const REF_PREVIEW_KEYS = {
  item: ['code', 'name', 'item_kind', 'spec', 'purchase_price', 'amount', 'tax_type'],
  fixed_asset: ['code', 'name', 'amount', 'start_date'],
  intangible_asset: ['code', 'name', 'amount', 'start_date'],
  jeokyo: ['name', 'memo'],
}

export const refImportAdapter = (cfg) => {
  // 파일 첨부·계좌 선택은 엑셀로 못 받는다
  const fields = editableFields(cfg.fields).filter(fd => fd.kind !== 'file' && fd.kind !== 'account')
  const byKey = new Map(fields.map(fd => [fd.key, fd]))
  const reqField = fields.find(fd => fd.req) || fields[0]
  const codeField = byKey.get('code')

  const normSelect = (fd, raw) => {
    const s = String(raw ?? '').trim()
    if (!s) return ''
    const exact = fd.options.find(o => normRefText(o) === normRefText(s))
    if (exact) return exact
    for (const [re, val] of (REF_SELECT_SYNONYMS[fd.key] || [])) if (re.test(s)) return val
    return ''
  }
  // 품목코드가 있으면 그게 키, 없으면 품명＋규격 (ref_items.code엔 UNIQUE가 없어 앱에서 판정한다)
  const keyOf = (d) => {
    const code = String(d.code ?? '').trim().toLowerCase()
    if (code) return 'c:' + code
    return 'n:' + normRefText(d.name) + '|' + normRefText(d.spec)
  }

  return {
    label: cfg.label,
    title: `${cfg.label} 엑셀 업로드`,
    sub: `${cfg.label} 목록을 엑셀(.xlsx)·CSV로 한 번에 등록하세요. 이미 있는 항목은 중복 판정 후 건너뛰거나 덮어쓸 수 있어요.`,
    templateUrl: `/api/ref-items/import/template?type=${cfg.type}`,
    templateName: `${cfg.label}_업로드_양식.xlsx`,
    targets: fields.map(fd => fd.label),
    requiredTarget: reqField.label,
    requiredHelp: `${reqField.label}이(가) 없으면 ${cfg.label}을(를) 등록할 수 없어요.`,
    parse: (file) => api.parseRefItemExcel(file),
    commit: (items) => api.commitRefItemImport(cfg.type, items),

    guess: (h) => {
      const s = String(h).replace(/\s/g, '')
      const exact = fields.find(fd => normRefText(fd.label) === normRefText(s))
      if (exact) return exact.label
      for (const [key, re] of REF_HEADER_HINTS) {
        if (byKey.has(key) && re.test(s)) return byKey.get(key).label
      }
      return '사용 안함'
    },

    mapRow: (g) => {
      const d = {}
      for (const fd of fields) {
        const raw = g(fd.label)
        if (fd.kind === 'select') d[fd.key] = normSelect(fd, raw)
        // 금액은 '1,200원'·'₩1,200'처럼 와도 숫자만 남긴다. 빈 칸은 빈 채로 둬야
        // 덮어쓰기 때 기존 단가가 0으로 지워지지 않는다(서버가 빈 칸=유지로 처리).
        else if (fd.kind === 'num') d[fd.key] = raw === '' ? '' : String(parseInt(raw.replace(/[^0-9-]/g, ''), 10) || 0)
        else d[fd.key] = raw
      }
      return d
    },
    isValid: (d) => !!String(d[reqField.key] || '').trim(),
    matchKey: keyOf,
    buildIndex: (existing) => {
      const byCode = new Map(), byKeyMap = new Map(), byName = new Map()
      for (const r of existing) {
        const code = String(r.code ?? '').trim().toLowerCase()
        if (code && !byCode.has(code)) byCode.set(code, r)
        const k = 'n:' + normRefText(r.name) + '|' + normRefText(r.spec)
        if (!byKeyMap.has(k)) byKeyMap.set(k, r)
        const nn = normRefText(r.name)
        if (nn) { if (!byName.has(nn)) byName.set(nn, []); byName.get(nn).push(r) }
      }
      return { byCode, byKeyMap, byName }
    },
    findMatch: (d, idx) => {
      const code = String(d.code ?? '').trim().toLowerCase()
      const matched = (code && idx.byCode.get(code))
        || idx.byKeyMap.get('n:' + normRefText(d.name) + '|' + normRefText(d.spec))
        || null
      // 이름은 같은데 규격이 다르면 별개 품목일 수도, 규격만 빠뜨린 같은 품목일 수도 있다 → 사람이 고른다
      return { matched, candidates: matched ? [] : (idx.byName.get(normRefText(d.name)) || []) }
    },
    candidateLabel: (c) => ({ label: c.name, sub: [c.code, c.spec].filter(Boolean).join(' · ') }),
    rowWarns: (d, g) => {
      const w = []
      for (const fd of fields) {
        if (fd.kind !== 'select') continue
        const raw = g(fd.label)
        if (raw && !d[fd.key]) {
          w.push(`${fd.label} ‘${raw}’을(를) 못 알아봤어요 — 비워둔 채 등록됩니다`
            + (fd.key === 'tax_type' ? ' (비목의 부가세 설정을 따라가요)' : ''))
        }
      }
      return w
    },
    previewCols: (REF_PREVIEW_KEYS[cfg.type] || fields.slice(0, 4).map(fd => fd.key))
      .filter(k => byKey.has(k))
      .map(k => {
        const fd = byKey.get(k)
        return {
          header: fd.label,
          width: fd.w,
          className: fd.kind === 'num' ? 'num text-sm' : (fd.key === reqField.key ? 'fw-600' : 'text-sm'),
          render: (d) => {
            const v = d[fd.key]
            if (v === '' || v == null) return <span className="text-muted2">—</span>
            return fd.kind === 'num' ? fmtNum(v) : v
          },
        }
      }),
    dupHelp: codeField ? (
      <>{codeField.label}가 같으면 <b>중복</b>이에요. {codeField.label}가 없으면 <b>{reqField.label}＋규격</b>이 모두 같은 항목을 중복으로 봅니다. {reqField.label}만 같고 규격이 다르면 <b>확인 필요</b>로 표시하니, 처리 칸에서 맞는 항목을 골라 덮어쓰세요. 덮어쓰기는 엑셀에 값이 있는 칸만 바꿔요.</>
    ) : (
      <>{reqField.label}이(가) 같으면 <b>중복</b>이에요. 처리 칸에서 건너뛰거나 덮어쓸 수 있어요.</>
    ),
  }
}

const VendorPanel = ({ embedded = false }) => {
  const toast = useToast()
  const [importing,   setImporting]   = useState(false)
  const [vendors,     setVendors]     = useState([])
  const [q,           setQ]           = useState('')
  const [filterGubu,  setFilterGubu]  = useState('')
  const [showInactive, setShowInactive] = useState(false)   // 미사용 거래처는 기본으로 감춘다
  const [drawerOpen,  setDrawerOpen]  = useState(false)
  const [editing,     setEditing]     = useState(null)
  const [form, setForm] = useState({ name:'', gubu:'A', type:'', biz_no:'', ceo:'', contact:'', phone:'', fax:'', email:'', address:'', biz_type:'', biz_item:'', pay_account:'' })

  // 기준정보 화면이므로 미사용까지 다 불러온다(다른 화면의 선택 목록은 사용중만 받는다).
  const load = () => api.getVendors({ all: true }).then(setVendors)
  useEffect(() => { load() }, [])

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const filtered = vendors.filter(v => {
    const matchQ = !q || [v.name, v.biz_no, v.ceo, v.contact, v.phone, v.email].some(s => s?.includes(q))
    const matchG = !filterGubu || v.gubu === filterGubu
    const matchA = showInactive || v.active !== 0
    return matchQ && matchG && matchA
  })
  const inactiveCount = vendors.filter(v => v.active === 0).length

  const toggleActive = async (v) => {
    const next = v.active === 0
    const res = await api.setVendorActive(v.id, next)
    if (!res.ok) return toast.push(res.error || '변경에 실패했어요', { tone: 'warn' })
    toast.push(next
      ? `${v.name} 다시 사용해요`
      : `${v.name} 미사용으로 바꿨어요. 새 거래의 거래처 목록에서 빠지고, 기존 기록은 그대로 남아요`)
    load()
  }

  const openNew = () => {
    setEditing(null)
    setForm({ name:'', gubu:'A', type:'', biz_no:'', ceo:'', contact:'', phone:'', fax:'', email:'', address:'', biz_type:'', biz_item:'', pay_account:'' })
    setDrawerOpen(true)
  }
  const openEdit = (v) => {
    setEditing(v)
    setForm({ name:v.name, gubu:v.gubu||'A', type:v.type||'', biz_no:v.biz_no||'', ceo:v.ceo||'', contact:v.contact||'', phone:v.phone||'', fax:v.fax||'', email:v.email||'', address:v.address||'', biz_type:v.biz_type||'', biz_item:v.biz_item||'', pay_account:v.pay_account||'' })
    setDrawerOpen(true)
  }
  const handleSave = async () => {
    if (!form.name) return toast.push('상호명을 입력하세요')
    const res = editing
      ? await api.updateVendor(editing.id, form)
      : await api.addVendor(form)
    if (!res.ok) return toast.push(res.error || '저장 실패', { tone: 'warn' })
    toast.push(editing ? '수정됐어요' : '거래처가 등록됐어요')
    setDrawerOpen(false)
    load()
  }
  const handleDelete = async (v) => {
    // 결과를 보지 않고 '삭제됐어요'를 띄우면, FK로 막혀 실패했는데도 성공한 줄 알게 된다
    const res = await api.deleteVendor(v.id)
    toast.push(res.ok ? `${v.name} 삭제됐어요` : (res.error || '삭제에 실패했어요'), res.ok ? undefined : { tone: 'warn' })
    load()
  }

  if (importing) return (
    <ImportWizard
      adapter={vendorImportAdapter}
      existing={vendors}
      onCancel={() => setImporting(false)}
      onDone={() => { setImporting(false); load() }}/>
  )

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
        {embedded ? (
          <div className="section-sub" style={{ alignSelf: 'center' }}>총 {vendors.length}건 · DB 기준</div>
        ) : (
          <div>
            <div className="section-title">거래처</div>
            <div className="section-sub">총 {vendors.length}건 · DB 기준</div>
          </div>
        )}
        <div className="row gap-6" style={{ marginLeft: 'auto' }}>
          {['', 'B', 'A', 'E'].map(g => (
            <button key={g} className={`chip ${filterGubu === g ? 'active' : ''}`} onClick={() => setFilterGubu(g)}>
              {g === '' ? '전체' : GUBU_LABEL[g]}
            </button>
          ))}
        </div>
        {inactiveCount > 0 && (
          <button className={`chip ${showInactive ? 'active' : ''}`} onClick={() => setShowInactive(s => !s)}>
            미사용 {inactiveCount}
          </button>
        )}
        <div className="search" style={{ margin: 0, width: 200, padding: '6px 10px' }}>
          <Icon.Search size={14}/>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="상호·담당자·연락처"/>
        </div>
        <button className="btn excel" onClick={() => setImporting(true)}><Icon.Excel/> 엑셀 업로드</button>
        <button className="btn primary" onClick={openNew}><Icon.Plus size={14}/> 거래처 등록</button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th>상호명</th>
              <th style={{ width: 70 }}>구분</th>
              <th>거래 유형</th>
              <th>사업자번호</th>
              <th>대표자</th>
              <th>담당자</th>
              <th>전화</th>
              <th>이메일</th>
              <th style={{ width: 70 }}>상태</th>
              <th style={{ width: 150 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32, color: 'var(--muted-2)' }}>등록된 거래처가 없어요</td></tr>
            )}
            {filtered.map(v => (
              <tr key={v.id} style={v.active === 0 ? { opacity: 0.55 } : undefined}>
                <td className="fw-700">{v.name}</td>
                <td><span className={`badge ${v.gubu === 'B' ? 'brand' : v.gubu === 'E' ? 'outline' : 'warn'}`}>{GUBU_LABEL[v.gubu] || v.gubu}</span></td>
                <td className="text-sm text-muted">{v.type || '—'}</td>
                <td className="text-sm">{v.biz_no || '—'}</td>
                <td className="text-sm">{v.ceo || '—'}</td>
                <td className="text-sm">{v.contact || '—'}</td>
                <td className="text-sm">{v.phone || '—'}</td>
                <td className="text-sm">{v.email || '—'}</td>
                <td>
                  {v.active === 0
                    ? <span className="badge outline">미사용</span>
                    : <span className="badge pos">사용중</span>}
                </td>
                <td>
                  <div className="row gap-6">
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => openEdit(v)}>수정</button>
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => toggleActive(v)}>
                      {v.active === 0 ? '사용' : '미사용'}
                    </button>
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--neg)' }} onClick={() => handleDelete(v)}>삭제</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <DrawerHead title={editing ? '거래처 수정' : '거래처 등록'} onClose={() => setDrawerOpen(false)}/>
        <div className="drawer-body col gap-form">
          <div>
            <label className="label" style={{ marginBottom: 8 }}>상호명 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <input className="input" value={form.name} onChange={e => f('name', e.target.value)} placeholder="(주)한화오션"/>
          </div>

          <div style={{ height: 1, background: 'var(--line)' }}/>

          {/* 거래 구분은 칩 라벨이 길어('매입처/외주 (지급)') 절반 폭에서는 2줄로 접힌다. 한 줄을 다 쓴다. */}
          <div>
            <label className="label" style={{ marginBottom: 8 }}>거래 구분 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {GUBU_OPTS.map(o => (
                <button key={o.value} type="button" className={`chip ${form.gubu === o.value ? 'active' : ''}`} onClick={() => f('gubu', o.value)}>{o.label}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="label" style={{ marginBottom: 8 }}>거래 유형</label>
            <input className="input" value={form.type} onChange={e => f('type', e.target.value)} placeholder="발주처 / 외주가공 / 원자재"/>
          </div>

          <div style={{ height: 1, background: 'var(--line)' }}/>

          <div className="row gap-16" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>사업자번호</label>
              <input className="input" value={form.biz_no} onChange={e => f('biz_no', e.target.value)} placeholder="000-00-00000"/>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>대표자</label>
              <input className="input" value={form.ceo} onChange={e => f('ceo', e.target.value)} placeholder="홍길동"/>
            </div>
          </div>

          {/* 업태·종목은 세금계산서에 찍히는 항목이라 거래처마다 들고 있어야 한다 */}
          <div className="row gap-16" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>업태</label>
              <input className="input" value={form.biz_type} onChange={e => f('biz_type', e.target.value)} placeholder="예: 제조업, 서비스업"/>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>종목</label>
              <input className="input" value={form.biz_item} onChange={e => f('biz_item', e.target.value)} placeholder="예: 소프트웨어 개발"/>
            </div>
          </div>

          <div>
            <label className="label" style={{ marginBottom: 8 }}>
              지급계좌 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택 (이 거래처에 이체할 계좌)</span>
            </label>
            <input className="input" value={form.pay_account} onChange={e => f('pay_account', e.target.value)}
              placeholder="예: 기업은행 123-456789-01-011 (주)○○"/>
          </div>

          <div className="row gap-16" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>담당자</label>
              <input className="input" value={form.contact} onChange={e => f('contact', e.target.value)} placeholder="김담당"/>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>전화번호</label>
              <input className="input" value={form.phone} onChange={e => f('phone', e.target.value)} placeholder="031-000-0000"/>
            </div>
          </div>

          <div className="row gap-16" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>팩스번호</label>
              <input className="input" value={form.fax} onChange={e => f('fax', e.target.value)} placeholder="031-000-0001"/>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>이메일</label>
              <input className="input" value={form.email} onChange={e => f('email', e.target.value)} placeholder="contact@company.com"/>
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--line)' }}/>

          <div>
            <label className="label" style={{ marginBottom: 8 }}>주소</label>
            <input className="input" value={form.address} onChange={e => f('address', e.target.value)} placeholder="경기도 안산시 ..."/>
          </div>
        </div>
        <DrawerFooter onCancel={() => setDrawerOpen(false)} onSave={handleSave}/>
      </Drawer>
    </div>
  )
}

// ── 표준 계정과목 패널 (읽기 전용 K-GAAP 마스터) ──────────────────
const ACCT_TYPES = ["자산", "부채", "자본", "수익", "비용"]
const ACCT_TYPE_BADGE = { 자산: "brand", 부채: "warn", 자본: "outline", 수익: "pos", 비용: "neg" }

const AccountSubjectPanel = ({ embedded = false }) => {
  const [rows, setRows] = useState([])
  const [q, setQ] = useState("")
  const [type, setType] = useState("")

  useEffect(() => { api.getAccountSubjects().then(setRows) }, [])

  const filtered = rows.filter(r =>
    (!type || r.acct_type === type) &&
    (!q || [r.name, r.code, r.category, r.note].some(s => String(s ?? "").includes(q)))
  )
  // 유형 → 분류 순서로 그룹핑 (원본 정렬 유지)
  const groups = []
  for (const r of filtered) {
    const key = `${r.acct_type} · ${r.category}`
    let g = groups.find(x => x.key === key)
    if (!g) { g = { key, acct_type: r.acct_type, category: r.category, items: [] }; groups.push(g) }
    g.items.push(r)
  }

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16, gap: 10, flexWrap: "wrap" }}>
        {embedded ? (
          <div className="section-sub" style={{ alignSelf: 'center' }}>K-GAAP 표준 계정과목 · 선택 전용(수정 불가) · 총 {rows.length}개</div>
        ) : (
          <div>
            <div className="section-title">계정과목</div>
            <div className="section-sub">한국채택 회계기준(K-GAAP) 표준 계정과목이에요. 거래 입력 시 선택용으로 쓰이며, 이 목록은 수정할 수 없어요. · 총 {rows.length}개</div>
          </div>
        )}
        <div className="search" style={{ margin: 0, marginLeft: "auto", width: 200, padding: "6px 10px" }}>
          <Icon.Search size={14}/>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="계정과목·코드·내용"/>
        </div>
      </div>

      <div className="row gap-6" style={{ marginBottom: 14, flexWrap: "wrap" }}>
        {["", ...ACCT_TYPES].map(t => (
          <button key={t} className={`chip ${type === t ? "active" : ""}`} onClick={() => setType(t)}>
            {t === "" ? "전체" : t}
          </button>
        ))}
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 130 }}>분류</th>
              <th>계정과목</th>
              <th style={{ width: 80 }}>코드</th>
              <th>내용</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: "center", padding: 32, color: "var(--muted-2)" }}>검색 결과가 없어요</td></tr>
            )}
            {groups.map(g => (
              <Fragment key={g.key}>
                <tr style={{ background: "var(--surface-2)" }}>
                  <td colSpan={4} style={{ padding: "8px 16px" }}>
                    <span className={`badge ${ACCT_TYPE_BADGE[g.acct_type] || "outline"}`} style={{ marginRight: 8 }}>{g.acct_type}</span>
                    <span className="fw-700 text-sm">{g.category}</span>
                  </td>
                </tr>
                {g.items.map(r => (
                  <tr key={r.id}>
                    <td className="text-sm text-muted">{r.category}</td>
                    <td className="fw-600">
                      {r.name}
                      {!r.postable && <span className="badge outline" style={{ marginLeft: 8, fontSize: 10 }}>집계</span>}
                    </td>
                    <td className="num text-sm text-muted">{r.code || "—"}</td>
                    <td className="text-xs text-muted" style={{ lineHeight: 1.5 }}>{r.note || "—"}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── F0: 비목 패널 (회사 자유 CRUD) ───────────────────────────────
// 영세 = 세율 0%인 과세거래(수출·해외용역). 세액은 없지만 과세표준에 들어가므로 면세와 나눠 둔다.
const VAT_OPTS = ["10%", "면세", "영세", "—"]
const PAY_OPTS = ["계좌이체", "법인카드", "현금", "—"]

const kindOf = (c) => (c.id?.startsWith('INC-') ? 'inc' : 'exp')

const CategoryPanel = ({ embedded = false }) => {
  const toast = useToast()
  const [cats, setCats] = useState([])
  const [q, setQ] = useState("")
  const [filterKind, setFilterKind] = useState("") // '' | 'exp' | 'inc'
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null = new
  const [form, setForm] = useState({ kind: "exp", name: "", vat: "10%", pay_method: "계좌이체" })

  const load = () => api.getCategories().then(setCats)
  useEffect(() => { load() }, [])

  const filtered = cats.filter(c =>
    (!filterKind || kindOf(c) === filterKind) &&
    (!q || c.name?.includes(q))
  )

  const openNew = () => {
    setEditing(null)
    setForm({ kind: filterKind === "inc" ? "inc" : "exp", name: "", vat: "10%", pay_method: "계좌이체" })
    setDrawerOpen(true)
  }
  const openEdit = (c) => {
    setEditing(c)
    // vat_deductible을 안 실으면 칩이 항상 '공제 가능'으로 보이고, 저장 시 서버가 1로 되돌린다
    setForm({ kind: kindOf(c), name: c.name, vat: c.vat, pay_method: c.pay_method,
              vat_deductible: c.vat_deductible == null ? 1 : Number(c.vat_deductible) })
    setDrawerOpen(true)
  }
  const handleSave = async () => {
    if (!form.name.trim()) return toast.push("비목명을 입력하세요")
    // 매입세액 불공제(접대비 등)는 반드시 payload에 넣는다 — 빠지면 서버가 1(공제가능)로 강제한다
    const vatDeductible = (form.vat_deductible ?? 1) === 0 ? 0 : 1
    const res = editing
      ? await api.updateCategory(editing.id, { name: form.name, group_name: editing.group_name || '', vat: form.vat, pay_method: form.pay_method, vat_deductible: vatDeductible })
      : await api.addCategory({ kind: form.kind, name: form.name, vat: form.vat, pay_method: form.pay_method, vat_deductible: vatDeductible })
    if (!res.ok) return toast.push(res.error || "저장 실패", { tone: 'warn' })
    toast.push(editing ? "수정됐어요" : "등록됐어요")
    setDrawerOpen(false)
    load()
  }
  const handleDelete = async (c) => {
    await api.deleteCategory(c.id)
    toast.push(`${c.name} 삭제됐어요`)
    load()
  }

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16, gap: 10, flexWrap: "wrap" }}>
        {embedded ? (
          <div className="section-sub" style={{ alignSelf: 'center' }}>거래 입력 시 필수 선택 항목 · 총 {cats.length}개</div>
        ) : (
          <div>
            <div className="section-title">비목</div>
            <div className="section-sub">회사가 자유롭게 쓰는 지출·수입 항목이에요. 거래 입력 시 필수로 선택합니다. · 총 {cats.length}개</div>
          </div>
        )}
        <div className="row gap-6" style={{ marginLeft: "auto" }}>
          {[["", "전체"], ["exp", "지출"], ["inc", "수입"]].map(([k, label]) => (
            <button key={k} className={`chip ${filterKind === k ? "active" : ""}`} onClick={() => setFilterKind(k)}>{label}</button>
          ))}
        </div>
        <div className="search" style={{ margin: 0, width: 200, padding: "6px 10px" }}>
          <Icon.Search size={14}/>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="비목 검색"/>
        </div>
        <button className="btn primary" onClick={openNew}><Icon.Plus size={14}/> 비목 추가</button>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 70 }}>구분</th>
              <th>비목명</th>
              <th style={{ width: 70 }}>부가세</th>
              <th style={{ width: 100 }}>결제수단</th>
              <th style={{ width: 100 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: "center", padding: 32, color: "var(--muted-2)" }}>비목이 없어요. 위에서 추가하세요.</td></tr>
            )}
            {filtered.map(c => (
              <tr key={c.id}>
                <td><span className={`badge ${kindOf(c) === "inc" ? "pos" : "warn"}`}>{kindOf(c) === "inc" ? "수입" : "지출"}</span></td>
                <td className="fw-600">{c.name}</td>
                <td className="text-sm">{c.vat}</td>
                <td className="text-sm">{c.pay_method}</td>
                <td>
                  <div className="row gap-6">
                    <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => openEdit(c)}>수정</button>
                    <button className="btn" style={{ fontSize: 11, padding: "2px 8px", color: "var(--neg)" }} onClick={() => handleDelete(c)}>삭제</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <DrawerHead title={editing ? "비목 수정" : "비목 추가"} onClose={() => setDrawerOpen(false)}/>
        <div className="drawer-body col gap-form">
          <div>
            <label className="label">구분 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
            <div className="row gap-6">
              {[["exp", "지출"], ["inc", "수입"]].map(([k, label]) => (
                <button key={k} type="button" disabled={!!editing}
                  className={`chip ${form.kind === k ? "active" : ""}`}
                  style={editing ? { opacity: 0.6, cursor: "default" } : undefined}
                  onClick={() => !editing && setForm(p => ({ ...p, kind: k }))}>{label}</button>
              ))}
            </div>
            {editing && <div className="text-xs text-muted" style={{ marginTop: 4 }}>구분은 수정할 수 없어요.</div>}
          </div>
          <div>
            <label className="label">비목명 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
            <input className="input" placeholder="예: 도금 외주"
              value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}/>
          </div>
          <div>
            <label className="label">부가세</label>
            <div className="row gap-6">
              {VAT_OPTS.map(v => (
                <button key={v} type="button" className={`chip ${form.vat === v ? 'active' : ''}`} onClick={() => setForm(p => ({ ...p, vat: v }))}>{v}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">기본 결제수단</label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {PAY_OPTS.map(v => (
                <button key={v} type="button" className={`chip ${form.pay_method === v ? 'active' : ''}`} onClick={() => setForm(p => ({ ...p, pay_method: v }))}>{v}</button>
              ))}
            </div>
          </div>
          {/* 접대비·비영업용 승용차처럼 세금계산서를 받아도 매입세액을 못 빼는 비목이 있다.
              여기서 꺼두면 이 비목으로 등록하는 지출이 기본 불공제로 들어간다(거래별로 다시 바꿀 수 있음). */}
          {kindOf(form) === 'exp' && (
            <div>
              <label className="label">매입세액</label>
              <div className="row gap-6">
                {[[1, '공제 가능'], [0, '불공제']].map(([v, label]) => (
                  <button key={label} type="button" className={`chip ${(form.vat_deductible ?? 1) === v ? 'active' : ''}`}
                    onClick={() => setForm(p => ({ ...p, vat_deductible: v }))}>{label}</button>
                ))}
              </div>
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                불공제로 두면 이 비목의 지출이 부가세 매입세액 집계에서 빠져요 (접대비·비영업용 승용차 등).
              </div>
            </div>
          )}
        </div>
        <DrawerFooter onCancel={() => setDrawerOpen(false)} onSave={handleSave}/>
      </Drawer>
    </div>
  )
}

// ── F1: 계좌별 잔액 패널 ─────────────────────────────────────────
const AdjustDrawer = ({ account, onClose, onSave }) => {
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")
  const [type, setType] = useState("minus")
  if (!account) return null
  const handleSave = () => {
    if (!reason) return
    const n = parseInt(amount.replace(/[^0-9]/g, "")) || 0
    onSave(account.id, { amount: type === "minus" ? -n : n, reason })
    onClose()
  }
  return (
    <Drawer open={!!account} onClose={onClose}>
      <DrawerHead title="잔액 조정" sub={account.name} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="row gap-8">
          <button className={`chip ${type === "minus" ? "active" : ""}`} onClick={() => setType("minus")}>- 차감</button>
          <button className={`chip ${type === "plus" ? "active" : ""}`} onClick={() => setType("plus")}>+ 추가</button>
        </div>
        <div>
          <label className="label">조정 금액</label>
          <MoneyInput value={amount} onChange={raw => setAmount(raw)}/>
        </div>
        <div>
          <label className="label">조정 사유</label>
          <input className="input" placeholder="은행 수수료, 오입력 수정 등" value={reason} onChange={e => setReason(e.target.value)}/>
        </div>
      </div>
      <DrawerFooter onCancel={onClose} onSave={handleSave} saveLabel="조정 등록"/>
    </Drawer>
  )
}

// ── 회사 정보 패널 (자사 기준정보, 단일 레코드) ────────────────────
const CompanyPanel = ({ embedded = false }) => {
  const toast = useToast()
  const [form, setForm] = useState({ name:'', biz_no:'', ceo:'', biz_type:'', biz_item:'', address:'', phone:'', fax:'', email:'', main_account:'' })
  const [accounts, setAccounts] = useState([])

  useEffect(() => {
    api.getCompany().then(c => {
      if (c) setForm({
        name: c.name||'', biz_no: c.biz_no||'', ceo: c.ceo||'', biz_type: c.biz_type||'',
        biz_item: c.biz_item||'', address: c.address||'', phone: c.phone||'', fax: c.fax||'',
        email: c.email||'', main_account: c.main_account||'',
      })
    })
    api.getAccounts().then(list => setAccounts(list.filter(a => a.kind !== 'card')))
  }, [])

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const handleSave = async () => {
    if (!form.name) return toast.push('상호(법인명)를 입력하세요')
    const res = await api.saveCompany(form)
    if (!res.ok) return toast.push(res.error || '저장 실패', { tone: 'warn' })
    toast.push('회사 정보가 저장됐어요')
  }

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16 }}>
        {embedded ? (
          <div className="section-sub" style={{ alignSelf: 'center' }}>세금계산서·보고서·세무 자료에 들어갈 자사 기준정보예요.</div>
        ) : (
          <div>
            <div className="section-title">회사 정보</div>
            <div className="section-sub">세금계산서·보고서·세무 자료에 들어갈 자사 기준정보예요.</div>
          </div>
        )}
        <button className="btn primary ml-auto" onClick={handleSave}><Icon.Check size={14}/> 저장</button>
      </div>

      <div className="card card-pad col" style={{ gap: 22, maxWidth: 760 }}>
        <div className="row gap-16" style={{ alignItems:'flex-start' }}>
          <div style={{ flex: 2 }}>
            <label className="label" style={{ marginBottom: 8 }}>상호(법인명) <span style={{ color:'var(--neg-ink)' }}>*</span></label>
            <input className="input" value={form.name} onChange={e => f('name', e.target.value)} placeholder="도니도라 주식회사"/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>대표자</label>
            <input className="input" value={form.ceo} onChange={e => f('ceo', e.target.value)} placeholder="홍길동"/>
          </div>
        </div>

        <div className="row gap-16" style={{ alignItems:'flex-start' }}>
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>사업자등록번호</label>
            <input className="input num" value={form.biz_no} onChange={e => f('biz_no', e.target.value)} placeholder="000-00-00000"/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>업태</label>
            <input className="input" value={form.biz_type} onChange={e => f('biz_type', e.target.value)} placeholder="제조업"/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>종목</label>
            <input className="input" value={form.biz_item} onChange={e => f('biz_item', e.target.value)} placeholder="방산 정밀가공"/>
          </div>
        </div>

        <div style={{ height: 1, background:'var(--line)' }}/>

        <div>
          <label className="label" style={{ marginBottom: 8 }}>사업장 주소</label>
          <input className="input" value={form.address} onChange={e => f('address', e.target.value)} placeholder="경기도 안산시 ..."/>
        </div>

        <div className="row gap-16" style={{ alignItems:'flex-start' }}>
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>대표 전화</label>
            <input className="input" value={form.phone} onChange={e => f('phone', e.target.value)} placeholder="031-000-0000"/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>팩스</label>
            <input className="input" value={form.fax} onChange={e => f('fax', e.target.value)} placeholder="031-000-0001"/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>이메일</label>
            <input className="input" value={form.email} onChange={e => f('email', e.target.value)} placeholder="info@dongjin.co.kr"/>
          </div>
        </div>

        <div style={{ height: 1, background:'var(--line)' }}/>

        <div>
          <label className="label" style={{ marginBottom: 8 }}>대표 입금계좌</label>
          <Combobox value={form.main_account} onChange={v => f('main_account', v)} allowAdd={false}
            options={[{ value: '', label: '선택 안 함' }, ...accounts.map(a => ({ value: a.name, label: a.name }))]}
            placeholder="대표 입금계좌 선택"/>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>세금계산서·청구서에 표기할 기본 수금 계좌예요.</div>
        </div>
      </div>
    </div>
  )
}

// ── 계좌 / 카드 등록 패널 ────────────────────────────────────────
const ACCOUNT_KINDS = [{ value: 'bank', label: '계좌' }, { value: 'card', label: '카드' }]
const BANK_TYPES = ['보통예금', '당좌예금', '정기예금']
const CARD_TYPES = ['법인카드', '개인카드', '체크카드']
const emptyAccountForm = () => ({ kind: 'bank', type: '보통예금', bank: '', number: '', name: '', purpose: '', initial_balance: '' })

const AccountPanel = ({ embedded = false }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [accounts, setAccounts] = useState([])
  const [q, setQ] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyAccountForm())

  const load = () => api.getAccounts().then(setAccounts)
  useEffect(() => { load() }, [])

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const setKind = (kind) => setForm(p => ({ ...p, kind, type: kind === 'bank' ? '보통예금' : '법인카드' }))

  const filtered = accounts.filter(a =>
    !q || [a.name, a.bankName, a.number, a.purpose, a.type].some(s => s?.includes(q))
  )

  const openNew = () => { setEditing(null); setForm(emptyAccountForm()); setDrawerOpen(true) }
  const openEdit = (a) => {
    setEditing(a)
    setForm({
      kind: a.kind || 'bank',
      type: a.type || (a.kind === 'card' ? '법인카드' : '보통예금'),
      bank: a.bankName || '',
      number: a.number || '',
      name: a.name || '',
      purpose: a.purpose || '',
      initial_balance: a.initialBalance ?? '',
    })
    setDrawerOpen(true)
  }

  const handleSave = async () => {
    if (!form.name) return toast.push('별칭을 입력하세요')
    const payload = {
      name: form.name, bank: form.bank, type: form.type, kind: form.kind,
      number: form.number, purpose: form.purpose,
      initial_balance: form.kind === 'bank' ? (parseInt(String(form.initial_balance).replace(/[^0-9-]/g, '')) || 0) : 0,
    }
    const res = editing ? await api.updateAccount(editing.id, payload) : await api.addAccount(payload)
    if (!res.ok) return toast.push(res.error || '저장 실패', { tone: 'warn' })
    toast.push(editing ? '수정됐어요' : '등록됐어요')
    setDrawerOpen(false)
    load()
  }

  const handleDelete = async (a) => {
    const ok = await confirm({
      tone: 'warn', icon: <Icon.Warn size={22}/>, title: `${a.name} 삭제`,
      body: '이 계좌/카드를 삭제할까요? 연결된 거래가 있으면 삭제되지 않습니다.', confirmLabel: '삭제',
    })
    if (!ok) return
    const res = await api.deleteAccount(a.id)
    if (!res.ok) return toast.push(res.error || '연결된 거래가 있어 삭제할 수 없어요')
    toast.push('삭제됐어요')
    load()
  }

  const isCard = form.kind === 'card'
  const subTypes = isCard ? CARD_TYPES : BANK_TYPES

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
        {embedded ? (
          <div className="section-sub" style={{ alignSelf: 'center' }}>총 {accounts.length}건 · 결제수단으로 사용됩니다</div>
        ) : (
          <div>
            <div className="section-title">계좌 / 카드</div>
            <div className="section-sub">총 {accounts.length}건 · 결제수단으로 사용됩니다</div>
          </div>
        )}
        <div className="search" style={{ margin: 0, marginLeft: 'auto', width: 200, padding: '6px 10px' }}>
          <Icon.Search size={14}/>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="별칭·은행·번호"/>
        </div>
        <button className="btn primary" onClick={openNew}><Icon.Plus size={14}/> 계좌/카드 등록</button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 64 }}>종류</th>
              <th>별칭</th>
              <th>세부유형</th>
              <th>은행/카드사</th>
              <th>번호</th>
              <th>용도</th>
              <th className="num-right">잔액</th>
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--muted-2)' }}>등록된 계좌/카드가 없어요</td></tr>
            )}
            {filtered.map(a => (
              <tr key={a.id}>
                <td><span className={`badge ${a.kind === 'card' ? 'warn' : 'brand'}`}>{a.kind === 'card' ? '카드' : '계좌'}</span></td>
                <td className="fw-700">{a.name}</td>
                <td className="text-sm text-muted">{a.type || '—'}</td>
                <td className="text-sm">{a.bankName || '—'}</td>
                <td className="text-sm num">{a.number || '—'}</td>
                <td className="text-sm">{a.purpose || '—'}</td>
                <td className="num-cell num-right">{a.kind === 'card' || a.currentBalance == null ? '—' : fmtNum(a.currentBalance)}</td>
                <td>
                  <div className="row gap-6">
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => openEdit(a)}>수정</button>
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--neg)' }} onClick={() => handleDelete(a)}>삭제</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <DrawerHead title={editing ? '계좌/카드 수정' : '계좌/카드 등록'} onClose={() => setDrawerOpen(false)}/>
        <div className="drawer-body col gap-form">
          <div>
            <label className="label" style={{ marginBottom: 8 }}>종류 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <div className="row gap-6">
              {ACCOUNT_KINDS.map(k => (
                <button key={k.value} type="button" className={`chip ${form.kind === k.value ? 'active' : ''}`} onClick={() => setKind(k.value)}>
                  {k.value === 'card' ? <Icon.Card size={12}/> : <Icon.Bank size={12}/>} {k.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="label" style={{ marginBottom: 8 }}>{isCard ? '카드 종류' : '예금 종류'}</label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {subTypes.map(t => (
                <button key={t} type="button" className={`chip ${form.type === t ? 'active' : ''}`} onClick={() => f('type', t)}>{t}</button>
              ))}
            </div>
          </div>

          <div style={{ height: 1, background: 'var(--line)' }}/>

          <div>
            <label className="label" style={{ marginBottom: 8 }}>별칭 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <input className="input" value={form.name} onChange={e => f('name', e.target.value)} placeholder={isCard ? '예) 법인카드(국민) *1234' : '예) 기업은행(주거래) *4010'}/>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>거래 등록·잔액 화면에 이 이름으로 표시돼요.</div>
          </div>

          <div className="row gap-16" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>{isCard ? '카드사' : '은행'}</label>
              <input className="input" value={form.bank} onChange={e => f('bank', e.target.value)} placeholder={isCard ? '국민카드' : 'IBK기업은행'}/>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>{isCard ? '카드번호' : '계좌번호'}</label>
              <input className="input num" value={form.number} onChange={e => f('number', e.target.value)} placeholder={isCard ? '0000-****-****-0000' : '000-000000-00-000'}/>
            </div>
          </div>

          <div className="row gap-16" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>용도</label>
              <input className="input" value={form.purpose} onChange={e => f('purpose', e.target.value)} placeholder={isCard ? '소모품·접대비' : '주거래 / 급여이체'}/>
            </div>
            {!isCard && (
              <div style={{ flex: 1 }}>
                <label className="label" style={{ marginBottom: 8 }}>초기 잔액</label>
                <MoneyInput allowNegative value={form.initial_balance} onChange={raw => f('initial_balance', raw)}/>
                <div className="text-xs text-muted2" style={{ marginTop: 6 }}>등록 시점 통장 잔액. 이후 거래로 자동 증감돼요.</div>
              </div>
            )}
          </div>
        </div>
        <DrawerFooter onCancel={() => setDrawerOpen(false)} onSave={handleSave}/>
      </Drawer>
    </div>
  )
}

const AccountBalancePanel = ({ embedded = false }) => {
  const toast = useToast()
  const [accounts, setAccounts] = useState([])
  const [adjustTarget, setAdjustTarget] = useState(null)
  const [histTarget, setHistTarget] = useState(null)

  const load = async () => {
    const accs = await api.getAccounts()
    const withAdj = await Promise.all(
      accs.map(async a => ({ ...a, adjustments: await api.getAdjustments(a.id) }))
    )
    setAccounts(withAdj)
  }
  useEffect(() => { load() }, [])

  const handleAdjust = async (accountId, data) => {
    // 결과를 안 보고 성공 문구를 띄우면, 마감된 달이라 거절돼도 등록된 줄 안다
    const res = await api.addAdjustment(accountId, data)
    if (!res.ok) { toast.push(res.error || "잔액 조정에 실패했어요", { tone: "warn" }); return }
    toast.push("잔액 조정이 등록됐어요")
    load()
  }

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16 }}>
        {!embedded && <div className="section-title">계좌별 잔액</div>}
        <div className="text-sm text-muted ml-auto">거래내역 기반 자동 집계 + 수동 조정</div>
      </div>
      <div className="col gap-12">
        {accounts.map(acc => (
          <div key={acc.id} className="card" style={{ padding: 18, border: "1px solid var(--line)" }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <div>
                <div className="fw-700" style={{ fontSize: 15 }}>{acc.name}</div>
                <div className="text-xs text-muted">{acc.bankName} · {acc.type}</div>
              </div>
              <div className="num fw-700 ml-auto" style={{ fontSize: 22, letterSpacing: "-0.02em" }}>
                {acc.currentBalance == null ? "—" : fmtNum(acc.currentBalance)}
              </div>
            </div>
            <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: "4px 12px", fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
              <span>초기잔액</span><span>거래 집계</span><span>수동 조정</span>
              <span className="num fw-600" style={{ color: "var(--ink)" }}>{fmtNum(acc.initialBalance)}</span>
              <span className="num fw-600" style={{ color: "var(--ink)" }}>계산됨</span>
              <span className="num fw-600" style={{ color: acc.adjustments.length > 0 ? "var(--warn-ink)" : "var(--muted)" }}>
                {acc.adjustments.length > 0 ? `${acc.adjustments.length}건` : "없음"}
              </span>
            </div>
            <div className="row gap-8">
              <button className="btn" style={{ fontSize: 12 }} onClick={() => setHistTarget(acc)}>
                <Icon.Clock size={12}/> 조정 이력
              </button>
              <button className="btn primary" style={{ fontSize: 12 }} onClick={() => setAdjustTarget(acc)}>
                <Icon.Plus size={12}/> 잔액 조정
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 조정 이력 */}
      <Drawer open={!!histTarget} onClose={() => setHistTarget(null)}>
        <DrawerHead title={<>조정 이력 — {histTarget?.name}</>} onClose={() => setHistTarget(null)}/>
        <div className="drawer-body">
          {histTarget?.adjustments?.length === 0 ? (
            <div className="text-muted text-sm" style={{ padding: "20px 0" }}>조정 이력이 없습니다</div>
          ) : histTarget?.adjustments?.map((a, i) => (
            <div key={i} style={{ padding: "12px 0", borderBottom: "1px solid var(--line)" }}>
              <div className="row">
                <span className="text-sm text-muted">{a.date}</span>
                <span className="num fw-700 ml-auto" style={{ color: a.amount < 0 ? "var(--neg-ink)" : "var(--pos)" }}>
                  {a.amount > 0 ? "+" : ""}{fmtNum(a.amount)}
                </span>
              </div>
              <div className="text-sm" style={{ marginTop: 4 }}>{a.reason}</div>
              <div className="text-xs text-muted">작성: {a.by}</div>
            </div>
          ))}
        </div>
        <div className="drawer-foot">
          <button className="btn ml-auto" onClick={() => setHistTarget(null)}>닫기</button>
        </div>
      </Drawer>

      <AdjustDrawer account={adjustTarget} onClose={() => setAdjustTarget(null)} onSave={handleAdjust}/>
    </div>
  )
}

// ── F4: 정기 지출 패널 ───────────────────────────────────────────
// 정기 지출 등록.
// 예전 폼은 거래처를 자유 텍스트(vendor)로, 생성일을 camelCase(dayOfMonth)로 보냈고
// start_date·account_id 는 아예 안 보냈다. start_date 는 NOT NULL 이라 저장이 항상
// 실패했는데 호출부가 결과를 안 보고 '등록됐어요'를 띄워, 사용자는 등록된 줄 알았다.
// 정기 반복(정기지출·정기청구)의 부가세 칩. 값은 서버 lib/vat.js의 recurring vat_mode와 같다.
const RECUR_VAT_OPTS = [["exclusive", "과세 10%"], ["none", "면세"], ["zero", "영세"]]
// 비목 vat('10%'/'면세'/'영세'/'—') → 정기 vat_mode (비목 선택 시 부가세 칩 자동 채움용)
const catVatToMode = (catVat) => (catVat === '10%' ? 'exclusive' : catVat === '영세' ? 'zero' : 'none')

// addGubu: 인라인으로 새 거래처를 만들 때 부여할 구분. 정기지출은 매입처(A).
// reloadVendors: 부모가 거래처 목록을 다시 불러오게 하는 콜백(추가 후 새 id로 잡기 위함).
// editing: 수정 대상(api.getRecurringExpenses 형태, camelCase). null이면 등록.
const RecurringFormDrawer = ({ open, editing, onClose, onSave, vendors = [], accounts = [], addGubu = 'A', reloadVendors }) => {
  const empty = { vendor_id: "", category: "", amount: "", vat_mode: "exclusive", period: "monthly", day_of_month: "1", start_date: todayStr(), end_date: "", account_id: "" }
  const [form, setForm] = useState(empty)
  // 비목은 반드시 실제 비목 마스터에서 고른다. 예전엔 ["임차료","통신비"…]를 하드코딩해서,
  // 마스터 이름과 한 글자라도 다르면(예: 마스터는 '통신비(관리)') 회차를 청구서로 만들 때
  // 비목을 못 찾아 부가세가 면세로 떨어졌다. 이름이 곧 조인 키다(recurring_expenses.category = categories.name).
  const [cats, setCats] = useState([])
  useEffect(() => { if (open) api.getCategories({ type: 'exp' }).then(setCats) }, [open])
  useEffect(() => {
    if (!open) return
    if (editing) {
      // 목록 행(camelCase) → 폼(snake_case) 복원
      setForm({
        vendor_id: editing.vendorId || "", category: editing.category || "",
        // 계약 연결은 폼에서 다루지 않지만, 수정 시 잃지 않도록 들고 다닌다
        contract_id: editing.contractId || null,
        amount: editing.amount ? String(editing.amount) : "",
        vat_mode: editing.vatMode || "exclusive",
        period: editing.period || "monthly", day_of_month: String(editing.dayOfMonth || 1),
        start_date: editing.startDate || todayStr(), end_date: editing.endDate || "",
        account_id: editing.accountId || "",
      })
    } else {
      // 출금 계좌 기본값 — 비어 있으면 생성된 지출을 '이체 실행'할 때 계좌가 없어 막힌다
      setForm({ ...empty, account_id: accounts.find(a => a.kind === "bank")?.id || accounts[0]?.id || "" })
    }
  }, [open, editing, accounts])
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const handleSave = () => {
    // 비목은 선택(강제하지 않음 — 초기 진입 부담을 줄인다). 부가세는 폼에서 직접 고른다.
    if (!form.vendor_id) return toast.push("거래처를 선택해주세요")
    if (!form.amount)    return toast.push("금액을 입력해주세요")
    if (!form.start_date) return toast.push("시작일을 선택해주세요")
    if (!form.account_id) return toast.push("출금 계좌를 선택해주세요")
    onSave({
      ...form,
      amount: parseInt(String(form.amount).replace(/[^0-9]/g, "")) || 0,
      day_of_month: parseInt(form.day_of_month) || 1,
      end_date: form.end_date || null,
    })
    onClose()
  }
  const toast = useToast()
  return (
    <Drawer open={open} onClose={onClose}>
      <DrawerHead title={editing ? "정기 지출 수정" : "정기 지출 등록"} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div><label className="label">거래처 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <Combobox value={form.vendor_id} onChange={v => f("vendor_id", v)}
            options={vendors.map(v => ({ value: v.id, label: v.name, sub: v.type || "" }))} placeholder="거래처 선택·검색"
            onAddNew={async (q) => {
              const nm = (q || '').trim(); if (!nm) return
              const res = await api.addVendor({ name: nm, gubu: addGubu })
              if (!res.ok) return toast.push("거래처 등록에 실패했어요", { tone: 'warn' })
              // 목록을 다시 받아 방금 만든 거래처를 id로 잡는다(Combobox 값이 이름이 아니라 id라서)
              const fresh = reloadVendors ? await reloadVendors() : []
              const hit = fresh.find(v => v.name === nm)
              f("vendor_id", hit ? hit.id : "")
              toast.push(`"${nm}" 거래처가 등록됐어요`)
            }}
            addNewLabel="거래처로 추가"/>
        </div>
        <div><label className="label">비목 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
          <Combobox value={form.category}
            onChange={v => {
              // 비목을 고르면 그 비목의 부가세 설정을 부가세 칸에 채워준다(참고값 — 아래서 바꿀 수 있다)
              const c = cats.find(x => x.name === v)
              setForm(p => ({ ...p, category: v, vat_mode: c ? catVatToMode(c.vat) : p.vat_mode }))
            }}
            allowAdd={false}
            options={cats.map(c => ({ value: c.name, label: c.name,
              sub: [c.group_name, c.vat && c.vat !== '—' ? `부가세 ${c.vat}` : ''].filter(Boolean).join(' · ') }))}
            placeholder="비목 선택 (선택)"/>
        </div>
        <div><label className="label">금액 <span style={{ color: 'var(--neg-ink)' }}>*</span> <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· VAT 포함 합계</span></label><MoneyInput value={form.amount} onChange={raw => f("amount", raw)}/></div>
        <div><label className="label">부가세</label>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            {RECUR_VAT_OPTS.map(([v, l]) => (
              <button key={v} type="button" className={`chip ${form.vat_mode === v ? 'active' : ''}`} onClick={() => f("vat_mode", v)}>{l}</button>
            ))}
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
            비목을 고르면 자동으로 맞춰지고, 여기서 바꿀 수 있어요. 금액은 부가세 포함 합계로 넣으세요.
          </div>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}>
            <label className="label">반복 주기</label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {[["monthly","매월"],["quarterly","매분기"],["yearly","매년"]].map(([v, l]) => (
                <button key={v} type="button" className={`chip ${form.period === v ? 'active' : ''}`} onClick={() => f("period", v)}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">생성 일 (매월 N일)</label>
            <input className="input" type="number" min="1" max="31" value={form.day_of_month} onChange={e => f("day_of_month", e.target.value)}/>
          </div>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}>
            <label className="label">시작일 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <input className="input" type="date" value={form.start_date} onChange={e => f("start_date", e.target.value)}/>
            <FirstCycleHint startDate={form.start_date} dayOfMonth={form.day_of_month} period={form.period} verb="지출" editing={!!editing}/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">종료일 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
            <input className="input" type="date" value={form.end_date} onChange={e => f("end_date", e.target.value)}/>
          </div>
        </div>
        <div>
          <label className="label">출금 계좌 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <Combobox value={form.account_id} onChange={v => f("account_id", v)} allowAdd={false}
            options={accounts.map(a => ({ value: a.id, label: a.name, sub: [a.kind === "card" ? "카드" : a.bankName, a.number].filter(Boolean).join(" ") }))}
            placeholder="계좌 선택"/>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>자동 생성된 지출을 이체 처리할 때 이 계좌가 쓰여요.</div>
        </div>
      </div>
      <DrawerFooter onCancel={onClose} onSave={handleSave} saveLabel={editing ? "수정" : "등록"}/>
    </Drawer>
  )
}

const PERIOD_LABEL = { monthly: "매월", quarterly: "매분기", yearly: "매년" }

/* 첫 회차 예정일 안내 — 등록 폼의 시작일 아래.
 * "이 날짜 이전으로는 소급되지 않아요"라는 규칙 설명만으로는, 시작일에 2020년을 넣은 사람이
 * 무슨 일이 벌어질지 알 수 없다. 결과(첫 회차 날짜)를 그 자리에서 보여준다. */
const FirstCycleHint = ({ startDate, dayOfMonth, period, verb, editing = false }) => {
  // 수정 중일 때는 계산하지 않는다. 하한은 '등록일'인데 여기선 오늘을 하한으로 쓰므로,
  // 옛 규칙을 열면 "첫 회차"가 실제와 다르게 나온다(그 규칙의 하한은 등록 당시 날짜다).
  if (editing) {
    return (
      <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
        등록일 이전으로는 소급되지 않아요. 남은 회차는 목록의 ‘다음 예정’에서 확인하세요.
      </div>
    )
  }
  if (!startDate) return <div className="text-xs text-muted2" style={{ marginTop: 6 }}>시작일을 선택하면 첫 회차를 알려드려요.</div>
  const first = firstCycleDate(startDate, dayOfMonth, period)
  const past = startDate < todayStr()
  return (
    <div className="text-xs" style={{ marginTop: 6, color: past ? 'var(--brand-ink)' : 'var(--muted2)' }}>
      {first
        ? <>첫 {verb} 회차 <b>{first}</b>{past && ' · 등록일 이전 회차는 만들어지지 않아요'}</>
        : '종료일 안에 도래하는 회차가 없어요'}
    </div>
  )
}

/* 계약 기반 표시 — 이동 수단(onGo)이 있으면 버튼, 없으면 표시만.
   눌러도 아무 일이 없는 버튼은 고장으로 읽힌다. */
const ContractBadge = ({ name, onGo }) => (
  onGo
    ? <button className="badge brand" style={{ marginLeft: 6, fontSize: 10, cursor: 'pointer', border: 0 }}
        title={`${name || '계약'} — 계약에서 관리`} onClick={onGo}><Icon.Link size={10}/> 계약</button>
    : <span className="badge brand" style={{ marginLeft: 6, fontSize: 10 }}
        title={`${name || '계약'} — 계약에서 관리`}>계약</span>
)

// 규칙 목록 필터 — 계약 기반은 금액·종료 시점의 출처가 계약이라 관리 경로가 다르다.
const RULE_FILTERS = [
  { value: 'all', label: '전체' },
  { value: 'plain', label: '일반' },
  { value: 'contract', label: '계약 기반' },
]
const filterRules = (rows, f) =>
  f === 'plain' ? rows.filter(r => !r.contractId)
  : f === 'contract' ? rows.filter(r => !!r.contractId)
  : rows

// 정기지출 = 판관비(경비) 쪽 정기 반복. 회계처리 '경비' 그룹의 독립 화면으로도, 기준정보 탭으로도 쓴다.
export const RecurringExpensePanel = ({ page = false, goRoute }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState([])
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)   // 수정 대상(없으면 등록)
  const [vendors, setVendors] = useState([])
  const [accounts, setAccounts] = useState([])
  const [ruleFilter, setRuleFilter] = useState('all')   // all | plain | contract

  const load = async () => setRows(await api.getRecurringExpenses())
  // 회차 이행 현황(놓친/임박/예정) — 정기청구와 공용 훅. 회차가 바뀌면 규칙의 '다음 예정'도 달라진다.
  const cyc = useRecurringCycles('purchase', { onChanged: load })
  useEffect(() => { load() }, [])
  // 매입처(A)·기관(E) 만 — 정기 지출의 상대는 돈을 주는 쪽이다
  const reloadVendors = async () => {
    const list = (await api.getVendors()).filter(x => x.gubu === 'A' || x.gubu === 'E')
    setVendors(list)
    return list
  }
  useEffect(() => {
    reloadVendors()
    api.getAccounts().then(setAccounts)
  }, [])

  const handleToggle = async (id) => {
    const res = await api.toggleRecurringExpense(id)
    toast.push(res.active ? "정기 지출이 활성화됐어요" : "정기 지출이 비활성화됐어요")
    load(); cyc.reload()   // 중지/재개는 예정 회차 목록을 바꾼다
  }

  // 삭제는 '앞으로 자동 생성하지 않는다'는 뜻이다. 이미 만들어진 청구서·거래는 남는다
  // (실제로 오간 돈의 기록이라 함께 지우면 장부에 구멍이 난다) — 그 점을 미리 알린다.
  const handleDelete = async (r) => {
    const ok = await confirm({
      tone: "neg", icon: <Icon.Warn size={22}/>,
      title: "정기 지출 삭제",
      body: `${r.vendor} · ${r.category}의 정기 지출을 삭제합니다. 앞으로 자동 생성되지 않아요.`,
      detail: "이미 만들어진 청구서와 거래는 그대로 남습니다. 잠시 멈추기만 하려면 '중지'를 쓰세요.",
      confirmLabel: "삭제",
    })
    if (!ok) return
    const res = await api.deleteRecurringExpense(r.id)
    if (!res.ok) { toast.push(res.error || "삭제에 실패했어요", { tone: "warn" }); return }
    const kept = (res.keptInvoices || 0) + (res.keptTxns || 0)
    toast.push(kept ? `정기 지출을 삭제했어요 (기존 기록 ${kept}건은 유지)` : "정기 지출을 삭제했어요")
    load(); cyc.reload()
  }


  const openNew = () => { setEditing(null); setFormOpen(true) }
  const openEdit = (r) => { setEditing(r); setFormOpen(true) }
  const ruleRows = filterRules(rows, ruleFilter)
  const cycSummary = cycleSummaryByRule(cyc.cycles)
  const addBtn = (
    <button className="btn primary" onClick={openNew}>
      <Icon.Plus size={14}/> 등록
    </button>
  )

  return (
    <div className={page ? 'fade-up' : undefined} style={page ? undefined : { padding: 20 }}>
      {/* 독립 화면일 땐 공용 PageHeader를 쓴다 — 다른 화면과 상단 여백·sticky 동작을 맞추기 위해 */}
      {page ? (
        <PageHeader title="정기 지출"
          sub={cyc.overdueCount > 0 ? `놓친 회차 ${cyc.overdueCount}건이 있어요` : undefined}
          actions={addBtn}/>
      ) : (
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="section-title">정기 지출</div>
          <div className="ml-auto">{addBtn}</div>
        </div>
      )}
      {/* 이행 현황 — 놓친 회차/임박/예정. 규칙만 보여주던 화면의 빈 곳을 채운다 */}
      <RecurringCycles cycles={cyc.cycles} kind="purchase" busy={cyc.busy}
        onIssue={cyc.issue} onPaid={cyc.openPaid} onBulk={cyc.bulk}
        onOpenContract={() => goRoute?.('contract_purchase')}/>

      <div className="row" style={{ marginBottom: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="section-title" style={{ fontSize: 13 }}>정기 지출 규칙 {ruleRows.length}건</div>
        <div className="row gap-6 ml-auto">
          {RULE_FILTERS.map(f => (
            <button key={f.value} className={`chip ${ruleFilter === f.value ? 'active' : ''}`}
              onClick={() => setRuleFilter(f.value)}>{f.label}</button>
          ))}
        </div>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>거래처</th><th>비목</th><th className="num-right">금액</th>
              <th>주기</th><th>다음 예정</th><th style={{ width: 60 }}>상태</th><th style={{ width: 110 }}></th>
            </tr>
          </thead>
          <tbody>
            {ruleRows.map(r => {
              const s = cycSummary.get(r.id)
              return (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.45 }}>
                <td className="fw-700">
                  {r.vendor}
                  {/* 계약 기반은 금액·종료 시점의 출처가 계약이다 → 수정은 계약에서.
                      goRoute가 없는 자리(기준정보 탭)에서는 눌러도 아무 일이 없으니 표시만 한다 */}
                  {r.contractId && <ContractBadge name={r.contractName} onGo={goRoute && (() => goRoute('contract_purchase'))}/>}
                </td>
                <td className="text-sm text-muted">{r.category}</td>
                <td className="num-cell num-right">{fmtNum(r.amount)}</td>
                <td className="text-sm">{PERIOD_LABEL[r.period]} {r.dayOfMonth}일</td>
                {/* 서버가 계산한 회차를 쓴다 — 화면에서 다시 계산하면 놓친 회차가 감춰진다 */}
                <td className="text-sm">
                  {r.active ? (s?.next || "—") : "—"}
                  {s?.overdue > 0 && (
                    <span className="badge neg" style={{ marginLeft: 6, fontSize: 10 }}>미처리 {s.overdue}</span>
                  )}
                </td>
                <td>
                  <span className={`badge ${r.active ? "pos" : "outline"}`}>{r.active ? "활성" : "비활성"}</span>
                </td>
                <td>
                  <div className="row gap-6">
                    <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => openEdit(r)}>수정</button>
                    <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => handleToggle(r.id)}>
                      {r.active ? "중지" : "재개"}
                    </button>
                    <button className="btn" style={{ fontSize: 11, padding: "3px 8px", color: "var(--neg-ink)" }}
                      onClick={() => handleDelete(r)}>삭제</button>
                  </div>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <RecurringFormDrawer open={formOpen} editing={editing} onClose={() => setFormOpen(false)} vendors={vendors} accounts={accounts}
        addGubu="A" reloadVendors={reloadVendors}
        onSave={async (data) => {
          // 결과를 보지 않고 성공 문구를 띄우면, 저장이 실패해도 등록된 줄 알게 된다
          const res = editing ? await api.updateRecurringExpense(editing.id, data) : await api.addRecurringExpense(data)
          toast.push(res?.ok === false ? (res.error || "저장에 실패했어요") : (editing ? "정기 지출을 수정했어요" : "정기 지출이 등록됐어요"),
                     res?.ok === false ? { tone: "warn" } : undefined)
          load(); cyc.reload()
        }}/>
      {/* 기지급 처리 — 계좌·날짜를 받는다. 대금청구서 화면과 같은 공용 드로어 */}
      <PaidIssueDrawer target={cyc.paidTarget} isIssued={false}
        onIssuePaid={cyc.issuePaid} onClose={cyc.closePaid} onDone={cyc.donePaid}/>
    </div>
  )
}

// ── 정기 청구(고정수입) 패널 ──────────────────────────────────────
const RecurringInvoiceFormDrawer = ({ open, editing, onClose, onSave, vendors, contracts, accounts, reloadVendors }) => {
  const toast = useToast()
  const empty = { vendorId: "", contractId: "", item: "", supply: "", vatMode: "exclusive", period: "monthly", dayOfMonth: "1", startDate: todayStr(), endDate: "", accountId: "" }
  const [form, setForm] = useState(empty)
  useEffect(() => {
    if (!open) return
    setForm(editing ? {
      vendorId: editing.vendorId || "", contractId: editing.contractId || "", item: editing.item || "",
      supply: editing.supplyAmount ? String(editing.supplyAmount) : "",
      vatMode: editing.vatMode || "exclusive", period: editing.period || "monthly",
      dayOfMonth: String(editing.dayOfMonth || 1), startDate: editing.startDate || todayStr(),
      endDate: editing.endDate || "", accountId: editing.accountId || "",
    } : empty)
  }, [open, editing])
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  // 계약 vat_mode(taxable/exempt/zero) → 정기청구 vat_mode(exclusive/none/zero)
  const modeFromContract = (vm) => (vm === 'exempt' ? 'none' : vm === 'zero' ? 'zero' : 'exclusive')

  const pickContract = (cid) => {
    setForm(p => {
      const c = contracts.find(x => x.id === cid)
      return {
        ...p,
        contractId: cid,
        vendorId: p.vendorId || (c ? c.vendor_id : ""),
        item: p.item || (c ? c.name : ""),
        // 계약을 걸면 그 계약의 과세유형을 따라간다. 이걸 안 맞추면 발행 시 세액은 규칙(기본 과세 10%)으로
        // 계산되는데 청구서 과세유형은 계약(면세/영세)으로 저장돼, 면세 계약에 10% 세액이 붙는다.
        vatMode: c ? modeFromContract(c.vat_mode) : p.vatMode,
      }
    })
  }

  const handleSave = () => {
    if (!form.vendorId || !form.supply || !form.startDate) return
    onSave({
      vendorId: form.vendorId,
      contractId: form.contractId || null,
      item: form.item,
      supplyAmount: parseInt(String(form.supply).replace(/[^0-9]/g, "")) || 0,
      vatMode: form.vatMode,
      period: form.period,
      dayOfMonth: parseInt(form.dayOfMonth) || 1,
      startDate: form.startDate,
      endDate: form.endDate || null,
      accountId: form.accountId || null,
    })
    onClose()
  }

  return (
    <Drawer open={open} onClose={onClose}>
      <DrawerHead title={editing ? "정기 청구 수정" : "정기 청구 등록"} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div><label className="label">계약 연결 <span className="text-muted">(선택)</span></label>
          <Combobox value={form.contractId} onChange={pickContract} allowAdd={false}
            options={contracts.map(c => ({ value: c.id, label: c.name, sub: c.vendor_name }))}
            placeholder="계약 선택 (없으면 비워두기)"/>
        </div>
        <div><label className="label">고객사 (발주처)</label>
          <Combobox value={form.vendorId} onChange={v => f("vendorId", v)}
            options={vendors.map(v => ({ value: v.id, label: v.name, sub: v.type }))}
            placeholder="고객사 선택·검색"
            onAddNew={async (q) => {
              const nm = (q || '').trim(); if (!nm) return
              const res = await api.addVendor({ name: nm, gubu: 'B' })   // 정기청구 상대는 발주처(B)
              if (!res.ok) return toast.push("고객사 등록에 실패했어요", { tone: 'warn' })
              const fresh = reloadVendors ? await reloadVendors() : []
              const hit = fresh.find(v => v.name === nm)
              f("vendorId", hit ? hit.id : "")
              toast.push(`"${nm}" 고객사가 등록됐어요`)
            }}
            addNewLabel="고객사로 추가"/>
        </div>
        <div><label className="label">청구 항목</label>
          <input className="input" value={form.item} onChange={e => f("item", e.target.value)} placeholder="예: OO 홈페이지 유지보수"/>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}><label className="label">공급가액</label>
            <MoneyInput value={form.supply} onChange={raw => f("supply", raw)}/>
          </div>
          <div style={{ flex: 1 }}><label className="label">부가세</label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {RECUR_VAT_OPTS.map(([v, l]) => (
                <button key={v} type="button" className={`chip ${form.vatMode === v ? 'active' : ''}`} onClick={() => f("vatMode", v)}>{l}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}>
            <label className="label">반복 주기</label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {[["monthly","매월"],["quarterly","매분기"],["yearly","매년"]].map(([v, l]) => (
                <button key={v} type="button" className={`chip ${form.period === v ? 'active' : ''}`} onClick={() => f("period", v)}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">청구일 (매월 N일)</label>
            <input className="input" type="number" min="1" max="31" value={form.dayOfMonth} onChange={e => f("dayOfMonth", e.target.value)}/>
          </div>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}><label className="label">시작일</label>
            <input className="input" type="date" value={form.startDate} onChange={e => f("startDate", e.target.value)}/>
            <FirstCycleHint startDate={form.startDate} dayOfMonth={form.dayOfMonth} period={form.period} verb="청구" editing={!!editing}/>
          </div>
          <div style={{ flex: 1 }}><label className="label">종료일 <span className="text-muted">(선택)</span></label>
            <input className="input" type="date" value={form.endDate} onChange={e => f("endDate", e.target.value)}/>
          </div>
        </div>
        <div><label className="label">입금 계좌 <span className="text-muted">(선택)</span></label>
          <Combobox value={form.accountId} onChange={v => f("accountId", v)} allowAdd={false}
            options={accounts.map(a => ({ value: a.id, label: a.name, sub: a.number }))}
            placeholder="입금 계좌 선택"/>
        </div>
      </div>
      <DrawerFooter onCancel={onClose} onSave={handleSave} saveLabel={editing ? "수정" : "등록"}/>
    </Drawer>
  )
}

// 정기청구 = 매출 쪽 정기 반복. 회계처리 '판매·매출' 그룹의 독립 화면으로도, 기준정보 탭으로도 쓴다.
export const RecurringInvoicePanel = ({ page = false, goRoute }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState([])
  const [vendors, setVendors] = useState([])
  const [contracts, setContracts] = useState([])
  const [accounts, setAccounts] = useState([])
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [ruleFilter, setRuleFilter] = useState('all')

  const load = async () => setRows(await api.getRecurringInvoices())
  // 정기지출과 완전히 같은 훅 — 회차 이행(놓친/임박/예정)과 일괄 발행
  const cyc = useRecurringCycles('sales', { onChanged: load })
  const reloadVendors = async () => {
    const list = await api.getVendors({ gubu: "B" })
    setVendors(list)
    return list
  }
  useEffect(() => {
    load()
    reloadVendors()
    api.getContracts().then(setContracts)
    api.getAccounts().then(setAccounts)
  }, [])

  const handleToggle = async (id) => {
    const res = await api.toggleRecurringInvoice(id)
    toast.push(res.active ? "정기 청구가 활성화됐어요" : "정기 청구가 비활성화됐어요")
    load(); cyc.reload()
  }

  // 정기지출 쪽과 같은 원칙 — 자동 발행만 멈추고, 이미 발행된 청구서는 남긴다.
  const handleDelete = async (r) => {
    const ok = await confirm({
      tone: "neg", icon: <Icon.Warn size={22}/>,
      title: "정기 청구 삭제",
      body: `${r.vendor} · ${r.item || r.contractName || ""}의 정기 청구를 삭제합니다. 앞으로 자동 발행되지 않아요.`.replace(/ · \./, "."),
      detail: "이미 발행된 청구서와 거래는 그대로 남습니다. 잠시 멈추기만 하려면 '중지'를 쓰세요.",
      confirmLabel: "삭제",
    })
    if (!ok) return
    const res = await api.deleteRecurringInvoice(r.id)
    if (!res.ok) { toast.push(res.error || "삭제에 실패했어요", { tone: "warn" }); return }
    const kept = (res.keptInvoices || 0) + (res.keptTxns || 0)
    toast.push(kept ? `정기 청구를 삭제했어요 (기존 기록 ${kept}건은 유지)` : "정기 청구를 삭제했어요")
    load(); cyc.reload()
  }
  // '밀린 회차 일괄 생성' 버튼은 이행 현황의 '놓친 회차 일괄 발행'으로 흡수했다
  // (같은 동작이 두 자리에 있으면 어느 쪽이 무엇을 만드는지 알 수 없다).

  // 영세(zero)도 세액 0 — 'none만 0'으로 보면 영세 청구액이 10% 부풀어 보인다
  const totalOf = (r) => r.supplyAmount + (r.vatMode === 'exclusive' ? Math.round(r.supplyAmount * 0.1) : 0)

  const openNew = () => { setEditing(null); setFormOpen(true) }
  const openEdit = (r) => { setEditing(r); setFormOpen(true) }
  const ruleRows = filterRules(rows, ruleFilter)
  const cycSummary = cycleSummaryByRule(cyc.cycles)
  const recActions = (
    <button className="btn primary" onClick={openNew}>
      <Icon.Plus size={14}/> 등록
    </button>
  )

  return (
    <div className={page ? 'fade-up' : undefined} style={page ? undefined : { padding: 20 }}>
      {/* 상단은 '이번에 청구할 것'(이행), 아래는 '무엇을 언제 얼마씩 청구할지'(규칙).
          같은 회차를 대금 청구서의 '발행 예정'에서도 처리할 수 있다 — 같은 API·같은 컴포넌트를 쓴다. */}
      {page ? (
        <PageHeader title="정기 청구"
          sub={cyc.overdueCount > 0 ? `놓친 회차 ${cyc.overdueCount}건이 있어요` : undefined}
          actions={recActions}/>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 6 }}>
            <div className="section-title">정기 청구</div>
            <div className="ml-auto">{recActions}</div>
          </div>
          <div className="text-sm text-muted" style={{ marginBottom: 16 }}>
            청구 조건을 설정하는 곳이에요. 도래한 회차는 아래에서 바로 발행할 수 있고, <b>판매·매출 → 대금 청구서</b>의 '발행 예정'에서 계약 청구일정과 함께 처리해도 됩니다.
          </div>
        </>
      )}

      <RecurringCycles cycles={cyc.cycles} kind="sales" busy={cyc.busy}
        onIssue={cyc.issue} onPaid={cyc.openPaid} onBulk={cyc.bulk}
        onOpenContract={() => goRoute?.('contract_sales')}/>

      <div className="row" style={{ marginBottom: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="section-title" style={{ fontSize: 13 }}>정기 청구 규칙 {ruleRows.length}건</div>
        <div className="row gap-6 ml-auto">
          {RULE_FILTERS.map(f => (
            <button key={f.value} className={`chip ${ruleFilter === f.value ? 'active' : ''}`}
              onClick={() => setRuleFilter(f.value)}>{f.label}</button>
          ))}
        </div>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>고객사</th><th>항목 / 계약</th><th className="num-right">청구액(VAT 포함)</th>
              <th>주기</th><th>다음 예정</th><th style={{ width: 60 }}>상태</th><th style={{ width: 110 }}></th>
            </tr>
          </thead>
          <tbody>
            {ruleRows.length === 0 && (
              <tr><td colSpan={7} className="text-sm text-muted" style={{ textAlign: "center", padding: 24 }}>
                {rows.length === 0
                  ? "등록된 정기 청구가 없어요. 유지보수·호스팅 등 매달 청구하는 건을 등록해보세요."
                  : "이 조건에 맞는 정기 청구가 없어요."}
              </td></tr>
            )}
            {ruleRows.map(r => {
              const s = cycSummary.get(r.id)
              return (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.45 }}>
                <td className="fw-700">
                  {r.vendor}
                  {r.contractId && <ContractBadge name={r.contractName} onGo={goRoute && (() => goRoute('contract_sales'))}/>}
                </td>
                <td className="text-sm">
                  {r.item || "—"}
                  {r.contractName && <div className="text-xs text-muted">계약: {r.contractName}</div>}
                </td>
                <td className="num-cell num-right">{fmtNum(totalOf(r))}</td>
                <td className="text-sm">{PERIOD_LABEL[r.period]} {r.dayOfMonth}일</td>
                <td className="text-sm">
                  {r.active ? (s?.next || "—") : "—"}
                  {s?.overdue > 0 && (
                    <span className="badge neg" style={{ marginLeft: 6, fontSize: 10 }}>미처리 {s.overdue}</span>
                  )}
                </td>
                <td><span className={`badge ${r.active ? "pos" : "outline"}`}>{r.active ? "활성" : "비활성"}</span></td>
                <td>
                  <div className="row gap-6">
                    <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => openEdit(r)}>수정</button>
                    <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => handleToggle(r.id)}>
                      {r.active ? "중지" : "재개"}
                    </button>
                    <button className="btn" style={{ fontSize: 11, padding: "3px 8px", color: "var(--neg-ink)" }}
                      onClick={() => handleDelete(r)}>삭제</button>
                  </div>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <RecurringInvoiceFormDrawer open={formOpen} editing={editing} onClose={() => setFormOpen(false)}
        vendors={vendors} contracts={contracts} accounts={accounts} reloadVendors={reloadVendors}
        onSave={async (data) => {
          const res = editing ? await api.updateRecurringInvoice(editing.id, data) : await api.addRecurringInvoice(data)
          toast.push(res?.ok === false ? (res.error || "저장에 실패했어요") : (editing ? "정기 청구를 수정했어요" : "정기 청구가 등록됐어요"),
                     res?.ok === false ? { tone: "warn" } : undefined)
          load(); cyc.reload()
        }}/>
      {/* 기입금 처리 — 정기지출과 같은 공용 드로어(계좌·날짜 필수) */}
      <PaidIssueDrawer target={cyc.paidTarget} isIssued
        onIssuePaid={cyc.issuePaid} onClose={cyc.closePaid} onDone={cyc.donePaid}/>
    </div>
  )
}

// ── 사용자 / 계정 관리 패널 ────────────────────────────────────────
// 결재선 프리셋 — 자주 쓰는 결재 단계(담당→결재→대표)를 저장해두고 결의서에서 골라 쓴다.
// 단계의 직위는 인사 기준정보 직위(hr pos)에서 고르거나 직접 입력.
const ApprovalPanel = ({ embedded = false }) => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [presets, setPresets] = useState([]);
  const [positions, setPositions] = useState([]);
  const [editing, setEditing] = useState(null);   // { id?, name, steps, is_default }

  const load = () => api.getApprovalPresets().then(setPresets);
  useEffect(() => {
    load();
    api.getHrCodes('pos').then(list => setPositions(list.map(p => p.name)));
  }, []);

  const startNew = () => setEditing({ name: '', steps: [{ label: '담당', position: '' }], is_default: false });
  const startEdit = (p) => setEditing({ id: p.id, name: p.name, steps: p.steps.length ? p.steps : [{ label: '', position: '' }], is_default: p.is_default });

  const setStep = (i, key, val) => setEditing(e => ({ ...e, steps: e.steps.map((s, j) => j === i ? { ...s, [key]: val } : s) }));
  const addStep = () => setEditing(e => ({ ...e, steps: [...e.steps, { label: '', position: '' }] }));
  const removeStep = (i) => setEditing(e => ({ ...e, steps: e.steps.filter((_, j) => j !== i) }));

  const save = async () => {
    if (!editing.name.trim()) return toast.push('프리셋 이름을 입력해주세요');
    const steps = editing.steps.filter(s => s.label.trim());
    if (steps.length === 0) return toast.push('결재 단계를 하나 이상 넣어주세요');
    const body = { name: editing.name.trim(), steps, is_default: editing.is_default };
    const res = editing.id ? await api.updateApprovalPreset(editing.id, body) : await api.addApprovalPreset(body);
    if (!res.ok) return toast.push(res.error || '저장에 실패했어요', { tone: 'warn' });
    toast.push('저장했어요'); setEditing(null); load();
  };
  const remove = async (p) => {
    const ok = await confirm({ tone: 'neg', title: '프리셋 삭제', body: `"${p.name}" 결재선을 삭제할까요?`, confirmLabel: '삭제' });
    if (!ok) return;
    await api.deleteApprovalPreset(p.id); toast.push('삭제됐어요'); load();
  };
  const makeDefault = async (p) => { await api.setDefaultApprovalPreset(p.id); toast.push(`"${p.name}"을 기본으로 지정했어요`); load(); };

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        {!embedded && <div className="section-title">결재선</div>}
        <button className="btn primary ml-auto" onClick={startNew}><Icon.Plus size={14}/> 새 결재선</button>
      </div>
      <div className="text-sm text-muted" style={{ marginBottom: 16 }}>
        지급결의서에 쓰는 결재 단계를 저장해두는 곳이에요. 결의서 만들 때 <b>기본</b> 결재선이 자동으로 붙고, 골라 바꿀 수 있어요. 직위는 인사 기준정보의 직위에서 고르거나 직접 입력하세요.
      </div>

      <div className="col gap-10">
        {presets.length === 0 && <div className="text-sm text-muted2" style={{ padding: 20, textAlign: 'center' }}>등록된 결재선이 없어요.</div>}
        {presets.map(p => (
          <div key={p.id} className="card card-pad">
            <div className="row gap-8" style={{ alignItems: 'center' }}>
              <span className="fw-700">{p.name}</span>
              {p.is_default && <span className="badge pos"><span className="dot"/>기본</span>}
              <div className="ml-auto row gap-6">
                {!p.is_default && <button className="btn ghost sm" onClick={() => makeDefault(p)}>기본으로</button>}
                <button className="btn ghost sm" onClick={() => startEdit(p)}><Icon.Pencil size={13}/></button>
                <button className="btn ghost sm" style={{ color: 'var(--neg)' }} onClick={() => remove(p)}><Icon.Trash size={13}/></button>
              </div>
            </div>
            <div className="row gap-6" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              {p.steps.map((s, i) => (
                <span key={i} className="badge outline">
                  {s.label}{s.position ? ` · ${s.position}` : ''}
                  {i < p.steps.length - 1 && <span style={{ margin: '0 2px', opacity: 0.5 }}>→</span>}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <Drawer open={true} onClose={() => setEditing(null)} width="min(460px,100vw)" label="결재선 편집">
          <DrawerHead title={editing.id ? '결재선 수정' : '새 결재선'} onClose={() => setEditing(null)}/>
          <div className="drawer-body col gap-form">
            <div>
              <label className="label" style={{ marginBottom: 8 }}>이름 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
              <input className="input" value={editing.name} onChange={e => setEditing(v => ({ ...v, name: e.target.value }))} placeholder="예: 일반 지출 결재선"/>
            </div>
            <div>
              <label className="label" style={{ marginBottom: 8 }}>결재 단계 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 왼쪽부터 순서대로</span></label>
              <div className="col gap-8">
                {editing.steps.map((s, i) => (
                  <div key={i} className="row gap-6" style={{ alignItems: 'center' }}>
                    <input className="input" style={{ width: 100 }} value={s.label} onChange={e => setStep(i, 'label', e.target.value)} placeholder="단계(담당)"/>
                    <div style={{ flex: 1 }}>
                      <Combobox value={s.position} onChange={v => setStep(i, 'position', v)}
                        options={positions.map(p => ({ value: p, label: p }))}
                        placeholder="직위 (선택/직접입력)"
                        onAddNew={(q) => setStep(i, 'position', q)} addNewLabel="이 직위로 입력"/>
                    </div>
                    <button className="icon-btn" onClick={() => removeStep(i)}><Icon.Close size={13}/></button>
                  </div>
                ))}
              </div>
              <button className="btn sm" style={{ marginTop: 8 }} onClick={addStep}><Icon.Plus size={12}/> 단계 추가</button>
            </div>
            <label className="row gap-8" style={{ alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={editing.is_default} onChange={e => setEditing(v => ({ ...v, is_default: e.target.checked }))}/>
              <span className="text-sm">이 결재선을 기본으로 (새 결의서에 자동 적용)</span>
            </label>
          </div>
          <DrawerFooter onCancel={() => setEditing(null)} onSave={save}/>
        </Drawer>
      )}
    </div>
  );
};

const UserPanel = ({ currentUser, embedded = false }) => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const isAdmin = currentUser?.role === 'admin';
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: "", name: "", password: "", role: "user" });
  const [pwTarget, setPwTarget] = useState(null);
  const [newPw, setNewPw] = useState("");
  // 역할 = 권한 묶음(마스터·실무·조회전용). users.role(admin/user)은 '계정 관리 권한'이라 별개다.
  const [roles, setRoles] = useState([]);
  const [rolesError, setRolesError] = useState("");
  const [roleTarget, setRoleTarget] = useState(null);   // 역할 배정 중인 사용자
  const [pickedRoles, setPickedRoles] = useState([]);

  const load = () => api.getUsers().then(setUsers);
  const loadRoles = () => api.getRoles()
    .then(rs => { setRoles(rs); setRolesError("") })
    .catch(e => setRolesError(e.message || "역할 목록을 불러오지 못했어요"));
  useEffect(() => { load(); if (isAdmin) loadRoles() }, [isAdmin]);

  const openRoles = (u) => { setRoleTarget(u); setPickedRoles(u.roleIds || []); };
  const saveRoles = async () => {
    if (!roleTarget) return;
    const res = await api.setUserRoles(roleTarget.id, pickedRoles);
    if (!res.ok) return toast.push(res.error || "역할 변경에 실패했어요", { tone: 'warn' });
    toast.push(`${roleTarget.name || roleTarget.username} 역할을 변경했어요`);
    setRoleTarget(null); load();
  };

  const add = async () => {
    const username = form.username.trim();
    if (!username || !form.password.trim()) return toast.push("아이디와 비밀번호를 입력하세요");
    if (form.password.length < 4) return toast.push("비밀번호는 4자 이상으로 해주세요");
    const res = await api.addUser({ username, password: form.password, name: form.name.trim(), role: form.role });
    if (res.ok) { toast.push("계정이 추가됐어요"); setForm({ username: "", name: "", password: "", role: "user" }); load(); }
    else toast.push(res.error || "추가에 실패했어요 (아이디 중복일 수 있어요)", { tone: 'warn' });
  };

  const openPw = (u) => { setPwTarget(u); setNewPw(""); };
  const savePw = async () => {
    if (!pwTarget) return;
    if (newPw.length < 4) return toast.push("비밀번호는 4자 이상으로 해주세요");
    const res = await api.updateUserPassword(pwTarget.id, newPw);
    if (res.ok) { toast.push(`${pwTarget.name || pwTarget.username} 비밀번호를 변경했어요`); setPwTarget(null); setNewPw(""); }
    else toast.push(res.error || "변경에 실패했어요", { tone: 'warn' });
  };

  const toggleActive = async (u) => {
    if (u.id === currentUser?.id) return toast.push("본인 계정은 비활성화할 수 없어요");
    const next = !u.active;
    if (!next) {
      const ok = await confirm({ tone: "neg", icon: <Icon.Warn size={22}/>, title: `"${u.name || u.username}" 비활성화`, body: "이 계정은 로그인할 수 없게 됩니다. 언제든 다시 활성화할 수 있어요.", confirmLabel: "비활성화" });
      if (!ok) return;
    }
    const res = await api.setUserActive(u.id, next);
    if (res.ok) { toast.push(next ? "활성화됐어요" : "비활성화됐어요"); load(); }
    else toast.push("변경에 실패했어요", { tone: 'warn' });
  };

  const changeRole = async (u) => {
    if (u.id === currentUser?.id) return toast.push("본인 권한은 변경할 수 없어요");
    const next = u.role === "admin" ? "user" : "admin";
    const ok = await confirm({
      tone: next === "admin" ? undefined : "neg",
      icon: <Icon.Warn size={22}/>,
      title: `"${u.name || u.username}" 권한 변경`,
      body: next === "admin"
        ? "이 계정을 관리자로 승격합니다. 모든 계정을 추가·관리할 수 있게 돼요."
        : "이 계정을 일반 사용자로 변경합니다. 계정 관리 권한이 사라져요.",
      confirmLabel: next === "admin" ? "관리자로" : "일반으로",
    });
    if (!ok) return;
    const res = await api.setUserRole(u.id, next);
    if (res.ok) { toast.push("권한을 변경했어요"); load(); }
    else toast.push(res.error || "변경에 실패했어요", { tone: 'warn' });
  };

  const pwDrawer = (
    <Drawer open={!!pwTarget} onClose={() => setPwTarget(null)}>
      <DrawerHead title="비밀번호 변경" sub={pwTarget?.name || pwTarget?.username} onClose={() => setPwTarget(null)}/>
      <div className="drawer-body col gap-form">
        <div>
          <label className="label">새 비밀번호</label>
          <input className="input" type="text" value={newPw} autoFocus
            onChange={e => setNewPw(e.target.value)}
            onKeyDown={e => e.key === "Enter" && savePw()}
            placeholder="새 비밀번호 (4자 이상)"/>
        </div>
        <div className="text-xs text-muted2" style={{ marginTop: 8 }}>변경 후 해당 사용자는 새 비밀번호로 다시 로그인해야 해요.</div>
      </div>
      <DrawerFooter onCancel={() => setPwTarget(null)} onSave={savePw} saveLabel="변경"/>
    </Drawer>
  );

  const roleDrawer = (
    <Drawer open={!!roleTarget} onClose={() => setRoleTarget(null)}>
      <DrawerHead title="역할 배정" sub={roleTarget?.name || roleTarget?.username} onClose={() => setRoleTarget(null)}/>
      <div className="drawer-body col gap-form">
        <div className="text-sm text-muted" style={{ lineHeight: 1.6 }}>
          역할은 이 사람이 <b>볼 수 있는 화면과 할 수 있는 일</b>을 정해요. 여러 개를 함께 줄 수 있고,
          그 경우 권한은 합쳐집니다.
        </div>
        <div className="col gap-8">
          {/* 못 불러온 것과 '진짜 하나도 없는 것'은 다르다. 전자를 후자로 보여주면
              역할이 지워진 줄 알고 새로 만들게 된다. */}
          {rolesError && (
            <div className="text-sm" style={{ color: "var(--neg-ink)", lineHeight: 1.6 }}>
              역할 목록을 불러오지 못했어요 — {rolesError}
              <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={loadRoles}>다시 시도</button>
            </div>
          )}
          {!rolesError && roles.length === 0 && <div className="text-sm text-muted2">역할이 없어요.</div>}
          {roles.map(r => {
            const on = pickedRoles.includes(r.id);
            return (
              <button key={r.id} type="button" className="card" style={{
                  padding: "12px 14px", textAlign: "left", cursor: "pointer",
                  borderColor: on ? "var(--brand)" : undefined,
                  background: on ? "var(--brand-weak, var(--surface-2))" : undefined,
                }}
                onClick={() => setPickedRoles(p => on ? p.filter(x => x !== r.id) : [...p, r.id])}>
                <div className="row" style={{ alignItems: "center", gap: 8 }}>
                  <span className="fw-700">{r.name}</span>
                  {!!r.is_system && <span className="badge outline text-xs">기본</span>}
                  {on && <Icon.Check size={16} style={{ marginLeft: "auto", color: "var(--brand)" }}/>}
                </div>
                {/* 권한 개수(275개…)는 사람이 판단할 수 있는 정보가 아니다 — 그 숫자로는
                    뭘 할 수 있는지 알 수 없어 역할을 고를 근거가 못 된다. 무엇이 되고
                    무엇이 안 되는지를 문장으로 보여준다. */}
                <div className="text-xs text-muted" style={{ marginTop: 4, lineHeight: 1.55 }}>
                  {r.description || "설명이 없는 역할이에요."}
                </div>
                {r.user_count > 0 && (
                  <div className="text-xs text-muted2" style={{ marginTop: 4 }}>지금 {r.user_count}명이 쓰고 있어요</div>
                )}
              </button>
            );
          })}
        </div>
        {pickedRoles.length === 0 && (
          <div className="text-xs" style={{ color: "var(--warn, var(--muted-2))", lineHeight: 1.6 }}>
            역할을 하나도 주지 않으면 <b>제한 없이 모든 화면</b>을 볼 수 있어요. 제한하려면 하나 이상 골라주세요.
          </div>
        )}
      </div>
      <DrawerFooter onCancel={() => setRoleTarget(null)} onSave={saveRoles} saveLabel="저장"/>
    </Drawer>
  );

  // 일반 사용자 — 본인 비밀번호만 변경 가능
  if (!isAdmin) {
    return (
      <div>
        <div className="row" style={{ padding: "16px 18px", borderBottom: "1px solid var(--line)" }}>
          <div>
            {!embedded && <div className="section-title">내 계정</div>}
            <div className="section-sub">비밀번호를 변경할 수 있어요. 계정 추가·권한 관리는 관리자 권한이 필요합니다.</div>
          </div>
        </div>
        <div style={{ padding: 20 }}>
          <div className="card" style={{ padding: 18, maxWidth: 420 }}>
            <div className="fw-700" style={{ marginBottom: 2 }}>{currentUser?.displayName || "나"}</div>
            <div className="text-sm text-muted" style={{ marginBottom: 16 }}>일반 사용자</div>
            <button className="btn primary" onClick={() => openPw({ id: currentUser.id, name: currentUser.displayName })}>비밀번호 변경</button>
          </div>
        </div>
        {pwDrawer}
      </div>
    );
  }

  // 관리자 — 전체 계정 관리
  return (
    <div>
      <div className="row" style={{ padding: "16px 18px", borderBottom: "1px solid var(--line)", flexWrap: "wrap", gap: 10 }}>
        <div>
          {!embedded && <div className="section-title">사용자</div>}
          <div className="section-sub">로그인 계정을 만들고 권한·비밀번호를 관리하세요. (관리자 전용)</div>
        </div>
      </div>

      <div style={{ padding: 20 }}>
        {/* 계정 추가 */}
        <div className="card" style={{ padding: 14, marginBottom: 22 }}>
          <div className="row gap-8" style={{ flexWrap: "wrap", alignItems: "center" }}>
            <input className="input" style={{ width: 150 }} value={form.username}
              onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="아이디"/>
            <input className="input" style={{ width: 130 }} value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="이름"/>
            <input className="input" style={{ width: 170 }} value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              onKeyDown={e => e.key === "Enter" && add()} placeholder="비밀번호 (4자 이상)"/>
            <div className="row gap-4">
              {[["user", "일반 사용자"], ["admin", "관리자"]].map(([r, lbl]) => (
                <button key={r} type="button" className={`chip ${form.role === r ? "active" : ""}`} onClick={() => setForm(f => ({ ...f, role: r }))}>{lbl}</button>
              ))}
            </div>
            <button className="btn primary" onClick={add}><Icon.Plus size={14}/> 계정 추가</button>
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 8 }}>· 관리자는 모든 계정을 관리할 수 있고, 일반 사용자는 본인 비밀번호만 바꿀 수 있어요.</div>
        </div>

        {/* 계정 목록 */}
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="table">
            <thead><tr><th>이름</th><th>아이디</th><th style={{ width: 100 }}>계정 권한</th><th style={{ width: 190 }}>역할(화면 권한)</th><th style={{ width: 90 }}>상태</th><th style={{ width: 300 }}></th></tr></thead>
            <tbody>
              {users.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", padding: 28, color: "var(--muted-2)", fontSize: 13 }}>계정이 없어요. 위에서 추가하세요.</td></tr>}
              {users.map(u => (
                <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                  <td className="fw-700">{u.name || u.username}{u.id === currentUser?.id && <span className="text-xs text-muted2" style={{ marginLeft: 6 }}>(나)</span>}</td>
                  <td className="text-sm text-muted">{u.username}</td>
                  <td><span className={`badge ${u.role === "admin" ? "ink" : "outline"}`}>{u.role === "admin" ? "관리자" : "일반"}</span></td>
                  <td>
                    {(u.roleNames || []).length
                      ? <div className="row gap-4" style={{ flexWrap: "wrap" }}>
                          {u.roleNames.map(n => <span key={n} className="badge outline">{n}</span>)}
                        </div>
                      /* 역할이 없으면 서버가 제한을 걸지 않는다 — 조용한 전체 허용이라 눈에 띄게 표시한다 */
                      : <span className="badge warn" title="역할이 없으면 모든 화면을 볼 수 있어요">미지정(전체 허용)</span>}
                  </td>
                  <td><span className={`badge ${u.active ? "pos" : "outline"}`}>{u.active ? "활성" : "비활성"}</span></td>
                  <td>
                    <div className="row gap-4">
                      <button className="btn ghost sm" disabled={u.id === currentUser?.id}
                        style={{ color: u.id === currentUser?.id ? "var(--muted-2)" : undefined }}
                        onClick={() => openRoles(u)}>역할</button>
                      <button className="btn ghost sm" onClick={() => openPw(u)}>비번 변경</button>
                      <button className="btn ghost sm" disabled={u.id === currentUser?.id}
                        style={{ color: u.id === currentUser?.id ? "var(--muted-2)" : undefined }}
                        onClick={() => changeRole(u)}>{u.role === "admin" ? "일반으로" : "관리자로"}</button>
                      <button className="btn ghost sm" disabled={u.id === currentUser?.id}
                        style={{ color: u.id === currentUser?.id ? "var(--muted-2)" : "var(--neg)" }}
                        onClick={() => toggleActive(u)}>{u.active ? "비활성화" : "활성화"}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="text-xs text-muted2" style={{ marginTop: 10, lineHeight: 1.7 }}>
          · <b>계정 권한</b>(관리자/일반)은 계정을 만들고 관리할 수 있는지를 정해요.<br/>
          · <b>역할</b>은 어떤 화면을 보고 무엇을 할 수 있는지를 정해요. 역할을 하나도 주지 않으면 제한 없이 전부 볼 수 있어요.
        </div>
      </div>
      {pwDrawer}
      {roleDrawer}
    </div>
  );
};

/* 월 마감 — 부가세 신고·월 마감을 끝낸 달의 장부를 잠근다.
   잠근 달의 거래는 등록·수정·삭제가 서버에서 막힌다(lib/closing.js). 되돌리려면 해제. */
const ClosingPanel = ({ embedded = false }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState([])
  const [period, setPeriod] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 1)   // 보통 마감하는 건 지난달
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [memo, setMemo] = useState('')

  const load = () => api.getClosings().then(setRows)
  useEffect(() => { load() }, [])

  const close = async () => {
    const res = await api.closePeriod(period, memo)
    if (!res.ok) return toast.push(res.error || '마감에 실패했어요', { tone: 'warn' })
    toast.push(`${period} 장부를 마감했어요`); setMemo(''); load()
  }
  const reopen = async (p) => {
    const ok = await confirm({
      tone: 'warn', icon: <Icon.Warn size={22}/>, title: `${p} 마감 해제`,
      body: '해제하면 이 달의 거래를 다시 고칠 수 있어요. 이미 제출한 신고자료와 장부가 어긋날 수 있으니 주의하세요.',
      confirmLabel: '해제',
    })
    if (!ok) return
    const res = await api.reopenPeriod(p)
    if (!res.ok) return toast.push(res.error || '해제에 실패했어요', { tone: 'warn' })
    toast.push(`${p} 마감을 해제했어요`); load()
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 16 }}>
        {!embedded && <div className="section-title">월 마감</div>}
        <div className="section-sub">
          부가세 신고나 월 결산을 끝낸 달을 잠급니다. 잠근 달의 거래는 등록·수정·삭제가 막혀,
          이미 제출한 자료와 장부가 어긋나지 않아요.
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row gap-12" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ width: 170 }}>
            <label className="label" style={{ marginBottom: 8 }}>마감할 달</label>
            <input className="input" type="month" value={period} onChange={e => setPeriod(e.target.value)}/>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label className="label" style={{ marginBottom: 8 }}>메모 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
            <input className="input" value={memo} placeholder="예: 1기 예정 부가세 신고 완료" onChange={e => setMemo(e.target.value)}/>
          </div>
          <button className="btn primary" onClick={close}><Icon.Check size={14}/> 마감</button>
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="table">
          <thead><tr><th style={{ width: 120 }}>마감한 달</th><th>메모</th><th style={{ width: 150 }}>마감 시각</th><th style={{ width: 90 }}></th></tr></thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: 'center', padding: 32, color: 'var(--muted-2)' }}>마감한 달이 없어요.</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id}>
                <td className="fw-600 num">{r.period}</td>
                <td className="text-sm text-muted">{r.memo || '—'}</td>
                <td className="text-sm text-muted2 num">{minuteOf(r.created_at)}</td>
                <td>
                  <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => reopen(r.period)}>해제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export const MasterScreen = ({ user, section = "base", forcedTab }) => {
  const toast = useToast();
  const sectionCfg = MASTER_SECTIONS[section] || MASTER_SECTIONS.base;
  const allowedTabs = sectionCfg.groups.flatMap(g => g.tabs);
  const [tab, setTab] = useState(allowedTabs[0]);
  // forcedTab(사이드바 서브메뉴로 진입)이면 그 탭 고정 + 내부 서브내브 숨김 + 전체폭.
  // 없으면 기존 탭 방식(내부 서브내브). 라우트 변경으로 탭이 이 섹션에 없으면 첫 탭 폴백.
  // 잘못된 forcedTab(오타 라우트·구버전 해시)은 이 섹션 탭이 아니면 무시 — data.label 등에서 화면 전체가 크래시하지 않게.
  const forced = forcedTab && allowedTabs.includes(forcedTab) ? forcedTab : null;
  const activeTab = forced || (allowedTabs.includes(tab) ? tab : allowedTabs[0]);
  const single = !!forced;
  const [q, setQ] = useState("");
  const [drawer, setDrawer] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [userRows,     setUserRows]     = useState([]);

  useEffect(() => {
    api.getUsers().then(list =>
      setUserRows(list.map(u => [u.name || u.username, u.username, u.role === 'admin' ? '관리자' : '일반 사용자', u.active ? '활성' : '비활성']))
    )
  }, []);

  const isCustomTab = ["account", "accountBalance", "recurringExpense", "recurringInvoice", "payroll", "payrollItems", "employType", "accountSubject", "category", "vendor", "department", "position", "company", "user", "approval", "jeokyo", "item", "insurance", "fixed_asset", "intangible_asset", "evidence_type", "closing"].includes(activeTab)
  const data = !isCustomTab ? MASTER_DATA[activeTab] : null
  const rawRows = activeTab === "user" ? userRows : (data?.rows || [])
  const rows = rawRows.filter(r => !q || r.some(c => String(c).toLowerCase().includes(q.toLowerCase())));

  const toggleGroup = (name) => setCollapsed(c => ({ ...c, [name]: !c[name] }));

  const renderCustomPanel = () => {
    if (REF_CONFIGS[activeTab])           return <RefMasterPanel key={activeTab} cfg={REF_CONFIGS[activeTab]} embedded={single}/>
    if (activeTab === "vendor")           return <VendorPanel embedded={single}/>
    if (activeTab === "account")          return <AccountPanel embedded={single}/>
    if (activeTab === "company")          return <CompanyPanel embedded={single}/>
    if (activeTab === "accountSubject")   return <AccountSubjectPanel embedded={single}/>
    if (activeTab === "category")         return <CategoryPanel embedded={single}/>
    if (activeTab === "accountBalance")   return <AccountBalancePanel embedded={single}/>
    if (activeTab === "recurringExpense") return <RecurringExpensePanel/>
    if (activeTab === "recurringInvoice") return <RecurringInvoicePanel/>
    if (activeTab === "payrollItems")     return <PayrollItemPanel embedded={single}/>
    if (activeTab === "employType")       return <EmployTypePanel embedded={single}/>
    if (activeTab === "user")             return <UserPanel currentUser={user} embedded={single}/>
    if (activeTab === "approval")         return <ApprovalPanel embedded={single}/>
    if (activeTab === "closing")          return <ClosingPanel embedded={single}/>
    if (activeTab === "department")       return <HrCodePanel type="dept" label="부서" embedded={single}/>
    if (activeTab === "position")         return <HrCodePanel type="pos"  label="직위" embedded={single}/>
    return null
  }

  return (
    <div className="fade-up">
      <PageHeader
        title={single ? (TAB_BY_ID[activeTab]?.label || sectionCfg.title) : sectionCfg.title}
        actions={!isCustomTab && data && (
          <>
            <button className="btn" onClick={() => toast.push(`${data.label} 양식을 내려받았어요`)}><Icon.Download/> <span className="btn-label-hide">양식 다운로드</span></button>
            <button className="btn" onClick={() => toast.push(`${data.label} 일괄 업로드 창을 열었어요`)}><Icon.Excel/> <span className="btn-label-hide">일괄 업로드</span></button>
            <button className="btn primary" onClick={() => setDrawer("new")}><Icon.Plus/> {data.label} 등록</button>
          </>
        )}
      />

      <div className="master-layout" style={{ display: "grid", gridTemplateColumns: single ? "1fr" : "200px 1fr", gap: 16, alignItems: "start" }}>
        {/* Sub-nav (섹션별 그룹) — 사이드바 서브메뉴로 진입한 단일 탭 모드에선 숨김(전체폭) */}
        {!single && <div className="card" style={{ padding: 8 }}>
          {sectionCfg.groups.map((group, gi) => (
            <div key={group.label} style={{ marginTop: gi ? 10 : 0 }}>
              <div className="nav-group-label" style={{ padding: "6px 10px 4px" }}>{group.label}</div>
              {group.tabs.map(id => {
                const t = TAB_BY_ID[id];
                if (!t) return null;
                const active = activeTab === t.id;
                const md = MASTER_DATA[t.id];
                let count = "";
                if (t.custom || t.id === "payroll") {
                  count = "";
                } else if (t.id === "user") {
                  count = userRows.length;
                } else if (md?.grouped) {
                  count = md.groups.reduce((a, g) => a + g.items.length, 0);
                } else if (md?.rows) {
                  count = md.rows.length;
                }
                return (
                  <button key={t.id}
                    className={`nav-item ${active ? "active" : ""}`}
                    style={{ width: "100%", justifyContent: "flex-start" }}
                    onClick={() => { setTab(t.id); setQ(""); }}>
                    <span>{t.label}</span>
                    {count !== "" && <span className="nav-count" style={{ marginLeft: "auto" }}>{count}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>}

        {/* Right panel */}
        <div className="card" style={{ overflow: "hidden" }}>
          {isCustomTab ? (
            renderCustomPanel()
          ) : (
            <>
              <div className="row" style={{ padding: "16px 18px", borderBottom: "1px solid var(--line)", flexWrap: "wrap", gap: 10 }}>
                <div>
                  <div className="section-title">{data.label}</div>
                  <div className="section-sub">
                    {data.grouped
                      ? `${data.groups.length}개 계정과목 · 총 ${data.rows.length}건`
                      : `총 ${rawRows.length}건 등록됨`}
                  </div>
                </div>
                <div className="ml-auto row gap-8" style={{ flexWrap: "wrap" }}>
                  <div className="search" style={{ margin: 0, width: 200, padding: "6px 10px" }}>
                    <Icon.Search size={14}/>
                    <input value={q} onChange={e => setQ(e.target.value)} placeholder={`${data.label} 검색`}/>
                  </div>
                  <button className="btn"><Icon.Filter/> 필터</button>
                </div>
              </div>

              <div className="table-scroll">
                {data.grouped ? (
                  <GroupedTable
                    data={data}
                    q={q}
                    collapsed={collapsed}
                    toggleGroup={toggleGroup}
                    onEdit={(g, idx) => setDrawer({ group: g.name, item: idx })}
                    onDelete={(name) => toast.push(`${name} 삭제됨`)}
                  />
                ) : (
                  <FlatTable
                    data={data}
                    rows={rows}
                    onEdit={(i) => setDrawer(i)}
                    onDelete={(name) => toast.push(`${name} 삭제됨`)}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {!isCustomTab && data && (
        <MasterDrawer
          open={drawer !== null}
          mode={drawer === "new" ? "new" : "edit"}
          category={data}
          rowIndex={typeof drawer === "number" ? drawer : null}
          groupedSel={drawer && typeof drawer === "object" ? drawer : null}
          onClose={() => setDrawer(null)}
          onSave={() => { setDrawer(null); toast.push(drawer === "new" ? `새 ${data.label}을(를) 등록했어요` : `${data.label} 정보를 저장했어요`); }}
        />
      )}
    </div>
  );
};

const FlatTable = ({ data, rows, onEdit, onDelete }) => (
  <table className="table">
    <thead>
      <tr>
        {data.columns.map(c => <th key={c}>{c}</th>)}
        <th style={{ width: 80 }}></th>
      </tr>
    </thead>
    <tbody>
      {rows.map((r, i) => (
        <tr key={i} style={{ cursor: "pointer" }} onClick={() => onEdit(i)}>
          {r.map((cell, j) => {
            const colName = data.columns[j];
            if (colName === "상태") return <td key={j}><StatusBadge status={cell}/></td>;
            if (j === 0) return <td key={j} className="fw-600">{cell}</td>;
            return <td key={j} className={/번호|금액|잔액|연락처/.test(colName) ? "num text-sm" : "text-sm"} style={{ color: cell === "—" ? "var(--muted-2)" : undefined }}>{cell}</td>;
          })}
          <td>
            <div className="row gap-4">
              <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onEdit(i); }}>편집</button>
              <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onDelete(r[0]); }}><Icon.Close size={14}/></button>
            </div>
          </td>
        </tr>
      ))}
      {rows.length === 0 && (
        <tr><td colSpan={data.columns.length + 1} style={{ textAlign: "center", padding: 40, color: "var(--muted-2)" }}>
          검색 결과가 없어요.
        </td></tr>
      )}
    </tbody>
  </table>
);

const GroupedTable = ({ data, q, collapsed, toggleGroup, onEdit, onDelete }) => {
  const filterMatch = (r, gName, topName) =>
    !q ||
    r.some(c => String(c).toLowerCase().includes(q.toLowerCase())) ||
    gName.includes(q) ||
    (topName && topName.includes(q));

  if (data.twoLevel) {
    const tops = [...new Set(data.groups.map(g => g.top))];
    return (
      <div>
        {tops.map((top) => {
          const subGroups = data.groups.filter(g => g.top === top);
          const totalItems = subGroups.reduce((a, g) => a + g.items.length, 0);
          const topKey = `top:${top}`;
          const isTopOpen = !collapsed[topKey];
          if (q) {
            const anyMatch = subGroups.some(g =>
              g.items.some(r => filterMatch(r, g.name, top))
            );
            if (!anyMatch) return null;
          }
          return (
            <div key={top}>
              <button onClick={() => toggleGroup(topKey)}
                style={{
                  width: "100%", textAlign: "left",
                  padding: "16px 18px",
                  background: top === "수익" ? "#F0F8F3" : "#FFF8EE",
                  borderBottom: "1px solid var(--line)", borderTop: "1px solid var(--line)",
                  cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                  fontFamily: "inherit",
                }}>
                <span style={{ transform: isTopOpen ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-flex", color: "var(--muted)" }}>
                  <Icon.Right size={14}/>
                </span>
                <span className={`badge ${top === "수익" ? "pos" : "warn"}`} style={{ padding: "2px 10px" }}>{top}</span>
                <span className="fw-700" style={{ fontSize: 14 }}>{top === "수익" ? "수익 계정" : "비용 계정"}</span>
                <span className="ml-auto text-xs text-muted2">{subGroups.length}개 계정과목 · {totalItems}개 비목</span>
              </button>
              {isTopOpen && subGroups.map((g) => {
                const groupKey = `mid:${g.name}`;
                const isMidOpen = !collapsed[groupKey];
                const filteredItems = g.items.filter(r => filterMatch(r, g.name, top));
                if (q && filteredItems.length === 0) return null;
                return (
                  <div key={g.name}>
                    <button onClick={() => toggleGroup(groupKey)}
                      style={{
                        width: "100%", textAlign: "left",
                        padding: "12px 18px 12px 42px",
                        background: "var(--surface-2)", border: 0,
                        borderBottom: "1px solid var(--line)",
                        cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
                        fontFamily: "inherit",
                      }}>
                      <span style={{ transform: isMidOpen ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-flex", color: "var(--muted-2)" }}>
                        <Icon.Right size={12}/>
                      </span>
                      <span className="fw-600" style={{ fontSize: 13 }}>{g.name}</span>
                      <span className="text-xs text-muted2" style={{ marginLeft: 4 }}>· {g.desc}</span>
                      <span className="ml-auto text-xs text-muted2 num">{g.items.length}건</span>
                    </button>
                    {isMidOpen && (
                      <table className="table" style={{ borderBottom: "1px solid var(--line)" }}>
                        <thead>
                          <tr>
                            {data.columns.map(c => <th key={c} style={{ background: "#fff", paddingLeft: c === data.columns[0] ? 66 : undefined }}>{c}</th>)}
                            <th style={{ width: 80, background: "#fff" }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredItems.map((r) => {
                            const idx = g.items.indexOf(r);
                            return (
                              <tr key={idx} style={{ cursor: "pointer" }} onClick={() => onEdit(g, idx)}>
                                {r.map((cell, j) => {
                                  const colName = data.columns[j];
                                  if (j === 0) return <td key={j} className="fw-600" style={{ paddingLeft: 66 }}>{cell}</td>;
                                  if (colName === "부가세") {
                                    const tone = cell === "면세" || cell === "—" ? "outline" : "brand";
                                    return <td key={j}><span className={`badge ${tone}`}>{cell}</span></td>;
                                  }
                                  return <td key={j} className={/코드/.test(colName) ? "num text-sm" : "text-sm"} style={{ color: cell === "—" ? "var(--muted-2)" : undefined }}>{cell}</td>;
                                })}
                                <td>
                                  <div className="row gap-4">
                                    <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onEdit(g, idx); }}>편집</button>
                                    <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onDelete(r[0]); }}><Icon.Close size={14}/></button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      {data.groups.map((g) => {
        const filtered = g.items.filter(r => filterMatch(r, g.name));
        if (q && filtered.length === 0) return null;
        const isOpen = !collapsed[g.name];
        return (
          <div key={g.name} style={{ borderTop: "1px solid var(--line)" }}>
            <button
              onClick={() => toggleGroup(g.name)}
              style={{
                width: "100%", textAlign: "left", padding: "14px 18px",
                background: "var(--surface-2)", border: 0,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                fontFamily: "inherit",
              }}>
              <span style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .15s", display: "inline-flex", color: "var(--muted)" }}>
                <Icon.Right size={14}/>
              </span>
              <span className="fw-700">{g.name}</span>
              <span className="text-xs text-muted" style={{ marginLeft: 4 }}>· {g.desc}</span>
              <span className="ml-auto text-xs text-muted2">{g.items.length}건</span>
            </button>
            {isOpen && (
              <table className="table">
                <thead>
                  <tr>
                    {data.columns.map(c => <th key={c} style={{ background: "#fff" }}>{c}</th>)}
                    <th style={{ width: 80, background: "#fff" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const idx = g.items.indexOf(r);
                    return (
                      <tr key={idx} style={{ cursor: "pointer" }} onClick={() => onEdit(g, idx)}>
                        {r.map((cell, j) => {
                          const colName = data.columns[j];
                          if (j === 0) return <td key={j} className="fw-600" style={{ paddingLeft: 44 }}>{cell}</td>;
                          if (colName === "부가세") { const tone = cell === "면세" || cell === "—" ? "outline" : "brand"; return <td key={j}><span className={`badge ${tone}`}>{cell}</span></td>; }
                          if (colName === "권한") return <td key={j}><span className={`badge ${cell === "관리자" ? "ink" : "outline"}`}>{cell}</span></td>;
                          if (colName === "결재 순번" && cell !== "—") return <td key={j}><span className="badge brand">{cell}</span></td>;
                          if (colName === "재직상태") return <td key={j}><StatusBadge status={cell}/></td>;
                          if (colName === "사번") return <td key={j} className="num text-sm" style={{ color: "var(--muted)" }}>{cell}</td>;
                          if (/입사일|퇴사일/.test(colName)) return <td key={j} className="num text-sm" style={{ color: cell === "—" ? "var(--muted-2)" : "var(--muted)" }}>{cell}</td>;
                          return <td key={j} className="text-sm" style={{ color: cell === "—" ? "var(--muted-2)" : undefined }}>{cell}</td>;
                        })}
                        <td>
                          <div className="row gap-4">
                            <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onEdit(g, idx); }}>편집</button>
                            <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onDelete(r[0]); }}><Icon.Close size={14}/></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
};

const MasterDrawer = ({ open, mode, category, rowIndex, groupedSel, onClose, onSave }) => {
  if (!open) return null;
  let row = null;
  let initialGroup = null;
  if (groupedSel) {
    const g = category.groups.find(gr => gr.name === groupedSel.group);
    row = g?.items[groupedSel.item];
    initialGroup = groupedSel.group;
  } else if (rowIndex != null) {
    row = category.rows[rowIndex];
  }
  const isEdit = mode === "edit";
  const title = mode === "new" ? `새 ${category.label} 등록` : `${category.label} 정보 편집`;

  return (
    <Drawer open={true} onClose={onClose} width="min(520px, 100vw)" label={title}>
        <DrawerHead title={title} sub={mode === "new"
                ? "필수 항목만 채우면 바로 등록할 수 있어요."
                : "변경한 내용은 즉시 반영됩니다."} onClose={onClose}/>

        <div className="drawer-body">
          <div className="col gap-form">
            {category.grouped && (
              <div>
                <label className="label">계정과목 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
                <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                  {category.groups.map(g => (
                    <button key={g.name} className={`chip ${initialGroup === g.name ? "active" : ""}`}>
                      {g.name}
                    </button>
                  ))}
                  <button className="chip"><Icon.Plus size={12}/> 새 계정과목</button>
                </div>
                <div className="text-xs text-muted2" style={{ marginTop: 6 }}>계정과목은 결의서·원가계산서에서 그룹 헤더로 사용돼요.</div>
              </div>
            )}

            {category.columns.map((c, i) => {
              const initial = row ? row[i] : "";
              const isStatus = c === "상태";
              const isLong = /설명|주소/.test(c);

              if (c === "부가세") {
                return (
                  <div key={c}>
                    <label className="label">{c}</label>
                    <div className="row gap-6">
                      {["10%", "면세", "—"].map(s => (
                        <button key={s} className={`chip ${initial === s ? "active" : ""}`}>{s}</button>
                      ))}
                    </div>
                  </div>
                );
              }
              if (c === "기본 결제수단") {
                return (
                  <div key={c}>
                    <label className="label">{c}</label>
                    <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                      {["계좌이체", "법인카드", "개인카드", "현금", "—"].map(s => (
                        <button key={s} className={`chip ${initial === s ? "active" : ""}`}>{s}</button>
                      ))}
                    </div>
                  </div>
                );
              }
              return (
                <div key={c}>
                  <label className="label">
                    {c} {i === 0 ? <span style={{ color: "var(--neg-ink)" }}>*</span> : null}
                  </label>
                  {isStatus ? (
                    <div className="row gap-6">
                      {["진행중", "보류", "완료"].map(s => (
                        <button key={s} className={`chip ${initial === s ? "active" : ""}`}>{s}</button>
                      ))}
                    </div>
                  ) : isLong ? (
                    <textarea className="input" rows={2} defaultValue={initial} style={{ resize: "vertical", fontFamily: "inherit" }}/>
                  ) : (
                    <input className="input" defaultValue={initial} placeholder={`${c}을(를) 입력하세요`}/>
                  )}
                </div>
              );
            })}

            {category.label === "거래처" && (
              <div>
                <label className="label">메모</label>
                <textarea className="input" rows={2} placeholder="거래처에 대한 메모를 자유롭게 적어주세요" style={{ resize: "vertical", fontFamily: "inherit" }}/>
              </div>
            )}

            {category.label === "계정과목 / 비목" && (
              <div className="alert-row" style={{ background: "var(--brand-soft)", borderColor: "transparent" }}>
                <Icon.Sparkle/>
                <div>
                  <div className="lead">계정과목·비목은 결의서·세무 자료에 그대로 표기돼요.</div>
                  <div className="body">사용 중인 비목은 삭제 대신 '비활성화'를 권장합니다.</div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="drawer-foot">
          {isEdit ? (
            <button className="btn" onClick={onClose} style={{ color: "var(--neg-ink)" }}>이 행 삭제</button>
          ) : (
            <button className="btn" onClick={onClose}>취소</button>
          )}
          <div className="ml-auto row gap-8">
            <button className="btn" onClick={onClose}>닫기</button>
            <button className="btn primary" onClick={onSave}><Icon.Check size={14}/> {mode === "new" ? "등록하기" : "저장하기"}</button>
          </div>
        </div>
    </Drawer>
  );
};

// 급여 항목 마스터: 지급(+)/공제(-) 표준 목록을 사용자가 직접 관리
const PayrollItemPanel = ({ embedded = false }) => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ label: "", kind: "earn", mode: "fixed", default_value: 0 });
  const [editingId, setEditingId] = useState(null);

  const load = () => api.getPayrollItemTypes().then(setItems);
  useEffect(() => { load() }, []);

  const reset = () => { setForm({ label: "", kind: "earn", mode: "fixed", default_value: 0 }); setEditingId(null); };
  const save = async () => {
    if (!form.label.trim()) return toast.push("항목명을 입력하세요");
    const res = editingId ? await api.updatePayrollItemType(editingId, form) : await api.addPayrollItemType(form);
    if (res.ok) { toast.push(editingId ? "수정됐어요" : "항목이 추가됐어요"); reset(); load(); }
    else toast.push("저장에 실패했어요", { tone: 'warn' });
  };
  const edit = (it) => { setEditingId(it.id); setForm({ label: it.label, kind: it.kind, mode: it.mode, default_value: Number(it.default_value) }); };
  const del = async (it) => {
    const ok = await confirm({ tone: "neg", icon: <Icon.Warn size={22}/>, title: `"${it.label}" 삭제`, body: "급여 항목 목록에서 제거됩니다. 이미 작성된 명세에는 영향이 없어요.", confirmLabel: "삭제" });
    if (ok) { await api.deletePayrollItemType(it.id); load(); toast.push("삭제됐어요"); }
  };

  const fmtVal = (it) => it.mode === "percent"
    ? `${Number(it.default_value)}%`
    : (Number(it.default_value) ? fmtNum(it.default_value) + "원" : "직접 입력");

  const Table = ({ kind, title, tone }) => {
    const list = items.filter(i => i.kind === kind);
    return (
      <div style={{ marginBottom: 26 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="text-xs fw-700" style={{ color: tone, letterSpacing: "0.02em" }}>{title} <span className="text-muted2" style={{ fontWeight: 500 }}>{list.length}개</span></div>
        </div>
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="table">
            <thead><tr><th>항목명</th><th style={{ width: 110 }}>방식</th><th className="num-right" style={{ width: 140 }}>기본값</th><th style={{ width: 120 }}></th></tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={4} style={{ textAlign: "center", padding: 28, color: "var(--muted-2)", fontSize: 13 }}>항목이 없어요. 위에서 추가하세요.</td></tr>}
              {list.map(it => (
                <tr key={it.id}>
                  <td className="fw-700">{it.label}</td>
                  <td className="text-sm text-muted">{it.mode === "percent" ? "% (요율)" : "원 (금액)"}</td>
                  <td className="num-cell num-right">{fmtVal(it)}</td>
                  <td>
                    <div className="row gap-4">
                      <button className="btn ghost sm" onClick={() => edit(it)}>편집</button>
                      <button className="btn ghost sm" style={{ color: "var(--neg)" }} onClick={() => del(it)}>삭제</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="row" style={{ padding: "16px 18px", borderBottom: "1px solid var(--line)", flexWrap: "wrap", gap: 10 }}>
        <div>
          {!embedded && <div className="section-title">급여 항목</div>}
          <div className="section-sub">매달 급여명세에 쓰는 지급(+)·공제(−) 항목을 직접 만들어두세요. 급여대장 생성 시 자동으로 채워집니다.</div>
        </div>
      </div>

      <div style={{ padding: 20 }}>
        {/* 추가/편집 입력줄 */}
        <div className="card" style={{ padding: 14, marginBottom: 22, border: editingId ? "1px solid var(--brand)" : "1px solid var(--line)" }}>
          <div className="row gap-8" style={{ flexWrap: "wrap", alignItems: "center" }}>
            <input className="input" style={{ flex: 1, minWidth: 150 }} value={form.label}
              onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              onKeyDown={e => e.key === "Enter" && save()}
              placeholder="항목명 (예: 야근수당, 연말정산)"/>
            <div className="row gap-4">
              {[["earn", "지급 +"], ["deduct", "공제 −"]].map(([k, lbl]) => (
                <button key={k} type="button" className={`chip ${form.kind === k ? "active" : ""}`} onClick={() => setForm(f => ({ ...f, kind: k }))}>{lbl}</button>
              ))}
            </div>
            <div className="row gap-4">
              {[["fixed", "원"], ["percent", "%"]].map(([m, lbl]) => (
                <button key={m} type="button" className={`chip ${form.mode === m ? "active" : ""}`} onClick={() => setForm(f => ({ ...f, mode: m }))}>{lbl}</button>
              ))}
            </div>
            <div style={{ position: "relative", width: 140 }}>
              <input className="input num fw-700" style={{ paddingRight: 26 }}
                value={form.mode === "percent" ? form.default_value : fmtNum(form.default_value)}
                onChange={e => {
                  const raw = e.target.value.replace(/[^0-9.]/g, "");
                  setForm(f => ({ ...f, default_value: f.mode === "percent" ? raw : (parseInt(raw.replace(/\./g, "")) || 0) }));
                }}/>
              <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted-2)", fontSize: 11 }}>{form.mode === "percent" ? "%" : "원"}</span>
            </div>
            <button className="btn primary" onClick={save}><Icon.Plus size={14}/> {editingId ? "수정" : "추가"}</button>
            {editingId && <button className="btn" onClick={reset}>취소</button>}
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 8 }}>· 기본값은 비워둬도 돼요(명세서에서 직접 입력). · %는 지급 고정금액 합계 기준으로 계산됩니다.</div>
        </div>

        <Table kind="earn"   title="지급 항목 (+)" tone="var(--brand-ink)"/>
        <Table kind="deduct" title="공제 항목 (−)" tone="var(--neg-ink)"/>
      </div>
    </div>
  );
};

// 고용형태 마스터 — 근로·용역계약의 유형별 기본값(소득구분·단가단위·보험·상용전환 기준).
// income_type만 세법이 정한 닫힌 값. 계약 등록 시 여기 기본값이 자동으로 채워진다.
const ET_KINDS = [["labor", "근로"], ["service", "용역"], ["daily", "일용"]];
const ET_INCOME = [["근로", "근로소득"], ["일용", "일용근로"], ["사업", "사업소득"], ["기타", "기타소득"]];
const ET_FORMS = [["annual", "연봉"], ["monthly", "월급"], ["hourly", "시급"], ["daily", "일당"], ["piece", "건당"]];
const emptyET = () => ({ label: "", kind: "labor", income_type: "근로", pay_form: "monthly", default_unit: "",
  insure_np: 1, insure_hi: 1, insure_ei: 1, insure_ai: 1, conv_alert_months: 0 });

const FieldRow = ({ label, hint, required, children }) => (
  <div>
    <div className="row" style={{ marginBottom: 6, gap: 6, alignItems: "baseline" }}>
      <span className="text-sm fw-700">{label}{required && <span style={{ color: "var(--neg)" }}> *</span>}</span>
      {hint && <span className="text-xs text-muted2">{hint}</span>}
    </div>
    {children}
  </div>
);

const EmployTypePanel = ({ embedded = false }) => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [types, setTypes] = useState([]);
  const [form, setForm] = useState(emptyET());
  const [editingId, setEditingId] = useState(null);
  const [open, setOpen] = useState(false);

  const load = () => api.getEmployTypes().then(setTypes);
  useEffect(() => { load() }, []);

  const reset = () => { setForm(emptyET()); setEditingId(null); setOpen(false); };
  const save = async () => {
    if (!form.label.trim()) return toast.push("고용형태 이름을 입력하세요");
    const res = editingId ? await api.updateEmployType(editingId, form) : await api.addEmployType(form);
    if (res.ok) { toast.push(editingId ? "수정됐어요" : "고용형태가 추가됐어요"); reset(); load(); }
    else toast.push(res.error || "저장에 실패했어요", { tone: 'warn' });
  };
  const edit = (t) => {
    setEditingId(t.id); setOpen(true);
    setForm({ label: t.label, kind: t.kind, income_type: t.income_type, pay_form: t.pay_form,
      default_unit: t.default_unit || "", insure_np: t.insure_np, insure_hi: t.insure_hi,
      insure_ei: t.insure_ei, insure_ai: t.insure_ai, conv_alert_months: Number(t.conv_alert_months) || 0 });
  };
  const del = async (t) => {
    const ok = await confirm({ tone: "neg", icon: <Icon.Warn size={22}/>, title: `"${t.label}" 삭제`,
      body: "고용형태 목록에서 제거됩니다. 이미 이 유형으로 맺은 계약은 그대로 유지돼요.", confirmLabel: "삭제" });
    if (ok) { await api.deleteEmployType(t.id); load(); toast.push("삭제됐어요"); }
  };

  const insBadges = (t) => ["insure_np", "insure_hi", "insure_ei", "insure_ai"]
    .map((k, i) => t[k] ? ["국민", "건강", "고용", "산재"][i] : null).filter(Boolean).join("·") || "—";
  const kindLabel = (k) => (ET_KINDS.find(x => x[0] === k) || [, k])[1];
  const formLabel = (f) => (ET_FORMS.find(x => x[0] === f) || [, f])[1];

  return (
    <div>
      <div className="row" style={{ padding: "16px 18px", borderBottom: "1px solid var(--line)", flexWrap: "wrap", gap: 10 }}>
        <div>
          {!embedded && <div className="section-title">고용형태</div>}
          <div className="section-sub">근로계약·용역·일용에서 쓰는 고용형태를 직접 만들어두세요. 계약을 등록할 때 소득구분·단가 단위·4대보험 적용이 자동으로 채워집니다.</div>
        </div>
        {!open && <button className="btn primary ml-auto" onClick={() => { setForm(emptyET()); setEditingId(null); setOpen(true); }}><Icon.Plus size={14}/> 고용형태 추가</button>}
      </div>

      <div style={{ padding: 20 }}>
        {open && (
          <div className="card" style={{ padding: 16, marginBottom: 22, border: editingId ? "1px solid var(--brand)" : "1px solid var(--line)" }}>
            <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <FieldRow label="고용형태 이름" required>
                <input className="input" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                  placeholder="예: 정규직, 일용(행사), 프리랜서"/>
              </FieldRow>
              <FieldRow label="구분 (화면 배치)">
                <div className="row gap-4">
                  {ET_KINDS.map(([k, lbl]) => (
                    <button key={k} type="button" className={`chip ${form.kind === k ? "active" : ""}`}
                      onClick={() => setForm(f => ({ ...f, kind: k }))}>{lbl}</button>
                  ))}
                </div>
              </FieldRow>
              <FieldRow label="소득구분 (세법)" hint="명세서·지급명세서 양식이 여기서 갈려요">
                <div className="row gap-4" style={{ flexWrap: "wrap" }}>
                  {ET_INCOME.map(([k, lbl]) => (
                    <button key={k} type="button" className={`chip ${form.income_type === k ? "active" : ""}`}
                      onClick={() => setForm(f => ({ ...f, income_type: k }))}>{lbl}</button>
                  ))}
                </div>
              </FieldRow>
              <FieldRow label="급여 형태">
                <div className="row gap-4" style={{ flexWrap: "wrap" }}>
                  {ET_FORMS.map(([k, lbl]) => (
                    <button key={k} type="button" className={`chip ${form.pay_form === k ? "active" : ""}`}
                      onClick={() => setForm(f => ({ ...f, pay_form: k }))}>{lbl}</button>
                  ))}
                </div>
              </FieldRow>
              <FieldRow label="단가 단위" hint="용역·일용 단가표 기본 단위 (일/시간/건)">
                <input className="input" style={{ maxWidth: 140 }} value={form.default_unit}
                  onChange={e => setForm(f => ({ ...f, default_unit: e.target.value }))} placeholder="예: 일, 시간, 건"/>
              </FieldRow>
              <FieldRow label="상용전환 경고" hint="일용이 이 개월수 이상 계속 고용되면 알림 (0=끔, 건설 12)">
                <div className="row gap-4" style={{ alignItems: "center" }}>
                  <input className="input num" style={{ width: 80 }} value={form.conv_alert_months}
                    onChange={e => setForm(f => ({ ...f, conv_alert_months: parseInt(e.target.value.replace(/[^0-9]/g, "")) || 0 }))}/>
                  <span className="text-sm text-muted2">개월</span>
                </div>
              </FieldRow>
            </div>
            <FieldRow label="4대보험 적용" hint="일용·단시간은 조건부라 계약마다 다를 수 있어요">
              <div className="row gap-4" style={{ flexWrap: "wrap" }}>
                {[["insure_np", "국민연금"], ["insure_hi", "건강보험"], ["insure_ei", "고용보험"], ["insure_ai", "산재보험"]].map(([k, lbl]) => (
                  <button key={k} type="button" className={`chip ${form[k] ? "active" : ""}`}
                    onClick={() => setForm(f => ({ ...f, [k]: f[k] ? 0 : 1 }))}>{form[k] ? "✓ " : ""}{lbl}</button>
                ))}
              </div>
            </FieldRow>
            <div className="row gap-8" style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={save}>{editingId ? "수정" : "추가"}</button>
              <button className="btn" onClick={reset}>취소</button>
            </div>
          </div>
        )}

        <div className="card" style={{ overflow: "hidden" }}>
          <table className="table">
            <thead><tr>
              <th>고용형태</th><th style={{ width: 70 }}>구분</th><th style={{ width: 90 }}>소득구분</th>
              <th style={{ width: 70 }}>급여</th><th style={{ width: 60 }}>단위</th>
              <th style={{ width: 150 }}>4대보험</th><th style={{ width: 90 }}>상용전환</th><th style={{ width: 120 }}></th>
            </tr></thead>
            <tbody>
              {types.length === 0 && <tr><td colSpan={8} style={{ textAlign: "center", padding: 28, color: "var(--muted-2)", fontSize: 13 }}>고용형태가 없어요. 위에서 추가하세요.</td></tr>}
              {types.map(t => (
                <tr key={t.id}>
                  <td className="fw-700">{t.label}</td>
                  <td className="text-sm text-muted">{kindLabel(t.kind)}</td>
                  <td className="text-sm">{t.income_type}</td>
                  <td className="text-sm text-muted">{formLabel(t.pay_form)}</td>
                  <td className="text-sm text-muted">{t.default_unit || "—"}</td>
                  <td className="text-xs text-muted">{insBadges(t)}</td>
                  <td className="text-sm text-muted">{Number(t.conv_alert_months) > 0 ? `${t.conv_alert_months}개월` : "—"}</td>
                  <td>
                    <div className="row gap-4">
                      <button className="btn ghost sm" onClick={() => edit(t)}>편집</button>
                      <button className="btn ghost sm" style={{ color: "var(--neg)" }} onClick={() => del(t)}>삭제</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

