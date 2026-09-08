/**
 * 전표 목록(분개장) — 기간 안의 거래를 차변·대변 줄로 펼친다.
 *
 * 신고철에 세무사에게 넘기거나 회계 프로그램에 올릴 때 쓰는 형태다.
 * 지금까지는 전표를 **한 건씩만** 볼 수 있었고(VoucherView), 하루치 집계가 일계표였다.
 * 기간 전체를 뽑을 길이 없어 그때마다 거래내역 CSV 를 받아 손으로 분개를 만들었다.
 *
 * ⚠ 분개는 **화면에서 다시 만들지 않는다.** lib/voucher.js 한 곳에서만 만든다 —
 *   같은 거래가 화면과 파일에서 다른 분개로 나오면 어느 쪽이 장부인지 알 수 없다.
 *
 * ⚠ 짝이 안 맞는 전표(계정과목이 비어 한쪽 다리가 없는 것)를 **감추지 않는다.**
 *   빼고 내보내면 합계가 맞아 보이지만 그 거래는 장부에서 사라진다.
 *   그대로 세우고 '확인 필요'로 표시해, 받는 사람이 물어볼 수 있게 한다.
 */

const { transactionVoucher, invoiceVoucher, noteVoucher, noteDishonorVoucher } = require('./voucher')

/**
 * 기간 안의 거래를 전표로 만든다.
 * @param db      req.db (테넌트 연결)
 * @param from,to 'YYYY-MM-DD'
 * @param kind    'all' | 'income' | 'expense'
 */
async function listVouchers(db, { from, to, kind = 'all', includeIssuance = true }) {
  const where = ['t.date >= ?', 't.date <= ?']
  const args = [from, to]
  if (kind === 'income' || kind === 'expense') { where.push('t.kind = ?'); args.push(kind) }

  const [rows] = await db.execute(`
    SELECT t.id, t.kind, t.amount, t.date, t.category, t.memo, t.account_code, t.has_splits,
           a.acct_code AS bank_code, a.name AS account_name, v.name AS vendor_name
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      LEFT JOIN vendors  v ON v.id = t.vendor_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.date, t.id`, args)

  /* 복합 현금 전표(D1) — 여러 비목으로 갈린 거래는 splits 를 붙여 전표를 여러 줄로 편다.
     한 번에 모아 읽어(줄마다 조회하지 않는다) 각 거래에 매단다. */
  const splitIds = rows.filter(r => r.has_splits).map(r => r.id)
  if (splitIds.length) {
    const [sp] = await db.execute(
      `SELECT txn_id, account_code, supply_amount, vat_amount, amount
         FROM txn_splits WHERE txn_id IN (${splitIds.map(() => '?').join(',')})
        ORDER BY sort_order, id`, splitIds)
    const by = new Map()
    for (const s of sp) { if (!by.has(s.txn_id)) by.set(s.txn_id, []); by.get(s.txn_id).push(s) }
    for (const r of rows) if (by.has(r.id)) r.splits = by.get(r.id)
  }

  /* 어음 수취·발행도 전표다 — **거래가 아니라서 위 조회에 안 걸린다.**
   * 빼면 만기 결제 전표의 상대 계정(1205·2102)이 이 파일 안에서 대변에만 나타나,
   * 받는 사람(세무사·회계 프로그램)이 어디서 생긴 계정인지 알 수 없다.
   *
   * ⚠ kind 필터는 어음에도 건다 — 받을어음은 income 쪽, 지급어음은 expense 쪽으로 본다.
   *   '입금만' 뽑았는데 지급어음이 섞이면 받는 쪽이 그 파일을 못 믿는다.
   * ⚠ 부도난 어음도 뺀 적 없다(발행일 기준). 되돌리는 것은 부도일의 반대 분개다. */
  /* 발행일이든 부도일이든 기간에 걸리면 가져온다 — 부도 전표는 부도일에 서기 때문에,
     발행일만 보면 지난 분기에 받은 어음의 이번 분기 부도가 통째로 빠진다. */
  /* ⚠ 부도일은 COALESCE 로 본다 — dishonored_on 이 없는 옛 행은 만기일을 부도일로
     친다(아래 전표 생성부와 같은 규칙). 여기만 dishonored_on 을 보면 그 행의 부도
     전표가 일계표에는 서고 분개장에는 안 서서 두 장부가 다른 말을 한다. */
  const noteWhere = ['((n.issued_on >= ? AND n.issued_on <= ?) OR (COALESCE(n.dishonored_on, n.due_on) >= ? AND COALESCE(n.dishonored_on, n.due_on) <= ?))']
  const noteArgs = [from, to, from, to]
  if (kind === 'income')  noteWhere.push("n.kind = 'receivable'")
  if (kind === 'expense') noteWhere.push("n.kind = 'payable'")
  const [noteRows] = await db.execute(`
    SELECT n.id, n.kind, n.amount, n.issued_on, n.note_no, n.origin_txn_id,
           n.status, n.due_on, n.dishonored_on, n.invoice_id,
           v.name AS vendor_name,
           /* ⚠ 거래를 다시 읽지 않는다 — 만기 결제가 그 거래의 account_code 를
              어음 계정으로 덮어쓰기 때문이다. 발행 시점에 굳혀 둔 값을 쓴다. */
           n.origin_acct_code
      FROM notes n
      LEFT JOIN vendors v ON v.id = n.vendor_id
     WHERE ${noteWhere.join(' AND ')}
     ORDER BY n.issued_on, n.id`, noteArgs).catch(() => [[]])

  /* ⚠ **아직 결제되지 않은 어음이 붙어 있는 원거래는 여기서 뺀다.**
   * 거래 폼에서 결제방법을 '어음'으로 고르면 거래는 '지급 예정'으로 남고, 그 발생분개
   * (차 비용 / 대 지급어음)는 바로 위에서 만든 **어음 전표가 이미 그린다.**
   * 빼지 않으면 같은 비용이 하루에 두 번 차변에 서서 비용이 두 배가 되고,
   * 원거래 쪽은 대변 다리가 없어 '확인 필요'로도 남는다.
   *
   * 만기 결제된 어음(settled)은 예외다 — 그때 원거래는 account_code 가 어음 계정으로
   * 바뀌어 결제 분개(차 지급어음 / 대 보통예금)가 되므로, 그대로 둬야 짝이 맞는다.
   * 부도(dishonored)는 결제가 아니므로 held 와 같이 뺀다. */
  let coveredTxnIds = new Set()
  try {
    /* ⚠ **보유 중(held)** 어음만 원거래를 가린다.
     * settled : 그 거래는 결제 분개(차 어음 / 대 예금)로 바뀌었으니 그대로 세운다.
     * dishonored : 부도 처리가 그 거래의 계정을 외상으로 옮겨 놓았다. 나중에 현금으로
     *   갚으면 '차 외상매입금 / 대 예금'이 되어 부도 전표와 짝이 맞는다 — 가리면
     *   그 지급이 분개장에서 통째로 사라진다(일계표에는 서므로 두 장부가 어긋난다). */
    const [ns] = await db.execute(
      "SELECT origin_txn_id FROM notes WHERE origin_txn_id IS NOT NULL AND status = 'held'")
    coveredTxnIds = new Set(ns.map(n => n.origin_txn_id))
  } catch { /* notes 테이블이 없는 DB — 어음을 안 쓰는 것이니 뺄 것도 없다 */ }

  /* 계정과목 이름은 한 번에 붙인다. 전표마다 withNames 를 부르면 거래 수만큼
     같은 조회가 반복돼, 한 분기(수백 건)를 뽑을 때 눈에 띄게 느려진다. */
  const vouchers = rows.filter(t => !coveredTxnIds.has(t.id)).map(t => ({
    ...transactionVoucher(t),
    kind: t.kind,
    amount: Number(t.amount) || 0,
    vendor_name: t.vendor_name || '',
    account_name: t.account_name || '',
    memo: t.memo || '',
    category: t.category || '',
  }))
  const inRange = (d) => !!d && d >= from && d <= to
  for (const nt of noteRows) {
    /* 부도난 어음은 전표가 **둘**이다 — 발행일의 수취 분개와, 부도일의 그 반대.
       반대 분개가 없으면 청구서가 미수로 되살아난 뒤에도 받을어음이 남아
       같은 돈이 두 군데 자산으로 잡힌다. */
    if (nt.status === 'dishonored' && inRange(nt.dishonored_on || nt.due_on)) {
      vouchers.push({
        ...noteDishonorVoucher(nt),
        kind: nt.kind === 'receivable' ? 'income' : 'expense',
        amount: Number(nt.amount) || 0,
        vendor_name: nt.vendor_name || '',
        account_name: '',
        memo: `어음 ${nt.note_no || ''} 부도`.trim(),
        category: '',
      })
    }
    if (!inRange(nt.issued_on)) continue
    vouchers.push({
      ...noteVoucher(nt, nt.origin_txn_id ? { account_code: nt.origin_acct_code } : null),
      kind: nt.kind === 'receivable' ? 'income' : 'expense',
      amount: Number(nt.amount) || 0,
      vendor_name: nt.vendor_name || '',
      account_name: '',            // 어음은 통장을 안 거친다
      memo: `어음 ${nt.note_no || ''}`.trim(),
      category: nt.kind === 'receivable' ? '받을어음' : '지급어음',
    })
  }
  /* ⚠ **청구서 발행도 전표다.** 여기 없어서 이 파일에는 매출 계정(4102)·부가세예수금이
   *   한 줄도 안 나왔다 — 세무사에게 넘기는 파일인데 매출이 없고, 외상매출금은 정산 거래의
   *   대변으로만 나타나 어디서 생긴 채권인지 알 수 없었다. voucher.js 머리말이
   *   "매출 계정은 평생 한 번도 찍히지 않는다. 누적하면 장부가 성립하지 않는다"고
   *   경고한 상태 그대로였다. 일계표(cashReport.dailyTrial)는 이미 세고 있어 두 장부가
   *   다른 말을 했다.
   *
   * ⚠ 회사 설정(report_prefs 'voucher_issuance')을 **일계표와 똑같이** 따른다.
   *   "은행 기준으로 돈이 오갈 때만 전표를 끊는다"는 회사(현금주의)에는 발행 분개가
   *   낯설다. 한쪽만 끄면 같은 회사의 두 장부가 또 갈린다. */
  if (includeIssuance) {
    const invWhere = ['i.issued_at >= ?', 'i.issued_at <= ?']
    const invArgs = [from, to]
    // 매출 청구서는 income 쪽, 매입은 expense 쪽으로 본다(어음 필터와 같은 규칙)
    if (kind === 'income')  invWhere.push("i.kind = 'issued'")
    if (kind === 'expense') invWhere.push("i.kind = 'received'")
    const [invs] = await db.execute(`
      SELECT i.id, i.invoice_no, i.kind, i.supply_amount, i.vat_amount, i.total_amount,
             i.issued_at, i.account_code, v.name AS vendor_name
        FROM invoices i
        LEFT JOIN vendors v ON v.id = i.vendor_id
       WHERE ${invWhere.join(' AND ')}`, invArgs)
    for (const inv of invs) {
      /* 짝이 안 맞는 것도 **감추지 않는다**(이 파일의 원칙). 비목이 없는 매입 청구서는
         차변이 비어 한 다리로 서는데, 빼면 합계는 맞아 보이지만 그 청구서가 장부에서
         사라진다. 그대로 세우고 '확인 필요'로 표시해 받는 사람이 물어볼 수 있게 한다. */
      vouchers.push({
        ...invoiceVoucher(inv),
        kind: inv.kind === 'issued' ? 'income' : 'expense',
        amount: Number(inv.total_amount) || 0,
        vendor_name: inv.vendor_name || '',
        account_name: '',            // 발행 시점엔 통장을 안 거친다
        memo: `${inv.invoice_no || ''} 발행`.trim(),
        category: '',
      })
    }
  }

  // 날짜 순으로 다시 세운다 — 어음·청구서를 뒤에 붙였으므로 그대로 두면 파일 끝에 몰린다
  vouchers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id < b.id ? -1 : 1)))

  const codes = [...new Set(vouchers.flatMap(v => v.lines.map(l => String(l.code))))]
  if (codes.length === 0) return vouchers
  const [subs] = await db.execute(
    `SELECT code, name, acct_type FROM account_subjects WHERE code IN (${codes.map(() => '?').join(',')})`, codes)
  const by = new Map(subs.map(s => [String(s.code), s]))
  return vouchers.map(v => ({
    ...v,
    lines: v.lines.map(l => ({
      ...l,
      // 표에 없는 코드(옛 데이터)는 코드를 그대로 세운다 — 빈칸이면 사라진 것처럼 보인다
      name: by.get(String(l.code))?.name || String(l.code),
      acct_type: by.get(String(l.code))?.acct_type || '',
    })),
  }))
}

/** 전표번호 — 파일 안에서만 쓰는 일련번호(날짜 순). 받는 쪽이 줄을 묶어 읽는 근거. */
const voucherNo = (v, i) => `${String(v.date).replace(/-/g, '')}-${String(i + 1).padStart(4, '0')}`

/** 전표 → 엑셀 행. 한 전표가 여러 줄이 되고, 전표번호로 묶인다. */
function toRows(vouchers) {
  const rows = []
  vouchers.forEach((v, i) => {
    const no = voucherNo(v, i)
    const head = (col) => col   // 첫 줄에만 적는 값(둘째 줄부터는 빈칸)

    /* ⚠ **줄이 하나도 없는 전표도 세운다.**
     *
     * 계좌와 계정과목이 **둘 다** 비면 lines 가 0개가 된다. 그냥 두면 그 거래는
     * 분개장에서 통째로 사라진다 — 합계는 맞아 보이는데 장부에 구멍이 난다.
     * (실데이터에서 전표 16건이 13줄로 나왔다. 세 건이 소리 없이 빠져 있었다.)
     * 금액을 알려주고 '확인' 칸에 이유를 적어, 받는 사람이 물어볼 수 있게 한다. */
    if (v.lines.length === 0) {
      rows.push([
        v.date, no, v.type, '', '(계정과목 없음)',
        v.kind === 'income' ? null : v.amount,
        v.kind === 'income' ? v.amount : null,
        v.vendor_name, v.memo || v.category,
        '계좌·계정과목이 모두 비어 분개를 만들 수 없어요',
      ])
      return
    }

    v.lines.forEach((l, li) => {
      rows.push([
        li === 0 ? head(v.date) : '',          // 같은 전표의 둘째 줄부터는 날짜를 비운다
        li === 0 ? head(no) : '',
        li === 0 ? head(v.type) : '',          // TYPE 은 이미 '입금전표·출금전표·대체전표'다
        l.code,
        l.name,
        l.side === 'debit' ? l.amount : null,
        l.side === 'credit' ? l.amount : null,
        li === 0 ? head(v.vendor_name) : '',
        li === 0 ? head(v.memo || v.category) : '',
        li === 0 ? (v.balanced ? '' : (v.missing || '차·대 불일치')) : '',
      ])
    })
  })
  return rows
}

const COLUMNS = [
  { header: '일자',       width: 12, align: 'center' },
  { header: '전표번호',   width: 15, align: 'center' },
  { header: '구분',       width: 8,  align: 'center' },
  { header: '계정코드',   width: 10, align: 'center' },
  { header: '계정과목',   width: 20 },
  { header: '차변',       width: 15, money: true },
  { header: '대변',       width: 15, money: true },
  { header: '거래처',     width: 20 },
  { header: '적요',       width: 30 },
  { header: '확인',       width: 22 },
]

const GUIDE = [
  '전표 목록 — 읽는 법',
  '',
  '• 한 전표가 여러 줄입니다. 일자·전표번호가 적힌 줄이 그 전표의 첫 줄이고, 아래 빈 줄들이 같은 전표입니다.',
  '• 차변 합계와 대변 합계는 반드시 같아야 합니다. 맨 아래 합계 줄에서 확인하세요.',
  '• 구분: 입금/출금은 현금 계정이 낀 거래, 대체는 통장·카드끼리 오간 거래입니다.',
  '• "확인" 칸에 글자가 있으면 그 전표는 짝이 안 맞습니다. 대개 거래에 계정과목을 안 골라서 한쪽 다리가 비어 있는 경우입니다.',
  '  숨기지 않고 그대로 실었습니다 — 빼면 합계는 맞아 보이지만 그 거래가 장부에서 사라집니다.',
  '• 금액의 "-" 는 0원이라는 뜻입니다.',
]

module.exports = { listVouchers, toRows, COLUMNS, GUIDE }
