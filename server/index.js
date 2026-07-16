require('dotenv').config()
const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const { initDb } = require('./db')

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:4173'] }))
app.use(express.json())
app.use('/uploads', express.static(require('path').join(__dirname, 'uploads')))

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

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`동진테크 ERP 서버: http://localhost:${PORT}/api`))
  })
  .catch(err => {
    console.error('DB 초기화 실패:', err.message)
    process.exit(1)
  })
