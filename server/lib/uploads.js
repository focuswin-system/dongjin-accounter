/**
 * 업로드 파일 정리
 *
 * 첨부를 지우면 DB 행만 지우고 실제 파일은 uploads/{companyId}/ 에 그대로 남아 있었다.
 * 사용자는 지운 줄 알지만 서버 디스크에는 계약서·세금계산서가 계속 남는다 —
 * 시간이 지날수록 정리가 어려워지고, 개인정보·거래 정보가 의도치 않게 보존된다.
 *
 * ⚠ 멀티테넌트 주의
 * URL 은 DB에 저장된 값이라 그대로 믿고 경로를 만들면 안 된다.
 * `/uploads/{내 회사}/…` 형태인지 반드시 확인한 뒤에만 지운다. 확인하지 않으면
 * 조작된(또는 잘못 저장된) url 하나로 다른 회사 파일을 지울 수 있다.
 */
const fs = require('fs')
const path = require('path')

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads')

/**
 * 첨부 파일 하나를 디스크에서 지운다.
 * 실패해도 던지지 않는다 — 파일이 없다고 해서 DB 정리까지 막을 이유는 없다.
 *
 * @param {string} url        DB에 저장된 url (`/uploads/{companyId}/{파일명}`)
 * @param {string} companyId  요청자의 회사 id (필수)
 * @returns {boolean} 실제로 지웠으면 true
 */
function removeUploadedFile(url, companyId) {
  if (!url || !companyId) return false
  const prefix = `/uploads/${companyId}/`
  if (!String(url).startsWith(prefix)) return false      // 남의 회사 파일이거나 형식이 다르면 손대지 않는다

  const name = String(url).slice(prefix.length)
  // 경로 탈출 방지 — 파일명에 / 나 .. 가 들어오면 거부
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return false

  const full = path.join(UPLOAD_ROOT, companyId, name)
  // 최종 확인: 해석된 경로가 그 회사 폴더 안인가
  const companyDir = path.join(UPLOAD_ROOT, companyId)
  if (!full.startsWith(companyDir + path.sep)) return false

  try {
    fs.unlinkSync(full)
    return true
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[첨부 삭제 실패]', full, e.message)
    return false
  }
}

/** 여러 개를 한 번에. 지운 개수를 돌려준다. */
function removeUploadedFiles(urls, companyId) {
  let n = 0
  for (const u of urls || []) if (removeUploadedFile(u, companyId)) n++
  return n
}

module.exports = { removeUploadedFile, removeUploadedFiles }
