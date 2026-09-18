/* 청구서 없는 실제 지출 거래를 **한 줄** 만든다 — 결의서·품의 처리(docExec)와 반복거래(repeat)가 함께 쓴다.
 *
 * 왜 떼어냈나: 같은 INSERT 가 창구마다 한 벌씩 생기면 한쪽에만 칸이 빠진다(이 저장소는 그걸
 * 청구서 생성에서 열 번 겪고 invoiceCreate 로 모았다). 청구서 없는 비용은 계정과목(비목)과
 * 부가세 칸이 있어야 일계표·부가세 집계에 선다 — 그걸 한 곳에서 채운다.
 *
 * 부르는 쪽이 할 일: 미래 날짜·마감·중복(닮은 거래) 검사. 여기서는 장부 규칙만 지킨다.
 */
const { randomUUID } = require('crypto')
const { ledgerError } = require('./ledger')
const { vatFields } = require('./vat')
const { acctCodeByCategoryName } = require('./categoryAccount')
const { httpError } = require('./withTx')

/**
 * @param conn 트랜잭션 커넥션
 * @param f.amount    합계(VAT 포함)
 * @param f.supply    공급가(주면 그대로, 안 주면 과세유형으로 역산)
 * @param f.vat       세액
 * @returns 새 거래 id
 */
async function insertExpenseTxn(conn, f) {
  // 계좌가 없으면 만들지 않는다 — NULL 이면 어느 계좌 잔액에서도 안 빠져 잔액이 과대 계상된다
  const lerr = ledgerError({ kind: 'expense', account_id: f.accountId, status: '지급완료', method: f.method })
  if (lerr) throw httpError(400, lerr)
  const vat = vatFields({
    amount: f.amount, supply_amount: f.supply, vat_amount: f.vat,
    tax_type: f.taxType, vat_deductible: f.vatDeductible,
  })
  const acctCode = await acctCodeByCategoryName(conn, f.category, 'expense')
  const id = randomUUID()
  await conn.execute(
    `INSERT INTO transactions (id, kind, vendor_id, contract_id, account_id, account_code, category, amount, date, method,
                               status, doc_no, memo, supply_amount, vat_amount, tax_type, vat_deductible, evid_type, template_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, 'expense', f.vendorId || null, f.contractId || null, f.accountId || null, acctCode, f.category || '',
     Number(f.amount), f.date, f.method || '계좌이체',
     '지급완료', f.docNo || '', f.memo || '',
     vat.supply_amount, vat.vat_amount, vat.tax_type, vat.vat_deductible, f.evidType || null, f.templateId || null])
  return id
}

module.exports = { insertExpenseTxn }
