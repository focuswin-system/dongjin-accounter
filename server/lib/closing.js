/* 월 마감(기간 잠금).
 *
 * 부가세 신고나 월 마감을 끝낸 뒤 그 기간의 거래가 바뀌면, 이미 제출한 자료와 장부가 조용히 어긋난다.
 * 잠근 달(YYYY-MM)에 속하는 거래는 등록·수정·삭제를 막는다.
 *
 * 검사는 '날짜가 잠긴 달에 속하는가'만 본다 — 옮기는 경우(잠긴 달 → 열린 달, 또는 그 반대)는
 * 양쪽 날짜를 모두 검사해야 한다. 한쪽만 보면 잠긴 달에서 거래를 빼내거나 밀어넣을 수 있다.
 */

const monthOf = (date) => String(date || '').slice(0, 7)

/** 잠긴 달인지 (db는 필수 인자 — 기본값을 두면 다른 회사 DB를 건드린다) */
async function isPeriodClosed(db, date) {
  const m = monthOf(date)
  if (!/^\d{4}-\d{2}$/.test(m)) return false
  const [[row]] = await db.execute('SELECT id FROM closed_periods WHERE period = ?', [m])
  return !!row
}

/**
 * **청구서 문서**의 잠금 — 월 마감만 본다(장부 시작일 전이어도 막지 않는다).
 * 잠긴 기간이면 사용자에게 보여줄 오류 문구, 아니면 null.
 * dates에 여러 날짜를 주면(옮기기 전/후) 하나라도 잠겨 있으면 막는다.
 */
async function closedDocError(db, ...dates) {
  for (const d of dates) {
    if (!d) continue
    if (await isPeriodClosed(db, d)) {
      return `${monthOf(d)}은 마감된 기간이에요. 수정하려면 먼저 환경설정에서 마감을 해제하세요.`
    }
  }
  return null
}

/**
 * **돈이 오가는 기록**의 잠금 — 월 마감 + 장부 시작일 전(4단계).
 *
 * ⚠ 기본값을 이쪽으로 뒀다(fail-closed). 거래를 만드는 경로가 열두 파일에 흩어져 있어, 장부 시작일 검사를
 *   경로마다 붙이면 새 경로가 생길 때마다 빠진다(실제로 정산·일괄 정산·이체가 빠졌다 — 코드 검토).
 *   그래서 이 함수가 시작일까지 보고, **청구서 문서**만 closedDocError(월 마감만)를 쓴다 — 시작 전달 세금계산서는
 *   이번 분기 부가세라 들어와야 한다.
 * 장부 시작일 전은 **마감된 달처럼 잠긴다** — 새로 넣는 것도, 이미 있던 것을 고치거나 지우는 것도.
 */
async function closedPeriodError(db, ...dates) {
  return (await closedDocError(db, ...dates)) || (await beforeBooksError(db, ...dates))
}

/**
 * 장부 시작일 전인가(4단계, 2026-09) — 그 전의 돈은 **계좌 기초잔액·이월 잔액 안에 이미 들어 있다.**
 * 그 날짜로 거래를 넣으면 같은 돈이 두 번 잡힌다(기초잔액 한 번 + 거래 한 번).
 *
 * ⚠ **돈이 오간 거래에만** 쓴다. 청구서는 막지 않는다 — 9/1 에 시작한 회사가 8월 세금계산서를 가져와야
 *   3분기 부가세가 맞는다. 청구서는 정산하기 전까지 통장을 안 건드리므로 두 번 잡힐 일이 없다.
 * 시작일이 비어 있으면(대부분의 기존 회사) 막는 것이 없다.
 */
async function beforeBooksError(db, ...dates) {
  let start = null
  try {
    const [[co]] = await db.execute('SELECT books_start FROM company_info WHERE id = ?', ['main'])
    start = co?.books_start || null
  } catch (e) {
    // 칸이 아직 없는 DB(배포 직후 setup:db 전)에서 거래 등록 전부가 막히지 않게 — 그 경우에만 넘어간다
    if (e.code === 'ER_BAD_FIELD_ERROR') return null
    throw e
  }
  if (!start) return null
  for (const d of dates) {
    const day = String(d || '').slice(0, 10)
    if (day && day < start) {
      return `${day}은 장부 시작일(${start}) 전이에요. 그 전 돈은 계좌 기초잔액·이월 잔액에 들어 있어요.`
    }
  }
  return null
}

module.exports = { isPeriodClosed, closedPeriodError, closedDocError, beforeBooksError, monthOf }
