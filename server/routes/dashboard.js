const { Router } = require('express')
const { kstDate, kstToday } = require('../db')
const { pendingCond } = require('../lib/invoiceStatus')
const { balancesAsOf, upcomingFlows, project, projectByAccount, dailyTrial } = require('../lib/cashReport')
const { paidPrincipal } = require('../lib/savings')
const { remainingPrincipal } = require('../lib/loan')

const router = Router()

/* 홈 요약 · 자금일보 · 일계표.
 *
 * ⚠ 이 파일은 한동안 죽어 있었다 — 프런트에서 아무도 부르지 않았고, pendingCond import 가
 *   빠져 있어 호출되면 바로 터졌다. 게다가 잔액 산식이 routes/accounts.js 와 달라
 *   (수입에 status 조건이 없었다) 살아났더라도 화면마다 잔액이 다르게 나왔을 것이다.
 *   지금은 집계 로직을 lib/cashReport.js 한 곳에 두고 accounts.js 와 같은 산식을 쓴다.
 *
 * ⚠ 멀티테넌트 — req.db 로만 질의한다.
 */

const num = (v) => Number(v) || 0

/** 미수/미지급 잔액 합계 — 이미 정산된 부분을 뺀 '남은 돈' */
async function openInvoiceTotal(db, kind) {
  const cond = pendingCond(kind)
  const [[r]] = await db.execute(`
    SELECT COALESCE(SUM(i.total_amount), 0) AS total,
           COALESCE(SUM((SELECT COALESCE(SUM(amount),0) FROM invoice_matches WHERE invoice_id = i.id)), 0) AS matched,
           COUNT(*) AS cnt
      FROM invoices i
     WHERE i.kind = ? AND ${cond.sql}`, [kind, ...cond.params])
  return { total: num(r.total) - num(r.matched), count: Number(r.cnt) }
}

/** 묶인 자금 — 예적금에 들어가 있어 당장 못 쓰는 돈 */
async function lockedFunds(db) {
  const [rows] = await db.execute("SELECT * FROM savings WHERE status='active'")
  let total = 0
  const items = []
  for (const s of rows) {
    const [pays] = await db.execute(
      'SELECT amount FROM savings_payments WHERE savings_id = ? AND paid_date IS NOT NULL', [s.id])
    const bal = paidPrincipal(s, pays)
    total += bal
    items.push({ id: s.id, name: s.name, bank: s.bank, kind: s.kind, balance: bal, maturity_date: s.maturity_date })
  }
  return { total, items }
}

/** 차입 잔여 원금 */
async function loanRemaining(db) {
  const [loans] = await db.execute("SELECT id, name, principal FROM loans WHERE status='active'")
  let total = 0
  for (const l of loans) {
    /* paid_date 를 함께 뽑아야 한다 — remainingPrincipal 은 **낸 회차만** 세는데(lib/loan.js),
       이 열이 없으면 모든 행이 걸러져 차감이 0이 된다. 아무리 갚아도 잔여가 원금 전액으로
       남아, 같은 차입금이 홈 화면과 자금 현황에서 다른 금액으로 나왔다. */
    const [reps] = await db.execute(
      'SELECT principal, paid_date FROM loan_repayments WHERE loan_id = ?', [l.id])
    total += remainingPrincipal(l.principal, reps)
  }
  return { total, count: loans.length }
}

/**
 * 자금일보.
 *
 * @query date  기준일(기본 오늘). 과거 날짜를 주면 그날 시점으로 되짚는다.
 * @query days  앞으로 며칠까지 볼지(기본 30). 자금 압박은 보통 한 달 안에 드러난다.
 */
router.get('/cash-report', async (req, res, next) => {
  try {
    const date = req.query.date || kstToday()
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 180)
    const to = kstDate(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000 - 9 * 3600 * 1000)

    const all = await balancesAsOf(req.db, date)
    /* 개인 계좌(대표 사비)는 **마스터에게만** 보인다.
     * 회계 데이터가 아니라 대표 개인 자금이라, 실무자 화면에 잔고가 뜨면 안 된다.
     * 계정 관리와 같은 방식으로 가른다(users.role='admin' — routes/auth.js isMaster). */
    const canSeePersonal = req.user?.role === 'admin'
    const accounts = canSeePersonal ? all : all.filter(a => a.owner !== 'personal')

    // 가용 자금 = 통장에 있어 당장 쓸 수 있는 돈. 카드는 결제수단이지 보유 자금이 아니다.
    // **법인 것만** 센다 — 개인 돈을 섞으면 "회사에 얼마 있나"가 부풀려진다.
    const cash = accounts.filter(a => a.kind !== 'card')
    const available = cash.filter(a => a.owner === 'corp').reduce((s, a) => s + a.balance, 0)
    const availablePersonal = cash.filter(a => a.owner === 'personal').reduce((s, a) => s + a.balance, 0)

    const [locked, loan, ar, ap, flows] = await Promise.all([
      lockedFunds(req.db),
      loanRemaining(req.db),
      openInvoiceTotal(req.db, 'issued'),
      openInvoiceTotal(req.db, 'received'),
      upcomingFlows(req.db, { from: date, to }),
    ])

    res.json({
      date, days, to,
      accounts,
      available,                    // 지금 쓸 수 있는 돈
      locked: locked.total,         // 예적금에 묶인 돈
      lockedItems: locked.items,
      totalAssets: available + locked.total,
      loanRemaining: loan.total,
      loanCount: loan.count,
      receivable: ar,               // 받을 돈
      payable: ap,                  // 나갈 돈
      // 앞으로 N일 — 이 문서의 결론은 forecast.lowest 다("며칠에 얼마까지 떨어지나")
      forecast: project(available, flows, { from: date, to }),
      /* 계좌별 예측 — 합계만 보면 "어느 통장이 부족한지"를 알 수 없다.
         카드는 보유 자금이 아니라 결제수단이므로 뺀다(available 과 같은 기준). */
      byAccount: projectByAccount(cash, flows, { from: date, to }),
      // 개인 계좌 합계 — 화면이 법인과 나눠 보여준다(엑셀의 <법인>/<개인> 구분과 같다)
      availablePersonal,
      canSeePersonal,
    })
  } catch (e) { next(e) }
})

/** 일계표 — 하루치 거래를 계정과목별 차변/대변으로.
 *
 * 청구서 발행 분개를 함께 셀지는 회사가 정한다(report_prefs 'voucher_issuance').
 * 기본은 **켜짐** — 발행분이 빠지면 외상매출금이 생긴 적 없이 사라지고 매출 계정이
 * 한 번도 안 찍혀 장부가 성립하지 않는다. 다만 "은행 기준으로만 전표를 끊는" 회사는
 * 발행분이 섞이면 낯설어서, 끌 수 있게 둔다(report_prefs 규약대로 행이 없으면 켜짐). */
router.get('/daily-trial', async (req, res, next) => {
  try {
    const [[off]] = await req.db.execute(
      "SELECT key_name FROM report_prefs WHERE key_name = 'voucher_issuance' AND enabled = 0")
    res.json(await dailyTrial(req.db, req.query.date || kstToday(), { includeIssuance: !off }))
  } catch (e) { next(e) }
})

/**
 * 홈 요약 — 자금일보의 앞부분만. 홈에서 매일 보는 숫자라 가볍게 유지한다.
 * 자세한 건 자금일보로 들어간다.
 */
router.get('/', async (req, res, next) => {
  try {
    const date = kstToday()
    const to = kstDate(Date.now() + 7 * 86400000)
    const accounts = await balancesAsOf(req.db, date)
    const available = accounts.filter(a => a.kind !== 'card').reduce((s, a) => s + a.balance, 0)
    const [ar, ap, flows] = await Promise.all([
      openInvoiceTotal(req.db, 'issued'),
      openInvoiceTotal(req.db, 'received'),
      upcomingFlows(req.db, { from: date, to }),
    ])
    const f = project(available, flows, { from: date, to })
    res.json({
      date, available, accountCount: accounts.filter(a => a.kind !== 'card').length,
      receivable: ar, payable: ap,
      weekIn: f.totalIn, weekOut: f.totalOut,
      lowest: f.lowest,
      overdueCount: flows.filter(x => x.overdue).length,
      /* 기한이 없는 청구서는 '언제 들어올지 모르는 돈'이라 기준일에 몰아 세운다.
         그러면 '이번 주 들어올 돈'에 통째로 섞여, 실제로는 기약 없는 돈을 이번 주 자금으로
         계획하게 된다(자금일보는 '기한 미정' 배지로 구분해 주는데 홈만 단정하고 있었다).
         금액을 함께 내려 홈이 "그중 얼마는 기한 미정"이라고 말할 수 있게 한다. */
      noDueIn:  flows.filter(x => x.noDue && x.kind === 'in').reduce((s, x) => s + x.amount, 0),
      noDueOut: flows.filter(x => x.noDue && x.kind === 'out').reduce((s, x) => s + x.amount, 0),
    })
  } catch (e) { next(e) }
})

module.exports = router
