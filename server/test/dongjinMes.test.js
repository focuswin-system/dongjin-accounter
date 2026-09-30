/* 동진 MES 연결 — 거래처 칸 대응(MES 표가 원본)과 수주 상태 판정(순수 함수).
 *
 * 틀리면 두 방향 모두 사고다:
 *   틀린 짝·칸 → 회계에서 저장한 값이 **엉뚱한 MES 거래처**를 덮는다(우리 앱 밖 데이터)
 *   놓친 짝    → 같은 회사가 MES 에 두 번 생긴다(MES 수주·발주의 거래처가 갈린다)
 * 설계: docs/02-design/features/dongjin-custom-module.design.md
 */
const test = require('node:test')
const assert = require('node:assert')
const { mesToVendor, vendorToMes, vendorDiffers, findMesMatch, nextClieCode, fmtBiz } = require('../custom/dongjin/map/vendor')
const { dueState, shapeGroup, origOf } = require('../custom/dongjin/map/order')
const { isKnownFeatureKey } = require('../platform/plans')
const { customFeatureKeyOf } = require('../platform/customCatalog')
const { requiredPerm } = require('../platform/apiPerms')

const mes = (o) => ({ clie_code: 'X', clie_name: '', clie_gubu: 'A', clie_sano: '', pres_name: '', addr_knam: '', addr_deta: '',
  tele_numb: '', faxs_numb: '', taxb_mail: '', damd_name: '', upta_name: '', jong_moks: '', bank_name: '', acco_numb: '', hold_name: '',
  enab_yesn: 1, rev: '2026-01-01 00:00:00', ...o })

test('MES → 회계: 칸 대응 · 사업자번호 표기 · 주소 두 칸을 잇는다', () => {
  const v = mesToVendor(mes({ clie_name: '한화오션㈜', clie_sano: '1234567890', addr_knam: '거제시 장평로', addr_deta: '3층', clie_gubu: 'B', enab_yesn: 0 }))
  assert.equal(v.name, '한화오션㈜')
  assert.equal(v.biz_no, '123-45-67890')
  assert.equal(v.address, '거제시 장평로 3층')
  assert.equal(v.gubu, 'B')
  assert.equal(v.active, 0)
})

test('MES 코드표: D=금융/관공 → 회계 E(기관), E=기타 → 회계 A. 되돌릴 때 E(기타)는 지킨다', () => {
  assert.equal(mesToVendor(mes({ clie_gubu: 'D' })).gubu, 'E')
  assert.equal(mesToVendor(mes({ clie_gubu: 'E' })).gubu, 'A')
  assert.equal(vendorToMes({ gubu: 'E' }).clie_gubu, 'D')
  assert.equal(vendorToMes({ gubu: 'A' }, mes({ clie_gubu: 'E' })).clie_gubu, 'E', '기타를 매입으로 바꿔 버리지 않는다')
  assert.equal(vendorToMes({ gubu: 'B' }, mes({ clie_gubu: 'E' })).clie_gubu, 'B', '사람이 구분을 바꿨으면 따른다')
})

test('회계 → MES: 주소가 그대로면 MES 두 칸을 안 건드린다(저장마다 상세주소가 합쳐지지 않게)', () => {
  const cur = mes({ addr_knam: '김해시 주촌면', addr_deta: '1-2' })
  const same = vendorToMes({ address: '김해시 주촌면 1-2' }, cur)
  assert.equal(same.addr_knam, '김해시 주촌면'); assert.equal(same.addr_deta, '1-2')
  const changed = vendorToMes({ address: '부산시 강서구' }, cur)
  assert.equal(changed.addr_knam, '부산시 강서구'); assert.equal(changed.addr_deta, '')
})

test('회계 → MES: MES 칸 길이를 넘기지 않는다(strict 모드는 문장째 거절한다)', () => {
  const m = vendorToMes({ name: '가'.repeat(150), ceo: '나'.repeat(40) })
  assert.equal(m.clie_name.length, 100)
  assert.equal(m.pres_name.length, 20)
})

test('같으면 안 쓴다 — 쓸데없는 UPDATE 로 수정 시각이 흔들리지 않게', () => {
  const fromMes = mesToVendor(mes({ clie_name: 'A사', clie_sano: '1112233333' }))
  assert.equal(vendorDiffers({ ...fromMes }, fromMes), false)
  assert.equal(vendorDiffers({ ...fromMes, name: 'A사(주)' }, fromMes), true)
})

test('짝 찾기 — 사업자번호가 먼저, 번호가 없을 때만 상호로(같은 회사를 MES 에 두 번 만들지 않게)', () => {
  const free = [mes({ clie_code: 'M1', clie_name: '한전', clie_sano: '' }), mes({ clie_code: 'M2', clie_name: 'B사', clie_sano: '222-22-22222' })]
  assert.equal(findMesMatch({ name: '아무이름', biz_no: '2222222222' }, free).clie_code, 'M2')
  assert.equal(findMesMatch({ name: '한전', biz_no: '' }, free).clie_code, 'M1')
  assert.equal(findMesMatch({ name: 'B사', biz_no: '9999999999' }, free), null, '번호가 다르면 이름이 같아도 다른 회사')
})

test('MES 거래처코드 — MES 와 같은 규칙(YYYYMM + A~Z + 001~999)', () => {
  assert.equal(nextClieCode(null, '202609'), '202609A001')
  assert.equal(nextClieCode('202609A041', '202609'), '202609A042')
  assert.equal(nextClieCode('202609A999', '202609'), '202609B001')
  assert.throws(() => nextClieCode('202609Z999', '202609'))
  assert.equal(fmtBiz('603-81-44150'), '603-81-44150')
})

/* ── 수주 단계·납기 ── */
const TODAY = '2026-09-28'

test('납기 — 출하완료면 따지지 않는다(늦게라도 끝났으면 빨강이 아니다)', () => {
  assert.equal(dueState(5, '2026-01-01', TODAY), null)
})
test('납기 — 지남 / 14일 안(오늘 포함) / 그 뒤', () => {
  assert.equal(dueState(1, '2026-09-27 00:00:00', TODAY), 'late')
  assert.equal(dueState(3, '2026-09-28', TODAY), 'soon')
  assert.equal(dueState(1, '2026-10-12', TODAY), 'soon')
  assert.equal(dueState(1, '2026-10-13', TODAY), null)
  assert.equal(dueState(1, null, TODAY), null)
})
test('PO 모양 — 단계 이름·완료 품목 수·원청(한화·현대 밖은 기타)', () => {
  const g = shapeGroup({ cont_numb: 'P1', orig_gubu: 'HW', line_cnt: 2, done_cnt: 1, stage: 3, amount: '10.5', next_due: '2027-01-01' }, TODAY)
  assert.equal(g.stageLabel, '출하대기')
  assert.equal(g.doneLines, 1)
  assert.equal(g.amount, 10.5)
  assert.equal(g.orig, 'HW')
  assert.equal(origOf('SK'), 'ETC')
  assert.equal(origOf(null), 'ETC')
})

/* ── 켜고 끄기·권한 배선 ── */
test('전용 모듈 키는 알려진 이름 규칙이다(오타 키가 콘솔에서 조용히 무시되지 않게)', () => {
  assert.equal(customFeatureKeyOf('dongjin_mes'), 'custom:dongjin_mes')
  assert.ok(isKnownFeatureKey('custom:dongjin_mes'))
})
test('권한 — MES 수주는 계약관리 › 수주 화면의 권한을 쓴다', () => {
  assert.deepEqual(requiredPerm('GET', '/api/dongjin-mes/orders').resources, ['contract_sales'])
  assert.deepEqual(requiredPerm('GET', '/api/dongjin-mes/orders/4003769237/lines').resources, ['contract_sales'])
})

test('짝 찾기: 사업자번호 없는 이름 매칭은 딱 하나일 때만', () => {
  const free = [mes({ clie_code: 'N1', clie_name: '홍길동' }), mes({ clie_code: 'N2', clie_name: '홍길동' })]
  assert.equal(findMesMatch({ name: '홍길동', biz_no: '' }, free), null, '같은 이름 둘 — 어느 쪽인지 모르면 잇지 않는다')
  assert.equal(findMesMatch({ name: '', biz_no: '' }, [mes({ clie_code: 'N3', clie_name: '' })]), null, '빈 이름끼리 잇지 않는다')
})

test('쓰기: 바뀐 칸만 MES 로 · 수정 시각 비교는 글자 19자리로', () => {
  const { _test: { changedOnly, sameRev } } = require('../custom/dongjin/vendorSource')
  const cur = mes({ clie_name: 'A사', tele_numb: '02-1', enab_yesn: 1 })
  const next = vendorToMes({ name: 'A사', phone: '02-2', active: 1 }, cur)
  assert.deepEqual(Object.keys(changedOnly(next, cur)), ['tele_numb'], 'MES 에서 안 바꾼 칸은 건드리지 않는다')
  assert.deepEqual(changedOnly(vendorToMes({ name: 'A사', phone: '02-1', active: 1 }, cur), cur), {})
  assert.equal(sameRev('2026-09-28 10:00:00', '2026-09-28 10:00:00.000'), true)
  assert.equal(sameRev('2026-09-28 10:00:00', '2026-09-28 10:00:01'), false)
  assert.equal(sameRev(null, null), false, '기록이 없으면 같다고 보지 않는다(처음 이은 행은 MES 값으로 덮는다)')
})

test('한 회사 안에서 끌어오기·쓰기는 한 줄로 — 겹치지 않고, 앞이 실패해도 뒤는 돈다', async () => {
  const { _test: { serial } } = require('../custom/dongjin/vendorSource')
  const db = {}
  let running = 0, maxRunning = 0
  const job = serial(async (_db, fail) => {
    running++; maxRunning = Math.max(maxRunning, running)
    await new Promise(r => setTimeout(r, 5))
    running--
    if (fail) throw new Error('x')
    return 'ok'
  })
  const rs = await Promise.allSettled([job(db, false), job(db, true), job(db, false)])
  assert.equal(maxRunning, 1)
  assert.deepEqual(rs.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled'])
})

test('발주: MES 진행상태를 그대로 단계로 · 입고 진척 · 입고완료면 납품일을 안 따진다', () => {
  const { shapePurchase } = require('../custom/dongjin/map/order')
  const base = { ppro_numb: 'PP1', ppro_date: '2026-09-01 00:00:00', clie_name: 'A', line_cnt: 3, first_matl: 'BENDING',
    qty: 10, rece_qty: 4, amount: 1000, afte_conf: '완결', pdel_date: '2026-09-10 00:00:00' }
  const a = shapePurchase({ ...base, ppro_stat: '입고처리' }, '2026-09-20')
  assert.equal(a.stage, 4); assert.equal(a.stageLabel, '입고처리')
  assert.equal(a.items, 'BENDING 외 2'); assert.equal(a.receRate, 40)
  assert.equal(a.due, 'late', '납품일이 지났는데 입고가 안 끝났다')
  const b = shapePurchase({ ...base, ppro_stat: '입고완료', rece_qty: 10 }, '2026-09-20')
  assert.equal(b.due, null, '다 들어온 발주는 늦었다고 하지 않는다'); assert.equal(b.receRate, 100)
  assert.equal(shapePurchase({ ...base, ppro_stat: '모르는값' }, '2026-09-20').stageLabel, '발주등록')
  assert.equal(shapePurchase({ ...base, line_cnt: 0, qty: 0 }, '2026-09-20').receRate, null)
})

test('권한: 동진 발주 목록은 발주 화면 권한, 수주는 수주 화면 권한', () => {
  assert.deepEqual(requiredPerm('GET', '/api/dongjin-mes/purchase-orders').resources, ['contract_purchase'])
  assert.deepEqual(requiredPerm('GET', '/api/dongjin-mes/purchase-orders/PP1/lines').resources, ['contract_purchase'])
  assert.deepEqual(requiredPerm('GET', '/api/dongjin-mes/orders').resources, ['contract_sales'])
})
