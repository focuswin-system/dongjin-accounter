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
  }

  // 구매품의서 — 단건(txn_id) + 여러 건 연결(purchase_req_txns)
  if (canSee(['purchase_req'])) {
    const [ps] = await db.execute(
      `SELECT id, doc_no, summary, status, req_date FROM purchase_reqs
        WHERE txn_id = ? OR id IN (SELECT req_id FROM purchase_req_txns WHERE txn_id = ?) ORDER BY doc_no`,
      [txn.id, txn.id])
    out.purchaseReqs = ps
  }

  // 정산내역서 — 줄이 이 거래를 출처로 가진 것
  if (canSee(['settlement'])) {
    const [ss] = await db.execute(
      `SELECT DISTINCT s.id, s.doc_no, s.status FROM settlements s JOIN settlement_lines l ON l.settlement_id = s.id
        WHERE l.source_type = 'txn' AND l.source_id = ? ORDER BY s.doc_no`, [txn.id])
    out.settlements = ss
  }

  return out
}

module.exports = { relatedToTxn, mimeOf, kindOf, shape }
