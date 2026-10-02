import { Icon } from './ui'
import { api } from './api'

/* 입력 칸에서 '거래처로 추가'를 누를 때 — **화면 일곱 곳이 이 하나를 쓴다.**
 *
 * 왜 하나인가 — 곳마다 따로 부르다 보니 한쪽은 고른 거래처를 id 로, 다른 쪽은 친 이름으로 담았고,
 *   실패하면 어떤 곳은 서버가 준 이유를, 어떤 곳은 '실패했어요'만, 어떤 곳은 아무 말도 안 했다.
 *
 * 하는 일
 *   · 이름이 **비슷한** 거래처가 있으면 묻는다(서버 409 similar_vendor — lib/vendorName.js).
 *     '금강노인종합복지회관'이 '복지관' 옆에 새로 생겨 같은 입금이 두 줄 선 적이 있다(운영 fowin).
 *     [그 거래처 쓰기] / [다른 곳 — 새로 등록] / [취소] — 짐작해서 잇지 않는다.
 *   · 결과를 같은 말로 알린다.
 *
 * @returns { id, name, gubu } — 고르거나 만든 거래처. 취소·실패면 null(알림은 이미 했다)
 *   ⚠ 받는 쪽은 **name 을 친 글자(q) 대신 이 값으로** 담는다 — 비슷한 거래처를 고르면 이름이 다르다.
 */
export async function addVendorAsking({ confirm, toast }, payload) {
  let res = await api.addVendor(payload)
  if (!res.ok && res.code === 'similar_vendor' && res.candidates?.length) {
    const c = res.candidates[0]
    const ans = await confirm({
      tone: 'warn', icon: <Icon.Warn size={22}/>, title: '이름이 비슷한 거래처가 있어요',
      body: `'${payload.name}' — 이미 있는 거래처 '${c.name}'. 같은 곳인가요?`,
      detail: '같은 곳을 두 벌 만들면 입금·미수금이 갈라지고, 같은 돈이 두 번 들어와도 못 잡아요.',
      // 이름은 본문에 있다 — 단추에 넣으면 길어져 두 줄로 꺾인다
      confirmLabel: '기존 거래처 쓰기', altLabel: '다른 곳 — 새로 등록', cancelLabel: '취소',
    })
    if (ans === true) {
      toast.push(`"${c.name}" 거래처를 골랐어요`)
      return { id: c.id, name: c.name, gubu: c.gubu }
    }
    if (ans !== 'alt') return null
    res = await api.addVendor({ ...payload, allow_similar: true })
  }
  if (!res.ok) { toast.push(res.error || '거래처를 등록하지 못했어요', { tone: 'warn' }); return null }
  toast.push(res.existed ? `이미 있는 "${payload.name}" 거래처를 골랐어요` : `"${payload.name}" 거래처를 등록했어요`)
  return { id: res.id, name: payload.name, gubu: res.gubu || payload.gubu }
}
