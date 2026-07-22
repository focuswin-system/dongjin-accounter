# 멀티테넌트 개발 가이드

> **이 문서는 코드를 고치거나 추가하기 전에 읽는 문서입니다.**
> 이 프로젝트는 하나의 서버에서 **여러 회사의 회계 데이터**를 다룹니다.
> 여기 적힌 규칙을 어기면 **에러 없이 조용히 남의 회사 데이터를 읽거나 씁니다.**
>
> 구조 배경: `docs/02-design/features/multi-tenant-saas.design.md`
> 운영 방법: `docs/reference/tenant-operations.md`

---

## 0. 30초 요약

| 하지 말 것 | 대신 할 것 |
|---|---|
| `require('../db')` 에서 `pool` 가져오기 | `req.db` 사용 (tenant 미들웨어가 주입) |
| `async (_, res, next)` 로 핸들러 작성 | `async (req, res, next)` — `req` 없으면 `req.db`도 없다 |
| 헬퍼 함수에서 전역 풀 참조 | 헬퍼에 `db`를 **인자로 받기** |
| `db = pool` 같은 기본값 두기 | 기본값 없이 **필수 인자**로 (누락 시 즉시 예외) |
| 파일을 `uploads/` 바로 아래 저장 | `uploads/{companyId}/` 아래 저장 |
| 앱 코드에서 `CREATE/ALTER` 실행 | 배포 시점 스크립트(`setup:db`)에서만 |

작업 끝나면 **반드시**:
```bash
cd server && npm run check:isolation
```

---

## 1. 구조 한눈에

```
공용 관리 DB (acct_platform)          회사별 데이터 DB
 ├ companies   회사 레지스트리         ├ winc_ac      (fowin — 실서비스)
 ├ users       로그인 계정             ├ acct_c0001   (신규 회사)
 ├ roles/role_perms  권한             └ acct_c000N   …
 ├ audit_logs                          각 DB에 vendors·invoices·transactions…
 └ tenant_migrations                   (스키마는 전부 동일)
```

**요청 흐름**
```
로그인 → 회사코드로 companies 조회 → JWT에 {companyId, dbName} 발급
   ↓
요청 → auth 미들웨어(JWT 검증) → tenant 미들웨어(req.db 주입) → 라우트
```

`req.db`는 **그 요청을 보낸 회사의 DB 풀**입니다. 라우트는 어느 회사인지 신경 쓸 필요 없이 `req.db`만 쓰면 자동으로 격리됩니다. **그게 이 구조의 핵심이자 유일한 규칙입니다.**

---

## 2. 라우트 작성 규칙

### 2.1 기본형

```js
const { Router } = require('express')
// ⚠ pool은 export되지 않는다. 가져오려 하면 undefined가 되어 즉시 터진다.
const { futureDateError } = require('../db')

const router = Router()

router.get('/', async (req, res, next) => {   // ← _ 아니고 req
  try {
    const [rows] = await req.db.execute('SELECT * FROM vendors ORDER BY name')
    res.json(rows)
  } catch (e) { next(e) }
})
```

### 2.2 트랜잭션

```js
router.post('/', async (req, res, next) => {
  const conn = await req.db.getConnection()   // ← req.db 에서 꺼낸다
  try {
    await conn.beginTransaction()
    await conn.execute('INSERT INTO ...')
    await conn.commit()
    res.json({ ok: true })
  } catch (e) { await conn.rollback(); next(e) }
  finally { conn.release() }                   // ← 반드시 release
})
```

> `release()`를 빠뜨리면 커넥션이 새는 것뿐 아니라, **풀 매니저가 그 회사 풀을 '사용 중'으로 오인해 영원히 회수하지 못합니다.**

### 2.3 헬퍼 함수 — 가장 자주 실수하는 지점

핸들러 밖에 정의한 함수에는 `req`가 없습니다. **`db`를 인자로 받으세요.**

```js
// ❌ 나쁨 — req가 없어 ReferenceError, 혹은 전역 풀로 폴백되면 교차 유출
async function calcBalance(accountId) {
  const [rows] = await req.db.execute('...')   // req가 뭔지 모른다
}

// ✅ 좋음
async function calcBalance(db, accountId) {
  const [rows] = await db.execute('...', [accountId])
}
// 호출: await calcBalance(req.db, id)
```

**기본값을 절대 두지 마세요:**
```js
// ❌ 치명적 — 호출자가 db를 빠뜨리면 '조용히' 전역 풀을 쓴다
async function syncTxn(body, db = pool) { ... }

// ✅ 필수로 만들고, 누락 시 바로 터뜨린다
async function syncTxn(body, db) {
  if (!db) throw new Error('syncTxn: 테넌트 연결(db)이 필요합니다')
}
```

에러가 나는 건 괜찮습니다. **조용히 잘못된 회사 데이터를 건드리는 게 진짜 사고입니다.**

---

## 3. 파일 첨부 규칙

- 업로드는 **반드시 `uploads/{companyId}/`** 아래로 (`routes/uploads.js`가 처리)
- 다운로드는 **`routes/files.js`** 경유. 요청자의 `companyId`와 경로의 `companyId`가 일치해야 함
- **`express.static`으로 업로드 폴더를 노출하지 마세요.** 그렇게 하면 인증 없이 전부 열립니다
- 타사 파일 요청은 **403이 아니라 404** — 존재 여부 자체가 정보입니다
- 프런트는 `<a href>` / `window.open`으로 브라우저를 직접 이동시키므로 헤더를 못 싣습니다.
  그래서 `path=/uploads` 로 스코프된 **httpOnly 쿠키**로 인증합니다(로그인 시 발급)

새 첨부 기능을 만들 때는 **URL을 DB에 저장하는 컬럼이 늘어난다는 점**을 기억하세요.
`scripts/migrate-uploads.js`의 `URL_COLUMNS` 목록에도 추가해야 합니다.

---

## 4. 스키마 변경 규칙

### 4.1 앱은 DDL을 하지 않는다

런타임 계정(`DB_USER`)은 **DML 권한만** 갖습니다. `CREATE`/`ALTER`가 필요하면:

- `server/db.js`의 `initDb(conn)` 안에 `ensureColumn` / `CREATE TABLE IF NOT EXISTS` 로 추가
- 배포 시 `npm run setup:db`가 **관리 계정으로** 적용 (deploy.sh에 포함됨)

### 4.2 모든 회사에 적용된다는 것을 기억할 것

`initDb`는 **각 테넌트 DB마다** 실행됩니다. 그래서:

- **멱등이어야 합니다** — 여러 번 돌아도 안전해야 함
- 데이터를 **변형**하는 마이그레이션은 `runOnce('키', ...)`로 감싸세요.
  안 그러면 부팅/배포마다 재실행되어 신규 데이터를 오염시킵니다
- `information_schema` 조회 시 `DB_NAME` 상수가 아니라 **`SELECT DATABASE()`로 얻은 스키마명**을 쓰세요
  (이미 `initDb` 안에 `schemaName` 변수로 준비돼 있습니다)

### 4.3 기준정보 시드

새 기준정보를 시드할 때는 "**회사가 이 값을 수정하는가**"로 판단하세요.

| 성격 | 위치 |
|---|---|
| 회사가 커스터마이즈 (비목·적요·급여항목·고용형태) | 테넌트 DB에 시드 |
| 전 회사 공통 고정 (표준 계정과목) | 저장소 JSON을 원본으로 테넌트에 복제 |
| 로그인·권한·회사 정보 | 공용 DB(`acct_platform`) |

---

## 5. 화면(nav)을 추가할 때

`src/lib/nav.js`에 잎 메뉴를 추가하면, **`server/platform/permissions.js`의 `RESOURCES`에도 같은 id를 추가**해야 합니다.

안 하면 `npm run check:isolation`이 배포를 막습니다:
```
❌ nav에 있으나 권한 카탈로그에 없음: mgmt_ask
```

> 도메인/포털 카테고리처럼 **실제 화면이 아닌 묶음 id**는 `check-isolation.js`의 `CONTAINERS` 배열에 넣어 제외합니다.

**새 자원의 기본 권한은 '아무에게도 없음'** 입니다(마스터 제외). 회사 마스터가 명시적으로 열어줘야 보입니다 — 회계·방산 특성상 기본 차단이 안전합니다.

---

## 6. 자동 검사 — `npm run check:isolation`

`deploy.sh`가 배포 전에 자동 실행합니다(로컬 `[0/4]` 단계 + 원격). 검사 항목:

| # | 검사 |
|---|---|
| 1 | `routes/`에서 전역 풀 사용 금지 |
| 2 | `req` 인자를 버린 핸들러(`async (_, res)`) 없는지 |
| 3 | `db.js`가 `pool`을 export 하지 않는지 |
| 4 | `index.js`에 tenant 미들웨어가 걸려 있는지 |
| 5 | 권한 자원 카탈로그 ↔ `nav.js` 동기화 |

5번은 프런트 소스가 있어야 의미가 있어 **로컬에서만** 수행됩니다(배포 서버엔 `src/`가 없음).

> ⚠️ 이 검사는 **문법 수준의 정적 검사**입니다. 통과했다고 격리가 보장되지는 않습니다.
> 새 기능이 회사 경계를 넘나들 수 있는 성격이면 **실제로 회사 2개를 만들어 교차 테스트**하세요
> (`docs/reference/tenant-operations.md`의 교차 검증 절차 참고).

---

## 7. 실수 사례 (실제로 있었던 것)

전환 작업 중 자동 검사가 잡아낸 것들입니다. 같은 실수를 반복하지 않도록 남깁니다.

| 사례 | 무슨 일이 일어나는가 |
|---|---|
| `async (_, res, next)` 핸들러 14곳 | `req.db`가 ReferenceError → 그 화면 전체 500 |
| `syncTaxTxn(body, db = pool)` | 호출자가 `db`를 빠뜨리면 **에러 없이** 다른 회사 DB에 세금 거래를 씀 |
| `attachDocs(rows)` 등 헬퍼 4개 | 모듈 스코프라 `req` 없음 → 전역 풀 폴백 위험 |
| 권한 카탈로그에 `mgmt_ask` 누락 | 화면은 생겼는데 권한을 부여할 수 없음 |
| `uploads/`를 `express.static`으로 노출 | **인증 없이** 전 회사 증빙·계약서 다운로드 가능 |
| `config.yml`에서 catch-all 규칙 삭제 | Cloudflare 터널 기동 실패 → 전체 서비스 중단 |

---

## 8. 체크리스트 (PR 전)

- [ ] 새/수정 라우트가 `req.db`만 사용하는가
- [ ] 핸들러 시그니처가 `(req, res, next)` 인가
- [ ] 헬퍼 함수가 `db`를 인자로 받는가 (기본값 없이)
- [ ] 트랜잭션에 `finally { conn.release() }` 가 있는가
- [ ] 파일 저장 경로에 `companyId`가 들어가는가
- [ ] 스키마 변경이 멱등인가 / 데이터 변형이면 `runOnce`로 감쌌는가
- [ ] 화면을 추가했다면 `permissions.js`의 `RESOURCES`에도 넣었는가
- [ ] `npm run check:isolation` 통과하는가
- [ ] (회사 경계에 민감한 기능이면) 회사 2개로 교차 테스트했는가
