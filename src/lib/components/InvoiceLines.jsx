import { useMemo } from 'react'
import { Icon, fmtNum, Combobox, MoneyInput } from '../ui'
import { computeLineAmount, num, BASIS_LABEL } from '../lineAmount'

/* 거래명세서식 품목 입력 — 청구서 폼에서 쓴다.
 *
 * ── 왜 필요한가 ──
 * 여태 청구서는 공급가액 한 칸이었다. 그런데 실무는 거래명세서(품목·규격·수량·단위·중량·단가)를
 * 만들고 그걸 월별로 청구한다. 그래서 명세서는 엑셀로 따로 만들고 이 앱엔 총액만 옮겨 적었다 —
 * 이중 입력이고, 나중에 "그 달에 뭘 팔았는지"가 앱에 없다.
 * invoice_lines 테이블·거래명세서 출력·지급결의서 연동은 이미 있었는데 **입력 경로만 없었다.**
 *
 * ── 설계 ──
 * · 금액은 자동 계산이 기본이지만 **사람이 덮어쓸 수 있다**(할인·끝수 조정이 흔하다).
 *   손댄 줄은 수량·단가를 바꿔도 다시 덮지 않는다 — 고친 값이 소리 없이 사라지면 신뢰를 잃는다.
 * · 단가 기준(수량/중량)은 줄마다 다르다. 같은 청구서에 개당 파는 품목과 ㎏당 파는 자재가 섞인다.
 * · 기준정보 품목을 고르면 규격·단위·단가·중량을 채워 준다. 없으면 직접 입력해도 된다.
 */
export const InvoiceLines = ({ lines = [], onChange, itemMaster = [], readOnly = false }) => {
  const itemOptions = useMemo(() => itemMaster.map(it => ({
    value: it.id,
    label: it.name,
    sub: [it.spec, it.unit, it.amount ? `${fmtNum(it.amount)}원` : null].filter(Boolean).join(' · '),
  })), [itemMaster])

  const set = (i, patch) => {
    const next = lines.map((l, idx) => {
      if (idx !== i) return l
      const merged = { ...l, ...patch }
      /* 금액 자동 계산 — 사용자가 금액을 직접 건드린 줄(amountTouched)은 건너뛴다.
         '금액' 칸을 고친 것 자체가 patch 로 오면 그때 표식을 세운다. */
      if (!('amount' in patch) && !merged.amountTouched) merged.amount = computeLineAmount(merged)
      return merged
    })
    onChange(next)
  }

  const add = () => onChange([...lines, blankLine()])
  const remove = (i) => onChange(lines.filter((_, idx) => idx !== i))
  /* 복사 — 같은 품목의 규격·단가만 다른 줄이 줄줄이 나오는 게 명세서의 보통 모습이다.
     처음부터 다시 고르게 하면 그 자체가 이 기능을 안 쓰는 이유가 된다. */
  const dup = (i) => {
    const copy = { ...lines[i], id: undefined }
    onChange([...lines.slice(0, i + 1), copy, ...lines.slice(i + 1)])
  }

  const pickItem = (i, itemId) => {
    const it = itemMaster.find(x => x.id === itemId)
    if (!it) return set(i, { item_id: '' })
    // 기준정보 값은 **출발점**이다. 고른 뒤 이 청구서에서 고쳐도 기준정보는 안 바뀐다(스냅샷).
    set(i, {
      item_id: it.id,
      name: it.name || '',
      spec: it.spec || '',
      unit: it.unit || '',
      unit_price: Number(it.amount) || 0,
      weight: Number(it.weight) || 0,
      price_basis: it.price_basis === 'weight' ? 'weight' : 'qty',
    })
  }

  const supplyTotal = lines.reduce((s, l) => s + num(l.amount), 0)

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <label className="label" style={{ margin: 0 }}>품목 내역 <span className="text-muted2">(선택)</span></label>
        {!readOnly && (
          <button type="button" className="btn sm ml-auto" onClick={add}>
            <Icon.Plus size={12}/> 품목 추가
          </button>
        )}
      </div>

      {lines.length === 0 ? (
        <div className="text-xs text-muted2" style={{ padding: '10px 0' }}>
          품목을 넣으면 거래명세서로 출력할 수 있고, 공급가액이 자동으로 합산돼요.
          넣지 않으면 아래 공급가액만으로 청구서가 만들어집니다.
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto', marginBottom: 8 }}>
          <table className="table" style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 150 }}>품목</th>
                <th style={{ minWidth: 100 }}>규격</th>
                <th style={{ width: 74 }}>단위</th>
                <th className="num-right" style={{ width: 84 }}>수량</th>
                <th className="num-right" style={{ width: 90 }}>중량</th>
                <th style={{ width: 92 }}>단가 기준</th>
                <th className="num-right" style={{ width: 110 }}>단가</th>
                <th className="num-right" style={{ width: 120 }}>금액</th>
                {!readOnly && <th style={{ width: 62 }}></th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <Combobox value={l.item_id || ''} onChange={v => pickItem(i, v)} options={itemOptions}
                      placeholder="품목 선택" disabled={readOnly}
                      onAddNew={q => set(i, { item_id: '', name: q })} addNewLabel="직접 입력"/>
                    {/* 기준정보에 없는 품목은 이름만 남긴다 — 고르지 않아도 명세서는 나와야 한다 */}
                    {!l.item_id && (
                      <input className="input" style={{ marginTop: 4 }} value={l.name || ''} disabled={readOnly}
                        placeholder="품목명" onChange={e => set(i, { name: e.target.value })}/>
                    )}
                  </td>
                  <td><input className="input" value={l.spec || ''} disabled={readOnly}
                    onChange={e => set(i, { spec: e.target.value })}/></td>
                  <td><input className="input" value={l.unit || ''} disabled={readOnly}
                    placeholder="EA" onChange={e => set(i, { unit: e.target.value })}/></td>
                  <td><input className="input num" inputMode="decimal" value={l.qty ?? ''} disabled={readOnly}
                    onChange={e => set(i, { qty: e.target.value })}/></td>
                  <td><input className="input num" inputMode="decimal" value={l.weight ?? ''} disabled={readOnly}
                    onChange={e => set(i, { weight: e.target.value })}/></td>
                  <td>
                    {/* 짧은 enum 이라 칩. 무엇에 단가를 곱하는지가 금액의 근거다 */}
                    <div className="row gap-4">
                      {['qty', 'weight'].map(b => (
                        <button key={b} type="button" disabled={readOnly}
                          className={`chip ${(l.price_basis || 'qty') === b ? 'active' : ''}`}
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          onClick={() => set(i, { price_basis: b })}>{BASIS_LABEL[b]}</button>
                      ))}
                    </div>
                  </td>
                  <td><MoneyInput value={String(l.unit_price ?? '')} disabled={readOnly}
                    onChange={(raw, v) => set(i, { unit_price: v })}/></td>
                  <td>
                    <MoneyInput value={String(l.amount ?? '')} disabled={readOnly}
                      onChange={(raw, v) => set(i, { amount: v, amountTouched: true })}/>
                    {l.amountTouched && !readOnly && (
                      <button type="button" className="text-xs text-muted2"
                        style={{ border: 0, background: 'none', cursor: 'pointer', padding: '2px 0' }}
                        title="수량·단가로 다시 계산"
                        onClick={() => set(i, { amountTouched: false, amount: computeLineAmount(l) })}>
                        자동 계산으로
                      </button>
                    )}
                  </td>
                  {!readOnly && (
                    <td>
                      <div className="row gap-4">
                        <button type="button" className="btn ghost sm" title="이 줄 복사"
                          style={{ padding: '2px 6px' }} onClick={() => dup(i)}><Icon.Plus size={11}/></button>
                        <button type="button" className="btn ghost sm" title="이 줄 삭제"
                          style={{ padding: '2px 6px', color: 'var(--neg-ink)' }} onClick={() => remove(i)}>
                          <Icon.Close size={11}/></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lines.length > 0 && (
        <div className="row text-sm" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <span className="text-muted">품목 {lines.length}줄 합계</span>
          <b className="num">{fmtNum(supplyTotal)}원</b>
        </div>
      )}
    </div>
  )
}

export const blankLine = () => ({
  item_id: '', name: '', spec: '', unit: '', qty: '', weight: '',
  price_basis: 'qty', unit_price: '', amount: '',
})
