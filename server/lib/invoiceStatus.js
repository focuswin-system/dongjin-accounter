/* 청구서 상태 재계산 — 정산(매칭) 누계가 곧 상태다.
 *
 * 같은 3분기 판정이 네 곳에 복사돼 있었다(거래 수정·거래 삭제·정산 추가·정산 취소).
 * 그중 **청구서 금액 수정 경로에는 아예 없었다** — 금액을 바꿔도 status가 그대로 남아
 * 완납된 청구서를 증액하면 '입금 완료'로 남아 미수금 화면·대시보드 양쪽에서 사라졌다.
 * 상태를 정하는 규칙은 여기 하나만 둔다.
 *
 * db는 필수 인자다 — 기본값(전역 풀)을 두면 조용히 남의 회사 DB를 건드린다.
 */

/**
 * 청구서 status(와 연결 마일스톤)를 정산 누계로 다시 정한다.
 * @returns {{ total:number, paid:number, remain:number, status:string }|null} 청구서가 없으면 null
 */
async function recalcInvoiceStatus(db, invoiceId) {
  if (!db) throw new Error('recalcInvoiceStatus: 테넌트 연결(db)이 필요합니다')
  if (!invoiceId) return null
  const [[inv]] = await db.execute('SELECT kind, total_amount FROM invoices WHERE id = ?', [invoiceId])
  if (!inv) return null
  const [[{ paid }]] = await db.execute(
    'SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [invoiceId])
  const isIssued = inv.kind === 'issued'
  const total = Number(inv.total_amount)
  const paidNum = Number(paid)
  const status = paidNum <= 0 ? (isIssued ? '입금 예정' : '지급 대기')
    : paidNum >= total ? (isIssued ? '입금 완료' : '지급 완료')
    : (isIssued ? '일부 입금' : '일부 지급')
  await db.execute('UPDATE invoices SET status = ? WHERE id = ?', [status, invoiceId])
  await db.execute('UPDATE milestones SET status = ? WHERE invoice_id = ?', [status, invoiceId])
  return { total, paid: paidNum, remain: total - paidNum, status }
}

/** 이미 정산된 금액 — 청구서 금액을 이 아래로 내리면 잔여가 음수가 된다 */
async function paidAmountOf(db, invoiceId) {
  if (!db) throw new Error('paidAmountOf: 테넌트 연결(db)이 필요합니다')
  const [[{ paid }]] = await db.execute(
    'SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_matches WHERE invoice_id = ?', [invoiceId])
  return Number(paid)
}

/* ── 미수금·미지급금으로 볼 상태 ──
 * 두 화면이 서로 다른 기준을 쓰고 있었다:
 *   invoices.js   화이트리스트 4종
 *   dashboard.js  `status NOT IN ('입금 완료')` — 블랙리스트
 * 그래서 status가 엉뚱한 값으로 들어간 청구서가 한쪽에만 잡혀 두 화면의 미수금이 달랐다.
 * 기준은 여기 하나. 화이트리스트를 쓴다 — 새 상태값이 생겼을 때 조용히 포함되는 쪽이 아니라
 * 명시적으로 넣어야 하는 쪽이 안전하다.
 */
const RECEIVABLE_STATUSES = ['입금 예정', '일부 입금', '기한 지남', '장기 미수']
const PAYABLE_STATUSES    = ['지급 대기', '지급 예정', '일부 지급', '기한 지남']

/** SQL IN 절 조각 + 파라미터 — `WHERE kind='issued' AND ${pendingCond('issued').sql}`
 *
 * alias 를 주면 `i.status IN (...)` 처럼 테이블을 붙인다. 주문(contracts)처럼 status 컬럼을
 * 가진 테이블과 조인하면 붙이지 않은 status 는 "ambiguous" 로 질의가 통째로 실패한다. */
const pendingCond = (kind, alias = '') => {
  const list = kind === 'issued' ? RECEIVABLE_STATUSES : PAYABLE_STATUSES
  const col = alias ? `${alias}.status` : 'status'
  return { sql: `${col} IN (${list.map(() => '?').join(',')})`, params: [...list] }
}

module.exports = {
  recalcInvoiceStatus, paidAmountOf,
  RECEIVABLE_STATUSES, PAYABLE_STATUSES, pendingCond,
}
