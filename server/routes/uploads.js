const { Router } = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')

const router = Router()

// 파일은 반드시 회사 폴더 안에 저장한다 — 경로 자체가 소유 회사를 증명하고,
// 다운로드 시 요청자의 companyId와 대조해 타사 접근을 막는다(routes/files.js).
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const companyId = req.user?.companyId
    if (!companyId) return cb(new Error('회사 정보가 없어 업로드할 수 없습니다'))
    const dir = path.join(__dirname, '../uploads', companyId)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname)
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9가-힣_-]/g, '_')
    cb(null, `${Date.now()}_${base}${ext}`)
  },
})

const MAX_MB = 20
const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.xlsx', '.xls', '.docx', '.hwp']
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, allowed.includes(ext))
  },
})

/* multer 가 던지는 오류(용량 초과 등)를 **사람 말로** 돌려준다. 그냥 두면 전역 오류 처리로 가서
   500 '서버 오류'가 되고, 화면은 무엇이 문제였는지 모른 채 'upload failed' 만 띄웠다(2026-09-29 실사용). */
const single = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next()
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `파일이 너무 커요. ${MAX_MB}MB 까지 올릴 수 있어요.` })
  }
  if (err instanceof multer.MulterError) return res.status(400).json({ error: '파일을 올리지 못했어요. 다시 시도해 주세요.' })
  next(err)
})

router.post('/', single, (req, res) => {
  if (!req.file) return res.status(400).json({ error: '올릴 수 없는 형식이에요. PDF·사진(JPG·PNG)·엑셀·워드·한글만 돼요.' })
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8')
  res.json({
    url:          `/uploads/${req.user.companyId}/${req.file.filename}`,
    originalName,
    size:         req.file.size,
    mimetype:     req.file.mimetype,
  })
})

module.exports = router
