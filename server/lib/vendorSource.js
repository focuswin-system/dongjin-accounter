/**
 * 거래처 원본이 **이 앱 밖**에 있는 회사를 위한 끼움 자리 — 제품 중립.
 *
 * 대부분의 회사는 거래처 원본이 회계 vendors 표다. 그런데 어떤 고객사는 다른 시스템(예: 동진테크 MES)의
 * 거래처 표를 원본으로 쓴다. 그 회사에서는
 *   · 목록을 읽기 전에 바깥 원본의 바뀐 것을 끌어오고(beforeVendorRead)
 *   · 회계에서 바꾼 뒤에는 바깥 원본에 바로 쓴다(afterVendorWrite)
 *   · 지우기는 바깥 원본이 허락하는 방식으로 바꾼다(vendorDeleteOverride)
 *
 * 공통 코드(routes/vendors.js)는 **누가 끼워졌는지 모른다.** 끼우는 쪽(고객사 전용 모듈의 입구 라우터)이
 * registerVendorSource 로 등록하고, applies(req) 로 '이 요청의 회사가 내 담당인가'를 스스로 답한다.
 * 끼워진 게 없으면 아래 함수들은 아무 일도 안 한다 — 다른 회사는 달라지는 게 없다.
 *
 * 설계: docs/02-design/features/dongjin-custom-module.design.md
 */
const sources = []

/** @param {{ applies(req):Promise<boolean>, pull(db, opts?), push(db, ids), remove(db, id) }} source */
function registerVendorSource(source) {
  if (!sources.includes(source)) sources.push(source)
}

async function sourceFor(req) {
  for (const s of sources) if (await s.applies(req)) return s
  return null
}

/** 목록·상세를 읽기 전 — 바깥 원본의 바뀐 것을 끌어온다.
 *  끌어오기가 실패해도(바깥 시스템 점검 등) 읽기는 막지 않는다 — 마지막으로 맞춘 짝 행을 보여 준다.
 *  거래처 목록은 청구서·거래 등록마다 부르니, 여기서 500 을 내면 회계 전체가 멈춘다(검토에서 잡힘). */
async function beforeVendorRead(req) {
  const s = await sourceFor(req)
  if (!s) return
  try { await s.pull(req.db) }
  catch (e) { console.warn('[vendorSource] 끌어오기 실패 — 마지막 값으로 보여 줌:', e.code || e.message) }
}

/** 회계에서 거래처를 만들거나 고친 뒤 — 바깥 원본에 쓴다. 실패하면 오류로 올린다(원본이 밖이라 조용히 넘기면 안 된다) */
async function afterVendorWrite(req, ids) {
  const s = await sourceFor(req)
  if (s) await s.push(req.db, (ids || []).filter(Boolean))
}

/** 지우기 대신 할 일이 있으면 그 결과(응답 본문), 없으면 null — 평소대로 지운다 */
async function vendorDeleteOverride(req, id) {
  const s = await sourceFor(req)
  return s ? s.remove(req.db, id) : null
}

module.exports = { registerVendorSource, beforeVendorRead, afterVendorWrite, vendorDeleteOverride }
