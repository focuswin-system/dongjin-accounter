/* 주문 목록 엑셀(.xlsx) 생성 — 서식·요약까지 갖춘 실제 업무용 파일.
 * CSV는 열 너비도 숫자 서식도 없고 시트도 한 장뿐이라, 받아서 다시 손봐야 했다.
 *
 * 시트 3장:
 *   주문 목록  — 전체 주문 + 금액 지표. 상단에 요약(건수·주문금액·미수금·월 고정수입)
 *   갱신 관리  — 만료가 있는 주문만. 종료일 순 + D-day. 통보기한 지난 건이 위로.
 *   정기 주문  — 주기·주기당 금액·월 환산·초기 일시금·정기청구 연결 여부
 */
const ExcelJS = require('exceljs')

const BILLING = { onetime: '총액형', recurring: '정기형' }
const TERM = { fixed: '기간 만료', auto_renew: '자동갱신', open: '무기한' }
const PERIOD = { monthly: '월', quarterly: '분기', yearly: '년' }
const PERIOD_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 }

const MONEY = '#,##0'
const HEADER_FILL = 'FFF1F3F5'
const TITLE_COLOR = 'FF212529'

const daysLeft = (endDate, today) => {
  if (!endDate) return null
  const d = new Date(endDate); d.setHours(0, 0, 0, 0)
  if (isNaN(d)) return null
  return Math.round((d - today) / 86400000)
}

// 갱신 개념이 있는 주문만 = 자동갱신이거나 정기형.
// 총액형+기간만료(구축 프로젝트)는 끝나면 그냥 끝이라 '갱신 누락'이 아니다.
const isRenewable = (c) => c.term_mode !== 'open' &&
  (c.term_mode === 'auto_renew' || c.billing_mode === 'recurring')

/** 갱신 상태 한 줄 — 화면(renewal.js)과 같은 규칙 */
const renewalText = (c, today) => {
  if (c.term_mode === 'open') return '해당 없음 (무기한)'
  if (c.status === '완료' || c.status === '보류') return '해당 없음'
  const d = daysLeft(c.end_date, today)
  if (d === null) return '종료일 없음'
  if (!isRenewable(c)) return d < 0 ? `기간 종료 (${-d}일 경과 · 상태 정리 필요)` : '갱신 없는 단발 주문'
  const notice = Number(c.notice_days) >= 0 ? Number(c.notice_days) : 60
  const auto = c.term_mode === 'auto_renew'
  if (d < 0) return auto ? `연장 미입력 (${-d}일 경과)` : `갱신 누락 (${-d}일 경과)`
  if (d <= notice) return auto ? `자동갱신 D-${d}` : `재계약 필요 D-${d}`
  return `여유 (D-${d})`
}

/** 헤더 행 스타일 + 열 너비 + 틀고정 + 자동필터를 한 번에 */
function styleTable(ws, headerRowIdx, widths) {
  const header = ws.getRow(headerRowIdx)
  header.font = { bold: true, color: { argb: TITLE_COLOR } }
  header.alignment = { vertical: 'middle' }
  header.height = 20
  header.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCED4DA' } } }
  })
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w })
  // 헤더까지 고정 → 스크롤해도 열 이름이 보인다
  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }]
  ws.autoFilter = {
    from: { row: headerRowIdx, column: 1 },
    to:   { row: headerRowIdx, column: widths.length },
  }
}

function addTitle(ws, title, subtitle, colSpan) {
  ws.mergeCells(1, 1, 1, colSpan)
  const t = ws.getCell(1, 1)
  t.value = title
  t.font = { bold: true, size: 14 }
  t.alignment = { vertical: 'middle' }
  ws.getRow(1).height = 24

  ws.mergeCells(2, 1, 2, colSpan)
  const s = ws.getCell(2, 1)
  s.value = subtitle
  s.font = { size: 10, color: { argb: 'FF868E96' } }
}

/** 숫자 열에 천단위 서식 일괄 적용 */
function moneyCols(ws, firstDataRow, lastRow, cols) {
  for (let r = firstDataRow; r <= lastRow; r++) {
    cols.forEach(c => { ws.getCell(r, c).numFmt = MONEY })
  }
}

async function buildContractWorkbook(contracts, { kind = 'all', today = new Date() } = {}) {
  today.setHours(0, 0, 0, 0)
  const wb = new ExcelJS.Workbook()
  wb.creator = 'focus-accounter'
  wb.created = today

  const kindLabel = kind === 'purchase' ? '발주' : kind === 'sales' ? '수주' : '주문'
  const stamp = today.toISOString().slice(0, 10)

  // ── 시트 1: 주문 목록 ─────────────────────────────────────────
  const ws = wb.addWorksheet('주문 목록', { views: [{ state: 'frozen', ySplit: 6 }] })
  const isPurchaseList = kind === 'purchase'

  const HEAD = [
    '주문명', '주문번호', '거래처', '청구 방식', '종료 방식',
    '주기당 금액', '주기', '초기 일시금',
    '시작일', '종료일', '갱신 상태',
    isPurchaseList ? '주문금액' : '주문금액(이번 기간)',
    isPurchaseList ? '지급 완료' : '수금 완료',
    '남은 잔액', isPurchaseList ? '미지급금' : '미수금',
    ...(isPurchaseList ? [] : ['원가', '예상 손익']),
    '상태',
  ]

  // 요약(상단) — 합계는 무기한 주문을 빼고 센다(총액이 없는 주문이라 더하면 거짓말이 된다)
  const totalAmount = contracts
    .filter(c => !(c.billing_mode === 'recurring' && c.term_mode === 'open'))
    .reduce((s, c) => s + (Number(c.amount) || 0), 0)
  const totalRemain = contracts.reduce((s, c) => s + (c.remain != null ? c.remain : (c.ar_remain || 0)), 0)
  const monthly = contracts
    .filter(c => c.billing_mode === 'recurring' && c.status === '진행중')
    .reduce((s, c) => s + Math.round((Number(c.unit_amount) || 0) / (PERIOD_MONTHS[c.billing_period] || 1)), 0)

  addTitle(ws, `${kindLabel} 목록`, `기준일 ${stamp} · 총 ${contracts.length}건 (진행중 ${contracts.filter(c => c.status === '진행중').length}건)`, HEAD.length)

  ws.getCell(4, 1).value = '주문금액 합계'
  ws.getCell(4, 2).value = totalAmount
  ws.getCell(4, 3).value = isPurchaseList ? '미지급 잔액' : '남은 미수금'
  ws.getCell(4, 4).value = totalRemain
  ws.getCell(4, 5).value = isPurchaseList ? '월 고정지출' : '월 고정수입'
  ws.getCell(4, 6).value = monthly
  ;[1, 3, 5].forEach(c => { ws.getCell(4, c).font = { bold: true, size: 10, color: { argb: 'FF868E96' } } })
  ;[2, 4, 6].forEach(c => { ws.getCell(4, c).numFmt = MONEY; ws.getCell(4, c).font = { bold: true } })

  ws.getRow(6).values = HEAD
  contracts.forEach(c => {
    const recurring = c.billing_mode === 'recurring'
    const openEnded = recurring && c.term_mode === 'open'
    const purchase = c.is_purchase
    ws.addRow([
      c.name || '', c.contract_no || '', c.vendor_name || '',
      BILLING[c.billing_mode] || '총액형', TERM[c.term_mode] || '기간 만료',
      recurring ? Number(c.unit_amount) || 0 : null,
      recurring ? (PERIOD[c.billing_period] || '월') : '',
      recurring && c.initial_amount ? Number(c.initial_amount) : null,
      c.start_date || '', openEnded ? '해지 시까지' : (c.end_date || ''),
      renewalText(c, today),
      openEnded ? null : Number(c.amount) || 0,
      c.collected ?? 0,
      c.remain != null ? c.remain : null,
      c.ar_remain ?? 0,
      ...(isPurchaseList ? [] : [purchase ? null : (c.cost ?? 0), purchase ? null : (c.profit ?? 0)]),
      c.status || '',
    ])
  })

  const lastRow = ws.rowCount
  const moneyIdx = isPurchaseList ? [6, 8, 12, 13, 14, 15] : [6, 8, 12, 13, 14, 15, 16, 17]
  if (lastRow >= 7) moneyCols(ws, 7, lastRow, moneyIdx)

  styleTable(ws, 6, [
    34, 14, 20, 10, 11, 14, 6, 14, 12, 13, 18, 16, 14, 14, 14,
    ...(isPurchaseList ? [] : [14, 14]), 9,
  ])
  ws.views = [{ state: 'frozen', ySplit: 6, xSplit: 1 }]   // 주문명 열도 고정

  // ── 시트 2: 갱신 관리 ─────────────────────────────────────────
  const renewable = contracts
    .filter(c => isRenewable(c) && c.end_date && c.status === '진행중')
    .map(c => ({ ...c, _d: daysLeft(c.end_date, today) }))
    .sort((a, b) => (a._d ?? 9e9) - (b._d ?? 9e9))

  const ws2 = wb.addWorksheet('갱신 관리')
  addTitle(ws2, '갱신 관리', `기준일 ${stamp} · 갱신 개념이 있는 주문만(자동갱신·정기형) · 종료일이 가까운 순`, 9)
  ws2.getRow(4).values = ['주문명', '거래처', '종료일', '남은 일수', '갱신 방식', '통보 기한(일)', '갱신 상태', '갱신 후 금액 기준', '갱신 횟수']
  renewable.forEach(c => {
    const recurring = c.billing_mode === 'recurring'
    ws2.addRow([
      c.name || '', c.vendor_name || '', c.end_date || '',
      c._d,                                    // 음수 = 이미 지남
      TERM[c.term_mode] || '',
      c.notice_days ?? 60,
      renewalText(c, today),
      recurring
        ? `${PERIOD[c.billing_period] || '월'} ${Number(c.unit_amount || 0).toLocaleString()}원`
        : `총액 ${Number(c.amount || 0).toLocaleString()}원`,
      Number(c.renew_count || 0),
    ])
  })
  styleTable(ws2, 4, [34, 20, 13, 11, 12, 13, 20, 22, 10])
  // 만료·임박 건은 눈에 띄게 (색은 '지금 챙길 것'에만)
  for (let r = 5; r <= ws2.rowCount; r++) {
    const d = ws2.getCell(r, 4).value
    const notice = Number(ws2.getCell(r, 6).value) || 60
    if (typeof d !== 'number') continue
    const color = d < 0 ? 'FFFFE3E3' : d <= notice ? 'FFFFF3BF' : null
    if (!color) continue
    for (let col = 1; col <= 9; col++) {
      ws2.getCell(r, col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }
    }
  }

  // ── 시트 3: 정기 주문 ─────────────────────────────────────────
  const recurrings = contracts.filter(c => c.billing_mode === 'recurring')
  const ws3 = wb.addWorksheet('정기 주문')
  addTitle(ws3, '정기 주문', `기준일 ${stamp} · ${recurrings.length}건 · 월 환산 합계 ${monthly.toLocaleString()}원`, 9)
  ws3.getRow(4).values = ['주문명', '거래처', '주기', '주기당 금액', '월 환산', '초기 일시금', '청구일', '계약 기간', '정기청구 연결']
  recurrings.forEach(c => {
    const openEnded = c.term_mode === 'open'
    ws3.addRow([
      c.name || '', c.vendor_name || '',
      PERIOD[c.billing_period] || '월',
      Number(c.unit_amount) || 0,
      Math.round((Number(c.unit_amount) || 0) / (PERIOD_MONTHS[c.billing_period] || 1)),
      Number(c.initial_amount) || 0,
      `${c.billing_day || 1}일`,
      openEnded ? `${c.start_date || ''} ~ 해지 시까지` : `${c.start_date || ''} ~ ${c.end_date || ''}`,
      Number(c.recurring_active || 0) > 0 ? '연결됨' : '미연결 (청구서 자동생성 안 됨)',
    ])
  })
  if (ws3.rowCount >= 5) moneyCols(ws3, 5, ws3.rowCount, [4, 5, 6])
  styleTable(ws3, 4, [34, 20, 7, 14, 14, 14, 9, 26, 26])

  return wb
}

module.exports = { buildContractWorkbook }
