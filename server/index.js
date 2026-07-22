require('dotenv').config()
const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const { assertPlatformReady } = require('./platform/db')

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:4173'] }))
app.use(express.json())
// ⚠ /uploads 는 절대 정적 서빙하지 않는다.
// 예전에는 express.static으로 통째로 열려 있어, 경로만 알면 인증 없이 남의 회사
// 증빙·계약서를 받아갈 수 있었다. 이제 인증 + 소유 회사 확인을 거쳐야 한다.
app.use('/uploads', require('./routes/files'))

// ── 인증 게이트 ──
// 로그인·헬스체크만 공개(로그인 자체 + deploy.sh 무토큰 헬스체크), 나머지 모든 /api 요청은 JWT 필요.
// 프론트 api.js의 req()·업로드·엑셀·내보내기·템플릿 다운로드 전부 Authorization 헤더를 실어 보낸다.
// (정적 SPA·/uploads 파일은 /api 경로가 아니라 통과.)
const authMiddleware = require('./middleware/auth')
const tenantMiddleware = require('./middleware/tenant')
const PUBLIC_API = new Set(['/api/auth/login', '/api/health'])
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || PUBLIC_API.has(req.path)) return next()
  // 인증 통과 후 곧바로 테넌트를 확정한다 — JWT의 dbName으로 회사 DB 풀을 req.db에 주입.
  // 이 순서가 보장돼야 라우트가 '어느 회사인지 모르는 상태'로 실행되는 일이 없다.
  return authMiddleware(req, res, (err) => (err ? next(err) : tenantMiddleware(req, res, next)))
})

app.use('/api/auth',               require('./routes/auth'))
app.use('/api/uploads',            require('./routes/uploads'))
app.use('/api/categories',         require('./routes/categories'))
app.use('/api/account-subjects',   require('./routes/account-subjects'))
app.use('/api/accounts',           require('./routes/accounts'))
app.use('/api/vendors',            require('./routes/vendors'))
app.use('/api/contracts',          require('./routes/contracts'))
app.use('/api/invoices',           require('./routes/invoices'))
app.use('/api/transactions',       require('./routes/transactions'))
app.use('/api/recurring-expenses', require('./routes/recurring'))
app.use('/api/recurring-invoices', require('./routes/recurring-invoices'))
app.use('/api/employees',          require('./routes/employees'))
app.use('/api/hr-codes',           require('./routes/hr-codes'))
app.use('/api/ref-items',          require('./routes/ref-items'))
app.use('/api/tax',                require('./routes/tax'))
app.use('/api/payroll',            require('./routes/payroll'))
app.use('/api/payroll-items',      require('./routes/payroll-items'))
app.use('/api/work-contracts',     require('./routes/work-contracts'))
app.use('/api/employ-types',       require('./routes/employ-types'))
app.use('/api/dashboard',          require('./routes/dashboard'))
app.use('/api/company',            require('./routes/company'))
app.use('/api/resolutions',        require('./routes/resolutions'))
app.use('/api/approval-presets',   require('./routes/approval-presets'))

app.get('/api/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }))

// ── 정적 SPA 서빙 (배포 환경) ──
// 빌드된 dist/가 있으면 프론트도 이 서버가 직접 서빙한다. dist가 없으면
// (로컬 개발: Vite가 별도 서빙) 이 블록은 건너뛴다.
const DIST = path.join(__dirname, '..', 'dist')
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST))
  // SPA 폴백: /api·/uploads 외의 모든 경로는 index.html로
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next()
    res.sendFile(path.join(DIST, 'index.html'))
  })
}

app.use((err, req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: err.message })
})

// ── 기동 ──
// 런타임은 DDL을 하지 않는다. 스키마 준비는 배포 시점(npm run setup:db)의 책임이고,
// 여기서는 '준비됐는지'만 확인해 문제를 조용한 런타임 오류가 아니라 명확한 기동 실패로 만든다.
assertPlatformReady()
  .then(() => {
    app.listen(PORT, () => console.log(`focus-accounter 서버: http://localhost:${PORT}/api`))
  })
  .catch(err => {
    console.error('\n❌ 기동 실패\n')
    console.error(err.message)
    console.error('')
    process.exit(1)
  })
