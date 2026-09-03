import { useState, useEffect, useCallback } from 'react'

/**
 * 인쇄 전 손보기 — 보고서의 **글자 칸만** 그 자리에서 고쳐 인쇄한다.
 *
 * ── 왜 필요한가 ──
 * 보고서는 결재를 받아 넘기는 종이다. 그런데 종이에 적어야 할 말 중에는 장부에 없는 것이
 * 있다 — '자동이체', '리스', 담당자가 손으로 달던 단서 같은 것들. 여태는 인쇄한 뒤
 * 볼펜으로 적거나, 엑셀로 내려받아 고쳐서 다시 인쇄해야 했다.
 *
 * ── 무엇을 열고 무엇을 잠그나 ──
 * **글자 칸만 연다. 숫자는 잠근다.**
 * 보고서는 장부에서 뽑은 집계다. 금액을 고칠 수 있으면 **장부와 다른 숫자를 말하는 인쇄물**이
 * 생기고, 그건 나중에 어느 쪽이 맞는지 가릴 방법이 없다. 그래서 num 서식이 붙은 칸,
 * 머리글·합계 줄, 버튼·입력이 든 칸은 건드리지 않는다.
 *
 * ── 저장하지 않는다 ──
 * 고친 값은 화면(DOM)에만 있다. 새로고침하면 장부 값으로 돌아온다. 저장하는 순간 그것은
 * 보고서가 아니라 문서이고, 번호·이력·마감이 따라붙어야 한다(문서업무가 그 자리다).
 * 지금 필요한 건 "인쇄 직전에 한 줄 적는 것"이므로 거기까지만 한다.
 *
 * ⚠ 화면이 다시 그려지면(달을 바꾸는 등) 고친 글자는 사라진다 — 원래 값이 React 손에
 *   있기 때문이다. 그래서 손보기를 켜면 그 사실을 화면에 적어 둔다.
 */

/** 이 칸을 고칠 수 있나 — 글자 칸만. */
const editable = (td) => {
  if (td.closest('thead') || td.closest('tfoot')) return false        // 머리글·합계는 장부의 뼈대다
  const cls = String(td.className || '')
  if (/\bnum\b|num-cell|num-right/.test(cls)) return false            // 숫자 서식
  if (td.querySelector('input, select, textarea, button, a')) return false  // 조작이 든 칸
  const t = (td.textContent || '').trim()
  if (!t) return true                                                  // 빈 칸은 적을 자리다
  // 숫자·금액·날짜만 든 칸은 잠근다(서식 클래스를 안 붙인 표가 있다)
  if (/^[0-9,.\-+원%\s]+$/.test(t)) return false
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return false
  return true
}

const CELLS = 'td, th'

/** root 아래 칸을 열거나(on) 잠그고, 고칠 수 있는 칸 수를 알린다.
 *  ⚠ 칸 수는 **켜지 않아도** 센다 — 켤 때만 세면 0 이라 버튼이 안 뜨고,
 *    버튼이 없으니 켤 수가 없다(서로 물린다). */
function apply(root, on, setCount) {
  let n = 0
  for (const td of root.querySelectorAll(CELLS)) {
    const can = editable(td)
    if (can) n++
    if (on && can) {
      if (td.getAttribute('contenteditable') !== 'true') {
        td.setAttribute('contenteditable', 'true')
        td.setAttribute('data-pe', '1')
        td.setAttribute('tabindex', '0')     // Tab 으로 칸을 옮겨 다니려면 초점을 받아야 한다
      }
    } else if (td.hasAttribute('data-pe')) {
      td.removeAttribute('contenteditable')
      td.removeAttribute('data-pe')
      td.removeAttribute('tabindex')
    }
  }
  root.classList.toggle('print-edit', on)
  // 같은 값이면 다시 그리지 않는다 — 관찰자와 맞물려 돌지 않게
  setCount(c => (c === n ? c : n))
}

/**
 * @param rootRef  인쇄 대상(.report-print 등)을 가리키는 ref
 * @param watch    이 값이 바뀌면 다시 훑는다.
 *   ⚠ **꼭 넘긴다.** 이 훅은 화면이 붙자마자 도는데, 그때는 목록을 불러오는 중이라
 *     인쇄 대상이 **아직 없다**(ref 가 null). ref 는 값이 바뀌어도 효과를 다시 돌리지
 *     않으므로, 그대로 두면 영영 한 번도 못 훑고 버튼이 안 뜬다(실측).
 * @returns { on, toggle, count, onKeyDown }
 */
export function usePrintEdit(rootRef, watch = null) {
  const [on, setOn] = useState(false)
  const [count, setCount] = useState(0)

  /* ⚠ **한 번만 훑으면 안 된다.** 이 효과는 화면이 붙자마자 도는데 그때는 아직 자료를
       불러오는 중이라 표가 없다 — 세어 봐야 0 이고, 0 이면 버튼이 안 뜬다(실측).
       달을 바꿔 표가 다시 그려질 때도 마찬가지다. 그래서 root 아래 변화를 지켜본다.
     React 가 관리하는 속성이 아니라 우리가 붙였다 떼는 것이므로 정리도 우리가 한다. */
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let raf = 0
    const scan = () => { raf = 0; apply(root, on, setCount) }
    apply(root, on, setCount)
    const mo = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(scan) })
    mo.observe(root, { childList: true, subtree: true })
    return () => {
      mo.disconnect()
      if (raf) cancelAnimationFrame(raf)
      root.classList.remove('print-edit')
      for (const td of root.querySelectorAll('[data-pe]')) {
        td.removeAttribute('contenteditable')
        td.removeAttribute('data-pe')
        td.removeAttribute('tabindex')
      }
    }
  }, [on, rootRef, watch])

  /* 키보드 — 문서 품목표(lib/gridKeys.js)와 **같은 규칙**을 쓴다.
       Enter 아래 줄 · Shift+Enter 위 줄 · ↑↓ 위아래 · Tab 옆 칸(브라우저 기본)
     ⚠ 여기서는 줄을 더하지 않는다. 보고서의 줄은 장부에서 온 것이라 사람이 만들 수 없다. */
  const onKeyDown = useCallback((e) => {
    if (!on) return
    const td = e.target?.closest?.('[data-pe]')
    if (!td) return
    const isEnter = e.key === 'Enter'
    const isUp = e.key === 'ArrowUp'
    const isDown = e.key === 'ArrowDown'
    if (!isEnter && !isUp && !isDown) return
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return   // 한글 조합 중의 Enter 는 글자 확정이다
    const tr = td.closest('tr')
    const tbody = tr?.parentElement
    if (!tr || !tbody) return
    const col = [...tr.children].indexOf(td)
    const rows = [...tbody.children]
    const at = rows.indexOf(tr)
    const back = isUp || (isEnter && e.shiftKey)
    /* 그 줄의 같은 열이 잠겨 있으면(숫자 칸) 지나쳐 다음 줄을 본다 —
       "키가 고장 났나" 싶게 멈추지 않도록. */
    for (let i = at + (back ? -1 : 1); i >= 0 && i < rows.length; i += back ? -1 : 1) {
      const cell = rows[i]?.children[col]
      if (cell?.hasAttribute('data-pe')) {
        e.preventDefault()
        cell.focus()
        // 커서를 칸 끝에 둔다 — 전체 선택하면 이어 치는 순간 적어둔 게 날아간다
        const sel = window.getSelection?.()
        if (sel) {
          const r = document.createRange()
          r.selectNodeContents(cell); r.collapse(false)
          sel.removeAllRanges(); sel.addRange(r)
        }
        return
      }
    }
  }, [on])

  return { on, toggle: () => setOn(v => !v), count, onKeyDown }
}
