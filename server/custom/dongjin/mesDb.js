/**
 * 동진테크 MES DB 연결 — 같은 MariaDB 서버의 다른 DB(winc_dj).
 *
 * ⚠ 테넌트 풀(db/poolManager getPool)을 쓰지 않는다. 그 풀의 DB 이름은 **JWT 에서만** 온다 —
 *   요청이 다른 회사 DB 를 고를 수 없게 만든 장치라, 여기서 우회하면 그 장치가 무너진다.
 *   그래서 MES 는 환경변수로 정한 **한 DB 만** 여는 별도 풀이다.
 *
 * ⚠ 계정 권한으로 잠근다(설계 §7-3):
 *   SELECT          winc_dj.*                     ← 수주 현황·거래처 끌어오기
 *   INSERT, UPDATE  winc_dj.COERP_COM_CLIENTELE   ← 거래처 등록·수정(mesWrite.js) 하나뿐. DELETE 는 주지 않는다
 *   코드 실수로도 다른 표는 못 쓴다.
 *
 * 환경변수(server/.env) — 비밀번호에 # 이 있으면 따옴표 필수:
 *   MES_DB_NAME=winc_dj  MES_DB_USER=…  MES_DB_PASSWORD="…"  [MES_DB_HOST] [MES_DB_PORT]
 * MES_DB_NAME 이 없으면 '설정 안 됨' — 화면이 그렇게 알려 주고, 나머지 앱은 멀쩡하다.
 */
const mysql = require('mysql2/promise')

let pool = null

function mesConfig() {
  const database = String(process.env.MES_DB_NAME || '').trim()
  if (!database) return null
  return {
    host: process.env.MES_DB_HOST || process.env.DB_HOST || 'localhost',
    port: Number(process.env.MES_DB_PORT || 3306),
    user: process.env.MES_DB_USER,
    password: process.env.MES_DB_PASSWORD,
    database,
    /* 연결 예산: 테넌트 30×3 + 플랫폼 10 + 여기 2 = 102 / MariaDB 기본 151 */
    connectionLimit: 2,
    // MES 가 멈춰 있으면 빨리 포기한다 — 거래처 목록이 기본 10초씩 기다리면 회계 화면이 다 느려진다
    connectTimeout: 2000,
    charset: 'utf8mb4',
    // 날짜를 Date 로 받으면 KST/UTC 가 섞인다 — MES 가 저장한 글자 그대로 받는다
    dateStrings: true,
  }
}

/** MES 풀. 설정이 없으면 null — 부르는 쪽이 '설정 안 됨'으로 답한다. */
function mesPool() {
  if (pool) return pool
  const cfg = mesConfig()
  if (!cfg) return null
  pool = mysql.createPool(cfg)
  return pool
}

module.exports = { mesPool, mesConfig }
