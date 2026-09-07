/**
 * 주문(계약) 고르기 — **거래처를 골랐으면 그 거래처 주문만.**
 *
 * ── 왜 한곳에 두나 ──
 * 이 칸이 네 곳에 있다: 청구서 폼(Billing) · 거래 폼(Form) · 정기입금 · 정기지출(Master).
 * 화면마다 목록을 따로 만들면 한 곳만 고치고 끝나서 같은 지적을 네 번 듣게 된다.
 * 규칙이 하나면 새 화면이 생겨도 여기만 가져다 쓰면 된다.
 *
 * ⚠ **원가 귀속 칸에는 쓰지 않는다.**
 *   그 칸은 "어느 수주건 때문에 쓴 돈인가"를 고르는 자리다. 지출의 거래처는 외주업체
 *   (매입처)이고 고르는 건 발주처와의 수주라, 거래처로 거르면 후보가 늘 0건이 된다.
 *   두 값은 서로 다른 축이다(server/routes/contracts.js 의 contract_id ↔ cost_contract_id).
 */

/**
 * 고를 수 있는 주문만 남긴다.
 * 거래처를 아직 안 골랐으면 전부 보여준다 — 주문부터 고르는 사람도 있고,
 * 그때는 주문이 거래처를 채워 준다.
 */
export const contractsForVendor = (contracts, vendorId) => {
  if (!vendorId) return contracts || []
  return (contracts || []).filter(c => c.vendor_id === vendorId)
}

/**
 * 지금 고른 주문이 지금 고른 거래처의 것인가.
 *
 * 거래처를 **바꿨을 때** 쓴다. 안 맞는데 그냥 두면 목록에서는 사라졌는데 값은 남아,
 * 딴 회사 주문이 붙은 채로 저장된다(화면에는 아무 표시도 없다).
 * 주문을 모르는 경우(목록에 아직 없음)는 참으로 본다 — 모른다고 지우면 안 된다.
 */
export const contractFitsVendor = (contracts, contractId, vendorId) => {
  if (!contractId || !vendorId) return true
  const c = (contracts || []).find(x => x.id === contractId)
  return !c || c.vendor_id === vendorId
}
