import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, Drawer, localToday, DateInput } from '../ui'
import { DrawerHead } from './Drawer'
import { api } from '../api'
import { vatOf } from '../vatRate'

/* 기입금/기지급 처리 — 계약 청구 일정의 청구서 발행 + 즉시 정산을 한 번에.
 *
 * "돈이 어느 계좌로 오갔나"를 반드시 받는다. 계좌가 비면 그 돈은 어느 계좌 잔액에도
 * 잡히지 않는다(accounts.js calcBalance가 account_id로 합산) — 과거 F-02와 같은 유형의 누락.
 * 미래 날짜도 막는다(실제로 오간 돈이므로).
 *
 * 발행 자체는 부모가 넘긴 onIssuePaid가 한다. 이 드로어는 계좌·날짜만 받아 실어 보낸다.
 * (옛 정기 회차의 변동형 금액·발행함 미입금 분기는 반복거래로 바뀌며 걷었다 — 이제 청구 일정만 쓴다.)
 *
 * @param target       처리할 일정 (amount=공급가, vat, vendor_name, type)
 * @param isIssued     true=매출(기입금) / false=매입(기지급)
 * @param onIssuePaid  (target + _accountId·_date) => { ok, error?, cancelled?, reused_txn? }
 */
export const PaidIssueDrawer = ({ target, isIssued, onClose, onDone, onIssuePaid }) => {
  const toast = useToast()
  const today = localToday()
  const [accounts, setAccounts] = useState([])
  const [accountId, setAccountId] = useState("")
  const [date, setDate] = useState(today)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!target) return
    setDate(localToday())
    api.getAccounts().then(a => { setAccounts(a); const bank = a.find(x => x.kind === 'bank'); setAccountId(bank ? bank.id : "") })
  }, [target])
  if (!target) return null
  // 세액이 안 실려 오면 10% 로 본다(발행예정 표의 pendingGross 와 같은 규칙 — 보여준 숫자와 기록이 같아야 한다)
  const total = (target.amount || 0) + (target.vat != null ? target.vat : vatOf(target.amount || 0))
  const submit = async () => {
    if (date > today) return toast.push("미래 날짜로는 처리할 수 없어요")
    setBusy(true)
    const res = await onIssuePaid({ ...target, _accountId: accountId || null, _date: date })
    setBusy(false)
    // 확인창에서 그만둔 것은 실패가 아니다(같은 거래가 이미 있어 되물었을 때) — 조용히 돌아간다
    if (res.cancelled) return
    if (!res.ok) { toast.push(res.error || "처리에 실패했어요", { tone: "warn" }); return }
    /* 거래를 새로 만들었는지, 이미 장부에 있던 것에 붙였는지는 사용자에게 다른 일이다 —
       붙인 경우 계좌 잔액이 안 움직이는데 아무 말이 없으면 "반영이 안 됐나" 가 된다. */
    toast.push(res.reused_txn
      ? (isIssued ? "이미 있던 입금에 붙였어요 (거래를 새로 만들지 않았어요)" : "이미 있던 지급에 붙였어요 (거래를 새로 만들지 않았어요)")
      : (isIssued ? "입금 처리했어요" : "지급 처리했어요"))
    onDone()
  }
  return (
    <Drawer open onClose={onClose} width="min(460px, 100vw)">
      <DrawerHead
        title={isIssued ? "입금 처리" : "지급 처리"}
        sub={<>{target.vendor_name} · {target.type} · {fmtNum(total)}원</>}
        onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="alert-row" style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}>
          <Icon.Sparkle/>
          <div className="text-sm">
            청구서를 발행하고 <b>{fmtNum(total)}원</b>을 {isIssued ? "입금" : "지급"} 완료로 함께 기록해요.
            {' '}{isIssued ? "입금받은" : "출금한"} 계좌를 선택하세요.
          </div>
        </div>
        <div>
          <label className="label">{isIssued ? "입금 계좌" : "출금 계좌"}</label>
          <div className="row gap-6" style={{ flexWrap: "wrap" }}>
            {accounts.filter(a => a.kind === 'bank').map(a => (
              <button key={a.id} type="button" className={`chip ${accountId === a.id ? "active" : ""}`} onClick={() => setAccountId(a.id)}>{a.name}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">{isIssued ? "입금일" : "지급일"}</label>
          <DateInput className="input num" value={date} max={today} onChange={e => setDate(e.target.value)}/>
        </div>
      </div>
      <div className="drawer-foot">
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            <Icon.Check size={14}/> {busy ? "처리 중..." : (isIssued ? "입금 처리" : "지급 처리")}
          </button>
        </div>
      </div>
    </Drawer>
  )
}
