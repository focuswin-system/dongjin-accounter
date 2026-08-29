import { useState, useEffect } from 'react'
import { Icon } from '../ui'
import { LEAF_BY_ID } from '../nav'
import { loadQuickLinks } from './QuickDock'

/* 홈 맨 위의 바로가기 — **떠 있는 독과 같은 목록**을 크게 그린다.
 *
 * 예전엔 홈에 '자주 찾는 메뉴'(homeFavorites)가 따로 있었다. 저장소가 달라서
 * 독에 담은 것이 홈에 없고 홈에 담은 것이 독에 없었다 — 같은 것을 두 곳에서 관리한 셈이다.
 * 이제 목록은 한 벌이고(QuickDock 의 quickLinks), 여기서는 보여주기만 한다.
 *
 * ⚠ 편집 폼을 여기 새로 만들지 않는다. '편집'은 독의 편집 창을 연다 —
 *   같은 일을 하는 폼이 둘이면 반드시 어긋난다(이 저장소가 계속 겪은 유형).
 */
const bgOf = (c) => ({
  ink: 'var(--ink)', brand: 'var(--brand)', pos: 'var(--pos)',
  warn: 'var(--warn-ink)', neg: 'var(--neg)', gray: 'var(--muted)',
}[c] || 'var(--ink)')

export const QuickTiles = ({ go, canDo }) => {
  const [links, setLinks] = useState(loadQuickLinks)

  // 독에서 담거나 뺀 것이 새로고침 없이 여기에도 보여야 한다
  useEffect(() => {
    const on = (e) => setLinks(Array.isArray(e.detail) ? e.detail : loadQuickLinks())
    window.addEventListener('quicklinks:changed', on)
    return () => window.removeEventListener('quicklinks:changed', on)
  }, [])

  // 권한을 잃은 화면은 조용히 뺀다(목록은 기기에 남아 있다)
  const shown = links.filter(l => {
    const leaf = LEAF_BY_ID[l.id]
    return leaf && (!canDo || canDo(l.id.startsWith('settings') ? 'settings' : l.id))
  })

  return (
    <div style={{ marginBottom: 24 }}>
      <div className="row" style={{ marginBottom: 10, padding: '0 2px', alignItems: 'center' }}>
        <div className="text-xs fw-700" style={{ color: 'var(--muted-2)', letterSpacing: '0.02em' }}>바로가기</div>
        <button className="btn ghost sm ml-auto" onClick={() => window.dispatchEvent(new Event('quickdock:edit'))}>
          <Icon.Cog size={13}/> 편집
        </button>
      </div>

      {shown.length === 0 ? (
        <button className="card quick-empty" onClick={() => window.dispatchEvent(new Event('quickdock:edit'))}>
          <Icon.Plus size={16}/>
          <span>자주 여는 화면을 담아두세요. 여기와 떠 있는 바로가기에 함께 나타납니다.</span>
        </button>
      ) : (
        <div className="quick-tiles">
          {shown.map(l => {
            const leaf = LEAF_BY_ID[l.id]
            const Ic = Icon[l.icon] || leaf.icon || Icon.Right
            return (
              <button key={l.id} className="quick-tile" onClick={() => go(l.id)}>
                <span className="qt-ico" style={{ background: bgOf(l.color) }}><Ic size={24}/></span>
                <span className="qt-label">{leaf.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
