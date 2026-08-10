import { fmtNum } from '../ui'

/* 거래명세서 — 청구서의 품목 내역을 실제로 주고받는 서류로 뽑는다.
 *
 * 청구서에 '거래명세서식' 품목 입력을 만들어 놓고 정작 명세서를 뽑을 데가 없었다.
 * 품목은 지급결의서와 기성 누계에만 쓰이고, 거래처에 보내는 서류는 여전히 엑셀로
 * 따로 만들어야 했다 — 같은 내용을 두 번 적는 게 그대로 남아 있던 셈이다.
 *
 * 양식은 지출결의서(resolution-paper)와 같은 뼈대를 쓴다. 회사마다 명세서 서식이
 * 조금씩 다르지만, 공급자·공급받는자·품목·합계·인감 자리는 공통이다.
 *
 * ── 중량 ──
 * 중량을 쓰는 줄이 하나도 없으면 칸 자체를 내지 않는다. 금속·자재를 안 다루는 회사에
 * 늘 빈 칸이 서 있으면 명세서가 지저분해지고, 받는 쪽도 "왜 비었지"를 묻는다.
 * 중량이 단가 기준인 줄은 그 숫자에 표시를 달아 금액의 근거가 보이게 한다.
 */
export const StatementDoc = ({ invoice, company, vendor, printId = 'statement-print' }) => {
  const lines = invoice?.lines || []
  const useWeight = lines.some(l => Number(l.weight) > 0)
  const supply = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0) || Number(invoice?.supplyAmount) || 0
  const vat = Number(invoice?.vatAmount) || 0

  /* 발행(매출)이면 우리가 공급자, 수취(매입)면 거래처가 공급자다.
     명세서는 '누가 누구에게 줬는가'를 적는 서류라 이 방향이 뒤집히면 서류가 거짓말을 한다. */
  const weIssue = invoice?.kind === 'issued'
  const supplier = weIssue ? company : vendor
  const buyer    = weIssue ? vendor : company

  const party = (label, p) => (
    <table className="res-table" style={{ width: '100%' }}>
      <tbody>
        <tr><th style={{ width: 74 }}>{label}</th><td colSpan={3} className="fw-700">{p?.name || '—'}</td></tr>
        <tr><th>사업자번호</th><td className="num">{p?.biz_no || '—'}</td><th style={{ width: 56 }}>대표</th><td>{p?.ceo || '—'}</td></tr>
        <tr><th>주소</th><td colSpan={3} className="text-sm">{p?.address || '—'}</td></tr>
      </tbody>
    </table>
  )

  // 양식 느낌 — 품목이 적어도 표가 너무 납작해지지 않게 빈 줄로 채운다
  const blanks = Math.max(0, 5 - lines.length)
  const colCount = useWeight ? 8 : 7

  return (
    <div className="doc-paper resolution-paper" id={printId}>
      <div className="res-title-ko">거래명세서</div>
      <div className="res-title">去 來 明 細 書</div>
      <div className="res-date num">{invoice?.issuedAt || ''}</div>

      <div className="stmt-parties">
        {party('공급자', supplier)}
        {party('공급받는자', buyer)}
      </div>

      <div className="res-note-line">아래와 같이 거래 내역을 통지합니다.</div>

      <table className="res-table res-items">
        <thead>
          <tr>
            <th style={{ width: 34 }}>NO</th>
            <th>품명 및 규격</th>
            <th style={{ width: 50 }}>단위</th>
            <th style={{ width: 56 }}>수량</th>
            {useWeight && <th style={{ width: 66 }}>중량</th>}
            <th style={{ width: 92 }}>단가</th>
            <th style={{ width: 106 }}>금액</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id || i}>
              <td className="num" style={{ textAlign: 'center' }}>{i + 1}</td>
              <td>
                {l.name}
                {/* 규격은 아랫줄에 흐리게 — 한 줄에 이어 붙이면 품명이 어디서 끝나는지 안 보인다 */}
                {l.spec && <div className="text-xs text-muted" style={{ marginTop: 2 }}>{l.spec}</div>}
              </td>
              <td style={{ textAlign: 'center' }}>{l.unit || ''}</td>
              <td className="num" style={{ textAlign: 'right' }}>{Number(l.qty) ? fmtNum(l.qty) : ''}</td>
              {useWeight && (
                <td className="num" style={{ textAlign: 'right' }}>
                  {Number(l.weight) ? String(Number(l.weight)) : ''}
                  {l.price_basis === 'weight' && <span className="stmt-basis">기준</span>}
                </td>
              )}
              <td className="num" style={{ textAlign: 'right' }}>{fmtNum(l.unit_price || 0)}</td>
              <td className="num fw-600" style={{ textAlign: 'right' }}>{fmtNum(l.amount || 0)}</td>
            </tr>
          ))}
          {Array.from({ length: blanks }).map((_, i) => (
            <tr key={`b${i}`}>{Array.from({ length: colCount - 1 }).map((__, j) => <td key={j}>&nbsp;</td>)}</tr>
          ))}
          <tr className="res-total">
            <th colSpan={colCount - 2} style={{ textAlign: 'center' }}>공급가액</th>
            <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(supply)}</td>
          </tr>
          <tr className="res-total">
            <th colSpan={colCount - 2} style={{ textAlign: 'center' }}>세　액</th>
            <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(vat)}</td>
          </tr>
          <tr className="res-total">
            <th colSpan={colCount - 2} style={{ textAlign: 'center' }}>합　계</th>
            <td className="num fw-700" style={{ textAlign: 'right' }}>{fmtNum(supply + vat)}</td>
          </tr>
        </tbody>
      </table>

      <div className="res-foot">
        <div className="res-note">
          <div className="res-note-head">비고</div>
          <div className="res-note-body">{invoice?.memo || ''}</div>
        </div>
        {/* 인감 자리 — 인쇄해서 찍는 방식(전자서명 아님), 지출결의서 결재란과 같은 결 */}
        <table className="res-approve">
          <tbody>
            <tr><th>인수자</th><th>공급자(인)</th></tr>
            <tr><td></td><td></td></tr>
          </tbody>
        </table>
      </div>

      <div className="res-company">
        {supplier?.name || ''}{supplier?.phone ? ` · ${supplier.phone}` : ''}
        {invoice?.invoiceNo ? ` · 청구번호 ${invoice.invoiceNo}` : ''}
      </div>
    </div>
  )
}
