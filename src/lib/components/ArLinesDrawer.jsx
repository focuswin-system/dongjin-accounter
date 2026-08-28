import { Drawer, Icon, fmtNum, fmtDateShort } from '../ui'
import { DrawerHead } from './Drawer'

/* 미수금(미지급금)의 **근거** — 이 숫자가 어떤 청구서들로 이루어졌나.
 *
 * 여태는 숫자만 있었다. 그래서 값이 이상해도 검산할 수도, 어디가 틀렸는지 짚을 수도 없었다.
 * 실제로 "미수금 176,000원이 어디서 나왔는지 볼 수가 없다"는 말이 나왔고,
 * 그 176,000원은 **다른 거래처 청구서 2건이 이 주문에 붙어 있어서** 생긴 값이었다
 * (주문을 이름으로 고르던 시절의 오연결 — 같은 이름 주문이 8개였다).
 *
 * 그래서 이 화면의 핵심은 목록 자체가 아니라 **'이 주문 거래처가 아닌 청구서'를 짚어 주는 것**이다.
 * 미수금 = 이 주문에 붙은 청구서 합 − 이 주문에 붙은 입금 합 이라,
 * 남의 청구서가 하나 붙으면 그 금액이 통째로 미수로 남는다.
 */
export const ArLinesDrawer = ({ open, onClose, lines = [], isPurchase, contractVendor }) => {
  const label = isPurchase ? '미지급금' : '미수금'
  const rows = lines.filter(l => l.remain !== 0)
  const foreign = rows.filter(l => l.foreign_vendor)
  const sum = rows.reduce((s, l) => s + l.remain, 0)
  const foreignSum = foreign.reduce((s, l) => s + l.remain, 0)

  return (
    <Drawer open={open} onClose={onClose} width={680}>
      <DrawerHead
        title={`${label} 내역`}
        sub={`이 주문에 붙은 청구서 중 아직 ${isPurchase ? '안 나간' : '안 들어온'} 돈이에요.`}
        onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="row" style={{ alignItems: 'baseline' }}>
          <div className="text-sm text-muted">청구서 {rows.length}건</div>
          <div className="num fw-700 ml-auto" style={{ fontSize: 20 }}>{fmtNum(sum)}원</div>
        </div>

        {/* 남의 청구서가 섞여 있으면 그게 이 화면의 요점이다 — 목록보다 먼저 말한다 */}
        {foreign.length > 0 && (
          <div className="alert-row" style={{ background: 'var(--warn-soft)', borderColor: 'transparent' }}>
            <Icon.Warn/>
            <div className="text-sm">
              이 주문의 거래처(<b>{contractVendor || '—'}</b>)가 아닌 청구서가 <b>{foreign.length}건</b> 붙어 있어요
              — 합계 <b>{fmtNum(foreignSum)}원</b>.
              <div className="text-xs text-muted2" style={{ marginTop: 2 }}>
                주문을 이름으로 고르던 때 잘못 붙었을 수 있어요. 청구서를 열어 제 주문으로 옮기면
                이 {label}도 함께 사라집니다.
              </div>
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="card card-pad" style={{ textAlign: 'center', color: 'var(--muted-2)' }}>
            남은 {label}이 없어요.
          </div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="table">
              <thead><tr>
                <th>청구서</th>
                <th>거래처</th>
                <th className="num-right">청구액</th>
                <th className="num-right">{isPurchase ? '지급액' : '입금액'}</th>
                <th className="num-right">남은 돈</th>
              </tr></thead>
              <tbody>
                {rows.map(l => (
                  <tr key={l.id} style={l.foreign_vendor ? { background: 'var(--warn-soft)' } : undefined}>
                    <td>
                      <div className="fw-600 text-sm">{l.invoice_no}</div>
                      <div className="text-xs text-muted2 num">{fmtDateShort(l.issued_at)}
                        {l.due_at ? ` · 기한 ${fmtDateShort(l.due_at)}` : ''}</div>
                    </td>
                    <td className="text-sm">
                      {l.vendor_name || '—'}
                      {l.foreign_vendor && (
                        <div className="text-xs" style={{ color: 'var(--neg-ink)' }}>이 주문 거래처가 아니에요</div>
                      )}
                    </td>
                    <td className="num-cell num-right">{fmtNum(l.total_amount)}</td>
                    <td className="num-cell num-right text-muted2">{fmtNum(l.paid)}</td>
                    <td className="num-cell num-right fw-700">{fmtNum(l.remain)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 다 정산된 청구서는 접어 둔다 — 남은 돈을 보러 온 화면이다 */}
        {lines.length > rows.length && (
          <div className="text-xs text-muted2">
            정산이 끝난 청구서 {lines.length - rows.length}건은 뺐어요.
          </div>
        )}
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>닫기</button>
      </div>
    </Drawer>
  )
}
