// 엑셀·CSV 일괄 업로드 공용 파서.
// 거래처(vendors)·기준정보(ref-items) 등 임포트 기능이 늘어날 때마다 같은 파싱 코드를
// 복사하지 않도록 여기 한 곳에 둔다. 라우터는 이 모듈의 uploadMem·parseSheet만 쓴다.
const multer = require('multer')
const xlsx = require('xlsx')

// 파일은 디스크에 남기지 않는다 — 임포트는 파싱 즉시 JSON으로 바뀌고 버려지므로
// 테넌트별 uploads 디렉터리를 오염시킬 이유가 없다.
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

// 미리보기로 돌려주는 최대 행 수. 넘으면 truncated를 함께 주어 화면이 "잘렸다"고 알리게 한다.
// (조용히 자르면 사용자는 전부 올라간 줄 안다.)
const MAX_ROWS = 5000

// 첫 시트를 머리글 + 행 배열로 변환한다.
//   raw:false      — 숫자·날짜를 엑셀 표시 문자열 그대로 받는다(금액 콤마 등은 화면에서 정리)
//   cellDates:true — 날짜 셀을 시리얼 숫자가 아닌 날짜로 읽는다
function parseSheet(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) return { headers: [], rows: [], total: 0, truncated: false }

  const json = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false })
  // 값이 하나도 없는 행(엑셀 하단 빈 줄)은 버린다 — 미리보기에서 '상호명 없음' 오류로 잡히면 지저분하다
  const rows = json.filter(r => Object.values(r).some(v => String(v ?? '').trim() !== ''))
  const headers = rows.length ? Object.keys(rows[0]) : (json.length ? Object.keys(json[0]) : [])

  return {
    headers,
    rows: rows.slice(0, MAX_ROWS),
    total: rows.length,
    truncated: rows.length > MAX_ROWS,
  }
}

module.exports = { uploadMem, parseSheet, MAX_ROWS }
