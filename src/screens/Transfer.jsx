import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Combobox, MoneyInput, DateInput, localToday, fmtDateShort, periodToRange } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { Drawer } from '../lib/ui'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { DataTable } from '../lib/components/DataTable'
import { api } from '../lib/api'
import { TxnQuickDrawer } from '../lib/components/TxnQuickDrawer'

/**
 * 내부 계좌 이체 — 우리 통장에서 우리 다른 통장으로 옮기는 돈.
 *
 * **벌지도 쓰지도 않은 돈**이라 수입도 지출도 아니다. 자산 안에서 자리만 바뀐다
 * (예금 A ↓ + 예금 B ↑, 총액은 그대로). 급여일 전에 급여계좌를 채우거나
 * 시재통장을 보충하는 일이 여기다.
 *
 * ⚠ 카드 대금은 여기가 아니라 **카드 대금 지급** 화면이다. 저장 모양은 같지만
 *   (양쪽 다 두 줄 대체 거래, api.transfer 하나를 쓴다) 하는 일이 다르다 —
 *   카드 대금은 빚을 갚는 것(예금 ↓ + 미지급금 ↓)이고 본체가 '갚을 카드 목록'이다.
 *   한 화면에 뒀더니 훨씬 자주 하는 카드값이 이 화면의 보조 표로 얹혀 있었다.
 *
 * ⚠ 받는 쪽으로 **카드를 고를 수 없다.** 신용카드는 위 화면에서 갚고,
 *   체크카드는 쓴 즉시 통장에서 빠져 갚을 것이 없다 — 체크카드로 이체하면
 *   있지도 않은 잔액이 생긴다.
 */
export const TransferScreen = ({ openEdit }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [accounts, setAccounts] = useState([])
  const [rows, setRows] = useState([])
  const [company, setCompany] = useState(null)   // 인쇄 보고물 머리글용
  const [form, setForm] = useState(null)   // null 이면 폼이 닫힌 상태
  const [busy, setBusy] = useState(false)
  const [txnOpen, setTxnOpen] = useState(null)   // 이체 내역 행에서 연 거래 상세

  const today = localToday()
  /* 보고물·엑셀은 기간을 정해 뽑는다 — 거래처에 "이 기간에 이렇게 옮겼습니다"로 낸다.
     기본은 올해. 이체는 잦지 않아 이번 달로 잡으면 대개 빈 표가 된다. */
  const [range, setRange] = useState(() => periodToRange('year'))
  /* 계좌번호 표시 — 받는 사람·용도에 따라 다르다. 대외 보고엔 마스킹, 내부 확인엔 전체,
     통장 이름만으로 충분하면 숨김. 기본은 숨김(예전 동작 그대로). */
  const [numMode, setNumMode] = useState('hide')   // 'hide' | 'mask' | 'full'
  /* 인쇄 방향 — 계좌번호까지 켜면 가로가 편하다. 기본 세로. */
  const [landscape, setLandscape] = useState(false)

  const load = async () => {
    const [accs, expense, comp] = await Promise.all([
      api.getAccounts(), api.getTransactions({ kind: 'expense' }), api.getCompany(),
    ])
    setAccounts(accs)
    setCompany(comp)
    /* 이체 내역 — 두 줄 중 **보내는 쪽(지출)만** 목록에 세운다.
       둘 다 세우면 한 번의 이체가 두 줄로 보여 "두 번 옮겼나" 싶어진다.
       카드가 낀 줄은 카드 대금 지급 화면 소관이라 여기서 뺀다 — 안 그러면
       같은 기록이 두 화면에 나와 어느 쪽에서 취소해야 하는지 갈린다. */
    const cardIds = new Set((accs || []).filter(a => a.kind === 'card').map(a => a.id))
    setRows((expense || [])
      .filter(t => t.transferId && !cardIds.has(t.accountId) && !cardIds.has(t.counterpartyAccountId))
      .sort((a, b) => String(b.date).localeCompare(String(a.date))))
  }
  useEffect(() => { load() }, [])

  const byId = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts])
  // 통장만 — 카드는 양쪽 어디에도 못 온다(위 주석 참고)
  const banks = useMemo(() => accounts.filter(a => a.kind !== 'card'), [accounts])

  // 기간 안의 이체만 — 보고물·엑셀·화면이 같은 것을 본다
  const shown = useMemo(
    () => rows.filter(t => (!range.from || t.date >= range.from) && (!range.to || t.date <= range.to)),
    [rows, range])
  const total = useMemo(() => shown.reduce((s, t) => s + (Number(t.amount) || 0), 0), [shown])
  const acctLabel = (id) => byId.get(id)?.name || '—'
  const acctSub = (id) => { const a = byId.get(id); return a ? [a.bankName, a.number].filter(Boolean).join(' ') : '' }

  /* 계좌번호를 표시 모드대로 낸다. 마스킹은 **뒤 4자리만** 남기고 나머지 숫자를 가린다
     (하이픈 등 구분자는 그대로 둬 자릿수 감을 유지). 숨김이면 빈 문자열. */
  const maskNo = (s) => {
    const str = String(s || ''); if (!str) return ''
    const digitPos = []
    for (let i = 0; i < str.length; i++) if (/\d/.test(str[i])) digitPos.push(i)
    const keep = new Set(digitPos.slice(-4))
    return str.split('').map((ch, i) => (/\d/.test(ch) && !keep.has(i)) ? '●' : ch).join('')
  }
  const acctNo = (id) => {
    if (numMode === 'hide') return ''
    const a = byId.get(id); if (!a || !a.number) return ''
    const no = [a.bankName, a.number].filter(Boolean).join(' ')
    return numMode === 'mask' ? maskNo(no) : no
  }

  /* 내보내기·인쇄 파일 이름 — '계좌 간 이체' + 기간 + 만든 날짜.
     받는 사람이 파일만 봐도 무엇의 언제 기준인지 알 수 있게 한다. */
  const docName = () => `계좌 간 이체 (${range.from}~${range.to}) ${today}`

  /* 엑셀은 서식 있는 xlsx 로 낸다 — 서버 xlsxBook 이 머리글·합계·안내 시트까지 만든다
     (CSV 로 대충 내지 않는다 — 프로젝트 규칙). 계좌번호 표시 모드는 화면과 같이 간다. */
  const exportXlsx = async () => {
    if (shown.length === 0) return toast.push('내보낼 이체가 없어요')
    const res = await api.downloadTransfersXlsx({ from: range.from, to: range.to, nums: numMode, filename: `${docName()}.xlsx` })
    if (!res.ok) toast.push(res.error || '내려받기에 실패했어요', { tone: 'warn' })
  }

  /* 인쇄로 PDF 저장 시 파일 이름은 브라우저가 document.title 을 쓴다 —
     인쇄 직전에 바꿔 두고 끝나면 되돌린다. 버튼 인쇄든 Ctrl+P 든 같게 동작한다. */
  useEffect(() => {
    const prev = document.title
    const before = () => { document.title = docName() }
    const after = () => { document.title = prev }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after) }
  }, [range])   // eslint-disable-line react-hooks/exhaustive-deps

  const openForm = (preset = {}) => setForm({
    fromAccountId: '', toAccountId: '', amount: '', date: today, memo: '', ...preset,
  })

  const save = async () => {
    if (!form.fromAccountId || !form.toAccountId) return toast.push('보내는 통장과 받는 통장을 골라주세요', { tone: 'warn' })
    if (form.fromAccountId === form.toAccountId) return toast.push('같은 통장으로는 옮길 수 없어요', { tone: 'warn' })
    const amt = Number(String(form.amount).replace(/[^0-9-]/g, '')) || 0
    if (amt <= 0) return toast.push('금액을 입력해주세요', { tone: 'warn' })

    const from = byId.get(form.fromAccountId), to = byId.get(form.toAccountId)
    const ok = await confirm({
      tone: 'brand', icon: <Icon.Bank size={22}/>, title: '내부 계좌 이체',
      body: `${from?.name} → ${to?.name} 으로 ${fmtNum(amt)}원을 옮깁니다.`,
      detail: '수입도 지출도 아니에요. 두 통장의 잔액만 바뀌고 손익에는 잡히지 않습니다.',
      confirmLabel: '이체',
    })
    if (!ok) return
    setBusy(true)
    const res = await api.transfer({ ...form, amount: amt })
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '이체에 실패했어요', { tone: 'warn' })
    toast.push('이체했어요')
    setForm(null)
    load()
  }

  const remove = async (r) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: '이체 취소',
      body: `${fmtNum(r.amount)}원 이체를 지웁니다.`,
      detail: '보내는 쪽과 받는 쪽 두 줄이 함께 지워져요. 한쪽만 남으면 돈이 사라지거나 생겨납니다.',
      confirmLabel: '삭제',
    })
    if (!ok) return
    const res = await api.deleteTransaction(r.id)
    toast.push(res.ok ? '이체를 취소했어요' : (res.error || '취소에 실패했어요'), res.ok ? undefined : { tone: 'warn' })
    load()
  }

  const acctOpts = banks.map(a => ({
    value: a.id, label: a.name,
    sub: [a.bankName, a.number].filter(Boolean).join(' '),
  }))

  return (
    /* ⚠ report-print — 인쇄 화이트리스트(index.css @media print) 등록 클래스.
       이걸 빼면 Ctrl+P 가 백지가 된다. 조작부(기간 바·버튼·취소)는 .no-print 로 감춘다. */
    <div className="fade-up report-print">
      {/* 화면 머리(캐주얼 설명·조작부)는 종이에 안 넣는다 — 거래처에 내는 종이엔
          아래 print-only 머리글(회사·기간)만 나온다. 그래서 no-print 로 감싼다. */}
      <div className="no-print">
      <PageHeader title="내부 계좌 이체"
        sub="우리 통장끼리 옮기는 돈이에요. 수입도 지출도 아니라 손익에는 잡히지 않아요."
        actions={<div className="row gap-6" style={{ alignItems: 'center' }}>
          <button className="btn" onClick={exportXlsx} disabled={shown.length === 0}>
            <Icon.Excel size={14}/> 엑셀
          </button>
          <button className="btn" onClick={() => window.print()} disabled={shown.length === 0}>
            <Icon.Print size={14}/> 인쇄
          </button>
          <button className="btn primary" onClick={() => openForm()}><Icon.Plus size={14}/> 이체 등록</button>
        </div>}/>
      </div>

      {/* 가로 인쇄를 고르면 이 규칙이 A4 를 눕힌다. @page 는 스타일시트 어디에 있어도
          브라우저가 인쇄에 반영한다 — 켰을 때만 넣는다(안 넣으면 기본 세로). */}
      {landscape && <style>{`@media print { @page { size: A4 landscape; } }`}</style>}

      {/* 기간 — 보고물·엑셀·화면이 모두 이 기간을 본다 */}
      <div className="card card-pad row no-print" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <DateInput className="input" style={{ width: 150 }} max={today} value={range.from}
          onChange={e => setRange(r => ({ ...r, from: e.target.value }))}/>
        <span className="text-muted2">~</span>
        <DateInput className="input" style={{ width: 150 }} max={today} value={range.to}
          onChange={e => setRange(r => ({ ...r, to: e.target.value }))}/>
        {[['month', '이번 달'], ['year', '올해']].map(([p, label]) => (
          <button key={p} className="chip" onClick={() => setRange(periodToRange(p))}>{label}</button>
        ))}

        <span className="text-muted2" style={{ marginLeft: 'auto' }}>계좌번호</span>
        {[['hide', '숨김'], ['mask', '마스킹'], ['full', '전체']].map(([m, label]) => (
          <button key={m} className={`chip ${numMode === m ? 'active' : ''}`} onClick={() => setNumMode(m)}>{label}</button>
        ))}
        <span className="text-muted2" style={{ marginLeft: 12 }}>인쇄</span>
        {[['portrait', '세로', false], ['landscape', '가로', true]].map(([k, label, v]) => (
          <button key={k} className={`chip ${landscape === v ? 'active' : ''}`} onClick={() => setLandscape(v)}>{label}</button>
        ))}
      </div>

      {/* 인쇄 때만 나오는 머리글 — 거래처에 내는 종이라 회사·기간·제목이 있어야 한다 */}
      <div className="print-only" style={{ textAlign: 'center', marginBottom: 16 }}>
        <div className="fw-700" style={{ fontSize: 20 }}>내부 계좌 이체 내역</div>
        <div className="text-sm text-muted" style={{ marginTop: 6 }}>
          {company?.name || ''}{company?.biz_no ? ` · 사업자 ${company.biz_no}` : ''}
        </div>
        <div className="text-sm text-muted" style={{ marginTop: 2 }}>{range.from} ~ {range.to}</div>
      </div>

      {/* 합계 — 화면·인쇄 모두 */}
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 8, gap: 8, alignItems: 'baseline' }}>
        <span className="text-sm text-muted2">기간 내 이체 {shown.length}건 · 합계</span>
        <span className="num fw-700" style={{ fontSize: 18 }}>{fmtNum(total)}</span>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <DataTable
          rows={shown}
          // 행을 누르면 그 거래가 열린다 — 다른 목록과 같은 규칙
          onRowClick={t => setTxnOpen(t.id)}
          empty="이체 내역이 없어요. 급여계좌 보충·시재통장 채우기 같은 통장 간 이동을 여기에 기록하세요."
          columns={[
            { key: 'date', header: '날짜', sortable: true,
              render: t => <span className="text-sm num">{fmtDateShort(t.date)}</span> },
            { key: 'from', header: '보내는 통장',
              render: t => <div>
                <span className="fw-700">{byId.get(t.accountId)?.name || '—'}</span>
                {acctNo(t.accountId) && <div className="text-xs text-muted2 num">{acctNo(t.accountId)}</div>}
              </div> },
            { key: 'to', header: '받는 통장',
              render: t => <div>
                <span className="text-sm">{byId.get(t.counterpartyAccountId)?.name || '—'}</span>
                {acctNo(t.counterpartyAccountId) && <div className="text-xs text-muted2 num">{acctNo(t.counterpartyAccountId)}</div>}
              </div> },
            { key: 'memo', header: '내용', render: t => <span className="text-sm text-muted">{t.memo || '—'}</span> },
            { key: 'amount', header: '금액', align: 'right', sortable: true,
              render: t => <span className="num-cell">{fmtNum(t.amount)}</span> },
            /* 취소 열은 종이에 필요 없다 — 버튼만이 아니라 열(머리글+칸) 전체를 인쇄에서 뺀다.
               (버튼만 no-print 로 감추면 빈 열이 남아 오른쪽에 빈 칸이 생긴다) */
            { key: 'act', header: '', align: 'right', className: 'no-print', headClassName: 'no-print',
              render: t => <button className="btn sm" style={{ color: 'var(--neg-ink)' }}
                onClick={(e) => { e.stopPropagation(); remove(t) }}>취소</button> },
          ]}/>
      </div>

      {/* 받는 사람이 오해하지 않게 — 내부 이체의 뜻을 종이에도 적는다 */}
      <div className="text-xs text-muted2" style={{ marginTop: 12, lineHeight: 1.7 }}>
        · 우리 회사 통장 사이에서 옮긴 자금이에요. 수입·지출이 아니라 자산의 이동이며 손익에는 반영되지 않습니다.
      </div>

      {txnOpen && <TxnQuickDrawer txnId={txnOpen} onClose={() => setTxnOpen(null)} onChanged={load} openEdit={openEdit}/>}

      {/* 폼은 Drawer 로 낸다 — 이 앱의 모든 폼이 그렇다(CLAUDE.md). 여기만 모달을 쓰면
          닫기 동작·확인창·모바일 폭이 다른 화면과 어긋난다. */}
      <Drawer open={!!form} onClose={() => setForm(null)} width="min(480px,100vw)" label="내부 계좌 이체">
        <DrawerHead title="내부 계좌 이체" sub="수입도 지출도 아니에요 — 두 통장의 잔액만 바뀝니다"
          onClose={() => setForm(null)}/>
        {form && (
          <div className="drawer-body col gap-form">
              <div><label className="label">보내는 통장 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                <Combobox value={form.fromAccountId} allowAdd={false}
                  onChange={v => setForm(f => ({ ...f, fromAccountId: v }))}
                  options={acctOpts.filter(o => o.value !== form.toAccountId)} placeholder="통장 선택"/>
              </div>
              <div><label className="label">받는 통장 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                <Combobox value={form.toAccountId} allowAdd={false}
                  onChange={v => setForm(f => ({ ...f, toAccountId: v }))}
                  options={acctOpts.filter(o => o.value !== form.fromAccountId)} placeholder="통장 선택"/>
              </div>
              <div className="row gap-12">
                <div style={{ flex: 1 }}><label className="label">금액 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                  <MoneyInput value={form.amount} onChange={raw => setForm(f => ({ ...f, amount: raw }))}/>
                </div>
                <div style={{ flex: 1 }}><label className="label">날짜 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                  <DateInput className="input" max={today} value={form.date}
                    onChange={e => setForm(f => ({ ...f, date: e.target.value }))}/>
                </div>
              </div>
              <div><label className="label">내용</label>
                <input className="input" value={form.memo} placeholder="예: 급여계좌 보충"
                  onChange={e => setForm(f => ({ ...f, memo: e.target.value }))}/>
              </div>
              <div className="text-xs text-muted2" style={{ lineHeight: 1.7 }}>
                · 거래내역에는 <b>두 줄</b>로 남아요 — 보내는 통장의 출금, 받는 통장의 입금.<br/>
                · 카드 대금은 <b>카드 대금 지급</b> 화면에서 갚아요.
              </div>
          </div>
        )}
        <DrawerFooter onCancel={() => setForm(null)} onSave={save} saveLabel="이체" busy={busy}/>
      </Drawer>
    </div>
  )
}
