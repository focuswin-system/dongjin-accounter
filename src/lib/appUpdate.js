/**
 * 새 버전 배포 감지 — "지금 보고 있는 화면이 낡았다"를 알려준다.
 *
 * ── 왜 필요한가 ──
 * 이 앱은 PWA 서비스워커가 index.html·번들을 선캐시한다. 배포하면 브라우저가 다음 방문에
 * 새 워커를 받아 설치하고 제어권을 가져가지만(skipWaiting·clientsClaim),
 * **이미 열려 있는 탭은 이미 읽어들인 옛 자바스크립트를 계속 실행한다.**
 * 그래서 배포 직후 접속하면 옛 화면이 나오고, 새로고침을 한 번 더 해야 반영된다.
 *
 * 실제로 2026-08-03 배포에서 수정이 안 먹은 것처럼 보였고(옛 번들이 돌고 있었다),
 * 경리 담당자라면 "고쳐준다더니 그대로네"로 받아들일 자리다.
 *
 * ── 왜 자동 새로고침을 하지 않는가 ──
 * 여기는 회계 앱이다. 거래 등록 폼을 반쯤 채운 상태에서 화면이 저절로 새로고침되면
 * 입력하던 내용이 통째로 사라진다. 배포는 사용자가 모르는 사이에 일어나므로
 * "왜 갑자기 지워졌지"만 남는다. 그래서 **알리고, 누르면 그때 새로고침**한다.
 */

const listeners = new Set()
let updated = false

const emit = () => { for (const fn of listeners) fn(updated) }

/** 새 버전이 준비됐는지 구독한다. @returns 해제 함수 */
export function onAppUpdate(fn) {
  listeners.add(fn)
  if (updated) fn(true)          // 이미 감지된 뒤에 구독했으면 바로 알려준다
  return () => listeners.delete(fn)
}

export const applyAppUpdate = () => window.location.reload()

// 장시간 열어둔 탭도 알아채도록 주기적으로 새 워커를 확인한다.
// 경리 업무는 한 탭을 하루 종일 띄워두는 일이 흔해서, 방문 시점에만 확인하면
// 배포한 날 내내 옛 화면을 쓰게 된다.
const CHECK_INTERVAL_MS = 30 * 60 * 1000

/** 앱 시작 시 1회 호출 (main.jsx). 운영 빌드에서만 동작한다. */
export function watchAppUpdate() {
  if (!('serviceWorker' in navigator)) return
  if (import.meta.env.DEV) return          // 개발 서버는 워커를 쓰지 않는다

  /* 첫 방문에는 controller 가 없다가 워커가 처음 붙을 때도 controllerchange 가 뜬다.
     그건 '새 버전'이 아니라 '이제 막 설치됨'이므로 배너를 띄우면 안 된다.
     → 페이지가 이미 워커의 제어를 받고 있었을 때만 갱신으로 본다. */
  const hadController = !!navigator.serviceWorker.controller

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return
    updated = true
    emit()
  })

  navigator.serviceWorker.ready.then(reg => {
    if (!reg) return
    const check = () => { reg.update().catch(() => { /* 오프라인 등 — 다음 주기에 다시 */ }) }
    setInterval(check, CHECK_INTERVAL_MS)
    // 탭을 다시 볼 때도 한 번 확인한다(점심 후 돌아온 경우 등)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check() })
  }).catch(() => { /* 워커 미등록 — 알림 없이 그대로 */ })
}
