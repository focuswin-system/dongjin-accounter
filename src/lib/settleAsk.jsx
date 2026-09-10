import { api } from './api'
import { Icon } from './ui'

/**
 * 청구서 정산(입금·지급 연결) — **같은 거래를 두 번 만들지 않게 되묻는 자리.**
 *
 * 서버는 거래를 새로 만들기 직전에 같은 거래처·같은 날·같은 금액의 거래가 이미 있으면
 * 409 `dup_txn` 으로 되묻는다(통장 한 줄이 장부 두 줄이 되는 걸 막는다).
 * 그런데 되묻는 말을 받아 줄 화면이 없으면 사용자는 **막혔다는 사실만** 보고 길이 없다.
 *
 * 정산을 부르는 화면은 셋이고(청구서 상세·거래 입력·정기 회차) 전부 거래를 새로 만들 수 있다.
 * 화면마다 확인창을 복사해 두면 문구가 서로 갈라지므로 여기 한 곳에 둔다.
 *
 * 기존 거래를 잇는 경로(txnId 가 있는 경우)는 서버가 애초에 묻지 않는다 — 새 돈이 안 생긴다.
 *
 * @returns api.matchInvoice 와 같은 모양. 사용자가 취소하면 `{ ok:false, cancelled:true }`.
 */
export async function matchInvoiceAsking(confirm, invoiceId, payload) {
  const r = await api.matchInvoice(invoiceId, payload)
  if (r.ok || r.code !== 'dup_txn') return r
  const ok = await confirm({
    tone: 'warn', icon: <Icon.Warn size={22}/>,
    title: '같은 거래가 이미 있어요',
    body: `${r.error} 그래도 새 거래로 등록하면 장부에 같은 돈이 두 줄 남습니다.`,
    confirmLabel: '그래도 새로 등록',
  })
  if (!ok) return { ok: false, cancelled: true, error: r.error, code: r.code }
  return api.matchInvoice(invoiceId, { ...payload, allowNew: true })
}
