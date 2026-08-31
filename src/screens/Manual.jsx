import { useState, useMemo, useEffect, useRef, Fragment } from 'react'
import { Icon } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { MANUAL, blockText } from '../lib/manual'
import { NAV_PATH_OF, LEAF_BY_ID } from '../lib/nav'

/**
 * 사용 설명서 화면.
 *
 * ── 왜 드로어가 아니라 전용 화면인가 ──
 * 매뉴얼은 **목차를 따라 읽는** 것이다. 380px 서랍에 목차와 본문을 같이 넣으면
 * 둘 다 못 읽는다. FAQ(서랍)는 한 건을 집어 오는 것이라 좁아도 되지만 이건 다르다.
 *
 * ⚠ 인쇄하면 **왼쪽 목차와 검색은 빠지고 본문만** 나간다. 종이에서는 누를 수 없는
 *   것들이라 자리만 차지한다. 그리고 인쇄는 지금 보는 장만이 아니라 **전부** 나간다 —
 *   도입 교육 자료로 통째로 뽑는 것이 이 문서의 쓰임새다.
 */

/** **굵게** 만 지원한다. 매뉴얼 본문에 필요한 강조는 이것뿐이고,
    마크다운을 통째로 들이면 쓰는 사람이 문법을 배워야 한다. */
const Rich = ({ text }) => {
  const parts = String(text || '').split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**')
      ? <b key={i}>{p.slice(2, -2)}</b>
      : <Fragment key={i}>{p}</Fragment>)
}

/* 화면 위치 — nav.js 에서 뽑는다. 손으로 적으면 메뉴를 옮길 때마다 어긋난다. */
const PathBlock = ({ id, go }) => {
  const path = NAV_PATH_OF[id]
  const leaf = LEAF_BY_ID[id]
  if (!path && !leaf) return null
  const crumbs = path || [leaf.label]
  return (
    <div className="man-path">
      <Icon.Right size={12}/>
      <span className="man-path-crumb">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="man-path-sep">›</span>}
            {c}
          </Fragment>
        ))}
      </span>
      {go && <button className="btn sm ml-auto man-noprint" onClick={() => go(id)}>열기</button>}
    </div>
  )
}

const Block = ({ b, go }) => {
  if (b.t === 'p')  return <p className="man-p"><Rich text={b.v}/></p>
  if (b.t === 'ul') return <ul className="man-ul">{b.v.map((x, i) => <li key={i}><Rich text={x}/></li>)}</ul>
  if (b.t === 'steps') return <ol className="man-steps">{b.v.map((x, i) => <li key={i}><Rich text={x}/></li>)}</ol>
  if (b.t === 'note') return (
    <div className={`man-note${b.tone === 'warn' ? ' warn' : ''}`}>
      {b.tone === 'warn' ? <Icon.Warn size={15}/> : <Icon.Help size={15}/>}
      <div><Rich text={b.v}/></div>
    </div>
  )
  if (b.t === 'path') return <PathBlock id={b.v} go={go}/>
  if (b.t === 'table') {
    const [head, ...rows] = b.v
    return (
      <div className="man-table-wrap">
        <table className="man-table">
          <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}><Rich text={c}/></td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    )
  }
  return null
}

/* 검색 — 장·절 단위로 걸린다. 문장 단위로 걸면 앞뒤가 잘려 무슨 말인지 모른다. */
const searchManual = (q) => {
  const s = q.trim().toLowerCase()
  if (!s) return null
  const hits = []
  for (const ch of MANUAL) {
    for (const sec of ch.sections) {
      const text = [sec.title, ...sec.body.map(blockText)].join(' ').toLowerCase()
      if (text.includes(s) || ch.title.toLowerCase().includes(s)) {
        hits.push({ chapter: ch, section: sec })
      }
    }
  }
  return hits
}

export const ManualScreen = ({ go, focusChapter }) => {
  const [chapterId, setChapterId] = useState(focusChapter || MANUAL[0].id)
  const [q, setQ] = useState('')
  const bodyRef = useRef(null)

  /* 다른 화면의 ? 에서 들어오면 그 화면에 맞는 장을 연다.
     ⚠ 의존성에 focusChapter 만 둔다 — chapterId 를 넣으면 사용자가 목차에서 고른
       순간 다시 원래 장으로 튕긴다. */
  useEffect(() => { if (focusChapter) setChapterId(focusChapter) }, [focusChapter])

  const results = useMemo(() => searchManual(q), [q])
  const chapter = MANUAL.find(c => c.id === chapterId) || MANUAL[0]

  /* 장을 바꾸면 본문을 맨 위로. 안 그러면 3장 중간에서 4장으로 갔을 때
     4장 중간이 보여서 "왜 중간부터지?" 가 된다. */
  useEffect(() => { bodyRef.current?.scrollTo?.({ top: 0 }) }, [chapterId])

  const goSection = (chId, secId) => {
    setChapterId(chId); setQ('')
    setTimeout(() => document.getElementById(`man-${chId}-${secId}`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60)
  }

  return (
    <div className="fade-up man-screen">
      <PageHeader title="사용 설명서"
        actions={
          <button className="btn man-noprint" onClick={() => window.print()}>
            <Icon.Print size={14}/> 전체 인쇄
          </button>
        }/>

      <div className="man-layout">
        {/* ── 목차 ── */}
        <aside className="man-toc man-noprint">
          <div className="search" style={{ margin: '0 0 12px', width: '100%' }}>
            <Icon.Search size={14}/>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="설명서에서 찾기"/>
          </div>

          {results ? (
            <div className="col gap-6">
              <div className="text-xs text-muted2">{results.length}건</div>
              {results.length === 0 && (
                <div className="text-sm text-muted" style={{ padding: '16px 4px' }}>
                  찾는 말이 없어요. 다른 말로 찾아보세요.
                </div>
              )}
              {results.map((r, i) => (
                <button key={i} className="man-hit" onClick={() => goSection(r.chapter.id, r.section.id)}>
                  <span className="text-xs text-muted2">{r.chapter.title}</span>
                  <span className="fw-600 text-sm">{r.section.title}</span>
                </button>
              ))}
            </div>
          ) : (
            <nav className="col gap-2">
              {MANUAL.map((ch, i) => {
                const Ic = ch.icon || Icon.Doc
                const on = ch.id === chapterId
                return (
                  <button key={ch.id} className={`man-toc-item${on ? ' on' : ''}`}
                    onClick={() => setChapterId(ch.id)}>
                    <span className="man-toc-no">{i + 1}</span>
                    <Ic size={15}/>
                    <span>{ch.title}</span>
                  </button>
                )
              })}
            </nav>
          )}
        </aside>

        {/* ── 본문 ──
            ⚠ 인쇄할 때는 이 자리에 **모든 장**을 그린다. 지금 보는 장만 뽑히면
              "설명서를 인쇄했는데 한 장만 나왔다"가 된다. */}
        <div className="man-body" ref={bodyRef}>
          <article className="man-doc man-screen-only">
            <ChapterView chapter={chapter} go={go}/>
          </article>
          {/* ⚠ `manual-print` 는 장식이 아니라 **등록**이다. index.css 의 인쇄 규칙은
              body 를 전부 숨기고 화이트리스트에 든 것만 되살린다 — 이 클래스를 빼면
              Ctrl+P 가 백지로 나온다(보고서 화면이 실제로 그랬다). */}
          <div className="man-print-only manual-print">
            {MANUAL.map(ch => <ChapterView key={ch.id} chapter={ch} go={null}/>)}
          </div>
        </div>
      </div>
    </div>
  )
}

const ChapterView = ({ chapter, go }) => (
  <section className="man-chapter">
    <h2 className="man-h1">{chapter.title}</h2>
    {chapter.intro && <p className="man-intro">{chapter.intro}</p>}
    {chapter.sections.map(sec => (
      <section key={sec.id} id={`man-${chapter.id}-${sec.id}`} className="man-section">
        <h3 className="man-h2">{sec.title}</h3>
        {sec.body.map((b, i) => <Block key={i} b={b} go={go}/>)}
      </section>
    ))}
  </section>
)
