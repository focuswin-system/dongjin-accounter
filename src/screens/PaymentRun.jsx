import { useState, useEffect } from 'react'
import { Icon, fmtNum, useToast, FilterSelect, Loading, localToday } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { api } from '../lib/api'
import { downloadCsv } from '../lib/export'

/* 매입처 결제 내역 — 매달 은행에 넣을 일괄이체 명단.
 *
 * 실제 고객사가 매달 엑셀로 손수 만들던 서류를 그대로 대체한다:
 *   "2026년 6월분 매입처 결제 내역 / 경남은행 창원영업부 207-0077-7078-00 / 합계 7,712,253"
 *   31개 업체 × (업체명·은행·계좌번호·예금주·이체금액·비고)
 * 받은 실물은 순번이 13→15→18→14 로 꼬여 있었다 — 손으로 정렬하다 어긋난 흔적이다.
 *
 * ⚠ 이 화면은 **아무것도 바꾸지 않는다.** 명단을 보여주고 인쇄·내보내기만 한다.
 *   실제 지급 처리는 대금 청구서의 일괄 정산이 맡는다 — 돈이 나가는 길을 둘로 만들면
 *   나중에 어느 쪽으로 나갔는지 못 짚는다.
 */
export const PaymentRunScreen = ({ go }) => {
  const toast = useToast()
  const [month, setMonth] = useState(() => localToday().slice(0, 7))
  const [data, setData] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [fromAccount, setFromAccount] = useState(null)   // 출금 계좌(문서 머리에 적는다)
  const [company, setCompany] = useState(null)

  useEffect(() => {
    api.getAccounts().then(list => setAccounts((list || []).filter(a => a.kind === 'bank')))
    api.getCompany().then(setCompany)
  }, [])

  useEffect(() => {
    let alive = true
    setData(null)
    api.getPaymentRun(month).then(d => { if (alive) setData(d) })
    return () => { alive = false }
  }, [month])

  const acc = accounts.find(a => a.name === fromAccount)

  const exportCsv = () => {
    if (!data?.vendors?.length) return toast.push('내보낼 내역이 없어요')
    /* 계좌번호는 **글자**로 내보낸다(textCols). 그냥 두면 Excel 이 숫자로 읽어
       하이픈 없는 계좌가 1.73065E+13 이 되고 앞자리 0 이 사라진다 — 틀린 계좌로 돈이 나간다.
       이체금액은 반대로 숫자여야 한다(엑셀에서 합계를 내야 하므로). */
    downloadCsv(`매입처_결제내역_${month}.csv`,
      ['순번', '업체명', '은행', '계좌번호', '예금주', '이체금액', '건수', '비고'],
      data.vendors.map((v, i) => [
        i + 1, v.vendor_name, v.bank_name, v.bank_account,
        v.account_holder || v.vendor_name, v.amount, v.count,
        v.overdue > 0 ? `연체 ${fmtNum(v.overdue)}원 포함` : '',
      ]),
      { textCols: [3] })
  }

  return (
    <div className="fade-up">
      <PageHeader
        title="매입 결제내역"
        sub="이번 달 매입처에 보낼 대금을 한 장으로 모읍니다. 은행 이체 명단으로 그대로 쓰세요."
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
          <span className="text-xs text-muted2">그 달 말일까지 낼 미지급금 — 기한이 지난 것도 함께 모읍니다</span>
          {/* ⚠ 이 칸은 **거르지 않는다.** 문서 머리에 '어느 계좌에서 보낼지'를 적을 뿐이다.
              미지급금은 아직 안 나간 돈이라 출금 계좌가 정해져 있지 않다(대개 비어 있다) —
              그걸로 거르면 명단 대부분이 사라져서 정작 낼 돈이 안 보인다.
              그래서 '거르는 칸'처럼 보이지 않게 이름과 설명을 붙여둔다. 고르면 걸러진다고
              믿게 만드는 화면은 안 만든 것만 못하다. */}
          <div className="row gap-8 ml-auto" style={{ alignItems: 'center' }}>
            <span className="text-sm fw-600">보낼 계좌</span>
            <FilterSelect value={fromAccount} onChange={setFromAccount}
              options={accounts.map(a => a.name)} placeholder="선택 안 함"/>
            <span className="text-xs text-muted2">문서 머리에 적어요 · 목록은 안 걸러집니다</span>
          </div>
        </div>
      </div>

      {/* 계좌를 모르면 이체 자체를 못 한다 — 이 명단의 유일한 치명적 결함이라 크게 알린다 */}
      {data && data.missingBank > 0 && (
        <div className="card card-pad no-print" style={{ marginBottom: 16, background: 'var(--warn-soft)' }}>
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <Icon.Warn size={16}/>
            <div style={{ flex: 1 }}>
              <div className="fw-700 text-sm">계좌를 모르는 거래처가 {data.missingBank}곳 있어요</div>
              <div className="text-sm text-muted" style={{ marginTop: 2 }}>
                이대로는 그곳에 이체할 수 없습니다. 기준정보 › 거래처에서 은행·계좌번호·예금주를 채워주세요
                (엑셀로 한 번에 올릴 수도 있어요).
              </div>
            </div>
            <button className="btn sm" onClick={() => go?.('master_vendor')}>거래처로 <Icon.Right size={12}/></button>
          </div>
        </div>
      )}

      {!data ? <Loading label="미지급금을 모으는 중…"/> : data.vendors.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: 'center', padding: 48, color: 'var(--muted-2)' }}>
          {month} 말일까지 낼 미지급금이 없어요.
        </div>
      ) : (
        <div className="card" id="resolution-print" style={{ padding: 24 }}>
          {/* 실물 서류와 같은 머리 — 사업자번호·제목·출금계좌·합계 */}
          <div className="text-xs text-muted num" style={{ marginBottom: 8 }}>
            {company?.biz_no ? `NO.${company.biz_no}` : ''}
          </div>
          <div style={{ textAlign: 'center', fontSize: 20, fontWeight: 800, letterSpacing: '0.06em', marginBottom: 16 }}>
            {month.slice(0, 4)}년 {Number(month.slice(5, 7))}월분 매입처 결제 내역
          </div>

          <table className="table" style={{ marginBottom: 14 }}>
            <tbody>
              <tr>
                <th style={{ width: 150, background: 'var(--surface-2)' }}>{acc?.bankName || '출금 계좌'}</th>
                <th style={{ width: 60, background: 'var(--surface-2)' }}>계좌</th>
                <td className="num">{acc?.number || '—'}</td>
                <th style={{ width: 50, background: 'var(--surface-2)' }}>₩</th>
                <td className="num fw-700 num-right" style={{ fontSize: 16 }}>{fmtNum(data.total)}</td>
              </tr>
            </tbody>
          </table>

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>순번</th>
                  <th>업체명</th>
                  <th style={{ width: 70 }}>은행명</th>
                  <th style={{ width: 150 }}>계좌번호</th>
                  <th style={{ width: 120 }}>예금주</th>
                  <th className="num-right" style={{ width: 110 }}>이체금액</th>
                  <th style={{ width: 130 }}>비고</th>
                </tr>
              </thead>
              <tbody>
                {data.vendors.map((v, i) => (
                  <tr key={v.vendor_id || v.vendor_name}>
                    <td className="num text-center">{i + 1}</td>
                    <td className="fw-600">{v.vendor_name}</td>
                    <td className="text-sm">{v.bank_name || <span className="text-neg">—</span>}</td>
                    <td className="num text-sm">
                      {v.bank_account || <span className="text-neg">계좌 없음</span>}
                      {/* 예전에 한 칸으로 적어둔 값이 있으면 근거로 보여준다 */}
                      {!v.bank_account && v.pay_account_legacy && (
                        <div className="text-xs text-muted2 no-print">예전 입력: {v.pay_account_legacy}</div>
                      )}
                    </td>
                    <td className="text-sm">
                      {v.account_holder || <span className="text-muted2">{v.vendor_name}</span>}
                    </td>
                    <td className="num num-right fw-700">{fmtNum(v.amount)}</td>
                    <td className="text-xs text-muted">
                      {v.count > 1 && `${v.count}건`}
                      {v.overdue > 0 && <span className="text-neg"> · 연체 {fmtNum(v.overdue)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={5} style={{ textAlign: 'center' }}>합　계</th>
                  <td className="num num-right fw-700" style={{ fontSize: 15 }}>{fmtNum(data.total)}</td>
                  <td className="text-xs text-muted">{data.count}개사</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="text-xs text-muted2 no-print" style={{ marginTop: 12 }}>
            이 화면은 명단만 보여줍니다. 실제 지급 처리는 <b>대금 청구서</b>에서 여러 건을 골라
            <b> 지급 처리</b>하면 거래내역·계좌 잔액에 반영돼요.
          </div>
        </div>
      )}
    </div>
  )
}
