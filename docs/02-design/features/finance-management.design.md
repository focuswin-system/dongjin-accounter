# 재무관리 (차입금 · 투자) 설계

- 작성: 2026-07-30
- 범위 확정: **차입금 + 투자 원장**(상환 스케줄·이자/원금 분리·계좌 연동). 지분율·평가손익 제외.
- IA: **새 도메인 `재무관리`** (일반회계·인사급여·경영관리와 나란히)
- 배경: 고객사 실무자가 요청. `docs/01-plan/features/post-multitenant-roadmap.plan.md` §독립 과제에 기재됨.

---

## 1. 왜 필요한가 — 지금은 넣을 자리가 없다

대출을 받으면 **계좌 잔액은 늘지만 수익이 아니다.** 투자받은 돈도 같다.
현재 스키마에는 이 돈을 넣을 자리가 없어서, 실무자는 잡손익이나 임의 비목으로 밀어넣게 된다.
그러면 **손익이 조용히 왜곡된다** — 화면은 멀쩡하고 숫자만 틀린다.

계정과목은 이미 준비돼 있다(`account_subjects`): 부채 14개(유동/비유동), 자본 13개, 자산 중 투자자산.
**없는 것은 원장과 상환 스케줄**이다.

---

## 2. 최우선 규칙 — 재무 거래는 손익이 아니다

> **손익 여부는 `kind`가 아니라 계정과목의 대분류(`account_subjects.acct_type`)가 정한다.**

이게 이 기능의 핵심 위험이다. 현재 코드는 `kind`만 보고 손익을 판정한다:

| 위치 | 지금 하는 일 | 재무 거래가 섞이면 |
|---|---|---|
| `routes/analytics.js:11` | `KIND = { sales: 'income' }` — income = 매출 | **대출 수령이 매출로 집계** |
| `routes/dashboard.js:18` | 계좌별 income/expense 합산 | 잔액은 맞지만 수입 지표가 부풂 |
| `routes/accounts.js:10` | 계좌 잔액 = income − expense | **이건 맞다**(실제로 오간 돈) |
| `routes/tax.js:78` | `vat_amount IS NOT NULL` 인 거래만 집계 | `vat_amount`를 NULL로 두면 안 섞임 ✓ |

### 판정 방식

거래에 이미 `account_code`가 있고, `account_subjects.acct_type`이 자산/부채/자본/수익/비용을 구분한다.
**`acct_type IN ('수익','비용')`만 손익**이고, 자산·부채·자본 거래는 재무활동이다.

```
대출 수령 5,000만  → kind=income  · account_code=단기차입금(부채)  → 잔액 ○ / 손익 ✕
원금 상환 142만    → kind=expense · account_code=단기차입금(부채)  → 잔액 ○ / 손익 ✕
이자 지급 10만     → kind=expense · account_code=이자비용(비용)    → 잔액 ○ / 손익 ○
투자 수령 3,000만  → kind=income  · account_code=자본금/주식발행초과금(자본) → 잔액 ○ / 손익 ✕
```

즉 **원금과 이자를 반드시 두 거래로 나눠야** 손익이 맞는다. 한 건으로 뭉치면 원금까지 비용이 된다.

### 기존 집계 수정 범위 (이 작업의 실제 리스크)

`analytics.js`·`dashboard.js`의 손익성 집계에 `account_code`의 `acct_type` 조건을 더해야 한다.
**계좌 잔액 집계(`accounts.js`)는 건드리지 않는다** — 실제로 오간 돈이므로 지금이 맞다.
계정과목이 비어 있는 과거 거래는 종전대로 손익으로 본다(갑자기 과거 숫자를 바꾸지 않는다).

---

## 3. 스키마

```sql
-- 차입금(대출) 원장
CREATE TABLE loans (
  id            VARCHAR(36) PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,   -- '기업은행 운전자금'
  lender        VARCHAR(200),            -- 금융기관·개인
  vendor_id     VARCHAR(36),             -- 거래처(기관)로 잡아둔 경우
  principal     BIGINT NOT NULL,         -- 최초 원금
  annual_rate   DECIMAL(6,3),            -- 연이율 %(4.250)
  method        ENUM('equal_payment','equal_principal','bullet') NOT NULL,
  term_months   INT,                     -- 상환 회차(만기일시는 이자 회차)
  start_date    VARCHAR(20) NOT NULL,    -- 실행일
  pay_day       INT,                     -- 매월 상환일
  end_date      VARCHAR(20),             -- 만기
  account_id    VARCHAR(36),             -- 입금/이체 계좌
  acct_code_principal VARCHAR(10),       -- 원금 계정(부채) — 손익 제외 판정 근거
  acct_code_interest  VARCHAR(10),       -- 이자 계정(비용)
  status        ENUM('active','closed') DEFAULT 'active',
  memo          TEXT,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 상환 실적. 스케줄은 계산으로 만들고, '처리한 회차'만 기록한다
-- (정기지출의 last_generated와 같은 철학 — 미래 회차를 미리 만들어두지 않는다).
CREATE TABLE loan_repayments (
  id          VARCHAR(36) PRIMARY KEY,
  loan_id     VARCHAR(36) NOT NULL,
  seq         INT NOT NULL,              -- 회차
  due_date    VARCHAR(20) NOT NULL,
  principal   BIGINT NOT NULL,
  interest    BIGINT NOT NULL,
  paid_date   VARCHAR(20),
  txn_principal_id VARCHAR(36),          -- 원금 지출 거래
  txn_interest_id  VARCHAR(36),          -- 이자 지출 거래
  UNIQUE KEY uq_loan_seq (loan_id, seq),
  FOREIGN KEY (loan_id) REFERENCES loans(id)
);

-- 투자 (받은 돈 / 한 돈)
CREATE TABLE investments (
  id          VARCHAR(36) PRIMARY KEY,
  direction   ENUM('in','out') NOT NULL, -- in=투자받음(자본) / out=투자함(자산)
  counterparty VARCHAR(200) NOT NULL,    -- 투자자 · 피투자회사
  vendor_id   VARCHAR(36),
  amount      BIGINT NOT NULL,
  invested_at VARCHAR(20) NOT NULL,
  account_id  VARCHAR(36),
  -- 투자받은 돈은 자본금과 주식발행초과금으로 갈린다(액면가 × 주식수 = 자본금).
  capital_amount BIGINT DEFAULT 0,
  premium_amount BIGINT DEFAULT 0,
  acct_code   VARCHAR(10),               -- 자본 또는 투자자산 계정
  txn_id      VARCHAR(36),               -- 입출금 거래
  memo        TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

`transactions`에는 `loan_id`·`investment_id`를 추가해 역참조한다(어디서 온 거래인지 추적 — 정기의
`recurring_id`와 같은 용도, FK는 두지 않는다).

---

## 4. 상환 스케줄 계산 (`server/lib/loan.js` — 순수 함수)

여기가 조용히 틀리는 자리다. 단위 테스트로 못박는다.

| 방식 | 원금 | 이자 |
|---|---|---|
| `bullet` 만기일시 | 만기에 전액 | 매월 `잔액 × 월이율` |
| `equal_principal` 원금균등 | `원금 / 회차` 고정 | 매월 `잔액 × 월이율`(감소) |
| `equal_payment` 원리금균등 | 매월 `납입액 − 이자` | 매월 `잔액 × 월이율` |

- 월이율 = 연이율 / 12 / 100
- 원리금균등 납입액 `PMT = P·r / (1 − (1+r)^−n)`
- **원 단위 반올림**, **마지막 회차에서 잔액 단수 조정** — 안 하면 잔액이 1~2원 남거나 초과된다
- 이율 0%도 성립해야 한다(무이자 차입 — 개인/관계사 차입에 흔하다)
- 잔액은 항상 `원금 − Σ상환원금`이며 음수가 되지 않아야 한다

## 5. 화면 · 권한 자원

`nav.js`에 도메인 `finance` 신설. `permissions.js RESOURCES`에 함께 등록한다
(안 하면 `check:isolation` 실패. 새 자원의 기본값은 '아무에게도 안 보임'이므로 마스터가 열어줘야 한다).

| 자원 id | 라벨 | 내용 |
|---|---|---|
| `finance_loan` | 차입금 | 대출 목록·상세(스케줄·상환 실적), 상환 처리 |
| `finance_investment` | 투자 | 투자받은/한 돈 목록 |
| `finance_dash` | 재무 현황 | 총 차입·잔여·월 상환액·투자 요약 |

상환 처리는 **계좌·날짜를 받아야 한다**(실제로 돈이 오가므로) → 기존 `PaidIssueDrawer`와 같은 원칙.
미래 회차 상환 처리는 막는다. 마감된 달도 막는다(`closedPeriodError`).

## 6. 하지 않는 것 (범위 밖)

- 지분율·주주 관리, 투자자산 평가손익 → 확정 시 별도 설계
- 재무상태표·현금흐름표 출력 → 계정 대분류 정합성이 먼저다
- 리스·할부 → 차입금과 회계처리가 달라 섞지 않는다
