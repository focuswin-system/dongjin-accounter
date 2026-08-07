const { Router } = require('express')
const { randomUUID } = require('crypto')
const xlsx = require('xlsx')
const { rollbackQuietly } = require('../lib/tx')
const { uploadMem, parseSheet } = require('../lib/xlsx-import')

const router = Router()

const FIELDS = ['name', 'code', 'spec', 'unit', 'party', 'amount', 'start_date', 'end_date', 'memo',
  'period', 'pay_day', 'account_id', 'file_url', 'file_name',
  'purchase_price', 'item_kind', 'tax_type', 'item_group', 'deductible',
  // 중량과 '단가를 무엇에 곱하는가'. 거래명세서에 중량이 들어가는 업종(금속·자재)이 있고,
  // ㎏당 단가로 파는 품목은 금액 = 중량 × 단가다(lib/lineAmount.js).
  'weight', 'price_basis']
const NUM_FIELDS = new Set(['amount', 'pay_day', 'purchase_price', 'deductible'])
/* 중량은 소수를 쓴다(㎏에 g 단위). parseInt 로 넣으면 12.5 가 12 가 되어 조용히 틀린다. */
const DEC_FIELDS = new Set(['weight'])
const pick = (body) => FIELDS.map(f => {
  if (NUM_FIELDS.has(f)) return parseInt(String(body[f] ?? '').replace(/[^0-9-]/g, ''), 10) || 0
  if (DEC_FIELDS.has(f)) return parseFloat(String(body[f] ?? '').replace(/[^0-9.-]/g, '')) || 0
  // 아는 값만 통과시킨다 — 엉뚱한 값이 들어오면 금액 계산 기준이 흔들린다
  if (f === 'price_basis') return body[f] === 'weight' ? 'weight' : 'qty'
  return body[f] ?? null
})

// 목록 (type별)
router.get('/', async (req, res, next) => {
  try {
    const { type } = req.query
    const [rows] = type
      ? await req.db.execute('SELECT * FROM ref_items WHERE type=? ORDER BY sort_order, name', [type])
      : await req.db.execute('SELECT * FROM ref_items ORDER BY type, sort_order, name')
    res.json(rows)
  } catch (e) { next(e) }
})

// 등록
router.post('/', async (req, res, next) => {
  try {
    const { type, name } = req.body
    if (!type || !name) return res.status(400).json({ error: 'type·name 필수' })
    const [[{ maxOrder }]] = await req.db.execute('SELECT COALESCE(MAX(sort_order),0) AS maxOrder FROM ref_items WHERE type=?', [type])
    const id = randomUUID()
    await req.db.execute(
      'INSERT INTO ref_items (id, type, name, code, spec, unit, party, amount, start_date, end_date, memo, period, pay_day, account_id, file_url, file_name, purchase_price, item_kind, tax_type, item_group, deductible, weight, price_basis, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [id, type, ...pick(req.body), maxOrder + 1]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

// 수정
router.put('/:id', async (req, res, next) => {
  try {
    const [result] = await req.db.execute(
      'UPDATE ref_items SET name=?, code=?, spec=?, unit=?, party=?, amount=?, start_date=?, end_date=?, memo=?, period=?, pay_day=?, account_id=?, file_url=?, file_name=?, purchase_price=?, item_kind=?, tax_type=?, item_group=?, deductible=?, weight=?, price_basis=? WHERE id=?',
      [...pick(req.body), req.params.id]
    )
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 삭제
router.delete('/:id', async (req, res, next) => {
  try {
    // 품목 기준정보는 거래·계약·청구서가 item_id 로 참조하는데 FK가 없다.
    // 그냥 지우면 이미 기록된 거래의 품목명이 조용히 빈칸이 된다(목록은 JOIN 으로 이름을 붙인다).
    // 과거 기록을 훼손하지 않도록, 쓰인 적 있는 항목은 지우지 못하게 막는다.
    const id = req.params.id
    const [[c]] = await req.db.execute(
      `SELECT
         (SELECT COUNT(*) FROM transactions        WHERE item_id = ?) AS txns,
         (SELECT COUNT(*) FROM contract_items      WHERE item_id = ?) AS citems,
         (SELECT COUNT(*) FROM invoice_lines       WHERE item_id = ?) AS ilines,
         (SELECT COUNT(*) FROM work_contract_items WHERE item_id = ?) AS witems`,
      [id, id, id, id]
    )
    const parts = []
    if (Number(c.txns)   > 0) parts.push(`거래 ${c.txns}건`)
    if (Number(c.citems) > 0) parts.push(`계약 품목 ${c.citems}건`)
    if (Number(c.ilines) > 0) parts.push(`청구서 품목 ${c.ilines}건`)
    if (Number(c.witems) > 0) parts.push(`용역계약 품목 ${c.witems}건`)
    if (parts.length) {
      return res.status(409).json({
        error: `이 항목은 ${parts.join(' · ')}에 쓰였어요. 지우면 그 기록의 품목명이 사라져요. 이름만 바꿔 쓰시거나 그대로 두세요.`,
      })
    }
    const [r] = await req.db.execute('DELETE FROM ref_items WHERE id=?', [id])
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// ── 기준정보 엑셀 임포트 ─────────────────────────────────────────
// 업로드를 지원하는 type만 허용한다. 보험·증빙유형은 첨부파일·계좌 같은 칸이 있어
// 엑셀 한 장으로 채울 수 없으니 일부러 뺐다.
const REF_IMPORT_TYPES = new Set(['item', 'fixed_asset', 'intangible_asset', 'jeokyo'])
// 임포트로 채울 수 있는 칸. 화면(REF_CONFIGS)의 라벨→키 변환은 프론트가 하고, 서버는 키만 받는다.
const IMPORT_FIELDS = ['name', 'code', 'spec', 'unit', 'item_kind', 'item_group', 'tax_type',
  'purchase_price', 'amount', 'start_date', 'end_date', 'memo']
const IMPORT_NUM = new Set(['purchase_price', 'amount'])
const numOf = (v) => parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10) || 0

// 파싱(머리글 + 행) — 저장은 하지 않는다
router.post('/import/parse', uploadMem.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다' })
    res.json(parseSheet(req.file.buffer))
  } catch (e) { next(e) }
})

// 일괄 등록/갱신
// items: [{ action:'insert'|'update', id?, name, code, spec, ... }]
// update는 엑셀에 값이 있는 칸만 덮어쓴다(빈 칸으로 기존 단가·규격을 지우지 않음).
router.post('/import/commit', async (req, res, next) => {
  const type = String(req.body.type ?? '')
  if (!REF_IMPORT_TYPES.has(type)) return res.status(400).json({ error: '엑셀 업로드를 지원하지 않는 기준정보예요' })
  const conn = await req.db.getConnection()
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : []
    await conn.beginTransaction()
    const [[{ maxOrder }]] = await conn.execute('SELECT COALESCE(MAX(sort_order),0) AS maxOrder FROM ref_items WHERE type=?', [type])
    let order = Number(maxOrder) || 0
    let inserted = 0, updated = 0
    const createdNames = []
    for (const it of items) {
      const name = String(it.name ?? '').trim()
      if (!name) continue
      if (it.action === 'update' && it.id) {
        // type까지 함께 조건에 넣는다 — id만 믿으면 다른 종류(자산 → 품목)를 덮어쓸 수 있다
        const [rows] = await conn.execute('SELECT * FROM ref_items WHERE id=? AND type=?', [it.id, type])
        const cur = rows[0]
        if (!cur) continue
        const vals = IMPORT_FIELDS.map(k => {
          const raw = String(it[k] ?? '').trim()
          if (raw === '') return cur[k] ?? null              // 빈 칸 = 기존 값 유지
          return IMPORT_NUM.has(k) ? numOf(raw) : raw
        })
        await conn.execute(
          `UPDATE ref_items SET ${IMPORT_FIELDS.map(k => `${k}=?`).join(', ')} WHERE id=?`,
          [...vals, it.id]
        )
        updated++
      } else {
        order++
        const vals = IMPORT_FIELDS.map(k => {
          const raw = String(it[k] ?? '').trim()
          return IMPORT_NUM.has(k) ? numOf(raw) : (raw || null)
        })
        await conn.execute(
          `INSERT INTO ref_items (id, type, sort_order, ${IMPORT_FIELDS.join(', ')}) VALUES (?,?,?,${IMPORT_FIELDS.map(() => '?').join(',')})`,
          [randomUUID(), type, order, ...vals]
        )
        inserted++; createdNames.push(name)
      }
    }
    await conn.commit()
    res.json({ inserted, updated, createdNames })
  } catch (e) { await rollbackQuietly(conn); next(e) }
  finally { conn.release() }
})

// 양식 다운로드(.xlsx) — type별 머리글 + 예시 2행 + 작성안내 시트
const TEMPLATES = {
  item: {
    file: '품목_업로드_양식.xlsx',
    sheet: '품목',
    cols: ["품목코드", "품명", "유형", "분류", "규격", "단위", "매입가", "출고가", "과세"],
    widths: [12, 28, 10, 14, 20, 8, 12, 12, 8],
    samples: [
      ["SW-001", "그룹웨어 구축", "서비스", "웹서비스", "1식", "식", "0", "12000000", "과세"],
      ["MT-100", "알루미늄 브라켓", "원재료", "가공품", "120×80×6t", "EA", "3500", "0", "과세"],
    ],
    guide: [
      ["• 품명: 필수. 반드시 입력하세요."],
      ["• 품목코드: 있으면 중복 판정에 우선 사용됩니다. 없으면 품명＋규격으로 판정해요."],
      ["• 유형: 제품 / 상품 / 서비스 / 원재료 / 부재료 중 하나. '완제품·용역·자재' 같은 말도 알아서 맞춰줍니다."],
      ["• 과세: 과세 / 면세 / 영세 중 하나. 비워두면 비목(계정과목)의 부가세 설정을 따라갑니다."],
      ["  ※ 알 수 없는 값이면 비운 채로 올리고 업로드 화면에 '확인' 표시를 띄웁니다 — 잘못 채우면 부가세 신고가 틀어져요."],
      ["• 매입가·출고가: 숫자만. 콤마·'원'이 섞여 있어도 괜찮습니다. (출고가 − 매입가 = 마진으로 자동 계산)"],
    ],
  },
  fixed_asset: {
    file: '고정자산_업로드_양식.xlsx',
    sheet: '고정자산',
    cols: ["자산번호", "자산명", "취득가액", "취득일", "비고"],
    widths: [14, 28, 14, 14, 30],
    samples: [
      ["FA-001", "CNC 머시닝센터", "48000000", "2025-03-14", "1공장"],
      ["FA-002", "업무용 차량 (스타리아)", "38500000", "2026-01-05", ""],
    ],
    guide: [
      ["• 자산명: 필수."],
      ["• 자산번호: 있으면 중복 판정에 우선 사용됩니다."],
      ["• 취득일: 2026-01-05 형식으로 적어주세요."],
      ["• 취득가액: 숫자만. 콤마가 섞여 있어도 괜찮습니다."],
    ],
  },
  intangible_asset: {
    file: '무형자산_업로드_양식.xlsx',
    sheet: '무형자산',
    cols: ["자산번호", "자산명", "취득가액", "취득일", "비고"],
    widths: [14, 28, 14, 14, 30],
    samples: [
      ["IA-001", "회계 소프트웨어 라이선스", "6000000", "2025-11-20", "5년 상각"],
      ["IA-002", "상표권", "1200000", "2026-02-02", ""],
    ],
    guide: [
      ["• 자산명: 필수."],
      ["• 자산번호: 있으면 중복 판정에 우선 사용됩니다."],
      ["• 취득일: 2026-01-05 형식으로 적어주세요."],
    ],
  },
  jeokyo: {
    file: '적요_업로드_양식.xlsx',
    sheet: '적요',
    cols: ["적요", "비고"],
    widths: [40, 30],
    samples: [
      ["4대보험료 납부", "매월 10일"],
      ["사무실 임차료", ""],
    ],
    guide: [
      ["• 적요: 필수. 거래 입력 시 자주 쓰는 문구를 한 줄에 하나씩 적어주세요."],
    ],
  },
}

router.get('/import/template', (req, res, next) => {
  try {
    const t = TEMPLATES[String(req.query.type ?? '')]
    if (!t) return res.status(400).json({ error: '양식이 없는 기준정보예요' })

    const ws = xlsx.utils.aoa_to_sheet([t.cols, ...t.samples])
    ws['!cols'] = t.widths.map(wch => ({ wch }))

    const wsGuide = xlsx.utils.aoa_to_sheet([
      [`${t.sheet} 일괄 업로드 — 작성 안내`], [""],
      ...t.guide.map(line => [line[0]]),
      [""],
      ["• 첫 행(머리글)은 그대로 두고, 둘째 행부터 데이터를 입력하세요. 예시 2행은 지우고 쓰세요."],
      ["• 이미 등록된 항목은 업로드 화면에서 '건너뛰기 / 덮어쓰기'를 고를 수 있어요."],
      ["• 덮어쓰기는 엑셀에 값이 있는 칸만 바꿉니다 — 빈 칸으로 기존 정보가 지워지지 않아요."],
    ])
    wsGuide['!cols'] = [{ wch: 92 }]

    const wb = xlsx.utils.book_new()
    xlsx.utils.book_append_sheet(wb, ws, t.sheet)
    xlsx.utils.book_append_sheet(wb, wsGuide, "작성안내")
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="ref_import_template.xlsx"; filename*=UTF-8''${encodeURIComponent(t.file)}`)
    res.send(buf)
  } catch (e) { next(e) }
})

module.exports = router
