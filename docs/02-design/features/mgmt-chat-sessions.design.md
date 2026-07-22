# 경영 도우미 — 대화(세션)형 진화 설계

> 배경: [[mgmt-query-assistant.design.md]]에서 만든 절차식 조회(QuerySpec → 검증 집계 → 차트)를 **사용자별 대화 세션**으로 진화시킨다. ChatGPT처럼 좌측에 대화 목록(생성·이름변경·삭제), 각 대화는 사용자가 조건을 골라 만든 **차트 메시지의 타임라인**. 각 차트는 **저장된 조건으로 언제든 새로고침**(기준시각 표시)할 수 있다.
>
> 핵심 가치: **경영자가 실무자에게 자주 묻는 차트(월 매출 추이, 거래처 Top, 비목별 지출 등)를 스스로 고정해 두고 아무 때나 열어 최신화**. 실무자 질의 부하를 줄이고, 경영자가 데이터에 직접 접근.
>
> 설계 원칙:
> 1. **채팅 셸을 먼저, LLM은 나중.** 지금은 입력부 = 메뉴 드릴다운(컴포저). 나중에 LLM이 오면 **입력부만 텍스트 입력으로 교체** — 세션·저장·차트·새로고침은 그대로. 버리는 작업 없음.
> 2. **스냅샷 저장.** 각 차트 메시지는 만든 시점의 결과(result_json)를 저장 → 다시 열면 마지막 본 상태 그대로, "N분 전 기준" 표시. ⟳ 새로고침을 눌러야 재계산.
> 3. **상대 기간은 조건으로 저장.** "최근 3개월"은 날짜가 아니라 프리셋으로 저장 → 새로고침 시점 기준으로 재계산.
> 4. **사용자별 격리.** 대화는 `user_id`로 격리(같은 회사라도 남의 대화 안 보임). 멀티테넌트 `req.db` + `req.user.id`.

---

## 1. 데이터 모델 (신규 2테이블, req.db · 사용자별)

`db.js` 셋업에 `CREATE TABLE IF NOT EXISTS`로 추가(런타임 DDL 아님, setup:db 시점). 기존 컨벤션(VARCHAR(36) PK, created_at) 따름.

```sql
CREATE TABLE IF NOT EXISTS analytics_chats (
  id          VARCHAR(36) PRIMARY KEY,
  user_id     VARCHAR(36) NOT NULL,          -- 소유자(req.user.id). 대화 격리 기준
  title       VARCHAR(120) NOT NULL DEFAULT '새 대화',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_chats_user (user_id, updated_at)
);

CREATE TABLE IF NOT EXISTS analytics_chat_items (
  id           VARCHAR(36) PRIMARY KEY,
  chat_id      VARCHAR(36) NOT NULL,
  spec_json    JSON NOT NULL,               -- QuerySpec: {topic,group,period,from?,to?,filter?}
  title        VARCHAR(160),                -- "매출 · 거래처별 · 최근 3개월" (버블 제목)
  result_json  JSON,                        -- 스냅샷: {rows,total,summary,chart,periodLabel...}
  refreshed_at TIMESTAMP NULL,              -- 마지막 계산 시각("N분 전 기준")
  sort_order   INT DEFAULT 0,               -- 타임라인 순서(created 순 == 대화 흐름)
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES analytics_chats(id) ON DELETE CASCADE
);
```

- `spec_json` = 재계산의 유일한 근거. **상대 기간(period 프리셋)을 그대로 저장** → 새로고침 시 그때 날짜로 환산.
- `result_json` = 스냅샷. 없으면(막 생성) 최초 계산으로 채움. 스키마는 aggregate 응답 + summary 문장 + 차트타입.
- 대화 삭제 → 항목 CASCADE 삭제.
- **다른 기기/재로그인에도 유지**(DB 저장이라 localStorage 아님).

---

## 2. API (신규, `server/routes/analytics.js`에 추가 · req.db · 소유자 검증)

모든 엔드포인트: `WHERE user_id = req.user.id`(대화) / 항목은 소속 대화의 소유자 확인. 남의 대화 접근 404.

| 메서드·경로 | 동작 | 비고 |
|---|---|---|
| `GET /api/analytics/chats` | 내 대화 목록 | `updated_at DESC`. 각 대화 항목수·마지막제목 요약 포함 |
| `POST /api/analytics/chats` | 새 대화 | body `{title?}`. 반환 `{id,...}` |
| `PATCH /api/analytics/chats/:id` | 이름 변경 | body `{title}` |
| `DELETE /api/analytics/chats/:id` | 대화 삭제 | 항목 CASCADE |
| `GET /api/analytics/chats/:id/items` | 대화의 차트 타임라인 | `sort_order, created_at` 순 |
| `POST /api/analytics/chats/:id/items` | 질문 추가 = 차트 생성 | body `{spec}`. **서버가 aggregate 계산 → result_json·refreshed_at 저장** → 스냅샷 포함 반환. `chats.updated_at` 갱신 |
| `POST /api/analytics/chat-items/:id/refresh` | 새로고침 | 저장된 spec으로 **재계산 → result_json·refreshed_at 갱신** → 반환 |
| `DELETE /api/analytics/chat-items/:id` | 항목 삭제 | 타임라인에서 제거 |
| (재사용) `GET /api/analytics/aggregate` | 컴포저 미리보기 | 저장 전 즉석 조회에도 그대로 사용 가능 |

**핵심: 계산 로직 공용화.** 기존 aggregate의 집계부를 내부 함수 `runAggregate(db, spec)`로 추출해 `/aggregate`·`/items`(생성)·`/refresh` 셋이 공유. QuerySpec → rows/total은 한 곳에서만.

`runAggregate`가 만드는 스냅샷:
```js
{ topic, group, periodLabel, from, to, chart /* line|bar */,
  rows:[{key,label,value,count}], total,
  summary /* 한 줄 요약 문장 */ }
```
요약 문장 생성도 서버로 이동(스냅샷에 박제) → 프론트는 렌더만. (LLM 전환 후에도 요약 규칙 재사용)

---

## 3. 새로고침 / 스냅샷 의미

- 항목 생성 시: spec으로 즉시 계산 → 스냅샷 저장, `refreshed_at = now`.
- 다시 열 때: **스냅샷 그대로 렌더** + "⟳ 3분 전 기준"(now - refreshed_at 상대표기, KST).
- ⟳ 클릭: `/refresh` → spec 재계산(상대기간이면 최신 날짜로) → 스냅샷·시각 갱신 → 버블 in-place 업데이트.
- 상대표기 규칙: <1분 "방금", <60분 "N분 전", <24시간 "N시간 전", 그 외 "M/D HH:mm". 절대시각은 title 툴팁.

---

## 4. 프론트 — 2단 채팅 UI (`src/screens/MgmtAsk.jsx` 진화)

기존 단일화면 → 좌측 대화목록 + 우측 스레드. route·잎(`mgmt_ask`) 유지.

```
┌───────────────┬────────────────────────────────────────────┐
│ + 새 대화       │  (대화 제목) ✎이름변경                         │
│───────────────│                                              │
│ ▸ 월 매출 추이  │  [질문 버블·우측] 매출 · 거래처별 · 최근 3개월   │
│   거래처 Top   │  ┌────────────────────────────────┐ ⟳ 3분 전 │
│   비목별 지출   │  │ (막대 차트)                       │ 기준     │
│   …            │  │ 요약: …가장 큰 거래처는 …          │         │
│   [⋯ 삭제/이름] │  │ [그리드 펼치기]                    │         │
│               │  └────────────────────────────────┘         │
│               │  ───────────────────────────────────────    │
│               │  [컴포저] 매출/매입 → 기준 → 기간 → [추가]      │
└───────────────┴────────────────────────────────────────────┘
```

### 4-1. 좌측 목록
- `+ 새 대화` → POST chats → 우측 빈 스레드(컴포저만).
- 항목: 제목, 마지막 갱신 상대시각. 클릭 → 우측 로드.
- hover ⋯ → 이름변경(인라인)·삭제(확인 모달).
- 빈 상태: "자주 보는 질문을 대화로 저장해 두세요."

### 4-2. 우측 스레드
- 항목마다 **질문 버블(우측 정렬, 조건 요약)** + **응답 카드(요약문 + 차트 + 접이식 그리드)**.
- 응답 카드 우상단: ⟳ 새로고침 + "N분 전 기준" + ⋯(삭제).
- 차트: 월별=라인, 그 외=막대(기존 경량 SVG 재사용).
- 스크롤 최하단 = 최신. 새 항목 추가 시 하단으로 스크롤.

### 4-3. 컴포저(하단 고정)
- 지금의 드릴다운(무엇을 → 기준 → 기간)을 **한 줄 인라인 칩 바**로 압축. 세 값 다 고르면 `[추가]` 활성.
- 기간에 상대 프리셋 강조(이번달·이번분기·올해·최근 3개월·최근 12개월). 최근 3개월 추가.
- `[추가]` → POST items(spec) → 스레드에 버블 append.
- (선택) 추가 전 즉석 미리보기: aggregate로 축소 프리뷰 — MVP는 생략, 바로 추가.

### 4-4. api.js 클라이언트
`getChats/createChat/renameChat/deleteChat/getChatItems/addChatItem/refreshChatItem/deleteChatItem` 추가. 기존 `getAnalytics`(aggregate)는 유지.

---

## 5. LLM 확장 경로 (지금 셸이 토대인 이유)

- 지금: 컴포저 = 메뉴. `[추가]`가 QuerySpec을 만들어 POST.
- 다음: 컴포저에 **텍스트 입력** 추가 → 문장을 LLM이 QuerySpec(JSON)으로 변환 → **동일한 POST items** 실행. 세션·스냅샷·새로고침·삭제 전부 그대로.
- 더 나중: 응답에 LLM 코멘터리(요약 문장을 규칙→생성으로) 얹기. `result_json.summary`만 생성 소스가 바뀜.
- 즉 이 설계의 **대화·항목 테이블과 API가 곧 LLM 챗의 백엔드**. 챗 히스토리 = analytics_chat_items.

---

## 6. 보안 / 격리

- 대화·항목 모든 쿼리에 `user_id = req.user.id` 강제. 항목 접근은 `JOIN analytics_chats ON ... WHERE chats.user_id = ?`.
- aggregate와 동일하게 group/filter 컬럼 화이트리스트(spec_json은 저장 전 **서버에서 정규화**: 허용된 topic/group/period/filter 키만 통과, 그 외 폐기). 저장된 spec도 refresh 시 다시 화이트리스트 통과.
- `req.db`만 사용(전역 풀 금지, check-isolation 통과).

---

## 7. 단계별 구현 계획

| 단계 | 내용 | 검증 |
|---|---|---|
| 1 | db.js 2테이블 + `runAggregate` 추출(생성/refresh/aggregate 공용) + 요약문 서버 이동 | Node http: aggregate 회귀(기존 값 동일) |
| 2 | chats CRUD API (목록·생성·이름·삭제) | curl: 사용자 격리(타 user 404) |
| 3 | items API (목록·추가=계산저장·refresh=재계산·삭제) | curl: 추가 후 스냅샷/refreshed_at, refresh로 값·시각 갱신 |
| 4 | api.js 클라이언트 8종 | — |
| 5 | 프론트 2단 셸: 좌측 목록(CRUD) | Playwright: 새대화·이름·삭제 |
| 6 | 우측 스레드: 버블+차트+그리드+요약, 컴포저 추가 | Playwright: 추가→버블, 라인/막대 렌더 |
| 7 | 새로고침(기준시각 상대표기) + 항목 삭제 | Playwright: ⟳ 후 "방금 기준" |
| 8 | 빈 상태·스크롤·이름 자동생성(첫 항목 조건으로 대화 제목 제안) | 시연 |

- **1~4(백엔드+클라이언트)**는 한 세션에서 안전하게 묶어 구현·검증(파운데이션, 병렬화 위험).
- **5~8(프론트 셸)**은 규모 커서 별도 세션/에이전트로 분담 가능. API 계약(2·3절)이 고정돼 있으면 독립 진행 가능.

---

## 8. 범위 / 주의

- **과설계 금지**: 즉석 미리보기·막대 클릭 드릴·CSV·전기대비는 후속(기존 [[mgmt-query-assistant.design.md]] §8과 합류). MVP = 세션 CRUD + 컴포저 추가 + 스냅샷 새로고침.
- **상대기간 박제 금지**: period는 프리셋으로 저장(날짜 환산 결과를 저장하면 새로고침이 무의미).
- **KST**: refreshed_at 상대표기·기간 경계 모두 KST.
- **제목 자동**: 새 대화 첫 항목 추가 시 title이 '새 대화'면 그 조건 요약으로 자동 명명(사용자 수정 가능).
- 관련: [[mgmt-query-assistant.design.md]](aggregate·QuerySpec 원형), `analytics.js`, `MgmtAsk.jsx`.
```
