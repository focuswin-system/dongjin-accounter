/**
 * 저장 버튼 재진입 차단 테스트.
 *
 * 여기서 틀리면 **문서가 두 장 생긴다.** 구매품의서·견적요청서·정산내역서는 번호를 따고,
 * 근로계약·용역계약은 직원(인력)까지 만든다. 느린 순간에 두 번 눌리면 그대로 두 벌이다.
 * 화면에서 재현하려면 느린 저장을 인위로 만들어야 해서, 규칙만 떼어 여기서 못박는다.
 */
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const loading = import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', 'busyRun.js')).href)

const slow = (ms, onCall) => () => new Promise(r => { onCall(); setTimeout(() => r('ok'), ms) })

test('연달아 세 번 눌러도 한 번만 실행된다', async () => {
  const { createBusyRun } = await loading
  let calls = 0
  const run = createBusyRun(() => {})
  const fn = slow(30, () => calls++)
  await Promise.all([run(fn), run(fn), run(fn)])
  assert.equal(calls, 1, '두 번째·세 번째 클릭은 버려져야 한다')
})

test('끝나면 다시 누를 수 있다 — 영영 잠기면 안 된다', async () => {
  const { createBusyRun } = await loading
  let calls = 0
  const run = createBusyRun(() => {})
  const fn = slow(5, () => calls++)
  await run(fn)
  await run(fn)
  assert.equal(calls, 2)
})

test('저장이 실패해도 잠금이 풀린다', async () => {
  const { createBusyRun } = await loading
  const run = createBusyRun(() => {})
  let calls = 0
  await assert.rejects(() => run(async () => { calls++; throw new Error('저장 실패') }))
  // 실패 뒤에도 다시 눌러야 한다 — 안 풀리면 사용자가 화면을 새로고침해야 한다
  await run(async () => { calls++ })
  assert.equal(calls, 2)
})

test('busy 표시가 켜졌다 꺼진다 — 버튼 비활성의 근거', async () => {
  const { createBusyRun } = await loading
  const seen = []
  const run = createBusyRun(v => seen.push(v))
  await run(async () => { assert.deepEqual(seen, [true], '실행 중에는 켜져 있어야 한다') })
  assert.deepEqual(seen, [true, false])
})

test('실행 중 두 번째 호출은 undefined 를 돌려준다(결과를 섞지 않는다)', async () => {
  const { createBusyRun } = await loading
  const run = createBusyRun(() => {})
  const first = run(slow(20, () => {}))
  const second = await run(async () => 'second')
  assert.equal(second, undefined)
  assert.equal(await first, 'ok')
})
