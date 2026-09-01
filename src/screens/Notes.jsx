import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Drawer, Combobox, MoneyInput, DateInput,
         localToday, Loading, StatusBadge, vendorLabel } from '../lib/ui'
import { api } from '../lib/api'
import { PageHeader } from '../lib/components/PageHeader'
import { DrawerHead } from '../lib/components/Drawer'
import { Kpi, KpiRow } from '../lib/components/Kpi'

/**
 * 어음 — 받을어음 · 지급어음.
 *
 * ⚠ **어음은 아직 현금이 아니다.** 화면 곳곳에서 그 사실을 말한다 —
 *   받은 걸 받은 돈으로 착각하면 통장에 없는 돈으로 계획을 세우게 된다.
 *
 * 흐름은 셋뿐이다: 등록 → (만기) 결제 / 부도.
 * 할인·배서양도는 아직 없다 — 실제로 하시게 되면 그때 더한다(없는 기능을 화면에 세우지 않는다).
 */

const KIND = {
  receivable: { label: '받을어음', desc: '거래처가 우리에게 준 어음', tone: 'pos',  money: '들어올 돈' },
  payable:    { label: '지급어음', desc: '우리가 거래처에 준 어음', tone: 'warn', money: '나갈 돈' },
}
const STATUS = {
  held:       { label: '보유 중', tone: 'brand' },
  settled:    { label: '결제됨',  tone: 'pos' },
  dishonored: { label: '부도',    tone: 'neg' },
}

/** 만기까지 며칠 — 지난 것은 음수. 보유 중인 것에만 뜻이 있다. */
const daysTo = (due, today) => {
  if (!due) return null
  const d = (new Date(due + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000
  return Math.round(d)
}

const dueLabel = (n, today) => {
  if (n.status !== 'held') return null
  const d = daysTo(n.dueOn, today)
  if (d == null) return null
  if (d < 0) return { text: `${-d}일 지남`, tone: 'neg' }
  if (d === 0) return { text: '오늘 만기', tone: 'warn' }
  if (d <= 7) return { text: `D-${d}`, tone: 'warn' }
  return { text: `D-${d}`, tone: '' }
}

/**
 * 어음 화면.
 *
 * 같은 화면이 세 군데에 걸린다 — 재무관리의 '어음'(양쪽을 한눈에)과,
 * 입출금의 '받을어음'·'지급어음'(한쪽만).
 *
 * 나눠 다는 이유: 어음은 자금 운용이기도 하지만, 경리에게는 **입금·출금 업무**다.
 * 받을어음을 확인하러 재무관리로 건너가야 하면 정기 입금 → 수시 입금 → 받을어음으로
 * 이어지는 흐름이 끊긴다. 재무관리를 아예 안 쓰는 회사도 어음은 쓴다.
 *
 * ⚠ 화면을 복제하지 않는다. kind 를 고정해 여는 것뿐이다 —
 *   복제하면 만기·부도 규칙이 두 벌이 되어 언젠가 어긋난다(routes/notes.js 와 같은 이유).
 *
 * @param fixedKind 'receivable' | 'payable' — 주면 그쪽만 열고 탭을 감춘다.
 */
export const NotesScreen = ({ fixedKind = null }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState(null)
  const [vendors, setVendors] = useState([])
  const [accounts, setAccounts] = useState([])
  /* 기본 탭 — **있는 쪽**을 먼저 연다.
     받을어음을 기본으로 두었더니, 지급어음만 있는 회사가 들어오면 빈 화면을 보고
     "등록했는데 없네?" 하게 됐다(실제로 검증 중에 그랬다). 회사마다 한쪽만 쓰는 일이 흔하다. */
  /* ⚠ fixedKind 를 useState 초기값으로 두면 안 된다 — 초기값은 첫 렌더에만 쓰여서,
     받을어음 → 지급어음으로 **메뉴를 갈아타도** 같은 컴포넌트가 살아남아 화면이 안 바뀐다
     (브레드크럼만 바뀌고 내용은 그대로였다). 고정 쪽은 state 를 거치지 않고 파생시킨다. */
  const [tabState, setTabState] = useState(null)
  const tab = fixedKind || tabState
  const setTab = setTabState
  const [formOpen, setFormOpen] = useState(false)
  const [edit, setEdit] = useState(null)
  const [settleTarget, setSettleTarget] = useState(null)
  const today = localToday()

  const load = async () => setRows(await api.getNotes())
  useEffect(() => {
    load()
    api.getVendors().then(setVendors)
    api.getAccounts().then(a => setAccounts(a.filter(x => x.kind === 'bank')))
  }, [])

  /* 처음 한 번만 — 사용자가 탭을 고른 뒤에는 그 선택을 존중한다(빈 쪽을 봐도 튕기지 않게). */
  useEffect(() => {
    if (fixedKind || tabState !== null || rows === null) return
    const held = rows.filter(n => n.status === 'held')
    const hasRecv = held.some(n => n.kind === 'receivable')
    setTab(hasRecv || !held.length ? 'receivable' : 'payable')
  }, [rows, tabState, fixedKind])

  const list = useMemo(() => (rows || []).filter(n => n.kind === (tab || 'receivable')), [rows, tab])
  const held = list.filter(n => n.status === 'held')
  /* ⚠ **지난 것과 임박한 것을 가른다.**
     한 칸에 묶었더니 "7일 안에 만기"에 이미 지난 어음이 섞여, 가장 급한 것이 묻혔다.
     만기가 지났는데 안 들어온 어음은 **부도 신호**다 — 임박한 것과 급한 정도가 다르다. */
  const 지남 = held.filter(n => { const d = daysTo(n.dueOn, today); return d != null && d < 0 })
  const 임박 = held.filter(n => { const d = daysTo(n.dueOn, today); return d != null && d >= 0 && d <= 7 })
  const 부도 = list.filter(n => n.status === 'dishonored')
  const sum = (a) => a.reduce((s, n) => s + (n.amount || 0), 0)

  if (rows === null || tab === null) return <Loading/>

  const K = KIND[tab] || KIND.receivable
  const isRecv = (tab || 'receivable') === 'receivable'

  return (
    <div className="fade-up">
      <PageHeader title={fixedKind ? K.label : '어음'}
        sub={`어음은 만기가 와야 현금이 됩니다. ${isRecv ? '여기 있는 돈은 아직 통장에 없어요.' : '여기 있는 돈은 아직 통장에서 안 나갔어요.'}`}
        actions={
          <button className="btn primary" onClick={() => { setEdit(null); setFormOpen(true) }}>
            <Icon.Plus size={14}/> 어음 등록
          </button>
        }/>

      {/* 한쪽만 여는 화면에서는 탭을 감춘다 — 메뉴로 이미 고른 것을 또 고르게 하지 않는다.
          ⚠ hidden 속성은 .row 의 display:flex 에 져서 그대로 보인다. 아예 안 그린다. */}
      {!fixedKind && <div className="row gap-8" style={{ marginBottom: 16 }}>
        {Object.entries(KIND).map(([k, v]) => (
          <button key={k} className={`chip ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {v.label} {(rows || []).filter(n => n.kind === k && n.status === 'held').length || ''}
          </button>
        ))}
      </div>}

      {/* 급한 순서대로 — 지난 것 · 곧 올 것 · 전체 · 부도 */}
      <KpiRow cols={4}>
        <Kpi label="만기 지남" value={sum(지남)} badge={`${지남.length}건`}
             hint={지남.length ? (isRecv ? '안 들어왔어요 · 부도 신호일 수 있어요' : '아직 안 냈어요') : undefined}
             tone={지남.length ? 'neg' : undefined}/>
        <Kpi label="7일 안에 만기" value={sum(임박)} badge={`${임박.length}건`}
             tone={임박.length ? 'warn' : undefined}/>
        {/* 이 칸은 보유 중 **전체**다 — 앞 두 칸(지남·임박)을 품고 있다.
            나란히 놓으면 더해서 읽기 쉬워서, 총계라는 걸 한 줄로 밝혀 둔다. */}
        <Kpi label={`보유 중 ${K.money}`} value={sum(held)} badge={`${held.length}건`}
             hint={(지남.length || 임박.length) ? '만기 지남·임박도 포함한 전체예요' : undefined}/>
        <Kpi label="부도" value={sum(부도)} badge={`${부도.length}건`}
             tone={부도.length ? 'neg' : undefined}/>
      </KpiRow>

      <div className="card" style={{ overflow: 'hidden', marginTop: 16 }}>
        {list.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center' }} className="text-sm text-muted">
            {K.label}이 없어요. {K.desc}을 여기에 적어두면 만기일이 자금 계획에 잡힙니다.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>만기일</th>
                <th style={{ width: 90 }}></th>
                <th>거래처</th>
                <th style={{ width: 140 }}>어음번호</th>
                <th style={{ width: 110 }}>발행일</th>
                <th style={{ width: 130, textAlign: 'right' }}>금액</th>
                <th style={{ width: 90 }}>상태</th>
                <th style={{ width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map(n => {
                const d = dueLabel(n, today)
                return (
                  <tr key={n.id}>
                    <td className="num">{n.dueOn}</td>
                    <td>{d && <span className={`badge ${d.tone}`} style={{ fontSize: 11 }}>{d.text}</span>}</td>
                    <td className="fw-600">{n.vendorName || '—'}
                      {n.invoiceNo && <span className="text-xs text-muted2" style={{ marginLeft: 6 }}>{n.invoiceNo}</span>}
                    </td>
                    <td className="text-sm num">{n.noteNo || '—'}</td>
                    <td className="num text-sm text-muted">{n.issuedOn}</td>
                    <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(n.amount)}</td>
                    <td><StatusBadge status={STATUS[n.status]?.label || n.status} tone={STATUS[n.status]?.tone}/></td>
                    <td>
                      <div className="row gap-6" style={{ justifyContent: 'flex-end' }}>
                        {n.status === 'held' && (
                          <>
                            <button className="btn sm primary" onClick={() => setSettleTarget(n)}>
                              {n.kind === 'receivable' ? '입금 처리' : '지급 처리'}
                            </button>
                            <button className="btn sm" onClick={async () => {
                              const ok = await confirm({
                                tone: 'warn', title: '부도 처리할까요?',
                                body: n.invoiceNo
                                  ? `청구서 ${n.invoiceNo}가 다시 미수로 돌아갑니다. 못 받은 돈이 장부에서 사라지지 않게요.`
                                  : '이 어음을 부도로 표시합니다.',
                                confirmLabel: '부도 처리',
                              })
                              if (!ok) return
                              const res = await api.dishonorNote(n.id)
                              if (!res.ok) return toast.push(res.error || '처리하지 못했어요', { tone: 'warn' })
                              toast.push(res.restored ? '부도 처리하고 청구서를 미수로 되돌렸어요' : '부도 처리했어요')
                              load()
                            }}>부도</button>
                            <button className="btn sm" onClick={() => { setEdit(n); setFormOpen(true) }}>수정</button>
                          </>
                        )}
                        {n.status === 'settled' && (
                          <button className="btn sm" onClick={async () => {
                            const ok = await confirm({
                              tone: 'warn', title: '결제를 되돌릴까요?',
                              body: '그때 만든 입출금 거래도 함께 지워집니다.', confirmLabel: '되돌리기',
                            })
                            if (!ok) return
                            const res = await api.unsettleNote(n.id)
                            if (!res.ok) return toast.push(res.error || '되돌리지 못했어요', { tone: 'warn' })
                            toast.push('결제를 되돌렸어요'); load()
                          }}>되돌리기</button>
                        )}
                        {n.status !== 'settled' && (
                          <button className="btn sm" onClick={async () => {
                            const ok = await confirm({
                              tone: 'neg', title: '어음을 지울까요?',
                              body: n.invoiceNo ? `청구서 ${n.invoiceNo}에 붙여 둔 정산도 함께 걷습니다.` : '',
                              confirmLabel: '지우기',
                            })
                            if (!ok) return
                            const res = await api.deleteNote(n.id)
                            if (!res.ok) return toast.push(res.error || '지우지 못했어요', { tone: 'warn' })
                            toast.push('지웠어요'); load()
                          }}><Icon.Trash size={13}/></button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <NoteForm open={formOpen} note={edit} defaultKind={tab} vendors={vendors}
        onClose={() => { setFormOpen(false); setEdit(null) }}
        onSaved={() => { setFormOpen(false); setEdit(null); load() }}/>

      <SettleDrawer target={settleTarget} accounts={accounts}
        onClose={() => setSettleTarget(null)}
        onDone={() => { setSettleTarget(null); load() }}/>
    </div>
  )
}

/* 등록·수정 — 청구서에 붙이는 것은 **등록할 때만**. 이미 붙은 어음의 금액을 바꾸면
   청구서 정산액과 어긋나므로 서버가 막는다(routes/notes.js PUT). */
const NoteForm = ({ open, note, defaultKind, vendors, onClose, onSaved }) => {
  const toast = useToast()
  const [f, setF] = useState({})
  const [invoices, setInvoices] = useState([])
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))

  useEffect(() => {
    if (!open) return
    setF(note ? {
      kind: note.kind, noteNo: note.noteNo, vendorId: note.vendorId,
      amount: String(note.amount || ''), issuedOn: note.issuedOn, dueOn: note.dueOn,
      invoiceId: note.invoiceId || '', memo: note.memo,
    } : {
      kind: defaultKind, noteNo: '', vendorId: '', amount: '',
      issuedOn: localToday(), dueOn: '', invoiceId: '', memo: '',
    })
  }, [open, note, defaultKind])

  /* 붙일 수 있는 청구서 — 아직 덜 정산된 것만. 방향에 맞는 것만 보여준다
     (받을어음은 우리가 발행한 것, 지급어음은 받은 것). */
  useEffect(() => {
    if (!open || note) return
    const kind = f.kind === 'receivable' ? 'issued' : 'received'
    api.getInvoices({ kind }).then(list =>
      setInvoices((list || []).filter(i => (Number(i.remainAmount) || 0) > 0)))
  }, [open, note, f.kind])

  if (!open) return null
  const K = KIND[f.kind] || KIND.receivable

  const save = async () => {
    setBusy(true)
    const body = {
      kind: f.kind, note_no: f.noteNo, vendor_id: f.vendorId, amount: f.amount,
      issued_on: f.issuedOn, due_on: f.dueOn, memo: f.memo,
      ...(note ? {} : { invoice_id: f.invoiceId || null }),
    }
    const res = note ? await api.updateNote(note.id, body) : await api.addNote(body)
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '저장하지 못했어요', { tone: 'warn' })
    toast.push(note ? '고쳤어요' : '어음을 등록했어요')
    onSaved()
  }

  return (
    <Drawer open={open} onClose={onClose} width="min(560px,100vw)" label="어음">
      <DrawerHead title={note ? '어음 수정' : '어음 등록'}
        sub={note ? null : '받은(또는 끊어 준) 어음을 대장에 올립니다'} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        {!note && (
          <div>
            <label className="label">어느 쪽 어음인가요? <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <div className="row gap-6">
              {Object.entries(KIND).map(([k, v]) => (
                <button key={k} type="button" className={`chip ${f.kind === k ? 'active' : ''}`}
                  onClick={() => set('kind', k)}>{v.label}</button>
              ))}
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>{K.desc}</div>
          </div>
        )}

        <div>
          <label className="label">거래처 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <Combobox value={f.vendorId} onChange={v => set('vendorId', v)} allowAdd={false}
            options={vendors.map((v, _i, arr) => ({ value: v.id, label: vendorLabel(v, arr), sub: v.type }))}
            placeholder={f.kind === 'receivable' ? '어음을 준 곳' : '어음을 준 상대'}/>
        </div>

        <div className="row gap-12">
          <div style={{ flex: 1 }}>
            <label className="label">어음번호</label>
            <input className="input num" value={f.noteNo || ''} onChange={e => set('noteNo', e.target.value)}
              placeholder="예: 자가12345678"/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">금액 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <MoneyInput value={f.amount} onChange={raw => set('amount', raw)}/>
          </div>
        </div>

        <div className="row gap-12">
          <div style={{ flex: 1 }}>
            <label className="label">발행일 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <DateInput className="input num" value={f.issuedOn || ''} onChange={e => set('issuedOn', e.target.value)}/>
          </div>
          <div style={{ flex: 1 }}>
            <label className="label">
              만기일 <span style={{ color: 'var(--neg-ink)' }}>*</span>
              <span className="text-muted2 fw-600" style={{ marginLeft: 6, fontWeight: 400 }}>· 현금이 되는 날</span>
            </label>
            <DateInput className="input num" value={f.dueOn || ''} onChange={e => set('dueOn', e.target.value)}/>
          </div>
        </div>

        {!note && (
          <div>
            <label className="label">어느 청구서를 대신하나요? <span className="text-muted2">(선택)</span></label>
            <Combobox value={f.invoiceId} onChange={v => set('invoiceId', v)} allowAdd={false}
              options={[{ value: '', label: '연결 안 함' },
                ...invoices.map(i => ({
                  value: i.id,
                  label: `${i.invoiceNo || ''} ${i.vendor || ''}`.trim(),
                  sub: `남은 ${fmtNum(i.remainAmount)}원`,
                }))]}
              placeholder="청구서 선택 (선택)"/>
            {/* 이게 이 기능의 핵심이라 화면에서도 밝힌다 */}
            <div className="text-xs text-muted2" style={{ marginTop: 6, lineHeight: 1.7 }}>
              연결하면 그 청구서는 <b>정산된 것으로 처리</b>돼요. 다만 <b>통장 잔액은 그대로</b>예요 —
              어음은 만기가 와야 현금이 되니까요. 부도가 나면 그 청구서는 다시 미수로 돌아옵니다.
            </div>
          </div>
        )}

        <div>
          <label className="label">메모 <span className="text-muted2">(선택)</span></label>
          <input className="input" value={f.memo || ''} onChange={e => set('memo', e.target.value)}
            placeholder="예: 3개월 만기, 은행 지점 확인"/>
        </div>
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" disabled={busy} onClick={save}>
          <Icon.Check size={14}/> {busy ? '저장 중…' : '저장'}
        </button>
      </div>
    </Drawer>
  )
}

/* 만기 결제 — **여기서 처음으로 돈이 움직인다.** 계좌를 반드시 고르게 한다. */
const SettleDrawer = ({ target, accounts, onClose, onDone }) => {
  const toast = useToast()
  const [accountId, setAccountId] = useState('')
  const [date, setDate] = useState(localToday())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!target) return
    setDate(localToday())
    setAccountId(accounts[0]?.id || '')
  }, [target, accounts])

  if (!target) return null
  const recv = target.kind === 'receivable'

  return (
    <Drawer open={!!target} onClose={onClose} width="min(520px,100vw)" label="어음 결제">
      <DrawerHead title={recv ? '어음 입금 처리' : '어음 지급 처리'}
        sub={`${target.vendorName || ''} · ${fmtNum(target.amount)}원`} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="man-note" style={{ margin: 0 }}>
          <Icon.Help size={15}/>
          <div>
            만기가 되어 <b>{recv ? '실제로 들어온' : '실제로 나간'}</b> 것을 기록합니다.
            이제야 계좌 잔액이 움직여요.
          </div>
        </div>
        <div>
          <label className="label">{recv ? '입금 계좌' : '출금 계좌'} <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            {accounts.map(a => (
              <button key={a.id} type="button" className={`chip ${accountId === a.id ? 'active' : ''}`}
                onClick={() => setAccountId(a.id)}>{a.name}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">
            {recv ? '입금일' : '지급일'}
            <span className="text-muted2 fw-600" style={{ marginLeft: 6, fontWeight: 400 }}>· 기본값: 오늘</span>
          </label>
          <DateInput className="input num" value={date} onChange={e => setDate(e.target.value)}/>
        </div>
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" disabled={busy} onClick={async () => {
          setBusy(true)
          const res = await api.settleNote(target.id, { account_id: accountId, date })
          setBusy(false)
          if (!res.ok) return toast.push(res.error || '처리하지 못했어요', { tone: 'warn' })
          toast.push(recv ? '입금 처리했어요' : '지급 처리했어요')
          onDone()
        }}>
          <Icon.Check size={14}/> {busy ? '처리 중…' : (recv ? '입금 처리' : '지급 처리')}
        </button>
      </div>
    </Drawer>
  )
}
