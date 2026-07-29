/**
 * 인증 · 계정 관리 — 멀티테넌트(테넌트 스코프 사용자)
 *
 * 로그인은 3필드: 회사코드 + 아이디 + 비밀번호.
 * username은 전역이 아니라 회사 안에서만 유일하므로(uq_company_user),
 * 회사코드 없이는 사용자를 특정할 수 없다.
 *
 * ⚠ 계정 관리 엔드포인트는 전부 req.user.companyId로 스코프를 건다.
 *   빠뜨리면 A사 관리자가 id만 알면 B사 계정을 수정할 수 있다.
 *
 * 설계: docs/02-design/features/multi-tenant-saas.design.md §2
 */
const { Router } = require('express')
const { randomUUID } = require('crypto')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { platformPool, audit } = require('../platform/db')
const authMiddleware = require('../middleware/auth')
const { setFileCookie, clearFileCookie } = require('../middleware/fileAuth')
const {
  clientIp, noteFailure, noteSuccess, ipBlockedFor, accountBlockedFor, waitMessage,
} = require('../lib/loginGuard')
const { signSession } = require('../lib/session')

const router = Router()

// role은 P1에서 기존 값(admin/user)을 유지한다. admin ≡ 회사 마스터.
// P5(RBAC)에서 role_perms 매트릭스로 대체하며 master/member 네이밍으로 이관 예정.
const isMaster = (req) => req.user?.role === 'admin'

// ── 로그인 ──
router.post('/login', async (req, res, next) => {
  try {
    const { companyCode, username, password } = req.body
    if (!companyCode || !username || !password) {
      return res.status(400).json({ error: '회사코드·아이디·비밀번호를 모두 입력하세요' })
    }

    // ── 무차별 대입 방어 ──
    // IP 층을 가장 먼저 본다. 회사코드 조회·bcrypt 비교보다 앞이어야
    // 잠긴 공격자가 DB와 해시 연산을 계속 소모시키지 못한다(느린 bcrypt는 그 자체로 부하).
    const ip = clientIp(req)
    const ipWait = ipBlockedFor(ip)
    if (ipWait) {
      res.set('Retry-After', String(ipWait))
      return res.status(429).json({ error: waitMessage(ipWait) })
    }

    const code = String(companyCode).trim().toLowerCase()
    const [companies] = await platformPool.execute(
      'SELECT id, code, name, db_name, active, status FROM companies WHERE code = ?', [code]
    )
    const company = companies[0]
    // 회사코드는 비밀이 아니므로 존재 여부를 알려줘도 안전하다(오히려 오타 안내에 유용).
    // 다만 없는 코드를 계속 찍어보는 것도 시도이므로 IP 층에는 실패로 센다.
    if (!company) {
      noteFailure(ip)
      return res.status(401).json({ error: '회사코드를 찾을 수 없습니다' })
    }
    if (!company.active || company.status !== 'active') {
      return res.status(403).json({ error: '이용이 중지된 회사입니다. 관리자에게 문의하세요' })
    }

    // 계정 층 — 이 회사의 이 아이디가 최근에 반복 실패했는지.
    // audit_logs 에 남는 username 과 맞춰 trim 한 값으로 조회한다.
    //
    // ⚠ 잠겨 있어도 여기서 바로 끊지 않는다. 회사코드는 비밀이 아니고 마스터 아이디는
    // 'admin' 으로 고정이라, 즉시 차단하면 아무나 틀린 비번 5회로 남의 회사 마스터를
    // 무기한 잠글 수 있다(15분마다 5회면 IP 층 임계값에도 안 걸린다 = 잠금이 DoS 무기가 된다).
    // 비밀번호는 끝까지 확인하고 맞으면 통과시킨다. 추측을 막는 목적은 그대로다 —
    // 틀린 비번은 잠금이 풀릴 때까지 계속 429로 거부된다.
    const uname = String(username).trim()
    const acctWait = await accountBlockedFor(platformPool, company.id, uname)

    const [rows] = await platformPool.execute(
      'SELECT * FROM users WHERE company_id = ? AND username = ? AND active = 1',
      [company.id, uname]
    )
    const user = rows[0]
    const ok = !!user && await bcrypt.compare(password, user.password)
    if (!ok) {
      noteFailure(ip)
      // 이 기록이 곧 계정 층의 카운트 근거다. fire-and-forget 으로 두면 동시에 들어온
      // 요청들이 서로의 실패를 보지 못하고 전부 잠금을 통과한다 → 응답 전에 확실히 남긴다.
      await audit({
        companyId: company.id, username: uname, action: 'login_fail', ip,
        detail: acctWait ? 'locked' : null,
      })
      if (acctWait) {
        res.set('Retry-After', String(acctWait))
        return res.status(429).json({ error: waitMessage(acctWait) })
      }
      // 아이디/비번은 어느 쪽이 틀렸는지 구분해서 알려주지 않는다.
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' })
    }

    // 수명·갱신 정책은 lib/session.js 한곳에서 정한다(쓰는 동안 튕기지 않도록 슬라이딩).
    const token = signSession({
      id: user.id,
      companyId: company.id,
      dbName: company.db_name,   // tenant 미들웨어가 이 값으로 회사 DB를 고른다(P2)
      username: user.username,
      name: user.name,
      role: user.role,
      // 임시 비번이면 토큰에 플래그 → 미들웨어가 비번 변경 전까지 다른 API를 막는다(서버 강제)
      mustChangePw: !!user.must_change_pw,
    })
    // 성공했으니 이 IP의 누적 실패를 한 번분 덜어낸다(같은 사무실 다른 사람이 애먼 잠금에 걸리지 않도록).
    noteSuccess(ip)
    // 이 기록이 계정 층의 카운트 기준선을 민다 = 잠겨 있었더라도 여기서 풀린다.
    // 응답보다 먼저 남아야 바로 다음 요청이 이미 풀린 상태를 본다.
    await audit({ companyId: company.id, userId: user.id, username: user.username, action: 'login', ip })
    // 첨부파일은 브라우저가 직접 열기 때문에 헤더를 실을 수 없다 → /uploads 전용 쿠키로 인증한다.
    setFileCookie(res, token)
    res.json({
      token,
      company: { code: company.code, name: company.name },
      user: {
        id: user.id, username: user.username, name: user.name, role: user.role,
        mustChangePw: !!user.must_change_pw,
      },
    })
  } catch (e) { next(e) }
})

// ── 로그아웃 ──
// JWT는 서버에 상태가 없어 무효화할 수 없지만(만료까지 유효), 첨부파일 쿠키는 반드시 지워야 한다.
// 안 지우면 로그아웃 후에도 8시간 동안 같은 브라우저에서 이전 회사 첨부에 접근할 수 있다.
// 인증을 요구하지 않는다 — 토큰이 이미 만료된 상태에서도 쿠키는 정리되어야 하기 때문.
router.post('/logout', (req, res) => {
  clearFileCookie(res)
  res.json({ ok: true })
})

// ── 내 정보 ──
router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const [rows] = await platformPool.execute(
      `SELECT u.id, u.username, u.name, u.email, u.role, u.must_change_pw, u.created_at,
              c.code AS company_code, c.name AS company_name
         FROM users u JOIN companies c ON u.company_id = c.id
        WHERE u.id = ? AND u.company_id = ?`,
      [req.user.id, req.user.companyId]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

// ── 사용자 목록 (회사 마스터만, 자사 계정만) ──
router.get('/users', authMiddleware, async (req, res, next) => {
  try {
    if (!isMaster(req)) return res.status(403).json({ error: '권한이 없습니다' })
    const [rows] = await platformPool.execute(
      `SELECT id, username, name, email, role, active, must_change_pw, created_at
         FROM users WHERE company_id = ? ORDER BY created_at`,
      [req.user.companyId]
    )
    res.json(rows)
  } catch (e) { next(e) }
})

// ── 사용자 추가 (회사 마스터만) ──
router.post('/users', authMiddleware, async (req, res, next) => {
  try {
    if (!isMaster(req)) return res.status(403).json({ error: '권한이 없습니다' })
    const { username, password, name, role, email } = req.body
    if (!username || !password) return res.status(400).json({ error: 'username, password 필수' })

    const hashed = await bcrypt.hash(password, 10)
    const id = randomUUID()
    // 관리자가 초기 비번을 정해 건네므로, 새 계정도 최초 로그인 시 본인이 비번을 바꾸게 강제한다.
    await platformPool.execute(
      'INSERT INTO users (id, company_id, username, password, name, email, role, must_change_pw) VALUES (?,?,?,?,?,?,?,1)',
      [id, req.user.companyId, String(username).trim(), hashed, name || '', email || null,
       role === 'admin' ? 'admin' : 'user']
    )
    audit({ companyId: req.user.companyId, userId: req.user.id, username: req.user.username,
            action: 'create', resource: 'user', targetId: id, ip: clientIp(req), detail: username })
    res.json({ id })
  } catch (e) {
    // uq_company_user 위반 — 같은 아이디가 '이 회사 안에' 이미 있다는 뜻(타사와는 무관).
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '이미 존재하는 아이디입니다' })
    next(e)
  }
})

// ── 비밀번호 변경 (본인) / 리셋 (마스터가 사내 계정 대상) ──
// 마스터가 남의 비번을 바꾸면 임시 비번으로 보고 최초 로그인 시 변경을 강제한다.
router.put('/users/:id/password', authMiddleware, async (req, res, next) => {
  try {
    const isSelf = req.user.id === req.params.id
    if (!isSelf && !isMaster(req)) return res.status(403).json({ error: '권한이 없습니다' })
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'password 필수' })

    const hashed = await bcrypt.hash(password, 10)
    const [result] = await platformPool.execute(
      'UPDATE users SET password = ?, must_change_pw = ? WHERE id = ? AND company_id = ?',
      [hashed, isSelf ? 0 : 1, req.params.id, req.user.companyId]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    audit({ companyId: req.user.companyId, userId: req.user.id, username: req.user.username,
            action: isSelf ? 'password_change' : 'password_reset', resource: 'user',
            targetId: req.params.id, ip: clientIp(req) })
    // 본인이 임시 비번을 바꾼 경우: 기존 토큰엔 mustChangePw=true가 남아 미들웨어가 계속 막는다
    // → mustChangePw를 뗀 새 토큰을 발급해 게이트를 즉시 푼다.
    if (isSelf && req.user.mustChangePw) {
      // 최초 로그인 시각(loginAt)은 그대로 물려준다 — 비번을 바꿨다고 절대 상한이 밀리면 안 된다.
      const token = signSession(
        { id: req.user.id, companyId: req.user.companyId, dbName: req.user.dbName,
          username: req.user.username, name: req.user.name, role: req.user.role,
          mustChangePw: false, loginAt: req.user.loginAt })
      return res.json({ ok: true, token })
    }
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// ── 계정 활성/비활성 (마스터만) ──
router.patch('/users/:id/active', authMiddleware, async (req, res, next) => {
  try {
    if (!isMaster(req)) return res.status(403).json({ error: '권한이 없습니다' })
    if (req.user.id === req.params.id) return res.status(400).json({ error: '본인 계정은 비활성화할 수 없습니다' })
    const { active } = req.body
    const [result] = await platformPool.execute(
      'UPDATE users SET active = ? WHERE id = ? AND company_id = ?',
      [active ? 1 : 0, req.params.id, req.user.companyId]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    audit({ companyId: req.user.companyId, userId: req.user.id, username: req.user.username,
            action: active ? 'activate' : 'deactivate', resource: 'user',
            targetId: req.params.id, ip: clientIp(req) })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// ── 권한 변경 (마스터만) — 본인 권한은 변경 불가(마지막 관리자 잠금 방지) ──
router.patch('/users/:id/role', authMiddleware, async (req, res, next) => {
  try {
    if (!isMaster(req)) return res.status(403).json({ error: '권한이 없습니다' })
    if (req.user.id === req.params.id) return res.status(400).json({ error: '본인 권한은 변경할 수 없습니다' })
    const { role } = req.body
    if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'role은 admin 또는 user여야 합니다' })
    const [result] = await platformPool.execute(
      'UPDATE users SET role = ? WHERE id = ? AND company_id = ?',
      [role, req.params.id, req.user.companyId]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    audit({ companyId: req.user.companyId, userId: req.user.id, username: req.user.username,
            action: 'role_change', resource: 'user', targetId: req.params.id,
            ip: clientIp(req), detail: role })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
