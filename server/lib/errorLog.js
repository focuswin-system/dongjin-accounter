/**
 * 서버 오류 수집 — 장애를 고객 전화로 알게 되는 상태를 끝낸다.
 *
 * 지금까지 500은 stdout 으로만 흘러갔다. 그건 서버에 SSH로 들어가야 볼 수 있고,
 * 여러 테넌트의 로그가 섞이며, 재시작하면 흩어진다. 그래서 "언제부터 몇 번 났는지"를
 * 아무도 답하지 못했다. 여기서 공용 관리 DB(error_logs)에 남겨 관리자 콘솔이 읽게 한다.
 *
 * ── 설계상 반드시 지키는 것 ──
 *
 * 1) **기록이 요청을 망치지 않는다.** 오류를 남기다 오류가 나면 본전도 못 찾는다.
 *    insert 는 await 하지 않고, 실패해도 삼킨다(stdout 경고만).
 *
 * 2) **값은 남기지 않는다.** 반드시 logSafe.safeErr()를 거친 것만 저장한다.
 *    원본 오류에는 SQL 파라미터(금액·거래처명)가 박혀 있다.
 *
 * 3) **폭주해도 DB를 밀어붙이지 않는다.** 오류는 대개 혼자 오지 않는다 —
 *    재시도 루프 하나가 초당 수백 건을 만든다. 그때 수집기가 DB를 두들기면
 *    수집기가 장애를 키운다. 창(窓)당 상한을 두고 넘치면 버린다(버린 수는 알린다).
 *
 * 4) **stdout 은 그대로 둔다.** DB가 죽은 순간의 오류는 DB에 못 남는다.
 *    이 수집은 콘솔 로그를 대체하는 게 아니라 그 위에 얹는 것이다.
 */
const { randomUUID, createHash } = require('crypto')
const { safeErr } = require('./logSafe')

/** 폭주 방어 — 이 시간 창 안에서 최대 이만큼만 기록한다 */
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 60

/** 보관 기간. 넘은 기록은 기동할 때 지운다(무한히 쌓이면 관리 DB가 커진다) */
const RETAIN_DAYS = 90

const MAX_MESSAGE = 500   // 컬럼 길이와 맞춤
const MAX_PATH = 255

const cut = (s, n) => (s == null ? null : String(s).slice(0, n))

/**
 * 같은 오류를 묶는 열쇠.
 *
 * 이게 없으면 '한 건이 300번 터진 것'과 '서로 다른 300건'을 구별할 수 없어,
 * 목록을 봐도 무엇부터 고쳐야 할지 알 수 없다.
 *
 * 숫자는 지운다 — 같은 버그라도 ID·금액 자리가 달라 다른 오류로 갈라지기 때문이다.
 * (메시지는 이미 마스킹돼 있지만 경로의 ID 등이 남는다)
 */
function fingerprintOf({ code, message, frame }) {
  const shape = String(message || '').replace(/\d+/g, '#')
  return createHash('sha1').update(`${code || ''}|${shape}|${frame || ''}`).digest('hex')
}

/** 스택에서 우리 코드의 첫 지점. node 내부 프레임은 어느 버그든 똑같아 묶는 데 쓸모가 없다 */
function appFrame(at) {
  if (!Array.isArray(at)) return null
  return at.find(l => !l.includes('node:internal')) || at[0] || null
}

/**
 * 저장할 행을 만든다. DB를 건드리지 않는 순수 함수라 그대로 검증할 수 있다.
 */
function buildRow({ err, req, status = 500, release = null }) {
  const safe = safeErr(err)
  const u = (req && req.user) || {}
  const frame = appFrame(safe.at)
  return {
    id: randomUUID(),
    companyId: u.companyId || null,
    userId: u.id || null,
    username: cut(u.username, 100),
    method: cut(req && req.method, 10),
    path: cut(req && (req.originalUrl || req.path), MAX_PATH),
    status: Number(status) || null,
    code: cut(safe.code || safe.name || null, 64),
    errno: Number.isInteger(safe.errno) ? safe.errno : null,
    message: cut(safe.message, MAX_MESSAGE),
    stack: safe.at ? safe.at.join('\n') : null,
    fingerprint: fingerprintOf({ code: safe.code || safe.name, message: safe.message, frame }),
    releaseId: cut(release, 80),
  }
}

const INSERT_SQL = `INSERT INTO error_logs
  (id, company_id, user_id, username, method, path, status, code, errno, message, stack, fingerprint, release_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`

/**
 * 수집기를 만든다.
 *
 * exec 를 주입받는 이유는 두 가지다 — lib/ 가 platform/ 을 끌어오지 않게 하고(의존 방향),
 * DB 없이 시험할 수 있게 하려고. 실제 배선은 index.js 에서 platformPool 로 한다.
 */
function createErrorRecorder({ exec, now = () => Date.now(), release = null, log = console }) {
  let windowStart = 0
  let writes = 0
  let dropped = 0

  /** 이번 요청을 기록해도 되는가 (폭주 방어) */
  function allow() {
    const t = now()
    if (t - windowStart > WINDOW_MS) {
      // 창이 바뀐다 — 직전 창에서 버린 게 있으면 그 사실만은 반드시 알린다.
      // 조용히 버리면 "오류가 60건뿐이었다"고 잘못 읽게 된다.
      if (dropped > 0) log.warn(`[errorLog] 폭주로 ${dropped}건 기록 생략(직전 1분)`)
      windowStart = t
      writes = 0
      dropped = 0
    }
    if (writes >= MAX_PER_WINDOW) { dropped++; return false }
    writes++
    return true
  }

  /**
   * 오류 한 건을 남긴다. 절대 throw 하지 않고, await 할 필요도 없다.
   * (프로미스를 돌려주므로 시험에서는 기다릴 수 있다)
   */
  function record({ err, req, status = 500 }) {
    if (!allow()) return Promise.resolve(false)
    let r
    try {
      r = buildRow({ err, req, status, release })
    } catch (e) {
      log.warn('[errorLog] 기록 준비 실패:', safeErr(e).message)
      return Promise.resolve(false)
    }
    return Promise.resolve()
      .then(() => exec(INSERT_SQL, [
        r.id, r.companyId, r.userId, r.username, r.method, r.path,
        r.status, r.code, r.errno, r.message, r.stack, r.fingerprint, r.releaseId,
      ]))
      .then(() => true)
      .catch(e => {
        // 여기서 다시 던지면 오류 핸들러 안에서 오류가 나 요청이 끝나지 않는다.
        log.warn('[errorLog] 기록 실패:', safeErr(e).message)
        return false
      })
  }

  /** 보관 기간이 지난 기록 정리. 기동할 때 한 번 부른다. */
  function prune(days = RETAIN_DAYS) {
    return Promise.resolve()
      .then(() => exec('DELETE FROM error_logs WHERE created_at < (NOW() - INTERVAL ? DAY)', [days]))
      .catch(e => log.warn('[errorLog] 오래된 기록 정리 실패:', safeErr(e).message))
  }

  return { record, prune }
}

module.exports = { createErrorRecorder, buildRow, fingerprintOf, RETAIN_DAYS, MAX_PER_WINDOW }
