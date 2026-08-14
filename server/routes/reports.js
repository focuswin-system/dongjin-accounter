const { Router } = require('express')
const { platformPool } = require('../platform/db')
const { featuresOf } = require('../lib/entitlements')
const { BUILTIN_REPORTS, visibleReports, featureKeyOf } = require('../platform/reportCatalog')
const { kstToday } = require('../db')
const xlsx = require('xlsx')
const { taxofficePack, SHEETS } = require('../lib/taxofficePack')

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

/* ── 세무사 전달용 자료 ──────────────────────────────────────────────────
 *
 * 예전엔 화면에 건수가 **코드로 박혀 있었다**(16건·7건·5건·8건·7명·1건·누락 3건).
 * 실데이터와 무관한데 초록 체크까지 붙어 "준비 완료"로 읽혔고, 'ZIP 내려받기'는
 * 토스트만 떴다. 신고철에 그걸 믿고 넘어가면 자료가 빠진 채 세무사에게 간다.
 *
 * 이제 실제로 센다. 그리고 **한 파일로 내려받는다** — ZIP 대신 엑셀 한 권에 종류별 시트다.
 * 세무사가 받아서 여는 것도, 우리가 만드는 것도 그쪽이 낫다(ZIP은 압축 라이브러리가 더 필요하고,
 * 받는 쪽은 결국 풀어서 하나씩 연다).
 */

/** 'YYYY-MM' 인가 — 아니면 이번 달 */
const monthOf = (v) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || '')) ? String(v) : kstToday().slice(0, 7))

/** 회계 마감일 — 달 구간이 회사마다 다르다(25일 마감이면 7월분 = 6/26~7/25) */
async function closingDayOf(db) {
  const [[cfg]] = await db.execute("SELECT closing_day FROM company_info WHERE id = 'main'")
  return cfg ? Number(cfg.closing_day) || 0 : 0
}

/* 이 회사가 그 양식을 켰나 — **데이터 API 도 직접 확인한다.**
 *
 * 목록에서 빼는 것만으로는 부족하다. 화면에 안 보여도 URL 을 아는 사람은 그대로 부를 수 있고,
 * 한 번 켰다 끈 회사는 주소가 브라우저 기록에 남아 있다. "화면을 가렸으니 됐다"는
 * 프런트를 믿는 것이고, 이 코드베이스는 그렇게 하지 않는다(권한 게이트도 같은 이유로 서버에 있다).
 *
 * 권한(perm.js)은 'report' 자원 하나로만 판정하므로 여기까지 못 온다 —
 * 양식 단위 판정은 여기가 유일한 자리다.
 */
async function requireFeature(req, res, key) {
  const spec = BUILTIN_REPORTS.find(r => r.key === key)
  if (!spec || spec.scope === 'all') return true          // 기본 제공은 통과
  if (spec.scope === 'hidden') {                          // 아직 못 여는 양식
    res.status(404).json({ error: '없는 보고서예요' })
    return false
  }
  const features = await featuresOf(platformPool, req.user?.companyId, kstToday())
  if (features.has(featureKeyOf(key))) return true
  res.status(403).json({ error: '이 보고서는 사용 중이 아니에요. 도입을 원하시면 문의해주세요.' })
  return false
}

// 화면용 — 건수와 각 항목의 행
router.get('/taxoffice', async (req, res, next) => {
  try {
    if (!(await requireFeature(req, res, 'taxoffice'))) return
    const month = monthOf(req.query.month)
    const pack = await taxofficePack(req.db, month, await closingDayOf(req.db))
    res.json(pack)
  } catch (e) { next(e) }
})

/* 엑셀 — 종류별 시트 한 권.
 * 시트의 열은 화면 표와 같다(SHEETS). 보이는 것과 받는 것이 다르면 대조가 안 된다. */
router.get('/taxoffice.xlsx', async (req, res, next) => {
  try {
    if (!(await requireFeature(req, res, 'taxoffice'))) return
    const month = monthOf(req.query.month)
    const pack = await taxofficePack(req.db, month, await closingDayOf(req.db))

    const wb = xlsx.utils.book_new()
    /* 첫 장은 목차다 — 시트가 7개라 무엇이 몇 건인지 한눈에 봐야 한다.
       구간(from~to)을 적는 이유: 마감일이 있는 회사는 '7월분'이 6/26~7/25 라
       받는 쪽이 달력월로 오해하면 대조가 안 맞는다. */
    const guide = [
      ['세무사 전달용 자료'],
      ['월분', month],
      ['집계 구간', `${pack.from} ~ ${pack.to}`],
      [],
      ['항목', '건수', '비고'],
      ...pack.sections.map(s => [s.label, `${s.count}${s.unit}`, s.ready ? '' : '확인 필요']),
      [],
      ['· 입출금은 완료된 거래만 담았습니다(예정 제외).'],
      ['· 급여대장은 월분 기준이라 위 집계 구간과 다를 수 있습니다.'],
      ['· 원천징수이행상황신고서 서식은 포함하지 않습니다 — 대상 급여 명단만 담았습니다.'],
    ]
    const wsGuide = xlsx.utils.aoa_to_sheet(guide)
    wsGuide['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 12 }]
    xlsx.utils.book_append_sheet(wb, wsGuide, '목차')

    for (const sec of pack.sections) {
      const spec = SHEETS[sec.key]
      if (!spec) continue
      const rows = pack.data[sec.key] || []
      const aoa = [spec.head, ...rows.map(spec.row)]
      const ws = xlsx.utils.aoa_to_sheet(aoa)
      ws['!cols'] = spec.head.map(h => ({ wch: Math.max(10, String(h).length * 2 + 4) }))
      /* 시트 이름은 31자 제한이고 : \ / ? * [ ] 를 못 쓴다. 우리 이름들은 짧고 안전하지만
         라벨을 고칠 때 조용히 깨지지 않게 여기서 자른다. */
      xlsx.utils.book_append_sheet(wb, ws, sec.label.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31))
    }

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition',
      `attachment; filename="taxoffice_${month}.xlsx"; filename*=UTF-8''${encodeURIComponent(`세무사전달_${month}.xlsx`)}`)
    res.send(buf)
  } catch (e) { next(e) }
})

module.exports = router
