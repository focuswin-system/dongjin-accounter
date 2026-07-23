import { Icon } from '../ui'

// 드로어 머리·발 공통 부품. 껍데기(포털+백드롭+aside)는 lib/ui.jsx 의 Drawer 가 담당하고,
// 그 안의 반복되는 머리(제목+부제+닫기)·발(취소/저장)만 여기서 뽑는다.
// 예전엔 30여 개 드로어가 아래 마크업을 각자 복붙했다:
//   <div className="drawer-head"><div className="fw-700" style={{fontSize:16}}>제목</div>
//     <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close/></button></div>
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
    <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
  </div>
)

// 발 — 표준은 (취소) 왼쪽 · (저장) 오른쪽. 버튼 구성이 특수하면 children 으로 통째 대체.
//   onCancel/cancelLabel  취소 버튼(없으면 미표시)
//   onSave/saveLabel      저장 버튼(primary, Icon.Check). saveDisabled 로 비활성
//   children              주면 표준 버튼 대신 이걸 그대로 넣는다(삭제·출력 등 커스텀 발)
export const DrawerFooter = ({ onCancel, cancelLabel = '취소', onSave, saveLabel = '저장', saveDisabled, children }) => (
  <div className="drawer-foot">
    {children ?? (
      <>
        {onCancel && <button className="btn" onClick={onCancel}>{cancelLabel}</button>}
        {onSave && (
          <button className="btn primary ml-auto" onClick={onSave} disabled={saveDisabled}>
            <Icon.Check size={14}/> {saveLabel}
          </button>
        )}
      </>
    )}
  </div>
)
