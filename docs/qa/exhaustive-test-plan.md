# Exhaustive 테스트 설계문서 — 일반회계 · 인사급여

> 3개 인벤토리 에이전트(일반회계 UI / 인사급여 UI / 백엔드 정합성)가 전 화면·전 엔드포인트·정합성 규칙을 전수 조사한 결과를 종합한 실행형 테스트 계획.
> 목적: "실사용 문제 최소화". QA는 문제의 부재를 증명 못 하므로, **돈·데이터가 틀어지는 경로(P0)를 최우선**으로 전수 검증하고, 발견 즉시 수정·재검증한다.
> 각 케이스: [우선순위] 시나리오 — 단계 → 기대결과 → 검증방식(UI/API/DB) → (해당 시 인벤토리 RISK 참조).

---

## 0. 실행 환경·방법 (별도 세션 공통)

- 임시 풀스택 서버 **PORT=3096~3099**, `DB_USER=root DB_PASSWORD=1234 DB_NAME=winc_dj_ac`(로컬 `.env` 비번 불일치 → root 오버라이드). **3001(사용자)·운영 절대 금지.**
- 로그인 우회: `localStorage.loggedIn=1` + user. SW 캐시 시 `?v=N`.
- **조작=Playwright, 부작용 검증=API/DB 조회**(잔액·거래·미수/미지급은 화면에 안 보이는 side-effect라 반드시 교차검증).
- 한글 API 테스트는 Bash curl UTF-8 깨짐 → **Node http 스크립트**.
- 케이스별: 실행 → 검증 → 실버그면 수정 → 재검증 → 데이터 정리(`[검증]` prefix, FK 순서 유의: 거래→payroll/청구→계약/직원).
- 발견 = 심각도(P0 돈/데이터·보안 · P1 correctness · P2 cosmetic/robustness)로 분류, 수정 후 회귀.

---

## ⚠ TIER S — 즉시 결정 필요 (테스트 이전에 사용자 판단)

### S1 [보안 P0] 모든 금융 API가 인증 없음
`middleware/auth.js`는 `/api/auth/me`·`/api/auth/users*`에만 적용. **accounts·transactions·invoices·contracts·payroll·tax·resolutions 등 모든 돈 데이터 엔드포인트가 무인증.** 포트에 닿는 누구나 조회·수정 가능. 운영은 `acct.custwin.shop`(Cloudflare 터널)로 외부 노출.
- **결정**: (a) 데이터 라우트에 authMiddleware 일괄 적용(프론트 JWT 이미 있음 — req()에 토큰 실림 확인 필요) / (b) Cloudflare Access 등 앞단 접근제어 / (c) 감수. 
- 프론트 `req()`가 Authorization 헤더를 보내는지 먼저 확인 → 보내면 서버에 미들웨어만 붙이면 됨(저위험). 안 보내면 프론트도 수정 필요.
- ⚠ 잘못 붙이면 전 화면 401 → **테스트 필수**. 이 결정 없이 나머지 QA 진행 가능하나, 배포 전 반드시 정리.

---

## TIER 0 — 돈·데이터 정합성 (P0, 최우선 전수)

### 급여·용역 (인사급여)
- **T0-1** 급여 지급(부분/전액/과지급) → 거래내역 생성 + **계좌잔액 반영**(status='지급완료') + 미지급/과지급. ✅*이미 검증(F-02 수정분)*. 회귀만.
- **T0-2** 용역·일용 지급(수량×단가, 원천징수 확정공제, payNow) → 거래+잔액+누적+seq≥1, 급여대장(seq0) 분리. ✅*검증됨*. 회귀.
- **T0-3** 급여대장 생성 = 유효 근로계약(seq0) 소스, 퇴사자 제외, pay_items 빈 계약 폴백. ✅*검증*.
- **T0-4** [RISK 인사#9] **연봉 인상 "새 계약" UI 버튼이 기존 계약을 만료로 안 바꿈** → 한 직원 진행중 계약 2건. `LaborDrawer.save`에 기존 계약 만료 처리 없음(퇴사만 함). 검증: UI로 새 계약 만들고 목록에 진행중 2건 뜨는지 → 뜨면 **수정**(새 계약 시 직전 진행중 계약 만료, 또는 generate/monthly_net dedup 보장).
- **T0-5** [RISK 인사#27] **급여 기준 저장(LaborPayItemsTab)이 work_hours/conv_alert_months/memo 누락 재구성** → 저장 시 그 필드 유실 가능. 검증: 소정근로시간 입력한 계약에서 급여기준 탭 저장 후 그 값 남는지 → 유실되면 **수정**.
- **T0-6** [RISK 인사#26] 메모 저장이 `...contract` 스프레드 → labor는 items undefined/service는 pay_items undefined로 상대 배열 null화 가능. 검증: 용역계약 메모 저장 후 단가표 유지되는지.
- **T0-7** [RISK 인사#6] **PayDrawer(급여 지급)에 미래날짜 가드 없음**(ServicePayDrawer엔 있음). 검증: 급여 지급일 미래로 등록 시도 → 막히는지. 안 막히면 **수정**(앱 전체 KST 규칙 일관).

### 청구·계약·거래 (일반회계)
- **T0-8** 매출 총액형: 계약→청구일정 자동→발행(+기입금)→입금·미수금·계좌잔액. ✅*검증*. 회귀.
- **T0-9** 매입: 청구 수취→지급(+기지급)→미지급금·계좌잔액(지급완료). ✅*검증*.
- **T0-10** [RISK 백엔드#2, F-02 형제 생존] **`PATCH /transactions/:id/status`가 임의 문자열 허용.** 정기지출 generate는 `'지급 대기'`로 거래 생성 → 완료 처리 시 `'지급완료'` 아닌 철자('지급 완료' 등)면 잔액서 누락. 검증: 정기지출 생성분을 UI '이체 실행'으로 완료 → 거래 status가 정확히 '지급완료'인지 + 잔액 반영되는지. 틀리면 **수정**(status 화이트리스트 or UI가 올바른 값 전송).
- **T0-11** [RISK 백엔드#14] **청구서 매칭 시 기존 거래 연결이 body.amount 사용**(거래 실제금액 아님) → 장부/청구 잔액 불일치. 검증: 거래 100만인데 매칭 50만 입력 → 청구 remain은 -50만, 잔액은 -100만? 정합 확인. + [RISK 일반#linkMatch] 초과매칭 가드 없음(txn.amount>remain). 검증: 큰 거래를 작은 청구에 연결 → 초과 방지되는지.
- **T0-12** [RISK 백엔드#5,#6] 거래 삭제 → invoice_matches 고아(FK 없음)+청구 status 재계산 안 함 / 매칭 삭제 → 청구 status 미복구. 검증: 매칭된 거래 삭제 후 청구서 미수금 복구되는지, 잔액 정합.
- **T0-13** [RISK 백엔드#4] 계약 metrics(전 status)·cost_actual(지급완료만)·잔액(지급완료만) 3중 불일치. 정기지출('지급 대기') 걸린 매입계약에서 세 숫자 확인.
- **T0-14** [RISK 백엔드#13] schedule/issue·progress-invoice 기입금이 **첫 은행계좌 고정**(선택 무시). 검증: 은행 여러 개일 때 기입금이 의도 계좌로 가는지 → 아니면 **수정**(계좌 선택 인자 전달).
- **T0-15** 부가세 신고 완료→거래 생성/취소→거래 삭제·잔액 원복(tax.js). 기타세액 동일. 검증 both.
- **T0-16** 지급결의서 process(create/link)→지출 거래+청구 지급처리 연동, from-invoice 품목별. ✅*일부 검증(매입 결의서)*. 나머지.
- **T0-17** [RISK 백엔드#15] `JSON.parse(cost_budget)` 무가드 → 손상 1행이 계약목록 전체 500. 검증: cost_budget에 깨진 JSON 심고 목록 조회 → 500이면 **수정**(safeParse).

---

## TIER 1 — 흐름·상태 정확성 (P1)

### 인사급여
- **T1-1** 직원 등록(고용형태 자동채움: pay_form·4대보험) → 저장 → 계약+직원. 사번 무충돌. ✅*검증*.
- **T1-2** 용역 인력 등록(고용형태→소득구분·단위·conv 자동, 소득구분 칩 사업↔기타 kind 유지). ✅*부분검증*.
- **T1-3** 상용전환 경고(일용 3개월/건설 12개월): 배너+행배지+개월수. ✅*검증*. [RISK 인사#22] 경고가 mount 시만 갱신 — Master에서 conv 바꿔도 열린 목록 미갱신. 검증.
- **T1-4** 명세서 4종(근로 임금명세서 / 일용·사업·기타 공통) 인쇄: 금액 0 아님(computeItems), [RISK 인사#19] **printPayslip(HR.jsx)는 HTML 이스케이프 없음** → 이름에 `<`,`&` 넣고 인쇄 레이아웃 확인. 깨지면 **수정**.
- **T1-5** 퇴사→급여대장 제외, 재직 필터. [RISK 인사#24] 만료 계약+재직 직원이 active 필터서 사라짐(재입사 케이스). 검증.
- **T1-6** 과지급(PayDrawer amount>remain 무제한), 지급 취소(deletePayrollPayment)→잔액 원복. ✅*부분*.
- **T1-7** 고용형태/급여항목 소프트삭제 후 기존 계약·명세 스냅샷 유지, 신규 선택 불가. ✅*검증(고용형태)*.
- **T1-8** 이 달 비우기: [RISK 인사#12] 비트랜잭션 루프 — 부분 실패 시 반쪽 삭제인데 토스트는 성공. 검증(정상 경로 + 다건).
- **T1-9** [RISK 백엔드#9] payroll DELETE 비트랜잭션(unlink+delete). 정상 경로 확인.

### 일반회계
- **T1-10** 계약 정기형: 초기 일시금+주기 정액, 갱신(RenewDrawer)→종료일·단가·연결 정기 반영, 미갱신 종료. 
- **T1-11** [RISK 일반#3] **계약 상세 탭 상태가 계약 전환 시 유지** → billing_mode 다른 계약 열면 빈 탭. 검증: progress 계약 '기성 청구 내역' 탭 본 뒤 onetime 계약 열기.
- **T1-12** [RISK 일반#4] **계약 "메모 남기기"가 토스트 뿐 저장 안 됨.** 검증: 메모 입력·저장 후 재조회 → 사라지면 **수정**(실저장 or 버튼 제거).
- **T1-13** [RISK 일반#5] issueInvoiceForMilestone 확인창이 **면세인데 VAT 10% 하드코딩** 표시(서버 계산은 정확). 검증: 면세 계약 발행 확인창 문구.
- **T1-14** 기성 청구(ProgressInvoiceDrawer): 수량→금액 자동(수정가능), supply=Σ, 면세 vat0, paid 정산. ✅*검증(df7cde6)*.
- **T1-15** 마일스톤 편집(비율→금액 자동, locked=발행분 읽기전용, 전체교체 invoice_id 보존), Σ≠계약액 경고.
- **T1-16** 정기청구 소급 차단(등록일부터)+미래 35일 미리보기+earliest-first 발행(409). ✅*커밋 736a236*. 실UI 확인.
- **T1-17** 정기지출 generate(최신 1건, '지급 대기')→발행예정 노출→완료 처리(T0-10과 연계).
- **T1-18** 거래 등록 폼: 면세 토글·supplyMode·품목 자동채움·원가귀속(cost_contract_id)·미래날짜 차단·자동생성 거래 편집(공통 프리필). ✅*부분(미래차단)*.
- **T1-19** 증빙 다중첨부(거래/청구/계약) 업로드·다운로드·삭제, 레거시 evid_url 병합.
- **T1-20** 엑셀 업로드: 파싱·매핑·오류행 제외·commit(자동 거래처 생성). [RISK 백엔드#11] **import/commit 미래날짜 무가드**+미래 income 즉시 잔액 반영. [RISK 일반#7] `Math.abs`로 음수 부호 소실. 검증.

---

## TIER 2 — robustness·엣지·cosmetic (P2)

- **T2-1** [RISK 백엔드#10] emp_no·invoice_no **유니크 인덱스 없음** → 동시/다경로 생성 시 중복. 단일사용자라 낮음. doc_no/payroll seq는 유니크지만 생성자가 ER_DUP_ENTRY 미포착 → 동시 500. 정보성.
- **T2-2** [RISK 백엔드#7,#8] account DELETE 가드가 recurring_invoices·adjustments 누락 → 409 대신 500. vendor/employee 하드삭제 FK 500. **친절한 409 처리 검토**. (F-01과 동류.)
- **T2-3** [RISK 백엔드#12] dashboard가 UTC "today" + 잔액쿼리 중복 + AR/AP denylist(≠invoices allowlist) → KST 화면과 경계일 불일치. 검증.
- **T2-4** [RISK 백엔드#16] boot마다 `bumpRate`(구값일 때만)·`doc_no='공통'` 재적용 → 사용자가 되돌린 값/비운 doc_no 덮어씀. 정보성.
- **T2-5** [F-03] ReportTax4 부제 "2026년 5월…" 하드코딩. Docs.jsx. cosmetic.
- **T2-6** FAQ/도움말 텍스트가 옛 UI(직원 탭·자동 세금계산) 설명 — 내용 불일치. nav.js/App.jsx HELP_MAP·FAQ_DATA. 갱신 검토.
- **T2-7** KST vs UTC 혼재: HRScreen 월초기값·PayDrawer 날짜·ReportTax4 월이 `toISOString`(UTC), ServicePayDrawer만 KST. 자정 근처 하루 어긋남. 통일 검토.
- **T2-8** 서버다운 degradation: 모든 read가 빈배열/null 반환 → 화면 크래시 없이 빈 상태인지, 0을 실데이터처럼 오도하지 않는지.
- **T2-9** 죽은 목업 코드(IncomeDrawer/ExpenseDrawer/EvidenceScreen/CONTRACT_LIST/MOCK_DOCS) 도달 불가 확인. evidence 숨김 route 수동 해시 시 크래시 없이 렌더.
- **T2-10** computeItems 항목별 반올림(sum-of-rounded vs rounded-sum), percent-mode earn이 percent base서 제외되는 규칙 의도 확인. 잘못된 percent 입력('1.2.3').
- **T2-11** CSV 내보내기 이스케이프(따옴표·콤마·한글 BOM), 대량 목록 렌더(페이지네이션 없음) 성능.

---

## 실행 순서 (권장)

1. **S1 결정** 먼저 사용자와(보안). 
2. **TIER 0 전수** (P0 돈/데이터) — T0-4,5,6,7,10,11,12,14,17이 미검증 실버그 후보 → 우선. 발견 즉시 수정·재검증.
3. **TIER 1** 흐름 정확성 — 미검증 위주(T1-11,12,13,16,20 등).
4. **TIER 2** — 판단·후속(대부분 수정 여부 사용자 확인).
5. 각 TIER 종료마다 중간 보고. 수정분은 그룹으로 커밋. 배포는 사용자 확인 후.

## 참조
- 인벤토리 원본(에이전트 3종) 요지는 이 문서에 편입. 세부 file:line은 해당 라우트/화면 파일.
- 관련: `hr-work-contract.design.md`, `stabilization-scenarios.md`(1차), work_20260720c(F-02), project_deploy_server.
