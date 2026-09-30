/**
 * 수주 — 동진테크는 계약관리 › 수주 자리에 MES 수주를 **그대로 읽어** 보여 준다(보기 전용, 회계로 옮기지 않는다).
 * 등록·수정은 MES 에서만 한다 — 그래서 이 화면에는 등록 버튼이 없다(App.jsx contract_sales).
 *
 * 두 축을 **따로** 보여 준다(2026-09-28 사용자: "납품·긴급·다음 납기가 헷갈린다"):
 *   단계  수주 → 생산 → 출하대기 → 출하 → 출하완료   '어디까지 왔나'
 *   납기  늦었나(빨강 글자)·곧인가(주황 글자)          '늦었나'
 * 단계 판정은 서버(custom/dongjin/mesRead.js) 한 곳 — 화면은 다시 계산하지 않는다.
 *
 * 고객사 전용 모듈(custom:dongjin_mes). 설계: dongjin-custom-module.design.md
 */
import { useState, useEffect, useMemo } from 'react'
import { Icon, fmtNum, Loading, Drawer, localToday } from '../../lib/ui'
import { PageHeader } from '../../lib/components/PageHeader'
import { DataTable, Sub } from '../../lib/components/DataTable'
import { TableToolbar } from '../../lib/components/TableToolbar'
import { Kpi, KpiRow } from '../../lib/components/Kpi'
import { DrawerHead } from '../../lib/components/Drawer'
import { api } from '../../lib/api'
import { MesGate } from './MesGate'
import { qtySum } from './MesPurchases'

const ORIGS = [['', '전체'], ['HW', '한화'], ['HD', '현대'], ['ETC', '기타']]
const ORIG_LABEL = { HW: '한화', HD: '현대', ETC: '기타' }
const STAGES = [[1, '수주'], [2, '생산'], [3, '출하대기'], [4, '출하'], [5, '출하완료']]

/* 납기는 글자색으로만 — 따로 칸·배지를 세우면 단계와 또 섞인다 */
const DUE_COLOR = { late: 'var(--neg-ink)', soon: 'var(--warn-ink)' }
const DUE_TITLE = { late: '납기가 지났어요', soon: '납기가 14일 안이에요' }

/* 기본 조회기간 — 최근 한 달(30일 전 ~ 오늘). 2026-09-29 사용자: PO 가 수백 건이라 전부 펼치면 끝없이 내려간다 */
const daysAgo = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d - n))
  return t.toISOString().slice(0, 10)
}
const defaultRange = () => { const to = localToday(); return { from: daysAgo(to, 30), to } }

export const MesOrdersScreen = () => {
  const [data, setData] = useState(null)       // { today, rows } | { error }
  const [stage, setStage] = useState(0)        // 0 = 전체
  const [orig, setOrig] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(null)
  const [colSlot, setColSlot] = useState(null) // '열 설정' 버튼을 단계 줄에 앉힌다(표 위 빈 줄을 없앤다)
  const [range, setRange] = useState(defaultRange)   // 수주일 기간(서버가 거른다)

  const load = () => {
    setData(null)
    api.mesOrders(range).then(setData).catch(e => setData({ error: e.message, code: e.code, status: e.status }))
  }
  useEffect(load, [range.from, range.to])   // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.rows || []
  const byOrig = useMemo(() => (orig ? rows.filter(r => r.orig === orig) : rows), [rows, orig])
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return byOrig
      .filter(r => !stage || r.stage === stage)
      .filter(r => !s || [r.contNumb, r.projNumb, r.projName, r.ships].some(v => String(v || '').toLowerCase().includes(s)))
  }, [byOrig, stage, q])

  const stageCount = (n) => byOrig.filter(r => r.stage === n).length
  const sumOf = (list) => list.reduce((a, r) => a + r.amount, 0)
  /* 위 카드는 **기간과 무관한 지금 전체**(서버 summary) — 기간으로 자르면 오래된 지연 PO 가 카드에서 사라진다 */
  const sm = data?.summary || { going: 0, goingAmount: 0, late: 0, soon: 0 }

  const columns = [
    { key: 'stage', header: '단계', width: 130, sortable: true, render: r => (
      <>
        {r.stageLabel}
        {/* 일부 품목만 끝난 PO — 단계는 가장 덜 된 품목 기준이라, 나머지가 얼마나 왔는지 알려 준다 */}
        {r.doneLines > 0 && r.doneLines < r.lines && <Sub>{fmtNum(r.doneLines)}/{fmtNum(r.lines)} 완료</Sub>}
      </>
    ) },
    { key: 'orderDate', header: '수주일', width: 104, sortable: true,
      render: r => <span className="num" style={{ whiteSpace: 'nowrap' }}>{r.orderDate || '—'}</span> },
    { key: 'orig', header: '원청', width: 64, render: r => ORIG_LABEL[r.orig] || '—' },
    { key: 'contNumb', header: 'PO 번호', width: 150, sortable: true, render: r => (
      <span className="row gap-6" style={{ alignItems: 'center' }}>
        <span className="num">{r.contNumb}</span>
        {r.urgent > 0 && <span className="badge warn" title="원청이 긴급 요청한 품목이 있어요">긴급</span>}
      </span>
    ) },
    { key: 'proj', header: '공사·호선', render: r => (
      <>{r.projName || r.projNumb || '—'}<Sub>{r.ships}</Sub></>
    ) },
    { key: 'lines', header: '품목', width: 72, align: 'right', sortable: true,
      render: r => <span className="num">{fmtNum(r.lines)}</span> },
    { key: 'nextDue', header: '납기', width: 110, sortable: true, sortValue: r => r.nextDue || '9999',
      render: r => (
        <span className="num" title={DUE_TITLE[r.due] || ''}
          style={r.due ? { color: DUE_COLOR[r.due], fontWeight: 700 } : undefined}>
          {r.stage >= 5 ? '—' : (r.nextDue || '—')}
        </span>
      ) },
    { key: 'amount', header: '금액', width: 130, align: 'right', sortable: true,
      render: r => <span className="num fw-700">{fmtNum(Math.round(r.amount))}</span> },
  ]

  return (
    <div className="fade-up">
      <PageHeader title="수주" sub="MES 수주를 봅니다 · 등록·수정은 MES 에서"
        actions={<button className="btn" onClick={load}><Icon.Refresh size={14}/> 새로고침</button>}/>

      <MesGate data={data} onRetry={load}>
        <KpiRow cols={4} style={{ marginBottom: 16 }}>
          <Kpi label="진행 중인 PO · 전체" value={sm.going} unit="건"/>
          <Kpi label="진행 중 금액 · 전체" value={Math.round(sm.goingAmount)}/>
          <Kpi label="납기 지남 · 전체" value={sm.late} unit="건" tone={sm.late ? 'neg' : undefined}/>
          <Kpi label="납기 14일 안 · 전체" value={sm.soon} unit="건" tone={sm.soon ? 'warn' : undefined}/>
        </KpiRow>

        <div className="card">
          <TableToolbar
            date={{ from: range.from, to: range.to, onChange: setRange }}
            search={{ value: q, onChange: setQ, placeholder: 'PO 번호·공사·호선 검색' }}
            right={
              <div className="seg" role="tablist" aria-label="원청">
                {ORIGS.map(([k, l]) => (
                  <button key={k || 'all'} role="tab" aria-selected={orig === k}
                    className={`seg-btn ${orig === k ? 'active' : ''}`} onClick={() => setOrig(k)}>{l}</button>
                ))}
              </div>
            }/>
          <div className="row gap-8" style={{ padding: '0 16px 10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div className="seg" role="tablist" aria-label="단계">
              <button role="tab" aria-selected={stage === 0}
                className={`seg-btn ${stage === 0 ? 'active' : ''}`} onClick={() => setStage(0)}>
                전체<span className="seg-count">{byOrig.length}</span>
              </button>
              {STAGES.map(([n, l]) => (
                <button key={n} role="tab" aria-selected={stage === n}
                  className={`seg-btn ${stage === n ? 'active' : ''}`} onClick={() => setStage(n)}>
                  {l}<span className="seg-count">{stageCount(n)}</span>
                </button>
              ))}
            </div>
            <span ref={setColSlot} className="dt-colbar-inline ml-auto"/>
          </div>
          <DataTable tableKey="mes_orders" colBarIn={colSlot} columns={columns} rows={shown} rowKey={r => r.contNumb} pageSize={50}
            loading={!data} onRowClick={setOpen} empty="조건에 맞는 수주가 없어요"
            footer={shown.length > 0 && (
              <tr>
                <td colSpan={columns.length - 1} className="text-sm text-muted">{fmtNum(shown.length)}건</td>
                <td className="num num-right fw-700">{fmtNum(Math.round(sumOf(shown)))}</td>
              </tr>
            )}/>
        </div>
      </MesGate>

      <OrderLinesDrawer group={open} onClose={() => setOpen(null)}/>
    </div>
  )
}

const OrderLinesDrawer = ({ group, onClose }) => {
  const [lines, setLines] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!group) return
    let alive = true   // 다른 PO 를 빨리 열면 앞 응답이 늦게 와 덮는다
    setLines(null); setError('')
    api.mesOrderLines(group.contNumb)
      .then(r => { if (alive) setLines(r.lines || []) })
      // 실패를 '품목이 없어요'로 보이면 MES 가 멈춘 걸 모른다
      .catch(e => { if (alive) { setLines([]); setError(e.message || 'MES 에서 품목을 읽지 못했어요') } })
    return () => { alive = false }
  }, [group])

  const columns = [
    { key: 'matl', header: '품명·규격', render: l => (
      <>{l.matl_desc || '—'}<Sub>{[l.matl_code, l.matl_quli].filter(Boolean).join(' · ')}</Sub></>
    ) },
    { key: 'stage', header: '단계', width: 84, render: l => l.stage_label },
    { key: 'qty', header: '수량', width: 100, align: 'right', render: l => {
      const q = Number(l.orde_qtys) || 0
      const s = Number(l.shipped_qty) || 0
      return (
        <span className="num" title={s > 0 && s < q ? '출하 수량 / 수주 수량' : ''}>
          {/* 출하가 일부만 됐을 때만 '출하/수주' 로 — 나머지는 수주 수량 하나 */}
          {s > 0 && s < q ? `${fmtNum(s)}/` : ''}{fmtNum(q)}{l.orde_quni ? ` ${l.orde_quni}` : ''}
        </span>
      )
    } },
    { key: 'due', header: '납기', width: 104, render: l => <span className="num">{String(l.deli_date || '').slice(0, 10) || '—'}</span> },
    { key: 'amt', header: '금액', width: 110, align: 'right',
      render: l => <span className="num">{fmtNum(Math.round(Number(l.orde_cwon) || 0))}</span> },
  ]

  return (
    <Drawer open={!!group} onClose={onClose} width="min(780px, 100vw)" confirmClose={false}>
      {group && (
        <>
          <DrawerHead onClose={onClose} title={`PO ${group.contNumb}`}
            sub={[ORIG_LABEL[group.orig], group.projName || group.projNumb, group.ships].filter(Boolean).join(' · ')}/>
          <div className="drawer-body">
            <KpiRow cols={3} style={{ marginBottom: 12 }}>
              <Kpi size="sm" label="단계" value={group.stageLabel} unit=""/>
              <Kpi size="sm" label="출하완료" value={`${fmtNum(group.doneLines)} / ${fmtNum(group.lines)}`} unit="품목"/>
              <Kpi size="sm" label="금액" value={Math.round(group.amount)}/>
            </KpiRow>
            {!lines ? <Loading/> : (
              <DataTable columns={columns} rows={lines} rowKey={l => l.orde_numb} empty={error || '품목이 없어요'}
                footer={lines.length > 0 && (
                  <tr>
                    <td colSpan={2} className="text-sm text-muted">합계 {fmtNum(lines.length)}품목</td>
                    <td className="num num-right fw-700">{qtySum(lines, 'orde_qtys', 'orde_quni') ?? '—'}</td>
                    <td/>
                    <td className="num num-right fw-700">{fmtNum(Math.round(lines.reduce((a, l) => a + (Number(l.orde_cwon) || 0), 0)))}</td>
                  </tr>
                )}/>
            )}
          </div>
        </>
      )}
    </Drawer>
  )
}
