/* 계약 모델 — 서버 단일 규칙. 라우트가 이걸 통해서만 계약 필드를 해석한다.
 *
 * 두 축:
 *   billing_mode  onetime   총액을 마일스톤으로 나눠 청구 (구축·납품)
 *                 recurring 주기마다 정액 청구 (유지보수·호스팅)
 *   term_mode     fixed      종료일에 만료 — 재계약해야 이어짐
 *                 auto_renew 해지 통보가 없으면 자동 연장
 *                 open       무기한 — 해지할 때까지 계속 (종료일 없음)
 *
 * 금액:
 *   onetime   → amount(계약 총액)를 사용자가 입력
 *   recurring → unit_amount(주기당 금액)를 입력하고, amount는 '이번 텀 총액'으로 여기서 산출
 *               (open은 끝이 없으므로 총액 개념이 없다 → amount = 0)
 */

const PERIOD_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 }

const periodMonths = (p) => PERIOD_MONTHS[p] || 1

/** start~end 사이에 billing_period가 몇 회차 들어가는지 (양끝 포함, 최소 1회) */
function billingCycles(start, end, period) {
  if (!start || !end) return 0
  const s = new Date(start), e = new Date(end)
  if (isNaN(s) || isNaN(e) || e < s) return 0
  const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth())
  // 종료일이 시작일과 같은 '일'에 못 미치면 그 달은 회차가 안 찬 것으로 본다
  const full = e.getDate() >= s.getDate() ? months + 1 : months
  return Math.max(1, Math.floor(full / periodMonths(period)))
}

/** 첫 계약기간인가 (갱신되면 current_term_start가 뒤로 밀린다) */
function isFirstTerm(c) {
  if (!c.current_term_start || !c.start_date) return true
  return c.current_term_start === c.start_date
}

/** 이번 텀(current_term_start ~ end_date)의 계약 총액.
 *  recurring = 초기 일시금(첫 기간에만) + 주기금액 × 회차수
 *  progress  = 총액 개념 없음(품목 단가×수량으로 그때그때 청구) → 0 */
function termTotal(c) {
  if (c.billing_mode === 'progress') return 0
  if (c.billing_mode !== 'recurring') return Number(c.amount) || 0
  // 초기 구축비는 계약 시작 때 한 번만 받는 돈 → 갱신된 기간에는 더하지 않는다
  const initial = isFirstTerm(c) ? (Number(c.initial_amount) || 0) : 0
  if (c.term_mode === 'open') return 0            // 끝이 없으면 '기간 총액'이 성립하지 않는다
  const unit = Number(c.unit_amount) || 0
  const start = c.current_term_start || c.start_date
  return initial + unit * billingCycles(start, c.end_date, c.billing_period)
}

/** 요청 body → 계약 컬럼값. 유형에 안 맞는 필드는 비워서 모순된 상태가 저장되지 않게 한다. */
function normalize(body) {
  // 청구 방식 3종: onetime(총액) / recurring(주기 정액) / progress(품목 단가×수량 기성)
  const billing = ['recurring', 'progress'].includes(body.billing_mode) ? body.billing_mode : 'onetime'
  const term = ['fixed', 'auto_renew', 'open'].includes(body.term_mode) ? body.term_mode : 'fixed'
  const isOpen = term === 'open'

  const out = {
    billing_mode: billing,
    term_mode: term,
    // 부가세: 면세(exempt)면 청구서 발행 시 부가세 0, 아니면 과세(taxable, 공급가×10%)
    vat_mode: body.vat_mode === 'exempt' ? 'exempt' : 'taxable',
    // 무기한 계약은 종료일이 없다
    end_date: isOpen ? null : (body.end_date || null),
    // 만료가 있는 계약만 갱신 통보 기한·텀 길이가 의미 있음
    notice_days: isOpen ? null : (Number(body.notice_days) >= 0 ? Number(body.notice_days) : 60),
    term_months: isOpen ? null : (Number(body.term_months) > 0 ? Number(body.term_months) : 12),
    unit_amount: null,
    billing_period: null,
    billing_day: null,
    initial_amount: null,
    amount: 0,
  }

  if (billing === 'recurring') {
    out.unit_amount = Number(String(body.unit_amount ?? '').replace(/[^0-9]/g, '')) || 0
    out.billing_period = PERIOD_MONTHS[body.billing_period] ? body.billing_period : 'monthly'
    out.billing_day = Number(body.billing_day) >= 1 && Number(body.billing_day) <= 31 ? Number(body.billing_day) : 1
    out.initial_amount = Number(String(body.initial_amount ?? '').replace(/[^0-9]/g, '')) || 0
    out.amount = termTotal({ ...out, current_term_start: body.current_term_start, start_date: body.start_date })
  } else if (billing === 'onetime') {
    out.amount = Number(String(body.amount ?? '').replace(/[^0-9]/g, '')) || 0
  }
  // progress는 총액이 없다 → out.amount = 0(기본값 유지), 정기 필드도 전부 null(기본값 유지)
  return out
}

/** 종료일 + term_months = 다음 종료일 (말일 보정) */
function nextEndDate(endDate, months) {
  if (!endDate) return null
  const d = new Date(endDate)
  if (isNaN(d)) return null
  const day = d.getDate()
  d.setMonth(d.getMonth() + (Number(months) > 0 ? Number(months) : 12))
  if (d.getDate() !== day) d.setDate(0)   // 1/31 + 1개월이 3/2로 넘어가는 것을 2/28로
  return d.toISOString().slice(0, 10)
}

/** 날짜 문자열 +1일 (다음 텀 시작일) */
function dayAfter(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d)) return null
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

module.exports = { normalize, termTotal, billingCycles, periodMonths, nextEndDate, dayAfter }
