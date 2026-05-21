// F1: 계좌별 잔액 관리
export const ACCOUNTS_BALANCE = [
  {
    id: "acc-001",
    name: "기업은행 *123",
    type: "보통예금",
    bankName: "기업은행",
    initialBalance: 50000000,
    adjustments: [
      { id: "adj-001", date: "2026-05-01", amount: -500000, reason: "은행 수수료 수동 반영", by: "한경리" },
      { id: "adj-002", date: "2026-04-15", amount: 200000,  reason: "오입력 수정 (3월 이체 차액)", by: "한경리" },
    ],
  },
  {
    id: "acc-002",
    name: "신한은행 *456",
    type: "보통예금",
    bankName: "신한은행",
    initialBalance: 30000000,
    adjustments: [],
  },
  {
    id: "acc-003",
    name: "국민은행 *789",
    type: "보통예금",
    bankName: "국민은행",
    initialBalance: 12800000,
    adjustments: [],
  },
]

// F2: 청구서 (발행=미수금, 수취=미지급금)
export const INVOICES = [
  // 발행 청구서 (미수금)
  { id: "INV-2026-001", kind: "issued",   vendor: "한화에어로스페이스", contractId: "CT-2026-101", contract: "KF-21 동체 부품",       supplyAmount: 25818182, vatAmount: 2581818, totalAmount: 28400000, issuedAt: "2026-05-15", dueAt: "2026-05-20", status: "입금 예정", accountId: "acc-001", matches: [], memo: "KF-21 기성고 3차" },
  { id: "INV-2026-002", kind: "issued",   vendor: "LIG넥스원",          contractId: "CT-2026-088", contract: "유도무기 정밀가공 부품", supplyAmount: 16909091, vatAmount: 1690909, totalAmount: 18600000, issuedAt: "2026-05-10", dueAt: "2026-05-18", status: "일부 입금", accountId: "acc-002", matches: [{ txnId: "IN-0510", amount: 2200000, matchedAt: "2026-05-10" }], memo: "5월 납품분" },
  { id: "INV-2026-003", kind: "issued",   vendor: "현대로템",            contractId: "CT-2026-072", contract: "K2 변속기 케이스 가공",  supplyAmount:  8363636, vatAmount:  836364, totalAmount:  9200000, issuedAt: "2026-05-08", dueAt: "2026-05-27", status: "입금 완료", accountId: "acc-001", matches: [{ txnId: "IN-0509", amount: 9200000, matchedAt: "2026-05-09" }], memo: "검수 후 결제" },
  { id: "INV-2026-004", kind: "issued",   vendor: "KAI",                 contractId: "CT-2026-065", contract: "헬기 외장 패널 가공",    supplyAmount:  4090909, vatAmount:  409091, totalAmount:  4500000, issuedAt: "2026-05-12", dueAt: "2026-05-30", status: "입금 예정", accountId: "acc-002", matches: [], memo: "잔금" },
  { id: "INV-2026-005", kind: "issued",   vendor: "한화시스템",          contractId: "CT-2026-058", contract: "레이더 하우징 가공",     supplyAmount:  3454545, vatAmount:  345455, totalAmount:  3800000, issuedAt: "2026-05-01", dueAt: "2026-06-02", status: "입금 예정", accountId: "acc-001", matches: [], memo: "잔금" },
  { id: "INV-2026-006", kind: "issued",   vendor: "(주)동방산업",         contractId: null,          contract: "전차 궤도 부품 시제",    supplyAmount: 10727273, vatAmount: 1072727, totalAmount: 11800000, issuedAt: "2026-02-10", dueAt: "2026-02-18", status: "장기 미수", accountId: "acc-001", matches: [], memo: "재청구 필요" },
  { id: "INV-2026-007", kind: "issued",   vendor: "(주)대선기공",         contractId: "CT-2025-194", contract: "함정 추진계 정밀가공",   supplyAmount: 16545455, vatAmount: 1654545, totalAmount: 18200000, issuedAt: "2026-04-01", dueAt: "2026-04-25", status: "기한 지남", accountId: "acc-002", matches: [], memo: "" },
  { id: "INV-2026-008", kind: "issued",   vendor: "(주)서울항공",         contractId: "CT-2025-176", contract: "기체 패스너 가공",       supplyAmount:  7818182, vatAmount:  781818, totalAmount:  8600000, issuedAt: "2026-04-05", dueAt: "2026-04-30", status: "기한 지남", accountId: "acc-001", matches: [], memo: "" },
  // 수취 청구서 (미지급금)
  { id: "INV-2026-101", kind: "received", vendor: "(주)한울정밀",         contractId: "CT-2026-088", contract: "유도무기 정밀가공",      supplyAmount:  3818182, vatAmount:  381818, totalAmount:  4200000, issuedAt: "2026-05-10", dueAt: "2026-05-15", status: "지급 대기", accountId: "acc-001", matches: [], memo: "CNC 외주가공 5월분" },
  { id: "INV-2026-102", kind: "received", vendor: "한국기계연구원",        contractId: "CT-2026-072", contract: "K2 변속기 케이스",       supplyAmount:  1681818, vatAmount:  168182, totalAmount:  1850000, issuedAt: "2026-05-09", dueAt: "2026-05-18", status: "지급 예정", accountId: "acc-001", matches: [], memo: "" },
  { id: "INV-2026-103", kind: "received", vendor: "(주)대원특수강",        contractId: null,          contract: "공통(원자재)",           supplyAmount:  3454545, vatAmount:  345455, totalAmount:  3800000, issuedAt: "2026-05-08", dueAt: "2026-05-20", status: "지급 예정", accountId: "acc-001", matches: [], memo: "" },
  { id: "INV-2026-104", kind: "received", vendor: "임대인 박OO",           contractId: null,          contract: "공통",                   supplyAmount:  2909091, vatAmount:  290909, totalAmount:  3200000, issuedAt: "2026-05-01", dueAt: "2026-05-12", status: "기한 지남", accountId: "acc-001", matches: [], memo: "5월 공장 임차" },
  { id: "INV-2026-105", kind: "received", vendor: "다이아공구",            contractId: null,          contract: "공통(생산소모)",         supplyAmount:   563636, vatAmount:   56364, totalAmount:   620000, issuedAt: "2026-05-07", dueAt: "2026-05-22", status: "지급 대기", accountId: "acc-001", matches: [], memo: "" },
  { id: "INV-2026-106", kind: "received", vendor: "(주)동아표면처리",       contractId: "CT-2026-065", contract: "헬기 외장 패널",         supplyAmount:  3545455, vatAmount:  354545, totalAmount:  3900000, issuedAt: "2026-05-02", dueAt: "2026-05-02", status: "기한 지남", accountId: "acc-001", matches: [], memo: "" },
]

// F4: 정기 지출
export const RECURRING_EXPENSES = [
  { id: "rec-001", vendor: "임대인 박OO",   contract: "공통",          category: "임차료",   amount: 3200000, period: "monthly",   dayOfMonth: 1,  startDate: "2026-01-01", endDate: null, accountId: "acc-001", active: true,  lastGenerated: "2026-05-01" },
  { id: "rec-002", vendor: "KT",            contract: "공통",          category: "통신비",   amount: 185000,  period: "monthly",   dayOfMonth: 25, startDate: "2026-01-01", endDate: null, accountId: "acc-001", active: true,  lastGenerated: "2026-04-25" },
  { id: "rec-003", vendor: "한전",          contract: "공통",          category: "전력비",   amount: 420000,  period: "monthly",   dayOfMonth: 15, startDate: "2026-01-01", endDate: null, accountId: "acc-001", active: true,  lastGenerated: "2026-05-15" },
  { id: "rec-004", vendor: "국민건강보험공단외", contract: "공통(인건비)", category: "4대보험", amount: 3120000, period: "monthly",   dayOfMonth: 10, startDate: "2026-01-01", endDate: null, accountId: "acc-001", active: true,  lastGenerated: "2026-05-10" },
  { id: "rec-005", vendor: "한국산업안전공단", contract: "공통",        category: "안전관리비", amount: 450000, period: "quarterly", dayOfMonth: 5,  startDate: "2026-01-01", endDate: null, accountId: "acc-001", active: false, lastGenerated: "2026-04-05" },
]

// Raw todo data — icons/colors are client-side concerns, not DB fields.
// Real DB: SELECT * FROM todos WHERE status='pending' AND assignee=:userId AND date=TODAY()
export const TODOS_RAW = [
  { id: 1, kind: "ar",       tag: "입금 처리",   title: "한화에어로스페이스 기성고 입금 확인",     sub: "KF-21 동체 부품 · 24,800,000원",          action: "처리" },
  { id: 2, kind: "ar",       tag: "입금 처리",   title: "LIG넥스원 납품대금 입금 확인",            sub: "유도무기 정밀가공 · 18,600,000원",         action: "처리" },
  { id: 3, kind: "doc",      tag: "결의서 승인", title: "외주가공비 — (주)한울정밀",               sub: "EXP-2026-0229 · 4,200,000원",             action: "승인" },
  { id: 4, kind: "evidence", tag: "증빙 첨부",   title: "다이아공구 공구비 영수증",                 sub: "OUT-0510-A · 620,000원",                   action: "첨부" },
  { id: 5, kind: "evidence", tag: "증빙 첨부",   title: "방산전시회 출장비 영수증",                  sub: "OUT-0507-A · 340,000원",                   action: "첨부" },
  { id: 6, kind: "ap",       tag: "지급 지연",   title: "(주)동아표면처리 외주가공비 이체",         sub: "헬기 외장 패널 · 3,900,000원 · 11일 지연", action: "이체" },
];

export const SAMPLE = {
  topStats: [
    { id: "ar",  label: "미수금",          help: "납품 후 입금되지 않은 금액입니다.",         amount: 87400000, sub: "입금 대기 6건", delta: 6,   accent: "blue" },
    { id: "ap",  label: "미지급금",        help: "외주가공·원자재 결제가 남은 금액입니다.",   amount: 32800000, sub: "지급 대기 9건", delta: -8,  accent: "warn" },
    { id: "iex", label: "이번 달 입금 예정", help: "이번 달 납품 마감일 기준 회수 예정입니다.", amount: 64500000, sub: "예정 8건",      delta: 11,  accent: "pos" },
    { id: "oex", label: "이번 달 지급 예정", help: "이번 달 결제일이 도래한 비용입니다.",       amount: 28600000, sub: "예정 7건",      delta: -4,  accent: "neg" },
  ],

  alerts: [
    { kind: "neg",  title: "연체 미수금",      count: 2, desc: "발주처 결제 기한이 지난 납품 건이 있습니다.",            to: "ar" },
    { kind: "warn", title: "검사성적서 누락",  count: 3, desc: "납품 건의 시험성적서·검사성적서가 등록되지 않았습니다.", to: "evidence" },
    { kind: "warn", title: "승인 대기 결의서", count: 4, desc: "외주가공·원자재 결의서가 결재선에 있습니다.",           to: "doc" },
    { kind: "neg",  title: "지급 지연 외주비", count: 1, desc: "협력사 외주가공비 지급일이 경과했습니다.",                to: "ap" },
  ],

  upcomingIn: [
    { vendor: "한화에어로스페이스", contract: "KF-21 동체 부품 1차분",  type: "납품대금",    amount: 28400000, due: "2026-05-22" },
    { vendor: "LIG넥스원",          contract: "유도무기 정밀가공 부품", type: "기성고",      amount: 18600000, due: "2026-05-24" },
    { vendor: "현대로템",           contract: "K2 변속기 케이스 가공",  type: "검수 후 결제", amount:  9200000, due: "2026-05-27" },
    { vendor: "KAI",                contract: "헬기 외장 패널 가공",   type: "납품대금",    amount:  4500000, due: "2026-05-30" },
    { vendor: "한화시스템",         contract: "레이더 하우징 가공",    type: "잔금",        amount:  3800000, due: "2026-06-02" },
  ],

  upcomingOut: [
    { vendor: "정밀도금 (주)",      note: "표면처리 외주",     amount:  6800000, due: "2026-05-21" },
    { vendor: "포스코강판",         note: "스테인리스 원자재", amount: 12400000, due: "2026-05-23" },
    { vendor: "임직원 7명",         note: "5월 급여 일괄이체", amount: 37530000, due: "2026-05-25" },
    { vendor: "(주)한울정밀",       note: "CNC 외주가공",      amount:  4200000, due: "2026-05-26" },
    { vendor: "한국기계연구원",     note: "시험성적서 발급",   amount:  1850000, due: "2026-05-29" },
    { vendor: "임대인 박OO",        note: "공장 임차료",       amount:  3200000, due: "2026-05-31" },
  ],

  contractSummary: [
    { name: "KF-21 동체 부품 (한화에어로스페이스)",  buyer: "한화에어로스페이스", contractNo: "CT-2026-101", amount: 142000000, inDone: 113600000, out: 38500000, profit: 75100000, status: "진행중",
      items: [
        { no: "DJT-2026-001", name: "동체 프레임 브래킷",  qty: 24, unit: "EA", unitPrice: 2800000, total: 67200000 },
        { no: "DJT-2026-002", name: "주익 연결 핀 어셈블리", qty: 48, unit: "EA", unitPrice: 780000,  total: 37440000 },
        { no: "DJT-2026-003", name: "동체 격벽 패널",       qty: 12, unit: "EA", unitPrice: 3110000, total: 37360000 },
      ] },
    { name: "유도무기 정밀가공 부품 (LIG넥스원)",     buyer: "LIG넥스원",         contractNo: "CT-2026-102", amount:  96000000, inDone:  77400000, out: 28200000, profit: 49200000, status: "진행중",
      items: [
        { no: "DJT-2026-004", name: "유도탄 노즐 하우징",  qty: 60, unit: "EA", unitPrice: 920000,  total: 55200000 },
        { no: "DJT-2026-005", name: "핀 안정화 장치 부품", qty: 80, unit: "EA", unitPrice: 510000,  total: 40800000 },
      ] },
    { name: "K2 변속기 케이스 가공 (현대로템)",       buyer: "현대로템",           contractNo: "CT-2026-103", amount:  48000000, inDone:  38800000, out: 12100000, profit: 26700000, status: "진행중",
      items: [
        { no: "DJT-2026-006", name: "변속기 케이스 본체",  qty:  8, unit: "EA", unitPrice: 4200000, total: 33600000 },
        { no: "DJT-2026-007", name: "오일 씰 브래킷",      qty: 16, unit: "EA", unitPrice: 900000,  total: 14400000 },
      ] },
    { name: "헬기 외장 패널 가공 (KAI)",              buyer: "KAI",                contractNo: "CT-2026-104", amount:  22500000, inDone:  18000000, out:  6400000, profit: 11600000, status: "진행중",
      items: [
        { no: "DJT-2026-008", name: "헬기 외장 복합패널",  qty: 15, unit: "EA", unitPrice: 1500000, total: 22500000 },
      ] },
    { name: "레이더 하우징 가공 (한화시스템)",         buyer: "한화시스템",         contractNo: "CT-2026-105", amount:  18200000, inDone:  14400000, out:  4900000, profit:  9500000, status: "진행중",
      items: [
        { no: "DJT-2026-009", name: "레이더 안테나 하우징", qty: 7, unit: "EA", unitPrice: 1800000, total: 12600000 },
        { no: "DJT-2026-010", name: "냉각 채널 커버",       qty: 7, unit: "EA", unitPrice: 800000,  total:  5600000 },
      ] },
  ],

  incomes: [
    { date: "2026-05-12", vendor: "한화에어로스페이스", contract: "KF-21 동체 부품",       type: "기성고",      amount: 24800000, account: "기업은행 *123", status: "입금 완료", evid: true,  memo: "1차분 납품" },
    { date: "2026-05-10", vendor: "LIG넥스원",          contract: "유도무기 정밀가공 부품", type: "납품대금",    amount: 18600000, account: "신한은행 *456", status: "입금 완료", evid: true,  memo: "" },
    { date: "2026-05-09", vendor: "현대로템",           contract: "K2 변속기 케이스 가공",  type: "검수 후 결제", amount:  9200000, account: "기업은행 *123", status: "입금 완료", evid: true,  memo: "" },
    { date: "2026-05-08", vendor: "한화시스템",         contract: "레이더 하우징 가공",    type: "선급금",      amount:  3600000, account: "신한은행 *456", status: "입금 완료", evid: true,  memo: "" },
    { date: "2026-05-20", vendor: "KAI",                contract: "헬기 외장 패널 가공",   type: "잔금",        amount:  4500000, account: "신한은행 *456", status: "입금 예정", evid: false, memo: "검수 완료 후" },
    { date: "2026-05-22", vendor: "풍산",                contract: "탄피 황동 가공 시제품", type: "1차분",       amount:  2200000, account: "기업은행 *123", status: "일부 입금", evid: true,  memo: "전체 4,000,000원 중" },
    { date: "2026-04-25", vendor: "한국과학기술원",     contract: "(계약 없음)",            type: "용역수익",    amount:   800000, account: "기업은행 *123", status: "입금 완료", evid: true,  memo: "산학협력" },
    { date: "2026-03-18", vendor: "(주)동방산업",        contract: "전차 궤도 부품 시제",    type: "납품대금",    amount: 11800000, account: "기업은행 *123", status: "장기 미수", evid: false, memo: "재청구 필요" },
  ],

  expenses: [
    { date: "2026-05-12", vendor: "정밀도금 (주)",   scope: "KF-21 동체 부품",       category: "외주가공비", amount:  6800000, method: "계좌이체", evid: true,  doc: "승인 완료", pay: "지급 완료" },
    { date: "2026-05-11", vendor: "포스코강판",       scope: "공통(원자재)",         category: "재료비",    amount: 12400000, method: "계좌이체", evid: true,  doc: "승인 완료", pay: "지급 완료" },
    { date: "2026-05-10", vendor: "(주)한울정밀",     scope: "유도무기 정밀가공",    category: "외주가공비", amount:  4200000, method: "계좌이체", evid: true,  doc: "승인 요청", pay: "지급 대기" },
    { date: "2026-05-09", vendor: "한국기계연구원",   scope: "K2 변속기 케이스",     category: "시험검사비", amount:  1850000, method: "계좌이체", evid: true,  doc: "승인 완료", pay: "지급 예정" },
    { date: "2026-05-08", vendor: "(주)대원특수강",   scope: "공통(원자재)",         category: "재료비",    amount:  3800000, method: "계좌이체", evid: true,  doc: "승인 완료", pay: "지급 예정" },
    { date: "2026-05-07", vendor: "다이아공구",       scope: "공통(생산소모)",       category: "공구비",    amount:   620000, method: "법인카드", evid: false, doc: "작성중",   pay: "지급 대기" },
    { date: "2026-05-05", vendor: "임대인 박OO",      scope: "공통",                category: "임차료",    amount:  3200000, method: "계좌이체", evid: true,  doc: "승인 완료", pay: "지급 예정" },
    { date: "2026-05-02", vendor: "한국산업안전공단", scope: "공통",                category: "안전관리비", amount:   450000, method: "계좌이체", evid: true,  doc: "승인 완료", pay: "지급 완료" },
    { date: "2026-05-25", vendor: "임직원 (7명)",     scope: "공통(인건비)",        category: "인건비",    amount: 37530000, method: "계좌이체", evid: true,  doc: "승인 완료", pay: "지급 예정" },
    { date: "2026-05-10", vendor: "국민건강보험공단 외", scope: "공통(인건비)",     category: "4대보험(회사)", amount: 3120000, method: "계좌이체", evid: true, doc: "승인 완료", pay: "지급 완료" },
  ],

  receivables: {
    summary: { total: 87400000, thisMonth: 32800000, overdue: 18200000, longOverdue: 11800000 },
    rows: [
      { vendor: "한화에어로스페이스", contract: "KF-21 동체 부품",       billed: 28400000, paid:       0, remain: 28400000, due: "2026-05-20", delay: 0,  status: "입금 예정" },
      { vendor: "LIG넥스원",          contract: "유도무기 정밀가공 부품", billed: 18600000, paid:       0, remain: 18600000, due: "2026-05-18", delay: 0,  status: "청구 예정" },
      { vendor: "풍산",                contract: "탄피 황동 가공 시제품", billed:  4000000, paid: 2200000, remain:  1800000, due: "2026-05-30", delay: 0,  status: "일부 입금" },
      { vendor: "(주)대선기공",        contract: "함정 추진계 가공",      billed: 18200000, paid:       0, remain: 18200000, due: "2026-04-25", delay: 18, status: "기한 지남" },
      { vendor: "(주)서울항공",        contract: "기체 패스너 가공",      billed:  8600000, paid:       0, remain:  8600000, due: "2026-04-30", delay: 13, status: "기한 지남" },
      { vendor: "(주)동방산업",        contract: "전차 궤도 부품 시제",    billed: 14000000, paid: 2200000, remain: 11800000, due: "2026-02-18", delay: 84, status: "장기 미수" },
    ],
  },

  payables: {
    summary: { total: 32800000, thisMonth: 18600000, overdue: 6900000, pendingApproval: 4200000 },
    rows: [
      { vendor: "(주)한울정밀",       scope: "유도무기 정밀가공",  category: "외주가공비", amount: 4200000, due: "2026-05-15", doc: "승인 요청", pay: "지급 대기" },
      { vendor: "한국기계연구원",     scope: "K2 변속기 케이스",   category: "시험검사비", amount: 1850000, due: "2026-05-18", doc: "승인 완료", pay: "지급 예정" },
      { vendor: "(주)대원특수강",     scope: "공통(원자재)",      category: "재료비",    amount: 3800000, due: "2026-05-20", doc: "승인 완료", pay: "지급 예정" },
      { vendor: "임대인 박OO",        scope: "공통",              category: "임차료",    amount: 3200000, due: "2026-05-12", doc: "승인 완료", pay: "지급 예정" },
      { vendor: "다이아공구",         scope: "공통(생산소모)",    category: "공구비",    amount:  620000, due: "2026-05-22", doc: "작성중",   pay: "지급 대기" },
      { vendor: "프리랜서 설계 박OO", scope: "KF-21 동체 부품",   category: "설계용역비", amount: 2400000, due: "2026-05-25", doc: "승인 완료", pay: "지급 예정" },
      { vendor: "(주)동아표면처리",   scope: "헬기 외장 패널",    category: "외주가공비", amount: 3900000, due: "2026-05-02", doc: "승인 완료", pay: "기한 지남" },
      { vendor: "한국화학연구원",     scope: "재질 분석",         category: "시험검사비", amount: 3000000, due: "2026-05-08", doc: "승인 완료", pay: "기한 지남" },
      { vendor: "운송 (주)신영로지스", scope: "공통",              category: "운반비",    amount:  920000, due: "2026-05-28", doc: "승인 완료", pay: "지급 예정" },
    ],
  },

  contractDetail: {
    name:    "KF-21 동체 부품 가공",
    vendor:  "한화에어로스페이스",
    code:    "CT-2026-101",
    period:  "2026-01-15 ~ 2026-08-31",
    pm:      "정수민",
    status:  "진행중",
    amount:  142000000,
    inDone:  113600000,
    remain:   28400000,
    out:      38500000,
    profit:   75100000,
    incomes: [
      { date: "2026-01-30", type: "선급금", amount: 28400000, status: "입금 완료", evid: true },
      { date: "2026-03-15", type: "기성고", amount: 42600000, status: "입금 완료", evid: true },
      { date: "2026-04-20", type: "기성고", amount: 42600000, status: "입금 완료", evid: true },
      { date: "2026-05-20", type: "잔금",   amount: 28400000, status: "입금 예정", evid: false },
    ],
    expenses: [
      { date: "2026-02-10", vendor: "포스코강판",   category: "재료비",    amount: 18200000, doc: "승인 완료", pay: "지급 완료" },
      { date: "2026-03-22", vendor: "(주)한울정밀", category: "외주가공비", amount:  9400000, doc: "승인 완료", pay: "지급 완료" },
      { date: "2026-04-18", vendor: "정밀도금 (주)", category: "외주가공비", amount:  6800000, doc: "승인 완료", pay: "지급 완료" },
      { date: "2026-05-12", vendor: "정밀도금 (주)", category: "외주가공비", amount:  4100000, doc: "승인 완료", pay: "지급 예정" },
    ],
    docs: [
      { id: "EXP-2026-0231", title: "외주가공비 — 정밀도금 (주)", date: "2026-05-12", amount:  4100000, status: "승인 완료" },
      { id: "EXP-2026-0218", title: "재료비 — 포스코강판",         date: "2026-02-10", amount: 18200000, status: "승인 완료" },
    ],
    evidences: [
      { name: "발주서_한화에어로스페이스_KF-21_1차.pdf", type: "발주서",     size: "126KB", date: "2026-01-15" },
      { name: "세금계산서_한화_선급금.pdf",               type: "세금계산서", size: "82KB",  date: "2026-01-30" },
      { name: "시험성적서_기계연_3차.pdf",                type: "시험성적서", size: "1.2MB", date: "2026-04-18" },
      { name: "검사성적서_초도검사.pdf",                  type: "검사성적서", size: "612KB", date: "2026-04-25" },
      { name: "거래명세서_정밀도금_5월.pdf",              type: "거래명세서", size: "94KB",  date: "2026-05-12" },
    ],
    history: [
      { date: "2026-05-12", who: "한경리", what: "지출결의서 EXP-2026-0231 (정밀도금 외주비) 승인 완료" },
      { date: "2026-04-25", who: "정수민", what: "초도검사 합격 · 검사성적서 등록" },
      { date: "2026-04-20", who: "한경리", what: "기성고 42,600,000원 입금 등록" },
      { date: "2026-03-15", who: "한경리", what: "기성고 42,600,000원 입금 등록" },
      { date: "2026-01-15", who: "정수민", what: "계약 등록 · 발주서 #PO-KF21-2026-01 첨부" },
    ],
  },

  docs: [
    { id: "EXP-2026-0231", date: "2026-05-12", title: "외주가공비 — 정밀도금 (주)",   vendor: "정밀도금 (주)",    contract: "KF-21 동체 부품",   amount:  6800000, status: "승인 완료", writer: "한경리" },
    { id: "EXP-2026-0230", date: "2026-05-11", title: "재료비 — 포스코강판",           vendor: "포스코강판",        contract: "공통(원자재)",      amount: 12400000, status: "승인 완료", writer: "한경리" },
    { id: "EXP-2026-0229", date: "2026-05-10", title: "외주가공비 — (주)한울정밀",     vendor: "(주)한울정밀",      contract: "유도무기 정밀가공", amount:  4200000, status: "승인 요청", writer: "한경리" },
    { id: "EXP-2026-0228", date: "2026-05-09", title: "시험검사비 — 한국기계연구원",   vendor: "한국기계연구원",    contract: "K2 변속기 케이스",  amount:  1850000, status: "승인 완료", writer: "한경리" },
    { id: "EXP-2026-0227", date: "2026-05-07", title: "공구비 — 다이아공구",           vendor: "다이아공구",        contract: "공통(생산소모)",    amount:   620000, status: "작성중",   writer: "한경리" },
    { id: "EXP-2026-0226", date: "2026-05-05", title: "임차료 — 임대인 박OO",          vendor: "임대인 박OO",        contract: "공통",              amount:  3200000, status: "승인 완료", writer: "한경리" },
    { id: "EXP-2026-0225", date: "2026-05-04", title: "안전관리비 — 한국산업안전공단", vendor: "한국산업안전공단",  contract: "공통",              amount:   450000, status: "반려",     writer: "한경리" },
    { id: "EXP-2026-0224", date: "2026-05-02", title: "설계용역비 — 프리랜서 박OO",    vendor: "프리랜서 박OO",     contract: "KF-21 동체 부품",   amount:  2400000, status: "승인 완료", writer: "한경리" },
  ],

  evidences: [
    { name: "발주서_한화에어로스페이스_KF-21_1차.pdf", type: "발주서",     size: "126KB", date: "2026-01-15", linked: "계약 CT-2026-101", contract: "KF-21 동체 부품",   status: "연결 완료" },
    { name: "세금계산서_한화_선급금.pdf",               type: "세금계산서", size: "82KB",  date: "2026-01-30", linked: "입금 #IN-0130",     contract: "KF-21 동체 부품",   status: "연결 완료" },
    { name: "검사성적서_초도검사.pdf",                  type: "검사성적서", size: "612KB", date: "2026-04-25", linked: "납품 #DLV-0425",    contract: "KF-21 동체 부품",   status: "연결 완료" },
    { name: "시험성적서_기계연_3차.pdf",                type: "시험성적서", size: "1.2MB", date: "2026-04-18", linked: "지출 #OUT-0418",    contract: "K2 변속기 케이스", status: "연결 완료" },
    { name: "거래명세서_정밀도금_5월.pdf",              type: "거래명세서", size: "94KB",  date: "2026-05-12", linked: "지출 #OUT-0512",    contract: "KF-21 동체 부품",   status: "연결 완료" },
    { name: "납품확인서_LIG_5월.pdf",                    type: "납품확인서", size: "118KB", date: "2026-05-10", linked: "입금 #IN-0510",     contract: "유도무기 정밀가공", status: "연결 완료" },
    { name: "다이아공구_영수증_0507.jpg",                type: "영수증",     size: "488KB", date: "2026-05-07", linked: "—",                 contract: "—",                status: "연결 필요" },
    { name: "통장사본_2026-04.pdf",                       type: "통장내역",   size: "1.1MB", date: "2026-05-01", linked: "—",                 contract: "—",                status: "검토 필요" },
    { name: "출장영수증_방산전시회_0506.jpg",            type: "영수증",     size: "302KB", date: "2026-05-06", linked: "—",                 contract: "—",                status: "누락" },
  ],

  evidenceMissing: [
    { id: "OUT-0510-A", title: "공구비 — 다이아공구 (드릴비트)", amount:  620000, date: "2026-05-10" },
    { id: "OUT-0507-A", title: "방산전시회 출장비 — 부산",        amount:  340000, date: "2026-05-07" },
    { id: "OUT-0428-A", title: "측정공구 — 마이크로미터",          amount:  185000, date: "2026-04-28" },
    { id: "OUT-0421-A", title: "식대 — 협력사 미팅 (정밀도금)",    amount:   95000, date: "2026-04-21" },
  ],

  excelPreview: [
    { ok: true,  row: 2, date: "2026-05-02", vendor: "포스코강판",         contract: "공통(원자재)",       type: "지출", category: "재료비",    amount: 12400000, memo: "5월 발주" },
    { ok: true,  row: 3, date: "2026-05-05", vendor: "임대인 박OO",         contract: "공통",               type: "지출", category: "임차료",    amount:  3200000, memo: "5월 공장 임차" },
    { ok: false, row: 4, date: "",           vendor: "정밀도금 (주)",        contract: "KF-21 동체 부품",     type: "지출", category: "외주가공비", amount:  6800000, memo: "5월 표면처리", err: "날짜 없음" },
    { ok: true,  row: 5, date: "2026-05-08", vendor: "(주)대원특수강",      contract: "공통(원자재)",       type: "지출", category: "재료비",    amount:  3800000, memo: "" },
    { ok: false, row: 6, date: "2026-05-09", vendor: "한국기계연구원",      contract: "K2 변속기 케이스",   type: "지출", category: "시험분석비", amount:  1850000, memo: "", err: "비목 미등록 (→ 시험검사비?)" },
    { ok: true,  row: 7, date: "2026-05-10", vendor: "한화에어로스페이스", contract: "KF-21 동체 부품",     type: "입금", category: "기성고",    amount: 24800000, memo: "1차분" },
    { ok: false, row: 8, date: "2026-05-11", vendor: "다이아공구",          contract: "공통(생산소모)",     type: "지출", category: "공구비",    amount: 0,        memo: "", err: "금액 없음" },
    { ok: true,  row: 9, date: "2026-05-12", vendor: "LIG넥스원",           contract: "유도무기 정밀가공",   type: "입금", category: "납품대금", amount: 18600000, memo: "5월 납품" },
  ],
};
