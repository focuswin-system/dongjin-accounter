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

/**
 * 회사 마스터만 들어갈 수 있는 화면.
 *
 * 역할(role)은 자원 권한과 별개 축이다 — 'settings' 권한은 실무 역할도 갖지만
 * 계정 관리와 변경 이력은 마스터만이다(서버 routes/auth.js·routes/audit.js 가 막는다).
 * 그 화면들을 자원 권한만으로 가리면 **실무 역할에게 눌러도 403 나는 타일**이 남는다.
 */
export const MASTER_ONLY_LEAVES = new Set(['settings_audit'])

export const isMasterOnly = (id) => MASTER_ONLY_LEAVES.has(id)

/** 마스터가 아니면 마스터 전용 화면을 빼고 돌려준다(포털 노드용) */
export function withoutMasterOnly(node, isMaster) {
  if (!node || isMaster) return node
  if (node.route) return isMasterOnly(node.route) ? null : node
  const groups = (node.groups || [])
    .map(g => ({ ...g, items: g.items.filter(id => !isMasterOnly(id)) }))
    .filter(g => g.items.length)
  return groups.length ? { ...node, groups } : null
}

// ── React 배선 ────────────────────────────────────────────────
// prop drilling으로 화면 40여 개에 perms를 흘리는 건 현실적이지 않다 → context 하나.
//
// ⚠ 값은 **{ perms, isMaster }** 다. perms 맵만 넣으면 안 된다 —
//   마스터 전용 화면(변경 이력)은 자원 권한과 **다른 축**이라 perms 만으로는 못 가린다.
export const PermCtx = createContext(null)

/**
 * 화면에서 쓰는 훅. `const p = usePerms(); p.can('master_vendor','create')`
 *
 * ⚠ `can` 은 자원 권한 **위에 마스터 축을 한 번 더 얹는다.**
 *   '실무' 역할은 settings 자원을 통째로 갖는데(access·view·create·edit·delete),
 *   변경 이력 잎(settings_audit)의 자원 이름도 resourceOf 로 'settings' 가 된다.
 *   그래서 can() 만 보면 **비마스터에게 true** 가 나왔다 — 사이드바·홈 포털은
 *   withoutMasterOnly 로 따로 걸렀지만 Ctrl+K·바로가기 후보·라우트 가드는 안 걸러서,
 *   실무 계정이 '변경 이력 조회'를 검색해 들어갈 수 있었다(2026-09-02 실측).
 *   서버가 데이터를 안 주니 새는 건 없지만, 열리는 빈 화면은 고장으로 보인다.
 *   판정을 여기 한 곳에 둬서 호출부가 각자 기억하지 않아도 되게 한다.
 */
export function usePerms() {
  const ctx = useContext(PermCtx)
  const perms = ctx?.perms ?? null
  const isMaster = !!ctx?.isMaster
  const allow = (resource, action = 'access') =>
    can(perms, resource, action) && (isMaster || !isMasterOnly(resource))
  return {
    perms,
    isMaster,
    can: allow,
    /** 이 화면에서 쓰이는 흔한 판정 묶음 — 버튼 숨기기에 바로 쓴다 */
    of: (resource) => ({
      view:     allow(resource, 'view'),
      create:   allow(resource, 'create'),
      edit:     allow(resource, 'edit'),
      remove:   allow(resource, 'delete'),
      upload:   allow(resource, 'upload'),
      download: allow(resource, 'download'),
      export:   allow(resource, 'export'),
    }),
  }
}
