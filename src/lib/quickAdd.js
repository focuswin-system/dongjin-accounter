/**
 * 그 자리에서 기준정보 등록하기 — 입력 중에 목록에 없는 값을 만났을 때.
 *
 * 원래는 화면을 나가 기준정보에서 만들고 돌아와야 했다. 거래를 입력하다 처음 보는
 * 품목 하나 때문에 작성 중인 내용을 두고 나가는 것은 실수를 부른다(돌아오면 다시 채워야 하니
 * 대충 비슷한 걸 고르게 된다 — 그렇게 들어간 값은 나중에 장부에서 찾아내기 어렵다).
 *
 * 거래처는 이미 이렇게 동작하고 있었다(Form.jsx). 같은 방식을 품목·비목으로 넓힌다.
 *
 * ⚠ 여기서 만드는 것은 '최소 정보'다. 비목의 과세유형·공제여부, 품목의 규격·단가 같은
 *   속성은 서버 기본값으로 들어간다(비목은 과세 10%·공제 가능). 정확한 값은 나중에
 *   기준정보 화면에서 보완한다 — 입력을 막지 않는 것이 우선이다.
 */
import { api } from './api'

/**
 * 비목을 등록하고 목록을 새로고침한다.
 * @param {string} name 사용자가 입력한 이름
 * @param {{ kind: 'inc'|'exp', setCategories: Function, toast?: object }} ctx
 * @returns {Promise<string|null>} 등록된 이름(실패하면 null)
 */
export async function quickAddCategory(name, { kind, setCategories, toast }) {
  const nm = String(name || '').trim()
  if (!nm) return null
  const res = await api.addCategory({ kind, name: nm })
  if (!res.ok) {
    toast?.push(res.error || '비목을 등록하지 못했어요', { tone: 'warn' })
    return null
  }
  setCategories(await api.getCategories())
  toast?.push(`"${nm}" 비목을 등록했어요`)
  return nm
}

/**
 * 기준정보 항목(품목·적요 등 ref_items)을 등록하고 목록을 새로고침한다.
 * @param {'item'|'jeokyo'} type
 * @param {string} name
 * @param {{ setList: Function, toast?: object, label?: string }} ctx
 * @returns {Promise<string|null>}
 */
export async function quickAddRefItem(type, name, { setList, toast, label = '항목' }) {
  const nm = String(name || '').trim()
  if (!nm) return null
  const res = await api.addRefItem({ type, name: nm })
  if (!res.ok) {
    toast?.push(res.error || `${label}을(를) 등록하지 못했어요`, { tone: 'warn' })
    return null
  }
  setList(await api.getRefItems(type))
  toast?.push(`"${nm}" ${label}을(를) 등록했어요`)
  return nm
}
