/**
 * MES 거래처(COERP_COM_CLIENTELE) ↔ 회계 거래처(vendors) 칸 대응 — **순수 함수.**
 *
 * 2026-09-28 사용자 결정: 동진테크는 거래처를 **MES 표 하나로** 쓴다.
 *   · MES 표가 원본이다. 회계 화면에서 등록·수정하면 MES 표에 저장된다.
 *   · 회계 vendors 에는 MES 코드 하나당 **짝 행**이 하나 있다(1:1, external_links).
 *     청구서·거래·계약 등 회계 표 11곳이 거래처를 id 로 가리키기 때문이다(FK).
 *     짝 행의 내용은 늘 MES 값으로 덮인다 — 사람이 보는 값은 MES 값이다.
 *   · 회계에만 있는 칸(업종 분류·지급 계좌 여럿·담당자 여럿)은 회계에 남는다. MES 에 자리가 없다.
 */

/* MES 업체구분(공통코드 A01, 운영 실측) ↔ 회계 gubu.
 * ⚠ 칸 설명(COMMENT)은 'E:금융관공서' 지만 **실제 코드표는 D=금융/관공, E=기타** 다. 코드표를 따른다. */
const GUBU_TO_ACCT = { A: 'A', B: 'B', C: 'C', D: 'E', E: 'A' }
const GUBU_TO_MES = { A: 'A', B: 'B', C: 'C', E: 'D' }

const s = (v) => String(v ?? '').trim()
const digits = (v) => s(v).replace(/[^0-9]/g, '')

/** 사업자번호를 000-00-00000 로(회계 화면 표기). 10자리가 아니면 받은 그대로 */
function fmtBiz(v) {
  const d = digits(v)
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : s(v)
}

const joinAddr = (r) => [s(r.addr_knam), s(r.addr_deta)].filter(Boolean).join(' ')

/** MES 행 → 회계 vendors 칸들(짝 행에 덮어쓸 값) */
function mesToVendor(r) {
  return {
    name: s(r.clie_name),
    biz_no: fmtBiz(r.clie_sano),
    ceo: s(r.pres_name),
    address: joinAddr(r),
    phone: s(r.tele_numb),
    fax: s(r.faxs_numb),
    // 회계의 이메일은 세금계산서를 받는 주소로 쓴다 — MES 에서 그 칸은 taxb_mail
    email: s(r.taxb_mail),
    contact: s(r.damd_name),
    gubu: GUBU_TO_ACCT[s(r.clie_gubu)] || 'A',
    biz_type: s(r.upta_name),
    biz_item: s(r.jong_moks),
    bank_name: s(r.bank_name),
    bank_account: s(r.acco_numb),
    account_holder: s(r.hold_name),
    active: Number(r.enab_yesn) ? 1 : 0,
  }
}

/** 회계 행과 MES 에서 온 값이 다른가 — 같으면 쓰지 않는다(쓸데없는 UPDATE 로 수정 시각이 흔들리지 않게) */
function vendorDiffers(local, fromMes) {
  return Object.keys(fromMes).some(k => (k === 'active'
    ? Number(local[k] ?? 1) !== fromMes[k]
    : s(local[k]) !== s(fromMes[k])))
}

/* MES 칸 길이(운영 실측) — 넘치면 MariaDB strict 모드가 문장 전체를 거절한다 */
const MAX = {
  clie_name: 100, pres_name: 20, clie_sano: 14, addr_knam: 200, addr_deta: 200, tele_numb: 40, faxs_numb: 40,
  taxb_mail: 50, damd_name: 20, upta_name: 50, jong_moks: 50, bank_name: 50, acco_numb: 50, hold_name: 40,
}
const cut = (col, v) => s(v).slice(0, MAX[col] ?? 200)

/**
 * 회계 vendors 행 → MES 칸들(INSERT·UPDATE 공용).
 * @param v    회계 행
 * @param cur  지금의 MES 행(수정일 때). 없으면 새로 만드는 것
 *
 * 주소: MES 는 주소·상세주소 두 칸이다. 회계 값이 MES 두 칸을 이은 것과 같으면 **안 건드린다**
 *       (안 그러면 저장할 때마다 상세주소가 앞 칸으로 합쳐진다). 다르면 앞 칸에 통째로 넣는다.
 * 구분: 회계 A(매입)는 MES 'E(기타)'에서도 온다. MES 가 E 였고 회계가 A 그대로면 E 를 지킨다.
 */
function vendorToMes(v, cur = null) {
  const out = {
    clie_name: cut('clie_name', v.name),
    pres_name: cut('pres_name', v.ceo),
    clie_sano: cut('clie_sano', fmtBiz(v.biz_no)),
    tele_numb: cut('tele_numb', v.phone),
    faxs_numb: cut('faxs_numb', v.fax),
    taxb_mail: cut('taxb_mail', v.email),
    damd_name: cut('damd_name', v.contact),
    upta_name: cut('upta_name', v.biz_type),
    jong_moks: cut('jong_moks', v.biz_item),
    bank_name: cut('bank_name', v.bank_name),
    acco_numb: cut('acco_numb', v.bank_account),
    hold_name: cut('hold_name', v.account_holder),
    enab_yesn: Number(v.active ?? 1) ? 1 : 0,
  }
  const gubu = GUBU_TO_MES[s(v.gubu)] || 'A'
  out.clie_gubu = cur && s(cur.clie_gubu) === 'E' && gubu === 'A' ? 'E' : gubu
  if (cur && s(v.address) === joinAddr(cur)) {
    out.addr_knam = s(cur.addr_knam); out.addr_deta = s(cur.addr_deta)
  } else {
    out.addr_knam = cut('addr_knam', v.address); out.addr_deta = ''
  }
  return out
}

/**
 * 짝이 없는 회계 거래처에게 MES 쪽 짝을 찾아 준다 — 처음 옮길 때와, 다른 경로(홈택스·엑셀 임포트)로
 * 회계에 먼저 생긴 거래처를 MES 로 올리기 전에 쓴다. **같은 회사를 MES 에 두 번 만들지 않기 위해서다.**
 *   1) 사업자번호(숫자만)가 같고 아직 짝이 없는 MES 행
 *   2) 사업자번호가 둘 다 없을 때만, 상호가 정확히 같은 MES 행 — **딱 하나일 때만.**
 *      같은 이름이 둘이면 어느 쪽인지 모른다. 잘못 이으면 남의 값으로 덮이니 잇지 않는다.
 * @returns MES 행 | null
 */
function findMesMatch(vendor, freeMesRows) {
  const b = digits(vendor.biz_no)
  if (b) return freeMesRows.find(r => digits(r.clie_sano) === b) || null
  const n = s(vendor.name)
  if (!n) return null
  const hits = freeMesRows.filter(r => !digits(r.clie_sano) && s(r.clie_name) === n)
  return hits.length === 1 ? hits[0] : null
}

/** MES 거래처코드 다음 번호 — MES clieService.nextCode 와 **같은 규칙**(YYYYMM + A~Z + 001~999) */
function nextClieCode(maxCode, yyyymm) {
  if (!maxCode) return `${yyyymm}A001`
  const prefix = maxCode.charAt(6)
  const serial = parseInt(maxCode.substring(7), 10)
  if (serial < 999) return `${maxCode.substring(0, 6)}${prefix}${String(serial + 1).padStart(3, '0')}`
  const next = String.fromCharCode(prefix.charCodeAt(0) + 1)
  if (next > 'Z') throw new Error('MES 거래처코드 월별 한도 초과')
  return `${maxCode.substring(0, 6)}${next}001`
}

module.exports = {
  GUBU_TO_ACCT, GUBU_TO_MES, fmtBiz, mesToVendor, vendorDiffers, vendorToMes, findMesMatch, nextClieCode,
}
