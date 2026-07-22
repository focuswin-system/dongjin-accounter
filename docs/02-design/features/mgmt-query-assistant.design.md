# 경영 질문 도우미 (절차식 조회) — 설계

> 배경: 회계 데이터는 차원(dimension)과 측정값(measure)이 유한해 "물어볼 수 있는 것"이 정형화돼 있다. 은행 앱처럼 **메뉴 드릴다운으로 질문을 좁혀 → 검증된 집계 쿼리 실행 → 차트+한 줄 요약**으로 답하는 절차식 도우미를 경영관리에 신설한다. **추후 LLM 도입 전 간이 봇**이자, LLM을 얹을 때의 **토대(질문 카탈로그 = function 목록)**.
> 원칙: (1) 자유 SQL/자유 문장 없음 → 각 선택지가 **화이트리스트 기반 검증 쿼리 하나**에 매핑(재무 데이터라 오답 불가). (2) 차트는 데이터 모양으로 **자동 선택**. (3) 차트 위 **템플릿 한 줄 요약**이 "리포트"를 "도우미"로 만든다. (4) 대표가 실제 묻는 **소수 질문부터**.

---

## 0. 현재 자산 (재활용)

| 이미 있는 것 | 위치 | 도우미에서 쓰임 |
|---|---|---|
| 미수금/미지급 요약 | `invoices` `GET /summary/receivables·payables` | 미수·미지급 질문 |
| 부가세 분기 집계 | `invoices` `GET /summary/vat` | 세금 질문 |
| 비목별 지출 | `transactions` `GET /summary?buyerType&year&month` | 비목별 지출 |
| 계약 손익 지표 | `contracts` `GET /`(metrics), `/:id/cost-analysis` | 계약별 손익 |
| 경영 대시보드(정적) | `Mgmt.jsx` MgmtDashScreen | 도우미 결과의 상위 요약과 연계 |

⚠ 백엔드가 `req.db` 주입 패턴으로 리팩터 중 → **새 엔드포인트는 `req.db.execute`/`req.db.getConnection` 사용**.

---

## 1. 핵심 개념 — 질문 = QuerySpec

모든 질문을 하드코딩 분기 대신 **스펙 하나**로 표현한다. 메뉴는 이 스펙을 채워가는 UI일 뿐.

```
QuerySpec = {
  topic:   'sales' | 'purchase' | 'receivable' | 'payable' | 'profit' | 'tax' | 'cash',
  measure: 'amount' | 'count',        // 무엇을 (금액/건수)
  basis:   'txn' | 'invoice',         // 실현(오간 돈) / 발생(청구 기준)
  group:   'none' | 'vendor' | 'contract' | 'category' | 'item' | 'month',
  period:  { preset: 'this_month'|'this_quarter'|'this_year'|'last_12m'|'custom', from?, to? },
  filter:  { vendor_id?, contract_id?, category?, item_id? },
  viz:     'auto' | 'line' | 'bar' | 'grid'   // 기본 auto
}
```

- 새 질문 추가 = **스펙 노드 추가**(코드 분기 X). 확장성 + LLM 연결(스펙이 곧 tool 파라미터) 둘 다 확보.
- `basis`가 중요: **매출(수금 실현)** vs **매출(청구 발생)**, **매입(지급)** vs **매입(청구받음)** 를 구분. 대표 질문은 대개 실현(txn) 기준이 직관적.

---

## 2. 백엔드 — 범용 집계 엔드포인트 (신규, 안전)

자유 SQL 금지. **화이트리스트 매핑**으로 group/filter 컬럼을 고정.

### `GET /api/analytics/aggregate`
쿼리 파라미터(전부 검증):
- `topic` (sales→income / purchase→expense 로 kind 매핑)
- `measure` = amount|count
- `group` = none|vendor|contract|category|item|month
- `from`, `to` (YYYY-MM-DD, KST)
- `status_scope` = completed(기본, `지급완료`/`입금완료`만) | all
- 필터: `vendor_id`, `contract_id`, `category`, `item_id`

서버 로직(개념):
```
const KIND = { sales: 'income', purchase: 'expense' }[topic]
const GROUP_COL = { vendor:'vendor_id', contract:'contract_id',
                    category:'category', item:'item_id', month:"DATE_FORMAT(date,'%Y-%m')" }[group]  // 화이트리스트
const AGG = measure === 'count' ? 'COUNT(*)' : 'SUM(amount)'
// status_scope=completed → income 전부 + expense는 status='지급완료'(잔액 계산과 동일 기준)
// WHERE kind=? AND date BETWEEN ? AND ? [+ 화이트리스트 필터 바인딩]
// group !== none → GROUP BY GROUP_COL + JOIN으로 라벨(거래처명/계약명/품목명)
// → [{ key, label, value, count }] (month는 key 오름차순, 그 외 value 내림차순)
```
반환: `{ rows:[{key,label,value,count}], total, group, measure, period }`

> 이 하나로 **매출/매입 × (거래처·계약·품목·비목·월별)** 을 안전하게 덮는다. 미수/미지급·부가세·손익은 §0 기존 엔드포인트 재사용.
> 필요 시 확장 엔드포인트: `GET /api/analytics/ar-by-vendor`(미수 거래처별), `GET /api/analytics/cash-trend`(계좌 잔액 추이 — phase 2, 무거움).

---

## 3. 질문 카탈로그 (MVP 6개 → 확장)

| # | 질문(대표 관점) | QuerySpec 요지 | 소스 | 기본 차트 |
|---|---|---|---|---|
| Q1 | 이번 분기 **매출/매입 추이** | topic=sales/purchase, group=month, period=this_year | aggregate | 라인 |
| Q2 | **거래처별** 매출/매입 (누가 큰가) | group=vendor | aggregate | 막대(Top N) |
| Q3 | **계약별 손익** | contracts metrics(billed/collected/cost/profit) | 기존 | 막대+그리드 |
| Q4 | **비목별 지출** | topic=purchase, group=category | aggregate/summary | 막대 |
| Q5 | **미수금/미지급 누가 얼마** | ar-by-vendor(신규 소) | invoices+신규 | 막대+그리드 |
| Q6 | **부가세** 분기별 | summary/vat | 기존 | 막대 |
| (P2) | 품목별 매출/매입 | group=item | aggregate | 막대 |
| (P2) | 자금(계좌) 잔액 추이 | cash-trend | 신규(무거움) | 라인 |

MVP는 **Q1·Q2·Q3·Q4**(aggregate 1개 신규 + 기존 재사용)로 시작 → Q5·Q6 → P2.

---

## 4. 프론트 — 절차식 UI 흐름

### 4-1. 진입 & 두 모드 (하이브리드)
- **질문 카드**(빠른 재사용): 대표 실질문 4~6개를 카드로. 한 번 눌러 바로 결과. (반복 사용 최적)
- **직접 좁히기**(탐색): "다른 게 궁금하세요?" → 드릴다운. (발견/온보딩 최적)

### 4-2. 드릴다운 3단계
```
Step 1 관점   [매출] [매입] [미수·미지급] [계약 손익] [세금]
Step 2 축     예) 매출 → [전체 추이] [거래처별] [계약별] [품목별]
Step 3 기간   [이번 달] [이번 분기] [올해] [최근 12개월] [직접 지정]
→ 결과
```
각 단계는 QuerySpec의 한 필드를 채운다. 뒤로/조건 변경 자유.

### 4-3. 결과 화면
1. **한 줄 요약(핵심)**: 템플릿 문장. 예) `"올해 매출은 총 1억 2,400만원, 지난해 대비 +18%. 가장 큰 거래처는 (주)웹메이커(3,100만원)."`
2. **차트**: 자동 선택(§5). 상단 우측에 라인/막대/그리드 토글.
3. **그리드**(항상 접이식): 표로도 확인 + CSV 내보내기.
4. **드릴 계속**: 막대 클릭 → 그 거래처/계약으로 필터 좁혀 재조회(예: 거래처 막대 클릭 → 그 거래처의 월별 추이).

---

## 5. 시각화 자동 선택 규칙

| 데이터 모양 | 차트 | 이유 |
|---|---|---|
| group=month (시계열) | **라인** | 추이 |
| group=vendor/category/item/contract (범주 비교) | **막대**(Top 8 + 기타) | 크기 비교 |
| group=none (단일 값) | **큰 숫자 타일** + 전기 대비 | 스칼라 |
| 상세/행 많음 | **그리드** | 열람 |
차트 라이브러리: 기존 `Sparkline`(ui.jsx) 확장 or 경량 SVG 자체 렌더(외부 의존 최소). 막대/라인은 SVG로 충분.

---

## 6. LLM 확장 경로 (지금 설계가 토대인 이유)

- 지금: 사용자가 메뉴로 QuerySpec을 채움.
- 다음: LLM이 **자유 문장 → QuerySpec(JSON)** 로 매핑만. 실행은 **동일한 aggregate 엔드포인트**. 즉 검증 쿼리는 그대로, 앞단만 교체.
- 질문 카탈로그·QuerySpec 스키마가 곧 LLM의 **function/tool 정의**가 된다. 버리는 작업 없음.

---

## 7. 메뉴 네이밍 (경영관리 하위)

후보와 성격:
- **경영 질문** — Q&A 성격 직관적, 간결. 드릴다운과 잘 맞음.
- **경영 도우미** — 어시스턴트 정체성(지금 절차식 + 나중 LLM 둘 다 자연스러움), 비개발자 친화.
- **빠른 분석** — 차트/분석 결과를 전면에.
- (지양) "무엇이든 물어보세요" — 자유 문장을 과약속(현재는 메뉴식).

**권장**: 1순위 **경영 도우미**(LLM 전환 후에도 이름이 유지됨), 2순위 **경영 질문**. 사이드바 `경영관리` 도메인에 `장부관리(보고서)`·`경영 대시보드`와 나란히 `경영 도우미` 잎 추가. route `mgmt_ask`.

---

## 8. 단계별 구현

| 단계 | 내용 | 검증 |
|---|---|---|
| 1 | `GET /api/analytics/aggregate`(req.db, 화이트리스트) + api.js | Node http: 매출 월별·거래처별 합계 대조 |
| 2 | 결과 컴포넌트(요약 문장 + 자동 차트 + 그리드) — SVG 막대/라인 | Playwright |
| 3 | 드릴다운 3단계 + 질문 카드(Q1·Q2·Q4) | Playwright |
| 4 | Q3 계약손익(기존 metrics)·Q5 미수 거래처별(신규 소)·Q6 부가세 | 대조 |
| 5 | 막대 클릭 드릴 + CSV + 전기 대비 요약 | — |
| P2 | 품목별·자금 잔액 추이 | — |

nav.js/App.jsx에 `mgmt_ask` 라우트·잎 추가, 크럼 `["경영관리","경영 도우미"]`.

---

## 9. 주의 / 범위

- **과설계 금지**: Q1·Q2·Q3·Q4로 시작, 실제 사용 보고 확장.
- **basis 혼동 방지**: 화면에 "실입금 기준 / 청구 기준" 명시(대표가 "매출"이라 할 때 뭘 보는지 라벨로).
- **status 기준 일치**: aggregate completed 집계는 잔액 계산과 동일하게 income 전부 + expense `지급완료`만(F-02 계열 일관).
- **KST**: 기간 경계는 kstToday/kstDate.
- 보안: aggregate는 group/filter 컬럼 화이트리스트만 — 자유 컬럼/SQL 절대 금지.

관련: `Mgmt.jsx`(경영 대시보드), `Docs.jsx` REPORTS(보고서), invoices/transactions/contracts summary 엔드포인트.
