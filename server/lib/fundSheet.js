/**
 * 자금관리표 — 대표가 쓰던 엑셀(`자금(현금)관리2026.xlsx`)을 그대로 옮긴 한 장.
 *
 * ── 왜 자금 현황 화면과 따로 두나 ──
 * 숫자는 같다(lib/fundStatus.js 를 함께 쓴다). **모양이 다르다.**
 *   자금 현황  화면에서 읽는 문서. 달력·시간축·펼쳐보기가 있다
 *   자금관리표 종이로 넘기는 문서. 엑셀 칸 배치를 그대로 지킨다
 * 대표가 몇 년째 그 배치로 봐 왔기 때문에, 같은 숫자라도 자리가 바뀌면 못 읽는다.
 *
 * ── 원본에 없는데 더한 것: '들어온 돈' ──
 * 원본 엑셀에는 <입금 예정금액>(들어올 돈)만 있고 **이미 들어온 돈이 없다.**
 * 그래서 "이번 달에 얼마나 들어왔나"를 통장을 따로 열어 봐야 했다.
 * 계좌 줄에 실적(들어온·나간)을 함께 싣고, 입금 블록도 예정/실적 두 줄로 낸다.
 *
 * ── 블록 순서(원본과 같다) ──
 *   1. 법인 계좌별   잔액 · 나갈 항목(이름(일자)) · 합계 · 차액
 *   2. 개인 계좌별
 *   3. 총 합계
 *   4. 부채 현황(법인·개인)
 *   5. 저축 현황(법인·개인)
 *   6. 요약표        구분별 보통계좌·저축·부채·지급예정·미지급 인건비·현금 과부족
 *   7. 미지급 인건비 이름별
 *   8. 입금 예정·실적
 */

const { periodRange, periodLabel, monthRange } = require('./period')
const { balancesAsOf, upcomingFlows } = require('./cashReport')
const {
  openingBalances, actualsIn, debtStatus, savingsStatus, laborStatus, closedState,
} = require('./fundStatus')

const num = (v) => Number(v) || 0

/** 항목 이름 — 엑셀은 `급여(15일)` 처럼 이름과 날짜를 한 칸에 적는다 */
const itemLabel = (it) => {
  const d = String(it.date || '')
  const day = /^\d{4}-\d{2}-(\d{2})$/.test(d) ? `(${Number(d.slice(8))}일)` : ''
  return `${it.label}${day}`
}

/**
 * 한 구간(기본: 이번 달)의 자금관리표.
 *
 * @param db          req.db
 * @param opt.month   'YYYY-MM' (없으면 today 가 속한 회계월)
 * @param opt.today   'YYYY-MM-DD'
 * @param opt.closingDay 회계 마감일
 * @param opt.canSeeLabor 인사 권한 — 없으면 이름별 명세를 지운다(합계는 남긴다)
 */
async function fundSheet(db, { month, today, closingDay = 0, canSeeLabor = true }) {
  /* 구간은 **회계월**이다. 25일 마감 회사면 8월분 = 7/26~8/25 —
     엑셀 시트 이름도 그 회사의 '월분'이지 달력월이 아니다. */
  const range = month
    ? { unit: 'month', ...monthRange(month, closingDay) }
    : periodRange('month', today, 0, { closingDay })
  const label = periodLabel('month', range)

  const [open, flows, debts, savings, labor] = await Promise.all([
    // 구간 시작 시점 잔액. 미래 구간이면 오늘~구간 직전의 예정을 미리 반영한다(fundStatus 참조)
    openingBalances(db, { from: range.from, today }),
    upcomingFlows(db, { from: range.from < today ? today : range.from, to: range.to, anchorPast: range.from <= today }),
    debtStatus(db),
    savingsStatus(db),
    laborStatus(db),
  ])

  const mine = new Set(open.map(a => a.id))
  const actual = await actualsIn(db, range.from, range.to, mine)

  // 계좌별로 나갈·들어올 항목을 담는다
  const byAcct = new Map(open.map(a => [a.id, { ...a, out: [], in: [] }]))
  const unassigned = { in: 0, out: 0, items: [] }
  for (const f of flows) {
    const a = f.account_id && byAcct.get(f.account_id)
    if (!a) { unassigned[f.kind] += f.amount; unassigned.items.push(f); continue }
    a[f.kind].push(f)
  }

  const line = (a) => {
    const outTotal = a.out.reduce((s, x) => s + x.amount, 0)
    const inTotal = a.in.reduce((s, x) => s + x.amount, 0)
    return {
      id: a.id, name: a.name, owner: a.owner, kind: a.kind,
      balance: num(a.balance),
      // 실적 — 원본 엑셀에 없던 열이다("이미 얼마 들어왔나"를 통장을 열어 봐야 했다)
      actualIn: num(actual.by.get(a.id)?.in), actualOut: num(actual.by.get(a.id)?.out),
      outItems: a.out.map(it => ({ label: itemLabel(it), amount: it.amount, date: it.date, source: it.source })),
      inItems: a.in.map(it => ({ label: itemLabel(it), amount: it.amount, date: it.date, source: it.source })),
      outTotal, inTotal,
      // 엑셀의 마지막 칸 — 잔액에서 나갈 돈을 뺀 값(들어올 돈은 원본이 안 셌다. 따로 낸다)
      after: num(a.balance) - outTotal,
      expected: num(a.balance) - outTotal + inTotal,
    }
  }

  const group = (owner) => {
    const rows = [...byAcct.values()].filter(a => a.owner === owner && a.kind !== 'card').map(line)
    const sum = (f) => rows.reduce((s, r) => s + f(r), 0)
    return {
      rows,
      total: {
        balance: sum(r => r.balance), outTotal: sum(r => r.outTotal), inTotal: sum(r => r.inTotal),
        actualIn: sum(r => r.actualIn), actualOut: sum(r => r.actualOut),
        after: sum(r => r.after), expected: sum(r => r.expected),
      },
    }
  }

  const corp = group('corp')
  const personal = group('personal')
  const both = (f) => f(corp.total) + f(personal.total)

  /* 부채·저축은 법인/개인으로 갈라야 요약표가 원본과 같아진다.
     부채는 lender(기관)로 묶여 있고 개인 여부 표시가 없다 — 계좌 owner 처럼 나눌 근거가
     지금 데이터에 없다. 그래서 **가르지 않고 합계만** 낸다. 원본의 '개인부채' 칸은
     대표 개인 명의 차입이라, 그 구분이 데이터에 생기기 전에는 지어낼 수 없다. */
  const summary = {
    corp: {
      cash: corp.total.balance, plan: corp.total.outTotal,
      shortfall: corp.total.after,
    },
    personal: {
      cash: personal.total.balance, plan: personal.total.outTotal,
      shortfall: personal.total.after,
    },
    all: {
      cash: both(t => t.balance),
      savings: num(savings.total),
      debt: num(debts.total),
      plan: both(t => t.outTotal) + unassigned.out,
      labor: num(labor.total),
      actualIn: num(actual.in), actualOut: num(actual.out),
      planIn: both(t => t.inTotal) + unassigned.in,
      shortfall: both(t => t.after) - unassigned.out,
    },
  }

  // 들어올 돈 — 계좌 미지정분까지 포함해 한 줄씩(원본의 <입금 예정금액> 블록)
  const incoming = flows.filter(f => f.kind === 'in').map(f => ({
    label: f.label, source: f.source, date: f.date, amount: f.amount,
    account: byAcct.get(f.account_id)?.name || '',
    overdue: !!f.overdue, noDue: !!f.noDue,
  }))

  return {
    range: { ...range, label },
    today,
    state: await closedState(db, range.from, range.to, today),
    corp, personal, unassigned,
    debts, savings,
    // 인사 권한이 없으면 이름별 명세는 지우고 합계만 남긴다(자금 판단에는 합계면 된다)
    labor: canSeeLabor ? labor : { ...labor, items: [] },
    incoming,
    summary,
  }
}

module.exports = { fundSheet, itemLabel }
