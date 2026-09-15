/* 우리 회사 사업자번호 — 형식 검사와 표기.
 *
 * 받는 모양은 둘뿐이다.
 *   10자리  사업자등록번호. 마지막 자리 검증 숫자까지 맞아야 한다(국세청 규칙).
 *           오타 한 자리는 거래명세표에 그대로 찍히고 세금계산서 매출·매입 판정이 틀어지므로
 *           저장 전에 여기서 걸러야 한다.
 *   6자리   개인 용도(주민번호 앞자리 YYMMDD). 월·일 범위만 본다.
 *
 * ⚠ 거래처 사업자번호에는 쓰지 않는다. 거래처는 엑셀·홈택스에서 온갖 모양으로 들어오고
 *   틀려도 막을 이유가 없다(찾기 키일 뿐이다). 이건 **우리 번호**만의 규칙이다.
 */

const digitsOf = (v) => String(v ?? '').replace(/\D/g, '')

const WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5]

function checksumOk(d) {
  const n = d.split('').map(Number)
  let sum = 0
  for (let i = 0; i < 9; i++) sum += n[i] * WEIGHTS[i]
  sum += Math.floor((n[8] * 5) / 10)
  return (10 - (sum % 10)) % 10 === n[9]
}

/**
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 *   value 는 저장할 표기 — 10자리는 000-00-00000, 6자리는 숫자 그대로.
 */
function parseOwnBizNo(input) {
  const d = digitsOf(input)
  if (d.length === 10) {
    if (!checksumOk(d)) return { ok: false, error: '사업자번호가 올바르지 않아요. 다시 확인해주세요' }
    return { ok: true, value: `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` }
  }
  if (d.length === 6) {
    const mm = Number(d.slice(2, 4))
    const dd = Number(d.slice(4, 6))
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
      return { ok: false, error: '주민번호 앞 6자리(생년월일)가 올바르지 않아요' }
    }
    return { ok: true, value: d }
  }
  return { ok: false, error: '사업자번호 10자리 또는 주민번호 앞 6자리를 입력해주세요' }
}

/** 두 번호가 같은가 — 하이픈 유무는 따지지 않는다 */
const sameBizNo = (a, b) => digitsOf(a) === digitsOf(b)

module.exports = { parseOwnBizNo, sameBizNo, digitsOf }
