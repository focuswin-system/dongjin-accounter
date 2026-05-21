import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge, Drawer } from '../lib/ui'
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

const InvoiceDetailDrawer = ({ invoice, onClose, onMatch, onDelete, toast }) => {
  const { confirm } = useConfirm()
  const [matchAmt, setMatchAmt] = useState("")
  const [matchDate, setMatchDate] = useState(localDate())
  const [innerTab, setInnerTab] = useState("match")

  if (!invoice) return null

  const isIssued  = invoice.kind === "issued"
  const labelPaid = isIssued ? "입금 완료" : "지급 완료"
  const docs      = MOCK_DOCS[invoice.id] || []

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
    if (ok) { onMatch(invoice.id, amount); onClose() }
  }

  return (
    <Drawer open={true} onClose={onClose}>
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>청구서 상세</div>
            <div className="text-xs text-muted">{invoice.id}</div>
          </div>
          <div className="ml-auto row gap-6">
            <button className="btn" style={{ fontSize: 12 }}
              onClick={() => toast.push("청구서 수정 기능은 준비 중입니다")}>
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
                <div className="row" style={{ fontSize: 13 }}>
                  <span className="text-muted">{invoice.vendor} · {invoice.contract || "계약 없음"}</span>
                  <span className="num fw-700 ml-auto">{fmtNum(invoice.totalAmount)}원</span>
                </div>
              </div>

              <div>
                <div className="fw-700" style={{ marginBottom: 8 }}>
                  {isIssued ? "입금" : "지급"} 이력
                </div>
                {invoice.matches.length > 0 ? (
                  <div className="col gap-6" style={{ marginBottom: 12 }}>
                    {invoice.matches.map((m, i) => (
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
                  <div className="col gap-8">
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
                      <Icon.Check size={14}/> {labelPaid} 처리
                    </button>
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
              <div className="drop" style={{ marginBottom: 16, padding: "20px 16px" }}
                onClick={() => toast.push("파일 선택 창을 열었어요")}>
                <Icon.Upload size={20}/>
                <div className="text-sm fw-600" style={{ marginTop: 6 }}>파일을 끌어다 놓거나 클릭</div>
                <div className="text-xs text-muted2" style={{ marginTop: 2 }}>
                  세금계산서 · 납품확인서 · 검사성적서 · PDF, JPG, PNG
                </div>
              </div>

              {docs.length === 0 ? (
                <div className="text-sm text-muted" style={{ textAlign: "center", padding: "20px 0" }}>
                  첨부된 서류가 없습니다
                </div>
              ) : (
                <div className="col gap-8">
                  {docs.map((d, i) => (
                    <div key={i} className="row gap-12"
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
                        <div className="text-xs text-muted2">{d.type} · {d.size} · {d.date}</div>
                      </div>
                      <button className="btn ghost sm" onClick={() => toast.push("파일을 내려받았어요")}>
                        <Icon.Download size={13}/>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="row gap-6" style={{ marginTop: 16, flexWrap: "wrap" }}>
                {["세금계산서", "납품확인서", "검사성적서", "거래명세서", "계약서"].map(t => (
                  <button key={t} className="chip"
                    onClick={() => toast.push(`${t} 파일을 첨부해주세요`)}>
                    <Icon.Plus size={11}/> {t}
                  </button>
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
const InvoiceFormDrawer = ({ open, onClose, defaultKind = "issued", toast, onSave }) => {
  const [form, setForm] = useState({
    kind: defaultKind, vendor: "", contract: "", supplyAmount: "", vatAmount: "", dueAt: "", memo: "",
  })

  useEffect(() => {
    if (open) setForm({ kind: defaultKind, vendor: "", contract: "", supplyAmount: "", vatAmount: "", dueAt: "", memo: "" })
  }, [open, defaultKind])

  const f = (k, v) => {
    const next = { ...form, [k]: v }
    if (k === "supplyAmount") {
      const n = parseInt(v.replace(/[^0-9]/g, "")) || 0
      next.vatAmount = String(Math.round(n * 0.1))
      next.supplyAmount = v
    }
    setForm(next)
  }

  const supply = parseInt(form.supplyAmount.replace(/[^0-9]/g, "")) || 0
  const vat    = parseInt(form.vatAmount) || Math.round(supply * 0.1)
  const total  = supply + vat

  const handleSave = () => {
    if (!form.vendor) { toast.push("거래처를 입력하세요", { tone: "warn" }); return }
    if (!supply) { toast.push("공급가액을 입력하세요", { tone: "warn" }); return }
    onSave({
      kind: form.kind, vendor: form.vendor, contract: form.contract,
      supplyAmount: supply, vatAmount: vat, totalAmount: total,
      issuedAt: new Date().toISOString().slice(0, 10), dueAt: form.dueAt,
      status: form.kind === "issued" ? "입금 예정" : "지급 예정",
      accountId: "acc-001", memo: form.memo,
    })
    onClose()
  }

  return (
    <Drawer open={open} onClose={onClose}>
        <div className="drawer-head">
          <div>
            <div className="fw-700" style={{ fontSize: 16 }}>
              {form.kind === "issued" ? "청구서 발행" : "청구서 등록 (수취)"}
            </div>
            <div className="text-xs text-muted">
              {form.kind === "issued" ? "발주처에 청구서를 발행합니다" : "협력사로부터 받은 청구서를 등록합니다"}
            </div>
          </div>
          <button className="icon-btn ml-auto" onClick={onClose}><Icon.Close size={16}/></button>
        </div>
        <div className="drawer-body col gap-16">
          <div className="row gap-8">
            {["issued", "received"].map(k => (
              <button key={k} className={`chip ${form.kind === k ? "active" : ""}`} onClick={() => f("kind", k)}>
                {k === "issued" ? "발행 (미수금)" : "수취 (미지급금)"}
              </button>
            ))}
          </div>

          <div>
            <label className="label">거래처</label>
            <input className="input" placeholder="거래처명" value={form.vendor} onChange={e => f("vendor", e.target.value)}/>
          </div>
          <div>
            <label className="label">계약 (선택)</label>
            <input className="input" placeholder="관련 계약명" value={form.contract} onChange={e => f("contract", e.target.value)}/>
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
          <button className="btn primary ml-auto" onClick={handleSave}><Icon.Check size={14}/> 등록</button>
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
            <td className="text-sm text-muted">{inv.id}</td>
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

// ── 메인 BillingScreen ───────────────────────────────────────────
export const BillingScreen = ({ initialTab = "issued" }) => {
  const toast   = useToast()
  const [tab, setTab]           = useState(initialTab)
  const [invoices, setInvoices] = useState([])
  const [recSummary, setRecSummary] = useState(null)
  const [paySum, setPaySum]     = useState(null)
  const [selected, setSelected] = useState(null)
  const [formOpen, setFormOpen] = useState(false)
  const [statusFilter, setStatusFilter] = useState("전체")

  const load = async () => {
    const [rows, rec, pay] = await Promise.all([
      api.getInvoices(),
      api.getReceivablesSummary(),
      api.getPayablesSummary(),
    ])
    setInvoices(rows)
    setRecSummary(rec)
    setPaySum(pay)
  }
  useEffect(() => { load() }, [])

  const issuedRows   = invoices.filter(inv => inv.kind === "issued")
  const receivedRows = invoices.filter(inv => inv.kind === "received")

  const STATUS_OPTIONS_ISSUED   = ["전체", "입금 예정", "일부 입금", "기한 지남", "장기 미수", "입금 완료"]
  const STATUS_OPTIONS_RECEIVED = ["전체", "지급 대기", "지급 예정", "일부 지급", "기한 지남", "지급 완료"]
  const statusOptions = tab === "issued" ? STATUS_OPTIONS_ISSUED : STATUS_OPTIONS_RECEIVED

  const filtered = (tab === "issued" ? issuedRows : receivedRows)
    .filter(inv => statusFilter === "전체" || inv.status === statusFilter)

  const handleMatch = async (invoiceId, amount) => {
    await api.matchInvoice(invoiceId, { txnId: `TXN-${Date.now()}`, amount })
    toast.push("매칭 처리가 완료됐어요")
    load()
  }

  const handleSave = async (data) => {
    await api.addInvoice(data)
    toast.push(`청구서가 등록됐어요`)
    load()
  }

  return (
    <div className="fade-up">
      <div className="row" style={{ marginBottom: 6 }}>
        <div>
          <div className="page-title">청구 관리</div>
          <div className="page-sub">발행 청구서(미수금)와 수취 청구서(미지급금)를 관리하세요.</div>
        </div>
        <div className="ml-auto row gap-8">
          <button className="btn primary" onClick={() => setFormOpen(true)}>
            <Icon.Plus size={14}/> 청구서 등록
          </button>
        </div>
      </div>
      <Spacer h={16}/>

      {/* 요약 카드 */}
      <div className="grid" style={{ gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 24 }}>
        <SummaryCard label="미수금 합계"    amount={recSummary?.total ?? 0}        count={recSummary?.count ?? 0}          accent="blue"/>
        <SummaryCard label="연체 미수금"    amount={recSummary?.overdueAmount ?? 0} count={recSummary?.overdueCount ?? 0}    accent="neg" warn/>
        <SummaryCard label="미지급금 합계"  amount={paySum?.total ?? 0}            count={paySum?.count ?? 0}              accent="warn"/>
        <SummaryCard label="연체 미지급금"  amount={paySum?.overdueAmount ?? 0}    count={paySum?.overdueCount ?? 0}       accent="neg" warn/>
      </div>

      {/* 탭 */}
      <div className="row gap-8" style={{ marginBottom: 16 }}>
        <button className={`chip ${tab === "issued" ? "active" : ""}`} onClick={() => { setTab("issued"); setStatusFilter("전체") }}>
          발행 청구서 (미수금) {recSummary && <span className="badge neg" style={{ marginLeft: 6 }}>{recSummary.count}</span>}
        </button>
        <button className={`chip ${tab === "received" ? "active" : ""}`} onClick={() => { setTab("received"); setStatusFilter("전체") }}>
          수취 청구서 (미지급금) {paySum && <span className="badge warn" style={{ marginLeft: 6 }}>{paySum.count}</span>}
        </button>
        <div className="ml-auto row gap-6" style={{ flexWrap: "wrap" }}>
          {statusOptions.map(s => (
            <button key={s} className={`chip ${statusFilter === s ? "active" : ""}`} onClick={() => setStatusFilter(s)}
              style={{ fontSize: 12 }}>{s}</button>
          ))}
        </div>
      </div>

      <InvoiceTable rows={filtered} onSelect={setSelected}/>

      <InvoiceDetailDrawer
        invoice={selected}
        onClose={() => setSelected(null)}
        onMatch={handleMatch}
        toast={toast}
      />

      <InvoiceFormDrawer
        open={formOpen}
        onClose={() => setFormOpen(false)}
        defaultKind={tab}
        toast={toast}
        onSave={handleSave}
      />
    </div>
  )
}
