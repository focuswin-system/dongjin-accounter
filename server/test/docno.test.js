/**
 * 문서번호 채번 재시도
 *
 * 채번이 SELECT MAX+1 이라 동시 발행이 부딪힌다(2026-07-22: 결의서 5건 동시 생성 시 3건 500).
 * 여기서 중요한 건 '재시도한다'보다 **무엇을 재시도하지 않는가**다.
 * 교착(1213)을 재시도하면 InnoDB가 트랜잭션을 이미 롤백했으므로
 * 트랜잭션 없이 쓰는 꼴이 된다 — 그 경계를 못 지키면 장부가 조용히 깨진다.
 *
 * 콜백 기반이라 DB 없이 전부 검증된다.
 */
const { test } = require('node:test')
const assert = require('node:assert')

const { insertWithDocNo } = require('../lib/docno')

/** errno 를 가진 가짜 MySQL 오류 */
const dbErr = (errno) => Object.assign(new Error(`fake errno ${errno}`), { errno })

test('첫 시도에 성공하면 그 번호를 돌려준다', async () => {
  let computed = 0, inserted = null
  const no = await insertWithDocNo(
    async () => { computed++; return 'DJ-2026-0001' },
    async (n) => { inserted = n }
  )
  assert.strictEqual(no, 'DJ-2026-0001')
  assert.strictEqual(inserted, 'DJ-2026-0001')
  assert.strictEqual(computed, 1, '충돌이 없으면 한 번만 뽑는다')
})

test('중복키(1062)면 번호를 다시 뽑아 재시도한다', async () => {
  // 재시도할 때 예전 번호를 그대로 쓰면 영원히 같은 곳에 부딪힌다.
  const numbers = ['DJ-2026-0001', 'DJ-2026-0002', 'DJ-2026-0003']
  let i = 0, attempts = 0
  const no = await insertWithDocNo(
    async () => numbers[i++],
    async (n) => {
      attempts++
      if (n !== 'DJ-2026-0003') throw dbErr(1062)
    }
  )
  assert.strictEqual(no, 'DJ-2026-0003')
  assert.strictEqual(attempts, 3)
  assert.strictEqual(i, 3, '매 시도마다 번호를 새로 뽑아야 한다')
})

test('잠금 읽기 경합(1020)도 재시도한다', async () => {
  let tries = 0
  const no = await insertWithDocNo(
    async () => {
      // 채번(FOR UPDATE) 자체가 던지는 경우 — 이것도 재시도 대상이어야 한다.
      tries++
      if (tries === 1) throw dbErr(1020)
      return 'DJ-2026-0009'
    },
    async () => {}
  )
  assert.strictEqual(no, 'DJ-2026-0009')
  assert.strictEqual(tries, 2)
})

test('교착(1213)은 재시도하지 않고 그대로 던진다', async () => {
  // InnoDB가 트랜잭션 전체를 롤백했으므로 같은 트랜잭션에서 재시도하면 안 된다.
  let attempts = 0
  await assert.rejects(
    () => insertWithDocNo(
      async () => 'DJ-2026-0001',
      async () => { attempts++; throw dbErr(1213) }
    ),
    (e) => e.errno === 1213
  )
  assert.strictEqual(attempts, 1, '교착은 단 한 번만 시도해야 한다')
})

test('경합과 무관한 오류는 그대로 던진다', async () => {
  let attempts = 0
  await assert.rejects(
    () => insertWithDocNo(
      async () => 'DJ-2026-0001',
      async () => { attempts++; throw dbErr(1054) }   // Unknown column
    ),
    (e) => e.errno === 1054
  )
  assert.strictEqual(attempts, 1)
})

test('계속 부딪히면 사용자에게 보여줄 409로 바꿔 던진다', async () => {
  let attempts = 0
  await assert.rejects(
    () => insertWithDocNo(
      async () => 'DJ-2026-0001',
      async () => { attempts++; throw dbErr(1062) }
    ),
    (e) => {
      assert.strictEqual(e.status, 409)
      assert.strictEqual(e.expose, true, '이 문구는 사용자에게 그대로 보여준다')
      assert.ok(/다시 시도/.test(e.message))
      assert.strictEqual(e.cause?.errno, 1062, '원인 오류를 보존해야 진단이 된다')
      return true
    }
  )
  assert.ok(attempts > 1, '포기하기 전에 여러 번 시도해야 한다')
})
