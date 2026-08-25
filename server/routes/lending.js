const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError, amountError } = require('../lib/ledger')
const { closedPeriodError } = require('../lib/closing')
/* ⚠ 일정 계산은 **차입금과 같은 함수**를 쓴다(lib/loan.js). 원리금 공식은 돈의 방향과
   무관하고, 두 벌로 두면 한쪽만 고쳐져 같은 조건에서 다른 숫자가 나온다. */
const { METHODS, isNoSchedule, repaymentSchedule, unpaidCycles, remainingPrincipal, scheduleTotals } = require('../lib/loan')
const { moneyOf: intOf } = require('../lib/money')

const router = Router()

/* ── 대여금 — 우리가 **빌려준** 돈 ─────────────────────────────────
 *
 * 차입금(loans)의 거울상이다. 돈의 방향과 계정만 반대고 나머지는 같다:
 *   차입  실행=입금(부채↑) · 상환=출금 · 이자=비용(5301)
 *   대여  실행=출금(자산↑) · 회수=입금 · 이자=수익(4201)
 *
 * ⚠ 테이블을 가른 이유는 db.js lendings 주석 참고 —
 *   한 테이블에 direction 으로 두면 필터 한 곳만 빠져도 **부채가 자산으로 뒤집힌다.**
 *
 * ⚠ 원금과 이자는 **반드시 나눠 기록한다.** 원금 회수는 자산이 통장으로 돌아온 것뿐이라
 *   손익이 아니고, 이자만 수익이다. 합쳐서 넣으면 원금까지 매출로 잡혀 손익이 부푼다
 *   (lib/pnl.js 가 계정과목 대분류로 가르므로, 계정만 제대로 달면 자동으로 갈린다).
 */
const ACCT = {
  short:    '1301',   // 단기대여금(자산)
  long:     '1503',   // 장기대여금(자산)
  interest: '4201',   // 이자수익(수익)
}

const methodOf = (v) => (METHODS.includes(v) ? v : 'bullet')
/** 대여 기간이 1년을 넘으면 장기대여금 — 재무상태표의 유동/비유동이 갈린다 */
const principalCode = (termMonths) => (Number(termMonths) > 12 ? ACCT.long : ACCT.short)

/** 저장된 예정 회차 + 아직 안 만든 회차를 합쳐 '지금 시점의 일정'을 만든다(차입금과 같은 방식) */
async function scheduleOf(db, l) {
  const [rows] = await db.execute(
    'SELECT * FROM lending_repayments WHERE lending_id = ? ORDER BY seq', [l.id])
  const saved = new Map(rows.map(r => [Number(r.seq), r]))
  const base = isNoSchedule(l) ? [] : repaymentSchedule(l)
  const out = base.map(c => {
    const s = saved.get(c.seq)
    return s
      ? { seq: c.seq, due_date: s.due_date, principal: Number(s.principal), interest: Number(s.interest),
          paid_date: s.paid_date || null }
      : { ...c, paid_date: null }
  })
  /* 일정 밖의 회차(수시 회수)도 실린다 — 만기일시·무일정 대여는 그때그때 갚아 오는 일이 흔한데,
     그것을 안 보여주면 "받은 돈이 어디 갔나"가 된다. */
  for (const r of rows) {
    if (out.some(c => c.seq === Number(r.seq))) continue
    out.push({ seq: Number(r.seq), due_date: r.due_date, principal: Number(r.principal),
               interest: Number(r.interest), paid_date: r.paid_date || null })
  }
  return out.sort((a, b) => a.seq - b.seq)
}

/** 목록·상세에 붙이는 집계 — 얼마 빌려주고 얼마 돌려받았나 */
async function withMetrics(db, l) {
  const sch = await scheduleOf(db, l)
  const collectedP = sch.filter(c => c.paid_date).reduce((s, c) => s + c.principal, 0)
  const collectedI = sch.filter(c => c.paid_date).reduce((s, c) => s + c.interest, 0)
  /* ⚠ scheduleTotals 는 **일정 배열이 아니라 대여 객체**를 받는다(안에서 스케줄을 다시 만든다).
     배열을 넘기면 조용히 0 이 나온다 — 에러가 안 나서 화면에 '총이자 0원'이 그냥 떴다. */
  const totals = isNoSchedule(l) ? { principal: Number(l.principal), interest: 0 } : scheduleTotals(l)
  return {
    ...l,
    schedule: sch,
    collected_principal: collectedP,
    collected_interest: collectedI,
    // 남은 원금 = 빌려준 원금 − 돌려받은 원금. 아직 못 받은 돈이다.
    remain_principal: Math.max(0, Number(l.principal) - collectedP),
    total_interest: totals.interest,
    overdue: sch.filter(c => !c.paid_date && c.due_date <= kstToday()).length,
  }
}

// ── 목록 ──
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT l.*, v.name AS vendor_name, a.name AS account_name
         FROM lendings l
         LEFT JOIN vendors v ON l.vendor_id = v.id
         LEFT JOIN accounts a ON l.account_id = a.id
        ORDER BY l.status, l.start_date DESC`)
    res.json(await Promise.all(rows.map(r => withMetrics(req.db, r))))
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [[l]] = await req.db.execute(
      `SELECT l.*, v.name AS vendor_name, a.name AS account_name
         FROM lendings l
         LEFT JOIN vendors v ON l.vendor_id = v.id
         LEFT JOIN accounts a ON l.account_id = a.id
        WHERE l.id = ?`, [req.params.id])
    if (!l) return res.status(404).json({ error: 'Not found' })
    res.json(await withMetrics(req.db, l))
  } catch (e) { next(e) }
})

/* 미리보기 — 저장 전에 "매달 얼마씩 몇 번" 을 보여준다.
   숫자를 보고 나서 조건을 고칠 수 있어야 한다. 저장한 뒤 확인하면 지우고 다시 만들게 된다. */
router.post('/preview', (req, res) => {
  const b = req.body || {}
  const l = {
    principal: intOf(b.principal), annual_rate: Number(b.annual_rate) || 0,
    method: methodOf(b.method), term_months: parseInt(b.term_months, 10) || 12,
    start_date: b.start_date, pay_day: parseInt(b.pay_day, 10) || 1,
  }
  const sch = isNoSchedule(l) ? [] : repaymentSchedule(l)
  // scheduleTotals 는 대여 객체를 받는다(위 withMetrics 주석 참조) — 배열을 넘기면 0 이 나온다
  const totals = isNoSchedule(l)
    ? { months: 0, principal: intOf(b.principal), interest: 0, total: intOf(b.principal) }
    : scheduleTotals(l)
  res.json({ schedule: sch, totals })
})

// ── 등록 — 통장에서 돈이 나가고 대여금(자산)이 늘어난다 ──
router.post('/', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const b = req.body || {}
    const principal = intOf(b.principal)
    const ae = amountError(principal)
    if (ae) return res.status(400).json({ error: ae })
    if (!b.start_date) return res.status(400).json({ error: '대여일을 입력해주세요' })
    const de = futureDateError(b.start_date)
    if (de) return res.status(400).json({ error: de })

    const termMonths = parseInt(b.term_months, 10) || 12
    /* 거래를 만들지 **끌지** 고르게 한다.
       몇 년 전에 빌려준 돈을 뒤늦게 등록하는 일이 흔한데, 그때 이미 찍힌 출금과 겹치면
       계좌 잔액이 두 번 빠진다(예적금·보증금 등록에서 같은 이유로 그렇게 했다). */
    const recorded = b.recorded !== false
    const accountId = b.account_id || null
    if (recorded) {
      const le = ledgerError({ kind: 'expense', account_id: accountId, status: '지급완료' })
      if (le) return res.status(400).json({ error: le })
    }

    await conn.beginTransaction()
    if (recorded) {
      const ce = await closedPeriodError(conn, b.start_date)
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
    }

    const id = randomUUID()
    const acctP = b.acct_code_principal || principalCode(termMonths)
    let txnId = null
    if (recorded) {
      txnId = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, doc_no, memo, account_code)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txnId, 'expense', b.vendor_id || null, accountId, '대여금 지급', principal, b.start_date,
         '계좌이체', '지급완료', '공통', `${b.name || '대여금'} 대여`, acctP])
    }
    await conn.execute(
      `INSERT INTO lendings (id, name, borrower, vendor_id, principal, annual_rate, method, term_months,
        start_date, pay_day, end_date, account_id, acct_code_principal, acct_code_interest, memo, txn_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.name || '대여금', b.borrower || '', b.vendor_id || null, principal,
       Number(b.annual_rate) || 0, methodOf(b.method), termMonths, b.start_date,
       parseInt(b.pay_day, 10) || 1, b.end_date || null, accountId,
       acctP, b.acct_code_interest || ACCT.interest, b.memo || '', txnId])
    await conn.commit()
    res.json({ id })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {}
    const termMonths = parseInt(b.term_months, 10) || 12
    const [r] = await req.db.execute(
      `UPDATE lendings SET name=?, borrower=?, vendor_id=?, principal=?, annual_rate=?, method=?,
        term_months=?, start_date=?, pay_day=?, end_date=?, account_id=?, memo=? WHERE id=?`,
      [b.name || '대여금', b.borrower || '', b.vendor_id || null, intOf(b.principal),
       Number(b.annual_rate) || 0, methodOf(b.method), termMonths, b.start_date,
       parseInt(b.pay_day, 10) || 1, b.end_date || null, b.account_id || null,
       b.memo || '', req.params.id])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/* 회수 처리 — 원금과 이자를 **각각** 거래로 남긴다.
 *
 * ⚠ 회차 판정부터 거래 생성까지 한 트랜잭션 안에서 대여 행을 FOR UPDATE 로 잠근 뒤 한다.
 *   두 창에서 같은 회차를 누르면 잠금이 없을 때 **같은 돈이 두 번 입금**된다
 *   (차입금 상환에서 겪은 것과 같은 자리다). */
async function applyCollect(conn, l, cycle, { payDate, acct }) {
  const mkTxn = async (amount, category, acctCode, memo) => {
    if (amount <= 0) return null
    const id = randomUUID()
    await conn.execute(
      `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, doc_no, memo, account_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, 'income', l.vendor_id || null, acct, category, amount, payDate,
       '계좌이체', '입금완료', '공통', memo, acctCode])
    return id
  }
  const label = `${l.name} ${cycle.seq}회차`
  // 원금 = 자산 회수(손익 아님) / 이자 = 이자수익(손익) — 반드시 나눈다
  const txnP = await mkTxn(cycle.principal, '대여금 회수', l.acct_code_principal || ACCT.short, `${label} 원금`)
  const txnI = await mkTxn(cycle.interest, '이자수익', l.acct_code_interest || ACCT.interest, `${label} 이자`)
  await conn.execute(
    `INSERT INTO lending_repayments (id, lending_id, seq, due_date, principal, interest, paid_date, txn_principal_id, txn_interest_id)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE paid_date=VALUES(paid_date), principal=VALUES(principal),
       interest=VALUES(interest), txn_principal_id=VALUES(txn_principal_id), txn_interest_id=VALUES(txn_interest_id)`,
    [randomUUID(), l.id, cycle.seq, cycle.due_date, cycle.principal, cycle.interest, payDate, txnP, txnI])
  return { txnP, txnI }
}

/** 원금을 다 받았으면 종료로 표시한다 — 다 받은 대여가 계속 '진행중'으로 남으면 목록이 안 줄어든다 */
async function closeIfSettled(conn, l) {
  const [[{ got }]] = await conn.execute(
    'SELECT COALESCE(SUM(principal),0) AS got FROM lending_repayments WHERE lending_id = ? AND paid_date IS NOT NULL',
    [l.id])
  if (Number(got) >= Number(l.principal)) {
    await conn.execute("UPDATE lendings SET status='closed' WHERE id = ?", [l.id])
  }
}

router.post('/:id/collect', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[l]] = await conn.execute('SELECT * FROM lendings WHERE id = ? FOR UPDATE', [req.params.id])
    if (!l) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }

    const sch = await scheduleOf(conn, l)
    /* ⚠ unpaidCycles 도 **대여 객체 + 처리된 회차번호**를 받는다(lib/loan.js:99).
       일정 배열을 넘기면 안에서 repaymentSchedule(배열) 을 돌려 빈 배열이 나오고,
       화면에는 "남은 회차가 없어요" 만 뜬다 — 실제로 그렇게 만들어 확인했다.
       scheduleTotals 와 같은 실수다. 저장된 회차(=이미 받은 것)를 빼고 남은 것을 구한다. */
    const paidSeqs = sch.filter(c => c.paid_date).map(c => c.seq)
    const unpaid = unpaidCycles(l, paidSeqs)
    if (!unpaid.length) { await rollbackQuietly(conn); return res.status(409).json({ error: '남은 회차가 없어요' }) }
    const target = req.body.seq ? unpaid.find(c => c.seq === Number(req.body.seq)) : unpaid[0]
    if (!target) { await rollbackQuietly(conn); return res.status(400).json({ error: '이미 받았거나 없는 회차예요' }) }
    /* 순서를 건너뛸 수 없다 — 건너뛰면 남은 원금 누계가 어긋나고 되돌리기 어렵다
       (차입금 상환과 같은 규칙). */
    if (target.seq !== unpaid[0].seq) {
      await rollbackQuietly(conn)
      return res.status(400).json({ error: `${unpaid[0].seq}회차부터 순서대로 처리해주세요` })
    }

    const payDate = req.body.date || kstToday()
    const de = futureDateError(payDate)
    if (de) { await rollbackQuietly(conn); return res.status(400).json({ error: de }) }
    const ce = await closedPeriodError(conn, payDate)
    if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
    const acct = req.body.account_id || l.account_id
    const le = ledgerError({ kind: 'income', account_id: acct, status: '입금완료' })
    if (le) { await rollbackQuietly(conn); return res.status(400).json({ error: le }) }

    await applyCollect(conn, l, target, { payDate, acct })
    await closeIfSettled(conn, l)
    await conn.commit()
    res.json({ ok: true, seq: target.seq, principal: target.principal, interest: target.interest })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/* 수시 회수 — 일정 밖에서 받은 돈.
 * 만기일시·무일정 대여는 "여유될 때 조금씩" 갚아 오는 일이 흔하다. 그것을 넣을 자리가
 * 없으면 사용자가 회차 금액을 억지로 고치게 되고, 그러면 일정과 실제가 둘 다 틀어진다. */
router.post('/:id/collect-adhoc', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[l]] = await conn.execute('SELECT * FROM lendings WHERE id = ? FOR UPDATE', [req.params.id])
    if (!l) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }

    const principal = intOf(req.body.principal)
    const interest = intOf(req.body.interest)
    if (principal + interest <= 0) {
      await rollbackQuietly(conn); return res.status(400).json({ error: '받은 금액을 입력해주세요' })
    }
    /* 빌려준 것보다 많이 받았다고 기록할 수는 없다 — 남은 원금을 넘는 회수는 거절한다.
       잘라서 기록하면 통장에 들어온 돈과 장부가 조용히 어긋난다(청구서 정산과 같은 규칙). */
    const sch = await scheduleOf(conn, l)
    const got = sch.filter(c => c.paid_date).reduce((s, c) => s + c.principal, 0)
    const remain = Number(l.principal) - got
    if (principal > remain) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `남은 원금은 ${remain.toLocaleString('ko-KR')}원이에요`
             + `(${principal.toLocaleString('ko-KR')}원 입력). 이자는 따로 넣어주세요.` })
    }

    const payDate = req.body.date || kstToday()
    const de = futureDateError(payDate)
    if (de) { await rollbackQuietly(conn); return res.status(400).json({ error: de }) }
    const ce = await closedPeriodError(conn, payDate)
    if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
    const acct = req.body.account_id || l.account_id
    const le = ledgerError({ kind: 'income', account_id: acct, status: '입금완료' })
    if (le) { await rollbackQuietly(conn); return res.status(400).json({ error: le }) }

    // 일정 회차와 번호가 겹치지 않게 뒤쪽 번호를 준다(수시 회수는 일정 밖이다)
    const [[{ maxseq }]] = await conn.execute(
      'SELECT COALESCE(MAX(seq),0) AS maxseq FROM lending_repayments WHERE lending_id = ?', [l.id])
    const base = isNoSchedule(l) ? [] : repaymentSchedule(l)
    const seq = Math.max(Number(maxseq), base.length) + 1

    await applyCollect(conn, l, { seq, due_date: payDate, principal, interest }, { payDate, acct })
    await closeIfSettled(conn, l)
    await conn.commit()
    res.json({ ok: true, seq, principal, interest })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/* 회수 취소 — 거래까지 함께 지운다.
 * 거래만 남기면 "받았다고 표시는 안 됐는데 통장에는 들어온" 상태가 되어 잔액이 안 맞는다. */
router.delete('/:id/collect/:seq', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[row]] = await conn.execute(
      'SELECT * FROM lending_repayments WHERE lending_id = ? AND seq = ? FOR UPDATE',
      [req.params.id, req.params.seq])
    if (!row) { await rollbackQuietly(conn); return res.status(404).json({ error: '그 회차를 찾을 수 없어요' }) }
    if (!row.paid_date) { await rollbackQuietly(conn); return res.status(409).json({ error: '아직 받지 않은 회차예요' }) }
    const ce = await closedPeriodError(conn, row.paid_date)
    if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }

    for (const t of [row.txn_principal_id, row.txn_interest_id]) {
      if (t) await conn.execute('DELETE FROM transactions WHERE id = ?', [t])
    }
    /* 일정에 있는 회차면 '안 받은 것'으로 되돌리고, 수시 회수면 줄 자체를 지운다.
       수시 회수는 일정에 없는 회차라 남겨 두면 유령 예정이 생긴다. */
    const [[l]] = await conn.execute('SELECT * FROM lendings WHERE id = ?', [req.params.id])
    const inSchedule = !isNoSchedule(l) && Number(req.params.seq) <= repaymentSchedule(l).length
    if (inSchedule) {
      await conn.execute(
        'UPDATE lending_repayments SET paid_date=NULL, txn_principal_id=NULL, txn_interest_id=NULL WHERE id = ?',
        [row.id])
    } else {
      await conn.execute('DELETE FROM lending_repayments WHERE id = ?', [row.id])
    }
    // 다시 받을 게 생겼으므로 종료를 푼다
    await conn.execute("UPDATE lendings SET status='active' WHERE id = ?", [req.params.id])
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/* 삭제 — 받은 이력이 있으면 막는다.
 * 지우면 그 입금이 어디서 온 돈인지가 사라진다(근로계약 삭제와 같은 규칙).
 * 다 받은 대여는 '종료'로 남는다 — 기록을 지울 일이 아니다. */
router.delete('/:id', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[{ cnt }]] = await conn.execute(
      'SELECT COUNT(*) AS cnt FROM lending_repayments WHERE lending_id = ? AND paid_date IS NOT NULL',
      [req.params.id])
    if (cnt > 0) {
      await rollbackQuietly(conn)
      return res.status(409).json({
        error: `이미 ${cnt}회차를 회수한 대여예요. 지우면 그 입금이 어디서 온 돈인지 알 수 없게 됩니다.`
             + ` 다 받은 것이라면 그대로 두세요 — 종료로 표시됩니다.` })
    }
    // 실행 거래(대여금 지급)는 함께 지운다 — 대여가 없으면 그 출금도 근거를 잃는다
    const [[l]] = await conn.execute('SELECT txn_id FROM lendings WHERE id = ?', [req.params.id])
    if (l?.txn_id) await conn.execute('DELETE FROM transactions WHERE id = ?', [l.txn_id])
    await conn.execute('DELETE FROM lendings WHERE id = ?', [req.params.id])   // repayments 는 CASCADE
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

module.exports = router
