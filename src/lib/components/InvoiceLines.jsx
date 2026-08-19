import { useMemo } from 'react'
import { Icon, fmtNum, Combobox, MoneyInput, DateInput } from '../ui'
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
/** 줄 하나의 세액 — 직접 적었으면 그 값, 안 적었으면 과세유형대로 자동.
 *  품목표·분할 발행 미리보기·서버(routes/invoices.js lineVatOf)가 모두 이 규칙을 쓴다.
 *  한 군데라도 다르면 화면에서 본 세액과 저장된 세액이 갈린다. */
export const lineVat = (l, taxType = '과세') => (
  (l.vat === null || l.vat === undefined || l.vat === '')
    ? (taxType === '과세' ? Math.round(num(l.amount) * 0.1) : 0)
    : num(l.vat)
)

/** 실제로 쓰이는 줄인가 — 표는 빈 줄 하나로 시작하므로, '품목을 쓰고 있는지'를
 *  이 규칙 하나로 판정한다. 청구서 폼(공급가액 잠금)·분할 미리보기·저장이 모두 이걸 쓴다.
 *  한 군데라도 다르면 "표에는 보이는데 저장 안 된 줄"이 생긴다. */
export const isFilledLine = (l) => (
  !!String(l?.name || '').trim() || !!String(l?.item_id || '') ||
  num(l?.amount) > 0 || num(l?.qty) > 0 || num(l?.unit_price) > 0
)

/* 글자 수에 맞춰 칸을 넓힌다.
 *
 * 열두 칸이 나란히 서는 표라 글자 칸은 늘 좁았다. 규격("SUS304 t2.0 1219×2438")이
 * 여덟 자만 보이면 뭘 청구하는지 검산이 안 된다. 그렇다고 처음부터 다 넓혀 두면
 * 짧은 품목명만 쓰는 사람은 빈 여백을 가로로 스크롤하게 된다.
 * 그래서 **적은 만큼** 늘린다 — 상한을 둬서 한 칸이 표를 삼키지는 않게. */
const growWidth = (lines, get, min, max) => {
  /* 글자 수가 아니라 **폭**으로 센다 — 한글은 영문의 두 배 가까이 넓다.
     길이로만 재면 '알루미늄 브라켓 가공품' 같은 한글 품목명이 늘 잘린 채로 남는다. */
  const widthOf = (s) => [...String(s ?? '')].reduce(
    (w, ch) => w + (/[ᄀ-ᇿ　-〿㄰-㆏가-힯＀-｠]/.test(ch) ? 2 : 1), 0)
  const longest = lines.reduce((m, l) => Math.max(m, widthOf(get(l))), 0)
  return Math.round(Math.max(min, Math.min(max, longest * 7.4 + 34)))
}

export const InvoiceLines = ({ lines = [], onChange, itemMaster = [], taxType = '과세', kind = 'issued' }) => {
  /* 같은 날짜라도 부르는 이름이 다르다 — 우리가 내보내면 납품일, 우리가 받으면 입고일.
     칸(delivery_date)은 하나고 이름표만 바뀐다. 매입 청구서에 '납품일'이라고 쓰여 있으면
     "우리가 납품한 날인가?" 하고 한 번 멈추게 된다. */
  const dateLabel = kind === 'received' ? '입고일' : '납품일'
  /* 줄별 세액의 기본값 — 비워두면 청구서 과세유형을 따라 자동으로 채워 보여준다.
     실제 명세서·매입현황표가 줄마다 세액을 적고, 같은 청구서에 과세와 면세가 섞이는 일이
     실제로 있다(자재 + 근조화환). 그래서 줄마다 고칠 수 있어야 하되,
     대부분은 손댈 일이 없으므로 자동값이 보이는 편이 낫다. */
  const shownVat = (l) => lineVat(l, taxType)
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

  /* 품목 칸에 넣을 값 — 거래처 칸과 같은 방식이다.
   *
   * Combobox 는 옵션에 없는 값을 **원문 그대로** 보여준다(ui.jsx `display`).
   * 그래서 기준정보에서 고른 줄은 id 를, 직접 적은 줄은 이름 자체를 넣으면
   * 두 경우가 한 칸에서 다 보인다. 예전엔 늘 item_id 를 넣었는데, 직접 입력하면
   * item_id 가 비어 표시할 값이 없어져서 **아래에 입력칸을 하나 더** 달아야 했다.
   * 기준정보에 없는 품목이 흔한 건 맞지만, 그건 칸을 나눌 이유가 아니라
   * 이 칸이 이름을 받아야 할 이유였다.
   *
   * 기준정보에서 지워진 품목을 물고 있는 옛 줄은 id 가 매칭되지 않는다 —
   * 그대로 두면 칸에 UUID 가 노출되므로, 그때도 이름으로 떨어뜨린다. */
  const shownItem = (l) => (
    itemMaster.some(it => it.id === l.item_id) ? l.item_id : (l.name || '')
  )

  const pickItem = (i, itemId) => {
    const it = itemMaster.find(x => x.id === itemId)
    // 목록에서 고른 게 아니면(있을 수 없지만) 이름은 지키고 연결만 끊는다
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

  const filled = lines.filter(isFilledLine)
  const supplyTotal = filled.reduce((s, l) => s + num(l.amount), 0)
  const vatTotal = filled.reduce((s, l) => s + shownVat(l), 0)

  // 글자 칸만 내용에 따라 자란다. 숫자·날짜 칸은 들어갈 값의 길이가 정해져 있어 고정.
  const nameW = growWidth(lines, l => l.name, 170, 340)
  const specW = growWidth(lines, l => l.spec, 120, 280)
  // 최소폭은 placeholder('예: 14,500원/KG')가 안 잘리는 길이다 — 예시가 잘리면 예시가 아니다
  const noteW = growWidth(lines, l => l.note, 145, 260)
  const tableW = 130 + nameW + specW + 70 + 84 + 88 + 92 + 112 + 124 + 108 + noteW + 58

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <label className="label" style={{ margin: 0 }}>품목 내역 <span className="text-muted2">(선택)</span></label>
        <button type="button" className="btn sm ml-auto" onClick={add}>
          <Icon.Plus size={12}/> 품목 추가
        </button>
      </div>

      {lines.length === 0 ? (
        <div className="text-xs text-muted2" style={{ padding: '10px 0' }}>
          품목을 넣으면 거래명세서로 출력할 수 있고, 공급가액이 자동으로 합산돼요.
          넣지 않으면 아래 공급가액만으로 청구서가 만들어집니다.
          품목마다 <b>{dateLabel}</b>을 적어두면, {dateLabel}별로 청구서를 나눠서 발행할 수 있어요.
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto', marginBottom: 8 }}>
          <table className="table line-table" style={{ minWidth: tableW }}>
            <thead>
              <tr>
                {/* 납품일(매입이면 입고일) — 한 장에 여러 날 납품분이 섞이는 게 실무의 보통 모습이다.
                    비워도 된다(단일 납품·용역). 채우면 거래명세서에 찍히고,
                    '날짜별로 나눠 발행'의 기준이 된다. */}
                <th style={{ width: 130 }}>{dateLabel}</th>
                <th style={{ width: nameW }}>품목</th>
                <th style={{ width: specW }}>규격</th>
                <th style={{ width: 70 }}>단위</th>
                <th className="num-right" style={{ width: 84 }}>수량</th>
                <th className="num-right" style={{ width: 88 }}>중량</th>
                <th style={{ width: 92 }}>단가 기준</th>
                <th className="num-right" style={{ width: 112 }}>단가</th>
                <th className="num-right" style={{ width: 124 }}>금액</th>
                <th className="num-right" style={{ width: 108 }}>부가세</th>
                <th style={{ width: noteW }}>비고</th>
                <th style={{ width: 58 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <DateInput className="input num" value={l.delivery_date || ''}
                      onChange={e => set(i, { delivery_date: e.target.value })}/>
                  </td>
                  <td>
                    {/* 기준정보에 없는 품목은 이름만 남는다 — 고르지 않아도 명세서는 나와야 한다.
                        목록에 없는 이름을 치면 아래 '직접 입력'으로 그대로 넣을 수 있다(거래처 칸과 동일). */}
                    {/* portal — 이 표는 가로 스크롤 상자라, 목록을 상자 안에 그리면
                        아랫부분('직접 입력')이 잘려 목록에 없는 품목을 넣을 길이 막힌다. */}
                    <Combobox value={shownItem(l)} onChange={v => pickItem(i, v)} options={itemOptions}
                      placeholder="품목 선택 · 직접 입력" portal
                      onAddNew={q => set(i, { item_id: '', name: q })} addNewLabel="직접 입력"/>
                  </td>
                  <td><input className="input" value={l.spec || ''}
                    onChange={e => set(i, { spec: e.target.value })}/></td>
                  {/* placeholder 를 두지 않는다 — 칸이 좁아 '단위'가 '단우'로 잘리고,
                      머리글이 이미 '단위'라 같은 말을 두 번 하는 셈이다 */}
                  <td><input className="input" value={l.unit || ''}
                    onChange={e => set(i, { unit: e.target.value })}/></td>
                  <td><input className="input num" inputMode="decimal" value={l.qty ?? ''}
                    onChange={e => set(i, { qty: e.target.value })}/></td>
                  <td><input className="input num" inputMode="decimal" value={l.weight ?? ''}
                    onChange={e => set(i, { weight: e.target.value })}/></td>
                  <td>
                    {/* 짧은 enum 이라 칩. 무엇에 단가를 곱하는지가 금액의 근거다 */}
                    <div className="row gap-4">
                      {['qty', 'weight'].map(b => (
                        <button key={b} type="button"
                          className={`chip ${(l.price_basis || 'qty') === b ? 'active' : ''}`}
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          onClick={() => set(i, { price_basis: b })}>{BASIS_LABEL[b]}</button>
                      ))}
                    </div>
                  </td>
                  <td><MoneyInput value={String(l.unit_price ?? '')}
                    onChange={(raw, v) => set(i, { unit_price: v })}/></td>
                  <td>
                    <MoneyInput value={String(l.amount ?? '')}
                      onChange={(raw, v) => set(i, { amount: v, amountTouched: true })}/>
                    {l.amountTouched && (
                      <button type="button" className="text-xs text-muted2"
                        style={{ border: 0, background: 'none', cursor: 'pointer', padding: '2px 0' }}
                        title="수량·단가로 다시 계산"
                        onClick={() => set(i, { amountTouched: false, amount: computeLineAmount(l) })}>
                        자동 계산으로
                      </button>
                    )}
                  </td>
                  <td>
                    {/* 비워두면 과세유형대로 자동. 면세 줄만 0 으로 고치면 된다 —
                        직접 넣은 값은 그 줄의 세액으로 굳는다(자동값과 구별해 표시). */}
                    <MoneyInput value={String(shownVat(l))}
                      onChange={(raw, v) => set(i, { vat: v })}/>
                    {(l.vat === null || l.vat === undefined || l.vat === '') ? (
                      <div className="text-xs text-muted2" style={{ padding: '2px 0' }}>자동</div>
                    ) : (
                      <button type="button" className="text-xs text-muted2"
                        style={{ border: 0, background: 'none', cursor: 'pointer', padding: '2px 0' }}
                        title="과세유형대로 다시 계산" onClick={() => set(i, { vat: null })}>
                        자동으로
                      </button>
                    )}
                  </td>
                  <td><input className="input" value={l.note || ''} placeholder="예: 14,500원/KG"
                    onChange={e => set(i, { note: e.target.value })}/></td>
                  <td>
                    <div className="row gap-4">
                      {/* 복사에 Plus 를 쓰면 위쪽 '품목 추가'와 같은 아이콘이라 '새 줄'로 읽힌다 */}
                      <button type="button" className="btn ghost sm" title="이 줄 복사"
                        style={{ padding: '2px 6px' }} onClick={() => dup(i)}><Icon.Copy size={11}/></button>
                      <button type="button" className="btn ghost sm" title="이 줄 삭제"
                        style={{ padding: '2px 6px', color: 'var(--neg-ink)' }} onClick={() => remove(i)}>
                        <Icon.Close size={11}/></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 합계줄은 **채운 줄이 있을 때만**. 표가 빈 줄 하나로 시작하므로 줄 수로 재면
          폼을 열자마자 "품목 1줄 · 공급가 0" 이 떠서, 아무것도 안 적었는데 적은 것처럼 읽힌다. */}
      {filled.length > 0 && (
        <div className="row text-sm" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <span className="text-muted">품목 {filled.length}줄</span>
          <span className="text-muted">공급가</span><b className="num">{fmtNum(supplyTotal)}</b>
          <span className="text-muted">세액</span><b className="num">{fmtNum(vatTotal)}</b>
          <span className="text-muted">계</span><b className="num">{fmtNum(supplyTotal + vatTotal)}원</b>
        </div>
      )}
    </div>
  )
}

/* 새 줄. 단위는 'EA' 로 **채워서** 시작한다 — 예전엔 placeholder 로만 'EA' 를 띄웠는데,
   회색 글씨가 값처럼 읽혀 그대로 저장하면 단위가 빈 명세서가 나왔다. 다르면 고치면 된다. */
export const blankLine = () => ({
  item_id: '', name: '', spec: '', unit: 'EA', qty: '', weight: '',
  price_basis: 'qty', unit_price: '', amount: '', vat: null, note: '', delivery_date: '',
})

/** 납품일별로 묶는다 — 서버 /invoices/split 과 **같은 규칙**이라야 미리보기와 결과가 같다.
 *  날짜를 안 적은 줄은 '' 한 묶음(날짜 없는 것끼리 한 장). Map 은 넣은 순서를 지킨다. */
export const groupLinesByDelivery = (lines = []) => {
  const g = new Map()
  for (const l of lines) {
    if (!isFilledLine(l)) continue   // 손대지 않은 빈 줄(표는 빈 줄 하나로 시작한다)
    const k = /^\d{4}-\d{2}-\d{2}$/.test(String(l.delivery_date || '')) ? l.delivery_date : ''
    if (!g.has(k)) g.set(k, [])
    g.get(k).push(l)
  }
  return [...g.entries()].map(([delivery_date, ls]) => ({ delivery_date, lines: ls }))
}
