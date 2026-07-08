/**
 * API layer — Express/SQLite 서버 전용 (localhost:3001)
 * 서버가 꺼져 있으면 빈 배열/null 반환 (mock 없음)
 */

const BASE = '/api'

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
    account: row.account_name || '',
    scope: row.contract_name || row.memo || row.doc_no || '—',
    category: row.category || '—',
    subCategory: row.sub_category,
    amount: row.amount,
    method: row.method,
    status: row.status,
    accountId: row.account_id,
    buyerType: row.buyer_type,
    vesselNo: row.vessel_no,
    usagePlace: row.usage_place,
    invoiceId: row.invoice_id,
    docNo: row.doc_no,
    evid_url: row.evid_url || '',
    evid_type: row.evid_type || '',
    docs: buildTxnDocs(row),
    evid: (row.docs && row.docs.length > 0) || !!(row.evid_url || row.evid_type),
    memo: row.memo || '',
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
    status: row.active ? '재직' : '퇴직',
    baseSalary: row.base_salary || 0,
    account: '—',
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
        body: { amount, reason, date: new Date().toISOString().slice(0, 10), created_by: by },
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
      const thisYear = new Date().getFullYear()
      params.set('from', from || `${thisYear}-01-01`)
      if (to) params.set('to', to)
      return (await req(`/invoices?${params}`)).map(adaptInvoice)
    } catch { return [] }
  },

  async getReceivablesSummary() {
    try {
      const data = await req('/invoices/summary/receivables')
      return { total: data.summary.total, count: data.summary.count, overdueAmount: data.summary.overdue, overdueCount: 0 }
    } catch { return { total: 0, count: 0, overdueAmount: 0, overdueCount: 0 } }
  },

  async getPayablesSummary() {
    try {
      const data = await req('/invoices/summary/payables')
      return { total: data.summary.total, count: data.summary.count, overdueAmount: data.summary.overdue, overdueCount: 0 }
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
    } catch { return { ok: false } }
  },

  async updateInvoice(id, data) {
    try {
      await req(`/invoices/${id}`, { method: 'PUT', body: data })
      return { ok: true }
    } catch { return { ok: false } }
  },

  async deleteInvoice(id) {
    try {
      await req(`/invoices/${id}`, { method: 'DELETE' })
      return { ok: true }
    } catch { return { ok: false } }
  },

  async getMatchable(invoiceId) {
    try { return await req(`/invoices/${invoiceId}/matchable`) } catch { return [] }
  },

  async matchInvoice(invoiceId, { txnId, amount, date }) {
    try {
      await req(`/invoices/${invoiceId}/matches`, { method: 'POST', body: { txn_id: txnId, amount, date } })
      return { ok: true }
    } catch { return { ok: false } }
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
    } catch { return { ok: false } }
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

  async commitImport(items) {
    try {
      const r = await req('/transactions/import/commit', { method: 'POST', body: { items } })
      return { ok: true, ...r }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async updateTransaction(id, data) {
    try {
      await req(`/transactions/${id}`, { method: 'PUT', body: data })
      return { ok: true }
    } catch { return { ok: false } }
  },

  async updateTransactionStatus(id, status) {
    try {
      await req(`/transactions/${id}/status`, { method: 'PATCH', body: { status } })
      return { ok: true }
    } catch { return { ok: false } }
  },

  async deleteTransaction(id) {
    try {
      await req(`/transactions/${id}`, { method: 'DELETE' })
      return { ok: true }
    } catch { return { ok: false } }
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
        category: r.category,
        amount: r.amount,
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

  async addRecurringExpense(data) {
    try {
      const result = await req('/recurring-expenses', { method: 'POST', body: {
        vendor_id: data.vendorId,
        category: data.category,
        amount: data.amount,
        period: data.period,
        day_of_month: data.dayOfMonth,
        start_date: data.startDate,
        end_date: data.endDate,
        account_id: data.accountId,
      }})
      return { ok: true, id: result.id }
    } catch { return { ok: false } }
  },

  async toggleRecurringExpense(id) {
    try {
      const result = await req(`/recurring-expenses/${id}/toggle`, { method: 'PATCH', body: {} })
      return { ok: true, active: result.active }
    } catch { return { ok: false } }
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

  async addContract(data) {
    try {
      const result = await req('/contracts', { method: 'POST', body: data })
      return { ok: true, id: result.id }
    } catch (e) { return { ok: false, error: e.message } }
  },

  async updateContract(id, data) {
    try {
      await req(`/contracts/${id}`, { method: 'PUT', body: data })
      return { ok: true }
    } catch (e) { return { ok: false, error: e.message } }
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
  async getVendors({ gubu } = {}) {
    try {
      const params = gubu ? `?gubu=${gubu}` : ''
      return await req(`/vendors${params}`)
    } catch { return [] }
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
    } catch(e) { return { ok: false } }
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

  // 부가세(세무관리)
  async getVatSummary(year) {
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
      await req(`/auth/users/${id}/password`, { method: 'PUT', body: { password } })
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
  async getPayroll(month) {
    try { return await req('/payroll' + (month ? `?month=${month}` : '')) } catch { return [] }
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
  async generatePayroll(month, payDate) {
    try { return await req('/payroll/generate', { method: 'POST', body: { month, pay_date: payDate } }) } catch (e) { return { ok: false, error: e.message } }
  },
  async payPayroll(id, data) {
    try { return await req(`/payroll/${id}/pay`, { method: 'POST', body: data }) } catch (e) { return { ok: false, error: e.message } }
  },
  async deletePayrollPayment(id, txnId) {
    try { await req(`/payroll/${id}/pay/${txnId}`, { method: 'DELETE' }); return { ok: true } } catch { return { ok: false } }
  },
  async deletePayslip(id) {
    try { await req('/payroll/' + id, { method: 'DELETE' }); return { ok: true } } catch { return { ok: false } }
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

  // ─── 홈 대시보드 ──────────────────────────────────────────────
  async getHomeStats() {
    const [arSum, apSum] = await Promise.all([
      this.getReceivablesSummary(),
      this.getPayablesSummary(),
    ])
    const invs = await this.getInvoices({ kind: 'received', status: '지급 대기' })
    const month = new Date().toISOString().slice(0, 7)
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
      const month = new Date().toISOString().slice(0, 7)
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

  async getHomeTodos() { return [] },

  async completeTodo() { return { ok: true } },

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
    const month = new Date().toISOString().slice(0, 7)
    const PENDING = new Set(['입금 예정', '일부 입금', '기한 지남', '장기 미수'])
    const rows = invs
      .filter(i => PENDING.has(i.status))
      .map(i => {
        const due = i.dueAt ? new Date(i.dueAt) : null
        if (due) due.setHours(0, 0, 0, 0)
        const delay = due ? Math.max(0, Math.round((today - due) / 86400000)) : 0
        return { id: i.id, vendor: i.vendor, contract: i.contract,
                 billed: i.totalAmount, paid: i.paidAmount, remain: i.remainAmount,
                 due: i.dueAt || '', delay, status: i.status }
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
    const month = new Date().toISOString().slice(0, 7)
    const PENDING = ['지급 대기', '지급 예정', '일부 지급', '기한 지남']
    const rows = invs
      .map(i => {
        const due = i.dueAt ? new Date(i.dueAt) : null
        if (due) due.setHours(0, 0, 0, 0)
        const delay = due ? Math.max(0, Math.round((today - due) / 86400000)) : 0
        return { id: i.id, vendor: i.vendor, scope: i.contract || i.memo || '—',
                 category: i.category || '—', amount: i.remainAmount,
                 due: i.dueAt || '', delay, doc: i.doc || '승인 완료', pay: i.status }
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
