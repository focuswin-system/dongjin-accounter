import { Fragment, useState } from 'react'
import { Icon } from '../ui'
import { DataTable } from './DataTable'

/**
 * 업로드 화면 공용 — **단계 표시**와 **1단계 안내(양식 다운로드)**.
 *
 * 왜 — 거래내역 엑셀 업로드에만 '양식 다운로드 → 작성 방법 표 → 다음 단계' 안내가 있고,
 *   세금계산서·카드 명세서·기준정보 업로드(ImportWizard)는 첫 화면이 곧 파일 놓는 칸이었다.
 *   같은 일을 하는 화면이 서로 다른 얼굴이라 사용자가 "양식 맞춰야 해"(2026-10-02).
 *   생김새를 여기 하나로 두고 두 곳(Docs ExcelScreen · ImportWizard)이 같이 쓴다.
 */

/* 단계 표시 — 지난 단계는 체크, 지금 단계는 진하게. onStep 을 주면 그 단계 번호를 누를 수 있다 */
export const ImportSteps = ({ steps, stage, canGo = () => false, onStep }) => (
  <div className="row gap-12" style={{ marginBottom: 20 }}>
    {steps.map((t, i, arr) => {
      const n = i + 1
      const go = canGo(n) && onStep
      return (
        <Fragment key={t}>
          <div className="row gap-8" style={{ opacity: stage >= n ? 1 : 0.4, cursor: go ? 'pointer' : undefined }}
            onClick={go ? () => onStep(n) : undefined}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: stage >= n ? 'var(--ink)' : 'var(--surface)', color: stage >= n ? 'var(--surface)' : 'var(--muted)', border: '1px solid var(--line-strong)', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 12, flexShrink: 0 }}>
              {stage > n ? <Icon.Check size={14}/> : n}
            </div>
            <div className={`text-sm ${stage >= n ? 'fw-700' : 'text-muted'}`} style={{ whiteSpace: 'nowrap' }}>{t}</div>
          </div>
          {i < arr.length - 1 && <div style={{ flex: 1, height: 1, background: 'var(--line)', minWidth: 12 }}/>}
        </Fragment>
      )
    })}
  </div>
)

/**
 * 1단계 안내 카드 — 왼쪽 설명·주의·[양식 다운로드] | 오른쪽 '작성 방법' 표 | 아래 [다음 단계].
 *
 * @param title     굵은 첫 줄
 * @param intro     설명(노드)
 * @param note      주의 상자(노드, 없으면 안 그린다)
 * @param onDownload  양식 받기. 없으면 버튼이 없고 [다음 단계]가 주된 버튼이 된다
 *                    (카드 명세서처럼 **받아 온 파일 그대로** 올리는 업로드 — 양식을 주면 "옮겨 적으라"는 말이 된다)
 * @param downloadHint 버튼 옆 작은 말
 * @param guide     [{ col, req, how, ex, num }] — 작성 방법 표
 * @param guideTitle 표 제목(기본 '작성 방법')
 * @param onNext    다음 단계(파일 업로드)
 */
export const ImportGuideCard = ({ title, intro, note, onDownload, downloadHint, guide = [], guideTitle = '작성 방법', onNext, nextLead }) => (
  <div className="card card-pad col gap-20">
    <div className="xl-guide">
      <div className="col gap-16">
        <div>
          <div className="section-title" style={{ marginBottom: 6 }}>{title}</div>
          <div className="text-sm text-muted" style={{ lineHeight: 1.7 }}>{intro}</div>
        </div>
        {note && (
          <div className="man-note" style={{ margin: 0 }}>
            <Icon.Help size={15}/>
            <div style={{ lineHeight: 1.7 }}>{note}</div>
          </div>
        )}
        {/* 이 단계의 주된 일은 '받기'다 — 가장 눈에 띄게, 안내를 다 읽은 자리 바로 밑에 */}
        {onDownload && (
          <div className="row gap-12" style={{ alignItems: 'center' }}>
            <button className="btn primary" style={{ padding: '12px 20px', fontSize: 14 }} onClick={onDownload}>
              <Icon.Download size={16}/> 양식 다운로드
            </button>
            {downloadHint && <span className="text-xs text-muted2">{downloadHint}</span>}
          </div>
        )}
      </div>
      {guide.length > 0 && (
        <div>
          <div className="fw-700 text-sm" style={{ marginBottom: 8 }}>{guideTitle}</div>
          <div className="table-scroll">
            {/* 촘촘한 표 — 안내가 길어져 [다운로드]·[다음 단계]가 화면 밖으로 밀리면 안 된다 */}
            <table className="table table-compact">
              <thead><tr><th>항목</th><th>작성 방법</th><th>예시</th></tr></thead>
              <tbody>
                {guide.map(g => (
                  /* 한 줄 — 넘치면 '…', 마우스를 올리면 전체(그리드와 같은 dt-cell 규칙) */
                  <tr key={g.col}>
                    <td className="dt-cell fw-600"><div style={{ maxWidth: 200 }} title={g.col}>{g.col}{g.req && <span style={{ color: 'var(--neg-ink)' }}> *</span>}</div></td>
                    <td className="dt-cell text-sm"><div style={{ maxWidth: 320 }} title={g.how}>{g.how}</div></td>
                    <td className={`dt-cell text-sm text-muted${g.num ? ' num' : ''}`}><div style={{ maxWidth: 180 }} title={g.ex}>{g.ex}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {guide.some(g => g.req) && <div className="text-xs text-muted2" style={{ marginTop: 6 }}>* 필수 항목</div>}
        </div>
      )}
    </div>
    <div className="row gap-8" style={{ borderTop: '1px solid var(--line)', paddingTop: 16, alignItems: 'center' }}>
      <span className="text-sm text-muted">{nextLead || (onDownload ? '양식 작성을 마쳤으면' : '파일을 준비했으면')}</span>
      <button className={`btn ml-auto${onDownload ? '' : ' primary'}`} onClick={onNext}>
        다음 단계 — 파일 업로드 <Icon.Right size={14}/>
      </button>
    </div>
  </div>
)

/* 양식 받기 — 인증 헤더가 필요해서 <a href> 로는 안 되고 blob 으로 받아 저장한다 */
export const downloadWithAuth = async (url, name) => {
  const token = localStorage.getItem('token')
  const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
  if (!res.ok) throw new Error('양식 다운로드에 실패했어요')
  const blob = await res.blob()
  const href = URL.createObjectURL(blob); const a = document.createElement('a')
  a.href = href; a.download = name; a.click(); URL.revokeObjectURL(href)
}

/**
 * 마지막 단계 — **등록 결과.** 거래내역 엑셀 업로드의 결과 화면을 공용으로 뺀 것이다.
 *   ① 몇 건 등록 · 등록 불가 몇 건 + [〈목록〉에서 보기] [새 파일 업로드]
 *   ② extra — 다음 할 일(대사 안내 등)
 *   ③ 거래처 — 새로 등록한 곳 / 기존에 연결한 곳 / 미지정(이름이 같은 거래처가 여럿)
 *   ④ 업로드 내역 — 줄마다 등록·제외·등록 불가(이유). 거르기·찾기
 * 예전엔 공용 마법사(세금계산서·카드 명세서·기준정보)만 "반영됐어요 N건" 한 장이라,
 * 어느 줄이 왜 빠졌는지 볼 길이 없었다(2026-10-02 사용자).
 *
 * @param headline   굵은 첫 줄(예: '39건이 등록됐어요')
 * @param noCount    등록 불가 건수
 * @param viewLabel / onView   목록으로 가는 버튼
 * @param vendors    { created[], linked[{from,to}], existing[], unclear[] } — null 이면 거래처 카드를 안 그린다
 * @param vendorNote 거래처 카드 아래 한 줄(노드)
 * @param rows / columns / rowKey   업로드 내역 표(DataTable)
 * @param isOk(row)  등록된 줄인가 — 거르기 칩과 붉은 줄에 쓴다
 * @param searchOf(row) 찾기 대상 글자 / searchPlaceholder
 * @param rowDetail(row) (선택) 줄을 누르면 아래에 펼칠 내용(품목 등). columns 를 함수로 주면 (isOpen) => columns — '외 N건 ▾' 표시용
 */
export const ImportResultView = ({ headline, noCount = 0, viewLabel, onView, onAgain, extra, vendors, vendorNote,
  rows = [], columns, rowKey, isOk, searchOf, searchPlaceholder = '검색', rowDetail }) => {
  const [show, setShow] = useState('all')   // all | ok | no
  const [openKeys, setOpenKeys] = useState(() => new Set())   // 펼친 줄
  const isOpen = (r) => openKeys.has(rowKey(r))
  const toggle = (r) => setOpenKeys(s => { const n = new Set(s), k = rowKey(r); n.has(k) ? n.delete(k) : n.add(k); return n })
  const [q, setQ] = useState('')
  const ok = rows.filter(isOk), no = rows.filter(r => !isOk(r))
  const kw = q.trim().toLowerCase()
  const list = (show === 'ok' ? ok : show === 'no' ? no : rows)
    .filter(r => !kw || String(searchOf?.(r) || '').toLowerCase().includes(kw))
  const chips = (label, names, tone = 'outline') => (
    <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
      {names.length ? names.map(n => <span key={n} className={`badge ${tone}`}>{n}</span>) : <span className="text-sm text-muted2">없음</span>}
    </div>
  )
  return (
    <div className="col gap-16 fade-up">
      <div className="card card-pad row gap-16" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--pos-soft)', color: 'var(--pos)', display: 'grid', placeItems: 'center' }}><Icon.Check size={22}/></div>
        <div>
          <div className="fw-700" style={{ fontSize: 16 }}>{headline}</div>
          <div className="text-sm text-muted" style={{ marginTop: 2 }}>
            {noCount > 0 ? `등록 불가 ${noCount}건 — 아래 업로드 내역에서 확인할 수 있습니다` : '업로드한 행이 모두 등록됐습니다'}
          </div>
        </div>
        <div className="row gap-8 ml-auto">
          {onView && <button className="btn" onClick={onView}>{viewLabel}</button>}
          <button className="btn primary" onClick={onAgain}>새 파일 업로드</button>
        </div>
      </div>

      {extra}

      {/* 거래처 — 새로 만든 곳·이어 붙인 곳. 오타로 생긴 거래처는 여기서 바로 눈에 띈다 */}
      {vendors && (
        <div className="card card-pad col gap-12">
          <div className="section-title">거래처</div>
          <div className="form-grid-2">
            <div>
              <div className="text-sm fw-700">거래처 자동 등록 (신규) {vendors.created.length}곳</div>
              <div className="text-xs text-muted2" style={{ margin: '2px 0 6px' }}>미등록 거래처를 신규 등록했습니다</div>
              {chips('created', vendors.created)}
            </div>
            <div>
              <div className="text-sm fw-700">거래처 자동 매칭 {(vendors.linked || []).length + vendors.existing.length}곳</div>
              <div className="text-xs text-muted2" style={{ margin: '2px 0 6px' }}>
                기존 거래처에 연결했습니다{(vendors.linked || []).length ? ` — ${vendors.linked.length}곳은 법인 표기·띄어쓰기 차이` : ''}
              </div>
              <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                {(vendors.linked || []).map(l => <span key={l.from} className="badge outline">{l.from} → {l.to}</span>)}
                {vendors.existing.map(n => <span key={n} className="badge outline">{n}</span>)}
                {!(vendors.linked || []).length && !vendors.existing.length && <span className="text-sm text-muted2">없음</span>}
              </div>
            </div>
            {(vendors.unclear || []).length > 0 && (
              <div>
                <div className="text-sm fw-700">{vendors.unclearTitle || '거래처 미지정'} {vendors.unclear.length}곳</div>
                <div className="text-xs text-muted2" style={{ margin: '2px 0 6px' }}>{vendors.unclearHelp || '거래처로 연결하지 못했습니다 — 목록에서 지정해 주세요'}</div>
                {chips('unclear', vendors.unclear, vendors.unclearTone || 'warn')}
              </div>
            )}
          </div>
          {vendorNote}
        </div>
      )}

      {/* 올린 줄 전부 — 거르기·찾기 */}
      <div className="card">
        <div className="row gap-8" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="section-title">업로드 내역</div>
          <div className="row gap-6" style={{ marginLeft: 8 }}>
            {[['all', `전체 ${rows.length}`], ['ok', `등록 ${ok.length}`], ['no', `등록 불가 ${no.length}`]].map(([v, l]) => (
              <button key={v} className={`chip ${show === v ? 'active' : ''}`} onClick={() => setShow(v)}>{l}</button>
            ))}
          </div>
          <div className="search tbar-search ml-auto">
            <Icon.Search size={14}/>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={searchPlaceholder}/>
          </div>
        </div>
        <DataTable rows={list} rowKey={rowKey} maxHeight={520} empty="해당 내역이 없습니다."
          rowClass={r => (isOk(r) ? undefined : 'imp-err')} columns={typeof columns === 'function' ? columns(isOpen) : columns}
          onRowClick={rowDetail ? (r => { if (rowDetail(r)) toggle(r) }) : undefined}
          renderExpanded={rowDetail ? (r => (isOpen(r) ? <div style={{ padding: '8px 16px 12px 56px', background: 'var(--surface-2)' }}>{rowDetail(r)}</div> : null)) : undefined}/>
      </div>
    </div>
  )
}
