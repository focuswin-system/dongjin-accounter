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

/* 반복 주기 — **화면 쪽의 유일한 정의.**
 * ⚠ value 는 서버 server/lib/period.js 및 DB ENUM 과 **글자까지 같아야** 한다.
 * 격월(2개월마다)이 있는 이유: 격월 정기점검·유지보수가 실제로 흔한데, 매월로 넣으면
 * 회차가 두 배로 돌고 분기로 넣으면 한 달씩 밀린다. */
export const BILLING_PERIODS = [
  { value: 'monthly',   label: '월',   long: '매월',   months: 1 },
  { value: 'bimonthly', label: '격월', long: '격월',   months: 2 },
  { value: 'quarterly', label: '분기', long: '매분기', months: 3 },
  { value: 'yearly',    label: '년',   long: '매년',   months: 12 },
];

/* 긴 이름('매월·격월·매분기·매년') — 규칙 목록·명령팔레트처럼 문장 안에 들어가는 자리.
   이 표가 없던 시절에는 화면마다 `p === 'yearly' ? '매년' : ...` 삼항식을 따로 썼고,
   그래서 주기를 하나 더하면 **손 안 댄 곳만 조용히 '매월'로 떨어졌다.** */
export const periodLong = (p) => BILLING_PERIODS.find(x => x.value === p)?.long || '매월';

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

/* ── 회차가 '몇 월 며칠'인지 ────────────────────────────────────────
 *
 * 주기(월·분기·년)와 일자(day_of_month/billing_day)만 화면에 있으면
 * **분기·년이 몇 월인지 알 수 없다.** 실제 규칙은 서버(lib/recurrence.js)에 있다:
 *   달  = 시작일이 속한 달에서 3개월(분기)·12개월(년)씩
 *   일  = day_of_month (그 달 말일보다 크면 말일로 clamp)
 * 즉 **월은 시작일이 정한다.** 화면이 그걸 말해주지 않아 "분기는 몇 월인가"가 물음으로 남았다.
 */

/** 일자 인풋 라벨. '매월 N일'을 주기와 무관하게 쓰면 격월·분기·년에서 거짓말이 된다. */
const DAY_LABEL = {
  monthly: '매월 N일', bimonthly: '두 달마다 N일', quarterly: '분기마다 N일', yearly: '매년 N일',
};
export const cycleDayLabel = (period) => DAY_LABEL[period] || DAY_LABEL.monthly;

/**
 * 회차가 놓이는 달만 짧게. 예) '2·5·8·11월 25일'
 *
 * 라벨 괄호 안에 넣으려고 뗀 것이다. 예전엔 일자 칸 라벨이 `생성 일 (매월 N일)` 이고
 * 그 **아래에 또** `매월 25일` 이 연한 글씨로 붙어 있었다 — 괄호는 **틀**만 말하고
 * 아래 줄이 **실제 답**이라, 같은 말이 두 번 있는 데다 줄 높이까지 어긋났다.
 * 실제 답을 괄호로 올리고 아래 줄은 없앤다.
 *
 * ⚠ '시작일을 비우면 등록일 기준' 안내는 여기서 뺀다 — 바로 아래 FirstCycleHint 가
 *   "비워두면 오늘(등록일)부터 시작해요" 로 이미 말한다. 두 곳에서 말하면 또 중복이다.
 */
export const cycleMonthsLabel = (startDate, day, period, today) => {
  const d = Math.min(Math.max(Number(day) || 1, 1), 31);
  const sm = Number(String(startDate || today || '').split('-')[1]);
  if (!sm) return cycleDayLabel(period);          // 날짜를 못 읽으면 틀이라도 보여준다
  if (period === 'yearly') return `매년 ${sm}월 ${d}일`;
  const step = periodMonths(period);
  if (step > 1) {
    const ms = Array.from({ length: 12 / step }, (_, i) => ((sm - 1 + i * step) % 12) + 1)
      .sort((a, b) => a - b);
    return `${ms.join('·')}월 ${d}일`;
  }
  return `매월 ${d}일`;
};

/**
 * 회차가 놓이는 달을 사람 말로. 예) '2·5·8·11월 25일'
 * startDate 가 없으면 등록일(오늘)이 앵커가 되므로 그렇게 알려준다.
 * (주문 화면에서 쓴다 — 정기 규칙 폼은 위 cycleMonthsLabel 을 라벨 괄호에 쓴다)
 */
export const cycleMonthsHint = (startDate, day, period, today) => {
  const d = Math.min(Math.max(Number(day) || 1, 1), 31);
  const src = String(startDate || today || '');
  const sm = Number(src.split('-')[1]);
  if (!sm) return null;
  const base = startDate ? '' : '시작일을 비우면 등록일 기준 — ';
  if (period === 'yearly') return `${base}매년 ${sm}월 ${d}일`;
  /* 격월·분기는 **몇 월인지가 화면 어디에도 없다** — 월은 시작일이 정하기 때문이다.
     그 달들을 그대로 적어 준다. 격월이면 6개(1·3·5·7·9·11월), 분기면 4개. */
  const step = periodMonths(period);
  if (step > 1) {
    const ms = Array.from({ length: 12 / step }, (_, i) => ((sm - 1 + i * step) % 12) + 1)
      .sort((a, b) => a - b);
    return `${base}${ms.join('·')}월 ${d}일`;
  }
  return `${base}매월 ${d}일`;
};

/* ── 결제조건 ───────────────────────────────────────────────────
 * 회차일(세금계산서를 끊는 날)과 **돈이 오가는 날**은 다르다.
 * 국내 B2B 에서 제일 흔한 조건은 '30일 후'가 아니라 **익월 지정일**이다
 * ("이번 달 것은 다음 달 10일에 넣어드립니다"). net30 으로 뭉뚱그리면
 * 자금 현황의 예정일이 며칠씩 어긋난다 — 8/5 회차를 익월 10일로 받는 거래처면
 * 실제는 9/10 인데 net30 은 9/4 로 잡는다.
 * ⚠ 값(value)은 서버 lib/recurrence.js PAY_TERMS 와 **글자까지 같아야** 한다.
 */
export const PAY_TERM_OPTS = [
  { value: 'immediate', label: '당일' },
  { value: 'net30',     label: '30일 후' },
  { value: 'dom',       label: '당월 N일', needsDay: true },
  { value: 'eom',       label: '당월 말일' },
  { value: 'nm_day',    label: '익월 N일', needsDay: true },
  { value: 'nm_eom',    label: '익월 말일' },
];
export const payTermNeedsDay = (t) => !!PAY_TERM_OPTS.find(o => o.value === t)?.needsDay;

/** 고른 조건을 한 문장으로. verb: '빠져요'(지출) | '들어와요'(청구) */
export const payTermHint = (term, day, verb) => {
  const d = Math.min(Math.max(Number(day) || 1, 1), 31);
  switch (term) {
    case 'immediate': return `회차일 당일에 ${verb}.`;
    case 'dom':       return `회차가 있는 달 ${d}일에 ${verb}. (그 달에 없는 날짜면 말일)`;
    case 'eom':       return `회차가 있는 달 말일에 ${verb}.`;
    case 'nm_day':    return `회차 다음 달 ${d}일에 ${verb}. 국내 B2B에서 가장 흔한 조건이에요.`;
    case 'nm_eom':    return `회차 다음 달 말일에 ${verb}.`;
    default:          return `회차일부터 30일 뒤에 ${verb}.`;
  }
};
