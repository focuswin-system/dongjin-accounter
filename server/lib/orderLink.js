/**
 * 주문 없이 남은 것들을 모아, **어느 주문에 붙일지** 짝지어 준다.
 *
 * ── 왜 필요한가 ──
 * 등록할 때 주문을 묻지만(screens/Form.jsx·Billing.jsx) 저장을 막지는 않는다 —
 * 막으면 사람들은 '2026년 기타' 같은 더미 주문을 만들어 통과하고, 그러면 데이터는
 * 채워지는데 원가율이 거짓말을 한다. 그래서 '없이 등록'을 열어 뒀다.
 * 대신 그렇게 빠져나간 것을 **나중에 몰아서 회수**할 자리가 있어야 한다. 여기다.
 *
 * ── 대사(lib/reconcile.js)와 무엇이 다른가 ──
 * 저쪽은 "이 돈이 어느 **청구서**를 갚았나"(금액이 축, 부분 정산 있음).
 * 여기는 "이 건이 어느 **주문**의 것인가"(귀속, 부분 없음).
 * 그래서 판정 기준도 다르다 — 금액이 아니라 **거래처와 시기**가 축이다.
 *   한 주문에 여러 건이 붙는 게 정상이라(월별 청구·분할 지급) 금액 일치는 뜻이 약하고,
 *   오히려 "그 기간에 그 거래처와의 주문이 이것뿐"이 가장 강한 단서다.
 *
 * ⚠ 제시만 한다. 붙이는 건 사람이 한다.
 */

/** 날짜가 주문 기간 안에 드나. 종료일이 없으면(무기한) 시작일 이후면 참. */
function inTerm(date, start, end) {
  const d = String(date || '').slice(0, 10)
  if (!d) return false
  const s = String(start || '').slice(0, 10)
  const e = String(end || '').slice(0, 10)
  if (s && d < s) return false
  if (e && d > e) return false
  return true
}

/* 기간에서 얼마나 벗어났나(일). 안에 들면 0.
   ⚠ 기간 밖이어도 후보로는 낸다 — 늦게 등록한 건, 마무리 정산처럼 며칠~몇 달 벗어나는 일은
     흔하다. 다만 **너무 멀면 후보가 아니다.** 실측에서 2020년에 끝난 주문이 2026년 청구서의
     후보로 5건이나 올라왔다(6년 차이). 그건 제시가 아니라 잡음이다. */
function daysOutside(date, start, end) {
  const d = String(date || '').slice(0, 10)
  const s = String(start || '').slice(0, 10)
  const e = String(end || '').slice(0, 10)
  const day = (a, b) => Math.round((Date.parse(a + 'T00:00:00') - Date.parse(b + 'T00:00:00')) / 86400000)
  if (s && d < s) return Math.abs(day(s, d))
  if (e && d > e) return Math.abs(day(d, e))
  return 0
}

/* 기간에서 이만큼 넘게 벗어나면 후보로 안 낸다(약 1년). 그 정도면 다른 주문이거나
   주문이 없는 건이지, 이 주문의 것일 리 없다. */
const OUT_LIMIT_DAYS = 365

/**
 * @param db    테넌트 연결(req.db)
 * @param kind  'income'(매출 — 수주) | 'expense'(매입 — 발주)
 * @returns { rows, txnCount, invoiceCount }
 *          rows = [{ type:'invoice'|'txn', id, date, amount, vendor, label, best, others }]
 */
async function linkCandidates(db, kind) {
  const isIncome = kind === 'income'
  const gubu = isIncome ? ["B"] : ['A', 'E']

  /* 후보 주문 — 이 종류(수주/발주)의 것만. 거래처 없는 주문은 붙일 근거가 없어 뺀다. */
  const [conRows] = await db.execute(`
    SELECT c.id, c.name, c.vendor_id, c.start_date, c.end_date, c.status, c.amount,
           v.name AS vendor_name, v.gubu
      FROM contracts c JOIN vendors v ON v.id = c.vendor_id
     WHERE v.gubu ${isIncome ? "= 'B'" : "IN ('A','E')"}
       AND (c.status IS NULL OR c.status <> '완료')
     ORDER BY c.start_date DESC
     LIMIT 500`)
  if (!conRows.length) return { rows: [], txnCount: 0, invoiceCount: 0, contractCount: 0 }

  const byVendor = new Map()
  for (const c of conRows) {
    if (!byVendor.has(c.vendor_id)) byVendor.set(c.vendor_id, [])
    byVendor.get(c.vendor_id).push(c)
  }

  /* 주문 없는 청구서. 매출이면 issued, 매입이면 received.
     ⚠ 거래처가 없으면 붙일 수 없다 — 주문은 '누구와의 약속'이라 거래처가 뼈대다. */
  const [invRows] = await db.execute(`
    SELECT i.id, i.invoice_no, i.issued_at AS date, i.total_amount AS amount, i.vendor_id, i.memo,
           v.name AS vendor_name
      FROM invoices i JOIN vendors v ON v.id = i.vendor_id
     WHERE i.kind = ? AND (i.contract_id IS NULL OR i.contract_id = '')
     ORDER BY i.issued_at DESC
     LIMIT 200`, [isIncome ? 'issued' : 'received'])

  /* 주문 없는 거래. 원가 귀속(cost_contract_id)만 골라도 '밝힌 것'이므로 뺀다.
     정산으로 생긴 거래(invoice_id 있음)는 청구서 쪽에서 다루므로 여기서 또 세지 않는다 —
     같은 건이 두 줄로 보이면 어느 쪽을 눌러야 할지 알 수 없다. */
  const [txnRows] = await db.execute(`
    SELECT t.id, t.date, t.amount, t.vendor_id, t.category, t.memo, v.name AS vendor_name
      FROM transactions t JOIN vendors v ON v.id = t.vendor_id
     WHERE t.kind = ?
       AND (t.contract_id IS NULL OR t.contract_id = '')
       AND (t.cost_contract_id IS NULL OR t.cost_contract_id = '')
       AND (t.invoice_id IS NULL OR t.invoice_id = '')
       AND (t.payroll_id IS NULL OR t.payroll_id = '')
     ORDER BY t.date DESC
     LIMIT 200`, [kind])

  /** 한 건에 대해 붙일 만한 주문을 점수 순으로 */
  const pick = (vendorId, date) => {
    const pool = byVendor.get(vendorId) || []
    if (!pool.length) return []
    return pool
      .map(c => {
        const why = ['거래처 같음']
        let score = 40
        const out = daysOutside(date, c.start_date, c.end_date)
        if (out === 0) { score += 40; why.push('주문 기간 안') }
        else if (out > OUT_LIMIT_DAYS) return null      // 너무 멀다 — 후보가 아니다
        else {
          // 조금 벗어난 건 후보로 내되, 얼마나 벗어났는지 밝힌다(사람이 판단할 근거)
          score += Math.max(0, 20 - Math.round(out / 15))
          why.push(out > 60 ? `기간에서 ${Math.round(out / 30)}개월 벗어남` : `기간에서 ${out}일 벗어남`)
        }
        // 진행 중인 주문이 끝난 주문보다 그럴듯하다
        if (c.status === '진행중') { score += 10 }
        return { id: c.id, name: c.name, vendor: c.vendor_name,
                 start: c.start_date, end: c.end_date, status: c.status, score, why }
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
  }

  const rows = []
  const put = (type, r, label) => {
    const cands = pick(r.vendor_id, r.date)
    if (!cands.length) return
    const top = cands.slice(0, 3)
    rows.push({
      type, id: r.id, date: String(r.date || '').slice(0, 10),
      amount: Number(r.amount) || 0, vendor: r.vendor_name || '', label,
      memo: r.memo || '',
      /* 후보가 **하나뿐이고 기간까지 맞으면** 미리 골라 둔다. 둘 이상이면 사람이 고른다 —
         같은 거래처에 주문이 여럿이면 어느 것인지는 우리가 알 수 없다. */
      best: { ...top[0], sure: top.length === 1 && top[0].why.includes('주문 기간 안') },
      others: top.slice(1),
    })
  }

  for (const r of invRows) put('invoice', r, r.invoice_no || '(번호 없음)')
  for (const r of txnRows) put('txn', r, r.category || r.memo || '거래')

  rows.sort((a, b) => (b.best.sure - a.best.sure) || (b.best.score - a.best.score)
                   || (a.date < b.date ? 1 : -1))
  return { rows, txnCount: txnRows.length, invoiceCount: invRows.length, contractCount: conRows.length }
}

module.exports = { linkCandidates, inTerm }
