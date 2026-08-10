import { useState, useEffect, Fragment } from 'react'
import { Icon, fmtNum, useToast, Loading, localToday } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { api } from '../lib/api'
import { downloadCsv } from '../lib/export'

/* 주별 총 매입(매출) 현황 — 품목 단위로 기간을 가로지른다.
 *
 * 실물 그대로 만든다:
 *   "※ 주별 총 매입 현황 (매월 25일 마감)"  + 결재란
 *   순번·일자·거래처명·명칭·규격·수량·단위·단가·금액·부가세·계·비고
 *   주마다 소계, 맨 아래 "7월 총 합계"
 *
 * 세는 것은 **청구서 품목**이지 거래(입출금)가 아니다 — 실물 표의 각 줄이 전부
 * 세금계산서를 받는 매입이기 때문이다(통신요금·기장수수료 포함).
 */
const SUB_CELL = { background: 'var(--surface-2)' }
const TOTAL_CELL = { borderTop: '2px solid var(--ink)', background: 'var(--surface-2)' }

export const PurchaseStatusScreen = ({ go }) => {
  const toast = useToast()
  const [month, setMonth] = useState(() => localToday().slice(0, 7))
  const [kind, setKind] = useState('received')     // 기본 매입 — 실제로 만들던 표가 그것이다
  const [data, setData] = useState(null)
  const [company, setCompany] = useState(null)

  useEffect(() => { api.getCompany().then(setCompany) }, [])
  useEffect(() => {
    let alive = true
    setData(null)
    api.getPurchaseStatus(month, kind).then(d => { if (alive) setData(d) })
    return () => { alive = false }
  }, [month, kind])

  const label = kind === 'received' ? '매입' : '매출'

  const exportCsv = () => {
    if (!data?.count) return toast.push('내보낼 내역이 없어요')
    const rows = []
    let no = 0
    for (const w of data.weeks) {
      for (const l of w.items) {
        no++
        rows.push([no, l.date, l.vendor, l.name, l.spec, l.qty, l.unit,
          l.unit_price, l.amount, l.vat, l.total, l.note])
      }
      if (w.items.length) rows.push(['', `${w.from}~${w.to} 소계`, '', '', '', '', '', '', w.amount, w.vat, w.total, ''])
    }
    rows.push(['', `${month} 총 합계`, '', '', '', '', '', '', data.amount, data.vat, data.total, ''])
    downloadCsv(`${label}현황_${month}.csv`,
      ['순번', '일자', '거래처명', '명칭', '규격', '수량', '단위', '단가', '금액', '부가세', '계', '비고'], rows)
  }

  let seq = 0
  return (
    <div className="fade-up">
      <PageHeader
        title="매입·매출 현황"
        sub="청구서에 적은 품목을 기간으로 모읍니다. 주별 소계와 월 합계가 함께 나와요."
        actions={<>
          <button className="btn" onClick={exportCsv}><Icon.Download/> <span className="btn-label-hide">내보내기</span></button>
          <button className="btn primary" onClick={() => window.print()}><Icon.Print/> 인쇄</button>
        </>}
      />

      <div className="card card-pad no-print" style={{ marginBottom: 16 }}>
        <div className="row gap-12" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="text-sm fw-600">기준월</span>
          {/* 목록형은 최근 몇 달만 담게 돼 작년 자료를 못 본다. 비울 수 없는 값이라 월 입력이 맞다. */}
          <input className="input" type="month" style={{ width: 150 }}
            value={month} onChange={e => e.target.value && setMonth(e.target.value)}/>
          <div className="row gap-6">
            {[['received', '매입'], ['issued', '매출']].map(([k, t]) => (
              <button key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{t}</button>
            ))}
          </div>
          {/* 회계 월이 달력월과 다를 수 있다 — 어느 기간을 세고 있는지 늘 적어둔다 */}
          {data && (
            <span className="text-xs text-muted2 ml-auto">
              {data.from} ~ {data.to}
              {data.closingDay > 0 && <> · 매월 {data.closingDay}일 마감</>}
              <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => go?.('settings_company')}>
                기간 설정 <Icon.Right size={11}/>
              </button>
            </span>
          )}
        </div>
      </div>

      {!data ? <Loading label="품목을 모으는 중…"/> : data.count === 0 ? (
        <div className="card card-pad" style={{ textAlign: 'center', padding: 48, color: 'var(--muted-2)' }}>
          {data.from} ~ {data.to} 사이에 품목이 적힌 {label} 청구서가 없어요.
          <div className="text-xs" style={{ marginTop: 8 }}>
            청구서를 등록할 때 <b>품목 내역</b>을 채우면 여기에 모입니다.
          </div>
        </div>
      ) : (
        // report-print: 인쇄 whitelist(index.css @media print)에 있어야 백지가 안 나온다.
        // 표가 길어 여러 장이 되므로, 머리글을 장마다 반복해주는 report-print 쪽을 쓴다.
        <div className="card report-print" style={{ padding: 24 }}>
          <div className="row" style={{ alignItems: 'flex-start', marginBottom: 14 }}>
            <div className="fw-700" style={{ fontSize: 15 }}>
              ※ 주별 총 {label} 현황
              {data.closingDay > 0 && <span className="text-sm fw-400"> (매월 {data.closingDay}일 마감)</span>}
              <div className="text-xs text-muted" style={{ marginTop: 3, fontWeight: 400 }}>
                {company?.name || ''} · {data.from} ~ {data.to}
              </div>
            </div>
            {/* 실물에 결재란이 있다 — 인쇄해서 결재받는 서류다 */}
            <table className="res-approve" style={{ width: 220, marginLeft: 'auto' }}>
              <tbody>
                <tr><th>담 당</th><th>이 사</th><th>승 인</th></tr>
                <tr><td></td><td></td><td></td></tr>
              </tbody>
            </table>
          </div>

          {/* 열이 12개라 좁은 화면에서는 글자가 접힌다 — 접느니 가로로 밀어 보게 한다.
              (인쇄는 A4 가로폭에 맞춰 브라우저가 축소하므로 min-width 가 방해되지 않는다) */}
          <div className="table-scroll" style={{ overflowX: 'auto' }}>
            <table className="table" style={{ minWidth: 1060 }}>
              <thead>
                <tr>
                  <th style={{ width: 42 }}>순번</th>
                  <th style={{ width: 92, whiteSpace: 'nowrap' }}>일자</th>
                  <th style={{ width: 120 }}>거래처명</th>
                  <th style={{ minWidth: 120 }}>명칭</th>
                  <th style={{ width: 130 }}>규격</th>
                  <th className="num-right" style={{ width: 56 }}>수량</th>
                  <th style={{ width: 44 }}>단위</th>
                  <th className="num-right" style={{ width: 86 }}>단가</th>
                  <th className="num-right" style={{ width: 96 }}>금액</th>
                  <th className="num-right" style={{ width: 84 }}>부가세</th>
                  <th className="num-right" style={{ width: 96 }}>계</th>
                  <th style={{ width: 96 }}>비고</th>
                </tr>
              </thead>
              <tbody>
                {data.weeks.map((w, wi) => (
                  w.items.length === 0 ? null : (
                    <Fragment key={wi}>
                      {w.items.map((l, li) => {
                        seq++
                        return (
                          <tr key={`${wi}-${li}`}>
                            <td className="num text-center">{seq}</td>
                            <td className="num text-sm" style={{ whiteSpace: 'nowrap' }}>{l.date}</td>
                            <td className="text-sm">{l.vendor}</td>
                            <td className="fw-600">{l.name}</td>
                            <td className="text-sm text-muted">{l.spec}</td>
                            <td className="num num-right">
                              {l.qty ? String(l.qty) : ''}
                              {/* 중량 기준 줄은 곱한 값이 중량이다 — 안 적으면 수량으로 읽힌다 */}
                              {l.basis === 'weight' && <span className="text-muted2" style={{ fontSize: 9 }}> 중량</span>}
                            </td>
                            <td className="text-sm text-center">{l.unit}</td>
                            <td className="num num-right">{fmtNum(l.unit_price)}</td>
                            <td className="num num-right">{fmtNum(l.amount)}</td>
                            {/* 면세 줄은 0 이 아니라 빈 칸 — 실물이 그렇게 비워둔다 */}
                            <td className="num num-right">{l.vat ? fmtNum(l.vat) : ''}</td>
                            <td className="num num-right fw-600">{fmtNum(l.total)}</td>
                            <td className="text-xs text-muted">{l.note}</td>
                          </tr>
                        )
                      })}
                      {/* 음영은 행이 아니라 칸에 준다 — th 가 제 배경을 갖고 있어서
                          행에만 주면 왼쪽만 음영이 들어간 반쪽짜리 줄이 된다 */}
                      <tr>
                        <th colSpan={8} style={{ ...SUB_CELL, textAlign: 'center' }}>
                          {w.from} ~ {w.to} 소계
                        </th>
                        <td className="num num-right fw-600" style={SUB_CELL}>{fmtNum(w.amount)}</td>
                        <td className="num num-right" style={SUB_CELL}>{fmtNum(w.vat)}</td>
                        <td className="num num-right fw-700" style={SUB_CELL}>{fmtNum(w.total)}</td>
                        <td style={SUB_CELL}></td>
                      </tr>
                    </Fragment>
                  )
                ))}
              </tbody>
              {/* 총 합계는 소계와 같은 무게로 보이면 안 된다 — 위에 선을 하나 더 긋는다.
                  (border-collapse 라 tfoot 자체에 준 선은 안 그려진다 — 칸마다 줘야 한다) */}
              <tfoot>
                <tr>
                  <th colSpan={8} style={{ ...TOTAL_CELL, textAlign: 'center' }}>
                    {month.slice(0, 4)}년 {Number(month.slice(5, 7))}월 총 합계
                  </th>
                  <td className="num num-right fw-700" style={TOTAL_CELL}>{fmtNum(data.amount)}</td>
                  <td className="num num-right fw-700" style={TOTAL_CELL}>{fmtNum(data.vat)}</td>
                  <td className="num num-right fw-700" style={{ ...TOTAL_CELL, fontSize: 15 }}>{fmtNum(data.total)}</td>
                  <td style={TOTAL_CELL}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
