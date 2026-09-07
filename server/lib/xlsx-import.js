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
/* 파일을 잘못 고르는 일은 흔하다. 그때 무슨 일이 나는지 실측했다(2026-09-07):
 *   ·txt / 빈 파일  → 200 "행 0건"  ... 왜 비었는지 알 길이 없다
 *   ·깨진 xlsx      → 500 "처리 중 오류" ... 사용자 잘못인데 서버 탓처럼 보이고 error_logs 가 쌓인다
 *   ·PDF            → 200 "행 1건"  ... **쓰레기 바이트를 표로 읽어** 미리보기에 올렸다
 * 세 경우 다 "엑셀이 아니다" 한마디면 끝나는 일이다. 임포트 라우트가 네 곳이라
 * (거래내역·거래처·청구서·기준정보) 판정은 여기 한 곳에만 둔다.
 *
 * ⚠ 확장자만 보지 않는다 — 이름은 .xlsx 인데 내용이 PDF 인 파일이 실제로 걸렸다.
 *   앞머리 몇 바이트(서명)로 가른다: xlsx/xlsm 은 zip(PK), xls 는 OLE, 나머지는 글자(CSV)로 본다. */
class ImportFormatError extends Error {
  /* ⚠ status 와 **expose** 를 함께 단다. index.js 의 전역 처리기는 4xx 를 존중하지만,
     expose 가 없으면 문장을 삼키고 "요청을 처리할 수 없어요"라는 일반 문구로 바꾼다 —
     어느 파일이 왜 안 되는지 말해주려고 만든 오류인데 그러면 뜻이 사라진다.
     라우트 네 곳(거래내역·거래처·청구서·기준정보)은 그대로 next(e) 만 하면 된다. */
  constructor(message) {
    super(message)
    this.name = 'ImportFormatError'
    this.status = 400
    this.expose = true
  }
}

const startsWith = (buf, bytes) =>
  buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b)

/** 표로 읽을 수 있는 파일인가. 아니면 왜 아닌지 문장으로 던진다. */
function assertTabular(buffer) {
  if (!buffer || !buffer.length) {
    throw new ImportFormatError('빈 파일이에요. 내용이 있는 엑셀 파일을 올려주세요.')
  }
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) {           // %PDF
    throw new ImportFormatError('PDF 파일이에요. 엑셀(.xlsx) 이나 CSV 로 올려주세요.')
  }
  const isZip = startsWith(buffer, [0x50, 0x4b])                 // PK — xlsx·xlsm
  const isOle = startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0])     // 옛 .xls
  if (isZip || isOle) return

  /* 남은 건 글자 파일(CSV)일 때만 통과시킨다. 이미지·실행파일처럼 아무 바이트나
     들어오면 SheetJS 가 억지로 한 줄을 만들어 낸다(PDF 가 그랬다). */
  const head = buffer.subarray(0, Math.min(buffer.length, 4096))
  if (head.includes(0x00)) {
    throw new ImportFormatError('엑셀 파일이 아닌 것 같아요. .xlsx 또는 .csv 로 올려주세요.')
  }
}

function parseSheet(buffer) {
  assertTabular(buffer)
  let wb
  try {
    wb = xlsx.read(buffer, { type: 'buffer', cellDates: true })
  } catch {
    // 서명은 맞는데 내용이 깨진 파일 — 서버 오류(500)가 아니라 파일 문제(400)다
    throw new ImportFormatError('엑셀 파일을 열지 못했어요. 파일이 깨졌는지 확인해주세요.')
  }
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) throw new ImportFormatError('시트가 없는 파일이에요. 양식을 내려받아 채워서 올려주세요.')

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

module.exports = { uploadMem, parseSheet, MAX_ROWS, ImportFormatError }
