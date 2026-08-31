/**
 * 양식 신청함의 말 — **고객 라우터(routes/template-requests.js)와 운영 콘솔
 * (routes/admin.js)이 함께 쓰는 정의.**
 *
 * 두 곳이 각자 상태 문자열을 적어 두면 언젠가 한쪽만 늘어난다. 그러면 콘솔에서
 * 바꾼 상태가 고객 화면에서는 이름 없는 값으로 보인다 — 그래서 여기 한 곳에 둔다.
 *
 * ⚠ **신청은 계약이 아니다.** 상태가 '완료'가 되어도 아무것도 안 열린다.
 *   여는 것은 사람이 콘솔 기능 탭에서 company_features 를 켜는 별도의 손이다.
 */

const KINDS = new Set(['report', 'doc'])

/** 고객에게 그대로 보이는 진행 단계 — 감감무소식이면 같은 걸 또 신청한다. */
const STATUS = {
  received:  '접수됨',
  reviewing: '검토 중',
  building:  '만드는 중',
  done:      '완료',
  hold:      '보류',
}
const STATUS_IDS = Object.keys(STATUS)

/**
 * 첨부 목록 정리 — 화면이 준 것을 그대로 믿지 않는다.
 *
 * ⚠ url 은 **그 회사 폴더 안의 파일 하나**여야 한다. 다른 모양은 버린다.
 *   콘솔이 나중에 이 경로로 디스크를 읽으므로(routes/admin.js), 여기가 새면
 *   그게 곧 남의 회사 파일을 읽는 길이 된다. 검증은 저장할 때와 읽을 때 **양쪽에서** 한다.
 */
function cleanFiles(raw, companyId) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const f of raw.slice(0, 10)) {          // 열 개면 충분하다
    const url = String(f?.url || '')
    const name = fileNameOf(url, companyId)
    if (!name) continue
    out.push({ url, name: String(f?.name || name).slice(0, 200), size: Number(f?.size) || 0 })
  }
  return out
}

/**
 * `/uploads/<companyId>/<파일이름>` 에서 파일 이름만 꺼낸다. 모양이 다르면 null.
 * 경로 구분자·상위 이동(..)이 섞이면 버린다 — 여기가 경로 탈출을 막는 자리다.
 */
function fileNameOf(url, companyId) {
  const prefix = `/uploads/${companyId}/`
  const s = String(url || '')
  if (!s.startsWith(prefix)) return null
  const name = s.slice(prefix.length)
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null
  return name
}

module.exports = { KINDS, STATUS, STATUS_IDS, cleanFiles, fileNameOf }
