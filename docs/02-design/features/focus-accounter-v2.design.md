# focus-accounter v2 설계 문서

> **Summary**: 6개 회계 기능 영역의 데이터 구조·화면 레이아웃·컴포넌트 설계
>
> **Project**: 동진테크 회계관리 ERP (focus-accounter)
> **Author**: Chajuick
> **Date**: 2026-05-20
> **Status**: Draft
> **Plan Doc**: [focus-accounter-v2.plan.md](../01-plan/features/focus-accounter-v2.plan.md)

---

## 1. 설계 원칙

- 기존 `src/lib/ui.jsx` 컴포넌트(Icon, StatusBadge, useToast 등)를 최대한 재사용
- 기존 화면 구조(hash 라우팅, Drawer 패턴)와 일관성 유지
- 각 기능은 독립 파일 또는 독립 탭으로 분리하여 향후 실제 API 연동 시 교체 최소화
- 데이터는 `src/lib/data.js`에 집중, 로직은 `src/lib/api.js`에 집중

---

## 2. 전체 아키텍처 변경

### 2.1 네비게이션 변경

```
현재                          v2
─────────────────────         ─────────────────────
홈         (#home)            홈         (#home)
거래내역   (#ledger)           거래내역   (#ledger)
계약       (#contract)  →     청구 관리  (#billing)     ← 신규
인사관리   (#hr)               계약       (#contract)
보고서     (#report)           인사관리   (#hr)
설정       (#master)           보고서     (#report)
                               설정       (#master)
```

### 2.2 수정 파일 목록

| 파일 | 변경 유형 | 관련 기능 |
|------|---------|---------|
| `src/lib/data.js` | 수정 | 전체 (데이터 구조 추가) |
| `src/lib/api.js` | 수정 | 전체 (mock 엔드포인트 추가) |
| `src/App.jsx` | 수정 | 네비게이션 + 라우팅 |
| `src/screens/Billing.jsx` | **신규** | F2 청구 관리 |
| `src/screens/Master.jsx` | 수정 | F1 계좌잔액, F4 정기지출 |
| `src/screens/Contract.jsx` | 수정 | F5 마일스톤, F6 원가예산 |
| `src/screens/Docs.jsx` | 수정 | F3 부가세 (ReportsScreen 탭) |
| `src/screens/Home.jsx` | 수정 | 계좌잔액·미수금 연동 |

---

## 3. 데이터 모델 설계

### 3.1 F1 — 계좌 잔액 (`ACCOUNTS_BALANCE`)

```js
// src/lib/data.js에 추가
export const ACCOUNTS_BALANCE = [
  {
    id: "acc-001",
    name: "기업은행 *123",
    type: "보통예금",
    initialBalance: 50000000,   // 수동 설정 초기잔액
    adjustments: [
      {
        id: "adj-001",
        date: "2026-05-01",
        amount: -500000,          // 음수 = 차감, 양수 = 추가
        reason: "은행 수수료 수동 반영",
        by: "한경리"
      }
    ]
    // 현재잔액 = initialBalance + Σ(입금 거래) - Σ(출금 거래) + Σ(조정)
    // → api.js에서 계산
  },
  {
    id: "acc-002",
    name: "신한은행 *456",
    type: "보통예금",
    initialBalance: 30000000,
    adjustments: []
  }
]
```

**잔액 계산 로직 (api.js)**:
```js
api.getAccountBalance(accountId) {
  const account = ACCOUNTS_BALANCE.find(a => a.id === accountId)
  const incomeTotal = INVOICES
    .filter(inv => inv.kind === "issued" && inv.accountId === accountId)
    .flatMap(inv => inv.matches)
    .reduce((sum, m) => sum + m.amount, 0)
  const expenseTotal = SAMPLE.expenses
    .filter(e => e.accountId === accountId && e.pay === "지급 완료")
    .reduce((sum, e) => sum + e.amount, 0)
  const adjustTotal = account.adjustments
    .reduce((sum, a) => sum + a.amount, 0)
  return account.initialBalance + incomeTotal - expenseTotal + adjustTotal
}
```

---

### 3.2 F2 — 청구서 (`INVOICES`)

```js
export const INVOICES = [
  {
    id: "INV-2026-001",
    kind: "issued",               // "issued" = 발행(미수금), "received" = 수취(미지급금)
    vendor: "한화에어로스페이스",
    contractId: "CT-2026-101",
    contract: "KF-21 동체 부품",
    supplyAmount: 25818182,       // 공급가액
    vatAmount: 2581818,           // 부가세
    totalAmount: 28400000,        // 합계
    issuedAt: "2026-05-15",
    dueAt: "2026-05-20",
    status: "입금 예정",           // "입금 예정" | "일부 입금" | "입금 완료" | "기한 지남" | "장기 미수"
    accountId: "acc-001",         // 입금받을 계좌
    matches: [                    // 실제 입금 거래 연결
      // { txnId: "IN-0512", amount: 28400000, matchedAt: "2026-05-12" }
    ],
    memo: "KF-21 기성고 3차"
  },
  {
    id: "INV-2026-010",
    kind: "received",             // 수취 = 협력사로부터 받은 청구서 (미지급금)
    vendor: "(주)한울정밀",
    contractId: null,
    contract: "유도무기 정밀가공",
    supplyAmount: 3818182,
    vatAmount: 381818,
    totalAmount: 4200000,
    issuedAt: "2026-05-10",
    dueAt: "2026-05-15",
    status: "지급 대기",           // "지급 대기" | "일부 지급" | "지급 완료" | "기한 지남"
    accountId: "acc-001",
    matches: [],
    memo: "CNC 외주가공 5월분"
  }
]
```

**미수금/미지급금 산출 (api.js)**:
```js
api.getReceivables() {
  return INVOICES
    .filter(inv => inv.kind === "issued" && inv.status !== "입금 완료")
    .map(inv => ({
      ...inv,
      paidAmount: inv.matches.reduce((s, m) => s + m.amount, 0),
      remainAmount: inv.totalAmount - inv.matches.reduce((s, m) => s + m.amount, 0)
    }))
}

api.getPayables() {
  return INVOICES
    .filter(inv => inv.kind === "received" && inv.status !== "지급 완료")
    .map(inv => ({ ...inv, remainAmount: inv.totalAmount - ... }))
}
```

---

### 3.3 F3 — 부가세 (기존 INVOICES에서 집계)

별도 데이터 구조 없이 INVOICES에서 집계:

```js
api.getVatSummary(quarter) {
  // quarter: "Q1" | "Q2" | "Q3" | "Q4"
  const qRange = { Q1: ["01","02","03"], Q2: ["04","05","06"], ... }[quarter]

  const salesVat = INVOICES
    .filter(inv => inv.kind === "issued" && qRange.includes(inv.issuedAt.slice(5,7)))
    .reduce((sum, inv) => sum + inv.vatAmount, 0)

  const purchaseVat = INVOICES
    .filter(inv => inv.kind === "received" && qRange.includes(inv.issuedAt.slice(5,7)))
    .reduce((sum, inv) => sum + inv.vatAmount, 0)

  return { salesVat, purchaseVat, netVat: salesVat - purchaseVat }
}
```

---

### 3.4 F4 — 정기 지출 (`RECURRING_EXPENSES`)

```js
export const RECURRING_EXPENSES = [
  {
    id: "rec-001",
    vendor: "임대인 박OO",
    contract: "공통",
    category: "임차료",
    amount: 3200000,
    period: "monthly",            // "monthly" | "quarterly" | "yearly"
    dayOfMonth: 1,                // 매월 1일 생성
    startDate: "2026-01-01",
    endDate: null,                // null = 무기한
    accountId: "acc-001",
    active: true,
    lastGenerated: "2026-05-01"   // 마지막 자동 생성일
  },
  {
    id: "rec-002",
    vendor: "KT",
    contract: "공통",
    category: "통신비",
    amount: 185000,
    period: "monthly",
    dayOfMonth: 25,
    startDate: "2026-01-01",
    endDate: null,
    accountId: "acc-001",
    active: true,
    lastGenerated: "2026-05-25"
  }
]
```

**자동 생성 로직 (api.js)**:
```js
api.generateRecurringExpenses() {
  const today = new Date()
  const generated = []
  RECURRING_EXPENSES.filter(r => r.active).forEach(r => {
    const nextDate = calcNextDate(r)  // period + dayOfMonth 기반 계산
    if (nextDate <= today && nextDate > new Date(r.lastGenerated)) {
      // SAMPLE.expenses에 "지급 예정" 상태로 추가
      generated.push({ vendor: r.vendor, amount: r.amount, pay: "지급 예정", ... })
      r.lastGenerated = nextDate.toISOString().slice(0,10)
    }
  })
  return generated
}
```

---

### 3.5 F5 — 마일스톤 (CONTRACT_LIST 확장)

```js
// CONTRACT_LIST 각 항목에 milestones 필드 추가
{
  id: "CT-2026-101",
  name: "KF-21 동체 부품",
  ...기존 필드...,
  milestones: [
    {
      id: "ms-001",
      type: "선급금",
      ratio: 20,                  // 계약금액의 %
      amount: 28400000,
      dueDate: "2026-01-30",
      status: "입금 완료",         // "예정" | "청구됨" | "일부 입금" | "입금 완료"
      invoiceId: "INV-2026-050"   // 연결된 청구서 ID (청구서 발행 후 연결)
    },
    {
      id: "ms-002",
      type: "기성고",
      ratio: 30,
      amount: 42600000,
      dueDate: "2026-03-15",
      status: "입금 완료",
      invoiceId: "INV-2026-051"
    },
    {
      id: "ms-003",
      type: "기성고",
      ratio: 30,
      amount: 42600000,
      dueDate: "2026-04-20",
      status: "입금 완료",
      invoiceId: "INV-2026-052"
    },
    {
      id: "ms-004",
      type: "잔금",
      ratio: 20,
      amount: 28400000,
      dueDate: "2026-05-20",
      status: "예정",              // 아직 청구서 미발행
      invoiceId: null
    }
  ]
}
```

---

### 3.6 F6 — 원가 예산 (CONTRACT_LIST 확장)

```js
// CONTRACT_LIST 각 항목에 costBudget 필드 추가
{
  id: "CT-2026-101",
  ...기존 필드...,
  costBudget: {
    material:  20000000,    // 재료비 예산
    outsource: 15000000,    // 외주가공비 예산
    labor:      8000000,    // 인건비 예산
    overhead:   3500000     // 경비 예산
  }
  // 실적은 SAMPLE.expenses에서 contractId 기준으로 집계
}
```

**원가율 계산 (api.js)**:
```js
api.getContractCostAnalysis(contractId) {
  const contract = CONTRACT_LIST.find(c => c.id === contractId)
  const expenses = SAMPLE.expenses.filter(e => e.contractId === contractId)

  const actual = {
    material:  expenses.filter(e => e.category === "재료비").reduce(...),
    outsource: expenses.filter(e => e.category === "외주가공비").reduce(...),
    labor:     expenses.filter(e => e.category === "인건비").reduce(...),
    overhead:  expenses.filter(e => !["재료비","외주가공비","인건비"].includes(e.category)).reduce(...)
  }

  const budget = contract.costBudget
  const totalBudget = Object.values(budget).reduce((s, v) => s + v, 0)
  const totalActual = Object.values(actual).reduce((s, v) => s + v, 0)

  return {
    budget, actual,
    totalBudget, totalActual,
    targetCostRate: totalBudget / contract.amount,
    actualCostRate: totalActual / contract.amount,
    estimatedProfit: contract.amount - totalActual
  }
}
```

---

## 4. 화면 설계

### 4.1 F1 — 계좌별 잔액 (`MasterScreen` 계좌 탭 확장)

**현재**: 계좌 목록만 표시
**변경**: 잔액 + 조정 기능 추가

```
설정 > 계좌 관리
┌─────────────────────────────────────────────────────────┐
│  계좌 관리                              [+ 계좌 추가]   │
├─────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────┐  │
│  │ 기업은행 *123  보통예금                           │  │
│  │ 현재 잔액  ₩ 42,350,000                          │  │
│  │ 초기잔액 50,000,000 + 입금 24,800,000            │  │
│  │                      - 출금 32,450,000            │  │
│  │                      ± 조정     -500,000          │  │
│  │                    [조정 이력]  [잔액 조정]       │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ 신한은행 *456  보통예금                           │  │
│  │ 현재 잔액  ₩ 18,620,000                          │  │
│  │ ...                    [조정 이력]  [잔액 조정]   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘

[잔액 조정 Drawer]
┌─────────────────────────────────┐
│ 잔액 조정 — 기업은행 *123      │
├─────────────────────────────────┤
│ 조정 금액    [      -500,000  ] │
│              (+ 추가 / - 차감)  │
│ 조정 사유    [은행 수수료       ]│
│ 조정 일자    [2026-05-20       ]│
│                                 │
│        [취소]  [조정 등록]      │
└─────────────────────────────────┘

[조정 이력 Drawer]
┌────────────────────────────────────────┐
│ 조정 이력 — 기업은행 *123             │
├────────────────────────────────────────┤
│ 2026-05-01  -500,000  은행 수수료     │
│             작성: 한경리              │
│ ──────────────────────────────────── │
│ 2026-04-15  +200,000  오입력 수정    │
│             작성: 한경리              │
└────────────────────────────────────────┘
```

---

### 4.2 F2 — 청구 관리 (`Billing.jsx` 신규)

```
청구 관리
┌─────────────────────────────────────────────────────────────────┐
│ [발행 청구서 (미수금)]  [수취 청구서 (미지급금)]                │
├─────────────────────────────────────────────────────────────────┤
│ 미수금 합계: ₩87,400,000 · 6건              [+ 청구서 발행]    │
│                                                                   │
│ 기간 [이번달 v]  거래처 [전체 v]  상태 [전체 v]  [검색_______] │
├────────┬──────────────┬──────────────┬───────────┬──────────────┤
│ 청구번호│ 거래처       │ 계약         │ 청구액    │ 상태         │
├────────┼──────────────┼──────────────┼───────────┼──────────────┤
│INV-001 │한화에어로스페│KF-21 동체 부품│28,400,000 │● 입금 예정   │
│        │이스           │              │           │ 2026-05-20   │
├────────┼──────────────┼──────────────┼───────────┼──────────────┤
│INV-002 │LIG넥스원      │유도무기 정밀 │18,600,000 │○ 일부 입금   │
│        │              │가공           │잔여16.4M  │ 2026-05-18   │
├────────┼──────────────┼──────────────┼───────────┼──────────────┤
│INV-003 │(주)동방산업   │전차 궤도 시제 │11,800,000 │🔴 장기 미수  │
│        │              │              │           │ +84일 연체   │
└────────┴──────────────┴──────────────┴───────────┴──────────────┘

[청구서 상세 Drawer]
┌────────────────────────────────────────────┐
│ 청구서  INV-2026-001                       │
├────────────────────────────────────────────┤
│ 거래처   한화에어로스페이스                │
│ 계약     KF-21 동체 부품 (CT-2026-101)    │
│ 공급가액 25,818,182원                      │
│ 부가세    2,581,818원                      │
│ 청구금액 28,400,000원                      │
│ 청구일   2026-05-15                        │
│ 지급기한 2026-05-20                        │
│ 메모     KF-21 기성고 3차                  │
├────────────────────────────────────────────┤
│ 입금 매칭                                  │
│  [입금 거래 연결]                          │
│  연결된 거래 없음                          │
├────────────────────────────────────────────┤
│       [수정]  [입금 처리]  [삭제]          │
└────────────────────────────────────────────┘

[청구서 발행 Drawer — 6단계]
Step1: 거래처 선택
Step2: 연결 계약 선택 (마일스톤 자동 연결 옵션)
Step3: 공급가액 입력 → 부가세 자동 계산
Step4: 청구일 / 지급기한 입력
Step5: 입금 계좌 선택
Step6: 메모 + 확인
```

---

### 4.3 F3 — 부가세 관리 (`ReportsScreen` 신규 탭)

```
보고서 > [월별] [계약별] [거래처별] [부가세]   ← 탭 추가

부가세 신고 자료
┌───────────────────────────────────────────────┐
│ 기간: [1분기] [2분기] [3분기] [4분기] [직접입력]│
│       2026.01.01 ~ 2026.03.31                  │
├──────────────────────┬────────────────────────┤
│ 매출세액             │ 매입세액               │
│ ₩12,840,000         │ ₩6,370,000             │
│ 세금계산서 8건       │ 세금계산서 14건        │
├──────────────────────┴────────────────────────┤
│ 납부 예상세액                                  │
│ ₩6,470,000   (매출세액 - 매입세액)            │
├───────────────────────────────────────────────┤
│ 매출 세금계산서 목록                           │
├────────┬────────────┬──────────┬──────────────┤
│ 발행일 │ 거래처     │ 공급가액 │ 세액         │
├────────┼────────────┼──────────┼──────────────┤
│01-30   │한화에어로  │25,818,182│2,581,818     │
│03-15   │한화에어로  │38,727,272│3,872,727     │
│ ...    │            │          │              │
├───────────────────────────────────────────────┤
│ 매입 세금계산서 목록                           │
│ (동일 구조)                                    │
└───────────────────────────────────────────────┘
```

---

### 4.4 F4 — 정기 지출 (`MasterScreen` 신규 탭)

```
설정 > [업체] [비목] [계좌] [임직원] [정기지출]   ← 탭 추가

정기 지출 관리                         [+ 정기 지출 등록]
┌─────────────────────────────────────────────────────────┐
│ 거래처          금액        주기    다음 생성    상태    │
├─────────────────────────────────────────────────────────┤
│ 임대인 박OO    3,200,000   매월 1일 2026-06-01  ● 활성  │
│ KT             185,000    매월 25일 2026-06-25  ● 활성  │
│ (주)한울정밀  선계약별    분기    2026-07-01   ● 활성  │
│ ...                                             ○ 비활성 │
└─────────────────────────────────────────────────────────┘

[정기 지출 등록 Drawer]
┌──────────────────────────────────┐
│ 정기 지출 등록                   │
├──────────────────────────────────┤
│ 거래처    [임대인 박OO         ] │
│ 비목      [임차료 v            ] │
│ 금액      [3,200,000           ] │
│ 반복 주기 [매월 v]  일 [1     ] │
│ 시작일    [2026-01-01          ] │
│ 종료일    [없음 (무기한)       ] │
│ 결제 계좌 [기업은행 *123 v    ] │
│                                  │
│     [취소]  [등록]              │
└──────────────────────────────────┘
```

---

### 4.5 F5 — 수금 예정 자동화 (`ContractScreen` 탭 추가)

```
계약 상세 > [개요] [수금 현황] [마일스톤] [원가 예산] [서류] [증빙] [이력]
                              ↑ 탭 추가   ↑ 탭 추가

마일스톤 탭
┌────────────────────────────────────────────────────────────┐
│ KF-21 동체 부품 (142,000,000원)            [마일스톤 편집] │
├─────┬───────┬─────────────┬────────────┬───────────────────┤
│ 유형 │  비율  │ 금액        │ 예정일     │ 상태              │
├─────┼───────┼─────────────┼────────────┼───────────────────┤
│선급금│  20%  │  28,400,000 │ 2026-01-30 │ ✅ 입금 완료       │
│기성고│  30%  │  42,600,000 │ 2026-03-15 │ ✅ 입금 완료       │
│기성고│  30%  │  42,600,000 │ 2026-04-20 │ ✅ 입금 완료       │
│잔금  │  20%  │  28,400,000 │ 2026-05-20 │ 🔵 [청구서 발행]   │
└─────┴───────┴─────────────┴────────────┴───────────────────┘
│ [마일스톤 추가]                                             │

← "청구서 발행" 버튼 클릭 시 청구서 발행 Drawer 자동 열림
   (거래처, 계약, 금액 사전 입력된 상태)
← 청구서 발행 완료 후 상태 → "입금 예정"으로 변경

[마일스톤 편집 Drawer]
┌────────────────────────────────────┐
│ 마일스톤 설정                      │
│ 계약금액: 142,000,000원            │
├────────────────────────────────────┤
│ 유형    비율  금액         예정일  │
│ [선급금] [20%] 28,400,000  [날짜] │
│ [기성고] [30%] 42,600,000  [날짜] │
│ [기성고] [30%] 42,600,000  [날짜] │
│ [잔금  ] [20%] 28,400,000  [날짜] │
│ 합계: 100% = 142,000,000원 ✅     │
│ [행 추가]              [저장]     │
└────────────────────────────────────┘
```

---

### 4.6 F6 — 계약별 원가 예산 (`ContractScreen` 탭 추가)

```
원가 예산 탭
┌──────────────────────────────────────────────────────────────────┐
│ 원가 예산 vs 실적                           [예산 수정]          │
├──────────────┬────────────┬────────────┬───────┬────────────────┤
│ 항목         │ 예산       │ 실적       │ 달성율 │ 상태           │
├──────────────┼────────────┼────────────┼───────┼────────────────┤
│ 재료비       │ 20,000,000 │ 18,200,000 │  91%  │ ⚠️ 임박         │
│ 외주가공비   │ 15,000,000 │ 20,300,000 │ 135%  │ 🔴 초과         │
│ 인건비       │  8,000,000 │  6,500,000 │  81%  │ 정상           │
│ 경비         │  3,500,000 │  3,800,000 │ 109%  │ 🔴 초과         │
├──────────────┼────────────┼────────────┼───────┼────────────────┤
│ 합계         │ 46,500,000 │ 48,800,000 │ 105%  │                │
├──────────────┴────────────┴────────────┴───────┴────────────────┤
│ 계약금액     142,000,000원                                       │
│ 목표 원가율   32.7%  (예산 기준)                                 │
│ 실제 원가율   34.4%  (실적 기준)  ⚠️ 목표 초과                  │
│ 예상 이익    93,200,000원  (계약금액 - 실적 합계)                │
└──────────────────────────────────────────────────────────────────┘

[예산 수정 Drawer]
┌──────────────────────────────────┐
│ 원가 예산 설정                   │
│ 계약금액: 142,000,000원          │
├──────────────────────────────────┤
│ 재료비    [  20,000,000        ] │
│ 외주가공비 [  15,000,000        ] │
│ 인건비    [   8,000,000        ] │
│ 경비      [   3,500,000        ] │
│ ─────────────────────────────── │
│ 합계      46,500,000 (32.7%)    │
│                                  │
│     [취소]  [저장]              │
└──────────────────────────────────┘
```

---

## 5. 컴포넌트 설계

### 5.1 신규 컴포넌트 (`src/screens/Billing.jsx`)

```
BillingScreen
├── BillingSummaryCards       // 미수금 합계, 미지급금 합계, 이번달 청구
├── BillingTabs               // 발행 청구서 / 수취 청구서
│   ├── IssuedInvoiceTable    // 발행 청구서 목록
│   └── ReceivedInvoiceTable  // 수취 청구서 목록
├── InvoiceDetailDrawer       // 청구서 상세 (매칭 포함)
│   └── MatchingPanel         // 거래 연결 UI
└── InvoiceFormDrawer         // 청구서 발행/편집 Drawer (6단계)
```

### 5.2 수정 컴포넌트

**`Master.jsx`**
- `AccountTab` → `AccountBalanceTab` (잔액 표시 + 조정)
  - `AccountBalanceCard` — 계좌별 카드
  - `AdjustmentDrawer` — 조정 입력
  - `AdjustmentHistoryDrawer` — 이력 조회
- `RecurringExpenseTab` (신규 탭)
  - `RecurringExpenseTable`
  - `RecurringExpenseFormDrawer`

**`Contract.jsx`**
- `ContractScreen`에 탭 추가: `MilestoneTab`, `CostBudgetTab`
  - `MilestoneTable` — 마일스톤 목록 + 상태
  - `MilestoneEditDrawer` — 마일스톤 편집
  - `CostBudgetTable` — 예산/실적 비교
  - `CostBudgetEditDrawer` — 예산 수정

**`Docs.jsx` (ReportsScreen)**
- 탭에 `VatTab` 추가
  - `VatSummaryCards` — 매출세액, 매입세액, 납부세액
  - `VatInvoiceTable` — 세금계산서 목록 (매출/매입 전환)
  - `QuarterSelector` — 분기 선택

---

## 6. 홈 대시보드 연동

```
Home.jsx 변경사항

현재                          v2
─────────────────────         ─────────────────────────────
미수금: 하드코딩             미수금: api.getReceivables() 합계
미지급금: 하드코딩           미지급금: api.getPayables() 합계
입금 예정 목록: 하드코딩     입금 예정: 마일스톤 + 청구서 due date 기반
지급 예정 목록: 하드코딩     지급 예정: 정기지출 + 청구서 기반
자금 카드: 없음              계좌별 잔액 요약 추가 (F1)
```

---

## 7. 구현 순서 및 예상 작업량

| 순서 | 파일 | 주요 작업 | 예상 규모 |
|------|------|---------|---------|
| 1 | `data.js` | ACCOUNTS_BALANCE, INVOICES, RECURRING_EXPENSES, 계약 필드 추가 | 중 |
| 2 | `api.js` | 잔액 계산, 미수금/미지급금 집계, VAT 집계 함수 추가 | 중 |
| 3 | `Master.jsx` | 계좌 탭 → 잔액+조정, 정기지출 탭 신규 | 중 |
| 4 | `Billing.jsx` | 청구 관리 화면 전체 신규 | 대 |
| 5 | `App.jsx` | 청구 관리 네비게이션 + 라우팅 추가 | 소 |
| 6 | `Contract.jsx` | 마일스톤 탭, 원가예산 탭 추가 | 중 |
| 7 | `Docs.jsx` | 보고서에 부가세 탭 추가 | 중 |
| 8 | `Home.jsx` | 대시보드 데이터 연동 | 소 |

---

## 8. 구현 시 주의사항

1. **청구서 발행 → 마일스톤 연결**: 마일스톤의 "청구서 발행" 버튼은 `Billing.jsx`의 `InvoiceFormDrawer`를 호출하되, 계약·금액·거래처를 props로 넘겨 사전 입력
2. **미수금 집계 일관성**: 기존 `SAMPLE.receivables`는 제거하고 `INVOICES` 기반으로 통일. 홈·거래내역·청구 메뉴 모두 동일 소스 사용
3. **StatusBadge 확장**: 청구서 상태("입금 예정", "일부 입금", "장기 미수" 등)는 기존 `StatusBadge` 컴포넌트 tone 매핑 추가
4. **계좌 잔액 실시간성**: 거래내역 입력 시 해당 계좌의 잔액이 즉시 반영되도록 `api.getAccountBalance()`를 항상 계산형으로 유지

---

## 9. 버전 이력

| 버전 | 날짜 | 변경 내용 | 작성자 |
|------|------|---------|--------|
| 0.1 | 2026-05-20 | 초안 작성 | Chajuick |
