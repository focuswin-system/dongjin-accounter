# 인사급여 재설계 — 근로계약·용역계약 기반 급여대장

> 배경: 현재 `근로계약`·`기타 용역·일용` 화면은 `ref_items` 범용 패널에 얹힌 **단순 목록**이라 급여대장과 아무 연결이 없다. 등록해도 어디에도 쓰이지 않는다.
> 방향: 두 화면을 **실제 계약 관리 화면**으로 만들고, 인사관리의 급여대장이 **그 계약을 소스로** 명세서·지급처리까지 잇는다.
> 로직 패턴은 **매입계약의 청구 메커니즘**(계약 → 단가표 → 회차 발행 → 정산 → 미지급 추적)을 차용하되, **테이블은 재사용하지 않는다**.

확정 결정(2026-07-16, 사용자 합의):
- **위치**: 인사급여 도메인에 별도로 둔다. `contracts`/`invoices` 재사용 안 함.
- **원천징수**: 앱이 계산하지 않는다. **확정 금액 기록만** — 2026-07-01 급여 설계 전환(자동 세금계산 폐기)과 동일 원칙.
- **일용직 사용함**. 일용은 유형이 갈리므로 범용 구조로 간다(§0).
- **범위**: 이 문서는 설계까지. 구현은 다음 세션.

---

## 0. 범용성 설계 원칙 — 세법 축은 닫고, 회사 축은 연다

"일용계약도 여러 종류가 있지 않나"는 맞다. 다만 **종류가 아니라 축이 셋으로 갈린다.**

| 축 | 예 | 처리 |
|---|---|---|
| **지급 단위** | 일당제(일×일수) / 시급제 / 건당(도급) | `work_contract_items.unit` — **이미 단가표가 커버**. 늘릴 것 없음 |
| **소득구분** | 근로 / 사업 / 일용 / **기타** | **닫힌 ENUM 4종** — 세법이 정한 집합 |
| **고용형태** | 정규직 / 계약직 / 수습 / 단시간 / 건설일용 / 행사스태프 … | **`ref_items` 마스터 — 사용자가 직접 추가** |

**왜 소득구분은 여는 게 아니라 닫는가**: 명세서 양식·지급명세서 제출주기·신고자료 분기가 전부 여기 걸린다. 사용자가 '특별용역' 같은 값을 만들면 그 지급건이 어느 신고 자료로 가야 하는지 앱이 알 수 없다. 세법이 4종만 인정하므로 4종으로 고정한다.

**왜 고용형태는 여는가**: 이건 회사가 정하는 이름표다. 하드코딩하면 사용자가 못 늘린다. `payroll_item_types`(급여 항목 마스터)가 급여 항목에 하는 일과 정확히 같은 패턴 — 마스터가 **기본값**(소득구분·단가 단위·보험 적용·상용전환 기준)을 갖고, 계약 생성 시 자동으로 채워준다.

**계약 템플릿 테이블은 만들지 않는다(YAGNI)**: 유형별 기본값은 고용형태 마스터가 이미 갖는다. 반복 생성은 `이 계약으로 새로 만들기`(복제) 버튼이 90% 커버한다. 22명 규모에 템플릿 엔진은 과설계.

### 소득구분 4종

| `income_type` | 대상 | 지급명세서 제출 | 원천징수(참고) |
|---|---|---|---|
| `근로` | 상용 근로자 | 반기 | 간이세액표 |
| `일용` | 일용근로자 | **매월** | 실효 2.7% (일 15만원 공제 후 6%, 세액공제 55%) |
| `사업` | 프리랜서(인적용역) | 매월 | 3.3% |
| `기타` | 강연료·원고료·자문료 등 **일시적** 용역 | 매월 | 실효 8.8% (필요경비 60% 인정 시) |

> 원천징수율은 **참고용 표기일 뿐 앱이 계산하지 않는다**(확정 금액 입력). 덕분에 세법이 바뀌어도 코드 수정이 없다 — 2026-07-01 자동 세금계산 폐기 결정이 여기서도 그대로 이득이 된다.
> ⚠ `사업`과 `기타`의 구분은 **계속·반복성**이다. 자문·강연 단발 건을 사업소득으로 넣으면 지급명세서가 잘못 나간다.

---

## 1. 왜 테이블을 재사용하지 않는가

사용자의 비유("용역=기성, 근로계약=정기")는 **흐름의 모양**으로는 맞지만, 저장을 `contracts`/`invoices`에 태우면 깨진다.

| 항목 | 매입계약 | 인사급여 |
|---|---|---|
| 청구서 | 상대가 발행 → 우리가 수취(`invoices.kind='received'`) | **없음**. 우리가 대장을 만들어 지급 |
| 부가세 | 공급가 + VAT, 세금계산서 | **과세대상 아님** (인적용역은 면세) |
| 계정 | 미지급금 | 미지급 급여 (별개 개념) |
| 상대 | 거래처(`vendors`) | 사람(`employees`) |

`invoices`에 급여를 넣으면 **미지급금 목록에 직원이 뜨고 부가세 집계가 오염된다.** 현재 코드도 이미 이 차이를 반영하고 있다 — `POST /payroll/:id/pay`는 청구서를 거치지 않고 '급여' 카테고리 지출 거래를 바로 만든다(`server/routes/payroll.js:198`).

**"근로계약 = recurring"도 어긋난다.** `recurring_expenses`는 정액 자동생성이지만 급여는 매달 금액이 다르다(연장수당·상여·공제 변동·4대보험 정산). 근로계약이 정하는 건 월 지급액이 아니라 **기본급·수당의 기준값**이다.

**"용역 = 기성"은 정확하다.** 일당×일수, 건당·시간당·M/M → `contract_items`(단가표) + 수량 입력 = 기성형과 같은 구조. **이 패턴은 복제한다.**

### 대응표 (패턴 차용 지도)

| 매입계약 | → 인사급여 |
|---|---|
| `contracts` | `work_contracts` (신규) |
| `billing_mode='recurring'` | `kind='labor'` — 단, 금액은 매월 편집 |
| `billing_mode='progress'` + `contract_items` | `kind='service'\|'daily'` + `work_contract_items` |
| `invoices`(received) | `payroll` — 청구서·부가세 없음 |
| `invoice_lines` | `payroll.items`(JSON) + 용역은 단가×수량 라인 |
| 정산 → 거래 생성 | 지급 등록 → 거래 생성(`payroll_id` 연결) — **이미 동작 중** |
| 미지급금 | `remain` 양수=미지급 / 음수=과지급 — **이미 동작 중** |
| 지급결의서 | 임금명세서 / 용역 지급명세 |
| `contract_docs` | `work_contract_docs` (계약서 첨부) |

---

## 2. 현재 구조의 문제

`POST /payroll/generate`는 `employees WHERE active=1` 전수 + `payroll_item_types` 마스터로 대장을 만들고, 기본급·수당은 **직원 마스터 컬럼**(`base_salary`, `position_allowance`, `meal_allowance`, `vehicle_allowance`)에서 `itemsFromMaster()`가 끌어온다(`payroll.js:30`).

여기서 갈라지는 문제:
1. **급여 기준에 이력이 없다.** 연봉을 올리면 컬럼을 덮어쓴다 → 작년 급여를 왜 그 금액으로 줬는지 근거가 사라진다. 계약서와 대조가 안 된다.
2. **계약서가 없다.** 근로계약서·용역계약서를 붙일 곳이 없다(첨부 공용 `FileAttach`는 이미 있음).
3. **용역이 어디에도 안 붙는다.** 프리랜서에게 지급하면 그냥 거래 한 줄로 끝 → 누구에게 누적 얼마를 줬는지, 계약 대비 얼마 남았는지 알 수 없다.
4. **입·퇴사 이력이 없다.** `status`(재직/퇴사) 한 컬럼뿐 — 퇴사일도, 재입사도 표현 못 한다.

---

## 3. 데이터 모델

### 3-1. `employees` (기존 유지 — '사람' 마스터로 역할 재정의)

인적 정보만 남기고, **급여 기준은 계약으로 이관**한다.

```
유지:   id, name, role, department, emp_no, birth_date, join_date, status, active
추가:   person_kind  ENUM('employee','worker') DEFAULT 'employee'   -- 직원 / 용역·일용 인력
        leave_date   VARCHAR(20)                                     -- 퇴사일
레거시: base_salary, position_allowance, meal_allowance,
        vehicle_allowance, dependents, child_dependents
        → 계약으로 이관. 컬럼은 남기되 계약이 있으면 계약이 우선(fallback 용도).
```

> `person_kind`는 급여대장(직원)과 용역대장(인력)을 가르는 축. 계약 `kind`로도 판별 가능하지만, **계약이 아직 없는 사람**이 있으므로 사람 자체에 둔다.

### 3-2. `work_contracts` (신규) — 근로·용역 계약

```
id              VARCHAR(36) PK
employee_id     VARCHAR(36) FK employees(id)
kind            ENUM('labor','service','daily') NOT NULL  -- 근로 / 용역 / 일용 (화면 배치 축)
income_type     ENUM('근로','사업','일용','기타') NOT NULL  -- 소득구분 (세법 축) → 명세서·신고자료 분기
title           VARCHAR(255)                              -- 계약명 (용역·일용: 업무내용)
-- 고용형태: ref_items(type='employ_type') 마스터 참조 + 스냅샷
employ_type_id  VARCHAR(36)
employ_type     VARCHAR(50)        -- 스냅샷(마스터가 바뀌어도 계약서 시점 값 보존)
-- 기간 (contracts의 term_mode 규칙 차용)
start_date      VARCHAR(20)
end_date        VARCHAR(20)
term_mode       ENUM('fixed','auto_renew','open') DEFAULT 'fixed'
status          VARCHAR(20) DEFAULT '진행중'               -- 진행중 / 만료 / 해지
-- 급여 형태
pay_form        ENUM('annual','monthly','hourly','daily','piece')  -- 연봉/월급/시급/일당/건당
work_hours      VARCHAR(50)        -- 소정근로시간 (예: 주 40시간, 09:00~18:00)
pay_day         INT                -- 급여 지급일 (1~31). 일용·용역은 NULL 가능
pay_items       TEXT               -- JSON [{label,kind,mode,value}] — 급여대장 생성 소스 (labor)
-- 4대보험 적용 (일용·단시간은 조건부라 계약마다 갈린다)
insure_np       TINYINT DEFAULT 0  -- 국민연금  (1개월 이상 + 월 8일/60시간 이상)
insure_hi       TINYINT DEFAULT 0  -- 건강보험  (동일 기준)
insure_ei       TINYINT DEFAULT 0  -- 고용보험  (일용도 원칙 가입 → 일용근로내역서 매월 신고)
insure_ai       TINYINT DEFAULT 1  -- 산재보험  (무조건 가입)
-- 일용 → 상용 전환 경고 (§6-2)
conv_alert_months INT DEFAULT 3    -- 계속 고용 N개월 초과 시 경고. 건설 일용은 12
memo            TEXT
created_at      TIMESTAMP
FOREIGN KEY (employee_id) REFERENCES employees(id)
```

> `kind`와 `income_type`을 **분리**하는 이유: `kind`는 "어느 화면에서 관리하나"(배치), `income_type`은 "어느 신고자료로 가나"(세법). 대개 붙어 다니지만 항상은 아니다 — 예: `kind='service'`인 자문 계약이 `income_type='기타'`(일시적)일 수도 `'사업'`(계속·반복)일 수도 있다. 하나로 합치면 이 구분이 사라진다.

**핵심**: `pay_items`가 `itemsFromMaster()`를 대체한다. 지금은 직원 컬럼 4개에서 끌어오지만, 앞으로는 **계약에 박힌 기준 항목**을 그대로 복사해 명세서를 만든다. 연봉이 오르면 **새 계약 행**을 만든다 → 이력이 자연히 남는다.

**"해당 월에 유효한 계약"** = `start_date <= 월말 AND (end_date IS NULL OR end_date >= 월초) AND status='진행중'`. 급여대장 생성은 이 조건으로 계약을 고른다.

### 3-3. `employ_types` (신규) — 고용형태 마스터 (사용자 정의)

§0의 "회사 축은 연다"의 실체. 사용자가 유형을 직접 만들고, 계약 생성 시 **기본값이 자동으로 채워진다**.

`ref_items`는 고정 컬럼(`code/name/party/spec/unit/amount/period/...`)이라 기본값을 담기 어색하다 → **전용 테이블로 신설**한다.

```
employ_types
id                VARCHAR(36) PK
label             VARCHAR(50) NOT NULL       -- 정규직 / 계약직 / 수습 / 단시간 / 건설일용 / 행사스태프 …
kind              ENUM('labor','service','daily')  -- 이 유형이 속하는 화면
income_type       ENUM('근로','사업','일용','기타') -- 기본 소득구분
pay_form          ENUM('annual','monthly','hourly','daily','piece')
default_unit      VARCHAR(30)                -- 단가표 기본 단위 (일/시간/건/M·M)
insure_np/hi/ei/ai TINYINT                   -- 보험 적용 기본값
conv_alert_months INT DEFAULT 3              -- 상용전환 경고 기준 (건설일용=12)
sort_order        INT DEFAULT 0
active            TINYINT DEFAULT 1
created_at        TIMESTAMP
```

시드(표준 8종): 정규직 · 계약직 · 수습 · 단시간 · 일용(일반) · 일용(건설) · 프리랜서(사업) · 일시용역(기타)

> 계약이 마스터 값을 **스냅샷**으로 복사한다(§3-2 `employ_type`). 마스터를 나중에 고쳐도 이미 체결된 계약서와 어긋나지 않는다 — `contract_items`가 품목 단가를 스냅샷하는 것과 같은 이유.
> 관리 위치: `hr_base`(부서·직위·급여) 화면에 '고용형태' 탭 추가. `PayrollItemPanel`과 같은 인라인 편집 표.

### 3-4. `work_contract_items` (신규) — 용역·일용 단가표

`contract_items`와 같은 모양. 기성형 패턴 그대로.

```
id                VARCHAR(36) PK
work_contract_id  VARCHAR(36) FK work_contracts(id) ON DELETE CASCADE
item_id           VARCHAR(36)        -- ref_items(type='item') 참조, 인라인 추가 지원
name              VARCHAR(255)       -- 업무명 스냅샷 (예: 화면 개발, 일당)
spec              VARCHAR(255)
unit              VARCHAR(30)        -- 일 / 시간 / 건 / M/M
unit_price        BIGINT DEFAULT 0
sort_order        INT DEFAULT 0
created_at        TIMESTAMP
```

### 3-5. `work_contract_docs` (신규) — 계약서 첨부

`contract_docs`와 동형. 공용 `FileAttach` 재사용.

```
id                VARCHAR(36) PK
work_contract_id  VARCHAR(36) FK work_contracts(id) ON DELETE CASCADE
file_url          VARCHAR(500)
file_name         VARCHAR(255)
created_at        TIMESTAMP
```

### 3-6. `payroll` (기존 재사용 + 확장) — 지급 회차

**용역·일용도 payroll을 쓴다.** 구조가 이미 같기 때문이다 — `items`(JSON) + `gross/deduction/net` + `pay_date` + 거래 연결(`payroll_id`) + `enrich()`의 미지급/과지급 계산. `items`에 `용역비`/`일당`(earn) + `원천징수 소득세·지방소득세`(deduct, **확정금액 입력**)를 넣으면 그대로 동작한다.

```
추가: work_contract_id  VARCHAR(36) FK work_contracts(id)   -- 근거 계약
      seq              INT DEFAULT 0                        -- 월 내 회차 (근로=0, 용역=1..N)
      qty_lines        TEXT                                 -- 용역 단가×수량 라인 JSON
                                                            --   [{name,unit,qty,unit_price,amount}]
```

> ⚠ **제약 충돌**: 현재 `UNIQUE KEY uq_emp_month (employee_id, month)`. 용역은 한 달에 여러 회차를 지급하므로 걸린다.
> **해결**: `uq_emp_month` 삭제 → `UNIQUE (employee_id, month, seq)` 로 교체.
> 근로계약은 항상 `seq=0`이라 **중복 방지 효과가 지금과 완전히 동일**하고, 용역만 `seq=1,2,3…`으로 늘어난다. `/generate`의 upsert 의미론도 그대로 유지된다.

**대안(기각)**: 용역 전용 `service_payments` 테이블 신설. → `enrich()`·지급등록·거래연결·요약을 통째로 복제해야 하고, 인사관리 화면이 두 소스를 합산해야 한다. `seq` 한 컬럼으로 끝나는 걸 테이블로 가를 이유가 없다.

---

## 4. 화면 설계

### 4-1. `hr_labor_contract` — 근로계약 (ref 패널 → 실화면)

**직원 등록이 여기로 이관된다.** (인사관리의 '직원' 탭 제거)

- **목록**: 직원 행 = 이름·사번·부서·직위·고용형태·현재 계약기간·월 기준급여·상태(재직/수습/휴직/퇴사). 필터 = 재직/퇴사/전체.
- **상단 버튼**: `직원 등록`(사람 + 최초 근로계약을 한 드로어에서), `퇴사 처리`
- **상세 Drawer 탭**:
  | 탭 | 내용 |
  |---|---|
  | 계약 정보 | 고용형태·계약기간·종료방식·소정근로시간·급여지급일 |
  | 급여 기준 | `pay_items` 편집 (지급/공제, 원·% 토글) — `PayslipEditorDrawer` UI 재사용 |
  | 계약서 | `FileAttach` 다중 첨부 |
  | 계약 이력 | 이 직원의 `work_contracts` 전체(연봉 인상·갱신 이력) |
  | 급여 이력 | 이 직원의 `payroll` 월별 (`GET /payroll/employee/:id` 이미 있음) |
  | 메모 | |
- **퇴사 처리**: `status='퇴사'` + `leave_date` + 진행 계약 `status='만료'` → 급여대장 생성 대상에서 제외.
- **재계약/연봉 인상**: `새 계약` 버튼 → 기존 계약 만료 + 새 행 생성(이력 보존).

### 4-2. `hr_outsourcing` — 기타 용역·일용

- **목록**: 인력 행 = 성명·고용형태·소득구분 배지·업무내용·계약기간·누적 지급액·미지급.
  - **필터 칩**: 전체 / 용역 / 일용 / 기타 (`income_type` 기준)
  - **상용전환 경고 배지**(§6-2)를 행에 표시.
- **상단 버튼**: `인력 등록` — **고용형태를 먼저 고르면 나머지가 자동으로 채워진다**(소득구분·단가 단위·보험 적용·전환 기준). §3-3 마스터의 값.
- **상세 Drawer 탭**:
  | 탭 | 내용 |
  |---|---|
  | 계약 정보 | 고용형태·소득구분·기간·종료방식·4대보험 적용 체크 |
  | 단가표 | `work_contract_items` — `ContractItemsEditor` 재사용(Combobox allowAdd 인라인 등록). 단위는 고용형태 기본값(일/시간/건) |
  | 지급 내역 | 발행된 `payroll` 회차 목록 + **항목별 누적**(기성 청구 내역 탭과 동형) |
  | 계약서 | `FileAttach` |
  | 메모 | |
- **`지급 등록` 버튼** ← 계약 상세의 `기성 청구` 버튼과 같은 자리·같은 동작. 드로어에서 단가표 항목별 수량 입력 → 금액 자동(수량×단가) → 원천징수 확정금액 입력(공제 항목) → `payroll` 회차 생성.
- **`이 계약으로 새로 만들기`(복제)** — §0의 "템플릿 대신 복제". 같은 인력의 다음 계약, 또는 같은 조건의 다른 인력을 한 번에.

### 4-3. `hr` — 인사관리

- 탭: **급여대장**(`kind='labor'`) / **용역·일용 대장**(`kind IN ('service','daily')`)
- **'직원' 탭 제거** → 근로계약 화면으로 이관. 페이지 설명문도 수정.
- 급여대장: 현행 유지. 단 `생성`이 **유효한 근로계약**을 소스로 동작(§5).
- 용역·일용 대장: 월별 지급 회차 목록 + 요약 타일(지급 합계/미지급/인원). 여기서도 `지급 등록` 가능.

---

## 5. 흐름 변경 — `POST /payroll/generate`

```
현재: employees WHERE active=1
        → itemsFromMaster(payroll_item_types 마스터, 직원 컬럼 4개)
        → payroll

변경: work_contracts WHERE kind='labor' AND status='진행중'
                       AND 해당 월에 유효 (start<=월말 AND (end IS NULL OR end>=월초))
        → JOIN employees (재직 확인)
        → items = JSON.parse(pay_items)        ← 계약이 소스
        → payroll (work_contract_id, seq=0)
```

- `pay_items`가 비었으면 `itemsFromMaster()`로 **폴백**(마이그레이션 전 데이터 보호).
- `payroll_item_types`(급여 항목 마스터)는 그대로 유지 — **계약의 `pay_items` 초기값**을 만드는 템플릿 역할로 축소. 계약 생성 시 마스터에서 항목을 깔고 금액만 계약에 채운다.
- 용역은 `/generate` 대상이 아니다. **지급이 발생할 때 수동 발행**(기성과 같음).

---

## 6. 명세서 분기 (`printPayslip`)

### 6-1. `income_type`으로 양식이 갈린다

| 소득구분 | 양식 |
|---|---|
| 근로 | 법정 임금명세서 (2021.11 의무) — **현행 그대로** |
| 일용 | 일용 지급명세 — 일당×일수 라인 + 원천징수 + 차인지급액 |
| 사업 | 용역 지급명세 — 업무내용·단가×수량 라인 + 원천징수 + 차인지급액 |
| 기타 | 기타소득 지급명세 — 지급내용·원천징수 + 차인지급액 |

원천징수는 **입력값을 그대로 출력**한다. 요율 계산 없음.

> 일용·사업·기타 3종은 양식 뼈대가 같다(내역 라인 + 원천징수 + 차인지급액) → **한 템플릿에 라벨·헤더만 `income_type`으로 바꾸는** 방식으로 구현한다. 근로(법정 임금명세서)만 별도 템플릿.

### 6-2. 일용 → 상용 전환 경고 (신규)

세법상 일용근로자는 **3개월 이상 계속 고용되면**(건설공사는 1년) 일용이 아니라 **상용근로자로 전환**되어 근로소득으로 신고해야 한다. 실무에서 자주 놓치는 지점이고, 놓치면 원천징수·지급명세서가 통째로 잘못 나간다.

- **판정**: `kind='daily'` 계약에서 `start_date` ~ 최근 지급 회차까지의 개월수 > `conv_alert_months`(기본 3, 건설 12)
- **표시**: 용역·일용 목록의 행 배지 + 인사관리 용역대장 상단 경고 + 홈 알림(`api.getNotifications()` — 미수/미지급 집계 패턴 재사용)
- **문구**: "○○님이 N개월째 계속 근로 중입니다. 상용근로자 전환 검토가 필요해요."
- **자동 전환은 하지 않는다.** 판정이 애매한 경우(월 8일 미만 산발 근로 등)가 있어 앱이 단정하면 안 된다 → **알리기만 하고 사용자가 근로계약으로 새 계약을 만든다.**

---

## 7. 신고자료 영향 (`Docs.jsx` `ReportTax4`)

현재 `payroll` 항목을 월별로 집계해 4대보험·원천세 자료를 만든다. 용역·일용이 같은 테이블에 들어오면 **근로소득에 다른 소득이 섞인다.**

→ `income_type`으로 섹션을 나눈다. 제출 주기가 다르다:

| 소득구분 | 지급명세서 | 비고 |
|---|---|---|
| 근로 | 반기 | 현행 자료 = 이것 |
| 일용 | **매월** | + 고용보험 **일용근로내역서** 매월 신고(`insure_ei=1`) |
| 사업·기타 | 매월 | |

> 실제 신고 서식 생성까지는 이번 범위가 아니다. **집계가 소득구분별로 갈려서 나오는 것**까지가 목표 — 세무사에게 넘길 자료를 만드는 게 이 앱의 역할이다.

---

## 8. 마이그레이션

| # | 내용 | 방식 |
|---|---|---|
| 1 | `work_contracts`/`work_contract_items`/`work_contract_docs`/`employ_types` 생성 | `CREATE TABLE IF NOT EXISTS` |
| 2 | `employ_types` 표준 8종 시드 | `INSERT` (존재 확인 후) |
| 3 | `employees.person_kind`, `employees.leave_date` | `ensureColumn` |
| 4 | `payroll.work_contract_id`, `payroll.seq`, `payroll.qty_lines` | `ensureColumn` |
| 5 | `uq_emp_month` → `UNIQUE (employee_id, month, seq)` | `runOnce` 가드 (인덱스 존재 확인 후 교체) |
| 6 | 기존 직원 → 최초 근로계약 자동 생성 (급여기준 컬럼 → `pay_items`, `employ_type='정규직'`) | `runOnce` 가드 |
| 7 | `REF_CONFIGS`에서 `labor_contract`·`outsourcing` 제거 | 코드 |

> ⚠ **7번 전에 확인 필요**: `ref_items`에 `type='labor_contract'`/`'outsourcing'` 실데이터가 있는지. 있으면 `work_contracts`로 옮기는 마이그레이션이 추가된다. **로컬에서 확인 못 함**(백엔드 미기동) — 구현 착수 시 첫 작업.

> 5번은 데이터 변형이 아니라 인덱스 교체지만, 재실행 시 에러가 나므로 `runOnce` 또는 `information_schema.statistics` 확인 후 실행.

> 2번 시드는 `payroll_item_types` 표준 16종 시드와 같은 패턴. **사용자가 지운 유형이 부팅마다 되살아나면 안 되므로** `runOnce` 가드 또는 "테이블이 비었을 때만" 조건.

---

## 9. 구현 순서 (다음 세션)

| Phase | 내용 | 검증 |
|---|---|---|
| 0 | `ref_items` 실데이터 확인 | DB 조회 |
| 1 | 스키마 + `employ_types` 시드 + `work_contracts` 라우트(CRUD·docs·items) | Node http 테스트 |
| 2 | `hr_base`에 '고용형태' 탭 (마스터 CRUD) | Playwright |
| 3 | 근로계약 화면 (직원 등록 이관, 계약 이력, 퇴사 처리) | Playwright |
| 4 | `/payroll/generate` 계약 소스로 전환 + 폴백 | 생성 결과 대조 |
| 5 | 용역·일용 화면 (고용형태 자동채움 + 단가표 + 지급 등록 + 복제) | Playwright |
| 6 | 인사관리 탭 재구성(직원 탭 제거, 용역·일용 대장 추가) | Playwright |
| 7 | 명세서 4종 분기 + 상용전환 경고 + `ReportTax4` `income_type` 분리 | 인쇄 렌더 |

Phase 1~4(근로) / 5~7(용역·일용)으로 끊어 배포 가능.

---

## 10. 미결 — 착수 전 확인 필요

1. **`payroll` 유니크 교체**(§3-6) 승인 — 기존 데이터 영향은 없지만 스키마 변경이라 확인 필요.
2. **`employ_types` 표준 8종이 적절한가** — 실제 쓰는 고용형태를 알려주시면 시드를 맞춘다. 특히 **건설 일용을 쓰는지**(전환 기준이 3개월이 아니라 1년).
3. **용역 인력을 `employees`에 둘지**(§3-1). `payroll` FK 재사용상 유리하지만 "직원 명부에 프리랜서가 섞이는" 게 걸리면 `person_kind` 필터로 분리 표시.
4. **`ref_items` 기존 데이터 유무**(§8).
5. **급여 항목 마스터의 위치** — 계약이 급여 기준을 갖게 되면 `hr_base`(부서·직위·급여)의 '급여 항목' 탭은 템플릿 역할로 축소된다. 이대로 둘지 확인.

> ~~일용직을 실제로 쓰는가~~ → **쓴다(2026-07-16 확정)**. `kind` 3종 유지 + `income_type` 4종.

---

## 참고

- 기존 급여 설계 전환 근거: 자동 세금계산 폐기(2026-07-01) — 4대보험은 공단 고지금액, 소득세는 매년 바뀌는 간이세액표 → 앱은 **확정 금액 기록 + 지출 연동 + 미지급/과지급 추적**만 한다.
- 차용 대상 설계: `docs/02-design/features/unit-progress-billing.design.md` (단가 기성형)
- 관련 코드: `server/routes/payroll.js`, `server/contract-model.js`, `src/screens/Hr.jsx`, `src/screens/Master.jsx:249` (REF_CONFIGS)
