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

/** 로그인 응답에서 호출 — 파일 접근용 쿠키를 심는다. */
function setFileCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/uploads',            // API 요청에는 전송되지 않는다
    maxAge: 8 * 60 * 60 * 1000,  // JWT 만료(8h)와 동일
    secure: process.env.COOKIE_SECURE === '1',  // HTTPS 배포에서 1로 설정
  })
}

module.exports = { fileAuth, setFileCookie, COOKIE_NAME }
