/* 계약 모델 — 화면 공용 규칙 (서버의 server/contract-model.js와 같은 정의).
 *
 * 계약은 서로 독립적인 두 축을 가진다.
 *   청구 방식 billing_mode : onetime(총액을 나눠 청구) / recurring(주기마다 정액)
 *   종료 방식 term_mode    : fixed(만료 — 재계약 필요) / auto_renew(말 없으면 자동 연장) / open(무기한)
 *
 * 금액도 축에 따라 의미가 다르다.
 *   onetime   → amount = 계약 총액 (사용자 입력)
 *   recurring → unit_amount = 주기당 금액 (사용자 입력), amount = 이번 텀 총액 (서버 산출)
 *               open이면 끝이 없으므로 총액 자체가 없다.
 */

export const BILLING_MODES = [
  { value: 'onetime',   label: '총액형', hint: '계약 총액을 마일스톤으로 나눠 청구 (구축·납품)' },
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
/** 총액·진행률·남은 계약분 개념이 성립하는 계약인가.
 *  무기한 정기계약과 기성형(총액 없이 품목 기성)은 성립하지 않는다. */
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

/** 이 계약에 '갱신'이라는 개념이 있는가.
 *  자동갱신 — 당연히 있다.
 *  정기형 + 기간 만료 — 1년 유지보수처럼, 이어가려면 재계약해야 한다.
 *  총액형 + 기간 만료 — 구축·납품 프로젝트. 끝나면 그냥 끝이지 갱신할 게 없다. */
export const isRenewable = (c) => !!c && !isOpenEnded(c) &&
  (c.term_mode === 'auto_renew' || isRecurring(c));

/** 계약 한 건의 갱신 상태.
 *  managed=false → 갱신 관리 대상 아님 (무기한·완료·보류·종료일 없음·단발 계약)
 *  stage 'ended' → 갱신 개념이 없는 단발 계약의 기간이 끝남. 갱신이 아니라 '상태 정리' 대상. */
export const renewalInfo = (c) => {
  const none = { managed: false, stage: 'none', days: null, badge: null, tone: 'outline' };
  if (!c || isOpenEnded(c)) return none;
  if (c.status === '완료' || c.status === '보류') return none;
  const days = daysUntil(c.end_date);
  if (days === null) return none;

  // 단발 구축 계약은 갱신 대상이 아니다. 다만 종료일이 지났는데 '진행중'이면 상태 정리가 필요하다.
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

/** 정기청구가 계약과 어긋났는지 — 금액·주기·종료일 대조 */
export const recurringMismatch = (c, rec) => {
  if (!c || !rec || !isRecurring(c)) return [];
  const out = [];
  if (Number(rec.supply_amount) !== Number(c.unit_amount || 0)) {
    out.push(`청구금액 ${Number(rec.supply_amount).toLocaleString()}원 ≠ 계약 ${Number(c.unit_amount || 0).toLocaleString()}원`);
  }
  if (rec.period !== c.billing_period) {
    out.push(`청구주기 ${periodLabel(rec.period)} ≠ 계약 ${periodLabel(c.billing_period)}`);
  }
  if (!isOpenEnded(c) && c.end_date && rec.end_date !== c.end_date) {
    out.push(`종료일 ${rec.end_date || '없음'} ≠ 계약 ${c.end_date}`);
  }
  return out;
};
