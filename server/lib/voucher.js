/**
 * 전표 — 장부에 오르는 한 건을 차변·대변 줄로 펼친다.
 *
 * ── 왜 '전표'인가 ──
 * 경리 실무는 거래를 **전표**라는 종이 한 장 단위로 다룬다. 이 앱은 그 단위를 화면 뒤로
 * 숨기고 '거래 등록'만 보여줬는데, 회계를 아는 사용자에게는 **전표가 없는 프로그램**으로
 * 읽혔다. 실제로는 이미 복식으로 전개하고 있었으므로(lib/cashReport.js dailyTrial),
 * 없던 것은 계산이 아니라 **표현**이다. 이 파일이 그 표현을 한곳에 모은다.
 *
 * ── 전표 종류 ──
 * 3전표제에서 입금·출금전표는 **현금(시재) 전용**이다. 양식 자체가 한쪽을 현금으로 못 박고
 * 상대 계정 한 줄만 적게 되어 있어서, 통장 거래는 담을 자리가 없다. 그래서 보통예금·당좌
 * 거래는 전부 대체전표다(더존 등 전산 프로그램도 같은 규칙 — 출금을 고르면 현금이 자동으로 박힌다).
 *
 *   입금전표   차변이 1101 현금
 *   출금전표   대변이 1101 현금
 *   대체전표   그 외 전부 — 통장 거래, 청구서 발행 분개 등
 *
 * ── 두 시점 ──
 * 청구서 발행과 대금 결제는 **서로 다른 전표**다. 발행 때 생긴 채권·채무가 결제 때 사라진다.
 *   발행: 차변 외상매출금 / 대변 매출 + 부가세예수금
 *   결제: 차변 보통예금   / 대변 외상매출금
 * 발행 전표가 없으면 외상매출금이 **생긴 적 없이 사라지고**, 매출 계정은 평생 한 번도
 * 찍히지 않는다. 하루치 일계표는 그래도 맞아 보이지만 누적하면 장부가 성립하지 않는다.
 *
 * ── 저장하지 않는다 ──
 * 전표는 별도 테이블에 쌓지 않고 거래·청구서에서 **그때그때 계산**한다. 그래서 부가세처럼
 * 줄이 셋 이상 필요한 분개도 스키마를 바꾸지 않고 표현할 수 있다(transactions 는 계정이 둘 고정).
 */

const CASH = '1101'                    // 현금(시재) — 입금·출금전표를 가르는 유일한 기준
const AR   = '1204'                    // 외상매출금
const AP   = '2101'                    // 외상매입금
const VAT_RECEIVABLE = '1306'          // 부가세대급금 (매입세액)
const VAT_PAYABLE    = '2208'          // 부가세예수금 (매출세액)
const DEFAULT_SALES  = '4102'          // 제품매출 — 매출 청구서에 비목이 없을 때의 기본값

const TYPE = { IN: '입금전표', OUT: '출금전표', TRANSFER: '대체전표' }

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** 금액 0 이하인 줄은 전표에 세우지 않는다(면세 청구서의 부가세 줄 등) */
const line = (side, code, amount) => (num(amount) > 0 && code ? { side, code, amount: num(amount) } : null)

const build = (type, meta, rawLines) => {
  const lines = rawLines.filter(Boolean)
  const debit = lines.filter(l => l.side === 'debit').reduce((s, l) => s + l.amount, 0)
  const credit = lines.filter(l => l.side === 'credit').reduce((s, l) => s + l.amount, 0)
  return {
    ...meta,
    type,
    lines,
    debitTotal: debit,
    creditTotal: credit,
    /* 짝이 맞는가. 안 맞으면 감추지 않고 그대로 알린다 — 조용히 맞추면
     * 틀린 장부가 맞는 것처럼 보인다(일계표 화면과 같은 원칙). */
    balanced: debit === credit && lines.length >= 2,
    missing: lines.length < 2 ? '계정과목이 비어 한쪽 다리가 없어요' : null,
  }
}

/**
 * 거래 → 전표.
 *
 * @param {object} t 거래 행. `kind`·`amount`·`date`·`account_code` 와
 *                   계좌의 계정과목 `bank_code`(accounts.acct_code) 가 필요하다.
 *
 * 입금이면 돈이 계좌로 들어오므로 계좌가 차변, 지출이면 계좌가 대변이다.
 * 상대 계정(account_code)이 비면 줄이 하나뿐이라 balanced=false 로 나간다.
 */
function transactionVoucher(t) {
  const bank = t.bank_code || null
  const other = t.account_code || null
  const amount = num(t.amount)
  const isIncome = t.kind === 'income'

  const lines = isIncome
    ? [line('debit', bank, amount),  line('credit', other, amount)]
    : [line('debit', other, amount), line('credit', bank, amount)]

  // 현금 계정이 낀 거래만 입금·출금전표다. 통장 거래는 대체전표.
  const type = bank === CASH ? (isIncome ? TYPE.IN : TYPE.OUT) : TYPE.TRANSFER

  return build(type, {
    source: 'transaction',
    id: t.id,
    date: t.date,
    summary: t.memo || t.category || '',
    counterparty: t.vendor_name || '',
  }, lines)
}

/**
 * 청구서 발행 → 전표.
 *
 * 자금이 움직이지 않으므로 **항상 대체전표**다(현금이 끼지 않는다).
 * 공급가액과 부가세를 나눠 세우기 때문에 줄이 셋이 될 수 있다 — 거래 전표(2줄)와 다른 점이다.
 *
 * @param {object} inv 청구서 행. `kind`('issued'|'received')·금액 3종·`account_code` 필요.
 */
function invoiceVoucher(inv) {
  const total  = num(inv.total_amount)
  const vat    = num(inv.vat_amount)
  /* 공급가액이 비어 있는 옛 데이터는 합계에서 세액을 뺀 값으로 본다 —
   * 0 으로 두면 매출 줄이 통째로 사라져 차·대변이 안 맞는다. */
  const supply = num(inv.supply_amount) || (total - vat)
  const isIssued = inv.kind === 'issued'

  const lines = isIssued
    ? [
        // 매출: 받을 권리가 생기고(차변), 매출과 낼 세금이 생긴다(대변)
        line('debit',  AR, total),
        line('credit', inv.account_code || DEFAULT_SALES, supply),
        line('credit', VAT_PAYABLE, vat),
      ]
    : [
        // 매입: 비용과 돌려받을 세금이 생기고(차변), 갚을 빚이 생긴다(대변)
        line('debit',  inv.account_code, supply),
        line('debit',  VAT_RECEIVABLE, vat),
        line('credit', AP, total),
      ]

  const v = build(TYPE.TRANSFER, {
    source: 'invoice',
    id: inv.id,
    date: inv.issued_at,
    summary: `${inv.invoice_no || ''} ${isIssued ? '매출' : '매입'} 발행`.trim(),
    counterparty: inv.vendor_name || '',
  }, lines)

  // 매입인데 비목이 없으면 차변 비용 계정이 통째로 빈다 — 무엇이 없는지 그대로 말한다
  if (!isIssued && !inv.account_code) v.missing = '비목이 없어 어떤 비용인지 정해지지 않았어요'
  return v
}

/**
 * 전표 줄에 계정과목 이름을 붙인다.
 *
 * 코드만 내보내면 화면이 계정과목표를 다시 조회해야 하고, 인쇄본에는 숫자만 남아
 * 사람이 읽을 수 없다. 이름은 서버에서 붙여 내보낸다.
 *
 * @param db 테넌트 연결(req.db). **기본값을 두지 않는다** — 빠뜨리면 조용히 남의 회사를 읽는다.
 */
async function withNames(db, voucher, extra = {}) {
  if (!db) throw new Error('withNames: 테넌트 연결(db)이 필요합니다')
  const codes = [...new Set(voucher.lines.map(l => String(l.code)))]
  if (codes.length === 0) return { ...voucher, ...extra }
  const [rows] = await db.execute(
    `SELECT code, name, acct_type FROM account_subjects WHERE code IN (${codes.map(() => '?').join(',')})`,
    codes)
  const by = new Map(rows.map(r => [String(r.code), r]))
  return {
    ...voucher, ...extra,
    lines: voucher.lines.map(l => ({
      ...l,
      // 표에 없는 코드(옛 데이터)는 코드를 그대로 세운다 — 빈칸으로 두면 사라진 것처럼 보인다
      name: by.get(String(l.code))?.name || String(l.code),
      acct_type: by.get(String(l.code))?.acct_type || '',
    })),
  }
}

module.exports = {
  TYPE, CASH, AR, AP, VAT_RECEIVABLE, VAT_PAYABLE, DEFAULT_SALES,
  transactionVoucher, invoiceVoucher, withNames,
}
