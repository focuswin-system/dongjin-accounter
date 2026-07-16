# 단가 기성형(품목별) 청구방식 — 구현 설계

> 배경: 이 앱은 SW 개발사(본인) + 제조업체 한 곳 납품. 제조업체가 **소사장 형태 기성 계약**이 잦음 → 총액 없이 **단가×수량**으로 청구. 기존 청구방식(총액형/정기형)에 3번째 **기성형(progress)** 추가.

확정 결정(2026-07-16):
- **진입점**: 계약 상세에 '기성 청구' 버튼 → 품목 수량 드로어
- **종료 방식**: progress는 종료방식(fixed/auto_renew/open) 자유, **총액은 항상 없음**(hasTotal=false, openEnded 처리 재활용)
- **거래명세서 출력**: 이번 범위 제외(후속). 핵심(테이블→계약폼→기성발행→누적)까지만.

---

## 1. 데이터 모델

### contracts (기존 테이블 재사용)
- `billing_mode` 에 `'progress'` 값 추가. 컬럼은 기존 `VARCHAR(20)`이라 스키마 변경 불필요.
- progress 계약: `amount=0`, `unit_amount/billing_period/billing_day/initial_amount = NULL` (정기 필드 안 씀).

### contract_items (신규) — 계약별 품목 단가표
```
id          VARCHAR(36) PK
contract_id VARCHAR(36) FK contracts(id) ON DELETE CASCADE
item_id     VARCHAR(36)   -- ref_items(type='item') 참조. 인라인 추가 시 새 ref_items도 생성
name        VARCHAR(255)  -- 스냅샷(품명)
spec        VARCHAR(255)
unit        VARCHAR(30)
unit_price  BIGINT DEFAULT 0  -- 계약별 단가(기준정보 단가가 기본, 수정 가능)
sort_order  INT DEFAULT 0
created_at  TIMESTAMP
```

### invoice_lines (신규) — 기성 청구서 품목 내역
```
id         VARCHAR(36) PK
invoice_id VARCHAR(36) FK invoices(id) ON DELETE CASCADE
item_id    VARCHAR(36)
name       VARCHAR(255)  -- 스냅샷
spec       VARCHAR(255)
unit       VARCHAR(30)
qty        DECIMAL(14,2) DEFAULT 0
unit_price BIGINT DEFAULT 0
amount     BIGINT DEFAULT 0   -- qty×unit_price(수동 수정 가능)
sort_order INT DEFAULT 0
created_at TIMESTAMP
```
> 품목 내역은 **(A) 정식 line 저장** 확정 → 거래명세서 출력 + 품목별 누적 집계의 단일 소스.

---

## 2. 계약 모델 규칙 (server/contract-model.js · src/lib/renewal.js)

`normalize(body)` 분기 추가:
```
billing = onetime | recurring | progress   (셋 중 하나)
progress: amount=0, unit_amount=null, billing_period/day=null, initial_amount=null
          term_mode/vat_mode/end_date/notice_days/term_months 는 기존 규칙 그대로
```
`termTotal(c)`: progress → 0 (총액 개념 없음).

renewal.js:
- `BILLING_MODES` 에 `{ value:'progress', label:'기성형', hint:'품목 단가×수량으로 기성 청구 (소사장·정밀가공)' }`
- `hasTotal(c)` → progress면 false (`!(isRecurring&&open) && billing_mode!=='progress'`)
- `isRecurring`은 progress에 false. 진행률/총액/남은분 UI 안 그림.

`metrics()` (contracts.js): progress를 openEnded처럼 `term_total=null, remain=null`. `billed`/`ar_remain`(청구액−수금)은 그대로 유효(기성 청구 누적으로 잡힘).

---

## 3. API 계약

### 품목 단가표 (contract_items) — ✅ 구현: 전체 교체 방식(개별 CRUD 라우트 없음)
- 개별 item CRUD 라우트는 만들지 않음. **계약 저장(POST/PUT)의 `items` 배열로 통째 교체**
  (milestones 편집기와 동일 패턴 — 더 단순·일관). 이름 없는 행은 서버가 스킵.
- 인라인 신규 품목은 **프론트 Combobox `onAddNew`가 `api.addRefItem({type:'item'})`로 ref_items 등록** 후 item_id를 실어 보냄. 서버는 받은 대로 저장(item_id nullable).
- 상세 GET이 `contract_items`를 내려주므로 별도 목록 라우트도 불필요.

### 기성 청구 발행 — ✅ 구현
- `POST /contracts/:id/progress-invoice`
  body `{ issued_at, due_at?, lines:[{ item_id, name, spec, unit, qty, unit_price, amount }], paid? }`
  처리: supply=Σ(amount), vat=면세?0:round(supply×0.1), total=supply+vat →
  invoices 1건(kind: 계약 gubu로 issued/received 판별, 채번 기존 규칙) + invoice_lines N건.
  paid=true면 schedule/issue처럼 실제 거래+매칭 생성(미래일자 금지).
- 응답 `{ ok, id, invoice_no }`

### 계약 상세 확장 (GET /contracts/:id)
- `contract_items`: 품목 단가표
- `item_progress`: 품목별 누적 `[{ item_id, name, qty_sum, amount_sum }]` (invoice_lines GROUP BY, 해당 계약 청구서 한정)

### invoices 삭제
- 기존 delete에 `DELETE FROM invoice_lines WHERE invoice_id=?` 추가(또는 FK CASCADE로 자동).

---

## 4. 프론트 UI

### 계약 폼 (Contract.jsx ContractTermFields)
- 청구방식 칩 3개(총액형/정기형/**기성형**).
- progress 선택 시: 금액칸(계약금액/주기금액) 대신 **품목 단가표 편집기**:
  - 행: `Combobox`(ref_items type=item, `allowAdd` + `onAddNew`로 인라인 추가) · 규격 · 단위 · 단가(`MoneyInput`, 기준정보 단가 기본값) · 삭제
  - 품목 고르면 규격/단위/단가 자동 채움(Form.jsx 품목 자동채움 패턴 재사용).
- 저장 시 items 배열을 계약 payload에 실어 보냄.

### 기성 청구 드로어 (계약 상세, progress 계약만)
- '기성 청구' 버튼 → Drawer: contract_items 목록 + 품목별 **수량 입력 → 금액=수량×단가 자동**(수동 수정 가능).
- 발행일·부가세(과세/면세) 표시, 합계 supply/vat/total.
- 발행 → `progress-invoice` 호출 → 성공 시 상세 새로고침(품목별 누적 갱신).
- 계약 상세에 **품목별 누적 기성**(수량·금액) 섹션 표시.

---

## 5. 검증
- 임시 서버 **PORT=3099** (3001 사용자 서버 죽이지 말 것). 한글 든 API는 Node http 스크립트로.
- 흐름: progress 계약 생성(품목 2~3개) → 기성 청구 2회 발행(수량 다르게) → 계약 상세 누적 확인 → 청구서 삭제 시 invoice_lines·누적 원복 확인.
- `npm run build` 통과. 검증 후 테스트 데이터 정리.

## 6. 후속(이번 제외)
- 거래명세서(invoice_lines 기반 품목 내역) 인쇄 출력.
- 매입 기성(소사장에게 나가는 기성 지급) 관점 — 우선 매출 기준으로 구현하되 gubu 판별은 발행 API에서 이미 처리.
