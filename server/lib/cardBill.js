/**
 * 카드 대금 — 결제일·사용 구간·밀린 대금을 **한 곳에서** 계산한다.
 *
 * ── 왜 한 곳인가 ──
 * 같은 계산이 두 벌 있었다. 카드 대금 화면(브라우저 CardPayment.jsx billingWindow)과
 * 자금 예측(lib/cashReport.js 카드 결제 줄). 두 벌이면 언젠가 한쪽만 고쳐져 화면이 말하는
 * 결제 예정액과 자금표의 출금 예정액이 달라진다. 화면은 이제 GET /transactions/card-bills 로 받는다.
 *
 * ── 이 앱의 회차 모델 ──
 *   결제일 D 에 빠지는 돈 = **지난 결제일 다음날 ~ 이번 결제일**에 쓴 돈.
 *   (카드사마다 마감일이 결제일보다 앞서지만 그 차이는 회사마다 다르다 — 종이 명세서와 견줄 때
 *    사람이 본다. 화면은 구간을 그대로 적어 준다)
 *   결제일 31 = 말일. 짧은 달이면 그 달 마지막 날로 당긴다.
 *
 * ── 금액 셋 ──
 *   unpaid   미결제 합계 = 카드 잔액의 음수 쪽(기초 + 결제 − 사용). 결제분이 자동으로 빠진다.
 *   current  이번 회차 몫 = 이번 구간 사용액(단 미결제를 넘지 않는다)
 *   overdue  밀린 대금 = 미결제 − 이번 회차 몫. 지난 결제일에 빠졌어야 할 돈이다.
 *   (갚은 돈은 오래된 몫부터 지운 것으로 본다 — 카드사도 그렇게 처리한다)
 *
 * ⚠ 체크카드는 계산하지 않는다 — 쓴 즉시 통장에서 빠져 갚을 것이 없다.
 * ⚠ db 는 인자로만 받는다(멀티테넌트 — 기본값을 두면 남의 회사를 읽는다).
 */

const { SETTLED_INCOME, SETTLED_EXPENSE } = require('./ledger')

const pad = (n) => String(n).padStart(2, '0')

/** y년 m월(1~12)의 결제일 — 짧은 달이면 말일로 당긴다 */
const payDateOf = (y, m, payDay) => {
  const last = new Date(y, m, 0).getDate()
  return `${y}-${pad(m)}-${pad(Math.min(Number(payDay), last))}`
}

/** 'YYYY-MM-DD' 하루 뒤 */
const nextDay = (d) => {
  const [y, m, dd] = d.split('-').map(Number)
  const t = new Date(y, m - 1, dd + 1)
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

/**
 * 결제일 payDate 가 덮는 사용 구간 — 지난 결제일 다음날 ~ 이번 결제일.
 * @param y,m  payDate 의 연·월
 * @returns { payDate, prevPay, from, to }
 */
function cycleAt(y, m, payDay) {
  const payDate = payDateOf(y, m, payDay)
  const prev = new Date(y, m - 2, 1)
  const prevPay = payDateOf(prev.getFullYear(), prev.getMonth() + 1, payDay)
  return { payDate, prevPay, from: nextDay(prevPay), to: payDate }
}

/** 오늘 기준 **다가오는**(오늘 포함) 결제일의 회차 */
function upcomingCycle(payDay, today) {
  let [y, m] = today.split('-').map(Number)
  if (today > payDateOf(y, m, payDay)) { m += 1; if (m > 12) { m = 1; y += 1 } }
  return cycleAt(y, m, payDay)
}

const num = (v) => Number(v) || 0

/** 'YYYY-MM' 기준 k달 앞의 회차 */
const cycleBack = (cy, payDay, k) => {
  const [y, m] = cy.payDate.split('-').map(Number)
  const d = new Date(y, m - 1 - k, 1)
  return cycleAt(d.getFullYear(), d.getMonth() + 1, payDay)
}

/** 회차 하나의 상태 — 화면 칩 색이 여기서 정해진다 */
const statusOf = (c, today) => {
  if (c.used <= 0) return 'none'                       // 쓴 게 없다
  if (c.remain <= 0) return 'paid'                     // 다 냈다
  if (c.payDate >= today) return c.paid > 0 ? 'partial_due' : 'due'   // 아직 결제일 전(또는 오늘)
  return c.paid > 0 ? 'partial' : 'unpaid'             // 결제일이 지났는데 남았다
}

/* 회차 수 — **보여 주는 것**과 **세는 것**이 다르다(2026-10-02 사용자: "최근 3개월이면 된다. 밀린 달은 보여야 하고").
 *   SHOW_CYCLES  늘 보이는 회차 — 지난 2회 + 이번 회차
 *   CYCLES       회차로 나눠 세는 폭. 이 안에서 밀린 회차는 SHOW 밖이어도 보인다.
 *                이보다 오래 밀린 돈은 before_remain 한 덩어리로 낸다. */
const SHOW_CYCLES = 3
const CYCLES = 12

/**
 * 신용카드마다 최근 회차별 납부 상황과 지금 상태.
 *
 * ── 조회는 카드 수와 무관하게 **세 번** ──
 *   ① 카드 목록  ② 보는 구간 **이전** 합계(카드별 GROUP BY)  ③ 보는 구간 안 **날짜별** 합계(카드·날짜 GROUP BY)
 *   카드마다·회차마다 묻지 않는다 — 카드가 열 장이면 그것만으로 백 번이 된다. 회차 나누기와 갚은 돈 배분은
 *   메모리에서 한다. 낱건(사용 내역)은 화면이 회차를 열 때 그 회차만 따로 받는다.
 *
 * ── 갚은 돈은 **오래된 몫부터** 채운다(카드사도 그렇게 처리한다) ──
 *   기초 미결제 → 보는 구간 이전 사용 → 회차 순. 그래서 9월이 미납이면 10월에 낸 돈도 9월부터 채운다.
 *   환불·취소로 카드에 들어온 돈도 갚은 돈과 같이 센다(잔액 계산 routes/accounts.js 와 같은 식).
 *
 * @param today 'YYYY-MM-DD'(KST) — 부르는 쪽이 kstToday() 로 준다
 */
async function cardBills(db, today, { cycles: nCycles = CYCLES } = {}) {
  if (!db) throw new Error('cardBills: 테넌트 연결(db)이 필요합니다')
  const [cards] = await db.execute(
    `SELECT a.id, a.name, a.bank, a.\`number\`, a.owner, a.card_type, a.card_pay_day, a.card_pay_account_id,
            a.initial_balance, p.name AS pay_account_name
       FROM accounts a LEFT JOIN accounts p ON p.id = a.card_pay_account_id
      WHERE a.kind = 'card' AND COALESCE(a.card_type, 'credit') <> 'check'
      ORDER BY a.name`)
  if (!cards.length) return []

  // 카드마다 볼 회차(오래된 것 → 이번) — 결제일이 없으면 회차가 없다
  const plan = new Map()
  for (const c of cards) {
    const payDay = num(c.card_pay_day)
    if (!(payDay > 0)) { plan.set(c.id, []); continue }
    const up = upcomingCycle(payDay, today)
    plan.set(c.id, Array.from({ length: nCycles }, (_, i) => cycleBack(up, payDay, nCycles - 1 - i)))
  }
  // 모든 카드의 가장 이른 회차 시작 — ②·③ 의 경계(카드마다 다른 경계는 메모리에서 맞춘다)
  const firsts = [...plan.values()].filter(l => l.length).map(l => l[0].from)
  const minFrom = firsts.length ? firsts.sort()[0] : today
  const ids = cards.map(c => c.id)
  const ph = ids.map(() => '?').join(',')

  /* ⚠ 계좌 잔액(routes/accounts.js calcBalance)과 **같은 재료**로 센다 — 완료 상태만, 잔액 조정 포함.
     예전엔 상태를 안 걸러 '지급 예정' 카드 지출까지 갚을 돈이 됐고, 카드에 넣은 잔액 조정은 빠져
     카드 잔액과 미결제가 어긋났다(2026-10-02 검토) */
  const settled = `((kind = 'expense' AND status = ?) OR (kind = 'income' AND status = ?))`
  const [before] = await db.execute(
    `SELECT account_id,
            COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END), 0) AS owe,
            COALESCE(SUM(CASE WHEN kind = 'income'  THEN amount ELSE 0 END), 0) AS paid
       FROM transactions WHERE account_id IN (${ph}) AND ${settled} AND date < ? GROUP BY account_id`,
    [...ids, SETTLED_EXPENSE, SETTLED_INCOME, minFrom])
  const [daily] = await db.execute(
    `SELECT account_id, LEFT(date, 10) AS d,
            COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END), 0) AS owe,
            SUM(CASE WHEN kind = 'expense' THEN 1 ELSE 0 END) AS n,
            COALESCE(SUM(CASE WHEN kind = 'income'  THEN amount ELSE 0 END), 0) AS paid
       FROM transactions WHERE account_id IN (${ph}) AND ${settled} AND date >= ? GROUP BY account_id, LEFT(date, 10)`,
    [...ids, SETTLED_EXPENSE, SETTLED_INCOME, minFrom])
  // 잔액 조정 — 플러스는 갚은 돈처럼(미결제 ↓), 마이너스는 쓴 돈처럼(미결제 ↑). 그 날짜에 둔다
  const [adjs] = await db.execute(
    `SELECT account_id, LEFT(date, 10) AS d, COALESCE(SUM(amount), 0) AS amt
       FROM account_adjustments WHERE account_id IN (${ph}) GROUP BY account_id, LEFT(date, 10)`, ids)
  const beforeOf = new Map(before.map(r => [r.account_id, { owe: num(r.owe), paid: num(r.paid) }]))
  const dailyOf = new Map()
  for (const r of daily) { if (!dailyOf.has(r.account_id)) dailyOf.set(r.account_id, []); dailyOf.get(r.account_id).push(r) }
  for (const a of adjs) {
    const amt = num(a.amt); if (!amt) continue
    const owe = amt < 0 ? -amt : 0, paid = amt > 0 ? amt : 0
    if (a.d < minFrom) {
      const b = beforeOf.get(a.account_id) || { owe: 0, paid: 0 }
      beforeOf.set(a.account_id, { owe: b.owe + owe, paid: b.paid + paid })
    } else {
      if (!dailyOf.has(a.account_id)) dailyOf.set(a.account_id, [])
      dailyOf.get(a.account_id).push({ d: a.d, owe, paid, n: 0 })
    }
  }

  return cards.map(c => {
    const list = plan.get(c.id)
    const days = dailyOf.get(c.id) || []
    const b0 = beforeOf.get(c.id) || { owe: 0, paid: 0 }
    const init = num(c.initial_balance)
    const myFrom = list.length ? list[0].from : '9999-12-31'
    // 이 카드의 회차 이전에 진 빚 — 기초 미결제 + (전체 경계 이전) + (전체 경계 ~ 내 첫 회차 사이)
    let owedBefore = Math.max(0, -init) + num(b0.owe)
    let paidAll = Math.max(0, init) + num(b0.paid)
    for (const d of days) { paidAll += num(d.paid); if (d.d < myFrom) owedBefore += num(d.owe) }
    const cyc = list.map(cy => {
      const ds = days.filter(d => d.d >= cy.from && d.d <= cy.to)
      return { ...cy, used: ds.reduce((s, d) => s + num(d.owe), 0), count: ds.reduce((s, d) => s + num(d.n), 0) }
    })
    // 오래된 몫부터 채운다
    let left = paidAll
    const beforeRemain = Math.max(0, owedBefore - left); left = Math.max(0, left - owedBefore)
    for (const cy of cyc) {
      cy.paid = Math.min(cy.used, left); left -= cy.paid
      cy.remain = cy.used - cy.paid
      cy.status = statusOf(cy, today)
    }
    const up = cyc[cyc.length - 1] || null
    // 보이는 회차 — 최근 SHOW_CYCLES + 그보다 오래됐어도 **밀린** 회차(완납·사용 없음은 접는다)
    const shown = cyc.filter((x, i) => i >= cyc.length - SHOW_CYCLES || x.status === 'unpaid' || x.status === 'partial')
    const pastRemain = cyc.filter(x => x.payDate < today).reduce((s, x) => s + x.remain, 0)
    const unpaid = beforeRemain + cyc.reduce((s, x) => s + x.remain, 0)
    return {
      id: c.id, name: c.name, bank: c.bank, number: c.number, owner: c.owner, card_type: c.card_type || 'credit',
      pay_day: num(c.card_pay_day), pay_account_id: c.card_pay_account_id || null, pay_account_name: c.pay_account_name || null,
      // 결제일이 없는 카드는 회차를 못 세운다 — 미결제만 잔액으로 낸다
      // ⚠ 회차가 없으면 모든 사용이 owedBefore 에 들어 있다(myFrom 이 끝 날짜) — 기초잔액은 이미 양쪽에 반영됐다.
      //   예전 식은 init 을 한 번 더 더해 기초 −500,000 카드가 1,000,000 으로 나왔다(2026-10-02 검토)
      unpaid: list.length ? unpaid : Math.max(0, owedBefore - paidAll),
      cycles: shown,                   // 오래된 것 → 이번 회차(접힌 회차는 남은 돈이 0이다)
      cycle: up,                       // 이번(다가오는) 회차
      used: up ? up.used : 0, used_count: up ? up.count : 0, paid_in_cycle: up ? up.paid : 0,
      current: up && up.payDate >= today ? up.remain : 0,
      overdue: beforeRemain + pastRemain,
      before_remain: beforeRemain,     // 보이는 회차보다 더 오래 밀린 돈
      credit: left,                    // 더 낸 돈(카드에 남은 잔액)
    }
  })
}

module.exports = { cardBills, cycleAt, upcomingCycle, payDateOf, nextDay, statusOf, SHOW_CYCLES, CYCLES }
