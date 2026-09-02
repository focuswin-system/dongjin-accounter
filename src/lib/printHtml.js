/**
 * 완성된 HTML 한 장을 **그대로 인쇄**한다 — 급여명세서·용역 명세서처럼
 * 화면에 없는 서류를 뽑을 때 쓴다.
 *
 * ── 왜 숨김 iframe 인가 ──
 * `window.open` 은 팝업 차단에 막히고, 막히면 사용자에게는 "아무 일도 안 일어남"으로만
 * 보인다. 숨김 iframe 은 차단되지 않고 인쇄 대화상자가 바로 뜬다.
 *
 * ── 왜 공용인가 ──
 * 같은 배선이 Hr.jsx 와 WorkContract.jsx 에 한 벌씩 있었는데 **미묘하게 달랐다.**
 *   · 한쪽은 인쇄 직후 iframe 을 즉시 지웠다 — 브라우저가 대화상자를 띄우기 전에
 *     문서가 사라지면 빈 종이가 나온다. 그래서 조금 늦춰 지운다.
 *   · 한쪽은 catch 가 비어 있어 **인쇄 실패를 조용히 삼켰다.** 사용자는 눌렀는데
 *     아무 일도 안 일어난 것으로만 안다.
 * 이런 것은 한 곳에 두고 한 번만 제대로 맞추는 편이 낫다.
 *
 * ⚠ 서식(HTML 본문)은 여기서 만들지 않는다. 근로소득 임금명세서와 용역·일용
 *   지급명세서는 **법적 성격이 다른 서류**라 한 틀로 찍으면 안 된다.
 */

/** HTML 로 들어갈 값 이스케이프 — 이름·항목명에 <, &, " 가 있어도 서식이 안 깨진다 */
export const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/**
 * @param html   <!doctype html> 부터 </html> 까지 완성된 문서
 * @param onFail 인쇄를 띄우지 못했을 때(브라우저 거부 등). 없으면 콘솔에만 남긴다
 */
export function printHtmlDocument(html, onFail) {
  const iframe = document.createElement('iframe')
  /* 화면낭독기에도 숨긴다 — 눈에 안 보이는 0×0 문서가 읽히면 방해만 된다 */
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'

  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    /* ⚠ 곧바로 지우지 않는다 — 브라우저가 인쇄 대화상자를 띄우기 전에 문서가 사라지면
       빈 종이가 나온다. 짧게 늦춰서 대화상자가 문서를 붙든 뒤에 치운다. */
    setTimeout(() => { if (iframe.parentNode) iframe.parentNode.removeChild(iframe) }, 500)
  }

  iframe.onload = () => {
    try {
      const w = iframe.contentWindow
      w.onafterprint = cleanup
      w.focus()
      w.print()
    } catch (e) {
      /* 조용히 삼키지 않는다 — 사용자는 눌렀는데 아무 일도 안 일어난 것으로만 안다 */
      console.error('명세서 인쇄 실패', e)
      onFail?.(e)
      cleanup()
    }
  }
  iframe.srcdoc = html
  document.body.appendChild(iframe)
  // onafterprint 를 안 주는 브라우저 대비 백스톱
  setTimeout(cleanup, 60000)
}
