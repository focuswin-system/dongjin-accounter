/**
 * 초기 데이터 시딩 (개발용)
 * 실행: node seed.js
 *
 * ⚠ 멀티테넌트 전환 후: 전역 pool은 더 이상 export 되지 않는다(회사 구분이 사라지므로).
 *   이 스크립트는 **DB_NAME 이 가리키는 첫 테넌트**에만 관리 계정으로 시딩한다.
 *   다른 회사에 데이터를 넣으려면 그 회사로 로그인해 화면에서 입력하거나,
 *   withAdmin(..., { database: '<그 회사 db_name>' }) 로 대상 DB를 지정해야 한다.
 */
require('dotenv').config()
const { randomUUID } = require('crypto')
const { initDb } = require('./db')
const { withAdmin, assertDbName } = require('./platform/db')

const TARGET_DB = assertDbName(process.env.DB_NAME || 'dongjin_erp')

async function seed() {
  await withAdmin(async (c) => {
    await initDb(c)
    await seedInto(c)
  }, { database: TARGET_DB })
}

async function seedInto(c) {
  {
    // ─── 1. 계좌 ─────────────────────────────────────────────────
    const [[{ accCnt }]] = await c.execute('SELECT COUNT(*) AS accCnt FROM accounts')
    if (accCnt === 0) {
      const accounts = [
        ['acc-001', '기업은행(주거래) *4010',  'IBK기업은행', '보통예금', 48720000],
        ['acc-002', '하나은행(급여이체) *7231', '하나은행',    '보통예금', 22450000],
        ['acc-003', '기업은행(시제통장) *077',  'IBK기업은행', '보통예금',  5890000],
        ['acc-004', '우리은행(정산) *301',       '우리은행',    '보통예금',        0],
      ]
      for (const [id, name, bank, type, bal] of accounts) {
        await c.execute('INSERT INTO accounts (id, name, bank, type, initial_balance) VALUES (?,?,?,?,?)', [id, name, bank, type, bal])
      }
      console.log('✅ 계좌 4건 등록')
    } else {
      console.log('⏭️  계좌 이미 존재, 건너뜀')
    }

    // ─── 2. 거래처 ───────────────────────────────────────────────
    const [[{ vndCnt }]] = await c.execute('SELECT COUNT(*) AS vndCnt FROM vendors')
    if (vndCnt === 0) {
      const vendors = [
        // 발주처 (B)
        [randomUUID(), '한화오션',          '415-81-37235', 'B', '발주처',   '—'],
        [randomUUID(), 'HD현대중공업',       '290-81-00066', 'B', '발주처',   '—'],
        // 외주가공 (A)
        [randomUUID(), '광명산업',          '', 'A', '외주가공', '외주가공'],
        [randomUUID(), '건후테크',          '', 'A', '외주가공', '외주가공'],
        [randomUUID(), '세한테크',          '', 'A', '외주가공', '외주가공'],
        [randomUUID(), '와이더블유테크',    '', 'A', '외주가공', '외주가공'],
        [randomUUID(), '일광테크',          '', 'A', '외주가공', '외주가공'],
        [randomUUID(), '금화테크',          '', 'A', '외주가공', '외주가공'],
        [randomUUID(), '세원에스엔피',      '', 'A', '외주가공', '외주가공'],
        [randomUUID(), '태인',              '', 'A', '외주가공', '외주가공'],
        [randomUUID(), '금보산업',          '', 'A', '외주가공', '외주가공'],
        [randomUUID(), '대성산업',          '', 'A', '외주가공', '외주가공'],
        [randomUUID(), '동국기업',          '', 'A', '외주가공', '외주가공'],
        [randomUUID(), '제이와이물류',      '', 'A', '운반',     '운반'],
        [randomUUID(), '흥성철강',          '', 'A', '원자재',   '자재공급'],
        [randomUUID(), '한우리급식(주)',     '606-86-52066', 'A', '급식', '급식'],
        [randomUUID(), '임대인 박OO',       '', 'A', '임차',     '임차'],
        // 기관 (E)
        [randomUUID(), '국민건강보험공단',  '', 'E', '기관', '4대보험'],
        [randomUUID(), '한국전력공사',      '', 'E', '기관', '전기'],
        [randomUUID(), '세무법인부성',      '', 'E', '기관', '세무'],
        [randomUUID(), '경남에너지',        '', 'E', '기관', '가스'],
        [randomUUID(), '진례기숙사(이정화)','', 'E', '임차', '임차'],
        [randomUUID(), '한국산업안전공단',  '', 'E', '기관', '안전'],
      ]
      for (const row of vendors) {
        await c.execute('INSERT INTO vendors (id, name, biz_no, gubu, type, service_type) VALUES (?,?,?,?,?,?)', row)
      }
      console.log(`✅ 거래처 ${vendors.length}건 등록`)
    } else {
      console.log('⏭️  거래처 이미 존재, 건너뜀')
    }

    // ─── 3. 임직원 ───────────────────────────────────────────────
    const [[{ empCnt }]] = await c.execute('SELECT COUNT(*) AS empCnt FROM employees')
    if (empCnt === 0) {
      const staff = [
        ['김원철', '대표이사', '경영'],
        ['김구섭', '차장',     '관리'],
        ['백정숙', '차장',     '관리'],
        ['임효진', '경리',     '관리'],
        ['남혜윤', '—',        '—'],
        ['문성욱', '팀장',     '생산'],
        ['조승래', '생산직',   '생산'],
        ['신훈범', '생산직',   '생산'],
        ['신영범', '생산직',   '생산'],
        ['뚜에',   '생산직',   '생산'],
        ['부디',   '생산직',   '생산'],
        ['아데',   '생산직',   '생산'],
        ['이완',   '생산직',   '생산'],
        ['투안',   '생산직',   '생산'],
        ['키엔',   '생산직',   '생산'],
        ['CNC',    '생산직',   '생산'],
      ]
      for (const [name, role, dept] of staff) {
        await c.execute('INSERT INTO employees (id, name, role, department, active) VALUES (?,?,?,?,1)', [randomUUID(), name, role, dept])
      }
      console.log(`✅ 임직원 ${staff.length}명 등록`)
    } else {
      console.log('⏭️  임직원 이미 존재, 건너뜀')
    }

    // ─── 4. 정기 지출 ────────────────────────────────────────────
    const [[{ recCnt }]] = await c.execute('SELECT COUNT(*) AS recCnt FROM recurring_expenses')
    if (recCnt === 0) {
      const getVendorId = async (name) => {
        const [rows] = await c.execute('SELECT id FROM vendors WHERE name = ?', [name])
        return rows[0]?.id || null
      }

      const recurring = [
        { vendor: '한우리급식(주)',     cat: '복리후생비(생산)', amount:  3500000, period: 'monthly',   day: 10, active: 1 },
        { vendor: '국민건강보험공단',   cat: '복리후생비(생산)', amount:  3450000, period: 'monthly',   day: 10, active: 1 },
        { vendor: '국민건강보험공단',   cat: '복리후생비(관리)', amount:  1150000, period: 'monthly',   day: 10, active: 1 },
        { vendor: '한국전력공사',       cat: '전력비',          amount:  3200000, period: 'monthly',   day:  5, active: 1 },
        { vendor: '임대인 박OO',        cat: '임차료',          amount:  3200000, period: 'monthly',   day:  1, active: 1 },
        { vendor: '세무법인부성',       cat: '수수료',          amount:   517000, period: 'monthly',   day: 10, active: 1 },
        { vendor: '제이와이물류',       cat: '운반비',          amount:   968000, period: 'monthly',   day: 15, active: 1 },
        { vendor: '진례기숙사(이정화)', cat: '임차료',          amount:    50000, period: 'monthly',   day:  1, active: 1 },
        { vendor: '경남에너지',         cat: '수도광열비',      amount:   155460, period: 'monthly',   day: 25, active: 1 },
        { vendor: '한국산업안전공단',   cat: '안전관리비',      amount:   450000, period: 'quarterly', day:  5, active: 0 },
      ]

      for (const r of recurring) {
        const vendorId = await getVendorId(r.vendor)
        await c.execute(
          'INSERT INTO recurring_expenses (id, vendor_id, category, amount, period, day_of_month, start_date, account_id, active) VALUES (?,?,?,?,?,?,?,?,?)',
          [randomUUID(), vendorId, r.cat, r.amount, r.period, r.day, '2026-01-01', 'acc-001', r.active]
        )
      }
      console.log(`✅ 정기지출 ${recurring.length}건 등록`)
    } else {
      console.log('⏭️  정기지출 이미 존재, 건너뜀')
    }

    console.log('\n✅ 기준정보 시딩 완료')
    console.log('다음 단계: 계약·거래·청구서는 UI에서 직접 입력하세요.')

  }
  // 연결 정리는 withAdmin 이 담당한다(열었다 반드시 닫음).
}

seed()
  .then(() => process.exit(0))
  .catch(e => { console.error('시딩 실패:', e.message); process.exit(1) })
