# 멀티테넌트 이후 로드맵

> **Version**: 1.0
> **Date**: 2026-07-22
> **Status**: Draft — 순서 확정, 단계별 착수 대기
> **선행**: 멀티테넌트 전환 완료 ([[multi-tenant-saas.design.md]], 2026-07-22 운영 배포)

---

## 0. 전체 순서와 근거

```
Phase 1  전체 코드 품질 검토
    ↓
Phase 2  공통 컴포넌트화 (Drawer · DataTable · Form · Toolbar)
    ↓
Phase 3  UI 다듬기
    ↓
Phase 4  권한 관리(P5) + 셀프 가입(P4)
```

### 왜 권한 관리가 마지막인가

권한 적용은 **모든 화면의 버튼·메뉴에 조건부 렌더**를 붙이는 작업입니다. 지금 상태로 하면:

| 현황 | 권한을 지금 붙이면 | 컴포넌트화 후 붙이면 |
|---|---|---|
| `Drawer` 192회 사용 | 192곳에 권한 분기 | 공통 컴포넌트 **1곳** |
| `<table>` 62회 반복 | 62곳에 삭제/수정 버튼 분기 | `DataTable` **1곳** |
| Master.jsx 3050줄 | 거대 파일에서 누락 발생 | 분리된 단위로 검증 가능 |

**컴포넌트화를 먼저 하면 권한 적용 지점이 수십 분의 1로 줄고, 누락 위험도 그만큼 줄어듭니다.** 사용자가 제안한 순서가 맞습니다.

> ⚠️ 다만 **서버 측 `requirePerm`은 컴포넌트화와 무관**합니다. 프런트가 늦어져도 서버 가드는 먼저 붙일 수 있고, 그게 진짜 방어선입니다. Phase 4에서 서버부터 착수합니다.

---

## Phase 1 — 전체 코드 품질 검토

### 범위
멀티테넌트 전환분은 이미 별도 검토함. 여기서는 **그 이전부터 쌓인 코드** 전체.

### 점검 항목
| 영역 | 내용 |
|---|---|
| **금액·날짜 정합성** | 돈이 움직이는 모든 경로가 `transactions`에 남고 계좌잔액에 반영되는가 (과거 F-02 P0 재발 방지) |
| **트랜잭션 누락** | 다중 테이블 수정이 트랜잭션으로 묶였는가, `finally { release() }` 있는가 |
| **삭제 정합성** | 삭제 시 연관 행·파일이 함께 정리되는가, FK 제약이 맞는가 |
| **에러 처리** | 사용자에게 원인이 전달되는가(500 대신 친절한 409/400) |
| **KST 일관성** | 날짜 계산이 `kstToday`/`kstDate` 로 통일됐는가 |
| **미사용 코드** | `SAMPLE.*` 잔재, 죽은 라우트, 숨긴 화면(`evidence`) 정리 |
| **api.js 비대화** | 1223줄. 도메인별 분리 검토 |

### 산출물
- 결함 목록(우선순위별) + 즉시 수정분 커밋
- 큰 건은 별도 이슈로 분리

---

## Phase 2 — 공통 컴포넌트화

### 현황 (2026-07-22 측정)

| 파일 | 줄 수 | Drawer | `<table>` |
|---|---|---|---|
| `Master.jsx` | **3050** | 64 | 16 |
| `Contract.jsx` | **2149** | 31 | 10 |
| `Docs.jsx` | **2075** | 17 | 18 |
| `WorkContract.jsx` | 961 | 34 | 6 |
| `Billing.jsx` | 948 | 15 | 2 |
| `HR.jsx` | 581 | 11 | 5 |
| `Tax.jsx` | 451 | 12 | 2 |
| **합계** | 14575 | **192** | **62** |

### 2.0 착수 순서 — 실측 근거 (2026-07-22 측정)

| 순위 | 대상 | 개수 | 현재 상태 | 근거 |
|---|---|---|---|---|
| **1** | **KPI 카드** | **53** | **정의가 3벌로 분기** | 통합 비용 최소인데 **이미 버그를 만들고 있음** |
| **2** | 표(DataTable) | 62 (+빈상태 78) | 없음 | 정렬·합계·빈상태를 62곳이 각자 재구현 |
| 3 | 컨테이너 / Drawer 머리·발 | 35 / 34 | `Drawer`만 존재 | 껍데기는 있는데 머리·발은 각자 만듦 |
| 4 | 경고·확인창 | confirm 25 / toast 234 | **부품은 이미 있음** | 필요한 건 컴포넌트가 아니라 **문구 규약** |
| 5 | 버튼 | 274 (+icon-btn 61) | CSS로 통일됨 | 개수 1위지만 로직이 없어 **얻는 것 대비 회귀 위험이 큼** |
| — | 로딩 | — | ✅ `Spinner`/`Loading` 완료 | 2026-07-22 추가 |

`ui.jsx`가 이미 제공: `Drawer` `useConfirm` `useToast` `Combobox` `StatusBadge` `MoneyInput` `FilterSelect` `Spinner` `Loading` `Popover`

#### KPI 카드를 1순위로 두는 이유

정의가 셋으로 갈라져 있고 **prop 이름이 서로 다릅니다**:

```jsx
Docs.jsx:1345  StatCard ({ label, value,  unit = "원", tone })   // 30곳
Tax.jsx:9      StatCard ({ label, amount, tone = 'ink', hint })  //  7곳
Home.jsx:27    MiniStat ({ label, value,  sub, tone })           // 16곳
```

`Docs`의 `<StatCard value={…}/>`를 `Tax`로 복사하면 **에러 없이 빈 칸이 렌더**됩니다.
(같은 유형의 실제 버그를 2026-07-22에 발견: `WorkContract.jsx`가 존재하지 않는 `a.bank`를 읽고 있었음 — `adaptAccount`는 `bankName`을 준다)

#### 곁다리 효과 — 화면 간 의존 해소

현재 **화면이 화면에서 부품을 꺼내 쓰고 있습니다**:

```
Contract.jsx     → './Home'  (MiniStat)
HR.jsx           → './Home'  (MiniStat)
Ledger.jsx       → './Docs'  (ResolutionDocument)
Docs.jsx         → './HR'    (computeItems·shiftMonth·monthLabel)
WorkContract.jsx → './HR'    (computeItems·monthLabel)
```

`Home.jsx`를 건드리면 `Contract`·`HR`이 같이 흔들립니다.
**KPI 카드를 `lib/components/`로 빼면 이 의존 5개 중 3개가 저절로 사라집니다.**

> 2026-07-22: `WorkContract.jsx`가 `'./Hr'`(실제 파일은 `HR.jsx`)를 참조하던 대소문자
> 오타를 발견·수정(커밋 `6bf0121`). Windows에선 드러나지 않고 **리눅스 빌드에서만** 깨지는
> 종류였음. 화면 간 직접 import가 줄면 이런 사고 표면도 함께 줄어듭니다.

---

### 2.1 `DataTable`
62곳의 테이블 마크업이 각자 정렬·빈상태·로딩·합계행을 다시 구현하고 있음.

```jsx
<DataTable
  columns={[
    { key: 'date',   label: '일자',  width: 110 },
    { key: 'vendor', label: '거래처' },
    { key: 'amount', label: '금액',  align: 'right', format: 'money', total: true },
  ]}
  rows={rows}
  empty="거래 내역이 없어요"
  onRowClick={openDetail}
  actions={[{ icon: 'edit', perm: 'edit', onClick: … }]}   // ← Phase 4 권한 연결 지점
/>
```
포함: 정렬 · 빈 상태 · 로딩 스켈레톤 · 합계행 · 금액 콤마 · 행 클릭 · 액션 버튼

### 2.2 `FormDrawer`
192회의 Drawer가 각자 열림상태·제목·푸터버튼·저장중 처리·유효성 표시를 반복.

```jsx
<FormDrawer open={open} onClose={close} title="거래처 등록"
            onSubmit={save} submitting={saving} perm="create">
  <Field label="상호명" required error={err.name}>…</Field>
</FormDrawer>
```

### 2.3 `Field` / 입력 공용화
`Combobox`·칩·금액입력·날짜입력의 라벨·필수표시·에러표시를 통일.
> 기존 규칙 유지: **짧은 enum은 칩, 긴 목록은 Combobox. 기본 `select` 금지**

### 2.4 `ListToolbar`
검색·기간필터·구분필터·엑셀 내보내기 버튼 묶음. 화면마다 조금씩 다르게 구현돼 있음.

### 2.5 화면 파일 분해
`Master.jsx`(3050줄)를 탭별 파일로 분리. `Contract.jsx`·`Docs.jsx`도 동일.

### 원칙
- **한 번에 하나씩, 화면 하나로 검증 후 확산.** 62곳을 한 번에 바꾸지 않는다
- 컴포넌트는 `src/lib/ui.jsx`(608줄)에 무한정 추가하지 말고 `src/lib/components/` 로 분리
- 각 단계마다 빌드 + 실화면 확인

---

## Phase 3 — UI 다듬기

Phase 2로 마크업이 한곳에 모인 뒤에 착수해야 효과가 있음(지금 다듬으면 62곳을 각각 손봐야 함).

- 빈 상태·로딩·에러 표현 통일
- 목록 밀도·정렬·금액 우측정렬 일관성
- 반응형 점검(현재 데스크톱 위주)
- 인쇄 양식(결의서·명세서) 정리
- 접근성 기본(라벨·포커스·키보드)

---

## Phase 4 — 권한 관리 + 셀프 가입

### 4.1 서버 가드 (먼저, 프런트와 무관하게 착수 가능)
`requirePerm(resource, action)` 을 전 라우트에 부착.
```js
router.post('/',      requirePerm('master_vendor','create'), handler)
router.delete('/:id', requirePerm('master_vendor','delete'), handler)
```
- 자원·행위 카탈로그는 **이미 완성**: `server/platform/permissions.js` (자원 33 × 행위 8)
- 역할·권한 데이터도 **이미 생성됨**(마스터/경리/조회전용) — 회사 생성·부트스트랩 시 자동
- 남은 것: 라우트↔자원 매핑 + 미들웨어 부착 + `req.perms` 로딩·캐시

### 4.2 프런트 반영
- 로그인 응답에 `perms` 포함 → nav 메뉴 숨김(`access` 없으면), 버튼 비활성(`create`/`edit`/`delete`)
- Phase 2의 `DataTable`·`FormDrawer`에 `perm` prop 연결 → **한 곳에서 전 화면 적용**

### 4.3 권한 관리 화면 (마스터용)
- 역할별 **자원 × 행위 매트릭스** 체크박스 (33 × 8, 도메인별 접기)
- 계정↔역할 지정, 사내 계정 생성/비활성/비번 리셋
- 감사 로그 조회

### 4.4 셀프 가입 (P4)
가입 폼 → `provisionTenant()` 호출(CLI와 동일 서비스 코드). 회사코드 중복확인 실시간.

### 4.5 기타 남은 것
- `donidora.kr` → `.com` 301 리다이렉트
- 마스터 이메일 기반 비밀번호 재설정(현재는 마스터가 사내 계정 리셋만 가능)

---

## 병행 가능한 별도 트랙

로드맵과 독립적으로 진행 가능한 업무 기능:

- **재무관리 도메인** — 부채(차입금)·투자·보험·계약없는 정기지출 ([[next_steps]])
- 거래명세서(`invoice_lines`) 인쇄 출력
- 지급예정 파이프라인 Phase 2~3

> 이들 작업 시 **반드시** `docs/reference/multi-tenant-dev-guide.md` 규칙을 따를 것.
> 새 화면을 추가하면 `permissions.js`의 `RESOURCES`에도 등록해야 `check:isolation`을 통과합니다.

---

## 리스크

| 리스크 | 대응 |
|---|---|
| 컴포넌트화 중 회귀 | 화면 하나씩 전환 + 매 단계 실화면 확인. 대량 일괄 치환 금지 |
| 권한 적용 누락 | 서버 `requirePerm`이 최종 방어선. 프런트 숨김만 믿지 않는다 |
| 리팩터 중 업무 기능 요청 | Phase 2는 중단·재개가 쉬움(화면 단위). 급한 기능 먼저 처리 후 복귀 |
| 두 번째 실사용 회사 온보딩 | Phase와 무관하게 언제든 가능. 온보딩 시 교차 검증 절차 수행 |
