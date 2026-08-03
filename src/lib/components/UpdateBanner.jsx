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
      /* --surface-1 은 이 프로젝트에 없는 이름이었다(index.css 는 --surface).
         정의되지 않은 변수라 배경이 통째로 투명해져, 로그인 화면처럼 뒤가 흰 곳에서는
         글자만 떠 있는 것처럼 보였다. */
      background: 'var(--surface)', border: '1px solid var(--line-strong)',
      boxShadow: '0 10px 30px rgba(0,0,0,.18)', maxWidth: 'calc(100vw - 32px)',
    }}>
      <Icon.Refresh size={16} style={{ color: 'var(--brand)', flexShrink: 0 }}/>
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        <b>새 버전이 나왔어요.</b>
        <span className="text-muted" style={{ marginLeft: 6 }}>눌러야 새 화면으로 바뀝니다.</span>
      </div>
      {/* 버튼이 하는 일은 Ctrl+Shift+R(강력 새로고침)과 같다 — 서비스워커·캐시를 비우고 다시 받는다.
          그냥 '새로고침'이라고만 쓰면 F5 로 될 일처럼 보여서, 실제로 안 바뀌면 앱을 의심하게 된다. */}
      <button className="btn primary sm" onClick={applyAppUpdate} title="캐시를 비우고 새로 받습니다 (Ctrl+Shift+R 와 같아요)">
        지금 받기
      </button>
      <button className="icon-btn" title="나중에" onClick={() => setShow(false)}><Icon.Close size={14}/></button>
    </div>
  )
}
