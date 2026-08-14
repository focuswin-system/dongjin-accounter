/**
 * 감사 로그 대상 — '무엇을 남기는가'의 단일 지점.
 *
 * ── 왜 라우트마다 audit() 를 심지 않는가 ──
 * apiPerms.js 와 같은 이유다. 라우트별로 심으면 **빠뜨린 라우트가 곧 공백**이고,
 * 그 공백은 사고가 난 뒤에야 드러난다("그 거래 누가 지웠지?" → 기록 없음).
 * 여기 한 곳에 선언하고 middleware/auditTrail.js 가 강제한다.
 *
 * ── 무엇을 남기는가 ──
 * 되돌리기 어렵거나 돈이 움직이는 행위만. 기준정보 수정·조회까지 남기면 정작 중요한
 * 기록이 잡음에 묻힌다. 남기는 축은 네 가지다 — 마감 / 삭제 / 지급·입금 / 발행.
 *
 * ── 무엇을 남기지 않는가 (지시된 정책) ──
 * 금액·거래처명·계좌번호·품목·계약명은 어떤 경우에도 넣지 않는다. 구체적 수치는 회사 비밀이다.
 * 남기는 것은 **누가·언제·무엇을(action)·대상 ID·IP·성공 여부**뿐이고, 그 대상이 무엇이었는지
 * 알고 싶으면 그 회사의 화면에서 ID로 찾아본다. 로그 자체가 장부의 사본이 되면 안 된다.
 *
 * ── 규칙 모양 ──
 *   m      HTTP 메서드
 *   re     전체 경로(/api/...) 정규식. **먼저 맞는 것이 이긴다** — 좁은 규칙을 위에 둘 것.
 *   res    audit_logs.resource (도메인 이름, 소문자 단수)
 *   action audit_logs.action (동사)
 *   target 대상 ID를 어디서 얻는가
 *            숫자 n      → 정규식 n번 캡처 그룹 (경로의 :id)
 *            'created'  → 응답 본문의 id (POST 로 새로 만든 것)
 *            {body:'f'} → 요청 본문의 f 필드 (마감 월처럼 값 자체가 대상인 경우)
 *            없음       → null
 */

/** 되돌리기 어렵거나 돈이 움직이는 행위만. 위에서부터 먼저 맞는 것이 이긴다. */
const AUDIT_RULES = [
  // ── 마감 ── 장부를 잠그고 여는 행위. 마감 해제는 특히 남아야 한다(잠긴 기간을 다시 연다)
  { m: 'POST',   re: /^\/api\/closings$/,                          res: 'closing', action: 'close',  target: { body: 'period' } },
  { m: 'DELETE', re: /^\/api\/closings\/([^/]+)$/,                 res: 'closing', action: 'reopen', target: 1 },

  // ── 일괄 등록 ── 한 번에 수백 건이 들어온다. 무엇이 언제 들어왔는지 못 짚으면 되돌릴 수 없다
  { m: 'POST',   re: /^\/api\/transactions\/import\/commit$/,      res: 'transaction', action: 'import' },
  { m: 'POST',   re: /^\/api\/invoices\/import\/commit$/,          res: 'invoice',     action: 'import' },
  { m: 'POST',   re: /^\/api\/vendors\/import\/commit$/,           res: 'vendor',      action: 'import' },
  { m: 'POST',   re: /^\/api\/ref-items\/import\/commit$/,         res: 'ref_item',    action: 'import' },

  // ── 거래(장부) 삭제 ── 계좌 잔액이 함께 움직인다
  { m: 'DELETE', re: /^\/api\/transactions\/([^/]+)$/,             res: 'transaction', action: 'delete', target: 1 },

  // ── 청구서 ── 발행은 매출·매입의 시작점, 입금 매칭은 미수금을 지운다
  { m: 'POST',   re: /^\/api\/invoices$/,                          res: 'invoice', action: 'issue',        target: 'created' },
  { m: 'POST',   re: /^\/api\/invoices\/([^/]+)\/matches$/,        res: 'invoice', action: 'match',        target: 1 },
  { m: 'DELETE', re: /^\/api\/invoices\/([^/]+)\/matches\/[^/]+$/, res: 'invoice', action: 'match_cancel', target: 1 },
  { m: 'DELETE', re: /^\/api\/invoices\/([^/]+)$/,                 res: 'invoice', action: 'delete',       target: 1 },
  /* 일괄 처리 — 한 번에 최대 100건의 돈이 오가고, 삭제도 그만큼이다.
     건별 기록(match·delete)은 대상 ID로 남지만 "누가 언제 한꺼번에 했나"가 없으면
     "이 날 미지급금이 왜 통째로 사라졌지"를 짚을 수 없다. */
  { m: 'POST',   re: /^\/api\/invoices\/bulk\/settle$/,            res: 'invoice', action: 'bulk_settle' },
  { m: 'POST',   re: /^\/api\/invoices\/bulk\/delete$/,            res: 'invoice', action: 'bulk_delete' },

  // ── 계약 ── 기성·마일스톤 발행은 청구서를 만든다
  { m: 'POST',   re: /^\/api\/contracts\/([^/]+)\/progress-invoice$/,   res: 'invoice',  action: 'issue',  target: 1 },
  { m: 'POST',   re: /^\/api\/contracts\/schedule\/([^/]+)\/issue$/,    res: 'invoice',  action: 'issue',  target: 1 },
  { m: 'DELETE', re: /^\/api\/contracts\/([^/]+)$/,                     res: 'contract', action: 'delete', target: 1 },

  // ── 정기 발행 ── 놓친 회차 일괄 발행은 한 번에 여러 건을 만든다
  { m: 'POST',   re: /^\/api\/recurring-invoices\/issue-missed$/,       res: 'recurring_invoice', action: 'issue_missed' },
  { m: 'POST',   re: /^\/api\/recurring-invoices\/([^/]+)\/issue$/,     res: 'recurring_invoice', action: 'issue', target: 1 },
  { m: 'POST',   re: /^\/api\/recurring-expenses\/issue-missed$/,       res: 'recurring_expense', action: 'issue_missed' },
  { m: 'POST',   re: /^\/api\/recurring-expenses\/([^/]+)\/issue$/,     res: 'recurring_expense', action: 'issue', target: 1 },

  /* 정기 규칙 삭제 — 장부(청구서·거래)는 남지만 **앞으로의 청구·지출이 멈춘다.**
     "왜 이번 달에 안 청구됐지"를 나중에 짚으려면 누가 언제 지웠는지가 있어야 한다. */
  { m: 'DELETE', re: /^\/api\/recurring-invoices\/([^/]+)$/,            res: 'recurring_invoice', action: 'delete', target: 1 },
  { m: 'DELETE', re: /^\/api\/recurring-expenses\/([^/]+)$/,            res: 'recurring_expense', action: 'delete', target: 1 },

  /* ── 회차 건너뛰기 ── 그 달 청구가 사라지는 결정이다. "왜 3월만 없지"를 짚으려면 남아야 한다.
     되살리기(DELETE)도 마찬가지 — 있던 게 다시 생기는 것이라 양쪽 다 기록한다. */
  { m: 'POST',   re: /^\/api\/recurring-invoices\/([^/]+)\/skip$/,      res: 'recurring_invoice', action: 'skip',   target: 1 },
  { m: 'DELETE', re: /^\/api\/recurring-invoices\/([^/]+)\/skip\/[^/]+$/, res: 'recurring_invoice', action: 'unskip', target: 1 },
  { m: 'POST',   re: /^\/api\/recurring-expenses\/([^/]+)\/skip$/,      res: 'recurring_expense', action: 'skip',   target: 1 },
  { m: 'DELETE', re: /^\/api\/recurring-expenses\/([^/]+)\/skip\/[^/]+$/, res: 'recurring_expense', action: 'unskip', target: 1 },

  /* ── 소급 등록 ── 한 번에 최대 60건의 청구서·거래가 생기고, 되돌리기는 그만큼을 지운다.
   * 과거 기간에 꽂는 일이라 "이 달 숫자가 왜 달라졌지"가 나중에 반드시 나온다.
   * (미리보기는 아무것도 바꾸지 않으므로 기록하지 않는다) */
  { m: 'POST',   re: /^\/api\/recurring-invoices\/([^/]+)\/backfill$/,  res: 'recurring_invoice', action: 'backfill', target: 1 },
  { m: 'DELETE', re: /^\/api\/recurring-invoices\/backfill\/([^/]+)$/,  res: 'recurring_invoice', action: 'backfill_undo', target: 1 },
  { m: 'POST',   re: /^\/api\/recurring-expenses\/([^/]+)\/backfill$/,  res: 'recurring_expense', action: 'backfill', target: 1 },
  { m: 'DELETE', re: /^\/api\/recurring-expenses\/backfill\/([^/]+)$/,  res: 'recurring_expense', action: 'backfill_undo', target: 1 },

  // ── 급여·용역 지급 ── 계좌에서 돈이 나간다
  { m: 'POST',   re: /^\/api\/payroll\/generate$/,                      res: 'payroll', action: 'generate' },
  { m: 'POST',   re: /^\/api\/payroll\/([^/]+)\/pay$/,                  res: 'payroll', action: 'pay',          target: 1 },
  { m: 'DELETE', re: /^\/api\/payroll\/([^/]+)\/pay\/[^/]+$/,           res: 'payroll', action: 'pay_cancel',   target: 1 },
  { m: 'DELETE', re: /^\/api\/payroll\/month\/([^/]+)$/,                res: 'payroll', action: 'delete_month', target: 1 },
  { m: 'DELETE', re: /^\/api\/payroll\/([^/]+)$/,                       res: 'payroll', action: 'delete',       target: 1 },
  { m: 'POST',   re: /^\/api\/work-contracts\/([^/]+)\/pay$/,           res: 'work_contract', action: 'pay',    target: 1 },
  { m: 'DELETE', re: /^\/api\/work-contracts\/([^/]+)$/,                res: 'work_contract', action: 'delete', target: 1 },

  /* 계약 귀속 변경 — 금액은 그대로지만 그 돈이 **어느 계약의 실적·원가로 잡히는지**가 바뀐다.
     한 번에 여러 건을 옮길 수 있어서, 나중에 원가율이 이상해졌을 때 언제 무엇이 옮겨졌는지
     짚을 수 있어야 한다. */
  { m: 'POST',   re: /^\/api\/transactions\/link-contract$/,          res: 'transaction', action: 'link_contract' },

  // ── 지급결의 ── 처리하면 실제 지급 거래가 만들어진다
  { m: 'POST',   re: /^\/api\/resolutions\/([^/]+)\/process$/,          res: 'resolution', action: 'process', target: 1 },
  { m: 'DELETE', re: /^\/api\/resolutions\/([^/]+)$/,                   res: 'resolution', action: 'delete',  target: 1 },
  { m: 'DELETE', re: /^\/api\/settlements\/([^/]+)$/,                   res: 'settlement', action: 'delete',  target: 1 },

  // ── 재무(차입금·투자) ── 원금·이자가 계좌에서 나간다
  { m: 'POST',   re: /^\/api\/finance\/loans\/([^/]+)\/repay$/,         res: 'loan', action: 'repay',         target: 1 },
  { m: 'POST',   re: /^\/api\/finance\/loans\/([^/]+)\/repay-missed$/,  res: 'loan', action: 'repay_missed',  target: 1 },
  { m: 'DELETE', re: /^\/api\/finance\/loans\/([^/]+)\/repay\/[^/]+$/,  res: 'loan', action: 'repay_cancel',  target: 1 },
  { m: 'DELETE', re: /^\/api\/finance\/loans\/([^/]+)$/,                res: 'loan', action: 'delete',        target: 1 },
  { m: 'DELETE', re: /^\/api\/finance\/investments\/([^/]+)$/,          res: 'investment', action: 'delete',  target: 1 },

  // ── 적금 ── 납입·만기도 계좌를 움직인다
  { m: 'POST',   re: /^\/api\/savings\/([^/]+)\/pay-missed$/,           res: 'savings', action: 'pay_missed', target: 1 },
  { m: 'POST',   re: /^\/api\/savings\/([^/]+)\/pay$/,                  res: 'savings', action: 'pay',        target: 1 },
  { m: 'POST',   re: /^\/api\/savings\/([^/]+)\/mature$/,               res: 'savings', action: 'mature',     target: 1 },
  { m: 'DELETE', re: /^\/api\/savings\/([^/]+)$/,                       res: 'savings', action: 'delete',     target: 1 },

  /* ── 미지급 퇴직금 ── 여기 적힌 금액은 자금 예측이 '언젠가 나갈 돈'으로 세는 실제 자금이다
     (실물 기준 7,351만). 지우거나 금액을 고치면 그만큼 나갈 돈이 사라지는데 기록이 없었다. */
  { m: 'DELETE', re: /^\/api\/unpaid-labor\/([^/]+)$/,                 res: 'unpaid_labor', action: 'delete', target: 1 },
  { m: 'PUT',    re: /^\/api\/unpaid-labor\/([^/]+)$/,                 res: 'unpaid_labor', action: 'edit',   target: 1 },

  // ── 계좌 삭제 ── 잔액이 붙어 있는 자원이다
  { m: 'DELETE', re: /^\/api\/accounts\/([^/]+)$/,                      res: 'account', action: 'delete',     target: 1 },
]

/**
 * 화면에 보여줄 이름 — **서버가 단일 소스다.**
 *
 * 프런트에 따로 두면 규칙을 고칠 때 한쪽만 바뀌어, 새 행위가 'pay_missed' 같은
 * 코드값 그대로 보인다. 변경 이력 화면은 이 표를 /api/audit/meta 로 받아 쓴다.
 *
 * routes/auth.js 가 직접 남기는 계정 관련 행위(로그인·비번·역할)도 여기 함께 둔다 —
 * 기록하는 곳이 둘이어도 읽는 곳은 하나다.
 */
const ACTION_LABELS = {
  // 마감
  close: '마감', reopen: '마감 해제',
  // 등록·삭제
  import: '일괄 등록', delete: '삭제', edit: '수정', delete_month: '월 전체 삭제', generate: '급여 생성',
  // 발행
  issue: '발행', issue_missed: '놓친 회차 일괄 발행',
  backfill: '지난 회차 소급 등록', backfill_undo: '소급 등록 되돌리기',
  skip: '회차 건너뛰기', unskip: '건너뛴 회차 되살리기',
  bulk_settle: '청구서 일괄 정산', bulk_delete: '청구서 일괄 삭제',
  link_contract: '거래 계약 연결·해제',
  // 입금·지급
  match: '입금 연결', match_cancel: '입금 연결 해제',
  pay: '지급', pay_cancel: '지급 취소', pay_missed: '놓친 회차 납입',
  process: '결의서 처리', mature: '만기 처리',
  repay: '상환', repay_missed: '놓친 회차 상환', repay_cancel: '상환 취소',
  // 계정 (routes/auth.js)
  login: '로그인', login_fail: '로그인 실패', create: '등록',
  password_change: '비밀번호 변경', password_reset: '비밀번호 초기화',
  activate: '계정 사용', deactivate: '계정 정지', unlock: '로그인 잠금 해제',
  role_change: '역할 변경', roles_assign: '역할 배정',
  // 회사별 유료 기능 (routes/admin.js) — 계약이 바뀌는 행위라 반드시 남는다
  feature_on: '기능 사용 시작', feature_off: '기능 사용 중지',
}

const RESOURCE_LABELS = {
  closing: '월 마감', transaction: '거래', invoice: '청구서', contract: '계약',
  recurring_invoice: '정기청구', recurring_expense: '정기지출',
  payroll: '급여', work_contract: '근로·용역계약',
  resolution: '지급결의서', settlement: '정산내역서',
  loan: '차입금', investment: '투자', savings: '예금·적금', unpaid_labor: '미지급 퇴직금',
  account: '계좌/카드', vendor: '거래처', ref_item: '기준정보', user: '사용자',
  feature: '유료 기능',
}

/** 대상 ID 길이 상한 (audit_logs.target_id VARCHAR(64)) */
const MAX_TARGET = 64

/**
 * 이 요청이 감사 대상인가. 대상이면 규칙과 경로 캡처를 함께 돌려준다.
 * @returns {{ rule: object, match: RegExpExecArray }|null}
 */
function auditRuleFor(method, fullPath) {
  for (const rule of AUDIT_RULES) {
    if (rule.m !== method) continue
    const match = rule.re.exec(fullPath)
    if (match) return { rule, match }
  }
  return null
}

/**
 * 규칙이 말하는 대상 ID를 뽑는다.
 *
 * body 에서 꺼내는 경우는 규칙에 적힌 **그 필드 하나만** 본다.
 * 본문을 통째로 훑지 않는 이유는 명백하다 — 거기엔 금액과 거래처명이 들어 있다.
 */
function targetIdFrom({ rule, match }, { body, createdId }) {
  const t = rule.target
  if (t == null) return null
  let v = null
  if (t === 'created') v = createdId
  else if (typeof t === 'number') v = match[t]
  else if (t && typeof t.body === 'string') v = body ? body[t.body] : null
  if (v == null) return null
  return String(v).slice(0, MAX_TARGET)
}

module.exports = {
  AUDIT_RULES, auditRuleFor, targetIdFrom, MAX_TARGET,
  ACTION_LABELS, RESOURCE_LABELS,
}
