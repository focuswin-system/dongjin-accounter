/**
 * 잔액을 볼 자격 — 계좌 목록(routes/accounts.js)과 이체 상세(routes/transactions.js)가 **같은 규칙**을 쓴다.
 * 두 곳에 따로 두면 한쪽만 고쳐져, 목록에선 가린 잔액이 이체 상세에선 보이게 된다.
 *
 * 계좌 목록 자체는 결제수단이라 누구나 골라야 하지만 잔액은 다르다.
 * 권한 게이트가 목록 조회를 공용으로 열어 놨기 때문에(apiPerms LOOKUP) 여기서 한 번 더 가른다.
 * 역할 미배정 계정은 제한 없음(게이트와 같은 규칙)이라 req.perms 가 비면 통과시킨다.
 */
const canSeeBalance = (req) => {
  const perms = req.perms
  if (!perms || perms.size === 0) return true
  return ['master_accountBalance', 'master_account', 'cash_report', 'home']
    .some(r => perms.has(`${r}:view`))
}

/* 개인 계좌(대표 사비)의 **잔액**은 마스터에게만 보인다.
 * 목록에서 통째로 빼지는 않는다 — 중소기업은 대표 개인 계좌로 회사 비용을 내는 일이
 * 실제로 있고, 그때 실무자가 거래를 등록하려면 계좌를 고를 수 있어야 한다.
 * 가려야 하는 건 '그 통장에 얼마 있나'이지 '그 통장이 있다'가 아니다.
 * 가르는 방식은 계정 관리와 같다(users.role='admin' — routes/auth.js isMaster). */
const canSeePersonal = (req) => req.user?.role === 'admin'

module.exports = { canSeeBalance, canSeePersonal }
