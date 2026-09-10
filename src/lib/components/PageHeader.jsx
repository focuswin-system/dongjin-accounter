import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'

// 화면 상단 헤더 — (제목 + 부제) 왼쪽, 액션 버튼 오른쪽, 세로 가운데 정렬.
// 데스크톱에선 스크롤 컨테이너(.content) 안에서 sticky 로 상단에 고정된다(본문만 스크롤).
//
// 예전엔 화면마다 아래를 조금씩 다르게(정렬·마진·클래스명) 반복했다:
//   <div className="row"><div><page-title/><page-sub/></div><div className="ml-auto">…버튼</div></div>
// 부제 유무·정렬(flex-end vs center)이 화면마다 달라 버튼 세로 위치가 흔들렸다. 하나로 못박는다.
//
// 탭·기간필터는 여기 넣지 않는다 — 그건 본문(표/그리드)에 속하는 요소다(사용자 규약).
// 헤더는 제목·부제·액션만 담는다.
//
// props
//   title    제목(필수)
//   sub      부제(문자열/JSX). 없으면 부제 줄 자체를 그리지 않는다
//   actions  오른쪽 버튼 영역(JSX). 없어도 자리(슬롯)는 그린다 — 아래 HeaderActions 참고

const SLOT_ID = 'page-header-actions-slot'

export const PageHeader = ({ title, sub, actions }) => (
  <div className="page-header">
    <div className="page-header-main">
      <div className="page-title">{title}</div>
      {sub && <div className="page-sub">{sub}</div>}
    </div>
    {/* ⚠ 비어 있어도 그린다. 화면 본문 깊숙한 곳(패널)에 있는 주 동작 버튼이
        HeaderActions 로 **여기에** 올라오기 때문이다. 없으면 올릴 자리가 없다. */}
    <div className="page-header-actions" id={SLOT_ID}>{actions}</div>
  </div>
)

/**
 * 본문 안에 있는 주 동작 버튼을 **머리글 오른쪽으로 올린다.**
 *
 * 왜 필요한가 — 등록 버튼의 자리가 화면군마다 달랐다.
 *   · 회계·계약 화면(수주·발주·정기·수시·차입금·어음…) → 머리글 오른쪽
 *   · 기준정보(거래처·품목·비목·계좌·카드…)·설정 → 본문 툴바 안
 * 같은 성격의 목록인데 눈이 두 군데를 찾아야 했다. 그렇다고 패널을 뜯어 상태를 위로
 * 끌어올리면(등록 드로어 여닫는 상태까지) 화면 21개를 다 손대야 한다 —
 * 버튼은 제자리에 두고 **그리는 자리만** 옮긴다.
 *
 * @param when  false 면 올리지 않고 그 자리에 그대로 그린다(탭 안에 여럿이 함께 뜨는 경우).
 *              단독 화면(embedded)일 때만 올린다 — 두 패널이 동시에 올리면 버튼이 겹친다.
 */
export const HeaderActions = ({ when = true, children }) => {
  const [slot, setSlot] = useState(null)
  /* deps 를 두지 않는다 — 라우트가 바뀌면 머리글 DOM 이 통째로 갈리므로 매 렌더에서 다시 찾는다.
     같은 노드면 setState 를 건너뛴다(안 그러면 렌더-이펙트가 서로를 부른다). */
  useEffect(() => {
    const el = when ? document.getElementById(SLOT_ID) : null
    setSlot(prev => (prev === el ? prev : el))
  })
  if (!when) return children
  return slot ? createPortal(children, slot) : null
}
