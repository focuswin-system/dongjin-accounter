/* 인쇄 방향(세로/가로) — 한 곳에서만 관리한다.
 *
 * ── 왜 모듈이 필요한가 ──
 * CSS 의 `@page` 는 **선택자를 못 받는다.** `.report-print { @page ... }` 같은 건 없다.
 * 그래서 화면마다 클래스를 붙이는 식으로는 방향을 못 바꾼다 — 문서에 규칙을 하나
 * 끼워 넣었다 빼는 수밖에 없다. 그 일을 화면마다 따로 하면 규칙이 겹쳐 남아,
 * 한 화면에서 가로로 뽑은 뒤 다른 화면에서 Ctrl+P 를 누르면 거기도 가로로 나온다.
 *
 * ── 왜 인쇄할 때가 아니라 '고를 때' 적용하나 ──
 * 사용자는 버튼만 쓰는 게 아니라 **Ctrl+P** 로도 인쇄한다. 버튼 누르는 순간에만 규칙을
 * 넣으면 Ctrl+P 는 늘 세로로 나온다. 그래서 방향을 고른 동안 규칙을 계속 걸어 두고,
 * 화면을 떠날 때 거둔다.
 */

const STYLE_ID = 'print-orientation'

/** 'landscape' | 'portrait' | null(원래대로). 규칙은 늘 **하나만** 남는다. */
export const applyPrintOrientation = (orientation) => {
  if (typeof document === 'undefined') return
  const old = document.getElementById(STYLE_ID)
  if (old) old.remove()
  if (orientation !== 'landscape') return    // 세로는 index.css 의 기본값(@page A4)이 이미 맞다
  const el = document.createElement('style')
  el.id = STYLE_ID
  /* 가로는 여백을 조금 줄인다 — 가로로 뽑는 건 열이 많아서인데,
     세로와 같은 16mm 를 두면 정작 넓어진 폭을 여백이 도로 가져간다. */
  el.textContent = '@media print { @page { size: A4 landscape; margin: 12mm; } }'
  document.head.appendChild(el)
}

/** 화면마다 마지막 선택을 기억한다 — 매입매출장은 늘 가로, 결의서는 늘 세로인 식이다. */
export const readPrintOrientation = (key, fallback = 'portrait') => {
  try { return localStorage.getItem(`print-ori:${key}`) || fallback } catch { return fallback }
}
export const savePrintOrientation = (key, orientation) => {
  try { localStorage.setItem(`print-ori:${key}`, orientation) } catch { /* 사생활 보호 모드 등 */ }
}
