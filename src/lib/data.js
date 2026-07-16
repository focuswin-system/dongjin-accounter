// 비목(계정과목) 마스터 — 코드 기반 정적 참조 데이터 (DB 저장 불필요)
export const CATEGORIES = [
  // 인건비(생산)
  { id: "EXP-101", name: "생산 급여",          group: "인건비(생산)",  vat: "면세", payMethod: "계좌이체" },
  { id: "EXP-102", name: "복리후생비(생산)",   group: "인건비(생산)",  vat: "면세", payMethod: "계좌이체" },
  { id: "EXP-103", name: "퇴직급여(생산)",     group: "인건비(생산)",  vat: "면세", payMethod: "계좌이체" },
  // 인건비(관리)
  { id: "EXP-104", name: "관리 급여",          group: "인건비(관리)",  vat: "면세", payMethod: "계좌이체" },
  { id: "EXP-105", name: "복리후생비(관리)",   group: "인건비(관리)",  vat: "면세", payMethod: "계좌이체" },
  { id: "EXP-106", name: "퇴직급여(관리)",     group: "인건비(관리)",  vat: "면세", payMethod: "계좌이체" },
  // 재료비
  { id: "EXP-201", name: "철강 원자재",        group: "재료비",        vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-202", name: "비철금속",           group: "재료비",        vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-203", name: "특수강",             group: "재료비",        vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-204", name: "부자재",             group: "재료비",        vat: "10%",  payMethod: "법인카드" },
  // 외주가공비
  { id: "EXP-301", name: "정밀가공 외주",      group: "외주가공비",    vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-302", name: "표면처리 외주",      group: "외주가공비",    vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-303", name: "도금 외주",          group: "외주가공비",    vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-304", name: "열처리 외주",        group: "외주가공비",    vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-305", name: "용접 외주",          group: "외주가공비",    vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-306", name: "연삭·방전 외주",     group: "외주가공비",    vat: "10%",  payMethod: "계좌이체" },
  // 소모품
  { id: "EXP-401", name: "소모품비(생산)",     group: "소모품",        vat: "10%",  payMethod: "법인카드" },
  { id: "EXP-402", name: "소모품비(관리)",     group: "소모품",        vat: "10%",  payMethod: "법인카드" },
  { id: "EXP-403", name: "측정공구비",         group: "소모품",        vat: "10%",  payMethod: "법인카드" },
  { id: "EXP-404", name: "절삭유·윤활유",      group: "소모품",        vat: "10%",  payMethod: "법인카드" },
  // 시험·인증
  { id: "EXP-501", name: "시험검사비",         group: "시험·인증",     vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-502", name: "검사성적서 발급",    group: "시험·인증",     vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-503", name: "방산인증 수수료",    group: "시험·인증",     vat: "면세", payMethod: "계좌이체" },
  { id: "EXP-504", name: "KS·ISO 인증",        group: "시험·인증",     vat: "면세", payMethod: "계좌이체" },
  // 운영비
  { id: "EXP-601", name: "임차료",             group: "운영비",        vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-602", name: "전력비",             group: "운영비",        vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-603", name: "수도광열비",         group: "운영비",        vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-604", name: "통신비(관리)",       group: "운영비",        vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-605", name: "통신비(생산)",       group: "운영비",        vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-606", name: "수선비",             group: "운영비",        vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-607", name: "보험료",             group: "운영비",        vat: "면세", payMethod: "계좌이체" },
  { id: "EXP-608", name: "운반비",             group: "운영비",        vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-609", name: "위탁관리비",         group: "운영비",        vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-610", name: "수수료",             group: "운영비",        vat: "10%",  payMethod: "계좌이체" },
  // 차량·여비
  { id: "EXP-701", name: "차량유지비",         group: "차량·여비",     vat: "10%",  payMethod: "법인카드" },
  { id: "EXP-702", name: "출장비",             group: "차량·여비",     vat: "면세", payMethod: "법인카드" },
  { id: "EXP-703", name: "접대비",             group: "차량·여비",     vat: "10%",  payMethod: "법인카드" },
  // 안전·환경
  { id: "EXP-801", name: "안전관리비",         group: "안전·환경",     vat: "10%",  payMethod: "계좌이체" },
  { id: "EXP-802", name: "환경규제 비용",      group: "안전·환경",     vat: "면세", payMethod: "계좌이체" },
  // 세금·금융
  { id: "EXP-901", name: "세금과공과금",       group: "세금·금융",     vat: "면세", payMethod: "계좌이체" },
  { id: "EXP-902", name: "이자비용",           group: "세금·금융",     vat: "면세", payMethod: "계좌이체" },
  { id: "EXP-903", name: "판공비",             group: "세금·금융",     vat: "면세", payMethod: "법인카드" },
  { id: "EXP-904", name: "기타 지출",          group: "세금·금융",     vat: "—",    payMethod: "—"        },
  // 납품수익
  { id: "INC-101", name: "선급금",             group: "납품수익",      vat: "10%",  payMethod: "—" },
  { id: "INC-102", name: "기성고",             group: "납품수익",      vat: "10%",  payMethod: "—" },
  { id: "INC-103", name: "중도금",             group: "납품수익",      vat: "10%",  payMethod: "—" },
  { id: "INC-104", name: "검수 후 결제",       group: "납품수익",      vat: "10%",  payMethod: "—" },
  { id: "INC-105", name: "납품대금",           group: "납품수익",      vat: "10%",  payMethod: "—" },
  { id: "INC-106", name: "잔금",               group: "납품수익",      vat: "10%",  payMethod: "—" },
  // 기타수익
  { id: "INC-201", name: "고철·스크랩 수익",  group: "기타수익",      vat: "10%",  payMethod: "—" },
  { id: "INC-202", name: "환급금",             group: "기타수익",      vat: "—",    payMethod: "—" },
  { id: "INC-203", name: "잡수익",             group: "기타수익",      vat: "—",    payMethod: "—" },
  { id: "INC-204", name: "이자수익",           group: "기타수익",      vat: "면세", payMethod: "—" },
]
