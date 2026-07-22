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

const router = Router()

// role은 P1에서 기존 값(admin/user)을 유지한다. admin ≡ 회사 마스터.
// P5(RBAC)에서 role_perms 매트릭스로 대체하며 master/member 네이밍으로 이관 예정.
const isMaster = (req) => req.user?.role === 'admin'
const clientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || null

// ── 로그인 ──
router.post('/login', async (req, res, next) => {
  try {
    const { companyCode, username, password } = req.body
    if (!companyCode || !username || !password) {
      return res.status(400).json({ error: '회사코드·아이디·비밀번호를 모두 입력하세요' })
    }

    const code = String(companyCode).trim().toLowerCase()
    const [companies] = await platformPool.execute(
      'SELECT id, code, name, db_name, active, status FROM companies WHERE code = ?', [code]
    )
    const company = companies[0]
    // 회사코드는 비밀이 아니므로 존재 여부를 알려줘도 안전하다(오히려 오타 안내에 유용).
    if (!company) return res.status(401).json({ error: '회사코드를 찾을 수 없습니다' })
    if (!company.active || company.status !== 'active') {
      return res.status(403).json({ error: '이용이 중지된 회사입니다. 관리자에게 문의하세요' })
    }

    const [rows] = await platformPool.execute(
      'SELECT * FROM users WHERE company_id = ? AND username = ? AND active = 1',
      [company.id, String(username).trim()]
    )
    const user = rows[0]
    // 아이디/비번은 어느 쪽이 틀렸는지 구분해서 알려주지 않는다.
    if (!user || !(await bcrypt.compare(password, user.password))) {
      audit({ companyId: company.id, username, action: 'login_fail', ip: clientIp(req) })
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' })
    }

    const token = jwt.sign(
      {
        id: user.id,
        companyId: company.id,
        dbName: company.db_name,   // tenant 미들웨어가 이 값으로 회사 DB를 고른다(P2)
        username: user.username,
        name: user.name,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    )
    audit({ companyId: company.id, userId: user.id, username: user.username, action: 'login', ip: clientIp(req) })
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
    await platformPool.execute(
      'INSERT INTO users (id, company_id, username, password, name, email, role) VALUES (?,?,?,?,?,?,?)',
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
