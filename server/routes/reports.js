const { Router } = require('express')
const { platformPool } = require('../platform/db')
const { featuresOf } = require('../lib/entitlements')
const { BUILTIN_REPORTS, visibleReports, featureKeyOf } = require('../platform/reportCatalog')
const { kstToday } = require('../db')
const xlsx = require('xlsx')
const { taxofficePack, SHEETS } = require('../lib/taxofficePack')
const { fundSheet } = require('../lib/fundSheet')
const { loanReport } = require('../lib/loanReport')
const { cardReport } = require('../lib/cardReport')
const { buildLoanWorkbook } = require('../lib/loanWorkbook')
const { canSeeLaborDetail } = require('../lib/fundStatus')

const router = Router()

/**
 * 보고서 카탈로그 — **이 회사가 볼 수 있는 양식 목록**.
 *
 * ⚠ 회사 구분은 **req.user.companyId** 로만 한다. 경로·본문으로 회사 id 를 받지 않는다 —
 *   받는 순간, 검증을 한 곳만 빠뜨려도 남의 회사 것을 보게 된다. 이 코드베이스는
 *   DB-per-tenant 라 격리가 이미 미들웨어에서 끝나 있고, 여기서 더 할 일이 없다.
 *   (여기서 platformPool 을 쓰는 건 주문 정보라 회사 DB에 있으면 안 되기 때문이다 —
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
      // 볼 수 있는 것만 내려간다. 두 축을 모두 통과해야 한다 —
      // 우리가 열어줬나(features) AND 회사가 켜 뒀나(disabled 에 없나)
      items: visibleReports({ catalog, features, disabled: await disabledOf(req.db) }),
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
  if (!features.has(featureKeyOf(key))) {
    res.status(403).json({ error: '이 보고서는 사용 중이 아니에요. 도입을 원하시면 문의해주세요.' })
    return false
  }
  // 회사가 스스로 껐으면 그 회사에서는 안 쓰는 것이다 — 데이터도 안 준다
  if ((await disabledOf(req.db)).has(key)) {
    res.status(403).json({ error: '이 보고서는 회사 설정에서 꺼져 있어요. 환경설정 > 보고서에서 켤 수 있어요.' })
    return false
  }
  return true
}

/** 그 회사가 스스로 끈 보고서 key 들 (report_prefs 에 행이 없으면 켜짐) */
async function disabledOf(db) {
  const [rows] = await db.execute('SELECT key_name FROM report_prefs WHERE enabled = 0')
  return new Set(rows.map(r => r.key_name))
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

/* ── 자금관리표 ──────────────────────────────────────────────────────────
 *
 * 대표가 쓰던 엑셀(`자금(현금)관리2026.xlsx`)의 칸 배치를 그대로 옮긴 한 장이다.
 * 자금 현황 화면과 **숫자는 같고 모양이 다르다**(lib/fundSheet.js 머리말 참조).
 *
 * 원본에 없던 '들어온 돈'을 더한다 — 원본은 <입금 예정금액>만 있어서
 * "이번 달에 얼마나 들어왔나"를 통장을 따로 열어 봐야 했다.
 */
async function fundSheetOf(req) {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? String(req.query.month) : null
  return fundSheet(req.db, {
    month, today: kstToday(), closingDay: await closingDayOf(req.db),
    // 이름별 미지급 인건비는 인사 권한이 있어야 본다(자금 판단에는 합계면 된다)
    canSeeLabor: canSeeLaborDetail(req),
  })
}

router.get('/fund-sheet', async (req, res, next) => {
  try {
    if (!(await requireFeature(req, res, 'fundsheet'))) return
    res.json(await fundSheetOf(req))
  } catch (e) { next(e) }
})

/* 엑셀.
 *
 * 원본 시트는 나갈 항목을 **가로로 8칸** 펼쳐 놨다. 사람이 손으로 채우던 표라 그게 가능했다.
 * 그런데 실제 데이터를 넣어 보니 계좌 하나에 항목이 **44개**까지 나온다(정기지출·상환 회차).
 * 가로로 펼치면 44열이 되어 못 읽고, 8칸에서 자르면 **조용히 빠진 지출**이 생긴다 —
 * 자금표에서 나갈 돈이 빠지는 건 이 문서가 가장 하면 안 되는 일이다.
 *
 * 그래서 한 장에는 **계좌별 요약 + 요약표 + 들어올 돈 + 미지급 인건비**를 원본 순서대로 담고,
 * 나갈 항목·부채·저축은 **명세 시트**로 뺀다. 아무것도 자르지 않는다.
 */
router.get('/fund-sheet.xlsx', async (req, res, next) => {
  try {
    if (!(await requireFeature(req, res, 'fundsheet'))) return
    const d = await fundSheetOf(req)
    const money = (n) => (Number(n) || 0)
    const wb = xlsx.utils.book_new()
    const addSheet = (name, aoa, cols) => {
      const ws = xlsx.utils.aoa_to_sheet(aoa)
      if (cols) ws['!cols'] = cols
      xlsx.utils.book_append_sheet(wb, ws, name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31))
    }

    /* ── 1장: 자금관리표 ── */
    const main = []
    main.push([`자금관리표  ${d.range.label}`])
    main.push(['집계 구간', `${d.range.from} ~ ${d.range.to}`])
    main.push(['※ 나갈 항목 명세는 [나갈 항목] 시트에 있습니다.'])
    main.push([])

    const acctBlock = (title, g) => {
      main.push([title])
      main.push(['계좌', '잔액', '들어온 돈', '나간 돈', '나갈 건수', '나갈 합계', '들어올 합계', '차액'])
      for (const r of g.rows) {
        main.push([r.name, money(r.balance), money(r.actualIn), money(r.actualOut),
          r.outItems.length, money(r.outTotal), money(r.inTotal), money(r.after)])
      }
      const t = g.total
      main.push(['합계', money(t.balance), money(t.actualIn), money(t.actualOut),
        g.rows.reduce((a, r) => a + r.outItems.length, 0), money(t.outTotal), money(t.inTotal), money(t.after)])
      main.push([])
    }
    acctBlock('<법인>', d.corp)
    acctBlock('<개인>', d.personal)

    main.push(['<요약>'])
    main.push(['구분', '보통계좌', '저축·보증금', '부채', '나갈 돈(예정)', '미지급 인건비', '들어온 돈', '들어올 돈', '현금 과부족'])
    main.push(['법인', money(d.summary.corp.cash), '', '', money(d.summary.corp.plan), '', '', '', money(d.summary.corp.shortfall)])
    main.push(['개인', money(d.summary.personal.cash), '', '', money(d.summary.personal.plan), '', '', '', money(d.summary.personal.shortfall)])
    main.push(['합계', money(d.summary.all.cash), money(d.summary.all.savings), money(d.summary.all.debt),
      money(d.summary.all.plan), money(d.summary.all.labor),
      money(d.summary.all.actualIn), money(d.summary.all.planIn), money(d.summary.all.shortfall)])
    // 저축·부채는 법인/개인 구분이 데이터에 없다 — 빈 칸으로 두고 이유를 적는다(지어내지 않는다)
    main.push(['※ 저축·부채는 법인/개인 구분이 데이터에 없어 합계로만 냅니다.'])
    main.push([])

    main.push(['<들어올 돈>'])
    main.push(['일자', '출처', '내용', '입금 계좌', '금액'])
    for (const it of d.incoming) {
      main.push([it.noDue ? '기한 미정' : (it.overdue ? `${it.date} (기한 지남)` : it.date),
        it.source, it.label, it.account, money(it.amount)])
    }
    main.push(['합계', '', '', '', d.incoming.reduce((a, x) => a + money(x.amount), 0)])
    main.push([])
    /* '들어온 돈'은 원본 엑셀에 없던 항목이다 — 원본은 예정만 있어서
       "이번 달에 얼마나 들어왔나"를 통장을 따로 열어 봐야 했다. */
    main.push(['<들어온 돈>', money(d.summary.all.actualIn)])
    main.push(['※ 원본 양식에 없던 항목입니다 — 이 구간에 실제로 입금이 끝난 금액입니다.'])
    main.push([])

    main.push(['<미지급 인건비>'])
    if ((d.labor.items || []).length) {
      main.push(['구분', '이름', '항목', '월분', '금액'])
      for (const it of d.labor.items) {
        main.push([it.status === 'retired' ? '퇴직자' : '현직원', it.name,
          it.kind === 'severance' ? '퇴직금' : '급여', it.period || '', money(it.remain)])
      }
    } else {
      main.push(['(이름별 명세는 인사 권한이 있어야 보입니다)'])
    }
    main.push(['합계', '', '', '', money(d.labor.total)])

    addSheet(d.range.label, main,
      [{ wch: 24 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 16 }])

    /* ── 2장: 나갈 항목 명세 ── 아무것도 자르지 않는다 */
    const outs = [['계좌', '구분', '일자', '출처', '내용', '금액']]
    for (const [label, g] of [['법인', d.corp], ['개인', d.personal]]) {
      for (const r of g.rows) {
        for (const it of r.outItems) outs.push([r.name, label, it.date || '', it.source || '', it.label, money(it.amount)])
      }
    }
    // 계좌가 안 정해진 예정(급여·퇴직금 등)도 빠뜨리지 않는다 — 빠지면 나갈 돈이 작아 보인다
    for (const it of (d.unassigned.items || []).filter(x => x.kind === 'out')) {
      outs.push(['(계좌 미지정)', '', it.date || '', it.source || '', it.label, money(it.amount)])
    }
    outs.push(['합계', '', '', '', '', outs.slice(1).reduce((a, r) => a + money(r[5]), 0)])
    addSheet('나갈 항목', outs, [{ wch: 20 }, { wch: 8 }, { wch: 13 }, { wch: 14 }, { wch: 34 }, { wch: 16 }])

    /* ── 3장: 부채 현황 ── */
    const debt = [['기관', '건명', '원금', '남은 원금']]
    for (const g of d.debts.groups || []) {
      for (const it of g.items) debt.push([g.lender, it.name, money(it.principal), money(it.remaining)])
    }
    debt.push(['합계', '', '', money(d.debts.total)])
    addSheet('부채 현황', debt, [{ wch: 20 }, { wch: 30 }, { wch: 16 }, { wch: 16 }])

    /* ── 4장: 저축·보증금 현황 ── */
    const sav = [['상품', '기관', '구분', '금액']]
    for (const it of d.savings.items || []) {
      sav.push([it.name, it.bank || '',
        it.kind === 'guarantee' ? '보증금' : it.kind === 'deposit' ? '예금' : '적금', money(it.amount)])
    }
    sav.push(['합계', '', '', money(d.savings.total)])
    addSheet('저축·보증금 현황', sav, [{ wch: 26 }, { wch: 16 }, { wch: 10 }, { wch: 16 }])

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition',
      `attachment; filename="fund_sheet.xlsx"; filename*=UTF-8''${encodeURIComponent(`자금관리표_${d.range.label}.xlsx`)}`)
    res.send(buf)
  } catch (e) { next(e) }
})

/* ── 차입금 현황 ────────────────────────────────────────────────────────
 *
 * 재무관리 > 차입금 화면에는 출력이 없었다. 대표·세무사에게 넘길 때마다 화면을 보고
 * 손으로 옮겨 적었다는 뜻이다 — 그 과정에서 숫자가 틀리면 아무도 모른다.
 *
 * 화면(JSON)과 엑셀이 **같은 lib/loanReport.js** 를 쓴다. 집계를 두 벌로 두면
 * 화면에서 본 잔액과 내려받은 파일의 잔액이 달라진다.
 *
 * status=all 이면 상환 완료분까지 낸다(기본은 진행 중만) — 결산 때 "올해 갚은 것"을
 * 봐야 하는데, 다 갚은 차입금이 목록에서 사라져 있으면 그 표를 만들 수 없다.
 */
router.get('/loans', async (req, res, next) => {
  try {
    if (!(await requireFeature(req, res, 'loan'))) return
    res.json(await loanReport(req.db, {
      status: req.query.status === 'all' ? 'all' : 'active',
      loanId: req.query.loan_id || null,
    }))
  } catch (e) { next(e) }
})

/* 카드 사용내역 — 카드별로 **쓴 돈과 갚은 돈**을 한 장에.
 *
 * 거르는 축을 쿼리로 받는다: owner(법인/개인) · card_type(신용/체크) · card_id · 기간.
 * 법인만 걸러 뽑으면 그것이 '법인카드 사용 기록부'다 — 별도 양식을 만들지 않는다.
 * 집계는 lib/cardReport.js 한 곳(화면과 엑셀이 같은 숫자를 봐야 한다).
 */
router.get('/cards', async (req, res, next) => {
  try {
    if (!(await requireFeature(req, res, 'card'))) return
    // 기간은 빈 값이면 전체다 — 화면의 '전체' 프리셋과 뜻이 같아야 한다
    res.json(await cardReport(req.db, {
      from: req.query.from || '',
      to: req.query.to || '',
      owner: req.query.owner || 'all',
      cardType: req.query.card_type || 'all',
      cardId: req.query.card_id || null,
    }))
  } catch (e) { next(e) }
})

/* 엑셀 — 서식 있는 통합문서(lib/loanWorkbook.js).
 *
 * loan_id 를 주면 그 계좌 한 건만 담는다. 전체를 받을지 한 계좌만 받을지는
 * 화면에서 고르고, 고른 그대로 파일이 나온다 — 화면과 파일이 다르면 둘 다 못 믿는다. */
router.get('/loans.xlsx', async (req, res, next) => {
  try {
    if (!(await requireFeature(req, res, 'loan'))) return
    const status = req.query.status === 'all' ? 'all' : 'active'
    const loanId = req.query.loan_id || null
    const d = await loanReport(req.db, { status, loanId })
    const today = kstToday()

    /* 고른 계좌가 이 회사에 없으면 빈 파일이 나간다 — "왜 비었지"로 끝나므로 먼저 끊는다.
       (남의 회사 것을 볼 위험은 없다. req.db 가 이미 이 회사 DB다.) */
    if (loanId && !d.loans.length) {
      return res.status(404).json({ error: '그 차입금을 찾을 수 없어요' })
    }

    const loanName = loanId ? d.loans[0].name : null
    const wb = buildLoanWorkbook(d, {
      today,
      scope: status === 'all' ? '상환 완료 포함' : '진행 중',
      loanName,
    })

    const filename = loanName
      ? `차입금현황_${loanName.replace(/[\/:*?"<>|]/g, ' ')}_${today}.xlsx`
      : `차입금현황_전체_${today}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition',
      `attachment; filename="loans.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`)
    await wb.xlsx.write(res)
    res.end()
  } catch (e) { next(e) }
})

/* ── 회사가 자기 보고서를 관리한다 ─────────────────────────────────────────
 *
 * **두 축을 섞지 않는다.**
 *   우리(운영 콘솔)  이 회사가 그 양식을 쓸 수 있나  ← 계약. 회사는 못 건드린다
 *   회사(이 화면)    쓸 수 있는 것 중 무엇을 쓸까     ← 그 회사 자유
 *
 * 그래서 회사는 **안 열린 양식을 열 수 없다**(409). 열 수 있게 하면 고객이 유료 기능을
 * 스스로 켜는 셈이 된다 — 이 설계가 처음부터 피한 것이다.
 * 반대로 **열린 것과 기본 제공은 끌 수 있다.** 안 쓰는 보고서를 자기 화면에서 치우는 건
 * 그 회사가 정할 일이고, 목록이 짧아야 쓰는 사람이 찾는다.
 *
 * 설계: docs/02-design/features/company-report-templates.design.md §17
 */
const isMaster = (req) => req.user?.role === 'admin'

router.get('/manage', async (req, res, next) => {
  try {
    if (!isMaster(req)) return res.status(403).json({ error: '회사 마스터만 볼 수 있어요' })
    const features = await featuresOf(platformPool, req.user?.companyId, kstToday())
    const disabled = await disabledOf(req.db)
    /* hidden 은 아예 없는 양식이라 목록에도 안 넣는다 — 고객에게 "준비 중인 게 있다"고
       알릴 이유가 없고, 알리면 언제 되느냐는 문의만 생긴다. */
    const items = BUILTIN_REPORTS.filter(r => r.scope !== 'hidden').map(r => {
      const entitled = r.scope === 'all' || features.has(featureKeyOf(r.key))
      return {
        key: r.key, title: r.title, descr: r.descr || '',
        basic: r.scope === 'all',   // 기본 제공인가
        entitled,                   // 우리가 열어줬나
        enabled: !disabled.has(r.key),
        visible: entitled && !disabled.has(r.key),
      }
    })
    res.json({ items })
  } catch (e) { next(e) }
})

router.put('/manage/:key', async (req, res, next) => {
  try {
    if (!isMaster(req)) return res.status(403).json({ error: '회사 마스터만 바꿀 수 있어요' })
    const key = String(req.params.key || '')
    const spec = BUILTIN_REPORTS.find(r => r.key === key && r.scope !== 'hidden')
    if (!spec) return res.status(404).json({ error: '없는 보고서예요' })

    const enabled = req.body?.enabled !== false
    if (enabled && spec.scope === 'entitled') {
      /* 켤 때만 주문을 본다. 끄는 건 언제든 되어야 한다 —
         주문이 끝나 안 보이는 양식을 '꺼짐'으로 정리하는 것까지 막을 이유가 없다. */
      const features = await featuresOf(platformPool, req.user?.companyId, kstToday())
      if (!features.has(featureKeyOf(key))) {
        return res.status(409).json({
          error: '이 보고서는 아직 사용 주문이 없어요. 도입을 원하시면 문의해주세요.',
        })
      }
    }
    /* 켜진 상태가 기본이므로 켤 때는 행을 지운다 — 그래야 우리가 나중에 조건을 바꿔도
       '예전에 켠 기록'이 남아 판단을 흐리지 않는다. */
    if (enabled) await req.db.execute('DELETE FROM report_prefs WHERE key_name = ?', [key])
    else {
      await req.db.execute(
        `INSERT INTO report_prefs (key_name, enabled) VALUES (?, 0)
         ON DUPLICATE KEY UPDATE enabled = 0`, [key])
    }
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
