/**
 * 서식 있는 엑셀 — 이 앱의 모든 내려받기가 같은 얼굴을 갖게 하는 공용 도구.
 *
 * ── 왜 필요한가 ──
 * 내려받기가 곳곳에 흩어져 있었고 대부분 `xlsx`(SheetJS)로 만들었다. 그건 값만 넣는 데엔
 * 충분하지만 **셀 서식을 못 넣는다**(커뮤니티 판에 스타일 API가 없다). 그래서
 *   · 금액이 `1165939932` 로 찍혀 사람이 자릿수를 센다
 *   · 머리글이 본문과 구별되지 않아 어디부터 데이터인지 눈으로 찾는다
 *   · 열 폭이 안 맞아 날짜가 `#####` 로 나온다
 * 이 파일들은 대표·세무사에게 그대로 건네는 문서다. 그 상태로는 못 쓴다.
 *
 * exceljs 는 이미 의존성에 있다. 여기 규칙은 lib/loanWorkbook.js 가 먼저 세운 것을
 * 그대로 따른다 — 같은 회사가 낸 문서가 시트마다 다른 얼굴이면 안 된다.
 *
 * ── 서식 규칙(장식이 아니라 읽는 속도를 위한 것) ──
 *   · 금액: 천단위 구분 + 0은 '-'. 0을 그대로 두면 자릿수 착시가 난다
 *   · 머리글: 굵게 + 옅은 바탕 + 아래 테두리 + 틀 고정
 *   · 합계: 굵게 + 위쪽 실선(회계에서 합계선의 뜻)
 *   · 숫자는 오른쪽, 날짜는 **문자열로 고정** — 로캘에 따라 3/4가 3월 4일도 4월 3일도 된다
 */

const ExcelJS = require('exceljs')

// 0을 '-' 로 두는 회계 표기(loanWorkbook 과 같은 값)
const MONEY = '#,##0;-#,##0;"-"'
const INT = '#,##0'

const INK = 'FF1A1A1A'
const HEAD_BG = 'FFF2F4F7'
const LINE = 'FFD0D5DD'
const SUB = 'FF667085'

const headerStyle = (cell) => {
  cell.font = { bold: true, color: { argb: INK }, size: 10 }
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } }
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  cell.border = { bottom: { style: 'thin', color: { argb: LINE } } }
}

/** 합계·소계 행 — 굵게, 위쪽 실선. double 이면 겹선(최종 합계). */
const totalStyle = (row, { double = false } = {}) => {
  row.eachCell({ includeEmpty: true }, (c) => {
    c.font = { bold: true, color: { argb: INK }, size: 10 }
    c.border = { top: { style: double ? 'double' : 'thin', color: { argb: INK } } }
  })
}

/** 제목 줄 — 파일만 받아 본 사람이 무엇인지 알 수 있어야 한다. 표가 시작될 행을 돌려준다. */
function titleBlock(ws, { title, sub, span }) {
  ws.mergeCells(1, 1, 1, span)
  const t = ws.getCell(1, 1)
  t.value = title
  t.font = { bold: true, size: 14, color: { argb: INK } }
  t.alignment = { vertical: 'middle' }
  ws.getRow(1).height = 24

  ws.mergeCells(2, 1, 2, span)
  const s = ws.getCell(2, 1)
  s.value = sub || ''
  s.font = { size: 9, color: { argb: SUB } }
  ws.getRow(3).height = 6            // 제목과 표 사이 숨 쉴 자리
  return 4                            // 머리글이 놓일 행
}

/** 표 머리글을 그린다. */
function putHeader(ws, rowNo, labels) {
  const row = ws.getRow(rowNo)
  labels.forEach((label, i) => { row.getCell(i + 1).value = label })
  row.eachCell({ includeEmpty: false }, headerStyle)
  row.height = 20
  return rowNo
}

/**
 * 표 한 장을 통째로 그린다 — 이 앱의 내려받기 대부분이 이 모양이다.
 *
 * @param wb            ExcelJS.Workbook
 * @param name          시트 이름
 * @param opts.title    제목(없으면 시트 이름)
 * @param opts.sub      부제(기간·건수 등 — 무엇을 뽑은 것인지)
 * @param opts.columns  [{ header, width, money?, int?, align?, key? }]
 * @param opts.rows     값 배열의 배열(columns 순서와 같아야 한다)
 * @param opts.totals   합계 행(값 배열). 있으면 굵게 + 위쪽 겹선
 * @param opts.freezeCols 왼쪽에서 몇 열을 함께 고정할지(날짜·이름처럼 계속 봐야 하는 열)
 */
function sheet(wb, name, { title, sub, columns, rows, totals = null, freezeCols = 0 }) {
  const span = columns.length
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 4, xSplit: freezeCols }],
    pageSetup: { orientation: span > 7 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })
  ws.columns = columns.map(c => ({ width: c.width || 14 }))

  const headRow = titleBlock(ws, { title: title || name, sub, span })
  putHeader(ws, headRow, columns.map(c => c.header))

  rows.forEach((r, i) => {
    const row = ws.getRow(headRow + 1 + i)
    r.forEach((v, ci) => { row.getCell(ci + 1).value = v })
    row.height = 18
  })

  // 숫자 서식·정렬은 열 단위로 — 행마다 걸면 빈 행에서 서식이 끊긴다
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1)
    if (c.money) { col.numFmt = MONEY; col.alignment = { horizontal: 'right' } }
    else if (c.int) { col.numFmt = INT; col.alignment = { horizontal: 'right' } }
    else if (c.align) col.alignment = { horizontal: c.align }
  })

  if (totals) {
    const row = ws.getRow(headRow + 1 + rows.length)
    totals.forEach((v, ci) => { row.getCell(ci + 1).value = v })
    totalStyle(row, { double: true })
    row.height = 20
  }

  /* 자동 필터 — 받은 사람이 바로 걸러 볼 수 있게. 표가 비면 걸지 않는다
     (엑셀이 머리글만 있는 필터를 깨진 것으로 표시한다). */
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: headRow, column: 1 }, to: { row: headRow + rows.length, column: span } }
  }
  return ws
}

/**
 * 업로드 양식 시트 — **채워서 다시 올릴** 파일이다. 읽는 문서와 요구가 다르다.
 *
 *   · 예시 행은 **지워야 할 것**임이 보여야 한다. 그냥 두면 예시를 그대로 올린다
 *     (실제로 'SW-001 그룹웨어 구축'이 품목으로 등록된 적이 있다) → 기울임 + 회색
 *   · 필수 칸은 갈려야 한다 → **색으로만** 표시한다(아래 ⚠ 참고)
 *   · 제목·부제 줄을 넣지 않는다. 위에 뭐가 붙어 있으면 **파싱 시작 행이 밀린다** —
 *     읽는 쪽(lib/xlsx-import.js)은 첫 행을 머리글로 본다
 *
 * ⚠ **머리글 글자를 건드리지 않는다.** '상호명 *' 처럼 별표를 붙이면 왕복이 깨진다 —
 *   받아서 채워 올릴 때 화면의 자동 매칭(`guess(h)`)이 공백을 지우고 이름으로 맞추는데,
 *   '상호명*' 은 '상호명' 과 다른 글자가 된다. 사용자는 열세 칸을 손으로 다시 이어야 한다.
 *   양식은 **그대로 돌아올 파일**이라, 사람에게 보이는 표시는 값이 아니라 서식으로만 준다.
 *
 * @param opts.columns [{ header, width, required? }]
 * @param opts.samples 예시 행(값 배열). 비워도 된다
 */
function templateSheet(wb, name, { columns, samples = [] }) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = columns.map(c => ({ width: c.width || 16 }))

  const head = ws.getRow(1)
  columns.forEach((c, i) => {
    const cell = head.getCell(i + 1)
    cell.value = c.header                      // ⚠ 글자는 그대로. 위 주석 참고
    cell.font = { bold: true, color: { argb: c.required ? 'FFFFFFFF' : INK }, size: 10 }
    cell.fill = { type: 'pattern', pattern: 'solid',
      fgColor: { argb: c.required ? 'FFB42318' : HEAD_BG } }   // 필수는 바탕을 뒤집는다
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = { bottom: { style: 'thin', color: { argb: LINE } } }
  })
  head.height = 22

  samples.forEach((r, ri) => {
    const row = ws.getRow(2 + ri)
    r.forEach((v, ci) => {
      const cell = row.getCell(ci + 1)
      cell.value = v
      cell.font = { italic: true, color: { argb: 'FF98A2B3' }, size: 10 }
    })
    row.height = 18
  })
  return ws
}

/**
 * 구획이 섞인 시트 — 자금관리표처럼 **한 장 안에 표가 여럿**인 문서.
 *
 * 위 `sheet()` 는 '머리글 한 줄 + 데이터'인 표를 그린다. 그런데 대표가 보던 엑셀 양식은
 * 구획 제목·머리글·데이터·합계·주석이 한 장에 번갈아 선다. 그 모양을 바꾸지 않고
 * (양식을 그대로 쓰는 게 이 문서의 값어치다) 서식만 입힌다.
 *
 * ⚠ 역할을 **명시해서** 받는다. '첫 칸이 합계면 합계 줄'처럼 짐작하면 반드시 틀린다 —
 *   '합계'라는 거래처가 있을 수도 있고, 구획 제목이 한 칸짜리가 아닐 수도 있다.
 *
 * @param opts.rows [{ kind, cells, money }] — kind: section|head|data|total|note|blank
 *        줄에 `money` 를 적으면 그 줄에만 쓰는 금액 열 번호가 된다(시트 기본값을 덮는다)
 * @param opts.widths 열 폭 배열
 * @param opts.money  금액인 열 번호(0-based) 배열. data·total 줄에만 건다
 */
function blockSheet(wb, name, { title, sub, rows, widths = [], money = [] }) {
  const span = Math.max(widths.length, ...rows.map(r => (r.cells || []).length), 1)
  const ws = wb.addWorksheet(name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31), {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })
  ws.columns = Array.from({ length: span }, (_, i) => ({ width: widths[i] || 14 }))

  let rowNo = titleBlock(ws, { title, sub, span })
  const moneySet = new Set(money)

  for (const r of rows) {
    const row = ws.getRow(rowNo++)
    if (r.kind === 'blank') { row.height = 8; continue }
    ;(r.cells || []).forEach((v, i) => { row.getCell(i + 1).value = v })

    if (r.kind === 'section') {
      // 구획 제목 — 이 장이 어디서 갈리는지. 위에 숨 쉴 자리를 주고 굵게.
      row.getCell(1).font = { bold: true, size: 11, color: { argb: INK } }
      row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EBF0' } }
      row.height = 22
    } else if (r.kind === 'head') {
      row.eachCell({ includeEmpty: false }, headerStyle)
      row.height = 20
    } else if (r.kind === 'total') {
      totalStyle(row)
      row.height = 19
    } else if (r.kind === 'note') {
      row.getCell(1).font = { size: 9, italic: true, color: { argb: SUB } }
      row.height = 16
    } else {
      row.height = 18
    }

    /* 금액 서식은 줄 단위로 — 열 단위로 걸면 구획마다 열의 뜻이 달라 엉뚱한 칸이 잡힌다.
       실제로 자금관리표에서 다섯째 칸이 계좌 구획에선 '나갈 건수', 요약 구획에선 '나갈 돈'이었다.
       금액이 아닌 숫자(건수)도 천단위는 넣는다 — 서식이 없으면 왼쪽에 붙어 표가 어긋난다. */
    if (r.kind === 'data' || r.kind === 'total') {
      const cols = r.money ? new Set(r.money) : moneySet
      ;(r.cells || []).forEach((v, i) => {
        if (typeof v !== 'number') return
        const c = row.getCell(i + 1)
        c.numFmt = cols.has(i) ? MONEY : INT
        c.alignment = { horizontal: 'right' }
      })
    }
  }
  return ws
}

/** 안내 시트 — 무엇을 어떻게 읽는 파일인지. 받은 사람이 우리에게 되묻지 않게 한다.
 *  @param opts.hasRequired 업로드 양식이면 true — 필수 칸 표시를 읽는 법을 맨 앞에 얹는다
 *         (머리글에 별표를 못 붙이므로 색의 뜻을 어딘가에서 알려야 한다) */
function guideSheet(wb, lines, name = '작성안내', { hasRequired = false } = {}) {
  if (hasRequired) {
    lines = [lines[0], '',
      '• 머리글이 빨간 칸은 필수입니다 — 비우면 그 줄은 등록되지 않습니다.',
      '• 회색 기울임으로 적힌 예시 줄은 지우고 쓰세요. 그대로 두면 예시가 등록됩니다.',
      ...lines.slice(1)]
  }
  const ws = wb.addWorksheet(name)
  ws.columns = [{ width: 96 }]
  lines.forEach((line, i) => {
    const c = ws.getCell(i + 1, 1)
    c.value = line
    c.font = i === 0 ? { bold: true, size: 12, color: { argb: INK } } : { size: 10, color: { argb: SUB } }
    c.alignment = { vertical: 'middle', wrapText: true }
  })
  return ws
}

const newBook = () => {
  const wb = new ExcelJS.Workbook()
  wb.creator = '도니도라'
  wb.created = new Date()
  return wb
}

/** 응답으로 내보낸다 — 파일명 한글은 RFC 5987 로(브라우저가 깨뜨리지 않게). */
async function sendBook(res, wb, filename) {
  const buf = await wb.xlsx.writeBuffer()
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition',
    `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(Buffer.from(buf))
}

module.exports = { newBook, sheet, blockSheet, templateSheet, guideSheet, sendBook, titleBlock, putHeader, totalStyle, MONEY, INT }
