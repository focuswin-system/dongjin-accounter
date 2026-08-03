/**
 * API layer — Express + MariaDB 백엔드 전용. 모든 요청은 같은 오리진의 /api 로 나간다
 * (개발에서는 Vite 프록시가 로컬 서버로 넘긴다 — 포트는 vite.config.js 참조).
 *
 * ⚠ 조회 계열 메서드는 실패를 `catch { return [] }` 로 삼켜 화면이 안 깨지게 한다.
 *   대신 그대로 두면 서버 장애와 '데이터 0건'이 똑같아 보이므로, 삼키기 전에
 *   req() 가 setApiFailureHandler 로 알린다(아래 notifyInfra 참조).
 */
// 메뉴 색인·검색 태그 — 명령팔레트(Ctrl+K)가 화면 전체를 찾을 수 있게 한다
import { ALL_LEAVES, LEAF_TAGS } from './nav'


const BASE = '/api'

// 오늘 / 이번 달 — 로컬(KST) 기준. new Date().toISOString()은 UTC라 KST 00~09시에
// 하루 전 날짜가 나온다(월 경계에선 전월). 서버 kstToday()와 짝을 맞춘다.
const localToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const localMonth = () => localToday().slice(0, 7)

/**
 * TIMESTAMP 컬럼(created_at·matched_at 등) → 화면에 쓸 'YYYY-MM-DD'.
 *
 * mysql2 는 TIMESTAMP 를 Date 로 주고 JSON 직렬화에서 UTC ISO 문자열이 된다.
 * 그걸 그대로 뿌리면 화면에 **'2026-08-02T23:53:31.000Z'** 가 나온다(실제로 입금 이력이
 * 그랬다). 게다가 UTC라 KST 오전 9시 이전 기록은 하루 앞 날짜로 보인다.
 * DATE 컬럼('YYYY-MM-DD')이 들어와도 그대로 통과시킨다.
 */
export const dayOf = (v) => {
  if (!v) return ''
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s          // 이미 날짜만
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s              // 못 읽으면 원문 유지
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 시각까지 보여야 하는 자리(마감 시각 등) → 'YYYY-MM-DD HH:mm' (로컬=KST).
 *  문자열을 잘라 쓰면 UTC 시각이 그대로 나와 9시간 어긋난다. */
export const minuteOf = (v) => {
  if (!v) return ''
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) return String(v)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 실패를 사용자에게 설명 가능한 형태로 만든다.
 *
 * 화면 코드 대부분은 load() 안에서 이 함수를 await 만 하고 try 로 감싸지 않는다.
 * 그대로 두면 실패가 unhandledrejection 으로 새어나가 **화면이 조용히 빈 상태로 남는다**
 * — 사용자는 '데이터가 없는 것'과 '서버가 죽은 것'을 구분할 수 없다.
 * 그래서 던지는 오류에 status·kind 를 붙여, App 의 전역 핸들러가 무엇이 잘못됐는지
 * 토스트로 알려줄 수 있게 한다.
 */
function apiError(message, { status = 0, kind = 'http', code = '' } = {}) {
  const e = new Error(message)
  e.status = status
  e.kind = kind      // 'network' | 'auth' | 'ratelimit' | 'http'
  // 서버가 준 사유 코드(예: 'duplicate'). 화면이 문구를 다시 파싱하지 않고 분기할 수 있게 남긴다.
  e.code = code
  return e
}

/**
 * 인프라 실패 알림 — App 이 토스트에 연결한다.
 *
 * ⚠ 조회 계열 메서드는 대부분 `catch { return [] }` 로 실패를 빈 배열로 바꾼다.
 * 화면이 안 깨지는 대신 **서버가 죽은 것과 데이터가 0건인 것이 똑같아 보인다.**
 * 그래서 삼켜지기 전, 요청 계층에서 한 번 알린다. 여기서 알리지 않으면
 * 전역 unhandledrejection 핸들러도 소용없다 — 애초에 rejection 이 생기지 않으니까.
 *
 * 다만 모든 실패를 알리지는 않는다. 400/409 같은 업무 규칙 위반은 호출부가 이미
 * 화면에 사유를 띄우므로(마감된 기간·계좌 미선택 등) 토스트까지 겹치면 시끄럽다.
 * 화면 코드가 어찌할 수 없는 것 — 네트워크 단절·5xx·429 — 만 알린다.
 */
let infraFailureHandler = null
export function setApiFailureHandler(fn) { infraFailureHandler = fn }

function notifyInfra(err) {
  const infra = err.kind === 'network' || err.kind === 'ratelimit' || err.status >= 500
  if (!infra || !infraFailureHandler) return err
  err.notified = true   // 전역 핸들러가 같은 오류를 두 번 띄우지 않도록
  try { infraFailureHandler(err) } catch { /* 알림 실패가 요청을 막지 않는다 */ }
  return err
}

async function req(path, opts = {}) {
  const token = localStorage.getItem('token')
  let res
  try {
    res = await fetch(BASE + path, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    // fetch 자체가 실패 = 서버가 내려갔거나 네트워크가 끊겼다.
    // 기본 메시지("Failed to fetch")는 사용자에게 아무 의미가 없다.
    throw notifyInfra(apiError('서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요.', { kind: 'network' }))
  }
  // 슬라이딩 세션 — 서버가 만료 임박을 감지하면 새 토큰을 실어 보낸다.
  // 조용히 갈아끼운다(사용자에게 알릴 일이 아니다). 이게 있어야 일하는 도중에 안 튕긴다.
  const renewed = res.headers.get('X-Renewed-Token')
  if (renewed) localStorage.setItem('token', renewed)

  if (res.status === 401) {
    // opts.softAuth: 401이어도 세션을 지우지 않는다.
    // 앱이 켜지자마자 배경으로 부르는 호출(권한 조회 등)에 쓴다 — 이런 호출이 세션을 지우면
    // 일시적인 401 하나에 작업 중이던 사람이 통째로 튕긴다. 진짜 만료라면 사용자가
    // 무언가를 눌렀을 때 그 호출이 아래 정상 경로로 처리한다.
    if (opts.softAuth) throw apiError('인증이 만료되었습니다', { status: 401, kind: 'auth' })

    /* 죽은 세션의 늦은 응답은 무시한다 — **로그인 직후 튕기던 원인**.
     *
     * 만료된 토큰이 localStorage 에 남아 있으면 앱이 켜지면서 그 토큰으로 요청 십수 개를
     * 한꺼번에 쏜다. 그중 하나가 401을 물고 와 세션을 지우고 로그인 화면으로 되돌린다.
     * 여기까지는 맞다. 그런데 **느린 요청**(/finance/summary 는 상환 스케줄까지 계산한다)은
     * 그 사이에 아직 날아다니고 있다가, 사용자가 새로 로그인해 화면에 들어간 **뒤에** 401로
     * 돌아온다. 그러면 방금 받은 멀쩡한 토큰까지 지우고 또 튕긴다.
     *
     * 그래서 요청을 보낼 때 쓴 토큰이 지금도 그대로인지 본다. 바뀌었다면 그 401은
     * 이미 끝난 세션의 것이므로 버린다. 지금 세션은 건드리지 않는다. */
    if (token !== localStorage.getItem('token')) {
      throw apiError('지난 세션의 요청이라 무시했어요', { status: 401, kind: 'auth' })
    }

    // 어느 요청이 세션을 끊었는지 남긴다.
    // 이게 없으면 사용자에게는 '갑자기 로그인 화면으로 튕겼다'로만 보이고,
    // 고치는 쪽에서도 어디를 봐야 할지 알 수 없다(실제로 원인 추적에 오래 걸렸다).
    let why = ''
    try { const b = await res.clone().json(); why = b?.error || '' } catch { /* 본문 없음 */ }
    console.error(`[auth] 401 — ${opts.method || 'GET'} ${path} :: ${why}`)
    try {
      sessionStorage.setItem('authFail', JSON.stringify({
        path, method: opts.method || 'GET', why, at: new Date().toISOString(),
      }))
    } catch { /* 저장 실패는 무시 */ }
    localStorage.removeItem('token')
    localStorage.removeItem('loggedIn')
    localStorage.removeItem('user')
    window.location.reload()
    // kind:'auth' — 어차피 로그인 화면으로 되돌아가므로 토스트를 띄우지 않는다.
    throw apiError('인증이 만료되었습니다', { status: 401, kind: 'auth' })
  }
  if (!res.ok) {
    let msg = `요청을 처리하지 못했어요 (${res.status})`
    let code = ''
    try { const body = await res.json(); if (body?.error) msg = body.error; code = body?.code || '' } catch { /* 본문 없음 */ }
    // 429는 서버가 이유와 대기 시간을 문구에 담아 보낸다(시도 제한·요청 한도).
    // 이걸 삼키면 사용자는 왜 막혔는지 모른 채 빈 화면만 본다.
    throw notifyInfra(apiError(msg, { status: res.status, kind: res.status === 429 ? 'ratelimit' : 'http', code }))
  }
  return res.json()
}

// 엑셀 임포트 파싱용 — multipart라 req()(JSON 전용)를 쓸 수 없다
async function postImportFile(path, file) {
  const fd = new FormData()
  fd.append('file', file)
  const token = localStorage.getItem('token')
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  })
  if (!res.ok) throw new Error('엑셀 파싱에 실패했어요')
  return res.json() // { headers, rows, total, truncated }
}

// 서버 응답 → 컴포넌트 형식 변환
function adaptAccount(row) {
  return {
    id: row.id,
    name: row.name,
    bankName: row.bank,
    type: row.type,
    initialBalance: row.initial_balance,
    /* 서버가 권한 없는 사용자에게 balance: null 을 준다. 여기서 `?? initial_balance` 로
     * 메우면 **개설 잔액이 현재 잔액인 척** 표시된다 — 가리려던 의도도 못 지키고,
     * 아무 경고 없이 틀린 숫자를 보여주게 된다. null 은 null 로 두고 화면이 '—' 를 그린다. */
    currentBalance: row.balance ?? null,
    adjustments: row.adjustments ?? [],
    kind: row.kind || 'bank',
    number: row.number || '',
    purpose: row.purpose || '',
  }
}

function parseMemo(raw) {
  if (!raw) return { display: '', parsed: null }
  try {
    const obj = JSON.parse(raw)
    if (obj.src?.startsWith('payables-import')) {
      const parts = [obj.item, obj.buyer && obj.buyer !== '공용' ? obj.buyer : '', obj.vessel && obj.vessel !== '직영' ? obj.vessel : '']
        .filter(Boolean)
      return { display: parts.join(' · '), parsed: obj }
    }
  } catch { /* not JSON */ }
  return { display: raw, parsed: null }
}

// 거래 첨부 서류: transaction_docs + 레거시 단일 증빙(evid_url)을 하나의 목록으로 합침
function buildTxnDocs(row) {
  const list = (row.docs || []).map(d => ({ id: d.id, url: d.url, name: d.name, type: d.doc_type || '기타', size: d.size || 0 }))
  if (row.evid_url && !list.some(d => d.url === row.evid_url)) {
    list.unshift({ id: null, url: row.evid_url, name: row.evid_type || '첨부 파일', type: '기타', size: 0, legacy: true })
  }
  return list
}

function adaptInvoice(row) {
  const { display: memoDisplay, parsed: memoParsed } = parseMemo(row.memo)
  return {
    id: row.id,
    invoiceNo: row.invoice_no || row.id,
    kind: row.kind,
    vendor: row.vendor_name || '',
    contractId: row.contract_id,
    contract: row.contract_name || '',
    supplyAmount: row.supply_amount,
    vatAmount: row.vat_amount,
    totalAmount: row.total_amount,
    taxType: row.tax_type || '',   // 과세/면세/영세 — 편집 시 자동 10% 재계산을 막는 데 필요
    ntsConfirmNo: row.nts_confirm_no || '',   // 홈택스 승인번호 — 세금계산서 임포트의 중복 판정 키
    issuedAt: row.issued_at,
    dueAt: row.due_at || null,
    status: row.status,
    accountId: row.account_id,
    // id 는 정산 취소에 필요하다(없으면 화면에서 어느 매칭인지 지목할 수 없다)
    matches: (row.matches || []).map(m => ({ id: m.id, txnId: m.txn_id, amount: m.amount, matchedAt: dayOf(m.matched_at) })),
    docs: (row.docs || []).map(d => ({ id: d.id, url: d.url, name: d.name, type: d.doc_type || '기타', size: d.size || 0 })),
    paidAmount: row.paidAmount || 0,
    remainAmount: row.remainAmount ?? row.total_amount,
    memo: memoDisplay,
    memoRaw: row.memo || '',
    memoParsed,
    category: row.category,
    doc: row.doc,
  }
}

function adaptTransaction(row) {
  return {
    id: row.id,
    kind: row.kind,
    sign: row.kind === 'income' ? +1 : -1,
    date: row.date || '',
    vendor: row.vendor_name || '(미확인)',
    vendorId: row.vendor_id,
    contract: row.contract_name || row.doc_no || '',
    contractId: row.contract_id || '',
    // 원가 귀속(지출만) — 이 지출이 어느 매출계약의 원가인지. 근거 계약과 별개 축.
    cost_contract_id: row.cost_contract_id || '',
    cost_contract_name: row.cost_contract_name || '',
    account: row.account_name || '',
    scope: row.contract_name || row.memo || row.doc_no || '—',
    category: row.category || '—',
    subCategory: row.sub_category,
    amount: row.amount,
    // 부가세: null이면 이 기능 이전 거래(세액 미상) — 화면이 합계에서 역산한다
    supply_amount: row.supply_amount ?? null,
    vat_amount: row.vat_amount ?? null,
    tax_type: row.tax_type || '',
    vat_deductible: row.vat_deductible == null ? 1 : Number(row.vat_deductible),
    method: row.method,
    status: row.status,
    accountId: row.account_id,
    // 업종중립 필드: 프로젝트·공사번호 / 현장·사용처 (구 vessel_no·usage_place)
    project_no: row.project_no || '',
    site: row.site || '',
    invoiceId: row.invoice_id,
    docNo: row.doc_no,
    evid_url: row.evid_url || '',
    evid_type: row.evid_type || '',
    docs: buildTxnDocs(row),
    evid: (row.docs && row.docs.length > 0) || !!(row.evid_url || row.evid_type),
    memo: row.memo || '',
    item_id: row.item_id || '',
    item_name: row.item_name || '',
    account_code: row.account_code || '',
    /* 손익 거래인가 — 서버가 계정과목 대분류로 판정해 내려준다(server/lib/pnl.js 와 같은 규칙).
     * 대출 실행·원금 상환·예적금 납입·투자는 계좌는 오가지만 손익이 아니다.
     * 값이 없는 옛 응답은 손익으로 본다(종전 동작 유지). */
    isPnl: row.is_pnl == null ? true : !!Number(row.is_pnl),
    /* 청구서 정산으로 생긴 거래인가. 보고서가 '재무거래(대출·투자)'와
     * '매출 수금'을 갈라내는 데 쓴다 — 둘 다 손익 거래가 아니지만 성격이 정반대다. */
    invoiceId: row.invoice_id || '',
    /* 급여·용역 지급으로 생긴 거래인가. 인사급여에서 관리하는 건이라
     * '일반 경비' 목록에서는 빼야 한다(안 빼면 경비의 대부분이 급여가 된다). */
    payrollId: row.payroll_id || '',
    employee: row.employee_name || '',
  }
}

function adaptEmployee(row) {
  return {
    id: row.id,
    code: row.emp_no || String(row.id ?? '').slice(0, 8),
    name: row.name,
    role: row.role || '—',
    dept: row.department || '—',
    pos: row.role || '—',
    join: row.join_date || '—',
    birth: row.birth_date || '',
    status: row.status || (row.active ? '재직' : '퇴사'),
    baseSalary: row.base_salary || 0,
    // 급여이체 계좌 — 없으면 '—'(화면이 그대로 찍는다)
    account: row.salary_account || '—',
    salary_account: row.salary_account || '',
    pay: {
      base: row.base_salary || 0,
      mealAllowance: row.meal_allowance || 0,
      positionAllowance: row.position_allowance || 0,
      vehicleAllowance: row.vehicle_allowance || 0,
      dependents: row.dependents == null ? 1 : row.dependents,
      childDependents: row.child_dependents || 0,
    },
  }
}

export const api = {
  // ─── 내 정보·권한 ─────────────────────────────────────────────
  // 권한은 토큰이 아니라 매번 서버에서 읽는다. 관리자가 역할을 바꿔도 재로그인 없이 반영된다.
  // softAuth — 앱이 켜지는 즉시 배경으로 부르는 호출이라, 이게 401 하나로 세션을 지우면
  // 작업 중이던 사람이 아무것도 안 눌렀는데 로그인 화면으로 튕긴다.
  async me() { return req('/auth/me', { softAuth: true }) },

  // ─── 계좌 ─────────────────────────────────────────────────────
  async getAccounts() {
    try { return (await req('/accounts')).map(adaptAccount) } catch { return [] }
  },

  async addAccount(data) {
    try {
      const result = await req('/accounts', { method: 'POST', body: data })
      return { ok: true, id: result.id }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async updateAccount(id, data) {
    try {
      await req(`/accounts/${id}`, { method: 'PUT', body: data })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async deleteAccount(id) {
    try {
      await req(`/accounts/${id}`, { method: 'DELETE' })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async getAdjustments(accountId) {
    try {
      return (await req(`/accounts/${accountId}/adjustments`)).map(a => ({
        date: a.date, amount: Number(a.amount), reason: a.reason, by: a.created_by,
      }))
    } catch { return [] }
  },

  async addAdjustment(accountId, { amount, reason, by = '담당자' }) {
    try {
      await req(`/accounts/${accountId}/adjustments`, {
        method: 'POST',
        body: { amount, reason, date: localToday(), created_by: by },
      })
      return { ok: true }
    } catch (e) {
      // 서버 메시지를 버리면 마감된 달·사유 누락 같은 거절 이유를 사용자가 알 수 없다
      return { ok: false, error: e.message }
    }
  },

  // ─── 회사 정보 ────────────────────────────────────────────────
  async getCompany() {
    try { return await req('/company') } catch { return null }
  },

  async saveCompany(data) {
    try {
      await req('/company', { method: 'PUT', body: data })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },

  // ─── 청구서 ───────────────────────────────────────────────────
  async getInvoices({ kind, status, from, to } = {}) {
    try {
      const params = new URLSearchParams()
      if (kind)   params.set('kind', kind)
      if (status) params.set('status', status)
      if (from) params.set('from', from)   // 기본 전체 기간(연말 넘긴 미수금이 사라지지 않도록)
      if (to) params.set('to', to)
      return (await req(`/invoices?${params}`)).map(adaptInvoice)
    } catch { return [] }
  },

  async getReceivablesSummary() {
    try {
      const data = await req('/invoices/summary/receivables')
      return { total: data.summary.total, count: data.summary.count, overdueAmount: data.summary.overdue, overdueCount: data.summary.overdueCount ?? 0 }
    } catch { return { total: 0, count: 0, overdueAmount: 0, overdueCount: 0 } }
  },

  async getPayablesSummary() {
    try {
      const data = await req('/invoices/summary/payables')
      return { total: data.summary.total, count: data.summary.count, overdueAmount: data.summary.overdue, overdueCount: data.summary.overdueCount ?? 0 }
    } catch { return { total: 0, count: 0, overdueAmount: 0, overdueCount: 0 } }
  },

  async getVatSummary(quarter) {
    try {
      const year = new Date().getFullYear()
      const data = await req(`/invoices/summary/vat?quarter=${quarter}&year=${year}`)
      return {
        quarter,
        salesVat: data.salesVat,
        purchaseVat: data.purchaseVat,
        netVat: data.netVat,
        salesInvoices: data.rows.filter(r => r.kind === 'issued').map(adaptInvoice),
        purchaseInvoices: data.rows.filter(r => r.kind === 'received').map(adaptInvoice),
      }
    } catch { return { quarter, salesVat: 0, purchaseVat: 0, netVat: 0, salesInvoices: [], purchaseInvoices: [] } }
  },

  async addInvoice(data) {
    try {
      const result = await req('/invoices', { method: 'POST', body: data })
      return { ok: true, id: result.id }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async updateInvoice(id, data) {
    try {
      await req(`/invoices/${id}`, { method: 'PUT', body: data })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async deleteInvoice(id) {
    try {
      await req(`/invoices/${id}`, { method: 'DELETE' })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async getMatchable(invoiceId) {
    try { return await req(`/invoices/${invoiceId}/matchable`) } catch { return [] }
  },

  // account_code = 계정과목 코드, account_id = 입출금 계좌. 서로 다른 값이니 섞지 말 것.
  async matchInvoice(invoiceId, { txnId, amount, date, category, memo, account_code, account_id }) {
    try {
      await req(`/invoices/${invoiceId}/matches`, { method: 'POST', body: { txn_id: txnId, amount, date, category, memo, account_code, account_id } })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }   // 실패 사유를 화면까지 전달한다
  },

  /** 정산(입금·지급 매칭) 취소. 잘못 연결한 입금을 되돌리는 유일한 길이다.
   *  서버가 정산이 만든 거래는 함께 지우고, 원래 있던 거래는 연결만 끊는다. */
  async unmatchInvoice(invoiceId, matchId) {
    try {
      const r = await req(`/invoices/${invoiceId}/matches/${matchId}`, { method: 'DELETE' })
      return { ok: true, removedTxn: r?.removedTxn || null }
    } catch (e) { return { ok: false, error: e.message } }
  },

  // ─── 거래내역 ─────────────────────────────────────────────────
  async getTransactions({ kind, from, to, category, accountId } = {}) {
    try {
      const params = new URLSearchParams()
      if (kind)      params.set('kind', kind)
      if (category)  params.set('category', category)
      if (accountId) params.set('accountId', accountId)
      if (from)      params.set('from', from)
      if (to)        params.set('to', to)
      return (await req(`/transactions?${params}`)).map(adaptTransaction)
    } catch { return [] }
  },

  async addTransaction(data) {
    try {
      const result = await req('/transactions', { method: 'POST', body: data })
      return { ok: true, id: result.id }
    } catch (e) { return { ok: false, error: e.message } }   // 마감·계좌 등 400/409 사유를 화면까지
  },

  // ─── 엑셀 임포트 ───────────────────────────────────────────────
  async parseExcel(file) {
    const fd = new FormData()
    fd.append('file', file)
    const token = localStorage.getItem('token')
    const res = await fetch(`${BASE}/transactions/import/parse`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    })
    if (!res.ok) throw new Error('엑셀 파싱에 실패했어요')
    return res.json() // { headers, rows }
  },

  // accountId — 대량 등록분이 어느 계좌에서 오간 것인지. 없으면 잔액에 반영되지 않아 서버가 400을 준다.
  async commitImport(items, accountId) {
    try {
      const r = await req('/transactions/import/commit', { method: 'POST', body: { items, account_id: accountId || null } })
      return { ok: true, ...r }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async updateTransaction(id, data) {
    try {
      await req(`/transactions/${id}`, { method: 'PUT', body: data })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }   // 마감·계좌 등 400/409 사유를 화면까지
  },

  async updateTransactionStatus(id, status) {
    try {
      await req(`/transactions/${id}/status`, { method: 'PATCH', body: { status } })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async deleteTransaction(id) {
    try {
      await req(`/transactions/${id}`, { method: 'DELETE' })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }   // 409 사유(세금 납부·결의서·급여 연결)를 화면까지
  },

  async uploadFile(file) {
    try {
      const token = localStorage.getItem('token')
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/uploads', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })
      if (!res.ok) throw new Error('upload failed')
      return await res.json()
    } catch(e) { return { ok: false, error: e.message } }
  },

  // 거래의 증빙(레거시 단일)만 갱신(다른 필드 보존)
  async updateTransactionEvidence(id, data) {
    try { await req(`/transactions/${id}/evidence`, { method: 'PATCH', body: data }); return { ok: true } }
    catch { return { ok: false } }
  },
  // 거래 첨부 서류(다중)
  async addTransactionDoc(txnId, data) {
    try { const r = await req(`/transactions/${txnId}/docs`, { method: 'POST', body: data }); return { ok: true, id: r.id } }
    catch { return { ok: false } }
  },
  async deleteTransactionDoc(docId) {
    try { await req(`/transactions/docs/${docId}`, { method: 'DELETE' }); return { ok: true } }
    catch { return { ok: false } }
  },
  // 계약 첨부 서류(다중)
  async addContractDoc(contractId, data) {
    try { const r = await req(`/contracts/${contractId}/docs`, { method: 'POST', body: data }); return { ok: true, id: r.id } }
    catch { return { ok: false } }
  },
  async deleteContractDoc(docId) {
    try { await req(`/contracts/docs/${docId}`, { method: 'DELETE' }); return { ok: true } }
    catch { return { ok: false } }
  },
  async clearContractFile(contractId) {
    try { await req(`/contracts/${contractId}/clear-file`, { method: 'PATCH' }); return { ok: true } }
    catch { return { ok: false } }
  },

  // 청구서 첨부 서류
  async addInvoiceDoc(invoiceId, data) {
    try { const r = await req(`/invoices/${invoiceId}/docs`, { method: 'POST', body: data }); return { ok: true, id: r.id } }
    catch { return { ok: false } }
  },
  async deleteInvoiceDoc(docId) {
    try { await req(`/invoices/docs/${docId}`, { method: 'DELETE' }); return { ok: true } }
    catch { return { ok: false } }
  },

  // ─── 정기지출 ─────────────────────────────────────────────────
  async getRecurringExpenses() {
    try {
      return (await req('/recurring-expenses')).map(r => ({
        id: r.id,
        vendor: r.vendor_name || '(미확인)',
        vendorId: r.vendor_id,
        contractId: r.contract_id,   // 수정 시 계약 연결을 잃지 않도록 함께 싣는다
        category: r.category,
        amount: r.amount,
        period: r.period,
        dayOfMonth: r.day_of_month,
        startDate: r.start_date,
        endDate: r.end_date,
        accountId: r.account_id,
        vatMode: r.vat_mode,
        active: r.active === 1,
        lastGenerated: r.last_generated,
      }))
    } catch { return [] }
  },

  // 폼이 보내는 snake_case 를 그대로 쓴다. 예전에는 camelCase(vendorId·startDate…)를 읽었는데
  // 폼은 다른 이름으로 보내고 있어, 필수값이 통째로 undefined 로 전달돼 저장이 항상 실패했다.
  async addRecurringExpense(data) {
    try {
      const result = await req('/recurring-expenses', { method: 'POST', body: {
        vendor_id: data.vendor_id ?? data.vendorId ?? null,
        contract_id: data.contract_id ?? null,
        category: data.category,
        amount: data.amount,
        vat_mode: data.vat_mode ?? data.vatMode ?? null,
        period: data.period,
        day_of_month: data.day_of_month ?? data.dayOfMonth,
        start_date: data.start_date ?? data.startDate,
        end_date: data.end_date ?? data.endDate ?? null,
        account_id: data.account_id ?? data.accountId ?? null,
      }})
      return { ok: true, id: result.id }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async updateRecurringExpense(id, data) {
    try {
      await req(`/recurring-expenses/${id}`, { method: 'PUT', body: {
        vendor_id: data.vendor_id ?? data.vendorId ?? null,
        // 계약 연결은 폼이 다루지 않으므로 기존 값을 그대로 실어 보낸다.
        // 예전엔 항상 null이라, 계약에 걸린 정기지출을 수정하면 연결이 조용히 끊겼다.
        contract_id: data.contract_id ?? data.contractId ?? null,
        category: data.category,
        amount: data.amount,
        vat_mode: data.vat_mode ?? data.vatMode ?? null,
        period: data.period,
        day_of_month: data.day_of_month ?? data.dayOfMonth,
        start_date: data.start_date ?? data.startDate,
        end_date: data.end_date ?? data.endDate ?? null,
        account_id: data.account_id ?? data.accountId ?? null,
      }})
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },
  async toggleRecurringExpense(id) {
    try {
      const result = await req(`/recurring-expenses/${id}/toggle`, { method: 'PATCH', body: {} })
      return { ok: true, active: result.active }
    } catch { return { ok: false } }
  },
  // 정기지출 삭제 — 앞으로 자동 생성만 멈춘다. 이미 만들어진 청구서·거래는 남는다(실제 돈 기록).
  async deleteRecurringExpense(id) {
    try { const r = await req(`/recurring-expenses/${id}`, { method: 'DELETE' }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  // 지급 예정인 정기지출 회차(아직 매입 청구서 미생성) — 매입 대금청구서 '지급 예정'에 계약 지급일정과 함께
  async getPendingRecurringExpenses() {
    try { return await req('/recurring-expenses/pending') } catch { return [] }
  },
  // 정기지출 회차 1건을 매입 청구서(미지급금)로 등록. paid=true면 지급 처리까지
  async issueRecurringExpense(recurringId, { due, paid = false, account_id } = {}) {
    try { const r = await req(`/recurring-expenses/${recurringId}/issue`, { method: 'POST', body: { due, paid, account_id } }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  // 놓친 회차 일괄 등록 — 예정일이 지난 미등록 회차를 모두 '지급 대기' 청구서로.
  // 계좌는 건드리지 않는다(지급 처리는 회차별 '기지급 처리'에서). 매출 쪽과 대칭.
  async issueMissedRecurringExpenses() {
    try {
      const r = await req('/recurring-expenses/issue-missed', { method: 'POST', body: {} })
      return { ok: true, count: r.count, generated: r.generated }
    } catch (e) { return { ok: false, count: 0, error: e.message } }
  },

  // ─── 정기청구(고정수입) ───────────────────────────────────────
  async getRecurringInvoices() {
    try {
      return (await req('/recurring-invoices')).map(r => ({
        id: r.id,
        vendor: r.vendor_name || '(미지정)',
        vendorId: r.vendor_id,
        contractId: r.contract_id,
        contractName: r.contract_name,
        item: r.item,
        supplyAmount: r.supply_amount,
        vatMode: r.vat_mode,
        period: r.period,
        dayOfMonth: r.day_of_month,
        startDate: r.start_date,
        endDate: r.end_date,
        accountId: r.account_id,
        active: r.active === 1,
        lastGenerated: r.last_generated,
      }))
    } catch { return [] }
  },

  async addRecurringInvoice(data) {
    try {
      const result = await req('/recurring-invoices', { method: 'POST', body: {
        vendor_id: data.vendorId,
        contract_id: data.contractId,
        item: data.item,
        supply_amount: data.supplyAmount,
        vat_mode: data.vatMode,
        period: data.period,
        day_of_month: data.dayOfMonth,
        start_date: data.startDate,
        end_date: data.endDate,
        account_id: data.accountId,
      }})
      return { ok: true, id: result.id }
    } catch { return { ok: false } }
  },

  async updateRecurringInvoice(id, data) {
    try {
      await req(`/recurring-invoices/${id}`, { method: 'PUT', body: {
        vendor_id: data.vendorId ?? data.vendor_id ?? null,
        contract_id: data.contractId ?? data.contract_id ?? null,
        item: data.item,
        supply_amount: data.supplyAmount ?? data.supply_amount,
        vat_mode: data.vatMode ?? data.vat_mode,
        period: data.period,
        day_of_month: data.dayOfMonth ?? data.day_of_month,
        start_date: data.startDate ?? data.start_date,
        end_date: data.endDate ?? data.end_date ?? null,
        account_id: data.accountId ?? data.account_id ?? null,
      }})
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },
  async toggleRecurringInvoice(id) {
    try {
      const result = await req(`/recurring-invoices/${id}/toggle`, { method: 'PATCH', body: {} })
      return { ok: true, active: result.active }
    } catch { return { ok: false } }
  },
  // 정기청구 삭제 — 앞으로 자동 발행만 멈춘다. 이미 발행된 청구서는 남는다.
  async deleteRecurringInvoice(id) {
    try { const r = await req(`/recurring-invoices/${id}`, { method: 'DELETE' }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },

  // 놓친 회차 일괄 발행 — 예정일이 지난 미발행 회차를 모두 '입금 예정' 청구서로.
  // 계좌는 건드리지 않는다(입금 처리는 회차별 '기입금 처리'에서).
  async issueMissedRecurringInvoices() {
    try {
      const r = await req('/recurring-invoices/issue-missed', { method: 'POST', body: {} })
      return { ok: true, count: r.count, generated: r.generated }
    } catch (e) { return { ok: false, count: 0, error: e.message } }
  },

  // ─── 계약 ─────────────────────────────────────────────────────
  async getContracts({ status } = {}) {
    try {
      const params = status ? `?status=${status}` : ''
      return await req(`/contracts${params}`)
    } catch { return [] }
  },

  async getContract(id) {
    try { return await req(`/contracts/${id}`) } catch { return null }
  },

  // 기성 청구 발행 — 기성형(progress) 계약에서 품목별 수량으로 청구서 1건 + 품목 내역 생성.
  // body: { issued_at, due_at?, paid?, lines:[{ item_id, name, spec, unit, qty, unit_price, amount }] }
  async issueProgressInvoice(contractId, body) {
    try { const r = await req(`/contracts/${contractId}/progress-invoice`, { method: 'POST', body }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },

  // ── 지급결의서 ──
  async getResolutions() {
    try { return await req('/resolutions') } catch { return [] }
  },
  async getResolution(id) {
    try { return await req(`/resolutions/${id}`) } catch { return null }
  },
  // 지출 거래에 연결된 결의서(증빙 영역에서 열람). 없으면 null.
  async getResolutionByTxn(txnId) {
    try { return await req(`/resolutions/by-txn/${txnId}`) } catch { return null }
  },

  // ── 결재선 프리셋 ──
  async getApprovalPresets() {
    try { return await req('/approval-presets') } catch { return [] }
  },
  async addApprovalPreset(data) {
    try { const r = await req('/approval-presets', { method: 'POST', body: data }); return { ok: true, id: r.id } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async updateApprovalPreset(id, data) {
    try { await req(`/approval-presets/${id}`, { method: 'PUT', body: data }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async setDefaultApprovalPreset(id) {
    try { await req(`/approval-presets/${id}/default`, { method: 'PATCH' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async deleteApprovalPreset(id) {
    try { await req(`/approval-presets/${id}`, { method: 'DELETE' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  // 결의서 직접 등록 (청구서 없는 소액 경비 — 비누·간식 등)
  async createResolution(data) {
    try { const r = await req('/resolutions', { method: 'POST', body: data }); return { ok: true, resolution: r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  // 매입 청구서 1건 → 결의서 생성(지급 전 결재용, 이미 있으면 그 결의서 반환)
  async createResolutionFromInvoice(invoiceId) {
    try { const r = await req(`/resolutions/from-invoice/${invoiceId}`, { method: 'POST' }); return { ok: true, resolution: r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async updateResolution(id, data) {
    try { await req(`/resolutions/${id}`, { method: 'PUT', body: data }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  // 처리 시 연결할 만한 미연결 지출 거래 후보
  async getResolutionMatchable(id) {
    try { return await req(`/resolutions/${id}/matchable`) } catch { return [] }
  },
  // 결의서 처리 — mode:'link'(기존 거래 연결) | 'create'(새 지출 생성)
  async processResolution(id, body) {
    try { const r = await req(`/resolutions/${id}/process`, { method: 'POST', body }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async deleteResolution(id) {
    try { await req(`/resolutions/${id}`, { method: 'DELETE' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },

  // ── 정산내역서 ──────────────────────────────────────────────
  async getSettlements() {
    try { return await req('/settlements') } catch { return [] }
  },
  async getSettlement(id) {
    try { return await req(`/settlements/${id}`) } catch { return null }
  },
  async createSettlement(data) {
    try { const r = await req('/settlements', { method: 'POST', body: data }); return { ok: true, settlement: r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async updateSettlement(id, data) {
    try { await req(`/settlements/${id}`, { method: 'PUT', body: data }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async deleteSettlement(id) {
    try { await req(`/settlements/${id}`, { method: 'DELETE' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },

  // ── 구매품의서 ──────────────────────────────────────────────
  async getPurchaseReqs() {
    try { return await req('/purchase-reqs') } catch { return [] }
  },
  async getPurchaseReq(id) {
    try { return await req(`/purchase-reqs/${id}`) } catch { return null }
  },
  async createPurchaseReq(data) {
    try { const r = await req('/purchase-reqs', { method: 'POST', body: data }); return { ok: true, req: r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async updatePurchaseReq(id, data) {
    try { await req(`/purchase-reqs/${id}`, { method: 'PUT', body: data }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async deletePurchaseReq(id) {
    try { await req(`/purchase-reqs/${id}`, { method: 'DELETE' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  // 구매품의서 → 미지급금(매입 청구서) 등록
  async issuePurchaseReqPayable(id, { supply_amount, vat_mode, due } = {}) {
    try { const r = await req(`/purchase-reqs/${id}/issue-payable`, { method: 'POST', body: { supply_amount, vat_mode, due } }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },

  async getQuoteReqs() {
    try { return await req('/quote-reqs') } catch { return [] }
  },
  async getQuoteReq(id) {
    try { return await req(`/quote-reqs/${id}`) } catch { return null }
  },
  async createQuoteReq(data) {
    try { const r = await req('/quote-reqs', { method: 'POST', body: data }); return { ok: true, req: r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async updateQuoteReq(id, data) {
    try { await req(`/quote-reqs/${id}`, { method: 'PUT', body: data }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async deleteQuoteReq(id) {
    try { await req(`/quote-reqs/${id}`, { method: 'DELETE' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },

  async addContract(data) {
    try {
      const result = await req('/contracts', { method: 'POST', body: data })
      return { ok: true, id: result.id }
    } catch (e) { return { ok: false, error: e.message } }
  },
  async deleteContract(id) {
    try { await req(`/contracts/${id}`, { method: 'DELETE' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }   // 409 사유(청구서·거래 연결)를 화면까지
  },

  async updateContract(id, data) {
    try {
      await req(`/contracts/${id}`, { method: 'PUT', body: data })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },
  async updateContractMemo(id, memo) {
    try { await req(`/contracts/${id}/memo`, { method: 'PATCH', body: { memo } }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },

  // 계약 목록 엑셀 내려받기 (kind: 'sales'|'purchase'|'all').
  // 인증 헤더가 필요해서 <a href>로는 안 되고, blob으로 받아 저장한다.
  async exportContractsXlsx(kind = 'all') {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(`${BASE}/contracts/export.xlsx?kind=${kind}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) throw new Error('내보내기에 실패했어요')
      const blob = await res.blob()
      const label = kind === 'purchase' ? '매입계약' : kind === 'sales' ? '매출계약' : '계약'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${label}_${localToday()}.xlsx`
      // Firefox는 anchor가 DOM에 있어야 다운로드되고, 같은 tick에 revoke하면 진행 중 다운로드가 취소된다.
      document.body.appendChild(a)
      a.click()
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url) }, 0)
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },

  // 갱신 관리: 통보기한에 들어왔거나 만료된 기간 계약 (for: 'sales'|'purchase')
  async getUpcomingRenewals(forKind) {
    try { return await req(`/contracts/renewals/upcoming${forKind ? `?for=${forKind}` : ''}`) } catch { return [] }
  },
  // 갱신 처리: result='renew'면 다음 기간으로 연장(+금액 변경), 'close'면 미갱신 종료
  async renewContract(id, data) {
    try { const r = await req(`/contracts/${id}/renew`, { method: 'POST', body: data }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  // 정기형 계약 → 계약의 주기·금액·기간으로 정기청구 걸기
  async addContractRecurring(id, accountId) {
    try { const r = await req(`/contracts/${id}/recurring`, { method: 'POST', body: { account_id: accountId || null } }); return { ok: true, id: r.id } }
    catch (e) { return { ok: false, error: e.message } }
  },
  // 계약에 걸린 정기 반복(매출=정기청구 / 매입=정기지출)을 계약 조건에 다시 맞춘다.
  // 계약이 원본이므로, 어긋나면 계약 쪽으로 되돌리는 게 맞다.
  async syncContractRecurring(id) {
    try { const r = await req(`/contracts/${id}/recurring/sync`, { method: 'PATCH' }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  // 계약에 걸린 정기 반복 중지/재개 (매출·매입 모두 계약 화면에서)
  async toggleContractRecurring(contractId, recId) {
    try { const r = await req(`/contracts/${contractId}/recurring/${recId}/toggle`, { method: 'PATCH' }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },

  // 청구 예정인 정기청구 회차(아직 청구서 미생성) — 발행 예정 목록에 계약 청구일정과 함께 뜬다
  async getPendingRecurring() {
    try { return await req('/recurring-invoices/pending') } catch { return [] }
  },
  // 정기청구 회차 1건 발행 (paid=true면 기입금 처리까지)
  async issueRecurring(recurringId, { due, paid = false, account_id } = {}) {
    try { const r = await req(`/recurring-invoices/${recurringId}/issue`, { method: 'POST', body: { due, paid, account_id } }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },

  // 발행 예정(대기) 청구 일정 (for: 'sales'|'purchase')
  async getPendingSchedules(forKind) {
    try { return await req(`/contracts/schedule/pending${forKind ? `?for=${forKind}` : ''}`) } catch { return [] }
  },
  // 청구 일정 → 청구서 발행(원자적). paid=true면 기입금(거래+매칭까지 생성)
  async issueSchedule(milestoneId, { paid = false, date, account_id } = {}) {
    try { const r = await req(`/contracts/schedule/${milestoneId}/issue`, { method: 'POST', body: { paid, date, account_id } }); return { ok: true, id: r.id, invoice_no: r.invoice_no } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async updateMilestoneStatus(id, status) {
    try { await req(`/contracts/milestones/${id}/status`, { method: 'PATCH', body: { status } }); return { ok: true } } catch (e) { return { ok: false, error: e.message } }
  },

  async addMilestones(id, milestones) {
    try {
      await req(`/contracts/${id}/milestones`, { method: 'POST', body: { milestones } })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async updateCostBudget(id, budget) {
    try {
      await req(`/contracts/${id}/cost-budget`, { method: 'PUT', body: budget })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },

  // ─── 거래처 ───────────────────────────────────────────────────
  // 기본은 사용중인 거래처만. all:true 는 기준정보 관리 화면처럼 미사용까지 봐야 할 때만.
  async getVendors({ gubu, all } = {}) {
    try {
      const q = new URLSearchParams()
      if (gubu) q.set('gubu', gubu)
      if (all) q.set('all', '1')
      const params = q.toString() ? `?${q}` : ''
      return await req(`/vendors${params}`)
    } catch { return [] }
  },

  async setVendorActive(id, active) {
    try {
      await req(`/vendors/${id}/active`, { method: 'PATCH', body: { active } })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async addVendor(data) {
    try {
      const result = await req('/vendors', { method: 'POST', body: data })
      return { ok: true, id: result.id }
    } catch(e) { return { ok: false, error: e.message } }
  },

  async updateVendor(id, data) {
    try {
      await req(`/vendors/${id}`, { method: 'PUT', body: data })
      return { ok: true }
    } catch(e) { return { ok: false } }
  },

  async deleteVendor(id) {
    try {
      await req(`/vendors/${id}`, { method: 'DELETE' })
      return { ok: true }
    } catch(e) { return { ok: false, error: e.message } }   // 실패 사유(FK 409)를 화면까지 전달
  },

  // ─── 거래처 엑셀 임포트 ────────────────────────────────────────
  parseVendorExcel(file) { return postImportFile('/vendors/import/parse', file) },

  async commitVendorImport(items) {
    try {
      const r = await req('/vendors/import/commit', { method: 'POST', body: { items } })
      return { ok: true, ...r }
    } catch (e) { return { ok: false, error: e.message } }
  },

  // ─── 기준정보(품목·자산·적요) 엑셀 임포트 ──────────────────────
  parseRefItemExcel(file) { return postImportFile('/ref-items/import/parse', file) },

  async commitRefItemImport(type, items) {
    try {
      const r = await req('/ref-items/import/commit', { method: 'POST', body: { type, items } })
      return { ok: true, ...r }
    } catch (e) { return { ok: false, error: e.message } }
  },

  // ─── 홈택스 세금계산서 엑셀 임포트(→ 청구서) ───────────────────
  parseTaxInvoiceExcel(file) { return postImportFile('/invoices/import/parse', file) },

  async commitTaxInvoiceImport(items, { registerItems = false } = {}) {
    try {
      const r = await req('/invoices/import/commit', { method: 'POST', body: { items, registerItems } })
      return { ok: true, ...r }
    } catch (e) { return { ok: false, error: e.message } }
  },

  // ─── 재무관리 (차입금·투자) ─────────────────────────────────────
  // 대출 원금·투자금은 손익이 아니라 부채·자본이다 → 매출 집계에 잡히지 않는다(server/lib/pnl.js)
  async getLoans() {
    try { return await req('/finance/loans') } catch { return [] }
  },
  async getLoan(id) {
    try { return await req(`/finance/loans/${id}`) } catch { return null }
  },
  /** 등록 전 상환 스케줄 미리보기 — 총 이자를 그 자리에서 보여준다(저장 없음) */
  async previewLoan(data) {
    try { return await req('/finance/loans/preview', { method: 'POST', body: data }) }
    catch { return { schedule: [], totals: null } }
  },
  async addLoan(data) {
    try { const r = await req('/finance/loans', { method: 'POST', body: data }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async updateLoan(id, data) {
    try { await req(`/finance/loans/${id}`, { method: 'PUT', body: data }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async deleteLoan(id) {
    try { await req(`/finance/loans/${id}`, { method: 'DELETE' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  /** 상환 처리 — 원금·이자를 각각 다른 거래로 만든다(원금은 부채, 이자는 비용) */
  async repayLoan(id, { seq, date, account_id } = {}) {
    try { const r = await req(`/finance/loans/${id}/repay`, { method: 'POST', body: { seq, date, account_id } }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  /** 놓친 상환 일괄 처리 — 예정일이 지난 회차를 순서대로 모두. 각 회차는 그 예정일로 기록된다 */
  async repayMissedLoan(id, { account_id } = {}) {
    try { const r = await req(`/finance/loans/${id}/repay-missed`, { method: 'POST', body: { account_id } }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async cancelRepayment(id, seq) {
    try { await req(`/finance/loans/${id}/repay/${seq}`, { method: 'DELETE' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async getInvestments() {
    try { return await req('/finance/investments') } catch { return [] }
  },
  async addInvestment(data) {
    try { const r = await req('/finance/investments', { method: 'POST', body: data }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async deleteInvestment(id) {
    try { await req(`/finance/investments/${id}`, { method: 'DELETE' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async getFinanceSummary() {
    try { return await req('/finance/summary') } catch { return null }
  },

  // ─── 예금·적금 (자금 운용) ────────────────────────────────────
  async getSavings() {
    try { return await req('/savings') } catch { return [] }
  },
  async getSavingsOne(id) {
    try { return await req(`/savings/${id}`) } catch { return null }
  },
  /** 저장 전 만기 미리보기 — 이자·수령액을 가입 전에 보여준다 */
  async previewSavings(params) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString()
    try { return await req(`/savings/preview?${qs}`) } catch { return null }
  },
  async addSavings(data) {
    try { const r = await req('/savings', { method: 'POST', body: data }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async updateSavings(id, data) {
    try { await req(`/savings/${id}`, { method: 'PUT', body: data }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async deleteSavings(id) {
    try { await req(`/savings/${id}`, { method: 'DELETE' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async paySavings(id, body) {
    try { const r = await req(`/savings/${id}/pay`, { method: 'POST', body }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async paySavingsMissed(id, body) {
    try { const r = await req(`/savings/${id}/pay-missed`, { method: 'POST', body }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async matureSavings(id, body) {
    try { const r = await req(`/savings/${id}/mature`, { method: 'POST', body }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
  },

  // ─── 자금일보 · 일계표 ────────────────────────────────────────
  async getCashReport({ date, days } = {}) {
    const qs = new URLSearchParams(Object.entries({ date, days }).filter(([, v]) => v)).toString()
    try { return await req('/dashboard/cash-report' + (qs ? `?${qs}` : '')) } catch { return null }
  },
  /** 홈 요약 — 자금일보의 앞부분만 가볍게 */
  async getCashSummary() {
    try { return await req('/dashboard') } catch { return null }
  },
  async getDailyTrial(date) {
    try { return await req('/dashboard/daily-trial' + (date ? `?date=${date}` : '')) } catch { return null }
  },

  // ─── HR 코드 (부서/직급) ──────────────────────────────────────
  async getHrCodes(type) {
    try { return await req(`/hr-codes${type ? `?type=${type}` : ''}`) } catch { return [] }
  },
  async addHrCode(type, name) {
    try { return await req('/hr-codes', { method: 'POST', body: { type, name } }) } catch { return { ok: false } }
  },
  async deleteHrCode(id) {
    try { await req(`/hr-codes/${id}`, { method: 'DELETE' }); return { ok: true } } catch { return { ok: false } }
  },

  // 기준정보 범용(적요·품목·보험·고정자산·무형자산)
  async getRefItems(type) {
    try { return await req(`/ref-items${type ? `?type=${type}` : ''}`) } catch { return [] }
  },
  async addRefItem(data) {
    try { const r = await req('/ref-items', { method: 'POST', body: data }); return { ok: true, id: r.id } } catch (e) { return { ok: false, error: e.message } }
  },
  async updateRefItem(id, data) {
    try { await req(`/ref-items/${id}`, { method: 'PUT', body: data }); return { ok: true } } catch (e) { return { ok: false, error: e.message } }
  },
  async deleteRefItem(id) {
    try { await req(`/ref-items/${id}`, { method: 'DELETE' }); return { ok: true } } catch { return { ok: false } }
  },

  // 부가세(세무관리) — 분기별 신고 집계+상태 (Docs의 getVatSummary(quarter)와 별개)
  // 월 마감(기간 잠금) — 잠근 달의 거래는 등록·수정·삭제가 막힌다
  async getClosings() {
    try { return await req('/closings') } catch { return [] }
  },
  async closePeriod(period, memo) {
    try { await req('/closings', { method: 'POST', body: { period, memo } }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async reopenPeriod(period) {
    try { await req(`/closings/${period}`, { method: 'DELETE' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async getVatFilings(year) {
    try { return await req(`/tax/vat?year=${year}`) } catch { return { year, quarters: [] } }
  },
  async saveVatFiling(data) {
    try { await req('/tax/vat', { method: 'PUT', body: data }); return { ok: true } } catch (e) { return { ok: false, error: e.message } }
  },
  async getOtherTaxes() {
    try { return await req('/tax/others') } catch { return [] }
  },
  async addOtherTax(data) {
    try { const r = await req('/tax/others', { method: 'POST', body: data }); return { ok: true, id: r.id } } catch (e) { return { ok: false, error: e.message } }
  },
  async updateOtherTax(id, data) {
    try { await req(`/tax/others/${id}`, { method: 'PUT', body: data }); return { ok: true } } catch (e) { return { ok: false, error: e.message } }
  },
  async deleteOtherTax(id) {
    try { await req(`/tax/others/${id}`, { method: 'DELETE' }); return { ok: true } } catch (e) { return { ok: false, error: e.message } }
  },

  // ─── 임직원 ───────────────────────────────────────────────────
  async getEmployees() {
    try { return (await req('/employees')).map(adaptEmployee) } catch { return [] }
  },
  /** 드롭다운용 최소 목록 — 이름을 고르는 데 필요한 것만.
   *  전체 목록은 급여·생년월일·급여계좌까지 담고 있어 인사 권한이 필요하다. */
  async getEmployeeOptions() {
    try { return (await req('/employees/options')).map(adaptEmployee) } catch { return [] }
  },
  async addEmployee(data) {
    try { return await req('/employees', { method: 'POST', body: data }) } catch { return { ok: false } }
  },
  async deleteEmployee(id) {
    try { await req(`/employees/${id}`, { method: 'DELETE' }); return { ok: true } } catch { return { ok: false } }
  },

  async updateEmployee(id, data) {
    try {
      await req(`/employees/${id}`, { method: 'PUT', body: data })
      return { ok: true }
    } catch { return { ok: false } }
  },

  async getCategories({ type } = {}) {
    try {
      const params = type ? `?type=${type}` : ''
      return await req(`/categories${params}`)
    } catch { return [] }
  },

  // 표준 계정과목(읽기 전용). postableOnly=true 면 거래 입력용(집계 제외).
  async getAccountSubjects({ postableOnly = false } = {}) {
    try {
      return await req(`/account-subjects${postableOnly ? '?postable=1' : ''}`)
    } catch { return [] }
  },

  async addCategory(data) {
    try {
      const result = await req('/categories', { method: 'POST', body: data })
      return { ok: true, id: result.id }
    } catch(e) { return { ok: false, error: e.message } }
  },

  async updateCategory(id, data) {
    try {
      await req(`/categories/${id}`, { method: 'PUT', body: data })
      return { ok: true }
    } catch(e) { return { ok: false } }
  },

  async deleteCategory(id) {
    try {
      await req(`/categories/${id}`, { method: 'DELETE' })
      return { ok: true }
    } catch(e) { return { ok: false } }
  },

  async getUsers() {
    try { return await req('/auth/users') } catch { return [] }
  },

  async addUser(data) {
    try {
      const result = await req('/auth/users', { method: 'POST', body: data })
      return { ok: true, id: result.id }
    } catch(e) { return { ok: false, error: e.message } }
  },

  async updateUserPassword(id, password) {
    try {
      // 본인이 임시 비번을 바꾸면 서버가 mustChangePw를 뗀 새 토큰을 준다 → 저장해 게이트를 푼다
      const r = await req(`/auth/users/${id}/password`, { method: 'PUT', body: { password } })
      if (r && r.token) localStorage.setItem('token', r.token)
      return { ok: true }
    } catch(e) { return { ok: false, error: e.message } }
  },

  async setUserActive(id, active) {
    try {
      await req(`/auth/users/${id}/active`, { method: 'PATCH', body: { active } })
      return { ok: true }
    } catch(e) { return { ok: false, error: e.message } }
  },

  async setUserRole(id, role) {
    try {
      await req(`/auth/users/${id}/role`, { method: 'PATCH', body: { role } })
      return { ok: true }
    } catch(e) { return { ok: false, error: e.message } }
  },

  // ─── 역할(권한 묶음) ──────────────────────────────────────────
  /** 역할 목록. 실패를 []로 삼키면 화면이 "역할이 없어요"로 그려져
   *  서버 장애가 '역할 미설정'으로 보인다 → 사유를 그대로 올려보낸다. */
  async getRoles() {
    return await req('/auth/roles')
  },

  /** 사용자의 역할을 통째로 지정한다(부분 추가·삭제가 아니라 전체 교체) */
  async setUserRoles(id, roleIds) {
    try {
      await req(`/auth/users/${id}/roles`, { method: 'PUT', body: { roleIds } })
      return { ok: true }
    } catch(e) { return { ok: false, error: e.message } }
  },

  // ─── 급여대장 ─────────────────────────────────────────────────
  async getPayroll(month, scope) {
    const qs = new URLSearchParams(Object.entries({ month, scope }).filter(([, v]) => v)).toString()
    try { return await req('/payroll' + (qs ? `?${qs}` : '')) } catch { return [] }
  },
  async getPayrollSummary(month) {
    try { return await req('/payroll/summary' + (month ? `?month=${month}` : '')) } catch { return null }
  },
  async getPayrollByEmployee(id) {
    try { return await req('/payroll/employee/' + id) } catch { return null }
  },
  async savePayslip(data) {
    try { return await req('/payroll', { method: 'POST', body: data }) } catch (e) { return { ok: false, error: e.message } }
  },
  // payDate 를 주면 전원이 그 날짜로 고정된다. 비워두면 서버가 근로계약의 pay_day 를 쓴다.
  async generatePayroll(month, payDate) {
    try { return await req('/payroll/generate', { method: 'POST', body: { month, pay_date: payDate || null } }) } catch (e) { return { ok: false, error: e.message } }
  },
  async payPayroll(id, data) {
    try { return await req(`/payroll/${id}/pay`, { method: 'POST', body: data }) } catch (e) { return { ok: false, error: e.message } }
  },
  async deletePayrollPayment(id, txnId) {
    try { await req(`/payroll/${id}/pay/${txnId}`, { method: 'DELETE' }); return { ok: true } } catch { return { ok: false } }
  },
  async deletePayslip(id) {
    // 지급 이력이 있으면 서버가 409 + 안내를 준다. 사유를 버리면 화면이 이유를 못 보여준다.
    try { await req('/payroll/' + id, { method: 'DELETE' }); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  },
  async clearPayrollMonth(month) {
    try { const r = await req('/payroll/month/' + month, { method: 'DELETE' }); return { ok: true, deleted: r.deleted } }
    catch (e) { return { ok: false, error: e.message } }
  },

  // 급여 항목 마스터(지급/공제 표준 목록)
  async getPayrollItemTypes(kind) {
    try { return await req('/payroll-items' + (kind ? `?kind=${kind}` : '')) } catch { return [] }
  },
  async addPayrollItemType(data) {
    try { return await req('/payroll-items', { method: 'POST', body: data }) } catch (e) { return { ok: false, error: e.message } }
  },
  async updatePayrollItemType(id, data) {
    try { return await req('/payroll-items/' + id, { method: 'PUT', body: data }) } catch (e) { return { ok: false, error: e.message } }
  },
  async deletePayrollItemType(id) {
    try { await req('/payroll-items/' + id, { method: 'DELETE' }); return { ok: true } } catch { return { ok: false } }
  },

  // 고용형태 마스터 (근로·용역계약 유형)
  async getEmployTypes(kind) {
    try { return await req('/employ-types' + (kind ? `?kind=${kind}` : '')) } catch { return [] }
  },
  async addEmployType(data) {
    try { return await req('/employ-types', { method: 'POST', body: data }) } catch (e) { return { ok: false, error: e.message } }
  },
  async updateEmployType(id, data) {
    try { return await req('/employ-types/' + id, { method: 'PUT', body: data }) } catch (e) { return { ok: false, error: e.message } }
  },
  async deleteEmployType(id) {
    try { await req('/employ-types/' + id, { method: 'DELETE' }); return { ok: true } } catch { return { ok: false } }
  },

  // 근로·용역 계약
  async getWorkContracts(params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString()
    try { return await req('/work-contracts' + (qs ? `?${qs}` : '')) } catch { return [] }
  },
  async getWorkContract(id) {
    try { return await req('/work-contracts/' + id) } catch { return null }
  },
  async saveWorkContract(data) {
    const path = data.id ? '/work-contracts/' + data.id : '/work-contracts'
    try { return await req(path, { method: data.id ? 'PUT' : 'POST', body: data }) } catch (e) { return { ok: false, error: e.message } }
  },
  async duplicateWorkContract(id, data = {}) {
    try { return await req(`/work-contracts/${id}/duplicate`, { method: 'POST', body: data }) } catch (e) { return { ok: false, error: e.message } }
  },
  async deleteWorkContract(id) {
    try { await req('/work-contracts/' + id, { method: 'DELETE' }); return { ok: true } } catch { return { ok: false } }
  },
  async payWorkContract(id, data) {
    // code 도 같이 넘긴다 — 중복 지급('duplicate')이면 화면이 확인을 받고 force 로 다시 부른다.
    try { return await req(`/work-contracts/${id}/pay`, { method: 'POST', body: data }) }
    catch (e) { return { ok: false, error: e.message, code: e.code || '' } }
  },
  async addWorkContractDoc(id, data) {
    try { return await req(`/work-contracts/${id}/docs`, { method: 'POST', body: data }) } catch (e) { return { ok: false, error: e.message } }
  },
  async deleteWorkContractDoc(docId) {
    try { await req('/work-contracts/docs/' + docId, { method: 'DELETE' }); return { ok: true } } catch { return { ok: false } }
  },
  async getConversionAlerts() {
    try { return await req('/work-contracts/alerts/conversion') } catch { return [] }
  },

  // ─── 경영 도우미(범용 집계) ───────────────────────────────────
  async getAnalytics(spec = {}) {
    const qs = new URLSearchParams(Object.entries(spec).filter(([, v]) => v != null && v !== '')).toString()
    try { return await req('/analytics/aggregate' + (qs ? `?${qs}` : '')) } catch { return { rows: [], total: 0 } }
  },

  // ─── 경영 도우미(대화·세션) ───────────────────────────────────
  async getChats() { try { return await req('/analytics/chats') } catch { return [] } },
  async createChat(title) { return req('/analytics/chats', { method: 'POST', body: { title } }) },
  async renameChat(id, title) { return req(`/analytics/chats/${id}`, { method: 'PATCH', body: { title } }) },
  async deleteChat(id) { return req(`/analytics/chats/${id}`, { method: 'DELETE' }) },
  async getChatItems(chatId) { try { return await req(`/analytics/chats/${chatId}/items`) } catch { return [] } },
  async addChatItem(chatId, spec) { return req(`/analytics/chats/${chatId}/items`, { method: 'POST', body: { spec } }) },
  async refreshChatItem(itemId) { return req(`/analytics/chat-items/${itemId}/refresh`, { method: 'POST' }) },
  async deleteChatItem(itemId) { return req(`/analytics/chat-items/${itemId}`, { method: 'DELETE' }) },

  // ─── 홈 대시보드 ──────────────────────────────────────────────
  async getHomeStats() {
    const [arSum, apSum] = await Promise.all([
      this.getReceivablesSummary(),
      this.getPayablesSummary(),
    ])
    const invs = await this.getInvoices({ kind: 'received', status: '지급 대기' })
    const month = localMonth()
    const monthOut = invs.filter(i => (i.dueAt || '').startsWith(month))
      .reduce((s, i) => s + i.remainAmount, 0)
    const monthOutCount = invs.filter(i => (i.dueAt || '').startsWith(month)).length
    return [
      { id: "ar",  label: "미수금",            amount: arSum.total,  sub: `미입금 ${arSum.count}건`,    delta: 0 },
      { id: "ap",  label: "미지급금",          amount: apSum.total,  sub: `미지급 ${apSum.count}건`,    delta: 0 },
      { id: "iex", label: "이번 달 입금 예정", amount: 0,            sub: "계약 등록 후 확인 가능",      delta: 0 },
      { id: "oex", label: "이번 달 지급 예정", amount: monthOut,     sub: `예정 ${monthOutCount}건`,    delta: 0 },
    ]
  },

  async getMonthCashFlow() {
    try {
      const month = localMonth()
      const [inInvs, outInvs] = await Promise.all([
        this.getInvoices({ kind: 'issued' }),
        this.getInvoices({ kind: 'received' }),
      ])
      const IN_PENDING  = new Set(['입금 예정', '일부 입금'])
      const OUT_PENDING = new Set(['지급 대기', '지급 예정'])
      const inRows  = inInvs.filter(i  => IN_PENDING.has(i.status)  && (i.dueAt || '').startsWith(month))
      const outRows = outInvs.filter(i => OUT_PENDING.has(i.status) && (i.dueAt || '').startsWith(month))
      const inTotal  = inRows.reduce((s, i)  => s + i.remainAmount, 0)
      const outTotal = outRows.reduce((s, i) => s + i.remainAmount, 0)
      return { month, inTotal, inCount: inRows.length, outTotal, outCount: outRows.length, net: inTotal - outTotal }
    } catch { return null }
  },

  async getHomeTodos() {
    try {
      const [rec, pay] = await Promise.all([this.getReceivables(), this.getPayables()])
      const won = (n) => (n || 0).toLocaleString() + '원'
      const todos = []
      ;(rec.rows || [])
        .filter(r => ['입금 예정', '일부 입금', '기한 지남', '장기 미수'].includes(r.status))
        .slice(0, 6)
        .forEach(r => todos.push({
          id: 'ar-' + r.id, kind: 'ar', invoiceId: r.id,
          tag: r.delay > 0 ? `${r.delay}일 초과` : '입금 예정',
          title: r.vendor, sub: [won(r.remain), r.contract].filter(Boolean).join(' · '),
          amount: r.remain, action: '입금 처리',
        }))
      ;(pay.rows || [])
        .filter(r => ['지급 예정', '지급 대기', '기한 지남'].includes(r.pay))
        .slice(0, 6)
        .forEach(r => todos.push({
          id: 'ap-' + r.id, kind: 'ap', invoiceId: r.id,
          tag: r.pay === '기한 지남' ? '지급 기한 지남' : '지급 예정',
          title: r.vendor, sub: [won(r.amount), r.category].filter(Boolean).join(' · '),
          amount: r.amount, action: '이체',
        }))
      return todos
    } catch { return [] }
  },
  // completeTodo 는 아무것도 하지 않는 스텁이었다. 홈에서 그걸 부르고 '입금이 처리되었어요'를
  // 띄우고 있어, 실제로는 거래가 하나도 안 남았는데 사용자는 처리된 줄 알았다.
  // 할 일은 청구서 상태에서 파생되므로 별도 완료 표시가 필요 없다 — 정산하면 목록에서 빠진다.

  async getAlerts() {
    const invs = await this.getInvoices()
    const overdueRec = invs.filter(i => i.kind === 'issued' && ['기한 지남', '장기 미수'].includes(i.status))
    const overdueAp  = invs.filter(i => i.kind === 'received' && i.status === '기한 지남')
    const alerts = []
    if (overdueRec.length > 0) alerts.push({ kind: 'neg',  title: '연체 미수금',     count: overdueRec.length, desc: '발주처 결제 기한이 지난 납품 건이 있습니다.',    to: 'ar' })
    if (overdueAp.length > 0)  alerts.push({ kind: 'neg',  title: '지급 지연 외주비', count: overdueAp.length,  desc: '협력사 외주가공비 지급일이 경과했습니다.',        to: 'ap' })
    return alerts
  },

  // ─── 우측 상단 알림 벨: 실데이터 집계 ──────────────────────────
  async getNotifications() {
    const won = (n) => (Number(n) || 0).toLocaleString('ko-KR') + '원'
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const dleft = (due) => {
      if (!due) return null
      const d = new Date(due); d.setHours(0, 0, 0, 0)
      return Math.round((d - today) / 86400000)
    }
    let rec = { rows: [] }, pay = { rows: [] }
    try { [rec, pay] = await Promise.all([this.getReceivables(), this.getPayables()]) } catch { /* noop */ }
    const PAY_PENDING = new Set(['지급 대기', '지급 예정', '일부 지급', '기한 지남'])
    const items = []
    // 미수금: 마감일이 지났으면(상태 라벨 무관) 연체, 7일 내면 임박, 그 외 일부입금은 잔액 회수
    rec.rows.forEach(r => {
      const d = dleft(r.due)
      if (r.delay > 0) {
        items.push({ tone: 'neg', icon: 'Warn', to: 'ar', sortKey: 0,
          title: `${r.vendor} 미수금이 ${r.delay}일 연체되었습니다`,
          sub: `${r.contract || '거래'} · ${won(r.remain)}`, when: `${r.delay}일 연체` })
      } else if (d !== null && d <= 7) {
        items.push({ tone: 'outline', icon: 'Clock', to: 'ar', sortKey: 3,
          title: `${r.vendor} 입금 예정`, sub: `${r.contract || '거래'} · ${won(r.remain)}`, when: d === 0 ? '오늘' : `D-${d}` })
      } else if (r.status === '일부 입금') {
        items.push({ tone: 'warn', icon: 'Bell', to: 'ar', sortKey: 2,
          title: `${r.vendor} 일부 입금 — 잔액 회수 필요`, sub: `잔액 ${won(r.remain)}`, when: '' })
      }
    })
    // 미지급금: 마감일이 지났으면 지급 지연, 7일 내면 지급 예정 임박
    pay.rows.filter(r => PAY_PENDING.has(r.pay)).forEach(r => {
      const d = dleft(r.due)
      if (r.delay > 0) {
        items.push({ tone: 'neg', icon: 'Warn', to: 'ap', sortKey: 1,
          title: `${r.vendor} 지급 기한이 ${r.delay}일 지났습니다`,
          sub: `${r.scope} · ${won(r.amount)}`, when: `${r.delay}일 경과` })
      } else if (d !== null && d <= 7) {
        items.push({ tone: 'warn', icon: 'Bell', to: 'ap', sortKey: 2,
          title: `${r.vendor} 지급 예정`, sub: `${won(r.amount)} · ${r.scope}`, when: d === 0 ? '오늘' : `D-${d}` })
      }
    })
    // 계약 갱신: 통보기한에 들어온 기간 계약 + 종료일이 지났는데 처리 안 된 계약
    let renewals = []
    try { renewals = await this.getUpcomingRenewals() } catch { /* noop */ }
    renewals.forEach(r => {
      const auto = r.term_mode === 'auto_renew'
      const d = Number(r.days_left)
      const to = (r.gubu === 'A' || r.gubu === 'E') ? 'contract_purchase' : 'contract_sales'
      if (d < 0) {
        items.push({ tone: 'neg', icon: 'Warn', to, sortKey: 0,
          title: `${r.vendor_name || '거래처'} 계약이 만료됐는데 ${auto ? '연장 입력이 안 됐습니다' : '갱신되지 않았습니다'}`,
          sub: `${r.name} · 종료일 ${r.end_date}`, when: `${-d}일 경과` })
      } else {
        items.push({ tone: d <= 14 ? 'neg' : 'warn', icon: 'Clock', to, sortKey: d <= 14 ? 1 : 2,
          title: `${r.vendor_name || '거래처'} 계약 ${auto ? '자동갱신 예정' : '갱신 필요'}`,
          sub: `${r.name} · 종료일 ${r.end_date}`, when: d === 0 ? '오늘 만료' : `D-${d}` })
      }
    })
    items.sort((a, b) => a.sortKey - b.sortKey)
    return items.slice(0, 15)
  },

  // ─── Ctrl+K 명령 팔레트: 실데이터 검색 인덱스 ──────────────────
  async getCommandIndex() {
    const won = (n) => (Number(n) || 0).toLocaleString('ko-KR') + '원'
    let vendors = [], contracts = [], invoices = []
    try { [vendors, contracts, invoices] = await Promise.all([this.getVendors(), this.getContracts(), this.getInvoices()]) } catch { /* noop */ }
    const cmds = []
    contracts.forEach(c => cmds.push({
      kind: '계약', label: c.name || '(이름 없음)',
      sub: [c.vendor_name, c.amount ? won(c.amount) : null].filter(Boolean).join(' · '),
      route: 'contract_detail', contractId: c.id, contractName: c.name,
    }))
    vendors.forEach(v => cmds.push({
      kind: '거래처', label: v.name,
      sub: [v.gubu === 'B' ? '발주처' : v.gubu === 'E' ? '기관' : '매입처', v.type].filter(Boolean).join(' · '),
      // 거래처를 고르면 **거래처 화면**으로 간다. 예전엔 'contract'(계약)로 보내서,
      // 거래처를 검색해 눌렀는데 엉뚱하게 계약 목록이 열렸다.
      route: 'master_vendor',
    }))
    invoices.forEach(i => cmds.push({
      kind: i.kind === 'issued' ? '청구서' : '매입',
      label: i.invoiceNo, sub: [i.vendor, won(i.totalAmount)].filter(Boolean).join(' · '),
      route: i.kind === 'issued' ? 'billing_issued' : 'billing_received',
    }))
    /* 메뉴 전체를 색인한다.
     *
     * 예전엔 미수금·미지급금·엑셀 3개만 있었다. 화면이 44개인데 3개만 검색되니
     * "보험이 어디 있지" 하고 Ctrl+K 를 눌러도 아무것도 안 나온다 —
     * 처음 쓰는 사람일수록 사이드바에서 찾기 어려운데 검색도 안 되는 상태였다.
     *
     * 태그(LEAF_TAGS)를 함께 실어, 메뉴명이 아니라 **업무에서 쓰는 말**로도 찾게 한다:
     *   '세금계산서' → 대금 청구서 / '인사' → 인사관리 / '통장' → 계좌·카드 */
    for (const l of ALL_LEAVES) {
      cmds.push({
        kind: '메뉴', label: l.label,
        sub: [l.domain, l.section].filter(Boolean).join(' › '),
        keywords: LEAF_TAGS[l.id] || '',
        route: l.id,
      })
    }
    cmds.push({ kind: '메뉴', label: '엑셀 업로드', sub: '', keywords: '엑셀 일괄 업로드 임포트 가져오기', route: 'excel' })
    return cmds
  },

  async getUpcomingIn({ limit = 5 } = {}) {
    const invs = await this.getInvoices({ kind: 'issued' })
    const PENDING = new Set(['입금 예정', '일부 입금', '기한 지남', '장기 미수'])
    return invs
      .filter(i => PENDING.has(i.status))
      .sort((a, b) => { if (!a.dueAt) return 1; if (!b.dueAt) return -1; return a.dueAt.localeCompare(b.dueAt) })
      .slice(0, limit)
      .map(i => ({ vendor: i.vendor, contract: i.contract, type: i.status, amount: i.remainAmount, due: i.dueAt || '' }))
  },

  async getUpcomingOut({ limit = 5 } = {}) {
    const invs = await this.getInvoices({ kind: 'received' })
    const PENDING = new Set(['지급 대기', '지급 예정', '일부 지급', '기한 지남'])
    return invs
      .filter(i => PENDING.has(i.status))
      .sort((a, b) => { if (!a.dueAt) return 1; if (!b.dueAt) return -1; return a.dueAt.localeCompare(b.dueAt) })
      .slice(0, limit)
      .map(i => ({ vendor: i.vendor, note: i.contract || i.memo, amount: i.remainAmount, due: i.dueAt || '' }))
  },

  // ─── 미수금/미지급금 목록 ─────────────────────────────────────
  async getReceivables() {
    const invs  = await this.getInvoices({ kind: 'issued' })
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const month = localMonth()
    const PENDING = new Set(['입금 예정', '일부 입금', '기한 지남', '장기 미수'])
    const rows = invs
      .filter(i => PENDING.has(i.status))
      .map(i => {
        const due = i.dueAt ? new Date(i.dueAt) : null
        if (due) due.setHours(0, 0, 0, 0)
        const delay = due ? Math.max(0, Math.round((today - due) / 86400000)) : 0
        // 마감일 경과 시 자동 전이(미납분만; '일부 입금'은 해당 탭 유지): 90일↑ 장기미수, 그 외 기한지남
        const eff = (i.status === '입금 예정' && delay > 90) ? '장기 미수'
                  : (i.status === '입금 예정' && delay > 0)  ? '기한 지남'
                  : i.status
        return { id: i.id, vendor: i.vendor, contract: i.contract,
                 billed: i.totalAmount, paid: i.paidAmount, remain: i.remainAmount,
                 due: i.dueAt || '', delay, status: eff }
      })
      .sort((a, b) => { if (!a.due) return 1; if (!b.due) return -1; return a.due.localeCompare(b.due) })
    const total       = rows.reduce((s, r) => s + r.remain, 0)
    const thisMonth   = rows.filter(r => r.due.startsWith(month)).reduce((s, r) => s + r.remain, 0)
    const overdue     = rows.filter(r => r.status === '기한 지남').reduce((s, r) => s + r.remain, 0)
    const longOverdue = rows.filter(r => r.status === '장기 미수').reduce((s, r) => s + r.remain, 0)
    return {
      summary: {
        total, thisMonth, overdue, longOverdue,
        count: rows.length,
        thisMonthCount: rows.filter(r => r.due.startsWith(month)).length,
        overdueCount: rows.filter(r => r.status === '기한 지남').length,
        longOverdueCount: rows.filter(r => r.status === '장기 미수').length,
      },
      rows,
    }
  },

  async getPayables() {
    const invs  = await this.getInvoices({ kind: 'received' })
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const month = localMonth()
    const PENDING = ['지급 대기', '지급 예정', '일부 지급', '기한 지남']
    const rows = invs
      .map(i => {
        const due = i.dueAt ? new Date(i.dueAt) : null
        if (due) due.setHours(0, 0, 0, 0)
        const delay = due ? Math.max(0, Math.round((today - due) / 86400000)) : 0
        const eff = ((i.status === '지급 예정' || i.status === '지급 대기') && delay > 0) ? '기한 지남' : i.status
        return { id: i.id, vendor: i.vendor, scope: i.contract || i.memo || '—',
                 category: i.category || '—', amount: i.remainAmount,
                 due: i.dueAt || '', delay, doc: i.doc || '승인 완료', pay: eff }
      })
      .sort((a, b) => { if (!a.due) return 1; if (!b.due) return -1; return a.due.localeCompare(b.due) })
    const pendingRows = rows.filter(r => PENDING.includes(r.pay))
    const total       = pendingRows.reduce((s, r) => s + r.amount, 0)
    const thisMonth   = pendingRows.filter(r => r.due.startsWith(month)).reduce((s, r) => s + r.amount, 0)
    const overdue     = pendingRows.filter(r => r.pay === '기한 지남').reduce((s, r) => s + r.amount, 0)
    return {
      summary: {
        total, thisMonth,
        thisMonthCount: pendingRows.filter(r => r.due.startsWith(month)).length,
        overdue, pendingApproval: 0,
        count: pendingRows.length,
        overdueCount: pendingRows.filter(r => r.pay === '기한 지남').length,
        pendingCount: 0,
      },
      rows,
    }
  },
}
