const { Router } = require('express')
const { periodRange, periodSeries, periodLabel, UNITS } = require('../lib/period')
const { balancesAsOf, upcomingFlows } = require('../lib/cashReport')
const { SETTLED_INCOME, SETTLED_EXPENSE } = require('../lib/ledger')
const { kstToday } = require('../db')

const router = Router()

/* 자금 현황 — "이 기간에 돈이 얼마 들어오고 나가서, 얼마 남나".
 *
 * 자금일보(cash-report)와 같은 데이터를 쓰지만 **축이 다르다.**
 *   자금일보   오늘부터 N일 롤링. 실무자가 매일 아침 보는 화면.
 *   자금 현황  주·월·분기·년 구간. 대표가 "이 달/이 분기에 도나"를 보는 화면.
 * 산식을 두 벌로 두면 같은 회사 숫자가 화면마다 달라지므로 lib/cashReport.js 를 함께 쓴다.
 *
 * ── 지난 기간과 안 지난 기간은 성격이 다르다 ──
 *   확정  장부가 마감된 기간 → 실제로 들어온/나간 돈(거래 실적)
 *   잠정  지났지만 미마감    → 실적이지만 아직 입력 중일 수 있다
 *   예정  아직 안 온 기간    → 규칙·청구서에서 나온 예상
 * '지났다'만으로 확정이라 하면 안 된다 — 입력이 밀린 달도 지난 달이기 때문이다.
 * 그래서 확정의 근거는 **장부 마감**(closed_periods)으로 둔다.
 */

/** 구간이 마감됐는가 — 그 구간에 걸친 달이 **전부** 마감돼야 확정이다. */
async function closedState(db, from, to, today) {
  const months = []
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, m = 1) : m++) {
    months.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  if (!months.length) return 'planned'
  const ph = months.map(() => '?').join(',')
  const [rows] = await db.execute(
    `SELECT period FROM closed_periods WHERE period IN (${ph})`, months)
  const closed = new Set(rows.map(r => r.period))
  if (from > today) return 'planned'                       // 아직 안 온 구간
  if (months.every(m => closed.has(m))) return 'closed'    // 전부 마감 = 확정
  return to < today ? 'provisional' : 'current'            // 지났지만 미마감 / 진행 중
}

/** 그 구간에 **실제로 오간 돈**(거래 실적). 계좌별로 나눈다. */
async function actualsIn(db, from, to) {
  const [rows] = await db.execute(
    `SELECT account_id, kind, SUM(amount) AS total
       FROM transactions
      WHERE date BETWEEN ? AND ?
        AND ((kind = 'income' AND status = ?) OR (kind = 'expense' AND status = ?))
      GROUP BY account_id, kind`,
    [from, to, SETTLED_INCOME, SETTLED_EXPENSE])
  const by = new Map()
  let inSum = 0, outSum = 0
  for (const r of rows) {
    const key = r.account_id || ''
    if (!by.has(key)) by.set(key, { in: 0, out: 0 })
    const v = Number(r.total) || 0
    if (r.kind === 'income') { by.get(key).in += v; inSum += v } else { by.get(key).out += v; outSum += v }
  }
  return { by, in: inSum, out: outSum }
}

/**
 * GET /api/fund-status?unit=month&offset=0
 *
 * 한 구간의 자금 현황 + 앞뒤 구간 요약(한 눈에 보기).
 */
router.get('/', async (req, res, next) => {
  try {
    const unit = UNITS.includes(req.query.unit) ? req.query.unit : 'month'
    const offset = Math.max(-60, Math.min(60, parseInt(req.query.offset, 10) || 0))
    const today = kstToday()

    const [[cfg]] = await req.db.execute(
      "SELECT closing_day, week_start_day FROM company_info WHERE id = 'main'")
    const opt = {
      closingDay: cfg ? Number(cfg.closing_day) || 0 : 0,
      weekStart: cfg ? Number(cfg.week_start_day) : 1,
    }

    const range = periodRange(unit, today, offset, opt)
    const state = await closedState(req.db, range.from, range.to, today)

    /* 개인 계좌(대표 사비)는 마스터에게만. 계정 관리와 같은 방식(routes/auth.js isMaster). */
    const canSeePersonal = req.user?.role === 'admin'
    const all = await balancesAsOf(req.db, range.to)
    const accounts = (canSeePersonal ? all : all.filter(a => a.owner !== 'personal'))
      .filter(a => a.kind !== 'card')

    // 실적(그 구간에 실제로 오간 돈)과 예정(앞으로 오갈 돈)을 **함께** 낸다.
    // 지난 구간이면 예정이 비고, 미래 구간이면 실적이 빈다. 진행 중인 구간은 둘 다 있다.
    const actual = await actualsIn(req.db, range.from, range.to)
    /* 미래 구간은 연체·기한미정 돈을 끌어오지 않는다(anchorPast:false).
       끌어오면 같은 연체 청구서가 9월·10월·11월에 거듭 잡혀 나갈 돈이 누적된다.
       그 돈은 '지금' 몫이다 — 진행 중인 구간에서만 센다. */
    const future = range.from > today
    const planFrom = future ? range.from : today
    const flows = range.to < today ? []
      : (await upcomingFlows(req.db, { from: planFrom, to: range.to, anchorPast: !future }))

    const flowBy = new Map()
    let planIn = 0, planOut = 0
    for (const f of flows) {
      const key = f.account_id || ''
      if (!flowBy.has(key)) flowBy.set(key, { in: 0, out: 0, items: [] })
      const b = flowBy.get(key)
      if (f.kind === 'in') { b.in += f.amount; planIn += f.amount } else { b.out += f.amount; planOut += f.amount }
      b.items.push(f)
    }

    const byAccount = accounts.map(a => {
      const act = actual.by.get(a.id) || { in: 0, out: 0 }
      const pl = flowBy.get(a.id) || { in: 0, out: 0, items: [] }
      return {
        id: a.id, name: a.name, bank: a.bank, owner: a.owner, number: a.number,
        balance: a.balance,                       // 구간 끝 시점 잔액(실적 기준)
        actualIn: act.in, actualOut: act.out,
        planIn: pl.in, planOut: pl.out,
        expected: a.balance + pl.in - pl.out,     // 예정까지 반영한 예상 잔액
        items: pl.items,
      }
    })
    // 어느 계좌인지 모르는 예정(계좌 미지정 청구서 등)도 감춰선 안 된다 — 합계가 안 맞는다
    const unassigned = flowBy.get('') || { in: 0, out: 0, items: [] }

    const sum = (list, f) => list.reduce((s, x) => s + f(x), 0)
    const group = (owner) => {
      const list = byAccount.filter(a => a.owner === owner)
      return {
        accounts: list,
        balance: sum(list, a => a.balance),
        actualIn: sum(list, a => a.actualIn), actualOut: sum(list, a => a.actualOut),
        planIn: sum(list, a => a.planIn), planOut: sum(list, a => a.planOut),
        expected: sum(list, a => a.expected),
      }
    }

    res.json({
      unit, offset, today,
      range: { ...range, label: periodLabel(unit, range) },
      state,                       // closed | provisional | current | planned
      closingDay: opt.closingDay, weekStart: opt.weekStart,
      corp: group('corp'),
      personal: canSeePersonal ? group('personal') : null,
      canSeePersonal,
      unassigned,
      totals: {
        actualIn: actual.in, actualOut: actual.out,
        planIn, planOut,
        net: (actual.in - actual.out) + (planIn - planOut),
      },
    })
  } catch (e) { next(e) }
})

/**
 * GET /api/fund-status/series?unit=month&back=6&forward=6
 *
 * 구간을 한 줄씩 요약해 **한 화면에 늘어놓는다** — 엑셀은 시트를 넘겨야 보이던 것이다.
 * "어느 달에 구멍이 나나"가 스크롤 없이 보이는 게 이 화면의 값어치다.
 */
router.get('/series', async (req, res, next) => {
  try {
    const unit = UNITS.includes(req.query.unit) ? req.query.unit : 'month'
    const back = Math.max(0, Math.min(24, parseInt(req.query.back, 10) || 6))
    const forward = Math.max(0, Math.min(24, parseInt(req.query.forward, 10) || 6))
    const today = kstToday()

    const [[cfg]] = await req.db.execute(
      "SELECT closing_day, week_start_day FROM company_info WHERE id = 'main'")
    const opt = {
      closingDay: cfg ? Number(cfg.closing_day) || 0 : 0,
      weekStart: cfg ? Number(cfg.week_start_day) : 1,
    }

    const canSeePersonal = req.user?.role === 'admin'
    const all = await balancesAsOf(req.db, null)
    const owners = new Map(all.map(a => [a.id, a.owner]))
    const mine = (id) => canSeePersonal || owners.get(id) !== 'personal'

    const series = periodSeries(unit, today, { back, forward, ...opt })
    const out = []
    for (const p of series) {
      const state = await closedState(req.db, p.from, p.to, today)
      const actual = await actualsIn(req.db, p.from, p.to)
      let actualIn = 0, actualOut = 0
      for (const [id, v] of actual.by) {
        if (id && !mine(id)) continue
        actualIn += v.in; actualOut += v.out
      }
      let planIn = 0, planOut = 0
      if (p.to >= today) {
        const future = p.from > today
        const flows = await upcomingFlows(req.db, {
          from: future ? p.from : today, to: p.to, anchorPast: !future })
        for (const f of flows) {
          if (f.account_id && !mine(f.account_id)) continue
          if (f.kind === 'in') planIn += f.amount; else planOut += f.amount
        }
      }
      out.push({
        ...p, state,
        actualIn, actualOut, planIn, planOut,
        in: actualIn + planIn, out: actualOut + planOut,
        net: (actualIn + planIn) - (actualOut + planOut),
      })
    }
    res.json({ unit, today, closingDay: opt.closingDay, weekStart: opt.weekStart, series: out })
  } catch (e) { next(e) }
})

module.exports = router
