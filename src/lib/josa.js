/**
 * 조사 — 앞말의 받침을 보고 을/를·은/는·이/가·와/과를 고른다.
 *
 * 화면 문구에 `을(를)`·`이(가)` 처럼 둘 다 적어 두면 읽는 사람이 한 번 걸린다.
 * 이름은 회사마다 다르니("세금계산서"·"거래처"·"부가세") 문구를 손으로 맞출 수 없다 — 규칙으로 고른다.
 *
 * 받침 판정은 한글 음절(가~힣)만 본다. 영문·숫자로 끝나면 읽는 소리를 알 수 없으므로
 * **받침 없는 쪽**(를·는·가·와)으로 둔다 — 'CEO를', '3를'보다 어색한 경우가 드물다.
 * 예외로 숫자 1·3·6·7·8·0 은 읽을 때 받침이 있다(일·삼·육·칠·팔·영).
 */
const LAST_DIGIT_HAS_BATCHIM = { 0: true, 1: true, 3: true, 6: true, 7: true, 8: true }

/** 마지막 글자에 받침이 있나 */
export const hasBatchim = (word) => {
  const s = String(word ?? '').trim()
  if (!s) return false
  const ch = s[s.length - 1]
  const code = ch.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0
  if (ch >= '0' && ch <= '9') return !!LAST_DIGIT_HAS_BATCHIM[ch]
  return false
}

/**
 * 말 뒤에 조사를 붙인다. `josa('세금계산서', '을')` → `'세금계산서를'`
 * @param word 앞말
 * @param kind '을' | '은' | '이' | '와' | '으로' 중 하나(받침 있는 쪽 형태로 적는다)
 */
export const josa = (word, kind) => {
  const s = String(word ?? '')
  const pair = { 을: '를', 은: '는', 이: '가', 와: '과', 으로: '로' }
  const withB = kind in pair ? kind : '을'
  // 와/과는 짝이 반대다 — 받침이 있으면 '과', 없으면 '와'
  if (withB === '와') return s + (hasBatchim(s) ? '과' : '와')
  // '으로'는 ㄹ 받침이면 '로'다(예: '서울로')
  if (withB === '으로') {
    const ch = s[s.length - 1] || ''
    const code = ch.charCodeAt(0)
    const jong = code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 : -1
    return s + (jong === 0 || jong === 8 ? '로' : '으로')
  }
  return s + (hasBatchim(s) ? withB : pair[withB])
}
