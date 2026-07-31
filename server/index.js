require('dotenv').config()
const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const { assertPlatformReady } = require('./platform/db')

const app = express()
const PORT = process.env.PORT || 3001

// ⚠ Express는 기본적으로 라우트를 대소문자 무시로 매칭한다.
// 그러면 '/API/vendors' 가 '/api/vendors' 라우터에 도달하는데,
// 아래 인증 게이트는 req.path 를 대소문자 구분해 판정하므로 게이트만 건너뛰게 된다
// (실제로 /API/vendors/import/template 이 무인증 200을 반환했다).
// 라우팅을 대소문자 구분으로 바꿔 우회 경로 자체를 없앤다.
app.set('case sensitive routing', true)
app.set('strict routing', false)

// ── 기본 보안 헤더 ──
// nosniff·frameguard·referrer 정책 등 표준 헤더를 한 번에 붙이고 X-Powered-By 를 지운다.
//
// CSP 는 일부러 끈다. 이 SPA 는 인쇄를 iframe.srcdoc + 인라인 style 로 만들고(HR.jsx,
// WorkContract.jsx) Vite 빌드도 인라인을 섞는다. 잘못된 CSP 는 화면을 통째로 깨뜨리는데
// 그게 배포 후에야 드러난다. 켜려면 실제 리소스를 전수 조사한 뒤 별도로 다뤄야 한다.
//
// HSTS 도 끈다. 이 서버는 0.0.0.0:8081 에 바인딩돼 사무실 LAN 에서 http 로 직접 접속한다.
// HSTS 를 내보내면 브라우저가 그 호스트를 https 로 강제해 LAN 접속이 막힌다.
// 외부(donidora.com)의 https 강제는 Cloudflare 쪽에서 하는 것이 맞다.
const helmet = require('helmet')
app.use(helmet({
  contentSecurityPolicy: false,
  strictTransportSecurity: false,
  // 첨부파일·이미지를 개발 환경(5173)에서도 열 수 있어야 한다. 운영은 동일 오리진이다.
  crossOriginResourcePolicy: { policy: 'same-site' },
}))

// exposedHeaders: 슬라이딩 세션이 실어 보내는 갱신 토큰을 브라우저 JS가 읽을 수 있어야 한다.
// (운영은 동일 오리진이라 무관하지만, 개발은 5173→서버로 크로스 오리진이다)
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:4173'],
  exposedHeaders: ['X-Renewed-Token'],
}))
// 본문 크기 상한 — 기본값(100kb)보다 넉넉하되 무제한은 아니다.
// 엑셀 일괄 업로드는 파일을 multer 로 받지만, 매핑 결과를 JSON 으로 되보내는 경로가 있어
// 100kb 는 빠듯할 수 있다. 파일 자체는 multer 의 20MB 제한이 따로 건다.
app.use(express.json({ limit: '1mb' }))

// /api 전역 요청 한도(완만). 로그인은 loginGuard 가 따로, 더 엄격하게 막는다.
app.use('/api', require('./lib/rateLimit').apiRateLimit())
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
const permGate = require('./middleware/perm')
// 로그아웃은 인증을 요구하지 않는다 — 토큰이 이미 만료된 상태에서도 쿠키는 정리되어야 한다.
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/logout', '/api/health'])
app.use((req, res, next) => {
  // 대소문자를 낮춰 판정한다(이중 방어). case sensitive routing 과 함께 두어,
  // 둘 중 하나가 설정 변경으로 풀려도 게이트가 뚫리지 않게 한다.
  const p = req.path.toLowerCase()
  if (!p.startsWith('/api/') || PUBLIC_API.has(p)) return next()
  // 인증 통과 후 곧바로 테넌트를 확정한다 — JWT의 dbName으로 회사 DB 풀을 req.db에 주입.
  // 이 순서가 보장돼야 라우트가 '어느 회사인지 모르는 상태'로 실행되는 일이 없다.
  // 그 다음 권한 게이트 — 자원×행위 판정을 한 곳에서 한다(platform/apiPerms.js).
  return authMiddleware(req, res, (err) => (err ? next(err)
    : tenantMiddleware(req, res, (err2) => (err2 ? next(err2) : permGate(req, res, next)))))
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
app.use('/api/closings',           require('./routes/closings'))
app.use('/api/payroll',            require('./routes/payroll'))
app.use('/api/payroll-items',      require('./routes/payroll-items'))
app.use('/api/work-contracts',     require('./routes/work-contracts'))
app.use('/api/employ-types',       require('./routes/employ-types'))
app.use('/api/dashboard',          require('./routes/dashboard'))
app.use('/api/analytics',          require('./routes/analytics'))
app.use('/api/company',            require('./routes/company'))
app.use('/api/resolutions',        require('./routes/resolutions'))
app.use('/api/settlements',        require('./routes/settlements'))
app.use('/api/purchase-reqs',      require('./routes/purchase-reqs'))
app.use('/api/quote-reqs',         require('./routes/quote-reqs'))
app.use('/api/approval-presets',   require('./routes/approval-presets'))
app.use('/api/finance',            require('./routes/finance'))

// ── 헬스체크 ──
// deploy.sh 가 배포 시점에 기록한 provenance 를 함께 돌려준다.
// 이 스크립트는 git 이 아니라 작업 트리를 전송하므로, 이게 없으면 "지금 운영에 뭐가
// 도는지"를 커밋으로 답할 수 없다. 장애 때 무엇으로 되돌려야 하는지가 여기서 나온다.
// 파일이 없으면(로컬 개발) null — 기동 시 한 번만 읽는다.
let DEPLOY_INFO = null
try {
  DEPLOY_INFO = JSON.parse(fs.readFileSync(path.join(__dirname, 'deploy-info.json'), 'utf8'))
} catch { /* 로컬 개발이거나 provenance 이전에 배포된 서버 */ }

app.get('/api/health', (_, res) => res.json({
  ok: true, time: new Date().toISOString(), deploy: DEPLOY_INFO,
}))

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

// 예기치 못한 오류 처리.
// 사용자에게 보여줄 메시지는 각 라우트가 4xx로 직접 반환한다(next(new Error(...)) 사용처 없음).
// 여기까지 온 것은 SQL 오류·TypeError 같은 내부 오류이므로, 원문을 그대로 내보내면
// 테이블·컬럼명 등 내부 구조가 노출된다. 상세는 서버 로그로만 남긴다.
app.use((err, req, res, _next) => {
  // 미들웨어가 붙인 상태코드(예: multer 파일 크기 초과 413)는 존중한다.
  // 전부 500으로 뭉개면 사용자는 자기 입력 문제인지 서버 장애인지 알 수 없다.
  const status = Number(err.status || err.statusCode) || 0
  if (status >= 400 && status < 500) {
    console.warn(`[${status}] ${req.method} ${req.originalUrl}`, err.message)
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? '파일이 너무 커요 (최대 20MB)'
      : (err.expose && err.message) || '요청을 처리할 수 없어요. 입력값을 확인해 주세요.'
    return res.status(status).json({ error: msg })
  }
  // 문서번호 충돌 — 두 사람이 동시에 발행하면 같은 MAX+1 을 뽑는다.
  // 유니크 인덱스가 중복 저장은 막아주지만, 그대로 두면 사용자는 원인 모를 500 을 본다.
  // (결의서는 lib/docno.js 로 자동 재시도한다. 나머지 채번은 번호가 후속 문장으로
  //  흘러가 재시도 구조를 넣기 어려워, 여기서 '다시 시도' 안내로 바꾼다)
  if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
    const msg = /invoice_no/.test(err.sqlMessage || '') ? '청구번호'
              : /doc_no/.test(err.sqlMessage || '')     ? '문서번호'
              : null
    console.warn(`[409] ${req.method} ${req.originalUrl}`, err.sqlMessage || err.message)
    return res.status(409).json({
      error: msg
        ? `${msg}가 다른 작업과 겹쳤어요. 잠시 후 다시 시도해주세요.`
        : '이미 등록된 값이에요. 중복되지 않는 값으로 입력해주세요.',
    })
  }
  // 잠금 경합 — 여러 사람이 같은 순간에 같은 자원을 건드렸다.
  //   1213 교착: InnoDB가 트랜잭션 전체를 롤백한다(= 아무것도 저장되지 않음)
  //   1205 잠금 대기 초과
  // 데이터는 안전하지만 그대로 500 을 주면 사용자는 무엇이 잘못됐는지 알 수 없다.
  // 완전한 해법은 트랜잭션 전체를 재시도하는 것이고, 그건 라우트 구조를 바꿔야 한다.
  if (err && (err.errno === 1213 || err.errno === 1205)) {
    console.warn(`[409] ${req.method} ${req.originalUrl}  잠금 경합(${err.errno})`)
    return res.status(409).json({
      error: '다른 작업과 겹쳐 처리하지 못했어요. 저장된 건 없으니 다시 시도해주세요.',
    })
  }
  console.error(`[500] ${req.method} ${req.originalUrl}`, err)
  res.status(500).json({ error: '처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' })
})

// ── 마지막 안전망 ──
// Express 4는 async 핸들러의 rejection을 잡지 못한다. 그래서 catch 안에서
// `await conn.rollback()` 이 다시 던지거나, try 밖의 `getConnection()` 이 실패하면
// 그 거부가 라우트를 빠져나가 처리되지 않은 Promise 거부가 된다.
// Node 20 기본값(--unhandled-rejections=throw)에서는 그 순간 **프로세스가 죽는다**
// — 즉 한 요청의 DB 연결 문제가 전 회사의 서비스를 내린다.
// 여기서 붙잡아, 최악의 결과를 '서버 다운'에서 '그 요청 하나 실패'로 낮춘다.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] 요청 처리 중 붙잡히지 않은 거부:', reason)
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
