import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { pruneDeadSession } from './lib/session'

/* 앱을 그리기 전에 죽은 세션을 걷어낸다.
 * 남겨두면 만료된 토큰으로 첫 요청 묶음이 나가고, 그 401들이 세션을 지우며 화면이
 * 들어갔다 튕겨나온다. 어제 쓰던 브라우저를 아침에 열면 매번 그랬다. */
pruneDeadSession()

/* 개발 서버에서 남아 있는 서비스워커를 스스로 걷어낸다.
 *
 * 예전에 vite.config 의 devOptions.enabled 가 켜져 있어서 5173에도 PWA 워커가 등록됐다.
 * 설정을 끄더라도 **이미 등록된 워커는 사라지지 않는다** — 계속 옛 index.html·번들을
 * 선캐시해서 내보낸다. 코드를 고쳐도 안 고쳐진 화면이 나오고, 옛 번들이 옛 인증 흐름을
 * 타면 로그인하자마자 튕기는 것처럼 보인다. DevTools를 열어 직접 지우게 하는 대신
 * 여기서 한 번 정리한다. 운영 빌드(import.meta.env.DEV === false)는 건드리지 않는다. */
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(async (regs) => {
    if (!regs.length) return
    await Promise.all(regs.map(r => r.unregister()))
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k)
    console.info('[dev] 남아 있던 서비스워커·캐시를 정리했어요. 한 번 새로고침합니다.')
    window.location.reload()
  }).catch(() => { /* 워커 정리는 실패해도 앱 동작과 무관 */ })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
