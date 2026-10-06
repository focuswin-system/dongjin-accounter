import { useState, useEffect, useRef } from 'react'
import { Icon } from '../ui'
import { fileKind, UPLOAD_ACCEPT } from '../fileKinds'

/**
 * 증빙 판 — **왼쪽 서류 목록, 오른쪽 미리보기.** (2026-09-29 사용자: "좌측에 서류 리스트, 우측에 미리보기")
 * 설계: popup-attachments-print §3-2
 *
 * 예전엔 서류가 아이콘 줄이었고 눌러야 새 탭으로 열렸다 — 무엇이 붙었는지 눈으로 확인하려면
 * 파일마다 탭을 오갔다. 여기서는 고르면 옆에 바로 뜬다(이미지·PDF). 엑셀·한글은 내려받기.
 *
 * @param files     [{ id, url, name, kind?, size, source_label? }] — lib/attachments.js 모양
 * @param onUpload  (File) => Promise — 없으면 올리기 칸을 안 그린다(읽기 전용)
 * @param onRemove  (file) => Promise — 없으면 지우기 버튼을 안 그린다
 * @param canRemove (file) => boolean — 지울 수 있는 것만(예: 거래 팝업에서 청구서 서류는 청구서에서 지운다)
 * @param height    판 높이(px) — 미리보기가 이 안에서 스크롤한다
 */
export const AttachmentPanel = ({ files = [], onUpload, onRemove, canRemove = () => true, height = 520, empty = '붙은 서류가 없어요' }) => {
  const [sel, setSel] = useState(0)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const inputRef = useRef(null)
  // 목록이 바뀌어(지우기) 고른 번호가 넘치면 마지막으로
  useEffect(() => { if (sel >= files.length) setSel(Math.max(0, files.length - 1)) }, [files.length, sel])
  const cur = files[sel] || null

  const upload = async (list) => {
    if (!onUpload || !list?.length) return
    setBusy(true)
    try { for (const f of list) await onUpload(f) } finally { setBusy(false) }
  }

  return (
    <div className="att-panel" style={{ height }}>
      <div className="att-list">
        {files.length === 0 && <div className="text-sm text-muted" style={{ padding: '18px 14px' }}>{empty}</div>}
        {files.map((f, i) => {
          const k = f.kind || fileKind(f.name || f.url)
          return (
            <button key={f.id || f.url || i} type="button" className={`att-item${i === sel ? ' active' : ''}`}
              onClick={() => setSel(i)} title={f.name}>
              <span className="att-ico">{k === 'image' ? <Icon.Image size={16}/> : <Icon.File size={16}/>}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="att-name">{f.name || '첨부 파일'}</span>
                <span className="text-xs text-muted2">
                  {[f.source_label, k === 'pdf' ? 'PDF' : k === 'image' ? '이미지' : '파일', f.size ? `${Math.round(f.size / 1024)}KB` : '']
                    .filter(Boolean).join(' · ')}
                </span>
              </span>
            </button>
          )
        })}
        {onUpload && (
          <label className={`att-drop${over ? ' over' : ''}`}
            onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
            onDrop={e => { e.preventDefault(); setOver(false); upload([...e.dataTransfer.files]) }}>
            <Icon.Upload size={16}/>
            <span>{busy ? '올리는 중…' : '서류 추가'}</span>
            <span className="text-xs text-muted2">끌어 놓거나 눌러서 · 사진·PDF</span>
            <input ref={inputRef} type="file" multiple accept={UPLOAD_ACCEPT} style={{ display: 'none' }}
              onChange={e => { upload([...e.target.files]); e.target.value = '' }}/>
          </label>
        )}
      </div>

      <div className="att-view">
        {cur ? (
          <>
            <div className="att-view-head">
              <span className="fw-600 truncate" style={{ minWidth: 0 }}>{cur.name}</span>
              <div className="row gap-4 ml-auto" style={{ flexShrink: 0 }}>
                <a className="btn ghost sm" href={cur.url} download={cur.name} title="다운로드"><Icon.Download size={14}/></a>
                {onRemove && canRemove(cur) && (
                  <button className="btn ghost sm" style={{ color: 'var(--neg-ink)' }} title="지우기"
                    onClick={() => onRemove(cur)}><Icon.Trash size={14}/></button>
                )}
              </div>
            </div>
            <div className="att-view-body">
              <Preview file={cur}/>
            </div>
          </>
        ) : (
          <div className="att-view-empty text-sm text-muted">
            {onUpload ? '왼쪽에서 서류를 추가하면 여기에 보여요' : '미리 볼 서류가 없어요'}
          </div>
        )}
      </div>
    </div>
  )
}

const Preview = ({ file }) => {
  const k = file.kind || fileKind(file.name || file.url)
  if (k === 'image') return <img className="att-img" src={file.url} alt={file.name}/>
  if (k === 'pdf') return <PdfPages url={file.url}/>
  return (
    <div className="att-view-empty text-sm text-muted">
      이 형식은 미리 볼 수 없어요. 다운로드해 열어 주세요.
    </div>
  )
}

/* pdf.js 를 한 번만 불러 둔다. legacy 빌드 — 사무실의 오래된 브라우저에서도 돈다
   (최신 빌드는 Promise.withResolvers 를 요구한다. 설계 검토 §8) */
let pdfjsPromise = null
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default
      return lib
    }).catch(e => { pdfjsPromise = null; throw e })
  }
  return pdfjsPromise
}

/* PDF 한 벌을 쪽 이미지로 — 화면 미리보기와 인쇄 마법사가 같이 쓴다.
   캔버스는 한 쪽에 수 MB 라 그리자마자 그림(objectURL)으로 바꾸고 버린다(설계 검토 §8).
   /uploads 는 쿠키로 열리는 같은 출처 주소라 fetch 로 받는다 — iframe 은 서버 CSP(sandbox)에 막힌다. */
export async function renderPdfPages(url, { scale = 1.5, maxPages = 30 } = {}) {
  const pdfjs = await loadPdfjs()
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`PDF 를 받지 못했어요 (${res.status})`)
  const doc = await pdfjs.getDocument({ data: await res.arrayBuffer() }).promise
  const out = []
  // 중간에 실패하면 이미 만든 그림도 버린다 — 부르는 쪽은 실패만 받으니 해제할 길이 없다
  try {
    const n = Math.min(doc.numPages, maxPages)
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i)
      const vp = page.getViewport({ scale })
      const c = document.createElement('canvas')
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height)
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise
      const blob = await new Promise(r => c.toBlob(r, 'image/png'))
      c.width = 0; c.height = 0
      // 너무 큰 쪽(도면 등)은 브라우저 캔버스 한도를 넘어 blob 이 비어 온다
      if (!blob) throw new Error('쪽이 너무 커서 그리지 못했어요')
      out.push({ src: URL.createObjectURL(blob), w: vp.width, h: vp.height })
      page.cleanup()
    }
    return { pages: out, total: doc.numPages }
  } catch (e) {
    out.forEach(pg => URL.revokeObjectURL(pg.src))
    throw e
  } finally {
    doc.destroy()
  }
}

const PdfPages = ({ url }) => {
  const [st, setSt] = useState({ loading: true })
  useEffect(() => {
    let alive = true, made = []
    setSt({ loading: true })
    renderPdfPages(url)
      .then(r => { made = r.pages; if (alive) setSt({ pages: r.pages, total: r.total }); else r.pages.forEach(p => URL.revokeObjectURL(p.src)) })
      .catch(e => { if (alive) setSt({ error: e.message || 'PDF 를 열지 못했어요' }) })
    return () => { alive = false; made.forEach(p => URL.revokeObjectURL(p.src)) }
  }, [url])
  if (st.loading) return <div className="att-view-empty text-sm text-muted">PDF 를 여는 중…</div>
  if (st.error) return <div className="att-view-empty text-sm text-muted">{st.error}</div>
  return (
    <div className="col gap-12">
      {st.pages.map((p, i) => <img key={i} className="att-pdf-page" src={p.src} alt={`${i + 1}쪽`}/>)}
      {st.total > st.pages.length && (
        <div className="text-xs text-muted" style={{ textAlign: 'center' }}>앞 {st.pages.length}쪽만 보여요 (전체 {st.total}쪽)</div>
      )}
    </div>
  )
}
