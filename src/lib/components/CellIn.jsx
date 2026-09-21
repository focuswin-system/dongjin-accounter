/**
 * 문서 양식 안의 얇은 인라인 입력 칸 — 구매품의서·견적요청서·정산내역서가 함께 쓴다.
 *
 * 예전엔 세 화면에 같은 부품이 복사돼 있었고, 셋 다 금액을 `50000` 그대로 보여줬다
 * (옆 금액 칸은 `50,000` 인데 단가만 콤마가 없었다 — 화면 검증 2026-09-18).
 * money 를 켜면 콤마를 찍어 보여주고, 바깥으로는 숫자만 넘긴다(계산하는 쪽은 그대로 둔다).
 */
/* 음수는 허용할 때만 남긴다(맨 앞 한 자리). 정산내역서는 마이너스 줄이 실제로 있고,
   부호를 지우면 고치지 않고 저장만 해도 금액이 +로 뒤집힌다. */
const digitsOf = (v, neg) => {
  const raw = String(v ?? '').replace(neg ? /[^0-9-]/g : /[^0-9]/g, '')
  return neg ? (raw.startsWith('-') ? '-' + raw.replace(/-/g, '') : raw.replace(/-/g, '')) : raw
}

export const CellIn = ({ value, onChange, right, placeholder, money, allowNegative }) => {
  const digits = money ? digitsOf(value, allowNegative) : ''
  const shown = money
    ? (digits === '' || digits === '-' ? digits : Number(digits).toLocaleString('ko-KR'))
    : (value ?? '')
  return (
    <input className={`settle-cellin ${right || money ? 'num' : ''}`} value={shown} placeholder={placeholder}
      inputMode={money ? 'numeric' : undefined}
      onChange={e => onChange(money ? digitsOf(e.target.value, allowNegative) : e.target.value)}
      style={right || money ? { textAlign: 'right' } : undefined}/>
  )
}
