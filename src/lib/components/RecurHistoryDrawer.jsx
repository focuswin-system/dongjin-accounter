import { useState, useEffect } from 'react'
import { fmtNum, Drawer, Loading, localToday } from '../ui'
import { DrawerHead } from './Drawer'
import { api } from '../api'

/**
 * 정기 규칙의 **회차 이력** — 이 규칙이 지금까지 어떻게 흘러왔나.
 *
 * ── 왜 만들었나 ──
 * 정기입금·정기지급은 행을 누르면 **수정 폼**이 열리는 게 전부였다. 그래서
 *   · 이 규칙이 여태 얼마를 만들어냈는지 → 청구서 목록을 거래처로 걸러 눈으로 셌다
 *   · 변동형 금액이 어떻게 움직였는지 → 볼 데가 없었다. 정작 발행할 때는
 *     **직전 회차 금액이 기본값**으로 들어가는데, 그 직전 회차를 확인할 자리가 없었다
 *   · 왜 그 달만 없는지 → recurring_skips 에 **사유까지 저장하면서 읽는 화면이 없었다**
 *
 * ⚠ 보는 것과 고치는 것을 갈랐다. 예전엔 누르면 바로 편집이라 "보려다 고치는" 구조였다.
 *   수정은 이 안의 버튼으로 한 번 더 짚고 들어간다(대여금 상세와 같은 모양).
 *
 * ⚠ 소급으로 넣은 회차는 **반드시 표시한다.** 규칙 등록 전 회차를 나중에 몰아 넣은 것이라,
 *   표시가 없으면 "이 규칙이 그때부터 돌고 있었다"로 읽힌다.
 *
 * 매출(sales)·매입(purchase)이 거울이라 한 부품으로 짓는다 — 두 벌로 두면 반드시 어긋난다.
 */
export const RecurHistoryDrawer = ({ open, rule, kind, onClose, onEdit }) => {
  const isSales = kind === 'sales'
  const [d, setD] = useState(null)

  useEffect(() => {
    if (!open || !rule?.id) return
    let alive = true
    setD(null)
    const get = isSales ? api.getRecurringInvoiceHistory : api.getRecurringExpenseHistory
    get(rule.id).then(x => { if (alive) setD(x) })
    return () => { alive = false }
  }, [open, rule?.id, kind])

  const today = localToday()

  return (
    <Drawer open={open} onClose={onClose} width="min(760px,100vw)" label="정기 회차 이력">
      {rule && (<>
        <DrawerHead title={rule.label || rule.vendor || '정기 규칙'}
          sub={rule.sub || (isSales ? '정기입금 회차 이력' : '정기지급 회차 이력')}
          onClose={onClose}/>
        <div className="drawer-body">
          {!d ? <Loading label="회차를 불러오는 중…"/> : (<>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
              <div>
                <div className="text-xs text-muted2">{isSales ? '청구한 회차' : '지급한 회차'}</div>
                <div className="num fw-700">{d.totals.done}회</div>
              </div>
              <div>
                <div className="text-xs text-muted2">여태 합계</div>
                <div className="num fw-700">{fmtNum(d.totals.amount)}</div>
              </div>
              <div>
                <div className="text-xs text-muted2">{isSales ? '입금된 회차' : '지급 완료'}</div>
                <div className="num fw-700"
                  style={{ color: d.totals.settled ? 'var(--pos-ink)' : undefined }}>{d.totals.settled}회</div>
              </div>
            </div>

            {/* 지금까지 얼마를 받았어야 하는데 얼마를 받았나.
                주문(청구일정)에는 총액이 있어 진행률이 나오는데 정기 규칙은 끝이 없어서
                이 눈금이 없었다 — 한 회차가 통째로 빠져도 표가 안 났다.
                기산점은 첫 회차가 실제로 만들어진 날, 건너뛴 달은 분모에서 뺀다. */}
            {d.totals.due_amount > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div className="row" style={{ alignItems: 'baseline', marginBottom: 6 }}>
                  <div className="text-xs text-muted2">
                    지금까지 {isSales ? '받았어야 할 돈' : '냈어야 할 돈'}
                  </div>
                  <div className="num text-sm" style={{ marginLeft: 'auto' }}>
                    <b>{fmtNum(d.totals.paid_amount)}</b>
                    <span className="text-muted2"> / {fmtNum(d.totals.due_amount)}원</span>
                  </div>
                </div>
                <div style={{ height: 8, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 999,
                    width: `${Math.min(100, Math.round(d.totals.paid_amount / d.totals.due_amount * 100))}%`,
                    background: d.totals.paid_amount >= d.totals.due_amount ? 'var(--pos-ink)' : 'var(--brand)',
                  }}/>
                </div>
                {d.totals.due_amount > d.totals.paid_amount && (
                  <div className="text-xs" style={{ marginTop: 5, color: 'var(--muted-2)' }}>
                    {fmtNum(d.totals.due_amount - d.totals.paid_amount)}원이 아직 {isSales ? '안 들어왔어요' : '안 나갔어요'}
                    {d.totals.missing_estimated && ' (만들지 않은 달은 최근 회차 금액으로 어림했어요)'}
                  </div>
                )}
              </div>
            )}

            {/* 건너뛴 게 있을 때만 알린다 — 없는 걸 0으로 세워 두면 정상에 표식을 다는 꼴이다 */}
            {d.totals.skipped > 0 && (
              <div className="text-sm text-muted" style={{ marginBottom: 12 }}>
                건너뛴 회차 <b>{d.totals.skipped}회</b>가 있어요. 아래 표에서 사유를 볼 수 있어요.
              </div>
            )}
            {/* 빠진 달 — 이 화면이 풀려던 "왜 그 달만 없지"의 답이다 */}
            {d.totals.missing > 0 && (
              <div className="text-sm" style={{ marginBottom: 12, color: 'var(--neg-ink)' }}>
                만들지도 건너뛰지도 않은 달이 <b>{d.totals.missing}회</b> 있어요.
                필요하면 <b>지난 회차 넣기</b>로 채울 수 있어요.
              </div>
            )}
            {d.totals.backfilled > 0 && (
              <div className="text-sm text-muted" style={{ marginBottom: 12 }}>
                이 중 <b>{d.totals.backfilled}회</b>는 나중에 <b>소급으로</b> 넣은 회차예요.
              </div>
            )}

            {d.cycles.length === 0 ? (
              <div className="text-sm text-muted2" style={{ padding: 24, textAlign: 'center' }}>
                아직 만들어진 회차가 없어요.
              </div>
            ) : (
              <table className="table">
                <thead><tr>
                  <th style={{ width: 110 }}>날짜</th>
                  <th className="num-right">{isSales ? '청구액' : '지급액'}</th>
                  <th>{isSales ? '상태' : '비목 / 상태'}</th>
                  <th>{isSales ? '입금 계좌' : '출금 계좌'}</th>
                  <th style={{ width: 90 }}></th>
                </tr></thead>
                <tbody>
                  {d.cycles.map((c, i) => (
                    <tr key={`${c.state}-${c.date}-${c.id || i}`}
                      style={{ opacity: c.state === 'done' ? 1 : 0.62 }}>
                      <td className="num text-sm">{c.date}</td>
                      <td className="num-cell num-right">
                        {c.state === 'done' ? (<>
                          <span className="fw-700">{fmtNum(c.total_amount)}</span>
                          {/* 매입 청구서도 공급가액이 갈려 있다 — 부가세 신고의 근거라 함께 보인다 */}
                          {c.vat_amount > 0 && (
                            <div className="text-xs text-muted2">
                              공급 {fmtNum(c.supply_amount)} · VAT {fmtNum(c.vat_amount)}
                            </div>
                          )}
                        </>) : <span className="text-muted2">—</span>}
                      </td>
                      <td className="text-sm">
                        {c.state === 'skipped' ? (<>
                          <span className="badge" style={{ fontSize: 10 }}>건너뜀</span>
                          {/* 사유는 저장만 하고 아무도 못 보던 값이다 */}
                          {c.reason && <div className="text-xs text-muted">{c.reason}</div>}
                        </>) : c.state === 'missing' ? (
                          <span className="text-xs" style={{ color: 'var(--neg-ink)' }}>안 만들어짐</span>
                        ) : c.state === 'upcoming' ? (
                          <span className="text-xs text-muted2">
                            {c.date <= today ? '아직 안 만듦' : '예정'}
                          </span>
                        ) : (<>
                          {c.category && <span className="text-muted">{c.category}</span>}
                          <div className="text-xs text-muted">{c.status || '—'}</div>
                        </>)}
                      </td>
                      <td className="text-sm text-muted">
                        {c.state === 'done' ? (c.account_name || '—') : ''}
                      </td>
                      <td>
                        {/* 소급분은 반드시 밝힌다 — 없으면 "그때부터 돌고 있었다"로 읽힌다 */}
                        {c.backfilled && <span className="badge outline" style={{ fontSize: 10 }}>소급</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="text-xs text-muted2" style={{ marginTop: 14, lineHeight: 1.7 }}>
              · 지난 회차는 <b>실제로 만들어진 것</b>을 그대로 보여줘요. 규칙의 금액을 나중에
              바꿔도 그때 나간 금액은 변하지 않아요.<br/>
              · 앞으로 올 회차는 {d.horizon_days}일까지만 보여줍니다.
            </div>
          </>)}
        </div>
        {/* 보는 것과 고치는 것을 가른다 — 예전엔 누르면 바로 편집이었다 */}
        {onEdit && (
          <div className="drawer-foot row">
            <button className="btn ml-auto" onClick={() => onEdit(rule)}>규칙 수정</button>
          </div>
        )}
      </>)}
    </Drawer>
  )
}
