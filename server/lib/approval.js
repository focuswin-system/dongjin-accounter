/**
 * 전자결재 엔진 — 문서 종류와 무관하다(문서는 lib/approvalDocs.js 등록표로 붙는다).
 * 설계: docs/02-design/features/e-approval.design.md
 *
 * ── 동작 ──
 *   상신(submit)   기안자가 결재선을 정해 올린다. 첫 '결재' 차례가 '차례'가 된다.
 *                  후결(mode post): 문서를 먼저 승인 상태로 돌려 곧바로 처리할 수 있게 하고, 결재는 뒤따른다.
 *   승인(approve)  **지금 차례인 사람만.** 다음 '결재' 차례로 넘어가고, 마지막이면 결재 끝 → 문서 승인.
 *   전결(final)    차례인 사람이 윗선을 대신해 끝낸다. 뒤 차례는 '생략'(Q2: 결재자 판단, 규칙표 없음).
 *   반려(reject)   차례인 사람이, 사유 필수. 결재 끝, 문서는 '작성'으로(후결이면 문서는 그대로 두고 '후결 반려'로 알린다).
 *   회수(recall)   기안자가, 아무도 승인·전결하기 전에만. 관리자는 언제든(결재자가 퇴사해 멈춘 결재를 풀 길).
 *
 * ── 후결을 되돌리는 규칙 ── (검토에서 잡힘: 후결 상신 후 바로 회수하면 아무도 결재 안 한 문서가 '승인'으로 남았다)
 *   후결은 상신 때 문서를 먼저 승인한다. 그래서 반려·회수되면 **그 승인도 푼다 — 돈이 아직 안 나갔으면.**
 *   돈이 이미 나갔으면 반려는 '후결 반려'로만 남기고(사람이 처리 취소를 판단), 기안자 회수는 막는다.
 *
 * ── 잠금 순서 ── submit 은 문서→결재, act·recall 은 결재→문서 순으로 잠근다. 같은 문서에 재상신과
 *   승인이 동시에 들어오면 교착이 날 수 있지만 withTx 가 1213 을 재시도해 409 로 수렴한다(검토 확인).
 *
 * ── 지키는 것 ──
 *   · 한 트랜잭션 + 행 잠금(FOR UPDATE) — 같은 차례를 두 번 처리하지 못한다(MES 는 여기가 비어 있었다)
 *   · 이력은 지우지 않는다 — 반려·회수 뒤 다시 올리면 새 회차(round+1)
 *   · 문서의 돈 규칙(마감·이중계상 가드)은 docExec 가 그대로 지킨다. 결재는 '누가 허락했나'만 바꾼다
 *
 * 모든 함수는 db(테넌트 풀 또는 트랜잭션 연결)를 인자로 받는다(전역 풀 금지).
 */
const { randomUUID } = require('crypto')
const { withTx, httpError } = require('./withTx')
const { platformPool } = require('../platform/db')
const { DOCS, docTypeOf } = require('./approvalDocs')

const MAX_STEPS = 10
const ACTIVE = '진행'

/** 회사가 전자결재를 쓰나(회사 설정, 기본 꺼짐) */
async function isEnabled(db) {
  const [[r]] = await db.execute("SELECT e_approval FROM company_info WHERE id = 'main'")
  return !!Number(r?.e_approval)
}

/** 결재자 후보 — 같은 회사의 사용 중인 계정. 이름·직위·부서만 준다(아이디·이메일은 주지 않는다) */
async function approvers(companyId) {
  const [rows] = await platformPool.execute(
    `SELECT id, name, username, position, department FROM users
      WHERE company_id = ? AND active = 1 ORDER BY name`, [companyId])
  return rows.map(u => ({ id: u.id, name: u.name || u.username, position: u.position || '', department: u.department || '' }))
}

async function usersById(companyId, ids) {
  if (!ids.length) return new Map()
  const [rows] = await platformPool.execute(
    `SELECT id, name, username, position, active FROM users
      WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [companyId, ...ids])
  return new Map(rows.map(u => [u.id, u]))
}

/** 그 문서의 진행 중인 결재(있으면) */
async function activeOf(db, docType, docId, { lock = false } = {}) {
  const [[a]] = await db.execute(
    `SELECT * FROM approvals WHERE doc_type = ? AND doc_id = ? AND status = ? ORDER BY round DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [docType, docId, ACTIVE])
  return a || null
}

/** 문서를 고치거나 지우기 전에 — 결재가 진행 중이면 막는다(회수가 먼저다) */
async function assertNoActive(db, docType, docId) {
  const a = await activeOf(db, docType, docId)
  if (a) {
    throw httpError(409, a.mode === 'post'
      ? '후결 결재가 진행 중인 문서예요. 결재가 끝난 뒤에 고치거나, 기안자가 회수해 주세요.'
      : '결재 중인 문서예요. 고치려면 기안자가 먼저 회수해 주세요.', { code: 'approval_active' })
  }
}

/** 승인된 문서가 다시 '작성'으로 돌아갈 때(내용 수정·승인 취소) — 그 결재는 효력을 잃는다 */
async function voidApproved(db, docType, docId) {
  await db.execute(
    `UPDATE approvals SET status = '취소' WHERE doc_type = ? AND doc_id = ? AND status = '승인'`, [docType, docId])
}

/**
 * 상신.
 * @param user  req.user ({ id, name, companyId })
 * @param body  { doc_type, doc_id, steps:[{user_id, label?, kind?:'결재'|'참조'}], mode?:'normal'|'post', reason? }
 */
async function submit(db, user, body) {
  const docType = String(body.doc_type || '')
  const spec = docTypeOf(docType)
  const docId = String(body.doc_id || '')
  if (!(await isEnabled(db))) throw httpError(409, '전자결재를 쓰지 않는 회사예요. 환경설정 › 결재선에서 켜 주세요.')

  const raw = Array.isArray(body.steps) ? body.steps : []
  if (raw.length > MAX_STEPS) throw httpError(400, `결재선은 ${MAX_STEPS}명까지예요`)
  const steps = raw.map((s, i) => ({
    userId: String(s.user_id || ''), label: String(s.label || '').trim().slice(0, 30),
    kind: s.kind === '참조' ? '참조' : '결재', seq: i + 1,
  }))
  if (steps.some(s => !s.userId)) throw httpError(400, '결재선에 사람을 모두 골라 주세요')
  if (!steps.some(s => s.kind === '결재')) throw httpError(400, '결재할 사람이 한 명은 있어야 해요')
  const ids = steps.map(s => s.userId)
  if (new Set(ids).size !== ids.length) throw httpError(400, '같은 사람이 결재선에 두 번 있어요')
  if (ids.includes(user.id)) throw httpError(400, '기안자 본인은 결재선에 넣을 수 없어요')
  const people = await usersById(user.companyId, ids)
  for (const s of steps) {
    const u = people.get(s.userId)
    if (!u || !Number(u.active)) throw httpError(400, '결재선에 없는 사람이나 사용 중지된 계정이 있어요')
    s.name = u.name || u.username
    s.pos = u.position || ''
  }
  const [[me]] = await platformPool.execute('SELECT position FROM users WHERE id = ? AND company_id = ?', [user.id, user.companyId])

  return withTx(db, async (conn) => {
    const doc = await spec.load(conn, docId, { lock: true })
    if (!doc) throw httpError(404, `${spec.label}를 찾을 수 없어요`)
    if (await activeOf(conn, docType, docId, { lock: true })) throw httpError(409, '이미 결재가 진행 중인 문서예요')
    const st = doc.status || '작성'
    if (st === '결재중') throw httpError(409, '이미 결재가 진행 중인 문서예요')
    // 이미 결재가 끝난 문서에 또 올리면 유효한 승인 위에 새 회차가 쌓이고, 그게 반려되면 승인을 가린다
    const [[last]] = await conn.execute(
      'SELECT status FROM approvals WHERE doc_type = ? AND doc_id = ? ORDER BY round DESC LIMIT 1', [docType, docId])
    // 문서가 작성으로 돌아왔으면(내용을 고쳐 결재가 풀림) 다시 올릴 수 있어야 한다 — 승인·완료 문서만 막는다
    if (last?.status === '승인' && st !== '작성') throw httpError(409, '이미 결재가 끝난 문서예요')

    /* 이미 승인·처리된 문서에 결재를 올리면 그건 **후결**이다 — 처리가 먼저 있었고 결재가 뒤따른다.
       사유를 자동으로 채우는 건 **정말 처리가 끝난(완료) 문서만** — 승인만 된 문서는 사람이 이유를 적는다
       (안 그러면 사유 필수 규칙이 이 길로 빠져나간다 — 검토에서 잡힘). */
    let mode = body.mode === 'post' ? 'post' : 'normal'
    let reason = String(body.reason || '').trim().slice(0, 500)
    if (st === '승인' || st === '완료') mode = 'post'
    if (st === '완료') reason = reason || '이미 처리된 문서'
    // 내보낼 돈이 없는 문서(정산내역서)는 '먼저 처리'할 게 없다 — 후결이 성립하지 않는다
    if (mode === 'post' && spec.noPost) throw httpError(400, `${spec.label}는 후결로 올릴 수 없어요`)
    if (mode === 'post' && !reason) throw httpError(400, '긴급(후결)로 올리는 이유를 적어 주세요')

    const [[{ r }]] = await conn.execute(
      'SELECT COALESCE(MAX(round), 0) AS r FROM approvals WHERE doc_type = ? AND doc_id = ?', [docType, docId])
    const snap = spec.snapshot(doc)
    const approvalId = randomUUID()
    await conn.execute(
      `INSERT INTO approvals (id, doc_type, doc_id, round, title, amount, mode, reason, status,
                              drafter_id, drafter_name, drafter_pos, submitted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [approvalId, docType, docId, Number(r) + 1, snap.title || null, snap.amount ?? null, mode, reason || null, ACTIVE,
       user.id, user.name || user.username || '', me?.position || ''])
    const firstTurn = steps.find(s => s.kind === '결재').seq
    for (const s of steps) {
      const status = s.kind === '참조' ? '참조' : (s.seq === firstTurn ? '차례' : '대기')
      await conn.execute(
        `INSERT INTO approval_steps (id, approval_id, seq, kind, approver_id, approver_name, approver_pos, label, status)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [randomUUID(), approvalId, s.seq, s.kind, s.userId, s.name, s.pos, s.label || s.pos || '결재', status])
    }

    // 문서 쪽 — 정상: 결재중(잠김). 후결: 아직 승인 전이면 먼저 승인해서 곧바로 처리할 수 있게
    if (mode === 'normal') {
      await conn.execute(`UPDATE ${spec.table} SET status = '결재중' WHERE id = ?`, [docId])
    } else if (st === '작성') {
      await spec.onApproved(conn, doc)
    }
    return { id: approvalId, mode }
  })
}

/**
 * 결재 동작 — 승인·전결·반려. 지금 차례인 사람만.
 * @param action 'approve' | 'final' | 'reject'
 */
async function act(db, user, approvalId, action, comment) {
  if (!['approve', 'final', 'reject'].includes(action)) throw httpError(400, '알 수 없는 결재 동작이에요')
  const note = String(comment || '').trim().slice(0, 500)
  if (action === 'reject' && !note) throw httpError(400, '반려 사유를 적어 주세요')

  return withTx(db, async (conn) => {
    const [[a]] = await conn.execute('SELECT * FROM approvals WHERE id = ? FOR UPDATE', [approvalId])
    if (!a) throw httpError(404, '결재를 찾을 수 없어요')
    if (a.status !== ACTIVE) throw httpError(409, `이미 끝난 결재예요(${a.status})`)
    const [steps] = await conn.execute(
      'SELECT * FROM approval_steps WHERE approval_id = ? ORDER BY seq FOR UPDATE', [approvalId])
    const mine = steps.find(s => s.status === '차례')
    if (!mine || mine.approver_id !== user.id) throw httpError(403, '지금 결재 차례가 아니에요')

    const spec = DOCS[a.doc_type]
    const doc = spec ? await spec.load(conn, a.doc_id, { lock: true }) : null
    const finish = async (status) => {
      await conn.execute('UPDATE approvals SET status = ?, finished_at = NOW() WHERE id = ?', [status, approvalId])
    }

    if (action === 'reject') {
      await conn.execute(`UPDATE approval_steps SET status = '반려', acted_at = NOW(), comment = ? WHERE id = ?`, [note, mine.id])
      await finish('반려')
      if (doc && a.mode === 'normal') await spec.onRejected(conn, doc)
      /* 후결 — 먼저 해 둔 승인을 푼다. 돈이 이미 나갔으면 못 푼다 → '후결 반려'로 남아 사람이 판단한다 */
      let undone = null
      if (doc && a.mode === 'post') undone = await spec.undoPost(conn, doc)
      return { status: '반려', mode: a.mode, undone }
    }

    await conn.execute(`UPDATE approval_steps SET status = ?, acted_at = NOW(), comment = ? WHERE id = ?`,
      [action === 'final' ? '전결' : '승인', note || null, mine.id])
    const rest = steps.filter(s => s.kind === '결재' && s.seq > mine.seq && s.status === '대기')
    if (action === 'final' && rest.length) {
      await conn.execute(
        `UPDATE approval_steps SET status = '생략' WHERE approval_id = ? AND kind = '결재' AND seq > ? AND status = '대기'`,
        [approvalId, mine.seq])
    }
    const next = action === 'final' ? null : rest[0]
    if (next) {
      await conn.execute(`UPDATE approval_steps SET status = '차례' WHERE id = ?`, [next.id])
      return { status: ACTIVE, next: next.approver_name }
    }
    await finish('승인')
    /* 정상 결재가 끝나면 문서를 승인한다(지금의 승인 규칙 — 돈이 이미 나간 문서는 바로 완료).
       문서가 결재중이 아니면(그 사이 다른 경로로 바뀜) 건드리지 않는다 */
    if (doc && a.mode === 'normal' && doc.status === '결재중') await spec.onApproved(conn, doc)
    return { status: '승인', mode: a.mode }
  })
}

const isAdmin = (user) => user?.role === 'admin'

/**
 * 회수 — 기안자가, 아직 아무도 승인·전결하지 않았을 때.
 * **관리자는 언제든** — 결재 차례인 사람이 퇴사·계정 중지되면 결재가 영영 멈추고(PUT·DELETE 가 결재 중이라 막힌다)
 * 풀 길이 없었다(검토에서 잡힘). 관리자 회수도 감사 기록에 남는다(auditMap recall).
 */
async function recall(db, user, approvalId) {
  return withTx(db, async (conn) => {
    const [[a]] = await conn.execute('SELECT * FROM approvals WHERE id = ? FOR UPDATE', [approvalId])
    if (!a) throw httpError(404, '결재를 찾을 수 없어요')
    const byAdmin = isAdmin(user) && a.drafter_id !== user.id
    if (a.drafter_id !== user.id && !isAdmin(user)) throw httpError(403, '올린 사람만 회수할 수 있어요')
    if (a.status !== ACTIVE) throw httpError(409, `이미 끝난 결재예요(${a.status})`)
    if (!isAdmin(user)) {
      const [[{ n }]] = await conn.execute(
        `SELECT COUNT(*) AS n FROM approval_steps WHERE approval_id = ? AND status IN ('승인','전결')`, [approvalId])
      if (Number(n) > 0) throw httpError(409, '이미 결재한 사람이 있어 회수할 수 없어요. 결재자에게 반려를 부탁해 주세요.')
    }
    const spec = DOCS[a.doc_type]
    const doc = spec ? await spec.load(conn, a.doc_id, { lock: true }) : null
    if (doc && a.mode === 'post') {
      // 후결 — 먼저 해 둔 승인을 푼다. 돈이 이미 나갔으면 기안자는 회수 못 한다(반려로만). 관리자는 결재만 거둔다
      const undone = await spec.undoPost(conn, doc)
      if (!undone && !isAdmin(user)) {
        throw httpError(409, '이미 처리(지출)된 후결은 회수할 수 없어요. 처리 취소부터 하거나 결재자에게 반려를 부탁해 주세요.')
      }
    }
    await conn.execute(`UPDATE approval_steps SET status = '대기' WHERE approval_id = ? AND status = '차례'`, [approvalId])
    await conn.execute(`UPDATE approvals SET status = '회수', finished_at = NOW() WHERE id = ?`, [approvalId])
    if (doc && a.mode === 'normal') await spec.onRecalled(conn, doc)
    return { status: '회수', byAdmin }
  })
}

/** 문서를 지울 때 — 그 문서의 결재를 모두 '취소'로(결재함·반려 숫자에 지워진 문서가 남지 않게, 검토에서 잡힘) */
async function voidAll(db, docType, docId) {
  await db.execute(
    `UPDATE approvals SET status = '취소', finished_at = COALESCE(finished_at, NOW())
      WHERE doc_type = ? AND doc_id = ? AND status <> '취소'`, [docType, docId])
}

const stepsOf = async (db, ids) => {
  if (!ids.length) return new Map()
  const [rows] = await db.execute(
    `SELECT approval_id, seq, kind, approver_id, approver_name, approver_pos, label, status, acted_at, comment
       FROM approval_steps WHERE approval_id IN (${ids.map(() => '?').join(',')}) ORDER BY seq`, ids)
  const by = new Map()
  for (const s of rows) (by.get(s.approval_id) || by.set(s.approval_id, []).get(s.approval_id)).push(s)
  return by
}

/** 결재 한 건 + 결재선. 볼 수 있는 사람: 기안자·결재선에 있는 사람·그 문서를 볼 권한이 있는 사람 */
async function detail(db, user, approvalId, { canViewDoc } = {}) {
  const [[a]] = await db.execute('SELECT * FROM approvals WHERE id = ?', [approvalId])
  if (!a) throw httpError(404, '결재를 찾을 수 없어요')
  const steps = (await stepsOf(db, [a.id])).get(a.id) || []
  const involved = a.drafter_id === user.id || steps.some(s => s.approver_id === user.id)
  if (!involved && !(canViewDoc && canViewDoc(DOCS[a.doc_type]?.resource))) throw httpError(403, '볼 수 없는 결재예요')
  return shape(a, steps, user)
}

function shape(a, steps, user) {
  const spec = DOCS[a.doc_type]
  const turn = steps.find(s => s.status === '차례')
  return {
    ...a, amount: a.amount == null ? null : Number(a.amount),
    doc_label: spec?.label || a.doc_type, doc_route: spec?.route || null,
    steps,
    my_turn: !!(turn && user && turn.approver_id === user.id && a.status === ACTIVE),
    can_recall: !!(user && a.status === ACTIVE && (isAdmin(user)
      || (a.drafter_id === user.id && !steps.some(s => ['승인', '전결'].includes(s.status))))),
    turn_name: turn?.approver_name || null,
  }
}

/** 문서 하나의 결재 이력(모든 회차, 최근 것 먼저) — 문서 화면·인쇄 결재란 */
async function historyOf(db, user, docType, docId) {
  docTypeOf(docType)
  const [rows] = await db.execute(
    'SELECT * FROM approvals WHERE doc_type = ? AND doc_id = ? ORDER BY round DESC', [docType, docId])
  const steps = await stepsOf(db, rows.map(r => r.id))
  return rows.map(a => shape(a, steps.get(a.id) || [], user))
}


/**
 * 목록 줄에 **최근 결재 상태**를 얹는다 — 반려된 문서가 목록에서 그냥 '작성'으로만 보이면
 * 기안자가 열어 보기 전엔 돌려받은 줄 모른다(실화면에서 짚음).
 * rows 는 id 를 가진 문서 행. approval_state: 진행|승인|반려|회수|취소|null, approval_mode: normal|post|null
 */
async function withApprovalState(db, docType, rows) {
  const ids = (rows || []).map(r => r.id).filter(Boolean)
  if (!ids.length) return rows
  const [st] = await db.execute(
    `SELECT a.doc_id, a.status, a.mode FROM approvals a
      WHERE a.doc_type = ? AND a.doc_id IN (${ids.map(() => '?').join(',')})
        AND a.round = (SELECT MAX(b.round) FROM approvals b WHERE b.doc_type = a.doc_type AND b.doc_id = a.doc_id)`,
    [docType, ...ids])
  const by = new Map(st.map(r => [r.doc_id, r]))
  return rows.map(r => ({ ...r, approval_state: by.get(r.id)?.status || null, approval_mode: by.get(r.id)?.mode || null }))
}

/**
 * 결재함.
 *   todo  결재할 문서(내 차례)            mine  내가 올린 것(진행·반려·회수, 최근)
 *   done  내가 결재한 것(승인·전결·반려)   ref   참조로 받은 것
 */
async function inbox(db, user, box) {
  const LIMIT = 200
  let sql
  const args = [user.id]
  if (box === 'todo') {
    sql = `SELECT a.* FROM approvals a JOIN approval_steps s ON s.approval_id = a.id
            WHERE s.approver_id = ? AND s.status = '차례' AND a.status = '진행' ORDER BY a.submitted_at`
  } else if (box === 'mine') {
    /* 문서마다 **최근 회차만** — 반려 뒤 다시 올린 문서가 회차 수만큼 줄로 겹쳐 보였다. 앞 회차는 상세의 이력에서 본다 */
    sql = `SELECT a.* FROM approvals a WHERE a.drafter_id = ?
             AND a.round = (SELECT MAX(b.round) FROM approvals b WHERE b.doc_type = a.doc_type AND b.doc_id = a.doc_id)
           ORDER BY a.submitted_at DESC LIMIT ${LIMIT}`
  } else if (box === 'done') {
    sql = `SELECT a.* FROM approvals a JOIN approval_steps s ON s.approval_id = a.id
            WHERE s.approver_id = ? AND s.status IN ('승인','전결','반려') ORDER BY s.acted_at DESC LIMIT ${LIMIT}`
  } else if (box === 'ref') {
    sql = `SELECT a.* FROM approvals a JOIN approval_steps s ON s.approval_id = a.id
            WHERE s.approver_id = ? AND s.kind = '참조' ORDER BY a.submitted_at DESC LIMIT ${LIMIT}`
  } else throw httpError(400, '알 수 없는 결재함이에요')
  const [rows] = await db.execute(sql, args)
  const steps = await stepsOf(db, rows.map(r => r.id))
  return rows.map(a => shape(a, steps.get(a.id) || [], user))
}

/** 종·사이드바 숫자 — 결재할 문서, 반려되어 돌아온 내 문서(아직 다시 안 올린 것), 후결 반려 */
async function counts(db, user) {
  const [[t]] = await db.execute(
    `SELECT COUNT(*) AS n FROM approval_steps s JOIN approvals a ON a.id = s.approval_id
      WHERE s.approver_id = ? AND s.status = '차례' AND a.status = '진행'`, [user.id])
  const [[r]] = await db.execute(
    `SELECT COUNT(*) AS n FROM approvals a
      WHERE a.drafter_id = ? AND a.status = '반려'
        AND a.round = (SELECT MAX(b.round) FROM approvals b WHERE b.doc_type = a.doc_type AND b.doc_id = a.doc_id)`,
    [user.id])
  return { todo: Number(t.n), rejected: Number(r.n) }
}

module.exports = {
  isEnabled, approvers, activeOf, assertNoActive, voidApproved,
  submit, act, recall, voidAll, detail, historyOf, inbox, counts, withApprovalState,
}
