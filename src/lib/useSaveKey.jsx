import { useEffect } from 'react'

/**
 * 저장 단축키 — ⌘/Ctrl + Enter.
 *
 * 경리 업무는 같은 폼을 연달아 채운다. 마지막에 마우스로 [등록]을 찍게 하면
 * 한 건마다 손이 키보드를 떠난다. 거래 등록 폼에만 있던 규칙을 여기로 뽑아
 * **저장 버튼이 있는 서랍은 모두 같은 키**로 저장되게 한다.
 *
 * ⚠ 그냥 Enter 는 쓰지 않는다 — 콤보박스·적요 검색이 Enter 로 값을 확정하는데,
 *   같은 키가 저장까지 하면 고르려다 저장된다(실제로 겪는 사고다).
 *
 * @param active  열려 있을 때만 듣는다(닫힌 서랍이 남의 Enter 를 가로채면 안 된다)
 * @param onSave  저장 함수. 비활성(저장 못 하는 상태)이면 부르는 쪽에서 막는다
 */
export const useSaveKey = (active, onSave) => {
  useEffect(() => {
    if (!active || typeof onSave !== 'function') return
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter' || e.defaultPrevented) return
      e.preventDefault()
      onSave()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, onSave])
}

/** 저장 단축키 안내 — 버튼 옆에 같은 모양으로 붙인다 */
export const SaveKeyHint = () => (
  <span className="text-xs text-muted2">
    <span className="kbd">⌘</span> <span className="kbd">↵</span> 저장
  </span>
)
