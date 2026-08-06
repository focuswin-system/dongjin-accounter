import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, useConfirm, Spacer, StatusBadge, Drawer, Combobox, MoneyInput } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { DrawerHead, DrawerFooter } from '../lib/components/Drawer'
import { DataTable } from '../lib/components/DataTable'
import { ImportWizard } from '../lib/components/ImportWizard'
import { PaidIssueDrawer } from '../lib/components/PaidIssueDrawer'
import { taxInvoiceImportAdapter } from '../lib/taxInvoiceImport'
import { FileAttach } from '../lib/FileAttach'
import { api } from '../lib/api'
import { quickAddCategory } from '../lib/quickAdd'

const STATUS_TONE = {
  "입금 완료": "pos",  "지급 완료": "pos",
  "입금 예정": "brand","지급 예정": "brand",
  "일부 입금": "warn", "일부 지급": "warn",
  "지급 대기": "warn",
  "기한 지남": "neg",  "장기 미수": "neg",
}

// 만기까지 남은 일수. new Date('2026-07-31')는 UTC 자정으로 파싱되므로 현재시각과 직접 빼면
// KST 21시 이후 만기 당일 건이 '+1일 초과'로 표시된다. 로컬 자정끼리 비교한다.
const dayDiff = (due) => Math.round(
  (new Date(`${due}T00:00:00`) - new Date(`${localDate()}T00:00:00`)) / 86400000)

const dday = (due) => {
  if (!due) return ""
  const diff = dayDiff(due)
  if (diff === 0) return "오늘"
  if (diff < 0)   return `+${Math.abs(diff)}일 초과`
  return `D-${diff}`
}

const ddayTone = (due) => {
  if (!due) return "outline"
  const diff = dayDiff(due)
  if (diff < 0)  return "neg"
  if (diff <= 3) return "warn"
  return "outline"
}

// 표시용 상태: 잔여가 남고 기한이 지났으면 '기한 지남'으로 본다(서버 미수/미지급 요약의 연체 기준과 일치).
// 저장된 status는 매칭 시 '일부 입금/지급'까지만 바뀌므로, 화면에서 연체를 덧씌워 요약 카드와 어긋나지 않게 한다.
// '장기 미수'는 이미 연체보다 무거운 상태라 유지한다.
const effStatus = (inv) =>
  (inv.remainAmount > 0 && inv.dueAt && inv.dueAt < localDate() && inv.status !== "장기 미수")
    ? "기한 지남"
    : inv.status

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

const InvoiceDetailDrawer = ({ invoice, onClose, onMatch, onDelete, onEdit, onChanged, toast }) => {
  const { confirm } = useConfirm()
  // 취소 중인 매칭 id — 같은 줄을 두 번 눌러 이미 지운 매칭을 또 지우려 하는 걸 막는다
  const [unmatching, setUnmatching] = useState(null)
  const [matchAmt, setMatchAmt] = useState("")
  const [matchDate, setMatchDate] = useState(localDate())
  const [innerTab, setInnerTab] = useState("match")
  // 기본은 '새 거래로 등록'(정상 워크플로우 — 청구서 열어 바로 입금/지급 기록).
  // '거래내역에서 연결'은 이미 들어온 거래를 뒤늦게 이 청구서에 붙이는 보조 경로라 뒤로.
  const [matchMode, setMatchMode] = useState("new")
  const [candidates, setCandidates] = useState([])
  const [showAll, setShowAll] = useState(false)
  const [docs, setDocs] = useState([])
  // 새 거래로 입금/지급 처리할 때 채울 분류값(자동으로 채우되 수정 가능)
  const [matchCategory, setMatchCategory] = useState("")
  const [matchMemo, setMatchMemo] = useState("")
  const [matchAcct, setMatchAcct] = useState("")
  // 입출금 계좌 — 위 matchAcct(계정과목 코드)와 다른 값이다. 비면 잔액에 반영되지 않는다.
  const [bankAccounts, setBankAccounts] = useState([])
  const [matchBankId, setMatchBankId] = useState("")
  const [categories, setCategories] = useState([])
  const [acctSubjects, setAcctSubjects] = useState([])
  const [jeokyos, setJeokyos] = useState([])
  useEffect(() => {
    if (invoice?.id && invoice.remainAmount > 0) api.getMatchable(invoice.id).then(setCandidates)
    else setCandidates([])
    setShowAll(false)
  }, [invoice?.id, invoice?.remainAmount])
  useEffect(() => { setDocs(invoice?.docs || []) }, [invoice?.id])
  // 청구서에 계좌가 지정돼 있으면 그걸, 없으면 은행계좌를 기본값으로 (정기청구 자동 생성분은 계좌가 비어 있다)
  useEffect(() => {
    api.getAccounts().then(list => {
      setBankAccounts(list)
      setMatchBankId(invoice?.accountId || list.find(a => a.kind === "bank")?.id || "")
    })
  }, [invoice?.id])
  useEffect(() => {
    api.getCategories().then(setCategories)
    // 거래 입력용은 postable 계정만 — 집계 계정(code=NULL)이 섞이면 code로 만든 옵션이
    // value=null 로 여럿 생겨 Combobox key가 중복된다(선택도 불가).
    api.getAccountSubjects({ postableOnly: true }).then(setAcctSubjects)
    api.getRefItems('jeokyo').then(setJeokyos)
  }, [])
  // 청구서 열릴 때 분류 기본값 채움: 비목=수금/대금 지급, 적요=청구서 정산
  useEffect(() => {
    if (!invoice) return
    const isInc = invoice.kind === "issued"
    setMatchCategory(isInc ? "수금" : "대금 지급")
    setMatchMemo(`청구서 ${invoice.invoiceNo || ""} 정산`.trim())
    setMatchAcct("")
  }, [invoice?.id])

  if (!invoice) return null

  const relatedCands = candidates.filter(c => c.related)
  const shownCands = showAll ? candidates : (relatedCands.length ? relatedCands : candidates)
  const hasOther = relatedCands.length > 0 && candidates.length > relatedCands.length

  const isIssued  = invoice.kind === "issued"
  const labelPaid = isIssued ? "입금 완료" : "지급 완료"


  const handleMatch = async () => {
    const amount = parseInt(matchAmt.replace(/[^0-9]/g, ""))
    if (!amount) { toast.push("금액을 입력하세요", { tone: "warn" }); return }
    if (amount > invoice.remainAmount) { toast.push("잔여 금액을 초과할 수 없어요", { tone: "warn" }); return }
    // 계좌가 비면 이 돈이 어느 계좌 잔액에도 잡히지 않는다(서버도 400으로 막는다)
    if (!matchBankId) { toast.push(`${isIssued ? "입금" : "출금"} 계좌를 선택해주세요`, { tone: "warn" }); return }
    const ok = await confirm({
      tone: "brand", icon: <Icon.Check size={22}/>,
      title: `${isIssued ? "입금" : "지급"} 매칭 처리`,
      body: `${fmtNum(amount)}원을 매칭 처리합니다.`,
      confirmLabel: "매칭 처리",
    })
    if (ok) { onMatch(invoice.id, amount, matchDate, null, { category: matchCategory, memo: matchMemo, account_code: matchAcct, account_id: matchBankId }); onClose() }
  }

  /* 정산 취소. 되돌리면 미수금(미지급금)이 그만큼 되살아난다.
     정산이 만든 거래는 서버가 함께 지우고, 원래 있던 거래는 연결만 끊는다 —
     어느 쪽인지 사용자가 미리 알아야 하므로 확인창에 그대로 적는다. */
  const cancelMatch = async (m) => {
    const ok = await confirm({
      tone: "neg", icon: <Icon.Warn size={22}/>,
      title: `${isIssued ? "입금" : "지급"} 정산 취소`,
      body: `${fmtNum(m.amount)}원 정산을 취소해요. ${isIssued ? "미수금" : "미지급금"}이 그만큼 다시 늘어나고, `
        + `이 정산으로 만들어진 거래가 있으면 함께 삭제됩니다.`,
      confirmLabel: "정산 취소",
    })
    if (!ok) return
    setUnmatching(m.id)
    const r = await api.unmatchInvoice(invoice.id, m.id)
    setUnmatching(null)
    if (!r.ok) return toast.push(r.error || "정산 취소에 실패했어요", { tone: 'warn' })
    toast.push(r.removedTxn ? "정산을 취소하고 거래도 삭제했어요" : "정산을 취소했어요")
    onChanged?.()
  }

  const linkMatch = async (txn) => {
    const ok = await confirm({
      tone: "brand", icon: <Icon.Check size={22}/>,
      title: `${isIssued ? "입금" : "지급"} 거래 연결`,
      body: `${txn.date} · ${fmtNum(txn.amount)}원 거래를 이 청구서에 연결해요. 새 거래는 만들지 않아요.`,
      confirmLabel: "연결",
    })
    // 연결 대상에 계좌가 있으면 서버가 그걸 우선 쓴다. 없을 때만 여기 값이 폴백으로 쓰인다.
    if (ok) { onMatch(invoice.id, txn.amount, txn.date, txn.id, { account_id: matchBankId }); onClose() }
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
                if (ok) { onClose(); if (onDelete) onDelete(invoice.id); }
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
            <StatusBadge status={effStatus(invoice)}/>
          </div>
        </div>

        <div className="drawer-body col gap-form">
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
                      <div key={m.id || i} className="row gap-10"
                        style={{ padding: "8px 12px", borderRadius: 8, background: "var(--surface-2)", fontSize: 13 }}>
                        <Icon.Check size={14} style={{ color: "var(--pos)" }}/>
                        <span className="text-muted">{m.matchedAt}</span>
                        <span className="num fw-700 ml-auto">{fmtNum(m.amount)}</span>
                        {/* 정산 취소 — 서버엔 있었는데 부르는 화면이 없어서, 금액이나 상대를 잘못 넣은
                            입금은 되돌릴 방법이 없었다(청구서를 통째로 지우는 수밖에). */}
                        <button className="icon-btn" title={`${isIssued ? "입금" : "지급"} 정산 취소`}
                          disabled={unmatching === m.id || !m.id}
                          onClick={() => cancelMatch(m)}>
                          <Icon.Close size={14}/>
                        </button>
                      </div>
                    ))}
                    <div className="row" style={{ paddingTop: 8, borderTop: "1px solid var(--line)", fontSize: 13 }}>
                      <span className="text-muted">{isIssued ? "미수금" : "미지급금"}</span>
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
                      {[["new", "새 거래로 등록"], ["link", `거래내역에서 연결${(relatedCands.length || candidates.length) ? ` (${relatedCands.length || candidates.length})` : ""}`]].map(([v, l]) => (
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
                        <MoneyInput placeholder={fmtNum(invoice.remainAmount)} value={matchAmt}
                          onChange={raw => setMatchAmt(raw)}/>
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

                        {/* 분류 — 청구서 정보로 미리 채워두고, 필요하면 사용자가 바꾼다 */}
                        <label className="label" style={{ marginTop: 4 }}>비목</label>
                        <Combobox value={matchCategory} onChange={setMatchCategory}
                          options={categories.filter(c => c.id?.startsWith(isIssued ? "INC-" : "EXP-")).map(c => ({ value: c.name, label: c.name, sub: c.group_name || "" }))}
                          placeholder="비목 선택"
                          onAddNew={async (q) => {
                            // 예전에는 값만 넣고 끝나서, 같은 비목을 다음 정산 때 또 타이핑해야 했다.
                            const nm = await quickAddCategory(q, { kind: isIssued ? 'inc' : 'exp', setCategories, toast })
                            if (nm) setMatchCategory(nm)
                          }}
                          addNewLabel="비목으로 등록"/>
                        <label className="label" style={{ marginTop: 4 }}>적요</label>
                        <Combobox value={matchMemo} onChange={setMatchMemo}
                          options={jeokyos.map(j => ({ value: j.name, label: j.name, sub: j.memo || "" }))}
                          placeholder="적요 입력" onAddNew={setMatchMemo} addNewLabel="이 적요로 입력"/>
                        <label className="label" style={{ marginTop: 4 }}>계정과목 <span className="text-muted2 fw-600" style={{ fontSize: 11 }}>· 선택</span></label>
                        <Combobox value={matchAcct} onChange={setMatchAcct}
                          options={acctSubjects.map(a => ({ value: a.code, label: a.name, sub: `${a.code} · ${a.category}`, keywords: a.note || "" }))}
                          placeholder="계정과목 선택 (선택)" allowAdd={false}/>

                        <label className="label" style={{ marginTop: 4 }}>
                          {isIssued ? "입금" : "출금"} 계좌 <span style={{ color: "var(--neg-ink)" }}>*</span>
                        </label>
                        <Combobox value={matchBankId} onChange={setMatchBankId}
                          options={bankAccounts.map(a => ({ value: a.id, label: a.name, sub: [a.kind === "card" ? "카드" : a.bankName, a.number].filter(Boolean).join(" ") }))}
                          placeholder="계좌 선택" allowAdd={false}/>
                        <div className="text-xs text-muted2">이 계좌의 잔액에 반영됩니다.</div>

                        <button className="btn primary" style={{ marginTop: 8 }} onClick={handleMatch}>
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

          {/* 탭: 첨부 서류 — 여러 파일 한 번에 첨부 가능(공용 컴포넌트) */}
          {innerTab === "docs" && (
            <FileAttach
              docs={docs}
              onAdd={async (d) => {
                const res = await api.addInvoiceDoc(invoice.id, { url: d.url, name: d.name, doc_type: '기타', size: d.size || 0 })
                if (res.ok) setDocs(prev => [...prev, { id: res.id, url: d.url, name: d.name, type: '기타', size: d.size || 0 }])
                else toast.push("첨부에 실패했어요", { tone: 'warn' })
              }}
              onRemove={async (d) => {
                if (!d.id) { setDocs(prev => prev.filter(x => x !== d)); return }
                const res = await api.deleteInvoiceDoc(d.id)
                if (res.ok) setDocs(prev => prev.filter(x => x.id !== d.id))
                else toast.push("삭제에 실패했어요", { tone: 'warn' })
              }}
              label="세금계산서·납품확인서 등을 끌어다 놓거나 클릭 (여러 개 가능)"/>
          )}
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={onClose}>닫기</button>
          {/* 매입 미지급금은 우리가 낼 돈이라 독촉 대상이 아님 → 지급결의서 발행.
              (제거) 매출 미수금의 '독촉 발송' — 누르면 "독촉 메일을 발송했어요"라고 알렸지만
              서버에 메일 발송 경로가 **아예 없다**(독촉·메일 관련 코드 0건). 아무것도 안 나가는데
              보낸 줄 알고 넘어가면 수금이 그만큼 밀리고, 보낸 이력도 남지 않아 확인할 방법도 없다.
              메일 발송을 실제로 붙일 때 되살린다. */}
          {isIssued
            ? null
            : (
                <button className="btn primary" style={{ marginLeft: "auto" }}
                  onClick={async () => {
                    const res = await api.createResolutionFromInvoice(invoice.id);
                    if (!res.ok) return toast.push(res.error || "결의서 생성에 실패했어요", { tone: 'warn' });
                    toast.push(res.resolution.reused ? "이미 만든 결의서를 엽니다" : `지급결의서 ${res.resolution.doc_no}를 만들었어요`);
                    onClose();
                    window.location.hash = "doc";
                  }}>
                  <Icon.Sign size={14}/> 지급결의서 발행
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
  // 첨부 파일 — 발행 전이라 청구서 id가 없으므로 먼저 업로드해 두고, 저장 후 청구서에 연결(지연 첨부)
  const [docs, setDocs] = useState([])

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
    setDocs([])   // 폼에서의 첨부는 이번에 새로 올리는 것만. 기존 첨부는 청구서 상세에서 관리.
    if (editInvoice) {
      setForm({
        kind: editInvoice.kind,
        vendor: editInvoice.vendor || "",
        contract: editInvoice.contract || "",
        supplyAmount: String(editInvoice.supplyAmount || ""),
        // 세액 0(면세·영세)이 String(0||'')로 ''가 되어 자동 10%로 되살아나던 버그 → null만 빈칸.
        vatAmount: editInvoice.vatAmount != null ? String(editInvoice.vatAmount) : "",
        // 과세유형: 저장값이 있으면 그대로, 없으면(옛 청구서) 세액 유무로 추론
        taxType: editInvoice.taxType || (Number(editInvoice.vatAmount) > 0 ? "과세" : "면세"),
        dueAt: editInvoice.dueAt || "",
        memo: editInvoice.memoRaw || "",
        accountId: editInvoice.accountId || accounts[0]?.id || "",
      })
    } else {
      setForm({ kind: defaultKind, vendor: "", contract: "", supplyAmount: "", vatAmount: "", taxType: "과세", dueAt: "", memo: "", accountId: accounts[0]?.id || "" })
    }
  }, [open, defaultKind, editInvoice])

  const f = (k, v) => {
    const next = { ...form, [k]: v }
    // 과세일 때만 공급가 변경 시 세액을 10%로 자동 채운다. 면세·영세는 세액 0을 유지한다.
    if (k === "supplyAmount") {
      const n = parseInt(v.replace(/[^0-9]/g, "")) || 0
      next.vatAmount = next.taxType === "과세" ? String(Math.round(n * 0.1)) : "0"
      next.supplyAmount = v
    }
    if (k === "taxType") {
      const n = parseInt(String(next.supplyAmount).replace(/[^0-9]/g, "")) || 0
      next.vatAmount = v === "과세" ? String(Math.round(n * 0.1)) : "0"
    }
    if (k === "vendor") next.contract = ""
    setForm(next)
  }

  const taxable = form.taxType === "과세"
  const supply = parseInt(form.supplyAmount.replace(/[^0-9]/g, "")) || 0
  const vatRaw = String(form.vatAmount).replace(/[^0-9]/g, "")
  // 과세면 빈칸일 때 자동 10%, 값 있으면 그대로. 면세·영세는 항상 0.
  const vat    = !taxable ? 0 : (vatRaw === "" ? Math.round(supply * 0.1) : parseInt(vatRaw))
  const total  = supply + vat

  const vendorOptions = (form.kind === "issued"
    ? vendors.filter(v => v.gubu === "B")
    : vendors.filter(v => ["A", "E"].includes(v.gubu))
  ).map(v => ({ value: v.name, label: v.name, sub: v.type }))

  /* 계약은 **선택 입력**이다. 청구서는 계약 없이도 성립한다(contract_id 는 nullable).
   *
   * 예전엔 여기에 '공통(원자재)'·'공통(생산소모)'·'공통' 세 개가 붙어 있었다.
   * 계약을 안 고르면 안 될 것 같아 만든 임시방편이었는데, 실제로는 **저장될 때 통째로 버려졌다** —
   * handleSave 가 `contracts.find(name)` 으로만 id 를 찾으므로 '공통…'은 contract_id=null 이 되고
   * 이름을 남길 자리도 없다(거래 폼과 달리 청구서엔 doc_no 보존 경로가 없다).
   * 고른 사람은 분류한 줄 알지만 아무 데도 안 남는다 → 빈칸과 결과가 같으면서 거짓말만 한다. 뺀다. */
  const contractOptions = contracts.map(c => ({
    value: c.name, label: c.name, sub: `${c.vendor_name || ''} · ${c.status || ''}`,
  }))

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
      tax_type: form.taxType || "과세",
      issued_at: editInvoice ? editInvoice.issuedAt : localDate(),
      due_at: form.dueAt || null,
      status: editInvoice ? editInvoice.status : (form.kind === "issued" ? "입금 예정" : "지급 예정"),
      account_id: form.accountId || null, memo: form.memo || "",
      _docs: docs,   // 저장 후 청구서에 연결할 첨부(부모 handleSave가 처리)
    })
    onClose()
  }

  return (
    <Drawer open={open} onClose={onClose}>
        <DrawerHead
          title={editInvoice ? "청구서 수정" : (form.kind === "issued" ? "청구서 발행" : "청구서 등록 (수취)")}
          sub={editInvoice ? "청구서 내용을 수정합니다" : (form.kind === "issued" ? "발주처에 청구서를 발행합니다" : "협력사로부터 받은 청구서를 등록합니다")}
          onClose={onClose}/>
        <div className="drawer-body col gap-form">
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
            <label className="label">계약 <span className="text-muted2">(선택)</span></label>
            {/* '직접 입력'도 뺐다 — 목록에 없는 이름을 타이핑하면 저장 때 버려져(위 주석)
                입력한 사람만 연결됐다고 믿게 된다. 계약은 계약 화면에서 먼저 만든다. */}
            <Combobox
              value={form.contract}
              onChange={v => f("contract", v)}
              options={contractOptions}
              placeholder={contractOptions.length ? "해당 계약이 있으면 선택하세요" : "등록된 계약이 없어요"}/>
            <div className="text-sm text-muted2" style={{ marginTop: 4 }}>
              계약 없이 발행·수취하는 청구서는 비워두세요.
            </div>
          </div>
          <div>
            <label className="label">과세유형</label>
            <div className="row gap-6" style={{ flexWrap: "wrap" }}>
              {["과세", "면세", "영세"].map(t => (
                <button key={t} type="button" className={`chip ${form.taxType === t ? "active" : ""}`} onClick={() => f("taxType", t)}>{t}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">공급가액</label>
            <MoneyInput value={form.supplyAmount} onChange={raw => f("supplyAmount", raw)}/>
          </div>
          <div className="row gap-12">
            <div style={{ flex: 1 }}>
              <label className="label">부가세</label>
              <MoneyInput placeholder={taxable ? "자동 계산" : "면세·영세 (0)"} value={taxable ? form.vatAmount : "0"}
                onChange={raw => f("vatAmount", raw)} disabled={!taxable}/>
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
            <FileAttach
              docs={docs}
              onAdd={(d) => setDocs(prev => [...prev, d])}
              onRemove={(d) => setDocs(prev => prev.filter(x => x !== d))}
              label="세금계산서·납품확인서 등 첨부"/>
          </div>
        </div>
        <DrawerFooter onCancel={onClose} onSave={handleSave} saveLabel={editInvoice ? "저장" : "등록"}/>
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
const InvoiceTable = ({ rows, onSelect, remainLabel = "잔여" }) => (
  <div className="card" style={{ overflow: "hidden" }}>
    <DataTable
      rows={rows}
      onRowClick={onSelect}
      empty="해당 청구서가 없습니다"
      columns={[
        { key: 'invoiceNo', header: '청구번호', sortable: true, render: inv => <span className="text-sm text-muted num">{inv.invoiceNo}</span> },
        { key: 'vendor', header: '거래처', sortable: true, render: inv => <span className="fw-700">{inv.vendor}</span> },
        { key: 'contract', header: '계약', render: inv => <span className="text-sm text-muted">{inv.contract || "—"}</span> },
        { key: 'totalAmount', header: '청구금액', align: 'right', sortable: true, render: inv => <span className="num-cell">{fmtNum(inv.totalAmount)}</span> },
        { key: 'remainAmount', header: remainLabel, align: 'right', sortable: true, render: inv => (
          inv.remainAmount > 0
            ? <span style={{ color: "var(--warn-ink)", fontWeight: 700 }}>{fmtNum(inv.remainAmount)}</span>
            : <span className="text-muted">—</span>
        ) },
        { key: 'dueAt', header: '기한', sortable: true, render: inv => (
          /* D-day 뱃지는 **아직 받을(낼) 돈이 남았을 때만** 붙인다.
             예전엔 기한만 보고 붙여서, 이미 다 받은 '입금 완료' 청구서에도 '+3일 초과'가
             빨갛게 떴다 — 처리할 게 남은 것처럼 보여 다시 들여다보게 만든다. */
          <><span className="text-sm">{inv.dueAt}</span>
            {inv.dueAt && inv.remainAmount > 0 &&
              <span className={`badge ${ddayTone(inv.dueAt)}`} style={{ marginLeft: 6, fontSize: 10 }}>{dday(inv.dueAt)}</span>}</>
        ) },
        { key: 'status', header: '상태', render: inv => <StatusBadge status={effStatus(inv)}/> },
        // 아직 안 받은/안 낸 청구서는 목록에서 바로 처리 버튼. 누르면 상세의 매칭 탭이 열린다.
        { key: 'action', header: '', align: 'right', render: inv => (
          inv.remainAmount > 0 && (
            <button className="btn primary sm" onClick={(e) => { e.stopPropagation(); onSelect(inv); }}>
              {inv.kind === "issued" ? "입금 처리" : "지급 처리"}
            </button>
          )
        ) },
      ]}
    />
  </div>
)

// ── 발행 예정(대기) 청구 일정 테이블 ─────────────────────────────
// 계약에 깔아둔 청구/지급 일정 → 아직 청구서가 안 만들어진 건. 매출은 '발행', 매입은 '등록' 관점.
const PendingScheduleTable = ({ rows, onIssue, onPaid, isIssued = true }) => (
  <div className="card" style={{ overflow: "hidden" }}>
    <DataTable
      rows={rows}
      rowKey={p => p.recurring_id ? `r-${p.recurring_id}-${p.due_date}` : `m-${p.milestone_id}`}
      empty={isIssued
        ? "발행 예정인 청구 일정이 없어요. 계약 상세의 '청구 일정'에서 청구할 금액·시점을 등록하세요."
        : "예정된 지급 일정이 없어요. 발주 계약 상세의 '청구 일정'에서 지급할 금액·시점을 등록하세요."}
      columns={[
        { key: 'due_date', header: '예정일', sortable: true, render: p => (
          <span className="num text-sm">{p.due_date || "—"}
            {p.due_date && <span className={`badge ${ddayTone(p.due_date)}`} style={{ marginLeft: 6, fontSize: 10 }}>{dday(p.due_date)}</span>}</span>
        ) },
        { key: 'vendor_name', header: '거래처', sortable: true, render: p => <span className="fw-700">{p.vendor_name || "—"}</span> },
        { key: 'contract_name', header: '계약', render: p => <span className="text-sm text-muted">{p.contract_name}{p.contract_no ? ` · ${p.contract_no}` : ""}</span> },
        { key: 'type', header: '유형', render: p => <span className="badge outline">{p.type}</span> },
        { key: 'total', header: `${isIssued ? "청구금액" : "지급금액"}(VAT 포함)`, align: 'right', sortable: true,
          sortValue: p => p.amount + (p.vat != null ? p.vat : Math.round(p.amount * 0.1)),
          render: p => <span className="num-cell fw-700">{fmtNum(p.amount + (p.vat != null ? p.vat : Math.round(p.amount * 0.1)))}</span> },
        { key: 'action', header: '', width: 210, render: p => (
          <div className="row gap-6">
            <button className="btn primary sm" onClick={() => onIssue(p)}>
              <Icon.Receipt size={12}/> {isIssued ? "발행 처리" : "청구서 등록"}
            </button>
            <button className="btn sm" onClick={() => onPaid(p)}>{isIssued ? "기입금 처리" : "기지급 처리"}</button>
          </div>
        ) },
      ]}
    />
  </div>
)

// ── 메인 BillingScreen ───────────────────────────────────────────
// role='issue'(발행 청구서: 발행 중심) | 'collect'(입금·환불/지급·환입: 청구서 기준 회수 중심)
export const BillingScreen = ({ initialTab = "issued", role = "issue", openRefund, openReturn, focusInvoiceId }) => {
  const toast = useToast()
  const { confirm } = useConfirm()
  const kind = initialTab              // 'issued'(대금청구) | 'received'(수취)
  const isIssued = kind === "issued"
  const collect = role === "collect"   // 회수 모드: 미정산 청구서 + 입금/지급 처리 + 환불/환입
  const [view, setView] = useState(collect ? "list" : "pending")   // issued: pending|list
  const [invoices, setInvoices] = useState([])
  const [pending, setPending]   = useState([])
  const [recSummary, setRecSummary] = useState(null)
  const [paySum, setPaySum]     = useState(null)
  const [selected, setSelected] = useState(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editInvoice, setEditInvoice] = useState(null)
  const [statusFilter, setStatusFilter] = useState(collect ? "미정산" : "전체")
  const [paidTarget, setPaidTarget] = useState(null)   // 기입금/기지급 처리 대상(계좌·날짜 드로어)
  const [importing, setImporting] = useState(false)    // 홈택스 세금계산서 엑셀 업로드 화면
  const [ourBizNo, setOurBizNo] = useState('')         // 우리 회사 사업자번호 — 매출/매입 자동 판정용

  // 청구할 것은 두 갈래로 생긴다: 계약의 청구 일정(마일스톤)과 정기청구 회차(유지보수 등).
  // 경리가 청구서 메뉴 한 곳만 열면 이번 달 청구할 게 다 보이도록 '발행 예정'에서 합친다.
  // (정기청구는 매출 전용 — 매입의 정기지출은 별도 흐름)
  const load = async () => {
    // 정기 반복은 성격에 맞는 쪽에만 뜬다: 매출=정기청구 / 매입=정기지출 (완전 대칭)
    const [rows, rec, pay, sched, recurring] = await Promise.all([
      api.getInvoices(),
      api.getReceivablesSummary(),
      api.getPayablesSummary(),
      api.getPendingSchedules(isIssued ? "sales" : "purchase"),
      isIssued ? api.getPendingRecurring() : api.getPendingRecurringExpenses(),
    ])
    const merged = [
      ...sched.map(s => ({ ...s, source: 'milestone' })),
      ...recurring,
    ].sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')))
    setInvoices(rows); setRecSummary(rec); setPaySum(pay); setPending(merged)
    /* 상세를 열어둔 채 정산·취소를 하면 목록만 새로고침되고 열린 상세는 옛 값 그대로였다
       — 입금을 등록해도 이력·미수금이 그대로라 한 번 더 넣게 된다. 같은 건을 다시 물려준다.
       사라진 청구서(삭제)면 닫는다. */
    setSelected(prev => prev ? (rows.find(r => r.id === prev.id) || null) : prev)
  }
  useEffect(() => { load() }, [])
  // 세금계산서 업로드의 매출/매입 판정 기준. 환경설정 › 회사 정보에 사업자번호가 있어야 자동으로 갈린다.
  useEffect(() => { api.getCompany().then(c => setOurBizNo(c?.biz_no || '')) }, [])
  // 어댑터는 옵션이 바뀔 때만 새로 만든다 — 매 렌더 새 객체면 마법사가 중복 판정을 통째로 다시 계산한다.
  const importAdapter = useMemo(
    () => taxInvoiceImportAdapter({ ourBizNo, defaultKind: kind }), [ourBizNo, kind])

  // 홈 '할 일'에서 특정 청구서를 지목해 들어오면 그 상세를 바로 연다.
  useEffect(() => {
    if (!focusInvoiceId || !invoices.length) return
    const hit = invoices.find(inv => inv.id === focusInvoiceId)
    if (hit) setSelected(hit)
  }, [focusInvoiceId, invoices])

  const kindRows = invoices.filter(inv => inv.kind === kind)
  // 미정산(아직 안 받은/안 낸) 청구서 상태 그룹 — 미수금/미지급금의 정의
  const PENDING_STATUS = isIssued
    ? ["입금 예정", "일부 입금", "기한 지남", "장기 미수"]
    : ["지급 대기", "지급 예정", "일부 지급", "기한 지남"]
  /* '미정산'은 **항상** 첫 칩이다.
   * 예전엔 회수 모드(role='collect', 미수금·미지급금 메뉴)에서만 나왔다. 그런데 그 메뉴는
   * 이 화면과 같은 화면이라 사이드바에서 합쳤고(nav.js), 칩이 회수 모드에만 있으면
   * "못 받은 것만 보기"가 통째로 사라진다. 미수금·미지급금은 경리가 매일 보는 축이다. */
  const STATUS_OPTIONS = isIssued
    ? ["미정산", "전체", "입금 예정", "일부 입금", "기한 지남", "장기 미수", "입금 완료"]
    : ["미정산", "전체", "지급 대기", "지급 예정", "일부 지급", "기한 지남", "지급 완료"]
  // 필터도 표시 상태(effStatus) 기준 — 뱃지에 '기한 지남'으로 뜨는 건이 '기한 지남' 필터에도 잡히게.
  const filtered = statusFilter === "미정산"
    ? kindRows.filter(inv => PENDING_STATUS.includes(effStatus(inv)))
    : kindRows.filter(inv => statusFilter === "전체" || effStatus(inv) === statusFilter)
  const pendingTotal = pending.reduce((s, p) => s + p.amount + (p.vat != null ? p.vat : Math.round(p.amount * 0.1)), 0)

  // 예정 회차 1건을 청구서로 발행/등록. 출처(마일스톤/정기청구/정기지출)마다 API가 다르다.
  const issuePending = (p, paid) => {
    const opts = { paid, account_id: paid ? (p._accountId || null) : undefined }
    if (p.source === 'recurring')          return api.issueRecurring(p.recurring_id, { due: p.due_date, ...opts })
    if (p.source === 'recurring-expense')  return api.issueRecurringExpense(p.recurring_id, { due: p.due_date, ...opts })
    // 마일스톤은 기지급 시 사용자가 고른 날짜(_date)를 쓴다(정기 회차는 회차일 고정)
    return api.issueSchedule(p.milestone_id, { date: p._date || p.due_date, ...opts })
  }

  const issueSchedule = async (p, paid) => {
    // 기입금/기지급은 "돈이 어느 계좌로 오갔나"가 핵심이라, 계좌·날짜를 받는 드로어로 넘긴다.
    if (paid) { setPaidTarget(p); return }
    const supply = p.amount || 0
    const vat = p.vat != null ? p.vat : Math.round(supply * 0.1)
    const isRecurring = p.source === 'recurring'
    const ok = await confirm({
      tone: "brand", icon: <Icon.Receipt size={22}/>,
      title: isIssued ? "청구서 발행" : "매입 청구서 등록",
      body: isIssued
        ? `${p.vendor_name} · ${p.type}${isRecurring ? ` (${p.due_date} 회차)` : ''} ${fmtNum(supply + vat)}원(VAT 포함) 청구서를 발행해요. 미수금으로 등록됩니다.`
        : `${p.vendor_name} · ${p.type} ${fmtNum(supply + vat)}원(VAT 포함) 매입 청구서를 등록해요. 미지급금으로 잡힙니다.`,
      confirmLabel: isIssued ? "청구서 발행" : "청구서 등록",
    })
    if (!ok) return
    const res = await issuePending(p, false)
    if (!res.ok) { toast.push(res.error || "처리에 실패했어요", { tone: 'warn' }); return }
    toast.push(isIssued ? "청구서를 발행했어요" : "매입 청구서를 등록했어요")
    load()
  }

  const handleMatch = async (invoiceId, amount, date, txnId, extra) => {
    const r = await api.matchInvoice(invoiceId, { txnId: txnId || null, amount, date, ...extra })
    // 결과를 보지 않고 성공 문구를 띄우면, 계좌 누락 같은 400을 사용자가 모른 채 넘어간다
    toast.push(r.ok ? "매칭 처리가 완료됐어요" : (r.error || "매칭 처리에 실패했어요"), r.ok ? undefined : { tone: "warn" })
    load()
  }

  const handleSave = async (data) => {
    const { _docs, ...payload } = data
    let invoiceId = payload.id
    if (payload.id) {
      const res = await api.updateInvoice(payload.id, payload)
      // 서버 메시지를 버리면 "마감된 달" · "이미 정산된 금액보다 적게 바꿀 수 없다" 같은
      // 거절 이유가 사라져, 사용자는 그냥 고장난 것으로 받아들인다
      if (!res.ok) { toast.push(res.error || "청구서 수정에 실패했어요", { tone: "warn" }); return }
      toast.push("청구서가 수정됐어요")
    } else {
      const res = await api.addInvoice(payload)
      if (!res.ok) { toast.push(res.error || "청구서 등록에 실패했어요", { tone: 'warn' }); return }
      invoiceId = res.id
      toast.push("청구서가 등록됐어요")
    }
    // 폼에서 올린 첨부를 청구서에 연결 (실패 건수는 안내)
    if (invoiceId && Array.isArray(_docs) && _docs.length) {
      let failed = 0
      for (const d of _docs) {
        const r = await api.addInvoiceDoc(invoiceId, { url: d.url, name: d.name, doc_type: '기타', size: d.size || 0 })
        if (!r.ok) failed++
      }
      if (failed) toast.push(`첨부 ${failed}건 연결 실패`, { tone: "warn" })
    }
    load()
  }

  // 세금계산서 업로드는 목록을 통째로 바꾸므로 화면을 넘겨받는다(기준정보 엑셀 업로드와 같은 방식).
  if (importing) return (
    <ImportWizard
      adapter={importAdapter}
      existing={invoices}
      onCancel={() => setImporting(false)}
      onDone={() => { setImporting(false); load() }}/>
  )

  return (
    <div className="fade-up">
      <PageHeader
        title={collect ? (isIssued ? "미수금" : "미지급금") : "대금 청구서"}
        actions={collect
          ? <button className="btn" onClick={isIssued ? openRefund : openReturn}>
              <Icon.Plus size={14}/> {isIssued ? "환불 등록" : "환입 등록"}
            </button>
          : <>
              <button className="btn" onClick={() => setImporting(true)}>
                <Icon.Excel size={14}/> 홈택스 업로드
              </button>
              <button className="btn primary" onClick={() => { setEditInvoice(null); setFormOpen(true) }}>
                <Icon.Plus size={14}/> 청구서 {isIssued ? "발행" : "등록"}
              </button>
            </>}
      />

      {/* 요약 카드 — 회수 모드는 미수/미지급 2칸(발행 예정 없음), 발행 모드는 3칸 */}
      <div className="grid" style={{ gridTemplateColumns: `repeat(${collect ? 2 : 3}, 1fr)`, gap: 16, marginBottom: 24 }}>
        {isIssued ? (
          <>
            {!collect && <SummaryCard label="발행 예정(대기)" amount={pendingTotal} count={pending.length} accent="brand"/>}
            <SummaryCard label={collect ? "받을 미수금" : "미수금 합계"} amount={recSummary?.total ?? 0} count={recSummary?.count ?? 0} accent="blue"/>
            <SummaryCard label="연체 미수금" amount={recSummary?.overdueAmount ?? 0} count={recSummary?.overdueCount ?? 0} accent="neg" warn/>
          </>
        ) : (
          <>
            {/* pending 은 '아직 청구서가 안 만들어진 회차'다(정기지출·계약 지급일정).
                '지급 예정(대기)'라고 부르니 옆의 '미지급금 합계'와 구분이 안 됐다 —
                둘 다 "3건"으로 떠서 같은 3건처럼 보인다. 실제로는 겹치지 않는 별개다.
                매출 쪽 '발행 예정'과 대칭이 되게 '등록 예정'으로 부른다. */}
            {!collect && <SummaryCard label="등록 예정(청구서 전)" amount={pendingTotal} count={pending.length} accent="brand"/>}
            <SummaryCard label={collect ? "줄 미지급금" : "미지급금 합계"} amount={paySum?.total ?? 0} count={paySum?.count ?? 0} accent="warn"/>
            <SummaryCard label="연체 미지급금" amount={paySum?.overdueAmount ?? 0} count={paySum?.overdueCount ?? 0} accent="neg" warn/>
          </>
        )}
      </div>

      {/* 탭: 발행 모드는 발행 예정|발행됨. 회수 모드는 상태 필터만(발행 예정 없음). */}
      <div className="row gap-8" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        {!collect && (
          <>
            <button className={`chip ${view === "pending" ? "active" : ""}`} onClick={() => setView("pending")}>
              {isIssued ? "발행 예정" : "지급 예정"}{pending.length > 0 && <span style={{ marginLeft: 6, opacity: 0.7, fontWeight: 700 }}>{pending.length}</span>}
            </button>
            <button className={`chip ${view === "list" ? "active" : ""}`} onClick={() => setView("list")}>
              {isIssued ? "발행됨" : "등록됨"}<span style={{ marginLeft: 6, opacity: 0.7, fontWeight: 700 }}>{kindRows.length}</span>
            </button>
          </>
        )}
        {(collect || view === "list") && (
          <div className={`row gap-6 ${collect ? "" : "ml-auto"}`} style={{ flexWrap: "wrap" }}>
            {STATUS_OPTIONS.map(s => (
              <button key={s} className={`chip ${statusFilter === s ? "active" : ""}`} onClick={() => setStatusFilter(s)} style={{ fontSize: 12 }}>{s}</button>
            ))}
          </div>
        )}
      </div>

      {!collect && view === "pending"
        ? <PendingScheduleTable rows={pending} isIssued={isIssued}
            onIssue={(p) => issueSchedule(p, false)} onPaid={(p) => issueSchedule(p, true)}/>
        : <InvoiceTable rows={filtered} onSelect={setSelected} remainLabel={isIssued ? "미수금" : "미지급금"}/>}

      <InvoiceDetailDrawer
        invoice={selected}
        onClose={() => setSelected(null)}
        onMatch={handleMatch}
        onDelete={async (id) => { const r = await api.deleteInvoice(id); toast.push(r.ok ? "청구서가 삭제됐어요" : (r.error || "삭제에 실패했어요")); load() }}
        onEdit={(inv) => { setEditInvoice(inv); setSelected(null); setFormOpen(true) }}
        onChanged={load}
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

      <PaidIssueDrawer target={paidTarget} isIssued={isIssued}
        onIssuePaid={(p) => issuePending(p, true)}
        onClose={() => setPaidTarget(null)}
        onDone={() => { setPaidTarget(null); load() }}/>
    </div>
  )
}

// 기입금/기지급 처리 드로어는 lib/components/PaidIssueDrawer.jsx 공용
// (대금청구서·정기청구·정기지출이 같은 드로어를 쓴다).
