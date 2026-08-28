import { useState, useEffect, useRef, useMemo, Fragment } from 'react'
import { Icon, fmtNum, useToast, useConfirm, StatusBadge, Drawer, Combobox, MoneyInput, Loading, DateInput } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { RecurAuditDrawer } from '../lib/components/RecurAuditDrawer'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { DataTable } from '../lib/components/DataTable'
import { ImportWizard } from '../lib/components/ImportWizard'
import { VendorSubList, ACCOUNT_FIELDS, CONTACT_FIELDS } from '../lib/components/VendorSubList'
import { RecurringCycles, useRecurringCycles, cycleSummaryByRule, CycleAmountDrawer } from '../lib/components/RecurringCycles'
import { PaidIssueDrawer } from '../lib/components/PaidIssueDrawer'
import { BackfillWizard } from '../lib/components/BackfillWizard'
import { RowActions } from '../lib/components/RowActions'
import { RecurHistoryDrawer } from '../lib/components/RecurHistoryDrawer'
import { normBizNo, normVendorName } from '../lib/normalize'
import { cycleMonthsLabel, PAY_TERM_OPTS, payTermNeedsDay, payTermHint,
         BILLING_PERIODS, periodMonths, periodLong } from '../lib/renewal'
import { bizTypeOptions, bizItemOptions } from '../lib/bizTypes'
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
  const step = periodMonths(period)   // 주기 표는 lib/renewal.js 한 곳(서버 lib/period.js 와 같은 값)
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
  { id: "account",         label: "계좌", custom: true },
  { id: "card",            label: "카드", custom: true },
  { id: "accountBalance",  label: "계좌 잔액", custom: true },
  { id: "recurringExpense",label: "정기 출금", custom: true },
  { id: "recurringInvoice",label: "정기 입금", custom: true },
  // 조직
  { id: "department",      label: "부서", custom: true },
  { id: "position",        label: "직위", custom: true },
  /* 환경설정 항목의 이름은 **nav.js SETTINGS_LEAVES 와 같아야 한다** —
     여기 label 이 화면 제목이 되므로, 다르면 메뉴와 제목이 어긋난다. */
  { id: "user",            label: "사용자 관리" },
  { id: "approval",        label: "결재선 등록", custom: true },
  // 기준 설정
  { id: "payrollItems",    label: "급여 항목", custom: true },
  { id: "employType",      label: "고용형태", custom: true },
  { id: "company",         label: "회사 정보", custom: true },
  { id: "template",        label: "문서 양식" },
  { id: "reports",         label: "보고서 관리", custom: true },
  { id: "closing",         label: "월 마감 설정", custom: true },
  { id: "audit",           label: "변경 이력 조회", custom: true },
];

const TAB_BY_ID = Object.fromEntries(MASTER_TABS.map(t => [t.id, t]));

/* 메뉴에서 내린 탭 → 그 일을 이어받은 탭.
   '계좌 잔액'은 계좌 상세 안으로 들어갔다(현재 잔액·초기잔액·조정 이력·잔액 조정). */
const RETIRED_TABS = { accountBalance: "account" };

/**
 * 전용 패널로 그리는 탭 — MasterScreen 의 renderCustomPanel() 과 짝이다.
 *
 * ⚠ 여기 빠뜨리면 일반 표 렌더러로 흘러가 `data.label` 에서 **화면이 통째로 크래시한다**
 * (변경 이력 탭을 추가하면서 실제로 겪었다). MASTER_TABS 의 custom 플래그와 따로 두는
 * 이유는 그 플래그가 서브내브 건수 표시에도 쓰여 의미가 겹치지 않기 때문이다.
 *
 * 등록을 잊어도 최악이 '빈 카드'가 되도록, 아래 isCustomTab 은 MASTER_DATA 에 표 정의가
 * 없는 탭도 전용 패널 경로로 보낸다 — 크래시보다는 빈 화면이 낫다.
 */
const CUSTOM_PANEL_TABS = new Set([
  "account", "card", "accountBalance", "recurringExpense", "recurringInvoice", "payroll",
  "payrollItems", "employType", "accountSubject", "category", "vendor",
  "department", "position", "company", "user", "approval", "jeokyo", "item",
  "insurance", "fixed_asset", "intangible_asset", "evidence_type", "closing", "audit",
  "reports",
]);

// 도메인별 기준정보 섹션 (App 라우트: master=base / settings / hr_base=hr)
const MASTER_SECTIONS = {
  base: {
    title: "기준정보",
    sub: "거래처·계정과목·계좌·품목·자산 등 회계 처리의 기준이 되는 정보를 관리합니다.",
    groups: [
      // 증빙유형: 목업이던 evidenceType 탭을 버리고 실제 CRUD(ref_items type='evidence_type')로 교체.
      { label: "거래 기준", tabs: ["vendor", "accountSubject", "category", "jeokyo", "evidence_type"] },
      { label: "품목·자산", tabs: ["item", "fixed_asset", "intangible_asset"] },
      // 계좌와 카드를 가른다 — 통장은 '얼마 있나', 카드는 '언제 빠져나가나'라 관리 축이 다르다.
      // 잔액은 계좌 상세 안으로 들어갔다 — '계좌 잔액' 탭은 뺀다(라우트는 계좌 화면을 띄운다)
      { label: "자금·결제", tabs: ["account", "card", "insurance"] },
      // 정기청구/정기지출은 기준정보(정적 참조)가 아니라 주문에서 파생되는 흐름이라 여기서 제거.
      // → 회계처리로 재배치 완료: 정기청구=판매·수주(매출)(route recurring_invoice), 정기지출=경비(route recurring_expense).
      //   패널은 이 파일에서 export해 App이 page 모드로 렌더한다.
    ],
  },
  settings: {
    title: "환경설정",
    sub: "회사 정보·사용자·결재선·장부 마감을 관리합니다.",
    groups: [
      // '문서 양식'(template)은 목업이라 제외. 실동작 항목만.
      { label: "회사", tabs: ["company"] },
      { label: "시스템", tabs: ["user", "approval", "reports"] },
      { label: "장부 마감", tabs: ["closing"] },
      { label: "기록", tabs: ["audit"] },
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
  const [editId, setEditId] = useState(null)
  const [editName, setEditName] = useState("")

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

  /* 수정 — 지금까지 없어서, 오타 하나를 고치려면 지우고 다시 만들어야 했다.
     그러면 새 id 가 생겨 이 직위를 가리키던 결재선이 끊긴다. */
  const startEdit = (item) => { setEditId(item.id); setEditName(item.name) }
  const saveEdit = async () => {
    const name = editName.trim()
    if (!name) return toast.push(`${label}명을 입력하세요`)
    if (items.some(i => i.id !== editId && i.name === name)) return toast.push("이미 있는 항목이에요")
    const res = await api.updateHrCode(editId, name)
    if (!res.ok) return toast.push(res.error || "저장 실패", { tone: 'warn' })
    setEditId(null); load(); toast.push("수정됐어요")
  }

  /* 순서 옮기기 — 이름순은 뜻이 없다(가나다로 세우면 '과장·대리·부장·사원'이 된다).
     화면에서 먼저 바꿔 보여주고 서버에 굳힌다. 실패하면 서버 값으로 되돌린다 —
     안 그러면 새로고침했을 때 순서가 슬그머니 제자리로 가 있다. */
  const move = async (idx, dir) => {
    const to = idx + dir
    if (to < 0 || to >= items.length) return
    const next = [...items]
    ;[next[idx], next[to]] = [next[to], next[idx]]
    setItems(next)
    const res = await api.reorderHrCodes(type, next.map(i => i.id))
    if (!res.ok) { toast.push(res.error || "순서를 저장하지 못했어요", { tone: 'warn' }); load() }
  }

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16 }}>
        {embedded ? (
          <div className="section-sub" style={{ alignSelf: 'center' }}>총 {items.length}개 · 화살표로 순서를 바꿔요</div>
        ) : (
          <div>
            <div className="section-title">{label} 관리</div>
            <div className="section-sub">총 {items.length}개 · 화살표로 순서를 바꿔요</div>
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
              <th style={{ width: 52 }}>순서</th>
              <th>{label}명</th>
              <th style={{ width: 150 }}></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={3} style={{ textAlign: "center", padding: 32, color: "var(--muted-2)", fontSize: 13 }}>
                등록된 {label}이 없어요. 위에서 추가하세요.
              </td></tr>
            )}
            {items.map((item, i) => (
              <tr key={item.id}>
                <td>
                  <div className="row gap-6" style={{ alignItems: 'center' }}>
                    <span className="num text-xs text-muted2" style={{ width: 14 }}>{i + 1}</span>
                    <div className="col" style={{ gap: 1 }}>
                      <button className="ord-btn" disabled={i === 0} title="위로"
                        onClick={() => move(i, -1)}>▲</button>
                      <button className="ord-btn" disabled={i === items.length - 1} title="아래로"
                        onClick={() => move(i, 1)}>▼</button>
                    </div>
                  </div>
                </td>
                <td className="fw-600">
                  {editId === item.id ? (
                    <input className="input" autoFocus value={editName} style={{ maxWidth: 260 }}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditId(null) }}/>
                  ) : item.name}
                </td>
                <td>
                  <div className="row gap-6">
                    {editId === item.id ? (
                      <>
                        <button className="btn primary" style={{ fontSize: 11, padding: "2px 8px" }} onClick={saveEdit}>저장</button>
                        <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => setEditId(null)}>취소</button>
                      </>
                    ) : (
                      <>
                        <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => startEdit(item)}>수정</button>
                        <button className="btn" style={{ fontSize: 11, padding: "2px 8px", color: "var(--neg)" }}
                          onClick={() => handleDelete(item)}>삭제</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* 연월일까지 적을 수도, 연월까지만 적을 수도 있는 날짜 칸.
 *
 * 오래된 설비는 명판에 '2011-06'처럼 연월까지만 찍혀 있는 일이 흔하다. 그렇다고 자유 입력으로
 * 두면 '2011.6'·'11년 6월'·'2011/06' 이 섞여 들어와 정렬이 깨진다. 그래서 **어느 단위로
 * 적을지 먼저 고르게 하고**, 그 단위에 맞는 달력 칸을 낸다. 저장은 'YYYY-MM-DD' 또는 'YYYY-MM'.
 *
 * min·max 를 준다 — 크롬의 연도 칸은 275760년까지 받아서, 안 주면 '20260'이 만들어진다. */
const PartDateInput = ({ value = '', onChange }) => {
  const v = String(value || '')
  const monthOnly = /^\d{4}-\d{2}$/.test(v)
  const [mode, setMode] = useState(monthOnly ? 'month' : 'day')
  /* 값이 바뀌면 그 값의 생김새에 모드를 맞춘다.
     아래 pick 이 단위를 바꿀 때 값도 그 단위로 맞춰 두므로, 이 effect 가 사용자의 선택을
     되돌리지 않는다. (예전엔 값이 비었나 아닌가만 보고 있어서, 드로어를 다시 쓰는 구조로
     바뀌면 '2020-03-14'를 월 칸에 넣으려다 빈칸으로 보이게 될 자리였다.) */
  useEffect(() => { setMode(monthOnly ? 'month' : 'day') }, [v])

  const pick = (m) => {
    setMode(m)
    if (!v) return
    // 연월일 → 연월은 잘라서 살리고, 연월 → 연월일은 없는 '일'을 지어낼 수 없으니 비운다
    onChange(m === 'month' ? v.slice(0, 7) : (v.length === 7 ? '' : v))
  }

  return (
    <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <input className="input num" style={{ maxWidth: 180 }}
        type={mode === 'month' ? 'month' : 'date'}
        min={mode === 'month' ? '1900-01' : '1900-01-01'}
        max={mode === 'month' ? '2099-12' : '2099-12-31'}
        value={v} onChange={e => onChange(e.target.value)}/>
      <div className="row gap-6">
        {[['day', '연월일'], ['month', '연월만']].map(([m, l]) => (
          <button key={m} type="button" className={`chip ${mode === m ? 'active' : ''}`}
            onClick={() => pick(m)} style={{ fontSize: 12 }}>{l}</button>
        ))}
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
    sub: '거래·주문·청구에 쓰는 품목을 관리합니다. 매입가·출고가를 넣으면 마진이 자동으로 잡혀요.',
    fields: [
      { key: 'code', label: '품목코드', kind: 'text', w: 110 },
      { key: 'name', label: '품명', kind: 'text', req: true },
      { key: 'item_kind', label: '유형', kind: 'select', options: ITEM_KINDS, w: 82,
        hint: '팔 것(제품·상품·서비스) / 살 것(원재료·부재료)' },
      { key: 'item_group', label: '분류', kind: 'text', w: 110, hint: '품목을 묶는 이름 (예: 웹서비스, 가공품)' },
      { key: 'spec', label: '규격', kind: 'text' },
      { key: 'unit', label: '단위', kind: 'text', w: 70 },
      { key: 'purchase_price', label: '매입가', kind: 'num', w: 110, hint: '원가 — 외주·자재 매입 단가' },
      { key: 'amount', label: '출고가', kind: 'num', w: 110, hint: '판매 단가 — 주문·청구서에 자동으로 채워져요' },
      { key: 'margin', label: '마진', kind: 'num', w: 100, calc: r => (Number(r.amount) || 0) - (Number(r.purchase_price) || 0) },
      /* 중량 — 거래명세서에 중량 칸이 있는 업종(금속·자재)이 있다. 대부분 표시용이지만
         ㎏당 단가로 파는 품목은 금액 = 중량 × 단가라, 무엇에 단가를 곱할지 함께 정한다.
         여기 값은 청구서 품목을 고를 때 출발점으로 채워지고, 청구서에서 줄마다 고칠 수 있다. */
      { key: 'weight', label: '중량', kind: 'dec', w: 90, hint: '단위당 중량 (소수 입력 가능)' },
      /* 표에는 기본값('수량')을 안 적는다 — 품목 166건이 전부 '수량'이라 그 글자가 벽처럼
         늘어서고, 정작 눈에 띄어야 할 '중량'이 그 안에 묻힌다(정상에는 표식을 붙이지 않는다). */
      // '단가 단위' — 단가를 무엇에 곱하나(개당/㎏당). 품목표의 같은 칸과 이름을 맞춘다
      { key: 'price_basis', label: '단가 단위', kind: 'select', options: [['qty', '수량'], ['weight', '중량']],
        w: 92, required: true, def: 'qty', mutedDefault: 'qty',
        hint: '금액을 무엇에 곱해 낼지 — 기본은 수량 × 단가' },
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
      // 자유 메모 — 보증보험이면 보증종류·귀속주문·보증금액 등 유형별 특수정보를 여기에.
      { key: 'memo', label: '비고', kind: 'text', hideCol: true,
        hint: '보증보험이면 보증종류·귀속주문·보증금액 등을 자유롭게 적어두세요' },
      { key: 'file', label: '증권 첨부', kind: 'file', hideCol: true },
    ],
  },
  fixed_asset: {
    type: 'fixed_asset', label: '고정자산',
    sub: '유형 고정자산(자산번호·제조사·규격·취득일)을 관리합니다.',
    fields: [
      { key: 'code', label: '자산번호', kind: 'text', w: 120 },
      { key: 'name', label: '자산명', kind: 'text', req: true },
      // 설비 대장에 필요한 것들 — 같은 이름의 기계도 제조사·규격이 다르면 다른 자산이다.
      { key: 'maker', label: '제조사', kind: 'text', w: 120 },
      { key: 'spec', label: '규격', kind: 'text', w: 150, hint: '모델명·용량·치수 등' },
      { key: 'amount', label: '취득가액', kind: 'num', w: 130 },
      /* 제조일자는 연월까지만 아는 경우가 흔하다(오래된 설비는 명판에 연월만 찍혀 있다).
         취득일과 달리 감가상각에 안 쓰이므로, 아는 만큼만 적게 둔다. */
      { key: 'made_at', label: '제조일자', kind: 'partdate', w: 130,
        hint: '연월일(2020-03-14) 또는 연월(2020-03)까지만 적어도 돼요' },
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
    // def 가 있는 select(단가 기준처럼 '비어 있으면 안 되는' 값)는 기본값으로 시작한다
    else o[fd.key] = fd.def ?? ''
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
    // 기본값인 행은 표에 적지 않는다 — 모든 줄에 같은 글자가 서면 다른 값이 안 보인다
    if (fd.mutedDefault != null && val === fd.mutedDefault) return '—'
    // 값/라벨 쌍 옵션은 저장값(qty)이 아니라 사람이 읽는 이름(수량)을 보여준다
    if (fd.kind === 'select' && Array.isArray(fd.options?.[0])) {
      const hit = fd.options.find(([v]) => v === val)
      return hit ? hit[1] : val
    }
    if (fd.kind === 'num') return fmtNum(val)
    // 중량 0은 '안 쓴다'는 뜻이라 숫자 0을 늘어놓지 않는다
    if (fd.kind === 'dec') return Number(val) ? String(Number(val)) : '—'
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
                /* 선택 항목이라 고른 칩을 다시 누르면 해제된다(과세유형처럼 '비워두기'가 뜻을 갖는 필드가 있다).
                   옵션은 문자열이거나 [저장값, 보여줄 이름] 쌍이다 — 저장값이 코드고 라벨이 한글인
                   필드가 있다(price_basis: qty/weight ↔ 수량/중량). 쌍을 안 받으면 한글이 그대로
                   저장돼 서버가 알아보지 못한다. */
                <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                  {fd.options.map(o => {
                    const [val, label] = Array.isArray(o) ? o : [o, o]
                    const on = form[fd.key] === val
                    return (
                      <button key={val} type="button" className={`chip ${on ? 'active' : ''}`}
                        onClick={() => f(fd.key, on && !fd.required ? '' : val)}>{label}</button>
                    )
                  })}
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
              ) : fd.kind === 'partdate' ? (
                <PartDateInput value={form[fd.key]} onChange={v => f(fd.key, v)}/>
              ) : fd.kind === 'file' ? (
                <RefFileField url={form.file_url} name={form.file_name} uploading={uploading}
                  onUpload={handleUpload} onRemove={() => setForm(p => ({ ...p, file_url: '', file_name: '' }))}/>
              ) : (
                /* 'dec' = 소수를 쓰는 수치(중량). 'num'은 정수라 12.5 를 넣으면 12 가 된다 —
                   ㎏ 단위에 g 을 적는 경우가 있어 잘리면 조용히 틀린 값이 저장된다.
                   콤마 서식도 넣지 않는다(입력 중에 소수점이 지워진다). */
                <input
                  className={`input ${fd.kind === 'num' || fd.kind === 'dec' ? 'num' : ''}`}
                  type={fd.kind === 'date' ? 'date' : 'text'}
                  inputMode={fd.kind === 'dec' ? 'decimal' : undefined}
                  value={fd.kind === 'num'
                    ? (form[fd.key] === '' || form[fd.key] == null ? '' : fmtNum(form[fd.key]))
                    : (form[fd.key] ?? '')}
                  onChange={e => f(fd.key,
                    fd.kind === 'num' ? (parseInt(e.target.value.replace(/[^0-9-]/g, ''), 10) || 0)
                    : fd.kind === 'dec' ? e.target.value.replace(/[^0-9.]/g, '')
                    : e.target.value)}
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
  /* ⚠ **순서가 규칙이다.** 위에서부터 먼저 걸린 것이 이긴다.
   *   · '예금주'는 '대표'보다 **먼저** 봐야 한다 — 둘 다 사람 이름이라 헷갈리기 쉽고,
   *     아래에 두면 '예금주명'이 /대표/ 에 안 걸려 통과할 뿐 순서를 믿을 수 없다.
   *   · '계좌번호'는 '사업자등록번호'보다 먼저 — 둘 다 '번호'가 들어간다.
   *   · '은행'은 '거래은행' 같은 머리글이 흔한데 /거래처/ 규칙에 먼저 걸리면 상호명이 된다.
   *     그래서 상호명 규칙보다 위에 둔다. */
  if (/예금주|수취인|holder/i.test(s)) return "예금주"
  if (/계좌|account(?!.*holder)|번호.*계좌/i.test(s)) return "계좌번호"
  if (/은행|bank/i.test(s)) return "은행"
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
  targets: ["상호명", "거래구분", "거래유형", "사업자번호", "대표자", "담당자", "전화", "팩스", "이메일", "주소",
    // 이체 정보 — 매입처 결제내역(월별 일괄이체 명단)이 이 셋을 각각 요구한다
    "은행", "계좌번호", "예금주"],
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

  /* ⚠ **은행·계좌번호·예금주가 여기서 빠져 있었다.**
   *
   * targets 에는 세 칸이 있어 사용자가 매핑까지 하는데, 정작 행을 만들 때 안 담았다.
   * 서버(routes/vendors.js import/commit)는 그 셋을 저장할 준비가 되어 있었으므로
   * **화면이 조용히 버린 것**이다 — "업로드 됐어요"라고 말하고 계좌번호만 사라졌다.
   * 매입처 결제내역(월별 일괄이체 명단)이 이 셋을 각각 요구해서, 빠지면 이체를 못 만든다.
   */
  mapRow: (g, opts) => ({
    name: g('상호명'), gubu: normGubu(g('거래구분')) || opts.defaultGubu,
    biz_no: g('사업자번호'), type: g('거래유형'), ceo: g('대표자'),
    contact: g('담당자'), phone: g('전화'), fax: g('팩스'), email: g('이메일'), address: g('주소'),
    bank_name: g('은행'), bank_account: g('계좌번호'), account_holder: g('예금주'),
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
  const [form, setForm] = useState({ name:'', gubu:'A', type:'', biz_no:'', ceo:'', contact:'', phone:'', fax:'', email:'', address:'', biz_type:'', biz_item:'', pay_account:'', bank_name:'', bank_account:'', account_holder:'' })
  // 계좌·담당자는 여러 줄이라 form 과 따로 든다(실물 명세서에 계좌가 셋 적혀 있다)
  const [vAccounts, setVAccounts] = useState([])
  const [vContacts, setVContacts] = useState([])

  // 기준정보 화면이므로 미사용까지 다 불러온다(다른 화면의 선택 목록은 사용중만 받는다).
  const load = () => api.getVendors({ all: true }).then(setVendors)
  useEffect(() => { load() }, [])

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const filtered = vendors.filter(v => {
    /* 계좌번호·예금주도 검색에 건다 — 통장 내역의 예금주 이름만 들고
       "이게 어느 거래처지"를 찾는 일이 실제로 있다. */
    const matchQ = !q || [v.name, v.biz_no, v.ceo, v.contact, v.phone, v.email,
      v.bank_account, v.account_holder].some(s => s?.includes(q))
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
    setForm({ name:'', gubu:'A', type:'', biz_no:'', ceo:'', contact:'', phone:'', fax:'', email:'', address:'', biz_type:'', biz_item:'', pay_account:'', bank_name:'', bank_account:'', account_holder:'' })
    setVAccounts([]); setVContacts([])
    setDrawerOpen(true)
  }
  const openEdit = async (v) => {
    setEditing(v)
    setForm({ name:v.name, gubu:v.gubu||'A', type:v.type||'', biz_no:v.biz_no||'', ceo:v.ceo||'', contact:v.contact||'', phone:v.phone||'', fax:v.fax||'', email:v.email||'', address:v.address||'', biz_type:v.biz_type||'', biz_item:v.biz_item||'', pay_account:v.pay_account||'',
      bank_name:v.bank_name||'', bank_account:v.bank_account||'', account_holder:v.account_holder||'' })
    /* 계좌·담당자는 목록이라 상세로 따로 받는다 — 거래처 목록에 전부 실으면
       드롭다운 한 번에 수백 줄이 따라온다(목록에는 '주'만 실린다). */
    setVAccounts([]); setVContacts([])
    setDrawerOpen(true)
    const full = await api.getVendor(v.id)
    if (full) { setVAccounts(full.accounts || []); setVContacts(full.contacts || []) }
  }
  const handleSave = async () => {
    if (!form.name) return toast.push('상호명을 입력하세요')
    const payload = { ...form, accounts: vAccounts, contacts: vContacts }
    const res = editing
      ? await api.updateVendor(editing.id, payload)
      : await api.addVendor(payload)
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
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="상호·담당자·연락처·계좌"/>
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
              {/* 이메일이 아니라 **계좌**를 보여준다.
                  이메일은 이 목록과 검색·폼에만 있고 실제로 쓰이는 데가 없다. 계좌는 다르다 —
                  매입 결제내역(월별 일괄이체 명단)이 은행·계좌번호·예금주를 그대로 요구하고,
                  비어 있으면 거기서 빨간 '계좌 없음'이 뜬다. 그런데 정작 거래처를 관리하는
                  이 목록에서는 뭐가 비었는지 볼 수 없었다 — 이체 직전에야 알게 된다.
                  (이메일은 상세·수정 폼에 그대로 있고 검색으로도 걸린다.) */}
              <th>계좌</th>
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
                <td className="text-sm">
                  {v.bank_account ? (
                    <>
                      <div className="num" style={{ fontSize: 12 }}>
                        {v.bank_name ? `${v.bank_name} ` : ''}{v.bank_account}
                      </div>
                      {/* 예금주가 상호와 다르면 적는다(개인 명의 계좌가 흔하다).
                          이 어긋남이 이체 사고의 흔한 원인이라, 같을 때는 굳이 안 적는다. */}
                      {v.account_holder && v.account_holder !== v.name && (
                        <div className="text-xs text-muted2">예금주 {v.account_holder}</div>
                      )}
                    </>
                  ) : <span className="text-muted2">—</span>}
                </td>
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
              <Combobox value={form.biz_type} onChange={v => f('biz_type', v)}
                options={bizTypeOptions()} placeholder="업태 선택 또는 직접 입력"
                onAddNew={q => f('biz_type', q)} addNewLabel="직접 입력"/>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ marginBottom: 8 }}>종목</label>
              <Combobox value={form.biz_item} onChange={v => f('biz_item', v)}
                options={bizItemOptions(form.biz_type)} placeholder="종목 선택 또는 직접 입력"
                onAddNew={q => f('biz_item', q)} addNewLabel="직접 입력"/>
            </div>
          </div>

          {/* 이체 정보 — 은행·계좌번호·예금주를 **나눠서** 받는다.
              매입처 결제내역서(월별 일괄이체 명단)가 각각을 열로 요구하고, 한 칸에 몰아
              적은 값에서 그걸 갈라내려면 표기가 제각각이라 반드시 틀린다.
              ⚠ 예금주는 상호와 다른 경우가 흔하다(개인 명의 계좌). 비워두면 상호로 대신하지만,
                 실제 명단에는 '김선국맑은유통' 같은 예금주가 섞여 있어 그대로 두면 이체가 튕긴다. */}
          <VendorSubList
            label="이체 계좌" addLabel="계좌 추가"
            hint="거래처가 계좌를 여러 개 주는 일이 흔해요. '주로 씀'으로 표시한 계좌가 매입 결제내역 명단에 실립니다."
            rows={vAccounts} onChange={setVAccounts} fields={ACCOUNT_FIELDS}/>

          <VendorSubList
            label="담당자" addLabel="담당자 추가"
            hint="영업·경리·배송 담당이 다른 경우가 많아요. 위쪽 전화·팩스·이메일은 회사 대표 연락처입니다."
            rows={vContacts} onChange={setVContacts} fields={CONTACT_FIELDS}/>

          {/* 예전에 한 칸으로 적어둔 값이 있으면 버리지 않고 보여준다 — 옮겨 적을 근거가 된다 */}
          {form.pay_account && vAccounts.length === 0 && (
            <div className="text-xs text-muted2">
              예전 지급계좌 입력: {form.pay_account} <span className="text-muted2">— 위 '계좌 추가'로 옮겨 적어주세요</span>
            </div>
          )}

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

/* 자금 계정 — 비목의 계정과목이 될 수 없다. 서버 lib/categoryAccount.js FUND_CODES 와 같은 값집합.
 * 거래는 계좌로 이미 한쪽 다리를 갖기 때문에, 상대 계정까지 예금·현금이면
 * `보통예금 / 보통예금` 이 되어 매출도 비용도 장부에 잡히지 않는다. */
const FUND_CODES = ["1101", "1102", "1103"]

const CategoryPanel = ({ embedded = false }) => {
  const toast = useToast()
  const [cats, setCats] = useState([])
  const [acctSubjects, setAcctSubjects] = useState([])
  const [q, setQ] = useState("")
  const [filterKind, setFilterKind] = useState("") // '' | 'exp' | 'inc'
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null = new
  const [form, setForm] = useState({ kind: "exp", name: "", vat: "10%", pay_method: "계좌이체", account_code: "" })

  const load = () => api.getCategories().then(setCats)
  useEffect(() => {
    load()
    api.getAccountSubjects({ postableOnly: true })
      .then(rows => setAcctSubjects(rows.filter(a => !FUND_CODES.includes(String(a.code)))))
  }, [])

  const acctNameOf = (code) =>
    acctSubjects.find(a => String(a.code) === String(code))?.name || ''

  const filtered = cats.filter(c =>
    (!filterKind || kindOf(c) === filterKind) &&
    (!q || c.name?.includes(q))
  )

  const openNew = () => {
    setEditing(null)
    setForm({ kind: filterKind === "inc" ? "inc" : "exp", name: "", vat: "10%", pay_method: "계좌이체", account_code: "" })
    setDrawerOpen(true)
  }
  const openEdit = (c) => {
    setEditing(c)
    // vat_deductible을 안 실으면 칩이 항상 '공제 가능'으로 보이고, 저장 시 서버가 1로 되돌린다
    // account_code도 같다 — 안 실으면 저장 한 번에 연결이 통째로 지워진다
    setForm({ kind: kindOf(c), name: c.name, vat: c.vat, pay_method: c.pay_method,
              vat_deductible: c.vat_deductible == null ? 1 : Number(c.vat_deductible),
              account_code: c.account_code || "" })
    setDrawerOpen(true)
  }
  const handleSave = async () => {
    if (!form.name.trim()) return toast.push("비목명을 입력하세요")
    // 매입세액 불공제(접대비 등)는 반드시 payload에 넣는다 — 빠지면 서버가 1(공제가능)로 강제한다
    const vatDeductible = (form.vat_deductible ?? 1) === 0 ? 0 : 1
    const acctCode = form.account_code || null
    const res = editing
      ? await api.updateCategory(editing.id, { name: form.name, group_name: editing.group_name || '', vat: form.vat, pay_method: form.pay_method, vat_deductible: vatDeductible, account_code: acctCode })
      : await api.addCategory({ kind: form.kind, name: form.name, vat: form.vat, pay_method: form.pay_method, vat_deductible: vatDeductible, account_code: acctCode })
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
              {/* 이 비목으로 등록한 거래가 장부에 어떤 계정으로 오르는지 — 경리가 분개를 맞출 때 본다 */}
              <th style={{ width: 180 }}>계정과목</th>
              <th style={{ width: 70 }}>부가세</th>
              <th style={{ width: 100 }}>결제수단</th>
              <th style={{ width: 100 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: "center", padding: 32, color: "var(--muted-2)" }}>비목이 없어요. 위에서 추가하세요.</td></tr>
            )}
            {filtered.map(c => (
              <tr key={c.id}>
                <td><span className={`badge ${kindOf(c) === "inc" ? "pos" : "warn"}`}>{kindOf(c) === "inc" ? "수입" : "지출"}</span></td>
                <td className="fw-600">{c.name}</td>
                <td className="text-sm">
                  {c.account_code
                    ? <span><span className="num text-xs text-muted2">{c.account_code}</span> {acctNameOf(c.account_code)}</span>
                    : <span className="text-xs" style={{ color: "var(--neg-ink)" }}>연결 안 됨</span>}
                </td>
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
          {/* 이 비목으로 등록한 거래가 장부에 어떤 계정으로 오르는지. 비워 두면 그 거래는
              상대 계정이 없어 일계표에서 차·대변 짝을 잃는다 — 그래서 표에도 '연결 안 됨'으로 세운다. */}
          <div>
            <label className="label">계정과목</label>
            <Combobox value={form.account_code || ""}
              onChange={v => setForm(p => ({ ...p, account_code: v }))}
              options={acctSubjects
                .filter(a => kindOf(form) === 'inc' ? a.acct_type === '수익' : a.acct_type !== '수익')
                .map(a => ({ value: String(a.code), label: a.name, sub: `${a.code} · ${a.category}`, keywords: a.note || "" }))}
              placeholder="계정과목 선택"
              allowAdd={false}/>
            <div className="text-xs text-muted" style={{ marginTop: 4 }}>
              거래를 등록할 때 계정과목을 비워두면 여기 값이 자동으로 들어가요.
              현금·예금은 계좌가 맡는 자리라 고를 수 없어요.
            </div>
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

/* 자주 쓰는 조정 사유. **DB가 아니라 고정 목록**이다 —
   기준정보 한 칸을 더 만들면 관리할 게 늘고, 정작 실무에서 쓰는 사유는 몇 개로 수렴한다.
   목록에 없으면 그냥 쳐서 넣으면 된다(거래처 칸과 같은 방식). */
const ADJUST_REASONS = [
  { value: '은행 수수료',        sub: '이체·송금·타행 수수료' },
  { value: '이자 입금',          sub: '예금 이자' },
  { value: '카드 연회비',        sub: '' },
  { value: '거래 누락분 반영',   sub: '통장에는 있는데 장부에 없던 건' },
  { value: '오입력 정정',        sub: '금액·계좌를 잘못 넣은 건' },
  { value: '기초 잔액 보정',     sub: '개설 시점 잔액이 실제와 달랐을 때' },
  { value: '통장 대조 차액',     sub: '원인을 못 찾은 잔액 차이' },
]

/* 잔액 조정 — 통장에 찍힌 잔액과 장부 잔액을 맞추는 유일한 경로.
 *
 * ── 왜 이 모양인가 ──
 * 예전 폼은 '차감/추가' 칩 + 금액 + 사유 세 칸이었고 **일자 칸이 아예 없었다**
 * (api.addAdjustment 가 오늘 날짜를 박아 보냈다). 그런데 실제로 하는 일은
 * "통장을 보니 8,500,000인데 앱은 8,400,000이다" 이지, "10만원을 더해야 한다"가 아니다.
 * 그래서 **조정 후 잔액**을 그대로 치게 하고 증감액은 자동으로 낸다. 반대로 쳐도 된다.
 *
 * ⚠ 조정 일자는 이력용 날짜가 아니다. 자금 현황·일계표(cashReport.balancesAsOf)가
 * 조정을 `date <= 기준일`로 잘라 합산하므로, 과거 날짜로 넣으면 **그날 이후 모든 잔액이
 * 같은 폭으로 움직인다.** 그래서 (1) 고른 날짜 기준 잔액을 보여주고
 * (2) 과거 날짜를 고르면 무엇이 바뀌는지 그 자리에서 말해 준다.
 * (오늘 잔액만 놓고 과거 날짜를 고르게 하면, 사람이 머릿속으로 되짚어 빼야 한다 —
 *  그 계산이 틀리면 조정이 또 틀린다.) */
const AdjustDrawer = ({ account, onClose, onSave }) => {
  const [date, setDate] = useState(todayStr())
  const [reason, setReason] = useState("")
  // 기준일 잔액. null = 아직 못 읽음(0원과 구별해야 한다)
  const [base, setBase] = useState(null)
  /* 사용자가 무엇을 쳤는지 기억한다 — 조정 후 잔액과 증감액은 서로를 덮으므로,
     '지금 쓰는 쪽'을 알아야 상대를 다시 계산해도 커서가 튀지 않는다. */
  const [target, setTarget] = useState("")   // 조정 후 잔액
  const [delta, setDelta] = useState("")     // 증감액(부호 포함)

  const accountId = account?.id
  useEffect(() => {
    if (!accountId) return
    setDate(todayStr()); setReason(""); setTarget(""); setDelta(""); setBase(null)
  }, [accountId])

  /* 날짜가 바뀌면 그 시점 잔액을 다시 읽는다. 늦게 온 응답이 최신 값을 덮지 않게 막는다.
     ⚠ 기준 잔액이 바뀌면 '조정 후 잔액'도 다시 잡아야 한다 — 안 그러면 6월 잔액 55만원 옆에
     8월 통장 기준으로 친 716만원이 그대로 남아, 화면의 세 숫자가 서로 안 맞는다.
     살리는 쪽은 **증감액**이다. 실제로 저장되는 값이 그것이고, '얼마를 조정한다'는
     날짜가 바뀌어도 그대로인 반면 '통장에 찍힌 잔액'은 날짜마다 다른 값이기 때문이다. */
  useEffect(() => {
    if (!accountId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { setBase(null); return }
    let alive = true
    api.getBalanceAsOf(accountId, date).then(b => {
      if (!alive) return
      setBase(b)
      if (b == null) return
      setDelta(d => {
        setTarget(d === "" ? "" : String(b + (Number(String(d).replace(/[^0-9-]/g, '')) || 0)))
        return d
      })
    })
    return () => { alive = false }
  }, [accountId, date])

  if (!account) return null

  const num = (s) => Number(String(s).replace(/[^0-9-]/g, '')) || 0
  const deltaNum = delta === "" ? null : num(delta)

  // 조정 후 잔액을 치면 증감액이 따라오고, 증감액을 치면 조정 후 잔액이 따라온다
  const onTarget = (raw) => {
    setTarget(raw)
    if (base == null || raw === "") return setDelta("")
    setDelta(String(num(raw) - base))
  }
  const onDelta = (raw) => {
    setDelta(raw)
    if (base == null || raw === "") return setTarget("")
    setTarget(String(base + num(raw)))
  }

  const isPast = date < todayStr()
  const canSave = base != null && deltaNum != null && deltaNum !== 0 && !!String(reason).trim()

  const handleSave = () => {
    if (!canSave) return
    onSave(account.id, { amount: deltaNum, reason: String(reason).trim(), date })
    onClose()
  }

  return (
    <Drawer open={!!account} onClose={onClose} width="min(520px, 100vw)">
      <DrawerHead title="잔액 조정" sub={account.name} onClose={onClose}/>
      <div className="drawer-body col gap-form">

        {/* 맞춰야 할 기준을 **맨 위에** 둔다 — 어느 통장인지(번호)와 지금 얼마인지가
            먼저 확정돼야 그 아래 숫자를 채울 수 있다. 통장을 옆에 놓고 보는 화면이다. */}
        <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
          <div className="row" style={{ alignItems: 'baseline', marginBottom: 8 }}>
            <span className="text-sm fw-600">{account.bankName || account.type}</span>
            {account.number && (
              <span className="num text-sm text-muted ml-auto">{account.number}</span>
            )}
          </div>
          <div className="row" style={{ alignItems: 'baseline' }}>
            {/* 어느 날짜 기준인지 라벨에 박는다 — 과거 날짜를 고르면 이 숫자가 바뀌므로,
                날짜를 안 적으면 "무엇의 잔액인지"가 사라진다. */}
            <span className="text-sm text-muted">{date || todayStr()} 기준 현재 잔액</span>
            <span className="num fw-700 ml-auto" style={{ fontSize: 18 }}>
              {base == null ? <span className="text-muted2 text-sm">불러오는 중…</span> : `${fmtNum(base)}원`}
            </span>
          </div>
        </div>

        <div>
          <label className="label">조정 일자</label>
          <DateInput className="input num" value={date} max={todayStr()}
            onChange={e => setDate(e.target.value)}/>
        </div>

        <div>
          <label className="label">조정 후 잔액 <span className="text-muted2">(통장에 찍힌 금액)</span></label>
          {/* allowNegative — 잔액은 음수가 될 수 있다(카드 미결제분, 마이너스 통장).
              빼면 '-550,000 → 549,999' 처럼 부호가 사라져 조정이 110만원짜리로 둔갑한다. */}
          <MoneyInput value={target} allowNegative placeholder={base == null ? "" : fmtNum(base)}
            onChange={raw => onTarget(raw)}/>
        </div>

        <div>
          <label className="label">증감액</label>
          <MoneyInput value={delta} allowNegative placeholder="+ 또는 - 금액"
            onChange={raw => onDelta(raw)}/>
          {deltaNum != null && deltaNum !== 0 && (
            <div className="text-sm" style={{ marginTop: 6, color: deltaNum > 0 ? 'var(--pos-ink, var(--brand-ink))' : 'var(--neg-ink)' }}>
              {deltaNum > 0 ? '＋' : '－'}{fmtNum(Math.abs(deltaNum))}원 {deltaNum > 0 ? '늘어납니다' : '줄어듭니다'}
            </div>
          )}
        </div>

        <div>
          <label className="label">조정 사유 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <Combobox
            value={reason} onChange={v => setReason(v)}
            options={ADJUST_REASONS.map(r => ({ value: r.value, label: r.value, sub: r.sub }))}
            placeholder="사유를 고르거나 직접 입력하세요"
            onAddNew={q => setReason(q)} addNewLabel="직접 입력"/>
          <div className="text-xs text-muted2" style={{ marginTop: 4 }}>
            나중에 "이 돈은 왜 조정됐나"에 답할 수 있어야 해요.
          </div>
        </div>

        {/* 과거 날짜의 뜻 — 고른 순간에 말해준다. 저장하고 나서 알면 늦다. */}
        {isPast && (
          <div className="card card-pad" style={{ background: 'var(--warn-soft)', border: '1px solid var(--warn-ink)' }}>
            <div className="row gap-8" style={{ alignItems: 'flex-start' }}>
              <Icon.Warn size={15} style={{ color: 'var(--warn-ink)', flexShrink: 0, marginTop: 2 }}/>
              <div className="text-sm" style={{ color: 'var(--warn-ink)' }}>
                <b>{date} 이후 잔액이 모두 바뀝니다.</b>
                <div style={{ marginTop: 4 }}>
                  이 날짜는 기록용이 아니에요 — 자금 현황·자금관리표·일계표가 이 날짜부터
                  조정을 반영하므로, {date}부터 오늘까지 모든 날의 잔액이
                  {deltaNum ? ` ${deltaNum > 0 ? '＋' : '－'}${fmtNum(Math.abs(deltaNum))}원씩 ` : ' 같은 폭으로 '}
                  움직입니다. 오늘 잔액은 어느 날짜를 고르든 같습니다.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <DrawerFooter onCancel={onClose} onSave={handleSave} saveLabel="조정 등록" saveDisabled={!canSave}/>
    </Drawer>
  )
}

// ── 회사 정보 패널 (자사 기준정보, 단일 레코드) ────────────────────
const CompanyPanel = ({ embedded = false }) => {
  const toast = useToast()
  const [form, setForm] = useState({ name:'', biz_no:'', ceo:'', biz_type:'', biz_item:'', address:'', phone:'', fax:'', email:'', main_account:'', closing_day: 0, week_start_day: 1,
    main_in_account_id: '', main_out_account_id: '', main_card_id: '' })
  const [accounts, setAccounts] = useState([])
  // 회계 처리 방식 — 저장 버튼과 무관하게 토글 즉시 반영된다(장부 규약이라 되돌리기 쉬워야 한다)
  const [acctPrefs, setAcctPrefs] = useState({ voucher_issuance: true })

  useEffect(() => {
    api.getCompany().then(c => {
      if (c) setForm({
        name: c.name||'', biz_no: c.biz_no||'', ceo: c.ceo||'', biz_type: c.biz_type||'',
        biz_item: c.biz_item||'', address: c.address||'', phone: c.phone||'', fax: c.fax||'',
        email: c.email||'', main_account: c.main_account||'',
        main_in_account_id: c.main_in_account_id || '',
        main_out_account_id: c.main_out_account_id || '',
        main_card_id: c.main_card_id || '',
        closing_day: Number(c.closing_day) || 0, week_start_day: Number(c.week_start_day ?? 1),
      })
    })
    api.getAccounts().then(list => setAccounts(list.filter(a => a.kind !== 'card')))
    api.getAccountingPrefs().then(setAcctPrefs)
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
          {/* 업태·종목은 사업자등록증에 적힌 문구를 그대로 옮기는 칸이다. 자유 입력이라
              같은 뜻을 여러 표기로 쓰게 되므로(소프트웨어개발/소프트웨어 개발/SW개발)
              표준 목록에서 고르게 하되, 목록에 없으면 직접 입력도 된다. */}
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>업태</label>
            <Combobox value={form.biz_type} onChange={v => f('biz_type', v)}
              options={bizTypeOptions()} placeholder="업태 선택 또는 직접 입력"
              onAddNew={q => f('biz_type', q)} addNewLabel="직접 입력"/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>종목</label>
            <Combobox value={form.biz_item} onChange={v => f('biz_item', v)}
              options={bizItemOptions(form.biz_type)} placeholder="종목 선택 또는 직접 입력"
              onAddNew={q => f('biz_item', q)} addNewLabel="직접 입력"/>
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

        <div style={{ height: 1, background:'var(--line)' }}/>

        {/* 주거래 계좌·카드 — 업무마다 늘 쓰는 그것을 계좌 선택에서 **앞에 세운다.**
            ⚠ 미리 고르지는 않는다. 자동 선택은 사용자가 확인 없이 지나가게 만들고,
              그러면 다른 통장에서 나간 돈이 주거래로 기록된다(현금/카드에서 실제로 겪었다).
              순서를 바꾸는 것은 틀린 기록을 만들지 않지만, 미리 고르는 것은 만든다. */}
        <div>
          <div className="fw-600" style={{ marginBottom: 4 }}>주거래 계좌·카드</div>
          <div className="text-xs text-muted2" style={{ marginBottom: 12 }}>
            업무마다 늘 쓰는 계좌를 지정하면 <b>계좌 고르는 자리에서 맨 앞에</b> 나와요.
            자동으로 골라지지는 않아요 — 확인 없이 지나가면 엉뚱한 통장에 기록될 수 있어서요.
          </div>
          <div className="row gap-16" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {[
              ['main_in_account_id',  '주입금 계좌', '돈이 들어오는 일 — 청구서 입금·수시입금', a => a.kind !== 'card'],
              ['main_out_account_id', '주지출 계좌', '돈이 나가는 일 — 지급·경비·이체',       a => a.kind !== 'card'],
              ['main_card_id',        '주카드',     '카드로 쓰는 일',                        a => a.kind === 'card'],
            ].map(([key, label, hint, pick]) => (
              <div key={key} style={{ flex: 1, minWidth: 220 }}>
                <label className="label" style={{ marginBottom: 8 }}>{label}</label>
                <Combobox value={form[key] || ''} onChange={v => f(key, v)} allowAdd={false}
                  options={[{ value: '', label: '지정 안 함' },
                    ...accounts.filter(pick).map(a => ({ value: a.id, label: a.name, sub: a.bank || undefined }))]}
                  placeholder={`${label} 선택`}/>
                <div className="text-xs text-muted2" style={{ marginTop: 6 }}>{hint}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ height: 1, background:'var(--line)' }}/>

        {/* 회사가 세는 '한 달'과 '한 주'.
            25일 마감이면 7월분은 6/26~7/25 다 — 달력월로 세면 매입현황 표가 실물과 영영 안 맞는다. */}
        <div>
          <div className="fw-600" style={{ marginBottom: 4 }}>집계 기간</div>
          <div className="text-xs text-muted2" style={{ marginBottom: 12 }}>
            매입·매출 현황을 어느 구간으로 묶을지 정해요. 장부 마감(월 마감)과는 다른 설정이에요.
          </div>

          <div className="row gap-16" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <label className="label" style={{ marginBottom: 8 }}>마감일</label>
              <Combobox value={String(form.closing_day)} onChange={v => f('closing_day', Number(v) || 0)} allowAdd={false}
                options={[{ value: '0', label: '달력월 그대로 (1일~말일)' },
                  ...Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `매월 ${i + 1}일 마감` }))]}
                placeholder="마감일 선택"/>
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                {form.closing_day > 0
                  ? `7월분은 6월 ${form.closing_day + 1}일 ~ 7월 ${form.closing_day}일로 집계돼요.`
                  : '7월분은 7월 1일 ~ 7월 31일로 집계돼요.'}
                {/* 29~31 은 2월에 없는 날짜라 그 달만 조용히 어긋난다 — 아예 고를 수 없게 뒀다 */}
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 220 }}>
              <label className="label" style={{ marginBottom: 8 }}>주 시작 요일</label>
              <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                {['일', '월', '화', '수', '목', '금', '토'].map((d, i) => (
                  <button key={i} className={`chip ${form.week_start_day === i ? 'active' : ''}`}
                    onClick={() => f('week_start_day', i)}>{d}</button>
                ))}
              </div>
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>주별 소계를 이 요일부터 끊어요.</div>
            </div>
          </div>
        </div>

        <div style={{ height: 1, background: 'var(--line)' }}/>

        {/* 회계 처리 방식 — 일계표가 무엇을 세는지 정한다.
            저장 버튼을 거치지 않고 토글 즉시 반영한다(되돌리기 쉬워야 하는 장부 규약). */}
        <div>
          <label className="label" style={{ marginBottom: 8 }}>회계 처리 방식</label>
          <div className="row gap-10" style={{ alignItems: 'flex-start' }}>
            <button type="button"
              className={`chip ${acctPrefs.voucher_issuance ? 'active' : ''}`}
              onClick={async () => {
                const next = !acctPrefs.voucher_issuance
                setAcctPrefs(p => ({ ...p, voucher_issuance: next }))
                const res = await api.setAccountingPref('voucher_issuance', next)
                if (!res.ok) {
                  setAcctPrefs(p => ({ ...p, voucher_issuance: !next }))   // 실패하면 되돌린다
                  toast.push(res.error || '바꾸지 못했어요', { tone: 'warn' })
                } else {
                  toast.push(next ? '청구서 발행분도 일계표에 셉니다' : '돈이 오간 거래만 셉니다')
                }
              }}>
              청구서 발행 시점도 장부에 올리기
            </button>
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6, lineHeight: 1.7 }}>
            {acctPrefs.voucher_issuance
              ? <>켜짐 · 청구서를 <b>발행한 날</b>에 받을 돈(외상매출금)이 생기고, 입금될 때 사라지는 것으로 봐요.
                  두 시점이 다 잡혀야 장부가 맞습니다.</>
              : <>꺼짐(기본) · <b>돈이 실제로 오간 거래만</b> 셉니다. 은행 기준으로 전표를 끊는 방식이에요.</>}
          </div>
          {/* 켜기 전에 무엇을 정리해야 하는지 먼저 알린다 — 모르고 켜면 매출이 두 번 잡힌다 */}
          {!acctPrefs.voucher_issuance && (
            <div className="text-xs text-muted2" style={{ marginTop: 8, lineHeight: 1.7, paddingLeft: 10, borderLeft: '2px solid var(--line)' }}>
              켜시기 전에 두 가지를 확인해주세요.<br/>
              · <b>매입 청구서에 비목</b>이 들어 있어야 해요. 없으면 그 청구서는 장부에 못 올라갑니다(일계표가 알려줘요).<br/>
              · 청구서와 입금 거래를 <b>정산으로 연결</b>해두셔야 해요. 따로 두면 매출이 두 번 잡힙니다.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 계좌 / 카드 등록 패널 ────────────────────────────────────────
/* 계좌 유형 — **결제수단**만 여기 선다.
 *
 * '정기예금'을 뺐다. accounts 는 거래 등록·급여이체·청구서 정산 등 11곳에서 결제수단
 * 드롭다운으로 쓰이고, 잔액은 자금 예측의 '쓸 수 있는 돈'에 그대로 합산된다(balancesAsOf).
 * 정기예금을 여기 두면 (1) 묶인 돈이 가용 잔액으로 잡히고 (2) "정기예금 통장에서 외주비
 * 지급"이 조용히 만들어진다. 실제로 fowin 이 퇴직연금 신탁을 정기예금 계좌로 등록해 두고
 * 예금·적금 화면에도 같은 금액을 넣어, 904,870원이 **가용 잔액과 묶인 돈 양쪽에** 잡혀 있었다.
 *
 * 정기예금·적금·보증금·퇴직연금은 전부 적금·정기예금·보증금 화면(savings)에서 관리한다. */
/* ⚠ '현금'은 통장이 아니라 **금고 시재**다. 그런데 계좌 종류의 하나로 둔다 — 새 kind 를
   만들지 않는 이유가 셋 있다.
     1. lib/acctCode.js 가 이미 현금:'1101' 을 매핑하고 db.js 에 백필 CASE 까지 있다.
        설계 의도가 '계좌 종류의 하나'였는데 화면만 그 문을 안 열어 뒀다.
     2. kind='cash' 를 새로 만들면 `kind !== 'card'` 로 통장을 세는 자리 13곳을 전부
        재검토해야 한다(잔액·자금예측·일계표·계좌표…).
     3. **통장 → 현금 인출**이 기존 계좌 이체로 그냥 된다. 실제로 있는 거래다.
   대신 **회사에 하나만** 두게 서버가 막는다(routes/accounts.js) — 여러 개면 "어느 금고에서
   뺐나"가 되어 시재가 안 맞는다. 회계의 현금 계정도 회사에 하나다. */
const BANK_TYPES = ['보통예금', '당좌예금', '현금']
const CARD_TYPES = ['법인카드', '개인카드', '체크카드']
// kind 를 받아 그 화면에 맞는 빈 폼을 낸다 — 카드 화면에서 '새로 등록'을 누르면 카드로 시작해야 한다
const emptyAccountForm = (kind = 'bank') => ({
  kind, type: kind === 'card' ? '법인카드' : '보통예금',
  bank: '', number: '', name: '', purpose: '', initial_balance: '', owner: 'corp',
  card_pay_day: '', card_pay_account_id: '', card_type: 'credit',
})

/* 계좌 / 카드 — **한 테이블(accounts)에 kind 로 나뉜 두 가지**를 각각의 화면으로 낸다.
 *
 * ── 왜 갈랐나 ──
 * 통장과 법인카드는 성격이 다르다. 통장은 '지금 얼마 있나'(잔액)가 핵심이고,
 * 카드는 '언제 얼마가 빠져나가나'(결제일·결제계좌)가 핵심이다. 한 표에 섞어 두니
 * 카드 행의 잔액 칸이 늘 '—' 로 비어 있었고, 잔액 조정 화면에는 카드까지 딸려 들어갔다.
 *
 * ⚠ DB 는 그대로 한 테이블이다. 거래 등록의 '계좌' 선택은 카드로 결제한 지출도 잡아야 해서
 * 여전히 둘을 합쳐 보여준다 — 가른 것은 **관리 화면**이지 데이터가 아니다. */
const AccountPanel = ({ embedded = false, kind = 'bank' }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [accounts, setAccounts] = useState([])
  const [q, setQ] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyAccountForm(kind))
  const isCardPanel = kind === 'card'
  /* 드로어는 **보는 것이 먼저**다. 예전엔 계좌 하나를 들여다볼 방법이 수정 폼을 여는 것뿐이라,
     계좌번호만 확인하려 해도 편집 가능한 칸 한가운데에 서 있어야 했다. */
  const [mode, setMode] = useState('view')       // 'view' | 'edit'
  const [adjustTarget, setAdjustTarget] = useState(null)
  const [histTarget, setHistTarget] = useState(null)
  const [adjustments, setAdjustments] = useState(null)   // null = 아직 못 읽음

  const load = () => api.getAccounts().then(setAccounts)
  useEffect(() => { load() }, [])

  /* 상세를 열 때 그 계좌의 조정 이력만 읽는다(목록 전체를 미리 읽지 않는다).
     카드는 잔액이 없으니 부르지 않는다 — 없는 것을 조회하면 빈 이력이 '조정 0건'으로 보인다. */
  useEffect(() => {
    if (!drawerOpen || !editing || isCardPanel) { setAdjustments(null); return }
    let alive = true
    api.getAdjustments(editing.id).then(list => { if (alive) setAdjustments(list || []) }).catch(() => {})
    return () => { alive = false }
  }, [drawerOpen, editing?.id, isCardPanel])

  const reloadDetail = async () => {
    await load()
    if (editing && !isCardPanel) api.getAdjustments(editing.id).then(setAdjustments).catch(() => {})
  }

  const handleAdjust = async (accountId, data) => {
    // 결과를 안 보고 성공 문구를 띄우면, 마감된 달이라 거절돼도 등록된 줄 안다
    const res = await api.addAdjustment(accountId, data)
    if (!res.ok) { toast.push(res.error || '잔액 조정에 실패했어요', { tone: 'warn' }); return }
    toast.push('잔액 조정이 등록됐어요')
    reloadDetail()
  }

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  /* 드로어가 들고 있는 editing 은 열 때 떠 온 사본이라 잔액을 조정해도 그대로다.
     화면에 쓸 값은 늘 방금 다시 읽은 목록에서 집는다 — 조정하고 나서 옛 잔액이 남아 있으면
     "조정이 안 먹었나" 싶어 한 번 더 조정하게 된다. */
  const detail = editing ? (accounts.find(a => a.id === editing.id) || editing) : null

  const filtered = accounts.filter(a => (a.kind === 'card') === isCardPanel).filter(a =>
    !q || [a.name, a.bankName, a.number, a.purpose, a.type].some(s => s?.includes(q))
  )

  // 새로 만들 때는 볼 것이 없으니 곧장 입력 모드로 연다
  const openNew = () => { setEditing(null); setForm(emptyAccountForm(kind)); setMode('edit'); setDrawerOpen(true) }

  /* 건수는 **이 화면이 실제로 보여주는 것**만 센다. accounts.length(전체 9건)를 쓰면
     카드 3장짜리 화면에 '총 9건'이 떠서, 표와 머리글이 서로 다른 말을 한다. */
  const ownCount = accounts.filter(a => (a.kind === 'card') === isCardPanel).length
  const headerSub = isCardPanel
    ? `총 ${ownCount}장 · 결제수단으로 사용됩니다`
    : `총 ${ownCount}개 · 입출금이 기록되는 통장이에요`
  const openDetail = (a) => { fillForm(a); setMode('view'); setDrawerOpen(true) }

  const fillForm = (a) => {
    setEditing(a)
    setForm({
      kind: a.kind || 'bank',
      type: a.type || (a.kind === 'card' ? '법인카드' : '보통예금'),
      bank: a.bankName || '',
      number: a.number || '',
      name: a.name || '',
      purpose: a.purpose || '',
      owner: a.owner === 'personal' ? 'personal' : 'corp',
      card_pay_day: a.cardPayDay || '',
      card_pay_account_id: a.cardPayAccountId || '',
      card_type: a.cardType || 'credit',
      initial_balance: a.initialBalance ?? '',
    })
    setDrawerOpen(true)
  }

  const handleSave = async () => {
    if (!form.name) return toast.push('별칭을 입력하세요')
    const payload = {
      name: form.name, bank: form.bank, type: form.type, kind,
      number: form.number, purpose: form.purpose, owner: form.owner,
      card_type: isCard ? (form.card_type || 'credit') : 'credit',
      card_pay_day: isCard ? form.card_pay_day : 0,
      card_pay_account_id: isCard ? (form.card_pay_account_id || null) : null,
      initial_balance: form.kind === 'bank' ? (parseInt(String(form.initial_balance).replace(/[^0-9-]/g, '')) || 0) : 0,
    }
    const res = editing ? await api.updateAccount(editing.id, payload) : await api.addAccount(payload)
    if (!res.ok) return toast.push(res.error || '저장 실패', { tone: 'warn' })
    toast.push(editing ? '수정됐어요' : '등록됐어요')
    // 고친 뒤엔 상세로 돌아간다 — 무엇이 바뀌었는지 그 자리에서 보이는 게 확인이다
    if (editing) setMode('view'); else setDrawerOpen(false)
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
    /* 드로어를 닫는다. 상세(view)에서도 삭제할 수 있게 된 뒤로, 안 닫으면 지워진 계좌가
     * 그대로 떠 있다 — detail 은 `accounts.find(...) || editing` 이라 목록에서 사라진 뒤엔
     * **낡은 사본**으로 떨어진다. 거기서 수정을 누르면 없는 계좌를 저장하려다 404가 난다. */
    setDrawerOpen(false)
    load()
  }

  /* 종류는 **화면이 정한다**(form 이 아니라). 카드 화면에서 '계좌'로 바꿔 저장하면
     그 항목이 계좌 탭으로 넘어가 목록에서 사라진다 — 지운 것처럼 보인다.
     그래서 드로어에서 종류 선택을 없애고 여기서 못 박는다. */
  const isCard = isCardPanel
  /* 목록에 없는 옛 값(예: '정기예금')을 쓰는 계좌가 남아 있으면 그 값도 칩으로 세운다.
     안 그러면 수정 화면에서 아무 칩도 안 눌린 채로 떠서 "종류가 비었네"로 읽힌다 —
     실제로는 form.type 에 그대로 들어 있어 저장해도 안 바뀐다. 보이는 것과 다른 상태다. */
  const baseTypes = isCard ? CARD_TYPES : BANK_TYPES
  const subTypes = form.type && !baseTypes.includes(form.type) ? [...baseTypes, form.type] : baseTypes

  return (
    <div style={{ padding: 20 }}>
      <div className="row" style={{ marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
        {embedded ? (
          <div className="section-sub" style={{ alignSelf: 'center' }}>{headerSub}</div>
        ) : (
          <div>
            <div className="section-title">{isCardPanel ? '카드' : '계좌'}</div>
            <div className="section-sub">{headerSub}</div>
          </div>
        )}
        <div className="search" style={{ margin: 0, marginLeft: 'auto', width: 200, padding: '6px 10px' }}>
          <Icon.Search size={14}/>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={isCardPanel ? '별칭·카드사·번호' : '별칭·은행·번호'}/>
        </div>
        <button className="btn primary" onClick={openNew}><Icon.Plus size={14}/> {isCardPanel ? '카드' : '계좌'} 등록</button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th>별칭</th>
              <th>세부유형</th>
              <th>{isCardPanel ? '카드사' : '은행'}</th>
              <th>번호</th>
              <th>용도</th>
              {isCardPanel
                ? <><th>결제일</th><th>결제 계좌</th></>
                : <th className="num-right">잔액</th>}
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={isCardPanel ? 8 : 7} style={{ textAlign: 'center', padding: 32, color: 'var(--muted-2)' }}>등록된 {isCardPanel ? '카드' : '계좌'}가 없어요</td></tr>
            )}
            {filtered.map(a => (
              <tr key={a.id}>
                <td className="fw-700">
                  {a.name}
                  {/* 개인 것만 표시한다 — 법인이 대부분이라 양쪽에 다 붙이면 표가 시끄럽다 */}
                  {a.owner === 'personal' && (
                    <span className="badge" style={{ marginLeft: 6, fontSize: 10 }}>개인</span>
                  )}
                </td>
                {/* 카드는 소유·결제방식이 곧 종류다(위 폼 주석 참조). type 은 옛 값이라 안 쓴다. */}
                <td className="text-sm text-muted">
                  {isCard
                    ? [a.owner === 'personal' ? '대표 개인' : '법인', a.cardType === 'check' ? '체크' : '신용'].join(' · ')
                    : (a.type || '—')}
                </td>
                <td className="text-sm">{a.bankName || '—'}</td>
                <td className="text-sm num">{a.number || '—'}</td>
                <td className="text-sm">{a.purpose || '—'}</td>
                {isCardPanel ? (
                  <>
                    <td className="text-sm num">{a.card_pay_day ? `매월 ${a.card_pay_day}일` : '—'}</td>
                    <td className="text-sm">{accounts.find(x => x.id === a.card_pay_account_id)?.name || '—'}</td>
                  </>
                ) : (
                  <td className="num-cell num-right">{a.currentBalance == null ? '—' : fmtNum(a.currentBalance)}</td>
                )}
                <td>
                  <div className="row gap-6">
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => openDetail(a)}>상세</button>
                    <button className="btn" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--neg)' }} onClick={() => handleDelete(a)}>삭제</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} confirmClose={mode === 'edit'}>
        <DrawerHead
          title={editing ? detail?.name : `${isCard ? '카드' : '계좌'} 등록`}
          /* 카드는 옛 type(법인카드/체크카드…) 대신 소유·결제방식으로 적는다 —
             목록·상세와 같은 말이어야 한다(폼에서 그 칩을 걷어낸 이유와 같다). */
          sub={editing ? (mode === 'view'
            ? [detail?.bankName, isCard
                ? [detail?.owner === 'personal' ? '대표 개인' : '법인', detail?.cardType === 'check' ? '체크' : '신용'].join(' · ')
                : detail?.type].filter(Boolean).join(' · ')
            : '수정 중') : null}
          onClose={() => setDrawerOpen(false)}/>

        {mode === 'view' && detail ? (
          <div className="drawer-body col gap-16">
            {/* 잔액 — 통장에만 있다. 카드는 결제수단이라 담아 두는 돈이 없다. */}
            {!isCard && (
              <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
                <div className="row">
                  <div className="text-sm text-muted">현재 잔액</div>
                  <div className="num fw-700 ml-auto" style={{ fontSize: 24, letterSpacing: '-0.02em' }}>
                    {detail.currentBalance == null ? '—' : fmtNum(detail.currentBalance)}
                  </div>
                </div>
                {/* 잔액이 어떻게 나온 숫자인지 보여준다 — 근거 없이 뜬 금액은 못 믿는다 */}
                <div className="row text-xs text-muted2" style={{ marginTop: 6, gap: 10 }}>
                  <span>초기잔액 <span className="num">{fmtNum(detail.initialBalance)}</span></span>
                  <span>·</span>
                  <span>거래 집계 반영됨</span>
                  <span>·</span>
                  <span style={{ color: adjustments?.length ? 'var(--warn-ink)' : undefined }}>
                    조정 {adjustments == null ? '…' : adjustments.length ? `${adjustments.length}건` : '없음'}
                  </span>
                </div>
                <div className="row gap-8" style={{ marginTop: 14 }}>
                  <button className="btn primary" style={{ fontSize: 12 }} onClick={() => setAdjustTarget(detail)}>
                    <Icon.Plus size={12}/> 잔액 조정
                  </button>
                  <button className="btn" style={{ fontSize: 12 }} disabled={!adjustments?.length}
                    onClick={() => setHistTarget(detail)}>
                    <Icon.Clock size={12}/> 조정 이력
                  </button>
                </div>
              </div>
            )}

            <dl className="detail-list">
              <dt>{isCard ? '카드 종류' : '예금 종류'}</dt>
              <dd>{isCard
                ? [detail.owner === 'personal' ? '대표 개인' : '법인', detail.cardType === 'check' ? '체크' : '신용'].join(' · ')
                : (detail.type || '—')}</dd>
              <dt>{isCard ? '카드사' : '은행'}</dt><dd>{detail.bankName || '—'}</dd>
              <dt>{isCard ? '카드번호' : '계좌번호'}</dt><dd className="num">{detail.number || '—'}</dd>
              <dt>용도</dt><dd>{detail.purpose || '—'}</dd>
              <dt>소유</dt><dd>{detail.owner === 'personal' ? '대표 개인' : '법인'}</dd>
              {isCard && <>
                <dt>결제일</dt><dd>{detail.cardPayDay ? `매월 ${detail.cardPayDay}일` : '설정 안 함'}</dd>
                <dt>결제 계좌</dt><dd>{accounts.find(x => x.id === detail.cardPayAccountId)?.name || '—'}</dd>
              </>}
            </dl>
          </div>
        ) : (
        <div className="drawer-body col gap-form">
          {/* 예금 종류는 통장에만 낸다.
              ⚠ 카드에서 걷어낸 이유: 옛 목록이 `법인카드 / 개인카드 / 체크카드` 였는데
                이건 **두 축을 한 칸에 섞은 것**이다 — 법인/개인은 '소유', 체크는 '결제 방식'.
                그런데 이 폼에는 소유(owner)와 결제 방식(card_type)이 각각 따로 있다.
                셋을 두면 서로 모순될 수 있다(종류=개인카드인데 소유=법인, 종류=체크카드인데
                결제방식=신용). 실제로 운영 데이터에 카드인데 종류가 '보통예금'인 것도 있었다.
                → 소유는 owner, 결제 방식은 card_type 하나씩만 쓴다. */}
          {!isCard && (
            <div>
              <label className="label" style={{ marginBottom: 8 }}>예금 종류</label>
              <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                {subTypes.map(t => (
                  <button key={t} type="button" className={`chip ${form.type === t ? 'active' : ''}`} onClick={() => f('type', t)}>{t}</button>
                ))}
              </div>
            </div>
          )}

          {/* 신용 / 체크 — **결제 방식이 정반대**라 먼저 갈라야 한다.
                신용  사용액이 쌓였다가 결제일에 통장에서 한꺼번에 빠진다 → 결제일·결제계좌가 필요
                체크  쓴 **즉시** 통장에서 빠진다 → 결제일이 없고 옮길 돈도 없다
              구분이 없던 시절엔 체크카드에도 결제일이 붙어, 이미 빠진 돈을 자금일보가
              "그 날 한꺼번에 빠질 돈"으로 한 번 더 세웠다(있지도 않은 출금). */}
          {isCard && (
            <div>
              <label className="label" style={{ marginBottom: 8 }}>카드 종류</label>
              <div className="row gap-6">
                {[['credit', '신용카드'], ['check', '체크카드']].map(([v, l]) => (
                  <button key={v} type="button" className={`chip ${(form.card_type || 'credit') === v ? 'active' : ''}`}
                    onClick={() => f('card_type', v)}>{l}</button>
                ))}
              </div>
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                {(form.card_type || 'credit') === 'check'
                  ? '쓴 즉시 통장에서 빠져요. 결제일이 없어 자금 예측에 따로 잡지 않습니다.'
                  : '결제일에 통장에서 한꺼번에 빠져요. 그 날짜와 통장을 아래에 적어주세요.'}
              </div>
            </div>
          )}

          {/* 카드 결제일 — 신용카드만. 쓰는 날과 돈이 빠지는 날이 다르다.
              이게 없으면 이번 달 카드값이 며칠에 어느 통장에서 빠지는지 자금 예측이 모른다.
              비워두면 예측하지 않는다 — 모르는 날짜를 지어내면 그 날 잔고가 틀린다. */}
          {isCard && (form.card_type || 'credit') === 'credit' && (
            <div className="row gap-16" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <label className="label" style={{ marginBottom: 8 }}>결제일</label>
                <Combobox value={String(form.card_pay_day || '')} allowAdd={false}
                  onChange={v => f('card_pay_day', v)}
                  options={[{ value: '', label: '설정 안 함' },
                    ...Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `매월 ${i + 1}일` }))]}
                  placeholder="결제일 선택"/>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label" style={{ marginBottom: 8 }}>결제 계좌</label>
                <Combobox value={form.card_pay_account_id || ''} allowAdd={false}
                  onChange={v => f('card_pay_account_id', v)}
                  options={[{ value: '', label: '선택 안 함' },
                    ...accounts.filter(a => a.kind !== 'card').map(a => ({ value: a.id, label: a.name }))]}
                  placeholder="어느 통장에서 빠지나요"/>
              </div>
            </div>
          )}
          {isCard && (form.card_type || 'credit') === 'credit' && (
            <div className="text-xs text-muted2" style={{ marginTop: -8 }}>
              결제일을 넣으면 이번 달 사용액이 그 날 이 통장에서 빠지는 것으로 자금 현황에 잡혀요.
              실제 결제는 <b>지급처리 → 카드 대금 지급</b>에서 한 번에 처리할 수 있어요.
            </div>
          )}

          {/* 소유 — 중소기업은 대표 개인 계좌·카드로 회사 돈을 쓰는 일이 흔하다.
              자금 현황에서 법인/개인 합계를 가르는 근거이고, 개인 잔액은 마스터만 본다.
              회계(손익·부가세)는 계좌가 아니라 등록된 거래로 잡히므로 이 값과 무관하다. */}
          <div>
            <label className="label" style={{ marginBottom: 8 }}>소유</label>
            <div className="row gap-6">
              {[['corp', '법인'], ['personal', '대표 개인']].map(([v, t]) => (
                <button key={v} type="button" className={`chip ${form.owner === v ? 'active' : ''}`}
                  onClick={() => f('owner', v)}>{t}</button>
              ))}
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
              {form.owner === 'personal'
                ? '자금 현황에서 법인과 따로 집계돼요. 잔액은 마스터에게만 보입니다.'
                : '회사 명의 계좌·카드예요.'}
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
                {/* 초기 잔액과 잔액 조정은 둘 다 잔액을 움직이지만 성격이 다르다.
                    여기는 '출발점'이고, 조정은 그 뒤에 생긴 차이를 사유와 함께 남기는 기록이다. */}
                <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                  등록 시점 통장 잔액이에요. 이후 생긴 차이는 상세의 <b>잔액 조정</b>으로 맞추세요.
                </div>
              </div>
            )}
          </div>
        </div>
        )}

        {mode === 'view' && detail ? (
          <div className="drawer-foot">
            <button className="btn" style={{ color: 'var(--neg)' }} onClick={() => handleDelete(detail)}>삭제</button>
            <button className="btn ml-auto" onClick={() => setDrawerOpen(false)}>닫기</button>
            <button className="btn primary" onClick={() => { fillForm(detail); setMode('edit') }}>수정</button>
          </div>
        ) : (
          <DrawerFooter
            onCancel={() => (editing ? setMode('view') : setDrawerOpen(false))}
            onSave={handleSave}/>
        )}
      </Drawer>

      {/* 조정 이력 — 계좌 상세 위에 겹쳐 뜬다(Drawer 스택이 Esc 를 맨 위 것부터 닫는다) */}
      <Drawer open={!!histTarget} onClose={() => setHistTarget(null)}>
        <DrawerHead title="조정 이력" sub={histTarget?.name} onClose={() => setHistTarget(null)}/>
        <div className="drawer-body">
          {!adjustments?.length ? (
            <div className="text-muted text-sm" style={{ padding: '20px 0' }}>조정 이력이 없습니다</div>
          ) : adjustments.map((a, i) => (
            <div key={a.id || i} style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="row">
                <span className="text-sm text-muted">{a.date}</span>
                <span className="num fw-700 ml-auto" style={{ color: a.amount < 0 ? 'var(--neg-ink)' : 'var(--pos)' }}>
                  {a.amount > 0 ? '+' : ''}{fmtNum(a.amount)}
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
const RecurringFormDrawer = ({ open, editing, onClose, onSave, vendors = [], accounts = [], contracts = [], addGubu = 'A', reloadVendors }) => {
  const empty = { vendor_id: "", contract_id: null, category: "", amount: "", vat_mode: "exclusive", period: "monthly", day_of_month: "1", start_date: todayStr(), end_date: "", account_id: "", pay_term: "net30", pay_day: 1, evidence_required: false, amount_mode: "fixed" }
  const [form, setForm] = useState(empty)
  // 비목은 반드시 실제 비목 마스터에서 고른다. 예전엔 ["임차료","통신비"…]를 하드코딩해서,
  // 마스터 이름과 한 글자라도 다르면(예: 마스터는 '통신비(관리)') 회차를 청구서로 만들 때
  // 비목을 못 찾아 부가세가 면세로 떨어졌다. 이름이 곧 조인 키다(recurring_expenses.category = categories.name).
  const [cats, setCats] = useState([])
  useEffect(() => { if (open) api.getCategories({ type: 'exp' }).then(setCats) }, [open])
  /* 발주만 고르게 한다 — 나가는 돈에 수주를 걸면 원가가 엉뚱한 건에 붙는다.
     방향 판정은 거래처 구분(A 외주·매입 / E 기관)이다(Contract.jsx isPurchase 와 같은 규칙).
     ⚠ 목록 API 는 `gubu`, 상세 API 는 `vendor_gubu` 로 같은 값을 내려준다 —
        한쪽만 보면 목록에서 온 계약이 통째로 걸러져 "등록된 발주가 없어요"가 된다. */
  const purchaseGubu = (c) => c.vendor_gubu ?? c.gubu
  const purchaseContracts = contracts.filter(c => ['A', 'E'].includes(purchaseGubu(c)))
  useEffect(() => {
    if (!open) return
    if (editing) {
      // 목록 행(camelCase) → 폼(snake_case) 복원
      setForm({
        vendor_id: editing.vendorId || "", category: editing.category || "",
        // 주문 연결은 폼에서 다루지 않지만, 수정 시 잃지 않도록 들고 다닌다
        contract_id: editing.contractId || null,
        amount: editing.amount ? String(editing.amount) : "",
        vat_mode: editing.vatMode || "exclusive",
        period: editing.period || "monthly", day_of_month: String(editing.dayOfMonth || 1),
        pay_term: editing.payTerm || editing.pay_term || "net30", pay_day: editing.payDay || editing.pay_day || 1,
        evidence_required: !!(editing.evidence_required ?? editing.evidenceRequired),
        amount_mode: editing.amountMode || editing.amount_mode || 'fixed',
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
      pay_term: form.pay_term || 'net30',
      evidence_required: !!form.evidence_required,
      amount_mode: form.amount_mode || 'fixed',
      pay_day: parseInt(form.pay_day, 10) || 1,
      end_date: form.end_date || null,
    })
    onClose()
  }
  const toast = useToast()
  /* 드로어를 기본 폭(480px)보다 넓게 — 결제조건 칩이 여섯 개인데다 '당월/익월 N일'을
     고르면 날짜 칸이 하나 더 붙는다. 480 에서는 칩이 세 줄로 접혀 조건 하나를 고르는 데
     눈이 세 번 내려간다. 정기청구 폼도 같은 폭이다(둘은 같은 값을 다루는 쌍이다). */
  return (
    <Drawer open={open} onClose={onClose} width="min(600px,100vw)" label="정기지급">
      <DrawerHead title={editing ? "정기지급 수정" : "정기지급 등록"} onClose={onClose}/>
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
        {/* 나가는 돈이라 **발주**다. 정기청구의 '수주 연결'과 마주보는 자리다.
            예전엔 이 칸이 아예 없어서, 발주에서 만든 정기지출을 여기서 열면 연결이 보이지도
            않았다(값은 들고만 다녔다). 실제로 어느 발주 건인지가 원가 귀속의 근거다. */}
        <div><label className="label">발주 연결 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
          <Combobox value={form.contract_id || ""} onChange={v => f("contract_id", v || null)} allowAdd={false}
            options={purchaseContracts.map(c => ({ value: c.id, label: c.name, sub: c.vendor_name }))}
            placeholder={purchaseContracts.length ? "발주 선택 (없으면 비워두기)" : "등록된 발주가 없어요"}/>
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
        {/* 정액형 / 변동형 — **금액 칸 바로 아래**여야 뜻이 통한다.
            전기·수도·통신·클라우드처럼 **날짜는 같고 금액만 다른** 건이 흔한데, 여태는
            규칙의 금액이 확정값이라 회차를 발행하면 그 금액이 그대로 나갔다.
            사용량을 계산하지는 않는다 — 필요한 건 "이번 달 얼마였고 냈나" 뿐이다. */}
        <div>
          <label className="label">금액 성격</label>
          <div className="row gap-6">
            {[['fixed', '정액형'], ['variable', '변동형']].map(([v, l]) => (
              <button key={v} type="button" className={`chip ${(form.amount_mode || 'fixed') === v ? 'active' : ''}`}
                onClick={() => f('amount_mode', v)}>{l}</button>
            ))}
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6, lineHeight: 1.7 }}>
            {(form.amount_mode || 'fixed') === 'variable'
              ? '위 금액은 예상액이에요. 회차를 처리할 때마다 실제 금액을 물어봅니다. 놓친 회차 일괄 처리에서는 빠져요 — 같은 금액으로 여러 달을 한꺼번에 만들면 전부 틀리니까요.'
              : '매번 같은 금액이에요. 회차가 도래하면 위 금액 그대로 처리됩니다.'}
          </div>
        </div>
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
              {/* 목록을 여기 손으로 적지 않는다 — 주기를 하나 더할 때 이런 자리가 빠지면
                  DB·계산은 아는데 **고를 수가 없다**(격월을 넣으며 실제로 겪는 자리다). */}
              {BILLING_PERIODS.map(o => (
                <button key={o.value} type="button" className={`chip ${form.period === o.value ? 'active' : ''}`}
                  onClick={() => f("period", o.value)}>{o.long}</button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            {/* 괄호 안이 **실제 답**이다 — 예전엔 괄호가 틀('매월 N일')이고 아래 줄이 답이라
                같은 말이 두 번 있었고 줄 높이도 어긋났다. 몇 월에 도는지는 시작일이 정한다. */}
            <label className="label">생성 일 ({cycleMonthsLabel(form.start_date, form.day_of_month, form.period, todayStr())})</label>
            <input className="input" type="number" min="1" max="31" value={form.day_of_month} onChange={e => f("day_of_month", e.target.value)}/>
          </div>
        </div>
        {/* 시작일·종료일은 **주기 바로 아래**다.
            예전엔 결제조건·증빙 두 구획 건너에 있었다. 그런데 위 일자 칸의 안내
            ("2·4·6·8·10·12월 25일")는 **시작일이 정하는 값**이다 — 몇 월에 도는지는
            시작일이 결정한다. 읽는 순간 근거가 되는 칸이 화면 밖에 있으면 못 믿을 말이 된다.
            "얼마나 자주 · 며칠에 · 언제부터 언제까지"를 한 덩어리로 둔다. */}
        <div className="row gap-12">
          <div style={{ flex: 1 }}>
            <label className="label">시작일 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <DateInput className="input" value={form.start_date} onChange={e => f("start_date", e.target.value)}/>
            <FirstCycleHint startDate={form.start_date} dayOfMonth={form.day_of_month} period={form.period} verb="지출" editing={!!editing}/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">종료일 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
            <DateInput className="input" value={form.end_date} onChange={e => f("end_date", e.target.value)}/>
          </div>
        </div>
        {/* 결제조건 — 회차일과 **돈이 빠지는 날**이 다르다.
            급여·임대료·카드처럼 자동이체로 그 날 바로 나가는 지출을 30일 뒤로 잡으면
            정작 잔고가 모자라는 날을 못 짚는다. 자금 현황이 이 값으로 날짜를 세운다. */}
        <div>
          <label className="label" style={{ marginBottom: 8 }}>결제조건</label>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            {PAY_TERM_OPTS.map(o => (
              <button key={o.value} type="button" className={`chip ${(form.pay_term || 'net30') === o.value ? 'active' : ''}`}
                onClick={() => f('pay_term', o.value)}>{o.label}</button>
            ))}
            {/* 'N일' 조건에서만 날짜 칸을 낸다 — 안 쓰는 조건에 칸이 떠 있으면 저장 안 되는 값이 된다 */}
            {payTermNeedsDay(form.pay_term) && (
              <div className="row gap-6" style={{ alignItems: 'center' }}>
                <input className="input num" type="number" min="1" max="31" style={{ width: 76 }}
                  value={form.pay_day ?? 1} onChange={e => f('pay_day', e.target.value)}/>
                <span className="text-sm text-muted">일</span>
              </div>
            )}
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
            {payTermHint(form.pay_term, form.pay_day, '빠져요')}
          </div>
        </div>
        {/* 증빙 요구 — **규칙**에 붙는다. 매달 같은 성격이라 회차마다 다시 판단할 이유가 없다.
            서버 사용료처럼 세금계산서가 오는 건은 매달 챙겨야 하고, 대표 가수금 상환처럼
            서류가 없는 건은 챙길 게 없다. 켠 규칙에서 나온 회차만 '증빙 미비'로 센다 —
            전부 켜 두면 미비 목록이 길어져 아무도 안 본다. */}
        <div>
          <label className="label">증빙</label>
          <div className="row gap-4">
            {[[false, '필요 없음'], [true, '서류를 챙겨야 함']].map(([v, l]) => (
              <button key={String(v)} type="button"
                className={`chip ${!!form.evidence_required === v ? 'active' : ''}`}
                onClick={() => f('evidence_required', v)}>{l}</button>
            ))}
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 4 }}>
            {form.evidence_required
              ? '회차마다 증빙을 받았는지 확인합니다. 파일을 붙이거나 «확인» 표시로 닫을 수 있어요.'
              : '증빙을 따로 챙기지 않는 건이에요. 미비 목록에 뜨지 않습니다.'}
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


/* 규칙 한 줄 이름 — 소급 드로어 제목처럼 "무슨 규칙인지" 한 줄로 말해야 하는 자리에 쓴다.
   ⚠ `r.vendor_name` 을 읽으면 안 된다. 어댑터가 내려주는 이름은 **`vendor`** 다
     (api.js getRecurringInvoices / getRecurringExpenses). 그래서 소급 드로어 제목이
     "연간 라이선스 · " 처럼 가운뎃점만 남고 거래처가 비어 있었다.
   한쪽이 비면 가운뎃점도 안 찍는다 — 구분자만 남으면 값이 사라진 것처럼 보인다. */
const ruleLabel = (r) => [r.item || r.category || '', r.vendor || ''].filter(Boolean).join(' · ')

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
  /* 시작일을 비운 채로 둘 수 있으므로(무기한 주문), '안 고르면 어떻게 되는지'를 그 자리에서 말해준다.
     예전 문구("시작일을 선택하면 첫 회차를 알려드려요")는 고르라는 뜻으로 읽혀,
     비워도 된다는 걸 알 수 없었다. */
  if (!startDate) {
    const first = firstCycleDate(todayStr(), dayOfMonth, period)
    return (
      <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
        비워두면 오늘(등록일)부터 시작해요{first ? <> · 첫 {verb} 회차 <b>{first}</b></> : null}
      </div>
    )
  }
  const first = firstCycleDate(startDate, dayOfMonth, period)
  const past = startDate < todayStr()
  return (
    <div className="text-xs" style={{ marginTop: 6, color: past ? 'var(--brand-ink)' : 'var(--muted-2)' }}>
      {first
        ? <>첫 {verb} 회차 <b>{first}</b>{past && ' · 등록일 이전 회차는 만들어지지 않아요'}</>
        : '종료일 안에 도래하는 회차가 없어요'}
    </div>
  )
}

/* 계약 연결 표시 — 이동 수단(onGo)이 있으면 버튼, 없으면 표시만.
   눌러도 아무 일이 없는 버튼은 고장으로 읽힌다.

   ⚠ '주문'이라 뭉뚱그리지 않는다. 들어오는 돈은 **수주**에서, 나가는 돈은 **발주**에서 온다 —
   화면이 이미 contract_sales / contract_purchase 로 갈라 보내고 있는데 라벨만 같은 말이라
   "어느 주문이지"를 눌러 봐야 알 수 있었다. 용어 결정도 영업 단계는 수주/발주다
   (회계 단계인 청구서·미수금·부가세만 매출/매입을 유지한다). */
const ContractBadge = ({ name, onGo, side = 'sales' }) => {
  const word = side === 'purchase' ? '발주' : '수주'
  const tip = `${name || word} — ${word}에서 관리`
  return onGo
    ? <button className="badge brand" style={{ marginLeft: 6, fontSize: 10, cursor: 'pointer', border: 0 }}
        title={tip} onClick={onGo}><Icon.Link size={10}/> {word}</button>
    : <span className="badge brand" style={{ marginLeft: 6, fontSize: 10 }} title={tip}>{word}</span>
}

// 규칙 목록 필터 — 계약 기반은 금액·종료 시점의 출처가 그 계약이라 관리 경로가 다르다.
const ruleFilters = (side) => [
  { value: 'all', label: '전체' },
  { value: 'plain', label: '일반' },
  { value: 'contract', label: side === 'purchase' ? '발주 기반' : '수주 기반' },
]
const filterRules = (rows, f) =>
  f === 'plain' ? rows.filter(r => !r.contractId)
  : f === 'contract' ? rows.filter(r => !!r.contractId)
  : rows

/* 규칙 검색 — 거래처·항목/비목·주문명으로 찾는다.
   규칙이 스무 개를 넘으면 눈으로 훑어서는 못 찾는다("이 고객 유지보수 얼마였더라"). */
const matchRule = (r, q) => {
  const s = String(q || '').trim().toLowerCase()
  if (!s) return true
  // api 가 내려주는 키만 본다 — vendor_name 은 매핑에 없어서(vendor 로 온다) 늘 빈 값이었다
  return [r.vendor, r.item, r.category, r.contractName]
    .some(v => String(v || '').toLowerCase().includes(s))
}

/* 활성 규칙을 한 달치로 환산한 합계(분기 ÷3, 년 ÷12).
   주기가 섞여 있으면 금액을 그냥 더한 수는 아무 뜻이 없다 —
   "매달 얼마가 꼬박꼬박 오가나"가 이 화면에서 알고 싶은 것이다. */
const monthlyEquivalent = (rows, amountOf) => Math.round(rows
  .filter(r => r.active)
  .reduce((s, r) => s + amountOf(r) / periodMonths(r.period), 0))

// 규칙 목록 머리 — 건수·월 환산·검색·필터 칩. 정기청구와 정기지출이 같이 쓴다(둘은 대칭이다).
const RuleListHeader = ({ title, rows, all, amountOf, q, setQ, ruleFilter, setRuleFilter, placeholder, side = 'sales' }) => (
  <div className="row" style={{ marginBottom: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
    <div>
      <div className="section-title" style={{ fontSize: 13 }}>
        {title} {rows.length}건
        {rows.length !== all.length && <span className="text-muted2 fw-400"> / 전체 {all.length}건</span>}
      </div>
      <div className="text-xs text-muted2" style={{ marginTop: 2 }}>
        활성 {rows.filter(r => r.active).length}건 · 월 환산 <span className="num">{fmtNum(monthlyEquivalent(rows, amountOf))}</span>원
      </div>
    </div>
    <div className="search rule-search" style={{ marginLeft: 'auto' }}>
      <Icon.Search size={14}/>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder}/>
    </div>
    <div className="row gap-6">
      {ruleFilters(side).map(f => (
        <button key={f.value} className={`chip ${ruleFilter === f.value ? 'active' : ''}`}
          onClick={() => setRuleFilter(f.value)}>{f.label}</button>
      ))}
    </div>
  </div>
)

// 정기지출 = 판관비(경비) 쪽 정기 반복. 회계처리 '경비' 그룹의 독립 화면으로도, 기준정보 탭으로도 쓴다.
export const RecurringExpensePanel = ({ page = false, goRoute }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [backfill, setBackfill] = useState(null)   // 소급 등록 마법사 대상 규칙
  const [auditOpen, setAuditOpen] = useState(false) // 정기 점검 — 전 규칙 한 번에 훑기
  // 회차 이력 — 보는 것과 고치는 것을 가른다(예전엔 이 표에서 갈 수 있는 곳이 수정 폼뿐이었다)
  const [history, setHistory] = useState(null)
  const [rows, setRows] = useState([])
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)   // 수정 대상(없으면 등록)
  const [vendors, setVendors] = useState([])
  const [accounts, setAccounts] = useState([])
  // 발주 연결 칸에 쓴다 — 폼에서 거르므로 여기서는 전부 받는다(정기청구 패널과 같은 방식)
  const [contracts, setContracts] = useState([])
  const [ruleFilter, setRuleFilter] = useState('all')   // all | plain | contract
  const [q, setQ] = useState('')

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
    api.getContracts().then(setContracts)
  }, [])

  const handleToggle = async (id) => {
    const res = await api.toggleRecurringExpense(id)
    toast.push(res.active ? "정기지급을 다시 시작했어요" : "정기지급을 멈췄어요")
    load(); cyc.reload()   // 중지/재개는 예정 회차 목록을 바꾼다
  }

  // 삭제는 '앞으로 자동 생성하지 않는다'는 뜻이다. 이미 만들어진 청구서·거래는 남는다
  // (실제로 오간 돈의 기록이라 함께 지우면 장부에 구멍이 난다) — 그 점을 미리 알린다.
  const handleDelete = async (r) => {
    const ok = await confirm({
      tone: "neg", icon: <Icon.Warn size={22}/>,
      title: "정기지급 삭제",
      body: `${r.vendor} · ${r.category}의 정기지급을 삭제합니다. 앞으로 자동 생성되지 않아요.`,
      detail: "이미 만들어진 청구서와 거래는 그대로 남습니다. 잠시 멈추기만 하려면 '중지'를 쓰세요.",
      confirmLabel: "삭제",
    })
    if (!ok) return
    const res = await api.deleteRecurringExpense(r.id)
    if (!res.ok) { toast.push(res.error || "삭제에 실패했어요", { tone: "warn" }); return }
    const kept = (res.keptInvoices || 0) + (res.keptTxns || 0)
    toast.push(kept ? `정기지급을 삭제했어요 (기존 기록 ${kept}건은 유지)` : "정기지급을 삭제했어요")
    load(); cyc.reload()
  }


  const openNew = () => { setEditing(null); setFormOpen(true) }
  const openEdit = (r) => { setEditing(r); setFormOpen(true) }
  const ruleRows = filterRules(rows, ruleFilter).filter(r => matchRule(r, q))
  const cycSummary = cycleSummaryByRule(cyc.cycles)
  const addBtn = (
    <div className="row gap-8">
      {/* 규칙을 하나씩 열어 확인하던 일을 한 번에 — 이상만 모아 보여준다 */}
      <button className="btn" onClick={() => setAuditOpen(true)}><Icon.Check size={14}/> 점검</button>
      <button className="btn primary" onClick={openNew}><Icon.Plus size={14}/> 등록</button>
    </div>
  )

  return (
    <div className={page ? 'fade-up' : undefined} style={page ? undefined : { padding: 20 }}>
      {/* 독립 화면일 땐 공용 PageHeader를 쓴다 — 다른 화면과 상단 여백·sticky 동작을 맞추기 위해 */}
      {page ? (
        /* 제목은 메뉴 이름과 같아야 한다 — 메뉴가 정기지급인데 제목만 '정기 지출'이면
           다른 화면에 온 것처럼 읽힌다(수시입금/수시지급에서 맞춘 것과 같은 규칙). */
        <PageHeader title="정기 출금"
          sub={cyc.overdueCount > 0 ? `놓친 회차 ${cyc.overdueCount}건이 있어요` : undefined}
          actions={addBtn}/>
      ) : (
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="section-title">정기지급</div>
          <div className="ml-auto">{addBtn}</div>
        </div>
      )}
      {/* 이행 현황 — 놓친 회차/임박/예정. 규칙만 보여주던 화면의 빈 곳을 채운다 */}
      <RecurringCycles cycles={cyc.cycles} kind="purchase" busy={cyc.busy}
        onIssue={cyc.issue} onPaid={cyc.openPaid} onBulk={cyc.bulk}
        onSkip={cyc.skip} onUnskip={cyc.unskip}
        onOpenContract={() => goRoute?.('contract_purchase')}/>

      <RuleListHeader title="정기지급 규칙" side="purchase" rows={ruleRows} all={rows} amountOf={r => Number(r.amount) || 0}
        q={q} setQ={setQ} ruleFilter={ruleFilter} setRuleFilter={setRuleFilter}
        placeholder="거래처·비목·발주"/>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            {/* '상태' 열이 있었지만 값의 대부분이 초록 '활성'이었다 — 정상인 것에 표식을 달면
                표식이 뜻을 잃는다. 비활성만 알리면 되고, 그건 행 자체를 흐리게 해서 이미 말한다.
                대신 **계좌**를 세운다. 규칙에 통장을 지정해 두는데 목록에 안 보여서
                "어느 통장으로 들어올 돈인지" 확인할 길이 없었다(수시입금에서 같은 지적을 받았다). */}
            <tr>
              <th>거래처</th><th>비목</th><th className="num-right">금액</th>
              <th>주기</th><th>다음 예정</th><th>계좌</th><th style={{ width: 96 }}></th>
            </tr>
          </thead>
          <tbody>
            {/* 빈 상태가 없으면 검색에 안 걸렸을 때 표가 통째로 사라져 고장으로 읽힌다 */}
            {ruleRows.length === 0 && (
              <tr><td colSpan={7} className="text-sm text-muted" style={{ textAlign: "center", padding: 24 }}>
                {rows.length === 0
                  ? "등록된 정기지급이 없어요. 임차료·통신비 등 매달 나가는 건을 등록해보세요."
                  : "이 조건에 맞는 정기지급이 없어요."}
              </td></tr>
            )}
            {ruleRows.map(r => {
              const s = cycSummary.get(r.id)
              return (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.45 }}>
                {/* 이름을 누르면 **이력**이 열린다(매출 쪽과 같은 규칙) */}
                <td className="fw-700">
                  <button type="button" className="link-cell"
                    onClick={() => setHistory({ id: r.id, label: r.vendor, sub: ruleLabel(r) })}>{r.vendor}</button>
                  {/* 주문 기반은 금액·종료 시점의 출처가 주문이다 → 수정은 주문에서.
                      goRoute가 없는 자리(기준정보 탭)에서는 눌러도 아무 일이 없으니 표시만 한다 */}
                  {r.contractId && <ContractBadge name={r.contractName} side="purchase" onGo={goRoute && (() => goRoute('contract_purchase'))}/>}
                </td>
                <td className="text-sm text-muted">{r.category}</td>
                <td className="num-cell num-right">
                  {fmtNum(r.amount)}
                  {/* 변동형은 이 숫자가 **예상액**이다. 표시가 없으면 확정 금액으로 읽힌다. */}
                  {r.amountMode === 'variable' && <div className="text-xs text-muted2">예상</div>}
                </td>
                <td className="text-sm">{periodLong(r.period)} {r.dayOfMonth}일</td>
                {/* 서버가 계산한 회차를 쓴다 — 화면에서 다시 계산하면 놓친 회차가 감춰진다 */}
                {/* 다음 예정은 **서버 계산값**(nextDue)이다. 예전엔 이행 현황(pending)에서
                    주워 썼는데 그 목록은 35일 미리보기라, 매분기·매년 규칙은 늘 '—'로 떴다 —
                    활성인데 예정이 없으니 규칙이 안 도는 것처럼 읽힌다. */}
                <td className="text-sm">
                  {r.active ? (r.nextDue || s?.next || "—") : "—"}
                  {s?.overdue > 0 && (
                    <span className="badge neg" style={{ marginLeft: 6, fontSize: 10 }}>미처리 {s.overdue}</span>
                  )}
                </td>
                <td className="text-sm text-muted">{r.accountName || "—"}</td>
                <td>
                  {/* 평소 쓰는 '수정'만 밖에. 삭제를 '중지' 옆에 붙여 두면 잠시 멈추려던 손이
                      한 칸 빗나가 규칙을 지운다 — 되돌릴 수 없는 것은 ⋯ 안, 선 아래에 둔다. */}
                  <RowActions
                    primary={{ label: '수정', onClick: () => openEdit(r) }}
                    items={[
                      { label: '회차 이력', onClick: () => setHistory({ id: r.id, label: r.vendor, sub: ruleLabel(r) }) },
                      { label: r.active ? '중지' : '재개', onClick: () => handleToggle(r.id),
                        hint: r.active ? '자동 생성 멈춤' : undefined },
                      // 등록일 이전 회차는 평소 경로로 안 만들어진다 → 기간을 열어 넣는 입구
                      { label: '지난 회차 넣기', onClick: () => setBackfill({ id: r.id, label: ruleLabel(r) }) },
                      { label: '삭제', tone: 'neg', onClick: () => handleDelete(r) },
                    ]}/>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <RecurringFormDrawer open={formOpen} editing={editing} onClose={() => setFormOpen(false)} vendors={vendors} accounts={accounts}
        contracts={contracts} addGubu="A" reloadVendors={reloadVendors}
        onSave={async (data) => {
          // 결과를 보지 않고 성공 문구를 띄우면, 저장이 실패해도 등록된 줄 알게 된다
          const res = editing ? await api.updateRecurringExpense(editing.id, data) : await api.addRecurringExpense(data)
          toast.push(res?.ok === false ? (res.error || "저장에 실패했어요") : (editing ? "정기지급을 수정했어요" : "정기지급을 등록했어요"),
                     res?.ok === false ? { tone: "warn" } : undefined)
          load(); cyc.reload()
        }}/>
      {/* 기지급 처리 — 계좌·날짜를 받는다. 대금청구서 화면과 같은 공용 드로어 */}
      <PaidIssueDrawer target={cyc.paidTarget} isIssued={false}
        onIssuePaid={cyc.issuePaid} onClose={cyc.closePaid} onDone={cyc.donePaid}/>
      {/* 변동형 회차의 금액 입력 — 규칙 금액은 예상액이라 발행 전에 실제 금액을 받는다 */}
      <CycleAmountDrawer {...cyc.amountProps}/>
      {/* 도입 이전 회차 넣기 — 등록일 하한 때문에 평소 경로로는 안 만들어진다 */}
      <RecurAuditDrawer open={auditOpen} kind="purchase" onClose={() => setAuditOpen(false)}
        onFix={id => { const r = rows.find(x => x.id === id); setAuditOpen(false); if (r) setBackfill({ id: r.id, label: ruleLabel(r) }) }}
        onHistory={id => { const r = rows.find(x => x.id === id); setAuditOpen(false); if (r) setHistory({ id: r.id, label: r.vendor, sub: ruleLabel(r) }) }}/>
      <BackfillWizard open={!!backfill} rule={backfill} kind="purchase"
        onClose={() => setBackfill(null)} onDone={() => { load(); cyc.reload() }}/>
      {/* 회차 이력 — 수정은 이 안에서 한 번 더 짚고 들어간다(보려다 고치는 일을 막는다) */}
      <RecurHistoryDrawer open={!!history} rule={history} kind="purchase"
        onClose={() => setHistory(null)}
        onEdit={(h) => { const r = rows.find(x => x.id === h.id); setHistory(null); if (r) openEdit(r) }}/>
    </div>
  )
}

// ── 정기 청구(고정수입) 패널 ──────────────────────────────────────
const RecurringInvoiceFormDrawer = ({ open, editing, onClose, onSave, vendors, contracts, accounts, reloadVendors }) => {
  const toast = useToast()
  const empty = { vendorId: "", contractId: "", item: "", supply: "", vatMode: "exclusive", period: "monthly", dayOfMonth: "1", startDate: todayStr(), endDate: "", accountId: "", payTerm: "net30", payDay: 1, evidenceRequired: false, amountMode: "fixed" }
  const [form, setForm] = useState(empty)
  useEffect(() => {
    if (!open) return
    setForm(editing ? {
      vendorId: editing.vendorId || "", contractId: editing.contractId || "", item: editing.item || "",
      supply: editing.supplyAmount ? String(editing.supplyAmount) : "",
      vatMode: editing.vatMode || "exclusive", period: editing.period || "monthly",
      amountMode: editing.amountMode || "fixed",
      dayOfMonth: String(editing.dayOfMonth || 1), startDate: editing.startDate || todayStr(),
      endDate: editing.endDate || "", accountId: editing.accountId || "",
      payTerm: editing.payTerm || "net30", payDay: editing.payDay || 1,
      evidenceRequired: !!(editing.evidenceRequired ?? editing.evidence_required),
    } : empty)
  }, [open, editing])
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  // 주문 vat_mode(taxable/exempt/zero) → 정기청구 vat_mode(exclusive/none/zero)
  const modeFromContract = (vm) => (vm === 'exempt' ? 'none' : vm === 'zero' ? 'zero' : 'exclusive')

  const pickContract = (cid) => {
    setForm(p => {
      const c = contracts.find(x => x.id === cid)
      return {
        ...p,
        contractId: cid,
        vendorId: p.vendorId || (c ? c.vendor_id : ""),
        item: p.item || (c ? c.name : ""),
        // 주문을 걸면 그 주문의 과세유형을 따라간다. 이걸 안 맞추면 발행 시 세액은 규칙(기본 과세 10%)으로
        // 계산되는데 청구서 과세유형은 주문(면세/영세)으로 저장돼, 면세 주문에 10% 세액이 붙는다.
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
      amount_mode: form.amountMode || 'fixed',
      period: form.period,
      dayOfMonth: parseInt(form.dayOfMonth) || 1,
      startDate: form.startDate,
      endDate: form.endDate || null,
      accountId: form.accountId || null,
      payTerm: form.payTerm || 'net30',
      evidence_required: !!form.evidenceRequired,
      payDay: parseInt(form.payDay, 10) || 1,
    })
    onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} width="min(600px,100vw)" label="정기입금">
      <DrawerHead title={editing ? "정기입금 수정" : "정기입금 등록"} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        {/* 들어오는 돈이라 **수주**다. '주문'이라 두면 발주와 구별이 안 된다. */}
        <div><label className="label">수주 연결 <span className="text-muted">(선택)</span></label>
          <Combobox value={form.contractId} onChange={pickContract} allowAdd={false}
            options={contracts.map(c => ({ value: c.id, label: c.name, sub: c.vendor_name }))}
            placeholder="수주 선택 (없으면 비워두기)"/>
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
        {/* 정액형 / 변동형 — 정기지급 폼과 같은 규칙(둘은 대칭이다).
            사용량에 따라 금액이 달라지는 유지보수가 여기 해당한다. */}
        <div>
          <label className="label">금액 성격</label>
          <div className="row gap-6">
            {[['fixed', '정액형'], ['variable', '변동형']].map(([v, l]) => (
              <button key={v} type="button" className={`chip ${(form.amountMode || 'fixed') === v ? 'active' : ''}`}
                onClick={() => f('amountMode', v)}>{l}</button>
            ))}
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6, lineHeight: 1.7 }}>
            {(form.amountMode || 'fixed') === 'variable'
              ? '위 공급가액은 예상액이에요. 회차를 발행할 때마다 실제 금액을 물어봅니다. 놓친 회차 일괄 발행에서는 빠져요 — 같은 금액으로 여러 달치 세금계산서를 한꺼번에 끊으면 전부 틀리니까요.'
              : '매번 같은 금액이에요. 회차가 도래하면 위 금액 그대로 발행됩니다.'}
          </div>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}>
            <label className="label">반복 주기</label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {/* 목록을 여기 손으로 적지 않는다 — 주기를 하나 더할 때 이런 자리가 빠지면
                  DB·계산은 아는데 **고를 수가 없다**(격월을 넣으며 실제로 겪는 자리다). */}
              {BILLING_PERIODS.map(o => (
                <button key={o.value} type="button" className={`chip ${form.period === o.value ? 'active' : ''}`}
                  onClick={() => f("period", o.value)}>{o.long}</button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            {/* 위 정기지급 폼과 같은 규칙 — 괄호 안이 실제 답이다 */}
            <label className="label">청구일 ({cycleMonthsLabel(form.startDate, form.dayOfMonth, form.period, todayStr())})</label>
            <input className="input" type="number" min="1" max="31" value={form.dayOfMonth} onChange={e => f("dayOfMonth", e.target.value)}/>
          </div>
        </div>
        {/* 시작일·종료일은 **주기 바로 아래**다.
            예전엔 결제조건·증빙 두 구획 건너에 있었다. 그런데 위 일자 칸의 안내
            ("2·4·6·8·10·12월 25일")는 **시작일이 정하는 값**이다 — 몇 월에 도는지는
            시작일이 결정한다. 읽는 순간 근거가 되는 칸이 화면 밖에 있으면 못 믿을 말이 된다.
            "얼마나 자주 · 며칠에 · 언제부터 언제까지"를 한 덩어리로 둔다. */}
        <div className="row gap-12">
          {/* 시작일은 선택 — 무기한 주문은 "언제부터"가 모호한 경우가 흔하다(구두로 이어오던 유지보수 등).
              비우면 등록한 날부터 센다(서버 lib/recurrence.js 앵커 폴백). */}
          <div style={{ flex: 1 }}><label className="label">시작일 <span className="text-muted">(선택)</span></label>
            <DateInput className="input" value={form.startDate} onChange={e => f("startDate", e.target.value)}/>
            <FirstCycleHint startDate={form.startDate} dayOfMonth={form.dayOfMonth} period={form.period} verb="청구" editing={!!editing}/>
          </div>
          <div style={{ flex: 1 }}><label className="label">종료일 <span className="text-muted">(선택)</span></label>
            <DateInput className="input" value={form.endDate} onChange={e => f("endDate", e.target.value)}/>
          </div>
        </div>
        {/* 결제조건 — 청구일과 **돈이 들어오는 날**은 다르다. 자금 예측이 이 값으로 입금일을 세운다.
            정기지출 폼과 같은 값·같은 문구를 쓴다(한쪽만 다르면 같은 날짜가 화면마다 달라진다). */}
        <div>
          <label className="label" style={{ marginBottom: 8 }}>결제조건</label>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            {PAY_TERM_OPTS.map(o => (
              <button key={o.value} type="button" className={`chip ${(form.payTerm || 'net30') === o.value ? 'active' : ''}`}
                onClick={() => f('payTerm', o.value)}>{o.label}</button>
            ))}
            {/* 'N일' 조건에서만 날짜 칸을 낸다 — 안 쓰는 조건에 칸이 떠 있으면 저장 안 되는 값이 된다 */}
            {payTermNeedsDay(form.payTerm) && (
              <div className="row gap-6" style={{ alignItems: 'center' }}>
                <input className="input num" type="number" min="1" max="31" style={{ width: 76 }}
                  value={form.payDay ?? 1} onChange={e => f('payDay', e.target.value)}/>
                <span className="text-sm text-muted">일</span>
              </div>
            )}
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
            {payTermHint(form.payTerm, form.payDay, '들어와요')}
          </div>
        </div>
        {/* 증빙 요구 — 정기지출 폼과 같은 값·같은 문구(둘은 대칭이다).
            매출 쪽은 '우리가 발행한 계산서 사본'이나 검수확인서처럼 챙겨야 할 서류가 있는 건에 켠다. */}
        <div>
          <label className="label">증빙</label>
          <div className="row gap-4">
            {[[false, '필요 없음'], [true, '서류를 챙겨야 함']].map(([v, l]) => (
              <button key={String(v)} type="button"
                className={`chip ${!!form.evidenceRequired === v ? 'active' : ''}`}
                onClick={() => f('evidenceRequired', v)}>{l}</button>
            ))}
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 4 }}>
            {form.evidenceRequired
              ? '회차마다 증빙을 받았는지 확인합니다. 파일을 붙이거나 «확인» 표시로 닫을 수 있어요.'
              : '증빙을 따로 챙기지 않는 건이에요. 미비 목록에 뜨지 않습니다.'}
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

// 정기청구 = 매출 쪽 정기 반복. 회계처리 '판매·수주(매출)' 그룹의 독립 화면으로도, 기준정보 탭으로도 쓴다.
export const RecurringInvoicePanel = ({ page = false, goRoute }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [backfill, setBackfill] = useState(null)   // 소급 등록 마법사 대상 규칙
  const [auditOpen, setAuditOpen] = useState(false) // 정기 점검 — 전 규칙 한 번에 훑기
  // 회차 이력 — 보는 것과 고치는 것을 가른다(예전엔 이 표에서 갈 수 있는 곳이 수정 폼뿐이었다)
  const [history, setHistory] = useState(null)
  const [rows, setRows] = useState([])
  const [vendors, setVendors] = useState([])
  const [contracts, setContracts] = useState([])
  const [accounts, setAccounts] = useState([])
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [ruleFilter, setRuleFilter] = useState('all')
  const [q, setQ] = useState('')

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
    toast.push(res.active ? "정기입금을 다시 시작했어요" : "정기입금을 멈췄어요")
    load(); cyc.reload()
  }

  // 정기지출 쪽과 같은 원칙 — 자동 발행만 멈추고, 이미 발행된 청구서는 남긴다.
  const handleDelete = async (r) => {
    const ok = await confirm({
      tone: "neg", icon: <Icon.Warn size={22}/>,
      title: "정기입금 삭제",
      body: `${r.vendor} · ${r.item || r.contractName || ""}의 정기입금을 삭제합니다. 앞으로 자동 발행되지 않아요.`.replace(/ · \./, "."),
      detail: "이미 발행된 청구서와 거래는 그대로 남습니다. 잠시 멈추기만 하려면 '중지'를 쓰세요.",
      confirmLabel: "삭제",
    })
    if (!ok) return
    const res = await api.deleteRecurringInvoice(r.id)
    if (!res.ok) { toast.push(res.error || "삭제에 실패했어요", { tone: "warn" }); return }
    const kept = (res.keptInvoices || 0) + (res.keptTxns || 0)
    toast.push(kept ? `정기입금을 삭제했어요 (기존 기록 ${kept}건은 유지)` : "정기입금을 삭제했어요")
    load(); cyc.reload()
  }
  // '밀린 회차 일괄 생성' 버튼은 이행 현황의 '놓친 회차 일괄 발행'으로 흡수했다
  // (같은 동작이 두 자리에 있으면 어느 쪽이 무엇을 만드는지 알 수 없다).

  // 영세(zero)도 세액 0 — 'none만 0'으로 보면 영세 청구액이 10% 부풀어 보인다
  const totalOf = (r) => r.supplyAmount + (r.vatMode === 'exclusive' ? Math.round(r.supplyAmount * 0.1) : 0)

  const openNew = () => { setEditing(null); setFormOpen(true) }
  const openEdit = (r) => { setEditing(r); setFormOpen(true) }
  const ruleRows = filterRules(rows, ruleFilter).filter(r => matchRule(r, q))
  const cycSummary = cycleSummaryByRule(cyc.cycles)
  const recActions = (
    <div className="row gap-8">
      <button className="btn" onClick={() => setAuditOpen(true)}><Icon.Check size={14}/> 점검</button>
      <button className="btn primary" onClick={openNew}><Icon.Plus size={14}/> 등록</button>
    </div>
  )

  return (
    <div className={page ? 'fade-up' : undefined} style={page ? undefined : { padding: 20 }}>
      {/* 상단은 '이번에 청구할 것'(이행), 아래는 '무엇을 언제 얼마씩 청구할지'(규칙).
          같은 회차를 수시입금의 '발행예정'에서도 처리할 수 있다 — 같은 API·같은 컴포넌트를 쓴다. */}
      {page ? (
        /* 제목은 메뉴 이름과 같아야 한다 — 위 정기지급과 같은 규칙 */
        <PageHeader title="정기 입금"
          sub={cyc.overdueCount > 0 ? `놓친 회차 ${cyc.overdueCount}건이 있어요` : undefined}
          actions={recActions}/>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 6 }}>
            <div className="section-title">정기입금</div>
            <div className="ml-auto">{recActions}</div>
          </div>
          <div className="text-sm text-muted" style={{ marginBottom: 16 }}>
            청구 조건을 설정하는 곳이에요. 도래한 회차는 아래에서 바로 발행할 수 있고, <b>입금관리 → 수시입금</b>의 '발행예정'에서 수주 청구일정과 함께 처리해도 됩니다.
          </div>
        </>
      )}

      <RecurringCycles cycles={cyc.cycles} kind="sales" busy={cyc.busy}
        onIssue={cyc.issue} onPaid={cyc.openPaid} onBulk={cyc.bulk}
        onSkip={cyc.skip} onUnskip={cyc.unskip}
        onOpenContract={() => goRoute?.('contract_sales')}/>

      <RuleListHeader title="정기입금 규칙" side="sales" rows={ruleRows} all={rows} amountOf={totalOf}
        q={q} setQ={setQ} ruleFilter={ruleFilter} setRuleFilter={setRuleFilter}
        placeholder="고객사·항목·수주"/>
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            {/* 계좌를 세우고 '상태' 열을 뺀 이유는 정기지급 표의 주석 참조 */}
            <tr>
              <th>고객사</th><th>항목 / 수주</th><th className="num-right">청구액(VAT 포함)</th>
              <th>주기</th><th>다음 예정</th><th>계좌</th><th style={{ width: 96 }}></th>
            </tr>
          </thead>
          <tbody>
            {ruleRows.length === 0 && (
              <tr><td colSpan={7} className="text-sm text-muted" style={{ textAlign: "center", padding: 24 }}>
                {rows.length === 0
                  ? "등록된 정기입금이 없어요. 유지보수·호스팅 등 매달 청구하는 건을 등록해보세요."
                  : "이 조건에 맞는 정기입금이 없어요."}
              </td></tr>
            )}
            {ruleRows.map(r => {
              const s = cycSummary.get(r.id)
              return (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.45 }}>
                {/* 이름을 누르면 **이력**이 열린다. 예전엔 이 표에서 갈 수 있는 곳이
                    수정 폼뿐이라 "여태 얼마 나갔나"를 볼 데가 없었다. */}
                <td className="fw-700">
                  <button type="button" className="link-cell"
                    onClick={() => setHistory({ id: r.id, label: r.vendor, sub: ruleLabel(r) })}>{r.vendor}</button>
                  {r.contractId && <ContractBadge name={r.contractName} side="sales" onGo={goRoute && (() => goRoute('contract_sales'))}/>}
                </td>
                <td className="text-sm">
                  {r.item || "—"}
                  {r.contractName && <div className="text-xs text-muted">수주: {r.contractName}</div>}
                </td>
                <td className="num-cell num-right">
                  {fmtNum(totalOf(r))}
                  {/* 변동형은 이 숫자가 **예상액**이다. 표시가 없으면 확정 금액으로 읽힌다. */}
                  {r.amountMode === 'variable' && <div className="text-xs text-muted2">예상</div>}
                </td>
                <td className="text-sm">{periodLong(r.period)} {r.dayOfMonth}일</td>
                {/* 다음 예정은 **서버 계산값**(nextDue)이다. 예전엔 이행 현황(pending)에서
                    주워 썼는데 그 목록은 35일 미리보기라, 매분기·매년 규칙은 늘 '—'로 떴다 —
                    활성인데 예정이 없으니 규칙이 안 도는 것처럼 읽힌다. */}
                <td className="text-sm">
                  {r.active ? (r.nextDue || s?.next || "—") : "—"}
                  {s?.overdue > 0 && (
                    <span className="badge neg" style={{ marginLeft: 6, fontSize: 10 }}>미처리 {s.overdue}</span>
                  )}
                </td>
                <td className="text-sm text-muted">{r.accountName || "—"}</td>
                <td>
                  {/* 평소 쓰는 '수정'만 밖에. 삭제를 '중지' 옆에 붙여 두면 잠시 멈추려던 손이
                      한 칸 빗나가 규칙을 지운다 — 되돌릴 수 없는 것은 ⋯ 안, 선 아래에 둔다. */}
                  <RowActions
                    primary={{ label: '수정', onClick: () => openEdit(r) }}
                    items={[
                      { label: '회차 이력', onClick: () => setHistory({ id: r.id, label: r.vendor, sub: ruleLabel(r) }) },
                      { label: r.active ? '중지' : '재개', onClick: () => handleToggle(r.id),
                        hint: r.active ? '자동 생성 멈춤' : undefined },
                      // 등록일 이전 회차는 평소 경로로 안 만들어진다 → 기간을 열어 넣는 입구
                      { label: '지난 회차 넣기', onClick: () => setBackfill({ id: r.id, label: ruleLabel(r) }) },
                      { label: '삭제', tone: 'neg', onClick: () => handleDelete(r) },
                    ]}/>
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
          toast.push(res?.ok === false ? (res.error || "저장에 실패했어요") : (editing ? "정기입금을 수정했어요" : "정기입금을 등록했어요"),
                     res?.ok === false ? { tone: "warn" } : undefined)
          load(); cyc.reload()
        }}/>
      {/* 기입금 처리 — 정기지출과 같은 공용 드로어(계좌·날짜 필수) */}
      <PaidIssueDrawer target={cyc.paidTarget} isIssued
        onIssuePaid={cyc.issuePaid} onClose={cyc.closePaid} onDone={cyc.donePaid}/>
      {/* 변동형 회차의 금액 입력 — 규칙 금액은 예상액이라 발행 전에 실제 금액을 받는다 */}
      <CycleAmountDrawer {...cyc.amountProps}/>
      {/* 도입 이전 회차 넣기 — 등록일 하한 때문에 평소 경로로는 안 만들어진다 */}
      <RecurAuditDrawer open={auditOpen} kind="sales" onClose={() => setAuditOpen(false)}
        onFix={id => { const r = rows.find(x => x.id === id); setAuditOpen(false); if (r) setBackfill({ id: r.id, label: ruleLabel(r) }) }}
        onHistory={id => { const r = rows.find(x => x.id === id); setAuditOpen(false); if (r) setHistory({ id: r.id, label: r.vendor, sub: ruleLabel(r) }) }}/>
      <BackfillWizard open={!!backfill} rule={backfill} kind="sales"
        onClose={() => setBackfill(null)} onDone={() => { load(); cyc.reload() }}/>
      {/* 회차 이력 — 수정은 이 안에서 한 번 더 짚고 들어간다(보려다 고치는 일을 막는다) */}
      <RecurHistoryDrawer open={!!history} rule={history} kind="sales"
        onClose={() => setHistory(null)}
        onEdit={(h) => { const r = rows.find(x => x.id === h.id); setHistory(null); if (r) openEdit(r) }}/>
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

/* 변경 이력 — 누가 무엇을 했는지.
 *
 * 금액·거래처명은 일부러 없다. 서버가 남기지 않기 때문이다(구체적 수치는 회사 비밀).
 * 여기서 '무엇이었는지'까지 알고 싶으면 대상 ID로 그 화면에서 찾아본다 —
 * 로그 자체가 장부의 사본이 되면 안 된다. 원칙은 server/platform/auditMap.js 참고.
 */
const AUDIT_LIMIT = 50

// 되돌리기 어려운 행위는 눈에 띄어야 한다. 목록을 훑을 때 제일 먼저 걸려야 하는 것들.
const AUDIT_DANGER = new Set(['delete', 'delete_month', 'reopen', 'pay_cancel', 'match_cancel', 'repay_cancel'])

/** 기본 조회 기간 — 최근 한 달. 기본을 '전체'로 두면 최근에 무슨 일이 있었는지가 오히려 안 보인다. */
const auditDefaultRange = () => {
  const to = new Date()
  const from = new Date(to); from.setMonth(from.getMonth() - 1)
  return { from: fmtDateLocal(from), to: fmtDateLocal(to) }
}

const AuditPanel = ({ embedded = false }) => {
  const toast = useToast()
  const [meta, setMeta] = useState({ actions: {}, resources: {}, usernames: [] })
  const [filter, setFilter] = useState(() => ({
    ...auditDefaultRange(), action: '', resource: '', username: '',
  }))
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => { api.getAuditMeta().then(setMeta) }, [])

  const load = async (offset = 0) => {
    setLoading(true)
    const r = await api.getAuditLogs({ ...filter, limit: AUDIT_LIMIT, offset })
    setLoading(false)
    // 권한 없음·기간 초과 등 서버가 말해주는 이유를 그대로 보여준다.
    // 한 가지 이유로 뭉뚱그리면 "마스터만 볼 수 있어요"가 기간 오류에도 뜬다.
    if (r.error) { setError(r.error); setRows([]); setTotal(0); return }
    setError('')
    setRows(prev => (offset ? [...prev, ...r.rows] : r.rows))
    setTotal(r.total)
  }
  useEffect(() => { load(0) }, [filter])   // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k, v) => setFilter(prev => ({ ...prev, [k]: v }))
  const opts = (map, all) => [{ value: '', label: all }, ...Object.entries(map).map(([value, label]) => ({ value, label }))]

  const download = async () => {
    setDownloading(true)
    const r = await api.exportAuditXlsx(filter)
    setDownloading(false)
    if (!r.ok) toast.push(r.error || '내보내기에 실패했어요', { tone: 'warn' })
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 16 }}>
        {!embedded && <div className="section-title">변경 이력</div>}
        <div className="section-sub">
          마감·삭제·지급·발행처럼 되돌리기 어려운 작업의 기록입니다. 누가 언제 무엇을 했는지 남고,
          금액·거래처 같은 내용은 남기지 않아요. 자세한 내용은 대상 번호로 해당 화면에서 확인하세요.
          <br/>기본은 최근 한 달이고, 한 번에 최대 1년까지 조회할 수 있어요.
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row gap-12" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ width: 150 }}>
            <label className="label" style={{ marginBottom: 8 }}>시작일</label>
            <DateInput className="input" value={filter.from} onChange={e => set('from', e.target.value)}/>
          </div>
          <div style={{ width: 150 }}>
            <label className="label" style={{ marginBottom: 8 }}>종료일</label>
            <DateInput className="input" value={filter.to} onChange={e => set('to', e.target.value)}/>
          </div>
          <div style={{ width: 170 }}>
            <label className="label" style={{ marginBottom: 8 }}>대상</label>
            <Combobox value={filter.resource} onChange={v => set('resource', v)}
                      options={opts(meta.resources, '전체 대상')} placeholder="전체 대상"/>
          </div>
          <div style={{ width: 190 }}>
            <label className="label" style={{ marginBottom: 8 }}>행위</label>
            <Combobox value={filter.action} onChange={v => set('action', v)}
                      options={opts(meta.actions, '전체 행위')} placeholder="전체 행위"/>
          </div>
          <div style={{ width: 160 }}>
            <label className="label" style={{ marginBottom: 8 }}>사용자</label>
            <Combobox value={filter.username} onChange={v => set('username', v)}
                      options={[{ value: '', label: '전체 사용자' },
                                ...meta.usernames.map(u => ({ value: u, label: u }))]}
                      placeholder="전체 사용자"/>
          </div>
          <button className="btn" onClick={() => setFilter({ ...auditDefaultRange(), action: '', resource: '', username: '' })}>
            초기화
          </button>
          <button className="btn" disabled={downloading || !!error} onClick={download}>
            <Icon.Excel/> {downloading ? '내보내는 중…' : '엑셀 받기'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card card-pad" style={{ marginBottom: 16, textAlign: 'center', color: 'var(--neg-ink)' }}>
          {error}
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 150 }}>시각</th>
              <th style={{ width: 120 }}>사용자</th>
              <th style={{ width: 130 }}>대상</th>
              <th style={{ width: 150 }}>행위</th>
              <th>대상 번호</th>
              <th style={{ width: 130 }}>접속 IP</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--muted-2)' }}>
                {loading ? '불러오는 중…' : '기록이 없어요.'}
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id}>
                <td className="text-sm text-muted2 num">{minuteOf(r.created_at)}</td>
                {/* 'ops:xxx' 는 우리 회사 사람이 아니라 서비스 운영자가 한 일이다.
                    그 구분이 보이지 않으면 "내가 안 한 비번 변경"이 직원 소행으로 읽힌다. */}
                <td className="fw-600">
                  {String(r.username || '').startsWith('ops:')
                    ? <><span className="pill-ops">운영자</span> {r.username.slice(4)}</>
                    : (r.username || '—')}
                </td>
                <td className="text-sm text-muted">{meta.resources[r.resource] || r.resource || '—'}</td>
                <td>
                  <span className={AUDIT_DANGER.has(r.action) ? 'fw-600 text-neg' : 'text-sm text-muted'}>
                    {meta.actions[r.action] || r.action || '—'}
                  </span>
                </td>
                <td className="text-sm text-muted2 num" style={{ wordBreak: 'break-all' }}>{r.target_id || '—'}</td>
                <td className="text-sm text-muted2 num">{r.ip || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row gap-12" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
        <div className="text-sm text-muted2">
          {total > 0 ? `전체 ${fmtNum(total)}건 중 ${fmtNum(rows.length)}건 표시` : ''}
        </div>
        {rows.length < total && (
          <button className="btn" disabled={loading} onClick={() => load(rows.length)}>
            {loading ? '불러오는 중…' : '더 보기'}
          </button>
        )}
      </div>
    </div>
  )
}

/* ── 보고서 사용 설정 ────────────────────────────────────────────────────
 *
 * **두 축을 섞지 않는다.**
 *   우리(공급자)  이 회사가 그 양식을 쓸 수 있나 — 주문. 여기서는 못 바꾼다
 *   회사(이 화면) 쓸 수 있는 것 중 무엇을 쓸까   — 자유
 *
 * 그래서 주문이 없는 양식은 켤 수 없다(서버가 409). 대신 **끄는 건 무엇이든 된다** —
 * 안 쓰는 보고서를 목록에서 치우는 건 그 회사가 정할 일이고, 목록이 짧아야 쓰는 사람이 찾는다.
 */
export const ReportPrefPanel = ({ embedded }) => {
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState('')

  const load = async () => setRows(await api.getReportPrefs())
  useEffect(() => { load() }, [])

  const toggle = async (r) => {
    setBusy(r.key)
    const res = await api.setReportPref(r.key, !r.enabled)
    setBusy('')
    if (!res.ok) return toast.push(res.error || '바꾸지 못했어요', { tone: 'warn' })
    toast.push(`${r.title} 을(를) ${r.enabled ? '끔' : '켬'}`)
    load()
  }

  if (rows === null) return <Loading label="보고서 설정을 불러오는 중…"/>

  const on = rows.filter(r => r.visible).length
  return (
    <div className={embedded ? '' : 'fade-up'}>
      {!embedded && <PageHeader title="보고서 관리"/>}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="row card-pad" style={{ paddingBottom: 10, alignItems: 'baseline' }}>
          <div className="fw-700">보고서</div>
          <div className="text-sm text-muted" style={{ marginLeft: 10 }}>
            보고서 화면에 무엇을 띄울지 고릅니다 · 사용 중 {on}개
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>보고서</th>
              <th style={{ width: 120 }}>구분</th>
              <th style={{ width: 110 }}>상태</th>
              <th style={{ width: 120 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <td>
                  <span className="fw-600">{r.title}</span>
                  <div className="text-sm text-muted">{r.descr}</div>
                </td>
                <td className="text-sm">
                  {r.basic
                    ? <span className="text-muted">기본 제공</span>
                    : <span className="badge" style={{ fontSize: 11 }}>선택 제공</span>}
                </td>
                <td>
                  {/* 정상(사용 중)에는 표식을 달지 않는다 — 전부 배지가 붙으면 정작 꺼진 게 안 보인다 */}
                  {r.visible ? <span className="text-sm text-muted2">사용 중</span>
                    : !r.entitled ? <span className="badge" style={{ fontSize: 11 }}>미주문</span>
                    : <span className="badge warn" style={{ fontSize: 11 }}>꺼짐</span>}
                </td>
                <td>
                  {/* 주문이 없으면 켤 수 없다. 켜는 단추 대신 왜 못 켜는지를 적는다 */}
                  {!r.entitled && r.enabled
                    ? <span className="text-xs text-muted2">문의 후 사용</span>
                    : (
                      <button className={`btn sm ${r.enabled ? '' : 'primary'}`}
                        disabled={busy === r.key}
                        onClick={() => toggle(r)}>
                        {busy === r.key ? '…' : r.enabled ? '끄기' : '켜기'}
                      </button>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="card-pad text-xs text-muted" style={{ paddingTop: 0, lineHeight: 1.7 }}>
          · 끄면 <b>보고서 화면 목록에서 빠지고</b> 그 자료도 열리지 않습니다. 언제든 다시 켤 수 있어요.<br/>
          · <b>선택 제공</b>은 사용 주문이 있어야 켜집니다 — 도입을 원하시면 문의해주세요.<br/>
          · 여기 설정은 <b>회사 전체</b>에 적용됩니다. 사람별로 가리는 건 환경설정 &gt; 사용자의 역할에서 정합니다.
        </div>
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
  /* 은퇴한 탭은 지금 그 일을 하는 탭으로 넘긴다. 그냥 두면 allowedTabs 에 없어서
     첫 탭(거래처)으로 떨어지는데, 옛 북마크를 누른 사람 눈에는 엉뚱한 화면이 뜬 것이다. */
  const wantedTab = RETIRED_TABS[forcedTab] || forcedTab;
  const forced = wantedTab && allowedTabs.includes(wantedTab) ? wantedTab : null;
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

  // 표 정의가 없는 탭도 전용 패널 경로로 보낸다 — 등록을 빠뜨려도 크래시가 아니라 빈 카드가 된다.
  const isCustomTab = CUSTOM_PANEL_TABS.has(activeTab) || !MASTER_DATA[activeTab]
  const data = !isCustomTab ? MASTER_DATA[activeTab] : null
  const rawRows = activeTab === "user" ? userRows : (data?.rows || [])
  const rows = rawRows.filter(r => !q || r.some(c => String(c).toLowerCase().includes(q.toLowerCase())));

  const toggleGroup = (name) => setCollapsed(c => ({ ...c, [name]: !c[name] }));

  const renderCustomPanel = () => {
    if (REF_CONFIGS[activeTab])           return <RefMasterPanel key={activeTab} cfg={REF_CONFIGS[activeTab]} embedded={single}/>
    if (activeTab === "vendor")           return <VendorPanel embedded={single}/>
    /* ⚠ key 를 준다. 계좌와 카드는 **같은 컴포넌트**라, key 가 없으면 React 가 한 인스턴스를
       재사용해 상태가 그대로 넘어간다 — 계좌 상세를 열어 둔 채 카드로 옮기면 카드 목록 위에
       통장 상세가 떠 있고, 거기서 저장하면 kind='card' 로 저장돼 **통장이 카드가 된다.** */
    if (activeTab === "account")          return <AccountPanel key="bank" embedded={single} kind="bank"/>
    if (activeTab === "card")             return <AccountPanel key="card" embedded={single} kind="card"/>
    if (activeTab === "company")          return <CompanyPanel embedded={single}/>
    if (activeTab === "accountSubject")   return <AccountSubjectPanel embedded={single}/>
    if (activeTab === "category")         return <CategoryPanel embedded={single}/>
    if (activeTab === "recurringExpense") return <RecurringExpensePanel/>
    if (activeTab === "recurringInvoice") return <RecurringInvoicePanel/>
    if (activeTab === "payrollItems")     return <PayrollItemPanel embedded={single}/>
    if (activeTab === "employType")       return <EmployTypePanel embedded={single}/>
    if (activeTab === "user")             return <UserPanel currentUser={user} embedded={single}/>
    if (activeTab === "approval")         return <ApprovalPanel embedded={single}/>
    if (activeTab === "reports")          return <ReportPrefPanel embedded={single}/>
    if (activeTab === "closing")          return <ClosingPanel embedded={single}/>
    if (activeTab === "audit")            return <AuditPanel embedded={single}/>
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
// income_type만 세법이 정한 닫힌 값. 주문 등록 시 여기 기본값이 자동으로 채워진다.
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
      body: "고용형태 목록에서 제거됩니다. 이미 이 유형으로 맺은 주문은 그대로 유지돼요.", confirmLabel: "삭제" });
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
          <div className="section-sub">근로계약·용역·일용에서 쓰는 고용형태를 직접 만들어두세요. 주문을 등록할 때 소득구분·단가 단위·4대보험 적용이 자동으로 채워집니다.</div>
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
            <FieldRow label="4대보험 적용" hint="일용·단시간은 조건부라 주문마다 다를 수 있어요">
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

