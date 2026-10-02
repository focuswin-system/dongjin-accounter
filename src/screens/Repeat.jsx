import { useState, useEffect, useMemo } from 'react'
import { categoryOption } from '../lib/categoryWords'
import { useOrdersFromMes } from '../lib/customModules'
import { Icon, fmtNum, useToast, useConfirm, Drawer, Combobox, MoneyInput, DateInput, fmtDateShort } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { RowActions } from '../lib/components/RowActions'
import { DataTable, Sub } from '../lib/components/DataTable'
import { SelectionBar } from '../lib/components/SelectionBar'
import { contractsForVendor, contractFitsVendor } from '../lib/contractPick'
import { BILLING_PERIODS, periodLong, PAY_TERM_OPTS, payTermNeedsDay, payTermHint } from '../lib/renewal'
import { vatOf } from '../lib/vatRate'
import { api } from '../lib/api'

/* 반복거래 — 매달 비슷하게 오가는 돈을 **목록에서 골라 한 번에 만든다.**
 *
 * 옛 정기 입금·정기 출금(회차·놓친 회차·소급·건너뛰기)을 대신한다. 회차를 기억하지 않는다 —
 * 그 달에 이 반복거래로 만든 청구서·거래가 있는지만 서버가 계산해 준다(server/lib/repeat.js).
 * 설계: docs/02-design/features/repeat-templates.design.md
 */

const pad = (n) => String(n).padStart(2, '0')
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const shiftYm = (ym, n) => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}
const ymLabel = (ym) => `${ym.slice(0, 4)}년 ${Number(ym.slice(5, 7))}월`
const lastDayOf = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(y, m, 0).getDate())}` }
const dirLabel = (d) => (d === 'in' ? '입금' : '출금')
const createsLabel = (r) => (r.direction === 'in' ? '청구서' : r.creates === 'txn' ? '바로 출금' : '청구서')

const VAT_OPTS = [['exclusive', '부가세 별도'], ['inclusive', '부가세 포함'], ['none', '면세'], ['zero', '영세']]

/* prefill — 거래를 적은 뒤 반복 제안에서 [반복거래로 등록]을 누르고 온 경우(3단계).
   그 거래를 본뜬 값으로 등록 서랍을 열어 준다. id 가 없으니 저장하면 새로 등록된다. */
export const RepeatScreen = ({ goRoute, initialDirection = 'all', prefill = null, onPrefillUsed }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [ym, setYm] = useState(localToday().slice(0, 7))
  const [dir, setDir] = useState(initialDirection)
  const [view, setView] = useState('month')        // month | all
  const [rows, setRows] = useState(null)
  const [templates, setTemplates] = useState(null)
  const [picked, setPicked] = useState(() => new Set())
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [createRows, setCreateRows] = useState(null)   // 만들기 확인 서랍
  const [q, setQ] = useState('')                       // 검색 — 거래처·내용·계약
  const [vendor, setVendor] = useState('')             // 거래처 필터(이름)
  const [showMade, setShowMade] = useState(false)      // 달별 — 이미 만든 줄 펼치기

  const loadMonth = async () => { setRows(await api.getRepeatMonth(ym)); setPicked(new Set()) }
  const loadAll = async () => setTemplates(await api.getRepeatTemplates())
  useEffect(() => { loadMonth() }, [ym])
  useEffect(() => { if (view === 'all') loadAll() }, [view])
  /* 보이는 것만 고른 것이다 — 입금/출금 칩이나 보기를 바꾸면 선택을 푼다.
     안 그러면 화면에 없는 줄이 '선택한 N건'에 섞여 확인 서랍에서 처음 보게 된다. */
  useEffect(() => { setPicked(new Set()) }, [dir, view, q, vendor])
  const reload = () => { loadMonth(); if (view === 'all' || templates) loadAll() }

  /* 방향 · 거래처 · 검색을 한 번에 거른다. 검색은 거래처·내용·계약 이름에 걸린다(달별은 치환된 내용, 전체 목록은 틀의 내용) */
  const term = q.trim().toLowerCase()
  const byDir = (list) => (list || []).filter(r =>
    (dir === 'all' || r.direction === dir)
    && (!vendor || (r.vendor_name || '') === vendor)
    && (!term || [r.vendor_name, r.item_text, r.item, r.contract_name].some(v => String(v || '').toLowerCase().includes(term))))
  // 거래처 필터 목록 — 등록된 반복거래에 실제로 나오는 거래처만(모든 거래처를 늘어놓으면 고를 게 너무 많다)
  const vendorOpts = useMemo(() => {
    const names = new Set([...(rows || []), ...(templates || [])].map(r => r.vendor_name).filter(Boolean))
    return [...names].sort((a, b) => a.localeCompare(b, 'ko')).map(n => ({ value: n, label: n }))
  }, [rows, templates])
  const monthRows = byDir(rows)
  const allRows = byDir(templates)
  // 손볼 것이 남은 줄(비목·계좌 없음)은 고를 수 없다 — 골라도 서버가 막고, 만들기는 전부 아니면 전무다(아래 select.isSelectable)

  /* 달별은 **할 일 목록**이다 — 만들 것과 이미 만든 것을 가른다(2026-10-01 사용자 · 40건 시험).
     섞어 두면 처리할수록 목록이 줄지 않고, 어디까지 했는지 눈으로 다시 찾아야 한다.
     만든 것은 접어 두고 필요하면 편다. ⚠ 달별은 끊어 보지 않는다(pageSize 0) — 한 줄이라도
     안 보이면 그달 청구서가 빠진다(놓친 회차). */
  const pendingRows = monthRows.filter(r => !r.made)
  const madeRows = monthRows.filter(r => r.made)

  const openCreate = async () => {
    const res = await api.previewRepeat(ym, [...picked])
    if (!res.ok) return toast.push(res.error || '불러오지 못했어요', { tone: 'warn' })
    if (!res.rows.length) return toast.push('만들 반복거래가 없어요')
    setCreateRows(res.rows)
  }

  const openInvoiceOrTxn = (made, r) => {
    if (!goRoute || !made) return
    if (made.type === 'invoice') goRoute(r.direction === 'in' ? 'billing_issued' : 'billing_received', { invoiceId: made.id })
    else goRoute('ledger', { txnId: made.id })
  }

  const handleDelete = async (t) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: '반복거래 삭제',
      body: `${t.vendor_name ? `${t.vendor_name} · ` : ''}${t.item} — 앞으로 목록에 뜨지 않아요.`,
      detail: '이미 만든 청구서와 거래는 그대로 남습니다. 잠시 멈추려면 끄기를 쓰세요.',
      confirmLabel: '삭제',
    })
    if (!ok) return
    const res = await api.deleteRepeatTemplate(t.id)
    if (!res.ok) return toast.push(res.error || '삭제하지 못했어요', { tone: 'warn' })
    toast.push('삭제했어요')
    reload()
  }
  const handleToggle = async (t) => {
    const res = await api.toggleRepeatTemplate(t.id)
    if (!res.ok) return toast.push(res.error || '바꾸지 못했어요', { tone: 'warn' })
    toast.push(res.active ? '켰어요' : '껐어요 — 목록에 뜨지 않아요')
    reload()
  }
  const openEdit = (t) => { setEditing(t); setFormOpen(true) }
  useEffect(() => {
    if (!prefill) return
    setEditing({ ...prefill, active: 1 }); setFormOpen(true)
    onPrefillUsed?.()
  }, [prefill])

  const pickedTotal = monthRows.filter(r => picked.has(r.id)).reduce((s, r) => s + r.total, 0)

  return (
    <div className="fade-up">
      <PageHeader title="반복거래"
        actions={<button className="btn primary" onClick={() => { setEditing(null); setFormOpen(true) }}><Icon.Plus size={14}/> 반복거래</button>}/>

      <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div className="row gap-6">
          {[['month', '달별'], ['all', '전체 목록']].map(([v, l]) => (
            <button key={v} className={`chip ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>{l}</button>
          ))}
        </div>
        <div className="row gap-6">
          {[['all', '전체'], ['in', '입금'], ['out', '출금']].map(([v, l]) => (
            <button key={v} className={`chip ${dir === v ? 'active' : ''}`} onClick={() => setDir(v)}>{l}</button>
          ))}
        </div>
        <div className="search" style={{ margin: 0, width: 220, padding: '6px 10px' }}>
          <Icon.Search size={14}/>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="거래처·내용 검색"/>
          {q && <button type="button" className="icon-btn" aria-label="검색어 지우기" onClick={() => setQ('')}><Icon.Close size={12}/></button>}
        </div>
        <div className="row gap-4" style={{ alignItems: 'center', width: 200 }}>
          {/* 문서 목록의 거래처 필터와 같은 낮은 칸(.doc-filters-vendor) — 옆 검색칸·칩과 높이를 맞춘다 */}
          <div className="doc-filters-vendor">
            <Combobox value={vendor} onChange={v => setVendor(v || '')} options={vendorOpts} allowAdd={false} placeholder="거래처 전체"/>
          </div>
          {vendor && <button type="button" className="icon-btn" aria-label="거래처 필터 지우기" onClick={() => setVendor('')}><Icon.Close size={12}/></button>}
        </div>
        {view === 'month' && (
          <div className="row gap-4 ml-auto" style={{ alignItems: 'center' }}>
            <button className="btn ghost sm" aria-label="이전 달" onClick={() => setYm(shiftYm(ym, -1))}><Icon.Left size={14}/></button>
            <span className="fw-700" style={{ minWidth: 96, textAlign: 'center' }}>{ymLabel(ym)}</span>
            <button className="btn ghost sm" aria-label="다음 달" onClick={() => setYm(shiftYm(ym, 1))}><Icon.Right size={14}/></button>
          </div>
        )}
      </div>

      {view === 'month' ? (
        <>
          <div className="text-sm text-muted" style={{ marginBottom: 8 }}>
            만들 것 <b className="num" style={{ color: 'var(--ink)' }}>{pendingRows.length}</b>건
          </div>
          <div className="card" style={{ overflow: 'hidden' }}>
            <DataTable
              tableKey="repeat-month" rows={pendingRows} loading={rows === null} pageSize={0}
              rowKey={r => r.id}
              select={{
                ids: [...picked], onChange: ids => setPicked(new Set(ids)),
                isSelectable: r => !r.needs_fix,
                disabledHint: r => r.needs_fix,
              }}
              onRowClick={openEdit}
              empty={term || vendor ? '조건에 맞는 반복거래가 없어요.'
                : madeRows.length ? `${ymLabel(ym)}에 만들 것을 다 만들었어요.` : `${ymLabel(ym)}에 해당하는 반복거래가 없어요.`}
              columns={[
                { key: 'date', header: '날짜', sortable: true, sortValue: r => r.date || '9999',
                  render: r => (r.date ? fmtDateShort(r.date) : <span className="text-muted2">만들 때 고름</span>) },
                { key: 'direction', header: '구분', sortable: true, render: r => dirLabel(r.direction) },
                { key: 'vendor_name', header: '거래처', sortable: true, render: r => <b>{r.vendor_name || '—'}</b> },
                { key: 'item_text', header: '내용', maxWidth: 420,
                  render: r => <>{r.item_text}{r.contract_name && <Sub>계약 {r.contract_name}</Sub>}
                    {r.needs_fix && <Sub className="text-warn">{r.needs_fix}</Sub>}</> },
                { key: 'total', header: '금액', align: 'right', sortable: true,
                  render: r => <span className="num">{fmtNum(r.total)}</span> },
                { key: 'creates', header: '만들 것', render: r => <span className="text-muted">{createsLabel(r)}</span> },
              ]}/>
          </div>

          {madeRows.length > 0 && (
            <>
              <button type="button" className="btn ghost sm" style={{ marginTop: 12 }} onClick={() => setShowMade(v => !v)}>
                {showMade ? <Icon.Down size={13}/> : <Icon.Right size={13}/>} 이미 만든 것 {madeRows.length}건
              </button>
              {showMade && (
                <div className="card" style={{ overflow: 'hidden', marginTop: 8 }}>
                  {/* 만든 줄은 틀의 값이 아니라 **실제로 만든** 날짜·금액이다 — 만들 때 고쳤을 수 있다 */}
                  <DataTable rows={madeRows} pageSize={0} rowKey={r => r.id}
                    onRowClick={r => openInvoiceOrTxn(r.made, r)}
                    columns={[
                      { key: 'date', header: '날짜', sortable: true, sortValue: r => r.made.date, render: r => fmtDateShort(r.made.date) },
                      { key: 'direction', header: '구분', render: r => dirLabel(r.direction) },
                      { key: 'vendor_name', header: '거래처', sortable: true, render: r => <b>{r.vendor_name || '—'}</b> },
                      { key: 'item_text', header: '내용', maxWidth: 420 },
                      { key: 'amount', header: '금액', align: 'right', sortable: true, sortValue: r => r.made.amount,
                        render: r => <span className="num">{fmtNum(r.made.amount)}</span> },
                      { key: 'made', header: '만든 것', render: r => <span className="link-cell">{r.made.no || `${fmtDateShort(r.made.date)} 출금`}</span> },
                    ]}/>
                </div>
              )}
            </>
          )}
          {/* 고른 것 · 만들기 — 화면 아래에 떠서 스크롤을 따라다닌다(SelectionBar).
              표 위에 두면 긴 목록에서 스크롤과 함께 사라졌다. ⚠ 목록 **맨 끝**에 둔다 —
              바가 마지막 줄을 가리지 않게 남기는 여백(spacer)이 이 자리에 생긴다 */}
          <SelectionBar count={picked.size} summary={`${fmtNum(pickedTotal)}원`} onClear={() => setPicked(new Set())}>
            <button className="btn primary" onClick={openCreate}><Icon.Check size={14}/> 선택한 {picked.size}건 만들기</button>
          </SelectionBar>
        </>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {/* 규칙 목록 — 공용 표(정렬·열 설정·한 줄). tableKey 가 있어 50건씩 + [더 보기] */}
          <DataTable tableKey="repeat-templates"
            rows={allRows} loading={templates === null} rowKey={t => t.id}
            onRowClick={openEdit}
            rowClass={t => (t.active ? undefined : 'row-off')}
            empty={term || vendor ? '조건에 맞는 반복거래가 없어요.'
              : '등록된 반복거래가 없어요. 유지보수비·임차료처럼 매달 오가는 돈을 등록해 두면 달마다 골라서 만들 수 있어요.'}
            columns={[
              { key: 'vendor_name', header: '거래처', sortable: true, render: t => <b>{t.vendor_name || '—'}</b> },
              { key: 'item', header: '내용', sortable: true, maxWidth: 420,
                render: t => <>{t.item}{t.contract_name && <Sub>계약 {t.contract_name}</Sub>}
                  {t.hidden_reason && <Sub style={{ color: 'var(--warn-ink)' }}>{t.hidden_reason}</Sub>}</> },
              { key: 'direction', header: '구분', sortable: true, render: t => dirLabel(t.direction) },
              { key: 'total', header: '금액', align: 'right', sortable: true, render: t => <span className="num">{fmtNum(t.total)}</span> },
              { key: 'period', header: '주기', sortable: true, sortValue: t => `${t.period}|${String(t.day_of_month).padStart(2, '0')}`,
                render: t => `${periodLong(t.period)} ${t.day_of_month ? `${t.day_of_month}일` : '(날짜는 만들 때)'}` },
              { key: 'creates', header: '만들 것', render: t => <span className="text-muted">{createsLabel(t)}{t.active ? '' : ' · 꺼짐'}</span> },
              { key: 'actions', header: '', label: '관리', width: 110, shrink: false,
                render: t => (
                  <span onClick={e => e.stopPropagation()}>
                    <RowActions
                      primary={{ label: '수정', onClick: () => openEdit(t) }}
                      items={[
                        { label: t.active ? '끄기' : '켜기', onClick: () => handleToggle(t) },
                        { label: '삭제', tone: 'neg', onClick: () => handleDelete(t) },
                      ]}/>
                  </span>
                ) },
            ]}/>
        </div>
      )}

      <RepeatFormDrawer open={formOpen} editing={editing} defaultDirection={dir === 'out' ? 'out' : 'in'}
        onClose={() => setFormOpen(false)} onSaved={reload}/>
      <RepeatCreateDrawer rows={createRows} ym={ym} onClose={() => setCreateRows(null)}
        onDone={(n) => { setCreateRows(null); toast.push(`${n}건을 만들었어요`); loadMonth() }}/>
    </div>
  )
}

/* ── 만들기 확인 ──────────────────────────────────────────────────────
 * 줄마다 날짜·금액을 고칠 수 있다(이번 달만 금액이 다른 일이 흔하다 — 전기료·통신비).
 * 이미 장부에 같은 돈이 있으면(통장·홈택스로 먼저 들어온 것) 기본은 **그것에 연결**이다.
 * 한 줄이라도 막히면 서버가 아무것도 안 만든다. */
const RepeatCreateDrawer = ({ rows, ym, onClose, onDone }) => {
  const toast = useToast()
  const [items, setItems] = useState([])
  const [accounts, setAccounts] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)   // { template_id, message }

  useEffect(() => {
    if (!rows) return
    setError(null)
    /* 바로 출금은 오늘까지만 만들 수 있다(실제로 오간 돈이라 — lib/repeat.js).
       예정일이 아직 안 온 줄에 그 날짜를 채워 두면, 사람이 손댈 수 없는 값(입력칸 max 는 오늘)
       그대로 서버에 가서 400 이 나고, 만들기는 전부 아니면 전무라 **같이 고른 줄까지 다 죽는다**
       (실측 재현: 28일 자동이체를 18일에 다른 줄들과 함께 고르면 아무것도 안 만들어졌다).
       오늘로 당겨 채운다 — 통장에서 이미 나간 날로 사람이 고쳐 쓰면 된다. */
    const nowDay = localToday()
    // 이번 달을 보고 있을 때만 당긴다 — 다음 달 줄을 오늘로 당기면 그 달 밖 날짜가 된다
    const clampable = nowDay.slice(0, 7) === ym
    setItems(rows.map(r => ({
      row: r,
      date: clampable && r.creates === 'txn' && r.date && r.date > nowDay ? nowDay : (r.date || ''),
      amount: String(r.amount), account_id: r.account_id || '',
      choice: r.lookalikes?.length ? `link:${r.lookalikes[0].type}:${r.lookalikes[0].id}` : 'new',
    })))
    if (rows.some(r => r.creates === 'txn')) api.getAccounts().then(list => setAccounts(list.filter(a => a.kind !== 'card')))
  }, [rows])

  const set = (i, k, v) => setItems(list => list.map((it, j) => (j === i ? { ...it, [k]: v } : it)))
  const today = localToday()

  const submit = async () => {
    const missing = items.find(it => !it.date)
    if (missing) return toast.push(`${missing.row.vendor_name || missing.row.item_text} — 날짜를 골라주세요`, { tone: 'warn' })
    /* 만들기는 전부 아니면 전무다 — 서버에 보내기 전에 여기서 걸러야 한 줄 때문에 묶음이 통째로 죽지 않는다 */
    const future = items.find(it => it.row.creates === 'txn' && it.date > today)
    if (future) {
      return toast.push(`${future.row.vendor_name || future.row.item_text} — 바로 출금은 오늘까지 날짜만 만들 수 있어요`, { tone: 'warn' })
    }
    // 옛 정기 규칙에서 옮겨 온 줄은 비목이 비어 있을 수 있다(등록 폼을 안 거쳤다)
    const noCat = items.find(it => it.row.direction === 'out' && !it.row.category)
    if (noCat) {
      return toast.push(`${noCat.row.vendor_name || noCat.row.item_text} — 비목이 비어 있어요. 반복거래를 열어 비목을 골라주세요`, { tone: 'warn' })
    }
    setBusy(true)
    const payload = items.map(it => {
      const base = { template_id: it.row.id, date: it.date, amount: String(it.amount).replace(/[^0-9]/g, ''), account_id: it.account_id || null }
      /* force_new 는 **사람이 후보를 보고 '새로 만들기'를 고른 줄**에만 붙인다.
         모든 줄에 붙이면 서랍을 연 뒤 통장·홈택스로 들어온 돈을 서버가 다시 볼 기회를 없앤다
         (lib/repeat.js 의 두 번째 검사 — 그게 없으면 같은 돈이 두 줄 선다. 실측 재현). */
      if (it.choice === 'new') return it.row.lookalikes?.length ? { ...base, force_new: true } : base
      const [, type, id] = it.choice.split(':')
      return { ...base, link: { type, id } }
    })
    const res = await api.createRepeat(ym, payload)
    setBusy(false)
    if (!res.ok) {
      /* 확인 서랍을 연 뒤에 같은 돈이 들어왔다 — 그 줄에 후보를 붙여 다시 고르게 한다 */
      if (res.code === 'lookalike' && res.payload?.template_id && res.payload.lookalikes?.length) {
        setItems(list => list.map(it => it.row.id === res.payload.template_id
          ? { ...it, row: { ...it.row, lookalikes: res.payload.lookalikes },
              choice: `link:${res.payload.lookalikes[0].type}:${res.payload.lookalikes[0].id}` }
          : it))
      }
      setError(res.error || '만들지 못했어요')
      return
    }
    onDone(res.created.length)
  }

  /* 서랍 합계는 **통장에 오갈 돈**(부가세 포함)으로 센다 — 입력칸은 부가세 별도면 공급가라,
     그대로 더하면 목록 아래 합계와 다른 숫자가 나온다(같은 선택인데 두 값). 세율은 lib/vatRate.js 한 곳. */
  const totalOf = (vatMode, amount) => {
    const a = Number(String(amount).replace(/[^0-9]/g, '')) || 0
    return vatMode === 'exclusive' ? a + vatOf(a) : a
  }
  const total = items.reduce((s, it) => s + totalOf(it.row.vat_mode, it.amount), 0)

  return (
    <Drawer open={!!rows} onClose={onClose} width="min(720px,100vw)" label="반복거래 만들기">
      <DrawerHead title={`${ymLabel(ym)} 반복거래 만들기`} sub={`${items.length}건`} onClose={onClose}/>
      <div className="drawer-body col gap-12">
        {error && (
          <div className="alert-row" style={{ background: 'var(--neg-soft)', borderColor: 'transparent', color: 'var(--neg-ink)' }}>
            <Icon.Warn/> <div className="text-sm">{error}</div>
          </div>
        )}
        {items.map((it, i) => {
          const r = it.row
          const vatHint = r.vat_mode === 'exclusive' ? '공급가 · 부가세 별도' : r.vat_mode === 'inclusive' ? '부가세 포함' : r.vat_mode === 'zero' ? '영세' : '면세'
          return (
            <div key={r.id} className="card card-pad col" style={{ gap: 10 }}>
              <div className="row gap-8" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span className="fw-700">{r.vendor_name || '—'}</span>
                <span className="text-sm">{r.item_text}</span>
                <span className="text-xs text-muted2 ml-auto">{dirLabel(r.direction)} · {createsLabel(r)}</span>
              </div>
              <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 160px' }}>
                  <label className="label">날짜</label>
                  <DateInput className="input" value={it.date} min={`${ym}-01`}
                    max={r.creates === 'txn' && lastDayOf(ym) > today ? today : lastDayOf(ym)}
                    onChange={e => set(i, 'date', e.target.value)}/>
                </div>
                <div style={{ flex: '1 1 160px' }}>
                  <label className="label">금액 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· {vatHint}</span></label>
                  <MoneyInput value={it.amount} onChange={raw => set(i, 'amount', raw)}/>
                </div>
                {r.creates === 'txn' && (
                  <div style={{ flex: '1 1 180px' }}>
                    <label className="label">출금 계좌</label>
                    <Combobox value={it.account_id} onChange={v => set(i, 'account_id', v)} allowAdd={false}
                      options={accounts.map(a => ({ value: a.id, label: a.name, sub: a.bankName || '' }))} placeholder="계좌"/>
                  </div>
                )}
              </div>
              {r.lookalikes?.length > 0 && (
                <div className="col" style={{ gap: 6 }}>
                  <div className="text-sm fw-600">장부에 같은 금액이 이미 있어요</div>
                  {r.lookalikes.map(l => (
                    <label key={l.id} className="row gap-6 text-sm" style={{ alignItems: 'center' }}>
                      <input type="radio" name={`lk-${r.id}`} checked={it.choice === `link:${l.type}:${l.id}`}
                        onChange={() => set(i, 'choice', `link:${l.type}:${l.id}`)}/>
                      그것에 연결 — {fmtDateShort(l.date)} · <span className="num">{fmtNum(l.amount)}</span>원 {l.no || l.label || ''}
                      {l.note ? <span className="text-xs text-muted2">· {l.note}</span> : null}
                    </label>
                  ))}
                  <label className="row gap-6 text-sm" style={{ alignItems: 'center' }}>
                    <input type="radio" name={`lk-${r.id}`} checked={it.choice === 'new'} onChange={() => set(i, 'choice', 'new')}/>
                    다른 건이에요 — 새로 만들기
                  </label>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <DrawerFooter onCancel={onClose} onSave={submit} saveDisabled={busy}
        saveLabel={busy ? '만드는 중…' : `${items.length}건 만들기 · ${fmtNum(total)}원`}/>
    </Drawer>
  )
}

/* ── 반복거래 등록·수정 ─────────────────────────────────────────────── */
const emptyForm = (direction) => ({
  direction, creates: direction === 'out' ? 'txn' : 'invoice', vendor_id: '', contract_id: null,
  item: '', category: '', amount: '', vat_mode: direction === 'out' ? 'inclusive' : 'exclusive',
  period: 'monthly', anchor_month: new Date().getMonth() + 1, day_of_month: '1',
  account_id: '', pay_term: direction === 'out' ? 'immediate' : 'net30', pay_day: 1, active: true,
})

const RepeatFormDrawer = ({ open, editing, defaultDirection, onClose, onSaved }) => {
  /* 수주·발주 원본이 MES 인 회사(동진)는 회계 쪽 주문 연결을 감춘다 — lib/customModules.js */
  const ordersFromMes = useOrdersFromMes()
  const toast = useToast()
  const [form, setForm] = useState(() => emptyForm(defaultDirection))
  const [errors, setErrors] = useState({})
  const [vendors, setVendors] = useState([])
  const [contracts, setContracts] = useState([])
  const [accounts, setAccounts] = useState([])
  const [cats, setCats] = useState([])

  useEffect(() => {
    if (!open) return
    setErrors({})
    api.getVendors().then(setVendors)
    api.getContracts().then(setContracts)
    api.getAccounts().then(list => setAccounts(list.filter(a => a.kind !== 'card')))
    api.getCategories({ type: 'exp' }).then(setCats)
    if (editing) {
      setForm({
        ...emptyForm(editing.direction),
        ...editing,
        contract_id: editing.contract_id || null, vendor_id: editing.vendor_id || '', category: editing.category || '',
        /* 일자 0 은 옛 '날짜가 매번 달라요'(기본 날짜 없음). 그 선택은 없앴지만(만들 때 늘 날짜를 고친다)
           이미 그렇게 저장된 것은 빈칸으로 보여 주고, 비운 채 저장하면 그대로 둔다 */
        amount: String(editing.amount || ''), day_of_month: Number(editing.day_of_month) ? String(editing.day_of_month) : '',
        account_id: editing.account_id || '',
        active: !!editing.active,
      })
    } else {
      setForm(emptyForm(defaultDirection))
    }
  }, [open, editing])

  const f = (k, v) => { setErrors(e => (e[k] ? { ...e, [k]: '' } : e)); setForm(p => ({ ...p, [k]: v })) }
  const isOut = form.direction === 'out'
  const needsVendor = !isOut || form.creates === 'invoice'
  /* 계약은 방향에 맞는 것만 — 나가는 돈에 수주를 걸면 원가가 엉뚱한 건에 붙는다.
     ⚠ 방향은 **서버가 준 is_purchase** 로 본다(주문에 적힌 값). 거래처 구분으로 추정하면
        겸함('C') 주문이 들어오는 돈·나가는 돈 양쪽 후보에 중복으로 뜨고, 반대로 거래처가
        매출처인데 발주로 만든 주문은 나가는 돈 후보에서 빠져 고를 수조차 없다. */
  const sideContracts = useMemo(() => contracts.filter(c => {
    const g = c.vendor_gubu ?? c.gubu
    const purchase = c.is_purchase ?? ['A', 'E'].includes(g)
    return isOut ? purchase : !purchase
  }), [contracts, isOut])

  const save = async () => {
    if (needsVendor && !form.vendor_id) { setErrors({ vendor_id: '거래처를 골라주세요' }); return }
    // 새로 만들 땐 날짜가 있어야 한다(기본 날짜). 옛 '매번 달라요'(0)로 저장된 것만 빈칸을 허락한다
    if (!(parseInt(form.day_of_month, 10) > 0) && !(editing?.id && !Number(editing.day_of_month))) {
      setErrors({ day_of_month: '날짜를 적어 주세요' }); return
    }
    const body = {
      ...form,
      creates: isOut ? form.creates : 'invoice',
      amount: String(form.amount).replace(/[^0-9]/g, ''),
      day_of_month: parseInt(form.day_of_month, 10) || 0,
    }
    const res = await api.saveRepeatTemplate(editing?.id, body)
    if (!res.ok) {
      if (res.field) { setErrors({ [res.field]: res.error }); return }
      return toast.push(res.error || '저장하지 못했어요', { tone: 'warn' })
    }
    toast.push(editing?.id ? '수정했어요' : '등록했어요')
    onClose()
    onSaved?.()
  }

  const Err = ({ k }) => (errors[k] ? <div className="text-xs" style={{ color: 'var(--neg-ink)', marginTop: 4 }}>{errors[k]}</div> : null)
  const req = <span style={{ color: 'var(--neg-ink)' }}> *</span>

  return (
    /* 두 칸 배치 — 한 줄에 하나씩 세우면 짧은 칸(구분·주기·날짜)까지 줄을 다 먹어 스크롤이 길었다
       (2026-09-29 사용자: "쓸데없이 한 줄, 가로를 늘리고 두 줄로"). 좁은 화면에선 한 줄로 돌아간다 */
    <Drawer open={open} onClose={onClose} width="880px" label="반복거래">
      <DrawerHead title={editing?.id ? '반복거래 수정' : '반복거래 등록'} onClose={onClose}/>
      <div className="drawer-body form-grid-2">
        <div className="span-2 row" style={{ gap: 32, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <label className="label">구분</label>
          <div className="row gap-6">
            {[['in', '입금'], ['out', '출금']].map(([v, l]) => (
              <button key={v} type="button" className={`chip ${form.direction === v ? 'active' : ''}`}
                onClick={() => setForm(p => {
                  /* 방향이 바뀌면 '만들 것'·결제기한은 그 방향의 기본값으로 되돌린다 — 적은 내용·금액·거래처만 남긴다.
                     안 그러면 출금에서 고른 '바로 출금(immediate)'이 입금에 남아 결제기한 칩이 하나도 안 눌린 채 저장된다. */
                  const base = emptyForm(v)
                  return { ...base, ...p, direction: v, contract_id: null,
                    creates: base.creates, pay_term: base.pay_term, account_id: base.account_id,
                    /* 부가세 방식도 되돌린다 — 출금은 '포함', 입금은 '별도'가 기본이라, 안 되돌리면
                       적어 둔 100만이 공급가에서 합계로(또는 그 반대로) 뜻만 조용히 바뀐다.
                       다만 면세·영세는 방향과 무관한 **사실**이라 그대로 둔다(되돌리면 세액 0이
                       10%로 바뀐다 — 막으려던 바로 그 일이 면세 사용자에게 난다). */
                    vat_mode: (p.vat_mode === 'none' || p.vat_mode === 'zero') ? p.vat_mode : base.vat_mode }
                })}>{l}</button>
            ))}
          </div>
        </div>
        {isOut && (
          <div>
            <label className="label">만들 것</label>
            <div className="row gap-6">
              {[['txn', '바로 출금'], ['invoice', '청구서(지급 대기)']].map(([v, l]) => (
                <button key={v} type="button" className={`chip ${form.creates === v ? 'active' : ''}`}
                  onClick={() => setForm(p => ({ ...p, creates: v, pay_term: v === 'txn' ? 'immediate' : (p.pay_term === 'immediate' ? 'net30' : p.pay_term) }))}>{l}</button>
              ))}
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
              {form.creates === 'txn' ? '자동이체처럼 그 날 통장에서 나가는 돈' : '세금계산서를 받고 나중에 지급하는 돈'}
            </div>
          </div>
        )}
        </div>
        <div>
          {/* 청구서를 만드는 규칙은 거래처가 필수다(서버 lib/repeat.js) — 바로 출금은 공과금처럼 없을 수 있다 */}
          <label className="label">거래처 {needsVendor
            ? <span style={{ color: 'var(--neg-ink)' }}>*</span>
            : <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span>}</label>
          {errors.vendor_id && <div className="text-xs" style={{ color: 'var(--neg-ink)' }}>{errors.vendor_id}</div>}
          <Combobox value={form.vendor_id} allowAdd={false}
            onChange={v => setForm(p => contractFitsVendor(contracts, p.contract_id, v) ? { ...p, vendor_id: v } : { ...p, vendor_id: v, contract_id: null })}
            options={vendors.map(v => ({ value: v.id, label: v.name, sub: v.type || '' }))} placeholder="거래처 선택·검색"/>
        </div>
        {!ordersFromMes && (
        <div>
          <label className="label">{isOut ? '발주' : '수주'} 연결 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
          <Combobox value={form.contract_id || ''} onChange={v => f('contract_id', v || null)} allowAdd={false}
            options={contractsForVendor(sideContracts, form.vendor_id).map(c => ({ value: c.id, label: c.name, sub: c.vendor_name }))}
            placeholder="없으면 비워두기"/>
        </div>
        )}
        <div>
          <label className="label">내용{req}</label>
          <input className="input" value={form.item} onChange={e => f('item', e.target.value)} placeholder="예: {월}월 유지보수"/>
          <div className="text-xs text-muted2" style={{ marginTop: 4 }}>{'{월}'}은 만들 때 그 달 숫자로 바뀌어요</div>
          <Err k="item"/>
        </div>
        {isOut && (
          <div>
            <label className="label">비목{req}</label>
            <Combobox value={form.category} onChange={v => f('category', v)} allowAdd={false}
              options={cats.map(categoryOption)} placeholder="비목 선택"/>
            <Err k="category"/>
          </div>
        )}
        <div>
          <label className="label">금액{req}</label>
          <MoneyInput value={form.amount} onChange={raw => f('amount', raw)}/>
          <div className="row gap-6" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            {VAT_OPTS.map(([v, l]) => (
              <button key={v} type="button" className={`chip ${form.vat_mode === v ? 'active' : ''}`} onClick={() => f('vat_mode', v)}>{l}</button>
            ))}
          </div>
          <Err k="amount"/>
        </div>
        <div>
          <label className="label">주기</label>
          <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
            {BILLING_PERIODS.map(o => (
              <button key={o.value} type="button" className={`chip ${form.period === o.value ? 'active' : ''}`}
                onClick={() => f('period', o.value)}>{o.long}</button>
            ))}
          </div>
          {form.period !== 'monthly' && (
            <div className="row gap-6" style={{ alignItems: 'center', marginTop: 8 }}>
              <span className="text-sm text-muted">시작 달</span>
              <div style={{ width: 110 }}>
                <Combobox value={String(form.anchor_month)} onChange={v => f('anchor_month', Number(v) || 1)} allowAdd={false}
                  options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1}월` }))}/>
              </div>
            </div>
          )}
        </div>
        <div>
          <label className="label">날짜</label>
          <div className="row gap-8" style={{ alignItems: 'center' }}>
            <input className="input num" type="number" onWheel={e => e.currentTarget.blur()} min="1" max="31" style={{ width: 80 }}
              value={form.day_of_month} onChange={e => f('day_of_month', e.target.value)}/>
            <span className="text-sm text-muted">일</span>
          </div>
          {/* '날짜가 매번 달라요' 체크를 없앴다 — 만들 때(이번 달 반복거래 만들기) 건마다 날짜를 늘 고칠 수 있다 */}
          <div className="text-xs text-muted2" style={{ marginTop: 4 }}>만들 때 그 달 날짜를 바꿀 수 있어요</div>
          <Err k="day_of_month"/>
        </div>
        <div>
          <label className="label">{isOut ? '출금' : '입금'} 계좌{isOut && form.creates === 'txn' ? req : null}</label>
          <Combobox value={form.account_id} onChange={v => f('account_id', v)} allowAdd={false}
            options={[...(isOut && form.creates === 'txn' ? [] : [{ value: '', label: '지정 안 함' }]),
              ...accounts.map(a => ({ value: a.id, label: a.name, sub: a.bankName || '' }))]}
            placeholder="계좌 선택"/>
          <Err k="account_id"/>
        </div>
        {!(isOut && form.creates === 'txn') && (
          <div>
            <label className="label">결제기한</label>
            <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
              {PAY_TERM_OPTS.filter(o => o.value !== 'immediate').map(o => (
                <button key={o.value} type="button" className={`chip ${form.pay_term === o.value ? 'active' : ''}`}
                  onClick={() => f('pay_term', o.value)}>{o.label}</button>
              ))}
              {/* 'N일' 칸은 **늘 자리에 둔다** — 당월·익월 N일을 누를 때만 생기면 누를 때마다 줄이 밀렸다.
                  N일 기한이 아니면 끈 채로 둔다 */}
              <div className="row gap-6" style={{ alignItems: 'center' }}>
                <input className="input num" type="number" onWheel={e => e.currentTarget.blur()} min="1" max="31" style={{ width: 64 }}
                  disabled={!payTermNeedsDay(form.pay_term)} aria-label="N일"
                  value={payTermNeedsDay(form.pay_term) ? (form.pay_day ?? 1) : ''} placeholder="N"
                  onChange={e => f('pay_day', e.target.value)}/>
                <span className="text-sm text-muted">일</span>
              </div>
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>{payTermHint(form.pay_term, form.pay_day, isOut ? '나가요' : '들어와요')}</div>
          </div>
        )}
      </div>
      <DrawerFooter onCancel={onClose} onSave={save} saveLabel={editing?.id ? '수정' : '등록'}/>
    </Drawer>
  )
}
