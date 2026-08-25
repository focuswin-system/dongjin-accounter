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
 * · 단가 단위(수량/중량)는 줄마다 다르다. 같은 청구서에 개당 파는 품목과 ㎏당 파는 자재가 섞인다.
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

/* 어떤 칸을 낼지 — 쓰는 화면마다 다르다.
 *
 * 청구서(invoice_lines)와 주문 품목표(contract_items)는 겹치는 게 많지만 같지 않다.
 * 주문 품목표는 **단가표**다("이 주문으로 무엇을 얼마에 주고받나"). 수량·금액·세액은
 * 청구할 때 정해지고, 대신 **매입가(원가)** 가 있다 — 계약별 손익의 근거다.
 * 반대로 청구서에는 매입가가 없다. 스키마 자체가 그렇게 갈려 있다.
 *
 * ⚠ 없는 칸을 켜면 **저장되지 않는 칸이 화면에 뜬다.** 사람은 적었는데 서버가 버린다 —
 * 정산내역서에서 한 번 겪은 사고다. 그래서 칸은 기본이 꺼짐이고, 쓰는 쪽이 켠다. */
export const INVOICE_COLUMNS = {
  deliveryDate: true, qty: true, weight: true, basis: true,
  amount: true, vat: true, note: true, costPrice: false,
}
export const CONTRACT_COLUMNS = {
  deliveryDate: false, qty: true, weight: true, basis: true,
  amount: false, vat: false, note: false, costPrice: true,
}
/* 기성형 주문 — 수량도 중량도 주문 때 정하지 않는다(청구할 때 회차마다 넣는다).
   칸을 남겨 두면 "여기 적은 수량은 뭐지?" 가 되고, 적어도 아무 데도 안 쓰인다.
   ⚠ weight 를 함께 끄지 않으면 CONTRACT_COLUMNS 의 `weight: true` 를 물려받아
     중량 칸이 되살아난다(교체 전 편집기는 이 칸을 기성형에서 감췄었다).
     단가기준(basis)은 남긴다 — "㎏당 단가"라는 사실 자체는 주문 조건이고,
     그 중량은 발행 화면에서 회차마다 받는다. */
export const CONTRACT_PROGRESS_COLUMNS = { ...CONTRACT_COLUMNS, qty: false, weight: false }

export const InvoiceLines = ({
  lines = [], onChange, itemMaster = [], taxType = '과세', kind = 'issued',
  columns = INVOICE_COLUMNS,
  label = '품목 내역', labelHint = '(선택)', emptyHint, addLabel = '품목 추가',
  onAddNewItem,
  /* '쓰이는 줄'의 판정 — 합계줄이 이걸로 센다.
     ⚠ **쓰는 화면의 저장 규칙과 같아야 한다.** 다르면 합계는 500,000원이라 하는데
     저장은 "품목을 등록해주세요"로 거절하는 상태가 된다(주문 품목표에서 실제로 겪었다).
     주문은 이름이 필수라(contract_items.name NOT NULL) 이름 없는 줄을 세면 안 된다. */
  isUsableLine = isFilledLine,
}) => {
  const col = { ...INVOICE_COLUMNS, ...columns }
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

  /* 줄 하나의 '기준' — 단가와 금액 중 **무엇이 무엇을 정하는가.**
   *
   * 단가 기준(기본)  단가 × 수량(중량) = 금액.   수량을 고치면 금액이 따라온다.
   * 금액 기준        금액 ÷ 수량(중량) = 단가.   총액이 먼저 정해진 건에 쓴다
   *                  ("이 줄은 통틀어 50만원" — 거래처가 그렇게 주는 일이 흔하다).
   *
   * 예전엔 금액을 직접 고치면 그 줄이 **얼어붙기만** 했다(amountTouched). 수량을 바꿔도
   * 금액도 단가도 안 움직여서, 사용자가 단가를 손으로 나눠 넣어야 했다.
   * 이제 금액 기준이면 수량이 바뀔 때 **단가를 다시 뽑는다** — 어느 쪽이 근거인지만 고르면
   * 나머지는 따라온다.
   *
   * ⚠ 수량이 0이면 나눌 수 없다. 그때는 단가를 건드리지 않는다(0으로 지워 버리면
   *   사용자가 적어 둔 단가가 소리 없이 사라진다).
   */
  const set = (i, patch) => {
    const next = lines.map((l, idx) => {
      if (idx !== i) return l
      const merged = { ...l, ...patch }
      const byAmount = merged.amountTouched
      if (byAmount) {
        // 금액 기준 — 금액이나 수량이 바뀌면 단가를 역산한다
        if ('amount' in patch || 'qty' in patch || 'weight' in patch || 'price_basis' in patch) {
          const div = merged.price_basis === 'weight' ? Number(merged.weight) : Number(merged.qty)
          const amt = Number(merged.amount)
          if (div > 0 && amt >= 0) merged.unit_price = Math.round(amt / div)
        }
      } else if (!('amount' in patch)) {
        // 단가 기준 — 지금까지와 같다
        merged.amount = computeLineAmount(merged)
      }
      return merged
    })
    onChange(next)
  }

  /* 기준 바꾸기 — 바꾸는 순간 **그 기준으로 한 번 맞춰 준다.**
     안 맞춰 주면 "기준만 바뀌고 숫자는 그대로"라 무엇이 달라졌는지 안 보인다. */
  const setBasis = (i, byAmount) => {
    const l = lines[i]
    const div = l.price_basis === 'weight' ? Number(l.weight) : Number(l.qty)
    const patch = { amountTouched: byAmount }
    if (byAmount) {
      if (div > 0 && Number(l.amount) >= 0) patch.unit_price = Math.round(Number(l.amount) / div)
    } else {
      patch.amount = computeLineAmount(l)
    }
    onChange(lines.map((x, idx) => (idx === i ? { ...x, ...patch } : x)))
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
    // 기준정보 값은 **출발점**이다. 고른 뒤 이 문서에서 고쳐도 기준정보는 안 바뀐다(스냅샷).
    set(i, {
      item_id: it.id,
      name: it.name || '',
      spec: it.spec || '',
      unit: it.unit || '',
      unit_price: Number(it.amount) || 0,
      weight: Number(it.weight) || 0,
      price_basis: it.price_basis === 'weight' ? 'weight' : 'qty',
      // 매입가는 그 칸을 쓰는 화면에서만 채운다 — 안 쓰는 화면에 넣으면 저장 때 버려질 값이다
      ...(col.costPrice ? { cost_price: Number(it.purchase_price) || 0 } : {}),
    })
  }

  /* 목록에 없는 이름을 친 경우.
     청구서는 이름만 남기면 되지만(명세서에 찍히면 그만), 주문 품목표는 기준정보에 등록해
     다음 주문에서도 고를 수 있어야 한다 — 그 동작은 화면이 onAddNewItem 으로 넘긴다. */
  const addNew = async (i, q) => {
    const name = String(q || '').trim()
    if (!name) return
    if (!onAddNewItem) return set(i, { item_id: '', name })
    const id = await onAddNewItem(name)
    set(i, { item_id: id || '', name })
  }

  const filled = lines.filter(isUsableLine)
  const supplyTotal = filled.reduce((s, l) => s + num(l.amount), 0)
  const vatTotal = filled.reduce((s, l) => s + shownVat(l), 0)
  /* 금액 칸이 없는 화면용 합계 — 저장된 amount 가 아니라 단가×(수량|중량)으로 그때그때 낸다.
   *
   * ⚠ **수량이 비면 1로 본다.** computeLineAmount 는 빈 수량을 0으로 보는데, 이 합계를 쓰는
   * 주문 화면은 `qty || 1` 로 주문 금액을 정한다(Contract.jsx itemsTotal). 규칙이 갈리면
   * 표 아래에는 "합계 0원 · 마진 −원가"(빨강)가 뜨는데 저장은 단가 합계로 되는,
   * **보이는 숫자와 저장되는 숫자가 다른** 상태가 된다. 기성형 주문은 수량 칸 자체가 없어
   * 늘 그랬다. 여기서는 쓰는 화면의 규칙을 따른다. */
  const basisQty = (l) => (l.price_basis === 'weight' ? num(l.weight) : (num(l.qty) || 1))
  const calcTotal = filled.reduce((s, l) => s + Math.round(basisQty(l) * num(l.unit_price)), 0)
  const costTotal = filled.reduce((s, l) => s + Math.round(basisQty(l) * num(l.cost_price)), 0)

  // 글자 칸만 내용에 따라 자란다. 숫자·날짜 칸은 들어갈 값의 길이가 정해져 있어 고정.
  const nameW = growWidth(lines, l => l.name, 170, 340)
  const specW = growWidth(lines, l => l.spec, 120, 280)
  // 최소폭은 placeholder('예: 14,500원/KG')가 안 잘리는 길이다 — 예시가 잘리면 예시가 아니다
  const noteW = growWidth(lines, l => l.note, 145, 260)
  // 켜진 칸만 더해 표 최소폭을 낸다 — 끈 칸 몫까지 더하면 쓸데없이 가로 스크롤이 생긴다
  const tableW = 34 + nameW + specW + 70 + 112
    + (col.deliveryDate ? 130 : 0) + (col.qty ? 84 : 0) + (col.weight ? 88 : 0)
    + (col.basis ? 92 : 0) + (col.amount ? 124 : 0) + (col.vat ? 108 : 0)
    + (col.note ? noteW : 0) + (col.costPrice ? 124 : 0) + 58

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
        <label className="label" style={{ margin: 0 }}>
          {label} {labelHint && <span className="text-muted2">{labelHint}</span>}
        </label>
        <button type="button" className="btn sm ml-auto" onClick={add}>
          <Icon.Plus size={12}/> {addLabel}
        </button>
      </div>

      {lines.length === 0 ? (
        <div className="text-xs text-muted2" style={{ padding: '10px 0' }}>
          {emptyHint ?? (<>
            품목을 넣으면 거래명세서로 출력할 수 있고, 공급가액이 자동으로 합산돼요.
            넣지 않으면 아래 공급가액만으로 청구서가 만들어집니다.
            품목마다 <b>{dateLabel}</b>을 적어두면, {dateLabel}별로 청구서를 나눠서 발행할 수 있어요.
          </>)}
        </div>
      ) : (
        <div className="card" style={{ overflowX: 'auto', marginBottom: 8 }}>
          <table className="table line-table" style={{ minWidth: tableW }}>
            <thead>
              <tr>
                {/* 납품일(매입이면 입고일) — 한 장에 여러 날 납품분이 섞이는 게 실무의 보통 모습이다.
                    비워도 된다(단일 납품·용역). 채우면 거래명세서에 찍히고,
                    '날짜별로 나눠 발행'의 기준이 된다. */}
                {col.deliveryDate && <th style={{ width: 130 }}>{dateLabel}</th>}
                <th style={{ width: nameW }}>품목</th>
                <th style={{ width: specW }}>규격</th>
                <th style={{ width: 70 }}>단위</th>
                {col.qty && <th className="num-right" style={{ width: 84 }}>수량</th>}
                {col.weight && <th className="num-right" style={{ width: 88 }}>중량</th>}
                {/* '단가 기준'이 아니라 '단가 단위'다 — 이 칩이 정하는 것은 **단가를 무엇에
                    곱하나**(개당인가 ㎏당인가)이지, 무엇이 근거인가가 아니다.
                    금액 칸의 '단가 기준/금액 기준'과 이름이 겹쳐 둘 다 못 읽혔다. */}
                {col.basis && <th style={{ width: 92 }}>단가 단위</th>}
                <th className="num-right" style={{ width: 112 }}>{col.costPrice ? '출고가' : '단가'}</th>
                {col.costPrice && <th className="num-right" style={{ width: 124 }}>매입가(원가)</th>}
                {col.amount && <th className="num-right" style={{ width: 124 }}>금액</th>}
                {col.vat && <th className="num-right" style={{ width: 108 }}>부가세</th>}
                {col.note && <th style={{ width: noteW }}>비고</th>}
                <th style={{ width: 58 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  {col.deliveryDate && (
                    <td>
                      <DateInput className="input num" value={l.delivery_date || ''}
                        onChange={e => set(i, { delivery_date: e.target.value })}/>
                    </td>
                  )}
                  <td>
                    {/* 기준정보에 없는 품목은 이름만 남는다 — 고르지 않아도 명세서는 나와야 한다.
                        목록에 없는 이름을 치면 아래 '직접 입력'으로 그대로 넣을 수 있다(거래처 칸과 동일). */}
                    {/* portal — 이 표는 가로 스크롤 상자라, 목록을 상자 안에 그리면
                        아랫부분('직접 입력')이 잘려 목록에 없는 품목을 넣을 길이 막힌다. */}
                    <Combobox value={shownItem(l)} onChange={v => pickItem(i, v)} options={itemOptions}
                      placeholder="품목 선택 · 직접 입력" portal
                      onAddNew={q => addNew(i, q)}
                      addNewLabel={onAddNewItem ? '새 품목 등록' : '직접 입력'}/>
                  </td>
                  <td><input className="input" value={l.spec || ''}
                    onChange={e => set(i, { spec: e.target.value })}/></td>
                  {/* placeholder 를 두지 않는다 — 칸이 좁아 '단위'가 '단우'로 잘리고,
                      머리글이 이미 '단위'라 같은 말을 두 번 하는 셈이다 */}
                  <td><input className="input" value={l.unit || ''}
                    onChange={e => set(i, { unit: e.target.value })}/></td>
                  {col.qty && (
                    <td><input className="input num" inputMode="decimal" value={l.qty ?? ''}
                      onChange={e => set(i, { qty: e.target.value })}/></td>
                  )}
                  {col.weight && (
                    <td><input className="input num" inputMode="decimal" value={l.weight ?? ''}
                      onChange={e => set(i, { weight: e.target.value })}/></td>
                  )}
                  {col.basis && (
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
                  )}
                  <td><MoneyInput value={String(l.unit_price ?? '')}
                    onChange={(raw, v) => set(i, { unit_price: v })}/></td>
                  {/* 매입가 — 주문 품목표에만 있다. 계약별 손익(수익 − 원가)의 근거라
                      출고가 바로 옆에 두어 마진이 눈으로 비교되게 한다. */}
                  {col.costPrice && (
                    <td><MoneyInput value={String(l.cost_price ?? '')}
                      onChange={(raw, v) => set(i, { cost_price: v })}/></td>
                  )}
                  {col.amount && (
                  <td>
                    <MoneyInput value={String(l.amount ?? '')}
                      onChange={(raw, v) => set(i, { amount: v, amountTouched: true })}/>
                    {/* 이 줄의 기준을 여기서 고른다. 꼬리표는 칸 안에 **겹쳐** 띄워
                        행 높이를 안 밀게 한다(.cell-tag) — 예전엔 입력 아래에 붙어
                        그 줄만 키가 커지고 격자가 어긋났다. */}
                    <button type="button" className="cell-tag"
                      /* 왼쪽 열은 '단가 단위'(수량/중량)로 이름을 바꿨다 — 이제 여기서
                         '기준'이라는 말을 겹치지 않게 쓸 수 있다. */
                      title={l.amountTouched
                        ? '금액이 근거예요 — 수량을 바꾸면 단가를 다시 계산합니다. 누르면 단가 기준으로 바꿔요.'
                        : '단가가 근거예요 — 수량을 바꾸면 금액을 다시 계산합니다. 누르면 금액 기준으로 바꿔요.'}
                      onClick={() => setBasis(i, !l.amountTouched)}>
                      {l.amountTouched ? '금액 기준' : '단가 기준'}
                    </button>
                  </td>
                  )}
                  {col.vat && (
                  <td>
                    {/* 비워두면 과세유형대로 자동. 면세 줄만 0 으로 고치면 된다 —
                        직접 넣은 값은 그 줄의 세액으로 굳는다(자동값과 구별해 표시). */}
                    <MoneyInput value={String(shownVat(l))}
                      onChange={(raw, v) => set(i, { vat: v })}/>
                    {/* 꼬리표는 칸 안에 **겹쳐** 띄운다 — 입력 아래에 두면 행 높이를 밀어
                        같은 줄의 다른 칸들과 줄이 어긋난다(.cell-tag) */}
                    {(l.vat === null || l.vat === undefined || l.vat === '') ? (
                      <span className="cell-tag">자동</span>
                    ) : (
                      <button type="button" className="cell-tag" style={{ cursor: 'pointer' }}
                        title="과세유형대로 다시 계산" onClick={() => set(i, { vat: null })}>
                        되돌리기
                      </button>
                    )}
                  </td>
                  )}
                  {col.note && (
                    <td><input className="input" value={l.note || ''} placeholder="예: 14,500원/KG"
                      onChange={e => set(i, { note: e.target.value })}/></td>
                  )}
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
          {col.amount ? (
            <>
              <span className="text-muted">공급가</span><b className="num">{fmtNum(supplyTotal)}</b>
              <span className="text-muted">세액</span><b className="num">{fmtNum(vatTotal)}</b>
              <span className="text-muted">계</span><b className="num">{fmtNum(supplyTotal + vatTotal)}원</b>
            </>
          ) : (
            /* 금액 칸이 없는 화면(주문 품목표) — 합계는 단가×수량(또는 중량)으로 낸다.
               매입가가 있으면 마진까지 그 자리에서 보여준다. 계약별 손익을 여기서 정하기 때문. */
            <>
              <span className="text-muted">합계</span><b className="num">{fmtNum(calcTotal)}원</b>
              {col.costPrice && costTotal > 0 && (
                <>
                  <span className="text-muted">원가</span><b className="num">{fmtNum(costTotal)}</b>
                  <span className="text-muted">마진</span>
                  <b className="num" style={{ color: calcTotal - costTotal < 0 ? 'var(--neg-ink)' : undefined }}>
                    {fmtNum(calcTotal - costTotal)}원
                  </b>
                </>
              )}
            </>
          )}
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
  cost_price: '',   // 주문 품목표용. 청구서 저장 경로는 이 필드를 보내지 않으므로 남아도 무해하다
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
