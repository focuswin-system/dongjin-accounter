/* 정기 회차 소급 등록 — 매출(정기청구)·매입(정기지출) 공용.
 *
 * ── 왜 필요한가 ──
 * 정기 반복은 등록일(setup_date) 이전 회차를 만들지 않는다(lib/recurrence.js).
 * 그 제약은 옳다 — 없앴다가 "2003년 시작 무기한 계약"이 청구서 수백 건으로 쏟아진 적이 있다.
 * 하지만 그 탓에 **도입 시점에 과거를 넣을 방법이 없다.** 회사는 보통 몇 달~몇 년 운영하다
 * 이 앱을 쓰기 시작하는데, 매달 나가던 임차료·호스팅비는 이미 수십 회차가 지나 있다.
 *
 * ── 어떻게 푸는가 ──
 * 하한을 없애지 않는다. 대신 **사용자가 기간을 명시적으로 열어** 그 범위만 만든다.
 * 날짜 계산은 새로 짜지 않고 dueDatesToGenerate 를 그대로 쓴다 —
 * setup_date 자리에 '소급 시작일'을, today 자리에 '소급 종료일'을 넣으면
 * 같은 규칙(주기·앵커일·월말 clamp·종료일)으로 그 구간 회차가 나온다.
 * 계산이 두 벌이 되면 소급분과 평소 회차가 어긋나므로 반드시 한 벌을 쓴다.
 */
const { dueDatesToGenerate } = require('./recurrence')

/* 한 번에 만들 수 있는 상한. 옛 사고(수백 건 쏟아짐)의 재발 방지선이다.
   넘으면 만들다 마는 게 아니라 **거절하고** 범위를 좁히게 한다 —
   조용히 잘라내면 사용자는 전부 만들어진 줄 안다. */
const MAX_BACKFILL = 60

/**
 * 소급 대상 회차 날짜 목록.
 * @param rec  정기 규칙(start_date·period·day_of_month·end_date)
 * @param from 소급 시작일(YYYY-MM-DD) — 사용자가 연 범위
 * @param to   소급 종료일(보통 오늘) — 미래는 대상이 아니다(기존 '발행 예정'이 담당)
 */
function backfillCycles(rec, from, to) {
  return dueDatesToGenerate(
    // setup_date 를 from 으로 갈아끼워 하한을 그 날짜로 옮긴다.
    // last_generated 는 비운다 — '이미 만들었나'는 아래에서 실제 장부를 보고 판단한다
    // (하한만 믿으면 중간에 지운 회차를 영영 못 되살린다).
    { ...rec, setup_date: from, last_generated: null },
    to,
  )
}

/** 상한 초과 여부 — 넘으면 이유가 담긴 문자열, 아니면 null */
function tooManyError(n) {
  if (n <= MAX_BACKFILL) return null
  return `한 번에 만들 수 있는 회차는 ${MAX_BACKFILL}개까지예요. ${n}개가 나왔으니 기간을 좁혀서 나눠 등록해주세요.`
}

module.exports = { backfillCycles, tooManyError, MAX_BACKFILL }
