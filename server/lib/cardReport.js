/**
 * 카드 사용내역 — 카드별로 **얼마를 썼고 얼마를 갚았나**.
 *
 * ── 왜 필요한가 ──
 * 데이터는 여태 다 있었다(카드 계좌에 달린 지출이 곧 사용 기록이다). 그런데 **넘길 문서**가
 * 없었다. 거래내역에서 계좌로 걸러 화면으로 보는 것과, 감사·세무사에게 한 장으로 내미는
 * 것은 다른 일이다. 차입금 현황 보고서를 만든 이유와 같다.
 *
 * ── '법인카드 기록부'가 아니라 '카드 사용내역'인 이유 ──
 * 중소기업은 **대표 개인 명의 카드로 회사 돈을 쓰는 일이 흔하다**(그래서 accounts.owner 가
 * 있다). 법인카드만 다루면 개인 명의 사용분은 여전히 낼 문서가 없다.
 * 전부 담고 **거르는 축**을 준다 — 법인만 뽑으면 그게 법인카드 사용 기록부다.
 *
 * ⚠ 쓴 돈과 **갚은 돈**을 한 장에 담는다. 사용액만 있으면 "그래서 얼마가 통장에서
 *   나갔나"를 알 수 없다. 결제는 계좌 간 이체로 들어온다(카드 계좌의 income + transfer_id)
 *   — routes/transactions.js 의 이체가 그렇게 남긴다.
 */

const num = (v) => Number(v) || 0

/** 소유·종류를 사람 말로 — 화면·엑셀이 같은 말을 쓰게 한 곳에 둔다 */
const ownerLabel = (o) => (o === 'personal' ? '대표 개인' : '법인')
const typeLabel = (t) => (t === 'check' ? '체크' : '신용')

/**
 * @param db     req.db (테넌트 풀)
 * @param from   'YYYY-MM-DD' (빈 값 = 처음부터)
 * @param to     'YYYY-MM-DD' (빈 값 = 끝까지)
 * @param owner  'all' | 'corp' | 'personal'
 * @param cardType 'all' | 'credit' | 'check'
 * @param cardId 특정 카드 한 장만
 */
async function cardReport(db, { from = '', to = '', owner = 'all', cardType = 'all', cardId = null } = {}) {
  const where = ["kind = 'card'"]
  const params = []
  if (owner === 'corp' || owner === 'personal') { where.push('owner = ?'); params.push(owner) }
  if (cardType === 'credit' || cardType === 'check') { where.push('card_type = ?'); params.push(cardType) }
  if (cardId) { where.push('id = ?'); params.push(cardId) }

  const [cards] = await db.execute(
    `SELECT id, name, bank, \`number\`, owner, card_type, card_pay_day, card_pay_account_id
       FROM accounts WHERE ${where.join(' AND ')} ORDER BY owner, name`, params)
  if (!cards.length) return { from, to, cards: [], totals: { used: 0, paid: 0, count: 0, no_evidence: 0 } }

  const ids = cards.map(c => c.id)
  const ph = ids.map(() => '?').join(',')

  /* 기간은 **양쪽 다 선택**이다. 보고서 기간 필터의 '전체'가 빈 값을 주므로,
     비었을 때 이번 달로 슬쩍 좁히면 화면에 적힌 기간과 숫자가 어긋난다. */
  const span = []
  const spanParams = []
  if (from) { span.push('AND t.date >= ?'); spanParams.push(from) }
  if (to) { span.push('AND t.date <= ?'); spanParams.push(to) }
  const spanSql = span.join(' ')

  /* 사용 — 카드 계좌에 달린 **지출**. 이체(transfer_id)는 뺀다. 그건 쓴 돈이 아니라
     갚은 돈이고, 방향도 반대다(카드로 들어온다). */
  const [used] = await db.execute(
    `SELECT t.id, t.account_id, t.date, t.amount, t.category, t.memo, t.evid_url, t.evid_ok,
            v.name AS vendor_name
       FROM transactions t
       LEFT JOIN vendors v ON v.id = t.vendor_id
      WHERE t.account_id IN (${ph}) AND t.kind = 'expense' AND t.transfer_id IS NULL
        ${spanSql}
      ORDER BY t.date, t.id`, [...ids, ...spanParams])

  /* 결제 — 통장에서 카드로 옮겨진 돈. 계좌 간 이체의 **받는 쪽 다리**다. */
  const [paid] = await db.execute(
    `SELECT t.id, t.account_id, t.date, t.amount, t.memo, a.name AS from_name
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.counterparty_account_id
      WHERE t.account_id IN (${ph}) AND t.kind = 'income' AND t.transfer_id IS NOT NULL
        ${spanSql}
      ORDER BY t.date, t.id`, [...ids, ...spanParams])

  const payAcctIds = [...new Set(cards.map(c => c.card_pay_account_id).filter(Boolean))]
  const payNames = new Map()
  if (payAcctIds.length) {
    const [rows] = await db.execute(
      `SELECT id, name FROM accounts WHERE id IN (${payAcctIds.map(() => '?').join(',')})`, payAcctIds)
    rows.forEach(r => payNames.set(r.id, r.name))
  }

  const out = cards.map(c => {
    const lines = used.filter(u => u.account_id === c.id).map(u => ({
      id: u.id, date: u.date, amount: num(u.amount),
      vendor: u.vendor_name || '', category: u.category || '', memo: u.memo || '',
      // 증빙 — 파일이 붙었거나 '확인' 체크가 됐으면 챙긴 것으로 본다(lib/evidence.js 와 같은 규칙)
      evidence: !!(String(u.evid_url || '').trim() || u.evid_ok),
    }))
    const pays = paid.filter(p => p.account_id === c.id).map(p => ({
      id: p.id, date: p.date, amount: num(p.amount), from: p.from_name || '', memo: p.memo || '',
    }))
    return {
      id: c.id,
      name: c.name,
      bank: c.bank || '',
      number: c.number || '',
      owner: c.owner === 'personal' ? 'personal' : 'corp',
      owner_label: ownerLabel(c.owner),
      card_type: c.card_type === 'check' ? 'check' : 'credit',
      type_label: typeLabel(c.card_type),
      /* 체크카드는 결제일이 없다 — 쓴 즉시 통장에서 빠진다. 0 을 '1일'처럼 보이게 두면
         있지도 않은 결제일을 문서에 적게 된다. */
      pay_day: c.card_type === 'check' ? 0 : num(c.card_pay_day),
      pay_account: c.card_type === 'check' ? '' : (payNames.get(c.card_pay_account_id) || ''),
      lines,
      payments: pays,
      used_total: lines.reduce((s, l) => s + l.amount, 0),
      paid_total: pays.reduce((s, p) => s + p.amount, 0),
      count: lines.length,
      // 증빙을 못 챙긴 건수 — 감사에서 먼저 묻는 숫자다
      no_evidence: lines.filter(l => !l.evidence).length,
    }
  })

  return {
    from, to,
    cards: out,
    totals: {
      used: out.reduce((s, c) => s + c.used_total, 0),
      paid: out.reduce((s, c) => s + c.paid_total, 0),
      count: out.reduce((s, c) => s + c.count, 0),
      no_evidence: out.reduce((s, c) => s + c.no_evidence, 0),
    },
  }
}

module.exports = { cardReport, ownerLabel, typeLabel }
