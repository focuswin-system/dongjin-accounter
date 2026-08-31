/**
 * 화면 설정 — 밝기(라이트/다크)·강조색·왼쪽 메뉴 표시 방식.
 *
 * ── 값이 사는 곳이 둘인 이유 ──
 * 최종 원본은 **서버(user_prefs)** 다. 사람에 붙는 설정이라 PC 를 바꿔도 따라와야 한다.
 * 그런데 서버 값은 로그인 뒤에야 온다 — 그때까지 기본(밝은) 화면을 그려 두면
 * 다크를 쓰는 사람은 **켤 때마다 흰 화면이 번쩍인다.** 그래서 localStorage 에도
 * 같은 값을 적어 두고, 첫 페인트는 그걸로 한다(index.html 의 인라인 스크립트).
 *
 *   localStorage  이 기기에서 **바로 그리기 위한** 사본. 진실이 아니다.
 *   user_prefs    진실. 로그인하면 이걸로 덮어쓴다.
 *
 * ⚠ 그래서 로그인 직후 한 번은 화면이 바뀔 수 있다(다른 PC 에서 바꿨을 때).
 *   그건 맞는 동작이다 — 틀린 값으로 계속 있는 것보다 낫다.
 *
 * ── 왜 <html> 의 data-* 인가 ──
 * CSS 가 `[data-theme="dark"]` 로 토큰만 갈아 끼운다(index.css). 클래스를 컴포넌트마다
 * 내려보내지 않으므로, 화면 코드는 테마를 **몰라도 된다** — 색을 토큰으로만 쓰면 따라온다.
 */

const KEY = 'ui_theme'

/* 고를 수 있는 값. 화면(ThemePanel)과 여기 두 곳에 적어 두면 언젠가 어긋나므로
   목록도 여기서 내보낸다. */
export const MODES = [
  { id: 'light',  label: '밝게' },
  { id: 'dark',   label: '어둡게' },
  /* 시스템 — 운영체제 설정을 따라간다. 밤에 자동으로 어두워지길 바라는 사람이 있다. */
  { id: 'system', label: '시스템 설정' },
]

export const ACCENTS = [
  { id: 'gold',   label: '금빛',   swatch: '#B08A4A' },
  { id: 'blue',   label: '파랑',   swatch: '#4B6FD8' },
  { id: 'green',  label: '초록',   swatch: '#3E9B72' },
  { id: 'violet', label: '보라',   swatch: '#8B5CD6' },
  { id: 'teal',   label: '청록',   swatch: '#3C8C9B' },
]

/**
 * 왼쪽 메뉴를 어떻게 세워 둘까.
 *
 * ⚠ 밝기(모드)와 **다른 축**이다. 색이 아니라 **자리를 얼마나 내주느냐**의 문제다 —
 *   메뉴를 늘 펴 두면 길을 잃지 않고, 접어 두면 표가 넓어진다. 넓은 표를 보는 사람과
 *   메뉴를 자주 오가는 사람이 원하는 게 다르다.
 */
export const NAV_MODES = [
  { id: 'fixed',  label: '항상 펼침', desc: '왼쪽에 늘 서 있어요. 길을 잃지 않아요.' },
  { id: 'rail',   label: '마우스 올리면 펼침', desc: '평소엔 아이콘만. 가져다 대면 펼쳐져요.' },
  { id: 'toggle', label: '버튼으로 열기', desc: '숨겨 두고 ☰ 를 눌러 열어요. 화면이 가장 넓어요.' },
]

export const DEFAULTS = { mode: 'light', accent: 'gold', navMode: 'fixed' }

const oneOf = (list, v, fallback) => (list.some(x => x.id === v) ? v : fallback)

/** 무엇이 들어와도 쓸 수 있는 값으로 — 서버 값이 낡았거나 사람이 손으로 고쳤을 수 있다 */
export const normalize = (raw) => {
  const t = raw && typeof raw === 'object' ? raw : {}
  return {
    mode:    oneOf(MODES,     t.mode,    DEFAULTS.mode),
    accent:  oneOf(ACCENTS,   t.accent,  DEFAULTS.accent),
    navMode: oneOf(NAV_MODES, t.navMode, DEFAULTS.navMode),
  }
}

/** 'system' 을 실제 밝기로 푼다. 그 밖의 값은 그대로. */
const resolveMode = (mode) => {
  if (mode !== 'system') return mode
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch { return 'light' }
}

/**
 * <html> 에 값을 붙인다 — CSS 가 읽는 유일한 자리.
 *
 * ⚠ 메뉴·헤더의 **색은 따로 고르지 않는다.** 밝기(모드)를 따라간다 —
 *   한때 셸 톤을 별도 축으로 뒀는데, 고를 것만 늘고 "이건 왜 따로지?"가 남았다.
 *   메뉴에서 정말 다른 사람마다 다른 것은 색이 아니라 **자리**였다(navMode).
 */
export const applyTheme = (raw) => {
  const t = normalize(raw)
  const el = document.documentElement
  const mode = resolveMode(t.mode)

  el.setAttribute('data-theme', mode)
  el.setAttribute('data-accent', t.accent)
  el.setAttribute('data-navmode', t.navMode)
  return t
}

export const readLocal = () => {
  try { return normalize(JSON.parse(localStorage.getItem(KEY) || '{}')) }
  catch { return normalize(null) }
}

export const writeLocal = (t) => {
  try { localStorage.setItem(KEY, JSON.stringify(normalize(t))) } catch { /* 사생활 보호 모드 */ }
}

/* 서버 prefs 는 칸이 납작하다(pref_key 하나에 값 하나). 그 모양과 여기 모양을 잇는다 —
   이 변환을 화면마다 적으면 키 이름이 조용히 갈린다. */
export const fromPrefs = (prefs) => normalize({
  mode:    prefs?.theme_mode,
  accent:  prefs?.theme_accent,
  navMode: prefs?.theme_nav_mode,
})

export const toPrefs = (t) => {
  const n = normalize(t)
  return { theme_mode: n.mode, theme_accent: n.accent, theme_nav_mode: n.navMode }
}

/* 'system' 을 고른 사람은 OS 가 밤에 바뀔 때 같이 바뀌어야 한다. 안 그러면
   '시스템 설정'이라는 이름이 거짓말이 된다. 구독을 끊는 함수를 돌려준다. */
export const watchSystem = (getTheme) => {
  let mq
  try { mq = window.matchMedia('(prefers-color-scheme: dark)') } catch { return () => {} }
  const on = () => { if (normalize(getTheme()).mode === 'system') applyTheme(getTheme()) }
  mq.addEventListener?.('change', on)
  return () => mq.removeEventListener?.('change', on)
}
