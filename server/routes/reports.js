const { Router } = require('express')
const { platformPool } = require('../platform/db')
const { featuresOf } = require('../lib/entitlements')
const { BUILTIN_REPORTS, visibleReports } = require('../platform/reportCatalog')
const { kstToday } = require('../db')

const router = Router()

/**
 * 보고서 카탈로그 — **이 회사가 볼 수 있는 양식 목록**.
 *
 * ⚠ 회사 구분은 **req.user.companyId** 로만 한다. 경로·본문으로 회사 id 를 받지 않는다 —
 *   받는 순간, 검증을 한 곳만 빠뜨려도 남의 회사 것을 보게 된다. 이 코드베이스는
 *   DB-per-tenant 라 격리가 이미 미들웨어에서 끝나 있고, 여기서 더 할 일이 없다.
 *   (여기서 platformPool 을 쓰는 건 계약 정보라 회사 DB에 있으면 안 되기 때문이다 —
 *    회계 업무 데이터는 여전히 req.db 로만 읽는다. lib/entitlements.js 머리말 참조)
 *
 * 응답은 **목록뿐**이고 회계 숫자는 없다. 각 보고서 화면은 지금처럼 기존 API로 데이터를
 * 가져간다. 전용 데이터 API(/reports/:key/data)는 선언형 엔진(P3)에서 필요해질 때 만든다 —
 * 지금 만들면 쓰지도 않는 표면만 늘어난다.
 *
 * 설계: docs/02-design/features/company-report-templates.design.md §5
 */
router.get('/', async (req, res, next) => {
  try {
    const companyId = req.user?.companyId
    const features = await featuresOf(platformPool, companyId, kstToday())

    /* 회사 전용 양식(report_templates)은 P3(선언형)에서 이어 붙는 자리다.
       지금은 내장 카탈로그만 쓴다 — 표는 만들어 두되 비어 있다. */
    const catalog = BUILTIN_REPORTS

    res.json({
      // 볼 수 있는 것만 내려간다 — 안 켜진 양식은 마스터에게도 안 보낸다
      items: visibleReports({ catalog, features }),
    })
  } catch (e) { next(e) }
})

module.exports = router
