const { Router } = require('express')
const { randomUUID } = require('crypto')
const { monthOf } = require('../lib/closing')
const { fiscalOfYear, fiscalYearOf } = require('../lib/fiscal')
const { kstToday } = require('../db')

const router = Router()

/* ── 회기 마감(4단계, 2026-09) ── 월 마감을 **회기 열두 달 한 번에** 한다.
 * 이월 값을 따로 저장하지 않는다 — 계좌 잔액·미수·미지급이 계산으로 이어지므로 해를 넘기며 옮길 값이 없다
 * (회기 행을 만들지 않은 1단계와 같은 이유: 기억이 생기면 어긋난다). 잠금 자체는 월 마감 표를 그대로 쓴다.
 * 설계: docs/02-design/features/fiscal-opening.design.md */
const monthsOf = (start, end) => {
  const out = []
  let y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7))
  const endYm = end.slice(0, 7)
  for (let i = 0; i < 24; i++) {
    const ym = `${y}-${String(m).padStart(2, '0')}`
    out.push(ym)
    if (ym === endYm) break
    m += 1; if (m > 12) { m = 1; y += 1 }
  }
  return out
}
const companyFiscal = async (db) => {
  const [[co]] = await db.execute('SELECT fiscal_end_month, fiscal_base_year, fiscal_base_seq FROM company_info WHERE id = ?', ['main'])
  return co || { fiscal_end_month: 12 }
}

/** 최근 회기 셋 — 이번·지난·지지난. 각 회기에 잠긴 달 수를 붙인다(화면이 '일부만 잠김'을 말할 수 있게) */
router.get('/fiscal', async (req, res, next) => {
  try {
    const co = await companyFiscal(req.db)
    const today = kstToday()
    const cur = fiscalYearOf(Number(co.fiscal_end_month) || 12, today)
    const [closed] = await req.db.execute('SELECT period FROM closed_periods')
    const set = new Set(closed.map(r => r.period))
    const out = []
    for (const year of [cur, cur - 1, cur - 2]) {
      const f = fiscalOfYear(co, year)
      if (!f) continue
      const months = monthsOf(f.start, f.end)
      out.push({ ...f, months: months.length, closed: months.filter(m => set.has(m)).length, ended: f.end < today })
    }
    res.json(out)
  } catch (e) { next(e) }
})

/** 회기 마감 — 아직 안 잠근 달만 잠근다(이미 잠긴 달은 그대로, 메모도 안 덮는다) */
router.post('/fiscal', async (req, res, next) => {
  try {
    const co = await companyFiscal(req.db)
    const f = fiscalOfYear(co, Number(req.body.year))
    if (!f) return res.status(400).json({ error: '마감할 회기를 확인해주세요' })
    // 끝나지 않은 회기는 못 잠근다 — 남은 달의 거래를 넣을 수 없게 된다(월 마감의 '미래 달' 규칙과 같다)
    if (f.end >= kstToday()) return res.status(400).json({ error: `${f.name} 회기는 아직 끝나지 않았어요(${f.end}까지)` })
    let n = 0
    for (const ym of monthsOf(f.start, f.end)) {
      const [r] = await req.db.execute(
        'INSERT IGNORE INTO closed_periods (id, period, memo, closed_by) VALUES (?,?,?,?)',
        [randomUUID(), ym, `${f.name} 회기 마감`, req.user?.username || null])
      n += r.affectedRows
    }
    res.json({ ok: true, name: f.name, closed: n })
  } catch (e) { next(e) }
})

/** 회기 마감 해제 — 그 회기의 모든 달을 푼다(따로 잠근 달도 함께 — 회기 단위로 푸는 게 이 버튼의 뜻이다) */
router.delete('/fiscal/:year', async (req, res, next) => {
  try {
    const co = await companyFiscal(req.db)
    const f = fiscalOfYear(co, Number(req.params.year))
    if (!f) return res.status(400).json({ error: '해제할 회기를 확인해주세요' })
    const months = monthsOf(f.start, f.end)
    const [r] = await req.db.execute(
      `DELETE FROM closed_periods WHERE period IN (${months.map(() => '?').join(',')})`, months)
    res.json({ ok: true, name: f.name, reopened: r.affectedRows })
  } catch (e) { next(e) }
})

// 마감한 달 목록 (최근 순)
router.get('/', async (req, res, next) => {
  try {
    const [rows] = await req.db.execute('SELECT * FROM closed_periods ORDER BY period DESC')
    res.json(rows)
  } catch (e) { next(e) }
})

// 월 마감
router.post('/', async (req, res, next) => {
  try {
    const period = monthOf(req.body.period)
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: '마감할 달을 YYYY-MM 형식으로 지정해주세요' })
    // 아직 오지 않은 달을 마감하면 그 달의 거래를 아예 넣을 수 없게 된다
    const nowMonth = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7)  // KST 기준 이번 달
    if (period > nowMonth) return res.status(400).json({ error: '아직 지나지 않은 달은 마감할 수 없어요' })
    await req.db.execute(
      'INSERT INTO closed_periods (id, period, memo, closed_by) VALUES (?,?,?,?)',
      [randomUUID(), period, req.body.memo || null, req.user?.username || null]
    )
    res.json({ ok: true, period })
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '이미 마감된 달이에요' })
    next(e)
  }
})

// 마감 해제
router.delete('/:period', async (req, res, next) => {
  try {
    const [r] = await req.db.execute('DELETE FROM closed_periods WHERE period = ?', [monthOf(req.params.period)])
    if (r.affectedRows === 0) return res.status(404).json({ error: '마감된 달이 아니에요' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

module.exports = router
