import { useState } from 'react'
import { api } from '../api'
import { Icon, useToast, fmtNum, fmtDateShort } from '../ui'

/**
 * **이미 발행한 것 같은 회차** — 회차에 안 걸린 청구서가 그 주문에 있을 때.
 *
 * ── 왜 이 구획이 있나 ──
 * 회차는 '끊기로 한 것', 청구서는 '끊은 것'이다. 회차를 통해 발행하면 둘이 저절로
 * 이어지지만 임포트(홈택스)·수시 발행·나중에 '주문 붙이기'로 들어온 청구서는 안 이어진다.
 * 그러면 이미 끊은 돈이 '아직 안 끊음'으로 발행예정에 남고, 그대로 누르면 **같은 건을
 * 두 번 청구**한다.
 *
 * ⚠ 자동으로 잇지 않는다. 같은 달의 별개 건을 회차로 착각하면 진짜 청구가 사라져
 *   **못 받는 돈**이 된다. 후보만 내밀고 고르는 건 사람이 한다.
 * ⚠ 감추지도 않는다(소급 회차 구획과 같은 대접이다) — 그중 진짜 끊어야 할 것이 있다.
 */

/* 금액이 맞으면 가장 강한 단서다. 회차 금액은 공급가라 부가세를 더해 총액으로 견준다 —
   공급가끼리 견주면 면세·영세에서 어긋난다. */
const sameAmount = (msTotal, invTotal) => Math.abs(msTotal - invTotal) < 1

export const MaybeIssuedPanel = ({ rows, isIssued, onChanged, onOpenOrder }) => {
  const [pick, setPick] = useState({})     // 회차 id → 고른 청구서 id
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)   // 방금 이은 것 (되돌리기용)
  const toast = useToast()

  /* ⚠ rows 가 비어도 **방금 이은 것이 있으면 남는다.** 예전엔 그냥 사라져서,
       마지막 한 건을 이으면 되돌리기 버튼까지 같이 없어졌다 — 되돌릴 길이 없다. */
  if (!rows.length && !done) return null

  const totalOf = (r) => (Number(r.amount) || 0) + (Number(r.vat) || 0)

  /* 미리 골라 두는 건 **후보가 하나뿐이고 금액까지 같을 때만**이다.
     둘 이상이거나 금액이 다르면 어느 것인지는 우리가 알 수 없다. */
  const defaultPick = (r) => {
    const cs = r.loose_invoices || []
    if (cs.length === 1 && sameAmount(totalOf(r), cs[0].total_amount)) return cs[0].id
    return ''
  }
  const chosen = (r) => (pick[r.milestone_id] !== undefined ? pick[r.milestone_id] : defaultPick(r))

  const linkOne = async (r) => {
    const invId = chosen(r)
    if (!invId) { toast.push('이을 청구서를 고르세요', { tone: 'warn' }); return }
    setBusy(true)
    const res = await api.linkScheduleInvoice(r.milestone_id, invId)
    setBusy(false)
    if (!res.ok) { toast.push(res.error || '잇지 못했어요', { tone: 'warn' }); return }
    setDone({ milestoneId: r.milestone_id, name: r.contract_name })
    toast.push('이었어요 — 발행예정에서 빠집니다')
    onChanged?.()
  }

  const undo = async () => {
    if (!done) return
    setBusy(true)
    const res = await api.linkScheduleInvoice(done.milestoneId, null)
    setBusy(false)
    toast.push(res.ok ? '되돌렸어요' : (res.error || '되돌리지 못했어요'), res.ok ? undefined : { tone: 'warn' })
    setDone(null)
    onChanged?.()
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div className="row gap-8" style={{ alignItems: 'baseline', marginBottom: 8 }}>
        <span className="fw-700 text-sm">이미 {isIssued ? '발행' : '등록'}한 것 같아요</span>
        {rows.length > 0 && <span className="badge outline" style={{ fontSize: 10 }}>{rows.length}건</span>}
        <span className="text-xs text-muted2">
          {rows.length > 0
            ? '이 주문에 회차와 안 이어진 청구서가 있어요. 맞으면 이어 주세요.'
            : '다 이었어요.'}
        </span>
        {done && (
          <button className="btn sm ml-auto" onClick={undo} disabled={busy}>방금 이은 것 되돌리기</button>
        )}
      </div>

      {rows.map(r => {
        const cands = r.loose_invoices || []
        const msTotal = totalOf(r)
        const sel = chosen(r)
        return (
          <div key={r.milestone_id} className="card"
               style={{ padding: '12px 16px', marginBottom: 8, borderColor: sel ? 'var(--brand)' : undefined }}>
            <div className="row gap-16" style={{ alignItems: 'flex-start' }}>
              {/* 왼쪽 — 어느 회차인가 */}
              <div style={{ minWidth: 0, flex: 1 }}>
                {/* ⚠ flexWrap 을 쓰지 않는다. 좁은 화면에서 금액이 다음 줄로 내려가면
                    같은 목록에서 줄이 제각각으로 보인다 — 이름이 줄어드는 게 맞다. */}
                <div className="row gap-6" style={{ alignItems: 'baseline' }}>
                  <span className="badge outline" style={{ fontSize: 10, flexShrink: 0 }}>{r.type}</span>
                  <button className="btn ghost sm fw-700 text-sm ellipsis"
                          style={{ minWidth: 0, padding: 0, textAlign: 'left' }}
                          onClick={() => onOpenOrder?.(r)}>
                    {r.contract_name}
                  </button>
                  <span className="text-xs num" style={{ marginLeft: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {fmtNum(msTotal)}
                  </span>
                </div>
                <div className="text-xs text-muted2 ellipsis" style={{ marginTop: 2 }}>
                  {r.vendor_name || '거래처 없음'} · {fmtDateShort(r.due_date) || '기일 없음'}
                </div>
              </div>

              <Icon.Right size={14} style={{ color: 'var(--muted-2)', flexShrink: 0, margin: '4px 12px 0' }}/>

              {/* 오른쪽 — 이을 청구서 고르기 */}
              <div style={{ minWidth: 0, flex: 1 }}>
                {cands.map(c => (
                  <label key={c.id} className="row gap-8"
                         style={{ alignItems: 'center', marginBottom: 4, cursor: 'pointer' }}>
                    <input type="radio" name={`ms-${r.milestone_id}`} checked={sel === c.id}
                           onChange={() => setPick(p => ({ ...p, [r.milestone_id]: c.id }))}/>
                    <span className="text-xs ellipsis" style={{ minWidth: 0 }}>
                      {c.invoice_no || '(번호 없음)'} · {fmtDateShort(c.issued_at)}
                    </span>
                    <span className="text-xs num" style={{ marginLeft: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {fmtNum(c.total_amount)}
                    </span>
                    {sameAmount(msTotal, c.total_amount) && (
                      <span className="badge pos" style={{ fontSize: 10, flexShrink: 0 }}>금액 같음</span>
                    )}
                  </label>
                ))}
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                  <button className="btn sm primary" disabled={busy || !sel} onClick={() => linkOne(r)}>
                    이 청구서로 잇기
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
