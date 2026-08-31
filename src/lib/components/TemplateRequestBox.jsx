import { useState, useEffect } from 'react'
import { Icon, useToast, useConfirm, Drawer } from '../ui'
import { api } from '../api'
import { DrawerHead } from './Drawer'

/**
 * 양식 신청함 — 보고서 관리·문서 관리 아래에 함께 서는 부품.
 *
 * ── 왜 필요한가 ──
 * 카탈로그·주문·회사 설정까지 다 만들어 놓고 **고객이 요청할 통로가 없었다.**
 * 전화·카톡으로 오면 기록이 안 남고, 무엇을 요청했는지가 사람 머릿속에만 있다.
 *
 * ⚠ **신청 목록을 함께 보여준다.** 보내고 감감무소식이면 같은 걸 또 신청한다.
 *   상태('접수됨'·'검토 중'…)와 우리 답변이 여기 그대로 뜬다.
 *
 * ⚠ 신청은 **계약이 아니다.** 보낸다고 아무것도 안 열린다 — 화면 문구도 그렇게 적는다.
 *   기대를 만들어 놓고 못 열어주면 그게 더 나쁘다.
 */

const STATUS = {
  received:  { label: '접수됨',    tone: 'warn' },
  reviewing: { label: '검토 중',   tone: 'brand' },
  building:  { label: '만드는 중', tone: 'brand' },
  done:      { label: '완료',      tone: 'pos' },
  hold:      { label: '보류',      tone: 'outline' },
}

const KIND_WORD = { report: '보고서', doc: '문서' }

export const TemplateRequestBox = ({ kind = 'report' }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(false)

  const load = async () => setRows(await api.getTemplateRequests(kind))
  useEffect(() => { load() }, [kind])

  const word = KIND_WORD[kind] || '양식'
  const live = (rows || []).filter(r => r.status !== 'done')

  return (
    <div className="card" style={{ marginTop: 14, overflow: 'hidden' }}>
      <div className="row card-pad" style={{ alignItems: 'center' }}>
        <div>
          <div className="fw-700">원하는 {word} 양식이 없나요?</div>
          {/* 문구는 짧게. 무엇이 되고 무엇이 안 되는지 한 줄씩. */}
          <div className="text-sm text-muted" style={{ marginTop: 3 }}>
            쓰시던 양식 파일을 보내주시면 검토해서 만들어드려요.
          </div>
        </div>
        <button className="btn primary ml-auto" onClick={() => setOpen(true)}>
          <Icon.Plus size={14}/> {word} 양식 신청
        </button>
      </div>

      {rows && rows.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>신청한 양식</th>
              <th style={{ width: 110 }}>상태</th>
              <th style={{ width: 110 }}>보낸 날</th>
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const st = STATUS[r.status] || STATUS.received
              return (
                <tr key={r.id}>
                  <td>
                    <span className="fw-600">{r.title}</span>
                    {r.files?.length > 0 && (
                      <span className="text-xs text-muted2" style={{ marginLeft: 8 }}>
                        첨부 {r.files.length}
                      </span>
                    )}
                    {/* 우리 답변 — 있으면 여기 그대로 보인다 */}
                    {r.opsReply && (
                      <div className="text-sm text-muted" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
                        {r.opsReply}
                      </div>
                    )}
                  </td>
                  <td>
                    {/* 완료는 표식을 달지 않는다 — 정상에는 배지를 안 붙이는 규칙 */}
                    {r.status === 'done'
                      ? <span className="text-sm text-muted2">완료</span>
                      : <span className={`badge ${st.tone}`} style={{ fontSize: 11 }}>{st.label}</span>}
                  </td>
                  <td className="text-sm text-muted">{String(r.createdAt || '').slice(0, 10)}</td>
                  <td>
                    {/* 취소는 우리가 손대기 전에만. 서버도 같은 조건으로 막는다(409) */}
                    {r.status === 'received' && (
                      <button className="btn sm" onClick={async () => {
                        if (!await confirm({ tone: 'warn', title: '신청을 취소할까요?', body: r.title, confirmLabel: '취소하기' })) return
                        const res = await api.cancelTemplateRequest(r.id)
                        if (!res.ok) return toast.push(res.error || '취소하지 못했어요', { tone: 'warn' })
                        toast.push('신청을 취소했어요'); load()
                      }}>취소</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {rows && rows.length > 0 && live.length === 0 && (
        <div className="card-pad text-xs text-muted" style={{ paddingTop: 0 }}>
          신청하신 건은 모두 처리됐어요.
        </div>
      )}

      <RequestDrawer open={open} kind={kind} word={word}
        onClose={() => setOpen(false)}
        onDone={() => { setOpen(false); load() }}/>
    </div>
  )
}

const RequestDrawer = ({ open, kind, word, onClose, onDone }) => {
  const toast = useToast()
  const [title, setTitle] = useState('')
  const [descr, setDescr] = useState('')
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (open) { setTitle(''); setDescr(''); setFiles([]) } }, [open])

  const pick = async (e) => {
    const list = [...(e.target.files || [])]
    e.target.value = ''                       // 같은 파일을 다시 고를 수 있게
    for (const f of list) {
      const up = await api.uploadFile(f)
      if (!up?.url) { toast.push(`${f.name} 을(를) 올리지 못했어요`, { tone: 'warn' }); continue }
      setFiles(prev => [...prev, { url: up.url, name: up.originalName || f.name, size: up.size || f.size }])
    }
  }

  const save = async () => {
    if (!title.trim()) return toast.push('어떤 양식인지 제목을 적어주세요')
    setBusy(true)
    const res = await api.createTemplateRequest({ kind, title, descr, files })
    setBusy(false)
    if (!res.ok) return toast.push(res.error || '보내지 못했어요', { tone: 'warn' })
    toast.push('신청을 보냈어요')
    onDone()
  }

  return (
    <Drawer open={open} onClose={onClose} width="min(560px,100vw)" label={`${word} 양식 신청`}>
      <DrawerHead title={`${word} 양식 신청`} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div>
          <label className="label" style={{ marginBottom: 8 }}>
            어떤 양식인가요 <span style={{ color: 'var(--neg-ink)' }}>*</span>
          </label>
          <input className="input" value={title} onChange={e => setTitle(e.target.value)}
            placeholder={kind === 'doc' ? '예: 거래명세서' : '예: 부서별 예산 대비 집행'}/>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>어떻게 쓰시나요</label>
          <textarea className="input" rows={5} value={descr} onChange={e => setDescr(e.target.value)}
            placeholder={'언제 쓰는지, 누구에게 넘기는지, 어떤 칸이 꼭 있어야 하는지 적어주세요.'}/>
        </div>
        <div>
          <label className="label" style={{ marginBottom: 8 }}>
            쓰시던 양식 파일 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span>
          </label>
          {/* 파일이 있으면 훨씬 빠르다 — 칸 배치를 말로 옮길 필요가 없다 */}
          <div className="text-xs text-muted2" style={{ marginBottom: 8 }}>
            엑셀·한글·PDF·사진 모두 됩니다.
          </div>
          <label className="btn sm" style={{ display: 'inline-flex', cursor: 'pointer' }}>
            <Icon.Upload size={14}/> 파일 고르기
            <input type="file" multiple style={{ display: 'none' }} onChange={pick}
              accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.hwp"/>
          </label>
          {files.length > 0 && (
            <div className="col gap-6" style={{ marginTop: 10 }}>
              {files.map((f, i) => (
                <div key={i} className="row" style={{ alignItems: 'center', gap: 8 }}>
                  <Icon.File size={14}/>
                  <span className="text-sm" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <button className="btn sm" onClick={() => setFiles(p => p.filter((_, j) => j !== i))}>빼기</button>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* 기대를 정확히 만든다 — 신청하면 바로 켜진다고 읽히면 안 된다 */}
        <div className="text-xs text-muted2" style={{ lineHeight: 1.7 }}>
          보내주시면 확인 후 연락드려요. 신청만으로 바로 사용되지는 않아요.
        </div>
      </div>
      <div className="drawer-foot">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary ml-auto" disabled={busy} onClick={save}>
          {busy ? '보내는 중…' : '신청 보내기'}
        </button>
      </div>
    </Drawer>
  )
}
