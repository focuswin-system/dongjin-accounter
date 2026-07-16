/**
 * 동진테크 ERP 초기 데이터 시딩 스크립트
 * bkend.ai BaaS 구현 후 이 파일의 데이터를 각 테이블에 INSERT
 *
 * 사용법:
 *   import { seedAll } from './seed'
 *   await seedAll(api)  ← bkend.ai api 인스턴스 전달
 */

// ─── 계좌 (4개) ───────────────────────────────────────────────
export const SEED_ACCOUNTS = [
  { name: "기업은행(주거래) *4010", bank: "IBK기업은행", type: "보통예금", initial_balance: 48720000 },
  { name: "하나은행(급여이체) *7231", bank: "하나은행",   type: "보통예금", initial_balance: 22450000 },
  { name: "기업은행(시제통장) *077",  bank: "IBK기업은행", type: "보통예금", initial_balance: 5890000 },
  { name: "우리은행(정산) *301",      bank: "우리은행",    type: "보통예금", initial_balance: 0 },
]

// ─── 거래처 (발주처 2 + 외주처 13 + 기관 7) ──────────────────
export const SEED_VENDORS = [
  // 발주처 (gubu: B)
  { name: "한화오션",          biz_no: "415-81-37235", gubu: "B", type: "발주처",   service_type: "—" },
  { name: "HD현대중공업",       biz_no: "290-81-00066", gubu: "B", type: "발주처",   service_type: "—" },
  // 외주가공 (gubu: A)
  { name: "광명산업",          biz_no: "",              gubu: "A", type: "외주가공", service_type: "외주가공" },
  { name: "건후테크",          biz_no: "",              gubu: "A", type: "외주가공", service_type: "외주가공" },
  { name: "세한테크",          biz_no: "",              gubu: "A", type: "외주가공", service_type: "외주가공" },
  { name: "와이더블유테크",    biz_no: "",              gubu: "A", type: "외주가공", service_type: "외주가공" },
  { name: "일광테크",          biz_no: "",              gubu: "A", type: "외주가공", service_type: "외주가공" },
  { name: "금화테크",          biz_no: "",              gubu: "A", type: "외주가공", service_type: "외주가공" },
  { name: "세원에스엔피",      biz_no: "",              gubu: "A", type: "외주가공", service_type: "외주가공" },
  { name: "태인",              biz_no: "",              gubu: "A", type: "외주가공", service_type: "외주가공" },
  { name: "금보산업",          biz_no: "",              gubu: "A", type: "외주가공", service_type: "외주가공" },
  { name: "대성산업",          biz_no: "",              gubu: "A", type: "외주가공", service_type: "외주가공" },
  { name: "동국기업",          biz_no: "",              gubu: "A", type: "외주가공", service_type: "외주가공" },
  { name: "제이와이물류",      biz_no: "",              gubu: "A", type: "운반",     service_type: "운반" },
  { name: "흥성철강",          biz_no: "",              gubu: "A", type: "원자재",   service_type: "자재공급" },
  { name: "한우리급식(주)",    biz_no: "606-86-52066",  gubu: "A", type: "급식",     service_type: "급식" },
  { name: "임대인 박OO",       biz_no: "",              gubu: "A", type: "임차",     service_type: "임차" },
  // 기관 (gubu: E)
  { name: "국민건강보험공단",  biz_no: "",              gubu: "E", type: "기관",     service_type: "4대보험" },
  { name: "한국전력공사",      biz_no: "",              gubu: "E", type: "기관",     service_type: "전기" },
  { name: "세무법인부성",      biz_no: "",              gubu: "E", type: "기관",     service_type: "세무" },
  { name: "경남에너지",        biz_no: "",              gubu: "E", type: "기관",     service_type: "가스" },
  { name: "진례기숙사(이정화)",biz_no: "",              gubu: "E", type: "임차",     service_type: "임차" },
  { name: "한국산업안전공단",  biz_no: "",              gubu: "E", type: "기관",     service_type: "안전" },
]

// ─── 임직원 (21명) ────────────────────────────────────────────
export const SEED_EMPLOYEES = [
  // 내국인 관리직
  { name: "김원철", role: "대표이사", department: "경영", base_salary: 0, active: true },
  { name: "김구섭", role: "차장",     department: "관리", base_salary: 0, active: true },
  { name: "백정숙", role: "차장",     department: "관리", base_salary: 0, active: true },
  { name: "임효진", role: "경리",     department: "관리", base_salary: 0, active: true },
  { name: "남혜윤", role: "—",        department: "—",    base_salary: 0, active: true },
  // 내국인 생산직
  { name: "문성욱", role: "팀장",     department: "생산", base_salary: 0, active: true },
  { name: "조승래", role: "생산직",   department: "생산", base_salary: 0, active: true },
  { name: "신훈범", role: "생산직",   department: "생산", base_salary: 0, active: true },
  { name: "신영범", role: "생산직",   department: "생산", base_salary: 0, active: true },
  // 외국인 근로자
  { name: "뚜에",   role: "생산직",   department: "생산", base_salary: 0, active: true },
  { name: "부디",   role: "생산직",   department: "생산", base_salary: 0, active: true },
  { name: "아데",   role: "생산직",   department: "생산", base_salary: 0, active: true },
  { name: "이완",   role: "생산직",   department: "생산", base_salary: 0, active: true },
  { name: "투안",   role: "생산직",   department: "생산", base_salary: 0, active: true },
  { name: "키엔",   role: "생산직",   department: "생산", base_salary: 0, active: true },
  { name: "CNC",    role: "생산직",   department: "생산", base_salary: 0, active: true },
]

// ─── 정기 지출 (12건) — vendor_id는 시딩 후 실제 UUID로 교체 필요 ──
export const SEED_RECURRING_EXPENSES = [
  // 인건비 (급여는 실제 payroll 마감 흐름을 따름 — 여기서는 포함 안 함)
  { vendor_name: "한우리급식(주)",    category: "복리후생비(생산)", amount:  3500000, period: "monthly",   day_of_month: 10, start_date: "2026-01-01" },
  { vendor_name: "국민건강보험공단",  category: "복리후생비(생산)", amount:  3450000, period: "monthly",   day_of_month: 10, start_date: "2026-01-01" },
  { vendor_name: "국민건강보험공단",  category: "복리후생비(관리)", amount:  1150000, period: "monthly",   day_of_month: 10, start_date: "2026-01-01" },
  { vendor_name: "한국전력공사",      category: "전력비",          amount:  3200000, period: "monthly",   day_of_month:  5, start_date: "2026-01-01" },
  { vendor_name: "임대인 박OO",       category: "임차료",          amount:  3200000, period: "monthly",   day_of_month:  1, start_date: "2026-01-01" },
  { vendor_name: "세무법인부성",      category: "수수료",          amount:   517000, period: "monthly",   day_of_month: 10, start_date: "2026-01-01" },
  { vendor_name: "제이와이물류",      category: "운반비",          amount:   968000, period: "monthly",   day_of_month: 15, start_date: "2026-01-01" },
  { vendor_name: "진례기숙사(이정화)",category: "임차료",          amount:    50000, period: "monthly",   day_of_month:  1, start_date: "2026-01-01" },
  { vendor_name: "경남에너지",        category: "수도광열비",      amount:   155460, period: "monthly",   day_of_month: 25, start_date: "2026-01-01" },
  { vendor_name: "한국산업안전공단",  category: "안전관리비",      amount:   450000, period: "quarterly", day_of_month:  5, start_date: "2026-01-01", active: false },
]

// ─── 2026년 실적 요약 (홈 대시보드용 참고 수치) ───────────────
export const ANNUAL_TARGET_2026 = {
  orderTarget:    7248000000,  // 수주 목표
  salesTarget:    8040000000,  // 매출 목표
  orderActual:    1588249391,  // 5월 누계 수주 (달성률 21.9%)
  salesActual:    2727515960,  // 5월 누계 매출 (달성률 33.9%)
  backlog:        2445217001,  // 수주 잔량
}

// ─── 계정과목 코드표 (참고) ───────────────────────────────────
// 실제 categories 데이터는 src/lib/data.js CATEGORIES export 참조
// 주요 코드: EXP-101~106 인건비, EXP-201~204 재료비, EXP-301~306 외주가공비
//           EXP-601~610 운영비, EXP-901~904 세금·금융, INC-101~106 납품수익

/**
 * 시딩 순서:
 * 1. accounts  → SEED_ACCOUNTS
 * 2. vendors   → SEED_VENDORS  (순서 중요: recurring에서 참조)
 * 3. employees → SEED_EMPLOYEES
 * 4. recurring_expenses → SEED_RECURRING_EXPENSES (vendor_id 매핑 후)
 *
 * 2026년 외상매입현황 2,004건은 Excel에서 별도 일괄 업로드
 * 2025년 세금계산서 316건 (7~9월)도 별도 업로드
 */
