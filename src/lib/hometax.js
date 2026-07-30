/* 홈택스 전자세금계산서 엑셀 한 행 → 청구서 한 건. 순수 함수만 둔다(테스트 대상).
 *
 * 여기서 틀리면 화면은 멀쩡하고 숫자만 조용히 틀어진다. 특히 위험한 두 가지:
 *   1) 매출/매입 방향 — 뒤집히면 매출세액과 매입세액이 통째로 바뀐다.
 *   2) 과세유형 — 면세를 과세로 넣으면 없는 세액이 생기고, 영세를 면세로 넣으면 과세표준이 빈다.
 * 그래서 둘 다 '추측하지 않고 근거로 판정'하고, 근거가 없으면 행에 표시한다(hometaxRowWarns).
 *
 * import 없음 — 서버 테스트(node --test)에서 그대로 불러 쓴다.
 */

export const digits = (v) => String(v ?? '').replace(/[^0-9]/g, '')
export const intOf = (v) => parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10) || 0
/** 수량은 소수가 올 수 있다(0.5개월·1.5시간). 금액과 달리 반올림하지 않는다. */
export const numOf = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** 엑셀 날짜 → YYYY-MM-DD. '2026-07-01' · '2026.7.1' · '2026년 7월 1일' · '20260701' 모두 받는다. */
export const normDate = (v) => {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const m = s.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  const d = digits(s)
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  return ''
}

/** 작성일자 + n일 = 결제기한. new Date(ymd)는 UTC 자정이라 KST에서 하루 밀린다 → 로컬 생성자로 만든다. */
export const addDays = (ymd, n) => {
  if (!ymd) return ''
  const days = Number(n)
  if (!Number.isFinite(days) || days <= 0) return ''
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, m - 1, d + days)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

/** 오늘(로컬 달력). toISOString(UTC)은 KST 새벽에 하루 전이 되므로 쓰지 않는다. */
export const localTodayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 매핑 대상 라벨 — 화면의 컬럼 매핑 드롭다운과 mapRow가 같은 문자열을 쓴다. */
export const T = {
  date:    '작성일자',
  confirm: '승인번호',
  supBiz:  '공급자 사업자등록번호',
  supName: '공급자 상호',
  buyBiz:  '공급받는자 사업자등록번호',
  buyName: '공급받는자 상호',
  total:   '합계금액',
  supply:  '공급가액',
  vat:     '세액',
  docKind: '종류',
  memo:    '비고',
  // 품목 상세 — 홈택스 엑셀을 품목까지 포함해 받으면 계산서 1건이 품목 수만큼 여러 행으로 온다.
  itemName:   '품목명',
  itemSpec:   '품목 규격',
  itemQty:    '품목 수량',
  itemPrice:  '품목 단가',
  itemAmount: '품목 공급가액',
}

export const HOMETAX_TARGETS = [
  T.date, T.confirm, T.supBiz, T.supName, T.buyBiz, T.buyName,
  T.total, T.supply, T.vat, T.docKind, T.memo,
  T.itemName, T.itemSpec, T.itemQty, T.itemPrice, T.itemAmount,
]

/**
 * 엑셀 머리글 → 매핑 대상 추측.
 * '공급받는자 …'를 '공급자 …'보다 먼저 본다 — 반대로 두면 공급받는자 사업자번호가
 * 공급자 칸으로 들어가 매출/매입 방향이 통째로 뒤집힌다.
 */
export const guessHometaxColumn = (h) => {
  const s = String(h).replace(/\s/g, '')
  if (/승인번호/.test(s)) return T.confirm
  if (/공급받는자|공급받는/.test(s)) {
    if (/사업자|등록번호/.test(s)) return T.buyBiz
    if (/상호|법인명|업체명|회사명/.test(s)) return T.buyName
    return '사용 안함'          // 대표자명·주소·이메일 등은 청구서에 넣지 않는다
  }
  if (/공급자/.test(s)) {
    if (/사업자|등록번호/.test(s)) return T.supBiz
    if (/상호|법인명|업체명|회사명/.test(s)) return T.supName
    return '사용 안함'
  }
  // 품목 칸을 계산서 합계보다 먼저 본다 — '품목공급가액'이 '공급가액'(계산서 합계)으로 잡히면
  // 품목 하나짜리 계산서에선 티가 안 나고 여러 품목일 때만 금액이 틀어진다.
  if (/품목/.test(s)) {
    if (/세액/.test(s)) return '사용 안함'        // invoice_lines엔 품목별 세액 칸이 없다(계산서 세액을 쓴다)
    if (/일자|날짜|비고/.test(s)) return '사용 안함'
    if (/공급가|금액/.test(s)) return T.itemAmount
    if (/수량/.test(s)) return T.itemQty
    if (/단가/.test(s)) return T.itemPrice
    if (/규격|사양|모델/.test(s)) return T.itemSpec
    return T.itemName                             // '품목명' · '품목'
  }
  if (/합계금액|총금액|합계/.test(s)) return T.total
  if (/공급가액|공급가/.test(s)) return T.supply
  if (/세액|부가세/.test(s)) return T.vat
  // 전송일자·발급일자도 날짜지만, 기준은 작성일자다(부가세 귀속 분기를 정하는 날).
  // 마법사는 같은 대상이 여러 컬럼에 걸리면 첫 컬럼을 쓰고, 홈택스 엑셀은 작성일자가 맨 앞이다.
  if (/작성일|거래일|발행일|발급일/.test(s)) return T.date
  if (/종류|유형/.test(s)) return T.docKind
  if (/규격|사양|모델/.test(s)) return T.itemSpec
  if (/수량/.test(s)) return T.itemQty
  if (/단가/.test(s)) return T.itemPrice
  if (/비고|메모/.test(s)) return T.memo
  return '사용 안함'
}

/**
 * 여러 행을 한 계산서로 묶는다 — 품목 상세를 포함해 받으면 계산서 1건이 품목 수만큼 행으로 온다.
 * 안 묶으면 같은 계산서가 여러 건으로 보이고, 중복으로 걸러도 품목이 통째로 버려진다.
 *
 * @param rows    파싱된 원본 행 배열
 * @param colFor  (target) => 그 대상에 연결된 엑셀 컬럼명 (없으면 undefined)
 * @returns 첫 행을 헤더로 삼고 __lines(품목)·__row(원본 행 번호)·__mergedRows(합쳐진 행 수)를 붙인 배열
 *
 * ⚠ 묶는 기준은 승인번호 하나뿐이다. 승인번호가 없으면 같은 계산서라는 근거가 없으므로
 *   묶지 않는다 — 잘못 합치면 별개 계산서의 금액이 통째로 사라진다.
 */
export const groupHometaxRows = (rows, colFor) => {
  const cell = (row, target) => {
    const c = colFor(target)
    return c != null ? String(row[c] ?? '').trim() : ''
  }
  const hasItemCols = [T.itemName, T.itemQty, T.itemPrice, T.itemAmount].some(t => colFor(t) != null)
  const lineOf = (row) => {
    if (!hasItemCols) return null
    const qty = numOf(cell(row, T.itemQty))
    const unitPrice = intOf(cell(row, T.itemPrice))
    const amount = intOf(cell(row, T.itemAmount)) || Math.round(qty * unitPrice)
    const line = {
      name: cell(row, T.itemName), spec: cell(row, T.itemSpec),
      qty, unit_price: unitPrice, amount,
    }
    return (line.name || line.amount) ? line : null   // 빈 품목 칸은 라인으로 만들지 않는다
  }

  const out = [], byConfirm = new Map()
  rows.forEach((row, i) => {
    const key = digits(cell(row, T.confirm))
    const head = key ? byConfirm.get(key) : null
    const line = lineOf(row)
    if (head) {
      if (line) head.__lines.push(line)
      head.__mergedRows++
      return
    }
    const merged = { ...row, __row: i, __lines: line ? [line] : [], __mergedRows: 1 }
    if (key) byConfirm.set(key, merged)
    out.push(merged)
  })
  return out
}

/**
 * 매핑된 한 행 → 청구서 데이터.
 * @param g       (target) => 셀 문자열
 * @param opts    { ourBizNo, defaultKind: 'issued'|'received', dueDays }
 *
 * @param row     groupHometaxRows가 만든 행(__lines·__mergedRows). 없으면 품목 없는 한 줄짜리로 본다.
 *
 * 방향은 우리 회사 사업자등록번호로 가른다: 공급자가 우리면 매출, 공급받는자가 우리면 매입.
 * 번호가 없거나 어느 쪽과도 안 맞으면 사용자가 고른 기본 방향을 쓰고 _by에 근거를 남긴다.
 */
export const mapHometaxRow = (g, opts = {}, row = null) => {
  const ourBiz = digits(opts.ourBizNo)
  const supBiz = digits(g(T.supBiz))
  const buyBiz = digits(g(T.buyBiz))

  let kind, by
  if (ourBiz && supBiz === ourBiz)      { kind = 'issued';   by = 'biz' }
  else if (ourBiz && buyBiz === ourBiz) { kind = 'received'; by = 'biz' }
  else { kind = opts.defaultKind === 'issued' ? 'issued' : 'received'; by = 'default' }

  // 거래처는 언제나 '우리 반대편'이다.
  const isSale = kind === 'issued'
  const vendorName = String((isSale ? g(T.buyName) : g(T.supName)) || '').trim()
  const vendorBiz  = String((isSale ? g(T.buyBiz)  : g(T.supBiz))  || '').trim()

  const issuedAt = normDate(g(T.date))
  const vat      = intOf(g(T.vat))
  const supplyIn = intOf(g(T.supply))
  const totalIn  = intOf(g(T.total))
  // 셋 중 빠진 값은 나머지로 채운다(홈택스 양식에 따라 합계 또는 공급가액만 오는 경우가 있다)
  const supply = supplyIn || (totalIn ? totalIn - vat : 0)
  const total  = totalIn || (supply + vat)

  const docKind = String(g(T.docKind) || '')
  // 세액이 있으면 과세. 세액 0은 면세(계산서)가 기본이고, '영세'라고 적힌 것만 영세다.
  // 영세를 면세로 넣으면 과세표준에서 빠지므로 문자열을 근거로만 판정한다.
  const taxType = vat > 0 ? '과세' : (/영세/.test(docKind) ? '영세' : '면세')

  const lines = Array.isArray(row?.__lines) ? row.__lines : []

  return {
    kind,
    _by: by,                         // 'biz' = 사업자번호로 판정 / 'default' = 기본 방향
    _mergedRows: row?.__mergedRows || 1,
    lines,                           // 품목 내역(invoice_lines). 품목 칸을 안 쓰면 빈 배열
    vendor_name: vendorName,
    biz_no: vendorBiz,
    issued_at: issuedAt,
    due_at: addDays(issuedAt, opts.dueDays),
    supply_amount: supply,
    vat_amount: vat,
    total_amount: total,
    tax_type: taxType,
    nts_confirm_no: String(g(T.confirm) || '').trim(),
    memo: String(g(T.memo) || '').trim(),
  }
}

/** 등록 가능한 행인가 — 하나라도 없으면 청구서가 쓸모없어지는 값들. */
export const isHometaxRowValid = (d) =>
  !!d.issued_at && !!d.vendor_name && d.total_amount > 0

/** 왜 등록할 수 없는지 한 줄로 (마법사의 '처리' 칸에 뜬다) */
export const hometaxInvalidLabel = (d) => {
  if (!d.issued_at)   return '작성일자 필요'
  if (!d.vendor_name) return '거래처 상호 필요'
  return '금액 필요'
}

/**
 * 행별 주의 문구. 등록은 되지만 값이 미심쩍은 것들 — 조용히 넘기면 신고 때 드러난다.
 * @param d  mapHometaxRow 결과
 */
export const hometaxRowWarns = (d, opts = {}) => {
  const w = []
  if (d._by !== 'biz') {
    w.push(digits(opts.ourBizNo)
      ? `공급자·공급받는자 어느 쪽도 우리 사업자번호와 맞지 않아 ‘${d.kind === 'issued' ? '매출' : '매입'}’로 넣어요`
      : `우리 회사 사업자등록번호가 없어 매출·매입을 가르지 못했어요 — ‘${d.kind === 'issued' ? '매출' : '매입'}’로 등록됩니다`)
  }
  if (d.supply_amount + d.vat_amount !== d.total_amount) {
    w.push('합계금액이 공급가액＋세액과 달라요 — 엑셀 값을 확인하세요')
  }
  // 과세인데 세액이 공급가의 10%가 아니면 컬럼이 밀렸을 가능성이 크다(1원 반올림은 허용)
  if (d.tax_type === '과세' && Math.abs(Math.round(d.supply_amount * 0.1) - d.vat_amount) > 1) {
    w.push('세액이 공급가액의 10%와 달라요 — 컬럼 매핑을 확인하세요')
  }
  // 품목 합계가 공급가액과 다르면 행이 덜 묶였거나 품목 컬럼이 잘못 연결된 것이다.
  // 청구서 금액은 계산서 헤더를 따르므로 장부는 맞지만, 지급결의서 품목 명세가 어긋난다.
  if (d.lines?.length) {
    const sum = d.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)
    if (sum !== d.supply_amount) {
      w.push(`품목 합계(${sum.toLocaleString()}원)가 공급가액과 달라요 — 금액은 계산서 기준으로 넣고 품목만 그대로 둡니다`)
    }
  }
  /* 작성일자가 먼 미래면 컬럼 매핑 실수나 엑셀 오타다.
   * 정기청구의 미리 발행처럼 가까운 미래는 정당하므로 막지 않고, 1년을 넘는 것만 알린다
   * (2030년 계산서가 조용히 들어가면 그 분기 부가세와 미수금에 계상된다). */
  const horizon = addDays(opts.today || localTodayStr(), 365)
  if (d.issued_at && horizon && d.issued_at > horizon) {
    w.push(`작성일자(${d.issued_at})가 1년 넘게 미래예요 — 컬럼이나 엑셀 값을 확인하세요`)
  }
  if (!d.nts_confirm_no) {
    w.push(d._mergedRows > 1
      ? '승인번호가 없어요 — 중복을 걸러내지 못합니다'
      : '승인번호가 없어요 — 다음에 같은 파일을 올리면 중복을 걸러내지 못합니다')
  }
  return w
}

/** 파일 안·기존 자료와의 중복 판정 키. 승인번호가 있으면 그것만으로 충분하다. */
export const hometaxMatchKey = (d, normName) => {
  const c = digits(d.nts_confirm_no)
  if (c) return 'c:' + c
  return `k:${d.kind}|${normName(d.vendor_name)}|${d.issued_at}|${d.total_amount}`
}
