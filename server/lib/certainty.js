/**
 * 확실한 돈과 불확실한 돈 — "지금 쓸 수 있는 돈"을 정확히 말하기 위한 판정 한 곳.
 *
 * ── 왜 필요한가 ──
 * 지금은 **양쪽이 같은 방향으로 틀린다.**
 *   · 장기 미수가 RECEIVABLE_STATUSES 에 들어 있어 **들어올 게 확실한 돈**으로 세어진다
 *   · 기한 없는 미수금은 기준일로 끌어올려져 '오늘 들어올 돈'이 된다
 * 둘 다 잔고를 실제보다 크게 만든다. 그 숫자를 보고 지급 일정을 잡으면 통장이 빈다.
 *
 * ── 핵심 원칙: 안전한 방향이 서로 반대다 ──
 *   들어올 돈이 불확실 → 확실 흐름에서 **뺀다**(없는 셈)
 *   나갈 돈이 불확실   → 확실 흐름에 **넣는다**(있는 셈)
 *
 * 두 방향에 같은 규칙을 쓰면 한쪽은 반드시 틀린다. cashReport.js 의 place() 가 지금
 * 그 상태다 — 기한 미정을 양쪽 다 '기준일에 세운다'로 처리해서, 나갈 돈에는 맞고
 * 들어올 돈에는 낙관 쪽으로 틀린다.
 *
 * ── 감추지 않는다 ──
 * 불확실을 목록에서 빼 버리면 "그 돈은 어디 갔나"가 된다. 계산에서만 빼고 **금액과 건수는
 * 그 자리에 적는다**("확실히 들어올 돈 3,200만 · 불확실 1,850만").
 *
 * ⚠ 이 판정은 **자금 예측 전용**이다. 미수금 화면·KPI 는 종전대로 장기 미수를 포함해야 한다
 *   (lib/invoiceStatus.js RECEIVABLE_STATUSES 를 건드리면 미수금 총액이 조용히 줄어든다).
 */

/* '장기 미수' 상태 — **아무도 저장할 수 없는 값이었다.**
 *
 * 화면에는 필터 칩·빨간 배지·미수금 KPI(longOverdue)까지 있고 RECEIVABLE_STATUSES 에도
 * 들어 있는데, 서버 어디에서도 이 값을 쓰지 않는다. 청구서 수정은 status 를 정산 누계로
 * 덮어쓰기 때문이다(routes/invoices.js — "클라이언트가 보낸 값을 믿지 않는다").
 * 그래서 그 집계는 늘 0이었다.
 *
 * 판정을 저장된 상태에 기대면 이 규칙은 운영에서 한 번도 안 걸린다.
 * '기한 지남'을 화면에서 날짜로 도출하듯, **장기 미수도 나이로 도출한다**(아래 상수).
 * 값이 실제로 들어 있는 경우(옛 데이터·임포트)에는 그것도 존중한다. */
const UNCERTAIN_STATUS = '장기 미수'

/* 기한이 이만큼 지나면 '들어온다'고 셈하지 않는다.
 *
 * 90일 = 한 분기. 부가세 신고가 분기라 실무의 시간 단위가 그것이고, 한 분기가 통째로
 * 지나도록 안 들어온 돈은 "받을 수 있나" 소리가 나오는 시점이다. 대손세액공제 요건
 * (6개월)보다 보수적으로 잡았다 — 낙관 쪽으로 틀리지 않는 것이 이 판정의 목적이다.
 *
 * 회사마다 감이 다를 수 있다. 바꿀 곳은 여기 한 줄이다. */
const OVERDUE_UNCERTAIN_DAYS = 90

/* 급여가 이만큼 밀리면 '이번에 나간다'고 셈하지 않는다(그래도 나갈 돈에는 남는다).
 * 60일 = 2회차. 한 달 늦는 것은 자금 사정으로 흔하지만, 두 달이면 "언제 줄 수 있나"가 된다. */
const PAYROLL_UNCERTAIN_DAYS = 60

/** 두 날짜 사이 일수 — 'YYYY-MM-DD' 문자열만 받는다(KST 기준 문자열 비교와 같은 눈금) */
function daysBetween(from, to) {
  if (!from || !to) return 0
  const a = Date.parse(from + 'T00:00:00Z')
  const b = Date.parse(to + 'T00:00:00Z')
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86400000)
}

/**
 * 들어올 돈이 확실한가.
 * @returns {{certain: boolean, reason: string}} reason 은 화면에 그대로 적는 말
 */
function inflowCertainty({ status = '', due = '', today }) {
  if (status === UNCERTAIN_STATUS) return { certain: false, reason: '장기 미수' }
  // 날짜가 없으면 기댈 근거가 없다. '오늘 들어온다'고 세우면 그게 곧 낙관이다.
  if (!due) return { certain: false, reason: '기한 미정' }
  const late = daysBetween(due, today)
  if (late >= OVERDUE_UNCERTAIN_DAYS) {
    return { certain: false, reason: `${late}일 밀림` }
  }
  return { certain: true, reason: '' }
}

/**
 * 나갈 돈이 확실한가.
 *
 * ⚠ **불확실해도 흐름에서 빼지 않는다.** 언제 나갈지 모르는 돈은 '지금 있는 것'으로 보는
 *   편이 안전하다. 여기서 내는 판정은 화면에 "이 중 얼마는 기한이 없다"를 적기 위한 것이지,
 *   계산에서 덜어내기 위한 것이 아니다.
 */
function outflowCertainty({ due = '', today, kind = 'invoice' }) {
  if (!due) return { certain: false, reason: '기한 미정' }
  if (kind === 'payroll') {
    const late = daysBetween(due, today)
    if (late >= PAYROLL_UNCERTAIN_DAYS) return { certain: false, reason: `${late}일 밀림` }
  }
  return { certain: true, reason: '' }
}

module.exports = {
  inflowCertainty, outflowCertainty, daysBetween,
  UNCERTAIN_STATUS, OVERDUE_UNCERTAIN_DAYS, PAYROLL_UNCERTAIN_DAYS,
}
