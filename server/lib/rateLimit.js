/**
 * /api 전역 요청 한도 — 완만한 남용 방지
 *
 * 로그인 무차별 대입은 lib/loginGuard.js 가 훨씬 엄격하게 따로 막는다.
 * 여기는 그 밖의 경로(목록 조회·엑셀 내보내기 등)를 자동화 도구가 쉼 없이
 * 긁어가는 것을 막는 정도의, 사람이라면 절대 닿지 않는 선이다.
 *
 * 한도를 넉넉히 잡는 이유:
 *   한 사무실 전체가 같은 공인 IP로 나온다. 화면 하나를 열 때 API를 5~10번
 *   부르는 구조라, 빡빡하게 잡으면 공격자보다 경리 담당자가 먼저 막힌다.
 *   여기서 잡고 싶은 건 '정상 사용의 수십 배'이지 '정상 사용의 두 배'가 아니다.
 *
 * 메모리에 두는 이유는 loginGuard 와 같다 — ecosystem.config.js 가 instances:1 이다.
 * 여러 인스턴스로 늘리면 인스턴스마다 따로 세므로 한도가 사실상 N배가 된다.
 */
const { clientIp } = require('./loginGuard')

const WINDOW_MS = 60 * 1000
const MAX_REQ = 1000        // IP당 1분

/** @type {Map<string, {count: number, resetAt: number}>} */
const hits = new Map()

function prune(now) {
  for (const [ip, rec] of hits) if (rec.resetAt <= now) hits.delete(ip)
}

/**
 * @param {{ windowMs?: number, max?: number }} [opts] 테스트용 주입점
 */
function apiRateLimit(opts = {}) {
  const windowMs = opts.windowMs || WINDOW_MS
  const max = opts.max || MAX_REQ

  return function rateLimitMiddleware(req, res, next) {
    // 신뢰할 수 있는 IP 판정은 loginGuard 와 같은 함수를 쓴다.
    // 여기서 헤더를 그대로 믿으면 한도는 헤더 한 줄로 무력화된다.
    const ip = clientIp(req)
    if (!ip) return next()

    const now = Date.now()
    if (hits.size > 10000) prune(now)

    let rec = hits.get(ip)
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs }
      hits.set(ip, rec)
    }
    rec.count += 1

    if (rec.count > max) {
      const retry = Math.max(1, Math.ceil((rec.resetAt - now) / 1000))
      res.set('Retry-After', String(retry))
      // 정상 사용자가 여기에 닿았다면 그건 우리 쪽 버그(무한 루프 등)일 가능성이 높다.
      // 조용히 429만 주면 원인을 못 찾으므로 로그를 남긴다.
      console.warn(`[rateLimit] ${ip} 한도 초과 (${rec.count}/${max}) ${req.method} ${req.originalUrl}`)
      return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' })
    }
    next()
  }
}

module.exports = { apiRateLimit, _limits: { WINDOW_MS, MAX_REQ } }
