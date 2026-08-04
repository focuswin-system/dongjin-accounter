const express = require('express')
const bcrypt = require('bcryptjs')
const { randomUUID } = require('crypto')
const { platformPool, audit } = require('../platform/db')
const { signSession } = require('../lib/session')
const { clientIp, noteFailure, noteSuccess, ipBlockedFor, waitMessage } = require('../lib/loginGuard')
const { withTx, httpError } = require('../lib/withTx')
const platformAuth = require('../middleware/platformAuth')

const router = express.Router()

/**
 * 운영자 콘솔 API — 서비스 전체를 가로질러 본다.
 *
 * ⚠ 이 라우터는 이 코드베이스에서 **유일하게 테넌트 격리를 의도적으로 넘는 곳**이다.
 * 회사별 DB(req.db)를 쓰지 않고 공용 관리 DB를 회사 구분 없이 읽는다.
 * 그게 목적이기 때문이다 — "지금 어느 회사에서 장애가 났나"는 회사 안에서는 답할 수 없다.
 *
 * 그래서 자물쇠를 **두 개** 건다(index.js 에서 순서대로 적용).
 *   1) middleware/lanOnly  — 사무실 LAN에서 온 요청만. 밖에서는 404, 문이 안 보인다.
 *   2) middleware/platformAuth — platform_admins 계정의 토큰만. 회사 사용자 토큰은 거부.
 *
 * 그리고 **회계 내용은 여기서도 보지 않는다.** 거래·금액·거래처는 이 API 어디에도 없다.
 * 운영에 필요한 건 '무엇이 고장났나'이지 '고객이 얼마를 벌었나'가 아니다.
 * 고객 데이터를 안 보는 것이 정책이자, 실수로도 못 보게 만드는 설계다.
 */

/** 조회 상한 — 콘솔은 훑어보는 화면이지 분석 도구가 아니다 */
const MAX_ROWS = 200

/* 없는 계정으로 로그인을 시도해도 있는 계정과 같은 시간이 걸리게 하는 더미 해시.
   (어떤 비밀번호와도 맞지 않는다 — 무작위 값을 해싱한 결과다) */
const DUMMY_HASH = '$2b$10$jwNKqcjn4D3WM2dBVnIYmuAO9pixCahE8qcr51GeDiDpn7Jt2hvY.'
const intIn = (v, min, max, dflt) => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt
}

// ── 로그인 ──
// LAN 안이라도 비밀번호는 필요하다. 사무실 안의 누구나 볼 수 있는 화면이 아니다.
router.post('/login', async (req, res, next) => {
  try {
    const ip = clientIp(req)
    const wait = ipBlockedFor(ip)
    if (wait) {
      res.set('Retry-After', String(wait))
      return res.status(429).json({ error: waitMessage(wait) })
    }

    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    if (!username || !password) {
      return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' })
    }

    const [[admin]] = await platformPool.execute(
      'SELECT id, username, name, password FROM platform_admins WHERE username = ?', [username])

    /* 계정이 없든 비번이 틀리든 **같은 응답**을 준다 — 어느 아이디가 존재하는지 알려주지 않는다.
     *
     * 문구만 같게 해서는 부족하다. 계정이 없을 때 bcrypt 비교를 건너뛰면 응답이 눈에 띄게
     * 빨라져(해시 비교는 의도적으로 느리다) **시간만 재도 아이디 존재 여부를 알 수 있다.**
     * 없을 때도 같은 비용을 치러 그 차이를 없앤다. */
    const okPw = await bcrypt.compare(password, admin ? admin.password : DUMMY_HASH)
                 && Boolean(admin)
    if (!okPw) {
      noteFailure(ip)
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' })
    }
    noteSuccess(ip)

    // companyId·dbName 은 절대 싣지 않는다 — 이 토큰이 테넌트 API로 새어 들어가면 안 된다.
    const token = signSession({
      kind: 'platform', id: admin.id, username: admin.username, name: admin.name,
    })
    res.json({ token, admin: { username: admin.username, name: admin.name } })
  } catch (e) { next(e) }
})

// ── 여기서부터 운영자 인증 필요 ──
router.use(platformAuth)

router.get('/me', (req, res) => res.json({ admin: req.admin }))

/**
 * 테넌트 현황 — 회사별 사용자 수·마지막 로그인·최근 오류 건수.
 * 회계 데이터는 건드리지 않는다(회사 DB에 접속조차 하지 않는다).
 */
router.get('/overview', async (req, res, next) => {
  try {
    const [companies] = await platformPool.execute(
      `SELECT c.id, c.code, c.name, c.db_name, c.status, c.active, c.created_at,
              (SELECT COUNT(*) FROM users u
                WHERE u.company_id = c.id AND u.active = 1)                    AS users,
              (SELECT MAX(a.created_at) FROM audit_logs a
                WHERE a.company_id = c.id AND a.action = 'login')              AS last_login,
              (SELECT COUNT(*) FROM error_logs e
                WHERE e.company_id = c.id
                  AND e.created_at >= NOW() - INTERVAL 7 DAY)                  AS errors_7d,
              (SELECT COUNT(*) FROM audit_logs a
                WHERE a.company_id = c.id AND a.action = 'login_fail'
                  AND a.created_at >= NOW() - INTERVAL 1 DAY)                  AS login_fails_1d
         FROM companies c
        ORDER BY c.active DESC, c.code`)

    // 회사와 무관한 오류(로그인 전·기동 중)도 있다 — 회사별 합계만 보면 놓친다.
    const [[{ orphan }]] = await platformPool.execute(
      `SELECT COUNT(*) AS orphan FROM error_logs
        WHERE company_id IS NULL AND created_at >= NOW() - INTERVAL 7 DAY`)

    res.json({ companies, orphanErrors7d: orphan, server: req.app.get('deployInfo') || null })
  } catch (e) { next(e) }
})

/**
 * 최근 오류 — 같은 것끼리 묶어서. 300번 난 한 건과 서로 다른 300건은 전혀 다른 상황이다.
 * 저장된 값은 이미 마스킹돼 있다(lib/logSafe.js).
 */
router.get('/errors', async (req, res, next) => {
  try {
    const limit = intIn(req.query.limit, 1, MAX_ROWS, 50)
    const days = intIn(req.query.days, 1, 90, 7)
    const grouped = String(req.query.grouped || '1') === '1'

    if (grouped) {
      const [rows] = await platformPool.execute(
        `SELECT e.fingerprint, COUNT(*) AS hits, MAX(e.created_at) AS last_seen,
                MIN(e.created_at) AS first_seen,
                COUNT(DISTINCT e.company_id) AS companies,
                SUBSTRING_INDEX(GROUP_CONCAT(e.code ORDER BY e.created_at DESC), ',', 1)    AS code,
                SUBSTRING_INDEX(GROUP_CONCAT(e.message ORDER BY e.created_at DESC SEPARATOR '\\n'), '\\n', 1) AS message,
                SUBSTRING_INDEX(GROUP_CONCAT(e.path ORDER BY e.created_at DESC), ',', 1)    AS path
           FROM error_logs e
          WHERE e.created_at >= NOW() - INTERVAL ${days} DAY
          GROUP BY e.fingerprint
          ORDER BY last_seen DESC
          LIMIT ${limit}`)
      return res.json({ grouped: true, days, rows })
    }

    const [rows] = await platformPool.execute(
      `SELECT id, company_id, username, method, path, status, code, errno,
              message, stack, fingerprint, release_id, created_at
         FROM error_logs
        WHERE created_at >= NOW() - INTERVAL ${days} DAY
        ORDER BY created_at DESC
        LIMIT ${limit}`)
    res.json({ grouped: false, days, rows })
  } catch (e) { next(e) }
})

/** 한 묶음의 실제 발생 건들 — 목록에서 하나를 눌렀을 때 */
router.get('/errors/:fingerprint', async (req, res, next) => {
  try {
    const [rows] = await platformPool.execute(
      `SELECT e.id, e.company_id, c.code AS company_code, e.username, e.method, e.path,
              e.status, e.code, e.errno, e.message, e.stack, e.release_id, e.created_at
         FROM error_logs e
         LEFT JOIN companies c ON c.id = e.company_id
        WHERE e.fingerprint = ?
        ORDER BY e.created_at DESC
        LIMIT 20`, [String(req.params.fingerprint).slice(0, 40)])
    res.json({ rows })
  } catch (e) { next(e) }
})

/**
 * 로그인 실패 — 어느 회사에 무차별 대입이 들어오는지.
 * 성공은 여기 없다(그건 회사 안의 변경 이력이 보여준다).
 */
router.get('/login-failures', async (req, res, next) => {
  try {
    const limit = intIn(req.query.limit, 1, MAX_ROWS, 50)
    const days = intIn(req.query.days, 1, 30, 3)
    const [rows] = await platformPool.execute(
      `SELECT a.created_at, a.username, a.ip, a.detail, c.code AS company_code, c.name AS company_name
         FROM audit_logs a
         LEFT JOIN companies c ON c.id = a.company_id
        WHERE a.action = 'login_fail'
          AND a.created_at >= NOW() - INTERVAL ${days} DAY
        ORDER BY a.created_at DESC
        LIMIT ${limit}`)
    res.json({ days, rows })
  } catch (e) { next(e) }
})

/* ── 회사별 계정 관리 ──────────────────────────────────────────────
 *
 * 운영자가 고객사 계정을 만들고 비밀번호를 바꿀 수 있다. 편의는 크지만, 이건
 * **고객사 회계 데이터로 들어가는 경로**이기도 하다 — 비번을 아는 값으로 바꾸면
 * 그 회사로 로그인할 수 있다. 기능을 넣기로 한 이상, 숨기지 않는 것으로 상쇄한다.
 *
 *   · 모든 행위를 **그 회사의 감사 로그**에 남긴다 → 고객사 마스터가 자기 화면
 *     (환경설정 → 변경 이력)에서 "운영자가 내 계정 비번을 바꿨다"를 본다.
 *   · 남기는 이름은 `ops:<운영자아이디>` 다. 회사 사용자와 절대 헷갈리지 않는다.
 *   · 비밀번호를 바꾸면 must_change_pw=1 — 본인이 다시 바꾸게 강제된다(회사 마스터가
 *     바꿀 때와 같은 규칙). 운영자가 정한 비번이 조용히 계속 살아 있지 않는다.
 *
 * 되돌릴 수 없는 것(계정 삭제)은 넣지 않았다. 정지(active=0)로 충분하고,
 * 삭제는 그 사람이 남긴 기록의 주인을 지우는 일이라 성격이 다르다.
 */

/** 회사가 실제로 있는지 — 없는 회사 id로 남의 회사 행을 건드리지 못하게 */
async function companyOr404(companyId, res) {
  const [[c]] = await platformPool.execute(
    'SELECT id, code, name FROM companies WHERE id = ?', [companyId])
  if (!c) { res.status(404).json({ error: '회사를 찾을 수 없습니다' }); return null }
  return c
}

/**
 * 운영자 행위를 그 회사 감사 로그에 남긴다 — **변경과 같은 트랜잭션 안에서.**
 *
 * 다른 감사 기록은 곁다리라 실패해도 업무를 막지 않는다(platform/db.js audit()은 실패를 삼킨다).
 * 여기는 다르다 — 기록이 이 기능을 정당화하는 근거다.
 * "운영자가 고객 비밀번호를 바꿀 수 있되, 고객이 그걸 본다"가 성립해야 하는데,
 * 기록만 실패하면 **바뀌었는데 아무도 모르는** 상태가 된다. 그게 정확히 백도어다.
 *
 * users 와 audit_logs 는 같은 공용 DB에 있으므로 한 트랜잭션에 묶을 수 있다.
 * 묶으면 '변경됐는데 기록이 없는' 경우가 생길 수 없다 — 같이 성공하거나 같이 없던 일이 된다.
 */
function auditAsOpsTx(conn, req, { companyId, action, targetId, detail }) {
  return conn.execute(
    `INSERT INTO audit_logs (id, company_id, user_id, username, action, resource, target_id, ip, detail)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [randomUUID(), companyId, null,            // userId: 회사 사용자가 아니다
     `ops:${req.admin.username}`,              // 회사 사용자와 헷갈리지 않는 표기
     action, 'user', targetId, clientIp(req), detail || null])
}

// 계정 목록
router.get('/companies/:id/users', async (req, res, next) => {
  try {
    const company = await companyOr404(req.params.id, res)
    if (!company) return
    const [rows] = await platformPool.execute(
      `SELECT u.id, u.username, u.name, u.email, u.role, u.active, u.must_change_pw, u.created_at,
              (SELECT MAX(a.created_at) FROM audit_logs a
                WHERE a.company_id = u.company_id AND a.username = u.username
                  AND a.action = 'login')                                        AS last_login,
              (SELECT COUNT(*) FROM audit_logs a
                WHERE a.company_id = u.company_id AND a.username = u.username
                  AND a.action = 'login_fail'
                  AND a.created_at >= NOW() - INTERVAL 30 MINUTE
                  AND a.created_at > COALESCE((SELECT MAX(s.created_at) FROM audit_logs s
                       WHERE s.company_id = u.company_id AND s.username = u.username
                         AND s.action IN ('login','unlock')), '1970-01-01'))     AS recent_fails
         FROM users u
        WHERE u.company_id = ?
        ORDER BY u.role DESC, u.username`, [req.params.id])
    res.json({ company, rows })
  } catch (e) { next(e) }
})

// 계정 추가
router.post('/companies/:id/users', async (req, res, next) => {
  try {
    const company = await companyOr404(req.params.id, res)
    if (!company) return
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    if (!username || !password) return res.status(400).json({ error: '아이디와 임시 비밀번호를 입력하세요' })
    if (password.length < 8) return res.status(400).json({ error: '임시 비밀번호는 8자 이상이어야 합니다' })

    const id = randomUUID()
    const hashed = await bcrypt.hash(password, 10)   // 트랜잭션 밖에서 — 느린 해싱으로 잠금을 쥐고 있지 않는다
    await withTx(platformPool, async (conn) => {
      await conn.execute(
        `INSERT INTO users (id, company_id, username, password, name, email, role, must_change_pw)
         VALUES (?,?,?,?,?,?,?,1)`,
        [id, company.id, username, hashed,
         String(req.body?.name || ''), req.body?.email || null,
         req.body?.role === 'admin' ? 'admin' : 'user'])
      await auditAsOpsTx(conn, req, {
        companyId: company.id, action: 'create', targetId: id, detail: username,
      })
    })
    res.json({ id })
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '이미 존재하는 아이디입니다' })
    next(e)
  }
})

// 사용/정지
router.patch('/companies/:id/users/:userId/active', async (req, res, next) => {
  try {
    const company = await companyOr404(req.params.id, res)
    if (!company) return
    const active = req.body?.active ? 1 : 0
    await withTx(platformPool, async (conn) => {
      // company_id 를 함께 건다 — 회사 밖 사용자를 건드릴 수 없게(경로 조작 방어)
      const [r] = await conn.execute(
        'UPDATE users SET active = ? WHERE id = ? AND company_id = ?',
        [active, req.params.userId, company.id])
      if (!r.affectedRows) throw httpError(404, '계정을 찾을 수 없습니다')
      await auditAsOpsTx(conn, req, {
        companyId: company.id, action: active ? 'activate' : 'deactivate', targetId: req.params.userId,
      })
    })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 비밀번호 초기화 — 임시 비번. 본인이 최초 로그인 때 반드시 바꾼다.
router.post('/companies/:id/users/:userId/password', async (req, res, next) => {
  try {
    const company = await companyOr404(req.params.id, res)
    if (!company) return
    const password = String(req.body?.password || '')
    if (password.length < 8) return res.status(400).json({ error: '임시 비밀번호는 8자 이상이어야 합니다' })

    const hashed = await bcrypt.hash(password, 10)    // 트랜잭션 밖에서(느린 해싱으로 잠금을 쥐지 않는다)
    await withTx(platformPool, async (conn) => {
      const [r] = await conn.execute(
        'UPDATE users SET password = ?, must_change_pw = 1 WHERE id = ? AND company_id = ?',
        [hashed, req.params.userId, company.id])
      if (!r.affectedRows) throw httpError(404, '계정을 찾을 수 없습니다')
      await auditAsOpsTx(conn, req, {
        companyId: company.id, action: 'password_reset', targetId: req.params.userId,
      })
    })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/**
 * 로그인 잠금 해제.
 *
 * 시도 제한은 '마지막 성공 이후의 실패'를 센다(lib/loginGuard.js). 그래서 해제란
 * **기준선을 지금으로 밀어주는 것**이다. 가짜 'login' 기록을 넣으면 로그인하지도 않은
 * 사람이 로그인한 것처럼 남으므로, 'unlock' 이라는 자기 이름으로 남기고
 * loginGuard 가 그것도 기준선으로 인정한다.
 */
router.post('/companies/:id/users/:userId/unlock', async (req, res, next) => {
  try {
    const company = await companyOr404(req.params.id, res)
    if (!company) return
    const [[u]] = await platformPool.execute(
      'SELECT username FROM users WHERE id = ? AND company_id = ?', [req.params.userId, company.id])
    if (!u) return res.status(404).json({ error: '계정을 찾을 수 없습니다' })

    // 기준선이 되는 기록이므로 반드시 기다린다(기다리지 않으면 해제 전에 응답이 나간다)
    await audit({
      companyId: company.id, userId: req.params.userId, username: u.username,
      action: 'unlock', resource: 'user', targetId: req.params.userId, ip: clientIp(req),
      detail: `ops:${req.admin.username}`,
    })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
