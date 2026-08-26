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

const { transactionVoucher, withNames } = require('./voucher')

/**
 * 기간 안의 거래를 전표로 만든다.
 * @param db      req.db (테넌트 연결)
 * @param from,to 'YYYY-MM-DD'
 * @param kind    'all' | 'income' | 'expense'
 */
async function listVouchers(db, { from, to, kind = 'all' }) {
  const where = ['t.date >= ?', 't.date <= ?']
  const args = [from, to]
  if (kind === 'income' || kind === 'expense') { where.push('t.kind = ?'); args.push(kind) }

  const [rows] = await db.execute(`
    SELECT t.id, t.kind, t.amount, t.date, t.category, t.memo, t.account_code,
           a.acct_code AS bank_code, a.name AS account_name, v.name AS vendor_name
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      LEFT JOIN vendors  v ON v.id = t.vendor_id
     WHERE ${where.join(' AND ')}
     ORDER BY t.date, t.id`, args)

  /* 계정과목 이름은 한 번에 붙인다. 전표마다 withNames 를 부르면 거래 수만큼
     같은 조회가 반복돼, 한 분기(수백 건)를 뽑을 때 눈에 띄게 느려진다. */
  const vouchers = rows.map(t => ({
    ...transactionVoucher(t),
    kind: t.kind,
    amount: Number(t.amount) || 0,
    vendor_name: t.vendor_name || '',
    account_name: t.account_name || '',
    memo: t.memo || '',
    category: t.category || '',
  }))
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
