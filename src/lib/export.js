/* 내보내기 공용 — CSV 저장과 '화면에 그려진 표'를 그대로 뽑는 helper.
 *
 * 왜 화면을 긁는가: 보고서 7종은 각자 다른 집계를 하고, 그 결과가 이미 표로 그려져 있다.
 * 컴포넌트마다 내보내기용 데이터를 따로 만들면 화면과 파일이 어긋난다(집계 로직이 두 벌이 된다).
 * 표를 그대로 뽑으면 **보이는 것과 받는 것이 항상 같다.**
 */

/** 배열 → CSV 파일 저장. Excel이 한글을 깨지 않도록 BOM을 붙인다. */
export function downloadCsv(filename, headers, rows) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
  const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\r\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  // Firefox는 anchor가 DOM에 있어야 내려받는다(api.js의 엑셀 내려받기와 같은 이유).
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/* 셀 텍스트 정리.
 * "1,100,000원" 처럼 자릿수 쉼표와 단위가 붙은 값은 Excel에서 **문자로** 들어가 합계가 안 된다.
 * 숫자로만 이루어진 칸은 쉼표·원·공백을 떼어 숫자로 넘긴다(음수 −(U+2212)도 -로 바꾼다).
 * 반대로 '2026-08-05' 같은 날짜나 거래처명은 손대지 않는다. */
function cleanCell(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim()
  const numeric = t.replace(/[,\s원]/g, '').replace(/−/g, '-')
  if (numeric !== '' && /^-?\d+(\.\d+)?$/.test(numeric)) return numeric
  return t
}

/** 컨테이너 안의 모든 <table>을 CSV 행 배열로. 표가 여럿이면 제목 줄과 빈 줄로 나눈다. */
export function tablesToRows(container) {
  if (!container) return []
  const tables = [...container.querySelectorAll('table')]
  const out = []
  tables.forEach((table, i) => {
    // 표 앞의 소제목을 찾아 구분선으로 쓴다 — 한 화면에 매출/매입 표가 나란히 있는 경우가 있다.
    const section = table.closest('.card')?.querySelector('.section-title, .fw-700')
    const caption = section?.textContent?.trim()
    if (i > 0) out.push([])
    if (caption) out.push([caption])
    for (const tr of table.querySelectorAll('tr')) {
      const cells = [...tr.querySelectorAll('th, td')].map(td => cleanCell(td.textContent))
      // 완전히 빈 줄(레이아웃용 tr)은 버린다
      if (cells.some(c => c !== '')) out.push(cells)
    }
  })
  return out
}

/** 화면에 그려진 보고서를 CSV로 저장. 표가 하나도 없으면 false를 돌려준다(호출부가 안내). */
export function downloadVisibleTables(container, filename) {
  const rows = tablesToRows(container)
  if (rows.length === 0) return false
  // 첫 줄을 머리글로 쓰지 않고 전부 본문으로 넘긴다 — 표가 여러 개면 머리글도 여러 벌이다.
  downloadCsv(filename, rows[0] || [], rows.slice(1))
  return true
}
