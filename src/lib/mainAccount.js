/**
 * 주거래 계좌·카드를 앞에 세운다.
 *
 * ── 왜 ──
 * 계좌 목록이 어디서나 `ORDER BY name` — 가나다순이었다. 매일 쓰는 주거래 통장이
 * 목록 일곱 번째에 있을 수 있고, 그러면 청구서를 끊을 때마다 눈으로 찾아야 한다.
 * 실사용 문의: "회사의 주입금/주지출 계좌·카드를 회사정보에서 지정하고, 업무에 따라
 * 바로바로 그 계좌가 앞에 정렬되고 선택되는 기능이 필요함."
 *
 * ── ⚠ 앞에 세우기만 한다. 자동 선택은 안 한다 ──
 * 미리 골라 두면 사용자가 확인 없이 지나가고, 다른 통장에서 나간 돈이 주거래로 기록된다.
 * 실제로 그런 사고를 겪었다 — 결제수단을 바꿔도 계좌 선택이 남아 현금 지출이 법인카드에
 * 달렸다(운영 3건). **순서를 바꾸는 것은 틀린 기록을 만들지 않지만, 미리 고르는 것은 만든다.**
 *
 * 표시도 한다 — 앞에 있는 이유를 말해주지 않으면 "왜 순서가 이렇지"가 된다.
 */

/** 업무 갈래 → 회사 정보의 어느 칸을 볼 것인가 */
export const MAIN_KEY = {
  in:   'main_in_account_id',    // 돈이 들어오는 일 — 청구서 입금, 수시입금
  out:  'main_out_account_id',   // 돈이 나가는 일 — 지급, 경비, 이체
  card: 'main_card_id',          // 카드로 쓰는 일
}

/**
 * 주거래를 맨 앞으로, 나머지는 원래 순서 그대로.
 *
 * ⚠ 나머지를 다시 정렬하지 않는다. 서버가 이름순으로 주는 순서를 사람들이 이미 외우고
 *   있어서, 여기서 또 흔들면 "어제 세 번째였던 게 오늘은 다섯 번째"가 된다.
 *
 * @param accounts 계좌 목록
 * @param company  회사 정보(getCompany 결과). 없으면 원래 순서 그대로
 * @param use      'in' | 'out' | 'card'
 */
export function withMainFirst(accounts = [], company = null, use = 'out') {
  const id = company?.[MAIN_KEY[use]] || null
  if (!id) return accounts
  const idx = accounts.findIndex(a => a.id === id)
  if (idx <= 0) return accounts          // 없거나 이미 맨 앞
  const head = accounts[idx]
  return [head, ...accounts.slice(0, idx), ...accounts.slice(idx + 1)]
}

/** 이 계좌가 그 업무의 주거래인가 — 칩에 표시를 달 때 쓴다 */
export const isMainAccount = (account, company, use = 'out') =>
  !!account && !!company && account.id === company[MAIN_KEY[use]]

/** 주거래 표시 — 한 곳에서 만들어 화면마다 다른 말이 안 되게 한다 */
export const MAIN_BADGE = '주거래'
