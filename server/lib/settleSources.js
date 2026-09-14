/**
 * 정산내역서 줄의 출처 — **같은 돈을 두 번 넣지 않게** 판정하는 곳.
 *
 * 한 지출이 여러 얼굴로 온다:
 *   txn:<거래>  ─ 그 거래를 처리 결과로 가진 결의서(resolution:<id>)·품의(purchase_req:<id>)
 *   resolution  ─ 처리한 거래, 넘겨받은 품의
 *   purchase_req─ 처리한 거래, 근거 지출(purchase_req_txns), 넘긴 결의서 — 그리고 **그 결의서의 거래**
 *
 * 한 단계만 펼치면 사슬이 끊긴다(품의 P → 결의서 R → 거래 T 에서 P 를 넣은 뒤 T 가 다시 후보에 떴다).
 * 그래서 이웃을 따라 **닫힐 때까지** 묶는다(연결 요소). 같은 묶음에 속한 열쇠는 전부 같은 돈이다.
 *
 * ⚠ 멀티테넌트 — db 는 반드시 인자로 받는다.
 */
const { inClause } = require('./pagedList')

const TYPES = ['txn', 'resolution', 'purchase_req']
const split = (key) => { const i = key.indexOf(':'); return [key.slice(0, i), key.slice(i + 1)] }

/** 열쇠들의 이웃 간선 [a, b] — 종류별로 한 번씩만 조회한다 */
async function neighborEdges(db, keys) {
  const by = { txn: [], resolution: [], purchase_req: [] }
  for (const k of keys) { const [t, id] = split(k); if (by[t]) by[t].push(id) }
  const edges = []
  const q = async (sql, ids) => { const { clause, ids: a } = inClause(ids); const [rows] = await db.execute(sql.replace('IN ?', `IN ${clause}`), a); return rows }
  if (by.resolution.length) {
    for (const r of await q('SELECT id, txn_id, purchase_req_id FROM expense_resolutions WHERE id IN ?', by.resolution)) {
      if (r.txn_id) edges.push([`resolution:${r.id}`, `txn:${r.txn_id}`])
      if (r.purchase_req_id) edges.push([`resolution:${r.id}`, `purchase_req:${r.purchase_req_id}`])
    }
  }
  if (by.purchase_req.length) {
    for (const p of await q('SELECT id, txn_id FROM purchase_reqs WHERE id IN ?', by.purchase_req)) {
      if (p.txn_id) edges.push([`purchase_req:${p.id}`, `txn:${p.txn_id}`])
    }
    for (const p of await q('SELECT req_id, txn_id FROM purchase_req_txns WHERE req_id IN ?', by.purchase_req)) {
      edges.push([`purchase_req:${p.req_id}`, `txn:${p.txn_id}`])
    }
    for (const r of await q('SELECT id, purchase_req_id FROM expense_resolutions WHERE purchase_req_id IN ?', by.purchase_req)) {
      edges.push([`purchase_req:${r.purchase_req_id}`, `resolution:${r.id}`])
    }
  }
  if (by.txn.length) {
    for (const r of await q('SELECT id, txn_id FROM expense_resolutions WHERE txn_id IN ?', by.txn)) edges.push([`txn:${r.txn_id}`, `resolution:${r.id}`])
    for (const p of await q('SELECT id, txn_id FROM purchase_reqs WHERE txn_id IN ?', by.txn)) edges.push([`txn:${p.txn_id}`, `purchase_req:${p.id}`])
    for (const p of await q('SELECT req_id, txn_id FROM purchase_req_txns WHERE txn_id IN ?', by.txn)) edges.push([`txn:${p.txn_id}`, `purchase_req:${p.req_id}`])
  }
  return edges
}

/**
 * 출처 열쇠들을 같은 돈끼리 묶는다.
 * @param seeds ['txn:…', …]
 * @returns (key) => 묶음 대표 열쇠
 */
async function moneyGroups(db, seeds) {
  if (!db) throw new Error('moneyGroups: 테넌트 연결(db)이 필요합니다')
  const parent = new Map()
  const find = (k) => { if (!parent.has(k)) parent.set(k, k); let r = k; while (parent.get(r) !== r) r = parent.get(r); parent.set(k, r); return r }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  let frontier = [...new Set(seeds)]
  const seen = new Set(frontier)
  frontier.forEach(find)
  // 사슬은 길어야 품의→결의서→거래→(다른 문서) 정도다. 넉넉히 6단계에서 멈춘다(순환 방지)
  for (let round = 0; round < 6 && frontier.length; round++) {
    const next = []
    for (const [a, b] of await neighborEdges(db, frontier)) {
      union(a, b)
      for (const k of [a, b]) if (!seen.has(k)) { seen.add(k); next.push(k) }
    }
    frontier = next
  }
  return { rootOf: find, keys: () => [...parent.keys()] }
}

/** 줄 목록에서 출처 열쇠를 뽑는다(모르는 종류·빈 값은 버린다) */
const keyOfLine = (l) => (TYPES.includes(l.source_type) && l.source_id ? `${l.source_type}:${l.source_id}` : null)

/**
 * 이미 정산서에 들어간 돈 — { 열쇠: 정산서 번호 }. 같은 묶음의 모든 열쇠를 펼쳐 준다.
 * @param exceptSettlementId 이 정산서의 줄은 빼고 본다(수정할 때 자기 줄과 부딪히지 않게)
 */
async function usedSourceMap(db, { exceptSettlementId = null } = {}) {
  const [lines] = await db.execute(
    `SELECT l.source_type, l.source_id, s.doc_no FROM settlement_lines l
       JOIN settlements s ON s.id = l.settlement_id
      WHERE l.source_type IS NOT NULL AND l.source_id IS NOT NULL${exceptSettlementId ? ' AND s.id <> ?' : ''}`,
    exceptSettlementId ? [exceptSettlementId] : [])
  const seeds = lines.map(keyOfLine).filter(Boolean)
  if (!seeds.length) return {}
  const g = await moneyGroups(db, seeds)
  const docOfRoot = new Map()
  for (const l of lines) { const k = keyOfLine(l); if (k && !docOfRoot.has(g.rootOf(k))) docOfRoot.set(g.rootOf(k), l.doc_no) }
  const out = {}
  for (const k of g.keys()) { const d = docOfRoot.get(g.rootOf(k)); if (d) out[k] = d }
  return out
}

/**
 * 저장하려는 줄이 같은 돈을 두 번 담는가 — 다른 정산서에 이미 있거나, 이 정산서 안에서 두 줄이거나.
 * 화면이 가져오기 목록에서 빼 주지만, 두 사람이 동시에 넣거나 목록을 연 채 오래 두면 겹친다.
 * @returns 오류 문구 | null
 */
async function duplicateSourceError(db, lines, { settlementId = null } = {}) {
  const mine = (lines || []).map(keyOfLine).filter(Boolean)
  if (!mine.length) return null
  const used = await usedSourceMap(db, { exceptSettlementId: settlementId })
  for (const k of mine) if (used[k]) return `정산내역서 ${used[k]}에 이미 들어간 지출이 있어요. 그 줄을 빼고 저장해주세요.`
  const g = await moneyGroups(db, mine)
  const roots = mine.map(k => g.rootOf(k))
  if (new Set(roots).size < roots.length) return '같은 지출이 두 줄로 들어 있어요(품의와 그 결의서, 또는 거래와 그 결의서). 한 줄만 남겨주세요.'
  return null
}

module.exports = { moneyGroups, usedSourceMap, duplicateSourceError }
