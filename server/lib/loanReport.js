/**
 * 차입금 현황 집계 — 보고서 '차입금 현황'의 단일 산식.
 *
 * ── 왜 lib 인가 ──
 * 화면(보고서 카드)과 엑셀이 **같은 숫자**를 내야 한다. 집계를 두 벌로 두면
 * 화면에서 본 잔액과 내려받은 파일의 잔액이 달라지고, 그러면 둘 다 못 믿게 된다.
 * lib/fundStatus.js · lib/fundSheet.js 를 화면과 보고서가 함께 쓰는 것과 같은 이유다.
 *
 * ⚠ 멀티테넌트 — db 를 **인자로 받는다.** 전역 풀을 참조하면 회사 구분이 사라진다.
 *
 * ── 잔액을 어떻게 세나 ──
 * `loans.principal` 은 **누적 차입액**이다(추가 인출이 있으면 그만큼 늘어난다).
 * 남은 원금 = 누적 차입액 − 실제로 갚은 원금. 이 산식은 lib/loan.js `remainingPrincipal()`
 * 하나로만 구한다 — 화면(routes/finance.js loanDetail)이 쓰는 것과 같은 함수다.
 *
 * ⚠ 이자는 **잔액에서 빼지 않는다.** 갚아야 할 빚은 원금이고, 이자는 그때그때 나간 비용이다.
 *   합치면 "얼마를 더 갚아야 하나"가 실제보다 커진다.
 */

const { remainingPrincipal } = require('./loan')

const num = (v) => Number(v) || 0

/** 차입처 이름 — 비어 있으면 거래처명, 그것도 없으면 '미지정'. 묶음 키가 빈 문자열이 되면
 *  엑셀에서 이름 없는 행이 하나 생겨 "이게 뭐지"로 끝난다. */
const lenderOf = (l) => (l.lender || '').trim() || (l.vendor_name || '').trim() || '미지정'

/**
 * 차입금 현황 한 벌.
 *
 * @param db          req.db (테넌트 커넥션)
 * @param opts.status 'active'(기본) | 'all' — 상환 완료분까지 볼지
 * @param opts.loanId 한 건만 볼 때 그 차입금 id. 없으면 전부
 * @returns {{ loans, byLender, repayments, byLoan, totals, status, loanId }}
 */
async function loanReport(db, { status = 'active', loanId = null } = {}) {
  const onlyActive = status !== 'all'
  /* 한 건만 뽑을 때는 status 를 무시한다 — 이미 다 갚은 차입금 하나를 골랐는데
     '진행 중' 필터에 걸려 빈 표가 나오면 "왜 안 나오지"로 끝난다. 고른 것이 곧 의도다. */
  const where = loanId ? 'WHERE l.id = ?' : (onlyActive ? "WHERE l.status = 'active'" : '')
  const [loans] = await db.execute(`
    SELECT l.*, v.name AS vendor_name, a.name AS account_name
      FROM loans l
      LEFT JOIN vendors  v ON v.id = l.vendor_id
      LEFT JOIN accounts a ON a.id = l.account_id
     ${where}
     ORDER BY l.status, l.start_date, l.name`, loanId ? [loanId] : [])

  if (!loans.length) {
    return { status, loanId, loans: [], byLender: [], repayments: [], byLoan: [],
             totals: { count: 0, principal: 0, repaidPrincipal: 0, repaidInterest: 0, remaining: 0 } }
  }

  /* 상환 회차와 추가 인출을 **한 번에** 가져온다. 차입금마다 조회하면 왕복이 건수만큼 늘고,
     fowin 만 해도 14건이라 화면 한 장에 30번 왕복하게 된다. */
  const ids = loans.map(l => l.id)
  const ph = ids.map(() => '?').join(',')
  const [repRows] = await db.execute(
    `SELECT loan_id, seq, due_date, paid_date, principal, interest
       FROM loan_repayments WHERE loan_id IN (${ph}) ORDER BY loan_id, seq`, ids)
  const [drawRows] = await db.execute(
    `SELECT loan_id, draw_date, amount FROM loan_draws WHERE loan_id IN (${ph})`, ids)

  const repsBy = new Map()
  for (const r of repRows) {
    if (!repsBy.has(r.loan_id)) repsBy.set(r.loan_id, [])
    repsBy.get(r.loan_id).push(r)
  }
  const drawSum = new Map()
  for (const d of drawRows) drawSum.set(d.loan_id, (drawSum.get(d.loan_id) || 0) + num(d.amount))

  const out = []
  for (const l of loans) {
    const reps = repsBy.get(l.id) || []
    const paid = reps.filter(r => r.paid_date)
    out.push({
      id: l.id,
      name: l.name,
      lender: lenderOf(l),
      principal: num(l.principal),                        // 누적 차입액
      // 최초 실행액 — 누적에서 추가 인출을 되짚는다(화면 loanDetail 과 같은 계산)
      initialPrincipal: num(l.principal) - (drawSum.get(l.id) || 0),
      annualRate: num(l.annual_rate),
      method: l.method,
      termMonths: num(l.term_months),
      startDate: l.start_date,
      endDate: l.end_date || '',
      accountName: l.account_name || '',
      status: l.status,
      repaidPrincipal: paid.reduce((t, r) => t + num(r.principal), 0),
      repaidInterest: paid.reduce((t, r) => t + num(r.interest), 0),
      // ⚠ remainingPrincipal 은 paid_date 가 있는 행만 센다 — 예정 회차를 갚은 걸로 세면 안 된다
      remaining: remainingPrincipal(l.principal, reps),
      paidCount: paid.length,
      cycleCount: reps.length,
    })
  }

  // 차입처별 묶음 — 잔액 큰 순. "어디에 제일 많이 물려 있나"가 이 표의 질문이다
  const byLender = [...out.reduce((m, l) => {
    const g = m.get(l.lender) || { lender: l.lender, count: 0, principal: 0,
                                   repaidPrincipal: 0, repaidInterest: 0, remaining: 0 }
    g.count += 1
    g.principal += l.principal
    g.repaidPrincipal += l.repaidPrincipal
    g.repaidInterest += l.repaidInterest
    g.remaining += l.remaining
    return m.set(l.lender, g)
  }, new Map()).values()].sort((a, b) => b.remaining - a.remaining || b.principal - a.principal)

  /* 상환 내역 — 갚은 회차만, 납부일 순. 예정 회차는 '상환 내역'이 아니다.
     (다음에 나갈 돈은 자금 예측이 답하는 질문이고, 이 표는 지나간 기록이다.) */
  const nameById = new Map(out.map(l => [l.id, l]))
  const repayments = repRows
    .filter(r => r.paid_date && nameById.has(r.loan_id))
    .map(r => {
      const l = nameById.get(r.loan_id)
      return {
        loanId: r.loan_id, loanName: l.name, lender: l.lender, accountName: l.accountName,
        seq: num(r.seq), dueDate: r.due_date, paidDate: r.paid_date,
        principal: num(r.principal), interest: num(r.interest),
        total: num(r.principal) + num(r.interest),
      }
    })
    /* 납부일 → 차입금명 → 회차. 이름 비교에서 **1 을 빠뜨리면 안 된다** —
       빠뜨리면 이름이 큰 쪽에서 seq 차이로 흘러, 같은 날 갚은 두 계좌의 순서가
       비교 순서에 따라 달라진다(정렬이 불안정해져 엑셀 행 순서가 그때그때 바뀐다). */
    .sort((a, b) => (a.paidDate < b.paidDate ? -1 : a.paidDate > b.paidDate ? 1
                     : a.loanName < b.loanName ? -1 : a.loanName > b.loanName ? 1
                     : a.seq - b.seq))

  const totals = {
    count: out.length,
    principal: out.reduce((t, l) => t + l.principal, 0),
    repaidPrincipal: out.reduce((t, l) => t + l.repaidPrincipal, 0),
    repaidInterest: out.reduce((t, l) => t + l.repaidInterest, 0),
    remaining: out.reduce((t, l) => t + l.remaining, 0),
  }

  /* 차입금(=대출 계좌)별로 묶은 상환 내역.
   *
   * 날짜순 한 줄로만 내면 여섯 개 계좌의 회차가 뒤섞여, "이 계좌에 얼마를 갚았나"를
   * 세려면 사람이 눈으로 골라내야 한다. 차입금 이름에 계좌번호가 붙어 있는 것
   * ("경남은행 64 (23.1218~28.1218)-9304")도 실무에서 계좌 단위로 본다는 뜻이다.
   * 그래서 묶음과 **소계**를 함께 낸다 — 소계가 없으면 묶어도 다시 더해야 한다.
   *
   * 상환 실적이 없는 차입금도 뺀 자리 없이 넣는다(rows: []). 목록에서 사라지면
   * "안 갚은 것"과 "화면에 안 나온 것"을 구별할 수 없다. */
  const byLoan = out.map(l => {
    const rows = repayments.filter(r => r.loanId === l.id)
    return {
      loanId: l.id, loanName: l.name, lender: l.lender, accountName: l.accountName,
      principal: l.principal, remaining: l.remaining, status: l.status,
      rows,
      subtotal: {
        principal: rows.reduce((t, r) => t + r.principal, 0),
        interest: rows.reduce((t, r) => t + r.interest, 0),
        total: rows.reduce((t, r) => t + r.total, 0),
        count: rows.length,
      },
    }
  })

  return { status, loanId, loans: out, byLender, repayments, byLoan, totals }
}

/** 상환방식 한글 이름 — 화면·엑셀이 같은 말을 쓰게 한 곳에 둔다 */
const METHOD_LABEL = {
  equal_payment: '원리금균등',
  equal_principal: '원금균등',
  bullet: '만기일시',
  none: '일정 없음',
}

module.exports = { loanReport, METHOD_LABEL }
