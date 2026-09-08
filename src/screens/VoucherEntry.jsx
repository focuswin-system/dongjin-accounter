import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Combobox, MoneyInput, DateInput, localToday, fmtDateShort } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { api } from '../lib/api'

/**
 * 전표 입력 — 순수 대체 전표(현금이 안 움직이는 분개)를 차·대변으로 직접 적는다.
 *
 * ⚠ 통장이 오가는 건 여기가 아니라 **입금·출금**에서 넣는다 — 그래야 잔액에 잡힌다.
 *   여기 전표는 통장을 안 거치므로(감가상각·대손상각 등) 잔액과 무관하고,
 *   전표 목록(분개장)·비은행 계정 원장에만 나온다.
 * ⚠ 차변 합계 = 대변 합계 여야 저장된다(복식부기의 기본). 화면이 실시간으로 알려준다.
 */

const numOf = (v) => (typeof v === 'string' ? parseInt(v.replace(/[^0-9-]/g, ''), 10) || 0 : Number(v) || 0)
const emptyLine = () => ({ account_code: '', account_name: '', debit: '', credit: '' })

export const VoucherEntryScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [subjects, setSubjects] = useState([])
  const [list, setList] = useState([])
  const [date, setDate] = useState(localToday())
  const [summary, setSummary] = useState('')
  const [lines, setLines] = useState([emptyLine(), emptyLine()])
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const [subs, vs] = await Promise.all([api.getAccountSubjects({ postableOnly: true }), api.getJournalVouchers()])
    setSubjects(subs || [])
    setList(vs || [])
  }
  useEffect(() => { load() }, [])

  const opts = useMemo(() => (subjects || []).map(s => ({
    value: s.code, label: s.name, sub: `${s.code}${s.acct_type ? ' · ' + s.acct_type : ''}`,
  })), [subjects])
  const nameOf = (code) => (subjects.find(s => s.code === code)?.name || '')

  const setLine = (i, field, v) => setLines(ls => ls.map((l, j) => j === i ? { ...l, [field]: v } : l))
  const addLine = () => setLines(ls => [...ls, emptyLine()])
  const delLine = (i) => setLines(ls => ls.length <= 2 ? ls : ls.filter((_, j) => j !== i))

  const debitSum = useMemo(() => lines.reduce((s, l) => s + numOf(l.debit), 0), [lines])
  const creditSum = useMemo(() => lines.reduce((s, l) => s + numOf(l.credit), 0), [lines])
  const balanced = debitSum > 0 && debitSum === creditSum
  const usableCount = lines.filter(l => l.account_code && (numOf(l.debit) || numOf(l.credit))).length

  const reset = () => { setDate(localToday()); setSummary(''); setLines([emptyLine(), emptyLine()]) }

  const save = async () => {
    if (usableCount < 2) return toast.push('차변·대변 줄을 둘 이상 적어주세요', { tone: 'warn' })
    if (!balanced) return toast.push('차변 합계와 대변 합계가 같아야 해요', { tone: 'warn' })
    // 한 줄에 차변·대변을 동시에 적으면 안 된다 — 어느 쪽인지 애매하다
    if (lines.some(l => numOf(l.debit) && numOf(l.credit))) return toast.push('한 줄에는 차변이나 대변 하나만 적어주세요', { tone: 'warn' })
    const payload = {
      date, summary,
      lines: lines.filter(l => l.account_code && (numOf(l.debit) || numOf(l.credit))).map(l => ({
        side: numOf(l.debit) ? 'debit' : 'credit',
        account_code: l.account_code, account_name: nameOf(l.account_code),
        amount: numOf(l.debit) || numOf(l.credit), memo: '',
      })),
    }
    setBusy(true)
    const res = await api.createJournalVoucher(payload)
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '저장에 실패했어요', { tone: 'warn' })
    toast.push(`전표 ${res.doc_no}를 저장했어요`)
    reset(); load()
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
        sub="현금이 안 움직이는 분개(감가상각·대손상각 등)를 차·대변으로 직접 적어요. 통장이 오가는 건 입금·출금에서 넣으세요."/>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row gap-12" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
          <div><label className="label">날짜</label>
            <DateInput className="input" style={{ width: 160 }} max={localToday()} value={date}
              onChange={e => setDate(e.target.value)}/>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}><label className="label">적요</label>
            <input className="input" value={summary} placeholder="예: 6월 감가상각"
              onChange={e => setSummary(e.target.value)}/>
          </div>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>계정과목</th>
              <th className="num-right" style={{ width: 160 }}>차변</th>
              <th className="num-right" style={{ width: 160 }}>대변</th>
              <th style={{ width: 34 }}/>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <Combobox value={l.account_code} allowAdd={false}
                    onChange={v => setLine(i, 'account_code', v)} options={opts} placeholder="계정과목 선택"/>
                </td>
                <td><MoneyInput value={l.debit} onChange={raw => setLine(i, 'debit', raw)}/></td>
                <td><MoneyInput value={l.credit} onChange={raw => setLine(i, 'credit', raw)}/></td>
                <td style={{ textAlign: 'center' }}>
                  <button className="icon-btn sm" title="줄 삭제" onClick={() => delLine(i)} disabled={lines.length <= 2}>
                    <Icon.Close size={14}/>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th style={{ textAlign: 'right' }}>합계</th>
              <th className="num-cell num-right" style={{ color: balanced ? undefined : 'var(--neg-ink)' }}>{fmtNum(debitSum)}</th>
              <th className="num-cell num-right" style={{ color: balanced ? undefined : 'var(--neg-ink)' }}>{fmtNum(creditSum)}</th>
              <th/>
            </tr>
          </tfoot>
        </table>

        <div className="row gap-8" style={{ alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={addLine}><Icon.Plus size={13}/> 줄 추가</button>
          {debitSum !== creditSum
            ? <span className="badge warn" style={{ fontSize: 11 }}>차변·대변 차이 {fmtNum(Math.abs(debitSum - creditSum))}</span>
            : (debitSum > 0 && <span className="badge pos" style={{ fontSize: 11 }}>차·대변 일치</span>)}
          <button className="btn primary ml-auto" onClick={save} disabled={busy || !balanced || usableCount < 2}>
            <Icon.Check size={14}/> 전표 저장
          </button>
        </div>
      </div>

      {/* 최근 대체전표 — 지운다(수정은 지우고 다시 적는다: 분개는 줄이 통째로 바뀌므로 그 편이 안전) */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-pad" style={{ paddingBottom: 8 }}><span className="fw-700 text-sm">최근 전표</span></div>
        {list.length === 0
          ? <div className="text-sm text-muted2" style={{ padding: '8px 16px 20px' }}>아직 입력한 대체전표가 없어요.</div>
          : (
            <table className="table">
              <thead><tr><th style={{ width: 130 }}>전표번호</th><th style={{ width: 110 }}>날짜</th><th>적요</th><th className="num-right" style={{ width: 140 }}>금액</th><th style={{ width: 60 }}/></tr></thead>
              <tbody>
                {list.map(v => (
                  <tr key={v.id}>
                    <td className="num text-sm">{v.doc_no}</td>
                    <td className="text-sm text-muted">{fmtDateShort(v.date)}</td>
                    <td className="text-sm">{v.summary || v.memo || '—'}</td>
                    <td className="num-cell num-right">{fmtNum(v.total)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm" style={{ color: 'var(--neg-ink)' }} onClick={() => remove(v)}>삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  )
}
