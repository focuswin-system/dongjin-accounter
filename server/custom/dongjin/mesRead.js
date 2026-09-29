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
async function orderGroups(mes) {
  const [rows] = await mes.query(`
    SELECT * FROM (
    SELECT cont_numb,
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

module.exports = { counts, listClients, clientsByCodes, orderGroups, orderLines }
