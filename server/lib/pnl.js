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

/**
 * **집계 범위** — "이 거래를 매출·매입으로 세는가".
 *
 * pnlOnly() 만으로는 부족하다. 계정과목이 자산·부채라고 다 재무거래가 아니기 때문이다.
 *
 *   청구서 정산  차 보통예금 / 대 **외상매출금(1204)**  ← 자산이라 pnlOnly 에서 탈락
 *   어음 만기결제 차 **지급어음(2102)** / 대 보통예금   ← 부채라 탈락
 *   대출 실행    차 보통예금 / 대 차입금(2201)          ← 진짜 재무거래
 *
 * 앞의 둘은 **매출·매입이 이미 일어난 뒤의 결제**다. 발행·수취 시점에 손익으로 잡혔으니
 * 정산을 또 손익으로 세면 두 번 잡히는 게 맞다 — 다만 그건 **전표·일계표**의 이야기다.
 * 매출 분석·월별 현황처럼 **transactions 만 읽는 집계**에서는 발행 전표를 안 보므로,
 * 정산 거래를 빼면 그 매출이 어디에도 안 나타난다.
 *
 * ── 왜 함수로 묶는가 ──
 * 같은 사고가 세 번 반복됐다.
 *   1) 청구서 정산 입금이 월별 현황에서 빠짐 — "2억이 들어왔는데 총 입금 0원"
 *      → 화면(Docs.jsx)에서 `isPnl !== false || invoiceId` 로 고쳤다
 *   2) 그 규칙이 여기 안 올라와서, 경영 도우미 매출(routes/analytics.js)은 그대로 남았다
 *   3) 어음이 들어오며 같은 경로가 하나 더 생겼다
 * 판정이 프런트에만 살아 있는 한 네 번째가 온다. 규칙은 여기 한 곳에 둔다.
 *
 * @param alias 거래 테이블 별칭
 */
function countableOnly(alias = 'transactions') {
  const inv  = `${alias}.invoice_id`
  const note = `EXISTS (SELECT 1 FROM notes n WHERE n.txn_id = ${alias}.id OR n.origin_txn_id = ${alias}.id)`
  return `(${pnlOnly(alias)} OR (${inv} IS NOT NULL AND ${inv} <> '') OR ${note})`
}

/** countableOnly()가 요구하는 바인딩 파라미터 (pnlOnly 와 같다) */
const countableParams = () => [...NON_PNL_TYPES]

/** 반대 — 재무·자산 활동만(재무 현황 집계에서 쓴다) */
function financeOnly(alias = 'transactions') {
  const col = `${alias}.account_code`
  return `(${col} IS NOT NULL AND ${col} <> '' AND ${col} IN (
    SELECT code FROM account_subjects
    WHERE code IS NOT NULL AND acct_type IN (${NON_PNL_TYPES.map(() => '?').join(',')})))`
}

module.exports = { NON_PNL_TYPES, pnlOnly, pnlParams, countableOnly, countableParams, financeOnly }
