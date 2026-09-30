/**
 * 발주 — 동진테크는 계약관리 › 발주 자리에 MES 구매발주를 **그대로 읽어** 보여 준다(보기 전용).
 * 발주·승인·입고는 MES(2F)에서 한다 — 이 화면엔 등록 버튼이 없다(App.jsx contract_purchase).
 * 회계로 넘어오는 지점은 발주 목록이 아니라 지출결의서다(설계 D1: 승인된 품의를 결의서로 불러와 지급).
 *
 * 두 축(수주 화면과 같은 규칙):
 *   단계  발주등록 → 승인요청 → 발주완료 → 입고처리 → 입고완료   — MES 가 적은 값 그대로(다시 판정하지 않는다)
 *   입고  받은 수량 / 발주 수량 — 단계와 따로 보인다
 *   납품일이 지났는데 입고가 안 끝났으면 빨강 글자
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

const STAGES = ['발주등록', '승인요청', '발주완료', '입고처리', '입고완료']
const DUE_COLOR = { late: 'var(--neg-ink)', soon: 'var(--warn-ink)' }
const DUE_TITLE = { late: '납품일이 지났는데 입고가 안 끝났어요', soon: '납품일이 14일 안이에요' }

/* 기본 조회기간 — 최근 한 달(30일 전 ~ 오늘). 수주 화면과 같다 */
const daysAgo = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10)
}
const defaultRange = () => { const to = localToday(); return { from: daysAgo(to, 30), to } }
const num = (v) => fmtNum(Math.round(Number(v) || 0))

/* 수량 합계 — **단위가 모두 같을 때만.** EA 와 KG 이 섞이면 더한 값이 뜻이 없다(그땐 '—').
   금액은 단위가 없으니 늘 더한다 */
export const sameUnit = (list, unitKey) => new Set(list.map(l => String(l[unitKey] || '').trim())).size <= 1
export const qtySum = (list, qtyKey, unitKey) => {
  if (!sameUnit(list, unitKey)) return null
  const units = new Set(list.map(l => String(l[unitKey] || '').trim()))
  const sum = list.reduce((a, l) => a + (Number(l[qtyKey]) || 0), 0)
  const unit = [...units][0] || ''
  return `${fmtNum(Math.round(sum * 1000) / 1000)}${unit ? ` ${unit}` : ''}`
}

export const MesPurchasesScreen = () => {
  const [data, setData] = useState(null)        // { rows, summary } | { error }
  const [stage, setStage] = useState('')        // '' = 전체
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(null)
  const [colSlot, setColSlot] = useState(null)
  const [range, setRange] = useState(defaultRange)

  const load = () => {
    setData(null)
    api.mesPurchaseOrders(range).then(setData).catch(e => setData({ error: e.message, code: e.code, status: e.status }))
  }
  useEffect(load, [range.from, range.to])   // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.rows || []
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return rows
      .filter(r => !stage || r.stageLabel === stage)
      .filter(r => !s || [r.pproNumb, r.vendor, r.items, r.manager].some(v => String(v || '').toLowerCase().includes(s)))
  }, [rows, stage, q])
  const stageCount = (l) => rows.filter(r => r.stageLabel === l).length
  const sm = data?.summary || { going: 0, goingAmount: 0, late: 0, waiting: 0 }

  const columns = [
    { key: 'stageLabel', header: '단계', width: 96, sortable: true, sortValue: r => r.stage },
    { key: 'orderDate', header: '발주일', width: 104, sortable: true,
      render: r => <span className="num" style={{ whiteSpace: 'nowrap' }}>{r.orderDate || '—'}</span> },
    { key: 'pproNumb', header: '발주번호', width: 120, sortable: true, render: r => <span className="num">{r.pproNumb}</span> },
    { key: 'vendor', header: '거래처', width: 170, sortable: true, render: r => <span className="truncate">{r.vendor || '—'}</span> },
    { key: 'items', header: '품목', render: r => <span className="truncate">{r.items}</span> },
    { key: 'manager', header: '담당', width: 90, sortable: true, render: r => r.manager || '—' },
    // 입고 — 다 들어왔으면 표시 없이 수량만(정상엔 표식을 달지 않는다)
    { key: 'receRate', header: '입고', width: 110, align: 'right', sortable: true, render: r => (
      <span className="num" title={`${num(r.receQty)} / ${num(r.qty)}`}>
        {r.receRate == null ? '—' : r.receRate >= 100 ? `${num(r.qty)}` : `${num(r.receQty)}/${num(r.qty)}`}
      </span>
    ) },
    { key: 'deliDate', header: '납품일', width: 104, sortable: true, sortValue: r => r.deliDate || '9999',
      render: r => (
        <span className="num" title={DUE_TITLE[r.due] || ''} style={r.due ? { color: DUE_COLOR[r.due], fontWeight: 700 } : undefined}>
          {r.deliDate || '—'}
        </span>
      ) },
    { key: 'approval', header: '결재', width: 72, render: r => r.approval || '—' },
    { key: 'amount', header: '금액', width: 120, align: 'right', sortable: true,
      render: r => <span className="num fw-700">{num(r.amount)}</span> },
  ]

  return (
    <div className="fade-up">
      <PageHeader title="발주" sub="MES 구매발주를 봅니다 · 발주·입고는 MES 에서"
        actions={<button className="btn" onClick={load}><Icon.Refresh size={14}/> 새로고침</button>}/>

      <MesGate data={data} onRetry={load}>
        {/* 위 카드는 기간과 무관한 **지금 전체**(서버 summary) — 수주 화면과 같은 규칙 */}
        <KpiRow cols={4} style={{ marginBottom: 16 }}>
          <Kpi label="진행 중인 발주 · 전체" value={sm.going} unit="건"/>
          <Kpi label="진행 중 금액 · 전체" value={Math.round(sm.goingAmount)}/>
          <Kpi label="입고 기다림 · 전체" value={sm.waiting} unit="건"/>
          <Kpi label="납품일 지남 · 전체" value={sm.late} unit="건" tone={sm.late ? 'neg' : undefined}/>
        </KpiRow>

        <div className="card">
          <TableToolbar
            date={{ from: range.from, to: range.to, onChange: setRange }}
            search={{ value: q, onChange: setQ, placeholder: '발주번호·거래처·품목·담당 검색' }}/>
          <div className="row gap-8" style={{ padding: '0 16px 10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div className="seg" role="tablist" aria-label="단계">
              <button role="tab" aria-selected={!stage} className={`seg-btn ${!stage ? 'active' : ''}`} onClick={() => setStage('')}>
                전체<span className="seg-count">{rows.length}</span>
              </button>
              {STAGES.map(l => (
                <button key={l} role="tab" aria-selected={stage === l}
                  className={`seg-btn ${stage === l ? 'active' : ''}`} onClick={() => setStage(l)}>
                  {l}<span className="seg-count">{stageCount(l)}</span>
                </button>
              ))}
            </div>
            <span ref={setColSlot} className="dt-colbar-inline ml-auto"/>
          </div>
          <DataTable tableKey="mes_purchases" colBarIn={colSlot} columns={columns} rows={shown} rowKey={r => r.pproNumb} pageSize={50}
            loading={!data} onRowClick={setOpen} empty="조건에 맞는 발주가 없어요"
            footer={shown.length > 0 && (
              <tr>
                <td colSpan={columns.length - 1} className="text-sm text-muted">{fmtNum(shown.length)}건</td>
                <td className="num num-right fw-700">{num(shown.reduce((a, r) => a + r.amount, 0))}</td>
              </tr>
            )}/>
        </div>
      </MesGate>

      <PurchaseLinesDrawer po={open} onClose={() => setOpen(null)}/>
    </div>
  )
}

/* 한 발주의 품목과 입고 기록 — 무엇을 얼마에 시켰고, 언제 얼마나 들어왔나 */
const PurchaseLinesDrawer = ({ po, onClose }) => {
  const [d, setD] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!po) return
    let alive = true
    setD(null); setError('')
    api.mesPurchaseOrderLines(po.pproNumb)
      .then(r => { if (alive) setD(r) })
      .catch(e => { if (alive) { setD({ items: [], wares: [] }); setError(e.message || 'MES 에서 발주를 읽지 못했어요') } })
    return () => { alive = false }
  }, [po])

  const itemCols = [
    { key: 'matl', header: '품명·규격', render: l => (
      <>{l.matl_name || '—'}<Sub>{[l.matl_code, l.matl_spec].filter(Boolean).join(' · ')}</Sub></>
    ) },
    { key: 'qty', header: '발주', width: 90, align: 'right', render: l => <span className="num">{num(l.ppro_qtys)}{l.puro_unit ? ` ${l.puro_unit}` : ''}</span> },
    { key: 'rece', header: '입고', width: 80, align: 'right', render: l => {
      const short = Number(l.rece_qtys) < Number(l.ppro_qtys)
      return <span className="num" style={short ? { color: 'var(--warn-ink)', fontWeight: 700 } : undefined}>{num(l.rece_qtys)}</span>
    } },
    { key: 'price', header: '단가', width: 100, align: 'right', render: l => <span className="num">{num(l.ppro_pric)}</span> },
    { key: 'amount', header: '금액', width: 110, align: 'right', render: l => <span className="num fw-700">{num(l.ppro_cwon)}</span> },
  ]
  const wareCols = [
    { key: 'ware_numb', header: '입고번호', width: 120, render: w => <span className="num">{w.ware_numb}</span> },
    { key: 'ware_date', header: '입고일', width: 104, render: w => <span className="num">{String(w.ware_date || '').slice(0, 10)}</span> },
    { key: 'seri', header: '품목 순번', width: 80, render: w => <span className="num">{w.pros_seri}</span> },
    { key: 'qty', header: '수량', width: 80, align: 'right', render: w => <span className="num">{num(w.ware_qtys)}</span> },
    { key: 'amount', header: '금액', width: 110, align: 'right', render: w => <span className="num fw-700">{num(w.ware_kwon)}</span> },
    // 매입마감 — MES 가 매입을 마감했나(세금계산서로 넘어갈 준비). 미마감은 흐린 글자로
    { key: 'clos', header: '매입마감', width: 84, render: w => (w.clos_yesn ? '마감' : <span className="text-muted">미마감</span>) },
  ]

  return (
    <Drawer open={!!po} onClose={onClose} size="lg" confirmClose={false} label="발주 품목">
      {po && (
        <>
          <DrawerHead onClose={onClose} title={`${po.pproNumb} · ${po.vendor || ''}`}
            sub={`${po.stageLabel} · 발주 ${po.orderDate || '—'}${po.deliDate ? ` · 납품 ${po.deliDate}` : ''} · ${num(po.amount)}원 · 결재 ${po.approval || '—'}`}/>
          <div className="drawer-body col gap-16">
            {!d ? <Loading/> : (
              <>
                {po.usage && <div className="text-sm"><span className="text-muted">용도</span> {po.usage}</div>}
                <section>
                  <div className="txo-label">품목 {d.items.length > 0 && <span className="num text-muted2">{d.items.length}</span>}</div>
                  <DataTable columns={itemCols} rows={d.items} rowKey={l => l.ppro_seri} empty={error || '품목이 없어요'}
                    footer={d.items.length > 0 && (
                      <tr>
                        <td className="text-sm text-muted">합계 {fmtNum(d.items.length)}품목</td>
                        <td className="num num-right fw-700">{qtySum(d.items, 'ppro_qtys', 'puro_unit') ?? '—'}</td>
                        <td className="num num-right fw-700">{qtySum(d.items, 'rece_qtys', 'puro_unit') ?? '—'}</td>
                        <td/>
                        <td className="num num-right fw-700">{num(d.items.reduce((a, l) => a + (Number(l.ppro_cwon) || 0), 0))}</td>
                      </tr>
                    )}/>
                </section>
                <section>
                  <div className="txo-label">입고 {d.wares.length > 0 && <span className="num text-muted2">{d.wares.length}</span>}</div>
                  <DataTable columns={wareCols} rows={d.wares} rowKey={w => w.ware_numb} empty={error || '입고 내역이 없어요'}
                    footer={d.wares.length > 0 && (
                      <tr>
                        <td colSpan={3} className="text-sm text-muted">합계 {fmtNum(d.wares.length)}건</td>
                        {/* 입고 기록엔 단위 칸이 없다 — 품목이 한 단위일 때만 수량을 더한다 */}
                        <td className="num num-right fw-700">{sameUnit(d.items, 'puro_unit')
                          ? num(d.wares.reduce((a, w) => a + (Number(w.ware_qtys) || 0), 0)) : '—'}</td>
                        <td className="num num-right fw-700">{num(d.wares.reduce((a, w) => a + (Number(w.ware_kwon) || 0), 0))}</td>
                        <td className="text-sm">마감 <span className="num">{d.wares.filter(w => w.clos_yesn).length}/{d.wares.length}</span></td>
                      </tr>
                    )}/>
                </section>
                <div className="text-xs text-muted">발주·입고의 등록·수정은 MES 에서 해요.</div>
              </>
            )}
          </div>
        </>
      )}
    </Drawer>
  )
}
