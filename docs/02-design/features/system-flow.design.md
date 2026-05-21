# 동진테크 회계관리 ERP — 전체 시스템 흐름 설계서

> **Version**: 0.1 (1차 초안)
> **Date**: 2026-05-21
> **Author**: Chajuick
> **Status**: Draft — 서버/DB 구현 직전 기준

---

## 1. 시스템 개요

### 1.1 대상 조직
- 동진테크 (방위산업 부품 제조사)
- 주요 역할: 대표(승인), 경리 담당자(입력/처리), 관리자(조회)
- 핵심 업무: 납품 계약 관리, 거래내역 관리, 급여 처리, 세무 자료 생성

### 1.2 시스템 목적
엑셀 기반 회계 업무를 웹 시스템으로 전환. 계약-청구-수금-지출-보고의 전 주기를 하나의 흐름으로 연결.

### 1.3 화면 구성

```
┌──────────────────────────────────────────────┐
│  네비게이션                                   │
│  홈(#home) · 거래내역(#ledger) · 청구관리    │
│  (#billing) · 계약(#contract) · 인사(#hr)    │
│  · 보고서(#docs) · 설정(#master)             │
└──────────────────────────────────────────────┘
```

---

## 2. 핵심 업무 흐름

### 2.1 수금 전체 흐름 (납품 → 입금)

```
[계약 등록]
  거래처 + 계약명 + 금액 + 납품 조건
       │
       ▼
[마일스톤 설정]
  선급금 20% · 기성고 30%×2 · 잔금 20%
  각 단계별 예정일 입력
       │
       ▼
[납품 / 검수 완료]
  (시스템 외부 이벤트 — 물리 납품)
       │
       ▼
[청구서 발행]  ← Contract 화면 마일스톤의 [청구서 발행] 버튼
  마일스톤 → 청구서 Drawer 자동 연결
  공급가액 입력 → 부가세 자동 계산 (10%)
  지급기한 설정
       │
       ▼
[입금 대기]  → 홈 "입금 예정" 배너에 표시
  Billing 화면: 상태 = "입금 예정"
       │
       ▼
[입금 확인]  ← 실제 계좌 입금 확인 후 처리
  Billing > 청구서 상세 > [입금 처리]
  입금 거래(Ledger)와 청구서 매칭
       │
       ▼
[완료]
  청구서 상태 → "입금 완료"
  Ledger에 입금 거래 반영
  계좌 잔액 자동 업데이트
```

### 2.2 지출 전체 흐름 (발생 → 결의서)

```
[지출 발생]
  (세금계산서 수취 또는 비용 발생)
       │
       ▼
[지출 등록]  ← Ledger 화면 "지출 등록" 또는 Docs 화면 "지출 결의서"
  거래처 · 계약/공통 · 계정과목/비목 · 금액
  결제수단 (계좌이체 / 법인카드 / 개인카드 / 현금)
  증빙 (세금계산서 / 영수증 / 기타)
       │
       ▼
[결의서 자동 생성]
  Docs 화면에서 결의서 번호 자동 부여
  EXP-{연도}-{해시4자리}
       │
       ▼
[지급 처리]
  결제수단에 따라 지급 처리
  계좌이체: 계좌 잔액 차감
  개인카드/현금: 담당 직원 지정 → 비용 정산 처리
       │
       ▼
[보고서 반영]
  계약별 원가 실적 업데이트
  비목별 지출 현황 업데이트
  부가세 신고 자료 업데이트
```

### 2.3 정기 지출 흐름 (핵심: 확인 후 확정 방식)

```
[정기 지출 등록]  ← 설정 > 정기 지출 탭
  거래처 · 비목 · 금액 · 주기(매월/분기/년) · N일
  결제 계좌 · 시작일 · 종료일(선택)
       │
       ▼  매월 N일 도래 시 (서버 스케줄러 또는 앱 기동 시 체크)
       ▼
[대기 항목 자동 생성]
  상태 = "지급 대기"
  원장에 pre-filled 항목으로 삽입
       │
       ▼  홈 화면에 배너 표시
       │  "이번달 처리 대기 정기 지출 N건"
       ▼
[담당자 확인 처리]
  홈 배너 클릭 → 해당 거래 드로어 열림
  금액 확인 및 수정 (실제 청구액 다를 수 있음)
  [확정] 버튼 클릭
       │
       ▼
[원장 반영 완료]
  상태 = "지급 완료"
  계좌 잔액 차감
  결의서 자동 생성
```

> **설계 결정**: 자동 확정 방식(A)이 아닌 확인 후 확정 방식(B) 채택.
> 이유: 실제 청구액이 등록액과 다를 수 있음 (예: 통신비 월별 변동).
> 확인 없이 자동 확정 시 오류 수정 비용이 큼.

### 2.4 급여 흐름

```
[임직원 등록]  ← 설정 > 임직원 탭
  기본급 · 직급 · 부서
       │
       ▼
[월 급여 확인]  ← 인사 화면 (매월)
  기본급 기반 자동 계산
  수당 / 공제 수동 입력
       │
       ▼
[급여 마감]
  해당 월 마감 처리 (수정 잠금)
  sessionStorage 영속화 (프로토타입) → DB 저장 (실 구현)
       │
       ▼
[지출 반영]
  급여 합계 → 원장에 "인건비" 지출로 자동 생성
  계좌 잔액 차감
```

---

## 3. 화면 연결 맵

```
홈(Home)
 ├─ 입금 예정 클릭 → Billing > 해당 청구서 드로어
 ├─ 정기 지출 대기 클릭 → Ledger > 해당 거래 드로어
 ├─ 미수금 클릭 → Billing > 발행 청구서 탭
 └─ 계좌 잔액 클릭 → 설정 > 계좌 탭

거래내역(Ledger)
 ├─ 입금 등록 → Form 드로어 (수금 유형 선택)
 ├─ 지출 등록 → Form 드로어 (계정과목/비목 선택)
 └─ 거래 클릭 → 결의서 상세 드로어

청구관리(Billing)
 ├─ 청구서 발행 → InvoiceFormDrawer (계약/마일스톤 연동)
 ├─ 청구서 클릭 → 상세 드로어 (입금 처리 포함)
 └─ 입금 처리 → Ledger 입금 거래 생성

계약(Contract)
 ├─ 수금 현황 탭 → 마일스톤별 현황 + 청구서 발행
 ├─ 마일스톤 탭 → [청구서 발행] → Billing InvoiceFormDrawer
 ├─ 원가 예산 탭 → 예산 vs 실적 비교
 └─ 증빙 탭 → Docs 결의서 연결

인사(HR)
 └─ 급여 마감 → Ledger 인건비 지출 자동 생성

보고서(Docs)
 ├─ 부가세 탭 → Billing INVOICES 집계
 └─ 결의서 탭 → Ledger 지출 거래 연결

설정(Master)
 ├─ 계좌 탭 → 잔액 조회 + 조정 (Ledger 데이터 집계)
 └─ 정기 지출 탭 → 등록/관리
```

---

## 4. 데이터 관계도 (Entity Relationship)

```
VENDORS (거래처)
  id, name, bizNo, ceo, address, phone, type(매출처/매입처/양쪽)

CONTRACT_LIST (계약)
  id, vendorId, name, amount, startDate, endDate, status
  costBudget: { material, outsource, labor, overhead }
  milestones: → MILESTONES

MILESTONES (마일스톤)
  id, contractId, type(선급금/기성고/잔금), ratio, amount
  dueDate, status, invoiceId(→INVOICES)

INVOICES (청구서)
  id, kind(issued/received), vendorId, contractId
  supplyAmount, vatAmount, totalAmount
  issuedAt, dueAt, status, accountId
  matches: → TRANSACTIONS

TRANSACTIONS (거래내역 — 원장)
  id, kind(income/expense), vendorId, contractId
  category(계정과목), subCategory(비목)
  amount, date, method(결제수단)
  status(지급완료/지급대기/예정)
  invoiceId(→INVOICES, 입금 매칭용)
  recurringId(→RECURRING_EXPENSES, 정기지출 연결)
  docNo(결의서번호), employeeId(개인카드/현금 시)
  evidType, evidUrl

ACCOUNTS (계좌)
  id, name, bank, type, initialBalance
  adjustments: → ACCOUNT_ADJUSTMENTS

ACCOUNT_ADJUSTMENTS (계좌 잔액 조정)
  id, accountId, amount, reason, date, createdBy

RECURRING_EXPENSES (정기 지출)
  id, vendorId, contractId(공통 또는 특정), category
  amount, period(monthly/quarterly/yearly), dayOfMonth
  startDate, endDate, accountId, active, lastGenerated

EMPLOYEES (임직원)
  id, name, role, department, baseSalary, joinDate

PAYROLL (급여 내역)
  id, employeeId, month(YYYY-MM), baseSalary
  allowance, deduction, netSalary, status(확정/마감)
  txnId(→TRANSACTIONS, 지출 반영 후 연결)
```

### 4.1 계좌 잔액 계산 방식

```
현재 잔액 = 초기 잔액
          + Σ(입금 거래, 해당 계좌)
          - Σ(지출 거래, 해당 계좌, 지급완료)
          + Σ(잔액 조정)
```

계산형으로 유지 (별도 잔액 필드 저장 X) → 거래 수정 시 자동 반영.

---

## 5. DB 스키마 설계 (실 구현용)

### 5.1 기술 스택 검토

| 옵션 | 특징 | 적합도 |
|------|------|--------|
| **bkend.ai BaaS** | 즉시 사용 가능한 REST API, Auth 포함 | ★★★ 권장 |
| PostgreSQL + Express | 직접 서버 구성, 완전한 제어 | ★★☆ |
| Supabase | bkend.ai와 유사, PostgreSQL 기반 | ★★☆ |

→ 빠른 납품 일정 감안 시 **bkend.ai BaaS** 우선 검토.

### 5.2 핵심 테이블

```sql
-- 거래처
CREATE TABLE vendors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  biz_no      VARCHAR(20),
  ceo         VARCHAR(50),
  address     TEXT,
  phone       VARCHAR(20),
  type        VARCHAR(20) CHECK (type IN ('매출처','매입처','양쪽')),
  created_at  TIMESTAMP DEFAULT NOW()
);

-- 계약
CREATE TABLE contracts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID REFERENCES vendors(id),
  name            VARCHAR(200) NOT NULL,
  amount          BIGINT NOT NULL,
  start_date      DATE,
  end_date        DATE,
  status          VARCHAR(20) DEFAULT '진행중',
  cost_budget     JSONB,  -- { material, outsource, labor, overhead }
  created_at      TIMESTAMP DEFAULT NOW()
);

-- 마일스톤
CREATE TABLE milestones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID REFERENCES contracts(id) ON DELETE CASCADE,
  type        VARCHAR(20),  -- 선급금/기성고/잔금
  ratio       SMALLINT,     -- %
  amount      BIGINT,
  due_date    DATE,
  status      VARCHAR(20) DEFAULT '예정',
  invoice_id  UUID REFERENCES invoices(id)
);

-- 청구서
CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            VARCHAR(10) CHECK (kind IN ('issued','received')),
  vendor_id       UUID REFERENCES vendors(id),
  contract_id     UUID REFERENCES contracts(id),
  supply_amount   BIGINT NOT NULL,
  vat_amount      BIGINT NOT NULL,
  total_amount    BIGINT NOT NULL,
  issued_at       DATE NOT NULL,
  due_at          DATE,
  status          VARCHAR(20) DEFAULT '입금 예정',
  account_id      UUID REFERENCES accounts(id),
  memo            TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- 거래내역 (원장)
CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            VARCHAR(10) CHECK (kind IN ('income','expense')),
  vendor_id       UUID REFERENCES vendors(id),
  contract_id     UUID REFERENCES contracts(id),
  category        VARCHAR(100),   -- 계정과목
  sub_category    VARCHAR(100),   -- 비목
  amount          BIGINT NOT NULL,
  date            DATE NOT NULL,
  method          VARCHAR(30),    -- 결제수단
  status          VARCHAR(20) DEFAULT '지급완료',
  invoice_id      UUID REFERENCES invoices(id),
  recurring_id    UUID REFERENCES recurring_expenses(id),
  doc_no          VARCHAR(30),    -- EXP-2026-XXXX
  employee_id     UUID REFERENCES employees(id),
  evid_type       VARCHAR(30),
  evid_url        TEXT,
  memo            TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- 계좌
CREATE TABLE accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(100) NOT NULL,
  bank            VARCHAR(50),
  type            VARCHAR(30) DEFAULT '보통예금',
  initial_balance BIGINT DEFAULT 0,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- 계좌 잔액 조정
CREATE TABLE account_adjustments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID REFERENCES accounts(id) ON DELETE CASCADE,
  amount      BIGINT NOT NULL,   -- 양수=추가, 음수=차감
  reason      TEXT,
  date        DATE NOT NULL,
  created_by  VARCHAR(50),
  created_at  TIMESTAMP DEFAULT NOW()
);

-- 정기 지출
CREATE TABLE recurring_expenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID REFERENCES vendors(id),
  contract_id     UUID REFERENCES contracts(id),  -- NULL = 공통
  category        VARCHAR(100),
  amount          BIGINT NOT NULL,
  period          VARCHAR(20) CHECK (period IN ('monthly','quarterly','yearly')),
  day_of_month    SMALLINT CHECK (day_of_month BETWEEN 1 AND 31),
  start_date      DATE NOT NULL,
  end_date        DATE,
  account_id      UUID REFERENCES accounts(id),
  active          BOOLEAN DEFAULT TRUE,
  last_generated  DATE,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- 임직원
CREATE TABLE employees (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(50) NOT NULL,
  role            VARCHAR(50),
  department      VARCHAR(50),
  base_salary     BIGINT DEFAULT 0,
  join_date       DATE,
  active          BOOLEAN DEFAULT TRUE
);

-- 급여
CREATE TABLE payroll (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID REFERENCES employees(id),
  month       CHAR(7) NOT NULL,   -- YYYY-MM
  base_salary BIGINT,
  allowance   BIGINT DEFAULT 0,
  deduction   BIGINT DEFAULT 0,
  net_salary  BIGINT,
  status      VARCHAR(20) DEFAULT '확정',  -- 확정/마감
  txn_id      UUID REFERENCES transactions(id),
  UNIQUE (employee_id, month)
);
```

---

## 6. API 엔드포인트 설계

### 6.1 거래처 / 기준정보
```
GET    /vendors                    목록 조회 (type 필터)
POST   /vendors                    등록
PUT    /vendors/:id                수정
DELETE /vendors/:id                삭제

GET    /accounts                   계좌 목록 + 잔액 계산
POST   /accounts/:id/adjustments   잔액 조정 등록
GET    /accounts/:id/adjustments   조정 이력 조회
```

### 6.2 계약 / 마일스톤
```
GET    /contracts                  목록 (vendorId, status 필터)
POST   /contracts                  등록
PUT    /contracts/:id              수정
GET    /contracts/:id              상세 (milestones + costBudget 포함)

POST   /contracts/:id/milestones   마일스톤 일괄 저장 (덮어쓰기)
PUT    /milestones/:id/invoice     마일스톤 ↔ 청구서 연결
PUT    /contracts/:id/cost-budget  예산 수정
GET    /contracts/:id/cost-analysis 예산 vs 실적 비교
```

### 6.3 청구서
```
GET    /invoices                   목록 (kind, status, vendorId, period 필터)
POST   /invoices                   발행
PUT    /invoices/:id               수정
DELETE /invoices/:id               삭제

POST   /invoices/:id/matches       거래 매칭 (입금 연결)
DELETE /invoices/:id/matches/:txnId 매칭 해제

GET    /invoices/summary/receivables  미수금 집계
GET    /invoices/summary/payables     미지급금 집계
GET    /invoices/summary/vat          부가세 집계 (quarter 파라미터)
```

### 6.4 거래내역 (원장)
```
GET    /transactions               목록 (kind, contractId, category, period 필터)
POST   /transactions               등록
PUT    /transactions/:id           수정
DELETE /transactions/:id           삭제

GET    /transactions/summary       월별/계정과목별 집계
```

### 6.5 정기 지출
```
GET    /recurring-expenses         목록
POST   /recurring-expenses         등록
PUT    /recurring-expenses/:id     수정 (금액, 계좌 등)
PATCH  /recurring-expenses/:id/toggle  활성/비활성 전환

POST   /recurring-expenses/generate   대기 항목 생성 (스케줄러 또는 수동 트리거)
  → 오늘 날짜 기준으로 last_generated 이후 도래한 항목들을 transactions에 status='지급 대기'로 삽입
  → 응답: { generated: [txnId, ...], count: N }
```

### 6.6 인사 / 급여
```
GET    /employees                  목록
POST   /employees                  등록
PUT    /employees/:id              수정

GET    /payroll?month=YYYY-MM      해당 월 급여 목록
POST   /payroll/close              월 급여 마감 + transactions 자동 생성
```

### 6.7 홈 대시보드
```
GET    /dashboard                  홈 요약 정보 (단일 호출)
  응답:
  {
    accountBalances: [...],        계좌별 현재 잔액
    receivableTotal: 87400000,     미수금 합계
    payableTotal: 12600000,        미지급금 합계
    upcomingIncome: [...],         7일 내 입금 예정
    pendingRecurring: [...],       처리 대기 정기 지출
    overdueInvoices: [...]         연체 청구서
  }
```

---

## 7. 인증 / 권한 설계

```
역할     권한
──────── ──────────────────────────────────
대표     전체 조회, 승인 (향후 결재 기능 확장)
경리     전체 입력/수정/삭제 (주 사용자)
직원     본인 급여명세서 조회만
```

> v1에서는 단일 계정(경리 담당자)으로 운영. 대표 조회 계정은 선택 구현.

---

## 8. 미결 사항 (고객사 자료 수취 후 확정 필요)

| 항목 | 현재 상태 | 확인 필요 내용 |
|------|---------|-------------|
| 계정과목 목록 | 프로토타입 기준 9그룹 | 실제 사용 계정과목 목록 |
| 거래처 목록 | 샘플 3곳 | 실제 거래처 (매출처/매입처 구분) |
| 계좌 목록 | 샘플 2개 | 실제 계좌 (법인카드 포함 여부) |
| 마일스톤 유형 | 선급금/기성고/잔금 | 검수비, 유지비 등 추가 유형 여부 |
| 결의서 양식 | 현재 자동 생성 | 기존 엑셀 양식 맞춤 여부 |
| 부가세 신고 방식 | 일반과세자 가정 | 실제 과세 유형 |
| 임직원 수 | 샘플 5명 | 실제 인원 및 급여 체계 |

---

## 9. 구현 우선순위

```
Phase 1 — 백엔드 기반 (DB + 인증)
  ① bkend.ai 프로젝트 생성 + 테이블 생성
  ② 인증 (로그인/로그아웃)
  ③ 거래처·계좌·임직원 CRUD API

Phase 2 — 핵심 업무 흐름
  ④ 거래내역 (원장) CRUD
  ⑤ 계약 + 마일스톤
  ⑥ 청구서 발행 + 입금 처리

Phase 3 — 자동화
  ⑦ 정기 지출 생성 스케줄러
  ⑧ 급여 마감 → 지출 자동 생성
  ⑨ 홈 대시보드 집계 API

Phase 4 — 보고서
  ⑩ 부가세 집계
  ⑪ 계약별 원가 분석
  ⑫ 결의서 PDF 출력
```

---

## 10. 버전 이력

| 버전 | 날짜 | 변경 내용 |
|------|------|---------|
| 0.1 | 2026-05-21 | 1차 초안 — 전체 흐름, DB 스키마, API 설계 |
