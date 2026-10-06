import { Icon, fmtNum } from '../ui'

/**
 * 여러 품목을 표 한 칸에 — **'첫 품목 외 N건'** + 펼침 표시. 펼친 내용은 부르는 표가 아래 줄로 그린다(ItemLines).
 *
 * 왜 — '40개 · 선박 배관 지지대 01'처럼 개수와 첫 이름을 한 칸에 몰아 두니 칸이 접히고,
 *   나머지 39개는 볼 길이 없었다(2026-10-02 사용자: "외 N 해놓고 누르면 펼쳐지게").
 *   여러 품목을 보여 주는 칸은 이 모양 하나로 쓴다.
 */
export const ItemSummary = ({ names = [], open = false }) => {
  const n = names.length
  if (!n) return <span className="text-muted2">—</span>
  const first = names[0] || '(이름 없음)'
  return (
    <span className="row gap-4" style={{ alignItems: 'center', minWidth: 0 }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{first}</span>
      {n > 1 && <span className="text-muted2" style={{ flexShrink: 0 }}>외 {n - 1}건</span>}
      {n > 1 && (open ? <Icon.Up size={12} className="text-muted2"/> : <Icon.Down size={12} className="text-muted2"/>)}
    </span>
  )
}

/* 펼친 품목 표 — 많으면 안에서 스크롤(40줄이 화면을 다 밀어내지 않게) */
export const ItemLines = ({ lines = [] }) => (
  <div style={{ maxHeight: 280, overflowY: 'auto' }}>
    <table className="table table-compact" style={{ background: 'var(--surface)' }}>
      <thead><tr><th style={{ width: 40 }}>#</th><th>품목명</th><th>규격</th><th style={{ textAlign: 'right' }}>수량</th><th style={{ textAlign: 'right' }}>단가</th><th style={{ textAlign: 'right' }}>공급가액</th></tr></thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i}>
            <td className="num text-muted2">{i + 1}</td>
            <td className="dt-cell"><div style={{ maxWidth: 320 }} title={l.name}>{l.name || '—'}</div></td>
            <td className="dt-cell text-muted"><div style={{ maxWidth: 200 }} title={l.spec}>{l.spec || '—'}</div></td>
            <td className="num" style={{ textAlign: 'right' }}>{fmtNum(l.qty)}</td>
            <td className="num" style={{ textAlign: 'right' }}>{fmtNum(l.unit_price)}</td>
            <td className="num fw-600" style={{ textAlign: 'right' }}>{fmtNum(l.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)
