import { useState, useEffect } from 'react'
import { Icon } from '../ui'
import { applyPrintOrientation, readPrintOrientation, savePrintOrientation } from '../printOrientation'

/**
 * 인쇄 버튼 + 방향 고르기(세로·가로).
 *
 * 열이 많은 표는 세로로 뽑으면 오른쪽 열이 접히거나 글자가 잘게 줄어 읽기 어렵다
 * (매입매출장이 그랬다). 그렇다고 전부 가로로 두면 결의서 같은 세로 서식이 우스워진다 —
 * 그래서 **화면마다 고르고, 고른 값을 기억한다.**
 *
 * ⚠ `storeKey` 는 화면마다 달라야 한다. 같은 키를 쓰면 한 화면에서 가로로 바꾼 게
 *   다른 화면까지 따라간다.
 */
export const PrintButton = ({ storeKey, defaultOrientation = 'portrait', label = '인쇄', className = 'btn' }) => {
  const [ori, setOri] = useState(() => readPrintOrientation(storeKey, defaultOrientation))

  /* 고른 동안 규칙을 걸어 둔다 — 버튼이 아니라 Ctrl+P 로 인쇄해도 방향이 맞아야 한다.
     화면을 떠나면 거둔다(안 거두면 다른 화면 인쇄까지 가로가 된다). */
  useEffect(() => {
    applyPrintOrientation(ori)
    return () => applyPrintOrientation(null)
  }, [ori])

  const pick = (v) => { setOri(v); savePrintOrientation(storeKey, v) }

  return (
    <span className="row gap-6 no-print" style={{ alignItems: 'center' }}>
      {/* 짧은 선택지라 칩으로 — 두 개짜리에 드롭다운을 두면 한 번 더 눌러야 한다 */}
      <span className="row gap-4">
        {[['portrait', '세로'], ['landscape', '가로']].map(([v, l]) => (
          <button key={v} className={`chip sm ${ori === v ? 'active' : ''}`} onClick={() => pick(v)}
            title={v === 'landscape' ? '열이 많은 표는 가로가 읽기 좋아요' : 'A4 세로'}>{l}</button>
        ))}
      </span>
      <button className={className} onClick={() => window.print()}><Icon.Print size={14}/> {label}</button>
    </span>
  )
}
