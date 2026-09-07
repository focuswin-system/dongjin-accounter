import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import { Icon, useToast, fmtNum, fmtDateShort } from '../ui'

/**
 * 주문 없이 남은 청구서·거래를 **모아서 주문에 붙인다.**
 *
 * ── 왜 이 화면이 있나 ──
 * 등록할 때 주문을 묻지만 저장을 막지는 않는다 — 막으면 사람들은 '2026년 기타' 같은
 * 더미 주문을 만들어 통과하고, 그러면 데이터는 채워지는데 원가율이 거짓말을 한다.
 * 그래서 '없이 등록'을 열어 뒀고, 그렇게 빠져나간 것을 **나중에 몰아서** 회수하는 자리다.
 * 경리가 건건이가 아니라 한 번에 처리할 수 있어야 이 길이 도망칠 구멍이 아니라 정상 경로가 된다.
 *
 * ── 대사 화면과 무엇이 다른가 ──
 * 대사는 "이 돈이 어느 **청구서**를 갚았나"(금액이 축, 부분 정산 있음).
 * 여기는 "이 건이 어느 **주문**의 것인가"(귀속, 부분 없음) — 판정 축이 거래처·시기다.
 *
 * ⚠ 제시는 자동, 확정은 사람. 미리 골라 두는 건 후보가 하나뿐이고 기간까지 맞을 때만이다.
 */

/* ⚠ '거래처 같음'은 **적지 않는다.** 후보를 거래처로 걸러서 내므로 늘 참이고,
     늘 참인 표식은 정보가 0이면서 자리만 차지한다(모든 줄에 똑같이 붙어 있었다).
   '기간에서 N일/개월 벗어남'은 반대로 **눈에 띄어야 한다** — 확인이 필요하다는
   뜻이라 회색이면 묻힌다. */
const Why = ({ text }) => {
  if (/거래처 같음/.test(text)) return null
  const warn = /벗어남/.test(text)
  return (
    <span className={`badge ${warn ? 'warn' : 'pos'}`} style={{ fontSize: 10 }}>{text}</span>
  )
}

export const OrderLinkPanel = ({ kind, onChanged }) => {
  const isIncome = kind === 'income'
  const label = isIncome ? '수주' : '발주'
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState({})     // 항목 키 → 고른 주문 id
  const [open, setOpen] = useState({})     // 다른 후보를 펼친 줄
  const [done, setDone] = useState(null)
  const toast = useToast()

  const keyOf = (r) => `${r.type}:${r.id}`

  const load = useCallback(async () => {
    setBusy(true)
    const d = await api.getUnlinkedForOrders(kind)
    setData(d)
    /* 미리 골라 두는 건 **후보가 하나뿐이고 기간까지 맞을 때만**이다.
       같은 거래처에 주문이 여럿이면 어느 것인지는 우리가 알 수 없다. */
    const init = {}
    for (const r of (d.rows || [])) if (r.best.sure) init[`${r.type}:${r.id}`] = r.best.id
    setPick(init)
    setBusy(false)
  }, [kind])

  useEffect(() => { setDone(null); load() }, [load])

  const rows = data?.rows || []
  const chosen = rows.filter(r => pick[keyOf(r)])

  const apply = async () => {
    if (!chosen.length) return
    setBusy(true)
    const items = chosen.map(r => ({ type: r.type, id: r.id, contract_id: pick[keyOf(r)] }))
    const res = await api.linkOrders(items)
    setBusy(false)
    if (!res.ok) { toast.push(res.error || '붙이지 못했어요', { tone: 'warn' }); return }
    /* 되돌릴 수 있게 방금 붙인 것을 들고 있는다 — 주문별 실적·원가율이 바뀌는 일이라
       "잘못 눌렀다"가 반드시 나온다. 되돌아갈 길이 없으면 아무도 안 누른다. */
    setDone({ items, invoices: res.invoices, txns: res.txns })
    toast.push(`${res.invoices + res.txns}건을 ${label}에 붙였어요`)
    onChanged?.()
    await load()
  }

  const undo = async () => {
    if (!done?.items?.length) return
    setBusy(true)
    const res = await api.linkOrders(done.items.map(i => ({ ...i, contract_id: null })))
    setBusy(false)
    toast.push(res.ok ? '되돌렸어요' : (res.error || '되돌리지 못했어요'), res.ok ? undefined : { tone: 'warn' })
    onChanged?.()
    await load()
    setDone(null)
  }

  if (!data) return <div className="card" style={{ padding: 24 }}><span className="text-sm text-muted">불러오는 중…</span></div>

  return (
    <div>
      {done && (
        <div className="card" style={{ padding: '12px 16px', marginBottom: 12 }}>
          <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="text-sm"><b>{done.invoices + done.txns}건</b>을 붙였어요</span>
            <button className="btn sm ml-auto" onClick={undo} disabled={busy}>방금 한 것 되돌리기</button>
          </div>
        </div>
      )}

      <div className="row gap-8" style={{ alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        {/* 예전엔 "청구서 8건 · 거래 3건"만 적었는데, 위 제목의 '8건'(=붙일 만한 짝을 찾은 수)과
            숫자가 안 맞아 보였다. 무엇의 몇 건인지 한 줄로 밝힌다. */}
        <span className="text-sm text-muted">
          {label} 없는 청구서 {data.invoiceCount}건 · 거래 {data.txnCount}건
          {' — '}그중 <b className="text-ink">{rows.length}건</b>에 붙일 {label}를 찾았어요
        </span>
        <div className="row gap-6 ml-auto">
          <button className="btn sm" onClick={() => { setDone(null); load() }} disabled={busy}>다시 찾기</button>
          <button className="btn sm primary" onClick={apply} disabled={busy || !chosen.length}>
            {busy ? '붙이는 중…' : `선택한 ${chosen.length}건 붙이기`}
          </button>
        </div>
      </div>

      {!rows.length ? (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <Icon.Check size={28} style={{ color: 'var(--pos)' }}/>
          <div className="fw-700" style={{ marginTop: 8 }}>붙일 만한 게 없어요</div>
          <div className="text-sm text-muted2" style={{ marginTop: 4 }}>
            같은 거래처의 {label}가 있어야 붙일 수 있어요.
          </div>
        </div>
      ) : rows.map(r => {
        const k = keyOf(r)
        const picked = pick[k]
        const shown = [r.best, ...r.others]
        const isOpen = open[k]
        const cur = (picked && shown.find(c => c.id === picked)) || r.best
        return (
          <div key={k} className="card"
               style={{ padding: '12px 16px', marginBottom: 8, borderColor: picked ? 'var(--brand)' : undefined }}>
            <div className="row gap-16" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" checked={!!picked} style={{ marginTop: 4 }}
                onChange={e => setPick(p => ({ ...p, [k]: e.target.checked ? r.best.id : null }))}/>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row gap-6" style={{ alignItems: 'baseline' }}>
                  {/* 청구서인지 거래인지 밝힌다 — 둘을 한 목록에 섞어 보여주므로
                      무엇을 붙이는 건지 모르면 누를 수가 없다. */}
                  <span className="badge outline" style={{ fontSize: 10, flexShrink: 0 }}>
                    {r.type === 'invoice' ? '청구서' : '거래'}
                  </span>
                  {/* ⚠ flexWrap 을 쓰지 않는다. 좁은 화면에서 라벨이 길면 금액이 **다음 줄로
                      내려가** 라벨 → 금액 → 거래처 순서가 어그러진다(라벨이 짧으면 한 줄이라
                      같은 화면에서 줄이 제각각으로 보인다). 금액은 자리를 지키고
                      **라벨이 줄어드는** 게 맞다 — ellipsis 가 그 일을 한다. */}
                  <span className="fw-700 text-sm ellipsis" style={{ minWidth: 0 }}>{r.label}</span>
                  <span className="text-xs num" style={{ marginLeft: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtNum(r.amount)}</span>
                </div>
                <div className="text-xs text-muted2 ellipsis" style={{ marginTop: 2 }}>
                  {r.vendor || '거래처 없음'} · {fmtDateShort(r.date)}
                </div>
              </div>
              <Icon.Right size={14} style={{ color: 'var(--muted-2)', flexShrink: 0, margin: '4px 12px 0' }}/>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="fw-700 text-sm ellipsis">{cur.name}</div>
                <div className="text-xs text-muted2 ellipsis" style={{ marginTop: 2 }}>
                  {fmtDateShort(cur.start) || '시작일 없음'} ~ {cur.end ? fmtDateShort(cur.end) : '무기한'}
                  {cur.status ? ` · ${cur.status}` : ''}
                </div>
                <div className="row gap-4" style={{ marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {cur.why.map((w, i) => <Why key={i} text={w}/>)}
                  {r.others.length > 0 && (
                    <button className="btn ghost sm" style={{ marginLeft: 4, fontSize: 11, padding: '2px 8px' }}
                      onClick={() => setOpen(o => ({ ...o, [k]: !isOpen }))}>
                      다른 {label} {r.others.length}건 {isOpen ? '접기' : '보기'}
                    </button>
                  )}
                  {isOpen && (
                    <div style={{ width: '100%', marginTop: 4 }}>
                      {shown.map(c => (
                        <label key={c.id} className="row gap-8"
                               style={{ alignItems: 'center', marginTop: 6, cursor: 'pointer' }}>
                          <input type="radio" name={`alt-${k}`} checked={(picked || r.best.id) === c.id}
                                 onChange={() => setPick(p => ({ ...p, [k]: c.id }))}/>
                          <span className="text-xs ellipsis">{c.name}</span>
                          <span className="text-xs text-muted2" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                            {c.why.join(' · ')}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      })}

      {/* 목록이 길다(실데이터에 27건이 떠 있었다). 위에만 두면 스크롤해서 고른 뒤
          맨 위로 되돌아가야 누를 수 있다. 세 줄 넘어가면 아래에도 둔다. */}
      {rows.length > 3 && (
        <div className="row gap-6" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="btn sm primary" onClick={apply} disabled={busy || !chosen.length}>
            {busy ? '붙이는 중…' : `선택한 ${chosen.length}건 붙이기`}
          </button>
        </div>
      )}
    </div>
  )
}
