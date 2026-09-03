import { useState, useEffect } from 'react'
import { Icon, fmtNum, Loading, localToday, Combobox } from '../lib/ui'
import { api } from '../lib/api'

/**
 * 고객사 양식 보고서 다섯 — 월 매출내역 / 연 매출액 / 월 매입내역 / 거래처 거래내역 / 매출장.
 *
 * 종이의 칸 배치를 그대로 옮긴 것들이라, 다른 보고서와 달리 **정렬·필터를 붙이지 않는다.**
 * 결재를 받아 넘기는 문서는 어제 뽑은 것과 오늘 뽑은 것의 줄 순서가 같아야 한다.
 *
 * 집계는 전부 서버 lib/salesForms.js 에 있다 — 화면에서 다시 더하지 않는다
 * (같은 표가 두 가지 답을 갖지 않게).
 *
 * ⚠ 이 화면들은 보고서 화면(Docs.jsx ReportsScreen) 안에 그려지고, 그 바깥이
 *   `.report-print` 를 이미 달고 있다 — 여기서 인쇄용 클래스를 또 붙이지 않는다.
 */

const TOTAL = { borderTop: '2px solid var(--ink)', background: 'var(--surface-2)' }

/** 결재란 — 실물에 있다. 인쇄해서 결재받는 서류다. */
const ApprovalBox = ({ cols = ['담 당', '검 토', '승 인'] }) => (
  <table className="res-approve" style={{ width: 74 * cols.length, marginLeft: 'auto' }}>
    <tbody>
      <tr>{cols.map(c => <th key={c}>{c}</th>)}</tr>
      <tr>{cols.map(c => <td key={c}/>)}</tr>
    </tbody>
  </table>
)

/** 제목 줄 — 양식마다 같은 자리에 선다. */
const FormHead = ({ title, sub, right }) => (
  <div className="row" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
    <div className="fw-700" style={{ fontSize: 16 }}>
      {title}
      {sub && <div className="text-xs text-muted" style={{ marginTop: 3, fontWeight: 400 }}>{sub}</div>}
    </div>
    <div style={{ marginLeft: 'auto' }}>{right}</div>
  </div>
)

/** 조작 줄 — 다섯 양식이 같은 줄을 쓴다. 상자를 여럿으로 쪼개지 않는다(듬성해 보인다).
    second: 아래에 한 줄 더 붙일 때(매출장의 마감일자·담당자). */
const MonthBar = ({ month, setMonth, children, note, second }) => (
  <div className="card card-pad no-print" style={{ marginBottom: 16 }}>
    <div className="row gap-12" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
      <span className="text-sm fw-600">기준월</span>
      <input className="input" type="month" style={{ width: 150 }}
        value={month} onChange={e => e.target.value && setMonth(e.target.value)}/>
      {children}
      {note && <span className="text-xs text-muted2 ml-auto">{note}</span>}
    </div>
    {second && (
      <>
        <div style={{ height: 1, background: 'var(--line)', margin: '14px 0' }}/>
        {second}
      </>
    )}
  </div>
)

/* 빈 상태·오류.
 *
 * ⚠ 흰 상자에 회색 한 줄만 두지 않는다 — "대충 만들다 만 화면"으로 읽힌다(실사용 지적).
 *   무엇이 없는지(제목)와 어떻게 하면 되는지(한 줄)를 같이 준다. 아이콘은 눈이 멈출 자리다.
 * 살 수 없는 양식(403)도 여기로 온다 — 빈 표로 보여주면 "자료가 없다"로 읽혀,
 * 고객이 없는 자료를 찾아 헤맨다. */
const FormEmpty = ({ title, hint, tone = 'muted' }) => (
  <div className="card card-pad" style={{ textAlign: 'center', padding: '56px 24px' }}>
    <div style={{
      width: 44, height: 44, borderRadius: 12, margin: '0 auto 14px',
      display: 'grid', placeItems: 'center',
      background: tone === 'warn' ? 'var(--warn-soft, var(--surface-2))' : 'var(--surface-2)',
      color: tone === 'warn' ? 'var(--warn-ink)' : 'var(--muted-2)',
    }}>
      {tone === 'warn' ? <Icon.Warn size={20}/> : <Icon.Doc size={20}/>}
    </div>
    <div className="fw-700" style={{ fontSize: 15, marginBottom: 6 }}>{title}</div>
    {hint && <div className="text-sm text-muted" style={{ lineHeight: 1.7, maxWidth: 460, margin: '0 auto' }}>{hint}</div>}
  </div>
)

const FormError = ({ error }) => <FormEmpty title="이 보고서를 열 수 없어요" hint={error} tone="warn"/>

const useForm = (load, deps) => {
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    setD(null); setErr('')
    load().then(x => { if (alive) setD(x) })
      .catch(e => { if (alive) setErr(e?.message || '불러오지 못했어요') })
    return () => { alive = false }
  }, deps)   // eslint-disable-line react-hooks/exhaustive-deps
  return [d, err]
}

const ym = (m) => `${m.slice(0, 4)}년 ${Number(m.slice(5, 7))}월`

/* ── 7-1. YYYY년 N월분 매출내역 ───────────────────────────────────────────── */
export const ReportSalesMonth = () => {
  const [month, setMonth] = useState(() => localToday().slice(0, 7))
  const [d, err] = useForm(() => api.getSalesMonthForm(month), [month])

  return (
    <div>
      <MonthBar month={month} setMonth={setMonth}
        note={d ? `${d.from} ~ ${d.to}${d.closingDay > 0 ? ` · 매월 ${d.closingDay}일 마감` : ''}` : ''}/>
      {err ? <FormError error={err}/> : !d ? <Loading label="매출을 모으는 중…"/> : (
        <>
          <div className="card" style={{ padding: 24, marginBottom: 20 }}>
            <FormHead title={`${ym(month)}분 매출내역`}
              sub={`${d.from} ~ ${d.to}`} right={<ApprovalBox/>}/>
            <div className="table-scroll">
              <table className="table" style={{ minWidth: 880 }}>
                <thead>
                  <tr>
                    <th style={{ width: 48 }}>NO</th>
                    <th style={{ width: 100 }}>일자</th>
                    <th style={{ width: 160 }}>업체명</th>
                    <th>품목</th>
                    <th className="num-right" style={{ width: 110 }}>공급가액</th>
                    <th className="num-right" style={{ width: 100 }}>부가세</th>
                    {/* '월계' — 그 줄까지의 이 달 누계다(맨 아래 합계와 마지막 줄이 같다) */}
                    <th className="num-right" style={{ width: 120 }} title="그 줄까지의 이 달 누계">월계</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.length === 0 && (
                    <tr><td colSpan={7} className="dt-empty">
                      이 달에 품목이 적힌 매출 청구서가 없어요.
                      {d.headless.count > 0 && <><br/>총액만 끊은 청구서 {d.headless.count}건은 아래 연 누계에 있어요.</>}
                    </td></tr>
                  )}
                  {d.rows.map(r => (
                    <tr key={r.no}>
                      <td className="num text-center">{r.no}</td>
                      <td className="num text-sm" style={{ whiteSpace: 'nowrap' }}>{r.date}</td>
                      <td className="text-sm">{r.vendor}</td>
                      <td className="fw-600">{r.name}{r.spec && <span className="text-muted text-sm"> {r.spec}</span>}</td>
                      <td className="num num-right">{fmtNum(r.amount)}</td>
                      {/* 면세 줄은 0 이 아니라 빈 칸 — 실물이 그렇게 비워둔다 */}
                      <td className="num num-right">{r.vat ? fmtNum(r.vat) : ''}</td>
                      <td className="num num-right text-muted">{fmtNum(r.running)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={4} style={{ ...TOTAL, textAlign: 'center' }}>합계</th>
                    <td className="num num-right fw-700" style={TOTAL}>{fmtNum(d.totals.supply)}</td>
                    <td className="num num-right fw-700" style={TOTAL}>{fmtNum(d.totals.vat)}</td>
                    <td className="num num-right fw-700" style={{ ...TOTAL, fontSize: 15 }}>{fmtNum(d.totals.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {/* 품목 없이 총액만 끊은 청구서 — 위 표에 줄이 없다. 아래 누계와 왜 다른지 밝힌다 */}
            {d.headless.count > 0 && (
              <div className="text-xs text-muted2" style={{ marginTop: 10, lineHeight: 1.7 }}>
                품목 내역이 없는 청구서 {d.headless.count}건({fmtNum(d.headless.total)}원)은 위 표에 줄이 없어요 —
                아래 <b>연 누계</b>에는 들어갑니다.
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 24 }}>
            <FormHead title={`${month.slice(0, 4)}년 현재 매출액 합계`}
              sub={`${d.yearFrom} ~ ${d.to} · 청구서 기준`}/>
            <div className="table-scroll">
              <table className="table" style={{ minWidth: 720 }}>
                <thead>
                  <tr>
                    <th style={{ width: 48 }}>NO</th>
                    <th>업체명</th>
                    <th style={{ width: 200 }}>내역</th>
                    <th className="num-right" style={{ width: 120 }}>공급가액</th>
                    <th className="num-right" style={{ width: 110 }}>부가세</th>
                    <th className="num-right" style={{ width: 130 }}>합계</th>
                  </tr>
                </thead>
                <tbody>
                  {d.vendors.length === 0 && (
                    <tr><td colSpan={6} className="dt-empty">올해 매출 청구서가 없어요.</td></tr>
                  )}
                  {d.vendors.map(v => (
                    <tr key={v.no}>
                      <td className="num text-center">{v.no}</td>
                      <td className="fw-600">{v.vendor}</td>
                      <td className="text-sm text-muted">{month.slice(0, 4)}년 매출액 누계 ({v.count}건)</td>
                      <td className="num num-right">{fmtNum(v.supply)}</td>
                      <td className="num num-right">{fmtNum(v.vat)}</td>
                      <td className="num num-right fw-600">{fmtNum(v.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={3} style={{ ...TOTAL, textAlign: 'center' }}>합계</th>
                    <td className="num num-right fw-700" style={TOTAL}>{fmtNum(d.vendorTotals.supply)}</td>
                    <td className="num num-right fw-700" style={TOTAL}>{fmtNum(d.vendorTotals.vat)}</td>
                    <td className="num num-right fw-700" style={{ ...TOTAL, fontSize: 15 }}>{fmtNum(d.vendorTotals.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ── 7-2. 특정 년도 매출액 (업체 × 12개월) ───────────────────────────────── */
export const ReportSalesYear = () => {
  const [year, setYear] = useState(() => Number(localToday().slice(0, 4)))
  /* 매출액을 공급가액으로 볼지 부가세까지 넣을지 — 회사마다 다르다. 고르게 두고
     고른 것을 표에 적는다(안 적으면 숫자만 보고는 어느 쪽인지 알 수 없다). */
  const [basis, setBasis] = useState('supply')
  const [d, err] = useForm(() => api.getSalesYearForm(year, basis), [year, basis])

  return (
    <div>
      <div className="card card-pad no-print" style={{ marginBottom: 16 }}>
        <div className="row gap-12" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="text-sm fw-600">연도</span>
          <button className="icon-btn" title="이전 해" onClick={() => setYear(y => y - 1)}><Icon.Left size={14}/></button>
          <span className="num fw-700" style={{ minWidth: 64, textAlign: 'center' }}>{year}년</span>
          <button className="icon-btn" title="다음 해" onClick={() => setYear(y => y + 1)}><Icon.Right size={14}/></button>
          <span className="chip-div"/>
          <span className="text-sm text-muted fw-600">기준</span>
          {[['supply', '공급가액'], ['total', 'VAT 포함']].map(([v, l]) => (
            <button key={v} className={`chip ${basis === v ? 'active' : ''}`} onClick={() => setBasis(v)}>{l}</button>
          ))}
        </div>
      </div>
      {err ? <FormError error={err}/> : !d ? <Loading label="한 해 매출을 모으는 중…"/> : (
        <div className="card" style={{ padding: 24 }}>
          <FormHead title={`${year}년 매출액`}
            sub={`업체별 월 매출 · ${basis === 'total' ? '부가세 포함' : '공급가액'} 기준 · ${d.from} ~ ${d.to}`}
            right={<ApprovalBox/>}/>
          <div className="table-scroll">
            {/* 열이 열넷이라 좁은 화면에서는 접힌다 — 접느니 가로로 밀어 보게 한다 */}
            <table className="table" style={{ minWidth: 1180 }}>
              <thead>
                <tr>
                  <th style={{ width: 44 }}>NO</th>
                  <th style={{ width: 150 }}>업체명</th>
                  {d.monthLabels.map(m => <th key={m} className="num-right" style={{ width: 78 }}>{m}</th>)}
                  <th className="num-right" style={{ width: 120 }}>합계</th>
                </tr>
              </thead>
              <tbody>
                {d.vendors.length === 0 && (
                  <tr><td colSpan={15} className="dt-empty">{year}년 매출 청구서가 없어요.</td></tr>
                )}
                {d.vendors.map(v => (
                  <tr key={v.no}>
                    <td className="num text-center">{v.no}</td>
                    <td className="fw-600">{v.vendor}</td>
                    {/* 0 인 달은 빈 칸 — 열두 칸에 0 이 늘어서면 정작 값이 안 보인다 */}
                    {v.months.map((n, i) => (
                      <td key={i} className="num num-right text-sm">{n ? fmtNum(n) : ''}</td>
                    ))}
                    <td className="num num-right fw-600">{fmtNum(v.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={2} style={{ ...TOTAL, textAlign: 'center' }}>합계</th>
                  {d.monthTotals.map((n, i) => (
                    <td key={i} className="num num-right fw-700" style={TOTAL}>{n ? fmtNum(n) : ''}</td>
                  ))}
                  <td className="num num-right fw-700" style={{ ...TOTAL, fontSize: 15 }}>{fmtNum(d.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── 7-3. YYYY년 N월분 매입내역 ──────────────────────────────────────────── */
export const ReportPurchaseMonth = () => {
  const [month, setMonth] = useState(() => localToday().slice(0, 7))
  const [d, err] = useForm(() => api.getPurchaseMonthForm(month), [month])

  return (
    <div>
      <MonthBar month={month} setMonth={setMonth}
        note={d ? `${d.from} ~ ${d.to}${d.closingDay > 0 ? ` · 매월 ${d.closingDay}일 마감` : ''}` : ''}/>
      {err ? <FormError error={err}/> : !d ? <Loading label="매입을 모으는 중…"/> : (
        <div className="card" style={{ padding: 24 }}>
          <FormHead title={`${ym(month)}분 매입내역`} sub={`${d.from} ~ ${d.to}`} right={<ApprovalBox/>}/>
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 1080 }}>
              <thead>
                <tr>
                  <th style={{ width: 44 }}>순번</th>
                  <th style={{ width: 150 }}>업체명</th>
                  <th className="num-right" style={{ width: 110 }} title="지난 청구서 중 아직 안 낸 금액">전월 이월</th>
                  <th className="num-right" style={{ width: 110 }}>공급가</th>
                  <th className="num-right" style={{ width: 100 }}>부가세</th>
                  <th className="num-right" style={{ width: 110 }}>합계</th>
                  <th style={{ width: 100 }}>결제일</th>
                  <th className="num-right" style={{ width: 110 }}>결제금액</th>
                  <th className="num-right" style={{ width: 110 }}>잔액</th>
                  <th style={{ width: 140 }}>비고</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.length === 0 && (
                  <tr><td colSpan={10} className="dt-empty">이 달에 매입 청구서도 결제도 없어요.</td></tr>
                )}
                {d.rows.map(r => (
                  <tr key={r.no}>
                    <td className="num text-center">{r.no}</td>
                    <td className="fw-600">{r.vendor}</td>
                    <td className="num num-right text-muted">{r.carryOver ? fmtNum(r.carryOver) : ''}</td>
                    <td className="num num-right">{r.supply ? fmtNum(r.supply) : ''}</td>
                    <td className="num num-right">{r.vat ? fmtNum(r.vat) : ''}</td>
                    <td className="num num-right fw-600">{r.total ? fmtNum(r.total) : ''}</td>
                    <td className="num text-sm" style={{ whiteSpace: 'nowrap' }}>
                      {r.payDate}
                      {/* 한 달에 여러 번 냈으면 날짜 하나로는 부족하다 — 몇 번인지 적는다 */}
                      {r.payCount > 1 && <span className="text-muted2 text-xs"> 외 {r.payCount - 1}</span>}
                    </td>
                    <td className="num num-right" style={{ color: r.paid ? 'var(--pos-ink)' : undefined }}>
                      {r.paid ? fmtNum(r.paid) : ''}
                    </td>
                    <td className="num num-right fw-700"
                      style={{ color: r.balance > 0 ? 'var(--warn-ink)' : undefined }}>
                      {r.balance ? fmtNum(r.balance) : ''}
                    </td>
                    <td className="text-xs text-muted">{r.note}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={2} style={{ ...TOTAL, textAlign: 'center' }}>합계</th>
                  <td className="num num-right fw-700" style={TOTAL}>{fmtNum(d.totals.carryOver)}</td>
                  <td className="num num-right fw-700" style={TOTAL}>{fmtNum(d.totals.supply)}</td>
                  <td className="num num-right fw-700" style={TOTAL}>{fmtNum(d.totals.vat)}</td>
                  <td className="num num-right fw-700" style={TOTAL}>{fmtNum(d.totals.total)}</td>
                  <td style={TOTAL}/>
                  <td className="num num-right fw-700" style={TOTAL}>{fmtNum(d.totals.paid)}</td>
                  <td className="num num-right fw-700" style={{ ...TOTAL, fontSize: 15 }}>{fmtNum(d.totals.balance)}</td>
                  <td style={TOTAL}/>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="text-xs text-muted2" style={{ marginTop: 10, lineHeight: 1.7 }}>
            잔액 = 전월 이월 + 합계 − 결제금액. 결제는 청구서에 이어 붙인 지급이고, 어음으로 준 것도 셉니다.
            비고는 그 달 청구서에 적은 메모예요 — 자동이체·리스처럼 늘 같은 말은 청구서 메모에 적어두면 여기 그대로 나옵니다.
          </div>
        </div>
      )}
    </div>
  )
}

/** 거래처 고르기 — 7-4·7-5 가 함께 쓴다. 그 달에 거래가 있는 곳만 준다. */
const VendorPick = ({ choices, vendorId, setVendorId }) => (
  <>
    <span className="chip-div"/>
    <span className="text-sm fw-600">거래처</span>
    <div style={{ width: 240 }}>
      <Combobox value={vendorId} onChange={setVendorId} allowAdd={false}
        options={choices.map(c => ({ value: c.id, label: c.name }))}
        placeholder="거래처 선택"/>
    </div>
  </>
)

/* ── 7-4. YYYY년 N월 특정 거래처 거래내역 ───────────────────────────────── */
export const ReportVendorLedger = () => {
  const [month, setMonth] = useState(() => localToday().slice(0, 7))
  const [vendorId, setVendorId] = useState('')
  const [kind, setKind] = useState('issued')
  const [d, err] = useForm(
    () => api.getVendorLinesForm({ month, vendorId, kind, form: 'vendor_ledger' }), [month, vendorId, kind])

  // 고른 거래처가 그 달에 없으면 손에 든 선택을 놓는다(빈 표를 보며 기다리게 두지 않는다)
  useEffect(() => {
    if (vendorId && d?.choices?.length && !d.choices.some(c => c.id === vendorId)) setVendorId('')
  }, [d, vendorId])

  return (
    <div>
      <MonthBar month={month} setMonth={setMonth}
        note={d ? `${d.from} ~ ${d.to}` : ''}>
        <span className="chip-div"/>
        {[['issued', '매출'], ['received', '매입']].map(([k, l]) => (
          <button key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{l}</button>
        ))}
        {d && <VendorPick choices={d.choices} vendorId={vendorId} setVendorId={setVendorId}/>}
      </MonthBar>
      {err ? <FormError error={err}/> : !d ? <Loading label="거래를 모으는 중…"/> : !vendorId ? (
        d.choices.length
          ? <FormEmpty title="거래처를 고르세요"
              hint={`${ym(month)}에 거래가 있는 곳 ${d.choices.length}곳이 위 목록에 있어요. 고르면 그 달 거래내역이 나옵니다.`}/>
          : <FormEmpty title={`${ym(month)}에 품목이 적힌 청구서가 없어요`}
              hint="이 표는 청구서에 적은 품목으로 만듭니다. 기준월을 바꿔 보시거나, 청구서를 등록할 때 품목 내역을 채워주세요."/>
      ) : (
        <div className="card" style={{ padding: 24 }}>
          <FormHead title={`${ym(month)} ${d.vendor} 거래내역`} sub={`${d.from} ~ ${d.to}`} right={<ApprovalBox/>}/>
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 980 }}>
              <thead>
                <tr>
                  <th style={{ width: 100 }}>납품 일자</th>
                  <th style={{ width: 140 }}>결재 No</th>
                  <th style={{ width: 150 }}>공사 번호</th>
                  <th style={{ width: 130 }}>품번</th>
                  <th>W/O</th>
                  <th className="num-right" style={{ width: 90 }}>합격수량</th>
                  <th className="num-right" style={{ width: 100 }}>단가</th>
                  <th className="num-right" style={{ width: 120 }}>합계</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.length === 0 && (
                  <tr><td colSpan={8} className="dt-empty">이 거래처의 이 달 거래가 없어요.</td></tr>
                )}
                {d.rows.map(r => (
                  <tr key={r.no}>
                    {/* 납품일을 안 적은 줄은 발행일로 갈음한다 — 빈 칸이면 종이에서 줄을 못 찾는다 */}
                    <td className="num text-sm" style={{ whiteSpace: 'nowrap' }}>
                      {r.deliveryDate || r.date}
                      {!r.deliveryDate && <span className="text-muted2 text-xs"> (발행일)</span>}
                    </td>
                    <td className="num text-sm text-muted">{r.invoiceNo}</td>
                    <td className="text-sm">{r.contract || '—'}</td>
                    <td className="num text-sm">{r.code || r.spec || '—'}</td>
                    <td className="fw-600">{r.name}{r.note && <span className="text-muted text-sm"> {r.note}</span>}</td>
                    <td className="num num-right">{r.qty ? String(r.qty) : ''}</td>
                    <td className="num num-right">{fmtNum(r.unitPrice)}</td>
                    <td className="num num-right fw-600">{fmtNum(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={5} style={{ ...TOTAL, textAlign: 'center' }}>합계</th>
                  <td className="num num-right fw-700" style={TOTAL}>{d.totals.qty ? String(d.totals.qty) : ''}</td>
                  <td style={TOTAL}/>
                  <td className="num num-right fw-700" style={{ ...TOTAL, fontSize: 15 }}>{fmtNum(d.totals.supply)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {/* 우리 자료의 어느 칸이 어느 칸으로 갔는지 밝힌다 — 안 밝히면 빈 칸을 고장으로 읽는다 */}
          <div className="text-xs text-muted2" style={{ marginTop: 10, lineHeight: 1.7 }}>
            공사 번호는 <b>주문</b>, 품번은 <b>품목 기준정보의 코드</b>(없으면 규격), W/O 는 <b>품명과 품목 비고</b>에서 옵니다.
            합계는 공급가액 기준이에요.
          </div>
        </div>
      )}
    </div>
  )
}

/* ── 7-5. YYYY년도 N월 매출장 ────────────────────────────────────────────── */
export const ReportSalesBook = () => {
  const [month, setMonth] = useState(() => localToday().slice(0, 7))
  const [vendorId, setVendorId] = useState('')
  /* 머리말의 마감일자·담당자는 회사마다·거래처마다 다른 말이라 자료로 갖고 있지 않다.
     여기서 적어 넣으면 그대로 인쇄된다(비워 두면 그 줄은 안 나온다). */
  const [closeNote, setCloseNote] = useState('')
  const [staff, setStaff] = useState('')
  const [d, err] = useForm(
    () => api.getVendorLinesForm({ month, vendorId, kind: 'issued', form: 'sales_book' }), [month, vendorId])

  useEffect(() => {
    if (vendorId && d?.choices?.length && !d.choices.some(c => c.id === vendorId)) setVendorId('')
  }, [d, vendorId])

  return (
    <div>
      <MonthBar month={month} setMonth={setMonth} note={d ? `${d.from} ~ ${d.to}` : ''}
        second={
          <div className="col gap-8">
            <div className="row gap-12" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="text-sm fw-600" style={{ minWidth: 56 }}>마감일자</span>
              <input className="input" style={{ width: 220 }} value={closeNote}
                onChange={e => setCloseNote(e.target.value)} placeholder="예: 15일 / 말일 2회 마감"/>
              <span className="text-sm fw-600" style={{ minWidth: 46 }}>담당자</span>
              {/* 부서-파트-이름-전화가 한 줄로 들어간다 — 300px 이면 끝이 잘려 보인다 */}
              <input className="input" style={{ flex: 1, minWidth: 320 }} value={staff}
                onChange={e => setStaff(e.target.value)} placeholder="예: 부품사업부-파트-홍길동 사원 010-0000-0000"/>
            </div>
            <div className="text-xs text-muted2">적어 두면 인쇄물 머리말에 그대로 나와요. 비워 두면 그 줄은 안 나옵니다.</div>
          </div>
        }>
        {d && <VendorPick choices={d.choices} vendorId={vendorId} setVendorId={setVendorId}/>}
      </MonthBar>
      {err ? <FormError error={err}/> : !d ? <Loading label="매출장을 모으는 중…"/> : !vendorId ? (
        d.choices.length
          ? <FormEmpty title="거래처를 고르세요"
              hint={`${ym(month)}에 매출이 있는 곳 ${d.choices.length}곳이 위 목록에 있어요. 고르면 그 거래처에 보낼 매출장이 나옵니다.`}/>
          : <FormEmpty title={`${ym(month)}에 품목이 적힌 매출 청구서가 없어요`}
              hint="매출장은 청구서에 적은 품목으로 만듭니다. 기준월을 바꿔 보시거나, 청구서를 등록할 때 품목 내역을 채워주세요."/>
      ) : (
        <div className="card" style={{ padding: 24 }}>
          <FormHead title={`${month.slice(0, 4)}년도 ${Number(month.slice(5, 7))}월 매출장`}
            sub={[d.vendor, closeNote && `마감 ${closeNote}`, staff].filter(Boolean).join(' · ')}
            right={<ApprovalBox cols={['담 당', '승 인']}/>}/>
          <div className="table-scroll">
            <table className="table" style={{ minWidth: 940 }}>
              <thead>
                <tr>
                  <th style={{ width: 100 }}>{month.slice(0, 4)}년</th>
                  <th>품명</th>
                  <th style={{ width: 130 }}>품번</th>
                  <th className="num-right" style={{ width: 100 }}>수량</th>
                  <th style={{ width: 56 }}>단위</th>
                  <th className="num-right" style={{ width: 100 }}>단가</th>
                  <th className="num-right" style={{ width: 120 }}>공급가</th>
                  <th className="num-right" style={{ width: 130 }} title="그 줄까지의 공급가 누계">중간계</th>
                  <th className="num-right" style={{ width: 130 }}>VAT 포함</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.length === 0 && (
                  <tr><td colSpan={9} className="dt-empty">이 거래처의 이 달 매출이 없어요.</td></tr>
                )}
                {d.rows.map(r => (
                  <tr key={r.no}>
                    <td className="num text-sm" style={{ whiteSpace: 'nowrap' }}>{String(r.date).slice(5)}</td>
                    <td className="fw-600">{r.name}{r.spec && <span className="text-muted text-sm"> {r.spec}</span>}</td>
                    <td className="num text-sm">{r.code || '—'}</td>
                    <td className="num num-right">
                      {r.qty ? String(r.qty) : ''}
                      {r.basis === 'weight' && <span className="text-muted2" style={{ fontSize: 9 }}> 중량</span>}
                    </td>
                    <td className="text-sm text-center">{r.unit}</td>
                    <td className="num num-right">{fmtNum(r.unitPrice)}</td>
                    <td className="num num-right">{fmtNum(r.amount)}</td>
                    <td className="num num-right text-muted">{fmtNum(r.running)}</td>
                    <td className="num num-right fw-600">{fmtNum(r.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={6} style={{ ...TOTAL, textAlign: 'center' }}>합계</th>
                  <td className="num num-right fw-700" style={TOTAL}>{fmtNum(d.totals.supply)}</td>
                  <td style={TOTAL}/>
                  <td className="num num-right fw-700" style={{ ...TOTAL, fontSize: 15 }}>{fmtNum(d.totals.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
