import { useEffect, useState } from 'react'
import { Icon } from '../ui'
import { onAppUpdate, applyAppUpdate } from '../appUpdate'

/**
 * 새 버전 알림 배너.
 *
 * 배포 직후 열려 있던 탭은 옛 화면을 계속 보여준다(자세한 배경은 lib/appUpdate.js).
 * 그 사실을 알려주고, 사용자가 준비됐을 때 누르면 새로고침한다 —
 * 작성 중인 폼이 있을 수 있으니 저절로 새로고침하지 않는다.
 *
 * 닫을 수 있게 둔다. 급한 입력 중에 계속 떠 있으면 그게 더 방해가 된다.
 * 다음에 새 배포가 감지되면 다시 뜬다.
 */
export function UpdateBanner() {
  const [show, setShow] = useState(false)
  useEffect(() => onAppUpdate(() => setShow(true)), [])
  if (!show) return null

  return (
    <div className="fade-up" role="status" style={{
      position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 20, zIndex: 3000,
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 14px 12px 16px', borderRadius: 12,
      background: 'var(--surface-1)', border: '1px solid var(--line)',
      boxShadow: '0 10px 30px rgba(0,0,0,.18)', maxWidth: 'calc(100vw - 32px)',
    }}>
      <Icon.Refresh size={16} style={{ color: 'var(--brand)', flexShrink: 0 }}/>
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        <b>새 버전이 나왔어요.</b>
        <span className="text-muted" style={{ marginLeft: 6 }}>새로고침하면 반영됩니다.</span>
      </div>
      <button className="btn primary sm" onClick={applyAppUpdate}>새로고침</button>
      <button className="icon-btn" title="나중에" onClick={() => setShow(false)}><Icon.Close size={14}/></button>
    </div>
  )
}
