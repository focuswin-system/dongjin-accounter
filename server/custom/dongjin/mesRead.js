/**
 * MES 읽기 — **SELECT 만.** (check:isolation [20] 이 이 파일의 SQL 첫 단어를 본다)
 *
 * 표·칸 이름은 운영 MES(winc_dj)에서 2026-09-28 에 실측했다. MES 는 자사 다른 직원이
 * 만드는 중이라 표가 늘고 이름이 바뀐다(운영 구매표는 COERP_PRO_*, 개발 코드는 COERP_PUR_*).
 * 그래서 **여기 한 파일에만** 표 이름을 적는다 — 바뀌면 여기만 고친다.
 *
 * MES 사정:
 *   · bit(1) 은 CAST(... AS UNSIGNED) 로 읽는다(안 그러면 Buffer 가 온다)
 *   · 날짜는 dateStrings 로 'YYYY-MM-DD hh:mm:ss' 글자 그대로 온다(mesDb.js)
 */

/** 연결 확인 + 표 크기. 화면 머리의 '연결됨 · 거래처 121' 표시용 */
async function counts(mes) {
  const [[r]] = await mes.query(`
    SELECT (SELECT COUNT(*) FROM COERP_COM_CLIENTELE)                 AS clients,
           (SELECT COUNT(*) FROM COERP_SAL_ORDER)                     AS order_lines,
           (SELECT COUNT(DISTINCT cont_numb) FROM COERP_SAL_ORDER)    AS order_pos`)
  return { clients: Number(r.clients), orderLines: Number(r.order_lines), orderPos: Number(r.order_pos) }
}

/** 거래처 전부(121곳 수준 — 한 번에 읽는다) */
async function listClients(mes) {
  const [rows] = await mes.query(`
    SELECT clie_code, clie_name, clie_gubu, clie_sano, pres_name,
           addr_knam, addr_deta, tele_numb, faxs_numb,
           bank_name, acco_numb, hold_name, upta_name, jong_moks, taxb_mail, damd_name,
           CAST(enab_yesn AS UNSIGNED) AS enab_yesn,
           COALESCE(modi_date, user_date) AS rev
      FROM COERP_COM_CLIENTELE
     ORDER BY clie_code`)
  return rows
}

/** 몇 개 코드만 — 반영 직전 최신 값을 다시 읽을 때 */
async function clientsByCodes(mes, codes) {
  const list = (codes || []).map(String).filter(Boolean)
  if (!list.length) return []
  const [rows] = await mes.query(`
    SELECT clie_code, clie_name, clie_gubu, clie_sano, pres_name,
           addr_knam, addr_deta, tele_numb, faxs_numb,
           bank_name, acco_numb, hold_name, upta_name, jong_moks, taxb_mail, damd_name,
           CAST(enab_yesn AS UNSIGNED) AS enab_yesn,
           COALESCE(modi_date, user_date) AS rev
      FROM COERP_COM_CLIENTELE
     WHERE clie_code IN (${list.map(() => '?').join(',')})`, list)
  return rows
}

/* 줄마다 단계(1~5)를 매기는 파생 표 — 판정은 **MES 에 남은 기록**으로만 한다.
 *   5 출하완료  MES 가 납품(deli_yesn)을 찍었거나, 출하 수량 합이 수주 수량 이상
 *   4 출하      출하 수량이 조금이라도 있다(COERP_SAL_SHIPITEM)
 *   3 출하대기  살아 있는 출하요청이 있다(COERP_SAL_SHIPREQUEST, RQ)
 *   2 생산      작업지시가 이어졌다(work_numb) — ⚠ 2026-09-28 운영에서 아직 0줄. MES 작업지시가 생기면 채워진다
 *   1 수주      그 밖
 * 규칙은 이 SQL 한 곳에만 둔다(화면은 번호를 받아 이름만 붙인다 — map/order.js). */
const LINES_WITH_STAGE = `
  SELECT o.*,
         COALESCE(sh.qty, 0) AS shipped_qty,
         CASE
           WHEN CAST(o.deli_yesn AS UNSIGNED) = 1 OR (o.orde_qtys > 0 AND COALESCE(sh.qty, 0) >= o.orde_qtys) THEN 5
           WHEN COALESCE(sh.qty, 0) > 0 THEN 4
           WHEN rq.orde_numb IS NOT NULL THEN 3
           WHEN COALESCE(o.work_numb, '') <> '' THEN 2
           ELSE 1
         END AS stage
    FROM COERP_SAL_ORDER o
    LEFT JOIN (SELECT orde_numb, SUM(ship_qtys) AS qty FROM COERP_SAL_SHIPITEM GROUP BY orde_numb) sh
           ON sh.orde_numb = o.orde_numb
    LEFT JOIN (SELECT DISTINCT orde_numb FROM COERP_SAL_SHIPREQUEST
                WHERE requ_stat = 'RQ' AND CAST(enab_yesn AS UNSIGNED) = 1) rq
           ON rq.orde_numb = o.orde_numb`

/**
 * 수주를 원청 PO(cont_numb) 단위로 묶어 읽는다.
 * cont_numb 는 원청의 계약/주문 번호다(현대: 계약번호 / 한화: 주문번호). 줄은 품목 단위.
 * PO 의 단계 = 가장 덜 진행된 줄의 단계(한 줄이라도 남았으면 그 PO 는 아직 거기 있다).
 * 납기 = 출하완료가 아닌 줄 중 가장 이른 납기.
 */
/* 수주일 — MES 에 원청 공통 '수주일' 칸이 없다(2026-09-29 실측):
 *   현대  cont_date(계약일) 100% 채워짐
 *   한화  appr_date(구매오더 최종승인일) 7.5% 만 — 나머지는 user_date(MES 등록일) 밖에 없다
 *   user_date 만 쓰면 MES 도입 전 수주가 전부 일괄 이관일(2026-06/07)로 찍힌다.
 * 그래서 계약일 → 승인일 → 등록일 순으로 있는 것을 쓴다. PO 의 수주일은 품목 중 가장 이른 날. */
const ORDER_DATE = 'DATE(COALESCE(cont_date, appr_date, user_date))'

async function orderGroups(mes) {
  const [rows] = await mes.query(`
    SELECT * FROM (
    SELECT cont_numb,
           MIN(${ORDER_DATE})                            AS order_date,
           MIN(orig_gubu)                                AS orig_gubu,
           MIN(clie_name)                                AS clie_name,
           MIN(proj_numb)                                AS proj_numb,
           MIN(proj_name)                                AS proj_name,
           GROUP_CONCAT(DISTINCT ship_numb ORDER BY ship_numb SEPARATOR ', ') AS ship_numbs,
           COUNT(*)                                      AS line_cnt,
           SUM(stage = 5)                                AS done_cnt,
           MIN(stage)                                    AS stage,
           SUM(CAST(urge_yesn AS UNSIGNED))              AS urgent_cnt,
           SUM(orde_cwon)                                AS amount,
           MIN(CASE WHEN stage < 5 THEN deli_date END)   AS next_due
      FROM (${LINES_WITH_STAGE}) l
     GROUP BY cont_numb
    ) g
     ORDER BY g.next_due IS NULL, g.next_due, g.cont_numb`)
  return rows
}

/** 한 PO 의 줄 — 줄마다 단계와 출하 수량 */
async function orderLines(mes, contNumb) {
  const [rows] = await mes.query(`
    SELECT orde_numb, cont_seri, matl_code, matl_desc, matl_quli,
           orde_qtys, orde_quni, orde_upri, orde_cwon, curr_unit,
           deli_date, ship_numb, bloc_numb, draw_numb, orde_dono,
           shipped_qty, stage,
           CAST(urge_yesn AS UNSIGNED) AS urge_yesn
      FROM (${LINES_WITH_STAGE}) l
     WHERE cont_numb = ?
     ORDER BY cont_seri, orde_numb`, [String(contNumb)])
  return rows
}

/* ── 발주(구매) ── MES 2F 구매발주. 헤더 COERP_PRO_PPRO · 품목 COERP_PRO_PPROITEM · 입고 COERP_MAT_WAREHOUSING
 * 진행 단계는 **MES 가 적은 값(ppro_stat)** 을 그대로 쓴다 — 발주등록 → 승인요청 → 발주완료 → 입고처리 → 입고완료.
 * 수주와 달리 MES 가 단계를 스스로 관리하므로 여기서 다시 판정하지 않는다(두 답이 생긴다).
 * 입고 진척은 품목의 누적 입고수량(rece_qtys) / 발주수량으로 따로 보여 준다. */
async function purchaseOrders(mes) {
  const [rows] = await mes.query(`
    SELECT p.ppro_numb, p.ppro_date, p.clie_code, p.clie_name, p.damd_name, p.pdel_date,
           p.ppro_stat, p.afte_conf, p.pays_cond, p.ppro_usag,
           COUNT(i.ppro_seri)            AS line_cnt,
           MIN(i.matl_name)              AS first_matl,
           SUM(i.ppro_qtys)              AS qty,
           SUM(COALESCE(i.rece_qtys, 0)) AS rece_qty,
           SUM(i.ppro_cwon)              AS amount
      FROM COERP_PRO_PPRO p
      LEFT JOIN COERP_PRO_PPROITEM i ON i.ppro_numb = p.ppro_numb
     GROUP BY p.ppro_numb
     ORDER BY p.ppro_date DESC, p.ppro_numb DESC`)
  return rows
}

/** 한 발주의 품목 + 입고 기록 */
async function purchaseOrderLines(mes, pproNumb) {
  const [items] = await mes.query(`
    SELECT ppro_seri, item_gubu, matl_code, matl_name, matl_spec, puro_unit,
           ppro_qtys, COALESCE(rece_qtys, 0) AS rece_qtys, ppro_pric, ppro_cwon, rece_plac, purs_numb, ppro_memo
      FROM COERP_PRO_PPROITEM WHERE ppro_numb = ? ORDER BY ppro_seri`, [String(pproNumb)])
  const [wares] = await mes.query(`
    SELECT ware_numb, pros_seri, ware_date, ware_qtys, ware_pric, ware_kwon, lots_numb,
           CAST(clos_yesn AS UNSIGNED) AS clos_yesn, CAST(insp_okey AS UNSIGNED) AS insp_okey
      FROM COERP_MAT_WAREHOUSING WHERE pros_numb = ? ORDER BY ware_date, ware_numb`, [String(pproNumb)])
  return { items, wares }
}

module.exports = { counts, listClients, clientsByCodes, orderGroups, orderLines, purchaseOrders, purchaseOrderLines }
