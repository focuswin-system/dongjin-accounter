/**
 * 문서번호 채번 (청구서 invoice_no · 결의서 doc_no)
 *
 * 채번은 전부 `SELECT MAX(뒤 4자리) + 1` 방식이다. 두 사람이 동시에 발행하면
 * 같은 MAX 를 읽어 같은 번호를 만든다. 다행히 두 컬럼에 유니크 인덱스가 있어
 * 중복이 실제로 저장되지는 않지만, 뒤늦게 INSERT 한 쪽이 ER_DUP_ENTRY 로 500 을
 * 받는다 — 사용자는 "처리 중 오류가 발생했어요"만 보고 원인을 알 수 없다.
 *
 * (2026-07-22 확인: 결의서 5건을 동시에 만들면 3건이 500)
 *
 * 락을 걸어 직렬화하는 대신, 충돌하면 번호를 다시 뽑아 재시도한다.
 * MySQL 에서 중복키 오류는 그 문(statement)만 실패시키고 트랜잭션을 깨지 않으므로
 * 같은 트랜잭션 안에서 안전하게 다시 시도할 수 있다.
 */

const MAX_TRIES = 8

/**
 * 재시도할 만한 경합 오류인가.
 *   1062 ER_DUP_ENTRY  — 같은 번호를 동시에 잡아 유니크 인덱스에 걸림
 *   1020 ER_CHECKREAD  — MariaDB가 잠금 읽기(FOR UPDATE) 경합에서 내는 오류
 *                        ("Record has changed since last read")
 * 둘 다 그 문(statement)만 실패시키므로 같은 트랜잭션 안에서 다시 시도해도 된다.
 *
 * ⚠ 교착(1213)은 넣지 않는다 — InnoDB가 트랜잭션 전체를 롤백해버리므로,
 *   같은 트랜잭션 안에서 재시도하면 트랜잭션 없이 쓰는 꼴이 된다. 그대로 위로 던진다.
 */
const RETRYABLE = new Set([1062, 1020])
const isRetryable = (e) => !!e && RETRYABLE.has(e.errno)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * @param {() => Promise<string>} computeNo  번호를 새로 뽑는다(매 시도마다 다시 호출)
 * @param {(no:string) => Promise<any>} insert  그 번호로 INSERT 한다
 * @returns {Promise<string>} 실제로 저장된 번호
 */
async function insertWithDocNo(computeNo, insert) {
  let lastErr
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      // ⚠ 채번도 try 안에 둔다. 잠금 읽기(FOR UPDATE) 자체가 경합으로 던지므로,
      //   밖에 두면 그 오류가 재시도되지 않고 그대로 500 이 된다.
      const no = await computeNo()
      await insert(no)
      return no
    } catch (e) {
      if (!isRetryable(e)) throw e
      lastErr = e
      // 같은 순간에 몰린 요청이 똑같은 간격으로 재시도하면 계속 부딪힌다 — 조금씩 어긋나게 한다
      await sleep(10 * (i + 1) + Math.floor(Math.random() * 15))
    }
  }
  // 5번 연속 충돌은 정상 경합이 아니다(번호 규칙이 깨졌거나 데이터가 이상하다)
  const err = new Error('문서번호를 만들지 못했어요. 잠시 후 다시 시도해주세요.')
  err.status = 409
  err.expose = true
  err.cause = lastErr
  throw err
}

module.exports = { insertWithDocNo }
