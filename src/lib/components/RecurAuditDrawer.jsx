import { useState, useEffect } from 'react'
import { Drawer, Icon, fmtNum, Loading, useToast } from '../ui'
import { DrawerHead } from './Drawer'
import { api } from '../api'

/* 정기 점검 — 규칙 전부를 한 번에 훑어 **이상만** 보여준다.
 *
 * 여태는 규칙 하나씩 열어 기간을 넣고 미리보기를 돌려야 문제를 알 수 있었다.
 * 규칙이 수십 개면 그건 점검이 아니라 노동이고, 실제로 끝까지 보는 사람이 없다.
 *
 * 화면 규칙 두 가지:
 *   · **이상 있는 것만 먼저.** 멀쩡한 규칙은 접어 둔다 — 첫 줄이 '정상'이면 아무도 두 번 안 연다.
 *   · **여기서 바로 고치러 갈 수 있어야 한다.** 문제를 보여주고 "찾아가세요"로 끝나면
 *     결국 하나씩 여는 일이 그대로 남는다.
 */
const TONE = {
  high: { bg: 'var(--neg-soft)', ink: 'var(--neg-ink)' },
  mid:  { bg: 'var(--warn-soft)', ink: 'var(--ink)' },
  low:  { bg: 'var(--surface-2)', ink: 'var(--muted)' },
}

export const RecurAuditDrawer = ({ open, onClose, kind, onFix, onHistory }) => {
  const sales = kind === 'sales'
  const toast = useToast()
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showOk, setShowOk] = useState(false)

  const load = async () => {
    setBusy(true)
    const res = await api.recurAudit(kind)
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '점검에 실패했어요', { tone: 'warn' })
    setData(res)
  }
  useEffect(() => { if (open) { setShowOk(false); load() } }, [open, kind])

  const bad = (data?.rules || []).filter(r => r.issues.length > 0)
  const ok  = (data?.rules || []).filter(r => r.issues.length === 0)

  const Row = ({ r }) => {
    const tone = TONE[r.severity] || TONE.low
    return (
      <div className="card card-pad" style={{ marginBottom: 8 }}>
        <div className="row gap-8" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div className="fw-600">{r.vendor_name || '(거래처 없음)'}</div>
            <div className="text-xs text-muted2">
              {r.label || '—'}{r.contract_name ? ` · ${r.contract_name}` : ''}
              {!r.active && ' · 중지됨'}
            </div>
          </div>
          <div className="num text-sm" style={{ textAlign: 'right' }}>
            <div>{fmtNum(r.paid_amount)} <span className="text-muted2">/ {fmtNum(r.due_amount)}원</span></div>
            <div className="text-xs text-muted2">{sales ? '받음 / 도래' : '냄 / 도래'}</div>
          </div>
        </div>
        {r.issues.length > 0 && (
          <div style={{ marginTop: 8, background: tone.bg, borderRadius: 8, padding: '8px 10px' }}>
            {r.issues.map((is, i) => (
              <div key={is.code + i} className="text-sm" style={{ color: tone.ink }}>· {is.text}</div>
            ))}
          </div>
        )}
        {/* 보여주고 끝내지 않는다 — 여기서 바로 고치러 간다 */}
        <div className="row gap-8" style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={() => onHistory && onHistory(r.id)}>회차 이력</button>
          {r.issues.some(i => i.code === 'missing' || i.code === 'stuck') && (
            <button className="btn sm primary" onClick={() => onFix && onFix(r.id)}>지난 회차 넣기</button>
          )}
        </div>
      </div>
    )
  }

  return (
    <Drawer open={open} onClose={onClose} width={640}>
      <DrawerHead
        title={`${sales ? '정기 입금' : '정기 출금'} 점검`}
        sub="규칙을 하나씩 열어 보지 않아도 되게, 전부 훑어 이상만 모았어요."
        onClose={onClose}/>
      <div className="drawer-body col gap-form">
        {busy && <Loading/>}
        {!busy && data && (
          <>
            <div className="row gap-12" style={{ flexWrap: 'wrap' }}>
              <div>
                <div className="text-xs text-muted2">점검한 규칙</div>
                <div className="num fw-700">{data.checked}개</div>
              </div>
              <div>
                <div className="text-xs text-muted2">이상</div>
                <div className="num fw-700" style={{ color: data.problems ? 'var(--neg-ink)' : 'var(--pos-ink)' }}>
                  {data.problems}건
                </div>
              </div>
              <button className="btn sm ml-auto" onClick={load}><Icon.Refresh size={14}/> 다시 점검</button>
            </div>

            {bad.length === 0 ? (
              <div className="card card-pad" style={{ textAlign: 'center', color: 'var(--muted-2)' }}>
                이상이 없어요. 도래한 회차가 모두 청구·정산됐습니다.
              </div>
            ) : bad.map(r => <Row key={r.id} r={r}/>)}

            {/* 멀쩡한 규칙은 접어 둔다 — 세어만 보고 싶을 때 펼친다 */}
            {ok.length > 0 && (
              <div>
                <button className="btn ghost sm" onClick={() => setShowOk(s => !s)}>
                  {showOk ? '이상 없는 규칙 접기' : `이상 없는 규칙 ${ok.length}개 보기`}
                </button>
                {showOk && <div style={{ marginTop: 8 }}>{ok.map(r => <Row key={r.id} r={r}/>)}</div>}
              </div>
            )}
          </>
        )}
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>닫기</button>
      </div>
    </Drawer>
  )
}
