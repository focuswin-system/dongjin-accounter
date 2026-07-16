# 동진테크 회계관리 ERP — 전체 시스템 흐름 설계서

> **Version**: 0.3
> **Date**: 2026-05-28
> **Author**: Chajuick
> **Status**: Finalized — 실제 자료(엑셀/PDF) 분석 완료, bkend.ai 구현 준비

---

## 1. 시스템 개요

### 1.1 대상 조직

**㈜동진테크** — 경남 김해시 진례면 서부로 909-17  
사업자번호 603-81-44150 · 대표이사 김종석 · TEL 055-346-6500 / FAX 055-346-6501

| 항목 | 내용 |
|------|------|
| 업종 | 조선용·특수선용·잠수함용 파이프 SUPPORT (배관지지물) 제조 |
| 발주처 | 한화오션 (상선·특수선·수상함), HD현대중공업 (특수선·잠수함) |
| 규모 | 임직원 21명 (내국인 9명 + 외국인 12명) |
| 발주번호 체계 | 한화오션: `4003XXXXXX` (10자리), HD현대중공업: PU계약번호 |
| 품의번호 체계 | `DJ5-260330-04` (회사코드-연월일-순번) |
| 발주서번호 체계 | `20260112-06` (연월일-순번) |
| 주거래 계좌 | 기업은행 *4010 (주거래), 하나은행 *7231 (급여), 기업은행 *077 (시제), 우리은행 *301 (정산) |

- **주요 역할**: 경리 담당자(입력/처리), 차장급 관리(승인), 대표(최종 결재)
- **핵심 업무**: 납품 계약 관리, 거래내역 입력, 급여 처리, 세무 자료 생성

### 1.2 시스템 목적

엑셀 기반 회계 업무를 웹 시스템으로 전환. 계약-청구-수금-지출-보고의 전 주기를 하나의 흐름으로 연결.  
**핵심 요구**: 수주처(한화오션/HD현대중공업)별, 호선/공사번호별 원가 분류 (외상매입현황의 수주처·호선 컬럼 체계 반영).

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
  수주처 선택 (한화오션 / HD현대중공업 / 공통)  ← 핵심
  호선/공사번호 입력 (해당 시)                  ← 핵심
  사용처 (어느 납품지·현장에서 사용됐는지)      ← 핵심
  결제수단 (계좌이체 / 법인카드 / 개인카드 / 현금)
  증빙 (세금계산서 / 영수증 / 기타)
       │
       ▼
[결의서 자동 생성]
  Docs 화면에서 결의서 번호 자동 부여
  DJ5-{연도월일}-{순번} (ex: DJ5-260330-04)
       │
       ▼
[지급 처리]
  결제수단에 따라 지급 처리
  계좌이체: 계좌 잔액 차감
  개인카드/현금: 담당 직원 지정 → 비용 정산 처리
       │
       ▼
[보고서 반영]
  수주처별·호선별 원가 실적 업데이트
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
> 이유: 실제 청구액이 등록액과 다를 수 있음 (예: 가스비·통신비 월별 변동).

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
 ├─ 지출 등록 → Form 드로어 (계정과목/비목 + 수주처/호선 입력)
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
  gubu: "A"(매입처) | "B"(매출처/발주처) | "E"(기관/금융)
  service_type: 용접|절단|도장|자재공급|운반|세무|기타
  -- B: 청구서 issued 시 업체 필터 / A,E: received 시 업체 필터

CONTRACT_LIST (계약)
  id, vendorId, name, amount, startDate, endDate, status
  buyerCode: "HHIO" | "HHIM" (발주처 코드)
  puNo: PU계약번호 (현대)
  orderNo: 발주번호 4003XXXXXX (한화오션)
  vesselCode: 호선/공사번호
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
  buyerType: "HHIO" | "HHIM" | "공통"  ← 수주처 (한화오션/HD현대중공업)
  vesselNo: 호선번호/공사번호            ← 호선 (ex: "231호선", "PU26-001")
  usagePlace: 사용처                     ← 사용처 (ex: "동산테크1공장", "유일2공장")
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

### 5.1 기술 스택

| 옵션 | 특징 | 적합도 |
|------|------|--------|
| **bkend.ai BaaS** | 즉시 사용 가능한 REST API, Auth 포함 | ★★★ 권장 |
| PostgreSQL + Express | 직접 서버 구성, 완전한 제어 | ★★☆ |
| Supabase | bkend.ai와 유사, PostgreSQL 기반 | ★★☆ |

→ 빠른 납품 일정 감안 시 **bkend.ai BaaS** 우선 채택.

### 5.2 핵심 테이블

```sql
-- 거래처
CREATE TABLE vendors (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(100) NOT NULL,
  biz_no       VARCHAR(20),
  ceo          VARCHAR(50),
  address      TEXT,
  phone        VARCHAR(20),
  gubu         CHAR(2) CHECK (gubu IN ('A','B','E')),  -- A=매입처 B=매출처 E=기관
  type         VARCHAR(20),
  service_type VARCHAR(50),   -- 용접/절단/도장/자재공급/운반/세무 등
  created_at   TIMESTAMP DEFAULT NOW()
);

-- 계약
CREATE TABLE contracts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     UUID REFERENCES vendors(id),
  name          VARCHAR(200) NOT NULL,
  amount        BIGINT NOT NULL,
  start_date    DATE,
  end_date      DATE,
  status        VARCHAR(20) DEFAULT '진행중',
  buyer_code    VARCHAR(10),    -- 'HHIO'(한화오션) | 'HHIM'(HD현대중공업)
  pu_no         VARCHAR(30),    -- PU계약번호 (현대 발주)
  order_no      VARCHAR(30),    -- 발주번호 4003XXXXXX (한화오션)
  vessel_code   VARCHAR(30),    -- 호선/공사번호
  cost_budget   JSONB,          -- { material, outsource, labor, overhead }
  created_at    TIMESTAMP DEFAULT NOW()
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
  buyer_type      VARCHAR(10),    -- 'HHIO'(한화오션) | 'HHIM'(HD현대중공업) | '공통'
  vessel_no       VARCHAR(30),    -- 호선번호/공사번호 (ex: "231호선", "PU26-001")
  usage_place     VARCHAR(100),   -- 사용처 (ex: "동산테크1공장", "유일2공장")
  invoice_id      UUID REFERENCES invoices(id),
  recurring_id    UUID REFERENCES recurring_expenses(id),
  doc_no          VARCHAR(30),    -- DJ5-260330-04
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
  amount      BIGINT NOT NULL,
  reason      TEXT,
  date        DATE NOT NULL,
  created_by  VARCHAR(50),
  created_at  TIMESTAMP DEFAULT NOW()
);

-- 정기 지출
CREATE TABLE recurring_expenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID REFERENCES vendors(id),
  contract_id     UUID REFERENCES contracts(id),
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
  status      VARCHAR(20) DEFAULT '확정',
  txn_id      UUID REFERENCES transactions(id),
  UNIQUE (employee_id, month)
);
```

---

## 6. API 엔드포인트 설계

### 6.1 거래처 / 기준정보
```
GET    /vendors                    목록 조회 (gubu 필터 지원)
POST   /vendors                    등록
PUT    /vendors/:id                수정
DELETE /vendors/:id                삭제

GET    /accounts                   계좌 목록 + 잔액 계산
POST   /accounts/:id/adjustments   잔액 조정 등록
GET    /accounts/:id/adjustments   조정 이력 조회
```

### 6.2 계약 / 마일스톤
```
GET    /contracts                  목록 (vendorId, buyerCode, status 필터)
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
GET    /transactions               목록 (kind, contractId, buyerType, vesselNo, category, period 필터)
POST   /transactions               등록
PUT    /transactions/:id           수정
DELETE /transactions/:id           삭제

GET    /transactions/summary       수주처별/호선별/계정과목별 집계
```

### 6.5 정기 지출
```
GET    /recurring-expenses         목록
POST   /recurring-expenses         등록
PUT    /recurring-expenses/:id     수정
PATCH  /recurring-expenses/:id/toggle  활성/비활성 전환

POST   /recurring-expenses/generate   대기 항목 생성 (스케줄러 또는 수동 트리거)
  → 오늘 날짜 기준으로 last_generated 이후 도래한 항목들을 transactions에 status='지급 대기'로 삽입
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
    receivableTotal: ...,          미수금 합계
    payableTotal: ...,             미지급금 합계
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

## 8. 확정된 기준 데이터

*2026-05-28 실제 자료(엑셀/PDF) 분석 완료. 하기 데이터를 초기 시딩에 사용.*

### 8.1 발주처 (gubu: B)

| ID | 업체명 | 비고 |
|----|--------|------|
| VND-001 | 한화오션 | 상선·특수선·수상함 발주 |
| VND-002 | HD현대중공업 | 특수선·잠수함 발주 |

### 8.2 외주처 / 자재처 (gubu: A)

*2026년 거래처 외상매입현황 기준 (2,004건 검토)*

| ID | 업체명 | 서비스 유형 | 비고 |
|----|--------|------------|------|
| VND-010 | 광명산업 | 외주가공 | |
| VND-011 | 건후테크 | 외주가공 | |
| VND-012 | 세한테크 | 외주가공 | |
| VND-013 | 와이더블유테크 | 외주가공 | |
| VND-014 | 일광테크 | 외주가공 | |
| VND-015 | 금화테크 | 외주가공 | |
| VND-016 | 세원에스엔피 | 외주가공 | |
| VND-017 | 태인 | 외주가공 | 자재공제 대상 |
| VND-018 | 금보산업 | 외주가공 | 자재공제 대상 |
| VND-019 | 대성산업 | 외주가공 | 자재공제 대상 |
| VND-020 | 동국기업 | 외주가공 | |
| VND-021 | 제이와이물류 | 운반 | 월 968,000원 |
| VND-022 | 흥성철강 | 원자재 | SS400 앵글 보관품 141,480kg |

### 8.3 기관 (gubu: E)

| ID | 업체명 | 용도 |
|----|--------|------|
| VND-030 | 국민건강보험공단 | 4대보험 |
| VND-031 | 한국전력공사 | 전기 |
| VND-032 | 세무법인부성 | 월기장료 517,000원 |
| VND-033 | 경남에너지 | 기숙사 가스비 (변동) |
| VND-034 | 송정주유소 | 차량 경유 (변동) |
| VND-035 | 진례기숙사(이정화) | 기숙사 임차료 50,000원/월 |

### 8.4 계좌 (4개)

| ID | 계좌명 | 은행 | 용도 |
|----|--------|------|------|
| acc-001 | 기업은행(주거래) *4010 | IBK기업은행 | 주거래 |
| acc-002 | 하나은행(급여이체) *7231 | 하나은행 | 급여 이체 전용 |
| acc-003 | 기업은행(시제통장) *077 | IBK기업은행 | 시제품/소액 |
| acc-004 | 우리은행(정산) *301 | 우리은행 | 정산내역서 확인 (090-044469-13-301) |

### 8.5 임직원 (21명)

**내국인 (9명):**

| ID | 이름 | 직책 | 부서 |
|----|------|------|------|
| EMP-001 | 김원철 | 대표이사 | 경영 |
| EMP-002 | 김구섭 | 차장 | 관리 |
| EMP-003 | 백정숙 | 차장 | 관리 |
| EMP-004 | 임효진 | 경리 담당 | 관리 |
| EMP-005 | 남혜윤 | — | — |
| EMP-006 | 문성욱 | 팀장 | 생산 |
| EMP-007 | 조승래 | — | 생산 |
| EMP-008 | 신훈범 | 생산직 | 생산 |
| EMP-009 | 신영범 | 생산직 | 생산 |

**외국인 근로자 (12명):**

| ID | 이름 | 직책 |
|----|------|------|
| EMP-101 | 뚜에 | 생산직 |
| EMP-102 | 부디 | 생산직 |
| EMP-103 | 아데 | 생산직 |
| EMP-104 | 이완 | 생산직 |
| EMP-105 | 투안 | 생산직 |
| EMP-106 | 키엔 | 생산직 |
| EMP-107 | CNC | 생산직 |
| EMP-108 ~ EMP-112 | (추가 확인 필요) | 생산직 |

### 8.6 정기 지출 (확정 14건)

| 거래처 | 비목 | 금액 | 주기 | 일 |
|--------|------|------|------|----|
| 직원(생산직) | 생산 급여 | ~22,500,000 | 매월 | 25 |
| 직원(관리직) | 관리 급여 | ~9,800,000 | 매월 | 25 |
| 한우리급식(주) | 복리후생비(생산) | 3,500,000 | 매월 | 10 |
| 국민건강보험공단 | 복리후생비(생산) | 3,450,000 | 매월 | 10 |
| 국민건강보험공단 | 복리후생비(관리) | 1,150,000 | 매월 | 10 |
| 한국전력공사 | 전력비 | 3,200,000 | 매월 | 5 |
| 세무법인부성 | 수수료 | 517,000 | 매월 | 10 |
| 제이와이물류 | 운반비 | 968,000 | 매월 | 15 |
| 진례기숙사(이정화) | 임차료 | 50,000 | 매월 | 1 |
| 공장 임대인 | 임차료 | (확인 필요) | 매월 | 1 |
| 경남에너지 | 수도광열비 | ~155,460 변동 | 매월 | — |
| 한국산업안전공단 | 안전관리비 | 450,000 | 분기 | 5 |

### 8.7 연간 실적 (2026년 5월 누계)

| 구분 | 연간 목표 | 5월 누계 | 달성률 |
|------|---------|---------|--------|
| 수주 | 7,248,000,000원 | 1,588,249,391원 | 21.9% |
| 매출 | 8,040,000,000원 | 2,727,515,960원 | 33.9% |
| 잔량 (수주잔) | — | 2,445,217,001원 | — |

### 8.8 생산 공정 단계

```
절단 → 마킹 → 홀 → 면취 → 컷팅 → 취부 → 용접 → 사상 → 도장 → 납품
```

검사 단계: 제작검사完 → 전처리검사完 → 도장검사完 → 납품完

납품지 (주요): 동산테크㈜1공장(경주), 유일2공장(전남 영암), 유니온(부산), 의령기업, 에스텍

---

## 9. 구현 우선순위

```
Phase 1 — 백엔드 기반 (DB + 인증)
  ① bkend.ai 프로젝트 생성 + 테이블 생성 (섹션 5.2 스키마)
  ② 인증 (로그인/로그아웃, 경리 단일 계정)
  ③ 거래처·계좌·임직원 CRUD API + 초기 데이터 시딩

Phase 2 — 핵심 업무 흐름
  ④ 거래내역 (원장) CRUD (buyer_type/vessel_no/usage_place 포함)
  ⑤ 계약 + 마일스톤 (pu_no/order_no/vessel_code 포함)
  ⑥ 청구서 발행 + 입금 처리

Phase 3 — 자동화
  ⑦ 정기 지출 생성 스케줄러
  ⑧ 급여 마감 → 지출 자동 생성
  ⑨ 홈 대시보드 집계 API

Phase 4 — 보고서
  ⑩ 부가세 집계
  ⑪ 수주처별·호선별 원가 분석
  ⑫ 결의서 PDF 출력
```

---

## 10. 버전 이력

| 버전 | 날짜 | 변경 내용 |
|------|------|---------|
| 0.1 | 2026-05-21 | 1차 초안 — 전체 흐름, DB 스키마, API 설계 |
| 0.2 | 2026-05-22 | VENDORS gubu 필드 추가, 참고 자료 링크 추가 |
| 0.3 | 2026-05-28 | 실제 자료 분석 완료 반영: 회사 정보 확정, 섹션 5.2 buyer_type/vessel_no/usage_place/pu_no/order_no 추가, 섹션 8 기준 데이터 목록 (발주처 2개, 외주처 13개, 계좌 4개, 임직원 21명, 정기지출 12건, 연간 실적) |
