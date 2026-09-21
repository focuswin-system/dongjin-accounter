/* ⚠ 확장자를 적는다 — 이 파일은 server/test/cardStatement.test.js 가
   노드로 **직접** import 한다(번들러를 안 거친다). ESM 은 확장자를 생략 못 한다. */
import { intOf, normDate, digits } from './hometax.js'

/* 카드사 이용내역(카드대금명세서) 엑셀 한 행 → 카드 사용 지출 한 건. 순수 함수만 둔다.
 *
 * ── 왜 따로 받나 ──
 * 카드로 쓴 돈은 통장에 안 찍힌다. 결제일에 **합계 한 줄**로만 빠지므로, 그 안의 수십 건을
 * 사람이 명세서를 보고 하나씩 옮겨 적어 왔다. 그게 이 앱에서 가장 지루한 반복 입력이고,
 * 빠뜨리면 경비가 통째로 누락된다(카드 잔액만 늘어나 결제일에야 "왜 이렇게 많지"가 된다).
 *
 * ── 카드사마다 열 이름이 다르다 ──
 * 신한 '이용일자/이용가맹점', 삼성 '이용일/가맹점명', 현대 '이용일자/가맹점',
 * KB '이용일자/가맹점명', 홈택스 사업용카드 '거래일자/거래처'… 뜻은 같고 글자만 다르다.
 * 그래서 **양식을 강요하지 않는다** — 받아온 파일 그대로 올리고, 열 이름으로 짐작한 뒤
 * 사람이 마법사에서 고친다. 짐작이 틀려도 등록 전에 표로 보인다.
 *
 * ⚠ **승인번호가 중복 판정의 축이다.** 같은 명세서를 두 번 올려도 두 번 쌓이지 않아야 한다.
 *   승인번호 열이 없는 파일(오래된 양식·직접 만든 표)은 날짜+금액+가맹점으로 본다 —
 *   같은 가게에서 같은 날 같은 금액을 두 번 쓴 경우가 실제로 있어(커피 두 번) 확실하지 않다.
 *   그래서 그 경우는 '중복'이 아니라 '확인 필요'로 띄우고 사람이 정한다.
 */

/** 매핑 대상 라벨 — 마법사의 드롭다운에 이 이름으로 뜬다 */
export const C = {
  date: '이용일자',
  merchant: '가맹점',
  bizNo: '사업자번호',
  amount: '이용금액',
  supply: '공급가액',
  vat: '부가세',
  tip: '봉사료',
  installment: '할부',
  approval: '승인번호',
  industry: '업종',
  cardNo: '카드번호',
  status: '상태',
  memo: '비고',
}

export const CARD_TARGETS = Object.values(C)

/* 열 이름 → 매핑 대상.
 *
 * ⚠ 순서가 규칙이다. '이용금액'보다 '공급가액'을 먼저 봐야 한다 —
 *   '공급가액'에도 '가액'이 있어서 느슨한 금액 규칙이 먼저 잡으면 공급가가 합계로 들어간다.
 * ⚠ '승인일자'는 날짜, '승인번호'는 번호다. 둘 다 '승인'으로 시작하므로 번호를 먼저 본다.
 */
const RULES = [
  [C.approval,    /승인\s*번호|거래\s*번호|전표\s*번호|approval/i],
  [C.date,        /이용\s*일|승인\s*일|거래\s*일|사용\s*일|매출\s*일|결제\s*일자|date/i],
  [C.bizNo,       /사업자\s*(등록)?\s*번호|biz/i],
  /* ⚠ 업종을 **가맹점보다 먼저** 본다. '가맹점업종'처럼 둘이 붙은 머리글이 흔한데,
     가맹점 규칙이 먼저 잡으면 업종명이 거래처 이름 자리로 들어간다. */
  [C.industry,    /업종|가맹점\s*분류|업태/],
  /* 취소 건을 가려내는 열. 신한·KB 는 금액을 양수로 두고 '매입상태=취소'로만 표시한다 —
     이 열을 안 보면 **취소된 결제가 경비로 그대로 들어간다.** */
  [C.status,      /매입\s*상태|승인\s*상태|취소\s*여부|거래\s*상태|^상태$/],
  [C.merchant,    /가맹점|이용\s*처|사용\s*처|상호|거래처|merchant|store/i],
  [C.supply,      /공급\s*가액|과세\s*금액|supply/i],
  [C.vat,         /부가\s*세|세액|부\s*가\s*가치세|vat|tax/i],
  [C.tip,         /봉사료/],
  [C.installment, /할부/],
  [C.cardNo,      /카드\s*번호|카드\s*No|카드\s*종류|카드\s*명/i],
  /* 금액은 마지막에 본다 — 위의 구체적인 금액 열(공급가액·부가세·봉사료)을 먼저 집고 남은 것만 합계로. */
  [C.amount,      /이용\s*금액|승인\s*금액|합계|총\s*금액|결제\s*금액|사용\s*금액|금액|amount/i],
  [C.memo,        /비고|메모|적요|내용|note|memo/i],
]

export const guessCardColumn = (header) => {
  const h = String(header ?? '').replace(/\s+/g, ' ').trim()
  if (!h) return null
  for (const [target, re] of RULES) if (re.test(h)) return target
  return null
}

/** '3개월'·'일시불'·'03' → 개월 수. 일시불·빈 값은 1. */
export const installmentMonths = (v) => {
  const s = String(v ?? '').trim()
  if (!s) return 1
  if (/일시불|일시|없음/.test(s)) return 1
  const n = parseInt(digits(s), 10)
  return Number.isFinite(n) && n > 1 ? n : 1
}

/**
 * 엑셀 한 행 → 등록할 카드 사용 한 건.
 *
 * @param g    (라벨) => 셀 값
 * @param opts { defaultCategory }
 */
export function mapCardRow(g, opts = {}) {
  const amountRaw = intOf(g(C.amount))
  const supply = g(C.supply) !== '' ? intOf(g(C.supply)) : null
  const vat    = g(C.vat)    !== '' ? intOf(g(C.vat))    : null
  const tip    = intOf(g(C.tip))
  /* 합계 열이 없는 파일이 있다(공급가·부가세·봉사료만 주는 양식).
     그때는 더해서 만든다 — 합계가 0이면 행이 통째로 '필수값 없음'이 되어 버려진다. */
  const amount = amountRaw || ((supply || 0) + (vat || 0) + tip)
  const months = installmentMonths(g(C.installment))
  const merchant = String(g(C.merchant) ?? '').trim()

  return {
    date: normDate(g(C.date)),
    merchant,
    biz_no: digits(g(C.bizNo)) || '',
    amount,
    /* 카드 매출전표는 공급가·세액이 찍혀 나온다. 그 값이 있으면 그대로 쓴다.
       없으면 **보내지 않는다** — 서버 vatFields 가 비목의 과세 설정대로 계산한다(규칙은 한 곳). */
    supply_amount: supply,
    vat_amount: vat,
    /* 세액이 0으로 찍혀 온 건 면세 가맹점(농산물·병원·학원 등)이다.
       ⚠ 추정이 아니다 — 카드사가 준 값이다. 다만 세액 열 자체가 없으면 판단하지 않는다. */
    tax_type: vat == null ? null : (vat > 0 ? '과세' : '면세'),
    installment: months,
    approval_no: digits(g(C.approval)) || '',
    industry: String(g(C.industry) ?? '').trim(),
    /* 카드사가 준 상태. '취소'가 적힌 행은 등록하지 않는다 — 금액이 양수라 금액만 보면 못 가린다. */
    status: String(g(C.status) ?? '').trim(),
    canceled: /취소|반품|무효/.test(String(g(C.status) ?? '')),
    card_no: String(g(C.cardNo) ?? '').trim(),
    category: opts.defaultCategory || '',
    /* 가맹점 이름은 **메모에 남긴다.** 거래처로 자동 등록하지 않는 편이 기본이라
       (가맹점은 수백 곳이고 대부분 한 번 쓰고 만다) 이 줄이 없으면 어디서 쓴 돈인지 사라진다. */
    memo: [merchant, months > 1 ? `${months}개월 할부` : '', String(g(C.memo) ?? '').trim()]
      .filter(Boolean).join(' · '),
  }
}

export const isCardRowValid = (d) => !!d.date && Number(d.amount) > 0 && !d.canceled

/* ⚠ 취소 건(음수)은 등록하지 않는다.
   카드 취소는 '마이너스 지출'이 아니라 **원래 지출을 없던 일로 하는 것**이다. 음수로 넣으면
   그 달 경비는 맞아 보여도 거래가 두 줄 남아, 나중에 증빙을 맞출 때 어느 쪽이 진짜인지 모른다.
   먼저 올린 원거래를 지우는 것이 맞고, 그 말을 여기서 한다. */
export const cardInvalidLabel = (d) =>
  !d.date ? '이용일자를 못 읽었어요'
    : d.canceled ? `취소된 결제예요(${d.status}) — 등록하지 않습니다`
    : Number(d.amount) < 0 ? '취소 건이에요 — 먼저 올린 원거래를 지워주세요'
    : '금액이 0이에요'

/** 파일 안 중복 판정 키 — 승인번호가 있으면 그것 하나로 충분하다. */
export const cardMatchKey = (d) =>
  d.approval_no ? `A|${d.approval_no}` : `D|${d.date}|${d.amount}|${d.merchant}`

/** 행별 주의 문구 — 값을 못 알아봤거나, 올린 파일이 이용내역이 아닐 때. */
export function cardRowWarns(d) {
  const w = []
  if (!d.approval_no) w.push('승인번호 없음 — 다시 올리면 중복될 수 있어요')
  if (!d.merchant) w.push('가맹점 없음')
  if (d.installment > 1) w.push(`${d.installment}개월 할부 — 승인일에 전액으로 잡습니다`)
  return w
}

/**
 * 올린 파일이 **이용내역**이 맞는지 본다.
 *
 * 카드사 사이트에는 두 가지가 있다.
 *   이용내역(승인내역) — 승인 한 건이 한 줄. 우리가 원하는 것.
 *   청구내역           — 이번 달에 **청구되는 금액**이 한 줄(할부 2회차 같은 것이 섞인다).
 * 청구내역을 올리면 할부 원금이 회차마다 또 잡혀 경비가 부풀고, 카드 잔액도 안 맞는다.
 * 열 이름으로 가려낼 수 있으면 올리기 전에 알린다 — 등록한 뒤에는 되돌리기가 훨씬 비싸다.
 */
export const looksLikeBillingFile = (headers = []) =>
  headers.some(h => /청구\s*금액|이번\s*달\s*청구|당월\s*청구|결제\s*예정|할부\s*회차|잔여\s*(할부|회차|원금)|남은\s*(할부|회차)|수수료/
    .test(String(h ?? '')))
