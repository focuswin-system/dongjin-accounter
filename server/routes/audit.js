const express = require('express')
const ExcelJS = require('exceljs')
const { platformPool } = require('../platform/db')
const { ACTION_LABELS, RESOURCE_LABELS } = require('../platform/auditMap')

const router = express.Router()

/**
 * 변경 이력 (감사 로그 조회)
 *
 * ⚠ 이 라우터는 **테넌트 DB(req.db)가 아니라 공용 관리 DB**를 읽는다.
 * 감사 로그는 회사별 DB가 아니라 platform DB의 audit_logs 한 테이블에 모여 있기 때문이다
 * (로그인 실패처럼 '어느 회사인지 확정되기 전'의 사건도 남아야 해서 그렇게 설계됐다).
 *
 * 그래서 **회사 격리를 이 파일이 직접 책임진다.** 모든 조회에 company_id = ? 가 반드시 붙는다.
 * 이 조건이 하나라도 빠지면 남의 회사 이력이 그대로 보인다 — req.db 처럼 자동으로 막아주는
 * 장치가 없는 자리다. 아래 모든 쿼리가 companyId 를 첫 파라미터로 받는 이유다.
 *
 * 열람 권한: 회사 마스터만. 계정 보안 사건(로그인 실패·비밀번호 초기화)이 함께 보이고,
 * 감사 대상자가 자기 기록을 들여다보는 걸 막는 것이 감사의 기본이다.
 */

/** 회사 마스터만 — routes/auth.js 의 계정 관리와 같은 기준 */
const requireMaster = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '변경 이력은 회사 마스터만 볼 수 있어요.' })
  }
  next()
}

/** 한 번에 가져올 최대 건수 — 화면이 감당할 수 있고 DB도 부담 없는 선 */
const MAX_LIMIT = 200

/** 엑셀 상한. 1년치라도 이 이상이면 파일이 실무에서 안 열린다 */
const MAX_EXPORT = 20000

/** 저장된 시각(UTC)을 사용자가 보는 시각(KST) 문자열로 */
function kstStamp(v) {
  if (!v) return ''
  const d = new Date(new Date(v).getTime() + 9 * 3600 * 1000)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** 정수 파라미터를 안전 범위로 자른다. LIMIT/OFFSET 은 문자열이면 SQL 이 깨진다 */
const intIn = (v, min, max, dflt) => {
  const n = parseInt(v, 10)
  if (!Number.isFinite(n)) return dflt
  return Math.min(Math.max(n, min), max)
}

/**
 * 조회 기간 규칙 — **서버가 단일 소스다.**
 *
 * 기본 한 달: 감사 로그는 계속 쌓이기만 한다. 기본을 '전체'로 두면 화면을 열 때마다
 * 몇 년치를 훑게 되고, 정작 최근에 무슨 일이 있었는지는 더 안 보인다.
 *
 * 최대 1년: 상한이 없으면 한 번의 조회가 테이블 전체 스캔이 된다. 다만 **조용히 잘라내지는
 * 않는다** — 자른 결과를 그대로 보여주면 "그 기간엔 아무 일도 없었다"로 잘못 읽힌다.
 * 넘으면 명확히 거절하고 이유를 말한다.
 */
const DEFAULT_DAYS = 30
const MAX_DAYS = 366          // 윤년 포함 1년

const dayOf = (v) => String(v || '').slice(0, 10)
/* 형태만 보면 '2026-13-99' 도 통과한다(13월 99일). 그 값이 그대로 SQL 로 들어가면
   조건이 아무것도 못 맞춰 **빈 목록**이 되고, 사용자는 그걸 '그 기간엔 일이 없었다'로 읽는다.
   실제 존재하는 날짜인지까지 확인한다. */
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))

/**
 * from·to 를 확정한다. 둘 다 없으면 최근 한 달.
 * @returns {{from:string,to:string}|{error:string}}
 */
function resolveRange(q, today) {
  const to = isDate(dayOf(q.to)) ? dayOf(q.to) : today
  let from = isDate(dayOf(q.from)) ? dayOf(q.from) : null
  if (!from) {
    const d = new Date(`${to}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - DEFAULT_DAYS)
    from = d.toISOString().slice(0, 10)
  }
  if (from > to) return { error: '시작일이 종료일보다 뒤예요.' }
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)
  if (span > MAX_DAYS) return { error: '기간은 최대 1년까지 조회할 수 있어요. 시작일을 조정해 주세요.' }
  return { from, to }
}

/** 오늘(KST). 서버 시계가 UTC여도 사용자가 보는 '오늘'과 어긋나지 않게 한다. */
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)

/**
 * 필터 → WHERE 조각. company_id 는 호출부에서 이미 넣었으므로 여기선 추가 조건만 만든다.
 * 값은 전부 플레이스홀더로 넘긴다(문자열 결합 금지).
 */
function buildFilters(q, range) {
  const where = []
  const params = []
  if (q.action)   { where.push('action = ?');   params.push(String(q.action)) }
  if (q.resource) { where.push('resource = ?'); params.push(String(q.resource)) }
  if (q.username) { where.push('username = ?'); params.push(String(q.username)) }
  // 날짜는 '그 날 전체'를 포함해야 한다 — to 를 그대로 쓰면 그날 오전 0시까지만 잡힌다.
  where.push('created_at >= ?'); params.push(`${range.from} 00:00:00`)
  where.push('created_at <= ?'); params.push(`${range.to} 23:59:59`)
  return { where, params }
}

// ── 목록 ──
router.get('/', requireMaster, async (req, res, next) => {
  try {
    const companyId = req.user.companyId
    const range = resolveRange(req.query, kstToday())
    if (range.error) return res.status(400).json({ error: range.error })
    const { where, params } = buildFilters(req.query, range)
    /* `company_id = ?` 는 **각 쿼리문에 직접 적는다.** 변수로 감싸 붙이면 그 변수를 만드는
     * 곳을 고칠 때 회사 조건이 조용히 빠질 수 있고, 사람도 검사 스크립트도 그걸 못 본다.
     * 추가 필터만 뒤에 잇는다. (check-isolation [12] 가 이 형태를 강제한다) */
    const more = where.length ? ` AND ${where.join(' AND ')}` : ''
    const limit = intIn(req.query.limit, 1, MAX_LIMIT, 50)
    const offset = intIn(req.query.offset, 0, 1_000_000, 0)

    const [[{ total }]] = await platformPool.execute(
      `SELECT COUNT(*) AS total FROM audit_logs WHERE company_id = ?${more}`,
      [companyId, ...params])

    // LIMIT/OFFSET 은 위에서 정수로 확정했으므로 그대로 넣는다
    // (준비문 플레이스홀더로는 드라이버·서버 조합에 따라 문자열로 넘어가 문법 오류가 난다).
    const [rows] = await platformPool.execute(
      `SELECT id, user_id, username, action, resource, target_id, ip, detail, created_at
         FROM audit_logs WHERE company_id = ?${more}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      [companyId, ...params])

    res.json({ rows, total, limit, offset, from: range.from, to: range.to })
  } catch (e) { next(e) }
})

/**
 * 엑셀 내려받기 — 화면과 **같은 필터·같은 기간**으로 뽑는다.
 *
 * 화면은 '더 보기'로 나눠 받지만 파일은 그 기간 전체를 담는다. 눈으로 본 것과 파일이
 * 다르면 감사 자료로 못 쓰기 때문에, 조건은 목록과 한 함수(buildFilters)를 공유한다.
 */
router.get('/export.xlsx', requireMaster, async (req, res, next) => {
  try {
    const range = resolveRange(req.query, kstToday())
    if (range.error) return res.status(400).json({ error: range.error })
    const { where, params } = buildFilters(req.query, range)
    const more = where.length ? ` AND ${where.join(' AND ')}` : ''

    /* 상한을 넘으면 **잘라서 주지 않고 거절한다.**
     * 2만 행짜리 파일을 말없이 건네면 받은 사람은 그게 전부라고 믿는다. 감사 자료에서
     * '없는 것'은 곧 '일어나지 않은 일'로 읽히므로, 잘린 파일은 조회 상한을 넘긴 것보다 나쁘다.
     * (기간 상한을 거절로 처리한 것과 같은 이유다) */
    const [[{ total }]] = await platformPool.execute(
      `SELECT COUNT(*) AS total FROM audit_logs WHERE company_id = ?${more}`,
      [req.user.companyId, ...params])
    if (total > MAX_EXPORT) {
      return res.status(400).json({
        error: `기록이 ${total.toLocaleString('ko-KR')}건이라 한 번에 내보낼 수 없어요` +
               ` (최대 ${MAX_EXPORT.toLocaleString('ko-KR')}건). 기간을 나눠서 받아주세요.`,
      })
    }

    const [rows] = await platformPool.execute(
      `SELECT created_at, username, resource, action, target_id, ip
         FROM audit_logs WHERE company_id = ?${more}
        ORDER BY created_at DESC, id DESC
        LIMIT ${MAX_EXPORT}`,
      [req.user.companyId, ...params])

    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('변경 이력')
    ws.columns = [
      { header: '시각',      key: 'at',     width: 20 },
      { header: '사용자',    key: 'who',    width: 18 },
      { header: '대상',      key: 'res',    width: 14 },
      { header: '행위',      key: 'action', width: 18 },
      { header: '대상 번호', key: 'target', width: 40 },
      { header: '접속 IP',   key: 'ip',     width: 16 },
    ]
    ws.getRow(1).font = { bold: true }
    ws.views = [{ state: 'frozen', ySplit: 1 }]

    for (const r of rows) {
      ws.addRow({
        // 엑셀에서 정렬·필터가 되도록 문자열로 고정한다(로캘에 따라 날짜 해석이 갈리는 걸 피한다)
        at: kstStamp(r.created_at),
        // 운영자가 한 일은 파일에서도 구별돼야 한다 — 화면의 「운영자」 표시와 같은 의미다
        who: String(r.username || '').startsWith('ops:')
          ? `[운영자] ${String(r.username).slice(4)}` : (r.username || ''),
        res: RESOURCE_LABELS[r.resource] || r.resource || '',
        action: ACTION_LABELS[r.action] || r.action || '',
        target: r.target_id || '',
        ip: r.ip || '',
      })
    }

    const filename = `변경이력_${range.from}_${range.to}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    // 한글 파일명 — 구형 클라이언트용 ASCII fallback + RFC 5987
    res.setHeader('Content-Disposition',
      `attachment; filename="audit-log.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`)
    await wb.xlsx.write(res)
    res.end()
  } catch (e) { next(e) }
})

/**
 * 화면이 필요로 하는 부속 정보 — 행위·자원 이름표와, 이 회사에 실제로 기록이 있는 사용자 목록.
 *
 * 이름표를 프런트에 복사해 두지 않는 이유: 규칙을 고칠 때 한쪽만 바뀌면 새 행위가
 * 코드값('pay_missed') 그대로 보인다. 서버가 단일 소스다(platform/auditMap.js).
 */
router.get('/meta', requireMaster, async (req, res, next) => {
  try {
    const [users] = await platformPool.execute(
      `SELECT DISTINCT username FROM audit_logs
        WHERE company_id = ? AND username IS NOT NULL ORDER BY username`,
      [req.user.companyId])
    res.json({
      actions: ACTION_LABELS,
      resources: RESOURCE_LABELS,
      usernames: users.map(u => u.username),
    })
  } catch (e) { next(e) }
})

module.exports = router
// 기간 규칙은 감사 자료의 신뢰성이 걸린 부분이라 따로 검증한다(test/auditRange.test.js)
module.exports._range = { resolveRange, buildFilters, DEFAULT_DAYS, MAX_DAYS }
