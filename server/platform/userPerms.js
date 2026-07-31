/**
 * 사용자 권한 조회 — 역할(user_roles) → 권한(role_perms) 합집합.
 *
 * ── 왜 JWT에 싣지 않는가 ──
 * 토큰에 권한을 박으면 마스터가 권한을 바꿔도 **그 사용자가 재로그인할 때까지 반영되지 않는다.**
 * 권한을 뺐는데 계속 쓸 수 있거나, 줬는데 못 쓰는 상태가 생긴다. 후자는 2026-07-30에 겪은
 * 임시비번 영구잠금과 같은 구조다(토큰의 낡은 플래그가 사용자를 가둔다).
 * 그래서 DB를 진실로 삼고, 대신 **짧은 캐시**로 매 요청 쿼리를 피한다.
 *
 * 캐시는 프로세스 메모리다. pm2 cluster 로 여러 인스턴스가 돌면 인스턴스마다 최대 TTL만큼
 * 낡은 값을 볼 수 있다 → TTL을 짧게(30초) 두고, 권한을 바꾼 요청은 즉시 무효화한다(invalidate).
 */

const TTL_MS = 30_000

// key: `${companyId}:${userId}` → { at, perms:Set<'resource:action'>, roles:string[] }
const cache = new Map()

const keyOf = (companyId, userId) => `${companyId}:${userId}`

/** 권한을 바꾼 직후 호출 — 그 사용자(또는 역할이 걸린 사용자 전체)의 캐시를 버린다 */
function invalidate({ companyId, userId, roleId } = {}) {
  if (userId && companyId) { cache.delete(keyOf(companyId, userId)); return }
  // 역할이 바뀌면 그 역할을 쓰는 사용자를 특정하기 어렵다 → 회사 단위로 버린다(안전한 쪽)
  if (companyId) {
    for (const k of cache.keys()) if (k.startsWith(`${companyId}:`)) cache.delete(k)
    return
  }
  cache.clear()
}

/**
 * 사용자의 권한 집합을 읽는다.
 * @param platformDb 공용 관리 DB 풀 (회사 DB가 아니다 — 역할·권한은 플랫폼에 있다)
 * @returns {{ perms:Set<string>, roles:string[] }} perms 원소는 'resource:action'
 */
async function loadUserPerms(platformDb, { companyId, userId }) {
  const k = keyOf(companyId, userId)
  const hit = cache.get(k)
  if (hit && Date.now() - hit.at < TTL_MS) return hit
  const [rows] = await platformDb.execute(
    `SELECT r.name AS role_name, rp.resource, rp.action
       FROM user_roles ur
       JOIN roles r      ON r.id = ur.role_id AND r.company_id = ?
       LEFT JOIN role_perms rp ON rp.role_id = r.id
      WHERE ur.user_id = ?`,
    [companyId, userId]
  )
  const perms = new Set()
  const roles = new Set()
  for (const row of rows) {
    if (row.role_name) roles.add(row.role_name)
    if (row.resource && row.action) perms.add(`${row.resource}:${row.action}`)
  }
  const entry = { at: Date.now(), perms, roles: [...roles] }
  cache.set(k, entry)
  return entry
}

/** 자원군 중 하나라도 그 행위 권한이 있는가 */
const canAny = (perms, resources, action) =>
  resources.some(r => perms.has(`${r}:${action}`))

/** 화면(nav) 노출 판정용 — 그 자원에 접근 권한이 있는가 */
const canAccess = (perms, resource) => perms.has(`${resource}:access`)

/**
 * 프런트에 내려줄 형태로 정리. 자원별 허용 행위 목록.
 * nav 가리기와 버튼 숨기기를 화면이 스스로 판단할 수 있게 한다.
 * @returns {{ roles:string[], perms:Record<string,string[]> }}
 */
function toClientShape({ perms, roles }) {
  const out = {}
  for (const p of perms) {
    const i = p.lastIndexOf(':')
    const resource = p.slice(0, i)
    const action = p.slice(i + 1)
    ;(out[resource] ||= []).push(action)
  }
  for (const k of Object.keys(out)) out[k].sort()
  return { roles, perms: out }
}

module.exports = { TTL_MS, loadUserPerms, invalidate, canAny, canAccess, toClientShape }
