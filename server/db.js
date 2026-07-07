require('dotenv').config()
const mysql = require('mysql2/promise')
const { randomUUID } = require('crypto')

const DB_NAME = process.env.DB_NAME || 'dongjin_erp'

const baseConfig = {
  host:     process.env.DB_HOST     || 'localhost',
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '1234',
  charset:  'utf8',
}

const pool = mysql.createPool({
  ...baseConfig,
  database:           DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
})

async function initDb() {
  // DB 생성 (없는 경우). 운영 서버처럼 DB가 이미 있고 계정에 CREATE 권한이
  // 없으면 조용히 건너뛴다(전용 계정은 자기 DB 권한만 가짐).
  try {
    const conn = await mysql.createConnection(baseConfig)
    await conn.execute(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8 COLLATE utf8_general_ci`)
    await conn.end()
  } catch (e) {
    console.warn('DB 생성 단계 건너뜀:', e.code || e.message)
  }

  // 테이블 생성
  const c = await pool.getConnection()
  try {
    await c.execute(`
      CREATE TABLE IF NOT EXISTS accounts (
        id              VARCHAR(36) PRIMARY KEY,
        name            VARCHAR(255) NOT NULL,
        bank            VARCHAR(100),
        type            VARCHAR(50) DEFAULT '보통예금',
        kind            VARCHAR(10) DEFAULT 'bank',
        number          VARCHAR(100),
        purpose         VARCHAR(100),
        initial_balance BIGINT DEFAULT 0,
        created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS account_adjustments (
        id          VARCHAR(36) PRIMARY KEY,
        account_id  VARCHAR(36),
        amount      BIGINT NOT NULL,
        reason      VARCHAR(255),
        date        VARCHAR(20) NOT NULL,
        created_by  VARCHAR(100),
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS vendors (
        id           VARCHAR(36) PRIMARY KEY,
        name         VARCHAR(255) NOT NULL,
        biz_no       VARCHAR(50),
        ceo          VARCHAR(100),
        address      VARCHAR(500),
        phone        VARCHAR(50),
        gubu         ENUM('A','B','E'),
        type         VARCHAR(100),
        service_type VARCHAR(100),
        contact      VARCHAR(100),
        fax          VARCHAR(50),
        email        VARCHAR(200),
        created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS employees (
        id          VARCHAR(36) PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        role        VARCHAR(100),
        department  VARCHAR(100),
        base_salary BIGINT DEFAULT 0,
        join_date   VARCHAR(20),
        active      TINYINT DEFAULT 1,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS contracts (
        id          VARCHAR(36) PRIMARY KEY,
        vendor_id   VARCHAR(36),
        name        VARCHAR(255) NOT NULL,
        amount      BIGINT NOT NULL,
        start_date  VARCHAR(20),
        end_date    VARCHAR(20),
        status      VARCHAR(50) DEFAULT '진행중',
        buyer_code  VARCHAR(50),
        pu_no       VARCHAR(50),
        order_no    VARCHAR(50),
        vessel_code VARCHAR(50),
        cost_budget TEXT,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id)
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS milestones (
        id          VARCHAR(36) PRIMARY KEY,
        contract_id VARCHAR(36),
        type        VARCHAR(50),
        ratio       INT,
        amount      BIGINT,
        due_date    VARCHAR(20),
        status      VARCHAR(50) DEFAULT '예정',
        invoice_id  VARCHAR(36),
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS invoices (
        id             VARCHAR(36) PRIMARY KEY,
        invoice_no     VARCHAR(30),
        kind           ENUM('issued','received'),
        vendor_id      VARCHAR(36),
        contract_id    VARCHAR(36),
        supply_amount  BIGINT NOT NULL,
        vat_amount     BIGINT NOT NULL,
        total_amount   BIGINT NOT NULL,
        issued_at      VARCHAR(20) NOT NULL,
        due_at         VARCHAR(20),
        status         VARCHAR(50) DEFAULT '입금 예정',
        account_id     VARCHAR(36),
        memo           TEXT,
        created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id)    REFERENCES vendors(id),
        FOREIGN KEY (contract_id)  REFERENCES contracts(id),
        FOREIGN KEY (account_id)   REFERENCES accounts(id)
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS invoice_matches (
        id         VARCHAR(36) PRIMARY KEY,
        invoice_id VARCHAR(36),
        txn_id     VARCHAR(36),
        amount     BIGINT NOT NULL,
        matched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS invoice_docs (
        id         VARCHAR(36) PRIMARY KEY,
        invoice_id VARCHAR(36),
        url        VARCHAR(500) NOT NULL,
        name       VARCHAR(300),
        doc_type   VARCHAR(50),
        size       BIGINT DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        id           VARCHAR(36) PRIMARY KEY,
        kind         ENUM('income','expense'),
        vendor_id    VARCHAR(36),
        contract_id  VARCHAR(36),
        account_id   VARCHAR(36),
        category     VARCHAR(100),
        sub_category VARCHAR(100),
        amount       BIGINT NOT NULL,
        date         VARCHAR(20) NOT NULL,
        method       VARCHAR(50),
        status       VARCHAR(50) DEFAULT '지급완료',
        buyer_type   VARCHAR(50),
        vessel_no    VARCHAR(50),
        usage_place  VARCHAR(200),
        invoice_id   VARCHAR(36),
        recurring_id VARCHAR(36),
        doc_no       VARCHAR(50),
        employee_id  VARCHAR(36),
        evid_type    VARCHAR(50),
        evid_url     VARCHAR(500),
        memo         TEXT,
        created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id)   REFERENCES vendors(id),
        FOREIGN KEY (contract_id) REFERENCES contracts(id),
        FOREIGN KEY (account_id)  REFERENCES accounts(id),
        FOREIGN KEY (invoice_id)  REFERENCES invoices(id),
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS recurring_expenses (
        id             VARCHAR(36) PRIMARY KEY,
        vendor_id      VARCHAR(36),
        contract_id    VARCHAR(36),
        category       VARCHAR(100),
        amount         BIGINT NOT NULL,
        period         ENUM('monthly','quarterly','yearly'),
        day_of_month   INT,
        start_date     VARCHAR(20) NOT NULL,
        end_date       VARCHAR(20),
        account_id     VARCHAR(36),
        active         TINYINT DEFAULT 1,
        last_generated VARCHAR(20),
        created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id)   REFERENCES vendors(id),
        FOREIGN KEY (contract_id) REFERENCES contracts(id),
        FOREIGN KEY (account_id)  REFERENCES accounts(id)
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS recurring_invoices (
        id             VARCHAR(36) PRIMARY KEY,
        vendor_id      VARCHAR(36),
        contract_id    VARCHAR(36),
        item           VARCHAR(255),
        supply_amount  BIGINT NOT NULL,
        vat_mode       ENUM('exclusive','none') DEFAULT 'exclusive',
        period         ENUM('monthly','quarterly','yearly'),
        day_of_month   INT,
        start_date     VARCHAR(20) NOT NULL,
        end_date       VARCHAR(20),
        account_id     VARCHAR(36),
        active         TINYINT DEFAULT 1,
        last_generated VARCHAR(20),
        created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id)   REFERENCES vendors(id),
        FOREIGN KEY (contract_id) REFERENCES contracts(id),
        FOREIGN KEY (account_id)  REFERENCES accounts(id)
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS payroll (
        id          VARCHAR(36) PRIMARY KEY,
        employee_id VARCHAR(36),
        month       VARCHAR(7) NOT NULL,
        base_salary BIGINT,
        allowance   BIGINT DEFAULT 0,
        deduction   BIGINT DEFAULT 0,
        net_salary  BIGINT,
        status      VARCHAR(50) DEFAULT '확정',
        txn_id      VARCHAR(36),
        UNIQUE KEY uq_emp_month (employee_id, month),
        FOREIGN KEY (employee_id) REFERENCES employees(id),
        FOREIGN KEY (txn_id)      REFERENCES transactions(id)
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS payroll_item_types (
        id            VARCHAR(36) PRIMARY KEY,
        label         VARCHAR(100) NOT NULL,
        kind          ENUM('earn','deduct') NOT NULL,
        mode          ENUM('fixed','percent') DEFAULT 'fixed',
        default_value DECIMAL(14,3) DEFAULT 0,
        sort_order    INT DEFAULT 0,
        active        TINYINT DEFAULT 1,
        created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id         VARCHAR(36) PRIMARY KEY,
        username   VARCHAR(100) NOT NULL UNIQUE,
        password   VARCHAR(255) NOT NULL,
        name       VARCHAR(100),
        role       ENUM('admin','user') DEFAULT 'user',
        active     TINYINT DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS categories (
        id          VARCHAR(20) PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        group_name  VARCHAR(50),
        vat         VARCHAR(10) DEFAULT '10%',
        pay_method  VARCHAR(50) DEFAULT '계좌이체',
        sort_order  INT DEFAULT 0,
        active      TINYINT DEFAULT 1,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await c.execute(`
      CREATE TABLE IF NOT EXISTS company_info (
        id           VARCHAR(36) PRIMARY KEY,
        name         VARCHAR(255),
        biz_no       VARCHAR(50),
        ceo          VARCHAR(100),
        biz_type     VARCHAR(100),
        biz_item     VARCHAR(100),
        address      VARCHAR(500),
        phone        VARCHAR(50),
        fax          VARCHAR(50),
        email        VARCHAR(200),
        main_account VARCHAR(255),
        updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await c.execute(`
      CREATE TABLE IF NOT EXISTS transaction_docs (
        id         VARCHAR(36) PRIMARY KEY,
        txn_id     VARCHAR(36),
        url        VARCHAR(500) NOT NULL,
        name       VARCHAR(300),
        doc_type   VARCHAR(50),
        size       BIGINT DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (txn_id) REFERENCES transactions(id) ON DELETE CASCADE
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS contract_docs (
        id          VARCHAR(36) PRIMARY KEY,
        contract_id VARCHAR(36),
        url         VARCHAR(500) NOT NULL,
        name        VARCHAR(300),
        doc_type    VARCHAR(50),
        size        BIGINT DEFAULT 0,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS hr_codes (
        id         VARCHAR(36) PRIMARY KEY,
        type       VARCHAR(20) NOT NULL,
        name       VARCHAR(100) NOT NULL,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // ── 마이그레이션: 기존 DB에 신규 컬럼 추가 (MySQL은 ADD COLUMN IF NOT EXISTS 미지원) ──
    const ensureColumn = async (table, col, ddl) => {
      const [[{ cnt }]] = await c.execute(
        `SELECT COUNT(*) AS cnt FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
        [DB_NAME, table, col]
      )
      if (cnt === 0) await c.execute(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`)
    }
    await ensureColumn('accounts', 'kind',    "kind VARCHAR(10) DEFAULT 'bank'")
    await ensureColumn('accounts', 'number',  "`number` VARCHAR(100)")
    await ensureColumn('accounts', 'purpose', "purpose VARCHAR(100)")
    await ensureColumn('invoices', 'invoice_no', "invoice_no VARCHAR(30)")
    // 급여대장: 항목별 명세(JSON), 총지급액, 지급 예정일
    await ensureColumn('payroll', 'items',    "items TEXT")
    await ensureColumn('payroll', 'gross',    "gross BIGINT DEFAULT 0")
    await ensureColumn('payroll', 'pay_date', "pay_date VARCHAR(20)")
    // 실제 급여 지출 ↔ 급여대장 연결(분할 지급/미지급/과지급 추적)
    await ensureColumn('transactions', 'payroll_id', "payroll_id VARCHAR(36)")
    // 직원 고정 수당(급여대장 생성 시 명세서에 자동 채움) + 부양가족(참고용)
    await ensureColumn('employees', 'emp_no',             "emp_no VARCHAR(20)")
    await ensureColumn('employees', 'position_allowance', "position_allowance BIGINT DEFAULT 0")
    await ensureColumn('employees', 'meal_allowance',     "meal_allowance BIGINT DEFAULT 0")
    await ensureColumn('employees', 'vehicle_allowance',  "vehicle_allowance BIGINT DEFAULT 0")
    await ensureColumn('employees', 'dependents',         "dependents INT DEFAULT 1")
    await ensureColumn('employees', 'child_dependents',   "child_dependents INT DEFAULT 0")
    await ensureColumn('employees', 'birth_date',         "birth_date VARCHAR(20)")
    // 계약서 첨부 파일(레거시 단일 파일)
    await ensureColumn('contracts', 'file_url',  "file_url VARCHAR(500)")
    await ensureColumn('contracts', 'file_name', "file_name VARCHAR(300)")
    // 계약번호(계약서 번호) — 회사에 따라 계약을 번호로 식별
    await ensureColumn('contracts', 'contract_no', "contract_no VARCHAR(50)")

    // 표준 공제 항목 4대보험 요율: 2025년 시드값 → 2026년 확정값으로 1회 보정
    // (사용자가 직접 바꾼 값은 건드리지 않도록, 구(舊)값과 정확히 일치할 때만 갱신)
    const bumpRate = async (label, from, to) => {
      await c.execute(
        "UPDATE payroll_item_types SET default_value=? WHERE label=? AND mode='percent' AND default_value=?",
        [to, label, from]
      )
    }
    await bumpRate('국민연금', 4.5,   4.75)
    await bumpRate('건강보험', 3.545, 3.595)
    await bumpRate('장기요양', 0.459, 0.472)

    // 자동 생성 거래(청구서 정산·정기지출·급여)에 계약/공통 스코프가 비어 편집 시 공란이 되는 문제 보정
    await c.execute("UPDATE transactions SET doc_no='공통' WHERE (doc_no IS NULL OR doc_no='') AND (contract_id IS NULL OR contract_id='') AND (invoice_id IS NOT NULL OR recurring_id IS NOT NULL OR payroll_id IS NOT NULL)")

    // 초기 데이터 시딩 (테이블이 비어 있을 때만)
    const [[{ cnt }]] = await c.execute('SELECT COUNT(*) AS cnt FROM categories')
    if (cnt === 0) {
      const seed = [
        ["EXP-101","생산 급여","인건비(생산)","면세","계좌이체",1],
        ["EXP-102","복리후생비(생산)","인건비(생산)","면세","계좌이체",2],
        ["EXP-103","퇴직급여(생산)","인건비(생산)","면세","계좌이체",3],
        ["EXP-104","관리 급여","인건비(관리)","면세","계좌이체",4],
        ["EXP-105","복리후생비(관리)","인건비(관리)","면세","계좌이체",5],
        ["EXP-106","퇴직급여(관리)","인건비(관리)","면세","계좌이체",6],
        ["EXP-201","철강 원자재","재료비","10%","계좌이체",7],
        ["EXP-202","비철금속","재료비","10%","계좌이체",8],
        ["EXP-203","특수강","재료비","10%","계좌이체",9],
        ["EXP-204","부자재","재료비","10%","법인카드",10],
        ["EXP-301","정밀가공 외주","외주가공비","10%","계좌이체",11],
        ["EXP-302","표면처리 외주","외주가공비","10%","계좌이체",12],
        ["EXP-303","도금 외주","외주가공비","10%","계좌이체",13],
        ["EXP-304","열처리 외주","외주가공비","10%","계좌이체",14],
        ["EXP-305","용접 외주","외주가공비","10%","계좌이체",15],
        ["EXP-306","연삭·방전 외주","외주가공비","10%","계좌이체",16],
        ["EXP-401","소모품비(생산)","소모품","10%","법인카드",17],
        ["EXP-402","소모품비(관리)","소모품","10%","법인카드",18],
        ["EXP-403","측정공구비","소모품","10%","법인카드",19],
        ["EXP-404","절삭유·윤활유","소모품","10%","법인카드",20],
        ["EXP-501","시험검사비","시험·인증","10%","계좌이체",21],
        ["EXP-502","검사성적서 발급","시험·인증","10%","계좌이체",22],
        ["EXP-503","방산인증 수수료","시험·인증","면세","계좌이체",23],
        ["EXP-504","KS·ISO 인증","시험·인증","면세","계좌이체",24],
        ["EXP-601","임차료","운영비","10%","계좌이체",25],
        ["EXP-602","전력비","운영비","10%","계좌이체",26],
        ["EXP-603","수도광열비","운영비","10%","계좌이체",27],
        ["EXP-604","통신비(관리)","운영비","10%","계좌이체",28],
        ["EXP-605","통신비(생산)","운영비","10%","계좌이체",29],
        ["EXP-606","수선비","운영비","10%","계좌이체",30],
        ["EXP-607","보험료","운영비","면세","계좌이체",31],
        ["EXP-608","운반비","운영비","10%","계좌이체",32],
        ["EXP-609","위탁관리비","운영비","10%","계좌이체",33],
        ["EXP-610","수수료","운영비","10%","계좌이체",34],
        ["EXP-701","차량유지비","차량·여비","10%","법인카드",35],
        ["EXP-702","출장비","차량·여비","면세","법인카드",36],
        ["EXP-703","접대비","차량·여비","10%","법인카드",37],
        ["EXP-801","안전관리비","안전·환경","10%","계좌이체",38],
        ["EXP-802","환경규제 비용","안전·환경","면세","계좌이체",39],
        ["EXP-901","세금과공과금","세금·금융","면세","계좌이체",40],
        ["EXP-902","이자비용","세금·금융","면세","계좌이체",41],
        ["EXP-903","판공비","세금·금융","면세","법인카드",42],
        ["EXP-904","기타 지출","세금·금융","—","—",43],
        ["INC-101","선급금","납품수익","10%","—",44],
        ["INC-102","기성고","납품수익","10%","—",45],
        ["INC-103","중도금","납품수익","10%","—",46],
        ["INC-104","검수 후 결제","납품수익","10%","—",47],
        ["INC-105","납품대금","납품수익","10%","—",48],
        ["INC-106","잔금","납품수익","10%","—",49],
        ["INC-201","고철·스크랩 수익","기타수익","10%","—",50],
        ["INC-202","환급금","기타수익","—","—",51],
        ["INC-203","잡수익","기타수익","—","—",52],
        ["INC-204","이자수익","기타수익","면세","—",53],
      ]
      for (const [id, name, group_name, vat, pay_method, sort_order] of seed) {
        await c.execute(
          'INSERT INTO categories (id, name, group_name, vat, pay_method, sort_order) VALUES (?,?,?,?,?,?)',
          [id, name, group_name, vat, pay_method, sort_order]
        )
      }
    }

    // 급여 항목 마스터 시딩 (비어 있을 때만) — 지급(earn)/공제(deduct)
    const [[{ pcnt }]] = await c.execute('SELECT COUNT(*) AS pcnt FROM payroll_item_types')
    if (pcnt === 0) {
      const items = [
        // 지급 항목(+)
        ["기본급",       "earn",   "fixed",   0,     1],
        ["직책수당",     "earn",   "fixed",   0,     2],
        ["식대(비과세)", "earn",   "fixed",   0,     3],
        ["자가운전보조", "earn",   "fixed",   0,     4],
        ["야근수당",     "earn",   "fixed",   0,     5],
        ["연장근로수당", "earn",   "fixed",   0,     6],
        ["상여금",       "earn",   "fixed",   0,     7],
        // 공제 항목(-)
        ["국민연금",     "deduct", "percent", 4.75,  20],
        ["건강보험",     "deduct", "percent", 3.595, 21],
        ["장기요양",     "deduct", "percent", 0.472, 22],
        ["고용보험",     "deduct", "percent", 0.9,   23],
        ["소득세(갑근세)", "deduct", "fixed", 0,     24],
        ["지방소득세",   "deduct", "fixed",   0,     25],
        ["건강보험정산", "deduct", "fixed",   0,     26],
        ["연말정산",     "deduct", "fixed",   0,     27],
        ["가불금 상환",  "deduct", "fixed",   0,     28],
      ]
      for (const [label, kind, mode, dv, so] of items) {
        await c.execute(
          'INSERT INTO payroll_item_types (id, label, kind, mode, default_value, sort_order) VALUES (?,?,?,?,?,?)',
          [randomUUID(), label, kind, mode, dv, so]
        )
      }
    }
  } finally {
    c.release()
  }
}

module.exports = { pool, initDb }
