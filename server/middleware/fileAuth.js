/**
 * 파일 접근 인증
 *
 * 첨부파일은 프런트가 <a href> · window.open 으로 브라우저를 직접 이동시켜 연다.
 * 이때는 Authorization 헤더를 실을 수 없으므로 Bearer만 요구하면 모든 첨부가 깨진다.
 *   → 로그인 시 발급한 httpOnly 쿠키(path=/uploads)로 인증한다.
 *     path가 /uploads로 한정돼 API 요청에는 전송되지 않으므로 CSRF 표면이 늘지 않고,
 *     httpOnly라 XSS로도 토큰을 훔칠 수 없다.
 *
 * 프로그램적 접근(fetch 등)을 위해 Authorization 헤더도 계속 받아준다.
 */
const jwt = require('jsonwebtoken')

const COOKIE_NAME = 'fa_file_token'

/** 의존성 추가 없이 Cookie 헤더를 직접 파싱한다. */
function readCookie(req, name) {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim())
    }
  }
  return null
}

function fileAuth(req, res, next) {
  const header = req.headers.authorization
  const token = header && header.startsWith('Bearer ')
    ? header.slice(7)
    : readCookie(req, COOKIE_NAME)

  if (!token) return res.status(401).send('로그인이 필요합니다')

  let payload
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return res.status(401).send('세션이 만료되었습니다. 다시 로그인해 주세요')
  }
  if (!payload.companyId) return res.status(401).send('다시 로그인해 주세요')

  req.fileUser = payload
  next()
}

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict',
  path: '/uploads',            // API 요청에는 전송되지 않는다
  secure: process.env.COOKIE_SECURE === '1',  // HTTPS 배포에서 1로 설정(.env.example 참조)
}

/** 로그인 응답에서 호출 — 파일 접근용 쿠키를 심는다. */
function setFileCookie(res, token) {
  res.cookie(COOKIE_NAME, token, { ...COOKIE_OPTS, maxAge: 8 * 60 * 60 * 1000 })
}

/**
 * 로그아웃 시 호출 — 쿠키를 제거한다.
 * 이게 없으면 로그아웃 후에도 쿠키가 8시간 살아 있어, 같은 브라우저를 쓰는 다음 사람이
 * /uploads/{companyId}/{파일명} 을 직접 입력해 이전 사용자 회사의 첨부를 받을 수 있다.
 * ⚠ clearCookie는 옵션(path/secure/sameSite)이 발급 때와 같아야 지워진다.
 */
function clearFileCookie(res) {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTS)
}

module.exports = { fileAuth, setFileCookie, clearFileCookie, COOKIE_NAME }
