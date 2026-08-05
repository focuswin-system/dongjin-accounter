const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday } = require('../db')
const model = require('../contract-model')
const { buildContractWorkbook } = require('../contract-export')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError, amountError } = require('../lib/ledger')
const { settleAcctCode } = require('../lib/acctCode')
const { removeUploadedFile } = require('../lib/uploads')
const { vatOf, vatRateOf, taxTypeOfMode } = require('../lib/vat')
const { closedPeriodError } = require('../lib/closing')

const router = Router()

/* 계약을 '완료'로 닫을 때, 거기 걸린 정기 규칙 중 **종료일이 빈 것**에 종료일을 채운다.
 *
 * 왜 '끄기'(active=0)가 아니라 '종료일 채우기'인가:
 *   · 계약이 완료돼도 **마지막 회차 청구는 남는 게 정상**이다(8월 말 종료 → 8월분을 9월에 발행).
 *     상태로 목록에서 잘라내면 그 회차가 사라져 못 받은 돈이 조용히 없어진다.
 *     종료일을 채우면 과거 미청구분은 '놓친 회차'로 남고 미래만 멈춘다.
 *   · 종료일은 정기청구·정기지출 화면에 보이고 고칠 수 있다. 잘못됐으면 날짜만 지우면 원복된다.
 *     active 토글은 껐다 켜는 사이 회차가 '놓친 회차'로 몰려 되돌리기가 지저분하다.
 *
 * 기한 있는 계약은 이미 종료일이 있어 자연히 멈추므로 대상이 아니다(빈 것만 고른다).
 * '보류'는 끝난 게 아니라 잠깐 멈춘 것이라 여기서 다루지 않는다.
 */
async function findOpenEndedRecurring(db, contractId) {
  const [invoices] = await db.execute(
    `SELECT id, item AS label, period, day_of_month FROM recurring_invoices
     WHERE contract_id = ? AND active = 1 AND (end_date IS NULL OR end_date = '')`, [contractId])
  const [expenses] = await db.execute(
    `SELECT id, category AS label, period, day_of_month FROM recurring_expenses
     WHERE contract_id = ? AND active = 1 AND (end_date IS NULL OR end_date = '')`, [contractId])
  return { invoices, expenses }
}

/* 계약 조건 → 정기 규칙 반영. 계약이 원본이고 정기 규칙은 실행 장치다.
 *
 * ⚠ start_date 가 빠져 있었다. 그래서 계약 시작일을 고쳐도 규칙은 옛 날짜를 붙들었고,
 *   화면의 어긋남 경고(recurringMismatch)에도 시작일이 없어 **아무도 알려주지 않았다.**
 *   방향에 따라 덜 청구(시작일 앞당김)도, 더 청구(시작일 미룸)도 난다.
 * 소급은 이걸로 열리지 않는다 — 등록일 하한(setup_date)은 그대로다. 정합성만 맞춘다.
 */
async function syncRecurringToContract(db, c, isPurchase) {
  const start = c.start_date || ''
  return isPurchase
    ? (await db.execute(
        'UPDATE recurring_expenses SET amount=?, period=?, day_of_month=?, start_date=?, end_date=? WHERE contract_id=?',
        [Number(c.unit_amount) || 0, c.billing_period || 'monthly', c.billing_day || 1, start, c.end_date || null, c.id]))[0]
    : (await db.execute(
        'UPDATE recurring_invoices SET supply_amount=?, vat_mode=?, period=?, day_of_month=?, start_date=?, end_date=? WHERE contract_id=?',
        [Number(c.unit_amount) || 0, vatRateOf(c.vat_mode) === 0 ? 'none' : 'exclusive',
         c.billing_period || 'monthly', c.billing_day || 1, start, c.end_date || null, c.id]))[0]
}

async function closeOpenEndedRecurring(conn, contractId, endDate) {
  const [ri] = await conn.execute(
    `UPDATE recurring_invoices SET end_date = ?
     WHERE contract_id = ? AND active = 1 AND (end_date IS NULL OR end_date = '')`, [endDate, contractId])
  const [re] = await conn.execute(
    `UPDATE recurring_expenses SET end_date = ?
     WHERE contract_id = ? AND active = 1 AND (end_date IS NULL OR end_date = '')`, [endDate, contractId])
  return { invoices: ri.affectedRows, expenses: re.affectedRows }
}

// cost_budget(JSON)이 손상된 행 하나가 계약 목록/상세 응답 전체를 500으로 만들지 않도록 안전 파싱.
const safeBudget = (raw, fallback = null) => { if (!raw) return fallback; try { return JSON.parse(raw) } catch { return fallback } }

// 지출을 원가 4분류로 나눈다 — 원가예산 대비 실적용.
// 비목명만 보고 방산 용어(철강·도금·열처리…)를 찾던 걸 비목 그룹 + 일반 단어로 바꿨다.
// 업종이 달라도(천막=원단 매입, SW=외주 개발) 그룹만 제대로 잡혀 있으면 분류된다. 못 잡으면 overhead.
const costBucket = (categoryName, groupName) => {
  const s = `${groupName || ''} ${categoryName || ''}`
  if (/외주|하도급|용역|가공|위탁/.test(s))          return 'outsource'
  if (/인건|급여|임금|노무|퇴직|복리|상여/.test(s))   return 'labor'
  if (/재료|자재|원단|부품|매입|소모품|공구/.test(s)) return 'material'
  return 'overhead'
}

// 계약 한 건의 금액 지표. 화면마다 다르게 계산하다 어긋나지 않도록 여기서만 만든다.
//
// 매출 계약(gubu B)과 매입 계약(gubu A·E)은 보는 관점이 다르다.
//   매출 계약 — 받을 돈이 본체. 여기에 그 일을 하느라 나간 원가(외주개발비 등)를 붙여 계약별 손익을 본다.
//   매입 계약 — 나갈 돈만 있는 계약. '손익'도 '입금'도 성립하지 않는다 (nul로 내려서 화면이 안 그리게 한다).
//
//   billed     이 계약으로 발행/수취한 청구서 합계(VAT 포함)
//   collected  매출=받은 돈, 매입=지급한 돈  (계약 이행 대금)
//   cost       매출 계약에 붙은 원가 지출 (매입 계약은 null — 지급액이 곧 collected라 중복)
//   ar_remain  미수금(매입이면 미지급금) = 청구했는데 아직 정산 안 된 돈
//   remain     남은 계약분 = 이번 텀 총액 − 받은(지급한) 돈 (무기한 정기계약은 총액이 없으므로 null)
//   profit     매출 계약만. 매입 계약은 null
// 정기 계약은 '이번 텀'(current_term_start 이후) 기준으로 봐야 갱신 후에도 진행률이 맞는다.
const metrics = (r) => {
  const isPurchase = r.gubu === 'A' || r.gubu === 'E'
  const in_done = Number(r.in_done || 0)
  const out     = Number(r.out_total || 0)     // 이 계약이 근거인 지출 = 매입계약의 지급액
  const cost    = Number(r.cost_total || 0)    // 이 매출계약에 귀속된 원가 (외주비 등)
  const term_in_done = Number(r.term_in_done || 0)
  const term_out     = Number(r.term_out || 0)
  const collected      = isPurchase ? out : in_done
  const term_collected = isPurchase ? term_out : term_in_done
  const billed      = Number(r.billed || 0)
  const term_billed = Number(r.term_billed || 0)

  const openEnded = r.billing_mode === 'recurring' && r.term_mode === 'open'
  // 총액 개념이 없는 계약: 무기한 정기 + 기성형(품목 단가×수량으로 그때그때 청구).
  const noTotal = openEnded || r.billing_mode === 'progress'
  // amount는 정기형이면 '이번 텀 총액'(저장 시 서버가 산출), 총액형이면 계약 총액. 면세면 부가세 없음.
  const vatMul = 1 + vatRateOf(r.vat_mode)
  const termTotal = noTotal ? null : Math.round((Number(r.amount) || 0) * vatMul)
  const remain = termTotal == null ? null : Math.max(0, termTotal - term_collected)
  const ar_remain = Math.max(0, billed - collected)

  return {
    ...r,
    is_purchase: isPurchase,
    in_done, out, billed, term_billed, term_collected, collected,
    term_total: termTotal, remain, ar_remain,
    // 매입 계약에 원가·손익 개념을 붙이면 "나간 돈 = 손해"로 읽히는 거짓 숫자가 나온다.
    // 매출 계약의 원가는 '이 계약에 귀속된 지출'(cost_contract_id)이지, 이 계약이 근거인 지출이 아니다.
    cost:   isPurchase ? null : cost,
    /* 손익은 공급가액 기준 — 부가세는 회사 돈이 아니라 받아서 내는 돈이다.
     * VAT 포함 금액으로 계산하면 1.1S − 1.1C 이 되어 손익이 정확히 10% 부풀려진다. */
    profit: isPurchase ? null : Number(r.in_supply || 0) - Number(r.cost_supply || 0),
    cost_budget: safeBudget(r.cost_budget),
  }
}

// 지표 집계용 서브쿼리. 거래는 두 축으로 계약에 붙는다:
//   contract_id      = 이 계약이 근거인 돈 (매출계약의 수금 / 매입계약의 지급)
//   cost_contract_id = 이 계약(매출)에 귀속된 원가 (외주비 등 — 그 돈은 외주 매입계약에 지급된 것이기도 하다)
// 이번 텀 합계는 current_term_start 이후 거래만 센다.
//
// ⚠ 지출은 반드시 status='지급완료'만 센다 — 계좌 잔액 계산(accounts.js calcBalance)과
// 같은 조건이어야 한다. 안 그러면 아직 나가지도 않은 '지급 대기'(정기지출 자동 생성분 등)가
// '지급액'에 섞여, 매입계약의 미지급 잔액이 실제보다 적게 보이고 원가는 부풀려진다.
// (입금은 calcBalance도 status를 보지 않으므로 여기서도 동일하게 맞춘다)
const PAID = "status='지급완료'"
/* 수입도 완료된 것만 센다. 예전 주석은 'calcBalance 가 입금 status 를 안 본다'였는데
 * 그 뒤 calcBalance 가 SETTLED_INCOME 으로 막도록 바뀌었고 여기만 남았다 →
 * 아직 안 들어온 입금이 계약 수금액·손익에 섞여 손익이 부풀었다. */
const RECV = "status='입금완료'"
/* 손익은 **공급가액** 기준이다. 부가세는 회사 돈이 아니라 받아서 내는 돈이라,
 * 매출·원가를 VAT 포함 금액으로 계산하면 손익이 정확히 10% 부풀려진다(1.1S − 1.1C).
 * 부가세 컬럼이 없던 시절 거래는 supply_amount 가 NULL 이므로 amount 로 폴백한다
 * — 옛 데이터의 숫자를 갑자기 바꾸지 않으면서, 데이터가 채워질수록 정확해진다. */
const SUPPLY = 'COALESCE(supply_amount, amount)'
/* 계약 성격에 맞는 청구서 종류. 매입 계약(거래처 gubu A=외주/매입, E=기관)은 수취 청구서,
 * 매출 계약(B=발주처)은 발행 청구서. 판정 기준은 위 isPurchase 와 같아야 한다.
 * 이 필터가 없으면 외주비 매입 청구서를 매출 계약에 귀속시켰을 때 그 금액이 매출 계약의
 * '청구액'에 더해지고, 받을 돈이 아닌데 미수금(billed − collected)으로 뜬다. */
const PURCHASE_KIND = "IF(v.gubu IN ('A','E'), 'received', 'issued')"
const METRIC_COLS = `
  COALESCE((SELECT SUM(amount) FROM transactions WHERE contract_id=c.id AND kind='income' AND ${RECV}),0)  AS in_done,
  COALESCE((SELECT SUM(amount) FROM transactions WHERE contract_id=c.id AND kind='expense' AND ${PAID}),0) AS out_total,
  COALESCE((SELECT SUM(amount) FROM transactions WHERE cost_contract_id=c.id AND kind='expense' AND ${PAID}),0) AS cost_total,
  /* 손익용 공급가 합계 — 위 in_done·cost_total 은 실제로 오간 돈(VAT 포함)이라 그대로 두고,
     손익은 이 값으로 계산한다. 둘을 섞으면 손익이 10% 부풀려진다. */
  COALESCE((SELECT SUM(${SUPPLY}) FROM transactions WHERE contract_id=c.id AND kind='income' AND ${RECV}),0) AS in_supply,
  COALESCE((SELECT SUM(${SUPPLY}) FROM transactions WHERE cost_contract_id=c.id AND kind='expense' AND ${PAID}),0) AS cost_supply,
  COALESCE((SELECT SUM(amount) FROM transactions WHERE contract_id=c.id AND kind='income' AND ${RECV}
            AND (c.current_term_start IS NULL OR date >= c.current_term_start)),0)  AS term_in_done,
  COALESCE((SELECT SUM(amount) FROM transactions WHERE contract_id=c.id AND kind='expense' AND ${PAID}
            AND (c.current_term_start IS NULL OR date >= c.current_term_start)),0)  AS term_out,
  /* ⚠ 계약의 성격에 맞는 청구서만 센다.
   *   매출 계약(gubu='B')에는 발행 청구서(issued), 매입 계약에는 수취 청구서(received).
   *   kind 필터가 없으면, 외주비 매입 청구서를 프로젝트(매출) 계약에 귀속시켰을 때
   *   그 금액이 매출 계약의 '청구액'에 더해지고 collected 는 그대로라
   *   **받을 돈이 아닌데 미수금으로 뜬다**(ar_remain = billed − collected).
   *   청구서 등록 폼은 매출·매입 구분 없이 모든 계약을 후보로 주므로 실제로 일어나는 입력이다. */
  COALESCE((SELECT SUM(total_amount) FROM invoices i WHERE i.contract_id=c.id
            AND i.kind = ${PURCHASE_KIND}),0) AS billed,
  COALESCE((SELECT SUM(total_amount) FROM invoices i WHERE i.contract_id=c.id
            AND i.kind = ${PURCHASE_KIND}
            AND (c.current_term_start IS NULL OR i.issued_at >= c.current_term_start)),0) AS term_billed`

router.get('/', async (req, res, next) => {
  try {
    const { vendorId, status } = req.query
    let sql = `SELECT c.*, v.name AS vendor_name, v.gubu, ${METRIC_COLS}
      FROM contracts c LEFT JOIN vendors v ON c.vendor_id = v.id WHERE 1=1`
    const params = []
    if (vendorId)  { sql += ' AND c.vendor_id = ?';  params.push(vendorId) }
    if (status)    { sql += ' AND c.status = ?';     params.push(status) }
    sql += ' ORDER BY c.created_at DESC'
    const [rows] = await req.db.execute(sql, params)
    res.json(rows.map(metrics))
  } catch (e) { next(e) }
})

// 발행 예정(대기) 청구 일정 — status='예정' & 아직 미발행(invoice_id NULL)
// for=sales → 발주처(gubu B)+미지정(NULL) / for=purchase → 매입(A·E)
router.get('/schedule/pending', async (req, res, next) => {
  try {
    const forKind = req.query.for
    let sql = `SELECT m.id AS milestone_id, m.type, m.amount, m.due_date,
                      c.id AS contract_id, c.name AS contract_name, c.contract_no, c.vendor_id, c.vat_mode,
                      v.name AS vendor_name, v.gubu
               FROM milestones m
               JOIN contracts c ON m.contract_id = c.id
               LEFT JOIN vendors v ON c.vendor_id = v.id
               WHERE m.status = '예정' AND (m.invoice_id IS NULL OR m.invoice_id = '')`
    if (forKind === 'purchase')  sql += " AND v.gubu IN ('A','E')"
    else if (forKind === 'sales') sql += " AND (v.gubu IS NULL OR v.gubu = 'B')"
    sql += ' ORDER BY m.due_date'
    const [rows] = await req.db.execute(sql)
    // vat를 서버가 계약 vat_mode로 계산해 내려준다(면세=0). 화면이 0.1을 하드코딩하면 면세에 유령 VAT가 붙는다.
    res.json(rows.map(r => {
      const amount = Number(r.amount)
      return { ...r, amount, vat: vatOf(amount, r.vat_mode) }
    }))
  } catch (e) { next(e) }
})

// 계약 목록 엑셀(.xlsx) — 계약 목록 / 갱신 관리 / 정기 계약 3개 시트.
// CSV로는 서식·요약·시트 분리가 안 돼서 서버에서 만들어 내려준다.
router.get('/export.xlsx', async (req, res, next) => {
  try {
    const kind = ['sales', 'purchase'].includes(req.query.kind) ? req.query.kind : 'all'
    let sql = `SELECT c.*, v.name AS vendor_name, v.gubu, ${METRIC_COLS},
        COALESCE((SELECT COUNT(*) FROM contract_renewals WHERE contract_id=c.id AND result='갱신'),0) AS renew_count,
        COALESCE((SELECT COUNT(*) FROM recurring_invoices WHERE contract_id=c.id AND active=1),0) AS recurring_active
      FROM contracts c LEFT JOIN vendors v ON c.vendor_id = v.id WHERE 1=1`
    if (kind === 'purchase')   sql += " AND v.gubu IN ('A','E')"
    else if (kind === 'sales') sql += " AND (v.gubu IS NULL OR v.gubu = 'B')"
    sql += ' ORDER BY c.start_date DESC, c.created_at DESC'
    const [rows] = await req.db.execute(sql)
    const contracts = rows.map(metrics)

    const wb = await buildContractWorkbook(contracts, { kind })
    const label = kind === 'purchase' ? '매입계약' : kind === 'sales' ? '매출계약' : '계약'
    const filename = `${label}_${kstToday()}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    // 한글 파일명 — 구형 클라이언트용 ASCII fallback + RFC 5987
    res.setHeader('Content-Disposition',
      `attachment; filename="contracts.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`)
    await wb.xlsx.write(res)
    res.end()
  } catch (e) { next(e) }
})

// 갱신 관리 대상: 만료가 있는 계약(fixed·auto_renew) 중 진행중이고 종료일이 있는 건.
// 통보기한(notice_days) 안에 들어왔거나 이미 만료된 계약을 종료일 순으로 반환.
// 무기한(open) 계약은 만료가 없으므로 대상이 아니다.
// for=sales → 발주처(gubu B)+미지정 / for=purchase → 매입(A·E)
router.get('/renewals/upcoming', async (req, res, next) => {
  try {
    const forKind = req.query.for
    let sql = `SELECT c.id, c.name, c.contract_no, c.amount, c.unit_amount, c.billing_mode, c.billing_period,
                      c.term_mode, c.term_months, c.notice_days, c.start_date, c.end_date, c.status,
                      c.vendor_id, v.name AS vendor_name, v.gubu,
                      DATEDIFF(c.end_date, CURDATE()) AS days_left
               FROM contracts c LEFT JOIN vendors v ON c.vendor_id = v.id
               WHERE c.term_mode IN ('fixed','auto_renew') AND c.status = '진행중'
                 -- 갱신 개념이 있는 계약만: 자동갱신이거나 정기형(유지보수 등).
                 -- 총액형+기간만료(구축 프로젝트)는 끝나면 그냥 끝이라 갱신 대상이 아니다.
                 AND (c.term_mode = 'auto_renew' OR c.billing_mode = 'recurring')
                 AND c.end_date IS NOT NULL AND c.end_date <> ''
                 AND DATEDIFF(c.end_date, CURDATE()) <= COALESCE(c.notice_days, 60)`
    if (forKind === 'purchase')   sql += " AND v.gubu IN ('A','E')"
    else if (forKind === 'sales') sql += " AND (v.gubu IS NULL OR v.gubu = 'B')"
    sql += ' ORDER BY c.end_date'
    const [rows] = await req.db.execute(sql)
    res.json(rows.map(r => ({ ...r, amount: Number(r.amount), unit_amount: r.unit_amount == null ? null : Number(r.unit_amount), days_left: Number(r.days_left) })))
  } catch (e) { next(e) }
})

// 갱신 처리 (result: 'renew' 연장 | 'close' 미갱신 종료)
//  renew → 이번 텀을 닫고 다음 텀으로 넘긴다: current_term_start = 기존 종료일 + 1일, end_date = 새 종료일.
//          정기형이면 주기당 금액(new_unit_amount)을 받고 텀 총액(amount)은 서버가 다시 계산한다.
//          연결된 정기청구의 종료일도 같이 밀어준다(안 하면 갱신했는데 청구가 끊긴다).
//  close → 계약을 '완료'로 닫고 이력만 남긴다. 연결된 정기청구는 자동으로 끄지 않는다(돈 나가는 쪽이라 사람이 확인).
// enum은 ASCII로 받는다 — 한글 문자열로 받으면 인코딩이 틀어질 때 조용히 오작동한다.
router.post('/:id/renew', async (req, res, next) => {
  const { new_end_date, new_amount, new_unit_amount, memo, result, renewed_at } = req.body
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[c]] = await conn.execute('SELECT * FROM contracts WHERE id = ? FOR UPDATE', [req.params.id])
    if (!c) { await rollbackQuietly(conn); return res.status(404).json({ error: '계약을 찾을 수 없어요' }) }

    if (!['renew', 'close'].includes(result)) {
      await rollbackQuietly(conn); return res.status(400).json({ error: "result는 'renew' 또는 'close'여야 해요" })
    }
    if (c.term_mode === 'open') {
      await rollbackQuietly(conn); return res.status(400).json({ error: '무기한 계약은 갱신 대상이 아니에요. 끝내려면 계약 상태를 완료로 바꾸세요.' })
    }
    const isRenew = result === 'renew'
    if (isRenew && !new_end_date) {
      await rollbackQuietly(conn); return res.status(400).json({ error: '새 종료일을 입력해주세요' })
    }
    if (isRenew && c.end_date && new_end_date <= c.end_date) {
      await rollbackQuietly(conn); return res.status(400).json({ error: '새 종료일은 기존 종료일보다 뒤여야 해요' })
    }

    const recurring = c.billing_mode === 'recurring'
    const prevUnit = recurring ? Number(c.unit_amount) || 0 : null
    const nextUnit = recurring
      ? (new_unit_amount != null && new_unit_amount !== '' ? Number(new_unit_amount) : prevUnit)
      : null
    // 다음 텀 시작일 = 기존 종료일 다음날 (첫 텀 시작일이 없으면 계약 시작일 유지)
    const nextTermStart = isRenew ? (model.dayAfter(c.end_date) || c.current_term_start || c.start_date) : null
    // 정기형의 계약금액은 항상 파생값 — 새 텀 길이 × 주기당 금액
    const nextAmount = !isRenew ? null
      : recurring
        ? model.termTotal({ ...c, unit_amount: nextUnit, end_date: new_end_date, current_term_start: nextTermStart })
        : (new_amount != null && new_amount !== '' ? Number(new_amount) : Number(c.amount) || 0)

    const [[{ maxseq }]] = await conn.execute(
      'SELECT COALESCE(MAX(seq), 0) AS maxseq FROM contract_renewals WHERE contract_id = ?', [req.params.id]
    )
    await conn.execute(
      `INSERT INTO contract_renewals (id, contract_id, seq, prev_end_date, new_end_date, prev_amount, new_amount,
                                      prev_unit_amount, new_unit_amount, renewed_at, result, memo)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [randomUUID(), req.params.id, Number(maxseq) + 1, c.end_date || null, isRenew ? new_end_date : null,
       Number(c.amount) || 0, nextAmount, prevUnit, isRenew ? nextUnit : null,
       renewed_at || kstToday(), isRenew ? '갱신' : '미갱신', memo || null]
    )

    let recurringExtended = 0
    let recurringClosed = null
    if (isRenew) {
      await conn.execute(
        'UPDATE contracts SET end_date=?, amount=?, unit_amount=?, current_term_start=?, status=? WHERE id=?',
        [new_end_date, nextAmount, recurring ? nextUnit : null, nextTermStart, '진행중', req.params.id]
      )
      // 계약에 걸린 정기 반복도 새 종료일까지 연장 + 단가 반영.
      // 매출이면 정기청구, 매입이면 정기지출 — 안 하면 갱신했는데 청구/지출이 끊긴다.
      const [[vg]] = await conn.execute('SELECT gubu FROM vendors WHERE id = ?', [c.vendor_id || ''])
      const isPurchaseC = vg && (vg.gubu === 'A' || vg.gubu === 'E')
      const sql = isPurchaseC
        ? 'UPDATE recurring_expenses SET end_date=?, amount=IF(? IS NULL, amount, ?) WHERE contract_id=? AND active=1'
        : 'UPDATE recurring_invoices SET end_date=?, supply_amount=IF(? IS NULL, supply_amount, ?) WHERE contract_id=? AND active=1'
      const [ri] = await conn.execute(sql,
        [new_end_date, recurring ? nextUnit : null, recurring ? nextUnit : null, req.params.id])
      recurringExtended = ri.affectedRows
    } else {
      await conn.execute("UPDATE contracts SET status = '완료' WHERE id = ?", [req.params.id])
      /* 미갱신 종료 — 종료일이 빈 정기 규칙은 여기서 닫아준다.
         갱신 쪽(위)은 종료일을 새 날짜로 밀어주는데 이쪽만 아무것도 안 해서,
         무기한 계약을 닫아도 회차가 계속 후보로 떴다. 기준일은 계약 종료일(없으면 오늘). */
      if (req.body.close_recurring) {
        const endDate = c.end_date || kstToday()
        recurringClosed = { ...(await closeOpenEndedRecurring(conn, req.params.id, endDate)), end_date: endDate }
      }
    }
    await conn.commit()
    res.json({ ok: true, seq: Number(maxseq) + 1, result: isRenew ? '갱신' : '미갱신', recurringExtended, recurringClosed })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// 청구 일정 단건 상태 변경(레거시 — 필요 시)
router.patch('/milestones/:id/status', async (req, res, next) => {
  try {
    const [result] = await req.db.execute('UPDATE milestones SET status=? WHERE id=?', [req.body.status || '예정', req.params.id])
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 청구 일정 → 청구서 발행 (+선택적 기입금). 원자적: 청구서·(기입금 시)거래·매칭·일정 상태를 한 트랜잭션에서 처리.
// 거래처 gubu로 매출(issued)/매입(received) 자동 판별. 이미 발행된 일정은 409로 거부(중복 방지).
router.post('/schedule/:milestoneId/issue', async (req, res, next) => {
  const { paid, date, account_id } = req.body
  // 기입금(paid)이면 실제 입/출금 거래가 생기므로 미래 일자 금지
  if (paid) { const de = futureDateError(date); if (de) return res.status(400).json({ error: de }) }
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[ms]] = await conn.execute(
      `SELECT m.*, c.name AS contract_name, c.vendor_id, c.vat_mode, v.gubu
       FROM milestones m JOIN contracts c ON m.contract_id = c.id
       LEFT JOIN vendors v ON c.vendor_id = v.id WHERE m.id = ? FOR UPDATE`,
      [req.params.milestoneId]
    )
    if (!ms) { await rollbackQuietly(conn); return res.status(404).json({ error: '청구 일정을 찾을 수 없어요' }) }
    if (ms.status !== '예정' || (ms.invoice_id && ms.invoice_id !== '')) {
      await rollbackQuietly(conn); return res.status(409).json({ error: '이미 발행된 청구 일정이에요' })
    }
    const isPurchase = ms.gubu === 'A' || ms.gubu === 'E'
    const kind = isPurchase ? 'received' : 'issued'
    const supply = Number(ms.amount) || 0
    // 면세 계약이면 부가세 0
    const vat = vatOf(supply, ms.vat_mode)
    const total = supply + vat
    const today = kstToday()   // UTC면 KST 00~09시에 하루 전(연초엔 전년도 채번)으로 찍힌다
    const year = today.slice(0, 4)
    const prefix = isPurchase ? '매입' : '청구'
    // 채번: 최대 일련번호+1 (삭제해도 재사용 안 됨)
    const [[{ maxno }]] = await conn.execute(
      `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno
       FROM invoices WHERE kind = ? AND invoice_no LIKE ?`,
      [kind, `${prefix}-${year}-%`]
    )
    const invoice_no = `${prefix}-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    // 기입금 시 반영할 계좌: 사용자가 고른 계좌 우선, 없으면 주거래(첫 은행) 계좌.
    const [[defAcc]] = await conn.execute("SELECT id FROM accounts WHERE kind='bank' ORDER BY created_at LIMIT 1")
    const accountId = account_id || (defAcc ? defAcc.id : null)
    const invId = randomUUID()
    const status = paid ? (isPurchase ? '지급 완료' : '입금 완료') : (isPurchase ? '지급 대기' : '입금 예정')
    /* 만기일은 발행일보다 앞설 수 없다.
     * 청구 일정의 예정일이 이미 지난 뒤 발행하면(늦은 청구) due_at < issued_at 이 되어
     * 발행 즉시 '연체 미수금'으로 집계됐다 — 연체 금액·건수가 실제와 다르게 잡힌다.
     * 예정일이 지났으면 발행일을 만기로 본다(그날부터 받을 돈이다). */
    const dueAt = ms.due_date && ms.due_date >= today ? ms.due_date : today
    /* 마감된 달로는 청구서를 발행할 수 없다. 예전엔 'paid' 일 때(거래를 만들 때)만 검사해서,
     * 마감·신고를 끝낸 달로 청구서만 새로 꽂을 수 있었다 → 그 분기 부가세 집계가 신고 후에 바뀐다.
     * 수동 등록(POST /invoices)은 처음부터 issued_at 으로 막고 있었다. */
    { const ce = await closedPeriodError(conn, today); if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) } }
    // 금액 0(마일스톤 금액을 안 채운 채 발행)이면 '입금 예정 0원' 청구서가 남아
    // 홈 '할 일'과 미수금 목록을 채운다 — 실제로 그런 청구서가 생겨 있었다.
    { const ae = amountError(total); if (ae) { await rollbackQuietly(conn); return res.status(400).json({ error: ae }) } }
    await conn.execute(
      'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo, tax_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [invId, invoice_no, kind, ms.vendor_id || null, ms.contract_id, supply, vat, total, today, dueAt, status, paid ? accountId : null, `${ms.contract_name} · ${ms.type}`, taxTypeOfMode(ms.vat_mode)]
    )
    // 기입금: 실제 입/출금 거래 + 매칭 생성(장부·계좌·계약 수금에 반영)
    if (paid) {
      // 완료 상태로 넣으므로 계좌가 없으면 잔액에 안 잡힌다(lib/ledger.js)
      const lerr = ledgerError({ kind: isPurchase ? 'expense' : 'income', account_id: accountId, status: isPurchase ? '지급완료' : '입금완료' })
      if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: lerr }) }
      // 마감된 달에는 실제 거래를 만들 수 없다
      const ce = await closedPeriodError(conn, date || today)
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
      const txnId = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, account_code, category, amount, date, method, status, doc_no, invoice_id, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txnId, isPurchase ? 'expense' : 'income', ms.vendor_id || null, ms.contract_id, accountId,
         // 정산은 채권·채무가 사라지는 거래다 → 상대 계정은 외상매출금/외상매입금.
         // 비우면 일계표에서 한쪽 다리가 없어 차변·대변이 안 맞는다.
         settleAcctCode(isPurchase ? 'expense' : 'income'),
         isPurchase ? '대금 지급' : '수금', total, date || today, '계좌이체',
         isPurchase ? '지급완료' : '입금완료', '', invId, `청구서 ${invoice_no} 정산`]
      )
      await conn.execute('INSERT INTO invoice_matches (id, invoice_id, txn_id, amount, txn_created) VALUES (?,?,?,?,1)', [randomUUID(), invId, txnId, total])
    }
    await conn.execute('UPDATE milestones SET status = ?, invoice_id = ? WHERE id = ?',
      [paid ? (isPurchase ? '지급 완료' : '입금 완료') : (isPurchase ? '지급 예정' : '입금 예정'), invId, req.params.milestoneId])
    await conn.commit()
    res.json({ ok: true, id: invId, invoice_no, kind })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// 기성 청구 발행 — 기성형(progress) 계약에서 품목별 수량을 받아 청구서 1건 + 품목 내역(invoice_lines)을 만든다.
// 총액형의 schedule/issue와 달리 마일스톤이 없고, 품목 line 합계가 곧 공급가액이다.
// body: { issued_at, due_at?, paid?, lines:[{ item_id, name, spec, unit, qty, unit_price, amount }] }
router.post('/:id/progress-invoice', async (req, res, next) => {
  const { issued_at, due_at, paid, lines, account_id } = req.body
  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: '청구할 품목을 하나 이상 입력해주세요' })
  }
  /* 청구일은 반드시 받는다.
   * 예전엔 없으면 조용히 오늘로 대체했다(`issued_at || today`). 그 결과
   *   · 3~7월 기성으로 보낸 청구서 9건이 전부 **오늘 날짜로** 저장됐고
   *     (호출부가 필드명을 `date` 로 잘못 보냈는데 아무 말이 없었다),
   *   · 마감된 달로 청구해도 **오늘로 바뀌어 마감 검사를 그냥 지나갔다.**
   * 부가세는 발행일로 분기를 가르므로, 날짜가 조용히 바뀌면 신고 자료가 통째로 틀어진다.
   * 화면은 늘 값을 보내므로(Contract.jsx) 이 검사에 걸리지 않는다 — 잘못 부른 쪽만 걸린다. */
  if (!issued_at) return res.status(400).json({ error: '청구일을 선택해주세요' })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(issued_at))) {
    return res.status(400).json({ error: '청구일 형식이 올바르지 않아요 (YYYY-MM-DD)' })
  }
  // 기입금(paid)이면 실제 입/출금 거래가 생기므로 미래 일자 금지
  if (paid) { const de = futureDateError(issued_at); if (de) return res.status(400).json({ error: de }) }
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[c]] = await conn.execute(
      'SELECT c.*, v.gubu FROM contracts c LEFT JOIN vendors v ON c.vendor_id = v.id WHERE c.id = ? FOR UPDATE',
      [req.params.id]
    )
    if (!c) { await rollbackQuietly(conn); return res.status(404).json({ error: '계약을 찾을 수 없어요' }) }
    if (c.billing_mode !== 'progress') { await rollbackQuietly(conn); return res.status(400).json({ error: '기성형 계약이 아니에요' }) }

    // 매입원가 스냅샷은 계약 품목표에서 가져온다(화면이 안 보내줘도 원가가 새는 일이 없게).
    const [ciRows] = await conn.execute(
      'SELECT item_id, name, cost_price FROM contract_items WHERE contract_id = ?', [req.params.id]
    )
    const costOf = (l) => {
      if (l.cost_price != null && l.cost_price !== '') return Number(String(l.cost_price).replace(/[^0-9]/g, '')) || 0
      const hit = ciRows.find(ci => (l.item_id && ci.item_id === l.item_id) || ci.name === String(l.name ?? '').trim())
      return hit ? Number(hit.cost_price) || 0 : 0
    }

    // 품목 정규화: 수량·단가·금액 계산(금액이 오면 그대로, 없으면 수량×단가). 이름 없거나 금액 0 이하 행은 제외.
    const clean = []
    for (const l of lines) {
      const nm = (l && l.name != null) ? String(l.name).trim() : ''
      if (!nm) continue
      const qty = Number(String(l.qty ?? '').replace(/[^0-9.]/g, '')) || 0
      const price = Number(String(l.unit_price ?? '').replace(/[^0-9]/g, '')) || 0
      const amount = (l.amount != null && l.amount !== '')
        ? (Number(String(l.amount).replace(/[^0-9]/g, '')) || 0)
        : Math.round(qty * price)
      if (amount <= 0) continue
      clean.push({ item_id: l.item_id || null, name: nm, spec: l.spec || null, unit: l.unit || null,
        qty, unit_price: price, amount, cost_price: costOf(l) })
    }
    if (clean.length === 0) { await rollbackQuietly(conn); return res.status(400).json({ error: '청구 금액이 있는 품목이 없어요' }) }

    const supply = clean.reduce((s, l) => s + l.amount, 0)
    const vat = vatOf(supply, c.vat_mode)
    const total = supply + vat

    const isPurchase = c.gubu === 'A' || c.gubu === 'E'
    const kind = isPurchase ? 'received' : 'issued'
    const today = kstToday()   // UTC면 KST 00~09시에 하루 전(연초엔 전년도 채번)으로 찍힌다
    const issuedAt = issued_at || today
    const year = String(issuedAt).slice(0, 4)
    const prefix = isPurchase ? '매입' : '청구'
    const [[{ maxno }]] = await conn.execute(
      `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno
       FROM invoices WHERE kind = ? AND invoice_no LIKE ?`,
      [kind, `${prefix}-${year}-%`]
    )
    const invoice_no = `${prefix}-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    // 발행 즉시 정산 시 반영할 계좌: 사용자가 고른 계좌 우선, 없으면 주거래(첫 은행) 계좌.
    const [[defAcc]] = await conn.execute("SELECT id FROM accounts WHERE kind='bank' ORDER BY created_at LIMIT 1")
    const accountId = account_id || (defAcc ? defAcc.id : null)
    const invId = randomUUID()
    const status = paid ? (isPurchase ? '지급 완료' : '입금 완료') : (isPurchase ? '지급 대기' : '입금 예정')
    /* 마감된 달로는 청구서를 발행할 수 없다. 예전엔 'paid' 일 때(거래를 만들 때)만 검사해서,
     * 마감·신고를 끝낸 달로 청구서만 새로 꽂을 수 있었다 → 그 분기 부가세 집계가 신고 후에 바뀐다.
     * 수동 등록(POST /invoices)은 처음부터 issued_at 으로 막고 있었다. */
    { const ce = await closedPeriodError(conn, issuedAt); if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) } }
    // 수량을 0으로 둔 채 기성 발행하면 0원 청구서가 된다 — 마일스톤 발행과 같은 이유로 막는다.
    { const ae = amountError(total); if (ae) { await rollbackQuietly(conn); return res.status(400).json({ error: ae }) } }
    await conn.execute(
      'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, memo, tax_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [invId, invoice_no, kind, c.vendor_id || null, c.id, supply, vat, total, issuedAt, due_at || null, status, paid ? accountId : null, `${c.name} · 기성 ${clean.length}개 품목`, taxTypeOfMode(c.vat_mode)]
    )
    let ord = 0
    for (const l of clean) {
      await conn.execute(
        'INSERT INTO invoice_lines (id, invoice_id, item_id, name, spec, unit, qty, unit_price, cost_price, amount, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [randomUUID(), invId, l.item_id, l.name, l.spec, l.unit, l.qty, l.unit_price, l.cost_price, l.amount, ++ord]
      )
    }
    // 기입금: 실제 입/출금 거래 + 매칭 생성(장부·계좌·계약 수금에 반영)
    if (paid) {
      const lerr = ledgerError({ kind: isPurchase ? 'expense' : 'income', account_id: accountId, status: isPurchase ? '지급완료' : '입금완료' })
      if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: lerr }) }
      const ce = await closedPeriodError(conn, issuedAt)
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
      const txnId = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, account_code, category, amount, date, method, status, doc_no, invoice_id, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txnId, isPurchase ? 'expense' : 'income', c.vendor_id || null, c.id, accountId,
         settleAcctCode(isPurchase ? 'expense' : 'income'),   // 위 마일스톤 발행과 같은 이유
         isPurchase ? '대금 지급' : '수금', total, issuedAt, '계좌이체',
         isPurchase ? '지급완료' : '입금완료', '', invId, `청구서 ${invoice_no} 정산`]
      )
      await conn.execute('INSERT INTO invoice_matches (id, invoice_id, txn_id, amount, txn_created) VALUES (?,?,?,?,1)', [randomUUID(), invId, txnId, total])
    }
    await conn.commit()
    res.json({ ok: true, id: invId, invoice_no, kind, supply, vat, total })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [cRows] = await req.db.execute(
      `SELECT c.*, v.name AS vendor_name, v.gubu AS vendor_gubu, v.gubu, ${METRIC_COLS}
       FROM contracts c LEFT JOIN vendors v ON c.vendor_id = v.id WHERE c.id = ?`,
      [req.params.id]
    )
    if (!cRows[0]) return res.status(404).json({ error: 'Not found' })
    const c = cRows[0]
    const m = metrics(c)
    const [milestones] = await req.db.execute(
      'SELECT * FROM milestones WHERE contract_id = ? ORDER BY due_date',
      [req.params.id]
    )
    const [incomeRows] = await req.db.execute(
      "SELECT t.*, v.name AS vendor_name FROM transactions t LEFT JOIN vendors v ON t.vendor_id=v.id WHERE t.contract_id=? AND t.kind='income' ORDER BY t.date DESC",
      [req.params.id]
    )
    // 지출 목록도 관점에 따라 다른 축을 본다.
    //   매입 계약 → 이 계약이 근거인 지급 (contract_id)
    //   매출 계약 → 이 계약에 귀속된 원가 (cost_contract_id) — 외주비는 외주 매입계약에 지급되지만 원가는 여기 붙는다
    const isPurchaseC = c.vendor_gubu === 'A' || c.vendor_gubu === 'E'
    const [expenseRows] = await req.db.execute(
      `SELECT t.*, v.name AS vendor_name, pc.name AS paid_contract_name, cat.group_name AS category_group
       FROM transactions t
       LEFT JOIN vendors v ON t.vendor_id=v.id
       LEFT JOIN contracts pc ON t.contract_id = pc.id
       LEFT JOIN categories cat ON t.category = cat.name
       WHERE t.${isPurchaseC ? 'contract_id' : 'cost_contract_id'}=? AND t.kind='expense' ORDER BY t.date DESC`,
      [req.params.id]
    )
    // 상세 탭용 가공 데이터
    const incomes = incomeRows.map(t => ({
      date: t.date, type: t.category || '입금', amount: Number(t.amount),
      status: t.status, evid: !!(t.evid_url || t.evid_type),
    }))
    const expenses = expenseRows.map(t => ({
      date: t.date, vendor: t.vendor_name || '—', category: t.category || '—',
      amount: Number(t.amount), doc: t.doc_no ? '작성 완료' : '미작성', pay: t.status,
      // 매출계약 원가 목록에선 "이 돈이 어느 매입계약으로 나갔는지"를 같이 보여준다
      paidContract: t.paid_contract_name || null,
    }))
    const evidences = [...incomeRows, ...expenseRows]
      .filter(t => t.evid_url || t.evid_type)
      .map(t => ({
        name: t.evid_url ? String(t.evid_url).split('/').pop() : (t.evid_type || '증빙'),
        type: t.evid_type || '', size: '', date: t.date,
      }))
    const docs = expenseRows.filter(t => t.doc_no).map(t => ({
      id: t.doc_no,
      title: [t.category, t.vendor_name].filter(Boolean).join(' · ') || '결의서',
      date: t.date, amount: Number(t.amount), status: t.status,
    }))

    // 원가 실적 집계 (지급완료만) — 비목 그룹으로 4분류. 계약 원가예산과 같은 축이다.
    const cost_actual = { material: 0, outsource: 0, labor: 0, overhead: 0 }
    for (const t of expenseRows) {
      if (t.status !== '지급완료') continue
      cost_actual[costBucket(t.category, t.category_group)] += Number(t.amount)
    }

    // 계약 첨부 서류(다중) + 레거시 단일 계약서(file_url) 병합
    const [attRows] = await req.db.execute(
      'SELECT id, url, name, doc_type, size, created_at FROM contract_docs WHERE contract_id = ? ORDER BY created_at',
      [req.params.id]
    )
    const attachments = attRows.map(d => ({ id: d.id, url: d.url, name: d.name, type: d.doc_type || '기타', size: d.size || 0 }))
    if (c.file_url && !attachments.some(a => a.url === c.file_url)) {
      attachments.unshift({ id: null, url: c.file_url, name: c.file_name || '계약서', type: '계약서', size: 0, legacy: true })
    }

    // 갱신 이력 + 이 계약에 걸린 정기청구(금액·기간이 계약과 어긋나는지 화면에서 대조)
    const [renewals] = await req.db.execute(
      'SELECT * FROM contract_renewals WHERE contract_id = ? ORDER BY seq DESC', [req.params.id]
    )
    const num = (v) => (v == null ? null : Number(v))
    // 정기 반복은 매출이면 정기청구(받을 돈), 매입이면 정기지출(나갈 돈)에 들어 있다
    const [recRows] = isPurchaseC
      ? await req.db.execute(
          'SELECT id, category AS item, amount AS supply_amount, period, day_of_month, start_date, end_date, active, last_generated FROM recurring_expenses WHERE contract_id = ?',
          [req.params.id])
      : await req.db.execute(
          'SELECT id, item, supply_amount, period, day_of_month, start_date, end_date, active, last_generated FROM recurring_invoices WHERE contract_id = ?',
          [req.params.id])
    const recurrings = recRows.map(r => ({ ...r, supply_amount: Number(r.supply_amount), active: !!r.active }))

    // 계약 품목표 + 품목별 누적 기성(이 계약의 청구서 line 합계 — 기성형에서만 채워진다)
    const [itemRows] = await req.db.execute(
      'SELECT id, item_id, name, spec, unit, qty, unit_price, cost_price, sort_order FROM contract_items WHERE contract_id = ? ORDER BY sort_order, name',
      [req.params.id]
    )
    const contract_items = itemRows.map(r => ({
      ...r, qty: Number(r.qty), unit_price: Number(r.unit_price), cost_price: Number(r.cost_price),
    }))
    const [progRows] = await req.db.execute(
      `SELECT il.item_id, il.name, il.spec, il.unit,
              SUM(il.qty) AS qty_sum, SUM(il.amount) AS amount_sum
       FROM invoice_lines il JOIN invoices i ON il.invoice_id = i.id
       WHERE i.contract_id = ?
       GROUP BY il.item_id, il.name, il.spec, il.unit
       ORDER BY il.name`,
      [req.params.id]
    )
    const item_progress = progRows.map(r => ({
      item_id: r.item_id, name: r.name, spec: r.spec, unit: r.unit,
      qty_sum: Number(r.qty_sum), amount_sum: Number(r.amount_sum),
    }))
    // 기성형: 이 계약으로 발행한 기성 청구서 목록(품목수 포함) — 상세 '기성 청구 내역' 탭용
    const [progInvRows] = await req.db.execute(
      `SELECT i.id, i.invoice_no, i.kind, i.issued_at, i.due_at, i.total_amount, i.status,
              (SELECT COUNT(*) FROM invoice_lines il WHERE il.invoice_id = i.id) AS line_count
       FROM invoices i WHERE i.contract_id = ? ORDER BY i.issued_at DESC, i.created_at DESC`,
      [req.params.id]
    )
    const progress_invoices = progInvRows.map(r => ({ ...r, total_amount: Number(r.total_amount), line_count: Number(r.line_count) }))

    res.json({
      ...m,
      contract_items, item_progress, progress_invoices,
      renewals: renewals.map(r => ({
        ...r,
        prev_amount: num(r.prev_amount), new_amount: num(r.new_amount),
        prev_unit_amount: num(r.prev_unit_amount), new_unit_amount: num(r.new_unit_amount),
      })),
      recurrings,
      recurring_active: recurrings.filter(r => r.active).length,
      milestones,
      incomes, expenses, evidences, docs, attachments, history: [],
      cost_actual,
      txn_count: incomeRows.length + expenseRows.length,
    })
  } catch (e) { next(e) }
})

// 계약의 품목표를 통째로 교체 저장한다(마일스톤 편집기와 같은 전체 교체 방식).
// items: [{ item_id?, name, spec, unit, qty?, unit_price, cost_price? }]. 이름 없는 행은 건너뛴다.
// 청구 방식과 무관하게 쓴다 — '무엇을 주고받나'(품목)와 '어떻게 청구하나'(billing_mode)는 별개 축이다.
//   총액형·정기형: 수량×단가 합계 = 계약금액(정기형은 주기당 금액). 품목 0줄이면 금액 직접 입력.
//   기성형: 수량은 청구할 때 넣으므로 여기선 0.
// cost_price(매입원가)는 스냅샷 — 기준정보 매입가가 나중에 바뀌어도 이 계약의 원가는 그대로 남는다.
async function replaceContractItems(conn, contractId, items) {
  await conn.execute('DELETE FROM contract_items WHERE contract_id = ?', [contractId])
  if (!Array.isArray(items)) return
  let ord = 0
  for (const it of items) {
    const nm = (it && it.name != null) ? String(it.name).trim() : ''
    if (!nm) continue
    const price = Number(String(it.unit_price ?? '').replace(/[^0-9]/g, '')) || 0
    const cost  = Number(String(it.cost_price ?? '').replace(/[^0-9]/g, '')) || 0
    const qty   = Number(String(it.qty ?? '').replace(/[^0-9.]/g, '')) || 0
    await conn.execute(
      'INSERT INTO contract_items (id, contract_id, item_id, name, spec, unit, qty, unit_price, cost_price, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [randomUUID(), contractId, it.item_id || null, nm, it.spec || null, it.unit || null, qty, price, cost, ++ord]
    )
  }
}

router.post('/', async (req, res, next) => {
  const { vendor_id, name, start_date, status, order_no, project_no, cost_budget, file_url, file_name, contract_no } = req.body
  const f = model.normalize(req.body)   // 금액·기간·갱신 필드는 모델이 결정 (모순된 조합 저장 방지)
  const id = randomUUID()
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    await conn.execute(
      `INSERT INTO contracts (id, vendor_id, name, amount, start_date, end_date, status, order_no, project_no,
                              cost_budget, file_url, file_name, contract_no,
                              billing_mode, term_mode, unit_amount, billing_period, billing_day, initial_amount, term_months, notice_days, current_term_start, vat_mode)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, vendor_id||null, name, f.amount, start_date||null, f.end_date, status||'진행중', order_no||null, project_no||null,
       cost_budget ? JSON.stringify(cost_budget) : null, file_url||null, file_name||null, contract_no||null,
       f.billing_mode, f.term_mode, f.unit_amount, f.billing_period, f.billing_day, f.initial_amount, f.term_months, f.notice_days, start_date||null, f.vat_mode]
    )

    // 거래처 gubu로 매출/매입 판별 — 정기 반복을 정기청구(매출)에 걸지 정기지출(매입)에 걸지 결정.
    let gubu = null
    if (vendor_id) {
      const [[v]] = await conn.execute('SELECT gubu FROM vendors WHERE id = ?', [vendor_id])
      gubu = v ? v.gubu : null
    }
    const isPurchase = gubu === 'A' || gubu === 'E'

    // 계약을 등록하면 청구할 것이 자동으로 '발행 예정'에 뜨도록, 유형에 맞춰 일정/정기반복을 깔아준다.
    // (수동 설정을 깜빡해 청구가 누락되는 걸 막는다. 필요하면 청구 일정 탭·정기청구 탭에서 수정)
    if (f.billing_mode === 'recurring') {
      // 초기 일시금(구축비)은 1회성 청구 → 청구 일정 1건
      if (f.initial_amount > 0) {
        await conn.execute(
          'INSERT INTO milestones (id, contract_id, type, ratio, amount, due_date, status) VALUES (?,?,?,?,?,?,?)',
          [randomUUID(), id, '초기 일시금', 0, f.initial_amount, start_date || null, '예정']
        )
      }
      /* 월 정액은 정기청구(매출)/정기지출(매입)로 자동 세팅 → 회차가 도래하면 발행예정에 뜬다.
       *
       * 예전엔 `&& start_date` 가 붙어 있어서 **시작일 없는 계약은 정기 규칙이 아예 안 만들어졌다.**
       * 계약은 저장되고 월 정액도 적혀 있는데 청구만 조용히 빠지는 것이라, 사용자가 알 방법이
       * 없었다(무기한 유지보수처럼 시작일이 모호한 계약에서 그대로 걸린다).
       * 월 정액을 적었다는 건 청구·지급을 하겠다는 뜻이므로 규칙은 만들고, 언제부터 셀지는
       * 엔진이 등록일로 받아준다(lib/recurrence.js 앵커 폴백). */
      if (Number(f.unit_amount) > 0) {
        if (isPurchase) {
          /* ⚠ vat_mode 를 반드시 넣는다. 빠뜨리면 recurring.js 가 비목명으로 세액을 유추하는데,
           * 여기서 category 에 넣는 값은 비목명이 아니라 **계약명**이라 조인이 절대 안 맞는다
           * → modeFromCatVat(null) → 'none'(면세) → 과세 매입계약인데 매달 부가세 0으로 청구되어
           *   **매입세액이 매달 사라졌다.** 바로 아래 매출(recurring_invoices)은 원래 넣고 있었다. */
          await conn.execute(
            `INSERT INTO recurring_expenses (id, vendor_id, contract_id, category, amount, vat_mode, period, day_of_month, start_date, end_date, account_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [randomUUID(), vendor_id || null, id, name || '정기지출', Number(f.unit_amount),
             vatRateOf(f.vat_mode) === 0 ? 'none' : 'exclusive',
             f.billing_period || 'monthly', f.billing_day || 1, start_date || '', f.end_date || null, null]
          )
        } else {
          await conn.execute(
            `INSERT INTO recurring_invoices (id, vendor_id, contract_id, item, supply_amount, vat_mode, period, day_of_month, start_date, end_date, account_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [randomUUID(), vendor_id || null, id, name || '', Number(f.unit_amount), vatRateOf(f.vat_mode) === 0 ? 'none' : 'exclusive',
             f.billing_period || 'monthly', f.billing_day || 1, start_date || '', f.end_date || null, null]
          )
        }
      }
    } else if (f.billing_mode === 'progress') {
      // 기성형: 총액·마일스톤 없음. 청구는 계약 상세의 '기성 청구'에서 그때그때 발행한다.
    } else if (Number(f.amount) > 0) {
      // 단건 계약: 계약금액 전체를 '예정' 청구 일정 1건으로 자동 생성 → 발행예정에 바로 뜬다.
      // 선급/기성/잔금으로 쪼갤 거면 청구 일정 탭에서 편집하면 이 1건이 대체된다(편집기는 전체 교체 방식).
      // 타입 '일시'(일시불) — 청구 일정 편집기 유형 목록(MS_TYPES)에 있는 값이라 그대로 표시·수정된다.
      await conn.execute(
        'INSERT INTO milestones (id, contract_id, type, ratio, amount, due_date, status) VALUES (?,?,?,?,?,?,?)',
        [randomUUID(), id, '일시', 100, f.amount, start_date || null, '예정']
      )
    }
    // 품목표는 청구 방식과 무관하게 저장한다(총액형·정기형도 품목으로 구성 가능 — 선택).
    await replaceContractItems(conn, id, req.body.items)

    await conn.commit()
    res.json({ id })
  } catch (e) {
    await rollbackQuietly(conn)
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '이미 사용 중인 계약번호예요' })
    next(e)
  } finally {
    conn.release()
  }
})

/* 계약을 '완료'로 바꾸기 전에 "무엇이 멈추는지"를 화면이 먼저 보여줄 수 있게 하는 조회.
   무기한 계약은 종료일이 없어 끝난 뒤에도 회차가 영원히 후보로 뜬다 — 그걸 여기서 잡는다. */
router.get('/:id/recurring/open-ended', async (req, res, next) => {
  try {
    const [[c]] = await req.db.execute('SELECT end_date FROM contracts WHERE id = ?', [req.params.id])
    if (!c) return res.status(404).json({ error: '계약을 찾을 수 없어요' })
    const found = await findOpenEndedRecurring(req.db, req.params.id)
    res.json({ ...found, suggestedEndDate: c.end_date || kstToday() })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  const { vendor_id, name, start_date, status, order_no, project_no, file_url, file_name, contract_no, cost_budget } = req.body
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    // 이번 텀 총액은 현재 텀 시작일 기준으로 다시 산출 (편집으로 단가·종료일이 바뀔 수 있음)
    const [[cur]] = await conn.execute('SELECT current_term_start, start_date FROM contracts WHERE id = ? FOR UPDATE', [req.params.id])
    if (!cur) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    const termStart = cur.current_term_start || start_date || cur.start_date || null
    const f = model.normalize({ ...req.body, current_term_start: termStart })
    const [result] = await conn.execute(
      `UPDATE contracts SET vendor_id=?, name=?, amount=?, start_date=?, end_date=?, status=?, order_no=?, project_no=?,
                            file_url=?, file_name=?, contract_no=?,
                            billing_mode=?, term_mode=?, unit_amount=?, billing_period=?, billing_day=?, initial_amount=?, term_months=?, notice_days=?, current_term_start=?, vat_mode=?
       WHERE id=?`,
      [vendor_id||null, name, f.amount, start_date||null, f.end_date, status||'진행중', order_no||null, project_no||null,
       file_url||null, file_name||null, contract_no||null,
       f.billing_mode, f.term_mode, f.unit_amount, f.billing_period, f.billing_day, f.initial_amount, f.term_months, f.notice_days, termStart, f.vat_mode, req.params.id]
    )
    if (result.affectedRows === 0) { await rollbackQuietly(conn); return res.status(404).json({ error: 'Not found' }) }
    // 원가예산은 보낸 요청만 갱신한다(예산을 다루지 않는 화면의 저장이 기존 예산을 지우면 안 된다)
    if (cost_budget !== undefined) {
      await conn.execute('UPDATE contracts SET cost_budget = ? WHERE id = ?',
        [cost_budget ? JSON.stringify(cost_budget) : null, req.params.id])
    }
    // 품목표: 폼에서 넘어온 대로 통째 교체(청구 방식 무관). items를 아예 안 보낸 요청은
    // 품목을 다루지 않는 화면이므로 기존 품목표를 건드리지 않는다.
    if (req.body.items !== undefined) await replaceContractItems(conn, req.params.id, req.body.items)

    /* 청구 방식을 바꿔 저장했을 때 뒤따라야 할 정리 — 등록(POST)에만 있고 편집(PUT)엔 없었다.
     *
     * 실제로 이런 일이 있었다(운영 fowin, 2026-08-05): 단건으로 만든 계약(계약금액 5만)을
     * 정기형(월 5만)으로 고쳤더니
     *   · 옛 '일시' 청구 일정이 그대로 남아 대금 청구서 '발행 예정'에 216일 초과로 떠 있고
     *   · **정기청구 규칙은 만들어지지 않아 매달 청구가 아예 안 걸렸다.**
     * 계약 화면만 보면 정기형으로 잘 바뀐 것처럼 보여서 알아채기 어렵다.
     */
    if (f.billing_mode === 'recurring' || f.billing_mode === 'progress') {
      /* '일시'(계약금액 100% 1회)는 정기·기성과 양립할 수 없다. 아직 발행 안 된 것만 지운다 —
         이미 청구서가 나간 일정은 장부 근거라 건드리지 않는다.
         '초기 일시금'은 정기형과 함께 쓰라고 만든 유형이므로 대상이 아니다. */
      await conn.execute(
        `DELETE FROM milestones
         WHERE contract_id = ? AND type = '일시' AND status = '예정'
           AND (invoice_id IS NULL OR invoice_id = '')`, [req.params.id])
    }
    if (f.billing_mode === 'recurring' && Number(f.unit_amount) > 0) {
      /* 규칙이 **하나도 없을 때만** 만든다(active=0 도 '있는' 것으로 친다).
         사용자가 일부러 꺼 둔 정기청구를, 계약을 저장했다는 이유로 되살리면 안 된다. */
      const [[vg]] = await conn.execute('SELECT gubu FROM vendors WHERE id = ?', [vendor_id || ''])
      const isPurchaseC = vg && (vg.gubu === 'A' || vg.gubu === 'E')
      const table = isPurchaseC ? 'recurring_expenses' : 'recurring_invoices'
      const [[cnt]] = await conn.execute(`SELECT COUNT(*) AS n FROM ${table} WHERE contract_id = ?`, [req.params.id])
      if (Number(cnt.n) > 0) {
        /* 이미 규칙이 있으면 계약 조건으로 맞춘다 — 계약이 원본이기 때문이다.
           예전엔 계약을 고쳐도 규칙이 그대로여서, 시작일을 7/1로 당겨도 규칙은 8/5를 붙들었다.
           (화면의 '계약 조건으로 맞추기' 버튼은 그대로 둔다 — 규칙이 다른 이유로 어긋났을 때 쓴다) */
        await syncRecurringToContract(conn, {
          id: req.params.id, unit_amount: f.unit_amount, vat_mode: f.vat_mode,
          billing_period: f.billing_period, billing_day: f.billing_day,
          start_date, end_date: f.end_date,
        }, isPurchaseC)
      } else {
        const vatMode = vatRateOf(f.vat_mode) === 0 ? 'none' : 'exclusive'
        if (isPurchaseC) {
          await conn.execute(
            `INSERT INTO recurring_expenses (id, vendor_id, contract_id, category, amount, vat_mode, period, day_of_month, start_date, end_date, account_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [randomUUID(), vendor_id || null, req.params.id, name || '정기지출', Number(f.unit_amount), vatMode,
             f.billing_period || 'monthly', f.billing_day || 1, start_date || '', f.end_date || null, null])
        } else {
          await conn.execute(
            `INSERT INTO recurring_invoices (id, vendor_id, contract_id, item, supply_amount, vat_mode, period, day_of_month, start_date, end_date, account_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [randomUUID(), vendor_id || null, req.params.id, name || '', Number(f.unit_amount), vatMode,
             f.billing_period || 'monthly', f.billing_day || 1, start_date || '', f.end_date || null, null])
        }
      }
    }

    /* '완료'로 닫으면서 화면이 동의를 받아 왔을 때만 정기 규칙의 종료일을 채운다.
       요청하지 않으면 아무것도 안 한다 — 사용자가 모르는 사이에 청구가 멈추면 안 된다. */
    let recurringClosed = null
    if (status === '완료' && req.body.close_recurring) {
      const endDate = f.end_date || kstToday()
      recurringClosed = { ...(await closeOpenEndedRecurring(conn, req.params.id, endDate)), end_date: endDate }
    }
    await conn.commit()
    res.json({ ok: true, recurringClosed })
  } catch (e) {
    await rollbackQuietly(conn)
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '이미 사용 중인 계약번호예요' })
    next(e)
  } finally {
    conn.release()
  }
})

// 계약 삭제 — 돈 기록(청구서·거래·정기반복)이 하나라도 걸려 있으면 막는다.
// 걸린 게 없을 때만 지우고, 그때 설정 성격(마일스톤·품목표·갱신이력·첨부)은 함께 지운다.
// 거래처·거래 삭제와 같은 '안전 삭제' 방식 — 지우면 조용히 고아가 되거나 잔액이 틀어질 걸 미리 차단.
router.delete('/:id', async (req, res, next) => {
  const id = req.params.id
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[c]] = await conn.execute('SELECT id, name FROM contracts WHERE id = ? FOR UPDATE', [id])
    if (!c) { await rollbackQuietly(conn); return res.status(404).json({ error: '계약을 찾을 수 없어요' }) }

    // 돈 기록 집계 — 거래는 두 축(근거 contract_id / 원가귀속 cost_contract_id)을 모두 본다
    const [[cnt]] = await conn.execute(`
      SELECT
        (SELECT COUNT(*) FROM invoices           WHERE contract_id = ?) AS invs,
        (SELECT COUNT(*) FROM transactions        WHERE contract_id = ? OR cost_contract_id = ?) AS txns,
        (SELECT COUNT(*) FROM recurring_invoices  WHERE contract_id = ?) AS recin,
        (SELECT COUNT(*) FROM recurring_expenses  WHERE contract_id = ?) AS recex`,
      [id, id, id, id, id])
    const parts = []
    if (Number(cnt.invs)  > 0) parts.push(`청구서 ${cnt.invs}건`)
    if (Number(cnt.txns)  > 0) parts.push(`거래 ${cnt.txns}건`)
    if (Number(cnt.recin) > 0) parts.push(`정기청구 ${cnt.recin}건`)
    if (Number(cnt.recex) > 0) parts.push(`정기지출 ${cnt.recex}건`)
    if (parts.length) {
      await rollbackQuietly(conn)
      // 어디서 정리하는지까지 알려준다. 예전에는 "먼저 정리하세요"라고만 해서,
      // 정작 정기지출·정기청구는 지울 화면이 없어 사용자가 막다른 골목에 갇혔다.
      const where = (Number(cnt.recin) > 0 || Number(cnt.recex) > 0)
        ? " 정기청구·정기지출은 기준정보 화면에서 삭제할 수 있어요."
        : ""
      return res.status(409).json({
        error: `이 계약엔 ${parts.join(' · ')}이 연결돼 있어 지울 수 없어요. 먼저 그 기록을 정리하거나, 계약 상태를 '완료'·'보류'로 두세요.${where}`,
      })
    }

    // 첨부 파일 경로를 먼저 모아둔다(행을 지우기 전에) — 디스크에서도 지워 고아 파일을 막는다
    const [docRows] = await conn.execute('SELECT url FROM contract_docs WHERE contract_id = ?', [id])
    const [[cf]] = await conn.execute('SELECT file_url FROM contracts WHERE id = ?', [id])
    const fileUrls = [...docRows.map(d => d.url), cf?.file_url].filter(Boolean)

    // 설정 성격만 남았다 — 명시적으로 지운다(FK CASCADE에 기대지 않고 의도를 코드로 드러낸다)
    await conn.execute('DELETE FROM milestones        WHERE contract_id = ?', [id])
    await conn.execute('DELETE FROM contract_items     WHERE contract_id = ?', [id])
    await conn.execute('DELETE FROM contract_renewals  WHERE contract_id = ?', [id])
    await conn.execute('DELETE FROM contract_docs      WHERE contract_id = ?', [id])
    await conn.execute('DELETE FROM contracts          WHERE id = ?', [id])
    await conn.commit()
    // 커밋 후 파일 정리 — 실패해도 계약 삭제는 이미 끝났으므로 조용히 넘어간다(고아 파일만 남을 뿐)
    for (const u of fileUrls) { try { removeUploadedFile(u, req.user?.companyId) } catch {} }
    res.json({ ok: true })
  } catch (e) {
    await rollbackQuietly(conn)
    next(e)
  } finally {
    conn.release()
  }
})

// 계약의 정기 반복은 매출/매입에 따라 들어가는 곳이 다르다.
//   매출 계약(gubu B·미상) → recurring_invoices (받을 돈: 정기청구)
//   매입 계약(gubu A·E)    → recurring_expenses (나갈 돈: 정기지출)
// 이걸 안 나누면 매입 계약에 건 반복이 '받을 돈(미수금)'으로 둔갑한다.
const purchaseContract = (c) => c.gubu === 'A' || c.gubu === 'E'
const loadContractWithGubu = async (db, id) => {
  const [[c]] = await db.execute(
    'SELECT c.*, v.gubu FROM contracts c LEFT JOIN vendors v ON c.vendor_id = v.id WHERE c.id = ?', [id]
  )
  return c
}

// 정기형 계약 → 정기청구(매출) 또는 정기지출(매입) 걸기.
// 계약의 주기·금액·기간·거래처를 그대로 가져간다 (계약이 원본, 반복은 실행 장치).
router.post('/:id/recurring', async (req, res, next) => {
  try {
    const c = await loadContractWithGubu(req.db, req.params.id)
    if (!c) return res.status(404).json({ error: '계약을 찾을 수 없어요' })
    if (c.billing_mode !== 'recurring') return res.status(400).json({ error: '정기형 계약이 아니에요' })
    if (!c.unit_amount)  return res.status(400).json({ error: '주기당 금액이 없어요' })
    // 시작일은 없어도 된다 — 없으면 등록일부터 센다(lib/recurrence.js 앵커 폴백).
    // 예전엔 여기서 400으로 막아, 시작일이 모호한 무기한 계약은 정기청구를 걸 길이 없었다.

    const isPurchase = purchaseContract(c)
    const table = isPurchase ? 'recurring_expenses' : 'recurring_invoices'
    const [[dup]] = await req.db.execute(`SELECT COUNT(*) AS n FROM ${table} WHERE contract_id=? AND active=1`, [req.params.id])
    if (Number(dup.n) > 0) {
      return res.status(409).json({ error: `이미 이 계약에 걸린 ${isPurchase ? '정기지출' : '정기청구'}이 있어요` })
    }

    const id = randomUUID()
    if (isPurchase) {
      await req.db.execute(
        `INSERT INTO recurring_expenses (id, vendor_id, contract_id, category, amount, period, day_of_month, start_date, end_date, account_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, c.vendor_id || null, c.id, c.name || '정기지출', Number(c.unit_amount),
         c.billing_period || 'monthly', c.billing_day || 1, c.start_date || '', c.end_date || null, req.body.account_id || null]
      )
    } else {
      await req.db.execute(
        `INSERT INTO recurring_invoices (id, vendor_id, contract_id, item, supply_amount, vat_mode, period, day_of_month, start_date, end_date, account_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, c.vendor_id || null, c.id, c.name || '', Number(c.unit_amount), vatRateOf(c.vat_mode) === 0 ? 'none' : 'exclusive',
         c.billing_period || 'monthly', c.billing_day || 1, c.start_date || '', c.end_date || null, req.body.account_id || null]
      )
    }
    res.json({ ok: true, id, kind: isPurchase ? 'expense' : 'invoice' })
  } catch (e) { next(e) }
})

// 계약에 걸린 정기 반복을 계약 조건에 다시 맞춘다(금액·주기·청구일·종료일).
router.patch('/:id/recurring/sync', async (req, res, next) => {
  try {
    const c = await loadContractWithGubu(req.db, req.params.id)
    if (!c) return res.status(404).json({ error: '계약을 찾을 수 없어요' })
    if (c.billing_mode !== 'recurring') return res.status(400).json({ error: '정기형 계약이 아니에요' })
    const isPurchase = purchaseContract(c)
    // 매출 정기청구는 계약의 과세/면세(vat_mode)도 함께 맞춘다(계약을 과세↔면세로 바꾼 뒤 sync 시 반영).
    const r = await syncRecurringToContract(req.db, c, isPurchase)
    res.json({ ok: true, updated: r.affectedRows })
  } catch (e) { next(e) }
})

// 계약에 걸린 정기 반복 중지/재개 — 매출·매입 어느 쪽이든 계약 화면에서 처리한다
router.patch('/:id/recurring/:recId/toggle', async (req, res, next) => {
  try {
    const c = await loadContractWithGubu(req.db, req.params.id)
    if (!c) return res.status(404).json({ error: '계약을 찾을 수 없어요' })
    const table = purchaseContract(c) ? 'recurring_expenses' : 'recurring_invoices'
    const [[row]] = await req.db.execute(`SELECT active FROM ${table} WHERE id=? AND contract_id=?`, [req.params.recId, req.params.id])
    if (!row) return res.status(404).json({ error: '정기 항목을 찾을 수 없어요' })
    const next_ = row.active ? 0 : 1
    await req.db.execute(`UPDATE ${table} SET active=? WHERE id=?`, [next_, req.params.recId])
    res.json({ ok: true, active: !!next_ })
  } catch (e) { next(e) }
})

router.post('/:id/milestones', async (req, res, next) => {
  const { milestones } = req.body
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    await conn.execute('DELETE FROM milestones WHERE contract_id = ?', [req.params.id])
    for (const m of (Array.isArray(milestones) ? milestones : [])) {
      await conn.execute(
        'INSERT INTO milestones (id, contract_id, type, ratio, amount, due_date, status, invoice_id) VALUES (?,?,?,?,?,?,?,?)',
        [randomUUID(), req.params.id, m.type, m.ratio||0, m.amount, m.due_date||null, m.status||'예정', m.invoice_id||null]
      )
    }
    await conn.commit()
    res.json({ ok: true })
  } catch (e) {
    await rollbackQuietly(conn)
    next(e)
  } finally {
    conn.release()
  }
})

router.put('/:id/cost-budget', async (req, res, next) => {
  try {
    const [result] = await req.db.execute(
      'UPDATE contracts SET cost_budget = ? WHERE id = ?',
      [JSON.stringify(req.body), req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.get('/:id/cost-analysis', async (req, res, next) => {
  try {
    const [cRows] = await req.db.execute('SELECT * FROM contracts WHERE id = ?', [req.params.id])
    if (!cRows[0]) return res.status(404).json({ error: 'Not found' })
    const c = cRows[0]
    const budget = safeBudget(c.cost_budget, { material: 0, outsource: 0, labor: 0, overhead: 0 })
    // ⚠ 원가는 cost_contract_id 축이다. contract_id 는 '이 계약이 근거인 지출'(매입계약의
    // 지급액)이라 매출계약에는 붙지 않아, 예전 코드는 항상 0을 반환했다(호출자가 없어
    // 드러나지 않았을 뿐이다). 계약 상세가 쓰는 cost_total(METRIC_COLS)과 같은 축으로 맞춘다.
    const [txns] = await req.db.execute(
      `SELECT t.category, cat.group_name AS category_group, SUM(t.amount) AS total
       FROM transactions t LEFT JOIN categories cat ON t.category = cat.name
       WHERE t.cost_contract_id = ? AND t.kind='expense' AND t.status='지급완료'
       GROUP BY t.category, cat.group_name`,
      [req.params.id]
    )
    const actual = { material: 0, outsource: 0, labor: 0, overhead: 0 }
    for (const t of txns) {
      actual[costBucket(t.category, t.category_group)] += Number(t.total)
    }
    const totalBudget = Object.values(budget).reduce((s, v) => s + v, 0)
    const totalActual = Object.values(actual).reduce((s, v) => s + v, 0)
    res.json({
      budget, actual, totalBudget, totalActual,
      targetCostRate: c.amount > 0 ? totalBudget / c.amount : 0,
      actualCostRate:  c.amount > 0 ? totalActual / c.amount : 0,
      estimatedProfit: c.amount - totalActual,
    })
  } catch (e) { next(e) }
})

// ── 계약 첨부 서류(다중) ──
router.post('/:id/docs', async (req, res, next) => {
  try {
    const { url, name, doc_type, size } = req.body
    if (!url) return res.status(400).json({ error: 'url 필수' })
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO contract_docs (id, contract_id, url, name, doc_type, size) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, url, name || '', doc_type || '', size || 0]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.delete('/docs/:docId', async (req, res, next) => {
  try {
    // DB 행만 지우면 실제 파일이 uploads/{companyId}/ 에 그대로 남는다(고아 파일).
    const [[doc]] = await req.db.execute('SELECT url FROM contract_docs WHERE id = ?', [req.params.docId])
    await req.db.execute('DELETE FROM contract_docs WHERE id = ?', [req.params.docId])
    if (doc) removeUploadedFile(doc.url, req.user?.companyId)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 계약 메모 저장(단일 필드)
router.patch('/:id/memo', async (req, res, next) => {
  try {
    const [r] = await req.db.execute('UPDATE contracts SET memo = ? WHERE id = ?', [req.body.memo ?? null, req.params.id])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 레거시 단일 계약서(file_url) 제거
router.patch('/:id/clear-file', async (req, res, next) => {
  try {
    await req.db.execute('UPDATE contracts SET file_url=NULL, file_name=NULL WHERE id=?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
