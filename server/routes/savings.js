const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { closedPeriodError } = require('../lib/closing')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError } = require('../lib/ledger')
const {
  KINDS, paymentSchedule, unpaidPayments, paidPrincipal, maturitySummary, maturityDateOf,
  accruedInterest,
} = require('../lib/savings')

const router = Router()

/* 예금·적금 — 자금 '운용'. 차입금(자금 조달)의 거울상이라 구조를 일부러 맞췄다.
 *
 * 최우선 규칙: **납입은 비용이 아니다.** 돈이 계좌에서 나가지만 회사 재산은 그대로다
 * (보통예금이 줄고 금융상품이 는다). 계정과목을 자산(1201·1501)으로 붙이면
 * lib/pnl.js 가 손익 집계에서 알아서 빼준다. 비용 계정으로 붙이면 손익이 그만큼 틀어진다.
 *
 * 만기 수령은 **원금과 이자를 나눈다** — 원금은 자산 회수(손익 아님), 이자는 수익(손익).
 * 한 건으로 뭉치면 원금까지 수익이 되어 매출이 부풀려진다(대출 상환과 정확히 같은 이유).
 *
 * ⚠ 멀티테넌트 — 전역 풀 금지. req.db 로만 질의하고 헬퍼에는 db를 인자로 넘긴다.
 */

// 기본 계정과목 — 화면에서 고르지 않았을 때. 표준 계정과목 시딩에 이미 있는 코드다.
const ACCT = {
  shortTerm: '1201',   // 단기금융상품 (1년 이내)
  longTerm:  '1501',   // 장기금융상품 (1년 초과)
  // ⚠ 계정과목(account_subjects) 코드여야 한다. transactions.account_code 가 그 체계다.
  //   예전에 'INC-204'(비목 categories 코드)를 넣어, 일계표가 이름을 못 찾아 원문 코드로
  //   대분류 빈 칸으로 찍혔다. 손익 판정은 우연히 맞아 조용히 틀렸다.
  interest:  '4201',   // 이자수익(수익·영업외수익)
  guarantee: '1801',   // 보증금(기타비유동자산) — "전세권, 임차보증금, 영업보증금 등"
}

const { moneyOf: intOf, numOf } = require('../lib/money')

/** 기간이 1년을 넘으면 장기금융상품 — 회계 분류가 갈린다.
 *
 * ⚠ 보증금은 여기 태우면 안 된다. 만기가 없어 term_months 가 0이라 '1201 단기금융상품'
 *   으로 찍히는데, 보증금은 **당좌자산이 아니라 기타비유동자산**이다(계약이 끝나야
 *   돌아오는 돈이라 1년 내 현금화되지 않는다). 재무상태표에서 자리가 통째로 틀린다. */
const defaultAcctCode = (kind, termMonths) => (
  kind === 'guarantee' ? ACCT.guarantee
    : Number(termMonths) > 12 ? ACCT.longTerm
    : ACCT.shortTerm)

/* ── 납입 회차: 예정도 실적과 같은 테이블에 산다 ──────────────────────────
 * savings_payments 한 행 = 한 회차. paid_date 가 비면 **예정**, 차면 **실적**이다.
 * 차입금과 같은 규칙이다(routes/finance.js 머리말). 자동이체 금액이 바뀌거나
 * 이체일이 휴일로 밀리면 공식값과 어긋나는데, 그걸 고칠 자리가 있어야 한다. */

/** 저장된 회차 전부(예정+실적) */
async function storedPayments(db, savingsId) {
  const [rows] = await db.execute(
    'SELECT seq, due_date, amount, paid_date FROM savings_payments WHERE savings_id = ? ORDER BY seq', [savingsId])
  return rows.map(r => ({
    seq: Number(r.seq), due_date: r.due_date, amount: Number(r.amount) || 0, paid_date: r.paid_date || null,
  }))
}

/** 미납 회차 — **이 함수 하나로만 구한다.** 저장된 예정이 있으면 그것이 진실이다. */
async function unpaidPaymentsOf(db, s) {
  const rows = await storedPayments(db, s.id)
  const planned = rows.filter(c => !c.paid_date)
  if (planned.length) return planned
  return unpaidPayments(s, rows.filter(c => c.paid_date).map(c => c.seq))
}

/** 예정 회차를 다시 깐다 — 이미 낸 회차는 절대 건드리지 않는다. */
async function writePlannedPayments(conn, s) {
  if (s.kind !== 'installment') return          // 예금은 회차가 없다(가입 때 전액)
  const [paid] = await conn.execute(
    'SELECT seq FROM savings_payments WHERE savings_id = ? AND paid_date IS NOT NULL', [s.id])
  const done = new Set(paid.map(p => Number(p.seq)))
  await conn.execute('DELETE FROM savings_payments WHERE savings_id = ? AND paid_date IS NULL', [s.id])
  for (const c of paymentSchedule(s)) {
    if (done.has(c.seq)) continue
    await conn.execute(
      'INSERT INTO savings_payments (id, savings_id, seq, due_date, amount) VALUES (?,?,?,?,?)',
      [randomUUID(), s.id, c.seq, c.due_date, c.amount])
  }
}

/** 예적금 1건 + 납입 실적 + 스케줄 + 만기 요약 */
async function savingsDetail(db, s) {
  const [payments] = await db.execute(
    'SELECT * FROM savings_payments WHERE savings_id = ? ORDER BY seq', [s.id])
  const paid = payments.filter(p => p.paid_date)
  const stored = await storedPayments(db, s.id)
  // 저장된 회차가 있으면 그것이 스케줄이다(고쳐 둔 금액 반영). 없으면 공식.
  const schedule = stored.length ? stored : paymentSchedule(s)
  const unpaid = await unpaidPaymentsOf(db, s)
  const today = kstToday()
  return {
    ...s,
    schedule,
    payments: paid,
    paid_count: paid.length,
    // 지금까지 실제로 들어간 돈. 자금일보의 '묶인 자금'이 이 값을 쓴다.
    balance: paidPrincipal(s, paid),
    maturity: maturitySummary(s),
    next_payment: unpaid[0] || null,
    // 예정일이 지났는데 아직 안 낸 회차 — 자동이체가 실패했거나 잔액이 모자랐던 경우
    overdue_payments: unpaid.filter(c => c.due_date <= today),
  }
}

// ── 목록 ──────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(`
      SELECT s.*, a.name AS account_name, v.name AS vendor_name
        FROM savings s
        LEFT JOIN accounts a ON a.id = s.account_id
        LEFT JOIN vendors  v ON v.id = s.vendor_id
       ORDER BY s.status, s.start_date DESC`)
    res.json(await Promise.all(rows.map(r => savingsDetail(req.db, r))))
  } catch (e) { next(e) }
})

/**
 * 등록 화면의 만기 미리보기 — 저장하기 전에 이자·만기 수령액을 보여준다.
 * 기본값은 **등록(POST)과 반드시 같아야 한다.** 예전에 여기만 pay_day 기본을 1로 두어
 * 미리보기 첫 납입일이 가입일보다 앞으로 나왔다(7/31 가입인데 첫 납입 7/1).
 */
router.get('/preview', (req, res) => {
  const q = req.query
  const start_date = q.start_date || kstToday()
  res.json(maturitySummary({
    kind: KINDS.includes(q.kind) ? q.kind : 'installment',
    principal: intOf(q.principal),
    monthly_amount: intOf(q.monthly_amount),
    annual_rate: numOf(q.annual_rate),
    term_months: intOf(q.term_months),
    start_date,
    pay_day: intOf(q.pay_day) || Number(String(start_date).slice(8, 10)) || 1,
  }))
})

router.get('/:id', async (req, res, next) => {
  try {
    const [[s]] = await req.db.execute(`
      SELECT s.*, a.name AS account_name, v.name AS vendor_name
        FROM savings s
        LEFT JOIN accounts a ON a.id = s.account_id
        LEFT JOIN vendors  v ON v.id = s.vendor_id
       WHERE s.id = ?`, [req.params.id])
    if (!s) return res.status(404).json({ error: 'Not found' })
    res.json(await savingsDetail(req.db, s))
  } catch (e) { next(e) }
})

/**
 * 가입.
 *
 * 예금은 가입하는 순간 목돈이 계좌에서 빠진다 → recorded=true 면 출금 거래를 만든다.
 * 적금은 가입만으로는 돈이 안 나간다(1회차 납입은 아래 /pay 로 처리) — 대출을 '실행'과
 * '상환'으로 나눈 것과 같은 이유다. 가입과 동시에 첫 회차를 내는 게 보통이라
 * 화면에서 바로 1회차 납입을 안내한다.
 */
router.post('/', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const b = req.body
    const kind = KINDS.includes(b.kind) ? b.kind : 'installment'
    const name = String(b.name || '').trim()
    if (!name) return res.status(400).json({ error: '상품명을 입력해주세요' })
    const start_date = b.start_date
    if (!start_date) return res.status(400).json({ error: '가입일을 입력해주세요' })
    const fe = futureDateError(start_date)
    if (fe) return res.status(400).json({ error: fe })

    /* 보증금(guarantee)은 만기가 없다 — 계약이 끝나야 돌아온다.
       기간을 1개월로 두어도 되지만, 그러면 '만기 임박' 같은 안내가 엉뚱하게 뜬다.
       기간 검사는 만기가 있는 둘(예금·적금)에만 건다. */
    const term_months = kind === 'guarantee' ? 0 : intOf(b.term_months)
    if (kind !== 'guarantee' && term_months <= 0) {
      return res.status(400).json({ error: '기간(개월)을 1 이상으로 입력해주세요' })
    }
    // 보증금도 목돈이라 principal 을 쓴다(예금과 같은 자리). 적금만 월 납입액이다.
    const principal = kind === 'installment' ? 0 : intOf(b.principal)
    const monthly_amount = kind === 'installment' ? intOf(b.monthly_amount) : 0
    if (kind === 'deposit' && principal <= 0) return res.status(400).json({ error: '예치 금액을 입력해주세요' })
    if (kind === 'guarantee' && principal <= 0) return res.status(400).json({ error: '보증금 금액을 입력해주세요' })
    if (kind === 'installment' && monthly_amount <= 0) return res.status(400).json({ error: '월 납입액을 입력해주세요' })

    /* 가입과 동시에 통장에서 돈이 빠지는가.
     *   예금  — 목돈이 그 자리에서 나간다(기본 O)
     *   적금  — 가입만으로는 안 나간다(1회차는 /pay)
     *   보증금 — 대개 **몇 년 전에 이미 낸 것**을 뒤늦게 등록한다. 기본으로 거래를 만들면
     *            그때 이미 찍힌 출금과 겹쳐 계좌 잔액이 두 번 빠진다 → 켤 때만 만든다. */
    const recorded = kind === 'deposit' ? b.recorded !== false
      : kind === 'guarantee' ? b.recorded === true
      : false
    const account_id = b.account_id || null
    if (recorded) {
      const le = ledgerError({ kind: 'expense', account_id, status: '지급완료' })
      if (le) return res.status(400).json({ error: le })
    }
    /* 마감 검사는 적금에도 필요하다. 거래를 안 만들어도, 마감된 달을 가입일로 잡으면
     * 1회차 예정일이 그 달이 되어 납입이 영구히 거절된다(회차를 건너뛸 수 없다).
     * 되돌릴 수 없는 상태의 적금이 남는다. */
    const ce = await closedPeriodError(conn, start_date)
    if (ce) return res.status(400).json({ error: ce })

    const id = randomUUID()
    const acct_code = b.acct_code || defaultAcctCode(kind, term_months)
    const pay_day = intOf(b.pay_day) || Number(String(start_date).slice(8, 10)) || 1
    const maturity_date = maturityDateOf({ start_date, term_months })

    await conn.beginTransaction()
    let txn_id = null
    if (recorded) {
      // 예치금은 **자산 이동**이지 비용이 아니다 — 계정과목을 금융상품으로 붙여 손익에서 빠지게 한다
      txn_id = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, doc_no, memo, account_code, savings_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txn_id, 'expense', b.vendor_id || null, account_id,
         kind === 'guarantee' ? '보증금 예치' : '예금 예치', principal, start_date,
         '계좌이체', '지급완료', '공통', `${name} ${kind === 'guarantee' ? '지급' : '가입'}`, acct_code, id])
    }
    await conn.execute(
      `INSERT INTO savings (id, name, bank, vendor_id, kind, principal, monthly_amount, annual_rate,
                            term_months, start_date, pay_day, maturity_date, account_id, acct_code,
                            acct_code_interest, status, memo, txn_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
      [id, name, b.bank || '', b.vendor_id || null, kind, principal, monthly_amount, numOf(b.annual_rate),
       term_months, start_date, pay_day, maturity_date, account_id, acct_code,
       b.acct_code_interest || ACCT.interest, b.memo || '', txn_id])
    /* 예정 회차를 바로 깐다(차입금과 같은 규칙).
       이 호출이 없어서 savings_payments 에 예정 행이 **한 번도 생기지 않았다** —
       회차 수정 화면이 늘 404 였고, 파일 머리말이 선언한 "은행 통보액·휴일 이체일로
       고칠 자리"가 실현되지 않았다. */
    await writePlannedPayments(conn, {
      id, kind, monthly_amount, term_months, start_date, pay_day,
    })
    await conn.commit()
    res.json({ id })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body
    const [[cur]] = await req.db.execute('SELECT * FROM savings WHERE id = ?', [req.params.id])
    if (!cur) return res.status(404).json({ error: 'Not found' })
    if (cur.status !== 'active') return res.status(409).json({ error: '이미 만기·해지된 상품은 수정할 수 없어요' })
    // 이미 납입 실적이 있으면 금액·기간을 바꿀 수 없다 — 바꾸면 지난 회차와 어긋난다
    const [[{ cnt }]] = await req.db.execute(
      'SELECT COUNT(*) AS cnt FROM savings_payments WHERE savings_id = ? AND paid_date IS NOT NULL', [req.params.id])
    /* 보증금은 기간을 0으로 못 박는다. 폼이 기본값 12를 같이 보내는데 그대로 받으면
       만기일이 생겨 '만기 D-30' 같은 안내가 뜬다 — 보증금에 만기는 없다. */
    const term_months = cur.kind === 'guarantee' ? 0 : (intOf(b.term_months) || cur.term_months)
    const monthly_amount = intOf(b.monthly_amount) || cur.monthly_amount
    if (cnt > 0 && (term_months !== cur.term_months || monthly_amount !== Number(cur.monthly_amount))) {
      return res.status(409).json({
        error: `이미 ${cnt}회차를 납입해서 금액·기간은 바꿀 수 없어요. 조건이 달라졌다면 해지 후 새로 등록해주세요.` })
    }
    /* 예금 예치 금액 — 화면은 편집할 수 있게 그리는데 UPDATE 문에 없어서 조용히 무시됐다
     * ("수정했어요"는 뜨는데 금액은 그대로). 가입 출금 거래도 함께 맞춰야 잔액이 안 어긋난다.
     * 보증금도 목돈이라 같은 자리를 쓴다 — 여기서 적금과 한 덩어리로 묶으면 수정할 때마다
     * 보증금 금액이 0으로 지워진다. */
    const lumpSum = cur.kind !== 'installment'          // 예금·보증금 = 목돈 / 적금 = 월 납입
    const principal = lumpSum ? (intOf(b.principal) || Number(cur.principal)) : 0
    if (lumpSum && principal <= 0) {
      return res.status(400).json({ error: cur.kind === 'guarantee' ? '보증금 금액을 입력해주세요' : '예치 금액을 입력해주세요' })
    }
    // 이율은 numOf 가 빈 값을 0으로 만든다 — 일부 필드만 보낸 요청에서 이율이 조용히 사라졌다
    const annual_rate = b.annual_rate != null && String(b.annual_rate) !== ''
      ? numOf(b.annual_rate) : Number(cur.annual_rate)
    // 기간이 1년을 넘나들면 회계 분류(단기↔장기 금융상품)도 따라가야 한다
    const acct_code = b.acct_code
      || (term_months !== cur.term_months ? defaultAcctCode(cur.kind, term_months) : cur.acct_code)

    const conn = await req.db.getConnection()
    try {
      await conn.beginTransaction()
      await conn.execute(
        `UPDATE savings SET name=?, bank=?, vendor_id=?, principal=?, annual_rate=?, term_months=?, monthly_amount=?,
                pay_day=?, maturity_date=?, account_id=?, acct_code=?, memo=? WHERE id=?`,
        [String(b.name || cur.name).trim(), b.bank ?? cur.bank, b.vendor_id ?? cur.vendor_id,
         principal, annual_rate, term_months, monthly_amount,
         intOf(b.pay_day) || cur.pay_day,
         maturityDateOf({ start_date: cur.start_date, term_months }),
         b.account_id ?? cur.account_id, acct_code, b.memo ?? cur.memo, req.params.id])
      /* 납입 조건이 바뀌면 예정 회차를 다시 깐다(이미 낸 회차는 그대로 둔다) */
      if (cur.kind === 'installment' &&
          (term_months !== Number(cur.term_months) || monthly_amount !== Number(cur.monthly_amount)
           || (intOf(b.pay_day) || cur.pay_day) !== Number(cur.pay_day))) {
        await writePlannedPayments(conn, {
          id: req.params.id, kind: cur.kind, monthly_amount, term_months,
          start_date: cur.start_date, pay_day: intOf(b.pay_day) || cur.pay_day,
        })
      }
      // 예치 금액이 바뀌면 가입 출금 거래도 같은 금액으로 — 안 맞추면 계좌 잔액이 어긋난다
      if (lumpSum && cur.txn_id && principal !== Number(cur.principal)) {
        const [[txn]] = await conn.execute('SELECT date FROM transactions WHERE id = ?', [cur.txn_id])
        if (txn) {
          const ce = await closedPeriodError(conn, txn.date)
          if (ce) { await rollbackQuietly(conn); conn.release(); return res.status(400).json({ error: ce }) }
          await conn.execute('UPDATE transactions SET amount = ?, account_code = ? WHERE id = ?',
            [principal, acct_code, cur.txn_id])
        }
      }
      await conn.commit()
      res.json({ ok: true })
    } catch (e) { await rollbackQuietly(conn); throw e }
    finally { conn.release() }
  } catch (e) { next(e) }
})

/**
 * 삭제 — 잘못 만든 것을 되무르는 용도.
 *
 * ⚠ 가입 출금 거래(예금)를 **반드시 함께 지운다.** 안 지우면 통장에서 돈은 나갔는데 그 돈을
 *   담고 있던 상품이 사라져, 자금일보의 '묶인 자금'에서 증발한다(가용도 아니고 묶인 것도
 *   아닌 돈이 되어 총자산이 그만큼 과소계상). transactions.savings_id 는 FK가 아니라
 *   거래가 알아서 지워지지 않는다. 차입금 삭제(routes/finance.js)가 실행 거래를 함께
 *   지우는 것과 같은 이유다.
 *
 *   예금은 savings_payments 행이 구조적으로 0건이라(회차가 없다) 기존 가드가 항상 통과했다.
 *
 * ⚠ 트랜잭션 + FOR UPDATE — 건수 확인과 삭제 사이에 다른 요청이 납입을 커밋하면
 *   CASCADE로 회차만 지워지고 지출 거래는 남는다.
 */
router.delete('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[s]] = await conn.execute('SELECT * FROM savings WHERE id = ? FOR UPDATE', [req.params.id])
    if (!s) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    if (s.status !== 'active') {
      await rollbackQuietly(conn)
      return res.status(409).json({ error: '이미 만기·해지된 상품은 삭제할 수 없어요. 기록으로 남겨두세요.' })
    }
    const [[{ cnt }]] = await conn.execute(
      'SELECT COUNT(*) AS cnt FROM savings_payments WHERE savings_id = ? AND paid_date IS NOT NULL', [req.params.id])
    if (cnt > 0) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `납입 실적 ${cnt}건이 있어 삭제할 수 없어요. 잘못 만든 게 아니라면 해지로 처리해주세요.` })
    }
    // 예금 가입 출금 거래 — 마감된 달이면 지울 수 없다(장부가 이미 확정됐다)
    if (s.txn_id) {
      const [[txn]] = await conn.execute('SELECT date FROM transactions WHERE id = ?', [s.txn_id])
      if (txn) {
        const ce = await closedPeriodError(conn, txn.date)
        if (ce) { await rollbackQuietly(conn); return res.status(400).json({ error: ce }) }
        await conn.execute('DELETE FROM transactions WHERE id = ?', [s.txn_id])
      }
    }
    await conn.execute('DELETE FROM savings WHERE id = ?', [req.params.id])
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/**
 * 회차 납입을 실제로 반영한다 — 건별·일괄이 같은 코드를 쓰게 떼어냈다.
 * 납입액은 **자산 증가**라 손익이 아니다(계정과목을 금융상품으로 붙인다).
 * 호출 전 검사(회차 순서·미래일자·마감·계좌)는 라우트가 한다.
 */
async function applyPayment(conn, s, cycle, { payDate, acct }) {
  const txnId = randomUUID()
  await conn.execute(
    `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, doc_no, memo, account_code, savings_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [txnId, 'expense', s.vendor_id || null, acct, '적금 납입', cycle.amount, payDate,
     '계좌이체', '지급완료', '공통', `${s.name} ${cycle.seq}회차 납입`, s.acct_code || ACCT.shortTerm, s.id])
  await conn.execute(
    `INSERT INTO savings_payments (id, savings_id, seq, due_date, amount, paid_date, txn_id)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE paid_date=VALUES(paid_date), amount=VALUES(amount), txn_id=VALUES(txn_id)`,
    [randomUUID(), s.id, cycle.seq, cycle.due_date, cycle.amount, payDate, txnId])
  return txnId
}

/**
 * 예정 회차 수정 — 자동이체 금액이 바뀌거나 이체일이 휴일로 밀렸을 때 맞춘다.
 * 이미 낸 회차는 거절한다(오간 돈의 기록이라, 고치려면 납입을 취소하고 다시 처리해야
 * 거래 금액까지 함께 맞는다). 차입금의 같은 API 와 규칙을 맞췄다.
 */
router.patch('/:id/cycles/:seq', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[row]] = await conn.execute(
      'SELECT * FROM savings_payments WHERE savings_id = ? AND seq = ? FOR UPDATE',
      [req.params.id, req.params.seq])
    if (!row) { await rollbackQuietly(conn); return res.status(404).json({ error: '그 회차를 찾을 수 없어요' }) }
    if (row.paid_date) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `이미 ${row.paid_date}에 납입 처리한 회차예요. 금액을 고치려면 납입을 취소한 뒤 다시 처리해주세요.`,
      })
    }
    const amount  = req.body.amount != null && req.body.amount !== '' ? intOf(req.body.amount) : Number(row.amount)
    const dueDate = req.body.due_date || row.due_date
    if (amount < 0) { await rollbackQuietly(conn); return res.status(400).json({ error: '납입액은 0 이상이어야 해요' }) }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {   // \d 이스케이프가 빠져 어떤 날짜도 통과 못 했다
      await rollbackQuietly(conn); return res.status(400).json({ error: '예정일을 날짜로 입력해주세요' })
    }
    await conn.execute('UPDATE savings_payments SET due_date=?, amount=? WHERE savings_id = ? AND seq = ?',
      [dueDate, amount, req.params.id, req.params.seq])
    await conn.commit()
    res.json({ ok: true, seq: Number(req.params.seq), due_date: dueDate, amount })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/** 회차 납입(건별) */
router.post('/:id/pay', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    // 잠금 — 같은 회차를 두 번 눌러 이중 출금이 나는 것을 막는다(대출 상환과 같은 이유)
    const [[s]] = await conn.execute('SELECT * FROM savings WHERE id = ? FOR UPDATE', [req.params.id])
    if (!s) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    if (s.status !== 'active') { await rollbackQuietly(conn); return res.status(409).json({ error: '만기·해지된 상품이에요' }) }
    if (s.kind !== 'installment') { await rollbackQuietly(conn); return res.status(400).json({ error: '예금은 납입 회차가 없어요' }) }

    const payDate = req.body.pay_date || kstToday()
    const acct = req.body.account_id || s.account_id
    const le = ledgerError({ kind: 'expense', account_id: acct, status: '지급완료' })
    if (le) { await rollbackQuietly(conn); return res.status(400).json({ error: le }) }
    const fe = futureDateError(payDate)
    if (fe) { await rollbackQuietly(conn); return res.status(400).json({ error: fe }) }
    if (payDate < s.start_date) {
      await rollbackQuietly(conn)
      return res.status(400).json({ error: `납입일이 가입일(${s.start_date})보다 빠를 수 없어요` })
    }
    const ce = await closedPeriodError(conn, payDate)
    if (ce) { await rollbackQuietly(conn); return res.status(400).json({ error: ce }) }

    const unpaid = await unpaidPaymentsOf(conn, s)
    if (!unpaid.length) { await rollbackQuietly(conn); return res.status(409).json({ error: '남은 회차가 없어요' }) }
    // 순서를 건너뛸 수 없다 — 건너뛰면 누계가 어긋나고 되돌리기 어렵다
    const cycle = req.body.seq ? unpaid.find(c => c.seq === Number(req.body.seq)) : unpaid[0]
    if (!cycle) { await rollbackQuietly(conn); return res.status(400).json({ error: '이미 납입했거나 없는 회차예요' }) }
    if (cycle.seq !== unpaid[0].seq) {
      await rollbackQuietly(conn)
      return res.status(400).json({ error: `${unpaid[0].seq}회차부터 순서대로 처리해주세요` })
    }

    await applyPayment(conn, s, cycle, { payDate, acct })
    await conn.commit()
    res.json({ ok: true, seq: cycle.seq, amount: cycle.amount })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/**
 * 놓친 납입 일괄 처리 — 예정일이 지났는데 처리하지 않은 회차를 순서대로 모두 반영한다.
 * 마감된 달이 하나라도 섞이면 **전체를 거절한다**(대출과 같은 규칙).
 * 순서를 건너뛸 수 없으므로 일부만 처리하면 남은 회차를 영영 못 넣게 된다.
 */
router.post('/:id/pay-missed', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[s]] = await conn.execute('SELECT * FROM savings WHERE id = ? FOR UPDATE', [req.params.id])
    if (!s) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    // /pay 와 같은 검사 — 여기만 빠져 있어 만기 처리된 상품에 납입이 더 들어갈 수 있었다
    // (다른 탭에서 만기를 누른 뒤, 이미 열어둔 일괄 드로어를 저장하는 경우).
    // 그 돈은 계좌에서 나가지만 묶인 자금에는 안 잡혀(active만 센다) 총자산이 그만큼 준다.
    if (s.status !== 'active') { await rollbackQuietly(conn); return res.status(409).json({ error: '만기·해지된 상품이에요' }) }
    if (s.kind !== 'installment') { await rollbackQuietly(conn); return res.status(400).json({ error: '예금은 납입 회차가 없어요' }) }
    const acct = req.body.account_id || s.account_id
    const le = ledgerError({ kind: 'expense', account_id: acct, status: '지급완료' })
    if (le) { await rollbackQuietly(conn); return res.status(400).json({ error: le }) }

    const today = kstToday()
    const missed = (await unpaidPaymentsOf(conn, s)).filter(c => c.due_date <= today)
    if (!missed.length) { await rollbackQuietly(conn); return res.json({ ok: true, count: 0 }) }

    for (const c of missed) {
      const ce = await closedPeriodError(conn, c.due_date)
      if (ce) {
        await rollbackQuietly(conn)
        return res.status(400).json({ error: `${c.seq}회차(${c.due_date})가 마감된 달이라 전체를 처리하지 않았어요. ${ce}` })
      }
    }
    for (const c of missed) await applyPayment(conn, s, c, { payDate: c.due_date, acct })
    await conn.commit()
    res.json({ ok: true, count: missed.length, total: missed.reduce((a, c) => a + c.amount, 0) })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/**
 * 만기 수령 — 원금과 이자를 **두 거래로 나눈다**.
 * 원금은 자산 회수(손익 아님), 이자는 이자수익(손익). 한 건으로 뭉치면 원금까지 수익이 되어
 * 매출이 부풀려진다. 대출 상환에서 원금·이자를 나눈 것과 정확히 같은 이유다.
 */
router.post('/:id/mature', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[s]] = await conn.execute('SELECT * FROM savings WHERE id = ? FOR UPDATE', [req.params.id])
    if (!s) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    if (s.status !== 'active') { await rollbackQuietly(conn); return res.status(409).json({ error: '이미 처리된 상품이에요' }) }

    const recvDate = req.body.received_date || kstToday()
    const acct = req.body.account_id || s.account_id
    const le = ledgerError({ kind: 'income', account_id: acct, status: '입금완료' })
    if (le) { await rollbackQuietly(conn); return res.status(400).json({ error: le }) }
    const fe = futureDateError(recvDate)
    if (fe) { await rollbackQuietly(conn); return res.status(400).json({ error: fe }) }
    const ce = await closedPeriodError(conn, recvDate)
    if (ce) { await rollbackQuietly(conn); return res.status(400).json({ error: ce }) }

    const [payRows] = await conn.execute(
      'SELECT * FROM savings_payments WHERE savings_id = ? AND paid_date IS NOT NULL', [s.id])
    // 원금은 **실제로 넣은 만큼**만 돌려받는다. 스케줄 기준으로 잡으면 밀린 회차만큼 부풀려진다.
    const principal = paidPrincipal(s, payRows)
    if (principal <= 0) {
      await rollbackQuietly(conn)
      return res.status(400).json({ error: '납입 실적이 없어요. 먼저 납입을 기록해주세요.' })
    }
    /* 이자는 실제 수령액을 받는다(우대금리·중도해지로 예상과 다를 수 있다).
     * 기본값은 **실제로 넣은 돈에 붙은 이자**다 — 예전엔 "끝까지 넣었을 때"(maturitySummary)를
     * 써서, 1회만 낸 적금을 만기 처리하면 12회분 이자가 들어가 이자수익이 부풀었다. */
    const expected = accruedInterest(s, payRows, recvDate)
    const interest = req.body.interest != null ? intOf(req.body.interest) : expected
    if (interest < 0) { await rollbackQuietly(conn); return res.status(400).json({ error: '이자는 음수일 수 없어요' }) }
    /* 자릿수 오타 방어 — 260,000을 2,600,000으로 치면 이자수익이 부풀고 되돌리기 어렵다.
     * 약속대로 끝까지 넣었을 때의 이자를 상한으로 본다(우대금리를 감안해 1.5배까지). */
    const ceiling = Math.max(Math.round(maturitySummary(s).interest * 1.5), 10000)
    if (interest > ceiling) {
      await rollbackQuietly(conn)
      return res.status(400).json({
        error: `이자 ${intOf(interest).toLocaleString('ko-KR')}원은 이 상품에서 나올 수 있는 금액을 넘어요`
             + ` (예상 ${expected.toLocaleString('ko-KR')}원). 자릿수를 확인해주세요.` })
    }

    const mkTxn = async (amount, category, acctCode, memo) => {
      if (amount <= 0) return null
      const id = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, doc_no, memo, account_code, savings_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, 'income', s.vendor_id || null, acct, category, amount, recvDate,
         '계좌이체', '입금완료', '공통', memo, acctCode, s.id])
      return id
    }
    // 원금 = 금융상품 회수(자산↔자산, 손익 아님) / 이자 = 이자수익(손익)
    // 보증금은 '만기'가 아니라 **계약이 끝나 돌려받는 것**이라 거래 이름을 달리 적는다
    const back = s.kind === 'guarantee'
    const txnP = await mkTxn(principal, back ? '보증금 반환' : '예적금 만기',
      s.acct_code || ACCT.shortTerm, `${s.name} ${back ? '반환' : '만기 원금'}`)
    const txnI = await mkTxn(interest, '이자수익', s.acct_code_interest || ACCT.interest, `${s.name} 만기 이자`)

    await conn.execute(
      "UPDATE savings SET status='matured', matured_at=?, txn_maturity_id=?, txn_interest_id=? WHERE id=?",
      [recvDate, txnP, txnI, s.id])
    await conn.commit()
    res.json({ ok: true, principal, interest, total: principal + interest })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

module.exports = router
