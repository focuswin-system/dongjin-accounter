import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Drawer, Combobox, MoneyInput, localToday, DateInput } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { Kpi, KpiRow } from '../lib/components/Kpi'
import { DataTable } from '../lib/components/DataTable'
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
  none: '일정 없음',
}
const METHOD_HINT = {
  equal_payment: '매월 같은 금액을 낸다. 초반엔 이자 비중이 크고 점점 원금이 커진다.',
  equal_principal: '원금을 균등하게 나눠 갚는다. 이자가 줄어 매월 납입액이 감소한다.',
  bullet: '만기까지 이자만 내고 원금은 만기에 한 번에 갚는다.',
  /* 대표가수금·관계사 차입처럼 언제 갚을지 안 정한 채무. 회차를 만들지 않으므로
     자금 예측에 출금이 안 잡히고, 부채 잔액으로만 남는다. */
  none: '갚을 날짜가 정해지지 않은 돈이에요. 회차를 만들지 않고 잔액만 남깁니다 — 나중에 정해지면 방식을 바꾸면 돼요.',
}
/** 상환 일정이 없는 채무 — 회차·이율·기간 입력이 뜻을 잃는다 */
const noSchedule = (m) => m === 'none'

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
    // 일정 없음은 회차를 안 만든다 — 숨겨둔 term_months 때문에 '0회·0원' 미리보기가 떴다
    if (noSchedule(form.method) || p <= 0 || n <= 0) { setPreview(null); return }
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
    /* 일정 없음이면 회차를 0으로 보낸다. 폼이 칸만 숨기고 값(기본 '12')은 그대로 보내서,
       대표가수금이 term_months=12 로 저장되고 그 값으로 단기/장기차입금 계정이 갈렸다. */
    const res = await onSave({
      ...form, principal: p,
      term_months: noSchedule(form.method) ? 0 : form.term_months,
    })
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
          <div style={{ width: 150 }}><label className="label">연이율 (%)</label>
            <input className="input num" value={form.annual_rate} onChange={e => f('annual_rate', e.target.value)}
              placeholder={noSchedule(form.method) ? '몰라도 됨' : '4.2'}/>
            {/* '일정 없음'의 이율은 참고값이다 — 회차가 없어 이걸로 이자를 계산하지 않는다.
                변동금리라 이율을 못 적는 경우와, 무이자인 경우는 다른 사실이라 지우지 않는다. */}
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>
              {noSchedule(form.method) ? '적어도 계산엔 안 써요 — 이자는 갚을 때 직접 입력' : '무이자는 0'}
            </div>
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
        {/* 일정이 없는 채무는 회차·상환일이 뜻을 잃는다 — 칸을 그리면 뭔가 채워야 하는 줄 안다 */}
        <div className="row gap-12">
          {!noSchedule(form.method) && (
            <div style={{ flex: 1 }}><label className="label">상환 회차 (개월)</label>
              <input className="input num" value={form.term_months} onChange={e => f('term_months', e.target.value.replace(/[^0-9]/g, ''))}/>
            </div>
          )}
          <div style={{ flex: 1 }}><label className="label">실행일 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <DateInput className="input" value={form.start_date} onChange={e => f('start_date', e.target.value)}/>
          </div>
          {!noSchedule(form.method) && (
            <div style={{ width: 110 }}><label className="label">상환일</label>
              <input className="input num" value={form.pay_day} onChange={e => f('pay_day', e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="매월 N일"/>
            </div>
          )}
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

/* ── 추가 차입 Drawer — 같은 대출에서 원금을 더 빌린다 ──────────────
 *
 * 수시 상환의 **정확한 반대편**이다. 개인 대출·대표 가수금·한도대출은 한 약정 안에서
 * 잔액이 오르내리는데, 여태 더 빌리는 자리가 없어 새 대출로 등록하는 수밖에 없었다.
 * 그러면 같은 약정이 여러 건으로 쪼개져 "이 사람에게 지금 얼마 빚졌나"를 한눈에 못 본다.
 */
const DrawLoanDrawer = ({ loan, onClose, onDone, accounts }) => {
  const toast = useToast()
  const today = localToday()
  const [date, setDate] = useState(today)
  const [acct, setAcct] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!loan) return
    setDate(today); setAmount(''); setMemo('')
    setAcct(loan.account_id || accounts.find(a => a.kind === 'bank')?.id || '')
  }, [loan?.id])
  if (!loan) return null
  const amt = Number(String(amount).replace(/[^0-9]/g, '')) || 0
  const left = Number(loan.remaining) || 0

  const submit = async () => {
    if (!acct) return toast.push('입금 계좌를 선택해주세요 — 안 고르면 계좌 잔액에 반영되지 않아요')
    if (amt <= 0) return toast.push('빌린 금액을 입력해주세요')
    if (date > today) return toast.push('미래 날짜로는 처리할 수 없어요')
    if (date < loan.start_date) return toast.push(`대출 실행일(${loan.start_date}) 이전 날짜로는 인출할 수 없어요`, { tone: 'warn' })
    setBusy(true)
    const res = await api.drawLoan(loan.id, { date, account_id: acct, amount: amt, memo })
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '처리에 실패했어요', { tone: 'warn' })
    toast.push(`${fmtNum(amt)}원 추가로 빌린 것으로 기록했어요 (남은 원금 ${fmtNum(left + amt)}원)`)
    onDone()
  }
  return (
    <Drawer open onClose={onClose} width="min(460px, 100vw)">
      <DrawerHead title="추가 차입" sub={<>{loan.name} · 현재 남은 원금 {fmtNum(left)}원</>} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="alert-row" style={{ background: 'var(--brand-soft)', borderColor: 'transparent' }}>
          <Icon.Sparkle size={16}/>
          <div>
            <div className="lead">같은 대출에서 더 빌립니다</div>
            <div className="body">새 대출을 만들지 않고 이 약정의 원금을 늘려요. 갚을 때는 지금처럼 수시 상환을 쓰면 됩니다.</div>
          </div>
        </div>
        <div><label className="label">빌린 금액 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <MoneyInput value={amount} onChange={setAmount}/>
          <div className="text-sm text-muted" style={{ marginTop: 4 }}>부채가 늘어나는 금액이에요. 매출이 아닙니다.</div>
        </div>
        <div><label className="label">입금 계좌</label>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            {accounts.filter(a => a.kind === 'bank').map(a => (
              <button key={a.id} type="button" className={`chip ${acct === a.id ? 'active' : ''}`}
                onClick={() => setAcct(a.id)}>{a.name}</button>
            ))}
          </div>
        </div>
        <div><label className="label">인출일</label>
          <DateInput className="input num" value={date} max={today} onChange={e => setDate(e.target.value)}/>
        </div>
        <div><label className="label">메모 <span className="text-muted2">· 선택</span></label>
          <input className="input" value={memo} placeholder="예: 운전자금 추가" onChange={e => setMemo(e.target.value)}/>
        </div>
        {amt > 0 && (
          <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
            <div className="row"><span className="text-sm">입금 합계</span>
              <span className="num fw-700 ml-auto">{fmtNum(amt)}원</span></div>
            <div className="row" style={{ marginTop: 4 }}><span className="text-sm text-muted">빌린 뒤 남는 원금</span>
              <span className="num ml-auto">{fmtNum(left + amt)}원</span></div>
            <div className="text-sm text-muted" style={{ marginTop: 8 }}>
              입금 거래 <b>1건</b>으로 기록돼요 — 차입금(부채) 계정이라 매출·손익에는 잡히지 않습니다.
            </div>
          </div>
        )}
      </div>
      <DrawerFooter onCancel={onClose} onSave={submit} saveDisabled={busy}
        saveLabel={busy ? '처리 중…' : '추가 차입 기록'}/>
    </Drawer>
  )
}

/* ── 수시 상환 Drawer — 회차 없이 금액을 직접 넣어 갚는다 ──────────────
 *
 * 상환 일정이 없는 채무(대표가수금 등)는 갚을 회차가 없다. 그런데 실무에서는 자금 여유가
 * 생길 때 500만·1,000만씩 수시로 갚는다. 이 자리가 없으면 갚는 방법이 거래를 직접 등록하는
 * 것뿐인데, 그러면 차입금과 연결이 안 돼 잔여 원금이 영영 안 줄어든다.
 */
const AdhocRepayDrawer = ({ loan, onClose, onDone, accounts }) => {
  const toast = useToast()
  const today = localToday()
  const [date, setDate] = useState(today)
  const [acct, setAcct] = useState('')
  const [principal, setPrincipal] = useState('')
  const [interest, setInterest] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!loan) return
    setDate(today); setPrincipal(''); setInterest('')
    setAcct(loan.account_id || accounts.find(a => a.kind === 'bank')?.id || '')
  }, [loan?.id])
  if (!loan) return null
  const p = Number(String(principal).replace(/[^0-9]/g, '')) || 0
  const i = Number(String(interest).replace(/[^0-9]/g, '')) || 0
  const left = Number(loan.remaining) || 0

  const submit = async () => {
    if (!acct) return toast.push('출금 계좌를 선택해주세요 — 안 고르면 계좌 잔액에 반영되지 않아요')
    if (p + i <= 0) return toast.push('갚은 금액을 입력해주세요')
    if (p > left) return toast.push(`남은 원금(${fmtNum(left)}원)보다 많이 갚을 수 없어요`, { tone: 'warn' })
    if (date > today) return toast.push('미래 날짜로는 처리할 수 없어요')
    setBusy(true)
    const res = await api.repayLoanAdhoc(loan.id, { date, account_id: acct, principal: p, interest: i })
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '처리에 실패했어요', { tone: 'warn' })
    toast.push(p >= left ? '다 갚았어요 — 완료 처리했습니다' : `${fmtNum(p + i)}원 상환했어요 (남은 원금 ${fmtNum(res.remaining)}원)`)
    onDone()
  }
  return (
    <Drawer open onClose={onClose} width="min(460px, 100vw)">
      <DrawerHead title="수시 상환" sub={<>{loan.name} · 남은 원금 {fmtNum(left)}원</>} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="alert-row" style={{ background: 'var(--brand-soft)', borderColor: 'transparent' }}>
          <Icon.Sparkle size={16}/>
          <div>
            <div className="lead">갚을 일정이 없는 채무예요</div>
            <div className="body">이번에 실제로 나간 금액만 적어주세요. 남은 원금이 그만큼 줄고, 다 갚으면 완료로 바뀝니다.</div>
          </div>
        </div>
        <div><label className="label">갚은 원금 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <MoneyInput value={principal} onChange={setPrincipal}/>
          <div className="text-sm text-muted" style={{ marginTop: 4 }}>부채가 줄어드는 금액이에요. 비용이 아닙니다.</div>
        </div>
        <div><label className="label">함께 낸 이자</label>
          <MoneyInput value={interest} onChange={setInterest}/>
          <div className="text-sm text-muted" style={{ marginTop: 4 }}>이자를 냈다면 적어주세요. 이건 비용으로 잡힙니다. 없으면 비워두세요.</div>
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
          <DateInput className="input num" value={date} max={today} onChange={e => setDate(e.target.value)}/>
        </div>
        {(p > 0 || i > 0) && (
          <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
            <div className="row"><span className="text-sm">출금 합계</span>
              <span className="num fw-700 ml-auto">{fmtNum(p + i)}원</span></div>
            <div className="row" style={{ marginTop: 4 }}><span className="text-sm text-muted">갚고 남는 원금</span>
              <span className="num ml-auto">{fmtNum(Math.max(0, left - p))}원</span></div>
            <div className="text-sm text-muted" style={{ marginTop: 8 }}>
              지출 거래 <b>{(p > 0 ? 1 : 0) + (i > 0 ? 1 : 0)}건</b>으로 기록돼요 — 원금과 이자는 계정과목이 달라 뭉치면 손익이 틀어집니다.
            </div>
          </div>
        )}
      </div>
      <DrawerFooter onCancel={onClose} onSave={submit} saveDisabled={busy}
        saveLabel={busy ? '처리 중…' : '상환 처리'}/>
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
          <DateInput className="input num" value={date} max={today} onChange={e => setDate(e.target.value)}/>
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
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              <DataTable
                rows={cycles}
                rowKey={c => c.seq}
                columns={[
                  { key: 'seq', header: '회차', width: 56, className: 'num text-muted2' },
                  { key: 'due_date', header: '예정일', className: 'num text-sm' },
                  { key: 'principal', header: '원금', align: 'right', className: 'num-cell', render: c => fmtNum(c.principal) },
                  { key: 'interest', header: '이자', align: 'right', className: 'num-cell text-muted', render: c => fmtNum(c.interest) },
                  { key: 'total', header: '납입', align: 'right', className: 'num-cell fw-600', render: c => fmtNum(c.total) },
                ]}/>
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
  const [adhocTarget, setAdhocTarget] = useState(null)   // 일정 없는 채무의 수시 상환
  const [drawTarget, setDrawTarget] = useState(null)     // 일정 없는 채무의 추가 차입
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

  /* 추가 차입 취소 — 잘못 기록한 인출을 되돌린다. 입금 거래도 함께 사라지므로
     계좌 잔액이 그만큼 줄어든다는 걸 미리 말해준다(누르고 나서 알면 늦다). */
  const cancelDraw = async (l, d) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: '추가 차입 취소',
      body: `${d.draw_date}에 빌린 ${fmtNum(d.amount)}원을 되돌립니다.`,
      detail: '이때 만든 입금 거래도 함께 지워져 계좌 잔액이 그만큼 줄고, 누적 차입액도 되돌아가요.',
      confirmLabel: '취소 처리',
    })
    if (!ok) return
    const res = await api.cancelLoanDraw(l.id, d.id)
    toast.push(res.ok ? '추가 차입을 취소했어요' : (res.error || '취소에 실패했어요'), res.ok ? undefined : { tone: 'warn' })
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

      <KpiRow cols={3} style={{ marginBottom: 20 }}>
        <Kpi label="차입 잔여 원금" value={totalRemaining} badge={`진행 중 ${active.length}건`}/>
        <Kpi label="이번 회차 납입액" value={monthlyDue} hint="원금+이자 합계"/>
        <Kpi label="놓친 상환" value={`${overdue.length}건`} tone={overdue.length ? 'neg-ink' : undefined}
          hint={overdue.length ? '처리가 필요해요' : '없어요'}/>
      </KpiRow>

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
          <DataTable
            rows={overdue}
            rowKey={r => `${r.loan.id}-${r.cycle.seq}`}
            columns={[
              { key: 'due', header: '예정일', width: 170, render: ({ cycle }) => (
                <span className="num text-sm">{cycle.due_date}
                  <span className={`badge ${ddayTone(cycle.due_date)}`} style={{ marginLeft: 6, fontSize: 10 }}>{dday(cycle.due_date)}</span>
                </span>
              )},
              { key: 'name', header: '대출명', className: 'fw-700', render: ({ loan }) => loan.name },
              { key: 'seq', header: '회차', width: 80, className: 'text-sm text-muted', render: ({ cycle }) => `${cycle.seq}회차` },
              { key: 'total', header: '납입액', width: 130, align: 'right', className: 'num-cell fw-700',
                render: ({ cycle }) => fmtNum(cycle.total) },
              { key: 'act', header: '', width: 120, render: (r) => (
                <button className="btn sm primary" onClick={() => setRepayTarget(r)}>상환 처리</button>
              )},
            ]}/>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <DataTable
          rows={loans}
          empty="등록된 차입금이 없어요. 대출·관계사 차입을 등록하면 상환 스케줄이 자동으로 만들어집니다."
          renderExpanded={l => (openId === l.id ? <LoanSchedule loan={l} onRepay={setRepayTarget} onCancel={cancelRepay} onCancelDraw={cancelDraw}/> : null)}
          columns={[
            { key: 'name', header: '대출명', sortable: true, className: 'fw-700', render: l => (
              <span style={{ cursor: 'pointer', opacity: l.status === 'closed' ? 0.5 : 1 }}
                onClick={() => setOpenId(openId === l.id ? null : l.id)}>
                <Icon.Right size={11} style={{ transform: openId === l.id ? 'rotate(90deg)' : 'none', marginRight: 4 }}/>
                {l.name}
              </span>
            )},
            { key: 'lender', header: '기관', className: 'text-sm text-muted', sortable: true,
              render: l => l.lender || l.vendor_name || '—' },
            { key: 'method', header: '방식', className: 'text-sm', render: l => (
              <>{METHOD_LABEL[l.method]}<span className="text-xs text-muted2"> · {Number(l.annual_rate) || 0}%</span></>
            )},
            { key: 'principal', header: '원금', align: 'right', className: 'num-cell', sortable: true,
              sortValue: l => Number(l.principal) || 0, render: l => fmtNum(l.principal) },
            { key: 'remaining', header: '잔여', align: 'right', className: 'num-cell fw-700', sortable: true,
              sortValue: l => Number(l.remaining) || 0, render: l => fmtNum(l.remaining) },
            { key: 'next', header: '다음 상환', className: 'text-sm',
              sortValue: l => l.next_cycle?.due_date || null, sortable: true, render: l => (l.next_cycle ? (
                <>{l.next_cycle.due_date}
                  <span className={`badge ${ddayTone(l.next_cycle.due_date)}`} style={{ marginLeft: 6, fontSize: 10 }}>
                    {dday(l.next_cycle.due_date)}
                  </span></>
              ) : '—')},
            { key: 'status', header: '상태', width: 70, render: l => (
              <span className={`badge ${l.status === 'active' ? 'brand' : 'outline'}`}>
                {l.status === 'active' ? '진행' : '완료'}</span>
            )},
            { key: 'act', header: '', width: 160, render: l => (
              <div className="row gap-6">
                {/* 일정 없는 채무는 회차가 없다 — 대신 금액을 직접 넣는 수시 상환을 연다.
                    없애기만 하면 갚을 방법이 사라져 잔여 원금이 영영 안 줄어든다. */}
                {l.status === 'active' && noSchedule(l.method) && (
                  <button className="btn sm primary" style={{ fontSize: 11, padding: '3px 8px' }}
                    onClick={() => setAdhocTarget(l)}>수시 상환</button>
                )}
                {/* 추가 차입 — 수시 상환의 반대편이라 나란히 둔다. 일정이 있는 대출은
                    원금을 늘리면 스케줄이 통째로 무효가 되므로 버튼 자체를 안 그린다
                    (그 경우는 증액이 아니라 새 약정이다). */}
                {l.status === 'active' && noSchedule(l.method) && (
                  <button className="btn sm" style={{ fontSize: 11, padding: '3px 8px' }}
                    title="같은 대출에서 원금을 더 빌립니다"
                    onClick={() => setDrawTarget(l)}>추가 차입</button>
                )}
                {/* 0원 회차는 상환할 것이 없다. 눌러도 서버가 막지만, 버튼을 보이면
                    "왜 안 되지"로 막히므로 애초에 안 그린다. */}
                {!noSchedule(l.method) && l.next_cycle && (
                  <button className="btn sm primary" style={{ fontSize: 11, padding: '3px 8px' }}
                    onClick={() => setRepayTarget({ loan: l, cycle: l.next_cycle })}>상환</button>
                )}
                <button className="btn" style={{ fontSize: 11, padding: '3px 8px' }}
                  onClick={() => { setEditing(l); setFormOpen(true) }}>수정</button>
                <button className="btn" style={{ fontSize: 11, padding: '3px 8px', color: 'var(--neg-ink)' }}
                  onClick={() => handleDelete(l)}>삭제</button>
              </div>
            )},
          ]}/>
      </div>

      <LoanFormDrawer open={formOpen} editing={editing} vendors={vendors} accounts={accounts}
        onClose={() => { setFormOpen(false); setEditing(null) }} onSave={handleSave}/>
      <RepayDrawer loan={repayTarget?.loan} cycle={repayTarget?.cycle} accounts={accounts}
        onClose={() => setRepayTarget(null)} onDone={() => { setRepayTarget(null); load() }}/>
      <BulkRepayDrawer loan={bulkTarget?.loan} cycles={bulkTarget?.cycles} accounts={accounts}
        onClose={() => setBulkTarget(null)} onDone={() => { setBulkTarget(null); load() }}/>
      <DrawLoanDrawer loan={drawTarget} accounts={accounts}
        onClose={() => setDrawTarget(null)}
        onDone={() => { setDrawTarget(null); load() }}/>
      <AdhocRepayDrawer loan={adhocTarget} accounts={accounts}
        onClose={() => setAdhocTarget(null)} onDone={() => { setAdhocTarget(null); load() }}/>
    </div>
  )
}

/* 상환 스케줄 — 대출 행을 펼치면 나온다.
 * 회차는 앞에서부터 순서대로만 처리할 수 있다(건너뛰면 잔액이 어긋난다).
 * 그래서 '다음 회차'에만 버튼을 주고 나머지는 왜 못 누르는지 적어둔다. */
/* 추가 차입 내역 — 인출이 한 번이라도 있을 때만 낸다.
   없으면 칸이 늘 비어 있어 표만 길어진다(거래명세서의 납품일 칸과 같은 규칙). */
const LoanDraws = ({ loan: l, onCancelDraw }) => {
  if (!l.draws?.length) return null
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row" style={{ marginBottom: 6, gap: 8, flexWrap: 'wrap' }}>
        <span className="text-sm fw-700">추가 차입 {l.draws.length}건</span>
        {/* 처음 얼마로 시작해 얼마가 됐는지 — 이게 안 보이면 원금이 왜 늘었는지 알 수 없다 */}
        <span className="text-xs text-muted2">
          최초 {fmtNum(l.initial_principal)}원 → 누적 {fmtNum(l.principal)}원
        </span>
      </div>
      <DataTable
        rows={l.draws}
        rowKey={d => d.id}
        columns={[
          { key: 'draw_date', header: '인출일', className: 'num text-sm' },
          { key: 'amount', header: '금액', align: 'right', className: 'num-cell fw-600', render: d => fmtNum(d.amount) },
          { key: 'memo', header: '메모', render: d => <span className="text-sm text-muted">{d.memo || '—'}</span> },
          { key: 'act', header: '', width: 70, align: 'right', render: d => (
            <button className="btn ghost sm" style={{ fontSize: 10, padding: '1px 5px' }}
              title="이 인출을 되돌립니다 — 입금 거래도 함께 지워져요"
              onClick={() => onCancelDraw(l, d)}>취소</button>
          )},
        ]}/>
    </div>
  )
}

const LoanSchedule = ({ loan: l, onRepay, onCancel, onCancelDraw }) => (
  <div style={{ padding: 16 }}>
    <LoanDraws loan={l} onCancelDraw={onCancelDraw}/>
    <div className="row" style={{ marginBottom: 8, gap: 16, flexWrap: 'wrap' }}>
      <span className="text-sm">총 이자 <b className="num">{fmtNum(l.totals?.interest || 0)}</b>원</span>
      <span className="text-sm">총 상환 <b className="num">{fmtNum(l.totals?.total || 0)}</b>원</span>
      <span className="text-sm">처리 {l.paid_count}/{l.totals?.months}회차</span>
    </div>
    <div style={{ maxHeight: 280, overflowY: 'auto' }}>
      <DataTable
        rows={l.schedule || []}
        rowKey={c => c.seq}
        columns={[
          { key: 'seq', header: '회차', width: 60, className: 'num text-muted2' },
          { key: 'due_date', header: '예정일', className: 'num text-sm' },
          { key: 'principal', header: '원금', align: 'right', className: 'num-cell', render: c => fmtNum(c.principal) },
          { key: 'interest', header: '이자', align: 'right', className: 'num-cell text-muted', render: c => fmtNum(c.interest) },
          { key: 'total', header: '납입액', align: 'right', className: 'num-cell fw-600', render: c => fmtNum(c.total) },
          { key: 'balance', header: '잔액', align: 'right', className: 'num-cell text-muted2', render: c => fmtNum(c.balance) },
          { key: 'act', header: '처리', width: 120, render: c => {
            const done = l.repayments.find(r => r.seq === c.seq && r.paid_date)
            if (done) return (
              <div className="row gap-4" style={{ alignItems: 'center' }}>
                <span className="badge pos" style={{ fontSize: 10 }}>{done.paid_date}</span>
                <button className="btn ghost sm" style={{ fontSize: 10, padding: '1px 5px' }}
                  onClick={() => onCancel(l, c.seq)}>취소</button>
              </div>
            )
            /* 0원 회차 — 무이자 만기일시의 거치 구간처럼 **정말 낼 것이 없는** 회차다.
               버튼을 지웠더니 그 회차를 넘길 수 없어 마지막 회차에 영영 도달 못 했다(회귀).
               거래는 안 생기고 회차만 넘어간다는 걸 라벨로 밝힌다. */
            if (l.next_cycle?.seq === c.seq && (Number(c.principal) + Number(c.interest)) <= 0) return (
              <button className="btn sm" style={{ fontSize: 10, padding: '2px 7px' }}
                onClick={() => onRepay({ loan: l, cycle: c })}>건너뛰기</button>
            )
            if (l.next_cycle?.seq === c.seq) return (
              <button className="btn sm primary" style={{ fontSize: 10, padding: '2px 7px' }}
                onClick={() => onRepay({ loan: l, cycle: c })}>상환 처리</button>
            )
            return <span className="text-xs text-muted2">앞선 회차부터</span>
          }},
        ]}/>
    </div>
  </div>
)

/* 투자 회수 — 받은 투자를 돌려주거나, 한 투자를 돌려받는다.
 *
 * 여태 회수를 적을 길이 **삭제밖에 없었다.** 지우면 "받았다가 돌려줬다"는 사실이 통째로
 * 사라져서, 그 해에 자본이 얼마나 들어오고 나갔는지를 되짚을 수 없다.
 *
 * ⚠ 방향에 따라 화면이 묻는 것이 다르다.
 *   받은 돈(in)  돌려주는 것 → 처분손익이 없다(감자다). 손익 칸을 아예 안 낸다.
 *   한 돈(out)   돌려받는 것 → 원금보다 더/덜 받은 차액이 처분손익이다. 그 칸을 낸다.
 *   안 쓰는 칸을 세워 두면 "여기 뭘 넣지"가 되고, 잘못 넣으면 손익이 틀어진다.
 */
const RedeemDrawer = ({ inv, accounts, onClose, onDone }) => {
  const toast = useToast()
  const [amount, setAmount] = useState('')
  const [gain, setGain] = useState('')
  const [date, setDate] = useState(localToday())
  const [accountId, setAccountId] = useState(inv?.account_id || '')
  const [rows, setRows] = useState([])
  const [busy, setBusy] = useState(false)
  const isIn = inv?.direction === 'in'

  const load = async () => setRows(await api.getInvestmentRedemptions(inv.id))
  useEffect(() => { if (inv) { setAmount(''); setGain(''); setDate(localToday()); load() } }, [inv?.id])
  if (!inv) return null

  const submit = async () => {
    setBusy(true)
    const res = await api.redeemInvestment(inv.id, {
      amount, gain: isIn ? 0 : gain, redeemed_at: date, account_id: accountId })
    setBusy(false)
    if (!res.ok) return toast.push(res.error, { tone: 'warn' })
    toast.push(isIn ? '환급을 기록했어요' : '회수를 기록했어요')
    onDone()
  }
  const cancel = async (r) => {
    const res = await api.cancelInvestmentRedeem(inv.id, r.id)
    if (!res.ok) return toast.push(res.error, { tone: 'warn' })
    toast.push('취소했어요'); load(); onDone(true)
  }

  return (
    <>
      <DrawerHead title={isIn ? '투자 환급' : '투자 회수'}
        sub={`${inv.counterparty} · 투자 ${fmtNum(inv.amount)}원 · 남은 원금 ${fmtNum(inv.remain_amount ?? inv.amount)}원`}
        onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div>
          <label className="label">{isIn ? '돌려준 금액' : '돌려받은 원금'} <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <MoneyInput value={amount} onChange={setAmount}/>
          <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
            {isIn
              ? '자본이 그만큼 줄어요. 손익에는 잡히지 않습니다.'
              : '투자자산이 그만큼 줄어요. 원금이라 손익에는 잡히지 않습니다.'}
          </div>
        </div>

        {/* 처분손익은 '한 돈'에만 있다 — 자본 환급은 매매가 아니라 감자다 */}
        {!isIn && (
          <div>
            <label className="label">손익 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
            <MoneyInput value={gain} onChange={setGain} allowNegative/>
            <div className="text-xs text-muted2" style={{ marginTop: 6, lineHeight: 1.7 }}>
              원금보다 <b>더</b> 받았으면 그 차액을 양수로 넣으세요 → 투자자산처분이익.<br/>
              <b>덜</b> 받았으면 음수로 넣으세요 → 투자자산처분손실. 원금 칸에 합쳐 넣으면 안 돼요.
            </div>
          </div>
        )}

        <div className="row gap-12">
          <div style={{ flex: 1 }}><label className="label">{isIn ? '돌려준 날' : '받은 날'}</label>
            <DateInput className="input" value={date} max={localToday()} onChange={e => setDate(e.target.value)}/>
          </div>
          <div style={{ flex: 1 }}><label className="label">{isIn ? '출금 계좌' : '입금 계좌'}</label>
            <Combobox value={accountId} allowAdd={false} onChange={setAccountId}
              options={accounts.filter(a => a.kind !== 'card').map(a => ({ value: a.id, label: a.name }))}
              placeholder="계좌 선택"/>
          </div>
        </div>

        {/* 이력 — 비어 있으면 안 그린다(이 앱의 규칙) */}
        {rows.length > 0 && (
          <div>
            <div className="label" style={{ marginBottom: 8 }}>지금까지</div>
            <table className="table">
              <thead><tr><th>날짜</th><th className="num-right">원금</th><th className="num-right">손익</th><th style={{ width: 70 }}></th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td className="num text-sm">{r.redeemed_at}</td>
                    <td className="num-cell num-right">{fmtNum(r.amount)}</td>
                    <td className="num-cell num-right" style={{ color: r.gain > 0 ? 'var(--pos-ink)' : r.gain < 0 ? 'var(--neg-ink)' : undefined }}>
                      {r.gain ? fmtNum(r.gain) : '—'}
                    </td>
                    <td>
                      <button className="btn sm" style={{ color: 'var(--neg-ink)' }} onClick={() => cancel(r)}>취소</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <DrawerFooter onCancel={onClose} onSave={submit} saveLabel={isIn ? '환급 기록' : '회수 기록'} busy={busy}/>
    </>
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
            <DateInput className="input" value={form.invested_at} onChange={e => f('invested_at', e.target.value)}/>
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
  const [redeem, setRedeem] = useState(null)   // 회수/환급 대상 투자
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
  /* ⚠ **남은 원금**을 더한다. 유치·집행 금액을 그대로 더하면 돌려준 돈이 자본에 그대로
     남는다 — 회수/환급을 넣기 전에는 둘이 늘 같아서 문제가 없었다.
     자본과 투자자산은 재무상태 숫자라, 부풀면 바로 아래 표의 '남은 원금'과 모순된다. */
  const remainOf = (r) => Number(r.remain_amount ?? r.amount) || 0
  const inRows = rows.filter(r => r.direction === 'in')
  const outRows = rows.filter(r => r.direction === 'out')
  const sumIn = inRows.reduce((s, r) => s + remainOf(r), 0)
  const sumOut = outRows.reduce((s, r) => s + remainOf(r), 0)
  const rawIn = inRows.reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const rawOut = outRows.reduce((s, r) => s + (Number(r.amount) || 0), 0)

  return (
    <div className="fade-up">
      <PageHeader title="투자"
        actions={<button className="btn primary" onClick={() => setFormOpen(true)}>
          <Icon.Plus size={14}/> 투자 등록
        </button>}/>

      <KpiRow cols={2} style={{ marginBottom: 20 }}>
        <Kpi label="투자받은 돈 · 자본" value={sumIn}
          hint={rawIn > sumIn
            ? `유치 ${fmtNum(rawIn)}원 중 ${fmtNum(rawIn - sumIn)}원 환급했어요`
            : '수익이 아니라 자본으로 잡혀요'}/>
        <Kpi label="투자한 돈 · 투자자산" value={sumOut}
          hint={rawOut > sumOut
            ? `집행 ${fmtNum(rawOut)}원 중 ${fmtNum(rawOut - sumOut)}원 회수했어요`
            : '비용이 아니라 자산으로 잡혀요'}/>
      </KpiRow>

      <div className="row" style={{ marginBottom: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="section-title" style={{ fontSize: 13 }}>투자 기록 {shown.length}건</div>
        <div className="row gap-6 ml-auto">
          {[['all', '전체'], ['in', '받은 돈'], ['out', '한 돈']].map(([v, l]) => (
            <button key={v} className={`chip ${dir === v ? 'active' : ''}`} onClick={() => setDir(v)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <DataTable
          rows={shown}
          empty="투자 기록이 없어요."
          columns={[
            { key: 'direction', header: '구분', width: 90, render: r => (
              <span className={`badge ${r.direction === 'in' ? 'brand' : 'outline'}`}>
                {r.direction === 'in' ? '받은 돈' : '한 돈'}</span>
            )},
            { key: 'counterparty', header: '상대', className: 'fw-700', sortable: true, render: r => (
              <>{r.counterparty}{r.vendor_name && <span className="text-xs text-muted2"> · {r.vendor_name}</span>}</>
            )},
            { key: 'invested_at', header: '일자', className: 'num text-sm', sortable: true },
            { key: 'amount', header: '금액', align: 'right', className: 'num-cell fw-700', sortable: true,
              sortValue: r => Number(r.amount) || 0, render: r => fmtNum(r.amount) },
            { key: 'detail', header: '내역', className: 'text-sm text-muted', render: r => (r.direction === 'in'
              ? <>자본금 {fmtNum(r.capital_amount)}{r.premium_amount > 0 && ` · 주식발행초과금 ${fmtNum(r.premium_amount)}`}</>
              : (r.memo || '투자자산')) },
            /* 회수 — 여태 이 자리가 비어 있어서 "돌려줬다/돌려받았다"를 적을 길이
               삭제밖에 없었다. 다 회수한 것은 그대로 남겨 이력이 보이게 한다. */
            { key: 'remain', header: '남은 원금', align: 'right', className: 'num-cell',
              render: r => (r.redeemed_count
                ? (r.remain_amount > 0
                    ? <span style={{ color: 'var(--warn-ink)', fontWeight: 700 }}>{fmtNum(r.remain_amount)}</span>
                    : <span className="badge outline" style={{ fontSize: 10 }}>전액 회수</span>)
                : <span className="text-muted2 text-xs">—</span>) },
            { key: 'act', header: '', width: 140, render: r => (
              <div className="row gap-6" style={{ justifyContent: 'flex-end' }}>
                <button className="btn" style={{ fontSize: 11, padding: '3px 8px' }}
                  onClick={() => setRedeem(r)}>{r.direction === 'in' ? '환급' : '회수'}</button>
                <button className="btn" style={{ fontSize: 11, padding: '3px 8px', color: 'var(--neg-ink)' }}
                  onClick={() => handleDelete(r)}>삭제</button>
              </div>
            )},
          ]}/>
      </div>

      <Drawer open={!!redeem} onClose={() => setRedeem(null)} width="min(480px,100vw)" label="투자 회수">
        <RedeemDrawer inv={redeem} accounts={accounts}
          onClose={() => setRedeem(null)}
          onDone={(keepOpen) => { load(); if (!keepOpen) setRedeem(null) }}/>
      </Drawer>

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
      <KpiRow cols={cards.length} style={{ marginBottom: 20 }}>
        {cards.map(c => <Kpi key={c.label} label={c.label} value={c.v || 0} hint={c.sub}/>)}
      </KpiRow>
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
