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
const { shapeGroup, STAGES, shapePurchase, PUR_STAGES } = require('../custom/dongjin/map/order')

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
    // 기간(수주일) — 날짜 모양만 받는다. 비우면 전체
    const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '')
    const from = ymd(req.query.from), to = ymd(req.query.to)
    const today = kstToday()
    const all = (await mesRead.orderGroups(mes)).map(g => shapeGroup(g, today))
    /* 요약(화면 위 카드)은 **기간과 무관하게 지금 전체**를 센다. 기간으로 자르면 한 달 전에 받은 PO 는
       늦어도 '납기 지남'에서 사라진다 — 운영 실측 전체 740건 중 기본 기간(30일)에선 9건만 보였다(2026-09-29) */
    const going = all.filter(r => r.stage < 5)
    const summary = {
      going: going.length,
      goingAmount: going.reduce((a, r) => a + r.amount, 0),
      late: going.filter(r => r.due === 'late').length,
      soon: going.filter(r => r.due === 'soon').length,
    }
    const rows = all.filter(r => (!from || (r.orderDate && r.orderDate >= from)) && (!to || (r.orderDate && r.orderDate <= to)))
    res.json({ today, summary, rows })
  } catch (e) { next(e) }
})

router.get('/orders/:contNumb/lines', async (req, res, next) => {
  try {
    const mes = needMes(res); if (!mes) return
    const lines = await mesRead.orderLines(mes, String(req.params.contNumb).slice(0, 20))
    res.json({ lines: lines.map(l => ({ ...l, stage_label: STAGES[Number(l.stage)] || '수주' })) })
  } catch (e) { next(e) }
})

/* 발주 — 동진에서는 계약관리 › 발주 자리가 MES 구매발주(보기 전용). 권한은 발주 화면(contract_purchase)
   — apiPerms RESOURCE_OVERRIDES. 기간은 발주일, 위 요약은 수주와 같이 **기간과 무관한 지금 전체** */
router.get('/purchase-orders', async (req, res, next) => {
  try {
    const mes = needMes(res); if (!mes) return
    const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '')
    const from = ymd(req.query.from), to = ymd(req.query.to)
    const today = kstToday()
    const all = (await mesRead.purchaseOrders(mes)).map(p => shapePurchase(p, today))
    const going = all.filter(p => p.stageLabel !== '입고완료')
    const summary = {
      going: going.length,
      goingAmount: going.reduce((a, p) => a + p.amount, 0),
      late: going.filter(p => p.due === 'late').length,
      // 발주는 나갔는데 아직 다 안 들어온 것 — 매입(세금계산서)이 곧 올 돈
      waiting: going.filter(p => p.stageLabel === '발주완료' || p.stageLabel === '입고처리').length,
    }
    const rows = all.filter(p => (!from || (p.orderDate && p.orderDate >= from)) && (!to || (p.orderDate && p.orderDate <= to)))
    res.json({ today, stages: PUR_STAGES, summary, rows })
  } catch (e) { next(e) }
})

router.get('/purchase-orders/:pproNumb/lines', async (req, res, next) => {
  try {
    const mes = needMes(res); if (!mes) return
    res.json(await mesRead.purchaseOrderLines(mes, String(req.params.pproNumb).slice(0, 12)))
  } catch (e) { next(e) }
})

module.exports = router
