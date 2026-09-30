# 동진테크 전용 모듈 — MES 연결 설계

> 작성 2026-09-28 · 상태: **구현(로컬), 미배포** · 개정 2 2026-09-28 — ⚠ 아래 '개정 2' 가 앞 내용보다 우선한다 · 결정 배경: 메모리 `project_dongjin_custom_module`
> 관련: `project_mes_integration`(2026-09-09 "제품에 안 박고 동진 커넥터 + DB 공유"),
> MES 쪽 `dongjin-mes/.claude/docs/accounter-integration.md`

## 0. 한 줄 요약

**포크하지 않는다.** 도니도라 코드는 하나로 두고, 동진 전용은 `server/custom/dongjin/`·`src/custom/dongjin/`
한 곳에 모은다. 동진에게만 켜는 스위치는 기존 회사별 기능(`company_features`)을 쓴다.
MES DB(`winc_dj`)는 **읽기 전용 계정**으로 읽기만 한다.

---

## 1. 원칙

| # | 원칙 | 이유 |
|---|---|---|
| P1 | **원본은 한쪽만.** 거래처·품목·수주·발주·입고 = MES. 돈 기록(전표·입출금·세금계산서·미수/미지급) = 회계 | 양쪽이 같은 표를 쓰면 한쪽 규칙이 다른 쪽 데이터를 조용히 깨뜨린다 |
| P2 | **MES 에는 절대 쓰지 않는다.** DB 계정 권한으로 강제(SELECT only) | 코드 실수로도 못 쓰게 |
| P3 | **회계 규칙은 공통 코드 그대로 탄다.** 청구서는 `createInvoice`, 거래는 ledger·마감 가드 | 동진 장부만 다른 규칙으로 계산되면 포크한 것과 같다 |
| P4 | 공통 코드는 동진 폴더를 **모른다**(import 금지). 연결점은 라우트 파일 1개 + 메뉴 잎 1개 | `if (dongjin)` 이 퍼지는 순간이 분리 신호다 |
| P5 | 가져오기는 **미리보기 → 반영** 두 걸음(엑셀 임포트 마법사와 같은 모양). 자동 백그라운드 동기화는 나중 | 처음엔 사람이 눈으로 보고 넣어야 매핑 오류를 잡는다 |
| P6 | 같은 MES 건을 두 번 가져와도 **한 번만** 생긴다(멱등) | 외부 키 대장(§4)이 판정 |

---

## 2. MES 쪽 사실 (2026-09-28 조사)

- DB `winc_dj` — 같은 서버(192.168.0.34)의 **같은 MariaDB 10.6**. 테이블 `COERP_<모듈>_<이름>`.
- **삭제가 전부 하드 삭제**(`DELETE FROM`). 소프트 삭제 없음. 예외: 수주는 `COERP_SAL_ORDER_DELE` 에 보관 후 삭제,
  입고 취소는 `COERP_INV_WARE_HISTORY` 에 '취소' 행.
- `modi_date` 는 insert 때 NULL, DB 가 자동 갱신 안 함 → 증분 커서는 `COALESCE(modi_date, user_date)`.
- 키는 앱이 만드는 **고정 문자열**(재사용 안 함): 거래처 `202609A001`, 수주 `OR26…`, 발주 `PP2609…`, 입고 `WP/WM2609…`.
- `bit(1)` 은 `CAST(x AS UNSIGNED)` 로 읽는다.
- **매입에 부가세 칸이 없다.** 매출 출하는 `taxs_kwon` 을 사람이 친다.
- **매출마감은 미구현**(`SHIPMENT.clos_yesn` 은 늘 0). **매입마감은 동작**(`WAREHOUSING.clos_yesn`).

---

## 3. 테이블 대응표 (2026-09-28 개정)

| MES (원본) | 회계 | 방식 | 단계 | 비고 |
|---|---|---|---|---|
| `COERP_COM_CLIENTELE` 거래처 | `vendors` | **양쪽 다 고친다**(D3) — 대조 화면에서 어느 쪽 값으로 맞출지 사람이 고른다 | **1 ✅** | 사업자번호 N:1. 코드표 A매입·B매출·C겸함·**D금융/관공→E**·E기타→구분없음 |
| `COERP_SAL_ORDER` 수주 | (옮기지 않음) | **MES 를 그대로 읽는 '수주 현황' 화면**(D2) | **2 ✅** | PO(cont_numb) 1,257개라 계약 1:1 은 너무 잘다. '생산중'은 MES 에 생산 표가 생기면 |
| MES 2F 구매품의(발주+결재) | **지출결의서** 불러오기 | 회계 담당자가 승인된 품의 + 일반지출을 결의서로 묶어 대표 결재(D1) | 4 | 회계 구매품의서와 **다른 문서**. 운영 MES 구매표는 `COERP_PRO_*`, 2026-09-28 생성·테스트 몇 건 |
| MES 입고/반품 | 정기 지급 예정 목록 | 지금은 2F 가 엑셀로 넘긴다 → 회계가 직접 읽는다 | 5 | 운영에 입고 표 아직 없음. 미지급금은 세금계산서가 만든다(§5) |
| 자재(`MATLCODE`) | 동진 전용 품목 분류(D4) | MES 대·중·소·재질 체계를 따른다 | 후속 | 쓸모가 검증되면 제품으로 |

## 4. 외부 키 대장 — `external_links` (새 테이블, 전 테넌트 공통)

외부 ID 칸이 회계에 하나도 없다(`biz_no`·`order_no`·`code` 모두 자유 텍스트, 비고유). 멱등을 위해 대장이 필요하다.

```sql
CREATE TABLE external_links (
  id          VARCHAR(36) PRIMARY KEY,
  source      VARCHAR(20)  NOT NULL,   -- 'mes_dj'
  entity      VARCHAR(30)  NOT NULL,   -- 'vendor' | 'contract' | 'contract_item' | 'purchase_req' | 'purchase_req_item' | 'item'
  local_id    VARCHAR(36)  NOT NULL,   -- 회계 행 id
  ext_key     VARCHAR(80)  NOT NULL,   -- MES 키 (복합키는 'PP26090001:01')
  ext_rev     DATETIME     NULL,       -- 가져올 때 MES 의 COALESCE(modi_date,user_date)
  ext_gone    TINYINT      NOT NULL DEFAULT 0,  -- MES 에서 사라짐(하드 삭제 감지)
  synced_at   DATETIME     NOT NULL,
  UNIQUE KEY uq_ext (source, entity, ext_key),
  KEY ix_local (source, entity, local_id)
);
```

- **제품 중립 이름**(연동 일반)이라 전 테넌트에 깔려도 무해하다 — 다른 고객사 연동에도 그대로 쓴다.
  동진 전용 컬럼을 공통 테이블에 붙이지 않는다(회계코어 재정비 때 buyer_code 등을 걷어낸 원칙).
- 거래처는 N:1 이라 한 `local_id` 에 여러 `ext_key` 가 붙는다(UNIQUE 는 ext_key 쪽만).
- **연결된 행은 MES 가 주인인 칸을 회계에서 못 고친다**(이름·사업자번호·구분). 화면은 잠금 표시 + "MES 에서 고치세요".
  돈과 관련된 칸(결제 조건·계좌·비목 등)은 회계가 계속 고친다. → §6-D3

---

## 5. 이중계상 막기 — 가장 중요

미수금·미지급금의 원본은 **청구서(invoices)** 다(CLAUDE.md 단일 데이터 소스). 동진은 세금계산서를 홈택스 임포트로
이미 넣고 있다. 여기에 MES 입고로 미지급금을 **또** 만들면 같은 돈이 두 번 잡힌다.

그래서:
- MES 입고는 **청구서를 만들지 않는다.** 품의서의 실적 수량·금액만 채운다("받았다"는 사실).
- 미지급금은 지금처럼 **세금계산서(홈택스 임포트)** 가 만든다. 그때 같은 거래처·가까운 금액의 품의서를
  후보로 띄워 잇는다(기존 entry-hints·대사 금액 판정 재사용 — "금액이 판정을 맡는다").
- 매출도 같다: 출하/매출마감은 '납품했다'는 사실, 미수금은 매출 세금계산서가 만든다.
  (세금계산서 없이 채권 추적 — 메모리 `project_mes_integration` 의 구상 — 은 5단계에서 따로 설계)

---

## 6. 결정 (2026-09-28 사용자)

| # | 결정 |
|---|---|
| D1 | 연결점은 구매품의서가 아니라 **지출결의서**. 흐름: 1F 구매요청(생산이사 결재, 생략도) → 2F 구매품의서(대표 결재) → 발주 / 회계는 승인된 품의 + 일반지출(기숙사비 등)을 결의서로 불러와 대표 결재. 입고: 1F 입고·반품 → 2F 엑셀 → 회계 정기 지급일 지급 → 세금계산서 리스트·부가세. **전자결재(상신·결재선·선결재 후결/전결)는 회계 쪽에서 제대로 만들고 MES 를 거기 통일**(사용자가 양쪽 유지보수). MES 에 이미 `EIS_APPROVAL`(미결/후결/완결) 토대가 있다 — 통일 때 먼저 본다. 별도 설계서로 |
| D2 | 수주는 옮기지 않고 **동진 전용 수주 현황 화면**으로 MES 를 직접 읽는다 |
| D3 | 거래처는 **통합** — 두 쪽 다 고친다. 회계 값이 실제 상호라 더 정확한 경우가 많다. MES 쓰기는 **거래처 표 UPDATE 만**, 비어 있는 값으로 지우지 않고, 사업자번호(짝의 열쇠)는 덮지 않는다 |
| D4 | 품목 분류는 동진 전용으로 제대로(MES 체계). 실사용 고객은 동진이 유일 — 동진에서 검증된 것을 제품으로 올린다 |
| D5 | `dongjintech.kr/acct` 는 가능하지만 앱 전체를 경로 접두사에 맞춰야 해서 보류. **`acct.dongjintech.kr`** |

⚠ 원칙 P2(MES 에 쓰지 않는다)는 D3 로 **거래처 표 한정**으로 좁혀졌다. DB 계정 권한도 그만큼만 연다(§7-3).

## 7. 구조

```
server/
├── custom/dongjin/
│   ├── mesDb.js          ← 읽기 전용 풀(지연 생성, connectionLimit 2). MES_DB_* env
│   ├── mesRead.js        ← MES SELECT 모음. 여기 밖에서 winc_dj 를 부르지 않는다
│   ├── map/              ← 순수 함수(MES 행 → 회계 모양). 테스트는 여기에 몰린다
│   │   ├── vendor.js     (mesVendorMap.js 를 옮겨 오거나 감싼다)
│   │   ├── salesOrder.js
│   │   └── purchaseOrder.js
│   └── sync/             ← preview(db) / commit(db) — db 는 인자로(전역 풀 금지)
├── routes/dongjin-mes.js ← 얇은 라우터. feature 게이트 + custom 호출만
└── lib/externalLinks.js  ← 대장 읽기/쓰기(공통, 제품 중립)
src/
├── custom/dongjin/MesLink.jsx  ← 'MES 연결' 화면(미리보기 표 + 반영)
└── lib/nav.js                  ← 잎 `mes_link` 1개(기준정보 아래)
```

### 7-1. 켜고 끄기 (기존 틀 재사용)
- `plans.js FEATURE_NS` 에 `'custom'` 추가 → 키 `custom:dongjin_mes`.
- 운영 콘솔 `sellableCatalog()` 에 CUSTOM 목록을 더해 콘솔에서 동진에게만 켠다(감사 기록 자동).
- 서버: `routes/dongjin-mes.js` 첫 미들웨어가 `featuresOf()` 로 확인 — 없으면 **404**(존재 자체를 숨김).
- 화면: 잎 `mes_link` 는 기능이 없으면 메뉴에서 감춘다(`filterDocs` 와 같은 방식). 감추기는 보안이 아니다 — 서버 404 가 막는다.
- JWT 에 회사코드가 없으므로 `code === 'dongjin'` 비교는 쓰지 않는다(쓰려면 플랫폼 DB 조회가 또 필요).

### 7-2. 격리 검사 보강 (`check:isolation`)
조사 결과 지금 검사는 `routes/` 만 보고, `/api/a/b` 처럼 슬래시가 두 번인 마운트는 못 알아본다
(→ 권한 매핑 없이 **무검사 통과**). 그래서:
- 마운트는 평평한 `/api/dongjin-mes`, `API_RESOURCES` 에 `mes_link` 매핑.
- 검사 [1][2][8][9] 스캔 대상에 `server/custom/**` 추가.
- **새 검사**: `server/custom/` 밖에서 `custom/` 을 require 하는 곳은 `routes/dongjin-mes.js` 하나뿐 / `custom/` 밖에서 `winc_dj`·`mesDb` 언급 금지.
- **새 검사**: `mesRead.js` 의 SQL 은 `SELECT` 로만 시작(계정 권한과 이중 잠금).

### 7-3. 읽기 전용 계정
```sql
CREATE USER 'winc_ac_mes'@'localhost' IDENTIFIED BY '…';
GRANT SELECT ON winc_dj.* TO 'winc_ac_mes'@'localhost';
GRANT UPDATE ON winc_dj.COERP_COM_CLIENTELE TO 'winc_ac_mes'@'localhost';   -- D3 거래처 맞추기만
```
- `server/.env` 에 `MES_DB_NAME=winc_dj`, `MES_DB_USER`, `MES_DB_PASSWORD`(따옴표 — `#` 주의). 비번은 접속정보.md.
- 연결 예산: 테넌트 90 + 플랫폼 10 + MES 2 = 102 / 151.
- 로컬 개발: MES 덤프를 로컬 `winc_dj` 로 올려 같은 방식으로.

### 7-4. 서브도메인
- 터널 `donidora` 에 `acct.dongjintech.kr` → **`http://localhost:8081`** 한 줄(회계는 nginx 를 안 거친다).
- 이 주소로 들어오면 회사코드 칸 자동 `dongjin`: 플랫폼 `companies` 에 `domain` 칸(제품 중립 — 다른 고객사도 자기 주소 가능),
  로그인 화면이 `GET /api/auth/domain-hint` 로 조회. `?company=` 보다 우선.
- 오리진이 달라 로그인은 donidora.com 과 따로 유지된다(localStorage 분리) — 정상.

---

## 8. 단계 (개정)

| 단계 | 내용 | 상태 |
|---|---|---|
| **0 바탕** | 폴더·게이트(`custom:dongjin_mes`, 404)·격리검사 [20]·`external_links`·`companies.domain`+로그인 힌트 | ✅ 로컬 |
| **1 거래처 대조** | 같음/값 다름/연결 전/회계에 없음/연결 겹침 · 연결·끊기·가져오기·양방향 맞추기 | ✅ 로컬 |
| **2 수주 현황** | PO 단위 상태(납기 지남·임박·일부 납품·완료), 줄 보기 | ✅ 로컬 |
| 3 전자결재 | 상신·결재선·선결재(후결/전결). **별도 설계서** — MES `EIS_APPROVAL` 먼저 본다 | 설계 전 |
| 4 지출결의서 불러오기 | MES 승인 품의 → 결의서 줄 | MES 구매 안정 뒤 |
| 5 입고 → 정기 지급 | 입고 내역 → 지급 예정 → 세금계산서 대사 | MES 입고 표 생긴 뒤 |

### 구현 메모 (0~2단계)
- 서버: `routes/dongjin-mes.js`(유일한 입구) · `custom/dongjin/{mesDb,mesRead,mesWrite,vendorOps}.js` · `map/{vendor,order}.js`(순수, `test/dongjinMes.test.js` 15건) · `lib/externalLinks.js`(제품 중립)
- 화면: `src/custom/dongjin/{MesOrders,MesVendors,MesGate}.jsx`, nav `mes_dom`(custom 도메인 — `filterCustom`, Ctrl+K 는 `leafVisibleForCompany`)
- 켜기: 운영 콘솔 › 회사 › 기능 › '전용 모듈' 그룹. 서버 `.env` 에 `MES_DB_*`
- 서브도메인: 플랫폼 `companies.domain` 에 `acct.dongjintech.kr` 을 넣으면 로그인 화면이 회사코드를 채운다(`GET /api/auth/domain-hint`, 공개). 터널에 `acct.dongjintech.kr → http://localhost:8081` 한 줄
- 알려진 한계: 권한 게이트가 기능 게이트보다 먼저 돌아, 모듈이 꺼진 회사의 **권한 없는 사용자**는 404 대신 403 을 본다(마스터는 404). 존재가 드러나는 정도라 두었다
- 홈 포털 타일에는 아직 없다(사이드바·Ctrl+K 만)

## 9. 분리 신호 (이게 보이면 포크를 다시 논의)

- 동진이 **회계 규칙 자체**(마감·전표 구조·잔액 계산)를 다르게 원한다
- 공통 코드에 `if (dongjin)` / 동진 전용 컬럼이 들어가기 시작한다
- 계약상 동진이 코드 소유·별도 운영을 요구한다

동진 전용 기능 2~3개(대략 1~3단계)를 만든 뒤 한 번 재판단한다.

---

## ⭐ 개정 2 (2026-09-28 사용자 정정) — 이 절이 위 내용보다 우선한다

사용자: "왜 거래처 대조나 수주 현황을 따로 만든거야? 계약관리 내의 수주에 MES 수주의 상태를 보여주게끔
연결하고(등록은 못함, 보기만), 거래처 대조 할 거 없이 거래처를 MES 쪽 DB 꺼를 쓰라니까"

→ 별도 메뉴(MES 연결 › 수주 현황·거래처 대조)는 **없앴다.**

### 수주
- **계약관리 › 수주** 자리가 동진에서는 MES 수주(보기 전용). 등록 버튼 없음. `App.jsx contract_sales`
  (모듈 상태를 읽기 전에는 로딩 — 옛 화면의 '신규 생성'이 번쩍이지 않게)
- API `GET /api/dongjin-mes/orders` · `/orders/:po/lines`, 권한 자원은 `contract_sales` 그대로

### 발주 (2026-09-29 사용자 A안)
- **계약관리 › 발주** 자리도 동진에서는 MES 구매발주(보기 전용, 등록 없음). `App.jsx contract_purchase`
- 운영 실측: 헤더 `COERP_PRO_PPRO`(6) · 품목 `COERP_PRO_PPROITEM`(8) · 입고 `COERP_MAT_WAREHOUSING`(8, pros_numb 로 연결)
- 단계 = MES 진행상태 `ppro_stat` 그대로(발주등록 → 승인요청 → 발주완료 → 입고처리 → 입고완료) — 다시 판정하지 않는다.
  입고 진척은 품목 누적 `rece_qtys` / 발주수량. 납품일(`pdel_date`) 지났는데 입고완료가 아니면 빨강
- API `GET /api/dongjin-mes/purchase-orders`(기간=발주일, summary 는 기간 무관 전체) · `/purchase-orders/:no/lines`(품목+입고)
- 권한: 발주 목록은 `contract_purchase`(apiPerms RESOURCE_OVERRIDES), 수주는 `contract_sales`
- 수주도 같은 날: 기간 필터(수주일 = 현대 cont_date → 한화 appr_date → user_date) + 카드는 기간 무관 전체

### 거래처 — MES 표(COERP_COM_CLIENTELE)가 원본
- 회계 vendors 에는 MES 코드 하나당 **짝 행**(1:1, `external_links` source=mes_dj). 회계 표 11곳이
  vendors.id 를 FK 로 가리키기 때문에 행 자체는 필요하다. 내용은 MES 값으로 덮인다.
- 공통 코드의 끼움 자리 `lib/vendorSource.js`(제품 중립) — routes/vendors.js 가 부른다:
  - 읽기 전 `beforeVendorRead` → MES 에서 바뀐 행 끌어오기(15초 간격, 수정 시각 비교)
  - 등록·수정·사용/미사용·엑셀 임포트 뒤 `afterVendorWrite` → MES 표에 INSERT/UPDATE
    (코드는 MES 와 같은 규칙 YYYYMM+A~Z+001, 등록 실패 시 회계 쪽 새 행도 지운다)
  - 삭제 `vendorDeleteOverride` → MES 는 지우지 않고 양쪽 '사용 안 함'(MES 수주·발주가 코드를 들고 있다)
- 동진 구현 `custom/dongjin/vendorSource.js`, 칸 대응 `map/vendor.js`(순수, 테스트 13건)
- 처음 옮길 때: 짝 없는 회계 거래처는 **사업자번호(없으면 상호)** 로 MES 행과 먼저 잇는다 — 중복 생성 방지.
  로컬 실측: 회계 135 중 121 이 MES 와 사업자번호로 이어짐, MES 사업자번호 중복 0
- ⚠ **회계에만 있는 거래처를 MES 로 올리는 것은 기본 꺼짐**(`MES_VENDOR_UPLOAD=1` 일 때만).
  운영 동진은 회계 145 · MES 121 — 켜면 스무 곳 넘게 MES 에 생긴다. 사용자 결정(Q1) 대기.
  꺼져 있어도 사람이 거래처 화면에서 저장한 것은 MES 로 간다.
- 두 DB 는 한 트랜잭션으로 못 묶는다 → MES 를 먼저 쓰고 회계를 맞춘다. MES 쓰기가 실패하면 회계 짝 행을
  MES 값으로 되돌리고 502. 원본이 MES 라 되돌아가는 방향이 늘 하나다.
- 회계에만 있는 칸(거래 유형·서비스 유형·지급 계좌 여럿·담당자 여럿)은 회계에 남는다
- **검토 반영(2026-09-28)**:
  - 한 회사 안에서 pull·push·remove 는 한 줄로 선다(동시 목록 열기 → 짝 행 두 개 생기던 것)
  - 쓰기는 **바뀐 칸만**. 마지막으로 맞춘 뒤 MES 에서 고쳐졌으면(수정 시각 비교) 덮지 않고 409 + MES 값으로 되맞춤
  - MES 에서 지워진 거래처는 회계가 되살리지 않는다(다시 켜기·저장 → 409)
  - 끌어오기 실패는 읽기를 막지 않는다(경고만, 마지막 값으로 보여 줌). MES 연결 대기 2초
  - 짝 찾기: 사업자번호 없는 이름 매칭은 **딱 하나일 때만**, 사용 중인 회계 행 먼저
  - 엑셀 임포트는 회계에 들어간 뒤 MES 쓰기가 실패해도 500 대신 경고(중복 재업로드 방지)
  - 회귀: `test/dongjinMes.test.js` + 로컬 시나리오(동시 끌어오기·칸 보존·충돌 409·삭제 후 되살림 막기)
- MES DB 계정 권한: `SELECT ON winc_dj.*` + `INSERT, UPDATE ON winc_dj.COERP_COM_CLIENTELE` (DELETE 없음)

### 없앤 것
- 거래처 대조 화면·연결/끊기/맞추기 API, nav `mes_dom`, 권한 자원 `mes_orders`·`mes_vendors`, 감사 규칙 mes_link·mes_sync
- 남은 찌꺼기 파일 3개(삭제 권한이 막혀 못 지움, 아무도 안 부름): `server/custom/dongjin/vendorOps.js`,
  `server/lib/externalLinks.js`(vendorOps 만 불렀다), `src/custom/dongjin/MesVendors.jsx` — 커밋 전에 지운다

### 운영 배포 전 할 일
1. Q1 결정(회계에만 있는 거래처를 MES 로 올릴지) → `MES_VENDOR_UPLOAD`
2. MES 계정 만들기(위 권한) + `server/.env` `MES_DB_NAME=winc_dj` `MES_DB_USER` `MES_DB_PASSWORD`
3. **배포 직전 운영 백업(회계 acct_c0002 + MES winc_dj)** — 첫 끌어오기가 회계 거래처 145곳의 이름·계좌를 MES 값으로 덮는다
4. 운영 콘솔에서 동진에 '전용 모듈' 켜기
5. 서브도메인: 터널 `acct.dongjintech.kr → http://localhost:8081`, platform `companies.domain`
