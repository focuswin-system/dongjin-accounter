/**
 * API layer — Express/SQLite 서버 전용 (localhost:3001)
 * 서버가 꺼져 있으면 빈 배열/null 반환 (mock 없음)
 */

const BASE = '/api'

// 오늘 / 이번 달 — 로컬(KST) 기준. new Date().toISOString()은 UTC라 KST 00~09시에
// 하루 전 날짜가 나온다(월 경계에선 전월). 서버 kstToday()와 짝을 맞춘다.
const localToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const localMonth = () => localToday().slice(0, 7)

async function req(path, opts = {}) {
  const token = localStorage.getItem('token')
  const res = await fetch(BASE + path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (res.status === 401) {
    localStorage.removeItem('token')
    localStorage.removeItem('loggedIn')
    localStorage.removeItem('user')
    window.location.reload()
    throw new Error('인증이 만료되었습니다')
  }
  if (!res.ok) {
    let msg = `API ${path} → ${res.status}`
    try { const body = await res.json(); if (body?.error) msg = body.error } catch { /* 본문 없음 */ }
    throw new Error(msg)
  }
  return res.json()
}

// 서버 응답 → 컴포넌트 형식 변환
function adaptAccount(row) {
  return {
    id: row.id,
    name: row.name,
    bankName: row.bank,
    type: row.type,
    initialBalance: row.initial_balance,
    currentBalance: row.balance ?? row.initial_balance,
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
    issuedAt: row.issued_at,
    dueAt: row.due_at || null,
    status: row.status,
    accountId: row.account_id,
    matches: (row.matches || []).map(m => ({ txnId: m.txn_id, amount: m.amount, matchedAt: m.matched_at })),
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
    } catch { return { ok: false } }
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
  // 지급 예정인 정기지출 회차(아직 매입 청구서 미생성) — 매입 대금청구서 '지급 예정'에 계약 지급일정과 함께
  async getPendingRecurringExpenses() {
    try { return await req('/recurring-expenses/pending') } catch { return [] }
  },
  // 정기지출 회차 1건을 매입 청구서(미지급금)로 등록. paid=true면 지급 처리까지
  async issueRecurringExpense(recurringId, { due, paid = false, account_id } = {}) {
    try { const r = await req(`/recurring-expenses/${recurringId}/issue`, { method: 'POST', body: { due, paid, account_id } }); return { ok: true, ...r } }
    catch (e) { return { ok: false, error: e.message } }
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

  async generateRecurringInvoices() {
    try {
      const result = await req('/recurring-invoices/generate', { method: 'POST', body: {} })
      return { ok: true, count: result.count, generated: result.generated }
    } catch { return { ok: false, count: 0 } }
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
  async parseVendorExcel(file) {
    const fd = new FormData()
    fd.append('file', file)
    const token = localStorage.getItem('token')
    const res = await fetch(`${BASE}/vendors/import/parse`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    })
    if (!res.ok) throw new Error('엑셀 파싱에 실패했어요')
    return res.json() // { headers, rows }
  },

  async commitVendorImport(items) {
    try {
      const r = await req('/vendors/import/commit', { method: 'POST', body: { items } })
      return { ok: true, ...r }
    } catch (e) { return { ok: false, error: e.message } }
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
    try { await req(`/tax/others/${id}`, { method: 'DELETE' }); return { ok: true } } catch { return { ok: false } }
  },

  // ─── 임직원 ───────────────────────────────────────────────────
  async getEmployees() {
    try { return (await req('/employees')).map(adaptEmployee) } catch { return [] }
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
    try { return await req(`/work-contracts/${id}/pay`, { method: 'POST', body: data }) } catch (e) { return { ok: false, error: e.message } }
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
        .slice(0, 4)
        .forEach(r => todos.push({
          id: 'ar-' + r.id, kind: 'ar', invoiceId: r.id,
          tag: r.delay > 0 ? `${r.delay}일 초과` : '입금 예정',
          title: `${r.vendor} 입금 확인`, sub: `${r.contract || ''} ${won(r.remain)}`.trim(), action: '입금 처리',
        }))
      ;(pay.rows || [])
        .filter(r => ['지급 예정', '지급 대기', '기한 지남'].includes(r.pay))
        .slice(0, 4)
        .forEach(r => todos.push({
          id: 'ap-' + r.id, kind: 'ap', invoiceId: r.id, tag: '지급 예정',
          title: `${r.vendor} 이체`, sub: `${r.category || ''} ${won(r.amount)}`.trim(), action: '이체',
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
      route: 'contract',
    }))
    invoices.forEach(i => cmds.push({
      kind: i.kind === 'issued' ? '청구서' : '매입',
      label: i.invoiceNo, sub: [i.vendor, won(i.totalAmount)].filter(Boolean).join(' · '),
      route: i.kind === 'issued' ? 'billing_issued' : 'billing_received',
    }))
    // 자주 쓰는 메뉴 단축
    cmds.push({ kind: '메뉴', label: '미수금 관리', sub: '', route: 'ar' })
    cmds.push({ kind: '메뉴', label: '미지급금 관리', sub: '', route: 'ap' })
    cmds.push({ kind: '메뉴', label: '엑셀 업로드', sub: '', route: 'excel' })
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
