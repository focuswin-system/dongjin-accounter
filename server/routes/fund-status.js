const { Router } = require('express')
const { periodRange, periodSeries, periodLabel, UNITS, bucketsOf, dayBefore, BUCKET_OF } = require('../lib/period')
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

const {
  closedState, openingBalances, actualsIn,
  debtStatus, savingsStatus, laborStatus, incomingNoDate, canSeeLaborDetail,
} = require('../lib/fundStatus')

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
    const mine = new Set(accounts.map(a => a.id))
    const actual = await actualsIn(req.db, range.from, range.to, mine)
    /* 미래 구간은 연체·기한미정 돈을 끌어오지 않는다(anchorPast:false).
       끌어오면 같은 연체 청구서가 9월·10월·11월에 거듭 잡혀 나갈 돈이 누적된다.
       그 돈은 '지금' 몫이다 — 진행 중인 구간에서만 센다. */
    const future = range.from > today
    const planFrom = future ? range.from : today
    const flows = range.to < today ? []
      : (await upcomingFlows(req.db, { from: planFrom, to: range.to, anchorPast: !future }))

    /* ⚠ 확실/불확실을 자금일보와 **같은 규칙**으로 가른다(lib/certainty.js).
     *   들어올 돈이 불확실하면 예상 잔액에서 빼고, 나갈 돈은 불확실해도 넣는다.
     *   여기만 안 가르면 같은 회사 숫자가 자금일보와 자금현황에서 달라진다 —
     *   그러면 어느 쪽이 맞는지 알 방법이 없다. */
    const flowBy = new Map()
    let planIn = 0, planOut = 0, uncertainIn = 0, uncertainOut = 0
    for (const f of flows) {
      const key = f.account_id || ''
      // 실적과 같은 모집단이어야 KPI 와 계좌표 합계가 맞는다(카드·비관리자 개인 계좌 제외)
      if (key && !mine.has(key)) continue
      if (!flowBy.has(key)) flowBy.set(key, { in: 0, out: 0, items: [], uncertainIn: 0 })
      const b = flowBy.get(key)
      b.items.push(f)
      if (f.kind === 'in') {
        if (f.certain === false) { b.uncertainIn += f.amount; uncertainIn += f.amount; continue }
        b.in += f.amount; planIn += f.amount
      } else {
        if (f.certain === false) uncertainOut += f.amount
        b.out += f.amount; planOut += f.amount
      }
    }

    /* 미래 구간의 '예상 잔액'은 **오늘~구간 시작 사이에 나갈 돈**도 빼야 한다.
     * 거래는 미래 날짜로 못 넣으므로 balance 는 사실상 오늘 잔액이다. 그 사이의 급여·카드값을
     * 안 빼면 9월 화면이 8/25 급여를 안 뺀 잔액에서 출발한다(실물 4,000만 과대).
     * 그 다리 구간에서는 연체·기한미정도 센다 — 지금 몫의 돈이다. */
    const bridge = new Map()
    if (future) {
      const pre = await upcomingFlows(req.db, { from: today, to: dayBefore(range.from), anchorPast: true })
      for (const f of pre) {
        const k = f.account_id || ''
        if (k && !mine.has(k)) continue
        // 다리 구간에서도 불확실한 유입은 안 센다 — 본 구간과 기준이 달라지면 안 된다
        if (f.kind === 'in' && f.certain === false) continue
        bridge.set(k, (bridge.get(k) || 0) + (f.kind === 'in' ? f.amount : -f.amount))
      }
    }
    const byAccount = accounts.map(a => {
      const act = actual.by.get(a.id) || { in: 0, out: 0 }
      const pl = flowBy.get(a.id) || { in: 0, out: 0, items: [] }
      const pre = bridge.get(a.id) || 0
      return {
        id: a.id, name: a.name, bank: a.bank, owner: a.owner, number: a.number,
        balance: a.balance,                       // 구간 끝 시점 잔액(실적 기준)
        actualIn: act.in, actualOut: act.out,
        planIn: pl.in, planOut: pl.out, uncertainIn: pl.uncertainIn || 0,
        // 예정까지 반영한 예상 잔액. 미래 구간이면 오늘~구간 시작 사이 예정(pre)도 뺀다.
        expected: a.balance + pre + pl.in - pl.out,
        items: pl.items,
      }
    })
    const bridgeUnassigned = bridge.get('') || 0
    // 어느 계좌인지 모르는 예정(계좌 미지정 청구서 등)도 감춰선 안 된다 — 합계가 안 맞는다
    const un0 = flowBy.get('') || { in: 0, out: 0, items: [] }
    /* 계좌 미지정 예정도 미래 구간이면 다리 구간 몫을 함께 낸다 —
       화면의 '현금 과부족'이 계좌표의 '기간 말 예상'과 같은 기준이어야 한다. */
    const unassigned = { ...un0, bridge: bridgeUnassigned }

    const sum = (list, f) => list.reduce((s, x) => s + f(x), 0)
    const group = (owner) => {
      const list = byAccount.filter(a => a.owner === owner)
      return {
        accounts: list,
        balance: sum(list, a => a.balance),
        actualIn: sum(list, a => a.actualIn), actualOut: sum(list, a => a.actualOut),
        planIn: sum(list, a => a.planIn), planOut: sum(list, a => a.planOut),
        uncertainIn: sum(list, a => a.uncertainIn),
        expected: sum(list, a => a.expected),
      }
    }

    /* ── 엑셀 아래쪽 블록들 ──
     * 대표 자금표는 계좌만 보지 않는다. 부채·저축·미지급 인건비·입금예정을 한 장에 놓고
     * 마지막에 '자산 합계 / 현금 과부족'을 낸다. 그 구성을 그대로 낸다. */
    const debts = await debtStatus(req.db)
    const savings = await savingsStatus(req.db)
    const labor = await laborStatus(req.db)
    // 합계는 자금 판단에 필요하다. 이름별 명세는 인사 권한이 있어야 본다.
    if (!canSeeLaborDetail(req)) labor.items = []
    const incoming = await incomingNoDate(req.db, today)

    res.json({
      unit, offset, today,
      range: { ...range, label: periodLabel(unit, range) },
      debts, savings, labor, incoming,
      state,                       // closed | provisional | current | planned
      closingDay: opt.closingDay, weekStart: opt.weekStart,
      corp: group('corp'),
      personal: canSeePersonal ? group('personal') : null,
      canSeePersonal,
      unassigned,
      totals: {
        actualIn: actual.in, actualOut: actual.out,
        planIn, planOut,
        /* 기약 없는 몫 — 계산에서 뺀 것을 감추지 않는다.
           planIn 은 확실한 것만이라, 화면이 "그 밖에 얼마가 걸려 있다"를 말할 수 있어야 한다. */
        uncertainIn, uncertainOut,
        net: (actual.in - actual.out) + (planIn - planOut),
      },
    })
  } catch (e) { next(e) }
})

/**
 * GET /api/fund-status/timeline?unit=month&offset=0
 *
 * **며칠에 어느 통장이 비나.** 이 화면이 답해야 할 진짜 질문이다.
 *
 * 구간 합계로는 답이 안 나온다 — 월말에 흑자여도 25일 급여일에 통장이 비면
 * 그 날 이체가 안 나가고, 그건 돈이 없는 것과 같다. 그래서 구간을 한 칸 잘게 쪼개
 * (월→일자, 분기→주, 년→월) **계좌별 잔액이 시간을 따라 어떻게 움직이는지** 낸다.
 *
 * 실적과 예정을 한 축에 놓는다. 오늘 이전은 실제로 오간 돈, 오늘 이후는 예정이다.
 * 둘을 나눠 그리면 "어제까지는 실적표, 내일부터는 예측표" 두 장을 눈으로 이어야 한다.
 */
router.get('/timeline', async (req, res, next) => {
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
    const buckets = bucketsOf(unit, range, opt)

    const canSeePersonal = req.user?.role === 'admin'
    // 축과 같은 규칙(기한 미정·연체 제외)으로 다리 구간을 반영해야 구간이 이어진다
    const all = await openingBalances(req.db, { from: range.from, today, datedOnly: true })
    const accounts = (canSeePersonal ? all : all.filter(a => a.owner !== 'personal'))
      .filter(a => a.kind !== 'card')
    const mine = new Set(accounts.map(a => a.id))
    const acctName = new Map(accounts.map(a => [a.id, a.name]))

    // 구간 안에서 실제로 오간 돈 — 날짜·계좌별
    const [txns] = await req.db.execute(
      `SELECT t.date, t.account_id, t.kind, t.amount, t.category, t.memo, v.name AS vendor_name
         FROM transactions t LEFT JOIN vendors v ON v.id = t.vendor_id
        WHERE t.date BETWEEN ? AND ?
          AND ((t.kind = 'income' AND t.status = ?) OR (t.kind = 'expense' AND t.status = ?))
        ORDER BY t.date`,
      [range.from, range.to, SETTLED_INCOME, SETTLED_EXPENSE])

    /* 예정은 '오늘부터'만 센다. 지난 구간이면 예정이 없고(이미 실적으로 확정), 미래 구간이면
       연체·기한미정 돈을 끌어오지 않는다(anchorPast:false) — 끌어오면 같은 연체가 달마다 다시 잡힌다. */
    const future = range.from > today
    const flows = range.to < today ? []
      : await upcomingFlows(req.db, { from: future ? range.from : today, to: range.to, anchorPast: !future })

    // 한 축에 올린다: 실적 → 예정
    const events = [
      ...txns.filter(t => !t.account_id || mine.has(t.account_id)).map(t => ({
        date: t.date, account_id: t.account_id || null,
        kind: t.kind === 'income' ? 'in' : 'out', amount: Number(t.amount) || 0,
        label: `${t.vendor_name || t.category || '거래'}`, source: t.category || '거래', actual: true,
      })),
      ...flows.filter(f => !f.account_id || mine.has(f.account_id)).map(f => ({ ...f, actual: false })),
    ]

    /* ⚠ **기한을 모르는 돈은 날짜축에 올리지 않는다.**
     *
     * 미지급 급여·퇴직금처럼 "언젠가 나갈 건 확실한데 언제인지 모르는" 돈은 upcomingFlows 가
     * 기준일(오늘)로 몰아 세운다 — 합계를 낼 때는 낙관 쪽으로 안 틀리려는 옳은 규칙이다.
     * 그런데 **날짜별 표**에 그대로 올리면 실물에서 1억 8,566만이 오늘 하루에 꽂혀,
     * 그 뒤 모든 날의 잔액이 −1.4억으로 덮여 "며칠에 어느 통장이 비나"가 통째로 안 보였다.
     * 이 표의 존재 이유가 사라진다. 그래서 날짜 있는 것만 축에 올리고, 기한 미정은
     * **따로 한 줄로** 낸다(금액을 감추는 게 아니라 자리를 옮기는 것이다).
     *
     * **연체(overdue)도 같이 뺀다.** 연체는 "그 날 나간다"가 아니라 "이미 지났는데 아직
     * 안 나갔다"는 뜻이다. 합계를 낼 때는 기준일로 끌어오는 게 맞지만(안 나간 건 사실이니),
     * 날짜별 표에서 오늘 칸에 몰면 오늘 잔액이 실제와 달라지고 그 뒤가 전부 어긋난다.
     * 실물에서 몇 년치 밀린 급여 1억 1,214만이 오늘 하루에 꽂혀 8월 흐름을 통째로 덮었다.
     * 대표 자금표도 밀린 급여·퇴직금은 '지급예정'이 아니라 **별도 블록**에 둔다. */
    const offAxis = (e) => e.noDue || e.overdue
    const dated = events.filter(e => !offAxis(e))
    const undatedItems = events.filter(offAxis)
    /* ⚠ 이 버킷과 '기약 없는 돈'은 **뜻이 다르다.**
     *   여기: 날짜축에 못 올린 것 전부(며칠 밀린 것도 포함) — 표 레이아웃 때문에 뺀 것
     *   저기: 90일 넘게 밀렸거나 기한이 없는 것 — 판정 때문에 예측에서 뺀 것
     * 둘 다 "뺐다"고 말하는데 뺀 곳이 달라서, 숫자가 나란히 뜨면 "왜 다르지"가 된다.
     * 그래서 이 안에서 판정 몫이 얼마인지도 함께 낸다 — 두 숫자의 관계를 그 자리에서 밝힌다. */
    const undated = {
      in: undatedItems.filter(e => e.kind === 'in').reduce((s, e) => s + e.amount, 0),
      out: undatedItems.filter(e => e.kind === 'out').reduce((s, e) => s + e.amount, 0),
      uncertainIn: undatedItems.filter(e => e.kind === 'in' && e.certain === false)
        .reduce((s, e) => s + e.amount, 0),
      items: undatedItems.map(e => ({
        kind: e.kind, amount: e.amount, label: e.label, source: e.source,
        overdue: !!e.overdue, noDue: !!e.noDue,
        // 왜 기약이 없는지 — 목록을 펼쳤을 때 그 줄에 적는다
        certain: e.certain !== false, uncertainReason: e.uncertainReason || '',
        account_id: e.account_id, account_name: e.account_id ? (acctName.get(e.account_id) || null) : null,
      })),
    }

    const blank = () => ({ in: 0, out: 0 })
    /* 원래부터 마이너스인 통장(마이너스 통장·한도 대출 계좌)은 '모자라게 된' 게 아니다.
       매일 붉게 칠하면 진짜 신호가 묻히므로 부족 판정에서 뺀다. */
    const chronicNeg = new Set(accounts.filter(a => a.balance < 0).map(a => a.id))
    // 계좌별 누적 잔액 — 구간 시작 전날 잔액에서 출발한다
    const running = new Map(accounts.map(a => [a.id, a.balance]))
    let runningUnassigned = 0

    const out = buckets.map(b => {
      const inBucket = dated.filter(e => e.date >= b.from && e.date <= b.to)
      const byAccount = {}
      for (const a of accounts) byAccount[a.id] = blank()
      const un = blank()
      for (const e of inBucket) {
        const t = e.account_id ? byAccount[e.account_id] : un
        if (!t) continue
        t[e.kind] += e.amount
      }
      for (const a of accounts) {
        const v = byAccount[a.id]
        running.set(a.id, running.get(a.id) + v.in - v.out)
        v.balance = running.get(a.id)
      }
      runningUnassigned += un.in - un.out
      un.balance = runningUnassigned

      const sum = (f) => accounts.reduce((s, a) => s + f(byAccount[a.id]), 0)
      return {
        ...b,
        in: sum(v => v.in) + un.in,
        out: sum(v => v.out) + un.out,
        byAccount, unassigned: un,
        /* 합계에는 **계좌 미지정도 넣는다.**
         * 안 넣으면 그 줄의 '들어온·올 − 나간·갈'과 합계 증감이 안 맞는다 — 실제로
         * 순 −3,427만이 오간 날 합계가 +3,573만 올라가 있었다(급여·퇴직금 7,000만이
         * 어느 통장 열에도 못 들어가 통째로 증발). 어느 통장에서 나갈지 모를 뿐,
         * 나가는 건 확실한 돈이다. */
        balance: sum(v => v.balance) + runningUnassigned,
        // 통장 열의 합만 따로도 낸다(계좌 열들과 세로로 더해 맞춰볼 수 있게)
        accountBalance: sum(v => v.balance),
        moved: inBucket.length > 0,
        /* 그 날 **바닥난 통장**. 합계가 플러스여도 특정 통장이 비면 그 날 이체가 안 나간다 —
           달력은 칸 하나에 합계만 적을 수 있어서, 이걸 따로 안 주면 "합계는 +800만인데
           경남8381은 −1,200만"인 날이 흰 칸으로 지나간다. */
        shortAccounts: accounts
          .filter(a => !chronicNeg.has(a.id) && byAccount[a.id].balance < 0)
          .map(a => ({ id: a.id, name: a.name, owner: a.owner, balance: byAccount[a.id].balance })),
        // 지났는가 — 화면이 실적/예정을 색으로 가른다
        past: b.to < today,
        items: inBucket.map(e => ({
          date: e.date, account_id: e.account_id, kind: e.kind, amount: e.amount,
          // 어느 통장으로 오가는지 — 펼쳤을 때 이게 없으면 "이 돈이 어디로?"에 답을 못 한다
          account_name: e.account_id ? (acctName.get(e.account_id) || null) : null,
          label: e.label, source: e.source, actual: e.actual,
          overdue: !!e.overdue, noDue: !!e.noDue,
        })),
      }
    })

    /* 모자라는 시점 — 이 문서의 결론이다. 표를 훑지 않아도 맨 위에서 바로 보이게 따로 낸다.
       **처음 마이너스가 되는 순간**만 잡는다(그 뒤로 계속 마이너스면 같은 사건이다). */
    const shortfalls = []
    const firstNeg = (name, pick, opening, opts = {}) => {
      /* 처음부터 마이너스인 통장(마이너스 통장·가수금 계좌)은 '모자라게 된' 게 아니다.
         그걸 경고에 올리면 매달 같은 줄이 떠서 진짜 경고가 묻힌다 — 이미 음수면 건너뛴다. */
      let prevNeg = opening < 0
      for (const b of out) {
        const v = pick(b)
        if (v < 0 && !prevNeg) {
          /* **어느 통장에서 옮기면 되나.**
           *
           * "8/15에 급여통장이 1,200만 모자랍니다"까지만 말하면 절반이다 — 경리가 다음에
           * 하는 일은 '어느 통장에서 끌어올까'를 찾는 것이고, 그러려면 표를 가로로 훑어야 했다.
           * 그 시점에 여유가 있는 통장을 많은 순으로 함께 낸다.
           * 법인·개인을 갈라 적는다 — 대표 개인 통장에서 넣는 건 가수금이라 성격이 다르다. */
          const cover = opts.self === undefined ? [] : accounts
            .filter(a => a.id !== opts.self && b.byAccount[a.id].balance > 0)
            .map(a => ({ id: a.id, name: a.name, owner: a.owner, balance: b.byAccount[a.id].balance }))
            .sort((x, y) => y.balance - x.balance)
            .slice(0, 4)
          shortfalls.push({
            accountId: opts.self ?? null, accountName: name, owner: opts.owner || null,
            date: b.to, label: b.label, balance: v, need: -v, cover,
          })
        }
        prevNeg = v < 0
      }
    }
    for (const a of accounts) {
      firstNeg(a.name, b => b.byAccount[a.id].balance, a.balance, { self: a.id, owner: a.owner })
    }
    /* 통장별로는 다 플러스인데 **합계가 마이너스**인 경우가 있다 — 계좌를 안 정한 급여·퇴직금이
       클 때다. 그걸 안 잡으면 "통장은 다 괜찮은데 실제로는 돈이 모자란" 상태를 놓친다. */
    firstNeg('전체(계좌 미지정 포함)', b => b.balance,
      accounts.reduce((s, a) => s + a.balance, 0))

    res.json({
      unit, bucketUnit: BUCKET_OF[unit], offset, today,
      weekStart: opt.weekStart,          // 달력으로 그릴 때 주 시작 요일이 필요하다
      range: { ...range, label: periodLabel(unit, range) },
      accounts: accounts.map(a => ({ id: a.id, name: a.name, owner: a.owner, opening: a.balance })),
      buckets: out,
      undated,          // 기한을 모르는 돈 — 날짜축에 못 올린다
      shortfalls,
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
    /* 기본값이 앞뒤 6칸이던 것을 **보고 있는 구간 + 다음 한 칸**으로 줄였다.
       고른 달과 상관없는 13줄이 첫 화면을 통째로 먹고, 그중 절반은 거래가 없어 '—' 였다. */
    const back = Math.max(0, Math.min(24, parseInt(req.query.back, 10) || 0))
    // ⚠ parseInt 는 없으면 NaN 이라 ?? 로는 안 걸린다(NaN ?? 1 === NaN) — 0 을 보내는 것도 뜻이 있다
    const fw = parseInt(req.query.forward, 10)
    const forward = Math.max(0, Math.min(24, Number.isFinite(fw) ? fw : 1))
    const base = Math.max(-60, Math.min(60, parseInt(req.query.offset, 10) || 0))
    const today = kstToday()

    const [[cfg]] = await req.db.execute(
      "SELECT closing_day, week_start_day FROM company_info WHERE id = 'main'")
    const opt = {
      closingDay: cfg ? Number(cfg.closing_day) || 0 : 0,
      weekStart: cfg ? Number(cfg.week_start_day) : 1,
    }

    const canSeePersonal = req.user?.role === 'admin'
    const all = await balancesAsOf(req.db, null)
    /* 카드 계좌도 뺀다 — `/` 와 같은 모집단이어야 같은 구간에서 같은 숫자가 나온다.
       예전엔 개인만 걸러, 카드 사용액이 series 에만 들어가 offset=0 줄과 상단 KPI 가 어긋났다. */
    const shown = new Map(all.map(a => [a.id, a]))
    const mine = (id) => {
      const a = shown.get(id)
      if (!a) return true                       // 계좌 미지정은 그대로 센다
      if (a.kind === 'card') return false
      return canSeePersonal || a.owner !== 'personal'
    }

    const series = periodSeries(unit, today, { back, forward, base, ...opt })
    const out = []
    for (const p of series) {
      const state = await closedState(req.db, p.from, p.to, today)
      const actual = await actualsIn(req.db, p.from, p.to, new Set(all.filter(a => mine(a.id)).map(a => a.id)))
      let actualIn = 0, actualOut = 0
      for (const [id, v] of actual.by) {
        if (id && !mine(id)) continue
        actualIn += v.in; actualOut += v.out
      }
      /* ⚠ 여기도 확실/불확실을 가른다. 안 가르면 **같은 화면 안에서 모순**이 난다 —
         구간 비교는 '들어올 1,200만'인데 그 아래 요약은 '들어올 100만'으로 찍혔다.
         판정은 위 목록·자금일보·홈과 같은 곳(lib/certainty.js)을 쓴다. */
      let planIn = 0, planOut = 0, uncertainIn = 0, uncertainOut = 0
      if (p.to >= today) {
        const future = p.from > today
        const flows = await upcomingFlows(req.db, {
          from: future ? p.from : today, to: p.to, anchorPast: !future })
        for (const f of flows) {
          if (f.account_id && !mine(f.account_id)) continue
          if (f.kind === 'in') {
            if (f.certain === false) { uncertainIn += f.amount; continue }
            planIn += f.amount
          } else {
            if (f.certain === false) uncertainOut += f.amount
            planOut += f.amount
          }
        }
      }
      out.push({
        ...p, state,
        actualIn, actualOut, planIn, planOut, uncertainIn, uncertainOut,
        in: actualIn + planIn, out: actualOut + planOut,
        net: (actualIn + planIn) - (actualOut + planOut),
      })
    }
    res.json({ unit, today, closingDay: opt.closingDay, weekStart: opt.weekStart, series: out })
  } catch (e) { next(e) }
})

module.exports = router
