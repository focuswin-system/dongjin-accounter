import { useState } from 'react'
import { Drawer, Icon, fmtNum, useToast, useConfirm, MoneyInput, localToday, DateInput } from '../ui'
import { DrawerHead } from './Drawer'
import { api } from '../api'

/* 정기 회차 소급 등록 마법사 — 정기청구(매출)·정기지출(매입) 공용.
 *
 * 정기 반복은 등록일 이전 회차를 만들지 않는다(2003년 시작 주문이 수백 건으로 쏟아진 사고 때문).
 * 그 하한은 그대로 두고, **사용자가 기간을 명시적으로 열었을 때만** 그 범위를 만든다.
 *
 * 흐름: 기간 지정 → 미리보기(무엇이 생기고 무엇이 막히는지) → 개별 선택·금액 수정 → 일괄 생성 → 되돌리기
 * 규칙을 설명하는 대신 **결과를 먼저 보여준다** — 소급은 되돌리기 어려운 일이라 더 그렇다.
 */
export const BackfillWizard = ({ open, onClose, rule, kind, onDone }) => {
  const sales = kind === 'sales'
  const toast = useToast()
  const { confirm } = useConfirm()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(localToday())
  const [preview, setPreview] = useState(null)   // { cycles: [...] }
  const [rows, setRows] = useState([])           // 화면에서 만지는 사본
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)     // { batch, count }

  const reset = () => { setPreview(null); setRows([]); setResult(null) }
  const close = () => { reset(); setFrom(''); setTo(localToday()); onClose() }

  const doPreview = async () => {
    if (!from) return toast.push('언제부터 소급할지 선택해주세요', { tone: 'warn' })
    setBusy(true)
    const res = await api.backfillPreview(kind, rule.id, { from, to })
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '미리보기에 실패했어요', { tone: 'warn' })
    setPreview(res)
    /* 기본값: 만들 수 있는 것만 켠다(이미 있거나 마감된 달은 끔).
       과거 회차는 대부분 이미 돈이 오갔으므로 '기정산'도 기본으로 켠다 — 계획서의 규칙. */
    setRows(res.cycles.map(c => ({
      ...c,
      checked: !c.exists && !c.closed,
      paid: true,
      supply: c.supply_amount,
      vat: c.vat_amount,
    })))
    setResult(null)
  }

  const upd = (i, patch) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r))

  /* 공급가액을 고치면 세액도 따라가야 한다.
     안 그러면 5만→10만으로 올려도 세액이 5,000원에 머물러 **합계가 조용히 틀린다**
     (거래·청구서 폼이 이미 같은 규칙을 쓴다). 세율은 그 규칙의 원래 비율에서 가져온다 —
     면세·영세면 원래 세액이 0이므로 계속 0이 된다. */
  const updSupply = (i, v) => setRows(rs => rs.map((r, idx) => {
    if (idx !== i) return r
    const base = Number(r.supply_amount) || 0        // 서버가 준 원래 공급가
    const rate = base > 0 ? (Number(r.vat_amount) || 0) / base : 0
    return { ...r, supply: v, vat: Math.round((Number(v) || 0) * rate) }
  }))
  const picked = rows.filter(r => r.checked)
  const sumTotal = picked.reduce((s, r) => s + (Number(r.supply) || 0) + (Number(r.vat) || 0), 0)
  const blockedClosed = rows.filter(r => r.closed)
  const already = rows.filter(r => r.exists)

  const doCommit = async () => {
    if (picked.length === 0) return toast.push('만들 회차를 선택해주세요', { tone: 'warn' })
    const paidN = picked.filter(r => r.paid).length
    const ok = await confirm({
      title: `${picked.length}건을 만들까요?`,
      body: (
        <>
          <div style={{ marginBottom: 6 }}>
            {picked[0].due_date} ~ {picked[picked.length - 1].due_date} · 합계 <b>{fmtNum(sumTotal)}원</b>
          </div>
          <div>
            {sales ? '청구서' : '매입 청구서'} {picked.length}건이 만들어지고,
            그중 <b>{paidN}건</b>은 {sales ? '입금' : '지급'}까지 처리돼 계좌 잔액에 반영됩니다.
          </div>
          <div style={{ marginTop: 6 }}>만든 뒤 이 화면에서 한 번에 되돌릴 수 있어요.</div>
        </>
      ),
      confirmLabel: `${picked.length}건 만들기`,
    })
    if (!ok) return
    setBusy(true)
    const res = await api.backfillCommit(kind, rule.id, picked.map(r => ({
      due_date: r.due_date,
      supply_amount: Number(r.supply) || 0,
      vat_amount: Number(r.vat) || 0,
      total_amount: (Number(r.supply) || 0) + (Number(r.vat) || 0),
      paid: !!r.paid,
    })))
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '등록에 실패했어요', { tone: 'warn' })
    setResult({ batch: res.batch, count: res.count })
    toast.push(`${res.count}건을 등록했어요`)
    onDone && onDone()
  }

  const doUndo = async () => {
    const ok = await confirm({
      tone: 'neg',
      title: '방금 만든 것을 되돌릴까요?',
      body: `${result.count}건의 ${sales ? '청구서' : '매입 청구서'}와 함께 만들어진 거래가 지워집니다. 복구할 수 없어요.`,
      confirmLabel: '되돌리기',
    })
    if (!ok) return
    setBusy(true)
    const res = await api.backfillUndo(kind, result.batch)
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '되돌리기에 실패했어요', { tone: 'warn' })
    toast.push(`${res.count}건을 되돌렸어요`)
    setResult(null); setPreview(null); setRows([])
    onDone && onDone()
  }

  return (
    <Drawer open={open} onClose={close} width={720}>
      <DrawerHead
        title="지난 회차 소급 등록"
        sub={`${rule?.label || ''} · 등록일 이전 회차는 평소엔 만들어지지 않아요. 기간을 열어 한 번에 넣습니다.`}
        onClose={close}/>
      <div className="drawer-body col gap-form">
        {/* 1) 기간 */}
        <div className="row gap-12" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 150 }}>
            <label className="label">언제부터 <span style={{ color: 'var(--neg-ink)' }}>*</span></label>
            <DateInput className="input" value={from} max={to}
              onChange={e => { setFrom(e.target.value); reset() }}/>
          </div>
          <div style={{ flex: 1, minWidth: 150 }}>
            <label className="label">언제까지</label>
            <DateInput className="input" value={to} max={localToday()}
              onChange={e => { setTo(e.target.value); reset() }}/>
          </div>
          <button className="btn primary" onClick={doPreview} disabled={busy}>
            <Icon.Search size={14}/> 미리보기
          </button>
        </div>
        <div className="text-xs text-muted2">
          미래 회차는 소급 대상이 아니에요 — 그건 ‘발행 예정’에서 그대로 처리합니다.
        </div>

        {/* 2) 미리보기 결과 */}
        {preview && (
          <>
            {rows.length === 0 && (
              <div className="card card-pad" style={{ textAlign: 'center', color: 'var(--muted-2)' }}>
                이 기간에 만들 회차가 없어요.
              </div>
            )}

            {/* 막히는 것을 먼저 말한다 — 만들고 나서 "왜 빠졌지"가 되면 안 된다 */}
            {blockedClosed.length > 0 && (
              <div className="alert-row" style={{ background: 'var(--warn-soft)', borderColor: 'transparent' }}>
                <Icon.Warn/>
                <div className="text-sm">
                  <b>마감된 달 {blockedClosed.length}건</b>은 만들 수 없어요
                  ({blockedClosed.map(r => r.due_date).join(', ')}).
                  넣어야 한다면 환경설정 → 월 마감에서 그 달을 먼저 풀어주세요.
                  <div className="text-xs text-muted2" style={{ marginTop: 2 }}>
                    마감을 푸는 건 이미 신고한 자료가 바뀔 수 있다는 뜻이라, 여기서 자동으로 풀지 않아요.
                  </div>
                </div>
              </div>
            )}
            {already.length > 0 && (
              <div className="text-xs text-muted2">
                이미 만들어진 회차 {already.length}건은 꺼 두었어요 ({already.map(r => r.existing_no || r.due_date).join(', ')}).
              </div>
            )}

            {rows.length > 0 && (
              <>
                <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
                  <button className="btn sm" onClick={() => setRows(rs => rs.map(r => ({ ...r, checked: !r.exists && !r.closed })))}>
                    만들 수 있는 것 전체 선택
                  </button>
                  <button className="btn sm" onClick={() => setRows(rs => rs.map(r => ({ ...r, checked: false })))}>전체 해제</button>
                  <button className="btn sm" onClick={() => setRows(rs => rs.map(r => ({ ...r, paid: true })))}>
                    전부 {sales ? '기입금' : '기지급'}
                  </button>
                  <button className="btn sm" onClick={() => setRows(rs => rs.map(r => ({ ...r, paid: false })))}>
                    전부 미정산
                  </button>
                </div>

                <div className="card" style={{ overflow: 'hidden' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}></th>
                        <th>회차일</th>
                        <th className="num">공급가액</th>
                        <th className="num">부가세</th>
                        <th className="num">합계</th>
                        <th style={{ width: 110 }}>{sales ? '입금' : '지급'}</th>
                        <th>상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const disabled = r.exists || r.closed
                        return (
                          <tr key={r.due_date} style={disabled ? { opacity: 0.55 } : undefined}>
                            <td>
                              <input type="checkbox" checked={r.checked} disabled={disabled}
                                onChange={e => upd(i, { checked: e.target.checked })}/>
                            </td>
                            <td>{r.due_date}</td>
                            <td className="num" style={{ maxWidth: 140 }}>
                              {/* 회차별 금액 수정 — 임차료 인상처럼 달마다 금액이 달랐던 경우가 반드시 있다 */}
                              <MoneyInput value={String(r.supply)} disabled={disabled}
                                onChange={(raw, v) => updSupply(i, v)}/>
                            </td>
                            <td className="num" style={{ maxWidth: 120 }}>
                              <MoneyInput value={String(r.vat)} disabled={disabled}
                                onChange={(raw, v) => upd(i, { vat: v })}/>
                            </td>
                            <td className="num fw-600">{fmtNum((Number(r.supply) || 0) + (Number(r.vat) || 0))}</td>
                            <td>
                              <label className="row gap-4 text-xs" style={{ cursor: disabled ? 'default' : 'pointer' }}>
                                <input type="checkbox" checked={r.paid} disabled={disabled}
                                  onChange={e => upd(i, { paid: e.target.checked })}/>
                                {sales ? '이미 입금' : '이미 지급'}
                              </label>
                            </td>
                            <td className="text-xs text-muted2">
                              {r.closed ? '마감된 달' : r.exists ? `이미 있음 ${r.existing_no || ''}` : ''}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="row" style={{ alignItems: 'center' }}>
                  <div className="text-sm">
                    선택 <b>{picked.length}건</b> · 합계 <b>{fmtNum(sumTotal)}원</b>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* 3) 생성 결과 + 되돌리기 */}
        {result && (
          <div className="alert-row" style={{ background: 'var(--pos-soft)', borderColor: 'transparent' }}>
            <Icon.Check/>
            <div className="text-sm" style={{ flex: 1 }}>
              {result.count}건을 만들었어요. 잘못됐으면 지금 한 번에 되돌릴 수 있어요.
            </div>
            <button className="btn sm" onClick={doUndo} disabled={busy}>되돌리기</button>
          </div>
        )}
      </div>

      <div className="drawer-foot">
        <button className="btn" onClick={close}>닫기</button>
        <button className="btn primary" style={{ marginLeft: 'auto' }}
          onClick={doCommit} disabled={busy || picked.length === 0 || !!result}>
          {picked.length > 0 ? `${picked.length}건 만들기` : '만들기'}
        </button>
      </div>
    </Drawer>
  )
}
