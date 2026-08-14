/**
 * 세무사 전달용 자료 — 한 달치 회계 자료를 종류별로 모은다.
 *
 * ── 왜 새로 만드나 ──
 * 화면(Docs.jsx ReportTaxOffice)은 있었지만 **건수가 코드에 박혀 있었다**
 * (16건·7건·5건·8건·7명·1건·누락 3건). 실데이터와 아무 상관이 없는데 초록 체크까지 붙어
 * "준비 완료"로 읽혔다. 신고철에 그걸 믿고 넘어가면 자료가 통째로 빠진 채 세무사에게 간다 —
 * 화면이 거짓을 말하는, 이 코드베이스에서 제일 나쁜 종류다.
 *
 * ── 무엇을 세는가 ──
 * 세무사가 월마감에 실제로 요구하는 것들이다. 각 항목은 **건수와 행을 함께** 낸다 —
 * 건수만 내면 "16건"이 맞는지 확인할 방법이 없다.
 *
 * ── 기준 ──
 * · 달 구간은 **회계 기간**을 따른다(마감일 25일 회사면 7월분 = 6/26~7/25).
 *   달력월로 세면 그 회사의 다른 화면(매입·매출 현황)과 건수가 어긋난다.
 * · 거래는 **완료된 것만**(입금완료/지급완료). 예정은 아직 장부가 아니다.
 * · 금액은 그대로 낸다. 여기서 손익을 계산하지 않는다 — 계산은 세무사가 한다.
 */

const { SETTLED_INCOME, SETTLED_EXPENSE } = require('./ledger')
const { monthRange } = require('./period')

/* 항목 정의. label 은 화면·엑셀 시트 이름으로 그대로 쓴다(둘이 갈리면 대조가 안 된다).
 * required=true 인 항목이 0건이면 화면이 '확인 필요'로 표시한다 —
 * 급여가 0건인 달은 정상일 수 있지만(대표 1인 회사), 입출금이 0건인 달은 대개 입력이 안 된 것이다. */
const SECTIONS = [
  { key: 'txns',        label: '월별 입출금 내역',      unit: '건', required: true },
  { key: 'resolutions', label: '지출결의서 (승인 완료)', unit: '건', required: false },
  { key: 'salesTax',    label: '세금계산서 (매출)',      unit: '건', required: false },
  { key: 'purchaseTax', label: '세금계산서 (매입)',      unit: '건', required: false },
  { key: 'payroll',     label: '급여대장',              unit: '명', required: false },
  { key: 'withholding', label: '원천징수 대상 급여',     unit: '건', required: false },
  { key: 'noEvidence',  label: '증빙 누락 지출',         unit: '건', required: false, warn: true },
]

const num = (v) => Number(v) || 0

/**
 * 한 달치 자료를 모은다.
 * @param db          req.db (테넌트 DB — 전역 풀 금지)
 * @param month       'YYYY-MM'
 * @param closingDay  회계 마감일(0=달력월)
 */
async function taxofficePack(db, month, closingDay = 0) {
  const { from, to } = monthRange(month, closingDay)

  // 1. 입출금 — 완료된 거래만. 세무사가 통장과 대조하는 자료라 계좌·적요까지 낸다.
  const [txns] = await db.execute(`
    SELECT t.date, t.kind, t.category, t.amount, t.supply_amount, t.vat_amount,
           t.memo, v.name AS vendor_name, a.name AS account_name
      FROM transactions t
      LEFT JOIN vendors  v ON v.id = t.vendor_id
      LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.date BETWEEN ? AND ?
       AND ((t.kind = 'income' AND t.status = ?) OR (t.kind = 'expense' AND t.status = ?))
     ORDER BY t.date, t.kind DESC`,
    [from, to, SETTLED_INCOME, SETTLED_EXPENSE])

  /* 2. 지출결의서 — **승인이 끝난 것만.** 작성 중인 결의서를 넘기면 세무사가 미확정 지출을
        장부에 올린다. 날짜는 지급일 기준(결의서를 언제 썼는지가 아니라 언제 나갔는지가 회계 사실). */
  const [resolutions] = await db.execute(`
    SELECT doc_no, pay_date, vendor_name, title, amount, pay_method, applicant, status
      FROM expense_resolutions
     WHERE status = '완료' AND pay_date BETWEEN ? AND ?
     ORDER BY pay_date, doc_no`, [from, to])

  // 3·4. 세금계산서 — 발행일 기준. 부가세 신고 자료라 공급가·세액을 나눠 낸다.
  const taxInvoices = async (kind) => {
    const [rows] = await db.execute(`
      SELECT i.issued_at, i.invoice_no, v.name AS vendor_name,
             i.supply_amount, i.vat_amount, i.total_amount, i.status
        FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id
       WHERE i.kind = ? AND i.issued_at BETWEEN ? AND ?
       ORDER BY i.issued_at, i.invoice_no`, [kind, from, to])
    return rows
  }
  const salesTax = await taxInvoices('issued')
  const purchaseTax = await taxInvoices('received')

  /* 5. 급여대장 — 월분(payroll.month)은 **달력월 문자열**이라 회계 기간과 축이 다르다.
        여기서만 달력월로 세는 게 맞다: 급여는 '7월분'이라는 이름으로 신고되지
        '6/26~7/25분'으로 신고되지 않는다. */
  const [payroll] = await db.execute(`
    SELECT e.name, e.role, e.department, p.month, p.base_salary, p.allowance, p.deduction, p.net_salary, p.status
      FROM payroll p LEFT JOIN employees e ON e.id = p.employee_id
     WHERE p.month = ?
     ORDER BY e.name`, [month])

  /* 6. 원천징수 대상 — 급여 중 공제가 있는 건. 원천징수이행상황신고서의 인원·금액 근거다.
        신고서 자체를 만들지는 않는다(서식·세율은 매년 바뀌어 우리가 책임질 자리가 아니다). */
  const withholding = payroll.filter(p => num(p.deduction) > 0)

  /* 7. 증빙 누락 — 완료된 지출 중 증빙이 없는 것. 세무사에게 넘기기 전에 채워야 할 목록이다.
        급여·이체처럼 원래 증빙이 없는 건은 뺀다 — 안 빼면 매달 수십 건이 '누락'으로 떠서
        정작 진짜 누락이 묻힌다. */
  const [noEvidence] = await db.execute(`
    SELECT t.date, t.category, t.amount, t.memo, v.name AS vendor_name
      FROM transactions t LEFT JOIN vendors v ON v.id = t.vendor_id
     WHERE t.kind = 'expense' AND t.status = ?
       AND t.date BETWEEN ? AND ?
       AND (t.evid_url IS NULL OR t.evid_url = '')
       AND (t.evid_type IS NULL OR t.evid_type = '')
       AND t.payroll_id IS NULL
       AND t.loan_id IS NULL AND t.savings_id IS NULL
     ORDER BY t.date`, [SETTLED_EXPENSE, from, to])

  const data = { txns, resolutions, salesTax, purchaseTax, payroll, withholding, noEvidence }

  return {
    month, from, to,
    sections: SECTIONS.map(s => ({
      key: s.key, label: s.label, unit: s.unit,
      count: data[s.key].length,
      // warn 항목(증빙 누락)은 **있으면** 문제, 나머지는 required 인데 0건이면 확인이 필요하다
      ready: s.warn ? data[s.key].length === 0 : (!s.required || data[s.key].length > 0),
    })),
    data,
  }
}

/** 엑셀 시트로 낼 때의 머리글·행 변환. 화면 표와 같은 열을 쓴다(보이는 것과 받는 것이 같아야 한다). */
const SHEETS = {
  txns: {
    head: ['일자', '구분', '거래처', '계정', '공급가액', '부가세', '금액', '계좌', '적요'],
    row: (r) => [r.date, r.kind === 'income' ? '입금' : '출금', r.vendor_name || '', r.category || '',
      r.supply_amount == null ? '' : num(r.supply_amount), r.vat_amount == null ? '' : num(r.vat_amount),
      num(r.amount), r.account_name || '', r.memo || ''],
  },
  resolutions: {
    head: ['문서번호', '지급일', '거래처', '건명', '금액', '지급방법', '기안자'],
    row: (r) => [r.doc_no, r.pay_date || '', r.vendor_name || '', r.title || '', num(r.amount),
      r.pay_method || '', r.applicant || ''],
  },
  salesTax: {
    head: ['발행일', '청구번호', '거래처', '공급가액', '세액', '합계', '상태'],
    row: (r) => [r.issued_at, r.invoice_no || '', r.vendor_name || '',
      num(r.supply_amount), num(r.vat_amount), num(r.total_amount), r.status || ''],
  },
  purchaseTax: {
    head: ['수취일', '청구번호', '거래처', '공급가액', '세액', '합계', '상태'],
    row: (r) => [r.issued_at, r.invoice_no || '', r.vendor_name || '',
      num(r.supply_amount), num(r.vat_amount), num(r.total_amount), r.status || ''],
  },
  payroll: {
    head: ['성명', '직위', '부서', '월분', '기본급', '수당', '공제', '실지급', '상태'],
    row: (r) => [r.name || '', r.role || '', r.department || '', r.month, num(r.base_salary),
      num(r.allowance), num(r.deduction), num(r.net_salary), r.status || ''],
  },
  withholding: {
    head: ['성명', '월분', '지급총액', '공제액', '실지급'],
    row: (r) => [r.name || '', r.month, num(r.base_salary) + num(r.allowance), num(r.deduction), num(r.net_salary)],
  },
  noEvidence: {
    head: ['일자', '거래처', '계정', '금액', '적요'],
    row: (r) => [r.date, r.vendor_name || '', r.category || '', num(r.amount), r.memo || ''],
  },
}

module.exports = { taxofficePack, SECTIONS, SHEETS }
