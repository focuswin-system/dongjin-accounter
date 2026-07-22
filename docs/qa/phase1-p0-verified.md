# Phase 1 — P0 반증 검증 결과

> **작성**: 2026-07-22 / 에이전트 12개(6건 × refute·repro 2렌즈)
> **결과: 6건 전부 CONFIRMED, 반증 0건.** 심각도 재평가로 2건이 P1로 조정됨.

| 심각도 | 위치 | 요약 |
|---|---|---|
| **P0** | `server/routes/resolutions.js:195` | 지급결의서 '지출 새로 등록' 처리가 account_id NULL 로 지출 거래를 만들어 계좌 잔액에서 100% 누락된다… |
| **P0** | `server/routes/payroll.js:243` | 급여 지급 등록에서 출금 계좌를 고르지 않으면 transactions.account_id 가 NULL 로 들어가 어느 계좌 잔… |
| **P0** | `server/routes/invoices.js:177` | 기존 '지급 대기' 지출 거래를 매입 청구서에 연결하면 청구서만 '지급 완료'가 되고 거래 status 는 그대로라 계좌 잔액… |
| **P0** | `server/routes/transactions.js:126` | 거래 금액을 수정해도 invoice_matches.amount 와 청구서 상태가 갱신되지 않아 청구서 정산액이 옛 금액 그대로… |
| **P1** | `server/routes/resolutions.js:184` | 지급결의서 '기존 지출 연결'(mode=link)이 거래 status 를 '지급완료'로 바꾸지 않아, 결의서·청구서는 완료인데… |
| **P1** | `src/screens/Docs.jsx:1658` | '미수금 현황' 보고서가 실 API 를 조회하지 않고 빈 SAMPLE 상수를 읽어 미수금을 항상 0원으로 표시한다… |

---

## P0 · `server/routes/resolutions.js:195`

**지급결의서 '지출 새로 등록' 처리가 account_id NULL 로 지출 거래를 만들어 계좌 잔액에서 100% 누락된다**

**판정**: CONFIRMED (반증 0/2표)

### 검증 근거

**반증 시도(refute)**

반증 실패 — 지적을 무력화하는 코드를 어디에서도 찾지 못했다.

1) 서버 INSERT (server/routes/resolutions.js:192-197): `account_id || null` 로 그대로 들어가며, mode==='create' 분기 전체(185-198)에 계좌 필수 검증이 없다. 검증은 미래날짜(189)와 금액(190)뿐.
2) 유일한 호출자: src/lib/api.js:574 `processResolution` → src/screens/Docs.jsx:467 한 곳뿐(grep 결과 다른 호출자 없음). Docs.jsx:463-465 의 body는 `{ mode:'create', amount: amountNum, date }` 로 account_id를 보내지 않고, ProcessDrawer의 create 모드 UI(Docs.jsx:490-507)에는 계좌 선택 컨트롤이 아예 없다(금액·지출일 두 개뿐, 506행은 "거래처·지급방법으로 지출 거래가 생성됩니다" 안내문일 뿐). 따라서 account_id는 항상 NULL.
3) DB 방어 없음: server/db.js:171-200 transactions 정의에서 `account_id VARCHAR(36)` — NOT NULL 아님, DEFAULT 없음, FK만 존재. db.js/platform/schema.js 어디에도 TRIGGER/BEFORE INSERT 없음(grep 0건).
4) 잔액 집계가 NULL을 흡수하지 않음: server/routes/accounts.js:11 `COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='expense' AND account_id=a.id AND status='지급완료'),0)` — `account_id=a.id` 는 NULL에 대해 절대 참이 아니므로 모든 계좌에서 누락. server/routes/dashboard.js:18 도 동일 SQL. accounts.js/transactions.js 에 `account_id IS NULL` 보정이나 '미지정' 버킷 처리 grep 0건.
5) 사후 승계도 없음: 청구서 매칭 분기(resolutions.js:217)는 `UPDATE transactions SET invoice_id=?` 만 하고 account_id를 채우지 않는다. invoices 테이블에 account_id 컬럼이 있는데도(db.js:141) from-invoice 결의서에서 이를 승계하는 코드가 없다.
6) 대조군 확인: tax.js:36 은 같은 형태의 INSERT를 하지만 프런트(Tax.jsx:55)가 계좌를 강제한다. 결의서 경로만 이 규약이 빠졌다.

즉 F-02(급여·용역 지급 잔액 미반영)와 동일 유형이 결의서 도메인에 그대로 남아 있다. 참고로 요청받은 id `resolution-new-expense-null-account` 는 문서에 그 문자열 그대로는 없고, 같은 결함을 가리키는 `resolution-create-null-account`(docs/qa/phase1-review-findings.md:118)와 `resolution-create-no-account`(:150) 두 절이 중복 등재돼 있다. 내용은 동일하며 둘 다 사실로 확인됐다.

**경로 추적(repro)**

실행 경로가 끝까지 이어져 재현된다. (1) 유일한 호출자 src/screens/Docs.jsx:462-465 `submit()` — mode='create'일 때 body는 `{ mode:'create', amount: amountNum, date }` 뿐이고, ProcessDrawer의 create 폼(Docs.jsx:490-507)에는 금액·지출일 입력만 있고 계좌 선택 UI가 아예 없다(문구도 "거래처 · 계좌이체로 지출 거래가 생성됩니다"로 계좌를 묻지 않음). api 레이어(src/lib/api.js:574-577)도 body를 그대로 전달할 뿐 보강하지 않는다. (2) 서버 server/routes/resolutions.js:158 `const { mode, txn_id, amount, date, account_id } = req.body` → account_id는 항상 undefined. 라우트 160-201 어디에도 account_id 필수 검증이나 기본 계좌 폴백이 없다(검증은 결의서 존재/중복처리/청구서 완납/미래날짜/mode 값뿐). (3) resolutions.js:192-197 INSERT에서 `account_id || null` → NULL 저장. r.invoice_id가 있는 경로(206-226)도 invoices.account_id(server/db.js:141에 존재)를 승계하지 않고 transactions.invoice_id만 채운다. (4) 잔액식 server/routes/accounts.js:11 `SELECT SUM(amount) FROM transactions WHERE kind='expense' AND account_id=a.id AND status='지급완료'` — NULL은 어떤 계좌 서브쿼리에도 매칭되지 않아 expense_total에서 100% 누락. server/routes/dashboard.js:19도 동일 식이라 홈 대시보드 잔액도 같이 부풀려진다. 반면 status는 '지급완료'(공백 없음, :197)로 정확히 들어가므로 거래내역 화면에는 정상 지출로 보인다 → F-02와 정확히 동형의 '조용한 장부 오차'. 대조군으로 server/routes/transactions.js:103의 일반 거래 등록도 account_id||null이지만 그쪽은 폼에 계좌 선택 UI가 있고, 세금 납부(Tax.jsx:55)는 계좌를 강제한다. 결의서 경로만 사용자가 계좌를 지정할 방법 자체가 없어 100% 발생한다.

### 수정 방향

- 서버: resolutions.js mode==='create' 분기에서 지급방법이 현금이 아닌 경우 account_id 필수로 검증(없으면 400 '지출 계좌를 선택해주세요'), 그리고 r.invoice_id 가 있으면 invoices.account_id 를 기본값으로 승계(`account_id || inv.account_id || null`). 프런트: Docs.jsx ProcessDrawer create 모드에 계좌 Combobox(api.getAccounts) 추가하고 body에 account_id 포함, Tax.jsx:55 처럼 미선택 시 제출 차단 + '이 계좌에서 지출 거래가 생성돼요' 안내. 기존에 이미 만들어진 account_id NULL 지출은 일회성 점검 스크립트로 목록화해 사용자에게 계좌 지정을 유도(자동 배정 금지).
- ProcessDrawer(Docs.jsx) create 모드에 출금 계좌 Combobox를 추가해 body에 account_id를 실어 보내고, 결의서가 청구서 기반이면 invoices.account_id를 기본값으로 채운다. 서버 resolutions.js:185-198 mode='create' 분기에 `if (!account_id) return 400 '출금 계좌를 선택해주세요'`(또는 r.invoice_id의 invoices.account_id 승계 후에도 없으면 400) 검증을 넣어 NULL 계좌 지출이 생성되지 않도록 막고, 기존에 생성된 account_id NULL·doc_no가 결의서번호인 지출 거래를 점검·보정하는 1회 스크립트를 함께 돌린다.

---

## P0 · `server/routes/payroll.js:243`

**급여 지급 등록에서 출금 계좌를 고르지 않으면 transactions.account_id 가 NULL 로 들어가 어느 계좌 잔액에서도 차감되지 않는다 (F-02 동형 잔여 경로)**

**판정**: CONFIRMED (반증 0/2표)

### 검증 근거

**반증 시도(refute)**

반증 실패 — 이를 막는 코드가 서버·DB·프런트 어디에도 없다. (1) server/routes/payroll.js:243 은 `account_id || null` 을 그대로 INSERT 하며 227-255 핸들러 전체에 기본계좌 조회가 없다. (2) 스키마 server/db.js:177 `account_id VARCHAR(36)` 은 nullable·DEFAULT 없음이고 db.js:197 의 `FOREIGN KEY (account_id) REFERENCES accounts(id)` 는 NULL을 허용하므로 INSERT가 에러 없이 성공한다(트리거 없음). (3) 잔액 정의 server/routes/accounts.js:11 `... WHERE kind='expense' AND account_id=a.id AND status='지급완료'` 와 동일 SQL인 server/routes/dashboard.js:19 는 `account_id=a.id` 조건이라 NULL 행이 어느 계좌 서브쿼리에도 걸리지 않는다. server/·src/ 전체에 `account_id IS NULL` 을 별도 집계하는 코드는 없다. (4) 프런트 방어도 없다 — src/screens/HR.jsx PayDrawer 는 열릴 때 `setAccountId("")`, 콤보박스 placeholder 가 "계좌 선택 (선택)", register() 는 `if (!amount || amount <= 0)` 만 검사하고 `account_id: accountId || null` 을 전송한다. src/lib/api.js:884 payPayroll 은 단순 pass-through. (5) 대조군이 결정적이다: server/routes/work-contracts.js:391-392 는 같은 INSERT 직전에 `SELECT id FROM accounts WHERE kind='bank' ORDER BY created_at LIMIT 1` 후 `const acc = account_id || (defAcc ? defAcc.id : null)` 로 폴백하지만, 급여 경로에는 이 두 줄이 없다. payroll.js:245 주석이 F-02 수정(status='지급완료' 공백 없음)을 명시해 놓고 정작 같은 WHERE 절의 나머지 절반인 account_id 는 방어하지 않은 상태다. 결과적으로 급여대장은 '지급완료', 거래내역에도 지출이 보이지만 계좌 잔액·홈 대시보드 잔액은 1원도 줄지 않는 F-02 동형 장부 이탈이 성립한다.

**경로 추적(repro)**

실행 경로가 끝까지 이어집니다(중간 차단 없음).

1) 프론트 진입 — `src/screens/HR.jsx:485` `useState("")`, `:492` `setAccountId("")` (기본 계좌 자동선택 없음), `:552-555` `<label>출금 계좌</label>` + `placeholder="계좌 선택 (선택)"` (필수 표시 `*`는 :530 지급액에만 있음). `:499-501` `register()`는 `if (!amount || amount <= 0)` 금액만 검사하고 `api.payPayroll(row.id, { amount, date, account_id: accountId || null, method })` 로 그대로 null 전송. 호출자는 이 한 곳뿐(grep 결과 `src/screens/HR.jsx:501` 유일).

2) API — `src/lib/api.js:884-886` 은 body를 가공 없이 `POST /payroll/:id/pay` 로 전달.

3) 라우트 검증 — `server/routes/payroll.js:227-236`: `futureDateError(date)`, payroll 존재(404), `amt <= 0`(400) 세 가지만 검사. account_id 필수 검증·기본값 폴백 전혀 없음.

4) DB 쓰기 — `payroll.js:243` `[txnId, 'expense', account_id || null, '급여', amt, …, '지급완료', …]`. 스키마도 nullable(`server/db.js:177` `account_id VARCHAR(36)`, NOT NULL 아님). NULL 백필/트리거 없음(`UPDATE transactions SET account_id` / `account_id IS NULL` grep 무결과).

5) 잘못된 결과 — `server/routes/accounts.js:11` `SUM(amount) … WHERE kind='expense' AND account_id=a.id AND status='지급완료'` 이므로 account_id NULL 행은 어느 계좌에도 매칭되지 않아 전액 누락. `server/routes/dashboard.js:18` 도 동일 SQL이라 홈 대시보드 잔액까지 같이 틀어짐. 반면 `payroll.js:248-251` 은 `SUM(amount) WHERE payroll_id=?` 로 집계해 급여대장은 '지급완료'가 되고 거래내역에도 뜸 → **거래는 남았는데 잔액만 안 줄어드는 F-02와 정확히 동형**.

대조군 확인: 같은 성격의 용역/일용 지급 경로 `server/routes/work-contracts.js:391-392` 에는 `SELECT id FROM accounts WHERE kind='bank' ORDER BY created_at LIMIT 1` 기본 계좌 폴백이 있어 NULL이 되지 않음(`:398` 에 `acc` 사용). 급여 경로만 덮이지 않았음. `payroll.js:245` 주석이 status 축만 방어했다는 지적도 코드와 일치.

(참고: 지정된 id `payroll-null-account` 는 문서상 `payroll-pay-optional-account`(48-74행)와 `payroll-pay-null-account`(78-110행) 두 절로 중복 기재돼 있으며 동일 결함입니다.)

심각도: 조용한 장부 오차 + 사용자가 그 잔액을 보고 지급 판단, 22명 급여면 월 수천만 원 규모, 기본 상태가 NULL 경로라 발생 확률 높음 → P0 유지.

### 수정 방향

- work-contracts.js:391-392 와 동일하게 payroll.js `/:id/pay` 에서도 account_id 미지정 시 기본 은행계좌로 폴백하거나(권장: 폴백 대신 400 반환으로 명시 선택 강요), 최소한 서버에서 `if (!account_id) return res.status(400).json({ error: '출금 계좌를 선택해주세요' })` 로 막아라. 동시에 HR.jsx PayDrawer 의 라벨을 '출금 계좌 *' 로 바꾸고 placeholder 에서 '(선택)' 을 제거, accounts[0] 또는 주거래 은행계좌를 기본 선택으로 세팅해 '현금' 지급 시에도 계좌가 비지 않게 한다. 기존 데이터는 `SELECT * FROM transactions WHERE kind='expense' AND account_id IS NULL` 로 누락분을 뽑아 계좌 배정하는 일회성 정리 스크립트가 필요하다.
- 서버 `payroll.js:239-244` 에 work-contracts.js:391-392 와 동일한 기본 계좌 폴백을 넣어 account_id가 NULL로 저장되지 않게 하고(`const [[defAcc]] = await conn.execute("SELECT id FROM accounts WHERE kind='bank' ORDER BY created_at LIMIT 1"); const acc = account_id || defAcc?.id`), 폴백조차 없으면 400으로 거절할 것. 프론트 `HR.jsx` PayDrawer 는 열릴 때 기본 은행 계좌를 자동 선택하고 라벨을 '출금 계좌 *'/placeholder '계좌 선택'으로 바꿔 필수화(현금 지급도 실제 출금처가 있으므로 동일 적용). 추가로 기존 account_id NULL·kind='expense' 거래를 찾아 보정하는 1회 점검 스크립트 권장.

---

## P0 · `server/routes/invoices.js:177`

**기존 '지급 대기' 지출 거래를 매입 청구서에 연결하면 청구서만 '지급 완료'가 되고 거래 status 는 그대로라 계좌 잔액이 줄지 않는다**

**판정**: CONFIRMED (반증 0/2표)

### 검증 근거

**반증 시도(refute)**

반증 실패 — 지적된 경로가 코드에 그대로 존재하고, 이를 막는 코드를 서버·프런트·스키마 어디에서도 찾지 못했습니다.

1) 기존 거래 재사용 경로: `server/routes/invoices.js:176-177`
```
if (realTxnId) {
  await conn.execute('UPDATE transactions SET invoice_id = ? WHERE id = ?', [invoiceId, realTxnId])
}
```
invoice_id만 붙이고 status/account_id는 손대지 않습니다. 반대 분기(:182-188)만 `'지급완료'`(공백 없음)로 새 거래를 INSERT합니다. 그 직후 `invoices.js:195-199`에서 매칭 누계로 청구서와 마일스톤이 `'지급 완료'`로 갱신됩니다.

2) 후보 목록에 status 필터 없음: `server/routes/invoices.js:216-225` — WHERE 절은 `t.kind = ?`, `t.invoice_id IS NULL`, `NOT IN (SELECT txn_id FROM invoice_matches)` 뿐입니다. '지급 대기' 거래가 그대로 후보에 올라옵니다.

3) '지급 대기' 지출 거래는 실제로 생성됩니다: `server/routes/recurring.js:73` — 정기지출 자동생성이 `status='지급 대기'`로 INSERT. (`transactions.js:104` 수동 등록 기본값은 '지급완료'이므로 대기 상태의 주 공급원이 정기지출입니다. 이 프로젝트의 실사용이 정기청구·정기지출 중심이라 도달 가능성도 높습니다.)

4) 잔액 집계는 이 값을 거릅니다: `server/routes/accounts.js:11` — `SUM(amount) ... kind='expense' AND account_id=a.id AND status='지급완료'`. `analytics.js:72`도 `AND t.status = '지급완료'`.

5) 방어코드 부재 확인
- 프런트: `src/screens/Billing.jsx:83`(`api.getMatchable`)은 후보를 그대로 받고, :253-266 렌더링에서 거래 status를 표시조차 하지 않으며, :123-131 `linkMatch`는 "새 거래는 만들지 않아요" 확인만 띄우고 status 검사 없이 `onMatch(...)` 호출.
- DB: `server/db.js`에 transactions 스키마가 있으나 `CREATE TRIGGER`는 저장소 전체에 존재하지 않음(grep 결과 0건). 기본값·FK로도 보정되지 않음.
- 역방향 동기화도 없음: `transactions.js:137-146` PATCH /:id/status 는 거래 status만 바꾸고, `invoices.js:242-259`·`transactions.js:185-205`는 매칭 삭제/거래 삭제 시 청구서만 재계산합니다. 거래→청구서, 청구서→거래 양방향 어디에도 "연결된 거래의 지급 상태" 보정이 없습니다.

다만 지적의 인과 서술 한 곳은 정확도를 낮춰 볼 필요가 있습니다. 돈이 실제로 나가지 않았다면 잔액이 그대로인 것 자체는 옳고, 진짜 결함은 **지급되지 않은 거래를 연결했는데 청구서가 완납(지급 완료)으로 바뀌어 미지급금이 사라지는 것**입니다. 또 완전 무증상은 아닙니다 — 그 거래는 `src/screens/Ledger.jsx:291`에서 여전히 '이체 실행' 버튼과 함께 남고, `server/routes/dashboard.js:52-57`의 '대기 중 정기 지출' 위젯(`status='지급 대기' AND recurring_id IS NOT NULL`)에도 계속 노출됩니다. 즉 사후 복구·가시성 경로는 있으나, 이는 지적을 무력화하는 코드가 아니라 완화 요소입니다.

**경로 추적(repro)**

실행 경로가 끝까지 이어지고 잘못된 결과에 도달한다. 막는 검증·기본값이 어디에도 없다.

1) '지급 대기' 지출 거래는 실제로 생성된다 — `server/routes/recurring.js:73`: `[id,'expense',...,'계좌이체','지급 대기','공통',r.id,'정기 지출 자동 생성']`. (정기지출 생성 버튼 한 번이면 만들어짐)

2) 그 거래는 매칭 후보에 그대로 뜬다 — `server/routes/invoices.js:216-225` 후보 쿼리에 status 조건이 전혀 없다: `WHERE t.kind=? AND (t.invoice_id IS NULL OR t.invoice_id='') AND t.id NOT IN (SELECT txn_id FROM invoice_matches)`. 프론트도 status로 거르지 않는다(`src/screens/Billing.jsx:83` getMatchable → :104-105 `related` 여부로만 필터).

3) 사용자가 '연결'을 누르면 `src/screens/Billing.jsx:125-133 linkMatch()`가 `onMatch(invoice.id, txn.amount, txn.date, txn.id)` → `:762 api.matchInvoice(..., {txnId})`로 기존 txn_id를 보낸다. 확인 문구도 "새 거래는 만들지 않아요".

4) 라우트 `POST /:id/matches` (`server/routes/invoices.js:148~`): futureDateError(과거 날짜라 통과) → inv 조회 → 중복 매칭 검사(`:171` 첫 매칭이라 통과) → `:173` 거래 존재 확인 → **`:176-177` `if (realTxnId) { await conn.execute('UPDATE transactions SET invoice_id = ? WHERE id = ?', [invoiceId, realTxnId]) }`** — invoice_id만 붙이고 status는 손대지 않는다. else 분기(:182-188)에서만 `'지급완료'`가 들어간다.

5) 반면 청구서는 완납 처리된다 — `:195-199` `status = paid >= total ? '지급 완료' : '일부 지급'` → invoices UPDATE + milestones UPDATE.

6) 결과적으로 잔액 SQL을 통과하지 못한다 — `server/routes/accounts.js:11` `SUM(amount) ... WHERE kind='expense' AND account_id=a.id AND status='지급완료'`, 동일 조건이 `server/routes/dashboard.js:19`에도 있다. 거래 status는 여전히 `'지급 대기'`라 지출로 집계되지 않아 계좌 잔액이 줄지 않는다. `server/routes/analytics.js:72`의 `status_scope=completed` 매입 집계, `server/routes/contracts.js:459,793`의 계약 원가 실적에서도 빠진다.

반증 시도 결과: (a) DB 트리거 없음(server 전체 grep에서 TRIGGER 0건), (b) `server/routes/transactions.js:141-144`의 status 정규화는 거래 직접 수정 경로에만 있고 매칭 경로엔 없다, (c) `server/db.js:1157`의 1회 마이그레이션은 `'지급 완료'`(공백형)만 보정하며 `'지급 대기'`는 대상이 아니다, (d) 매칭 해제 경로(`invoices.js:242-263`)도 거래 status를 건드리지 않아 대칭적으로 미처리다.

부수 악화: 미지급금은 `PAYABLE_STATUSES`(invoices.js:8) 기준이라 청구서에서 사라지는데, 그 거래는 `dashboard.js:55`(`t.status='지급 대기' AND t.recurring_id IS NOT NULL`)의 '지급 예정'에는 계속 남는다. 즉 한쪽에선 완료, 다른 쪽에선 미지급으로 이중 표기된다.

과거 P0 F-02(급여·용역 지급이 status 공백 때문에 잔액 미반영)와 동일 클래스의 잔여 경로이며, 정기지출→매입청구서라는 일상 플로우에서 발생하므로 P0 유지가 타당하다.

### 수정 방향

- `invoices.js:216-225` 후보 쿼리에 완료 거래만 남기는 조건(`AND t.status IN ('입금완료','지급완료')`)을 넣거나, :176-177 재사용 분기에서 거래를 함께 완료 처리하도록 `UPDATE transactions SET invoice_id=?, status=?, account_id=COALESCE(account_id, ?)`(expense면 '지급완료', income이면 '입금완료', 계좌는 inv.account_id로 보완)로 바꾸세요. 후자를 택하면 미완료 거래를 연결할 때 프런트(`Billing.jsx` linkMatch)에서 "이 거래를 지급완료로 함께 처리한다"는 문구를 확인창에 명시해야 하고, account_id가 끝까지 NULL이면 잔액 미반영이 되므로 400으로 막는 편이 안전합니다.
- `server/routes/invoices.js:176-177`의 기존 거래 재사용 분기에서 invoice_id뿐 아니라 완료 상태도 함께 확정한다: `UPDATE transactions SET invoice_id=?, status=?, account_id=COALESCE(account_id, ?) WHERE id=?` (status는 isIssued ? '입금완료' : '지급완료' — 공백 없는 표준형, account_id 폴백은 inv.account_id). 거래 date도 매칭 date로 맞출지는 정책 결정 필요(현재 UI는 txn.date를 그대로 보냄). 아울러 매칭 해제(`:242-263`)에서도 대칭으로 status를 되돌릴지 결정하고, `GET /:id/matchable`(`:216-225`)이 후보에 t.status를 함께 내려 UI가 '아직 지급 안 된 거래를 연결합니다'를 고지하도록 보완한다.

---

## P0 · `server/routes/transactions.js:126`

**거래 금액을 수정해도 invoice_matches.amount 와 청구서 상태가 갱신되지 않아 청구서 정산액이 옛 금액 그대로 남는다**

**판정**: CONFIRMED (반증 0/2표)

### 검증 근거

**반증 시도(refute)**

반증 실패. (1) server/routes/transactions.js:124-131 PUT은 `UPDATE transactions SET ... amount=?, date=? ...` 만 수행하고 invoice_matches를 전혀 참조하지 않는다. 같은 파일 DELETE(transactions.js:191-204)에는 `DELETE FROM invoice_matches WHERE txn_id=?` + 청구서/마일스톤 상태 재계산이 있는데 PUT에는 대응 로직이 없다. (2) 정산액은 거래에서 파생되지 않고 별도 복사본이다 — invoices.js:192 `INSERT INTO invoice_matches (id, invoice_id, txn_id, amount)`, 상태는 invoices.js:195-199의 `SELECT COALESCE(SUM(amount),0) FROM invoice_matches`로만 결정된다. 조회 경로도 invoices.js:11-14(`paidAmount = Σ m.amount`, `remainAmount = total - paid`), dashboard.js:31,39(미수/미지급 remain 합산)까지 전부 invoice_matches.amount만 읽고 transactions.amount를 재조회하는 코드는 없다. contracts.js:308,395 / recurring-invoices.js:155 / resolutions.js:218 도 같은 방식으로 amount를 복사해 넣는다. (3) DB 방어 없음 — server/db.js:150-157 invoice_matches는 `FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE` 뿐이고 txn_id에는 FK조차 없다. 앱 코드 전체에 CREATE TRIGGER가 없다(grep 결과는 node_modules의 mysql2 에러상수/타입정의만 매치). (4) 프런트 방어 없음 — src/screens/Ledger.jsx:428 `openEdit?.(txn)` 편집 버튼이 invoice_id/매칭 여부와 무관하게 항상 노출되고(Ledger.jsx에 invoice_id 참조 자체가 없음), src/screens/Form.jsx:113 `amount: editTxn.amount`가 그대로 편집 가능하며 :190-191이 `api.updateTransaction`(src/lib/api.js:332 → PUT /transactions/:id)을 호출한다. 서버·DB·프런트 어디에도 이 시나리오를 막거나 보정하는 코드가 없다. 참고로 금액을 올리는 방향은 match가 과소로 남아 잔여가 생기는(안전한) 쪽이지만, 내리는 방향은 청구서가 '입금 완료'인 채 미수가 사라지는 F-02와 동일한 조용한 왜곡이 된다.

**경로 추적(repro)**

실행 경로가 끝까지 이어지며 막는 지점이 없습니다. (1) 정산 금액은 server/routes/invoices.js:192 `INSERT INTO invoice_matches (id, invoice_id, txn_id, amount)` 로 transactions와 별개 행에 복사 저장되고, 청구서 상태는 invoices.js:195-199에서 `SUM(invoice_matches.amount)` 로만 재계산됩니다. server/db.js:150-158 스키마에 트리거·생성컬럼 없음 — 두 값은 물리적으로 독립. (2) 프론트 가드 없음: src/screens/Ledger.jsx:428 `<button className="btn" onClick={() => { onClose(); openEdit?.(txn) }}>편집</button>` 는 txn.invoice_id 유무와 무관하게 항상 노출되고, 정산으로 자동 생성된 '청구서 … 정산' 거래도 원장 목록에 그대로 보입니다. src/App.jsx:318이 그대로 Form을 편집 모드로 열고, src/screens/Form.jsx:146-153의 검증은 거래처·계약·비목·적요·금액유무·날짜형식/미래날짜뿐이라 금액 변경을 막지 않으며 Form.jsx:178·190-191에서 새 amount로 `api.updateTransaction(editTxn.id, txnData)`(src/lib/api.js:334, PUT /transactions/:id)를 호출합니다. (3) 서버 PUT(server/routes/transactions.js:111-135)은 futureDateError와 `SELECT kind` 404 체크만 거친 뒤 `UPDATE transactions SET ... amount=?, ...` 만 수행하고 invoice_matches를 조회조차 하지 않습니다. 같은 파일 DELETE(:191-204)에는 매칭 정리 + 청구서/마일스톤 상태 재계산 로직이 있는데 PUT에는 대응 로직이 전혀 없습니다. (4) 결과적으로 계좌잔액(accounts.js, transactions.amount 기준)만 감액되고, invoices.js:11-14 attachMatches의 paidAmount/remainAmount와 /summary/receivables(:33-49)는 옛 금액 그대로라 remainAmount=0 → 미수금 집계에서 통째로 탈락하고 청구서는 '입금 완료'로 남습니다. UI 어디에도 거래금액과 매칭금액 불일치를 드러내는 표시가 없어 조용히 틀어집니다. 증액 방향도 동일해, POST /:id/matches의 과입금 방지(invoices.js:160-165)를 사후 편집으로 우회해 SUM(matches) > total 상태를 만들 수 있습니다.

### 수정 방향

- PUT /transactions/:id 를 conn = await req.db.getConnection() 트랜잭션으로 감싸고, 해당 txn_id의 invoice_matches가 있으면 (a) 새 amount와 해당 청구서의 잔여(total - 다른 매칭 합계)를 비교해 `UPDATE invoice_matches SET amount = LEAST(newAmount, remainExcludingThis) WHERE txn_id=?` 로 갱신한 뒤, (b) DELETE 경로(transactions.js:193-204)와 동일한 재계산 블록(paid<=0 → '입금 예정'/'지급 대기', paid>=total → '입금 완료'/'지급 완료', else 일부)으로 invoices.status·milestones.status를 다시 쓴다. 재계산 로직은 DELETE와 중복되므로 헬퍼(db를 인자로 받는 recalcInvoiceStatus(conn, invoiceId))로 뽑아 invoices.js:195-199, :253-258 과도 공유하는 게 안전하다. 추가로 프런트(Form.jsx)에서 매칭된 거래는 금액 변경 시 경고를 띄우면 좋다.
- PUT /transactions/:id 를 conn=req.db.getConnection() 트랜잭션으로 감싸고, 금액이 바뀌었고 해당 txn_id에 invoice_matches 행이 있으면 매칭 금액을 새 amount(해당 청구서의 다른 매칭 합계를 뺀 잔여로 상한 처리)로 UPDATE한 뒤, DELETE 라우트(transactions.js:193-204)와 동일한 방식으로 SUM(matches) 기준 invoices.status·milestones.status를 재계산하세요. 최소 조치로는 invoice_matches에 걸린 거래의 amount 변경을 서버에서 409로 거부하고 Ledger 편집 버튼도 비활성화해, 금액 정정은 매칭 취소 후 재매칭으로만 가능하게 하는 방법이 있습니다.

---

## P1 · `server/routes/resolutions.js:184`

**지급결의서 '기존 지출 연결'(mode=link)이 거래 status 를 '지급완료'로 바꾸지 않아, 결의서·청구서는 완료인데 계좌 잔액에서 그 지출이 빠지지 않는다**

**판정**: CONFIRMED (반증 0/2표)

### 검증 근거

**반증 시도(refute)**

반증 실패 — 무력화 코드를 찾지 못했다. server/routes/resolutions.js:181-184 의 mode='link' 분기는 `SELECT id FROM transactions WHERE id=? AND kind='expense'` 로 존재 여부만 확인하고 `UPDATE transactions SET doc_no=?` 만 실행한다. status 를 읽지도 쓰지도 않는다. 후보 목록 server/routes/resolutions.js:141-148 은 `WHERE t.kind='expense' AND t.id NOT IN (SELECT txn_id FROM expense_resolutions ...)` 뿐이라 status 필터가 없고, t.status 를 SELECT 해서 내려주기만 한다. 프런트 방어도 없다 — src/screens/Docs.jsx:457 이 그 목록을 그대로 받아 :526 에서 status 를 표시만 하고, :463-467 은 어떤 검증도 없이 `{mode:'link', txn_id}` 를 POST 한다. 잔액 집계 server/routes/accounts.js:11 은 `kind='expense' AND account_id=a.id AND status='지급완료'` 인 것만 지출로 세므로 '지급 대기' 로 남은 거래는 100% 누락된다. 정규화 코드(server/routes/transactions.js:143, server/db.js:1157)는 '지급 완료'(공백) → '지급완료' 만 다루고 '지급 대기' 는 건드리지 않는다. DB 트리거/기본값 방어도 없다(server/ 전체에서 CREATE TRIGGER 없음, status 는 호출자가 직접 쓰는 평범한 컬럼). 미완료 지출을 실제로 만들어내는 경로도 실재한다 — server/routes/recurring.js:73 이 '지급 대기' 로 INSERT 하고 server/routes/dashboard.js:55 가 그런 행을 정상 상태로 취급한다. 반면 같은 트랜잭션에서 청구서는 server/routes/resolutions.js:220-222 로 '지급 완료'(server/routes/invoices.js:8 PAYABLE_STATUSES 밖 → 미지급금에서 제외), 결의서는 :228 로 '완료' 가 된다. 즉 미지급금은 사라지고 계좌 잔액은 그대로 남는 F-02 동형 결함이 맞다. 형제 분기 mode='create'(resolutions.js:197)가 '지급완료' 를 하드코딩하고 있다는 점이 이 값이 필요하다는 방증이다. 다만 완화 요소는 있다: 이 경로는 사용자가 '기존 지출에 연결' 을 고르고 목록에서 미완료 거래를 직접 선택해야만 발생하며(자동 발생 아님, Docs.jsx:443 주석상 원래 의도는 '이미 나간 지출' 연결), 사후에도 src/screens/Ledger.jsx:291-292 가 그 거래에 '이체 실행' 버튼을 계속 노출해 수동 교정이 가능하다. 그래도 경고는 전혀 없고 장부는 조용히 틀어진다.

**경로 추적(repro)**

실행 경로를 끝까지 따라가면 시나리오가 그대로 성립한다. (1) 미완료 지출 생성원이 실재한다 — server/routes/recurring.js:73 이 `status='지급 대기'`, `account_id=r.account_id` 로 expense 거래를 INSERT 한다(정기지출 자동 생성, 대시보드 nudge dashboard.js:55 가 이걸 노출). (2) 후보 목록에 필터가 없다 — resolutions.js:141-148 `WHERE t.kind='expense' AND t.id NOT IN (SELECT txn_id FROM expense_resolutions ...)` 로 status 는 SELECT 만 하고 조건에 안 쓴다. 프런트도 src/screens/Docs.jsx:517-527 에서 status 를 문구로만 찍고(`{t.date} · {t.category} · {t.status}`) 걸러내지 않으며, submit(Docs.jsx:462-466)은 `{ mode:'link', txn_id: pickedTxn }` 만 보낸다. (3) 라우트 진입 후 막는 검증이 없다 — resolutions.js:181 은 `SELECT id FROM transactions WHERE id=? AND kind='expense'` 로 kind 만 확인하고, :184 는 `UPDATE transactions SET doc_no=? ...` 로 doc_no 만 찍는다. status 를 건드리는 문이 mode='link' 분기 전체에 없다(같은 핸들러 mode='create' 분기 :197 은 '지급완료'를 하드코딩). (4) 그런데 같은 트랜잭션에서 청구서는 완납된다 — :212 dupMatch 검사 통과(정기지출 거래는 invoice_matches 에 없음), :214 remainBefore>0, :218 invoice_matches INSERT, :220-222 invoices/milestones status='지급 완료', :228 결의서 status='완료'. '지급 완료'는 invoices.js:8 PAYABLE_STATUSES 에 없어 미지급금 집계에서 빠지고 Billing.jsx:728 PENDING_STATUS 에서도 빠진다. (5) 계좌 잔액은 accounts.js:11 `SUM(amount) ... kind='expense' AND account_id=a.id AND status='지급완료'` 만 세므로 '지급 대기'로 남은 이 거래는 차감되지 않는다(dashboard.js:19 동일 SQL, analytics.js:72, contracts.js:459 `if (t.status !== '지급완료') continue` 도 동일하게 누락). db.js:1157 의 1회 마이그레이션은 '지급 완료'(공백)만 '지급완료'로 정규화하므로 '지급 대기'는 영구히 남는다. 결과: 미지급금은 사라졌는데 통장 잔액은 그대로 → 순자산 과대 계상. F-02 와 동형이며 어디에도 이를 막는 조건문·기본값이 없다. 심각도만 조정: F-02 는 무조건 발생이었으나 이 건은 (a) 사용자가 '지급완료'가 아닌 후보를 골라야 성립하고(Ledger 신규 등록 기본값은 transactions.js:104 `status||'지급완료'`), (b) 거래내역에 '지급 대기'로 남아 Ledger.jsx:435-438 '이체 실행' 버튼으로 사후 복구 가능하다. 다만 처리 직후 토스트는 "기존 지출에 연결했어요. 청구서도 지급 처리됐어요"(Docs.jsx:469-470)라 사용자가 추가 조치가 필요한 줄 모른다 → P1.

### 수정 방향

- resolutions.js:181 의 SELECT 에 status 를 포함시키고, mode='link' 분기에서 연결 대상이 미완료('지급 대기'/'지급 예정'/'기한 지남')면 같은 트랜잭션 안에서 `UPDATE transactions SET status='지급완료'`(무공백 표준형)까지 함께 실행한다 — mode='create' 분기(:197)와 결과를 일치시키는 것이 핵심. account_id 가 비어 있으면 잔액 반영이 안 되므로 이때 계좌 확인/요구도 함께 하는 편이 안전하다. 아울러 /:id/matchable(:141-148)은 status 를 응답에 계속 실어주되, 미완료 후보를 고르면 프런트(Docs.jsx:508-531)에서 "이 거래는 아직 지급 전이에요 — 연결하면 지급완료로 처리됩니다" 를 명시해 사용자가 결과를 알게 한다.
- resolutions.js mode='link' 분기(:181-184)에서 거래를 조회할 때 status 도 같이 읽고, 완료가 아니면 같은 트랜잭션에서 `UPDATE transactions SET status='지급완료' WHERE id=? AND kind='expense'` 로 정규화하라(공백 없는 '지급완료' — accounts.js:11 이 이 값만 센다). 더불어 후보 쿼리 `/:id/matchable`(:141-148)에도 안내용 status 노출은 유지하되, 완료 전환이 일어난다는 점을 처리 응답/토스트에 알리거나 최소한 account_id 가 NULL 인 후보는 잔액에 안 잡히므로 경고하라. 같은 누락이 invoices.js:176-177(기존 거래 매칭 시 status 미갱신)에도 있으니 함께 보는 것이 좋다.

---

## P1 · `src/screens/Docs.jsx:1658`

**'미수금 현황' 보고서가 실 API 를 조회하지 않고 빈 SAMPLE 상수를 읽어 미수금을 항상 0원으로 표시한다**

**판정**: CONFIRMED (반증 0/2표)

### 검증 근거

**반증 시도(refute)**

반증 실패 — 지적 내용이 코드와 일치한다.

1) 데이터 소스가 실제로 빈 상수다. `src/screens/Docs.jsx:3-8`
```
// SAMPLE placeholder — Docs 화면은 실 API 연동 전까지 빈 데이터로 동작
const SAMPLE = { docs: [], evidences: [], ..., receivables: { summary: { total: 0, thisMonth: 0, overdue: 0, longOverdue: 0 }, rows: [] } }
```
`SAMPLE`은 모듈 로컬 `const`이고 export도 되지 않으며, 파일 전체(3,830,900,903,1312,1313,1346,1347,1497,1548,1597,1658,1706,1721,1767행)에서 읽기만 할 뿐 `Object.assign`/재대입으로 실데이터를 주입하는 코드가 없다. 즉 런타임에 채워질 경로가 존재하지 않는다.

2) `ReportAR`(Docs.jsx:1657-1658)에 API 호출이 없다. 같은 파일의 다른 보고서는 실제로 API를 쓴다 — `ReportTax4`(1421행 `api.getPayroll(...)`), `ReportVAT`(1908행 `api.getVatSummary(quarter)`). ReportAR만 `useEffect`/`api.*`가 전무하다. 따라서 1662~1665행 StatCard 4장에 `summary.total/thisMonth/overdue/longOverdue`가 모두 리터럴 0으로 들어가고, StatCard(1298-1307행)는 `isNum`이면 `fmtNum(value)`로 렌더하므로 "0"이 그대로 표시된다(빈 값 처리·로딩 표시 없음). 표 본문(1681행)도 `rows=[]`라 항상 비어 있다.

3) 화면 도달 경로가 살아 있다(숨김 처리된 `evidence`와 다르다).
- `src/lib/nav.js:70` `{ id: "report", label: "보고서", icon: Icon.Chart }` (사이드바 경영관리 > 장부관리)
- `src/lib/nav.js:134` `{ id: 'report', label: '장부관리', ..., route: 'report' }` (포털)
- `src/App.jsx:334` `case "report": return <ReportsScreen/>;`
- `src/screens/Docs.jsx:2056` `{REPORTS.map(...)}` — 필터/`준비중` 뱃지 없이 10개 전부 카드로 노출, `REPORTS`에 `{ id: "ar", t: "미수금 현황" }`(1336행)이 포함, `REPORT_VIEWS.ar = ReportAR`(2022행).
- 권한도 열려 있다: `server/platform/permissions.js:70` `{ id: 'report', ... }`가 RESOURCES에 있고 PRESET_ROLES의 마스터/경리/조회전용 모두 access·view를 받는다(92,103,111행). 즉 권한 게이팅으로 막히지 않는다.

4) 오인 유발 요소도 그대로다. `Docs.jsx:2044` `<div className="page-sub">{localToday()} 조회 기준</div>` 가 제목 아래 붙어 최신 조회처럼 보이고, 같은 앱의 `ar` 라우트(`App.jsx:349` BillingScreen role="collect")는 `api.getReceivables()` 기반 실수치를 보여주므로 두 화면 숫자가 어긋난다.

5) 반증에 쓸 만한 방어코드(로딩 스켈레톤, 빈 상태 안내, "목업" 표기, nav 숨김, 라우트 제거)를 프런트·미들웨어·권한 어디에서도 찾지 못했다.

다만 심각도는 조정 의견이 있다. (a) 쓰기 경로가 없는 읽기 전용 표시 결함으로, 과거 P0 'F-02'처럼 DB 장부가 틀어지지는 않는다. (b) CLAUDE.md '알려진 미구현 항목'에 "Docs.jsx/Ledger.jsx — 아직 SAMPLE.receivables 참조 중(api 전환 필요)"로 이미 문서화돼 있다. (c) 같은 화면의 monthly·contract·category·vendor·subcontract 보고서도 동일하게 빈 SAMPLE을 읽어(1346,1497,1548,1597,1706행) 보고서 목록 대부분이 비어 보이므로, 단일 항목만 그럴듯한 0원을 말하는 상황보다는 오인 가능성이 낮다. 그래도 금액을 0원으로 확언해 회수 판단을 그르칠 수 있어 P1 아래로는 내릴 수 없다.

**경로 추적(repro)**

실행 경로가 끝까지 이어진다. (1) 진입: src/lib/nav.js:70 사이드바 '경영관리 > 장부관리 > 보고서'(id `report`)와 nav.js:134 포털 카테고리(route `report`) 모두 살아 있고, src/App.jsx:334 `case "report": return <ReportsScreen/>` 로 라우팅된다(숨김 처리된 evidence와 달리 제외 코드 없음). (2) 목록: Docs.jsx:1336 `{ id: "ar", t: "미수금 현황", … }` 카드가 REPORTS에 그대로 있고, ReportsScreen(Docs.jsx:2027-2058)에서 카드 클릭 → setActive('ar') → Docs.jsx:2022 `REPORT_VIEWS = { …, ar: ReportAR }` → Docs.jsx:2045 `<View toast={toast}/>` 로 렌더된다. (3) 데이터: ReportAR(Docs.jsx:1657-1658) 본문 전체가 `const { summary = {}, rows = [] } = SAMPLE.receivables || {}` 한 줄뿐이고 useEffect·api 호출이 전혀 없다. SAMPLE은 같은 파일 Docs.jsx:4-8 의 하드코딩 빈 상수 `receivables: { summary: { total: 0, thisMonth: 0, overdue: 0, longOverdue: 0 }, rows: [] }` 다. (4) 렌더: Docs.jsx:1662-1665 StatCard 4개에 value=0 이 넘어가고, StatCard(Docs.jsx:1297-1305)는 `typeof value === "number"` 이면 fmtNum 렌더 + '원' 단위를 붙인다. ui.jsx:11 `fmtNum = (n) => (n ?? 0).toLocaleString("ko-KR")` 이므로 0 은 "—"가 아니라 "0원"으로 확신 있게 찍힌다. rows=[] 이므로 표는 완전히 빈 tbody(빈 상태 안내 문구조차 없음)이고, Docs.jsx:2044 `{localToday()} 조회 기준` 문구가 상단에 붙어 실시간 조회처럼 보인다. 중간에 이를 막는 검증·조건문·기본값은 없다. 실 데이터원도 존재한다 — src/lib/api.js:1155 `getReceivables()` 는 `/invoices` 를 조회해 ReportAR 이 구조분해하는 것과 동일한 `{ summary, rows }` 형태를 돌려주고, 같은 앱의 `ar`(입금·환불) 화면은 이 경로로 실 잔액을 보여준다. 즉 두 화면이 서로 다른 숫자를 말한다는 지적도 사실이다. 다만 심각도는 과장으로 본다: 이 결함은 순수 표시 결함으로 DB 쓰기·집계 왜곡이 없어 배경의 F-02(지출이 계좌잔액 집계에서 누락되어 장부가 영구히 틀어짐)와 성격이 다르고, 되돌릴 데이터 손상이 없다. 또한 CLAUDE.md에 'Docs.jsx는 아직 SAMPLE 직접 참조 중(api 전환 필요)'로 이미 알려진 미구현 항목이며, 같은 화면의 다른 보고서 6개(monthly Docs.jsx:1346-1347, contract 1497, category 1548, vendor 1597, subcontract 1706, defense 1767)도 동일하게 빈 SAMPLE 을 읽어 미수금 보고서만의 단독 회귀가 아니다(사용자가 화면 전반이 비어 있음을 인지하기 쉬움).

### 수정 방향

- ReportAR을 실 API로 배선한다 — `api.getReceivables()`(src/lib/api.js:1155)가 이미 `{ vendor, contract, billed, paid, remain, due, delay, status }`로 ReportAR 표(Docs.jsx:1681-1693)와 정확히 같은 shape을 반환하므로 `useState([])` + `useEffect(() => { api.getReceivables().then(setRows) }, [])` 로 교체하고, summary 4종은 rows에서 파생(total=Σremain, thisMonth=due가 KST 당월인 건, overdue=delay>0, longOverdue=status==='장기 미수')하거나 `api.getReceivablesSummary()`(api.js:230)와 맞춘다. 즉시 배선이 어렵다면 `evidence`를 nav에서 뺐던 방식대로 REPORTS(Docs.jsx:1330-1341)에서 `ar`(및 동일하게 빈 SAMPLE을 쓰는 monthly·contract·category·vendor·subcontract) 항목을 제거해 0원이 실수치로 오인되지 않게 한다.
- ReportAR 을 다른 API 연동 화면과 동일한 패턴으로 바꾼다 — `const [data, setData] = useState({ summary: {}, rows: [] })` + `useEffect(() => { api.getReceivables().then(setData) }, [])`. api.js:1155 getReceivables() 가 이미 `{ summary: { total, thisMonth, overdue, longOverdue }, rows: [{ vendor, contract, billed, paid, remain, due, delay, status }] }` 형태를 반환하므로 JSX 는 그대로 두어도 된다. 로딩 중에는 0원 대신 스켈레톤/'불러오는 중'을 보여주고, rows 가 비면 '미수금 없음' 빈 상태 문구를 넣어 미연동과 실제 0원을 구분한다. 동시에 같은 화면의 나머지 SAMPLE 기반 보고서(Docs.jsx:1346,1497,1548,1597,1706,1767)도 API 전환하거나, 전환 전까지 REPORTS 목록에서 감춰 0원이 실데이터로 오인되지 않게 한다.

---

