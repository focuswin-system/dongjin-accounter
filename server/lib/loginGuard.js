/**
 * 로그인 시도 제한 — 무차별 대입(brute force) 방어
 *
 * 이 서비스는 https://donidora.com 으로 인터넷에 열려 있고, 회사코드는 비밀이 아니며
 * 마스터 아이디는 관례적으로 'admin' 이다. 즉 공격자에게 남은 미지수는 비밀번호 하나뿐이라
 * 시도 횟수를 막지 않으면 자동화 도구가 초당 수십 번씩 계속 두드릴 수 있다.
 *
 * 두 층으로 막는다.
 *   1) 계정 단위 — 한 계정을 집중해서 두드리는 경우. **주 방어선**.
 *   2) IP 단위   — 계정을 갈아타며 흩뿌리는 경우(스프레이). 1)만으로는 안 잡힌다.
 *
 * 계정 단위를 DB(audit_logs)로 세는 이유:
 *   로그인 실패는 이미 audit({action:'login_fail'})로 기록되고 있다. 새 테이블을 만드는 대신
 *   그 기록을 읽으면, 프로세스 재시작·배포(pm2 reload)에도 잠금이 유지된다.
 *   메모리에만 두면 공격자가 아니라 '배포'가 잠금을 풀어버린다.
 *
 * IP 단위를 메모리로 두는 이유:
 *   ecosystem.config.js 가 instances:1 이라 프로세스가 하나뿐이다. 여러 인스턴스로 늘리면
 *   이 층은 인스턴스마다 따로 세게 되므로, 그때는 계정 단위처럼 DB로 옮겨야 한다.
 */

// ── 임계값 ──
// 정상 사용자는 오타로 3~4번은 틀린다. 5회는 실사용을 방해하지 않으면서
// 자동화 시도는 즉시 무의미해지는 지점이다.
const ACCOUNT_WINDOW_MIN = 15   // 이 시간 안의 실패만 센다
const ACCOUNT_MAX_FAILS = 5     // 이만큼 실패하면 잠금
const ACCOUNT_LOCK_MIN = 15     // 마지막 실패로부터 이만큼 잠금
const ACCOUNT_HARD_FAILS = 10   // 계속 두드리면
const ACCOUNT_HARD_LOCK_MIN = 60 // 잠금을 늘린다

const IP_WINDOW_MIN = 10
const IP_MAX_FAILS = 20         // 한 사무실에서 여러 명이 쓸 수 있으므로 계정보다 넉넉히
const IP_LOCK_MIN = 10

const MIN = 60 * 1000

/**
 * 신뢰할 수 있는 클라이언트 IP.
 *
 * ⚠ x-forwarded-for 를 무조건 믿으면 안 된다. 이 서버는 0.0.0.0:8081 에 바인딩되어
 * 사무실 LAN에서 직접 접근할 수 있으므로, LAN의 누군가가 헤더를 지어내면 남의 IP인 척하며
 * 제한을 우회하거나 정상 IP를 대신 잠글 수 있다.
 *
 * 외부 트래픽은 cloudflared 가 같은 장비에서 localhost 로 전달한다 → 소켓 상대가 루프백일 때만
 * 프록시가 붙인 헤더로 인정한다. 그 외(=LAN 직접 접속)는 소켓 주소가 곧 진짜 주소다.
 */
function clientIp(req) {
  const peer = req.socket?.remoteAddress || req.ip || ''
  const fromLoopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
  if (fromLoopback) {
    // Cloudflare 는 원 IP를 CF-Connecting-IP 에 넣는다. 없으면 XFF 첫 항목.
    const cf = req.headers['cf-connecting-ip']
    if (cf) return String(cf).trim().slice(0, 45)
    const xff = req.headers['x-forwarded-for']
    if (xff) return String(xff).split(',')[0].trim().slice(0, 45)
  }
  return String(peer).slice(0, 45) || null
}

// ── IP 층 (메모리) ──
/** @type {Map<string, {count: number, first: number, until: number}>} */
const ipFails = new Map()

function pruneIp(now) {
  // 항목이 쌓이는 걸 막는다. 만료된 것만 지우므로 잠금 중인 IP는 남는다.
  for (const [ip, rec] of ipFails) {
    if (rec.until <= now && now - rec.first > IP_WINDOW_MIN * MIN) ipFails.delete(ip)
  }
}

/** 로그인 실패를 IP 층에 기록한다. 회사코드가 틀린 경우처럼 계정을 특정할 수 없을 때도 부른다. */
function noteFailure(ip) {
  if (!ip) return
  const now = Date.now()
  if (ipFails.size > 5000) pruneIp(now)   // 방치 시 메모리 증가 방지
  const rec = ipFails.get(ip)
  if (!rec || now - rec.first > IP_WINDOW_MIN * MIN) {
    ipFails.set(ip, { count: 1, first: now, until: 0 })
    return
  }
  rec.count += 1
  if (rec.count >= IP_MAX_FAILS) rec.until = now + IP_LOCK_MIN * MIN
}

/** 로그인 성공 — 그 IP의 누적 실패를 지운다(정상 사용자가 오래 묶이지 않도록). */
function noteSuccess(ip) {
  if (ip) ipFails.delete(ip)
}

/** IP가 잠겨 있으면 남은 초, 아니면 0. */
function ipBlockedFor(ip) {
  if (!ip) return 0
  const rec = ipFails.get(ip)
  if (!rec || !rec.until) return 0
  const left = Math.ceil((rec.until - Date.now()) / 1000)
  return left > 0 ? left : 0
}

/**
 * 계정이 잠겨 있으면 남은 초, 아니면 0.
 *
 * 마지막 '성공' 이후의 실패만 센다 — 몇 번 틀리다 로그인에 성공한 사용자가
 * 잠시 뒤 한 번 더 틀렸다고 잠기면 안 되기 때문이다.
 *
 * 시간 비교는 전부 DB 안에서 한다(클라이언트 시계와 DB 시계가 어긋나도 영향 없음).
 *
 * @param {import('mysql2/promise').Pool} platformPool
 * @param {string} companyId
 * @param {string} username  auth.js 와 같은 방식으로 trim 된 값
 */
async function accountBlockedFor(platformPool, companyId, username) {
  if (!companyId || !username) return 0
  // 임계값은 전부 이 파일의 상수다(사용자 입력이 SQL로 들어가지 않는다).
  const [[row]] = await platformPool.execute(
    `SELECT COUNT(*) AS fails,
            UNIX_TIMESTAMP(MAX(created_at)) AS lastFail,
            UNIX_TIMESTAMP() AS now
       FROM audit_logs
      WHERE company_id = ? AND username = ? AND action = 'login_fail'
        AND created_at >= NOW() - INTERVAL ${ACCOUNT_WINDOW_MIN} MINUTE
        AND created_at > COALESCE(
              (SELECT MAX(s.created_at) FROM audit_logs s
                WHERE s.company_id = ? AND s.username = ? AND s.action = 'login'),
              '1970-01-01 00:00:00')`,
    [companyId, username, companyId, username]
  )
  const fails = Number(row?.fails || 0)
  if (fails < ACCOUNT_MAX_FAILS) return 0

  const lockMin = fails >= ACCOUNT_HARD_FAILS ? ACCOUNT_HARD_LOCK_MIN : ACCOUNT_LOCK_MIN
  const left = Number(row.lastFail) + lockMin * 60 - Number(row.now)
  return left > 0 ? Math.ceil(left) : 0
}

/** 사용자에게 보여줄 대기 안내 — 초 단위는 불안만 주므로 분으로 올림한다. */
function waitMessage(seconds) {
  const min = Math.max(1, Math.ceil(seconds / 60))
  return `로그인 시도가 너무 많습니다. ${min}분 후에 다시 시도해 주세요.`
}

module.exports = {
  clientIp,
  noteFailure,
  noteSuccess,
  ipBlockedFor,
  accountBlockedFor,
  waitMessage,
  // 테스트·운영 점검용
  _thresholds: {
    ACCOUNT_WINDOW_MIN, ACCOUNT_MAX_FAILS, ACCOUNT_LOCK_MIN,
    ACCOUNT_HARD_FAILS, ACCOUNT_HARD_LOCK_MIN,
    IP_WINDOW_MIN, IP_MAX_FAILS, IP_LOCK_MIN,
  },
}
