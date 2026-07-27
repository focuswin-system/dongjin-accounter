import { fmtNum } from '../ui'

// 문서 센터 공용 레이아웃 — 좌측 리스트 + 우측(콘텐츠 헤더 + 본문).
// 지급결의서·정산내역서 등 모든 문서 화면이 같은 뼈대를 쓴다.
//
//   <DocWorkspace>
//     <DocSide top={필터/검색}>{rows or empty}</DocSide>
//     <DocMain>
//       {sel ? <><DocToolbar docNo status>{actions}</DocToolbar><DocViewport portrait>{문서}</DocViewport></> : <DocEmpty/>}
//     </DocMain>
//   </DocWorkspace>

export const DocWorkspace = ({ children }) => <div className="doc-ws">{children}</div>

export const DocSide = ({ top, children }) => (
  <div className="card doc-ws-side">
    {top && <div className="doc-ws-side-top">{top}</div>}
    <div className="doc-ws-side-scroll">{children}</div>
  </div>
)

// 좌측 리스트 한 행 — 두 화면 공통 모양(문서번호+우측배지, 제목, 메타+금액)
export const DocListRow = ({ active, onClick, docNo, right, title, meta, amount, amountLabel = '원' }) => (
  <button type="button" className={`doc-ws-row ${active ? 'active' : ''}`} onClick={onClick}>
    <div className="doc-ws-row-top">
      <span className="num text-xs text-muted2 fw-600">{docNo}</span>
      {right != null && <span className="doc-ws-row-right">{right}</span>}
    </div>
    {title != null && <div className="doc-ws-row-title">{title}</div>}
    {(meta != null || amount != null) && (
      <div className="doc-ws-row-meta">
        {meta != null && <span className="text-xs text-muted">{meta}</span>}
        {amount != null && (
          <span className="num fw-700 text-sm doc-ws-row-amt">
            {fmtNum(amount)}<span className="text-muted2" style={{ fontWeight: 400, marginLeft: 2 }}>{amountLabel}</span>
          </span>
        )}
      </div>
    )}
  </button>
)

export const DocSideEmpty = ({ children }) => (
  <div className="doc-ws-side-empty">{children}</div>
)

export const DocMain = ({ children }) => <div className="doc-ws-main">{children}</div>

// 콘텐츠 헤더 — 문서번호 + 상태 + (오른쪽) 액션 버튼들
export const DocToolbar = ({ docNo, status, children }) => (
  <div className="card no-print doc-ws-toolbar">
    <span className="num fw-700 text-sm">{docNo}</span>
    {status}
    <div className="ml-auto row gap-6">{children}</div>
  </div>
)

// 본문 뷰포트 — portrait(세로 양식)면 가운데 정렬, 아니면(가로) 그대로 폭 채움
export const DocViewport = ({ portrait, children }) => (
  <div className={`doc-ws-viewport ${portrait ? 'is-portrait' : ''}`}>{children}</div>
)

export const DocEmpty = ({ icon, children }) => (
  <div className="card doc-ws-empty">
    {icon}
    <div className="text-sm">{children}</div>
  </div>
)
