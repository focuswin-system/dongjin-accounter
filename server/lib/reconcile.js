/**
 * 대사(對査) — 아직 정산 안 된 **청구서**와 아직 붙지 않은 **거래**의 짝을 찾아 준다.
 *
 * ── 왜 필요한가 ──
 * 엑셀로 세금계산서 100건, 통장 내역 300건을 올리고 나면 그 둘을 사람이 손으로 잇는다.
 * 지금은 청구서를 하나 열어야 후보가 보여서, 100건이면 100번 열어야 한다.
 * 여기서는 **한 번에** 짝을 지어 내놓는다.
 *
 * ── 무엇을 하고 무엇을 안 하나 ──
 * **제시만 한다. 붙이는 건 사람이 한다.**
 * 매칭은 미수금·미지급금을 지우는 행위다. 잘못 붙으면 "받은 걸로 되어 있는데 통장엔 없는 돈"이
 * 생기고, 그건 몇 달 뒤에야 드러나며 그때는 원인을 찾기가 아주 어렵다.
 * 그래서 자동 확정은 하지 않는다 — 확신이 높은 짝을 **미리 골라 둔 채로** 보여주고,
 * 사람이 눈으로 확인해 누르게 한다.
 *
 * ⚠ 실제로 붙이는 일은 기존 `POST /invoices/:id/matches` 가 한다. 거기에 마감월·미래일자·
 *   중복 거래·잔액 초과 가드가 이미 다 들어 있다. 여기서 그 로직을 흉내 내지 않는다 —
 *   두 벌이 되면 한쪽만 고쳐져 가드가 새는 날이 온다.
 */

/** 두 날짜의 거리(일). 못 읽으면 아주 먼 값으로 본다. */
const daysBetween = (a, b) => {
  const x = Date.parse(`${String(a).slice(0, 10)}T00:00:00`)
  const y = Date.parse(`${String(b).slice(0, 10)}T00:00:00`)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 9999
  return Math.abs(Math.round((x - y) / 86400000))
}

/** 상호를 적요에서 찾기 위한 정규화 — (주)·㈜·공백·마침표는 표기 차이일 뿐이다. */
const normName = (s) => String(s || '')
  .replace(/\(주\)|\(유\)|㈜|㈜|주식회사|유한회사/g, '')
  .replace(/[\s.·,\-_()]/g, '')
  .toLowerCase()

/* 금액이 '거의 같다'고 볼 범위 — 이체 수수료로 몇백 원이 빠져 들어오는 일이 흔하다.
   비율만 쓰면 큰 금액에서 너무 헐거워지므로 절대값과 함께 작은 쪽을 택한다. */
const NEAR_ABS = 1000
const NEAR_RATE = 0.005
/* 나눠 낸 것으로 볼 최소 비율 — 이보다 작은 조각은 우연히 맞은 것으로 본다 */
const PARTIAL_MIN_RATE = 0.2
const nearly = (a, b) => {
  const d = Math.abs(a - b)
  if (d === 0) return false                    // 정확히 같은 건 따로 센다
  return d <= Math.min(NEAR_ABS, Math.max(1, Math.round(b * NEAR_RATE)))
}

/**
 * 한 쌍의 점수와 근거.
 * @returns { score, why[] } — score 0 이면 후보로 보지 않는다
 */
function scorePair(inv, txn) {
  const why = []
  let score = 0

  const sameVendor = !!inv.vendor_id && inv.vendor_id === txn.vendor_id
  if (sameVendor) { score += 40; why.push('거래처 같음') }

  /* ⚠ **금액 단서가 하나도 없으면 후보가 아니다.**
     처음엔 거래처와 날짜만으로도 내놨더니, 남은 금액 4,400,000원짜리 청구서에
     350,000원 거래를 1등으로 추천했다(실측). 거래처가 같은 건 그 회사와 거래가
     여러 건이라는 뜻일 뿐이라 근거가 못 된다. 금액이 판정의 축이다. */
  const amt = Number(txn.amount) || 0

  /* ⚠ **남은 금액을 넘는 거래는 제시하지 않는다.**
     POST /:id/matches 가 초과분을 409 로 막는다(맞는 처사다 — 넘치는 돈은 다른 건의 것이다).
     그런 짝을 목록에 올려 두면 사람이 누를 때마다 실패하고, 왜 실패하는지도 알기 어렵다.
     이런 건은 청구서를 열어 금액을 나눠 넣는 기존 정산 화면이 맡는다. */
  if (amt > inv.remain) return { score: 0, why: [] }

  let amountClue = false
  if (amt === inv.remain) { score += 45; why.push('남은 금액과 일치'); amountClue = true }
  else if (amt === inv.total) { score += 45; why.push('청구금액과 일치'); amountClue = true }  // 아직 한 푼도 안 받은 건
  else if (amt === inv.supply) { score += 35; why.push('공급가액과 일치'); amountClue = true }
  else if (nearly(amt, inv.remain) || nearly(amt, inv.total)) {
    score += 22; amountClue = true
    why.push(`${Math.abs(amt - (nearly(amt, inv.remain) ? inv.remain : inv.total)).toLocaleString('ko-KR')}원 모자람`)
  } else if (sameVendor && amt < inv.remain && amt >= inv.remain * PARTIAL_MIN_RATE) {
    /* 나눠 낸 것으로 보이는 경우(선급·기성·잔금). 다만 **너무 작은 조각은 뺀다** —
       남은 금액의 몇 퍼센트짜리 거래까지 후보로 내면 그 거래처의 모든 거래가 딸려 온다. */
    score += 18; amountClue = true
    why.push(`남은 금액의 ${Math.round(amt / inv.remain * 100)}%`)
  }
  if (!amountClue) return { score: 0, why: [] }

  /* 거래처가 안 붙은 거래를 구제한다 — 엑셀로 올린 통장 내역은 적요만 있고 거래처가 비는 일이
     많다. 적요에 상호가 찍혀 있으면 그게 거래처만큼 강한 단서다. */
  let nameInMemo = false
  if (!sameVendor && inv.vendorNameNorm) {
    const hay = normName(`${txn.memo || ''} ${txn.category || ''}`)
    if (hay && hay.includes(inv.vendorNameNorm)) { score += 30; nameInMemo = true; why.push('적요에 거래처 이름') }
  }

  /* **양쪽 다 거래처를 아는데 서로 다르면** 거의 아니다 — 금액이 우연히 같았을 뿐이다.
     실측에서 부산영재교육진흥원 청구서에 동진문구 거래가 1등으로 붙었다.
     거래처가 **비어 있는** 거래는 깎지 않는다(엑셀 통장 내역이 그렇다 — 구제 대상이다). */
  if (!sameVendor && !nameInMemo && inv.vendor_id && txn.vendor_id) {
    score -= 15; why.push('거래처 다름')
  }

  /* 날짜 — 가까울수록 가점. 여태 아예 안 보던 신호인데 가장 값싸고 강하다.
     기준은 결제기한이 있으면 그것, 없으면 발행일이다(돈은 대개 기한 즈음에 오간다). */
  const base = inv.due_at || inv.issued_at
  const gap = daysBetween(txn.date, base)
  if (gap <= 3) { score += 20; why.push('날짜가 거의 같음') }
  else if (gap <= 14) { score += 12; why.push(`${gap}일 차이`) }
  else if (gap <= 45) { score += 5; why.push(`${gap}일 차이`) }
  else if (gap > 180) { score -= 15; why.push(`${gap}일 차이`) }

  // 거래가 청구서보다 **먼저** 있었으면 약하게 깎는다(먼저 받고 나중에 끊는 일도 있어 막지는 않는다)
  if (txn.date < String(inv.issued_at).slice(0, 10)) { score -= 8; why.push('청구서보다 이름') }

  return { score, why }
}

/** 이 짝을 미리 골라 둘 만큼 확신하나 — 거래처와 금액이 **둘 다** 맞고 시기도 멀지 않을 때만. */
function isSure(inv, txn, why) {
  const amtExact = why.includes('남은 금액과 일치') || why.includes('청구금액과 일치')
  const vendorOk = why.includes('거래처 같음')
  const base = inv.due_at || inv.issued_at
  return amtExact && vendorOk && daysBetween(txn.date, base) <= 60
}

const MIN_SCORE = 45          // 이보다 낮으면 보여주지 않는다 — 근거 없는 제시는 방해가 된다
const TOP_N = 3               // 청구서 하나에 후보 셋까지

/**
 * @param db     테넌트 연결(req.db)
 * @param kind   'issued'(매출·미수금) | 'received'(매입·미지급금)
 * @returns { rows, txnCount } rows = [{ invoice, best, others[] }]
 */
async function reconcileCandidates(db, kind) {
  const txnKind = kind === 'issued' ? 'income' : 'expense'

  /* 아직 남은 청구서. 정산액은 한 번의 조인으로 함께 센다 —
     청구서마다 따로 세면 200건이면 200번 묻게 된다. */
  const [invRows] = await db.execute(`
    SELECT i.id, i.invoice_no, i.vendor_id, i.issued_at, i.due_at,
           i.supply_amount, i.total_amount, i.status, i.memo,
           v.name AS vendor_name,
           COALESCE((SELECT SUM(m.amount) FROM invoice_matches m WHERE m.invoice_id = i.id), 0) AS paid
      FROM invoices i
      LEFT JOIN vendors v ON v.id = i.vendor_id
     WHERE i.kind = ?
     HAVING i.total_amount - paid > 0
     ORDER BY i.issued_at DESC
     LIMIT 300`, [kind])

  /* 아직 어느 청구서에도 안 붙은 거래.
     ⚠ invoice_id 만 보면 안 된다 — 매칭은 invoice_matches 가 정본이고, invoice_id 는
       거기서 따라 채워지는 값이다. 둘 다 본다. */
  const [txnRows] = await db.execute(`
    SELECT t.id, t.date, t.amount, t.vendor_id, t.category, t.memo, t.status, t.account_id,
           v.name AS vendor_name, a.name AS account_name
      FROM transactions t
      LEFT JOIN vendors v ON v.id = t.vendor_id
      LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.kind = ?
       AND t.invoice_id IS NULL
       AND t.id NOT IN (SELECT txn_id FROM invoice_matches WHERE txn_id IS NOT NULL)
     ORDER BY t.date DESC
     LIMIT 500`, [txnKind])

  const invoices = invRows.map(r => ({
    id: r.id, invoiceNo: r.invoice_no, vendor_id: r.vendor_id, vendor: r.vendor_name || '',
    vendorNameNorm: normName(r.vendor_name),
    issued_at: r.issued_at, due_at: r.due_at, status: r.status, memo: r.memo || '',
    supply: Number(r.supply_amount) || 0,
    total: Number(r.total_amount) || 0,
    remain: (Number(r.total_amount) || 0) - (Number(r.paid) || 0),
  }))

  /* 청구서마다 후보를 점수 매긴다. 300 x 500 = 15만 번인데 단순 비교라 눈 깜짝할 사이다. */
  const scoredByInv = new Map()
  const allPairs = []
  for (const inv of invoices) {
    const list = []
    for (const t of txnRows) {
      const { score, why } = scorePair(inv, t)
      if (score >= MIN_SCORE) { list.push({ txn: t, score, why }); allPairs.push({ inv, txn: t, score, why }) }
    }
    if (list.length) {
      list.sort((a, b) => b.score - a.score || (a.txn.date < b.txn.date ? 1 : -1))
      scoredByInv.set(inv.id, list)
    }
  }

  /* **한 거래는 한 청구서에만 붙는다.** 그러니 제시도 그렇게 한다.
     처음엔 청구서마다 따로 1등을 뽑았더니 같은 350,000원 거래가 두 청구서의 1등으로
     동시에 올라왔다(실측). 사람이 위에서부터 누르다 보면 두 번째는 반드시 실패한다.
     점수가 높은 짝부터 임자를 정하고, 이미 임자가 있는 거래는 다음 청구서에서 뺀다. */
  allPairs.sort((a, b) => b.score - a.score)
  const takenTxn = new Set()
  const bestOf = new Map()
  for (const p of allPairs) {
    if (bestOf.has(p.inv.id) || takenTxn.has(p.txn.id)) continue
    bestOf.set(p.inv.id, p)
    takenTxn.add(p.txn.id)
  }

  const view = (s, inv) => ({
    id: s.txn.id, date: s.txn.date, amount: Number(s.txn.amount) || 0,
    vendor: s.txn.vendor_name || '', category: s.txn.category || '', memo: s.txn.memo || '',
    account: s.txn.account_name || '', accountId: s.txn.account_id || null,
    score: s.score, why: s.why,
    sure: isSure(inv, s.txn, s.why),
  })

  const rows = []
  for (const inv of invoices) {
    const picked = bestOf.get(inv.id)
    if (!picked) continue
    // 다른 청구서가 이미 가져간 거래는 대안으로도 내놓지 않는다 — 눌러도 안 되는 선택지다
    const others = (scoredByInv.get(inv.id) || [])
      .filter(s => s.txn.id !== picked.txn.id && !takenTxn.has(s.txn.id))
      .slice(0, TOP_N - 1)
      .map(s => view(s, inv))
    const best = view(picked, inv)
    /* 확신은 **1등이 압도적일 때만** 준다. 비슷한 점수의 대안이 있으면 사람이 골라야 한다 —
       금액이 같은 거래가 둘이면 어느 쪽인지는 우리가 알 수 없다. */
    const clear = !others.length || (best.score - others[0].score >= 20)
    rows.push({
      invoice: {
        id: inv.id, invoiceNo: inv.invoiceNo, vendor: inv.vendor, issuedAt: inv.issued_at,
        dueAt: inv.due_at, total: inv.total, remain: inv.remain, status: inv.status,
      },
      best: { ...best, sure: best.sure && clear },
      others,
    })
  }

  /* 확신이 높은 것부터 — 눌러야 할 것이 위에 오는 게 맞다. 같은 확신 안에서는 점수 순. */
  rows.sort((a, b) => (b.best.sure - a.best.sure) || (b.best.score - a.best.score))
  return { rows, invoiceCount: invoices.length, txnCount: txnRows.length }
}

module.exports = { reconcileCandidates, scorePair, normName, daysBetween }
