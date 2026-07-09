import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge, Drawer, Combobox } from '../lib/ui'
import { api } from '../lib/api'

const STATUS_TONE = {
  "입금 완료": "pos",  "지급 완료": "pos",
  "입금 예정": "brand","지급 예정": "brand",
  "일부 입금": "warn", "일부 지급": "warn",
  "지급 대기": "warn",
  "기한 지남": "neg",  "장기 미수": "neg",
}

const dday = (due) => {
  if (!due) return ""
  const diff = Math.round((new Date(due) - new Date()) / 86400000)
  if (diff === 0) return "오늘"
  if (diff < 0)   return `+${Math.abs(diff)}일 초과`
  return `D-${diff}`
}

const ddayTone = (due) => {
  if (!due) return "outline"
  const diff = Math.round((new Date(due) - new Date()) / 86400000)
  if (diff < 0)  return "neg"
  if (diff <= 3) return "warn"
  return "outline"
}

// ── 청구서 상세 Drawer ────────────────────────────────────────────
const MOCK_DOCS = {
  "INV-2026-001": [
    { name: "세금계산서_한화에어로스페이스_KF21_3차.pdf", type: "세금계산서", size: "142KB", date: "2026-05-15" },
    { name: "납품확인서_KF21동체_3차.pdf",               type: "납품확인서", size: "88KB",  date: "2026-05-15" },
  ],
  "INV-2026-002": [
    { name: "세금계산서_LIG넥스원_유도무기_5월.pdf", type: "세금계산서", size: "118KB", date: "2026-05-10" },
  ],
  "INV-2026-101": [
    { name: "세금계산서_한울정밀_CNC외주_5월.pdf", type: "세금계산서", size: "96KB",  date: "2026-05-10" },
    { name: "거래명세서_한울정밀.jpg",             type: "거래명세서", size: "620KB", date: "2026-05-10" },
  ],
}

const DOC_TYPE_ICON = {
  "세금계산서": <Icon.File size={16}/>,
  "납품확인서": <Icon.Doc  size={16}/>,
  "거래명세서": <Icon.Doc  size={16}/>,
  "검사성적서": <Icon.File size={16}/>,
  "계약서":     <Icon.File size={16}/>,
}

const localDate = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

const InvoiceDetailDrawer = ({ invoice, onClose, onMatch, onDelete, onEdit, toast }) => {
  const { confirm } = useConfirm()
  const [matchAmt, setMatchAmt] = useState("")
  const [matchDate, setMatchDate] = useState(localDate())
  const [innerTab, setInnerTab] = useState("match")
  const [matchMode, setMatchMode] = useState("link")
  const [candidates, setCandidates] = useState([])
  const [showAll, setShowAll] = useState(false)
  const [docs, setDocs] = useState([])
  useEffect(() => {
    if (invoice?.id && invoice.remainAmount > 0) api.getMatchable(invoice.id).then(setCandidates)
    else setCandidates([])
    setShowAll(false)
  }, [invoice?.id, invoice?.remainAmount])
  useEffect(() => { setDocs(invoice?.docs || []) }, [invoice?.id])

  if (!invoice) return null

  const relatedCands = candidates.filter(c => c.related)
  const shownCands = showAll ? candidates : (relatedCands.length ? relatedCands : candidates)
  const hasOther = relatedCands.length > 0 && candidates.length > relatedCands.length

  const isIssued  = invoice.kind === "issued"
  const labelPaid = isIssued ? "입금 완료" : "지급 완료"

  const uploadDoc = async (file, docType) => {
    if (!file) return
    const up = await api.uploadFile(file)
    if (!up?.url) { toast.push("업로드에 실패했어요"); return }
    const res = await api.addInvoiceDoc(invoice.id, { url: up.url, name: up.originalName || file.name, doc_type: docType || '기타', size: up.size || 0 })
    if (res.ok) { setDocs(prev => [...prev, { id: res.id, url: up.url, name: up.originalName || file.name, type: docType || '기타', size: up.size || 0 }]); toast.push("서류를 첨부했어요") }
    else toast.push("첨부에 실패했어요")
  }
  const removeDoc = async (id) => {
    const res = await api.deleteInvoiceDoc(id)
    if (res.ok) { setDocs(prev => prev.filter(d => d.id !== id)); toast.push("삭제됐어요") }
    else toast.push("삭제에 실패했어요")
  }

  const handleMatch = async () => {
    const amount = parseInt(matchAmt.replace(/[^0-9]/g, ""))
    if (!amount) { toast.push("금액을 입력하세요", { tone: "warn" }); return }
    if (amount > invoice.remainAmount) { toast.push("잔여 금액을 초과할 수 없어요", { tone: "warn" }); return }
    const ok = await confirm({
      tone: "brand", icon: <Icon.Check size={22}/>,
      title: `${isIssued ? "입금" : "지급"} 매칭 처리`,
      body: `${fmtNum(amount)}원을 매칭 처리합니다.`,
      confirmLabel: "매칭 처리",
    })
    if (ok) { onMatch(invoice.id, amount, matchDate, null); onClose() }
  }

  const linkMatch = async (txn) => {
    const ok = await confirm({
      tone: "brand", icon: <Icon.Check size={22}/>,
      title: `${isIssued ? "입금" : "지급"} 거래 연결`,
      body: `${txn.date} · ${fmtNum(txn.amount)}원 거래를 이 청구서에 연결해요. 새 거래는 만들지 않아요.`,
      confirmLabel: "연결",
    })
    if (ok) { onMatch(invoice.id, txn.amount, txn.date, txn.id); onClose() }
  }

  return (
    <Drawer open={true} onClose={onClose}>
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>청구서 상세</div>
            <div className="text-xs text-muted">{invoice.invoiceNo}</div>
          </div>
          <div className="ml-auto row gap-6">
            <button className="btn" style={{ fontSize: 12 }}
              onClick={() => onEdit?.(invoice)}>
              <Icon.Pencil size={13}/> 수정
            </button>
            <button className="btn" style={{ fontSize: 12, color: "var(--neg-ink)" }}
              onClick={async () => {
                const ok = await confirm({ tone: "neg", icon: <Icon.Warn size={22}/>,
                  title: "청구서 삭제", body: "이 청구서를 삭제합니다. 되돌릴 수 없어요.", confirmLabel: "삭제" })
                if (ok) { toast.push("청구서가 삭제됐어요"); onClose(); if (onDelete) onDelete(invoice.id); }
              }}>
              삭제
            </button>
            <button className="icon-btn" onClick={onClose}><Icon.Close size={16}/></button>
          </div>
        </div>

        {/* 탭 */}
        <div className="row gap-0" style={{ borderBottom: "1px solid var(--line)", padding: "0 22px" }}>
          {[
            { id: "match", label: isIssued ? "입금 매칭" : "지급 매칭" },
            { id: "info",  label: "청구 정보" },
            { id: "docs",  label: `첨부 서류${docs.length ? ` (${docs.length})` : ""}` },
          ].map(t => (
            <button key={t.id} onClick={() => setInnerTab(t.id)}
              style={{
                padding: "10px 14px", border: "none", background: "none", cursor: "pointer",
                fontFamily: "inherit", fontSize: 13, fontWeight: innerTab === t.id ? 700 : 500,
                color: innerTab === t.id ? "var(--ink)" : "var(--muted)",
                borderBottom: innerTab === t.id ? "2px solid var(--ink)" : "2px solid transparent",
                marginBottom: -1,
              }}>
              {t.label}
            </button>
          ))}
          <div className="ml-auto row gap-6" style={{ alignItems: "center", paddingBottom: 8 }}>
            <StatusBadge status={invoice.status}/>
          </div>
        </div>

        <div className="drawer-body col gap-16">
          {/* 탭: 입금/지급 매칭 */}
          {innerTab === "match" && (
            <>
              <div className="card" style={{ padding: "12px 16px", background: "var(--surface-2)" }}>
                <div className="row" style={{ fontSize: 13, alignItems: "baseline", gap: 10 }}>
                  <span className="fw-700" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{invoice.vendor || "—"}</span>
                  <span className="num fw-700 ml-auto" style={{ flexShrink: 0 }}>{fmtNum(invoice.totalAmount)}원</span>
                </div>
                <div className="text-xs text-muted2" style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {invoice.contract || "계약 없음"}
                </div>
              </div>

              <div>
                <div className="fw-700" style={{ marginBottom: 8 }}>
                  {isIssued ? "입금" : "지급"} 이력
                </div>
                {(invoice.matches?.length ?? 0) > 0 ? (
                  <div className="col gap-6" style={{ marginBottom: 12 }}>
                    {(invoice.matches || []).map((m, i) => (
                      <div key={i} className="row gap-10"
                        style={{ padding: "8px 12px", borderRadius: 8, background: "var(--surface-2)", fontSize: 13 }}>
                        <Icon.Check size={14} style={{ color: "var(--pos)" }}/>
                        <span className="text-muted">{m.matchedAt}</span>
                        <span className="num fw-700 ml-auto">{fmtNum(m.amount)}</span>
                      </div>
                    ))}
                    <div className="row" style={{ paddingTop: 8, borderTop: "1px solid var(--line)", fontSize: 13 }}>
                      <span className="text-muted">잔여</span>
                      <span className="num fw-700 ml-auto"
                        style={{ color: invoice.remainAmount > 0 ? "var(--warn-ink)" : "var(--pos)" }}>
                        {fmtNum(invoice.remainAmount)}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted" style={{ marginBottom: 12 }}>매칭된 거래 없음</div>
                )}

                {invoice.remainAmount > 0 && (
                  <div className="col gap-10">
                    <div style={{ display: "flex", background: "var(--surface-2)", borderRadius: 8, padding: 3, gap: 2 }}>
                      {[["link", `거래내역에서 연결${(relatedCands.length || candidates.length) ? ` (${relatedCands.length || candidates.length})` : ""}`], ["new", "새 거래로 등록"]].map(([v, l]) => (
                        <button key={v} onClick={() => setMatchMode(v)}
                          style={{ flex: 1, padding: "7px 0", border: 0, borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "inherit",
                            background: matchMode === v ? "#fff" : "transparent", color: matchMode === v ? "var(--ink)" : "var(--muted-2)",
                            boxShadow: matchMode === v ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }}>
                          {l}
                        </button>
                      ))}
                    </div>

                    {matchMode === "link" ? (
                      candidates.length === 0 ? (
                        <div className="text-sm text-muted" style={{ padding: "10px 0", textAlign: "center", lineHeight: 1.6 }}>
                          연결할 미매칭 {isIssued ? "입금" : "지출"} 거래가 없어요.<br/>'새 거래로 등록'을 쓰거나, 거래내역·엑셀로 먼저 등록하세요.
                        </div>
                      ) : (
                        <div className="col gap-6">
                          <div className="row" style={{ alignItems: "center", gap: 8 }}>
                            <div className="text-xs text-muted2" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {showAll ? "전체 미매칭 거래" : "추천 거래 (거래처·금액 일치)"}
                            </div>
                            {hasOther && (
                              <button className="btn ghost sm ml-auto" style={{ fontSize: 11, flexShrink: 0 }} onClick={() => setShowAll(s => !s)}>
                                {showAll ? "거래처 일치만" : `전체 ${candidates.length}건 보기`}
                              </button>
                            )}
                          </div>
                          {shownCands.length === 0 ? (
                            <div className="text-sm text-muted" style={{ padding: "10px 0", textAlign: "center" }}>이 거래처의 미매칭 거래가 없어요.</div>
                          ) : shownCands.map(t => (
                            <div key={t.id} className="row gap-10" style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10, fontSize: 13, alignItems: "center" }}>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div className="row gap-8" style={{ alignItems: "center" }}>
                                  <span className="num text-muted" style={{ flexShrink: 0 }}>{t.date}</span>
                                  <span className="fw-600" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{t.vendor_name || "—"}</span>
                                </div>
                                <div className="row gap-6" style={{ marginTop: 2, alignItems: "center", flexWrap: "wrap" }}>
                                  <span className="text-xs text-muted2" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.category || "—"}</span>
                                  {t.sameVendor && <span className="badge brand" style={{ fontSize: 10, flexShrink: 0 }}>거래처 일치</span>}
                                  {(t.matchTotal || t.matchRemain) && <span className="badge pos" style={{ fontSize: 10, flexShrink: 0 }}>금액 일치</span>}
                                  {t.matchSupply && <span className="badge outline" style={{ fontSize: 10, flexShrink: 0 }}>공급가 일치</span>}
                                </div>
                              </div>
                              <span className="num fw-700" style={{ flexShrink: 0 }}>{fmtNum(t.amount)}</span>
                              <button className="btn sm primary" style={{ flexShrink: 0 }} onClick={() => linkMatch(t)}>연결</button>
                            </div>
                          ))}
                        </div>
                      )
                    ) : (
                      <>
                        <label className="label">{isIssued ? "입금" : "지급"} 금액</label>
                        <input className="input num" placeholder={fmtNum(invoice.remainAmount)} value={matchAmt}
                          onChange={e => setMatchAmt(e.target.value)}/>
                        <div className="row gap-6" style={{ flexWrap: "wrap" }}>
                          {[invoice.remainAmount, Math.round(invoice.remainAmount / 2)].filter(Boolean).map(a => (
                            <button key={a} className="chip" onClick={() => setMatchAmt(String(a))}>{fmtNum(a)}원</button>
                          ))}
                        </div>
                        <label className="label" style={{ marginTop: 4 }}>
                          {isIssued ? "입금일" : "지급일"} <span style={{ color: "var(--neg-ink)" }}>*</span>
                          <span className="text-muted2 fw-600" style={{ marginLeft: 6, fontWeight: 400 }}>· 기본값: 오늘</span>
                        </label>
                        <input type="date" className="input" value={matchDate}
                          max={localDate()}
                          onChange={e => setMatchDate(e.target.value)}/>
                        <button className="btn primary" style={{ marginTop: 4 }} onClick={handleMatch}>
                          <Icon.Check size={14}/> {labelPaid} 처리 (새 거래 생성)
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* 탭: 청구 정보 */}
          {innerTab === "info" && (
            <div className="card" style={{ padding: 16, background: "var(--surface-2)" }}>
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "10px 16px", fontSize: 13 }}>
                <span className="text-muted">거래처</span><span className="fw-700">{invoice.vendor}</span>
                <span className="text-muted">계약</span><span>{invoice.contract || "—"}</span>
                <span className="text-muted">공급가액</span><span className="num fw-600">{fmtNum(invoice.supplyAmount)}</span>
                <span className="text-muted">부가세</span><span className="num fw-600">{fmtNum(invoice.vatAmount)}</span>
                <span className="text-muted">청구금액</span>
                <span className="num fw-700" style={{ fontSize: 15 }}>{fmtNum(invoice.totalAmount)}</span>
                <span className="text-muted">발행일</span><span>{invoice.issuedAt}</span>
                <span className="text-muted">지급기한</span>
                <span className="fw-600"
                  style={{ color: ["기한 지남","장기 미수"].includes(invoice.status) ? "var(--neg-ink)" : undefined }}>
                  {invoice.dueAt}
                </span>
                {invoice.memo && <><span className="text-muted">메모</span><span>{invoice.memo}</span></>}
              </div>
            </div>
          )}

          {/* 탭: 첨부 서류 */}
          {innerTab === "docs" && (
            <div>
              <label className="drop" style={{ display: "block", marginBottom: 16, padding: "20px 16px", cursor: "pointer" }}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); uploadDoc(e.dataTransfer.files[0]) }}>
                <Icon.Upload size={20}/>
                <div className="text-sm fw-600" style={{ marginTop: 6 }}>파일을 끌어다 놓거나 클릭</div>
                <div className="text-xs text-muted2" style={{ marginTop: 2 }}>
                  세금계산서 · 납품확인서 · 검사성적서 · PDF, JPG, PNG
                </div>
                <input type="file" style={{ display: "none" }} accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.hwp" onChange={e => uploadDoc(e.target.files[0])}/>
              </label>

              {docs.length === 0 ? (
                <div className="text-sm text-muted" style={{ textAlign: "center", padding: "20px 0" }}>
                  첨부된 서류가 없습니다
                </div>
              ) : (
                <div className="col gap-8">
                  {docs.map((d, i) => (
                    <div key={d.id || i} className="row gap-12"
                      style={{ padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 10, background: "#fff" }}>
                      <div style={{
                        width: 36, height: 36, borderRadius: 8, background: "var(--surface-3)",
                        display: "grid", placeItems: "center", flexShrink: 0, color: "var(--muted)",
                      }}>
                        {DOC_TYPE_ICON[d.type] || <Icon.File size={16}/>}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="fw-600 text-sm"
                          style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {d.name}
                        </div>
                        <div className="text-xs text-muted2">{d.type}{d.size ? ` · ${Math.round(d.size / 1024)}KB` : ''}</div>
                      </div>
                      <a className="btn ghost sm" href={d.url} target="_blank" rel="noreferrer" download={d.name} style={{ textDecoration: "none" }}>
                        <Icon.Download size={13}/>
                      </a>
                      {d.id && <button className="btn ghost sm" style={{ color: "var(--neg)" }} onClick={() => removeDoc(d.id)}>
                        <Icon.Close size={13}/>
                      </button>}
                    </div>
                  ))}
                </div>
              )}

              <div className="row gap-6" style={{ marginTop: 16, flexWrap: "wrap" }}>
                {["세금계산서", "납품확인서", "검사성적서", "거래명세서", "계약서"].map(t => (
                  <label key={t} className="chip" style={{ cursor: "pointer" }}>
                    <Icon.Plus size={11}/> {t}
                    <input type="file" style={{ display: "none" }} accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.hwp" onChange={e => uploadDoc(e.target.files[0], t)}/>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>닫기</button>
          {invoice.remainAmount > 0 && innerTab === "match" && (
            <button className="btn" style={{ marginLeft: "auto" }}
              onClick={() => toast.push("독촉 메일을 발송했어요")}>
              <Icon.Bell size={14}/> 독촉 발송
            </button>
          )}
        </div>
    </Drawer>
  )
}

// ── 청구서 발행 Drawer ────────────────────────────────────────────
const InvoiceFormDrawer = ({ open, onClose, defaultKind = "issued", toast, onSave, editInvoice }) => {
  const [form, setForm] = useState({
    kind: defaultKind, vendor: "", contract: "", supplyAmount: "", vatAmount: "", dueAt: "", memo: "",
    accountId: "",
  })
  const [vendors, setVendors] = useState([])
  const [accounts, setAccounts] = useState([])
  const [contracts, setContracts] = useState([])

  useEffect(() => {
    api.getVendors().then(setVendors)
    api.getAccounts().then(list => {
      setAccounts(list)
      setForm(f => ({ ...f, accountId: f.accountId || list[0]?.id || "" }))
    })
    api.getContracts().then(setContracts)
  }, [])

  useEffect(() => {
    if (!open) return
    if (editInvoice) {
      setForm({
        kind: editInvoice.kind,
        vendor: editInvoice.vendor || "",
        contract: editInvoice.contract || "",
        supplyAmount: String(editInvoice.supplyAmount || ""),
        vatAmount: String(editInvoice.vatAmount || ""),
        dueAt: editInvoice.dueAt || "",
        memo: editInvoice.memoRaw || "",
        accountId: editInvoice.accountId || accounts[0]?.id || "",
      })
    } else {
      setForm({ kind: defaultKind, vendor: "", contract: "", supplyAmount: "", vatAmount: "", dueAt: "", memo: "", accountId: accounts[0]?.id || "" })
    }
  }, [open, defaultKind, editInvoice])

  const f = (k, v) => {
    const next = { ...form, [k]: v }
    if (k === "supplyAmount") {
      const n = parseInt(v.replace(/[^0-9]/g, "")) || 0
      next.vatAmount = String(Math.round(n * 0.1))
      next.supplyAmount = v
    }
    if (k === "vendor") next.contract = ""
    setForm(next)
  }

  const supply = parseInt(form.supplyAmount.replace(/[^0-9]/g, "")) || 0
  const vat    = parseInt(form.vatAmount) || Math.round(supply * 0.1)
  const total  = supply + vat

  const vendorOptions = (form.kind === "issued"
    ? vendors.filter(v => v.gubu === "B")
    : vendors.filter(v => ["A", "E"].includes(v.gubu))
  ).map(v => ({ value: v.name, label: v.name, sub: v.type }))

  const contractOptions = [
    ...contracts.map(c => ({ value: c.name, label: c.name, sub: `${c.vendor_name || ''} · ${c.status || ''}` })),
    { value: "공통(원자재)",   label: "공통(원자재)",   sub: "특정 계약 없음" },
    { value: "공통(생산소모)", label: "공통(생산소모)", sub: "특정 계약 없음" },
    { value: "공통",           label: "공통",           sub: "사무·운영" },
  ]

  const handleSave = () => {
    if (!form.vendor) { toast.push("거래처를 선택하세요", { tone: "warn" }); return }
    if (!supply) { toast.push("공급가액을 입력하세요", { tone: "warn" }); return }
    const vendorObj = vendors.find(v => v.name === form.vendor)
    const contractObj = contracts.find(c => c.name === form.contract)
    onSave({
      id: editInvoice?.id,
      kind: form.kind,
      vendor_id: vendorObj?.id || null,
      contract_id: contractObj?.id || null,
      supply_amount: supply, vat_amount: vat, total_amount: total,
      issued_at: editInvoice ? editInvoice.issuedAt : new Date().toISOString().slice(0, 10),
      due_at: form.dueAt || null,
      status: editInvoice ? editInvoice.status : (form.kind === "issued" ? "입금 예정" : "지급 예정"),
      account_id: form.accountId || null, memo: form.memo || "",
    })
    onClose()
  }

  return (
    <Drawer open={open} onClose={onClose}>
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>
              {editInvoice ? "청구서 수정" : (form.kind === "issued" ? "청구서 발행" : "청구서 등록 (수취)")}
            </div>
            <div className="text-xs text-muted">
              {editInvoice ? "청구서 내용을 수정합니다" : (form.kind === "issued" ? "발주처에 청구서를 발행합니다" : "협력사로부터 받은 청구서를 등록합니다")}
            </div>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>
        <div className="drawer-body col gap-16">
          {!editInvoice && (
            <div className="row gap-8">
              {["issued", "received"].map(k => (
                <button key={k} className={`chip ${form.kind === k ? "active" : ""}`} onClick={() => f("kind", k)}>
                  {k === "issued" ? "발행 (미수금)" : "수취 (미지급금)"}
                </button>
              ))}
            </div>
          )}

          <div>
            <label className="label">거래처 <span style={{ color: "var(--neg-ink)" }}>*</span></label>
            <Combobox
              value={form.vendor}
              onChange={v => f("vendor", v)}
              options={vendorOptions}
              placeholder={form.kind === "issued" ? "발주처 선택" : "협력사·기관 선택"}
              onAddNew={q => { f("vendor", q); toast.push(`"${q}" 거래처를 직접 입력했어요`) }}
              addNewLabel="직접 입력"/>
          </div>
          <div>
            <label className="label">계약 / 귀속</label>
            <Combobox
              value={form.contract}
              onChange={v => f("contract", v)}
              options={contractOptions}
              placeholder="계약 선택 (선택)"
              onAddNew={q => { f("contract", q); toast.push(`"${q}" 계약명을 직접 입력했어요`) }}
              addNewLabel="직접 입력"/>
          </div>
          <div>
            <label className="label">공급가액</label>
            <input className="input num" placeholder="0" value={form.supplyAmount}
              onChange={e => f("supplyAmount", e.target.value)}/>
          </div>
          <div className="row gap-12">
            <div style={{ flex: 1 }}>
              <label className="label">부가세</label>
              <input className="input num" placeholder="자동 계산" value={form.vatAmount}
                onChange={e => f("vatAmount", e.target.value)}/>
            </div>
            <div style={{ flex: 1 }}>
              <label className="label">합계</label>
              <div className="input num fw-700" style={{ background: "var(--surface-2)", display: "flex", alignItems: "center" }}>
                {fmtNum(total)}
              </div>
            </div>
          </div>
          <div>
            <label className="label">지급 기한</label>
            <input className="input" type="date" value={form.dueAt} onChange={e => f("dueAt", e.target.value)}/>
          </div>
          <div>
            <label className="label">{form.kind === "issued" ? "수금 계좌" : "지급 계좌"}</label>
            <div className="row gap-6" style={{ flexWrap: "wrap" }}>
              {accounts.map(acc => (
                <button key={acc.id} type="button"
                  className={`chip ${form.accountId === acc.id ? "active" : ""}`}
                  onClick={() => f("accountId", acc.id)}>
                  <Icon.Bank size={12}/>{acc.name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">메모 (선택)</label>
            <input className="input" placeholder="기성고 3차, 잔금 등" value={form.memo} onChange={e => f("memo", e.target.value)}/>
          </div>

          <div>
            <label className="label">첨부 서류 (선택)</label>
            <div className="drop" style={{ padding: "16px 12px" }}
              onClick={() => toast.push("파일 선택 창을 열었어요")}>
              <Icon.Upload size={18}/>
              <div className="text-sm fw-600" style={{ marginTop: 4 }}>세금계산서·납품확인서 첨부</div>
              <div className="text-xs text-muted2" style={{ marginTop: 2 }}>PDF, JPG, PNG</div>
            </div>
          </div>
        </div>
        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary ml-auto" onClick={handleSave}><Icon.Check size={14}/> {editInvoice ? "저장" : "등록"}</button>
        </div>
    </Drawer>
  )
}

// ── 요약 카드 ────────────────────────────────────────────────────
const SummaryCard = ({ label, amount, count, accent = "blue", warn }) => (
  <div className="card" style={{ padding: "16px 18px" }}>
    <div className="row" style={{ marginBottom: 6 }}>
      <span className="text-sm text-muted fw-600">{label}</span>
      <span className={`badge ${accent} ml-auto`}>{count}건</span>
    </div>
    <div className="num fw-700" style={{ fontSize: 22, color: warn ? "var(--neg-ink)" : undefined }}>
      {fmtNum(amount)}
    </div>
  </div>
)

// ── 청구서 테이블 ────────────────────────────────────────────────
const InvoiceTable = ({ rows, onSelect }) => (
  <div className="card" style={{ overflow: "hidden" }}>
    <table className="table">
      <thead>
        <tr>
          <th>청구번호</th>
          <th>거래처</th>
          <th>계약</th>
          <th className="num-right">청구금액</th>
          <th className="num-right">잔여</th>
          <th>기한</th>
          <th>상태</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={7} className="text-center text-muted" style={{ padding: 32 }}>해당 청구서가 없습니다</td></tr>
        )}
        {rows.map(inv => (
          <tr key={inv.id} style={{ cursor: "pointer" }} onClick={() => onSelect(inv)}>
            <td className="text-sm text-muted num">{inv.invoiceNo}</td>
            <td className="fw-700">{inv.vendor}</td>
            <td className="text-sm text-muted">{inv.contract || "—"}</td>
            <td className="num-cell num-right">{fmtNum(inv.totalAmount)}</td>
            <td className="num-cell num-right">
              {inv.remainAmount > 0
                ? <span style={{ color: "var(--warn-ink)", fontWeight: 700 }}>{fmtNum(inv.remainAmount)}</span>
                : <span className="text-muted">—</span>}
            </td>
            <td>
              <span className="text-sm">{inv.dueAt}</span>
              {inv.dueAt && (
                <span className={`badge ${ddayTone(inv.dueAt)}`} style={{ marginLeft: 6, fontSize: 10 }}>
                  {dday(inv.dueAt)}
                </span>
              )}
            </td>
            <td><StatusBadge status={inv.status}/></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

// ── 발행 예정(대기) 청구 일정 테이블 ─────────────────────────────
const PendingScheduleTable = ({ rows, onIssue, onPaid }) => (
  <div className="card" style={{ overflow: "hidden" }}>
    <table className="table">
      <thead>
        <tr>
          <th>예정일</th><th>거래처</th><th>계약</th><th>유형</th>
          <th className="num-right">청구금액(VAT 포함)</th><th style={{ width: 210 }}></th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={6} className="text-center text-muted" style={{ padding: 32 }}>
            발행 예정인 청구 일정이 없어요. 계약 상세의 '청구 일정'에서 청구할 금액·시점을 등록하세요.
          </td></tr>
        )}
        {rows.map(p => {
          const total = p.amount + Math.round(p.amount * 0.1)
          return (
            <tr key={p.milestone_id}>
              <td className="num text-sm">
                {p.due_date || "—"}
                {p.due_date && <span className={`badge ${ddayTone(p.due_date)}`} style={{ marginLeft: 6, fontSize: 10 }}>{dday(p.due_date)}</span>}
              </td>
              <td className="fw-700">{p.vendor_name || "—"}</td>
              <td className="text-sm text-muted">{p.contract_name}{p.contract_no ? ` · ${p.contract_no}` : ""}</td>
              <td><span className="badge outline">{p.type}</span></td>
              <td className="num-cell num-right fw-700">{fmtNum(total)}</td>
              <td>
                <div className="row gap-6">
                  <button className="btn primary sm" onClick={() => onIssue(p)}><Icon.Receipt size={12}/> 발행 처리</button>
                  <button className="btn sm" onClick={() => onPaid(p)}>기입금 처리</button>
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  </div>
)

// ── 메인 BillingScreen ───────────────────────────────────────────
export const BillingScreen = ({ initialTab = "issued" }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const kind = initialTab              // 'issued'(대금청구) | 'received'(수취)
  const isIssued = kind === "issued"
  const [view, setView] = useState("pending")   // issued: pending|list
  const [invoices, setInvoices] = useState([])
  const [pending, setPending]   = useState([])
  const [recSummary, setRecSummary] = useState(null)
  const [paySum, setPaySum]     = useState(null)
  const [selected, setSelected] = useState(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editInvoice, setEditInvoice] = useState(null)
  const [statusFilter, setStatusFilter] = useState("전체")

  const load = async () => {
    const [rows, rec, pay, pend] = await Promise.all([
      api.getInvoices(),
      api.getReceivablesSummary(),
      api.getPayablesSummary(),
      isIssued ? api.getPendingSchedules("sales") : Promise.resolve([]),
    ])
    setInvoices(rows); setRecSummary(rec); setPaySum(pay); setPending(pend)
  }
  useEffect(() => { load() }, [])

  const kindRows = invoices.filter(inv => inv.kind === kind)
  const STATUS_OPTIONS = isIssued
    ? ["전체", "입금 예정", "일부 입금", "기한 지남", "장기 미수", "입금 완료"]
    : ["전체", "지급 대기", "지급 예정", "일부 지급", "기한 지남", "지급 완료"]
  const filtered = kindRows.filter(inv => statusFilter === "전체" || inv.status === statusFilter)
  const pendingTotal = pending.reduce((s, p) => s + (p.amount + Math.round(p.amount * 0.1)), 0)

  const issueSchedule = async (p, paid) => {
    const supply = p.amount || 0
    const vat = Math.round(supply * 0.1)
    const ok = await confirm({
      tone: "brand", icon: paid ? <Icon.Check size={22}/> : <Icon.Receipt size={22}/>,
      title: paid ? "기입금 처리" : "청구서 발행",
      body: paid
        ? `${p.vendor_name} · ${p.type} ${fmtNum(supply + vat)}원을 이미 입금된 건으로 처리해요. (청구서가 입금 완료로 생성됩니다)`
        : `${p.vendor_name} · ${p.type} ${fmtNum(supply + vat)}원(VAT 포함) 청구서를 발행해요. 미수금으로 등록됩니다.`,
      confirmLabel: paid ? "기입금 처리" : "청구서 발행",
    })
    if (!ok) return
    // 원자적: 청구서 + (기입금 시)입금거래·매칭 + 청구 일정 상태·연결을 서버 한 트랜잭션에서 처리
    const res = await api.issueSchedule(p.milestone_id, { paid })
    if (!res.ok) { toast.push(res.error || "발행에 실패했어요"); return }
    toast.push(paid ? "기입금 처리했어요" : "청구서를 발행했어요")
    load()
  }

  const handleMatch = async (invoiceId, amount, date, txnId) => {
    await api.matchInvoice(invoiceId, { txnId: txnId || null, amount, date })
    toast.push("매칭 처리가 완료됐어요")
    load()
  }

  const handleSave = async (data) => {
    if (data.id) {
      const res = await api.updateInvoice(data.id, data)
      toast.push(res.ok === false ? "수정 실패" : "청구서가 수정됐어요")
    } else {
      await api.addInvoice(data)
      toast.push("청구서가 등록됐어요")
    }
    load()
  }

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 6 }}>
        <div>
          <div className="page-title">{isIssued ? "대금 청구" : "수취 청구서"}</div>
          <div className="page-sub">
            {isIssued
              ? "계약 청구 일정을 청구서로 발행하고, 입금을 확인하세요."
              : "협력사·기관에서 받은 청구서(미지급금)를 관리하세요."}
          </div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn primary" onClick={() => { setEditInvoice(null); setFormOpen(true) }}>
            <Icon.Plus size={14}/> 청구서 {isIssued ? "발행" : "등록"}
          </button>
        </div>
      </div>
      <Spacer h={16}/>

      {/* 요약 카드 */}
      <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
        {isIssued ? (
          <>
            <SummaryCard label="발행 예정(대기)" amount={pendingTotal}                count={pending.length}                  accent="brand"/>
            <SummaryCard label="미수금 합계"      amount={recSummary?.total ?? 0}       count={recSummary?.count ?? 0}          accent="blue"/>
            <SummaryCard label="연체 미수금"      amount={recSummary?.overdueAmount ?? 0} count={recSummary?.overdueCount ?? 0} accent="neg" warn/>
          </>
        ) : (
          <>
            <SummaryCard label="미지급금 합계"   amount={paySum?.total ?? 0}         count={paySum?.count ?? 0}         accent="warn"/>
            <SummaryCard label="연체 미지급금"   amount={paySum?.overdueAmount ?? 0} count={paySum?.overdueCount ?? 0}  accent="neg" warn/>
            <div/>
          </>
        )}
      </div>

      {/* 탭: 발행 예정 | 발행됨 (issued) / 상태 필터 */}
      <div className="row gap-8" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        {isIssued && (
          <>
            <button className={`chip ${view === "pending" ? "active" : ""}`} onClick={() => setView("pending")}>
              발행 예정 {pending.length > 0 && <span className="badge brand" style={{ marginLeft: 6 }}>{pending.length}</span>}
            </button>
            <button className={`chip ${view === "list" ? "active" : ""}`} onClick={() => setView("list")}>
              발행됨 <span className="badge outline" style={{ marginLeft: 6 }}>{kindRows.length}</span>
            </button>
          </>
        )}
        {(!isIssued || view === "list") && (
          <div className="ml-auto row gap-6" style={{ flexWrap: "wrap" }}>
            {STATUS_OPTIONS.map(s => (
              <button key={s} className={`chip ${statusFilter === s ? "active" : ""}`} onClick={() => setStatusFilter(s)} style={{ fontSize: 12 }}>{s}</button>
            ))}
          </div>
        )}
      </div>

      {isIssued && view === "pending"
        ? <PendingScheduleTable rows={pending} onIssue={(p) => issueSchedule(p, false)} onPaid={(p) => issueSchedule(p, true)}/>
        : <InvoiceTable rows={filtered} onSelect={setSelected}/>}

      <InvoiceDetailDrawer
        invoice={selected}
        onClose={() => setSelected(null)}
        onMatch={handleMatch}
        onEdit={(inv) => { setEditInvoice(inv); setSelected(null); setFormOpen(true) }}
        toast={toast}
      />

      <InvoiceFormDrawer
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditInvoice(null) }}
        defaultKind={kind}
        editInvoice={editInvoice}
        toast={toast}
        onSave={handleSave}
      />
    </div>
  )
}
