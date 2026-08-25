import { useState, useEffect } from 'react'
import { fmtNum, Spacer, Loading } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { Kpi, KpiRow } from '../lib/components/Kpi'
import { api } from '../lib/api'

/* 경영 대시보드 — "얼마 중에 얼마가 들어왔고, 얼마나 기한이 지났나".
 *
 * ── 예전 화면 ──
 * '진행중 주문 상위' 라며 `contracts.filter(진행중).slice(0, 6)` 을 뿌렸다.
 * 정렬도 판정도 없어 **목록 앞 여섯 개**였다. 큰 계약이 뒤에 있으면 안 보이고,
 * 몇 달째 돈이 안 들어오는 계약과 어제 시작한 계약이 같은 모양으로 나란히 섰다.
 * 대표님이 보고 싶은 것은 그것이 아니었다.
 *
 * ── 지금 ──
 *   1. 회수 현황 — 주문금액 중 얼마를 청구했고 얼마가 들어왔나
 *   2. 손봐야 할 주문 — 오래 밀린 것부터. **이게 이 화면의 결론이다**
 *   3. 정상 진행 중인 큰 계약 — 금액 순
 *   4. 주기적으로 오가는 돈 — 월 환산
 *
 * ⚠ 판정은 전부 서버(lib/contractHealth.js)가 낸다. 화면에서 다시 세면 같은 계약이
 *   여기서는 정상, 주문 목록에서는 이상으로 뜬다. 회수 판정은 자금 쪽(lib/certainty.js)을
 *   그대로 재사용한다 — 자금일보에서 '기약 없다'고 한 돈이 여기서만 멀쩡할 수는 없다.
 */

/* 위험과 지켜보기를 같은 색으로 두면 "며칠 밀린 것"과 "반년째 안 들어오는 것"이
   나란히 노랗게 떠서 눈길이 흩어진다. 무게가 다르면 색도 달라야 한다. */
const HEALTH_BADGE = { risk: 'badge neg', watch: 'badge warn', ok: 'badge outline' }

/** 회수율 막대 — 숫자만 있으면 "얼마나 남았나"가 한눈에 안 들어온다 */
const RateBar = ({ rate, tone }) => {
  if (rate == null) return null
  const w = Math.max(0, Math.min(100, rate))
  return (
    <div style={{ height: 4, borderRadius: 2, background: 'var(--line)', marginTop: 5, overflow: 'hidden' }}>
      <div style={{ width: `${w}%`, height: '100%', background: tone || 'var(--pos)' }}/>
    </div>
  )
}

/* ⚠ 막대 색은 **회수 상태**만 말한다.
   health 를 그대로 칠했더니 회수 100%인 주문(종료 처리만 안 된 건)이 새빨갛게 떠서
   "돈을 못 받았다"로 읽혔다. 그 사실은 옆의 배지가 말한다 — 한 신호에 두 뜻을 담지 않는다. */
const rateTone = (c) =>
  c.overdueDays >= 90 ? 'var(--neg)' : c.overdueDays > 0 ? 'var(--warn)' : 'var(--pos)'

const ContractRow = ({ c, showIssues }) => (
  <div style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
    <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
      <span className="fw-600 text-sm" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {c.name}
      </span>
      {c.vendor && <span className="text-xs text-muted2">{c.vendor}</span>}
      <span className="num text-sm ml-auto" style={{ flexShrink: 0 }}>
        {fmtNum(c.collected)} <span className="text-muted2">/ {fmtNum(c.amount)}</span>
      </span>
    </div>
    <RateBar rate={c.rate} tone={rateTone(c)}/>
    <div className="row text-xs text-muted2" style={{ gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
      {c.rate != null && <span>회수 {c.rate}%</span>}
      {/* 아직 청구도 못 한 몫 — '못 받은 돈'과 원인이 달라 따로 적는다 */}
      {c.unbilled > 0 && <span>미청구 {fmtNum(c.unbilled)}원</span>}
      {c.remain > 0 && <span style={{ color: 'var(--warn-ink)' }}>못 받은 돈 {fmtNum(c.remain)}원</span>}
      {showIssues && c.overdueDays > 0 && (
        <span style={{ color: 'var(--neg-ink)' }}>{c.overdueDays}일 밀림</span>
      )}
      {showIssues && c.issueLabels.map(l => (
        <span key={l} className={HEALTH_BADGE[c.health] || 'badge'} style={{ fontSize: 10 }}>{l}</span>
      ))}
    </div>
  </div>
)

export const MgmtDashScreen = () => {
  const [d, setD] = useState(null)

  useEffect(() => {
    let alive = true
    api.getMgmtDash().then(x => { if (alive) setD(x) })
    return () => { alive = false }
  }, [])

  if (!d) return (
    <div className="fade-up"><PageHeader title="경영 대시보드"/><Loading label="주문 현황을 불러오는 중…"/></div>
  )

  const t = d.totals
  // 손봐야 할 것 — 오래 밀린 순. 이게 이 화면의 결론이라 맨 위에 크게 둔다.
  const trouble = d.contracts
    .filter(c => c.health !== 'ok')
    .sort((a, b) => b.overdueDays - a.overdueDays || b.remain - a.remain)
  // 정상 진행 중인 큰 계약 — 금액 순(예전엔 정렬조차 없었다)
  const healthy = d.contracts
    .filter(c => c.health === 'ok' && c.status === '진행중')
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6)

  return (
    <div className="fade-up">
      <PageHeader title="경영 대시보드"/>

      <KpiRow cols={4} style={{ marginBottom: 20 }}>
        <Kpi label="진행중 주문금액" value={t.amount} badge={`${t.liveCount}건`}/>
        <Kpi label="들어온 돈" value={t.collected} tone="pos"
          hint={t.amount > 0 ? `주문금액의 ${Math.round(t.collected / t.amount * 1000) / 10}%` : undefined}/>
        {/* 두 숫자를 갈라 둔다 — 원인이 다르다. 앞은 "청구했는데 안 들어온다",
            뒤는 "아직 청구를 못 했다". 합치면 무엇을 해야 할지 알 수 없다. */}
        <Kpi label="못 받은 돈" value={t.remain} tone="neg-ink" hint="청구했는데 안 들어온 돈"/>
        <Kpi label="아직 청구 안 한 돈" value={t.unbilled} hint="주문금액 − 청구액"/>
      </KpiRow>

      {/* 손봐야 할 주문 — 이 화면의 결론. 없으면 그리지 않는다 */}
      {trouble.length > 0 ? (
        <div className="card card-pad" style={{ marginBottom: 20 }}>
          <div className="row" style={{ marginBottom: 4, alignItems: 'baseline' }}>
            <div className="section-title">손봐야 할 주문</div>
            <span className="text-sm text-muted ml-auto">
              위험 {t.riskCount}건 · 지켜보기 {t.watchCount}건
            </span>
          </div>
          <div className="text-xs text-muted2" style={{ marginBottom: 6 }}>
            오래 밀린 순이에요. 기한이 지났거나, 종료일이 지났는데 진행중인 주문이에요.
          </div>
          {trouble.map(c => <ContractRow key={c.id} c={c} showIssues/>)}
        </div>
      ) : (
        /* 정상에는 표식을 달지 않는다는 규칙이 있지만, 이 화면은 **문제를 찾으러 오는 자리**다.
           빈 채로 두면 "아직 안 불러왔나"로 읽힌다. 한 줄로 끝낸다. */
        <div className="card card-pad text-sm text-muted" style={{ marginBottom: 20 }}>
          손봐야 할 주문이 없어요. 기한 지난 미수도, 종료일이 지난 진행중 주문도 없습니다.
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card card-pad">
          <div className="section-title" style={{ marginBottom: 4 }}>정상 진행 중인 큰 계약</div>
          <div className="text-xs text-muted2" style={{ marginBottom: 6 }}>주문금액 순이에요.</div>
          {healthy.length === 0
            ? <div className="text-sm text-muted2" style={{ padding: '12px 0' }}>진행중인 주문이 없어요.</div>
            : healthy.map(c => <ContractRow key={c.id} c={c}/>)}
        </div>

        <div className="card card-pad">
          <div className="section-title" style={{ marginBottom: 4 }}>주기적으로 오가는 돈</div>
          <div className="text-xs text-muted2" style={{ marginBottom: 10 }}>
            한 달치로 환산했어요(분기 ÷3, 년 ÷12). 주기가 섞여 있으면 그냥 더한 수는 뜻이 없어요.
          </div>
          {/* 규칙이 하나도 없으면 0원 세 줄 대신 한 줄로 — 빈 구획은 그리지 않는다 */}
          {!d.recurring.monthlyIn && !d.recurring.monthlyOut ? (
            <div className="text-sm text-muted2" style={{ padding: '12px 0' }}>
              등록된 정기입금·정기지급이 없어요.
            </div>
          ) : (<>
          <div className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
            <span className="text-sm">매달 들어올 돈 <span className="text-muted2">정기입금</span></span>
            <span className="num fw-700 ml-auto" style={{ color: 'var(--pos-ink)' }}>
              {fmtNum(d.recurring.monthlyIn)}원</span>
          </div>
          <div className="row" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
            <span className="text-sm">매달 나갈 돈 <span className="text-muted2">정기지급</span></span>
            <span className="num fw-700 ml-auto" style={{ color: 'var(--neg-ink)' }}>
              {fmtNum(d.recurring.monthlyOut)}원</span>
          </div>
          <div className="row" style={{ padding: '10px 0' }}>
            <span className="text-sm fw-700">남는 돈</span>
            <span className="num fw-700 ml-auto" style={{
              color: d.recurring.monthlyIn - d.recurring.monthlyOut < 0 ? 'var(--neg-ink)' : undefined,
            }}>{fmtNum(d.recurring.monthlyIn - d.recurring.monthlyOut)}원</span>
          </div>
          </>)}
        </div>
      </div>

      {/* 기약 없는 돈 — 자금 쪽과 같은 판정이다. 여기서도 밝혀야 회수율을 낙관하지 않는다 */}
      {t.uncertain > 0 && (
        <>
          <Spacer h={16}/>
          <div className="card card-pad text-sm text-muted">
            못 받은 돈 중 <b className="num" style={{ color: 'var(--neg-ink)' }}>{fmtNum(t.uncertain)}원</b>은
            {' '}<b>기약이 없어요</b>(기한 미정이거나 90일 넘게 밀린 건). 자금일보의 예측에서도 빠진 금액이에요.
          </div>
        </>
      )}
    </div>
  )
}
