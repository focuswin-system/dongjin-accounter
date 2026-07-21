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

console.log('\n' + '━'.repeat(64))
if (failures === 0) {
  console.log(' ✅ 격리 검사 통과')
  console.log('━'.repeat(64) + '\n')
  process.exit(0)
}
console.log(` ❌ ${failures}건 위반 — 교차 테넌트 유출 위험이 있습니다`)
console.log('━'.repeat(64) + '\n')
process.exit(1)
