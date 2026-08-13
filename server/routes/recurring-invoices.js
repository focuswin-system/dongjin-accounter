const { Router } = require('express')
const { randomUUID } = require('crypto')
const { futureDateError, kstToday, kstDate } = require('../db')
const { dueDatesToGenerate, addDays, LOOKAHEAD_DAYS, pendingCycle , PAYMENT_TERM_DAYS, cashDateOf, PAY_TERMS } = require('../lib/recurrence')
const { rollbackQuietly } = require('../lib/tx')
const { ledgerError, amountError } = require('../lib/ledger')
const { taxTypeOfMode, recurFromSupply, recurVat } = require('../lib/vat')
const { closedPeriodError } = require('../lib/closing')
const { backfillCycles, tooManyError, addSkip, removeSkip, issuedInvoiceAt } = require('../lib/backfill')
const { settleAcctCode } = require('../lib/acctCode')

const router = Router()

/** 결제조건은 정해진 셋 중 하나만 받는다(정기지출과 같은 규칙) */
const payTermOf = (v) => (PAY_TERMS.includes(v) ? v : 'net30')

/* 정기청구로 발행하는 청구서의 과세유형.
   정기청구 규칙의 vat_mode는 exclusive/none 두 값뿐이라 면세와 영세를 구분하지 못한다
   → 계약에 걸린 정기청구면 계약의 vat_mode(taxable/exempt/zero)를 따른다. */
const invTaxType = (r) => (r.contract_vat_mode
  ? taxTypeOfMode(r.contract_vat_mode)
  : recurVat(r.vat_mode).tax)   // exclusive→과세 / none→면세 / zero→영세

/* 세액 계산에 쓸 vat_mode. 과세유형(invTaxType)과 '같은 소스'여야 한다.
   예전엔 세액은 규칙 vat_mode로, 과세유형은 계약 vat_mode로 정해서
   면세·영세 계약에 10% 세액이 붙은 청구서가 나갔다(고객 과청구 + 신고자료 불일치). */
const effVatMode = (r) => (r.contract_vat_mode
  ? (r.contract_vat_mode === 'exempt' ? 'none' : r.contract_vat_mode === 'zero' ? 'zero' : 'exclusive')
  : r.vat_mode)

router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute(`
      SELECT r.*, v.name AS vendor_name, c.name AS contract_name
      FROM recurring_invoices r
      LEFT JOIN vendors v   ON r.vendor_id = v.id
      LEFT JOIN contracts c ON r.contract_id = c.id
      ORDER BY r.day_of_month
    `)
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { vendor_id, contract_id, item, supply_amount, vat_mode, period, day_of_month, start_date, end_date, account_id } = req.body
    const id = randomUUID()
    /* start_date 는 NOT NULL 인데 아무 검사가 없었다 — 값이 안 오면 mysql2 가 던져 500이 났다
       (정기지출 쪽은 이미 400으로 막고 있었는데 여기만 빠져 있었다).
       다만 여기서 400으로 거절하지는 않는다. 시작일이 모호한 무기한 계약이 흔하고,
       비워 두면 **등록일부터** 세도록 엔진이 받아준다(lib/recurrence.js 앵커 폴백).
       빈 문자열은 '미지정'을 뜻한다. */
    await req.db.execute(
      'INSERT INTO recurring_invoices (id, vendor_id, contract_id, item, supply_amount, vat_mode, period, day_of_month, start_date, end_date, account_id, pay_term) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, vendor_id||null, contract_id||null, item||'', supply_amount, vat_mode||'exclusive', period||'monthly', day_of_month||1, start_date||'', end_date||null, account_id||null, payTermOf(req.body.pay_term)]
    )
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { vendor_id, contract_id, item, supply_amount, vat_mode, period, day_of_month, start_date, end_date, account_id } = req.body
    // pay_term 이 빠져 있어서, 등록할 때 고른 결제조건을 수정 화면에서 바꿔도 저장되지 않았다
    const [result] = await req.db.execute(
      'UPDATE recurring_invoices SET vendor_id=?, contract_id=?, item=?, supply_amount=?, vat_mode=?, period=?, day_of_month=?, start_date=?, end_date=?, account_id=?, pay_term=? WHERE id=?',
      [vendor_id||null, contract_id||null, item||'', supply_amount, vat_mode||'exclusive', period||'monthly', day_of_month||1, start_date, end_date||null, account_id||null, payTermOf(req.body.pay_term), req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/**
 * 정기청구 삭제 — '앞으로 자동 발행하지 않는다'는 뜻이다.
 * 이미 발행된 청구서·거래는 지우지 않는다(실제 돈 기록). 자세한 배경은 routes/recurring.js 참고.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const [[rec]] = await req.db.execute('SELECT id FROM recurring_invoices WHERE id = ?', [req.params.id])
    if (!rec) return res.status(404).json({ error: 'Not found' })
    const [[kept]] = await req.db.execute(
      `SELECT (SELECT COUNT(*) FROM invoices     WHERE recurring_id = ?) AS invs,
              (SELECT COUNT(*) FROM transactions WHERE recurring_id = ?) AS txns`,
      [req.params.id, req.params.id])
    /* 건너뛴 기록도 함께 지운다. 규칙이 없어지면 이 행들은 아무 데서도 안 읽히는 고아가 되고,
       같은 id 가 재사용되진 않지만 테이블에 계속 쌓인다. 청구서·거래와 달리 장부가 아니라
       '이 규칙의 그 회차를 건너뛴다'는 설정값이므로 규칙과 수명을 같이한다. */
    await req.db.execute("DELETE FROM recurring_skips WHERE kind = 'invoice' AND recurring_id = ?", [req.params.id])
    await req.db.execute('DELETE FROM recurring_invoices WHERE id = ?', [req.params.id])
    res.json({ ok: true, keptInvoices: Number(kept.invs) || 0, keptTxns: Number(kept.txns) || 0 })
  } catch (e) { next(e) }
})

router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT active FROM recurring_invoices WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const newActive = rows[0].active ? 0 : 1
    await req.db.execute('UPDATE recurring_invoices SET active = ? WHERE id = ?', [newActive, req.params.id])
    res.json({ active: !!newActive })
  } catch (e) { next(e) }
})

// 청구 예정 회차(아직 청구서가 안 만들어진 회차) — 대금청구 '발행 예정' 목록에 계약 청구일정과 함께 뜬다.
// 경리가 청구서 메뉴 한 곳만 열면 이번 달 청구할 게 다 보이게 하기 위함.
router.get('/pending', async (req, res, next) => {
  try {
    const [recs] = await req.db.execute(`
      SELECT r.*, UNIX_TIMESTAMP(r.created_at) AS created_epoch,
             v.name AS vendor_name, c.name AS contract_name, c.contract_no,
             c.vat_mode AS contract_vat_mode
      FROM recurring_invoices r
      LEFT JOIN vendors v   ON r.vendor_id = v.id
      LEFT JOIN contracts c ON r.contract_id = c.id
      WHERE r.active = 1`)
    const today = kstToday()
    // 건너뛴 회차는 계산에서 빼고, 목록 맨 아래에 따로 보여준다(되돌릴 수 있어야 하므로)
    const [skipRows] = await req.db.execute(
      "SELECT recurring_id, due_date, reason FROM recurring_skips WHERE kind = 'invoice'")
    const skipBy = new Map()
    for (const s of skipRows) {
      if (!skipBy.has(s.recurring_id)) skipBy.set(s.recurring_id, [])
      skipBy.get(s.recurring_id).push(s)
    }
    const out = []
    for (const r of recs) {
      r.setup_date = kstDate(Number(r.created_epoch) * 1000) // 등록일(KST) — 소급 하한
      r.skips = (skipBy.get(r.id) || []).map(s => String(s.due_date).slice(0, 10))
      // 다가오는 회차(LOOKAHEAD_DAYS)까지 미리 노출 — 경리가 대금청구서를 미리 발행할 수 있게.
      for (const due of dueDatesToGenerate(r, today, { horizonDays: LOOKAHEAD_DAYS })) {
        const supply = Number(r.supply_amount)
        const vat = recurFromSupply(supply, effVatMode(r)).vat
        out.push(pendingCycle(r, due, today, {
          source: 'recurring',
          type: '정기청구',
          item: r.item || '',
          amount: supply,
          vat,
          // 계약 이름이 없으면 항목으로 대신 표시(계약 무관 정기청구)
          contract_name: r.contract_name || r.item || '',
        }))
      }
      /* 건너뛴 회차도 실어 보낸다(state='skipped'). 감추기만 하면 되돌릴 방법이 없어진다 —
         "왜 이 달만 없지"를 화면에서 바로 확인하고 되살릴 수 있어야 한다. */
      for (const s of (skipBy.get(r.id) || [])) {
        const due = String(s.due_date).slice(0, 10)
        const supply = Number(r.supply_amount)
        out.push({
          ...pendingCycle(r, due, today, {
            source: 'recurring', type: '정기청구', item: r.item || '',
            amount: supply, vat: recurFromSupply(supply, effVatMode(r)).vat,
            contract_name: r.contract_name || r.item || '',
            skip_reason: s.reason || '',
          }),
          state: 'skipped',
        })
      }
    }
    out.sort((a, b) => a.due_date.localeCompare(b.due_date))
    res.json(out)
  } catch (e) { next(e) }
})

// 정기청구 회차 1건만 발행 (발행 예정 목록에서 건별로 누르는 경우).
// 앞선 회차를 건너뛰고 발행하면 last_generated 때문에 그 앞 회차가 영영 안 뜨므로,
// 가장 이른 미생성 회차만 발행하도록 제한한다.
router.post('/:id/issue', async (req, res, next) => {
  const { due, paid, account_id } = req.body
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[r]] = await conn.execute(
      "SELECT r.*, UNIX_TIMESTAMP(r.created_at) AS created_epoch, c.vat_mode AS contract_vat_mode FROM recurring_invoices r LEFT JOIN contracts c ON r.contract_id = c.id WHERE r.id = ? FOR UPDATE",
      [req.params.id]
    )
    if (!r) { await rollbackQuietly(conn); return res.status(404).json({ error: '정기청구를 찾을 수 없어요' }) }
    r.setup_date = kstDate(Number(r.created_epoch) * 1000)
    // pending과 동일한 미리보기 범위 — 발행 예정에 뜬 미래 회차를 그대로 발행할 수 있어야 한다.
    const dues = dueDatesToGenerate(r, kstToday(), { horizonDays: LOOKAHEAD_DAYS })
    if (dues.length === 0) { await rollbackQuietly(conn); return res.status(409).json({ error: '발행할 회차가 없어요' }) }
    const target = due || dues[0]
    if (target !== dues[0]) {
      await rollbackQuietly(conn)
      return res.status(409).json({ error: `앞선 회차(${dues[0]})부터 발행해주세요` })
    }
    // 미래 회차는 미수(입금 예정) 청구서로만 미리 발행 가능. 기입금(paid)은 실제 입금 거래가
    // 생기므로 미래 일자 금지 — 다른 발행 경로(계약 청구일정·거래·세금)와 동일한 규칙.
    if (paid) {
      const de = futureDateError(target)
      if (de) { await rollbackQuietly(conn); return res.status(400).json({ error: de }) }
      // 기입금은 실제 거래를 만든다 → 마감된 달이면 막는다(지출 쪽과 대칭)
      const ce = await closedPeriodError(conn, target)
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) }
    }

    const year = target.slice(0, 4)
    const [[{ maxno }]] = await conn.execute(
      "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind='issued' AND invoice_no LIKE ?",
      [`청구-${year}-%`]
    )
    const invoice_no = `청구-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
    const supply = Number(r.supply_amount)
    const vat    = recurFromSupply(supply, effVatMode(r)).vat
    const total  = supply + vat
    // 발행 즉시 정산(기입금) 시 반영할 계좌: 사용자가 고른 계좌 > 정기청구 규칙 계좌 > 주거래(첫 은행).
    let acctId = account_id || r.account_id || null
    if (paid && !acctId) {
      const [[defBank]] = await conn.execute("SELECT id FROM accounts WHERE kind='bank' ORDER BY created_at LIMIT 1")
      acctId = defBank ? defBank.id : null
    }
    const id = randomUUID()
    /* 마감된 달로는 청구서를 발행할 수 없다. 예전엔 paid 일 때만 검사해서, 마감·신고를 끝낸
     * 달로 청구서만 새로 꽂을 수 있었다 → 그 분기 부가세 집계가 신고 후에 바뀐다. */
    { const ce = await closedPeriodError(conn, target); if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: ce }) } }
    // 금액 없는 정기청구가 매달 0원 청구서를 찍어내면 미수금 목록만 부풀린다.
    { const ae = amountError(total); if (ae) { await rollbackQuietly(conn); return res.status(400).json({ error: ae }) } }
    await conn.execute(
      'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, recurring_id, memo, tax_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, invoice_no, 'issued', r.vendor_id || null, r.contract_id || null, supply, vat, total,
       target, cashDateOf(target, r.pay_term), paid ? '입금 완료' : '입금 예정', acctId, r.id,
       `정기청구 · ${r.item || ''}`.trim(), invTaxType(r)]
    )
    // 기입금 처리: 실제 입금 거래 + 매칭까지 (계약 상세의 수금·미수금에 반영)
    if (paid) {
      const lerr = ledgerError({ kind: 'income', account_id: acctId, status: '입금완료' })
      if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: lerr }) }
      const txnId = randomUUID()
      await conn.execute(
        `INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, account_code, category, amount, date, method, status, doc_no, invoice_id, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [txnId, 'income', r.vendor_id || null, r.contract_id || null, acctId,
         settleAcctCode('income'),   // 외상매출금 — 없으면 일계표 차·대변이 안 맞는다
         '수금', total, target, '계좌이체', '입금완료', '', id, `청구서 ${invoice_no} 정산`]
      )
      await conn.execute('INSERT INTO invoice_matches (id, invoice_id, txn_id, amount, txn_created) VALUES (?,?,?,?,1)',
        [randomUUID(), id, txnId, total])
    }
    await conn.execute('UPDATE recurring_invoices SET last_generated = ? WHERE id = ?', [target, r.id])
    await conn.commit()
    res.json({ ok: true, id, invoice_no })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/**
 * 놓친 회차 일괄 발행 — 예정일이 지났는데 청구서가 없는 회차를 모두 '입금 예정'으로 만든다.
 *
 * 미래 회차는 대상이 아니고(미수금 조기 부풀림 방지), 소급 범위는 등록일(setup_date)부터다 —
 * 2020년 시작 계약을 올해 등록해도 등록일 이전 회차는 만들어지지 않는다.
 * 계좌를 건드리지 않는다(입금 처리 아님) — 실제 입금 확인 없이 잔액을 움직이지 않기 위해.
 * (매입 정기지출 /issue-missed와 대칭)
 */
router.post('/issue-missed', async (req, res, next) => {
  const today = kstToday()
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    // FOR UPDATE — 일괄이 두 번 겹쳐 돌면 같은 last_generated를 읽어 같은 회차를 두 벌 발행한다.
    // (FOR UPDATE OF r 로 좁히지 않는다 — MariaDB 버전에 따라 지원이 갈린다. 짧은 트랜잭션이라 무해)
    const [recs] = await conn.execute("SELECT r.*, UNIX_TIMESTAMP(r.created_at) AS created_epoch, c.vat_mode AS contract_vat_mode FROM recurring_invoices r LEFT JOIN contracts c ON r.contract_id = c.id WHERE r.active = 1 FOR UPDATE")
    const generated = []

    for (const r of recs) {
      r.setup_date = kstDate(Number(r.created_epoch) * 1000)
      // 일괄 생성은 오늘까지 도래한 회차만 실제 청구서로 만든다(미래분 미수금 조기 부풀림 방지).
      // 소급 범위는 setup_date(등록일)부터 — 과거 무기한 계약이 수백 건 쏟아지지 않게.
      const dues = dueDatesToGenerate(r, today)
      if (!dues.length) continue

      for (const dueStr of dues) {
        const year = dueStr.slice(0, 4)
        // 채번: 최대 일련번호+1 (issue/수동 발행과 동일 방식 — 삭제 후 번호 재사용/중복 방지)
        const [[{ maxno }]] = await conn.execute(
          "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind='issued' AND invoice_no LIKE ?",
          [`청구-${year}-%`]
        )
        const invoice_no = `청구-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`
        const supply = Number(r.supply_amount)
        const vat    = recurFromSupply(supply, effVatMode(r)).vat
        const total  = supply + vat
        // 결제조건을 따른다 — 건별 발행과 같은 함수여야 어느 버튼을 눌러도 날짜가 같다
        const dueAt  = cashDateOf(dueStr, r.pay_term)
        const id = randomUUID()
        /* 마감된 달이 하나라도 섞이면 전체를 거절한다 — 회차 순서를 건너뛸 수 없으므로
         * 일부만 처리하면 남은 회차를 영영 못 넣는다(대출·적금 일괄과 같은 규칙). */
        { const ce = await closedPeriodError(conn, dueStr)
          if (ce) { await rollbackQuietly(conn)
            return res.status(409).json({ error: `${dueStr} 회차가 마감된 달이라 전체를 처리하지 않았어요. ${ce}` }) } }
        /* 금액이 0이면 회차마다 0원 청구서가 찍힌다. 위 마감과 같은 이유로 전체를 세운다 —
         * 금액은 회차가 아니라 정기청구 설정에서 오므로, 한 회차가 0이면 나머지도 전부 0이다. */
        { const ae = amountError(total)
          if (ae) { await rollbackQuietly(conn)
            return res.status(400).json({ error: `${ae} (정기청구 "${r.item || ''}"의 금액을 확인해주세요)` }) } }
        await conn.execute(
          'INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount, issued_at, due_at, status, account_id, recurring_id, memo, tax_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, invoice_no, 'issued', r.vendor_id||null, r.contract_id||null, supply, vat, total, dueStr, dueAt, '입금 예정', r.account_id||null, r.id, `정기청구 자동 생성 · ${r.item||''}`.trim(), invTaxType(r)]
        )
        generated.push({ id, invoice_no, vendor_id: r.vendor_id, item: r.item, total, date: dueStr })
      }
      await conn.execute('UPDATE recurring_invoices SET last_generated = ? WHERE id = ?', [dues[dues.length - 1], r.id])
    }

    await conn.commit()
    res.json({ ok: true, count: generated.length, generated })
  } catch (e) {
    await rollbackQuietly(conn)
    next(e)
  } finally {
    conn.release()
  }
})

// 반복일 계산·날짜 가산은 ../lib/recurrence(dueDatesToGenerate·addDays)로 공용화.

/* ── 회차 건너뛰기 ────────────────────────────────────────────────
 * "이 달은 청구 안 함"을 발행 대기에서 바로 처리한다. 배경은 lib/backfill.js 참고. */
router.post('/:id/skip', async (req, res, next) => {
  try {
    const due = String(req.body.due_date || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ error: '건너뛸 회차 날짜가 필요해요' })
    const [[r]] = await req.db.execute('SELECT id FROM recurring_invoices WHERE id = ?', [req.params.id])
    if (!r) return res.status(404).json({ error: '정기청구를 찾을 수 없어요' })
    /* 이미 청구서가 나갔으면 건너뛰기가 아니다 — 숨기기만 하면 청구서는 그대로 남아
       미수금에 잡힌 채 목록에서만 사라진다. 삭제로 안내한다. */
    const inv = await issuedInvoiceAt(req.db, req.params.id, due)
    if (inv) return res.status(409).json({ error: `이 회차는 이미 ${inv.invoice_no}로 발행됐어요. 청구서를 삭제해주세요.` })
    await addSkip(req.db, 'invoice', req.params.id, due, req.body.reason)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id/skip/:due', async (req, res, next) => {
  try {
    const n = await removeSkip(req.db, 'invoice', req.params.id, req.params.due)
    if (!n) return res.status(404).json({ error: '건너뛴 기록을 찾을 수 없어요' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/* ── 소급 등록 마법사 ─────────────────────────────────────────────
 * 등록일 하한을 없애지 않고, 사용자가 연 기간만 만든다. 자세한 배경은 lib/backfill.js 참고.
 */

/** 1) 미리보기 — 이 기간에 무엇이 생기는지, 무엇이 막히는지 먼저 보여준다. */
router.post('/:id/backfill/preview', async (req, res, next) => {
  try {
    const { from, to } = req.body
    if (!from) return res.status(400).json({ error: '소급 시작일을 선택해주세요' })
    const today = kstToday()
    // 미래는 대상이 아니다 — 기존 '발행 예정'이 담당한다(미수금 조기 부풀림 방지).
    const end = (!to || to > today) ? today : to
    if (from > end) return res.status(400).json({ error: '시작일이 종료일보다 뒤예요' })

    const [[r]] = await req.db.execute(
      `SELECT r.*, v.name AS vendor_name, c.vat_mode AS contract_vat_mode
       FROM recurring_invoices r LEFT JOIN vendors v ON r.vendor_id = v.id
       LEFT JOIN contracts c ON r.contract_id = c.id WHERE r.id = ?`, [req.params.id])
    if (!r) return res.status(404).json({ error: '정기청구를 찾을 수 없어요' })

    const dues = backfillCycles(r, from, end)
    const over = tooManyError(dues.length)
    if (over) return res.status(400).json({ error: over, count: dues.length })

    const supply = Number(r.supply_amount)
    const vat = recurFromSupply(supply, effVatMode(r)).vat
    const cycles = []
    for (const due of dues) {
      // 이미 있는가 — 하한이 아니라 실제 장부를 본다(중간에 지운 회차를 되살릴 수 있어야 한다)
      const [[dup]] = await req.db.execute(
        'SELECT id, invoice_no FROM invoices WHERE recurring_id = ? AND issued_at = ? LIMIT 1', [r.id, due])
      // 마감된 달인가 — 소급은 대개 신고가 끝난 기간에 꽂는 일이라 이게 핵심 가드다
      const closed = await closedPeriodError(req.db, due)
      cycles.push({
        due_date: due, supply_amount: supply, vat_amount: vat, total_amount: supply + vat,
        exists: !!dup, existing_no: dup ? dup.invoice_no : null,
        closed: !!closed, closed_reason: closed || null,
      })
    }
    res.json({
      item: r.item || '', vendor_name: r.vendor_name || '', from, to: end,
      cycles,
      // 화면이 기본 체크를 정하는 근거 — 이미 있거나 마감된 회차는 꺼둔다
      selectable: cycles.filter(c => !c.exists && !c.closed).length,
    })
  } catch (e) { next(e) }
})

/** 2) 일괄 생성 — 화면에서 고른 회차만. 금액은 회차별로 바뀔 수 있다(임차료 인상 등). */
router.post('/:id/backfill', async (req, res, next) => {
  const cycles = Array.isArray(req.body.cycles) ? req.body.cycles : []
  if (cycles.length === 0) return res.status(400).json({ error: '만들 회차를 선택해주세요' })
  const over = tooManyError(cycles.length)
  if (over) return res.status(400).json({ error: over })

  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [[r]] = await conn.execute(
      `SELECT r.*, c.vat_mode AS contract_vat_mode FROM recurring_invoices r
       LEFT JOIN contracts c ON r.contract_id = c.id WHERE r.id = ? FOR UPDATE`, [req.params.id])
    if (!r) { await rollbackQuietly(conn); return res.status(404).json({ error: '정기청구를 찾을 수 없어요' }) }

    const batch = randomUUID()
    const today = kstToday()
    const created = []
    for (const c of cycles.slice().sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))) {
      const due = String(c.due_date || '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) { await rollbackQuietly(conn); return res.status(400).json({ error: `회차 날짜가 올바르지 않아요 (${due})` }) }
      if (due > today) { await rollbackQuietly(conn); return res.status(400).json({ error: `${due}는 미래예요. 소급은 과거 회차만 만듭니다.` }) }
      /* 마감된 달은 하나라도 섞이면 전체를 거절한다. 일부만 만들면 사용자는 전부 된 줄 안다 —
         '무엇이 빠지는지 먼저 보여주고 사용자가 마감을 풀지 결정'하는 게 이 기능의 규칙이다. */
      const ce = await closedPeriodError(conn, due)
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: `${due} 회차가 마감된 달이라 아무것도 만들지 않았어요. ${ce}` }) }
      // 중복 — 미리보기 이후 다른 사람이 만들었을 수 있으므로 여기서 다시 본다
      const [[dup]] = await conn.execute(
        'SELECT id FROM invoices WHERE recurring_id = ? AND issued_at = ? LIMIT 1', [r.id, due])
      if (dup) continue

      const supply = Number(c.supply_amount) >= 0 ? Number(c.supply_amount) : Number(r.supply_amount)
      const vat = Number.isFinite(Number(c.vat_amount)) ? Number(c.vat_amount) : recurFromSupply(supply, effVatMode(r)).vat
      const total = supply + vat
      const ae = amountError(total)
      if (ae) { await rollbackQuietly(conn); return res.status(400).json({ error: `${due} 회차 — ${ae}` }) }

      const year = due.slice(0, 4)
      const [[{ maxno }]] = await conn.execute(
        "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(invoice_no, '-', -1) AS UNSIGNED)), 0) AS maxno FROM invoices WHERE kind='issued' AND invoice_no LIKE ?",
        [`청구-${year}-%`])
      const invoice_no = `청구-${year}-${String(Number(maxno) + 1).padStart(4, '0')}`

      // 과거 회차는 대부분 이미 돈이 오갔다 → 기입금이면 거래·매칭까지 만든다
      const paid = !!c.paid
      let acctId = c.account_id || r.account_id || null
      if (paid && !acctId) {
        const [[defBank]] = await conn.execute("SELECT id FROM accounts WHERE kind='bank' ORDER BY created_at LIMIT 1")
        acctId = defBank ? defBank.id : null
      }
      const id = randomUUID()
      await conn.execute(
        `INSERT INTO invoices (id, invoice_no, kind, vendor_id, contract_id, supply_amount, vat_amount, total_amount,
                               issued_at, due_at, status, account_id, recurring_id, memo, tax_type, backfill_batch)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, invoice_no, 'issued', r.vendor_id || null, r.contract_id || null, supply, vat, total,
         due, cashDateOf(due, r.pay_term), paid ? '입금 완료' : '입금 예정', acctId, r.id,
         `소급 등록 · ${r.item || ''}`.trim(), invTaxType(r), batch])

      if (paid) {
        const lerr = ledgerError({ kind: 'income', account_id: acctId, status: '입금완료' })
        if (lerr) { await rollbackQuietly(conn); return res.status(400).json({ error: `${due} 회차 — ${lerr}` }) }
        const txnId = randomUUID()
        await conn.execute(
          `INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, account_code, category, amount, date, method, status, doc_no, invoice_id, memo, backfill_batch)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [txnId, 'income', r.vendor_id || null, r.contract_id || null, acctId, settleAcctCode('income'),
           '수금', total, due, '계좌이체', '입금완료', '', id, `청구서 ${invoice_no} 정산 (소급)`, batch])
        await conn.execute('INSERT INTO invoice_matches (id, invoice_id, txn_id, amount, txn_created) VALUES (?,?,?,?,1)',
          [randomUUID(), id, txnId, total])
      }
      created.push({ id, invoice_no, due_date: due, total, paid })
    }

    /* last_generated 는 '이 값 이하 회차는 이미 생성됨' 하한이다. 소급으로 만든 회차가
       기존 하한보다 뒤면 밀어준다. 앞이면 건드리지 않는다 — 낮추면 이미 만든 뒤 회차가
       다시 '놓친 회차'로 살아나 중복 청구가 된다. */
    const last = created.length ? created[created.length - 1].due_date : null
    if (last && (!r.last_generated || last > String(r.last_generated).slice(0, 10))) {
      await conn.execute('UPDATE recurring_invoices SET last_generated = ? WHERE id = ?', [last, r.id])
    }
    await conn.commit()
    res.json({ ok: true, batch, count: created.length, created })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

/** 3) 되돌리기 — 이 배치로 만든 것만 통째로. 잘못된 범위로 수십 건을 만들면 하나씩은 못 지운다. */
router.delete('/backfill/:batch', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.execute(
      'SELECT id, invoice_no, issued_at, recurring_id FROM invoices WHERE backfill_batch = ? FOR UPDATE', [req.params.batch])
    if (rows.length === 0) { await rollbackQuietly(conn); return res.status(404).json({ error: '되돌릴 묶음을 찾을 수 없어요' }) }
    /* 마감된 달이 섞였으면 되돌리기도 막는다 — 마감 후 장부가 바뀌는 건 만들 때든 지울 때든 같다. */
    for (const inv of rows) {
      const ce = await closedPeriodError(conn, String(inv.issued_at).slice(0, 10))
      if (ce) { await rollbackQuietly(conn); return res.status(409).json({ error: `${inv.invoice_no}(${String(inv.issued_at).slice(0, 10)})가 마감된 달이라 되돌리지 않았어요. ${ce}` }) }
    }
    // ⚠ recurring_id 는 **지우기 전에** 챙긴다(지운 뒤 조회하면 빈 결과다)
    const recurringId = rows.find(r => r.recurring_id)?.recurring_id || null

    const ids = rows.map(r => r.id)
    const ph = ids.map(() => '?').join(',')
    // 매칭 → 거래 → 청구서 순. 이 배치가 만든 거래만 지운다(backfill_batch 로 한정).
    await conn.execute(`DELETE FROM invoice_matches WHERE invoice_id IN (${ph})`, ids)
    await conn.execute('DELETE FROM transactions WHERE backfill_batch = ?', [req.params.batch])
    await conn.execute(`DELETE FROM invoices WHERE id IN (${ph})`, ids)
    /* last_generated 는 **남은 청구서에서 다시 계산한다.**
     *
     * '지운 것 중 가장 이른 날짜 - 1일'로 낮추면 안 된다. 소급 배치가 3~5월이고 6~8월은
     * 평소 경로로 발행돼 있다면, 하한을 2월로 낮추는 순간 **6~8월이 '놓친 회차'로 되살아나
     * 중복 청구**가 된다(lib/recurrence.js restoreLastGenerated 가 같은 이유로 막는 상황).
     * 실제 장부의 최대 발행일을 쓰면 지운 회차만 정확히 다시 열린다. */
    if (recurringId) {
      const [[m]] = await conn.execute(
        'SELECT MAX(issued_at) AS last FROM invoices WHERE recurring_id = ?', [recurringId])
      await conn.execute('UPDATE recurring_invoices SET last_generated = ? WHERE id = ?',
        [m && m.last ? String(m.last).slice(0, 10) : null, recurringId])
    }
    await conn.commit()
    res.json({ ok: true, count: rows.length })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

module.exports = router
