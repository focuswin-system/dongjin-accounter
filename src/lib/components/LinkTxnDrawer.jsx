import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, Drawer, Loading, StatusBadge } from '../ui'
import { DrawerHead, DrawerFooter } from './Drawer'
import { api } from '../api'

/* 계약에 거래를 붙인다 — "이미 처리된 입금·지출을 계약에서 골라 연결".
 *
 * 청구서 '매칭'과 이름을 나눈 이유: 저쪽은 이 돈이 청구서를 **얼마나 갚았나**(금액 배분,
 * 부분 입금 가능)이고, 여기는 이 거래가 **어느 계약 건인가**(귀속, 부분 없음)이다.
 * 같은 말을 쓰면 부분 연결을 기대하게 된다.
 *
 * axis
 *   'contract' — 이 계약이 근거인 거래 (매출계약의 입금 / 매입계약의 지급)
 *   'cost'     — 이 지출이 원가로 붙는 매출 계약 (외주비 등)
 * 어느 탭에서 열렸느냐로 정해진다. 틀리면 돈이 엉뚱한 바구니에 조용히 들어간다.
 */
export const LinkTxnDrawer = ({ open, onClose, contractId, contractName, kind, axis = 'contract', onLinked }) => {
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [checked, setChecked] = useState([])
  const [q, setQ] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setChecked([]); setQ(''); setRows(null)
  }, [open, contractId, kind, axis])

  // 검색은 서버에서 — 후보가 100건으로 잘리므로 화면에서 거르면 뒤쪽이 영영 안 보인다
  useEffect(() => {
    if (!open) return
    let alive = true
    const t = setTimeout(() => {
      api.getLinkableTxns({ contractId, kind, axis, q }).then(list => { if (alive) setRows(list || []) })
    }, q ? 300 : 0)
    return () => { alive = false; clearTimeout(t) }
  }, [open, contractId, kind, axis, q])

  const toggle = (id) => setChecked(c => c.includes(id) ? c.filter(x => x !== id) : [...c, id])
  const sum = (rows || []).filter(r => checked.includes(r.id)).reduce((s, r) => s + Number(r.amount || 0), 0)

  const save = async () => {
    if (!checked.length) return
    setSaving(true)
    const res = await api.linkTxnsToContract({ txnIds: checked, contractId, axis })
    setSaving(false)
    if (!res.ok) return toast.push(res.error || '연결에 실패했어요', { tone: 'warn' })
    toast.push(`${res.count}건을 ${contractName || '계약'}에 연결했어요`)
    onLinked?.(); onClose()
  }

  const label = axis === 'cost' ? '원가로 귀속' : '계약에 연결'

  return (
    <Drawer open={open} onClose={onClose} width="min(720px, 100vw)" label="거래 연결">
      <DrawerHead
        title={`${kind === 'income' ? '입금' : '지출'} 거래 연결`}
        sub={<>{contractName}
          {axis === 'cost' && <> · 이 계약의 <b>원가</b>로 잡습니다</>}</>}
        onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="search" style={{ margin: 0 }}>
          <Icon.Search size={14}/>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="거래처·적요·비목 검색"/>
        </div>

        {rows === null ? <Loading label="거래를 불러오는 중…"/> : rows.length === 0 ? (
          <div className="text-sm text-muted" style={{ padding: '24px 0', textAlign: 'center' }}>
            {q ? '검색 결과가 없어요.' : '연결할 만한 거래가 없어요. 거래내역에 먼저 등록해주세요.'}
          </div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 38 }}></th>
                  <th style={{ width: 104 }}>날짜</th>
                  <th>거래처 · 적요</th>
                  <th className="num-right" style={{ width: 120 }}>금액</th>
                  <th style={{ width: 130 }}>지금 연결</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className={checked.includes(r.id) ? 'dt-selected' : undefined}
                    style={{ cursor: 'pointer' }} onClick={() => toggle(r.id)}>
                    <td onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={checked.includes(r.id)} onChange={() => toggle(r.id)}/>
                    </td>
                    <td className="num-cell text-muted text-sm">{r.date}</td>
                    <td>
                      <div className="fw-600">{r.vendor_name || '(거래처 미지정)'}</div>
                      <div className="text-xs text-muted2">
                        {[r.category, r.memo].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </td>
                    <td className="num-cell num-right fw-700">{fmtNum(r.amount)}</td>
                    <td>
                      {/* 다른 계약에 붙어 있는 거래도 목록에 둔다 — 잘못 붙은 것을 옮기는 게
                          이 화면의 주 용도라 안 보이면 옮길 수가 없다. 다만 옮긴다는 걸 알려야 한다. */}
                      {r.linked_contract_name
                        ? <span className="badge warn text-xs">{r.linked_contract_name}에서 옮김</span>
                        : <span className="text-xs text-muted2">없음</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {checked.length > 0 && (
          <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
            <div className="row text-sm">
              <span className="fw-700">{checked.length}건 선택</span>
              <span className="num fw-700 ml-auto">{fmtNum(sum)}원</span>
            </div>
            <div className="text-xs text-muted2" style={{ marginTop: 6 }}>
              금액은 바뀌지 않아요. 이 거래들이 <b>{contractName}</b>의 {axis === 'cost' ? '원가' : '실적'}으로 잡힙니다.
            </div>
          </div>
        )}
      </div>
      <DrawerFooter onCancel={onClose} onSave={save} saveLabel={saving ? '연결 중…' : `${checked.length || ''}건 ${label}`.trim()}
        saveDisabled={!checked.length || saving}/>
    </Drawer>
  )
}
