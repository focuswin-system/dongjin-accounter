/**
 * MES 쓰기 — **거래처 표(COERP_COM_CLIENTELE) 하나만.** 이 앱이 MES 를 고치는 유일한 문이다.
 *
 * 2026-09-28 사용자 결정: 동진테크는 거래처를 MES 표 하나로 쓴다. 회계 화면에서 등록·수정하면
 * 여기로 와서 MES 표에 저장된다. 다른 MES 표는 절대 쓰지 않는다.
 * ⚠ DB 계정도 이 표 INSERT·UPDATE 만 받는다(mesDb.js 머리말). 지우기(DELETE)는 권한도 없다 —
 *   MES 수주·발주가 거래처코드를 들고 있어서, 지우면 MES 쪽이 깨진다. 끄기(enab_yesn=0)만 한다.
 */
const { nextClieCode } = require('./map/vendor')

/* 누가 고쳤는지 MES 화면에도 보이게 — user_idno/modi_idno 는 varchar(10) */
const BY = 'ACCT'

const COLS = ['clie_name', 'clie_gubu', 'pres_name', 'clie_sano', 'addr_knam', 'addr_deta', 'tele_numb', 'faxs_numb',
  'taxb_mail', 'damd_name', 'upta_name', 'jong_moks', 'bank_name', 'acco_numb', 'hold_name', 'enab_yesn']

function yyyymmKst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * 새 거래처를 MES 에 만든다. 코드는 MES 와 같은 규칙으로 받는다.
 * 번호가 겹치면(같은 순간 MES 화면에서도 등록) 다시 받는다 — MES 도 같은 방식이다.
 * @returns {{ code:string, rev:string }}
 */
async function insertClient(mes, fields) {
  const yyyymm = yyyymmKst()
  for (let i = 0; i < 3; i++) {
    const [[m]] = await mes.query(
      'SELECT MAX(clie_code) AS max_code FROM COERP_COM_CLIENTELE WHERE clie_code LIKE ?', [`${yyyymm}%`])
    const code = nextClieCode(m?.max_code || null, yyyymm)
    try {
      await mes.execute(
        `INSERT INTO COERP_COM_CLIENTELE (clie_code, ${COLS.join(', ')}, clie_loca, user_idno, user_date, modi_idno, modi_date)
         VALUES (?, ${COLS.map(() => '?').join(', ')}, '국내', ?, NOW(), ?, NOW())`,
        [code, ...COLS.map(c => fields[c] ?? ''), BY, BY])
      return { code, rev: await revOf(mes, code) }
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY' || i === 2) throw e
    }
  }
  throw new Error('MES 거래처코드를 받지 못했어요')
}

/** MES 거래처 한 곳을 고친다 */
async function updateClient(mes, code, fields) {
  const cols = COLS.filter(c => c in fields)
  const [r] = await mes.execute(
    `UPDATE COERP_COM_CLIENTELE SET ${cols.map(c => `${c} = ?`).join(', ')}, modi_idno = ?, modi_date = NOW()
      WHERE clie_code = ?`,
    [...cols.map(c => fields[c]), BY, code])
  if (!r.affectedRows) return null
  return { rev: await revOf(mes, code) }
}

/** 고친 뒤의 수정 시각 — 다음 끌어오기 때 '우리가 쓴 것'을 다시 덮지 않게 대장에 적어 둔다 */
async function revOf(mes, code) {
  const [[r]] = await mes.query(
    'SELECT COALESCE(modi_date, user_date) AS rev FROM COERP_COM_CLIENTELE WHERE clie_code = ?', [code])
  return r?.rev || null
}

module.exports = { insertClient, updateClient }
