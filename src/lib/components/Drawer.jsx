import { useRef } from 'react'
import { Icon } from '../ui'
import { SaveKeyHint, useSaveKey } from '../useSaveKey'

// 드로어 머리·발 공통 부품. 껍데기(포털+백드롭+aside)는 lib/ui.jsx 의 Drawer 가 담당하고,
// 그 안의 반복되는 머리(제목+부제+닫기)·발(취소/저장)만 여기서 뽑는다.
// 예전엔 30여 개 드로어가 아래 마크업을 각자 복붙했다:
//   <div className="drawer-head"><div className="fw-700" style={{fontSize:16}}>제목</div>
//     <button className="icon-btn ml-auto" title="닫기" onClick={onClose}><Icon.Close/></button></div>
//   <div className="drawer-foot"><button className="btn">취소</button>
//     <button className="btn primary ml-auto"><Icon.Check/> 저장</button></div>

// 머리 — (제목 + 부제) 왼쪽, 닫기(X) 오른쪽.
//   title    제목(필수)
//   sub      부제(없으면 줄 생략)
//   onClose  X 버튼 핸들러
//   right    닫기 버튼 왼쪽에 둘 추가 요소(옵션)
export const DrawerHead = ({ title, sub, onClose, right }) => (
  <div className="drawer-head">
    <div style={{ minWidth: 0 }}>
      <div className="fw-700" style={{ fontSize: 16 }}>{title}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
    {right}
    <button className="icon-btn ml-auto" title="닫기" onClick={onClose}><Icon.Close size={16}/></button>
  </div>
)

// 발 — 표준은 (취소) 왼쪽 · (저장) 오른쪽. 버튼 구성이 특수하면 children 으로 통째 대체.
//   onCancel/cancelLabel  취소 버튼(없으면 미표시)
//   onSave/saveLabel      저장 버튼(primary, Icon.Check). saveDisabled 로 비활성
//   children              주면 표준 버튼 대신 이걸 그대로 넣는다(삭제·출력 등 커스텀 발)
export const DrawerFooter = ({ onCancel, cancelLabel = '취소', onSave, saveLabel = '저장', saveDisabled, busy, children }) => {
  /* ⌘/Ctrl+Enter 저장을 **여기서** 건다. 예전엔 안내만 여기서 그리고 동작은 화면마다 따로였다 —
     서랍 서른 곳에 "저장" 단축키가 적혀 있는데 실제로 되는 건 넷뿐이었다(안 되는 단축키는 거짓말이다).
     발은 서랍이 열려 있을 때만 그려지므로 열림 판정이 따로 필요 없다. */
  const blocked = saveDisabled || busy
  const footRef = useRef(null)
  /* 서랍이 겹쳐 있으면 **맨 위 것만** 듣는다 — 안 그러면 위 서랍에서 누른 저장이 뒤 서랍까지 저장한다 */
  const isTopDrawer = () => {
    const mine = footRef.current?.closest('.drawer')
    const all = [...document.querySelectorAll('.drawer.open')]
    return !mine || all[all.length - 1] === mine
  }
  useSaveKey(!!onSave && !blocked, () => { if (isTopDrawer()) onSave?.() })
  return (
  <div className="drawer-foot" ref={footRef}>
    {children ?? (
      <>
        {onCancel && <button className="btn" onClick={onCancel}>{cancelLabel}</button>}
        {onSave && (
          <>
            {/* 단축키는 **보이는 자리에** 적는다 — 안 보이는 단축키는 없는 단축키다 */}
            {!blocked && <span className="ml-auto" style={{ marginRight: 8 }}><SaveKeyHint/></span>}
            <button className={`btn primary${blocked ? '' : ''}`} style={blocked ? { marginLeft: 'auto' } : undefined}
              onClick={onSave} disabled={blocked}>
              <Icon.Check size={14}/> {busy ? '처리 중…' : saveLabel}
            </button>
          </>
        )}
      </>
    )}
  </div>
  )
}
