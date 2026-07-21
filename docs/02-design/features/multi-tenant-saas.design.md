# 멀티테넌트 SaaS 전환 설계서

> **Version**: 1.0
> **Date**: 2026-07-21
> **Author**: Chajuick
> **Status**: Finalized — 구조·핵심 4개 의사결정 확정, P1 구현 착수 준비
> **관련 문서**: `system-flow.design.md`(단일 테넌트 현행), `focus-accounter-v2.design.md`

---

## 0. 요약 (TL;DR)

현재 **단일 테넌트**(DB 1개 `dongjin_erp`, 전역 pool, 테넌트 스코프 없는 쿼리)를,
**하나의 서버에서 회사마다 독립된 DB를 갖는 멀티테넌트 SaaS/ASP**로 전환한다.

- **격리 모델**: DB-per-tenant — 공용 관리 DB 1개 + 회사별 데이터 DB N개
- **선정 이유**: ① 회계 데이터 물리적 격리 ② 회사별 백업/이관 용이 ③ **기존 쿼리 SQL 불변**(전역 `pool` → `req.db`만 교체) ④ 폭발 반경 회사 단위 국한
- **인증 모델**: 테넌트 스코프 사용자 — 로그인 = `회사코드 + 아이디 + 비밀번호` 3필드. 같은 아이디(`24`)가 회사마다 독립 존재
- **온보딩**: 가입 = 회사 생성 + 마스터 계정 생성을 한 트랜잭션으로
- **권한**: RBAC — (화면 자원 × 행위) 매트릭스, 서버 미들웨어가 최종 방어선
- **규모 전제**: 수백 개사 → 커넥션 풀 매니저(LRU) + 버전드 마이그레이션 러너가 **필수**

---

## 1. 아키텍처

### 1.1 2계층 DB 구조

```
┌─────────────────────────────────────────────────────────┐
│ 공용 관리 DB (control-plane)  ─  acct_platform          │
│   · companies       회사(테넌트) 레지스트리 + 라우팅    │
│   · users           로그인 주체 (회사 스코프)           │
│   · roles           회사별 역할                          │
│   · role_perms      권한 매트릭스                        │
│   · platform_admins 운영자(슈퍼관리자)                   │
│   · audit_logs      감사 로그                            │
│   · account_subjects_std  표준 계정과목(K-GAAP) 원본    │
│   · tenant_migrations     테넌트별 마이그레이션 버전     │
│   ※ 회계 '업무 데이터'는 여기 절대 두지 않는다          │
└─────────────────────────────────────────────────────────┘
                          │  로그인 → companyId/dbName 해석
                          ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ acct_c0001   │  │ acct_c0002   │  │ acct_cXXXX   │   회사별 데이터 DB
│ (A사)        │  │ (B사)        │  │ ...          │
│ vendors      │  │ vendors      │  │              │   ← 현행 db.js 테이블
│ invoices     │  │ invoices     │  │              │      세트를 그대로 복제
│ transactions │  │ transactions │  │              │      (스키마 동일)
│ contracts …  │  │ contracts …  │  │              │
└──────────────┘  └──────────────┘  └──────────────┘
```

### 1.2 요청 흐름

```
[로그인]  POST /api/auth/login  { companyCode, username, password }
   │  1) companies WHERE code = companyCode        → company(id, db_name, active)
   │  2) getPool(company.db_name)                   → 그 회사 DB pool (LRU 캐시)
   │  3) users WHERE company_id = ? AND username=?  → bcrypt.compare
   │  4) role_perms 로드                            → perms 객체
   │  5) JWT 발급  { userId, companyId, dbName, role }   (perms는 요청마다 재조회 or 캐시)
   ▼
[일반 요청]  GET /api/vendors   (Authorization: Bearer <JWT>)
   │  auth 미들웨어      : JWT 검증 → req.auth = { userId, companyId, dbName }
   │  tenant 미들웨어    : req.db = getPool(req.auth.dbName)
   │                       req.perms = loadPerms(userId)  (캐시)
   │  requirePerm 가드   : req.perms['vendors'] 에 'view' 있나
   │  라우트 핸들러      : req.db.execute('SELECT * FROM vendors ...')   ← SQL 불변
   ▼
[응답]
```

**핵심**: 라우트 핸들러의 SQL 문자열은 전혀 바뀌지 않는다. 전역 `pool` 참조를 `req.db`로 바꾸는 것이 전부. → 30여 개 라우트의 기계적 치환.

### 1.3 왜 DB-per-tenant인가 (대안 비교)

| 기준 | 공용스키마 + company_id | **DB-per-tenant (채택)** | 서버 분리 |
|---|---|---|---|
| 격리 | 앱 로직 의존(WHERE 누락 시 유출) | **물리적** | 최고 |
| 기존 코드 수정 | 전 쿼리 수정 + 유출 위험 | **연결만 교체** | 연결만 |
| 회사별 백업/이관 | 어려움 | **mysqldump 1개 DB** | 쉬움 |
| 적정 테넌트 수 | 수천~수만 | **수십~수천(수백 적정)** | 소수 |
| 운영 복잡도 | 낮음 | 중간(풀·마이그레이션 자동화 필요) | 높음 |

수백 개사 전제에서 DB-per-tenant는 유효 구간이며, 회계 격리·백업 이점이 운영 복잡도를 상회한다. (수천 개 이상으로 커지면 공용스키마 재검토)

---

## 2. 인증 · 온보딩 모델

### 2.1 테넌트 스코프 사용자 (핵심 원칙)

- username은 **전역 유니크가 아니라 (회사, username) 복합 유니크**
- → A사 `24`, B사 `24` 독립 공존
- 로그인은 **회사 판별자(회사코드)** 를 반드시 요구 → 3필드: `회사코드 + 아이디 + 비밀번호`
- 회사코드는 내부 UUID가 아니라 **사람이 외우는 슬러그**(예: `dongjin`, `a-tech`)

**회사코드(slug) 규칙** [확정]
- 형식: 소문자 영숫자 + 하이픈, **4~20자** (`^[a-z0-9][a-z0-9-]{2,18}[a-z0-9]$`)
- **중복 불가** + **예약어 블록리스트**(`admin`, `api`, `www`, `login`, `platform`, `app`, `static` 등)
- 생성 후 **불변** — 변경은 슈퍼관리자만(로그인·북마크·문의 무결성 위해)
- 가입 폼에서 실시간 중복확인 제공

### 2.2 가입(온보딩) 흐름

```
[가입 폼]  회사명 · 회사코드(중복확인) · 마스터 아이디 · 비밀번호 · 마스터 이메일
   │  [확정] 동기 프로비저닝 + 보상 정리 (DDL은 트랜잭션에 못 묶이므로 순서·실패처리 명시):
   │   1) companies INSERT  (id=UUID, code, name, db_name='acct_c'+seq, status='provisioning')  ← 공용 DB, 커밋
   │   2) provisionTenantDb(db_name)  ← CREATE DATABASE + migrate-all(최신까지) + 시드 (DDL, 트랜잭션 밖)
   │   3) 성공 → companies status='active' + roles 기본 3종 + role_perms 프리셋 + 마스터 users INSERT
   │      실패 → DROP DATABASE(있으면) + companies 삭제/실패표시  (보상 정리)
   ▼
[완료]  마스터가 로그인 → 사내 계정(24 등) 추가 → 각자 권한(역할) 지정
```

- "회사 없는 유저"는 DB에 존재하지 않는다. 가입 폼 제출 순간 회사+마스터가 원샷 생성된다.
- **동기 처리 확정**: 회계 SaaS는 가입 빈도가 낮아(하루 몇 건) 수 초 소요를 스피너로 커버. 큐/폴링은 가입 폭주 시에만 필요 → YAGNI. 폭주가 현실화되면 3번을 큐 잡으로 승격.

### 2.3 역할 계층

| 역할 | 범위 | 권한 |
|---|---|---|
| `platform_admin` | 운영자(우리) | 전 회사 목록·정지·요금·프로비저닝. **회사 업무 데이터 접근 불가**(감사 목적 외) |
| `master` | 회사 1인(가입자) | 사내 계정 CRUD, 역할·권한 지정, 회사 정보, 전 화면 |
| `member` | 회사 사용자 | 마스터가 부여한 역할의 권한 매트릭스대로 |

### 2.4 비밀번호 찾기 (결정 ①)

- **사내 member**: 마스터가 관리자 화면에서 **비번 리셋**(임시 비번 발급 → 최초 로그인 시 변경 강제)
- **master 본인**: `users.email`로 **이메일 리셋 링크**
- username이 이메일도 전역 유니크도 아니므로 "아이디만으로" 셀프 복구는 불가 — 위 2경로로 해결

### 2.5 1계정 = 1회사 (결정 ②, YAGNI)

- 현재 모델: 사용자는 정확히 한 회사에 속함(그 회사 마스터가 생성)
- 세무대리인처럼 다(多)회사 접근이 필요해지면 → `memberships(user_id, company_id, role)` 로 확장
- **지금은 구현하지 않는다.** 단, `users`에 `company_id`를 두는 위 스키마는 나중에 memberships로 승격 가능하도록 설계됨

---

## 3. 데이터 배치 — 공용 vs 테넌트

### 3.1 공용 관리 DB 스키마 (`acct_platform`)

```sql
CREATE TABLE companies (
  id           VARCHAR(36) PRIMARY KEY,
  code         VARCHAR(20) NOT NULL UNIQUE,          -- 로그인용 회사코드
  name         VARCHAR(255) NOT NULL,
  db_name      VARCHAR(64) NOT NULL UNIQUE,          -- acct_cXXXX
  plan         VARCHAR(30) DEFAULT 'basic',
  active       TINYINT DEFAULT 1,                    -- 정지 시 0
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id           VARCHAR(36) PRIMARY KEY,
  company_id   VARCHAR(36) NOT NULL,
  username     VARCHAR(100) NOT NULL,
  password     VARCHAR(255) NOT NULL,                -- bcrypt (현행 유지)
  name         VARCHAR(100),
  email        VARCHAR(200),                         -- 마스터 셀프 리셋용(선택)
  role         VARCHAR(20) DEFAULT 'member',         -- master | member
  must_change_pw TINYINT DEFAULT 0,                  -- 임시 비번 강제 변경
  active       TINYINT DEFAULT 1,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_company_user (company_id, username), -- ★ 핵심 제약
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE roles (
  id           VARCHAR(36) PRIMARY KEY,
  company_id   VARCHAR(36) NOT NULL,
  name         VARCHAR(50) NOT NULL,                 -- 마스터/경리/조회전용/...
  is_system    TINYINT DEFAULT 0,                    -- 기본 프리셋 여부
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_company_role (company_id, name),
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE user_roles (
  user_id VARCHAR(36) NOT NULL,
  role_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE role_perms (
  role_id  VARCHAR(36) NOT NULL,
  resource VARCHAR(40) NOT NULL,                     -- ledger|billing|contract|hr|docs|master|...
  action   VARCHAR(20) NOT NULL,                     -- access|view|create|edit|delete|upload|download|export
  PRIMARY KEY (role_id, resource, action),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE platform_admins (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(100) UNIQUE, password VARCHAR(255), name VARCHAR(100),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_logs (
  id VARCHAR(36) PRIMARY KEY,
  company_id VARCHAR(36), user_id VARCHAR(36), username VARCHAR(100),
  action VARCHAR(40),          -- login|create|edit|delete|download|export|perm_change|...
  resource VARCHAR(40), target_id VARCHAR(64),
  ip VARCHAR(45), detail TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_company_time (company_id, created_at)
);

CREATE TABLE tenant_migrations (
  db_name    VARCHAR(64) NOT NULL,
  version    VARCHAR(80) NOT NULL,                   -- 마이그레이션 키
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (db_name, version)
);
```

### 3.2 회사별 데이터 DB 스키마 (`acct_cXXXX`)

**현행 `server/db.js`의 테이블 세트를 그대로 사용**한다. 단, 아래 2개는 이동/조정:

| 현행 테이블 | 조치 |
|---|---|
| `users` | **삭제** → 공용 DB로 이전(§3.1). 테넌트 DB에는 로그인 계정 없음 |
| `company_info` | **유지**(테넌트) — 결의서·거래명세서 출력에 쓰는 회사 상세(사업자번호·대표·주소). 공용 `companies`(라우팅/식별용)와 역할 분리. `name` 중복은 허용 |

나머지 전 테이블(vendors, accounts, contracts, invoices, transactions, milestones, recurring_*, payroll, expense_resolutions, ref_items, vat_filings, work_contracts, …)은 **테넌트별 복제**.

### 3.3 공용/테넌트 기준정보 경계 (결정 필요 핵심)

시드·마이그레이션되는 "기준정보"를 어디에 둘지가 이 전환의 최대 난이도. 판정 기준: **회사가 수정하는가?**

| 데이터 | 성격 | 배치 | 근거 |
|---|---|---|---|
| `account_subjects` (K-GAAP 표준계정) | 고정 마스터, 사용자 CRUD 불가 | **공용 원본 + 테넌트 복제(읽기)** [확정] | 전 회사 동일. 공용 `account_subjects_std`를 원본으로, 프로비저닝 시 테넌트에 복사(조인 편의) |
| `categories` (계정/거래 분류) | 시드되지만 **사용자 편집**(Master 화면) | **테넌트** | 회사마다 커스터마이즈. 프로비저닝 시 기본 세트 시드 |
| `payroll_item_types` (급여 항목 + 4대보험 요율) | 사용자 편집 + **국가 법정 요율** | **테넌트(시드)** + 요율은 마이그레이션 배치 | 커스텀 항목은 회사별. 법정 요율 연간 갱신은 러너가 "사용자가 안 고친 값만" 일괄 보정(현행 `bumpRate` 로직 재사용) |
| `hr_codes`, `approval_presets`, `ref_items(jeokyo 등)` | 사용자 편집 | **테넌트(시드)** | 회사별 |
| `account-subjects.json` 시드 파일 | 코드 자산 | 공용 프로비저닝에서 사용 | — |

> **결정 [확정]**: **테넌트 복제**. `transactions.account_code`가 문자열 코드로 참조(AUTO_INCREMENT id 무관)라 복제해도 정합성 안전. 표준계정은 거의 안 바뀌어 복제 비용 ≈ 0이고, "기존 조인 SQL 불변 + 테넌트 DB 자기완결(별도 서버 이전 가능)"이라는 이 프로젝트 핵심 이점을 모두 보존. 드문 개정은 `migrate-all.js`로 push. (공용 전용 방식은 `JOIN acct_platform.account_subjects` 크로스-DB 종속을 유발해 격리/이관 이점을 깨므로 기각)

---

## 4. 권한 모델 (RBAC 매트릭스)

### 4.1 자원 × 행위

```
resource : home | ledger | billing | contract | hr | docs | master
           (+ 세부: vendors, accounts, employees, payroll, expense_resolution, vat, ...)
action   : access  (메뉴 노출/진입)
           view    (조회)
           create  (등록)
           edit     (수정)
           delete  (삭제)
           upload  (파일 첨부/엑셀 임포트)
           download(파일/엑셀 다운로드)
           export  (인쇄/보고서 출력)
```

### 4.2 기본 프리셋 역할

| 역할 | 권한 요약 |
|---|---|
| **마스터** | 전 자원 × 전 행위 + 계정/권한 관리 |
| **경리** | ledger/billing/contract/docs = access,view,create,edit,upload,download,export / hr = 없음 / master = view만 |
| **조회전용** | 전 자원 access,view,download,export만 (create/edit/delete 없음) |

### 4.3 시행 (2중 방어)

**서버(최종 방어선)** — 프런트 숨김만으론 API 직접 호출을 못 막음:

```js
// middleware/perm.js
const requirePerm = (resource, action) => (req, res, next) =>
  req.perms?.[resource]?.includes(action)
    ? next()
    : res.status(403).json({ error: '권한이 없습니다' })

// 라우트 부착 예
router.post('/',        requirePerm('vendors','create'), handler)
router.put('/:id',      requirePerm('vendors','edit'),   handler)
router.delete('/:id',   requirePerm('vendors','delete'), handler)
router.get('/import/template', requirePerm('vendors','download'), handler)
```

**프런트(UX)** — 로그인 응답의 `perms`로 메뉴/버튼 조건부 렌더:
- `access` 없으면 nav에서 화면 자체 숨김
- `delete` 없으면 삭제 버튼 숨김, `create` 없으면 등록 버튼 disable

### 4.4 감사 로그 연동

권한 있는 행위라도 create/edit/delete/download/export/perm_change는 `audit_logs`에 기록. 회계·방산 특성상 "누가 언제 무엇을" 추적 필수.

---

## 5. 운영 인프라 (수백 개사 필수 요소)

### 5.1 커넥션 풀 매니저 (LRU)

**문제**: 회사마다 상시 pool → 수백 × limit = 커넥션 폭발. MariaDB 기본 `max_connections`=151.

**설계**:
```js
// db/poolManager.js
const pools = new LRU({ max: 50, dispose: (pool) => pool.end() })  // 활성 50개사만 상주
function getPool(dbName) {
  let p = pools.get(dbName)
  if (!p) {
    p = mysql.createPool({ ...baseConfig, database: dbName,
                           connectionLimit: 3, waitForConnections: true })
    pools.set(dbName, p)
  }
  return p
}
```
- 회사당 `connectionLimit` 2~3, 상주 회사 수 LRU 제한(예 50)
- MariaDB `max_connections` 상향(예 500) + `wait_timeout` 조정
- 유휴 회사는 evict 시 pool `.end()`

### 5.2 마이그레이션 러너 (버전드 · 배치)

**문제**: 현행 "부팅 시 `initDb()` 1회"를 수백 개 DB에 부팅마다 돌리면 기동 수 분 + 위험.

**설계**:
- 현행 `initDb`의 `CREATE TABLE IF NOT EXISTS` / `ensureColumn` / `runOnce` 로직을 **`migrations/` 버전 스크립트**로 이관(각 버전 = 키)
- 테넌트별 적용 상태는 공용 `tenant_migrations(db_name, version)`로 관리
- **배포 시 별도 CLI**가 전 회사 순회 적용:
  ```
  node scripts/migrate-all.js         # 모든 테넌트 DB에 미적용 버전만 실행
  node scripts/migrate-all.js --db acct_c0007   # 특정 회사만
  ```
- 실패 격리: 한 회사 실패해도 나머지 진행 + 실패 목록 리포트
- 신규 회사 프로비저닝 = "최신 버전까지 전체 실행 + 시드"

### 5.3 파일 스토리지 격리

- 현행 첨부: `invoice_docs`, `contract_docs`, `transaction_docs`, `work_contract_docs`, `evid_url`, `ref_items.file_url`
- **회사별 경로 분리**: `/uploads/{companyId}/...` (또는 버킷 prefix)
- 다운로드 라우트는 **요청자의 companyId와 파일 경로의 companyId 일치 검증**(URL 추측으로 타사 증빙 접근 차단)
- 정적 서빙 금지 → 인증·권한(`download`) 통과 후 스트리밍

### 5.4 DB 계정 권한 분리 (DDL / DML)

**원칙: 앱 런타임은 DDL을 하지 않는다.** 스키마 생성·마이그레이션·테넌트 DB 생성은 배포 시점 작업이며, 웹 요청 경로가 탈취돼도 스키마를 건드리거나 DB를 만들 수 없어야 한다.

| 계정 | 용도 | 권한 | 사용처 |
|---|---|---|---|
| **앱 계정** (`DB_USER`) | 런타임 | `acct_platform` + `acct\_%` 에 **SELECT/INSERT/UPDATE/DELETE만** | Express 요청 처리 |
| **관리 계정** (`DB_ADMIN_USER`) | DDL | DB 생성·스키마 변경 | `setup-db.js`, `provision-tenant.js`, 마이그레이션 러너 |

- 관리 계정 연결은 **상시 유지하지 않는다** — `withAdmin()`이 필요할 때 열고 즉시 닫는다
- `DB_ADMIN_USER` 미설정 시 앱 계정으로 폴백(로컬 개발 편의). 운영에서는 반드시 분리
- ⚠ GRANT에서 `_`는 와일드카드다. 리터럴은 `` `acct\_%` `` 로 이스케이프해야 `acct_` 접두사만 매칭된다

**기동 시 동작**: `assertPlatformReady()`가 공용 DB 접근·스키마 완전성·회사 등록 여부만 **검증**한다(DDL 없음). 미비하면 조용한 런타임 오류가 아니라 **명확한 기동 실패 + 실행할 명령 안내**로 끝낸다.

**운영 도구**
```
npm run setup:db         공용 DB + 테넌트 스키마 + 부트스트랩 (멱등, 배포마다 실행)
npm run setup:db:check   변경 없이 상태만 점검
npm run check:db         계정별 권한 진단 → 부족한 GRANT 문을 그대로 출력
```
`deploy.sh` 4단계에 `npm run setup:db`가 포함되어, 런타임에서 뺀 DDL 책임을 배포가 진다.

### 5.5 도메인 라우팅

- **단일 도메인 + JWT companyId** 방식 채택(수백 개사에서 서브도메인/와일드카드 인증서보다 운영 단순)
- `https://acct.custwin.shop` 하나 유지(현행 Cloudflare 터널 그대로), 로그인 시 회사코드 입력으로 테넌트 구분
- (선택) 편의를 위해 `?c=회사코드` 쿼리로 로그인 폼 프리필

---

## 6. 이행 계획 (단계별)

현행 단일 테넌트(`dongjin_erp`)를 첫 테넌트로 흡수하는 방향.

| 단계 | 작업 | 산출물 |
|---|---|---|
| **P1. 공용 DB + 인증** | `acct_platform` 스키마 생성. `users` → 공용 이전(복합 유니크). `auth/login` 3필드화(회사코드 조회 추가). JWT에 `companyId/dbName` claim | 로그인 멀티테넌트화 |
| **P2. 풀 매니저 + tenant 미들웨어** | `getPool(dbName)` LRU 도입. `tenant` 미들웨어. 전 라우트 `pool` → `req.db` 기계적 치환 | 요청별 테넌트 라우팅 |
| **P3. 프로비저닝 + 마이그레이션 러너** | `initDb(dbName)` 파라미터화. `provisionTenantDb()`. `migrations/` + `tenant_migrations` + `migrate-all.js` | 회사 생성 API |
| **P4. 온보딩** | 가입 화면(회사+마스터 원샷). 마스터의 사내 계정 CRUD 화면 | 셀프 가입 |
| **P5. 권한 매트릭스** | `roles/role_perms`, `requirePerm` 전 라우트 부착, 관리자 권한관리 화면, 프런트 조건부 렌더 | RBAC |
| **P6. 격리 마감** | 파일 경로 회사별 분리 + 다운로드 검증. `audit_logs`. 공용/테넌트 기준정보 경계 확정 적용 | 격리 완성 |
| **P7. 기존 데이터 이전** | `dongjin_erp` → `acct_c0001`로 회사 등록 + 마스터 계정 발급. 데이터 그대로(스키마 동일) | 무중단 전환 |

### 6.1 P7 데이터 이전 메모
- 스키마가 동일하므로 `dongjin_erp`를 그대로 `acct_c0001`로 rename/dump-restore
- 기존 `users` 행 → 공용 `users`로 `company_id` 부여해 복사
- `company_info`는 그대로 테넌트에 잔류

---

## 7. 리스크 · 미결정 · 비범위

### 7.1 리스크
- **커넥션 고갈**: LRU max와 MariaDB `max_connections` 튜닝 없으면 동시 접속 회사 증가 시 장애 → P2에서 부하 테스트 필수
- **마이그레이션 부분 실패**: 수백 DB 중 일부 실패 시 스키마 드리프트 → `tenant_migrations`로 상태 추적 + 재실행 멱등성 보장
- **크로스 테넌트 유출**: 파일 다운로드/JWT 위변조가 유일한 취약점 → §5.3 검증 + JWT_SECRET 관리

### 7.2 확정된 의사결정 (2026-07-21)
| # | 항목 | 확정 | 참조 |
|---|---|---|---|
| 1 | `account_subjects` 배치 | **공용 원본 + 테넌트 복제** | §3.3 |
| 2 | 회사코드 체계 | **사용자 지정 슬러그 + 검증 + 불변** | §2.1 |
| 3 | 프로비저닝 | **동기 + 보상 정리** (큐는 YAGNI) | §2.2 |
| 4 | 요금/구독 과금 | **비범위 — 수동 과금**(`plan`/`active` 훅만, PG·플랜제한 미구현) | §7.3 |

### 7.3 비범위 (YAGNI)
- **과금/결제 연동**(PG, 우리 SaaS 세금계산서 발행, 요금제 설계, 미납 자동정지) — `plan`/`active` 컬럼만 훅으로 유지, 초기엔 오프라인 청구 + 운영자 `active` 토글. 플랜별 소프트 제한(계정 수 상한 등)도 MVP 비범위
- 다(多)회사 소속 사용자(memberships) — §2.5
- 서브도메인/회사별 커스텀 도메인
- 회사별 화이트라벨(로고/테마)
- 크로스 테넌트 통계(운영자 대시보드 집계) — 필요 시 별도 리드 레플리카

---

## 8. 변경 영향 요약 (현행 코드 대비)

| 파일/영역 | 변경 |
|---|---|
| `server/db.js` | `initDb(dbName)` 파라미터화, `users` 제거, 시드 로직 → `migrations/`로 이관, `getPool` LRU 도입 |
| `server/routes/*.js` | 전역 `pool` → `req.db` 치환(SQL 불변). `requirePerm` 가드 부착 |
| `server/routes/auth.js` | 3필드 로그인, 회사코드→company 조회, JWT companyId claim, 비번 리셋 2경로 |
| `server/middleware/auth.js` | JWT claim 확장 |
| `server/middleware/` (신규) | `tenant.js`(pool 주입), `perm.js`(requirePerm) |
| `server/` (신규) | `db/poolManager.js`, `services/provision.js`, `scripts/migrate-all.js` |
| `src/` | 로그인 화면 3필드, 가입 화면, 계정/권한 관리 화면, 권한 기반 nav/버튼 렌더 |
| 신규 DB | `acct_platform`(공용) |

---

*본 설계 확정 후 P1(공용 DB + 인증)부터 착수 권장. `/pdca design` 검증 및 `security-architect` 테넌트 격리 리뷰 병행.*
