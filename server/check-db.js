const db = require('./db')
console.log('=== DB 현황 ===')
console.log('거래처:', db.prepare('SELECT COUNT(*) AS c FROM vendors').get().c, '건')
const total = db.prepare("SELECT COUNT(*) AS c FROM invoices WHERE kind='received'").get().c
const waiting = db.prepare("SELECT COUNT(*) AS c FROM invoices WHERE kind='received' AND status='지급 대기'").get().c
const done = db.prepare("SELECT COUNT(*) AS c FROM invoices WHERE kind='received' AND status='지급 완료'").get().c
console.log('청구서(received):', total, '건')
console.log('  - 지급 대기:', waiting, '건')
console.log('  - 지급 완료:', done, '건')
console.log('정기지출:', db.prepare('SELECT COUNT(*) AS c FROM recurring_expenses').get().c, '건')
console.log('계좌:', db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c, '건')
console.log('임직원:', db.prepare('SELECT COUNT(*) AS c FROM employees').get().c, '건')
const payable2026 = db.prepare("SELECT SUM(total_amount) AS t FROM invoices WHERE kind='received' AND status='지급 대기'").get().t
console.log('\n2026년 미지급 합계:', (payable2026 || 0).toLocaleString(), '원')
