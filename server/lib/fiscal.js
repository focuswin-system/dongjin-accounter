/* 회기(회계연도)·기수 — **저장하지 않고 계산한다.**
 *
 * 회사가 정하는 값은 셋뿐이다(company_info).
 *   fiscal_end_month  결산월 1–12
 *   fiscal_base_year  기준 회계연도 — **시작하는 해**로 센다(3월 결산 2026 = 2026.04.01~2027.03.31)
 *   fiscal_base_seq   그 회계연도의 기수
 *
 * 왜 해마다 행을 만들지 않나: "올해 회기 행을 누가 언제 만드나"라는 기억이 생긴다.
 * 정기 기능이 회차를 기억하다 어긋나 사고가 났던 것과 같은 모양이다. 셋만 있으면
 * 어느 날짜든 회기·기수·이름이 한 가지로 나온다.
 *
 * 회기 이름은 입력받지 않는다(사용자 확정 2026-09-15) — 12월 결산은 '2026년', 그 밖은 '26-27년'.
 *
 * ⚠ 계산은 여기 한 곳. 화면은 API(/api/company, /api/company/fiscal-preview)로만 받는다.
 */

const pad = (n) => String(n).padStart(2, '0')
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()   // m: 1–12

const validMonth = (m) => Number.isInteger(m) && m >= 1 && m <= 12
const validYear = (y) => Number.isInteger(y) && y >= 1900 && y <= 2200
const validSeq = (s) => Number.isInteger(s) && s >= 1 && s <= 999

/** 회계연도 year(시작하는 해)의 기간 */
function periodOf(endMonth, year) {
  const startMonth = (endMonth % 12) + 1
  const endYear = endMonth === 12 ? year : year + 1
  return {
    start: `${year}-${pad(startMonth)}-01`,
    end: `${endYear}-${pad(endMonth)}-${pad(lastDay(endYear, endMonth))}`,
  }
}

/** 날짜(YYYY-MM-DD)가 속한 회계연도(시작하는 해) */
function fiscalYearOf(endMonth, date) {
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const startMonth = (endMonth % 12) + 1
  if (endMonth === 12) return y
  return m >= startMonth ? y : y - 1
}

function nameOf(endMonth, year) {
  if (endMonth === 12) return `${year}년`
  const yy = (n) => pad(n % 100)
  return `${yy(year)}-${yy(year + 1)}년`
}

/**
 * 회사 설정으로 회계연도 year 의 회기를 낸다.
 * @returns {{ year, seq: number|null, name, start, end } | null}  결산월이 없으면 null
 *   seq 는 기준 기수가 없거나 1 미만(회사가 생기기 전)이면 null.
 */
function fiscalOfYear(cfg, year) {
  const endMonth = Number(cfg?.fiscal_end_month)
  if (!validMonth(endMonth) || !validYear(year)) return null
  const baseYear = Number(cfg?.fiscal_base_year)
  const baseSeq = Number(cfg?.fiscal_base_seq)
  let seq = null
  if (validYear(baseYear) && validSeq(baseSeq)) {
    const s = baseSeq + (year - baseYear)
    seq = s >= 1 ? s : null
  }
  return { year, seq, name: nameOf(endMonth, year), ...periodOf(endMonth, year) }
}

/** 날짜가 속한 회기 */
function fiscalOfDate(cfg, date) {
  const endMonth = Number(cfg?.fiscal_end_month)
  if (!validMonth(endMonth) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null
  return fiscalOfYear(cfg, fiscalYearOf(endMonth, date))
}

/**
 * 입력값 검사 — 저장·미리보기가 같은 규칙을 쓴다.
 * @returns {{ ok: true, value: { fiscal_end_month, fiscal_base_year, fiscal_base_seq } } | { ok: false, error }}
 *   기준 연도·기수는 **둘 다 있거나 둘 다 없어야** 한다(하나만 있으면 기수를 셀 수 없다).
 */
function parseFiscal({ fiscal_end_month, fiscal_base_year, fiscal_base_seq }) {
  const m = Number(fiscal_end_month)
  if (!validMonth(m)) return { ok: false, error: '결산월을 1~12월 중에서 골라주세요' }
  const blank = (v) => v === null || v === undefined || v === ''
  if (blank(fiscal_base_year) && blank(fiscal_base_seq)) {
    return { ok: true, value: { fiscal_end_month: m, fiscal_base_year: null, fiscal_base_seq: null } }
  }
  const y = Number(fiscal_base_year)
  const s = Number(fiscal_base_seq)
  if (!validYear(y)) return { ok: false, error: '회계연도를 확인해주세요' }
  if (!validSeq(s)) return { ok: false, error: '기수는 1~999 사이 숫자로 입력해주세요' }
  return { ok: true, value: { fiscal_end_month: m, fiscal_base_year: y, fiscal_base_seq: s } }
}

module.exports = { fiscalOfYear, fiscalOfDate, fiscalYearOf, parseFiscal }
