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
 * 잠긴 기간이면 사용자에게 보여줄 오류 문구, 아니면 null.
 * dates에 여러 날짜를 주면(옮기기 전/후) 하나라도 잠겨 있으면 막는다.
 */
async function closedPeriodError(db, ...dates) {
  for (const d of dates) {
    if (!d) continue
    if (await isPeriodClosed(db, d)) {
      return `${monthOf(d)}은 마감된 기간이에요. 수정하려면 먼저 환경설정에서 마감을 해제하세요.`
    }
  }
  return null
}

module.exports = { isPeriodClosed, closedPeriodError, monthOf }
