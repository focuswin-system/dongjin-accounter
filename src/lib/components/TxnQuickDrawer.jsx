import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Drawer, Loading, StatusBadge } from '../ui'
import { DrawerHead } from './Drawer'
import { api } from '../api'

/* 주문 화면에서 연 거래 상세.
 *
 * 고객 지적: "주문이랑 연결된 입금/지출 내역을 보고 그 자리에서 뭔가 잘못된 경우
 *            처리를 해야 하는데, 처리가 힘들어."
 * 예전엔 주문의 입출금 표가 읽기 전용이라, 잘못된 걸 봐도 전체 거래내역으로 나가
 * 금액으로 더듬어 찾아야 했다.
 *
 * 여기서 하는 일은 둘이다 — **무엇인지 보여주기**와 **이 주문에서 떼기**.
 * 금액·날짜 같은 본격 수정은 거래내역의 편집 폼이 한다(같은 폼을 두 벌 두면 반드시 어긋난다).
 */
export const TxnQuickDrawer = ({ txnId, onClose, contractId, onChanged, goRoute,
  /* 그 자리에서 고치기. 거래내역과 **같은 폼**(TransactionForm)을 연다 —
     폼을 두 벌 두면 반드시 어긋나므로, 화면을 옮기지 않고 폼만 가져온다. */
  openEdit }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [txn, setTxn] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!txnId) { setTxn(null); return }
    let alive = true
    api.getTransactions().then(list => {
      if (alive) setTxn((list || []).find(t => t.id === txnId) || null)
    })
    return () => { alive = false }
  }, [txnId])

  if (!txnId) return null

  /* 어느 축으로 붙어 있는지 보고 그 축을 뗀다.
     근거 주문과 원가 귀속은 다른 컬럼이라, 보이는 대로 떼지 않으면 엉뚱한 쪽이 풀린다. */
  const axis = txn && txn.contractId === contractId ? 'contract'
    : txn && txn.cost_contract_id === contractId ? 'cost' : null

  const unlink = async () => {
    if (!axis) return
    const ok = await confirm({
      title: '이 주문에서 뗄까요?',
      body: <>거래는 그대로 남고 <b>이 주문과의 연결만</b> 끊어져요.
        금액·날짜·계좌는 바뀌지 않습니다.</>,
      confirmLabel: '연결 떼기',
    })
    if (!ok) return
    setBusy(true)
    const res = await api.linkTxnsToContract({ txnIds: [txnId], contractId: null, axis })
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '떼지 못했어요', { tone: 'warn' })
    toast.push('이 주문에서 뗐어요')
    onChanged?.()
  }

  const Row = ({ label, children }) => (
    <div className="row" style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      <span className="text-sm text-muted" style={{ width: 96, flexShrink: 0 }}>{label}</span>
      <span className="text-sm ml-auto" style={{ textAlign: 'right' }}>{children}</span>
    </div>
  )

  return (
    <Drawer open={true} onClose={onClose} width="min(460px, 100vw)" label="거래 상세" confirmClose={false}>
      <DrawerHead title="거래 상세" sub={txn ? `${txn.date} · ${txn.kind === 'income' ? '입금' : '지출'}` : ''} onClose={onClose}/>
      <div className="drawer-body">
        {!txn ? <Loading label="거래를 불러오는 중…"/> : (
          <>
            <div className="card card-pad" style={{ background: 'var(--surface-2)', marginBottom: 14 }}>
              <div className="row">
                <span className="fw-700">{txn.vendor}</span>
                <span className="num fw-700 ml-auto" style={{ fontSize: 18, color: txn.sign > 0 ? 'var(--pos)' : 'var(--ink)' }}>
                  {txn.sign > 0 ? '+' : '−'}{fmtNum(txn.amount)}
                </span>
              </div>
              <div className="text-xs text-muted2" style={{ marginTop: 4 }}>{txn.scope}</div>
            </div>

            <Row label="비목">{txn.category}</Row>
            <Row label="계좌">{txn.account || '—'}</Row>
            {/* 상대 계좌 — 기록이 있을 때만 보여준다. 없는 거래가 대부분이라
                '—' 로 늘 자리를 차지하면 있는 쪽이 묻힌다. */}
            {(txn.counterpartyAccount || txn.counterpartyBank) && (
              <Row label={txn.kind === 'expense' ? '보낸 곳' : '받은 곳'}>
                <span className="num">{[txn.counterpartyBank, txn.counterpartyAccount].filter(Boolean).join(' ')}</span>
                {txn.counterpartyHolder && (
                  <span className="text-xs text-muted2" style={{ marginLeft: 6 }}>{txn.counterpartyHolder}</span>
                )}
              </Row>
            )}
            <Row label="상태"><StatusBadge status={txn.status}/></Row>
            <Row label="근거 주문">{txn.contract || <span className="text-muted2">없음</span>}</Row>
            {txn.kind === 'expense' && (
              <Row label="원가 귀속">{txn.cost_contract_name || <span className="text-muted2">없음</span>}</Row>
            )}

            <div className="col gap-8" style={{ marginTop: 18 }}>
              {/* 수정이 첫 자리다. 여기까지 온 이유가 대개 "뭔가 잘못됐다"라서,
                  고칠 수단이 없으면 거래내역으로 나갔다 돌아오는 왕복이 생긴다. */}
              {openEdit && (
                <button className="btn primary" onClick={() => { openEdit(txn); onClose() }}>
                  <Icon.Pencil size={14}/> 이 거래 수정
                </button>
              )}
              {axis && (
                <button className="btn" style={{ color: 'var(--neg-ink)' }} onClick={unlink} disabled={busy}>
                  <Icon.Close size={14}/> 이 주문에서 떼기
                  <span className="text-xs text-muted2" style={{ marginLeft: 6 }}>
                    ({axis === 'cost' ? '원가 귀속' : '근거 주문'})
                  </span>
                </button>
              )}
              {/* 금액·날짜 수정은 거래내역의 편집 폼이 맡는다 — 같은 폼을 두 벌 두면 어긋난다.
                  ⚠ 예전엔 해시만 바꿔 거래내역 첫 화면으로 보냈다. 방금 보고 있던 건을
                     거기서 **다시 찾아야 했다**(수백 줄에서 금액으로 더듬는다).
                     goRoute 를 받은 자리에서는 그 거래를 짚어서 연다. */}
              {/* 여기서 고칠 수 있으면 굳이 화면을 옮길 이유가 없다. 수정 수단이 없는
                  자리(주문 화면 등)에서만 거래내역으로 보낸다. */}
              {!openEdit && (
                <button className="btn"
                  onClick={() => { goRoute ? goRoute('ledger', { txnId }) : (window.location.hash = 'ledger'); onClose() }}>
                  <Icon.Right size={14}/> 거래내역에서 열기
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Drawer>
  )
}
