# focus-accounter — Claude Code 컨텍스트

## 🔴 최우선 규칙 — 멀티테넌트

이 서비스는 **하나의 서버에서 여러 회사의 회계 데이터**를 다룹니다(DB-per-tenant).
아래를 어기면 **에러 없이 조용히 남의 회사 데이터를 읽거나 씁니다.**

| 하지 말 것 | 대신 |
|---|---|
| `require('../db')` 에서 `pool` 가져오기 | **`req.db`** (tenant 미들웨어가 주입) |
| `async (_, res, next)` | `async (req, res, next)` — `req` 없으면 `req.db`도 없음 |
| 헬퍼에서 전역 풀 참조 | 헬퍼에 **`db`를 인자로** 전달 (`db = pool` 같은 기본값 금지) |
| 파일을 `uploads/` 바로 아래 저장 | `uploads/{companyId}/` |
| 앱 코드에서 `CREATE`/`ALTER` | 배포 시점 `npm run setup:db` |
| 화면(nav) 추가 후 그냥 두기 | `server/platform/permissions.js` `RESOURCES`에도 등록 |

**작업 후 필수**: `cd server && npm run check:isolation`

- 상세 규칙·실수 사례: `docs/reference/multi-tenant-dev-guide.md`
- 회사 추가/삭제·운영: `docs/reference/tenant-operations.md`
- 구조 설계: `docs/02-design/features/multi-tenant-saas.design.md`
- 향후 로드맵: `docs/01-plan/features/post-multitenant-roadmap.plan.md`

---

## 프로젝트 개요

**도니도라** — 재무·회계관리 SaaS. `https://donidora.com`
Express + MariaDB 백엔드 + React/Vite SPA. **멀티테넌트 운영 중**(2026-07-22~).

- 운영 테넌트: `fowin` ((주)포커스윈) / 테스트: `claude`
- 회사 추가: `cd server && npm run tenant -- --code … --name … --user … --password …`
- 로그인은 **3필드**: 회사코드 + 아이디 + 비밀번호

> 아래 문서의 일부 서술(동진테크 전용·목 데이터 단계 등)은 초기 프로토타입 기준이라
> 현재와 다를 수 있습니다. 도메인 지식 참고용으로만 보세요.

---

## 기술 스택

- **프레임워크**: React 18, Vite
- **라우팅**: Hash 라우팅 (`#home`, `#ledger`, `#billing`, `#contract`, `#hr`, `#docs`, `#master`)
- **UI 컴포넌트**: `src/lib/ui.jsx` (자체 컴포넌트 라이브러리)
- **상태 관리**: 컴포넌트 로컬 state + prop drilling (전역 상태 없음)
- **백엔드**: 없음 (목 데이터, 추후 bkend.ai BaaS 연동 예정)

---

## 핵심 파일 구조

```
src/
├── lib/
│   ├── data.js      ← 목 데이터 단일 소스 (VENDORS, INVOICES, ACCOUNTS_BALANCE 등)
│   ├── api.js       ← API 레이어 (현재 data.js 참조, 실서버 연결 시 이 파일만 교체)
│   └── ui.jsx       ← 공통 컴포넌트 (Icon, StatusBadge, Combobox, useToast 등)
└── screens/
    ├── Home.jsx     ← 대시보드
    ├── Ledger.jsx   ← 거래내역 (원장)
    ├── Form.jsx     ← 거래 등록 Drawer (Ledger에서 사용)
    ├── Billing.jsx  ← 청구서 관리 (미수금/미지급금)
    ├── Contract.jsx ← 계약, 미수금 목록, 미지급금 목록
    ├── Docs.jsx     ← 보고서, 결의서
    ├── Hr.jsx       ← 인사/급여
    └── Master.jsx   ← 설정 (업체, 계정과목, 계좌, 임직원, 정기지출)
```

---

## 데이터 규칙

### 단일 데이터 소스 원칙
- 미수금/미지급금은 **`INVOICES`** 가 유일한 소스
- `SAMPLE.receivables`, `SAMPLE.payables` 사용 금지 (레거시 — 제거 예정)
- 미수금 화면 → `api.getReceivables()` / 미지급금 화면 → `api.getPayables()` 경유

### VENDORS.gubu 코드
- `"B"` = 발주처 (매출처) — 청구서 issued 시 업체 필터
- `"A"` = 외주/원자재/기타 (매입처) — 청구서 received 시
- `"E"` = 기관 (금융, 관공서) — received 시 A와 함께 표시
- 한빛이엔지 COERP_COM_CLIENTELE.clie_gubu 코드 체계 동일 적용

### CATEGORIES 코드
- `EXP-1xx~4xx` = 생산비 (외주가공비, 재료비, 경비)
- `EXP-5xx~9xx` = 관리비 (임차료, 통신비 등)
- `INC-1xx~2xx` = 매출/수익

### INVOICES 상태값
- issued: `"입금 예정"` | `"일부 입금"` | `"입금 완료"` | `"기한 지남"` | `"장기 미수"`
- received: `"지급 대기"` | `"지급 예정"` | `"일부 지급"` | `"지급 완료"` | `"기한 지남"`

---

## 주요 패턴

### Drawer 패턴
모든 폼/상세는 Drawer 컴포넌트 사용. 열림/닫힘은 로컬 boolean state.
```jsx
const [drawerOpen, setDrawerOpen] = useState(false)
<Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="...">
```

### api 연동 패턴
```jsx
const [data, setData] = useState(initialState)
const load = async () => {
  const result = await api.getSomething()
  setData(result)
}
useEffect(() => { load() }, [])
```

### Combobox 드롭다운
```jsx
import { Combobox } from '../lib/ui'
<Combobox
  value={form.vendor}
  onChange={v => setForm(prev => ({ ...prev, vendor: v }))}
  options={VENDORS.filter(v => v.gubu === "B").map(v => ({ value: v.name, label: v.name, sub: v.type }))}
  placeholder="업체 선택"
/>
```

---

## 알려진 미구현 항목

- `Docs.jsx` / `Ledger.jsx` — 아직 `SAMPLE.receivables`/`SAMPLE.expenses` 직접 참조 중 (api 전환 필요)
- 계약 마일스톤 탭, 원가예산 탭 (Contract.jsx)
- 부가세 탭 (Docs.jsx)
- 홈 대시보드 계좌잔액 카드 (일부 하드코딩)
- **증빙유형 (Master.jsx `MASTER_DATA.evidenceType`)** — 목업. 저장/백엔드 없음. 현재 기준정보 nav에서 숨김 처리(`MASTER_SECTIONS.base`에서 제외). 추후 적격증빙 분류(세금계산서·카드전표·현금영수증·간이영수증·거래명세서 + 부가세 공제가능 여부)로 구현 예정 → ref_items `type='evidence_type'` CRUD + 거래 증빙첨부 드롭다운 + 부가세 매입세액 집계 연동
- **증빙 관리 화면 (`Docs.jsx` `EvidenceScreen` / route `evidence`)** — 목업. `SAMPLE.evidences`·`SAMPLE.evidenceMissing`만 표시하고 업로드/다운로드/알림 버튼은 토스트만. API 없음. **2026-07 nav에서 숨김**(`nav.js` 사이드바+명령팔레트에서 `evidence` 제외, FAQ f15·f16의 evidence 링크 제거). route/화면 코드는 남겨둠. 추후 여유 있을 때 실구현 예정 → 거래 `evid_url` 집계 + 증빙 누락(evid 없는 지출) 관리 + 파일 업로드→거래 연결. (실제 증빙 첨부는 거래 등록 폼 `EvidUploader`/계약 상세 증빙 탭에서 이미 동작)

---

## 설계 문서

- `docs/01-plan/features/focus-accounter-v2.plan.md` — 기능 계획
- `docs/02-design/features/focus-accounter-v2.design.md` — 데이터 모델·화면 설계
- `docs/02-design/features/system-flow.design.md` — 전체 흐름·DB 스키마·API 설계
- `docs/reference/hanvit-db.md` — 한빛이엔지 DB 참고 (도메인 지식)

---

## 도메인 지식

- **방산 납품 수금 구조**: 계약 → 마일스톤(선급금/기성고/잔금) → 청구서 발행 → 입금
- **경리 주 업무**: 청구서 발행/수취, 거래내역 입력, 정기지출 확인, 부가세 신고 자료 준비
- **계좌**: 기업은행 주거래 *4010 (메인), 하나은행 급여이체 *7231, 기업은행 시제통장 *077
- **규모**: 발주처 9개사, 외주/매입처 21개사, 직원 약 22명
