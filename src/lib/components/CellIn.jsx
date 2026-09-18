/**
 * 문서 양식 안의 얇은 인라인 입력 칸 — 구매품의서·견적요청서·정산내역서가 함께 쓴다.
 *
 * 예전엔 세 화면에 같은 부품이 복사돼 있었고, 셋 다 금액을 `50000` 그대로 보여줬다
 * (옆 금액 칸은 `50,000` 인데 단가만 콤마가 없었다 — 화면 검증 2026-09-18).
 * money 를 켜면 콤마를 찍어 보여주고, 바깥으로는 숫자만 넘긴다(계산하는 쪽은 그대로 둔다).
 */
const digitsOf = (v) => String(v ?? '').replace(/[^0-9]/g, '')

export const CellIn = ({ value, onChange, right, placeholder, money }) => {
  const shown = money
    ? (digitsOf(value) === '' ? '' : Number(digitsOf(value)).toLocaleString('ko-KR'))
    : (value ?? '')
  return (
    <input className={`settle-cellin ${right || money ? 'num' : ''}`} value={shown} placeholder={placeholder}
      inputMode={money ? 'numeric' : undefined}
      onChange={e => onChange(money ? digitsOf(e.target.value) : e.target.value)}
      style={right || money ? { textAlign: 'right' } : undefined}/>
  )
}
