# 한빛이엔지 DB 참고 자료

> 동진테크 focus-accounter 설계 시 도메인 참고용.
> 한빛이엔지는 동종(방산 정밀가공) 제조업 회사로 이미 운영 중인 COERP 시스템의 DB 구조를 참조.
> 동진테크는 한빛이엔지의 약 45% 규모(약 22명).

---

## 1. 업체 구분 코드 (COERP_COM_CLIENTELE.clie_gubu)

한빛이엔지 운영 DB에서 실제 사용 중인 업체 분류 코드.
focus-accounter의 `VENDORS.gubu` 필드에 동일 체계 적용.

| 코드 | 의미 | focus-accounter 사용처 |
|------|------|----------------------|
| `B` | 매출처 (발주처) | 청구서 issued 시 업체 목록 필터 |
| `A` | 매입처 (외주/원자재/소모품 등) | 청구서 received 시 업체 목록 필터 |
| `E` | 기관 (금융기관, 관공서) | received 시 A와 함께 표시 |

```js
// focus-accounter VENDORS 예시
{ id: "v-001", name: "한화에어로스페이스", gubu: "B", ... }  // 발주처
{ id: "v-010", name: "(주)한울정밀",       gubu: "A", ... }  // 외주업체
{ id: "v-029", name: "기업은행",           gubu: "E", ... }  // 금융기관
```

---

## 2. 계정과목 체계 (COERP_FIN_ITEM)

한빛이엔지는 생산/관리 구분 + 계정과목 코드 체계 사용.
focus-accounter의 `CATEGORIES` 구조에 반영.

### 매입 계정과목 (EXP-*)

| 구분 | 코드 범위 | 주요 항목 |
|------|---------|---------|
| 생산비 | EXP-101~499 | 정밀가공 외주, 도금 외주, 특수강, 시험검사비, 소모품비(생산) |
| 관리비 | EXP-501~904 | 임차료, 통신비, 복리후생비, 소모품비(관리), 차량유지비 |

```
생산비 그룹
  외주가공비: 정밀가공 외주, 도금 외주, 열처리 외주
  재료비: 특수강, 비철금속, 기타 원자재
  경비(생산): 시험검사비, 소모품비(생산), 기계수선비

관리비 그룹
  임차료 / 통신비 / 복리후생비 / 소모품비(관리) / 차량유지비
  접대비 / 수수료 / 보험료
```

### 매출 계정과목 (INC-*)

```
납품매출: 방산부품 납품, 시제품 납품
용역매출: 기술용역
기타수익: 이자수익, 잡수익
```

---

## 3. 핵심 테이블 구조 참조

### COERP_COM_CLIENTELE (거래처)

```sql
clie_code    VARCHAR(10)  -- 업체 코드
clie_name    VARCHAR(100) -- 업체명
clie_gubu    CHAR(1)      -- 구분: A/B/E
clie_bizno   VARCHAR(20)  -- 사업자번호
clie_ceo     VARCHAR(50)  -- 대표자
clie_tel     VARCHAR(20)  -- 전화번호
```

→ focus-accounter VENDORS 필드 매핑:
`id ↔ clie_code`, `name ↔ clie_name`, `gubu ↔ clie_gubu`, `bizNo ↔ clie_bizno`

---

### COERP_FIN_ITEM (계정과목)

```sql
item_code    VARCHAR(10)  -- 계정과목 코드 (A001~A043)
item_name    VARCHAR(100) -- 계정과목명
item_gubu    CHAR(1)      -- 생산(P)/관리(M)/매출(S)
item_type    VARCHAR(10)  -- 매입/매출/공통
```

→ focus-accounter CATEGORIES 필드 매핑:
`id ↔ item_code`, `name ↔ item_name`, `division ↔ item_gubu`, `group ↔ 그룹명`

---

### COERP_FIN_PURCHASE / COERP_FIN_SALES (매입/매출 전표)

한빛이엔지의 매입/매출 전표 구조 = focus-accounter의 INVOICES received/issued에 대응.

```sql
-- 공통 필드
purch_vendor    VARCHAR(10)  -- 업체 코드 (→ VENDORS.id)
purch_contract  VARCHAR(20)  -- 계약 번호 (→ CONTRACT_LIST.id)
purch_amount    BIGINT       -- 공급가액
purch_vat       BIGINT       -- 부가세
purch_total     BIGINT       -- 합계금액
purch_date      DATE         -- 발행일
purch_due       DATE         -- 지급기한
purch_status    VARCHAR(20)  -- 상태
purch_account   VARCHAR(10)  -- 입금 계좌
```

---

## 4. 동진테크 vs 한빛이엔지 규모 비교

| 항목 | 한빛이엔지 | 동진테크 (추정) |
|------|---------|-------------|
| 인원 | ~50명 | ~22명 (45% 규모) |
| 계약 유형 | 방산 납품, 시제품, MRO | 방산 납품 중심 |
| 거래처 규모 | 매출처 20+, 매입처 100+ | 매출처 9개, 매입처 21개 |
| 계정과목 수 | ~43개 (A001~A043) | ~22개 (간소화) |
| 계좌 수 | 5~7개 | 3개 |

---

## 5. 설계 결정 사항

| 항목 | 한빛이엔지 방식 | focus-accounter 채택 | 이유 |
|------|------------|-------------------|------|
| 업체 구분 | clie_gubu A/B/E | VENDORS.gubu A/B/E | 동일 코드 체계 유지 |
| 계정과목 | A001~A043 | EXP-101~904 / INC-101~204 | 규모 축소, 생산/관리 구분 반영 |
| 미수금 집계 | 전표 기반 계산 | INVOICES 기반 계산 | 단일 데이터 소스 원칙 |
| 잔액 계산 | 별도 잔액 테이블 | 계산형 (_calcBalance) | 수정 시 자동 반영 |

---

## 6. 참고 사항

- 한빛이엔지 DB 접속 정보는 별도 보안 채널로 관리 (이 문서에 기재 금지)
- 한빛이엔지 COERP 시스템은 MariaDB 기반 PHP 웹 시스템
- 실제 DB 스키마 확인 필요 시 `sys_admin` 계정으로 직접 조회
- focus-accounter의 DB 구현 시 `system-flow.design.md` 섹션 5 (DB 스키마) 기준으로 설계
