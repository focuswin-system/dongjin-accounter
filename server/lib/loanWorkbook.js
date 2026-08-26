/**
 * 차입금 현황 엑셀 — 서식 있는 통합문서.
 *
 * ── 왜 exceljs 인가 ──
 * 다른 보고서는 `xlsx`(SheetJS) 로 만든다. 그건 값만 넣는 데엔 충분하지만
 * **셀 서식을 못 넣는다**(커뮤니티 판에는 스타일 API가 없다). 그래서 열 폭만 맞춘
 * 맨 표가 나오고, 금액이 `1165939932` 로 찍혀 사람이 자릿수를 세야 한다.
 * 이 파일은 대표·세무사에게 그대로 건네는 문서라 그 상태로는 못 쓴다.
 * exceljs 는 이미 의존성에 있다(변경 이력 내려받기에서 쓴다).
 *
 * ── 서식 규칙 ──
 * 회계 문서의 관례를 따른다. 장식이 아니라 **읽는 속도**를 위한 것이다.
 *   · 금액은 천단위 구분 + 0은 '-' (0을 그대로 두면 자릿수 착시가 난다)
 *   · 머리글은 굵게 + 옅은 바탕 + 아래 테두리, 틀 고정
 *   · 합계·소계는 굵게 + 위쪽 실선(회계에서 합계선의 뜻)
 *   · 숫자 열은 오른쪽, 날짜는 문자열로 고정(로캘에 따라 해석이 갈리는 걸 피한다)
 */

const ExcelJS = require('exceljs')
const { METHOD_LABEL } = require('./loanReport')

/* 0을 '-' 로 두는 회계 표기. 빈 칸으로 두면 "안 적은 것"과 구별이 안 되고,
   0 으로 두면 숫자가 빽빽해져 실제 금액이 안 보인다. */
const MONEY = '#,##0;-#,##0;"-"'
const RATE = '0.000"%"'

const INK = 'FF1A1A1A'
const HEAD_BG = 'FFF2F4F7'
const LINE = 'FFD0D5DD'

const headerStyle = (cell) => {
  cell.font = { bold: true, color: { argb: INK }, size: 10 }
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_BG } }
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  cell.border = { bottom: { style: 'thin', color: { argb: LINE } } }
}

/** 합계·소계 행 — 굵게, 위쪽 실선. 회계에서 그 선이 '여기서 더했다'는 뜻이다. */
const totalStyle = (row, { double = false } = {}) => {
  row.eachCell({ includeEmpty: true }, (c) => {
    c.font = { bold: true, color: { argb: INK }, size: 10 }
    c.border = { top: { style: double ? 'double' : 'thin', color: { argb: INK } } }
  })
}

/** 제목 줄 — 시트 맨 위. 파일만 받아 본 사람이 무엇인지 알 수 있어야 한다. */
function titleBlock(ws, { title, sub, span }) {
  ws.mergeCells(1, 1, 1, span)
  const t = ws.getCell(1, 1)
  t.value = title
  t.font = { bold: true, size: 14, color: { argb: INK } }
  t.alignment = { vertical: 'middle' }
  ws.getRow(1).height = 24

  ws.mergeCells(2, 1, 2, span)
  const s = ws.getCell(2, 1)
  s.value = sub
  s.font = { size: 9, color: { argb: 'FF667085' } }
  ws.getRow(3).height = 6            // 제목과 표 사이 숨 쉴 자리
}

/** 표 머리글을 그리고 그 행 번호를 돌려준다. 아래에서 틀 고정 기준으로 쓴다. */
function putHeader(ws, rowNo, labels) {
  const row = ws.getRow(rowNo)
  labels.forEach((label, i) => { row.getCell(i + 1).value = label })
  row.eachCell({ includeEmpty: false }, headerStyle)
  row.height = 20
  return rowNo
}

const setWidths = (ws, widths) => { ws.columns = widths.map(w => ({ width: w })) }

/** 금액 열에 서식을 건다(1-based 열 번호 배열) */
function moneyCols(ws, cols, fromRow) {
  for (const c of cols) {
    ws.getColumn(c).numFmt = MONEY
    ws.getColumn(c).alignment = { horizontal: 'right' }
  }
  void fromRow
}

/**
 * @param d      lib/loanReport.js 의 결과
 * @param opts.today   기준일 문자열
 * @param opts.scope   '진행 중' 같은 범위 이름
 * @param opts.loanName 고른 범위 이름(한 건이면 그 이름, 여럿이면 'N건 선택', 전체면 null)
 * @param opts.period   상환 내역을 자른 구간 {from,to}. 파일만 받아 본 사람이
 *                      "왜 3월 상환이 없지"를 묻지 않게, 자른 사실을 표지에 남긴다
 */
function buildLoanWorkbook(d, { today, scope, loanName = null, period = null }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = '도니도라'
  wb.created = new Date(`${today}T00:00:00Z`)

  /* 구간을 적을 때 **'상환 내역 구간'이라고 못 박는다.** 그냥 날짜만 적으면
     차입금 목록까지 그 기간 것이라고 읽는다 — 목록은 자르지 않는다(lib/loanReport.js). */
  const periodText = period && (period.from || period.to)
    ? `상환 내역 ${period.from || '처음'} ~ ${period.to || '오늘'}`
    : null
  const subOf = (extra) =>
    [`기준일 ${today}`, `범위 ${scope}`, loanName ? `계좌 ${loanName}` : null, periodText, extra]
      .filter(Boolean).join('   ·   ')

  /* ── 1. 차입처별 요약 ── */
  {
    const ws = wb.addWorksheet('차입처별 요약', { views: [{ state: 'frozen', ySplit: 5 }] })
    setWidths(ws, [26, 8, 17, 17, 17, 16])
    titleBlock(ws, { title: '차입금 현황', sub: subOf(null), span: 6 })
    const h = putHeader(ws, 4, ['차입처', '건수', '차입원금', '상환원금', '남은원금', '지급이자'])
    for (const g of d.byLender) {
      ws.addRow([g.lender, g.count, g.principal, g.repaidPrincipal, g.remaining, g.repaidInterest])
    }
    const t = ws.addRow(['합계', d.totals.count, d.totals.principal, d.totals.repaidPrincipal,
                         d.totals.remaining, d.totals.repaidInterest])
    totalStyle(t, { double: true })
    moneyCols(ws, [3, 4, 5, 6], h + 1)
    ws.getColumn(2).alignment = { horizontal: 'center' }

    ws.addRow([])
    const note = ws.addRow(['※ 남은원금 = 차입원금 − 상환원금. 지급이자는 이미 나간 비용이라 남은원금에 더하지 않습니다.'])
    note.getCell(1).font = { size: 9, color: { argb: 'FF667085' } }
  }

  /* ── 2. 차입금(계좌) 목록 ── */
  {
    const ws = wb.addWorksheet('차입금 목록', { views: [{ state: 'frozen', ySplit: 5, xSplit: 2 }] })
    setWidths(ws, [18, 36, 12, 12, 17, 16, 17, 15, 10, 12, 9, 18, 10])
    titleBlock(ws, { title: '차입금(계좌)별 현황', sub: subOf(`${d.loans.length}건`), span: 13 })
    const h = putHeader(ws, 4, ['차입처', '차입금명(계좌)', '차입일', '만기일', '차입원금',
      '상환원금', '남은원금', '지급이자', '연이율', '상환방식', '기간(월)', '상환계좌', '상태'])
    for (const l of d.loans) {
      ws.addRow([l.lender, l.name, l.startDate, l.endDate,
        l.principal, l.repaidPrincipal, l.remaining, l.repaidInterest,
        // 이율 0은 빈 칸 — '0%'로 찍으면 무이자로 읽힌다
        l.annualRate || null,
        METHOD_LABEL[l.method] || l.method,
        l.termMonths || null,
        l.accountName, l.status === 'active' ? '진행 중' : '상환 완료'])
    }
    const t = ws.addRow(['합계', '', '', '', d.totals.principal, d.totals.repaidPrincipal,
                         d.totals.remaining, d.totals.repaidInterest])
    totalStyle(t, { double: true })
    moneyCols(ws, [5, 6, 7, 8], h + 1)
    ws.getColumn(9).numFmt = RATE
    ws.getColumn(11).alignment = { horizontal: 'center' }
    ws.autoFilter = { from: { row: h, column: 1 }, to: { row: h, column: 13 } }
  }

  /* ── 3. 계좌별 상환 내역 ──
   *
   * 날짜순 한 줄로 내면 계좌들의 회차가 뒤섞여, "이 계좌에 얼마 갚았나"를 사람이
   * 눈으로 골라야 한다. 계좌마다 묶고 **소계**를 붙인다. */
  {
    const ws = wb.addWorksheet('계좌별 상환내역', { views: [{ state: 'frozen', ySplit: 4 }] })
    setWidths(ws, [13, 18, 36, 8, 13, 16, 15, 16, 18])
    titleBlock(ws, { title: '계좌별 상환 내역', sub: subOf(`${d.repayments.length}건`), span: 9 })

    let r = 4
    for (const g of d.byLoan) {
      // 계좌 머리 — 어느 계좌 묶음인지, 그 계좌의 잔액이 얼마인지 한 줄로
      const head = ws.getRow(r)
      head.getCell(1).value = `${g.lender}  ›  ${g.loanName}`
      ws.mergeCells(r, 1, r, 5)
      head.getCell(6).value = '남은원금'
      head.getCell(7).value = g.remaining
      head.eachCell({ includeEmpty: false }, (c) => {
        c.font = { bold: true, size: 10, color: { argb: INK } }
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFBFC' } }
      })
      head.getCell(6).alignment = { horizontal: 'right' }
      head.getCell(7).numFmt = MONEY
      r += 1

      putHeader(ws, r, ['납부일', '차입처', '차입금명(계좌)', '회차', '예정일', '원금', '이자', '합계', '상환계좌'])
      r += 1

      if (!g.rows.length) {
        const empty = ws.getRow(r)
        empty.getCell(1).value = '상환 처리한 회차가 없습니다.'
        empty.getCell(1).font = { size: 9, italic: true, color: { argb: 'FF98A2B3' } }
        ws.mergeCells(r, 1, r, 9)
        r += 1
      } else {
        for (const x of g.rows) {
          const row = ws.getRow(r)
          row.values = [x.paidDate, x.lender, x.loanName, x.seq, x.dueDate,
                        x.principal, x.interest, x.total, x.accountName]
          for (const c of [6, 7, 8]) row.getCell(c).numFmt = MONEY
          row.getCell(4).alignment = { horizontal: 'center' }
          r += 1
        }
        const sub = ws.getRow(r)
        sub.values = ['소계', '', '', g.subtotal.count, '',
                      g.subtotal.principal, g.subtotal.interest, g.subtotal.total, '']
        for (const c of [6, 7, 8]) sub.getCell(c).numFmt = MONEY
        totalStyle(sub)
        r += 1
      }
      r += 1                                  // 묶음 사이 빈 줄 — 없으면 어디서 끊기는지 안 보인다
    }

    // 전체 합계 — 소계를 다 더한 값. 맨 아래에 한 번 더 둔다
    const t = ws.getRow(r)
    t.values = ['전체 합계', '', '', d.repayments.length, '',
      d.repayments.reduce((s, x) => s + x.principal, 0),
      d.repayments.reduce((s, x) => s + x.interest, 0),
      d.repayments.reduce((s, x) => s + x.total, 0), '']
    for (const c of [6, 7, 8]) t.getCell(c).numFmt = MONEY
    totalStyle(t, { double: true })
  }

  return wb
}

module.exports = { buildLoanWorkbook }
