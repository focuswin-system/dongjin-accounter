import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui'

/**
 * 표 한 행의 동작들 — **자주 쓰는 하나만 내놓고 나머지는 ⋯ 뒤에 둔다.**
 *
 * ── 왜 다 늘어놓지 않나 ──
 * 정기 규칙 표는 행마다 버튼이 네 개였다(수정·지난 회차 넣기·중지·삭제). 문제가 둘이다.
 *   1. **삭제가 늘 손끝에 있다.** 옆 칸이 '중지'라서, 잠시 멈추려던 손이 한 칸 빗나가면
 *      규칙이 지워진다. 되돌릴 수 없는 동작을 되돌릴 수 있는 동작 옆에 붙여 두는 배치다.
 *   2. 네 개가 늘 떠 있으면 **어느 것이 평소 쓰는 것인지** 알려주지 않는다. 실제로 자주
 *      누르는 건 '수정' 하나고, 나머지는 드문 일이다(지난 회차 넣기는 도입할 때 한 번).
 *
 * 그래서 평소 것은 밖에, 드문 것과 위험한 것은 안에 둔다. 안에서는 이름이 온전히 보이고
 * 삭제는 맨 아래 선 아래에 떨어져 앉는다.
 *
 * ── 왜 포털로 띄우나 (position: fixed) ──
 * 표를 담은 카드는 `overflow: hidden` 이다(모서리를 둥글게 유지하려고). 그 안에서
 * absolute 로 띄우면 **마지막 행의 메뉴가 카드 밑변에서 잘린다** — 실제로 그렇게 만들었고
 * 삭제 항목이 보이지 않았다. 조상의 overflow 를 신경 쓰지 않으려면 body 로 내보내는 수밖에
 * 없다. 대신 좌표를 직접 재야 하므로, 아래로 넘치면 위로 뒤집는다.
 *
 * ⚠ 스크롤·리사이즈에는 **닫는다.** fixed 는 문서와 함께 움직이지 않아서, 열어 둔 채 표를
 *   굴리면 메뉴만 제자리에 남아 엉뚱한 행의 것처럼 보인다. 다시 눌러 여는 편이 안전하다.
 *
 * @param primary  {label, onClick, disabled?} — 밖에 남길 하나. 없으면 ⋯ 만 선다.
 * @param items    [{label, onClick, tone?: 'neg', disabled?, hint?}] — ⋯ 안. tone:'neg'는
 *                 선 아래 별도 구획으로 내려간다(되돌릴 수 없는 것).
 */
const POP_W = 168
const GAP = 4

export const RowActions = ({ primary, items = [] }) => {
  const [pos, setPos] = useState(null)   // null이면 닫힘
  const btnRef = useRef(null)
  const popRef = useRef(null)

  const place = useCallback(() => {
    const el = btnRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    // 항목 수로 높이를 어림한다(측정 전에 자리를 정해야 첫 그림부터 안 튄다)
    const h = items.length * 34 + 16
    const below = window.innerHeight - r.bottom
    return {
      left: Math.max(8, Math.min(r.right - POP_W, window.innerWidth - POP_W - 8)),
      top: below < h + GAP ? Math.max(8, r.top - h - GAP) : r.bottom + GAP,
    }
  }, [items.length])

  const toggle = () => setPos(p => (p ? null : place()))

  useEffect(() => {
    if (!pos) return
    const close = () => setPos(null)
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
      close()
    }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    // capture: 안쪽 스크롤 컨테이너(셸 고정 레이아웃)에서도 받는다
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [pos])

  const safe = items.filter(i => i && i.tone !== 'neg')
  const risky = items.filter(i => i && i.tone === 'neg')
  const run = (fn) => () => { setPos(null); fn?.() }
  const item = (i) => (
    <button key={i.label} role="menuitem" className={`row-actions-item${i.tone === 'neg' ? ' neg' : ''}`}
      disabled={i.disabled} onClick={run(i.onClick)}>
      {i.label}
      {i.hint && <span className="text-xs text-muted2">{i.hint}</span>}
    </button>
  )

  return (
    <div className="row-actions">
      {primary && (
        <button className="btn sm" disabled={primary.disabled} onClick={primary.onClick}>{primary.label}</button>
      )}
      {items.length > 0 && (
        <button ref={btnRef} className="icon-btn" aria-label="더보기" aria-expanded={!!pos}
          onClick={toggle}><Icon.More size={16}/></button>
      )}
      {pos && createPortal(
        <div ref={popRef} className="row-actions-pop" role="menu"
          style={{ left: pos.left, top: pos.top, width: POP_W }}>
          {safe.map(item)}
          {risky.length > 0 && safe.length > 0 && <div className="row-actions-sep"/>}
          {risky.map(item)}
        </div>,
        document.body)}
    </div>
  )
}

