const { Router } = require('express')
const { newBook, templateSheet, guideSheet, sendBook } = require('../lib/xlsxBook')
const { randomUUID } = require('crypto')
const { rollbackQuietly } = require('../lib/tx')
const { uploadMem, parseSheet } = require('../lib/xlsx-import')

const router = Router()

// 목록.
//   기본       — 사용중인 거래처만 (거래 등록 등에서 고를 대상)
//   ?all=1     — 미사용 포함 전체 (기준정보 관리 화면)
// 미사용 거래처를 기본에서 빼는 것이 이 기능의 핵심이다. 안 그러면 안 쓰는 거래처가
// 계속 드롭다운에 쌓여, 거래처가 늘수록 고르기 어려워진다.
router.get('/', async (req, res, next) => {
  try {
    const { gubu, all } = req.query
    const where = []
    const params = []
    if (gubu) { where.push('gubu = ?'); params.push(gubu) }
    if (all !== '1') where.push('active = 1')
    const sql = `SELECT * FROM vendors${where.length ? ' WHERE ' + where.join(' AND ') : ''}`
      + (gubu ? ' ORDER BY name' : ' ORDER BY gubu, name')
    const [rows] = await req.db.execute(sql, params)
    /* 목록에는 **주 계좌·주 담당자만** 얹는다. 거래처마다 전부 실으면 드롭다운 한 번에
       수백 줄이 따라온다 — 전체 목록은 상세(GET /:id)가 준다. */
    const [accs] = await req.db.execute(
      'SELECT vendor_id, bank_name, account_no, holder FROM vendor_accounts WHERE is_primary = 1')
    const [cons] = await req.db.execute(
      'SELECT vendor_id, name, role, phone, mobile FROM vendor_contacts WHERE is_primary = 1')
    const accBy = new Map(accs.map(a => [a.vendor_id, a]))
    const conBy = new Map(cons.map(c => [c.vendor_id, c]))
    res.json(rows.map(v => ({ ...v, primary_account: accBy.get(v.id) || null, primary_contact: conBy.get(v.id) || null })))
  } catch (e) { next(e) }
})

/* 사용/미사용 전환. 미사용으로 둬도 기존 거래·청구서·주문은 그대로 남는다.
 *
 * ⚠ **아직 일이 남은 거래처를 끄면 조용히 어긋난다.** 정기청구는 그대로 돌아 청구서를
 *   만들어 내는데, 정작 그 거래처는 거래 등록의 선택 목록에서 사라진다 — 들어온 돈을
 *   붙일 곳이 없어진다(fowin 마산시니어클럽: 진행중 주문 1·활성 정기입금 1을 달고 꺼져 있었고,
 *   8/25 입금 99,000원이 거래처 없이 떠 있었다).
 *   막지는 않는다. 끄는 게 맞는 경우도 있다 — 다만 **무엇이 남는지는 말해준다.** */
router.patch('/:id/active', async (req, res, next) => {
  try {
    const active = req.body.active ? 1 : 0
    const [r] = await req.db.execute('UPDATE vendors SET active = ? WHERE id = ?', [active, req.params.id])
    if (r.affectedRows === 0) return res.status(404).json({ error: '거래처를 찾을 수 없어요' })

    let pending = null
    if (!active) {
      const [[c]] = await req.db.execute(`
        SELECT (SELECT COUNT(*) FROM contracts WHERE vendor_id = ? AND status = '진행중') AS contracts,
               (SELECT COUNT(*) FROM recurring_invoices WHERE vendor_id = ? AND active = 1) AS recur_in,
               (SELECT COUNT(*) FROM recurring_expenses WHERE vendor_id = ? AND active = 1) AS recur_out,
               (SELECT COUNT(*) FROM invoices WHERE vendor_id = ?
                  AND status IN ('입금 예정','일부 입금','기한 지남','장기 미수','지급 대기','지급 예정','일부 지급')) AS open_invoices`,
        [req.params.id, req.params.id, req.params.id, req.params.id])
      const n = Number(c.contracts) + Number(c.recur_in) + Number(c.recur_out) + Number(c.open_invoices)
      if (n > 0) pending = { ...c, total: n }
    }
    res.json({ ok: true, active, pending })
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM vendors WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    const [accounts] = await req.db.execute(
      'SELECT * FROM vendor_accounts WHERE vendor_id = ? ORDER BY is_primary DESC, sort_order, created_at', [req.params.id])
    const [contacts] = await req.db.execute(
      'SELECT * FROM vendor_contacts WHERE vendor_id = ? ORDER BY is_primary DESC, sort_order, created_at', [req.params.id])
    res.json({ ...rows[0], accounts, contacts })
  } catch (e) { next(e) }
})


/* 계좌·담당자 목록 저장 — **통째로 갈아끼운다.**
 *
 * 줄 단위로 추가/수정/삭제를 주고받으면 화면과 서버가 서로 다른 순서를 들고 있을 때
 * 엉뚱한 줄이 지워진다. 목록이 몇 줄뿐이라 통째 교체가 싸고, 무엇보다 **화면에 보이는 것이
 * 곧 저장되는 것**이 된다(청구서 품목과 같은 방식).
 *
 * ⚠ lines 를 아예 안 보내면(undefined) 건드리지 않는다 — 계좌를 다루지 않는 화면의
 *   저장이 애써 넣은 계좌 목록을 지우면 안 된다(부분 수정 보존).
 */
async function replaceVendorList(db, table, vendorId, rows, cols) {
  if (!Array.isArray(rows)) return null
  await db.execute(`DELETE FROM ${table} WHERE vendor_id = ?`, [vendorId])
  const clean = rows.filter(r => cols.some(c => String(r?.[c] ?? '').trim()))
  // 주 표시가 하나도 없으면 첫 줄을 주로 삼는다 — 결제 명단이 집을 게 없으면 계좌가 비어 보인다
  const hasPrimary = clean.some(r => r.is_primary)
  let ord = 0
  for (const r of clean) {
    ord++
    const vals = cols.map(c => String(r[c] ?? '').trim() || null)
    await db.execute(
      `INSERT INTO ${table} (id, vendor_id, ${cols.join(', ')}, is_primary, memo, sort_order)
       VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?, ?, ?)`,
      [randomUUID(), vendorId, ...vals,
       (hasPrimary ? (r.is_primary ? 1 : 0) : (ord === 1 ? 1 : 0)),
       String(r.memo ?? '').trim() || null, ord])
  }
  return clean.length
}
const ACCOUNT_COLS = ['bank_name', 'account_no', 'holder']
const CONTACT_COLS = ['name', 'role', 'phone', 'mobile', 'email']

/* 이름 없는 거래처는 만들 수 없다.
 * ⚠ 여태 서버가 아무 검사도 안 해서 빈 이름이 그대로 INSERT 됐다 — 운영(dongjin 테넌트)에
 *   2026-08-13 에 14초 사이로 3건이 그렇게 생겼다. 이름 없는 거래처는 목록에서 빈 줄로 보이고,
 *   거기 붙은 돈은 "누구와 오간 돈"인지 영영 알 수 없다.
 *   화면이 막더라도 서버가 최종 판정이다 — 임포트·다른 화면·API 직접 호출이 다 여기를 지난다. */
const nameError = (name) => (String(name ?? '').trim() ? null : '거래처 이름을 입력해주세요')

router.post('/', async (req, res, next) => {
  try {
    const { name, biz_no, ceo, address, phone, gubu, type, service_type, contact, fax, email, biz_type, biz_item, pay_account,
            bank_name, bank_account, account_holder } = req.body
    { const e = nameError(name); if (e) return res.status(400).json({ error: e }) }
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO vendors (id, name, biz_no, ceo, address, phone, gubu, type, service_type, contact, fax, email, biz_type, biz_item, pay_account, bank_name, bank_account, account_holder) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, name, biz_no||'', ceo||'', address||'', phone||'', gubu||'A', type||'', service_type||'', contact||'', fax||'', email||'', biz_type||'', biz_item||'', pay_account||'', bank_name||'', bank_account||'', account_holder||'']
    )
    await replaceVendorList(req.db, 'vendor_accounts', id, req.body.accounts, ACCOUNT_COLS)
    await replaceVendorList(req.db, 'vendor_contacts', id, req.body.contacts, CONTACT_COLS)
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, biz_no, ceo, address, phone, gubu, type, service_type, contact, fax, email, biz_type, biz_item, pay_account,
            bank_name, bank_account, account_holder } = req.body
    // 수정으로도 이름을 비울 수 없다 — 만들 때만 막으면 지우는 길이 남는다
    { const e = nameError(name); if (e) return res.status(400).json({ error: e }) }
    const [result] = await req.db.execute(
      'UPDATE vendors SET name=?, biz_no=?, ceo=?, address=?, phone=?, gubu=?, type=?, service_type=?, contact=?, fax=?, email=?, biz_type=?, biz_item=?, pay_account=?, bank_name=?, bank_account=?, account_holder=? WHERE id=?',
      [name, biz_no||'', ceo||'', address||'', phone||'', gubu||'A', type||'', service_type||'', contact||'', fax||'', email||'', biz_type||'', biz_item||'', pay_account||'', bank_name||'', bank_account||'', account_holder||'', req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    await replaceVendorList(req.db, 'vendor_accounts', req.params.id, req.body.accounts, ACCOUNT_COLS)
    await replaceVendorList(req.db, 'vendor_contacts', req.params.id, req.body.contacts, CONTACT_COLS)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM vendors WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) {
    // 거래·청구서·주문이 걸려 있으면 FK가 막는다. 그대로 두면 500 일반 오류가 나가고
    // 사용자는 무엇이 문제인지 알 수 없다 — 어디를 정리해야 하는지 알려준다.
    if (e.code === 'ER_ROW_IS_REFERENCED_2' || e.errno === 1451) {
      const [[c]] = await req.db.execute(`
        SELECT
          (SELECT COUNT(*) FROM transactions WHERE vendor_id = ?) AS txns,
          (SELECT COUNT(*) FROM invoices     WHERE vendor_id = ?) AS invs,
          (SELECT COUNT(*) FROM contracts    WHERE vendor_id = ?) AS ctrs`,
        [req.params.id, req.params.id, req.params.id])
      const parts = []
      if (Number(c.txns) > 0) parts.push(`거래 ${c.txns}건`)
      if (Number(c.invs) > 0) parts.push(`청구서 ${c.invs}건`)
      if (Number(c.ctrs) > 0) parts.push(`주문 ${c.ctrs}건`)
      const detail = parts.length ? parts.join(' · ') : '연결된 자료'
      return res.status(409).json({
        error: `이 거래처에 ${detail}이 연결돼 있어 삭제할 수 없어요. 지난 기록을 지우면 장부가 어긋나요. 앞으로 안 쓰실 거면 '미사용'으로 바꿔주세요 — 선택 목록에서만 빠지고 기존 기록은 그대로 남아요.`,
      })
    }
    next(e)
  }
})

// ── 거래처 엑셀 임포트: 파싱(머리글 + 행) ──
router.post('/import/parse', uploadMem.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다' })
    res.json(parseSheet(req.file.buffer))
  } catch (e) { next(e) }
})

// ── 거래처 엑셀 임포트: 일괄 등록/갱신 ──
// items: [{ action:'insert'|'update', id?, name, gubu, type, biz_no, ceo, contact, phone, fax, email, address }]
// update는 기존 값을 유지하고 엑셀에 값이 있는 칸만 덮어쓴다(빈 칸으로 기존 정보를 지우지 않음).
/* 엑셀 일괄 업로드가 다루는 칸. 이체 정보(은행·계좌·예금주)를 함께 받는다 —
   매입처 결제내역서가 이 셋을 요구하는데, 거래처가 수십 곳이면 하나씩 손으로 넣을 수 없다. */
const VENDOR_FIELDS = ['name', 'biz_no', 'ceo', 'address', 'phone', 'gubu', 'type', 'contact', 'fax', 'email',
  'bank_name', 'bank_account', 'account_holder']
router.post('/import/commit', async (req, res, next) => {
  const conn = await req.db.getConnection()
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : []
    await conn.beginTransaction()
    let inserted = 0, updated = 0
    const createdNames = []
    for (const it of items) {
      const name = String(it.name || '').trim()
      if (!name) continue
      const gubu = ['A', 'B', 'E'].includes(it.gubu) ? it.gubu : 'A'
      if (it.action === 'update' && it.id) {
        const [rows] = await conn.execute('SELECT * FROM vendors WHERE id = ?', [it.id])
        const cur = rows[0]
        if (!cur) continue
        const merged = {}
        for (const k of VENDOR_FIELDS) {
          const incoming = k === 'gubu' ? gubu : String(it[k] ?? '').trim()
          merged[k] = incoming !== '' ? incoming : (cur[k] ?? '')
        }
        await conn.execute(
          'UPDATE vendors SET name=?, biz_no=?, ceo=?, address=?, phone=?, gubu=?, type=?, contact=?, fax=?, email=?, bank_name=?, bank_account=?, account_holder=? WHERE id=?',
          [merged.name, merged.biz_no, merged.ceo, merged.address, merged.phone, merged.gubu, merged.type, merged.contact, merged.fax, merged.email,
           merged.bank_name, merged.bank_account, merged.account_holder, it.id]
        )
        updated++
      } else {
        const id = randomUUID()
        await conn.execute(
          'INSERT INTO vendors (id, name, biz_no, ceo, address, phone, gubu, type, service_type, contact, fax, email, bank_name, bank_account, account_holder) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, name, String(it.biz_no || '').trim(), String(it.ceo || '').trim(), String(it.address || '').trim(),
           String(it.phone || '').trim(), gubu, String(it.type || '').trim(), '',
           String(it.contact || '').trim(), String(it.fax || '').trim(), String(it.email || '').trim(),
           String(it.bank_name || '').trim(), String(it.bank_account || '').trim(), String(it.account_holder || '').trim()]
        )
        inserted++; createdNames.push(name)
      }
    }
    await conn.commit()
    res.json({ inserted, updated, createdNames })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// ── 거래처 엑셀 임포트: 양식 다운로드(.xlsx) ──
router.get('/import/template', async (req, res, next) => {
  try {
    const rows = [
      ["상호명", "거래구분", "거래유형", "사업자번호", "대표자", "담당자", "전화", "팩스", "이메일", "주소", "은행", "계좌번호", "예금주"],
      ["(주)한화오션", "발주처", "발주처", "000-00-00000", "홍길동", "김담당", "031-000-0000", "031-000-0001", "sales@company.com", "경기도 안산시 ...", "", "", ""],
      // 예금주가 상호와 다른 경우(개인 명의 계좌)가 흔해서 예시에 함께 둔다
      ["정밀가공(주)", "매입처", "외주가공", "111-11-11111", "이대표", "박담당", "051-000-0000", "", "cnc@partner.com", "부산광역시 ...", "기업", "123-456789-01-011", "이대표정밀가공"],
      ["기업은행", "기관", "금융", "", "", "", "1588-0000", "", "", "", "", "", ""],
    ]
    const COLS = [
      { header: '상호명', width: 22, required: true }, { header: '거래구분', width: 10 },
      { header: '거래유형', width: 12 }, { header: '사업자번호', width: 14 },
      { header: '대표자', width: 10 }, { header: '담당자', width: 10 },
      { header: '전화', width: 14 }, { header: '팩스', width: 14 },
      { header: '이메일', width: 22 }, { header: '주소', width: 30 },
      { header: '은행', width: 10 }, { header: '계좌번호', width: 20 }, { header: '예금주', width: 16 },
    ]

    const guide = [
      ["거래처 일괄 업로드 — 작성 안내"],
      [""],
      ["• 상호명: 필수. 반드시 입력하세요."],
      ["• 거래구분: '발주처'(수금처) / '매입처'(외주·자재 지급처) / '기관'(금융·관공서) 중 하나. 비우면 아래 기본 구분이 적용됩니다."],
      ["• 거래유형: 발주처 / 외주가공 / 원자재 / 금융 등 자유롭게 입력."],
      ["• 사업자번호: 있으면 중복 판정에 우선 사용됩니다(000-00-00000)."],
      ["• 중복: 이미 등록된 거래처(사업자번호 또는 상호명 일치)는 업로드 화면에서 '건너뛰기/덮어쓰기'를 선택할 수 있어요."],
      ["• 첫 행(머리글)은 그대로 두고, 둘째 행부터 데이터를 입력하세요."],
    ]
    const wb = newBook()
    // rows[0] 은 머리글이라 예시에서 뺀다 — 머리글은 COLS 가 만든다
    templateSheet(wb, '거래처', { columns: COLS, samples: rows.slice(1) })
    guideSheet(wb, guide.map(g => g[0], '작성안내', { hasRequired: true }))
    await sendBook(res, wb, '거래처_업로드_양식.xlsx')
  } catch (e) { next(e) }
})

module.exports = router
