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
  const CONTAINERS = ['acct', 'hr_dom', 'mgmt', 'finance',
    'acct_sales', 'acct_purchase', 'acct_expense', 'acct_docs', 'acct_ledger', 'acct_tax', 'master',
    'hr_labor', 'hr_base', 'mgmt_report', 'mgmt_biz',
    // 재무관리 포털 카테고리 — route를 가진 것도 잎(finance_savings 등)으로 넘기는 묶음일 뿐이다
    'finance_fund', 'finance_ops', 'finance_status',
    // 자금일보 포털 타일(route=cash_report 로 넘긴다). 실제 자원은 cash_report.
    'mgmt_cash']
  for (const d of CONTAINERS) navIds.delete(d)

  // settings_<tab>(회사정보·사용자·결재선·월마감)은 단일 자원 'settings'가 통째로 관장한다
  // (모두 admin 전용 화면). 개별 권한 자원으로 쪼개지 않으므로 카탈로그 대조에서 제외.
  for (const id of [...navIds]) if (id.startsWith('settings_')) navIds.delete(id)

  const catalog = new Set(RESOURCE_IDS)
  const missingInCatalog = [...navIds].filter(id => !catalog.has(id))
  const missingInNav = [...catalog].filter(id => !navIds.has(id) && id !== 'home' && id !== 'settings')

  if (missingInCatalog.length) fail(`nav에 있으나 권한 카탈로그에 없음: ${missingInCatalog.join(', ')}`)
  if (missingInNav.length)     fail(`권한 카탈로그에 있으나 nav에 없음: ${missingInNav.join(', ')}`)
  if (!missingInCatalog.length && !missingInNav.length) ok(`자원 ${catalog.size}개 동기화 확인`)
} catch (e) {
  if (!e.skip) fail(`동기화 검사 실패: ${e.message}`)
}

// ── [6] 장부 불변식: 거래를 만드는 곳이 계좌 가드를 거치는가 ──
//
// 계좌 잔액은 account_id 가 있고 지출이면 status='지급완료' 인 거래만 센다(accounts.js calcBalance).
// 이 조건을 어긴 거래는 **에러 없이** 장부를 틀어지게 한다 — 2026-07-22 검토에서 이 유형의
// P0 결함이 6건 나왔다(결의서·급여·청구서정산·엑셀임포트·청구서연결·과거 F-02).
// 그래서 거래를 INSERT 하는 파일은 lib/ledger.js 의 가드를 거치도록 강제한다.
try {
  console.log('\n[6] 장부 불변식 — 거래 생성 지점의 계좌 가드')
  const routeDir = path.join(__dirname, '..', 'routes')
  // 계좌 없이 생성되는 것이 정상인 경로(미완료 상태로만 만든다)는 면제한다.
  const EXEMPT = {
    'recurring.js': "정기지출은 '지급 대기'로 생성 — 잔액 집계 대상이 아니다",
  }
  const offenders = []
  for (const f of fs.readdirSync(routeDir).filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(routeDir, f), 'utf8')
    if (!/INSERT INTO transactions/.test(src)) continue
    if (EXEMPT[f]) continue
    if (!/require\(['"]\.\.\/lib\/ledger['"]\)/.test(src)) offenders.push(f)
  }
  if (offenders.length) {
    fail(`거래를 만드는데 lib/ledger.js 가드를 안 씁니다: ${offenders.join(', ')}\n` +
         `      → ledgerError({ kind, account_id, status }) 로 검사하고 400을 반환하세요.\n` +
         `      → 계좌 없이 만드는 게 정상인 경로면 check-isolation.js 의 EXEMPT 에 사유와 함께 등록하세요.`)
  } else {
    ok('거래 생성 지점이 모두 계좌 가드를 거칩니다')
  }
} catch (e) {
  fail(`장부 불변식 검사 실패: ${e.message}`)
}

// ── [7] 프런트: ui.jsx 심볼을 import 없이 쓰는 곳 ──
//
// Vite 빌드는 미정의 참조를 잡지 못한다. 그 화면을 실제로 열어야 터지므로,
// 자주 안 쓰는 버튼(엑셀 내보내기 등)에 숨어 있으면 배포 후에야 발견된다.
// 실제로 2026-07-22 에 두 건 있었다(Master.jsx·Ledger.jsx의 localToday).
try {
  console.log('\n[7] 프런트 — 공용 부품 심볼 import 누락')
  const srcRoot = path.join(__dirname, '..', '..', 'src')
  if (!fs.existsSync(srcRoot)) throw { skip: true }
  // 공용 부품 원본: lib/ui.jsx + lib/components/*.jsx (컴포넌트화로 부품이 여러 파일로 흩어진다)
  const libDir = path.join(srcRoot, 'lib')
  const compDir = path.join(libDir, 'components')
  const sourceFiles = [path.join(libDir, 'ui.jsx')]
  if (fs.existsSync(compDir)) {
    for (const f of fs.readdirSync(compDir)) if (/\.jsx?$/.test(f)) sourceFiles.push(path.join(compDir, f))
  }
  const exported = [], selfPaths = new Set()
  for (const f of sourceFiles) {
    selfPaths.add(f.split(path.sep).join('/'))
    const s = fs.readFileSync(f, 'utf8')
    for (const m of s.matchAll(/^export (?:const|function)\s+([A-Za-z_]\w*)/gm)) exported.push(m[1])
  }
  const missing = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.jsx?$/.test(e.name)) continue
      const posix = p.split(path.sep).join('/')
      if (selfPaths.has(posix)) continue
      const src = fs.readFileSync(p, 'utf8')
      // import 경로는 파일 위치마다 다르다('../lib/ui' vs '../ui') — 경로를 따지지 말고
      // 이 파일이 이름을 가져오기는 했는지만 본다. 못 잡는 건 '정의 없는 참조'뿐이라 이걸로 충분하다.
      const imported = new Set()
      for (const m of src.matchAll(/import\s*(?:[\w*]+\s*,\s*)?\{([^}]*)\}\s*from/g)) {
        for (const x of m[1].split(',')) imported.add(x.trim().split(/\s+as\s+/).pop().trim())
      }
      for (const sym of exported) {
        if (imported.has(sym)) continue
        if (new RegExp('(?:const|function|let|var)\\s+' + sym + '\\b').test(src)) continue
        const used = new RegExp('(?<![.\\w])' + sym + '\\s*\\(').test(src) || new RegExp('<' + sym + '[\\s/>]').test(src)
        if (used) missing.push(`${posix.replace(/^.*\/src\//, 'src/')} → ${sym}`)
      }
    }
  }
  walk(srcRoot)
  if (missing.length) fail(`공용 부품 심볼을 import 없이 사용: ${missing.join(', ')}`)
  else ok(`공용 부품 심볼 import 누락 없음 (검사 대상 ${exported.length}개)`)
} catch (e) {
  if (e.skip) console.log('  ⏭ src/ 없음 — 배포 서버에서는 건너뜀')
  else fail(`import 검사 실패: ${e.message}`)
}

// [8] SQL — INSERT 컬럼 수와 값(placeholder) 수 일치
// 컬럼 하나를 빼면서 VALUES의 ?를 안 줄이면 빌드도 린트도 통과하고, 그 코드가 실제로 실행되는
// 순간에만 터진다(2026-07-23 잔재 컬럼 정리 때 9곳에서 났다). 기계적으로 세는 게 확실하다.
try {
  console.log('\n[8] SQL — INSERT 컬럼 수 ↔ 값 개수')
  const roots = [path.join(__dirname, '..', 'routes'), path.join(__dirname, '..')]
  const bad = []
  let checked = 0
  // 괄호 안에 NOW()·UUID() 같은 함수 호출이 있으면 단순 [^)] 매칭이 잘리므로 균형 잡힌 괄호로 읽는다
  const readParen = (s, from) => {
    let depth = 0
    for (let i = from; i < s.length; i++) {
      if (s[i] === '(') depth++
      else if (s[i] === ')') { depth--; if (depth === 0) return { body: s.slice(from + 1, i), end: i } }
    }
    return null
  }
  const splitTop = (s) => {
    const out = []; let depth = 0, cur = ''
    for (const ch of s) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
      cur += ch
    }
    out.push(cur)
    return out.map(x => x.trim()).filter(Boolean)
  }
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) continue
      const s = fs.readFileSync(p, 'utf8')
      const re = /INSERT\s+INTO\s+(\w+)\s*\(/gis
      let m
      while ((m = re.exec(s))) {
        const cols = readParen(s, m.index + m[0].length - 1)
        if (!cols) continue
        const after = s.slice(cols.end + 1)
        const vm = /^\s*VALUES\s*\(/i.exec(after)
        if (!vm) continue
        const vals = readParen(after, vm[0].length - 1)
        if (!vals) continue
        checked++
        const nc = splitTop(cols.body).length, nv = splitTop(vals.body).length
        if (nc !== nv) bad.push(`${f}:${s.slice(0, m.index).split('\n').length} ${m[1]} 컬럼 ${nc} ≠ 값 ${nv}`)
      }
    }
  }
  if (bad.length) fail(`INSERT 컬럼/값 개수 불일치: ${bad.join(' · ')}`)
  else ok(`INSERT 컬럼/값 개수 일치 (검사 ${checked}건)`)
} catch (e) {
  fail(`SQL 검사 실패: ${e.message}`)
}

// [9] SQL — 플레이스홀더(?) 수와 값 배열 길이 일치 (INSERT·UPDATE·SELECT 전부)
// [8]은 INSERT의 '컬럼 수 ↔ ? 수'만 본다. 값 배열이 하나 모자라거나 UPDATE의 SET을
// 고치면서 값을 안 맞추면 [8]을 통과하고 실행 시점에만 터진다 — 그 사각지대를 메운다.
// 스프레드(...pick(body))가 든 배열은 길이를 정적으로 셀 수 없어 건너뛴다.
try {
  console.log('\n[9] SQL — 플레이스홀더 수 ↔ 값 배열 길이')
  const BS = String.fromCharCode(92)
  const splitTop = (s) => {
    let depth = 0, quote = null, cur = '', out = []
    for (let i = 0; i < s.length; i++) {
      const c = s[i], prev = s[i - 1]
      if (quote) { if (c === quote && prev !== BS) quote = null; cur += c; continue }
      if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue }
      // 값 배열 안의 줄 주석은 건너뛴다 — 주석 속 쉼표를 항목으로 세면 개수가 틀린다(오탐).
      if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
      if ('([{'.includes(c)) depth++
      if (')]}'.includes(c)) depth--
      if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue }
      cur += c
    }
    out.push(cur)
    return out.map(x => x.trim()).filter(x => x.length)
  }
  const readBalanced = (s, from) => {
    let depth = 0, quote = null
    for (let i = from; i < s.length; i++) {
      const c = s[i], prev = s[i - 1]
      if (quote) { if (c === quote && prev !== BS) quote = null; continue }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue }
      if (c === '(') depth++
      else if (c === ')') { depth--; if (depth === 0) return i }
    }
    return -1
  }
  const bad = []
  let checked = 0, skipped = 0
  for (const dir of ['routes', '.', 'lib', 'platform']) {
    const d = path.join(__dirname, '..', dir)
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.js')) continue
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) continue
      const s = fs.readFileSync(p, 'utf8')
      const re = /\.(?:execute|query)\s*\(/g
      let m
      while ((m = re.exec(s))) {
        const open = m.index + m[0].length - 1
        const close = readBalanced(s, open)
        if (close < 0) continue
        const args = splitTop(s.slice(open + 1, close))
        if (args.length < 2) continue
        const sql = args[0]
        const rest = args.slice(1).join(',').trim()
        if (!rest.startsWith('[')) continue      // 값을 변수로 넘기면 정적 분석 불가
        if (!/^['"`]/.test(sql)) continue        // SQL이 변수면 ?를 셀 수 없다
        if (sql.includes('${')) continue         // 동적 SQL(? 개수가 런타임 결정)
        const inner = rest.slice(1, rest.lastIndexOf(']'))
        if (inner.includes('...')) { skipped++; continue }   // 스프레드는 길이를 못 센다
        const vals = inner.trim() ? splitTop(inner).length : 0
        const qs = (sql.match(/\?/g) || []).length
        checked++
        if (qs !== vals) {
          bad.push(`${f}:${s.slice(0, m.index).split('\n').length} ?=${qs} 값=${vals}`)
        }
      }
    }
  }
  if (bad.length) fail(`SQL 플레이스홀더/값 개수 불일치: ${bad.join(' · ')}`)
  else ok(`플레이스홀더/값 개수 일치 (검사 ${checked}건, 스프레드 ${skipped}건 제외)`)
} catch (e) {
  fail(`SQL 값 검사 실패: ${e.message}`)
}

// ── [10] 권한 게이트: 마운트된 모든 /api 라우터에 권한 매핑이 있는가 ──
// 매핑이 없으면 게이트는 그 경로를 **통과시킨다**(화면이 죽는 것보다 나으므로).
// 그래서 '빠뜨림'은 런타임에 조용히 무권한 통과가 된다 → 배포 전에 여기서 잡는다.
console.log('\n[10] 권한 게이트 매핑 완전성')
try {
  const { API_RESOURCES, ANY_AUTHENTICATED, TENANT_GATE_EXEMPT, unknownResources } = require('../platform/apiPerms')
  const mounted = []
  const re = /app\.use\(\s*['"](\/api\/[a-z-]+)['"]/g
  let m
  while ((m = re.exec(idxSrc))) mounted.push(m[1])

  /* 게이트 밖 경로는 '깜빡한 것'과 구별되어야 한다. 선언만으로 통과시키면 그 선언이
     곧 우회 수단이 되므로, **실제로 게이트 앞에 있고 LAN 게이트를 쓰는지** 확인한다. */
  const gateAt = idxSrc.indexOf('authMiddleware(req, res,')
  for (const prefix of TENANT_GATE_EXEMPT) {
    const mountRe = new RegExp(`app\\.use\\(\\s*['"]${prefix.replace(/\//g, '\\/')}['"]([^\\n]*)`)
    const hit = mountRe.exec(idxSrc)
    if (!hit) { fail(`게이트 예외로 선언됐지만 마운트가 없음: ${prefix}`); continue }
    if (gateAt > -1 && hit.index > gateAt) {
      fail(`${prefix} 가 인증 게이트 뒤에 마운트됨 — 게이트를 타면 회사 없는 토큰은 401이 된다`)
    }
    if (!/lanOnly/.test(hit[1])) {
      fail(`${prefix} 에 LAN 게이트(lanOnly)가 없음 — 전 테넌트를 보는 문이 인터넷에 열린다`)
    }
  }

  const mapped = new Set([...Object.keys(API_RESOURCES), ...ANY_AUTHENTICATED, ...TENANT_GATE_EXEMPT])
  const unmapped = [...new Set(mounted)].filter(p => !mapped.has(p))
  if (unmapped.length) {
    fail(`권한 매핑 없는 라우터: ${unmapped.join(', ')}\n` +
         '      → platform/apiPerms.js API_RESOURCES 에 자원을 등록하거나,\n' +
         '        화면과 무관한 공용 경로라면 ANY_AUTHENTICATED 에 넣으세요.')
  }
  // 반대 방향: 매핑은 있는데 마운트가 사라진 경로(오타·이름 변경) — 죽은 매핑은 착각을 만든다
  const dead = Object.keys(API_RESOURCES).filter(p => !mounted.includes(p))
  if (dead.length) fail(`마운트되지 않은 경로에 매핑이 있음(오타?): ${dead.join(', ')}`)

  const bad = unknownResources()
  if (bad.length) fail(`매핑이 카탈로그에 없는 자원을 가리킴: ${bad.join(', ')}`)

  // 게이트 자체가 등록돼 있는가 — 파일만 있고 안 걸면 강제가 전혀 안 된다
  if (!/require\(['"]\.\/middleware\/perm['"]\)/.test(idxSrc)) {
    fail('index.js에 권한 게이트(middleware/perm)가 등록되지 않았다 — 권한이 강제되지 않는다')
  }

  if (!unmapped.length && !dead.length && !bad.length) {
    ok(`라우터 ${new Set(mounted).size}개 전부 매핑됨 (자원 검사 통과)`)
  }
} catch (e) {
  fail(`권한 매핑 검사 실패: ${e.message}`)
}

// ── [11] 감사 로그: 장부·돈을 지우는 API가 전부 기록되는가 ──
// 감사는 '빠뜨림'이 곧 공백이고, 그 공백은 사고가 난 뒤에야 드러난다("그거 누가 지웠지?").
// 새 삭제 API를 추가하면서 platform/auditMap.js 등록을 잊는 걸 여기서 막는다.
console.log('\n[11] 감사 로그 — 장부 삭제 API 등록 완전성')
try {
  const { AUDIT_RULES, auditRuleFor } = require('../platform/auditMap')

  // 돈·장부가 걸린 라우터. 기준정보(거래처·비목 등)는 감사 대상이 아니다(잡음이 된다).
  const LEDGER_PREFIXES = new Set([
    '/api/transactions', '/api/invoices', '/api/contracts', '/api/payroll',
    '/api/work-contracts', '/api/resolutions', '/api/settlements',
    '/api/finance', '/api/savings', '/api/closings', '/api/accounts',
  ])

  // index.js 의 마운트에서 (경로 → 라우터 파일) 짝을 읽는다
  const mounts = []
  const mre = /app\.use\(\s*['"](\/api\/[a-z-]+)['"]\s*,\s*require\(['"]\.\/routes\/([a-z-]+)['"]\)/g
  let mm
  while ((mm = mre.exec(idxSrc))) mounts.push({ prefix: mm[1], file: mm[2] + '.js' })

  const missing = []
  for (const { prefix, file } of mounts) {
    if (!LEDGER_PREFIXES.has(prefix)) continue
    const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8')
    const rre = /router\.delete\(\s*['"]([^'"]+)['"]/g
    let rm
    while ((rm = rre.exec(src))) {
      // 첨부 삭제는 장부가 아니다 — 의도적으로 감사 대상에서 뺀다
      if (rm[1].includes('/docs/')) continue
      const full = (prefix + rm[1].replace(/:[A-Za-z0-9_]+/g, 'X')).replace(/\/$/, '')
      if (!auditRuleFor('DELETE', full)) missing.push(`${file} DELETE ${rm[1]}`)
    }
  }
  if (missing.length) {
    fail(`감사 로그에 등록되지 않은 삭제 API:\n      · ${missing.join('\n      · ')}\n` +
         '      → platform/auditMap.js AUDIT_RULES 에 규칙을 추가하세요.')
  }

  // 반대 방향: 마운트가 사라진 경로를 가리키는 죽은 규칙(오타·이름 변경)
  const mounted = new Set(mounts.map(m => m.prefix))
  const deadRules = AUDIT_RULES
    .map(r => (/^\^(\/api\/[a-z-]+)/.exec(r.re.source.replace(/\\\//g, '/')) || [])[1])
    .filter(p => p && !mounted.has(p))
  if (deadRules.length) {
    fail(`마운트되지 않은 경로에 감사 규칙이 있음(오타?): ${[...new Set(deadRules)].join(', ')}`)
  }

  // 미들웨어가 실제로 걸려 있는가 — 규칙만 있고 안 걸면 아무것도 남지 않는다
  if (!/require\(['"]\.\/middleware\/auditTrail['"]\)/.test(idxSrc)) {
    fail('index.js에 감사 미들웨어(middleware/auditTrail)가 등록되지 않았다 — 아무것도 기록되지 않는다')
  }

  if (!missing.length && !deadRules.length) {
    ok(`장부 삭제 API 전부 등록됨 (감사 규칙 ${AUDIT_RULES.length}개)`)
  }
} catch (e) {
  fail(`감사 로그 검사 실패: ${e.message}`)
}

// ── [12] 감사 로그 조회의 회사 격리 ──
//
// audit_logs 는 **공용 관리 DB**에 있다. 테넌트 DB가 아니므로 req.db 가 자동으로
// 회사를 갈라주지 않는다 — 조건을 빠뜨리면 **에러 없이 남의 회사 이력이 그대로 보인다.**
// 이 프로젝트 최우선 규칙(멀티테넌트)이 걸린 자리라 정적으로 못 박는다.
console.log('\n[12] 감사 로그 조회 — 회사 조건 누락 검사')
try {
  /* 운영자 콘솔은 **전 테넌트 횡단이 목적**이라 회사 조건이 없는 게 정상이다.
     대신 그 문은 lanOnly + platformAuth 로 따로 막고, [10] 이 그걸 확인한다.
     여기서 예외로 두는 파일은 이 하나뿐이어야 한다 — 늘어나면 규칙이 무의미해진다. */
  const CROSS_TENANT_BY_DESIGN = new Set(['admin.js'])
  let scanned = 0
  const bad = []
  for (const f of files) {
    if (CROSS_TENANT_BY_DESIGN.has(f)) continue
    const src = fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8')
    if (!src.includes('audit_logs')) continue
    // SQL 문자열(백틱·따옴표) 단위로 본다 — 한 문장 안에 회사 조건이 있어야 한다
    const re = /`([^`]*)`|'([^']*)'|"([^"]*)"/g
    let m
    while ((m = re.exec(src))) {
      const sql = m[1] ?? m[2] ?? m[3] ?? ''
      if (!/audit_logs/.test(sql)) continue
      scanned++
      /* `company_id` 가 어딘가 등장하는 것으로는 부족하다 — JOIN 조건
         (ON c.id = a.company_id)만 있어도 통과해버려, 정작 범위는 안 좁혀진다.
         **회사로 범위를 좁히는 형태**(company_id = ? 또는 INSERT 컬럼)를 요구한다. */
      const scoped = /company_id\s*=\s*\?/.test(sql) || /INSERT\s+INTO\s+audit_logs/i.test(sql)
      if (!scoped) bad.push(`${f}: ${sql.replace(/\s+/g, ' ').trim().slice(0, 70)}…`)
    }
  }
  if (bad.length) {
    fail('audit_logs 를 회사 조건 없이 다루는 SQL:\n      · ' + bad.join('\n      · ') +
         '\n      → company_id = ? 를 반드시 넣으세요(공용 DB라 req.db 가 막아주지 않습니다).')
  } else {
    ok(`감사 로그 SQL ${scanned}건 전부 회사 조건 있음`)
  }
} catch (e) {
  fail(`감사 로그 격리 검사 실패: ${e.message}`)
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
