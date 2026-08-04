/**
 * 사무실 LAN 전용 게이트 — 운영자 콘솔의 첫 번째 자물쇠.
 *
 * 관리자 콘솔은 **전 회사의 데이터를 횡단으로** 본다. 테넌트 격리를 의도적으로 넘는
 * 유일한 문이라, 그 문이 인터넷에 노출되면 격리 전체가 무의미해진다.
 * 그래서 인증(비밀번호)에 앞서 **경로 자체를 사무실 안으로 제한한다.**
 * 밖에서는 로그인 화면조차 보이지 않는다 — 무차별 대입할 대상이 아예 없다.
 *
 * ── 어떻게 가르는가 ──
 * 이 서버는 0.0.0.0:8081 에 바인딩돼 두 경로로 요청을 받는다.
 *
 *   외부(donidora.com) : cloudflared 가 **같은 장비의 localhost** 로 전달한다
 *                        → 소켓 상대가 루프백이고, 원 IP가 CF-Connecting-IP 헤더에 실린다
 *   사무실 LAN 직접     : 소켓 상대가 곧 진짜 주소다 (192.168.x.x)
 *
 * 판정 근거는 **소켓 주소**뿐이다. 헤더는 LAN 안에서 누구든 지어낼 수 있으므로
 * 통과 근거로 삼지 않는다 — 오히려 '루프백인데 프록시 헤더가 있다'는 것은
 * 터널을 통해 들어왔다는 뜻이므로 **차단 근거**로만 쓴다.
 * (lib/loginGuard.js clientIp 과 같은 관점이다)
 */

/** IPv6로 표현된 IPv4(::ffff:192.168.0.5)를 벗겨낸다 */
const bare = (ip) => String(ip || '').replace(/^::ffff:/, '')

const isLoopback = (ip) => {
  const a = bare(ip)
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.')
}

/** 사설 대역 — RFC1918 + 링크로컬 */
function isPrivate(ip) {
  const a = bare(ip)
  if (/^10\./.test(a)) return true
  if (/^192\.168\./.test(a)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true
  if (/^169\.254\./.test(a)) return true
  if (/^(fc|fd)/i.test(a)) return true         // IPv6 유니크 로컬
  if (/^fe80:/i.test(a)) return true           // IPv6 링크로컬
  return false
}

/** 터널(외부)을 거쳐 들어왔는가 — 프록시가 붙인 원 IP 헤더가 있으면 그렇다 */
const viaProxy = (req) =>
  Boolean(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'])

/**
 * 이 요청이 사무실 안에서 온 것인가.
 * 순수 함수로 빼두어 DB·서버 없이 검증한다(테스트가 이 판정을 직접 본다).
 */
function isFromLan(req) {
  const peer = req.socket?.remoteAddress || req.ip || ''
  if (!peer) return false
  // 루프백은 두 가지다 — 서버 장비에서 직접(허용) vs 터널이 전달(차단).
  if (isLoopback(peer)) return !viaProxy(req)
  return isPrivate(peer)
}

/**
 * 게이트. 밖에서 온 요청에는 **404를 준다** — 403이면 "여기 뭔가 있다"를 알려주는 셈이다.
 * 없는 경로처럼 보이는 편이 낫다.
 */
module.exports = function lanOnly(req, res, next) {
  if (isFromLan(req)) return next()
  res.status(404).json({ error: 'Not found' })
}

module.exports.isFromLan = isFromLan
module.exports._internal = { isPrivate, isLoopback, viaProxy }
