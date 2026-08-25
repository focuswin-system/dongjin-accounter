import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, MoneyInput, DateInput, localToday } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { Drawer } from '../lib/ui'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { api } from '../lib/api'

/**
 * 카드 대금 지급 — 쌓인 카드값을 통장에서 갚는다.
 *
 * ── 왜 '내부 계좌 이체'에서 떼어냈나 ──
 * 저장되는 모양은 이체와 같다(보내는 쪽 출금 + 받는 쪽 입금, 두 줄). 그래서 한 화면에 있었다.
 * 그런데 **하는 일도 화면 뼈대도 다르다.**
 *   · 카드 대금 = 예금 ↓ + 미지급금 ↓ — 빚을 갚는 일. 본체는 **갚을 카드 목록**이다.
 *   · 계좌 이체 = 예금 A ↓ + 예금 B ↑ — 자산 안에서 옮기는 일. 본체는 **폼 하나**다.
 * 한 화면에 두니 훨씬 자주 하는 카드값이 보조 표로 얹혀 있었고, 제목은 어쩌다 하는
 * 통장 이동이 달고 있었다.
 *
 * ── 이 화면이 하는 일 ──
 *   1. 갚을 카드 목록 — 카드별 미결제 잔액과 다음 결제일.
 *   2. **명세서 대조** — 이번 구간에 우리 장부가 잡고 있는 사용액과 미결제 잔액을 나란히
 *      놓고 차액을 보여준다. 경리가 실제로 하는 일이 "카드사 명세서와 장부가 맞나"라서다.
 *      차액이 있으면 대개 아직 안 올린 전표가 있다는 뜻이다.
 *   3. 결제 처리 — 어느 통장에서 얼마를 갚을지.
 *
 * ⚠ 건별로 골라 갚는 기능은 **일부러 만들지 않는다.** 카드사에 "이 건만 갚을게요"는
 *   존재하지 않는다. 명세서 구간이 통째로 청구되고, 부분 결제는 건이 아니라 금액 단위다.
 *   고를 수 있게 해두면 화면이 없는 약속을 하게 된다.
 *
 * ⚠ 체크카드는 여기 없다. 쓴 즉시 통장에서 빠지므로 갚을 것이 없다.
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

export const CardPaymentScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [accounts, setAccounts] = useState([])
  const [uses, setUses] = useState([])      // 카드로 쓴 지출(대조용)
  const [rows, setRows] = useState([])      // 결제 이력
  const [form, setForm] = useState(null)
  const [openCard, setOpenCard] = useState(null)   // 사용 내역을 펼친 카드
  const [busy, setBusy] = useState(false)

  const today = localToday()

  const load = async () => {
    const [accs, expense] = await Promise.all([
      api.getAccounts(), api.getTransactions({ kind: 'expense' }),
    ])
    setAccounts(accs)
    // 카드로 결제한 지출 = 대조 대상. 이체로 만들어진 줄은 사용이 아니므로 뺀다.
    setUses((expense || []).filter(t => !t.transferId))
    // 결제 이력은 보내는 쪽(지출)만 세운다 — 둘 다 세우면 한 번 결제가 두 줄로 보인다
    setRows((expense || []).filter(t => t.transferId).sort((a, b) => String(b.date).localeCompare(String(a.date))))
  }
  useEffect(() => { load() }, [])

  const byId = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts])
  const bankOpts = useMemo(() => accounts.filter(a => a.kind !== 'card'), [accounts])

  /* 갚을 카드 목록.
   *
   * ⚠ 금액은 '이번 구간 사용액'이 아니라 **카드 계좌 잔액**(음수)의 절대값이다.
   *   구간 사용액으로 세면 이미 결제한 뒤에도 같은 금액이 계속 떠 있다(결제는 income 인데
   *   구간 사용액은 지출만 세기 때문). 잔액으로 보면 결제분이 자동으로 빠지고
   *   **지난달 미납분까지** 함께 잡힌다 — 갚을 사람이 알고 싶은 건 정확히 그 숫자다.
   *
   * 결제일이 없으면 세지 않는다. 언제 빠지는지 모르면 "지금 갚으라"고 말할 수 없다.
   */
  const bills = useMemo(() => accounts
    .filter(a => a.kind === 'card' && a.cardType === 'credit' && a.cardPayDay > 0)
    .map(a => {
      const w = billingWindow(today, a.cardPayDay)
      const inWindow = uses.filter(t => t.accountId === a.id && t.date > w.from && t.date <= w.to)
      const booked = inWindow.reduce((s, t) => s + (Number(t.amount) || 0), 0)
      const unpaid = Math.max(0, -(a.currentBalance ?? 0))
      return {
        card: a, ...w, inWindow, booked, unpaid,
        payAcct: byId.get(a.cardPayAccountId) || null,
      }
    })
    .filter(b => b.unpaid > 0)
    .sort((a, b) => a.payDate.localeCompare(b.payDate)), [accounts, uses, byId, today])

  const totalUnpaid = bills.reduce((s, b) => s + b.unpaid, 0)

  const openPay = (b) => setForm({
    card: b.card, fromAccountId: b.payAcct?.id || '', amount: String(b.unpaid),
    unpaid: b.unpaid,
    // 결제일이 아직 안 왔으면 오늘로 — 미래 날짜는 서버가 막는다
    date: b.payDate > today ? today : b.payDate,
    memo: `${b.card.name} 카드대금`,
  })

  const save = async () => {
    if (!form.fromAccountId) return toast.push('어느 통장에서 갚을지 골라주세요', { tone: 'warn' })
    const amt = Number(String(form.amount).replace(/[^0-9-]/g, '')) || 0
    if (amt <= 0) return toast.push('금액을 입력해주세요', { tone: 'warn' })

    const from = byId.get(form.fromAccountId)
    const left = form.unpaid - amt
    const ok = await confirm({
      tone: 'brand', icon: <Icon.Card size={22}/>, title: '카드 대금 지급',
      body: `${from?.name} 에서 ${fmtNum(amt)}원으로 ${form.card.name} 대금을 갚습니다.`,
      detail: left > 0
        ? `갚고 나면 ${fmtNum(left)}원이 남아요. 수입도 지출도 아니라 손익에는 잡히지 않습니다.`
        : '수입도 지출도 아니에요 — 통장 잔액이 줄고 카드 미결제가 사라집니다.',
      confirmLabel: '지급',
    })
    if (!ok) return
    setBusy(true)
    const res = await api.transfer({
      fromAccountId: form.fromAccountId, toAccountId: form.card.id,
      amount: amt, date: form.date, memo: form.memo,
    })
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '지급에 실패했어요', { tone: 'warn' })
    toast.push('카드 대금을 지급했어요')
    setForm(null)
    load()
  }

  const remove = async (r) => {
    const ok = await confirm({
      tone: 'neg', icon: <Icon.Warn size={22}/>, title: '지급 취소',
      body: `${fmtNum(r.amount)}원 카드 대금 지급을 지웁니다.`,
      detail: '통장 출금과 카드 입금 두 줄이 함께 지워져요. 한쪽만 남으면 돈이 사라지거나 생겨납니다.',
      confirmLabel: '삭제',
    })
    if (!ok) return
    const res = await api.deleteTransaction(r.id)
    toast.push(res.ok ? '지급을 취소했어요' : (res.error || '취소에 실패했어요'), res.ok ? undefined : { tone: 'warn' })
    load()
  }

  return (
    <div className="fade-up">
      <PageHeader title="카드 대금 지급"
        sub={bills.length > 0
          ? `갚을 카드 ${bills.length}장 · ${fmtNum(totalUnpaid)}원`
          : '쌓인 카드값을 통장에서 갚습니다. 수입도 지출도 아니라 손익에는 잡히지 않아요.'}/>

      {bills.length === 0 ? (
        <div className="card card-pad" style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--muted)' }}>
          <Icon.Check size={16} className="text-pos"/>
          <span className="text-sm fw-600" style={{ color: 'var(--ink)' }}>갚을 카드값이 없어요.</span>
          <span className="text-xs text-muted2">
            결제일을 정해 둔 신용카드만 여기 나와요 (기준정보 › 카드).
          </span>
        </div>
      ) : (
        <div className="col gap-12">
          {bills.map(b => {
            const diff = b.unpaid - b.booked
            const open = openCard === b.card.id
            return (
              <div key={b.card.id} className="card" style={{ overflow: 'hidden' }}>
                <div className="row" style={{ padding: '16px 18px', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 180 }}>
                    <div className="fw-700" style={{ fontSize: 15 }}>{b.card.name}</div>
                    <div className="text-xs text-muted" style={{ marginTop: 2 }}>
                      결제일 <span className="num">{b.payDate}</span>
                      {b.payAcct
                        ? <> · {b.payAcct.name}에서 출금</>
                        : <span className="badge neg" style={{ marginLeft: 6, fontSize: 10 }}>결제 계좌 미설정</span>}
                    </div>
                  </div>
                  <div className="ml-auto" style={{ textAlign: 'right' }}>
                    <div className="text-xs text-muted2">미결제 잔액</div>
                    <div className="num fw-700" style={{ fontSize: 20, letterSpacing: '-0.02em' }}>{fmtNum(b.unpaid)}</div>
                  </div>
                  <button className="btn primary" disabled={!b.payAcct}
                    title={b.payAcct ? undefined : '기준정보 › 카드에서 결제 계좌를 먼저 지정해주세요'}
                    onClick={() => openPay(b)} style={{ alignSelf: 'center' }}>지급 처리</button>
                </div>

                {/* 명세서 대조 — 카드사가 청구할 금액과 우리 장부가 잡고 있는 금액을 나란히.
                    차액이 곧 "아직 안 올린 전표"다. 이걸 못 보면 결제만 하고 비용을 빠뜨린다. */}
                <div className="row" style={{ padding: '10px 18px', gap: 12, borderTop: '1px solid var(--line)',
                  background: 'var(--surface-2)', flexWrap: 'wrap' }}>
                  <span className="text-xs text-muted2">
                    사용 구간 <span className="num">{b.from}</span> ~ <span className="num">{b.to}</span>
                  </span>
                  <span className="text-xs text-muted2">·</span>
                  <span className="text-xs">
                    장부에 있는 사용액 <span className="num fw-600">{fmtNum(b.booked)}</span>
                    <span className="text-muted2"> ({b.inWindow.length}건)</span>
                  </span>
                  {Math.abs(diff) > 0 && (
                    <span className="badge warn" style={{ fontSize: 10 }}>
                      차액 {fmtNum(Math.abs(diff))} — {diff > 0 ? '아직 안 올린 전표가 있는지 확인하세요' : '장부가 더 많아요'}
                    </span>
                  )}
                  <button className="btn sm ml-auto" onClick={() => setOpenCard(open ? null : b.card.id)}>
                    {open ? '사용 내역 접기' : '사용 내역 보기'}
                  </button>
                </div>

                {open && (
                  <table className="table">
                    <thead><tr><th>날짜</th><th>거래처 · 적요</th><th>사용 직원</th><th className="num-right">금액</th></tr></thead>
                    <tbody>
                      {b.inWindow.length === 0 && (
                        <tr><td colSpan={4} style={{ textAlign: 'center', padding: 28, color: 'var(--muted-2)', fontSize: 13 }}>
                          이 구간에 장부로 올라온 사용 내역이 없어요.
                        </td></tr>
                      )}
                      {b.inWindow.map(t => (
                        <tr key={t.id}>
                          <td className="num-cell text-muted text-sm">{t.date}</td>
                          <td className="text-sm">
                            <span className="fw-600">{t.vendor || '—'}</span>
                            {t.memo && <span className="text-muted2"> · {t.memo}</span>}
                          </td>
                          {/* 법인카드는 여럿이 나눠 쓴다 — 누가 썼는지가 이 표의 값어치다 */}
                          <td className="text-sm text-muted">{t.employeeName || t.employee || '—'}</td>
                          <td className="num-cell num-right fw-600">{fmtNum(t.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 지급 이력 */}
      <div style={{ marginTop: 24 }}>
        <div className="section-title" style={{ fontSize: 13, marginBottom: 10 }}>지급 이력</div>
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="table">
            <thead><tr>
              <th>날짜</th><th>출금 통장</th><th>카드</th><th>내용</th>
              <th className="num-right">금액</th><th style={{ width: 70 }}></th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--muted-2)', fontSize: 13 }}>
                  카드 대금 지급 내역이 없어요.
                </td></tr>
              )}
              {rows.map(t => (
                <tr key={t.id}>
                  <td className="num-cell text-sm">{t.date}</td>
                  <td className="fw-700 text-sm">{byId.get(t.accountId)?.name || '—'}</td>
                  <td className="text-sm">{byId.get(t.counterpartyAccountId)?.name || '—'}</td>
                  <td className="text-sm text-muted">{t.memo || '—'}</td>
                  <td className="num-cell num-right fw-700">{fmtNum(t.amount)}</td>
                  <td><button className="btn sm" style={{ color: 'var(--neg-ink)' }} onClick={() => remove(t)}>취소</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 결제 폼 — 카드 말투로 묻는다. '보내는 계좌 → 받는 계좌'가 아니라
          '어느 통장에서 얼마를 갚나'다. 사용자 머릿속의 말과 같아야 한다. */}
      <Drawer open={!!form} onClose={() => setForm(null)} width="min(480px,100vw)" label="카드 대금 지급">
        <DrawerHead title="카드 대금 지급" sub={form?.card?.name} onClose={() => setForm(null)}/>
        {form && (
          <div className="drawer-body col gap-form">
            <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
              <div className="row">
                <span className="text-sm text-muted">미결제 잔액</span>
                <span className="num fw-700 ml-auto" style={{ fontSize: 18 }}>{fmtNum(form.unpaid)}</span>
              </div>
            </div>

            <div><label className="label">어느 통장에서 갚나요 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
              <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                {bankOpts.map(a => (
                  <button key={a.id} type="button"
                    className={`chip ${form.fromAccountId === a.id ? 'active' : ''}`}
                    onClick={() => setForm(f => ({ ...f, fromAccountId: a.id }))}>{a.name}</button>
                ))}
              </div>
            </div>

            <div className="row gap-12">
              <div style={{ flex: 1 }}><label className="label">갚는 금액 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                <MoneyInput value={form.amount} onChange={raw => setForm(f => ({ ...f, amount: raw }))}/>
                {/* 부분 결제가 실제로 흔하다. 갚고 나면 얼마 남는지 그 자리에서 보여준다. */}
                <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
                  {(() => {
                    const amt = Number(String(form.amount).replace(/[^0-9-]/g, '')) || 0
                    const left = form.unpaid - amt
                    return left > 0 ? `갚고 나면 ${fmtNum(left)}원이 남아요`
                      : left < 0 ? `미결제보다 ${fmtNum(-left)}원 많아요 — 카드에 잔액이 생깁니다`
                      : '전액 갚습니다'
                  })()}
                </div>
              </div>
              <div style={{ flex: 1 }}><label className="label">지급일 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
                <DateInput className="input" max={today} value={form.date}
                  onChange={e => setForm(f => ({ ...f, date: e.target.value }))}/>
              </div>
            </div>

            <div><label className="label">내용</label>
              <input className="input" value={form.memo}
                onChange={e => setForm(f => ({ ...f, memo: e.target.value }))}/>
            </div>

            <div className="text-xs text-muted2" style={{ lineHeight: 1.7 }}>
              · 거래내역에는 <b>두 줄</b>로 남아요 — 통장 출금, 카드 입금.<br/>
              · 손익에는 잡히지 않아요. 카드로 쓸 때 이미 비용으로 잡혔으니까요.
            </div>
          </div>
        )}
        <DrawerFooter onCancel={() => setForm(null)} onSave={save} saveLabel="지급" busy={busy}/>
      </Drawer>
    </div>
  )
}
