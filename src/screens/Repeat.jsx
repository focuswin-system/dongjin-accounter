import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Drawer, Combobox, MoneyInput, DateInput, fmtDateShort } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { RowActions } from '../lib/components/RowActions'
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

  const loadMonth = async () => { setRows(await api.getRepeatMonth(ym)); setPicked(new Set()) }
  const loadAll = async () => setTemplates(await api.getRepeatTemplates())
  useEffect(() => { loadMonth() }, [ym])
  useEffect(() => { if (view === 'all') loadAll() }, [view])
  /* 보이는 것만 고른 것이다 — 입금/출금 칩이나 보기를 바꾸면 선택을 푼다.
     안 그러면 화면에 없는 줄이 '선택한 N건'에 섞여 확인 서랍에서 처음 보게 된다. */
  useEffect(() => { setPicked(new Set()) }, [dir, view])
  const reload = () => { loadMonth(); if (view === 'all' || templates) loadAll() }

  const byDir = (list) => (list || []).filter(r => dir === 'all' || r.direction === dir)
  const monthRows = byDir(rows)
  const allRows = byDir(templates)
  // 손볼 것이 남은 줄(비목·계좌 없음)은 고를 수 없다 — 골라도 서버가 막고, 만들기는 전부 아니면 전무다
  const pickable = monthRows.filter(r => !r.made && !r.needs_fix)

  const toggle = (id) => setPicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleAll = () => setPicked(s => s.size === pickable.length ? new Set() : new Set(pickable.map(r => r.id)))

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
          <div className="card" style={{ overflow: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input type="checkbox" aria-label="모두 고르기" disabled={!pickable.length}
                      checked={pickable.length > 0 && picked.size === pickable.length} onChange={toggleAll}/>
                  </th>
                  <th>날짜</th><th>구분</th><th>거래처</th><th>내용</th>
                  <th className="num-right">금액</th><th>만들 것</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows === null ? (
                  <tr><td colSpan={8} className="text-sm text-muted" style={{ textAlign: 'center', padding: 24 }}>불러오는 중…</td></tr>
                ) : monthRows.length === 0 ? (
                  <tr><td colSpan={8} className="text-sm text-muted" style={{ textAlign: 'center', padding: 24 }}>
                    {ymLabel(ym)}에 해당하는 반복거래가 없어요.
                  </td></tr>
                ) : monthRows.map(r => (
                  <tr key={r.id} style={{ opacity: r.made ? 0.6 : 1 }}>
                    <td>{!r.made && !r.needs_fix
                      && <input type="checkbox" aria-label="고르기" checked={picked.has(r.id)} onChange={() => toggle(r.id)}/>}</td>
                    {/* 만든 줄은 틀의 값이 아니라 **실제로 만든** 날짜·금액을 보여준다 — 만들 때 고쳤을 수 있다 */}
                    <td className="text-sm">{r.made ? fmtDateShort(r.made.date) : r.date ? fmtDateShort(r.date) : '만들 때 고름'}</td>
                    <td className="text-sm">{dirLabel(r.direction)}</td>
                    <td className="fw-600">{r.vendor_name || '—'}</td>
                    <td className="text-sm">
                      {r.item_text}
                      {r.contract_name && <div className="text-xs text-muted2">계약: {r.contract_name}</div>}
                      {r.needs_fix && <div className="text-xs text-warn">{r.needs_fix}</div>}
                    </td>
                    <td className="num-cell num-right">{fmtNum(r.made ? r.made.amount : r.total)}</td>
                    <td className="text-sm text-muted">{createsLabel(r)}</td>
                    <td className="text-sm">
                      {r.made
                        ? <button type="button" className="link-cell" onClick={() => openInvoiceOrTxn(r.made, r)}>
                            {r.made.no || `${fmtDateShort(r.made.date)} 출금`}
                          </button>
                        : <button type="button" className="btn ghost sm" onClick={() => openEdit(r)}>수정</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {picked.size > 0 && (
            <div className="row gap-8" style={{ marginTop: 12, alignItems: 'center' }}>
              <span className="text-sm text-muted">{picked.size}건 · <span className="num">{fmtNum(pickedTotal)}</span>원</span>
              <button className="btn primary ml-auto" onClick={openCreate}><Icon.Check size={14}/> 선택한 {picked.size}건 만들기</button>
            </div>
          )}
        </>
      ) : (
        <div className="card" style={{ overflow: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>거래처</th><th>내용</th><th>구분</th><th className="num-right">금액</th>
                <th>주기</th><th>만들 것</th><th style={{ width: 96 }}></th>
              </tr>
            </thead>
            <tbody>
              {templates === null ? (
                <tr><td colSpan={7} className="text-sm text-muted" style={{ textAlign: 'center', padding: 24 }}>불러오는 중…</td></tr>
              ) : allRows.length === 0 ? (
                <tr><td colSpan={7} className="text-sm text-muted" style={{ textAlign: 'center', padding: 24 }}>
                  등록된 반복거래가 없어요. 유지보수비·임차료처럼 매달 오가는 돈을 등록해 두면 달마다 골라서 만들 수 있어요.
                </td></tr>
              ) : allRows.map(t => (
                <tr key={t.id} style={{ opacity: t.active ? 1 : 0.45 }}>
                  <td className="fw-600">{t.vendor_name || '—'}</td>
                  <td className="text-sm">
                    {t.item}
                    {t.contract_name && <div className="text-xs text-muted2">계약: {t.contract_name}</div>}
                    {t.hidden_reason && <div className="text-xs" style={{ color: 'var(--warn-ink)' }}>{t.hidden_reason}</div>}
                  </td>
                  <td className="text-sm">{dirLabel(t.direction)}</td>
                  <td className="num-cell num-right">{fmtNum(t.total)}</td>
                  <td className="text-sm">{periodLong(t.period)} {t.day_of_month ? `${t.day_of_month}일` : '(날짜는 만들 때)'}</td>
                  <td className="text-sm text-muted">{createsLabel(t)}{t.active ? '' : ' · 꺼짐'}</td>
                  <td>
                    <RowActions
                      primary={{ label: '수정', onClick: () => openEdit(t) }}
                      items={[
                        { label: t.active ? '끄기' : '켜기', onClick: () => handleToggle(t) },
                        { label: '삭제', tone: 'neg', onClick: () => handleDelete(t) },
                      ]}/>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
  period: 'monthly', anchor_month: new Date().getMonth() + 1, day_of_month: '1', pick_day: false,
  account_id: '', pay_term: direction === 'out' ? 'immediate' : 'net30', pay_day: 1, active: true,
})

const RepeatFormDrawer = ({ open, editing, defaultDirection, onClose, onSaved }) => {
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
        amount: String(editing.amount || ''), day_of_month: String(editing.day_of_month || 1),
        pick_day: Number(editing.day_of_month) === 0, account_id: editing.account_id || '',
        active: !!editing.active,
      })
    } else {
      setForm(emptyForm(defaultDirection))
    }
  }, [open, editing])

  const f = (k, v) => { setErrors(e => (e[k] ? { ...e, [k]: '' } : e)); setForm(p => ({ ...p, [k]: v })) }
  const isOut = form.direction === 'out'
  const needsVendor = !isOut || form.creates === 'invoice'
  /* 계약은 방향에 맞는 것만 — 나가는 돈에 수주를 걸면 원가가 엉뚱한 건에 붙는다(Contract.jsx isPurchase 와 같은 판정) */
  const sideContracts = useMemo(() => contracts.filter(c => {
    const g = c.vendor_gubu ?? c.gubu
    return isOut ? ['A', 'E', 'C'].includes(g) : !['A', 'E'].includes(g)
  }), [contracts, isOut])

  const save = async () => {
    if (needsVendor && !form.vendor_id) { setErrors({ vendor_id: '거래처를 골라주세요' }); return }
    const body = {
      ...form,
      creates: isOut ? form.creates : 'invoice',
      amount: String(form.amount).replace(/[^0-9]/g, ''),
      day_of_month: form.pick_day ? 0 : (parseInt(form.day_of_month, 10) || 1),
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
    <Drawer open={open} onClose={onClose} width="min(600px,100vw)" label="반복거래">
      <DrawerHead title={editing?.id ? '반복거래 수정' : '반복거래 등록'} onClose={onClose}/>
      <div className="drawer-body col gap-form">
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
                    creates: base.creates, pay_term: base.pay_term, account_id: base.account_id }
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
        <div>
          <label className="label">{isOut ? '발주' : '수주'} 연결 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
          <Combobox value={form.contract_id || ''} onChange={v => f('contract_id', v || null)} allowAdd={false}
            options={contractsForVendor(sideContracts, form.vendor_id).map(c => ({ value: c.id, label: c.name, sub: c.vendor_name }))}
            placeholder="없으면 비워두기"/>
        </div>
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
              options={cats.map(c => ({ value: c.name, label: c.name, sub: c.group_name || '' }))} placeholder="비목 선택"/>
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
          <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            {!form.pick_day && (
              <>
                <input className="input num" type="number" min="1" max="31" style={{ width: 80 }}
                  value={form.day_of_month} onChange={e => f('day_of_month', e.target.value)}/>
                <span className="text-sm text-muted">일</span>
              </>
            )}
            <label className="row gap-6 text-sm" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={form.pick_day} onChange={e => f('pick_day', e.target.checked)}/>
              날짜가 매번 달라요(만들 때 고름)
            </label>
          </div>
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
              {payTermNeedsDay(form.pay_term) && (
                <div className="row gap-6" style={{ alignItems: 'center' }}>
                  <input className="input num" type="number" min="1" max="31" style={{ width: 76 }}
                    value={form.pay_day ?? 1} onChange={e => f('pay_day', e.target.value)}/>
                  <span className="text-sm text-muted">일</span>
                </div>
              )}
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>{payTermHint(form.pay_term, form.pay_day, isOut ? '나가요' : '들어와요')}</div>
          </div>
        )}
      </div>
      <DrawerFooter onCancel={onClose} onSave={save} saveLabel={editing?.id ? '수정' : '등록'}/>
    </Drawer>
  )
}
