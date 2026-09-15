/* 회사 정보 변경 계획 — **무엇을 어떻게 바꿀지** 정하고 검사한다. DB 는 모른다.
 *
 * routes/company.js 의 저장(PUT)이 쓴다. 규칙을 라우트에서 떼어낸 이유는 단위 테스트다.
 *
 * @param cur   지금 행(없으면 { id })
 * @param body  요청 본문 — **들어 있는 칸만** 바꾼다
 * @param today 오늘(YYYY-MM-DD) — 기수를 '올해 회기의 기수'로 받기 때문에 필요하다
 * @returns {{ ok: true, set, after } | { ok: false, status, error, field? }}
 *   field — 어느 칸 때문인지. 화면이 그 칸 아래에 오류를 붙인다(문구로 가르면 문구를 고칠 때 깨진다).
 */
const { parseOwnBizNo, sameBizNo } = require('./bizNo')
const { parseFiscal, fiscalYearOf, fiscalOfDate } = require('./fiscal')

const validMonth = (m) => Number.isInteger(m) && m >= 1 && m <= 12

/* 사업자번호가 들어 있으면 준비된 회사다 — 첫 설정 화면을 띄울지 이것 하나로 가른다
   (새 회사를 만들 때 상호만 심기 때문에 '행이 있나'로는 못 가른다. /api/setup/status 와 같은 기준). */
const hasBizNo = (row) => !!String(row?.biz_no || '').trim()

/* DB 칸 크기와 **같게** 둔다(db.js company_info). 크면 STRICT 모드에서 400 이 아니라 'Data too long' 500 이 난다. */
const MAX_LEN = { name: 255, ceo: 100, biz_type: 100, biz_item: 100, address: 500, phone: 50, fax: 50, email: 200,
  main_account: 255 }
const TEXT_FIELDS = Object.keys(MAX_LEN)

function planCompanyChange(cur, body, today) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
  const fail = (status, error, field) => ({ ok: false, status, error, ...(field ? { field } : {}) })
  const set = {}

  for (const k of TEXT_FIELDS) {
    if (!has(k)) continue
    const v = String(body[k] ?? '').trim()
    if (v.length > MAX_LEN[k]) return fail(400, '입력이 너무 길어요', k)
    set[k] = v
  }

  if (has('sub_biz_no')) {
    const v = String(body.sub_biz_no ?? '').replace(/\D/g, '')
    if (v && v.length !== 4) return fail(400, '종사업장번호는 숫자 4자리예요', 'sub_biz_no')
    set.sub_biz_no = v || null
  }

  /* 사업자번호 — 바꿀 수 있다(사용자 확정 2026-09-15: "추후 회사정보에서 변경 가능해야").
     비울 수는 없고(아래 필수 검사), 바꿀 때마다 형식을 본다. 같은 번호면 표기(하이픈)를 건드리지 않는다. */
  if (has('biz_no')) {
    // 칸을 지우고 저장했는데 조용히 옛 번호가 남으면 저장이 안 된 줄 안다 — 막고 말한다
    if (!String(body.biz_no ?? '').trim()) return fail(400, '사업자번호를 입력해주세요', 'biz_no')
  }
  if (has('biz_no') && !sameBizNo(body.biz_no, cur?.biz_no)) {
    const p = parseOwnBizNo(body.biz_no)
    if (!p.ok) return fail(400, p.error, 'biz_no')
    set.biz_no = p.value
  }

  // 0~28 만 받는다 — 29~31 은 짧은 달에 존재하지 않아 그 달만 조용히 어긋난다
  if (has('closing_day')) set.closing_day = Math.min(28, Math.max(0, parseInt(body.closing_day, 10) || 0))
  if (has('week_start_day')) set.week_start_day = Math.min(6, Math.max(0, parseInt(body.week_start_day, 10) || 0))
  /* 주거래 계좌·카드 — 화면의 계좌 칩을 어느 순서로 세울지 정하는 값(accounts.id).
     빈 문자열은 '지정 안 함'이라 null 로 눕힌다 — ''로 두면 어떤 계좌와도 안 맞는 유령 값이 남는다. */
  for (const k of ['main_in_account_id', 'main_out_account_id', 'main_card_id']) {
    if (has(k)) set[k] = body[k] ? String(body[k]) : null
  }

  /* 회기 — 화면은 결산월과 **올해 회기의 기수**만 받는다(회계연도 칸 없음, 사용자 확정 2026-09-15).
     저장은 '기준 연도 = 오늘이 속한 회계연도'로 한다. 결산월만 바꾸면 올해 기수는 그대로 두고 기준을 다시 잡는다.
     기수는 선택이다 — 비우면 기간·이름만 계산되고 기수는 없음. */
  if (has('fiscal_end_month') || has('fiscal_base_seq')) {
    const m = Number(has('fiscal_end_month') ? body.fiscal_end_month : (cur?.fiscal_end_month ?? 12))
    if (!validMonth(m)) return fail(400, '결산월을 1~12월 중에서 골라주세요', 'fiscal_end_month')
    const todaySeq = fiscalOfDate(cur, today)?.seq ?? ''
    const seqNow = has('fiscal_base_seq') ? body.fiscal_base_seq : todaySeq
    const blank = seqNow === null || seqNow === undefined || seqNow === ''
    /* 지금과 같으면(결산월 그대로·올해 기수 그대로) 기준을 다시 잡지 않는다 — 저장할 때마다 기준이 흔들리지 않게 */
    const same = m === Number(cur?.fiscal_end_month) && String(blank ? '' : seqNow) === String(todaySeq)
    if (!same) {
      const p = parseFiscal({
        fiscal_end_month: m,
        fiscal_base_year: blank ? '' : fiscalYearOf(m, today),
        fiscal_base_seq: blank ? '' : seqNow,
      })
      if (!p.ok) return fail(400, p.error, 'fiscal_base_seq')
      Object.assign(set, p.value)
    }
  }

  const after = { ...cur, ...set }
  if (!String(after.name || '').trim()) return fail(400, '상호를 입력해주세요', 'name')
  if (!hasBizNo(after)) return fail(400, '사업자번호를 입력해주세요', 'biz_no')
  return { ok: true, set, after }
}

module.exports = { planCompanyChange, hasBizNo }
