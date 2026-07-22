const { Router } = require('express')
const { randomUUID } = require('crypto')
const multer = require('multer')
const xlsx = require('xlsx')
const { rollbackQuietly } = require('../lib/tx')

const router = Router()
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

router.get('/', async (req, res, next) => {
  try {
    const { gubu } = req.query
    const [rows] = gubu
      ? await req.db.execute('SELECT * FROM vendors WHERE gubu = ? ORDER BY name', [gubu])
      : await req.db.execute('SELECT * FROM vendors ORDER BY gubu, name')
    res.json(rows)
  } catch (e) { next(e) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM vendors WHERE id = ?', [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { name, biz_no, ceo, address, phone, gubu, type, service_type, contact, fax, email } = req.body
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO vendors (id, name, biz_no, ceo, address, phone, gubu, type, service_type, contact, fax, email) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, name, biz_no||'', ceo||'', address||'', phone||'', gubu||'A', type||'', service_type||'', contact||'', fax||'', email||'']
    )
    res.json({ id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { name, biz_no, ceo, address, phone, gubu, type, service_type, contact, fax, email } = req.body
    const [result] = await req.db.execute(
      'UPDATE vendors SET name=?, biz_no=?, ceo=?, address=?, phone=?, gubu=?, type=?, service_type=?, contact=?, fax=?, email=? WHERE id=?',
      [name, biz_no||'', ceo||'', address||'', phone||'', gubu||'A', type||'', service_type||'', contact||'', fax||'', email||'', req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('DELETE FROM vendors WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) {
    // 거래·청구서·계약이 걸려 있으면 FK가 막는다. 그대로 두면 500 일반 오류가 나가고
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
      if (Number(c.ctrs) > 0) parts.push(`계약 ${c.ctrs}건`)
      const detail = parts.length ? parts.join(' · ') : '연결된 자료'
      return res.status(409).json({
        error: `이 거래처에 ${detail}이 연결돼 있어 삭제할 수 없어요. 지난 기록을 지우면 장부가 어긋나므로, 이름만 바꿔 쓰시거나 연결된 자료를 먼저 정리해주세요.`,
      })
    }
    next(e)
  }
})

// ── 거래처 엑셀 임포트: 파싱(머리글 + 행) ──
router.post('/import/parse', uploadMem.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다' })
    const wb = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) return res.json({ headers: [], rows: [] })
    const json = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false })
    const headers = json.length ? Object.keys(json[0]) : []
    res.json({ headers, rows: json.slice(0, 1000) })
  } catch (e) { next(e) }
})

// ── 거래처 엑셀 임포트: 일괄 등록/갱신 ──
// items: [{ action:'insert'|'update', id?, name, gubu, type, biz_no, ceo, contact, phone, fax, email, address }]
// update는 기존 값을 유지하고 엑셀에 값이 있는 칸만 덮어쓴다(빈 칸으로 기존 정보를 지우지 않음).
const VENDOR_FIELDS = ['name', 'biz_no', 'ceo', 'address', 'phone', 'gubu', 'type', 'contact', 'fax', 'email']
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
          'UPDATE vendors SET name=?, biz_no=?, ceo=?, address=?, phone=?, gubu=?, type=?, contact=?, fax=?, email=? WHERE id=?',
          [merged.name, merged.biz_no, merged.ceo, merged.address, merged.phone, merged.gubu, merged.type, merged.contact, merged.fax, merged.email, it.id]
        )
        updated++
      } else {
        const id = randomUUID()
        await conn.execute(
          'INSERT INTO vendors (id, name, biz_no, ceo, address, phone, gubu, type, service_type, contact, fax, email) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, name, String(it.biz_no || '').trim(), String(it.ceo || '').trim(), String(it.address || '').trim(),
           String(it.phone || '').trim(), gubu, String(it.type || '').trim(), '',
           String(it.contact || '').trim(), String(it.fax || '').trim(), String(it.email || '').trim()]
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
router.get('/import/template', (req, res, next) => {
  try {
    const rows = [
      ["상호명", "거래구분", "거래유형", "사업자번호", "대표자", "담당자", "전화", "팩스", "이메일", "주소"],
      ["(주)한화오션", "발주처", "발주처", "000-00-00000", "홍길동", "김담당", "031-000-0000", "031-000-0001", "sales@company.com", "경기도 안산시 ..."],
      ["정밀가공(주)", "매입처", "외주가공", "111-11-11111", "이대표", "박담당", "051-000-0000", "", "cnc@partner.com", "부산광역시 ..."],
      ["기업은행", "기관", "금융", "", "", "", "1588-0000", "", "", ""],
    ]
    const ws = xlsx.utils.aoa_to_sheet(rows)
    ws['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 22 }, { wch: 30 }]

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
    const wsGuide = xlsx.utils.aoa_to_sheet(guide)
    wsGuide['!cols'] = [{ wch: 84 }]

    const wb = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(wb, ws, "거래처")
    xlsx.utils.book_append_sheet(wb, wsGuide, "작성안내")
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="vendor_import_template.xlsx"; filename*=UTF-8''${encodeURIComponent('거래처_업로드_양식.xlsx')}`)
    res.send(buf)
  } catch (e) { next(e) }
})

module.exports = router
