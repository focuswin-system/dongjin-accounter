/**
 * 정의되지 않은 CSS 변수 사용 검사.
 *
 * `var(--surface-1)` 처럼 index.css 에 없는 이름을 쓰면 **에러 없이 그 속성만 사라진다.**
 * 배경이 투명해지거나 글자색이 기본값으로 나오는데, 화면을 직접 보기 전엔 알 수가 없다.
 * 실제로 새 버전 알림 배너가 배경 없이(--surface-1, 존재하지 않는 이름) 떠 있었고,
 * 자금일보 증감·예적금 이자 색(--pos-ink)도 안 먹고 있었다.
 *
 * fallback 이 있는 것(`var(--x, #fff)`)은 의도된 것으로 보고 넘어간다.
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')

const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8')
const defined = new Set([...css.matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map(m => m[1]))

const bad = new Map()
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { walk(p); continue }
    if (!/\.(jsx?|css)$/.test(e.name)) continue
    const s = fs.readFileSync(p, 'utf8')
    for (const m of s.matchAll(/var\(\s*--([a-zA-Z0-9-]+)\s*(?:,|\))/g)) {
      if (m[0].includes(',')) continue          // fallback 있음 — 의도된 것으로 본다
      if (defined.has(m[1])) continue
      const line = s.slice(0, m.index).split('\n').length
      const key = m[1]
      if (!bad.has(key)) bad.set(key, [])
      bad.get(key).push(`${path.relative(ROOT, p)}:${line}`)
    }
  }
}
walk(SRC)

console.log('━'.repeat(64))
if (!bad.size) {
  console.log(` ✅ CSS 변수 검사 통과 (정의 ${defined.size}개)`)
  console.log('━'.repeat(64))
  process.exit(0)
}
console.log(' ❌ 정의되지 않은 CSS 변수 — 그 속성은 조용히 사라집니다')
console.log('━'.repeat(64))
for (const [name, where] of bad) {
  console.log(`  --${name}`)
  for (const w of where) console.log(`     ${w}`)
}
console.log(`\n  src/index.css 의 :root 에 정의하거나, 이름을 맞추세요.`)
process.exit(1)
