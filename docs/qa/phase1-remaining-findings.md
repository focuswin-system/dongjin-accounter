# Phase 1 — 미완 5개 영역 검토 결과

> 2026-07-22 / 에이전트 43개(Find 5 + Verify 38) / **반증 0건**
> P0/P1은 2렌즈 반증 검증 완료, P2는 미검증(`?` 표시)

## 요약

| 판정 | 건수 |
|---|---|
| CONFIRMED | 18 |
| PLAUSIBLE | 1 |
| 미검증(P2) | 13 |
| 반증 폐기 | 0 |

| 심각도 | 건수 |
|---|---|
| P0 | 2 |
| P1 | 14 |
| P2 | 16 |

---

## P0 (2건)

### BAL-01 · `server/routes/invoices.js:197`

**청구서 정산(매칭)으로 새로 만드는 입/출금 거래에 계좌가 안 붙어 계좌 잔액에 반영되지 않는다**

- 영역: balance-reconcile / 판정: CONFIRMED

**근거**

POST /invoices/:id/matches 는 기존 거래 재사용 경로(invoices.js:180-188)에서는 `const acct = cur?.account_id || inv.account_id || null; if (!acct) { rollback; 400 '이 거래에는 계좌가 없어요...' }` 로 계좌를 강제한다. 그런데 바로 아래 신규 거래 생성 경로(189-199)는 같은 가드 없이 `inv.account_id || null` 을 그대로 account_id 로 넣고 status 는 '입금완료'/'지급완료'로 확정한다. 라우트가 body 에서 읽는 값은 `{ txn_id, amount, date, category, memo, account_code }` 뿐이라 account_id 를 받을 방법 자체가 없고(src/lib/api.js:286, src/screens/Billing.jsx:122 도 계좌를 안 보냄), 자동 생성된 청구서는 account_id 가 NULL 이다 — recurring-invoices.js:197 은 `r.account_id||null`, contracts.js:296 은 `paid ? accountId : null`, 그 recurring_invoices 자체도 contracts.js:602-606 에서 account_id 를 null 로 만든다. calcBalance(accounts.js:10-11)는 account_id 가 일치하는 행만 세므로 account_id NULL 행은 잔액에 영원히 안 잡힌다.

**시나리오**

계약 등록 시 자동 생성된 정기청구(account_id NULL) → /recurring-invoices/generate 로 '입금 예정' 청구서 생성(account_id NULL) → 대금청구 화면에서 '입금 처리'(매칭) → income 거래가 status='입금완료', account_id=NULL 로 생성됨 → 거래내역·미수금·계약 수금액은 모두 정상 반영되지만 계좌 잔액만 1원도 안 늘어난다. 청구 일정에서 paid 없이 발행한 매입 청구서를 나중에 지급 처리해도 동일하게 출금이 잔액에서 안 빠진다.

**수정 방향**

신규 거래 생성 경로에도 재사용 경로와 같은 계좌 가드를 넣고(계좌 없으면 400), POST body 에 account_id 를 받아 `account_id || inv.account_id || 기본 은행계좌` 순으로 채운다. 프런트(Billing 정산 모달)에도 계좌 선택 칩을 추가한다.

---

### BAL-04 · `server/routes/transactions.js:287`

**엑셀 일괄 업로드 거래는 계좌가 비어 있어 완료 상태인데도 계좌 잔액에 전혀 반영되지 않는다**

- 영역: balance-reconcile / 판정: CONFIRMED (P1→P0 조정)

**근거**

import/commit 의 INSERT 컬럼 목록에 account_id 자체가 없다(`INSERT INTO transactions (id, kind, vendor_id, contract_id, category, amount, date, method, status, buyer_type, doc_no, memo)`), 상태는 `it.kind === 'income' ? '입금완료' : '지급완료'`(290행)로 확정 저장한다. 프런트 매핑도 날짜·거래처·계약명·구분·비목·금액·메모만 보내고 계좌 항목이 없다(Docs.jsx:1114-1121, 1144). 엑셀 양식 안내도 '기존 입출금 자료'를 올리라고 한다(transactions.js:313). calcBalance 는 account_id 일치 행만 세므로 이 거래들은 잔액에 영구히 안 잡힌다.

**시나리오**

은행 거래내역 200건을 엑셀로 업로드 → 거래내역 목록·수입/지출 합계·분석 매출/매입·계약 집계에는 전부 반영되는데 계좌 잔액은 initial_balance 그대로 → 통장 잔액과 화면 잔액이 처음부터 어긋난 채 운영된다.

**수정 방향**

임포트 마법사에 '입금/출금 계좌' 선택(행별 또는 일괄)을 추가하고 서버 INSERT 에 account_id 를 포함시킨다. 최소한 계좌 미지정 업로드 시 '이 거래는 계좌 잔액에 반영되지 않습니다' 경고를 명시한다.

---

## P1 (14건)

### BAL-02 · `server/routes/transactions.js:184`

**계좌 없는 정기지출 거래를 '지급완료'로 바꿔도 잔액에서 빠지지 않는데 상태 변경 API에 가드가 없다**

- 영역: balance-reconcile / 판정: CONFIRMED (P0→P1 조정)

**근거**

PATCH /transactions/:id/status 는 '지급 완료'→'지급완료' 공백만 정규화하고 `UPDATE transactions SET status=?` 만 실행한다(account_id 검사 없음). 한편 정기지출 자동 생성(recurring.js:72-73)은 `r.account_id||null` 로 거래를 만들고, 계약에서 자동 생성된 정기지출은 contracts.js:595-599 가 account_id 를 항상 null 로 넣는다(마지막 파라미터 `null`). 정기지출 등록 폼도 계좌 입력이 없다(Master.jsx:1670-1712). 그 결과 account_id NULL + status '지급 대기' 거래가 정상적으로 생기고, Ledger.jsx:272-274 의 '이체 실행'은 이 API로 '지급완료'만 찍는다. accounts.js:11 은 `kind='expense' AND account_id=a.id AND status='지급완료'` 만 합산하므로 NULL 계좌 행은 잔액에서 빠지지 않는다.

**시나리오**

계약(매입)에 걸린 정기지출 → /recurring-expenses/generate 로 '지급 대기' 거래 생성(account_id NULL) → 거래내역에서 '이체 실행' 클릭 → 원장에는 지출 300만원이 '지급완료'로 찍히고 지출합계(Ledger.jsx:65)·분석 매입(analytics.js:72)에도 잡히지만 어느 계좌 잔액도 줄지 않는다. F-02(급여/용역 지급 미반영)와 같은 계열의 잔여 구멍.

**수정 방향**

PATCH status 에서 완료 상태로 전환할 때 account_id 가 없으면 400 으로 막고(결의서 연결 경로와 동일 규칙), 프런트 이체 실행 모달에서 계좌를 고르게 해 함께 UPDATE 한다. 아울러 recurring_expenses 등록/계약 자동 생성 시 account_id 를 필수로 받는다.

---

### BAL-03 · `server/routes/contracts.js:65`

**계약 지표의 지급액·원가가 '지급 대기' 거래까지 합산해 미지급 잔액과 계약 손익이 실제보다 좋게 나온다**

- 영역: balance-reconcile / 판정: CONFIRMED

**근거**

METRIC_COLS 의 `out_total`(65행), `cost_total`(66행), `term_out`(69행)은 `kind='expense'` 만 걸고 status 조건이 없다. metrics()에서 매입계약은 `collected = out`, `ar_remain = billed - collected`, 매출계약은 `profit = in_done - cost` 로 쓰인다. 반면 같은 응답 안의 원가 실적 집계는 `if (t.status !== '지급완료') continue`(457-466행), 원가분석 API 는 `AND status='지급완료'`(793행), 계좌 잔액(accounts.js:11)·분석(analytics.js:72)도 '지급완료'만 센다. 즉 한 화면에서 '원가'(미필터)와 '원가 실적'(지급완료만)이 서로 다른 값이 된다.

**시나리오**

매입계약에 걸린 정기지출이 매달 '지급 대기' 거래를 만든다 → 아직 이체하지 않았는데 계약 상세의 지급액(collected)이 즉시 올라가고 미지급 잔액(ar_remain)과 남은 계약분(remain)이 그만큼 줄어든다. 매출계약도 아직 안 나간 외주비가 cost 로 잡혀 손익(profit)이 실제보다 낮게, 원가 실적 타일과는 다른 숫자로 표시된다.

**수정 방향**

METRIC_COLS 의 지출 계열(out_total·cost_total·term_out)에 `AND status='지급완료'` 를 붙여 잔액·분석·원가실적과 기준을 통일하거나, 지급완료분과 예정분을 별도 컬럼으로 내려 화면에서 구분해 표시한다.

---

### BAL-06 · `src/screens/Home.jsx:59`

**홈 대시보드의 '입금 처리 / 이체 실행'이 아무것도 기록하지 않는 빈 호출인데 성공 메시지를 보여준다**

- 영역: balance-reconcile / 판정: CONFIRMED

**근거**

handlePaymentConfirm 은 `await api.completeTodo(todo.id)` 만 호출하고 doneIds 에 넣은 뒤 "입금이 처리되었어요"/"이체가 실행되었어요" 토스트를 띄운다(Home.jsx:57-63). 그런데 api.completeTodo 는 `async completeTodo() { return { ok: true } }`(src/lib/api.js:1033) — 서버 호출이 전혀 없는 no-op 이다. 모달은 '등록된 계좌에서 이체합니다'라고 안내하고 지급일을 필수(*)로 받지만(Home.jsx:82-89) 그 날짜도 그냥 버려진다. 할 일 목록 자체는 실데이터(getReceivables/getPayables)로 만들어진다(api.js:1009-1031).

**시나리오**

홈 '오늘 할 일'에서 미수금 건의 '입금 처리'를 누르고 입금일을 지정해 확인 → 성공 토스트가 뜨고 항목이 사라진다. 그러나 청구서 상태·거래·계좌 잔액 어디에도 반영이 없고 새로고침하면 같은 할 일이 그대로 돌아온다. 경리가 처리했다고 믿고 넘어가면 수금 독촉이 누락된다.

**수정 방향**

todo.id 의 접두사(ar-/ap-)로 청구서 id 를 뽑아 POST /invoices/:id/matches(계좌·금액·날짜 포함)로 실제 정산을 태우거나, 구현 전까지는 해당 액션 버튼을 해당 화면으로 이동시키는 링크로 바꾼다.

---

### TX-02 · `server/routes/contracts.js:241`

**catch 안의 conn.rollback()이 던지면 next(e)가 실행되지 않아 요청이 무응답 + Node 기본값으로 프로세스가 죽는다**

- 영역: transaction-connection / 판정: CONFIRMED

**근거**

트랜잭션 라우트 약 25곳이 전부 이 모양이다:

```
  } catch (e) { await conn.rollback(); next(e) }
  finally { conn.release() }
```
(contracts.js:241·314·399, invoices.js:145·214·274, payroll.js:223·259·277·294·307, tax.js:125·177·195·208, transactions.js:296, work-contracts.js:245·270·302·315·406, recurring.js:82, recurring-invoices.js:161·207, vendors.js:113)

rollback 이 거부하면 그 rejection 이 catch 를 뚫고 나가 `next(e)` 가 실행되지 않는다. release 는 finally 라 누수는 없지만, Express 4.18(server/package.json)은 async 핸들러의 rejection 을 잡지 않으므로 응답이 영영 안 나가고, Node 20(v20.14.0, unhandled-rejections 기본값 throw)에서 index.js에 uncaughtException/unhandledRejection 핸들러가 전혀 없어(index.js:88-91 은 Express 에러 미들웨어일 뿐) 프로세스가 그대로 종료된다. rollback 이 던지는 대표 상황은 '커넥션이 트랜잭션 도중 끊겨서 원래 에러가 난' 경우 — 즉 catch 에 들어오는 바로 그 상황이다(mysql2: "Can't add new command when connection is in closed state").

**시나리오**

MariaDB 재시작이나 wait_timeout/네트워크 순단으로 계약 갱신(POST /contracts/:id/renew) 트랜잭션 중 커넥션이 끊긴다 → catch 진입 → conn.rollback() 이 'connection is in closed state'로 거부 → next(e) 미실행 → 500 대신 무응답, 그리고 Node 프로세스가 죽어 pm2가 재기동하는 동안 다른 회사의 진행 중 요청까지 전부 끊긴다.

**수정 방향**

`await conn.rollback().catch(() => {})` 로 감싸 rollback 실패가 원래 에러를 덮지 않게 하고, 별도로 index.js에 process.on('unhandledRejection'/'uncaughtException') 로깅 가드를 둔다. 근본적으로는 asyncHandler 래퍼(`fn(req,res,next).catch(next)`)를 도입해 모든 라우트에 적용.

---

### TX-03 · `server/routes/work-contracts.js:102`

**getConnection()이 try 블록 밖에 있어 커넥션 획득 실패가 라우트 밖으로 새어 무응답 + 프로세스 종료로 이어짐**

- 영역: transaction-connection / 판정: CONFIRMED

**근거**

거의 모든 트랜잭션/커넥션 라우트가 `const conn = await req.db.getConnection()` 을 try 밖 첫 줄에 둔다:

```
router.get('/', async (req, res, next) => {
  const conn = await req.db.getConnection()   // ← try 밖. 여기서 거부되면 잡는 사람이 없다
  try { ... } catch (e) { next(e) } finally { conn.release() }
```
해당 지점: contracts.js:175·260·328·560·635·755, invoices.js:130·153·254, payroll.js:93·110·138·178·228·264·283·298, recurring.js:56, recurring-invoices.js:100·169, resolutions.js:83·159, tax.js:93·166·183·200, transactions.js:225·260, vendors.js:76, work-contracts.js:102·150·206·249·275·306·343. (transactions.js:142 만 try 안에 있어 올바르다.)

Express 4 는 async 핸들러 rejection 을 잡지 않고, index.js 에 unhandledRejection 핸들러가 없으며 Node 20 기본값은 throw 라 프로세스가 종료된다. getConnection 은 DB 다운(ECONNREFUSED), max_connections 초과(ER_CON_COUNT_ERROR), poolManager 의 evict 로 닫힌 풀("Pool is closed") 에서 실제로 거부된다.

**시나리오**

MariaDB 가 max_connections(기본 151)에 도달하거나 잠깐 재시작되는 순간 사용자가 인사관리 화면을 연다 → GET /api/work-contracts 의 102행 getConnection 이 거부 → 500 응답도 없이 프로세스가 죽고 pm2 재기동. 일시적 DB 장애가 전 테넌트 서비스 중단으로 증폭된다.

**수정 방향**

getConnection 을 try 안으로 옮기고 `let conn; try { conn = await req.db.getConnection(); ... } catch(e){ next(e) } finally { conn?.release() }` 형태로 통일하거나, asyncHandler 래퍼를 도입해 라우트 전체를 한 번에 보호한다.

---

### TX-04 · `server/scripts/cleanup-recurring-invoices.js:25`

**정기청구 정리 스크립트가 존재하지 않는 export(pool)를 가져와 실행 즉시 TypeError로 죽는다**

- 영역: transaction-connection / 판정: CONFIRMED

**근거**

```
const { pool } = require('../db')          // 25행
...
const [summary] = await pool.execute(...)  // 49행
```
그런데 db.js:1174-1178 은 pool 을 의도적으로 export 하지 않는다(`module.exports = { initDb, kstDate, kstToday, futureDateError }`). 실제로 확인했다:
```
$ node -e "const m=require('./db'); console.log(Object.keys(m), typeof m.pool)"
[ 'initDb', 'kstDate', 'kstToday', 'futureDateError' ] undefined
```
즉 49행에서 `Cannot read properties of undefined (reading 'execute')` 로 즉사한다. 86행의 `pool.getConnection()`(실제 삭제 트랜잭션)에는 도달조차 못 한다. scripts/check-isolation.js 는 routes/ 만 훑기 때문에(19행 ROUTES_DIR) 이 위반을 잡지 못한다. 덧붙여 설령 pool 을 되살려도 이 스크립트는 레거시 DB_NAME 을 가리키므로 멀티테넌트에서 대상 회사 DB를 특정할 수 없다.

**시나리오**

운영 중 정기청구가 소급 생성돼 미수금이 부풀었을 때(메모리에 기록된 2026-07-20 사고 유형) 운영자가 `node server/scripts/cleanup-recurring-invoices.js --vendor "..."` 를 실행 → 미리보기조차 못 보고 TypeError 로 종료. 복구 수단이 없다고 판단해 수동 SQL로 지우다 매칭 있는 청구서까지 날릴 위험.

**수정 방향**

테넌트 DB를 인자(--company/--db)로 받아 mysql2 커넥션을 직접 만들거나 platform/db.js 의 withAdmin 을 쓰도록 고친다. 아울러 check-isolation.js 의 전역 pool 검사 대상에 scripts/ 도 포함시켜 같은 실수를 기계가 잡게 한다.

---

### TX-07 · `server/routes/contracts.js:279`

**청구서 발행·세금 납부·용역 지급의 날짜 폴백이 UTC라 KST 새벽에 하루 전 날짜로 기록된다**

- 영역: transaction-connection / 판정: CONFIRMED

**근거**

이번 세션에서 invoices.js·payroll.js 는 kstToday()로 고쳐졌지만 같은 패턴이 세 파일에 남아 있다:
- contracts.js:279 `const today = new Date().toISOString().slice(0, 10)` → 청구 일정 발행의 invoices.issued_at 과 기입금 거래 date 폴백(296·305행)
- contracts.js:359 동일 — 기성 청구(progress-invoice)의 issuedAt(376·392행)
- tax.js:22 `const d = date || new Date().toISOString().slice(0, 10)` → 부가세/기타세액 납부 거래의 date(30·38행)
- work-contracts.js:375·398 `new Date().toISOString().slice(0,10)` → payroll.month 산출과 용역 지급 거래 date

같은 파일이 미래일자 검증에는 KST 기준 futureDateError/kstToday(db.js:1165-1172)를 쓰므로 검증축과 저장축의 기준이 서로 다르다. 오류 없이 하루 어긋난 날짜가 그대로 저장된다.

**시나리오**

경리가 2026-07-01 오전 8시(KST)에 계약 청구 일정을 '기입금'으로 발행한다. UTC로는 아직 2026-06-30이라 청구서 issued_at 과 입금 거래 date 가 6월 30일로 저장된다 → 그 매출의 부가세가 3분기가 아니라 2분기 집계(tax.js:47-53 QUARTER(issued_at))에 잡히고, 6월 마감을 이미 끝낸 월별 손익도 소급해 바뀐다. 화면 어디에도 경고가 없어 사용자는 알아채지 못한다.

**수정 방향**

세 파일의 `new Date().toISOString().slice(0,10)` 을 전부 db.js의 kstToday()로 교체한다(contracts.js:279·359, tax.js:22, work-contracts.js:375·398). 재발 방지로 check-isolation.js에 routes/ 내 `new Date().toISOString().slice(0,10)` 금지 규칙을 추가할 것.

---

### DEL-01 · `C:/Users/USER/Desktop/Project/public/focus-accounter/server/routes/invoices.js:129`

**정기청구/정기지출로 생성된 청구서·거래를 삭제해도 last_generated가 되돌아가지 않아 그 회차가 영구히 사라진다**

- 영역: delete-integrity / 판정: CONFIRMED

**근거**

`server/lib/recurrence.js:48,61`이 회차 생성의 하한을 `const genFloor = rec.last_generated || ''` / `if (ds > genFloor) out.push(ds)` 로 잡는다. 즉 last_generated 이하 날짜는 pending에도 issue에도 다시 나오지 않는다.
반면 `recurring-invoices.js:158` (`UPDATE recurring_invoices SET last_generated = ?`)와 `recurring-invoices.js:201`, `recurring.js:75` 는 생성 시 이 값을 전진시키기만 한다.
청구서 삭제(`invoices.js:129-146`)는 invoice_matches·invoice_docs 정리, `transactions.invoice_id=NULL`, `milestones` 상태 되돌리기까지 하지만 `recurring_invoices.last_generated` 는 전혀 건드리지 않는다. 애초에 `invoices` 테이블에는 recurring_id 컬럼 자체가 없어(db.js:129-148) 어느 정기청구에서 나온 청구서인지 되짚을 수도 없다.
정기지출 쪽도 동일: `transactions.js:224-243` 의 거래 삭제는 `transactions.recurring_id`(db.js:188, FK 없음)를 보지 않으므로 `recurring_expenses.last_generated` 가 그대로 남는다.

**시나리오**

월 정기청구(매달 1일, 500만원)에서 3월분 청구서가 자동 생성됨 → last_generated='2026-03-01'. 경리가 금액을 잘못 넣었다고 판단해 대금청구 화면에서 그 청구서를 삭제(입금 매칭 전이라 409 가드도 통과). 이후 '발행 예정' 목록을 다시 열어도 3월 회차는 dueDatesToGenerate에서 `ds > genFloor` 조건에 걸려 나오지 않는다. 4월 1일이 되어야 4월분만 뜬다 → 3월 매출 500만원이 아무 경고 없이 미청구로 누락된다. 정기지출도 같은 방식으로 그 달 지출이 다시 생성되지 않는다.

**수정 방향**

invoices에 recurring_id 컬럼을 추가해(또는 memo 대신 명시적 링크) 삭제 시 `UPDATE recurring_invoices SET last_generated = (해당 회차 직전 회차 또는 NULL)` 로 되돌리고, transactions 삭제에서도 `recurring_id`가 있으면 recurring_expenses.last_generated를 동일하게 되돌린다. 최소한 삭제 시 '이 회차는 다시 자동 생성되지 않습니다' 경고라도 응답에 실어야 한다.

---

### DEL-02 · `C:/Users/USER/Desktop/Project/public/focus-accounter/server/routes/transactions.js:224`

**세금 납부 거래를 거래내역에서 삭제하면 부가세·기타세액은 '납부 완료'로 남고 txn_id만 고아가 된다**

- 영역: delete-integrity / 판정: CONFIRMED

**근거**

`vat_filings.txn_id`(db.js:635)와 `other_taxes.txn_id`(db.js:639)는 `ensureColumn`으로 ADD COLUMN 된 컬럼이라 **FK가 없다**. 따라서 `transactions.js:224` 의 DELETE는 FK 위반 없이 그대로 성공한다(238행의 ER_ROW_IS_REFERENCED_2 → 409 변환도 발동하지 않는다).
삭제 로직은 invoice_matches만 정리(231행)하고 vat_filings/other_taxes는 조회조차 하지 않는다.
한편 조회 쪽 `tax.js:73` 은 `status: f.status || '납부 대기'` 로 **저장된 status를 그대로** 내보낸다(급여의 payStatus처럼 거래에서 파생 계산하지 않는다).

**시나리오**

2026년 1분기 부가세를 '납부 완료'로 처리 → tax.js:104 syncTaxTxn이 category '부가세 납부' 지출 거래를 만들고 vat_filings.status='납부 완료', txn_id=T1 저장. 경리가 거래내역 화면에서 이 T1을 중복으로 오인해 삭제 → 계좌 잔액은 부가세만큼 원복되지만 부가세 탭은 여전히 '납부 완료 / 납부액 xxx원'으로 표시된다. 실제로는 납부 기록(자금 흐름)이 없는데 완납으로 보이고, 사용자가 알아챌 단서가 화면 어디에도 없다. 기타세액(원천세 등)도 동일.

**수정 방향**

transactions DELETE에서 `vat_filings`/`other_taxes`의 txn_id를 조회해 있으면 status를 '납부 대기'로 되돌리고 txn_id=NULL 처리(같은 트랜잭션 안에서). 또는 두 컬럼에 FK를 걸어 삭제를 409로 막는 편이 더 안전하다.

---

### DEL-03 · `C:/Users/USER/Desktop/Project/public/focus-accounter/server/routes/vendors.js:51`

**거래처 삭제는 FK 위반을 409로 바꾸지 않아 500이 새고, 화면은 실패했는데도 '삭제됐어요'라고 알린다**

- 영역: delete-integrity / 판정: CONFIRMED

**근거**

`vendors.js:51-56` 은 `catch (e) { next(e) }` 뿐이다. vendors를 RESTRICT로 참조하는 FK는 contracts.vendor_id(db.js:111), invoices.vendor_id(144), transactions.vendor_id(195), recurring_expenses.vendor_id(217), recurring_invoices.vendor_id(238), expense_resolutions.vendor_id(377) 로 6개다. 하나라도 걸리면 errno 1451 → `server/index.js:88-90` 의 공통 핸들러가 **500 '처리 중 오류가 발생했어요'** 를 반환한다.
같은 상황을 `employees.js:70-72`, `accounts.js:79-81` 은 409 + 안내 문구로 변환해두었는데 vendors만 빠져 있다.
게다가 `src/lib/api.js:709-714` deleteVendor는 에러를 삼켜 `{ok:false}`를 돌려주는데, `src/screens/Master.jsx:855-859` handleDelete는 결과를 보지 않고 `toast.push(`${v.name} 삭제됐어요`)` 를 무조건 띄운다.

**시나리오**

기준정보 > 업체에서 거래 이력이 있는 '정밀가공(주)'를 삭제 → 서버는 1451로 500 반환 → 화면에는 '정밀가공(주) 삭제됐어요' 토스트가 뜨지만 load() 후 목록에 그대로 남아 있다. 사용자는 삭제됐다고 믿고 넘어가거나, 왜 안 지워지는지 모른 채 반복 시도한다.

**수정 방향**

vendors DELETE에 `if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.errno === 1451) return res.status(409).json({error:'거래·계약·청구 이력이 있는 거래처는 삭제할 수 없어요'})` 를 추가하고, api.deleteVendor가 `e.error`를 전달하도록 한 뒤 Master.jsx handleDelete가 `res.ok`를 확인해 실패 메시지를 띄우게 한다.

---

### D-01 · `server/routes/contracts.js:279`

**청구일정 발행이 청구서 발행일·정산 거래일을 UTC(new Date().toISOString())로 찍어 KST 00~09시엔 하루 전 날짜로 저장된다**

- 영역: date-kst / 판정: CONFIRMED

**근거**

`const today = new Date().toISOString().slice(0, 10)` — toISOString은 프로세스 TZ와 무관하게 항상 UTC 달력일이라 KST 00:00~08:59 사이엔 어제가 나온다. 이 값이 (a) invoices INSERT의 issued_at(296행), (b) 기입금 거래의 date 폴백 `date || today`(305행), (c) 청구번호 연도 `today.slice(0,4)`(280행)에 모두 쓰인다. 같은 파일 259행은 `futureDateError(date)`(= kstToday 기준)로 검증하면서 저장은 UTC 기준이라 판정 기준 자체가 어긋나 있다. 359행 progress-invoice의 `today`도 동일(issued_at 폴백). 프런트(src/screens/Contract.jsx:923, src/screens/Billing.jsx:755)는 paid=false일 때 date를 아예 안 보내고 발행일 입력란도 없어 사용자가 확인할 방법이 없다.

**시나리오**

KST 2026-07-01 05:00에 대금청구 '발행 예정'에서 청구서를 발행한다 → UTC는 아직 2026-06-30 → invoices.issued_at = '2026-06-30'. tax.js:47의 `QUARTER(issued_at)`가 Q3가 아닌 Q2로 집계해 3분기 매출세액이 2분기로 넘어간다. 화면 어디에도 발행일 입력이 없어 경리는 알아채지 못한다. 1/1 새벽이면 청구번호도 '청구-2025-xxxx'로 채번된다.

**수정 방향**

contracts.js에서 `require('../db')`의 kstToday()를 import해 279행·359행의 `new Date().toISOString().slice(0,10)`를 `kstToday()`로 교체(invoices.js:198·payroll.js:247과 동일 처리).

---

### D-03 · `src/screens/Billing.jsx:464`

**청구서 수동 등록 폼이 발행일을 UTC로 채워, KST 새벽엔 하루 전 날짜와 (연초엔) 전년도 청구번호로 저장된다**

- 영역: date-kst / 판정: CONFIRMED

**근거**

`issued_at: editInvoice ? editInvoice.issuedAt : new Date().toISOString().slice(0, 10)` — 이 파일은 이미 localDate()(62행, 로컬 달력 기준)를 정의해 effStatus(72행)·PaidIssueDrawer(890행)에서 쓰고 있는데 여기만 UTC를 쓴다. 폼에는 발행일 입력이 없고(327행은 상세 '읽기'용 표시), 이 issued_at이 그대로 POST /invoices로 가서 server/routes/invoices.js:102의 `const year = String(issued_at||'').slice(0,4)`로 청구번호 연도까지 결정한다.

**시나리오**

KST 2027-01-01 06:00에 대금청구서 화면에서 '청구서 발행'으로 새 청구서를 등록 → UTC 2026-12-31 → issued_at='2026-12-31', invoice_no='청구-2026-00NN'. 2027년 첫 청구서가 2026년 장부·2026년 번호대에 들어가고, 부가세도 2026 Q4로 집계된다.

**수정 방향**

464행을 `localDate()`(같은 파일 62행) 또는 ui.jsx의 localToday()로 교체.

---

### D-04 · `src/screens/Docs.jsx:12`

**지출결의서의 지급예정일·집행일 기본값이 UTC라, 결의서 처리로 만들어지는 지출 거래가 하루 전 날짜로 기록된다**

- 영역: date-kst / 판정: CONFIRMED

**근거**

12행 `const todayStr = () => new Date().toISOString().slice(0, 10)`. 이 값이 335행 새 결의서 기본 pay_date, 469행 ProcessDrawer의 `useState(todayStr())`, 477행 `setDate(doc.pay_date || todayStr())`에 쓰인다. 이 date는 api.processResolution → server/routes/resolutions.js:198 `const effDate = date || r.pay_date || kstToday()`를 거쳐 207~211행 expense 거래의 date로 그대로 INSERT된다. 같은 파일 2행에서 KST 기준 localToday()를 이미 import해 537행 `max={localToday()}`에만 쓰고 있어, 입력칸은 max만 오늘이고 값은 어제인 상태가 된다(브라우저는 유효값이라 경고 없음).

**시나리오**

KST 2026-08-01 08:00에 결의서 목록에서 '처리' → 드로어의 지출일이 2026-07-31로 채워진 채 열리고, 그대로 확인하면 8월 지출이 7월 지출로 기록된다. 7월 지출결의 마감·월별 손익·부가세 기간이 조용히 틀어진다.

**수정 방향**

12행 todayStr를 삭제하고 이미 import된 localToday()로 335·469·477행을 통일.

---

### E-01 · `server/routes/vendors.js:51`

**거래처 삭제가 FK로 막혀도 500만 나가고, 화면은 "삭제됐어요"라고 알린다**

- 영역: error-handling / 판정: CONFIRMED

**근거**

vendors.js DELETE는 에러 매핑이 전혀 없다:
```js
router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM vendors WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }   // ← ER_ROW_IS_REFERENCED_2 그대로 통과
})
```
vendors(id)는 db.js에서 contracts:111 / invoices:144 / transactions:195 / recurring_expenses:217 / recurring_invoices:238 / expense_resolutions:377 이 모두 ON DELETE 절 없이(=RESTRICT) 참조한다. 같은 상황을 accounts.js:79와 employees.js:70은 `if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.errno === 1451) return res.status(409)…` 로 처리하는데 vendors만 빠져 있다. next(e)는 index.js:88 핸들러로 가서 `res.status(500).json({ error: '처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' })`가 된다.
프론트도 두 번 더 정보를 버린다 — src/lib/api.js:713 `catch(e) { return { ok: false } }` (메시지 폐기), src/screens/Master.jsx:855-859 `await api.deleteVendor(v.id); toast.push(`${v.name} 삭제됐어요`); load()` (반환값을 아예 안 본다).

**시나리오**

기준정보 > 거래처에서 거래내역이 한 건이라도 있는 업체(예: (주)한빛문구) 행의 [삭제] 버튼(Master.jsx:922)을 누른다. 서버는 MySQL 1451로 실패해 500을 반환하지만 화면에는 "(주)한빛문구 삭제됐어요" 토스트가 뜨고, 바로 이어 도는 load()로 목록이 갱신되면 그 업체가 그대로 남아 있다. 사용자는 삭제가 왜 안 됐는지도, 실패했다는 사실조차 안내받지 못하고 같은 버튼을 반복해서 누른다.

**수정 방향**

vendors.js DELETE의 catch에 accounts.js:79와 동일한 ER_ROW_IS_REFERENCED_2/errno 1451 → 409 + "거래·청구·계약 이력이 있는 거래처는 삭제할 수 없어요" 매핑을 추가한다(가능하면 accounts.js:64처럼 사전 참조 카운트 체크도). 함께 api.js:709 deleteVendor가 `{ ok:false, error: e.message }`를 돌려주게 하고, Master.jsx:855 handleDelete가 `if (!res.ok) return toast.push(res.error)` 로 결과를 확인하도록 고친다.

---

## P2 (16건)

### BAL-05 · `src/screens/Master.jsx:1678`

**정기지출 등록 폼이 필수값(start_date)·거래처ID·계좌를 안 보내 저장이 실패하는데 성공 토스트를 띄운다**

- 영역: balance-reconcile / 판정: CONFIRMED (P1→P2 조정)

**근거**

RecurringFormDrawer 의 form 은 `{ vendor, category, amount, period, dayOfMonth }` 뿐이고(1671행) onSave 도 그대로 넘긴다(1678행). api.addRecurringExpense(src/lib/api.js:426-437)는 `vendor_id: data.vendorId`(undefined), `start_date: data.startDate`(undefined), `account_id: data.accountId`(undefined) 를 보낸다. 서버 recurring.js:26 은 `start_date` 를 그대로 바인딩하는데 recurring_expenses.start_date 는 `VARCHAR(20) NOT NULL`(server/db.js:211)이고 mysql2 는 undefined 바인딩을 거부한다. 호출부(Master.jsx:1781)는 `await api.addRecurringExpense(data)` 의 반환값을 확인하지 않고 무조건 "정기 지출이 등록됐어요" 토스트를 띄운다(api 래퍼는 실패를 {ok:false}로 삼킨다).

**시나리오**

기준정보 > 정기 지출 > 등록에서 거래처·비목·금액을 입력하고 저장 → 성공 토스트가 뜨지만 목록에는 아무것도 추가되지 않는다(요청은 500/에러로 실패). 사용자가 입력한 거래처 이름도 vendor_id 로 매핑되지 않아 어차피 유실된다.

**수정 방향**

폼에 시작일(기본 오늘)·거래처 Combobox(vendorId)·출금 계좌(accountId)를 추가하고, onSave 결과 `res.ok` 를 확인해 실패 시 오류 토스트를 띄운다. 서버 POST /recurring-expenses 에도 start_date 누락 시 400 검증을 추가한다.

---

### BAL-07 · `server/routes/contracts.js:279`

**청구서 발행일·정산 거래일 기본값이 UTC라 KST 새벽에는 하루 전 날짜로 기록된다**

- 영역: balance-reconcile / 판정: UNVERIFIED

**근거**

`const today = new Date().toISOString().slice(0, 10)` 로 issued_at·채번 연도·기입금 거래 date 기본값을 정한다(contracts.js:279-280, 296, 305). 같은 패턴이 contracts.js:359(progress-invoice), work-contracts.js:375·398, tax.js:22 에도 있다. 프로젝트 규약은 KST(kstToday/kstDate)이고, invoices.js:198 은 같은 자리에 이미 `date || kstToday()` 를 쓰며 "UTC(new Date())면 KST 새벽에 하루 전으로 찍힌다"고 주석까지 달려 있다. futureDateError 도 KST 기준이라 UTC 기본값은 검증에 걸리지도 않는다.

**시나리오**

KST 3월 1일 오전 7시에 청구 일정에서 청구서를 발행하면 issued_at 이 2월 28일로 저장된다 → 부가세 분기 집계(QUARTER(issued_at))·월별 매출 추이·계약 이번 텀 청구액(term_billed, issued_at >= current_term_start)이 한 달/한 분기 앞쪽으로 잘못 귀속된다.

**수정 방향**

해당 지점들의 `new Date().toISOString().slice(0,10)` 을 server/db.js 의 kstToday() 로 교체한다.

---

### TX-01 · `server/routes/resolutions.js:129`

**결의서 생성이 트랜잭션 커넥션을 쥔 채 req.db로 두 번째 커넥션을 요구 — 테넌트 풀(3개) 고갈 시 영구 대기**

- 영역: transaction-connection / 판정: CONFIRMED (P1→P2 조정)

**근거**

POST /from-invoice/:invoiceId 는 83행에서 `const conn = await req.db.getConnection()` 으로 커넥션을 잡고, finally(132행)까지 놓지 않는다. 그런데 커밋 직후 129행에서 같은 풀에 두 번째 커넥션을 요청한다:

```
    await conn.commit()                                    // 128
    const [[created]] = await req.db.execute('SELECT * FROM expense_resolutions WHERE id = ?', [id])  // 129 ← conn 이 아니라 req.db
    res.json(adapt(created))
  } catch (e) { await conn.rollback(); next(e) }
  finally { conn.release() }                               // 132
```

테넌트 풀은 `CONN_LIMIT = 3`(db/poolManager.js:20)이고 `waitForConnections: true` + queueLimit 무제한(poolManager.js:89-90)이며 mysql2 풀에는 획득 타임아웃이 없다. 같은 핸들러 3건이 동시에 129행에 도달하면 3개 커넥션을 각자 붙잡은 채 4번째를 기다리므로 아무도 진행하지 못한다. 이 파일 안에서 유일하게 conn 을 쥔 상태로 req.db 를 다시 쓰는 지점이다(다른 트랜잭션 라우트는 전부 conn 으로만 질의).

**시나리오**

미지급 청구서 목록에서 '지급결의서 만들기'를 여러 건 연속 클릭(또는 응답이 늦어 사용자가 재시도)해서 POST /api/resolutions/from-invoice/... 3건이 동시에 처리되면, 세 요청 모두 129행에서 커넥션을 기다리며 영구 정지한다. 커넥션 3개가 그대로 묶여 그 회사의 이후 모든 API 요청(대시보드·거래내역 등)도 응답하지 않고, 서버를 재시작해야 풀린다.

**수정 방향**

129행을 `conn.execute(...)` 로 바꾸거나(커밋 이후에도 같은 커넥션으로 읽으면 된다), 이미 메모리에 있는 값으로 응답을 조립해 추가 조회 자체를 없앤다. 트랜잭션 커넥션을 쥔 구간에서는 req.db 를 쓰지 않는다는 규칙을 규약에 추가할 것.

---

### TX-05 · `server/routes/payroll.js:93`

**읽기 전용 목록 API가 커넥션 1개를 N+1 루프 내내 점유 — 테넌트 풀(3개)을 쉽게 소진**

- 영역: transaction-connection / 판정: UNVERIFIED

**근거**

```
router.get('/', async (req, res, next) => {
  const conn = await req.db.getConnection()      // 93
  ...
  const out = []
  for (const p of rows) out.push(await enrich(conn, p))   // 103 — 행마다 SELECT 1회
  ...
} catch (e) { next(e) } finally { conn.release() }        // 105
```
쓰기도 트랜잭션도 없는 순수 조회인데 전용 커넥션을 통째로 잡는다. `?month` 없이 호출하면 payroll 전 행을 훑으므로 점유 시간이 행 수에 비례한다. 같은 모양: payroll.js:110(/summary), payroll.js:138(/employee/:id), work-contracts.js:102(목록 — 행마다 withMetrics), work-contracts.js:150(상세). 테넌트 풀 한도는 3(poolManager.js:20)이라 이 계열 요청 3건이면 그 회사의 나머지 모든 쿼리가 대기한다.

**시나리오**

인사관리 화면 진입 시 급여대장 목록·용역계약 목록·계약 상세가 동시에 뜬다. 직원 20여 명 × 12개월치 급여 행이면 세 요청이 각각 수십 번의 왕복 동안 커넥션 3개를 모두 점유하고, 그 사이 같은 회사의 대시보드·거래내역 요청은 큐에서 대기해 화면이 멈춘 것처럼 보인다.

**수정 방향**

이 조회들은 `req.db.execute` 로 바꾸고(풀이 쿼리 단위로 커넥션을 빌려준다), enrich/withMetrics 의 N+1은 payroll_id/work_contract_id 로 한 번에 GROUP BY 집계하는 단일 쿼리로 합친다.

---

### TX-06 · `server/db/poolManager.js:61`

**conn.release() 시 entry.lastUsed를 갱신하지 않아, 긴 트랜잭션을 마친 풀이 곧바로 회수 대상이 된다**

- 영역: transaction-connection / 판정: UNVERIFIED

**근거**

execute/query 경로의 track()은 쿼리가 끝난 시점에도 lastUsed 를 갱신한다(37-44행, 주석에 그 이유가 명시돼 있다). 그런데 getConnection 경로는 그렇지 않다:
```
      conn.release = () => {
        if (released) return
        released = true
        entry.inFlight--      // ← lastUsed 갱신 없음
        release()
      }
```
트랜잭션이 시작될 때 찍힌 lastUsed 가 그대로 남으므로, 트랜잭션이 EVICT_GRACE_MS(30초)보다 오래 걸리면 release 직후 `inFlight === 0 && now - lastUsed >= 30s` 가 되어 evictIfNeeded(104-117행)의 회수 후보가 된다. req.db 는 요청 수명 동안 그 풀 래퍼를 계속 들고 있으므로(middleware/tenant.js:23), 같은 요청의 뒤이은 쿼리가 "Pool is closed" 로 실패한다 — 주석이 막으려던 바로 그 시나리오다. 지금은 MAX_POOLS=30 이고 상주 테넌트가 2곳뿐이라 evictIfNeeded 가 조기 반환하므로 도달하지 않는다(잠복).

**시나리오**

회사가 30곳을 넘어 풀 회수가 실제로 도는 상황에서, 엑셀 일괄 임포트(transactions.js:260 /import/commit)처럼 수백 행을 도는 트랜잭션이 40초 걸린 뒤 release 된다. 곧이어 다른 회사 요청이 evictIfNeeded 를 호출하면 방금 끝난 그 회사의 풀이 '30초 넘게 안 쓴 풀'로 오인돼 닫히고, 같은 요청의 후속 쿼리나 직후 요청이 Pool is closed 로 500이 난다.

**수정 방향**

release 패치에서 `entry.inFlight--` 와 함께 `entry.lastUsed = Date.now()` 를 찍는다(track()과 동일하게). 겸사겸사 getConnection 진입 시에도 lastUsed 를 갱신하면 대기 구간까지 커버된다.

---

### DEL-04 · `C:/Users/USER/Desktop/Project/public/focus-accounter/server/routes/transactions.js:217`

**첨부 삭제 라우트가 DB 행만 지우고 uploads/{companyId}/ 의 실제 파일은 영구히 남긴다**

- 영역: delete-integrity / 판정: UNVERIFIED

**근거**

첨부를 지우는 라우트는 모두 DELETE 문 한 줄뿐이다 — `transactions.js:217-222`(transaction_docs), `invoices.js:291-296`(invoice_docs), `contracts.js:829-834`(contract_docs), `work-contracts.js:331-336`(work_contract_docs). 어느 것도 fs.unlink를 부르지 않는다.
부모 삭제 경로는 더하다: `invoices.js:138` 은 invoice_docs 행을 지우고, transactions/contracts/work_contracts 삭제는 FK ON DELETE CASCADE(db.js:324, 336, 568, 579)로 자식 행이 통째로 사라지는데 파일은 하나도 지워지지 않는다. `contracts.js:846-851` clear-file, `ref-items.js:51-56`(ref_items.file_url, db.js:678)도 동일.
서버 전체에 파일 삭제 코드가 없다(`files.js`는 GET 서빙만, `uploads.js`는 POST 저장만).

**시나리오**

세금계산서 PDF를 잘못 올려 삭제 → DB에서는 사라지지만 uploads/{companyId}/1753xxxx_invoice.pdf 는 그대로 남는다. `files.js:24` 는 companyId만 대조하고 DB 참조 여부는 보지 않으므로, 파일명을 아는 사람(브라우저 히스토리·로그·이전 화면 캡처)은 삭제된 증빙을 계속 내려받을 수 있다. 운영 기간이 길어질수록 디스크에 고아 파일이 무한 축적된다.

**수정 방향**

docs 삭제 시 url에서 파일명을 뽑아 `path.resolve(UPLOAD_ROOT, companyId)` 아래인지 검증한 뒤 fs.unlink(실패는 무시). 부모 CASCADE 삭제 경로에서는 삭제 전에 자식 url 목록을 SELECT 해두고 커밋 후 unlink 한다. 최소한 고아 파일을 주기적으로 정리하는 스크립트라도 필요하다.

---

### DEL-05 · `C:/Users/USER/Desktop/Project/public/focus-accounter/server/routes/ref-items.js:51`

**품목 기준정보를 삭제하면 이미 기록된 거래의 품목명이 조용히 빈칸이 된다(item_id에 FK 없음)**

- 영역: delete-integrity / 판정: UNVERIFIED

**근거**

`ref-items.js:51-56` 은 참조 검사 없이 `DELETE FROM ref_items WHERE id=?` 만 실행한다.
`transactions.item_id`(db.js:653, ensureColumn으로 추가 → FK 없음)는 조회 시 `transactions.js:50` / `transactions.js:93` 의 `LEFT JOIN ref_items ri ON t.item_id = ri.id` 로 `ri.name AS item_name` 을 뽑아 쓴다. 거래에 품목명 스냅샷이 저장돼 있지 않으므로 기준정보가 사라지면 item_name이 NULL이 된다.
`analytics.js:19` 의 '품목별' 집계도 `label: 'MAX(ri.name)'`, `join: 'LEFT JOIN ref_items ri ON t.item_id = ri.id'` 라 같은 방식으로 라벨이 비어버린다.
(대조: contract_items·invoice_lines·work_contract_items는 name/spec/unit을 스냅샷으로 복사해두므로 영향 없다 — db.js:466-499, 556-569 주석 참조.)

**시나리오**

기준정보 > 품목에서 더 이상 쓰지 않는 'SUS304 플랜지'를 정리 삭제 → 그 품목으로 등록해둔 과거 지출 거래 수십 건의 품목 칸이 전부 빈칸이 된다. 경영 도우미의 '품목별' 차트에서도 해당 막대의 라벨이 사라진다. 삭제 시 경고가 없어 되돌릴 방법도 없다.

**수정 방향**

ref-items DELETE에서 type='item'인 경우 transactions.item_id 참조 건수를 세어 있으면 409로 막거나 소프트 삭제(active=0)로 전환한다. 또는 거래 등록 시 품목명을 transactions에 스냅샷으로 함께 저장한다.

---

### DEL-06 · `C:/Users/USER/Desktop/Project/public/focus-accounter/server/routes/accounts.js:60`

**계좌 삭제 가드가 ref_items·vat_filings·other_taxes의 account_id를 세지 않아 고아 참조가 남는다**

- 영역: delete-integrity / 판정: UNVERIFIED

**근거**

`accounts.js:64-71` 의 가드는 transactions / invoices / recurring_expenses / recurring_invoices 네 테이블만 센다. 이 네 개는 db.js에서 실제 FK가 걸려 있어(197, 146, 219, 240) 어차피 DB가 막아준다.
정작 FK가 **없는** 참조 3개가 빠져 있다 — `ref_items.account_id`(db.js:677, 보험 자동이체 계좌. `src/screens/Master.jsx:225` 에서 '자동이체 계좌'로 편집), `vat_filings.account_id`(db.js:636), `other_taxes.account_id`(db.js:640). FK가 없으니 삭제가 그대로 성공하고 참조만 남는다.

**시나리오**

보험(사업장 화재보험)의 자동이체 계좌로 지정해둔 시제통장을 계좌 목록에서 삭제. 그 계좌로 나간 거래가 아직 없으면 refCnt=0이라 가드를 통과해 삭제된다 → 보험 기준정보의 '자동이체 계좌'는 존재하지 않는 id를 가리킨 채 화면에서는 빈칸으로 보이고, 부가세 탭의 납부 계좌 선택도 조용히 초기화된다. 사용자는 어느 계좌였는지 알 수 없다.

**수정 방향**

가드 서브쿼리에 `ref_items`, `vat_filings`, `other_taxes` 의 account_id 참조 수를 추가하거나, 세 컬럼에 FK를 걸어 DB가 막게 한다(그 경우 기존 catch의 409 변환이 그대로 동작한다).

---

### D-02 · `server/routes/work-contracts.js:398`

**용역·일용 지급 발행에서 payroll 월과 지출 거래일 폴백이 UTC라 KST 새벽엔 하루 전(월초면 전월 회차)으로 기록된다**

- 영역: date-kst / 판정: PLAUSIBLE (P1→P2 조정)

**근거**

398행 `date || pay_date || new Date().toISOString().slice(0, 10)` — 실제 돈이 나간 expense 거래(status '지급완료', 계좌 잔액에 반영)의 date다. 375행 `const m = month || (date || pay_date || new Date().toISOString().slice(0,10)).slice(0, 7)`은 payroll 회차의 month(=급여대장 귀속 월, seq 채번 기준 377행)를 정한다. 이 파일은 3행에서 futureDateError만 가져오고 kstToday는 import하지 않았다 — 같은 세션에서 payroll.js:247은 이미 `date || kstToday()`로 고쳐졌는데 이 경로만 남았다.

**시나리오**

KST 2026-08-01 07:00에 용역계약 상세에서 '지급 발행'을 month·date·pay_date 없이 실행(프런트가 값을 안 채운 필드가 있으면 폴백 발동) → UTC는 2026-07-31 → payroll.month='2026-07'로 7월 회차가 하나 더 생기고, 지출 거래도 7-31자로 들어가 8월 급여/용역비 집계와 원천세 신고월이 어긋난다.

**수정 방향**

`const { futureDateError, kstToday } = require('../db')`로 바꾸고 375·398행의 UTC 폴백을 kstToday()로 교체.

---

### D-05 · `server/routes/tax.js:22`

**세금 납부/환급 거래의 납부일 폴백이 UTC라, 납부일을 비워두고 완료 처리하면 하루 전 지출·입금 거래가 생성된다**

- 영역: date-kst / 판정: UNVERIFIED

**근거**

syncTaxTxn 22행 `const d = date || new Date().toISOString().slice(0, 10)` — 이 d가 30행 UPDATE·38행 INSERT의 transactions.date다. 92행 futureDateError(paid_date)는 `paid_date &&` 가드 때문에 빈 값이면 통과하므로 폴백이 실제로 발동한다. 이 파일은 3행에서 futureDateError만 import하고 kstToday는 안 가져온다. 같은 계열의 남은 UTC 폴백: server/routes/resolutions.js:21(문서번호 DJ-YYYY 채번 연도), server/routes/invoices.js:72(부가세 요약 기본 연도), server/routes/payroll.js:112(급여 요약 기본 월).

**시나리오**

KST 2026-10-01 07:00에 부가세 화면에서 3분기 상태를 '납부 완료'로 바꾸며 납부일을 비워둔 채 저장 → UTC 2026-09-30 → 부가세 납부 지출 거래가 9-30자로 생성돼 9월 비용으로 잡힌다. resolutions.js:21은 같은 시각에 결의서를 만들면 DJ-2025-0001처럼 전년도 번호대로 채번된다(연초 새벽).

**수정 방향**

tax.js도 kstToday를 import해 22행 폴백을 kstToday()로 바꾸고, resolutions.js:21·invoices.js:72·payroll.js:112의 UTC 폴백도 kstToday()/kstToday().slice(0,7) 기준으로 통일.

---

### D-06 · `src/lib/api.js:1158`

**미수금·미지급금·홈 대시보드의 '이번 달' 집계 기준월이 UTC라 매월 1일 새벽엔 전월을 집계한다**

- 영역: date-kst / 판정: UNVERIFIED

**근거**

getReceivables 1158행 `const month = new Date().toISOString().slice(0, 7)`, getPayables 1194행, getHomeStats 980행, getMonthCashFlow 994행이 모두 동일. 이 month로 1176·1183행 `r.due.startsWith(month)`를 걸러 '이번 달 입금/지급 예정' 금액·건수 타일을 만든다. 같은 함수의 today는 1157행에서 `new Date(); setHours(0,0,0,0)`(로컬=KST)로 잡아 놓고 month만 UTC라 한 함수 안에서 기준일이 갈린다. 프런트에는 이미 localToday()(src/lib/ui.jsx:16)가 있다.

**시나리오**

KST 2026-09-01 08:00에 홈/미수금 화면을 연다 → month='2026-08' → '이번 달 입금 예정' 타일이 9월분이 아니라 이미 지난 8월 만기 건들을 합산해 보여준다. 숫자만 보이고 어느 달인지 표기가 없어 오판하기 쉽다.

**수정 방향**

1158·1194·980·994행을 `localToday().slice(0, 7)`로 교체(ui.jsx의 localToday를 api.js에서 import하거나 동일한 로컬 달력 헬퍼를 api.js에 두고 재사용).

---

### D-07 · `src/screens/Master.jsx:1928`

**정기청구·정기지출의 '다음 청구/다음 생성' 미리보기가 JS Date 월 오버플로로 서버가 실제 생성하는 회차 날짜와 다르게(달을 건너뛰며) 표시된다**

- 영역: date-kst / 판정: UNVERIFIED

**근거**

1926~1928행 `let d = new Date(sy, sm-1, rec.dayOfMonth || 1)` … `while (d <= today) d = new Date(d.getFullYear(), d.getMonth() + step, rec.dayOfMonth || 1)` — dayOfMonth가 그 달 말일보다 크면 JS Date가 다음 달로 넘겨버리고, 넘어간 d에서 다시 getMonth()+step를 하므로 드리프트가 누적된다. 서버는 server/lib/recurrence.js:55 `const day = Math.min(anchorDay, daysInMonth(y, m))`로 말일 clamp를 하도록 이미 공용화돼 있는데(파일 상단 주석 2~3행이 바로 이 오버플로 누적 버그를 고친 기록) 프런트 미리보기만 옛 로직으로 남았다. 1733~1741행 정기지출 nextDate도 동일한 `new Date(y, m, rec.dayOfMonth)` 오버플로.

**시나리오**

startDate 2026-01-31, 매월, 청구일 31일인 정기청구를 등록하면 기준정보 목록의 '다음 청구'가 Jan31 → new Date(2026,1,31)=3월 3일 → new Date(2026,3,31)=5월 1일처럼 2·4월을 통째로 건너뛴 날짜를 보여준다. 서버 dueDatesToGenerate는 01-31, 02-28, 03-31, 04-30을 생성하므로 화면의 다음 청구일과 실제 발행 예정 회차가 어긋난다.

**수정 방향**

Master.jsx의 두 nextDate를 server/lib/recurrence.js와 같은 규칙(절대 월 i*step 재계산 + `Math.min(anchorDay, 그 달 말일)` clamp)으로 바꾸거나, 서버 /recurring-invoices/pending·/recurring이 이미 계산한 다음 회차 값을 내려받아 표시.

---

### D-08 · `src/screens/Billing.jsx:16`

**청구서 목록 D-day 뱃지가 UTC 자정과 현재시각을 비교해, KST 21시 이후엔 만기 당일 건이 '+1일 초과'로 표시된다**

- 영역: date-kst / 판정: UNVERIFIED

**근거**

16행 `const diff = Math.round((new Date(due) - new Date()) / 86400000)` (24행 ddayTone도 동일). `new Date('2026-07-22')`는 UTC 자정으로 파싱되는데 `new Date()`는 현재 시각이라, 차이가 -(경과 UTC 시간)이 되고 12시간을 넘으면 Math.round가 -1로 떨어진다. 같은 파일 72행 effStatus는 `inv.dueAt < localDate()` 문자열 비교라 정상이므로, 상태 뱃지는 '입금 예정'인데 D-day 뱃지만 '초과'로 나오는 불일치가 생긴다.

**시나리오**

만기일이 오늘(2026-07-22)인 청구서를 KST 22:30에 조회 → UTC로는 07-22T13:30Z, diff=-13.5h/24h=-0.5625 → Math.round=-1 → 뱃지가 '오늘'이 아니라 '+1일 초과'(tone: neg)로 뜬다. 반대로 내일 만기 건은 '오늘'로 표시된다. 매일 21~24시 사이 3시간 동안 목록 전체의 D-day가 하루씩 밀린다.

**수정 방향**

16·24행을 문자열/로컬 달력 기준으로 계산: `const diff = Math.round((new Date(due + 'T00:00:00') - new Date(localDate() + 'T00:00:00')) / 86400000)` 처럼 양쪽 모두 로컬 자정으로 맞춘다(src/lib/renewal.js:52-58의 daysUntil이 쓰는 방식).

---

### E-02 · `server/index.js:88`

**전역 에러 핸들러가 err.status를 무시해, multer의 20MB 초과 같은 입력 오류까지 500 일반 메시지로 뭉갠다**

- 영역: error-handling / 판정: UNVERIFIED

**근거**

```js
app.use((err, req, res, _next) => {
  console.error(`[500] ${req.method} ${req.originalUrl}`, err)
  res.status(500).json({ error: '처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' })
})
```
무조건 500이다. 바로 위 주석은 "여기까지 온 것은 SQL 오류·TypeError 같은 내부 오류"라고 전제하지만 실제로는 아니다. routes/uploads.js:25-33의 `multer({ storage, limits: { fileSize: 20*1024*1024 } })`는 한도 초과 시 `MulterError('LIMIT_FILE_SIZE')`를 next(err)로 넘기고, uploads.js:13 `cb(new Error('회사 정보가 없어 업로드할 수 없습니다'))`도 마찬가지다. 둘 다 err.status/err.code가 붙어 있는데 핸들러가 무시한다. (vendors.js:7·transactions.js:8의 uploadMem 20MB 한도도 동일 경로.)
클라이언트는 한 번 더 버린다 — src/lib/api.js:363 `if (!res.ok) throw new Error('upload failed')` 로 응답 본문을 읽지도 않는다. 그 결과 src/lib/FileAttach.jsx:44는 이유 없는 `'파일명' 업로드에 실패했어요`만 표시한다(드롭존 안내문 hint는 "최대 20MB"라고 적혀 있는데 실제 초과 시 그 사실을 알려주지 못한다).

**시나리오**

거래 등록 폼이나 계약 증빙 탭에서 25MB짜리 스캔 PDF를 드롭한다. 서버는 500 + "처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요."를 주고, 화면에는 "'계약서_스캔.pdf' 업로드에 실패했어요"만 뜬다. "잠시 후 다시"라는 안내를 믿고 몇 번을 다시 시도해도 같은 결과다 — 파일이 큰 게 원인이라는 신호가 어디에도 없다.

**수정 방향**

index.js:88 핸들러를 `const code = err.status || err.statusCode; if (code && code < 500) return res.status(code).json({ error: err.expose ? err.message : '요청이 올바르지 않아요' })` 형태로 4xx를 통과시키고, uploads.js의 `upload.single('file')` 뒤에 라우터 전용 에러 핸들러를 두어 `err.code === 'LIMIT_FILE_SIZE'` → 400 "파일이 너무 커요(최대 20MB)"로 변환한다. api.js:353 uploadFile도 req()처럼 `res.json()`의 error 본문을 읽어 그대로 던지게 한다.

---

### E-03 · `src/lib/api.js:346`

**거래 삭제 실패 사유(지급결의서·급여 연결)를 서버가 409로 만들어 놨는데 화면까지 전달되지 않는다**

- 영역: error-handling / 판정: UNVERIFIED

**근거**

서버는 친절한 메시지를 준비해 뒀다 — transactions.js:238-240:
```js
if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.errno === 1451) {
  return res.status(409).json({ error: '지급결의서·급여에 연결된 거래라 삭제할 수 없어요' })
}
```
그런데 클라이언트가 버린다 — src/lib/api.js:346-351:
```js
async deleteTransaction(id) {
  try { await req(`/transactions/${id}`, { method: 'DELETE' }); return { ok: true } }
  catch { return { ok: false } }   // ← e를 받지도 않는다
}
```
그리고 src/screens/Ledger.jsx:424 `else toast.push("삭제에 실패했어요")`. 공통 래퍼 req()(api.js:25-29)는 본문의 error를 제대로 꺼내 던지는데, 그 위 계층에서 무조건 폐기되는 구조다. 같은 패턴이 api.js 전반에 30곳 이상 있고(203·270·308·343·350·790·891 등), 그중 서버가 4xx 안내문을 갖춘 것은 employees.js:71 "급여·계약·거래 이력이 있는 직원은 삭제할 수 없어요"(api.js:790), payroll·work-contracts 등이다.

**시나리오**

지급결의서를 발행해 처리한 지출 거래를 거래내역 상세에서 삭제하려 한다. 확인 다이얼로그(Ledger.jsx:420)까지 통과했는데 결과는 "삭제에 실패했어요" 한 줄뿐이다. 결의서를 먼저 지워야 한다는 것을 알 방법이 없어, 사용자는 원인을 못 찾고 같은 조작을 반복하거나 문의를 남긴다.

**수정 방향**

api.js의 `catch { return { ok:false } }` 패턴을 최소한 사용자가 버튼으로 직접 실행하는 삭제/저장 계열(deleteTransaction·deleteEmployee·deletePayroll·deleteWorkContract 등)에서 `catch (e) { return { ok:false, error: e.message } }` 로 바꾸고, 호출부는 `toast.push(res.error || '삭제에 실패했어요')` 로 서버 문구를 우선 노출한다.

---

### E-04 · `server/routes/tax.js:38`

**부가세·기타세액 '납부 완료' 저장 시 계좌 필수 검증이 서버에 없어, 계좌 없는 지출 거래가 그대로 만들어진다**

- 영역: error-handling / 판정: UNVERIFIED

**근거**

syncTaxTxn은 accountId가 비어도 아무 검사 없이 거래를 만든다:
```js
await db.execute(
  `INSERT INTO transactions (id, kind, account_id, category, amount, date, method, status, buyer_type, doc_no, memo, account_code)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [id, kind, accountId || null, category, amount, d, '계좌이체', status, '공통', '공통', memo, accountCode || null])
```
status는 '지급완료'/'입금완료'인데 account_id가 NULL이면 routes/accounts.js:10-11의 calcBalance가 `account_id=a.id` 로 묶어 합산하므로 어느 계좌 잔액에도 반영되지 않는다. 이번 세션에 resolutions.js(process의 link/create 두 분기)와 payroll.js:240이 정확히 이 이유로 `if (!account_id) return res.status(400)…` 가드를 받았는데 tax.js만 빠져 있다. 현재 막고 있는 것은 클라이언트뿐이다 — src/screens/Tax.jsx:55와 :273의 `if (isDone && !form.account_id) return toast.push(...)`. 서버는 PUT /api/tax/vat, POST/PUT /api/tax/others 어디에도 대응 검증이 없다.

**시나리오**

Tax.jsx의 클라이언트 가드가 사라지거나(예: accounts 로드 실패로 폼 상태가 초기화된 경우, 또는 리팩터링·다른 호출부 추가) 우회되면, `PUT /api/tax/vat`에 `{status:'납부 완료', paid_amount:3_500_000, account_id:null}` 이 들어가 account_id NULL인 '지급완료' 지출 거래가 생긴다. 거래내역에는 350만원 지출이 보이는데 계좌 잔액은 한 푼도 줄지 않아, 통장과 장부 잔액이 조용히 어긋난다(과거 F-02와 동일 유형).

**수정 방향**

tax.js PUT /vat(약 100행 syncTaxTxn 호출 직전)과 POST/PUT /others에 `if (isDone && amount > 0 && !account_id) return res.status(400).json({ error: '납부(환급) 계좌를 선택해주세요' })` 를 추가한다. 또는 syncTaxTxn 안에서 isDone && amount && !accountId 이면 명시적 400 에러를 던지게 해 세 호출부를 한 번에 막는다.

---

