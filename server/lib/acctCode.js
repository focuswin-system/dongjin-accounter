/**
 * 계좌 → 계정과목 코드.
 *
 * 일계표는 거래를 복식으로 전개해 만든다.
 *   입금: 차변 = 계좌 계정과목 / 대변 = 거래 계정과목
 *   지출: 차변 = 거래 계정과목 / 대변 = 계좌 계정과목
 * 계좌 쪽이 비면 **한쪽 다리가 없어 차변·대변 합계가 안 맞는다.**
 * (실제로 계좌 등록 라우트가 이 값을 안 넣어서 새 계좌의 거래가 전부 짝을 잃었다)
 *
 * 그래서 계좌를 만들거나 종류를 바꿀 때 반드시 이 함수를 거친다.
 * db.js 의 1회 마이그레이션(기존 계좌 백필)도 같은 규칙을 SQL CASE 로 쓴다 — 바꿀 땐 둘 다.
 */

/** 자금 계좌의 표준 계정과목 (server/data/account-subjects.json) */
const CODES = {
  현금:     '1101',
  당좌예금: '1102',
  보통예금: '1103',
}

/**
 * @param {string} type 계좌 종류 라벨(보통예금·당좌예금·현금·법인카드 …)
 * @returns {string} 계정과목 코드
 *
 * 카드는 실제로는 미지급금(2101)이지만, 이 앱은 카드 지출도 즉시 출금으로 다룬다
 * (카드 결제일·미결제 잔액 개념이 없다). 그래서 지금은 보통예금으로 둔다 —
 * 카드 결제 주기를 도입하면 2101로 바꾸고 결제일에 상계하는 흐름이 필요하다.
 */
const bankAcctCode = (type) => CODES[String(type || '').trim()] || CODES.보통예금

/**
 * 인건비성 지급의 계정과목 — 근로계약 소득구분(work_contracts.income_type) 기준.
 *
 * 급여·용역 지급 거래에 계정과목이 아예 안 붙어서, **일계표가 항상 안 맞았다.**
 * 급여는 매달 나가므로 이 화면은 사실상 늘 "차변과 대변이 맞지 않아요" 상태였다
 * (2026-08-03 검수에서 확인 — 지급 2건이 그대로 불일치 목록에 떴다).
 *
 * 소득구분을 나누는 이유는 표시가 아니라 회계다. 사업소득 용역비를 급여(5201)로 달면
 * 손익계산서의 급여가 부풀고 지급수수료는 비며, 원천징수 신고 구분과도 어긋난다.
 */
const LABOR_CODES = {
  근로: '5201',   // 급여
  일용: '5201',   // 잡급 계정이 따로 없다 → 급여로 (일용도 근로소득)
  사업: '5219',   // 지급수수료
  기타: '5219',   // 기타소득도 지급수수료로 본다
}

/** @param {string} incomeType 근로|일용|사업|기타 (없으면 근로로 본다 — 정규 급여대장) */
const laborAcctCode = (incomeType) => LABOR_CODES[String(incomeType || '').trim()] || LABOR_CODES.근로

/**
 * 인건비성 지급의 비목(거래 category).
 *
 * work-contracts(용역 지급 등록)와 payroll(회차 지급)이 각자 정하고 있었다.
 * 두 벌이면 같은 사람의 같은 계약인데 **어느 화면에서 지급했느냐에 따라 비목이 달라진다** —
 * 비목별 집계가 조용히 쪼개진다. 규칙을 여기 한 곳에 둔다.
 */
const LABOR_CATEGORIES = {
  근로: '급여',
  일용: '일용노무비',
  사업: '용역비',
  기타: '기타소득 지급',
}

const laborCategory = (incomeType) =>
  LABOR_CATEGORIES[String(incomeType || '').trim()] || LABOR_CATEGORIES.근로

/**
 * 청구서 정산 거래의 상대 계정.
 *
 * 매출·매입은 **청구서를 발행한 시점**에 이미 인식된다. 그때 생긴 채권·채무가
 * 입금·지급으로 사라지는 것이므로, 정산 거래의 상대 계정은 매출/매입이 아니라
 * 외상매출금·외상매입금이다.
 *   수금:   차변 보통예금   / 대변 외상매출금
 *   대금지급: 차변 외상매입금 / 대변 보통예금
 *
 * 이 값을 안 넣으면 일계표에서 한쪽 다리가 비어 차변·대변이 안 맞는다.
 * 자동 생성 거래(계약 기입금·정기청구/정기지출 기지급)는 사용자가 계정과목을 고를
 * 기회조차 없으므로 반드시 기본값을 채워야 한다.
 */
const SETTLE_CODES = { income: '1204', expense: '2101' }   // 외상매출금 / 외상매입금

/** @param {'income'|'expense'} kind */
const settleAcctCode = (kind) => SETTLE_CODES[kind] || null

module.exports = {
  CODES, bankAcctCode,
  LABOR_CODES, laborAcctCode, LABOR_CATEGORIES, laborCategory,
  SETTLE_CODES, settleAcctCode,
}
