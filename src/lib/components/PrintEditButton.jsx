import { Icon } from '../ui'

/**
 * '손보기' 버튼 — 보고서 머리에 선다. 켜면 글자 칸이 그 자리에서 고쳐진다.
 *
 * 안내를 버튼 옆에 짧게 둔다. 켠 상태를 모르면 "왜 글자가 지워지지"가 되고,
 * 저장 안 된다는 걸 모르면 "적어 뒀는데 사라졌다"가 된다 — 둘 다 실제로 겪을 일이다.
 */
export const PrintEditButton = ({ on, toggle, count }) => {
  if (!count && !on) return null      // 고칠 글자 칸이 없는 보고서에는 버튼도 없다
  return (
    <>
      {on && (
        <span className="text-xs text-muted2 no-print" style={{ marginRight: 2 }}>
          글자 칸만 · 저장 안 됨
        </span>
      )}
      <button className={`btn sm ${on ? 'primary' : ''}`} onClick={toggle}
        title={on ? '손보기를 끕니다' : '인쇄 전에 비고 같은 글자 칸을 그 자리에서 고칩니다 (숫자는 잠겨요)'}>
        <Icon.Pencil size={13}/> {on ? '손보기 끄기' : '손보기'}
      </button>
    </>
  )
}
