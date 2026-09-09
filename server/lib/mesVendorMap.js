// MES(동진테크) 거래처 엑셀 ↔ 회계 거래처(vendors) 대사.
//
// MES 는 한 회사(사업자번호 1개)가 clie_code 여럿을 갖는다(날짜코드로 회사당 여러 개) → **N:1**.
// 그래서 사업자번호로 그룹핑해 **회사 단위**로 보고, 회계 거래처(vendors)와 사업자번호로 대사한다.
// clie_code 여럿이 매입·매출로 갈리면 회계 gubu 는 합집합(C=매입매출).
//
// 이 파일은 **순수 함수만** 둔다(DB·req 안 만짐). 라우트가 vendors·기존 매핑을 넘겨준다.

// 엑셀 컬럼 이름(거래처관리.xlsx 실양식). 바뀌면 여기만 고친다.
const COL = { code: '업체번호', name: '거래처[한]', biz: '사업자번호', gubu: '업체구분', ceo: '대표자명' }

const normBiz = (s) => String(s || '').replace(/[^0-9]/g, '')

// MES 업체구분(한글) → 회계 gubu 코드
function korToGubu(v) {
  const s = String(v || '').trim()
  if (/매입.*매출|매출.*매입/.test(s)) return 'C'   // 둘 다 언급 → 겸함
  if (/기관|금융|관공|은행/.test(s)) return 'E'
  if (/매입/.test(s)) return 'A'
  if (/매출|발주/.test(s)) return 'B'
  return null
}

// 한 회사의 clie_code 들이 가진 gubu 집합 → 최종 하나(A+B 는 C 로 승격)
function mergeGubu(codes) {
  const s = new Set(codes.filter(Boolean))
  if (s.has('C') || (s.has('A') && s.has('B'))) return 'C'
  if (s.has('A')) return 'A'
  if (s.has('B')) return 'B'
  if (s.has('E')) return 'E'
  return 'A'   // gubu 를 못 읽으면 매입(가장 흔함)으로 둔다
}

// parseSheet 의 rows(헤더키 객체 배열) → 회사 단위로 그룹핑.
// 반환: { companies:[{biz,name,ceo,clieCodes[],gubu}], noBiz:[{clieCode,name}] }
function groupCompanies(rows) {
  const byBiz = new Map()
  const noBiz = []
  for (const r of rows || []) {
    const clieCode = String(r[COL.code] ?? '').trim()
    if (!clieCode) continue
    const biz = normBiz(r[COL.biz])
    if (!biz) { noBiz.push({ clieCode, name: String(r[COL.name] ?? '').trim() }); continue }
    if (!byBiz.has(biz)) byBiz.set(biz, { biz, name: String(r[COL.name] ?? '').trim(), ceo: String(r[COL.ceo] ?? '').trim(), clieCodes: [], gubus: [] })
    const g = byBiz.get(biz)
    g.clieCodes.push(clieCode)
    const gc = korToGubu(r[COL.gubu])
    if (gc) g.gubus.push(gc)
  }
  const companies = [...byBiz.values()].map(c => ({
    biz: c.biz, name: c.name, ceo: c.ceo, clieCodes: c.clieCodes, gubu: mergeGubu(c.gubus),
  }))
  return { companies, noBiz }
}

// 회사 목록 ↔ 회계 vendors 대사. existingMap = vendor_mes_map 행들(있으면 이미 이은 clie_code 제외).
// 반환 3구획: matched(양쪽 사업자번호 일치) · toCreate(회계에 없음) · accountingOnly(회계에만).
function reconcile(companies, vendors, existingMap = []) {
  const vByBiz = new Map()
  for (const v of vendors || []) { const b = normBiz(v.biz_no); if (b) vByBiz.set(b, v) }
  const mappedCodes = new Set(existingMap.map(m => String(m.mes_clie_code)))

  const matched = [], toCreate = []
  for (const co of companies) {
    const newCodes = co.clieCodes.filter(cc => !mappedCodes.has(String(cc)))
    const v = vByBiz.get(co.biz)
    if (v) matched.push({ ...co, vendorId: v.id, vendorName: v.name, vendorGubu: v.gubu || null, newCodes, alreadyMapped: newCodes.length === 0 })
    else toCreate.push({ ...co, newCodes })
  }
  const coBiz = new Set(companies.map(c => c.biz))
  const accountingOnly = (vendors || [])
    .filter(v => { const b = normBiz(v.biz_no); return b && !coBiz.has(b) })
    .map(v => ({ vendorId: v.id, name: v.name, biz: normBiz(v.biz_no), gubu: v.gubu || null }))

  return {
    matched, toCreate, accountingOnly,
    summary: { companies: companies.length, matched: matched.length, toCreate: toCreate.length, accountingOnly: accountingOnly.length },
  }
}

module.exports = { COL, normBiz, korToGubu, mergeGubu, groupCompanies, reconcile }
