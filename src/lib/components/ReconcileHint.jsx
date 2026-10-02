import { useEffect, useState } from 'react'
import { Icon } from '../ui'
import { api } from '../api'
import { usePerms } from '../perms'

/* 업로드 다음 할 일 — 세금계산서와 통장 거래를 **둘 다** 올렸으면 둘을 이어야 한다(대사).
 *
 * 왜 — 과거 자료를 양쪽으로 올리면 세금계산서는 미수금, 통장 입금은 짝 없이 남는다. 그 미수금을 지우려고
 *   [입금 처리]를 누르면 입금을 **새로** 만들어 같은 돈이 두 줄 섰다(운영 fowin 2026-08, 10줄).
 *   이을 짝이 서버 판정(lib/reconcile.js)으로 있을 때만 띄운다 — 없는데 띄우면 안내가 소음이 된다.
 *
 * 세금계산서 권한이 없는 사람에게는 안 띄운다(묻지도 않는다 — 곁다리 호출의 403 이 '권한 없음' 알림으로 뜬다).
 * @param kinds  볼 방향 ['issued','received']
 * @param onGo   열기 전에 할 일(업로드 창 닫기 등)
 */
export const ReconcileHint = ({ goRoute, kinds = ['issued', 'received'], onGo }) => {
  const perms = usePerms()
  const allowed = kinds.filter(k => perms.can(k === 'issued' ? 'billing_issued' : 'billing_received', 'view'))
  const [counts, setCounts] = useState([])
  useEffect(() => {
    let alive = true
    Promise.all(allowed.map(k => api.getReconcile(k)))
      .then(rs => { if (alive) setCounts(allowed.map((k, i) => ({ kind: k, n: (rs[i]?.rows || []).length }))) })
    return () => { alive = false }
  }, [allowed.join(',')])   // eslint-disable-line react-hooks/exhaustive-deps

  const has = counts.filter(c => c.n > 0)
  if (!has.length || !goRoute) return null
  const label = (k) => (k === 'issued' ? '매출' : '매입')
  return (
    <div className="card card-pad row gap-12" style={{ alignItems: 'center', flexWrap: 'wrap', background: 'var(--brand-soft)', borderColor: 'transparent' }}>
      <Icon.Receipt size={20}/>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div className="fw-700 text-sm">세금계산서와 이을 {has.map(c => `${label(c.kind)} ${c.n}건`).join(' · ')}이 있어요</div>
        <div className="text-xs text-muted" style={{ marginTop: 2 }}>
          이어 주지 않으면 미수금·미지급금이 그대로 남아요. 입금 처리로 새로 넣으면 같은 돈이 두 번 잡혀요.
        </div>
      </div>
      <div className="row gap-6">
        {has.map(c => (
          <button key={c.kind} className="btn sm primary" onClick={() => {
            onGo?.()
            goRoute(c.kind === 'issued' ? 'billing_issued' : 'billing_received', { view: 'match' })
          }}>{label(c.kind)} 대사 열기</button>
        ))}
      </div>
    </div>
  )
}
