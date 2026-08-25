import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Combobox, MoneyInput, DateInput, localToday } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { Drawer } from '../lib/ui'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { DataTable } from '../lib/components/DataTable'
import { api } from '../lib/api'

/**
 * 계좌 이체 — 내 통장에서 내 카드·다른 통장으로 옮기는 돈.
 *
 * ── 왜 이 화면이 필요한가 ──
 * 이 돈은 **벌지도 쓰지도 않은 돈**이다. 그런데 여태 적을 자리가 이체가 아니라 지출뿐이었다.
 * 그래서 신용카드를 쓰면 이렇게 됐다:
 *   · 카드로 산 소모품  → 지출 1건 (비용)
 *   · 결제일 통장 출금  → 지출 1건 (또 비용)   ← **같은 돈이 비용으로 두 번**
 * 안 적으면 반대로 통장 잔액이 실제보다 많다. 둘 다 틀린데, 둘 다 에러가 안 난다.
 *
 * ── 이 화면이 하는 일 ──
 *   1. 카드 결제 도우미 — 신용카드별 **아직 결제 안 된 사용액**과 결제일을 보여주고,
 *      누르면 금액·계좌가 채워진 채로 이체 폼이 열린다. 카드값 처리가 두 번 클릭이 된다.
 *   2. 이체 등록 — 통장 ↔ 통장도 같은 폼으로.
 *   3. 이체 내역 — 오간 것을 되짚는다.
 *
 * ⚠ 체크카드는 여기 안 나온다. 쓴 즉시 통장에서 빠지므로 옮길 돈이 없다.
 *   (신용/체크 구분은 기준정보 > 계좌에서 정한다)
 */

/** 그 달의 결제일 — 짧은 달이면 말일로 당긴다(2월 30일 같은 날짜는 없다) */
const payDateOf = (y, m, day) => {
  const last = new Date(y, m, 0).getDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`
}

/** 이번 결제일과 그 결제일이 덮는 사용 구간(지난 결제일 다음날 ~ 이번 결제일) */
function billingWindow(today, payDay) {
  const [y, m] = today.split('-').map(Number)
  let py = y, pm = m
  // 이번 달 결제일이 이미 지났으면 다음 달 것을 본다
  if (today > payDateOf(y, m, payDay)) { pm += 1; if (pm > 12) { pm = 1; py += 1 } }
  const payDate = payDateOf(py, pm, payDay)
  const prev = new Date(py, pm - 2, 1)
  const from = payDateOf(prev.getFullYear(), prev.getMonth() + 1, payDay)
  return { payDate, from, to: payDate }
}

export const TransferScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [accounts, setAccounts] = useState([])
  const [rows, setRows] = useState([])
  const [form, setForm] = useState(null)   // null 이면 폼이 닫힌 상태
  const [busy, setBusy] = useState(false)

  const today = localToday()

  const load = async () => {
    const [accs, expense] = await Promise.all([
      api.getAccounts(), api.getTransactions({ kind: 'expense' }),
    ])
    setAccounts(accs)
    /* 이체 내역 — 두 줄 중 **보내는 쪽(지출)만** 목록에 세운다.
       둘 다 세우면 한 번의 이체가 두 줄로 보여 "두 번 옮겼나" 싶어진다. */
    setRows((expense || []).filter(t => t.transferId)
      .sort((a, b) => String(b.date).localeCompare(String(a.date))))
  }
  useEffect(() => { load() }, [])

  const byId = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts])

  /* 카드 결제 도우미 — 신용카드별 **아직 안 갚은 돈**.
   *
   * ⚠ 금액은 '이번 구간 사용액'이 아니라 **카드 계좌 잔액**(음수)의 절대값이다.
   *   처음엔 구간 사용액으로 셌는데, 그러면 **이미 결제한 뒤에도 같은 금액이 계속 떠 있었다**
   *   (실제로 그렇게 만들어 확인했다). 결제는 이체로 들어오는 income 인데 구간 사용액은
   *   지출만 세기 때문이다. 잔액으로 보면 결제분이 자동으로 빠지고, **지난달 미납분까지**
   *   함께 잡힌다 — 결제할 사람이 알고 싶은 건 정확히 그 숫자다.
   *
   * 결제일이 없으면 세지 않는다. 언제 빠지는지 모르면 "지금 결제하라"고 말할 수 없다
   * (자금일보도 같은 이유로 그렇게 한다 — lib/cashReport.js).
   */
  const cardBills = useMemo(() => {
    return accounts
      .filter(a => a.kind === 'card' && a.cardType === 'credit' && a.cardPayDay > 0)
      .map(a => ({
        card: a,
        payDate: billingWindow(today, a.cardPayDay).payDate,
        unpaid: Math.max(0, -(a.currentBalance ?? 0)),
        payAcct: byId.get(a.cardPayAccountId) || null,
      }))
      .filter(b => b.unpaid > 0)
      .sort((a, b) => a.payDate.localeCompare(b.payDate))
  }, [accounts, byId, today])

  const openForm = (preset = {}) => setForm({
    fromAccountId: '', toAccountId: '', amount: '', date: today, memo: '', ...preset,
  })

  const save = async () => {
    if (!form.fromAccountId || !form.toAccountId) return toast.push('보내는 계좌와 받는 계좌를 골라주세요', { tone: 'warn' })
    if (form.fromAccountId === form.toAccountId) return toast.push('같은 계좌로는 옮길 수 없어요', { tone: 'warn' })
    const amt = Number(String(form.amount).replace(/[^0-9-]/g, '')) || 0
    if (amt <= 0) return toast.push('금액을 입력해주세요', { tone: 'warn' })

    const from = byId.get(form.fromAccountId), to = byId.get(form.toAccountId)
    const ok = await confirm({
      tone: 'brand', icon: <Icon.Bank size={22}/>, title: '계좌 이체',
      body: `${from?.name} → ${to?.name} 으로 ${fmtNum(amt)}원을 옮깁니다.`,
      detail: '수입도 지출도 아니에요. 두 계좌의 잔액만 바뀌고 손익에는 잡히지 않습니다.',
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

  const acctOpts = accounts.map(a => ({
    value: a.id, label: a.name,
    sub: [a.kind === 'card' ? (a.cardType === 'check' ? '체크카드' : '신용카드') : a.bankName, a.number].filter(Boolean).join(' '),
  }))

  return (
    <div className="fade-up">
      <PageHeader title="계좌 이체"
        sub="통장에서 카드·다른 통장으로 옮기는 돈이에요. 수입도 지출도 아니라 손익에는 잡히지 않아요."
        actions={<button className="btn primary" onClick={() => openForm()}><Icon.Plus size={14}/> 이체 등록</button>}/>

      {/* 카드 결제 도우미 — 비어 있으면 안 그린다(이 앱의 규칙).
          "결제할 카드 없음" 빈 카드를 매번 보여주면 진짜 있을 때도 안 보게 된다. */}
      {cardBills.length > 0 && (
        <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
          <div className="row" style={{ padding: '12px 16px', gap: 10, borderBottom: '1px solid var(--line)' }}>
            <span className="badge warn" style={{ fontSize: 11 }}><Icon.Card size={13}/> 카드 결제</span>
            <span className="text-xs text-muted2">
              아직 안 갚은 카드값이에요. 지난달 미납분이 있으면 함께 잡힙니다.
            </span>
          </div>
          <table className="table">
            <thead><tr>
              <th>카드</th><th>다음 결제일</th><th>결제 계좌</th>
              <th className="num-right">미결제 잔액</th><th style={{ width: 110 }}></th>
            </tr></thead>
            <tbody>
              {cardBills.map(b => (
                <tr key={b.card.id}>
                  <td className="fw-700">{b.card.name}</td>
                  <td className="text-sm num">{b.payDate}</td>
                  <td className="text-sm text-muted">{b.payAcct?.name || <span className="badge neg" style={{ fontSize: 10 }}>미설정</span>}</td>
                  <td className="num-cell num-right fw-700">{fmtNum(b.unpaid)}</td>
                  <td>
                    {/* 결제 계좌가 없으면 어디서 빼야 할지 모른다 — 기준정보에서 채우게 안내한다 */}
                    <button className="btn sm" disabled={!b.payAcct}
                      title={b.payAcct ? undefined : '기준정보 > 계좌에서 결제 계좌를 지정해주세요'}
                      onClick={() => openForm({
                        fromAccountId: b.payAcct.id, toAccountId: b.card.id,
                        amount: String(b.unpaid),
                        // 결제일이 아직 안 왔으면 오늘로 — 미래 날짜는 서버가 막는다
                        date: b.payDate > today ? today : b.payDate,
                        memo: `${b.card.name} 카드대금`,
                      })}>결제 처리</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <DataTable
          rows={rows}
          empty="이체 내역이 없어요. 카드대금이나 통장 간 이동을 여기서 기록하세요."
          columns={[
            { key: 'date', header: '날짜', sortable: true,
              render: t => <span className="text-sm num">{t.date}</span> },
            { key: 'from', header: '보내는 계좌',
              render: t => <span className="fw-700">{byId.get(t.accountId)?.name || '—'}</span> },
            { key: 'to', header: '받는 계좌',
              render: t => <span className="text-sm">{byId.get(t.counterpartyAccountId)?.name || '—'}</span> },
            { key: 'memo', header: '내용', render: t => <span className="text-sm text-muted">{t.memo || '—'}</span> },
            { key: 'amount', header: '금액', align: 'right', sortable: true,
              render: t => <span className="num-cell">{fmtNum(t.amount)}</span> },
            { key: 'act', header: '', align: 'right',
              render: t => <button className="btn sm" style={{ color: 'var(--neg-ink)' }} onClick={() => remove(t)}>취소</button> },
          ]}/>
      </div>

      {/* 폼은 Drawer 로 낸다 — 이 앱의 모든 폼이 그렇다(CLAUDE.md). 여기만 모달을 쓰면
          닫기 동작·확인창·모바일 폭이 다른 화면과 어긋난다. */}
      <Drawer open={!!form} onClose={() => setForm(null)} width="min(480px,100vw)" label="계좌 이체">
        <DrawerHead title="계좌 이체" sub="수입도 지출도 아니에요 — 두 계좌의 잔액만 바뀝니다"
          onClose={() => setForm(null)}/>
        {form && (
          <div className="drawer-body col gap-form">
              <div><label className="label">보내는 계좌 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                <Combobox value={form.fromAccountId} allowAdd={false}
                  onChange={v => setForm(f => ({ ...f, fromAccountId: v }))}
                  options={acctOpts.filter(o => o.value !== form.toAccountId)} placeholder="계좌 선택"/>
              </div>
              <div><label className="label">받는 계좌 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                <Combobox value={form.toAccountId} allowAdd={false}
                  onChange={v => setForm(f => ({ ...f, toAccountId: v }))}
                  options={acctOpts.filter(o => o.value !== form.fromAccountId)} placeholder="계좌 선택"/>
              </div>
              <div className="row gap-12">
                <div style={{ flex: 1 }}><label className="label">금액 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                  <MoneyInput value={form.amount} onChange={raw => setForm(f => ({ ...f, amount: raw }))}/>
                </div>
                <div style={{ flex: 1 }}><label className="label">날짜 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                  <DateInput className="input" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}/>
                </div>
              </div>
              <div><label className="label">내용</label>
                <input className="input" value={form.memo} placeholder="예: 국민카드 8월 대금"
                  onChange={e => setForm(f => ({ ...f, memo: e.target.value }))}/>
              </div>
              <div className="text-xs text-muted2" style={{ lineHeight: 1.7 }}>
                · 거래내역에는 <b>두 줄</b>로 남아요 — 보내는 계좌의 출금, 받는 계좌의 입금.<br/>
                · 손익에는 잡히지 않아요. 벌지도 쓰지도 않은 돈이니까요.
              </div>
          </div>
        )}
        <DrawerFooter onCancel={() => setForm(null)} onSave={save} saveLabel="이체" busy={busy}/>
      </Drawer>
    </div>
  )
}
