import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Icon, Drawer, useToast, useConfirm } from '../ui'
import { DrawerHead } from './Drawer'
import { VoucherSlip } from './VoucherSlip'
import { renderPdfPages } from './AttachmentPanel'
import { api } from '../api'
// Docs 화면도 이 파일을 부르지만, 쓰는 건 함수 실행 때라 순환이 문제되지 않는다
import { ResolutionDocument } from '../../screens/Docs'

/**
 * 인쇄 양식 편집기 — 양식(전표·결의서…)과 걸린 증빙(사진·PDF)을 **쪽 위에 직접 놓아** 한 번에 뽑는다.
 * 설계: docs/02-design/features/popup-attachments-print.design.md §5, §5-1
 *
 * ── 모양 ──
 * 쪽(A4 인쇄 영역 178×264mm)마다 양식이 바탕이거나 비어 있고, 그 위에 **상자**(사진 1장 또는 PDF 1쪽)를 놓는다.
 *   상자 = { id, ref, page, x, y, w, rot } (mm). 높이는 그림 비율에서 나온다(비율 고정).
 *   양식은 고치지 않는다 — 높이를 실측해 그 **아래 남는 자리**를 쓴다(결의서 아래 영수증 — 2026-10-02 사용자).
 * 열면 자동 배치, 손보면 문서별로 서버에 저장한다(lib/printLayouts.js). 다시 열면 그대로.
 *
 * ── 인쇄 방식 ──
 * 종이 묶음(.print-bundle)을 body 바로 아래로 띄워(포털) 두고, 인쇄하는 동안만(beforeprint~afterprint) **body 의 다른 자식을
 * 인라인 !important 로 숨긴다.** 화면 뒤에 열린 전표 팝업(.voucher-print)도 인쇄 화이트리스트라
 * CSS 만으로는 같이 찍힌다 — 인라인 !important 는 스타일시트 !important 보다 세다.
 * ⚠ .print-bundle 은 index.css @media print 화이트리스트 5곳 + 흰 종이 목록에 등록돼 있다.
 * 편집 화면과 종이는 **같은 쪽 부품(Sheet)** 을 mm 단위로 그린다 — 화면에서 본 자리가 종이의 자리다.
 *
 * ── 양식 ──
 * 새로 그리지 않는다 — 지금 인쇄 부품(VoucherSlip·ResolutionDocument)을 그대로 쓰거나,
 * 화면에 떠 있는 종이(#resolution-print)를 그대로 복사한다(domForm).
 *
 * @param forms     [{ key, label, get: () => Promise<ReactNode|null> }] — 기본으로 전부 켠다. 못 불러오면 throw(없음과 구분)
 * @param getFiles  () => Promise<file[]>  lib/attachments.js shape 모양({ url, name, kind, source_label }). 실패면 throw
 * @param layoutKey { ownerType, ownerId } — 배치를 저장할 문서. 없으면 저장 없이 매번 자동 배치
 *
 * ⚠ 실패를 '없음'으로 삼키지 않는다 — 증빙을 못 불러왔는데 "붙은 증빙이 없어요"로 보이면
 *   결의서만 든 묶음이 결재용으로 나간다(2026-10-02 검토 P1).
 */
const PDF_SCALE = 150 / 72          // 150dpi
const PDF_WARN = 20
const PDF_MAX = 60                  // 이보다 긴 PDF 는 앞쪽만 — 목록에 밝힌다

// 쪽 치수(mm) — @page 여백 16mm 를 뺀 A4 인쇄 영역. 높이는 1mm 덜(꽉 채우면 반올림으로 빈 장이 낀다)
const PW = 178, PH = 264
const GAP = 4                       // 상자 사이
const CAP_H = 6                     // 설명 줄 높이
const MIN_W = 50                    // 옆자리로 칠 최소 폭
/* 자동 배치가 이보다 작게 줄이지 않는다 — **긴 변** 기준. 폭으로 재면 세로로 긴 영수증(폭이 원래 좁다)이
   결의서 아래 빈자리에 못 들어갔다(2026-10-02: 79mm 자리에 폭 38mm·높이 73mm — 충분히 읽힌다) */
const MIN_LONG = 70
const MIN_REGION = 50               // 양식 아래 이보다 낮으면 빈자리로 안 친다
const HALF = (PH - GAP) / 2

/* ── 양식 만들기 도우미 — 부르는 화면이 골라 쓴다 ── */
export const voucherForm = ({ txnId, voucher, label = '전표' }) => ({
  key: `voucher-${txnId || voucher?.id || 'v'}`, label,
  get: async () => {
    const v = voucher || (txnId ? await api.getTransactionVoucher(txnId) : null)
    if (!v) throw new Error('전표를 불러오지 못했어요')
    return <div className="doc-paper pb-form-paper"><VoucherSlip v={v}/></div>
  },
})
export const resolutionForm = ({ id, docNo }) => ({
  key: `reso-${id}`, label: `지급결의서${docNo ? ' ' + docNo : ''}`,
  get: async () => {
    const [doc, company] = await Promise.all([api.getResolution(id), api.getCompany()])
    if (!doc) throw new Error('결의서를 불러오지 못했어요')
    return <ResolutionDocument doc={doc} company={company}/>
  },
})
/** 화면에 떠 있는 종이를 그대로 — 품의서·정산서처럼 종이 부품이 화면 안에 묶여 있는 문서 */
export const domForm = ({ selector = '#resolution-print', key = 'paper', label }) => ({
  key, label,
  get: async () => {
    const el = document.querySelector(selector)
    if (!el) return null
    const c = el.cloneNode(true)
    // 원본과 겹치지 않게 — 같은 id·인쇄 클래스가 둘이면 일반 Ctrl+P 규칙이 꼬인다
    c.removeAttribute('id'); c.classList.remove('resolution-print')
    c.querySelectorAll('.no-print, input[type=file]').forEach(n => n.remove())
    return <div dangerouslySetInnerHTML={{ __html: c.outerHTML }}/>
  },
})

/** 문서 증빙 목록 — 실패는 throw(마법사가 '못 불러옴'으로 보인다) */
export const docFiles = (ownerType, id) => () => api.getDocAttachments(ownerType, id).then(r => {
  if (r.error) throw new Error(r.error)
  return r.files
})

/* ── 배치 계산 ── */
let seq = 0
const uid = (p) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`
const printable = (f) => f.kind === 'image' || f.kind === 'pdf'
/* 저장본의 상자 열쇠 — 파일 URL 을 그대로 쓰지 않는다. 배치는 문서를 볼 수 있으면 누구나 읽는데,
   만든 사람은 청구서 권한이 있어 세금계산서 증빙 URL 이 남을 수 있다(검토 P2-6). 되돌릴 수 없는 짧은 해시로 */
const refOf = (url) => {
  let h = 0x811c9dc5
  for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  let h2 = 0
  for (let i = url.length - 1; i >= 0; i--) { h2 = (Math.imul(h2, 31) + url.charCodeAt(i)) >>> 0 }
  return 'f' + h.toString(36) + h2.toString(36)
}
/** 돌린 뒤의 세로/가로 비 */
const arOf = (u, rot) => (rot === 90 || rot === 270 ? 1 / u.ar : u.ar)
/** 상자 높이(mm) */
const boxH = (it, u, cap) => it.w * arOf(u, it.rot) + (cap ? CAP_H : 0)
/** rw×rh 안에 들어가는 가장 큰 폭 */
const fitW = (rw, rh, ar, cap) => Math.max(0, Math.min(rw, (rh - (cap ? CAP_H : 0)) / ar))

/**
 * 자동 배치 — 설계 §5-1
 *   1) 양식 아래 빈자리(높이 MIN_REGION 이상)에 들어가는 사진부터(긴 변 MIN_LONG 이상으로 들어갈 때만)
 *   2) 나머지 사진은 새 쪽을 위·아래 반으로 나눠 담는다(좁으면 옆으로도)
 *   3) PDF 쪽·큰 문서 사진은 한 장에 꽉
 * @param formPages  [{ id, kind:'form', form }]  — 그대로 앞에 둔다
 * @param formH      { key: 높이mm }
 * @param units      놓을 것(순서대로)
 */
function autoLayout(formPages, formH, units, cap) {
  const pages = [...formPages], items = [], regions = []
  for (const pg of formPages) {
    const h = formH[pg.form]
    if (h == null || h > PH) continue
    const y = Math.ceil(h + GAP * 2)
    if (PH - y >= MIN_REGION) regions.push({ page: pg.id, x: 0, y, w: PW, h: PH - y })
  }
  const newPage = () => { const id = uid('p'); pages.push({ id, kind: 'blank' }); return id }
  const put = (u, r) => {
    const w = fitW(r.w, r.h, u.ar, cap)
    if (Math.max(w, w * u.ar) < MIN_LONG) return false
    const h = w * u.ar + (cap ? CAP_H : 0)
    // 빈자리가 넓으면 가운데가 아니라 왼쪽부터 — 옆에 다음 것이 들어갈 자리를 남긴다
    items.push({ id: uid('b'), ref: u.ref, page: r.page, x: r.x, y: r.y, w, rot: 0 })
    /* ⚠ 다음 줄은 **이 줄에서 가장 키 큰 상자** 아래에서 — 방금 놓은 상자 높이로 내리면 앞의 세로 영수증을
       다음 줄 사진이 덮었다(2026-10-02 검토 P1). 줄 높이가 칸 높이를 넘지 않게도 본다 */
    r.rowH = Math.max(r.rowH || 0, h)
    if (r.w - w - GAP >= MIN_W) { r.x += w + GAP; r.w -= w + GAP; }
    else if (r.h - r.rowH - GAP >= MIN_REGION) { r.y += r.rowH + GAP; r.h -= r.rowH + GAP; r.x = r.x0 ?? 0; r.w = r.w0 ?? PW; r.rowH = 0 }
    else r.dead = true
    return true
  }
  for (const u of units) {
    if (u.full) {
      const page = newPage(), w = fitW(PW, PH, u.ar, cap)
      items.push({ id: uid('b'), ref: u.ref, page, x: (PW - w) / 2, y: 0, w, rot: 0 })
      continue
    }
    let ok = regions.some(r => !r.dead && put(u, r))
    if (!ok) {
      const page = newPage()
      const top = { page, x: 0, y: 0, w: PW, h: HALF, x0: 0, w0: PW }
      const bottom = { page, x: 0, y: HALF + GAP, w: PW, h: HALF, x0: 0, w0: PW }
      regions.push(top, bottom)
      ok = put(u, top)
      if (!ok) {   // 반쪽에도 못 들어가는 길쭉한 것 — 한 장을 다 준다
        top.dead = bottom.dead = true
        const w = fitW(PW, PH, u.ar, cap)
        items.push({ id: uid('b'), ref: u.ref, page, x: (PW - w) / 2, y: 0, w, rot: 0 })
      }
    }
  }
  return { pages, items }
}

const pdfLabel = (src) => {
  if (src.error) return 'PDF 를 그리지 못했어요'
  if (!src.total) return 'PDF'
  return src.total > src.units.length ? `PDF ${src.total}쪽 · 앞 ${src.units.length}쪽만` : `PDF ${src.total}쪽`
}
const loadImage = (url) => new Promise((resolve, reject) => {
  const im = new Image()
  im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight })
  im.onerror = () => reject(new Error('그림을 불러오지 못했어요'))
  im.src = url
})

export const PrintWizard = ({ open, onClose, title = '인쇄', forms = [], getFiles, layoutKey }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [formNodes, setFormNodes] = useState(null)      // { key: node|null }
  const [formErr, setFormErr] = useState({})
  const [formH, setFormH] = useState(null)              // { key: mm }
  const [sources, setSources] = useState(null)          // 파일별 [{ file, units:[{ ref, src, ar, full, label }], error, total }]
  const [filesErr, setFilesErr] = useState('')
  const [saved, setSaved] = useState(undefined)         // 서버 배치(undefined=불러오는 중, null=없음)
  const [layout, setLayout] = useState(null)            // { pages, items, removed, cap }
  const [sel, setSel] = useState(null)                  // 고른 상자 id
  const [saveState, setSaveState] = useState('')        // '' | 'saving' | 'saved' | 'error'
  const [reload, setReload] = useState(0)
  const [progress, setProgress] = useState('')        // PDF 그리는 중 표시
  const [loadErr, setLoadErr] = useState('')          // 저장된 배치를 못 불러옴 — 이때는 저장하지 않는다
  const madeUrls = useRef([])
  const alive = useRef(true)
  const measureRef = useRef(null)
  const dirty = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // ── 1. 모으기: 양식 · 첨부(그림 크기·PDF 쪽) · 저장된 배치 ──
  useEffect(() => {
    if (!open) return
    let live = true
    setFormNodes(null); setFormErr({}); setFormH(null); setSources(null); setFilesErr(''); setLayout(null); dirty.current = false
    const errs = {}
    Promise.all(forms.map(f => f.get().catch(e => { errs[f.key] = e?.message || '불러오지 못했어요'; return null }))).then(nodes => {
      if (!live) return
      const m = {}; forms.forEach((f, i) => { m[f.key] = nodes[i] })
      setFormNodes(m); setFormErr(errs)
    })
    ;(getFiles ? getFiles() : Promise.resolve([])).then(async fs => {
      const out = []
      const list = fs || [], nPdf = list.filter(f => f.kind === 'pdf').length
      let kPdf = 0
      for (const f of list) {
        if (!printable(f)) { out.push({ file: f, units: [], off: true }); continue }
        try {
          if (f.kind === 'image') {
            const d = await loadImage(f.url)
            // 가로 1200px 넘는 세로형 사진은 문서를 찍은 것 — 한 장을 다 준다
            out.push({ file: f, units: [{ ref: refOf(f.url), src: f.url, ar: d.h / d.w, full: d.w >= 1200 && d.h / d.w >= 1.2, file: f, label: f.name }] })
          } else {
            if (live) setProgress(`PDF 그리는 중 ${++kPdf}/${nPdf}`)
            if (!live) return
            const r = await renderPdfPages(f.url, { scale: PDF_SCALE, maxPages: PDF_MAX })
            if (!live || !alive.current) { r.pages.forEach(pg => URL.revokeObjectURL(pg.src)); return }
            madeUrls.current.push(...r.pages.map(pg => pg.src))
            out.push({ file: f, total: r.total, units: r.pages.map((pg, k) => ({
              ref: `${refOf(f.url)}#p${k + 1}`, src: pg.src, ar: pg.h / pg.w, full: true, file: f,
              label: r.total > 1 ? `${f.name} (${k + 1}/${r.total}쪽)` : f.name })) })
          }
        } catch { out.push({ file: f, units: [], error: true }) }
      }
      if (live) { setSources(out); setProgress('') }
    }).catch(e => { if (live) { setSources([]); setFilesErr(e?.message || '증빙을 불러오지 못했어요') } })
    if (layoutKey) {
      setSaved(undefined); setLoadErr('')
      api.getPrintLayout(layoutKey.ownerType, layoutKey.ownerId).then(r => {
        if (!live) return
        if (r?.error) setLoadErr(r.error)    // 실패를 '없음'으로 삼키면 손대는 순간 남이 손본 배치를 덮는다
        setSaved(r?.layout || null)
      })
    } else setSaved(null)
    return () => { live = false }
  }, [open, reload])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── 2. 양식 높이 실측(mm) — 숨긴 자리에 실제 폭(178mm)으로 그려 잰다 ──
  useLayoutEffect(() => {
    if (!formNodes || !measureRef.current) return
    const m = {}
    for (const el of measureRef.current.children) {
      const mmPerPx = PW / el.getBoundingClientRect().width
      m[el.dataset.k] = el.getBoundingClientRect().height * mmPerPx
    }
    setFormH(m)
  }, [formNodes])

  const units = useMemo(() => (sources || []).flatMap(s => s.units), [sources])
  const unitOf = useMemo(() => Object.fromEntries(units.map(u => [u.ref, u])), [units])
  const formPagesOf = (on) => forms.filter(f => formNodes?.[f.key] && on(f)).map(f => ({ id: `f-${f.key}`, kind: 'form', form: f.key }))

  // ── 3. 배치 — 저장된 것이 있으면 맞춰 쓰고(새 첨부만 자동), 없으면 자동 ──
  useEffect(() => {
    if (layout || !formNodes || !formH || !sources || saved === undefined) return
    const cap = saved?.cap ?? true
    const failed = Object.keys(formErr).length > 0 || !!filesErr
    if (saved && Array.isArray(saved.pages)) {
      /* 양식은 **끈 것만** 빠진다(formsOff) — 저장본에 없다고 끈 걸로 치면, 한 번 불러오기 실패나 나중에 연결된
         결의서가 영영 꺼진 채 저장됐다(검토 P1-3). 못 불러온 양식의 쪽은 이번엔 안 보일 뿐 저장본에선 지우지 않는다 */
      const formsOff = saved.formsOff || []
      let pages = saved.pages.filter(p => p.kind === 'blank' || (p.kind === 'form' && formNodes[p.form]))
      const missing = formPagesOf(f => !formsOff.includes(f.key) && !pages.some(p => p.form === f.key))
      if (missing.length) pages = [...missing, ...pages]
      // 한 장을 넘게 된 양식 위의 상자는 찍히지 않는다 — 다시 놓는다(검토 P1-4)
      const longIds = new Set(pages.filter(p => p.kind === 'form' && (formH[p.form] ?? 0) > PH).map(p => p.id))
      const ids = new Set(pages.filter(p => !longIds.has(p.id)).map(p => p.id))
      const items = (saved.items || []).filter(it => unitOf[it.ref] && ids.has(it.page))
      const removed = (saved.removed || []).filter(r => unitOf[r])
      const known = new Set([...items.map(i => i.ref), ...removed])
      const fresh = units.filter(u => !known.has(u.ref))
      const add = fresh.length ? autoLayout([], formH, fresh, cap) : { pages: [], items: [] }
      setLayout({ pages: [...pages, ...add.pages], items: [...items, ...add.items], removed, cap, formsOff })
      if ((fresh.length || missing.length) && !failed) dirty.current = true
    } else {
      const auto = autoLayout(formPagesOf(() => true), formH, units, cap)
      setLayout({ ...auto, removed: [], cap, formsOff: [] })
    }
  }, [formNodes, formH, sources, saved])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── 4. 저장 — 손본 뒤 0.8초 조용하면. 닫을 때 남은 것은 바로 ──
  /* ⚠ 무언가를 못 불러온 채(배치·증빙·양식)로는 저장하지 않는다 — 보이는 것만으로 저장하면
     못 불러온 쪽·상자가 저장본에서 지워진다(검토 P1-3, P2-2) */
  const blocked = !!loadErr || !!filesErr || Object.keys(formErr).length > 0
  const change = useCallback((fn) => { dirty.current = true; setLayout(l => (l ? fn(l) : l)) }, [])
  const pending = useRef(null)
  const flush = () => {
    const p = pending.current; pending.current = null
    if (!p) return
    clearTimeout(p.t)
    api.savePrintLayout(layoutKey.ownerType, layoutKey.ownerId, p.layout)
      .then(r => { if (alive.current) setSaveState(r.ok ? 'saved' : 'error') })
  }
  useEffect(() => {
    if (!layout || !layoutKey || !dirty.current || blocked) return
    setSaveState('saving')
    if (pending.current) clearTimeout(pending.current.t)
    pending.current = { layout, t: setTimeout(flush, 800) }
  }, [layout])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => flush(), [])   // eslint-disable-line react-hooks/exhaustive-deps

  // 닫으면 그린 쪽 그림을 버린다(쪽마다 수 MB)
  useEffect(() => () => { madeUrls.current.forEach(u => URL.revokeObjectURL(u)); madeUrls.current = [] }, [])

  /* 인쇄 동안 body 의 다른 자식(앱·팝업)을 숨긴다 — [인쇄] 버튼뿐 아니라 **Ctrl+P 도** 같은 길로.
     beforeprint/afterprint 로 걸어 두면 print() 가 바로 돌아오는 브라우저(모바일)에서도 미리보기 동안 유지된다.
     같은 이유로 용지는 A4 세로로 못 박는다 — 가로 인쇄 화면(printOrientation)과 함께 떠 있어도 묶음은 세로다. */
  useEffect(() => {
    if (!open) return
    let hidden = null, page = null
    const before = () => {
      // 묶음이 아직 없으면(준비 전) 숨기지 않는다 — 다 숨기면 백지가 나온다
      if (hidden || !document.querySelector('.print-bundle')) return
      hidden = []
      for (const el of document.body.children) {
        if (el.classList.contains('print-bundle')) continue
        hidden.push([el, el.style.getPropertyValue('display'), el.style.getPropertyPriority('display')])
        el.style.setProperty('display', 'none', 'important')
      }
      page = document.createElement('style')
      page.textContent = '@page { size: A4 portrait; margin: 16mm; }'
      document.head.appendChild(page)
    }
    const after = () => {
      if (!hidden) return
      for (const [el, v, p] of hidden) { if (v) el.style.setProperty('display', v, p); else el.style.removeProperty('display') }
      hidden = null; page?.remove(); page = null
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); after() }
  }, [open])

  // Delete 키 — 고른 상자를 뺀다
  useEffect(() => {
    if (!sel) return
    const onKey = (e) => {
      if (e.key === 'Delete' && !/input|textarea|select|button/i.test(e.target.tagName)) { e.preventDefault(); removeItem(sel) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })   // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  const ready = !!layout
  const cap = layout?.cap ?? true
  const placed = new Map((layout?.items || []).map(it => [it.ref, it]))
  const pageNo = (pid) => (layout?.pages.findIndex(p => p.id === pid) ?? -1) + 1
  const longForm = (p) => p.kind === 'form' && (formH?.[p.form] ?? 0) > PH

  /* ── 편집 동작 ── */
  const patchItem = (id, p) => change(l => ({ ...l, items: l.items.map(it => (it.id === id ? { ...it, ...p } : it)) }))
  const removeItem = (id) => {
    change(l => {
      const it = l.items.find(x => x.id === id)
      return { ...l, items: l.items.filter(x => x.id !== id), removed: it ? [...l.removed.filter(r => r !== it.ref), it.ref] : l.removed }
    })
    setSel(null)
  }
  /** 쪽 안으로 — 옮길 땐 자리를, 크기를 바꿀 땐(fixPos) 폭을 맞춘다 */
  const clamp = (it, u, fixPos = false) => {
    const ar = arOf(u, it.rot), c = cap ? CAP_H : 0
    let w = Math.min(it.w, PW, (PH - c) / ar)
    if (fixPos) w = Math.min(w, PW - it.x, (PH - c - it.y) / ar)
    const h = w * ar + c
    return { ...it, w, x: Math.min(Math.max(0, it.x), PW - w), y: Math.min(Math.max(0, it.y), Math.max(0, PH - h)) }
  }
  /** 상자를 앞·뒤 쪽으로 — 한 장을 넘는 양식 쪽은 건너뛴다(위에 놓을 수 없다). 끝이면 뒤에 빈 쪽을 만든다 */
  const shiftPage = (it, d) => change(l => {
    const ok = l.pages.filter(p => !longForm(p))
    let j = ok.findIndex(p => p.id === it.page) + d
    let pages = l.pages
    if (j < 0) return l
    if (j >= ok.length) { const np = { id: uid('p'), kind: 'blank' }; pages = [...pages, np]; ok.push(np) }
    const to = ok[j].id
    return { ...l, pages, items: l.items.map(x => (x.id === it.id ? clamp({ ...x, page: to }, unitOf[x.ref]) : x)) }
  })
  const rotate = (it) => {
    const u = unitOf[it.ref]
    patchItem(it.id, clamp({ ...it, rot: (it.rot + 90) % 360 }, u))
  }
  /** 목록에서 놓기 — 지정 자리(drop) 또는 새 쪽 */
  const placeUnit = (ref, at) => {
    const u = unitOf[ref]; if (!u) return
    change(l => {
      const base = { ...l, removed: l.removed.filter(r => r !== ref), items: l.items.filter(i => i.ref !== ref) }
      if (at) {
        const w = Math.min(at.w ?? 90, fitW(PW, PH, u.ar, l.cap))
        const it = clamp({ id: uid('b'), ref, page: at.page, x: at.x - w / 2, y: at.y - 10, w, rot: 0 }, u)
        return { ...base, items: [...base.items, it] }
      }
      const add = autoLayout([], formH, [u], l.cap)
      return { ...base, pages: [...base.pages, ...add.pages], items: [...base.items, ...add.items] }
    })
  }
  const addBlank = () => change(l => ({ ...l, pages: [...l.pages, { id: uid('p'), kind: 'blank' }] }))
  const removePage = (pid) => change(l => {
    const gone = l.items.filter(i => i.page === pid).map(i => i.ref)
    return { ...l, pages: l.pages.filter(p => p.id !== pid), items: l.items.filter(i => i.page !== pid), removed: [...l.removed, ...gone] }
  })
  const movePage = (pid, d) => change(l => {
    const i = l.pages.findIndex(p => p.id === pid), j = i + d
    if (i < 0 || j < 0 || j >= l.pages.length) return l
    const pages = [...l.pages]; [pages[i], pages[j]] = [pages[j], pages[i]]; return { ...l, pages }
  })
  const toggleForm = (key, on) => change(l => {
    const id = `f-${key}`
    const formsOff = (l.formsOff || []).filter(k => k !== key)
    if (!on) {
      const gone = l.items.filter(i => i.page === id).map(i => i.ref)
      return { ...l, formsOff: [...formsOff, key], pages: l.pages.filter(p => p.id !== id), items: l.items.filter(i => i.page !== id), removed: [...l.removed, ...gone] }
    }
    if (l.pages.some(p => p.id === id)) return { ...l, formsOff }
    // 양식 쪽은 양식 순서대로 맨 앞에
    const order = forms.map(f => f.key)
    const pages = [...l.pages]
    const at = pages.findIndex(p => p.kind !== 'form' || order.indexOf(p.form) > order.indexOf(key))
    pages.splice(at < 0 ? pages.length : at, 0, { id, kind: 'form', form: key })
    return { ...l, formsOff, pages }
  })
  const relayout = async () => {
    const ok = await confirm({ tone: 'warn', icon: <Icon.Refresh size={22}/>, title: '자동 배치 다시', body: '손본 배치를 지우고 처음부터 다시 놓아요.', confirmLabel: '다시 배치' })
    if (!ok) return
    const on = new Set(layout.pages.filter(p => p.kind === 'form').map(p => p.form))
    const auto = autoLayout(formPagesOf(f => on.has(f.key)), formH, units, cap)
    change(() => ({ ...auto, removed: [], cap, formsOff: forms.map(f => f.key).filter(k => !on.has(k)) }))
    setSel(null)
  }
  const doPrint = () => {
    if (!layout?.pages.length) return toast.push('인쇄할 쪽이 없어요', { tone: 'warn' })
    setSel(null)
    setTimeout(() => window.print(), 50)   // 다른 화면 숨기기·용지는 beforeprint 가 맡는다(Ctrl+P 와 같은 길)
  }

  const pdfPages = layout ? layout.items.filter(i => i.ref.includes('#p')).length : 0
  const sub = !ready ? (progress || '불러오는 중…')
    : [`${layout.pages.length}쪽`,
      pdfPages > PDF_WARN && `PDF ${pdfPages}쪽 — 많으면 필요한 것만 남기세요`,
      filesErr && '증빙을 못 불러왔어요',
      layoutKey && blocked && '못 불러온 것이 있어 배치를 저장하지 않아요',
      layoutKey && !blocked && ({ saving: '저장 중…', saved: '배치 저장됨', error: '배치를 저장하지 못했어요' }[saveState] || '')].filter(Boolean).join(' · ')

  return (
    <>
      <Drawer open onClose={onClose} size="xl" width="min(1320px, 100vw)" height="min(900px, 95vh)" label={title} confirmClose={false}>
        <DrawerHead title={title} sub={sub} onClose={onClose}/>
        <div className="drawer-body pw-body">
          <div className="pw-side">
            {forms.length > 0 && (
              <section>
                <div className="pw-label">양식</div>
                {!formNodes ? <div className="text-sm text-muted">불러오는 중…</div> : forms.map(f => {
                  const on = !!layout?.pages.some(p => p.id === `f-${f.key}`)
                  return (
                    <label key={f.key} className={`pw-row${formNodes[f.key] ? '' : ' disabled'}`}>
                      <input type="checkbox" checked={on} disabled={!formNodes[f.key] || !ready}
                        onChange={e => toggleForm(f.key, e.target.checked)}/>
                      <span className="pw-name">{f.label}</span>
                      {formErr[f.key] ? <span className="text-xs" style={{ color: 'var(--neg-ink)' }}>{formErr[f.key]}</span>
                        : !formNodes[f.key] && <span className="text-xs text-muted2">없음</span>}
                    </label>
                  )
                })}
              </section>
            )}
            <section>
              <div className="pw-label">첨부 <span className="text-muted2 fw-400">끌어서 쪽에 놓아요</span></div>
              {!sources ? <div className="text-sm text-muted">불러오는 중…</div>
                : filesErr ? (
                  <div className="text-sm" style={{ color: 'var(--neg-ink)' }}>
                    {filesErr} <button type="button" className="btn sm" style={{ marginLeft: 6 }} onClick={() => setReload(n => n + 1)}>다시</button>
                  </div>
                )
                : !sources.length ? <div className="text-sm text-muted">붙은 증빙이 없어요</div>
                : sources.map((s, i) => {
                  const on = s.units.filter(u => placed.has(u.ref))
                  const next = s.units.find(u => !placed.has(u.ref))
                  const where = [...new Set(on.map(u => pageNo(placed.get(u.ref).page)))].sort((a, b) => a - b)
                  return (
                    <div key={i} className={`pw-row pw-src${s.off || s.error ? ' disabled' : ''}`}
                      draggable={!!next} onDragStart={e => { e.dataTransfer.setData('text/x-pw-ref', next.ref); e.dataTransfer.effectAllowed = 'copy' }}
                      title={next ? '끌어서 원하는 쪽·자리에 놓아요' : undefined}>
                      <div className="pw-thumb">{s.units[0] ? <img src={s.units[0].src} alt=""/> : <Icon.File size={16}/>}</div>
                      <div className="pw-name">
                        <div className="ellipsis">{s.file.name}</div>
                        <div className="text-xs text-muted2 ellipsis">
                          {s.off ? '인쇄할 수 없는 형식이에요(엑셀·한글 등)'
                            : s.error ? '불러오지 못했어요'
                            : [s.file.source_label, s.file.kind === 'pdf' ? pdfLabel(s) : '이미지'].filter(Boolean).join(' · ')}
                        </div>
                        {!s.off && !s.error && (
                          <div className="text-xs" style={{ marginTop: 2, color: on.length ? 'var(--muted)' : 'var(--warn-ink)' }}>
                            {on.length ? `${where.join('·')}쪽에 있음${on.length < s.units.length ? ` (${on.length}/${s.units.length})` : ''}` : '놓지 않음'}
                          </div>
                        )}
                      </div>
                      {next && ready && (
                        <button type="button" className="btn sm" title="새 쪽에 놓기" onClick={() => {
                          for (const u of s.units) if (!placed.has(u.ref)) placeUnit(u.ref)
                        }}>놓기</button>
                      )}
                    </div>
                  )
                })}
            </section>
            <section>
              <div className="pw-label">쪽</div>
              <label className="pw-row" style={{ borderBottom: 0 }}>
                <input type="checkbox" checked={cap} disabled={!ready} onChange={e => change(l => ({ ...l, cap: e.target.checked }))}/>
                <span className="pw-name">첨부 아래 설명 줄(출처·파일명)</span>
              </label>
              <div className="row gap-6" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn sm" disabled={!ready} onClick={addBlank}><Icon.Plus size={12}/> 빈 쪽 추가</button>
                <button type="button" className="btn sm" disabled={!ready} onClick={relayout}><Icon.Refresh size={12}/> 자동 배치 다시</button>
              </div>
            </section>
          </div>

          <div className="pw-preview" onPointerDown={e => { if (e.target === e.currentTarget) setSel(null) }}>
            {!ready ? <div className="text-sm text-muted" style={{ padding: 40, textAlign: 'center' }}>불러오는 중…</div>
              : !layout.pages.length ? <div className="text-sm text-muted" style={{ padding: 40, textAlign: 'center' }}>쪽이 없어요 — 양식을 켜거나 빈 쪽을 추가하세요</div>
              : layout.pages.map((p, i) => (
                <div key={p.id} className="pe-sheet-wrap">
                  <div className="pe-sheet-bar">
                    <span className="num">{i + 1}쪽</span>
                    <span className="text-muted2">{p.kind === 'form' ? forms.find(f => f.key === p.form)?.label : '첨부'}</span>
                    <div className="ml-auto row gap-2">
                      <button type="button" className="icon-btn sm" title="앞으로" disabled={i === 0} onClick={() => movePage(p.id, -1)}><Icon.Up size={13}/></button>
                      <button type="button" className="icon-btn sm" title="뒤로" disabled={i === layout.pages.length - 1} onClick={() => movePage(p.id, 1)}><Icon.Down size={13}/></button>
                      {p.kind === 'blank' && <button type="button" className="icon-btn sm" title="쪽 삭제(첨부는 목록으로)" onClick={() => removePage(p.id)}><Icon.Trash size={13}/></button>}
                    </div>
                  </div>
                  <div className="pe-sheet">
                    <Sheet page={p} items={layout.items.filter(it => it.page === p.id)} unitOf={unitOf} cap={cap}
                      formNode={p.kind === 'form' ? formNodes[p.form] : null} formH={p.kind === 'form' ? formH[p.form] : null}
                      long={longForm(p)} edit sel={sel} setSel={setSel} patchItem={patchItem} clamp={clamp}
                      onRotate={rotate} onShift={shiftPage} onRemove={removeItem} onDropRef={placeUnit}/>
                  </div>
                </div>
              ))}
          </div>
        </div>
        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>닫기</button>
          <span className="text-xs text-muted2" style={{ marginLeft: 8 }}>끌어서 옮기기 · 모서리로 크기 · Delete 로 빼기</span>
          <button className="btn primary ml-auto" onClick={doPrint} disabled={!ready || !layout.pages.length}>
            <Icon.Print size={14}/> {ready ? `인쇄 (${layout.pages.length}쪽)` : '준비 중…'}
          </button>
        </div>
      </Drawer>

      {/* 양식 높이 재는 자리 — 화면 밖, 실제 폭 */}
      {formNodes && createPortal(
        <div className="pb-measure" ref={measureRef} aria-hidden>
          {forms.filter(f => formNodes[f.key]).map(f => <div key={f.key} data-k={f.key}>{formNodes[f.key]}</div>)}
        </div>, document.body)}

      {/* 실제로 찍히는 종이 — 화면에선 안 보인다(index.css .print-bundle) */}
      {ready && createPortal(
        <div className="print-bundle">
          {layout.pages.map(p => (
            <div key={p.id} className={longForm(p) ? 'pb-form' : 'pb-page'}>
              <Sheet page={p} items={layout.items.filter(it => it.page === p.id)} unitOf={unitOf} cap={cap}
                formNode={p.kind === 'form' ? formNodes[p.form] : null} long={longForm(p)}/>
            </div>
          ))}
        </div>, document.body)}
    </>
  )
}

/**
 * 쪽 하나 — 편집 화면과 종이가 같은 부품을 쓴다(mm). edit 일 때만 끌기·크기·도구가 붙는다.
 * 화면 배율은 바깥(.pe-sheet zoom)이 정하고, 끌 때는 쪽의 실제 화면 폭으로 mm 를 환산한다(배율을 몰라도 맞다).
 */
const Sheet = ({ page, items, unitOf, cap, formNode, formH, long, edit, sel, setSel, patchItem, clamp, onRotate, onShift, onRemove, onDropRef }) => {
  const ref = useRef(null)
  const drag = useRef(null)
  // 끄는 중에 쪽이 사라지면(닫기 등) 끌기도 끝낸다
  useEffect(() => () => drag.current?.end(), [])
  if (long) return <div className="pe-form">{formNode}</div>   // 한 장 넘는 양식 — 위에 놓지 않는다(바깥이 .pb-form)

  const mmAt = (el, cx, cy) => {
    const r = el.getBoundingClientRect(), k = r.width / PW
    return { x: (cx - r.left) / k, y: (cy - r.top) / k, k }
  }
  const pageUnder = (cx, cy) => document.elementsFromPoint(cx, cy).find(el => el.dataset?.pageId)

  /* 옮기기 — 손가락 아래 쪽이 다른 쪽이면 그 쪽으로 넘어간다 */
  const applyMove = (d) => {
    const pg = pageUnder(d.cx, d.cy) || document.querySelector(`[data-page-id="${CSS.escape(d.page)}"]`) || ref.current
    const at = mmAt(pg, d.cx, d.cy)
    d.page = pg.dataset.pageId
    patchItem(d.it.id, clamp({ ...d.it, page: d.page, x: at.x - d.gx, y: at.y - d.gy }, unitOf[d.it.ref]))
  }
  const onDown = (e, it, mode) => {
    if (!edit || e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    setSel(it.id)
    const at = mmAt(ref.current, e.clientX, e.clientY)
    const d = drag.current = { mode, it, page: it.page, gx: at.x - it.x, gy: at.y - it.y, sx: e.clientX, k: at.k, cx: e.clientX, cy: e.clientY }
    /* ⚠ 움직임·손 뗌은 **창(window)** 에서 듣는다. 상자에 달면, 상자가 다른 쪽으로 넘어가는 순간
       원래 쪽에서 사라져 손 뗌을 못 받고 끌기가 끝나지 않았다(상자가 엉뚱한 쪽으로 가고 저장도 멈춤) */
    const move = (ev) => {
      d.cx = ev.clientX; d.cy = ev.clientY
      if (d.mode === 'resize') patchItem(d.it.id, clamp({ ...d.it, w: Math.max(20, d.it.w + (ev.clientX - d.sx) / d.k) }, unitOf[d.it.ref], true))
      else applyMove(d)
    }
    d.end = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', d.end); window.removeEventListener('pointercancel', d.end)
      if (drag.current === d) drag.current = null
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', d.end); window.addEventListener('pointercancel', d.end)
    /* 화면엔 쪽이 한 장 남짓만 보인다 — 끄는 동안 위·아래 가장자리에 가면 저절로 넘긴다(다른 쪽으로 옮기기) */
    const sc = ref.current.closest('.pw-preview')
    if (mode === 'move' && sc) {
      const tick = () => {
        if (drag.current !== d) return
        const r = sc.getBoundingClientRect()
        const dy = d.cy > r.bottom - 48 ? 16 : d.cy < r.top + 48 ? -16 : 0
        if (dy) { sc.scrollTop += dy; applyMove(d) }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }
  }

  return (
    <div className="pe-page" ref={ref} data-page-id={edit ? page.id : undefined}
      onDragOver={edit ? (e => { if (e.dataTransfer.types.includes('text/x-pw-ref')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }) : undefined}
      onDrop={edit ? (e => {
        const r = e.dataTransfer.getData('text/x-pw-ref'); if (!r) return
        e.preventDefault()
        const at = mmAt(ref.current, e.clientX, e.clientY)
        onDropRef(r, { page: page.id, x: at.x, y: at.y })
      }) : undefined}>
      {formNode && <div className="pe-form">{formNode}</div>}
      {/* 양식이 끝나는 줄 — 그 아래가 빈자리(화면에서만) */}
      {edit && formH != null && formH < PH && <div className="pe-form-end" style={{ top: `${formH}mm` }}/>}
      {items.map(it => {
        const u = unitOf[it.ref]; if (!u) return null
        const ih = it.w * arOf(u, it.rot)
        const on = edit && sel === it.id
        return (
          <div key={it.id} className={`pe-box${on ? ' sel' : ''}${edit ? ' edit' : ''}`}
            style={{ left: `${it.x}mm`, top: `${it.y}mm`, width: `${it.w}mm` }}
            onPointerDown={edit ? (e => onDown(e, it, 'move')) : undefined}>
            <div className="pe-img" style={{ height: `${ih}mm` }}>
              <img src={u.src} alt="" draggable={false} className={it.rot ? `rot${it.rot}` : ''}
                style={it.rot === 90 || it.rot === 270 ? { width: `${ih}mm`, height: `${it.w}mm` } : undefined}/>
            </div>
            {cap && <div className="pe-cap">{[u.file.source_label, u.label].filter(Boolean).join(' · ')}</div>}
            {on && (
              <>
                <div className="pe-tools" onPointerDown={e => e.stopPropagation()}>
                  <button type="button" title="앞 쪽으로" onClick={() => onShift(it, -1)}><Icon.Up size={13}/></button>
                  <button type="button" title="뒤 쪽으로" onClick={() => onShift(it, 1)}><Icon.Down size={13}/></button>
                  <button type="button" title="90° 돌리기" onClick={() => onRotate(it)}><Icon.Refresh size={13}/></button>
                  <button type="button" title="빼기(목록으로)" onClick={() => onRemove(it.id)}><Icon.Close size={13}/></button>
                </div>
                <div className="pe-handle" title="크기" onPointerDown={e => onDown(e, it, 'resize')}/>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** [인쇄] 버튼 + 편집기 — 부르는 화면은 forms·getFiles·layoutKey 만 정한다 */
export const PrintWizardButton = ({ forms, getFiles, layoutKey, title, label = '인쇄', className = 'btn', disabled }) => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} disabled={disabled}>
        <Icon.Print size={14}/> {label}
      </button>
      {open && <PrintWizard open onClose={() => setOpen(false)} title={title} forms={forms} getFiles={getFiles} layoutKey={layoutKey}/>}
    </>
  )
}
