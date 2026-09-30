import { useState, useEffect } from 'react'
import { Icon, Drawer } from '../ui'
import { VoucherSlip } from './VoucherSlip'
import { DrawerHead } from './Drawer'
import { api } from '../api'

/**
 * 전표 보기 — 이 건이 장부에 어떻게 오르는지 차변·대변으로 보여주고 인쇄한다.
 *
 * ── 왜 만들었나 ──
 * 고객사 경리 담당자가 "입금·출금·대체 전표를 통한 업무처리가 없다"고 했다. 실제로는 앱이
 * 이미 복식으로 전개하고 있었지만(server/lib/voucher.js) 화면에 그 모습이 없었다.
 * 없던 것은 계산이 아니라 **표현**이다.
 *
 * ── 두 종류 ──
 *   거래   결제 시점. 계좌 한쪽 + 상대 계정 한쪽, 2줄.
 *   청구서 발행 시점. 채권·채무가 생기는 사건이라 자금이 안 움직인다. 부가세가 나뉘어 3줄.
 * 둘은 **서로 다른 전표**다 — 발행 때 생긴 것이 결제 때 사라진다.
 *
 * 전표 종류(입금·출금·대체)는 서버가 정한다. 3전표제에서 입금·출금전표는 현금(시재) 전용이라
 * 통장 거래는 전부 대체전표다 — 그 판정을 화면에서 다시 하면 두 벌이 되어 어긋난다.
 */
/* extra — 머리 오른쪽에 더 세울 버튼(예: 거래내역에서 연 대체전표의 '삭제').
   전표 보기는 읽기 전용이 기본이고, 지우기를 허락하는 쪽(부른 화면)이 버튼을 넣는다. */
export const VoucherView = ({ open, onClose, source, id, voucher, extra = null }) => {
  const [v, setV] = useState(voucher || null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    /* 이미 완성된 전표를 받았으면(전표 목록의 행 등) 그대로 그린다 — 다시 조회하지 않는다.
       어음(note)처럼 단건 전표 조회 API가 없는 종류도 이 경로로 함께 보인다. */
    if (voucher) { setV(voucher); setLoading(false); return }
    if (!id) return
    let alive = true
    setLoading(true); setV(null)
    const p = source === 'invoice' ? api.getInvoiceVoucher(id) : api.getTransactionVoucher(id)
    p.then(d => { if (alive) { setV(d); setLoading(false) } })
    return () => { alive = false }
  }, [open, id, source, voucher])

  return (
    <Drawer open={open} onClose={onClose} width="min(720px, 100vw)" label="전표" confirmClose={false}>
      <DrawerHead
        title="전표"
        sub={v ? `${v.type} · ${v.date || ''}` : ''}
        onClose={onClose}
        right={v && (
          <div className="row gap-6 no-print">
            {extra}
            <button className="btn" onClick={() => window.print()}>
              <Icon.Print size={14}/> 인쇄
            </button>
          </div>
        )}/>

      <div className="drawer-body">
        {loading && <div className="text-sm text-muted" style={{ padding: 40, textAlign: 'center' }}>불러오는 중…</div>}
        {!loading && !v && (
          <div className="text-sm text-muted" style={{ padding: 40, textAlign: 'center' }}>
            전표를 불러오지 못했어요.
          </div>
        )}

        {v && (
          /* .voucher-print 는 인쇄 화이트리스트(index.css @media print)에 있어야
             Ctrl+P 가 백지로 나오지 않는다. 드로어 안에서 인쇄되므로 전용 드로어 규칙도 함께 있다. */
          <div className="voucher-print" style={{ background: 'var(--surface)', padding: '8px 4px' }}>
            <VoucherSlip v={v} notes/>
          </div>
        )}
      </div>
    </Drawer>
  )
}
