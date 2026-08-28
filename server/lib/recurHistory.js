/**
 * 정기 규칙의 **회차 이력** — 이 규칙이 지금까지 어떻게 흘러왔나.
 *
 * ── 왜 필요한가 ──
 * 정기입금·정기지급은 목록에서 행을 누르면 **수정 폼**이 열린다. 그게 전부였다.
 * 그래서 세 가지를 어디서도 알 수 없었다.
 *   1. 이 규칙이 여태 얼마를 만들어냈나 — 청구서 목록을 거래처로 걸러 눈으로 세야 했다
 *   2. 변동형 금액이 어떻게 움직였나 — 41,930 → 43,200 → 41,100 의 흐름
 *      (변동형을 만든 이유가 "이번 달 얼마였고 냈나"인데 정작 지난 달을 그 자리에서 못 봤다)
 *   3. 건너뛴 달이 있었나, 왜 — recurring_skips 에 **사유까지 저장하면서 읽는 화면이 없었다**
 *
 * 데이터는 처음부터 다 있었다. invoices.recurring_id 가 "이 청구서가 어느 규칙의 회차인가"를
 * 들고 있었는데, "청구서를 지우면 last_generated 를 되돌린다"는 용도로만 쓰고 있었다.
 *
 * ⚠ **소급분(backfill_batch)을 그냥 섞어 한 줄로 내면 안 된다.** 규칙 등록 전 회차를
 *   나중에 몰아 넣은 것이라, 표시가 없으면 "이 규칙이 그때부터 돌고 있었다"로 읽힌다.
 *
 * ⚠ 지난 회차는 **규칙에서 다시 계산하지 않고 실제 행에서 읽는다.** 규칙의 금액·주기는
 *   나중에 바뀔 수 있어서, 지금 규칙으로 과거를 되짚으면 그때 실제로 나간 금액과 달라진다.
 */

const { dueDatesToGenerate } = require('./recurrence')
const { backfillCycles } = require('./backfill')

const num = (v) => Number(v) || 0
const day = (v) => String(v || '').slice(0, 10)

/** 앞으로 볼 기간 — 목록의 '예정'과 같은 눈금이어야 두 화면이 어긋나지 않는다 */
const HISTORY_HORIZON_DAYS = 90

/* 이행률 — "지금까지 얼마를 받았어야 하는데 얼마를 받았나".
 *
 * 주문(청구일정)은 총액이 정해져 있어 진행률이 자연스럽게 나오는데, 정기 규칙은 끝이 없어서
 * 그런 눈금이 없었다. 그래서 **한 회차가 통째로 빠져도 화면 어디에도 표가 안 났다**
 * (창원YWCA 8월이 정확히 그렇게 사라졌다).
 *
 * 기산점은 **첫 회차가 실제로 만들어진 날**이다 — 규칙의 시작일이 아니다.
 * 시작일로 세면 몇 년 전 날짜로 등록한 규칙이 "수천만원 미이행"으로 뜬다.
 * 건너뛴 회차는 분모에서 뺀다. "이 달은 청구 안 함"은 못 받은 게 아니다.
 * 빠진 회차는 실물이 없으니 규칙의 현재 금액으로 어림한다(그래서 estimated 로 표시한다).
 */
function dueVsPaid(done, missing, rule, today) {
  const past = done.filter(c => c.date <= today)
  /* 빠진 회차의 금액은 **실제로 만들어진 마지막 회차**에서 가져온다.
     규칙의 supply_amount 로 세면 매출은 세액만큼 모자라고, 금액이 바뀐 규칙은 옛 값이 나온다.
     (missing 은 done 이 하나라도 있을 때만 생기므로 여기서 done 은 비지 않는다.) */
  const guess = past.length ? past[past.length - 1].total_amount : 0
  const missingAmount = missing.length * guess
  return {
    due_amount: past.reduce((s, c) => s + c.total_amount, 0) + missingAmount,
    paid_amount: past.reduce((s, c) => s + num(c.paid_amount), 0),
    missing_amount: missingAmount,
    // 빠진 회차 금액은 규칙 금액으로 어림한 값 — 화면이 그렇게 말해야 한다
    missing_estimated: missing.length > 0,
  }
}

/**
 * @param db    req.db (테넌트 풀)
 * @param kind  'invoice'(정기입금·매출) | 'expense'(정기지급·매입)
 * @param rule  규칙 행. created_epoch 이 실려 있어야 한다(setup_date 계산에 쓴다)
 * @param today 'YYYY-MM-DD' (KST)
 */
async function recurHistory(db, kind, rule, today) {
  const isInvoice = kind === 'invoice'

  /* 1. 지난 회차 — 실제로 만들어진 것.
     ⚠ **매입도 청구서(invoices)가 회차의 본체다.** 정기지급 회차는 거래가 아니라
       매입 청구서(kind='received')로 만들어지고, 지급하면 그 청구서에 거래가
       invoice_id 로 매달린다(routes/recurring.js createExpenseInvoice).
       transactions.recurring_id 를 보면 회차가 통째로 0건으로 나온다 — 실제로 그렇게
       짰다가 이력이 비어 나왔다. 회차의 진실은 양쪽 다 invoices 에 있다. */
  const [doneRows] = await db.execute(
    `SELECT i.id, i.invoice_no, i.issued_at AS date, i.due_at,
            i.supply_amount, i.vat_amount, i.total_amount, i.status,
            i.category, i.backfill_batch, i.memo, a.name AS account_name
       FROM invoices i
       LEFT JOIN accounts a ON a.id = i.account_id
      WHERE i.recurring_id = ? AND i.kind = ?
      ORDER BY i.issued_at, i.created_at`, [rule.id, isInvoice ? 'issued' : 'received'])

  const done = doneRows.map(r => ({
    state: 'done',
    id: r.id,
    date: day(r.date),
    supply_amount: num(r.supply_amount),
    vat_amount: num(r.vat_amount),
    total_amount: num(r.total_amount),
    status: r.status || '',
    due_at: day(r.due_at),
    invoice_no: r.invoice_no || '',
    category: r.category || '',
    account_name: r.account_name || '',
    memo: r.memo || '',
    // 소급으로 넣은 회차인지 — 안 밝히면 "그때부터 돌고 있었다"로 읽힌다
    backfilled: !!r.backfill_batch,
  }))

  /* 2. 건너뛴 회차 — 저장만 하고 아무도 안 보던 데이터 */
  const [skipRows] = await db.execute(
    'SELECT due_date, reason, created_at FROM recurring_skips WHERE kind = ? AND recurring_id = ? ORDER BY due_date',
    [kind, rule.id])
  /* ⚠ 같은 날짜에 청구서도 있고 건너뜀 기록도 있을 수 있다. 소급 등록은 건너뛴 달을
     걸러내지 않아서(routes 의 preview 가 r.skips 를 안 채운다), 건너뛴 뒤 그 기간을
     소급하면 둘이 겹친다. **청구서가 이겼다** — 돈이 실제로 오간 쪽이 진실이고,
     건너뜀 기록은 그 순간 효력을 잃은 것이다. 두 줄로 내면 같은 달이 두 번 나온다. */
  const doneDays = new Set(done.map(c => c.date))
  const skipped = skipRows
    .map(s => ({ state: 'skipped', date: day(s.due_date), reason: s.reason || '' }))
    .filter(s => !doneDays.has(s.date))

  /* 3. 앞으로 올 회차 — 규칙에서 계산한다(아직 실물이 없으니 여기밖에 근거가 없다).
       건너뛴 날은 dueDatesToGenerate 가 rule.skips 로 걸러낸다. */
  const skipDays = skipped.map(s => s.date)
  const upcoming = dueDatesToGenerate(
    { ...rule, skips: skipDays }, today, { horizonDays: HISTORY_HORIZON_DAYS }
  ).map(d => ({ state: 'upcoming', date: day(d) }))

  /* 4. 빠진 회차 — 만들지도, 건너뛰지도 않은 달.
   *
   * 이력을 처음 띄웠을 때 2~7월이 있고 9월이 있는데 **8월만 아무 설명 없이 비어 있었다.**
   * 등록일 하한(소급 홍수 차단) 때문에 그 달 회차가 평소 경로로 안 만들어진 것인데,
   * 표에 아무 줄이 없으니 "왜 그 달만 없지"가 그대로 남는다 — 이 화면이 풀려던 바로 그 질문이다.
   *
   * ⚠ **처음 만들어진 회차부터** 오늘까지만 본다. 시작일부터 세면, 몇 년 전 시작일로
   *   등록한 규칙이 '안 만듦' 수십 줄을 뿜는다(소급 홍수가 화면으로 옮겨온 꼴이다).
   *   실제로 회차가 하나 만들어진 뒤부터가 "이 규칙이 돌고 있던 기간"이라고 말할 수 있다. */
  const missing = []
  if (done.length) {
    const known = new Set([...doneDays, ...skipped.map(c => c.date)])
    for (const d of backfillCycles(rule, done[0].date, today)) {
      const ds = day(d)
      if (!known.has(ds)) missing.push({ state: 'missing', date: ds })
    }
  }

  /* 회차별 실제 정산액 — 상태값(입금 완료)만 보면 **일부 입금이 통째로 0 또는 100 이 된다.**
     이행률은 금액으로 말해야 뜻이 통한다("8회 중 7회"가 아니라 "440,000 중 385,000"). */
  if (done.length) {
    const ph = done.map(() => '?').join(',')
    const [paidRows] = await db.execute(
      `SELECT invoice_id, COALESCE(SUM(amount),0) AS paid FROM invoice_matches
        WHERE invoice_id IN (${ph}) GROUP BY invoice_id`, done.map(c => c.id))
    const paidBy = new Map(paidRows.map(r => [r.invoice_id, num(r.paid)]))
    for (const c of done) c.paid_amount = paidBy.get(c.id) || 0
  }

  const cycles = [...done, ...skipped, ...missing, ...upcoming]
    .sort((a, b) => a.date.localeCompare(b.date) || a.state.localeCompare(b.state))

  /* 정산된 회차 — 청구서 상태값이다(lib/invoiceStatus.js 와 같은 말을 써야 한다).
     띄어쓰기 두 벌을 다 받는다: 화면 표기는 '입금 완료'인데 거래 status 는 '입금완료'다. */
  const paidStates = isInvoice
    ? ['입금 완료', '입금완료']
    : ['지급 완료', '지급완료']

  return {
    horizon_days: HISTORY_HORIZON_DAYS,
    cycles,
    totals: {
      done: done.length,
      // 여태 이 규칙으로 나간 금액 — "이 규칙이 얼마짜리였나"의 답이다
      amount: done.reduce((s, c) => s + c.total_amount, 0),
      backfilled: done.filter(c => c.backfilled).length,
      skipped: skipped.length,
      // 만들지도 건너뛰지도 않은 달 — 소급 마법사로 채울 수 있다
      missing: missing.length,
      upcoming: upcoming.length,
      // 받았나/줬나 — 만들기만 하고 정산이 안 된 회차가 몇 건인지가 실무의 관심사다
      settled: done.filter(c => paidStates.includes(c.status)).length,
      ...dueVsPaid(done, missing, rule, today),
    },
  }
}

module.exports = { recurHistory, HISTORY_HORIZON_DAYS }
