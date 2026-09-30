/**
 * 인라인 style 에서 **줄임 속성과 개별 속성을 섞은 곳**을 찾는다.
 *
 * 예: style={{ border: 0, borderTop: '1px solid var(--line)' }}
 *   React 는 이런 객체를 다시 그릴 때 한쪽을 빠뜨린다(콘솔 경고: "don't mix shorthand and non-shorthand").
 *   2026-09-29 알림 목록 구분선이 이것 때문에 **브라우저 기본 버튼 테두리(2px 검은 입체선)**로 보였다.
 *   순서가 거꾸로면(borderTop 다음 border:0) 의도한 선이 **아예 안 보인다** — 두 곳이 그랬다.
 *
 * 고치는 법: 줄임을 개별로 풀어 쓴다(border:0 → borderLeft:0, borderRight:0, borderBottom:0),
 *            또는 선을 boxShadow(inset)로 긋는다.
 * 실행: npm run check:css
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const PAIRS = {
  border: ['borderTop', 'borderBottom', 'borderLeft', 'borderRight', 'borderColor', 'borderWidth', 'borderStyle'],
  padding: ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'],
  margin: ['marginTop', 'marginBottom', 'marginLeft', 'marginRight'],
  background: ['backgroundColor', 'backgroundImage'],
  borderRadius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'],
  flex: ['flexGrow', 'flexShrink', 'flexBasis'],
  font: ['fontSize', 'fontWeight', 'fontFamily'],
  overflow: ['overflowX', 'overflowY'],
}

/** style={{ … }} 본문마다 섞인 짝을 돌려준다 — 검사 자체의 거부 사례 시험에도 쓴다 */
export function findMixes(src) {
  const out = []
  const open = /style=\{\{/g
  let m
  while ((m = open.exec(src))) {
    let i = m.index + m[0].length, depth = 2
    const start = i
    while (i < src.length && depth) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      i++
    }
    const body = src.slice(start, i)
    const keys = new Set([...body.matchAll(/(?:^|[,{\s])([a-zA-Z]+)\s*:/g)].map(x => x[1]))
    for (const [short, longs] of Object.entries(PAIRS)) {
      if (!keys.has(short)) continue
      const mixed = longs.filter(l => keys.has(l))
      if (mixed.length) out.push({ line: src.slice(0, m.index).split('\n').length, short, mixed })
    }
  }
  return out
}

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : /\.(jsx?|tsx?)$/.test(e.name) ? [path.join(d, e.name)] : [])

// 검사가 정말 잡는지 — 거부 사례 둘, 통과 사례 하나
const selfTest = [
  [`<a style={{ border: 0, borderTop: '1px solid red' }}/>`, 1],
  [`<a style={{ margin: 0, marginLeft: 'auto' }}/>`, 1],
  [`<a style={{ borderTop: 0, borderBottom: '1px solid red', padding: 4 }}/>`, 0],
]
for (const [code, want] of selfTest) {
  if (findMixes(code).length !== want) { console.error('check-style-mix 자체 시험 실패:', code); process.exit(2) }
}

const bad = []
for (const f of walk(ROOT)) {
  for (const h of findMixes(fs.readFileSync(f, 'utf8'))) {
    bad.push(`${path.relative(path.join(ROOT, '..'), f).replace(/\\/g, '/')}:${h.line}  ${h.short} + ${h.mixed.join(',')}`)
  }
}
console.log('━'.repeat(64))
if (bad.length) {
  console.log(` ❌ 인라인 style 에 줄임·개별 속성이 섞였어요 (${bad.length}곳) — 다시 그릴 때 한쪽이 빠진다`)
  for (const b of bad) console.log('   · ' + b)
  console.log('━'.repeat(64))
  process.exit(1)
}
console.log(' ✅ 인라인 style 줄임·개별 섞임 없음')
console.log('━'.repeat(64))
