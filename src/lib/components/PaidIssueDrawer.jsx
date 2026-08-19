import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, Drawer, localToday, DateInput } from '../ui'
import { DrawerHead } from './Drawer'
import { api } from '../api'

/* 기입금/기지급 처리 — 청구서 발행 + 즉시 정산을 한 번에.
 *
 * "돈이 어느 계좌로 오갔나"를 반드시 받는다. 계좌가 비면 그 돈은 어느 계좌 잔액에도
 * 잡히지 않는다(accounts.js calcBalance가 account_id로 합산) — 과거 F-02와 같은 유형의 누락.
 * 미래 날짜도 막는다(실제로 오간 돈이므로).
 *
 * 발행 자체는 부모가 넘긴 onIssuePaid가 한다 — 출처(주문 청구일정·정기청구·정기지출)마다
 * API가 다르므로 분기는 한 곳(부모)에만 둔다. 이 드로어는 계좌·날짜만 받아 실어 보낸다.
 * 대금청구서 화면과 정기청구·정기지출 화면이 같은 드로어를 쓴다(같은 동작은 같은 모양으로).
 *
 * @param target       처리할 회차/일정 (amount=공급가, vat, vendor_name, type)
 * @param isIssued     true=매출(기입금) / false=매입(기지급)
 * @param onIssuePaid  (target + _accountId·_date) => { ok, error? }
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
  const supply = target.amount || 0
  const vat = target.vat != null ? target.vat : Math.round(supply * 0.1)
  const total = supply + vat
  const submit = async () => {
    if (date > today) return toast.push("미래 날짜로는 처리할 수 없어요")
    setBusy(true)
    const res = await onIssuePaid({ ...target, _accountId: accountId || null, _date: date })
    setBusy(false)
    if (!res.ok) { toast.push(res.error || "처리에 실패했어요", { tone: "warn" }); return }
    toast.push(isIssued ? "기입금 처리했어요" : "기지급 처리했어요")
    onDone()
  }
  return (
    <Drawer open onClose={onClose} width="min(460px, 100vw)">
      <DrawerHead
        title={isIssued ? "기입금 처리" : "기지급 처리"}
        sub={<>{target.vendor_name} · {target.type} · {fmtNum(total)}원</>}
        onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="alert-row" style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}>
          <Icon.Sparkle/>
          <div className="text-sm">청구서를 발행하고 <b>{fmtNum(total)}원</b>을 {isIssued ? "입금" : "지급"} 완료로 함께 기록해요. {isIssued ? "입금받은" : "출금한"} 계좌를 선택하세요.</div>
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
            <Icon.Check size={14}/> {busy ? "처리 중..." : (isIssued ? "기입금 처리" : "기지급 처리")}
          </button>
        </div>
      </div>
    </Drawer>
  )
}
