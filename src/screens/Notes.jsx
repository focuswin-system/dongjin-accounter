import { useState, useEffect, useMemo } from 'react'
import { useTableFilter } from '../lib/tableFilter'
import { TableToolbar } from '../lib/components/TableToolbar'
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
/** 어음 화면의 한 줄 설명. 재무관리의 어음 화면과 수시 입금·출금의 어음 탭이 같이 쓴다. */
export const NOTE_INTRO = (isRecv) =>
  `어음은 만기가 와야 현금이 됩니다. ${isRecv ? '여기 있는 돈은 아직 통장에 없어요.' : '여기 있는 돈은 아직 통장에서 안 나갔어요.'}`

/* 상태 칩 — '보유 중'이 기본이다. 할 일이 있는 것만 먼저 세운다. */
const STATUS_CHIPS = [
  { id: 'held',       label: '보유 중' },
  { id: 'settled',    label: '결제됨' },
  { id: 'dishonored', label: '부도' },
  { id: 'all',        label: '전체' },
]

/** 상태 칩 한 벌. 어음 화면과 수시 입금·출금의 어음 탭이 **같은 모양**으로 쓴다. */
export const NoteStatusChips = ({ rows, value, onChange }) => (
  <>
    {STATUS_CHIPS.map(c => {
      const n = c.id === 'all' ? (rows || []).length : (rows || []).filter(r => r.status === c.id).length
      return (
        <button key={c.id} type="button" className={`chip ${value === c.id ? 'active' : ''}`}
          onClick={() => onChange(c.id)}>
          {c.label}{n > 0 && <span className="text-muted2" style={{ marginLeft: 4 }}>{n}</span>}
        </button>
      )
    })}
  </>
)

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
 * 어음 KPI — 목록과 떼어 둔다.
 *
 * 수시 입금·출금 안에서는 이 카드가 **그 화면의 카드 줄 자리**에 서야 한다.
 * 탭 아래에 따로 그리면 탭 하나 눌렀다고 카드 줄이 사라졌다 다른 게 나타나면서
 * 화면이 통째로 재구성된 것처럼 보인다(Billing.jsx 가 툴바에 대해 경계하는 것과 같다).
 *
 * ⚠ 계산은 여기 한 곳에만 둔다 — 품은 화면이 자기 힘으로 다시 세면 규칙이 두 벌이 된다.
 */
export const NoteKpis = ({ rows, kind, today = localToday() }) => {
  const list = (rows || []).filter(n => n.kind === kind)
  const held = list.filter(n => n.status === 'held')
  const 지남 = held.filter(n => { const d = daysTo(n.dueOn, today); return d != null && d < 0 })
  const 임박 = held.filter(n => { const d = daysTo(n.dueOn, today); return d != null && d >= 0 && d <= 7 })
  const 부도 = list.filter(n => n.status === 'dishonored')
  const sum = (a) => a.reduce((s, n) => s + (n.amount || 0), 0)
  const isRecv = kind === 'receivable'
  const K = KIND[kind] || KIND.receivable
  /* 부도 카드는 **있을 때만** 세운다. 늘 '0건'으로 서 있으면 그 자리를 안 보게 되고
     (이 화면들이 '발행예정' 카드에 대해 이미 같은 판단을 했다), 카드가 셋이 되어
     품은 화면의 청구서 카드 줄과 폭도 맞는다. */
  const cols = 부도.length ? 4 : 3
  return (
    <KpiRow cols={cols}>
      <Kpi label="만기 지남" value={sum(지남)} badge={`${지남.length}건`}
           hint={지남.length ? (isRecv ? '안 들어왔어요 · 부도 신호일 수 있어요' : '아직 안 냈어요') : undefined}
           tone={지남.length ? 'neg' : undefined}/>
      <Kpi label="7일 안에 만기" value={sum(임박)} badge={`${임박.length}건`}
           tone={임박.length ? 'warn' : undefined}/>
      <Kpi label={`보유 중 ${K.money}`} value={sum(held)} badge={`${held.length}건`}
           hint={(지남.length || 임박.length) ? '만기 지남·임박도 포함한 전체예요' : undefined}/>
      {부도.length > 0 && <Kpi label="부도" value={sum(부도)} badge={`${부도.length}건`} tone="neg"/>}
    </KpiRow>
  )
}

/**
 * 어음 화면.
 *
 * 두 자리에 선다 — 재무관리의 '어음'(양쪽을 한눈에)과,
 * **수시 입금·수시 출금 안의 '어음' 탭**(그 화면에 맞는 한쪽만).
 *
 * 탭으로 들어가는 이유: 그 화면의 탭은 이미 '청구서를 보는 축'과 '돈을 보는 축'으로
 * 갈려 있다(발행내역 │ 입금내역). 어음은 **아직 돈이 아닌 것**이라 돈 축 바로 옆자리가
 * 제 자리다. 메뉴를 따로 세우면 청구서 → 입금 → 어음으로 이어지는 한 흐름이
 * 사이드바를 건너뛰어야 하는 세 곳으로 흩어진다.
 *
 * ⚠ 화면을 복제하지 않는다. kind 를 고정하고 머리를 끄는 것뿐이다 —
 *   복제하면 만기·부도 규칙이 두 벌이 되어 언젠가 어긋난다(routes/notes.js 와 같은 이유).
 *
 * @param fixedKind 'receivable' | 'payable' — 주면 그쪽만 열고 탭을 감춘다.
 * @param embedded  다른 화면의 탭 안에 들어갈 때. 제목·설명을 끈다(그 화면이 이미 머리를 갖고 있다).
 * @param onLoaded  목록을 읽을 때마다 부른다 — 품은 화면이 탭 건수를 자기 힘으로 다시 세지 않게.
 * @param openAddSignal 숫자가 바뀌면 등록 폼을 연다.
 * @param filter    품은 화면이 만든 useTableFilter 결과. 주면 툴바를 **그 화면 자리에** 두고
 *        여기서는 안 그린다 — 뼈대(카드 → 기간·검색 → 필터 → 표)를 어느 탭에서나 같게 하려면
 *        툴바가 탭 줄 위에 서야 한다. 여기서 그리면 탭 아래로 내려가 줄이 통째로 밀린다.
 * @param statusFilter/onStatusChange 상태 칩도 같은 이유로 밖에서 받을 수 있다.
 */
export const NotesScreen = ({
  fixedKind = null, embedded = false, onLoaded = null, openAddSignal = 0,
  filter = null, statusFilter = null, onStatusChange = null,
}) => {
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

  const load = async () => {
    const r = await api.getNotes()
    setRows(r)
    onLoaded?.(r)          // 등록·결제·부도 뒤에도 품은 화면의 탭 건수가 따라온다
  }
  useEffect(() => {
    load()
    api.getVendors().then(setVendors)
    api.getAccounts().then(a => setAccounts(a.filter(x => x.kind === 'bank')))
  }, [])

  // 품은 화면의 '어음 등록' 버튼 — 숫자가 오를 때만 연다(첫 렌더의 0 은 무시)
  useEffect(() => { if (openAddSignal > 0) { setEdit(null); setFormOpen(true) } }, [openAddSignal])

  /* 처음 한 번만 — 사용자가 탭을 고른 뒤에는 그 선택을 존중한다(빈 쪽을 봐도 튕기지 않게). */
  useEffect(() => {
    if (fixedKind || tabState !== null || rows === null) return
    const held = rows.filter(n => n.status === 'held')
    const hasRecv = held.some(n => n.kind === 'receivable')
    setTab(hasRecv || !held.length ? 'receivable' : 'payable')
  }, [rows, tabState, fixedKind])

  /* 청구서 탭과 **같은 뼈대**를 쓴다: 카드 → 기간·검색 → 필터 → 표.
     어음만 필터가 없으면 탭을 옮길 때마다 화면 구조가 바뀐 것처럼 보이고,
     어음이 수십 건 쌓이면 찾을 길도 없다.
     ⚠ 기간은 **만기일**에 건다 — 어음에서 사람이 찾는 날짜는 발행일이 아니라 만기일이다.
       기본은 전체다(청구서와 다르다): 어음은 건수가 적고, 만기가 몇 달 뒤라 이번 달로
       열면 정작 보유 중인 어음이 하나도 안 보인다. */
  const ownFlt = useTableFilter({
    date: { field: 'dueOn', initial: { from: '', to: '' } },
    search: { fields: ['noteNo', 'vendorName', 'invoiceNo', 'memo'], placeholder: '어음번호·거래처·청구번호 검색' },
    filters: [{ key: 'vendorName', label: '거래처', field: 'vendorName', inline: true,
      options: [...new Set((rows || []).map(n => n.vendorName).filter(Boolean))].sort() }],
  })
  const flt = filter || ownFlt
  /* 상태 칩 — 기본은 '보유 중'이다. 할 일이 있는 것만 먼저 보여준다(결제·부도는 끝난 일).
     '전체'로 열면 몇 년치 결제된 어음이 쌓여 정작 만기 임박한 것이 묻힌다. */
  const [ownStatusF, setOwnStatusF] = useState('held')
  const statusF = statusFilter ?? ownStatusF
  const setStatusF = onStatusChange || setOwnStatusF
  const kindRows = useMemo(() => (rows || []).filter(n => n.kind === (tab || 'receivable')), [rows, tab])
  const list = useMemo(() => {
    const byStatus = statusF === 'all' ? kindRows : kindRows.filter(n => n.status === statusF)
    return flt.apply(byStatus)
  }, [kindRows, statusF, flt.apply])
  /* ⚠ 지남·임박·부도 계산은 **NoteKpis 안에만** 둔다(위). 여기서 또 세면 규칙이 두 벌이 되어
     같은 어음이 화면 위아래에서 다른 건수로 나온다. */

  if (rows === null || tab === null) return <Loading/>

  const K = KIND[tab] || KIND.receivable
  const isRecv = (tab || 'receivable') === 'receivable'

  return (
    <div className="fade-up">
      {/* 탭 안에서는 머리를 통째로 끈다 — 제목·설명·등록 버튼은 품은 화면이 **자기 자리에**
          그린다(NOTE_INTRO 를 같이 쓴다). 여기서 또 그리면 제목이 둘이 되고, 무엇보다
          탭 아래에 줄이 하나 더 생겨 탭을 누를 때마다 표가 아래위로 뛴다. */}
      {embedded ? null : (
        <PageHeader title="어음"
          sub={NOTE_INTRO(isRecv)}
          actions={
            <button className="btn primary" onClick={() => { setEdit(null); setFormOpen(true) }}>
              <Icon.Plus size={14}/> 어음 등록
            </button>
          }/>
      )}

      {/* 한쪽만 여는 화면에서는 탭을 감춘다 — 메뉴로 이미 고른 것을 또 고르게 하지 않는다.
          ⚠ hidden 속성은 .row 의 display:flex 에 져서 그대로 보인다. 아예 안 그린다. */}
      {!fixedKind && <div className="row gap-8" style={{ marginBottom: 16 }}>
        {Object.entries(KIND).map(([k, v]) => (
          <button key={k} className={`chip ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {v.label} {(rows || []).filter(n => n.kind === k && n.status === 'held').length || ''}
          </button>
        ))}
      </div>}

      {/* 급한 순서대로 — 지난 것 · 곧 올 것 · 전체 · (있으면) 부도.
          탭 안에서는 안 그린다 — 품은 화면이 **자기 카드 줄 자리**에 세운다. */}
      {!embedded && <NoteKpis rows={rows} kind={tab}/>}

      {/* 카드 → 기간·검색 → 필터 → 표. 청구서 화면과 **같은 뼈대**다 —
          탭을 옮겼다고 뼈대가 달라지면 같은 화면이 아닌 것처럼 읽힌다.
          주입받았으면(탭 안) 이 둘은 품은 화면이 자기 자리에 그린다. */}
      {!filter && (
        <>
          <TableToolbar {...flt.toolbarProps} periodPicker
            right={<span className="text-xs text-muted2">만기일 기준</span>}/>
          <div className="row gap-8" style={{ marginTop: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <NoteStatusChips rows={kindRows} value={statusF} onChange={setStatusF}/>
          </div>
        </>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        {list.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center' }} className="text-sm text-muted">
            {flt.isFiltered || statusF !== 'all'
              ? '조건에 맞는 어음이 없어요. 기간이나 상태를 넓혀 보세요.'
              : `${K.label}이 없어요. ${K.desc}을 여기에 적어두면 만기일이 자금 계획에 잡힙니다.`}
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
