# 미커밋본 품질검토 — 수정 설계서 (2026-07-16)

리팩터 브랜치 `refactor/portal-ia`의 미커밋 변경분 품질검토에서 나온 결함들의
**근본 원인 분석 · 해결 설계 · 다방면 검토**. 국소 패치가 아니라 정합성이 깨진 지점은
공용화/스키마 수준으로 정립한다.

범위: HIGH 3건 + MEDIUM 5건 + LOW(선별) 4건.

---

## 정립 1 — 정기 반복일 계산 공용화 (H3 + M1)

### 증상
- **H3** `recurring.js`(정기지출): `calcNextDate`가 `period`를 전혀 안 봄 → 분기/연 정기지출이 **매달** 생성.
- **M1** `recurring-invoices.js`(정기청구): `dueDatesToGenerate`의 스텝 `new Date(d.getFullYear(), d.getMonth()+step, day)`가
  이미 오버플로된 `d`의 월을 다시 기준 삼아, 기준일 ≥ 29일이면 회차가 밀리고 누락(예: 31일 기준 → 격월로만, 2월 누락).

### 근본 원인
두 라우트가 반복일 계산을 **각자 다르게** 구현. 하나는 period 미반영, 하나는 월말일 오버플로 버그.
동일 도메인 로직의 이중 구현 → 정합성 붕괴.

### 해결 (정립)
공용 모듈 `server/lib/recurrence.js` 신설. 단일 함수로 통합:

```js
// 앵커(start_date의 day_of_month)에서 period 간격으로 밟아 today까지의 미생성 회차 목록.
// 월말일은 그 달 말일로 clamp(31일 앵커 → 2월 28/29, 4월 30). 원 앵커 기준 절대월 계산이라 드리프트 없음.
function dueDatesToGenerate(rec, today) {
  if (!rec.start_date) return []
  const step = rec.period === 'yearly' ? 12 : rec.period === 'quarterly' ? 3 : 1
  const [sy, sm] = rec.start_date.split('-').map(Number)          // sm: 1-indexed
  const anchorDay = Number(rec.day_of_month) || Number(rec.start_date.split('-')[2]) || 1
  const todayStr = fmtDate(today)
  const floor = rec.last_generated || ''                          // 이 값 이하는 이미 생성됨
  const out = []
  for (let i = 0; i < 1200; i++) {                                // 안전 상한(월간 100년)
    const abs = (sm - 1) + i * step                               // 절대 월(0-indexed)
    const y = sy + Math.floor(abs / 12), m = abs % 12
    const day = Math.min(anchorDay, daysInMonth(y, m))            // 월말 clamp
    const ds = fmtDate(new Date(y, m, day))
    if (ds > todayStr) break
    if (rec.end_date && ds > rec.end_date) break
    if (ds >= rec.start_date && ds > floor) out.push(ds)
  }
  return out
}
```

적용:
- **정기청구**(`recurring-invoices.js`): `/pending`·`/generate`·`/issue`가 로컬 `dueDatesToGenerate` 대신 공용 함수 사용.
  기존 "놓친 회차 모두 소급 생성(미수 추적)" 정책 유지 — 이제 월말/period 정확.
- **정기지출**(`recurring.js`): `calcNextDate` 제거, 공용 함수로 `dues` 산출.
  지출 생성 정책은 **결정 필요**(아래 결정1) — 기본안은 "가장 최근 회차 1건만"(소급 홍수 방지, 저자 의도 유지).
  `last_generated`는 생성한 회차로 갱신.

### 다방면 검토
- **월말 clamp 정확성**: `daysInMonth(y,m)=new Date(y,m+1,0).getDate()`. 31일 앵커 → 1/3/5월 31, 2월 28(윤 29), 4/6월 30. 매월 정확히 1회.
- **period 드리프트 없음**: 매 회차를 `start_date` 앵커의 절대월(`i*step`)로 재계산 → 오버플로 누적 불가.
- **경계**: `ds >= start_date` 로 앵커 이전 배제, `> floor` 로 기생성 배제, `end_date` 초과 중단. 무기한(end_date 없음)도 today까지만.
- **KST**: `fmtDate`는 로컬 필드 사용(`toISOString` 아님) — 서버 TZ가 KST면 정확. (지출 `/generate`의 `today.toISOString()` todayStr도 로컬 기준 `fmtDate`로 교체해 경계 오차 제거.)
- **하위호환**: 스키마 무변경(period·day_of_month·last_generated 이미 존재). 기존 데이터에 그대로 동작.
- **회귀 방지**: 정기청구 `/issue`의 "가장 이른 미생성 회차만 발행" 가드는 `dues[0]` 기준이라 그대로 유효.

**영향 파일**: `server/lib/recurrence.js`(신규), `server/routes/recurring.js`, `server/routes/recurring-invoices.js`.

---

## 정립 2 — 직원 재직상태 컬럼 신설 (H2)

### 증상
퇴사(비활성) 직원을 편집 드로어에서 열고 상태 안 건드리고 저장 → **재직으로 되살아남**.
수습·휴직 칩은 선택해도 저장 안 됨(항상 재직으로 붕괴).

### 근본 원인
`employees` 테이블에 **status 컬럼이 없음**. 상태를 `active`(bool)에서만 파생:
- `adaptEmployee`는 `active ? '재직' : '퇴직'` 만 방출 → 칩 목록 `[재직·수습·휴직·퇴사]`의 '퇴사'와 불일치, 수습·휴직은 표현 불가.
- 저장은 `active: form.status !== '퇴사'`. 로드된 '퇴직'은 '퇴사'가 아니므로 → `active=true`(재활성).

### 해결 (정립)
실제 상태를 저장하도록 컬럼 신설. `active`는 상태에서 파생되는 종속값으로 정리.

1. `server/db.js`: `ensureColumn('employees','status',"status VARCHAR(20) DEFAULT '재직'")`.
   기존 행 백필: `UPDATE employees SET status = CASE WHEN active=1 THEN '재직' ELSE '퇴사' END WHERE status IS NULL`(1회 가드, 정립3과 동일 방식).
2. 직원 CRUD 라우트: `status` 저장. `active`는 `status !== '퇴사'`로 서버에서 파생(클라 신뢰 안 함).
3. `src/lib/api.js` `adaptEmployee`: `status: row.status || (row.active ? '재직' : '퇴사')`. '퇴직' 문자열 완전 제거.
4. `src/screens/HR.jsx` 저장 body: `status: form.status` 추가(active는 서버 파생이지만 하위호환 위해 같이 전송 가능).

### 다방면 검토
- **재직 집계**(`HR.jsx:161` `status==='재직'||'수습'`): 이제 실제 status로 동작. 휴직은 재직수에서 제외 — 의도와 일치(휴직=근무 중 아님).
- **급여대장 생성**("재직 직원"): `handleGeneratePayroll` 필터를 status 기준(퇴사 제외)으로 확인/정렬.
- **하위호환**: 백필로 기존 전 직원 status 확정. 신규 컬럼 DEFAULT '재직'.
- **부작용 없음**: status는 신규 축. active는 파생으로 유지되어 기존 active 참조 코드 무영향.

**영향 파일**: `server/db.js`, 직원 CRUD 라우트(`server/routes/employees.js` 등), `src/lib/api.js`, `src/screens/HR.jsx`.

---

## 정립 3 — 1회성 데이터 마이그레이션 가드 (M2)

### 증상
`db.js`의 지출→원가축 이관 `UPDATE`가 `initDb()` 안에 있어 **매 서버 재시작마다 실행**.
`WHERE ...(v.gubu IS NULL OR v.gubu='B')` 때문에, gubu가 NULL인 매입처(실데이터에서 흔함)에 올바로 연결한
지출이 재시작 때 `contract_id`가 조용히 NULL로 옮겨져 **근거 계약에서 분리**됨.

### 근본 원인
데이터 변형 마이그레이션이 멱등 가드 없이 부팅마다 재실행. 마이그레이션 버전 관리 부재.

### 해결 (정립)
경량 마이그레이션 기록 테이블 + 1회 실행 헬퍼 도입.

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  id VARCHAR(80) PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)
```
```js
async function runOnce(c, key, fn) {
  const [[r]] = await c.execute('SELECT id FROM schema_migrations WHERE id=?', [key])
  if (r) return
  await fn()
  await c.execute('INSERT INTO schema_migrations (id) VALUES (?)', [key])
}
```
지출→원가축 이관 UPDATE를 `runOnce(c,'2026-06_expense_cost_axis', …)`로 감싼다.
(정립2의 status 백필도 같은 방식으로 1회 실행.)

### 다방면 검토
- **기존 미이관 환경**: 최초 1회는 정상 실행 후 기록 → 이후 재시작 무영향.
- **이미 이관된 환경**: key가 없으므로 1회 더 돌 수 있음. 단 이관 대상이 이미 없어(대상 행 contract_id가 NULL) 사실상 무동작이며, 이후 신규 데이터는 절대 재이관 안 됨 — **이것이 핵심 안전 확보**.
- **`ensureColumn`류(순수 스키마 추가)**: 멱등하므로 가드 불필요. `runOnce`는 **데이터 변형** 마이그레이션에만 적용.
- **트랜잭션**: `initDb`의 커넥션 `c` 재사용.

**영향 파일**: `server/db.js`.

---

## 수정 4 — 지급결의서 from-invoice 금액 정합 (M3)

### 증상
`resolutions.js` `from-invoice`: 헤더 `amount`=`total_amount`(VAT 포함)인데 품목 라인 `amount`=`supply`(VAT 제외).
과세 매입 결의서에서 **라인합 ≠ 지급액**(10% 차이). 면세인데 supply_amount 비면 `/1.1` 폴백이 ~9% 과소.

### 근본 원인
지급결의서는 **지급액(gross, VAT 포함)** 을 결재받는 문서인데 품목 라인만 net(공급가)으로 계산.
두 값의 기준 불일치 + 불필요한 `/1.1` 추정.

### 해결
지급결의서는 gross 기준으로 통일. 품목 라인 = 지급 총액.

```js
const gross = Number(inv.total_amount) || 0
const items = [{ name: title, unit: '식', qty: 1, price: gross, amount: gross, note: inv.invoice_no || '' }]
// 헤더 amount 도 gross → 라인합 == 헤더 == 실제 지급액. /1.1 폴백 제거(면세 과소 해소).
```

### 다방면 검토
- **면세**: `total_amount` 그대로 사용 → 과세/면세 모두 정확(면세는 total=supply).
- **직접등록 경로(POST /)**: 이미 라인합=헤더로 정합. 변경 없음.
- **결의서 처리(`/process`)**: 매칭 금액은 거래·청구서 잔액 기반이라 무영향.
- **VAT 내역 표시**: 지급결의서 목적상 gross가 맞음. 공급가/부가세 분해가 필요하면 후속 별도 라인으로 확장(현 범위 밖).

**영향 파일**: `server/routes/resolutions.js`.

---

## 수정 5 — 면세 계약 VAT 표시 정합 (M4 + M5)

### 증상
- **M4** `Contract.jsx:1671`: 목록 진행률 바 `Math.round((r.amount||0)*1.1)` 하드코딩 → 면세 계약 완납해도 ~91%.
- **M5** `Billing.jsx`(발행예정): 마일스톤 pending이 `p.vat` 없어 `Math.round(p.amount*0.1)` 폴백 → 면세 계약에 유령 10% VAT.

### 근본 원인
서버는 이미 `vat_mode`로 면세 처리(metrics `vatMul`, invoices `vat_mode==='exempt'?0:...`).
그러나 (M4) 화면이 서버 `term_total`을 안 쓰고 재계산, (M5) `/schedule/pending`이 `vat`를 안 내려줌.

### 해결
"서버가 계산한 VAT를 화면이 그대로 쓴다"로 통일.

- **M4**: `const total = r.term_total`(서버 metrics가 이미 vat_mode 반영). 무기한이면 null→막대 미표시(기존 openEnded 처리).
- **M5**: `contracts.js` `/schedule/pending` SELECT에 `c.vat_mode` 추가, 응답에 `vat` 포함:
  `vat: r.vat_mode === 'exempt' ? 0 : Math.round(Number(r.amount) * 0.1)`.
  → 정기청구 `/pending`과 동일 계약(vat 항상 존재)이 되어, 화면 `p.vat != null` 분기가 면세=0으로 정확히 동작.

### 다방면 검토
- **M4**: `remain`(남은 잔액 컬럼)이 이미 서버 `term_total` 기반이라, 진행률도 같은 소스 쓰면 두 컬럼 모순 해소.
- **M5**: 화면 코드 무변경(이미 `p.vat` 우선). 서버만 채우면 됨 → 회귀 위험 최소. 발행 예정 카드(`pendingTotal`)·확인 다이얼로그·실제 발행분 전부 일치.
- **과세 계약**: 값 동일(0.1/term_total 모두 1.1 반영) → 무영향.

**영향 파일**: `src/screens/Contract.jsx`, `server/routes/contracts.js`.

---

## LOW (선별 수정)

### L1 — `api.js` `exportContractsXlsx` Firefox 다운로드 (수정)
anchor를 DOM에 안 붙이고 `click()` 직후 동기 `revokeObjectURL`. Firefox에서 다운로드 취소 가능.
→ `document.body.appendChild(a)` 후 click, `setTimeout(()=>{a.remove(); URL.revokeObjectURL(url)},0)`.

### L2 — `ui.jsx` MoneyInput 빈값으로 못 지움 (수정)
숫자 저장 콜러(Docs supply/vat/total, Contract amount)에서 전부 지우면 `0`으로 되돌아와 placeholder 불가.
→ MoneyInput이 **내부 텍스트 state**를 갖게 하여 부모 저장형(raw/num) 무관하게 표시. 빈 문자열 유지, blur 시 정규화.
(부모 값과 동기화: 외부 value 변경 시 내부 텍스트 갱신, 단 편집 중 빈 문자열은 보존.)

### L3 — `ui.jsx` Combobox `|| value` 원시코드 노출 (수정)
`display = selected?.label || value`가 옵션 로딩 전/삭제된 값에서 코드·ID를 그대로 노출.
→ 자유입력이 필요한 곳만 `allowCustom` prop으로 opt-in. 기본은 `selected?.label || ''`(옵션 매칭 실패 시 공백).
자유입력 콜러 확인 후 해당 호출부에 prop 부여.

### L4 — `data.js` 사장코드 (확인 후 처리)
`src/lib/data.js`가 CATEGORIES만 남고 아무 데서도 import 안 되면 삭제. import 있으면 유지.
(삭제 전 `grep "lib/data"` 로 실제 참조 확인 — 안전 우선.)

### 보류(문서화만)
- **Ledger.jsx 미결 처리 버튼 도달불가**: pending 처리는 Billing로 이관된 의도된 잔재. 기능 결함 아님 → 유지, 후속 정리 대상 표기.
- **Form.jsx acctGroup kind 필터 누락 / 날짜 UTC 폴백**: 영향 극미(세금계산서 배너 한정, 빈 날짜 한정). 여력 시 정리.

---

## 구현 순서
1. `server/lib/recurrence.js` 신규 → recurring 2종 교체 (정립1)
2. `server/db.js` schema_migrations + runOnce, status 컬럼, 이관 UPDATE 가드 (정립2·3)
3. 직원 CRUD 라우트 + `api.js` adaptEmployee + `HR.jsx` (정립2 마감)
4. `resolutions.js` gross 통일 (수정4)
5. `contracts.js` schedule/pending vat + `Contract.jsx` term_total (수정5)
6. LOW L1~L4
7. 빌드(`npm run build`) + 서버 기동 스모크 검증

## 검증 계획
- `npm run build` 통과.
- 정기반복: 31일 앵커 월간/분기/연 각각 회차 목록 단위검증(임시 노드 스크립트).
- 직원: 퇴사자 편집 재저장 → 여전히 퇴사. 수습/휴직 저장·재로드 유지.
- 마이그레이션: 재시작 2회 후 지출 contract_id 불변.
- 결의서: 과세/면세 from-invoice 라인합=헤더.
- VAT: 면세 계약 목록 진행률·마일스톤 발행예정 금액 = 서버값.
