/**
 * 테넌트 커넥션 풀 매니저 (LRU)
 *
 * 회사마다 별도 DB를 쓰므로 회사 수만큼 풀이 필요하지만, 전부 상주시키면
 * 커넥션이 폭발한다(수백 개사 × limit). MariaDB 기본 max_connections는 151.
 *   → 최근 쓰인 회사만 상주시키고(LRU), 유휴 풀은 닫는다.
 *
 * ⚠ 회수(evict)가 트랜잭션을 끊으면 안 된다.
 *   pool.end()는 진행 중인 쿼리를 기다려주지 않으므로, 실제로 사용 중인 풀
 *   (in-flight > 0)은 절대 회수하지 않는다. 그래서 각 풀의 사용 건수를 추적한다.
 *
 * 설계: docs/02-design/features/multi-tenant-saas.design.md §5.1
 */
const mysql = require('mysql2/promise')
const { appConfig, assertDbName } = require('../platform/db')

const MAX_POOLS    = Number(process.env.TENANT_POOL_MAX        || 50)
const CONN_LIMIT   = Number(process.env.TENANT_POOL_CONN_LIMIT || 3)
const IDLE_MS      = Number(process.env.TENANT_POOL_IDLE_MS    || 10 * 60 * 1000)
const SWEEP_MS     = 60 * 1000

/** dbName → { pool, wrapped, lastUsed, inFlight } */
const entries = new Map()

/**
 * 풀을 감싸 사용 건수를 추적한다.
 * 라우트는 이 래퍼만 쓰므로(req.db), 회수 시점 판단이 정확해진다.
 */
function wrap(pool, entry) {
  const track = (p) => {
    entry.inFlight++
    return p.finally(() => { entry.inFlight-- })
  }
  return {
    execute: (...args) => track(pool.execute(...args)),
    query:   (...args) => track(pool.query(...args)),
    // 트랜잭션용. release() 될 때까지 사용 중으로 센다.
    getConnection: async () => {
      entry.inFlight++
      let conn
      try {
        conn = await pool.getConnection()
      } catch (e) {
        entry.inFlight--
        throw e
      }
      let released = false
      const release = conn.release.bind(conn)
      conn.release = () => {
        if (released) return          // 이중 release 방어 (카운터가 음수로 새는 것 방지)
        released = true
        entry.inFlight--
        release()
      }
      return conn
    },
  }
}

/**
 * 해당 회사 DB의 풀을 얻는다. 없으면 만들고, 한도를 넘으면 유휴 풀을 회수한다.
 * @param {string} dbName
 */
function getPool(dbName) {
  const db = assertDbName(dbName)
  let entry = entries.get(db)
  if (entry) {
    entry.lastUsed = Date.now()
    return entry.wrapped
  }

  evictIfNeeded()

  const pool = mysql.createPool({
    ...appConfig,
    database:           db,
    waitForConnections: true,
    connectionLimit:    CONN_LIMIT,
  })
  entry = { pool, lastUsed: Date.now(), inFlight: 0 }
  entry.wrapped = wrap(pool, entry)
  entries.set(db, entry)
  return entry.wrapped
}

/** 한도를 넘으면 '사용 중이 아닌' 것 중 가장 오래 안 쓴 풀을 닫는다. */
function evictIfNeeded() {
  if (entries.size < MAX_POOLS) return
  let victimKey = null
  let oldest = Infinity
  for (const [k, e] of entries) {
    if (e.inFlight > 0) continue          // 사용 중인 풀은 건드리지 않는다
    if (e.lastUsed < oldest) { oldest = e.lastUsed; victimKey = k }
  }
  // 전부 사용 중이면 회수하지 않는다 — 일시적으로 한도를 넘는 편이
  // 진행 중인 트랜잭션을 끊는 것보다 안전하다.
  if (victimKey) closePool(victimKey)
}

function closePool(db) {
  const e = entries.get(db)
  if (!e) return
  entries.delete(db)
  e.pool.end().catch(err => console.warn(`[pool] ${db} 종료 실패:`, err.code || err.message))
}

/** 오래 안 쓴 풀을 주기적으로 닫아 커넥션을 돌려준다. */
const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [k, e] of [...entries]) {
    if (e.inFlight === 0 && now - e.lastUsed > IDLE_MS) closePool(k)
  }
}, SWEEP_MS)
sweeper.unref?.()   // 이 타이머 때문에 프로세스가 안 죽는 일은 없게

/** 관측용 — 헬스체크/디버깅에서 현재 상주 풀 상태를 본다. */
function stats() {
  return {
    resident: entries.size,
    max: MAX_POOLS,
    connLimit: CONN_LIMIT,
    pools: [...entries].map(([db, e]) => ({
      db, inFlight: e.inFlight, idleSec: Math.round((Date.now() - e.lastUsed) / 1000),
    })),
  }
}

/** 종료 시 전부 정리 */
async function closeAll() {
  clearInterval(sweeper)
  await Promise.all([...entries.keys()].map(async (k) => {
    const e = entries.get(k)
    entries.delete(k)
    await e.pool.end().catch(() => {})
  }))
}

module.exports = { getPool, stats, closeAll, closePool }
