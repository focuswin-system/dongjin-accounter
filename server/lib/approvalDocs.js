/**
 * 전자결재 — 문서 등록표. **엔진(lib/approval.js)은 문서를 모른다**(설계 e-approval A1).
 * 문서 종류마다 한 줄: 어느 표인지, 결재함에 무엇을 보일지, 결재가 끝나거나 반려·회수될 때 문서를 어떻게 할지.
 *
 * 문서 상태(status)는 지금 값(작성·승인·완료)에 **'결재중'** 하나만 더한다.
 *   작성 ──상신──▶ 결재중 ──마지막 승인──▶ onApproved(= 지금의 승인 규칙) ──지출 처리──▶ 완료
 *            ◀──반려·회수── (작성으로)
 * 후결(mode post)은 상신하는 순간 onApproved 를 먼저 태워 곧바로 처리할 수 있게 한다.
 *
 * 나중에 MES 발주도 여기 한 줄(mes_pur_order)로 붙는다.
 */
const { approveDoc, unapproveDoc } = require('./docExec')
const { httpError } = require('./withTx')

/* 문서를 '작성'으로 되돌린다 — 반려·회수 때. 결재중일 때만(그 사이 다른 경로로 바뀌었으면 건드리지 않는다) */
const backToDraft = (table) => async (conn, doc) => {
  await conn.execute(`UPDATE ${table} SET status = '작성' WHERE id = ? AND status = '결재중'`, [doc.id])
}

/* 후결을 되돌린다 — 후결은 상신 때 문서를 먼저 승인했으므로, 반려·회수되면 그 승인도 풀어야 한다.
 * **돈이 아직 안 나갔을 때만.** 지금의 '승인 취소' 규칙(docExec.unapproveDoc)을 그대로 탄다 —
 * 지출 처리가 끝났거나 결의서로 넘긴 품의면 그 함수가 409 로 막는다(사람이 처리 취소부터 해야 한다).
 * 반환: true = 되돌림 / false = 돈이 이미 나가 못 되돌림(호출부가 '후결 반려'로 남긴다) */
const undoPostApproval = (table) => async (conn, doc) => {
  try { await unapproveDoc(conn, table, doc.id); return true }
  catch (e) { if (e.status === 409) return false; throw e }
}

const DOCS = {
  purchase_req: {
    table: 'purchase_reqs', label: '구매품의서', route: 'purchase_req', resource: 'purchase_req',
    async load(conn, id, { lock = false } = {}) {
      const [[d]] = await conn.execute(`SELECT * FROM purchase_reqs WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id])
      if (!d) return null
      const [[{ total }]] = await conn.execute(
        'SELECT COALESCE(SUM(amount),0) AS total FROM purchase_req_items WHERE req_id = ?', [id])
      return { ...d, _amount: Number(total) || 0 }
    },
    snapshot: (d) => ({
      title: [d.doc_no, d.vendor_name, d.summary].filter(Boolean).join(' · ').slice(0, 200),
      amount: d._amount,
    }),
    onApproved: (conn, d) => approveDoc(conn, 'purchase_reqs', d.id),
    onRejected: backToDraft('purchase_reqs'),
    onRecalled: backToDraft('purchase_reqs'),
    undoPost: undoPostApproval('purchase_reqs'),
  },

  resolution: {
    table: 'expense_resolutions', label: '지급결의서', route: 'doc', resource: 'doc',
    async load(conn, id, { lock = false } = {}) {
      const [[d]] = await conn.execute(`SELECT * FROM expense_resolutions WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id])
      return d ? { ...d, _amount: Number(d.amount) || 0 } : null
    },
    snapshot: (d) => ({
      title: [d.doc_no, d.vendor_name, d.title].filter(Boolean).join(' · ').slice(0, 200),
      amount: d._amount,
    }),
    onApproved: (conn, d) => approveDoc(conn, 'expense_resolutions', d.id),
    onRejected: backToDraft('expense_resolutions'),
    onRecalled: backToDraft('expense_resolutions'),
    undoPost: undoPostApproval('expense_resolutions'),
  },

  /* 정산내역서 — 돈을 내보내는 처리 단계가 없다. 결재가 끝나면 '승인'이 최종이다 */
  settlement: {
    table: 'settlements', label: '정산내역서', route: 'settlement', resource: 'settlement',
    noPost: true,   // 후결 없음(엔진 submit)
    async load(conn, id, { lock = false } = {}) {
      const [[d]] = await conn.execute(`SELECT * FROM settlements WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id])
      if (!d) return null
      const [[{ total }]] = await conn.execute(
        'SELECT COALESCE(SUM(amount),0) AS total FROM settlement_lines WHERE settlement_id = ?', [id])
      return { ...d, _amount: Number(total) || 0 }
    },
    snapshot: (d) => ({
      title: [d.doc_no, d.settler, d.purpose].filter(Boolean).join(' · ').slice(0, 200),
      amount: d._amount,
    }),
    onApproved: async (conn, d) => {
      await conn.execute(`UPDATE settlements SET status = '승인' WHERE id = ?`, [d.id])
      return { status: '승인' }
    },
    onRejected: backToDraft('settlements'),
    onRecalled: backToDraft('settlements'),
    // 정산은 돈을 내보내는 단계가 없어 늘 되돌릴 수 있다
    undoPost: async (conn, d) => {
      await conn.execute(`UPDATE settlements SET status = '작성' WHERE id = ? AND status = '승인'`, [d.id])
      return true
    },
  },
}

const docTypeOf = (t) => {
  const d = DOCS[t]
  if (!d) throw httpError(400, `알 수 없는 문서 종류예요: ${t}`)
  return d
}

module.exports = { DOCS, docTypeOf }
