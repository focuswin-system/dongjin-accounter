const { Router } = require('express')
const { newBook, sheet, sendBook } = require('../lib/xlsxBook')

const router = Router()

/* 화면에 그려진 표를 **서식 있는 엑셀**로 바꿔 준다.
 *
 * 왜 이런 통로가 필요한가 —
 *   보고서·거래내역·매입 결제내역·매입·매출 현황은 화면에서 거른 결과를 그대로 내보낸다.
 *   그 걸러진 결과는 화면만 알고 있다(기간·비목·주문·검색·탭이 겹쳐 있다).
 *   서버가 다시 계산하면 **집계가 두 벌이 되어** 화면과 파일이 어긋난다 — 예전에 실제로
 *   겪은 문제라 이 저장소는 '보이는 것과 받는 것이 같다'를 원칙으로 삼았다.
 *   그렇다고 화면이 파일을 만들면 CSV 가 된다(서식도 합계도 없다).
 *   그래서 **줄은 화면이, 서식은 xlsxBook 이** 맡는다. 규칙(서식)이 한 곳에 남는다.
 *
 * ⚠ DB 를 건드리지 않는다. 사용자가 방금 자기 화면에서 본 값을 그대로 돌려받는 것뿐이다.
 *   그래도 인증 뒤에 둔다(파일 이름·내용이 그 회사의 업무 내용이므로).
 */
router.post('/xlsx', async (req, res, next) => {
  try {
    const { filename, title, sub, columns, rows, totals } = req.body || {}
    if (!Array.isArray(columns) || !columns.length) {
      return res.status(400).json({ error: '내보낼 열이 없어요' })
    }
    if (!Array.isArray(rows)) return res.status(400).json({ error: '내보낼 줄이 없어요' })
    /* 한 번에 너무 큰 표는 막는다 — 엑셀 한 장의 실용 한계이기도 하고,
       메모리에 통째로 올려 만들기 때문이다. 기간을 좁히라고 말해 준다. */
    if (rows.length > 50000) {
      return res.status(413).json({ error: `한 번에 5만 줄까지예요 (${rows.length.toLocaleString('ko-KR')}줄). 기간을 좁혀주세요.` })
    }

    const cols = columns.slice(0, 60).map(c => ({
      header: String(c.header ?? ''),
      width: Number(c.width) || 14,
      money: !!c.money,
      int: !!c.int,
      align: c.align === 'center' || c.align === 'right' || c.align === 'left' ? c.align : undefined,
    }))
    // 열 수를 넘는 칸은 버린다(머리글보다 긴 줄이 오면 시트가 어긋난다)
    const body = rows.map(r => (Array.isArray(r) ? r.slice(0, cols.length) : []))

    const wb = newBook()
    /* 시트 이름은 31자 제한이고 : \ / ? * [ ] 를 못 쓴다 — 엑셀이 파일을 못 연다. */
    const tab = String(title || '내보내기').replace(/[:\\/?*[\]]/g, ' ').slice(0, 31)
    sheet(wb, tab, {
      title: title || '내보내기',
      sub,
      columns: cols,
      rows: body,
      totals: Array.isArray(totals) && totals.length ? totals : null,
    })
    const name = String(filename || '내보내기.xlsx').replace(/[\\/:*?"<>|]/g, '_')
    await sendBook(res, wb, name.endsWith('.xlsx') ? name : `${name}.xlsx`)
  } catch (e) { next(e) }
})

module.exports = router
