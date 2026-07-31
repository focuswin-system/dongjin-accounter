/**
 * 화면 권한 — 메뉴 가리기·버튼 숨기기 판정.
 *
 * ⚠ 여기는 **편의**다. 실제 차단은 서버(middleware/perm.js)가 한다.
 * 버튼을 숨기는 건 "누를 수 있는데 안 되는" 헛수고를 없애려는 것이지 보안이 아니다.
 * 그러니 이 파일의 판정이 틀려도 남의 데이터가 새지 않는다 — 서버가 막는다.
 *
 * 권한은 로그인 시 /api/auth/me 가 내려준다: { 자원id: ['access','view','create',…] }
 */

import { createContext, useContext } from 'react'
import { NAV_TREE, SETTINGS_LEAVES, PORTAL, ALL_LEAVES } from './nav'

/** perms 가 비어 있으면(= 역할 미배정 계정) 전부 허용한다 — 서버 게이트와 같은 규칙 */
const unrestricted = (perms) => !perms || Object.keys(perms).length === 0

/**
 * 화면 id → 권한 자원 이름.
 *
 * 환경설정 하위 탭(settings_company·settings_user·settings_approval·settings_closing)은
 * **'settings' 자원 하나**가 통째로 관장한다(서버 permissions.js·apiPerms.js와 같은 규칙).
 * 서버는 settings_* 라는 자원을 아예 갖고 있지 않다.
 *
 * 이 변환을 빼먹으면 `can(perms,'settings_user')`가 항상 false가 되어,
 * **settings:access 를 가진 마스터가 환경설정 포털에서 통째로 튕긴다**
 * ("환경설정을(를) 볼 권한이 없어요" — 2026-07-31 확인). 변환을 can() 안에 둬서
 * 호출부(사이드바·포털·즐겨찾기·버튼)가 각자 기억하지 않아도 되게 한다.
 */
export const resourceOf = (id) => (String(id || '').startsWith('settings') ? 'settings' : id)

export function can(perms, resource, action = 'access') {
  if (unrestricted(perms)) return true
  const list = perms[resourceOf(resource)]
  return Array.isArray(list) && list.includes(action)
}

/** 여러 자원 중 하나라도 되면 통과 (한 화면이 여러 자원을 걸치는 경우) */
export const canAny = (perms, resources, action = 'access') =>
  unrestricted(perms) || resources.some(r => can(perms, r, action))

/**
 * 권한에 맞게 걸러낸 NAV_TREE.
 * · 잎: access 없으면 뺀다
 * · 섹션: 잎이 하나도 안 남으면 뺀다(빈 제목만 떠 있으면 고장으로 보인다)
 * · 도메인: 섹션이 하나도 안 남으면 뺀다
 */
export function visibleNav(perms) {
  if (unrestricted(perms)) return NAV_TREE
  const out = []
  for (const node of NAV_TREE) {
    if (node.type === 'leaf') { if (can(perms, node.id)) out.push(node); continue }
    const sections = node.sections
      .map(s => ({ ...s, items: s.items.filter(it => can(perms, it.id)) }))
      .filter(s => s.items.length)
    if (sections.length) out.push({ ...node, sections })
  }
  return out
}

/** 환경설정 잎 — 하위 탭 전부가 단일 자원 'settings' 소관이다(서버 매핑과 동일) */
export const visibleSettingsLeaves = (perms) =>
  can(perms, 'settings') ? SETTINGS_LEAVES : []

/** 포털 카테고리 안의 화면 목록도 같은 규칙으로 거른다 */
export function visiblePortalNode(perms, node) {
  if (unrestricted(perms) || !node) return node
  if (node.route) return can(perms, node.route) ? node : null
  const groups = (node.groups || [])
    .map(g => ({ ...g, items: g.items.filter(id => can(perms, id)) }))
    .filter(g => g.items.length)
  return groups.length ? { ...node, groups } : null
}

/**
 * 홈 포털(도메인 → 카테고리 타일) 필터.
 * 카테고리는 route 하나이거나 groups(여러 화면)이다. 들어갈 수 있는 화면이 하나도 없으면 타일을 뺀다.
 * 사이드바만 가리고 홈 타일을 남기면, 홈에서는 보이는데 메뉴엔 없는 이상한 상태가 된다.
 */
export function visiblePortal(perms) {
  if (unrestricted(perms)) return PORTAL
  const out = []
  for (const domain of PORTAL) {
    const categories = domain.categories.filter(cat => visiblePortalNode(perms, cat))
    if (categories.length) out.push({ ...domain, categories })
  }
  return out
}

/** '자주 찾는 메뉴' 후보·즐겨찾기 표시 목록도 같은 규칙으로 거른다 */
export const visibleLeaves = (perms) =>
  unrestricted(perms) ? ALL_LEAVES : ALL_LEAVES.filter(l => can(perms, l.id))   // can()이 settings_* → settings 로 변환

// ── React 배선 ────────────────────────────────────────────────
// prop drilling으로 화면 40여 개에 perms를 흘리는 건 현실적이지 않다 → context 하나.
export const PermCtx = createContext(null)

/** 화면에서 쓰는 훅. `const p = usePerms(); p.can('master_vendor','create')` */
export function usePerms() {
  const perms = useContext(PermCtx)
  return {
    perms,
    can: (resource, action = 'access') => can(perms, resource, action),
    canAny: (resources, action = 'access') => canAny(perms, resources, action),
    /** 이 화면에서 쓰이는 흔한 판정 묶음 — 버튼 숨기기에 바로 쓴다 */
    of: (resource) => ({
      view:     can(perms, resource, 'view'),
      create:   can(perms, resource, 'create'),
      edit:     can(perms, resource, 'edit'),
      remove:   can(perms, resource, 'delete'),
      upload:   can(perms, resource, 'upload'),
      download: can(perms, resource, 'download'),
      export:   can(perms, resource, 'export'),
    }),
  }
}
