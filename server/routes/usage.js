const { Router } = require('express')
const { platformPool } = require('../platform/db')

const router = Router()

/* 화면 사용 수집.
 *
 * 왜 필요한가: 지금까지 남는 것은 로그인과 **행위**(삭제·처리 같은 감사 대상)뿐이었다.
 * 그래서 가장 흔한 이탈 모습인 "들어와서 보기만 하고 나갔다"가 안 잡혔고,
 * "안 쓰는 것 같은데 어디서 막히는 걸까"를 추측으로만 이야기했다.
 *
 * 남기는 것은 **화면 이름뿐**이다. 금액·거래처·대상 ID는 넣지 않는다(감사 로그와 같은 정책).
 */

/* 화면 이름은 해시 라우트에서 온다 — 즉 주소창에서 사람이 바꿀 수 있는 값이다.
   그대로 저장하면 아무 문자열이나 테이블에 쌓인다(길이·개수 모두 통제 불능).
   글자 모양과 길이를 여기서 자른다. 알려진 라우트 목록과 대조하지 않는 이유는,
   화면이 늘 때마다 서버를 같이 고쳐야 하는 짐이 생기고 그 짐은 반드시 어긋나기 때문이다. */
const ROUTE_OK = /^[a-z][a-z0-9_]{0,59}$/

router.post('/', async (req, res) => {
  try {
    const route = String(req.body?.route || '')
    if (!ROUTE_OK.test(route)) return res.json({ ok: false })      // 조용히 무시 — 화면을 방해하지 않는다
    const { id: userId, companyId, username } = req.user || {}
    if (!userId || !companyId) return res.json({ ok: false })

    /* 하루 한 줄로 누적한다. 같은 화면을 몇 번 들렀는지는 hits 로 세고,
       마지막으로 만진 시각은 last_at 이 든다(사용자별 '마지막 접속'이 여기서 나온다). */
    await platformPool.execute(
      `INSERT INTO usage_daily (company_id, user_id, username, day, route, hits, last_at)
       VALUES (?, ?, ?, CURDATE(), ?, 1, NOW())
       ON DUPLICATE KEY UPDATE hits = hits + 1, last_at = NOW(), username = VALUES(username)`,
      [companyId, userId, username || null, route])
    res.json({ ok: true })
  } catch {
    /* 수집이 실패해도 화면은 아무 일 없어야 한다. 이건 곁다리 기록이지
       사용자가 하려던 일이 아니다 — next(e) 로 흘리면 에러 로그만 시끄러워진다. */
    res.json({ ok: false })
  }
})

module.exports = router
