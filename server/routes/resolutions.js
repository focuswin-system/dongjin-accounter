const { Router } = require('express')
const { randomUUID } = require('crypto')
const { kstToday } = require('../db')
const { insertWithDocNo } = require('../lib/docno')
const { withTx, httpError } = require('../lib/withTx')
const { pageParams, buildWhere, docDateExpr, approvalStatusSql, approvalCounts } = require('../lib/pagedList')
const {
  NOT_CLAIMED_SQL, syncReqFromResolution,
  approveDoc, execCandidates, executeDoc, invoiceState, linkInvoiceDoc, loadDoc, openInvoicesFor, resolutionOfReq, sourceTxnsOfReq, unapproveDoc, undoDoc,
} = require('../lib/docExec')
const { VAT_RATE } = require('../lib/vat')

const router = Router()
const TABLE = 'expense_resolutions'

const parseItems = (v) => { try { return v ? JSON.parse(v) : [] } catch { return [] } }
const parseJson = (v, fb) => { try { return v ? JSON.parse(v) : fb } catch { return fb } }
const adapt = (r) => ({ ...r, status: r.status || '작성', amount: Number(r.amount), items: parseItems(r.items), approval: parseJson(r.approval, []) })

/**
 * 청구서 1건 → 결의서 품목 줄.
 *
 * 결의서는 **지급액(VAT 포함)** 을 결재받는 문서다. 그래서 줄 합계가 청구서 total 과
 * 같아야 한다 — 품목은 공급가(수량×단가)라 부가세를 한 줄 더 얹는다.
 * 품목 내역이 없는 청구서는 예전처럼 지급액 한 줄로 뭉친다.
 *
 * 만들 때와 다시 불러올 때가 **같은 함수를 쓴다.** 규칙을 두 군데 두면 한쪽만 고쳐져
 * "새로 만든 결의서와 불러온 결의서의 합계가 다른" 일이 생긴다.
 *
 * 이미 일부 지급된 청구서면 '기지급' 줄을 빼서 **남은 금액**이 합계가 되게 한다.
 * 예전엔 청구서 총액으로 만들어, 500만 중 200만 낸 청구서의 결의서가 500만으로 결재됐다.
 *
 * 품명과 규격은 한 칸에 합친다 — 양식의 칸이 '품명 및 규격' 하나이고,
 * 구매품의서·견적요청서도 같은 방식으로 채운다(`품명 규격`).
 */
function itemsFromInvoice(inv, lines, fallbackTitle, paid = 0) {
  let items
  if (!lines.length) {
    const gross = Number(inv.total_amount) || 0
    items = [{ name: fallbackTitle, unit: '식', qty: 1, price: gross, amount: gross, note: inv.invoice_no || '' }]
  } else {
    items = lines.map(l => ({
      name: [l.name, l.spec].filter(Boolean).join(' '),
      unit: l.unit || '', qty: Number(l.qty) || 0, price: Number(l.unit_price) || 0,
      amount: Number(l.amount) || 0, note: '',
    }))
    const vat = Number(inv.vat_amount) || 0
    if (vat > 0) items.push({ name: '부가세', unit: '', qty: 1, price: vat, amount: vat, note: inv.invoice_no || '' })
  }
  if (paid > 0) items.push({ name: '기지급액', unit: '', qty: 1, price: -paid, amount: -paid, note: '이미 지급한 금액' })
  return items
}

// 기본 결재선 프리셋의 단계를 새 결의서에 스냅샷으로 복사 (없으면 담당/결재/대표)
const defaultApproval = async (execFn) => {
  const [[p]] = await execFn('SELECT steps FROM approval_presets WHERE is_default=1 ORDER BY sort_order LIMIT 1')
  const steps = parseJson(p && p.steps, null)
  if (steps && steps.length) return steps.map(s => ({ label: s.label || '', position: s.position || '', name: '' }))
  return [{ label: '담당', position: '', name: '' }, { label: '결재', position: '', name: '' }, { label: '대표이사', position: '', name: '' }]
}

// 문서번호 채번 DJ-YYYY-NNNN (최대 일련번호 +1, 삭제해도 재사용 안 함)
//
// ⚠ FOR UPDATE 가 반드시 필요하다.
// 트랜잭션(REPEATABLE READ) 안에서 그냥 SELECT 하면 스냅샷을 읽으므로, 다른 트랜잭션이
// 방금 커밋한 번호가 보이지 않는다. 그래서 충돌 후 다시 뽑아도 **같은 번호**가 나와
// 재시도가 무의미했다(실제로 6건 동시 생성 시 4건이 실패). FOR UPDATE 는 최신 커밋을
// 읽고 그 구간을 잠가, 동시에 채번하는 트랜잭션을 줄 세운다.
const nextDocNo = async (execFn, dateStr) => {
  const year = (dateStr || kstToday()).slice(0, 4)
  const [[{ maxno }]] = await execFn(
    `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(doc_no, '-', -1) AS UNSIGNED)), 0) AS maxno
     FROM expense_resolutions WHERE doc_no LIKE ? FOR UPDATE`, [`DJ-${year}-%`])
  return `DJ-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
}

/** 결의서 한 건을 넣는다 — 만드는 창구가 넷이라(직접·청구서·품의·지출) 칸 목록을 한 곳에 둔다 */
async function insertResolution(conn, f) {
  const id = randomUUID()
  await insertWithDocNo(
    () => nextDocNo((sql, p) => conn.execute(sql, p), f.pay_date),
    (doc_no) => conn.execute(
      `INSERT INTO expense_resolutions (id, doc_no, invoice_id, purchase_req_id, vendor_id, vendor_name, title, amount, pay_method, pay_date, applicant, items, note, approval, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, doc_no, f.invoice_id || null, f.purchase_req_id || null, f.vendor_id || null, f.vendor_name || '', f.title || '지출 결의',
       Number(f.amount) || 0, f.pay_method || '계좌이체', f.pay_date || null, f.applicant || '관리자',
       JSON.stringify(f.items || []), f.note || '', JSON.stringify(f.approval || []), f.status || '작성']))
  return id
}

/* 양식의 '구매품의NO' 칸에 넣을 **진짜 품의번호**.
 *
 * 예전엔 화면이 그 칸에 결의서 자기 번호(DJ-…)를 넣었다 — 결재하는 사람이
 * "품의번호가 왜 결의서 번호랑 같지" 이거나, 반대로 **품의와 연결된 줄 알고** 넘어갔다.
 * 품의에서 만든 결의서는 purchase_req_id 로, 그 전 방식(품의→미지급금→결의서)은 같은 청구서로 잇는다.
 * ⚠ 서브쿼리로 한 개만 집는다. JOIN 으로 잇던 시절엔 한 청구서에 품의가 둘이면 결의서가 목록에 두 줄 섰다.
 * ⚠ 품의를 안 거친 지출은 **빈 칸**이다. 없는 걸 있는 것처럼 적지 않는다(인쇄해서 손으로 적는 자리다). */
const PREQ_NO_SQL = `COALESCE(
    (SELECT pr.doc_no FROM purchase_reqs pr WHERE pr.id = er.purchase_req_id),
    (SELECT pr.doc_no FROM purchase_reqs pr WHERE er.invoice_id IS NOT NULL AND pr.invoice_id = er.invoice_id ORDER BY pr.created_at LIMIT 1)
  ) AS purchase_req_no`

// 목록 (최신순)
router.get('/', async (req, res, next) => {
  try {
    /* 파라미터가 하나도 없으면 **예전처럼 배열 전체**를 준다. 정산내역서가 결의서를
     * 후보로 끌어올 때(getResolutions) 그 계약을 안 깨려는 것. 화면 목록만 페이지로 부른다. */
    const pp = pageParams(req)
    if (!pp.paged) {
      const [rows] = await req.db.execute(
        `SELECT er.*, v.name AS vendor_name2, ${PREQ_NO_SQL}
           FROM expense_resolutions er
           LEFT JOIN vendors v ON er.vendor_id = v.id
          ORDER BY er.created_at DESC, er.id DESC`)
      return res.json(rows.map(adapt))
    }
    const { whereSql, args } = buildWhere(pp, ['er.doc_no', 'er.vendor_name', 'v.name', 'er.title'], {
      prefix: 'er.', dateExpr: docDateExpr('pay_date', 'er.'), vendor: true, statusSql: approvalStatusSql('er.'),
    })
    const [[{ cnt }]] = await req.db.execute(
      `SELECT COUNT(*) AS cnt FROM expense_resolutions er LEFT JOIN vendors v ON er.vendor_id = v.id ${whereSql}`, args)
    const [rows] = await req.db.execute(
      `SELECT er.*, v.name AS vendor_name2, ${PREQ_NO_SQL}
         FROM expense_resolutions er
         LEFT JOIN vendors v ON er.vendor_id = v.id
         ${whereSql}
        ORDER BY er.created_at DESC, er.id DESC
        LIMIT ${pp.limit} OFFSET ${pp.offset}`, args)
    // 배지용 — 검색과 무관한 '할 일' 크기(작성 = 승인 대기, 승인 = 처리 대기)
    const counts = await approvalCounts(req.db, 'expense_resolutions')
    res.json({ rows: rows.map(adapt), total: Number(cnt), hasMore: pp.offset + rows.length < Number(cnt), counts,
      pendingCount: (counts['작성'] || 0) + (counts['승인'] || 0) })
  } catch (e) { next(e) }
})

// 특정 지출 거래에 연결된 결의서 (증빙 영역에서 열람용). 없으면 null.
router.get('/by-txn/:txnId', async (req, res, next) => {
  try {
    const [[r]] = await req.db.execute(
      `SELECT er.*, ${PREQ_NO_SQL} FROM expense_resolutions er WHERE er.txn_id = ?`, [req.params.txnId])
    res.json(r ? adapt(r) : null)
  } catch (e) { next(e) }
})

/**
 * 결의서를 붙일 수 있는 지출 거래 — **결의서를 만들기 전에** 고르는 목록('이미 나간 돈에서').
 *
 * 통장에서 이미 나간 돈에 **사후로 결재 근거를 붙이는** 흐름이다.
 * 예전엔 빈 폼을 열어 거래처·금액·날짜를 손으로 옮겨 적었다 — 그 값이 장부에 이미 있는데도.
 */
router.get('/candidates', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    const like = `%${q}%`
    const [rows] = await req.db.execute(
      `SELECT t.id, t.date, t.amount, t.category, t.sub_category, t.memo, t.status,
              t.account_id, t.vendor_id, t.contract_id, v.name AS vendor_name, a.name AS account_name
         FROM transactions t
         LEFT JOIN vendors  v ON t.vendor_id  = v.id
         LEFT JOIN accounts a ON t.account_id = a.id
        WHERE t.kind = 'expense'
          /* ⚠ **이미 나간 돈만.** 연결은 대상 거래를 '지급완료'로 바꾼다 — 아직 안 나간 건을
             넣어 주면 나가지도 않은 돈이 계좌 잔액에서 빠진다. 계좌가 없는 건도 뺀다 —
             골라 봐야 ledgerError 로 막히는 선택지다. */
          AND t.status = '지급완료'
          AND t.account_id IS NOT NULL
          ${NOT_CLAIMED_SQL('t.id', null)}
          ${q ? 'AND (v.name LIKE ? OR t.category LIKE ? OR t.memo LIKE ?)' : ''}
        ORDER BY t.date DESC, t.created_at DESC
        LIMIT 50`,
      q ? [like, like, like] : [])
    res.json(rows.map(t => ({ ...t, amount: Number(t.amount) })))
  } catch (e) { next(e) }
})

/**
 * 결의서로 넘길 수 있는 구매품의서 — **승인됐고, 아직 처리 안 됐고, 다른 결의서가 없는 것.**
 *
 * 작성 중인 품의는 결재가 안 났으므로 넘기지 않는다. 품의에서 이미 지출 처리한 것(완료)도
 * 넘기지 않는다 — 그걸 결의서로 또 처리하면 같은 돈이 두 번 나간다.
 * (구매품의서 목록 API 를 쓰지 않는 이유: 결의서만 쓰는 역할은 그 API 권한이 없어 목록이 빈다)
 */
router.get('/purchase-req-candidates', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(
      `SELECT pr.id, pr.doc_no, pr.req_date, pr.vendor_id, pr.vendor_name, pr.summary, pr.invoice_id,
              COALESCE((SELECT SUM(amount) FROM purchase_req_items WHERE req_id = pr.id), 0) AS total,
              (SELECT invoice_no FROM invoices WHERE id = pr.invoice_id) AS invoice_no
         FROM purchase_reqs pr
        WHERE pr.status = '승인'
          AND NOT EXISTS (SELECT 1 FROM expense_resolutions er WHERE er.purchase_req_id = pr.id)
          AND NOT EXISTS (SELECT 1 FROM purchase_req_txns p WHERE p.req_id = pr.id)
        ORDER BY pr.created_at DESC
        LIMIT 200`)
    res.json(rows.map(r => ({ ...r, total: Number(r.total) || 0 })))
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [[r]] = await req.db.execute(
      `SELECT er.*, ${PREQ_NO_SQL} FROM expense_resolutions er WHERE er.id = ?`, [req.params.id])
    if (!r) return res.status(404).json({ error: 'Not found' })
    const inv = await invoiceState(req.db, r.invoice_id)
    res.json({ ...adapt(r),
      invoice: inv ? { id: inv.id, invoice_no: inv.invoice_no, total: inv.total, remain: inv.remain } : null })
  } catch (e) { next(e) }
})

// 직접 등록 — 청구서 없는 소액 경비(비누·간식 등)를 결의서부터 작성해 결재받는 경우.
router.post('/', async (req, res, next) => {
  try {
    const out = await withTx(req.db, async (conn) => {
      const { vendor_id, vendor_name, title, items, pay_method, pay_date, applicant, note } = req.body
      const itemList = Array.isArray(items) && items.length ? items
        : [{ name: title || '지출', unit: '식', qty: 1, price: Number(req.body.amount) || 0, amount: Number(req.body.amount) || 0, note: '' }]
      const amount = itemList.reduce((s, it) => s + (Number(it.amount) || 0), 0)
      // 결재선: 요청에 있으면 그걸 쓰고(만들 때 고른 프리셋), 없으면 기본 프리셋
      const approval = Array.isArray(req.body.approval) && req.body.approval.length
        ? req.body.approval : await defaultApproval((sql, p) => conn.execute(sql, p))
      /* 거래처는 이름으로 온다(콤보박스). 등록된 거래처면 id 도 채운다 —
         비워 두면 처리할 때 같은 거래처의 미지급 청구서·통장 지출을 못 찾아 중복 가드가 헛돈다. */
      let vid = vendor_id || null
      if (!vid && vendor_name) {
        // 같은 이름이 하나뿐일 때만 — 여럿이면 어느 회사인지 모르므로 짐작해 붙이지 않는다
        const [vs] = await conn.execute('SELECT id FROM vendors WHERE TRIM(name) = ? LIMIT 2', [String(vendor_name).trim()])
        vid = vs.length === 1 ? vs[0].id : null
      }
      const id = await insertResolution(conn, {
        vendor_id: vid, vendor_name, title: title || '지출 결의', amount, pay_method, pay_date,
        applicant: applicant || req.user?.name || req.user?.username || '관리자',
        items: itemList, note, approval, status: '작성',
      })
      const [[created]] = await conn.execute('SELECT * FROM expense_resolutions WHERE id = ?', [id])
      return adapt(created)
    })
    res.json(out)
  } catch (e) { next(e) }
})

/**
 * 매입 청구서 1건 → 결의서 생성(있으면 그대로 반환). 지급 전 결재용.
 * 동시 생성이 많은 경로라 교착(deadlock)이 실제로 난다 → withTx 로 begin 부터 다시 시도한다.
 *
 * 그 청구서로 **승인된 품의**가 있으면 이어 준다(purchase_req_id) — 구매품의NO가 채워지고,
 * 결의서를 처리하면 그 품의도 완료가 된다. 안 이으면 품의는 '승인'으로 남아 누군가 품의에서
 * 또 처리할 수 있다(청구서가 완납이라 막히긴 하지만, 할 일 목록에 영영 남는다).
 */
router.post('/from-invoice/:invoiceId', async (req, res, next) => {
  try {
    const out = await withTx(req.db, async (conn) => {
      const [[existing]] = await conn.execute('SELECT * FROM expense_resolutions WHERE invoice_id = ?', [req.params.invoiceId])
      if (existing) return { ...adapt(existing), reused: true }

      const [[inv]] = await conn.execute(
        `SELECT i.*, v.name AS vendor_name, c.name AS contract_name FROM invoices i
         LEFT JOIN vendors v ON i.vendor_id = v.id
         LEFT JOIN contracts c ON i.contract_id = c.id
         WHERE i.id = ? FOR UPDATE`, [req.params.invoiceId])
      if (!inv) throw httpError(404, '청구서를 찾을 수 없어요')
      if (inv.kind !== 'received') throw httpError(400, '매입(수취) 청구서만 지급결의서를 만들 수 있어요')
      const st = await invoiceState(conn, inv.id)
      if (st.remain <= 0) throw httpError(409, '이미 지급이 끝난 청구서예요')

      // 잠그고 본다 — 그 사이 품의에서 직접 처리하면(txn_id) 넘겨받을 돈이 없다
      const [[preq]] = await conn.execute(
        `SELECT pr.id FROM purchase_reqs pr
          WHERE pr.invoice_id = ? AND pr.status = '승인' AND pr.txn_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM expense_resolutions er WHERE er.purchase_req_id = pr.id)
          LIMIT 1 FOR UPDATE`, [inv.id])

      const title = inv.contract_name || inv.memo || '매입 대금 지급'
      const [lines] = await conn.execute('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order, name', [inv.id])
      const items = itemsFromInvoice(inv, lines, title, st.paid)
      const id = await insertResolution(conn, {
        invoice_id: inv.id, purchase_req_id: preq?.id || null,
        vendor_id: inv.vendor_id, vendor_name: inv.vendor_name, title, amount: st.remain,
        pay_date: inv.due_at || null, applicant: req.user?.name || req.user?.username || '관리자',
        items, approval: await defaultApproval((sql, p) => conn.execute(sql, p)), status: '작성',
      })
      // 커밋 전 같은 커넥션으로 재조회 — req.db 를 쓰면 conn 을 쥔 채 두 번째 커넥션을 요구해 풀이 고갈된다
      const [[created]] = await conn.execute('SELECT * FROM expense_resolutions WHERE id = ?', [id])
      return adapt(created)
    })
    res.json(out)
  } catch (e) { next(e) }
})

/**
 * 승인된 구매품의서 → 결의서. 품의를 **넘긴다**: 이후 처리는 결의서에서만 한다.
 *
 * 금액:
 *   · 품의에 청구서가 붙어 있으면 그 청구서의 **남은 금액**(세액 포함) — 청구서에서 만들 때와 같은 규칙
 *   · 없으면 품의 품목(공급가) + 부가세 10% 한 줄. 결의서는 지급액(VAT 포함)을 결재받는 문서다.
 *     면세면 편집에서 그 줄을 지우면 된다(처리 창에서 과세유형도 다시 고른다).
 */
router.post('/from-purchase-req/:reqId', async (req, res, next) => {
  try {
    const out = await withTx(req.db, async (conn) => {
      const pr = await loadDoc(conn, 'purchase_reqs', req.params.reqId, { lock: true })
      if (!pr) throw httpError(404, '구매품의서를 찾을 수 없어요')
      if (pr.status === '완료') throw httpError(409, `구매품의서 ${pr.doc_no}는 이미 처리됐어요`)
      if (pr.status !== '승인') throw httpError(409, '승인한 구매품의서만 결의서로 넘길 수 있어요')
      const er = await resolutionOfReq(conn, pr.id)
      if (er) return { ...adapt((await conn.execute('SELECT * FROM expense_resolutions WHERE id = ?', [er.id]))[0][0]), reused: true }
      if ((await sourceTxnsOfReq(conn, pr.id)).length) throw httpError(409, '이미 나간 지출로 만든 품의예요. 결의서로 넘길 돈이 없어요.')

      let items, amount, invoiceId = null
      const st = await invoiceState(conn, pr.invoice_id)
      if (st) {
        if (st.remain <= 0) throw httpError(409, `청구서 ${st.invoice_no || ''}가 이미 지급 완료됐어요`.replace('  ', ' '))
        const [[other]] = await conn.execute('SELECT doc_no FROM expense_resolutions WHERE invoice_id = ? LIMIT 1', [st.id])
        if (other) throw httpError(409, `청구서 ${st.invoice_no || ''}로 이미 결의서 ${other.doc_no}가 있어요.`.replace('  ', ' '))
        const [[inv]] = await conn.execute('SELECT * FROM invoices WHERE id = ?', [st.id])
        const [lines] = await conn.execute('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order, name', [st.id])
        items = itemsFromInvoice(inv, lines, pr._title, st.paid)
        amount = st.remain
        invoiceId = st.id
      } else {
        const [its] = await conn.execute('SELECT * FROM purchase_req_items WHERE req_id = ? ORDER BY sort_order, id', [pr.id])
        items = its.map(it => ({
          name: it.name || '', unit: it.unit || '', qty: Number(it.qty) || 0,
          price: Number(it.unit_price) || 0, amount: Number(it.amount) || 0, note: it.memo || '',
        }))
        const supply = items.reduce((s, it) => s + it.amount, 0)
        const vat = Math.round(supply * VAT_RATE)
        if (vat > 0) items.push({ name: '부가세', unit: '', qty: 1, price: vat, amount: vat, note: '' })
        amount = supply + vat
      }
      if (!(amount > 0)) throw httpError(400, '품의 금액이 비어 있어요. 품목 금액을 먼저 채워주세요.')

      const id = await insertResolution(conn, {
        invoice_id: invoiceId, purchase_req_id: pr.id,
        vendor_id: pr.vendor_id, vendor_name: pr.vendor_name, title: pr._title, amount,
        pay_date: null, applicant: req.user?.name || req.user?.username || pr.applicant || '관리자',
        items, approval: await defaultApproval((sql, p) => conn.execute(sql, p)), status: '작성',
      })
      const [[created]] = await conn.execute('SELECT * FROM expense_resolutions WHERE id = ?', [id])
      return adapt(created)
    })
    res.json(out)
  } catch (e) { next(e) }
})

/**
 * 이미 나간 지출 → 결의서를 만들고 그 지출에 **바로 연결**(사후 결재 근거).
 *
 * 예전엔 화면이 '만들기'와 '연결'을 따로 불렀다. 연결이 막히면(마감된 달 등) 결의서만 남았다.
 * 이제 한 트랜잭션이다 — 연결이 막히면 결의서도 안 생긴다. 돈은 이미 나갔으므로 승인 단계를
 * 거치지 않고 곧바로 완료가 된다(종이 결재는 인쇄해서 받는다).
 */
router.post('/from-txn/:txnId', async (req, res, next) => {
  try {
    const out = await withTx(req.db, async (conn) => {
      const [[t]] = await conn.execute(
        `SELECT t.*, v.name AS vendor_name FROM transactions t LEFT JOIN vendors v ON v.id = t.vendor_id
          WHERE t.id = ? AND t.kind = 'expense'`, [req.params.txnId])
      if (!t) throw httpError(404, '지출 거래를 찾을 수 없어요')
      /* 이미 나간 돈만 — 연결은 거래를 '지급완료'로 바꾼다. 아직 안 나간 지출을 넣으면
         나가지도 않은 돈이 계좌 잔액에서 빠진다(후보 목록 /candidates 와 같은 조건). */
      if (t.status !== '지급완료' || !t.account_id) throw httpError(409, '통장에서 이미 나간 지출(지급완료·계좌 있음)만 붙일 수 있어요')
      const title = t.category || t.memo || '지출'
      const amount = Number(t.amount) || 0
      const id = await insertResolution(conn, {
        vendor_id: t.vendor_id, vendor_name: t.vendor_name || '', title, amount,
        pay_date: t.date, applicant: req.user?.name || req.user?.username || '관리자',
        // 거래에는 품목 줄이 없다 — 한 줄로 뭉친다. 나누려면 만든 뒤 편집한다.
        items: [{ name: title, unit: '식', qty: 1, price: amount, amount, note: t.memo || '' }],
        approval: await defaultApproval((sql, p) => conn.execute(sql, p)), status: '승인',
      })
      // 연결은 처리 규칙(마감·중복·잔액)을 그대로 탄다 — 여기서 직접 적으면 그 가드를 우회한다
      await executeDoc(conn, TABLE, id, { mode: 'link', txn_id: t.id })
      const [[created]] = await conn.execute('SELECT * FROM expense_resolutions WHERE id = ?', [id])
      return adapt(created)
    })
    res.json(out)
  } catch (e) { next(e) }
})

/* ── 승인·처리 ── 규칙은 lib/docExec.js (구매품의서와 같은 함수) */

router.post('/:id/approve', async (req, res, next) => {
  try { res.json(await withTx(req.db, conn => approveDoc(conn, TABLE, req.params.id))) }
  catch (e) { next(e) }
})
router.post('/:id/unapprove', async (req, res, next) => {
  try { res.json(await withTx(req.db, conn => unapproveDoc(conn, TABLE, req.params.id))) }
  catch (e) { next(e) }
})

// 처리 창 — 연결할 만한 지출 거래(거래처가 같으면 위로, 금액이 가까우면 위로)
router.get('/:id/matchable', async (req, res, next) => {
  try {
    const doc = await loadDoc(req.db, TABLE, req.params.id)
    if (!doc) return res.status(404).json({ error: 'Not found' })
    res.json(await execCandidates(req.db, TABLE, doc))
  } catch (e) { next(e) }
})

// 처리 창 — 같은 거래처의 미지급 청구서
router.get('/:id/open-invoices', async (req, res, next) => {
  try {
    const doc = await loadDoc(req.db, TABLE, req.params.id)
    if (!doc) return res.status(404).json({ error: 'Not found' })
    const amount = Number(req.query.amount) || doc._amount
    res.json(await openInvoicesFor(req.db, doc.vendor_id, amount))
  } catch (e) { next(e) }
})

router.post('/:id/link-invoice', async (req, res, next) => {
  try { res.json(await withTx(req.db, conn => linkInvoiceDoc(conn, TABLE, req.params.id, req.body.invoice_id || null))) }
  catch (e) { next(e) }
})

// 결의서 처리 — 이 결의서대로 지출을 집행한다. mode 'link'(기존 지출) | 'create'(새 지출)
router.post('/:id/process', async (req, res, next) => {
  try { res.json({ ok: true, ...(await withTx(req.db, conn => executeDoc(conn, TABLE, req.params.id, req.body))) }) }
  catch (e) { next(e) }
})

/**
 * 결의서 내용 수정 (품목 명세·특기사항·헤더 보완). **상태는 본문에서 받지 않는다.**
 *   · 완료 — 금액은 못 바꾼다(이미 만들어진 지출과 어긋난다). 적요·결재선 같은 문서 정보만.
 *   · 승인 — 내용을 바꾸면 결재받은 문서가 아니다 → 작성으로 되돌린다(화면이 먼저 알린다)
 * 예전엔 `status || '작성'` 이라, status 를 안 보내는 저장이 완료 가드를 우회해 같은 결의서를
 * 두 번 집행할 수 있었다.
 */
router.put('/:id', async (req, res, next) => {
  try {
    const { title, amount, pay_method, pay_date, applicant, items, note, vendor_name, approval } = req.body
    if (pay_date && !/^\d{4}-\d{2}-\d{2}$/.test(pay_date)) return res.status(400).json({ error: '지급일은 YYYY-MM-DD 로 적어주세요' })
    /* 잠그고 읽는다. 잠그지 않으면 화면이 연 뒤 다른 탭에서 처리(완료)된 결의서를 이 저장이
       '작성'으로 덮는다 — txn_id 는 남은 채 다시 승인·처리가 열려 같은 돈이 두 번 나간다. */
    const out = await withTx(req.db, async (conn) => {
      const [[cur]] = await conn.execute('SELECT status, amount FROM expense_resolutions WHERE id = ? FOR UPDATE', [req.params.id])
      if (!cur) throw httpError(404, 'Not found')
      const done = cur.status === '완료'
      if (done && Number(amount) !== Number(cur.amount)) {
        throw httpError(409, '이미 처리된 결의서의 금액은 바꿀 수 없어요. 연결된 지출 거래와 어긋나요.')
      }
      const nextStatus = done ? '완료' : '작성'
      await conn.execute(
        `UPDATE expense_resolutions SET title=?, amount=?, pay_method=?, pay_date=?, applicant=?, items=?, note=?, status=?, vendor_name=?, approval=?
         WHERE id=?`,
        [title || '', Number(amount) || 0, pay_method || '', pay_date || null, applicant || '',
         JSON.stringify(items || []), note || '', nextStatus, vendor_name || '',
         JSON.stringify(approval || []), req.params.id])
      return { ok: true, status: nextStatus, unapproved: cur.status === '승인' }
    })
    res.json(out)
  } catch (e) { next(e) }
})

/**
 * 연결된 청구서의 품목을 **다시 불러온다.**
 * 만들 때 한 번 복사하고 끝이라, 청구서에 품목을 나중에 채워도 결의서는 옛 모습 그대로였다.
 * 완료 결의서는 막는다 — 품목을 갈아끼우면 이미 나간 지출 거래와 문서가 다른 말을 한다.
 * 승인 결의서는 내용이 바뀌므로 작성으로 되돌린다(수정과 같은 규칙).
 */
router.post('/:id/reload-lines', async (req, res, next) => {
  try {
    const out = await withTx(req.db, async (conn) => {
      const [[cur]] = await conn.execute('SELECT * FROM expense_resolutions WHERE id = ? FOR UPDATE', [req.params.id])
      if (!cur) throw httpError(404, '결의서를 찾을 수 없어요')
      if (cur.status === '완료') throw httpError(409, '이미 처리된 결의서는 품목을 바꿀 수 없어요. 연결된 지출 거래와 어긋나요.')
      if (!cur.invoice_id) throw httpError(400, '청구서에서 만든 결의서가 아니에요. 품목을 직접 입력해주세요.')

      const [[inv]] = await conn.execute(
        `SELECT i.*, c.name AS contract_name FROM invoices i
         LEFT JOIN contracts c ON i.contract_id = c.id WHERE i.id = ?`, [cur.invoice_id])
      if (!inv) throw httpError(404, '연결된 청구서가 없어요(지워졌을 수 있어요)')

      const [lines] = await conn.execute(
        'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort_order, name', [inv.id])
      if (!lines.length) {
        throw httpError(400, `청구서 ${inv.invoice_no || ''}에 품목 내역이 없어요. 청구서를 열어 품목을 넣고 다시 불러오세요.`.trim())
      }
      const st = await invoiceState(conn, inv.id)
      const items = itemsFromInvoice(inv, lines, cur.title || '매입 대금 지급', st.paid)
      /* 금액도 청구서의 남은 금액으로 다시 맞춘다. 품목 합이 곧 지급액이라
         따로 두면 표의 합계와 헤더의 '지출총액'이 어긋난다. */
      await conn.execute("UPDATE expense_resolutions SET items = ?, amount = ?, status = '작성' WHERE id = ?",
        [JSON.stringify(items), st.remain, cur.id])
      const [[updated]] = await conn.execute(`SELECT er.*, ${PREQ_NO_SQL} FROM expense_resolutions er WHERE er.id = ?`, [cur.id])
      return { ...adapt(updated), lineCount: lines.length, invoiceNo: inv.invoice_no, unapproved: cur.status === '승인' }
    })
    res.json(out)
  } catch (e) { next(e) }
})

/**
 * 집행(완료)을 되돌린다 — 처리 취소. 완료 → 승인.
 * 청구서 쪽 정산 취소는 결의서로 집행된 건을 "결의서에서 되돌려주세요"라며 막는다 — 그 출구가 여기다.
 */
router.post('/:id/unprocess', async (req, res, next) => {
  try {
    const out = await withTx(req.db, (conn) => undoDoc(conn, TABLE, req.params.id))
    if (!out.changed) return res.status(409).json({ error: '아직 처리되지 않은 결의서예요' })
    res.json({ ok: true, keptTxn: out.keptTxn, restored: out.restored })
  } catch (e) { next(e) }
})

/**
 * 삭제. 지출까지 처리된 건은 `?cascade=1` 이 있어야 지운다.
 * 예전엔 행만 지웠다. 완료 건이 그렇게 지워지면 지출 거래와 청구서 정산은 그대로 남아
 * **되돌릴 손잡이가 사라진다.** 그래서 먼저 되돌린 뒤에만 지운다.
 * 품의에서 넘겨받은 결의서를 지우면 그 품의는 다시 '승인'으로 돌아간다(다시 넘기거나 품의에서 처리).
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const cascade = req.query.cascade === '1' || req.query.cascade === 'true'
    const out = await withTx(req.db, async (conn) => {
      const [[cur]] = await conn.execute('SELECT status, doc_no, txn_id, purchase_req_id FROM expense_resolutions WHERE id = ? FOR UPDATE', [req.params.id])
      if (!cur) throw httpError(404, '결의서를 찾을 수 없어요')
      let keptTxn = false
      if (cur.status === '완료' && cur.txn_id) {
        if (!cascade) {
          throw httpError(409, '이미 처리된 결의서예요. 지출 이력까지 함께 지우려면 처리 취소 후 삭제하거나, 삭제 시 함께 삭제를 선택하세요.')
        }
        keptTxn = (await undoDoc(conn, TABLE, req.params.id)).keptTxn
      }
      await syncReqFromResolution(conn, cur.purchase_req_id, '승인')
      await conn.execute('DELETE FROM expense_resolutions WHERE id = ?', [req.params.id])
      return { keptTxn }
    })
    res.json({ ok: true, keptTxn: out.keptTxn })
  } catch (e) { next(e) }
})

module.exports = router
