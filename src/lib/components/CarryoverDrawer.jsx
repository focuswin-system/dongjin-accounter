import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, Drawer, Combobox, MoneyInput } from '../ui'
import { DrawerHead, DrawerFooter } from './Drawer'
import { api } from '../api'

/**
 * 이월 잔액 — 이 프로그램을 쓰기 전부터 있던 미수금·미지급금(4단계, 2026-09).
 *
 * 세금계산서를 다 찾아 올리지 않아도 **거래처별 금액만** 적으면 받을 돈·줄 돈이 맞는다(사용자 확정 2026-09-18).
 * 서버가 청구서로 세운다 — 발행일은 장부 시작일 전날, 상대 계정은 미처분이익잉여금(손익 아님),
 * 기간 매출·부가세 명세에서는 빠진다(server/lib/carryover.js). 들어오면 세금계산서 화면에서 입금 처리한다.
 *
 * 지우거나 고치는 것은 세금계산서 화면에서 한다(청구서다) — 여기는 넣는 자리와 지금 무엇이 있는지 보는 자리.
 */
const emptyRow = () => ({ vendor_id: '', kind: 'issued', amount: '', memo: '' })

export const CarryoverDrawer = ({ open, onClose, booksStart }) => {
  const toast = useToast()
  const [vendors, setVendors] = useState([])
  const [list, setList] = useState(null)
  const [rows, setRows] = useState([emptyRow()])
  const [busy, setBusy] = useState(false)

  const load = () => api.getCarryovers().then(r => setList(r || []))
  useEffect(() => {
    if (!open) return
    setRows([emptyRow()])
    api.getVendors({ all: true }).then(v => setVendors(v || []))
    load()
  }, [open])

  const set = (i, k, v) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  const num = (v) => Number(String(v || '').replace(/[^0-9]/g, '')) || 0
  const filled = rows.filter(r => r.vendor_id && num(r.amount) > 0)
  const sumOf = (kind) => filled.filter(r => r.kind === kind).reduce((s, r) => s + num(r.amount), 0)

  const save = async () => {
    if (!filled.length) return toast.push('거래처와 금액을 적어주세요', { tone: 'warn' })
    setBusy(true)
    const res = await api.saveCarryovers(filled.map(r => ({ ...r, amount: num(r.amount) })))
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '저장하지 못했어요', { tone: 'warn' })
    toast.push(`이월 잔액 ${res.created}건을 넣었어요`)
    setRows([emptyRow()]); load()
  }

  const dot = (d) => String(d || '').slice(0, 10).replace(/-/g, '.')

  return (
    <Drawer open={open} onClose={onClose} width="min(720px, 100vw)" label="이월 잔액">
      <DrawerHead title="이월 잔액" sub={booksStart ? `장부 시작일 ${dot(booksStart)} 전부터 있던 받을 돈·줄 돈` : ''} onClose={onClose}/>
      <div className="drawer-body col gap-16">
        <div className="text-sm text-muted">
          거래처별로 금액만 적으면 돼요. 받을 돈은 세금계산서 › 발행, 줄 돈은 수취에 뜨고, 들어오거나 나가면 거기서 처리해요.
          매출·부가세에는 잡히지 않아요.
        </div>

        <div className="col gap-10">
          {rows.map((r, i) => (
            <div key={i} className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="row gap-4">
                {[['issued', '받을 돈'], ['received', '줄 돈']].map(([k, l]) => (
                  <button key={k} type="button" className={`chip ${r.kind === k ? 'active' : ''}`} onClick={() => set(i, 'kind', k)}>{l}</button>
                ))}
              </div>
              <div style={{ flex: '1 1 180px', minWidth: 160 }}>
                <Combobox value={r.vendor_id} allowAdd={false} onChange={v => set(i, 'vendor_id', v)}
                  options={vendors.map(v => ({ value: v.id, label: v.name, sub: v.active === 0 ? '미사용' : (v.type || '') }))}
                  placeholder="거래처"/>
              </div>
              <div style={{ width: 150 }}>
                <MoneyInput value={r.amount} onChange={raw => set(i, 'amount', raw)}/>
              </div>
              <input className="input" style={{ flex: '1 1 140px', minWidth: 120 }} value={r.memo}
                placeholder="메모(선택)" onChange={e => set(i, 'memo', e.target.value)}/>
              <button type="button" className="icon-btn sm" title="줄 삭제" disabled={rows.length <= 1}
                onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}><Icon.Close size={13}/></button>
            </div>
          ))}
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }}
            onClick={() => setRows(rs => [...rs, emptyRow()])}><Icon.Plus size={12}/> 줄 추가</button>
        </div>

        {list && list.length > 0 && (
          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-pad" style={{ paddingBottom: 8 }}>
              <span className="fw-700 text-sm">넣어 둔 이월 잔액</span>
              <span className="text-xs text-muted2" style={{ marginLeft: 8 }}>고치거나 지우려면 세금계산서 화면에서</span>
            </div>
            <table className="table">
              <thead><tr><th>거래처</th><th style={{ width: 80 }}>구분</th><th className="num-right" style={{ width: 130 }}>금액</th><th className="num-right" style={{ width: 130 }}>남은 돈</th></tr></thead>
              <tbody>
                {list.map(inv => (
                  <tr key={inv.id}>
                    <td className="text-sm">{inv.vendor_name || '—'}{inv.memo && inv.memo !== '전기이월' ? <span className="text-xs text-muted2"> · {inv.memo.replace(/^전기이월 · /, '')}</span> : null}</td>
                    <td className="text-sm">{inv.kind === 'issued' ? '받을 돈' : '줄 돈'}</td>
                    <td className="num-cell num-right">{fmtNum(inv.total_amount)}</td>
                    <td className="num-cell num-right">{fmtNum(inv.remainAmount ?? inv.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <DrawerFooter>
        <span className="text-xs text-muted2">받을 돈 {fmtNum(sumOf('issued'))} · 줄 돈 {fmtNum(sumOf('received'))}</span>
        <button className="btn ml-auto" onClick={onClose}>닫기</button>
        <button className="btn primary" onClick={save} disabled={busy || !filled.length}><Icon.Check size={14}/> 넣기</button>
      </DrawerFooter>
    </Drawer>
  )
}
