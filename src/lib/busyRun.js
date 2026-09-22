/* 저장 버튼 재진입 차단 — 순수 로직만. React 훅(useBusy)은 이것을 감싼다.
 *
 * ── 왜 따로 빼나 ──
 * 훅 안에 두면 **테스트할 수가 없다.** 이 가드가 하는 일은 "두 번 눌러도 한 번만 실행"인데,
 * 그게 실제로 되는지 화면에서 확인하려면 느린 저장을 인위로 만들어야 한다.
 * 규칙만 떼어 두면 그냥 테스트로 못박을 수 있다.
 *
 * ── 왜 필요한가 ──
 * 서류를 만드는 버튼은 누르는 순간 **번호를 따고 행을 만든다.** 느린 순간에 두 번 눌리면
 * 문서번호가 두 장 나오고, 근로계약은 **직원까지 두 명** 생긴다.
 *
 * ⚠ 잠금은 **state 가 아니라 클로저 변수**로 한다. state 는 다시 그려진 뒤에야 바뀌는데,
 *   연달아 들어온 두 번째 클릭은 그 전에 온다 — state 만 보면 못 막는다.
 */
export function createBusyRun(setBusy) {
  let lock = false
  return async function run(fn) {
    if (lock) return undefined      // 이미 돌고 있다 — 두 번째 클릭은 버린다
    lock = true
    setBusy?.(true)
    try {
      return await fn()
    } finally {
      lock = false
      setBusy?.(false)
    }
  }
}
