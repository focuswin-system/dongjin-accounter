const { Router } = require('express')
const { randomUUID } = require('crypto')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { pool } = require('../db')
const authMiddleware = require('../middleware/auth')

const router = Router()

// 로그인
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body
    if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' })

    const [rows] = await pool.execute('SELECT * FROM users WHERE username = ? AND active = 1', [username])
    const user = rows[0]
    if (!user) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' })

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' })

    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    )
    res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } })
  } catch (e) { next(e) }
})

// 내 정보 확인
router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT id, username, name, role, created_at FROM users WHERE id = ?', [req.user.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

// 사용자 목록 (admin만)
router.get('/users', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다' })
    const [rows] = await pool.execute('SELECT id, username, name, role, active, created_at FROM users ORDER BY created_at')
    res.json(rows)
  } catch (e) { next(e) }
})

// 사용자 추가 (admin만)
router.post('/users', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다' })
    const { username, password, name, role } = req.body
    if (!username || !password) return res.status(400).json({ error: 'username, password 필수' })
    const hashed = await bcrypt.hash(password, 10)
    const id = randomUUID()
    await pool.execute(
      'INSERT INTO users (id, username, password, name, role) VALUES (?,?,?,?,?)',
      [id, username, hashed, name || '', role || 'user']
    )
    res.json({ id })
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '이미 존재하는 아이디입니다' })
    next(e)
  }
})

// 비밀번호 변경
router.put('/users/:id/password', authMiddleware, async (req, res, next) => {
  try {
    const isSelf = req.user.id === req.params.id
    const isAdmin = req.user.role === 'admin'
    if (!isSelf && !isAdmin) return res.status(403).json({ error: '권한이 없습니다' })
    const { password } = req.body
    if (!password) return res.status(400).json({ error: 'password 필수' })
    const hashed = await bcrypt.hash(password, 10)
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 계정 활성/비활성 (admin만)
router.patch('/users/:id/active', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다' })
    const { active } = req.body
    await pool.execute('UPDATE users SET active = ? WHERE id = ?', [active ? 1 : 0, req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 권한 변경 (admin만) — 본인 권한은 변경 불가(마지막 관리자 잠금 방지)
router.patch('/users/:id/role', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다' })
    if (req.user.id === req.params.id) return res.status(400).json({ error: '본인 권한은 변경할 수 없습니다' })
    const { role } = req.body
    if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'role은 admin 또는 user여야 합니다' })
    await pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
