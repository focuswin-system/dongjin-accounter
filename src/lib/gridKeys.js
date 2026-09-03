/**
 * 문서 품목표를 **키보드로** 다닌다 — 스프레드시트처럼.
 *
 * ── 왜 필요한가 ──
 * 품목이 열 줄이면 칸이 팔십 개다. 그걸 전부 마우스로 짚어 옮겨 다니면 한 장 쓰는 데
 * 손이 계속 오간다. 경리 업무는 숫자를 연달아 치는 일이라, 손이 자판을 떠나는 순간
 * 속도가 절반이 된다. 엑셀에서 하던 대로 되면 배울 것도 없다.
 *
 * ── 무엇을 하나 ──
 *   Enter        아래 줄 같은 칸으로. 마지막 줄이면 **줄을 하나 더 만들고** 거기로 간다
 *   Shift+Enter  위 줄 같은 칸으로
 *   ↑ / ↓        위·아래 줄 같은 칸 (글자 커서가 아니라 칸을 옮긴다)
 *   Tab          좌우 이동은 **브라우저 기본**을 그대로 둔다 — 이미 되는 것을 다시 만들면
 *                읽기 순서와 어긋나기 쉽다
 *
 * ⚠ 셀렉트·콤보 같은 목록형 칸에서는 ↑↓ 를 가로채지 않는다. 거기서는 후보를 고르는
 *   키라서, 뺏으면 목록을 못 고른다.
 * ⚠ 조합 중(한글 입력기)에는 Enter 를 가로채지 않는다. '자재'를 치는 중의 Enter 는
 *   글자를 확정하는 키다 — 그걸 줄 이동으로 먹으면 마지막 글자가 깨진다.
 */

/** 이 칸에서 위아래 이동을 가로채도 되나 — 목록을 여는 칸은 제 몫이 있다 */
const takesArrows = (el) => {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'SELECT' || tag === 'TEXTAREA') return false
  // 콤보박스(목록이 열려 있으면 ↑↓ 가 후보 이동이다)
  if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-expanded') === 'true') return false
  if (el.closest('[class*="combo"]')) return false
  return true
}

const cellsOf = (row) => [...row.querySelectorAll('input, select, textarea')].filter(x => !x.disabled && x.offsetParent)

/**
 * 표(<table>)에 붙이는 onKeyDown 핸들러를 만든다.
 * @param onAddRow 마지막 줄에서 Enter 를 눌렀을 때 줄을 더할 함수(없으면 이동만 한다)
 */
export function makeGridKeyHandler(onAddRow) {
  return (e) => {
    const el = e.target
    if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return
    const isEnter = e.key === 'Enter'
    const isUp = e.key === 'ArrowUp'
    const isDown = e.key === 'ArrowDown'
    if (!isEnter && !isUp && !isDown) return
    // 한글 조합 중의 Enter 는 글자를 확정하는 키다 — 뺏으면 마지막 글자가 깨진다
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return
    if ((isUp || isDown) && !takesArrows(el)) return

    const td = el.closest('td')
    const tr = el.closest('tr')
    const tbody = tr?.parentElement
    if (!td || !tr || !tbody) return

    const col = [...tr.children].indexOf(td)
    const rows = [...tbody.children].filter(r => r.querySelector('input, select, textarea'))
    const at = rows.indexOf(tr)
    if (at < 0) return

    const goto = (row) => {
      if (!row) return false
      const cell = row.children[col]
      /* 같은 열이 비었으면(입력칸이 없는 칸) 그 줄에서 가장 가까운 칸으로 — 아무 데도
         못 가고 멈추면 사용자는 키가 고장 났다고 느낀다 */
      const target = cell?.querySelector('input, select, textarea') || cellsOf(row)[0]
      if (!target) return false
      target.focus()
      if (target.select) try { target.select() } catch {}
      return true
    }

    const back = isUp || (isEnter && e.shiftKey)
    if (back) {
      if (goto(rows[at - 1])) e.preventDefault()
      return
    }
    // 아래로 — 마지막 줄이면 한 줄 더 만들고 그 줄로 간다
    if (rows[at + 1]) {
      if (goto(rows[at + 1])) e.preventDefault()
      return
    }
    if (isEnter && onAddRow) {
      e.preventDefault()
      onAddRow()
      /* 새 줄은 다음 그리기에서 생긴다 — 그 뒤에 옮겨야 한다.
         requestAnimationFrame 두 번이면 React 가 붙인 DOM 을 확실히 본다. */
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const after = [...tbody.children].filter(r => r.querySelector('input, select, textarea'))
        goto(after[at + 1])
      }))
    }
  }
}
