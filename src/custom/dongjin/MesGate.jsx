/**
 * MES 화면 공통 — 읽기 실패를 **이유별로** 보여 준다.
 *   404  이 회사에는 없는 기능(주소로 들어온 경우) — 서버가 모듈이 꺼진 회사에 404 로 답한다
 *   503  서버에 MES 연결 설정이 없다(MES_DB_NAME)
 *   그 밖 MES 에 닿지 못했다
 * 안 가르면 모두 '비었어요'로 보여, 설정 문제와 자료 0건을 구분할 수 없다.
 */
import { Icon } from '../../lib/ui'

export const MesGate = ({ data, onRetry, children }) => {
  if (!data?.error) return children
  const notHere = /Not found/i.test(data.error) || data.status === 404
  const notSet = data.code === 'mes_not_configured'
  return (
    <div className="card card-pad" style={{ textAlign: 'center', padding: 48 }}>
      <div className="fw-700" style={{ marginBottom: 6 }}>
        {notHere ? '이 회사에서는 쓸 수 없는 화면이에요' : notSet ? 'MES 연결이 설정되지 않았어요' : 'MES 에 연결하지 못했어요'}
      </div>
      <div className="text-sm text-muted" style={{ marginBottom: 16 }}>
        {notHere ? 'MES 연결은 해당 회사에만 열려 있어요.' : notSet ? '서버 설정(MES_DB_NAME)을 확인해 주세요.' : data.error}
      </div>
      {!notHere && <button className="btn" onClick={onRetry}><Icon.Refresh size={14}/> 다시 시도</button>}
    </div>
  )
}
