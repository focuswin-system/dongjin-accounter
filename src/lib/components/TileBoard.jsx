import { useState, useEffect, useMemo, useCallback } from 'react'
import { Icon } from '../ui'

/**
 * 카드 고르기 판 — **보고서·기준정보·환경설정이 함께 쓰는 부품.**
 *
 * ── 왜 하나로 묶나 ──
 * 세 화면이 하는 일이 같다: 카드가 여럿 깔려 있고 그중 하나를 골라 들어간다.
 * 그런데 각자 따로 그리고 있어서, 한쪽에 즐겨찾기를 붙이면 나머지 둘은 안 붙는다.
 * 카드가 늘수록(기준정보 15개, 보고서 13개) 매번 눈으로 훑어 찾게 된다.
 *
 * 붙이는 것 넷:
 *   · 즐겨찾기 — 자주 여는 것을 맨 앞으로. 별을 누르면 담긴다.
 *   · 분류 탭  — 묶음이 여럿이면 그 묶음만 본다.
 *   · 분류 구획 — '전체'에서도 묶음별로 갈라 보여준다(아래 참고).
 *   · 정렬     — 기본(정의 순) / 이름순 / 자주 여는 순.
 *
 * ── 분류가 있는데 '전체'는 왜 한 덩어리였나 ──
 * 탭으로 갈라 볼 수는 있었지만, 처음 들어와서 보는 '전체'가 15개 한 덩어리였다.
 * 분류를 만들어 놓고 정작 기본 화면에서는 안 쓴 셈이라 한눈에 안 들어왔다.
 * 이제 '전체 + 기본 정렬'이면 **분류마다 소제목을 두고 구획을 나눈다.**
 * ⚠ 이름순·자주 여는 순에서는 나누지 않는다 — 그 둘은 분류를 **일부러 섞어**
 *   보는 순서라, 구획을 치면 정작 보려던 순서가 안 보인다.
 *
 * ── 색 ──
 * 묶음에 `tone` 을 주면 그 묶음 카드의 아이콘이 같은 색을 쓴다. 아이콘 모양은
 * 항목마다 다르게 두되(무엇인지 알아야 하니까) **색이 묶음을 말한다.**
 *
 * ── 저장 ──
 * 화면별로 `storageKey` 를 받아 localStorage 에 따로 담는다. 서버에 두지 않는 이유는
 * **사람마다 다른 취향**이고 회사 데이터가 아니기 때문이다(바로가기 독과 같은 판단).
 * ⚠ 담기는 것은 **잎 id** 다. 메뉴를 옮겨도 id 는 안 바뀌므로 그대로 살아남는다 —
 *   id 를 바꾸는 개편을 하게 되면 nav.js ROUTE_ALIAS 와 함께 여기도 옮겨줘야 한다.
 *
 * @param storageKey 화면 구분(예: 'master' · 'settings' · 'report')
 * @param groups [{ label, icon, tone, items: [{ id, title, desc, icon }] }]
 *               label 이 비면 분류 탭·구획을 안 만든다. icon·tone 은 없어도 된다.
 * @param onPick (id) => void
 * @param empty  볼 것이 하나도 없을 때 보여줄 문구
 */

const SORTS = [
  { id: 'default', label: '기본' },
  { id: 'name',    label: '이름순' },
  { id: 'used',    label: '자주 여는 순' },
]

const read = (key, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback } catch { return fallback }
}

export const TileBoard = ({ storageKey, groups = [], onPick, empty = '볼 수 있는 항목이 없어요.' }) => {
  const FAV_KEY  = `tileFav:${storageKey}`
  const SORT_KEY = `tileSort:${storageKey}`
  const USE_KEY  = `tileUse:${storageKey}`

  const [favs, setFavs] = useState(() => { const v = read(FAV_KEY, []); return Array.isArray(v) ? v : [] })
  const [sort, setSort] = useState(() => {
    const v = read(SORT_KEY, 'default')
    return SORTS.some(s => s.id === v) ? v : 'default'
  })
  const [uses, setUses] = useState(() => { const v = read(USE_KEY, {}); return (v && typeof v === 'object') ? v : {} })
  const [tab, setTab]   = useState('all')

  useEffect(() => { localStorage.setItem(FAV_KEY, JSON.stringify(favs)) }, [FAV_KEY, favs])
  useEffect(() => { localStorage.setItem(SORT_KEY, JSON.stringify(sort)) }, [SORT_KEY, sort])
  useEffect(() => { localStorage.setItem(USE_KEY, JSON.stringify(uses)) }, [USE_KEY, uses])

  /* 분류 탭은 **라벨이 있는 묶음이 둘 이상일 때만** 만든다.
     묶음이 하나뿐인데 '전체 / 그 묶음' 두 칩을 세우면 누를 이유가 없는 칩이 생긴다. */
  const named = groups.filter(g => g.label)
  const showTabs = named.length > 1

  const all = useMemo(
    () => groups.flatMap((g, gi) => (g.items || []).map((it, ii) => ({
      ...it, _group: g.label || '', _tone: g.tone || '', _ord: gi * 1000 + ii,
    }))),
    [groups])

  const favSet = useMemo(() => new Set(favs), [favs])
  const hasFav = all.some(it => favSet.has(it.id))

  const shown = useMemo(() => {
    let rows = all
    if (tab === 'fav') rows = rows.filter(it => favSet.has(it.id))
    else if (tab !== 'all') rows = rows.filter(it => it._group === tab)

    const by = {
      default: (a, b) => a._ord - b._ord,
      name:    (a, b) => String(a.title).localeCompare(String(b.title), 'ko'),
      used:    (a, b) => (uses[b.id] || 0) - (uses[a.id] || 0) || a._ord - b._ord,
    }[sort]
    rows = [...rows].sort(by)

    /* '전체'에서는 즐겨찾기를 맨 앞으로 끌어올린다 — 그러라고 담는 것이다.
       분류 탭 안에서는 안 올린다. 그 묶음의 순서를 보러 들어온 것이라 흐트러뜨리면 안 된다. */
    if (tab === 'all' && hasFav) {
      rows = [...rows.filter(it => favSet.has(it.id)), ...rows.filter(it => !favSet.has(it.id))]
    }
    return rows
  }, [all, tab, sort, favSet, hasFav, uses])

  /* 구획으로 나눠 그릴지 — '전체'이고 '기본' 정렬이고 분류가 있을 때만.
     즐겨찾기는 맨 위 구획으로 따로 세운다(분류 안에 또 넣으면 두 번 나온다). */
  const sections = useMemo(() => {
    if (!(tab === 'all' && sort === 'default' && showTabs)) return null
    const out = []
    const favRows = shown.filter(it => favSet.has(it.id))
    if (favRows.length) out.push({ key: '_fav', label: '즐겨찾기', icon: Icon.Star, tone: '', items: favRows })
    for (const g of named) {
      const items = shown.filter(it => it._group === g.label && !favSet.has(it.id))
      if (items.length) out.push({ key: g.label, label: g.label, icon: g.icon, tone: g.tone || '', items })
    }
    return out
  }, [tab, sort, showTabs, shown, named, favSet])

  const toggleFav = useCallback((e, id) => {
    e.stopPropagation()          // 별을 눌렀는데 화면까지 열리면 안 된다
    setFavs(f => (f.includes(id) ? f.filter(x => x !== id) : [...f, id]))
  }, [])

  const pick = (id) => {
    setUses(u => ({ ...u, [id]: (u[id] || 0) + 1 }))
    onPick?.(id)
  }

  /* 카드 하나. 컴포넌트가 아니라 **부르는 함수**다 — 컴포넌트로 만들면
     렌더마다 새 타입이 되어 카드가 통째로 다시 붙는다. */
  const tile = (it) => {
    const Ic = it.icon || Icon.Doc
    const on = favSet.has(it.id)
    return (
      <button key={it.id} className={`leaf-tile tile-fav-host${it.desc ? ' has-desc' : ''}`} onClick={() => pick(it.id)}>
        {/* 별 — 담긴 것은 늘 보이고, 안 담긴 것은 카드에 손이 갔을 때만 보인다.
            안 그러면 카드마다 회색 별이 박혀 목록이 어수선해진다. */}
        <span className={`tile-fav${on ? ' on' : ''}`} role="button" tabIndex={-1}
          title={on ? '즐겨찾기에서 빼기' : '즐겨찾기에 담기'}
          onClick={(e) => toggleFav(e, it.id)}>
          <Icon.Star size={15} filled={on}/>
        </span>
        <div className={`l-ico${it._tone ? ` tone-${it._tone}` : ''}`}><Ic size={20}/></div>
        <div className="l-label">{it.title}</div>
        {it.desc && <div className="l-desc">{it.desc}</div>}
      </button>
    )
  }

  if (all.length === 0) {
    return <div className="card card-pad text-sm text-muted" style={{ textAlign: 'center', padding: 40 }}>{empty}</div>
  }

  return (
    <div>
      {/* 도구 줄 — 왼쪽은 무엇을 볼지, 오른쪽은 어떤 순서로 볼지 */}
      {(showTabs || hasFav || all.length > 6) && (
        <div className="row gap-6" style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
          {/* '전체'는 **갈래가 있을 때만** 세운다. 분류도 즐겨찾기도 없는데 '전체' 하나만
              서 있으면 누를 이유가 없는 칩이다(보고서 화면에서 실제로 그랬다). */}
          {(showTabs || hasFav) && (
            <button className={`chip ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>전체</button>
          )}
          {hasFav && (
            <button className={`chip ${tab === 'fav' ? 'active' : ''}`} onClick={() => setTab('fav')}>
              <Icon.Star size={13} filled/> 즐겨찾기 {favs.length}
            </button>
          )}
          {/* 칩에도 그 분류의 아이콘을 세운다 — 아래 구획 제목과 같은 아이콘이라
              탭과 구획이 같은 것을 가리킨다는 게 눈으로 이어진다. */}
          {showTabs && named.map(g => {
            const GIc = g.icon
            return (
              <button key={g.label} className={`chip ${tab === g.label ? 'active' : ''}`}
                onClick={() => setTab(g.label)}>
                {GIc && <GIc size={13}/>} {g.label}
              </button>
            )
          })}
          <div className="ml-auto row gap-4" style={{ alignItems: 'center' }}>
            {/* 라벨은 칩들과 한 덩어리로 읽히면 안 된다 — 붙여 두면 '정렬'이 첫 번째 칩처럼 보인다 */}
            <span className="text-xs text-muted2" style={{ marginRight: 4 }}>정렬</span>
            {SORTS.map(s => (
              <button key={s.id} className={`chip sm ${sort === s.id ? 'active' : ''}`}
                onClick={() => setSort(s.id)}>{s.label}</button>
            ))}
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="card card-pad text-sm text-muted" style={{ textAlign: 'center', padding: 32 }}>
          이 분류에는 아직 없어요.
        </div>
      ) : sections ? (
        sections.map(sec => {
          const SIc = sec.icon
          return (
            <div key={sec.key} className="tile-sec-wrap">
              <div className="tile-sec">
                <span className={`tile-sec-ico${sec.tone ? ` tone-${sec.tone}` : ''}`}>
                  {SIc ? <SIc size={13}/> : null}
                </span>
                <span className="tile-sec-label">{sec.label}</span>
                <span className="tile-sec-count">{sec.items.length}</span>
              </div>
              <div className="tile-row">{sec.items.map(tile)}</div>
            </div>
          )
        })
      ) : (
        <div className="tile-row">{shown.map(tile)}</div>
      )}
    </div>
  )
}
