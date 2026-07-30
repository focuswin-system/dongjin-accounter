import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Drawer, Combobox, MoneyInput, localToday } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { api } from '../lib/api'

/* 재무관리 — 차입금·투자.
 *
 * 성과(손익)와 재무(대차)는 성격이 다르다. 대출을 받으면 계좌 잔액은 늘지만 수익이 아니고,
 * 상환할 때 원금은 부채 감소, 이자만 비용이다. 그 구분을 화면에서도 계속 드러낸다 —
 * 숫자만 보여주면 사용자가 '수입/지출'로 오해한다.
 */

const METHOD_LABEL = {
  equal_payment: '원리금균등',
  equal_principal: '원금균등',
  bullet: '만기일시',
}
const METHOD_HINT = {
  equal_payment: '매월 같은 금액을 낸다. 초반엔 이자 비중이 크고 점점 원금이 커진다.',
  equal_principal: '원금을 균등하게 나눠 갚는다. 이자가 줄어 매월 납입액이 감소한다.',
  bullet: '만기까지 이자만 내고 원금은 만기에 한 번에 갚는다.',
}

const dayDiff = (d) => Math.round((new Date(`${d}T00:00:00`) - new Date(`${localToday()}T00:00:00`)) / 86400000)
const dday = (d) => { const n = dayDiff(d); return n === 0 ? '오늘' : n < 0 ? `+${Math.abs(n)}일 지남` : `D-${n}` }
const ddayTone = (d) => { const n = dayDiff(d); return n < 0 ? 'neg' : n <= 7 ? 'warn' : 'outline' }

/* ── 대출 등록 Drawer ─────────────────────────────────────────── */
const LoanFormDrawer = ({ open, editing, onClose, onSave, vendors, accounts }) => {
  const toast = useToast()
  const empty = {
    name: '', lender: '', vendor_id: '', principal: '', annual_rate: '', method: 'equal_payment',
    term_months: '12', start_date: localToday(), pay_day: '', account_id: '', memo: '', received: true,
  }
  const [form, setForm] = useState(empty)
  const [preview, setPreview] = useState(null)
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  useEffect(() => {
    if (!open) return
    setForm(editing ? {
      name: editing.name || '', lender: editing.lender || '', vendor_id: editing.vendor_id || '',
      principal: String(editing.principal || ''), annual_rate: String(editing.annual_rate ?? ''),
      method: editing.method || 'equal_payment', term_months: String(editing.term_months || 12),
      start_date: editing.start_date || localToday(), pay_day: String(editing.pay_day || ''),
      account_id: editing.account_id || '', memo: editing.memo || '', received: false,
    } : empty)
  }, [open, editing])

  // 총 이자를 그 자리에서 보여준다 — 조건을 바꿀 때마다 결과가 어떻게 달라지는지 알아야 고를 수 있다
  useEffect(() => {
    if (!open) return
    const p = Number(String(form.principal).replace(/[^0-9]/g, '')) || 0
    const n = Number(form.term_months) || 0
    if (p <= 0 || n <= 0) { setPreview(null); return }
    let alive = true
    api.previewLoan({
      principal: p, annual_rate: form.annual_rate, method: form.method,
      term_months: n, start_date: form.start_date, pay_day: form.pay_day,
    }).then(r => { if (alive) setPreview(r) })
    return () => { alive = false }
  }, [open, form.principal, form.annual_rate, form.method, form.term_months, form.start_date, form.pay_day])

  const save = async () => {
    if (!form.name.trim()) return toast.push('대출명을 입력해주세요')
    if (!form.start_date) return toast.push('실행일을 선택해주세요')
    const p = Number(String(form.principal).replace(/[^0-9]/g, '')) || 0
    if (p <= 0) return toast.push('원금을 입력해주세요')
    if (form.received && !form.account_id) return toast.push('입금 계좌를 선택해주세요 — 안 고르면 계좌 잔액에 반영되지 않아요')
    const res = await onSave({ ...form, principal: p })
    if (res?.ok === false) return toast.push(res.error || '저장에 실패했어요', { tone: 'warn' })
    onClose()
  }

  if (!open) return null
  const t = preview?.totals
  return (
    <Drawer open onClose={onClose} width="min(560px, 100vw)">
      <DrawerHead title={editing ? '차입금 수정' : '차입금 등록'}
        sub={editing ? '상환 실적이 있으면 원금·방식·회차는 바꿀 수 없어요' : '대출을 받은 기록을 남깁니다'}
        onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="alert-row" style={{ background: 'var(--surface-2)', borderColor: 'var(--line)' }}>
          <Icon.Bank/>
          <div className="text-sm">
            대출금은 <b>수익이 아니라 부채</b>예요. 계좌 잔액에는 들어오지만 매출로 집계되지 않고,
            상환할 때 <b>원금은 부채 감소 · 이자만 비용</b>으로 나뉘어 기록됩니다.
          </div>
        </div>
        <div><label className="label">대출명 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <input className="input" value={form.name} onChange={e => f('name', e.target.value)}
            placeholder="예: 기업은행 운전자금"/>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}><label className="label">금융기관·대여자</label>
            <input className="input" value={form.lender} onChange={e => f('lender', e.target.value)} placeholder="기업은행"/>
          </div>
          <div style={{ flex: 1 }}><label className="label">거래처 연결 <span className="text-muted2">· 선택</span></label>
            <Combobox value={form.vendor_id} onChange={v => f('vendor_id', v)} allowAdd={false}
              options={vendors.map(v => ({ value: v.id, label: v.name, sub: v.type }))} placeholder="거래처 선택"/>
          </div>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}><label className="label">원금 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <MoneyInput value={form.principal} onChange={v => f('principal', v)}/>
          </div>
          <div style={{ width: 130 }}><label className="label">연이율 (%)</label>
            <input className="input num" value={form.annual_rate} onChange={e => f('annual_rate', e.target.value)} placeholder="4.2"/>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>무이자는 0</div>
          </div>
        </div>
        <div><label className="label">상환 방식</label>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            {Object.entries(METHOD_LABEL).map(([v, l]) => (
              <button key={v} type="button" className={`chip ${form.method === v ? 'active' : ''}`}
                onClick={() => f('method', v)}>{l}</button>
            ))}
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>{METHOD_HINT[form.method]}</div>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}><label className="label">상환 회차 (개월)</label>
            <input className="input num" value={form.term_months} onChange={e => f('term_months', e.target.value.replace(/[^0-9]/g, ''))}/>
          </div>
          <div style={{ flex: 1 }}><label className="label">실행일 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <input className="input" type="date" value={form.start_date} onChange={e => f('start_date', e.target.value)}/>
          </div>
          <div style={{ width: 110 }}><label className="label">상환일</label>
            <input className="input num" value={form.pay_day} onChange={e => f('pay_day', e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="매월 N일"/>
          </div>
        </div>
        {/* 조건을 바꿀 때마다 결과를 보여준다 — 총 이자를 모르고 방식을 고를 수는 없다 */}
        {t && (
          <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <div className="fw-700 text-sm">상환 미리보기</div>
              <div className="ml-auto text-xs text-muted2">{t.firstDue} ~ {t.lastDue} · {t.months}회</div>
            </div>
            <div className="row gap-16" style={{ flexWrap: 'wrap' }}>
              <div><div className="text-xs text-muted2">첫 회차 납입</div>
                <div className="num fw-700">{fmtNum(preview.schedule[0]?.total || 0)}원</div></div>
              <div><div className="text-xs text-muted2">총 이자</div>
                <div className="num fw-700" style={{ color: 'var(--neg-ink)' }}>{fmtNum(t.interest)}원</div></div>
              <div><div className="text-xs text-muted2">총 상환액</div>
                <div className="num fw-700">{fmtNum(t.total)}원</div></div>
            </div>
          </div>
        )}
        <div><label className="label">{form.received ? '입금 계좌' : '상환 계좌'}</label>
          <Combobox value={form.account_id} onChange={v => f('account_id', v)} allowAdd={false}
            options={accounts.filter(a => a.kind === 'bank').map(a => ({ value: a.id, label: a.name, sub: a.number }))}
            placeholder="계좌 선택"/>
        </div>
        {!editing && (
          <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className={`chip ${form.received ? 'active' : ''}`}
              onClick={() => f('received', !form.received)}>
              {form.received ? <Icon.Check size={12}/> : null} 실행일에 입금된 것으로 기록
            </button>
            <span className="text-xs text-muted2">
              {form.received
                ? '입금 거래를 만들어 계좌 잔액에 반영해요(부채 계정이라 매출엔 안 잡혀요)'
                : '기록만 남기고 계좌 잔액은 건드리지 않아요'}
            </span>
          </div>
        )}
        <div><label className="label">메모</label>
          <input className="input" value={form.memo} onChange={e => f('memo', e.target.value)}/>
        </div>
      </div>
      <DrawerFooter onCancel={onClose} onSave={save} saveLabel={editing ? '수정' : '등록'}/>
    </Drawer>
  )
}

/* ── 상환 처리 Drawer — 계좌·날짜를 반드시 받는다 ────────────────── */
const RepayDrawer = ({ loan, cycle, onClose, onDone, accounts }) => {
  const toast = useToast()
  const today = localToday()
  const [date, setDate] = useState(cycle?.due_date || today)
  const [acct, setAcct] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!cycle) return
    // 예정일이 미래면 오늘로 — 미래 날짜로는 지출을 찍을 수 없다
    setDate(cycle.due_date > today ? today : cycle.due_date)
    setAcct(loan?.account_id || accounts.find(a => a.kind === 'bank')?.id || '')
  }, [cycle?.seq])
  if (!cycle) return null
  const submit = async () => {
    if (!acct) return toast.push('출금 계좌를 선택해주세요 — 안 고르면 계좌 잔액에 반영되지 않아요')
    if (date > today) return toast.push('미래 날짜로는 처리할 수 없어요')
    setBusy(true)
    const res = await api.repayLoan(loan.id, { seq: cycle.seq, date, account_id: acct })
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '처리에 실패했어요', { tone: 'warn' })
    toast.push(`${cycle.seq}회차를 상환 처리했어요 (원금·이자 2건으로 기록)`)
    onDone()
  }
  return (
    <Drawer open onClose={onClose} width="min(460px, 100vw)">
      <DrawerHead title={`${cycle.seq}회차 상환 처리`}
        sub={<>{loan.name} · 예정일 {cycle.due_date}</>} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="text-sm">원금 <span className="text-xs text-muted2">부채 감소 · 비용 아님</span></span>
            <span className="num fw-700 ml-auto">{fmtNum(cycle.principal)}원</span>
          </div>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="text-sm">이자 <span className="text-xs text-muted2">이자비용</span></span>
            <span className="num fw-700 ml-auto" style={{ color: 'var(--neg-ink)' }}>{fmtNum(cycle.interest)}원</span>
          </div>
          <div className="row" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}>
            <span className="text-sm fw-700">납입액</span>
            <span className="num fw-700 ml-auto">{fmtNum(cycle.total)}원</span>
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 8 }}>
            지출 거래 <b>2건</b>으로 나눠 기록돼요. 한 건으로 뭉치면 원금까지 비용이 되어 손익이 틀어집니다.
          </div>
        </div>
        <div><label className="label">출금 계좌</label>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            {accounts.filter(a => a.kind === 'bank').map(a => (
              <button key={a.id} type="button" className={`chip ${acct === a.id ? 'active' : ''}`}
                onClick={() => setAcct(a.id)}>{a.name}</button>
            ))}
          </div>
        </div>
        <div><label className="label">상환일</label>
          <input className="input num" type="date" value={date} max={today} onChange={e => setDate(e.target.value)}/>
          {cycle.due_date > today && (
            <div className="text-xs" style={{ marginTop: 4, color: 'var(--warn-ink)' }}>
              예정일({cycle.due_date})이 아직 오지 않았어요. 실제로 낸 날짜로 처리하세요.
            </div>
          )}
        </div>
      </div>
      <div className="drawer-foot">
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            <Icon.Check size={14}/> {busy ? '처리 중...' : '상환 처리'}
          </button>
        </div>
      </div>
    </Drawer>
  )
}

/* ── 놓친 상환 일괄 처리 Drawer ───────────────────────────────────
 * 정기 회차의 일괄 등록과 성격이 다르다. 정기 일괄은 '지급 대기'까지만 만들어 계좌를 안 건드리지만,
 * 대출 상환은 만드는 순간 실제 지출이다(자동이체로 이미 나간 돈) → 계좌를 반드시 받는다.
 * 각 회차는 그 회차의 예정일로 기록한다(실제 이체일이 그 날이므로). */
const BulkRepayDrawer = ({ loan, cycles, onClose, onDone, accounts }) => {
  const toast = useToast()
  const [acct, setAcct] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!loan) return
    setAcct(loan.account_id || accounts.find(a => a.kind === 'bank')?.id || '')
  }, [loan?.id])
  if (!loan || !cycles?.length) return null
  const sumP = cycles.reduce((s, c) => s + c.principal, 0)
  const sumI = cycles.reduce((s, c) => s + c.interest, 0)
  const submit = async () => {
    if (!acct) return toast.push('출금 계좌를 선택해주세요 — 안 고르면 계좌 잔액에 반영되지 않아요')
    setBusy(true)
    const res = await api.repayMissedLoan(loan.id, { account_id: acct })
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '처리에 실패했어요', { tone: 'warn' })
    toast.push(`${res.count}회차를 상환 처리했어요 (지출 거래 ${res.count * 2}건)`)
    onDone()
  }
  return (
    <Drawer open onClose={onClose} width="min(520px, 100vw)">
      <DrawerHead title={`놓친 상환 ${cycles.length}회차 일괄 처리`}
        sub={<>{loan.name} · {cycles[0].due_date} ~ {cycles[cycles.length - 1].due_date}</>} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="alert-row" style={{ background: 'var(--warn-soft)', borderColor: 'transparent' }}>
          <Icon.Warn/>
          <div className="text-sm">
            각 회차는 <b>그 회차의 예정일</b>로 기록돼요(자동이체로 이미 나간 날). 회차마다
            원금·이자 <b>2건</b>씩, 총 <b>{cycles.length * 2}건</b>의 지출 거래가 생깁니다.
          </div>
        </div>
        {/* 무엇이 만들어지는지 전부 보여준다 — 되돌리는 비용이 큰 동작이다 */}
        <div>
          <label className="label">처리할 회차</label>
          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="table-scroll" style={{ maxHeight: 220 }}>
              <table className="table">
                <thead><tr>
                  <th style={{ width: 44 }}>회차</th><th>예정일</th>
                  <th className="num-right">원금</th><th className="num-right">이자</th><th className="num-right">납입</th>
                </tr></thead>
                <tbody>
                  {cycles.map(c => (
                    <tr key={c.seq}>
                      <td className="num text-muted2">{c.seq}</td>
                      <td className="num text-sm">{c.due_date}</td>
                      <td className="num-cell num-right">{fmtNum(c.principal)}</td>
                      <td className="num-cell num-right text-muted">{fmtNum(c.interest)}</td>
                      <td className="num-cell num-right fw-600">{fmtNum(c.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ padding: '10px 14px', borderTop: '1px solid var(--line)', background: 'var(--surface-2)' }}>
              <span className="text-sm fw-700">합계</span>
              <span className="text-sm text-muted ml-auto" style={{ marginRight: 12 }}>
                원금 {fmtNum(sumP)} · 이자 {fmtNum(sumI)}
              </span>
              <span className="num fw-700">{fmtNum(sumP + sumI)}원</span>
            </div>
          </div>
        </div>
        <div><label className="label">출금 계좌</label>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            {accounts.filter(a => a.kind === 'bank').map(a => (
              <button key={a.id} type="button" className={`chip ${acct === a.id ? 'active' : ''}`}
                onClick={() => setAcct(a.id)}>{a.name}</button>
            ))}
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
            모든 회차가 이 계좌에서 나간 것으로 기록돼요. 회차마다 계좌가 달랐다면 개별로 처리하세요.
          </div>
        </div>
        <div className="text-xs text-muted2">
          마감된 달이 섞여 있으면 전체가 거절돼요 — 순서를 건너뛸 수 없어서, 일부만 처리하면 남은 회차를 넣을 수 없게 됩니다.
        </div>
      </div>
      <div className="drawer-foot">
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            <Icon.Check size={14}/> {busy ? '처리 중...' : `${cycles.length}회차 상환 처리`}
          </button>
        </div>
      </div>
    </Drawer>
  )
}

/* ── 차입금 화면 ─────────────────────────────────────────────── */
export const LoanScreen = ({ page = true }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [loans, setLoans] = useState([])
  const [vendors, setVendors] = useState([])
  const [accounts, setAccounts] = useState([])
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [repayTarget, setRepayTarget] = useState(null)   // { loan, cycle }
  const [bulkTarget, setBulkTarget] = useState(null)     // { loan, cycles } — 놓친 상환 일괄
  const [openId, setOpenId] = useState(null)             // 스케줄 펼친 대출

  const load = async () => setLoans(await api.getLoans())
  useEffect(() => {
    load()
    api.getVendors().then(list => setVendors(list.filter(v => v.gubu === 'E' || v.gubu === 'A')))
    api.getAccounts().then(setAccounts)
  }, [])

  const handleSave = async (data) => {
    const res = editing ? await api.updateLoan(editing.id, data) : await api.addLoan(data)
    if (res.ok) { toast.push(editing ? '차입금을 수정했어요' : '차입금을 등록했어요'); load() }
    return res
  }

  const handleDelete = async (l) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: '차입금 삭제',
      body: `${l.name}을 삭제합니다.`,
      detail: '상환 처리한 회차가 있으면 삭제할 수 없어요. 실행일 입금 거래는 함께 지워집니다.',
      confirmLabel: '삭제',
    })
    if (!ok) return
    const res = await api.deleteLoan(l.id)
    toast.push(res.ok ? '차입금을 삭제했어요' : (res.error || '삭제에 실패했어요'), res.ok ? undefined : { tone: 'warn' })
    if (res.ok) load()
  }

  const cancelRepay = async (l, seq) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: `${seq}회차 상환 취소`,
      body: '이 회차의 상환 기록과 원금·이자 지출 거래를 지웁니다.',
      detail: '마지막으로 처리한 회차만 취소할 수 있어요(중간을 되돌리면 뒤 회차 이자 계산 근거가 사라집니다).',
      confirmLabel: '취소 처리',
    })
    if (!ok) return
    const res = await api.cancelRepayment(l.id, seq)
    toast.push(res.ok ? '상환을 취소했어요' : (res.error || '취소에 실패했어요'), res.ok ? undefined : { tone: 'warn' })
    if (res.ok) load()
  }

  const active = loans.filter(l => l.status === 'active')
  const totalRemaining = active.reduce((s, l) => s + l.remaining, 0)
  const monthlyDue = active.reduce((s, l) => s + (l.next_cycle?.total || 0), 0)
  const overdue = active.flatMap(l => l.overdue_cycles.map(c => ({ loan: l, cycle: c })))

  return (
    <div className="fade-up">
      <PageHeader title="차입금"
        sub={overdue.length > 0 ? `상환일이 지난 회차 ${overdue.length}건이 있어요` : undefined}
        actions={<button className="btn primary" onClick={() => { setEditing(null); setFormOpen(true) }}>
          <Icon.Plus size={14}/> 차입금 등록
        </button>}/>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
        {[
          { label: '차입 잔여 원금', value: totalRemaining, sub: `진행 중 ${active.length}건` },
          { label: '이번 회차 납입액', value: monthlyDue, sub: '원금+이자 합계' },
          { label: '놓친 상환', value: null, count: overdue.length, sub: overdue.length ? '처리가 필요해요' : '없어요' },
        ].map(k => (
          <div key={k.label} className="card card-pad">
            <div className="text-xs text-muted2">{k.label}</div>
            <div className="num fw-700" style={{ fontSize: 20, marginTop: 4, color: k.count ? 'var(--neg-ink)' : undefined }}>
              {k.value != null ? `${fmtNum(k.value)}원` : `${k.count}건`}
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 2 }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* 놓친 상환 — 실제로 돈이 나갔을 가능성이 높으니 맨 위에 */}
      {overdue.length > 0 && (
        <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
          <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="badge neg"><Icon.Warn size={12}/> 놓친 상환</span>
            <span className="fw-700 text-sm">{overdue.length}건</span>
            <span className="num text-sm text-muted">{fmtNum(overdue.reduce((s, o) => s + o.cycle.total, 0))}원</span>
            <span className="text-xs text-muted2" style={{ flex: 1 }}>상환일이 지났는데 처리되지 않았어요</span>
            {/* 대출별로 묶어 일괄 — 회차 순서를 건너뛸 수 없으므로 한 대출씩 처리한다 */}
            {Object.values(overdue.reduce((acc, o) => {
              (acc[o.loan.id] ||= { loan: o.loan, cycles: [] }).cycles.push(o.cycle)
              return acc
            }, {})).map(g => (
              <button key={g.loan.id} className="btn sm" onClick={() => setBulkTarget(g)}>
                <Icon.Receipt size={12}/> {g.loan.name} {g.cycles.length}건 일괄
              </button>
            ))}
          </div>
          <table className="table">
            <tbody>
              {overdue.map(({ loan, cycle }) => (
                <tr key={`${loan.id}-${cycle.seq}`}>
                  <td className="num text-sm" style={{ width: 170 }}>{cycle.due_date}
                    <span className={`badge ${ddayTone(cycle.due_date)}`} style={{ marginLeft: 6, fontSize: 10 }}>{dday(cycle.due_date)}</span>
                  </td>
                  <td className="fw-700">{loan.name}</td>
                  <td className="text-sm text-muted">{cycle.seq}회차</td>
                  <td className="num-cell num-right fw-700">{fmtNum(cycle.total)}</td>
                  <td style={{ width: 120 }}>
                    <button className="btn sm primary" onClick={() => setRepayTarget({ loan, cycle })}>상환 처리</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th>대출명</th><th>기관</th><th>방식</th>
              <th className="num-right">원금</th><th className="num-right">잔여</th>
              <th>다음 상환</th><th style={{ width: 60 }}>상태</th><th style={{ width: 150 }}></th>
            </tr>
          </thead>
          <tbody>
            {loans.length === 0 && (
              <tr><td colSpan={8} className="text-sm text-muted" style={{ textAlign: 'center', padding: 24 }}>
                등록된 차입금이 없어요. 대출·관계사 차입을 등록하면 상환 스케줄이 자동으로 만들어집니다.
              </td></tr>
            )}
            {loans.map(l => (
              <>
                <tr key={l.id} style={{ opacity: l.status === 'closed' ? 0.5 : 1 }}>
                  <td className="fw-700" style={{ cursor: 'pointer' }} onClick={() => setOpenId(openId === l.id ? null : l.id)}>
                    <Icon.Right size={11} style={{ transform: openId === l.id ? 'rotate(90deg)' : 'none', marginRight: 4 }}/>
                    {l.name}
                  </td>
                  <td className="text-sm text-muted">{l.lender || l.vendor_name || '—'}</td>
                  <td className="text-sm">{METHOD_LABEL[l.method]}
                    <span className="text-xs text-muted2"> · {Number(l.annual_rate) || 0}%</span>
                  </td>
                  <td className="num-cell num-right">{fmtNum(l.principal)}</td>
                  <td className="num-cell num-right fw-700">{fmtNum(l.remaining)}</td>
                  <td className="text-sm">
                    {l.next_cycle ? (
                      <>{l.next_cycle.due_date}
                        <span className={`badge ${ddayTone(l.next_cycle.due_date)}`} style={{ marginLeft: 6, fontSize: 10 }}>
                          {dday(l.next_cycle.due_date)}
                        </span></>
                    ) : '—'}
                  </td>
                  <td><span className={`badge ${l.status === 'active' ? 'brand' : 'outline'}`}>
                    {l.status === 'active' ? '진행' : '완료'}</span></td>
                  <td>
                    <div className="row gap-6">
                      {l.next_cycle && (
                        <button className="btn sm primary" style={{ fontSize: 11, padding: '3px 8px' }}
                          onClick={() => setRepayTarget({ loan: l, cycle: l.next_cycle })}>상환</button>
                      )}
                      <button className="btn" style={{ fontSize: 11, padding: '3px 8px' }}
                        onClick={() => { setEditing(l); setFormOpen(true) }}>수정</button>
                      <button className="btn" style={{ fontSize: 11, padding: '3px 8px', color: 'var(--neg-ink)' }}
                        onClick={() => handleDelete(l)}>삭제</button>
                    </div>
                  </td>
                </tr>
                {openId === l.id && (
                  <tr key={l.id + '-detail'}>
                    <td colSpan={8} style={{ background: 'var(--surface-2)', padding: 16 }}>
                      <div className="row" style={{ marginBottom: 8, gap: 16, flexWrap: 'wrap' }}>
                        <span className="text-sm">총 이자 <b className="num">{fmtNum(l.totals?.interest || 0)}</b>원</span>
                        <span className="text-sm">총 상환 <b className="num">{fmtNum(l.totals?.total || 0)}</b>원</span>
                        <span className="text-sm">처리 {l.paid_count}/{l.totals?.months}회차</span>
                      </div>
                      <div className="table-scroll" style={{ maxHeight: 280 }}>
                        <table className="table">
                          <thead><tr>
                            <th style={{ width: 50 }}>회차</th><th>예정일</th>
                            <th className="num-right">원금</th><th className="num-right">이자</th>
                            <th className="num-right">납입액</th><th className="num-right">잔액</th>
                            <th style={{ width: 110 }}>처리</th>
                          </tr></thead>
                          <tbody>
                            {(l.schedule || []).map(c => {
                              const done = l.repayments.find(r => r.seq === c.seq && r.paid_date)
                              const isNext = l.next_cycle?.seq === c.seq
                              return (
                                <tr key={c.seq} style={{ opacity: done ? 0.6 : 1 }}>
                                  <td className="num text-muted2">{c.seq}</td>
                                  <td className="num text-sm">{c.due_date}</td>
                                  <td className="num-cell num-right">{fmtNum(c.principal)}</td>
                                  <td className="num-cell num-right text-muted">{fmtNum(c.interest)}</td>
                                  <td className="num-cell num-right fw-600">{fmtNum(c.total)}</td>
                                  <td className="num-cell num-right text-muted2">{fmtNum(c.balance)}</td>
                                  <td>
                                    {done ? (
                                      <div className="row gap-4" style={{ alignItems: 'center' }}>
                                        <span className="badge pos" style={{ fontSize: 10 }}>{done.paid_date}</span>
                                        <button className="btn ghost sm" style={{ fontSize: 10, padding: '1px 5px' }}
                                          onClick={() => cancelRepay(l, c.seq)}>취소</button>
                                      </div>
                                    ) : isNext ? (
                                      <button className="btn sm primary" style={{ fontSize: 10, padding: '2px 7px' }}
                                        onClick={() => setRepayTarget({ loan: l, cycle: c })}>상환 처리</button>
                                    ) : (
                                      <span className="text-xs text-muted2">앞선 회차부터</span>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      <LoanFormDrawer open={formOpen} editing={editing} vendors={vendors} accounts={accounts}
        onClose={() => { setFormOpen(false); setEditing(null) }} onSave={handleSave}/>
      <RepayDrawer loan={repayTarget?.loan} cycle={repayTarget?.cycle} accounts={accounts}
        onClose={() => setRepayTarget(null)} onDone={() => { setRepayTarget(null); load() }}/>
      <BulkRepayDrawer loan={bulkTarget?.loan} cycles={bulkTarget?.cycles} accounts={accounts}
        onClose={() => setBulkTarget(null)} onDone={() => { setBulkTarget(null); load() }}/>
    </div>
  )
}

/* ── 투자 화면 ───────────────────────────────────────────────── */
const InvestFormDrawer = ({ open, onClose, onSave, vendors, accounts }) => {
  const toast = useToast()
  const empty = {
    direction: 'in', counterparty: '', vendor_id: '', amount: '', invested_at: localToday(),
    account_id: '', capital_amount: '', memo: '', recorded: true,
  }
  const [form, setForm] = useState(empty)
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))
  useEffect(() => { if (open) setForm(empty) }, [open])
  if (!open) return null
  const isIn = form.direction === 'in'
  const amount = Number(String(form.amount).replace(/[^0-9]/g, '')) || 0
  const capital = Math.min(Number(String(form.capital_amount).replace(/[^0-9]/g, '')) || amount, amount)
  const save = async () => {
    if (!form.counterparty.trim()) return toast.push(isIn ? '투자자를 입력해주세요' : '투자처를 입력해주세요')
    if (amount <= 0) return toast.push('금액을 입력해주세요')
    if (form.recorded && !form.account_id) return toast.push('계좌를 선택해주세요 — 안 고르면 계좌 잔액에 반영되지 않아요')
    const res = await onSave({ ...form, amount, capital_amount: isIn ? capital : 0 })
    if (res?.ok === false) return toast.push(res.error || '저장에 실패했어요', { tone: 'warn' })
    onClose()
  }
  return (
    <Drawer open onClose={onClose} width="min(500px, 100vw)">
      <DrawerHead title="투자 등록" sub={isIn ? '투자받은 돈(자본)' : '투자한 돈(투자자산)'} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div><label className="label">구분</label>
          <div className="row gap-6">
            {[['in', '투자받은 돈'], ['out', '투자한 돈']].map(([v, l]) => (
              <button key={v} type="button" className={`chip ${form.direction === v ? 'active' : ''}`}
                onClick={() => f('direction', v)}>{l}</button>
            ))}
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
            {isIn ? '자본으로 잡혀요 — 수익이 아니라서 매출에 집계되지 않아요.'
                  : '투자자산으로 잡혀요 — 비용이 아니라서 손익에 집계되지 않아요.'}
          </div>
        </div>
        <div><label className="label">{isIn ? '투자자' : '투자처'} <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <input className="input" value={form.counterparty} onChange={e => f('counterparty', e.target.value)}
            placeholder={isIn ? '예: 개인투자 홍길동' : '예: (주)○○'}/>
        </div>
        <div className="row gap-12">
          <div style={{ flex: 1 }}><label className="label">금액 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <MoneyInput value={form.amount} onChange={v => f('amount', v)}/>
          </div>
          <div style={{ flex: 1 }}><label className="label">일자 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <input className="input" type="date" value={form.invested_at} onChange={e => f('invested_at', e.target.value)}/>
          </div>
        </div>
        {isIn && (
          <div>
            <label className="label">자본금 <span className="text-muted2">· 액면가 × 주식수</span></label>
            <MoneyInput value={form.capital_amount} onChange={v => f('capital_amount', v)}/>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>
              비우면 전액을 자본금으로 봐요. 넣으면 나머지 <b className="num">{fmtNum(Math.max(0, amount - capital))}</b>원이
              주식발행초과금(자본잉여금)으로 갈립니다.
            </div>
          </div>
        )}
        <div><label className="label">거래처 연결 <span className="text-muted2">· 선택</span></label>
          <Combobox value={form.vendor_id} onChange={v => f('vendor_id', v)} allowAdd={false}
            options={vendors.map(v => ({ value: v.id, label: v.name, sub: v.type }))} placeholder="거래처 선택"/>
        </div>
        <div><label className="label">{isIn ? '입금 계좌' : '출금 계좌'}</label>
          <Combobox value={form.account_id} onChange={v => f('account_id', v)} allowAdd={false}
            options={accounts.filter(a => a.kind === 'bank').map(a => ({ value: a.id, label: a.name, sub: a.number }))}
            placeholder="계좌 선택"/>
        </div>
        <div className="row gap-10" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className={`chip ${form.recorded ? 'active' : ''}`}
            onClick={() => f('recorded', !form.recorded)}>
            {form.recorded ? <Icon.Check size={12}/> : null} 실제 {isIn ? '입금' : '출금'}으로 기록
          </button>
          <span className="text-xs text-muted2">
            {form.recorded ? '계좌 잔액에 반영해요' : '기록만 남기고 계좌는 건드리지 않아요'}
          </span>
        </div>
        <div><label className="label">메모</label>
          <input className="input" value={form.memo} onChange={e => f('memo', e.target.value)}/>
        </div>
      </div>
      <DrawerFooter onCancel={onClose} onSave={save} saveLabel="등록"/>
    </Drawer>
  )
}

export const InvestmentScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState([])
  const [vendors, setVendors] = useState([])
  const [accounts, setAccounts] = useState([])
  const [formOpen, setFormOpen] = useState(false)
  const [dir, setDir] = useState('all')

  const load = async () => setRows(await api.getInvestments())
  useEffect(() => {
    load()
    api.getVendors().then(setVendors)
    api.getAccounts().then(setAccounts)
  }, [])

  const handleDelete = async (r) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: '투자 기록 삭제',
      body: `${r.counterparty} · ${fmtNum(r.amount)}원 기록을 삭제합니다.`,
      detail: '연결된 입출금 거래도 함께 지워집니다.',
      confirmLabel: '삭제',
    })
    if (!ok) return
    const res = await api.deleteInvestment(r.id)
    toast.push(res.ok ? '삭제했어요' : (res.error || '삭제에 실패했어요'), res.ok ? undefined : { tone: 'warn' })
    if (res.ok) load()
  }

  const shown = dir === 'all' ? rows : rows.filter(r => r.direction === dir)
  const sumIn = rows.filter(r => r.direction === 'in').reduce((s, r) => s + r.amount, 0)
  const sumOut = rows.filter(r => r.direction === 'out').reduce((s, r) => s + r.amount, 0)

  return (
    <div className="fade-up">
      <PageHeader title="투자"
        actions={<button className="btn primary" onClick={() => setFormOpen(true)}>
          <Icon.Plus size={14}/> 투자 등록
        </button>}/>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', gap: 16, marginBottom: 20 }}>
        <div className="card card-pad">
          <div className="text-xs text-muted2">투자받은 돈 · 자본</div>
          <div className="num fw-700" style={{ fontSize: 20, marginTop: 4 }}>{fmtNum(sumIn)}원</div>
          <div className="text-xs text-muted2" style={{ marginTop: 2 }}>수익이 아니라 자본으로 잡혀요</div>
        </div>
        <div className="card card-pad">
          <div className="text-xs text-muted2">투자한 돈 · 투자자산</div>
          <div className="num fw-700" style={{ fontSize: 20, marginTop: 4 }}>{fmtNum(sumOut)}원</div>
          <div className="text-xs text-muted2" style={{ marginTop: 2 }}>비용이 아니라 자산으로 잡혀요</div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="section-title" style={{ fontSize: 13 }}>투자 기록 {shown.length}건</div>
        <div className="row gap-6 ml-auto">
          {[['all', '전체'], ['in', '받은 돈'], ['out', '한 돈']].map(([v, l]) => (
            <button key={v} className={`chip ${dir === v ? 'active' : ''}`} onClick={() => setDir(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 90 }}>구분</th><th>상대</th><th>일자</th>
              <th className="num-right">금액</th><th>내역</th><th style={{ width: 70 }}></th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={6} className="text-sm text-muted" style={{ textAlign: 'center', padding: 24 }}>
                투자 기록이 없어요.
              </td></tr>
            )}
            {shown.map(r => (
              <tr key={r.id}>
                <td><span className={`badge ${r.direction === 'in' ? 'brand' : 'outline'}`}>
                  {r.direction === 'in' ? '받은 돈' : '한 돈'}</span></td>
                <td className="fw-700">{r.counterparty}
                  {r.vendor_name && <span className="text-xs text-muted2"> · {r.vendor_name}</span>}</td>
                <td className="num text-sm">{r.invested_at}</td>
                <td className="num-cell num-right fw-700">{fmtNum(r.amount)}</td>
                <td className="text-sm text-muted">
                  {r.direction === 'in'
                    ? <>자본금 {fmtNum(r.capital_amount)}{r.premium_amount > 0 && ` · 주식발행초과금 ${fmtNum(r.premium_amount)}`}</>
                    : (r.memo || '투자자산')}
                </td>
                <td>
                  <button className="btn" style={{ fontSize: 11, padding: '3px 8px', color: 'var(--neg-ink)' }}
                    onClick={() => handleDelete(r)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <InvestFormDrawer open={formOpen} vendors={vendors} accounts={accounts}
        onClose={() => setFormOpen(false)}
        onSave={async (data) => {
          const res = await api.addInvestment(data)
          if (res.ok) { toast.push('투자를 등록했어요'); load() }
          return res
        }}/>
    </div>
  )
}

/* ── 재무 현황 ───────────────────────────────────────────────── */
export const FinanceDashScreen = () => {
  const [s, setS] = useState(null)
  useEffect(() => { api.getFinanceSummary().then(setS) }, [])
  const cards = [
    { label: '차입 잔여 원금', v: s?.remaining, sub: `진행 중 ${s?.loan_count ?? 0}건 · 최초 ${fmtNum(s?.loan_principal || 0)}원` },
    { label: '이번 회차 납입액', v: s?.monthly_due, sub: '원금+이자 합계' },
    { label: '투자받은 돈', v: s?.invested_in, sub: '자본 — 매출 아님' },
    { label: '투자한 돈', v: s?.invested_out, sub: '투자자산 — 비용 아님' },
  ]
  return (
    <div className="fade-up">
      <PageHeader title="재무 현황"
        sub={s?.overdue_count > 0 ? `상환일이 지난 회차 ${s.overdue_count}건` : undefined}/>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 20 }}>
        {cards.map(c => (
          <div key={c.label} className="card card-pad">
            <div className="text-xs text-muted2">{c.label}</div>
            <div className="num fw-700" style={{ fontSize: 20, marginTop: 4 }}>{fmtNum(c.v || 0)}원</div>
            <div className="text-xs text-muted2" style={{ marginTop: 2 }}>{c.sub}</div>
          </div>
        ))}
      </div>
      <div className="card card-pad">
        <div className="section-title" style={{ marginBottom: 6 }}>재무 거래는 손익이 아닙니다</div>
        <div className="text-sm text-muted" style={{ lineHeight: 1.7 }}>
          대출금과 투자금은 계좌 잔액에는 들어오지만 <b>매출이 아닙니다</b>. 상환할 때도 <b>원금은 부채 감소</b>이고
          <b> 이자만 비용</b>입니다. 그래서 이 화면의 금액은 손익계산(매출·경비 분석)에 섞이지 않습니다.
          계좌 잔액에는 실제로 오간 돈이므로 그대로 반영됩니다.
        </div>
      </div>
    </div>
  )
}
