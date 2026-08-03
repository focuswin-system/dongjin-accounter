/**
 * 새 버전 배포 감지 — "지금 보고 있는 화면이 낡았다"를 알려준다.
 *
 * ── 왜 필요한가 ──
 * 이 앱은 PWA 서비스워커가 index.html·번들을 선캐시한다. 배포해도 **이미 열려 있는 탭은
 * 이미 읽어들인 옛 자바스크립트를 계속 실행한다.** 새로고침해도 워커가 옛 index.html을
 * 먼저 내주면 한 번 더 새로고침해야 반영된다(2026-08-03 배포에서 실제로 겪었다 —
 * 수정이 안 먹은 줄 알고 원인을 찾는 데 시간을 썼다).
 * 경리 담당자라면 "고쳐준다더니 그대로네"로 받아들일 자리다.
 *
 * ── 무엇을 기준으로 판단하는가 ──
 * **서버가 알려주는 배포 커밋**(`GET /api/health` → deploy.commit)이다.
 * 서비스워커의 controllerchange 로도 감지할 수 있지만 언제 발화하는지가 브라우저·타이밍에
 * 따라 들쭉날쭉해서 "떴다 안 떴다" 한다. 서버 값은 그런 흔들림이 없고 확인도 쉽다.
 * (워커 이벤트도 보조로 함께 듣는다 — 먼저 알아채면 그것대로 이득이다.)
 *
 * ── 왜 자동 새로고침을 하지 않는가 ──
 * 여기는 회계 앱이다. 거래 등록 폼을 반쯤 채운 상태에서 화면이 저절로 새로고침되면
 * 입력하던 내용이 통째로 사라진다. 배포는 사용자가 모르는 사이에 일어나므로
 * "왜 갑자기 지워졌지"만 남는다. 그래서 **알리고, 누르면 그때 새로고침**한다.
 */

const listeners = new Set()
let updated = false
let baseline = null        // 이 탭이 처음 확인했을 때의 배포 커밋

const markUpdated = () => {
  if (updated) return
  updated = true
  for (const fn of listeners) fn(true)
}

/** 새 버전이 준비됐는지 구독한다. @returns 해제 함수 */
export function onAppUpdate(fn) {
  listeners.add(fn)
  if (updated) fn(true)          // 이미 감지된 뒤에 구독했으면 바로 알려준다
  return () => listeners.delete(fn)
}

export const applyAppUpdate = () => window.location.reload()

/* 확인 주기. 경리 업무는 한 탭을 하루 종일 띄워두는 일이 흔해서, 방문 시점에만 보면
   배포한 날 내내 옛 화면을 쓰게 된다. 요청 하나가 아주 가벼워 10분이면 충분하다. */
const CHECK_INTERVAL_MS = 10 * 60 * 1000

async function currentCommit() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' })
    if (!r.ok) return null
    const j = await r.json()
    return j?.deploy?.commit || null
  } catch { return null }        // 오프라인·서버 재시작 중 — 다음 주기에 다시 본다
}

async function check() {
  if (updated) return
  const c = await currentCommit()
  if (!c) return
  if (baseline == null) { baseline = c; return }   // 첫 확인은 기준값만 잡는다
  if (c !== baseline) markUpdated()
}

/** 앱 시작 시 1회 호출 (main.jsx). 운영 빌드에서만 동작한다. */
export function watchAppUpdate() {
  if (import.meta.env.DEV) return    // 개발 서버는 배포 개념이 없다(deploy=null)

  check()
  setInterval(check, CHECK_INTERVAL_MS)
  // 탭으로 돌아올 때도 한 번 (점심 후 돌아온 경우 등)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check() })

  /* 보조 신호: 서비스워커가 새 버전으로 갈아탄 순간.
     첫 방문에는 controller 가 없다가 워커가 처음 붙을 때도 controllerchange 가 뜬다 —
     그건 '새 버전'이 아니라 '이제 막 설치됨'이므로 제외한다. */
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) markUpdated()
    })
  }
}
