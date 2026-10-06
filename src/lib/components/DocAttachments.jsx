import { useState, useEffect } from 'react'
import { Icon, Drawer, useToast, useConfirm } from '../ui'
import { DrawerHead, DrawerFooter } from './Drawer'
import { AttachmentPanel } from './AttachmentPanel'
import { api } from '../api'

/**
 * 문서 증빙 — 대체전표·지급결의서·구매품의서·정산내역서에 붙는 첨부(공용 표 attachments).
 * 설계: docs/02-design/features/popup-attachments-print.design.md 5단계.
 *
 * 목록에는 **직접 붙인 것 + 연결된 거래·세금계산서·품의서의 증빙**이 함께 나온다(서버 relatedToDoc).
 * 연결된 것은 보기만 — 지우기는 원래 붙은 곳에서 한다.
 *
 * 문서 머리(DocToolbar·전표 팝업)에 [증빙 N] 버튼 하나 — 누르면 왼쪽 목록·오른쪽 미리보기(AttachmentPanel).
 * 거래·세금계산서 증빙과 **같은 판**이다. 여기서 붙인 파일은 그 문서가 걸린 거래의 '한눈에 보기'와
 * 인쇄 마법사에도 모인다(서버 lib/attachments.js relatedToTxn).
 *
 * @param ownerType 'journal_voucher' | 'resolution' | 'purchase_req' | 'settlement'
 * @param ownerId   문서 id
 * @param title     팝업 제목(예: '지급결의서 DJ-2026-0012 증빙')
 * @param readOnly  보기만(붙이기·지우기 없음) — 서버도 editable 로 판정한다(권한·결재 중·마감). 둘 중 하나라도 막히면 보기만
 */
export const DocAttachButton = ({ ownerType, ownerId, title = '증빙', readOnly = false }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [data, setData] = useState(null)       // { files, editable, locked, error }
  const [open, setOpen] = useState(false)
  const load = () => api.getDocAttachments(ownerType, ownerId).then(setData)
  // 문서가 바뀌면 이전 목록을 비우고, 늦게 온 응답(이전 문서 것)은 버린다
  useEffect(() => {
    setData(null)
    if (!ownerId) return
    let alive = true
    api.getDocAttachments(ownerType, ownerId).then(r => { if (alive) setData(r) })
    return () => { alive = false }
  }, [ownerType, ownerId])
  const files = data?.files || null
  const viewOnly = readOnly || !data?.editable

  const upload = async (file) => {
    const up = await api.uploadFile(file)
    if (!up?.url) return toast.push(up?.error || '업로드에 실패했어요', { tone: 'warn' })
    const res = await api.addDocAttachment(ownerType, ownerId, { url: up.url, name: up.originalName || file.name, size: up.size || file.size })
    if (!res.ok) return toast.push(res.error || '증빙을 붙이지 못했어요', { tone: 'warn' })
    await load()
  }
  const remove = async (f) => {
    const ok = await confirm({ tone: 'neg', icon: <Icon.Trash size={22}/>, title: '증빙 지우기', body: `${f.name} 을(를) 지울까요?`, confirmLabel: '지우기' })
    if (!ok) return
    const res = await api.deleteDocAttachment(ownerType, ownerId, f.id)
    if (!res.ok) return toast.push(res.error || '지우지 못했어요', { tone: 'warn' })
    await load()
  }

  const n = files?.length || 0
  return (
    <>
      {/* 개수가 있으면 숫자를 단다 — 없으면 '증빙'만(정상에 표식을 붙이지 않는다) */}
      <button type="button" className="btn" onClick={() => setOpen(true)} disabled={!ownerId}>
        <Icon.File size={14}/> 증빙{n > 0 && <span className="num" style={{ marginLeft: 2 }}>{n}</span>}
      </button>
      {open && (
        <Drawer open onClose={() => setOpen(false)} size="xl" height="min(760px, 92vh)" label="증빙" confirmClose={false}>
          <DrawerHead title={title} sub={data?.error || data?.locked || (viewOnly ? '' : 'PDF·사진을 끌어다 놓거나 눌러서 붙여요. 연결된 거래·세금계산서 증빙도 함께 보여요.')} onClose={() => setOpen(false)}/>
          <div className="drawer-body">
            {/* 연결된 거래·세금계산서의 증빙도 함께 보인다(보기만) — 지우기는 원래 붙은 곳에서 */}
            <AttachmentPanel files={files || []} height={560}
              onUpload={viewOnly ? undefined : upload} onRemove={viewOnly ? undefined : remove}
              canRemove={(f) => !f.linked}
              empty={data === null ? '불러오는 중…' : data.error ? '증빙을 불러오지 못했어요' : '붙은 증빙이 없어요'}/>
          </div>
          <DrawerFooter onCancel={() => setOpen(false)} cancelLabel="닫기"/>
        </Drawer>
      )}
    </>
  )
}
