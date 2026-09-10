/* 화면 일관성·UX 자동 점검 하네스 (Playwright MCP 로 실행)
 *
 *   mcp__playwright__browser_run_code_unsafe { filename: "scripts/ui-audit.mjs" }
 *
 * ⚠ 이 파일은 **함수 표현식 하나**여야 한다(도구가 파일 내용을 그대로 평가한다).
 *   import·export·최상위 const 를 쓰면 SyntaxError 가 난다. 설정은 함수 안에 둔다.
 *
 * 사람 눈으로 볼 것(여백·굵기·말투)과 기계가 잡을 것(가로 스크롤·이중 스크롤·콘솔 에러·
 * 헤더 버튼 자리)을 나눈다. 여기는 기계가 잡는 쪽이다.
 * 스크린샷은 screenshots/audit/ 에 남겨 사람이 대조한다.
 *
 * ⚠ 실서버 테스트는 claude 테넌트만 쓴다(fowin·tyeng 은 실데이터).
 * ⚠ BATCH 를 고쳐 나눠 돈다 — 한 번에 다 돌리면 결과가 길어 읽히지 않는다.
 */
async (page) => {
  const BASE = 'http://192.168.0.34:8081'
  const LOGIN = { company: 'claude', user: 'admin', pass: 'claude1234' }
  const SHOT_DIR = 'C:/Users/USER/Desktop/Project/public/focus-accounter/screenshots/audit'

  /* 점검 대상 — src/lib/nav.js 의 잎 id. 묶음(_dom)은 포털 화면이라 함께 본다. */
  const ROUTES = [
    'home', 'contract_dom', 'contract_sales', 'contract_purchase',
    'cash_dom', 'recurring_invoice', 'billing_issued', 'recurring_expense', 'billing_received',
    'misc_pl', 'card_payment', 'transfer',
    'hr', 'ledger', 'voucher_entry',
    'hr_dom', 'hr_labor_contract', 'hr_outsourcing',
    'tax_dom', 'tax_vat', 'tax_etc',
    'office_dom', 'quote_req', 'purchase_req', 'doc', 'settlement',
    'finance', 'finance_loan', 'finance_investment', 'finance_savings', 'finance_lending',
    'finance_note', 'finance_dash',
    'mgmt', 'report', 'mgmt_dash', 'mgmt_ask',
    'master_vendor', 'master_item', 'master_category', 'master_jeokyo', 'master_evidence_type',
    'master_account', 'master_card', 'master_fixed_asset', 'master_intangible_asset', 'master_insurance',
    'hrbase_department', 'hrbase_position',
    'settings_company', 'settings_closing', 'settings_user', 'settings_approval',
    'settings_audit', 'settings_reports', 'settings_docs', 'settings_menu', 'settings_theme',
    'report_daily', 'voucher_book', 'cash_report', 'payment_run', 'purchase_status', 'fund_status',
    'manual',
  ]
  const BATCH = [49, 65]                    // 이번에 돌 구간 [시작, 끝)
  const WIDTHS = [[1440, 900, 'desktop'], [1280, 800, 'laptop'], [390, 844, 'phone']]

  const ctx = await page.context().browser().newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  const errors = []
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)) })
  p.on('pageerror', e => errors.push('PAGEERROR ' + String(e).slice(0, 140)))
  const report = []
  try {
    await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
    await p.locator('input').first().waitFor({ timeout: 20000 })
    const ins = p.locator('input')
    await ins.nth(0).fill(LOGIN.company); await ins.nth(1).fill(LOGIN.user); await ins.nth(2).fill(LOGIN.pass)
    await p.keyboard.press('Enter')
    await p.waitForTimeout(4000)

    for (const route of ROUTES.slice(BATCH[0], BATCH[1])) {
      const row = { route, w: {} }
      for (const [w, h, tag] of WIDTHS) {
        await p.setViewportSize({ width: w, height: h })
        errors.length = 0
        await p.goto(`${BASE}/#${route}`, { waitUntil: 'domcontentloaded' })
        await p.waitForTimeout(2300)   // 자료를 불러오는 화면은 1.7초로는 덜 그려진다
        const m = await p.evaluate(() => {
          const de = document.scrollingElement || document.documentElement
          const overflowX = de.scrollWidth - de.clientWidth
          const wide = [...document.querySelectorAll('body *')]
            .filter(el => el.getBoundingClientRect().right > window.innerWidth + 2)
            .slice(0, 3)
            .map(el => (el.tagName + '.' + String(el.className || '')).slice(0, 50))
          /* 사이드바(.nav-scroll)는 원래 자기 스크롤을 갖는다 — 세지 않는다.
             본문 스크롤 상자가 .content 말고 또 있으면 휠이 어디서 먹는지 사람이 못 맞춘다. */
          const scrollers = [...document.querySelectorAll('body *')].filter(el => {
            const s = getComputedStyle(el)
            if (el.closest('.nav-scroll')) return false
            if (String(el.className || '').includes('nav-scroll')) return false
            return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 8
          })
          const ph = document.querySelector('.page-header')
          const headerBtns = ph
            ? [...ph.querySelectorAll('.page-header-actions button')]
                .map(b => (b.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 6)
            : []
          const phTitle = (ph?.querySelector('.page-title')?.textContent || '').replace(/\s+/g, ' ').trim()
          // 주 동작 버튼(btn primary)이 헤더 밖에 있으면 화면마다 자리가 달라진다
          const primaryOutside = [...document.querySelectorAll('button.btn.primary')]
            .filter(b => !b.closest('.page-header') && !b.closest('.drawer') && b.offsetParent)
            .map(b => (b.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 4)
          return {
            ox: overflowX, wide,
            scr: scrollers.length,
            scrCls: scrollers.slice(0, 3).map(el => String(el.className || '').slice(0, 36)),
            title: phTitle.slice(0, 28),
            btns: headerBtns,
            primaryOutside,
            len: (document.body.innerText || '').length,
            tbl: document.querySelectorAll('table').length,
          }
        })
        if (errors.length) m.err = errors.slice(0, 2)
        row.w[tag] = m
        await p.screenshot({ path: `${SHOT_DIR}/${route}-${tag}.png`, fullPage: false }).catch(() => {})
      }
      report.push(row)
    }
  } catch (e) {
    report.push({ fatal: String(e).slice(0, 300) })
  } finally {
    await ctx.close()   // ⚠ 반드시 닫는다 — 남으면 사용자 크롬을 먹는다
  }
  return JSON.stringify(report)
}
