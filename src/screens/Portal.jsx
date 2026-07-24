import { useState, useEffect } from 'react'
import { Icon, Spacer } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { api } from '../lib/api'
import { LEAF_BY_ID } from '../lib/nav'

const TODO_META = {
  ar: { icon: <Icon.In size={15}/>,   soft: 'var(--brand-soft)', color: 'var(--brand)' },
  ap: { icon: <Icon.Bank size={15}/>, soft: 'var(--neg-soft)',   color: 'var(--neg-ink)' },
}

// 카테고리 포털 페이지: (상단) 관련 해야 할 일 + (하단) 그룹별 화면 타일
export const PortalScreen = ({ node, go, openIncome, openExpense }) => {
  const [todos, setTodos] = useState([])
  useEffect(() => {
    if (node.todos) api.getHomeTodos().then(setTodos).catch(() => {})
    else setTodos([])
  }, [node.id])

  return (
    <div className="fade-up">
      <PageHeader title={node.label}/>

      {/* 관련 해야 할 일 */}
      {node.todos && (
        <div style={{ marginBottom: 24 }}>
          <div className="text-xs fw-700" style={{ color: 'var(--muted-2)', letterSpacing: '0.02em', marginBottom: 10, padding: '0 2px' }}>
            해야 할 일 <span className="num" style={{ color: 'var(--brand-ink)', marginLeft: 4 }}>{todos.length}</span>
          </div>
          {todos.length === 0 ? (
            <div className="card" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)' }}>
              <Icon.Check size={16} className="text-pos"/>
              <span className="text-sm fw-600" style={{ color: 'var(--ink)' }}>처리할 일이 없어요.</span>
            </div>
          ) : (
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {todos.slice(0, 4).map(t => {
                const m = TODO_META[t.kind] || TODO_META.ar
                return (
                  <div key={t.id} className="card" style={{ padding: '14px 16px', flex: '1 1 240px', minWidth: 220, display: 'flex', gap: 12, alignItems: 'center' }}>
                    <div style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, background: m.soft, color: m.color, display: 'grid', placeItems: 'center' }}>{m.icon}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="text-xs fw-700" style={{ color: m.color }}>{t.tag}</div>
                      <div className="fw-700 text-sm" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
                    </div>
                    <button className="btn primary sm" onClick={() => go(t.kind === 'ap' ? 'ap' : 'ar')} style={{ flexShrink: 0 }}>{t.action}</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 그룹별 화면 타일 */}
      {node.groups.map((g, gi) => (
        <div key={g.label || gi} className="portal-group">
          {g.label && <div className="portal-group-label">{g.label}</div>}
          <div className="tile-row">
            {g.items.map(id => {
              const leaf = LEAF_BY_ID[id]
              if (!leaf) return null
              const Ic = leaf.icon
              return (
                <button key={id} className="leaf-tile" onClick={() => go(id)}>
                  <div className="l-ico"><Ic size={20}/></div>
                  <div className="l-label">{leaf.label}</div>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
