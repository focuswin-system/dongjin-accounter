/**
 * 첨부 — 여러 표에 흩어진 증빙을 **한 모양**으로 모은다.
 * 설계: docs/02-design/features/popup-attachments-print.design.md §3, §8
 *
 * 첨부는 표가 넷으로 갈려 있다(거래 transaction_docs + 옛 evid_url · 청구서 invoice_docs · 주문 · 근로계약).
 * 옮기지 않는다 — 옮기면 위험만 크다. 대신 **읽을 때** 한 모양으로 만든다:
 *   { id, url, name, mime, kind:'image'|'pdf'|'file', size, source, source_label, created_at }
 *
 * ⚠ 권한: 거래를 볼 수 있다고 그 거래에 걸린 결의서·청구서까지 볼 수 있는 건 아니다.
 *   /uploads 는 URL 만 알면 같은 회사 누구나 여므로, **URL 을 내주는 것 자체가 공개**다.
 *   그래서 모으는 쪽이 보는 사람의 권한(canSee)으로 구획을 거른다.
 *
 * 모든 함수는 db(테넌트 풀)를 인자로 받는다(전역 풀 금지).
 */

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', hwp: 'application/x-hwp',
}

/* mime 은 **확장자로** 정한다 — 브라우저가 보낸 mimetype 은 믿을 수 없고,
   업로드 라우트도 확장자로 거른다(routes/uploads.js). 같은 기준이어야 어긋나지 않는다. */
function mimeOf(nameOrUrl) {
  const m = /\.([a-z0-9]+)(?:$|\?)/i.exec(String(nameOrUrl || ''))
  return (m && EXT_MIME[m[1].toLowerCase()]) || 'application/octet-stream'
}
const kindOf = (mime) => (mime.startsWith('image/') ? 'image' : mime === 'application/pdf' ? 'pdf' : 'file')

function shape(row, source, sourceLabel) {
  const mime = mimeOf(row.name || row.url)
  return {
    id: row.id || null, url: row.url, name: row.name || '첨부 파일', mime, kind: kindOf(mime),
    size: Number(row.size) || 0, doc_type: row.doc_type || '', source, source_label: sourceLabel,
    created_at: row.created_at || null,
  }
}

const IN = (ids) => ids.map(() => '?').join(',')

/* ── 공용 첨부(attachments) — 문서 종류별 주인 표 ──
   종류를 늘릴 때는 여기 한 줄 + 그 문서 삭제 라우트의 removeAllFor 를 함께 넣는다 */
/* lock(db, id) → 막는 이유(문자열) | null.
   결재 중인 문서는 본문 수정·삭제를 409 로 막는다(각 라우트 PUT/DELETE) — 결재자가 보는 증빙도 같이 묶는다.
   완료(승인·처리 끝) 문서엔 붙일 수 있다 — 사후 영수증이 흔하다. 대체전표는 마감된 달만 막는다. */
const inApproval = (table, label) => async (db, id) => {
  const [[r]] = await db.execute(`SELECT status FROM ${table} WHERE id = ?`, [id])
  return r?.status === '결재중' ? `결재 중인 ${label}예요. 먼저 회수해 주세요.` : null
}
const OWNERS = {
  journal_voucher: { table: 'journal_vouchers',     label: '대체전표',  res: ['voucher_entry', 'voucher_book'],
    lock: async (db, id) => {
      const { closedPeriodError } = require('./closing')
      const [[v]] = await db.execute('SELECT date FROM journal_vouchers WHERE id = ?', [id])
      return v ? closedPeriodError(db, String(v.date).slice(0, 10)) : null
    } },
  resolution:      { table: 'expense_resolutions',  label: '지급결의서', res: ['doc'],          lock: inApproval('expense_resolutions', '지급결의서') },
  purchase_req:    { table: 'purchase_reqs',        label: '구매품의서', res: ['purchase_req'], lock: inApproval('purchase_reqs', '구매품의서') },
  settlement:      { table: 'settlements',          label: '정산내역서', res: ['settlement'],   lock: inApproval('settlements', '정산내역서') },
}

/* 업로드 파일 URL 이 저장되는 모든 자리 — 파일 하나를 여러 행이 가리킬 수 있다.
   ⚠ 파일을 지우기 전에 **다른 행이 아직 쓰는지** 센다. 안 세면 내 문서에서 뗀 파일이
   세금계산서·거래 증빙에서도 사라진다(2026-10-02 검토 P1). scripts/migrate-uploads.js 도 이 목록을 쓴다. */
const URL_COLUMNS = [
  ['attachments',        'url'],
  ['invoice_docs',       'url'],
  ['contract_docs',      'url'],
  ['transaction_docs',   'url'],
  ['work_contract_docs', 'file_url'],
  ['transactions',       'evid_url'],
  ['ref_items',          'file_url'],
  ['contracts',          'file_url'],
]
async function urlRefCount(db, url) {
  let n = 0
  for (const [t, c] of URL_COLUMNS) {
    const [[r]] = await db.execute(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [url])
    n += Number(r.n)
  }
  return n
}
/** 아무 행도 안 쓰는 파일만 지운다 — 행을 지운 **뒤에** 부른다 */
async function removeFilesIfUnused(db, urls, companyId) {
  const { removeUploadedFile } = require('./uploads')
  for (const u of new Set(urls || [])) {
    if (await urlRefCount(db, u) === 0) removeUploadedFile(u, companyId)
  }
}

async function listFor(db, ownerType, ownerId, sourceLabel) {
  const [rows] = await db.execute(
    'SELECT id, url, name, size, created_at FROM attachments WHERE owner_type = ? AND owner_id = ? ORDER BY created_at, id',
    [ownerType, ownerId])
  return rows.map(r => shape(r, ownerType, sourceLabel || OWNERS[ownerType]?.label || ''))
}

/* ── 문서에 연결된 것의 증빙 — 문서 [증빙]·인쇄 마법사가 쓴다 ──
   결의서·품의서·정산서는 **기존 거래를 끌어와** 만들기도 하고, 그 거래엔 세금계산서가 걸려 있기도 하다.
   증빙을 문서에 다시 올리게 하지 않는다 — 연결을 따라가 **읽을 때** 모은다(복사하지 않는다 → 원본 하나).
   연결된 것은 보기만(linked:true) — 지우기는 원래 붙은 곳에서 한다.
   ⚠ 권한: 문서를 볼 수 있다고 거래·청구서 증빙까지 볼 수 있는 건 아니다(위 relatedToTxn 과 같은 원칙). */
const TXN_RES = ['ledger', 'misc_pl', 'misc_income', 'voucher_book']
const INV_RES = ['billing_issued', 'billing_received', 'ar', 'ap']

async function invoiceFiles(db, invoiceIds) {
  const ids = [...new Set(invoiceIds.filter(Boolean))]
  if (!ids.length) return []
  const [invs] = await db.execute(`SELECT id, kind, invoice_no, issued_at FROM invoices WHERE id IN (${IN(ids)})`, ids)
  if (!invs.length) return []
  const [docs] = await db.execute(
    `SELECT id, invoice_id, url, name, doc_type, size, created_at FROM invoice_docs WHERE invoice_id IN (${IN(invs)}) ORDER BY created_at`,
    invs.map(i => i.id))
  return docs.map(d => {
    const i = invs.find(x => x.id === d.invoice_id)
    return shape(d, 'invoice', `${i.kind === 'issued' ? '매출' : '매입'} 세금계산서 · ${i.issued_at || ''}`)
  })
}

/** 거래들의 증빙 + 그 거래에 연결된 세금계산서 증빙 */
async function txnFiles(db, txnIds, canSee) {
  const ids = [...new Set(txnIds.filter(Boolean))]
  if (!ids.length) return []
  const out = []
  const [txns] = await db.execute(`SELECT t.id, t.date, v.name AS vendor_name, t.evid_url, t.evid_type, t.invoice_id
       FROM transactions t LEFT JOIN vendors v ON v.id = t.vendor_id WHERE t.id IN (${IN(ids)})`, ids)
  if (canSee(TXN_RES)) {
    const [tdocs] = await db.execute(
      `SELECT id, txn_id, url, name, doc_type, size, created_at FROM transaction_docs WHERE txn_id IN (${IN(ids)}) ORDER BY created_at`, ids)
    for (const t of txns) {
      const label = `거래 · ${String(t.date || '').slice(0, 10)}${t.vendor_name ? ' ' + t.vendor_name : ''}`
      const mine = tdocs.filter(d => d.txn_id === t.id)
      for (const d of mine) out.push(shape(d, 'txn', label))
      if (t.evid_url && !mine.some(d => d.url === t.evid_url)) {
        out.push(shape({ url: t.evid_url, name: String(t.evid_url).split('/').pop(), doc_type: t.evid_type }, 'txn', label))
      }
    }
  }
  if (canSee(INV_RES)) {
    const [ms] = await db.execute(`SELECT invoice_id FROM invoice_matches WHERE txn_id IN (${IN(ids)})`, ids)
    out.push(...await invoiceFiles(db, [...txns.map(t => t.invoice_id), ...ms.map(m => m.invoice_id)]))
  }
  return out
}

/**
 * 문서 하나에 걸린 증빙 전부 — 직접 붙인 것(linked:false) + 연결을 따라 모은 것(linked:true).
 *   지급결의서: 거래(txn_id) · 세금계산서(invoice_id) · 구매품의서(purchase_req_id, 품의서 직접 첨부)
 *   구매품의서: 거래(txn_id + purchase_req_txns) · 세금계산서(invoice_id)
 *   정산내역서: 줄의 출처(거래·결의서·품의서) — 결의서·품의서는 위 규칙을 한 번 더 따른다
 *   대체전표:   직접 붙인 것만(연결된 거래가 없다)
 * 같은 파일(url)은 한 번만.
 */
async function relatedToDoc(db, ownerType, id, canSee, depth = 0) {
  const own = (await listFor(db, ownerType, id)).map(f => ({ ...f, linked: depth > 0 }))
  const linked = []
  if (ownerType === 'resolution') {
    const [[r]] = await db.execute('SELECT txn_id, invoice_id, purchase_req_id FROM expense_resolutions WHERE id = ?', [id])
    if (r) {
      linked.push(...await txnFiles(db, [r.txn_id], canSee))
      if (r.invoice_id && canSee(INV_RES)) linked.push(...await invoiceFiles(db, [r.invoice_id]))
      if (r.purchase_req_id && depth < 2 && canSee(['purchase_req'])) linked.push(...await relatedToDoc(db, 'purchase_req', r.purchase_req_id, canSee, depth + 1))
    }
  } else if (ownerType === 'purchase_req') {
    const [[p]] = await db.execute('SELECT doc_no, txn_id, invoice_id FROM purchase_reqs WHERE id = ?', [id])
    if (p) {
      const [pts] = await db.execute('SELECT txn_id FROM purchase_req_txns WHERE req_id = ?', [id])
      linked.push(...await txnFiles(db, [p.txn_id, ...pts.map(x => x.txn_id)], canSee))
      if (p.invoice_id && canSee(INV_RES)) linked.push(...await invoiceFiles(db, [p.invoice_id]))
      if (depth > 0) own.forEach(f => { f.source_label = `구매품의서 · ${p.doc_no}` })
    }
  } else if (ownerType === 'settlement') {
    const [ls] = await db.execute(
      'SELECT DISTINCT source_type, source_id FROM settlement_lines WHERE settlement_id = ? AND source_id IS NOT NULL', [id])
    linked.push(...await txnFiles(db, ls.filter(l => l.source_type === 'txn').map(l => l.source_id), canSee))
    for (const l of ls) {
      if (depth >= 2) break
      if (l.source_type === 'resolution' && canSee(['doc'])) {
        const [[d]] = await db.execute('SELECT doc_no FROM expense_resolutions WHERE id = ?', [l.source_id])
        const fs = await relatedToDoc(db, 'resolution', l.source_id, canSee, depth + 1)
        linked.push(...fs.map(f => (f.source === 'resolution' && d ? { ...f, source_label: `지급결의서 · ${d.doc_no}` } : f)))
      }
      if (l.source_type === 'purchase_req' && canSee(['purchase_req'])) {
        linked.push(...await relatedToDoc(db, 'purchase_req', l.source_id, canSee, depth + 1))
      }
    }
  }
  const seen = new Set(own.map(f => f.url))
  const out = [...own]
  for (const f of linked) {
    if (seen.has(f.url)) continue
    seen.add(f.url); out.push({ ...f, linked: true })
  }
  return out
}

/** 문서를 지울 때 — 첨부 행을 지우고 파일 URL 을 돌려준다(파일은 커밋 뒤 부르는 쪽이 removeFilesIfUnused 로 지운다) */
async function removeAllFor(db, ownerType, ownerId) {
  const [rows] = await db.execute('SELECT url FROM attachments WHERE owner_type = ? AND owner_id = ?', [ownerType, ownerId])
  await db.execute('DELETE FROM attachments WHERE owner_type = ? AND owner_id = ?', [ownerType, ownerId])
  return rows.map(r => r.url)
}

/**
 * 문서 라우터에 첨부 길 세 개를 단다 — 권한은 그 문서 경로의 권한을 그대로 따른다(apiPerms 접두사).
 *   GET    /:id/attachments           목록(한 모양 — shape)
 *   POST   /:id/attachments           { url, name, size } — 파일은 먼저 /api/uploads 로 올린다
 *   DELETE /:id/attachments/:attId    행 + 파일
 * ⚠ 업로드 URL 은 **이 회사 폴더**(/uploads/{companyId}/)만 받는다 — 남의 회사 파일 URL 을 붙여 넣는 길을 막는다.
 */
function attachRoutes(router, ownerType) {
  const { randomUUID } = require('crypto')
  const fs = require('fs'), path = require('path')
  const { canAny } = require('../platform/userPerms')
  const owner = OWNERS[ownerType]
  const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads')
  const exists = async (db, id) => {
    const [[r]] = await db.execute(`SELECT id FROM ${owner.table} WHERE id = ?`, [id])
    return !!r
  }
  router.get('/:id/attachments', async (req, res, next) => {
    try {
      if (!(await exists(req.db, req.params.id))) return res.status(404).json({ error: `${owner.label}를 찾을 수 없어요` })
      // 직접 붙인 것 + 연결된 거래·세금계산서·품의서 증빙(보기만). 권한은 보는 사람 기준으로 거른다
      const canSee = (resources) => !req.permRoles?.length || canAny(req.perms, resources, 'view')
      const canEdit = !req.permRoles?.length || canAny(req.perms, owner.res, 'edit')
      const locked = await owner.lock(req.db, req.params.id)
      // editable — 화면이 올리기 칸·지우기 버튼을 그릴지. 막는 이유가 있으면 locked 로 함께 준다
      res.json({ files: await relatedToDoc(req.db, ownerType, req.params.id, canSee), editable: canEdit && !locked, locked: locked || '' })
    } catch (e) { next(e) }
  })
  router.post('/:id/attachments', async (req, res, next) => {
    try {
      if (!(await exists(req.db, req.params.id))) return res.status(404).json({ error: `${owner.label}를 찾을 수 없어요` })
      const locked = await owner.lock(req.db, req.params.id)
      if (locked) return res.status(409).json({ error: locked })
      const url = String(req.body.url || '')
      const companyId = req.user?.companyId
      /* 이 회사 폴더 바로 아래 파일 하나만 — 하위 경로·.. 금지, 실제로 있어야 한다(크기도 디스크에서 잰다) */
      const prefix = `/uploads/${companyId}/`
      const fname = companyId && url.startsWith(prefix) ? url.slice(prefix.length) : ''
      const file = fname && !/[/\\]/.test(fname) && !fname.includes('..') ? [url, fname] : null
      const full = file && path.join(UPLOAD_ROOT, companyId, file[1])
      let stat = null
      try { stat = full && fs.statSync(full) } catch { stat = null }
      if (!stat?.isFile()) return res.status(400).json({ error: '올린 파일을 찾을 수 없어요. 다시 올려주세요.' })
      // 이미 다른 곳(세금계산서·거래·다른 문서)에 붙은 파일은 받지 않는다 — 여기서 떼면 거기서도 사라진다
      if (await urlRefCount(req.db, url) > 0) return res.status(409).json({ error: '이미 다른 곳에 붙은 파일이에요. 파일을 새로 올려주세요.' })
      const name = String(req.body.name || file[1]).slice(0, 255)
      const id = randomUUID()
      await req.db.execute(
        'INSERT INTO attachments (id, owner_type, owner_id, url, name, mime, size, created_by) VALUES (?,?,?,?,?,?,?,?)',
        [id, ownerType, req.params.id, url, name, mimeOf(name || url), stat.size, req.user?.name || req.user?.username || null])
      res.json({ ok: true, id })
    } catch (e) { next(e) }
  })
  router.delete('/:id/attachments/:attId', async (req, res, next) => {
    try {
      const [[a]] = await req.db.execute(
        'SELECT id, url FROM attachments WHERE id = ? AND owner_type = ? AND owner_id = ?', [req.params.attId, ownerType, req.params.id])
      if (!a) return res.status(404).json({ error: '첨부를 찾을 수 없어요' })
      const locked = await owner.lock(req.db, req.params.id)
      if (locked) return res.status(409).json({ error: locked })
      await req.db.execute('DELETE FROM attachments WHERE id = ?', [a.id])
      await removeFilesIfUnused(req.db, [a.url], req.user?.companyId)
      res.json({ ok: true })
    } catch (e) { next(e) }
  })
}

/**
 * 거래 하나에 걸린 것 전부 — 한눈에 보기(overview)와 인쇄 마법사가 쓴다.
 * @param canSee (resources: string[]) => boolean  보는 사람이 그 구획을 볼 수 있나
 * @returns {{ invoices, resolutions, purchaseReqs, settlements, files }}
 */
async function relatedToTxn(db, txn, canSee) {
  const out = { invoices: [], resolutions: [], purchaseReqs: [], settlements: [], files: [] }

  // 거래 자체 — 이 거래를 볼 수 있으니 여기까지 왔다
  const [tdocs] = await db.execute(
    'SELECT id, url, name, doc_type, size, created_at FROM transaction_docs WHERE txn_id = ? ORDER BY created_at', [txn.id])
  for (const d of tdocs) out.files.push(shape(d, 'txn', '거래'))
  // 옛 단일 증빙 칸 — 목록 화면(api.js buildTxnDocs)도 함께 보여 준다
  if (txn.evid_url && !tdocs.some(d => d.url === txn.evid_url)) {
    out.files.push(shape({ url: txn.evid_url, name: String(txn.evid_url).split('/').pop(), doc_type: txn.evid_type }, 'txn', '거래'))
  }

  // 청구서 — 직접 연결(invoice_id) + 정산 연결(invoice_matches, 부분 입금 포함)
  if (canSee(['billing_issued', 'billing_received', 'ar', 'ap'])) {
    const [invs] = await db.execute(
      `SELECT i.id, i.invoice_no, i.kind, i.issued_at, i.due_at, i.status, i.supply_amount, i.vat_amount, i.total_amount,
              v.name AS vendor_name,
              (SELECT COALESCE(SUM(m2.amount), 0) FROM invoice_matches m2 WHERE m2.invoice_id = i.id) AS paid_amount,
              (SELECT m.amount FROM invoice_matches m WHERE m.invoice_id = i.id AND m.txn_id = ? LIMIT 1) AS this_amount
         FROM invoices i LEFT JOIN vendors v ON v.id = i.vendor_id
        WHERE i.id = ? OR i.id IN (SELECT invoice_id FROM invoice_matches WHERE txn_id = ?)
        ORDER BY i.issued_at`,
      [txn.id, txn.invoice_id || '', txn.id])
    out.invoices = invs.map(i => ({
      ...i, supply_amount: Number(i.supply_amount), vat_amount: Number(i.vat_amount), total_amount: Number(i.total_amount),
      paid_amount: Number(i.paid_amount), this_amount: i.this_amount == null ? null : Number(i.this_amount),
    }))
    if (invs.length) {
      const [idocs] = await db.execute(
        `SELECT id, invoice_id, url, name, doc_type, size, created_at FROM invoice_docs WHERE invoice_id IN (${IN(invs)}) ORDER BY created_at`,
        invs.map(i => i.id))
      const label = (id) => {
        const i = invs.find(x => x.id === id)
        return `${i.kind === 'issued' ? '매출' : '매입'} 세금계산서 · ${i.issued_at || ''}`
      }
      for (const d of idocs) out.files.push(shape(d, 'invoice', label(d.invoice_id)))
    }
  }

  // 지급결의서
  if (canSee(['doc'])) {
    const [rs] = await db.execute(
      'SELECT id, doc_no, title, amount, status, pay_date FROM expense_resolutions WHERE txn_id = ? ORDER BY doc_no', [txn.id])
    out.resolutions = rs.map(r => ({ ...r, amount: Number(r.amount) }))
    for (const r of rs) out.files.push(...await listFor(db, 'resolution', r.id, `지급결의서 · ${r.doc_no}`))
  }

  // 구매품의서 — 단건(txn_id) + 여러 건 연결(purchase_req_txns)
  if (canSee(['purchase_req'])) {
    const [ps] = await db.execute(
      `SELECT id, doc_no, summary, status, req_date FROM purchase_reqs
        WHERE txn_id = ? OR id IN (SELECT req_id FROM purchase_req_txns WHERE txn_id = ?) ORDER BY doc_no`,
      [txn.id, txn.id])
    out.purchaseReqs = ps
    for (const r of ps) out.files.push(...await listFor(db, 'purchase_req', r.id, `구매품의서 · ${r.doc_no}`))
  }

  // 정산내역서 — 줄이 이 거래를 출처로 가진 것
  if (canSee(['settlement'])) {
    const [ss] = await db.execute(
      `SELECT DISTINCT s.id, s.doc_no, s.status FROM settlements s JOIN settlement_lines l ON l.settlement_id = s.id
        WHERE l.source_type = 'txn' AND l.source_id = ? ORDER BY s.doc_no`, [txn.id])
    out.settlements = ss
    for (const r of ss) out.files.push(...await listFor(db, 'settlement', r.id, `정산내역서 · ${r.doc_no}`))
  }

  return out
}

module.exports = { relatedToTxn, relatedToDoc, mimeOf, kindOf, shape, OWNERS, URL_COLUMNS, listFor, removeAllFor, removeFilesIfUnused, attachRoutes }
