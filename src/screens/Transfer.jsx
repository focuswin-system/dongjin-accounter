import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Combobox, MoneyInput, DateInput, localToday } from '../lib/ui'
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
export const TransferScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [accounts, setAccounts] = useState([])
  const [rows, setRows] = useState([])
  const [form, setForm] = useState(null)   // null 이면 폼이 닫힌 상태
  const [busy, setBusy] = useState(false)
  const [txnOpen, setTxnOpen] = useState(null)   // 이체 내역 행에서 연 거래 상세

  const today = localToday()

  const load = async () => {
    const [accs, expense] = await Promise.all([
      api.getAccounts(), api.getTransactions({ kind: 'expense' }),
    ])
    setAccounts(accs)
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
    <div className="fade-up">
      <PageHeader title="내부 계좌 이체"
        sub="우리 통장끼리 옮기는 돈이에요. 수입도 지출도 아니라 손익에는 잡히지 않아요."
        actions={<button className="btn primary" onClick={() => openForm()}><Icon.Plus size={14}/> 이체 등록</button>}/>

      <div className="card" style={{ overflow: 'hidden' }}>
        <DataTable
          rows={rows}
          // 행을 누르면 그 거래가 열린다 — 다른 목록과 같은 규칙
          onRowClick={t => setTxnOpen(t.id)}
          empty="이체 내역이 없어요. 급여계좌 보충·시재통장 채우기 같은 통장 간 이동을 여기에 기록하세요."
          columns={[
            { key: 'date', header: '날짜', sortable: true,
              render: t => <span className="text-sm num">{t.date}</span> },
            { key: 'from', header: '보내는 통장',
              render: t => <span className="fw-700">{byId.get(t.accountId)?.name || '—'}</span> },
            { key: 'to', header: '받는 통장',
              render: t => <span className="text-sm">{byId.get(t.counterpartyAccountId)?.name || '—'}</span> },
            { key: 'memo', header: '내용', render: t => <span className="text-sm text-muted">{t.memo || '—'}</span> },
            { key: 'amount', header: '금액', align: 'right', sortable: true,
              render: t => <span className="num-cell">{fmtNum(t.amount)}</span> },
            { key: 'act', header: '', align: 'right',
              render: t => <button className="btn sm" style={{ color: 'var(--neg-ink)' }}
                onClick={(e) => { e.stopPropagation(); remove(t) }}>취소</button> },
          ]}/>
      </div>

      {txnOpen && <TxnQuickDrawer txnId={txnOpen} onClose={() => setTxnOpen(null)} onChanged={load}/>}

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
