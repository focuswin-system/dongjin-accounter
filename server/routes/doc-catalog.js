const { Router } = require('express')
const { platformPool } = require('../platform/db')
const { featuresOf } = require('../lib/entitlements')
const { BUILTIN_DOCS, visibleDocs, featureKeyOf, prefKeyOf } = require('../platform/docCatalog')
const { kstToday } = require('../db')

const router = Router()

/**
 * 문서 카탈로그 — 보고서(routes/reports.js)와 **같은 짜임**이다.
 *
 * ⚠ 회사 구분은 req.user.companyId 로만 한다. 경로·본문으로 회사 id 를 받지 않는다.
 *   (platformPool 을 쓰는 건 주문 정보라 회사 DB 에 있으면 안 되기 때문이다 —
 *    회계 업무 데이터는 여전히 req.db 로만 읽는다)
 */

/** 그 회사가 스스로 끈 것들 (report_prefs 에 행이 없으면 켜짐 — 표의 규약) */
async function disabledOf(db) {
  const [rows] = await db.execute('SELECT key_name FROM report_prefs WHERE enabled = 0')
  return new Set(rows.map(r => r.key_name))
}

/**
 * 이 회사에서 보이는 문서 목록 — **사이드바를 그리기 전에** 화면이 부른다.
 *
 * ⚠ 실패하면 화면은 '전부 보임'으로 간다(App.jsx). 카탈로그를 못 읽었다고
 *   메뉴가 사라지면, 서버가 잠깐 흔들린 것이 고객에게는 '기능이 없어졌다'로 보인다.
 *   막는 것은 권한(middleware/perm.js)의 일이고 여기는 목록일 뿐이다.
 */
router.get('/', async (req, res, next) => {
  try {
    const features = await featuresOf(platformPool, req.user?.companyId, kstToday())
    res.json({ items: visibleDocs({ features, disabled: await disabledOf(req.db) }) })
  } catch (e) { next(e) }
})

/* ── 회사가 자기 문서를 켜고 끈다 ─────────────────────────────────────
 *
 * 두 층이다(보고서와 같다).
 *   우리(운영 콘솔)  이 회사가 그 양식을 쓸 수 있나  ← 계약. 회사는 못 건드린다
 *   회사(이 화면)    쓸 수 있는 것 중 무엇을 쓸까     ← 그 회사 자유
 *
 * 안 열린 양식은 회사가 스스로 열 수 없다(409). 반대로 **열린 것과 기본 제공은 끌 수 있다** —
 * 안 쓰는 문서를 메뉴에서 치우는 건 그 회사가 정할 일이다.
 */
const isMaster = (req) => req.user?.role === 'admin'

router.get('/manage', async (req, res, next) => {
  try {
    if (!isMaster(req)) return res.status(403).json({ error: '회사 마스터만 볼 수 있어요' })
    const features = await featuresOf(platformPool, req.user?.companyId, kstToday())
    const disabled = await disabledOf(req.db)
    const items = BUILTIN_DOCS.filter(d => d.scope !== 'hidden').map(d => {
      const entitled = d.scope === 'all' || features.has(featureKeyOf(d.key))
      const enabled = !disabled.has(prefKeyOf(d.key))
      return {
        key: d.key, title: d.title, descr: d.descr || '',
        basic: d.scope === 'all',   // 기본 제공인가
        entitled,                   // 우리가 열어줬나
        enabled,                    // 회사가 켜 뒀나
        visible: entitled && enabled,
      }
    })
    res.json({ items })
  } catch (e) { next(e) }
})

router.put('/manage/:key', async (req, res, next) => {
  try {
    if (!isMaster(req)) return res.status(403).json({ error: '회사 마스터만 바꿀 수 있어요' })
    const key = String(req.params.key || '')
    const spec = BUILTIN_DOCS.find(d => d.key === key && d.scope !== 'hidden')
    if (!spec) return res.status(404).json({ error: '없는 문서예요' })

    const enabled = req.body?.enabled !== false
    if (enabled && spec.scope === 'entitled') {
      // 켤 때만 주문을 본다. 끄는 건 언제든 되어야 한다.
      const features = await featuresOf(platformPool, req.user?.companyId, kstToday())
      if (!features.has(featureKeyOf(key))) {
        return res.status(409).json({
          error: '이 문서는 아직 사용 주문이 없어요. 도입을 원하시면 문의해주세요.',
        })
      }
    }
    /* 켜진 상태가 기본이므로 켤 때는 행을 지운다 — 그래야 나중에 규약이 바뀌어도
       '예전에 켠 기록'이 남아 판단을 흐리지 않는다. */
    if (enabled) await req.db.execute('DELETE FROM report_prefs WHERE key_name = ?', [prefKeyOf(key)])
    else {
      await req.db.execute(
        `INSERT INTO report_prefs (key_name, enabled) VALUES (?, 0)
         ON DUPLICATE KEY UPDATE enabled = 0`, [prefKeyOf(key)])
    }
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
