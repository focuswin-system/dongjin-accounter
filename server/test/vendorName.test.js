// 상호 정규화(lib/vendorName.js) — 화면 규칙과 한 쌍
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { normVendorName } = require('../lib/vendorName')

test('법인격·띄어쓰기·기호만 다르면 같은 회사', () => {
  const k = normVendorName('한빛문구')
  for (const v of ['(주)한빛문구', '주식회사 한빛문구', '한빛 문구', '㈜한빛문구', '한빛문구(주)']) {
    assert.strictEqual(normVendorName(v), k, v)
  }
  assert.strictEqual(normVendorName('(재)부산영재교육진흥원'), normVendorName('재단법인 부산영재교육진흥원'))
})

test('오타·줄임말은 다른 회사로 둔다(잘못 이으면 남의 거래처에 돈이 붙는다)', () => {
  assert.notStrictEqual(normVendorName('한빛테크'), normVendorName('한빛테그'))
  assert.notStrictEqual(normVendorName('한빛'), normVendorName('한빛테크'))
})

test('화면 규칙(src/lib/normalize.js)과 글자까지 같다 — 둘이 갈리면 거래처가 두 벌 생긴다', () => {
  const pick = (src) => src.match(/normVendorName = \(v\) => String\(v \?\? ''\)([\s\S]*?toLowerCase\(\))/)[1].replace(/\s+/g, ' ')
  const client = fs.readFileSync(path.join(__dirname, '../../src/lib/normalize.js'), 'utf8')
  const server = fs.readFileSync(path.join(__dirname, '../lib/vendorName.js'), 'utf8')
  assert.strictEqual(pick(server), pick(client))
})
