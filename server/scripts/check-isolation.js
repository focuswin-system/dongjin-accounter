#!/usr/bin/env node
/**
 * 테넌트 격리 정적 검사
 *
 *   node scripts/check-isolation.js
 *
 * 멀티테넌트에서 가장 위험한 실수는 '조용한' 실수다 —
 * 라우트가 전역 풀을 쓰면 에러 없이 **남의 회사 데이터**를 읽고 쓴다.
 * 그래서 사람이 리뷰로 잡는 대신 기계가 막는다. 배포 전(deploy.sh)에 실행된다.
 *
 * 검사 항목:
 *   1) routes/ 에서 전역 pool 사용 금지 (req.db 만 허용)
 *   2) DB 질의를 하는 핸들러가 req 인자를 버리지 않았는지 (async (_, res) 패턴)
 *   3) req.db 를 쓰면서 tenant 미들웨어가 안 걸린 라우터가 없는지 (index.js 확인)
 */
const fs = require('fs')
const path = require('path')

const ROUTES_DIR = path.join(__dirname, '..', 'routes')
// 공용 관리 DB만 다루는 라우트 — 테넌트 풀을 쓰지 않는 게 정상이다.
const PLATFORM_ONLY = new Set(['auth.js'])

let failures = 0
const fail = (msg) => { console.log(`  ❌ ${msg}`); failures++ }
const ok   = (msg) => console.log(`  ✅ ${msg}`)

console.log('━'.repeat(64))
console.log(' 테넌트 격리 정적 검사')
console.log('━'.repeat(64))

const files = fs.readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js'))

// ── 1. 전역 pool 사용 금지 ──
console.log('\n[1] routes/ 전역 풀 사용 금지')
let poolHits = 0
for (const f of files) {
  if (PLATFORM_ONLY.has(f)) continue
  const src = fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8')
  src.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
    // req.db / platformPool 은 정상. 그 외 단독 pool 참조를 잡는다.
    const stripped = line.replace(/req\.db/g, '').replace(/platformPool/g, '')
    if (/\bpool\b/.test(stripped)) { fail(`${f}:${i + 1}  전역 pool 참조 — ${line.trim()}`); poolHits++ }
  })
}
if (poolHits === 0) ok('전역 풀 참조 없음')

// ── 2. req 인자를 버린 핸들러가 DB를 쓰는지 ──
console.log('\n[2] req 인자를 버린 핸들러(async (_, res)) 검사')
let underscoreHits = 0
for (const f of files) {
  const src = fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8')
  src.split('\n').forEach((line, i) => {
    if (/async\s*\(\s*_[a-zA-Z]*\s*,\s*res/.test(line)) {
      fail(`${f}:${i + 1}  req를 버린 핸들러 — req.db를 쓸 수 없다: ${line.trim()}`)
      underscoreHits++
    }
  })
}
if (underscoreHits === 0) ok('req 인자를 버린 핸들러 없음')

// ── 3. db.js가 pool을 export 하지 않는지 ──
console.log('\n[3] db.js 전역 풀 export 차단')
const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8')
const exportLine = dbSrc.split('\n').find(l => l.startsWith('module.exports'))
if (exportLine && /\bpool\b/.test(exportLine)) {
  fail(`db.js가 pool을 export 한다 — 라우트가 실수로 가져다 쓸 수 있다: ${exportLine.trim()}`)
} else {
  ok('db.js가 pool을 export 하지 않음')
}

// ── 4. 테넌트 라우터에 tenant 미들웨어가 걸려 있는지 ──
console.log('\n[4] index.js tenant 미들웨어 적용')
const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
if (/require\(['"]\.\/middleware\/tenant['"]\)/.test(idxSrc)) {
  ok('tenant 미들웨어가 등록되어 있음')
} else {
  fail('index.js에 tenant 미들웨어가 없다 — req.db가 주입되지 않는다')
}

// ── 5. 권한 자원 카탈로그 ↔ 프런트 nav 동기화 ──
// 어긋나면 '화면은 있는데 권한을 줄 수 없는' 또는 그 반대 상태가 된다.
console.log('\n[5] 권한 자원 카탈로그 ↔ nav.js 동기화')
try {
  const { RESOURCE_IDS } = require('../platform/permissions')
  const navPath = path.join(__dirname, '..', '..', 'src', 'lib', 'nav.js')
  // 배포 서버에는 프런트 소스가 없다(server/ 와 dist/ 만 전송). 소스가 있는
  // 환경(로컬·CI)에서만 의미 있는 검사이므로, 없으면 실패가 아니라 건너뛴다.
  if (!fs.existsSync(navPath)) {
    console.log('  ⏭  프런트 소스 없음(배포 환경) — 건너뜀')
    throw { skip: true }
  }
  const navSrc = fs.readFileSync(navPath, 'utf8')
  // nav.js의 잎 id 추출 — { id: "xxx", label: ... } 형태만 대상(도메인 노드 제외는 label 유무로 판별 불가하므로 전부 모아 비교)
  const navIds = new Set()
  const re = /\{\s*(?:type:\s*"leaf",\s*)?id:\s*["']([a-zA-Z_][\w]*)["']/g
  let m
  while ((m = re.exec(navSrc))) navIds.add(m[1])
  // 도메인·포털 카테고리 컨테이너 id는 '화면'이 아니라 묶음이라 권한 자원이 아니다.
  // (route를 가진 hr·report·mgmt_dash는 실제 화면이므로 제외하지 않는다)
  const CONTAINERS = ['acct', 'hr_dom', 'mgmt', 'acct_process', 'acct_tax', 'master', 'hr_labor', 'hr_base']
  for (const d of CONTAINERS) navIds.delete(d)

  const catalog = new Set(RESOURCE_IDS)
  const missingInCatalog = [...navIds].filter(id => !catalog.has(id))
  const missingInNav = [...catalog].filter(id => !navIds.has(id) && id !== 'home' && id !== 'settings')

  if (missingInCatalog.length) fail(`nav에 있으나 권한 카탈로그에 없음: ${missingInCatalog.join(', ')}`)
  if (missingInNav.length)     fail(`권한 카탈로그에 있으나 nav에 없음: ${missingInNav.join(', ')}`)
  if (!missingInCatalog.length && !missingInNav.length) ok(`자원 ${catalog.size}개 동기화 확인`)
} catch (e) {
  if (!e.skip) fail(`동기화 검사 실패: ${e.message}`)
}

console.log('\n' + '━'.repeat(64))
if (failures === 0) {
  console.log(' ✅ 격리 검사 통과')
  console.log('━'.repeat(64) + '\n')
  process.exit(0)
}
console.log(` ❌ ${failures}건 위반 — 교차 테넌트 유출 위험이 있습니다`)
console.log('━'.repeat(64) + '\n')
process.exit(1)
