import { useState, useEffect } from 'react'
import { Icon, fmtNum, Drawer } from '../ui'
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
export const VoucherView = ({ open, onClose, source, id }) => {
  const [v, setV] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !id) return
    let alive = true
    setLoading(true); setV(null)
    const p = source === 'invoice' ? api.getInvoiceVoucher(id) : api.getTransactionVoucher(id)
    p.then(d => { if (alive) { setV(d); setLoading(false) } })
    return () => { alive = false }
  }, [open, id, source])

  /* 차변·대변을 같은 줄에 세우려면 계정 하나가 한 행이어야 한다.
     한 계정이 양쪽에 오는 일은 없으므로(그건 곧 자기 자신과의 거래다) 줄을 그대로 편다. */
  const rows = v?.lines || []

  return (
    <Drawer open={open} onClose={onClose} width="min(720px, 100vw)" label="전표" confirmClose={false}>
      <DrawerHead
        title="전표"
        sub={v ? `${v.type} · ${v.date || ''}` : ''}
        onClose={onClose}
        right={v && (
          <button className="btn no-print" onClick={() => window.print()}>
            <Icon.Print size={14}/> 인쇄
          </button>
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
            <div style={{ textAlign: 'center', marginBottom: 18 }}>
              <div className="fw-700" style={{ fontSize: 20, letterSpacing: '0.3em', paddingLeft: '0.3em' }}>
                {v.type}
              </div>
              <div className="text-sm text-muted" style={{ marginTop: 6 }}>{v.date}</div>
            </div>

            <div className="row" style={{ gap: 24, flexWrap: 'wrap', marginBottom: 14, fontSize: 13 }}>
              {v.counterparty && <div><span className="text-muted2">거래처</span> <b>{v.counterparty}</b></div>}
              {v.account_name && <div><span className="text-muted2">계좌</span> <b>{v.account_name}</b></div>}
              {v.category && <div><span className="text-muted2">비목</span> <b>{v.category}</b></div>}
            </div>
            {v.summary && (
              <div style={{ fontSize: 13, marginBottom: 14 }}>
                <span className="text-muted2">적요</span> {v.summary}
              </div>
            )}

            {/* 짝이 안 맞으면 감추지 않는다 — 조용히 맞추면 틀린 장부가 맞는 것처럼 보인다 */}
            {!v.balanced && (
              <div className="card card-pad" style={{ marginBottom: 12, borderColor: 'var(--neg)', background: 'rgba(220,38,38,0.04)' }}>
                <div className="fw-700 text-sm" style={{ color: 'var(--neg-ink)', marginBottom: 4 }}>
                  이 전표는 아직 완성되지 않았어요
                </div>
                <div className="text-sm text-muted">
                  {v.missing || '차변과 대변이 맞지 않아요.'} 고치면 장부에 제대로 올라갑니다.
                </div>
              </div>
            )}

            {/* 전표는 T자다 — 차변 | 계정과목 | 대변 이 가운데로 모여야 읽힌다
                (일계표 화면과 같은 구성). */}
            <div className="card" style={{ overflow: 'hidden' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 180, textAlign: 'right' }}>차변</th>
                    <th style={{ textAlign: 'center' }}>계정과목</th>
                    <th style={{ width: 180, textAlign: 'right' }}>대변</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l, i) => (
                    <tr key={i}>
                      <td className="num-cell num-right fw-700">{l.side === 'debit' ? fmtNum(l.amount) : ''}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span className="num text-xs text-muted2" style={{ marginRight: 8 }}>{l.code}</span>
                        <span className="text-sm fw-600">{l.name}</span>
                        {l.acct_type && <span className="badge outline" style={{ fontSize: 10, marginLeft: 8 }}>{l.acct_type}</span>}
                      </td>
                      <td className="num-cell num-right fw-700">{l.side === 'credit' ? fmtNum(l.amount) : ''}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={3} style={{ textAlign: 'center', padding: 28, color: 'var(--muted-2)' }}>
                      계정과목이 없어 전표를 세울 수 없어요.
                    </td></tr>
                  )}
                </tbody>
                {rows.length > 0 && (
                  <tfoot>
                    <tr>
                      <td className="num-cell num-right fw-700">{fmtNum(v.debitTotal)}</td>
                      <td className="text-sm" style={{ textAlign: 'center' }}>합계</td>
                      <td className="num-cell num-right fw-700">{fmtNum(v.creditTotal)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <div className="text-xs text-muted2 no-print" style={{ marginTop: 12, lineHeight: 1.7 }}>
              {v.source === 'invoice'
                ? '· 청구서를 발행한 시점의 전표예요. 대금이 실제로 오갈 때는 별도의 전표가 따로 생깁니다.'
                : '· 돈이 실제로 오간 시점의 전표예요. 청구서를 거친 건이면 발행 시점 전표가 따로 있습니다.'}
              <br/>
              · 통장 거래는 <b>대체전표</b>예요. 입금·출금전표는 현금(시재)이 오갈 때만 씁니다.
            </div>
          </div>
        )}
      </div>
    </Drawer>
  )
}
