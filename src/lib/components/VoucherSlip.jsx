import { fmtNum } from '../ui'

/**
 * 전표 종이 한 장 — 차변 | 계정과목 | 대변. **그리는 곳은 여기 하나다.**
 *
 * 예전엔 두 벌이었다: 전표 보기(VoucherView)와 전표 목록 선택 인쇄(VoucherBook). 거래 한눈에 보기와
 * 인쇄 마법사까지 붙으면 네 벌이 된다 — 한쪽만 고치면 화면과 종이가 서로 다른 전표를 보여 준다.
 * (설계 popup-attachments-print §8: 양식 재사용 전에 컴포넌트로 뽑는다)
 *
 * @param v      서버 전표(lib/voucher.js) 또는 전표 목록 행(voucherBook) — 둘의 칸 이름이 조금 다르다
 * @param notes  아래 설명 줄(화면용, 인쇄 안 됨)
 */
export const VoucherSlip = ({ v, notes = false }) => {
  if (!v) return null
  const rows = v.lines || []
  // 전표 목록 행은 vendor_name·memo 로 온다 — 같은 종이에 같은 자리로
  const counterparty = v.counterparty || v.vendor_name
  const summary = v.summary || v.memo || (v.lines ? '' : v.category)
  return (
    <div className="voucher-slip">
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <div className="fw-700" style={{ fontSize: 20, letterSpacing: '0.3em', paddingLeft: '0.3em' }}>{v.type}</div>
        <div className="text-sm text-muted" style={{ marginTop: 6 }}>{v.date}</div>
      </div>

      <div className="row" style={{ gap: 24, flexWrap: 'wrap', marginBottom: 14, fontSize: 13 }}>
        {counterparty && <div><span className="text-muted2">거래처</span> <b>{counterparty}</b></div>}
        {v.account_name && <div><span className="text-muted2">계좌</span> <b>{v.account_name}</b></div>}
        {v.category && <div><span className="text-muted2">비목</span> <b>{v.category}</b></div>}
      </div>
      {summary && (
        <div style={{ fontSize: 13, marginBottom: 14 }}>
          <span className="text-muted2">적요</span> {summary}
        </div>
      )}

      {/* 짝이 안 맞으면 감추지 않는다 — 조용히 맞추면 틀린 장부가 맞는 것처럼 보인다 */}
      {v.balanced === false && (
        <div className="card card-pad" style={{ marginBottom: 12, borderColor: 'var(--neg)', background: 'rgba(220,38,38,0.04)' }}>
          <div className="fw-700 text-sm" style={{ color: 'var(--neg-ink)', marginBottom: 4 }}>이 전표는 아직 완성되지 않았어요</div>
          <div className="text-sm text-muted">{v.missing || '차변과 대변이 맞지 않아요.'} 고치면 장부에 제대로 올라갑니다.</div>
        </div>
      )}

      {/* 전표는 T자다 — 차변 | 계정과목 | 대변 이 가운데로 모여야 읽힌다(일계표 화면과 같은 구성) */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: '30%', textAlign: 'right' }}>차변</th>
              <th style={{ textAlign: 'center' }}>계정과목</th>
              <th style={{ width: '30%', textAlign: 'right' }}>대변</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l, i) => (
              <tr key={i}>
                <td className="num-cell num-right fw-700">{l.side === 'debit' ? fmtNum(l.amount) : ''}</td>
                <td style={{ textAlign: 'center' }}>
                  <span className="num text-xs text-muted2" style={{ marginRight: 8 }}>{l.code}</span>
                  <span className="text-sm fw-600">{l.name}</span>
                  {l.acct_type && <span className="badge outline" style={{ fontSize: 10, marginLeft: 8 }}>{l.acct_type}</span>}
                </td>
                <td className="num-cell num-right fw-700">{l.side === 'credit' ? fmtNum(l.amount) : ''}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={3} style={{ textAlign: 'center', padding: 28, color: 'var(--muted-2)' }}>
                계정과목이 없어 전표를 세울 수 없어요.
              </td></tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td className="num-cell num-right fw-700">{fmtNum(v.debitTotal)}</td>
                <td className="text-sm" style={{ textAlign: 'center' }}>합계</td>
                <td className="num-cell num-right fw-700">{fmtNum(v.creditTotal)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {notes && (
        <div className="text-xs text-muted2 no-print" style={{ marginTop: 12, lineHeight: 1.7 }}>
          {/* 대체전표(journal)는 돈이 안 움직인 분개다 — '돈이 오간 시점'이라고 적으면 거짓말이 된다 */}
          {v.source === 'invoice'
            ? '· 청구서를 발행한 시점의 전표예요. 대금이 실제로 오갈 때는 별도의 전표가 따로 생깁니다.'
            : v.source === 'journal'
            ? '· 돈이 움직이지 않은 분개예요. 통장 잔액에는 영향이 없습니다.'
            : '· 돈이 실제로 오간 시점의 전표예요. 청구서를 거친 건이면 발행 시점 전표가 따로 있습니다.'}
          <br/>
          · 통장 거래는 <b>대체전표</b>예요. 입금·출금전표는 현금(시재)이 오갈 때만 씁니다.
        </div>
      )}
    </div>
  )
}
