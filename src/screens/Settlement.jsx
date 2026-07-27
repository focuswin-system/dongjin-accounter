import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Drawer, Combobox, MoneyInput, localToday } from '../lib/ui'
import { api } from '../lib/api'
import { PageHeader } from '../lib/components/PageHeader'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'

// 定算內譯書 분류 — 동진테크 양식 기준(도로비·교통비·영업비·운송료·기타경비).
const CATEGORIES = ['기타경비', '도로비', '교통비', '영업비', '운송료']
const emptyLine = () => ({ category: '기타경비', title: '', amount: '', memo: '' })
const numOf = (v) => (typeof v === 'string' ? parseInt(v.replace(/[^0-9-]/g, ''), 10) || 0 : Number(v) || 0)

// ── 인쇄 양식(定算內譯書) ─────────────────────────────────────────
export const SettlementDocument = ({ doc, company }) => {
  const ceo = company?.ceo || '대표이사'
  const lines = doc.lines && doc.lines.length ? doc.lines : []
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const received = Number(doc.received_amount) || 0
  const balance = received - total
  const approval = (doc.approval && doc.approval.length)
    ? doc.approval
    : [{ label: '담당' }, { label: '결재' }, { label: '대표이사', position: ceo }]
  // 분류 순서대로 정렬해 보여준다
  const ordered = [...lines].sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category))
  return (
    <div className="doc-paper resolution-paper resolution-print">
      <div className="res-title-ko">정산내역서</div>
      <div className="res-title">定 算 內 譯 書</div>
      <div className="res-date num">{doc.settle_date || ''}</div>

      <table className="res-table res-head">
        <tbody>
          <tr><th>정산자</th><td>{doc.settler || '—'}</td><th>수령액</th><td className="num fw-700">₩ {fmtNum(received)}</td></tr>
          <tr><th>문서번호</th><td className="num">{doc.doc_no}</td><th>지출총액</th><td className="num">₩ {fmtNum(total)}</td></tr>
          <tr><th>정산일</th><td className="num">{doc.settle_date || '—'}</td><th>잔　액</th>
            <td className="num fw-700" style={{ color: balance < 0 ? 'var(--neg-ink)' : undefined }}>₩ {fmtNum(balance)}</td></tr>
        </tbody>
      </table>

      <div className="res-note-line">아래 내역과 같이 經費 使用 部分에 대하여 定算코자 하오니 決裁하여 주시기 바랍니다.</div>

      <table className="res-table res-items">
        <thead>
          <tr>
            <th style={{ width: 34 }}>NO</th><th style={{ width: 80 }}>분류</th><th>항목</th>
            <th style={{ width: 120 }}>지출액</th><th style={{ width: 150 }}>비고</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((l, i) => (
            <tr key={i}>
              <td className="num" style={{ textAlign: 'center' }}>{i + 1}</td>
              <td style={{ textAlign: 'center' }}>{l.category}</td>
              <td>{l.title}</td>
              <td className="num fw-600" style={{ textAlign: 'right' }}>{fmtNum(l.amount || 0)}</td>
              <td>{l.memo}</td>
            </tr>
          ))}
          {Array.from({ length: Math.max(0, 5 - ordered.length) }).map((_, i) => (
            <tr key={`e${i}`}><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>
          ))}
          <tr className="res-total">
            <th colSpan={3} style={{ textAlign: 'center' }}>합　계</th>
            <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(total)}</td>
            <td></td>
          </tr>
        </tbody>
      </table>

      <div className="res-foot">
        <div className="res-note">
          <div className="res-note-head">특기사항</div>
          <div className="res-note-body">{doc.note || ''}</div>
        </div>
        <table className="res-approve">
          <tbody>
            <tr>{approval.map((s, i) => <th key={i}>{s.label}{s.position ? <div style={{ fontWeight: 400, fontSize: 10, color: '#888' }}>{s.position}</div> : null}</th>)}</tr>
            <tr>{approval.map((_, i) => <td key={i}></td>)}</tr>
          </tbody>
        </table>
      </div>
      <div className="res-company num">{company?.name || ''}</div>
    </div>
  )
}

// ── 새/편집 정산내역서 드로어 ────────────────────────────────────
const SettlementDrawer = ({ open, editDoc, onClose, onSaved }) => {
  const toast = useToast()
  const [form, setForm] = useState({ settler: '', settle_date: localToday(), received_amount: '', note: '' })
  const [lines, setLines] = useState([emptyLine()])
  const [presets, setPresets] = useState([])
  const [presetId, setPresetId] = useState('')

  useEffect(() => {
    if (!open) return
    api.getApprovalPresets().then(list => {
      setPresets(list)
      setPresetId((list.find(p => p.is_default) || list[0])?.id || '')
    })
    if (editDoc) {
      setForm({ settler: editDoc.settler || '', settle_date: editDoc.settle_date || localToday(),
        received_amount: String(editDoc.received_amount || ''), note: editDoc.note || '' })
      setLines(editDoc.lines && editDoc.lines.length
        ? editDoc.lines.map(l => ({ category: l.category || '기타경비', title: l.title || '', amount: String(l.amount || ''), memo: l.memo || '' }))
        : [emptyLine()])
    } else {
      setForm({ settler: '', settle_date: localToday(), received_amount: '', note: '' })
      setLines([emptyLine()])
    }
  }, [open, editDoc])

  const total = lines.reduce((s, l) => s + numOf(l.amount), 0)
  const balance = numOf(form.received_amount) - total
  const setLine = (i, k, v) => setLines(ls => ls.map((l, j) => j === i ? { ...l, [k]: v } : l))
  const addLine = () => setLines(ls => [...ls, emptyLine()])
  const removeLine = (i) => setLines(ls => ls.length > 1 ? ls.filter((_, j) => j !== i) : ls)
  const chosen = presets.find(p => p.id === presetId)

  const save = async () => {
    const clean = lines.filter(l => l.title.trim() || numOf(l.amount))
    if (!clean.length) return toast.push('지출 항목을 한 줄 이상 입력해주세요')
    const payload = {
      settler: form.settler.trim(),
      settle_date: form.settle_date || null,
      received_amount: numOf(form.received_amount),
      note: form.note.trim(),
      lines: clean.map(l => ({ category: l.category, title: l.title.trim(), amount: numOf(l.amount), memo: l.memo.trim() })),
      approval: chosen ? chosen.steps.map(s => ({ label: s.label, position: s.position || '', name: '' })) : undefined,
    }
    const res = editDoc ? await api.updateSettlement(editDoc.id, payload) : await api.createSettlement(payload)
    if (!res.ok) return toast.push(res.error || '저장에 실패했어요')
    toast.push(editDoc ? '수정됐어요' : `정산내역서 ${res.settlement?.doc_no || ''}를 만들었어요`)
    onSaved(editDoc ? editDoc.id : res.settlement?.id)
  }

  return (
    <Drawer open={open} onClose={onClose} width="min(640px,100vw)" label="정산내역서">
      <DrawerHead title={editDoc ? '정산내역서 수정' : '새 정산내역서'} onClose={onClose}/>
      <div className="drawer-body col gap-form">
        <div className="text-sm text-muted">수령한 자금(수령액)을 분류별로 정산하고 잔액을 맞추는 문서예요. 잔액 = 수령액 − 지출 합계.</div>

        <div className="row gap-12">
          <div style={{ flex: 1 }}>
            <label className="label" style={{ marginBottom: 8 }}>정산자</label>
            <input className="input" value={form.settler} onChange={e => setForm(f => ({ ...f, settler: e.target.value }))} placeholder="정산 담당자"/>
          </div>
          <div style={{ width: 160 }}>
            <label className="label" style={{ marginBottom: 8 }}>정산일</label>
            <input className="input" type="date" value={form.settle_date} onChange={e => setForm(f => ({ ...f, settle_date: e.target.value }))}/>
          </div>
        </div>

        <div>
          <label className="label" style={{ marginBottom: 8 }}>수령액 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 정산 대상 자금</span></label>
          <div style={{ position: 'relative' }}>
            <MoneyInput className="input num fw-700" style={{ fontSize: 18, paddingRight: 36 }}
              value={form.received_amount} onChange={raw => setForm(f => ({ ...f, received_amount: raw }))}/>
            <span style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-2)', fontSize: 13 }}>원</span>
          </div>
        </div>

        <div>
          <div className="row" style={{ marginBottom: 8, alignItems: 'center' }}>
            <label className="label" style={{ margin: 0 }}>지출 항목</label>
            <button className="btn sm ml-auto" onClick={addLine}><Icon.Plus size={12}/> 항목 추가</button>
          </div>
          <div className="col gap-8">
            {lines.map((l, i) => (
              <div key={i} className="row gap-6" style={{ alignItems: 'center' }}>
                <div style={{ width: 96 }}>
                  <Combobox value={l.category} onChange={v => setLine(i, 'category', v || '기타경비')} allowAdd={false}
                    options={CATEGORIES.map(c => ({ value: c, label: c }))} placeholder="분류"/>
                </div>
                <input className="input" style={{ flex: 1, minWidth: 100 }} value={l.title}
                  onChange={e => setLine(i, 'title', e.target.value)} placeholder="항목명 (예: 고속도로통행료)"/>
                <div style={{ width: 120 }}>
                  <MoneyInput className="input num" value={l.amount} onChange={raw => setLine(i, 'amount', raw)}/>
                </div>
                <input className="input" style={{ width: 130 }} value={l.memo}
                  onChange={e => setLine(i, 'memo', e.target.value)} placeholder="비고"/>
                <button className="icon-btn" onClick={() => removeLine(i)} title="삭제"><Icon.Close size={14}/></button>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: '12px 14px', display: 'flex', gap: 20, alignItems: 'center' }}>
          <span className="text-sm text-muted">지출 합계 <b className="num" style={{ color: 'var(--ink)' }}>{fmtNum(total)}원</b></span>
          <span className="text-sm text-muted ml-auto">잔액</span>
          <b className="num" style={{ fontSize: 18, color: balance < 0 ? 'var(--neg-ink)' : 'var(--brand-ink)' }}>{fmtNum(balance)}원</b>
        </div>

        <div>
          <label className="label" style={{ marginBottom: 8 }}>결재선</label>
          <Combobox value={presetId} onChange={setPresetId} allowAdd={false}
            options={presets.map(p => ({ value: p.id, label: p.name }))} placeholder="기본 결재선"/>
          {chosen && <div className="text-xs text-muted2" style={{ marginTop: 6 }}>{(chosen.steps || []).map(s => s.label).join(' → ')}</div>}
        </div>

        <div>
          <label className="label" style={{ marginBottom: 8 }}>특기사항 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
          <input className="input" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="예: 계좌인출 후 송금"/>
        </div>
      </div>
      <DrawerFooter onCancel={onClose} onSave={save} saveLabel={editDoc ? '저장' : '정산내역서 만들기'}/>
    </Drawer>
  )
}

// ── 정산내역서 화면 ─────────────────────────────────────────────
export const SettlementScreen = () => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const [list, setList] = useState([])
  const [company, setCompany] = useState(null)
  const [selId, setSelId] = useState(null)
  const [drawer, setDrawer] = useState(null)   // null | 'new' | editDoc

  const load = async (keepId) => {
    const [rows, comp] = await Promise.all([api.getSettlements(), api.getCompany()])
    setList(rows); setCompany(comp)
    setSelId(prev => {
      const want = keepId || prev
      return want && rows.some(r => r.id === want) ? want : (rows[0]?.id || null)
    })
  }
  useEffect(() => { load() }, [])

  const [sel, setSel] = useState(null)
  useEffect(() => {
    if (!selId) { setSel(null); return }
    api.getSettlement(selId).then(setSel)
  }, [selId])

  const doDelete = async () => {
    if (!sel) return
    const ok = await confirm({ tone: 'neg', icon: <Icon.Warn size={22}/>, title: `${sel.doc_no} 삭제`, body: '이 정산내역서를 삭제할까요? 복구할 수 없어요.', confirmLabel: '삭제' })
    if (!ok) return
    const res = await api.deleteSettlement(sel.id)
    if (!res.ok) return toast.push(res.error || '삭제에 실패했어요')
    toast.push('삭제됐어요'); setSelId(null); load()
  }

  return (
    <div className="fade-up">
      <PageHeader title="정산내역서"
        actions={<button className="btn primary" onClick={() => setDrawer('new')}><Icon.Plus size={14}/> 새 정산내역서</button>}/>

      <div className="master-layout" style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ padding: 8 }}>
          {list.length === 0 && <div className="text-sm text-muted2" style={{ padding: 20, textAlign: 'center' }}>정산내역서가 없어요.<br/>위에서 새로 만드세요.</div>}
          {list.map(d => (
            <button key={d.id} className={`nav-item ${selId === d.id ? 'active' : ''}`}
              style={{ width: '100%', flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '10px 12px' }}
              onClick={() => setSelId(d.id)}>
              <span className="row" style={{ width: '100%', gap: 6 }}>
                <span className="fw-700 text-sm num">{d.doc_no}</span>
                <span className="text-xs text-muted2 ml-auto">{d.settle_date || ''}</span>
              </span>
              <span className="text-xs text-muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                {d.settler || '—'} · 잔액 <b style={{ color: (d.balance || 0) < 0 ? 'var(--neg-ink)' : 'var(--ink)' }}>{fmtNum(d.balance || 0)}</b>
              </span>
            </button>
          ))}
        </div>

        <div>
          {sel ? (
            <>
              <div className="card no-print" style={{ padding: '12px 16px', marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
                <span className="fw-700 num">{sel.doc_no}</span>
                <span className="text-sm text-muted">잔액 <b className="num" style={{ color: (sel.balance || 0) < 0 ? 'var(--neg-ink)' : 'var(--brand-ink)' }}>{fmtNum(sel.balance || 0)}원</b></span>
                <div className="ml-auto row gap-8">
                  <button className="btn" onClick={() => window.print()}><Icon.Print/> 인쇄</button>
                  <button className="btn" onClick={() => setDrawer(sel)}><Icon.Pencil size={14}/> 편집</button>
                  <button className="btn" style={{ color: 'var(--neg)' }} onClick={doDelete}><Icon.Trash size={14}/> 삭제</button>
                </div>
              </div>
              <SettlementDocument doc={sel} company={company}/>
            </>
          ) : (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--muted-2)' }}>왼쪽에서 정산내역서를 고르거나 새로 만드세요.</div>
          )}
        </div>
      </div>

      <SettlementDrawer open={!!drawer} editDoc={drawer === 'new' ? null : drawer}
        onClose={() => setDrawer(null)}
        onSaved={(id) => { setDrawer(null); load(id) }}/>
    </div>
  )
}
