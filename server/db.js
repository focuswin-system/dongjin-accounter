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

/**
 * 테넌트 DB 스키마 생성·마이그레이션 (멱등).
 *
 * ⚠ DDL을 수행하므로 **관리 계정 연결**로 호출해야 한다.
 *   운영: scripts/setup-db.js · scripts/provision-tenant.js 가 withAdmin()으로 호출한다.
 *   개발: 연결을 넘기지 않으면 앱 풀로 폴백한다(로컬 계정이 DDL 권한을 가진 경우에만 동작).
 *
 * DB 자체(CREATE DATABASE)는 여기서 만들지 않는다 — 프로비저닝의 책임이다.
 * 대상 스키마는 연결이 붙어 있는 DB(SELECT DATABASE())로 결정되므로,
 * 어느 테넌트 DB에든 그대로 적용할 수 있다.
 *
 * @param {import('mysql2/promise').Connection} [conn] 관리 계정 연결(대상 DB에 접속된 상태)
 */
async function initDb(conn) {
  const c = conn || await pool.getConnection()
  const pooled = !conn   // 풀에서 빌린 연결만 release 한다
  try {
    // information_schema 조회는 '지금 붙어 있는 DB' 기준이어야 한다.
    // env의 DB_NAME을 쓰면 다른 테넌트를 초기화할 때 엉뚱한 스키마를 본다.
    const [[{ schemaName }]] = await c.execute('SELECT DATABASE() AS schemaName')
    if (!schemaName) throw new Error('initDb: 연결에 대상 데이터베이스가 지정되어 있지 않습니다')
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
        -- 거래 기록이 붙은 거래처는 지울 수 없다(지우면 장부가 어긋난다).
        -- 대신 미사용으로 두면 선택 목록에서만 빠지고 과거 기록은 그대로 남는다.
        active       TINYINT(1) NOT NULL DEFAULT 1,
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
        -- 어느 정기청구에서 나온 회차인지. 삭제 시 last_generated 를 되돌려
        -- 그 회차가 '발행 예정'에 다시 뜨게 하기 위해 필요하다(FK는 두지 않는다 —
        -- 정기청구 규칙을 지워도 이미 발행된 청구서는 남아야 한다).
        recurring_id   VARCHAR(36),
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
    /* 건너뛴 정기 회차.
     *
     * 정기 회차는 저장된 행이 아니라 규칙에서 **계산되는 값**이라, 잘못 잡힌 회차를 지울
     * 대상이 없었다. 그래서 "발행하고 나서 그 청구서를 삭제"하는 수밖에 없었다 —
     * 쓸데없는 청구번호가 소모되고, 마감·정산 가드에 걸리면 그마저 막힌다.
     * 그 달만 안 하기로 한 사실을 여기 남긴다(규칙 자체는 계속 돈다).
     * 되돌리려면 이 행을 지우면 그 회차가 그대로 다시 나타난다. */
    await c.execute(`
      CREATE TABLE IF NOT EXISTS recurring_skips (
        id           VARCHAR(36) PRIMARY KEY,
        kind         ENUM('invoice','expense') NOT NULL,
        recurring_id VARCHAR(36) NOT NULL,
        due_date     VARCHAR(20) NOT NULL,
        reason       VARCHAR(255),
        created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_recurring_skips (kind, recurring_id, due_date)
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
    // ⚠ 레거시 — 로그인 계정은 공용 관리 DB(acct_platform.users)로 이전됐다.
    // 이 테이블은 최초 부트스트랩(레거시 계정 이전)의 읽기 소스로만 남아 있으며,
    // 신규 테넌트에서는 사용하지 않는다. P7 정리 단계에서 제거 예정.
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
    // 계약 갱신 이력: 갱신할 때마다 계약의 end_date를 연장하고 회차별 기간·금액 변동을 남긴다
    await c.execute(`
      CREATE TABLE IF NOT EXISTS contract_renewals (
        id             VARCHAR(36) PRIMARY KEY,
        contract_id    VARCHAR(36) NOT NULL,
        seq            INT NOT NULL,
        prev_end_date  VARCHAR(20),
        new_end_date   VARCHAR(20),
        prev_amount    BIGINT,
        new_amount     BIGINT,
        renewed_at     VARCHAR(20),
        result         VARCHAR(20) DEFAULT '갱신',
        memo           VARCHAR(500),
        created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
      )
    `)
    // 지급결의서: 거래 1건 = 결의서 1건(Method A). 채번 후 저장 → 인쇄 → 대표 서명(전자결재 아님).
    // 헤더는 거래에서 자동 채우고, 품목 명세(items JSON)와 특기사항만 사람이 보완한다.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS expense_resolutions (
        id           VARCHAR(36) PRIMARY KEY,
        doc_no       VARCHAR(30) NOT NULL,
        txn_id       VARCHAR(36),
        vendor_id    VARCHAR(36),
        vendor_name  VARCHAR(255),
        title        VARCHAR(255),
        amount       BIGINT NOT NULL DEFAULT 0,
        pay_method   VARCHAR(50),
        pay_date     VARCHAR(20),
        applicant    VARCHAR(100),
        items        TEXT,
        note         VARCHAR(1000),
        approval     TEXT,
        status       VARCHAR(20) DEFAULT '작성',
        created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_expense_resolutions_doc_no (doc_no),
        FOREIGN KEY (txn_id)    REFERENCES transactions(id),
        FOREIGN KEY (vendor_id) REFERENCES vendors(id)
      )
    `)
    // 결재선 프리셋: 자주 쓰는 결재 단계를 저장해두고 결의서 만들 때 골라 쓴다.
    // steps = [{label:'담당', position:'대리'}, ...] (직위는 인사 기준정보 직위 또는 자유 입력)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS approval_presets (
        id         VARCHAR(36) PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        steps      TEXT,
        is_default TINYINT DEFAULT 0,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    // 정산내역서(定算內譯書) — 수령액(자금)을 받아 분류별로 집행하고 잔액을 맞추는 정산 문서.
    // 지급결의서(건별 승인)와 달리, 한 기간의 여러 지출을 분류(도로비·교통비·영업비·운송료·기타경비)로
    // 묶어 수령액 대비 잔액을 정산한다. settlement_lines 가 항목별 지출.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS settlements (
        id              VARCHAR(36) PRIMARY KEY,
        doc_no          VARCHAR(30) NOT NULL,
        settler         VARCHAR(100),
        settle_date     VARCHAR(20),
        trip_area       VARCHAR(200),
        trip_period     VARCHAR(200),
        purpose         VARCHAR(200),
        received_amount BIGINT NOT NULL DEFAULT 0,
        note            VARCHAR(1000),
        approval        TEXT,
        status          VARCHAR(20) DEFAULT '작성',
        created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_settlements_doc_no (doc_no)
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS settlement_lines (
        id            VARCHAR(36) PRIMARY KEY,
        settlement_id VARCHAR(36) NOT NULL,
        category      VARCHAR(30),
        title         VARCHAR(255),
        amount        BIGINT NOT NULL DEFAULT 0,
        memo          VARCHAR(500),
        sort_order    INT DEFAULT 0,
        INDEX idx_settlement_lines (settlement_id),
        FOREIGN KEY (settlement_id) REFERENCES settlements(id) ON DELETE CASCADE
      )
    `)
    // 구매품의서(購買稟議書) — 지출 전 구매 결재 문서. 공급업체·수주처·호선·품목(단가×수량)·품의금액.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS purchase_reqs (
        id            VARCHAR(36) PRIMARY KEY,
        doc_no        VARCHAR(30) NOT NULL,
        req_date      VARCHAR(20),
        vendor_id     VARCHAR(36),
        vendor_name   VARCHAR(255),
        order_source  VARCHAR(120),
        ship_no       VARCHAR(120),
        summary       VARCHAR(255),
        arrival_date  VARCHAR(20),
        order_amount  BIGINT DEFAULT 0,
        pay_terms     VARCHAR(60),
        man_hours     VARCHAR(60),
        applicant     VARCHAR(100),
        note          VARCHAR(1000),
        approval      TEXT,
        status        VARCHAR(20) DEFAULT '작성',
        created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_purchase_reqs_doc_no (doc_no)
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS purchase_req_items (
        id            VARCHAR(36) PRIMARY KEY,
        req_id        VARCHAR(36) NOT NULL,
        name          VARCHAR(255),
        spec          VARCHAR(255),
        unit          VARCHAR(30),
        qty           DECIMAL(18,2) DEFAULT 0,
        unit_price    BIGINT DEFAULT 0,
        amount        BIGINT DEFAULT 0,
        actual_price  BIGINT DEFAULT 0,
        actual_amount BIGINT DEFAULT 0,
        memo          VARCHAR(500),
        sort_order    INT DEFAULT 0,
        INDEX idx_purchase_req_items (req_id),
        FOREIGN KEY (req_id) REFERENCES purchase_reqs(id) ON DELETE CASCADE
      )
    `)
    // 견적요청서(REQUEST FOR QUOTATION) — 공급업체에 견적을 요청하는 문서. 단가는 업체가 채우는 형태라 0으로 두는 칸이 많다.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS quote_reqs (
        id             VARCHAR(36) PRIMARY KEY,
        doc_no         VARCHAR(30) NOT NULL,
        req_date       VARCHAR(20),
        vendor_id      VARCHAR(36),
        vendor_code    VARCHAR(60),
        vendor_name    VARCHAR(255),
        order_source   VARCHAR(120),
        ship_no        VARCHAR(120),
        drawing        VARCHAR(120),
        pay_terms      VARCHAR(60),
        deliver_place  VARCHAR(255),
        currency       VARCHAR(20) DEFAULT 'WON',
        applicant      VARCHAR(100),
        note           VARCHAR(1000),
        status         VARCHAR(20) DEFAULT '작성',
        created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_quote_reqs_doc_no (doc_no)
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS quote_req_items (
        id          VARCHAR(36) PRIMARY KEY,
        req_id      VARCHAR(36) NOT NULL,
        code        VARCHAR(60),
        name        VARCHAR(255),
        spec        VARCHAR(255),
        unit        VARCHAR(30),
        qty         DECIMAL(18,2) DEFAULT 0,
        unit_price  BIGINT DEFAULT 0,
        amount      BIGINT DEFAULT 0,
        memo        VARCHAR(500),
        sort_order  INT DEFAULT 0,
        INDEX idx_quote_req_items (req_id),
        FOREIGN KEY (req_id) REFERENCES quote_reqs(id) ON DELETE CASCADE
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

    // 기준정보 범용 테이블 (적요·품목·보험·고정자산·무형자산) — type으로 구분
    await c.execute(`
      CREATE TABLE IF NOT EXISTS ref_items (
        id          VARCHAR(36) PRIMARY KEY,
        type        VARCHAR(30) NOT NULL,
        name        VARCHAR(255) NOT NULL,
        code        VARCHAR(50),
        spec        VARCHAR(255),
        unit        VARCHAR(30),
        party       VARCHAR(255),
        amount      BIGINT DEFAULT 0,
        start_date  VARCHAR(20),
        end_date    VARCHAR(20),
        memo        VARCHAR(500),
        sort_order  INT DEFAULT 0,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // 부가세 신고 상태(분기별 납부/환급) — 집계는 invoices에서, 상태만 저장
    await c.execute(`
      CREATE TABLE IF NOT EXISTS vat_filings (
        id          VARCHAR(36) PRIMARY KEY,
        year        INT NOT NULL,
        quarter     INT NOT NULL,
        status      VARCHAR(30) DEFAULT '납부 대기',
        paid_amount BIGINT DEFAULT 0,
        paid_date   VARCHAR(20),
        memo        VARCHAR(500),
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_vat_filing (year, quarter)
      )
    `)

    // 기타세액(원천세·지방소득세 등) — 부가세 외 세금 수동 관리 레지스터
    await c.execute(`
      CREATE TABLE IF NOT EXISTS other_taxes (
        id          VARCHAR(36) PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        period      VARCHAR(50),
        tax_amount  BIGINT DEFAULT 0,
        paid_amount BIGINT DEFAULT 0,
        paid_date   VARCHAR(20),
        status      VARCHAR(30) DEFAULT '납부 대기',
        memo        VARCHAR(500),
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // 표준 계정과목(K-GAAP) — 고정 마스터. 사용자 CRUD 불가, 거래 입력 시 선택용.
    // 집계 계정(현금및현금성자산·매출채권·매입채무 등)은 code=NULL, postable=0.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS account_subjects (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        acct_type   VARCHAR(10)  NOT NULL,
        category    VARCHAR(40)  NOT NULL,
        name        VARCHAR(100) NOT NULL,
        code        VARCHAR(10),
        note        VARCHAR(500),
        postable    TINYINT DEFAULT 1,
        sort_order  INT DEFAULT 0
      )
    `)

    // 기성형(progress) 계약의 품목 단가표. 계약별 품목·규격·단위·단가(계약별로 수정 가능).
    // item_id는 품목 기준정보(ref_items type='item') 참조 — 인라인 추가 시 ref_items에도 등록해 연결한다.
    // name·spec·unit은 스냅샷(기준정보가 바뀌어도 계약 조건은 유지).
    await c.execute(`
      CREATE TABLE IF NOT EXISTS contract_items (
        id          VARCHAR(36) PRIMARY KEY,
        contract_id VARCHAR(36) NOT NULL,
        item_id     VARCHAR(36),
        name        VARCHAR(255) NOT NULL,
        spec        VARCHAR(255),
        unit        VARCHAR(30),
        unit_price  BIGINT DEFAULT 0,
        sort_order  INT DEFAULT 0,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
      )
    `)
    // 기성 청구서의 품목 내역(정식 line). 거래명세서 출력 + 품목별 누적 기성 집계의 단일 소스.
    // amount는 qty×unit_price가 기본값이지만 사람이 수정할 수 있어 별도 저장한다.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS invoice_lines (
        id          VARCHAR(36) PRIMARY KEY,
        invoice_id  VARCHAR(36) NOT NULL,
        item_id     VARCHAR(36),
        name        VARCHAR(255) NOT NULL,
        spec        VARCHAR(255),
        unit        VARCHAR(30),
        qty         DECIMAL(14,2) DEFAULT 0,
        unit_price  BIGINT DEFAULT 0,
        amount      BIGINT DEFAULT 0,
        sort_order  INT DEFAULT 0,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
      )
    `)

    // ── 인사급여: 근로·용역계약 ──
    // 고용형태 마스터. 사용자가 직접 유형을 만들고 기본값을 정한다.
    // '세법이 정하는 축(income_type)은 닫고, 회사가 정하는 축(고용형태)은 연다'는 원칙의 실체.
    // 계약은 이 값을 스냅샷으로 복사하므로, 마스터를 나중에 고쳐도 기존 계약서와 어긋나지 않는다.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS employ_types (
        id                VARCHAR(36) PRIMARY KEY,
        label             VARCHAR(50) NOT NULL,
        kind              ENUM('labor','service','daily') DEFAULT 'labor',
        income_type       ENUM('근로','사업','일용','기타') DEFAULT '근로',
        pay_form          ENUM('annual','monthly','hourly','daily','piece') DEFAULT 'monthly',
        default_unit      VARCHAR(30),
        insure_np         TINYINT DEFAULT 0,
        insure_hi         TINYINT DEFAULT 0,
        insure_ei         TINYINT DEFAULT 0,
        insure_ai         TINYINT DEFAULT 0,
        conv_alert_months INT DEFAULT 0,
        sort_order        INT DEFAULT 0,
        active            TINYINT DEFAULT 1,
        created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    // 근로·용역 계약. 급여대장의 '근거'이자 급여 기준(pay_items)의 소스.
    // 연봉이 오르면 UPDATE가 아니라 새 행을 만든다 → 이력이 자연히 남는다.
    //   kind        = 어느 화면에서 관리하나 (배치 축)
    //   income_type = 어느 신고자료로 가나 (세법 축)
    // 둘은 대개 붙어 다니지만 항상은 아니다(자문 계약 = service + 기타소득).
    await c.execute(`
      CREATE TABLE IF NOT EXISTS work_contracts (
        id                VARCHAR(36) PRIMARY KEY,
        employee_id       VARCHAR(36),
        kind              ENUM('labor','service','daily') NOT NULL DEFAULT 'labor',
        income_type       ENUM('근로','사업','일용','기타') NOT NULL DEFAULT '근로',
        title             VARCHAR(255),
        employ_type_id    VARCHAR(36),
        employ_type       VARCHAR(50),
        start_date        VARCHAR(20),
        end_date          VARCHAR(20),
        term_mode         ENUM('fixed','auto_renew','open') DEFAULT 'fixed',
        status            VARCHAR(20) DEFAULT '진행중',
        pay_form          ENUM('annual','monthly','hourly','daily','piece') DEFAULT 'monthly',
        work_hours        VARCHAR(50),
        pay_day           INT,
        pay_items         TEXT,
        insure_np         TINYINT DEFAULT 0,
        insure_hi         TINYINT DEFAULT 0,
        insure_ei         TINYINT DEFAULT 0,
        insure_ai         TINYINT DEFAULT 1,
        conv_alert_months INT DEFAULT 3,
        memo              TEXT,
        created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id)
      )
    `)
    // 용역·일용 단가표. contract_items(기성형 품목 단가표)와 같은 모양.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS work_contract_items (
        id               VARCHAR(36) PRIMARY KEY,
        work_contract_id VARCHAR(36) NOT NULL,
        item_id          VARCHAR(36),
        name             VARCHAR(255) NOT NULL,
        spec             VARCHAR(255),
        unit             VARCHAR(30),
        unit_price       BIGINT DEFAULT 0,
        sort_order       INT DEFAULT 0,
        created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (work_contract_id) REFERENCES work_contracts(id) ON DELETE CASCADE
      )
    `)
    // 계약서 첨부(다중). contract_docs와 동형 — 공용 FileAttach 재사용.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS work_contract_docs (
        id               VARCHAR(36) PRIMARY KEY,
        work_contract_id VARCHAR(36) NOT NULL,
        file_url         VARCHAR(500),
        file_name        VARCHAR(255),
        created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (work_contract_id) REFERENCES work_contracts(id) ON DELETE CASCADE
      )
    `)

    // ── 경영 도우미: 대화(세션)형 조회 ──
    // 사용자별 대화 목록 + 각 대화의 차트 타임라인. 설계 docs/02-design/features/mgmt-chat-sessions.design.md
    // 채팅 셸을 먼저, LLM은 나중 — 이 두 테이블이 곧 LLM 챗의 히스토리 백엔드가 된다.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS analytics_chats (
        id          VARCHAR(36) PRIMARY KEY,
        user_id     VARCHAR(36) NOT NULL,
        title       VARCHAR(120) NOT NULL DEFAULT '새 대화',
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_chats_user (user_id, updated_at)
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS analytics_chat_items (
        id           VARCHAR(36) PRIMARY KEY,
        chat_id      VARCHAR(36) NOT NULL,
        spec_json    JSON NOT NULL,
        title        VARCHAR(160),
        result_json  JSON,
        refreshed_at TIMESTAMP NULL,
        sort_order   INT DEFAULT 0,
        created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chat_id) REFERENCES analytics_chats(id) ON DELETE CASCADE
      )
    `)

    /* ── 재무관리: 차입금(대출) ──
     * 대출 원금은 부채다(손익 아님). 계좌 잔액은 늘지만 매출이 아니므로,
     * 거래에 붙는 계정과목(acct_code_*)이 손익 제외의 근거가 된다(lib/pnl.js).
     * 상환 스케줄은 계산으로 만들고(lib/loan.js) 실제 처리한 회차만 loan_repayments에 남긴다
     * — 정기지출이 미래 회차를 미리 만들지 않는 것과 같은 철학.
     * 설계: docs/02-design/features/finance-management.design.md */
    await c.execute(`
      CREATE TABLE IF NOT EXISTS loans (
        id            VARCHAR(36) PRIMARY KEY,
        name          VARCHAR(200) NOT NULL,
        lender        VARCHAR(200),
        vendor_id     VARCHAR(36),
        principal     BIGINT NOT NULL,
        annual_rate   DECIMAL(6,3) DEFAULT 0,
        method        ENUM('equal_payment','equal_principal','bullet') NOT NULL DEFAULT 'equal_payment',
        term_months   INT NOT NULL DEFAULT 12,
        start_date    VARCHAR(20) NOT NULL,
        pay_day       INT DEFAULT 1,
        end_date      VARCHAR(20),
        account_id    VARCHAR(36),
        acct_code_principal VARCHAR(10),
        acct_code_interest  VARCHAR(10),
        status        ENUM('active','closed') NOT NULL DEFAULT 'active',
        memo          TEXT,
        txn_id        VARCHAR(36),
        created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id)
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS loan_repayments (
        id          VARCHAR(36) PRIMARY KEY,
        loan_id     VARCHAR(36) NOT NULL,
        seq         INT NOT NULL,
        due_date    VARCHAR(20) NOT NULL,
        principal   BIGINT NOT NULL DEFAULT 0,
        interest    BIGINT NOT NULL DEFAULT 0,
        paid_date   VARCHAR(20),
        txn_principal_id VARCHAR(36),
        txn_interest_id  VARCHAR(36),
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_loan_seq (loan_id, seq),
        FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
      )
    `)
    /* 투자 — 받은 돈(자본)과 한 돈(투자자산). 둘 다 손익이 아니다.
     * 투자받은 돈은 자본금과 주식발행초과금으로 갈린다(액면가 × 주식수 = 자본금).
     * 지분율·평가손익은 범위 밖(설계 §6). */
    await c.execute(`
      CREATE TABLE IF NOT EXISTS investments (
        id             VARCHAR(36) PRIMARY KEY,
        direction      ENUM('in','out') NOT NULL,
        counterparty   VARCHAR(200) NOT NULL,
        vendor_id      VARCHAR(36),
        amount         BIGINT NOT NULL,
        invested_at    VARCHAR(20) NOT NULL,
        account_id     VARCHAR(36),
        capital_amount BIGINT DEFAULT 0,
        premium_amount BIGINT DEFAULT 0,
        acct_code      VARCHAR(10),
        txn_id         VARCHAR(36),
        memo           TEXT,
        created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id)
      )
    `)

    /* 예금·적금 — 자금 '운용'. 차입금(자금 조달)의 거울상이다.
     *
     * accounts 에 넣지 않은 이유: accounts 는 11개 화면에서 결제수단 드롭다운으로 쓰인다.
     * 적금을 섞으면 그 전부를 걸러야 하고, 한 곳만 빠뜨려도 '적금에서 외주비 지급' 같은 게
     * 조용히 만들어진다(마감 우회와 같은 실패 패턴). 자금일보에서 '묶인 자금'으로 합산한다.
     *
     * 회계상 정기예금·적금은 현금및현금성자산이 아니라 금융상품이다 —
     * 1201 단기금융상품(1년 이내) / 1501 장기금융상품(1년 초과). 그래서 acct_code 를 둔다.
     * 납입은 자산 증가라 손익이 아니다(lib/pnl.js 가 acct_type='자산'으로 걸러낸다). */
    await c.execute(`
      CREATE TABLE IF NOT EXISTS savings (
        id             VARCHAR(36) PRIMARY KEY,
        name           VARCHAR(200) NOT NULL,
        bank           VARCHAR(200),
        vendor_id      VARCHAR(36),
        kind           ENUM('installment','deposit') NOT NULL DEFAULT 'installment',
        principal      BIGINT DEFAULT 0,          -- 예금: 예치 원금 / 적금: 0(납입으로 쌓인다)
        monthly_amount BIGINT DEFAULT 0,          -- 적금 월 납입액
        annual_rate    DECIMAL(6,3) DEFAULT 0,
        term_months    INT NOT NULL DEFAULT 12,
        start_date     VARCHAR(20) NOT NULL,
        pay_day        INT DEFAULT 1,
        maturity_date  VARCHAR(20),
        account_id     VARCHAR(36),               -- 납입 출금 / 만기 입금 계좌(보통예금)
        acct_code      VARCHAR(10),               -- 1201 단기금융상품 / 1501 장기금융상품
        acct_code_interest VARCHAR(10),           -- 만기 이자수익 계정(INC-204 계열)
        status         ENUM('active','matured','closed') NOT NULL DEFAULT 'active',
        memo           TEXT,
        txn_id         VARCHAR(36),               -- 예금 가입 시 출금 거래
        matured_at     VARCHAR(20),
        txn_maturity_id  VARCHAR(36),             -- 만기 원금 입금 거래
        txn_interest_id  VARCHAR(36),             -- 만기 이자 입금 거래
        created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (vendor_id) REFERENCES vendors(id)
      )
    `)
    await c.execute(`
      CREATE TABLE IF NOT EXISTS savings_payments (
        id          VARCHAR(36) PRIMARY KEY,
        savings_id  VARCHAR(36) NOT NULL,
        seq         INT NOT NULL,
        due_date    VARCHAR(20) NOT NULL,
        amount      BIGINT NOT NULL DEFAULT 0,
        paid_date   VARCHAR(20),
        txn_id      VARCHAR(36),
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_savings_seq (savings_id, seq),
        FOREIGN KEY (savings_id) REFERENCES savings(id) ON DELETE CASCADE
      )
    `)

    // ── 마이그레이션: 기존 DB에 신규 컬럼 추가 (MySQL은 ADD COLUMN IF NOT EXISTS 미지원) ──
    const ensureColumn = async (table, col, ddl) => {
      const [[{ cnt }]] = await c.execute(
        `SELECT COUNT(*) AS cnt FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
        [schemaName, table, col]
      )
      if (cnt === 0) await c.execute(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`)
    }

    // (UNIQUE 인덱스는 아래쪽 ensureUniqueIndex 를 쓴다 — 계약번호·사번·청구번호와 같은 자리)
    // ── 1회성 데이터 마이그레이션 가드 ──
    // 데이터를 '변형'하는 마이그레이션은 부팅마다 재실행되면 안 된다(신규 입력 데이터를 오염시킴).
    // ensureColumn 같은 순수 스키마 추가는 멱등이라 가드 불필요 — 이건 데이터 UPDATE 전용.
    await c.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(80) PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`)
    const runOnce = async (key, fn) => {
      const [[r]] = await c.execute('SELECT id FROM schema_migrations WHERE id = ?', [key])
      if (r) return
      await fn()
      await c.execute('INSERT INTO schema_migrations (id) VALUES (?)', [key])
    }
    // 거래처 사용/미사용. 거래·청구서·계약이 붙은 거래처는 FK 때문에 삭제할 수 없고,
    // 삭제해서도 안 된다(과거 장부가 어긋난다). 미사용으로 두면 새 거래의 선택 목록에서만
    // 빠지고 기존 기록은 그대로 유지된다. 기존 행은 전부 사용중(1)으로 시작한다.
    await ensureColumn('vendors', 'active', "active TINYINT(1) NOT NULL DEFAULT 1")
    // 정기청구 → 청구서 역참조. 청구서를 지우면 그 회차의 last_generated 를 되돌려야
    // '발행 예정'에 다시 뜬다. 이 링크가 없으면 그 달 매출이 조용히 미청구로 사라진다.
    // (기존 청구서는 NULL — memo 로 추정 복원하면 엉뚱한 회차를 되살릴 수 있어 하지 않는다)
    await ensureColumn('invoices', 'recurring_id', "recurring_id VARCHAR(36)")
    // 결의서 결재선 스냅샷(기존 DB 대상). [{label, position, name}]
    await ensureColumn('expense_resolutions', 'approval', "approval TEXT")
    // 부가세: 자동집계(예상)와 별개로 실제 신고세액을 직접 입력. NULL이면 아직 신고 전(예상값 사용).
    await ensureColumn('vat_filings', 'filed_amount', "filed_amount BIGINT")
    // 세금 납부/환급 → 실제 자금 흐름(거래) 연결. 완료 처리 시 거래 생성, 취소 시 삭제.
    await ensureColumn('vat_filings', 'txn_id',       "txn_id VARCHAR(36)")
    await ensureColumn('vat_filings', 'account_id',   "account_id VARCHAR(36)")
    await ensureColumn('vat_filings', 'category',     "category VARCHAR(100)")
    await ensureColumn('vat_filings', 'account_code', "account_code VARCHAR(10)")
    await ensureColumn('other_taxes', 'txn_id',       "txn_id VARCHAR(36)")
    await ensureColumn('other_taxes', 'account_id',   "account_id VARCHAR(36)")
    await ensureColumn('other_taxes', 'account_code', "account_code VARCHAR(10)")
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
    // 선택 입력: 품목(ref_items) · 계정과목(account_subjects 코드)
    await ensureColumn('transactions', 'item_id',      "item_id VARCHAR(36)")
    await ensureColumn('transactions', 'account_code', "account_code VARCHAR(10)")

    /* 계좌의 계정과목 — 일계표(복식 전개)에 필요하다.
     *
     * 이 앱의 거래는 겉보기엔 단식(income/expense)이지만 실은 복식 한 쌍을 담고 있다.
     *   입금: 차변 = 계좌 계정과목(보통예금)   / 대변 = transactions.account_code
     *   지출: 차변 = transactions.account_code / 대변 = 계좌 계정과목
     * 계좌 쪽 계정과목이 없으면 차변·대변 한쪽이 비어 일계표 합계가 맞지 않는다.
     *
     * 기본값은 계좌 종류(type)를 따라간다 — 현금 1101 / 당좌예금 1102 / 그 외 보통예금 1103.
     * 카드는 실제로는 미지급금이지만 이 앱은 카드 지출도 즉시 출금으로 다루므로 보통예금으로 둔다
     * (카드 결제일·미결제 잔액 개념이 아직 없다. 생기면 2101 미지급금으로 바꿔야 한다). */
    await ensureColumn('accounts', 'acct_code', "acct_code VARCHAR(10)")
    const [acctFill] = await c.execute(`
      UPDATE accounts SET acct_code = CASE
        WHEN type = '현금'     THEN '1101'
        WHEN type = '당좌예금' THEN '1102'
        ELSE '1103' END
      WHERE acct_code IS NULL OR acct_code = ''`)
    if (acctFill.affectedRows > 0) console.log(`[db] 계좌 계정과목 ${acctFill.affectedRows}건 기본값 설정`)
    // ── 거래의 두 축 ──
    // contract_id      이 돈이 나가고/들어오는 '근거 계약'. 수금=매출계약, 지급=매입계약(외주 계약 등)
    // cost_contract_id 이 지출이 '어느 매출계약의 원가'인지. (외주비는 매입계약에 지급되면서 동시에 매출건의 원가다)
    // 두 축이 따로 있어야 외주비 한 건이 매입계약 지급·매출계약 원가에 각각 정확히 잡힌다(이중계상 아님).
    await ensureColumn('transactions', 'cost_contract_id', "cost_contract_id VARCHAR(36)")
    // 기존 데이터 이관: 매출계약(gubu B/미상)에 직접 달려 있던 지출은 사실 '원가 귀속'이었다 → 원가축으로 옮긴다.
    // 근거 계약(contract_id)은 비운다(그 외주에 대한 매입계약이 아직 없으므로 = 공통 지급).
    // ⚠ 1회만 실행. 매 부팅마다 돌면 gubu가 NULL인 매입처에 새로 올바로 연결한 지출까지 재이관돼 계약에서 분리된다.
    await runOnce('2026-06_expense_cost_axis', async () => {
      await c.execute(`
        UPDATE transactions t
          JOIN contracts ct ON t.contract_id = ct.id
          LEFT JOIN vendors v ON ct.vendor_id = v.id
        SET t.cost_contract_id = t.contract_id, t.contract_id = NULL
        WHERE t.kind = 'expense'
          AND t.cost_contract_id IS NULL
          AND (v.gubu IS NULL OR v.gubu = 'B')
      `)
    })
    // 보험 등 기준정보 확장: 납입주기·납입일·자동이체 계좌 + 증권(계약서) 첨부
    await ensureColumn('ref_items', 'period',     "period VARCHAR(20)")
    await ensureColumn('ref_items', 'pay_day',    "pay_day INT")
    await ensureColumn('ref_items', 'account_id', "account_id VARCHAR(36)")
    await ensureColumn('ref_items', 'file_url',   "file_url VARCHAR(500)")
    await ensureColumn('ref_items', 'file_name',  "file_name VARCHAR(300)")
    // 품목 1급화: 매입가(원가)·품목유형·과세유형·분류. amount(단가)는 그대로 '출고가(판매단가)'다 —
    // 계약 품목표·거래 금액 자동채움이 이미 amount를 읽으므로 sale_price를 따로 두지 않는다(같은 값 두 벌 = 드리프트).
    // 마진 = amount − purchase_price.
    await ensureColumn('ref_items', 'purchase_price', "purchase_price BIGINT DEFAULT 0")
    await ensureColumn('ref_items', 'item_kind',      "item_kind VARCHAR(20)")
    await ensureColumn('ref_items', 'tax_type',       "tax_type VARCHAR(10)")   // 과세·면세·영세 (비어 있으면 비목 기준 폴백)
    await ensureColumn('ref_items', 'item_group',     "item_group VARCHAR(50)")
    // 계약·청구 라인의 매입원가 스냅샷. 발행 시점 품목 매입가를 복사한다(기준정보가 바뀌어도 계약 조건은 유지 —
    // name·spec·unit·unit_price와 같은 스냅샷 원칙). 라인별 마진·계약별 원가 합계의 근거가 된다.
    await ensureColumn('contract_items', 'cost_price', "cost_price BIGINT DEFAULT 0")
    await ensureColumn('invoice_lines',  'cost_price', "cost_price BIGINT DEFAULT 0")
    // 총액형·정기형 계약의 품목 수량. 기성형은 계약 시점에 수량이 없고 청구할 때 넣으므로 0으로 둔다.
    await ensureColumn('contract_items', 'qty',        "qty DECIMAL(14,2) DEFAULT 0")
    /* ── 중량 ──
     * 거래명세서에 품목·규격·수량·단위와 함께 중량이 들어가는 업종이 있다(금속·자재).
     * 대부분은 표시·참고용이지만, **중량으로 값을 매기는 품목**도 있다(㎏당 단가).
     * 그래서 중량 자체와 '무엇에 단가를 곱하는가'(price_basis)를 나눠 둔다.
     *   qty(기본) — 금액 = 수량 × 단가      weight — 금액 = 중량 × 단가
     * 기본값을 qty 로 두어 기존 데이터·화면 동작이 그대로다.
     * 소수 셋째 자리까지 — ㎏ 단위에서 g 단위를 적는 경우가 있다. */
    await ensureColumn('ref_items',      'weight',      "weight DECIMAL(14,3) DEFAULT 0")
    await ensureColumn('ref_items',      'price_basis', "price_basis VARCHAR(10) DEFAULT 'qty'")
    await ensureColumn('contract_items', 'weight',      "weight DECIMAL(14,3) DEFAULT 0")
    await ensureColumn('contract_items', 'price_basis', "price_basis VARCHAR(10) DEFAULT 'qty'")
    await ensureColumn('invoice_lines',  'weight',      "weight DECIMAL(14,3) DEFAULT 0")
    await ensureColumn('invoice_lines',  'price_basis', "price_basis VARCHAR(10) DEFAULT 'qty'")
    /* 줄별 세액과 비고.
     *
     * 실제 거래명세서와 매입현황표는 **줄마다** 부가세를 적는다. 그리고 같은 청구서 안에서도
     * 과세와 면세가 섞인다 — 매입현황표에 근조화환 80,000원은 부가세 칸이 비어 있다(면세).
     * 청구서 단위 과세유형(tax_type)만으로는 그 표를 만들 수 없다.
     *
     * vat 는 NULL 이 '아직 안 정했다'는 뜻이다. 0 은 '면세라서 0'이라는 뜻이라 서로 다르다 —
     * NULL 이면 화면이 청구서 과세유형으로 자동 계산해 채운다.
     * note 는 단가 근거("14,500원/KG")나 수령자 이름이 들어가는 칸이다. */
    await ensureColumn('invoice_lines',  'vat',  "vat BIGINT NULL")
    await ensureColumn('invoice_lines',  'note', "note VARCHAR(200)")
    // ── 부가세 정합성 ──
    // 직접 입력 거래에도 공급가/세액을 남긴다. 여태 amount(합계) 하나뿐이라, 청구서를 거치지 않은
    // 거래의 매출·매입세액이 부가세 집계에서 통째로 빠졌다. NULL = 세액을 모르는 과거 거래(집계 제외).
    await ensureColumn('transactions', 'supply_amount', "supply_amount BIGINT")
    await ensureColumn('transactions', 'vat_amount',    "vat_amount BIGINT")
    // 과세유형: 과세 / 면세 / 영세. 영세(수출·해외용역)는 세액 0이지만 과세표준에는 들어가므로
    // 세액이 0이라는 것만으로 면세와 구분할 수 없다 → 값을 직접 남긴다.
    await ensureColumn('transactions', 'tax_type',      "tax_type VARCHAR(10)")
    // 매입세액 불공제(접대비·비영업용 승용차 등). 기본은 공제 가능.
    await ensureColumn('transactions', 'vat_deductible', "vat_deductible TINYINT DEFAULT 1")
    // 비목 단위 기본값 — 접대비 비목을 불공제로 두면 거래가 그 값을 물려받는다.
    await ensureColumn('categories',   'vat_deductible', "vat_deductible TINYINT DEFAULT 1")
    // 청구서도 면세/영세를 구분해 저장(과세표준 구분용). 기존 행은 NULL → 세액>0이면 과세로 본다.
    await ensureColumn('invoices',     'tax_type',      "tax_type VARCHAR(10)")
    // 홈택스 전자세금계산서 승인번호(24자리). 임포트에서 같은 계산서가 두 번 쌓이는 걸 막는 유일한 키다.
    // 수기로 등록한 청구서는 비어 있고, 나중에 엑셀을 올리면 그 청구서에 채워진다.
    await ensureColumn('invoices',     'nts_confirm_no', "nts_confirm_no VARCHAR(40)")
    /* 소급 등록 마법사가 한 번에 만든 묶음. 잘못된 범위로 수십 건을 만들었을 때
     * 하나씩 지우는 건 현실적이지 않아서, 이 값으로 묶어 통째로 되돌린다.
     * 거래(transactions)에도 같은 값을 넣어 청구서와 함께 정리한다. */
    await ensureColumn('invoices',     'backfill_batch', "backfill_batch VARCHAR(40)")
    await ensureColumn('transactions', 'backfill_batch', "backfill_batch VARCHAR(40)")
    // 재무 거래 역참조 — 이 지출/입금이 어느 대출·투자에서 나왔는지(정기의 recurring_id와 같은 용도).
    // FK는 두지 않는다: 대출 기록을 지워도 실제로 오간 돈의 기록은 남아야 한다.
    /* 정산(매칭)이 만든 거래인가. 취소할 때 이 값으로 갈린다:
     *   1 = 정산이 새로 만든 거래 → 취소하면 함께 지운다(그 매칭이 유일한 근거였다)
     *   0 = 이미 있던 거래를 연결한 것 → 취소해도 남긴다(실제로 오간 돈의 독립 기록)
     * 구분이 없던 동안은 둘 다 남겨서, 정산 취소 뒤 같은 돈이 '들어온 돈'과 '못 받은 돈'으로
     * 동시에 존재했다(계좌 잔액은 그대로, 미수금은 부활). 기존 행은 0(보수적으로 유지). */
    await ensureColumn('invoice_matches', 'txn_created', "txn_created TINYINT(1) NOT NULL DEFAULT 0")
    await ensureColumn('transactions', 'loan_id',       "loan_id VARCHAR(36)")
    // 예적금 납입·만기 거래를 되짚기 위한 역참조(대출의 loan_id와 같은 역할)
    await ensureColumn('transactions', 'savings_id',    "savings_id VARCHAR(36)")
    await ensureColumn('transactions', 'investment_id', "investment_id VARCHAR(36)")
    // 적격증빙 유형(ref_items type='evidence_type')의 매입세액 공제 가능 여부.
    // 세금계산서·카드전표·현금영수증(지출증빙)은 공제, 간이영수증·거래명세서는 불공제.
    await ensureColumn('ref_items',    'deductible',    "deductible TINYINT DEFAULT 1")

    // ── 업종중립 필드 (구 방산·조선 전용 컬럼의 후신) ──
    // 이 제품은 여러 업종의 영세기업이 함께 쓰는 SaaS다. 초기에 조선 협력업체 엑셀을 그대로 옮기며
    // 'vessel_no(호선번호)·usage_place(사용처)·buyer_code(HHIO/HHIM)'가 스키마에 박혔는데,
    // 그중 개념이 살아 있는 것만 업종중립 이름으로 옮긴다.
    //   project_no  프로젝트·공사번호 (조선=호선 / 천막=현장 / 선반=작업지시 / SW=프로젝트코드)
    //   site        현장·사용처
    //   order_no    상대방 발주(수주)번호 — 기존 컬럼 그대로 뜻만 범용화
    // buyer_code·buyer_type·pu_no는 vendor_id·cost_contract_id와 중복이라 코드에서 걷어낸다.
    await ensureColumn('contracts',    'project_no',    "project_no VARCHAR(50)")
    await ensureColumn('transactions', 'project_no',    "project_no VARCHAR(50)")
    await ensureColumn('transactions', 'site',          "site VARCHAR(200)")
    // 기존 값 이관. ⚠ 1회만 — 매번 돌면 사용자가 새로 비운 값이 옛 값으로 되살아난다.
    await runOnce('2026-07_industry_neutral_fields', async () => {
      await c.execute("UPDATE contracts SET project_no = vessel_code WHERE (project_no IS NULL OR project_no = '') AND vessel_code IS NOT NULL AND vessel_code <> ''")
      await c.execute("UPDATE transactions SET project_no = vessel_no WHERE (project_no IS NULL OR project_no = '') AND vessel_no IS NOT NULL AND vessel_no <> ''")
      await c.execute("UPDATE transactions SET site = usage_place WHERE (site IS NULL OR site = '') AND usage_place IS NOT NULL AND usage_place <> ''")
      // pu_no는 발주번호의 옛 이름 — order_no가 비었을 때만 옮긴다(둘 다 있으면 order_no가 정답)
      await c.execute("UPDATE contracts SET order_no = pu_no WHERE (order_no IS NULL OR order_no = '') AND pu_no IS NOT NULL AND pu_no <> ''")
    })
    // 구 컬럼(vessel_code·vessel_no·usage_place·pu_no·buyer_code·buyer_type)은 DROP하지 않는다.
    // 코드에서 참조만 끊고, 컬럼 삭제는 운영 DB 백업 후 별도 단계로. (되돌리기 쉬운 순서로 간다)

    // ── 거래처·인사 필드 보강 ──
    // 업태·종목은 세금계산서 발행 항목이라 거래처마다 들고 있어야 한다.
    // 지급계좌는 매입처에 이체할 때 매번 찾아 적는 수고를 없앤다.
    await ensureColumn('vendors',   'biz_type',    "biz_type VARCHAR(100)")
    await ensureColumn('vendors',   'biz_item',    "biz_item VARCHAR(100)")
    await ensureColumn('vendors',   'pay_account', "pay_account VARCHAR(200)")
    /* 이체 정보 — 은행·계좌번호·예금주를 **나눠서** 담는다.
     *
     * pay_account 한 칸에 "기업은행 123-456789-01-011 (주)○○" 처럼 몰아 적던 것을 가른다.
     * 매입처 결제내역서(월별 일괄이체 명단)가 은행·계좌·예금주를 각각 열로 요구하고,
     * 자유 텍스트에서 그걸 갈라내려면 표기가 제각각이라 반드시 틀린다.
     *
     * ⚠ 예금주는 상호와 다른 경우가 흔하다 — 실제 명단에 '김선국맑은유통', '박말숙태강금속'
     *   처럼 개인 명의 계좌가 섞여 있다. 상호로 대신할 수 없어 별도 칸이 필요하다.
     * pay_account 는 지우지 않는다(기존 입력 보존). 화면이 옛 값을 힌트로 보여준다. */
    /* 매입·매출 집계의 '한 달'과 '한 주'를 회사가 정한다.
     *
     * 받은 실물 표머리에 "주별 총 매입 현황 (매월 25일 마감)" 이라 적혀 있다 — 달력월이 아니다.
     * 25일 마감이면 7월분은 6/26~7/25 다. 이걸 달력월로 세면 표가 실물과 영영 안 맞는다.
     * 주도 월~금이 기본이지만 회사마다 다를 수 있어 시작 요일을 연다.
     * 0=일 … 1=월(기본). 마감일 0 은 '달력월 그대로'라는 뜻이다. */
    await ensureColumn('company_info', 'closing_day',    "closing_day TINYINT NOT NULL DEFAULT 0")
    await ensureColumn('company_info', 'week_start_day', "week_start_day TINYINT NOT NULL DEFAULT 1")
    await ensureColumn('vendors',   'bank_name',      "bank_name VARCHAR(60)")
    await ensureColumn('vendors',   'bank_account',   "bank_account VARCHAR(60)")
    await ensureColumn('vendors',   'account_holder', "account_holder VARCHAR(100)")

    /* 거래처 계좌 — **여러 개**다.
     *
     * 받은 실물 명세서(현진특수강) 하단에 계좌가 셋 적혀 있다:
     *   기업 177-111262-01-012 / 경남 638-07-0035120 / 국민 667901-04-223797
     * 거래처가 여러 계좌를 주고 그중 하나로 보내는 게 실제 관행이다.
     * vendors 의 한 벌짜리 칸(bank_*)으로는 "이번엔 어느 계좌로" 를 담을 수 없다.
     *
     * is_primary 는 결제내역 명단이 기본으로 집는 계좌다 — 매번 고르게 하면 31곳을
     * 매달 고르는 일이 된다. 고를 일이 있을 때만 고르게 한다. */
    await c.execute(`
      CREATE TABLE IF NOT EXISTS vendor_accounts (
        id          VARCHAR(36) PRIMARY KEY,
        vendor_id   VARCHAR(36) NOT NULL,
        bank_name   VARCHAR(60),
        account_no  VARCHAR(60),
        holder      VARCHAR(100),
        is_primary  TINYINT(1) NOT NULL DEFAULT 0,
        memo        VARCHAR(200),
        sort_order  INT DEFAULT 0,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_vendor_accounts (vendor_id, is_primary DESC, sort_order),
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
      )
    `)

    /* 거래처 담당자 — 이것도 여럿이다(영업·경리·배송이 다른 사람이다).
     * vendors 의 contact/phone 은 **회사 대표 연락처**로 남기고, 사람은 여기 담는다. */
    await c.execute(`
      CREATE TABLE IF NOT EXISTS vendor_contacts (
        id          VARCHAR(36) PRIMARY KEY,
        vendor_id   VARCHAR(36) NOT NULL,
        name        VARCHAR(100),
        role        VARCHAR(60),
        phone       VARCHAR(50),
        mobile      VARCHAR(50),
        email       VARCHAR(200),
        is_primary  TINYINT(1) NOT NULL DEFAULT 0,
        memo        VARCHAR(200),
        sort_order  INT DEFAULT 0,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_vendor_contacts (vendor_id, is_primary DESC, sort_order),
        FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
      )
    `)

    /* 한 벌짜리로 적어둔 값을 목록의 **첫 줄(주)** 로 옮긴다.
       한 번만 돈다 — 이미 목록이 있는 거래처는 건드리지 않는다. 옮긴 뒤에도 원본 칸은
       지우지 않는다(되돌릴 근거를 남긴다). */
    await c.execute(`
      INSERT INTO vendor_accounts (id, vendor_id, bank_name, account_no, holder, is_primary, sort_order)
      SELECT UUID(), v.id, v.bank_name, v.bank_account, v.account_holder, 1, 1
        FROM vendors v
       WHERE COALESCE(v.bank_account, '') <> ''
         AND NOT EXISTS (SELECT 1 FROM vendor_accounts a WHERE a.vendor_id = v.id)
    `)
    await c.execute(`
      INSERT INTO vendor_contacts (id, vendor_id, name, phone, email, is_primary, sort_order)
      SELECT UUID(), v.id, v.contact, v.phone, v.email, 1, 1
        FROM vendors v
       WHERE COALESCE(v.contact, '') <> ''
         AND NOT EXISTS (SELECT 1 FROM vendor_contacts x WHERE x.vendor_id = v.id)
    `)
    /* 거래에 **상대 계좌**를 남긴다 — 어느 계좌에서 어느 계좌로 갔는지.
     *
     * account_id 는 우리 쪽 계좌다. 상대 쪽은 지금까지 아무 데도 안 남아서,
     * 거래처가 계좌를 셋 가진 순간 "이번엔 어디로 보냈지"를 영영 알 수 없게 된다.
     * (통장을 다시 뒤지는 것 말고는 방법이 없다.)
     *
     * ⚠ 값은 **스냅샷**이다. vendor_accounts 를 참조만 걸어두면 나중에 거래처가
     *   계좌를 바꾸거나 지웠을 때 과거 거래의 계좌까지 같이 바뀐다 —
     *   청구서 품목이 품목 마스터를 베껴 두는 것과 같은 이유다.
     * counterparty_account_id 는 '그때 어느 줄을 골랐나'를 남길 뿐이라
     *   그 줄이 지워지면 NULL 이 되고, 스냅샷 세 칸은 그대로 남는다. */
    await ensureColumn('transactions', 'counterparty_account_id', "counterparty_account_id VARCHAR(36)")
    await ensureColumn('transactions', 'counterparty_bank',       "counterparty_bank VARCHAR(60)")
    await ensureColumn('transactions', 'counterparty_account',    "counterparty_account VARCHAR(60)")
    await ensureColumn('transactions', 'counterparty_holder',     "counterparty_holder VARCHAR(100)")

    // 급여이체 계좌. 주민등록번호는 저장하지 않는다 —
    // 원천징수·연말정산 신고서 자동생성이 범위 밖이라 지금 얻는 게 없고, 저장하는 순간
    // 암호화·파기 의무가 붙는다. 신고서 자동화를 범위에 넣을 때 다시 판단한다.
    /* 계좌 소유 — 법인 것인가 대표 개인 것인가.
     *
     * 중소기업은 대표 개인 계좌·카드로 회사 돈을 쓰는 경우가 흔하다. 자금 현황에서는
     * 그것까지 봐야 "이 달에 돈이 도나"를 알 수 있지만, **회계 집계에 섞이면 안 된다.**
     * 다행히 회계는 계좌가 아니라 '등록된 거래'로 잡히므로, 개인 계좌를 등록해도
     * 개인 지출을 거래로 안 넣으면 손익·부가세에는 안 들어간다. 갈라야 하는 곳은
     * 잔액·총자산 합계뿐이라 여기 한 칸이면 된다.
     *
     * 개인 계좌로 회사 비용을 낸 경우는 회계상 **대표 차입(가수금)** 이고,
     * 그건 재무관리 > 차입금으로 이미 처리된다 — 이 칸과 별개다.
     * 기존 계좌는 전부 법인(corp)으로 시작한다. */
    await ensureColumn('accounts', 'owner', "owner VARCHAR(10) NOT NULL DEFAULT 'corp'")

    /* 카드 결제일과 결제 계좌 — 카드는 쓰는 날과 **돈이 빠지는 날**이 다르다.
     *
     * 받은 자금관리 엑셀에서 카드는 지출의 큰 축이다(BC 12일·국민 25일·롯데 5일·하나 27일).
     * 지금은 카드를 '결제수단'으로만 알고 있어서, 이번 달 카드값이 며칠에 어느 통장에서
     * 빠지는지 자금 예측이 알 수 없었다.
     * pay_day 0 = 미설정(예측하지 않는다 — 모르는 걸 지어내면 그 날 잔고가 틀린다). */
    await ensureColumn('accounts', 'card_pay_day', 'card_pay_day TINYINT NOT NULL DEFAULT 0')
    await ensureColumn('accounts', 'card_pay_account_id', 'card_pay_account_id VARCHAR(36)')

    await ensureColumn('employees', 'salary_account', "salary_account VARCHAR(200)")

    /* 대출 예정 회차 채우기 — loan_repayments 에 실적만 있던 옛 데이터를 위해.
     *
     * 이제 한 행 = 한 회차이고 paid_date 가 비면 예정이다(routes/finance.js 머리말).
     * 예정 행이 하나도 없는 활성 대출은 자금 예측에서 **나갈 돈이 통째로 빠지므로**
     * (예측이 낙관 쪽으로 틀린다) 여기서 채운다.
     *
     * runOnce 를 쓰지 않는다 — 예정 행이 없는 대출에만 넣는 **덧붙이기**라 매번 돌아도
     * 같은 결과이고, 한 번 실패해도 다음 배포에서 스스로 복구된다. 돈이 걸린 데이터는
     * '한 번만 시도하고 마는' 것보다 '늘 맞춰두는' 편이 안전하다. */
    {
      const { repaymentSchedule } = require('./lib/loan')
      const [loans] = await c.execute("SELECT * FROM loans WHERE status = 'active'")
      let filled = 0
      for (const loan of loans) {
        const [rows] = await c.execute('SELECT seq, paid_date FROM loan_repayments WHERE loan_id = ?', [loan.id])
        if (rows.some(r => !r.paid_date)) continue          // 이미 예정이 깔려 있다
        const done = new Set(rows.map(r => Number(r.seq)))
        for (const cy of repaymentSchedule(loan)) {
          if (done.has(cy.seq)) continue                     // 이미 낸 회차는 건드리지 않는다
          await c.execute(
            'INSERT IGNORE INTO loan_repayments (id, loan_id, seq, due_date, principal, interest) VALUES (?,?,?,?,?,?)',
            [randomUUID(), loan.id, cy.seq, cy.due_date, cy.principal, cy.interest])
          filled++
        }
      }
      if (filled) console.log(`   · 대출 예정 회차 ${filled}건 채움`)
    }

    /* 적금 예정 회차 채우기 — 대출과 같은 이유·같은 방식(덧붙이기, 매번 돌아도 같은 결과) */
    {
      const { paymentSchedule } = require('./lib/savings')
      const [list] = await c.execute("SELECT * FROM savings WHERE status = 'active' AND kind = 'installment'")
      let filled = 0
      for (const sv of list) {
        const [rows] = await c.execute('SELECT seq, paid_date FROM savings_payments WHERE savings_id = ?', [sv.id])
        if (rows.some(r => !r.paid_date)) continue
        const done = new Set(rows.map(r => Number(r.seq)))
        for (const cy of paymentSchedule(sv)) {
          if (done.has(cy.seq)) continue
          await c.execute(
            'INSERT IGNORE INTO savings_payments (id, savings_id, seq, due_date, amount) VALUES (?,?,?,?,?)',
            [randomUUID(), sv.id, cy.seq, cy.due_date, cy.amount])
          filled++
        }
      }
      if (filled) console.log(`   · 적금 예정 회차 ${filled}건 채움`)
    }
    // 정기지출도 부가세를 직접 저장한다(과세=exclusive / 면세=none / 영세=zero).
    // 비목을 강제하지 않으려는 것 — 비목을 고르면 그 값으로 채워지되, 폼에서 바꿀 수 있다.
    // NULL이면 옛 방식(비목 categories.vat)을 따른다(하위호환).
    await ensureColumn('recurring_expenses', 'vat_mode', "vat_mode VARCHAR(12)")

    // 월 마감(기간 잠금). 부가세 신고·월 마감을 끝낸 기간의 거래가 뒤에서 바뀌면
    // 이미 제출한 신고자료와 장부가 어긋난다 → 잠근 달의 거래는 등록·수정·삭제를 막는다.
    await c.execute(`
      CREATE TABLE IF NOT EXISTS closed_periods (
        id         VARCHAR(36) PRIMARY KEY,
        period     VARCHAR(7) NOT NULL UNIQUE,   -- 'YYYY-MM'
        memo       VARCHAR(500),
        closed_by  VARCHAR(100),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    // 직원 고정 수당(급여대장 생성 시 명세서에 자동 채움) + 부양가족(참고용)
    await ensureColumn('employees', 'emp_no',             "emp_no VARCHAR(20)")
    await ensureColumn('employees', 'position_allowance', "position_allowance BIGINT DEFAULT 0")
    await ensureColumn('employees', 'meal_allowance',     "meal_allowance BIGINT DEFAULT 0")
    await ensureColumn('employees', 'vehicle_allowance',  "vehicle_allowance BIGINT DEFAULT 0")
    await ensureColumn('employees', 'dependents',         "dependents INT DEFAULT 1")
    await ensureColumn('employees', 'child_dependents',   "child_dependents INT DEFAULT 0")
    await ensureColumn('employees', 'birth_date',         "birth_date VARCHAR(20)")
    // 재직상태(재직·수습·휴직·퇴사). active(bool)만으론 수습·휴직을 표현 못 하고 퇴사↔재활성 버그가 났다 → 상태를 직접 저장.
    await ensureColumn('employees', 'status',             "status VARCHAR(20) DEFAULT '재직'")
    // 사람 구분: 직원(근로계약) / 용역·일용 인력. 계약 kind로도 알 수 있지만
    // '아직 계약이 없는 사람'이 있으므로 사람 자체에 둔다.
    await ensureColumn('employees', 'person_kind',        "person_kind VARCHAR(20) DEFAULT 'employee'")
    await ensureColumn('employees', 'leave_date',         "leave_date VARCHAR(20)")
    // 급여대장 행의 근거 계약 + 월 내 회차(근로=0, 용역·일용=1..N) + 용역 단가×수량 라인
    await ensureColumn('payroll',   'work_contract_id',   "work_contract_id VARCHAR(36)")
    await ensureColumn('payroll',   'seq',                "seq INT DEFAULT 0")
    await ensureColumn('payroll',   'qty_lines',          "qty_lines TEXT")
    // 기존 행 백필: 컬럼 DEFAULT가 '재직'이라 신규 컬럼은 전부 '재직'으로 채워진다 → 퇴사(active=0)만 바로잡으면 된다.
    // active=0 ⟺ 퇴사 불변식(active는 status에서 파생)이라 재실행해도 멱등 — 수습/휴직(active=1)은 절대 안 건드린다.
    await runOnce('2026-07_employee_status_backfill', async () => {
      await c.execute("UPDATE employees SET status = '퇴사' WHERE active = 0")
    })
    // 계약서 첨부 파일(레거시 단일 파일)
    await ensureColumn('contracts', 'file_url',  "file_url VARCHAR(500)")
    await ensureColumn('contracts', 'file_name', "file_name VARCHAR(300)")
    // 계약번호(계약서 번호) — 회사에 따라 계약을 번호로 식별
    await ensureColumn('contracts', 'contract_no', "contract_no VARCHAR(50)")
    // 지급결의서: 청구서(지급 예정) 단계에서도 만들 수 있게 invoice_id 연결.
    // 지급 전에 결재받는 게 실무 순서 → 거래(txn_id) 없이 청구서만으로도 결의서 생성.
    await ensureColumn('expense_resolutions', 'invoice_id', "invoice_id VARCHAR(36)")
    // 정산내역서 헤더: 출장지역·출장기간·구분(定算內譯書 상단 칸). 기존 테이블에 뒤늦게 추가.
    await ensureColumn('settlements', 'trip_area',   "trip_area VARCHAR(200)")
    await ensureColumn('settlements', 'trip_period', "trip_period VARCHAR(200)")
    await ensureColumn('settlements', 'purpose',     "purpose VARCHAR(200)")
    // 구매품의서 품목: 실적가(단가·금액) — 공급업체 견적가와 별도로 과거 실적 단가를 나란히 보여준다.
    await ensureColumn('purchase_req_items', 'actual_price',  "actual_price BIGINT DEFAULT 0")
    await ensureColumn('purchase_req_items', 'actual_amount', "actual_amount BIGINT DEFAULT 0")
    // 구매품의서 → 미지급금(매입 청구서) 연결. 한 번만 등록되게 생성된 invoices.id 를 물고 있는다.
    await ensureColumn('purchase_reqs', 'invoice_id', "invoice_id VARCHAR(36)")
    // ── 계약 모델: 독립된 두 축 ──
    // billing_mode : onetime(총액을 마일스톤으로 나눠 청구) / recurring(주기마다 정액 청구)
    // term_mode    : fixed(종료일에 만료 — 재계약해야 이어짐) / auto_renew(해지 통보 없으면 자동 연장) / open(무기한 — 해지 시까지)
    // 금액 : onetime → amount(총액)를 입력 / recurring → unit_amount(주기당)를 입력하고 amount는 '현재 텀 총액'으로 서버가 산출
    // current_term_start : 갱신될 때마다 앞으로 밀리는 '이번 텀 시작일'. 진행률·수금을 이번 텀 기준으로 보기 위함
    await ensureColumn('contracts', 'billing_mode',       "billing_mode VARCHAR(20) DEFAULT 'onetime'")
    await ensureColumn('contracts', 'term_mode',          "term_mode VARCHAR(20) DEFAULT 'fixed'")
    await ensureColumn('contracts', 'unit_amount',        "unit_amount BIGINT")
    await ensureColumn('contracts', 'billing_period',     "billing_period VARCHAR(20)")
    await ensureColumn('contracts', 'billing_day',        "billing_day INT")
    await ensureColumn('contracts', 'term_months',        "term_months INT")
    await ensureColumn('contracts', 'notice_days',        "notice_days INT DEFAULT 60")
    await ensureColumn('contracts', 'current_term_start', "current_term_start VARCHAR(20)")
    // 정기형 계약의 초기 일시금(구축비·설치비). 첫 기간에만 붙고 갱신 후에는 붙지 않는다.
    await ensureColumn('contracts', 'initial_amount',     "initial_amount BIGINT")
    // 부가세 과세 여부. taxable(과세, 공급가×10%) / exempt(면세, 부가세 0). 청구서 발행·정기청구에 반영.
    await ensureColumn('contracts', 'vat_mode',           "vat_mode VARCHAR(10) DEFAULT 'taxable'")
    // 계약 자유 메모(단일 필드). 계약 상세 '메모/히스토리' 탭에서 편집.
    await ensureColumn('contracts', 'memo',               "memo TEXT")
    // 이번 텀 시작일이 빈 계약은 계약 시작일로 채움(= 첫 텀)
    await c.execute("UPDATE contracts SET current_term_start = start_date WHERE (current_term_start IS NULL OR current_term_start='') AND start_date IS NOT NULL AND start_date <> ''")
    // 앞선 시안(contract_type/renewal_type/renew_months) 정리 — 값은 전부 기본값이라 손실 없음
    const dropColumn = async (table, col) => {
      const [[{ cnt }]] = await c.execute(
        `SELECT COUNT(*) AS cnt FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
        [schemaName, table, col]
      )
      if (cnt > 0) await c.execute(`ALTER TABLE \`${table}\` DROP COLUMN \`${col}\``)
    }
    await dropColumn('contracts', 'contract_type')
    await dropColumn('contracts', 'renewal_type')
    await dropColumn('contracts', 'renew_months')
    // 정기형 계약의 갱신은 '주기당 금액'이 바뀌는 게 본질 → 이력에도 남긴다
    await ensureColumn('contract_renewals', 'prev_unit_amount', "prev_unit_amount BIGINT")
    await ensureColumn('contract_renewals', 'new_unit_amount',  "new_unit_amount BIGINT")
    // 계약번호 중복 방지(UNIQUE). MySQL은 NULL을 다중 허용 → 번호 미사용 계약은 공존.
    // 기존 중복 데이터가 있으면 인덱스 생성이 실패하므로 무시(수동 정리 후 재기동 시 적용).
    const ensureUniqueIndex = async (table, index, col) => {
      const [[{ cnt }]] = await c.execute(
        `SELECT COUNT(*) AS cnt FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = ? AND index_name = ?`,
        [schemaName, table, index]
      )
      if (cnt === 0) {
        try { await c.execute(`ALTER TABLE \`${table}\` ADD UNIQUE INDEX \`${index}\` (${col})`) }
        catch (e) { console.warn(`[migration] ${index} 생성 실패(중복 데이터 가능): ${e.message}`) }
      }
    }
    await ensureUniqueIndex('contracts', 'uq_contracts_contract_no', 'contract_no')
    // 홈택스 승인번호는 국세청이 부여한 유일값 → 같은 번호의 청구서가 둘 존재하는 것은 항상 잘못이다.
    // 임포트가 앱에서도 "조회 후 없으면 삽입"으로 막지만, 그 사이의 틈(동시 요청)은 인덱스만 닫는다.
    // NULL 다중 허용이라 승인번호 없는 수기 청구서는 공존한다.
    await ensureUniqueIndex('invoices', 'uq_invoices_nts_confirm_no', 'nts_confirm_no')

    // 사번·청구번호 유니크화: 먼저 기존 중복을 재번호(뒤 생성분을 그룹 최대+1)한 뒤 유니크 인덱스를 건다.
    // (동시/다경로 생성 시 MAX+1 채번이 겹쳐 중복이 조용히 생기는 것을 DB가 차단. 중복이 남아 있으면
    //  인덱스 생성이 실패하므로 dedup을 선행 — runOnce 가드로 1회만.)
    await runOnce('dedup_emp_invoice_no_v1', async () => {
      // emp_no 중복/공백 재번호
      const [emps] = await c.execute('SELECT id, emp_no FROM employees ORDER BY created_at, id')
      let maxN = 0
      for (const e of emps) { const n = parseInt(String(e.emp_no || '').replace(/[^0-9]/g, ''), 10) || 0; if (n > maxN) maxN = n }
      const seen = new Set()
      for (const e of emps) {
        const no = e.emp_no || ''
        if (!no || seen.has(no)) {
          maxN++; const newNo = 'EMP-' + String(maxN).padStart(3, '0')
          await c.execute('UPDATE employees SET emp_no = ? WHERE id = ?', [newNo, e.id]); seen.add(newNo)
        } else seen.add(no)
      }
      // invoice_no 중복 재번호(prefix-year 그룹 유지, 그 그룹 최대+1)
      const [invs] = await c.execute("SELECT id, invoice_no, kind FROM invoices WHERE invoice_no IS NOT NULL AND invoice_no <> '' ORDER BY created_at, id")
      const maxSeq = {}
      for (const iv of invs) { const m = String(iv.invoice_no).match(/^(.+-\d{4})-(\d+)$/); if (m) { const k = m[1], s = parseInt(m[2], 10) || 0; if (!(k in maxSeq) || s > maxSeq[k]) maxSeq[k] = s } }
      const seenInv = new Set()
      for (const iv of invs) {
        const no = iv.invoice_no
        if (seenInv.has(no)) {
          const m = String(no).match(/^(.+-\d{4})-(\d+)$/)
          const key = m ? m[1] : `${iv.kind === 'received' ? '매입' : '청구'}-0000`
          maxSeq[key] = (maxSeq[key] || 0) + 1
          const newNo = `${key}-${String(maxSeq[key]).padStart(4, '0')}`
          await c.execute('UPDATE invoices SET invoice_no = ? WHERE id = ?', [newNo, iv.id]); seenInv.add(newNo)
        } else seenInv.add(no)
      }
    })
    await ensureUniqueIndex('employees', 'uq_emp_no', 'emp_no')
    await ensureUniqueIndex('invoices', 'uq_invoice_no', 'invoice_no')

    // payroll 유니크 교체: (employee_id, month) → (employee_id, month, seq)
    // 용역·일용은 한 달에 여러 회차를 지급하므로 옛 유니크로는 2회차부터 막힌다.
    // 근로계약은 항상 seq=0이라 중복 방지 효과는 이전과 완전히 동일하다.
    // ⚠ 순서 주의: employee_id FK가 인덱스를 요구하므로 새 인덱스를 먼저 만들고 옛것을 지운다
    //    (먼저 지우면 errno 150으로 실패).
    const indexExists = async (table, index) => {
      const [[{ cnt }]] = await c.execute(
        `SELECT COUNT(*) AS cnt FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = ? AND index_name = ?`,
        [schemaName, table, index]
      )
      return cnt > 0
    }
    if (!(await indexExists('payroll', 'uq_emp_month_seq'))) {
      try { await c.execute('ALTER TABLE `payroll` ADD UNIQUE INDEX `uq_emp_month_seq` (employee_id, month, seq)') }
      catch (e) { console.warn(`[migration] uq_emp_month_seq 생성 실패: ${e.message}`) }
    }
    if (await indexExists('payroll', 'uq_emp_month_seq') && await indexExists('payroll', 'uq_emp_month')) {
      try { await c.execute('ALTER TABLE `payroll` DROP INDEX `uq_emp_month`') }
      catch (e) { console.warn(`[migration] uq_emp_month 제거 실패: ${e.message}`) }
    }

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

    // 자동 생성 거래(청구서 정산·정기지출·급여)에 계약/공통 스코프가 비어 편집 시 공란이 되던 문제 보정.
    // ⚠ 1회만 — 매 부팅마다 돌면 사용자가 일부러 비운 doc_no를 '공통'으로 되살린다.
    await runOnce('2026-07_backfill_doc_no_common', async () => {
      await c.execute("UPDATE transactions SET doc_no='공통' WHERE (doc_no IS NULL OR doc_no='') AND (contract_id IS NULL OR contract_id='') AND (invoice_id IS NOT NULL OR recurring_id IS NOT NULL OR payroll_id IS NOT NULL)")
    })

    // 결재선 기본 프리셋 1개 (비어 있을 때만) — 담당 → 결재 → 대표
    const [[{ apcnt }]] = await c.execute('SELECT COUNT(*) AS apcnt FROM approval_presets')
    if (apcnt === 0) {
      const defaultSteps = JSON.stringify([
        { label: '담당', position: '' },
        { label: '결재', position: '' },
        { label: '대표이사', position: '' },
      ])
      await c.execute(
        'INSERT INTO approval_presets (id, name, steps, is_default, sort_order) VALUES (UUID(), ?, ?, 1, 0)',
        ['기본 결재선', defaultSteps]
      )
    }

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

    // 표준 계정과목 시딩 (비어 있을 때만) — server/data/account-subjects.json (계정과목분류표.xlsx 기준)
    const [[{ acnt }]] = await c.execute('SELECT COUNT(*) AS acnt FROM account_subjects')
    if (acnt === 0) {
      const chart = require('./data/account-subjects.json')
      for (const a of chart) {
        await c.execute(
          'INSERT INTO account_subjects (acct_type, category, name, code, postable, note, sort_order) VALUES (?,?,?,?,?,?,?)',
          [a.type, a.category, a.name, a.code != null ? String(a.code) : null, a.postable ? 1 : 0, a.note || '', a.sort || 0]
        )
      }
    }

    // 적요(자주 쓰는 거래 내용) 예시 시딩 (jeokyo 항목이 하나도 없을 때만)
    const [[{ jcnt }]] = await c.execute("SELECT COUNT(*) AS jcnt FROM ref_items WHERE type='jeokyo'")
    if (jcnt === 0) {
      const jeokyo = [
        ['사무실 임차료', '매월 임대료'],
        ['인터넷·전화요금', '통신비'],
        ['서버·호스팅 이용료', ''],
        ['소프트웨어 구독료', 'SaaS·라이선스'],
        ['도메인 갱신비', ''],
        ['급여 지급', ''],
        ['상여금 지급', ''],
        ['4대보험 납부', ''],
        ['원천세 납부', ''],
        ['부가가치세 납부', ''],
        ['세무 기장 수수료', ''],
        ['법인카드 대금 결제', ''],
        ['사무용품 구입', ''],
        ['접대비(거래처 식대)', ''],
        ['교통비·주차비', ''],
        ['외주 용역비 지급', ''],
        ['광고·마케팅비', ''],
        ['용역대금 입금', ''],
        ['정기 유지보수비 입금', ''],
        ['프로젝트 잔금 입금', ''],
      ]
      let jo = 0
      for (const [name, memo] of jeokyo) {
        await c.execute(
          'INSERT INTO ref_items (id, type, name, memo, sort_order) VALUES (?,?,?,?,?)',
          [randomUUID(), 'jeokyo', name, memo, ++jo]
        )
      }
    }

    // 적격증빙 유형 시딩 (하나도 없을 때만). 부가세 매입세액 공제는 '적격증빙'이 있어야 받는다.
    // deductible=0 은 증빙으로 인정은 되지만 매입세액 공제는 안 되는 것들.
    const [[{ evcnt }]] = await c.execute("SELECT COUNT(*) AS evcnt FROM ref_items WHERE type='evidence_type'")
    if (evcnt === 0) {
      const evidences = [
        // [이름, 공제가능, 설명]
        ['세금계산서',        1, '가장 일반적인 적격증빙 (전자세금계산서 포함)'],
        ['신용카드매출전표',  1, '사업용 카드 결제분 — 공급자가 과세사업자일 때'],
        ['현금영수증',        1, '지출증빙용으로 발급받은 것만 공제 가능'],
        ['계산서',            0, '면세 거래용 — 애초에 매입세액이 없다'],
        ['간이영수증',        0, '적격증빙이 아니라 매입세액 공제 불가'],
        ['거래명세서',        0, '증빙 참고용 — 단독으로는 공제 불가'],
      ]
      let eo = 0
      for (const [name, deductible, memo] of evidences) {
        await c.execute(
          'INSERT INTO ref_items (id, type, name, deductible, memo, sort_order) VALUES (?,?,?,?,?,?)',
          [randomUUID(), 'evidence_type', name, deductible, memo, ++eo]
        )
      }
    }

    // 품목 예시 시딩 (item 항목이 하나도 없을 때만) — 단가 있으면 거래 입력 시 금액 자동 채움
    // SW-: 소프트웨어 개발사 / MFG-: 방산 정밀가공(동진테크) — 두 업종 예시를 함께 제공
    const [[{ icnt2 }]] = await c.execute("SELECT COUNT(*) AS icnt2 FROM ref_items WHERE type='item'")
    if (icnt2 === 0) {
      const goods = [
        // [품목코드, 품명, 규격, 단위, 출고가, 품목유형]
        ['SW-01',  '웹사이트 구축',       '기본형',   '식',   0,      '서비스'],
        ['SW-02',  '웹사이트 유지보수',   '월정액',   '월',   500000, '서비스'],
        ['SW-03',  '서버·호스팅',         '',         '월',   100000, '서비스'],
        ['SW-04',  '도메인 등록·갱신',    '',         '년',   22000,  '상품'],
        ['SW-05',  'SSL 인증서',          '',         '년',   110000, '상품'],
        ['SW-06',  '소프트웨어 라이선스', '1 user',   '개',   0,      '상품'],
        ['SW-07',  '기술 컨설팅',         '',         '시간', 100000, '서비스'],
        ['SW-08',  '퍼블리싱·디자인',     '',         '식',   0,      '서비스'],
        ['MFG-01', '실린더 블록',         'SCM440',   'EA',   0,      '제품'],
        ['MFG-02', '기어 하우징',         'AL6061',   'EA',   0,      '제품'],
        ['MFG-03', '밸브 바디',           'STS304',   'EA',   0,      '제품'],
        ['MFG-04', '구동 샤프트',         'SCM440',   'EA',   0,      '제품'],
        ['MFG-05', '커넥터 하우징',       'AL6061',   'EA',   0,      '제품'],
        ['MFG-06', '마운트 브라켓',       'AL7075',   'EA',   0,      '제품'],
        ['MFG-07', '플랜지',              'STS316',   'EA',   0,      '제품'],
        ['MFG-08', '피스톤 로드',         'SCM440',   'EA',   0,      '제품'],
      ]
      let go2 = 0
      for (const [code, name, spec, unit, amount, kind] of goods) {
        await c.execute(
          'INSERT INTO ref_items (id, type, name, code, spec, unit, amount, item_kind, sort_order) VALUES (?,?,?,?,?,?,?,?,?)',
          [randomUUID(), 'item', name, code, spec, unit, amount, kind, ++go2]
        )
      }
    }

    // 고정자산 예시 시딩 (fixed_asset 없을 때만) — FA- 자산번호
    const [[{ facnt }]] = await c.execute("SELECT COUNT(*) AS facnt FROM ref_items WHERE type='fixed_asset'")
    if (facnt === 0) {
      const fa = [
        // [자산번호, 자산명, 취득가액, 취득일]
        ['FA-001', '개발용 노트북',        3000000,   '2025-03-15'],
        ['FA-002', '서버 장비',            8000000,   '2024-11-20'],
        ['FA-003', '사무용 가구 세트',     1200000,   '2024-06-01'],
        ['FA-004', '업무용 차량',          28000000,  '2025-01-05'],
        ['FA-005', 'CNC 머시닝센터',       120000000, '2024-09-10'],
        ['FA-006', '3차원 측정기(CMM)',    45000000,  '2024-10-15'],
      ]
      let fs = 0
      for (const [code, name, amount, date] of fa) {
        await c.execute(
          'INSERT INTO ref_items (id, type, name, code, amount, start_date, sort_order) VALUES (?,?,?,?,?,?,?)',
          [randomUUID(), 'fixed_asset', name, code, amount, date, ++fs]
        )
      }
    }

    // 무형자산 예시 시딩 (intangible_asset 없을 때만) — IA- 자산번호
    const [[{ iacnt }]] = await c.execute("SELECT COUNT(*) AS iacnt FROM ref_items WHERE type='intangible_asset'")
    if (iacnt === 0) {
      const ia = [
        ['IA-001', '회계관리 소프트웨어',    5000000,  '2025-02-01'],
        ['IA-002', 'ERP 라이선스',           12000000, '2024-12-01'],
        ['IA-003', '특허권(정밀가공 공법)',  20000000, '2023-05-20'],
        ['IA-004', '상표권',                 3000000,  '2024-03-01'],
        ['IA-005', '홈페이지 개발비(자본화)', 8000000, '2025-04-01'],
      ]
      let is2 = 0
      for (const [code, name, amount, date] of ia) {
        await c.execute(
          'INSERT INTO ref_items (id, type, name, code, amount, start_date, sort_order) VALUES (?,?,?,?,?,?,?)',
          [randomUUID(), 'intangible_asset', name, code, amount, date, ++is2]
        )
      }
    }

    // 보험 예시 시딩 (insurance 없을 때만) — 사업장 화재·배상·상해 등 (증권번호 포함)
    const [[{ inscnt }]] = await c.execute("SELECT COUNT(*) AS inscnt FROM ref_items WHERE type='insurance'")
    if (inscnt === 0) {
      const insList = [
        // [보험명, 보험사, 증권번호, 보험료, 시작일, 종료일]
        ['사업장 화재보험',           '삼성화재',   'FIRE-2025-001',  1200000, '2025-01-01', '2025-12-31'],
        ['영업배상책임보험',          'DB손해보험', 'LIAB-2025-014',  800000,  '2025-03-01', '2026-02-28'],
        ['단체상해보험(임직원)',      '현대해상',   'GRP-2025-220',   3600000, '2025-01-01', '2025-12-31'],
        ['업무용 자동차보험',         'KB손해보험', 'CAR-2025-777',   1500000, '2025-01-05', '2026-01-04'],
        ['근로자재해보장책임보험',    '메리츠화재', 'WC-2025-033',    2400000, '2025-01-01', '2025-12-31'],
        ['기계보험(생산설비)',        '삼성화재',   'MACH-2025-009',  1800000, '2024-09-10', '2025-09-09'],
        ['제조물배상책임보험(PL)',    'DB손해보험', 'PL-2025-102',    2000000, '2025-01-01', '2025-12-31'],
        ['개인정보보호 배상책임보험', '현대해상',   'CYBER-2025-051', 1000000, '2025-02-01', '2026-01-31'],
      ]
      let insn = 0
      for (const [name, party, code, amount, sd, ed] of insList) {
        const payDay = parseInt(sd.slice(8, 10), 10) || 1   // 시작일의 일자 → 납입일
        await c.execute(
          'INSERT INTO ref_items (id, type, name, party, code, amount, start_date, end_date, period, pay_day, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [randomUUID(), 'insurance', name, party, code, amount, sd, ed, '연납', payDay, ++insn]
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

    // 고용형태 마스터 시딩 (비어 있을 때만 — 사용자가 지운 유형이 재부팅 때 되살아나면 안 된다)
    //   4대보험: 일용·단시간은 조건부(1개월 이상 + 월 8일/60시간 이상)라 기본값을 꺼두고 계약마다 정한다.
    //            프리랜서·일시용역은 사업/기타소득이라 급여 공제 대상이 아니다.
    //   conv_alert_months: 일용이 계속 고용되면 상용근로자로 전환해야 하는 기준(세법).
    //                      일반 3개월 / 건설공사 1년. 근로·용역은 해당 없음(0).
    const [[{ ecnt }]] = await c.execute('SELECT COUNT(*) AS ecnt FROM employ_types')
    if (ecnt === 0) {
      const types = [
        // label,           kind,      income, pay_form,  unit,   np hi ei ai  conv, sort
        ["정규직",         "labor",   "근로", "annual",  null,   1, 1, 1, 1,   0,  1],
        ["계약직",         "labor",   "근로", "annual",  null,   1, 1, 1, 1,   0,  2],
        ["수습",           "labor",   "근로", "monthly", null,   1, 1, 1, 1,   0,  3],
        ["단시간",         "labor",   "근로", "hourly",  "시간", 0, 0, 1, 1,   0,  4],
        ["일용(일반)",     "daily",   "일용", "daily",   "일",   0, 0, 1, 1,   3,  5],
        ["일용(건설)",     "daily",   "일용", "daily",   "일",   0, 0, 1, 1,  12,  6],
        ["프리랜서(사업)", "service", "사업", "piece",   "건",   0, 0, 0, 0,   0,  7],
        ["일시용역(기타)", "service", "기타", "piece",   "건",   0, 0, 0, 0,   0,  8],
      ]
      for (const [label, kind, income, payForm, unit, np, hi, ei, ai, conv, so] of types) {
        await c.execute(
          `INSERT INTO employ_types
             (id, label, kind, income_type, pay_form, default_unit, insure_np, insure_hi, insure_ei, insure_ai, conv_alert_months, sort_order)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [randomUUID(), label, kind, income, payForm, unit, np, hi, ei, ai, conv, so]
        )
      }
    }

    // 기존 직원 → 최초 근로계약 자동 생성 (1회만).
    // 급여 기준이 직원 컬럼에 흩어져 있던 것을 계약의 pay_items로 옮긴다.
    // 이 마이그레이션 전의 직원도 급여대장 생성이 끊기지 않게 하는 것이 목적
    // (payroll.js의 itemsFromMaster 폴백과 이중 안전장치).
    await runOnce('work_contracts_from_employees_v1', async () => {
      const [emps] = await c.execute('SELECT * FROM employees')
      if (!emps.length) return
      const [masters] = await c.execute('SELECT * FROM payroll_item_types WHERE active = 1 ORDER BY sort_order, label')
      const [[etype]] = await c.execute("SELECT id, label FROM employ_types WHERE label = '정규직' LIMIT 1")
      for (const e of emps) {
        const [[{ wc }]] = await c.execute('SELECT COUNT(*) AS wc FROM work_contracts WHERE employee_id = ?', [e.id])
        if (wc > 0) continue
        // 직원 고정 수당을 라벨 유연매칭으로 채운다(payroll.js itemsFromMaster와 같은 규칙).
        const empValueFor = (label) => {
          const l = String(label || '')
          if (/기본급/.test(l))             return Number(e.base_salary) || 0
          if (/직책|직급/.test(l))          return Number(e.position_allowance) || 0
          if (/식대/.test(l))               return Number(e.meal_allowance) || 0
          if (/자가운전|차량|운전/.test(l)) return Number(e.vehicle_allowance) || 0
          return null
        }
        let items = masters.map(m => {
          const ev = (m.kind === 'earn' && m.mode === 'fixed') ? empValueFor(m.label) : null
          return { label: m.label, kind: m.kind, mode: m.mode, value: ev != null ? ev : (Number(m.default_value) || 0) }
        })
        if (!items.some(i => i.kind === 'earn' && /기본급/.test(i.label || ''))) {
          items.unshift({ label: '기본급', kind: 'earn', mode: 'fixed', value: Number(e.base_salary) || 0 })
        }
        await c.execute(
          `INSERT INTO work_contracts
             (id, employee_id, kind, income_type, title, employ_type_id, employ_type, start_date, term_mode,
              status, pay_form, pay_day, pay_items, insure_np, insure_hi, insure_ei, insure_ai, conv_alert_months)
           VALUES (?,?,'labor','근로',?,?,?,?,'open',?,'monthly',?,?,1,1,1,1,0)`,
          [randomUUID(), e.id, `${e.name} 근로계약`, etype?.id || null, etype?.label || '정규직',
           e.join_date || null, e.status === '퇴사' ? '만료' : '진행중', 25, JSON.stringify(items)]
        )
      }
    })

    // 급여·용역 지급 거래가 '지급 완료'(공백)로 쌓여 계좌 잔액 계산(status='지급완료')에서 누락되던 것 보정.
    // 거래(transactions)만 대상 — 청구서(invoices)의 '지급 완료'는 별개 의미라 안 건드린다.
    await runOnce('fix_txn_paid_status_space_v1', async () => {
      await c.execute("UPDATE transactions SET status='지급완료' WHERE kind='expense' AND status='지급 완료'")
    })
  } finally {
    if (pooled) c.release()
  }
}

// epoch(ms) → 한국시간 날짜(YYYY-MM-DD). 서버/DB 타임존과 무관하게 KST 달력일을 뽑는다.
const kstDate = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10)
// 오늘(한국시간, YYYY-MM-DD). 서버 타임존이 UTC여도 KST로 계산해 새벽에 날짜가 밀리지 않게 한다.
const kstToday = () => kstDate(Date.now())
// 지출·입금은 실제로 오간 돈이라 미래 일자로 등록/처리할 수 없다(오늘까지만 허용).
// 미래면 에러 메시지, 아니면 null.
const futureDateError = (date) => (date && date > kstToday())
  ? '미래 날짜로는 처리할 수 없어요 (오늘까지만 가능)'
  : null

// ⚠ pool은 의도적으로 export 하지 않는다.
// 멀티테넌트에서 전역 풀을 쓰면 '어느 회사 DB인지'가 사라져 교차 테넌트 유출이 된다.
// 라우트는 반드시 req.db(tenant 미들웨어가 주입한 회사별 풀)만 사용한다.
// export를 막아두면 실수로 가져다 쓰는 코드가 조용히 동작하지 않고 즉시 터진다.
module.exports = { initDb, kstDate, kstToday, futureDateError }
