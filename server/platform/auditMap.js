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
 * 금액·거래처명·계좌번호·품목·주문명은 어떤 경우에도 넣지 않는다. 구체적 수치는 회사 비밀이다.
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
  /* ── 회사 정보 ── 사업자번호가 바뀌면 인쇄물 머리글과 세금계산서 매출·매입 판정이 달라진다.
     누가 언제 바꿨는지 남긴다. */
  { m: 'PUT',    re: /^\/api\/company$/,                           res: 'company', action: 'edit' },

  // ── 마감 ── 장부를 잠그고 여는 행위. 마감 해제는 특히 남아야 한다(잠긴 기간을 다시 연다)
  { m: 'POST',   re: /^\/api\/closings$/,                          res: 'closing', action: 'close',  target: { body: 'period' } },
  // 회기 마감(4단계) — 열두 달을 한 번에 잠그고 푼다. 월 마감과 같은 자원·행위로 남긴다
  { m: 'POST',   re: /^\/api\/closings\/fiscal$/,                   res: 'closing', action: 'close',  target: { body: 'year' } },
  { m: 'DELETE', re: /^\/api\/closings\/fiscal\/([^/]+)$/,          res: 'closing', action: 'reopen', target: 1 },
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
  // 한 번에 세금계산서 여러 장이 나간다 — 한 장 발행이 남는데 N장이 안 남을 이유가 없다
  { m: 'POST',   re: /^\/api\/invoices\/split$/,                    res: 'invoice', action: 'issue_split' },
  // 이월 잔액(4단계) — 쓰기 전 미수·미지급을 금액만으로 세운다. 장부의 출발점이라 남긴다
  { m: 'POST',   re: /^\/api\/invoices\/carryover$/,                res: 'invoice', action: 'carryover' },
  { m: 'POST',   re: /^\/api\/invoices\/([^/]+)\/matches$/,        res: 'invoice', action: 'match',        target: 1 },
  { m: 'DELETE', re: /^\/api\/invoices\/([^/]+)\/matches\/[^/]+$/, res: 'invoice', action: 'match_cancel', target: 1 },
  { m: 'DELETE', re: /^\/api\/invoices\/([^/]+)$/,                 res: 'invoice', action: 'delete',       target: 1 },
  /* 일괄 처리 — 한 번에 최대 100건의 돈이 오가고, 삭제도 그만큼이다.
     건별 기록(match·delete)은 대상 ID로 남지만 "누가 언제 한꺼번에 했나"가 없으면
     "이 날 미지급금이 왜 통째로 사라졌지"를 짚을 수 없다. */
  { m: 'POST',   re: /^\/api\/invoices\/bulk\/settle$/,            res: 'invoice', action: 'bulk_settle' },
  { m: 'POST',   re: /^\/api\/invoices\/bulk\/delete$/,            res: 'invoice', action: 'bulk_delete' },

  // ── 주문 ── 기성·마일스톤 발행은 청구서를 만든다
  { m: 'POST',   re: /^\/api\/contracts\/([^/]+)\/progress-invoice$/,   res: 'invoice',  action: 'issue',  target: 1 },
  { m: 'POST',   re: /^\/api\/contracts\/schedule\/([^/]+)\/issue$/,    res: 'invoice',  action: 'issue',  target: 1 },
  // 회차를 이미 있는 청구서로 잇기/되돌리기 — 주문별 실적과 발행예정 목록이 바뀐다
  { m: 'POST',   re: /^\/api\/contracts\/schedule\/([^/]+)\/link-invoice$/,    res: 'contract', action: 'schedule_link',  target: 1 },
  /* 청구 일정 삭제 — 앞으로 받을 돈이 목록에서 사라지는 일이라 기록이 남아야 한다.
     ⚠ `/:id` 규칙보다 **위**에 둔다. 아래에 두면 'milestones' 를 계약 id 로 읽는다. */
  { m: 'DELETE', re: /^\/api\/contracts\/milestones\/([^/]+)$/,         res: 'contract', action: 'schedule_delete', target: 1 },
  { m: 'DELETE', re: /^\/api\/contracts\/([^/]+)$/,                     res: 'contract', action: 'delete', target: 1 },
  // 주문 없이 남아 있던 청구서·거래를 주문에 붙인 것 — 주문별 실적·원가율이 바뀐다
  { m: 'POST',   re: /^\/api\/contracts\/link-orders$/,                 res: 'contract', action: 'link_orders' },
  // 청구서 품목으로 단가표를 채운 것 — 그 주문의 '기준선'이 정해지는 순간이라 남긴다
  { m: 'POST',   re: /^\/api\/contracts\/([^/]+)\/items\/seed$/,       res: 'contract', action: 'items_seed', target: 1 },

  /* ── 반복거래 ── 한 번에 여러 건의 청구서·거래가 생긴다(또는 이미 들어온 돈에 붙는다).
     반복거래 삭제는 장부를 안 지우지만 앞으로의 목록에서 사라진다 — "왜 이번 달에 안 떴지"를 짚으려면 남긴다. */
  { m: 'POST',   re: /^\/api\/repeat-templates\/create$/,             res: 'repeat_template', action: 'repeat_create' },
  { m: 'DELETE', re: /^\/api\/repeat-templates\/([^/]+)$/,            res: 'repeat_template', action: 'delete', target: 1 },
  { m: 'PUT',    re: /^\/api\/repeat-templates\/([^/]+)$/,            res: 'repeat_template', action: 'edit',   target: 1 },
  { m: 'PATCH',  re: /^\/api\/repeat-templates\/([^/]+)\/toggle$/,    res: 'repeat_template', action: 'toggle', target: 1 },

  // ── 급여·용역 지급 ── 계좌에서 돈이 나간다
  { m: 'POST',   re: /^\/api\/payroll\/generate$/,                      res: 'payroll', action: 'generate' },
  { m: 'POST',   re: /^\/api\/payroll\/([^/]+)\/pay$/,                  res: 'payroll', action: 'pay',          target: 1 },
  { m: 'DELETE', re: /^\/api\/payroll\/([^/]+)\/pay\/[^/]+$/,           res: 'payroll', action: 'pay_cancel',   target: 1 },
  { m: 'DELETE', re: /^\/api\/payroll\/month\/([^/]+)$/,                res: 'payroll', action: 'delete_month', target: 1 },
  { m: 'DELETE', re: /^\/api\/payroll\/([^/]+)$/,                       res: 'payroll', action: 'delete',       target: 1 },
  { m: 'POST',   re: /^\/api\/work-contracts\/([^/]+)\/pay$/,           res: 'work_contract', action: 'pay',    target: 1 },
  { m: 'DELETE', re: /^\/api\/work-contracts\/([^/]+)$/,                res: 'work_contract', action: 'delete', target: 1 },

  /* 주문 귀속 변경 — 금액은 그대로지만 그 돈이 **어느 주문의 실적·원가로 잡히는지**가 바뀐다.
     한 번에 여러 건을 옮길 수 있어서, 나중에 원가율이 이상해졌을 때 언제 무엇이 옮겨졌는지
     짚을 수 있어야 한다. */
  { m: 'POST',   re: /^\/api\/transactions\/link-contract$/,          res: 'transaction', action: 'link_contract' },

  // ── 지급결의 ── 처리하면 실제 지급 거래가 만들어진다
  { m: 'POST',   re: /^\/api\/resolutions\/([^/]+)\/process$/,          res: 'resolution', action: 'process', target: 1 },
  /* 집행을 되돌리는 일은 집행 자체만큼 남겨야 한다 — 지출 거래가 사라지고 청구서가
     미지급으로 되살아나는데, 기록이 없으면 나중에 "왜 다시 낼 돈이 생겼나"를 못 짚는다.
     check:isolation [11] 은 DELETE 만 보므로 이런 POST 취소는 사람이 챙겨야 한다. */
  { m: 'POST',   re: /^\/api\/resolutions\/([^/]+)\/unprocess$/,        res: 'resolution', action: 'unprocess', target: 1 },
  /* 승인 게이트 — 승인해야 처리(돈)가 열린다. 누가 언제 결재 상태를 바꿨는지 남긴다. */
  { m: 'POST',   re: /^\/api\/resolutions\/([^/]+)\/approve$/,          res: 'resolution', action: 'approve',   target: 1 },
  { m: 'POST',   re: /^\/api\/resolutions\/([^/]+)\/unapprove$/,        res: 'resolution', action: 'unapprove', target: 1 },
  // 붙은 청구서가 바뀌면 처리가 '새 비용'인지 '그 청구서 지급'인지가 바뀐다
  { m: 'POST',   re: /^\/api\/resolutions\/([^/]+)\/link-invoice$/,     res: 'resolution', action: 'link_invoice', target: 1 },
  // 이미 나간 지출에 결의서를 만들며 곧바로 연결한다 — 처리(process)와 같은 무게다
  { m: 'POST',   re: /^\/api\/resolutions\/from-txn\/([^/]+)$/,         res: 'resolution', action: 'create_from_txn', target: 'created' },
  // 품의를 결의서로 넘긴다 — 이후 그 품의의 처리 권한이 결의서로 옮겨 간다
  { m: 'POST',   re: /^\/api\/resolutions\/from-purchase-req\/([^/]+)$/, res: 'resolution', action: 'create_from_preq', target: 'created' },
  { m: 'DELETE', re: /^\/api\/resolutions\/([^/]+)$/,                   res: 'resolution', action: 'delete',  target: 1 },
  { m: 'DELETE', re: /^\/api\/settlements\/([^/]+)$/,                   res: 'settlement', action: 'delete',  target: 1 },

  // ── 재무(차입금·투자) ── 원금·이자가 계좌에서 나간다
  { m: 'POST',   re: /^\/api\/finance\/loans\/([^/]+)\/repay$/,         res: 'loan', action: 'repay',         target: 1 },
  { m: 'POST',   re: /^\/api\/finance\/loans\/([^/]+)\/repay-missed$/,  res: 'loan', action: 'repay_missed',  target: 1 },
  { m: 'DELETE', re: /^\/api\/finance\/loans\/([^/]+)\/repay\/[^/]+$/,  res: 'loan', action: 'repay_cancel',  target: 1 },
  { m: 'POST',   re: /^\/api\/finance\/loans\/([^/]+)\/draw$/,          res: 'loan', action: 'draw',          target: 1 },
  { m: 'DELETE', re: /^\/api\/finance\/loans\/([^/]+)\/draw\/[^/]+$/,   res: 'loan', action: 'draw_cancel',   target: 1 },
  { m: 'DELETE', re: /^\/api\/finance\/loans\/([^/]+)$/,                res: 'loan', action: 'delete',        target: 1 },
  { m: 'DELETE', re: /^\/api\/finance\/investments\/([^/]+)$/,          res: 'investment', action: 'delete',  target: 1 },
  /* 투자 회수 취소 — 거래 두 건(원금·처분손익)이 함께 지워진다. 남기지 않으면
     "그 환급 누가 되돌렸지"에 답할 수 없다. */
  { m: 'DELETE', re: /^\/api\/finance\/investments\/([^/]+)\/redeem\/([^/]+)$/, res: 'investment', action: 'redeem-cancel', target: 1 },

  /* ── 대여금(빌려준 돈) ── 거래를 만들고 지우는 장부 API 다.
     ⚠ 이 자리가 통째로 비어 있었다 — check-isolation 의 LEDGER_PREFIXES 에
       '/api/lendings' 가 없어서 검사조차 안 됐다. 함께 넣는다. */
  { m: 'DELETE', re: /^\/api\/lendings\/([^/]+)$/,                    res: 'lending', action: 'delete',         target: 1 },
  { m: 'DELETE', re: /^\/api\/lendings\/([^/]+)\/collect\/([^/]+)$/, res: 'lending', action: 'collect-cancel', target: 1 },

  /* ── 어음 ── 종이 한 장이 채권·채무이고, 만기·부도가 **거래를 만들고 지운다.**
     ⚠ 규칙이 0건이었다. unsettle 은 결제 거래를 DELETE 하고, dishonor·delete 는
       invoice_matches 를 지워 미수금을 되살린다 — 전부 무기록이었다.
       (대여금·정기 라우터가 똑같이 빠졌던 사고의 세 번째 반복이다.) */
  /* 등록도 기록한다 — invoice_id 를 주면 이 경로가 invoice_matches 를 넣어
     **미수금을 지운다**(같은 일을 하는 POST /invoices/:id/matches 는 이미 기록된다).
     자동 검사는 DELETE 만 보므로 문지기에 안 걸린다. */
  { m: 'POST',   re: /^\/api\/notes$/,                       res: 'note', action: 'create',    target: 0 },
  { m: 'POST',   re: /^\/api\/notes\/([^/]+)\/settle$/,    res: 'note', action: 'settle',    target: 1 },
  { m: 'POST',   re: /^\/api\/notes\/([^/]+)\/dishonor$/,  res: 'note', action: 'dishonor',  target: 1 },
  { m: 'POST',   re: /^\/api\/notes\/([^/]+)\/unsettle$/,  res: 'note', action: 'unsettle',  target: 1 },
  { m: 'PUT',    re: /^\/api\/notes\/([^/]+)$/,             res: 'note', action: 'edit',      target: 1 },
  { m: 'DELETE', re: /^\/api\/notes\/([^/]+)$/,             res: 'note', action: 'delete',    target: 1 },

  // ── 적금 ── 납입·만기도 계좌를 움직인다
  { m: 'POST',   re: /^\/api\/savings\/([^/]+)\/pay-missed$/,           res: 'savings', action: 'pay_missed', target: 1 },
  { m: 'POST',   re: /^\/api\/savings\/([^/]+)\/pay$/,                  res: 'savings', action: 'pay',        target: 1 },
  { m: 'POST',   re: /^\/api\/savings\/([^/]+)\/mature$/,               res: 'savings', action: 'mature',     target: 1 },
  /* 납입 취소 — 회차를 예정으로 되돌리고 그 지출 거래를 지운다. 돈이 오간 기록을
     없애는 일이라 "그 납입 누가 되돌렸지"에 답할 수 있어야 한다(차입금 상환 취소와 같다). */
  { m: 'DELETE', re: /^\/api\/savings\/([^/]+)\/pay\/([^/]+)$/,         res: 'savings', action: 'unpay',      target: 1 },
  { m: 'DELETE', re: /^\/api\/savings\/([^/]+)$/,                       res: 'savings', action: 'delete',     target: 1 },

  /* ── 미지급 퇴직금 ── 여기 적힌 금액은 자금 예측이 '언젠가 나갈 돈'으로 세는 실제 자금이다
     (실물 기준 7,351만). 지우거나 금액을 고치면 그만큼 나갈 돈이 사라지는데 기록이 없었다. */
  { m: 'DELETE', re: /^\/api\/unpaid-labor\/([^/]+)$/,                 res: 'unpaid_labor', action: 'delete', target: 1 },
  { m: 'PUT',    re: /^\/api\/unpaid-labor\/([^/]+)$/,                 res: 'unpaid_labor', action: 'edit',   target: 1 },

  // ── 계좌 삭제 ── 잔액이 붙어 있는 자원이다
  { m: 'DELETE', re: /^\/api\/accounts\/([^/]+)$/,                      res: 'account', action: 'delete',     target: 1 },

  /* ── 문지기 확장으로 드러난 공백 (2026-09) ──────────────────────────────
   * 감사 누락이 네 번 반복됐다(대여금 → 정기 → 어음 → 세금). 빠진 것은 늘
   * **돈을 만들거나 지우는 POST/PATCH/PUT** 이었는데 문지기가 DELETE 만 봤다.
   * 검사를 넓히자 39건이 한꺼번에 드러났다. 아래는 그중 **장부가 실제로 바뀌는** 것들이다.
   * (조회·미리보기·첨부는 문지기가 알아서 뺀다.) */

  // ── 세금 ── 납부·환급이 지출·입금 거래를 만들고 지운다. 규칙이 0건이었다.
  { m: 'PUT',    re: /^\/api\/tax\/vat$/,                              res: 'tax', action: 'file_vat' },
  { m: 'POST',   re: /^\/api\/tax\/others$/,                           res: 'tax', action: 'create' },
  { m: 'PUT',    re: /^\/api\/tax\/others\/([^/]+)$/,                  res: 'tax', action: 'edit',   target: 1 },
  { m: 'DELETE', re: /^\/api\/tax\/others\/([^/]+)$/,                  res: 'tax', action: 'delete', target: 1 },

  // ── 거래 ── 이체는 두 줄을 만들고, 상태 뒤집기는 통장에서 돈이 나간 것으로 만든다
  { m: 'POST',   re: /^\/api\/transactions\/transfer$/,                res: 'transaction', action: 'transfer' },
  { m: 'PUT',    re: /^\/api\/transactions\/([^/]+)$/,                 res: 'transaction', action: 'edit',   target: 1 },
  { m: 'PATCH',  re: /^\/api\/transactions\/([^/]+)\/status$/,         res: 'transaction', action: 'status', target: 1 },

  // ── 청구서 ── 금액·상태를 바꾸면 미수금이 따라 움직인다
  { m: 'PUT',    re: /^\/api\/invoices\/([^/]+)$/,                     res: 'invoice', action: 'edit', target: 1 },

  // ── 계좌 ── 잔액 조정은 되돌릴 길이 좁다(project_undelete_gaps 참조)
  { m: 'PUT',    re: /^\/api\/accounts\/([^/]+)$/,                     res: 'account', action: 'edit',   target: 1 },
  { m: 'POST',   re: /^\/api\/accounts\/([^/]+)\/adjustments$/,        res: 'account', action: 'adjust', target: 1 },

  /* ── 차입금·투자 ── 상환·회수는 거래 2건(원금+이자)을 만든다.
     ⚠ `/repay$` 규칙은 있었는데 `-adhoc` 이 정규식에 안 걸려 수시 상환만 무기록이었다. */
  { m: 'POST',   re: /^\/api\/finance\/loans$/,                              res: 'loan',       action: 'create' },
  { m: 'PUT',    re: /^\/api\/finance\/loans\/([^/]+)$/,                     res: 'loan',       action: 'edit',        target: 1 },
  { m: 'PATCH',  re: /^\/api\/finance\/loans\/([^/]+)\/cycles\/[^/]+$/,      res: 'loan',       action: 'edit_cycle',  target: 1 },
  { m: 'POST',   re: /^\/api\/finance\/loans\/([^/]+)\/repay-adhoc$/,        res: 'loan',       action: 'repay_adhoc', target: 1 },
  { m: 'POST',   re: /^\/api\/finance\/investments$/,                        res: 'investment', action: 'create' },
  { m: 'POST',   re: /^\/api\/finance\/investments\/([^/]+)\/redeem$/,       res: 'investment', action: 'redeem',      target: 1 },

  // ── 대여금 ── 회수도 거래 2건. 취소(DELETE)만 기록되고 회수는 무기록이었다.
  { m: 'PUT',    re: /^\/api\/lendings\/([^/]+)$/,                     res: 'lending', action: 'edit',           target: 1 },
  { m: 'POST',   re: /^\/api\/lendings\/([^/]+)\/collect$/,            res: 'lending', action: 'collect',        target: 1 },
  { m: 'POST',   re: /^\/api\/lendings\/([^/]+)\/collect-adhoc$/,      res: 'lending', action: 'collect_adhoc',  target: 1 },

  // ── 예적금 ── 수정이 가입 출금 거래를 따라 고친다
  { m: 'PUT',    re: /^\/api\/savings\/([^/]+)$/,                      res: 'savings', action: 'edit',       target: 1 },
  { m: 'PATCH',  re: /^\/api\/savings\/([^/]+)\/cycles\/[^/]+$/,       res: 'savings', action: 'edit_cycle', target: 1 },

  /* ── 주문 ── 금액·청구 일정이 바뀌면 앞으로 받을 돈이 바뀐다.
     ※ `PATCH /milestones/:id/status` 는 2026-09-02 에 **라우트째 지웠다** — 가드가
       하나도 없어 청구서 없이 '입금 완료'로 만들 수 있는 통로였고 호출자도 0이었다.
       상태는 청구서 발행·정산이 움직인다(routes/invoices.js). */
  { m: 'PUT',    re: /^\/api\/contracts\/([^/]+)$/,                        res: 'contract', action: 'edit',            target: 1 },
  { m: 'POST',   re: /^\/api\/contracts\/([^/]+)\/renew$/,                 res: 'contract', action: 'renew',           target: 1 },
  { m: 'POST',   re: /^\/api\/contracts\/([^/]+)\/milestones$/,            res: 'contract', action: 'save_milestones', target: 1 },
  { m: 'PUT',    re: /^\/api\/contracts\/([^/]+)\/cost-budget$/,           res: 'contract', action: 'edit_budget',     target: 1 },

  // ── 문서 ── 결의서·정산내역서 수정은 집행 금액과 짝이 맞아야 한다
  { m: 'PUT',    re: /^\/api\/resolutions\/([^/]+)$/,                  res: 'resolution', action: 'edit',         target: 1 },
  { m: 'POST',   re: /^\/api\/resolutions\/([^/]+)\/reload-lines$/,    res: 'resolution', action: 'reload_lines', target: 1 },
  { m: 'PUT',    re: /^\/api\/settlements\/([^/]+)$/,                  res: 'settlement', action: 'edit',         target: 1 },
  /* 순수 대체 전표(D2) — 현금 없는 분개(감가상각 등). 장부에 오르므로 남긴다. */
  { m: 'POST',   re: /^\/api\/journal-vouchers$/,                       res: 'journal_voucher', action: 'create' },
  { m: 'DELETE', re: /^\/api\/journal-vouchers\/([^/]+)$/,              res: 'journal_voucher', action: 'delete', target: 1 },
  /* 승인 게이트 — 승인해야 지출 처리가 열린다. 누가·언제는 이 감사기록이 남긴다.
     (예전의 issue-payable — 품의 승인으로 미지급금을 만들던 경로 — 은 2026-09 에 없앴다.
      미지급금은 세금계산서에서만 생긴다. lib/docExec.js 머리말 참고) */
  { m: 'POST',   re: /^\/api\/purchase-reqs\/([^/]+)\/process$/,         res: 'purchase_req', action: 'process',   target: 1 },
  { m: 'POST',   re: /^\/api\/purchase-reqs\/([^/]+)\/unprocess$/,       res: 'purchase_req', action: 'unprocess', target: 1 },
  { m: 'POST',   re: /^\/api\/purchase-reqs\/([^/]+)\/link-invoice$/,    res: 'purchase_req', action: 'link_invoice', target: 1 },
  { m: 'POST',   re: /^\/api\/purchase-reqs\/([^/]+)\/approve$/,       res: 'purchase_req', action: 'approve',   target: 1 },
  { m: 'POST',   re: /^\/api\/purchase-reqs\/([^/]+)\/unapprove$/,     res: 'purchase_req', action: 'unapprove', target: 1 },
  { m: 'PUT',    re: /^\/api\/purchase-reqs\/([^/]+)$/,               res: 'purchase_req', action: 'edit',   target: 1 },
  /* 삭제 — 지출 처리까지 끝난 품의는 cascade 로 지출을 되돌린 뒤 지운다. 무엇이 사라졌는지 남긴다. */
  { m: 'DELETE', re: /^\/api\/purchase-reqs\/([^/]+)$/,               res: 'purchase_req', action: 'delete', target: 1 },

  // ── 근로·용역계약 ── 계약 조건이 급여·용역대장의 근거다
  { m: 'PUT',    re: /^\/api\/work-contracts\/([^/]+)$/,               res: 'work_contract', action: 'edit',      target: 1 },
  { m: 'POST',   re: /^\/api\/work-contracts\/([^/]+)\/duplicate$/,    res: 'work_contract', action: 'duplicate', target: 1 },

  /* 증빙 첨부 — 장부 금액은 안 바뀌지만 **부가세 공제 판정**이 바뀐다
     (증빙유형이 불공제면 매입세액에서 빠진다 — lib/vatAgg.js). */
  { m: 'PATCH',  re: /^\/api\/transactions\/([^/]+)\/evidence$/,       res: 'transaction', action: 'evidence', target: 1 },
  { m: 'PATCH',  re: /^\/api\/invoices\/([^/]+)\/evidence$/,           res: 'invoice',     action: 'evidence', target: 1 },

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
  issue: '발행', repeat_create: '반복거래로 만들기',
  bulk_settle: '청구서 일괄 정산', bulk_delete: '청구서 일괄 삭제',
  link_contract: '거래 주문 연결·해제',
  // 입금·지급
  match: '입금 연결', match_cancel: '입금 연결 해제',
  pay: '지급', pay_cancel: '지급 취소', pay_missed: '놓친 회차 납입', unpay: '납입 취소',
  schedule_delete: '청구 일정 삭제',
  schedule_link: '청구 일정에 청구서 잇기',
  // 주문 붙이기 — 청구서·거래를 몰아서 주문에 귀속시킨다(되돌리기도 같은 행위)
  link_orders: '주문 붙이기', items_seed: '주문 단가표 채우기',
  process: '지출 처리', mature: '만기 처리',
  approve: '승인', unapprove: '승인 취소',
  repay: '상환', repay_missed: '놓친 회차 상환', repay_cancel: '상환 취소',
  // 대여금·투자 회수 — 차입금 상환의 거울상
  'collect-cancel': '회수 취소', 'redeem-cancel': '회수 취소',
  draw: '추가 차입', draw_cancel: '추가 차입 취소',
  unprocess: '처리 취소', issue_split: '나눠 발행', carryover: '이월 잔액 등록',
  /* ── 어음 ── 만기에 실제로 돈이 오가거나(결제) 안 오간다(부도) */
  settle: '어음 만기 결제', unsettle: '어음 결제 취소', dishonor: '어음 부도 처리',
  // ── 세금 ──
  file_vat: '부가세 신고 확정',
  // ── 거래 ── 이체는 두 줄을 만들고, 상태 뒤집기는 통장에서 돈이 나간 것으로 만든다
  transfer: '계좌 이체', status: '상태 변경', evidence: '증빙 첨부·해제',
  // ── 계좌 ──
  adjust: '잔액 조정',
  // ── 회차가 있는 것(차입금·예적금·정기) ──
  edit_cycle: '회차 수정', toggle: '사용 켜기·끄기',
  repay_adhoc: '수시 상환', collect: '회수', collect_adhoc: '수시 회수', redeem: '회수',
  // ── 주문 ──
  renew: '갱신', save_milestones: '청구 일정 저장', edit_budget: '원가 예산 수정',
  // ── 문서 ──
  reload_lines: '집행 내역 다시 불러오기', duplicate: '복제',
  // 대상(구매품의서·지급결의서)은 자원 이름이 붙여 준다 — 행위 이름에 문서명을 넣지 않는다
  link_invoice: '청구서 연결·해제', create_from_txn: '나간 지출에 결의서 붙이기', create_from_preq: '품의를 결의서로 넘기기',
  // 계정 (routes/auth.js)
  login: '로그인', login_fail: '로그인 실패', create: '등록',
  password_change: '비밀번호 변경', password_reset: '비밀번호 초기화',
  activate: '계정 사용', deactivate: '계정 정지', unlock: '로그인 잠금 해제',
  role_change: '역할 변경', roles_assign: '역할 배정',
  // 회사별 유료 기능 (routes/admin.js) — 계약이 바뀌는 행위라 반드시 남는다
  feature_on: '기능 사용 시작', feature_off: '기능 사용 중지',
}

const RESOURCE_LABELS = {
  closing: '월 마감', transaction: '거래', invoice: '청구서', contract: '주문',
  repeat_template: '반복거래',
  /* 옛 정기청구·정기지출 기록(2026-09 이전 감사 로그)을 읽을 때 이름이 비지 않게 남긴다 */
  recurring_invoice: '정기청구', recurring_expense: '정기지출',
  payroll: '급여', work_contract: '근로·용역계약',
  resolution: '지급결의서', settlement: '정산내역서',
  loan: '차입금', lending: '대여금', investment: '투자', savings: '예금·적금', unpaid_labor: '미지급 퇴직금',
  account: '계좌/카드', vendor: '거래처', ref_item: '기준정보', user: '사용자',
  feature: '유료 기능',
  company: '회사 정보',
  note: '어음', tax: '세금', purchase_req: '구매품의서', journal_voucher: '대체전표',
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
