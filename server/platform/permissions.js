/**
 * 권한 카탈로그 — 자원(화면) × 행위
 *
 * 자원 id는 프런트 네비게이션(src/lib/nav.js)의 잎 메뉴 id와 1:1로 대응한다.
 * 둘이 어긋나면 '화면은 있는데 권한을 못 주는' 상태가 되므로
 * scripts/check-isolation.js 가 동기화를 검사한다.
 *
 * ⚠ 새 화면이 추가됐을 때의 기본값 정책:
 *   기존 역할에는 그 자원의 권한 행이 없으므로 **아무에게도 보이지 않는다**(마스터 제외).
 *   회사 마스터가 명시적으로 열어줘야 한다 — 회계·방산 특성상 '기본 차단'이 안전하다.
 *
 * 설계: docs/02-design/features/multi-tenant-saas.design.md §4
 */

/** 행위 — 세분화된 권한 단위 */
const ACTIONS = ['access', 'view', 'create', 'edit', 'delete', 'upload', 'download', 'export']

const ACTION_LABELS = {
  access:   '접근',   // 메뉴 노출 / 화면 진입
  view:     '조회',
  create:   '등록',
  edit:     '수정',
  delete:   '삭제',
  upload:   '업로드', // 파일 첨부 · 엑셀 임포트
  download: '다운로드',
  export:   '출력',   // 인쇄 · 보고서 내보내기
}

/**
 * 자원(화면) 카탈로그. group은 관리 화면에서 묶어 보여주기 위한 분류.
 * nav.js의 도메인/섹션 구조를 그대로 따른다.
 */
const RESOURCES = [
  { id: 'home',                    label: '홈',            group: '공통' },

  { id: 'contract_sales',          label: '매출 계약',      group: '일반회계 · 판매·매출' },
  { id: 'billing_issued',          label: '대금 청구서(매출)', group: '일반회계 · 판매·매출' },
  { id: 'ar',                      label: '입금·환불',      group: '일반회계 · 판매·매출' },

  { id: 'contract_purchase',       label: '매입 계약',      group: '일반회계 · 구매·매입' },
  { id: 'billing_received',        label: '대금 청구서(매입)', group: '일반회계 · 구매·매입' },
  { id: 'doc',                     label: '지급결의서',     group: '일반회계 · 구매·매입' },
  { id: 'ap',                      label: '지급·환입',      group: '일반회계 · 구매·매입' },

  { id: 'ledger',                  label: '전체 거래내역',  group: '일반회계 · 거래·계약' },
  { id: 'contract',                label: '계약',          group: '일반회계 · 거래·계약' },

  { id: 'tax_vat',                 label: '부가세',        group: '일반회계 · 세무관리' },
  { id: 'tax_etc',                 label: '기타세액',      group: '일반회계 · 세무관리' },

  { id: 'master_vendor',           label: '거래처',        group: '일반회계 · 기준정보' },
  { id: 'master_accountSubject',   label: '계정과목',      group: '일반회계 · 기준정보' },
  { id: 'master_category',         label: '비목',          group: '일반회계 · 기준정보' },
  { id: 'master_jeokyo',           label: '적요',          group: '일반회계 · 기준정보' },
  { id: 'master_item',             label: '품목',          group: '일반회계 · 기준정보' },
  { id: 'master_fixed_asset',      label: '고정자산',      group: '일반회계 · 기준정보' },
  { id: 'master_intangible_asset', label: '무형자산',      group: '일반회계 · 기준정보' },
  { id: 'master_account',          label: '계좌/카드',     group: '일반회계 · 기준정보' },
  { id: 'master_accountBalance',   label: '계좌 잔액',     group: '일반회계 · 기준정보' },
  { id: 'master_insurance',        label: '보험',          group: '일반회계 · 기준정보' },

  { id: 'hr',                      label: '인사관리',      group: '인사급여' },
  { id: 'hr_labor_contract',       label: '근로계약',      group: '인사급여 · 근로·용역' },
  { id: 'hr_outsourcing',          label: '기타 용역·일용', group: '인사급여 · 근로·용역' },
  { id: 'hrbase_department',       label: '부서',          group: '인사급여 · 기준정보' },
  { id: 'hrbase_position',         label: '직위',          group: '인사급여 · 기준정보' },
  { id: 'hrbase_payrollItems',     label: '급여 항목',     group: '인사급여 · 기준정보' },
  { id: 'hrbase_employType',       label: '고용형태',      group: '인사급여 · 기준정보' },

  { id: 'report',                  label: '보고서',        group: '경영관리' },
  { id: 'mgmt_dash',               label: '경영 대시보드',  group: '경영관리' },
  { id: 'mgmt_ask',                label: '경영 질의',      group: '경영관리' },

  { id: 'settings',                label: '환경설정',      group: '공통' },
]

const RESOURCE_IDS = RESOURCES.map(r => r.id)
const HR_RESOURCES = RESOURCE_IDS.filter(id => id === 'hr' || id.startsWith('hr_') || id.startsWith('hrbase_'))

/** 읽기 전용 묶음 — 조회는 되지만 아무것도 바꾸지 못한다. */
const READ_ONLY = ['access', 'view', 'download', 'export']

/**
 * 회사 생성 시 기본으로 만들어지는 역할 프리셋.
 * perms: resourceId → action 배열. '*' 는 전 자원에 적용.
 */
const PRESET_ROLES = [
  {
    name: '마스터',
    isSystem: true,
    describe: '모든 화면·기능 + 계정/권한 관리',
    perms: { '*': ACTIONS },
  },
  {
    name: '경리',
    isSystem: true,
    describe: '회계 업무 전반. 인사급여는 제외, 삭제 권한 없음',
    perms: Object.fromEntries(
      RESOURCE_IDS.map(id => {
        if (HR_RESOURCES.includes(id)) return [id, []]                    // 인사급여 차단
        if (id === 'settings') return [id, ['access', 'view']]
        // 삭제는 마스터만 — 회계 데이터 삭제는 되돌리기 어렵다
        return [id, ['access', 'view', 'create', 'edit', 'upload', 'download', 'export']]
      })
    ),
  },
  {
    name: '조회전용',
    isSystem: true,
    describe: '전 화면 조회·출력만 가능. 등록/수정/삭제 불가',
    perms: Object.fromEntries(RESOURCE_IDS.map(id => [id, READ_ONLY])),
  },
]

/** 프리셋의 '*' 를 실제 자원 목록으로 펼친다. */
function expandPresetPerms(perms) {
  const out = []
  for (const [resource, actions] of Object.entries(perms)) {
    const targets = resource === '*' ? RESOURCE_IDS : [resource]
    for (const r of targets) for (const a of actions) out.push([r, a])
  }
  return out
}

module.exports = {
  ACTIONS, ACTION_LABELS, RESOURCES, RESOURCE_IDS,
  PRESET_ROLES, expandPresetPerms, READ_ONLY,
}
