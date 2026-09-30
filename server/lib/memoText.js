/**
 * 청구서에서 저절로 생기는 적요 — **한 곳에서만** 만든다.
 *
 * 예전 문구는 `청구서 청구-2026-0007 정산` · `청구-2026-0008 매출 발행` 이었다.
 * 따로 정한 규칙이 아니라 처음 만들 때 칸을 비우지 않으려고 넣은 임시 문구였다(2026-07-07).
 *   - 청구번호는 이 프로그램 안에서만 쓰는 번호라 장부를 보는 사람(세무사·대표)은 뜻을 모른다.
 *   - 거래처는 전표·거래내역에 칸이 따로 있다 — 적요에 또 적으면 한 줄에 같은 말이 두 번이다.
 *   - '정산'은 개발자 말이다. 장부 적요는 **무슨 일이 있었는지**를 적는다.
 * 그래서 사람 말로 적고, 청구서 메모(예: '기성고 3차')가 있으면 뒤에 붙여 같은 거래처의 여러 건을 가른다.
 *
 * ⚠ 청구번호를 지운 대신 분개장 엑셀에 **청구번호 칸**을 따로 둔다(lib/voucherBook.js).
 *   그 파일에서는 적요 속 번호가 이 줄이 어느 청구서인지 알려주는 유일한 단서였다.
 * ⚠ 화면(세금계산서 상세의 입금 처리)이 칸을 미리 채울 때 같은 문구를 쓴다 — 바꾸면 거기도 같이 본다
 *   (src/screens/Billing.jsx settleMemoOf).
 *
 * @param inv 청구서 행 — kind('issued'|'received')와 memo 만 본다
 */
/* 청구서 메모 — 매입 엑셀 임포트로 들어온 것은 JSON 이다({src:'payables-import', item, buyer, vessel}).
   그대로 붙이면 적요에 중괄호가 찍힌다. 화면(src/lib/api.js parseMemo)과 같은 규칙으로 푼다 */
const memoText = (raw) => {
  const m = String(raw || '').trim()
  if (!m.startsWith('{')) return m
  try {
    const o = JSON.parse(m)
    if (String(o.src || '').startsWith('payables-import')) {
      return [o.item, o.buyer && o.buyer !== '공용' ? o.buyer : '', o.vessel && o.vessel !== '직영' ? o.vessel : '']
        .filter(Boolean).join(' · ')
    }
  } catch { /* JSON 이 아니다 — 그대로 쓴다 */ }
  return m
}
const tail = (inv) => {
  const m = memoText(inv?.memo)
  return m ? ` · ${m}` : ''
}
const issued = (inv) => inv?.kind === 'issued'

/** 발행(수취) 전표의 적요 */
const issueSummary = (inv) => (issued(inv) ? '매출 세금계산서 발행' : '매입 세금계산서 수취') + tail(inv)

/** 청구서에 붙여 만든 입금·지급 거래의 적요 */
const settleMemo = (inv) => (issued(inv) ? '매출대금 입금' : '매입대금 지급') + tail(inv)

module.exports = { issueSummary, settleMemo }
