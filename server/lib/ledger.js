/**
 * 장부 불변식 — 거래(transactions)가 계좌 잔액에 제대로 잡히기 위한 조건을 한 곳에 정의한다.
 *
 * ── 왜 필요한가 ──
 * 계좌 잔액은 routes/accounts.js 의 calcBalance 가 이렇게 계산한다:
 *
 *     income  : account_id = <계좌>
 *     expense : account_id = <계좌>  AND  status = '지급완료'
 *
 * 즉 거래가 잔액에 반영되려면 (1) account_id 가 있어야 하고, (2) 지출이면 상태가
 * 무공백 표준형('지급완료')이어야 한다. 이 조건은 accounts.js 한 곳에 있는데,
 * 거래를 만드는 코드는 11곳에 흩어져 있다. 각자 `account_id || null` 로 넘기고
 * 상태를 직접 문자열로 적다 보니, 한 곳만 어긋나도 **에러 없이** 장부가 틀어졌다.
 *
 * 2026-07-22 검토에서 확인된 실제 사례(전부 같은 뿌리):
 *   · 결의서 '지출 새로 등록'      → account_id NULL (프런트에 계좌 UI 자체가 없었음)
 *   · 급여 지급                    → 계좌가 '선택' 항목이라 미선택 시 NULL
 *   · 청구서 정산(신규 거래)       → 정기청구발 청구서는 계좌가 비어 그대로 NULL
 *   · 엑셀 일괄 등록               → INSERT 컬럼 목록에 account_id 자체가 없었음
 *   · 청구서에 기존 거래 연결      → status 를 '지급 대기' 그대로 둠
 *   · 과거 F-02(급여·용역)         → status 공백
 *
 * 통장은 줄었는데 화면 잔액은 그대로 — 사용자가 알아챌 방법이 없는 종류의 오류다.
 * 그래서 "리뷰를 더 잘 하자"가 아니라 **규칙을 코드로 강제**한다.
 */

// 잔액 계산이 인정하는 완료 상태(무공백 표준형). accounts.js calcBalance 와 짝을 이룬다.
const SETTLED_EXPENSE = '지급완료'
const SETTLED_INCOME  = '입금완료'

/**
 * 상태 문자열 정규화.
 * 화면·엑셀·과거 데이터가 '지급 완료'(공백)를 섞어 쓴다. 공백형은 잔액 집계에서
 * 조용히 누락되므로 저장 전에 표준형으로 바꾼다.
 */
function normalizeStatus(status) {
  const s = String(status == null ? '' : status).trim()
  if (s.replace(/\s/g, '') === SETTLED_EXPENSE) return SETTLED_EXPENSE
  if (s.replace(/\s/g, '') === SETTLED_INCOME)  return SETTLED_INCOME
  return s
}

/** 이 상태가 '실제로 돈이 오갔음'을 뜻하는가 */
function isSettled(status) {
  const s = normalizeStatus(status)
  return s === SETTLED_EXPENSE || s === SETTLED_INCOME
}

/**
 * 이 거래가 계좌 잔액에 제대로 반영되는지 검사한다.
 * 문제가 있으면 **사용자에게 그대로 보여줄 수 있는 한국어 메시지**를, 없으면 null 을 반환한다.
 * (throw 하지 않는다 — 라우트가 400/409 중 무엇으로 응답할지 스스로 정하게 둔다)
 *
 * @param {{kind:string, account_id:any, status:any}} txn
 */
function ledgerError({ kind, account_id, status, method }) {
  const settled = isSettled(status)
  // 아직 오가지 않은 돈('지급 대기' 등)은 계좌가 없어도 된다 — 잔액에 잡히지 않는 게 맞다.
  if (!settled) return null
  /* ⚠ **현금은 계좌 없이도 통과한다.**
   *
   * 금고 시재를 관리하는 회사는 종류 '현금'인 계정(1101)을 만들어 거기서 빼면 되고,
   * 안 세는 회사(대표 지갑에서 그냥 나가는 소액)는 계정을 안 만든다. 후자에 계좌를
   * 요구하면 **현금 지출을 아예 등록할 수 없다** — 실제로 그 상태였고, 실무자가
   * 결제수단만 '현금'으로 바꾼 채 직전에 고른 카드가 남아 저장되는 사고로 이어졌다
   * (운영에서 현금 3건이 법인카드에 달려 있었다).
   *
   * 계좌가 없으면 잔액은 안 움직이고 비용만 잡힌다. 회계적으로는 헐렁하지만,
   * **틀린 계좌에 다는 것보다 낫다.** */
  if (method === '현금') return null
  if (!account_id) {
    return kind === 'income'
      ? '입금 계좌를 선택해주세요. 계좌를 지정해야 잔액에 반영됩니다.'
      : '출금 계좌를 선택해주세요. 계좌를 지정해야 잔액에 반영됩니다.'
  }
  return null
}

/** 거래 종류별 기본 완료 상태 — 수입에 '지급완료'가 박히면 상태 배지가 틀리고
 *  '입금완료'만 세는 집계(거래내역 입금 합계)에서 빠진다. */
const defaultSettledStatus = (kind) => (kind === 'income' ? SETTLED_INCOME : SETTLED_EXPENSE)

/* 금액 상한 — BIGINT 한계가 아니라 '사람이 실수로 넣은 값'을 걸러내는 선.
 * 1조원은 이 제품(영세·중소기업 회계)의 어떤 정상 거래보다 크다. */
const MAX_AMOUNT = 1_000_000_000_000

/**
 * 거래 금액 검증. 문제가 있으면 사용자에게 보여줄 한국어 메시지, 없으면 null.
 *
 * 서버에 부호 검증이 전혀 없어서 음수 금액이 그대로 저장됐다.
 * −330만 지출을 넣으면 계좌 잔액이 **늘고**, 부가세 매입세액이 −30만이 되어 공제세액이 줄었다.
 * 화면·엑셀 마법사는 숫자만 남기지만(`[^0-9]`), 프런트만 믿는 구조가 과거 사고(F-02)의 뿌리였다.
 */
function amountError(amount, { allowZero = false } = {}) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '금액을 숫자로 입력해주세요'
  if (n < 0) return '금액은 0보다 작을 수 없어요. 반대 방향 거래로 등록하거나 환불·환입을 쓰세요.'
  if (!allowZero && n === 0) return '금액을 입력해주세요'
  if (n > MAX_AMOUNT) return `금액이 너무 큽니다(${MAX_AMOUNT.toLocaleString('ko-KR')}원 초과). 자릿수를 확인해주세요.`
  return null
}

module.exports = {
  SETTLED_EXPENSE, SETTLED_INCOME, normalizeStatus, isSettled, ledgerError,
  defaultSettledStatus, amountError, MAX_AMOUNT,
}
