/**
 * 첨부파일 서빙 — 회사별 격리
 *
 * 이전에는 express.static으로 /uploads 전체를 인증 없이 열어뒀다.
 * 회사가 둘 이상이 되는 순간 이것은 곧 정보 유출이다 — 파일명만 알면(혹은 찍으면)
 * 남의 회사 세금계산서·계약서·증빙을 그대로 받아갈 수 있다.
 * DB를 아무리 분리해도 여기가 뚫리면 의미가 없다.
 *
 * 규칙:
 *   · 경로는 /uploads/{companyId}/{filename} 형태로만 존재한다
 *   · 요청자의 companyId와 경로의 companyId가 일치해야 한다
 *   · 경로 조작(../)으로 회사 폴더 밖을 못 나가게 실제 경로를 확인한다
 *
 * 설계: docs/02-design/features/multi-tenant-saas.design.md §5.3
 */
const { Router } = require('express')
const path = require('path')
const fs = require('fs')
const { fileAuth } = require('../middleware/fileAuth')

const router = Router()
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads')

router.get('/:companyId/:filename', fileAuth, (req, res) => {
  const { companyId, filename } = req.params

  // 1) 소유 회사 확인 — 다른 회사 파일은 존재 여부조차 알려주지 않는다(404로 통일).
  if (companyId !== req.fileUser.companyId) {
    return res.status(404).send('파일을 찾을 수 없습니다')
  }

  // 2) 경로 이탈 방지. filename에 ../ 나 절대경로가 들어와도 회사 폴더를 벗어날 수 없다.
  const companyDir = path.resolve(UPLOAD_ROOT, companyId)
  const target = path.resolve(companyDir, filename)
  if (target !== companyDir && !target.startsWith(companyDir + path.sep)) {
    return res.status(400).send('잘못된 경로입니다')
  }

  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return res.status(404).send('파일을 찾을 수 없습니다')
  }

  // 브라우저가 첨부를 그대로 실행하지 못하게 한다(HTML/SVG 업로드를 통한 XSS 방지).
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.sendFile(target)
})

module.exports = router
