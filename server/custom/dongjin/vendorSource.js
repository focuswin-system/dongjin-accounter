/**
 * 동진테크 거래처 원본 = MES 표(COERP_COM_CLIENTELE). lib/vendorSource.js 에 끼우는 구현.
 *
 * ── 흐름 ──
 *   끌어오기(pull)  MES → 회계 짝 행. MES 가 바뀐 행만(수정 시각이 대장의 값과 다를 때) 덮는다.
 *                    MES 에 새로 생긴 코드는 회계에 짝 행을 만든다.
 *                    회계에만 있는 거래처(홈택스·엑셀 임포트가 먼저 만든 것)는 MES 에 올린다 —
 *                    올리기 전에 같은 회사가 MES 에 있는지 먼저 찾는다(findMesMatch).
 *   쓰기(push)       회계에서 등록·수정한 행 → MES. 짝이 없으면 MES 에서 같은 회사를 먼저 찾고, 없으면 만든다.
 *                    **바뀐 칸만** 쓴다. 마지막으로 맞춘 뒤 MES 에서 누가 고쳤으면 덮지 않고 409.
 *   지우기(remove)   MES 에서는 지우지 않는다(수주·발주가 코드를 들고 있다). 양쪽 다 '사용 안 함'.
 *
 * ── 두 DB 는 한 트랜잭션으로 못 묶는다 ── (다른 계정·다른 풀)
 *   그래서 MES 를 먼저 쓰고 회계를 맞춘다. 회계 쪽이 실패해도 다음 끌어오기가 MES 값으로 되맞춘다 —
 *   원본이 MES 라서 되돌아가는 방향이 늘 하나다.
 *
 * ── 한 회사 안에서는 한 줄로 선다 ── (serial)
 *   목록 화면 둘이 동시에 끌어오면 둘 다 'MES 에 새 코드'를 보고 짝 행을 두 개 만든다(검토에서 잡힘).
 *   pull·push·remove 는 테넌트 풀마다 하나씩만 돈다. 안에서 서로 부를 땐 감싸지 않은 *Raw 를 부른다
 *   (감싼 걸 부르면 자기 뒤에 줄을 서서 영영 안 끝난다).
 *
 * 모든 함수는 db(테넌트 풀)를 인자로 받는다(전역 풀 금지).
 */
const { randomUUID } = require('crypto')
const { platformPool } = require('../../platform/db')
const { featuresOf } = require('../../lib/entitlements')
const { customFeatureKeyOf } = require('../../platform/customCatalog')
const { httpError } = require('../../lib/withTx')
const { kstToday } = require('../../db')
const { mesPool } = require('./mesDb')
const mesRead = require('./mesRead')
const { insertClient, updateClient } = require('./mesWrite')
const { mesToVendor, vendorDiffers, vendorToMes, findMesMatch } = require('./map/vendor')

const SOURCE = 'mes_dj'
const ENTITY = 'vendor'
const FEATURE = customFeatureKeyOf('dongjin_mes')

/* 끌어오기 간격 — 목록은 화면마다 부른다. MES 거래처는 121곳 수준이라 한 번에 읽어도 가볍지만,
   화면 전환마다 두 DB 를 훑을 이유는 없다. 우리가 쓴 직후에는 강제로 끌어온다. */
const PULL_EVERY_MS = 15_000
const lastPull = new WeakMap()   // 테넌트 풀(회사마다 하나, poolManager 가 재사용) → 시각
const queue = new WeakMap()      // 테넌트 풀 → 앞 작업의 promise

function serial(fn) {
  return (db, ...args) => {
    const prev = queue.get(db) || Promise.resolve()
    const run = prev.then(() => fn(db, ...args))
    queue.set(db, run.catch(() => {}))   // 앞 작업이 실패해도 뒤 작업은 돈다
    return run
  }
}

const VCOLS = ['name', 'biz_no', 'ceo', 'address', 'phone', 'fax', 'email', 'contact', 'gubu',
  'biz_type', 'biz_item', 'bank_name', 'bank_account', 'account_holder', 'active']

async function applies(req) {
  if (!req.user?.companyId || !mesPool()) return false
  const f = await featuresOf(platformPool, req.user.companyId, kstToday())
  return f.has(FEATURE)
}

/* ext_rev 는 글자로 받는다 — 테넌트 풀은 DATETIME 을 Date 로 주고, MES 풀은 글자로 준다(dateStrings).
   둘을 그대로 견주면 늘 달라서 매번 덮어쓰게 된다(검토에서 잡힘) */
async function links(db) {
  const [rows] = await db.execute(
    `SELECT local_id, ext_key, DATE_FORMAT(ext_rev, '%Y-%m-%d %H:%i:%s') AS ext_rev, ext_gone
       FROM external_links WHERE source = ? AND entity = ?`, [SOURCE, ENTITY])
  return rows
}

async function writeLink(db, localId, code, rev) {
  await db.execute(
    `INSERT INTO external_links (id, source, entity, local_id, ext_key, ext_rev, ext_gone, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NOW())
     ON DUPLICATE KEY UPDATE local_id = VALUES(local_id), ext_rev = VALUES(ext_rev), ext_gone = 0, synced_at = NOW()`,
    [randomUUID(), SOURCE, ENTITY, localId, code, rev || null])
}

async function markGone(db, code) {
  await db.execute('UPDATE external_links SET ext_gone = 1 WHERE source = ? AND entity = ? AND ext_key = ?',
    [SOURCE, ENTITY, code])
}

async function writeLocal(db, id, v) {
  await db.execute(`UPDATE vendors SET ${VCOLS.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...VCOLS.map(c => v[c]), id])
}

const revStr = (v) => String(v || '').slice(0, 19)
const sameRev = (a, b) => !!revStr(a) && revStr(a) === revStr(b)

/* 처음 이을 때 — 사용 중인 회계 행을 먼저(같은 회사가 사용 안 함 행과 둘 있으면 산 쪽이 짝이 된다) */
const activeFirst = (a, b) => Number(b.active ?? 1) - Number(a.active ?? 1)

/**
 * MES → 회계. @param {{force?:boolean}} opts  force: 간격 무시(우리가 방금 쓴 뒤)
 * @returns {{ updated, created, uploaded, gone }}
 */
async function pullRaw(db, opts = {}) {
  if (!opts.force && Date.now() - (lastPull.get(db) || 0) < PULL_EVERY_MS) return null
  lastPull.set(db, Date.now())
  const mes = mesPool()
  const [mesRows, linkRows, [locals]] = await Promise.all([
    mesRead.listClients(mes), links(db), db.execute(`SELECT id, ${VCOLS.join(', ')} FROM vendors`),
  ])
  const localById = new Map(locals.map(v => [v.id, v]))
  const linkByCode = new Map(linkRows.map(l => [String(l.ext_key), l]))
  // 사라진(ext_gone) 짝도 '짝 있음'으로 센다 — 안 그러면 1)·4) 가 그 거래처를 MES 에 되살린다
  const linkedLocal = new Set(linkRows.map(l => l.local_id))
  const out = { updated: 0, created: 0, uploaded: 0, gone: 0 }

  // 1) 짝이 없는 회계 거래처 중 MES 에 같은 회사가 있으면 먼저 잇는다(처음 옮길 때 — 중복 생성 방지)
  const freeMes = mesRows.filter(r => !linkByCode.has(String(r.clie_code)))
  for (const v of [...locals].sort(activeFirst)) {
    if (linkedLocal.has(v.id)) continue
    const m = findMesMatch(v, freeMes)
    if (!m) continue
    await writeLink(db, v.id, m.clie_code, null)   // rev 를 비워 두면 아래 2) 에서 MES 값으로 덮인다
    linkByCode.set(String(m.clie_code), { local_id: v.id, ext_key: m.clie_code, ext_rev: null, ext_gone: 0 })
    linkedLocal.add(v.id)
    freeMes.splice(freeMes.indexOf(m), 1)
  }

  // 2) MES 각 행 → 회계 짝 행(없으면 만든다)
  const seen = new Set()
  for (const r of mesRows) {
    const code = String(r.clie_code)
    seen.add(code)
    const fromMes = mesToVendor(r)
    const link = linkByCode.get(code)
    const local = link && localById.get(link.local_id)
    if (local) {
      if (sameRev(link.ext_rev, r.rev) && !Number(link.ext_gone) && !opts.force) continue
      if (vendorDiffers(local, fromMes)) { await writeLocal(db, local.id, fromMes); out.updated++ }
      await writeLink(db, local.id, code, r.rev)
      continue
    }
    const id = randomUUID()
    await db.execute(`INSERT INTO vendors (id, ${VCOLS.join(', ')}) VALUES (?, ${VCOLS.map(() => '?').join(', ')})`,
      [id, ...VCOLS.map(c => fromMes[c])])
    await writeLink(db, id, code, r.rev)
    linkedLocal.add(id)
    out.created++
  }

  // 3) MES 에서 사라진 코드(하드 삭제) → 회계 짝 행은 지우지 않고 '사용 안 함'(장부가 가리킬 수 있다). 한 번만
  for (const l of linkRows) {
    if (seen.has(String(l.ext_key)) || Number(l.ext_gone)) continue
    await markGone(db, l.ext_key)
    await db.execute('UPDATE vendors SET active = 0 WHERE id = ?', [l.local_id])
    out.gone++
  }

  /* 4) 여전히 짝이 없는 회계 거래처 → MES 에 올린다(원본을 하나로). 사용 안 함인 것은 올리지 않는다.
   *
   * ⚠ **기본은 꺼져 있다**(MES_VENDOR_UPLOAD=1 일 때만). 켜는 순간 회계에만 있던 거래처(한전·개인 등)가
   *   MES 거래처 목록에 한꺼번에 생긴다 — 운영 동진은 회계 145 · MES 121 이라 스무 곳 넘게 들어간다.
   *   그건 데이터 주인이 정할 일이다(2026-09-28 질문 Q1, 답 대기). 꺼져 있어도 사람이 거래처 화면에서
   *   저장한 것(push)은 MES 로 간다. */
  if (process.env.MES_VENDOR_UPLOAD !== '1') return out
  for (const v of locals) {
    if (linkedLocal.has(v.id) || !Number(v.active ?? 1)) continue
    if (!String(v.name || '').trim()) continue
    const { code, rev } = await insertClient(mes, vendorToMes(v))
    await writeLink(db, v.id, code, rev)
    out.uploaded++
  }
  return out
}

/* 지금 MES 행과 다른 칸만 — 안 바꾼 칸을 옛 값으로 덮지 않게(MES 화면에서 방금 고친 칸 보호) */
function changedOnly(next, cur) {
  const out = {}
  for (const [k, v] of Object.entries(next)) {
    const was = k === 'enab_yesn' ? Number(cur[k]) : String(cur[k] ?? '').trim()
    const now = k === 'enab_yesn' ? Number(v) : String(v ?? '').trim()
    if (was !== now) out[k] = v
  }
  return out
}

const conflict = (msg) => Object.assign(httpError(409, msg), { mesConflict: true })
const GONE_MSG = 'MES 에서 지워진 거래처예요. MES 에서 다시 등록하면 여기에도 생겨요.'

/** 회계 → MES 한 곳 */
async function pushOne(db, mes, id, linkByLocal) {
  const [[v]] = await db.execute(`SELECT id, ${VCOLS.join(', ')} FROM vendors WHERE id = ?`, [id])
  if (!v) return
  let link = linkByLocal.get(id)
  // MES 에서 지워진 거래처를 회계가 되살리지 않는다 — 원본은 MES 다
  if (link && Number(link.ext_gone)) throw conflict(GONE_MSG)
  if (!link) {
    // 짝이 없으면 MES 에 같은 회사가 이미 있는지 먼저 — 끌어오기 간격(15초) 사이에 MES 에서 만든 것일 수 있다
    const linked = new Set([...linkByLocal.values()].map(l => String(l.ext_key)))
    const free = (await mesRead.listClients(mes)).filter(r => !linked.has(String(r.clie_code)))
    const m = findMesMatch(v, free)
    if (m) {
      link = { local_id: id, ext_key: String(m.clie_code), ext_rev: revStr(m.rev), ext_gone: 0 }
      await writeLink(db, id, link.ext_key, link.ext_rev)
      linkByLocal.set(id, link)
    }
  }
  if (!link) {
    const r = await insertClient(mes, vendorToMes(v))
    await writeLink(db, id, r.code, r.rev)
    return
  }
  const code = String(link.ext_key)
  const [cur] = await mesRead.clientsByCodes(mes, [code])
  if (!cur) { await markGone(db, code); throw conflict(GONE_MSG) }
  // 마지막으로 맞춘 뒤 MES 에서 누가 고쳤다 → 덮지 않는다. 부르는 쪽이 MES 값으로 되맞춘다
  if (link.ext_rev && !sameRev(link.ext_rev, cur.rev)) {
    throw conflict('그 사이 MES 에서 이 거래처가 바뀌었어요. 바뀐 값을 불러왔으니 확인하고 다시 저장해 주세요.')
  }
  const fields = changedOnly(vendorToMes(v, cur), cur)
  if (!Object.keys(fields).length) { await writeLink(db, id, code, cur.rev); return }
  const r = await updateClient(mes, code, fields)
  await writeLink(db, id, code, r ? r.rev : cur.rev)
}

/** 회계 → MES. ids: 방금 만들거나 고친 회계 거래처 */
async function pushRaw(db, ids) {
  if (!ids.length) return
  const mes = mesPool()
  const linkByLocal = new Map((await links(db)).map(l => [l.local_id, l]))
  try {
    for (const id of ids) await pushOne(db, mes, id, linkByLocal)
  } catch (e) {
    if (!e.mesConflict) console.error('[dongjin-mes] MES 거래처 저장 실패:', e.code || e.message)
    // 회계 짝 행을 MES 값으로 되돌린다 — 원본(MES)과 다른 값이 회계에만 남지 않게
    let reverted = false
    try { await pullRaw(db, { force: true }); reverted = true } catch { /* 되돌리기 실패는 원래 오류를 덮지 않는다 */ }
    if (e.mesConflict) throw e
    throw httpError(502, reverted
      ? 'MES 거래처 표에 저장하지 못했어요. 회계 쪽 값은 MES 값으로 되돌렸어요. 잠시 뒤 다시 저장해 주세요.'
      : 'MES 에 연결되지 않아 거래처를 저장하지 못했어요. 잠시 뒤 다시 저장해 주세요.')
  }
  // 우리가 쓴 값이 MES 에서 어떻게 정리됐는지(칸 길이 자르기 등) 회계에도 맞춘다
  await pullRaw(db, { force: true })
}

/** 지우기 → 양쪽 '사용 안 함'. MES 는 수주·발주가 코드를 들고 있어 지우지 않는다 */
async function removeRaw(db, id) {
  const l = (await links(db)).find(x => x.local_id === id)
  if (!l) return null
  if (!Number(l.ext_gone)) {
    const r = await updateClient(mesPool(), String(l.ext_key), { enab_yesn: 0 })
    if (r) await writeLink(db, id, l.ext_key, r.rev)
  }
  await db.execute('UPDATE vendors SET active = 0 WHERE id = ?', [id])
  return { ok: true, deactivated: true,
    message: 'MES 거래처는 지우지 않고 사용 안 함으로 바꿨어요(MES 수주·발주가 이 거래처를 쓰고 있을 수 있어요).' }
}

const pull = serial(pullRaw)
const push = serial(pushRaw)
const remove = serial(removeRaw)

module.exports = { applies, pull, push, remove, SOURCE, _test: { changedOnly, sameRev, serial } }
