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
//   actions  오른쪽 버튼 영역(JSX). 없으면 제목만 좌측 정렬
export const PageHeader = ({ title, sub, actions }) => (
  <div className="page-header">
    <div className="page-header-main">
      <div className="page-title">{title}</div>
      {sub && <div className="page-sub">{sub}</div>}
    </div>
    {actions && <div className="page-header-actions">{actions}</div>}
  </div>
)
