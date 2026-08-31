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
| 문서업무 잎만 추가하기 | `server/platform/docCatalog.js`에도 같은 key 로 등록 (안 하면 회사별로 못 끈다) |

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

- **프런트**: React 18 + Vite. 해시 라우팅(`#<잎 id>` — 메뉴 구조는 `src/lib/nav.js` 한 곳이 원본)
- **UI 컴포넌트**: `src/lib/ui.jsx` + `src/lib/components/*` (Drawer·DataTable·TableToolbar·Kpi 등)
- **상태 관리**: 컴포넌트 로컬 state + prop drilling (전역 상태 없음)
- **백엔드**: Express + MariaDB. **DB-per-tenant 멀티테넌트 운영 중**(`server/`)
- **엑셀 출력**: 새 출력은 `server/lib/xlsxBook.js`(exceljs, 서식 있음). 옛 출력 일부는
  아직 `xlsx`(SheetJS) — 서식이 없다. 옮기는 중이다.

---

## 핵심 파일 구조

```
src/
├── lib/
│   ├── nav.js       ← **메뉴 구조의 원본.** 사이드바·홈 포털·브레드크럼·Ctrl+K 가 공유
│   ├── api.js       ← 서버 API 레이어(실서버). snake_case ↔ camelCase 변환도 여기서
│   ├── ui.jsx       ← 공통 부품 (Icon, StatusBadge, Combobox, Drawer, useToast …)
│   └── components/  ← DataTable·TableToolbar·Kpi·InvoiceLines·QuickDock·VoucherView …
└── screens/         ← 화면. 라우트 id ↔ 화면은 App.jsx 의 switch 가 잇는다
server/
├── routes/          ← API. ⚠ 새 라우트는 platform/apiPerms.js 에 자원 매핑 필수
├── lib/             ← 규칙이 사는 곳(voucher·recurrence·vat·ledger·closing·xlsxBook …)
└── platform/        ← 테넌트·권한·스키마 (permissions.js RESOURCES 는 nav 잎과 1:1)
```

> ⚠ **계산 규칙은 서버 `lib/` 한 곳에만 둔다.** 분개(voucher)·부가세(vat)·정기 회차(recurrence)를
> 화면에서 다시 계산하면 같은 거래가 두 가지 답을 갖게 된다.

---

## 데이터 규칙

### 단일 데이터 소스 원칙
- 미수금/미지급금은 **청구서(invoices)** 가 유일한 소스
- 목 데이터(`SAMPLE.*`)는 **증빙 관리 화면(미구현)에만** 남아 있다. 새 코드에서 쓰지 말 것

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

> 2026-08-26 전수 확인. 여기 적힌 것만 남았다 — 예전 목록의 계약 마일스톤·원가예산 탭,
> 부가세 탭, 홈 계좌잔액 하드코딩, 증빙유형 목업은 **전부 구현·해소됐다.**

- **증빙 관리 화면 (route `evidence`)** — 유일하게 남은 목업이다. 지금은 `ComingSoon`으로
  막아 두었고 `Docs.jsx`의 `EvidenceScreen`(+`SAMPLE.evidences`)은 죽은 코드로 남아 있다.
  실구현 방향: 거래 `evid_url` 집계 + 증빙 누락(증빙 없는 지출) 관리 + 파일 업로드→거래 연결.
  (실제 증빙 **첨부**는 거래 등록 폼·계약 상세 증빙 탭에서 이미 동작한다 — 없는 건 '한눈에 보는 화면'뿐)

- **`xlsx`(SheetJS) 취약점** — high 2건, npm 에 수정본이 없다. **읽기(업로드 파싱) 경로만**
  아직 이걸 쓴다(`server/lib/xlsx-import.js`). 인증 뒤에 있어 즉시 위험은 아니지만
  방치할 성격은 아니다.
  > 쓰기(내려받기)는 2026-08-26 에 전부 `server/lib/xlsxBook.js`(exceljs)로 옮겼다.
  > 새 엑셀 출력은 반드시 여기를 쓴다 — `sheet`(표 하나), `blockSheet`(한 장에 구획 여럿),
  > `templateSheet`(업로드 양식) + `guideSheet`(안내).
  > ⚠ 업로드 양식의 **머리글 글자는 건드리지 않는다.** `상호명 *` 처럼 별표를 붙이면
  > 임포트 파서가 다른 열로 읽어 왕복이 깨진다. 필수는 바탕색 반전으로 표시한다.


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
