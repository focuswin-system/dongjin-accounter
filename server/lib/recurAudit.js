/**
 * 정기 규칙 점검 — **전부 한 번에 훑어 이상만 남긴다.**
 *
 * 여태는 규칙 하나씩 열어 기간을 넣고 미리보기를 돌려야 문제를 알 수 있었다.
 * 규칙이 수십 개면 그건 점검이 아니라 노동이고, 실제로 아무도 끝까지 못 본다.
 *
 * ⚠ 여기서 가장 중요한 건 **'회차가 안 열리는' 규칙**이다.
 *   last_generated 는 "이 값 이하 회차는 이미 만들었다"는 하한이다. 이게 실제 최신
 *   청구서보다 **앞서** 있으면 그 사이 회차는 영영 안 열린다 — '놓친 회차'에도 안 잡힌다.
 *   안 열린 것은 빠진 것으로도 안 보이기 때문이다. 화면 어디에도 표가 안 나는 유일한 고장이다.
 *   (fowin 금강노인종합복지관: last_generated 8/9, 실제 최신 청구서 7/10 → 8월이 통째로 잠겼다)
 *
 * 판정은 규칙에서 다시 계산하지 않고 **recurHistory 한 곳**을 쓴다. 두 벌로 세면
 * 점검 결과와 화면이 어긋나고, 그러면 점검을 아무도 안 믿는다.
 */
const { recurHistory } = require('./recurHistory')

const day = (v) => String(v || '').slice(0, 10)
const num = (v) => Number(v) || 0

/* 심각도 — 목록을 이 순서로 세운다. 사람은 위에서 세 줄만 읽는다.
 *   high  돈이 새고 있거나, 고치지 않으면 계속 새는 것
 *   mid   지금 챙기면 되는 것
 *   low   정리해 두면 좋은 것 */
const SEVERITY = { stuck: 'high', missing: 'high', ended_active: 'mid', unpaid: 'mid', no_vendor: 'low', zero_amount: 'low' }

/**
 * @param db     req.db (테넌트 풀) — 필수
 * @param kind   'invoice'(정기입금) | 'expense'(정기지급)
 * @param rules  규칙 행 목록. created_epoch·setup_date 는 호출부가 채워 둔다
 * @param today  'YYYY-MM-DD' (KST)
 */
async function auditRecurRules(db, kind, rules, today) {
  if (!db) throw new Error('auditRecurRules: 테넌트 연결(db)이 필요합니다')
  const isInvoice = kind === 'invoice'
  const out = []

  for (const rule of rules) {
    const h = await recurHistory(db, kind, rule, today)
    const done = h.cycles.filter(c => c.state === 'done')
    const lastDone = done.length ? day(done[done.length - 1].date) : null
    const lastGen = rule.last_generated ? day(rule.last_generated) : null
    const due = num(h.totals.due_amount)
    const paid = num(h.totals.paid_amount)
    const issues = []

    /* 1) 회차가 안 열린다 — 하한이 실제 장부보다 앞서 있다.
       비활성 규칙은 어차피 안 도니 따지지 않는다. */
    if (rule.active && lastGen && lastDone && lastGen > lastDone) {
      issues.push({
        code: 'stuck',
        text: `회차가 안 열려요 — 다음 회차 기준일이 ${lastGen}인데 실제 마지막 청구서는 ${lastDone}이에요.`
            + ` 그 사이 회차는 '놓친 회차'에도 안 나타나요.`,
      })
    }
    // 2) 도래했는데 만들지도 건너뛰지도 않은 달
    if (h.totals.missing > 0) {
      issues.push({
        code: 'missing',
        text: `${isInvoice ? '청구서' : '매입 청구서'}를 안 만든 회차가 ${h.totals.missing}회 있어요`
            + ` (약 ${num(h.totals.missing_amount).toLocaleString('ko-KR')}원).`,
      })
    }
    // 3) 청구는 했는데 정산이 안 된 돈
    if (due - paid > 0 && h.totals.missing === 0) {
      issues.push({
        code: 'unpaid',
        text: `${(due - paid).toLocaleString('ko-KR')}원이 아직 ${isInvoice ? '안 들어왔어요' : '안 나갔어요'}.`,
      })
    }
    // 4) 끝난 규칙이 켜져 있다 — 다음 달에 또 청구가 나간다
    if (rule.active && rule.end_date && day(rule.end_date) < today) {
      issues.push({ code: 'ended_active', text: `종료일(${day(rule.end_date)})이 지났는데 아직 켜져 있어요.` })
    }
    // 5) 거래처·금액이 비어 있으면 만들어져도 쓸 수 없는 회차가 된다
    if (!rule.vendor_id) issues.push({ code: 'no_vendor', text: '거래처가 없어요.' })
    const amount = isInvoice ? num(rule.supply_amount) : num(rule.amount)
    if (amount <= 0 && rule.amount_mode !== 'variable') {
      issues.push({ code: 'zero_amount', text: '금액이 0원이에요.' })
    }

    const worst = issues.reduce((s, i) => {
      const v = SEVERITY[i.code] || 'low'
      return (s === 'high' || v === 'high') ? 'high' : (s === 'mid' || v === 'mid') ? 'mid' : 'low'
    }, null)

    out.push({
      id: rule.id,
      vendor_name: rule.vendor_name || '',
      label: (isInvoice ? rule.item : rule.category) || '',
      contract_name: rule.contract_name || '',
      active: !!rule.active,
      due_amount: due, paid_amount: paid,
      billed_amount: due - num(h.totals.missing_amount),
      missing: h.totals.missing, skipped: h.totals.skipped, done: h.totals.done,
      last_generated: lastGen, last_done: lastDone,
      issues, severity: worst,
    })
  }

  /* 이상 있는 것부터, 그 안에서는 새는 돈이 큰 것부터. 멀쩡한 규칙은 뒤로 민다 —
     점검 화면을 열어 제일 먼저 보이는 줄이 '정상'이면 아무도 두 번 안 연다. */
  const rank = { high: 0, mid: 1, low: 2 }
  out.sort((a, b) =>
    (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)
    || (b.due_amount - b.paid_amount) - (a.due_amount - a.paid_amount))

  return {
    checked: out.length,
    problems: out.filter(r => r.issues.length > 0).length,
    rules: out,
  }
}

module.exports = { auditRecurRules }
