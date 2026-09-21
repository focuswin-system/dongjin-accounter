import { api } from './api'
import { Icon } from './ui'

/**
 * 저장 직전에 **"이 돈, 그 청구서 건인가요?"** 를 묻는다.
 *
 * ── 왜 묻나 ──
 * 청구서를 안 걸고 거래만 적으면 통장 잔액은 맞는데 **미수금·미지급금이 안 줄어든다.**
 * 그 차이는 며칠 뒤 "안 받은 걸로 뜨는데 통장엔 들어와 있다"로 나타나고, 그때는
 * 어느 입금이 어느 청구서였는지 사람이 다시 찾아야 한다. 적는 순간이 가장 싸다.
 *
 * ── 언제 묻나 ──
 * 서버가 같은 거래처의 남은 청구서를 보고 금액 관계를 판정해 준다(transactions/entry-hints).
 *   exact    남은 금액이 **딱 맞는다** → 묻는다
 *   partial  남은 금액이 더 많다(부분 입금) → 묻는다
 *   over     들어온 돈이 더 많다 → **안 묻는다.** 여기서 붙이면 과입금이 되고,
 *            여러 건을 한 번에 받은 경우라 청구서 화면에서 나눠야 한다
 * 후보가 여럿이면 첫 건만 묻지 않는다 — 어느 것인지 사람이 골라야 하므로 목록으로 보낸다.
 *
 * ⚠ 안 묻고 넘어가는 것도 정상이다. 청구서 없는 돈(경비·공과금·잡수입)이 더 많다.
 *
 * @returns 고른 청구서 | null(그냥 등록) — 부르는 쪽이 이 값으로 정산 경로를 탄다
 */
export async function askInvoiceLink(confirm, { kind, vendorId, accountId, amount, date }) {
  if (!vendorId || !(amount > 0) || !date) return null
  const hints = await api.getEntryHints({ vendorId, accountId, kind, date, amount })
  const open = (hints?.openInvoices || []).filter(iv => iv.match === 'exact' || iv.match === 'partial')
  if (!open.length) return null

  const io = kind === 'income' ? '입금' : '지급'
  const 미 = kind === 'income' ? '미수금' : '미지급금'
  const won = (n) => Number(n || 0).toLocaleString('ko-KR')

  if (open.length === 1) {
    const iv = open[0]
    const ok = await confirm({
      tone: 'brand', icon: <Icon.Receipt size={22}/>,
      title: `${iv.invoice_no} 건인가요?`,
      body: `${iv.match === 'exact' ? '남은 금액이 딱 맞아요' : `남은 ${won(iv.remaining)}원 중 ${won(amount)}원`}`
        + ` — 연결하면 ${미}이 함께 정리돼요.`,
      detail: '아니면 그냥 통장 거래로만 남깁니다.',
      confirmLabel: `${iv.invoice_no}에 연결`, cancelLabel: '그냥 등록',
    })
    return ok ? iv : null
  }

  /* 여러 건이면 고르는 일이다 — 확인창으로 "예/아니오"를 물으면 엉뚱한 건에 붙는다.
     묻기만 하고, 고르는 것은 청구서 목록이 있는 자리에서 한다. */
  const ok = await confirm({
    tone: 'brand', icon: <Icon.Receipt size={22}/>,
    title: `${io}할 청구서가 ${open.length}건 있어요`,
    body: `이 거래처에 남은 청구서가 여러 건이에요. 어느 건인지 골라야 ${미}이 정확히 맞습니다.`,
    detail: open.map(iv => `${iv.invoice_no} · 남은 ${won(iv.remaining)}원`).join('\n'),
    confirmLabel: '청구서 고르러 가기', cancelLabel: '그냥 등록',
  })
  return ok ? { pickMany: true, list: open } : null
}
