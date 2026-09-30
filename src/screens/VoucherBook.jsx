import { useState, useEffect, useMemo, useRef} from 'react'
import { Icon, fmtNum, useToast, Loading, periodToRange, useFiscalTick } from '../lib/ui'
import { PageHeader } from '../lib/components/PageHeader'
import { api } from '../lib/api'
import { PrintEditButton } from '../lib/components/PrintEditButton'
import { usePrintEdit } from '../lib/printEdit'
import { VoucherView } from '../lib/components/VoucherView'
import { VoucherSlip } from '../lib/components/VoucherSlip'
import { DateRangeBar } from '../lib/components/PeriodPicker'

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

/* initialRange — 거래내역에서 '전표로 보기'로 넘어온 기간. goRoute — 되돌아가는 길.
   둘 다 없으면 평소처럼 이번 달을 본다(메뉴로 바로 들어온 경우). */
export const VoucherBookScreen = ({ initialRange = null, goRoute }) => {
  useFiscalTick()
  const toast = useToast()
  const init = initialRange || periodToRange('month')
  const [from, setFrom] = useState(init.from)
  const [to, setTo] = useState(init.to)
  const [kind, setKind] = useState('all')
  const [rows, setRows] = useState([])
  /* 전표 목록의 한 건을 클릭하면 그 전표를 '전표 모양'(차변|계정|대변)으로 띄운다.
     목록이 이미 완성된 전표(lines·합계·source)를 쥐고 있어 재조회 없이 그대로 넘긴다 —
     그래서 단건 조회 API 가 없는 어음(note)도 함께 열린다.
     적요·거래처는 슬립이 counterparty/summary 를 읽으므로 목록의 이름을 맞춰 넣는다. */
  const [slip, setSlip] = useState(null)
  const openSlip = (v) => setSlip({ ...v, counterparty: v.counterparty || v.vendor_name, summary: v.summary || v.memo || v.category })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  /* 여러 전표를 골라 한 번에 인쇄한다. 전표 종류마다 id 가 겹칠 수 있어 source 를 붙여 키로 쓴다. */
  const keyOf = (v) => `${v.source}:${v.id}`
  const [picked, setPicked] = useState(() => new Set())
  const [printing, setPrinting] = useState(false)
  const togglePick = (v) => setPicked(s => { const n = new Set(s); const k = keyOf(v); n.has(k) ? n.delete(k) : n.add(k); return n })

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

  const chosen = useMemo(() => rows.filter(v => picked.has(keyOf(v))), [rows, picked])

  /* 선택 전표만 한 번에 인쇄 — 고른 것만 슬립으로 펴서 한 장씩 나눠 출력한다.
     printing 이면 목록은 감추고(no-print) 슬립만 남긴다. 인쇄가 끝나면 원래대로. */
  const printSelected = () => {
    if (chosen.length === 0) return toast.push('인쇄할 전표를 선택하세요')
    setPrinting(true)
  }
  useEffect(() => {
    if (!printing) return
    const after = () => setPrinting(false)
    window.addEventListener('afterprint', after)
    const t = setTimeout(() => window.print(), 80)
    return () => { clearTimeout(t); window.removeEventListener('afterprint', after) }
  }, [printing])

  /* 인쇄 전 손보기 — 글자 칸만, 저장 안 함(lib/printEdit.js) */
  const printRef = useRef(null)
  const pe = usePrintEdit(printRef, rows ? rows.length : 0)
  return (
    /* ⚠ report-print — 인쇄 화이트리스트(index.css @media print) 등록용.
       '인쇄 전 손보기'가 있는데 이게 없어서 Ctrl+P 가 백지였다. */
    <div className="fade-up report-print" ref={printRef} onKeyDown={pe.onKeyDown}>
      {/* 선택 인쇄 — 고른 전표만 한 장씩(페이지 나눠) 슬립으로 인쇄한다. 인쇄 중에는 본문을 감춘다. */}
      {printing && (
        <div className="vb-batch">
          {chosen.map((v, i) => (
            <div key={keyOf(v)} className="vb-slip" style={{ pageBreakAfter: i < chosen.length - 1 ? 'always' : 'auto' }}>
              <VoucherSlip v={v}/>
            </div>
          ))}
        </div>
      )}

      <div className={printing ? 'no-print' : undefined}>
      <PageHeader title="전표 목록"
        sub="기간 안의 거래를 차변·대변으로 펼칩니다. 세무사에게 넘기거나 회계 프로그램에 올릴 때 쓰세요."
        actions={<div className="row gap-6 no-print" style={{ alignItems: 'center' }}>
          {/* 같은 돈을 그리드로 — 거래내역과 이 화면은 한 데이터의 두 얼굴이다.
              전에는 서로 오갈 길이 없어 메뉴를 거슬러 올라가야 했다. 기간을 들고 간다. */}
          <button className="btn" onClick={() => goRoute?.('ledger', { range: { from, to } })}>
            <Icon.Wallet size={14}/> 거래내역으로
          </button>
          <PrintEditButton on={pe.on} toggle={pe.toggle} count={pe.count}/>
          <button className="btn" onClick={printSelected} disabled={chosen.length === 0}>
            <Icon.Print size={14}/> 선택 인쇄{chosen.length ? ` (${chosen.length})` : ''}
          </button>
          <button className="btn primary" onClick={download} disabled={busy || rows.length === 0}>
            <Icon.Excel size={14}/> 엑셀 내보내기
          </button>
        </div>}/>

      <div className="card card-pad row no-print" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        {/* 기간은 앱 전체가 같은 모양(DateRangeBar). 전표 목록은 기간이 꼭 있어야 해서 '전체'는 안 낸다 */}
        <DateRangeBar from={from} to={to} all={false} onChange={r => { setFrom(r.from); setTo(r.to) }}/>
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
                <th className="no-print" style={{ width: 34, textAlign: 'center' }}>
                  <input type="checkbox" title="전체 선택"
                    checked={rows.length > 0 && chosen.length === rows.length}
                    onChange={e => setPicked(e.target.checked ? new Set(rows.map(keyOf)) : new Set())}/>
                </th>
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
                <tr><td colSpan={9} style={{ textAlign: 'center', padding: 40, color: 'var(--muted-2)', fontSize: 13 }}>
                  이 기간에 전표가 없어요.
                </td></tr>
              )}
              {/* 전표 순번(vi)으로 줄무늬를 준다 — 행 번호가 아니라 **전표 번호**가 기준이다.
                  한 전표가 여러 줄이라, 행마다 색을 바꾸면 묶음이 보이지 않는다. */}
              {rows.map((v, vi) => (v.lines.length === 0 ? [
                /* ⚠ 줄이 하나도 없는 전표(계좌·계정과목이 둘 다 빔)도 세운다.
                   빼면 화면에서 그 거래가 사라져, 고쳐야 할 대상을 볼 수가 없다. */
                <tr key={v.id} className={`vb-top vb-click ${vi % 2 ? 'vb-alt' : ''}`}
                    onClick={() => openSlip(v)} title="전표 보기">
                  <td className="no-print" style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={picked.has(keyOf(v))} onChange={() => togglePick(v)}/>
                  </td>
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
                <tr key={`${v.id}-${li}`} className={`vb-click ${li === 0 ? 'vb-top' : ''} ${vi % 2 ? 'vb-alt' : ''}`}
                    onClick={() => openSlip(v)} title="전표 보기">
                  {li === 0
                    ? <td className="no-print" rowSpan={v.lines.length} style={{ textAlign: 'center', verticalAlign: 'top' }} onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={picked.has(keyOf(v))} onChange={() => togglePick(v)}/>
                      </td>
                    : null}
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

      </div>{/* /본문(인쇄 시 감춤) */}

      {/* 목록의 한 건을 클릭하면 그 전표를 '전표 모양'으로 띄운다(인쇄 가능). */}
      <VoucherView open={!!slip} voucher={slip} onClose={() => setSlip(null)}/>
    </div>
  )
}
