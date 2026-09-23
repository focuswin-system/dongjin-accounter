/**
 * 비목(계정) 축으로 셀 때 쓰는 조각들 — **복합 거래를 항목으로 펼친다.**
 *
 * 왜 필요한가 —
 *   한 거래를 여러 비목으로 가른 복합 전표는 항목이 `txn_splits` 에 있고,
 *   부모 거래(`transactions`)에는 비목이 **하나만** 남는다. 전표 입력 화면이
 *   첫 줄 비목을 대표로 적기 때문이다(screens/VoucherEntry.jsx).
 *   그래서 비목으로 묶어 세면 외주비 100 + 재료비 50 + 운반비 10 을 한 전표로 적은 거래가
 *   **외주비 160 원**으로 잡혔다. 재료비·운반비는 0 이 된다.
 *
 *   합계와 부가세는 맞는다 — `saveSplits` 가 공급가·세액을 부모에 굴려 올린다.
 *   틀리는 것은 **비목 분포뿐**이라 총액을 맞춰 보는 검산으로는 안 걸린다.
 *   그래서 규칙을 여기 한 곳에 두고 집계하는 쪽이 전부 이걸 쓴다.
 *
 * 어떻게 —
 *   LEFT JOIN 이라 복합이 아닌 거래는 **그대로 한 줄**이고(붙을 항목이 없다),
 *   복합 거래만 항목 수만큼 펼쳐진다. 항목 합계 = 거래 금액은 저장 시점에 보장된다
 *   (`splitError` 가 다르면 저장을 막는다) — 그래서 펼쳐도 합이 안 틀어진다.
 *
 * ⚠ 이 JOIN 은 **비목 축에만** 붙인다.
 *   거래처·주문·월 축에 붙이면 복합 거래가 항목 수만큼 중복되어 그 축의 합계가 부풀어 오른다.
 *   그래서 건수도 `COUNT(*)` 가 아니라 `splitTxnCount()` 를 쓴다 — 한 거래는 한 건이다.
 */

/** 비목 축 집계에 붙이는 JOIN. 복합 거래만 항목으로 펼친다. */
const splitJoin = (t = 't', s = 's') =>
  `LEFT JOIN txn_splits ${s} ON ${s}.txn_id = ${t}.id AND ${t}.has_splits = 1`

/** 그 줄의 비목 — 항목이 있으면 항목 것, 없으면 거래 것 */
const splitCategory = (t = 't', s = 's') => `COALESCE(${s}.category, ${t}.category)`

/** 그 줄의 계정과목 코드 */
const splitAccountCode = (t = 't', s = 's') => `COALESCE(${s}.account_code, ${t}.account_code)`

/** 그 줄의 금액(총액) */
const splitAmount = (t = 't', s = 's') => `COALESCE(${s}.amount, ${t}.amount)`

/** 그 줄의 공급가액 — 없던 시절 거래는 총액으로 폴백한다(**집계** 쪽 기존 규칙과 같다) */
const splitSupply = (t = 't', s = 's') =>
  `COALESCE(${s}.supply_amount, ${s}.amount, ${t}.supply_amount, ${t}.amount)`

/** 그 줄의 공급가액 — **모르면 NULL 그대로.**
 *  세무사 전달 자료처럼 빈 칸이 뜻을 갖는 자리에 쓴다. 총액으로 채우면
 *  '세액 0원인 거래'로 읽혀, 받는 쪽이 부가세를 빼먹은 채로 장부에 올린다. */
const splitSupplyRaw = (t = 't', s = 's') => `COALESCE(${s}.supply_amount, ${t}.supply_amount)`

/** 그 줄의 부가세 */
const splitVat = (t = 't', s = 's') => `COALESCE(${s}.vat_amount, ${t}.vat_amount)`

/** 건수 — 펼쳐진 줄이 아니라 **거래**를 센다 */
const splitTxnCount = (t = 't') => `COUNT(DISTINCT ${t}.id)`

/**
 * 비목으로 **거르는** 조건. JOIN 없이 쓴다(EXISTS 라 줄이 안 늘어난다).
 * 값을 두 번 넣어야 한다 — `params.push(v, v)`.
 */
const splitCategoryFilter = (t = 't') =>
  `(${t}.category = ? OR (${t}.has_splits = 1 AND EXISTS (` +
  `SELECT 1 FROM txn_splits x WHERE x.txn_id = ${t}.id AND x.category = ?)))`

module.exports = {
  splitJoin, splitCategory, splitAccountCode, splitAmount,
  splitSupply, splitSupplyRaw, splitVat, splitTxnCount, splitCategoryFilter,
}
