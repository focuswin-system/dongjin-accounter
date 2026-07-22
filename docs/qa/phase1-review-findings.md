# Phase 1 코드 품질 검토 — 중간 결과 (미검증)

> **작성**: 2026-07-22 / **상태**: Find 5/11 완료, 반증 검증 미실시(비용 한도로 중단)
> ⚠️ **아래 항목은 반증 검증을 거치지 않았습니다. 수정 착수 전 건별로 코드를 직접 확인해야 합니다.**

## 요약

| 심각도 | 건수 |
|---|---|
| P0 | 8 |
| P1 | 16 |
| P2 | 14 |
| **합계** | **38** |

---

## P0 (8건)

### P0 · 기존 '지급 대기' 지출 거래를 매입 청구서에 연결하면 청구서만 '지급 완료'가 되고 거래 status는 그대로라 계좌 잔액이 줄지 않는다

- **위치**: `server/routes/invoices.js:177`
- **분류**: money
- **id**: `invoice-match-pending-txn`

**근거**

invoices.js:176-177 — 기존 거래를 재사용할 때 invoice_id만 붙이고 status는 손대지 않는다:
```
if (realTxnId) {
  await conn.execute('UPDATE transactions SET invoice_id = ? WHERE id = ?', [invoiceId, realTxnId])
} else { ... status '지급완료'로 새 거래 생성 ... }
```
그리고 invoices.js:197에서 청구서는 완납 처리된다: `const status = Number(paid) >= total ? (isIssued ? '입금 완료' : '지급 완료') : ...`
후보 목록(invoices.js:216-225)에는 **status 필터가 전혀 없다**:
```
WHERE t.kind = ?
  AND (t.invoice_id IS NULL OR t.invoice_id = '')
  AND t.id NOT IN (SELECT txn_id FROM invoice_matches)
```
'지급 대기' 지출은 실제로 존재한다 — recurring.js:73이 정기지출 자동 생성 시 `'지급 대기'`로 넣는다. 프론트도 이 후보를 그대로 노출·연결한다(src/screens/Billing.jsx:83 `api.getMatchable(invoice.id).then(setCandidates)`, :762 `api.matchInvoice(invoiceId, { txnId, ... })`, 확인문구 '새 거래는 만들지 않아요').

**실패 시나리오**

1) 매입 계약에 정기지출(월 1,100,000원)을 걸고 '정기지출 생성'을 실행하면 status='지급 대기' 지출 거래 1건이 생긴다. 2) 같은 건의 매입 청구서를 등록한다. 3) 청구서 상세 → 매칭에서 후보로 뜨는 그 '지급 대기' 거래를 '연결'한다. 4) 결과: 청구서 status='지급 완료', 미지급금 집계에서 1,100,000원이 빠지고, 결의서/마일스톤도 완료로 바뀐다. 그런데 거래 status는 여전히 '지급 대기'라 accounts.js:11의 `status='지급완료'` 조건을 통과하지 못해 **계좌 잔액은 그대로**다. analytics.js:72의 매입 집계(status_scope=completed)에서도 빠진다. 즉 미지급금은 사라졌는데 잔액은 안 줄어 장부가 양쪽으로 어긋난다.

---

### P0 · 급여 지급 등록에서 출금 계좌가 '선택' 항목이라, 미선택 시 급여 지출이 계좌 잔액에 반영되지 않는다

- **위치**: `server/routes/payroll.js:243`
- **분류**: money
- **id**: `payroll-pay-optional-account`

**근거**

payroll.js:240-245
```
INSERT INTO transactions (id, kind, account_id, category, amount, date, method, status, buyer_type, employee_id, payroll_id, memo)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`, [txnId, 'expense', account_id || null, '급여', amt, ...,
    method || '계좌이체', '지급완료', '공통', p.employee_id, p.id, ...])
// ↑ 거래 status는 '지급완료'(공백 없음) — 계좌 잔액 계산(accounts.js)이 이 값만 지출로 센다.
```
주석은 status 축만 방어하고 account_id 축은 방어하지 않는다. 서버에 account_id 필수 검증이 없고(라우터 227-237행 어디에도 없음), 클라이언트도 강제하지 않는다 — src/screens/HR.jsx:553-556:
```
<Combobox value={accountId} onChange={setAccountId}
  options={accounts.map(...)}
  placeholder="계좌 선택 (선택)"/>
```
라벨이 명시적으로 '(선택)'이고, HR.jsx:501은 `account_id: accountId || null`로 그대로 NULL을 보낸다. 잔액 SQL(accounts.js:11)은 `account_id=a.id` 조건이라 NULL 행은 모든 계좌에서 빠진다.

**실패 시나리오**

1) 인사관리 → 급여대장에서 직원 급여 3,000,000원을 '지급 등록'한다. 2) 지급액·지급일만 채우고 '출금 계좌'는 (선택)이라 비워둔 채 등록한다. 3) 급여대장 상태는 '지급완료'로 바뀌고 거래내역에도 급여 3,000,000원 지출이 뜬다. 4) 그러나 기업은행 주거래 계좌 잔액은 그대로다. 직원 20명분을 이렇게 등록하면 매달 수천만 원이 잔액에서 누락된다. F-02가 '급여·용역 지급이 계좌잔액에 미반영'이었던 것과 정확히 같은 결과가, 같은 화면에서, status가 아닌 account_id 경로로 그대로 재현된다.

---

### P0 · 급여 지급 등록 시 출금 계좌를 고르지 않으면 transactions.account_id가 NULL로 들어가 어느 계좌 잔액에서도 차감되지 않는다 (F-02 동형 잔여 경로)

- **위치**: `server/routes/payroll.js:243`
- **분류**: money
- **id**: `payroll-pay-null-account`

**근거**

payroll.js:240-244
```
INSERT INTO transactions (id, kind, account_id, category, amount, date, method, status, buyer_type, employee_id, payroll_id, memo)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`, [txnId, 'expense', account_id || null, '급여', amt, ...  '지급완료', ...])
```
바로 위 245줄 주석은 "거래 status는 '지급완료'(공백 없음) — 계좌 잔액 계산(accounts.js)이 이 값만 지출로 센다"라고 F-02 수정을 명시하고 있으나, 잔액 계산의 **다른 한쪽 조건인 account_id는 방어되지 않았다**.

server/routes/accounts.js:11
```
COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='expense' AND account_id=a.id AND status='지급완료'), 0) AS expense_total
```
→ account_id가 NULL이면 `account_id=a.id`가 어떤 계좌에도 매칭되지 않아 expense_total에 전혀 포함되지 않는다.

그리고 프론트는 계좌를 **선택 사항**으로 둔다.
src/screens/HR.jsx:492 `setAccountId("")` (초기값 공백, 기본 계좌 자동선택 없음)
src/screens/HR.jsx:553-555 `<Combobox value={accountId} ... placeholder="계좌 선택 (선택)"/>`
src/screens/HR.jsx:499-501 `register()`는 금액만 검사하고 `account_id: accountId || null` 로 그대로 전송한다.

대조군: 같은 성격의 용역 지급 경로(work-contracts.js:391-392)에는 기본 계좌 폴백이 있어 NULL이 되지 않는다. 즉 급여 경로만 덮이지 않았다.

**실패 시나리오**

인사관리 > 급여대장 > 직원 행의 '지급 등록'을 연다 → 지급액 3,000,000 입력, 지급 수단 '계좌이체'(기본값) → **'출금 계좌' 콤보박스를 건드리지 않고**(플레이스홀더가 '계좌 선택 (선택)'이라 필수로 보이지 않음) '지급 등록' 클릭.
결과: 토스트 "급여 지급을 등록했어요 (거래내역에 반영)"가 뜨고, 급여대장은 '지급완료', 거래내역에도 3,000,000원 지출이 보인다. 그러나 기준정보>계좌 화면과 홈 대시보드의 기업은행 주거래 잔액은 **1원도 줄지 않는다**. 22명 급여를 이렇게 등록하면 실제 통장보다 앱 잔액이 월 급여 총액만큼 크게 표시되고, 사용자는 그 잔액을 믿고 지급 판단을 하게 된다. 지급 수단으로 '현금' 칩을 고른 경우엔 계좌를 비워두는 것이 오히려 자연스러워 발생 확률이 더 높다.

---

### P0 · 지급결의서 '지출 새로 등록' 처리가 account_id NULL로 지출 거래를 만들어, 계좌 잔액에서 100% 누락된다

- **위치**: `server/routes/resolutions.js:195`
- **분류**: money
- **id**: `resolution-create-null-account`

**근거**

resolutions.js:192-197
```
await conn.execute(
  `INSERT INTO transactions (id, kind, vendor_id, account_id, category, amount, date, method, status, buyer_type, doc_no, memo)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  [id, 'expense', r.vendor_id || null, account_id || null, r.title || '지출', amt,
   effDate, r.pay_method || '계좌이체',
   '지급완료', '공통', r.doc_no, `결의서 ${r.doc_no} 집행`])
```
`account_id`는 req.body에서 온다(resolutions.js:158 `const { mode, txn_id, amount, date, account_id } = req.body`). 그런데 이 API를 호출하는 유일한 화면인 src/screens/Docs.jsx:463-465 는 account_id를 **아예 보내지 않는다**:
```
const body = mode === 'link'
  ? { mode: 'link', txn_id: pickedTxn }
  : { mode: 'create', amount: amountNum, date };
```
잔액 정의(accounts.js:11)는 `SUM(amount) FROM transactions WHERE kind='expense' AND account_id=a.id AND status='지급완료'` 이므로, account_id가 NULL이면 어떤 계좌의 서브쿼리에도 걸리지 않는다. dashboard.js:19도 동일 SQL이라 홈 대시보드 잔액도 같이 틀린다.
대조군: tax.js는 같은 상황에서 Tax.jsx:55 `if (isDone && !form.account_id) return toast.push('납부 계좌를 선택해주세요')`로 계좌를 강제하고 화면에 '이 계좌에서 지출 거래가 생성돼요'라고 명시한다. 결의서 경로만 이 규약이 빠져 있다.

**실패 시나리오**

1) 지출결의서(예: 외주비 5,000,000원)를 작성한다. 2) 결의서 목록에서 '처리' → '지출 새로 등록'을 고르고 금액·날짜만 넣고 처리한다. 3) 결의서는 '완료', 거래내역에는 5,000,000원 지출이 '지급완료'로 정상 표시된다. 4) 그런데 기준정보 → 계좌/카드, 홈 대시보드의 계좌 잔액은 **1원도 줄지 않는다**. 실제로는 돈이 나갔는데 장부상 잔액만 5,000,000원 부풀어 있다. 결의서로 집행한 지출이 쌓일수록 오차가 누적되고, 사용자는 거래내역에서 지출을 확인했기 때문에 잘못을 알아채지 못한다. (F-02의 (a)증상 재발 — 당시엔 status만 고쳤고 계좌 누락 축은 남았다.)

---

### P0 · 지급결의서 '지출 새로 등록' 처리로 생성된 지출 거래는 account_id가 항상 NULL이라 어느 계좌 잔액에서도 차감되지 않는다 (F-02 동형)

- **위치**: `server/routes/resolutions.js:195`
- **분류**: money
- **id**: `resolution-create-no-account`

**근거**

resolutions.js:192-197 `INSERT INTO transactions (id, kind, vendor_id, account_id, ...) VALUES (...)` 에 `account_id || null` 을 넣는데, 유일한 호출자인 src/screens/Docs.jsx:463-465 는 `{ mode: 'create', amount: amountNum, date }` 만 보낸다(ProcessDrawer 에 계좌 선택 UI 자체가 없음 — Docs.jsx:490-506 확인). 즉 account_id 는 언제나 NULL 이다. 반면 server/routes/accounts.js:11 의 잔액식은 `SELECT SUM(amount) FROM transactions WHERE kind='expense' AND account_id=a.id AND status='지급완료'` 라서 account_id 가 NULL 인 행은 모든 계좌 집계에서 빠진다. dashboard.js:19 도 동일 식이다. 결의서가 invoice 에서 생성된 경우 invoices.account_id 가 있는데도 그 값을 승계하는 코드가 없다.

**실패 시나리오**

결의서 화면에서 3,000,000원짜리 지급결의서(DJ-2026-0001)를 만들고 [처리] → [지출 새로 등록] → 금액 3,000,000 그대로 [처리 완료]. 거래내역 화면에는 3,000,000원 지출이 status='지급완료'로 정상 표시되지만, 기준정보 계좌 화면·홈 대시보드의 계좌 잔액 합계는 1원도 줄지 않는다. 결의서로 집행한 지출이 쌓일수록 계좌 잔액이 실제보다 계속 커지고, 사용자는 통장과 안 맞는 이유를 알 수 없다. F-02(급여·용역 지급이 잔액 미반영)와 정확히 같은 유형이 결의서 도메인에 남아 있는 것.

---

### P0 · 지급결의서 '기존 지출 연결'(mode=link) 처리가 거래 status를 '지급완료'로 바꾸지 않아, 결의서·청구서는 완료인데 계좌 잔액에서는 그 지출이 빠지지 않는다 (F-02 동형)

- **위치**: `server/routes/resolutions.js:184`
- **분류**: money
- **id**: `resolution-link-leaves-txn-pending`

**근거**

mode='link' 분기는 거래에 결의서 문서번호만 찍는다:
```js
linkedTxnId = txn_id
await conn.execute("UPDATE transactions SET doc_no = ? WHERE id = ? AND (doc_no IS NULL OR doc_no = '' OR doc_no = '공통')", [r.doc_no, txn_id])
```
status는 손대지 않는다. 반면 같은 핸들러의 mode='create' 분기(line 197)는 status를 `'지급완료'`로 하드코딩해 넣는다 — 저자도 이 값이 필요하다는 걸 알고 있었다(payroll.js:245, work-contracts.js:401에 "status '지급완료'(공백 없음) — 계좌 잔액 계산(accounts.js)이 이 값만 지출로 센다"는 주석까지 있다).

계좌 잔액은 지출을 status='지급완료'인 것만 센다 — server/routes/accounts.js:11
```sql
COALESCE((SELECT SUM(amount) FROM transactions WHERE kind='expense' AND account_id=a.id AND status='지급완료'), 0) AS expense_total
```

그런데 연결 후보 목록(resolutions.js:141-148 `/:id/matchable`)은 status 필터가 전혀 없어 미완료 지출도 그대로 후보로 내려준다:
```sql
WHERE t.kind='expense' AND t.id NOT IN (SELECT txn_id FROM expense_resolutions WHERE txn_id IS NOT NULL)
```
그리고 미완료 지출을 실제로 만들어내는 경로가 있다 — server/routes/recurring.js:73 (정기지출 자동 생성)이 status `'지급 대기'`로 거래를 INSERT한다.

반면 같은 트랜잭션 안에서 청구서는 완납 처리된다(resolutions.js:220-222):
```js
const status = Number(paid) >= Number(inv.total_amount) ? '지급 완료' : '일부 지급'
await conn.execute('UPDATE invoices SET status = ? WHERE id = ?', [status, r.invoice_id])
```
'지급 완료'는 invoices.js:8 PAYABLE_STATUSES에 없으므로 미지급금 집계에서도 빠진다.

**실패 시나리오**

1) 매입처에 정기지출을 걸어두고 정기지출 생성을 실행한다 → transactions에 status='지급 대기'인 지출 1건이 생긴다(recurring.js:73).
2) 그 매입 청구서에서 지급결의서를 만든다(POST /api/resolutions/from-invoice/:invoiceId).
3) 결의서 처리 Drawer(src/screens/Docs.jsx:462-471)에서 '기존 지출에 연결'을 고르고 1)의 거래를 선택 → POST /api/resolutions/:id/process { mode:'link', txn_id }.
4) 결과: 결의서 status='완료', 청구서 status='지급 완료' → 미지급금 목록·미지급 총액에서 사라진다. 화면에는 "기존 지출에 연결했어요. 청구서도 지급 처리됐어요" 토스트가 뜬다.
5) 그러나 거래 status는 여전히 '지급 대기' → accounts.js calcBalance의 expense_total에 안 잡힘 → **계좌 잔액이 지급액만큼 줄지 않는다.**

즉 그 금액만큼 미지급금은 사라졌는데 통장 잔액은 그대로 남아, 회사 순자산이 지급액만큼 과대 계상된다. 거래내역 화면에서 그 건만 '지급 대기'로 보이는 것 외에는 아무 경고가 없어 사용자가 알아채기 어렵다. mode='create'로 처리했을 때와 결과가 달라지는 것도 눈치채기 어렵다.

---

### P0 · 거래 금액을 수정해도 invoice_matches.amount 와 청구서 상태가 갱신되지 않아, 청구서 정산액이 옛 금액 그대로 남는다

- **위치**: `server/routes/transactions.js:126`
- **분류**: money
- **id**: `txn-put-invoice-match-desync`

**근거**

transactions.js:124-131 의 PUT 은 `UPDATE transactions SET ... amount=?, date=?, ...` 로 금액을 바꾸지만 invoice_matches 를 전혀 건드리지 않는다. 정산 매칭 금액은 별도 행(invoices.js:194 `INSERT INTO invoice_matches (id, invoice_id, txn_id, amount)`)에 복사돼 저장되고, 청구서 상태는 invoices.js:196-199 처럼 `SUM(invoice_matches.amount)` 로만 재계산된다. 같은 파일의 DELETE(transactions.js:191-204)는 삭제 시 매칭을 지우고 청구서 상태를 재계산하는데, PUT 에는 그 대응 로직이 전혀 없다. 프론트도 거래 편집을 막지 않는다 — src/screens/Ledger.jsx:427 의 [편집] 버튼은 invoice_id 유무와 무관하게 항상 노출된다.

**실패 시나리오**

매출 청구서 5,000,000원을 '입금 처리'해 정산 거래가 생성됨(invoice_matches.amount=5,000,000, 청구서='입금 완료'). 나중에 실제 입금이 3,000,000원이었음을 확인하고 거래내역 → 해당 거래 → [편집]에서 금액을 3,000,000으로 고쳐 저장. 계좌 잔액은 3,000,000만 반영되지만 invoice_matches 는 5,000,000 그대로라 청구서는 계속 '입금 완료'이고 미수금 목록에서도 빠진다. 받지 못한 2,000,000원이 장부에서 조용히 사라진다. (매입 청구서·지급 방향도 동일)

---

### P0 · '미수금 현황' 보고서가 실 API를 전혀 조회하지 않고 빈 상수를 읽어 미수금을 항상 0원으로 표시한다

- **위치**: `src/screens/Docs.jsx:1658`
- **분류**: money
- **id**: `report-ar-always-zero`

**근거**

ReportAR 본문: `const { summary = {}, rows = [] } = SAMPLE.receivables || {}` — 여기서 SAMPLE은 같은 파일 4~8행에 선언된 빈 플레이스홀더 상수다(`receivables: { summary: { total: 0, thisMonth: 0, overdue: 0, longOverdue: 0 }, rows: [] }`). api.getReceivables() 같은 실 조회가 이 컴포넌트 어디에도 없다. 결과적으로 1662~1665행의 StatCard 4개(미수금 합계/이번 달 회수 예정/기한 초과/장기 미수)에 value=0이 넘어가고, StatCard는 `typeof value === 'number'`이면 fmtNum으로 렌더하므로 화면에는 '0원'이 확신 있는 숫자로 찍힌다. 같은 앱의 ar 화면(App.jsx:350 BillingScreen role='collect')은 api를 통해 실제 미수 잔액을 보여주므로 두 화면이 서로 다른 숫자를 말한다.

**실패 시나리오**

실제로 미수금 3건·합계 4,500만원이 남아 있는 테넌트에서 경영관리 → 장부관리 → 보고서 → '미수금 현황'을 연다. 상단 카드에 '미수금 합계 0원 / 기한 초과 0원 / 장기 미수 0원'이 표시되고 표는 비어 있다. 사용자는 회수할 미수금이 없다고 판단해 독촉을 중단한다. 화면 하단 '{오늘 날짜} 조회 기준'(2044행) 문구까지 붙어 있어 최신 실데이터로 오인하기 쉽다.

---

## P1 (16건)

### P1 · 계약 지표(METRIC_COLS)의 지출 합계에 status 필터가 없어 매입 계약 상세의 '지급액'이 아직 나가지 않은 지급 대기분까지 포함한다

- **위치**: `server/routes/contracts.js:65`
- **분류**: money
- **id**: `contract-metric-no-status-filter`

**근거**

contracts.js:63-70 — out_total·term_out에 status 조건이 없다:
```
COALESCE((SELECT SUM(amount) FROM transactions WHERE contract_id=c.id AND kind='expense'),0) AS out_total,
...
COALESCE((SELECT SUM(amount) FROM transactions WHERE contract_id=c.id AND kind='expense'
          AND (c.current_term_start IS NULL OR date >= c.current_term_start)),0)  AS term_out,
```
이 값이 그대로 매입 계약의 '지급액'과 '남은 계약분'이 된다(contracts.js:28,32-33,43):
```
const out = Number(r.out_total || 0)     // 이 계약이 근거인 지출 = 매입계약의 지급액
const collected      = isPurchase ? out : in_done
const remain = termTotal == null ? null : Math.max(0, termTotal - term_collected)
```
같은 파일의 다른 두 집계는 정반대로 status를 거른다 — contracts.js:459 `if (t.status !== '지급완료') continue`, contracts.js:793 `AND status='지급완료'`. 계좌 잔액(accounts.js:11)·경영도우미(analytics.js:72)도 '지급완료'만 센다. 즉 같은 계약을 보는 화면끼리 숫자가 어긋난다.
'지급 대기' 지출이 매입 계약에 붙는 경로는 실재한다: contracts.js:701-705가 매입 계약(gubu A·E)에 recurring_expenses를 contract_id와 함께 만들고, recurring.js:73이 그 계약 id를 단 '지급 대기' 거래를 생성한다.

**실패 시나리오**

1) 매입 정기 계약(월 1,100,000원, 12개월)에 정기지출을 건다. 2) '정기지출 생성'을 눌러 이번 달 회차가 '지급 대기'로 생성된다(아직 이체 전). 3) 계약 상세를 열면 '지급액 1,100,000원', '남은 계약분'이 1,100,000원 줄어 있다 — 실제로는 한 푼도 안 나갔다. 4) 같은 화면의 원가 실적 타일(contracts.js:456-466)과 계좌 잔액은 0원 그대로다. 사용자는 계약별 집행률을 실제보다 앞서 있는 것으로 오인하고, 지급 대기분을 이중으로 지급할 위험이 생긴다.

---

### P1 · 계약 청구일정 발행이 UTC 기준 '오늘'로 청구서 발행일·채번연도·정산 거래일을 찍어, KST 00~09시에는 하루(연말이면 연도까지) 전으로 기록된다

- **위치**: `server/routes/contracts.js:279`
- **분류**: date
- **id**: `schedule-issue-utc-today`

**근거**

POST /contracts/schedule/:milestoneId/issue 내부:
  279: const today = new Date().toISOString().slice(0, 10)
  280: const year = today.slice(0, 4)
  288: const invoice_no = `${prefix}-${year}-...`
  296: [ ... issued_at=today ... ]
  305: '수금', total, date || today, '계좌이체',
`toISOString()`은 서버 TZ와 무관하게 항상 UTC 달력일이다. 같은 파일 3행에서 import 하는 `futureDateError`(server/db.js:1170)는 `kstToday()`(db.js:1167 = UTC+9)와 비교하므로, 이 라우트 안에서 '오늘'의 정의가 두 개(UTC / KST)로 갈린다. 같은 트랜잭션에서 만드는 정산 거래의 날짜는 프런트가 보낸 KST 값(src/screens/Billing.jsx:890 `localDate()` → PaidIssueDrawer가 `date`로 전송)이라, invoices.issued_at 과 transactions.date 가 서로 다른 날이 되어버린다.

**실패 시나리오**

KST 2027-01-01 08:00(=UTC 2026-12-31 23:00)에 경리가 '기입금 처리'로 청구 일정을 발행한다. 프런트는 date='2027-01-01'(localDate)을 보내고 futureDateError는 kstToday()='2027-01-01'과 비교해 통과한다. 그러나 서버의 today='2026-12-31'이 되어 ① 청구서 issued_at='2026-12-31', ② invoice_no='청구-2026-00xx'(2027년 첫 청구서가 2026년 번호를 가져감), ③ 정산 거래 date는 '2027-01-01'. 결과적으로 tax.js /vat(`YEAR(issued_at)`, `QUARTER(issued_at)`, 45~53행)는 이 매출을 2026년 4분기 매출세액으로 집계하고, 거래내역·월별 집계는 2027년 1월로 잡아 부가세 신고자료와 장부가 서로 다른 기간을 가리킨다. 사용자에게는 아무 경고도 뜨지 않는다.

---

### P1 · 입금·급여·용역 지급 거래 생성 시 date가 비면 UTC 오늘로 폴백하는데, 청구서 매칭 화면은 '필수' 표시만 하고 빈 날짜를 막지 않는다

- **위치**: `server/routes/invoices.js:187`
- **분류**: date
- **id**: `txn-date-fallback-utc`

**근거**

invoices.js POST /:id/matches — 새 정산 거래 INSERT:
  187: date || new Date().toISOString().slice(0, 10), '계좌이체',
같은 패턴이 돈이 실제로 나가는 다른 두 경로에도 있다:
  server/routes/payroll.js:243  `date || new Date().toISOString().slice(0, 10),` (급여 지급 지출)
  server/routes/work-contracts.js:398 `date || pay_date || new Date().toISOString().slice(0, 10),` (용역·일용 지급 지출), :375 는 같은 값으로 payroll.month 버킷까지 정한다
프런트 가드는 금액만 본다 — src/screens/Billing.jsx:113~122 `handleMatch()`는 `if (!amount) return` 뿐이고 matchDate가 ''여도 `onMatch(invoice.id, amount, matchDate, …)`로 그대로 넘긴다. 라벨(283행)은 "입금일 *  · 기본값: 오늘"로 필수라고 표시돼 있다.

**실패 시나리오**

청구서 상세 → 입금 매칭에서 사용자가 날짜 입력칸을 지우고(<input type="date"> 는 비우면 '') 금액만 넣은 뒤 매칭 처리한다. 클라이언트 검증이 없어 date=''로 전송되고, 서버는 futureDateError('')를 통과시킨 뒤 UTC 오늘 날짜로 입금 거래를 만든다. KST 2026-08-01 02:00에 하면 거래일이 '2026-07-31'이 되어 7월 매출로 집계된다. 사용자는 '기본값: 오늘'이라는 안내만 봤을 뿐 실제로 어떤 날짜가 들어갔는지 확인할 기회가 없다.

---

### P1 · 급여대장 삭제/월 비우기가 transactions.payroll_id를 NULL로 끊어, 재생성 시 이미 지급한 급여가 전액 '미지급'으로 되살아나고 재지급을 유도한다

- **위치**: `server/routes/payroll.js:283`
- **분류**: transaction
- **id**: `payroll-unlink-regenerate-double-pay`

**근거**

payroll.js:282-286 (월 전체 비우기)
```
await conn.execute(
  'UPDATE transactions SET payroll_id = NULL WHERE payroll_id IN (SELECT id FROM payroll WHERE month = ? AND seq = 0)',
  [req.params.month]
)
await conn.execute('DELETE FROM payroll WHERE month = ? AND seq = 0', [req.params.month])
```
payroll.js:298-299 (건별 삭제)도 동일하게 `UPDATE transactions SET payroll_id = NULL WHERE payroll_id = ?` 후 DELETE.

지급 여부 판정은 전적으로 이 링크에 의존한다 — payroll.js:71-75 `enrich()`
```
SELECT id, amount, date, method, account_id, memo FROM transactions WHERE payroll_id = ?
const paid = txns.reduce((s, t) => s + Number(t.amount), 0)
```
링크가 끊긴 거래를 급여대장에 **다시 연결하는 API/화면은 어디에도 없다**(payroll.js 전체에 payroll_id를 SET하는 문은 지급 INSERT 뿐).

재생성은 기존 seq=0 행 유무만 본다 — payroll.js:194 `SELECT employee_id FROM payroll WHERE month = ? AND seq = 0`. 월을 비운 뒤에는 이 집합이 비어 있어 전원 새로 만들어지고 paid=0이 된다.

summary도 같은 enrich를 쓴다 — payroll.js:122 `unpaidTotal = list.reduce((s, r) => s + r.unpaid, 0)`.

**실패 시나리오**

2026-07 급여 22명 5,000만원을 전부 지급 등록해 '지급완료' 상태. 이후 급여 항목 하나를 잘못 넣은 걸 발견해 '급여대장 전체 삭제'(확인 문구는 "지출 거래는 거래내역에 남고 연결만 끊겨요"만 알려줌) → '급여대장 생성' 클릭.
결과: 급여대장 22행이 전부 '미지급'으로 표시되고, 대표님용 요약(GET /payroll/summary)의 미지급 총액이 0원 → 5,000만원, 지급완료가 5,000만원 → 0원으로 뒤집힌다. 거래내역에는 지급 거래 22건이 payroll_id 없이 그대로 남아 있어 총 지출은 정상이므로 대조가 어렵다. 경리가 화면을 믿고 다시 '지급 등록'을 하면 지출 거래가 이중으로 쌓이고(계좌 잔액이 실제보다 5,000만원 적게 표시), 실제로 이체까지 하면 이중 출금이 된다. 되돌릴 방법(재연결)이 없다.

---

### P1 · 결의서 '기존 지출에 연결'도 지출 거래의 지급 대기 status를 그대로 둔 채 결의서·청구서만 완료 처리한다

- **위치**: `server/routes/resolutions.js:184`
- **분류**: money
- **id**: `resolution-link-pending-txn`

**근거**

resolutions.js:179-184 — mode='link'는 kind만 확인하고 status는 검사·갱신하지 않는다:
```
const [[t]] = await conn.execute("SELECT id FROM transactions WHERE id = ? AND kind='expense'", [txn_id])
if (!t) { ... 404 ... }
linkedTxnId = txn_id
await conn.execute("UPDATE transactions SET doc_no = ? WHERE id = ? AND (doc_no IS NULL OR doc_no = '' OR doc_no = '공통')", [r.doc_no, txn_id])
```
그 뒤 resolutions.js:220-222에서 청구서를 '지급 완료'로, :228에서 결의서를 '완료'로 바꾼다. 연결 후보 쿼리(resolutions.js:141-148)는 status를 SELECT해 내려주기까지 하면서도 필터에는 쓰지 않는다:
```
SELECT t.id, t.date, t.amount, t.category, t.status, v.name AS vendor_name
FROM transactions t ... WHERE t.kind='expense'
  AND t.id NOT IN (SELECT txn_id FROM expense_resolutions WHERE txn_id IS NOT NULL)
```

**실패 시나리오**

1) 정기지출 자동 생성으로 '지급 대기' 지출 거래가 만들어져 있다(recurring.js:73). 2) 매입 청구서에서 지급결의서를 만들고 '처리' → '기존 지출에 연결'로 그 거래를 고른다. 3) 결의서는 '완료', 청구서는 '지급 완료', 미지급금 목록에서 제거된다. 4) 그러나 거래 status는 '지급 대기'로 남아 계좌 잔액(accounts.js:11)·경영도우미 매입 집계(analytics.js:72)·계약 원가 실적(contracts.js:459)에서 모두 빠진다. 결재까지 끝난 지출이 잔액에는 영원히 반영되지 않는다.

---

### P1 · 결의서 처리로 생성된 지출에 contract_id 가 없어, 매입계약 상세의 지급 내역·원가 실적에서 통째로 누락된다

- **위치**: `server/routes/resolutions.js:193`
- **분류**: money
- **id**: `resolution-create-no-contract`

**근거**

resolutions.js:193 의 INSERT 컬럼 목록은 `(id, kind, vendor_id, account_id, category, amount, date, method, status, buyer_type, doc_no, memo)` 로 contract_id / cost_contract_id 가 아예 없다. 그런데 이 결의서는 `/from-invoice/:invoiceId`(resolutions.js:82-133)로 매입 청구서에서 만들어질 수 있고, 그 청구서는 contract_id 를 가진다. 비교 대상인 청구서 정산 경로 invoices.js:186-189 는 `inv.contract_id` 를 그대로 거래에 넣는다. 계약 상세는 contracts.js:425-431 `WHERE t.${isPurchaseC ? 'contract_id' : 'cost_contract_id'}=? AND t.kind='expense'` 로, 원가분석은 contracts.js:793 `WHERE contract_id = ? AND kind='expense' AND status='지급완료'` 로 집계한다.

**실패 시나리오**

외주 매입계약에 걸린 청구서 5,000,000원 → 청구서 화면에서 [지급결의서 만들기] → 결의서 [처리] → [지출 새로 등록]. 돈은 나갔고 거래내역에도 있지만, 그 매입계약 상세의 '지출' 탭과 '원가 실적'에는 0원으로 남는다. 같은 청구서를 결의서를 거치지 않고 청구서 화면에서 바로 '지급 처리'했다면 5,000,000원이 잡혔을 자리다. 즉 어느 경로로 처리했느냐에 따라 계약별 원가·수익성 숫자가 달라진다.

---

### P1 · 이미 다른 결의서에 연결된 지출 거래에 두 번째 결의서를 중복 연결할 수 있어, 한 번 나간 돈으로 두 건의 지출이 '집행 완료'된다

- **위치**: `server/routes/resolutions.js:181`
- **분류**: transaction
- **id**: `resolution-link-duplicate-txn`

**근거**

resolutions.js:181 `const [[t]] = await conn.execute("SELECT id FROM transactions WHERE id = ? AND kind='expense'", [txn_id])` — 존재 여부와 kind 만 본다. 같은 파일 :145 의 후보 조회는 `AND t.id NOT IN (SELECT txn_id FROM expense_resolutions WHERE txn_id IS NOT NULL)` 로 이미 연결된 거래를 제외하지만, 실제 처리 경로에는 그 검사가 없다. db.js:359-378 의 expense_resolutions 스키마에도 txn_id UNIQUE 제약이 없다(UNIQUE 는 doc_no 뿐). :184 의 `UPDATE transactions SET doc_no = ? WHERE id = ? AND (doc_no IS NULL OR doc_no = '' OR doc_no = '공통')` 은 이미 doc_no 가 찍힌 거래를 조용히 건너뛰기만 하고 에러를 내지 않으며, 그 뒤 :228 은 무조건 `status='완료', txn_id=?` 로 확정한다. 결의서가 invoice_id 를 가진 경우에만 :212 의 dupMatch 검사에 걸려 막힌다 — 청구서 없는 직접 등록 결의서는 아무 방어가 없다.

**실패 시나리오**

직접 등록 결의서 A(80만원)와 B(80만원)를 만들고 두 개의 처리 드로어를 연다(또는 A 처리 후 목록을 새로고침하지 않고 B를 연다 — 후보 목록은 Docs.jsx:457 에서 드로어 열 때 한 번만 가져온다). A를 지출 거래 T에 연결해 처리. 이어서 B의 드로어에 아직 남아 있는 T를 골라 처리하면 성공한다. 결과: T 한 건(80만원)으로 A·B 두 결의서가 모두 '완료'가 되어 목록에서 사라지고, B에 해당하는 80만원 지출은 영원히 장부에 기록되지 않는다. 게다가 /by-txn/:txnId(:41)는 `[[r]]`로 한 건만 돌려주므로 거래 증빙 영역에서는 결의서가 하나만 보여 중복을 눈치챌 수 없다.

---

### P1 · 부가세·기타세액을 '납부일 미입력'으로 완료 처리하면 미래날짜 검사를 그대로 통과한 뒤 지출/입금 거래 날짜가 UTC 오늘로 임의 기록된다

- **위치**: `server/routes/tax.js:22`
- **분류**: date
- **id**: `tax-payment-utc-fallback`

**근거**

syncTaxTxn():
  22: const d = date || new Date().toISOString().slice(0, 10)
호출부 가드는 값이 있을 때만 동작한다:
  92: if (isDoneStatus) { const de = futureDateError(paid_date); if (de) return ... }
  161: const otFutureErr = (body) => (…) ? futureDateError(body.paid_date) : null
`futureDateError`(server/db.js:1170)는 `(date && date > kstToday()) ? … : null` 이므로 date가 ''/null이면 항상 null(통과)이다. 프런트는 빈 값을 허용한다 — src/screens/Tax.jsx:21 `paid_date: ''`, :61 `paid_date: form.paid_date || null`, :278 동일. 그리고 vat_filings/other_taxes 에는 paid_date=NULL 이 저장되지만(114·119행) transactions 에는 d(UTC 오늘)가 들어간다.

**실패 시나리오**

경리가 부가세 화면에서 상태를 '납부 완료'로 바꾸고 납부금액만 입력한 뒤 납부일 칸을 비워둔 채 저장한다. 검증을 통과하고, 계좌 잔액에 즉시 반영되는 '지급완료' 지출 거래가 생성되는데 그 날짜는 사용자가 지정한 적 없는 UTC 오늘이다. KST 2027-01-01 03:00에 저장하면 거래 날짜가 '2026-12-31'이 되어 2026년 비용으로 계상된다. 화면(Tax.jsx:433)에는 납부일이 '—'로 표시되므로 사용자는 장부에 어떤 날짜가 박혔는지 볼 수도 없고, 세금 화면과 거래내역의 기간 귀속이 어긋난 것을 알아챌 수 없다.

---

### P1 · 거래 삭제 시 세금 납부(vat_filings/other_taxes)·급여 상위 문서가 되돌려지지 않고, 409 안내문은 실제로 보호되지 않는 대상까지 보호된다고 말한다

- **위치**: `server/routes/transactions.js:205`
- **분류**: transaction
- **id**: `txn-delete-no-tax-payroll-revert`

**근거**

transactions.js:191-205 의 DELETE 는 invoice_matches 만 정리하고 청구서·마일스톤 상태를 재계산한 뒤 `DELETE FROM transactions WHERE id = ?` 를 실행한다. payroll_id / vat_filings.txn_id / other_taxes.txn_id / recurring_id 에 대한 처리는 없다. 그리고 이 컬럼들은 FK 가 아니다 — db.js:611-617 의 ensureColumn 은 `ALTER TABLE ... ADD COLUMN ${ddl}` 만 실행하고, db.js:635 `ensureColumn('vat_filings','txn_id',"txn_id VARCHAR(36)")`, :639 `ensureColumn('other_taxes','txn_id',...)`, :651 `ensureColumn('transactions','payroll_id',...)` 모두 순수 컬럼 추가라 FK 제약이 붙지 않는다. 따라서 :210-211 의 `if (e.code === 'ER_ROW_IS_REFERENCED_2' ...) return res.status(409).json({ error: '지급결의서·급여에 연결된 거래라 삭제할 수 없어요' })` 는 FK 가 실제로 있는 결의서(db.js:376 `FOREIGN KEY (txn_id) REFERENCES transactions(id)`)에만 발동하고, 급여·세금 연결 거래는 아무 경고 없이 그냥 삭제된다.

**실패 시나리오**

부가세 1기 확정 5,000,000원을 세금 화면에서 '납부 완료'로 처리하면 tax.js:36-40 이 지출 거래를 만들고 vat_filings.txn_id 에 연결한다. 이후 경리가 거래내역 화면에서 그 지출 행을 열고 [삭제]를 누르면(Ledger.jsx:422) 그대로 지워진다. 부가세 화면은 여전히 '납부 완료 / 납부액 5,000,000'(tax.js:GET /vat 는 vat_filings.status·paid_amount 를 그대로 읽음)인데 거래내역에는 그 지출이 없고 계좌 잔액은 5,000,000 늘어난 상태로 남는다. 사용자는 '삭제하면 세금 납부 기록도 같이 취소되겠지' 또는 반대로 '결의서·급여처럼 막아주겠지'라고 믿지만 둘 다 아니다. 급여 지급 거래도 마찬가지로 삭제되며 payroll.status 는 '지급완료'로 남는다.

---

### P1 · 용역·일용 지급에서 account_id가 비면 임의의 은행계좌(생성일 최초)로 조용히 대체되고, 은행계좌가 하나도 없으면 NULL이 되어 잔액에서 누락된다

- **위치**: `server/routes/work-contracts.js:391`
- **분류**: money
- **id**: `service-pay-arbitrary-account-fallback`

**근거**

work-contracts.js:390-400
```
const [[defAcc]] = await conn.execute("SELECT id FROM accounts WHERE kind='bank' ORDER BY created_at LIMIT 1")
const acc = account_id || (defAcc ? defAcc.id : null)
...
INSERT INTO transactions (... account_id ...) VALUES (..., acc, ...)
```
두 가지 문제가 한 줄에 있다.
1) 폴백이 '가장 먼저 만든 은행계좌'라 실제 출금 계좌와 무관하다. 프론트 기본값은 다른 기준으로 고른다 — src/screens/WorkContract.jsx:850 `api.getAccounts().then(a => { ...; const bank = a.find(x => x.kind === 'bank'); if (bank) setAccountId(bank.id) })` 이고 GET /accounts는 `ORDER BY name`(accounts.js:22)이라 **서버 폴백(created_at 최초)과 프론트 기본값(이름순 첫 은행계좌)이 서로 다른 계좌를 가리킬 수 있다**.
2) `kind='bank'` 계좌가 0건이면 defAcc가 undefined → acc = null → accounts.js:11의 `account_id=a.id` 조건에 걸리지 않아 지출이 어떤 계좌 잔액에서도 차감되지 않는다(F-02와 동일 증상).
두 경우 모두 오류나 경고 없이 200 OK로 끝난다.

**실패 시나리오**

(1) 급여이체 전용인 하나은행 *7231에서 용역비를 이체했는데, ServicePayDrawer의 계좌 콤보박스를 확인하지 않고 저장하면 기업은행 *4010에서 차감된 것으로 기록된다 → 두 계좌 잔액이 동시에 틀어지고, 통장 대사 전까지 드러나지 않는다.
(2) 카드만 등록하고 은행계좌를 아직 등록하지 않은 신규 테넌트에서 용역비 2,000,000원을 '지금 지급' 체크로 등록하면, 거래내역에는 '용역비 2,000,000원 지급완료'가 남지만 account_id가 NULL이라 계좌 잔액 어디에도 반영되지 않는다.

---

### P1 · 정기청구 소급분 정리 스크립트가 db.js에서 export되지 않는 pool을 구조분해로 가져와, 실행 즉시 TypeError로 죽는다 (동작한 적 없는 코드)

- **위치**: `server/scripts/cleanup-recurring-invoices.js:25`
- **분류**: deadcode
- **id**: `cleanup-script-pool-undefined`

**근거**

```js
const { pool } = require('../db')
```
그러나 server/db.js:1178 은
```js
module.exports = { initDb, kstDate, kstToday, futureDateError }
```
이고 바로 위 1174-1177 주석이 "⚠ pool은 의도적으로 export 하지 않는다 … export를 막아두면 실수로 가져다 쓰는 코드가 조용히 동작하지 않고 즉시 터진다"고 명시한다. 따라서 `pool`은 `undefined`이며, main()의 첫 질의인 line 49 `await pool.execute(...)` 에서 `TypeError: Cannot read properties of undefined (reading 'execute')`로 죽는다. line 86 `await pool.getConnection()`(삭제 트랜잭션)도 마찬가지로 도달 불가능하다.

이 파일은 server/scripts/ 에 있어 격리 정적 검사의 대상이 아니다 — check-isolation.js:19,31 은 `ROUTES_DIR`(routes/)만 읽는다. 그래서 자동 검사에도 안 걸린다.

덧붙여, 설령 pool이 있었더라도 이 스크립트는 env의 단일 DB_NAME 풀을 쓰므로 멀티테넌트에서 어느 회사 DB를 지우는지 지정할 방법이 없다(파일 상단 사용법에 회사 지정 인자가 없다).

**실패 시나리오**

운영자가 파일 주석의 사용법대로 `node server/scripts/cleanup-recurring-invoices.js --vendor "금강노인종합복지관"` 을 실행하면, 미리보기 표조차 못 찍고 `TypeError: Cannot read properties of undefined (reading 'execute')` 스택트레이스만 뱉고 exit 1 한다. 소급 생성돼 쌓인 '입금 예정' 청구서(미수금을 부풀리는 원인)를 정리할 수단이 실제로는 존재하지 않는 상태다. 에러 메시지가 DB 연결 실패처럼 보여 운영자가 DB/네트워크를 의심하며 시간을 버리게 된다.

---

### P1 · 청구서 직접 등록 폼이 발행일을 UTC 기준으로 채워, 같은 파일이 다른 곳에서 쓰는 KST 기준(localDate)과 어긋난다

- **위치**: `src/screens/Billing.jsx:464`
- **분류**: date
- **id**: `invoice-issued-at-utc`

**근거**

InvoiceFormDrawer.handleSave():
  464: issued_at: editInvoice ? editInvoice.issuedAt : new Date().toISOString().slice(0, 10),
같은 파일 61~64행에는 로컬 달력 기준 헬퍼가 이미 있고(`const localDate = () => \`${d.getFullYear()}-…\``) 289·937행의 date input `max`와 69행 matchDate 기본값은 그 헬퍼를 쓴다. 즉 한 화면 안에서 발행일만 UTC 기준이다. 이 값은 그대로 POST /invoices → invoices.issued_at 으로 저장되고, server/routes/invoices.js:102 의 채번 연도(`String(issued_at).slice(0,4)`)와 server/routes/tax.js:47~52 의 `YEAR/QUARTER(issued_at)` 부가세 분기 집계의 기준이 된다.

**실패 시나리오**

KST 2026-10-01 07:00에 청구서를 새로 등록하면 issued_at='2026-09-30'으로 저장된다. 화면에는 사용자가 발행일을 고를 입력칸이 없으므로 잘못된 날짜를 알아챌 수 없고, 부가세 화면에서 이 매출세액이 3분기(Q3)에 잡힌다 — 실제로는 4분기(Q4) 발행분이다. 분기 신고 자료가 조용히 틀어진다.

---

### P1 · 보고서 화면 10개 중 5개(월별 입출금·계약별 손익·비목별 지출·발주처별 거래·외주가공비)가 빈 SAMPLE 상수를 집계해 총액을 0원으로 표시한다

- **위치**: `src/screens/Docs.jsx:1346`
- **분류**: money
- **id**: `report-sample-empty-5reports`

**근거**

ReportMonthly: `const incomes = filterByPeriod(SAMPLE.incomes, period)` / `const expenses = filterByPeriod(SAMPLE.expenses, period)`. 동일 패턴이 ReportContract 1497행(`SAMPLE.contractSummary.map(...)`), ReportCategory 1548행(`filterByPeriod(SAMPLE.expenses, period)`), ReportVendor 1597행(`filterByPeriod(SAMPLE.incomes, period)`), ReportSubcontract 1706·1721행(`filterByPeriod(SAMPLE.expenses, period)`)에 있다. SAMPLE.incomes / expenses / contractSummary는 4~8행에서 모두 `[]`로 선언돼 있고 이 파일에는 이들을 채우는 코드가 없다. 부수적으로 1311~1314행 ALL_MONTHS도 `SAMPLE.incomes`/`SAMPLE.expenses`에서 월을 뽑으므로 항상 빈 배열이 되어 PeriodFilter(1316행)에는 '전체' 칩 하나만 남는다. 반면 같은 화면의 tax4(1421행 api.getPayroll)·vat(1908행 api.getVatSummary)는 실 API를 쓴다 — 즉 한 화면 안에서 실데이터 보고서와 빈 상수 보고서가 섞여 있다.

**실패 시나리오**

거래내역이 수백 건 쌓인 상태에서 보고서 → '월별 입금/지출 현황'을 연다. '총 입금 0원 / 총 지출 0원 / 순차액 0원'이 뜨고 표는 비어 있으며 기간 칩도 '전체' 하나뿐이다. '계약별 손익 현황'은 '총 수주금액 0원 / 총 손익 0원 / 평균 이익률 0%', '비목별 지출 현황'은 '총 지출 0원 / 비목 수 0개'로 나온다. 사용자는 이번 달 실적이 0이라고 오인하거나, 보고서 기능 자체가 고장난 것으로 판단한다.

---

### P1 · '방산 납품 실적 보고서'가 0/0 나눗셈으로 이행률에 'NaN%'를 출력한다

- **위치**: `src/screens/Docs.jsx:1776`
- **분류**: error
- **id**: `report-defense-nan`

**근거**

1767행 `const rows = SAMPLE.contractSummary`(= 빈 배열) → 1768~1769행 `totalAmount = rows.reduce(...) = 0`, `totalDone = 0`. 1776행에서 `{(totalDone / totalAmount * 100).toFixed(1)}%` 를 렌더하는데 0/0 = NaN 이라 문자열 'NaN%'가 그대로 화면에 찍힌다. 바로 아래 1778행 `<RBar pct={(totalDone / totalAmount) * 100}/>` 도 pct=NaN → `width: 'NaN%'`라는 무효 CSS가 되어 막대가 그려지지 않는다. 같은 파일의 다른 보고서(1506행, 1730행, 1753행)는 `totalAmount > 0 ? ... : 0` 식으로 0 나눗셈을 막아두었는데 여기만 누락됐다.

**실패 시나리오**

보고서 → '방산 납품 실적 보고서'를 연다. 상단 '방산물자 납품 이행률' 옆에 'NaN%'가 표시되고 진행 막대는 비어 있다. 사용자에게는 명백한 오류 화면으로 보인다.

---

### P1 · '세무사 전달용 자료' 보고서가 하드코딩된 가짜 건수(16건·7건·5건…)를 실제 집계인 것처럼 보여주고 ZIP 다운로드는 토스트만 띄운다

- **위치**: `src/screens/Docs.jsx:1848`
- **분류**: other
- **id**: `report-taxoffice-hardcoded`

**근거**

1848~1856행 `const TAXOFFICE_DOCS = [{ label: '월별 입출금 내역', count: '16건', ready: true }, { label: '지출결의서 (승인 완료)', count: '7건', ready: true }, { label: '세금계산서 (매출)', count: '5건', ready: true }, ... { label: '증빙 누락 항목', count: '3건', ready: false }]` — 모두 고정 문자열이며 어떤 API도 호출하지 않는다. 1876~1886행에서 이 배열을 그대로 렌더해 '준비 완료' 체크 아이콘과 건수 뱃지를 붙인다. 1866행 기간 칩도 '2026년 3월/4월/5월'로 고정돼 있어 실제 조회 기간과 무관하다. 1871행 ZIP 버튼은 `onClick={() => toast.push(`${period} 자료를 ZIP으로 내려받았어요`)}` 뿐이라 파일이 실제로 만들어지지도 내려받아지지도 않는다.

**실패 시나리오**

부가세 신고 준비로 보고서 → '세무사 전달용 자료'를 연다. '월별 입출금 내역 16건 준비 완료', '급여대장 7명', '증빙 누락 항목 3건'이 표시된다. 실제 데이터가 몇 건이든 항상 같은 숫자가 나온다. 'ZIP 내려받기'를 누르면 '2026년 5월 자료를 ZIP으로 내려받았어요' 토스트가 뜨지만 브라우저 다운로드는 발생하지 않는다. 사용자는 세무사에게 자료를 보냈다고 믿고 실제로는 아무것도 전달하지 못한다.

---

### P1 · '부가세 신고 자료' 보고서의 신고기간·신고기한 배너가 분기 선택과 무관하게 고정돼 있고 과세기간 명칭도 틀렸다

- **위치**: `src/screens/Docs.jsx:1935`
- **분류**: date
- **id**: `report-vat-fixed-period-banner`

**근거**

1903행 `const [quarter, setQuarter] = useState('Q2')` 로 분기를 고르면 1906~1910행에서 `api.getVatSummary(quarter)`를 다시 호출해 아래 숫자는 분기별로 바뀐다. 그런데 1935~1936행 배너는 `<span>신고 기간: 2026.04.01 ~ 2026.06.30 (2기 예정신고)</span>` / `<span>신고 기한: 2026년 7월 25일</span>` 로 quarter를 전혀 참조하지 않는 고정 문자열이다. 게다가 4~6월은 부가가치세 제1기 확정신고 구간이지 '2기 예정신고'가 아니다(2기 예정신고는 7~9월분, 기한 10월 25일).

**실패 시나리오**

보고서 → '부가세 신고 자료'에서 'Q1 (1~3월)' 칩을 누른다. 아래 매출·매입 세금계산서 표와 매출세액/매입세액/납부세액 카드는 1~3월 데이터로 갱신되지만, 그 위 파란 배너는 여전히 '신고 기간: 2026.04.01 ~ 2026.06.30 (2기 예정신고) / 신고 기한: 2026년 7월 25일'이라고 표시된다. 사용자는 1분기 수치를 2분기 신고분으로 착각하거나, 신고 기한을 잘못 잡는다.

---

## P2 (14건)

### P2 · 결재선 기본 지정이 트랜잭션 없이 '전체 해제 → 대상 지정' 2문으로 나뉘어, 대상이 없으면 전체 해제만 남아 기본 결재선이 사라진다

- **위치**: `server/routes/approval-presets.js:47`
- **분류**: transaction
- **id**: `approval-default-clear-no-txn`

**근거**

PATCH /:id/default (line 45-52):
```js
await req.db.execute('UPDATE approval_presets SET is_default=0')
const [r] = await req.db.execute('UPDATE approval_presets SET is_default=1 WHERE id=?', [req.params.id])
if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
```
첫 문이 모든 행의 기본 지정을 지우는데, 두 번째 문이 0행이면 404만 반환하고 첫 문을 되돌리지 않는다. getConnection/beginTransaction이 전혀 없다. PUT /:id (line 34)도 같은 구조 — `if (is_default) await req.db.execute('UPDATE approval_presets SET is_default=0')` 뒤 UPDATE가 0행이면 404로 빠지면서 해제만 남는다.

이 값이 실제로 쓰이는 곳: server/routes/resolutions.js:13
```js
const [[p]] = await execFn('SELECT steps FROM approval_presets WHERE is_default=1 ORDER BY sort_order LIMIT 1')
```
기본이 하나도 없으면 line 16의 하드코딩 폴백(담당/결재/대표이사)으로 조용히 떨어진다.

프런트가 실패를 감추기까지 한다 — src/lib/api.js:548 setDefaultApprovalPreset은 예외를 삼켜 `{ok:false}`를 반환하는데, src/screens/Master.jsx:2033 makeDefault는 res.ok를 확인하지 않고 무조건 `"…을 기본으로 지정했어요"` 토스트를 띄운다.

**실패 시나리오**

브라우저 탭 A와 B에서 기준정보 > 결재선 화면을 연다. A에서 프리셋 '경영지원 결재선'을 삭제한다. B는 아직 옛 목록을 들고 있고, 거기서 그 프리셋의 '기본으로' 버튼을 누른다.
→ 서버는 먼저 전체 is_default=0을 실행하고, 대상 id가 없어 404를 반환한다. 프런트는 에러를 삼키고 "…을 기본으로 지정했어요" 성공 토스트를 띄운다.
→ 결과: 기본 결재선이 어느 프리셋에도 남아 있지 않다. 이후 만드는 모든 지급결의서(POST /resolutions, POST /resolutions/from-invoice/:id)가 회사가 설정한 결재선 대신 하드코딩 기본선(담당/결재/대표이사)으로 생성되고, 그 상태로 인쇄·결재까지 나간다.

---

### P2 · 원가분석 API가 폐기된 축(contract_id)으로 원가를 집계해 항상 0을 반환하며, 호출자도 없다

- **위치**: `server/routes/contracts.js:793`
- **분류**: deadcode
- **id**: `cost-analysis-wrong-axis-dead`

**근거**

contracts.js:792-795
```
const [txns] = await req.db.execute(
  "SELECT category, SUM(amount) AS total FROM transactions WHERE contract_id = ? AND kind='expense' AND status='지급완료' GROUP BY category",
  [req.params.id]
)
```
원가는 cost_contract_id 축으로 옮겨졌다. db.js:659-673의 마이그레이션이 매출 계약에 달려 있던 지출을 `SET t.cost_contract_id = t.contract_id, t.contract_id = NULL`로 이관했고, 같은 파일 contracts.js:66은 `cost_total`을 `WHERE cost_contract_id=c.id`로 집계하며, 계약 상세 지출 목록도 매출 계약이면 cost_contract_id를 본다(contracts.js:428 `WHERE t.${isPurchaseC ? 'contract_id' : 'cost_contract_id'}=?`). 이 엔드포인트만 옛 축을 쓴다.
또한 `grep -rn "cost-analysis|costAnalysis" src/ server/` 결과는 이 라우터 정의 1건뿐 — 프론트에 호출자가 없다.

**실패 시나리오**

매출 계약에 외주비 지출을 원가로 귀속(cost_contract_id)시킨 상태에서 GET /contracts/:id/cost-analysis 를 호출하면 actual이 전부 0, actualCostRate도 0으로 나온다. 계약 상세 화면이 보여주는 원가(cost_total)와 정반대 값이다. 현재는 호출자가 없어 사용자 피해는 없지만, 원가예산 탭을 구현하면서 이 엔드포인트를 그대로 붙이면 즉시 '원가 0원·이익률 100%'라는 잘못된 숫자가 화면에 나온다.

---

### P2 · catch에서 rollback이 실패하면 next(e)가 호출되지 않아, 응답을 영영 보내지 않고 요청이 매달린다 (express 4라 async 거부가 잡히지 않음)

- **위치**: `server/routes/invoices.js:203`
- **분류**: error
- **id**: `rollback-throw-swallows-next`

**근거**

```js
} catch (e) { await conn.rollback(); next(e) }
finally { conn.release() }
```
`conn.rollback()`이 거부하면 그 자리에서 throw되어 `next(e)`가 실행되지 않는다. finally의 release는 돌지만 응답은 나가지 않고, 핸들러가 반환한 Promise가 거부된 채 끝난다. server/package.json:22 는 `"express": "^4.18.2"` — express 4는 async 핸들러의 거부를 잡지 않으므로 에러 미들웨어로도 가지 않는다(UnhandledPromiseRejection만 남는다).

같은 형태가 트랜잭션 핸들러 전반에 반복된다: invoices.js:145,203,263 / contracts.js:241,314,399 / payroll.js:223,254,272,289,302 / work-contracts.js:245,270,302,315,406 / tax.js:125,177,195,208 / transactions.js:209,268 / resolutions.js:131,231 / vendors.js:113 / recurring.js:82 / recurring-invoices.js:161,207.

(참고: release 자체는 전부 finally에 있어 누수는 없다. 사전 스캔의 'getConnection 40 vs release 38' 격차는 poolManager.js:50의 래퍼 정의와 db.js:35의 initDb 폴백을 함께 센 결과로, 실제 라우트·스크립트는 37:37로 짝이 맞는다.)

**실패 시나리오**

청구서 입금 매칭(POST /api/invoices/:id/matches) 처리 중 MariaDB가 재시작되거나 wait_timeout으로 연결이 끊긴다. 트랜잭션 도중의 execute가 PROTOCOL_CONNECTION_LOST로 실패해 catch로 들어가고, 이어지는 `conn.rollback()`도 죽은 연결 위에서 거부한다.
→ next(e)가 호출되지 않아 클라이언트는 응답을 한 줄도 받지 못한다. src/lib/api.js의 fetch는 계속 대기 상태로 남고, 화면의 저장 버튼은 스피너로 굳는다. 사용자는 입금 매칭이 됐는지 안 됐는지 알 수 없어 새로고침 후 같은 매칭을 다시 시도하게 된다(실제로 첫 시도는 롤백되었는지조차 불확실하다). 서버 로그에는 요청 처리 결과가 남지 않고 UnhandledPromiseRejection만 찍힌다.

---

### P2 · 읽기 전용 급여·근로계약 조회가 트랜잭션도 아닌데 커넥션을 점유한 채 행마다 추가 질의를 돌려, 테넌트 풀(기본 3개)을 고갈시킨다

- **위치**: `server/routes/payroll.js:93`
- **분류**: other
- **id**: `readonly-routes-hold-pooled-conn`

**근거**

GET /api/payroll (line 92-106)는 트랜잭션이 없는데도 커넥션을 빌려 요청 내내 붙잡는다:
```js
const conn = await req.db.getConnection()
...
const out = []
for (const p of rows) out.push(await enrich(conn, p))
```
`enrich`(line 70-89)는 행마다 `SELECT ... FROM transactions WHERE payroll_id = ?` 를 1회씩 던진다. 같은 구조가 payroll.js:110(/summary, line 119), payroll.js:138(/employee/:id, line 147), work-contracts.js:102(목록, line 124 `withMetrics`), work-contracts.js:150(상세)에도 있다. 전부 beginTransaction이 없어 커넥션을 따로 빌릴 이유가 없는 코드다(같은 파일 line 163의 POST /는 req.db를 그냥 쓴다).

테넌트당 커넥션 한도는 3이다 — server/db/poolManager.js:20
```js
const CONN_LIMIT = Number(process.env.TENANT_POOL_CONN_LIMIT || 3)
```
그리고 poolManager.js:89 `waitForConnections: true` 라 한도를 넘긴 요청은 에러 없이 무기한 큐에 쌓인다(mysql2 기본 queueLimit=0, 타임아웃 없음).

**실패 시나리오**

직원 22명 · 12개월치 급여대장이 쌓인 상태에서 GET /api/payroll (month 미지정)을 호출하면 약 260행이 나오고, 핸들러는 커넥션 1개를 쥔 채 260번의 왕복 질의를 순차 수행한다.
경리 2명이 인사급여 화면을 열고 한 명이 근로계약 목록까지 여는 식으로 이런 요청이 동시에 3건만 겹치면 그 회사 풀의 커넥션 3개가 전부 점유된다. 그 순간 같은 회사의 다른 모든 API(홈 대시보드, 거래내역, 청구서)는 mysql2 대기 큐에 들어가 타임아웃도 없이 멈춘다 — 화면은 로딩 스피너로 멈춘 것처럼 보이고 서버 로그에는 아무 에러도 남지 않는다. 앞선 조회가 끝나야 풀린다.

---

### P2 · 급여 요약 API의 기본 조회월이 UTC 기준이라 매월 1일 새벽에는 전월 요약이 반환된다

- **위치**: `server/routes/payroll.js:112`
- **분류**: date
- **id**: `payroll-summary-month-utc`

**근거**

GET /payroll/summary:
  112: const month = req.query.month || new Date().toISOString().slice(0, 7)
이후 이 month로 `WHERE p.month = ? AND p.seq = 0` 조회(114~117행)를 하고, 지급예정일 폴백도 `${month}-25`(125행)로 만든다. 같은 파일 3행이 import 하는 futureDateError는 KST 기준이라 기준월 산출만 UTC로 남아 있다.

**실패 시나리오**

KST 2026-08-01 06:00에 급여 요약을 month 파라미터 없이 호출하면 month='2026-07'이 되어 7월 급여대장 기준 미지급·과지급 총액과 payDate('2026-07-25')가 응답된다. 8월 요약을 보려던 사용자는 전월 숫자를 이번 달 숫자로 오인한다.

---

### P2 · 급여·용역 지급 경로의 날짜 폴백이 KST가 아닌 UTC(new Date().toISOString())라, 한국시각 새벽 등록 시 거래일이 하루(월 경계에선 한 달) 밀린다

- **위치**: `server/routes/payroll.js:243`
- **분류**: date
- **id**: `utc-date-fallback-payroll`

**근거**

server/db.js:1164-1167에 KST 헬퍼가 있고 export까지 되어 있다.
```
const kstDate = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10)
const kstToday = () => kstDate(Date.now())
module.exports = { initDb, kstDate, kstToday, futureDateError }
```
그런데 두 파일 모두 `futureDateError`만 import하고(payroll.js:3, work-contracts.js:3) 날짜 폴백은 UTC를 쓴다.
- payroll.js:243 `date || new Date().toISOString().slice(0, 10)` — 거래일
- payroll.js:112 `req.query.month || new Date().toISOString().slice(0, 7)` — 요약 기본 월
- work-contracts.js:398 `date || pay_date || new Date().toISOString().slice(0, 10)` — 거래일
- work-contracts.js:375 `(date || pay_date || new Date().toISOString().slice(0, 10)).slice(0, 7)` — payroll 귀속 월
호출부는 date 미입력을 막지 않는다 — src/screens/HR.jsx:499-501의 `register()`는 `if (!amount || amount <= 0)`만 검사하고 date는 검증하지 않는다(날짜 input은 사용자가 비울 수 있다). 서버 배포 환경은 UTC 기준(db.js:1166 주석 "서버 타임존이 UTC여도")이다.

**실패 시나리오**

한국시각 2026-08-01 새벽 1시(= UTC 2026-07-31 16:00)에 급여 지급을 등록하면서 '지급일' 칸을 비우고 저장하면, 거래일이 2026-07-31로 기록된다. 8월 급여 지출이 7월 지출로 집계되어 월별 손익·부가세 신고자료의 귀속 기간이 틀어진다. 용역 지급(work-contracts.js:375)에서는 같은 상황에 payroll 회차의 month까지 '2026-07'로 잡혀 8월 용역대장에서 그 회차가 사라진다.

---

### P2 · 완료된 결의서를 PUT 으로 금액·상태까지 무제한 수정할 수 있고, status 를 빼면 '작성'으로 되돌아가 같은 결의서를 재처리(이중 지출)할 수 있다

- **위치**: `server/routes/resolutions.js:243`
- **분류**: transaction
- **id**: `resolution-put-unguarded-status`

**근거**

resolutions.js:240-244 `UPDATE expense_resolutions SET title=?, amount=?, ..., status=?, ... WHERE id=?` 에 `status || '작성'`(:243) 이 들어간다. r.status 가 '완료'인지, txn_id 가 이미 붙어 있는지 확인하는 가드가 전혀 없다. 재처리를 막는 유일한 방어는 :164 `if (r.status === '완료') ... 409` 하나뿐이고, 이는 status 컬럼 값만 본다. :228 의 `UPDATE expense_resolutions SET status='완료', txn_id=? WHERE id=?` 는 기존 txn_id 를 무조건 덮어쓴다. (현재 UI 는 Docs.jsx:684-686 에서 done 일 때 편집 버튼을 숨기고 :653 에서 `{...form}` 으로 status 를 실어 보내므로 화면 조작만으로는 재현되지 않는다 — API 레벨의 방어 부재다.)

**실패 시나리오**

완료된 결의서 DJ-2026-0005(txn T1, 300만원 집행됨)에 대해 status 필드가 빠진 PUT 요청이 한 번 들어오면(다른 클라이언트, 스크립트, 향후 부분 업데이트 UI) status 가 '작성'으로 돌아가 '처리 대기' 목록에 다시 뜬다. 담당자가 이를 미처리 건으로 보고 다시 [처리]→[지출 새로 등록] 하면 두 번째 300만원 지출 거래 T2 가 생성되고 txn_id 는 T2 로 덮어써진다. T1 은 결의서 없는 고아 지출로 남고 장부에는 같은 건이 두 번, 총 600만원으로 계상된다. 또한 완료 결의서의 amount 만 바꿔도 결의서 금액과 실제 집행 거래 금액이 어긋난 채 인쇄·결재된다.

---

### P2 · 결의서 문서번호 채번 연도가 UTC 기준이라 연초 새벽에 발행한 결의서에 전년도 번호가 붙는다

- **위치**: `server/routes/resolutions.js:21`
- **분류**: date
- **id**: `resolution-docno-year-utc`

**근거**

nextDocNo():
  21: const year = (dateStr || new Date().toISOString().slice(0, 10)).slice(0, 4)
  23~24: … FROM expense_resolutions WHERE doc_no LIKE ?  , [`DJ-${year}-%`]
  25: return `DJ-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
호출부 62행은 pay_date를 넘기는데, 그 pay_date 자체가 src/screens/Docs.jsx:335 의 UTC todayStr()이거나 비어 있을 수 있다. 이 doc_no는 resolutions.js:184·197 에서 지출 거래의 doc_no(증빙 역참조 키)로도 박힌다.

**실패 시나리오**

KST 2027-01-01 04:00에 지급예정일을 비운 채 결의서를 직접 등록하면 문서번호가 'DJ-2026-00xx'로 채번된다. 2027년 첫 결의서가 2026년 일련번호를 한 칸 더 소모하고, 2026년 결의서철에 섞여 연도별 문서 대장이 어긋난다.

---

### P2 · nav에서 숨긴 '증빙 관리' 목업 화면이 #evidence 해시로는 여전히 접근 가능하다

- **위치**: `src/App.jsx:352`
- **분류**: deadcode
- **id**: `evidence-route-still-reachable`

**근거**

App.jsx 352행 `case 'evidence': return <EvidenceScreen onAttach={(item) => setEvidenceAttach(item)}/>;` 가 살아 있고, 233~234행 `const h = window.location.hash.replace('#', ''); if (h && CRUMB_MAP[h]) setRoute(h)` + 56행 `evidence: ['증빙 관리']` 가 CRUMB_MAP에 남아 있어 주소창/북마크/뒤로가기로 `#evidence`가 그대로 라우팅된다. 정작 그 화면(Docs.jsx 823행 EvidenceScreen)은 830·900·903행에서 빈 상수 `SAMPLE.evidences` / `SAMPLE.evidenceMissing`만 읽고, 842·843·918행 버튼은 '증빙 파일을 ZIP으로 내려받았어요' 같은 토스트만 띄운다. 첨부 Drawer(Docs.jsx 926행, App.jsx 584행)도 965~968행 하드코딩 파일 목록에 986행 `onClose(); toast.push('증빙이 첨부되었어요')` 뿐이다. 한편 Home.jsx 55행 `else if (t.kind === 'evidence') go('evidence')` 분기는 api.getHomeTodos(api.js 1009~1031행)가 'ar'/'ap' kind만 생성하므로 절대 실행되지 않는 죽은 분기다.

**실패 시나리오**

이전에 증빙 화면을 열어두고 북마크했거나 브라우저 방문기록에 남은 사용자가 `https://donidora.com/#evidence` 로 들어간다. '증빙 관리' 화면이 정상적으로 열리지만 목록은 항상 비어 있고 '증빙 누락 0건'이 뜬다. '일괄 내려받기'·'파일 업로드'·'모두 알림 보내기'를 누르면 성공 토스트만 뜨고 실제로는 아무 일도 일어나지 않는다 — 사용자는 알림을 보냈다고 믿는다.

---

### P2 · 계좌 잔액 조정 등록 시 클라이언트가 조정일자를 UTC로 박아 보낸다

- **위치**: `src/lib/api.js:200`
- **분류**: date
- **id**: `adjustment-date-utc`

**근거**

  196: async addAdjustment(accountId, { amount, reason, by = '담당자' }) {
  200:   body: { amount, reason, date: new Date().toISOString().slice(0, 10), created_by: by },
사용자가 날짜를 고를 UI가 없고 이 값이 그대로 server/routes/accounts.js:96~103 의 account_adjustments.date 로 저장된다. 프로젝트 공용 헬퍼 `localToday`(src/lib/ui.jsx:16)를 쓰지 않은 유일한 저장 경로 중 하나다. 조정액은 accounts.js:12 `SUM(amount) FROM account_adjustments` 로 잔액에 무조건 합산되므로 금액은 맞고 날짜만 틀린다.

**실패 시나리오**

KST 2026-09-01 03:00에 계좌 잔액을 실제 통장과 맞추려고 조정을 등록하면 조정 이력에 '2026-08-31'로 남는다. 나중에 8월 말 잔액 대사를 할 때 8월에 없던 조정이 8월 이력에 보여 원인을 추적할 수 없다.

---

### P2 · src/lib/data.js와 src/lib/seed.js가 어느 파일에서도 import되지 않는 완전 사장 파일이다

- **위치**: `src/lib/seed.js:1`
- **분류**: deadcode
- **id**: `dead-lib-data-seed`

**근거**

src/ 전체에서 `lib/data` 를 import하는 구문은 0건(유일한 언급은 seed.js 96행 주석 '실제 categories 데이터는 src/lib/data.js CATEGORIES export 참조'), `seedAll` 참조도 seed.js 자체 주석 6~7행뿐이다. seed.js 헤더는 '동진테크 ERP 초기 데이터 시딩 스크립트 / bkend.ai BaaS 구현 후 이 파일의 데이터를 각 테이블에 INSERT'라고 적혀 있는데, 현재 백엔드는 Express+MariaDB이고 초기 데이터는 server의 setup:db·tenant 스크립트가 담당한다. 같은 디렉터리의 renewal.js는 Contract.jsx 7행에서 실제로 import되어 쓰이므로 대조된다.

**실패 시나리오**

seed.js 12~14행에는 '기업은행(주거래) *4010 initial_balance 48720000' 같은 구체적 계좌 잔액이, data.js에는 EXP-101 계열 비목 마스터가 그럴듯하게 들어 있다. 두 파일 모두 실행 경로에 없는데도 남아 있어, 계좌 잔액이나 비목 코드를 확인하려는 사람이 이 파일을 현행 기준정보로 오인해 참조할 수 있다.

---

### P2 · 레거시 7-step ExpenseDrawer 221줄이 어디서도 import되지 않는 죽은 코드로 남아 있다

- **위치**: `src/screens/Docs.jsx:23`
- **분류**: deadcode
- **id**: `dead-expense-drawer`

**근거**

23~243행 `export const ExpenseDrawer = ({ open, onClose }) => { ... }`. src/ 전체에서 이 심볼을 import하는 곳은 없다(App.jsx 11행은 `DocsScreen, EvidenceScreen, EvidenceAttachDrawer, ExcelScreen, ReportsScreen`만 가져온다). 내용도 실동작이 없는 목업이다 — 62행 거래처 칩이 '디자인스튜디오 R','AWS 코리아' 등 하드코딩, 169행 사용 직원이 '정수민','한경리' 등 하드코딩, 145~146행 계좌가 '기업은행 *123 / 신한은행 *456', 187행 첨부 파일명까지 고정이고, 238행 '등록 완료' 버튼은 `onClick={onClose}`라 저장 로직 자체가 없다. 실제 지출 등록은 src/screens/Form.jsx가 담당한다.

**실패 시나리오**

기능적 실패는 없지만, 실제 거래처·직원·계좌와 전혀 다른 하드코딩 값이 든 221줄이 남아 있어 이후 유지보수자가 이 Drawer를 살려 쓰거나 여기 값을 참조해 잘못된 기준정보로 오인할 위험이 있다.

---

### P2 · 지출결의서 화면만 UTC 기준 todayStr()을 써서, 결의서 지급예정일과 집행 시 생성되는 지출 거래 날짜가 하루 전으로 찍힌다

- **위치**: `src/screens/Docs.jsx:12`
- **분류**: date
- **id**: `resolution-paydate-utc`

**근거**

  12: const todayStr = () => new Date().toISOString().slice(0, 10)
  335: const empty = { …, pay_date: todayStr(), note: '' };   // 새 결의서 직접 등록
  450: const [date, setDate] = useState(todayStr());          // 처리(집행) 드로어
  456: setDate(doc.pay_date || todayStr());
  504: <input className="input" type="date" max={localToday()} … value={date} …/>
같은 파일 2행에서 `localToday`(src/lib/ui.jsx:16, 로컬 달력 기준)를 이미 import 해 `max`에만 쓰고 있어, 같은 입력 필드의 기본값(UTC)과 상한(로컬)이 서로 다른 날을 가리킨다. 이 date는 POST /resolutions/:id/process 로 넘어가 server/routes/resolutions.js:188~197 에서 '지급완료' 지출 거래의 date가 된다.

**실패 시나리오**

KST 2026-06-01 05:00에 결의서를 만들고 바로 '지출 새로 등록'으로 집행하면, 지출일 입력칸에 max는 '2026-06-01'인데 기본값은 '2026-05-31'이 채워진다. 그대로 처리하면 6월 1일에 나간 돈이 5월 지출로 기록되어 월별 지출 집계·정기 비용 대조가 한 달 어긋난다.

---

### P2 · 급여대장 생성 시 계약에 설정한 급여지급일(pay_day)이 항상 무시되고 매달 25일로 고정된다

- **위치**: `src/screens/HR.jsx:123`
- **분류**: date
- **id**: `generate-ignores-contract-pay-day`

**근거**

서버는 계약의 pay_day를 쓰도록 만들어져 있다 — server/routes/payroll.js:217-218
```
pay_date || (w.pay_day ? `${month}-${String(w.pay_day).padStart(2, '0')}` : `${month}-25`)
```
그런데 호출부가 pay_date를 **항상** 채워 보내서 앞의 `pay_date ||`가 무조건 이긴다 — src/screens/HR.jsx:123
```
const res = await api.generatePayroll(month, `${month}-25`);
```
src/lib/api.js:882 `req('/payroll/generate', { method: 'POST', body: { month, pay_date: payDate } })` — payDate가 그대로 전달된다.
결과적으로 work_contracts.pay_day 컬럼(db.js:544)과 근로계약 폼의 '급여일' 입력은 급여대장 생성에 아무 영향을 주지 못한다.

**실패 시나리오**

근로계약 편집에서 급여일을 10일로 저장한 뒤 인사관리 > 급여대장 > '급여대장 생성'을 누르면, 생성된 모든 명세의 지급 예정일이 2026-07-25로 찍힌다. 대표님용 요약(GET /payroll/summary)의 payDate도 payroll.js:125 `list.map(r => r.pay_date).filter(Boolean).sort()[0]`로 그 값을 그대로 읽어 '지급 예정일 7월 25일'을 표시한다 → 실제 급여일(10일)과 다른 일정이 화면에 뜨고, 계약서 설정이 반영되지 않은 사실이 어디에도 드러나지 않는다.

---

## 검토자 메모 (확인했으나 문제없던 부분 / 미확인 범위)

1. 읽은 범위: src/screens/Docs.jsx 전체(2076줄), src/lib/nav.js 전체, src/lib/data.js·seed.js 헤더 및 전체 import 그래프, src/App.jsx 라우팅/CRUMB_MAP/HELP_MAP 구간, src/screens/Home.jsx 1~110행(할 일 처리 분기), src/lib/api.js getHomeTodos/getNotifications/getAlerts/getCommandIndex 구간.\n\n핵심 판정 — 담당 지시의 '보이는 화면인지 nav와 대조' 결과: SAMPLE 참조 14곳은 두 갈래로 갈렸다. (1) ReportsScreen(라우트 report)는 NAV_TREE 경영관리→장부관리→'보고서'와 PORTAL mgmt 카테고리 양쪽에 모두 노출되는 실사용 화면이므로, 그 안의 SAMPLE 참조는 죽은 코드가 아니라 '실데이터인 양 0원을 보여주는' 결함이다(findings 1~2). (2) EvidenceScreen의 SAMPLE 참조는 nav에서 빠졌으나 해시 라우트로는 살아 있어 반쯤 죽은 코드다(finding 6).\n\n문제없다고 확인한 부분: DocsScreen/NewResolutionDrawer/ProcessDrawer/ResolutionPreview(246~798행)는 전부 api.getResolutions·createResolution·processResolution·updateResolution·deleteResolution 실 API 기반이고 SAMPLE을 쓰지 않는다. ResolutionDocument는 Ledger.jsx 456행에서 실제로 재사용된다. ExcelScreen(1027~1287행)은 api.parseExcel/commitImport 실 연동이며 매핑·오류 버킷 로직에 문제를 찾지 못했다. ReportTax4(1417행)는 api.getPayroll('labor') 실데이터, ReportVAT의 숫자 부분은 api.getVatSummary 실데이터다(단 배너는 finding 5). src/lib/renewal.js는 Contract.jsx에서 실사용 중이라 죽은 파일이 아니다.\n\n확인하지 않은 부분: api.getVatSummary·getPayroll의 서버측 집계 정확성(다른 담당 영역으로 판단), Contract.jsx 547행의 별도 evidences 목데이터, Master.jsx evidenceType 탭(이미 CLAUDE.md에 숨김 처리로 문서화됨), 보고서 상단 PDF/엑셀 버튼(2039~2040행)이 토스트만 띄우는 점은 finding 4와 동형이라 별도 항목으로 세우지 않았다.

2. ## 확정한 잔액 정의 (기준선)

accounts.js:6-18 `calcBalance` / dashboard.js:15-25 (동일 SQL 중복):
```
balance = initial_balance
        + SUM(transactions.amount WHERE kind='income'  AND account_id=A)          -- status 무조건
        - SUM(transactions.amount WHERE kind='expense' AND account_id=A AND status='지급완료')  -- 공백 없음
        + SUM(account_adjustments.amount WHERE account_id=A)
```
잔액에서 빠지는 경로는 딱 둘이다: **(a) account_id가 NULL** — 어떤 계좌 서브쿼리에도 안 걸림, **(b) 지출 status가 '지급완료'(무공백)가 아님**. 수입은 status 무관이라 (b)는 지출에만 적용된다.

## INSERT 지점 11곳 전수 대조 결과

| 위치 | status | account_id | 판정 |
|---|---|---|---|
| contracts.js:302 (마일스톤 기입금) | `'지급완료'`/`'입금완료'` | defAcc 폴백(:290) | 통과 |
| contracts.js:389 (기성 기입금) | `'지급완료'`/`'입금완료'` | defAcc 폴백(:370) | 통과 |
| invoices.js:183 (신규 매칭 거래) | `'지급완료'`/`'입금완료'` | `inv.account_id` | 통과 |
| invoices.js:177 (**기존 거래 재사용**) | **손대지 않음** | — | **탈락 → 지적3** |
| payroll.js:241 | `'지급완료'` | **NULL 허용** | **탈락 → 지적2** |
| recurring-invoices.js:150 | `'입금완료'` | acctId 폴백(:136) | 통과 |
| recurring.js:72 | `'지급 대기'` | r.account_id | **의도된 미반영**(대시보드 :55가 '지급 대기'로 별도 노출) — 그 자체는 정상이나 지적3·4·5의 입력원 |
| resolutions.js:193 | `'지급완료'` | **항상 NULL** | **탈락 → 지적1** |
| resolutions.js:184 (link) | **손대지 않음** | — | **탈락 → 지적4** |
| tax.js:36 | `'지급완료'`/`'입금완료'` | Tax.jsx:55·273이 클라이언트에서 강제 | 통과(서버 검증은 없음, 아래 참고) |
| transactions.js:99 | `status||'지급완료'`, PATCH :143-144에서 무공백 정규화 | Form.jsx:9-10,75가 accounts[0] 기본값 | 통과 |
| transactions.js:259 (엑셀 임포트) | `'입금완료'`/`'지급완료'` | account_id 없음(항상 NULL) | 임포트는 과거 실적 일괄 입력용이고 계좌 컬럼 자체가 양식에 없어(:276) 설계상 의도로 판단 — 미보고 |
| work-contracts.js:396 | `'지급완료'` | defAcc 폴백(:391) | 통과 |

## 확인했으나 문제없던 부분

- **status 무공백 표기 일관성**: transactions.js:143-144 PATCH 정규화 + db.js:1157 1회 보정 마이그레이션 + 프론트(Ledger.jsx:265,274)가 모두 무공백을 보낸다. F-02의 status 축은 실제로 막혀 있다.
- **트랜잭션 처리**: contracts.js·invoices.js·payroll.js·recurring*.js·resolutions.js·tax.js·transactions.js·work-contracts.js의 모든 `getConnection()` 경로가 try/catch(rollback)/finally(release) 규약을 지킨다. payroll.js:228처럼 conn 획득이 try 밖이어도 조기 return이 전부 try 내부라 release는 실행된다.
- **이중 계상**: analytics.js `runAggregate`는 transactions 단일 테이블만 집계하고 GROUP BY 축도 화이트리스트(GROUP 맵)라 JOIN 팬아웃이 없다. contracts.js의 contract_id/cost_contract_id 2축 분리도 metrics(:53)에서 매입 계약의 cost를 null로 죽여 중복을 피한다 — 설계대로다.
- **대시보드 미수/미지급**: dashboard.js:28-41은 invoice_matches 차감분(remain)으로 합산해 중복이 없고, invoices.js:36,55의 summary와 상태 집합이 일치한다.
- **부가세 집계**: tax.js:46-54는 invoices 단일 소스에 QUARTER(issued_at) 그룹핑 — 중복 없음.
- **잔액 SQL 중복**: accounts.js:6-18과 dashboard.js:15-25가 같은 식을 두 벌 갖고 있다(현재 값은 일치). 한쪽만 고치면 어긋나므로 공용화가 바람직하나, 지금 시점에 틀린 숫자는 아니라 지적으로 올리지 않았다.
- **tax.js 서버측 계좌 검증 부재**: `syncTaxTxn`은 accountId 없이도 '지급완료' 거래를 만든다(tax.js:38). 다만 유일한 호출 화면 Tax.jsx가 `if (isDone && !form.account_id) return toast.push(...)`로 막고 있어 현재 재현 경로가 없다. 지적1·2를 고칠 때 서버측 가드를 함께 넣으면 이 경로도 같이 닫힌다.

## 읽지 못한 부분

- server/routes/ 중 담당 외 파일(files.js, vendors.js, employees.js, ref-items.js, hr-codes.js, platform/*)은 잔액·집계와 무관해 열지 않았다.
- server/db.js는 871~1179행(시드 데이터·후반 마이그레이션)을 grep으로만 확인했다. 잔액 관련은 :1154-1157의 '지급 완료'→'지급완료' 보정 1건뿐임을 확인했다.
- contracts.js는 잔액·집계 경로(1-120, 255-500, 640-810)만 정독했고 갱신 이력·엑셀 export 구간(120-255, 500-640)은 통독하지 않았다.
- 실제 DB에 지금 account_id가 NULL인 '지급완료' 지출이 몇 건 쌓여 있는지는 조회하지 않았다. 지적1·2를 고칠 때 `SELECT COUNT(*), SUM(amount) FROM transactions WHERE kind='expense' AND status='지급완료' AND account_id IS NULL` 로 기존 누락분을 먼저 파악하고 계좌를 소급 지정해야 한다.

3. 확인했고 문제없던 부분:\n\n1. transactions.js DELETE(185-215)의 청구서 되돌리기 로직은 정확하다 — invoice_matches 삭제 → SUM 재계산 → invoices/milestones status 재설정까지 한 트랜잭션이고 finally{conn.release()}도 있다. 상태 문자열('입금 완료'/'지급 완료', 공백 있음)도 invoices.js:257 및 dashboard.js:28,36의 필터와 일치한다.\n\n2. transactions.js PATCH /:id/status(137-149)의 '지급 완료'→'지급완료' 정규화는 실제로 F-02 재발을 막고 있다. accounts.js:11이 status='지급완료'만 세는 것과 일치.\n\n3. transactions.js POST/PUT의 costId 처리(97, 123행) — 수입 거래에 cost_contract_id가 붙어 원가가 부풀지 않도록 kind로 걸러내는 것 정상. PUT은 DB에서 현재 kind를 다시 읽어 판단하므로 body 위조로 우회되지 않는다.\n\n4. futureDateError는 POST(94)·PUT(119)·import/commit(244)·resolutions process(189, pay_date까지 실효날짜로 검사)에 모두 적용돼 있다. KST 기준(db.js:1165-1172) 확인.\n\n5. 라우트 등록 순서 — GET /summary, GET /:id, GET /import/template, DELETE /docs/:docId, DELETE /:id 가 세그먼트 수 때문에 서로 잠식하지 않는다.\n\n6. import/commit(231-270)은 미래일자 스킵·거래처 자동생성·상태 무공백('입금완료'/'지급완료') 모두 정상. 롤백/release 정상.\n\n7. resolutions.js /from-invoice(82-133): 중복 생성 방지(existing 조회), kind='received' 검증, invoice_lines 있을 때 라인합+VAT=total 구성, FOR UPDATE 잠금 모두 적절. nextDocNo는 MAX+1이라 삭제 후 재사용 없음(doc_no UNIQUE와도 정합).\n\n8. resolutions.js process의 이중계상 방어 2건 — 완납 청구서 처리 차단(168-176), 이미 다른 청구서에 매칭된 지출 재매칭 차단(212-213) — 은 실제로 동작한다. 다만 둘 다 r.invoice_id가 있을 때만 걸리므로, 청구서 없는 직접 등록 결의서는 위 finding 4의 구멍이 남는다.\n\n9. payroll의 지급액은 transactions에서 매번 SUM으로 계산(payroll.js:70-87 enrich)하고 UI도 payStatus(동적)를 쓰므로(Hr.jsx:248,340), 거래가 삭제돼도 급여 지급액 표시는 자체 보정된다. 그래서 finding 5에서 급여 쪽은 세금 쪽보다 영향이 작다고 판단해 세금 시나리오를 대표로 적었다.\n\n못 읽은 부분 / 범위 밖:\n- recurring.js·recurring-invoices.js의 정기지출/정기청구 재생성 로직은 다른 담당 영역이라 last_generated 되돌림 문제(거래 삭제 시 재생성 안 됨)는 확인만 하고 보고하지 않았다.\n- work-contracts.js(용역·일용 지급), invoices.js 전체, contracts.js 기성 발행 경로는 finding 근거 확인에 필요한 부분(위에 인용한 줄)만 읽었고 전수 검토하지 않았다.\n- transaction_docs 테이블의 FK 유무는 확인하지 않았다(POST /:id/docs 가 거래 존재를 검증하지 않아 고아 행이 생길 수 있으나 금액과 무관해 제외).

4. ## 전수 확인한 범위\n\n**getConnection 사용처 37곳 전부(라우트 36 + 스크립트 1)를 호출 문맥까지 읽었다.**\n- contracts.js(175,260,328,560,635,755), invoices.js(130,153,243), payroll.js(93,110,138,178,228,259,278,293), work-contracts.js(102,150,206,249,275,306,343), tax.js(93,166,183,200), resolutions.js(83,159), transactions.js(186,232), recurring.js(56), recurring-invoices.js(100,169), vendors.js(76), scripts/cleanup-recurring-invoices.js(86)\n\n**커넥션 누수는 없다.** 사전 스캔의 \"getConnection 40 vs release 38\" 격차는 오탐이다: 40건 중 poolManager.js:50은 래퍼의 메서드 *정의*, poolManager.js:54는 그 안의 실제 호출(해제는 호출자가 하는 래핑된 conn.release로), db.js:35는 initDb의 폴백(db.js:1160 `if (pooled) c.release()`로 해제)이다. 라우트·스크립트만 세면 37:37로 정확히 짝이 맞고, **37곳 전부 release가 finally 절에 있다.**\n\n**초기 return이 트랜잭션을 열어둔 채 빠져나가는 곳도 없다.** beginTransaction 이후의 모든 조기 return(404/400/409)은 앞에 `await conn.rollback()`이 있음을 한 건씩 확인했다 — invoices.js:136,157,163,165,172,247 / contracts.js:179,182,185,189,192,269,271,335,336,351,640,652 / work-contracts.js:224,253,279,350,364 / recurring-invoices.js:107,111,114,121 / resolutions.js:94,95,163,164,173,180,182,200,213 / tax.js:187. payroll.js:181,232,234,236의 조기 return은 beginTransaction *이전*이라 문제없다.\n\n**중첩 getConnection(자기 교착)은 없다.** 헬퍼(enrich, withMetrics, replaceContractItems, replaceItems, syncTaxTxn, syncOtherTaxTxn, nextEmpNo, defaultApproval, nextDocNo, attachMatches, attachDocs, calcBalance)는 모두 db/conn을 인자로 받고 기본값이 없다.\n\n**트랜잭션 안에서 conn 대신 req.db를 쓰는 곳은 사실상 없다.** 유일하게 resolutions.js:129가 `await conn.commit()` 직후 `req.db.execute`로 방금 만든 행을 다시 읽는데, 이미 커밋된 데이터를 읽는 것이라 정합성 문제는 없다(보고 안 함).\n\n**poolManager.js 전체를 읽었다.** wrap()의 getConnection은 inFlight를 증가시키고 이중 release를 방어하며(59-66), evictIfNeeded/sweeper 모두 inFlight>0인 풀을 회수하지 않아 트랜잭션 중 풀이 닫히는 경로는 없다.\n\n## 확인했으나 문제없던 것\n- **F-02 동형 전수 점검(status/계좌잔액)**: invoices.js:188, contracts.js:306·393, recurring-invoices.js:153, payroll.js:243, work-contracts.js:399, tax.js:21, transactions.js:262는 전부 무공백 '지급완료'/'입금완료'로 넣는다. transactions.js:143-144의 PATCH 정규화, db.js:1156의 1회 보정 마이그레이션도 확인. **누락은 resolutions.js mode='link' 한 곳뿐**(finding 1).\n- recurring.js:73이 '지급 대기'(공백 있음)로 넣는 것은 아직 안 나간 돈이므로 잔액 제외가 정상 — 다만 이 행이 finding 1의 트리거가 된다.\n- transactions.js DELETE(185-215)의 매칭 정리·청구서 상태 재계산, invoices.js DELETE/매칭취소의 상태 재계산은 전부 한 트랜잭션 안이고 로직도 맞다.\n- payroll·work-contracts의 삭제 경로는 unlink+delete를 한 트랜잭션으로 묶어 고아 데이터를 안 만든다.\n\n## 보고 보류 (근거는 있으나 강도가 약해 8건에 넣지 않음)\n- **contracts.js:685-715 POST /:id/recurring** — `SELECT COUNT(*) … active=1` 중복 가드와 INSERT가 트랜잭션 없이 req.db로 나뉘어 있고 유니크 인덱스도 없다. 버튼 연타/중복 요청 시 같은 계약에 활성 정기청구가 2건 생겨 매달 청구서가 두 배로 발행될 수 있다. 다만 순수 경합이라 재현 조건을 확정하지 못해 제외했다.\n- **payroll.js:227-238 POST /:id/pay** — 급여대장 행을 beginTransaction *이전에* FOR UPDATE 없이 읽고 누적 지급액을 판정한다. 동시 요청 시 이중 지급 판정이 어긋날 수 있다(같은 파일 다른 핸들러들은 FOR UPDATE를 쓴다).\n- **transactions.js:232-240 import/commit** — vendors·contracts SELECT가 beginTransaction 앞에 있어 중복 거래처 판정이 트랜잭션 밖이다.\n- **accounts.js:10 vs 11 비대칭** — 지출은 status='지급완료'만 세는데 수입은 status 필터가 없다. 현재 income 거래를 만드는 모든 경로가 '입금완료'를 넣고 Form.jsx:181도 그러므로 지금은 증상이 없지만, 미완료 수입이 생기는 경로가 추가되면 즉시 잔액이 부풀어 오른다.\n\n## 읽지 못한 부분\n- server/routes 중 analytics.js, dashboard.js, auth.js, company.js, hr-codes.js, employ-types.js, payroll-items.js, account-subjects.js는 getConnection·beginTransaction이 한 건도 없음을 grep으로 확인만 하고 본문 전체는 읽지 않았다(내 담당이 트랜잭션·커넥션이라 우선순위를 낮췄다).\n- server/scripts 중 provision-tenant.js, setup-db.js, delete-tenant.js, migrate-uploads.js, check-db.js는 getConnection이 없어 읽지 않았다(delete-tenant.js는 파괴적 스크립트라 별도 검토 가치가 있다).\n- server/db.js는 1178줄 중 앞 90줄과 뒤 120줄만 읽었다. 중간부(대부분 CREATE TABLE/마이그레이션)는 확인하지 못했으므로, invoice_docs·expense_resolutions.txn_id의 FK/유니크 제약 유무는 검증하지 못했다.

5. 확인했으나 문제없던 부분:\n\n1. server/db.js:1164~1172 의 KST 헬퍼는 정상. kstDate(ms)=`new Date(ms + 9h).toISOString().slice(0,10)` 는 서버 TZ와 무관하게 KST 달력일을 뽑고, futureDateError 는 문자열 비교(date > kstToday())라 형식이 'YYYY-MM-DD'인 한 안전하다. 다만 `date`가 빈 값이면 무조건 통과한다는 점이 위 tax.js·invoices.js 결함의 뿌리다.\n\n2. server/lib/recurrence.js — fmtDate/daysInMonth/addDays 가 전부 로컬 달력 컴포넌트(getFullYear/getMonth/getDate)만 쓰고 toISOString을 피하므로 타임존 중립이다. `fmtDate(new Date(y, m, day))` 왕복도 값 보존된다. 호출부(recurring.js:55, recurring-invoices.js:66·110·168)가 모두 kstToday()를 문자열로 넘겨 비교 기준이 일관된다. 월말 clamp(55행)와 절대월 재계산(52~54행)으로 오버플로 드리프트 없음. 결함 없음.\n\n3. recurring-invoices.js 의 setup_date 산출 — `UNIX_TIMESTAMP(created_at)` → `kstDate(epoch*1000)` (69·108·176행)로 DB TIMESTAMP를 KST 달력일로 정확히 환산한다. 소급 하한/미리보기(LOOKAHEAD_DAYS=35) 로직도 today 문자열 기준으로 일관. 결함 없음.\n\n4. DB DATE↔JS Date 왕복 시프트 위험 없음 — 날짜 컬럼이 전부 VARCHAR(20)이다(db.js:91,102,121,138,211~215,232~236,345~349,368,413,429,444,538). mysql2가 Date 객체로 캐스팅하는 경로가 없어 왕복 시프트가 발생하지 않는다.\n\n5. server/contract-model.js 의 dayAfter/nextEndDate/billingCycles 는 `new Date('YYYY-MM-DD')`(UTC 자정) 후 로컬 setDate/setMonth → toISOString 조합이지만, UTC 오프셋이 0 이상이고 DST가 없는 TZ(UTC·Asia/Seoul)에서는 로컬 달력일 == 문자열 달력일이라 결과가 정확하다. 실제 배포 대상이 이 두 TZ이므로 결함으로 보지 않았다.\n\n6. analytics.js resolvePeriod(32~48행)는 kstToday() 기반 + 정수 월연산(shiftMonth)으로 타임존 안전하고, 기간 필터도 `t.date BETWEEN from AND to`로 양끝 포함이라 inclusive/exclusive 불일치 없음.\n\n7. dashboard.js:9~10 은 kstDate(Date.now()) / kstDate(Date.now()+7일)로 KST 기준을 명시적으로 맞춰 두었고, invoices.js:38·56 의 연체 판정도 kstToday() 기준이다. 이 경로들은 정상.\n\n8. 미래일자 차단이 필요한 '돈이 오가는' 입력 경로를 전수 확인했고 가드 자체는 모두 존재한다 — transactions.js:93·118·244, invoices.js:151, contracts.js:259·327, recurring-invoices.js:120, payroll.js:232, work-contracts.js:342, tax.js:92·161·165·182, resolutions.js:189(실효일 effDate 기준으로 pay_date 우회까지 막음). 누락된 것은 '가드가 있으나 값이 비면 무력화되는' 위 2·3번 결함뿐이다.\n\n보고 보류(추측 성격이라 제외):\n- contracts.js:151·158 의 `DATEDIFF(c.end_date, CURDATE())` 는 DB 서버 타임존 기준이라 앱의 kstToday()와 기준일 산출 방식이 다르다. mysql2 풀에 timezone 옵션이 없고(db.js:14~19) 배포 서버 DB의 실제 TZ를 코드만으로 확인할 수 없어, 실제 하루 오차가 나는지 단정할 수 없어 결함으로 올리지 않았다. 갱신 D-day 표시와 통보기한 필터에 영향을 주므로 DB TZ가 UTC라면 확인이 필요하다. work-contracts.js:138 의 `DATE_FORMAT(CURDATE(),'%Y-%m')` 도 동일.\n\n시간상 정독하지 못한 부분: server/routes/contracts.js 649~853행(계약 PUT 후반·마일스톤 편집·첨부), server/routes/work-contracts.js 1~99·159~339행, server/contract-export.js, server/scripts/*, src/screens/Contract.jsx·WorkContract.jsx 전체(날짜 관련 부분만 grep으로 확인).\n\n담당 영역 밖이라 보고하지 않은 관찰(참고): accounts.js:10~11 과 dashboard.js:18~19 의 잔액 계산은 지출만 `status='지급완료'`로 거르고 수입은 status 무관하게 전부 합산한다. transactions.js:104 의 기본 status가 kind와 무관하게 '지급완료'인 점과 맞물려, income 거래에 '입금 예정' 같은 status가 들어가도 잔액에 즉시 반영된다. 금액/거래 담당 에이전트가 확인하는 편이 좋겠다.

6. 【확인했으나 문제없던 부분】\n- transactions.status 공백/NULL 경로: 담당 두 파일에서 transactions를 INSERT하는 곳은 payroll.js:240-244와 work-contracts.js:395-400 두 곳뿐이고, 둘 다 status를 리터럴 '지급완료'(무공백)로 하드코딩한다. accounts.js:11의 `status='지급완료'` 조건과 일치 — F-02의 status 측면은 두 경로 모두 확실히 덮였다. 다른 파일(contracts/invoices/recurring/tax/resolutions)의 INSERT도 grep으로 훑었으나 담당 영역이 아니라 판단 보류.\n- 트랜잭션 처리: payroll.js의 /generate, /:id/pay, DELETE 3종과 work-contracts.js의 POST/PUT/duplicate/DELETE//:id/pay 모두 getConnection → beginTransaction → catch{rollback} → finally{conn.release()} 규약을 지킨다. 조기 return(404/400) 전에 rollback을 호출하는 것도 확인(work-contracts.js:224, 253, 279, 350, 364).\n- 삭제 시 고아 데이터: payroll 삭제(payroll.js:298, 282)와 work_contracts 삭제(work-contracts.js:311)는 모두 unlink+DELETE를 한 트랜잭션에 묶어 '연결만 끊기고 본체가 남는' 상태는 생기지 않는다. work_contract_items/docs는 FK CASCADE(db.js:568, 579)로 정리된다. 다만 unlink된 거래의 재연결 불가 문제는 위 P1로 보고했다.\n- payroll upsert(payroll.js:163-169): 유니크 키가 (employee_id, month, seq)로 교체되었고(db.js:810-817) INSERT는 seq를 생략해 0으로 들어가므로, 용역·일용 회차(seq>=1)를 덮어쓰지 않는다. 프론트(HR.jsx:381)가 status: row.status를 그대로 되돌려 보내므로 '지급완료'가 '확정'으로 되돌아가는 회귀도 없다. work_contract_id/qty_lines는 UPDATE 절에 없어 기존 값이 보존된다.\n- 미래일자 가드: payroll.js:232, work-contracts.js:342 모두 실제 거래를 만들 때만 futureDateError를 태우고, 검사 대상 날짜와 INSERT에 쓰는 날짜가 같은 식(`date` / `date || pay_date`)이라 우회 경로가 없다. 프론트도 max={localToday()}로 정렬(HR.jsx:540, WorkContract.jsx:862).\n- /generate 월 범위: monthStart/monthEnd를 `${month}-01`/`${month}-31` 문자열로 비교하지만 start_date/end_date가 VARCHAR(20)(db.js:538-539)이라 2월에도 문자열 비교로 정상 동작한다. 동일 직원 다중 계약은 byEmp Map으로 최근 1건만 채택하고(199-203), 기존 seq=0 존재 시 건너뛰므로 중복 생성 없음.\n- /alerts/conversion(work-contracts.js:132-146): '/:id'보다 먼저 선언되어 라우트 가로채기 없음. GROUP BY 없는 HAVING은 MySQL/MariaDB에서 행 단위 필터로 동작하며 select 목록에 집계함수가 없어 의도대로 작동한다.\n\n【확인했으나 재현 경로를 입증하지 못해 보고하지 않은 것】\n- enrich()(payroll.js:71-75)와 상세 조회(work-contracts.js:169), withMetrics(work-contracts.js:88)의 paid 집계는 `WHERE payroll_id = ?`만 걸고 status/kind를 보지 않는다. 반면 accounts.calcBalance는 `status='지급완료'`인 expense만 센다. 즉 급여 거래의 status가 다른 값으로 바뀌면 급여대장은 '지급완료', 계좌 잔액은 미차감으로 갈라진다. 다만 급여 거래의 status를 바꾸는 UI 경로를 찾지 못했다(Form.jsx:181은 status를 편집 불가 필드로 두고 기존 값을 그대로 되돌려 보냄, PATCH /transactions/:id/status는 청구/미지급 화면 쪽 경로로 보임). 잠재 위험으로만 기록한다.\n- work-contracts.js:376-379의 seq 채번(MAX(seq)+1)은 payroll 행에 FOR UPDATE를 걸지 않는다. 같은 직원·같은 달에 서로 다른 계약 2건으로 동시 지급 요청이 들어오면 seq가 충돌해 유니크 위반 500이 날 수 있으나, 실패가 시끄럽고(트랜잭션 롤백) 발생 조건이 좁아 제외했다.\n\n【읽지 못한 부분】\n- server/routes/transactions.js는 PUT/PATCH 가드 확인을 위해 99-190줄만 읽었고 전체는 읽지 않았다(담당 외).\n- src/screens/WorkContract.jsx는 ServicePayDrawer 주변(820-870)만 읽었다. 계약 편집/목록 쪽 로직은 미검토.\n- server/db.js는 payroll/work_contracts 스키마와 마이그레이션, KST 헬퍼 구간만 발췌해 읽었다.

