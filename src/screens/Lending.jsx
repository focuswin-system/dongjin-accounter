import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Combobox, MoneyInput, DateInput, Drawer, localToday } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { DataTable } from '../lib/components/DataTable'
import { api } from '../lib/api'

/**
 * 대여금 — 우리가 **빌려준** 돈. 차입금의 거울상이다.
 *
 * ── 왜 필요한가 ──
 * 빌려준 돈은 적을 자리가 아예 없었다. 계정과목에 `1301 단기대여금`·`1503 장기대여금` 이
 * 있는데도 그걸 쓰는 화면이 없어서, 지출 한 건으로만 남고 **언제 얼마를 받기로 했는지가
 * 어디에도 없었다.** 빌려준 돈은 안 적으면 잊힌다.
 *
 * ── 차입금과 무엇이 같고 무엇이 다른가 ──
 * 원리금 일정 계산은 **같은 함수**를 쓴다(서버 lib/loan.js). 공식은 돈의 방향과 무관하다.
 * 다른 것은 방향과 계정뿐이다:
 *   차입  실행=입금(부채↑) · 상환=출금 · 이자=비용
 *   대여  실행=출금(자산↑) · 회수=입금 · 이자=수익
 *
 * ⚠ 원금과 이자를 **나눠서** 기록한다. 원금 회수는 자산이 통장으로 돌아온 것뿐이라
 *   손익이 아니고 이자만 수익이다. 합치면 원금까지 매출로 잡혀 손익이 부푼다.
 */

const METHOD_OPTS = [
  { value: 'bullet',           label: '만기일시', hint: '이자만 받다가 만기에 원금을 한 번에' },
  { value: 'equal_payment',    label: '원리금균등', hint: '매달 같은 금액(원금+이자)' },
  { value: 'equal_principal',  label: '원금균등',  hint: '매달 같은 원금 + 남은 원금의 이자' },
  { value: 'none',             label: '정하지 않음', hint: '일정 없이 받을 때마다 기록 — 개인 대여에 흔하다' },
]
const methodLabel = (m) => METHOD_OPTS.find(o => o.value === m)?.label || '만기일시'

const emptyForm = () => ({
  name: '', borrower: '', vendor_id: '', principal: '', annual_rate: '',
  method: 'bullet', term_months: 12, start_date: localToday(), pay_day: 25,
  account_id: '', memo: '', recorded: true,
})

export const LendingScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState([])
  const [vendors, setVendors] = useState([])
  const [accounts, setAccounts] = useState([])
  const [form, setForm] = useState(null)      // 등록/수정 폼
  const [detail, setDetail] = useState(null)  // 상세(회차)
  /* 다음에 받을 회차 — 서버가 순서를 강제하므로(routes/lending.js:250~) 화면도 그 회차에만
     버튼을 낸다. 저장된 회차가 곧 받은 회차라 아직 안 받은 첫 회차가 다음 차례다. */
  const nextSeq = detail?.schedule?.find(c => !c.paid_date)?.seq
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const [ls, vs, as] = await Promise.all([api.getLendings(), api.getVendors(), api.getAccounts()])
    setRows(ls || []); setVendors(vs || []); setAccounts(as || [])
    // 상세를 열어둔 채 회수하면 목록만 새로고침되고 열린 상세는 옛 값 그대로였다 — 같은 건을 다시 물려준다
    setDetail(prev => prev ? (ls || []).find(r => r.id === prev.id) || null : prev)
  }
  useEffect(() => { load() }, [])

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  /* 저장 전에 "매달 얼마씩 몇 번" 을 보여준다 — 숫자를 보고 조건을 고칠 수 있어야 한다.
     저장한 뒤에 확인하면 지우고 다시 만들게 된다. */
  const doPreview = async () => {
    const r = await api.previewLending({
      principal: form.principal, annual_rate: form.annual_rate, method: form.method,
      term_months: form.term_months, start_date: form.start_date, pay_day: form.pay_day,
    })
    setPreview(r)
  }

  const save = async () => {
    if (!form.name?.trim()) return toast.push('대여 이름을 입력해주세요', { tone: 'warn' })
    setBusy(true)
    const body = { ...form, principal: form.principal, annual_rate: form.annual_rate }
    const res = form.id ? await api.updateLending(form.id, body) : await api.addLending(body)
    setBusy(false)
    if (!res.ok) return toast.push(res.error, { tone: 'warn' })
    toast.push(form.id ? '수정했어요' : '대여금을 등록했어요')
    setForm(null); setPreview(null); load()
  }

  const doCollect = async (l, c) => {
    const ok = await confirm({
      tone: 'brand', icon: <Icon.In size={22}/>, title: `${l.name} ${c.seq}회차 회수`,
      body: `원금 ${fmtNum(c.principal)}원 · 이자 ${fmtNum(c.interest)}원을 받은 것으로 기록해요.`,
      detail: '원금은 자산이 돌아온 것이라 손익에 안 잡히고, 이자만 이자수익으로 잡혀요.',
      confirmLabel: '회수 처리',
    })
    if (!ok) return
    const res = await api.collectLending(l.id, { seq: c.seq, account_id: l.account_id })
    if (!res.ok) return toast.push(res.error, { tone: 'warn' })
    toast.push('회수 처리했어요'); load()
  }

  const doCancel = async (l, c) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: '회수 취소',
      body: `${c.seq}회차 회수를 되돌려요.`,
      detail: '그때 만든 입금 거래도 함께 지워져요. 안 지우면 통장에는 들어왔는데 안 받은 것으로 남아 잔액이 안 맞습니다.',
      confirmLabel: '취소',
    })
    if (!ok) return
    const res = await api.cancelLendingCollect(l.id, c.seq)
    if (!res.ok) return toast.push(res.error, { tone: 'warn' })
    toast.push('회수를 취소했어요'); load()
  }

  const doDelete = async (l) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: '대여금 삭제',
      body: `«${l.name}» 을 지웁니다.`,
      detail: '잘못 등록한 것을 지우는 기능이에요. 실행 거래도 함께 지워집니다. 이미 회수한 이력이 있으면 지울 수 없어요.',
      confirmLabel: '삭제',
    })
    if (!ok) return
    const res = await api.deleteLending(l.id)
    if (!res.ok) return toast.push(res.error, { tone: 'warn' })
    toast.push('지웠어요'); setDetail(null); load()
  }

  const active = rows.filter(r => r.status !== 'closed')
  const lentOut = active.reduce((s, r) => s + Number(r.remain_principal || 0), 0)
  const overdue = active.reduce((s, r) => s + (r.overdue || 0), 0)

  return (
    <div className="fade-up">
      <PageHeader title="대여금"
        sub="회사가 빌려준 돈이에요. 원금은 받을 자산이고, 이자만 수익으로 잡힙니다."
        actions={<button className="btn primary" onClick={() => { setForm(emptyForm()); setPreview(null) }}>
          <Icon.Plus size={14}/> 대여 등록</button>}/>

      {/* 요약 — 비어 있으면 안 그린다(이 앱의 규칙) */}
      {active.length > 0 && (
        <div className="grid grid-4-to-2" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
          <div className="card card-pad">
            <div className="text-xs text-muted2">아직 못 받은 원금</div>
            <div className="num" style={{ fontSize: 22, fontWeight: 700 }}>{fmtNum(lentOut)}<span className="text-sm text-muted"> 원</span></div>
          </div>
          <div className="card card-pad">
            <div className="text-xs text-muted2">진행 중</div>
            <div className="num" style={{ fontSize: 22, fontWeight: 700 }}>{active.length}<span className="text-sm text-muted"> 건</span></div>
          </div>
          <div className="card card-pad">
            <div className="text-xs text-muted2">기한 지난 회차</div>
            <div className="num" style={{ fontSize: 22, fontWeight: 700, color: overdue ? 'var(--neg-ink)' : undefined }}>
              {overdue}<span className="text-sm text-muted"> 건</span></div>
          </div>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <DataTable
          rows={rows}
          onRowClick={setDetail}
          empty="빌려준 돈이 없어요. 개인·거래처에 빌려준 돈을 여기에 기록하면 언제 얼마를 받기로 했는지 남습니다."
          columns={[
            { key: 'name', header: '대여', sortable: true,
              render: l => <span className="fw-700">{l.name}</span> },
            { key: 'borrower', header: '빌려간 곳',
              render: l => <span className="text-sm text-muted">{l.borrower || l.vendor_name || '—'}</span> },
            { key: 'principal', header: '빌려준 금액', align: 'right', sortable: true,
              render: l => <span className="num-cell">{fmtNum(l.principal)}</span> },
            { key: 'remain_principal', header: '못 받은 원금', align: 'right', sortable: true,
              render: l => (l.remain_principal > 0
                ? <span className="num-cell" style={{ color: 'var(--warn-ink)', fontWeight: 700 }}>{fmtNum(l.remain_principal)}</span>
                : <span className="text-muted2 text-xs">다 받음</span>) },
            { key: 'method', header: '상환방식',
              render: l => <span className="text-sm">{methodLabel(l.method)}</span> },
            { key: 'annual_rate', header: '이율', align: 'right',
              render: l => <span className="text-sm num">{Number(l.annual_rate) > 0 ? `${l.annual_rate}%` : '무이자'}</span> },
            { key: 'overdue', header: '상태', align: 'center',
              render: l => (l.status === 'closed'
                ? <span className="badge outline" style={{ fontSize: 10 }}>종료</span>
                : l.overdue > 0
                  ? <span className="badge neg" style={{ fontSize: 10 }}>기한 지남 {l.overdue}</span>
                  : <span className="badge pos" style={{ fontSize: 10 }}>진행</span>) },
          ]}/>
      </div>

      {/* ── 상세: 회차 ── */}
      <Drawer open={!!detail} onClose={() => setDetail(null)} width="min(720px,100vw)" label="대여금 상세">
        {detail && (<>
          <DrawerHead title={detail.name}
            sub={`${detail.borrower || detail.vendor_name || '빌려간 곳 미지정'} · ${methodLabel(detail.method)} · ${Number(detail.annual_rate) > 0 ? `연 ${detail.annual_rate}%` : '무이자'}`}
            onClose={() => setDetail(null)}/>
          <div className="drawer-body">
            <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
              <div><div className="text-xs text-muted2">빌려준 원금</div><div className="num fw-700">{fmtNum(detail.principal)}</div></div>
              <div><div className="text-xs text-muted2">받은 원금</div><div className="num fw-700">{fmtNum(detail.collected_principal)}</div></div>
              <div><div className="text-xs text-muted2">받은 이자</div><div className="num fw-700" style={{ color: 'var(--pos-ink)' }}>{fmtNum(detail.collected_interest)}</div></div>
            </div>

            {/* 서버는 **순서대로만** 회수를 받는다(건너뛰면 남은 원금 누계가 어긋난다).
                그래서 버튼도 다음 회차에만 낸다 — 모든 행에 내면 눌러 봐야 "1회차부터
                처리해주세요" 만 돌아온다. 차입금 상환 화면과 같은 규칙(Finance.jsx:805~). */}
            {detail.schedule?.length > 0 ? (
              <table className="table">
                <thead><tr>
                  <th style={{ width: 56 }}>회차</th><th>예정일</th>
                  <th className="num-right">원금</th><th className="num-right">이자</th>
                  <th>상태</th><th style={{ width: 110 }}></th>
                </tr></thead>
                <tbody>
                  {detail.schedule.map(c => (
                    <tr key={c.seq}>
                      <td className="num text-sm">{c.seq}</td>
                      <td className="num text-sm">{c.due_date}</td>
                      <td className="num-cell num-right">{fmtNum(c.principal)}</td>
                      <td className="num-cell num-right">{fmtNum(c.interest)}</td>
                      <td>
                        {c.paid_date
                          ? <span className="badge pos" style={{ fontSize: 10 }}>{c.paid_date} 받음</span>
                          : c.due_date <= localToday()
                            ? <span className="badge neg" style={{ fontSize: 10 }}>기한 지남</span>
                            : <span className="text-xs text-muted2">예정</span>}
                      </td>
                      <td>
                        {c.paid_date
                          ? <button className="btn sm" style={{ color: 'var(--neg-ink)' }} onClick={() => doCancel(detail, c)}>취소</button>
                          : nextSeq === c.seq
                            ? <button className="btn sm primary" onClick={() => doCollect(detail, c)}>회수 처리</button>
                            : <span className="text-xs text-muted2">앞선 회차부터</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              /* 일정이 없는 대여('정하지 않음')는 회차 표가 뜻이 없다 — 빈 표 대신 무엇을 하면 되는지 적는다 */
              <div className="text-sm text-muted" style={{ padding: '20px 0' }}>
                상환 일정을 정하지 않은 대여예요. 받을 때마다 아래 «받은 금액 기록» 으로 남기면 됩니다.
              </div>
            )}
          </div>
          <div className="drawer-foot">
            <button className="btn" style={{ color: 'var(--neg-ink)' }} onClick={() => doDelete(detail)}>삭제</button>
            <div className="ml-auto row gap-8">
              <button className="btn" onClick={() => { setForm({ ...detail, recorded: false }); setDetail(null) }}>수정</button>
              <button className="btn primary" onClick={() => setForm({ _adhoc: detail })}>받은 금액 기록</button>
            </div>
          </div>
        </>)}
      </Drawer>

      {/* ── 수시 회수 ── */}
      <Drawer open={!!form?._adhoc} onClose={() => setForm(null)} width="min(420px,100vw)" label="받은 금액 기록">
        {form?._adhoc && <AdhocCollect l={form._adhoc} accounts={accounts}
          onClose={() => setForm(null)}
          onDone={() => { setForm(null); load() }}/>}
      </Drawer>

      {/* ── 등록/수정 ── */}
      <Drawer open={!!form && !form._adhoc} onClose={() => { setForm(null); setPreview(null) }}
        width="min(560px,100vw)" label="대여금 등록">
        {form && !form._adhoc && (<>
          <DrawerHead title={form.id ? '대여금 수정' : '대여금 등록'}
            sub="빌려준 돈이에요 — 통장에서 나가고 받을 자산이 늘어납니다"
            onClose={() => { setForm(null); setPreview(null) }}/>
          <div className="drawer-body col gap-form">
            <div><label className="label">대여 이름 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
              <input className="input" value={form.name} placeholder="예: 김대표 개인 대여"
                onChange={e => f('name', e.target.value)}/>
            </div>
            <div className="row gap-12">
              <div style={{ flex: 1 }}><label className="label">빌려간 곳</label>
                <input className="input" value={form.borrower} placeholder="이름 또는 상호"
                  onChange={e => f('borrower', e.target.value)}/>
              </div>
              <div style={{ flex: 1 }}><label className="label">거래처 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
                <Combobox value={form.vendor_id || ''} allowAdd={false}
                  onChange={v => f('vendor_id', v || null)}
                  options={[{ value: '', label: '연결 안 함' }, ...vendors.map(v => ({ value: v.id, label: v.name }))]}
                  placeholder="거래처 선택"/>
              </div>
            </div>
            <div className="row gap-12">
              <div style={{ flex: 1 }}><label className="label">빌려준 금액 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                <MoneyInput value={form.principal} onChange={raw => f('principal', raw)}/>
              </div>
              <div style={{ flex: 1 }}><label className="label">연이율 (%)</label>
                <input className="input num" type="number" step="0.01" min="0" value={form.annual_rate}
                  placeholder="0" onChange={e => f('annual_rate', e.target.value)}/>
                <div className="text-xs text-muted2" style={{ marginTop: 6 }}>비우면 무이자예요.</div>
              </div>
            </div>
            <div>
              <label className="label">상환방식</label>
              <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                {METHOD_OPTS.map(o => (
                  <button key={o.value} type="button" className={`chip ${form.method === o.value ? 'active' : ''}`}
                    onClick={() => { f('method', o.value); setPreview(null) }}>{o.label}</button>
                ))}
              </div>
              <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                {METHOD_OPTS.find(o => o.value === form.method)?.hint}
              </div>
            </div>
            {form.method !== 'none' && (
              <div className="row gap-12">
                <div style={{ flex: 1 }}><label className="label">기간 (개월)</label>
                  <input className="input num" type="number" min="1" value={form.term_months}
                    onChange={e => { f('term_months', e.target.value); setPreview(null) }}/>
                  <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                    12개월을 넘으면 장기대여금(1503)으로 잡아요.
                  </div>
                </div>
                <div style={{ flex: 1 }}><label className="label">회수일</label>
                  <input className="input num" type="number" min="1" max="28" value={form.pay_day}
                    onChange={e => { f('pay_day', e.target.value); setPreview(null) }}/>
                </div>
              </div>
            )}
            <div className="row gap-12">
              <div style={{ flex: 1 }}><label className="label">대여일 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                <DateInput className="input" value={form.start_date}
                  onChange={e => { f('start_date', e.target.value); setPreview(null) }}/>
              </div>
              <div style={{ flex: 1 }}><label className="label">출금 계좌</label>
                <Combobox value={form.account_id || ''} allowAdd={false}
                  onChange={v => f('account_id', v)}
                  options={accounts.filter(a => a.kind !== 'card').map(a => ({ value: a.id, label: a.name }))}
                  placeholder="계좌 선택"/>
              </div>
            </div>

            {/* 거래를 만들지 끌지 — 몇 년 전에 빌려준 돈을 뒤늦게 등록하면 그때 찍힌 출금과 겹친다 */}
            {!form.id && (
              <div>
                <label className="label">출금 기록</label>
                <div className="row gap-6">
                  {[[true, '지금 통장에서 나감'], [false, '이미 나간 돈 (기록만)']].map(([v, l]) => (
                    <button key={String(v)} type="button" className={`chip ${form.recorded === v ? 'active' : ''}`}
                      onClick={() => f('recorded', v)}>{l}</button>
                  ))}
                </div>
                <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                  {form.recorded
                    ? '대여일에 출금 거래를 만들어요.'
                    : '예전에 빌려준 돈을 뒤늦게 등록할 때 쓰세요 — 거래를 만들지 않아 계좌 잔액이 두 번 빠지지 않아요.'}
                </div>
              </div>
            )}

            {form.method !== 'none' && (
              <div>
                <button type="button" className="btn" onClick={doPreview}><Icon.Chart size={13}/> 회수 일정 미리보기</button>
                {preview?.schedule?.length > 0 && (
                  <div className="text-xs text-muted2" style={{ marginTop: 8, lineHeight: 1.8 }}>
                    {preview.schedule.length}회 · 원금 {fmtNum(preview.totals.principal)}원 + 이자 {fmtNum(preview.totals.interest)}원<br/>
                    첫 회차 {preview.schedule[0].due_date} · 원금 {fmtNum(preview.schedule[0].principal)}원 + 이자 {fmtNum(preview.schedule[0].interest)}원
                  </div>
                )}
              </div>
            )}
            <div><label className="label">메모</label>
              <input className="input" value={form.memo || ''} onChange={e => f('memo', e.target.value)}
                placeholder="차용증·공증 여부 등"/>
            </div>
          </div>
          <DrawerFooter onCancel={() => { setForm(null); setPreview(null) }} onSave={save}
            saveLabel={form.id ? '수정' : '등록'} busy={busy}/>
        </>)}
      </Drawer>
    </div>
  )
}

/** 수시 회수 — 일정 밖에서 받은 돈. 원금과 이자를 **따로** 받는다(합치면 손익이 부푼다). */
const AdhocCollect = ({ l, accounts, onClose, onDone }) => {
  const toast = useToast()
  const [principal, setPrincipal] = useState('')
  const [interest, setInterest] = useState('')
  const [date, setDate] = useState(localToday())
  const [accountId, setAccountId] = useState(l.account_id || '')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    const res = await api.collectLendingAdhoc(l.id, { principal, interest, date, account_id: accountId })
    setBusy(false)
    if (!res.ok) return toast.push(res.error, { tone: 'warn' })
    toast.push('기록했어요'); onDone()
  }
  return (<>
    <DrawerHead title="받은 금액 기록" sub={`${l.name} · 못 받은 원금 ${fmtNum(l.remain_principal)}원`} onClose={onClose}/>
    <div className="drawer-body col gap-form">
      <div><label className="label">원금</label>
        <MoneyInput value={principal} onChange={setPrincipal}/>
        <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
          받을 자산이 돌아온 거예요. 손익에는 잡히지 않아요.
        </div>
      </div>
      <div><label className="label">이자</label>
        <MoneyInput value={interest} onChange={setInterest}/>
        <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
          이자만 <b>이자수익</b>으로 잡혀요. 원금과 합쳐 넣으면 원금까지 수익이 됩니다.
        </div>
      </div>
      <div className="row gap-12">
        <div style={{ flex: 1 }}><label className="label">받은 날</label>
          <DateInput className="input" value={date} max={localToday()} onChange={e => setDate(e.target.value)}/>
        </div>
        <div style={{ flex: 1 }}><label className="label">입금 계좌</label>
          <Combobox value={accountId} allowAdd={false} onChange={setAccountId}
            options={accounts.filter(a => a.kind !== 'card').map(a => ({ value: a.id, label: a.name }))}
            placeholder="계좌 선택"/>
        </div>
      </div>
    </div>
    <DrawerFooter onCancel={onClose} onSave={submit} saveLabel="기록" busy={busy}/>
  </>)
}
