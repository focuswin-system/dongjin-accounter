/**
 * 회사가 무엇을 쓸 수 있나(entitlement).
 *
 * ── 권한(permission)과 다른 축이다 ──
 *   entitlement  이 **회사**가 샀나        → 우리(공급자)가 정한다. 플랫폼 DB
 *   permission   이 **사용자**가 볼 수 있나 → 고객사 마스터가 정한다. role_perms
 * 판정은 **AND**. "회사는 샀는데 사원은 못 본다"가 표현돼야 하므로 한 필드로 합치면 안 된다.
 *
 * ── 왜 플랫폼 DB인가 ──
 * 테넌트 DB(회사 DB)에 두면 **고객사 마스터가 자기 유료 기능을 스스로 켤 수 있다.**
 * 회사 DB는 그 회사 것이고 우리가 통제할 수 없다. 그래서 여기만은 플랫폼 DB다.
 * (routes/ 에서 platformPool 을 쓰는 것은 middleware/perm.js 와 같은 계열의 예외다 —
 *  회계 '업무 데이터'가 아니라 계약 정보라서 회사 DB에 있으면 안 되는 값이다.)
 *
 * 설계: docs/02-design/features/company-report-templates.design.md §3 · §4
 */
const { planFeatures } = require('../platform/plans')

/* 짧은 캐시 — 보고서 목록은 화면을 열 때마다 부른다. 회사당 한 줄짜리 조회지만
   플랫폼 풀은 모든 회사가 함께 쓰므로 왕복을 줄인다.
   30초로 둔 이유: 운영 콘솔에서 기능을 켠 뒤 "왜 안 보이지"를 오래 겪지 않을 만큼 짧고,
   화면 전환마다 조회하지는 않을 만큼 길다. */
const TTL_MS = 30_000
const cache = new Map()   // companyId → { at, features:Set, plan }

/* DATE 컬럼 → 'YYYY-MM-DD'.
 *
 * ⚠ mysql2 는 DATE 를 **Date 객체**로 준다. String(date) 는
 *   'Thu Jan 01 2026 00:00:00 GMT+0900…' 이라 앞 10자를 자르면 'Thu Jan 01' 이 된다.
 *   그걸 today('2026-08-14')와 문자열로 비교하면 '2' < 'T' 라서 **만료가 영영 안 온다** —
 *   해지한 회사가 유료 양식을 계속 보는 상태로, 에러 한 줄 없이 조용하다.
 *   (실동작 검증에서 실제로 잡혔다.)
 * Date 는 연·월·일을 직접 꺼낸다. UTC 로 바꾸면 KST 기준 날짜가 하루 밀린다.
 */
function dateOf(v) {
  if (!v) return null
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    const p = (n) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  const s = String(v).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/**
 * 요금제 묶음 + 회사별 낱개를 합친다. **순수 함수** — 테스트가 DB를 안 탄다.
 *
 * 낱개가 묶음을 덮는다:
 *   enabled=1 이고 기간 안 → 준다
 *   enabled=0            → **뺀다**(요금제로 받은 것도 회수된다. 환불·계약 해지 자리)
 * 기간 밖(아직 시작 전 / 이미 만료)은 없는 것으로 본다.
 *
 * @param {string[]} base  요금제가 주는 기능 키
 * @param {Array}    rows  company_features 행
 * @param {string}   today 'YYYY-MM-DD'
 */
function mergeFeatures(base, rows, today) {
  const set = new Set(base)
  for (const r of rows || []) {
    const key = r.feature_key
    if (!key) continue
    if (!Number(r.enabled)) { set.delete(key); continue }
    // 날짜는 비어 있으면 제한 없음. 구독으로 팔 때만 채운다(지금은 안 채운다).
    const starts = dateOf(r.starts_on)
    const ends = dateOf(r.expires_on)
    if (starts && today < starts) continue
    if (ends && today > ends) continue
    set.add(key)
  }
  return set
}

/**
 * 이 회사가 가진 기능 키 집합.
 * @param {import('mysql2/promise').Pool} platformPool
 * @param {string} companyId  ⚠ 반드시 req.user.companyId — 요청 본문에서 받은 값이면 안 된다
 * @param {string} today
 */
async function featuresOf(platformPool, companyId, today) {
  if (!companyId) return new Set()
  const hit = cache.get(companyId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.features

  const [[company]] = await platformPool.execute(
    'SELECT plan FROM companies WHERE id = ?', [companyId])
  const [rows] = await platformPool.execute(
    `SELECT feature_key, enabled, starts_on, expires_on
       FROM company_features WHERE company_id = ?`, [companyId])

  const features = mergeFeatures(planFeatures(company?.plan), rows, today)
  cache.set(companyId, { at: Date.now(), features, plan: company?.plan || null })
  return features
}

/** 기능을 켜고 끈 직후 즉시 반영되도록 — 운영 콘솔이 부른다(P1). */
function invalidate(companyId) {
  if (companyId) cache.delete(companyId)
  else cache.clear()
}

module.exports = { featuresOf, mergeFeatures, invalidate, dateOf, TTL_MS }
