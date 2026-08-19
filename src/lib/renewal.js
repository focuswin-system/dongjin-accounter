/* 주문 모델 — 화면 공용 규칙 (서버의 server/contract-model.js와 같은 정의).
 *
 * 주문은 서로 독립적인 두 축을 가진다.
 *   청구 방식 billing_mode : onetime(총액을 나눠 청구) / recurring(주기마다 정액)
 *   종료 방식 term_mode    : fixed(만료 — 재계약 필요) / auto_renew(말 없으면 자동 연장) / open(무기한)
 *
 * 금액도 축에 따라 의미가 다르다.
 *   onetime   → amount = 주문 총액 (사용자 입력)
 *   recurring → unit_amount = 주기당 금액 (사용자 입력), amount = 이번 텀 총액 (서버 산출)
 *               open이면 끝이 없으므로 총액 자체가 없다.
 */

export const BILLING_MODES = [
  { value: 'onetime',   label: '총액형', hint: '주문 총액을 마일스톤으로 나눠 청구 (구축·납품)' },
  { value: 'recurring', label: '정기형', hint: '주기마다 같은 금액을 청구 (유지보수·호스팅)' },
  { value: 'progress',  label: '기성형', hint: '품목 단가×수량으로 그때그때 기성 청구 (소사장·정밀가공)' },
];

export const TERM_MODES = [
  { value: 'fixed',      label: '기간 만료',  hint: '종료일에 끝. 이어가려면 재계약해야 함' },
  { value: 'auto_renew', label: '자동갱신',   hint: '해지 통보가 없으면 종료일에 자동 연장' },
  { value: 'open',       label: '무기한',     hint: '종료일 없이 해지할 때까지 계속' },
];

export const BILLING_PERIODS = [
  { value: 'monthly',   label: '월', months: 1 },
  { value: 'quarterly', label: '분기', months: 3 },
  { value: 'yearly',    label: '년', months: 12 },
];

export const billingLabel = (c) => BILLING_MODES.find(x => x.value === c?.billing_mode)?.label || '총액형';
export const termLabel    = (c) => TERM_MODES.find(x => x.value === c?.term_mode)?.label || '기간 만료';
export const periodLabel  = (p) => BILLING_PERIODS.find(x => x.value === p)?.label || '월';
export const periodMonths = (p) => BILLING_PERIODS.find(x => x.value === p)?.months || 1;

/** 정기형인가 / 기성형인가 / 무기한인가 — 화면 분기용 */
export const isRecurring = (c) => c?.billing_mode === 'recurring';
export const isProgress  = (c) => c?.billing_mode === 'progress';
export const isOpenEnded = (c) => c?.term_mode === 'open';
/** 총액·진행률·남은 주문분 개념이 성립하는 주문인가.
 *  무기한 정기주문과 기성형(총액 없이 품목 기성)은 성립하지 않는다. */
export const hasTotal = (c) => !(isRecurring(c) && isOpenEnded(c)) && !isProgress(c);

/** "초기 500만원 + 월 100만원" 같은 한 줄 요약 */
export const amountLabel = (c, fmt) => {
  if (isProgress(c)) return '품목 단가 기성';
  if (!isRecurring(c)) return `${fmt(c.amount || 0)}원`;
  const monthly = `${periodLabel(c.billing_period)} ${fmt(c.unit_amount || 0)}원`;
  return c.initial_amount > 0 ? `초기 ${fmt(c.initial_amount)}원 + ${monthly}` : monthly;
};

const daysUntil = (dateStr) => {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  if (isNaN(d)) return null;
  return Math.round((d - today) / 86400000);
};

/** 이 주문에 '갱신'이라는 개념이 있는가.
 *  자동갱신 — 당연히 있다.
 *  정기형 + 기간 만료 — 1년 유지보수처럼, 이어가려면 재계약해야 한다.
 *  총액형 + 기간 만료 — 구축·납품 프로젝트. 끝나면 그냥 끝이지 갱신할 게 없다. */
export const isRenewable = (c) => !!c && !isOpenEnded(c) &&
  (c.term_mode === 'auto_renew' || isRecurring(c));

/** 주문 한 건의 갱신 상태.
 *  managed=false → 갱신 관리 대상 아님 (무기한·완료·보류·종료일 없음·단발 주문)
 *  stage 'ended' → 갱신 개념이 없는 단발 주문의 기간이 끝남. 갱신이 아니라 '상태 정리' 대상. */
export const renewalInfo = (c) => {
  const none = { managed: false, stage: 'none', days: null, badge: null, tone: 'outline' };
  if (!c || isOpenEnded(c)) return none;
  if (c.status === '완료' || c.status === '보류') return none;
  const days = daysUntil(c.end_date);
  if (days === null) return none;

  // 단발 구축 주문은 갱신 대상이 아니다. 다만 종료일이 지났는데 '진행중'이면 상태 정리가 필요하다.
  if (!isRenewable(c)) {
    return days < 0
      ? { managed: false, stage: 'ended', days, badge: '기간 종료', tone: 'outline' }
      : none;
  }

  const notice = Number(c.notice_days) >= 0 ? Number(c.notice_days) : 60;
  const auto = c.term_mode === 'auto_renew';

  if (days < 0) {
    // 종료일이 지났는데 갱신도 종료 처리도 안 됨. 자동갱신이면 실제로는 연장됐는데 입력이 밀린 상태.
    return { managed: true, stage: 'expired', days, badge: auto ? '연장 미입력' : '갱신 누락', tone: 'neg' };
  }
  if (days <= notice) {
    return { managed: true, stage: 'due', days,
      badge: `${auto ? '자동갱신' : '재계약'} D-${days}`, tone: days <= 14 ? 'neg' : 'warn' };
  }
  return { managed: true, stage: 'ok', days, badge: `D-${days}`, tone: 'outline' };
};

/** 갱신 시 기본으로 채울 새 종료일 = 기존 종료일 + term_months (말일 보정) */
export const nextEndDate = (c) => {
  if (!c?.end_date) return '';
  const months = Number(c.term_months) > 0 ? Number(c.term_months) : 12;
  const d = new Date(c.end_date);
  if (isNaN(d)) return '';
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() !== day) d.setDate(0);
  return d.toISOString().slice(0, 10);
};

/** 정기청구가 주문과 어긋났는지 — 금액·주기·종료일 대조 */
export const recurringMismatch = (c, rec) => {
  if (!c || !rec || !isRecurring(c)) return [];
  const out = [];
  // supply_amount가 없으면 Number(undefined)=NaN이라 항상 불일치로 잡히고 'NaN원'이 노출된다 → 0으로 방어
  const recSupply = Number(rec.supply_amount) || 0;
  if (recSupply !== Number(c.unit_amount || 0)) {
    out.push(`청구금액 ${recSupply.toLocaleString()}원 ≠ 주문 ${Number(c.unit_amount || 0).toLocaleString()}원`);
  }
  if (rec.period !== c.billing_period) {
    out.push(`청구주기 ${periodLabel(rec.period)} ≠ 주문 ${periodLabel(c.billing_period)}`);
  }
  if (!isOpenEnded(c) && c.end_date && rec.end_date !== c.end_date) {
    out.push(`종료일 ${rec.end_date || '없음'} ≠ 주문 ${c.end_date}`);
  }
  /* 시작일·청구일도 봐야 한다 — 이 둘이 빠져 있어서 "주문은 7/1인데 규칙은 8/5" 같은 어긋남이
     경고조차 안 떴다. 방향에 따라 양쪽으로 틀린다:
       시작일을 앞당겼는데 규칙이 그대로 → 그 사이 회차가 안 잡힌다(덜 청구)
       시작일을 미뤘는데 규칙이 그대로   → 아직 시작도 안 한 주문에 회차가 뜬다(더 청구)
     ⚠ 시작일을 과거로 고쳐도 **등록일 하한(setup_date)은 그대로**라 소급은 열리지 않는다.
        과거 회차는 소급 등록 마법사로만 만든다. 여기서 맞추는 건 데이터 정합성이다. */
  const cStart = c.start_date || '';
  const rStart = rec.start_date || '';
  if (cStart && rStart !== cStart) {
    out.push(`시작일 ${rStart || '없음'} ≠ 주문 ${cStart}`);
  }
  const cDay = Number(c.billing_day) || 1;
  const rDay = Number(rec.day_of_month) || 1;
  if (rDay !== cDay) {
    out.push(`청구일 매월 ${rDay}일 ≠ 주문 ${cDay}일`);
  }
  return out;
};
