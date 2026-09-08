import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Combobox, MoneyInput, DateInput, localToday, fmtDateShort } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { VoucherView } from '../lib/components/VoucherView'
import { api } from '../lib/api'

/**
 * 전표 입력 — 거래내역에서 보는 그 전표 모양 그대로, 차변·대변에 줄을 더해 가며 입력한다.
 *
 * 한 줄은 **통장(계좌) 또는 계정과목(비목)** 중 하나를 고르고, 적요와 금액(차변 or 대변)을 적는다.
 * 차변 합계 = 대변 합계 여야 저장된다.
 *
 * 저장은 통장 줄이 있느냐로 갈린다:
 *   · 통장 줄 1개 있음 → 통장이 오간 **거래**로 저장(잔액에 반영). 나머지 줄은 비목.
 *       (차변이 통장이면 입금, 대변이면 출금)
 *   · 통장 줄 없음 → 현금이 안 움직이는 **대체전표**(감가상각 등)로 저장.
 * 통장 두 줄(통장↔통장)은 내부이체 화면을 쓴다 — 여기서는 막는다.
 */

const numOf = (v) => (typeof v === 'string' ? parseInt(v.replace(/[^0-9-]/g, ''), 10) || 0 : Number(v) || 0)
const emptyLine = () => ({ acct: '', memo: '', debit: '', credit: '' })
const VAT_CODES = new Set(['1306', '2208'])   // 부가세대급금/예수금 — 이 줄은 세액으로 잡는다

export const VoucherEntryScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [accounts, setAccounts] = useState([])
  const [subjects, setSubjects] = useState([])
  const [list, setList] = useState([])
  const [date, setDate] = useState(localToday())
  const [summary, setSummary] = useState('')
  const [lines, setLines] = useState([emptyLine(), emptyLine()])
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState(null)   // 저장 후·목록 클릭 시 여는 전표 보기

  const load = async () => {
    const [accs, subs, vs] = await Promise.all([
      api.getAccounts(), api.getAccountSubjects({ postableOnly: true }), api.getJournalVouchers(),
    ])
    setAccounts((accs || []).filter(a => a.kind !== 'card'))
    setSubjects(subs || [])
    setList(vs || [])
  }
  useEffect(() => { load() }, [])

  /* 계정 고르는 목록 — 통장을 앞에(자주 씀), 계정과목을 뒤에. 값으로 통장은 'acc:'+id, 계정과목은 코드. */
  const opts = useMemo(() => [
    ...(accounts.length ? [{ header: '통장 (돈이 실제로 오가는 계좌)' }] : []),
    ...accounts.map(a => ({ value: 'acc:' + a.id, label: a.name, sub: a.bankName || '통장' })),
    { header: '계정과목' },
    ...subjects.map(s => ({ value: s.code, label: s.name, sub: `${s.code} · ${s.category || '계정과목'}`, keywords: s.code })),
  ], [accounts, subjects])
  const isBank = (v) => typeof v === 'string' && v.startsWith('acc:')
  const nameOf = (v) => isBank(v) ? (accounts.find(a => 'acc:' + a.id === v)?.name || '') : (subjects.find(s => s.code === v)?.name || '')

  const setLine = (i, f, v) => setLines(ls => ls.map((l, j) => j === i ? { ...l, [f]: v } : l))
  const addLine = () => setLines(ls => [...ls, emptyLine()])
  const delLine = (i) => setLines(ls => ls.length <= 2 ? ls : ls.filter((_, j) => j !== i))

  const debitSum = useMemo(() => lines.reduce((s, l) => s + numOf(l.debit), 0), [lines])
  const creditSum = useMemo(() => lines.reduce((s, l) => s + numOf(l.credit), 0), [lines])
  const balanced = debitSum > 0 && debitSum === creditSum
  const usable = lines.filter(l => l.acct && (numOf(l.debit) || numOf(l.credit)))

  const reset = () => { setDate(localToday()); setSummary(''); setLines([emptyLine(), emptyLine()]) }

  const save = async () => {
    if (usable.length < 2) return toast.push('차변·대변 줄을 둘 이상 적어주세요', { tone: 'warn' })
    if (lines.some(l => numOf(l.debit) && numOf(l.credit))) return toast.push('한 줄에는 차변이나 대변 하나만 적어주세요', { tone: 'warn' })
    if (!balanced) return toast.push('차변 합계와 대변 합계가 같아야 해요', { tone: 'warn' })

    const banks = usable.filter(l => isBank(l.acct))
    if (banks.length > 1) return toast.push('통장은 한 줄만 — 통장끼리 옮기는 건 내부 이체 화면을 쓰세요', { tone: 'warn' })

    setBusy(true)
    try {
      if (banks.length === 1) {
        // 통장이 오간 거래 — 통장 줄이 차변이면 입금, 대변이면 지출. 나머지 줄은 비목(복합 항목).
        const bank = banks[0]
        const bankDebit = numOf(bank.debit) > 0
        const kind = bankDebit ? 'income' : 'expense'
        const amount = numOf(bank.debit) || numOf(bank.credit)
        const counters = usable.filter(l => l !== bank)
        const splits = counters.map(l => {
          const amt = numOf(l.debit) || numOf(l.credit)
          const vat = VAT_CODES.has(l.acct)
          return { category: nameOf(l.acct), account_code: l.acct,
                   supply_amount: vat ? 0 : amt, vat_amount: vat ? amt : 0, amount: amt,
                   tax_type: vat ? '과세' : '면세', memo: l.memo || '' }
        })
        const res = await api.addTransaction({
          kind, account_id: bank.acct.slice(4), amount, date,
          category: splits[0]?.category || '복합', memo: summary || counters[0]?.memo || '전표 입력',
          status: kind === 'income' ? '입금완료' : '지급완료',
          splits,
        })
        if (!res.ok) return toast.push(res.error || '저장에 실패했어요', { tone: 'warn' })
        toast.push('거래로 저장했어요 (거래내역·전표목록에서 보여요)')
        reset(); load()
        setView({ source: 'transaction', id: res.id })
      } else {
        // 통장 없음 — 순수 대체전표
        const res = await api.createJournalVoucher({
          date, summary,
          lines: usable.map(l => ({
            side: numOf(l.debit) ? 'debit' : 'credit', account_code: l.acct, account_name: nameOf(l.acct),
            amount: numOf(l.debit) || numOf(l.credit), memo: l.memo || '',
          })),
        })
        if (!res.ok) return toast.push(res.error || '저장에 실패했어요', { tone: 'warn' })
        toast.push(`전표 ${res.doc_no}를 저장했어요`)
        reset(); load()
        openJournalView(res.id)
      }
    } finally { setBusy(false) }
  }

  // 대체전표를 전표 보기(인쇄 가능)로 — 저장된 줄을 그 모양으로 편다
  const openJournalView = async (id) => {
    const v = await api.getJournalVoucher(id)
    if (!v) return
    setView({ voucher: {
      type: '대체전표', date: v.date, source: 'journal',
      counterparty: '', category: '', summary: v.summary || v.memo || '',
      lines: (v.lines || []).map(l => ({ side: l.side, code: l.account_code, name: l.account_name, amount: Number(l.amount) || 0 })),
      debitTotal: (v.lines || []).filter(l => l.side === 'debit').reduce((s, l) => s + (Number(l.amount) || 0), 0),
      creditTotal: (v.lines || []).filter(l => l.side === 'credit').reduce((s, l) => s + (Number(l.amount) || 0), 0),
      balanced: true,
    } })
  }

  const remove = async (v) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: '전표 삭제',
      body: `전표 ${v.doc_no}를 지웁니다.`, detail: '분개 줄이 함께 지워져요.', confirmLabel: '삭제',
    })
    if (!ok) return
    const res = await api.deleteJournalVoucher(v.id)
    toast.push(res.ok ? '전표를 지웠어요' : (res.error || '삭제에 실패했어요'), res.ok ? undefined : { tone: 'warn' })
    load()
  }

  return (
    <div className="fade-up">
      <PageHeader title="전표 입력"
        sub="거래내역에서 보는 전표 모양 그대로, 차변·대변에 줄을 더해 입력해요. 통장 줄이 있으면 통장이 오간 거래로, 없으면 대체전표로 저장돼요."/>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row gap-12" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
          <div><label className="label">날짜</label>
            <DateInput className="input" style={{ width: 160 }} max={localToday()} value={date} onChange={e => setDate(e.target.value)}/>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}><label className="label">전표 적요</label>
            <input className="input" value={summary} placeholder="예: 자동차보험료 납부" onChange={e => setSummary(e.target.value)}/>
          </div>
        </div>

        {/* 드로어에 뜨는 전표 그 모양 그대로 — 차변 | 계정과목 | 대변. 칸 안을 채워 넣는다.
            계정과목 칸에 계정(또는 통장)을 고르고, 그 아래 줄 적요를 적는다. */}
        <table className="table voucher-entry-table">
          <thead>
            <tr>
              <th className="num-right" style={{ width: 200 }}>차변</th>
              <th style={{ textAlign: 'center' }}>계정과목</th>
              <th className="num-right" style={{ width: 200 }}>대변</th>
              <th className="no-print" style={{ width: 32 }}/>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><MoneyInput value={l.debit} onChange={raw => setLine(i, 'debit', raw)}/></td>
                <td>
                  <Combobox value={l.acct} allowAdd={false} options={opts}
                    onChange={v => setLine(i, 'acct', v)} placeholder="계정과목 · 통장 선택"/>
                  <input className="input" style={{ marginTop: 4, fontSize: 12 }} value={l.memo}
                    placeholder="줄 적요(선택)" onChange={e => setLine(i, 'memo', e.target.value)}/>
                </td>
                <td><MoneyInput value={l.credit} onChange={raw => setLine(i, 'credit', raw)}/></td>
                <td className="no-print" style={{ textAlign: 'center', verticalAlign: 'top' }}>
                  <button className="icon-btn sm" title="줄 삭제" onClick={() => delLine(i)} disabled={lines.length <= 2}><Icon.Close size={14}/></button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th className="num-cell num-right" style={{ color: balanced ? undefined : 'var(--neg-ink)' }}>{fmtNum(debitSum)}</th>
              <th style={{ textAlign: 'center' }}>합계</th>
              <th className="num-cell num-right" style={{ color: balanced ? undefined : 'var(--neg-ink)' }}>{fmtNum(creditSum)}</th>
              <th className="no-print"/>
            </tr>
          </tfoot>
        </table>

        <div className="row gap-8" style={{ alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={addLine}><Icon.Plus size={13}/> 줄 추가</button>
          {debitSum !== creditSum
            ? <span className="badge warn" style={{ fontSize: 11 }}>차변·대변 차이 {fmtNum(Math.abs(debitSum - creditSum))}</span>
            : (debitSum > 0 && <span className="badge pos" style={{ fontSize: 11 }}>차·대변 일치</span>)}
          <button className="btn primary ml-auto" onClick={save} disabled={busy || !balanced || usable.length < 2}>
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

      {/* 저장한 전표·목록 클릭 → 전표 보기(인쇄 가능) */}
      <VoucherView open={!!view} voucher={view?.voucher} source={view?.source} id={view?.id} onClose={() => setView(null)}/>
    </div>
  )
}
