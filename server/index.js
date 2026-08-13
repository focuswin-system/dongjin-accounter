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

/* ── 운영자 콘솔 ──
 *
 * ⚠ 아래 테넌트 인증 게이트보다 **먼저** 마운트한다. 그 게이트는 회사(JWT의 companyId)를
 * 요구하는데, 운영자 토큰에는 회사가 없다 — 게이트를 타면 401로 죽는다.
 * 대신 자물쇠 두 개를 직접 건다:
 *   1) lanOnly       사무실 LAN 밖에서는 404. 문 자체가 안 보인다.
 *   2) platformAuth  platform_admins 토큰만(라우터 안에서. 로그인 경로는 열려 있어야 하므로).
 *
 * 콘솔 화면(/admin)도 같은 LAN 게이트를 통과해야 한다. 화면만 열려 있어도
 * "여기 관리자 콘솔이 있다"를 밖에 알려주는 셈이다.
 */
const lanOnly = require('./middleware/lanOnly')
app.use('/api/admin', lanOnly, require('./routes/admin'))
/* 콘솔은 단일 HTML 이라 해시 붙은 번들이 없다 → 캐시되면 고쳐도 옛 화면이 계속 뜬다.
   SPA 의 index.html 을 no-store 로 두는 것과 같은 이유다(아래 noStore 참고). */
app.use('/admin', lanOnly, express.static(path.join(__dirname, 'admin'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'),
}))

// ── 인증 게이트 ──
// 로그인·헬스체크만 공개(로그인 자체 + deploy.sh 무토큰 헬스체크), 나머지 모든 /api 요청은 JWT 필요.
// 프론트 api.js의 req()·업로드·엑셀·내보내기·템플릿 다운로드 전부 Authorization 헤더를 실어 보낸다.
// (정적 SPA·/uploads 파일은 /api 경로가 아니라 통과.)
const authMiddleware = require('./middleware/auth')
const tenantMiddleware = require('./middleware/tenant')
const permGate = require('./middleware/perm')
const auditTrail = require('./middleware/auditTrail')
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
  // 마지막으로 감사 로그 — 통과한 요청 중 '남겨야 할 행위'만 기록한다(platform/auditMap.js).
  // 권한 게이트 뒤에 두는 이유: 거부된 요청은 아무것도 바꾸지 않았으므로 감사 대상이 아니다.
  return authMiddleware(req, res, (err) => (err ? next(err)
    : tenantMiddleware(req, res, (err2) => (err2 ? next(err2)
      : permGate(req, res, (err3) => (err3 ? next(err3) : auditTrail(req, res, next)))))))
})

app.use('/api/auth',               require('./routes/auth'))
app.use('/api/uploads',            require('./routes/uploads'))
// 화면 사용 집계 — 어느 화면을 쓰고 어디서 멈추는지. 화면 이름만 남긴다.
app.use('/api/usage',              require('./routes/usage'))
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
// 첫 세팅 진행 상황 — 무엇을 채워야 자동채움이 켜지는지 알려준다(숫자만 센다)
app.use('/api/setup',              require('./routes/setup'))
app.use('/api/resolutions',        require('./routes/resolutions'))
app.use('/api/settlements',        require('./routes/settlements'))
app.use('/api/purchase-reqs',      require('./routes/purchase-reqs'))
// 매입처 결제 내역 — 월별 일괄이체 명단(조회 전용)
app.use('/api/payment-runs',       require('./routes/payment-runs'))
// 주별 총 매입/매출 현황 — 품목 단위 기간 집계(조회 전용)
app.use('/api/purchase-status',    require('./routes/purchase-status'))
app.use('/api/fund-status', require('./routes/fund-status'))
app.use('/api/unpaid-labor', require('./routes/unpaid-labor'))
app.use('/api/quote-reqs',         require('./routes/quote-reqs'))
app.use('/api/approval-presets',   require('./routes/approval-presets'))
app.use('/api/finance',            require('./routes/finance'))
app.use('/api/savings',            require('./routes/savings'))
app.use('/api/audit',              require('./routes/audit'))
// 보고서 카탈로그 — 회사가 볼 수 있는 양식 목록(숫자는 없다). 회사 구분은 토큰으로만 한다
app.use('/api/reports',            require('./routes/reports'))

// ── 헬스체크 ──
// deploy.sh 가 배포 시점에 기록한 provenance 를 함께 돌려준다.
// 이 스크립트는 git 이 아니라 작업 트리를 전송하므로, 이게 없으면 "지금 운영에 뭐가
// 도는지"를 커밋으로 답할 수 없다. 장애 때 무엇으로 되돌려야 하는지가 여기서 나온다.
// 파일이 없으면(로컬 개발) null — 기동 시 한 번만 읽는다.
let DEPLOY_INFO = null
try {
  DEPLOY_INFO = JSON.parse(fs.readFileSync(path.join(__dirname, 'deploy-info.json'), 'utf8'))
} catch { /* 로컬 개발이거나 provenance 이전에 배포된 서버 */ }
// 운영자 콘솔이 '지금 무엇이 돌고 있나'를 보여줄 수 있게 앱에 실어둔다(routes/admin.js overview)
app.set('deployInfo', DEPLOY_INFO)

app.get('/api/health', (_, res) => res.json({
  ok: true, time: new Date().toISOString(), deploy: DEPLOY_INFO,
}))

// ── 정적 SPA 서빙 (배포 환경) ──
// 빌드된 dist/가 있으면 프론트도 이 서버가 직접 서빙한다. dist가 없으면
// (로컬 개발: Vite가 별도 서빙) 이 블록은 건너뛴다.
const DIST = path.join(__dirname, '..', 'dist')
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  /* index.html·sw.js 는 절대 캐시하지 않는다.
   *
   * 번들 파일명에는 해시가 붙어 있어 캐시해도 안전하지만, **그 파일명을 가리키는
   * index.html 이 캐시되면 배포해도 사용자는 옛 화면을 계속 본다.** 서비스워커(sw.js)도
   * 마찬가지다 — 옛 워커가 캐시된 채로 남으면 스스로 갱신할 기회조차 없다.
   * 실제로 이것 때문에 고친 코드가 반영되지 않아 같은 증상을 며칠 더 보게 됐다. */
  const noStore = (res, filePath) => {
    if (/(index\.html|sw\.js|workbox-[^/\\]*\.js)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    }
  }
  app.use(express.static(DIST, { setHeaders: noStore }))
  // SPA 폴백: /api·/uploads 외의 모든 경로는 index.html로
  app.get('*', (req, res, next) => {
    // /admin 은 운영자 콘솔(server/admin/)이다. 여기로 흘리면 고객용 SPA가 대신 뜬다.
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.startsWith('/admin')) return next()
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.sendFile(path.join(DIST, 'index.html'))
  })
}

// 예기치 못한 오류 처리.
// 사용자에게 보여줄 메시지는 각 라우트가 4xx로 직접 반환한다(next(new Error(...)) 사용처 없음).
// 여기까지 온 것은 SQL 오류·TypeError 같은 내부 오류이므로, 원문을 그대로 내보내면
// 테이블·컬럼명 등 내부 구조가 노출된다. 상세는 서버 로그로만 남긴다.
//
// 그 '서버 로그'도 그냥 찍으면 안 된다. MariaDB 오류 메시지에는 실제 값이 박혀 오고
// (Duplicate entry 'INV-2026-0001' …) mysql2 오류 객체에는 실행한 SQL이 붙는다.
// 여러 회사의 회계 데이터를 한 서버에서 다루므로 오류는 safeErr()로 값을 걷어내고,
// 대신 reqTag()로 '어느 회사의 누가' 를 반드시 남긴다 — 그게 없으면 장애가 나도
// 어느 테넌트 문제인지 알 수 없다. 자세한 원칙은 lib/logSafe.js.
const { safeErr, reqTag } = require('./lib/logSafe')

// 500은 stdout 에만 두지 않고 공용 관리 DB에도 남긴다 — 그래야 "언제부터 몇 번 났는지"를
// 답할 수 있다(지금까지는 장애를 고객 전화로 알았다). 기록은 요청을 막지 않는다: await 하지
// 않고, 실패해도 삼킨다. 자세한 설계는 lib/errorLog.js.
const { platformPool } = require('./platform/db')
const errorRecorder = require('./lib/errorLog').createErrorRecorder({
  exec: (sql, params) => platformPool.execute(sql, params),
  release: (DEPLOY_INFO && (DEPLOY_INFO.commit || DEPLOY_INFO.deployedAt)) || null,
})

app.use((err, req, res, _next) => {
  // 미들웨어가 붙인 상태코드(예: multer 파일 크기 초과 413)는 존중한다.
  // 전부 500으로 뭉개면 사용자는 자기 입력 문제인지 서버 장애인지 알 수 없다.
  const status = Number(err.status || err.statusCode) || 0
  if (status >= 400 && status < 500) {
    console.warn(`[${status}] ${reqTag(req)}`, safeErr(err).message)
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
    // 중복 값 자체(청구번호·사업자번호 등)는 남기지 않는다 — 어느 제약이 걸렸는지만 남는다.
    console.warn(`[409] ${reqTag(req)}`, safeErr(err).message)
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
    console.warn(`[409] ${reqTag(req)}  잠금 경합(${err.errno})`)
    return res.status(409).json({
      error: '다른 작업과 겹쳐 처리하지 못했어요. 저장된 건 없으니 다시 시도해주세요.',
    })
  }
  console.error(`[500] ${reqTag(req)}`, safeErr(err))
  errorRecorder.record({ err, req, status: 500 })   // 의도적으로 await 하지 않는다
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
  console.error('[unhandledRejection] 요청 처리 중 붙잡히지 않은 거부:', safeErr(reason))
  // 어느 요청이었는지는 알 수 없다(이 시점엔 req 가 없다). 그래도 남긴다 —
  // 이건 프로세스를 죽일 뻔한 부류라 놓치면 안 된다.
  errorRecorder.record({ err: reason, req: null, status: 0 })
})

// ── 기동 ──
// 런타임은 DDL을 하지 않는다. 스키마 준비는 배포 시점(npm run setup:db)의 책임이고,
// 여기서는 '준비됐는지'만 확인해 문제를 조용한 런타임 오류가 아니라 명확한 기동 실패로 만든다.
assertPlatformReady()
  .then(() => {
    // 보관 기간이 지난 오류 기록 정리. 실패해도 기동을 막지 않는다(수집은 부가 기능이다).
    errorRecorder.prune()
    app.listen(PORT, () => console.log(`focus-accounter 서버: http://localhost:${PORT}/api`))
  })
  .catch(err => {
    console.error('\n❌ 기동 실패\n')
    console.error(err.message)
    console.error('')
    process.exit(1)
  })
