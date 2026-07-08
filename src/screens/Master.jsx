import { useState, useEffect, Fragment } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge, Drawer, Combobox } from '../lib/ui'
import { api } from '../lib/api'

const fmtDateLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const todayStr = () => fmtDateLocal(new Date())

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
  evidenceType: {
    label: "증빙유형",
    columns: ["유형명", "설명", "필수 입력", "기본 첨부"],
    rows: [],
  },
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
  { id: "category",        label: "계정과목" },
  { id: "jeokyo",          label: "적요", custom: true },
  { id: "evidenceType",    label: "증빙유형" },
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
  { id: "user",            label: "사용자/결재선" },
  // 기준 설정
  { id: "payrollItems",    label: "급여 항목", custom: true },
  { id: "company",         label: "회사 정보", custom: true },
  { id: "template",        label: "문서 양식" },
];

const TAB_BY_ID = Object.fromEntries(MASTER_TABS.map(t => [t.id, t]));

// 도메인별 기준정보 섹션 (App 라우트: master=base / settings / hr_base=hr)
const MASTER_SECTIONS = {
  base: {
    title: "기준정보",
    sub: "거래처·계정과목·계좌·정기 거래 등 회계 처리의 기준이 되는 정보를 관리합니다.",
    groups: [
      { label: "거래 기준", tabs: ["vendor", "category", "jeokyo", "evidenceType"] },
      { label: "품목·자산", tabs: ["item", "fixed_asset", "intangible_asset"] },
      { label: "자금·결제", tabs: ["account", "accountBalance", "insurance"] },
      { label: "정기 거래", tabs: ["recurringInvoice", "recurringExpense"] },
    ],
  },
  settings: {
    title: "환경설정",
    sub: "회사 정보와 시스템 사용자·문서 양식을 관리합니다.",
    groups: [
      { label: "회사", tabs: ["company"] },
      { label: "시스템", tabs: ["user", "template"] },
    ],
  },
  hr: {
    title: "인사급여 기준정보",
    sub: "부서·직위 등 조직 코드와 급여 항목을 관리합니다.",
    groups: [
      { label: "조직", tabs: ["department", "position"] },
      { label: "급여", tabs: ["payrollItems"] },
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

// ── 기준정보 범용 패널 (적요·품목·보험·고정자산·무형자산) ──────────────
const REF_CONFIGS = {
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
    sub: '거래·청구에 쓰는 품목(품명·규격·단위·단가)을 관리합니다.',
    fields: [
      { key: 'code', label: '품목코드', kind: 'text', w: 120 },
      { key: 'name', label: '품명', kind: 'text', req: true },
      { key: 'spec', label: '규격', kind: 'text' },
      { key: 'unit', label: '단위', kind: 'text', w: 80 },
      { key: 'amount', label: '단가', kind: 'num', w: 120 },
    ],
  },
  insurance: {
    type: 'insurance', label: '보험',
    sub: '가입 보험(보험사·증권번호·보험료·기간)을 관리합니다.',
    fields: [
      { key: 'name', label: '보험명', kind: 'text', req: true },
      { key: 'party', label: '보험사', kind: 'text' },
      { key: 'code', label: '증권번호', kind: 'text', w: 140 },
      { key: 'amount', label: '보험료', kind: 'num', w: 120 },
      { key: 'start_date', label: '시작일', kind: 'date', w: 130 },
      { key: 'end_date', label: '종료일', kind: 'date', w: 130 },
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
}

const emptyRefForm = (fields) => Object.fromEntries(fields.map(fd => [fd.key, '']))

const RefMasterPanel = ({ cfg }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState([])
  const [q, setQ] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyRefForm(cfg.fields))

  const load = () => api.getRefItems(cfg.type).then(setRows)
  useEffect(() => { load() }, [cfg.type])

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const filtered = rows.filter(r => !q || cfg.fields.some(fd => String(r[fd.key] ?? '').includes(q)))

  const openNew = () => { setEditing(null); setForm(emptyRefForm(cfg.fields)); setDrawerOpen(true) }
  const openEdit = (r) => {
    setEditing(r)
    setForm(Object.fromEntries(cfg.fields.map(fd => [fd.key, r[fd.key] ?? ''])))
    setDrawerOpen(true)
  }
  const handleSave = async () => {
    const reqField = cfg.fields.find(fd => fd.req)
    if (reqField && !String(form[reqField.key] ?? '').trim()) return toast.push(`${reqField.label}을(를) 입력하세요`)
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

  const cell = (fd, val) => (val == null || val === '') ? '—' : (fd.kind === 'num' ? fmtNum(val) : val)

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div className="section-title">{cfg.label}</div>
          <div className="section-sub">{cfg.sub} · 총 {rows.length}건</div>
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
              {cfg.fields.map(fd => <th key={fd.key} className={fd.kind === 'num' ? 'num-right' : undefined} style={fd.w ? { width: fd.w } : undefined}>{fd.label}</th>)}
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={cfg.fields.length + 1} style={{ textAlign: 'center', padding: 32, color: 'var(--muted-2)' }}>등록된 {cfg.label}이(가) 없어요. 위에서 추가하세요.</td></tr>
            )}
            {filtered.map(r => (
              <tr key={r.id}>
                {cfg.fields.map((fd, i) => (
                  <td key={fd.key}
                    className={fd.kind === 'num' ? 'num-cell num-right' : (i === 0 ? 'fw-600' : 'text-sm')}
                    style={{ color: (r[fd.key] == null || r[fd.key] === '') ? 'var(--muted-2)' : undefined }}>
                    {cell(fd, r[fd.key])}
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
        <div className="drawer-head">
          <div className="fw-700" style={{ fontSize: 16 }}>{editing ? `${cfg.label} 수정` : `${cfg.label} 등록`}</div>
          <button className="icon-btn ml-auto" onClick={() => setDrawerOpen(false)}><Icon.Close size={16}/></button>
        </div>
        <div className="drawer-body col gap-14">
          {cfg.fields.map(fd => (
            <div key={fd.key}>
              <label className="label" style={{ marginBottom: 8 }}>{fd.label} {fd.req && <span style={{ color: 'var(--neg-ink)' }}>*</span>}</label>
              <input
                className={`input ${fd.kind === 'num' ? 'num' : ''}`}
                type={fd.kind === 'date' ? 'date' : 'text'}
                value={fd.kind === 'num' ? (form[fd.key] === '' || form[fd.key] == null ? '' : fmtNum(form[fd.key])) : (form[fd.key] ?? '')}
                onChange={e => f(fd.key, fd.kind === 'num' ? (parseInt(e.target.value.replace(/[^0-9-]/g, ''), 10) || 0) : e.target.value)}
                placeholder={fd.label}/>
            </div>
          ))}
        </div>
        <div className="drawer-foot">
          <button className="btn" onClick={() => setDrawerOpen(false)}>취소</button>
          <button className="btn primary ml-auto" onClick={handleSave}><Icon.Check size={14}/> 저장</button>
        </div>
      </Drawer>
    </div>
  )
}

const VendorPanel = () => {
  const toast = useToast()
  const [vendors,     setVendors]     = useState([])
  const [q,           setQ]           = useState('')
  const [filterGubu,  setFilterGubu]  = useState('')
  const [drawerOpen,  setDrawerOpen]  = useState(false)
  const [editing,     setEditing]     = useState(null)
  const [form, setForm] = useState({ name:'', gubu:'A', type:'', biz_no:'', ceo:'', contact:'', phone:'', fax:'', email:'', address:'' })

  const load = () => api.getVendors().then(setVendors)
  useEffect(() => { load() }, [])

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const filtered = vendors.filter(v => {
    const matchQ = !q || [v.name, v.biz_no, v.ceo, v.contact, v.phone, v.email].some(s => s?.includes(q))
    const matchG = !filterGubu || v.gubu === filterGubu
    return matchQ && matchG
  })

  const openNew = () => {
    setEditing(null)
    setForm({ name:'', gubu:'A', type:'', biz_no:'', ceo:'', contact:'', phone:'', fax:'', email:'', address:'' })
    setDrawerOpen(true)
  }
  const openEdit = (v) => {
    setEditing(v)
    setForm({ name:v.name, gubu:v.gubu||'A', type:v.type||'', biz_no:v.biz_no||'', ceo:v.ceo||'', contact:v.contact||'', phone:v.phone||'', fax:v.fax||'', email:v.email||'', address:v.address||'' })
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
    await api.deleteVendor(v.id)
    toast.push(`${v.name} 삭제됐어요`)
    load()
  }

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
        <div className="search" style={{ margin: 0, width: 200, padding: '6px 10px' }}>
          <Icon.Search size={14}/>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="상호·담당자·연락처"/>
        </div>
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
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32, color: 'var(--muted-2)' }}>등록된 거래처가 없어요</td></tr>
            )}
            {filtered.map(v => (
              <tr key={v.id}>
                <td className="fw-700">{v.name}</td>
                <td><span className={`badge ${v.gubu === 'B' ? 'brand' : v.gubu === 'E' ? 'outline' : 'warn'}`}>{GUBU_LABEL[v.gubu] || v.gubu}</span></td>
                <td className="text-sm text-muted">{v.type || '—'}</td>
                <td className="text-sm">{v.biz_no || '—'}</td>
                <td className="text-sm">{v.ceo || '—'}</td>
                <td className="text-sm">{v.contact || '—'}</td>
                <td className="text-sm">{v.phone || '—'}</td>
                <td className="text-sm">{v.email || '—'}</td>
                <td>
                  <div className="row gap-6">
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => openEdit(v)}>수정</button>
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--neg)' }} onClick={() => handleDelete(v)}>삭제</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <div className="drawer-head">
          <div className="fw-700" style={{ fontSize: 16 }}>{editing ? '거래처 수정' : '거래처 등록'}</div>
          <button className="icon-btn ml-auto" onClick={() => setDrawerOpen(false)}><Icon.Close size={16}/></button>
        </div>
        <div className="drawer-body col" style={{ gap: 24 }}>
          <div>
            <label className="label" style={{ marginBottom: 8 }}>상호명 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <input className="input" value={form.name} onChange={e => f('name', e.target.value)} placeholder="(주)한화오션"/>
          </div>

          <div style={{ height: 1, background: 'var(--line)' }}/>

          <div className="row gap-16" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>거래 구분 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
              <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                {GUBU_OPTS.map(o => (
                  <button key={o.value} type="button" className={`chip ${form.gubu === o.value ? 'active' : ''}`} onClick={() => f('gubu', o.value)}>{o.label}</button>
                ))}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>거래 유형</label>
              <input className="input" value={form.type} onChange={e => f('type', e.target.value)} placeholder="발주처 / 외주가공 / 원자재"/>
            </div>
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
        <div className="drawer-foot">
          <button className="btn" onClick={() => setDrawerOpen(false)}>취소</button>
          <button className="btn primary ml-auto" onClick={handleSave}><Icon.Check size={14}/> 저장</button>
        </div>
      </Drawer>
    </div>
  )
}

// ── F0: 계정과목 / 비목 패널 ────────────────────────────────────────
const VAT_OPTS = ["10%", "면세", "—"]
const PAY_OPTS = ["계좌이체", "법인카드", "현금", "—"]

const CategoryPanel = () => {
  const toast = useToast()
  const [cats, setCats] = useState([])
  const [q, setQ] = useState("")
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null = new
  const [form, setForm] = useState({ id: "", name: "", group_name: "", vat: "10%", pay_method: "계좌이체" })

  const load = () => api.getCategories().then(setCats)
  useEffect(() => { load() }, [])

  const groups = cats.reduce((acc, c) => {
    const g = c.group_name || '미분류'
    if (!acc[g]) acc[g] = []
    acc[g].push(c)
    return acc
  }, {})

  const filtered = q
    ? cats.filter(c => c.name?.includes(q) || c.group_name?.includes(q) || c.id?.includes(q))
    : null

  const openNew = () => {
    setEditing(null)
    setForm({ id: "", name: "", group_name: "", vat: "10%", pay_method: "계좌이체" })
    setDrawerOpen(true)
  }
  const openEdit = (c) => {
    setEditing(c)
    setForm({ id: c.id, name: c.name, group_name: c.group_name, vat: c.vat, pay_method: c.pay_method })
    setDrawerOpen(true)
  }
  const handleSave = async () => {
    if (!form.name) return toast.push("비목명을 입력하세요")
    let res
    if (editing) {
      res = await api.updateCategory(editing.id, { name: form.name, group_name: form.group_name, vat: form.vat, pay_method: form.pay_method })
    } else {
      if (!form.id) return toast.push("코드를 입력하세요 (예: EXP-999)")
      res = await api.addCategory(form)
    }
    if (!res.ok) return toast.push(res.error || "저장 실패")
    toast.push(editing ? "수정됐어요" : "등록됐어요")
    setDrawerOpen(false)
    load()
  }
  const handleDelete = async (c) => {
    await api.deleteCategory(c.id)
    toast.push(`${c.name} 비활성화됐어요`)
    load()
  }

  const Row = ({ c }) => (
    <tr>
      <td className="text-xs text-muted">{c.id}</td>
      <td className="fw-600">{c.name}</td>
      <td className="text-sm text-muted">{c.group_name}</td>
      <td className="text-sm">{c.vat}</td>
      <td className="text-sm">{c.pay_method}</td>
      <td>
        <div className="row gap-6">
          <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => openEdit(c)}>수정</button>
          <button className="btn" style={{ fontSize: 11, padding: "2px 8px", color: "var(--neg)" }} onClick={() => handleDelete(c)}>삭제</button>
        </div>
      </td>
    </tr>
  )

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16, gap: 10 }}>
        <div>
          <div className="section-title">계정과목 / 비목</div>
          <div className="section-sub">총 {cats.length}개 · DB 기준</div>
        </div>
        <div className="search ml-auto" style={{ margin: 0, width: 200, padding: "6px 10px" }}>
          <Icon.Search size={14}/>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="비목 검색"/>
        </div>
        <button className="btn primary" onClick={openNew}><Icon.Plus size={14}/> 비목 추가</button>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 90 }}>코드</th>
              <th>비목명</th>
              <th>계정과목 그룹</th>
              <th style={{ width: 60 }}>부가세</th>
              <th style={{ width: 90 }}>결제수단</th>
              <th style={{ width: 100 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered
              ? filtered.map(c => <Row key={c.id} c={c}/>)
              : Object.entries(groups).map(([group, items]) => (
                  <Fragment key={group}>
                    <tr style={{ background: "var(--surface-2)" }}>
                      <td colSpan={6} className="fw-700 text-sm" style={{ padding: "8px 16px" }}>{group}</td>
                    </tr>
                    {items.map(c => <Row key={c.id} c={c}/>)}
                  </Fragment>
                ))
            }
          </tbody>
        </table>
      </div>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <div className="drawer-head">
          <div className="fw-700" style={{ fontSize: 16 }}>{editing ? "비목 수정" : "비목 추가"}</div>
          <button className="icon-btn ml-auto" onClick={() => setDrawerOpen(false)}><Icon.Close size={16}/></button>
        </div>
        <div className="drawer-body col gap-14">
          {!editing && (
            <div>
              <label className="label">코드 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
              <input className="input" placeholder="EXP-999 또는 INC-999"
                value={form.id} onChange={e => setForm(p => ({ ...p, id: e.target.value.toUpperCase() }))}/>
              <div className="text-xs text-muted" style={{ marginTop: 4 }}>EXP = 지출, INC = 수익</div>
            </div>
          )}
          <div>
            <label className="label">비목명 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
            <input className="input" placeholder="예: 도금 외주"
              value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}/>
          </div>
          <div>
            <label className="label">계정과목 그룹</label>
            <input className="input" placeholder="예: 외주가공비"
              value={form.group_name} onChange={e => setForm(p => ({ ...p, group_name: e.target.value }))}/>
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
        </div>
        <div className="drawer-foot">
          <button className="btn" onClick={() => setDrawerOpen(false)}>취소</button>
          <button className="btn primary ml-auto" onClick={handleSave}><Icon.Check size={14}/> 저장</button>
        </div>
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
      <div className="drawer-head">
        <div>
          <div className="fw-700" style={{ fontSize: 16 }}>잔액 조정</div>
          <div className="text-xs text-muted">{account.name}</div>
        </div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>
      <div className="drawer-body col gap-14">
        <div className="row gap-8">
          <button className={`chip ${type === "minus" ? "active" : ""}`} onClick={() => setType("minus")}>- 차감</button>
          <button className={`chip ${type === "plus" ? "active" : ""}`} onClick={() => setType("plus")}>+ 추가</button>
        </div>
        <div>
          <label className="label">조정 금액</label>
          <input className="input num" placeholder="0" value={amount} onChange={e => setAmount(e.target.value)}/>
        </div>
        <div>
          <label className="label">조정 사유</label>
          <input className="input" placeholder="은행 수수료, 오입력 수정 등" value={reason} onChange={e => setReason(e.target.value)}/>
        </div>
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" onClick={handleSave}><Icon.Check size={14}/> 조정 등록</button>
      </div>
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
        <div className="drawer-head">
          <div className="fw-700" style={{ fontSize: 16 }}>{editing ? '계좌/카드 수정' : '계좌/카드 등록'}</div>
          <button className="icon-btn ml-auto" onClick={() => setDrawerOpen(false)}><Icon.Close size={16}/></button>
        </div>
        <div className="drawer-body col" style={{ gap: 22 }}>
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
                <input className="input num" value={form.initial_balance} onChange={e => f('initial_balance', e.target.value)} placeholder="0"/>
                <div className="text-xs text-muted2" style={{ marginTop: 6 }}>등록 시점 통장 잔액. 이후 거래로 자동 증감돼요.</div>
              </div>
            )}
          </div>
        </div>
        <div className="drawer-foot">
          <button className="btn" onClick={() => setDrawerOpen(false)}>취소</button>
          <button className="btn primary ml-auto" onClick={handleSave}><Icon.Check size={14}/> 저장</button>
        </div>
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
        <div className="drawer-head">
          <div className="fw-700" style={{ fontSize: 16 }}>조정 이력 — {histTarget?.name}</div>
          <button className="icon-btn ml-auto" onClick={() => setHistTarget(null)}><Icon.Close size={16}/></button>
        </div>
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
const RecurringFormDrawer = ({ open, onClose, onSave }) => {
  const [form, setForm] = useState({ vendor: "", category: "임차료", amount: "", period: "monthly", dayOfMonth: "1" })
  useEffect(() => {
    if (open) setForm({ vendor: "", category: "임차료", amount: "", period: "monthly", dayOfMonth: "1" })
  }, [open])
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const handleSave = () => {
    if (!form.vendor || !form.amount) return
    onSave({ ...form, amount: parseInt(form.amount.replace(/[^0-9]/g, "")), dayOfMonth: parseInt(form.dayOfMonth) || 1 })
    onClose()
  }
  return (
    <Drawer open={open} onClose={onClose}>
      <div className="drawer-head">
        <div className="fw-700" style={{ fontSize: 16 }}>정기 지출 등록</div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>
      <div className="drawer-body col gap-14">
        <div><label className="label">거래처</label><input className="input" value={form.vendor} onChange={e => f("vendor", e.target.value)} placeholder="임대인 박OO"/></div>
        <div><label className="label">비목</label>
          <Combobox value={form.category} onChange={v => f("category", v)} allowAdd={false}
            options={["임차료","통신비","전력비","안전관리비","보험료","기타"].map(c => ({ value: c, label: c }))}/>
        </div>
        <div><label className="label">금액</label><input className="input num" value={form.amount} onChange={e => f("amount", e.target.value)} placeholder="0"/></div>
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
            <input className="input" type="number" min="1" max="31" value={form.dayOfMonth} onChange={e => f("dayOfMonth", e.target.value)}/>
          </div>
        </div>
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" onClick={handleSave}><Icon.Check size={14}/> 등록</button>
      </div>
    </Drawer>
  )
}

const PERIOD_LABEL = { monthly: "매월", quarterly: "매분기", yearly: "매년" }

const RecurringExpensePanel = () => {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const [formOpen, setFormOpen] = useState(false)

  const load = async () => setRows(await api.getRecurringExpenses())
  useEffect(() => { load() }, [])

  const handleToggle = async (id) => {
    const res = await api.toggleRecurringExpense(id)
    toast.push(res.active ? "정기 지출이 활성화됐어요" : "정기 지출이 비활성화됐어요")
    load()
  }

  const nextDate = (rec) => {
    const d = new Date()
    const next = new Date(d.getFullYear(), d.getMonth(), rec.dayOfMonth)
    if (next <= d) next.setMonth(next.getMonth() + 1)
    const y = next.getFullYear()
    const m = String(next.getMonth() + 1).padStart(2, '0')
    const day = String(next.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="section-title">정기 지출</div>
        <button className="btn primary ml-auto" onClick={() => setFormOpen(true)}>
          <Icon.Plus size={14}/> 등록
        </button>
      </div>
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
                <td className="text-sm">{r.active ? nextDate(r) : "—"}</td>
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
      <RecurringFormDrawer open={formOpen} onClose={() => setFormOpen(false)}
        onSave={async (data) => { await api.addRecurringExpense(data); toast.push("정기 지출이 등록됐어요"); load() }}/>
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
      <div className="drawer-head">
        <div className="fw-700" style={{ fontSize: 16 }}>정기 청구 등록</div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>
      <div className="drawer-body col gap-14">
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
            <input className="input num" value={form.supply} onChange={e => f("supply", e.target.value)} placeholder="0"/>
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
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" onClick={handleSave}><Icon.Check size={14}/> 등록</button>
      </div>
    </Drawer>
  )
}

const RecurringInvoicePanel = () => {
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

  const nextDate = (rec) => {
    const step = rec.period === 'yearly' ? 12 : rec.period === 'quarterly' ? 3 : 1
    const today = new Date()
    const [sy, sm] = (rec.startDate || todayStr()).split('-').map(Number)
    let d = new Date(sy, sm - 1, rec.dayOfMonth || 1)
    let guard = 0
    while (d <= today && guard++ < 600) d = new Date(d.getFullYear(), d.getMonth() + step, rec.dayOfMonth || 1)
    if (rec.endDate && fmtDateLocal(d) > rec.endDate) return "—"
    return fmtDateLocal(d)
  }

  const totalOf = (r) => r.supplyAmount + (r.vatMode === 'none' ? 0 : Math.round(r.supplyAmount * 0.1))

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="section-title">정기 청구</div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={handleGenerate} disabled={busy}>
            <Icon.Calendar size={14}/> 이번 회차 청구서 생성
          </button>
          <button className="btn primary" onClick={() => setFormOpen(true)}>
            <Icon.Plus size={14}/> 등록
          </button>
        </div>
      </div>
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
                <td className="text-sm">{r.active ? nextDate(r) : "—"}</td>
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
      <div className="drawer-head">
        <div>
          <div className="fw-700" style={{ fontSize: 16 }}>비밀번호 변경</div>
          <div className="text-xs text-muted">{pwTarget?.name || pwTarget?.username}</div>
        </div>
        <button className="icon-btn ml-auto" onClick={() => setPwTarget(null)}><Icon.Close size={16}/></button>
      </div>
      <div className="drawer-body col gap-14">
        <div>
          <label className="label">새 비밀번호</label>
          <input className="input" type="text" value={newPw} autoFocus
            onChange={e => setNewPw(e.target.value)}
            onKeyDown={e => e.key === "Enter" && savePw()}
            placeholder="새 비밀번호 (4자 이상)"/>
        </div>
        <div className="text-xs text-muted2" style={{ marginTop: 8 }}>변경 후 해당 사용자는 새 비밀번호로 다시 로그인해야 해요.</div>
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={() => setPwTarget(null)}>취소</button>
        <button className="btn primary ml-auto" onClick={savePw}><Icon.Check size={14}/> 변경</button>
      </div>
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
          <div className="section-title">사용자 / 결재선</div>
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

export const MasterScreen = ({ user, section = "base" }) => {
  const toast = useToast();
  const sectionCfg = MASTER_SECTIONS[section] || MASTER_SECTIONS.base;
  const allowedTabs = sectionCfg.groups.flatMap(g => g.tabs);
  const [tab, setTab] = useState(allowedTabs[0]);
  // 라우트(섹션) 변경으로 현재 탭이 이 섹션에 없으면 첫 탭으로 자동 폴백
  const activeTab = allowedTabs.includes(tab) ? tab : allowedTabs[0];
  const [q, setQ] = useState("");
  const [drawer, setDrawer] = useState(null);
  const [collapsed, setCollapsed] = useState({});
  const [userRows,     setUserRows]     = useState([]);

  useEffect(() => {
    api.getUsers().then(list =>
      setUserRows(list.map(u => [u.name || u.username, u.username, u.role === 'admin' ? '관리자' : '일반 사용자', u.active ? '활성' : '비활성']))
    )
  }, []);

  const isCustomTab = ["account", "accountBalance", "recurringExpense", "recurringInvoice", "payroll", "payrollItems", "category", "vendor", "department", "position", "company", "user", "jeokyo", "item", "insurance", "fixed_asset", "intangible_asset"].includes(activeTab)
  const data = !isCustomTab ? MASTER_DATA[activeTab] : null
  const rawRows = activeTab === "user" ? userRows : (data?.rows || [])
  const rows = rawRows.filter(r => !q || r.some(c => String(c).toLowerCase().includes(q.toLowerCase())));

  const toggleGroup = (name) => setCollapsed(c => ({ ...c, [name]: !c[name] }));

  const renderCustomPanel = () => {
    if (REF_CONFIGS[activeTab])           return <RefMasterPanel key={activeTab} cfg={REF_CONFIGS[activeTab]}/>
    if (activeTab === "vendor")           return <VendorPanel/>
    if (activeTab === "account")          return <AccountPanel/>
    if (activeTab === "company")          return <CompanyPanel/>
    if (activeTab === "category")         return <CategoryPanel/>
    if (activeTab === "accountBalance")   return <AccountBalancePanel/>
    if (activeTab === "recurringExpense") return <RecurringExpensePanel/>
    if (activeTab === "recurringInvoice") return <RecurringInvoicePanel/>
    if (activeTab === "payrollItems")     return <PayrollItemPanel/>
    if (activeTab === "user")             return <UserPanel currentUser={user}/>
    if (activeTab === "department")       return <HrCodePanel type="dept" label="부서"/>
    if (activeTab === "position")         return <HrCodePanel type="pos"  label="직위"/>
    return null
  }

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 8 }}>
        <div>
          <div className="page-title">{sectionCfg.title}</div>
          <div className="page-sub">{sectionCfg.sub}</div>
        </div>
        <div className="ml-auto row gap-8">
          {!isCustomTab && data && (
            <>
              <button className="btn" onClick={() => toast.push(`${data.label} 양식을 내려받았어요`)}><Icon.Download/> <span className="btn-label-hide">양식 다운로드</span></button>
              <button className="btn" onClick={() => toast.push(`${data.label} 일괄 업로드 창을 열었어요`)}><Icon.Excel/> <span className="btn-label-hide">일괄 업로드</span></button>
              <button className="btn primary" onClick={() => setDrawer("new")}><Icon.Plus/> {data.label} 등록</button>
            </>
          )}
        </div>
      </div>

      <Spacer h={20}/>

      <div className="master-layout" style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 16, alignItems: "start" }}>
        {/* Sub-nav (섹션별 그룹) */}
        <div className="card" style={{ padding: 8 }}>
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
        </div>

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
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>{title}</div>
            <div className="text-xs text-muted">
              {mode === "new"
                ? "필수 항목만 채우면 바로 등록할 수 있어요."
                : "변경한 내용은 즉시 반영됩니다."}
            </div>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        <div className="drawer-body">
          <div className="col gap-16">
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

