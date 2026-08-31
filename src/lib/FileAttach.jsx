import { useState, useRef } from 'react'
import { Icon } from './ui'
import { api } from './api'

/* 파일 첨부 공용 컴포넌트.
 * 여러 파일을 끌어다 놓거나 골라서 올리고, 목록을 보고 지운다. 업로드는 내부에서 처리한다.
 *
 * props:
 *   docs      현재 첨부 목록 [{ id?, name, url, type?, size? }]
 *   onAdd     업로드된 파일마다 호출 async(doc) — 부모가 저장(상세) 또는 폼 상태에 담음(등록 폼)
 *             doc = { url, name, size }
 *   onRemove  삭제 async(doc) — 부모가 서버 삭제 또는 폼 상태에서 제거
 *   accept    허용 확장자 (기본: 문서·이미지)
 *   label     드롭존 문구
 *   hint      드롭존 보조 문구
 *   multiple  여러 파일 동시 선택 허용 (기본 true)
 *   readOnly  목록만 보이고 추가/삭제 숨김
 */
const DEFAULT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.hwp'

const isImg = (name) => /\.(jpe?g|png|gif|webp)$/i.test(name || '')

export const FileAttach = ({
  docs = [], onAdd, onRemove,
  accept = DEFAULT_ACCEPT,
  label = '파일을 끌어다 놓거나 클릭해서 추가',
  hint = 'PDF · 이미지 · 문서 (최대 20MB)',
  multiple = true, readOnly = false,
}) => {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef(null)

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setErr(''); setBusy(true)
    try {
      for (const f of files) {
        const up = await api.uploadFile(f)
        if (up?.url) {
          await onAdd({ url: up.url, name: up.originalName || f.name, size: up.size || 0 })
        } else {
          setErr(`'${f.name}' 업로드에 실패했어요`)
        }
      }
    } catch {
      setErr('첨부 처리 중 오류가 났어요')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = '' // 같은 파일 다시 선택 가능하게
    }
  }

  return (
    <div className="col gap-8">
      {docs.map((d, i) => (
        <div key={d.id || d.url || i} className="row gap-10"
          style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)' }}>
          <div style={{ width: 34, height: 40, background: 'var(--surface-3)', border: '1px solid var(--line)', borderRadius: 6, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            {isImg(d.name) ? <Icon.Image size={18}/> : <Icon.File size={18}/>}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="fw-600 text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
            {(d.type || d.size) ? <div className="text-xs text-muted2">{d.type || '기타'}{d.size ? ` · ${Math.round(d.size / 1024)}KB` : ''}</div> : null}
          </div>
          {d.url && <button type="button" className="btn ghost sm" onClick={() => window.open(d.url, '_blank')} title="보기"><Icon.Eye size={14}/></button>}
          {d.url && <a className="btn ghost sm" href={d.url} download={d.name} style={{ textDecoration: 'none' }} title="내려받기"><Icon.Download size={14}/></a>}
          {!readOnly && <button type="button" className="btn ghost sm" style={{ color: 'var(--neg)' }} onClick={() => onRemove(d)} title="삭제"><Icon.Close size={14}/></button>}
        </div>
      ))}

      {!readOnly && (
        <label className="drop" style={{ display: 'block', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 }}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); if (!busy) handleFiles(e.dataTransfer.files) }}>
          <Icon.Upload size={20}/>
          <div className="fw-600 text-sm" style={{ marginTop: 6 }}>{busy ? '업로드 중…' : label}</div>
          <div className="text-xs text-muted2" style={{ marginTop: 2 }}>{hint}</div>
          <input ref={inputRef} type="file" accept={accept} multiple={multiple} style={{ display: 'none' }}
            disabled={busy} onChange={e => handleFiles(e.target.files)}/>
        </label>
      )}
      {err && <div className="text-xs" style={{ color: 'var(--neg-ink)' }}>{err}</div>}
      {docs.length === 0 && readOnly && <div className="text-xs text-muted2">첨부된 파일이 없어요.</div>}
    </div>
  )
}
