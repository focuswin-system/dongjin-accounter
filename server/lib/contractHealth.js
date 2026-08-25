/**
 * 주문(수주)이 정상으로 굴러가고 있나 — 판정 한 곳.
 *
 * ── 왜 필요한가 ──
 * 경영 대시보드의 '진행중 주문 상위'는 `status === '진행중'` 을 `slice(0, 6)` 한 것이었다.
 * 정렬도 없고 판정도 없다 — **목록 앞 여섯 개**일 뿐이라 큰 계약이 뒤에 있으면 안 보이고,
 * 몇 달째 돈이 안 들어오는 계약과 어제 시작한 계약이 같은 모양으로 나란히 섰다.
 *
 * 대표님이 보고 싶은 것은 그것이 아니다:
 *   "얼마 중에 얼마가 들어왔고, 얼마나 기한이 지났나"
 *   "정상 진행 중인 큰 계약"과 "정상 진행이 안 되는 계약"
 *
 * ── ⚠ 판정은 여기 한 곳 ──
 * 화면마다 따로 세면 같은 계약이 대시보드에서는 정상, 주문 목록에서는 이상으로 뜬다.
 * 그러면 어느 쪽이 맞는지 알 방법이 없다.
 *
 * ── 회수 판정은 자금 쪽과 같은 것을 쓴다 ──
 * '기약 없는 돈'의 기준(lib/certainty.js)을 그대로 재사용한다. 두 벌로 두면 자금일보에서는
 * 기약 없다고 한 돈이 여기서는 멀쩡한 미수로 잡힌다.
 *
 * ── 매출 주문만 본다 ──
 * "얼마가 들어왔나"는 매출(수주) 개념이다. 매입 주문(발주)은 우리가 주는 쪽이라
 * 회수 현황이 성립하지 않는다.
 */

const { inflowCertainty, daysBetween, OVERDUE_UNCERTAIN_DAYS } = require('./certainty')

const num = (v) => Number(v) || 0
const day = (v) => String(v || '').slice(0, 10)

/* 끝났어야 하는데 안 끝난 계약 — 이만큼 지나면 '위험'으로 본다.
 * 30일: 한 달이 지나도록 종료 처리도, 추가 청구도 없다면 누군가 놓친 것이다.
 * 그 전(1~29일)은 마무리 중일 수 있어 '지켜보기'로 둔다. */
const ENDED_RISK_DAYS = 30

/** 판정 코드 → 사람 말. 화면과 서버가 같은 말을 쓰게 한 곳에 둔다. */
const ISSUE_LABEL = {
  long_overdue: '오래 밀린 미수',
  overdue: '기한 지난 미수',
  ended_open: '종료일이 지났는데 진행중',
}

/**
 * 매출 주문별 회수 현황과 건강 판정.
 * @param db     req.db (테넌트 풀)
 * @param today  'YYYY-MM-DD' (KST)
 */
async function contractHealth(db, today) {
  /* 주문 + 청구액 + 입금액. 청구액은 **발행 청구서**만 센다 —
     외주비 매입 청구서를 매출 주문에 귀속시키면 받을 돈이 아닌데 미수로 잡힌다
     (routes/contracts.js 의 PURCHASE_KIND 주석과 같은 이유). */
  const [rows] = await db.execute(`
    SELECT c.id, c.name, c.amount, c.status, c.start_date, c.end_date, c.contract_no,
           v.name AS vendor_name,
           COALESCE((SELECT SUM(i.total_amount) FROM invoices i
                      WHERE i.contract_id = c.id AND i.kind = 'issued'), 0) AS billed,
           COALESCE((SELECT SUM(m.amount) FROM invoice_matches m
                       JOIN invoices i2 ON i2.id = m.invoice_id
                      WHERE i2.contract_id = c.id AND i2.kind = 'issued'), 0) AS collected
      FROM contracts c
      LEFT JOIN vendors v ON v.id = c.vendor_id
     WHERE v.gubu = 'B'
     ORDER BY c.amount DESC`)
  if (!rows.length) return { contracts: [], totals: emptyTotals() }

  /* 미수 청구서를 한 번에 가져와 주문별로 나눈다.
     주문마다 조회하면 왕복이 주문 수만큼 늘어난다(N+1). */
  const ids = rows.map(r => r.id)
  const ph = ids.map(() => '?').join(',')
  const [open] = await db.execute(`
    SELECT i.id, i.contract_id, i.invoice_no, i.due_at, i.status, i.total_amount,
           COALESCE((SELECT SUM(amount) FROM invoice_matches WHERE invoice_id = i.id), 0) AS matched
      FROM invoices i
     WHERE i.contract_id IN (${ph}) AND i.kind = 'issued'
     ORDER BY i.due_at`, ids)

  const openBy = new Map()
  for (const inv of open) {
    const remain = num(inv.total_amount) - num(inv.matched)
    if (remain <= 0) continue        // 다 받은 청구서는 회수 현황에서 볼 일이 없다
    if (!openBy.has(inv.contract_id)) openBy.set(inv.contract_id, [])
    openBy.get(inv.contract_id).push({ ...inv, remain })
  }

  /* ⚠ '예정일이 지난 마일스톤인데 청구서가 없음'은 **신호로 쓰지 않는다.**
   *
   * 넣어 보고 걷어냈다. 단건 주문은 등록하는 순간 **시작일**을 예정일로 하는 마일스톤이
   * 자동 생성된다(routes/contracts.js — "청구가 누락되는 걸 막는다"). 시작일은 대개
   * 과거라, 아직 전액 청구하지 않은 주문이면 거의 다 이 신호가 뜬다.
   * 검증에서 주문 4건 중 4건에 붙었다 — **모두에게 뜨는 신호는 신호가 아니다.**
   *
   * 사용자가 세운 약속인지 자동 생성인지 구분할 플래그도 없다. 그리고 그 뜻은 이미
   * unbilled(아직 청구 안 한 돈)가 **금액까지 담아** 더 정확히 말한다. */

  const contracts = rows.map(c => {
    const amount = num(c.amount)
    const billed = num(c.billed)
    const collected = num(c.collected)
    const opens = openBy.get(c.id) || []

    // 가장 오래 밀린 청구서 — "얼마나 기한이 지났나"의 답이다
    let overdueDays = 0
    let uncertain = 0
    for (const inv of opens) {
      const due = day(inv.due_at)
      const cert = inflowCertainty({ status: inv.status, due, today })
      if (!cert.certain) uncertain += inv.remain
      if (due && due < today) overdueDays = Math.max(overdueDays, daysBetween(due, today))
    }

    const issues = []
    if (uncertain > 0 && overdueDays >= OVERDUE_UNCERTAIN_DAYS) issues.push('long_overdue')
    else if (overdueDays > 0) issues.push('overdue')

    const ended = c.status === '진행중' && c.end_date && day(c.end_date) < today
    const endedDays = ended ? daysBetween(day(c.end_date), today) : 0
    if (ended) issues.push('ended_open')

    /* 세 단계로 나눈다. 둘(정상/이상)로 나누면 "며칠 밀린 것"과 "반년째 안 들어오는 것"이
       같은 칸에 들어가 눈길이 흩어진다. */
    const health = (overdueDays >= OVERDUE_UNCERTAIN_DAYS || endedDays >= ENDED_RISK_DAYS)
      ? 'risk'
      : issues.length ? 'watch' : 'ok'

    return {
      id: c.id, name: c.name, contract_no: c.contract_no || '',
      vendor: c.vendor_name || '', status: c.status,
      start_date: day(c.start_date), end_date: day(c.end_date),
      amount,
      billed,                                  // 청구한 금액
      collected,                               // 실제로 들어온 금액
      remain: Math.max(0, billed - collected), // 청구했는데 못 받은 돈
      /* 아직 청구도 못 한 몫. 음수가 나올 수 있다(주문금액보다 더 청구한 경우 — 증액을
         주문에 반영 안 했을 때 흔하다). 0으로 자르면 그 사실이 사라지므로 그대로 둔다. */
      unbilled: amount - billed,
      // 주문금액 대비 회수율. 주문금액이 0이면 비율이 성립하지 않는다(—로 표시한다)
      rate: amount > 0 ? Math.round((collected / amount) * 1000) / 10 : null,
      overdueDays,
      uncertain,                               // 그중 기약 없는 몫(lib/certainty.js 기준)
      openCount: opens.length,
      health,
      issues,
      issueLabels: issues.map(k => ISSUE_LABEL[k]).filter(Boolean),
    }
  })

  const sum = (list, f) => list.reduce((s, x) => s + f(x), 0)
  const live = contracts.filter(c => c.status === '진행중')
  return {
    contracts,
    totals: {
      count: contracts.length,
      liveCount: live.length,
      amount: sum(live, c => c.amount),
      billed: sum(live, c => c.billed),
      collected: sum(live, c => c.collected),
      remain: sum(live, c => c.remain),
      unbilled: sum(live, c => c.unbilled),
      uncertain: sum(contracts, c => c.uncertain),
      riskCount: contracts.filter(c => c.health === 'risk').length,
      watchCount: contracts.filter(c => c.health === 'watch').length,
    },
  }
}

const emptyTotals = () => ({
  count: 0, liveCount: 0, amount: 0, billed: 0, collected: 0,
  remain: 0, unbilled: 0, uncertain: 0, riskCount: 0, watchCount: 0,
})

module.exports = { contractHealth, ISSUE_LABEL, ENDED_RISK_DAYS }
