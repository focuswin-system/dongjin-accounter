/**
 * 증빙 충족 판정 — "이 건은 증빙이 필요한가" 와 "그 증빙을 받았나"를 한 곳에서 답한다.
 *
 * ── 왜 lib 인가 ──
 * 정기청구·정기지출·거래내역·청구서 네 화면이 같은 질문을 한다. 각자 판정하면
 * 한 화면에서는 '완료'인데 다른 화면에서는 '미비'로 보이고, 그러면 둘 다 못 믿는다.
 *
 * ── 두 가지 방식을 모두 받는 이유 ──
 * 파일 유무만으로 판정하면 **종이 증빙을 쓰는 회사는 영원히 '미비'로 남는다.** 원본이
 * 우편으로 오고 파일로는 안 만드는 곳이 아직 많고, 그런 곳에서 '미비 12건'이 계속 떠 있으면
 * 그 목록은 아무도 안 본다. 그래서 확인 체크로도 닫을 수 있게 한다.
 *
 * 반대로 체크만 두면 파일을 붙여 놓고도 따로 체크해야 해서 두 번 일하게 된다.
 * 그래서 **파일이 있으면 자동 충족**이고, 체크는 파일이 없을 때 쓰는 문이다.
 *
 * ⚠ 이건 '적격증빙 판정'이 아니다. 부가세 매입세액 공제 가능 여부는 증빙 **유형**
 *   (ref_items type='evidence_type' 의 deductible)이 정한다. 여기서 답하는 건
 *   "챙길 서류를 챙겼나"라는 업무 진행 상태뿐이다. 둘을 섞으면 간이영수증을 받아 둔 건이
 *   '공제 가능'으로 읽힌다.
 */

const truthy = (v) => v === 1 || v === true || v === '1'

/** 증빙이 붙어 있는가 — 파일이 있거나, 사람이 확인했다고 표시했거나 */
const hasEvidence = ({ fileUrl, docCount, checked }) =>
  Boolean(String(fileUrl || '').trim()) || Number(docCount || 0) > 0 || truthy(checked)

/**
 * 한 건의 증빙 상태.
 *
 * @param required 이 건이 증빙을 요구하는가(규칙에서 내려온 값)
 * @returns 'ok'(챙김) | 'missing'(필요한데 없음) | 'none'(요구하지 않음)
 */
function evidenceState({ required, fileUrl, docCount, checked }) {
  if (hasEvidence({ fileUrl, docCount, checked })) return 'ok'
  return truthy(required) ? 'missing' : 'none'
}

/** 목록에 붙일 요약 — 화면이 다시 세지 않게 서버가 낸다 */
function evidenceSummary(rows) {
  let required = 0, ok = 0, missing = 0
  for (const r of rows) {
    const st = evidenceState(r)
    if (st === 'ok') ok++
    else if (st === 'missing') missing++
    if (truthy(r.required)) required++
  }
  return { required, ok, missing }
}

/** 증빙 유형이 매입세액 공제 대상인가 — ref_items(type='evidence_type').deductible 기준.
 *  유형을 안 적었으면 **모른다**(null). '아니오'로 단정하면 공제 가능한 건이 조용히 빠진다. */
async function deductibleOf(db, evidTypeName) {
  const name = String(evidTypeName || '').trim()
  if (!name) return null
  const [[row]] = await db.execute(
    "SELECT deductible FROM ref_items WHERE type='evidence_type' AND name = ? LIMIT 1", [name])
  return row ? Boolean(Number(row.deductible)) : null
}

module.exports = { evidenceState, evidenceSummary, hasEvidence, deductibleOf }
