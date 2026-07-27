import { useState, useRef, useMemo, Fragment } from 'react'
import { Icon, Spacer, Combobox, Popover, useToast } from '../ui'

// ── 엑셀·CSV 일괄 업로드 공용 마법사 ──────────────────────────────
// 파일 업로드 → 컬럼 매핑 → 중복 판정 → 일괄 등록. 화면 흐름은 모든 임포트가 같고
// 다른 건 "무엇을 어떤 키로 중복 판정하느냐"뿐이라, 그 부분만 adapter로 주입받는다.
//
// adapter 규약
//   label, title, sub          — 문구
//   templateUrl, templateName  — 양식 다운로드
//   targets[], requiredTarget  — 매핑 대상 라벨 목록 / 필수 항목
//   guess(header)              — 엑셀 머리글 → 매핑 대상 추측
//   initialOpts, renderOpts()  — 어댑터 전용 옵션(예: 거래처 기본 구분)
//   mapRow(get, opts)          — 매핑된 컬럼 → 저장용 데이터 객체
//   isValid(data)              — 필수값 확인
//   matchKey(data)             — 파일 안 중복 판정 키
//   buildIndex(existing) / findMatch(data, idx) — 기존 자료와의 중복 판정
//   candidateLabel(row)        — 덮어쓰기 후보 표시
//   rowWarns(data, get)        — 행별 주의 문구(값을 못 알아봤을 때)
//   previewCols[]              — 미리보기 표 컬럼
//   commit(items)              — 서버 반영
const STATE_META = {
  error:     { badge: 'neg',     label: '필수값 없음' },
  'new':     { badge: 'pos',     label: '신규' },
  dup:       { badge: 'warn',    label: '중복' },
  ambiguous: { badge: 'brand',   label: '확인 필요' },
  filedup:   { badge: 'outline', label: '파일 내 중복' },
}

export const ImportWizard = ({ adapter, existing = [], onCancel, onDone }) => {
  const toast = useToast()
  const fileRef = useRef(null)
  const [file, setFile] = useState(null)
  const [rawRows, setRawRows] = useState([])
  const [truncated, setTruncated] = useState(null)   // { total, shown } — 행이 잘렸을 때만
  const [mapping, setMapping] = useState([])
  const [opts, setOpts] = useState(adapter.initialOpts ?? {})
  const [overrides, setOverrides] = useState({})     // idx -> 'insert' | 'skip' | 'update:<id>'
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const onFile = async (f) => {
    if (!f) return
    setBusy(true); setResult(null)
    try {
      const { headers, rows, total, truncated: cut } = await adapter.parse(f)
      if (!headers?.length) { toast.push('열을 인식하지 못했어요. 첫 행이 머리글인지 확인하세요.'); setBusy(false); return }
      setFile({ name: f.name, size: f.size })
      setRawRows(rows)
      setTruncated(cut ? { total, shown: rows.length } : null)
      setMapping(headers.map(h => ({ excelCol: h, target: adapter.guess(h) || '사용 안함' })))
      setOverrides({})
    } catch (e) { toast.push(e.message || '파싱 실패') }
    setBusy(false)
  }

  const reset = () => { setFile(null); setRawRows([]); setMapping([]); setOverrides({}); setResult(null); setTruncated(null) }
  const colFor = (t) => mapping.find(m => m.target === t)?.excelCol
  const setMap = (i, k, v) => setMapping(ms => ms.map((m, idx) => idx === i ? { ...m, [k]: v } : m))

  const idx = useMemo(() => adapter.buildIndex(existing), [existing, adapter])

  const preview = useMemo(() => {
    const seen = new Set()
    return rawRows.map((row, i) => {
      const get = (t) => { const c = colFor(t); return c != null ? String(row[c] ?? '').trim() : '' }
      const data = adapter.mapRow(get, opts)
      const warns = adapter.rowWarns?.(data, get) ?? []
      if (!adapter.isValid(data)) return { i, data, warns, state: 'error', candidates: [], def: 'skip' }

      const { matched, candidates } = adapter.findMatch(data, idx)
      const key = adapter.matchKey(data)
      const fileDup = key && seen.has(key)
      if (key) seen.add(key)

      let state, def
      if (matched) { state = 'dup'; def = 'skip' }
      else if (candidates.length) { state = 'ambiguous'; def = 'skip' }
      else if (fileDup) { state = 'filedup'; def = 'skip' }
      else { state = 'new'; def = 'insert' }
      return { i, data, warns, state, candidates: matched ? [matched] : candidates, def }
    })
  }, [rawRows, mapping, opts, idx, adapter])

  const eff = (r) => overrides[r.i] ?? r.def
  const setAction = (i, v) => setOverrides(o => ({ ...o, [i]: v }))

  const counts = useMemo(() => {
    const c = { new: 0, dup: 0, ambiguous: 0, filedup: 0, error: 0, insert: 0, update: 0, skip: 0, warn: 0 }
    for (const r of preview) {
      c[r.state]++
      if (r.warns.length) c.warn++
      const a = eff(r)
      if (r.state === 'error' || a === 'skip') c.skip++
      else if (a === 'insert') c.insert++
      else if (a.startsWith('update:')) c.update++
    }
    return c
  }, [preview, overrides])

  const applyBulk = (action) => setOverrides(o => {
    const n = { ...o }
    for (const r of preview) {
      if (r.state === 'error' || r.state === 'new') continue
      if (action === 'skip') n[r.i] = 'skip'
      else if (action === 'insert') n[r.i] = 'insert'
      else if (action === 'overwrite' && r.candidates.length === 1) n[r.i] = 'update:' + r.candidates[0].id
    }
    return n
  })

  const onCommit = async () => {
    const items = preview
      .filter(r => r.state !== 'error')
      .map(r => ({ r, a: eff(r) }))
      .filter(({ a }) => a !== 'skip')
      .map(({ r, a }) => ({
        action: a.startsWith('update:') ? 'update' : 'insert',
        id: a.startsWith('update:') ? a.slice(7) : undefined,
        ...r.data,
      }))
    if (!items.length) return toast.push(`등록·갱신할 ${adapter.label}이(가) 없어요`)
    setBusy(true)
    const res = await adapter.commit(items)
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '등록 실패')
    setResult(res)
    toast.push(`신규 ${res.inserted}건 · 갱신 ${res.updated}건 반영됐어요`)
  }

  const downloadTemplate = async () => {
    try {
      const token = localStorage.getItem('token')
      const res = await fetch(adapter.templateUrl, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob); const a = document.createElement('a')
      a.href = url; a.download = adapter.templateName; a.click(); URL.revokeObjectURL(url)
    } catch { toast.push('양식 다운로드에 실패했어요') }
  }

  const stage = result ? 3 : (file ? 2 : 1)
  const rowOpts = (r) => [
    { value: 'skip', label: '건너뛰기' },
    { value: 'insert', label: '새로 등록' },
    ...r.candidates.map(c => {
      const meta = adapter.candidateLabel(c)
      return { value: 'update:' + c.id, label: `덮어쓰기 → ${meta.label}`, sub: meta.sub || '' }
    }),
  ]

  return (
    <div className="import-wrap" style={{ padding: '20px 20px 104px' }}>
      <div className="row" style={{ marginBottom: 6, gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div className="section-title">{adapter.title}</div>
          <div className="section-sub">{adapter.sub}</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn" onClick={downloadTemplate}><Icon.Download/> 양식 다운로드</button>
          <button className="btn ghost" onClick={onCancel}><Icon.Close size={14}/> 닫기</button>
        </div>
      </div>
      <Spacer h={16}/>

      <div className="row gap-12" style={{ marginBottom: 20 }}>
        {[{ n: 1, t: '파일 업로드' }, { n: 2, t: '컬럼 매핑 · 중복 검토' }, { n: 3, t: '일괄 등록' }].map((s, i2, arr) => (
          <Fragment key={s.n}>
            <div className="row gap-8" style={{ opacity: stage >= s.n ? 1 : 0.4 }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: stage >= s.n ? 'var(--ink)' : '#fff', color: stage >= s.n ? '#fff' : 'var(--muted)', border: '1px solid var(--line-strong)', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 12 }}>
                {stage > s.n ? <Icon.Check size={14}/> : s.n}
              </div>
              <div className={`text-sm ${stage >= s.n ? 'fw-700' : 'text-muted'}`}>{s.t}</div>
            </div>
            {i2 < arr.length - 1 && <div style={{ flex: 1, height: 1, background: 'var(--line)' }}/>}
          </Fragment>
        ))}
      </div>

      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => onFile(e.target.files[0])}/>

      {result ? (
        <div className="card card-pad fade-up" style={{ textAlign: 'center', padding: '48px 24px', maxWidth: 520, margin: '0 auto' }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--pos-soft)', color: 'var(--pos)', display: 'grid', placeItems: 'center', margin: '0 auto 16px' }}><Icon.Check size={24}/></div>
          <div className="fw-700" style={{ fontSize: 16, marginBottom: 8 }}>{adapter.label}이(가) 반영됐어요</div>
          <div className="text-sm text-muted" style={{ marginBottom: 20 }}>신규 등록 {result.inserted}건 · 기존 갱신 {result.updated}건</div>
          <div className="row gap-8" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={reset}>새 파일 업로드</button>
            <button className="btn primary" onClick={onDone}>{adapter.label} 목록으로</button>
          </div>
        </div>
      ) : !file ? (
        <div className="card card-pad">
          <div className="drop" style={{ padding: 48, cursor: 'pointer', textAlign: 'center' }}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files[0]) }}>
            <Icon.Excel size={36} style={{ color: 'var(--pos)' }}/>
            <div className="fw-600" style={{ marginTop: 8 }}>{busy ? '분석 중...' : '엑셀·CSV 파일을 끌어다 놓거나 클릭해서 업로드'}</div>
            <div className="text-xs text-muted2" style={{ marginTop: 4 }}>.xlsx · .xls · .csv · 최대 20MB · 첫 행은 머리글</div>
          </div>
        </div>
      ) : (
        <div className="col gap-16">
            <div className="card card-pad">
              <div className="row gap-12">
                <div style={{ width: 44, height: 44, borderRadius: 10, background: '#E7F4ED', color: 'var(--pos)', display: 'grid', placeItems: 'center' }}><Icon.Excel size={22}/></div>
                <div style={{ minWidth: 0 }}>
                  <div className="fw-700" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
                  <div className="text-xs text-muted2">{Math.round(file.size / 1024)}KB · {rawRows.length}행 인식됨</div>
                </div>
                <div className="ml-auto row gap-6">
                  <button className="btn sm" onClick={() => fileRef.current?.click()}>다시 업로드</button>
                  <button className="btn ghost sm" onClick={reset}><Icon.Close size={14}/></button>
                </div>
              </div>
              {/* 행이 잘렸으면 반드시 알린다 — 조용히 자르면 전부 올라간 줄 안다 */}
              {truncated && (
                <div className="alert-row" style={{ marginTop: 12, background: 'var(--neg-soft)', borderColor: 'transparent' }}>
                  <Icon.Warn/>
                  <div>
                    <div className="lead">파일이 너무 커서 앞쪽 {truncated.shown}행만 읽었어요</div>
                    <div className="body">전체 {truncated.total}행 중 {truncated.total - truncated.shown}행은 이번 업로드에 포함되지 않아요. 파일을 나눠서 올려주세요.</div>
                  </div>
                </div>
              )}
              {adapter.renderOpts && (
                <>
                  <div style={{ height: 1, background: 'var(--line)', margin: '14px 0' }}/>
                  {adapter.renderOpts(opts, (patch) => setOpts(o => ({ ...o, ...patch })))}
                </>
              )}
            </div>

            <div className="card card-pad">
              <div className="section-title" style={{ marginBottom: 4 }}>컬럼 매핑</div>
              <div className="section-sub" style={{ marginBottom: 14 }}>왼쪽은 엑셀 컬럼명(수정 가능), 오른쪽은 우리 항목으로 연결하세요. ‘{adapter.requiredTarget}’은(는) 필수예요.</div>
              <div className="table-scroll">
                <table className="table" style={{ marginTop: 6 }}>
                  <thead><tr><th style={{ width: 200 }}>엑셀 컬럼</th><th>샘플 값</th><th style={{ width: 200 }}>매핑 항목</th></tr></thead>
                  <tbody>
                    {mapping.map((m, i) => (
                      <tr key={i}>
                        <td><input className="input" value={m.excelCol} onChange={e => setMap(i, 'excelCol', e.target.value)}/></td>
                        <td className="text-muted num text-sm" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(rawRows[0]?.[m.excelCol] ?? '—') || '—'}</td>
                        <td>
                          <div className="row gap-6" style={{ alignItems: 'center' }}>
                            <Icon.Right size={12} className="text-muted2"/>
                            <div style={{ flex: 1 }}>
                              <Combobox value={m.target} onChange={v => setMap(i, 'target', v)} allowAdd={false}
                                options={['사용 안함', ...adapter.targets].map(o => ({ value: o, label: o }))}/>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!colFor(adapter.requiredTarget) && (
                <div className="alert-row" style={{ marginTop: 12, background: 'var(--neg-soft)', borderColor: 'transparent' }}>
                  <Icon.Warn/>
                  <div><div className="lead">‘{adapter.requiredTarget}’ 컬럼을 지정해주세요</div><div className="body">{adapter.requiredHelp}</div></div>
                </div>
              )}
            </div>

            <div className="card">
              <div className="row" style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', gap: 8 }}>
                <div className="section-title">미리보기 · 중복 처리</div>
                <div className="ml-auto row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="badge pos"><Icon.Check size={11}/> 신규 {counts.new}</span>
                  {counts.dup > 0 && <span className="badge warn">중복 {counts.dup}</span>}
                  {counts.ambiguous > 0 && <span className="badge brand">확인 필요 {counts.ambiguous}</span>}
                  {counts.filedup > 0 && <span className="badge outline">파일 중복 {counts.filedup}</span>}
                  {counts.warn > 0 && <span className="badge warn"><Icon.Warn size={11}/> 값 확인 {counts.warn}</span>}
                  {counts.error > 0 && <span className="badge neg"><Icon.Warn size={11}/> 오류 {counts.error}</span>}
                  <Popover align="right" width={280}
                    trigger={<button className="icon-btn" title="중복 판정 기준"><Icon.Help size={16}/></button>}>
                    <div style={{ padding: 14 }}>
                      <div className="fw-700" style={{ marginBottom: 6 }}>중복은 이렇게 판정해요</div>
                      <div className="text-sm text-muted" style={{ lineHeight: 1.6 }}>{adapter.dupHelp}</div>
                    </div>
                  </Popover>
                </div>
              </div>

              {(counts.dup + counts.ambiguous + counts.filedup) > 0 && (
                <div className="row gap-8" style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', background: 'var(--surface-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="text-xs fw-600 text-muted">중복 {counts.dup + counts.ambiguous + counts.filedup}건 일괄</span>
                  <button className="btn sm" onClick={() => applyBulk('skip')}>전체 건너뛰기</button>
                  <button className="btn sm" onClick={() => applyBulk('overwrite')}>전체 덮어쓰기 <span className="text-muted2" style={{ fontSize: 11 }}>(후보 1곳)</span></button>
                  <button className="btn sm" onClick={() => applyBulk('insert')}>전체 새로 등록</button>
                  {Object.keys(overrides).length > 0 && <button className="btn ghost sm ml-auto" onClick={() => setOverrides({})}>처리 초기화</button>}
                </div>
              )}

              <div className="table-scroll" style={{ maxHeight: 420 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>행</th>
                      {adapter.previewCols.map(c => <th key={c.header} style={c.width ? { width: c.width } : undefined}>{c.header}</th>)}
                      <th style={{ width: 96 }}>판정</th>
                      <th style={{ width: 220 }}>처리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.slice(0, 200).map((r) => {
                      const a = eff(r)
                      const skipped = r.state === 'error' || a === 'skip'
                      return (
                        <tr key={r.i} style={{ background: r.state === 'error' ? 'rgba(255,80,80,0.04)' : undefined, opacity: skipped && r.state !== 'error' ? 0.55 : 1 }}>
                          <td className="num text-muted2">{r.i + 2}</td>
                          {adapter.previewCols.map(c => (
                            <td key={c.header} className={c.className}>{c.render(r.data)}</td>
                          ))}
                          <td>
                            <div className="row gap-4" style={{ flexWrap: 'wrap' }}>
                              <span className={`badge ${STATE_META[r.state].badge}`}>{STATE_META[r.state].label}</span>
                              {r.warns.length > 0 && (
                                <span className="badge warn" title={r.warns.join('\n')} style={{ cursor: 'help' }}><Icon.Warn size={11}/></span>
                              )}
                            </div>
                          </td>
                          <td>
                            {r.state === 'error' ? (
                              <span className="text-xs text-muted2">{adapter.requiredTarget} 필요</span>
                            ) : r.state === 'new' ? (
                              <div className="row gap-6">
                                <button className={`chip sm ${a === 'insert' ? 'active' : ''}`} onClick={() => setAction(r.i, 'insert')}>신규 등록</button>
                                <button className={`chip sm ${a === 'skip' ? 'active' : ''}`} onClick={() => setAction(r.i, 'skip')}>제외</button>
                              </div>
                            ) : (
                              <Combobox value={a} onChange={v => setAction(r.i, v)} allowAdd={false} options={rowOpts(r)}/>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ padding: 16, borderTop: '1px solid var(--line)', flexWrap: 'wrap', gap: 8 }}>
                <span className="text-sm text-muted">{preview.length > 200 ? `상위 200행 표시 · 전체 ${preview.length}행` : `전체 ${preview.length}행`}</span>
                <div className="ml-auto row gap-8">
                  <button className="btn" onClick={onCancel}>취소</button>
                  <button className="btn primary" disabled={busy || (!counts.insert && !counts.update)} style={{ opacity: (busy || (!counts.insert && !counts.update)) ? 0.5 : 1 }} onClick={onCommit}>
                    <Icon.Check size={14}/> {busy ? '등록 중...' : `신규 ${counts.insert} · 갱신 ${counts.update} 반영`}
                  </button>
                </div>
              </div>
            </div>
        </div>
      )}
    </div>
  )
}
