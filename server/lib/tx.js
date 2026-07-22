/**
 * 트랜잭션 보조 유틸
 *
 * 배경: 이 앱은 Express 4를 쓴다. Express 4는 async 라우트 핸들러가 반환한
 * Promise의 거부(rejection)를 잡지 못한다. 그래서 아래 흔한 패턴이 위험하다.
 *
 *   } catch (e) { await conn.rollback(); next(e) }
 *
 * 커넥션이 이미 끊겼거나 DB가 재시작한 상황이면 `conn.rollback()` 자체가 던진다.
 * 그러면 `next(e)`가 **실행되지 않고** 그 거부가 라우트를 빠져나간다. 결과는 둘 다 나쁘다.
 *   · 응답이 영영 나가지 않아 사용자 화면이 멈춘다
 *   · Node 20 기본값에서는 처리되지 않은 거부가 **프로세스를 죽인다**
 *     (index.js에 최종 안전망을 뒀지만, 애초에 여기서 막는 게 맞다)
 *
 * 4xx를 반환하기 직전의 `await conn.rollback()`도 같은 문제를 갖는다 —
 * rollback이 던지면 준비해둔 친절한 오류 메시지가 사용자에게 도달하지 못한다.
 */

/**
 * 롤백하되, 롤백 자체의 실패는 삼킨다.
 * 롤백이 실패해도 어차피 커밋되지 않았으므로 데이터는 안전하다.
 * 중요한 것은 그 뒤의 응답·에러 전달 흐름을 끊지 않는 것이다.
 */
async function rollbackQuietly(conn) {
  try {
    await conn.rollback()
  } catch (e) {
    // 여기서 다시 던지면 원래 오류를 덮어써 진짜 원인을 잃는다. 로그만 남긴다.
    console.error('[rollback 실패]', e && e.message)
  }
}

module.exports = { rollbackQuietly }
