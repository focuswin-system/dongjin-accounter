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

/* 비슷한 이름 — 묻는 데만 쓴다(잇지 않는다). 운영 fowin: '복지관'과 '복지회관'으로 갈려 같은 입금이 두 줄 섰다 */
const { isSimilarVendorName } = require('../lib/vendorName')
test('한 글자 차이(다섯 글자 이상)는 비슷하다', () => {
  assert.strictEqual(isSimilarVendorName('금강노인종합복지관', '금강노인종합복지회관'), true)
  assert.strictEqual(isSimilarVendorName('(주)동진테크', '주식회사 동진테크'), true)     // 정규화하면 같다
  assert.strictEqual(isSimilarVendorName('한국머신툴스', '한국머신틀스'), true)          // 바꿈
})
test('짧은 이름·두 글자 이상 차이는 비슷하지 않다', () => {
  assert.strictEqual(isSimilarVendorName('한빛테크', '한빛테그'), false)                 // 4자 — 다른 회사인 일이 흔하다
  assert.strictEqual(isSimilarVendorName('금강노인문화센터', '금강노인종합복지관'), false)
  assert.strictEqual(isSimilarVendorName('동진테크', '동진테크닉스'), false)
  assert.strictEqual(isSimilarVendorName('', '동진테크'), false)
})
test('비슷한 이름 판정도 화면(src/lib/normalize.js)과 글자까지 같다', () => {
  const pick = (src) => src.match(/const isSimilarVendorName = \(a, b\) => \{([\s\S]*?)\n\}/)[1].replace(/\s+/g, ' ')
  const client = fs.readFileSync(path.join(__dirname, '../../src/lib/normalize.js'), 'utf8')
  const server = fs.readFileSync(path.join(__dirname, '../lib/vendorName.js'), 'utf8')
  assert.strictEqual(pick(server), pick(client))
})
