/**
 * 첨부 파일 종류 — 받는 형식·미리보기 갈래·휴대폰 사진(HEIC) 변환. 판정은 **확장자**로 한다
 * (서버 routes/uploads.js · lib/attachments.js 와 같은 기준 — 브라우저가 붙이는 type 은 믿을 수 없다).
 * 설계: popup-attachments-print §3-3, §8
 */

/* 올릴 수 있는 형식 — 파일 고르기 창(accept)에 쓴다. HEIC 는 여기서 받고 올리기 전에 JPG 로 바꾼다
   (서버는 여전히 jpg 로 받는다 — 서버 허용 목록은 넓히지 않았다) */
export const UPLOAD_ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.xlsx,.xls,.docx,.hwp'

const extOf = (name) => (/\.([a-z0-9]+)(?:$|\?)/i.exec(String(name || '')) || [])[1]?.toLowerCase() || ''

/** 'image' | 'pdf' | 'file' — 미리보기 갈래 */
export function fileKind(nameOrUrl) {
  const e = extOf(nameOrUrl)
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(e)) return 'image'
  if (e === 'pdf') return 'pdf'
  return 'file'
}

const isHeic = (file) => /\.(heic|heif)$/i.test(file?.name || '') || /image\/hei[cf]/i.test(file?.type || '')

/* 캔버스 → JPEG. 품질 0.9 — 영수증 글자가 뭉개지지 않는 선 */
const canvasToJpeg = (canvas) => new Promise((resolve, reject) =>
  canvas.toBlob(b => (b ? resolve(b) : reject(new Error('jpeg'))), 'image/jpeg', 0.9))

/**
 * 올리기 직전 손질 — 지금은 HEIC → JPEG 하나.
 * 1) 브라우저가 스스로 풀 수 있으면(사파리) 그걸로 — 라이브러리보다 최신 아이폰 형식에 강하다
 * 2) 못 풀면 heic2any(고를 때만 불러온다 — 평소 번들 무게 없음)
 * 실패는 사람이 알아듣는 말로 던진다 — 조용히 원본을 올리면 서버가 확장자로 거절해 '업로드 실패'만 남는다.
 */
export async function toUploadable(file) {
  if (!isHeic(file)) return file
  const jpgName = file.name.replace(/\.(heic|heif)$/i, '') + '.jpg'
  try {
    const bmp = await createImageBitmap(file)
    const c = document.createElement('canvas')
    c.width = bmp.width; c.height = bmp.height
    c.getContext('2d').drawImage(bmp, 0, 0)
    bmp.close?.()
    return new File([await canvasToJpeg(c)], jpgName, { type: 'image/jpeg' })
  } catch { /* 이 브라우저는 HEIC 를 못 푼다 — 라이브러리로 */ }
  try {
    const { default: heic2any } = await import('heic2any')
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 })
    return new File([Array.isArray(out) ? out[0] : out], jpgName, { type: 'image/jpeg' })
  } catch {
    throw new Error('이 사진을 읽지 못했어요. 휴대폰에서 JPG 로 저장해 올려 주세요.')
  }
}
