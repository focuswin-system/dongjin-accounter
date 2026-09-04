/**
 * 청구서를 만드는 **단 하나의 함수.**
 *
 * ── 왜 필요한가 ──
 * 청구서를 만드는 곳이 라우트 10군데였다. 번호 채기·부가세·품목 줄까지는 공용 조각이
 * 있었지만 '청구서를 만든다'는 행위 자체는 공용이 없어서, 창구마다 하는 일이 조금씩
 * 달라졌다. 실제로 어긋나 있던 것들:
 *
 *   - 정기 회차에서 발행할 때만 `recurring_id` 를 채웠다 → 다른 창구로 만들면 그 회차가
 *     '발행예정'에 **영영 남는다.** 나중에 보고 또 발행하면 같은 돈을 두 번 청구한다.
 *   - 엑셀 임포트 INSERT 에는 `contract_id` 컬럼이 아예 없었다 → 엑셀로 올린 계산서는
 *     계약과 영영 안 이어진다.
 *   - 번호 채는 방법이 두 벌이었다(한쪽은 헬퍼, 한쪽은 같은 SQL 을 복사).
 *
 * ── 이 함수의 핵심: origin 은 **기본값이 없다** ──
 * 창구를 줄이는 게 답이 아니다. 홈택스 엑셀 100건과 매달 도는 정기 규칙과 계약 마일스톤은
 * 진짜로 다른 상황이고, 하나로 합치면 넷 다 불편해진다.
 * 대신 **어느 문으로 들어왔든 장부에는 똑같이 적히게** 한다. 그래서 origin 을 필수로 받는다 —
 * 새 창구를 내는 사람이 "이 청구서는 어디서 왔는가"를 답하지 않고는 청구서를 만들 수 없다.
 * 지금 벌어진 일(정기 회차인데 안 적어서 붕 뜸)이 구조적으로 불가능해진다.
 *
 * ⚠ origin 과 contractId 는 **다른 질문**이다. 섞지 말 것.
 *     origin     = 어느 문으로 들어왔나 (정기 / 마일스톤 / 엑셀 / 수시)
 *     contractId = 어느 계약의 돈인가
 *   엑셀로 올렸든 수시로 쳤든 그 계산서가 어느 계약 건인지는 이어져야 한다.
 */

const { randomUUID } = require('crypto')

/** origin 종류 — 여기 없는 값은 받지 않는다(오타로 뒤처리가 조용히 빠지는 걸 막는다)
 *
 *   recurring     정기 규칙 회차에서   → 회차를 닫는다(last_generated)
 *   milestone     계약 청구 일정에서   → 마일스톤을 잇는다(status·invoice_id)
 *   progress      계약 품목 기성에서   → 닫을 회차가 없다(기성은 품목 누적으로 관리한다)
 *   purchase_req  구매품의서에서       → 뒤처리 없음(품의서가 청구서를 붙들지 않는다)
 *   import        엑셀·홈택스 문서에서 → 뒤처리 없음(어느 회차인지 알 수 없다)
 *   manual        사람이 그 자리에서   → 뒤처리 없음
 */
const ORIGINS = new Set(['recurring', 'milestone', 'progress', 'purchase_req', 'import', 'manual'])

/* 정기 규칙이 사는 테이블 — **매출과 매입이 서로 다른 표다.**
   정기청구(매출)는 recurring_invoices, 정기지출(매입)은 recurring_expenses 를 민다.
   kind 로 넘겨짚지 않고 부르는 쪽이 적게 한다. 넘겨짚으면 언젠가 매입 청구서가
   매출 규칙의 하한을 밀어, 엉뚱한 회차가 통째로 사라진다.
   (lib/recurrence.js 의 restoreLastGenerated 도 같은 방식으로 테이블을 받는다) */
const RULE_TABLES = new Set(['recurring_invoices', 'recurring_expenses'])

/**
 * 청구번호 — `청구-2026-0001` / `매입-2026-0001`.
 * 최대 일련번호+1이라 삭제해도 번호를 재사용하지 않는다(회계 번호는 비어도 되지만 겹치면 안 된다).
 * @param seq 한 번에 여러 건을 만들 때 쓰는 캐시(Map). 없으면 매번 DB에 묻는다 —
 *            엑셀 100건을 넣을 때 캐시가 없으면 같은 번호가 100번 나온다.
 */
async function nextInvoiceNo(db, kind, year, seq = null) {
  const prefix = kind === 'issued' ? '청구' : '매입'
  const key = `${kind}|${year}`
  if (seq && seq.has(key)) {
    const n = seq.get(key) + 1
    seq.set(key, n)
    return `${prefix}-${year}-${String(n).padStart(4, '0')}`
  }
  const [[{ maxno }]] = await db.execute(
    "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno"
    + ' FROM invoices WHERE kind = ? AND invoice_no LIKE ?',
    [kind, `${prefix}-${year}-%`])
  const n = Number(maxno) + 1
  if (seq) seq.set(key, n)
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`
}

/**
 * 청구서 한 건을 만들고, **출처에 따른 뒤처리까지 같은 트랜잭션에서** 끝낸다.
 *
 * ⚠ **뒤처리가 있는 origin(recurring·milestone)은 트랜잭션 커넥션이어야 한다.**
 *   본체와 뒤처리가 갈라지면 청구서는 생겼는데 회차는 안 닫힌 상태가 남는다 — 지금 문제 그대로다.
 *   뒤처리가 없는 origin(manual·import·progress·purchase_req)은 풀(req.db)을 그대로 줘도 된다.
 *
 * @param conn  DB 커넥션. 뒤처리가 있는 origin 이면 beginTransaction 된 커넥션
 * @param f     청구서 값
 * @param f.origin  { type, recurringId?, milestoneId?, source? } — **필수**
 * @returns { id, invoiceNo, lines }
 */
async function createInvoice(conn, f) {
  const origin = f.origin
  if (!origin || !ORIGINS.has(origin.type)) {
    /* 던진다. 조용히 'manual' 로 넘기면 이 함수를 만든 이유가 사라진다 —
       뒤처리가 빠진 청구서가 또 생기고, 그건 몇 달 뒤 '붕 뜬 회차'로 나타난다. */
    throw new Error(`createInvoice: origin.type 이 필요해요 (${[...ORIGINS].join('/')})`)
  }
  if (origin.type === 'recurring') {
    if (!origin.recurringId) {
      throw new Error('createInvoice: origin.type=recurring 이면 recurringId 가 필요해요')
    }
    if (!RULE_TABLES.has(origin.ruleTable)) {
      throw new Error('createInvoice: origin.ruleTable 이 필요해요 '
        + `(${[...RULE_TABLES].join(' / ')}) — 매출과 매입은 다른 표를 씁니다`)
    }
  }
  if (origin.type === 'milestone' && !origin.milestoneId) {
    throw new Error('createInvoice: origin.type=milestone 이면 milestoneId 가 필요해요')
  }

  /* id 를 밖에서 받을 수 있게 둔다 — 부르는 쪽이 청구서를 만들기 **전에** id 가 필요한
     경우가 있다(품목 줄을 잇거나, 중복 오류를 잡아 그 건만 건너뛰는 임포트 반복문). */
  const id = f.id || randomUUID()
  const year = String(f.issuedAt || '').slice(0, 4)
  const invoiceNo = f.invoiceNo || await nextInvoiceNo(conn, f.kind, year, f.seq || null)

  /* contract_id 는 origin 과 무관하게 늘 담는다. 마일스톤에서 왔으면 그 마일스톤의 계약이지만,
     엑셀·수시로 들어온 건도 계약을 알면 이어 준다(예전 엑셀 임포트는 이 컬럼이 아예 없었다).
     recurring_id 는 정기 회차에서 온 것만 — 그게 회차를 닫는 근거다.
     backfill_batch 는 소급 등록 마법사가 **한 묶음을 통째로 되돌리는** 근거다(없으면 null).
     ⚠ 값 배열 안에는 주석을 쓰지 않는다. check:isolation 의 '플레이스홀더 ↔ 값 개수' 검사가
       주석 속 쉼표를 값으로 세어 위반으로 잡는다(실제로 걸렸다). 검사를 우회할 게 아니라
       읽기 쉬운 자리에 쓴다. */
  const recurringId = origin.type === 'recurring' ? origin.recurringId : null
  const status = f.status || (f.kind === 'issued' ? '입금 예정' : '지급 대기')
  await conn.execute(
    `INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, recurring_id,
                           supply_amount, vat_amount, total_amount, issued_at, due_at,
                           status, account_id, memo, tax_type, nts_confirm_no, category, account_code,
                           backfill_batch)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, invoiceNo, f.kind, f.vendorId || null, f.contractId || null, recurringId,
     f.supply, f.vat, f.total, f.issuedAt, f.dueAt || null,
     status, f.accountId || null, f.memo || '', f.taxType, f.ntsConfirmNo || null,
     f.category || null, f.accountCode || null, f.backfillBatch || null]
  )

  const lines = f.writeLines ? await f.writeLines(conn, id) : 0

  /* ── 출처별 뒤처리 ──
     여기가 이 함수의 존재 이유다. 예전엔 창구마다 알아서 했고, 그래서 빠뜨렸다. */
  if (origin.type === 'recurring') {
    /* 회차를 닫는다. last_generated 는 '이 값 이하 회차는 이미 생성됨'을 뜻하는 하한선이라,
       발행일이 아니라 **회차일(due)** 로 민다 — 발행일로 밀면 앞당겨 발행한 달의
       앞 회차들이 통째로 사라진다.

       ⚠ **앞으로만 민다(전진만).** 그냥 대입하면 소급 등록에서 하한이 **내려간다** —
         과거 회차를 만드는 창구라 due 가 기존 하한보다 앞서기 때문이다. 하한이 내려가면
         이미 만들어 둔 뒤 회차들이 '놓친 회차'로 되살아나 **같은 달을 두 번 청구**하게 된다.
         소급 창구가 따로 들고 있던 조건(뒤면 밀고 앞이면 그대로)을 여기로 올렸다 —
         이건 그 창구의 사정이 아니라 last_generated 라는 값 자체의 뜻이다. */
    const due = origin.dueDate || f.issuedAt
    // ruleTable 은 위에서 화이트리스트로 검사했다 — 문자열 끼워 넣기가 안전한 이유다
    await conn.execute(
      `UPDATE ${origin.ruleTable} SET last_generated = ?
        WHERE id = ? AND (last_generated IS NULL OR last_generated < ?)`,
      [due, origin.recurringId, due])
  } else if (origin.type === 'milestone') {
    /* 마일스톤을 잇는다. 상태는 **매출/매입 × 정산 여부** 네 가지다 —
       '청구' 같은 값을 새로 만들면 청구 일정 화면이 못 읽는다(기존 규칙 그대로 쓴다). */
    const isPurchase = f.kind === 'received'
    const msStatus = origin.paid
      ? (isPurchase ? '지급 완료' : '입금 완료')
      : (isPurchase ? '지급 예정' : '입금 예정')
    await conn.execute('UPDATE milestones SET status = ?, invoice_id = ? WHERE id = ?',
      [msStatus, id, origin.milestoneId])
  }
  /* import·manual 은 뒤처리가 없다 — 어느 회차인지 우리가 알 수 없기 때문이다.
     그래서 이 건들은 회차를 안 닫고, '발행예정'에 회차가 남는다. **그게 맞다.**
     자동으로 닫으면 같은 달의 별개 건을 회차로 착각해 진짜 청구를 빠뜨린다(못 받는 돈이 된다).
     나중에 사람이 대사 화면에서 이어 주는 것이 이 자리의 답이다. */

  return { id, invoiceNo, lines }
}

module.exports = { createInvoice, nextInvoiceNo, ORIGINS }
