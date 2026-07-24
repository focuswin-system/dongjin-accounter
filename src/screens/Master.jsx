import { useState, useEffect, useRef, useMemo, Fragment } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge, Drawer, Combobox, MoneyInput, Popover } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { api } from '../lib/api'

const fmtDateLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const todayStr = () => fmtDateLocal(new Date())

// 정기 항목의 '다음 생성/청구' 예정일.
// 서버 lib/recurrence.js 의 dueDatesToGenerate 와 같은 규칙이어야 화면과 실제가 어긋나지 않는다.
//   · 말일 clamp — new Date(2026, 1, 31) 은 3월 3일이 된다(오버플로). 그 달 말일로 맞춘다
//   · 주기 반영 — 분기·연 계약도 1개월씩 더하고 있었다
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate()
const nextRunDate = (rec) => {
  const anchor = Number(rec.dayOfMonth ?? rec.day_of_month) || 1
  const step = rec.period === 'yearly' ? 12 : rec.period === 'quarterly' ? 3 : 1
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = rec.startDate || rec.start_date
  const end = rec.endDate || rec.end_date

  // 앵커는 시작일의 '절대 월'에서 step 간격으로 밟는다. 매번 원 앵커로 계산하므로
  // 말일 clamp 가 누적되지 않는다(예: 31일 앵커가 2월을 지나며 28일로 굳어버리지 않는다).
  const [sy, sm] = String(start || fmtDateLocal(today)).split('-').map(Number)
  if (!sy || !sm) return '—'
  for (let i = 0; i < 600; i++) {
    const abs = (sm - 1) + i * step
    const y = sy + Math.floor(abs / 12)
    const m = ((abs % 12) + 12) % 12
    const d = new Date(y, m, Math.min(anchor, daysInMonth(y, m)))
    if (d <= today) continue
    const s = fmtDateLocal(d)
    if (end && s > end) return '—'
    return s
  }
  return '—'
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
    sub: "회사 정보와 시스템 사용자·문서 양식을 관리합니다.",
    groups: [
      { label: "회사", tabs: ["company"] },
      { label: "시스템", tabs: ["user", "approval", "template"] },
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

const HrCodePanel = ({ type, label }) => {
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
    else toast.push("저장 실패")
  }

  const handleDelete = async (item) => {
    await api.deleteHrCode(item.id)
    toast.push(`"${item.name}" 삭제됐어요`)
    load()
  }

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16 }}>
        <div>
          <div className="section-title">{label} 관리</div>
          <div className="section-sub">총 {items.length}개</div>
        </div>
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
    sub: '가입 보험(보험사·증권번호·보험료·납입·기간)과 증권을 관리합니다.',
    fields: [
      { key: 'name', label: '보험명', kind: 'text', req: true },
      { key: 'party', label: '보험사', kind: 'text', w: 110 },
      { key: 'code', label: '증권번호', kind: 'text', w: 130 },
      { key: 'amount', label: '보험료', kind: 'num', w: 110 },
      { key: 'period', label: '납입주기', kind: 'select', options: ['일시납', '월납', '분기납', '연납'], w: 84 },
      { key: 'pay_day', label: '납입일', kind: 'num', w: 70, hint: '매월/납기 일자 (1~31)' },
      { key: 'start_date', label: '시작일', kind: 'date', w: 130, hideCol: true },
      { key: 'end_date', label: '만기일', kind: 'date', w: 120 },
      { key: 'account_id', label: '자동이체 계좌', kind: 'account', hideCol: true },
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
export const RefMasterPanel = ({ cfg, page = false }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState([])
  const [q, setQ] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyRefForm(cfg.fields))
  const [accounts, setAccounts] = useState([])
  const [uploading, setUploading] = useState(false)

  const load = () => api.getRefItems(cfg.type).then(setRows)
  useEffect(() => { load() }, [cfg.type])
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
    else toast.push('파일 업로드에 실패했어요')
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
    if (!res.ok) return toast.push(res.error || '저장 실패')
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

  return (
    <div className={page ? 'fade-up' : undefined} style={page ? undefined : { padding: 20 }}>
      <div className="row" style={{ marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div className={page ? 'page-title' : 'section-title'}>{cfg.label}</div>
          <div className={page ? 'page-sub' : 'section-sub'}>{cfg.sub} · 총 {rows.length}건</div>
        </div>
        <div className="search" style={{ margin: 0, marginLeft: 'auto', width: 200, padding: '6px 10px' }}>
          <Icon.Search size={14}/>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={`${cfg.label} 검색`}/>
        </div>
        <button className="btn primary" onClick={openNew}><Icon.Plus size={14}/> {cfg.label} 등록</button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              {visibleFields.map(fd => <th key={fd.key} className={fd.kind === 'num' ? 'num-right' : undefined} style={fd.w ? { width: fd.w } : undefined}>{fd.label}</th>)}
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={visibleFields.length + 1} style={{ textAlign: 'center', padding: 32, color: 'var(--muted-2)' }}>등록된 {cfg.label}이(가) 없어요. 위에서 추가하세요.</td></tr>
            )}
            {filtered.map(r => (
              <tr key={r.id}>
                {visibleFields.map((fd, i) => (
                  <td key={fd.key}
                    className={fd.kind === 'num' ? 'num-cell num-right' : (i === 0 ? 'fw-600' : 'text-sm')}
                    style={{ color: (r[fd.key] == null || r[fd.key] === '') ? 'var(--muted-2)' : undefined }}>
                    {i === 0 && r.file_url && <Icon.Receipt size={12} style={{ marginRight: 4, color: 'var(--brand)', verticalAlign: -1 }}/>}
                    {cell(fd, r)}
                  </td>
                ))}
                <td>
                  <div className="row gap-6">
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => openEdit(r)}>수정</button>
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--neg)' }} onClick={() => handleDelete(r)}>삭제</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

// ── 거래처 엑셀 업로드 마법사 ─────────────────────────────────────
const VENDOR_IMPORT_TARGETS = ["사용 안함", "상호명", "거래구분", "거래유형", "사업자번호", "대표자", "담당자", "전화", "팩스", "이메일", "주소"]

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

const normBizNo = (v) => String(v ?? '').replace(/[^0-9]/g, '')
// 상호 정규화: 법인격·공백·기호 제거 후 소문자 — 유사 상호 매칭용
const normVendorName = (v) => String(v ?? '')
  .replace(/\(주\)|\(유\)|\(재\)|\(사\)|㈜|㈔|㈕|주식회사|유한회사|재단법인|사단법인/g, '')
  .replace(/[\s()\-.,·]/g, '')
  .toLowerCase()

const normGubu = (v) => {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (/기관|금융|은행|관공|공공|정부|카드사|^e$/i.test(s)) return 'E'
  if (/매입|외주|자재|원자재|협력|하청|구매|^a$/i.test(s)) return 'A'
  if (/발주|매출|수금|고객|판매|^b$/i.test(s)) return 'B'
  return null
}

const VENDOR_STATE_META = {
  error:     { badge: 'neg',     label: '상호 없음' },
  'new':     { badge: 'pos',     label: '신규' },
  dup:       { badge: 'warn',    label: '중복' },
  ambiguous: { badge: 'brand',   label: '확인 필요' },
  filedup:   { badge: 'outline', label: '파일 내 중복' },
}

const VendorImportWizard = ({ existing, onCancel, onDone }) => {
  const toast = useToast()
  const fileRef = useRef(null)
  const [file, setFile] = useState(null)
  const [rawRows, setRawRows] = useState([])
  const [mapping, setMapping] = useState([])
  const [defaultGubu, setDefaultGubu] = useState('A')
  const [overrides, setOverrides] = useState({})   // idx -> 'insert' | 'skip' | 'update:<id>'
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const onFile = async (f) => {
    if (!f) return
    setBusy(true); setResult(null)
    try {
      const { headers, rows } = await api.parseVendorExcel(f)
      if (!headers.length) { toast.push('열을 인식하지 못했어요. 첫 행이 머리글인지 확인하세요.'); setBusy(false); return }
      setFile({ name: f.name, size: f.size })
      setRawRows(rows)
      setMapping(headers.map(h => ({ excelCol: h, target: guessVendorTarget(h) })))
      setOverrides({})
    } catch (e) { toast.push(e.message || '파싱 실패') }
    setBusy(false)
  }

  const reset = () => { setFile(null); setRawRows([]); setMapping([]); setOverrides({}); setResult(null) }
  const colFor = (t) => mapping.find(m => m.target === t)?.excelCol
  const setMap = (i, k, v) => setMapping(ms => ms.map((m, idx) => idx === i ? { ...m, [k]: v } : m))

  // 기존 거래처 조회 인덱스 (사업자번호 / 정확 상호 / 정규화 상호)
  const idx = useMemo(() => {
    const byBiz = new Map(), byName = new Map(), byNorm = new Map()
    for (const v of existing) {
      const b = normBizNo(v.biz_no); if (b) byBiz.set(b, v)
      const nm = String(v.name || '').trim(); if (nm && !byName.has(nm)) byName.set(nm, v)
      const nn = normVendorName(v.name); if (nn) { if (!byNorm.has(nn)) byNorm.set(nn, []); byNorm.get(nn).push(v) }
    }
    return { byBiz, byName, byNorm }
  }, [existing])

  const preview = useMemo(() => {
    const seen = new Set()
    return rawRows.map((row, i) => {
      const g = (t) => { const c = colFor(t); return c != null ? String(row[c] ?? '').trim() : '' }
      const name = g('상호명')
      const bizRaw = g('사업자번호')
      const bizN = normBizNo(bizRaw)
      const gCol = colFor('거래구분')
      const gubu = gCol != null ? (normGubu(row[gCol]) || defaultGubu) : defaultGubu
      const base = {
        i, name, gubu, biz_no: bizRaw, type: g('거래유형'), ceo: g('대표자'),
        contact: g('담당자'), phone: g('전화'), fax: g('팩스'), email: g('이메일'), address: g('주소'),
      }
      if (!name) return { ...base, state: 'error', candidates: [], def: 'skip' }
      let matched = null
      if (bizN && idx.byBiz.get(bizN)) matched = idx.byBiz.get(bizN)
      else if (idx.byName.get(name)) matched = idx.byName.get(name)
      const nn = normVendorName(name)
      const candidates = matched ? [matched] : (idx.byNorm.get(nn) || [])
      const key = bizN || nn
      const fileDup = key && seen.has(key)
      if (key) seen.add(key)
      let state, def
      if (matched) { state = 'dup'; def = 'skip' }
      else if (candidates.length) { state = 'ambiguous'; def = 'skip' }
      else if (fileDup) { state = 'filedup'; def = 'skip' }
      else { state = 'new'; def = 'insert' }
      return { ...base, state, candidates, def }
    })
  }, [rawRows, mapping, defaultGubu, idx])

  const eff = (r) => overrides[r.i] ?? r.def
  const setAction = (i, v) => setOverrides(o => ({ ...o, [i]: v }))

  const counts = useMemo(() => {
    const c = { new: 0, dup: 0, ambiguous: 0, filedup: 0, error: 0, insert: 0, update: 0, skip: 0 }
    for (const r of preview) {
      c[r.state]++
      const a = eff(r)
      if (r.state === 'error' || a === 'skip') c.skip++
      else if (a === 'insert') c.insert++
      else if (a.startsWith('update:')) c.update++
    }
    return c
  }, [preview, overrides])

  const applyBulk = (action) => setOverrides(o => {
    const n = { ...o }
    for (const r of preview) {
      if (r.state === 'error' || r.state === 'new') continue
      if (action === 'skip') n[r.i] = 'skip'
      else if (action === 'insert') n[r.i] = 'insert'
      else if (action === 'overwrite' && r.candidates.length === 1) n[r.i] = 'update:' + r.candidates[0].id
    }
    return n
  })

  const onCommit = async () => {
    const items = preview
      .filter(r => r.state !== 'error')
      .map(r => ({ r, a: eff(r) }))
      .filter(({ a }) => a !== 'skip')
      .map(({ r, a }) => ({
        action: a.startsWith('update:') ? 'update' : 'insert',
        id: a.startsWith('update:') ? a.slice(7) : undefined,
        name: r.name, gubu: r.gubu, type: r.type, biz_no: r.biz_no, ceo: r.ceo,
        contact: r.contact, phone: r.phone, fax: r.fax, email: r.email, address: r.address,
      }))
    if (!items.length) return toast.push('등록·갱신할 거래처가 없어요')
    setBusy(true)
    const res = await api.commitVendorImport(items)
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '등록 실패')
    setResult(res)
    toast.push(`신규 ${res.inserted}건 · 갱신 ${res.updated}건 반영됐어요`)
  }

  const downloadTemplate = async () => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/vendors/import/template', { headers: token ? { Authorization: 'Bearer ' + token } : {} })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob); const a = document.createElement('a')
      a.href = url; a.download = '거래처_업로드_양식.xlsx'; a.click(); URL.revokeObjectURL(url)
    } catch { toast.push('양식 다운로드에 실패했어요') }
  }

  const stage = result ? 3 : (file ? 2 : 1)
  const rowOpts = (r) => [
    { value: 'skip', label: '건너뛰기' },
    { value: 'insert', label: '새로 등록' },
    ...r.candidates.map(c => ({ value: 'update:' + c.id, label: `덮어쓰기 → ${c.name}`, sub: c.biz_no || GUBU_LABEL[c.gubu] || '' })),
  ]

  return (
    <div className="import-wrap" style={{ padding: '20px 20px 104px' }}>
      <div className="row" style={{ marginBottom: 6, gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div className="section-title">거래처 엑셀 업로드</div>
          <div className="section-sub">거래처 목록을 엑셀(.xlsx)·CSV로 한 번에 등록하세요. 이미 있는 거래처는 중복 판정 후 건너뛰거나 덮어쓸 수 있어요.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={downloadTemplate}><Icon.Download/> 양식 다운로드</button>
          <button className="btn ghost" onClick={onCancel}><Icon.Close size={14}/> 닫기</button>
        </div>
      </div>
      <Spacer h={16}/>

      <div className="row gap-12" style={{ marginBottom: 20 }}>
        {[{ n: 1, t: '파일 업로드' }, { n: 2, t: '컬럼 매핑 · 중복 검토' }, { n: 3, t: '일괄 등록' }].map((s, i2, arr) => (
          <Fragment key={s.n}>
            <div className="row gap-8" style={{ opacity: stage >= s.n ? 1 : 0.4 }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: stage >= s.n ? 'var(--ink)' : '#fff', color: stage >= s.n ? '#fff' : 'var(--muted)', border: '1px solid var(--line-strong)', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 12 }}>
                {stage > s.n ? <Icon.Check size={14}/> : s.n}
              </div>
              <div className={`text-sm ${stage >= s.n ? 'fw-700' : 'text-muted'}`}>{s.t}</div>
            </div>
            {i2 < arr.length - 1 && <div style={{ flex: 1, height: 1, background: 'var(--line)' }}/>}
          </Fragment>
        ))}
      </div>

      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => onFile(e.target.files[0])}/>

      {result ? (
        <div className="card card-pad fade-up" style={{ textAlign: 'center', padding: '48px 24px', maxWidth: 520, margin: '0 auto' }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--pos-soft)', color: 'var(--pos)', display: 'grid', placeItems: 'center', margin: '0 auto 16px' }}><Icon.Check size={24}/></div>
          <div className="fw-700" style={{ fontSize: 16, marginBottom: 8 }}>거래처가 반영됐어요</div>
          <div className="text-sm text-muted" style={{ marginBottom: 20 }}>신규 등록 {result.inserted}건 · 기존 갱신 {result.updated}건</div>
          <div className="row gap-8" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={reset}>새 파일 업로드</button>
            <button className="btn primary" onClick={onDone}>거래처 목록으로</button>
          </div>
        </div>
      ) : !file ? (
        <div className="card card-pad">
          <div className="drop" style={{ padding: 48, cursor: 'pointer', textAlign: 'center' }}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files[0]) }}>
            <Icon.Excel size={36} style={{ color: 'var(--pos)' }}/>
            <div className="fw-600" style={{ marginTop: 8 }}>{busy ? '분석 중...' : '엑셀·CSV 파일을 끌어다 놓거나 클릭해서 업로드'}</div>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>.xlsx · .xls · .csv · 최대 20MB · 첫 행은 머리글</div>
          </div>
        </div>
      ) : (
        <div className="col gap-16">
            <div className="card card-pad">
              <div className="row gap-12">
                <div style={{ width: 44, height: 44, borderRadius: 10, background: '#E7F4ED', color: 'var(--pos)', display: 'grid', placeItems: 'center' }}><Icon.Excel size={22}/></div>
                <div style={{ minWidth: 0 }}>
                  <div className="fw-700" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                  <div className="text-xs text-muted2">{Math.round(file.size / 1024)}KB · {rawRows.length}행 인식됨</div>
                </div>
                <div className="ml-auto row gap-6">
                  <button className="btn sm" onClick={() => fileRef.current?.click()}>다시 업로드</button>
                  <button className="btn ghost sm" onClick={reset}><Icon.Close size={14}/></button>
                </div>
              </div>
              <div style={{ height: 1, background: 'var(--line)', margin: '14px 0' }}/>
              <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="text-sm fw-600">기본 거래구분</span>
                <span className="text-xs text-muted2">‘거래구분’ 컬럼을 매핑하면 그 값이 우선해요</span>
                <div className="row gap-6 ml-auto">
                  {GUBU_OPTS.map(o => (
                    <button key={o.value} className={`chip ${defaultGubu === o.value ? 'active' : ''}`} onClick={() => setDefaultGubu(o.value)}>{GUBU_LABEL[o.value]}</button>
                  ))}
                </div>
              </div>
            </div>

            <div className="card card-pad">
              <div className="section-title" style={{ marginBottom: 4 }}>컬럼 매핑</div>
              <div className="section-sub" style={{ marginBottom: 14 }}>왼쪽은 엑셀 컬럼명(수정 가능), 오른쪽은 우리 항목으로 연결하세요. ‘상호명’은 필수예요.</div>
              <div className="table-scroll">
                <table className="table" style={{ marginTop: 6 }}>
                  <thead><tr><th style={{ width: 200 }}>엑셀 컬럼</th><th>샘플 값</th><th style={{ width: 200 }}>매핑 항목</th></tr></thead>
                  <tbody>
                    {mapping.map((m, i) => (
                      <tr key={i}>
                        <td><input className="input" value={m.excelCol} onChange={e => setMap(i, 'excelCol', e.target.value)}/></td>
                        <td className="text-muted num text-sm" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(rawRows[0]?.[m.excelCol] ?? '—') || '—'}</td>
                        <td>
                          <div className="row gap-6" style={{ alignItems: 'center' }}>
                            <Icon.Right size={12} className="text-muted2"/>
                            <div style={{ flex: 1 }}>
                              <Combobox value={m.target} onChange={v => setMap(i, 'target', v)} allowAdd={false}
                                options={VENDOR_IMPORT_TARGETS.map(o => ({ value: o, label: o }))}/>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!colFor('상호명') && (
                <div className="alert-row" style={{ marginTop: 12, background: 'var(--neg-soft)', borderColor: 'transparent' }}>
                  <Icon.Warn/>
                  <div><div className="lead">‘상호명’ 컬럼을 지정해주세요</div><div className="body">상호명이 없으면 거래처를 등록할 수 없어요.</div></div>
                </div>
              )}
            </div>

            <div className="card">
              <div className="row" style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', gap: 8 }}>
                <div className="section-title">미리보기 · 중복 처리</div>
                <div className="ml-auto row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="badge pos"><Icon.Check size={11}/> 신규 {counts.new}</span>
                  {counts.dup > 0 && <span className="badge warn">중복 {counts.dup}</span>}
                  {counts.ambiguous > 0 && <span className="badge brand">확인 필요 {counts.ambiguous}</span>}
                  {counts.filedup > 0 && <span className="badge outline">파일 중복 {counts.filedup}</span>}
                  {counts.error > 0 && <span className="badge neg"><Icon.Warn size={11}/> 오류 {counts.error}</span>}
                  <Popover align="right" width={280}
                    trigger={<button className="icon-btn" title="중복 판정 기준"><Icon.Help size={16}/></button>}>
                    <div style={{ padding: 14 }}>
                      <div className="fw-700" style={{ marginBottom: 6 }}>중복은 이렇게 판정해요</div>
                      <div className="text-sm text-muted" style={{ lineHeight: 1.6 }}>
                        사업자번호가 같으면 <b>중복</b>, 상호가 똑같아도 <b>중복</b>이에요. 법인격·띄어쓰기만 다른 비슷한 상호는 <b>확인 필요</b>로 표시하니, 처리 칸에서 맞는 거래처를 골라 덮어쓰세요. 미등록 거래처는 <b>신규</b>로 등록됩니다.
                      </div>
                    </div>
                  </Popover>
                </div>
              </div>

              {(counts.dup + counts.ambiguous + counts.filedup) > 0 && (
                <div className="row gap-8" style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', background: 'var(--surface-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="text-xs fw-600 text-muted">중복 {counts.dup + counts.ambiguous + counts.filedup}건 일괄</span>
                  <button className="btn sm" onClick={() => applyBulk('skip')}>전체 건너뛰기</button>
                  <button className="btn sm" onClick={() => applyBulk('overwrite')}>전체 덮어쓰기 <span className="text-muted2" style={{ fontSize: 11 }}>(후보 1곳)</span></button>
                  <button className="btn sm" onClick={() => applyBulk('insert')}>전체 새로 등록</button>
                  {Object.keys(overrides).length > 0 && <button className="btn ghost sm ml-auto" onClick={() => setOverrides({})}>처리 초기화</button>}
                </div>
              )}

              <div className="table-scroll" style={{ maxHeight: 420 }}>
                <table className="table">
                  <thead><tr><th style={{ width: 40 }}>행</th><th>상호명</th><th style={{ width: 64 }}>구분</th><th>사업자번호</th><th>대표자</th><th>연락처</th><th style={{ width: 84 }}>판정</th><th style={{ width: 220 }}>처리</th></tr></thead>
                  <tbody>
                    {preview.slice(0, 200).map((r) => {
                      const a = eff(r)
                      const skipped = r.state === 'error' || a === 'skip'
                      return (
                        <tr key={r.i} style={{ background: r.state === 'error' ? 'rgba(255,80,80,0.04)' : undefined, opacity: skipped && r.state !== 'error' ? 0.55 : 1 }}>
                          <td className="num text-muted2">{r.i + 2}</td>
                          <td className="fw-600">{r.name || <span className="text-neg">—</span>}</td>
                          <td><span className="badge outline" style={{ fontSize: 10 }}>{GUBU_LABEL[r.gubu]}</span></td>
                          <td className="num text-sm text-muted">{r.biz_no || '—'}</td>
                          <td className="text-sm">{r.ceo || '—'}</td>
                          <td className="text-sm text-muted">{r.contact || r.phone || '—'}</td>
                          <td><span className={`badge ${VENDOR_STATE_META[r.state].badge}`}>{VENDOR_STATE_META[r.state].label}</span></td>
                          <td>
                            {r.state === 'error' ? (
                              <span className="text-xs text-muted2">상호명 필요</span>
                            ) : r.state === 'new' ? (
                              <div className="row gap-6">
                                <button className={`chip sm ${a === 'insert' ? 'active' : ''}`} onClick={() => setAction(r.i, 'insert')}>신규 등록</button>
                                <button className={`chip sm ${a === 'skip' ? 'active' : ''}`} onClick={() => setAction(r.i, 'skip')}>제외</button>
                              </div>
                            ) : (
                              <Combobox value={a} onChange={v => setAction(r.i, v)} allowAdd={false} options={rowOpts(r)}/>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ padding: 16, borderTop: '1px solid var(--line)', flexWrap: 'wrap', gap: 8 }}>
                <span className="text-sm text-muted">{preview.length > 200 ? `상위 200행 표시 · 전체 ${preview.length}행` : `전체 ${preview.length}행`}</span>
                <div className="ml-auto row gap-8">
                  <button className="btn" onClick={onCancel}>취소</button>
                  <button className="btn primary" disabled={busy || (!counts.insert && !counts.update)} style={{ opacity: (busy || (!counts.insert && !counts.update)) ? 0.5 : 1 }} onClick={onCommit}>
                    <Icon.Check size={14}/> {busy ? '등록 중...' : `신규 ${counts.insert} · 갱신 ${counts.update} 반영`}
                  </button>
                </div>
              </div>
            </div>
        </div>
      )}
    </div>
  )
}

const VendorPanel = () => {
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
    if (!res.ok) return toast.push(res.error || '저장 실패')
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
    <VendorImportWizard
      existing={vendors}
      onCancel={() => setImporting(false)}
      onDone={() => { setImporting(false); load() }}/>
  )

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div className="section-title">거래처</div>
          <div className="section-sub">총 {vendors.length}건 · DB 기준</div>
        </div>
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

const AccountSubjectPanel = () => {
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
        <div>
          <div className="section-title">계정과목</div>
          <div className="section-sub">한국채택 회계기준(K-GAAP) 표준 계정과목이에요. 거래 입력 시 선택용으로 쓰이며, 이 목록은 수정할 수 없어요. · 총 {rows.length}개</div>
        </div>
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

const CategoryPanel = () => {
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
    setForm({ kind: kindOf(c), name: c.name, vat: c.vat, pay_method: c.pay_method })
    setDrawerOpen(true)
  }
  const handleSave = async () => {
    if (!form.name.trim()) return toast.push("비목명을 입력하세요")
    const res = editing
      ? await api.updateCategory(editing.id, { name: form.name, group_name: editing.group_name || '', vat: form.vat, pay_method: form.pay_method })
      : await api.addCategory({ kind: form.kind, name: form.name, vat: form.vat, pay_method: form.pay_method })
    if (!res.ok) return toast.push(res.error || "저장 실패")
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
        <div>
          <div className="section-title">비목</div>
          <div className="section-sub">회사가 자유롭게 쓰는 지출·수입 항목이에요. 거래 입력 시 필수로 선택합니다. · 총 {cats.length}개</div>
        </div>
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
const CompanyPanel = () => {
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
    if (!res.ok) return toast.push(res.error || '저장 실패')
    toast.push('회사 정보가 저장됐어요')
  }

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16 }}>
        <div>
          <div className="section-title">회사 정보</div>
          <div className="section-sub">세금계산서·보고서·세무 자료에 들어갈 자사 기준정보예요.</div>
        </div>
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

const AccountPanel = () => {
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
    if (!res.ok) return toast.push(res.error || '저장 실패')
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
        <div>
          <div className="section-title">계좌 / 카드</div>
          <div className="section-sub">총 {accounts.length}건 · 결제수단으로 사용됩니다</div>
        </div>
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
                <td className="num-cell num-right">{a.kind === 'card' ? '—' : fmtNum(a.currentBalance)}</td>
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

const AccountBalancePanel = () => {
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
    await api.addAdjustment(accountId, data)
    toast.push("잔액 조정이 등록됐어요")
    load()
  }

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="section-title">계좌별 잔액</div>
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
                {fmtNum(acc.currentBalance)}
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
const RecurringFormDrawer = ({ open, onClose, onSave, vendors = [], accounts = [] }) => {
  const empty = { vendor_id: "", category: "임차료", amount: "", period: "monthly", day_of_month: "1", start_date: todayStr(), end_date: "", account_id: "" }
  const [form, setForm] = useState(empty)
  useEffect(() => {
    if (!open) return
    // 출금 계좌 기본값 — 비어 있으면 생성된 지출을 '이체 실행'할 때 계좌가 없어 막힌다
    setForm({ ...empty, account_id: accounts.find(a => a.kind === "bank")?.id || accounts[0]?.id || "" })
  }, [open, accounts])
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const handleSave = () => {
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
      <DrawerHead title="정기 지출 등록" onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div><label className="label">거래처 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <Combobox value={form.vendor_id} onChange={v => f("vendor_id", v)} allowAdd={false}
            options={vendors.map(v => ({ value: v.id, label: v.name, sub: v.type || "" }))} placeholder="거래처 선택"/>
        </div>
        <div><label className="label">비목</label>
          <Combobox value={form.category} onChange={v => f("category", v)} allowAdd={false}
            options={["임차료","통신비","전력비","안전관리비","보험료","기타"].map(c => ({ value: c, label: c }))}/>
        </div>
        <div><label className="label">금액 <span style={{ color: 'var(--neg-ink)' }}>*</span></label><MoneyInput value={form.amount} onChange={raw => f("amount", raw)}/></div>
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
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>이 날짜 이전으로는 소급 생성되지 않아요.</div>
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
      <DrawerFooter onCancel={onClose} onSave={handleSave} saveLabel="등록"/>
    </Drawer>
  )
}

const PERIOD_LABEL = { monthly: "매월", quarterly: "매분기", yearly: "매년" }

// 정기지출 = 판관비(경비) 쪽 정기 반복. 회계처리 '경비' 그룹의 독립 화면으로도, 기준정보 탭으로도 쓴다.
export const RecurringExpensePanel = ({ page = false }) => {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const [formOpen, setFormOpen] = useState(false)
  const [vendors, setVendors] = useState([])
  const [accounts, setAccounts] = useState([])

  const load = async () => setRows(await api.getRecurringExpenses())
  useEffect(() => { load() }, [])
  // 매입처(A)·기관(E) 만 — 정기 지출의 상대는 돈을 주는 쪽이다
  useEffect(() => {
    api.getVendors().then(v => setVendors(v.filter(x => x.gubu === 'A' || x.gubu === 'E')))
    api.getAccounts().then(setAccounts)
  }, [])

  const handleToggle = async (id) => {
    const res = await api.toggleRecurringExpense(id)
    toast.push(res.active ? "정기 지출이 활성화됐어요" : "정기 지출이 비활성화됐어요")
    load()
  }


  const addBtn = (
    <button className="btn primary" onClick={() => setFormOpen(true)}>
      <Icon.Plus size={14}/> 등록
    </button>
  )

  return (
    <div className={page ? 'fade-up' : undefined} style={page ? undefined : { padding: 20 }}>
      {/* 독립 화면일 땐 공용 PageHeader를 쓴다 — 다른 화면과 상단 여백·sticky 동작을 맞추기 위해 */}
      {page ? (
        <PageHeader title="정기 지출"
          sub="임차료·통신비처럼 매달 같은 날 나가는 지출을 등록해 두는 곳이에요."
          actions={addBtn}/>
      ) : (
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="section-title">정기 지출</div>
          <div className="ml-auto">{addBtn}</div>
        </div>
      )}
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>거래처</th><th>비목</th><th className="num-right">금액</th>
              <th>주기</th><th>다음 생성</th><th style={{ width: 60 }}>상태</th><th style={{ width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.45 }}>
                <td className="fw-700">{r.vendor}</td>
                <td className="text-sm text-muted">{r.category}</td>
                <td className="num-cell num-right">{fmtNum(r.amount)}</td>
                <td className="text-sm">{PERIOD_LABEL[r.period]} {r.dayOfMonth}일</td>
                <td className="text-sm">{r.active ? nextRunDate(r) : "—"}</td>
                <td>
                  <span className={`badge ${r.active ? "pos" : "outline"}`}>{r.active ? "활성" : "비활성"}</span>
                </td>
                <td>
                  <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => handleToggle(r.id)}>
                    {r.active ? "중지" : "재개"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RecurringFormDrawer open={formOpen} onClose={() => setFormOpen(false)} vendors={vendors} accounts={accounts}
        onSave={async (data) => {
          // 결과를 보지 않고 성공 문구를 띄우면, 저장이 실패해도 등록된 줄 알게 된다
          const res = await api.addRecurringExpense(data)
          toast.push(res?.ok === false ? (res.error || "등록에 실패했어요") : "정기 지출이 등록됐어요",
                     res?.ok === false ? { tone: "warn" } : undefined)
          load()
        }}/>
    </div>
  )
}

// ── 정기 청구(고정수입) 패널 ──────────────────────────────────────
const RecurringInvoiceFormDrawer = ({ open, onClose, onSave, vendors, contracts, accounts }) => {
  const empty = { vendorId: "", contractId: "", item: "", supply: "", vatMode: "exclusive", period: "monthly", dayOfMonth: "1", startDate: todayStr(), endDate: "", accountId: "" }
  const [form, setForm] = useState(empty)
  useEffect(() => { if (open) setForm(empty) }, [open])
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const pickContract = (cid) => {
    setForm(p => {
      const c = contracts.find(x => x.id === cid)
      return {
        ...p,
        contractId: cid,
        vendorId: p.vendorId || (c ? c.vendor_id : ""),
        item: p.item || (c ? c.name : ""),
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
      <DrawerHead title="정기 청구 등록" onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div><label className="label">계약 연결 <span className="text-muted">(선택)</span></label>
          <Combobox value={form.contractId} onChange={pickContract} allowAdd={false}
            options={contracts.map(c => ({ value: c.id, label: c.name, sub: c.vendor_name }))}
            placeholder="계약 선택 (없으면 비워두기)"/>
        </div>
        <div><label className="label">고객사 (발주처)</label>
          <Combobox value={form.vendorId} onChange={v => f("vendorId", v)} allowAdd={false}
            options={vendors.map(v => ({ value: v.id, label: v.name, sub: v.type }))}
            placeholder="고객사 선택"/>
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
              {[["exclusive","10% 별도"],["none","면세"]].map(([v, l]) => (
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
      <DrawerFooter onCancel={onClose} onSave={handleSave} saveLabel="등록"/>
    </Drawer>
  )
}

// 정기청구 = 매출 쪽 정기 반복. 회계처리 '판매·매출' 그룹의 독립 화면으로도, 기준정보 탭으로도 쓴다.
export const RecurringInvoicePanel = ({ page = false }) => {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const [vendors, setVendors] = useState([])
  const [contracts, setContracts] = useState([])
  const [accounts, setAccounts] = useState([])
  const [formOpen, setFormOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async () => setRows(await api.getRecurringInvoices())
  useEffect(() => {
    load()
    api.getVendors({ gubu: "B" }).then(setVendors)
    api.getContracts().then(setContracts)
    api.getAccounts().then(setAccounts)
  }, [])

  const handleToggle = async (id) => {
    const res = await api.toggleRecurringInvoice(id)
    toast.push(res.active ? "정기 청구가 활성화됐어요" : "정기 청구가 비활성화됐어요")
    load()
  }

  const handleGenerate = async () => {
    setBusy(true)
    const res = await api.generateRecurringInvoices()
    setBusy(false)
    if (!res.ok) return toast.push("청구서 생성에 실패했어요")
    toast.push(res.count > 0 ? `청구서 ${res.count}건을 '입금 예정'으로 생성했어요` : "생성할 청구 회차가 없어요")
    load()
  }

  const totalOf = (r) => r.supplyAmount + (r.vatMode === 'none' ? 0 : Math.round(r.supplyAmount * 0.1))

  const recActions = (
    <div className="row gap-8">
      <button className="btn" onClick={handleGenerate} disabled={busy}>
        <Icon.Calendar size={14}/> 밀린 회차 일괄 생성
      </button>
      <button className="btn primary" onClick={() => setFormOpen(true)}>
        <Icon.Plus size={14}/> 등록
      </button>
    </div>
  )

  return (
    <div className={page ? 'fade-up' : undefined} style={page ? undefined : { padding: 20 }}>
      {/* 여기는 '무엇을 언제 얼마씩 청구할지' 설정하는 곳.
          실제 청구(발행)는 판매·매출 → 대금 청구서의 '발행 예정'에서 한다(계약 청구일정과 한 화면에서 본다).
          밀린 회차를 한 번에 밀어넣어야 할 때만 일괄 생성을 쓴다. */}
      {page ? (
        <PageHeader title="정기 청구"
          sub={<>청구 조건을 설정하는 곳이에요. 실제 청구서 발행은 <b>판매·매출 → 대금 청구서</b>의 '발행 예정'에서 계약 청구일정과 함께 처리합니다.</>}
          actions={recActions}/>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 6 }}>
            <div className="section-title">정기 청구</div>
            <div className="ml-auto">{recActions}</div>
          </div>
          <div className="text-sm text-muted" style={{ marginBottom: 16 }}>
            청구 조건을 설정하는 곳이에요. 실제 청구서 발행은 <b>판매·매출 → 대금 청구서</b>의 '발행 예정'에서 계약 청구일정과 함께 처리합니다.
          </div>
        </>
      )}
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>고객사</th><th>항목 / 계약</th><th className="num-right">청구액(VAT 포함)</th>
              <th>주기</th><th>다음 청구</th><th style={{ width: 60 }}>상태</th><th style={{ width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="text-sm text-muted" style={{ textAlign: "center", padding: 24 }}>
                등록된 정기 청구가 없어요. 유지보수·호스팅 등 매달 청구하는 건을 등록해보세요.
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.45 }}>
                <td className="fw-700">{r.vendor}</td>
                <td className="text-sm">
                  {r.item || "—"}
                  {r.contractName && <div className="text-xs text-muted">계약: {r.contractName}</div>}
                </td>
                <td className="num-cell num-right">{fmtNum(totalOf(r))}</td>
                <td className="text-sm">{PERIOD_LABEL[r.period]} {r.dayOfMonth}일</td>
                <td className="text-sm">{r.active ? nextRunDate(r) : "—"}</td>
                <td><span className={`badge ${r.active ? "pos" : "outline"}`}>{r.active ? "활성" : "비활성"}</span></td>
                <td>
                  <button className="btn" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => handleToggle(r.id)}>
                    {r.active ? "중지" : "재개"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RecurringInvoiceFormDrawer open={formOpen} onClose={() => setFormOpen(false)}
        vendors={vendors} contracts={contracts} accounts={accounts}
        onSave={async (data) => { await api.addRecurringInvoice(data); toast.push("정기 청구가 등록됐어요"); load() }}/>
    </div>
  )
}

// ── 사용자 / 계정 관리 패널 ────────────────────────────────────────
// 결재선 프리셋 — 자주 쓰는 결재 단계(담당→결재→대표)를 저장해두고 결의서에서 골라 쓴다.
// 단계의 직위는 인사 기준정보 직위(hr pos)에서 고르거나 직접 입력.
const ApprovalPanel = () => {
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
    if (!res.ok) return toast.push(res.error || '저장에 실패했어요');
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
        <div className="section-title">결재선</div>
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

const UserPanel = ({ currentUser }) => {
  const toast = useToast();
  const { confirm } = useConfirm();
  const isAdmin = currentUser?.role === 'admin';
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ username: "", name: "", password: "", role: "user" });
  const [pwTarget, setPwTarget] = useState(null);
  const [newPw, setNewPw] = useState("");

  const load = () => api.getUsers().then(setUsers);
  useEffect(() => { load() }, []);

  const add = async () => {
    const username = form.username.trim();
    if (!username || !form.password.trim()) return toast.push("아이디와 비밀번호를 입력하세요");
    if (form.password.length < 4) return toast.push("비밀번호는 4자 이상으로 해주세요");
    const res = await api.addUser({ username, password: form.password, name: form.name.trim(), role: form.role });
    if (res.ok) { toast.push("계정이 추가됐어요"); setForm({ username: "", name: "", password: "", role: "user" }); load(); }
    else toast.push(res.error || "추가에 실패했어요 (아이디 중복일 수 있어요)");
  };

  const openPw = (u) => { setPwTarget(u); setNewPw(""); };
  const savePw = async () => {
    if (!pwTarget) return;
    if (newPw.length < 4) return toast.push("비밀번호는 4자 이상으로 해주세요");
    const res = await api.updateUserPassword(pwTarget.id, newPw);
    if (res.ok) { toast.push(`${pwTarget.name || pwTarget.username} 비밀번호를 변경했어요`); setPwTarget(null); setNewPw(""); }
    else toast.push(res.error || "변경에 실패했어요");
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
    else toast.push("변경에 실패했어요");
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
    else toast.push(res.error || "변경에 실패했어요");
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

  // 일반 사용자 — 본인 비밀번호만 변경 가능
  if (!isAdmin) {
    return (
      <div>
        <div className="row" style={{ padding: "16px 18px", borderBottom: "1px solid var(--line)" }}>
          <div>
            <div className="section-title">내 계정</div>
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
          <div className="section-title">사용자</div>
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
            <thead><tr><th>이름</th><th>아이디</th><th style={{ width: 100 }}>권한</th><th style={{ width: 90 }}>상태</th><th style={{ width: 280 }}></th></tr></thead>
            <tbody>
              {users.length === 0 && <tr><td colSpan={5} style={{ textAlign: "center", padding: 28, color: "var(--muted-2)", fontSize: 13 }}>계정이 없어요. 위에서 추가하세요.</td></tr>}
              {users.map(u => (
                <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                  <td className="fw-700">{u.name || u.username}{u.id === currentUser?.id && <span className="text-xs text-muted2" style={{ marginLeft: 6 }}>(나)</span>}</td>
                  <td className="text-sm text-muted">{u.username}</td>
                  <td><span className={`badge ${u.role === "admin" ? "ink" : "outline"}`}>{u.role === "admin" ? "관리자" : "일반"}</span></td>
                  <td><span className={`badge ${u.active ? "pos" : "outline"}`}>{u.active ? "활성" : "비활성"}</span></td>
                  <td>
                    <div className="row gap-4">
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
      </div>
      {pwDrawer}
    </div>
  );
};

/* 월 마감 — 부가세 신고·월 마감을 끝낸 달의 장부를 잠근다.
   잠근 달의 거래는 등록·수정·삭제가 서버에서 막힌다(lib/closing.js). 되돌리려면 해제. */
const ClosingPanel = () => {
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
    if (!res.ok) return toast.push(res.error || '마감에 실패했어요')
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
    if (!res.ok) return toast.push(res.error || '해제에 실패했어요')
    toast.push(`${p} 마감을 해제했어요`); load()
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <div className="section-title">월 마감</div>
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
                <td className="text-sm text-muted2 num">{String(r.created_at || '').slice(0, 16).replace('T', ' ')}</td>
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
  const activeTab = forcedTab || (allowedTabs.includes(tab) ? tab : allowedTabs[0]);
  const single = !!forcedTab;
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
    if (REF_CONFIGS[activeTab])           return <RefMasterPanel key={activeTab} cfg={REF_CONFIGS[activeTab]}/>
    if (activeTab === "vendor")           return <VendorPanel/>
    if (activeTab === "account")          return <AccountPanel/>
    if (activeTab === "company")          return <CompanyPanel/>
    if (activeTab === "accountSubject")   return <AccountSubjectPanel/>
    if (activeTab === "category")         return <CategoryPanel/>
    if (activeTab === "accountBalance")   return <AccountBalancePanel/>
    if (activeTab === "recurringExpense") return <RecurringExpensePanel/>
    if (activeTab === "recurringInvoice") return <RecurringInvoicePanel/>
    if (activeTab === "payrollItems")     return <PayrollItemPanel/>
    if (activeTab === "employType")       return <EmployTypePanel/>
    if (activeTab === "user")             return <UserPanel currentUser={user}/>
    if (activeTab === "approval")         return <ApprovalPanel/>
    if (activeTab === "closing")          return <ClosingPanel/>
    if (activeTab === "department")       return <HrCodePanel type="dept" label="부서"/>
    if (activeTab === "position")         return <HrCodePanel type="pos"  label="직위"/>
    return null
  }

  return (
    <div className="fade-up">
      <PageHeader
        title={single ? (TAB_BY_ID[activeTab]?.label || sectionCfg.title) : sectionCfg.title}
        sub={single ? sectionCfg.title : sectionCfg.sub}
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
const PayrollItemPanel = () => {
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
    else toast.push("저장에 실패했어요");
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
          <div className="section-title">급여 항목</div>
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

const EmployTypePanel = () => {
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
    else toast.push(res.error || "저장에 실패했어요");
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
          <div className="section-title">고용형태</div>
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

