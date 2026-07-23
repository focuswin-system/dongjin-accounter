import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Drawer, Combobox, StatusBadge, localToday } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DataTable } from '../lib/components/DataTable'
import { FileAttach } from '../lib/FileAttach'
import { api } from '../lib/api'
import { computeItems, monthLabel } from './HR'

/* 근로·용역·일용 계약 화면.
 * 근로계약(hr_labor_contract)과 기타 용역·일용(hr_outsourcing)이 같은 work_contracts를 쓰되
 * kind로 갈린다. 급여 기준(labor)은 pay_items, 용역·일용 단가는 work_contract_items.
 * 인사관리 급여대장이 이 계약을 소스로 명세서·지급을 만든다. */

const asNum = (v) => parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10) || 0
const KIND_LABEL = { labor: '근로', service: '용역', daily: '일용' }
const INCOME_LABEL = { 근로: '근로소득', 일용: '일용근로', 사업: '사업소득', 기타: '기타소득' }
const FORM_LABEL = { annual: '연봉', monthly: '월급', hourly: '시급', daily: '일당', piece: '건당' }
const TERM_LABEL = { fixed: '기간 만료', auto_renew: '자동 갱신', open: '무기한' }
const insBadges = (c) => ['insure_np', 'insure_hi', 'insure_ei', 'insure_ai']
  .map((k, i) => c[k] ? ['국민', '건강', '고용', '산재'][i] : null).filter(Boolean).join('·') || '—'
const won = (n) => fmtNum(n) + '원'

// ── 급여 기준(pay_items) 편집기 — 근로계약 전용. PayslipEditorDrawer와 같은 UI. ──
const PayItemsEditor = ({ items, setItems, masters }) => {
  const { calc, gross, deduction, net } = computeItems(items)
  const update = (idx, patch) => setItems(items.map((it, i) => i === idx ? { ...it, ...patch } : it))
  const addItem = (kind) => setItems([...items, { label: '', kind, mode: 'fixed', value: 0 }])
  const removeItem = (idx) => setItems(items.filter((_, i) => i !== idx))
  const addMaster = (id) => {
    const m = masters.find(x => x.id === id); if (!m) return
    setItems([...items, { label: m.label, kind: m.kind, mode: m.mode, value: Number(m.default_value) || 0 }])
  }
  const renderItems = (kind) => (
    <div className="col gap-8">
      {items.map((it, idx) => it.kind === kind && (
        <div key={idx} className="row gap-6" style={{ alignItems: 'center' }}>
          <input className="input" style={{ flex: 1, padding: '8px 10px', fontSize: 13 }} value={it.label}
            placeholder={kind === 'earn' ? '지급 항목명' : '공제 항목명'}
            onChange={e => update(idx, { label: e.target.value })}/>
          <div className="row gap-2" style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 2 }}>
            {[['fixed', '원'], ['percent', '%']].map(([m, lbl]) => (
              <button key={m} type="button" onClick={() => update(idx, { mode: m })}
                className={`chip ${it.mode === m ? 'active' : ''}`} style={{ padding: '4px 9px', fontSize: 12 }}>{lbl}</button>
            ))}
          </div>
          <div style={{ position: 'relative', width: 130 }}>
            <input className="input num fw-700" style={{ padding: '8px 26px 8px 10px', fontSize: 13 }}
              value={it.mode === 'percent' ? it.value : fmtNum(it.value)}
              onChange={e => {
                const raw = e.target.value.replace(/[^0-9.]/g, '')
                update(idx, { value: it.mode === 'percent' ? raw : (parseInt(raw.replace(/\./g, '')) || 0) })
              }}/>
            <span style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 11 }}>{it.mode === 'percent' ? '%' : '원'}</span>
          </div>
          <div className="num text-sm text-muted" style={{ width: 88, textAlign: 'right' }}>
            {kind === 'deduct' ? '-' : ''}{fmtNum(calc[idx]?.amount || 0)}
          </div>
          <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => removeItem(idx)}><Icon.Close size={13}/></button>
        </div>
      ))}
      <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => addItem(kind)}><Icon.Plus size={12}/> {kind === 'earn' ? '지급 항목 추가' : '공제 항목 추가'}</button>
    </div>
  )
  return (
    <div>
      <div className="card" style={{ padding: 14, background: 'var(--surface-2)', border: '1px solid var(--line)', marginBottom: 16 }}>
        <div className="row">
          <div>
            <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 4 }}>월 실수령(기준)</div>
            <div className="num fw-700" style={{ fontSize: 22 }}>{fmtNum(net)}<span className="text-muted" style={{ fontWeight: 400, fontSize: 13, marginLeft: 3 }}>원</span></div>
          </div>
          <div className="ml-auto text-sm" style={{ textAlign: 'right' }}>
            <div className="text-muted">지급 합계 <b className="text-ink">{fmtNum(gross)}</b></div>
            <div className="text-muted">공제 합계 <b className="text-warn">-{fmtNum(deduction)}</b></div>
          </div>
        </div>
      </div>
      <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 10 }}>지급 항목</div>
      <div style={{ marginBottom: 20 }}>{renderItems('earn')}</div>
      <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 10 }}>공제 항목 <span style={{ fontWeight: 400 }}>· %는 지급 고정금액 합계 기준</span></div>
      <div style={{ marginBottom: 14 }}>{renderItems('deduct')}</div>
      {masters.length > 0 && (
        <div className="row gap-8" style={{ alignItems: 'center', maxWidth: 380 }}>
          <span className="text-xs text-muted2 fw-600" style={{ whiteSpace: 'nowrap' }}>표준 항목에서 추가</span>
          <div style={{ flex: 1 }}>
            <Combobox value="" onChange={addMaster}
              options={masters.map(m => ({ value: m.id, label: `${m.kind === 'earn' ? '+ ' : '− '}${m.label}`, sub: m.mode === 'percent' ? `${Number(m.default_value)}%` : '금액' }))}
              placeholder="설정에 등록한 항목 불러오기"/>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 용역·일용 단가표 편집기 (ContractItemsEditor와 같은 방식) ──
const RateItemsEditor = ({ items, setItems, itemMaster, reloadMaster, defaultUnit }) => {
  const add = () => setItems([...items, { item_id: '', name: '', spec: '', unit: defaultUnit || '', unit_price: '' }])
  const upd = (i, patch) => setItems(items.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  const del = (i) => setItems(items.filter((_, idx) => idx !== i))
  const pick = (i, name) => {
    const it = itemMaster.find(x => x.name === name)
    upd(i, it ? { item_id: it.id, name: it.name, spec: it.spec || '', unit: it.unit || defaultUnit || '', unit_price: String(it.amount || '') } : { item_id: '', name })
  }
  const addNew = async (i, name) => {
    const nm = (name || '').trim(); if (!nm) return
    const res = await api.addRefItem({ type: 'item', name: nm })
    await reloadMaster(); upd(i, { item_id: res.id || '', name: nm })
  }
  return (
    <div>
      <div className="text-xs text-muted2" style={{ marginBottom: 10 }}>
        업무(품목)와 단가를 등록하세요. 지급은 상세의 <b>지급 등록</b>에서 수량을 넣어 발행합니다.
      </div>
      <div className="col gap-8">
        {items.map((r, i) => (
          <div key={i} className="col gap-6" style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 10, background: 'var(--surface-2)' }}>
            <div className="row gap-6" style={{ alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Combobox value={r.name} onChange={v => pick(i, v)} onAddNew={q => addNew(i, q)}
                  options={itemMaster.map(it => ({ value: it.name, label: it.name, sub: [it.unit, it.amount ? fmtNum(it.amount) + '원' : ''].filter(Boolean).join(' · ') }))}
                  addNewLabel="새 업무·품목 등록" placeholder="업무 선택·검색"/>
              </div>
              <button type="button" className="icon-btn" onClick={() => del(i)}><Icon.Close size={14}/></button>
            </div>
            <div className="row gap-6">
              <input className="input" style={{ flex: 1, minWidth: 0 }} value={r.spec || ''} placeholder="비고"
                onChange={e => upd(i, { spec: e.target.value })}/>
              <input className="input" style={{ width: 72 }} value={r.unit || ''} placeholder="단위"
                onChange={e => upd(i, { unit: e.target.value })}/>
              <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                <input className="input num fw-700" style={{ paddingRight: 26 }} value={fmtNum(asNum(r.unit_price))} placeholder="단가"
                  onChange={e => upd(i, { unit_price: asNum(e.target.value) })}/>
                <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 12 }}>원</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="btn ghost sm" style={{ marginTop: 10 }} onClick={add}><Icon.Plus size={13}/> 업무 추가</button>
    </div>
  )
}

// ── 지급명세 인쇄 (income_type로 양식 분기) ──
export function printWorkPayslip(p, contract, company = '') {
  // 저장된 items는 {label,kind,mode,value}뿐 — 금액(amount)은 computeItems로 산출한다
  // (percent 항목도 올바르게 계산되도록). i.amount를 바로 읽으면 전부 0으로 찍힌다.
  const { calc } = computeItems(Array.isArray(p.items) ? p.items : [])
  const earns = calc.filter(i => i.kind === 'earn')
  const deds = calc.filter(i => i.kind === 'deduct')
  const income = contract.income_type || '사업'
  const title = income === '일용' ? '일용근로 지급명세서' : income === '기타' ? '기타소득 지급명세서' : '용역비 지급명세서'
  // 이름·업무명에 <, &, " 등이 들어가도 인쇄 레이아웃이 깨지지 않게 이스케이프한다.
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const row = (label, amt, neg) => `<tr><td>${esc(label)}</td><td class="num">${neg ? '-' : ''}${fmtNum(amt)}</td></tr>`
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>
      @page { size:A4; margin:16mm }
      body { font-family:'Malgun Gothic',sans-serif; color:#111; font-size:13px }
      h1 { font-size:20px; text-align:center; margin:0 0 4px }
      .sub { text-align:center; color:#666; margin-bottom:20px }
      table { width:100%; border-collapse:collapse; margin-bottom:16px }
      th,td { border:1px solid #ccc; padding:7px 10px; text-align:left }
      th { background:#f4f4f5; width:130px }
      .num { text-align:right; font-variant-numeric:tabular-nums }
      .sec { font-weight:700; margin:14px 0 6px }
      .total { font-size:16px; font-weight:700 }
    </style></head><body>
    <h1>${title}</h1>
    <div class="sub">${esc(company)}</div>
    <table>
      <tr><th>성명</th><td>${esc(p.employee_name || contract.employee_name)}</td><th>소득구분</th><td>${INCOME_LABEL[income] || income}</td></tr>
      <tr><th>계약</th><td>${esc(contract.title)}</td><th>귀속월</th><td>${monthLabel(p.month)}</td></tr>
      <tr><th>지급일</th><td>${esc(p.pay_date)}</td><th>고용형태</th><td>${esc(contract.employ_type)}</td></tr>
    </table>
    <div class="sec">지급 내역</div>
    <table><thead><tr><th style="width:auto">항목</th><th class="num" style="width:140px">금액(원)</th></tr></thead>
      <tbody>${earns.map(i => row(i.label, i.amount)).join('')}</tbody></table>
    ${deds.length ? `<div class="sec">공제 내역</div>
    <table><thead><tr><th style="width:auto">항목</th><th class="num" style="width:140px">금액(원)</th></tr></thead>
      <tbody>${deds.map(i => row(i.label, i.amount, true)).join('')}</tbody></table>` : ''}
    <table><tr><th class="total">차인지급액</th><td class="num total">${fmtNum(p.net_salary)}</td></tr></table>
    </body></html>`
  const iframe = document.createElement('iframe')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  iframe.srcdoc = html
  const cleanup = () => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe) }
  iframe.onload = () => {
    try {
      const w = iframe.contentWindow
      w.onafterprint = cleanup
      w.focus(); w.print()
    } catch (e) {}
  }
  document.body.appendChild(iframe)
  setTimeout(cleanup, 60000)   // onafterprint를 못 받는 브라우저 대비 백스톱
}

/* ═══════════════ 근로계약 화면 ═══════════════ */
export const LaborContractScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState([])
  const [filter, setFilter] = useState('active')  // active | all
  const [drawer, setDrawer] = useState(null)       // { mode:'new'|'edit', id? }
  const [detail, setDetail] = useState(null)       // contract id

  const load = () => api.getWorkContracts({ kind: 'labor' }).then(setRows)
  useEffect(() => { load() }, [])

  const list = rows.filter(r => filter === 'all' || (r.emp_status !== '퇴사' && r.status === '진행중'))

  return (
    <div className="fade-up">
      <PageHeader
        title="근로계약"
        sub="직원 근로계약과 급여 기준을 관리하세요. 급여대장은 여기 등록된 계약을 바탕으로 만들어집니다."
        actions={<button className="btn primary" onClick={() => setDrawer({ mode: 'new' })}><Icon.Plus/> 직원 등록</button>}
      />

      <div className="card" style={{ overflow: 'hidden', marginTop: 16 }}>
        <div className="row" style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', gap: 8 }}>
          <div className="row gap-4">
            {[['active', '재직'], ['all', '전체']].map(([k, lbl]) => (
              <button key={k} className={`chip ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{lbl}</button>
            ))}
          </div>
          <div className="ml-auto text-sm text-muted2">{list.length}명</div>
        </div>
        <DataTable
          rows={list}
          onRowClick={r => setDetail(r.id)}
          empty="근로계약이 없어요. 직원을 등록하세요."
          columns={[
            { key: 'emp_no', header: '사번', sortable: true, render: r => <span className="num text-muted text-sm">{r.emp_no || '—'}</span> },
            { key: 'employee_name', header: '이름', sortable: true, render: r => <span className="fw-700">{r.employee_name}</span> },
            { key: 'department', header: '부서', render: r => <span className="text-sm">{r.department || '—'}</span> },
            { key: 'employ_type', header: '고용형태', render: r => <span className="text-sm">{r.employ_type || '—'}</span> },
            { key: 'term', header: '계약기간', render: r => <span className="text-sm text-muted">{r.start_date || '—'}{r.end_date ? ` ~ ${r.end_date}` : (r.term_mode === 'open' ? ' ~ (무기한)' : '')}</span> },
            { key: 'monthly_net', header: '월 기준급여', align: 'right', sortable: true, render: r => <span className="num-cell">{won(r.monthly_net || 0)}</span> },
            { key: 'ins', header: '4대보험', render: r => <span className="text-xs text-muted">{insBadges(r)}</span> },
            { key: 'status', header: '상태', render: r => <StatusBadge status={r.emp_status === '퇴사' ? '퇴사' : r.status}/> },
            { key: 'action', header: '', render: r => <button className="btn ghost sm" onClick={e => { e.stopPropagation(); setDrawer({ mode: 'edit', id: r.id }) }}>편집</button> },
          ]}
        />
      </div>

      {drawer && <LaborDrawer info={drawer} onClose={() => setDrawer(null)} onSaved={() => { setDrawer(null); load() }}/>}
      {detail && <LaborDetailDrawer id={detail} onClose={() => setDetail(null)} onChanged={load}
        onNewContract={(empId) => { setDetail(null); setDrawer({ mode: 'new', employeeId: empId }) }}/>}
    </div>
  )
}

// 직원 + 근로계약 등록/편집 Drawer
const LaborDrawer = ({ info, onClose, onSaved }) => {
  const toast = useToast()
  const [employTypes, setEmployTypes] = useState([])
  const [masters, setMasters] = useState([])
  const [depts, setDepts] = useState([])
  const [positions, setPositions] = useState([])
  const [form, setForm] = useState({
    name: '', department: '', role: '', birth_date: '', start_date: '', end_date: '',
    employ_type_id: '', employ_type: '', term_mode: 'open', pay_form: 'monthly', work_hours: '', pay_day: 25,
    insure_np: 1, insure_hi: 1, insure_ei: 1, insure_ai: 1, title: '',
  })
  const [items, setItems] = useState([])
  const editing = info.mode === 'edit'

  useEffect(() => {
    api.getEmployTypes('labor').then(setEmployTypes)
    api.getPayrollItemTypes().then(setMasters)
    api.getHrCodes('dept').then(setDepts)
    api.getHrCodes('pos').then(setPositions)
  }, [])

  // 편집: 계약을 한 번만 로드해 폼에 채운다. masters 로딩과 분리해야 편집 중 재조회로
  // 사용자가 방금 바꾼 값이 덮어써지지 않는다(masters.length를 deps에 넣으면 클로버).
  useEffect(() => {
    if (!editing || !info.id) return
    api.getWorkContract(info.id).then(c => {
      if (!c) return
      setForm(f => ({ ...f, name: c.employee_name, department: c.department === '—' ? '' : c.department,
        role: c.role || '', birth_date: c.birth_date || '', start_date: c.start_date || '', end_date: c.end_date || '',
        employ_type_id: c.employ_type_id || '', employ_type: c.employ_type || '', term_mode: c.term_mode || 'open',
        pay_form: c.pay_form || 'monthly', work_hours: c.work_hours || '', pay_day: c.pay_day || 25,
        insure_np: c.insure_np, insure_hi: c.insure_hi, insure_ei: c.insure_ei, insure_ai: c.insure_ai,
        title: c.title || '', employee_id: c.employee_id }))
      setItems((c.pay_items || []).map(i => ({ ...i })))
    })
  }, [info, editing])

  // 신규: 표준 급여 항목으로 초기화(금액 0). masters가 늦게 로드돼도 최초 한 번만.
  useEffect(() => {
    if (editing || !masters.length || items.length > 0) return
    setItems(masters.map(m => ({ label: m.label, kind: m.kind, mode: m.mode, value: Number(m.default_value) || 0 })))
  }, [editing, masters.length])

  const pickType = (id) => {
    const t = employTypes.find(x => x.id === id)
    if (!t) return setForm(f => ({ ...f, employ_type_id: '', employ_type: '' }))
    setForm(f => ({ ...f, employ_type_id: t.id, employ_type: t.label, pay_form: t.pay_form,
      insure_np: t.insure_np, insure_hi: t.insure_hi, insure_ei: t.insure_ei, insure_ai: t.insure_ai }))
  }

  const save = async () => {
    if (!form.name.trim()) return toast.push('이름을 입력해주세요')
    const body = {
      kind: 'labor', income_type: '근로', title: form.title || `${form.name} 근로계약`,
      employ_type_id: form.employ_type_id || null, employ_type: form.employ_type || null,
      start_date: form.start_date || null, end_date: form.term_mode === 'open' ? null : (form.end_date || null),
      term_mode: form.term_mode, pay_form: form.pay_form, work_hours: form.work_hours || null, pay_day: form.pay_day,
      pay_items: items, insure_np: form.insure_np, insure_hi: form.insure_hi, insure_ei: form.insure_ei, insure_ai: form.insure_ai,
    }
    if (editing) { body.id = info.id; body.employee_id = form.employee_id }
    else if (info.employeeId) body.employee_id = info.employeeId
    else body.employee = { name: form.name, department: form.department, role: form.role, birth_date: form.birth_date, join_date: form.start_date }
    const res = await api.saveWorkContract(body)
    // 편집 시 직원 인적정보도 갱신
    if (res.ok && editing && form.employee_id) {
      await api.updateEmployee(form.employee_id, { name: form.name, department: form.department, role: form.role, birth_date: form.birth_date || null, status: '재직' })
    }
    if (res.ok) { toast.push(editing ? '계약을 저장했어요' : '직원·계약을 등록했어요'); onSaved() }
    else toast.push(res.error || '저장에 실패했어요')
  }

  const chip = (val, cur, on, label) => (
    <button type="button" className={`chip ${cur === val ? 'active' : ''}`} onClick={on}>{label}</button>
  )

  return (
    <Drawer open={true} onClose={onClose} width="min(640px, 100vw)">
      <div className="drawer-head">
        <div>
          <div className="fw-700" style={{ fontSize: 16 }}>{editing ? `${form.name} 근로계약` : (info.employeeId ? '새 근로계약' : '직원 등록')}</div>
          <div className="text-xs text-muted">인적 정보와 근로계약·급여 기준을 입력하세요.</div>
        </div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>

      <div className="drawer-body">
        {!info.employeeId && (
          <>
            <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 12 }}>인적 정보</div>
            <div className="col gap-form" style={{ marginBottom: 24 }}>
              <Field label="이름" required><input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="홍길동"/></Field>
              <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <Field label="부서">
                  <Combobox value={form.department} onChange={v => setForm(f => ({ ...f, department: v }))}
                    options={depts.map(d => ({ value: d.name, label: d.name }))} placeholder="부서 선택"
                    onAddNew={async (name) => { const r = await api.addHrCode('dept', name); if (r.ok) { setDepts(await api.getHrCodes('dept')); setForm(f => ({ ...f, department: name })) } }} addNewLabel="부서로 추가"/>
                </Field>
                <Field label="직위">
                  <Combobox value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))}
                    options={positions.map(p => ({ value: p.name, label: p.name }))} placeholder="직위 선택"
                    onAddNew={async (name) => { const r = await api.addHrCode('pos', name); if (r.ok) { setPositions(await api.getHrCodes('pos')); setForm(f => ({ ...f, role: name })) } }} addNewLabel="직위로 추가"/>
                </Field>
              </div>
              <Field label="생년월일" hint="급여명세서 표기용"><input className="input num" type="date" value={form.birth_date} onChange={e => setForm(f => ({ ...f, birth_date: e.target.value }))}/></Field>
            </div>
          </>
        )}

        <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 12 }}>계약 정보</div>
        <div className="col gap-form" style={{ marginBottom: 24 }}>
          <Field label="고용형태">
            <Combobox value={form.employ_type_id} onChange={pickType}
              options={employTypes.map(t => ({ value: t.id, label: t.label, sub: FORM_LABEL[t.pay_form] }))} placeholder="고용형태 선택"/>
          </Field>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="계약 시작"><input className="input num" type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}/></Field>
            <Field label="종료 방식">
              <div className="row gap-4">
                {Object.entries(TERM_LABEL).map(([k, lbl]) => chip(k, form.term_mode, () => setForm(f => ({ ...f, term_mode: k })), lbl))}
              </div>
            </Field>
          </div>
          {form.term_mode !== 'open' && (
            <Field label="계약 종료"><input className="input num" type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}/></Field>
          )}
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="소정근로시간" hint="예: 주 40시간"><input className="input" value={form.work_hours} onChange={e => setForm(f => ({ ...f, work_hours: e.target.value }))} placeholder="주 40시간 / 09:00~18:00"/></Field>
            <Field label="급여 지급일"><input className="input num" type="number" min="1" max="31" value={form.pay_day} onChange={e => setForm(f => ({ ...f, pay_day: parseInt(e.target.value) || 25 }))}/></Field>
          </div>
          <Field label="4대보험 적용">
            <div className="row gap-4" style={{ flexWrap: 'wrap' }}>
              {[['insure_np', '국민연금'], ['insure_hi', '건강보험'], ['insure_ei', '고용보험'], ['insure_ai', '산재보험']].map(([k, lbl]) => (
                <button key={k} type="button" className={`chip ${form[k] ? 'active' : ''}`} onClick={() => setForm(f => ({ ...f, [k]: f[k] ? 0 : 1 }))}>{form[k] ? '✓ ' : ''}{lbl}</button>
              ))}
            </div>
          </Field>
        </div>

        <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 12 }}>급여 기준 <span style={{ fontWeight: 400 }}>· 급여대장 생성 시 이 항목이 명세서에 채워져요</span></div>
        <PayItemsEditor items={items} setItems={setItems} masters={masters}/>
      </div>

      <div className="drawer-foot">
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" onClick={save}><Icon.Check size={14}/> {editing ? '저장' : '등록'}</button>
        </div>
      </div>
    </Drawer>
  )
}

// 근로계약 상세 Drawer (탭)
const LaborDetailDrawer = ({ id, onClose, onChanged, onNewContract }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [c, setC] = useState(null)
  const [tab, setTab] = useState('계약 정보')
  const [history, setHistory] = useState([])
  const [payHistory, setPayHistory] = useState(null)

  const load = () => api.getWorkContract(id).then(setC)
  useEffect(() => { load() }, [id])
  useEffect(() => {
    if (!c) return
    api.getWorkContracts({ kind: 'labor' }).then(all => setHistory(all.filter(x => x.employee_id === c.employee_id)))
    api.getPayrollByEmployee(c.employee_id).then(setPayHistory)
  }, [c?.employee_id])

  if (!c) return null
  const TABS = ['계약 정보', '급여 기준', '계약서', '계약 이력', '급여 이력', '메모']

  const doLeave = async () => {
    const ok = await confirm({ tone: 'neg', icon: <Icon.Warn size={22}/>, title: `${c.employee_name} 퇴사 처리`,
      body: '퇴사일을 오늘로 기록하고 진행 계약을 만료합니다. 급여대장 생성 대상에서 제외돼요.', confirmLabel: '퇴사 처리' })
    if (!ok) return
    const today = localToday()
    await api.updateEmployee(c.employee_id, { name: c.employee_name, status: '퇴사', leave_date: today })
    await api.saveWorkContract({ id: c.id, employee_id: c.employee_id, kind: 'labor', income_type: '근로', title: c.title,
      employ_type_id: c.employ_type_id, employ_type: c.employ_type, start_date: c.start_date, end_date: c.end_date,
      term_mode: c.term_mode, pay_form: c.pay_form, pay_day: c.pay_day, pay_items: c.pay_items, status: '만료',
      insure_np: c.insure_np, insure_hi: c.insure_hi, insure_ei: c.insure_ei, insure_ai: c.insure_ai })
    toast.push('퇴사 처리했어요'); onChanged?.(); onClose()
  }

  return (
    <Drawer open={true} onClose={onClose} width="min(680px, 100vw)">
      <div className="drawer-head">
        <div>
          <div className="fw-700" style={{ fontSize: 16 }}>{c.employee_name} <span className="text-muted" style={{ fontSize: 13, fontWeight: 400 }}>· {c.employ_type || '근로계약'}</span></div>
          <div className="text-xs text-muted">{c.emp_no || ''} · {c.department || '—'} · {c.emp_status === '퇴사' ? '퇴사' : c.status}</div>
        </div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>

      <div className="tab-bar" style={{ padding: '0 18px' }}>
        {TABS.map(t => <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>)}
      </div>

      <div className="drawer-body">
        {tab === '계약 정보' && (
          <div className="col gap-form">
            <InfoRow label="고용형태" value={c.employ_type || '—'}/>
            <InfoRow label="소득구분" value={INCOME_LABEL[c.income_type] || c.income_type}/>
            <InfoRow label="계약기간" value={`${c.start_date || '—'}${c.end_date ? ` ~ ${c.end_date}` : (c.term_mode === 'open' ? ' ~ (무기한)' : '')}`}/>
            <InfoRow label="종료방식" value={TERM_LABEL[c.term_mode]}/>
            <InfoRow label="급여형태" value={FORM_LABEL[c.pay_form] || c.pay_form}/>
            <InfoRow label="소정근로시간" value={c.work_hours || '—'}/>
            <InfoRow label="급여 지급일" value={c.pay_day ? `매월 ${c.pay_day}일` : '—'}/>
            <InfoRow label="4대보험" value={insBadges(c)}/>
            <InfoRow label="월 기준급여" value={won(computeItems(c.pay_items || []).net)}/>
          </div>
        )}
        {tab === '급여 기준' && <LaborPayItemsTab contract={c} onSaved={() => { load(); onChanged?.() }}/>}
        {tab === '계약서' && <WorkContractDocsTab contract={c} onChanged={load}/>}
        {tab === '계약 이력' && (
          <div className="col gap-8">
            <div className="text-xs text-muted2" style={{ marginBottom: 4 }}>이 직원의 근로계약 전체 (연봉 인상·재계약 시 새 계약이 쌓여요)</div>
            {history.map(h => (
              <div key={h.id} className="card" style={{ padding: 12 }}>
                <div className="row">
                  <div className="fw-700 text-sm">{h.employ_type || '근로계약'} {h.id === c.id && <span className="chip active" style={{ padding: '2px 6px', fontSize: 11, marginLeft: 4 }}>현재</span>}</div>
                  <div className="ml-auto num text-sm">{won(h.monthly_net || 0)}</div>
                </div>
                <div className="text-xs text-muted" style={{ marginTop: 4 }}>{h.start_date || '—'}{h.end_date ? ` ~ ${h.end_date}` : ''} · {h.status}</div>
              </div>
            ))}
          </div>
        )}
        {tab === '급여 이력' && (
          <div className="col gap-8">
            {(payHistory?.months || []).length === 0 && <div className="text-muted2 text-sm" style={{ padding: 20, textAlign: 'center' }}>급여 이력이 없어요.</div>}
            {(payHistory?.months || []).map(m => (
              <div key={m.id} className="row card" style={{ padding: 12 }}>
                <div className="fw-700 text-sm">{monthLabel(m.month)}</div>
                <div className="ml-auto num text-sm">{won(m.net_salary)} <span className="text-muted2" style={{ fontSize: 11 }}>{m.payStatus}</span></div>
              </div>
            ))}
          </div>
        )}
        {tab === '메모' && <WorkContractMemoTab contract={c} onSaved={load}/>}
      </div>

      <div className="drawer-foot">
        {c.emp_status !== '퇴사' && <button className="btn" style={{ color: 'var(--neg-ink)' }} onClick={doLeave}>퇴사 처리</button>}
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={() => onNewContract(c.employee_id)}><Icon.Plus size={13}/> 새 계약(연봉 인상)</button>
        </div>
      </div>
    </Drawer>
  )
}

const LaborPayItemsTab = ({ contract, onSaved }) => {
  const toast = useToast()
  const [items, setItems] = useState((contract.pay_items || []).map(i => ({ ...i })))
  const [masters, setMasters] = useState([])
  useEffect(() => { api.getPayrollItemTypes().then(setMasters) }, [])
  const save = async () => {
    // 계약 전체를 펼치고 pay_items만 덮어쓴다 — 필드를 일부만 재구성하면 work_hours·conv_alert_months·memo가 유실된다.
    const res = await api.saveWorkContract({ ...contract, id: contract.id, employee_id: contract.employee_id, pay_items: items })
    if (res.ok) { toast.push('급여 기준을 저장했어요'); onSaved?.() } else toast.push('저장에 실패했어요')
  }
  return (
    <div>
      <PayItemsEditor items={items} setItems={setItems} masters={masters}/>
      <div className="row" style={{ marginTop: 16 }}><button className="btn primary ml-auto" onClick={save}><Icon.Check size={14}/> 급여 기준 저장</button></div>
    </div>
  )
}

const WorkContractDocsTab = ({ contract, onChanged }) => {
  const [docs, setDocs] = useState(contract.attachments || [])
  const add = async (doc) => {
    const res = await api.addWorkContractDoc(contract.id, { url: doc.url, name: doc.name })
    if (res.ok) setDocs(d => [...d, { id: res.id, url: doc.url, name: doc.name }])
    onChanged?.()
  }
  const remove = async (doc) => {
    if (doc.id) await api.deleteWorkContractDoc(doc.id)
    setDocs(d => d.filter(x => x.url !== doc.url)); onChanged?.()
  }
  return <FileAttach docs={docs} onAdd={add} onRemove={remove} label="계약서를 끌어다 놓거나 클릭해서 추가" hint="근로·용역 계약서 (PDF·이미지·문서)"/>
}

const WorkContractMemoTab = ({ contract, onSaved }) => {
  const toast = useToast()
  const [memo, setMemo] = useState(contract.memo || '')
  const save = async () => {
    const res = await api.saveWorkContract({ ...contract, id: contract.id, employee_id: contract.employee_id, pay_items: contract.pay_items, items: contract.items, memo })
    if (res.ok) { toast.push('메모를 저장했어요'); onSaved?.() } else toast.push('저장에 실패했어요')
  }
  return (
    <div>
      <textarea className="input" style={{ minHeight: 160, resize: 'vertical' }} value={memo} onChange={e => setMemo(e.target.value)} placeholder="특이사항·비고"/>
      <div className="row" style={{ marginTop: 12 }}><button className="btn primary ml-auto" onClick={save}>메모 저장</button></div>
    </div>
  )
}

/* ═══════════════ 기타 용역·일용 화면 ═══════════════ */
export const OutsourcingScreen = () => {
  const [rows, setRows] = useState([])
  const [income, setIncome] = useState('all')
  const [drawer, setDrawer] = useState(null)
  const [detail, setDetail] = useState(null)
  const [alerts, setAlerts] = useState([])

  const load = () => api.getWorkContracts({ kind: 'service,daily' }).then(setRows)
  useEffect(() => { load(); api.getConversionAlerts().then(setAlerts) }, [])

  const list = rows.filter(r => income === 'all' || r.income_type === income)
  const alertIds = new Set(alerts.map(a => a.id))

  return (
    <div className="fade-up">
      <PageHeader
        title="기타 용역·일용"
        sub="용역·일용 인력의 계약과 단가를 관리하고, 지급을 등록하면 거래내역에 자동 기록됩니다."
        actions={<button className="btn primary" onClick={() => setDrawer({ mode: 'new' })}><Icon.Plus/> 인력 등록</button>}
      />

      {alerts.length > 0 && (
        <div className="alert-row" style={{ marginTop: 12, background: 'var(--warn-soft)', borderColor: 'transparent' }}>
          <Icon.Warn/>
          <div className="text-sm">
            <b>상용근로자 전환 검토</b> — {alerts.map(a => `${a.employee_name}님(${a.months}개월)`).join(', ')}이 계속 근로 중이에요. 일용이 아닌 근로계약으로 전환이 필요할 수 있어요.
          </div>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden', marginTop: 16 }}>
        <div className="row" style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', gap: 8 }}>
          <div className="row gap-4" style={{ flexWrap: 'wrap' }}>
            {[['all', '전체'], ['사업', '용역(사업)'], ['일용', '일용'], ['기타', '기타소득']].map(([k, lbl]) => (
              <button key={k} className={`chip ${income === k ? 'active' : ''}`} onClick={() => setIncome(k)}>{lbl}</button>
            ))}
          </div>
          <div className="ml-auto text-sm text-muted2">{list.length}명</div>
        </div>
        <DataTable
          rows={list}
          onRowClick={r => setDetail(r.id)}
          empty="용역·일용 인력이 없어요. 인력을 등록하세요."
          columns={[
            { key: 'employee_name', header: '성명', sortable: true, render: r => <span className="fw-700">{r.employee_name} {alertIds.has(r.id) && <span className="chip" style={{ padding: '1px 6px', fontSize: 10, color: 'var(--warn-ink)', background: 'var(--warn-soft)' }}>전환검토</span>}</span> },
            { key: 'employ_type', header: '고용형태', render: r => <span className="text-sm">{r.employ_type || '—'}</span> },
            { key: 'income_type', header: '소득구분', render: r => <span className="text-sm">{INCOME_LABEL[r.income_type] || r.income_type}</span> },
            { key: 'title', header: '업무내용', render: r => <span className="text-sm text-muted">{r.title || '—'}</span> },
            { key: 'term', header: '계약기간', render: r => <span className="text-sm text-muted">{r.start_date || '—'}{r.end_date ? ` ~ ${r.end_date}` : (r.term_mode === 'open' ? ' ~ (무기한)' : '')}</span> },
            { key: 'paid_sum', header: '누적 지급', align: 'right', sortable: true, render: r => <span className="num-cell">{won(r.paid_sum || 0)}</span> },
            { key: 'unpaid', header: '미지급', align: 'right', sortable: true, render: r => <span className="num-cell" style={{ color: r.unpaid > 0 ? 'var(--warn-ink)' : undefined }}>{won(r.unpaid || 0)}</span> },
            { key: 'action', header: '', render: r => <button className="btn ghost sm" onClick={e => { e.stopPropagation(); setDrawer({ mode: 'edit', id: r.id }) }}>편집</button> },
          ]}
        />
      </div>

      {drawer && <OutsourcingDrawer info={drawer} onClose={() => setDrawer(null)} onSaved={() => { setDrawer(null); load() }}/>}
      {detail && <OutsourcingDetailDrawer id={detail} onClose={() => setDetail(null)} onChanged={() => { load(); api.getConversionAlerts().then(setAlerts) }}
        onEdit={(cid) => { setDetail(null); setDrawer({ mode: 'edit', id: cid }) }}/>}
    </div>
  )
}

const OutsourcingDrawer = ({ info, onClose, onSaved }) => {
  const toast = useToast()
  const [employTypes, setEmployTypes] = useState([])
  const [itemMaster, setItemMaster] = useState([])
  const [form, setForm] = useState({
    name: '', title: '', kind: 'service', income_type: '사업', employ_type_id: '', employ_type: '',
    start_date: '', end_date: '', term_mode: 'fixed', pay_form: 'piece', default_unit: '건', conv_alert_months: 0,
  })
  const [items, setItems] = useState([])
  const editing = info.mode === 'edit'
  const reloadMaster = () => api.getRefItems('item').then(r => setItemMaster(r || []))

  useEffect(() => { api.getEmployTypes().then(t => setEmployTypes(t.filter(x => x.kind !== 'labor'))); reloadMaster() }, [])
  useEffect(() => {
    if (editing && info.id) api.getWorkContract(info.id).then(c => {
      if (!c) return
      setForm(f => ({ ...f, name: c.employee_name, title: c.title || '', kind: c.kind, income_type: c.income_type,
        employ_type_id: c.employ_type_id || '', employ_type: c.employ_type || '', start_date: c.start_date || '', end_date: c.end_date || '',
        term_mode: c.term_mode || 'fixed', pay_form: c.pay_form || 'piece', default_unit: '건', conv_alert_months: c.conv_alert_months || 0, employee_id: c.employee_id }))
      setItems((c.items || []).map(i => ({ ...i, unit_price: Number(i.unit_price) })))
    })
  }, [info, editing])

  const pickType = (id) => {
    const t = employTypes.find(x => x.id === id)
    if (!t) return
    setForm(f => ({ ...f, employ_type_id: t.id, employ_type: t.label, kind: t.kind, income_type: t.income_type,
      pay_form: t.pay_form, default_unit: t.default_unit || '건', conv_alert_months: t.conv_alert_months || 0 }))
  }

  const save = async () => {
    if (!form.name.trim()) return toast.push('성명을 입력해주세요')
    const body = {
      kind: form.kind, income_type: form.income_type, title: form.title,
      employ_type_id: form.employ_type_id || null, employ_type: form.employ_type || null,
      start_date: form.start_date || null, end_date: form.term_mode === 'open' ? null : (form.end_date || null),
      term_mode: form.term_mode, pay_form: form.pay_form, conv_alert_months: form.conv_alert_months, items,
    }
    if (editing) { body.id = info.id; body.employee_id = form.employee_id }
    else body.employee = { name: form.name }
    const res = await api.saveWorkContract(body)
    if (res.ok && editing && form.employee_id) await api.updateEmployee(form.employee_id, { name: form.name, status: '재직', person_kind: 'worker' })
    if (res.ok) { toast.push(editing ? '계약을 저장했어요' : '인력·계약을 등록했어요'); onSaved() }
    else toast.push(res.error || '저장에 실패했어요')
  }

  return (
    <Drawer open={true} onClose={onClose} width="min(620px, 100vw)">
      <div className="drawer-head">
        <div>
          <div className="fw-700" style={{ fontSize: 16 }}>{editing ? `${form.name} 용역계약` : '용역·일용 인력 등록'}</div>
          <div className="text-xs text-muted">고용형태를 고르면 소득구분·단가 단위가 자동으로 채워져요.</div>
        </div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>

      <div className="drawer-body">
        <div className="col gap-form" style={{ marginBottom: 22 }}>
          {!editing && <Field label="성명" required><input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="김프리"/></Field>}
          <Field label="고용형태">
            <Combobox value={form.employ_type_id} onChange={pickType}
              options={employTypes.map(t => ({ value: t.id, label: t.label, sub: `${INCOME_LABEL[t.income_type]} · ${t.default_unit || ''}` }))} placeholder="고용형태 선택"/>
          </Field>
          <Field label="업무내용"><input className="input" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="예: 외주 개발, 행사 진행"/></Field>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="소득구분">
              <div className="row gap-4" style={{ flexWrap: 'wrap' }}>
                {['사업', '일용', '기타'].map(k => (
                  <button key={k} type="button" className={`chip ${form.income_type === k ? 'active' : ''}`}
                    onClick={() => setForm(f => ({ ...f, income_type: k, kind: k === '일용' ? 'daily' : 'service' }))}>{INCOME_LABEL[k]}</button>
                ))}
              </div>
            </Field>
            <Field label="종료 방식">
              <div className="row gap-4">{Object.entries(TERM_LABEL).map(([k, lbl]) => (
                <button key={k} type="button" className={`chip ${form.term_mode === k ? 'active' : ''}`} onClick={() => setForm(f => ({ ...f, term_mode: k }))}>{lbl}</button>
              ))}</div>
            </Field>
          </div>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="계약 시작"><input className="input num" type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}/></Field>
            {form.term_mode !== 'open' && <Field label="계약 종료"><input className="input num" type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}/></Field>}
          </div>
          {form.kind === 'daily' && (
            <Field label="상용전환 경고 (개월)" hint="이 개월수 이상 계속 근로 시 알림 (건설 12)">
              <input className="input num" style={{ width: 90 }} value={form.conv_alert_months} onChange={e => setForm(f => ({ ...f, conv_alert_months: parseInt(e.target.value.replace(/[^0-9]/g, '')) || 0 }))}/>
            </Field>
          )}
        </div>

        <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 12 }}>단가표</div>
        <RateItemsEditor items={items} setItems={setItems} itemMaster={itemMaster} reloadMaster={reloadMaster} defaultUnit={form.default_unit}/>
      </div>

      <div className="drawer-foot">
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" onClick={save}><Icon.Check size={14}/> {editing ? '저장' : '등록'}</button>
        </div>
      </div>
    </Drawer>
  )
}

const OutsourcingDetailDrawer = ({ id, onClose, onChanged, onEdit }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [c, setC] = useState(null)
  const [tab, setTab] = useState('지급 내역')
  const [payDrawer, setPayDrawer] = useState(false)
  const [company, setCompany] = useState('')

  const load = () => api.getWorkContract(id).then(setC)
  useEffect(() => { load(); api.getCompany().then(x => setCompany(x?.name || '')) }, [id])
  if (!c) return null
  const TABS = ['지급 내역', '단가표', '계약서', '메모']

  const dup = async () => {
    const res = await api.duplicateWorkContract(c.id, {})
    if (res.ok) { toast.push('계약을 복제했어요'); onChanged?.() } else toast.push('복제에 실패했어요')
  }

  return (
    <>
      <Drawer open={true} onClose={onClose} width="min(720px, 100vw)">
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>{c.employee_name} <span className="text-muted" style={{ fontSize: 13, fontWeight: 400 }}>· {c.employ_type || KIND_LABEL[c.kind]}</span></div>
            <div className="text-xs text-muted">{INCOME_LABEL[c.income_type]} · {c.title || '—'}</div>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>

        <div className="row" style={{ padding: '12px 18px 0', gap: 12 }}>
          <Tile label="누적 지급" value={won(c.paid_sum || 0)} tone="brand"/>
          <Tile label="누적 발생" value={won(c.net_sum || 0)} tone="ink"/>
          <Tile label="미지급" value={won(c.unpaid || 0)} tone={c.unpaid > 0 ? 'warn' : 'ink'}/>
        </div>

        <div className="tab-bar" style={{ padding: '0 18px' }}>
          {TABS.map(t => <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>)}
        </div>

        <div className="drawer-body">
          {tab === '지급 내역' && (
            <div className="col gap-8">
              {(c.item_progress || []).length > 0 && (
                <div className="card" style={{ padding: 12, marginBottom: 8 }}>
                  <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 8 }}>업무별 누적</div>
                  {c.item_progress.map((p, i) => (
                    <div key={i} className="row text-sm" style={{ padding: '3px 0' }}>
                      <span>{p.name}</span>
                      <span className="ml-auto num text-muted">{fmtNum(p.qty_sum)}{p.unit || ''} · {won(p.amount_sum)}</span>
                    </div>
                  ))}
                </div>
              )}
              {(c.payments || []).length === 0 && <div className="text-muted2 text-sm" style={{ padding: 20, textAlign: 'center' }}>지급 내역이 없어요. 아래 <b>지급 등록</b>으로 발행하세요.</div>}
              {(c.payments || []).map(p => (
                <div key={p.id} className="card" style={{ padding: 12 }}>
                  <div className="row">
                    <div className="fw-700 text-sm">{monthLabel(p.month)} <span className="text-muted2" style={{ fontWeight: 400, fontSize: 11 }}>#{p.seq}</span></div>
                    <div className="ml-auto num text-sm">{won(p.net_salary)} <span className="text-muted2" style={{ fontSize: 11 }}>{p.payStatus}</span></div>
                  </div>
                  <div className="row" style={{ marginTop: 6 }}>
                    <div className="text-xs text-muted">지급일 {p.pay_date} · 지급 {won(p.paid)}{p.unpaid > 0 ? ` · 미지급 ${won(p.unpaid)}` : ''}</div>
                    <button className="btn ghost sm ml-auto" onClick={() => printWorkPayslip(p, c, company)}><Icon.Print size={12}/> 명세</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {tab === '단가표' && (
            <div className="col gap-8">
              {(c.items || []).length === 0 && <div className="text-muted2 text-sm" style={{ padding: 20, textAlign: 'center' }}>단가표가 없어요. 편집에서 등록하세요.</div>}
              {(c.items || []).map(it => (
                <div key={it.id} className="row card" style={{ padding: 10 }}>
                  <div><div className="fw-700 text-sm">{it.name}</div>{it.spec && <div className="text-xs text-muted">{it.spec}</div>}</div>
                  <div className="ml-auto num text-sm">{won(it.unit_price)} / {it.unit || '건'}</div>
                </div>
              ))}
            </div>
          )}
          {tab === '계약서' && <WorkContractDocsTab contract={c} onChanged={load}/>}
          {tab === '메모' && <WorkContractMemoTab contract={c} onSaved={load}/>}
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={() => onEdit(c.id)}>편집</button>
          <button className="btn" onClick={dup}><Icon.Doc size={13}/> 이 계약으로 새로</button>
          <div className="ml-auto row gap-8">
            <button className="btn primary" onClick={() => setPayDrawer(true)}><Icon.Plus size={14}/> 지급 등록</button>
          </div>
        </div>
      </Drawer>
      {payDrawer && <ServicePayDrawer contract={c} onClose={() => setPayDrawer(false)} onSaved={() => { setPayDrawer(false); load(); onChanged?.() }}/>}
    </>
  )
}

// 용역·일용 지급 등록 (단가표 수량 → 금액 자동, 원천징수 확정 입력)
const ServicePayDrawer = ({ contract, onClose, onSaved }) => {
  const toast = useToast()
  const today = localToday()   // KST 기준(백엔드 futureDateError와 정렬)
  const [lines, setLines] = useState((contract.items || []).map(it => ({ name: it.name, unit: it.unit, unit_price: Number(it.unit_price), qty: 0 })))
  const [deductions, setDeductions] = useState([{ label: '원천징수 소득세', value: 0 }, { label: '지방소득세', value: 0 }])
  const [payNow, setPayNow] = useState(true)
  const [date, setDate] = useState(today)
  const [accounts, setAccounts] = useState([])
  const [accountId, setAccountId] = useState('')

  useEffect(() => { api.getAccounts().then(a => { setAccounts(a); const bank = a.find(x => x.kind === 'bank'); if (bank) setAccountId(bank.id) }) }, [])

  const gross = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0)
  const dedTotal = deductions.reduce((s, d) => s + asNum(d.value), 0)
  const net = gross - dedTotal

  const updLine = (i, patch) => setLines(lines.map((l, idx) => idx === i ? { ...l, ...patch } : l))
  const updDed = (i, patch) => setDeductions(deductions.map((d, idx) => idx === i ? { ...d, ...patch } : d))

  const submit = async () => {
    const usable = lines.filter(l => (Number(l.qty) || 0) > 0)
    if (usable.length === 0) return toast.push('수량을 입력한 항목이 없어요')
    if (payNow && date > today) return toast.push('미래 날짜로는 지급할 수 없어요')
    // 계좌가 비면 그 지출이 계좌 잔액에서 빠지지 않는다(서버도 400으로 막는다)
    if (payNow && !accountId) return toast.push('출금 계좌를 선택해주세요')
    const res = await api.payWorkContract(contract.id, {
      month: date.slice(0, 7), pay_date: date,
      lines: usable.map(l => ({ name: l.name, unit: l.unit, qty: l.qty, unit_price: l.unit_price })),
      deductions: deductions.filter(d => d.label && asNum(d.value) > 0),
      paid: payNow, date, account_id: accountId || null,
    })
    if (res.ok) { toast.push(payNow ? '지급을 등록했어요' : '지급 명세를 저장했어요'); onSaved() }
    else toast.push(res.error || '등록에 실패했어요')
  }

  return (
    <Drawer open={true} onClose={onClose} width="min(560px, 100vw)">
      <div className="drawer-head">
        <div>
          <div className="fw-700" style={{ fontSize: 16 }}>{contract.employee_name} 지급 등록</div>
          <div className="text-xs text-muted">단가표 수량을 넣으면 금액이 계산돼요. 원천징수는 확정 금액을 직접 입력하세요.</div>
        </div>
        <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
      </div>

      <div className="drawer-body">
        <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 10 }}>업무별 수량</div>
        <div className="col gap-8" style={{ marginBottom: 22 }}>
          {lines.length === 0 && <div className="text-muted2 text-sm">단가표가 비어 있어요. 계약 편집에서 업무를 추가하세요.</div>}
          {lines.map((l, i) => (
            <div key={i} className="row gap-6" style={{ alignItems: 'center' }}>
              <div style={{ flex: 1 }}><div className="fw-700 text-sm">{l.name}</div><div className="text-xs text-muted">{won(l.unit_price)} / {l.unit || '건'}</div></div>
              <input className="input num" style={{ width: 80 }} value={l.qty} placeholder="수량"
                onChange={e => updLine(i, { qty: e.target.value.replace(/[^0-9.]/g, '') })}/>
              <div className="num text-sm fw-700" style={{ width: 100, textAlign: 'right' }}>{won((Number(l.qty) || 0) * (Number(l.unit_price) || 0))}</div>
            </div>
          ))}
        </div>

        <div className="text-xs text-muted2 fw-600" style={{ marginBottom: 10 }}>공제 (원천징수 확정 금액)</div>
        <div className="col gap-8" style={{ marginBottom: 22 }}>
          {deductions.map((d, i) => (
            <div key={i} className="row gap-6" style={{ alignItems: 'center' }}>
              <input className="input" style={{ flex: 1 }} value={d.label} onChange={e => updDed(i, { label: e.target.value })} placeholder="공제 항목"/>
              <div style={{ position: 'relative', width: 130 }}>
                <input className="input num fw-700" style={{ paddingRight: 26 }} value={fmtNum(asNum(d.value))} onChange={e => updDed(i, { value: asNum(e.target.value) })}/>
                <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 12 }}>원</span>
              </div>
              <button className="icon-btn" onClick={() => setDeductions(deductions.filter((_, idx) => idx !== i))}><Icon.Close size={13}/></button>
            </div>
          ))}
          <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setDeductions([...deductions, { label: '', value: 0 }])}><Icon.Plus size={12}/> 공제 추가</button>
        </div>

        <div className="card" style={{ padding: 14, background: 'var(--surface-2)', marginBottom: 18 }}>
          <div className="row text-sm"><span className="text-muted">지급 합계</span><span className="ml-auto num">{won(gross)}</span></div>
          <div className="row text-sm"><span className="text-muted">공제 합계</span><span className="ml-auto num text-warn">-{won(dedTotal)}</span></div>
          <div className="row" style={{ marginTop: 6 }}><span className="fw-700">차인지급액</span><span className="ml-auto num fw-700" style={{ fontSize: 18 }}>{won(net)}</span></div>
        </div>

        <div className="col gap-form">
          <Field label="지급일"><input className="input num" type="date" value={date} max={today} onChange={e => setDate(e.target.value)}/></Field>
          <label className="row gap-8" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={payNow} onChange={e => setPayNow(e.target.checked)}/>
            <span className="text-sm">지금 지급 처리 (거래내역에 지출로 자동 기록)</span>
          </label>
          {payNow && (
            <Field label="출금 계좌 *">
              <Combobox value={accountId} onChange={setAccountId}
                options={accounts.map(a => ({ value: a.id, label: a.name, sub: [a.kind === 'card' ? '카드' : a.bankName, a.number].filter(Boolean).join(' ') }))}
                placeholder="계좌 선택"/>
            </Field>
          )}
        </div>
      </div>

      <div className="drawer-foot">
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" onClick={submit}><Icon.Check size={14}/> {payNow ? '지급 등록' : '명세 저장'}</button>
        </div>
      </div>
    </Drawer>
  )
}

// ── 작은 공용 조각 ──
const Field = ({ label, hint, required, children }) => (
  <div>
    <label className="label">{label}{required && <span style={{ color: 'var(--neg-ink)' }}> *</span>}{hint && <span className="text-muted2" style={{ marginLeft: 6, fontWeight: 400 }}>· {hint}</span>}</label>
    {children}
  </div>
)
const InfoRow = ({ label, value }) => (
  <div className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
    <span className="text-sm text-muted2" style={{ width: 120 }}>{label}</span>
    <span className="text-sm fw-600">{value}</span>
  </div>
)
const Tile = ({ label, value, tone }) => (
  <div className="card" style={{ flex: 1, padding: '10px 12px' }}>
    <div className="text-xs text-muted2">{label}</div>
    <div className="num fw-700" style={{ fontSize: 16, color: tone === 'warn' ? 'var(--warn-ink)' : tone === 'brand' ? 'var(--brand-ink)' : undefined }}>{value}</div>
  </div>
)
