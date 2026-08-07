/* 계좌를 사람이 고를 때 쓰는 이름.
 *
 * 계좌 이름은 **유일하지 않다.** 실제로 "국민카드-공용"이라는 공용 카드가 두 장 등록돼 있고
 * (끝자리 2847 / 9862), 화면에는 둘 다 그냥 "국민카드-공용"으로 섰다. 어느 쪽인지 고를 방법이
 * 없을 뿐 아니라, 이름으로 계좌를 되찾는 코드(FilterSelect 처럼 이름 목록을 다루는 부품)는
 * 늘 **첫 번째 것**을 집는다 — 사용자가 두 번째를 골라도 조용히 다른 카드로 처리된다.
 *
 * 그래서 **이름이 겹칠 때만** 뒤에 식별자를 붙인다. 안 겹치는 계좌까지 번호를 달면
 * 화면만 시끄러워지고 읽는 데 방해가 된다(정상에는 표식을 붙이지 않는다).
 */

/** 끝 4자리. 카드·계좌번호에 하이픈·공백이 섞여 있어 숫자만 남기고 자른다. */
const tail4 = (acc) => {
  const digits = String(acc?.number || '').replace(/\D/g, '')
  return digits ? digits.slice(-4) : ''
}

/**
 * 계좌 목록 → { id, name, label } 배열. label 은 화면에 보여줄 이름이고,
 * 이름이 겹치는 계좌에만 은행·끝자리가 붙는다.
 */
export function accountLabels(accounts = []) {
  const dupes = new Set()
  const seen = new Set()
  for (const a of accounts) {
    if (seen.has(a.name)) dupes.add(a.name)
    seen.add(a.name)
  }
  return accounts.map(a => {
    if (!dupes.has(a.name)) return { id: a.id, name: a.name, label: a.name }
    /* 은행 이름 키가 두 가지다 — api 어댑터는 bankName, 서버 raw 행은 bank.
       한쪽만 읽으면 조용히 빠져서 끝자리만 남는다(실제로 그랬다). */
    const mark = [a.bankName || a.bank, tail4(a)].filter(Boolean).join(' ')
    return { id: a.id, name: a.name, label: mark ? `${a.name} (${mark})` : a.name }
  })
}

/** 화면에서 고른 label 로 계좌 id 를 되찾는다. 못 찾으면 null(= 지정 안 함). */
export function accountIdByLabel(accounts = [], label) {
  if (!label) return null
  return accountLabels(accounts).find(a => a.label === label)?.id || null
}
