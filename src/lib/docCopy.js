/**
 * 문서 복사 — 지난 구매품의서·지급결의서를 본떠 새로 쓴다(3b단계, 2026-09).
 * 설계: docs/02-design/features/doc-copy.design.md
 *
 * ── 옮기는 칸은 **허용 목록**으로만 ──
 * 문서를 통째로 펼쳐 넘기면(`{ ...doc }`) 문서번호·결재·상태·연결이 같이 딸려 온다. 특히 **연결**
 * (원본 견적·청구서·지출)을 복사하면 같은 청구서·지출에 문서가 둘 붙어 **같은 돈이 두 번 결재된다**
 * (서버도 막지만, 막히기 전에 안 만드는 게 먼저다 — 사용자 확정 2026-09-15).
 * 그래서 옮길 칸을 여기 한 곳에 이름으로 적는다. 칸이 새로 생겨도 여기 적기 전엔 안 옮겨진다.
 *
 * 안 옮기는 것: 문서번호 · 날짜(요청일/지급일) · 신청자 · 결재선·승인 상태 · 연결(source·invoice·txn·품의)
 * 세 입구(선택창 '지난 문서에서' · 미리보기 [복사] · 거래처 옆 '지난 문서')가 모두 이 함수를 쓴다.
 */

const str = (v) => (v == null ? '' : String(v))

/** 구매품의서 품목 한 줄 — 실단가·실금액은 비운다(아직 안 산 것이다. 지난 실제값이 굳으면 안 된다) */
const preqItem = (it) => ({
  name: str(it.name), unit: str(it.unit),
  qty: it.qty ? str(it.qty) : '',
  unit_price: it.unit_price ? str(it.unit_price) : '',
  amount: it.amount ? str(it.amount) : '',
  actual_price: '', actual_amount: '', memo: str(it.memo),
})

/** 지급결의서 품목 한 줄 */
const resItem = (it) => ({
  name: str(it.name), unit: str(it.unit),   // 규격은 따로 없다 — 서버가 이름에 합쳐 둔다(routes/resolutions.js)
  qty: Number(it.qty) || 0, price: Number(it.price) || 0, amount: Number(it.amount) || 0,
  note: str(it.note),
})

/**
 * @param kind  'preq'(구매품의서) | 'resolution'(지급결의서)
 * @param doc   원본 문서(상세 조회 결과)
 * @param opts.itemsOnly  거래처 옆 '지난 문서'에서 온 경우 — 거래처는 폼에 이미 골랐으니 품목·내용만
 * @returns 새 작성 폼에 넣을 값
 */
export function copySeedOf(kind, doc, { itemsOnly = false } = {}) {
  if (!doc) return null
  if (kind === 'preq') {
    const items = (doc.items || []).map(preqItem)
    if (itemsOnly) return { items, summary: str(doc.summary) }
    return {
      vendor_id: doc.vendor_id || null, vendor_name: str(doc.vendor_name),
      order_source: str(doc.order_source), ship_no: str(doc.ship_no), summary: str(doc.summary),
      pay_terms: str(doc.pay_terms), man_hours: str(doc.man_hours), note: str(doc.note),
      items,
    }
  }
  if (kind === 'resolution') {
    /* 원본에만 뜻이 있는 줄은 뺀다(코드 검토 지적):
       · **기지급액**(음수) — 일부 지급된 청구서에서 만든 결의서가 '남은 금액'을 맞추려 넣은 줄이다.
         따라오면 다음 달 결의서가 그만큼 모자란다(110만 청구서에 50만 낸 원본 → 복사본 60만).
       · 청구서에서 온 줄의 비고는 **그 청구서 번호**다 — 새 결의서에는 틀린 근거가 된다. */
    const fromBill = !!doc.invoice_id
    const items = (doc.items || [])
      .filter(it => Number(it.amount) > 0)
      .map(it => resItem(fromBill ? { ...it, note: '' } : it))
    if (itemsOnly) return { items, title: str(doc.title) }
    return {
      vendor_id: doc.vendor_id || null, vendor_name: str(doc.vendor_name),
      title: str(doc.title), pay_method: str(doc.pay_method) || '계좌이체', note: str(doc.note),
      items,
    }
  }
  return null
}

/** 복사된 결의서 품목의 합계 — 결의서 금액은 품목 합이다 */
export const resolutionTotalOf = (items) => (items || []).reduce((s, it) => s + (Number(it.amount) || 0), 0)
