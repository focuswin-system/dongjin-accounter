import { useState, useEffect } from 'react'
import { Icon, Spacer } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { api } from '../lib/api'
import { LEAF_BY_ID } from '../lib/nav'
import { TileBoard } from '../lib/components/TileBoard'

const TODO_META = {
  ar: { icon: <Icon.In size={15}/>,   soft: 'var(--brand-soft)', color: 'var(--brand)' },
  ap: { icon: <Icon.Bank size={15}/>, soft: 'var(--neg-soft)',   color: 'var(--neg-ink)' },
}

// 카테고리 포털 페이지: (상단) 관련 해야 할 일 + (하단) 그룹별 화면 타일
export const PortalScreen = ({ node, go, openIncome, openExpense }) => {
  const [todos, setTodos] = useState([])
  useEffect(() => {
    /* ⚠ 실패를 통째로 삼키면 안 된다 — 서버가 죽어도 "처리할 일이 없어요"가 되어
         홈 첫 화면이 평온해 보인다. api.js 가 인프라 실패·조회 권한 오류를 토스트로
         알리므로 여기서는 **상태를 갈라 둔다**(빈 것과 못 읽은 것). */
    if (node.todos) api.getHomeTodos().then(setTodos).catch(() => setTodos(null))
    else setTodos([])
  }, [node.id])

  return (
    <div className="fade-up">
      <PageHeader title={node.label}/>

      {/* 관련 해야 할 일 */}
      {node.todos && (
        <div style={{ marginBottom: 24 }}>
          <div className="text-xs fw-700" style={{ color: 'var(--muted-2)', letterSpacing: '0.02em', marginBottom: 10, padding: '0 2px' }}>
            해야 할 일 {todos && <span className="num" style={{ color: 'var(--brand-ink)', marginLeft: 4 }}>{todos.length}</span>}
          </div>
          {/* ⚠ **못 읽은 것과 없는 것을 가른다.** 실패를 빈 배열로 바꾸면 서버가 죽어도
              "처리할 일이 없어요"가 되어 홈 첫 화면이 평온해 보인다. */}
          {todos === null ? (
            <div className="card" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon.Warn size={16} style={{ color: 'var(--warn-ink)' }}/>
              <span className="text-sm" style={{ color: 'var(--muted)' }}>해야 할 일을 불러오지 못했어요.</span>
              <button className="btn ghost sm ml-auto" onClick={() => api.getHomeTodos().then(setTodos).catch(() => setTodos(null))}>
                다시 시도
              </button>
            </div>
          ) : todos.length === 0 ? (
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

      {/* 화면 타일 — 즐겨찾기·분류 탭·정렬은 TileBoard 가 맡는다(보고서 화면과 같은 부품).
          예전엔 그룹을 세로로 죽 쌓아 놓기만 했다. 기준정보처럼 15개가 깔리면
          매번 눈으로 훑어 찾게 되고, 자주 쓰는 두어 개를 앞에 둘 방법이 없었다. */}
      <TileBoard
        storageKey={node.id}
        groups={node.groups.map(g => ({
          label: g.label, icon: g.icon, tone: g.tone,
          items: (g.items || []).map(id => LEAF_BY_ID[id]).filter(Boolean)
            .map(l => ({ id: l.id, title: l.label, icon: l.icon })),
        }))}
        onPick={go}/>
    </div>
  )
}
