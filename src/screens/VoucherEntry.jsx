import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Combobox, MoneyInput, DateInput, localToday, fmtDateShort } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { VoucherView } from '../lib/components/VoucherView'
import { api } from '../lib/api'

/**
 * 전표 입력 — 분개전표 모양 그대로. 왼쪽이 **차변** 블록, 오른쪽이 **대변** 블록이고,
 * 각 쪽에서 줄을 더해 계정과목·적요·금액을 채운다. 차변 합계 = 대변 합계여야 저장된다.
 *
 * 저장은 통장 줄이 있느냐로 갈린다:
 *   · 통장 줄 1개 → 통장이 오간 거래로 저장(잔액 반영). 나머지 줄은 비목.
 *       (통장이 차변이면 입금, 대변이면 지출)
 *   · 통장 줄 없음 → 현금이 안 움직이는 대체전표(감가상각 등).
 * 통장 두 줄(통장↔통장)은 내부이체 화면을 쓴다 — 여기서는 막는다.
 */

const numOf = (v) => (typeof v === 'string' ? parseInt(v.replace(/[^0-9-]/g, ''), 10) || 0 : Number(v) || 0)
const emptyRow = () => ({ acct: '', memo: '', amount: '' })
const VAT_CODES = new Set(['1306', '2208'])   // 부가세대급금/예수금 — 이 줄은 세액으로 잡는다

export const VoucherEntryScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [accounts, setAccounts] = useState([])
  const [subjects, setSubjects] = useState([])
  const [list, setList] = useState([])
  const [date, setDate] = useState(localToday())
  const [summary, setSummary] = useState('')
  const [debits, setDebits] = useState([emptyRow()])    // 차변 블록
  const [credits, setCredits] = useState([emptyRow()])  // 대변 블록
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState(null)

  const load = async () => {
    const [accs, subs, vs] = await Promise.all([
      api.getAccounts(), api.getAccountSubjects({ postableOnly: true }), api.getJournalVouchers(),
    ])
    setAccounts((accs || []).filter(a => a.kind !== 'card'))
    setSubjects(subs || [])
    setList(vs || [])
  }
  useEffect(() => { load() }, [])

  const opts = useMemo(() => [
    ...(accounts.length ? [{ header: '통장 (돈이 실제로 오가는 계좌)' }] : []),
    ...accounts.map(a => ({ value: 'acc:' + a.id, label: a.name, sub: a.bankName || '통장' })),
    { header: '계정과목' },
    ...subjects.map(s => ({ value: s.code, label: s.name, sub: `${s.code} · ${s.category || '계정과목'}`, keywords: s.code })),
  ], [accounts, subjects])
  const isBank = (v) => typeof v === 'string' && v.startsWith('acc:')
  const nameOf = (v) => isBank(v) ? (accounts.find(a => 'acc:' + a.id === v)?.name || '') : (subjects.find(s => s.code === v)?.name || '')

  // 한 쪽(차변/대변) 블록을 다루는 헬퍼
  const setRow = (setter) => (i, f, v) => setter(rs => rs.map((r, j) => j === i ? { ...r, [f]: v } : r))
  const addRow = (setter) => () => setter(rs => [...rs, emptyRow()])
  const delRow = (setter) => (i) => setter(rs => rs.length <= 1 ? rs : rs.filter((_, j) => j !== i))

  const debitSum = useMemo(() => debits.reduce((s, r) => s + numOf(r.amount), 0), [debits])
  const creditSum = useMemo(() => credits.reduce((s, r) => s + numOf(r.amount), 0), [credits])
  const balanced = debitSum > 0 && debitSum === creditSum
  const usableDebits = debits.filter(r => r.acct && numOf(r.amount))
  const usableCredits = credits.filter(r => r.acct && numOf(r.amount))

  const reset = () => { setDate(localToday()); setSummary(''); setDebits([emptyRow()]); setCredits([emptyRow()]) }

  const save = async () => {
    if (usableDebits.length + usableCredits.length < 2 || !usableDebits.length || !usableCredits.length)
      return toast.push('차변과 대변에 각각 한 줄 이상 적어주세요', { tone: 'warn' })
    if (!balanced) return toast.push('차변 합계와 대변 합계가 같아야 해요', { tone: 'warn' })

    const rows = [
      ...usableDebits.map(r => ({ ...r, side: 'debit' })),
      ...usableCredits.map(r => ({ ...r, side: 'credit' })),
    ]
    const banks = rows.filter(r => isBank(r.acct))
    if (banks.length > 1) return toast.push('통장은 한 줄만 — 통장끼리 옮기는 건 내부 이체 화면을 쓰세요', { tone: 'warn' })

    setBusy(true)
    try {
      if (banks.length === 1) {
        const bank = banks[0]
        const kind = bank.side === 'debit' ? 'income' : 'expense'
        const amount = numOf(bank.amount)
        const counters = rows.filter(r => r !== bank)
        const splits = counters.map(r => {
          const amt = numOf(r.amount)
          const vat = VAT_CODES.has(r.acct)
          return { category: nameOf(r.acct), account_code: r.acct,
                   supply_amount: vat ? 0 : amt, vat_amount: vat ? amt : 0, amount: amt,
                   tax_type: vat ? '과세' : '면세', memo: r.memo || '' }
        })
        const res = await api.addTransaction({
          kind, account_id: bank.acct.slice(4), amount, date,
          category: splits[0]?.category || '복합', memo: summary || counters[0]?.memo || '전표 입력',
          status: kind === 'income' ? '입금완료' : '지급완료', splits,
        })
        if (!res.ok) return toast.push(res.error || '저장에 실패했어요', { tone: 'warn' })
        toast.push('거래로 저장했어요 (거래내역·전표목록에서 보여요)')
        reset(); load()
        setView({ source: 'transaction', id: res.id })
      } else {
        const res = await api.createJournalVoucher({
          date, summary,
          lines: rows.map(r => ({ side: r.side, account_code: r.acct, account_name: nameOf(r.acct), amount: numOf(r.amount), memo: r.memo || '' })),
        })
        if (!res.ok) return toast.push(res.error || '저장에 실패했어요', { tone: 'warn' })
        toast.push(`전표 ${res.doc_no}를 저장했어요`)
        reset(); load()
        openJournalView(res.id)
      }
    } finally { setBusy(false) }
  }

  const openJournalView = async (id) => {
    const v = await api.getJournalVoucher(id)
    if (!v) return
    setView({ voucher: {
      type: '대체전표', date: v.date, source: 'journal', counterparty: '', category: '', summary: v.summary || v.memo || '',
      lines: (v.lines || []).map(l => ({ side: l.side, code: l.account_code, name: l.account_name, amount: Number(l.amount) || 0 })),
      debitTotal: (v.lines || []).filter(l => l.side === 'debit').reduce((s, l) => s + (Number(l.amount) || 0), 0),
      creditTotal: (v.lines || []).filter(l => l.side === 'credit').reduce((s, l) => s + (Number(l.amount) || 0), 0),
      balanced: true,
    } })
  }

  const remove = async (v) => {
    const ok = await confirm({ tone: 'neg', icon: <Icon.Warn size={22}/>, title: '전표 삭제',
      body: `전표 ${v.doc_no}를 지웁니다.`, detail: '분개 줄이 함께 지워져요.', confirmLabel: '삭제' })
    if (!ok) return
    const res = await api.deleteJournalVoucher(v.id)
    toast.push(res.ok ? '전표를 지웠어요' : (res.error || '삭제에 실패했어요'), res.ok ? undefined : { tone: 'warn' })
    load()
  }

  // 한 쪽 블록 렌더 — 차변/대변 공통
  const Side = ({ title, rows, setter, sum, tone }) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="fw-700" style={{ textAlign: 'center', padding: '8px 0', background: 'var(--surface-2)', borderRadius: 8, marginBottom: 10, color: `var(--${tone}-ink)` }}>{title}</div>
      <div className="col gap-10">
        {rows.map((r, i) => (
          <div key={i} className="row gap-6" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Combobox value={r.acct} allowAdd={false} options={opts}
                onChange={v => setRow(setter)(i, 'acct', v)} placeholder="계정과목 · 통장"/>
              <input className="input" style={{ marginTop: 4, fontSize: 12 }} value={r.memo}
                placeholder="적요(선택)" onChange={e => setRow(setter)(i, 'memo', e.target.value)}/>
            </div>
            <div style={{ width: 130 }}>
              <MoneyInput value={r.amount} onChange={raw => setRow(setter)(i, 'amount', raw)}/>
            </div>
            <button className="icon-btn sm" title="줄 삭제" style={{ marginTop: 6 }}
              onClick={() => delRow(setter)(i)} disabled={rows.length <= 1}><Icon.Close size={13}/></button>
          </div>
        ))}
      </div>
      <button className="btn sm" style={{ marginTop: 10 }} onClick={addRow(setter)}><Icon.Plus size={12}/> {title} 줄 추가</button>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
        <span className="text-sm text-muted2">{title} 합계</span>
        <span className="num fw-700">{fmtNum(sum)}</span>
      </div>
    </div>
  )

  return (
    <div className="fade-up">
      <PageHeader title="전표 입력"
        sub="분개전표 모양 그대로 — 왼쪽 차변, 오른쪽 대변에 줄을 더해 계정과목·금액을 채워요. 통장 줄이 있으면 통장이 오간 거래로, 없으면 대체전표로 저장돼요."/>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row gap-12" style={{ flexWrap: 'wrap', marginBottom: 16 }}>
          <div><label className="label">날짜</label>
            <DateInput className="input" style={{ width: 160 }} max={localToday()} value={date} onChange={e => setDate(e.target.value)}/>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}><label className="label">전표 적요</label>
            <input className="input" value={summary} placeholder="예: 자동차보험료 납부" onChange={e => setSummary(e.target.value)}/>
          </div>
        </div>

        {/* 분개전표 — 차변 | 대변 반반. Side 는 컴포넌트가 아니라 함수로 호출한다
            (<Side/> 로 쓰면 매 렌더마다 새 타입이 되어 입력 포커스가 튄다). */}
        <div className="row gap-16" style={{ alignItems: 'stretch' }}>
          {Side({ title: '차변', rows: debits, setter: setDebits, sum: debitSum, tone: 'pos' })}
          <div style={{ width: 1, background: 'var(--line)' }}/>
          {Side({ title: '대변', rows: credits, setter: setCredits, sum: creditSum, tone: 'neg' })}
        </div>

        <div className="row gap-8" style={{ alignItems: 'center', marginTop: 16, paddingTop: 12, borderTop: '2px solid var(--line-strong, var(--line))', flexWrap: 'wrap' }}>
          {debitSum !== creditSum
            ? <span className="badge warn" style={{ fontSize: 11 }}>차변·대변 차이 {fmtNum(Math.abs(debitSum - creditSum))}</span>
            : (debitSum > 0 && <span className="badge pos" style={{ fontSize: 11 }}>차·대변 일치</span>)}
          <button className="btn primary ml-auto" onClick={save} disabled={busy || !balanced}>
            <Icon.Check size={14}/> 전표 저장
          </button>
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-pad" style={{ paddingBottom: 8 }}>
          <span className="fw-700 text-sm">최근 대체전표</span>
          <span className="text-xs text-muted2" style={{ marginLeft: 8 }}>통장이 오간 전표는 거래내역·전표목록에서 봐요</span>
        </div>
        {list.length === 0
          ? <div className="text-sm text-muted2" style={{ padding: '8px 16px 20px' }}>아직 입력한 대체전표가 없어요.</div>
          : (
            <table className="table">
              <thead><tr><th style={{ width: 130 }}>전표번호</th><th style={{ width: 110 }}>날짜</th><th>적요</th><th className="num-right" style={{ width: 140 }}>금액</th><th style={{ width: 60 }}/></tr></thead>
              <tbody>
                {list.map(v => (
                  <tr key={v.id} style={{ cursor: 'pointer' }} onClick={() => openJournalView(v.id)}>
                    <td className="num text-sm">{v.doc_no}</td>
                    <td className="text-sm text-muted">{fmtDateShort(v.date)}</td>
                    <td className="text-sm">{v.summary || v.memo || '—'}</td>
                    <td className="num-cell num-right">{fmtNum(v.total)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm" style={{ color: 'var(--neg-ink)' }} onClick={(e) => { e.stopPropagation(); remove(v) }}>삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      <VoucherView open={!!view} voucher={view?.voucher} source={view?.source} id={view?.id} onClose={() => setView(null)}/>
    </div>
  )
}
