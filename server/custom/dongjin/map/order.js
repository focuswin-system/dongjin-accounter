/**
 * MES 수주 → 단계·납기 — **순수 함수.** 단계 판정 자체는 SQL(mesRead.js LINES_WITH_STAGE) 한 곳에 있고,
 * 여기는 번호에 이름을 붙이고 납기를 가른다.
 *
 * 수주는 회계로 옮기지 않는다(설계 D2) — MES 를 그대로 읽어 계약관리 › 수주 자리에 보여 준다.
 *
 * 단계와 납기는 **다른 축**이다. 단계는 '어디까지 왔나', 납기는 '늦었나'. 예전엔 둘을 한 칸(상태)에
 * 섞어 '납기 지남'이 단계처럼 보였다 — 사용자가 헷갈린다고 했다(2026-09-28).
 */

const STAGES = { 1: '수주', 2: '생산', 3: '출하대기', 4: '출하', 5: '출하완료' }

/** 납기 임박으로 보는 날 수 */
const SOON_DAYS = 14

const dayOf = (s) => (s ? String(s).slice(0, 10) : null)

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** 납기 상태 — 출하완료면 따지지 않는다. 'late' | 'soon' | null */
function dueState(stage, nextDue, today) {
  if (Number(stage) >= 5 || !nextDue) return null
  const due = dayOf(nextDue)
  if (due < today) return 'late'
  if (due <= addDays(today, SOON_DAYS)) return 'soon'
  return null
}

/** 원청 구분 — 화면 필터(전체·한화·현대·기타) */
const origOf = (g) => (g === 'HW' ? 'HW' : g === 'HD' ? 'HD' : 'ETC')

function shapeGroup(g, today) {
  const stage = Number(g.stage) || 1
  return {
    contNumb: g.cont_numb,
    orig: origOf(g.orig_gubu),
    client: g.clie_name,
    projNumb: g.proj_numb,
    projName: g.proj_name,
    orderDate: dayOf(g.order_date),
    ships: g.ship_numbs || '',
    lines: Number(g.line_cnt) || 0,
    doneLines: Number(g.done_cnt) || 0,
    urgent: Number(g.urgent_cnt) || 0,
    amount: Number(g.amount) || 0,
    stage,
    stageLabel: STAGES[stage],
    nextDue: dayOf(g.next_due),
    due: dueState(stage, g.next_due, today),
  }
}

/* ── 발주(구매) ── MES 진행상태(ppro_stat) 순서. 모르는 값이 오면 맨 앞(발주등록)으로 본다 */
const PUR_STAGES = ['발주등록', '승인요청', '발주완료', '입고처리', '입고완료']
const PUR_DONE = '입고완료'

function shapePurchase(p, today) {
  const stageLabel = PUR_STAGES.includes(p.ppro_stat) ? p.ppro_stat : '발주등록'
  const stage = PUR_STAGES.indexOf(stageLabel) + 1
  const lines = Number(p.line_cnt) || 0
  const qty = Number(p.qty) || 0
  const rece = Number(p.rece_qty) || 0
  const done = stageLabel === PUR_DONE
  return {
    pproNumb: p.ppro_numb,
    orderDate: dayOf(p.ppro_date),
    vendorCode: p.clie_code,
    vendor: p.clie_name,
    manager: p.damd_name || '',
    usage: p.ppro_usag || '',
    payCond: p.pays_cond || '',
    // 품목 한 줄 요약 — "BENDING 외 2"
    items: lines ? `${p.first_matl || '품목'}${lines > 1 ? ` 외 ${lines - 1}` : ''}` : '—',
    lines, qty, receQty: rece,
    // 입고 진척(%) — 수량 기준. 발주수량이 없으면 null
    receRate: qty > 0 ? Math.min(100, Math.round((rece / qty) * 100)) : null,
    amount: Number(p.amount) || 0,
    stage, stageLabel,
    approval: p.afte_conf || '',
    deliDate: dayOf(p.pdel_date),
    // 납품일(pdel_date)이 지났는데 입고가 안 끝났으면 늦음 — 수주의 납기와 같은 규칙
    due: done ? null : dueState(1, p.pdel_date, today),
  }
}

module.exports = { STAGES, SOON_DAYS, dueState, shapeGroup, origOf, addDays, PUR_STAGES, PUR_DONE, shapePurchase }
