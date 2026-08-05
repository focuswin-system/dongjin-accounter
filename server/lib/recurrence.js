// 정기 반복일 계산 — 정기청구(recurring_invoices)·정기지출(recurring_expenses) 공용.
// 과거엔 두 라우트가 각자 구현해 (1) 지출은 period를 무시해 분기/연이 매달 생성됐고,
// (2) 청구는 월말일(≥29) 앵커에서 오버플로가 누적돼 회차가 밀리고 누락됐다. 여기로 단일화한다.

// 로컬 캘린더 기준 yyyy-mm-dd (toISOString의 UTC 변환을 쓰지 않는다 — KST 경계 오차 방지)
function fmtDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 해당 연·월(0-indexed month)의 말일
function daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate()
}

// yyyy-mm-dd 문자열에 days를 더한 yyyy-mm-dd (로컬 캘린더 기준)
function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return fmtDate(new Date(y, m - 1, d + days))
}

// '발행 예정' 목록에 다가오는 회차를 며칠 앞까지 미리 보여줄지(대금청구서 미리 작성용).
// 월 최대 간격(31일)보다 커서, 월간 정기청구는 다음 회차가 항상 한 번 미리 보인다.
const LOOKAHEAD_DAYS = 35

// start_date 앵커에서 period 간격으로 밟아 '아직 생성 안 된' 회차 날짜 목록(오름차순).
// - period: 'monthly'(기본) | 'quarterly' | 'yearly'
// - day_of_month: 앵커 일자. 그 달 말일보다 크면 말일로 clamp(31일 앵커 → 2월 28/29, 4월 30).
// - last_generated: 이 값(포함) 이하 회차는 이미 생성됨.
// - setup_date: 정기청구를 등록한 날(created_at의 날짜). 이 날 이전 회차는 소급하지 않는다
//   (2003년 시작 무기한 계약이 수백 건으로 쏟아지던 문제 방지 — 설정 시점부터만 청구).
// - end_date: 있으면 초과 회차 중단.
// - opts.horizonDays: 오늘 이후 며칠까지의 미래 회차도 포함(미리보기용). 기본 0(오늘까지만).
// today: 'YYYY-MM-DD' 문자열(권장 — 호출부에서 kstToday()로 KST 기준 전달) 또는 Date.
//        문자열/ds/setup_date를 모두 같은 달력일 기준으로 비교해 타임존 혼용을 막는다.
// 각 회차를 원 앵커의 '절대 월'(i*step)로 재계산하므로 오버플로 드리프트가 없다.
function dueDatesToGenerate(rec, today = new Date(), opts = {}) {
  /* 앵커(회차를 세는 기준일) = 시작일, 없으면 **등록일**.
   *
   * 무기한 정기 계약은 "언제부터"가 모호한 경우가 흔하다(구두로 이어오던 유지보수 같은 것).
   * 예전엔 start_date 가 비면 그냥 [] 를 돌려줬다 — 규칙은 만들어져 있고 활성이고 종료도
   * 안 됐는데 회차가 **영원히 0건**이었다. 아무 경고도 없어서 그 달 매출이 조용히 빠졌다.
   *
   * 시작일을 모를 때 가장 방어 가능한 답은 '이 시스템에 등록한 날부터'다. setup_date 는
   * 이미 소급 하한(아래 setupFloor)으로 쓰고 있어, 앵커로 써도 규칙이 어긋나지 않는다
   * (첫 회차가 등록일이 되고, 그 이전으로는 어차피 소급되지 않는다).
   * 둘 다 없으면 셀 기준이 없으므로 그때는 [] 가 맞다. */
  const anchor = rec.start_date || rec.setup_date
  if (!anchor) return []
  const step = rec.period === 'yearly' ? 12 : rec.period === 'quarterly' ? 3 : 1
  const [sy, sm] = String(anchor).split('-').map(Number) // sm: 1-indexed
  if (!sy || !sm) return []
  const anchorDay = Number(rec.day_of_month) || Number(String(anchor).split('-')[2]) || 1
  const todayStr = typeof today === 'string' ? today : fmtDate(today)
  const horizonDays = Number(opts.horizonDays) || 0
  const horizonStr = horizonDays > 0 ? addDays(todayStr, horizonDays) : todayStr
  /* 이미 생성된 회차 판정은 **달 단위**로 한다.
   *
   * 예전엔 날짜 그대로 비교했다(`ds > last_generated`). 그러면 청구일을 바꾸는 순간
   * 그 달 회차가 다시 열린다 — 매월 1일 규칙으로 2026-07-01 을 발행한 뒤(last_generated=07-01)
   * 거래처 요청으로 청구일을 25일로 바꾸면 07-25 > 07-01 이라 **7월이 '놓친 회차'로 되살아나고
   * 발행하면 7월분 청구서가 두 장** 나간다(미수금 2배). 반대로 25→1일로 바꾸면 그 달이
   * 통째로 건너뛰어진다.
   *
   * 정기청구는 '주기당 한 번'이 규칙이므로, 같은 달(분기·연 주기도 회차가 놓인 달)에 이미
   * 발행했으면 앵커일이 어디로 옮겨가든 그 회차는 끝난 것이다. */
  const genFloorMonth = String(rec.last_generated || '').slice(0, 7)   // 'YYYY-MM'
  const setupFloor = rec.setup_date || ''   // 등록일 이전 회차는 소급 금지(비면 제약 없음)
  const out = []
  for (let i = 0; i < 1200; i++) { // 안전 상한(월간이면 100년치)
    const abs = (sm - 1) + i * step // 절대 월(0-indexed)
    const y = sy + Math.floor(abs / 12)
    const m = ((abs % 12) + 12) % 12
    const day = Math.min(anchorDay, daysInMonth(y, m)) // 월말 clamp
    const ds = fmtDate(new Date(y, m, day))
    if (ds > horizonStr) break
    if (rec.end_date && ds > rec.end_date) break
    if (ds < anchor) continue
    if (setupFloor && ds < setupFloor) continue // 설정 시점 이전 회차 건너뜀
    if (!genFloorMonth || ds.slice(0, 7) > genFloorMonth) out.push(ds)
  }
  return out
}

// '오늘·임박'으로 볼 범위(일). 화면의 구획과 서버 판정이 어긋나지 않게 여기 한 곳에서 정한다.
const SOON_DAYS = 7

/**
 * 회차 상태 — 화면 세 구획(놓침 / 오늘·임박 / 예정)의 근거.
 *   overdue  예정일이 지났는데 아직 청구서가 없다 → 실제로 돈이 나갔을 수 있다(가장 급함)
 *   soon     오늘~SOON_DAYS 안
 *   upcoming 그 뒤(미리보기)
 * 화면에서 따로 계산하면 서버 규칙과 어긋난다 — pending이 이 값을 실어 보낸다.
 */
function cycleState(due, today) {
  if (due < today) return 'overdue'
  return due <= addDays(today, SOON_DAYS) ? 'soon' : 'upcoming'
}

/**
 * 회차 1건의 공통 응답 필드 — 정기청구(매출)·정기지출(매입) pending이 같은 모양을 내게 한다.
 * 두 라우트가 각자 객체를 만들던 탓에 한쪽에만 필드가 빠지기 쉬웠다(contract_id가 그랬다).
 * 금액·세액처럼 성격이 다른 값만 extra로 받는다.
 */
function pendingCycle(r, due, today, extra = {}) {
  return {
    recurring_id: r.id,
    due_date: due,
    state: cycleState(due, today),
    vendor_id: r.vendor_id || null,
    vendor_name: r.vendor_name || '',
    // 계약 기반인지 일반 정기인지 — 화면에서 관리 경로를 나누는 기준
    contract_id: r.contract_id || null,
    contract_name: r.contract_name || '',
    contract_no: r.contract_no || '',
    period: r.period,
    ...extra,
  }
}

/**
 * 생성물(청구서·거래)을 지웠을 때 그 회차가 다시 생성될 수 있도록 last_generated 를 되돌린다.
 *
 * last_generated 는 '이 값 이하 회차는 이미 생성됨'을 뜻하는 하한선이다(위 genFloor).
 * 생성 코드는 이 값을 전진시키기만 해서, 만든 청구서를 지워도 하한선이 그대로 남았다.
 * 그러면 그 회차는 '발행 예정'에도 자동 생성에도 영영 나오지 않는다 —
 * 그 달 매출이 아무 경고 없이 미청구로 사라진다.
 *
 * 되돌리는 방법: 지워진 회차 날짜의 '하루 전'으로 낮춘다.
 * 그 회차만 다시 열리고(ds > genFloor), 그보다 앞선 회차는 여전히 하한 아래라 재생성되지 않는다.
 *
 * 단, 지워진 것이 '마지막으로 생성된 회차'일 때만 되돌린다. 중간 회차를 지웠는데 하한을
 * 낮추면 이미 만들어둔 뒤 회차까지 다시 생성돼 중복 청구서가 생긴다.
 *
 * @returns {{restored: boolean, note: string|null}} restored=false 면 그 회차는 수동으로 만들어야 한다.
 */
async function restoreLastGenerated(db, table, recurringId, removedDate) {
  if (!db) throw new Error('restoreLastGenerated: 테넌트 연결(db)이 필요합니다')
  if (!recurringId || !removedDate) return { restored: false, note: null }
  if (table !== 'recurring_invoices' && table !== 'recurring_expenses') {
    throw new Error(`restoreLastGenerated: 알 수 없는 테이블 ${table}`)
  }
  const [[rec]] = await db.execute(`SELECT last_generated FROM ${table} WHERE id = ?`, [recurringId])
  if (!rec) return { restored: false, note: null }
  const removed = String(removedDate).slice(0, 10)
  if (String(rec.last_generated || '').slice(0, 10) !== removed) {
    // 마지막 회차가 아니다 — 하한을 낮추면 뒤 회차가 중복 생성된다.
    return { restored: false, note: '이 회차는 자동으로 다시 만들어지지 않아요. 필요하면 직접 발행해주세요.' }
  }
  await db.execute(`UPDATE ${table} SET last_generated = ? WHERE id = ?`, [addDays(removed, -1), recurringId])
  return { restored: true, note: '이 회차는 다시 발행 예정에 나타나요.' }
}

module.exports = {
  dueDatesToGenerate, fmtDate, daysInMonth, addDays, LOOKAHEAD_DAYS, restoreLastGenerated,
  SOON_DAYS, cycleState, pendingCycle,
}
