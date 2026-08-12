const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError } = require('../lib/ledger')
const { repaymentSchedule, unpaidCycles, remainingPrincipal, scheduleTotals, METHODS } = require('../lib/loan')

const router = Router()

/* 재무관리 — 차입금·투자.
 *
 * 최우선 규칙: 원금은 부채, 이자는 비용이다. **반드시 두 거래로 나눈다** —
 * 한 건으로 뭉치면 원금까지 비용이 되어 손익이 틀어진다.
 * 손익 제외 판정은 거래에 붙는 계정과목(account_code)이 근거다(lib/pnl.js).
 *
 * 설계: docs/02-design/features/finance-management.design.md
 * ⚠ 멀티테넌트 — 전역 풀 금지. req.db 로만 질의하고 헬퍼에는 db를 인자로 넘긴다.
 */

// 기본 계정과목 — 화면에서 고르지 않았을 때. 코드는 기본 계정과목 시딩에 이미 있다.
const ACCT = {
  shortLoan: '2201',   // 단기차입금(부채)
  longLoan:  '2302',   // 장기차입금(부채)
  interest:  '5301',   // 이자비용(비용)
  capital:   '3101',   // 자본금(자본)
  premium:   '3201',   // 주식발행초과금(자본)
  investOut: '1502',   // 장기투자증권(자산)
}

const { moneyOf: intOf, numOf } = require('../lib/money')

/* ── 상환 회차: 예정도 실적과 같은 테이블에 산다 ──────────────────────────
 *
 * loan_repayments 한 행 = 한 회차. paid_date 가 비면 **예정**, 차면 **실적**이다.
 * 예전엔 실적만 저장하고 예정은 원금·이율·기간으로 매번 계산했는데, 그러면
 * 은행 통보서대로 고쳐 둘 자리가 없다 — 변동금리로 이자가 달라지거나, 중도상환·만기연장이
 * 있거나, 이체일이 휴일이라 하루 밀리면 공식값과 어긋난다. 자금 예측은 **은행이 실제로
 * 빼갈 금액**을 알아야 쓸모가 있으므로, 예정을 고칠 수 있는 데이터로 둔다.
 *
 * ⚠ 이 전제가 무너지면 안 갚은 돈이 갚은 것으로 계산된다. 그래서
 *   · 잔여 원금은 lib/loan.js 의 remainingPrincipal 이 paid_date 있는 행만 센다
 *   · '미상환 회차'는 아래 unpaidCyclesOf 한 곳으로만 구한다
 */

/** 회차 목록에 잔액(그 회차를 갚고 난 뒤 남는 원금)을 채운다 — 화면 표의 마지막 칸이다. */
function withBalance(principal, cycles) {
  let left = Number(principal) || 0
  return cycles.map(c => {
    left = Math.max(0, left - (Number(c.principal) || 0))
    return { ...c, balance: left }
  })
}

/** 저장된 회차 전부(예정+실적). 없으면 빈 배열 — 옛 데이터 판별에 쓴다. */
async function storedCycles(db, loanId) {
  const [rows] = await db.execute(
    'SELECT seq, due_date, principal, interest, paid_date FROM loan_repayments WHERE loan_id = ? ORDER BY seq',
    [loanId])
  return rows.map(r => ({
    seq: Number(r.seq), due_date: r.due_date,
    principal: Number(r.principal) || 0, interest: Number(r.interest) || 0,
    total: (Number(r.principal) || 0) + (Number(r.interest) || 0),
    paid_date: r.paid_date || null,
  }))
}

/**
 * 미상환 회차 — **이 함수 하나로만 구한다.**
 * 저장된 예정 행이 있으면 그것이 진실이다(고쳐 둔 금액이 살아 있어야 한다).
 * 하나도 없으면 스케줄이 아직 안 깔린 옛 데이터라 그때만 공식으로 만든다.
 */
async function unpaidCyclesOf(db, loan) {
  const rows = await storedCycles(db, loan.id)
  const planned = rows.filter(c => !c.paid_date)
  if (planned.length) return withBalance(loan.principal, rows).filter(c => !c.paid_date)
  const done = rows.filter(c => c.paid_date).map(c => c.seq)
  return unpaidCycles(loan, done)
}

/** 예정 회차를 다시 깐다 — **이미 낸 회차는 절대 건드리지 않는다.** */
async function writePlannedCycles(conn, loan) {
  const [paid] = await conn.execute(
    'SELECT seq FROM loan_repayments WHERE loan_id = ? AND paid_date IS NOT NULL', [loan.id])
  const done = new Set(paid.map(p => Number(p.seq)))
  await conn.execute('DELETE FROM loan_repayments WHERE loan_id = ? AND paid_date IS NULL', [loan.id])
  for (const c of repaymentSchedule(loan)) {
    if (done.has(c.seq)) continue
    await conn.execute(
      'INSERT INTO loan_repayments (id, loan_id, seq, due_date, principal, interest) VALUES (?,?,?,?,?,?)',
      [randomUUID(), loan.id, c.seq, c.due_date, c.principal, c.interest])
  }
}

/** 대출 1건 + 실적 + 잔여 + 다음 회차 */
async function loanDetail(db, loan) {
  const [reps] = await db.execute(
    'SELECT * FROM loan_repayments WHERE loan_id = ? ORDER BY seq', [loan.id])
  const stored = await storedCycles(db, loan.id)
  // 표에 그릴 스케줄 — 저장된 회차가 있으면 그것(고쳐 둔 금액 반영), 없으면 공식
  const schedule = stored.length ? withBalance(loan.principal, stored) : repaymentSchedule(loan)
  const paidSeqs = reps.filter(r => r.paid_date).map(r => r.seq)
  const upcoming = await unpaidCyclesOf(db, loan)
  const today = kstToday()
  return {
    ...loan,
    principal: Number(loan.principal),
    annual_rate: Number(loan.annual_rate),
    schedule,
    totals: scheduleTotals(loan),
    repayments: reps.map(r => ({ ...r, principal: Number(r.principal), interest: Number(r.interest) })),
    remaining: remainingPrincipal(loan.principal, reps),
    paid_count: paidSeqs.length,
    // 다음 상환 회차와, 예정일이 지났는데 아직 처리하지 않은 회차(놓친 상환)
    next_cycle: upcoming[0] || null,
    overdue_cycles: upcoming.filter(c => c.due_date < today),
  }
}

router.get('/loans', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(`
      SELECT l.*, v.name AS vendor_name FROM loans l
      LEFT JOIN vendors v ON l.vendor_id = v.id
      ORDER BY l.status, l.start_date DESC`)
    res.json(await Promise.all(rows.map(r => loanDetail(req.db, r))))
  } catch (e) { next(e) }
})

router.get('/loans/:id', async (req, res, next) => {
  try {
    const [[row]] = await req.db.execute(`
      SELECT l.*, v.name AS vendor_name FROM loans l
      LEFT JOIN vendors v ON l.vendor_id = v.id WHERE l.id = ?`, [req.params.id])
    if (!row) return res.status(404).json({ error: 'Not found' })
    res.json(await loanDetail(req.db, row))
  } catch (e) { next(e) }
})

/** 상환 스케줄 미리보기 — 등록 전에 총 이자·첫 회차를 보여준다(저장 없음) */
router.post('/loans/preview', (req, res) => {
  const loan = {
    principal: intOf(req.body.principal), annual_rate: numOf(req.body.annual_rate),
    method: req.body.method, term_months: intOf(req.body.term_months),
    start_date: req.body.start_date, pay_day: intOf(req.body.pay_day),
  }
  res.json({ schedule: repaymentSchedule(loan), totals: scheduleTotals(loan) })
})

/**
 * 대출 등록. received=true면 실행일에 계좌로 들어온 입금 거래까지 만든다.
 * 그 입금은 부채 계정(단기/장기차입금)으로 기록되므로 매출에는 잡히지 않는다.
 */
router.post('/loans', async (req, res, next) => {
  const b = req.body
  if (!String(b.name || '').trim()) return res.status(400).json({ error: '대출명을 입력해주세요' })
  if (!b.start_date) return res.status(400).json({ error: '실행일을 선택해주세요' })
  const principal = intOf(b.principal)
  if (principal <= 0) return res.status(400).json({ error: '원금을 입력해주세요' })
  /* 이율은 **안 넣은 것과 0%를 구분**해야 한다.
   * 검증이 없어서 이율 없이 대출이 만들어졌고, 그러면 상환 스케줄의 이자가 전부 0이 된다.
   * 실제로는 매달 이자를 내는데 장부에는 이자비용이 한 푼도 안 잡혀 손익이 그만큼 부풀고,
   * 나중에 알아채도 이미 몇 달치 상환이 잘못 기록된 뒤다.
   * 0%(무이자 정책자금 등)는 실제로 있으므로 **명시적으로 0을 보내면 허용**한다. */
  if (b.annual_rate == null || b.annual_rate === '') {
    return res.status(400).json({ error: '연이율을 입력해주세요. 무이자면 0을 넣어주세요.' })
  }
  const annualRate = numOf(b.annual_rate)
  if (!Number.isFinite(annualRate) || annualRate < 0) {
    return res.status(400).json({ error: '연이율을 숫자로 입력해주세요' })
  }
  if (annualRate > 100) return res.status(400).json({ error: '연이율이 너무 큽니다(100% 초과). 값을 확인해주세요.' })
  const method = METHODS.includes(b.method) ? b.method : 'equal_payment'
  const received = b.received === true || b.received === 'true'
  // 실제로 돈이 들어온 것으로 기록하려면 미래 날짜·마감월은 막는다(거래 등록과 같은 규칙)
  if (received) {
    const de = futureDateError(b.start_date); if (de) return res.status(400).json({ error: de })
    const ce = await closedPeriodError(req.db, b.start_date); if (ce) return res.status(409).json({ error: ce })
    const le = ledgerError({ kind: 'income', account_id: b.account_id, status: '입금완료' })
    if (le) return res.status(400).json({ error: le })
  }
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const id = randomUUID()
    const termMonths = Math.max(1, intOf(b.term_months) || 12)
    // 1년 초과면 비유동부채(장기차입금)가 기본값
    const acctPrincipal = b.acct_code_principal || (termMonths > 12 ? ACCT.longLoan : ACCT.shortLoan)
    let txnId = null
    if (received) {
      txnId = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, doc_no, memo, account_code, loan_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txnId, 'income', b.vendor_id || null, b.account_id || null, '차입금 수령', principal,
         b.start_date, '계좌이체', '입금완료', '공통',
         `${String(b.name).trim()} 대출 실행`, acctPrincipal, id])
    }
    await conn.execute(
      `INSERT INTO loans (id, name, lender, vendor_id, principal, annual_rate, method, term_months,
                          start_date, pay_day, end_date, account_id, acct_code_principal, acct_code_interest, memo, txn_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, String(b.name).trim(), b.lender || null, b.vendor_id || null, principal, numOf(b.annual_rate),
       method, termMonths, b.start_date, intOf(b.pay_day) || Number(String(b.start_date).slice(8, 10)) || 1,
       b.end_date || null, b.account_id || null, acctPrincipal, b.acct_code_interest || ACCT.interest,
       b.memo || null, txnId])
    /* 예정 회차를 바로 깐다. 이게 있어야 자금 예측이 "며칠에 얼마 나간다"를 알고,
       은행 통보액으로 고칠 자리도 생긴다. */
    await writePlannedCycles(conn, {
      id, principal, annual_rate: numOf(b.annual_rate), method, term_months: termMonths,
      start_date: b.start_date,
      pay_day: intOf(b.pay_day) || Number(String(b.start_date).slice(8, 10)) || 1,
    })
    await conn.commit()
    res.json({ ok: true, id })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/**
 * 대출 수정.
 *
 * 상환 조건(원금·이자율·방식·회차·실행일)은 **스케줄을 결정**하고, 스케줄은 매번 현재 값으로
 * 다시 계산된다(loanDetail). 그래서 상환 실적이 생긴 뒤 조건을 바꾸면 이미 낸 금액과
 * 화면 스케줄이 어긋난다 — 특히 원리금균등은 이자율이 원금 배분을 바꾸므로,
 * 이자율만 고쳐도 "스케줄대로 끝까지 갚아도 잔액이 0이 되지 않는" 상태가 된다.
 *   → 실적이 있으면 **이자율까지 포함해** 조건 5종 전부 잠근다.
 *
 * 실적이 없으면 조건도 바꿀 수 있어야 한다. 여태 UPDATE 컬럼 목록에 원금·방식·회차·실행일이
 * 아예 없어서, 화면이 값을 보내고 미리보기까지 새 스케줄을 보여주는데도 **조용히 무시**되고
 * `ok:true`가 돌아갔다(잘못 넣은 원금을 고칠 방법이 삭제·재등록뿐이었다).
 */
const LOAN_TERMS = ['principal', 'annual_rate', 'method', 'term_months', 'start_date']
router.put('/loans/:id', async (req, res, next) => {
  const b = req.body
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[cur]] = await conn.execute('SELECT * FROM loans WHERE id = ? FOR UPDATE', [req.params.id])
    if (!cur) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const [[{ cnt }]] = await conn.execute(
      'SELECT COUNT(*) AS cnt FROM loan_repayments WHERE loan_id = ? AND paid_date IS NOT NULL', [req.params.id])
    const locked = Number(cnt) > 0

    // 요청이 실제로 바꾸려는 조건이 무엇인지 — 보내지 않은 값은 기존 값 유지로 본다
    const want = {
      principal:   b.principal   != null && b.principal   !== '' ? intOf(b.principal)   : Number(cur.principal),
      annual_rate: b.annual_rate != null && b.annual_rate !== '' ? numOf(b.annual_rate) : Number(cur.annual_rate),
      method:      METHODS.includes(b.method) ? b.method : cur.method,
      term_months: b.term_months != null && b.term_months !== '' ? Math.max(1, intOf(b.term_months)) : Number(cur.term_months),
      start_date:  b.start_date || cur.start_date,
    }
    const changed = LOAN_TERMS.filter(k => String(want[k]) !== String(
      k === 'annual_rate' ? Number(cur.annual_rate) : k === 'principal' || k === 'term_months' ? Number(cur[k]) : cur[k]))
    if (locked && changed.length) {
      const LABEL = { principal: '원금', annual_rate: '이자율', method: '상환방식', term_months: '회차', start_date: '실행일' }
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `이미 상환 처리한 회차가 ${cnt}건 있어 ${changed.map(k => LABEL[k]).join('·')}은(는) 바꿀 수 없어요. `
             + `이미 낸 금액과 스케줄이 어긋납니다. 이름·기관·상환일·계좌·메모는 수정할 수 있어요.`,
      })
    }

    const [result] = await conn.execute(
      `UPDATE loans SET name=?, lender=?, vendor_id=?, principal=?, annual_rate=?, method=?, term_months=?,
              start_date=?, pay_day=?, end_date=?, account_id=?, acct_code_principal=?, acct_code_interest=?,
              memo=?, status=?
       WHERE id=?`,
      [String(b.name || '').trim() || cur.name, b.lender || null, b.vendor_id || null,
       want.principal, want.annual_rate, want.method, want.term_months, want.start_date,
       intOf(b.pay_day) || cur.pay_day || 1, b.end_date || null, b.account_id || null,
       b.acct_code_principal || cur.acct_code_principal || ACCT.shortLoan,
       b.acct_code_interest || cur.acct_code_interest || ACCT.interest,
       b.memo || null, b.status === 'closed' ? 'closed' : 'active', req.params.id])
    if (result.affectedRows === 0) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    /* 스케줄을 바꾸는 값이 달라졌을 때만 예정 회차를 다시 깐다.
       늘 다시 깔면, 이름만 고쳐도 은행 통보액으로 고쳐 둔 예정 금액이 공식값으로 되돌아간다.
       pay_day 는 LOAN_TERMS 에 없지만 예정일을 바꾸므로 여기 포함한다. */
    const payDayChanged = Number(intOf(b.pay_day) || cur.pay_day || 1) !== Number(cur.pay_day)
    if (changed.length || payDayChanged) {
      const [[fresh]] = await conn.execute('SELECT * FROM loans WHERE id = ?', [req.params.id])
      await writePlannedCycles(conn, fresh)
    }
    await conn.commit()
    res.json({ ok: true, changedTerms: changed })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/**
 * 회차 1건을 실제 상환으로 반영한다 — 건별·일괄이 같은 코드를 쓰게 떼어냈다.
 * **원금과 이자를 각각 다른 거래로 만든다.** 원금은 부채 계정(손익 제외), 이자는 비용 계정(손익 포함).
 * 한 건으로 뭉치면 원금까지 비용이 되어 손익이 틀어진다.
 * 호출 전 검사(회차 순서·미래일자·마감·계좌)는 라우트가 한다.
 */
async function applyRepayment(conn, loan, cycle, { payDate, acct }) {
  const mkTxn = async (amount, category, acctCode, memo) => {
    if (amount <= 0) return null
    const id = randomUUID()
    await conn.execute(
      `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, doc_no, memo, account_code, loan_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, 'expense', loan.vendor_id || null, acct, category, amount, payDate,
       '계좌이체', '지급완료', '공통', memo, acctCode, loan.id])
    return id
  }
  const label = `${loan.name} ${cycle.seq}회차`
  // 원금 = 부채 상환(손익 아님) / 이자 = 비용(손익) — 반드시 나눈다
  const txnP = await mkTxn(cycle.principal, '차입금 상환', loan.acct_code_principal || ACCT.shortLoan, `${label} 원금`)
  const txnI = await mkTxn(cycle.interest, '이자비용', loan.acct_code_interest || ACCT.interest, `${label} 이자`)
  await conn.execute(
    `INSERT INTO loan_repayments (id, loan_id, seq, due_date, principal, interest, paid_date, txn_principal_id, txn_interest_id)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE paid_date=VALUES(paid_date), principal=VALUES(principal),
       interest=VALUES(interest), txn_principal_id=VALUES(txn_principal_id), txn_interest_id=VALUES(txn_interest_id)`,
    [randomUUID(), loan.id, cycle.seq, cycle.due_date, cycle.principal, cycle.interest, payDate, txnP, txnI])
  return { txnP, txnI }
}

/**
 * 놓친 상환 일괄 처리 — 예정일이 지났는데 처리하지 않은 회차를 순서대로 모두 반영한다.
 *
 * 정기 회차의 일괄 등록과 성격이 다르다. 정기 일괄은 '지급 대기'까지만 만들어 계좌를 안 건드리지만,
 * **대출 상환은 만드는 순간 실제 지출**이다(자동이체로 이미 나간 돈). 그래서 계좌를 반드시 받고,
 * 각 회차는 그 회차의 예정일로 기록한다(실제 이체일이 그 날이므로).
 *
 * 마감된 달이 하나라도 섞이면 **전체를 거절한다**. 순서를 건너뛸 수 없으므로 일부만 처리하면
 * 남은 회차를 영영 못 넣게 되고, 부분 커밋은 "무엇이 처리됐는지" 알기 어렵다.
 */
router.post('/loans/:id/repay-missed', async (req, res, next) => {
  const { account_id } = req.body
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    /* ⚠ FOR UPDATE — 이 행을 잠그지 않으면 겹쳐 실행될 때(두 탭·모바일+PC·빠른 재클릭)
     * 양쪽이 같은 미상환 회차를 보고 각자 지출 거래를 만든다. loan_repayments의
     * UNIQUE(loan_id,seq)는 실적 행만 하나로 합치므로, 먼저 만든 거래들이 어느 실적에도
     * 연결되지 않은 고아로 남아 통장에서 한 번 나간 돈이 장부에서 두 번 빠진다.
     * 상환 취소는 실적에 적힌 txn_id만 지우므로 고아 거래는 취소로도 사라지지 않는다.
     * 정기청구·정기지출은 같은 위험을 FOR UPDATE로 막고 있다(routes/recurring*.js). */
    const [[loan]] = await conn.execute('SELECT * FROM loans WHERE id = ? FOR UPDATE', [req.params.id])
    if (!loan) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const today = kstToday()
    const left = await unpaidCyclesOf(conn, loan)
    const targets = left.filter(c => c.due_date <= today)   // 놓친 것만 — 미래 회차는 대상 아니다
    if (!targets.length) { await rollbackQuietly(conn); return res.status(409).json({ error: '처리할 놓친 상환이 없어요' }) }
    const acct = account_id || loan.account_id || null
    const le = ledgerError({ kind: 'expense', account_id: acct, status: '지급완료' })
    if (le) { await rollbackQuietly(conn); return res.status(400).json({ error: le }) }
    // 마감월 선검사 — 하나라도 걸리면 전체 거절(순서를 건너뛸 수 없으므로)
    for (const c of targets) {
      const ce = await closedPeriodError(conn, c.due_date)
      if (ce) {
        await rollbackQuietly(conn)
        return res.status(409).json({
          error: `${c.seq}회차(${c.due_date})가 마감된 달이에요. ${ce} 마감을 풀거나 그 회차부터는 개별로 처리해주세요.`,
        })
      }
    }
    let principal = 0, interest = 0
    for (const c of targets) {
      await applyRepayment(conn, loan, c, { payDate: c.due_date, acct })
      principal += c.principal; interest += c.interest
    }
    // 남은 예정 회차가 없으면 완료 처리 — '잔액 0'으로 보면, 예정 금액을 은행 통보액으로
    // 고쳤을 때 합이 원금과 딱 안 맞아 영영 안 닫힌다.
    if (!(await unpaidCyclesOf(conn, loan)).length) {
      await conn.execute("UPDATE loans SET status='closed' WHERE id = ?", [loan.id])
    }
    await conn.commit()
    res.json({ ok: true, count: targets.length, principal, interest, total: principal + interest })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/**
 * 상환 처리 — 한 회차를 실제로 갚는다.
 */
router.post('/loans/:id/repay', async (req, res, next) => {
  const { seq, date, account_id } = req.body
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    /* ⚠ 회차 판정부터 거래 생성까지 한 트랜잭션 안에서, 대출 행을 FOR UPDATE로 잠근 뒤 한다.
     * 잠그지 않으면 동시 요청이 같은 회차를 각자 상환해 지출 거래가 두 벌 생긴다
     * (실적 행은 UNIQUE로 하나가 되고, 먼저 만든 거래는 고아로 남아 취소로도 안 지워진다). */
    const [[loan]] = await conn.execute('SELECT * FROM loans WHERE id = ? FOR UPDATE', [req.params.id])
    if (!loan) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const left = await unpaidCyclesOf(conn, loan)
    if (!left.length) { await rollbackQuietly(conn); return res.status(409).json({ error: '남은 상환 회차가 없어요' }) }
    const target = seq ? left.find(c => c.seq === Number(seq)) : left[0]
    if (!target) { await rollbackQuietly(conn); return res.status(409).json({ error: '이미 처리한 회차예요' }) }
    // 앞선 회차를 건너뛰면 잔여 원금이 어긋난다(이자는 잔액 기준으로 계산되므로)
    if (target.seq !== left[0].seq) {
      await rollbackQuietly(conn)
      return res.status(409).json({ error: `앞선 회차(${left[0].seq}회차 · ${left[0].due_date})부터 처리해주세요` })
    }
    const payDate = date || target.due_date
    // 실제로 돈이 나가므로 거래 등록과 같은 규칙을 적용한다
    { const de = futureDateError(payDate); if (de) { await rollbackQuietly(conn); return res.status(400).json({ error: de }) } }
    { const ce = await closedPeriodError(conn, payDate); if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) } }
    // 대출을 받기도 전의 날짜로는 상환할 수 없다(그 달엔 갚을 채무가 없었다)
    if (payDate < loan.start_date) {
      await rollbackQuietly(conn)
      return res.status(400).json({ error: `대출 실행일(${loan.start_date}) 이전 날짜로는 상환 처리할 수 없어요` })
    }
    const acct = account_id || loan.account_id || null
    { const le = ledgerError({ kind: 'expense', account_id: acct, status: '지급완료' }); if (le) { await rollbackQuietly(conn); return res.status(400).json({ error: le }) } }

    await applyRepayment(conn, loan, target, { payDate, acct })
    // 남은 예정 회차가 없으면 자동으로 완료 처리(위 일괄 처리와 같은 규칙)
    if (!(await unpaidCyclesOf(conn, loan)).length) {
      await conn.execute("UPDATE loans SET status='closed' WHERE id = ?", [loan.id])
    }
    await conn.commit()
    res.json({ ok: true, seq: target.seq, principal: target.principal, interest: target.interest })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/**
 * 예정 회차 수정 — 은행 통보액·실제 이체일에 맞춘다.
 *
 * 공식으로 뽑은 원리금은 **은행이 실제로 빼가는 금액과 몇 원씩 다르다**(변동금리·일할계산·
 * 휴일 이월). 자금 예측은 실제로 빠질 금액을 알아야 쓸모가 있으므로 여기서 고친다.
 * 이미 낸 회차는 못 고친다 — 그건 예측이 아니라 이미 오간 돈의 기록이고,
 * 고치려면 상환을 취소하고 다시 처리해야 거래 금액까지 함께 맞는다.
 */
router.patch('/loans/:id/cycles/:seq', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[row]] = await conn.execute(
      'SELECT * FROM loan_repayments WHERE loan_id = ? AND seq = ? FOR UPDATE',
      [req.params.id, req.params.seq])
    if (!row) { await rollbackQuietly(conn); return res.status(404).json({ error: '그 회차를 찾을 수 없어요' }) }
    if (row.paid_date) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `이미 ${row.paid_date}에 상환 처리한 회차예요. 금액을 고치려면 상환을 취소한 뒤 다시 처리해주세요.`,
      })
    }
    const b = req.body
    const principal = b.principal != null && b.principal !== '' ? intOf(b.principal) : Number(row.principal)
    const interest  = b.interest  != null && b.interest  !== '' ? intOf(b.interest)  : Number(row.interest)
    const dueDate   = b.due_date || row.due_date
    // 음수는 잔여 원금을 되레 늘린다 — 서버에서 막는다(거래 등록과 같은 규칙)
    if (principal < 0 || interest < 0) {
      await rollbackQuietly(conn)
      return res.status(400).json({ error: '원금·이자는 0 이상이어야 해요' })
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      await rollbackQuietly(conn)
      return res.status(400).json({ error: '예정일을 날짜로 입력해주세요' })
    }
    await conn.execute(
      'UPDATE loan_repayments SET due_date=?, principal=?, interest=? WHERE loan_id = ? AND seq = ?',
      [dueDate, principal, interest, req.params.id, req.params.seq])
    await conn.commit()
    res.json({ ok: true, seq: Number(req.params.seq), due_date: dueDate, principal, interest })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/** 상환 취소 — 만든 거래도 함께 지운다(잘못 처리한 회차를 되돌리는 유일한 경로) */
router.delete('/loans/:id/repay/:seq', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[rep]] = await conn.execute(
      'SELECT * FROM loan_repayments WHERE loan_id = ? AND seq = ?', [req.params.id, req.params.seq])
    if (!rep) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    // 가장 마지막 회차만 취소할 수 있다 — 중간을 되돌리면 뒤 회차의 이자 계산 근거가 사라진다
    const [[{ maxSeq }]] = await conn.execute(
      'SELECT MAX(seq) AS maxSeq FROM loan_repayments WHERE loan_id = ? AND paid_date IS NOT NULL', [req.params.id])
    if (Number(maxSeq) !== Number(req.params.seq)) {
      await rollbackQuietly(conn)
      return res.status(409).json({ error: `마지막으로 처리한 회차(${maxSeq}회차)부터 취소해주세요` })
    }
    for (const t of [rep.txn_principal_id, rep.txn_interest_id]) {
      if (t) await conn.execute('DELETE FROM transactions WHERE id = ?', [t])
    }
    /* 행을 지우지 않고 **예정으로 되돌린다.** 지우면 그 회차가 통째로 사라져
       자금 예측에서 나갈 돈이 빠진다(예정도 같은 테이블에 살기 때문). */
    await conn.execute(
      'UPDATE loan_repayments SET paid_date=NULL, txn_principal_id=NULL, txn_interest_id=NULL WHERE loan_id = ? AND seq = ?',
      [req.params.id, req.params.seq])
    await conn.execute("UPDATE loans SET status='active' WHERE id = ?", [req.params.id])
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/** 대출 삭제 — 상환 실적이 있으면 막는다(실제로 오간 돈의 기록이다) */
router.delete('/loans/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[{ cnt }]] = await conn.execute(
      'SELECT COUNT(*) AS cnt FROM loan_repayments WHERE loan_id = ? AND paid_date IS NOT NULL', [req.params.id])
    if (Number(cnt) > 0) {
      await rollbackQuietly(conn)
      return res.status(409).json({ error: `상환 처리한 회차가 ${cnt}건 있어 삭제할 수 없어요. 상환을 취소하거나 '완료'로 두세요.` })
    }
    const [[loan]] = await conn.execute('SELECT txn_id FROM loans WHERE id = ?', [req.params.id])
    if (!loan) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    // 실행 입금 거래도 함께 지운다(상환이 없으므로 되돌려도 장부에 구멍이 없다)
    if (loan.txn_id) await conn.execute('DELETE FROM transactions WHERE id = ?', [loan.txn_id])
    await conn.execute('DELETE FROM loan_repayments WHERE loan_id = ?', [req.params.id])
    await conn.execute('DELETE FROM loans WHERE id = ?', [req.params.id])
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/* ── 투자 ── */

router.get('/investments', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(`
      SELECT i.*, v.name AS vendor_name FROM investments i
      LEFT JOIN vendors v ON i.vendor_id = v.id
      ORDER BY i.invested_at DESC`)
    res.json(rows.map(r => ({
      ...r, amount: Number(r.amount),
      capital_amount: Number(r.capital_amount), premium_amount: Number(r.premium_amount),
    })))
  } catch (e) { next(e) }
})

/**
 * 투자 등록. 받은 돈(in)은 자본, 한 돈(out)은 투자자산 — 둘 다 손익이 아니다.
 * recorded=true면 실제 입출금 거래까지 만든다.
 */
router.post('/investments', async (req, res, next) => {
  const b = req.body
  const direction = b.direction === 'out' ? 'out' : 'in'
  if (!String(b.counterparty || '').trim()) {
    return res.status(400).json({ error: direction === 'in' ? '투자자를 입력해주세요' : '투자처를 입력해주세요' })
  }
  if (!b.invested_at) return res.status(400).json({ error: '일자를 선택해주세요' })
  const amount = intOf(b.amount)
  if (amount <= 0) return res.status(400).json({ error: '금액을 입력해주세요' })
  const recorded = b.recorded === true || b.recorded === 'true'
  const kind = direction === 'in' ? 'income' : 'expense'
  if (recorded) {
    const de = futureDateError(b.invested_at); if (de) return res.status(400).json({ error: de })
    const ce = await closedPeriodError(req.db, b.invested_at); if (ce) return res.status(409).json({ error: ce })
    const le = ledgerError({ kind, account_id: b.account_id, status: direction === 'in' ? '입금완료' : '지급완료' })
    if (le) return res.status(400).json({ error: le })
  }
  /* 투자받은 돈은 자본금 + 주식발행초과금으로 갈린다. 안 나누면 전액을 자본금으로 본다.
   * intOf가 '-'를 살려두므로 음수를 막아야 한다 — 안 막으면 자본금이 음수가 되고
   * 주식발행초과금이 투자금보다 커진다(합계만 맞아서 눈에 안 띈다). */
  const capitalIn = intOf(b.capital_amount)
  if (direction === 'in' && capitalIn < 0) return res.status(400).json({ error: '자본금은 0보다 작을 수 없어요' })
  const capital = direction === 'in' ? Math.min(capitalIn || amount, amount) : 0
  const premium = direction === 'in' ? amount - capital : 0
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const id = randomUUID()
    // 거래는 한 건으로 남긴다(계좌에 오간 돈은 한 번이다). 자본금/주식발행초과금 구분은
    // 투자 원장에 남기고, 거래 계정과목은 비중이 큰 쪽으로 잡는다.
    const acctCode = b.acct_code || (direction === 'out' ? ACCT.investOut
      : (premium > capital ? ACCT.premium : ACCT.capital))
    let txnId = null
    if (recorded) {
      txnId = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, doc_no, memo, account_code, investment_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txnId, kind, b.vendor_id || null, b.account_id || null,
         direction === 'in' ? '투자 수령' : '투자 지출', amount, b.invested_at, '계좌이체',
         direction === 'in' ? '입금완료' : '지급완료', '공통',
         `${String(b.counterparty).trim()} ${direction === 'in' ? '투자 수령' : '투자'}`, acctCode, id])
    }
    await conn.execute(
      `INSERT INTO investments (id, direction, counterparty, vendor_id, amount, invested_at, account_id,
                                capital_amount, premium_amount, acct_code, txn_id, memo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, direction, String(b.counterparty).trim(), b.vendor_id || null, amount, b.invested_at,
       b.account_id || null, capital, premium, acctCode, txnId, b.memo || null])
    await conn.commit()
    res.json({ ok: true, id })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.delete('/investments/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[inv]] = await conn.execute('SELECT txn_id FROM investments WHERE id = ?', [req.params.id])
    if (!inv) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    if (inv.txn_id) await conn.execute('DELETE FROM transactions WHERE id = ?', [inv.txn_id])
    await conn.execute('DELETE FROM investments WHERE id = ?', [req.params.id])
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/* ── 재무 현황 요약 ── */
router.get('/summary', async (req, res, next) => {
  try {
    const today = kstToday()
    const [loans] = await req.db.execute("SELECT * FROM loans WHERE status='active'")
    let remaining = 0, monthlyDue = 0, overdue = 0
    for (const l of loans) {
      const [reps] = await req.db.execute('SELECT * FROM loan_repayments WHERE loan_id = ? AND paid_date IS NOT NULL', [l.id])
      remaining += remainingPrincipal(l.principal, reps)
      const left = unpaidCycles(l, reps.map(r => r.seq))
      if (left[0]) monthlyDue += left[0].total
      overdue += left.filter(c => c.due_date < today).length
    }
    const [[inv]] = await req.db.execute(`
      SELECT COALESCE(SUM(CASE WHEN direction='in'  THEN amount ELSE 0 END), 0) AS invested_in,
             COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END), 0) AS invested_out
      FROM investments`)
    res.json({
      loan_count: loans.length,
      loan_principal: loans.reduce((s, l) => s + Number(l.principal), 0),
      remaining, monthly_due: monthlyDue, overdue_count: overdue,
      invested_in: Number(inv.invested_in), invested_out: Number(inv.invested_out),
    })
  } catch (e) { next(e) }
})

module.exports = router
