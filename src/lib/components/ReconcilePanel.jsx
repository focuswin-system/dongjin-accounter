import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import { Icon, useToast, fmtNum } from '../ui'

/**
 * 대사(對査) — 청구서와 오간 돈을 **한 화면에서 한꺼번에** 잇는다.
 *
 * ── 왜 필요한가 ──
 * 세금계산서를 엑셀로 올리고 통장 내역을 엑셀로 올리면, 그 둘은 아직 남남이다.
 * 여태는 청구서를 하나 열어 후보를 보고 고르는 길뿐이라 100건이면 100번 열어야 했다.
 *
 * ── 무엇을 하고 무엇을 안 하나 ──
 * **제시는 자동, 확정은 사람.** 미리 골라 두는 것은 근거가 뚜렷한 것뿐이고,
 * 나머지는 눈으로 보고 켜야 한다. 잘못 이으면 "받은 걸로 되어 있는데 통장엔 없는 돈"이
 * 생기고 몇 달 뒤에야 드러난다 — 그때는 원인을 찾기가 아주 어렵다.
 *
 * ⚠ 붙이는 일은 **한 건씩** 기존 `api.matchInvoice` 로 한다. 거기에 마감월·중복 거래·
 *   잔액 초과 가드가 다 들어 있다. 빠르라고 서버에 일괄 경로를 새로 내면 그 가드를
 *   한 벌 더 쓰게 되고, 언젠가 한쪽만 고쳐진다.
 */

/** 근거 한 조각 — 왜 이 짝을 내놓았는지 사람이 읽을 수 있어야 누를 수 있다. */
const Why = ({ text }) => {
  // 뜻이 다른 근거를 같은 색으로 두면 훑을 수 없다 — 맞아떨어진 것과 참고만 할 것을 가른다
  const strong = /일치|거래처 같음|거의 같음|거래처 이름/.test(text)
  const weak = /다름|보다 먼저|모자람/.test(text)
  return (
    <span className={`badge ${strong ? 'pos' : weak ? 'outline' : ''}`} style={{ fontSize: 10 }}>{text}</span>
  )
}

const Side = ({ title, sub, amount, foot }) => (
  <div style={{ minWidth: 0, flex: 1 }}>
    {/* ⚠ flexWrap 을 쓰지 않는다. 좁은 화면에서 이름이 길면 금액이 다음 줄로 내려가
        순서가 어그러진다 — 금액이 자리를 지키고 이름이 줄어드는 게 맞다. */}
    <div className="row gap-6" style={{ alignItems: 'baseline' }}>
      <span className="fw-700 text-sm ellipsis" style={{ minWidth: 0 }}>{title}</span>
      <span className="text-xs num" style={{ marginLeft: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}>{fmtNum(amount)}</span>
    </div>
    <div className="text-xs text-muted2 ellipsis" style={{ marginTop: 2 }}>{sub}</div>
    {foot}
  </div>
)

export const ReconcilePanel = ({ kind, onChanged }) => {
  const isIssued = kind === 'issued'
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState({})      // 청구서 id → 고른 거래 id (없으면 안 붙임)
  const [open, setOpen] = useState({})      // 다른 후보를 펼친 줄
  const [done, setDone] = useState(null)    // 방금 붙인 결과 — 되돌릴 수 있게 들고 있는다
  const toast = useToast()

  const load = useCallback(async () => {
    setBusy(true)
    const d = await api.getReconcile(kind)
    setData(d)
    /* 미리 골라 두는 것은 **근거가 뚜렷한 것뿐**이다. 나머지를 함께 켜 두면
       사람이 하나씩 끄게 되는데, 그러다 보면 결국 다 켠 채로 누른다. */
    const init = {}
    for (const r of (d.rows || [])) if (r.best.sure) init[r.invoice.id] = r.best.id
    setPick(init)
    setBusy(false)
    /* ⚠ 여기서 done 을 지우지 않는다. 이었으면 곧바로 목록을 다시 부르는데,
         그때 지우면 **되돌리기 버튼이 뜨자마자 사라진다**. 지우는 건 사람이
         '다시 찾기'를 눌렀을 때와 매출/매입을 오갈 때뿐이다. */
  }, [kind])

  useEffect(() => { setDone(null); load() }, [load])

  const rows = data?.rows || []
  const chosen = rows.filter(r => pick[r.invoice.id])

  const apply = async () => {
    if (!chosen.length) return
    setBusy(true)
    const okList = [], failList = []
    for (const r of chosen) {
      const txn = [r.best, ...r.others].find(t => t.id === pick[r.invoice.id])
      if (!txn) continue
      const res = await api.matchInvoice(r.invoice.id, {
        // 붙일 금액은 서버가 정해 준 apply 다 — 거래 금액과 다를 수 있다(나눠 붙는 경우)
        txnId: txn.id, amount: txn.apply ?? txn.amount, date: txn.date,
        category: txn.category || undefined, memo: txn.memo || undefined,
        account_id: txn.accountId || undefined,
      })
      if (res.ok) okList.push({ invoiceId: r.invoice.id, matchId: res.matchId, label: r.invoice.invoiceNo })
      /* 실패는 **사유째로** 남긴다. 마감된 달·이미 붙은 거래 같은 진짜 이유가 있고,
         "3건 실패"만 보여 주면 사람이 할 수 있는 일이 없다. */
      else failList.push({ label: r.invoice.invoiceNo, error: res.error })
    }
    setBusy(false)
    setDone({ ok: okList, fail: failList })
    if (okList.length) toast.push(`${okList.length}건을 이었어요`)
    if (failList.length && !okList.length) toast.push('잇지 못했어요', { tone: 'warn' })
    onChanged?.()
    await load()
  }

  /** 방금 이은 것을 통째로 물린다 — 잘못 눌렀을 때 되돌아갈 길이 없으면 아무도 못 누른다.
   *
   *  ⚠ **다 물릴 수 있는 건 아니다.** 그 거래가 이미 지급결의서로 집행됐다면 서버가 막는다
   *    (맞는 처사다 — 결의서 쪽 기록과 어긋나기 때문이다). 그럴 때 "되돌리지 못했어요" 만
   *    띄우면 사람이 할 수 있는 일이 없으므로, **서버가 준 사유를 그대로** 남긴다.
   *    실측에서 '지급결의서 DJ-2026-0005로 집행됐어요. 결의서에서 되돌려주세요.' 가 나왔다. */
  const undoAll = async () => {
    if (!done?.ok?.length) return
    setBusy(true)
    const left = [], fail = []
    for (const m of done.ok) {
      if (!m.matchId) { fail.push({ label: m.label, error: '되돌릴 기록을 찾지 못했어요' }); continue }
      const r = await api.unmatchInvoice(m.invoiceId, m.matchId)
      if (r.ok) continue
      left.push(m)                                        // 아직 붙어 있으니 다시 시도할 수 있게 남긴다
      fail.push({ label: m.label, error: r.error })
    }
    setBusy(false)
    const n = done.ok.length - left.length
    toast.push(n ? `${n}건을 되돌렸어요` : '되돌리지 못했어요', n ? undefined : { tone: 'warn' })
    onChanged?.()
    await load()
    // 다 물렸으면 '방금 한 일'을 치운다. 남은 게 있으면 사유와 함께 세워 둔다.
    setDone(left.length ? { ok: left, fail, undone: n } : null)
  }

  if (!data) return <div className="card" style={{ padding: 24 }}><span className="text-sm text-muted">불러오는 중…</span></div>

  return (
    <div>
      {/* 방금 한 일 — 되돌리기가 여기 붙는다. 결과를 토스트로만 알리면 되돌릴 자리가 없다. */}
      {done && (
        <div className="card" style={{ padding: '12px 16px', marginBottom: 12 }}>
          <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="text-sm">
              {done.undone
                ? <><b>{done.undone}건</b> 되돌렸어요 · <b>{done.ok.length}건</b>은 그대로예요</>
                : <><b>{done.ok.length}건</b> 이었어요{done.fail.length ? ` · ${done.fail.length}건 실패` : ''}</>}
            </span>
            {done.ok.length > 0 && (
              <button className="btn sm ml-auto" onClick={undoAll} disabled={busy}>방금 한 것 되돌리기</button>
            )}
          </div>
          {done.fail.map((f, i) => (
            <div key={i} className="text-xs" style={{ color: 'var(--neg-ink)', marginTop: 4 }}>
              {f.label} — {f.error}
            </div>
          ))}
        </div>
      )}

      <div className="row gap-8" style={{ alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span className="text-sm text-muted">
          남은 {isIssued ? '청구서' : '계산서'} {data.invoiceCount}건 · 안 붙은 {isIssued ? '입금' : '지급'} {data.txnCount}건
        </span>
        <div className="row gap-6 ml-auto">
          <button className="btn sm" onClick={() => { setDone(null); load() }} disabled={busy}>다시 찾기</button>
          <button className="btn sm primary" onClick={apply} disabled={busy || !chosen.length}>
            {busy ? '잇는 중…' : `선택한 ${chosen.length}건 잇기`}
          </button>
        </div>
      </div>

      {!rows.length ? (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <Icon.Check size={28} style={{ color: 'var(--pos)' }}/>
          <div className="fw-700" style={{ marginTop: 8 }}>이을 만한 짝이 없어요</div>
          <div className="text-sm text-muted2" style={{ marginTop: 4 }}>
            금액이 맞는 거래가 있어야 짝으로 내놓아요.
          </div>
        </div>
      ) : rows.map(r => {
        const picked = pick[r.invoice.id]
        const shown = [r.best, ...r.others]
        const isOpen = open[r.invoice.id]
        // 지금 이 줄이 가리키는 거래 — 다른 후보로 바꿔 끼웠으면 그것이다
        const cur = (picked && shown.find(t => t.id === picked)) || r.best
        return (
          <div key={r.invoice.id} className="card"
               style={{ padding: '12px 16px', marginBottom: 8, borderColor: picked ? 'var(--brand)' : undefined }}>
            {/* 좌우 두 칸 사이를 넉넉히 벌린다 — 붙여 두면 왼쪽 금액과 화살표가
                '262,000 >' 한 덩어리로 읽혀서 어느 쪽 금액인지 헷갈린다(실측). */}
            <div className="row gap-16" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" checked={!!picked} style={{ marginTop: 4 }}
                onChange={e => setPick(p => ({ ...p, [r.invoice.id]: e.target.checked ? r.best.id : null }))}/>
              <Side title={r.invoice.invoiceNo || '(번호 없음)'} amount={r.invoice.remain}
                    sub={`${r.invoice.vendor || '거래처 없음'} · ${String(r.invoice.issuedAt || '').slice(0, 10)}`}/>
              <Icon.Right size={14} style={{ color: 'var(--muted-2)', flexShrink: 0, margin: '4px 12px 0' }}/>
              {/* 거래처가 비면 적요를 제목으로 올린다 — '거래처 없음'을 굵게 세우면
                  그게 상호인 줄 읽힌다(실측). 엑셀로 올린 통장 내역이 대개 이렇다. */}
              {/* 붙일 금액이 거래 금액보다 작을 수 있다(600만원 한 줄에서 200만원만 붙는 경우).
                  그때는 **붙일 금액을 크게** 두고 거래 금액은 밑줄에 적는다 — 큰 숫자가 거래
                  금액이면 "왜 200만원만 처리됐지"가 된다. */}
              <Side title={cur.vendor || cur.memo || cur.category || '적요 없음'}
                    amount={cur.apply ?? cur.amount}
                    sub={cur.apply != null && cur.apply !== cur.amount
                      ? `${cur.date} · ${cur.account || '계좌 없음'} · 거래 ${fmtNum(cur.amount)} 중`
                      : `${cur.date} · ${cur.account || '계좌 없음'}`}
                    foot={
                      <div className="row gap-4" style={{ marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        {cur.why.map((w, i) => <Why key={i} text={w}/>)}
                        {/* '다른 후보'는 **거래 쪽** 이야기다 — 오른쪽 칸에 붙인다.
                            왼쪽(청구서) 아래에 뒀더니 무엇의 후보인지 읽히지 않았다. */}
                        {r.others.length > 0 && (
                          <button className="btn ghost sm" style={{ marginLeft: 4, fontSize: 11, padding: "2px 8px" }}
                            onClick={() => setOpen(o => ({ ...o, [r.invoice.id]: !isOpen }))}>
                            다른 후보 {r.others.length}건 {isOpen ? '접기' : '보기'}
                          </button>
                        )}
                        {/* 대안도 이 칸 안에 둔다 — 밖에 두면 왼쪽(청구서) 축에 붙어
                            무엇을 바꿔 끼우는 목록인지 안 읽힌다. 지금 고른 것까지 함께
                            세워야 '바꾸는' 것으로 보인다(하나만 보이면 추가로 읽힌다). */}
                        {isOpen && (
                          <div style={{ width: '100%', marginTop: 4 }}>
                            {shown.map(t => (
                              <label key={t.id} className="row gap-8"
                                     style={{ alignItems: 'center', marginTop: 6, cursor: 'pointer' }}>
                                <input type="radio" name={`alt-${r.invoice.id}`}
                                       checked={(picked || r.best.id) === t.id}
                                       onChange={() => setPick(p => ({ ...p, [r.invoice.id]: t.id }))}/>
                                <span className="text-xs">{t.date} · {t.vendor || t.memo || '적요 없음'}</span>
                                <span className="text-xs num" style={{ marginLeft: 'auto' }}>{fmtNum(t.amount)}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    }/>
            </div>
          </div>
        )
      })}
    </div>
  )
}
