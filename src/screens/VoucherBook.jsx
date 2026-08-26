import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, useToast, DateInput, Loading, periodToRange } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { api } from '../lib/api'

/**
 * 전표 목록(분개장) — 기간 안의 거래를 차변·대변 줄로 펼친다.
 *
 * 신고철에 세무사에게 넘기거나 회계 프로그램에 올릴 때 쓴다. 그때까지는 전표를
 * **한 건씩만** 볼 수 있었고(청구서·거래 상세의 '전표'), 하루치 집계가 일계표였다.
 * 기간 전체를 뽑을 길이 없어 거래내역 CSV 를 받아 손으로 분개를 만들어야 했다.
 *
 * ⚠ 분개는 **서버에서만** 만든다(lib/voucher.js). 화면에서 다시 만들면 같은 거래가
 *   화면과 파일에서 다른 분개로 나와, 어느 쪽이 장부인지 알 수 없게 된다.
 *
 * ⚠ 짝이 안 맞는 전표를 감추지 않는다. 빼면 합계는 맞아 보이지만 그 거래가 장부에서
 *   사라진다. 그대로 세우고 '확인 필요'로 표시해 고칠 수 있게 한다.
 */

const KINDS = [['all', '전체'], ['income', '입금'], ['expense', '지출']]

export const VoucherBookScreen = () => {
  const toast = useToast()
  const init = periodToRange('month')
  const [from, setFrom] = useState(init.from)
  const [to, setTo] = useState(init.to)
  const [kind, setKind] = useState('all')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    if (!from || !to) return
    setLoading(true)
    setRows(await api.getVoucherBook({ from, to, kind }))
    setLoading(false)
  }
  useEffect(() => { load() }, [from, to, kind])

  const sum = useMemo(() => rows.reduce((a, v) => ({
    debit: a.debit + v.debitTotal, credit: a.credit + v.creditTotal,
    bad: a.bad + (v.balanced ? 0 : 1),
  }), { debit: 0, credit: 0, bad: 0 }), [rows])

  const download = async () => {
    if (rows.length === 0) return toast.push('내보낼 전표가 없어요')
    setBusy(true)
    const res = await api.downloadVoucherBookXlsx({ from, to, kind })
    setBusy(false)
    if (!res.ok) toast.push(res.error || '내려받기에 실패했어요', { tone: 'warn' })
  }

  return (
    <div className="fade-up">
      <PageHeader title="전표 목록"
        sub="기간 안의 거래를 차변·대변으로 펼칩니다. 세무사에게 넘기거나 회계 프로그램에 올릴 때 쓰세요."
        actions={
          <button className="btn primary" onClick={download} disabled={busy || rows.length === 0}>
            <Icon.Excel size={14}/> 엑셀 내려받기
          </button>
        }/>

      <div className="card card-pad row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <DateInput className="input" style={{ width: 150 }} value={from} onChange={e => setFrom(e.target.value)}/>
        <span className="text-muted2">~</span>
        <DateInput className="input" style={{ width: 150 }} value={to} onChange={e => setTo(e.target.value)}/>
        <div className="row gap-6" style={{ marginLeft: 8 }}>
          {[['month', '이번 달'], ['quarter', '이번 분기'], ['year', '올해']].map(([p, label]) => (
            <button key={p} className="chip" onClick={() => { const r = periodToRange(p); setFrom(r.from); setTo(r.to) }}>{label}</button>
          ))}
        </div>
        <div className="row gap-6 ml-auto">
          {KINDS.map(([v, label]) => (
            <button key={v} className={`chip ${kind === v ? 'active' : ''}`} onClick={() => setKind(v)}>{label}</button>
          ))}
        </div>
      </div>

      {/* 차·대 합계는 반드시 같아야 한다. 다르면 감추지 않고 그 사실을 크게 적는다. */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
        <div className="card card-pad">
          <div className="text-xs text-muted2">전표</div>
          <div className="num fw-700" style={{ fontSize: 20 }}>{fmtNum(rows.length)}<span className="text-sm text-muted"> 건</span></div>
        </div>
        <div className="card card-pad">
          <div className="text-xs text-muted2">차변 합계</div>
          <div className="num fw-700" style={{ fontSize: 20 }}>{fmtNum(sum.debit)}</div>
        </div>
        <div className="card card-pad" style={sum.debit !== sum.credit ? { borderColor: 'var(--neg)' } : undefined}>
          <div className="text-xs text-muted2">대변 합계</div>
          <div className="num fw-700" style={{ fontSize: 20, color: sum.debit !== sum.credit ? 'var(--neg-ink)' : undefined }}>
            {fmtNum(sum.credit)}
          </div>
          {sum.debit !== sum.credit && (
            <div className="text-xs" style={{ color: 'var(--neg-ink)', marginTop: 4 }}>
              차이 {fmtNum(Math.abs(sum.debit - sum.credit))}
            </div>
          )}
        </div>
      </div>

      {sum.bad > 0 && (
        <div className="alert-row" style={{ marginBottom: 16, background: 'var(--warn-soft)', borderColor: 'transparent' }}>
          <Icon.Warn/>
          <div>
            <div className="lead">짝이 안 맞는 전표가 {sum.bad}건 있어요.</div>
            <div className="body">
              대개 거래에 계정과목을 안 골라서 한쪽 다리가 비어 있는 경우예요.
              아래 표의 <b>확인</b> 칸을 보고 그 거래를 고쳐주세요 — 이대로 내보내도 파일에는 그대로 실립니다.
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? <Loading label="전표를 만드는 중…"/> : (
          <table className="vb-table">
            <thead>
              <tr>
                <th style={{ width: 100 }}>일자</th>
                <th style={{ width: 60 }}>구분</th>
                <th style={{ width: 90 }}>계정코드</th>
                <th>계정과목</th>
                <th className="num-right" style={{ width: 120 }}>차변</th>
                <th className="num-right" style={{ width: 120 }}>대변</th>
                <th>거래처 · 적요</th>
                <th style={{ width: 150 }}>확인</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--muted-2)', fontSize: 13 }}>
                  이 기간에 전표가 없어요.
                </td></tr>
              )}
              {/* 전표 순번(vi)으로 줄무늬를 준다 — 행 번호가 아니라 **전표 번호**가 기준이다.
                  한 전표가 여러 줄이라, 행마다 색을 바꾸면 묶음이 보이지 않는다. */}
              {rows.map((v, vi) => (v.lines.length === 0 ? [
                /* ⚠ 줄이 하나도 없는 전표(계좌·계정과목이 둘 다 빔)도 세운다.
                   빼면 화면에서 그 거래가 사라져, 고쳐야 할 대상을 볼 수가 없다. */
                <tr key={v.id} className={`vb-top ${vi % 2 ? 'vb-alt' : ''}`}>
                  <td className="num-cell text-sm text-muted vb-nowrap">{v.date}</td>
                  <td><span className="badge outline" style={{ fontSize: 10 }}>{v.type}</span></td>
                  <td className="num text-sm text-muted">—</td>
                  <td className="text-sm text-muted2">(계정과목 없음)</td>
                  <td className="num-cell num-right vb-nowrap">{v.kind === 'income' ? '' : fmtNum(v.amount)}</td>
                  <td className="num-cell num-right vb-nowrap">{v.kind === 'income' ? fmtNum(v.amount) : ''}</td>
                  <td className="text-sm">
                    <span className="fw-600">{v.vendor_name || '—'}</span>
                    {(v.memo || v.category) && <span className="text-muted2"> · {v.memo || v.category}</span>}
                  </td>
                  <td><span className="badge warn" style={{ fontSize: 10 }}>계좌·계정과목이 비어 있어요</span></td>
                </tr>,
              ] : v.lines.map((l, li) => (
                /* 한 전표가 여러 줄이다. 첫 줄에만 일자·구분·거래처를 적고 나머지는 비운다 —
                   같은 값을 줄마다 되풀이하면 어디서 전표가 갈리는지 눈으로 못 찾는다. */
                <tr key={`${v.id}-${li}`} className={`${li === 0 ? 'vb-top' : ''} ${vi % 2 ? 'vb-alt' : ''}`}>
                  <td className="num-cell text-sm text-muted vb-nowrap">{li === 0 ? v.date : ''}</td>
                  <td>{li === 0 ? <span className="badge outline" style={{ fontSize: 10 }}>{v.type}</span> : ''}</td>
                  <td className="num text-sm text-muted">{l.code}</td>
                  <td className="text-sm fw-600">{l.name}</td>
                  <td className="num-cell num-right vb-nowrap">{l.side === 'debit' ? fmtNum(l.amount) : ''}</td>
                  <td className="num-cell num-right vb-nowrap">{l.side === 'credit' ? fmtNum(l.amount) : ''}</td>
                  <td className="text-sm">
                    {li === 0 && <>
                      <span className="fw-600">{v.vendor_name || '—'}</span>
                      {(v.memo || v.category) && <span className="text-muted2"> · {v.memo || v.category}</span>}
                    </>}
                  </td>
                  <td>
                    {li === 0 && !v.balanced && (
                      <span className="badge warn" style={{ fontSize: 10 }}>{v.missing || '차·대 불일치'}</span>
                    )}
                  </td>
                </tr>
              ))))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
