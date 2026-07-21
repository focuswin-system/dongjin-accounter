const { Router } = require('express')
const { randomUUID } = require('crypto')

const router = Router()

// 고용형태 마스터 — 사용자가 유형을 직접 만들고 계약 기본값(소득구분·단가단위·보험·전환기준)을 정한다.
// income_type만 세법이 정한 닫힌 집합(근로/사업/일용/기타). 나머지는 회사가 자유롭게 정의.

const INCOME = ['근로', '사업', '일용', '기타']
const KINDS = ['labor', 'service', 'daily']
const FORMS = ['annual', 'monthly', 'hourly', 'daily', 'piece']
const tinyint = (v) => (v ? 1 : 0)

router.get('/', async (req, res, next) => {
  try {
    const { kind } = req.query
    const [rows] = kind
      ? await req.db.execute('SELECT * FROM employ_types WHERE active = 1 AND kind = ? ORDER BY sort_order, label', [kind])
      : await req.db.execute('SELECT * FROM employ_types WHERE active = 1 ORDER BY sort_order, label')
    res.json(rows)
  } catch (e) { next(e) }
})

router.post('/', async (req, res, next) => {
  try {
    const { label, kind, income_type, pay_form, default_unit,
            insure_np, insure_hi, insure_ei, insure_ai, conv_alert_months } = req.body
    if (!label || !label.trim()) return res.status(400).json({ error: '고용형태 이름을 입력해주세요' })
    const [[{ maxOrder }]] = await req.db.execute('SELECT COALESCE(MAX(sort_order),0) AS maxOrder FROM employ_types')
    const id = randomUUID()
    await req.db.execute(
      `INSERT INTO employ_types
         (id, label, kind, income_type, pay_form, default_unit, insure_np, insure_hi, insure_ei, insure_ai, conv_alert_months, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, label.trim(), KINDS.includes(kind) ? kind : 'labor', INCOME.includes(income_type) ? income_type : '근로',
       FORMS.includes(pay_form) ? pay_form : 'monthly', default_unit || null,
       tinyint(insure_np), tinyint(insure_hi), tinyint(insure_ei), tinyint(insure_ai),
       Number(conv_alert_months) || 0, maxOrder + 1]
    )
    res.json({ ok: true, id })
  } catch (e) { next(e) }
})

router.put('/:id', async (req, res, next) => {
  try {
    const { label, kind, income_type, pay_form, default_unit,
            insure_np, insure_hi, insure_ei, insure_ai, conv_alert_months } = req.body
    const [r] = await req.db.execute(
      `UPDATE employ_types SET label=?, kind=?, income_type=?, pay_form=?, default_unit=?,
         insure_np=?, insure_hi=?, insure_ei=?, insure_ai=?, conv_alert_months=? WHERE id=?`,
      [label, KINDS.includes(kind) ? kind : 'labor', INCOME.includes(income_type) ? income_type : '근로',
       FORMS.includes(pay_form) ? pay_form : 'monthly', default_unit || null,
       tinyint(insure_np), tinyint(insure_hi), tinyint(insure_ei), tinyint(insure_ai),
       Number(conv_alert_months) || 0, req.params.id]
    )
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Not found' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 소프트 삭제 — 이미 이 유형으로 맺은 계약의 스냅샷은 보존된다(계약이 label을 복사해뒀으므로).
router.delete('/:id', async (req, res, next) => {
  try {
    await req.db.execute('UPDATE employ_types SET active = 0 WHERE id = ?', [req.params.id])
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
