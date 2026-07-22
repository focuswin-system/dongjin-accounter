/**
 * 트랜잭션 실행 + 교착 시 전체 재시도
 *
 * ── 왜 필요한가 ──
 * InnoDB 는 교착(deadlock, errno 1213)을 감지하면 **트랜잭션 전체를 롤백**한다.
 * 그래서 문(statement) 단위 재시도(lib/docno.js)로는 못 살린다 — 이미 트랜잭션이
 * 없어진 상태라, 그 안에서 다시 시도하면 트랜잭션 없이 쓰는 꼴이 된다.
 * 살리려면 begin 부터 다시 해야 한다.
 *
 * 2026-07-22 확인: 결의서 8건 동시 생성 시 1건이 교착으로 실패했다. 데이터는
 * 안전했지만(롤백되므로) 사용자는 "다시 시도해주세요"를 보고 직접 눌러야 했다.
 *
 * ── 쓰는 법 ──
 *   router.post('/…', async (req, res, next) => {
 *     try {
 *       const out = await withTx(req.db, async (conn) => {
 *         …conn 으로 작업…
 *         return { ok: true, id }            // 반환값이 그대로 나온다
 *       })
 *       res.json(out)
 *     } catch (e) { next(e) }
 *   })
 *
 * 4xx 로 끝내려면 HttpError 를 던진다 — 재시도하지 않고 그대로 위로 나간다.
 *   throw httpError(409, '이미 처리된 결의서예요')
 *
 * ⚠ 콜백은 **여러 번 실행될 수 있다**. 콜백 밖의 상태를 바꾸지 말 것
 *   (파일 쓰기·외부 호출·상위 스코프 변수 누적 등). DB 작업만 넣는다.
 */

// 교착 / 잠금 대기 초과 — 다시 하면 되는 종류
const RETRYABLE = new Set([1213, 1205])
const MAX_TRIES = 3

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 라우트가 원하는 상태코드로 끝내고 싶을 때 쓰는 오류(재시도 대상이 아니다) */
function httpError(status, message) {
  const e = new Error(message)
  e.status = status
  e.expose = true
  return e
}

async function withTx(db, fn) {
  if (!db) throw new Error('withTx: 테넌트 연결(db)이 필요합니다')
  let lastErr
  for (let i = 0; i < MAX_TRIES; i++) {
    const conn = await db.getConnection()
    try {
      await conn.beginTransaction()
      const out = await fn(conn)
      await conn.commit()
      return out
    } catch (e) {
      // 롤백 실패가 원래 오류를 덮지 않게 한다(lib/tx.js 와 같은 이유)
      try { await conn.rollback() } catch (re) { console.error('[rollback 실패]', re && re.message) }
      if (!RETRYABLE.has(e && e.errno) || i === MAX_TRIES - 1) throw e
      lastErr = e
      console.warn(`[withTx] 잠금 경합(${e.errno}) — 재시도 ${i + 1}/${MAX_TRIES - 1}`)
      // 같은 순간에 몰린 요청이 똑같이 재시도하면 또 부딪힌다 — 조금씩 어긋나게
      await sleep(25 * (i + 1) + Math.floor(Math.random() * 40))
    } finally {
      conn.release()
    }
  }
  throw lastErr
}

module.exports = { withTx, httpError }
