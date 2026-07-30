/* 손익 거래 판정 — 재무관리(차입금·투자)가 들어오면서 필요해진 단일 규칙.
 *
 * ── 문제 ──
 * 대출을 받으면 계좌 잔액은 늘지만 **수익이 아니다**. 투자받은 돈도, 원금 상환도 손익이 아니다.
 * 그런데 거래에는 income/expense 두 종류뿐이라, 대출 수령을 income으로 넣으면
 * 매출 분석(routes/analytics.js)에 그대로 매출로 잡힌다 — 화면은 멀쩡하고 숫자만 틀린다.
 *
 * ── 규칙 ──
 * 손익 여부는 kind가 아니라 **계정과목의 대분류(account_subjects.acct_type)** 가 정한다.
 *   수익·비용  → 손익      (매출, 외주비, 이자비용 …)
 *   자산·부채·자본 → 재무·자산 활동 (차입금 원금, 자본금, 투자자산 …)
 *
 * 계정과목이 비어 있는 거래는 **종전대로 손익으로 본다**. 과거 데이터 대부분이 그렇고,
 * 그것들을 갑자기 손익에서 빼면 이미 맞던 과거 숫자가 바뀐다.
 *
 * ── 건드리지 않는 것 ──
 * **계좌 잔액 집계**(routes/accounts.js·dashboard.js)에는 적용하지 않는다.
 * 대출금도 실제로 계좌에 들어온 돈이므로 잔액에는 반영되는 게 맞다.
 */

/** 손익이 아닌 계정 대분류 */
const NON_PNL_TYPES = ['자산', '부채', '자본']

/**
 * 손익 거래만 남기는 SQL 조건.
 * 기존 집계 쿼리의 WHERE에 AND로 덧붙여 쓴다 — JOIN을 추가하지 않아도 되게 서브쿼리로 만든다.
 *
 * @param alias 거래 테이블 별칭(없으면 'transactions')
 * @example  WHERE t.kind = ? AND ${pnlOnly('t')}
 */
function pnlOnly(alias = 'transactions') {
  const col = `${alias}.account_code`
  return `(${col} IS NULL OR ${col} = '' OR ${col} NOT IN (
    SELECT code FROM account_subjects
    WHERE code IS NOT NULL AND acct_type IN (${NON_PNL_TYPES.map(() => '?').join(',')})))`
}

/** pnlOnly()가 요구하는 바인딩 파라미터 */
const pnlParams = () => [...NON_PNL_TYPES]

/** 반대 — 재무·자산 활동만(재무 현황 집계에서 쓴다) */
function financeOnly(alias = 'transactions') {
  const col = `${alias}.account_code`
  return `(${col} IS NOT NULL AND ${col} <> '' AND ${col} IN (
    SELECT code FROM account_subjects
    WHERE code IS NOT NULL AND acct_type IN (${NON_PNL_TYPES.map(() => '?').join(',')})))`
}

module.exports = { NON_PNL_TYPES, pnlOnly, pnlParams, financeOnly }
