/**
 * 동진테크 MES 연결 — 고객사 전용 모듈의 **유일한 입구.**
 *
 *   수주      계약관리 › 수주 화면이 동진에서는 MES 수주를 **보기 전용**으로 보여 준다(GET /orders)
 *   거래처    MES 거래처 표가 원본 — 회계 거래처 화면이 lib/vendorSource 로 거친다(여기서 등록)
 *
 * 공통 코드가 server/custom/dongjin/ 을 부르는 곳은 이 파일 하나뿐이다(check:isolation [20]).
 * 규칙·SQL 은 전부 그 폴더에 있고, 여기는 문지기와 배선만 한다.
 *
 * ── 문지기 ──
 *   이 회사에 'custom:dongjin_mes' 가 켜져 있어야 한다(운영 콘솔에서 우리가 켠다).
 *   없으면 **404** — 권한이 없다(403)가 아니라 그런 기능이 없다고 답한다. 다른 고객사에게
 *   '동진 전용 기능이 있다'는 사실조차 드러내지 않는다.
 *   사람 축(누가 볼 수 있나)은 권한 게이트가 따로 본다(apiPerms '/api/dongjin-mes').
 *
 * 설계: docs/02-design/features/dongjin-custom-module.design.md
 */
const { Router } = require('express')
const { platformPool } = require('../platform/db')
const { featuresOf } = require('../lib/entitlements')
const { customFeatureKeyOf } = require('../platform/customCatalog')
const { kstToday } = require('../db')
const { mesPool } = require('../custom/dongjin/mesDb')
const mesRead = require('../custom/dongjin/mesRead')
const { registerVendorSource } = require('../lib/vendorSource')
const dongjinVendors = require('../custom/dongjin/vendorSource')
const { shapeGroup, STAGES } = require('../custom/dongjin/map/order')

const router = Router()
const FEATURE = customFeatureKeyOf('dongjin_mes')

/* 거래처 — 동진은 MES 거래처 표가 원본이다(2026-09-28 결정). 회계 거래처 화면(routes/vendors.js)이
   읽고 쓸 때 이 구현을 거친다. 켜진 회사인지는 구현이 요청마다 스스로 본다(applies). */
registerVendorSource(dongjinVendors)

// 문지기 — 켜진 회사만. 판정은 토큰의 companyId 로만(요청 본문·주소를 믿지 않는다)
router.use(async (req, res, next) => {
  try {
    const features = await featuresOf(platformPool, req.user?.companyId, kstToday())
    if (!features.has(FEATURE)) return res.status(404).json({ error: 'Not found' })
    next()
  } catch (e) { next(e) }
})

/* MES 가 설정·연결돼 있어야 하는 문들 — 없으면 503 과 이유. 화면이 그 문구를 그대로 보여 준다 */
const needMes = (res) => {
  const mes = mesPool()
  if (!mes) {
    res.status(503).json({ error: 'MES 연결 설정이 없어요(서버 MES_DB_NAME).', code: 'mes_not_configured' })
    return null
  }
  return mes
}

// 연결 상태 — 메뉴를 그릴지 판단하는 데도 쓴다(여기까지 오면 기능은 켜진 것이다)
router.get('/status', async (req, res, next) => {
  try {
    const mes = mesPool()
    if (!mes) return res.json({ enabled: true, configured: false })
    try {
      const counts = await mesRead.counts(mes)
      res.json({ enabled: true, configured: true, connected: true, counts })
    } catch (e) {
      // 연결 실패는 앱 오류가 아니라 상태다 — 화면에 '연결 안 됨'으로 보인다
      console.warn('[dongjin-mes] MES 연결 실패:', e.code || e.message)
      res.json({ enabled: true, configured: true, connected: false, error: e.code || 'connect_failed' })
    }
  } catch (e) { next(e) }
})

/* ── 수주 — MES 를 그대로 읽는다(회계로 옮기지 않는다, 설계 D2). 걸러 보기는 화면이 한다(1,257 PO 수준) ── */
router.get('/orders', async (req, res, next) => {
  try {
    const mes = needMes(res); if (!mes) return
    const rows = await mesRead.orderGroups(mes)
    const today = kstToday()
    res.json({ today, rows: rows.map(g => shapeGroup(g, today)) })
  } catch (e) { next(e) }
})

router.get('/orders/:contNumb/lines', async (req, res, next) => {
  try {
    const mes = needMes(res); if (!mes) return
    const lines = await mesRead.orderLines(mes, String(req.params.contNumb).slice(0, 20))
    res.json({ lines: lines.map(l => ({ ...l, stage_label: STAGES[Number(l.stage)] || '수주' })) })
  } catch (e) { next(e) }
})

module.exports = router
