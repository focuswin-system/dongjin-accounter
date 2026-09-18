/* 같은 돈이 이미 장부에 있는가 — 정산·지출 처리·반복거래가 **새 거래를 만들기 직전에** 묻는다.
 *
 * 근거의 순서는 **은행이 먼저다.** 통장·엑셀 임포트로 그 입금·지급이 이미 들어와 있는 경우가 흔하다.
 * 그걸 모르고 새로 만들면 같은 돈이 두 번 선다(fowin 실데이터에서 실제로 겹쳤다).
 *
 * (옛 settleInvoiceTxn·openTxnCandidates 는 정기 회차 '기입금 발행'과 소급 마법사만 썼다 —
 *  반복거래로 바뀌며 둘 다 없어져 함께 걷었다. 반복거래는 lib/repeat.js findLookalikes 가 이 함수를 쓴다.)
 */
/** 기준 날짜에서 이만큼 떨어진 거래까지 같은 돈으로 본다(월 반복이 이웃 달을 넘보지 않는 폭) */
const MATCH_WINDOW_DAYS = 20

/**
 * **이 돈이 이미 장부에 있는가.** 정산이 거래를 새로 만들기 직전에 묻는 말이다.
 *
 * '붙일 수 있는 것'(아직 안 붙은 거래)만 보면 부족하다. 이중계상은 붙일 수 없을 때 오히려 더
 * 크게 난다 — 그 입금이 **이미 다른 청구서에 물려 있으면** 후보에서 사라지고, 화면에는
 * '새 거래로 등록'만 남는다. 그대로 누르면 통장 한 줄이 장부 두 줄이 된다
 * (운영 fowin 2026-09-09, 성도건설산업 220만 x 2).
 *
 * 그래서 여기서는 붙일 수 있든 없든 **닮은 거래를 다 찾고, 두 갈래로 나눠 돌려준다.**
 *   open  아직 안 붙었다 → 그 거래에 붙이면 된다(후보 목록에도 실제로 뜬다)
 *   taken 이미 다른 청구서에 물렸다 → 붙일 수 없다. 이 청구서가 중복은 아닌지 봐야 한다
 *
 * ⚠ 날짜는 **창(窓)으로** 본다. 같은 날만 보면 못 잡는다 — 정산 폼의 기본 날짜는 오늘이고
 *   통장에서 올라온 그 입금은 실제 입금일을 달고 있어서, 정확히 같은 날인 경우가 오히려 드물다.
 * ⚠ 이 청구서에 이미 붙은 거래는 뺀다. 100만을 오전·오후로 나눠 넣는 분할 정산은 정상이고,
 *   거기에 대고 "같은 거래가 있어요"를 띄우면 사람은 경고를 읽지 않고 넘기는 법을 배운다.
 */
async function lookalikeSettleTxns(db, { kind, vendorId, amount, date, invoiceId, accountId = null, windowDays = MATCH_WINDOW_DAYS }) {
  if (!db) throw new Error('lookalikeSettleTxns: 테넌트 연결(db)이 필요합니다')
  if (!date || !(Number(amount) > 0)) return { open: [], taken: [] }
  /* ⚠ **거래처 id 가 같아야만** 잡던 시절엔 두 경우를 통째로 놓쳤다(운영 dongjin 2026-09, 축의금 20만 이중 지출):
   *   · 한쪽에 거래처가 비어 있다 — 결의서 직접 작성·통장 임포트는 거래처 없이 들어오기 쉽다
   *   · 같은 이름 거래처가 여러 벌이다 — 한쪽은 A벌, 다른 쪽은 B벌에 붙어 id 가 다르다
   * 그래서 거래처는 **이름이 같은 벌까지** 같은 곳으로 보고, 어느 한쪽이라도 거래처를 모르면
   * **같은 계좌**를 근거로 본다(같은 계좌·같은 금액·가까운 날짜는 거래처 없이도 충분히 수상하다).
   * 둘 다 모르면(거래처도 계좌도 없음) 판정하지 않는다 — 금액·날짜만으로 걸면 경고가 늘 떠서 안 읽힌다. */
  if (!vendorId && !accountId) return { open: [], taken: [] }
  const settled = kind === 'income' ? '입금완료' : '지급완료'
  /* 거래처를 모를 때(같은 계좌로 볼 때)는 날짜 창을 **3일로 좁힌다.** 주거래 통장엔 같은 금액(20만·100만)이
     흔해서, 거래처 없이 20일을 보면 무관한 지출에 경고가 늘 뜨고 사람은 경고를 안 읽게 된다. */
  const ACCOUNT_WINDOW = Math.min(3, windowDays)
  const who = []
  const whoArgs = []
  if (vendorId) {
    who.push(`(t.vendor_id IN (SELECT v2.id FROM vendors v1 JOIN vendors v2 ON TRIM(v2.name) = TRIM(v1.name) WHERE v1.id = ?)
              AND ABS(DATEDIFF(t.date, ?)) <= ?)`)
    whoArgs.push(vendorId, date, windowDays)
  }
  if (accountId) {
    who.push(`(${vendorId ? 't.vendor_id IS NULL AND ' : ''}t.account_id = ? AND ABS(DATEDIFF(t.date, ?)) <= ?)`)
    whoArgs.push(accountId, date, ACCOUNT_WINDOW)
  }
  const [rows] = await db.execute(
    `SELECT t.id, t.date, t.amount, t.memo, v.name AS vendor_name,
            COALESCE(SUM(m.amount), 0) AS used,
            MAX(CASE WHEN m.invoice_id <> ? THEN i.invoice_no END) AS other_no,
            MAX(CASE WHEN m.invoice_id = ? THEN 1 ELSE 0 END) AS mine
       FROM transactions t
       LEFT JOIN vendors v ON v.id = t.vendor_id
       LEFT JOIN invoice_matches m ON m.txn_id = t.id
       LEFT JOIN invoices i ON i.id = m.invoice_id
      WHERE t.kind = ? AND (${who.join(' OR ')}) AND t.amount = ? AND t.status = ?
        AND t.transfer_id IS NULL
      GROUP BY t.id, t.date, t.amount, t.memo, v.name
     HAVING mine = 0
      ORDER BY ABS(DATEDIFF(t.date, ?)), t.date
      LIMIT 3`,
    [invoiceId || '', invoiceId || '', kind, ...whoArgs, Number(amount), settled, date])
  const open = [], taken = []
  for (const r of rows) (Number(r.used) < Number(r.amount) ? open : taken).push(r)
  return { open, taken }
}

/**
 * 위 결과를 사람에게 할 말로 바꾼다 — 라우트마다 문구가 갈리지 않게 여기 둔다.
 * 닮은 거래가 없으면 null(=그냥 만들면 된다).
 */
function dupSettleMessage({ open, taken }, kind) {
  const 돈 = kind === 'income' ? '입금' : '지급'
  const won = (n) => Number(n).toLocaleString('ko-KR')
  if (open.length) {
    const t = open[0]
    // 어느 거래인지 알아볼 수 있게 거래처·적요를 붙인다 — 금액·날짜만으로는 통장에서 못 찾는다
    const what = [t.vendor_name, t.memo].filter(Boolean).join(' · ')
    return `${t.date} 에 같은 ${won(t.amount)}원 ${돈} 거래${what ? `(${what})` : ''}가 이미 있어요.`
         + ` '거래내역에서 연결'로 그 거래에 붙이면 장부가 한 줄로 맞습니다.`
  }
  if (taken.length) {
    const t = taken[0]
    return `${t.date} 의 ${won(t.amount)}원 ${돈}은 이미 청구서 ${t.other_no || '(다른 건)'} 에 물려 있어요.`
         + ` 새로 만들면 같은 돈이 장부에 두 번 섭니다 — 이 청구서가 중복은 아닌지 먼저 확인해주세요.`
  }
  return null
}

module.exports = { lookalikeSettleTxns, dupSettleMessage, MATCH_WINDOW_DAYS }
