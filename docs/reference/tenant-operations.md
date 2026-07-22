# 테넌트 운영 매뉴얼

> 회사(테넌트) 추가·삭제, DB 준비, 권한 진단, 배포, 장애 대응 절차.
> 코드 작성 규칙은 `docs/reference/multi-tenant-dev-guide.md` 를 보세요.

모든 명령은 **`server/` 디렉터리에서** 실행합니다.

---

## 1. 명령 요약

| 명령 | 용도 | 안전성 |
|---|---|---|
| `npm run setup:db` | 공용DB+스키마+부트스트랩+역할 보정 | 멱등, 배포마다 실행됨 |
| `npm run setup:db:check` | 변경 없이 상태만 점검 | 읽기 전용 |
| `npm run check:db` | 계정별 권한 진단 + 필요한 GRANT 출력 | 읽기 전용 |
| `npm run check:isolation` | 테넌트 격리 정적 검사 | 읽기 전용 |
| `npm run migrate:uploads` | 첨부를 회사별 폴더로 이전 | 멱등 |
| `npm run tenant -- --list` | 회사 목록 | 읽기 전용 |
| `npm run tenant -- --code …` | **회사 생성** | 실패 시 자동 롤백 |
| `npm run tenant:delete -- --code …` | **회사 삭제** | ⚠️ 되돌릴 수 없음 |

> npm 스크립트에 인자를 넘길 때는 `--` 를 반드시 붙입니다: `npm run tenant -- --list`

---

## 2. 회사 추가

```bash
npm run tenant -- \
  --code hanbit \
  --name "한빛이엔지" \
  --user boss \
  --password 'Str0ngPw!23' \
  --username-label "김대표" \
  --email boss@hanbit.co.kr
```

| 인자 | 설명 |
|---|---|
| `--code` | **회사코드(로그인 시 입력)**. 소문자 영문·숫자·하이픈 4~20자. **생성 후 변경 불가** |
| `--name` | 회사명(표시용) |
| `--user` / `--password` | 마스터 계정. 비밀번호 8자 이상 |
| `--username-label` | 마스터 표시 이름(선택) |
| `--email` | 마스터 이메일 — **본인 비밀번호 재설정 경로**(선택이지만 권장) |

**자동으로 되는 일**
1. `companies` 행 선점(`status=provisioning`) — 코드 중복을 DB 유니크로 차단
2. 전용 DB 생성 (`acct_c0001`, `acct_c0002` … 순번)
3. 스키마 + 기준정보 시드 (계정과목 125·비목 53·적요·급여항목·고용형태)
4. 기본 역할 3종(마스터/경리/조회전용) + 권한 매트릭스
5. 마스터 계정 생성 + 마스터 역할 연결
6. `status=active` 전환

**실패하면** 만들다 만 DB를 `DROP`하고 회사 행을 지웁니다(보상 정리). 찌꺼기가 남지 않습니다.

**회사코드를 정할 때**
- 로그인 화면에서 직원들이 매번 입력하는 값 → 회사명 기반으로 기억하기 쉽게
- **생성 후 변경 불가**(로그인·북마크·문의가 전부 깨지므로). 신중히
- 예약어(`admin`, `api`, `www`, `platform` 등)는 거부됨

---

## 3. 회사 삭제

⚠️ **되돌릴 수 없습니다.** 반드시 `--dry-run` 으로 먼저 확인하세요.

```bash
# 1) 무엇이 지워지는지 확인
npm run tenant:delete -- --code deltest --dry-run

# 2) 확인 후 실제 삭제 (회사코드를 두 번 입력해야 실행됨)
npm run tenant:delete -- --code deltest --confirm deltest
```

**안전장치**
| 장치 | 동작 |
|---|---|
| `--confirm` 이중 입력 | 회사코드를 한 번 더 입력해야 실행 (오타·복붙 사고 방지) |
| 자동 백업 | 삭제 전 DB 전체를 `~/backups/deleted_<코드>_<DB>_<시각>.sql` 로 덤프. **백업 실패 시 삭제 중단** |
| 마지막 회사 보호 | 회사가 1개면 삭제 거부 (아무도 로그인 못 하게 되는 상황 방지) |
| 접두사 보호 | `acct_` 로 시작하지 않는 DB(=흡수한 실서비스 DB)는 `--force` 없이 거부 |
| 데이터량 표시 | 삭제 전 거래처·계약·청구서·거래·직원 건수를 보여줌 |

**지워지는 것**: 테넌트 DB · `companies` 행 · 계정·역할·권한(FK CASCADE) · `uploads/{companyId}/` 폴더

`--no-backup` 은 백업을 건너뜁니다. **권장하지 않습니다.**

---

## 4. 최초 설치 / DB 준비

### 4.1 DB 계정 (권한 분리)

앱 런타임 계정은 **DML만**, 스키마 작업은 **관리 계정**이 합니다.

```sql
-- 관리 계정 (DDL 전용)
CREATE USER 'acct_admin'@'localhost' IDENTIFIED BY '<강한비밀번호>';
GRANT ALL PRIVILEGES ON `acct\_%`.*   TO 'acct_admin'@'localhost';
GRANT ALL PRIVILEGES ON `<기존DB>`.*  TO 'acct_admin'@'localhost';

-- 앱 계정 (DML만)
GRANT SELECT, INSERT, UPDATE, DELETE ON `acct\_%`.* TO '<앱계정>'@'localhost';

FLUSH PRIVILEGES;
```

> ⚠️ GRANT에서 `_` 는 와일드카드입니다. **`acct\_%` 로 이스케이프**해야 `acct_` 접두사만 매칭됩니다.
> ⚠️ `SHOW GRANTS`는 배치 모드에서 백슬래시를 이중 표시(`acct\\_%`)합니다. 실제 값은 `--raw` 로 확인하세요.

`.env` 에 추가:
```
PLATFORM_DB_NAME=acct_platform
BOOTSTRAP_COMPANY_CODE=<기존 회사에 부여할 코드>
DB_ADMIN_USER=acct_admin
DB_ADMIN_PASSWORD=<위 비밀번호>
COOKIE_SECURE=1        # HTTPS 환경 필수. 안 하면 첨부파일이 안 열린다
```

### 4.2 실행

```bash
npm run check:db      # 권한 확인 — 부족하면 실행할 GRANT 문을 그대로 출력
npm run setup:db      # 공용DB 생성 + 스키마 + 기존 데이터 흡수
npm run migrate:uploads
```

`setup:db`는 기존 단일 테넌트를 **첫 회사로 흡수**합니다 — 기존 `users`를 bcrypt 해시째 공용 DB로 옮기므로 **비밀번호가 그대로 유지**됩니다.

---

## 5. 배포

```bash
bash deploy.sh
```

단계: 격리 검사(로컬) → 프런트 빌드 → 전송 → 의존성 → 격리 검사(원격) → **`setup:db`** → **`migrate:uploads`** → pm2 reload → 헬스체크

앱 런타임이 DDL을 하지 않으므로 **스키마 준비는 배포의 책임**입니다. `setup:db`가 멱등이라 매 배포마다 안전하게 돌아갑니다.

기동 시 `assertPlatformReady()`가 공용 DB 접근·스키마 완전성·회사 등록 여부를 검증합니다. 미비하면 **조용한 런타임 오류가 아니라 명확한 기동 실패**로 끝나며, 실행할 명령을 안내합니다.

---

## 6. 교차 테넌트 검증 절차

회사 경계에 민감한 기능을 만들었거나, 새 회사를 처음 받을 때 수행합니다.

```bash
# 검증용 회사 생성
npm run tenant -- --code testco --name "검증" --user boss --password 'Test!2345'
```

두 회사 토큰을 각각 받아 확인:

| 확인 항목 | 기대 |
|---|---|
| B사 계정으로 목록 조회 | A사 데이터가 **하나도 안 보임** |
| B사 토큰으로 A사 첨부 URL 접근 | **404** |
| A사 아이디로 B사 회사코드 로그인 | **거부** |
| JWT의 `dbName`을 조작한 요청 | **거부**(서명 불일치) |
| B사에 데이터 추가 | A사 건수 **변화 없음** |

끝나면 `npm run tenant:delete -- --code testco --confirm testco`

---

## 7. 장애 대응

| 증상 | 확인 |
|---|---|
| 기동 실패 `공용 관리 DB에 접근할 수 없습니다` | `npm run check:db` → 권한 확인 후 `npm run setup:db` |
| 기동 실패 `등록된 회사가 없습니다` | `npm run setup:db` (부트스트랩 미실행) |
| 로그인 `회사코드를 찾을 수 없습니다` | `npm run tenant -- --list` 로 코드 확인 |
| 로그인 후 `다시 로그인해 주세요` 반복 | 구 토큰(`companyId` 없음). 브라우저 localStorage 비우고 재로그인 |
| **첨부파일이 안 열림** | HTTPS인데 `COOKIE_SECURE=1` 누락 가능성. `.env` 확인 후 재기동 → **재로그인 필요**(쿠키는 로그인 시 발급) |
| 첨부 404 | `migrate:uploads` 미실행이거나 파일이 회사 폴더 밖에 있음 |
| 커넥션 부족 | `TENANT_POOL_MAX`(기본 50)·`TENANT_POOL_CONN_LIMIT`(기본 3) 조정, MariaDB `max_connections` 확인 |

### 백업·복구

- 배포 전 자동 백업은 없습니다. 큰 변경 전에는 수동으로:
  ```bash
  mysqldump -u<계정> -p<비번> --single-transaction <DB> > ~/backups/<DB>_$(date +%Y%m%d_%H%M%S).sql
  ```
- 회사 삭제 시에는 **자동으로** `~/backups/deleted_*.sql` 이 생성됩니다
- 복구: `mysql -u<계정> -p<비번> <DB> < 백업파일` 후 `companies` 행 재등록 필요

---

## 8. 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PLATFORM_DB_NAME` | `acct_platform` | 공용 관리 DB |
| `DB_NAME` | — | 기존(첫) 테넌트 DB |
| `BOOTSTRAP_COMPANY_CODE` | `dongjin` | 최초 흡수 시 부여할 회사코드 |
| `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD` | 앱 계정 폴백 | DDL 전용 관리 계정. **운영에서는 반드시 분리** |
| `COOKIE_SECURE` | `0` | HTTPS 배포 시 `1` 필수 |
| `TENANT_DB_PREFIX` | `acct_` | 신규 테넌트 DB 접두사 |
| `TENANT_POOL_MAX` | `50` | 동시에 상주시킬 회사 풀 수 |
| `TENANT_POOL_CONN_LIMIT` | `3` | 회사당 커넥션 수 |
| `TENANT_POOL_IDLE_MS` | `600000` | 유휴 풀 회수 대기(10분) |
| `TENANT_BACKUP_DIR` | `~/backups` | 삭제 시 백업 위치 |
